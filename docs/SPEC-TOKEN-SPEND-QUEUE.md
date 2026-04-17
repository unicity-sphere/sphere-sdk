# Token Spend Queue — Feature Specification

**Document status:** Draft v1.0
**Scope:** `sphere-sdk` — `modules/payments/`
**Authors:** Architecture team
**Last updated:** 2026-03-12

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Architecture Overview](#3-architecture-overview)
4. [Component: TokenReservationLedger](#4-component-tokenreservationledger)
5. [Component: SpendPlanner](#5-component-spendplanner)
6. [Component: SpendQueue](#6-component-spendqueue)
7. [Integration: PaymentsModule.send() Changes](#7-integration-paymentsmodulesend-changes)
8. [Integration: Change Token Arrival](#8-integration-change-token-arrival)
9. [Failure Handling](#9-failure-handling)
10. [Error Codes](#10-error-codes)
11. [Concurrency Model](#11-concurrency-model)
12. [Performance Characteristics](#12-performance-characteristics)
13. [Constants Reference](#13-constants-reference)
14. [Invariants Summary](#14-invariants-summary)
15. [Test Coverage Checklist](#15-test-coverage-checklist)

---

## 1. Executive Summary

`PaymentsModule.send()` has a TOCTOU (time-of-check-time-of-use) race condition: two concurrent `send()` calls can independently observe the same set of available tokens, both select them for spending, and both proceed. The second call will fail at the aggregator with `REQUEST_ID_EXISTS` because the token state was already committed by the first call.

This specification defines three cooperating components that eliminate the race:

| Component | Responsibility |
|-----------|----------------|
| `TokenReservationLedger` | Tracks exact amounts logically reserved from each token for each in-flight send. All operations are synchronous. |
| `SpendPlanner` | Executes a synchronous critical section: reads free amounts, runs split calculation, creates reservation atomically. |
| `SpendQueue` | Holds requests that cannot be served immediately because all candidate tokens are reserved. Wakes and re-plans when change tokens arrive. |

The key insight is that JavaScript is single-threaded. Between any two `await` points, code runs atomically. The fix ensures that token selection and reservation happen without any `await` between them, making the check-then-act sequence truly atomic.

---

## 2. Problem Statement

### 2.1 Current Race Window

In the current `PaymentsModule.send()` implementation (lines 1009–1016 of `PaymentsModule.ts`):

```
// Line 1011-1016
const availableTokens = Array.from(this.tokens.values());
const splitPlan = await calculator.calculateOptimalSplit(   // <-- AWAIT HERE
  availableTokens,
  BigInt(request.amount),
  request.coinId
);
```

`calculateOptimalSplit` is `async` because `SdkToken.fromJSON()` is async. During the `await`, another microtask (another concurrent `send()` call) can run its own `calculateOptimalSplit` with the same `this.tokens` snapshot, select the same tokens, and proceed to mark them `'transferring'`.

By the time both calls resume, both have selected the same tokens. The second submit to the aggregator will receive `REQUEST_ID_EXISTS`, which maps to a failed transfer and a corrupted wallet state (tokens removed but send failed).

### 2.2 Why "Just Lock" Doesn't Work

A naive mutex (`async lock() { ... }`) wrapping the entire `send()` body would serialize all sends globally. This is unacceptable because:

- Sends for different coin IDs are fully independent and should not be serialized.
- Sends that require no token overlap should proceed concurrently.
- The critical section is tiny — only the token selection step needs serialization, not the ~2-second aggregator round-trip.

### 2.3 Why Synchronous Reservation Works

JavaScript's event loop guarantees that between two `await` points, no other code runs. If we (a) pre-parse all tokens asynchronously, then (b) read free amounts + compute plan + write reservation in a single synchronous block, the reservation is atomic. No concurrent `send()` call can observe the same free amount and make the same reservation.

---

## 3. Architecture Overview

```
PaymentsModule.send(request)
        │
        ├─── 1. Validate request (async — existing)
        ├─── 2. Resolve recipient (async — existing)
        ├─── 3. Build ParsedTokenPool (async — new)
        │
        │    ┌──────────────────────────────────────────────────────┐
        │    │  SYNCHRONOUS CRITICAL SECTION (no awaits)            │
        ├─── 4. SpendPlanner.planSend(request, parsedPool)          │
        │    │    ├── Read free amounts from TokenReservationLedger  │
        │    │    ├── Run calculateOptimalSplitSync(freeView)        │
        │    │    ├── Case A: sufficient → create reservation        │
        │    │    │          return { reservationId, splitPlan }     │
        │    │    ├── Case B: sufficient if queued → enqueue        │
        │    │    │          return Promise (resolved later)         │
        │    │    └── Case C: permanently insufficient → throw       │
        │    └──────────────────────────────────────────────────────┘
        │
        ├─── 5. Execute splitPlan (async — existing)
        ├─── 6. ledger.commit(reservationId) on success
        └─── 7. ledger.cancel(reservationId) + notifyChange on failure


addToken(token)
        └─── spendQueue.notifyChange(token.coinId)
                └─── SpendQueue re-evaluates queued entries for coinId
                        └─── For each plannable entry:
                                └─── create reservation, resolve promise
```

### 3.1 Component Interactions

```
TokenReservationLedger
    ↑ reserve / commit / cancel / getFreeAmount
    │
SpendPlanner ──── calculateOptimalSplitSync() ──── (new sync variant of TokenSplitCalculator)
    │
    ├─── immediate path: reservation created, returns synchronously
    │
    └─── queued path: SpendQueue.enqueue(entry)
              │
              └─── SpendQueue ──── notifyChange(coinId)
                        │
                        └─── re-runs SpendPlanner critical section for queued entries
```

---

## 4. Component: TokenReservationLedger

### 4.1 Purpose

The `TokenReservationLedger` tracks which portions of which tokens have been logically claimed by in-flight `send()` operations. It answers the question: "how much of token X is actually free to be selected right now?"

A reservation is not the same as a transfer. A reservation is a logical hold that exists only in memory for the duration of the send operation. When the send succeeds, the reservation is committed (the token is removed from `this.tokens` by the existing `removeToken` path). When the send fails, the reservation is cancelled and the token becomes available again.

### 4.2 Data Model

```typescript
type ReservationStatus = 'active' | 'committed' | 'cancelled';

interface ReservationEntry {
  /** Unique per send attempt; equals the TransferResult.id of that send */
  readonly reservationId: string;

  /**
   * Map from tokenId to the amount reserved from that token.
   * A single reservation may span multiple tokens (e.g., three direct tokens + one split token).
   */
  readonly amounts: Map<string, bigint>;   // tokenId → reservedAmount

  /** All tokens in a reservation share the same coinId */
  readonly coinId: string;

  /** Wall-clock time of reservation creation, in milliseconds since epoch */
  readonly createdAt: number;

  /** Current lifecycle state */
  status: ReservationStatus;
}
```

**Internal storage:**

```typescript
// Primary index: reservationId → ReservationEntry
private readonly reservations: Map<string, ReservationEntry>;

// Secondary index for fast per-token lookup: tokenId → Set<reservationId>
// Maintained in sync with reservations map at all mutation points
private readonly tokenIndex: Map<string, Set<string>>;
```

The `tokenIndex` is an acceleration structure. Its contents must always be consistent with the `reservations` map. Any mutation to `reservations` must be mirrored in `tokenIndex`.

### 4.3 Operations

All operations listed below are **synchronous** (no `async`, no `await`). This is a hard requirement. The guarantee that the critical section in `SpendPlanner.planSend()` is race-free depends entirely on all reservation operations being synchronous.

---

#### `reserve(reservationId, entries, coinId): void`

Creates a new reservation.

**Parameters:**
- `reservationId: string` — must be unique across all active reservations. Callers use the `TransferResult.id` (a UUID from `crypto.randomUUID()`).
- `entries: Array<{ tokenId: string; amount: bigint }>` — one entry per token to be reserved.
- `coinId: string` — the coin being transferred. All tokens in `entries` must belong to this coin.

**Preconditions (must be checked synchronously before writing):**
1. `reservationId` must not already exist in `this.reservations`.
2. For each entry: `getFreeAmount(entry.tokenId) >= entry.amount` must hold at the moment of the call.
3. `entry.amount > 0n` for all entries.
4. `entries` must not be empty.

**Postconditions:**
- A new `ReservationEntry` with `status = 'active'` is added to `this.reservations`.
- For each `{ tokenId, amount }` in `entries`, `tokenIndex.get(tokenId)` includes `reservationId`.

**Error behavior:**
- If precondition 1 fails: throw `Error('DUPLICATE_RESERVATION_ID')`.
- If precondition 2 fails for any entry: throw `Error('INSUFFICIENT_FREE_AMOUNT')`. No partial reservation is written; the operation is all-or-nothing.
- If precondition 3 fails: throw `Error('INVALID_RESERVATION_AMOUNT')`.
- If precondition 4 fails: throw `Error('EMPTY_RESERVATION')`.

**Implementation note:** Because this is called from the synchronous critical section, the precondition checks and the map write happen atomically (no interleaving is possible). The failure path must ensure no partial state is written — compute all amounts before writing any.

---

#### `commit(reservationId): void`

Marks a reservation as committed. Called immediately before `removeToken()` to signal that the tokens are about to be permanently removed.

**Behavior:**
- If `reservationId` not found: no-op (idempotent).
- If `status === 'committed'`: no-op.
- If `status === 'cancelled'`: log a warning (unexpected), no-op. A cancelled reservation should never be committed.
- If `status === 'active'`: set `status = 'committed'`.

**Note on tokenIndex:** The committed reservation remains in `tokenIndex` until `cleanup()` or until the token itself is removed (which triggers `cancelForToken()`). `getFreeAmount()` must treat committed reservations as still consuming the token's amount, because the token has not yet been physically removed from `this.tokens`. The token disappears from `this.tokens` a few lines after `commit()` in the send flow.

---

#### `cancel(reservationId): void`

Releases a reservation, making the reserved amounts available again.

**Behavior:**
- If `reservationId` not found: no-op (idempotent).
- If `status === 'committed'`: no-op with warning. Committed reservations must not be cancelled (the token is already being removed).
- If `status === 'cancelled'`: no-op (idempotent).
- If `status === 'active'`: set `status = 'cancelled'`, remove from `tokenIndex` for all referenced tokens.

**Post-cancel state:** The cancelled entry MAY remain in `this.reservations` until `cleanup()` runs. This is acceptable because `getFreeAmount()` only sums reservations with `status === 'active'`.

---

#### `cancelForToken(tokenId): string[]`

Cancels all active reservations that reference `tokenId`. Called by `removeToken()` to handle the case where a token is removed while it is still reserved.

**Returns:** Array of cancelled `reservationId`s.

**Behavior:**
1. Look up `tokenIndex.get(tokenId)` to find all reservation IDs referencing this token.
2. For each such reservation where `status === 'active'`: call `cancel(reservationId)`.
3. Remove `tokenId` from `tokenIndex`.
4. Return the list of cancelled reservation IDs.

**Important:** This cancels the entire reservation, not just the portion for `tokenId`. If a reservation spans tokens A and B, and token A is removed, the entire reservation (including the hold on token B) is cancelled. This is correct behavior: the send that created this reservation is about to fail, so its hold on all tokens must be released.

---

#### `getFreeAmount(tokenId): bigint`

Returns the amount of `tokenId` that is available for new reservations.

**Computation:**

```
freeAmount = token.amount − Σ{ entry.amounts.get(tokenId) | entry ∈ reservations, entry.status ∈ { 'active', 'committed' } }
```

Both active and committed reservations are subtracted. Committed reservations still hold the token amount until the token is physically removed.

**Returns:**
- The free amount as a `bigint >= 0`.
- If `tokenId` does not exist in `this.tokens` (as maintained by the caller, `PaymentsModule`): returns `0n`.

**This operation must be O(k)** where k is the number of reservations referencing this token. Use `tokenIndex` for lookup.

---

#### `getTotalReserved(tokenId): bigint`

Returns the total amount reserved from `tokenId` across all active and committed reservations.

**Computation:**

```
totalReserved = Σ{ entry.amounts.get(tokenId) | entry ∈ reservations, entry.status ∈ { 'active', 'committed' } }
```

This is the complement of `getFreeAmount()`. Together they satisfy:

```
getFreeAmount(tokenId) + getTotalReserved(tokenId) = token.amount
```

for any token that exists in the pool.

---

#### `getActiveCoinReservations(coinId): Map<string, bigint>`

Returns a map of all amounts reserved for `coinId` across all active reservations.

**Returns:** `Map<tokenId, totalReservedAmount>` where `totalReservedAmount` is the sum of all active-reservation amounts for that token within the given coin. Committed and cancelled reservations are excluded.

**Use case:** Used by `SpendPlanner` to build the "free view" of the token pool before calling `calculateOptimalSplitSync`.

---

#### `cleanup(maxAgeMs: number): string[]`

Removes stale reservations (those older than `maxAgeMs` milliseconds, measured from `createdAt`).

**Behavior:**
1. Iterate all reservations.
2. For each reservation where `(Date.now() - entry.createdAt) > maxAgeMs`:
   - If `status === 'active'`: call `cancel(reservationId)` first, then remove.
   - If `status === 'committed'` or `'cancelled'`: remove directly (no need to cancel).
3. Clean up `tokenIndex` entries for removed reservations.
4. Return the list of all `reservationId`s that were removed.

**When called:**
- Periodically by `SpendQueue`'s internal timer (every 1 second, with `maxAgeMs = RESERVATION_TIMEOUT_MS = 30_000`).
- On `destroy()` with `maxAgeMs = 0` to cancel everything.

**Note:** `cleanup()` cancels active stale reservations. This may make tokens available. The caller must call `spendQueue.notifyChange(coinId)` for each affected coin after `cleanup()` returns.

### 4.4 Invariants

| ID | Statement |
|----|-----------|
| I-RL-1 | `getFreeAmount(tokenId) >= 0n` for all tokenIds at all times. If a `reserve()` call would violate this, it must throw before writing any state. |
| I-RL-2 | `getFreeAmount(tokenId) + getTotalReserved(tokenId) === token.amount` for any token currently in `this.tokens`. |
| I-RL-3 | All mutating operations (`reserve`, `commit`, `cancel`, `cancelForToken`, `cleanup`) are synchronous. No `await` is permitted anywhere in these methods or in any method they call. |
| I-RL-4 | A reservation with `status === 'cancelled'` or `'committed'` cannot be set back to `'active'`. Transitions are one-directional: `active → committed` and `active → cancelled`. |
| I-RL-5 | The `tokenIndex` is always consistent with `reservations`. For any `(tokenId, reservationId)` pair in `tokenIndex`, `reservations.get(reservationId).amounts.has(tokenId)` must be `true`. |
| I-RL-6 | Each entry in `reservations` has a unique `reservationId`. No two entries share the same ID. |

### 4.5 Edge Cases

**Reserve called with amount exceeding free amount:**
Throw `INSUFFICIENT_FREE_AMOUNT`. Never write partial state.

**Reserve called for a tokenId not present in the caller's token pool:**
This is a programming error in `SpendPlanner`. Throw `UNKNOWN_TOKEN`. (SpendPlanner must only pass tokenIds that exist in `ParsedTokenPool`.)

**Cancel called for unknown reservationId:**
No-op. This can happen legitimately if `cleanup()` already removed the reservation.

**Commit called for an already-committed reservation:**
No-op. This can happen if `commit()` is called twice due to a retry path. Safe to ignore.

**Token removed from `this.tokens` while reservation is active:**
`removeToken()` must call `cancelForToken(tokenId)` before removing the token. The cancelled send operations must be notified (see section 9).

**Multiple reservations on the same token:**
Fully supported. `getFreeAmount` subtracts all active+committed amounts. Example: token with amount `1000`, two active reservations of `300` each → `getFreeAmount` returns `400`.

**Reserve called with `amount = 0n`:**
Throw `INVALID_RESERVATION_AMOUNT`. Zero-amount reservations serve no purpose and could mask bugs.

---

## 5. Component: SpendPlanner

### 5.1 Purpose

`SpendPlanner` owns the critical section: it reads the free-token view and creates a reservation atomically. "Atomically" in this context means "without any `await`" — JavaScript's single-threaded event loop guarantees no other code runs between two synchronous statements.

### 5.2 Pre-computation Phase (Async, Before Critical Section)

Before entering the synchronous critical section, `SpendPlanner` must pre-parse all token `sdkData` fields. This is necessary because `SdkToken.fromJSON()` is async and cannot be called inside the critical section.

**Type: ParsedTokenPool**

```typescript
interface ParsedTokenEntry {
  token: Token;           // The UI-layer Token object from this.tokens
  sdkToken: SdkToken;    // Parsed SDK token (result of SdkToken.fromJSON)
  amount: bigint;        // Parsed coin amount from sdkToken.coins.get(coinId)
}

// Key: token.id (the UUID used as key in PaymentsModule.this.tokens)
type ParsedTokenPool = Map<string, ParsedTokenEntry>;
```

**Building ParsedTokenPool:**

```
async buildParsedPool(tokens: Token[], coinId: string): Promise<ParsedTokenPool>
```

1. Iterate `tokens`.
2. For each token where `token.coinId === coinId` and `token.status === 'confirmed'` and `token.sdkData` is non-null:
   a. Parse `JSON.parse(token.sdkData)`.
   b. Await `SdkToken.fromJSON(parsed)`.
   c. Extract `amount = sdkToken.coins.get(CoinId.fromJSON(coinId)) ?? 0n`.
   d. Skip tokens where `amount === 0n`.
3. Return the populated `ParsedTokenPool`.

**Failure handling in buildParsedPool:**
If `SdkToken.fromJSON()` throws for any individual token, log a warning and skip that token. A single unparseable token must not abort the entire send. This mirrors the existing behavior in `TokenSplitCalculator.calculateOptimalSplit()`.

**When to build:**
`buildParsedPool` is called once per `send()` invocation, before entering the critical section. If the request is queued and eventually retried after a `notifyChange()` event, the `parsedPool` snapshot from the original call is used for re-evaluation (see section 6.3 for why this is acceptable).

### 5.3 Synchronous Variant of TokenSplitCalculator

`TokenSplitCalculator.calculateOptimalSplit()` is currently async because `SdkToken.fromJSON()` is async. A new synchronous variant is required for use inside the critical section.

**Signature:**

```typescript
calculateOptimalSplitSync(
  candidates: ParsedTokenEntry[],   // pre-parsed, pre-filtered, sorted ascending by amount
  targetAmount: bigint
): SplitPlan | null
```

**Behavior:** Identical to `calculateOptimalSplit()` except:
- Input is already parsed (`ParsedTokenEntry[]` instead of `Token[]`).
- No `async`, no `await`.
- The `coinId` is taken from the first candidate's `token.coinId` (all candidates share the same coinId by precondition).
- Returns `null` if `candidates` is empty or `totalAvailable < targetAmount`.

**The algorithm** (identical logic to current `calculateOptimalSplit`):
1. Sort `candidates` ascending by `amount`.
2. Compute `totalAvailable = Σ amounts`.
3. If `totalAvailable < targetAmount`: return `null`.
4. Strategy 1: exact match — single token with `amount === targetAmount`.
5. Strategy 2: combination — find a set of up to 5 tokens summing to `targetAmount`.
6. Strategy 3: greedy + split — accumulate tokens until overflow, split the final one.

**Free-view transformation:**
Before calling `calculateOptimalSplitSync`, the caller builds a modified candidate list reflecting current reservations:

```
freeEntry.amount = parsedEntry.amount - ledger.getFreeAmount(parsedEntry.token.id)
```

Wait — this is backwards. The correct formula is:

```
freeEntry.amount = ledger.getFreeAmount(parsedEntry.token.id)
```

where `ledger.getFreeAmount(id)` = `token.amount - totalReserved(id)`. Tokens where `freeEntry.amount === 0n` are excluded from the candidate list.

### 5.4 The Critical Section

```typescript
planSend(
  request: TransferRequest,
  parsedPool: ParsedTokenPool,
  ledger: TokenReservationLedger,
  queue: SpendQueue,
  reservationId: string
): { reservationId: string; splitPlan: SplitPlan } | 'queued'
```

This method contains **no `await`**. The entire body runs synchronously.

**Steps:**

```
1. Build freeView: for each entry in parsedPool where coinId matches:
      freeAmount = ledger.getFreeAmount(entry.token.id)
      if freeAmount > 0n: include in freeView with amount = freeAmount

2. Run calculateOptimalSplitSync(freeView, BigInt(request.amount))
      → plan (SplitPlan | null)

3. Compute totalAvailable (free): sum of freeView amounts

4. Compute totalInventory: sum of ALL parsedPool amounts for this coinId
   (regardless of reservations)

5. Determine outcome:
      Case A — plan !== null (sufficient free tokens):
            ledger.reserve(reservationId, planEntries(plan), request.coinId)
            return { reservationId, splitPlan: plan }

      Case B — plan === null AND totalInventory >= BigInt(request.amount):
            (sufficient total inventory but all tied up in reservations)
            queue.enqueue({ id: reservationId, request, parsedPool, ... })
            return 'queued'

      Case C — totalInventory < BigInt(request.amount):
            throw SphereError('Insufficient balance', 'SEND_INSUFFICIENT_BALANCE')
```

**planEntries(plan):** Extracts the reservation entries from a `SplitPlan`:

```
entries = []
for each token in plan.tokensToTransferDirectly:
    entries.push({ tokenId: token.uiToken.id, amount: token.amount })
if plan.tokenToSplit:
    entries.push({ tokenId: plan.tokenToSplit.uiToken.id, amount: plan.splitAmount })
```

Note: for a split token, only `splitAmount` (the portion being sent) is reserved. `remainderAmount` remains free because it will become a new token under the sender's control.

**The critical invariant:** Steps 1 through the `ledger.reserve()` call in Case A (or the `queue.enqueue()` call in Case B) run with no `await`. This guarantees that the free-amount check and the reservation write are atomic.

### 5.5 planSend Caller Contract

`planSend()` is called by `PaymentsModule.send()` as follows:

```
// (async context, but planSend itself is synchronous)
const planResult = this.spendPlanner.planSend(request, parsedPool, ledger, queue, result.id);
if (planResult === 'queued') {
  // Await the promise from the queue
  const { reservationId, splitPlan } = await this.spendQueue.waitForEntry(result.id);
  // ... proceed with execution
} else {
  const { reservationId, splitPlan } = planResult;
  // ... proceed with execution
}
```

**The call to `planSend()` must not be preceded by any `await` after the last modification to `this.tokens`.** That is, between the last possible `addToken()`/`removeToken()` call and `planSend()`, there must be no `await`. `buildParsedPool()` is safe to `await` because it reads `this.tokens` at a point-in-time and returns an immutable snapshot; later token mutations do not affect `parsedPool`.

---

## 6. Component: SpendQueue

### 6.1 Purpose

The `SpendQueue` holds `send()` requests that cannot be immediately satisfied because all candidate tokens are currently reserved by concurrent sends. It re-evaluates queued requests when tokens become available (change tokens returning from a split, failed sends releasing their reservations, or any other `addToken()` call).

### 6.2 Queue Entry

```typescript
interface QueueEntry {
  /** Equals the TransferResult.id of the pending send */
  readonly id: string;

  /** Original transfer request */
  readonly request: TransferRequest;

  /**
   * Snapshot of the parsed token pool at the time of enqueue.
   * This snapshot reflects the token amounts as parsed (before any reservations).
   * Used for re-evaluation: the planner applies current free amounts to these
   * pre-parsed tokens rather than re-parsing from scratch.
   *
   * Staleness: if new tokens arrive between enqueue and wake, they are NOT in
   * this snapshot. The wake path must supplement parsedPool with new tokens
   * from this.tokens before calling calculateOptimalSplitSync. See 6.3.
   */
  readonly parsedPool: ParsedTokenPool;

  /** Coin being requested */
  readonly coinId: string;

  /** Requested amount as bigint */
  readonly amount: bigint;

  /** Wall-clock time when this entry was enqueued */
  readonly enqueuedAt: number;

  /**
   * Number of times this entry has been skipped (i.e., notifyChange fired but
   * this entry could not be served while a later entry could).
   * Used for starvation protection.
   */
  skipCount: number;

  /** Resolve the promise returned to the send() caller */
  resolve: (result: PlanResult) => void;

  /** Reject the promise returned to the send() caller */
  reject: (error: SphereError) => void;
}

interface PlanResult {
  reservationId: string;
  splitPlan: SplitPlan;
}
```

### 6.3 ParsedPool Freshness on Re-evaluation

When `notifyChange(coinId)` fires, new tokens may have arrived that were not in the original `parsedPool` snapshot. The re-evaluation logic must account for these.

**Re-evaluation procedure in `notifyChange`:**

```
1. For each queued entry with entry.coinId === coinId (in queue order):

   a. Build mergedPool:
        Start with entry.parsedPool
        For each token in this.tokens where coinId matches and status = 'confirmed':
            If token.id NOT in entry.parsedPool:
                Parse sdkData synchronously if already cached, else skip
                (New tokens must have been parsed and cached at addToken() time — see 8.1)
                Add to mergedPool

   b. Apply free-view transform using current ledger state

   c. Run calculateOptimalSplitSync(freeView, entry.amount)

   d. If plan found:
        ledger.reserve(entry.id, planEntries(plan), entry.coinId)
        entry.resolve({ reservationId: entry.id, splitPlan: plan })
        Remove entry from queue

   e. If plan NOT found:
        entry.skipCount++
        If entry.skipCount >= MAX_SKIP_COUNT:
            Stop iterating (starvation protection — wait for this entry to be served)
```

**Parsing new tokens synchronously:** Step (a) requires synchronous access to parsed token data for tokens added since enqueue. To support this, `addToken()` must cache the parsed `SdkToken` and `amount` in a `parsedTokenCache: Map<string, ParsedTokenEntry>` maintained on `PaymentsModule`. This cache is populated at `addToken()` time (async, not in the critical section) and consulted synchronously in `notifyChange`. The cache is invalidated at `removeToken()` time.

**Alternative:** If synchronous parsing is not feasible for some tokens (e.g., parse fails), those tokens are excluded from the re-evaluation. The entry will be re-evaluated again on the next `notifyChange()` event.

### 6.4 Operations

---

#### `enqueue(entry: Omit<QueueEntry, 'skipCount' | 'resolve' | 'reject'>): Promise<PlanResult>`

Adds an entry to the queue and returns a promise that resolves when the entry is eventually planned.

**Behavior:**
1. Check `size()` against `QUEUE_MAX_SIZE` (100). If at capacity, immediately reject with `SEND_QUEUE_FULL`.
2. Create a deferred promise, capturing `resolve` and `reject`.
3. Set `entry.skipCount = 0`.
4. Append to the per-coinId queue (a `Map<string, QueueEntry[]>`).
5. Schedule `entry.enqueuedAt + QUEUE_TIMEOUT_MS` timeout. On fire: reject with `SEND_QUEUE_TIMEOUT` and remove from queue.
6. Return the deferred promise.

**Queue structure:** `Map<coinId, QueueEntry[]>`. Entries are processed in insertion order (FIFO within coinId, modulo skip-ahead).

---

#### `notifyChange(coinId: string): void`

Called when tokens of `coinId` become available (either because a new token arrived or a reservation was cancelled).

This method is **synchronous**. It re-evaluates the queue for `coinId` and resolves entries that can now be served.

**Full behavior:**

```
entries = this.queue.get(coinId) ?? []
i = 0
while i < entries.length:
    entry = entries[i]

    // Check timeout first
    if Date.now() - entry.enqueuedAt > QUEUE_TIMEOUT_MS:
        entry.reject(new SphereError('Queue timeout', 'SEND_QUEUE_TIMEOUT'))
        entries.splice(i, 1)
        continue  // do NOT increment i

    // Try to plan
    mergedPool = buildMergedPool(entry.parsedPool, currentTokens)
    freeView = applyFreeView(mergedPool, ledger)
    plan = calculateOptimalSplitSync(freeView, entry.amount)

    if plan !== null:
        ledger.reserve(entry.id, planEntries(plan), entry.coinId)
        entry.resolve({ reservationId: entry.id, splitPlan: plan })
        entries.splice(i, 1)
        continue  // do NOT increment i (next entry shifts to position i)

    // Could not serve this entry
    entry.skipCount++
    if entry.skipCount >= MAX_SKIP_COUNT:
        break  // starvation protection: stop here, this entry must be served next

    i++

// Update queue
if entries.length === 0:
    this.queue.delete(coinId)
else:
    this.queue.set(coinId, entries)
```

**Starvation protection detail:** When `entry.skipCount >= MAX_SKIP_COUNT`, the loop breaks immediately, preventing later entries from jumping ahead of a starving entry. On the next `notifyChange()`, the same entry is evaluated first again. `skipCount` is NOT reset on failed re-evaluation — it only stops incrementing past MAX_SKIP_COUNT.

---

#### `waitForEntry(id: string): Promise<PlanResult>`

Returns the promise associated with a queued entry. This is how `PaymentsModule.send()` awaits the queue result after `planSend()` returns `'queued'`.

**Behavior:**
- Find the entry with `entry.id === id`.
- Return the deferred promise.
- If no entry found (should not happen in normal operation): reject with a programmer error.

---

#### `cancelAll(reason: string): void`

Rejects all queued entries with the provided reason. Called by `PaymentsModule.destroy()`.

**Behavior:**
1. For each entry in all per-coinId queues: `entry.reject(new SphereError(reason, 'MODULE_DESTROYED'))`.
2. Clear all queues.
3. Cancel the periodic cleanup timer.

---

#### `size(coinId?: string): number`

Returns the number of queued entries.

- If `coinId` provided: count for that coin only.
- If omitted: total across all coins.

### 6.5 Periodic Timeout Check

In addition to per-entry timeout scheduling (set in `enqueue()`), the `SpendQueue` runs a periodic timer every `QUEUE_CHECK_INTERVAL_MS = 1000` milliseconds.

**Timer behavior:**
1. Call `ledger.cleanup(RESERVATION_TIMEOUT_MS)` to remove stale reservations.
2. For each coinId with stale reservations (returned by `cleanup()`): call `notifyChange(coinId)`.
3. Scan all queued entries for timeout expiry (belt-and-suspenders for the per-entry timer).

This dual-timeout mechanism ensures that entries are evicted even if the per-entry `setTimeout` is delayed by event loop saturation.

---

## 7. Integration: PaymentsModule.send() Changes

### 7.1 New Instance Variables

The following fields are added to `PaymentsModule`:

```typescript
private readonly reservationLedger: TokenReservationLedger;
private readonly spendPlanner: SpendPlanner;
private readonly spendQueue: SpendQueue;

/**
 * Cache of parsed SdkToken data, keyed by token.id.
 * Populated at addToken() time, invalidated at removeToken() time.
 * Used by SpendQueue.notifyChange() for synchronous re-evaluation.
 */
private readonly parsedTokenCache: Map<string, ParsedTokenEntry>;
```

These are initialized in the `PaymentsModule` constructor.

### 7.2 Revised send() Flow

```
async send(request: TransferRequest): Promise<TransferResult> {
  this.ensureInitialized();
  if (this.destroyed) throw new SphereError('Module destroyed', 'MODULE_DESTROYED');

  const result = {
    id: crypto.randomUUID(),   // reservationId = result.id
    status: 'pending',
    tokens: [],
    tokenTransfers: [],
  };

  try {
    // ── Phase 1: Async pre-work (unchanged) ──────────────────────────────────
    const peerInfo = await this.deps!.transport.resolve?.(request.recipient) ?? null;
    const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
    const recipientAddress = await this.resolveRecipientAddress(...);
    const signingService = await this.createSigningService();
    const stClient = ...;
    const trustBase = ...;

    // ── Phase 2: Pre-parse token pool (async, one-time) ───────────────────────
    // Build ParsedTokenPool for the requested coinId.
    // After this await, no further modification to this.tokens occurs before
    // the critical section.
    const parsedPool = await this.spendPlanner.buildParsedPool(
      Array.from(this.tokens.values()),
      request.coinId
    );

    // ── Phase 3: Critical section (synchronous) ───────────────────────────────
    // planSend contains NO await. The token selection and reservation are atomic.
    const planResult = this.spendPlanner.planSend(
      request, parsedPool, this.reservationLedger, this.spendQueue, result.id
    );

    let reservationId: string;
    let splitPlan: SplitPlan;

    if (planResult === 'queued') {
      // ── Phase 4a: Wait in queue (async) ──────────────────────────────────────
      // Await without timeout — the per-entry timer in SpendQueue handles expiry.
      ({ reservationId, splitPlan } = await this.spendQueue.waitForEntry(result.id));
    } else {
      // ── Phase 4b: Immediate planning succeeded ────────────────────────────────
      ({ reservationId, splitPlan } = planResult);
    }

    // ── Phase 5: Execute splitPlan (unchanged async logic) ────────────────────
    const tokensToSend: Token[] = splitPlan.tokensToTransferDirectly.map(t => t.uiToken);
    if (splitPlan.tokenToSplit) tokensToSend.push(splitPlan.tokenToSplit.uiToken);
    result.tokens = tokensToSend;

    for (const token of tokensToSend) {
      token.status = 'transferring';
      this.tokens.set(token.id, token);
    }
    await this.save();
    await this.saveToOutbox(result, recipientPubkey);
    result.status = 'submitted';

    // ... (all existing transfer execution logic: instant mode / conservative mode)

    // ── Phase 6: Commit reservation on success ────────────────────────────────
    this.reservationLedger.commit(reservationId);

    // ... (existing post-transfer logic: history, events)

    result.status = 'completed';
    return result;

  } catch (error) {
    // ── Phase 7: Cancel reservation on failure ────────────────────────────────
    this.reservationLedger.cancel(result.id);
    this.spendQueue.notifyChange(request.coinId);   // wake queue — tokens freed

    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);

    for (const token of result.tokens) {
      token.status = 'confirmed';
      this.tokens.set(token.id, token);
    }

    this.deps!.emitEvent('transfer:failed', result);
    throw error;
  }
}
```

### 7.3 Constraint: No `await` Between parsedPool Build and planSend

The constraint that `planSend()` runs atomically is satisfied by:

1. `buildParsedPool()` is awaited and returns an immutable snapshot.
2. No code between the `buildParsedPool()` `await` and the `planSend()` call modifies `this.tokens`.
3. `planSend()` itself has no `await`.

Point 2 must be enforced by code review. The critical section is NOT a try-catch or a mutex — it is simply the absence of `await` between the free-amount read and the `reserve()` write. This must be documented with a clear comment in the source code.

### 7.4 Backward Compatibility

- No changes to the `TransferRequest` or `TransferResult` types.
- No changes to the external `send()` signature.
- The reservation lifecycle is entirely internal.
- Callers that currently retry on failure continue to work — the failure path cancels the reservation and wakes the queue.

---

## 8. Integration: Change Token Arrival

Change tokens from splits and any other newly added tokens are the primary source of "queue wake" events.

### 8.1 addToken() Changes

`addToken()` is the single point where tokens enter `this.tokens`. After adding the token:

1. **Parse and cache:** parse `token.sdkData` and cache the result in `this.parsedTokenCache`.

   ```typescript
   async addToken(token: Token): Promise<void> {
     // ... existing logic ...
     this.tokens.set(token.id, token);

     // NEW: parse and cache for SpendQueue synchronous re-evaluation
     if (token.sdkData && token.status === 'confirmed') {
       try {
         const parsed = JSON.parse(token.sdkData);
         const sdkToken = await SdkToken.fromJSON(parsed);
         const amount = this.extractCoinAmount(sdkToken, token.coinId);
         if (amount > 0n) {
           this.parsedTokenCache.set(token.id, { token, sdkToken, amount });
         }
       } catch {
         // Parse failure: token not cached. SpendQueue will skip it during re-evaluation.
         // This is acceptable — the token is in this.tokens and will be parsed in the
         // next buildParsedPool() call on the next send().
       }
     }

     // NEW: wake queue for this coinId
     this.spendQueue.notifyChange(token.coinId);

     // ... existing save/notify logic ...
   }
   ```

   **Why cache here:** `notifyChange()` is synchronous. To include newly arrived tokens in synchronous re-evaluation, their parsed form must already be available.

   **Why only 'confirmed' tokens:** Tokens with `status !== 'confirmed'` are excluded from `TokenSplitCalculator` candidate lists. No need to cache or wake the queue for placeholder, transferring, or unconfirmed tokens.

2. **Call `spendQueue.notifyChange(token.coinId)`** after the cache update.

   **Order matters:** The cache update must precede `notifyChange()`. If `notifyChange()` fires synchronously (it does), it may immediately read the cache for this token.

### 8.2 removeToken() Changes

`removeToken()` removes tokens from `this.tokens`. When a token is removed:

1. **Cancel reservations:** `const cancelledIds = this.reservationLedger.cancelForToken(token.id)`.

2. **Remove from cache:** `this.parsedTokenCache.delete(token.id)`.

3. **Wake queue:** call `this.spendQueue.notifyChange(token.coinId)`.

   This is not intuitive — removing a token reduces available amounts. However, a token removal may resolve a permanent insufficiency detection: if a queued entry was waiting for token X and token X is now removed, the entry's `totalInventory` check in `notifyChange` will now return `false`, causing the entry to be rejected with `SEND_INSUFFICIENT_BALANCE` rather than waiting indefinitely.

   The `cancelForToken` call also frees up amounts on other tokens that were co-reserved with the removed token, which may allow other queued entries to proceed.

4. **Existing remove logic** (archiving, tombstoning) continues unchanged.

### 8.3 Token Status Change (Not an addToken/removeToken)

When a token transitions from `'transferring'` back to `'confirmed'` (e.g., on send failure), `send()`'s catch block:
1. Sets `token.status = 'confirmed'`.
2. Calls `this.tokens.set(token.id, token)` (already in map, just updating status).
3. This does NOT call `addToken()`.

The queue wake in this path is handled by:
```
this.reservationLedger.cancel(result.id);    // releases reserved amounts
this.spendQueue.notifyChange(request.coinId); // explicit wake
```

---

## 9. Failure Handling

### 9.1 Send Fails After Reservation Created

This is the normal failure path (aggregator error, network error, etc.).

**Steps:**
1. Catch block in `send()` fires.
2. `this.reservationLedger.cancel(result.id)` — releases all token amounts reserved for this send.
3. For each token in `result.tokens`: restore `status = 'confirmed'`.
4. `this.spendQueue.notifyChange(request.coinId)` — wake queued requests that may now be servable.
5. `this.deps!.emitEvent('transfer:failed', result)`.
6. Re-throw the error to the caller.

**Idempotency:** If the catch block runs multiple times (e.g., due to unhandled re-throw), `cancel()` on an already-cancelled reservation is a no-op.

### 9.2 Aggregator Rejects with REQUEST_ID_EXISTS

`REQUEST_ID_EXISTS` from the aggregator means the commitment was already submitted (and possibly included). This can happen on:
- Restart with stale outbox entries (the existing recovery path handles this).
- Post-fix: should be extremely rare, only possible if two nodes share a private key.

**Handling:**
- The existing behavior is preserved: on `REQUEST_ID_EXISTS`, the send is treated as a success (the commitment went through).
- No change to reservation lifecycle: `commit(reservationId)` is called on the success path.

### 9.3 Token Becomes Invalid or Spent While Reserved

If a token that is currently reserved is detected as spent (via aggregator validation or Nostr re-delivery with tombstone match):

1. `removeToken(tokenId)` is called.
2. `removeToken()` calls `ledger.cancelForToken(tokenId)` (new, per section 8.2).
3. `cancelForToken()` cancels all active reservations that include `tokenId` and returns the `reservationId`s.
4. `removeToken()` calls `spendQueue.notifyChange(coinId)`.

**Notification to affected sends:**
The `send()` calls that were waiting for those reservations need to be notified. This is handled implicitly: the reservation is cancelled, so when those sends proceed to `commit()` or check their reservation status, they will find it cancelled.

**Implementation:** `SpendPlanner` should expose a `onReservationCancelled(reservationId, reason)` callback that `PaymentsModule` registers. When `cancelForToken()` returns a list of IDs, `PaymentsModule` calls this callback for each, which causes the corresponding `send()` to fail with `SEND_RESERVATION_CANCELLED`.

Alternatively, `send()` can check `ledger.getStatus(reservationId)` before proceeding to the execution phase, and throw `SEND_RESERVATION_CANCELLED` if the status is `'cancelled'`. This check occurs synchronously after `waitForEntry()` resolves.

### 9.4 Queue Timeout (30 Seconds)

When a queued entry reaches `QUEUE_TIMEOUT_MS = 30_000` ms since `enqueuedAt`:

1. The deferred promise is rejected with `new SphereError('Send queue timeout', 'SEND_QUEUE_TIMEOUT')`.
2. The entry is removed from the queue.
3. If a partial reservation was created (should not happen in this design — reservations are only created when a plan succeeds), it is cancelled.
4. The `send()` catch block fires, handling cleanup per section 9.1.

**Retry semantics:** `SEND_QUEUE_TIMEOUT` is recoverable. The caller can retry with a new `send()` call. The original `send()` call has failed; any state changes it made (token status = 'transferring') have been rolled back in the catch block.

### 9.5 destroy() Called While Requests Are Queued

`PaymentsModule.destroy()` adds the following steps (executed in order):

1. Set `this.destroyed = true` (existing flag).
2. `this.spendQueue.cancelAll('MODULE_DESTROYED')` — rejects all queued entry promises with `MODULE_DESTROYED`.
3. `this.reservationLedger.cleanup(0)` — cancels all active reservations immediately.
4. Existing destroy logic (unsubscribe, stop timers, etc.).

Any `send()` calls that are `await`-ing a queue promise will have their awaits rejected, their catch blocks will fire, and they will re-throw `MODULE_DESTROYED` to their callers.

---

## 10. Error Codes

The following error codes are new (added to `SphereError` code registry):

| Code | Type | When Thrown | Recoverable? | Retry Guidance |
|------|------|-------------|--------------|----------------|
| `SEND_QUEUE_TIMEOUT` | `SphereError` | Queued send exceeded `QUEUE_TIMEOUT_MS` (30s) without being served | Yes | Retry immediately; likely cause was concurrent sends with a slow aggregator round-trip |
| `SEND_INSUFFICIENT_BALANCE` | `SphereError` | Total token inventory (including all reserved tokens) is less than the requested amount | No | User needs more tokens; do not retry automatically |
| `SEND_RESERVATION_CANCELLED` | `SphereError` | A token that was reserved for this send was removed (spent, invalidated, or sync-removed) while the send was in progress | Yes | Retry; the conflicting token is gone, new selection will avoid it |
| `MODULE_DESTROYED` | `SphereError` | `destroy()` was called while the send was queued or in-flight | No | Do not retry; the wallet is shutting down |
| `SEND_QUEUE_FULL` | `SphereError` | Queue has reached `QUEUE_MAX_SIZE` (100) entries for this coin | Yes | Back off and retry after a short delay |

**Existing codes that remain relevant:**

| Code | Notes |
|------|-------|
| `INSUFFICIENT_BALANCE` | Renamed to `SEND_INSUFFICIENT_BALANCE` for clarity (breaking change — coordinate with consumers) |
| `TRANSFER_FAILED` | Aggregator or network failure during execution; catch block cancels reservation |
| `AGGREGATOR_ERROR` | Fatal aggregator configuration error; catch block cancels reservation |

---

## 11. Concurrency Model

### 11.1 What Is Synchronous vs. Async

| Operation | Synchronous? | Notes |
|-----------|-------------|-------|
| `ledger.reserve()` | Yes | Entire method body, no awaits |
| `ledger.commit()` | Yes | Entire method body |
| `ledger.cancel()` | Yes | Entire method body |
| `ledger.getFreeAmount()` | Yes | Read-only, no awaits |
| `ledger.cancelForToken()` | Yes | Entire method body |
| `ledger.cleanup()` | Yes | Entire method body |
| `spendQueue.notifyChange()` | Yes | Entire method body, including planning loop |
| `spendQueue.enqueue()` | Yes (body) | Returns a Promise, but the enqueue action itself is sync |
| `spendQueue.cancelAll()` | Yes | Entire method body |
| `spendPlanner.planSend()` | Yes | **The critical section** — must never acquire an await |
| `spendPlanner.buildParsedPool()` | No (async) | Called before the critical section |
| `calculateOptimalSplitSync()` | Yes | New sync variant |
| `addToken()` (partial) | No | Async for save, but notifyChange() fires synchronously after cache update |
| `removeToken()` (partial) | No | Async for archive/tombstone, but cancelForToken() fires synchronously |

### 11.2 What Can Run Concurrently vs. What Is Serialized

**Concurrently:**
- `send()` calls for **different coinIds** — fully independent, no shared reservation state.
- `send()` execution phases (token transfer to aggregator) for the same coinId — these run concurrently intentionally. Only the planning phase is serialized.
- `addToken()` / `receive()` — these can run concurrently with `send()`. The token cache and `notifyChange` mechanism handle this safely.

**Serialized (by virtue of JavaScript's single-threaded event loop):**
- Any two `planSend()` calls — they cannot interleave because both are synchronous. The second call's `planSend()` executes only after the first call has either returned or (impossibly for sync code) yielded. Since `planSend()` is synchronous, it always runs to completion before any other synchronous code.
- `notifyChange()` and `planSend()` — for the same reason. A `notifyChange()` triggered by an `addToken()` cannot interleave with a `planSend()` in progress.

### 11.3 Critical Section Boundaries

The critical section is not a lock. It is defined as the contiguous synchronous region from reading free amounts to writing the reservation:

```
─── (await buildParsedPool resolves) ────────────────────────────────────────
  START OF CRITICAL SECTION
  ledger.getActiveCoinReservations(coinId)   [sync read]
  calculateOptimalSplitSync(freeView)        [sync compute]
  ledger.reserve(...)                        [sync write]
  ─── OR ───
  spendQueue.enqueue(entry)                  [sync write (returns Promise)]
  END OF CRITICAL SECTION
─── (next await: this.save() or waitForEntry()) ─────────────────────────────
```

Between these two boundaries, no `await` may appear. The implementation must enforce this with a comment and review discipline.

### 11.4 Why No Deadlocks Are Possible

A deadlock requires a circular wait: resource A waits for B, and B waits for A. This system has no such cycle because:

1. **The critical section is synchronous.** `planSend()` cannot wait for any other component. It either succeeds immediately, enqueues and returns, or throws. No blocking.

2. **The queue resolves forward only.** Queue entries are resolved by `notifyChange()`, which is called when tokens are added or reservations are released. `notifyChange()` itself is synchronous and does not wait for queue entries.

3. **No resource hierarchy.** The only shared resource is `TokenReservationLedger`. All callers access it through the same two entry points: `planSend()` (write) and `notifyChange()` (read + write). Both are synchronous, so they serialize naturally through the event loop.

4. **No cross-coinId dependencies.** A reservation for `coinId = UCT` never blocks a reservation for `coinId = USDC`. The queues and ledger are per-coinId conceptually (even though the ledger uses a single map, the free-amount computation for one coin never reads reservation entries for another coin).

5. **Promises resolve, never wait for each other.** The `send()` calls that are `await`-ing `waitForEntry()` are waiting for `resolve()` to be called, which happens in `notifyChange()`. `notifyChange()` does not await anything. It completes synchronously and schedules the resolved promise callbacks as microtasks. There is no cycle.

---

## 12. Performance Characteristics

### 12.1 Critical Path Overhead

| Operation | Complexity | Expected Duration |
|-----------|------------|-------------------|
| `buildParsedPool()` | O(n × parse cost) | ~1-5ms for typical wallets (10-100 tokens) |
| `getActiveCoinReservations()` | O(r) where r = active reservations | <1µs for typical r < 10 |
| `calculateOptimalSplitSync()` | O(n²) worst case (combinations) | <1ms for n ≤ 100 tokens |
| `ledger.reserve()` | O(k) where k = tokens in plan | <1µs for typical k ≤ 5 |
| `planSend()` total | O(n² + r) | <2ms total critical section |

**Total added overhead per send:** approximately 2-7ms. This is negligible compared to the ~2.3s aggregator round-trip.

### 12.2 Queue Depth in Normal Operation

Under typical usage (one or two concurrent sends of the same coin):
- Expected queue depth: 0-1 entries.
- Most sends will find immediate free tokens (no other concurrent send).
- Sends that overlap on tokens will queue for at most ~2.3s (the aggregator proof time for the conflicting send to return its change token).

Under stress (many concurrent sends of the same coin):
- Queue depth: O(concurrent sends).
- Each send waits for change tokens from the send ahead of it.
- The queue resolves in FIFO order (with skip-ahead for smaller amounts that fit in residual free amounts).

### 12.3 Memory Bounds

| Structure | Size | Bound |
|-----------|------|-------|
| `reservations` map | O(active reservations × tokens per reservation) | At most `QUEUE_MAX_SIZE + 1` active reservations × 5 tokens = ~505 entries |
| `tokenIndex` | O(total token-reservation pairs) | Same bound |
| `parsedTokenCache` | O(tokens in wallet) | Bounded by `this.tokens.size` (typically < 1000) |
| Per-coinId queue | O(queued sends per coin) | At most `QUEUE_MAX_SIZE` = 100 per coin |

### 12.4 Change Token Latency

The maximum queue wait time for a request blocked by a concurrent split is bounded by the split's change token arrival time:
- Instant mode (V6 bundle): ~2.3s (aggregator burn proof + background mint).
- Conservative mode: ~42s (full sequential proof collection).

Queued sends set their timeout at 30s. If the conflicting send uses conservative mode, the queued send may timeout. This is by design: conservative mode is not optimized for concurrent operation. Users or callers should use instant mode for concurrent send scenarios.

### 12.5 Queue Cleanup

`cleanup()` runs every 1 second. Its cost is O(total reservations), which is bounded by `QUEUE_MAX_SIZE + 1`. At most 101 entries in the worst case, making cleanup negligible.

---

## 13. Constants Reference

All constants defined in a single location (e.g., `modules/payments/spend-queue-constants.ts`):

| Constant | Value | Description |
|----------|-------|-------------|
| `RESERVATION_TIMEOUT_MS` | `30_000` | Stale reservation eviction threshold (ms) |
| `QUEUE_TIMEOUT_MS` | `30_000` | Queued send expiry (ms from enqueue time) |
| `MAX_SKIP_COUNT` | `10` | Max times an entry can be skipped before starvation protection halts forward progress |
| `QUEUE_MAX_SIZE` | `100` | Maximum queue depth per coinId before new enqueues are rejected |
| `QUEUE_CHECK_INTERVAL_MS` | `1_000` | Periodic cleanup timer interval (ms) |

**Rationale:**

- `RESERVATION_TIMEOUT_MS = 30s`: Covers the conservative-mode round-trip (~42s would be too short, but the retry path handles that). Set at 30s to match `QUEUE_TIMEOUT_MS`.
- `QUEUE_TIMEOUT_MS = 30s`: Long enough for instant-mode change tokens (~2.3s) plus network variance. Short enough to surface failures promptly.
- `MAX_SKIP_COUNT = 10`: After being skipped 10 times, an entry is almost certainly dealing with starvation rather than a transient unavailability. At ~2.3s per change token, 10 skips ≈ 23s before starvation protection kicks in, well within the 30s timeout.
- `QUEUE_MAX_SIZE = 100`: Prevents unbounded memory growth. 100 concurrent sends of the same coin is far beyond any realistic usage.
- `QUEUE_CHECK_INTERVAL_MS = 1s`: Provides timely timeout detection without significant overhead.

---

## 14. Invariants Summary

The following invariants must hold at all times during normal operation. Violations indicate implementation bugs.

### Reservation Ledger Invariants

| ID | Statement |
|----|-----------|
| I-RL-1 | `ledger.getFreeAmount(id) >= 0n` for all token IDs |
| I-RL-2 | `ledger.getFreeAmount(id) + ledger.getTotalReserved(id) === token.amount` for all tokens in `this.tokens` |
| I-RL-3 | All mutating operations on the ledger are synchronous |
| I-RL-4 | Reservation status transitions are one-directional: `active → committed`, `active → cancelled` |
| I-RL-5 | `tokenIndex` contents are consistent with `reservations` contents at all times |
| I-RL-6 | Each `reservationId` in `reservations` is unique |

### SpendPlanner Invariants

| ID | Statement |
|----|-----------|
| I-SP-1 | `planSend()` contains no `await` or async operations |
| I-SP-2 | Every `reserve()` call inside `planSend()` uses amounts that were confirmed free by `getFreeAmount()` in the same synchronous execution frame |
| I-SP-3 | A reservation is only created when `calculateOptimalSplitSync()` returns a non-null plan |
| I-SP-4 | No `send()` operation proceeds to the execution phase with a cancelled reservation |

### SpendQueue Invariants

| ID | Statement |
|----|-----------|
| I-SQ-1 | Every queued entry has a corresponding deferred promise that will eventually be resolved or rejected |
| I-SQ-2 | No entry remains in the queue after its deferred promise has been resolved or rejected |
| I-SQ-3 | `notifyChange()` is synchronous |
| I-SQ-4 | An entry's `skipCount` never decreases |
| I-SQ-5 | An entry that has reached `MAX_SKIP_COUNT` is always evaluated before any entry with lower `skipCount` in the same `notifyChange()` pass |

### PaymentsModule Integration Invariants

| ID | Statement |
|----|-----------|
| I-PM-1 | `addToken()` always calls `spendQueue.notifyChange(token.coinId)` for confirmed tokens |
| I-PM-2 | `removeToken()` always calls `ledger.cancelForToken(token.id)` before removing the token |
| I-PM-3 | The `parsedTokenCache` always contains an entry for every confirmed token in `this.tokens` with valid `sdkData` |
| I-PM-4 | No `await` appears between the last possible `this.tokens` mutation and the `planSend()` call |
| I-PM-5 | On send failure, `ledger.cancel(reservationId)` is called before `emitEvent('transfer:failed')` |

---

## 15. Test Coverage Checklist

The following test scenarios must be covered by unit tests. All tests use mocked aggregator and transport providers.

### TokenReservationLedger Tests

- [ ] Reserve single token, verify `getFreeAmount` decreases
- [ ] Reserve multiple tokens in one reservation, verify all affected free amounts
- [ ] Two reservations on same token, verify free amounts sum correctly
- [ ] Commit reservation, verify `getFreeAmount` unchanged (committed still counts)
- [ ] Cancel reservation, verify `getFreeAmount` restored
- [ ] Cancel then try to commit: no-op, log warning
- [ ] Commit then try to cancel: no-op, log warning
- [ ] Reserve with amount exceeding free: throws `INSUFFICIENT_FREE_AMOUNT`, no state written
- [ ] Reserve with duplicate `reservationId`: throws `DUPLICATE_RESERVATION_ID`
- [ ] Reserve with `amount = 0n`: throws `INVALID_RESERVATION_AMOUNT`
- [ ] `cancelForToken` cancels all reservations referencing that token
- [ ] `cancelForToken` on token with no reservations: no-op, returns `[]`
- [ ] `cleanup(0)` cancels all active reservations, ignores committed and cancelled
- [ ] `cleanup(maxAgeMs)` only removes entries older than threshold
- [ ] `tokenIndex` consistency after each operation
- [ ] Invariant I-RL-2 holds across 100 random reserve/cancel/commit operations

### SpendPlanner Tests

- [ ] `buildParsedPool` excludes non-confirmed tokens
- [ ] `buildParsedPool` excludes tokens with wrong coinId
- [ ] `buildParsedPool` handles `SdkToken.fromJSON` failure gracefully (skips token, logs warning)
- [ ] `calculateOptimalSplitSync` returns exact match plan
- [ ] `calculateOptimalSplitSync` returns combination plan (2-5 tokens)
- [ ] `calculateOptimalSplitSync` returns split plan
- [ ] `calculateOptimalSplitSync` returns `null` when insufficient
- [ ] `planSend` Case A: immediate plan when tokens available
- [ ] `planSend` Case B: enqueues when all tokens reserved
- [ ] `planSend` Case C: throws `SEND_INSUFFICIENT_BALANCE` when total inventory insufficient
- [ ] `planSend` only reserves `splitAmount` for split tokens, not full token amount
- [ ] Free-view correctly excludes tokens with zero free amount

### SpendQueue Tests

- [ ] `enqueue` returns a Promise that resolves when `notifyChange` makes tokens available
- [ ] `notifyChange` serves FIFO entries when possible
- [ ] `notifyChange` skips entries and serves later ones when skip-ahead applicable
- [ ] `skipCount` increments on skip
- [ ] Starvation protection: loop halts when first entry reaches `MAX_SKIP_COUNT`
- [ ] `skipCount` does not decrement
- [ ] Entry timeout: rejected after `QUEUE_TIMEOUT_MS`
- [ ] `cancelAll` rejects all entries with the provided reason
- [ ] `size()` returns correct counts
- [ ] `QUEUE_MAX_SIZE` enforcement: `SEND_QUEUE_FULL` on overflow
- [ ] New tokens added to `parsedPool` during wait are included in re-evaluation
- [ ] Periodic cleanup timer triggers `notifyChange` for stale-reservation coins

### Integration Tests (PaymentsModule.send)

- [ ] Two concurrent sends of different coinIds complete independently
- [ ] Two concurrent sends of same coinId, sufficient total balance: both succeed
- [ ] Two concurrent sends of same coinId, insufficient total balance: first succeeds, second throws `SEND_INSUFFICIENT_BALANCE`
- [ ] Concurrent send queued, change token arrives, queued send completes
- [ ] Failed send releases reservation, wakes queued send
- [ ] `destroy()` during queued send: rejected with `MODULE_DESTROYED`
- [ ] Queue timeout (simulated): rejected with `SEND_QUEUE_TIMEOUT`, reservation cleaned up
- [ ] Token removed while reserved: `SEND_RESERVATION_CANCELLED` for affected sends
- [ ] Reservation committed before `removeToken` in success path
- [ ] Reservation cancelled before `emitEvent('transfer:failed')` in failure path
- [ ] `parsedTokenCache` populated on `addToken`, cleared on `removeToken`
- [ ] No `await` between `buildParsedPool` return and `planSend` call (code structure test / static analysis)

---

*End of specification.*
