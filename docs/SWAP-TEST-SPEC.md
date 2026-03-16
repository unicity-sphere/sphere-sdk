# SwapModule Test Suite Specification

> **Status:** Specification document (no code) for comprehensive test coverage of SwapModule
> **Framework:** Vitest
> **Target Files:** `tests/unit/modules/SwapModule.*.test.ts`, `tests/integration/swap-lifecycle.test.ts`, `tests/scripts/test-e2e-swap.ts`
> **Scope:** Unit tests covering all 8 public API methods, DM protocol processing, invoice event subscriptions, state machine transitions, manifest construction, concurrency, storage, and validation. Integration and E2E test outlines included.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Test Infrastructure](#2-test-infrastructure)
3. [Unit Tests](#3-unit-tests)
4. [Integration Tests](#4-integration-tests)
5. [E2E Tests](#5-e2e-tests)
6. [Cross-Cutting Concerns](#6-cross-cutting-concerns)
7. [Appendix A: Test Matrix](#appendix-a-test-matrix)
8. [Appendix B: Error Code Coverage](#appendix-b-error-code-coverage)
9. [Appendix C: DM Protocol Messages](#appendix-c-dm-protocol-messages)

---

## 1. Overview

### Purpose

Validate SwapModule -- the client-side counterpart to the escrow service -- through three test categories:

1. **Unit Tests** -- Individual methods, state transitions, DM processing, validation, error paths
2. **Integration Tests** -- Full swap workflows with mock escrow DM responses (no real escrow)
3. **E2E Tests** -- Two real Sphere wallets + escrow service on testnet (future)

### Architecture Context

SwapModule runs inside each party's wallet and coordinates atomic token swaps via an escrow service. The module:

- Builds a `SwapManifest` from a `SwapDeal` (human-readable proposal)
- Computes a deterministic `swap_id` via JCS (RFC 8785) canonicalization + SHA-256
- Exchanges `swap_proposal` / `swap_acceptance` / `swap_rejection` DMs between parties
- Announces the swap to the escrow service, which creates a deposit invoice
- Deposits tokens via `AccountingModule.payInvoice()`
- Receives payout invoice from escrow after both deposits land
- Verifies payout via `AccountingModule.getInvoiceStatus()`
- Tracks local swap state (`SwapRef`) persisted to `StorageProvider`

The escrow service (server-side) uses its own `SwapOrchestrator` with states: `ANNOUNCED -> DEPOSIT_INVOICE_CREATED -> PARTIAL_DEPOSIT -> DEPOSIT_COVERED -> CONCLUDING -> COMPLETED`. The client-side SwapModule maps escrow states to a local `SwapProgress` enum for UI rendering.

### Scope

- **Methods tested:** All 8 public methods (`proposeSwap`, `acceptSwap`, `rejectSwap`, `deposit`, `getSwapStatus`, `getSwaps`, `verifyPayout`, `cancelSwap`)
- **Error codes:** All 15 error codes (SWAP_NOT_FOUND through SWAP_ESCROW_REJECTED)
- **State machine:** All local progress transitions (proposed -> accepted -> announced -> depositing -> awaiting_counter -> concluding -> completed / cancelled / failed)
- **DM protocol:** All 9 message types (swap_proposal, swap_acceptance, swap_rejection, announce_result, invoice_delivery, payment_confirmation, swap_cancelled, bounce_notification, status)
- **Events:** All 12 event types (swap:proposed through swap:failed)
- **Storage:** Persisted swap records, dirty-write on destroy, terminal purge
- **Manifest:** JCS canonicalization, deterministic swap_id, field validation
- **Concurrency:** Per-swap async mutex, parallel operations on different swaps

### Test Framework

**Vitest** with the following patterns:
- `describe()` for test suites
- `it()` for individual tests
- `beforeEach()` for setup, `afterEach()` for cleanup
- Mock factories for all dependencies (MockAccountingModule, MockCommunicationsModule, MockStorageProvider, MockTransportProvider, mock event emitter)
- Test fixtures (sample swap deals, manifests, DM payloads)

### Test ID Convention

All test IDs follow the format `UT-SWAP-{CONCERN}-{NNN}` where:
- `CONCERN` is a short mnemonic (LIFE, PROP, ACCEPT, DEP, STATUS, VERIFY, CANCEL, DM, INV, CONC, STORE, MAN, SM, VAL, ERR)
- `NNN` is a zero-padded three-digit number

---

## 2. Test Infrastructure

### 2.1 Mock Factories

Each mock implements the full interface of its target to avoid partial stub issues.

#### MockAccountingModule

```typescript
// Returns a mock with:
// - createInvoice(request): Promise<CreateInvoiceResult>
// - importInvoice(token): Promise<InvoiceTerms>
// - getInvoice(invoiceId): InvoiceRef | null
// - getInvoiceStatus(invoiceId): Promise<InvoiceStatus>
// - payInvoice(invoiceId, params): Promise<TransferResult>
// - closeInvoice(invoiceId, opts?): Promise<void>
// - cancelInvoice(invoiceId, opts?): Promise<void>
// - on(event, handler): () => void (unsubscribe)
// --- Test helpers ---
// - _emit(event, data): void
// - _invoices: Map<string, InvoiceRef>
// - _statuses: Map<string, InvoiceStatus>
// - _payResult: TransferResult (mutable)
```

#### MockCommunicationsModule

```typescript
// Returns a mock with:
// - sendDM(recipient, content): Promise<DirectMessage>
// - getConversation(peer): DirectMessage[]
// - on(event, handler): () => void (unsubscribe)
// - onDirectMessage(handler): () => void (unsubscribe)
// --- Test helpers ---
// - _sentDMs: Array<{ recipient: string; content: string }>
// - _dmHandlers: Array<(message: DirectMessage) => void>
// - _emit(event, data): void
```

#### MockTransportProvider

```typescript
// Returns a mock with:
// - resolve(identifier): Promise<PeerInfo | null>
// --- Test helpers ---
// - _peers: Map<string, PeerInfo>
```

#### MockStorageProvider

```typescript
// Returns a mock with (matches StorageProvider interface):
// - get(key): Promise<string | null>
// - set(key, value): Promise<void>
// - remove(key): Promise<void>
// - has(key): Promise<boolean>
// - keys(prefix?): Promise<string[]>
// - clear(prefix?): Promise<void>
// (all operations backed by Map<string, string>)
// --- Test helpers ---
// - _data: Map<string, string>
```

#### MockEventEmitter

```typescript
// Returns a mock with:
// - emitEvent(type, data): void (vi.fn())
// - on(type, handler): () => void
// --- Test helpers ---
// - _handlers: Map<string, Array<(data: unknown) => void>>
// - _calls: Array<[string, unknown]>
```

### 2.2 Test Fixtures

#### Sample Swap Deals

- **Simple UCT-USDU swap:** Party A sends 1000000 UCT, Party B sends 500000 USDU, timeout 300s
- **Same-currency (rejected):** Both parties sending UCT -- must fail validation
- **Nametag addresses:** `@alice` and `@bob` -- resolved via transport
- **DIRECT:// addresses:** No resolution needed
- **Minimal timeout:** 60 seconds (minimum allowed)
- **Maximum timeout:** 86400 seconds (maximum allowed)

#### Sample Manifests

- **Valid manifest:** All fields present, swap_id computed correctly
- **Manifest from nametag deal:** Addresses resolved to DIRECT://
- **Manifest with different field ordering:** Same swap_id (JCS canonicalization)

#### Sample DM Payloads

- **swap_proposal:** `{ type: 'swap_proposal', version: 1, manifest: SwapManifest, escrow: string, message? }`
- **swap_acceptance:** `{ type: 'swap_acceptance', version: 1, swap_id }`
- **swap_rejection:** `{ type: 'swap_rejection', version: 1, swap_id, reason? }`
- **announce_result:** `{ type: 'announce_result', swap_id, deposit_invoice_id, state, created_at, is_new }`
- **invoice_delivery:** `{ type: 'invoice_delivery', swap_id, invoice_type: 'deposit'|'payout', invoice_id, invoice_token: TxfToken, payment_instructions? }`
- **payment_confirmation:** `{ type: 'payment_confirmation', swap_id, currency, amount, payout_invoice_id }`
- **swap_cancelled:** `{ type: 'swap_cancelled', swap_id, reason: 'timeout', deposits_returned }`
- **bounce_notification:** `{ type: 'bounce_notification', swap_id, reason: 'WRONG_CURRENCY'|'ALREADY_COVERED', returned_amount, returned_currency }`
- **status:** `{ type: 'status', swap_id }`

### 2.3 Helper Utilities

#### `createTestSwapModule(overrides?)`

Creates a fully-configured SwapModule with mock dependencies. Calls `initialize()` with all mock deps but does NOT call `load()` -- tests that need loaded state should call `await module.load()` explicitly.

```typescript
function createTestSwapModule(overrides?: {
  config?: Partial<SwapModuleConfig>;
  accounting?: MockAccountingModule;
  communications?: MockCommunicationsModule;
  transport?: MockTransportProvider;
  storage?: MockStorageProvider;
  identity?: FullIdentity;
}): {
  module: SwapModule;
  mocks: TestSwapModuleMocks;
}
```

Returns the SwapModule instance and all mock dependencies.

#### `createTestSwapDeal(overrides?)`

Returns a minimal valid `SwapDeal` with sensible defaults.

```typescript
function createTestSwapDeal(overrides?: Partial<SwapDeal>): SwapDeal {
  return {
    partyA: 'DIRECT://aaa...',
    partyB: 'DIRECT://bbb...',
    partyACurrency: 'UCT',
    partyAAmount: '1000000',
    partyBCurrency: 'USDU',
    partyBAmount: '500000',
    escrowAddress: 'DIRECT://eee...',
    timeout: 300,
    ...overrides,
  };
}
```

#### `createTestManifest(deal?)`

Builds a `SwapManifest` from a deal (or default deal), computing `swap_id` deterministically.

```typescript
function createTestManifest(deal?: SwapDeal): SwapManifest {
  const d = deal ?? createTestSwapDeal();
  const fields = {
    party_a_address: d.partyA,
    party_b_address: d.partyB,
    party_a_currency_to_change: d.partyACurrency,
    party_a_value_to_change: d.partyAAmount,
    party_b_currency_to_change: d.partyBCurrency,
    party_b_value_to_change: d.partyBAmount,
    timeout: d.timeout,
  };
  const swap_id = computeSwapId(fields);
  return { swap_id, ...fields };
}
```

#### `createMockInvoiceDeliveryDM(swapId, invoiceType)`

Creates a `DirectMessage` containing an `invoice_delivery` payload with a mock TxfToken.

#### `createMockAnnounceResultDM(swapId, depositInvoiceId?)`

Creates a `DirectMessage` containing an `announce_result` payload.

#### `DEFAULT_TEST_PARTY_A`

```typescript
const DEFAULT_TEST_PARTY_A: FullIdentity = {
  chainPubkey: '02' + 'a'.repeat(64),
  l1Address: 'alpha1partyaaddr',
  directAddress: 'DIRECT://party_a_address_aaa',
  privateKey: 'aa'.repeat(32),
};
```

#### `DEFAULT_TEST_PARTY_B`

```typescript
const DEFAULT_TEST_PARTY_B: FullIdentity = {
  chainPubkey: '02' + 'b'.repeat(64),
  l1Address: 'alpha1partybaddr',
  directAddress: 'DIRECT://party_b_address_bbb',
  privateKey: 'bb'.repeat(32),
};
```

#### `DEFAULT_TEST_ESCROW`

```typescript
const DEFAULT_TEST_ESCROW = 'DIRECT://escrow_address_eee';
```

#### `advanceTime(ms)`

Mocks `Date.now()` to return a value advanced by `ms` milliseconds.

---

## 3. Unit Tests

### 3.1 Module Lifecycle

**File:** `tests/unit/modules/SwapModule.lifecycle.test.ts`

#### UT-SWAP-LIFE-001: constructor accepts config, sets defaults

- **Preconditions:** None
- **Action:** `createSwapModule({ maxPendingSwaps: 5 })`
- **Expected:** Module created; `maxPendingSwaps` is 5; default `announceTimeoutMs` is 30000; default `terminalPurgeTtlMs` is 7 days
- **Note:** `announceTimeoutMs` and `terminalPurgeTtlMs` are not yet in SWAP-SPEC's SwapModuleConfig (section 18). They should be added to the spec as optional config fields.
- **Assertions:** Config values accessible via internal state inspection

#### UT-SWAP-LIFE-002: initialize() stores deps reference

- **Preconditions:** Fresh module
- **Action:** Call `initialize(deps)` with mock dependencies
- **Expected:** Dependencies stored; module ready for `load()`; no errors thrown
- **Assertions:** `module.initialize(deps)` does not throw; deps reference stored internally

#### UT-SWAP-LIFE-003: load() loads persisted swap records from storage

- **Preconditions:** Storage contains 3 serialized SwapRef records (1 active, 1 completed, 1 cancelled)
- **Action:** Call `load()`
- **Expected:** Active swap loaded into memory; terminal swaps loaded or purged based on TTL; storage.keys() called with swap prefix
- **Assertions:** `getSwaps()` returns the active swap; terminal swaps handled per TTL

#### UT-SWAP-LIFE-004: load() registers DM handler for swap messages

- **Preconditions:** Module with mock CommunicationsModule
- **Action:** Call `load()`
- **Expected:** `communications.onDirectMessage()` called once; handler registered for swap DM processing
- **Assertions:** `mocks.communications.onDirectMessage` called with function argument

#### UT-SWAP-LIFE-005: load() subscribes to invoice events

- **Preconditions:** Module with mock AccountingModule
- **Action:** Call `load()`
- **Expected:** Subscribes to `invoice:payment`, `invoice:covered`, `invoice:created`, `invoice:return_received` events via `accounting.on()`
- **Assertions:** `mocks.accounting.on` called for each event type

#### UT-SWAP-LIFE-006: destroy() unsubscribes all handlers

- **Preconditions:** Module loaded with active subscriptions
- **Action:** Track unsubscribe functions returned by `on()` calls, then call `destroy()`
- **Expected:** All unsubscribe handles called; DM handler unsubscribed; invoice event handlers unsubscribed
- **Assertions:** Every unsubscribe function mock called exactly once

#### UT-SWAP-LIFE-007: destroy() persists dirty swap records

- **Preconditions:** Module loaded with 1 active swap that has been modified since last persist
- **Action:** Call `destroy()`
- **Expected:** `storage.set()` called for the dirty swap record; serialized JSON contains current progress
- **Assertions:** `mocks.storage.set` called with swap storage key and valid JSON

#### UT-SWAP-LIFE-008: destroy() clears local timers

- **Preconditions:** Module loaded with active announce-timeout timer
- **Action:** Call `destroy()`
- **Expected:** Timer cleared; no pending timeouts after destroy
- **Assertions:** No errors from orphaned timers; module state is destroyed

#### UT-SWAP-LIFE-009: double-initialize throws

- **Preconditions:** Module already initialized
- **Action:** Call `initialize(deps)` again
- **Expected:** Throws SphereError with code SWAP_ALREADY_INITIALIZED
- **Assertions:** Error thrown with correct code

#### UT-SWAP-LIFE-010: operations before initialize throw NOT_INITIALIZED

- **Preconditions:** Fresh module, not yet initialized
- **Action:** Call `proposeSwap()`, `acceptSwap()`, `getSwaps()`, etc.
- **Expected:** Each throws SphereError with code SWAP_NOT_INITIALIZED
- **Assertions:** All public methods reject with SWAP_NOT_INITIALIZED

#### UT-SWAP-LIFE-011: operations after destroy throw SWAP_MODULE_DESTROYED

- **Preconditions:** Module loaded then destroyed
- **Action:** Call `proposeSwap()`, `acceptSwap()`, `deposit()`, `getSwapStatus()`, `getSwaps()`, `verifyPayout()`, `cancelSwap()`, `rejectSwap()`
- **Expected:** Each throws SphereError with code SWAP_MODULE_DESTROYED
- **Assertions:** All public methods reject with SWAP_MODULE_DESTROYED

---

### 3.2 proposeSwap()

**File:** `tests/unit/modules/SwapModule.proposeSwap.test.ts`

#### UT-SWAP-PROP-001: valid deal creates SwapProposal with correct swap_id

- **Preconditions:** Module loaded, transport resolves both addresses
- **Action:** `proposeSwap(deal)` with valid SwapDeal
- **Expected:** Returns SwapProposal with 64-hex swap_id; local SwapRef created with progress='proposed'
- **Assertions:** `result.swapId` is 64-char hex; `getSwaps()` contains the swap

#### UT-SWAP-PROP-002: swap_id is deterministic (same deal produces same ID)

- **Preconditions:** Module loaded
- **Action:** Call `computeSwapId()` twice with identical deal fields
- **Expected:** Both calls return the same 64-hex string
- **Assertions:** `id1 === id2`

#### UT-SWAP-PROP-003: resolves @nametag addresses via transport.resolve()

- **Preconditions:** Module loaded; transport mock resolves '@alice' -> DIRECT://aaa, '@bob' -> DIRECT://bbb
- **Action:** `proposeSwap({ partyA: '@alice', partyB: '@bob', ... })`
- **Expected:** Transport `resolve()` called twice; manifest contains DIRECT:// addresses
- **Assertions:** `mocks.transport.resolve` called with '@alice' and '@bob'

#### UT-SWAP-PROP-004: sends swap_proposal DM to counterparty

- **Preconditions:** Module loaded as party A (identity matches partyA address)
- **Action:** `proposeSwap(deal)`
- **Expected:** `communications.sendDM()` called once with party B address; DM content is JSON with `type: 'swap_proposal'`
- **Assertions:** `mocks.communications._sentDMs[0].recipient` equals party B address; parsed content has correct type and swap_id

#### UT-SWAP-PROP-005: emits swap:proposed event

- **Preconditions:** Module loaded
- **Action:** `proposeSwap(deal)`
- **Expected:** `emitEvent` called with `'swap:proposed'` and payload containing `{ swapId, deal, role: 'proposer' }`
- **Assertions:** `emitEvent` called with matching event name and payload shape

#### UT-SWAP-PROP-006: persists SwapRef with progress='proposed', role='proposer'

- **Preconditions:** Module loaded
- **Action:** `proposeSwap(deal)`
- **Expected:** `storage.set()` called with serialized SwapRef; ref has progress='proposed', role='proposer', createdAt set
- **Assertions:** Storage mock contains valid JSON at swap key; parsed ref matches expected shape

#### UT-SWAP-PROP-007: rejects empty partyA address (SWAP_INVALID_DEAL)

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ partyA: '', ... })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions address

#### UT-SWAP-PROP-008: rejects empty partyB address

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., partyB: '' })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL

#### UT-SWAP-PROP-009: rejects same partyA and partyB address

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ partyA: 'DIRECT://same', partyB: 'DIRECT://same', ... })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions self-swap

#### UT-SWAP-PROP-010: rejects non-positive amount (partyA)

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., partyAAmount: '-100' })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions amount

