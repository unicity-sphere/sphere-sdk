# Token Spend Queue Architecture

**Status:** Proposal — v1.0
**Date:** 2026-03-12
**Scope:** `PaymentsModule` concurrency safety for `send()` / `sendInstant()`

---

## 1. Problem Statement

`PaymentsModule.send()` and `sendInstant()` share a single mutable `tokens: Map<string, Token>` pool with no synchronization. Both methods follow this pattern:

```
1. READ pool snapshot          ← TOCTOU window opens here
2. await calculateOptimalSplit (async — yields to event loop)
3. await buildSplitBundle      (async)
4. await sendTokenTransfer     (async — irreversible side-effect)
5. Mark tokens 'transferring'  ← TOCTOU window closes here (too late)
6. await removeToken           (async)
```

Any two concurrent `send()` invocations can enter the window simultaneously. Both read the same snapshot at step 1, both select the same tokens, both proceed through the irreversible network send at step 4. The L3 aggregator rejects the second commitment (`REQUEST_ID_EXISTS`), but by that point the Nostr message has been delivered to the recipient, the tokens have been marked spent, and the caller receives a `'failed'` result — leaving the wallet in a confused intermediate state.

This architecture document specifies the `TokenSpendQueue` subsystem that eliminates this race condition entirely, without introducing global serialization that would harm performance for independent sends.

---

## 2. Guiding Principles

1. **Token-level locking, not operation-level locking.** Two sends using non-overlapping tokens must run in full parallel. Only sends that need the same token are serialized.

2. **Volume-aware reservations.** A token that is partially consumed (its remainder becomes a change token) can logically serve multiple sends simultaneously if its total capacity covers all claimed amounts. The ledger tracks per-token committed amounts, not just presence/absence.

3. **Queue, do not reject.** When the free pool cannot satisfy a request but the full inventory (free + reserved) can, the request is enqueued rather than failed. It waits for change tokens to arrive and proceeds as soon as they do.

4. **Smart queue skipping.** The queue is not strictly FIFO. A request that can be served by currently available free tokens may skip ahead of a blocked request that is waiting for a specific change token, as long as this does not produce starvation.

5. **JS event-loop safety.** JavaScript is single-threaded. "Concurrency" means interleaving between `await` suspension points. All critical sections in this design are synchronous (no `await`) and execute atomically within a single microtask queue turn.

6. **No architectural coupling to AccountingModule.** The spend queue is an internal implementation detail of `PaymentsModule`. `AccountingModule`'s `withInvoiceGate` continues to operate at the invoice level, independently.

---

## 3. Component Overview

```
PaymentsModule
│
├── tokens: Map<string, Token>            (existing — unchanged interface)
│
├── TokenReservationLedger                (NEW)
│   ├── reserved: Map<tokenId, ReservationEntry[]>
│   └── API: reserve(), commit(), cancel(), getFreeAmount()
│
├── SpendPlanner                          (NEW)
│   ├── plan(): synchronous critical section
│   ├── canFulfillNow(): free-pool check
│   ├── canFulfillEventually(): total-inventory check
│   └── notifyChange(): wake queued requests
│
├── SpendQueue                            (NEW)
│   ├── queue: QueueEntry[]
│   ├── enqueue(): add pending request
│   ├── notifyChange(): attempt to serve next satisfiable entry
│   └── destroy(): reject all waiters and mark queue destroyed
│
├── TokenSplitCalculator                  (existing — receives filtered view)
│
└── send() / sendInstant()               (existing — gains reservation lifecycle)
```

---

## 4. TokenReservationLedger

### 4.1 Purpose

The ledger is the single source of truth for which portions of which tokens have been committed to in-flight sends. It enables the rest of the system to distinguish "free amount" from "reserved amount" without mutating token status prematurely.

### 4.2 Data Structures

```
ReservationEntry {
  reservationId: string                  // UUID, matches the TransferResult.id of the originating send
  amounts:       Map<string, bigint>     // tokenId → reserved amount (a single reservation may span multiple tokens)
  coinId:        string                  // Coin type (all tokens share the same coin)
  createdAt:     number                  // ms timestamp (for timeout cleanup)
  status:        'active' | 'committed' | 'cancelled'
}

TokenReservationLedger {
  // Primary index: reservationId → ReservationEntry
  reservations:   Map<string, ReservationEntry>

  // Secondary index (acceleration): tokenId → Set<reservationId>
  // Maintained in sync with reservations map at all mutation points
  tokenIndex:     Map<string, Set<string>>
}
```

