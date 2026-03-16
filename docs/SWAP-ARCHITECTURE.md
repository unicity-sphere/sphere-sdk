# Swap Module Architecture

> **Status:** Draft specification -- no code yet
> **Module path:** `modules/swap/SwapModule.ts`
> **Barrel:** `modules/swap/index.ts`

---

## 1. Executive Summary

### What the SwapModule Is

The SwapModule is the **client-side SDK component** for executing two-party currency swaps. It runs inside each participant's wallet (browser or Node.js) and orchestrates the local side of a swap: proposing deals to counterparties, accepting or rejecting proposals, depositing funds into escrow, monitoring settlement, and verifying payouts.

### What the SwapModule Is NOT

The SwapModule does **not** replicate the escrow service's server-side orchestration. It does not create deposit invoices, manage timeout timers, close invoices, or execute cross-currency payouts. Those responsibilities belong to the escrow service (`/home/vrogojin/escrow-service`), which runs as a separate process with its own `Sphere` instance and `AccountingModule`.

### Relationship to Existing Components

```
┌─────────────────────────────────────────────────────────────────┐
│                      Party's Wallet (SDK)                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ SwapModule   │───▶│ Accounting   │───▶│ PaymentsModule   │  │
│  │ (this spec)  │    │ Module       │    │ (L3 transfers)   │  │
│  │              │───▶│              │    │                  │  │
│  │              │    └──────────────┘    └──────────────────┘  │
│  │              │───▶┌──────────────┐                          │
│  │              │    │ Comms Module │                          │
│  │              │    │ (DMs)        │                          │
│  └──────┬───────┘    └──────────────┘                          │
│         │                                                      │
└─────────┼──────────────────────────────────────────────────────┘
          │ DMs (Nostr NIP-17)
          ▼
┌──────────────────────┐         ┌──────────────────────────────┐
│   Counterparty       │         │   Escrow Service             │
│   (another wallet)   │         │   (SwapOrchestrator +        │
│                      │         │    AccountingModule)          │
└──────────────────────┘         └──────────────────────────────┘
```

The SwapModule is a **consumer** of the AccountingModule -- it calls `importInvoice()`, `payInvoice()`, `getInvoiceStatus()`, and listens to invoice events. It does not extend or modify the AccountingModule's internals.

### Current vs Future

The current design uses an **escrow-backed** swap mechanism: a trusted intermediary holds deposits and executes cross-currency payouts. The SwapModule's public API is designed to be **mechanism-agnostic**, so that a future **predicate-based direct swap** implementation (using HTLC-like L3 predicates) can replace the escrow-backed internals without changing the caller-facing interface.

---

## 2. Architecture Overview

### Three-Tier Relationship

```
┌───────────────────────────────────────────────────────┐
│  Tier 1: AccountingModule (foundation)                │
│  - Invoice minting, import, status, payInvoice()      │
│  - Balance computation from on-chain memo references   │
│  - Terminal states, auto-return, frozen balances       │
│  - Events: invoice:payment, invoice:covered, etc.     │
├───────────────────────────────────────────────────────┤
│  Tier 2: SwapModule (this document)                   │
│  - P2P proposal/acceptance protocol (new DM types)    │
│  - Local swap state machine (SwapProgress)            │
│  - Escrow DM interaction (announce, status, etc.)     │
│  - Invoice import/payment delegation to Tier 1        │
│  - Payout verification                                │
├───────────────────────────────────────────────────────┤
│  Tier 3: EscrowService (external)                     │
│  - Deposit invoice creation and management            │
│  - Timeout enforcement and cancellation               │
│  - Payout invoice creation and payment                │
│  - DM-based API (announce_result, invoice_delivery)   │
└───────────────────────────────────────────────────────┘
```

The SwapModule depends on Tier 1 (AccountingModule) for all invoice operations. Tier 3 (EscrowService) is an external process that the SwapModule communicates with exclusively via Nostr DMs. The SwapModule never calls the escrow directly -- all interaction is asynchronous message-passing.

### Module File Structure

```
modules/swap/
  SwapModule.ts          # Main module class
  types.ts               # SwapDeal, SwapProposal, SwapRef, SwapProgress, events
  state-machine.ts       # Local swap state transitions
  manifest.ts            # Manifest construction + swap_id derivation (SHA-256 of JCS)
  dm-protocol.ts         # DM message types + parse/build helpers
  escrow-client.ts       # DM-based escrow interaction (announce, status, etc.)
  index.ts               # Barrel exports + createSwapModule factory
```

---

## 3. SwapDeal Lifecycle

This section describes the full lifecycle of a swap from each party's perspective. Throughout, "Party A" is the swap proposer and "Party B" is the counterparty, matching the manifest field naming convention.

### Phase 1: Proposal (P2P via CommunicationsModule)

The proposal phase happens entirely between the two parties -- the escrow is not involved.

```
┌──────────┐                              ┌──────────┐
│  Party A │                              │  Party B │
│ (proposer)│                              │          │
└─────┬────┘                              └────┬─────┘
      │                                        │
      │  1. Construct SwapDeal                 │
      │  2. Compute swap_id from manifest      │
      │  3. Persist local SwapRecord           │
      │     (state: PROPOSED)                  │
      │                                        │
      │ ──── swap_proposal DM ──────────────▶  │
      │                                        │
      │                          4. Parse deal │
      │                          5. Verify     │
      │                             swap_id    │
      │                          6. Evaluate   │
      │                             terms      │
      │                                        │
      │  ◀──── swap_acceptance DM ──────────── │
      │        (or swap_rejection)             │
      │                                        │
      │  7. Update state: ACCEPTED             │
      │     (or REJECTED → terminal)           │
```

**Step 1-3: Proposer constructs the deal.**

The proposer calls `proposeSwap(deal)` which:

1. Validates deal parameters (addresses, currencies, amounts, timeout, escrow address).
2. Constructs the canonical `SwapManifest` from the deal terms.
3. Computes the `swap_id` as `SHA-256(JCS(manifest_fields))` -- the same derivation used by the escrow service (see [Section 8](#8-swap-id-derivation)).
4. Persists a local `SwapRecord` with state `PROPOSED`.
5. Sends a `swap_proposal` DM to the counterparty via `CommunicationsModule`.
6. Emits `swap:proposed` event.

**Step 4-6: Counterparty evaluates the proposal.**

When Party B receives a `swap_proposal` DM, the SwapModule:

1. Parses and validates the manifest.
2. Recomputes `swap_id` from the manifest fields and verifies it matches the claimed `swap_id`.
3. Verifies that the sender's address matches one of the party addresses in the manifest.
4. Persists a local `SwapRecord` with state `PROPOSAL_RECEIVED`.
5. Emits `swap:proposal_received` event with the full deal terms for the UI to display.

The user (or application logic) then calls either `acceptSwap(swapId)` or `rejectSwap(swapId, reason?)`.

**Step 7: Proposal resolution.**

- **Acceptance:** Party B's SwapModule sends a `swap_acceptance` DM. Both parties' local states advance to `ACCEPTED`.
- **Rejection:** Party B's SwapModule sends a `swap_rejection` DM. Both parties' local states advance to `REJECTED` (terminal).

### Phase 2: Escrow Announcement

After acceptance, both parties independently announce the swap to the escrow.

```
┌──────────┐        ┌──────────┐        ┌──────────┐
│  Party A │        │  Escrow  │        │  Party B │
└─────┬────┘        └────┬─────┘        └────┬─────┘
      │                  │                   │
      │ ── announce ───▶ │                   │
      │                  │ ◀── announce ──── │
      │                  │                   │
      │                  │ (creates deposit  │
      │                  │  invoice)         │
      │                  │                   │
      │ ◀─ announce_result ─                 │
      │ ◀─ invoice_delivery ─                │
      │                  │                   │
      │                  ─ announce_result ─▶ │
      │                  ─ invoice_delivery ▶ │
      │                  │                   │
      │ 1. Import        │                   │ 2. Import
      │    invoice       │                   │    invoice
```

Each party's SwapModule:

1. Sends an `announce` DM to the escrow address containing the full manifest (see protocol-spec Section 1.1).
2. Waits for `announce_result` and `invoice_delivery` DMs from the escrow.
3. On receiving `invoice_delivery` with `invoice_type: "deposit"`:
   - Calls `accounting.importInvoice(invoice_token)` to import the deposit invoice.
   - Persists the `deposit_invoice_id` in the local swap record.
   - Updates local state to `ANNOUNCED`.
   - Emits `swap:announced` event.

**Failure handling:** If the `announce` DM receives an `error` response, the SwapModule retries with exponential backoff (see [Section 10](#10-error-handling-and-recovery)). If the escrow is unreachable (DM delivery fails), the local state remains `ACCEPTED` and the announcement is retried on the next `load()`.

### Phase 3: Deposit

Each party pays their share into the deposit invoice.

```
┌──────────┐        ┌──────────┐        ┌──────────┐
│  Party A │        │  Escrow  │        │  Party B │
└─────┬────┘        └────┬─────┘        └────┬─────┘
      │                  │                   │
      │  payInvoice()    │                   │
      │  (currency_A,    │                   │
      │   value_A)       │                   │
      │ ═══ L3 transfer ═══▶                 │
      │                  │                   │
      │                  │    payInvoice()   │
      │                  │    (currency_B,   │
      │                  │     value_B)      │
      │                  ◀═══ L3 transfer ═══ │
      │                  │                   │
      │  invoice:payment │                   │
      │  event           │                   │
      │                  │   invoice:payment │
      │                  │   event           │
```

When the user calls `deposit(swapId)`, the SwapModule:

1. Looks up the local swap record to find the `deposit_invoice_id` and the party's role (A or B).
2. Determines the party's deposit parameters:
   - Party A deposits `party_a_currency_to_change` for `party_a_value_to_change`.
   - Party B deposits `party_b_currency_to_change` for `party_b_value_to_change`.
3. Calls `accounting.payInvoice(depositInvoiceId, params)` where `params` specifies the correct `targetIndex` (always 0 -- single-target deposit invoice) and `assetIndex` (0 for Party A's currency, 1 for Party B's currency).
4. Updates local state to `DEPOSITING`.
5. Emits `swap:deposited` event when the transfer completes.

**Asset index mapping (from escrow protocol-spec Section 2.1):**

The deposit invoice has a single target (the escrow's address) with two coin assets:
- `assets[0]` = `party_a_currency_to_change` at `party_a_value_to_change`
- `assets[1]` = `party_b_currency_to_change` at `party_b_value_to_change`

Therefore:
- Party A calls: `payInvoice(id, { targetIndex: 0, assetIndex: 0 })`
- Party B calls: `payInvoice(id, { targetIndex: 0, assetIndex: 1 })`

After depositing, the SwapModule monitors `invoice:payment` events to track the counterparty's deposit. When the party's own deposit is confirmed but the counterparty has not yet deposited, local state advances to `AWAITING_COUNTER`.

### Phase 4: Settlement (Escrow-Side, Parties Observe)

Settlement is driven entirely by the escrow. The parties observe it through DMs and invoice events.

```
┌──────────┐        ┌──────────┐        ┌──────────┐
│  Party A │        │  Escrow  │        │  Party B │
└─────┬────┘        └────┬─────┘        └────┬─────┘
      │                  │                   │
      │                  │ (both deposits    │
      │                  │  covered)         │
      │                  │                   │
      │                  │ closeInvoice()    │
      │                  │ createPayout A    │
      │                  │ createPayout B    │
      │                  │ payInvoice() x2   │
      │                  │                   │
      │ ◀─ invoice_delivery (payout) ─       │
      │ ◀─ payment_confirmation ──────       │
      │                  │                   │
      │                  ─ invoice_delivery ▶ │
      │                  ─ payment_confirm ─▶ │
      │                  │                   │
      │ import payout    │   import payout   │
      │ invoice          │   invoice         │
      │ verify status    │   verify status   │
```

When the SwapModule receives an `invoice_delivery` DM with `invoice_type: "payout"`:

1. Imports the payout invoice: `accounting.importInvoice(payout_token)`.
2. Persists the `payout_invoice_id` in the local swap record.
3. Updates local state to `CONCLUDING`.
4. Emits `swap:concluding` event.

When the SwapModule receives a `payment_confirmation` DM:

1. Verifies the payout status via `accounting.getInvoiceStatus(payoutInvoiceId)`.
2. Confirms the payout currency and amount match the expected swap terms.
3. If verification succeeds, local state advances to `COMPLETED`.
4. Emits `swap:completed` event.

### Phase 5: Completion and Verification

The `verifyPayout(swapId)` method performs the full verification protocol described in escrow protocol-spec Section 8:

1. Retrieves the payout invoice status from `accounting.getInvoiceStatus()`.
2. Verifies `state` is `'COVERED'` or `'CLOSED'`.
3. Verifies `targets[0].coinAssets[0].isCovered === true`.
4. Verifies the correct currency: the counterparty's currency, not the party's own.
5. Verifies the correct amount: `netCoveredAmount >= expected_amount`.
6. Optionally waits for `allConfirmed === true` (unicity proofs).
7. Returns `true` if all checks pass, `false` otherwise.

### Phase Summary: Cancellation Path

Swaps can be cancelled at several points:

```
PROPOSED / PROPOSAL_RECEIVED ──▶ REJECTED     (user rejects proposal)
ACCEPTED ──────────────────────▶ CANCELLED    (user cancels before announcement)
ANNOUNCED / DEPOSITING / ─────▶ CANCELLED    (escrow times out → swap_cancelled DM)
  AWAITING_COUNTER
```

On receiving a `swap_cancelled` DM from the escrow:
1. Update local state to `CANCELLED`.
2. The escrow handles deposit returns via the AccountingModule's auto-return mechanism.
3. Emit `swap:cancelled` event.

---

## 4. Local State Machine (SwapProgress)

### State Definitions

| State | Description | Who transitions here |
|-------|-------------|---------------------|
| `PROPOSED` | Proposer sent proposal DM, awaiting response | Proposer only |
| `PROPOSAL_RECEIVED` | Received proposal DM, awaiting user decision | Counterparty only |
| `ACCEPTED` | Proposal accepted by counterparty | Both parties |
| `REJECTED` | Proposal rejected (terminal) | Both parties |
| `ANNOUNCED` | Announced to escrow, deposit invoice imported | Both parties |
| `DEPOSITING` | Party's own deposit transfer in progress | Both parties |
| `AWAITING_COUNTER` | Own deposit confirmed, waiting for counterparty | Both parties |
| `CONCLUDING` | Payout invoice received, verifying settlement | Both parties |
| `COMPLETED` | Payout verified (terminal) | Both parties |
| `CANCELLED` | Swap cancelled by escrow or user (terminal) | Both parties |
| `FAILED` | Unrecoverable error (terminal) | Both parties |

### Transition Diagram

```
                                  ┌──────────┐
                     ┌───────────▶│ REJECTED │ (terminal)
                     │            └──────────┘
                     │
┌──────────┐    ┌────┴───────────┐    ┌──────────┐
│ PROPOSED │───▶│ ACCEPTED       │───▶│ANNOUNCED │
└──────────┘    └────┬───────────┘    └────┬─────┘
     │               │                    │
     │               │ (cancel            │
     │               │  before            ▼
     │               │  announce)    ┌──────────┐    ┌─────────────────┐
     │               ▼               │DEPOSITING│───▶│AWAITING_COUNTER │
     │          ┌──────────┐        └────┬─────┘    └────┬────────────┘
     │          │CANCELLED │             │               │
     │          │(terminal)│◀────────────┤               │
     │          └──────────┘             │               │
     │                                   ▼               ▼
     │                              ┌──────────┐
     │                              │CONCLUDING│
     │                              └────┬─────┘
     │                                   │
     │                                   ▼
     │          ┌──────────┐       ┌──────────┐
     └─────────▶│ FAILED   │       │COMPLETED │
                │(terminal)│       │(terminal)│
                └──────────┘       └──────────┘

┌───────────────────────────────┐
│ PROPOSAL_RECEIVED             │ (counterparty entry point)
│  ├──▶ ACCEPTED ──▶ ...       │
│  └──▶ REJECTED               │
└───────────────────────────────┘
```

### Valid Transitions

```typescript
const VALID_TRANSITIONS: Record<SwapProgress, Set<SwapProgress>> = {
  PROPOSED:           new Set(['ACCEPTED', 'REJECTED', 'CANCELLED', 'FAILED']),
  PROPOSAL_RECEIVED:  new Set(['ACCEPTED', 'REJECTED', 'FAILED']),
  ACCEPTED:           new Set(['ANNOUNCED', 'CANCELLED', 'FAILED']),
  REJECTED:           new Set([]),  // terminal
  ANNOUNCED:          new Set(['DEPOSITING', 'CANCELLED', 'FAILED']),
  DEPOSITING:         new Set(['AWAITING_COUNTER', 'CONCLUDING', 'CANCELLED', 'FAILED']),
  AWAITING_COUNTER:   new Set(['CONCLUDING', 'CANCELLED', 'FAILED']),
  CONCLUDING:         new Set(['COMPLETED', 'CANCELLED', 'FAILED']),
  COMPLETED:          new Set([]),  // terminal
  CANCELLED:          new Set([]),  // terminal
  FAILED:             new Set([]),  // terminal
};
```

### Mapping to Escrow States

The SwapModule's local states do not have a 1:1 correspondence with the escrow service's `SwapState` enum (defined in `/home/vrogojin/escrow-service/src/core/state-machine.ts`). The local state machine captures the **party's perspective**, while the escrow state machine captures the **escrow's perspective**.

| Local SwapProgress | Escrow SwapState(s) | Notes |
|-------------------|---------------------|-------|
| `PROPOSED` | (no escrow involvement) | P2P phase only |
| `PROPOSAL_RECEIVED` | (no escrow involvement) | P2P phase only |
| `ACCEPTED` | (no escrow involvement) | Before announcement |
| `ANNOUNCED` | `ANNOUNCED`, `DEPOSIT_INVOICE_CREATED` | Escrow creates invoice |
| `DEPOSITING` | `DEPOSIT_INVOICE_CREATED`, `PARTIAL_DEPOSIT` | Party paying |
| `AWAITING_COUNTER` | `PARTIAL_DEPOSIT` | One party paid |
| `CONCLUDING` | `DEPOSIT_COVERED`, `CONCLUDING` | Escrow settling |
| `COMPLETED` | `COMPLETED` | Both verified |
| `CANCELLED` | `TIMED_OUT`, `CANCELLING`, `CANCELLED` | Escrow cancelled |
| `FAILED` | `FAILED` | Unrecoverable |

### Offline Tolerance

The wallet may be offline during parts of the swap lifecycle. On `load()`, the SwapModule resumes non-terminal swaps by:

1. Querying the escrow for current status via `status` DM for each active swap.
2. Comparing the escrow's response against local state.
3. Fast-forwarding the local state if the escrow has progressed further (e.g., the escrow delivered a payout while the wallet was offline).
4. Re-importing any missed invoice tokens via `request_invoice` DM if needed.

---

## 5. DM Protocol Extensions

### 5.1 New P2P Message Types

These message types are exchanged **between the two swap parties** via CommunicationsModule (Nostr NIP-17 encrypted DMs). They are NOT sent to the escrow.

#### `swap_proposal`

Sent by the proposer to the counterparty.

```json
{
  "type": "swap_proposal",
  "v": 1,
  "manifest": {
    "swap_id": "<64 hex chars>",
    "party_a_address": "<DIRECT:// | @nametag>",
    "party_b_address": "<DIRECT:// | @nametag>",
    "party_a_currency_to_change": "<coinId>",
    "party_a_value_to_change": "<positive integer string>",
    "party_b_currency_to_change": "<coinId>",
    "party_b_value_to_change": "<positive integer string>",
    "timeout": 3600
  },
  "escrow_address": "<DIRECT:// | @nametag of escrow service>",
  "message": "Optional free-text message from proposer"
}
```

**Validation on receipt:**
- Recompute `swap_id` from manifest fields and verify it matches.
- Verify the sender's DIRECT address matches `party_a_address` (proposer is always Party A by convention).
- Verify `party_b_address` matches the recipient's own DIRECT address.
- Verify currencies differ and amounts are positive.
- Verify timeout is in range [60, 86400].

#### `swap_acceptance`

Sent by the counterparty to the proposer after accepting.

```json
{
  "type": "swap_acceptance",
  "v": 1,
  "swap_id": "<64 hex chars>"
}
```

**Validation on receipt:**
- Verify `swap_id` matches an existing local swap record in `PROPOSED` state.
- Verify the sender's address matches `party_b_address` in the stored manifest.

#### `swap_rejection`

Sent by the counterparty to the proposer after rejecting.

```json
{
  "type": "swap_rejection",
  "v": 1,
  "swap_id": "<64 hex chars>",
  "reason": "Optional human-readable reason"
}
```

### 5.2 Existing Escrow DM Types (Reused)

The SwapModule reuses the escrow service's DM protocol as defined in `/home/vrogojin/escrow-service/docs/protocol-spec.md`. It sends:

| Direction | Type | Purpose |
|-----------|------|---------|
| Party -> Escrow | `announce` | Submit manifest to escrow |
| Party -> Escrow | `status` | Query swap status |
| Party -> Escrow | `request_invoice` | Re-request deposit or payout invoice token |

And receives:

| Direction | Type | Purpose |
|-----------|------|---------|
| Escrow -> Party | `announce_result` | Announcement confirmation |
| Escrow -> Party | `invoice_delivery` | Deposit or payout invoice token |
| Escrow -> Party | `status_result` | Current swap status |
| Escrow -> Party | `payment_confirmation` | Payout completed notification |
| Escrow -> Party | `swap_cancelled` | Swap cancelled (timeout or manual) |
| Escrow -> Party | `bounce_notification` | Deposit bounced back |
| Escrow -> Party | `error` | Error response |

### 5.3 DM Handler Registration

The SwapModule registers its DM handlers alongside the existing `CommunicationsModule` handlers. It uses the same `onDirectMessage()` subscription mechanism:

```typescript
// In SwapModule.load()
this.dmUnsubscribe = this.deps.communications.onDirectMessage((dm) => {
  this.handleIncomingDM(dm);
});
```

The handler inspects the `type` field of parsed JSON DMs. It claims only the message types it recognizes (`swap_proposal`, `swap_acceptance`, `swap_rejection`, and escrow response types when the sender matches a known escrow address). Unrecognized types are silently ignored, allowing other modules (AccountingModule's receipt/cancellation DMs, generic chat) to coexist.

**Message routing by sender:**
- DMs from the counterparty's address: routed to P2P proposal handlers.
- DMs from the escrow's address: routed to escrow response handlers.
- DMs from unknown addresses: ignored (not a swap participant).

The escrow address for each swap is stored in the local swap record. The SwapModule maintains a reverse index (`escrowAddress -> Set<swapId>`) for efficient routing.

---

## 6. SDK Module Integration

### 6.1 Dependencies

```typescript
/**
 * Dependencies injected into SwapModule.
 * Follows the same pattern as AccountingModuleDependencies.
 */
export interface SwapModuleDependencies {
  /** AccountingModule for invoice operations */
  accounting: AccountingModule;
  /** CommunicationsModule for DM send/receive */
  communications: CommunicationsModule;
  /** PaymentsModule (indirect via accounting, also for resolve()) */
  payments: PaymentsModule;
  /** Storage for swap records (same StorageProvider as other modules) */
  storage: StorageProvider;
  /** Current wallet identity */
  identity: FullIdentity;
  /** Current tracked address */
  currentAddress: TrackedAddress;
  /** Event emitter function (from Sphere) */
  emitEvent: <T extends SphereEventType>(event: T, data: SphereEventMap[T]) => void;
}
```

### 6.2 Configuration

```typescript
/**
 * Configuration for SwapModule.
 * Passed to createSwapModule() at construction time.
 */
export interface SwapModuleConfig {
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Default escrow address used when proposeSwap() is called without
   * an explicit escrow. Can be a DIRECT://, @nametag, or chain pubkey.
   */
  defaultEscrowAddress?: string;
  /**
   * Maximum number of concurrent active (non-terminal) swaps.
   * Defense against resource exhaustion. Default: 50.
   */
  maxActiveSwaps?: number;
  /**
   * Timeout (ms) for escrow DM responses before retrying.
   * Default: 30000 (30 seconds).
   */
  escrowResponseTimeout?: number;
}
```

### 6.3 Module Lifecycle

The SwapModule follows the same lifecycle pattern as the AccountingModule (see `/home/vrogojin/sphere-sdk/modules/accounting/AccountingModule.ts`):

```typescript
class SwapModule {
  // Construction: createSwapModule(config) — stores config only
  constructor(config: SwapModuleConfig) { ... }

  // Phase 1: Dependency injection — called by Sphere after all modules are created
  initialize(deps: SwapModuleDependencies): void { ... }

  // Phase 2: Load state from storage — called by Sphere during address setup
  async load(): Promise<void> {
    // 1. Load persisted swap records from storage
    // 2. Subscribe to DM events
    // 3. Subscribe to invoice events (for deposit/payout monitoring)
    // 4. Resume non-terminal swaps (send status queries to escrows)
  }

  // Phase 3: Cleanup — called by Sphere on address switch or destroy
  async destroy(): Promise<void> {
    // 1. Unsubscribe from DM events
    // 2. Unsubscribe from invoice events
    // 3. Drain in-flight operations (withSwapGate)
    // 4. Clear in-memory state
  }
}
```

**Integration in Sphere class** (mirroring the AccountingModule pattern from `/home/vrogojin/sphere-sdk/core/Sphere.ts` lines 489-492):

```typescript
// In Sphere constructor
this._swap = swapConfig ? createSwapModule(swapConfig) : null;

// In Sphere._setupAddress()
if (this._swap) {
  this._swap.initialize({
    accounting: this._accounting!,
    communications: this._communications,
    payments: this._payments,
    storage: this._storage,
    identity: this._identity,
    currentAddress: this._currentAddress,
    emitEvent: this.emitEvent.bind(this),
  });
  await this._swap.load();
}

// In Sphere.destroy()
if (this._swap) {
  await this._swap.destroy();
}
```

### 6.4 Per-Swap Async Mutex (withSwapGate)

Every mutating operation on a given swap is serialized through a per-swap promise chain, mirroring the `withInvoiceGate` pattern from `AccountingModule` (line 705 of `/home/vrogojin/sphere-sdk/modules/accounting/AccountingModule.ts`):

```typescript
private readonly swapGates = new Map<string, Promise<unknown>>();

private async withSwapGate<T>(swapId: string, fn: () => Promise<T>): Promise<T> {
  if (this.destroyed) {
    throw new SphereError('SwapModule has been destroyed.', 'MODULE_DESTROYED');
  }

  const prev = this.swapGates.get(swapId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // chain regardless of success/failure
  this.swapGates.set(swapId, next);

  try {
    return await next;
  } finally {
    // Clean up idle gates
    if (this.swapGates.get(swapId) === next) {
      this.swapGates.delete(swapId);
    }
  }
}
```

This prevents races between concurrent operations on the same swap (e.g., a `deposit()` call racing with an incoming `swap_cancelled` DM).

### 6.5 Storage

Swap records are persisted via `StorageProvider` using per-address scoped keys, following the same pattern as the AccountingModule:

```typescript
// Storage key pattern (per-address scoped)
const SWAP_RECORDS_KEY = 'swap_records';      // Map<swapId, SwapRecord>
const SWAP_ESCROW_INDEX_KEY = 'swap_escrow_idx'; // Map<escrowAddress, Set<swapId>>
```

The storage format:

```typescript
interface SwapRecordStorage {
  [swapId: string]: PersistedSwapRecord;
}

interface PersistedSwapRecord {
  swap_id: string;
  manifest: SwapManifest;
  state: SwapProgress;
  escrow_address: string;
  my_role: 'A' | 'B';
  deposit_invoice_id: string | null;
  payout_invoice_id: string | null;
  counterparty_pubkey: string;  // for DM routing
  created_at: number;           // epoch ms
  updated_at: number;           // epoch ms
  error_message: string | null;
  proposal_message: string | null; // optional proposer message
}
```

### 6.6 Event Emission

Events are emitted through the Sphere event emitter, following the same pattern as accounting events. New event types are added to `SphereEventMap`:

```typescript
// In types/index.ts — additions to SphereEventMap
interface SphereEventMap {
  // ... existing events ...

  // Swap events
  'swap:proposed': { swapId: string; counterparty: string; manifest: SwapManifest };
  'swap:proposal_received': { swapId: string; proposer: string; manifest: SwapManifest; message?: string };
  'swap:accepted': { swapId: string };
  'swap:rejected': { swapId: string; reason?: string };
  'swap:announced': { swapId: string; depositInvoiceId: string };
  'swap:deposited': { swapId: string; transferResult: TransferResult };
  'swap:deposit_received': { swapId: string; partySide: 'A' | 'B' };
  'swap:concluding': { swapId: string; payoutInvoiceId: string };
  'swap:completed': { swapId: string; verified: boolean };
  'swap:cancelled': { swapId: string; reason: string; depositsReturned: boolean };
  'swap:failed': { swapId: string; error: string };
}
```

---

## 7. API Surface

### 7.1 Public Methods

```typescript
class SwapModule {
  /**
   * Propose a swap to a counterparty.
   *
   * Constructs a SwapManifest, computes the content-addressed swap_id,
   * persists a local record, and sends a swap_proposal DM.
   *
   * @param deal - The swap deal terms.
   * @returns SwapProposal with the computed swap_id and manifest.
   * @throws SphereError('SWAP_INVALID_PARAMS') if deal terms are invalid.
   * @throws SphereError('SWAP_LIMIT_EXCEEDED') if maxActiveSwaps reached.
   */
  async proposeSwap(deal: SwapDeal): Promise<SwapProposal>;

  /**
   * Accept an incoming swap proposal.
   *
   * Sends a swap_acceptance DM to the proposer and advances local state
   * to ACCEPTED. Automatically proceeds to escrow announcement.
   *
   * @param swapId - The swap_id of a proposal in PROPOSAL_RECEIVED state.
   * @throws SphereError('SWAP_NOT_FOUND') if no such swap exists.
   * @throws SphereError('SWAP_INVALID_STATE') if not in PROPOSAL_RECEIVED.
   */
  async acceptSwap(swapId: string): Promise<void>;

  /**
   * Reject an incoming swap proposal.
   *
   * Sends a swap_rejection DM and moves local state to REJECTED (terminal).
   *
   * @param swapId - The swap_id of a proposal in PROPOSAL_RECEIVED state.
   * @param reason - Optional rejection reason (max 256 chars).
   */
  async rejectSwap(swapId: string, reason?: string): Promise<void>;

  /**
   * Deposit funds into the swap's escrow invoice.
   *
   * Delegates to accounting.payInvoice() with the correct target and asset
   * indices based on the party's role in the swap.
   *
   * @param swapId - The swap_id of a swap in ANNOUNCED state.
   * @returns TransferResult from the underlying payInvoice() call.
   * @throws SphereError('SWAP_DEPOSIT_INVOICE_MISSING') if invoice not imported.
   * @throws SphereError('SWAP_INVALID_STATE') if not in ANNOUNCED.
   */
  async deposit(swapId: string): Promise<TransferResult>;

  /**
   * Get the current status of a swap.
   *
   * Returns the local swap record with computed status. For DEPOSITING
   * and later states, also includes deposit coverage information from
   * the AccountingModule.
   *
   * @param swapId - The swap_id to query.
   * @returns SwapRef with full status, or null if not found.
   */
  getSwapStatus(swapId: string): SwapRef | null;

  /**
   * List swaps with optional filtering.
   *
   * @param filter - Optional filter criteria (state, counterparty, date range).
   * @returns Array of SwapRef objects, sorted by updated_at descending.
   */
  getSwaps(filter?: SwapFilter): SwapRef[];

  /**
   * Verify that the payout for a completed swap matches the deal terms.
   *
   * Performs the full verification protocol: checks payout invoice status,
   * verifies currency, amount, and confirmation status.
   *
   * @param swapId - The swap_id of a swap in CONCLUDING or COMPLETED state.
   * @returns true if payout is verified, false if verification fails.
   */
  async verifyPayout(swapId: string): Promise<boolean>;

  /**
   * Cancel a swap from the local side.
   *
   * For PROPOSED state: sends a cancellation DM to counterparty.
   * For ACCEPTED state: sends cancellation DM, does NOT announce to escrow.
   * For ANNOUNCED and later: sends a status query to the escrow. The actual
   * cancellation can only be performed by the escrow (timeout or admin).
   * The local state is updated to CANCELLED if the escrow confirms cancellation.
   *
   * @param swapId - The swap_id to cancel.
   * @throws SphereError('SWAP_CANNOT_CANCEL') if in CONCLUDING or terminal state.
   */
  async cancelSwap(swapId: string): Promise<void>;
}
```

### 7.2 Types

```typescript
/**
 * Input for proposing a swap. User-facing — addresses can be nametags.
 */
interface SwapDeal {
  /** Counterparty address (@nametag, DIRECT://, or chain pubkey) */
  counterparty: string;
  /** Currency the proposer will send (coinId, e.g. 'UCT') */
  sendCurrency: string;
  /** Amount the proposer will send (smallest units, string) */
  sendAmount: string;
  /** Currency the proposer will receive (coinId, e.g. 'USDU') */
  receiveCurrency: string;
  /** Amount the proposer will receive (smallest units, string) */
  receiveAmount: string;
  /** Swap timeout in seconds (60-86400, default: 3600) */
  timeout?: number;
  /** Escrow address (defaults to SwapModuleConfig.defaultEscrowAddress) */
  escrowAddress?: string;
  /** Optional message to counterparty */
  message?: string;
}

/**
 * Result of proposeSwap(). Contains the computed manifest.
 */
interface SwapProposal {
  /** Content-addressed swap identifier */
  swapId: string;
  /** Full manifest (suitable for independent verification) */
  manifest: SwapManifest;
}

/**
 * Lightweight swap reference returned by getSwapStatus() and getSwaps().
 */
interface SwapRef {
  swapId: string;
  manifest: SwapManifest;
  state: SwapProgress;
  myRole: 'A' | 'B';
  escrowAddress: string;
  counterpartyAddress: string;
  counterpartyNametag?: string;
  depositInvoiceId: string | null;
  payoutInvoiceId: string | null;
  /** Deposit coverage (only populated after ANNOUNCED) */
  depositStatus?: {
    myDeposited: boolean;
    counterpartyDeposited: boolean;
    myAmount: string;
    counterpartyAmount: string;
  };
  createdAt: number;
  updatedAt: number;
  errorMessage: string | null;
}

/**
 * The swap manifest — the canonical agreement between two parties.
 * Same structure as the escrow's SwapManifest.
 * @see /home/vrogojin/escrow-service/src/core/manifest-validator.ts
 */
interface SwapManifest {
  swap_id: string;
  party_a_address: string;
  party_b_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
}

/**
 * Filter options for getSwaps().
 */
interface SwapFilter {
  /** Filter by state(s) */
  states?: SwapProgress[];
  /** Filter by counterparty address or nametag */
  counterparty?: string;
  /** Filter by escrow address */
  escrowAddress?: string;
  /** Filter swaps created after this timestamp */
  createdAfter?: number;
  /** Filter swaps created before this timestamp */
  createdBefore?: number;
  /** Maximum number of results */
  limit?: number;
}
```

### 7.3 Events

| Event | Payload | When |
|-------|---------|------|
| `swap:proposed` | `{ swapId, counterparty, manifest }` | Proposal DM sent to counterparty |
| `swap:proposal_received` | `{ swapId, proposer, manifest, message? }` | Proposal DM received from proposer |
| `swap:accepted` | `{ swapId }` | Counterparty accepted the proposal |
| `swap:rejected` | `{ swapId, reason? }` | Counterparty rejected the proposal |
| `swap:announced` | `{ swapId, depositInvoiceId }` | Escrow acknowledged, deposit invoice imported |
| `swap:deposited` | `{ swapId, transferResult }` | Own deposit transfer completed |
| `swap:deposit_received` | `{ swapId, partySide }` | Counterparty's deposit detected |
| `swap:concluding` | `{ swapId, payoutInvoiceId }` | Payout invoice received from escrow |
| `swap:completed` | `{ swapId, verified }` | Payout verified, swap complete |
| `swap:cancelled` | `{ swapId, reason, depositsReturned }` | Swap cancelled (timeout or user) |
| `swap:failed` | `{ swapId, error }` | Unrecoverable error |

---

## 8. Swap ID Derivation

The swap ID is a **content-addressed identifier** computed as the SHA-256 hash of the canonical JSON representation (RFC 8785 / JCS) of the manifest fields, excluding the `swap_id` field itself.

### Derivation Algorithm

```typescript
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Fields included in the swap_id hash — alphabetically ordered by JCS.
 * Matches the escrow's ManifestFields type from:
 * /home/vrogojin/escrow-service/src/utils/hash.ts
 */
interface ManifestFields {
  party_a_address: string;
  party_a_currency_to_change: string;
  party_a_value_to_change: string;
  party_b_address: string;
  party_b_currency_to_change: string;
  party_b_value_to_change: string;
  timeout: number;
}

function computeSwapId(fields: ManifestFields): string {
  // JCS (RFC 8785) serializes keys in lexicographic order.
  // The canonical form for the above fields is:
  // {"party_a_address":"...","party_a_currency_to_change":"...", ... ,"timeout":...}
  const canonical = canonicalize(fields);
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}
```

### Key Properties

1. **Deterministic:** Both parties compute the same `swap_id` independently from the same deal terms.
2. **Tamper-evident:** Any modification to the manifest fields produces a different `swap_id`.
3. **Collision-resistant:** SHA-256 provides 128-bit collision resistance.
4. **Escrow-compatible:** The SwapModule's derivation is identical to the escrow service's derivation (`/home/vrogojin/escrow-service/src/utils/hash.ts` lines 19-25). Both use `canonicalize` (RFC 8785) + SHA-256.

### Fields Included

The hash input contains exactly these fields (JCS orders them lexicographically by key):

| Field | Type | Example |
|-------|------|---------|
| `party_a_address` | string | `"DIRECT://02abc..."` or `"@alice"` |
| `party_a_currency_to_change` | string | `"UCT"` |
| `party_a_value_to_change` | string | `"1000000"` |
| `party_b_address` | string | `"DIRECT://03def..."` or `"@bob"` |
| `party_b_currency_to_change` | string | `"USDU"` |
| `party_b_value_to_change` | string | `"500000000"` |
| `timeout` | number | `3600` |

The `escrow_address` is intentionally **excluded** from the hash. This allows the same deal terms to be executed through different escrow services without changing the swap_id. The escrow address is carried alongside the manifest in the `swap_proposal` DM but is not part of the cryptographic commitment.

### Browser Compatibility

The SDK must provide a browser-compatible implementation of SHA-256 and JCS. The `@noble/hashes` library (already a dependency of the SDK) provides SHA-256. For JCS serialization, the `canonicalize` npm package provides a browser-compatible RFC 8785 implementation. This is the same package used by the escrow service.

**Dependency addition:** `canonicalize` must be added to `package.json`. It is a small, dependency-free package (~2KB).

---

## 9. Security Model

### 9.1 Trust in Escrow

The current escrow-backed design requires **full custody trust** during the swap window:

- The escrow holds both parties' deposits after the deposit phase.
- The escrow creates and pays payout invoices unilaterally.
- A compromised or malicious escrow could steal deposited funds.

**Mitigations:**
- The escrow's chain pubkey is public and verifiable. Invoice `creator` fields always contain the escrow's pubkey.
- Payout invoice terms can be independently verified by each party (currency, amount, recipient address).
- The swap timeout limits the custody window.
- The escrow address is agreed upon by both parties before announcement.

### 9.2 Address Verification

**Nametag squatting defense:** Before depositing funds, the SwapModule re-resolves the escrow's address to guard against nametag reassignment between proposal and deposit:

```typescript
// In deposit(), before calling payInvoice()
const resolvedEscrow = await this.deps.payments.resolve(swap.escrow_address);
if (!resolvedEscrow) {
  throw new SphereError('Escrow address resolution failed', 'SWAP_ESCROW_UNREACHABLE');
}

// Compare resolved address against the deposit invoice's target address
const invoiceStatus = await this.deps.accounting.getInvoiceStatus(swap.deposit_invoice_id);
const invoiceTargetAddress = invoiceStatus.targets[0]?.address; // should be ABSENT from the target...
// Actually, verify the invoice creator matches the known escrow pubkey:
const invoice = await this.deps.accounting.getInvoice(swap.deposit_invoice_id);
if (invoice?.terms.creator !== resolvedEscrow.chainPubkey) {
  throw new SphereError('Invoice creator does not match escrow', 'SWAP_ESCROW_MISMATCH');
}
```

### 9.3 Invoice Verification

When receiving an `invoice_delivery` DM from the escrow, the SwapModule verifies the delivered invoice matches expected swap terms:

**Deposit invoice verification:**
1. `terms.creator` matches the known escrow chain pubkey.
2. `terms.targets[0].assets` contains exactly two coin entries.
3. `assets[0].coin[0]` matches `party_a_currency_to_change` and `assets[0].coin[1]` matches `party_a_value_to_change`.
4. `assets[1].coin[0]` matches `party_b_currency_to_change` and `assets[1].coin[1]` matches `party_b_value_to_change`.

**Payout invoice verification (Section 8 of the escrow protocol-spec):**
1. `terms.creator` matches the known escrow chain pubkey (not `undefined` -- escrow invoices are never anonymous).
2. `terms.targets[0].address` matches the party's own DIRECT address.
3. `terms.targets[0].assets[0].coin[0]` matches the expected counter-currency.
4. `terms.targets[0].assets[0].coin[1]` matches the expected counter-value.

### 9.4 Party Verification

When receiving a `swap_proposal` DM:
- The sender's Nostr pubkey (which maps to a DIRECT address via `DIRECT://<hex_pubkey>`) must match `party_a_address` in the manifest.
- The recipient's own DIRECT address must match `party_b_address` in the manifest.
- The `swap_id` must be correctly derived from the manifest fields.

### 9.5 Replay Protection

Swap IDs are content-addressed. The same deal terms always produce the same swap_id. This means:
- A previously completed swap proposal sent again produces the same swap_id.
- The SwapModule checks for existing local records before processing a proposal.
- If a swap_id already exists in a terminal state, the proposal DM is ignored.
- If a swap_id exists in a non-terminal state, the proposal DM is treated as a re-delivery (idempotent).

---

## 10. Error Handling and Recovery

### 10.1 Crash Recovery

All swap state is persisted to `StorageProvider` after each transition. On `load()`:

1. Load all swap records from storage.
2. For each non-terminal swap, determine the recovery action:

| State on Crash | Recovery Action |
|----------------|-----------------|
| `PROPOSED` | Re-send `swap_proposal` DM (idempotent). Set a re-proposal timer. |
| `PROPOSAL_RECEIVED` | No action. Wait for user to accept/reject. |
| `ACCEPTED` | Re-send `swap_acceptance` DM (idempotent), then announce to escrow. |
| `ANNOUNCED` | Send `status` DM to escrow to check current state. |
| `DEPOSITING` | Check deposit invoice status. If payment went through, advance state. If not, retry deposit. |
| `AWAITING_COUNTER` | Send `status` DM to escrow. |
| `CONCLUDING` | Send `request_invoice` DM for payout if missing. Verify payout status. |

### 10.2 Timeout Handling

The SwapModule maintains a **local advisory timer** for each active swap, mirroring the escrow's timeout:

```typescript
// After deposit, start local timeout tracking
const timeoutMs = swap.manifest.timeout * 1000;
const depositedAt = Date.now(); // or first_deposit_at from escrow
const expiresAt = depositedAt + timeoutMs;

this.timeouts.set(swapId, setTimeout(() => {
  this.handleLocalTimeout(swapId);
}, expiresAt - Date.now()));
```

The local timer is **advisory only** -- it does not cancel the swap. When it fires, the SwapModule:
1. Sends a `status` DM to the escrow.
2. If the escrow confirms cancellation (`state: 'CANCELLED'`), updates local state.
3. If the escrow reports the swap is still active (e.g., just covered), updates local state accordingly.

The escrow's timeout is authoritative. The local timer serves to prompt the UI to display a timeout warning and trigger a status check.

### 10.3 Network Failure and Retry

DM sends use exponential backoff with jitter:

```
Attempt 1: immediate
Attempt 2: 2s + jitter(0-1s)
Attempt 3: 4s + jitter(0-2s)
Attempt 4: 8s + jitter(0-4s)
Attempt 5: 16s + jitter(0-8s)
Max retries: 5 (then transition to FAILED with descriptive error)
```

Retries apply to:
- `swap_proposal` DM delivery
- `announce` DM to escrow
- `status` DM to escrow
- `request_invoice` DM to escrow

Retries do NOT apply to:
- `deposit()` -- payment failures are reported immediately to the caller
- `acceptSwap()` / `rejectSwap()` -- if DM fails, the operation fails

### 10.4 Partial Deposits

If a deposit transfer partially fails (e.g., insufficient tokens for the full amount), the SwapModule reports the error from `payInvoice()` to the caller. The escrow handles partial deposits gracefully:

- The deposit invoice tracks partial coverage via the AccountingModule.
- The escrow's timeout will eventually fire and cancel the swap if full coverage is not reached.
- On cancellation, the escrow's auto-return mechanism returns all partial deposits.

### 10.5 Invoice Import Failures

If `accounting.importInvoice()` fails when processing an `invoice_delivery` DM:

1. Log the error.
2. Do NOT update local state (remain in pre-import state).
3. The party can retry by sending a `request_invoice` DM to the escrow.
4. On the next `load()`, recovery logic detects the missing invoice and requests re-delivery.

### 10.6 Error Codes

| Error Code | Description |
|------------|-------------|
| `SWAP_INVALID_PARAMS` | Invalid deal parameters (bad address, zero amount, etc.) |
| `SWAP_NOT_FOUND` | No swap record with the given swap_id |
| `SWAP_INVALID_STATE` | Operation not valid in the swap's current state |
| `SWAP_LIMIT_EXCEEDED` | Maximum active swaps reached |
| `SWAP_DUPLICATE_PROPOSAL` | Swap with this swap_id already exists |
| `SWAP_ESCROW_UNREACHABLE` | Cannot resolve or communicate with escrow |
| `SWAP_ESCROW_MISMATCH` | Invoice creator does not match expected escrow |
| `SWAP_DEPOSIT_INVOICE_MISSING` | Deposit invoice not yet imported |
| `SWAP_PAYOUT_VERIFICATION_FAILED` | Payout does not match expected terms |
| `SWAP_CANNOT_CANCEL` | Swap is in a state that cannot be cancelled locally |
| `SWAP_DM_DELIVERY_FAILED` | DM send failed after all retries |
| `MODULE_DESTROYED` | SwapModule has been destroyed |

---

## 11. Future Direction: Predicate-Based Direct Swaps

### The Abstraction Layer

The SwapModule's public API (`proposeSwap`, `acceptSwap`, `deposit`, `verifyPayout`, etc.) is designed to be **mechanism-agnostic**. The current implementation delegates to an escrow service, but the internal execution can be replaced without changing the caller-facing interface.

### Current: Escrow-Backed (Three Invoices)

```
Party A ──deposits──▶ Escrow ──pays──▶ Party B
Party B ──deposits──▶ Escrow ──pays──▶ Party A
```

Three invoices: one deposit, two payouts. Trusted intermediary holds custody.

### Future: Predicate-Based Direct Swaps

Unicity L3 supports programmable predicates on token ownership. An HTLC-like predicate can enforce atomic swaps without a trusted intermediary:

```
Party A: lock(tokenA, hash(secret), timeout) → Party B can claim with secret
Party B: lock(tokenB, hash(secret), timeout) → Party A can claim with secret
Party A: reveal secret → claims tokenB
Party B: uses revealed secret → claims tokenA
```

When predicate-based swaps are implemented:

1. `proposeSwap()` still constructs a manifest and sends a `swap_proposal` DM.
2. `acceptSwap()` still sends `swap_acceptance`.
3. `deposit()` locks the party's tokens with an HTLC predicate instead of paying into an escrow invoice.
4. `verifyPayout()` verifies the claimed tokens instead of checking a payout invoice.
5. The `escrowAddress` field becomes optional (not needed for direct swaps).

The `SwapDeal` type gains an optional `mechanism` field:

```typescript
interface SwapDeal {
  // ... existing fields ...
  /** Swap mechanism. Default: 'escrow'. Future: 'direct'. */
  mechanism?: 'escrow' | 'direct';
}
```

### Internal Strategy Pattern

The SwapModule uses an internal strategy interface for mechanism-specific operations:

```typescript
interface SwapExecutionStrategy {
  announce(swap: PersistedSwapRecord): Promise<void>;
  deposit(swap: PersistedSwapRecord): Promise<TransferResult>;
  verifyPayout(swap: PersistedSwapRecord): Promise<boolean>;
  cancel(swap: PersistedSwapRecord): Promise<void>;
}

// Current implementation
class EscrowSwapStrategy implements SwapExecutionStrategy { ... }

// Future implementation
class DirectSwapStrategy implements SwapExecutionStrategy { ... }
```

This separation is why the SwapModule exists as a distinct abstraction layer rather than being collapsed into application code. The P2P proposal protocol and local state machine remain unchanged across mechanisms -- only the execution strategy differs.

---

## 12. Module File Structure

### Detailed File Descriptions

```
modules/swap/
├── SwapModule.ts          # Main module class (~1500-2000 lines estimated)
│                          # - Constructor, initialize(), load(), destroy()
│                          # - Public API: proposeSwap, acceptSwap, deposit, etc.
│                          # - DM handler dispatch
│                          # - Invoice event handlers
│                          # - Per-swap gate (withSwapGate)
│                          # - Recovery logic in load()
│
├── types.ts               # All type definitions
│                          # - SwapDeal, SwapProposal, SwapRef
│                          # - SwapManifest (mirroring escrow's type)
│                          # - SwapProgress enum
│                          # - SwapModuleConfig, SwapModuleDependencies
│                          # - SwapFilter, PersistedSwapRecord
│                          # - Event payload types
│                          # - Error codes
│
├── state-machine.ts       # Local swap state transitions
│                          # - SwapProgress enum
│                          # - VALID_TRANSITIONS map
│                          # - isTerminalState(), isValidTransition()
│                          # - assertTransition()
│                          # Pattern: mirrors escrow's state-machine.ts
│                          # See: /home/vrogojin/escrow-service/src/core/state-machine.ts
│
├── manifest.ts            # Manifest construction + swap_id derivation
│                          # - ManifestFields type
│                          # - computeSwapId(fields): string
│                          # - isValidSwapId(id): boolean
│                          # - buildManifest(deal, myAddress): SwapManifest
│                          # - validateManifest(manifest): ValidationResult
│                          # Dependencies: canonicalize, @noble/hashes/sha256
│                          # Must produce identical output to:
│                          # /home/vrogojin/escrow-service/src/utils/hash.ts
│
├── dm-protocol.ts         # DM message types + parse/build helpers
│                          # - P2P types: SwapProposalMessage, SwapAcceptanceMessage,
│                          #   SwapRejectionMessage
│                          # - Escrow types: AnnounceMessage, StatusMessage,
│                          #   RequestInvoiceMessage (outgoing)
│                          # - Escrow response types: AnnounceResultMessage,
│                          #   InvoiceDeliveryMessage, StatusResultMessage,
│                          #   PaymentConfirmationMessage, SwapCancelledMessage,
│                          #   BounceNotificationMessage, ErrorMessage (incoming)
│                          # - buildProposalMessage(), parseProposalMessage()
│                          # - buildAnnounceMessage(), parseInvoiceDelivery()
│                          # - isSwapDM(dm): boolean — type discriminator
│                          # Mirrors: /home/vrogojin/escrow-service/docs/protocol-spec.md
│
├── escrow-client.ts       # DM-based escrow interaction layer
│                          # - EscrowClient class
│                          # - announce(escrowAddr, manifest): Promise<AnnounceResult>
│                          # - queryStatus(escrowAddr, swapId): Promise<StatusResult>
│                          # - requestInvoice(escrowAddr, swapId, type): Promise<void>
│                          # - Retry logic with exponential backoff
│                          # - Response correlation (DM request → response matching)
│                          # Dependencies: CommunicationsModule
│
└── index.ts               # Barrel exports + createSwapModule factory
                           # - export * from './types'
                           # - export { SwapModule, createSwapModule }
                           # - export { computeSwapId, buildManifest }
                           # Pattern: mirrors /home/vrogojin/sphere-sdk/modules/accounting/index.ts
```

### Dependency Graph

```
index.ts ─────▶ SwapModule.ts ─────▶ state-machine.ts
                     │                manifest.ts
                     │                dm-protocol.ts
                     │                escrow-client.ts
                     │
                     ▼
              types.ts (imported by all files)
```

### External Dependencies

| Dependency | Purpose | Already in SDK? |
|------------|---------|-----------------|
| `@noble/hashes` | SHA-256 for swap_id derivation | Yes |
| `canonicalize` | RFC 8785 JCS serialization | **No -- must be added** |
| `AccountingModule` | Invoice operations | Yes |
| `CommunicationsModule` | DM send/receive | Yes |
| `StorageProvider` | Persistent swap records | Yes |

### Size Estimates

| File | Estimated Lines | Rationale |
|------|----------------|-----------|
| `SwapModule.ts` | 1500-2000 | Main class with lifecycle, API, DM handling, recovery |
| `types.ts` | 300-400 | All types, interfaces, enums |
| `state-machine.ts` | 80-100 | State enum, transitions, validators |
| `manifest.ts` | 100-150 | Manifest construction, swap_id, validation |
| `dm-protocol.ts` | 300-400 | Message types, parsers, builders |
| `escrow-client.ts` | 250-350 | Escrow DM interaction, retry logic |
| `index.ts` | 15-25 | Barrel exports |
| **Total** | **~2600-3400** | |

---

## 13. CLI Commands

The SDK CLI exposes swap operations through three primary commands and two convenience commands, following the same `{module}-{action}` naming convention as invoice commands (`invoice-create`, `invoice-list`, `invoice-pay`, etc.).

### Primary Commands

**`swap-propose`** — Propose a swap deal to a counterparty

```
npm run cli -- swap-propose --to <recipient> \
  --offer-coin <coinId> --offer-amount <amount> \
  --want-coin <coinId> --want-amount <amount> \
  [--escrow <address>] [--timeout <seconds>] [--message <text>]
```

| Flag | Description |
|------|-------------|
| `--to` | Counterparty's @nametag, DIRECT:// address, or chain pubkey |
| `--offer-coin` / `--offer-amount` | What the proposer sends (coinId + amount in smallest units) |
| `--want-coin` / `--want-amount` | What the proposer expects to receive |
| `--escrow` | Escrow @nametag or DIRECT:// address (uses configured default if omitted) |
| `--timeout` | Swap timeout in seconds (default: 3600, range: 60–86400) |
| `--message` | Optional human-readable description sent to counterparty |

Maps to: `sphere.swap.proposeSwap(deal)` → sends `swap_proposal` DM to counterparty

Output: swap_id, manifest summary, status

---

**`swap-list`** — List swap deals

```
npm run cli -- swap-list [--all] [--role <proposer|acceptor>] [--progress <state>]
```

| Flag | Description |
|------|-------------|
| (default) | Shows only open deals (`proposed`, `accepted`, `announced`, `depositing`, `awaiting_counter`, `concluding`) — hides completed/cancelled/failed |
| `--all` | Show all deals including terminal states |
| `--role` | Filter by role (`proposer` or `acceptor`) |
| `--progress` | Filter by specific progress state |

Maps to: `sphere.swap.getSwaps(filter)` (local, synchronous)

Output: table with columns — swap_id (truncated), role, progress, counterparty, offer, want, created_at

---

**`swap-accept`** — Accept a proposed swap deal and execute it

```
npm run cli -- swap-accept <swap_id> [--deposit]
```

| Argument / Flag | Description |
|-----------------|-------------|
| `<swap_id>` | The 64-hex swap ID (from `swap-list` or from a received proposal notification) |
| `--deposit` | Also execute the deposit immediately after acceptance (otherwise deposit is a separate step) |

Without `--deposit`: only sends acceptance and announces to escrow. The user must then manually deposit via `swap-deposit`.

Maps to: `sphere.swap.acceptSwap(swapId)` + optionally `sphere.swap.deposit(swapId)`

Steps when `--deposit` is used:
1. Accept the swap (sends DM, announces to escrow, imports deposit invoice)
2. Automatically deposit by calling `sphere.swap.deposit(swapId)`
3. Print progress updates as events fire
4. Once `swap:completed` fires, print the final status and payout verification

Output: step-by-step progress log, final swap status

### Convenience Commands

**`swap-status`** — Show detailed status for a specific swap

```
npm run cli -- swap-status <swap_id> [--query-escrow]
```

Maps to: `sphere.swap.getSwapStatus(swapId)`

**`swap-deposit`** — Manually deposit into an announced swap (if `--deposit` was not used with `swap-accept`)

```
npm run cli -- swap-deposit <swap_id>
```

Maps to: `sphere.swap.deposit(swapId)`

### CLI-to-Protocol Data Flow

```
Proposer CLI                    Counterparty CLI                Escrow
─────────────                   ────────────────                ──────
swap-propose ──swap_proposal──►
                                swap-list (sees proposal)
                                swap-accept ──swap_acceptance──► (proposer)
                                             ──announce────────► ◄── announce_result
                                             ◄─invoice_delivery─
                                swap-accept --deposit
                                  └─payInvoice()──────────────►

(proposer also announces and deposits)
                                                                settlement...
                                             ◄─payment_confirm──
```

### Incoming Proposal Notification

When a counterparty sends a `swap_proposal` DM, the SwapModule emits a `swap:proposal_received` event. In the CLI, this triggers a console notification prompting the user to run `swap-list` to review incoming proposals. In a wallet UI, this event can drive a push notification or an in-app alert. The proposal remains in `PROPOSAL_RECEIVED` progress state until the user explicitly calls `swap-accept` or rejects it.

---

## Appendix A: Complete Data Flow Diagram

```
                          PROPOSAL PHASE (P2P)
                    ═══════════════════════════════

    Party A (Proposer)                              Party B (Counterparty)
    ──────────────────                              ──────────────────────
    proposeSwap(deal)
      │
      ├─ computeSwapId(manifest)
      ├─ persist(PROPOSED)
      ├─ sendDM(swap_proposal)  ─────────────────▶  onDM(swap_proposal)
      │                                               │
      │                                               ├─ verify swap_id
      │                                               ├─ verify addresses
      │                                               ├─ persist(PROPOSAL_RECEIVED)
      │                                               ├─ emit(swap:proposal_received)
      │                                               │
      │                                               │  [user accepts]
      │                                               │
      │  onDM(swap_acceptance)  ◀─────────────────  acceptSwap(swapId)
      │    │                                           │
      │    ├─ persist(ACCEPTED)                        ├─ sendDM(swap_acceptance)
      │    ├─ emit(swap:accepted)                      ├─ persist(ACCEPTED)
      │    │                                           │


                        ANNOUNCEMENT PHASE (via Escrow)
                    ══════════════════════════════════════

    Party A                     Escrow                    Party B
    ───────                     ──────                    ───────
    sendDM(announce) ──────────▶│                     ◀── sendDM(announce)
                                │
                                ├─ createInvoice()
                                │
    onDM(announce_result)◀──────│──────▶ onDM(announce_result)
    onDM(invoice_delivery)◀─────│──────▶ onDM(invoice_delivery)
      │                                           │
      ├─ importInvoice()                          ├─ importInvoice()
      ├─ persist(ANNOUNCED)                       ├─ persist(ANNOUNCED)
      │                                           │


                        DEPOSIT + SETTLEMENT PHASE
                    ════════════════════════════════

    Party A                     Escrow                    Party B
    ───────                     ──────                    ───────
    deposit(swapId)                                       deposit(swapId)
      │                                                     │
      ├─ payInvoice()                                       ├─ payInvoice()
      │   (asset 0)                                         │   (asset 1)
      │                                                     │
      ╠══ L3 transfer ═══════▶ │                            │
      │                        │ ◀══════════════════════════╣  L3 transfer
      │                        │
      │                        ├─ invoice:covered
      │                        ├─ closeInvoice()
      │                        ├─ createPayout A + B
      │                        ├─ payInvoice() x2
      │                        │
    onDM(invoice_delivery)◀────│────▶ onDM(invoice_delivery)
    onDM(payment_confirm) ◀────│────▶ onDM(payment_confirm)
      │                                           │
      ├─ importInvoice(payout)                    ├─ importInvoice(payout)
      ├─ verifyPayout()                           ├─ verifyPayout()
      ├─ persist(COMPLETED)                       ├─ persist(COMPLETED)
      ├─ emit(swap:completed)                     ├─ emit(swap:completed)
```

---

## Appendix B: Escrow DM Response Correlation

The Nostr DM protocol is asynchronous and unordered. The SwapModule must correlate escrow responses to outstanding requests. The correlation strategy:

1. **Type-based routing:** Each escrow response type (`announce_result`, `invoice_delivery`, etc.) contains a `swap_id` field that identifies the swap.

2. **Pending request tracking:** The `EscrowClient` maintains a map of pending requests:
   ```typescript
   private readonly pending = new Map<string, {
     type: string;       // e.g., 'announce', 'status'
     swapId: string;
     resolve: (msg: unknown) => void;
     reject: (err: Error) => void;
     timer: ReturnType<typeof setTimeout>;
   }>();
   ```

3. **Key format:** `${swapId}:${requestType}` -- at most one outstanding request per swap per type.

4. **Timeout:** If no response is received within `escrowResponseTimeout` (default 30s), the pending request is rejected and retry logic kicks in.

5. **Unsolicited messages:** Some escrow messages arrive without a prior request (e.g., `swap_cancelled` due to timeout, `bounce_notification`). These are routed directly to the SwapModule's event handlers by swap_id lookup.

---

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **SwapDeal** | User-facing input type for proposing a swap (human-friendly addresses) |
| **SwapManifest** | Canonical agreement structure with content-addressed `swap_id` |
| **SwapProgress** | Local state enum (party's perspective of swap lifecycle) |
| **SwapState** | Escrow's state enum (escrow's perspective), defined in escrow-service |
| **swap_id** | SHA-256 of JCS-serialized manifest fields (excluding swap_id itself) |
| **Party A** | The party listed first in the manifest; by convention, the proposer |
| **Party B** | The counterparty; by convention, the party receiving the proposal |
| **Deposit invoice** | Single-target, two-asset invoice created by escrow to collect both deposits |
| **Payout invoice** | Single-target, single-asset invoice created by escrow for each party's payout |
| **JCS** | JSON Canonicalization Scheme (RFC 8785) -- deterministic JSON serialization |
| **HTLC** | Hash Time-Locked Contract -- predicate pattern for trustless atomic swaps |
| **withSwapGate** | Per-swap async mutex preventing concurrent mutations |