#### UT-SWAP-PROP-011: rejects zero amount (partyB)

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., partyBAmount: '0' })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL

#### UT-SWAP-PROP-012: rejects same currency for both parties

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., partyACurrency: 'UCT', partyBCurrency: 'UCT' })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions same currency

#### UT-SWAP-PROP-013: rejects timeout less than 60 seconds

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., timeout: 59 })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions timeout range

#### UT-SWAP-PROP-014: rejects timeout greater than 86400 seconds

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., timeout: 86401 })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions timeout range

#### UT-SWAP-PROP-015: rejects empty escrowAddress

- **Preconditions:** Module loaded
- **Action:** `proposeSwap({ ..., escrowAddress: '' })`
- **Expected:** Throws SphereError with code SWAP_INVALID_DEAL
- **Assertions:** Error code is SWAP_INVALID_DEAL; message mentions escrow

#### UT-SWAP-PROP-016: rejects if maxPendingSwaps exceeded

- **Preconditions:** Module loaded with config `{ maxPendingSwaps: 2 }`; 2 active swaps already in state
- **Action:** `proposeSwap(newDeal)`
- **Expected:** Throws SphereError with code SWAP_LIMIT_EXCEEDED
- **Assertions:** Error code is SWAP_LIMIT_EXCEEDED

#### UT-SWAP-PROP-017: address resolution failure throws SWAP_RESOLVE_FAILED

- **Preconditions:** Module loaded; transport.resolve('@bob') returns null
- **Action:** `proposeSwap({ ..., partyB: '@bob' })`
- **Expected:** Throws SphereError with code SWAP_RESOLVE_FAILED
- **Assertions:** Error code is SWAP_RESOLVE_FAILED; message mentions unresolvable address

#### UT-SWAP-PROP-018: DM send failure throws SWAP_DM_SEND_FAILED

- **Preconditions:** Module loaded; communications.sendDM() rejects
- **Action:** `proposeSwap(deal)`
- **Expected:** Throws SphereError with code SWAP_DM_SEND_FAILED
- **Assertions:** Error code is SWAP_DM_SEND_FAILED

#### UT-SWAP-PROP-019: duplicate swap_id (same deal proposed twice) is idempotent

- **Preconditions:** Module loaded; same deal already proposed (SwapRef exists)
- **Action:** `proposeSwap(sameDeal)` again
- **Expected:** Returns existing SwapProposal; no duplicate SwapRef created; no duplicate DM sent
- **Assertions:** `getSwaps()` still returns 1 swap; `communications.sendDM` not called again (or called with same content)

---

### 3.3 acceptSwap() and rejectSwap()

**File:** `tests/unit/modules/SwapModule.acceptReject.test.ts`

#### UT-SWAP-ACCEPT-001: acceptSwap sends swap_acceptance DM

- **Preconditions:** Module loaded with incoming swap proposal (role='acceptor', progress='proposed')
- **Action:** `acceptSwap(swapId)`
- **Expected:** `communications.sendDM()` called with proposer address; content is JSON with `type: 'swap_acceptance'`
- **Assertions:** DM sent with correct type and swap_id