### 4.3 Volume-Aware Free Amount

For a given `(tokenId, tokenAmount)` pair, the free amount available for new reservations is:

```
getFreeAmount(tokenId, tokenAmount) =
    tokenAmount (as bigint)
  - sum of entry.amounts.get(tokenId) for all ReservationEntry where entry.status in ('active', 'committed')
```

This subtraction happens in a synchronous read — no `await` points. This is the key invariant that makes the critical section safe.

### 4.4 Partial Reservation

A single token may appear in multiple reservations simultaneously if its total capacity covers all claimed amounts. Example:

- Token T1 has 1000 UCT
- Send A claims 600 UCT from T1 (T1 reserved: 600, free: 400)
- Send B claims 400 UCT from T1 (T1 reserved: 1000, free: 0)
- Both sends proceed in parallel using different portions of T1

This is valid only when T1 is a "split" token — both A and B must each produce their own split. The physical token T1 cannot be sent to two recipients; instead each send creates its own split bundle from T1's state. The aggregator's `requestId` uniqueness guarantee prevents double-spend at the L3 level.

**Constraint:** Partial reservations are only permitted on tokens that will undergo a split operation (i.e., `splitAmount < token.amount`). Tokens designated for direct full-value transfer may only carry one reservation at a time. The `SpendPlanner` enforces this during the synchronous critical section.

### 4.5 Reservation Lifecycle

```
reserve(reservationId, [(tokenId, amount, coinId), ...])
  → synchronous
  → creates ReservationEntry records in byToken and byReservation
  → MUST be called from within the synchronous critical section

cancel(reservationId)
  → synchronous
  → removes all ReservationEntry records for this reservationId
  → MUST be called from within the synchronous critical section or failure path
  → triggers SpendQueue.notifyChange() after removal

commit(reservationId)
  → called after tokens are physically removed from pool (removeToken completes)
  → removes entries from the ledger (they are no longer needed)
  → distinct from cancel: commit is the happy path, cancel is the error path
  → triggers SpendQueue.notifyChange() after removal
```

### 4.6 Why No "committed" State in the Ledger

Once `removeToken()` is called and the token is archived, the reservation entry is no longer meaningful — the token is gone from the pool. The ledger entry is committed (deleted) at that point. The ledger only tracks active reservations on tokens that are still in the pool. This keeps the data structure minimal and avoids stale entries.

### 4.7 Timeout / Cleanup

Reservations that are never committed or cancelled (e.g., due to an unhandled exception that bypassed the finally block) would permanently reduce the perceived free amount of a token. To defend against this:

- Each `ReservationEntry` carries a `createdAt` timestamp.
- Each queued entry has its own `setTimeout` that fires after `RESERVATION_TIMEOUT_MS = 30_000` milliseconds.
- 30 seconds matches the queue timeout (`QUEUE_TIMEOUT_MS`) — a reservation that has not been committed or cancelled within this window is considered stale.
- The timeout calls `cancel(reservationId)` which triggers `SpendQueue.notifyChange()`.
- A warning is logged whenever a timeout-expired reservation is cleaned up, as this indicates a bug in the lifecycle management code.

---

## 5. SpendPlanner

### 5.1 Purpose

The `SpendPlanner` is responsible for the synchronous critical section that determines whether a new spend request can proceed immediately, must be queued, or must be rejected. It coordinates between `TokenReservationLedger`, `TokenSplitCalculator`, and `SpendQueue`.

### 5.2 The Critical Section Contract

The critical section is a synchronous function (no `await`). It reads the current state of `tokens` and `TokenReservationLedger`, makes a decision, and either creates a reservation or enqueues the request. Because JavaScript is single-threaded, no other async operation can interleave within a synchronous function body. The critical section exits before the microtask queue can run.

This means the planning decision and the reservation creation happen atomically in a single event-loop turn.

### 5.3 Inputs Required Before the Critical Section

The critical section cannot `await`. Therefore all async work that informs the planning decision must complete **before** entering it:

1. Recipient resolution (`transport.resolve()`) — async, done before planning
2. `TokenSplitCalculator.calculateOptimalSplit()` — this is currently async (it calls `SdkToken.fromJSON()` for each candidate token). This must be refactored to accept pre-parsed SDK tokens, or its async work must be moved to a pre-computation phase. See section 5.5.

