# SwapModule Test Suite

> **Status:** Implemented -- 243 tests across 17 test files (all passing)
> **Framework:** Vitest
> **Test Files:** `tests/unit/modules/SwapModule.*.test.ts`, `tests/unit/modules/swap-test-helpers.ts`, `tests/integration/swap-lifecycle.test.ts`
> **Scope:** Unit tests covering all 8 public API methods, DM protocol processing, invoice event subscriptions, state machine transitions, manifest construction, concurrency, storage, validation, error codes, and CLI commands. Integration tests covering full swap lifecycle workflows with mock escrow.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Test Infrastructure](#2-test-infrastructure)
3. [Unit Tests](#3-unit-tests)
4. [Integration Tests](#4-integration-tests)
5. [E2E Tests](#5-e2e-tests)
6. [Cross-Cutting Concerns](#6-cross-cutting-concerns)
7. [Protocol v2 Test Coverage](#7-protocol-v2-test-coverage)
8. [Appendix A: Test Matrix](#appendix-a-test-matrix)
9. [Appendix B: Error Code Coverage](#appendix-b-error-code-coverage)
10. [Appendix C: DM Protocol Messages](#appendix-c-dm-protocol-messages)

---

## 1. Overview

### Purpose

Validate SwapModule -- the client-side counterpart to the escrow service -- through three test categories:

1. **Unit Tests** -- Individual methods, state transitions, DM processing, validation, error paths (237 tests, 16 files)
2. **Integration Tests** -- Full swap workflows with mock escrow DM responses via `MockDMRelay` + `EscrowSimulator` (6 tests, 1 file)
3. **E2E Tests** -- Two real Sphere wallets + escrow service on testnet (future, not yet implemented)

### Architecture Context

SwapModule runs inside each party's wallet and coordinates atomic token swaps via an escrow service. The module:

- Builds a `SwapManifest` from a `SwapDeal` (human-readable proposal)
- Computes a deterministic `swap_id` via JCS (RFC 8785) canonicalization + SHA-256
- Includes a random `salt` in each manifest so repeated identical deals produce unique `swap_id` values
- Exchanges `swap_proposal` / `swap_acceptance` / `swap_rejection` DMs between parties
- Announces the swap to the escrow service, which creates a deposit invoice
- Deposits tokens via `AccountingModule.payInvoice()`
- Receives payout invoice from escrow after both deposits land
- Verifies payout via `AccountingModule.getInvoiceStatus()`
- Tracks local swap state (`SwapRef`) persisted to `StorageProvider`

The escrow service (server-side) uses its own `SwapOrchestrator` with states: `ANNOUNCED -> DEPOSIT_INVOICE_CREATED -> PARTIAL_DEPOSIT -> DEPOSIT_COVERED -> CONCLUDING -> COMPLETED`. The client-side SwapModule maps escrow states to a local `SwapProgress` enum for UI rendering.

### Scope

- **Methods tested:** All 8 public methods (`proposeSwap`, `acceptSwap`, `rejectSwap`, `deposit`, `getSwapStatus`, `getSwaps`, `verifyPayout`, `cancelSwap`)
- **Error codes:** 15 error codes (SWAP_NOT_FOUND through SWAP_MODULE_DESTROYED), with UT-SWAP-ERR-008a and UT-SWAP-ERR-009a covering escrow error DM and announce failure paths
- **State machine:** All local progress transitions tested via `state-machine.ts` directly (55 individual assertions) plus functional transitions through SwapModule methods
- **DM protocol:** All 9 message types (swap_proposal, swap_acceptance, swap_rejection, announce_result, invoice_delivery, payment_confirmation, swap_cancelled, bounce_notification, status)
- **Events:** All 12 event types (swap:proposed through swap:failed)
- **Storage:** Persisted swap records, dirty-write on destroy, terminal purge, corruption recovery
- **Manifest:** JCS canonicalization, deterministic swap_id with salt, field validation
- **Concurrency:** Per-swap async mutex (withSwapGate), parallel operations on different swaps
- **CLI:** All 5 swap CLI commands (swap-propose, swap-list, swap-accept, swap-status, swap-deposit)
- **Protocol v2:** Acceptor-announces path with signatures and chain pubkeys

### Test Framework

**Vitest** with the following patterns:
- `describe()` for test suites
- `it()` for individual tests with test ID prefix (e.g., `UT-SWAP-PROP-001:`)
- `beforeEach()` for setup, `afterEach()` for cleanup
- Mock factories in `swap-test-helpers.ts` for all dependencies
- `vi.waitFor()` for async DM processing assertions
- `vi.useFakeTimers()` for retry/timeout testing
- Test fixtures: sample swap deals, manifests, DM payloads

### Test ID Convention

All test IDs follow the format `UT-SWAP-{CONCERN}-{NNN}` where:
- `CONCERN` is a short mnemonic (LIFE, PROP, ACCEPT, REJECT, DEP, STATUS, VERIFY, CANCEL, DM, INV, CONC, STORE, MAN, SM, VAL, ERR, CLI)
- `NNN` is a zero-padded three-digit number (with occasional letter suffixes like `010a`, `003a`)

---

## 2. Test Infrastructure

### 2.1 Mock Factories

All mocks are defined in `tests/unit/modules/swap-test-helpers.ts` and implement the full interface of their target to avoid partial stub issues.

#### MockAccountingModule

```typescript
interface MockAccountingModule {
  importInvoice: ReturnType<typeof vi.fn>;   // (token) => Promise<InvoiceTerms>
  getInvoice: ReturnType<typeof vi.fn>;      // (invoiceId) => InvoiceRef | null
  getInvoiceStatus: ReturnType<typeof vi.fn>; // (invoiceId) => InvoiceStatus
  payInvoice: ReturnType<typeof vi.fn>;       // (invoiceId, params) => Promise<TransferResult>
  closeInvoice: ReturnType<typeof vi.fn>;     // (invoiceId, opts?) => Promise<void>
  cancelInvoice: ReturnType<typeof vi.fn>;    // (invoiceId, opts?) => Promise<void>
  on: ReturnType<typeof vi.fn>;               // (event, handler) => () => void
  // --- Test helpers ---
  _emit: (event: string, data: unknown) => void;
  _invoices: Map<string, unknown>;
  _statuses: Map<string, unknown>;
  _handlers: Map<string, Array<(data: unknown) => void>>;
  _payResult: TransferResult;                  // mutable, settable
}
```

#### MockCommunicationsModule

```typescript
interface MockCommunicationsModule {
  sendDM: ReturnType<typeof vi.fn>;           // (recipientPubkey, content) => Promise<{ eventId }>
  onDirectMessage: ReturnType<typeof vi.fn>;  // (handler) => () => void
  // --- Test helpers ---
  _sentDMs: Array<{ recipient: string; content: string }>;
  _dmHandlers: Array<(message: { senderPubkey; senderNametag?; content; timestamp }) => void>;
  _simulateIncomingDM: (content, senderPubkey, senderNametag?) => void;
}
```

#### MockPaymentsModule

```typescript
interface MockPaymentsModule {
  validate: ReturnType<typeof vi.fn>;  // () => Promise<{ valid, invalid }>
}
```

#### MockStorageProvider

```typescript
interface MockStorageProvider extends StorageProvider {
  _data: Map<string, string>;  // direct access to backing store
  // Implements full StorageProvider: get, set, remove, has, keys, clear
  // Plus BaseProvider metadata: id, name, type, description
  // Plus lifecycle stubs: connect, disconnect, isConnected, getStatus
  // Plus: setIdentity, saveTrackedAddresses, loadTrackedAddresses
}
```

#### MockResolve (transport-level peer resolution)

```typescript
interface MockResolve {
  (identifier: string): Promise<PeerInfo | null>;
  _peers: Map<string, PeerInfo>;  // pre-populated with party A, party B, and escrow
}
```

Pre-populated peers:
- Party A: `02aaaa...` -> `DIRECT://party_a_aaa111` (nametag: `alice`)
- Party B: `02bbbb...` -> `DIRECT://party_b_bbb222` (nametag: `bob`)
- Escrow: `02eeee...` -> `DIRECT://escrow_eee333` (nametag: `escrow`)

#### MockEmitEvent

```typescript
interface MockEmitEvent {
  <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  _calls: Array<[string, unknown]>;  // all calls recorded for assertion
}
```

### 2.2 Test Fixtures

#### `createTestSwapDeal(overrides?): SwapDeal`

Returns a minimal valid `SwapDeal` with DIRECT:// addresses (no resolution needed):
- `partyA: 'DIRECT://party_a_aaa111'`
- `partyB: 'DIRECT://party_b_bbb222'`
- `partyACurrency: 'UCT'`, `partyAAmount: '1000000'`
- `partyBCurrency: 'USDU'`, `partyBAmount: '500000'`
- `timeout: 300`, `escrowAddress: 'DIRECT://escrow_eee333'`

#### `createTestManifest(deal?): SwapManifest`

Builds a `SwapManifest` from a deal using the real `buildManifest()` from `manifest.ts`, which generates a random `salt` and computes `swap_id` deterministically via `computeSwapId()`.

#### `createTestSwapRef(overrides?): SwapRef`

Creates a test `SwapRef` with real manifest and swap_id computed from the deal. Defaults: `role: 'proposer'`, `progress: 'proposed'`.

#### `injectSwapRef(module, ref): void`

Directly injects a `SwapRef` into the module's private `swaps` map and updates the `invoiceToSwapIndex` if deposit or payout invoice IDs are set. Used for bypassing the normal create/load flow in test setup.

#### DM Simulation Helpers

All DM helpers use the real `buildProposalDM`, `buildAcceptanceDM`, `buildRejectionDM` from `dm-protocol.ts`:

- `createMockProposalDM(manifest, escrow?, message?): string`
- `createMockAcceptanceDM(swapId): string`
- `createMockRejectionDM(swapId, reason?): string`
- `createMockAnnounceResultDM(swapId, depositInvoiceId?): string`
- `createMockInvoiceDeliveryDM(swapId, type, invoiceId?): string`
- `createMockSwapCancelledDM(swapId, reason?, depositsReturned?): string`
- `createMockStatusResultDM(swapId, state): string`
- `createMockPaymentConfirmationDM(swapId, party?): string`
- `createMockBounceNotificationDM(swapId, reason, returnedAmount, returnedCurrency): string`
- `createMockEscrowErrorDM(error, swapId?): string`

### 2.3 Orchestrator

#### `createTestSwapModule(configOverrides?): { module, mocks }`

Creates a fully-configured SwapModule with mock dependencies. Calls `initialize()` with all mock deps but does NOT call `load()` -- tests that need loaded state should call `await module.load()` explicitly.

```typescript
function createTestSwapModule(configOverrides?: Partial<SwapModuleConfig>): {
  module: SwapModule;
  mocks: TestSwapModuleMocks;
}
```

The `SwapModuleConfig` accepts: `debug`, `defaultEscrowAddress`, `maxPendingSwaps`, `announceTimeoutMs`, `terminalPurgeTtlMs`, `proposalTimeoutMs`.

---

## 3. Unit Tests

### 3.1 Module Lifecycle (11 tests)

**File:** `tests/unit/modules/SwapModule.lifecycle.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-LIFE-001 | Constructor accepts config with defaults (`maxPendingSwaps`, `announceTimeoutMs: 30000`, `terminalPurgeTtlMs: 7 days`, `proposalTimeoutMs: 300000`) |
| UT-SWAP-LIFE-002 | `initialize()` stores deps reference (storage, accounting accessible) |
| UT-SWAP-LIFE-003 | `load()` loads persisted swap records from storage (index + record keys) |
| UT-SWAP-LIFE-004 | `load()` registers DM handler via `communications.onDirectMessage()` |
| UT-SWAP-LIFE-005 | `load()` subscribes to invoice events (`invoice:payment`, `invoice:covered`, `invoice:return_received`) |
| UT-SWAP-LIFE-006 | `destroy()` unsubscribes all DM and accounting handlers |
| UT-SWAP-LIFE-007 | `destroy()` persists dirty swap records (index flushed to storage) |
| UT-SWAP-LIFE-008 | `destroy()` clears local timers |
| UT-SWAP-LIFE-009 | Double initialize replaces deps without throwing (supports `switchToAddress` flow) |
| UT-SWAP-LIFE-010 | Operations before `load()` throw `SWAP_NOT_INITIALIZED` (all 8 public methods tested) |
| UT-SWAP-LIFE-011 | Operations after `destroy()` throw `SWAP_MODULE_DESTROYED` (all 8 public methods tested) |

**Note:** UT-SWAP-LIFE-009 diverges from the original spec which predicted `SWAP_ALREADY_INITIALIZED`. The actual implementation allows re-initialization for the `switchToAddress` flow.

---

### 3.2 proposeSwap() (19 tests)

**File:** `tests/unit/modules/SwapModule.proposeSwap.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-PROP-001 | Valid deal creates SwapProposal with 64-hex `swap_id`; `getSwaps()` returns 1 swap with `progress: 'proposed'`, `role: 'proposer'` |
| UT-SWAP-PROP-002 | `swap_id` is deterministic (same `ManifestFields` with same salt produce same ID via `computeSwapId()`) |
| UT-SWAP-PROP-003 | Resolves `@nametag` addresses via `deps.resolve()` (called with `@alice` and `@bob`) |
| UT-SWAP-PROP-004 | Sends `swap_proposal:` DM to counterparty transport pubkey; content is prefixed JSON with `type: 'swap_proposal'` and `manifest.swap_id` |
| UT-SWAP-PROP-005 | Emits `swap:proposed` event with `{ swapId, deal, recipientPubkey }` |
| UT-SWAP-PROP-006 | Persists SwapRef to storage with `progress: 'proposed'`, `role: 'proposer'`, `createdAt` as number |
| UT-SWAP-PROP-007 | Rejects empty `partyA` address (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-008 | Rejects empty `partyB` address (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-009 | Rejects same `partyA` and `partyB` address -- self-swap (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-010 | Rejects non-positive amount for partyA (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-011 | Rejects zero amount for partyB (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-012 | Rejects same currency for both parties (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-013 | Rejects timeout less than 60 seconds (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-014 | Rejects timeout greater than 86400 seconds (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-015 | Rejects empty `escrowAddress` when no default configured (`SWAP_INVALID_DEAL`) |
| UT-SWAP-PROP-016 | Rejects if `maxPendingSwaps` exceeded (`SWAP_LIMIT_EXCEEDED`) |
| UT-SWAP-PROP-017 | Address resolution failure throws `SWAP_RESOLVE_FAILED` |
| UT-SWAP-PROP-018 | DM send failure throws `SWAP_DM_SEND_FAILED` |
| UT-SWAP-PROP-019 | Same deal proposed twice creates two swaps with different IDs (salt makes each unique) |

**Note:** UT-SWAP-PROP-019 diverges from the original spec which predicted idempotency. The actual implementation generates a unique salt per call, so identical deals produce different `swap_id` values.

---

### 3.3 acceptSwap() and rejectSwap() (15 tests)

**File:** `tests/unit/modules/SwapModule.acceptReject.test.ts`

**acceptSwap() -- 10 tests:**

| Test ID | Description |
|---------|-------------|
| UT-SWAP-ACCEPT-001 | Sends `swap_acceptance` DM to counterparty (proposer transport pubkey) |
| UT-SWAP-ACCEPT-002 | Resolves escrow and announces manifest via DM to escrow transport pubkey |
| UT-SWAP-ACCEPT-003 | Resolves and stores `escrowPubkey`; DM handler calls `importInvoice` on `invoice_delivery` |
| UT-SWAP-ACCEPT-004 | Transitions to `accepted` state (not `proposed`); emits `swap:accepted` event |
| UT-SWAP-ACCEPT-005 | Emits `swap:accepted` event with `{ swapId, role: 'acceptor' }` |
| UT-SWAP-ACCEPT-006 | Non-existent swap throws `SWAP_NOT_FOUND` |
| UT-SWAP-ACCEPT-007 | Wrong state (e.g., `depositing`) throws `SWAP_WRONG_STATE` |
| UT-SWAP-ACCEPT-008 | Proposer cannot accept own swap -- throws `SWAP_WRONG_STATE` |
| UT-SWAP-ACCEPT-009 | Escrow rejection (sendDM failure for announce) transitions to `failed` after retry exhaustion |
| UT-SWAP-ACCEPT-010 | DM timeout (announce failure) transitions to `failed` after retry exhaustion |

**Implementation note:** Tests UT-SWAP-ACCEPT-009 and UT-SWAP-ACCEPT-010 use `vi.useFakeTimers()` to advance through the 6-attempt exponential backoff retry logic in `sendAnnounce_v2`. The test setup creates v2 protocol swaps with `protocolVersion: 2` and `proposerChainPubkey`.

**rejectSwap() -- 5 tests:**

| Test ID | Description |
|---------|-------------|
| UT-SWAP-REJECT-001 | Sends `swap_rejection` DM to counterparty (proposer transport pubkey) |
| UT-SWAP-REJECT-002 | Transitions to `cancelled` |
| UT-SWAP-REJECT-003 | Emits `swap:rejected` event with `{ swapId }` |
| UT-SWAP-REJECT-004 | `concluding` state throws `SWAP_WRONG_STATE` (payouts in progress) |
| UT-SWAP-REJECT-005 | Includes reason in rejection DM (`reason: 'Price too high'`) |

---

### 3.4 deposit() (8 tests)

**File:** `tests/unit/modules/SwapModule.deposit.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-DEP-001 | Party A deposit uses `assetIndex=0` (`payInvoice` called with `targetIndex: 0, assetIndex: 0`) |
| UT-SWAP-DEP-002 | Party B deposit uses `assetIndex=1` (deal parties swapped so local matches B) |
| UT-SWAP-DEP-003 | Transitions to `depositing` |
| UT-SWAP-DEP-004 | Emits `swap:deposit_sent` with `{ swapId, transferResult }` |
| UT-SWAP-DEP-005 | Wrong state (`proposed`) throws `SWAP_WRONG_STATE` |
| UT-SWAP-DEP-006 | `payInvoice` failure throws `SWAP_DEPOSIT_FAILED` |
| UT-SWAP-DEP-007 | No `depositInvoiceId` throws `SWAP_WRONG_STATE` |
| UT-SWAP-DEP-008 | Stores `localDepositTransferId` on success |

---

### 3.5 getSwapStatus() and getSwaps() (8 tests)

**File:** `tests/unit/modules/SwapModule.status.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-STATUS-001 | `getSwapStatus` returns SwapRef copy (all fields present, not same reference) |
| UT-SWAP-STATUS-002 | `getSwapStatus` with `queryEscrow: true` sends status DM to escrow |
| UT-SWAP-STATUS-003 | `getSwapStatus` on non-existent swap throws `SWAP_NOT_FOUND` |
| UT-SWAP-STATUS-004 | `getSwaps` returns all tracked swaps (3 injected -> 3 returned) |
| UT-SWAP-STATUS-005 | `getSwaps` with `{ progress: 'proposed' }` filter returns matching only |
| UT-SWAP-STATUS-006 | `getSwaps` with `{ role: 'acceptor' }` filter returns matching only |
| UT-SWAP-STATUS-007 | `getSwaps` with `{ excludeTerminal: true }` filters out completed/cancelled/failed |
| UT-SWAP-STATUS-008 | `getSwaps` returns empty array when no swaps exist |

---

### 3.6 verifyPayout() (9 tests)

**File:** `tests/unit/modules/SwapModule.verify.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-VERIFY-001 | Checks invoice status `isCovered` via `getInvoiceStatus` |
| UT-SWAP-VERIFY-002 | Returns `false` when invoice has wrong currency; emits `swap:failed` |
| UT-SWAP-VERIFY-003 | Returns `false` when invoice has wrong amount; emits `swap:failed` |
| UT-SWAP-VERIFY-004 | Transitions to `completed` on success; sets `payoutVerified: true` |
| UT-SWAP-VERIFY-005 | Emits `swap:completed` with `{ swapId, payoutVerified: true }` |
| UT-SWAP-VERIFY-006 | Returns `false` if not yet covered; progress stays `concluding` |
| UT-SWAP-VERIFY-007 | Returns `false` if wrong currency in payout; emits `swap:failed` |
| UT-SWAP-VERIFY-008 | Returns `false` if wrong amount in payout; emits `swap:failed` |
| UT-SWAP-VERIFY-009 | No `payoutInvoiceId` throws `SWAP_WRONG_STATE` |

---

### 3.7 cancelSwap() (7 tests)

**File:** `tests/unit/modules/SwapModule.cancel.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CANCEL-001 | Pre-announcement cancel marks cancelled locally; no escrow DM sent |
| UT-SWAP-CANCEL-002 | Emits `swap:cancelled` with `reason: 'explicit'` |
| UT-SWAP-CANCEL-003 | Already completed throws `SWAP_ALREADY_COMPLETED` |
| UT-SWAP-CANCEL-004 | Already cancelled throws `SWAP_ALREADY_CANCELLED` |
| UT-SWAP-CANCEL-005 | Escrow `swap_cancelled` DM updates local state to `cancelled` |
| UT-SWAP-CANCEL-006 | Cancellation clears local timer |
| UT-SWAP-CANCEL-007 | Deposit return tracked after cancellation (emits `swap:deposit_returned` via `invoice:return_received`) |

---

### 3.8 DM Processing (12 tests)

**File:** `tests/unit/modules/SwapModule.dmProcessing.test.ts`

Tests the `handleIncomingDM` private method indirectly via `_simulateIncomingDM()` on the mock CommunicationsModule. The DM handler is registered during `load()`.

| Test ID | Description |
|---------|-------------|
| UT-SWAP-DM-001 | `swap_proposal` DM creates SwapRef with `role: 'acceptor'`, `progress: 'proposed'` |
| UT-SWAP-DM-002 | `swap_proposal` DM emits `swap:proposal_received` with `{ swapId, deal, senderPubkey }` |
| UT-SWAP-DM-003 | `swap_acceptance` DM from counterparty triggers escrow announcement (for proposer) |
| UT-SWAP-DM-004 | `swap_rejection` DM marks swap as `cancelled`; emits both `swap:rejected` and `swap:cancelled` |
| UT-SWAP-DM-005 | `announce_result` DM stores `deposit_invoice_id` on SwapRef |
| UT-SWAP-DM-006 | `invoice_delivery` DM imports invoice via `AccountingModule.importInvoice()` |
| UT-SWAP-DM-007 | `payment_confirmation` DM updates progress to `concluding` |
| UT-SWAP-DM-008 | `swap_cancelled` DM updates to `cancelled`; emits `swap:cancelled` |
| UT-SWAP-DM-009 | `bounce_notification` DM emits `swap:bounce_received` with `{ swapId, reason, returnedAmount, returnedCurrency }` |
| UT-SWAP-DM-010 | Malformed DM (non-JSON) silently ignored; no state change, no swap events emitted |
| UT-SWAP-DM-011 | DM from unknown sender ignored; swap state unchanged |
| UT-SWAP-DM-012 | DM for unknown `swap_id` handled gracefully; no new swap created for non-proposal DMs |

---

### 3.9 Invoice Event Subscriptions (7 tests)

**File:** `tests/unit/modules/SwapModule.invoiceEvents.test.ts`

Tests the `setupInvoiceEventSubscriptions` private method by triggering invoice events via `_emit()` on the mock AccountingModule.

| Test ID | Description |
|---------|-------------|
| UT-SWAP-INV-001 | `invoice:payment` on deposit invoice emits `swap:deposit_confirmed` with `{ swapId, party: 'A', coinId }` |
| UT-SWAP-INV-002 | `invoice:covered` on deposit invoice emits `swap:deposits_covered` with `{ swapId }` |
| UT-SWAP-INV-003 | `invoice:covered` on deposit transitions to `concluding` |
| UT-SWAP-INV-004 | `invoice:return_received` on deposit invoice emits `swap:deposit_returned` with `{ swapId, returnReason }` |
| UT-SWAP-INV-004a | Payout `invoice_delivery` via DM emits `swap:payout_received` with `{ swapId, payoutInvoiceId }`; calls `importInvoice` |
| UT-SWAP-INV-005 | `invoice:return_received` transitions to `cancelled` with `depositsReturned: true` |
| UT-SWAP-INV-006 | Invoice event for non-swap invoice ignored; no swap events emitted |

**Note:** UT-SWAP-INV-004a tests payout delivery via escrow DM (not via `invoice:created` event). This is the actual implementation design -- the escrow controls payout delivery timing via `invoice_delivery` DM with `invoice_type: 'payout'`.

---

### 3.10 Concurrency (4 tests)

**File:** `tests/unit/modules/SwapModule.concurrency.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CONC-001 | Concurrent operations on same swap are serialized (acceptSwap + cancelSwap on same swapId; final state is consistent) |
| UT-SWAP-CONC-002 | Operations on different swaps run in parallel (both acceptSwap calls succeed independently) |
| UT-SWAP-CONC-003 | Gate released on error (first op fails, second op on same swap succeeds -- no deadlock) |
| UT-SWAP-CONC-004 | Concurrent `proposeSwap` with same deal creates two swaps (unique salt per call) |

**Note:** UT-SWAP-CONC-004 diverges from the original spec which predicted idempotency. The actual implementation uses a unique salt per `proposeSwap()` call, so two concurrent calls produce two distinct swaps.

---

### 3.11 Storage (5 tests)

**File:** `tests/unit/modules/SwapModule.storage.test.ts`

| Test ID | Description |
|---------|-------------|
| UT-SWAP-STORE-001 | Swap record persisted on state transition (`acceptSwap` writes updated progress to storage) |
| UT-SWAP-STORE-002 | `load()` restores 2 persisted swaps from index + record keys |
| UT-SWAP-STORE-003 | `destroy()` persists dirty records (index flushed) |
| UT-SWAP-STORE-004 | Storage corruption handled gracefully (invalid JSON skipped, valid records loaded) |
| UT-SWAP-STORE-005 | Terminal swaps purged after TTL (`storage.remove()` called for expired completed swap) |

Storage key format: `getAddressStorageKey(addressId, STORAGE_KEYS_ADDRESS.SWAP_INDEX)` for the index and `getAddressStorageKey(addressId, SWAP_RECORD_PREFIX + swapId)` for individual records. Records are wrapped in `{ version: 1, swap: SwapRef }`.

---

### 3.12 Manifest Construction and swap_id (7 tests)

**File:** `tests/unit/modules/SwapModule.manifest.test.ts`

Tests `manifest.ts` directly: `computeSwapId`, `buildManifest`, `validateManifest`.

| Test ID | Description |
|---------|-------------|
| UT-SWAP-MAN-001 | `computeSwapId` produces 64-hex string matching `/^[0-9a-f]{64}$/` |
| UT-SWAP-MAN-002 | `computeSwapId` is deterministic (same input produces same output) |
| UT-SWAP-MAN-003 | `computeSwapId` uses JCS canonicalization (field order irrelevant) |
| UT-SWAP-MAN-004 | Field ordering does not affect `swap_id` (two different insertion orders produce same hash) |
| UT-SWAP-MAN-005 | `buildManifest` constructs correct manifest with DIRECT addresses; `salt` matches `/^[0-9a-f]{32}$/`; `swap_id` matches recomputation from fields |
| UT-SWAP-MAN-006 | `validateManifest` rejects invalid fields (bad swap_id, non-DIRECT address, same currencies, timeout out of range, leading zeros in amount) |
| UT-SWAP-MAN-007 | Cross-implementation compatibility (known test vector with fixed salt produces deterministic hash; changing any field produces different hash) |

---

### 3.13 State Machine (55 tests)

**File:** `tests/unit/modules/SwapModule.stateMachine.test.ts`

Tests `state-machine.ts` directly: `assertTransition`, `isTerminalProgress`, `isValidTransition`, `mapEscrowStateToProgress`, `VALID_PROGRESS_TRANSITIONS`, `TERMINAL_PROGRESS`.

#### Valid Transitions

| Test ID | From | To |
|---------|------|----|
| UT-SWAP-SM-001 | proposed | accepted |
| UT-SWAP-SM-002 | proposed | cancelled |
| UT-SWAP-SM-003 | proposed | failed |
| UT-SWAP-SM-004 | accepted | announced |
| UT-SWAP-SM-005 | accepted | failed |
| UT-SWAP-SM-006 | accepted | cancelled |
| UT-SWAP-SM-007 | announced | depositing |
| UT-SWAP-SM-008 | announced | cancelled |
| UT-SWAP-SM-009 | depositing | awaiting_counter |
| UT-SWAP-SM-010 | depositing | failed |
| UT-SWAP-SM-010a | depositing | cancelled |
| *(unnumbered)* | depositing | concluding |
| *(unnumbered)* | depositing | completed |
| UT-SWAP-SM-011 | awaiting_counter | concluding |
| UT-SWAP-SM-012 | awaiting_counter | cancelled |
| *(unnumbered)* | awaiting_counter | completed |
| *(unnumbered)* | awaiting_counter | failed |
| UT-SWAP-SM-013 | concluding | completed |
| UT-SWAP-SM-014 | concluding | cancelled |
| UT-SWAP-SM-015 | concluding | failed |

#### Invalid Transitions

| Test ID | From | Attempted To |
|---------|------|-------------|
| UT-SWAP-SM-016 | proposed | depositing |
| UT-SWAP-SM-017 | proposed | concluding |
| UT-SWAP-SM-018 | announced | completed |
| UT-SWAP-SM-019 | depositing | announced |
| UT-SWAP-SM-020 | awaiting_counter | proposed |
| UT-SWAP-SM-021 | completed | cancelled |
| UT-SWAP-SM-022 | completed | depositing |
| UT-SWAP-SM-023 | cancelled | proposed |
| UT-SWAP-SM-024 | cancelled | depositing |
| UT-SWAP-SM-025 | failed | depositing |

#### Terminal State Detection

- **3 tests:** `completed`, `cancelled`, `failed` have empty transition lists

#### UT-SWAP-SM-026: isTerminalProgress (9 sub-assertions)

Tests all 9 progress values: `completed`, `cancelled`, `failed` return `true`; `proposed`, `accepted`, `announced`, `depositing`, `awaiting_counter`, `concluding` return `false`.

#### UT-SWAP-SM-027: mapEscrowStateToProgress (11 sub-assertions)

Maps all 10 escrow states plus unknown:

| Escrow State | Local Progress |
|-------------|---------------|
| ANNOUNCED | announced |
| DEPOSIT_INVOICE_CREATED | announced |
| PARTIAL_DEPOSIT | depositing |
| DEPOSIT_COVERED | awaiting_counter |
| CONCLUDING | concluding |
| COMPLETED | completed |
| TIMED_OUT | cancelled |
| CANCELLING | cancelled |
| CANCELLED | cancelled |
| FAILED | failed |
| *(unknown)* | null |

#### UT-SWAP-SM-003a: proposed -> cancelled is the rejection path (distinct from failed)

Validates that both `cancelled` and `failed` are valid targets from `proposed`, and that the `VALID_PROGRESS_TRANSITIONS['proposed']` set contains both.

#### UT-SWAP-SM-028: TERMINAL_PROGRESS contains exactly completed, cancelled, failed

---

### 3.14 Input Validation (20 tests)

**File:** `tests/unit/modules/SwapModule.validation.test.ts`

#### Address Format Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-001 | `partyA = 'DIRECT://...'` | Accepted |
| UT-SWAP-VAL-002 | `partyA = '@alice'` | Accepted (resolved) |
| UT-SWAP-VAL-003 | `partyA = '02aaaa...'` | Accepted (chain pubkey) |
| UT-SWAP-VAL-004 | `partyA = 'alpha1...'` | Accepted (L1 address) |
| UT-SWAP-VAL-005 | `partyA = ''` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-006 | `partyA = null` | Rejected: SWAP_INVALID_DEAL |

#### Amount Format Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-007 | `partyAAmount = '1000000'` | Accepted |
| UT-SWAP-VAL-008 | `partyAAmount = '1'` | Accepted (minimum) |
| UT-SWAP-VAL-009 | `partyAAmount = '0'` | Rejected |
| UT-SWAP-VAL-010 | `partyAAmount = '-100'` | Rejected |
| UT-SWAP-VAL-011 | `partyAAmount = '10.5'` | Rejected |
| UT-SWAP-VAL-012 | `partyAAmount = ''` | Rejected |
| UT-SWAP-VAL-013 | `partyAAmount = 'abc'` | Rejected |

#### Currency Format Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-014 | `partyACurrency = 'UCT'` | Accepted |
| UT-SWAP-VAL-015 | `partyBCurrency = 'USDU'` | Accepted |
| UT-SWAP-VAL-016 | `partyACurrency = ''` | Rejected |
| UT-SWAP-VAL-017 | `partyACurrency = 'UC-T'` | Rejected (special characters) |

#### Timeout Range Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-018 | `timeout = 60` | Accepted (minimum) |
| UT-SWAP-VAL-019 | `timeout = 86400` | Accepted (maximum) |
| UT-SWAP-VAL-020 | `timeout = 0` | Rejected |

---

### 3.15 Error Codes (17 tests)

**File:** `tests/unit/modules/SwapModule.errors.test.ts`

| Test ID | Error Code | Trigger |
|---------|-----------|---------|
| UT-SWAP-ERR-001 | SWAP_NOT_FOUND | `getSwapStatus('nonexistent')` |
| UT-SWAP-ERR-002 | SWAP_INVALID_DEAL | `proposeSwap({ partyA: '' })` |
| UT-SWAP-ERR-003 | SWAP_WRONG_STATE | `deposit()` on `proposed` swap |
| UT-SWAP-ERR-004 | SWAP_WRONG_STATE | `acceptSwap()` on proposer's swap |
| UT-SWAP-ERR-005 | SWAP_RESOLVE_FAILED | Escrow address resolution returns null |
| UT-SWAP-ERR-006 | SWAP_DM_SEND_FAILED | `sendDM()` rejects |
| UT-SWAP-ERR-007 | SWAP_DEPOSIT_FAILED | `payInvoice()` rejects |
| UT-SWAP-ERR-008 | SWAP_NOT_FOUND | `acceptSwap('nonexistent')` |
| UT-SWAP-ERR-008a | *(escrow error DM)* | Escrow sends `type: 'error'` DM for accepted swap -> transitions to `failed`; emits `swap:failed` |
| UT-SWAP-ERR-009 | SWAP_NOT_FOUND | `rejectSwap('nonexistent')` |
| UT-SWAP-ERR-009a | *(announce failure)* | `sendAnnounce_v2` exhausts all 6 retries during `acceptSwap` -> swap transitions to `failed`; emits `swap:failed` |
| UT-SWAP-ERR-010 | SWAP_ALREADY_COMPLETED | `cancelSwap()` on completed swap |
| UT-SWAP-ERR-011 | SWAP_ALREADY_CANCELLED | `cancelSwap()` on cancelled swap |
| UT-SWAP-ERR-012 | SWAP_LIMIT_EXCEEDED | Exceed `maxPendingSwaps` |
| UT-SWAP-ERR-013 | SWAP_NOT_INITIALIZED | Operation before `load()` |
| UT-SWAP-ERR-014 | SWAP_MODULE_DESTROYED | Operation after `destroy()` |
| UT-SWAP-ERR-015 | SWAP_NOT_INITIALIZED | `load()` before `initialize()` |

**Note:** UT-SWAP-ERR-008a and UT-SWAP-ERR-009a are implementation-specific tests that cover how the module handles escrow errors via DM handler (008a) and announce retry exhaustion (009a). The original spec listed `SWAP_ESCROW_REJECTED` and `SWAP_ESCROW_TIMEOUT` as separate error codes; the implementation handles these as state transitions to `failed` rather than thrown errors. UT-SWAP-ERR-009a uses `vi.useFakeTimers()` and creates v2 protocol swaps with `protocolVersion: 2` and `proposerChainPubkey`.

---

### 3.16 CLI Commands (33 tests)

**File:** `tests/unit/modules/SwapModule.cli.test.ts`

Tests the CLI swap commands by creating a minimal harness that replicates the CLI's switch-case logic and verifying it calls the SwapModule methods correctly. This avoids the fragility of importing the CLI module with mocked globals.

**Test infrastructure:**
- `MockSwapModule`: local mock with `proposeSwap`, `acceptSwap`, `deposit`, `getSwapStatus`, `getSwaps`
- `createMockSphere(swapModule)`: minimal Sphere shape the CLI needs
- `runSwapCommand(args, sphere)`: executes CLI logic, captures stdout/stderr/exitCode

#### swap-propose (10 tests)

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CLI-001 | Valid proposal with all required flags calls `proposeSwap` with correct SwapDeal |
| UT-SWAP-CLI-002 | Missing `--to` flag prints usage and exits 1 |
| UT-SWAP-CLI-003 | Missing `--offer` prints usage and exits 1 |
| UT-SWAP-CLI-004 | Invalid offer amount (not positive integer) prints error and exits 1 |
| UT-SWAP-CLI-005 | `--timeout` out of range [60, 86400] prints error and exits 1 |
| UT-SWAP-CLI-006 | Default timeout is 3600 when not specified |
| UT-SWAP-CLI-007 | `--escrow` flag overrides default escrow |
| UT-SWAP-CLI-008 | `--message` flag passed as `options.message` to proposeSwap |
| UT-SWAP-CLI-009 | `SWAP_RESOLVE_FAILED` error prints user-friendly message |
| UT-SWAP-CLI-010 | Output includes swap_id, counterparty, offer, want summary |

#### swap-list (6 tests)

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CLI-011 | Default (no flags) excludes terminal states (`excludeTerminal: true`) |
| UT-SWAP-CLI-012 | `--all` flag includes terminal states |
| UT-SWAP-CLI-013 | `--role proposer` filters by role |
| UT-SWAP-CLI-014 | `--progress depositing` filters by progress |
| UT-SWAP-CLI-015 | No matching swaps prints "No swaps found." |
| UT-SWAP-CLI-016 | Output table has correct columns (SWAP ID, ROLE, PROGRESS, OFFER, WANT, COUNTERPARTY, CREATED) |

#### swap-accept (8 tests)

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CLI-017 | Valid swap_id calls `acceptSwap` |
| UT-SWAP-CLI-018 | Missing swap_id prints usage and exits 1 |
| UT-SWAP-CLI-019 | Invalid swap_id (not 64 hex) prints error and exits 1 |
| UT-SWAP-CLI-020 | `--deposit` flag also calls `deposit()` after accept |
| UT-SWAP-CLI-021 | Without `--deposit` prints instruction to run `swap-deposit` |
| UT-SWAP-CLI-022 | `SWAP_NOT_FOUND` error prints user-friendly message |
| UT-SWAP-CLI-023 | `SWAP_WRONG_STATE` error prints current state |
| UT-SWAP-CLI-024 | `--deposit` with `--no-wait` returns immediately after deposit sent |

#### swap-status (3 tests)

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CLI-025 | Shows full SwapRef fields including deposit/payout invoice IDs |
| UT-SWAP-CLI-026 | `--query-escrow` flag triggers `getSwapStatus` with `{ queryEscrow: true }` |
| UT-SWAP-CLI-027 | `SWAP_NOT_FOUND` prints error |

#### swap-deposit (3 tests)

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CLI-028 | Valid swap_id calls `deposit()` |
| UT-SWAP-CLI-029 | `SWAP_WRONG_STATE` prints current state info |
| UT-SWAP-CLI-030 | `SWAP_DEPOSIT_FAILED` prints failure details |

#### Extra error conditions (3 tests)

| Test ID | Description |
|---------|-------------|
| UT-SWAP-CLI-031 | `swap-propose` without `--escrow` and no `defaultEscrowAddress` prints error |
| UT-SWAP-CLI-032 | `SWAP_LIMIT_EXCEEDED` prints error |
| UT-SWAP-CLI-033 | `swap-propose` with self-address as `--to` prints error |

---

## 4. Integration Tests (6 tests)

**File:** `tests/integration/swap-lifecycle.test.ts`

### Test Infrastructure

Two SwapModule instances (partyA and partyB) communicating via a `MockDMRelay`. An `EscrowSimulator` class simulates escrow behavior by intercepting DMs addressed to the escrow and replying with appropriate protocol messages.

**Key components:**
- `MockDMRelay`: Routes DMs between parties based on recipient transport pubkey
- `EscrowSimulator`: Mini state machine that responds to `announce` DMs with `announce_result` + `invoice_delivery`, detects coverage via `payInvoice` completion, and sends `payment_confirmation` + payout `invoice_delivery`
- Uses real `secp256k1` keys for party A and party B (private keys `'a'.repeat(64)` and `'b'.repeat(64)`) with correct compressed pubkeys derived via `@noble/curves`
- v2 protocol: Escrow sends `announce_result` and `invoice_delivery` to BOTH parties (not just the announcer)

### INT-SWAP-001: Happy path -- propose, accept, announce, deposit, conclude, verify

Party A proposes, Party B accepts and announces to escrow, escrow creates deposit invoice, both parties deposit, escrow confirms coverage, payout invoices delivered, both parties verify and complete.

### INT-SWAP-002: Rejection flow -- propose, reject

Party A proposes, Party B rejects with reason. Party A's swap transitions to `cancelled`; Party B's swap transitions to `cancelled`.

### INT-SWAP-003: Timeout cancellation -- escrow sends swap_cancelled after timeout

Both parties propose, accept, announce. Party A deposits; Party B does NOT deposit. Escrow simulator times out and sends `swap_cancelled` to both parties. Both end in `cancelled` state.

### INT-SWAP-004: Party A cancels before deposit

Both parties propose, accept, announce. Party A calls `cancelSwap()` before depositing. Party A's swap becomes `cancelled`.

### INT-SWAP-005: Concurrent proposal -- same deal produces different swap_ids (unique salt)

Party A proposes swap twice with same deal. Each proposal creates a unique swap_id due to random salt. Two distinct swaps tracked.

### INT-SWAP-006: Multiple independent swaps between same parties

Party A proposes two different swaps (UCT-for-USDU and UCT-for-EUR). Both are accepted, deposited, and verified independently. No cross-contamination.

---

## 5. E2E Tests

**File:** `tests/scripts/test-e2e-swap.ts`

> **Status:** Future -- requires real escrow service deployment on testnet. Not yet implemented.

---

## 6. Cross-Cutting Concerns

### 6.1 Event Ordering

All swap events fire in chronological order:

```
swap:proposed
  -> swap:accepted (or swap:rejected -> swap:cancelled)
    -> swap:announced
      -> swap:deposit_sent
        -> swap:deposit_confirmed
          -> swap:deposits_covered
            -> swap:concluding
              -> swap:payout_received
                -> swap:completed

Alternative terminal paths:
  swap:cancelled (from any non-terminal state)
  swap:failed (from any non-terminal state)
  swap:deposit_returned (after cancellation)
  swap:bounce_received (informational, any state)
```

### 6.2 DM Protocol Versioning

DM payloads use a type prefix format: `swap_proposal:{JSON}`, `swap_acceptance:{JSON}`, etc. The DM handler splits on the first `:` to extract the type prefix, then JSON-parses the remainder. Escrow messages are pure JSON (no prefix).

### 6.3 Storage Key Convention

Swap records use address-scoped storage keys:
- Index: `getAddressStorageKey(addressId, STORAGE_KEYS_ADDRESS.SWAP_INDEX)` -- JSON array of `{ swapId, progress, role, createdAt }`
- Records: `getAddressStorageKey(addressId, SWAP_RECORD_PREFIX + swapId)` -- `{ version: 1, swap: SwapRef }`

### 6.4 Escrow Address Validation

Protocol DMs (`announce_result`, `invoice_delivery`, `payment_confirmation`, `swap_cancelled`, `bounce_notification`, `error`) are only processed if the sender matches the stored `escrowPubkey` for the swap. DMs from other addresses are silently ignored (tested by UT-SWAP-DM-011).

### 6.5 Timer Management

- Announce timeout: managed by retry logic in `sendAnnounce_v2` (6 attempts with exponential backoff)
- Proposal timeout: `proposalTimeoutMs` (default 300s) for incoming proposal expiry
- All local timers cleared on `destroy()` (tested by UT-SWAP-LIFE-008)

---

## 7. Protocol v2 Test Coverage

The swap protocol has evolved from v1 to v2 with the following changes. This section documents which v2-specific behaviors are tested and where.

### 7.1 v2 proposal includes signatures

**Behavior:** `proposeSwap` with `escrowAddress` option sets `protocolVersion: 2` on the SwapRef and includes `proposerChainPubkey` (identity's chain pubkey) and `proposerSignature` on the proposal.

**Coverage:**
- The `setupAcceptorProposed()` helper in `SwapModule.acceptReject.test.ts` creates v2 swaps with `protocolVersion: 2` and `proposerChainPubkey: DEFAULT_TEST_PARTY_A_PUBKEY`
- `SwapModule.proposeSwap.test.ts` does not explicitly assert `proposer_signature` in the DM content -- it verifies the DM is sent and contains the manifest, but does not check v2-specific fields
- The integration test `swap-lifecycle.test.ts` uses real secp256k1 keys and exercises the full v2 flow with signature verification

**Verdict:** Partially covered. The v2 proposal path is exercised through acceptance tests and integration tests, but there is no explicit unit test verifying that the proposal DM contains `proposer_signature` and `proposer_chain_pubkey` fields.

### 7.2 acceptSwap v2 path: Bob announces directly to escrow

**Behavior:** In v2, when the acceptor calls `acceptSwap()`, the acceptor announces directly to the escrow (not relayed through the proposer).

**Coverage:**
- UT-SWAP-ACCEPT-002 verifies that `acceptSwap()` sends an announce DM directly to the escrow transport pubkey
- UT-SWAP-ACCEPT-009 and UT-SWAP-ACCEPT-010 test the announce retry/failure path using `sendAnnounce_v2`
- UT-SWAP-ERR-009a explicitly creates a v2 swap and tests announce failure
- INT-SWAP-001 exercises the full v2 acceptance flow

**Verdict:** Covered.

### 7.3 Downgrade attack prevention: v1 acceptance on v2 swap

**Behavior:** If a v1 acceptance DM arrives for a v2 swap, it should be silently dropped and the proposal timer should NOT be cleared.

**Coverage:** No explicit unit test for this behavior.

**Verdict:** TODO: add coverage for downgrade attack prevention.

### 7.4 Invalid acceptor signature

**Behavior:** A v2 acceptance DM with an invalid/wrong signature should be silently dropped and the proposal timer should NOT be cleared.

**Coverage:** No explicit unit test for this behavior in the unit test suite. The integration test uses real keys, which validates the happy path but does not test signature rejection.

**Verdict:** TODO: add coverage for invalid acceptor signature rejection.

### 7.5 Acceptor signature stored

**Behavior:** After v2 acceptance, `SwapRef.acceptorSignature` is persisted.

**Coverage:**
- UT-SWAP-ERR-009a creates a v2 swap with `protocolVersion: 2` and `proposerChainPubkey` set, but does not explicitly assert `acceptorSignature` storage
- The integration test exercises this path end-to-end but does not assert the field directly

**Verdict:** TODO: add explicit coverage for `acceptorSignature` persistence after v2 acceptance.

### 7.6 Salt in manifest

**Behavior:** `buildManifest` always adds a random `salt` field; each proposal produces a unique `swap_id`.

**Coverage:**
- UT-SWAP-MAN-005 verifies `manifest.salt` matches `/^[0-9a-f]{32}$/`
- UT-SWAP-PROP-019 verifies that same deal proposed twice produces different swap_ids
- UT-SWAP-CONC-004 verifies concurrent proposals with same deal create two swaps with different IDs
- UT-SWAP-MAN-007 includes `salt` in the test vector fields

**Verdict:** Fully covered.

### 7.7 Hash construction includes v2 fields when present

**Behavior:** `computeSwapId` / `verifyManifestIntegrity` includes v2 fields (like `escrow_address`) in the hash when present (using `!== undefined` check).

**Coverage:** No explicit test that adds v2-only fields to `ManifestFields` and verifies they affect the hash. The manifest tests use v1 field sets.

**Verdict:** TODO: add coverage for v2 field inclusion in hash construction.

### 7.8 v1 backward compat: v1 proposal triggers proposer announces to escrow

**Behavior:** For a v1 proposal (no `escrowAddress` in deal), the proposer announces to the escrow after receiving acceptance.

**Coverage:**
- UT-SWAP-DM-003 tests the v1 path: proposer receives acceptance DM and sends announcement to escrow
- This test injects a swap without `protocolVersion`, which defaults to v1 behavior

**Verdict:** Covered.

---

## Appendix A: Test Matrix

### Test Count Summary

| Test File | Test IDs | Vitest Count |
|-----------|----------|:------------:|
| SwapModule.lifecycle.test.ts | UT-SWAP-LIFE-001 to 011 | 11 |
| SwapModule.proposeSwap.test.ts | UT-SWAP-PROP-001 to 019 | 19 |
| SwapModule.acceptReject.test.ts | UT-SWAP-ACCEPT-001 to 010, UT-SWAP-REJECT-001 to 005 | 15 |
| SwapModule.deposit.test.ts | UT-SWAP-DEP-001 to 008 | 8 |
| SwapModule.status.test.ts | UT-SWAP-STATUS-001 to 008 | 8 |
| SwapModule.verify.test.ts | UT-SWAP-VERIFY-001 to 009 | 9 |
| SwapModule.cancel.test.ts | UT-SWAP-CANCEL-001 to 007 | 7 |
| SwapModule.dmProcessing.test.ts | UT-SWAP-DM-001 to 012 | 12 |
| SwapModule.invoiceEvents.test.ts | UT-SWAP-INV-001 to 006 + 004a | 7 |
| SwapModule.concurrency.test.ts | UT-SWAP-CONC-001 to 004 | 4 |
| SwapModule.storage.test.ts | UT-SWAP-STORE-001 to 005 | 5 |
| SwapModule.manifest.test.ts | UT-SWAP-MAN-001 to 007 | 7 |
| SwapModule.stateMachine.test.ts | UT-SWAP-SM-001 to 028 + 003a, 010a + unnumbered | 55 |
| SwapModule.validation.test.ts | UT-SWAP-VAL-001 to 020 | 20 |
| SwapModule.errors.test.ts | UT-SWAP-ERR-001 to 015 + 008a, 009a | 17 |
| SwapModule.cli.test.ts | UT-SWAP-CLI-001 to 033 | 33 |
| **Unit Total** | | **237** |
| swap-lifecycle.test.ts (integration) | INT-SWAP-001 to 006 | 6 |
| **Grand Total** | | **243** |

**Note on state machine count:** The stateMachine test file has 55 Vitest `it()` blocks because `UT-SWAP-SM-026` has 9 sub-tests (one per progress value), `UT-SWAP-SM-027` has 11 sub-tests (one per escrow state + unknown), and there are 3 unnumbered terminal transition list assertions plus 4 unnumbered valid transition tests for `depositing->concluding`, `depositing->completed`, `awaiting_counter->completed`, and `awaiting_counter->failed`.

### Method Coverage Matrix

| Method | Happy Path | Validation | Error Paths | Concurrency | Events | Storage |
|--------|-----------|------------|-------------|-------------|--------|---------|
| proposeSwap | PROP-001..006 | VAL-001..020 | PROP-007..018, ERR-002 | CONC-004 | PROP-005 | PROP-006 |
| acceptSwap | ACCEPT-001..005 | -- | ACCEPT-006..010, ERR-003,004,008,009a | CONC-001 | ACCEPT-004,005 | STORE-001 |
| rejectSwap | REJECT-001..003,005 | -- | REJECT-004, ERR-009 | -- | REJECT-003 | -- |
| deposit | DEP-001..004,008 | -- | DEP-005..007, ERR-007 | -- | DEP-004 | DEP-008 |
| getSwapStatus | STATUS-001..002 | -- | STATUS-003, ERR-001,008 | -- | -- | -- |
| getSwaps | STATUS-004..008 | -- | -- | -- | -- | -- |
| verifyPayout | VERIFY-001..005 | -- | VERIFY-006..009 | -- | VERIFY-005 | -- |
| cancelSwap | CANCEL-001..002,005..007 | -- | CANCEL-003,004, ERR-010,011 | CONC-001 | CANCEL-002 | -- |

---

## Appendix B: Error Code Coverage

| Error Code | Test IDs |
|-----------|----------|
| SWAP_NOT_FOUND | ERR-001, ERR-008, ERR-009, STATUS-003, ACCEPT-006, CLI-022, CLI-027 |
| SWAP_INVALID_DEAL | ERR-002, PROP-007..015, VAL-005..006, VAL-009..013, VAL-016..017, VAL-020, CLI-002..005, CLI-031, CLI-033 |
| SWAP_WRONG_STATE | ERR-003, ERR-004, DEP-005, DEP-007, ACCEPT-007, ACCEPT-008, REJECT-004, VERIFY-009, SM-016..025, CLI-023, CLI-029 |
| SWAP_RESOLVE_FAILED | ERR-005, PROP-017, CLI-009 |
| SWAP_DM_SEND_FAILED | ERR-006, PROP-018 |
| SWAP_DEPOSIT_FAILED | ERR-007, DEP-006, CLI-030 |
| SWAP_ALREADY_COMPLETED | ERR-010, CANCEL-003 |
| SWAP_ALREADY_CANCELLED | ERR-011, CANCEL-004 |
| SWAP_LIMIT_EXCEEDED | ERR-012, PROP-016, CLI-032 |
| SWAP_NOT_INITIALIZED | ERR-013, ERR-015, LIFE-010 |
| SWAP_MODULE_DESTROYED | ERR-014, LIFE-011 |

**Implementation note:** The original spec listed `SWAP_ESCROW_REJECTED` (ERR-008) and `SWAP_ESCROW_TIMEOUT` (ERR-009) as thrown errors. The actual implementation handles these as DM-driven state transitions to `failed` rather than thrown `SphereError` instances. Coverage is provided by:
- ERR-008a: escrow error DM transitions accepted swap to `failed`
- ERR-009a: announce retry exhaustion transitions swap to `failed`

The original spec also listed `SWAP_ALREADY_INITIALIZED` (ERR-015). The implementation allows re-initialization without throwing (LIFE-009), so ERR-015 tests `SWAP_NOT_INITIALIZED` on `load()` before `initialize()` instead.

---

## Appendix C: DM Protocol Messages

### C.1 Party-to-Party Messages (v1)

| Type | Direction | Content Format | Payload Fields |
|------|-----------|---------------|---------------|
| `swap_proposal` | Proposer -> Acceptor | `swap_proposal:{JSON}` | `type`, `manifest: SwapManifest`, `escrow: string`, `message?` |
| `swap_acceptance` | Acceptor -> Proposer | `swap_acceptance:{JSON}` | `type`, `swap_id` |
| `swap_rejection` | Acceptor -> Proposer | `swap_rejection:{JSON}` | `type`, `swap_id`, `reason?` |

### C.2 Party-to-Party Messages (v2 additions)

| Type | Direction | Content Format | Additional Payload Fields |
|------|-----------|---------------|--------------------------|
| `swap_proposal` (v2) | Proposer -> Acceptor | `swap_proposal:{JSON}` | `proposer_signature`, `proposer_chain_pubkey` (added to v1 fields) |
| `swap_acceptance` (v2) | Acceptor -> Proposer | `swap_acceptance:{JSON}` | `acceptor_signature`, `acceptor_chain_pubkey` (added to v1 fields) |

v2 proposals include the proposer's secp256k1 signature over the manifest fields and their chain pubkey. v2 acceptances include the acceptor's signature over `swap_consent:{swap_id}:{escrow_address}`.

### C.3 Client-to-Escrow Messages

| Type | Direction | Content Format | Payload Fields |
|------|-----------|---------------|---------------|
| `announce` | Client -> Escrow | Pure JSON | `type`, `manifest: SwapManifest` |
| `announce` (v2) | Acceptor -> Escrow | Pure JSON | `type`, `manifest`, `signatures: { party_a, party_b }`, `chain_pubkeys: { party_a, party_b }` |
| `status` | Client -> Escrow | Pure JSON | `type`, `swap_id` |

In v2, the acceptor announces directly to the escrow (instead of the proposer relaying). The announce includes both parties' signatures and chain pubkeys.

### C.4 Escrow-to-Client Messages

| Type | Direction | Content Format | Payload Fields |
|------|-----------|---------------|---------------|
| `announce_result` | Escrow -> Client | Pure JSON | `type`, `swap_id`, `deposit_invoice_id`, `state`, `created_at`, `is_new` |
| `invoice_delivery` | Escrow -> Client | Pure JSON | `type`, `swap_id`, `invoice_type: 'deposit'\|'payout'`, `invoice_id`, `invoice_token`, `payment_instructions?` |
| `payment_confirmation` | Escrow -> Both | Pure JSON | `type`, `swap_id`, `party?` |
| `swap_cancelled` | Escrow -> Both | Pure JSON | `type`, `swap_id`, `reason`, `deposits_returned` |
| `bounce_notification` | Escrow -> Sender | Pure JSON | `type`, `swap_id`, `reason`, `returned_amount`, `returned_currency` |
| `status_result` | Escrow -> Client | Pure JSON | `type`, `swap_id`, `state` |
| `error` | Escrow -> Client | Pure JSON | `type`, `error`, `swap_id?` |

### C.5 DM Content Format

Party-to-party swap DMs use a type-prefixed format:
```
swap_proposal:{"type":"swap_proposal","manifest":{...},"escrow":"DIRECT://eee..."}
```

Escrow messages use pure JSON (no prefix):
```
{"type":"announce_result","swap_id":"abc...","deposit_invoice_id":"..."}
```

The DM handler splits on the first `:` to extract the type prefix, then JSON-parses the remainder. If the content starts with `{`, it is parsed as pure JSON (escrow messages). This dual parsing handles both party-to-party and escrow message formats.

### C.6 Escrow DM Authentication

Escrow messages are only processed when `senderPubkey` matches the stored `escrowPubkey` for the swap. This prevents spoofed escrow messages from unauthorized senders (tested by UT-SWAP-DM-011).