#### UT-SWAP-ACCEPT-002: acceptSwap announces to escrow

- **Preconditions:** Module loaded with accepted swap
- **Action:** `acceptSwap(swapId)` triggers escrow announcement via DM to escrow address
- **Expected:** `communications.sendDM()` called with escrow address; content contains swap manifest
- **Assertions:** DM sent to escrow address; content includes full manifest fields

#### UT-SWAP-ACCEPT-003: acceptSwap imports deposit invoice from escrow response

- **Preconditions:** Module loaded; escrow replies with `announce_result` DM containing `deposit_invoice_id`
- **Action:** `acceptSwap(swapId)` completes; escrow DM delivered via mock
- **Expected:** `accounting.importInvoice()` called with deposit invoice token from subsequent `invoice_delivery` DM
- **Assertions:** `mocks.accounting.importInvoice` called once

#### UT-SWAP-ACCEPT-004: acceptSwap transitions to 'announced'

- **Preconditions:** Module loaded with proposal
- **Action:** `acceptSwap(swapId)` + escrow acknowledge_result DM arrives
- **Expected:** SwapRef progress transitions from 'proposed' -> 'accepted' -> 'announced'
- **Assertions:** `getSwapStatus(swapId).progress` equals 'announced'

#### UT-SWAP-ACCEPT-005: acceptSwap emits swap:accepted and swap:announced

- **Preconditions:** Module loaded with proposal
- **Action:** `acceptSwap(swapId)` + escrow response arrives
- **Expected:** `emitEvent` called with `'swap:accepted'` then `'swap:announced'`
- **Assertions:** Both events emitted in order with correct swapId

#### UT-SWAP-ACCEPT-006: acceptSwap on non-existent swap throws SWAP_NOT_FOUND

- **Preconditions:** Module loaded, no swaps
- **Action:** `acceptSwap('nonexistent')`
- **Expected:** Throws SphereError with code SWAP_NOT_FOUND
- **Assertions:** Error code is SWAP_NOT_FOUND

#### UT-SWAP-ACCEPT-007: acceptSwap on wrong state throws SWAP_WRONG_STATE

- **Preconditions:** Module loaded; swap in 'depositing' state
- **Action:** `acceptSwap(swapId)`
- **Expected:** Throws SphereError with code SWAP_WRONG_STATE
- **Assertions:** Error code is SWAP_WRONG_STATE; message mentions current state

#### UT-SWAP-ACCEPT-008: acceptSwap on proposer's own swap throws SWAP_WRONG_STATE

- **Preconditions:** Module loaded; swap with role='proposer'
- **Action:** `acceptSwap(swapId)`
- **Expected:** Throws SphereError with code SWAP_WRONG_STATE
- **Assertions:** Error code is SWAP_WRONG_STATE; message contains "you are the proposer, not the acceptor"

#### UT-SWAP-ACCEPT-009: escrow rejection in announce_result throws SWAP_ESCROW_REJECTED

- **Preconditions:** Module loaded; escrow responds with `announce_result` containing `error: 'INVALID_MANIFEST'`
- **Action:** `acceptSwap(swapId)` and escrow error DM arrives
- **Expected:** Throws or transitions to 'failed' with SWAP_ESCROW_REJECTED
- **Assertions:** Swap progress is 'failed'; error stored in SwapRef

#### UT-SWAP-ACCEPT-010: DM timeout (no announce_result) throws SWAP_ESCROW_TIMEOUT

- **Preconditions:** Module loaded; escrow does not reply within `announceTimeoutMs`
- **Action:** `acceptSwap(swapId)`; advance time past announceTimeoutMs
- **Expected:** Promise rejects with SWAP_ESCROW_TIMEOUT or swap transitions to 'failed'
- **Assertions:** Swap marked as failed with timeout reason

#### UT-SWAP-REJECT-001: rejectSwap sends swap_rejection DM

- **Preconditions:** Module loaded with incoming proposal (role='acceptor', progress='proposed')
- **Action:** `rejectSwap(swapId)`
- **Expected:** `communications.sendDM()` called with proposer address; content has `type: 'swap_rejection'`
- **Assertions:** DM sent with correct swap_id

#### UT-SWAP-REJECT-002: rejectSwap removes swap from local store

- **Preconditions:** Module loaded with proposal
- **Action:** `rejectSwap(swapId)`
- **Expected:** `storage.remove()` called for swap key; `getSwaps()` no longer includes this swap
- **Assertions:** Swap removed from both in-memory and persistent state

#### UT-SWAP-REJECT-003: rejectSwap emits swap:rejected

- **Preconditions:** Module loaded with proposal
- **Action:** `rejectSwap(swapId)`
- **Expected:** `emitEvent` called with `'swap:rejected'` and `{ swapId, role: 'acceptor' }`
- **Assertions:** Event emitted with correct payload

#### UT-SWAP-REJECT-004: rejectSwap on wrong state throws SWAP_WRONG_STATE

- **Preconditions:** Module loaded; swap already in 'announced' state
- **Action:** `rejectSwap(swapId)`
- **Expected:** Throws SphereError with code SWAP_WRONG_STATE
- **Assertions:** Error code is SWAP_WRONG_STATE

#### UT-SWAP-REJECT-005: rejectSwap with reason includes reason in DM

- **Preconditions:** Module loaded with proposal
- **Action:** `rejectSwap(swapId, { reason: 'Price too high' })`
- **Expected:** DM content includes `reason: 'Price too high'`
- **Assertions:** Parsed DM content has reason field

---

### 3.4 deposit()

**File:** `tests/unit/modules/SwapModule.deposit.test.ts`

#### UT-SWAP-DEP-001: deposit calls accounting.payInvoice with correct params for party A

- **Preconditions:** Module loaded; swap in 'announced' state; identity matches party A; depositInvoiceId set
- **Action:** `deposit(swapId)`
- **Expected:** `accounting.payInvoice()` called with `depositInvoiceId` and correct target/asset params for party A's currency slot (index 0)
- **Assertions:** `mocks.accounting.payInvoice` called with invoiceId = depositInvoiceId; params include party A's coinId and amount

#### UT-SWAP-DEP-002: deposit calls accounting.payInvoice with correct params for party B

- **Preconditions:** Module loaded; swap in 'announced' state; identity matches party B; depositInvoiceId set
- **Action:** `deposit(swapId)`
- **Expected:** `accounting.payInvoice()` called with correct target/asset params for party B's currency slot (index 1)
- **Assertions:** Params include party B's coinId and amount

#### UT-SWAP-DEP-003: deposit transitions to 'depositing'

- **Preconditions:** Module loaded; swap announced
- **Action:** `deposit(swapId)`
- **Expected:** SwapRef progress becomes 'depositing' immediately upon call; becomes 'awaiting_counter' after payInvoice resolves
- **Assertions:** Progress is 'depositing' during execution; 'awaiting_counter' after completion

#### UT-SWAP-DEP-004: deposit emits swap:deposit_sent with TransferResult

- **Preconditions:** Module loaded; swap announced
- **Action:** `deposit(swapId)`
- **Expected:** `emitEvent` called with `'swap:deposit_sent'` and `{ swapId, transferResult }`
- **Assertions:** Event payload contains TransferResult from payInvoice

#### UT-SWAP-DEP-005: deposit on wrong state throws SWAP_WRONG_STATE

- **Preconditions:** Module loaded; swap in 'proposed' state (not yet announced)
- **Action:** `deposit(swapId)`
- **Expected:** Throws SphereError with code SWAP_WRONG_STATE
- **Assertions:** Error code is SWAP_WRONG_STATE

#### UT-SWAP-DEP-006: deposit failure (payInvoice throws) throws SWAP_DEPOSIT_FAILED

- **Preconditions:** Module loaded; `accounting.payInvoice()` rejects with error
- **Action:** `deposit(swapId)`
- **Expected:** Throws SphereError with code SWAP_DEPOSIT_FAILED; original error preserved as cause
- **Assertions:** Error code is SWAP_DEPOSIT_FAILED; `error.cause` is the payInvoice error

#### UT-SWAP-DEP-007: deposit with no depositInvoiceId throws SWAP_WRONG_STATE

- **Preconditions:** Module loaded; swap announced but no deposit invoice received yet
- **Action:** `deposit(swapId)`
- **Expected:** Throws SphereError with code SWAP_WRONG_STATE
- **Assertions:** Error message mentions missing deposit invoice

#### UT-SWAP-DEP-008: successful deposit persists localDepositTransferId

- **Preconditions:** Module loaded; payInvoice returns result with id='tx-123'
- **Action:** `deposit(swapId)`
- **Expected:** SwapRef updated with `localDepositTransferId: 'tx-123'`; persisted to storage
- **Assertions:** `getSwapStatus(swapId).localDepositTransferId` equals 'tx-123'

---

### 3.5 getSwapStatus() and getSwaps()

**File:** `tests/unit/modules/SwapModule.status.test.ts`

#### UT-SWAP-STATUS-001: getSwapStatus returns local SwapRef

- **Preconditions:** Module loaded with 1 active swap
- **Action:** `getSwapStatus(swapId)`
- **Expected:** Returns SwapStatus with swapId, progress, role, deal, createdAt, and other fields
- **Assertions:** All expected fields present and match stored SwapRef

#### UT-SWAP-STATUS-002: getSwapStatus optionally queries escrow via DM

- **Preconditions:** Module loaded with swap in 'awaiting_counter' state
- **Action:** `getSwapStatus(swapId, { queryEscrow: true })`
- **Expected:** Sends `status` DM to escrow; waits for response; merges escrow state into local
- **Assertions:** `communications.sendDM()` called with escrow address

#### UT-SWAP-STATUS-003: getSwapStatus merges escrow response into local state

- **Preconditions:** Module loaded; escrow responds with state 'CONCLUDING'
- **Action:** `getSwapStatus(swapId, { queryEscrow: true })` + mock escrow reply
- **Expected:** Local progress updated to 'concluding'; escrow state stored in SwapRef
- **Assertions:** `result.progress` equals 'concluding'

#### UT-SWAP-STATUS-004: getSwapStatus on non-existent swap throws SWAP_NOT_FOUND

- **Preconditions:** Module loaded, no swaps
- **Action:** `getSwapStatus('nonexistent')`
- **Expected:** Throws SphereError with code SWAP_NOT_FOUND
- **Assertions:** Error code is SWAP_NOT_FOUND

#### UT-SWAP-STATUS-005: getSwaps returns all tracked swaps

- **Preconditions:** Module loaded with 3 swaps (1 proposed, 1 awaiting_counter, 1 completed)
- **Action:** `getSwaps()`
- **Expected:** Returns array of 3 SwapRef objects
- **Assertions:** Array length is 3

#### UT-SWAP-STATUS-006: getSwaps with progress filter

- **Preconditions:** Module loaded with 3 swaps
- **Action:** `getSwaps({ progress: 'proposed' })`
- **Expected:** Returns only swaps with progress='proposed'
- **Assertions:** Array length is 1; all items have progress='proposed'