### 5.4 Decision Logic (synchronous)

```
planSend(request, parsedPool, ledger, queue, reservationId, pendingChangeAmount?): PlanResult | 'queued'

  pendingChangeAmount is an optional bigint representing the total amount of change
  tokens currently in-flight (status='transferring', placeholder tokens). These are
  counted toward totalInventory to avoid false SEND_INSUFFICIENT_BALANCE rejections
  when concurrent sends are waiting for change from prior splits.

  freeTokens = tokens where getFreeAmount(t.id, t.amount) === t.amount  (fully free)
  partiallyFreeTokens = tokens where getFreeAmount(t.id, t.amount) > 0 AND < t.amount

  // Pass the effective free view to the split calculator
  // (freeTokens + partial tokens with their reduced free amounts)
  splitPlan = calculator.calculateOptimalSplitSync(freeView, request.amount, request.coinId)

  if splitPlan !== null:
    // Can proceed immediately
    reservations = deriveReservations(splitPlan)
    ledger.reserve(request.id, reservations)
    return { type: 'proceed', splitPlan, reservations }

  totalInventory = sum of all token amounts for coinId (ignoring reservations)
  if totalInventory >= request.amount:
    // Cannot proceed now but will be able to once change tokens arrive
    return { type: 'enqueue', reason: 'waiting_for_change' }

  // Genuinely insufficient funds
  return { type: 'reject', reason: 'insufficient_balance' }
```

### 5.5 Refactoring TokenSplitCalculator for Synchronous Use

`TokenSplitCalculator.calculateOptimalSplit()` is currently async because it calls `SdkToken.fromJSON()` (which parses token JSON and may involve crypto operations) for each candidate token. This parsing must be moved outside the critical section.

**Decision:** Introduce a `ParsedTokenPool` — a pre-computed map from `tokenId` to `{ sdkToken, amount, coinId }`. This map is built once per `send()` invocation, before the critical section, using `await`. The critical section then operates on pre-parsed data synchronously.

`TokenSplitCalculator` gains a new synchronous method:

```
calculateOptimalSplitSync(
  parsedPool: ParsedTokenPool,     // pre-computed, no IO
  freeAmounts: Map<string, bigint>, // from ledger, per tokenId
  targetAmount: bigint,
  coinId: string
): SplitPlan | null
```

The existing async `calculateOptimalSplit()` is preserved for backward compatibility but becomes a thin wrapper: parse all tokens, then call the sync version.

**Files affected:**
- `/home/vrogojin/sphere-sdk/modules/payments/TokenSplitCalculator.ts` — add sync variant, accept pre-parsed pool

### 5.6 The Free View Passed to the Calculator

The split calculator must see only the free portion of each token. For tokens with partial reservations, the calculator sees a reduced virtual amount equal to `freeAmount(tokenId, coinId)`. For fully reserved tokens, they are excluded entirely. This is computed synchronously from the ledger before calling the calculator.

### 5.7 notifyChange()

When a change token arrives (via `onChangeTokenCreated` callback) or a reservation is cancelled, `SpendPlanner.notifyChange(coinId)` is called. This triggers `SpendQueue.notifyChange(coinId)` to attempt to serve waiting requests.

---

## 6. SpendQueue

### 6.1 Purpose

The `SpendQueue` holds spend requests that cannot be served immediately because all relevant tokens are currently reserved, but the total inventory is sufficient to eventually serve them once change tokens arrive.

### 6.2 Data Structure

```
QueueEntry {
  id:               string              // matches TransferResult.id
  request:          TransferRequest
  coinId:           string
  amount:           bigint
  resolve:          (result: PlanResult) => void     // unblocks the waiting send()
  reject:           (err: Error) => void
  enqueuedAt:       number              // ms timestamp
  parsedPool:       ParsedTokenPool     // snapshot of parsed tokens at enqueue time
  timeout:          ReturnType<typeof setTimeout>    // per-entry timeout handle
}

SpendQueue {
  queues:   Map<string, QueueEntry[]>  // per-coinId FIFO queues
}
```

### 6.3 Enqueue

`enqueue()` creates a `QueueEntry` and returns a `Promise<SplitPlan>`. The `send()` call `await`s this promise. The promise is resolved when `notifyChange()` finds that the request can now be served.

