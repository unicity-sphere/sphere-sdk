# Swap Module Architecture

> **Status:** Implemented -- `feat/swap-module-spec` branch
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
+-------------------------------------------------------------+
|                      Party's Wallet (SDK)                     |
|                                                               |
|  +--------------+    +--------------+    +------------------+ |
|  | SwapModule   |--->| Accounting   |--->| PaymentsModule   | |
|  | (this module)|    | Module       |    | (L3 transfers)   | |
|  |              |--->|              |    |                  | |
|  |              |    +--------------+    +------------------+ |
|  |              |--->+--------------+                         |
|  |              |    | Comms Module |                         |
|  |              |    | (DMs)        |                         |
|  +--------------+    +--------------+                         |
|        |                                                      |
|        v                                                      |
|  +--------------+                                             |
|  | AsyncGateMap |  (per-swap mutex from core/async-gate.ts)   |
|  +--------------+                                             |
+-------------------------------------------------------------+
         |                        |
         | DM (Nostr NIP-17)      | L3 token transfers
         v                        v
+------------------+     +------------------+
| Escrow Service   |     | Unicity Network  |
| (separate process|     | (L3 aggregator)  |
|  with own Sphere)|     |                  |
+------------------+     +------------------+
```

The SwapModule:
- Delegates **invoice management** (import, pay, status) to AccountingModule.
- Delegates **DM send/receive** to CommunicationsModule.
- Delegates **token validation** to PaymentsModule (for payout verification).
- Uses **AsyncGateMap** (`core/async-gate.ts`) for per-swap serialization.
- Stores swap records via **StorageProvider** (same as other modules).

---

## 2. Architecture Overview

### Protocol Versions

The SwapModule supports two protocol versions:

| Version | Description | Announce Path |
|---------|-------------|---------------|
| **v1** (legacy) | Unsigned proposals. Proposer (Alice) announces to escrow after receiving acceptance. | Alice announces |
| **v2** (current default) | Signed proposals with consent signatures. Acceptor (Bob) announces directly to escrow with both signatures. | Bob announces |

**v2 advantages:**
- Proposer need not be online when acceptor decides to proceed.
- Escrow can cryptographically verify both parties consented before creating the swap.
- Nametag binding proofs prevent address spoofing.
- Salt field ensures unique swap_id even for identical deal re-proposals.

### Module Files (Implemented)

```
modules/swap/
+-- SwapModule.ts          # Main module class (2964 lines)
|                          # - Constructor, initialize(), load(), destroy()
|                          # - Public API: proposeSwap, acceptSwap, deposit, etc.
|                          # - DM handler dispatch (handleIncomingDM)
|                          # - Invoice event handlers (setupInvoiceEventSubscriptions)
|                          # - Per-swap gate (withSwapGate via AsyncGateMap)
|                          # - Crash recovery (reconnectPendingSwaps in load)
|                          # - Local timeout management (proposal + escrow timers)
|
+-- types.ts               # All type definitions (821 lines)
|                          # - SwapDeal, SwapManifest, ManifestFields
|                          # - SwapProgress, SwapRole, SwapRef
|                          # - DM message types (P2P and escrow)
|                          # - SwapModuleConfig, SwapModuleDependencies
|                          # - SwapEventMap, SwapEventType
|                          # - Storage types (SwapStorageData, SwapIndexEntry)
|
+-- state-machine.ts       # Local swap state transitions (112 lines)
|                          # - VALID_PROGRESS_TRANSITIONS map
|                          # - TERMINAL_PROGRESS set
|                          # - isTerminalProgress(), isValidTransition(), assertTransition()
|                          # - mapEscrowStateToProgress()
|
+-- manifest.ts            # Manifest construction + swap_id derivation (309 lines)
|                          # - computeSwapId(fields): SHA-256(JCS(fields))
|                          # - buildManifest(): includes salt + v2 escrow_address
|                          # - validateManifest(): full field validation + integrity
|                          # - verifyManifestIntegrity(): lightweight hash check
|                          # - signSwapManifest() / verifySwapSignature(): v2 consent
|                          # - createNametagBinding() / verifyNametagBinding(): v2 proofs
|                          # Dependencies: canonicalize, core/crypto (sha256, signMessage)
|
+-- dm-protocol.ts         # DM message builders + parsers (776 lines)
|                          # - P2P: buildProposalDM, buildProposalDM_v2
|                          # - P2P: buildAcceptanceDM, buildAcceptanceDM_v2
|                          # - P2P: buildRejectionDM
|                          # - Escrow: buildAnnounceDM, buildAnnounceDM_v2
|                          # - Escrow: buildStatusQueryDM, buildRequestInvoiceDM, buildCancelDM
|                          # - Universal parser: parseSwapDM() -> ParsedSwapDM | null
|                          # - Quick detector: isSwapDM()
|
+-- escrow-client.ts       # Stateless escrow DM helpers (291 lines)
|                          # - withRetry(): exponential backoff (2s base, 16s cap, 25% jitter)
|                          # - resolveEscrowAddress(): deal/config -> DIRECT + pubkey
|                          # - sendAnnounce() / sendAnnounce_v2(): 5 retries
|                          # - sendStatusQuery() / sendRequestInvoice(): 3 retries
|                          # - verifyEscrowSender(): identity check
|
+-- index.ts               # Barrel exports + createSwapModule factory
```

---

## 3. SwapDeal Lifecycle

This section describes the full lifecycle of a swap from each party's perspective. The proposer is "Alice" and the counterparty is "Bob". In the manifest, Alice may be party A or party B depending on how the deal addresses are specified.

### Phase 1: Proposal (P2P via CommunicationsModule)

The proposal phase happens entirely between the two parties -- the escrow is not involved.

```
+----------+                              +----------+
| Alice    |                              |   Bob    |
| (proposer)                              |          |
+-----+----+                              +----+-----+
      |                                        |
      |  1. Validate deal fields               |
      |  2. Resolve party addresses            |
      |  3. Resolve escrow address             |
      |  4. Build manifest (with salt)         |
      |  5. Sign manifest (v2)                 |
      |  6. Create nametag binding (v2, if @)  |
      |  7. Persist SwapRef (proposed)         |
      |                                        |
      | ---- swap_proposal DM (v2) --------->  |
      |                                        |
      |                          8. Verify     |
      |                             manifest   |
      |                             integrity  |
      |                          9. Verify     |
      |                             proposer   |
      |                             signature  |
      |                             (v2)       |
      |                         10. Verify     |
      |                             nametag    |
      |                             bindings   |
      |                         11. Persist    |
      |                             SwapRef    |
      |                             (proposed, |
      |                              acceptor) |
      |                                        |
      |  <---- swap_acceptance DM (v2) -----   |
      |        (informational for v2)          |
      |                                        |
      | 12. Store acceptor signature           |
      |     Emit swap:accepted                 |
      |     (v2: wait for escrow               |
      |      announce_result)                  |