#### UT-SWAP-STATUS-007: getSwaps with role filter

- **Preconditions:** Module loaded with 2 swaps (1 proposer, 1 acceptor)
- **Action:** `getSwaps({ role: 'acceptor' })`
- **Expected:** Returns only swaps with role='acceptor'
- **Assertions:** Array length is 1; item has role='acceptor'

#### UT-SWAP-STATUS-008: getSwaps returns empty array when no swaps

- **Preconditions:** Module loaded, empty state
- **Action:** `getSwaps()`
- **Expected:** Returns `[]`
- **Assertions:** Array length is 0

---

### 3.6 verifyPayout()

**File:** `tests/unit/modules/SwapModule.verify.test.ts`

#### UT-SWAP-VERIFY-001: verifyPayout checks invoice status isCovered

- **Preconditions:** Module loaded; swap in 'concluding' state with payoutInvoiceId; accounting.getInvoiceStatus returns COVERED
- **Action:** `verifyPayout(swapId)`
- **Expected:** Returns `true`; accounting.getInvoiceStatus called with payoutInvoiceId
- **Assertions:** `mocks.accounting.getInvoiceStatus` called; result is `true`

#### UT-SWAP-VERIFY-002: verifyPayout checks correct counter-currency

- **Preconditions:** Party A proposed UCT-for-USDU swap; payout invoice should contain USDU
- **Action:** `verifyPayout(swapId)` -- inspects payout invoice status for USDU
- **Expected:** Verification checks that payout targets contain the expected counter-currency
- **Assertions:** Invoice status targets inspected for correct coinId

#### UT-SWAP-VERIFY-003: verifyPayout checks correct amount

- **Preconditions:** Party A expects 500000 USDU in payout
- **Action:** `verifyPayout(swapId)` -- inspects payout invoice amounts
- **Expected:** Verification confirms payout amount matches expected counter-party value
- **Assertions:** Payout amount matches `deal.partyBAmount` (what party A receives)

#### UT-SWAP-VERIFY-004: verifyPayout transitions to 'completed' on success

- **Preconditions:** Module loaded; payout invoice verified successfully
- **Action:** `verifyPayout(swapId)`
- **Expected:** SwapRef progress becomes 'completed'
- **Assertions:** `getSwapStatus(swapId).progress` equals 'completed'

#### UT-SWAP-VERIFY-005: verifyPayout emits swap:completed

- **Preconditions:** Module loaded; verification succeeds
- **Action:** `verifyPayout(swapId)`
- **Expected:** `emitEvent` called with `'swap:completed'` and `{ swapId }`
- **Assertions:** Event emitted

#### UT-SWAP-VERIFY-006: verifyPayout returns false if not yet covered

- **Preconditions:** Module loaded; accounting.getInvoiceStatus returns OPEN
- **Action:** `verifyPayout(swapId)`
- **Expected:** Returns `false`; progress unchanged
- **Assertions:** result is `false`; progress still 'concluding'

#### UT-SWAP-VERIFY-007: verifyPayout returns false if wrong currency in payout

- **Preconditions:** Module loaded; payout invoice covered but with wrong coinId
- **Action:** `verifyPayout(swapId)`
- **Expected:** Returns `false`; swap transitions to 'failed' with SWAP_PAYOUT_VERIFICATION_FAILED
- **Assertions:** result is `false`; progress is 'failed'

#### UT-SWAP-VERIFY-008: verifyPayout returns false if wrong amount in payout

- **Preconditions:** Module loaded; payout invoice covered but with insufficient amount
- **Action:** `verifyPayout(swapId)`
- **Expected:** Returns `false`; swap transitions to 'failed' with SWAP_PAYOUT_VERIFICATION_FAILED
- **Assertions:** result is `false`; progress is 'failed'

#### UT-SWAP-VERIFY-009: verifyPayout with no payoutInvoiceId throws SWAP_WRONG_STATE

- **Preconditions:** Module loaded; swap in 'awaiting_counter' state (no payout invoice yet)
- **Action:** `verifyPayout(swapId)`
- **Expected:** Throws SphereError with code SWAP_WRONG_STATE
- **Assertions:** Error code is SWAP_WRONG_STATE

---

### 3.7 cancelSwap()

**File:** `tests/unit/modules/SwapModule.cancel.test.ts`

#### UT-SWAP-CANCEL-001: cancelSwap in pre-announcement state marks cancelled locally

- **Preconditions:** Module loaded; swap in 'proposed' state (not yet announced to escrow)
- **Action:** `cancelSwap(swapId)`
- **Expected:** SwapRef progress becomes 'cancelled'; no DM sent to escrow (pre-announcement)
- **Assertions:** Progress is 'cancelled'; no escrow DM sent

#### UT-SWAP-CANCEL-002: cancelSwap emits swap:cancelled

- **Preconditions:** Module loaded; swap in cancellable state
- **Action:** `cancelSwap(swapId)`
- **Expected:** `emitEvent` called with `'swap:cancelled'` and `{ swapId, reason: 'explicit' }`
- **Assertions:** Event emitted with correct payload

#### UT-SWAP-CANCEL-003: cancelSwap on already-completed throws SWAP_ALREADY_COMPLETED

- **Preconditions:** Module loaded; swap in 'completed' state
- **Action:** `cancelSwap(swapId)`
- **Expected:** Throws SphereError with code SWAP_ALREADY_COMPLETED
- **Assertions:** Error code is SWAP_ALREADY_COMPLETED

#### UT-SWAP-CANCEL-004: cancelSwap on already-cancelled throws SWAP_ALREADY_CANCELLED

- **Preconditions:** Module loaded; swap in 'cancelled' state
- **Action:** `cancelSwap(swapId)`
- **Expected:** Throws SphereError with code SWAP_ALREADY_CANCELLED
- **Assertions:** Error code is SWAP_ALREADY_CANCELLED

#### UT-SWAP-CANCEL-005: escrow swap_cancelled DM updates local state

- **Preconditions:** Module loaded; swap in 'awaiting_counter' state
- **Action:** Inject `swap_cancelled` DM from escrow via mock communications
- **Expected:** SwapRef progress becomes 'cancelled'; reason stored
- **Assertions:** `getSwapStatus(swapId).progress` equals 'cancelled'

#### UT-SWAP-CANCEL-006: escrow cancellation triggers swap:cancelled event

- **Preconditions:** Module loaded; swap in 'awaiting_counter' state
- **Action:** Inject `swap_cancelled` DM from escrow
- **Expected:** `emitEvent` called with `'swap:cancelled'` and `{ swapId, reason: 'timeout' }`
- **Assertions:** Event emitted with escrow-provided reason

#### UT-SWAP-CANCEL-007: deposit return received after cancellation tracked

- **Preconditions:** Module loaded; swap cancelled; escrow sends return via AccountingModule
- **Action:** Invoice `invoice:return_received` event fires for deposit invoice
- **Expected:** SwapRef updated with deposit return information
- **Assertions:** SwapRef contains `depositReturnTransferId`

---

### 3.8 DM Processing

**File:** `tests/unit/modules/SwapModule.dmProcessing.test.ts`

#### UT-SWAP-DM-001: swap_proposal DM creates SwapRef with role='acceptor'

- **Preconditions:** Module loaded; no existing swap for this ID
- **Action:** Inject `swap_proposal` DM via mock communications
- **Expected:** SwapRef created with `role: 'acceptor'`, `progress: 'proposed'`; deal parsed from DM content
- **Assertions:** `getSwaps()` includes new swap; role and progress correct

#### UT-SWAP-DM-002: swap_proposal DM emits swap:proposal_received

- **Preconditions:** Module loaded
- **Action:** Inject `swap_proposal` DM
- **Expected:** `emitEvent` called with `'swap:proposal_received'` and `{ swapId, deal, senderPubkey }`
- **Assertions:** Event payload contains deal details

#### UT-SWAP-DM-003: swap_acceptance DM triggers escrow announcement

- **Preconditions:** Module loaded; swap in 'proposed' state with role='proposer'
- **Action:** Inject `swap_acceptance` DM from counterparty
- **Expected:** Module sends announcement DM to escrow address; progress transitions to 'announced' after escrow reply
- **Assertions:** `communications.sendDM()` called with escrow address

#### UT-SWAP-DM-004: swap_rejection DM marks swap as cancelled

- **Preconditions:** Module loaded; swap in 'proposed' state with role='proposer'
- **Action:** Inject `swap_rejection` DM from counterparty
- **Expected:** SwapRef progress becomes 'cancelled'; reason stored; `swap:rejected` and `swap:cancelled` events emitted
- **Assertions:** Progress is 'cancelled'; both events emitted

#### UT-SWAP-DM-005: announce_result DM stores deposit_invoice_id

- **Preconditions:** Module loaded; swap waiting for escrow response
- **Action:** Inject `announce_result` DM from escrow
- **Expected:** SwapRef updated with `depositInvoiceId` from response; progress advances
- **Assertions:** `getSwapStatus(swapId).depositInvoiceId` is set

#### UT-SWAP-DM-006: invoice_delivery DM imports invoice via AccountingModule

- **Preconditions:** Module loaded; announce_result already received
- **Action:** Inject `invoice_delivery` DM containing deposit invoice token
- **Expected:** `accounting.importInvoice()` called with the parsed TxfToken from DM
- **Assertions:** `mocks.accounting.importInvoice` called once
- **Note:** `msg.invoice_token` is a JSON string that must be parsed (`JSON.parse(msg.invoice_token)`) before passing to `importInvoice()`

#### UT-SWAP-DM-007: payment_confirmation DM updates progress to 'concluding'

- **Preconditions:** Module loaded; swap in 'awaiting_counter' state
- **Action:** Inject `payment_confirmation` DM from escrow
- **Expected:** SwapRef progress becomes 'concluding'; payout invoice info stored
- **Assertions:** Progress is 'concluding'; `payoutInvoiceId` set

#### UT-SWAP-DM-008: swap_cancelled DM updates to cancelled

- **Preconditions:** Module loaded; swap in any non-terminal state
- **Action:** Inject `swap_cancelled` DM from escrow
- **Expected:** SwapRef progress becomes 'cancelled'; reason from DM stored
- **Assertions:** Progress is 'cancelled'

#### UT-SWAP-DM-009: bounce_notification DM logs warning

- **Preconditions:** Module loaded; swap in 'awaiting_counter' state
- **Action:** Inject `bounce_notification` DM from escrow with `reason: 'WRONG_CURRENCY'`
- **Expected:** Warning event emitted; swap state not changed (bounce is informational for the sender)
- **Assertions:** `emitEvent` called with `'swap:bounce_received'`

#### UT-SWAP-DM-010: malformed DM silently ignored

- **Preconditions:** Module loaded
- **Action:** Inject DM with content `'this is not JSON'`
- **Expected:** No error thrown; no state change; DM handler returns without action
- **Assertions:** `getSwaps()` unchanged; no emitEvent call for swap events

#### UT-SWAP-DM-011: DM from unknown sender ignored