`enqueue()` is called from the synchronous critical section. The promise itself is created synchronously; the executor function captures `resolve` and `reject` for later use.

### 6.4 notifyChange(coinId?)

`notifyChange()` is called whenever the free pool increases (change token arrival, reservation cancel/commit). It iterates the queue and attempts to serve requests:

```
notifyChange(coinId: string):
  entries = per-coinId queue for coinId
  i = 0
  while i < entries.length:
    entry = entries[i]

    // Check timeout first
    if Date.now() - entry.enqueuedAt > QUEUE_TIMEOUT_MS:
      entry.reject(new SphereError('Send queue timeout', 'SEND_QUEUE_TIMEOUT'))
      entries.splice(i, 1)
      continue

    // Build merged pool (original snapshot + fresh parsedTokenCache entries)
    // Try to plan with currently free tokens
    plan = calculateOptimalSplitSync(freeView, entry.amount)

    if plan !== null:
      ledger.reserve(entry.id, planEntries(plan), entry.coinId)
      entry.resolve({ reservationId: entry.id, splitPlan: plan })
      entries.splice(i, 1)
      continue

    // Could not plan — skip this entry, try later ones (pass-over)
    i++
```

**Skip-ahead behavior:** `notifyChange()` does not stop at the first blocked entry. It continues iterating to find any satisfiable entry further in the queue. This implements the "smart queue" requirement: a small send that can be served with available tokens is not blocked by a larger send waiting for a specific change token.

**Pass-over behavior:** Entries that cannot be planned are simply skipped, and smaller entries behind them proceed. There is no explicit `skipCount` or starvation-promotion mechanism — the queue uses simple FIFO with pass-over. Entries that remain unsatisfied will eventually be rejected by the per-entry timeout (`QUEUE_TIMEOUT_MS`).

### 6.5 Queue Ordering and Fairness

The queue is approximately FIFO with pass-over. Entries are appended in arrival order. `notifyChange()` scans forward and serves the first satisfiable entry it finds, then continues to find more. Entries that cannot be planned are passed over and remain in the queue until served or timed out.

### 6.6 Queue Timeout

A queued request that has not been served after 30 seconds is automatically rejected with `QUEUE_TIMEOUT`. The timer is started at `enqueuedAt` and checked during `notifyChange()`. On rejection, the entry is removed and `entry.reject()` is called.

The 30-second timeout is chosen to be:
- Long enough to accommodate the instant-mode change token latency (~2.3 seconds typical, up to ~10s under load)
- Short enough to give callers a timely error if the wallet is in a persistently congested state

---

## 7. Change-Back Token Integration

### 7.1 Change Token Arrival Path

In instant mode, change tokens arrive via the `onChangeTokenCreated` callback inside `buildSplitBundle()`. This callback fires asynchronously, approximately 2.3 seconds after the Nostr send. The current code flow:

```
onChangeTokenCreated: async (changeToken) => {
  // 1. Remove placeholder token from pool
  // 2. Create uiToken for the real change token
  // 3. await addToken(uiToken)  ← adds to this.tokens
}
```

After step 3, `this.tokens` has grown. This is the trigger for `SpendQueue.notifyChange()`.

### 7.2 Integration Point

`addToken()` is the single integration point. After `this.tokens.set(uiToken.id, uiToken)` completes inside `addToken()`, it calls `this.spendQueue.notifyChange(uiToken.coinId)`. This is a synchronous call that initiates `notifyChange()`.

No other integration points are required. External token arrivals (Nostr receive) also go through `addToken()`, so they naturally trigger queue advancement as well — this is the correct behavior described in edge case G.3.

### 7.3 Placeholder Tokens and the Queue

The current code creates a placeholder token with `status: 'transferring'` immediately after the Nostr send. This placeholder has `_placeholder: true` in its sdkData. The `TokenSplitCalculator` already filters out non-`confirmed` tokens. The ledger's free-amount computation must also exclude placeholders.

**Decision:** Placeholder tokens are excluded from the `ParsedTokenPool` during pool construction. They are not candidates for new reservations. This prevents the queue from thinking a placeholder satisfies a request.

### 7.4 Race: Change Token Arrives Before Queue Check

If a change token arrives and `notifyChange()` runs before the caller's `send()` has re-entered the critical section, the token is in the pool and available. The queue entry will be served on the `notifyChange()` pass. The `send()` call will find its promise already resolved when it `await`s — no deadlock.