```

**Implementation notes (from `SwapModule.ts`):**

- `proposeSwap()` always creates v2 proposals (protocol_version=2 in manifest).
- The manifest includes `escrow_address` and `salt` for v2.
- Proposer signs `"swap_consent:{swapId}:{escrowAddress}"` with their chain private key.
- A proposal timer is started (`proposalTimeoutMs`, default 5 min). If no acceptance arrives, the swap transitions to `failed`.

**Acceptance handling (v2 flow):**

In v2, the acceptance DM is informational for the proposer. Bob (the acceptor) announces directly to the escrow. Alice receives:
1. A `swap_acceptance_v2` DM from Bob (with Bob's signature).
2. An `announce_result` from the escrow (confirming the swap was created).

The acceptance handler verifies (inside `withSwapGate`):
1. Re-checks `swap.progress === 'proposed'` (TOCTOU guard).
2. If `swap.protocolVersion === 2` and the acceptance is v1 format, returns silently without clearing the timer (downgrade attack prevention).
3. Verifies `acceptor_signature` using `verifySwapSignature`. Rejects without clearing timer if invalid.
4. Only after all checks pass: clears the proposal timer.
5. If `transitionProgress` throws: restores `swap.progress` and `swap.updatedAt` in memory, re-arms the timer, and fire-and-forget re-persists the rolled-back state.

### Phase 2: Escrow Announcement

#### v2 Path (default): Bob announces directly

```
+----------+        +----------+        +----------+
| Alice    |        | Escrow   |        |   Bob    |
| (proposer)        |          |        | (acceptor)
+-----+----+        +----+-----+        +----+-----+
      |                  |                   |
      |                  |                   | acceptSwap()
      |                  |                   |   |
      |                  |                   |   +-- sign manifest (v2)
      |                  |                   |   +-- build announce_v2 DM
      |                  |                   |       (both signatures +
      |                  |                   |        chain pubkeys +
      |                  |                   |        auxiliary)
      |                  |                   |
      |                  | <-- announce_v2 --+
      |                  |                   |
      |                  | (verify sigs,     |
      |                  |  create deposit   |
      |                  |  invoice)         |
      |                  |                   |
      | <- announce_result                   |
      | <- invoice_delivery (deposit)        |
      |                  |                   |
      |                  +-- announce_result --> |
      |                  +-- invoice_delivery -> |
      |                  |                   |
      | import deposit   |   import deposit  |
      | invoice          |   invoice         |
      | -> ANNOUNCED     |   -> ANNOUNCED    |
```

**Key detail:** In v2, Alice does NOT announce to the escrow. She receives the `announce_result` because the escrow sends it to both parties. The `announce_result` handler allows `proposed -> announced` transition (not just `accepted -> announced`) to handle the case where the escrow's `announce_result` arrives before Bob's `swap_acceptance_v2` DM.

#### v1 Path (legacy): Alice announces after acceptance

```
+----------+        +----------+        +----------+
| Alice    |        | Escrow   |        |   Bob    |
| (proposer)        |          |        | (acceptor)
+-----+----+        +----+-----+        +----+-----+
      |                  |                   |
      | <- swap_acceptance (v1) ------------ |
      |                  |                   |
      | -- announce ---> |                   |
      |                  |                   |
      | <- announce_result                   |
      | <- invoice_delivery (deposit)        |
      |                  |                   |
      |                  +-- announce_result --> |
      |                  +-- invoice_delivery -> |
```

In v1, Alice (proposer) sends the `announce` DM after receiving the acceptance. Both parties then proceed identically.

### Phase 3: Deposit

Each party pays their share into the deposit invoice.

```
+----------+        +----------+        +----------+
| Alice    |        | Escrow   |        |   Bob    |
+-----+----+        +----+-----+        +----+-----+
      |                  |                   |
      |  deposit()       |                   |
      |  payInvoice()    |                   |
      |  (assetIndex=0   |                   |
      |   or 1)          |                   |
      | === L3 transfer ==>                  |
      |                  |                   |
      |                  |    deposit()      |
      |                  |    payInvoice()   |
      |                  <== L3 transfer === |
      |                  |                   |
      |  invoice:payment |   invoice:payment |
      |  event           |   event           |
```

When the user calls `deposit(swapId)`, the SwapModule:

1. Looks up the local swap record to find the `depositInvoiceId` and the party's role.
2. Determines the party's deposit `assetIndex` by matching the wallet's DIRECT address against the manifest's `party_a_address` and `party_b_address`.
   - If wallet matches `party_a_address`: `assetIndex = 0`
   - If wallet matches `party_b_address`: `assetIndex = 1`
3. Calls `accounting.payInvoice(depositInvoiceId, { targetIndex: 0, assetIndex })`.
4. Transitions to `depositing` on success.
5. Emits `swap:deposit_sent` event.

**TOCTOU guard:** The `deposit()` method re-checks `swap.progress === 'announced'` inside `withSwapGate` before executing `payInvoice`. A concurrent `cancelSwap` or escrow DM may have advanced the swap between the pre-gate check and gate acquisition.

**Failure handling:** If `payInvoice` throws, the swap state is NOT changed -- the user can retry. The error is wrapped in `SWAP_DEPOSIT_FAILED`.

After depositing, the SwapModule monitors `invoice:payment` events to track the counterparty's deposit. When the party's own deposit is confirmed but the counterparty has not yet deposited, local state advances to `awaiting_counter`.

### Phase 4: Settlement (Escrow-Side, Parties Observe)

Settlement is driven entirely by the escrow. The parties observe it through DMs and invoice events.

```
+----------+        +----------+        +----------+
| Alice    |        | Escrow   |        |   Bob    |
+-----+----+        +----+-----+        +----+-----+
      |                  |                   |
      |                  | (both deposits    |
      |                  |  covered)         |
      |                  |                   |
      |                  | closeInvoice()    |
      |                  | createPayout A    |
      |                  | createPayout B    |
      |                  | payInvoice() x2   |
      |                  |                   |
      | <- invoice_delivery (payout) --      |
      | <- payment_confirmation --------     |
      |                  |                   |
      |                  -- invoice_delivery -> |
      |                  -- payment_confirm --> |
      |                  |                   |
      | import payout    |   import payout   |
      | invoice          |   invoice         |
      | auto-verify      |   auto-verify     |
```

When the SwapModule receives an `invoice_delivery` DM with `invoice_type: "payout"`:

1. Imports the payout invoice: `accounting.importInvoice(payout_token)`.
2. Persists the `payoutInvoiceId` in the local swap record.
3. Emits `swap:payout_received` event.
4. Sets a `shouldAutoVerify` flag and fires `verifyPayout()` OUTSIDE the per-swap gate (see [Section 6.4](#64-asyncgatemap-constraint-and-auto-verification) for why).

When the SwapModule receives a `payment_confirmation` DM:

1. Transitions to `concluding` if not already terminal.
2. Emits `swap:concluding` event.

### Phase 5: Completion and Verification

The `verifyPayout(swapId)` method performs the full verification protocol:

1. Retrieves the payout invoice from `accounting.getInvoice()` for terms verification.
2. Retrieves the payout invoice status from `accounting.getInvoiceStatus()`.
3. Verifies `targets[0].assets[0].coin[0]` matches the expected counter-currency.
4. Verifies `targets[0].assets[0].coin[1]` matches the expected counter-amount.
5. Verifies `targets[0].address` matches the party's own DIRECT address.
6. Verifies `terms.creator` is defined (escrow invoices are non-anonymous).
7. Verifies `state` is `'COVERED'` or `'CLOSED'`.
8. Verifies `targets[0].coinAssets[0].isCovered === true`.
9. Verifies `netCoveredAmount >= expectedAmount`.
10. Resolves the escrow address and verifies `terms.creator === escrowPeer.chainPubkey`.
11. Validates L3 inclusion proofs via `payments.validate()`.
12. If all checks pass, transitions to `completed` with `payoutVerified: true`.

### Phase Summary: Cancellation Path

Swaps can be cancelled at several points:

```
proposed ---------> cancelled    (user rejects or cancels proposal)
accepted ---------> cancelled    (user cancels before announcement)
announced --------> cancelled    (escrow times out -> swap_cancelled DM)
depositing -------> cancelled    (escrow times out -> swap_cancelled DM)
awaiting_counter -> cancelled    (escrow times out -> swap_cancelled DM)
```

On receiving a `swap_cancelled` DM from the escrow:
1. Clear the local timer.
2. Transition to `cancelled`.
3. The escrow handles deposit returns via the AccountingModule's auto-return mechanism.
4. Emit `swap:cancelled` event.

The `cancelSwap()` method additionally sends a `cancel` DM to the escrow (for post-announcement states) and a rejection DM to the counterparty.

---

## 4. Local State Machine (SwapProgress)

### State Definitions

The implementation uses a 9-state machine (not the 11-state spec). Acceptors use `progress: 'proposed'` with `role: 'acceptor'` instead of a separate `PROPOSAL_RECEIVED` state. Rejections transition to `cancelled` instead of a separate `REJECTED` state. The `swap:rejected` event is emitted alongside `swap:cancelled` for clarity.

| State | Description | Who transitions here |
|-------|-------------|---------------------|
| `proposed` | Proposal sent (proposer) or received (acceptor). No escrow contact yet. | Both (role disambiguates) |
| `accepted` | Counterparty accepted. About to announce to escrow. | Both parties |
| `announced` | Escrow acknowledged. Deposit invoice available. | Both parties |
| `depositing` | Local deposit sent, awaiting confirmation or counterparty deposit. | Both parties |
| `awaiting_counter` | Local deposit confirmed. Waiting for counterparty to deposit. | Both parties |
| `concluding` | Escrow is executing payouts. Payout invoice expected soon. | Both parties |
| `completed` | Payout received and verified. **Terminal.** | Both parties |
| `cancelled` | Swap cancelled (timeout, explicit, rejection, or escrow failure). **Terminal.** | Both parties |
| `failed` | Unrecoverable error. **Terminal.** | Both parties |

### Transition Diagram

```
                    +----------+
       +----------->| cancelled| (terminal)
       |            +----------+
       |                 ^
       |                 |