- **Preconditions:** Module loaded; swap exists between party A and party B
- **Action:** Inject `swap_acceptance` DM from unknown party C
- **Expected:** DM silently ignored; no state change
- **Assertions:** Swap progress unchanged

#### UT-SWAP-DM-012: DM for unknown swap_id handled gracefully

- **Preconditions:** Module loaded; no swap with id 'unknown_swap_id'
- **Action:** Inject `swap_acceptance` DM with `swap_id: 'unknown_swap_id'`
- **Expected:** DM ignored for non-proposal types; for `swap_proposal`, new SwapRef created
- **Assertions:** No error; no new swap created for non-proposal DMs

---

### 3.9 Invoice Event Subscriptions

**File:** `tests/unit/modules/SwapModule.invoiceEvents.test.ts`

#### UT-SWAP-INV-001: invoice:payment on deposit invoice emits swap:deposit_confirmed

- **Preconditions:** Module loaded; swap has depositInvoiceId; invoice:payment fires for that invoice
- **Action:** Trigger `invoice:payment` event via mock accounting with matching invoiceId
- **Expected:** `emitEvent` called with `'swap:deposit_confirmed'` and `{ swapId, invoiceId, paymentDirection }`
- **Assertions:** Event emitted with correct swap association

#### UT-SWAP-INV-002: invoice:covered on deposit invoice emits swap:deposits_covered

- **Preconditions:** Module loaded; swap in 'awaiting_counter' state; deposit invoice becomes COVERED
- **Action:** Trigger `invoice:covered` event via mock accounting
- **Expected:** `emitEvent` called with `'swap:deposits_covered'` and `{ swapId }`
- **Assertions:** Event emitted

#### UT-SWAP-INV-003: invoice:covered on deposit transitions to 'concluding'

- **Preconditions:** Module loaded; swap has depositInvoiceId
- **Action:** Trigger `invoice:covered` event
- **Expected:** SwapRef progress transitions to 'concluding' (awaiting payout)
- **Assertions:** `getSwapStatus(swapId).progress` equals 'concluding'

#### UT-SWAP-INV-004: invoice:created for payout invoice emits swap:payout_received

- **Preconditions:** Module loaded; swap in 'concluding' state; payoutInvoiceId matches
- **Action:** Trigger `invoice:created` event with payout invoiceId
- **Expected:** `emitEvent` called with `'swap:payout_received'`
- **Assertions:** Event emitted with swap association

#### UT-SWAP-INV-005: invoice:return_received tracked for cancellation

- **Preconditions:** Module loaded; swap cancelled; deposit invoice return arrives
- **Action:** Trigger `invoice:return_received` event for deposit invoice
- **Expected:** SwapRef updated with return tracking info; `swap:deposit_returned` event emitted
- **Assertions:** Event emitted; return tracked in SwapRef

#### UT-SWAP-INV-006: invoice event for non-swap invoice ignored

- **Preconditions:** Module loaded; invoice:payment fires for an invoice not linked to any swap
- **Action:** Trigger `invoice:payment` with random invoiceId
- **Expected:** No swap state change; no swap events emitted
- **Assertions:** `emitEvent` not called with swap event types

---

### 3.10 Concurrency

**File:** `tests/unit/modules/SwapModule.concurrency.test.ts`

#### UT-SWAP-CONC-001: concurrent operations on same swap are serialized

- **Preconditions:** Module loaded; swap in 'proposed' state
- **Action:** Call `acceptSwap(swapId)` and `cancelSwap(swapId)` concurrently (Promise.allSettled)
- **Expected:** One succeeds, one fails with SWAP_WRONG_STATE; operations execute sequentially (mutex)
- **Assertions:** Exactly 1 fulfilled, 1 rejected; final state is consistent

#### UT-SWAP-CONC-002: operations on different swaps run in parallel

- **Preconditions:** Module loaded; 2 swaps in 'proposed' state
- **Action:** `acceptSwap(id1)` and `acceptSwap(id2)` concurrently
- **Expected:** Both succeed independently (different mutex keys)
- **Assertions:** Both resolved as fulfilled

#### UT-SWAP-CONC-003: gate released on error (doesn't deadlock)

- **Preconditions:** Module loaded; swap exists
- **Action:** First operation fails; second operation on same swap executes afterward
- **Expected:** Second operation runs normally (gate was released after error)
- **Assertions:** Second operation resolves (not stuck)

#### UT-SWAP-CONC-004: concurrent proposeSwap with same deal doesn't create duplicate

- **Preconditions:** Module loaded
- **Action:** Call `proposeSwap(sameDeal)` twice concurrently
- **Expected:** Only 1 SwapRef created; second call returns same proposal (idempotent)
- **Assertions:** `getSwaps()` returns 1 swap

---

### 3.11 Storage

**File:** `tests/unit/modules/SwapModule.storage.test.ts`

#### UT-SWAP-STORE-001: swap record persisted on state transition

- **Preconditions:** Module loaded; swap proposed
- **Action:** `acceptSwap(swapId)` transitions state
- **Expected:** `storage.set()` called with swap key; stored JSON contains updated progress
- **Assertions:** Storage contains valid serialized SwapRef at expected key

#### UT-SWAP-STORE-002: load() restores persisted swaps

- **Preconditions:** Storage pre-populated with 2 serialized SwapRef records
- **Action:** `load()`
- **Expected:** Both swaps accessible via `getSwaps()`; states match persisted data
- **Assertions:** `getSwaps()` returns 2 swaps with correct fields

#### UT-SWAP-STORE-003: destroyed module persists dirty records

- **Preconditions:** Module loaded; swap state modified in memory
- **Action:** `destroy()`
- **Expected:** Modified SwapRef flushed to storage before shutdown
- **Assertions:** `storage.set()` called during destroy

#### UT-SWAP-STORE-004: storage corruption handled gracefully

- **Preconditions:** Storage contains invalid JSON for a swap key
- **Action:** `load()`
- **Expected:** Corrupt record skipped with warning; valid records still loaded
- **Assertions:** Module loads without error; only valid swaps in `getSwaps()`

#### UT-SWAP-STORE-005: terminal swaps purged after TTL

- **Preconditions:** Storage contains 1 completed swap with `completedAt` older than `terminalPurgeTtlMs`
- **Action:** `load()`
- **Expected:** Completed swap removed from storage; not returned by `getSwaps()`
- **Assertions:** `storage.remove()` called for expired terminal swap key

---

### 3.12 Manifest Construction and swap_id

**File:** `tests/unit/modules/SwapModule.manifest.test.ts`

#### UT-SWAP-MAN-001: computeSwapId produces 64-hex string

- **Preconditions:** None (pure function)
- **Action:** `computeSwapId(fields)`
- **Expected:** Returns 64-character hexadecimal string
- **Assertions:** Result matches `/^[0-9a-f]{64}$/`

#### UT-SWAP-MAN-002: computeSwapId is deterministic

- **Preconditions:** None
- **Action:** Call `computeSwapId(fields)` twice with identical input
- **Expected:** Both calls return identical result
- **Assertions:** `result1 === result2`

#### UT-SWAP-MAN-003: computeSwapId uses JCS (RFC 8785) canonicalization

- **Preconditions:** Known test vector with expected hash
- **Action:** `computeSwapId(fields)`
- **Expected:** Result matches pre-computed hash from JCS-canonicalized input
- **Assertions:** Result equals expected hex hash

#### UT-SWAP-MAN-004: field ordering doesn't affect swap_id

- **Preconditions:** None
- **Action:** Create manifest fields in two different orderings; compute swap_id for each
- **Expected:** Both produce the same swap_id (JCS ensures deterministic ordering)
- **Assertions:** `id1 === id2`

#### UT-SWAP-MAN-005: buildManifest resolves addresses to DIRECT://

- **Preconditions:** Transport mock resolves '@alice' and '@bob' to DIRECT:// addresses
- **Action:** `buildManifest(deal)` with nametag addresses
- **Expected:** Manifest contains DIRECT:// addresses, not nametags
- **Assertions:** `manifest.party_a_address.startsWith('DIRECT://')`

#### UT-SWAP-MAN-006: buildManifest validates all fields

- **Preconditions:** None
- **Action:** `buildManifest(invalidDeal)` with missing/invalid fields
- **Expected:** Throws validation error before computing swap_id
- **Assertions:** Error thrown with descriptive message

#### UT-SWAP-MAN-007: computeSwapId matches escrow's hash implementation

- **Preconditions:** Known manifest from escrow test suite
- **Action:** Compute swap_id client-side using the same manifest fields
- **Expected:** Result matches the escrow's `computeSwapId()` output for the same input
- **Assertions:** Client and server produce identical hash (cross-implementation compatibility)

---

### 3.13 State Machine (Local Progress)

**File:** `tests/unit/modules/SwapModule.stateMachine.test.ts`

#### Valid Transitions

| Test ID | From | To | Trigger |
|---------|------|----|---------|
| UT-SWAP-SM-001 | proposed | accepted | acceptSwap() |
| UT-SWAP-SM-002 | proposed | cancelled | cancelSwap() |
| UT-SWAP-SM-003 | proposed | cancelled | swap_rejection DM |
| UT-SWAP-SM-004 | accepted | announced | announce_result DM |
| UT-SWAP-SM-005 | accepted | failed | escrow rejection |
| UT-SWAP-SM-006 | accepted | cancelled | cancelSwap() |
| UT-SWAP-SM-007 | announced | depositing | deposit() called |
| UT-SWAP-SM-008 | announced | cancelled | cancelSwap() |
| UT-SWAP-SM-009 | depositing | awaiting_counter | payInvoice resolves |
| UT-SWAP-SM-010 | depositing | failed | payInvoice rejects |
| UT-SWAP-SM-010a | depositing | cancelled | swap_cancelled DM received while deposit in flight |
| UT-SWAP-SM-011 | awaiting_counter | concluding | payment_confirmation DM |
| UT-SWAP-SM-012 | awaiting_counter | cancelled | swap_cancelled DM |
| UT-SWAP-SM-013 | concluding | completed | verifyPayout() success |
| UT-SWAP-SM-014 | concluding | cancelled | swap_cancelled DM |
| UT-SWAP-SM-015 | concluding | failed | verification failure |

Each test:
- **Preconditions:** Module loaded; swap in 'From' state (inject via internal state manipulation)
- **Action:** Trigger the specified action
- **Expected:** Progress transitions to 'To' state; correct event emitted
- **Assertions:** `getSwapStatus(swapId).progress` equals expected state

#### Invalid Transitions

| Test ID | From | Attempted To | Expected Error |
|---------|------|-------------|----------------|
| UT-SWAP-SM-016 | proposed | depositing | SWAP_WRONG_STATE |
| UT-SWAP-SM-017 | proposed | concluding | SWAP_WRONG_STATE |
| UT-SWAP-SM-018 | announced | completed | SWAP_WRONG_STATE |
| UT-SWAP-SM-019 | depositing | announced | SWAP_WRONG_STATE |
| UT-SWAP-SM-020 | awaiting_counter | proposed | SWAP_WRONG_STATE |
| UT-SWAP-SM-021 | completed | cancelled | SWAP_ALREADY_COMPLETED |
| UT-SWAP-SM-022 | completed | depositing | SWAP_ALREADY_COMPLETED |
| UT-SWAP-SM-023 | cancelled | proposed | SWAP_ALREADY_CANCELLED |
| UT-SWAP-SM-024 | cancelled | depositing | SWAP_ALREADY_CANCELLED |
| UT-SWAP-SM-025 | failed | depositing | SWAP_WRONG_STATE |