### 7.5 Race: Multiple Queued Requests, Single Change Token

If change token C (amount 400) arrives and two queued requests each need 300 from that coin:

- `notifyChange()` runs.
- First satisfiable entry (say request A needs 300): planner finds C is free (400 >= 300). Plans A using C (split: 300 to recipient, 100 remainder). Reserves 300 from C. Resolves A's promise.
- Continues iterating. Request B needs 300. Planner finds C has only 100 free. Total inventory for coinId: existing tokens + C's unreserved 100. If sufficient with other tokens, B is served. If not, B remains queued.
- A's send() resumes. Its split produces a new change token (100). `addToken()` fires. `notifyChange()` runs again. If B needs that 100 combined with something else, it may now be served.

### 7.6 The Circular Dependency Risk

Risk: request B is waiting for request A's change token. Request A is waiting in the queue behind request B. Both wait forever.

This cannot happen with the skip-ahead queue: `notifyChange()` does not block at B; it skips B and serves A first, producing the change token that will eventually serve B.

The only way circular waiting can occur is if:
- All entries in the queue are mutually blocked on each other's change tokens
- No change token from any other source arrives

This is an inherently unresolvable situation (deadlock-equivalent). The 30-second queue timeout prevents indefinite blocking. Requests are rejected with a `QUEUE_TIMEOUT` error, freeing all reserved amounts and triggering another `notifyChange()` pass that may unblock remaining entries.

---

## 8. Failure and Cancellation Handling

### 8.1 Send Failure After Reservation

The `send()` method has a `try/catch` block. On entry into the catch block, the following cleanup must occur:

1. `ledger.cancel(reservationId)` — synchronous, frees reserved amounts immediately
2. `spendQueue.notifyChange(request.coinId)` — may unblock waiting requests
3. Restore `token.status = 'confirmed'` for any tokens already marked `'transferring'` — existing behavior, unchanged

The existing catch block at line 1360 already handles step 3. Steps 1 and 2 are added to the same catch block.

If the failure occurs before the reservation was created (e.g., recipient resolution failed), no ledger entry exists. The cancel call must be a no-op in that case — `ledger.cancel()` checks for existence before removing.

### 8.2 Aggregator Rejection (REQUEST_ID_EXISTS)

This is the existing scenario where a concurrent send happened to produce the same `requestId`. The aggregator accepts the commitment but notes the ID already exists. The current code treats this as a success (`SUCCESS` or `REQUEST_ID_EXISTS`). No change needed from the queue's perspective — the reservation is committed (not cancelled) and the token is removed normally.

With the spend queue in place, the TOCTOU race that caused duplicate `requestId` values is eliminated. `REQUEST_ID_EXISTS` should become exceedingly rare. It is retained as a defensive case.

### 8.3 Reservation Timeout

When the 30-second per-entry timeout fires and expires a stale reservation (section 4.7):
1. `ledger.cancel(reservationId)` removes the stale entry
2. `spendQueue.notifyChange(coinId)` runs
3. The corresponding `send()` is almost certainly already in its catch block (or completed). The cancel is idempotent — if the send already called `cancel()`, the entry is already gone and the sweep is a no-op.

The sweep must not call `send()`'s existing error-path token-status restoration, since that is the send's responsibility. The sweep only manages the ledger.

### 8.4 destroy() Called with Pending Queue Entries

When `PaymentsModule.destroy()` is called (or will be called — the module does not currently have a `destroy()` method for the payments layer; this is a future concern noted in the existing `pendingBackgroundTasks` pattern):

1. Set a `destroyed` flag.
2. Call `spendQueue.destroy()` — rejects all queued entries with `MODULE_DESTROYED` error.
3. The `send()` calls awaiting those promises throw `MODULE_DESTROYED` and proceed to their catch blocks.
4. Catch blocks call `ledger.cancel()` and restore token statuses.

This mirrors the `withInvoiceGate` destroyed-check pattern in `AccountingModule`.

---

## 9. Integration with Existing Patterns

### 9.1 AccountingModule.withInvoiceGate

`withInvoiceGate` serializes invoice-level mutations (close, cancel, pay, return) per invoice. It does not touch the token pool directly — it calls `deps.payments.send()` and `deps.payments.returnPayment()`.

The spend queue operates inside `send()`. From `withInvoiceGate`'s perspective, `send()` is still a single async call that either succeeds or fails. The queue's internal waiting is transparent.