+----------+    +--------+------+    +----------+
| proposed |---*| accepted      |--->| announced|
+----------+    +-------+-------+    +-----+----+
     |                  |                   |
     |                  |                   v
     |                  |            +----------+    +-----------------+
     |                  v            | depositing|-->| awaiting_counter|
     |            +----------+      +-----+-----+   +------+----------+
     |            | cancelled|            |                 |
     |            | (terminal|<-----------+                 |
     |            +----------+            |                 |
     |                                    v                 v
     |                              +----------+
     |                              | concluding|
     |                              +-----+----+
     |                                    |
     |                                    v
     |          +----------+        +----------+
     +--------->| failed   |        | completed|
                | (terminal|        | (terminal|
                +----------+        +----------+

* proposed -> announced is valid (v2: escrow announce_result
  may arrive before acceptance DM)
```

### Valid Transitions (from `state-machine.ts`)

```typescript
const VALID_PROGRESS_TRANSITIONS: Record<SwapProgress, readonly SwapProgress[]> = {
  proposed:         ['accepted', 'announced', 'cancelled', 'failed'],
  accepted:         ['announced', 'cancelled', 'failed'],
  announced:        ['depositing', 'cancelled', 'failed'],
  depositing:       ['awaiting_counter', 'concluding', 'completed', 'cancelled', 'failed'],
  awaiting_counter: ['concluding', 'completed', 'cancelled', 'failed'],
  concluding:       ['completed', 'cancelled', 'failed'],
  completed:        [],  // terminal
  cancelled:        [],  // terminal
  failed:           [],  // terminal
};
```

**Notable transitions:**
- `proposed -> announced`: Allows the v2 fast path where the escrow's `invoice_delivery` arrives before the peer's `swap_acceptance_v2` DM (out-of-order DM delivery).
- `depositing -> concluding` / `depositing -> completed`: Allows fast-forwarding when the wallet was offline and the escrow has already progressed.
- `depositing -> completed`: Allows skipping `concluding` when status_result reports `COMPLETED`.

### Terminal States

```typescript
const TERMINAL_PROGRESS: ReadonlySet<SwapProgress> = new Set([
  'completed',
  'cancelled',
  'failed',
]);
```

### Mapping to Escrow States (from `mapEscrowStateToProgress`)

The SwapModule's local states do not have a 1:1 correspondence with the escrow service's `SwapState` enum. The local state machine captures the **party's perspective**.

| Escrow SwapState | Client SwapProgress | Notes |
|-----------------|---------------------|-------|
| `ANNOUNCED` | `announced` | Escrow created record |
| `DEPOSIT_INVOICE_CREATED` | `announced` | Invoice ready |
| `PARTIAL_DEPOSIT` | `depositing` | One party paid |
| `DEPOSIT_COVERED` | `awaiting_counter` | Both deposits in |
| `CONCLUDING` | `concluding` | Escrow settling |
| `COMPLETED` | `completed` | Both verified |
| `TIMED_OUT` | `cancelled` | Escrow timeout |
| `CANCELLING` | `cancelled` | Escrow cancelling |
| `CANCELLED` | `cancelled` | Fully cancelled |
| `FAILED` | `failed` | Unrecoverable |

### Offline Tolerance

The wallet may be offline during parts of the swap lifecycle. On `load()`, the SwapModule resumes non-terminal swaps by running crash recovery actions (fire-and-forget, per-swap):

| State on Load | Recovery Action |
|---------------|-----------------|
| `proposed` (proposer) | Start proposal timer (accounts for elapsed time). |
| `proposed` (acceptor) | No action. Wait for user to accept/reject. |
| `accepted` (v2 proposer) | Send `status` query to escrow (Bob already announced). |
| `accepted` (v2 acceptor) | Re-send `announce_v2` with both signatures (idempotent). |
| `accepted` (v1) | Re-send `announce` to escrow (idempotent). |
| `announced` | Send `status` query. Request deposit invoice if missing. |
| `depositing` | Send `status` query. Request deposit invoice if missing. |
| `awaiting_counter` | Send `status` query. |
| `concluding` | Send `status` query. Request payout invoice if missing. |

Each recovery action resolves the escrow address first (if `escrowPubkey` is not stored). Escrow resolution happens outside the per-swap gate; only the subsequent state update is gated.

---

## 5. DM Protocol Extensions

### 5.1 P2P Message Types

These message types are exchanged **between the two swap parties** via CommunicationsModule (Nostr NIP-17 encrypted DMs). They are NOT sent to the escrow.

P2P messages use a string prefix (`swap_proposal:`, `swap_acceptance:`, `swap_rejection:`) followed by a JSON payload, enabling fast discrimination from other DM traffic.

#### `swap_proposal` (v2)

Sent by the proposer to the counterparty.

```json
{
  "type": "swap_proposal",
  "version": 2,
  "manifest": {
    "swap_id": "<64 hex chars>",
    "party_a_address": "DIRECT://...",
    "party_b_address": "DIRECT://...",
    "party_a_currency_to_change": "UCT",
    "party_a_value_to_change": "1000000",
    "party_b_currency_to_change": "USDU",
    "party_b_value_to_change": "500000000",
    "timeout": 3600,
    "salt": "<32 hex chars>",
    "escrow_address": "DIRECT://...",
    "protocol_version": 2
  },
  "escrow": "@escrow-service",
  "proposer_signature": "<130 hex chars>",
  "proposer_chain_pubkey": "<66 hex chars>",
  "auxiliary": {
    "party_a_binding": {
      "nametag": "alice",
      "direct_address": "DIRECT://...",
      "chain_pubkey": "<66 hex chars>",
      "signature": "<130 hex chars>"
    }
  },
  "message": "Optional free-text message"
}
```

**v2 additions over v1:**
- `version: 2` (v1 has `version: 1`)
- `proposer_signature`: Signature over `"swap_consent:{swap_id}:{escrow_address}"`.
- `proposer_chain_pubkey`: 33-byte compressed secp256k1 public key.
- `auxiliary`: Optional nametag binding proofs (see [Section 8.3](#83-nametag-binding-proofs)).
- Manifest includes `salt`, `escrow_address`, and `protocol_version` fields.

**Validation on receipt:**
1. Recompute `swap_id` from manifest fields and verify it matches (`verifyManifestIntegrity`).
2. Full manifest field validation (`validateManifest`).
3. Check pending swap limit.
4. Verify sender is not the same wallet (address check).
5. Resolve counterparty and verify `dm.senderPubkey` matches their transport pubkey.
6. (v2) Verify `proposer_signature` using `verifySwapSignature`.
7. (v2) Resolve proposer address and verify `proposer_chain_pubkey` matches.
8. (v2) Verify nametag bindings if present (`verifyNametagBinding`).

#### `swap_acceptance` (v2)

Sent by the acceptor to the proposer.

```json
{
  "type": "swap_acceptance",
  "version": 2,
  "swap_id": "<64 hex chars>",
  "acceptor_signature": "<130 hex chars>",
  "acceptor_chain_pubkey": "<66 hex chars>"
}
```

In v2, this is **informational** for the proposer -- Bob announces directly to the escrow. The signature is verified by the proposer for record-keeping but is not required for the swap to proceed.

#### `swap_rejection`

```json
{
  "type": "swap_rejection",
  "version": 1,
  "swap_id": "<64 hex chars>",
  "reason": "Optional human-readable reason"
}
```

### 5.2 Escrow DM Types

The SwapModule reuses the escrow service's DM protocol. It sends:

| Direction | Type | Version | Purpose |
|-----------|------|---------|---------|
| Party -> Escrow | `announce` | v1 | Submit manifest (unsigned) |
| Party -> Escrow | `announce` | v2 | Submit manifest + both signatures + chain pubkeys |
| Party -> Escrow | `status` | - | Query swap status |
| Party -> Escrow | `request_invoice` | - | Re-request deposit or payout invoice token |
| Party -> Escrow | `cancel` | - | Request swap cancellation |

And receives:

| Direction | Type | Purpose |
|-----------|------|---------|
| Escrow -> Party | `announce_result` | Announcement confirmation + deposit_invoice_id |
| Escrow -> Party | `invoice_delivery` | Deposit or payout invoice token |
| Escrow -> Party | `status_result` | Current swap status |
| Escrow -> Party | `payment_confirmation` | Payout completed notification |
| Escrow -> Party | `swap_cancelled` | Swap cancelled (timeout or manual) |
| Escrow -> Party | `bounce_notification` | Deposit bounced back (wrong currency) |
| Escrow -> Party | `error` | Error response |

#### v2 Announce DM Structure

```json
{
  "type": "announce",
  "version": 2,
  "manifest": { ... },
  "signatures": {
    "party_a": "<130 hex chars>",
    "party_b": "<130 hex chars>"
  },
  "chain_pubkeys": {
    "party_a": "<66 hex chars>",
    "party_b": "<66 hex chars>"
  },
  "auxiliary": { ... }
}
```

### 5.3 DM Handler Registration

The SwapModule registers a single DM handler via `CommunicationsModule.onDirectMessage()`:

```typescript
// In SwapModule.load()
this.dmUnsubscribe = deps.communications.onDirectMessage((dm) => {
  this.handleIncomingDM(dm);
});
```

The handler uses `isSwapDM()` for fast prefix/type detection, then `parseSwapDM()` for full parsing. All errors are caught and logged -- never propagated from the DM handler.

**Message routing by sender:**
- DMs matching P2P prefixes (`swap_proposal:`, `swap_acceptance:`, `swap_rejection:`): routed by `swap_id` lookup against `this.swaps`.
- DMs matching escrow JSON types: verified against `swap.escrowPubkey` before processing.
- Unrecognized content: silently ignored.

### 5.4 DM Content Size Limit

All DM parsing enforces `MAX_DM_LENGTH = 131,072` UTF-16 code units. Messages exceeding this limit are silently dropped.

---

## 6. SDK Module Integration

### 6.1 Dependencies

```typescript
interface SwapModuleDependencies {
  readonly accounting: {
    importInvoice(token: unknown): Promise<unknown>;
    getInvoice(invoiceId: string): unknown | null;
    getInvoiceStatus(invoiceId: string): unknown;
    payInvoice(invoiceId: string, params: unknown): Promise<TransferResult>;
    on<T extends SphereEventType>(type: T, handler: (data: SphereEventMap[T]) => void): () => void;
  };
  readonly payments: {
    validate(): Promise<{ valid: Token[]; invalid: Token[] }>;
  };
  readonly communications: {
    sendDM(recipientPubkey: string, content: string): Promise<{ eventId: string }>;
    onDirectMessage(handler: (message: { ... }) => void): () => void;
  };
  readonly storage: StorageProvider;
  readonly identity: FullIdentity;
  readonly emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  readonly resolve: (identifier: string) => Promise<PeerInfo | null>;
  readonly getActiveAddresses: () => TrackedAddress[];
}
```

Dependencies use narrow interface subsets (not full module types) for testability and decoupling.

### 6.2 Configuration

```typescript
interface SwapModuleConfig {
  debug?: boolean;
  defaultEscrowAddress?: string;
  proposalTimeoutMs?: number;     // Default: 300000 (5 min)
  maxPendingSwaps?: number;       // Default: 100
  announceTimeoutMs?: number;     // Default: 30000 (30s)
  terminalPurgeTtlMs?: number;    // Default: 604800000 (7 days)
}
```

### 6.3 Module Lifecycle

The SwapModule follows the same lifecycle pattern as the AccountingModule:

```typescript
class SwapModule {
  constructor(config?: SwapModuleConfig);     // stores config only
  initialize(deps: SwapModuleDependencies): void;  // inject deps, reset destroyed flag
  async load(): Promise<void>;                      // load state, subscribe, resume
  async destroy(): Promise<void>;                   // unsubscribe, drain gates, persist
}
```

**`load()` steps:**
1. Clear in-memory state (swaps, terminalSwapIds, invoiceToSwapIndex).
2. Load persisted swap records from storage (`loadFromStorage`).
3. Purge terminal swaps older than `terminalPurgeTtlMs`.
4. Clean up stale proposals (proposer-side timeout check).
5. Register DM handler.
6. Subscribe to invoice events (`setupInvoiceEventSubscriptions`).
7. Rebuild `invoiceToSwapIndex` (depositInvoiceId/payoutInvoiceId -> swapId).
8. Resume local timers.
9. Crash recovery actions (fire-and-forget per swap).

**`load()` re-entry guard:** If `load()` is called while a previous `load()` is in progress, subsequent callers await the same promise or a deferred signal. A 10-second timeout prevents indefinite blocking.

**`destroy()` steps:**
1. Set `destroyed = true` (prevents new gate entries).
2. Unsubscribe DM handler.
3. Unsubscribe invoice events.
4. Clear all local timers.
5. Drain all in-flight gated operations (`_gateMap.drainAll()`).
6. Final-flush: persist index.

### 6.4 AsyncGateMap Constraint and Auto-Verification

The per-swap mutex uses `AsyncGateMap` from `core/async-gate.ts`. This is a promise-chain pattern: each new operation for a key appends to that key's chain (FIFO).

**Critical constraint: nested `withGate(key)` for the SAME key deadlocks.** The second call waits for the first to complete, but the first is waiting for the second (since it is a FIFO chain, not a reentrant lock).

This affects payout verification: when a `payout` `invoice_delivery` DM arrives, the DM handler runs inside `withSwapGate(swapId)`. If `verifyPayout()` were called inside the same gate, it would deadlock because `verifyPayout()` also calls `withSwapGate(swapId)`.

**Solution:** The DM handler uses a `shouldAutoVerify` flag pattern:

```typescript
// Inside the payout invoice_delivery handler:
let shouldAutoVerify = false;
await this.withSwapGate(swapId, async () => {
  // ... import invoice, persist, emit event ...
  shouldAutoVerify = true;
});

// Auto-verify runs OUTSIDE the gate
if (shouldAutoVerify) {
  this.verifyPayout(swapId).catch((err) => { ... });
}
```

This ensures the outer gate has fully released before `verifyPayout()` acquires its own gate.

### 6.5 Storage

Swap records are persisted via `StorageProvider` using per-address scoped keys:

**Two storage keys per swap:**

| Key Pattern | Content |
|-------------|---------|
| `swap_record:{swapId}` | Full `SwapStorageData` JSON (`{ version: 1, swap: SwapRef }`) |
| `swap_index` | Lightweight `SwapIndexEntry[]` for listing and TTL-based purging |

```typescript
interface SwapStorageData {
  readonly version: 1;
  readonly swap: SwapRef;
}

interface SwapIndexEntry {
  readonly swapId: string;
  readonly progress: SwapProgress;
  readonly role: SwapRole;
  readonly createdAt: number;
}
```

**Write order:** `persistSwap` writes the per-swap record first, then updates the index. If the index write fails (partial write), the inconsistency is healed on the next `persistSwap` call.

**Terminal swap handling:** Terminal swaps are removed from `this.swaps` (in-memory) but their index entries are preserved in `_storedTerminalEntries` for dedup and TTL purging. The `persistIndex()` method merges both active and stored terminal entries.

### 6.6 Event Emission

Events are emitted through the Sphere event emitter. The full set of swap events:

| Event | Payload | When |
|-------|---------|------|
| `swap:proposal_received` | `{ swapId, deal, senderPubkey, senderNametag? }` | Proposal DM received |
| `swap:proposed` | `{ swapId, deal, recipientPubkey }` | Proposal DM sent |
| `swap:accepted` | `{ swapId, role }` | Acceptance processed |
| `swap:rejected` | `{ swapId, reason? }` | Rejection processed |
| `swap:announced` | `{ swapId, depositInvoiceId }` | Escrow acknowledged, deposit invoice imported |
| `swap:deposit_sent` | `{ swapId, transferResult }` | Own deposit transfer sent |
| `swap:deposit_confirmed` | `{ swapId, party, amount, coinId }` | A deposit confirmed (ours or counterparty's) |
| `swap:deposits_covered` | `{ swapId }` | Both deposits fully covered |
| `swap:concluding` | `{ swapId }` | Escrow executing payouts |
| `swap:payout_received` | `{ swapId, payoutInvoiceId }` | Payout invoice received |
| `swap:completed` | `{ swapId, payoutVerified }` | Swap complete |
| `swap:cancelled` | `{ swapId, reason, depositsReturned? }` | Swap cancelled |
| `swap:failed` | `{ swapId, error }` | Unrecoverable error |
| `swap:deposit_returned` | `{ swapId, transfer, returnReason }` | Deposit returned after cancellation |
| `swap:bounce_received` | `{ swapId, reason, returnedAmount, returnedCurrency }` | Wrong-currency deposit bounced |

---

## 7. API Surface

### 7.1 Public Methods

```typescript
class SwapModule {
  /** Propose a swap to a counterparty (always v2). */
  async proposeSwap(deal: SwapDeal, options?: ProposeSwapOptions): Promise<SwapProposalResult>;

  /** Accept an incoming swap proposal. v2: announces directly to escrow. */
  async acceptSwap(swapId: string): Promise<void>;

  /** Reject a swap proposal. Also works on post-announcement states (sends cancel to escrow). */
  async rejectSwap(swapId: string, reason?: string): Promise<void>;

  /** Deposit into the swap's escrow invoice. Delegates to accounting.payInvoice(). */
  async deposit(swapId: string): Promise<TransferResult>;

  /** Verify that the payout invoice matches expected terms and L3 proofs are valid. */
  async verifyPayout(swapId: string): Promise<boolean>;

  /** Get swap status. Optionally sends a status query to the escrow. */
  async getSwapStatus(swapId: string, options?: GetSwapStatusOptions): Promise<SwapRef>;

  /** List swaps with optional filtering (progress, role, excludeTerminal). */
  getSwaps(filter?: GetSwapsFilter): SwapRef[];

  /** Cancel an active swap. Sends cancel DM to escrow if post-announcement. */
  async cancelSwap(swapId: string): Promise<void>;

  /** Resolve a swap ID from a full 64-char hex string or a unique prefix (min 4 chars). */
  resolveSwapId(idOrPrefix: string): string;
}
```

### 7.2 Types

```typescript
interface SwapDeal {
  readonly partyA: string;              // @nametag, DIRECT://, or chain pubkey
  readonly partyB: string;              // @nametag, DIRECT://, or chain pubkey
  readonly partyACurrency: string;      // coinId (1-20 alphanumeric chars)
  readonly partyAAmount: string;        // positive integer string
  readonly partyBCurrency: string;      // coinId (must differ from partyACurrency)
  readonly partyBAmount: string;        // positive integer string
  readonly timeout: number;             // seconds, [60, 86400]
  readonly escrowAddress?: string;      // defaults to SwapModuleConfig.defaultEscrowAddress
}

interface SwapManifest {
  readonly swap_id: string;                        // SHA-256(JCS(fields))
  readonly party_a_address: string;                // resolved DIRECT://
  readonly party_b_address: string;                // resolved DIRECT://
  readonly party_a_currency_to_change: string;
  readonly party_a_value_to_change: string;
  readonly party_b_currency_to_change: string;
  readonly party_b_value_to_change: string;
  readonly timeout: number;
  readonly salt: string;                           // 32 hex chars (v2)
  readonly escrow_address?: string;                // DIRECT:// (v2)
  readonly protocol_version?: number;              // 2 for v2
}

interface SwapRef {
  readonly swapId: string;
  readonly deal: SwapDeal;
  readonly manifest: SwapManifest;
  readonly role: SwapRole;                         // 'proposer' | 'acceptor'
  progress: SwapProgress;
  depositInvoiceId?: string;
  payoutInvoiceId?: string;
  escrowState?: string;
  counterpartyPubkey?: string;
  counterpartyNametag?: string;
  localDepositTransferId?: string;
  escrowPubkey?: string;
  escrowDirectAddress?: string;
  payoutVerified: boolean;
  readonly createdAt: number;
  announcedAt?: number;                            // timeout base
  updatedAt: number;
  error?: string;
  readonly proposerChainPubkey?: string;           // v2
  readonly proposerSignature?: string;             // v2
  readonly acceptorSignature?: string;             // v2
  readonly auxiliary?: ManifestAuxiliary;           // v2
  readonly protocolVersion?: number;               // 2 for v2
}
```

### 7.3 Error Codes

| Error Code | Description |
|------------|-------------|
| `SWAP_INVALID_DEAL` | Invalid deal parameters (bad address, zero amount, same currency, etc.) |
| `SWAP_NOT_FOUND` | No swap record with the given swap_id |
| `SWAP_WRONG_STATE` | Operation not valid in the swap's current state |
| `SWAP_LIMIT_EXCEEDED` | Maximum pending swaps reached |
| `SWAP_RESOLVE_FAILED` | Cannot resolve party or escrow address |
| `SWAP_DEPOSIT_FAILED` | Deposit payment failed (payInvoice error) |
| `SWAP_PAYOUT_VERIFICATION_FAILED` | Payout does not match expected terms |
| `SWAP_ALREADY_COMPLETED` | Swap is already in completed state |
| `SWAP_ALREADY_CANCELLED` | Swap is already in cancelled/failed state |
| `SWAP_DM_SEND_FAILED` | DM send failed |
| `SWAP_NOT_INITIALIZED` | Module not initialized or not loaded |
| `SWAP_MODULE_DESTROYED` | Module has been destroyed |

---

## 8. Swap ID Derivation

The swap ID is a **content-addressed identifier** computed as the SHA-256 hash of the canonical JSON representation (RFC 8785 / JCS) of the manifest fields, excluding the `swap_id` field itself.

### Derivation Algorithm

```typescript
import canonicalize from 'canonicalize';
import { sha256 } from '../../core/crypto.js';

function computeSwapId(fields: ManifestFields): string {
  const canonical = canonicalize(fields);
  if (!canonical) throw new Error('Failed to canonicalize manifest fields');
  return sha256(canonical, 'utf8');
}
```

### 8.1 Fields Included in Hash

The hash input contains these fields (JCS orders them lexicographically by key):

| Field | Type | Required | Example |
|-------|------|----------|---------|
| `party_a_address` | string | Always | `"DIRECT://02abc..."` |
| `party_a_currency_to_change` | string | Always | `"UCT"` |
| `party_a_value_to_change` | string | Always | `"1000000"` |
| `party_b_address` | string | Always | `"DIRECT://03def..."` |
| `party_b_currency_to_change` | string | Always | `"USDU"` |
| `party_b_value_to_change` | string | Always | `"500000000"` |
| `timeout` | number | Always | `3600` |
| `salt` | string | Always | `"a1b2c3d4e5f67890..."` (32 hex chars) |
| `escrow_address` | string | v2 only | `"DIRECT://02esc..."` |
| `protocol_version` | number | v2 only | `2` |

### 8.2 Salt Field

The `salt` is a 32-character lowercase hex string generated by `randomHex(16)` (16 random bytes). Its purpose: **ensures a unique `swap_id` per proposal even when the same deal terms are re-proposed.** Without salt, identical deal parameters would always produce the same `swap_id`, making it impossible to re-propose a previously rejected or cancelled swap.

The salt is part of the JCS hash and is validated by `validateManifest()` with `/^[0-9a-f]{32}$/`.

### 8.3 Nametag Binding Proofs

When a party uses an `@nametag` address in the deal, the proposer creates a nametag binding proof. The proof signature covers `"nametag_bind:{nametag}:{directAddress}:{swapId}"`.

```typescript
interface NametagBindingProof {
  readonly nametag: string;           // without @
  readonly direct_address: string;    // resolved DIRECT://
  readonly chain_pubkey: string;      // 33-byte compressed
  readonly signature: string;         // 130-char hex
}
```

Binding proofs are carried in the `auxiliary` field of the manifest (not part of the `swap_id` hash). They prove that the nametag owner authorized the DIRECT address for this specific swap.

### 8.4 Key Properties

1. **Deterministic:** Both parties and the escrow compute the same `swap_id` from the same manifest fields.
2. **Tamper-evident:** Any modification to the manifest fields produces a different `swap_id`.
3. **Collision-resistant:** SHA-256 provides 128-bit collision resistance.
4. **Escrow-compatible:** The SDK's derivation is identical to the escrow service's (`canonicalize` + SHA-256).
5. **Replay-resistant:** The `salt` field ensures unique IDs even for identical deals.

### 8.5 v2 vs v1 Hash Differences

In v2, the `escrow_address` is **included** in the hash (unlike v1 where it was excluded). This means:
- The same deal terms with different escrow addresses produce different `swap_id` values.
- The escrow address is cryptographically committed to in the swap identity.
- Both parties' consent signatures cover the `swap_id` which includes the escrow address.

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
- The escrow address is cryptographically committed in the `swap_id` (v2).
- Both parties sign consent messages covering the escrow address (v2).

### 9.2 Protocol v2 Security Properties

**Consent signatures:** Both parties sign `"swap_consent:{swapId}:{escrowAddress}"` with their chain private keys. The escrow verifies both signatures before creating the swap. This prevents:
- An attacker from creating swaps on behalf of a party without their consent.
- An acceptor from substituting a different escrow address after the proposer committed.

**Downgrade attack prevention:** When a v2 swap receives a v1-format acceptance message, the acceptance handler returns silently WITHOUT clearing the proposal timer. This prevents an attacker from:
1. Intercepting a v2 proposal.
2. Sending a v1 acceptance (which has no signature).
3. Stranding the swap by disarming the timeout without providing valid consent.

The check ordering is critical: version check happens BEFORE timer clear. Invalid signatures also do NOT clear the timer.

### 9.3 TOCTOU Guards (withSwapGate)

Every mutating public method uses a two-layer state check pattern:

1. **Fast-path check before gate:** Catches most invalid calls without gate overhead.
2. **Re-check inside gate:** Catches races where a concurrent operation (DM handler, timeout timer) advanced the swap between the fast-path check and gate acquisition.

Methods with TOCTOU guards:
- `acceptSwap`: Re-checks `swap.progress !== 'proposed'` inside gate.
- `rejectSwap`: Re-checks `swap.progress` for all terminal/concluding states inside gate.
- `cancelSwap`: Re-checks `swap.progress` for all terminal/concluding states inside gate.
- `deposit`: Re-checks `swap.progress === 'announced'` inside gate.

### 9.4 Timer-Clear Ordering

The acceptance handler follows a strict ordering to prevent swap stranding:

```
1. Check version (v2 swap requires v2 acceptance) -- reject WITHOUT clearing timer
2. Verify signature -- reject WITHOUT clearing timer
3. [All checks pass] -- NOW clear proposal timer
4. Transition state
5. If transition throws: rollback + re-arm timer + re-persist
```

This ordering ensures that a malformed or invalid acceptance message can never disarm the proposal timeout.

### 9.5 Partial-Write Recovery

`persistSwap` writes the per-swap record first, then the index. If the index write fails:
- The per-swap record is written but the index may be stale.
- On the next `persistSwap` call, the index is rebuilt from `this.swaps` + `_storedTerminalEntries`, healing the inconsistency.

If `transitionProgress` fails during the acceptance handler:
- `swap.progress` is rolled back in memory to the previous value.
- `swap.updatedAt` is restored.
- The proposal timer is re-armed.
- A fire-and-forget re-persist attempt heals any partial storage write.

### 9.6 Invoice Verification

When receiving an `invoice_delivery` DM from the escrow:

**Deposit invoice verification:**
1. Single target (1 target, not 0 or 2+).
2. Target address matches the resolved escrow DIRECT address.
3. Exactly 2 assets with correct currencies and amounts matching the manifest.

**Payout invoice verification (in `verifyPayout`):**
1. `terms.creator` is defined (escrow invoices are non-anonymous).
2. `terms.targets[0].address` matches the party's own DIRECT address.
3. `terms.targets[0].assets[0].coin[0]` matches the expected counter-currency.
4. `terms.targets[0].assets[0].coin[1]` matches the expected counter-amount.
5. Invoice state is `COVERED` or `CLOSED`.
6. `netCoveredAmount >= expectedAmount`.
7. `terms.creator` matches the escrow's chain pubkey.
8. L3 token validation passes (`payments.validate()`).

### 9.7 Escrow DM Sender Verification

Every escrow message handler calls `isFromExpectedEscrow(senderPubkey, swap)` before processing. This compares `dm.senderPubkey` (the transport pubkey from the DM) against `swap.escrowPubkey` (stored during escrow resolution). If the escrow pubkey is not yet stored (not resolved), the message is rejected.

### 9.8 Replay Protection

- **Duplicate proposal DMs:** Checked against both `this.swaps` (active) and `this.terminalSwapIds` (previously terminal). Duplicate swap_ids are silently dropped.
- **Stale DMs from previous proposal instance:** Acceptance and rejection handlers check `dm.timestamp < swap.createdAt` and drop stale messages. This handles the case where a swap_id is re-proposed (after terminal purge) and old DMs are replayed from the Nostr relay.
- **Re-proposal after terminal:** `proposeSwap()` removes the swap_id from `terminalSwapIds` before creating a new record, allowing re-proposals.

### 9.9 Subscription Lifecycle

- DM handler (`dmUnsubscribe`) is registered in `load()` and unsubscribed in `destroy()`.
- Invoice event handlers (`invoiceEventUnsubs`) are registered in `load()` and unsubscribed in `destroy()`.
- The `destroyed` flag is set FIRST in `destroy()`, before any unsubscription, to prevent new gate entries from concurrent DM handlers.

---

## 10. Error Handling and Recovery

### 10.1 Crash Recovery

All swap state is persisted to `StorageProvider` after each transition. On `load()`, recovery actions are dispatched per-swap as fire-and-forget async operations. Each recovery action:

1. Resolves the escrow address if not stored (network call, outside gate).
2. Persists the resolved address inside the per-swap gate.
3. Sends recovery DMs based on the swap's progress state (see [Section 4, Offline Tolerance](#offline-tolerance)).

Recovery failures are logged but never propagated. The swap will eventually be resolved by the escrow timeout or the next CLI sync.

### 10.2 Timeout Handling

The SwapModule maintains two types of local timers:

**Proposal timer** (`startProposalTimer`):
- For outgoing proposals in `proposed` state.
- Duration: `proposalTimeoutMs` (default 5 min), adjusted for elapsed time since `createdAt`.
- On fire: transitions to `failed` with "Proposal timed out".

**Local swap timer** (`startLocalTimer`):
- For swaps in `announced`, `depositing`, or `awaiting_counter` states.
- Duration: `deal.timeout * 1000 + 30000` (escrow timeout + 30s grace period), measured from `announcedAt`.
- On fire: transitions to `cancelled` with "Local timeout".

Both timers run inside `withSwapGate` for state mutation safety. If the computed remaining time is <= 0, the transition fires immediately (fire-and-forget).

The local swap timer is **advisory only** -- the escrow's timeout is authoritative. The local timer ensures the UI is updated even if the escrow's `swap_cancelled` DM is delayed or lost.

### 10.3 Network Failure and Retry

DM sends use exponential backoff with jitter (`withRetry` in `escrow-client.ts`):

```
Base delay: 2000ms
Max delay:  16000ms (cap)
Jitter:     +/-25% of computed delay
```

| Operation | Max Retries |
|-----------|------------|
| `announce` / `announce_v2` | 5 |
| `status` query | 3 |
| `request_invoice` | 3 |

Retries do NOT apply to:
- `deposit()` -- payment failures are reported immediately to the caller.
- `acceptSwap()` / `rejectSwap()` acceptance DM -- best-effort, not retried.

### 10.4 Error Codes

See [Section 7.3](#73-error-codes) for the complete error code table.

---

## 11. Future Direction: Predicate-Based Direct Swaps

### The Abstraction Layer

The SwapModule's public API (`proposeSwap`, `acceptSwap`, `deposit`, `verifyPayout`, etc.) is designed to be **mechanism-agnostic**. The current implementation delegates to an escrow service, but the internal execution can be replaced without changing the caller-facing interface.

### Current: Escrow-Backed (Three Invoices)

```
Party A --deposits--> Escrow --pays--> Party B
Party B --deposits--> Escrow --pays--> Party A
```

Three invoices: one deposit, two payouts. Trusted intermediary holds custody.

### Future: Predicate-Based Direct Swaps

Unicity L3 supports programmable predicates on token ownership. An HTLC-like predicate can enforce atomic swaps without a trusted intermediary:

```
Party A: lock(tokenA, hash(secret), timeout) -> Party B can claim with secret
Party B: lock(tokenB, hash(secret), timeout) -> Party A can claim with secret
Party A: reveal secret -> claims tokenB
Party B: uses revealed secret -> claims tokenA
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

The SwapModule can use an internal strategy interface for mechanism-specific operations:

```typescript
interface SwapExecutionStrategy {
  announce(swap: SwapRef): Promise<void>;
  deposit(swap: SwapRef): Promise<TransferResult>;
  verifyPayout(swap: SwapRef): Promise<boolean>;
  cancel(swap: SwapRef): Promise<void>;
}
```

This separation is why the SwapModule exists as a distinct abstraction layer rather than being collapsed into application code. The P2P proposal protocol and local state machine remain unchanged across mechanisms -- only the execution strategy differs.

---

## 12. Module File Structure

### External Dependencies

| Dependency | Purpose | Already in SDK? |
|------------|---------|-----------------|
| `canonicalize` | RFC 8785 JCS serialization | Yes (added) |
| `@noble/hashes` | SHA-256 for swap_id derivation (via `core/crypto.ts`) | Yes |
| `AccountingModule` | Invoice operations | Yes |
| `CommunicationsModule` | DM send/receive | Yes |
| `StorageProvider` | Persistent swap records | Yes |
| `AsyncGateMap` | Per-swap mutex | Yes (`core/async-gate.ts`) |

### Dependency Graph

```
index.ts -----> SwapModule.ts -----> state-machine.ts
                     |                manifest.ts
                     |                dm-protocol.ts
                     |                escrow-client.ts
                     |
                     v
              types.ts (imported by all files)
              core/async-gate.ts (AsyncGateMap)
              core/crypto.ts (sha256, signMessage, verifySignedMessage)
              core/errors.ts (SphereError)
```

---

## 13. CLI Commands

The SDK CLI exposes swap operations through five primary commands and two convenience commands, following the same `{module}-{action}` naming convention as invoice commands (`invoice-create`, `invoice-list`, `invoice-pay`, etc.).

### Primary Commands

**`swap-propose`** -- Propose a swap deal to a counterparty

```
npm run cli -- swap-propose --to <recipient> \
  --offer "<amount> <symbol>" \
  --want "<amount> <symbol>" \
  [--escrow <address>] [--timeout <seconds>] [--message <text>]
```

| Flag | Description |
|------|-------------|
| `--to` | Counterparty's @nametag, DIRECT:// address, or chain pubkey |
| `--offer "<amount> <symbol>"` | What the proposer sends (e.g., `"1000000 UCT"`) |
| `--want "<amount> <symbol>"` | What the proposer expects to receive (e.g., `"500000 USDU"`) |
| `--escrow` | Escrow @nametag or DIRECT:// address (uses configured default if omitted) |
| `--timeout` | Swap timeout in seconds (default: 3600, range: 60-86400) |
| `--message` | Optional human-readable description sent to counterparty |

Maps to: `sphere.swap.proposeSwap(deal)` -> sends `swap_proposal` DM to counterparty

Output: swap_id, manifest summary, status

---

**`swap-list`** -- List swap deals

```
npm run cli -- swap-list [--all] [--role <proposer|acceptor>] [--progress <state>]
```

| Flag | Description |
|------|-------------|
| (default) | Shows only open deals -- hides completed/cancelled/failed |
| `--all` | Show all deals including terminal states |
| `--role` | Filter by role (`proposer` or `acceptor`) |
| `--progress` | Filter by specific progress state |

Maps to: `sphere.swap.getSwaps(filter)` (local, synchronous)

Output: table with columns -- swap_id (truncated), role, progress, counterparty, offer, want, created_at

---

**`swap-accept`** -- Accept a proposed swap deal and execute it

```
npm run cli -- swap-accept <swap_id> [--deposit] [--no-wait]
```

| Argument / Flag | Description |
|-----------------|-------------|
| `<swap_id>` | The 64-hex swap ID or unique prefix (min 4 chars) |
| `--deposit` | Also execute the deposit immediately after acceptance |
| `--no-wait` | Returns immediately after deposit is sent |

Without `--deposit`: only sends acceptance and announces to escrow. The user must then manually deposit via `swap-deposit`.

Maps to: `sphere.swap.acceptSwap(swapId)` + optionally `sphere.swap.deposit(swapId)`

---

### Convenience Commands

**`swap-reject`** -- Reject a swap proposal

```
npm run cli -- swap-reject <swap_id> [reason]
```

Maps to: `sphere.swap.rejectSwap(swapId, reason)`

---

**`swap-cancel`** -- Cancel a swap

```
npm run cli -- swap-cancel <swap_id>
```

Maps to: `sphere.swap.cancelSwap(swapId)`

---

**`swap-status`** -- Show detailed status for a specific swap

```
npm run cli -- swap-status <swap_id> [--query-escrow]
```

Maps to: `sphere.swap.getSwapStatus(swapId, { queryEscrow: true })`

---

**`swap-deposit`** -- Manually deposit into an announced swap

```
npm run cli -- swap-deposit <swap_id>
```

Maps to: `sphere.swap.deposit(swapId)`

---

## Appendix A: Complete Data Flow Diagram (v2 Protocol)

```
                          PROPOSAL PHASE (P2P)
                    ===================================

    Alice (Proposer)                              Bob (Acceptor)
    ----------------                              ----------------
    proposeSwap(deal)
      |
      +-- resolve parties + escrow
      +-- buildManifest(partiesA, partyB, deal, timeout, escrowAddress)
      |   (includes salt + escrow_address + protocol_version=2)
      +-- computeSwapId(fields)
      +-- signSwapManifest(privateKey, swapId, escrowAddress)
      +-- createNametagBinding(...) (if @nametag)
      +-- persist(proposed, role=proposer)
      +-- sendDM(swap_proposal_v2) ----------------->  onDM(swap_proposal)
      +-- startProposalTimer()                            |
      |                                                   +-- verifyManifestIntegrity()
      |                                                   +-- validateManifest()
      |                                                   +-- verifySwapSignature()
      |                                                   +-- verifyNametagBinding()
      |                                                   +-- persist(proposed, role=acceptor)
      |                                                   +-- emit(swap:proposal_received)
      |                                                   |
      |                                                   |  [user calls acceptSwap()]
      |                                                   |
      |  onDM(swap_acceptance_v2)  <-------------------   acceptSwap(swapId)
      |    |                                                |
      |    +-- [inside withSwapGate]                        +-- signSwapManifest()
      |    |   check version==2 (downgrade guard)           +-- createNametagBinding()
      |    |   verifySwapSignature(acceptor)                +-- transition(accepted)
      |    |   clearProposalTimer()                         +-- sendDM(swap_acceptance_v2) (info)
      |    |   transition(accepted)                         +-- emit(swap:accepted)
      |    |   persist acceptorSignature                    |
      |    +-- emit(swap:accepted)                          |
      |    +-- (v2: do NOT announce -- wait for             |
      |    |    announce_result from escrow)                 |


                        ANNOUNCEMENT PHASE (v2: Bob announces)
                    ===========================================

    Alice                     Escrow                    Bob
    -----                     ------                    ---
                                                        sendAnnounce_v2(manifest,
                                                          signatures, chainPubkeys,
                                                          auxiliary)
                              |<-- announce_v2 ---------|
                              |                         |
                              +-- verify sig_a + sig_b  |
                              +-- createInvoice()       |
                              |                         |
    onDM(announce_result) <---|-------> onDM(announce_result)
    onDM(invoice_delivery)<---|-------> onDM(invoice_delivery)
      |                                           |
      +-- importInvoice()                         +-- importInvoice()
      +-- verify deposit invoice terms            +-- verify deposit invoice terms
      +-- transition(announced)                   +-- transition(announced)
      +-- startLocalTimer()                       +-- startLocalTimer()
      |                                           |


                        DEPOSIT + SETTLEMENT PHASE
                    ==================================

    Alice                     Escrow                    Bob
    -----                     ------                    ---
    deposit(swapId)                                     deposit(swapId)
      |                                                     |
      +-- payInvoice()                                      +-- payInvoice()
      |   (assetIndex per party)                            |   (assetIndex per party)
      |                                                     |
      |== L3 transfer ========> |                           |
      |                         | <======================== |  L3 transfer
      |                         |
      |                         +-- invoice:covered
      |                         +-- closeInvoice()
      |                         +-- createPayout A + B
      |                         +-- payInvoice() x2
      |                         |
    onDM(invoice_delivery) <----|----> onDM(invoice_delivery)
    onDM(payment_confirm)  <----|----> onDM(payment_confirm)
      |                                           |
      +-- importInvoice(payout)                   +-- importInvoice(payout)
      +-- emit(swap:payout_received)              +-- emit(swap:payout_received)
      +-- verifyPayout() [outside gate]           +-- verifyPayout() [outside gate]
      +-- transition(completed)                   +-- transition(completed)
      +-- emit(swap:completed)                    +-- emit(swap:completed)
```

---

## Appendix B: Escrow DM Response Correlation

The Nostr DM protocol is asynchronous and unordered. The SwapModule correlates escrow responses to outstanding swaps using `swap_id`:

1. **Type-based routing:** Each escrow response contains a `swap_id` field for lookup against `this.swaps`.
2. **Sender verification:** Every escrow message is authenticated via `isFromExpectedEscrow(senderPubkey, swap)`.
3. **State-aware processing:** Each handler checks the swap's current progress before acting.
4. **Unsolicited messages:** Some escrow messages arrive without prior request (e.g., `swap_cancelled` due to timeout, `bounce_notification`). These are routed directly by `swap_id` lookup.
5. **Out-of-order tolerance:** The state machine allows transitions like `proposed -> announced` to handle DM reordering (v2: `announce_result` may arrive before `swap_acceptance_v2`).

---

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **SwapDeal** | User-facing input type for proposing a swap (human-friendly addresses) |
| **SwapManifest** | Canonical agreement structure with content-addressed `swap_id` |
| **SwapProgress** | Local state type (party's perspective of swap lifecycle) |
| **SwapState** | Escrow's state enum (escrow's perspective), defined in escrow-service |
| **swap_id** | SHA-256 of JCS-serialized manifest fields (excluding swap_id itself) |
| **salt** | 32-hex random value ensuring unique swap_id per proposal |
| **Party A** | The party listed first in the manifest (may or may not be the proposer) |
| **Party B** | The party listed second in the manifest |
| **Proposer** | The party who initiated the swap proposal (Alice) |
| **Acceptor** | The party who received and accepted the proposal (Bob) |
| **Deposit invoice** | Single-target, two-asset invoice created by escrow to collect both deposits |
| **Payout invoice** | Single-target, single-asset invoice created by escrow for each party's payout |
| **JCS** | JSON Canonicalization Scheme (RFC 8785) -- deterministic JSON serialization |
| **HTLC** | Hash Time-Locked Contract -- predicate pattern for trustless atomic swaps |
| **withSwapGate** | Per-swap async mutex preventing concurrent mutations (via AsyncGateMap) |
| **AsyncGateMap** | Promise-chain per-key mutex in `core/async-gate.ts`; nested same-key calls deadlock |
| **consent signature** | v2 signature over `"swap_consent:{swapId}:{escrowAddress}"` by a party's chain key |
| **nametag binding** | v2 signature proving nametag owner authorized a DIRECT address for this swap |
| **downgrade attack** | Sending a v1 acceptance to a v2 swap to bypass signature verification |