Each test:
- **Preconditions:** Module loaded; swap in 'From' state
- **Action:** Attempt transition to 'Attempted To'
- **Expected:** Throws SphereError with expected error code
- **Assertions:** Error code matches

#### Terminal State Detection

#### UT-SWAP-SM-026: isTerminalState for completed/cancelled/failed

- **Preconditions:** None (pure function)
- **Action:** Check `isTerminalState('completed')`, `isTerminalState('cancelled')`, `isTerminalState('failed')`
- **Expected:** All return true
- **Assertions:** Each returns true

#### UT-SWAP-SM-027: mapping from escrow state to local progress

- **Preconditions:** None (pure function)
- **Action:** Map each escrow `SwapState` to local `SwapProgress`:

| Escrow State | Local Progress |
|-------------|---------------|
| ANNOUNCED | announced |
| DEPOSIT_INVOICE_CREATED | announced |
| PARTIAL_DEPOSIT | awaiting_counter |
| DEPOSIT_COVERED | awaiting_counter |
| CONCLUDING | concluding |
| COMPLETED | completed |
| TIMED_OUT | cancelled |
| CANCELLING | cancelled |
| CANCELLED | cancelled |
| FAILED | failed |

- **Expected:** Mapping function returns correct local progress for each escrow state
- **Assertions:** Each mapping matches expected value

---

### 3.14 Input Validation

**File:** `tests/unit/modules/SwapModule.validation.test.ts`

#### Address Format Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-001 | `partyA = 'DIRECT://valid'` | Accepted |
| UT-SWAP-VAL-002 | `partyA = '@alice'` | Accepted (resolved) |
| UT-SWAP-VAL-003 | `partyA = '02' + 'a'.repeat(64)` | Accepted (chain pubkey) |
| UT-SWAP-VAL-004 | `partyA = 'alpha1testaddr'` | Accepted (L1 address) |
| UT-SWAP-VAL-005 | `partyA = ''` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-006 | `partyA = null` | Rejected: SWAP_INVALID_DEAL |

#### Amount Format Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-007 | `partyAAmount = '1000000'` | Accepted |
| UT-SWAP-VAL-008 | `partyAAmount = '1'` | Accepted (minimum) |
| UT-SWAP-VAL-009 | `partyAAmount = '0'` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-010 | `partyAAmount = '-100'` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-011 | `partyAAmount = '10.5'` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-012 | `partyAAmount = ''` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-013 | `partyAAmount = 'abc'` | Rejected: SWAP_INVALID_DEAL |

#### Currency Format Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-014 | `partyACurrency = 'UCT'` | Accepted |
| UT-SWAP-VAL-015 | `partyACurrency = 'USDU'` | Accepted |
| UT-SWAP-VAL-016 | `partyACurrency = ''` | Rejected: SWAP_INVALID_DEAL |
| UT-SWAP-VAL-017 | `partyACurrency = 'UC-T'` | Rejected: SWAP_INVALID_DEAL |

#### Timeout Range Validation

| Test ID | Input | Expected |
|---------|-------|----------|
| UT-SWAP-VAL-018 | `timeout = 60` | Accepted (minimum) |
| UT-SWAP-VAL-019 | `timeout = 86400` | Accepted (maximum) |
| UT-SWAP-VAL-020 | `timeout = 0` | Rejected: SWAP_INVALID_DEAL |

Each test:
- **Preconditions:** Module loaded
- **Action:** `proposeSwap(deal)` with the specified input
- **Expected:** Accepted or rejected as indicated
- **Assertions:** Successful return or SphereError with SWAP_INVALID_DEAL

---

### 3.15 Error Codes

**File:** `tests/unit/modules/SwapModule.errors.test.ts`

| Test ID | Error Code | Trigger | Expected Message Contains |
|---------|-----------|---------|--------------------------|
| UT-SWAP-ERR-001 | SWAP_NOT_FOUND | `getSwapStatus('nonexistent')` | "swap not found" |
| UT-SWAP-ERR-002 | SWAP_INVALID_DEAL | `proposeSwap({ partyA: '' })` | "invalid deal" |
| UT-SWAP-ERR-003 | SWAP_WRONG_STATE | `deposit()` on 'proposed' swap | "wrong state" |
| UT-SWAP-ERR-004 | SWAP_WRONG_STATE | `acceptSwap()` on proposer's swap | "you are the proposer" |
| UT-SWAP-ERR-005 | SWAP_RESOLVE_FAILED | nametag resolution returns null | "resolve failed" |
| UT-SWAP-ERR-006 | SWAP_DM_SEND_FAILED | `sendDM()` rejects | "DM send failed" |
| UT-SWAP-ERR-007 | SWAP_DEPOSIT_FAILED | `payInvoice()` rejects | "deposit failed" |
| UT-SWAP-ERR-008 | SWAP_ESCROW_REJECTED | escrow returns error in announce_result | "escrow rejected" |
| UT-SWAP-ERR-009 | SWAP_ESCROW_TIMEOUT | no announce_result within timeout | "escrow timeout" |
| UT-SWAP-ERR-010 | SWAP_ALREADY_COMPLETED | `cancelSwap()` on completed swap | "already completed" |
| UT-SWAP-ERR-011 | SWAP_ALREADY_CANCELLED | `cancelSwap()` on cancelled swap | "already cancelled" |
| UT-SWAP-ERR-012 | SWAP_LIMIT_EXCEEDED | exceed maxPendingSwaps | "max pending" |
| UT-SWAP-ERR-013 | SWAP_NOT_INITIALIZED | operation before initialize | "not initialized" |
| UT-SWAP-ERR-014 | SWAP_MODULE_DESTROYED | operation after destroy | "destroyed" |
| UT-SWAP-ERR-015 | SWAP_ALREADY_INITIALIZED | double initialize | "already initialized" |

Each test:
- **Preconditions:** Module in appropriate state for the trigger
- **Action:** Execute the trigger
- **Expected:** SphereError thrown with correct code; `error instanceof SphereError` is true; `error.code` matches
- **Assertions:** Error instance, code, and message substring

---

### 3.16 CLI Commands

**File:** `tests/unit/modules/SwapModule.cli.test.ts`

Test the CLI commands `swap-propose`, `swap-list`, `swap-accept`, `swap-status`, and `swap-deposit` by verifying they correctly parse arguments, call the appropriate SwapModule methods, and produce the expected output.

**Test helpers:**
- Mock `getSphere()` to return a Sphere instance with a mocked SwapModule
- Capture stdout via `vi.spyOn(console, 'log')`
- Capture stderr via `vi.spyOn(console, 'error')`
- Mock `process.exit` to prevent test runner from exiting

#### swap-propose

#### UT-SWAP-CLI-001: Valid proposal with all required flags calls proposeSwap with correct SwapDeal

- **Preconditions:** Mocked SwapModule; `getSphere()` returns sphere with swap module
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000`
- **Expected:** `swapModule.proposeSwap()` called once with deal containing `partyB: '@bob'`, `partyACurrency: 'UCT'`, `partyAAmount: '1000000'`, `partyBCurrency: 'USDU'`, `partyBAmount: '500000'`
- **Assertions:** `proposeSwap` called with matching SwapDeal fields

#### UT-SWAP-CLI-002: Missing --to flag prints usage and exits 1

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000`
- **Expected:** `console.error` called with usage message; `process.exit(1)` called
- **Assertions:** stderr contains usage info; exit code is 1

#### UT-SWAP-CLI-003: Missing --offer-coin prints usage and exits 1

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --to @bob --offer-amount 1000000 --want-coin USDU --want-amount 500000`
- **Expected:** `console.error` called with usage message; `process.exit(1)` called
- **Assertions:** stderr contains usage info; exit code is 1

#### UT-SWAP-CLI-004: Invalid --offer-amount (not positive integer) prints error and exits 1

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount -50 --want-coin USDU --want-amount 500000`
- **Expected:** `console.error` called with message mentioning invalid amount; `process.exit(1)` called
- **Assertions:** stderr contains "amount"; exit code is 1

#### UT-SWAP-CLI-005: --timeout out of range [60, 86400] prints error and exits 1

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000 --timeout 30`
- **Expected:** `console.error` called with message mentioning timeout range; `process.exit(1)` called
- **Assertions:** stderr contains "timeout"; exit code is 1

#### UT-SWAP-CLI-006: Default timeout is 3600 when not specified

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000`
- **Expected:** `swapModule.proposeSwap()` called with deal where `timeout === 3600`
- **Assertions:** Deal passed to proposeSwap has timeout 3600

#### UT-SWAP-CLI-007: --escrow flag overrides default escrow

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000 --escrow DIRECT://custom_escrow`
- **Expected:** `swapModule.proposeSwap()` called with deal where `escrowAddress === 'DIRECT://custom_escrow'`
- **Assertions:** Deal passed to proposeSwap has custom escrow address