No coupling change is needed. The two serialization mechanisms are orthogonal: `withInvoiceGate` serializes invoice state transitions; the spend queue serializes token pool access.

### 9.2 payInvoice()

`payInvoice()` acquires the invoice gate briefly to check terminal state (lines 2175–2183), then releases it before calling `send()`. This is intentional — the spec notes that the gate is released before the network call to avoid blocking other operations.

With the spend queue, `payInvoice()` calls `send()` normally. If the send is queued (waiting for change tokens), the gate is not held during the wait — this is correct. Another `closeInvoice()` call could arrive and close the invoice while `payInvoice()` is waiting in the queue. The accounting module's post-send attribution logic handles this: the payment is attributed to a closed invoice and auto-return fires if configured.

### 9.3 returnInvoicePayment()

`returnInvoicePayment()` calls `send()` while holding the invoice gate (line 2376 — it uses `return this.withInvoiceGate(invoiceId, async () => { ... send() ... })`). This means the gate is held across the entire send duration, including any time spent in the queue.

This is correct by design. The spec requires that concurrent returns for the same invoice are serialized to prevent double-return. If the send is queued, the gate is held, which serializes subsequent return attempts for the same invoice behind this one.

The practical risk is that a return for invoice X holds X's gate while waiting in the spend queue for a change token from a send for invoice Y. Invoice X's gate is blocked, but invoice Y's gate is independent — no cross-invoice deadlock is possible.

### 9.4 Auto-Return Flows

Auto-return calls `this.deps.payments.send()` (through the `returnInvoicePayment` path or directly). It is subject to the same spend queue rules. No special treatment is needed. Auto-return's dedup ledger (`AutoReturnManager`) already handles retry semantics — if a queued return is eventually rejected (queue timeout, insufficient funds), the auto-return ledger marks it as `failed` and the retry mechanism in `setAutoReturn()` can reset it to `pending`.

---

## 10. Key Invariants

### I1 — Reservation Before Await

A token's free amount in the ledger must be reduced **before** any `await` point that reads the token pool for a different concurrent operation. This is enforced by ensuring `ledger.reserve()` is called synchronously within the critical section, before any `await`.

Violation of I1 is the root cause of the original TOCTOU bug.

### I2 — Free Amount Non-Negative

`freeAmount(tokenId, coinId) >= 0` always. The ledger never reserves more than a token's total amount. `SpendPlanner.plan()` enforces this by checking `freeAmount >= required` before creating a reservation.

### I3 — Reservation Sum Invariant

For every token T in the pool:
```
sum(entry.amount for all entries where entry.tokenId === T.id) <= T.amount
```

This invariant is maintained by the synchronous critical section. I3 can temporarily be violated only if a reservation is released after its `removeToken()` has already been called — this is prevented by always calling `commit()` (not `cancel()`) on the happy path.

### I4 — Queue Entry Has Reservation or No Entry

A send that is waiting in the queue has **no active reservation** in the ledger. The reservation is created only when the queue entry is served (the planner finds sufficient free tokens). A queued entry that has not yet been served contributes nothing to the ledger.

This avoids the situation where queued requests pre-reserve tokens they cannot yet use, further reducing the free pool and blocking other requests.

### I5 — Change Token Triggers Exactly One notifyChange Pass

Each `addToken()` call triggers exactly one `notifyChange()` pass. Multiple change tokens arriving in rapid succession each trigger their own pass. Passes are synchronous (no `await`) and therefore cannot interleave. This ensures no change token arrival is silently missed by the queue.

### I6 — Destroy Rejects All Queue Entries Before Cleanup

After `destroy()` returns (or its promise resolves), no queued entry has a pending promise. All callers of `send()` that were waiting in the queue have either resolved or rejected. This prevents zombie promises outliving the module.

---

## 11. Edge Cases

### E1 — All Tokens Locked, Change Never Arrives (Failed Split)

Scenario: All tokens are reserved by concurrent sends. One send fails at the aggregator level without producing a change token (e.g., the background `startBackground()` throws and the `onChangeTokenCreated` callback never fires).

Handling:
- The failed send's catch block calls `ledger.cancel(reservationId)`.
- `spendQueue.notifyChange()` runs — queued requests may now be served.
- The split token that was consumed is archived by `removeToken()`. No change token entered the pool.
- If total remaining inventory (after archival) is insufficient for queued requests, `notifyChange()` will call `entry.reject(INSUFFICIENT_BALANCE)` for each affected entry.

### E2 — Rapid-Fire Sends Exhausting the Pool

Scenario: 10 sends arrive simultaneously, each needing 100 UCT. Pool has 1000 UCT in a single token.

Handling:
- Send 1 enters the critical section. Pool has 1000 free. Plans a split: 100 to recipient, 900 remainder. Reserves 100.
- Send 2 enters the critical section. Free amount of T1 is 900. Plans a split: 100 to recipient, 800 remainder. Reserves 100.
- ... this continues for sends 3–10, each claiming 100 from T1.
- All 10 sends proceed in parallel using partial reservations on T1.
- The aggregator receives 10 distinct split commitments. Each creates its own split of T1's state.

Wait — this is a problem. A single token T1 cannot be split 10 times simultaneously. Each split creates a new state from T1's current state. The second split would reference T1's pre-first-split state, and the aggregator would reject it because T1 has already been committed for the first split.

**Revised decision:** Partial reservations are only valid when the reserved amount equals the full `splitAmount` and leaves a meaningful remainder. More importantly, only ONE send at a time may claim a split of any given token. A token that will undergo a split (as opposed to direct full-value transfer) may only carry ONE active reservation.

This is enforced in `SpendPlanner.plan()`:
- For each candidate split token, check that `ledger.getReservations(tokenId).length === 0` before planning a split on it.
- For direct-transfer tokens (full value), same single-reservation constraint applies.

The practical effect: if all tokens are locked for splits, new sends are queued rather than attempting simultaneous splits on the same token.

### E3 — External Token Arrives While Queue Is Waiting

Scenario: A token is received via Nostr while 3 sends are waiting in the queue.

Handling:
- Nostr reception calls `addToken(newToken)`.
- `addToken()` adds to `this.tokens` and calls `spendQueue.notifyChange(coinId)`.
- `notifyChange()` runs and may serve one or more queued requests using the new token.

This is the correct behavior. External arrivals are indistinguishable from change token arrivals at the queue level.

### E4 — destroy() Called While Queue Has Pending Requests

Handling described in section 8.4. The key requirement is that `destroy()` runs synchronously (no `await`), rejecting all entries immediately so their catch blocks can run synchronously in the same event-loop turn if the runtime permits, or in the next microtask batch.

### E5 — Split Produces Change Token Immediately Needed by Queued Request

Scenario: Queued request B is waiting for 100 UCT. Send A completes and its change token (150 UCT) arrives. B needs only 100 of those 150.

Handling:
- `addToken()` fires for the 150 UCT change token.
- `notifyChange()` runs. B is examined.
- The planner sees 150 free UCT. B needs 100. Plans a split on the change token: 100 to recipient, 50 remainder. Reserves 100.
- B's promise resolves. B's `send()` resumes with the pre-built split plan.
- B executes the split, producing a 50 UCT change token.
- `addToken()` fires for the 50 UCT change token. `notifyChange()` runs again (in case more queue entries were waiting for this coin).

### E6 — Queue Entry Becomes Unfulfillable Mid-Wait

Scenario: Queued request B is waiting for 100 UCT. While waiting, a `sync()` operation discovers that several tokens are invalid and removes them. Total inventory drops below 100 UCT.

Handling:
- Token removal calls `removeToken()`.
- `removeToken()` should call `spendQueue.notifyChange(coinId)` (new integration point — in addition to `addToken()`).
- `notifyChange()` runs. For B, `decision.type === 'reject'` (total inventory < 100). B is rejected with `INSUFFICIENT_BALANCE`.

This requires `removeToken()` to trigger a queue advance check, same as `addToken()`.

---

## 12. Files That Need to Change

| File | Change Required |
|------|----------------|
| `modules/payments/PaymentsModule.ts` | Add `TokenReservationLedger`, `SpendQueue`, `SpendPlanner` instances; modify `send()` and `sendInstant()` to go through the synchronous critical section; call `ledger.cancel()` / `ledger.commit()` in catch/success paths; call `spendQueue.notifyChange()` from `addToken()` and `removeToken()` |
| `modules/payments/TokenSplitCalculator.ts` | Add `calculateOptimalSplitSync()` accepting a pre-parsed pool and free-amount map; existing `calculateOptimalSplit()` becomes a thin async wrapper |
| `modules/payments/TokenReservationLedger.ts` | New file — implements the ledger (section 4) |
| `modules/payments/SpendQueue.ts` | New file — implements the queue and planner (sections 5, 6) |
| `modules/payments/index.ts` | Export new types if any are exposed (likely not — these are internal) |
| `tests/unit/modules/PaymentsModule.concurrency.test.ts` | New test file — concurrent send scenarios, queue behavior, change token wake-up |