#### UT-SWAP-CLI-008: --message flag passed as deal message

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000 --message "Trade offer"`
- **Expected:** `swapModule.proposeSwap()` called with deal where `message === 'Trade offer'`
- **Assertions:** Deal passed to proposeSwap includes message field

#### UT-SWAP-CLI-009: SWAP_RESOLVE_FAILED error prints user-friendly message

- **Preconditions:** Mocked SwapModule; `proposeSwap()` rejects with SphereError code SWAP_RESOLVE_FAILED
- **Action:** Run `swap-propose --to @unknown --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000`
- **Expected:** `console.error` called with user-friendly message (not raw stack trace); `process.exit(1)` called
- **Assertions:** stderr contains "could not resolve" or similar human-readable text; exit code is 1

#### UT-SWAP-CLI-010: Output includes swap_id, counterparty, offer, want summary

- **Preconditions:** Mocked SwapModule; `proposeSwap()` resolves with `{ swapId: 'abc...', ... }`
- **Action:** Run `swap-propose --to @bob --offer-coin UCT --offer-amount 1000000 --want-coin USDU --want-amount 500000`
- **Expected:** `console.log` output includes swap_id, counterparty identifier, offer summary (coin + amount), want summary (coin + amount)
- **Assertions:** stdout contains the swap_id, "@bob", "UCT", "1000000", "USDU", "500000"

#### swap-list

#### UT-SWAP-CLI-011: Default (no flags) excludes terminal states

- **Preconditions:** Mocked SwapModule; `getSwaps()` returns 3 swaps (1 proposed, 1 completed, 1 cancelled)
- **Action:** Run `swap-list`
- **Expected:** Output contains only the proposed swap; terminal (completed, cancelled) swaps excluded by default
- **Assertions:** stdout shows 1 row; completed and cancelled swaps not displayed

#### UT-SWAP-CLI-012: --all flag includes terminal states

- **Preconditions:** Mocked SwapModule; `getSwaps()` returns 3 swaps (1 proposed, 1 completed, 1 cancelled)
- **Action:** Run `swap-list --all`
- **Expected:** Output contains all 3 swaps including terminal states
- **Assertions:** stdout shows 3 rows

#### UT-SWAP-CLI-013: --role proposer filters by role

- **Preconditions:** Mocked SwapModule; `getSwaps()` returns 2 swaps (1 proposer, 1 acceptor)
- **Action:** Run `swap-list --role proposer`
- **Expected:** `getSwaps()` called with `{ role: 'proposer' }` filter; output contains only proposer swap
- **Assertions:** stdout shows 1 row with role='proposer'

#### UT-SWAP-CLI-014: --progress depositing filters by progress

- **Preconditions:** Mocked SwapModule; `getSwaps()` returns 3 swaps with mixed progress values
- **Action:** Run `swap-list --progress depositing`
- **Expected:** `getSwaps()` called with `{ progress: 'depositing' }` filter; output contains only matching swaps
- **Assertions:** All displayed rows have progress='depositing'

#### UT-SWAP-CLI-015: No matching swaps prints "No swaps found."

- **Preconditions:** Mocked SwapModule; `getSwaps()` returns `[]`
- **Action:** Run `swap-list`
- **Expected:** `console.log` called with "No swaps found."
- **Assertions:** stdout contains "No swaps found."

#### UT-SWAP-CLI-016: Output table has correct columns (swap_id, role, progress, offer, want, counterparty, created)

- **Preconditions:** Mocked SwapModule; `getSwaps()` returns 1 swap with known fields
- **Action:** Run `swap-list --all`
- **Expected:** Output formatted as table with columns: swap_id (truncated), role, progress, offer (coin + amount), want (coin + amount), counterparty (truncated), created (formatted timestamp)
- **Assertions:** stdout contains all column headers; row data matches swap fields

#### swap-accept

#### UT-SWAP-CLI-017: Valid swap_id calls acceptSwap

- **Preconditions:** Mocked SwapModule; `acceptSwap()` resolves successfully
- **Action:** Run `swap-accept aabbccdd...` (64-hex swap_id)
- **Expected:** `swapModule.acceptSwap()` called with the provided swap_id
- **Assertions:** `acceptSwap` called once with correct swap_id

#### UT-SWAP-CLI-018: Missing swap_id prints usage and exits 1

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-accept` (no arguments)
- **Expected:** `console.error` called with usage message; `process.exit(1)` called
- **Assertions:** stderr contains usage info; exit code is 1

#### UT-SWAP-CLI-019: Invalid swap_id (not 64 hex) prints error and exits 1

- **Preconditions:** Mocked SwapModule
- **Action:** Run `swap-accept not-a-valid-hex-id`
- **Expected:** `console.error` called with message mentioning invalid swap_id format; `process.exit(1)` called
- **Assertions:** stderr contains "swap_id"; exit code is 1

#### UT-SWAP-CLI-020: --deposit flag also calls deposit() after accept

- **Preconditions:** Mocked SwapModule; `acceptSwap()` and `deposit()` both resolve successfully
- **Action:** Run `swap-accept aabbccdd... --deposit` (64-hex swap_id)
- **Expected:** `swapModule.acceptSwap()` called first, then `swapModule.deposit()` called with same swap_id
- **Assertions:** Both `acceptSwap` and `deposit` called in order with correct swap_id

#### UT-SWAP-CLI-021: Without --deposit prints instruction to run swap-deposit

- **Preconditions:** Mocked SwapModule; `acceptSwap()` resolves successfully
- **Action:** Run `swap-accept aabbccdd...` (64-hex swap_id, no --deposit flag)
- **Expected:** `console.log` output includes instruction text mentioning `swap-deposit` command
- **Assertions:** stdout contains "swap-deposit"

#### UT-SWAP-CLI-022: SWAP_NOT_FOUND error prints user-friendly message

- **Preconditions:** Mocked SwapModule; `acceptSwap()` rejects with SphereError code SWAP_NOT_FOUND
- **Action:** Run `swap-accept aabbccdd...` (64-hex swap_id)
- **Expected:** `console.error` called with user-friendly message; `process.exit(1)` called
- **Assertions:** stderr contains "not found" or similar; exit code is 1

#### UT-SWAP-CLI-023: SWAP_WRONG_STATE error prints current state

- **Preconditions:** Mocked SwapModule; `acceptSwap()` rejects with SphereError code SWAP_WRONG_STATE and message containing "depositing"
- **Action:** Run `swap-accept aabbccdd...` (64-hex swap_id)
- **Expected:** `console.error` called with message including current swap state; `process.exit(1)` called
- **Assertions:** stderr contains state information; exit code is 1

#### UT-SWAP-CLI-024: --deposit with --no-wait returns immediately after deposit sent

- **Preconditions:** Mocked SwapModule; `acceptSwap()` and `deposit()` both resolve successfully
- **Action:** Run `swap-accept aabbccdd... --deposit --no-wait` (64-hex swap_id)
- **Expected:** `deposit()` called; command exits without waiting for swap completion
- **Assertions:** `deposit` called; process completes without polling for status

#### swap-status

#### UT-SWAP-CLI-025: Shows full SwapRef fields including deposit/payout invoice IDs

- **Preconditions:** Mocked SwapModule; `getSwapStatus()` returns SwapStatus with all fields populated (swapId, progress, role, deal, depositInvoiceId, payoutInvoiceId, createdAt)
- **Action:** Run `swap-status aabbccdd...` (64-hex swap_id)
- **Expected:** `console.log` output includes all SwapRef fields: swap_id, progress, role, offer/want details, deposit invoice ID, payout invoice ID, timestamps
- **Assertions:** stdout contains each field value from the returned SwapStatus

#### UT-SWAP-CLI-026: --query-escrow flag triggers getSwapStatus with escrow query

- **Preconditions:** Mocked SwapModule; `getSwapStatus()` resolves
- **Action:** Run `swap-status aabbccdd... --query-escrow` (64-hex swap_id)
- **Expected:** `swapModule.getSwapStatus()` called with `(swapId, { queryEscrow: true })`
- **Assertions:** `getSwapStatus` called with queryEscrow option set to true

#### UT-SWAP-CLI-027: SWAP_NOT_FOUND prints error

- **Preconditions:** Mocked SwapModule; `getSwapStatus()` rejects with SphereError code SWAP_NOT_FOUND
- **Action:** Run `swap-status aabbccdd...` (64-hex swap_id)
- **Expected:** `console.error` called with user-friendly message; `process.exit(1)` called
- **Assertions:** stderr contains "not found"; exit code is 1

#### swap-deposit

#### UT-SWAP-CLI-028: Valid swap_id calls deposit()

- **Preconditions:** Mocked SwapModule; `deposit()` resolves successfully
- **Action:** Run `swap-deposit aabbccdd...` (64-hex swap_id)
- **Expected:** `swapModule.deposit()` called with the provided swap_id
- **Assertions:** `deposit` called once with correct swap_id

#### UT-SWAP-CLI-029: SWAP_WRONG_STATE prints current state info

- **Preconditions:** Mocked SwapModule; `deposit()` rejects with SphereError code SWAP_WRONG_STATE and message containing "proposed"
- **Action:** Run `swap-deposit aabbccdd...` (64-hex swap_id)
- **Expected:** `console.error` called with message including current swap state; `process.exit(1)` called
- **Assertions:** stderr contains state information; exit code is 1

#### UT-SWAP-CLI-030: SWAP_DEPOSIT_FAILED prints failure details

- **Preconditions:** Mocked SwapModule; `deposit()` rejects with SphereError code SWAP_DEPOSIT_FAILED and message containing failure reason
- **Action:** Run `swap-deposit aabbccdd...` (64-hex swap_id)
- **Expected:** `console.error` called with failure details from error; `process.exit(1)` called
- **Assertions:** stderr contains failure details; exit code is 1

---

## 4. Integration Tests

**File:** `tests/integration/swap-lifecycle.test.ts`

### Test Infrastructure

Two SwapModule instances (partyA and partyB) communicating via a mock DM relay. An `EscrowSimulator` object simulates escrow behavior by intercepting DMs addressed to the escrow and replying with appropriate protocol messages.

```typescript
interface TestSwapContext {
  partyA: { module: SwapModule; mocks: TestSwapModuleMocks };
  partyB: { module: SwapModule; mocks: TestSwapModuleMocks };
  escrowSim: EscrowSimulator;
  dmRelay: MockDMRelay;
}
```

The `MockDMRelay` routes DMs between party A, party B, and the escrow simulator based on recipient address. The `EscrowSimulator` maintains a mini state machine that responds to `announce` DMs with `announce_result` + `invoice_delivery`, detects coverage and responds with `payment_confirmation` + payout `invoice_delivery`, and fires `swap_cancelled` on timeout.

### INT-SWAP-001: Happy path -- propose, accept, announce, deposit, conclude, verify

- **Preconditions:** Both modules loaded; escrow simulator running
- **Steps:**
  1. Party A calls `proposeSwap(deal)`
  2. Party B receives `swap:proposal_received` event
  3. Party B calls `acceptSwap(swapId)`
  4. Escrow simulator receives announcement, responds with `announce_result` + `invoice_delivery`
  5. Both parties call `deposit(swapId)` (mock `payInvoice` succeeds)
  6. Escrow simulator detects both deposits, sends `payment_confirmation` + payout `invoice_delivery`
  7. Both parties call `verifyPayout(swapId)` (mock payout invoice is COVERED)
- **Expected:** Both parties end in 'completed' state; all events fired in correct order; no errors
- **Assertions:** `partyA.module.getSwapStatus(swapId).progress === 'completed'`; same for party B

### INT-SWAP-002: Rejection flow -- propose, reject

- **Preconditions:** Both modules loaded
- **Steps:**
  1. Party A calls `proposeSwap(deal)`
  2. Party B receives proposal
  3. Party B calls `rejectSwap(swapId, { reason: 'Bad rate' })`
  4. Party A receives rejection DM
- **Expected:** Party A's swap transitions to 'cancelled'; Party B's swap removed; both emit appropriate events
- **Assertions:** Party A swap is 'cancelled'; party B has no swap

### INT-SWAP-003: Timeout cancellation flow

- **Preconditions:** Both modules loaded; escrow simulator has 5s timeout
- **Steps:**
  1. Both parties propose, accept, announce
  2. Party A deposits; Party B does NOT deposit
  3. Escrow simulator times out; sends `swap_cancelled` to both parties
- **Expected:** Both parties end in 'cancelled' state; `swap:cancelled` events with reason 'timeout'
- **Assertions:** Progress is 'cancelled' on both sides

### INT-SWAP-004: Party A cancels before deposit

- **Preconditions:** Both modules loaded; swap announced
- **Steps:**
  1. Both parties propose, accept, announce
  2. Party A calls `cancelSwap(swapId)` before depositing
- **Expected:** Party A's swap becomes 'cancelled'; cancellation DM optionally sent
- **Assertions:** Party A progress is 'cancelled'