The `AccountingModule`, `InstantSplitExecutor`, `TokenSplitExecutor`, and `BackgroundCommitmentService` files require **no changes**. The spend queue is entirely internal to `PaymentsModule`.

---

## 13. Architecture Decision Records

### ADR-001: Synchronous Critical Section via Pre-Parsed Pool

**Decision:** Extract all async token parsing (`SdkToken.fromJSON()`) from the planning step into a pre-computation phase. The planning and reservation step is fully synchronous.

**Rationale:** JavaScript's event loop guarantees that synchronous code is not interrupted. Placing the reservation creation in a synchronous function eliminates the TOCTOU window without any locking primitives.

**Alternative considered:** Wrapping the entire planning + execution in a global async mutex (single-concurrency semaphore). Rejected because it serializes all sends regardless of token overlap, destroying parallelism for independent sends.

### ADR-002: Ledger Tracks Amounts, Not Just Presence

**Decision:** The ledger stores the exact amount committed from each token per reservation, not merely a boolean "locked" flag.

**Rationale:** A boolean lock would prevent multiple sends from using different portions of a large token. Amount tracking enables partial reservation, maximizing parallelism when a token is large enough to serve multiple sends via splits.

**Constraint added:** Only one split per token at a time (section E2). The amount tracking still provides value for the combination case (direct transfer tokens in multi-token sends).

### ADR-003: Queue Rather Than Reject When Total Inventory Sufficient

**Decision:** When the free pool cannot satisfy a request but the total inventory (free + reserved) can, enqueue rather than reject.

**Rationale:** Rejecting in this case would require callers to implement their own retry logic, leading to thundering-herd behavior when multiple callers retry simultaneously. The queue provides back-pressure and orderly service.

**Alternative considered:** Return a `TEMPORARILY_INSUFFICIENT` error and let callers retry. Rejected because retry timing is non-trivial (change token latency is ~2.3s but variable), and coordinating retries across concurrent callers is complex.

### ADR-004: FIFO Queue with Pass-Over

**Decision:** `notifyChange()` scans the entire queue and serves any satisfiable entry, not just the head. Entries that cannot be planned are passed over.

**Rationale:** Strict FIFO would block a small send (10 UCT) behind a large send (10,000 UCT) that is waiting for a large change token. Pass-over maximizes throughput for independent requests.

**Starvation prevention:** Entries that remain unsatisfied are eventually rejected by the per-entry timeout (`QUEUE_TIMEOUT_MS = 30s`). No explicit `skipCount` or promotion mechanism is implemented — the timeout provides the starvation bound.

### ADR-005: No Cross-Module Coupling

**Decision:** The spend queue is entirely internal to `PaymentsModule`. `AccountingModule` is not modified.

**Rationale:** `AccountingModule`'s `withInvoiceGate` and the spend queue address different concerns at different abstraction levels. Invoice-level serialization and token-level reservation are orthogonal. Coupling them would create dependency complexity without benefit.

---

## 14. Open Questions

The following questions require product or engineering input before implementation begins:

1. **Partial reservation on splits (ADR-002 constraint):** Is the "one split per token at a time" constraint acceptable, or does the system need to support simultaneous splits of the same token? If yes, the architecture needs a mechanism to invalidate concurrent split commitments at the aggregator level.

2. **Queue timeout value (30s):** Should this be configurable in `PaymentsModuleConfig`? If operators of node.js wallets expect higher concurrency loads, they may want a longer timeout.

3. **Starvation bound (MAX_SKIP_COUNT = 10):** Is 10 the right value, or should it be configurable?

4. **`sendInstant()` relationship to `send()`:** `sendInstant()` currently has its own token-selection path (lines 1450–1455) that duplicates `send()`'s selection logic. Should `sendInstant()` be refactored to share the spend queue with `send()`, or treated as a separate entry point that also goes through its own critical section? The safest approach is to unify both through a shared `planSpend()` entry point.