### INT-SWAP-005: Concurrent proposal -- same deal from both sides

- **Preconditions:** Both modules loaded
- **Steps:**
  1. Party A proposes swap with party B
  2. Party B simultaneously proposes the same swap with party A
- **Expected:** Both see each other's proposal; deterministic swap_id ensures deduplication; one becomes proposer, one becomes acceptor
- **Assertions:** Only 1 swap tracked per party (same swap_id)

### INT-SWAP-006: Multiple independent swaps in parallel

- **Preconditions:** Both modules loaded; different deals
- **Steps:**
  1. Party A proposes swap #1 (UCT for USDU) and swap #2 (UCT for EUR)
  2. Party B accepts both
  3. Both deposit for both swaps
  4. Both verify payouts
- **Expected:** Both swaps complete independently; no cross-contamination
- **Assertions:** Both swaps in 'completed' state with correct amounts and currencies

---

## 5. E2E Tests

**File:** `tests/scripts/test-e2e-swap.ts`

> **Status:** Future -- requires real escrow service deployment on testnet

### Prerequisites

- Two Sphere wallets with UCT and USDU tokens (testnet)
- Escrow service running at known address
- Nostr relay available
- ~5 minute timeout budget

### E2E-SWAP-001: Full lifecycle on testnet

- **Steps:**
  1. Create wallet A with 2,000,000 UCT tokens
  2. Create wallet B with 1,000,000 USDU tokens
  3. Wallet A proposes swap: 1,000,000 UCT for 500,000 USDU
  4. Wallet B accepts and announces
  5. Both wallets deposit
  6. Escrow concludes; both verify payouts
  7. Assert final balances: A has 1,000,000 UCT + 500,000 USDU; B has 1,000,000 UCT + 500,000 USDU
- **Timeout:** 300 seconds
- **Cleanup:** Destroy both wallets

### E2E-SWAP-002: Timeout and refund on testnet

- **Steps:**
  1. Create wallet A and B with tokens
  2. Propose and announce swap with 120s timeout
  3. Only wallet A deposits
  4. Wait for timeout
  5. Assert: A receives deposit return; both wallets show 'cancelled'
  6. Assert: A's balance restored to pre-deposit amount
- **Timeout:** 300 seconds

---

## 6. Cross-Cutting Concerns

### 6.1 Event Ordering

All swap events must fire in the correct chronological order:

```
swap:proposed
  -> swap:accepted (or swap:rejected)
    -> swap:announced
      -> swap:deposit_sent
        -> swap:deposit_confirmed
          -> swap:deposits_covered
            -> swap:payout_received
              -> swap:completed

Alternative terminal paths:
  swap:cancelled (from any non-terminal state)
  swap:failed (from any non-terminal state)
  swap:deposit_returned (after cancellation)
  swap:bounce_received (informational, any state)
```

> **Note:** `swap:deposit_returned` and `swap:bounce_received` are not yet in SWAP-SPEC's SwapEventMap (section 2.7). They should be added to the spec as additional event types.

### 6.2 DM Protocol Versioning

All DM payloads include a `version` field. Tests should verify:
- Version 1 messages parsed correctly
- Unknown version messages logged but not crash the handler
- Missing version field treated as version 1 (backward compatibility)

### 6.3 Storage Key Convention

Swap records use a single storage key: `swap_records_{addressId}` where `addressId` is derived from the wallet's current DIRECT:// address (e.g., `DIRECT_abc123_xyz789`). All swap records are stored as a JSON blob (`SwapStorageData`) under this key, matching the spec's single-key approach (SWAP-SPEC section 14).

### 6.4 Escrow Address Validation

The module should verify that protocol DMs (announce_result, invoice_delivery, payment_confirmation, swap_cancelled) originate from the expected escrow address. DMs from other addresses claiming to be escrow responses must be ignored.

### 6.5 Timer Management

- Announce timeout timer: starts when `acceptSwap()` sends to escrow; cleared on `announce_result` or cancellation
- No client-side deposit timeout (escrow manages timeout)
- All timers cleared on `destroy()`

---

## Appendix A: Test Matrix

### Test Count Summary

| Test File | Test IDs | Count |
|-----------|----------|-------|
| SwapModule.lifecycle.test.ts | UT-SWAP-LIFE-001 to 011 | 11 |
| SwapModule.proposeSwap.test.ts | UT-SWAP-PROP-001 to 019 | 19 |
| SwapModule.acceptReject.test.ts | UT-SWAP-ACCEPT-001 to 010, UT-SWAP-REJECT-001 to 005 | 15 |
| SwapModule.deposit.test.ts | UT-SWAP-DEP-001 to 008 | 8 |
| SwapModule.status.test.ts | UT-SWAP-STATUS-001 to 008 | 8 |
| SwapModule.verify.test.ts | UT-SWAP-VERIFY-001 to 009 | 9 |
| SwapModule.cancel.test.ts | UT-SWAP-CANCEL-001 to 007 | 7 |
| SwapModule.dmProcessing.test.ts | UT-SWAP-DM-001 to 012 | 12 |
| SwapModule.invoiceEvents.test.ts | UT-SWAP-INV-001 to 006 | 6 |
| SwapModule.concurrency.test.ts | UT-SWAP-CONC-001 to 004 | 4 |
| SwapModule.storage.test.ts | UT-SWAP-STORE-001 to 005 | 5 |
| SwapModule.manifest.test.ts | UT-SWAP-MAN-001 to 007 | 7 |
| SwapModule.stateMachine.test.ts | UT-SWAP-SM-001 to 027 + SM-010a | 28 |
| SwapModule.validation.test.ts | UT-SWAP-VAL-001 to 020 | 20 |
| SwapModule.errors.test.ts | UT-SWAP-ERR-001 to 015 | 15 |
| SwapModule.cli.test.ts | UT-SWAP-CLI-001 to 030 | 30 |
| **Unit Total** | | **204** |
| swap-lifecycle.test.ts (integration) | INT-SWAP-001 to 006 | 6 |
| test-e2e-swap.ts (E2E) | E2E-SWAP-001 to 002 | 2 |
| **Grand Total** | | **212** |

### Method Coverage Matrix

| Method | Happy Path | Validation | Error Paths | Concurrency | Events | Storage |
|--------|-----------|------------|-------------|-------------|--------|---------|
| proposeSwap | PROP-001..006 | VAL-001..020 | PROP-007..018 | CONC-004 | PROP-005 | PROP-006 |
| acceptSwap | ACCEPT-001..005 | -- | ACCEPT-006..010 | CONC-001 | ACCEPT-005 | STORE-001 |
| rejectSwap | REJECT-001..003 | -- | REJECT-004..005 | -- | REJECT-003 | REJECT-002 |
| deposit | DEP-001..004 | -- | DEP-005..007 | -- | DEP-004 | DEP-008 |
| getSwapStatus | STATUS-001..003 | -- | STATUS-004 | -- | -- | -- |
| getSwaps | STATUS-005..008 | -- | -- | -- | -- | -- |
| verifyPayout | VERIFY-001..005 | -- | VERIFY-006..009 | -- | VERIFY-005 | -- |
| cancelSwap | CANCEL-001..002 | -- | CANCEL-003..004 | CONC-001 | CANCEL-002,006 | -- |

---

## Appendix B: Error Code Coverage

| Error Code | Test IDs |
|-----------|----------|
| SWAP_NOT_FOUND | ERR-001, STATUS-004, ACCEPT-006, CLI-022, CLI-027 |
| SWAP_INVALID_DEAL | ERR-002, PROP-007..015, VAL-005..017, VAL-020, CLI-002..005 |
| SWAP_WRONG_STATE | ERR-003, ERR-004, DEP-005, DEP-007, ACCEPT-007, ACCEPT-008, REJECT-004, VERIFY-009, SM-016..025, CLI-023, CLI-029 |
| SWAP_RESOLVE_FAILED | ERR-005, PROP-017, CLI-009 |
| SWAP_DM_SEND_FAILED | ERR-006, PROP-018 |
| SWAP_DEPOSIT_FAILED | ERR-007, DEP-006, CLI-030 |
| SWAP_ESCROW_REJECTED | ERR-008, ACCEPT-009 |
| SWAP_ESCROW_TIMEOUT | ERR-009, ACCEPT-010 |
| SWAP_ALREADY_COMPLETED | ERR-010, CANCEL-003, SM-021..022 |
| SWAP_ALREADY_CANCELLED | ERR-011, CANCEL-004, SM-023..024 |
| SWAP_LIMIT_EXCEEDED | ERR-012, PROP-016 |
| SWAP_NOT_INITIALIZED | ERR-013, LIFE-010 |
| SWAP_MODULE_DESTROYED | ERR-014, LIFE-011 |
| SWAP_ALREADY_INITIALIZED | ERR-015, LIFE-009 |

---

## Appendix C: DM Protocol Messages

### C.1 Party-to-Party Messages

| Type | Direction | Payload Fields |
|------|-----------|---------------|
| `swap_proposal` | Proposer -> Acceptor | `version`, `manifest: SwapManifest`, `escrow: string`, `message?` |
| `swap_acceptance` | Acceptor -> Proposer | `version`, `swap_id` |
| `swap_rejection` | Acceptor -> Proposer | `version`, `swap_id`, `reason?` |

### C.2 Client-to-Escrow Messages

| Type | Direction | Payload Fields |
|------|-----------|---------------|
| `announce` | Client -> Escrow | `manifest: SwapManifest` |
| `status` | Client -> Escrow | `swap_id` |

### C.3 Escrow-to-Client Messages

| Type | Direction | Payload Fields |
|------|-----------|---------------|
| `announce_result` | Escrow -> Client | `swap_id`, `deposit_invoice_id`, `state`, `created_at`, `is_new`, `error?` |
| `invoice_delivery` | Escrow -> Client | `swap_id`, `invoice_type: 'deposit'\|'payout'`, `invoice_id`, `invoice_token: TxfToken`, `payment_instructions?` |
| `payment_confirmation` | Escrow -> Both | `swap_id`, `payout_invoice_id`, `currency`, `amount`, `status` |
| `swap_cancelled` | Escrow -> Both | `swap_id`, `reason: 'timeout'`, `deposits_returned` |
| `bounce_notification` | Escrow -> Sender | `swap_id`, `reason: 'WRONG_CURRENCY'\|'ALREADY_COVERED'`, `returned_amount`, `returned_currency` |

### C.4 DM Content Format

All swap DMs use a structured JSON payload prefixed with the message type:

```
swap_proposal:{"version":1,"manifest":{...},"escrow":"DIRECT://eee..."}
```

The DM handler splits on the first `:` to extract the type prefix, then JSON-parses the remainder. This matches the pattern used by AccountingModule for `invoice_receipt:` and `invoice_cancellation:` DMs.

### C.5 Escrow DM Authentication

The module must verify that escrow-originated DMs (`announce_result`, `invoice_delivery`, `payment_confirmation`, `swap_cancelled`, `bounce_notification`) have a `senderPubkey` that matches the configured escrow address. DMs claiming to be from the escrow but originating from a different pubkey must be silently discarded.
