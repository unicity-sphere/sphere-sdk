# AccountingModule Test Suite Specification

> **Status:** Specification document (no code) for comprehensive test coverage of AccountingModule
> **Framework:** Vitest
> **Target Files:** `tests/unit/modules/AccountingModule.test.ts`, `tests/integration/accounting.test.ts`, `tests/scripts/test-e2e-accounting-cli.ts`
> **Scope:** Unit tests, E2E integration tests, CLI command tests covering all 15 API methods + 14 CLI commands

---

## Table of Contents

1. [Overview](#1-overview)
2. [Test Infrastructure](#2-test-infrastructure)
3. [Unit Tests](#3-unit-tests)
4. [E2E Integration Tests](#4-e2e-integration-tests)
5. [E2E CLI Tests](#5-e2e-cli-tests)
6. [Cross-Cutting Concerns](#6-cross-cutting-concerns)
7. [Appendix A: Test Matrix](#appendix-a-test-matrix)
8. [Appendix B: Error Code Coverage](#appendix-b-error-code-coverage)

---

## 1. Overview

### Purpose

Validate AccountingModule (§ ACCOUNTING-SPEC.md) through three test categories:

1. **Unit Tests** — Individual methods, state transitions, validation, error paths
2. **E2E Integration Tests** — Full workflows with realistic module instances (mocked providers)
3. **E2E CLI Tests** — All 14 CLI commands from §11 with real module + provider setup

### Scope

- **Methods tested:** All 15 public methods (load, destroy, createInvoice, importInvoice, getInvoiceStatus, getInvoices, getInvoice, closeInvoice, cancelInvoice, payInvoice, returnInvoicePayment, setAutoReturn, getAutoReturnSettings, sendInvoiceReceipts, sendCancellationNotices, getRelatedTransfers, parseInvoiceMemo)
- **Error codes:** All 38 error codes (§10)
- **State machine:** All transitions (OPEN → PARTIAL → COVERED → CLOSED/CANCELLED/EXPIRED)
- **Events:** All 19 event types with idempotency
- **Storage:** Persisted data (cancelled set, closed set, frozen balances, auto-return settings, invoice-transfer index)
- **Memo encoding:** All direction codes (F, B, RC, RX) and memo parsing
- **CLI:** All 14 commands, flag validation, prefix matching, output formats

### Test Framework

**Vitest** with the following patterns:
- `describe()` for test suites
- `it()` for individual tests
- `beforeEach()` for setup, `afterEach()` for cleanup
- Mock factories for providers (MockPaymentsModule, MockOracleProvider, MockStorageProvider, etc.)
- Test fixtures (sample invoices, tokens, transfers)

---

## 2. Test Infrastructure

### 2.1 Mock Factories

Each mock implements the full interface of its target to avoid partial stub issues.

#### MockPaymentsModule

```typescript
// Returns a mock with:
// - getBalance(): Promise<{ confirmed: number; unconfirmed: number }>
// - getTokens(filter?): Token[]
// - send(request: SendRequest): Promise<TransferResult>
// - getHistory(): HistoryRecord[]
// - on(event, handler): () => void (unsubscribe)
// - emit(event, data): void (for triggering test events)
// - l1: null (or MockL1PaymentsModule if needed)
```

#### MockOracleProvider

```typescript
// Returns a mock with:
// - validate(token): Promise<{ valid: boolean; proof?: any }>
// - submitTransaction(tx): Promise<{ success: boolean; txHash?: string }>
// - getStatus(txHash): Promise<TransactionStatus>
```

#### MockStorageProvider

```typescript
// Returns a mock with:
// - get(key): Promise<string | null>
// - set(key, value): Promise<void>
// - remove(key): Promise<void>
// - has(key): Promise<boolean>
// - clear(): Promise<void>
// (all operations backed by Map<string, string> for deterministic tests)
```

#### MockTokenStorageProvider

```typescript
// Returns a mock with:
// - loadTokens(addressId): Promise<Token[]>
// - saveTokens(addressId, tokens): Promise<void>
// - addToken(addressId, token): Promise<void>
// - removeToken(addressId, tokenId): Promise<void>
// - archiveToken(addressId, tokenId): Promise<void>
// - hasCoinData(addressId, coinId): Promise<boolean>
```

#### MockTransportProvider

```typescript
// Returns a mock with:
// - resolve(identifier): Promise<PeerInfo | null>
// - sendMessage(recipient, content): Promise<string>
// - onMessage(handler): () => void
// - sendTokenTransfer(recipient, token, proof): Promise<string>
// - onTokenTransfer(handler): () => void
```

#### MockCommunicationsModule

```typescript
// Returns a mock with:
// - sendDM(recipient, content): Promise<{ eventId: string }>
// - getConversation(peer): DirectMessage[]
// - on(event, handler): () => void
```

### 2.2 Test Fixtures

#### Sample Invoices

- **Single-target, single-asset:** `{ address: '@alice', assets: [{ coin: ['UCT', '10000000'] }] }`
- **Multi-target, multi-asset:** 2 targets × 2 assets (UCT + USDU)
- **100 targets (max):** Array of targets numbered 0-99
- **50 assets per target (max):** Single target with 50 different coins
- **With dueDate:** `createdAt: now, dueDate: now + 86400000` (1 day)
- **Anonymous:** `creator` field omitted
- **Long memo:** 4096-char string (max)
- **Large terms:** Just under 64 KB serialized

#### Sample Tokens

- **Valid invoice token:** Proper TXF format with INVOICE_TOKEN_TYPE_HEX, parsed InvoiceTerms in genesis.data.tokenData
- **Invalid token type:** Different tokenType
- **Corrupt tokenData:** Unparseable JSON in tokenData field
- **Invalid proof:** Broken inclusion proof chain
- **Zero-amount token:** Coin entry with amount "0"

#### Sample Transfers

- **Forward payment (F):** Transfer to invoice target address
- **Back payment (B):** Transfer from invoice target address
- **Return on close (RC):** Transfer with RC direction code
- **Return on cancel (RX):** Transfer with RX direction code
- **Masked sender:** Transfer with senderAddress = null
- **Unknown recipient:** Transfer to address not in invoice targets
- **Multi-coin transfer:** Single token with 2+ coin entries
- **Zero-amount in multi-coin:** Mixed zero and non-zero entries

#### Sample Balances

- **OPEN invoice:** No payments received
- **PARTIAL invoice:** Some assets partially covered
- **COVERED invoice:** All assets covered, some unconfirmed
- **CLOSED invoice:** Terminal, frozen balances persisted
- **CANCELLED invoice:** Terminal, frozen balances persisted
- **EXPIRED invoice:** dueDate in past, still OPEN/PARTIAL

### 2.3 Helper Utilities

#### `createTestInvoice(overrides?)`
Returns a minimal valid CreateInvoiceRequest with sensible defaults (1 target, 1 asset, future dueDate). Overrides merge with defaults.

#### `createTestToken(invoiceTerms)`
Returns a valid TxfToken with given terms in genesis.data.tokenData, proper INVOICE_TOKEN_TYPE_HEX, and valid proof chain.

#### `createTestTransfer(invoiceId, direction, amount, senderAddress?, recipientAddress?)`
Returns a HistoryRecord representing an on-chain transfer with INV:invoiceId:direction memo, targeting the given addresses.

#### `advanceTime(ms)`
Mocks `Date.now()` to simulate time passage (for dueDate tests, auto-return cooldown, etc.).

#### `resolveInvoicePrefix(invoices, prefix)`
Given array of InvoiceRef and a prefix string, returns matching invoices (simulates CLI prefix resolution).

#### `resolveTerminalState(status)`
Returns 'CLOSED' or 'CANCELLED' if status.state is terminal, else throws.

---

## 3. Unit Tests

### 3.1 Module Lifecycle

**File:** `tests/unit/modules/AccountingModule.lifecycle.test.ts`

#### UT-LIFECYCLE-001: load() with empty token storage
- **Preconditions:** Fresh module, no tokens in storage
- **Action:** Call `load()`
- **Expected:** Returns successfully; cancelled/closed sets are empty; no events fired
- **Spec ref:** §2.1 load() steps 1-4

#### UT-LIFECYCLE-002: load() with existing invoices
- **Preconditions:** Storage contains 3 invoice tokens (INVOICE_TOKEN_TYPE_HEX)
- **Action:** Call `load()`
- **Expected:** All 3 tokens parsed and indexed; cancelled/closed sets loaded from storage; subscribes to PaymentsModule events
- **Spec ref:** §2.1 load() steps 1-4

#### UT-LIFECYCLE-003: load() with pre-existing payments (retroactive events)
- **Preconditions:** 1 invoice in storage, full history contains 2 transfers referencing it
- **Action:** Call `load()`
- **Expected:** History scanned retroactively; payment + coverage events fired; no double events on subsequent transfer
- **Spec ref:** §2.1 load() step 5, §6.2 "On createInvoice() or importInvoice()"

#### UT-LIFECYCLE-004: load() clears previous in-memory state
- **Preconditions:** Module in use with 1 invoice, then `destroy()` is called, then module is re-initialized with different storage
- **Action:** Call `load()` on new storage with 0 invoices
- **Expected:** In-memory invoice map is cleared; previous invoice is no longer queryable
- **Spec ref:** §2.1 load() step 1 (enumerate tokens)

#### UT-LIFECYCLE-005: destroy() stops event listeners
- **Preconditions:** Module loaded with PaymentsModule listener registered
- **Action:** Call `destroy()`
- **Expected:** PaymentsModule 'transfer:incoming' listener is unsubscribed; subsequent transfers do not fire accounting events
- **Spec ref:** §2.1 destroy

#### UT-LIFECYCLE-006: destroy() is idempotent
- **Preconditions:** Module loaded
- **Action:** Call `destroy()` twice
- **Expected:** No error on second call; module state remains destroyed
- **Spec ref:** §2.1 destroy

#### UT-LIFECYCLE-007: MODULE_DESTROYED error on methods after destroy
- **Preconditions:** Module destroyed
- **Action:** Call each of: createInvoice(), getInvoices(), closeInvoice(), payInvoice(), etc.
- **Expected:** All throw SphereError with code MODULE_DESTROYED (except getInvoice(), getAutoReturnSettings(), parseInvoiceMemo() which remain callable)
- **Spec ref:** §10 MODULE_DESTROYED

#### UT-LIFECYCLE-008: MODULE_DESTROYED exempt methods remain callable
- **Preconditions:** Module destroyed
- **Action:** Call getInvoice('abc'), getAutoReturnSettings(), parseInvoiceMemo('memo')
- **Expected:** All return without error (in-memory, no I/O)
- **Spec ref:** §10 MODULE_DESTROYED

---

### 3.2 createInvoice()

**File:** `tests/unit/modules/AccountingModule.createInvoice.test.ts`

#### UT-CREATE-001: Simple invoice creation
- **Preconditions:** Module loaded, oracle available
- **Action:** `createInvoice({ targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '10000000'] }] }] })`
- **Expected:** Token minted on-chain; stored locally; event fired with invoiceId; result contains parsed terms
- **Spec ref:** §2.1 createInvoice(), §3 invoice minting

#### UT-CREATE-002: Creator pubkey auto-added when not anonymous
- **Preconditions:** Module loaded with identity
- **Action:** `createInvoice({ targets: [...], anonymous: false })`
- **Expected:** Minted token has creator field set to wallet's chainPubkey in terms
- **Spec ref:** §1.2 InvoiceTerms.creator

#### UT-CREATE-003: Creator pubkey omitted when anonymous
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [...], anonymous: true })`
- **Expected:** Minted token has creator field undefined in terms
- **Spec ref:** §1.2 InvoiceTerms.creator

#### UT-CREATE-004: createdAt timestamp set to local time
- **Preconditions:** Module loaded, `Date.now()` returns 1000
- **Action:** `createInvoice({ targets: [...] })`
- **Expected:** Minted token has createdAt: 1000 in terms
- **Spec ref:** §1.2 InvoiceTerms.createdAt

#### UT-CREATE-005: dueDate in the future is accepted
- **Preconditions:** Module loaded, now=1000
- **Action:** `createInvoice({ targets: [...], dueDate: 2000 })`
- **Expected:** Invoice created successfully; dueDate: 2000 in terms
- **Spec ref:** §8.1 "dueDate must be in the future"

#### UT-CREATE-006: dueDate in the past is rejected
- **Preconditions:** Module loaded, now=1000
- **Action:** `createInvoice({ targets: [...], dueDate: 500 })`
- **Expected:** Throws SphereError with INVOICE_PAST_DUE_DATE
- **Spec ref:** §8.1, §10 INVOICE_PAST_DUE_DATE

#### UT-CREATE-007: dueDate equal to now is rejected
- **Preconditions:** Module loaded, now=1000
- **Action:** `createInvoice({ targets: [...], dueDate: 1000 })`
- **Expected:** Throws SphereError with INVOICE_PAST_DUE_DATE
- **Spec ref:** §8.1

#### UT-CREATE-008: Empty targets array is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [] })`
- **Expected:** Throws SphereError with INVOICE_NO_TARGETS
- **Spec ref:** §8.1, §10 INVOICE_NO_TARGETS

#### UT-CREATE-009: Invalid target address format
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: 'invalid-format', assets: [...] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_ADDRESS
- **Spec ref:** §8.1, §10 INVOICE_INVALID_ADDRESS

#### UT-CREATE-010: Target with no assets is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: 'DIRECT://alice', assets: [] }] })`
- **Expected:** Throws SphereError with INVOICE_NO_ASSETS
- **Spec ref:** §8.1, §10 INVOICE_NO_ASSETS

#### UT-CREATE-011: Asset with both coin and nft is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: [...], nft: {...} }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_ASSET
- **Spec ref:** §8.1, §10 INVOICE_INVALID_ASSET

#### UT-CREATE-012: Asset with neither coin nor nft is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{}] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_ASSET
- **Spec ref:** §8.1, §10 INVOICE_INVALID_ASSET

#### UT-CREATE-013: Coin amount zero is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['UCT', '0'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_AMOUNT
- **Spec ref:** §8.1, §10 INVOICE_INVALID_AMOUNT

#### UT-CREATE-014: Coin amount negative is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['UCT', '-100'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_AMOUNT
- **Spec ref:** §8.1, §10 INVOICE_INVALID_AMOUNT

#### UT-CREATE-015: Coin amount non-integer is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['UCT', '10.5'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_AMOUNT
- **Spec ref:** §8.1, §10 INVOICE_INVALID_AMOUNT

#### UT-CREATE-016: Coin amount exceeding 78 digits is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['UCT', '1' + '0'.repeat(78)] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_AMOUNT
- **Spec ref:** §8.1, §10 INVOICE_INVALID_AMOUNT

#### UT-CREATE-017: Coin ID empty is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['', '1000'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_COIN
- **Spec ref:** §8.1, §10 INVOICE_INVALID_COIN

#### UT-CREATE-018: Coin ID non-alphanumeric is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['UC-T', '1000'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_COIN
- **Spec ref:** §8.1, §10 INVOICE_INVALID_COIN

#### UT-CREATE-019: Coin ID exceeding 20 chars is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ coin: ['A'.repeat(21), '1000'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_COIN
- **Spec ref:** §8.1, §10 INVOICE_INVALID_COIN

#### UT-CREATE-020: Duplicate target address is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: 'DIRECT://alice', assets: [...] }, { address: 'DIRECT://alice', assets: [...] }] })`
- **Expected:** Throws SphereError with INVOICE_DUPLICATE_ADDRESS
- **Spec ref:** §8.1, §10 INVOICE_DUPLICATE_ADDRESS

#### UT-CREATE-021: Duplicate coin ID within target is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '100'] }, { coin: ['UCT', '200'] }] }] })`
- **Expected:** Throws SphereError with INVOICE_DUPLICATE_COIN
- **Spec ref:** §8.1, §10 INVOICE_DUPLICATE_COIN

#### UT-CREATE-022: Duplicate NFT within target is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: 'DIRECT://alice', assets: [{ nft: { tokenId: '...' } }, { nft: { tokenId: '...' } }] }] })`
- **Expected:** Throws SphereError with INVOICE_DUPLICATE_NFT
- **Spec ref:** §8.1, §10 INVOICE_DUPLICATE_NFT

#### UT-CREATE-023: 100 targets (max) succeeds
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: array of 100 targets })`
- **Expected:** Invoice created successfully
- **Spec ref:** §8.1, §10 INVOICE_TOO_MANY_TARGETS

#### UT-CREATE-024: 101 targets (over max) is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: array of 101 targets })`
- **Expected:** Throws SphereError with INVOICE_TOO_MANY_TARGETS
- **Spec ref:** §8.1, §10 INVOICE_TOO_MANY_TARGETS

#### UT-CREATE-025: 50 assets per target (max) succeeds
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: array of 50 coins }] })`
- **Expected:** Invoice created successfully
- **Spec ref:** §8.1, §10 INVOICE_TOO_MANY_ASSETS

#### UT-CREATE-026: 51 assets per target (over max) is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: array of 51 coins }] })`
- **Expected:** Throws SphereError with INVOICE_TOO_MANY_ASSETS
- **Spec ref:** §8.1, §10 INVOICE_TOO_MANY_ASSETS

#### UT-CREATE-027: Memo 4096 chars (max) succeeds
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [...], memo: 'x'.repeat(4096) })`
- **Expected:** Invoice created successfully; memo stored in terms
- **Spec ref:** §8.1, §10 INVOICE_MEMO_TOO_LONG

#### UT-CREATE-028: Memo exceeding 4096 chars is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [...], memo: 'x'.repeat(4097) })`
- **Expected:** Throws SphereError with INVOICE_MEMO_TOO_LONG
- **Spec ref:** §8.1, §10 INVOICE_MEMO_TOO_LONG

#### UT-CREATE-029: Serialized terms 64 KB (max) succeeds
- **Preconditions:** Module loaded
- **Action:** `createInvoice()` with large targets/assets just under 64 KB
- **Expected:** Invoice created successfully
- **Spec ref:** §8.1, §10 INVOICE_TERMS_TOO_LARGE

#### UT-CREATE-030: Serialized terms exceeding 64 KB is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice()` with terms over 64 KB
- **Expected:** Throws SphereError with INVOICE_TERMS_TOO_LARGE
- **Spec ref:** §8.1, §10 INVOICE_TERMS_TOO_LARGE

#### UT-CREATE-031: Oracle not available is rejected
- **Preconditions:** Module initialized with no oracle
- **Action:** `createInvoice({ targets: [...] })`
- **Expected:** Throws SphereError with INVOICE_ORACLE_REQUIRED
- **Spec ref:** §8.1, §10 INVOICE_ORACLE_REQUIRED

#### UT-CREATE-032: Oracle mint failure is rejected
- **Preconditions:** Module loaded, oracle.submitTransaction() rejects
- **Action:** `createInvoice({ targets: [...] })`
- **Expected:** Throws SphereError with INVOICE_MINT_FAILED
- **Spec ref:** §8.1, §10 INVOICE_MINT_FAILED

#### UT-CREATE-033: Invalid deliveryMethods scheme is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [...], deliveryMethods: ['http://...'] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_DELIVERY_METHOD
- **Spec ref:** §8.1, §10 INVOICE_INVALID_DELIVERY_METHOD

#### UT-CREATE-034: deliveryMethods exceeding max length is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [...], deliveryMethods: ['https://' + 'x'.repeat(2049)] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_DELIVERY_METHOD
- **Spec ref:** §8.1, §10 INVOICE_INVALID_DELIVERY_METHOD

#### UT-CREATE-035: deliveryMethods exceeding 10 entries is rejected
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [...], deliveryMethods: array of 11 valid URLs })`
- **Expected:** Throws SphereError with INVOICE_INVALID_DELIVERY_METHOD
- **Spec ref:** §8.1, §10 INVOICE_INVALID_DELIVERY_METHOD

#### UT-CREATE-036: P2P async: payment already in history
- **Preconditions:** Module loaded, history contains transfer referencing non-existent invoice before createInvoice() is called
- **Action:** Create that invoice
- **Expected:** Retroactive payment event fired immediately; invoice terms stored
- **Spec ref:** §2.1 createInvoice() step 6

---

### 3.3 importInvoice()

**File:** `tests/unit/modules/AccountingModule.importInvoice.test.ts`

#### UT-IMPORT-001: Valid invoice token import
- **Preconditions:** Module loaded, valid invoice token in TXF format
- **Action:** `importInvoice(token)`
- **Expected:** Token stored; terms parsed and returned; no error
- **Spec ref:** §2.1 importInvoice()

#### UT-IMPORT-002: Token with invalid proof chain
- **Preconditions:** Module loaded, token with broken proof
- **Action:** `importInvoice(token)`
- **Expected:** Throws SphereError with INVOICE_INVALID_PROOF
- **Spec ref:** §8.2, §10 INVOICE_INVALID_PROOF

#### UT-IMPORT-003: Token with wrong tokenType
- **Preconditions:** Module loaded, token with non-INVOICE_TOKEN_TYPE_HEX type
- **Action:** `importInvoice(token)`
- **Expected:** Throws SphereError with INVOICE_WRONG_TOKEN_TYPE
- **Spec ref:** §8.2, §10 INVOICE_WRONG_TOKEN_TYPE

#### UT-IMPORT-004: Token with unparseable tokenData
- **Preconditions:** Module loaded, token with corrupt JSON in genesis.data.tokenData
- **Action:** `importInvoice(token)`
- **Expected:** Throws SphereError with INVOICE_INVALID_DATA
- **Spec ref:** §8.2, §10 INVOICE_INVALID_DATA

#### UT-IMPORT-005: Token with invalid business logic (e.g., empty targets)
- **Preconditions:** Module loaded, token with InvoiceTerms having empty targets array
- **Action:** `importInvoice(token)`
- **Expected:** Throws SphereError with INVOICE_INVALID_DATA (re-validates as per §8.1)
- **Spec ref:** §8.2

#### UT-IMPORT-006: Token already exists locally
- **Preconditions:** Module loaded with invoice already imported
- **Action:** `importInvoice(same token again)`
- **Expected:** Throws SphereError with INVOICE_ALREADY_EXISTS
- **Spec ref:** §8.2, §10 INVOICE_ALREADY_EXISTS

#### UT-IMPORT-007: Imported token with past dueDate is accepted
- **Preconditions:** Module loaded, token with dueDate in the past
- **Action:** `importInvoice(token)`
- **Expected:** Token imported successfully (dueDate validation is relaxed for imports per §8.2)
- **Spec ref:** §8.2 "except dueDate may be in the past for imported invoices"

#### UT-IMPORT-008: P2P async: pre-existing payments in history
- **Preconditions:** Module loaded, history contains transfer referencing the token being imported
- **Action:** `importInvoice(token)`
- **Expected:** Retroactive events fired for pre-existing transfers; terms returned
- **Spec ref:** §2.1 importInvoice() "scans full transaction history"

#### UT-IMPORT-009: createdAt timestamp validation (future allowed)
- **Preconditions:** Module loaded, token with createdAt = now + 3600000 (within 1-day clock skew)
- **Action:** `importInvoice(token)`
- **Expected:** Token imported successfully
- **Spec ref:** §8.2 "createdAt must not exceed Date.now() + 86400000"

#### UT-IMPORT-010: createdAt timestamp validation (too far future)
- **Preconditions:** Module loaded, token with createdAt = now + 86400001 (beyond 1-day skew)
- **Action:** `importInvoice(token)`
- **Expected:** Throws SphereError with INVOICE_INVALID_DATA
- **Spec ref:** §8.2

---

### 3.4 getInvoiceStatus()

**File:** `tests/unit/modules/AccountingModule.getInvoiceStatus.test.ts`

#### UT-STATUS-001: OPEN invoice with no payments
- **Preconditions:** Module with invoice created, no transfers
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Returns status with state: OPEN, all balances 0, allTargetsCovered: false
- **Spec ref:** §5 status computation

#### UT-STATUS-002: PARTIAL invoice (some assets covered)
- **Preconditions:** Module with invoice, 1 transfer covering asset A of target 0, asset B still at 0
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Returns PARTIAL; asset A shows covered, asset B shows 0
- **Spec ref:** §5 status computation

#### UT-STATUS-003: COVERED invoice (all assets covered, unconfirmed)
- **Preconditions:** Module with invoice, all requested assets covered but transfer unconfirmed
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Returns COVERED; allConfirmed: false
- **Spec ref:** §5 status computation

#### UT-STATUS-004: Terminal state CLOSED returns frozen balances
- **Preconditions:** Module with closed invoice
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Returns CLOSED with frozen balances from storage; does NOT recompute from history
- **Spec ref:** §2.1 getInvoiceStatus() "For terminal invoices (CLOSED, CANCELLED): returns persisted frozen balances"

#### UT-STATUS-005: Terminal state CANCELLED returns frozen balances
- **Preconditions:** Module with cancelled invoice
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Returns CANCELLED with frozen balances from storage
- **Spec ref:** §2.1 getInvoiceStatus()

#### UT-STATUS-006: Invoice not found
- **Preconditions:** Module loaded, no invoice with given ID
- **Action:** `getInvoiceStatus('nonexistent')`
- **Expected:** Throws SphereError with INVOICE_NOT_FOUND
- **Spec ref:** §8.8, §10 INVOICE_NOT_FOUND

#### UT-STATUS-007: Balance formula: net = forward - (back + return)
- **Preconditions:** Module with invoice, target receives 10 UCT forward, 3 UCT back
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Computed balance shows net: 7 UCT for that sender
- **Spec ref:** §2.1 getInvoiceStatus() "Balance formula per target:asset"

#### UT-STATUS-008: Implicit close trigger: all covered + all confirmed
- **Preconditions:** Module with invoice, all targets covered, all transfers confirmed
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Invokes implicit close: returns CLOSED with frozen balances, persists closed set, fires 'invoice:closed' event with explicit: false
- **Spec ref:** §5.1 step 7c, §6.2

#### UT-STATUS-009: Multi-coin balance aggregation
- **Preconditions:** Module with invoice requesting UCT + USDU; both received
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Balances computed per coin; target shows both coins covered
- **Spec ref:** §5.1 balance computation

#### UT-STATUS-010: Zero-amount coin entries are skipped
- **Preconditions:** Module with token containing UCT: 100, USDU: 0 in coinData
- **Action:** `getInvoiceStatus(invoiceId)` with this token received
- **Expected:** USDU: 0 entry does not produce transfer entry; balance stays at 0 for USDU
- **Spec ref:** §5.4.3 "Skip coin entries where amount is '0'"; §8.1 note on zero-value entries

#### UT-STATUS-011: Expiration flag when dueDate passed
- **Preconditions:** Module with invoice, dueDate in past, invoice still OPEN
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Fires 'invoice:expired' event; status.state remains OPEN; expirationDetected or similar flag set in status
- **Spec ref:** §6.2 step 7e; §6.4 expiration behavior

---

### 3.5 getInvoices() — Filtering & Pagination

**File:** `tests/unit/modules/AccountingModule.getInvoices.test.ts`

#### UT-INVOICES-001: List all invoices
- **Preconditions:** Module with 3 invoices
- **Action:** `getInvoices({})`
- **Expected:** Returns array of 3 InvoiceRef objects with full terms
- **Spec ref:** §2.1 getInvoices()

#### UT-INVOICES-002: Filter by state OPEN
- **Preconditions:** Module with 2 OPEN + 1 CLOSED invoices
- **Action:** `getInvoices({ state: ['OPEN'] })`
- **Expected:** Returns 2 OPEN invoices; status computed internally to apply filter but not returned
- **Spec ref:** §2.1 getInvoices() "When filtering by state, status IS computed per invoice"

#### UT-INVOICES-003: Filter by multiple states
- **Preconditions:** Module with OPEN, PARTIAL, CLOSED invoices
- **Action:** `getInvoices({ state: ['OPEN', 'PARTIAL'] })`
- **Expected:** Returns OPEN + PARTIAL; excludes CLOSED
- **Spec ref:** §2.1 getInvoices()

#### UT-INVOICES-004: Filter by createdByMe
- **Preconditions:** Module with 2 invoices created by me, 1 created by other
- **Action:** `getInvoices({ createdByMe: true })`
- **Expected:** Returns 2 invoices where creator === my chainPubkey
- **Spec ref:** §2.1 getInvoices() options

#### UT-INVOICES-005: Filter by targetingMe
- **Preconditions:** Module with 2 invoices targeting my address, 1 not
- **Action:** `getInvoices({ targetingMe: true })`
- **Expected:** Returns 2 invoices where my trackedAddress.directAddress is in targets
- **Spec ref:** §2.1 getInvoices() options

#### UT-INVOICES-006: Pagination: offset + limit
- **Preconditions:** Module with 10 invoices
- **Action:** `getInvoices({ offset: 5, limit: 3 })`
- **Expected:** Returns invoices 5, 6, 7 (3 items starting from offset 5)
- **Spec ref:** §2.1 getInvoices() "offset and limit applied AFTER filters"

#### UT-INVOICES-007: Pagination: offset past end
- **Preconditions:** Module with 5 invoices
- **Action:** `getInvoices({ offset: 10, limit: 5 })`
- **Expected:** Returns empty array
- **Spec ref:** §2.1 getInvoices() pagination

#### UT-INVOICES-008: Sort by createdAt descending (default)
- **Preconditions:** Module with invoices created at times 100, 200, 300
- **Action:** `getInvoices({ sort: 'createdAt', order: 'desc' })`
- **Expected:** Returns in order: 300, 200, 100
- **Spec ref:** §2.1 getInvoices() options

#### UT-INVOICES-009: Sort by dueDate ascending
- **Preconditions:** Module with invoices with dueDate 1000, 500, 2000
- **Action:** `getInvoices({ sort: 'dueDate', order: 'asc' })`
- **Expected:** Returns in order: 500, 1000, 2000
- **Spec ref:** §2.1 getInvoices() options

#### UT-INVOICES-010: State filter triggers implicit close
- **Preconditions:** Module with invoice that is COVERED + all confirmed (implicit close candidate)
- **Action:** `getInvoices({ state: ['COVERED'] })` (which recomputes status)
- **Expected:** Implicit close triggered; invoice moves to CLOSED; subsequent getInvoices returns it as CLOSED
- **Spec ref:** §2.1 getInvoices() "SIDE EFFECT: may trigger implicit close"

---

### 3.6 getInvoice()

**File:** `tests/unit/modules/AccountingModule.getInvoice.test.ts`

#### UT-GETINV-001: Get existing invoice
- **Preconditions:** Module with 1 invoice
- **Action:** `getInvoice(invoiceId)`
- **Expected:** Returns InvoiceRef with full terms; synchronous
- **Spec ref:** §2.1 getInvoice()

#### UT-GETINV-002: Get non-existent invoice
- **Preconditions:** Module loaded
- **Action:** `getInvoice('nonexistent')`
- **Expected:** Returns null; does NOT throw
- **Spec ref:** §2.1 getInvoice() "returns null if not found"

#### UT-GETINV-003: Synchronous operation (no async)
- **Preconditions:** Module with invoice
- **Action:** Verify `getInvoice()` is not async
- **Expected:** Method signature has no async; returns immediately
- **Spec ref:** §2.1 getInvoice() "Synchronous — cancelled/closed sets are kept in memory"

#### UT-GETINV-004: Returns lightweight data (no status computation)
- **Preconditions:** Module with invoice
- **Action:** `getInvoice(invoiceId)`
- **Expected:** Returned InvoiceRef has id + terms; no computed status field
- **Spec ref:** §2.1 getInvoice() "Get a single invoice. Synchronous — cancelled/closed sets are kept in memory"

---

### 3.7 closeInvoice()

**File:** `tests/unit/modules/AccountingModule.closeInvoice.test.ts`

#### UT-CLOSE-001: Close invoice explicitly
- **Preconditions:** Module with OPEN invoice, caller is target
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Balances frozen, closed set updated, 'invoice:closed' event with explicit: true
- **Spec ref:** §2.1 closeInvoice()

#### UT-CLOSE-002: Only target parties can close
- **Preconditions:** Module with invoice, caller is NOT a target
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Throws SphereError with INVOICE_NOT_TARGET
- **Spec ref:** §8.3, §10 INVOICE_NOT_TARGET

#### UT-CLOSE-003: Cannot close already-closed invoice
- **Preconditions:** Module with CLOSED invoice
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Throws SphereError with INVOICE_ALREADY_CLOSED
- **Spec ref:** §8.3, §10 INVOICE_ALREADY_CLOSED

#### UT-CLOSE-004: Cannot close already-cancelled invoice
- **Preconditions:** Module with CANCELLED invoice
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Throws SphereError with INVOICE_ALREADY_CANCELLED
- **Spec ref:** §8.3, §10 INVOICE_ALREADY_CANCELLED

#### UT-CLOSE-005: Close with autoReturn enabled (surplus only)
- **Preconditions:** Module with OPEN invoice, 15 UCT received (10 requested), caller is target, autoReturn enabled
- **Action:** `closeInvoice(invoiceId, { autoReturn: true })`
- **Expected:** Closes invoice; triggers auto-return of 5 UCT surplus only; fires 'invoice:auto_returned'
- **Spec ref:** §2.1 closeInvoice() step 4 "Returns SURPLUS ONLY"

#### UT-CLOSE-006: Caller address must match target directAddress exactly
- **Preconditions:** Module with invoice targeting DIRECT://abc, caller has trackedAddress DIRECT://abc
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Allowed; validates against directAddress not chainPubkey
- **Spec ref:** §8.3 "targets[].address is DIRECT://... — compare against directAddress"

#### UT-CLOSE-007: Invoice not found
- **Preconditions:** Module loaded
- **Action:** `closeInvoice('nonexistent')`
- **Expected:** Throws SphereError with INVOICE_NOT_FOUND
- **Spec ref:** §8.3, §10 INVOICE_NOT_FOUND

---

### 3.8 cancelInvoice()

**File:** `tests/unit/modules/AccountingModule.cancelInvoice.test.ts`

#### UT-CANCEL-001: Cancel invoice
- **Preconditions:** Module with OPEN invoice, caller is target
- **Action:** `cancelInvoice(invoiceId)`
- **Expected:** Balances frozen, cancelled set updated, 'invoice:cancelled' event fired
- **Spec ref:** §2.1 cancelInvoice()

#### UT-CANCEL-002: Only target parties can cancel
- **Preconditions:** Module with invoice, caller is NOT a target
- **Action:** `cancelInvoice(invoiceId)`
- **Expected:** Throws SphereError with INVOICE_NOT_TARGET
- **Spec ref:** §8.4, §10 INVOICE_NOT_TARGET

#### UT-CANCEL-003: Cannot cancel already-closed invoice
- **Preconditions:** Module with CLOSED invoice
- **Action:** `cancelInvoice(invoiceId)`
- **Expected:** Throws SphereError with INVOICE_ALREADY_CLOSED
- **Spec ref:** §8.4, §10 INVOICE_ALREADY_CLOSED

#### UT-CANCEL-004: Cannot cancel already-cancelled invoice
- **Preconditions:** Module with CANCELLED invoice
- **Action:** `cancelInvoice(invoiceId)`
- **Expected:** Throws SphereError with INVOICE_ALREADY_CANCELLED
- **Spec ref:** §8.4, §10 INVOICE_ALREADY_CANCELLED

#### UT-CANCEL-005: Cancel with autoReturn enabled (everything)
- **Preconditions:** Module with invoice, 15 UCT received (10 requested), autoReturn enabled
- **Action:** `cancelInvoice(invoiceId, { autoReturn: true })`
- **Expected:** Cancels invoice; auto-returns entire 15 UCT (NOT just surplus); fires 'invoice:auto_returned'
- **Spec ref:** §2.1 cancelInvoice() step 4 "Returns EVERYTHING"

#### UT-CANCEL-006: Invoice not found
- **Preconditions:** Module loaded
- **Action:** `cancelInvoice('nonexistent')`
- **Expected:** Throws SphereError with INVOICE_NOT_FOUND
- **Spec ref:** §8.4, §10 INVOICE_NOT_FOUND

---

### 3.9 payInvoice()

**File:** `tests/unit/modules/AccountingModule.payInvoice.test.ts`

#### UT-PAY-001: Simple payment to invoice
- **Preconditions:** Module with invoice requesting 10 UCT at target 0, asset 0
- **Action:** `payInvoice(invoiceId, { targetIndex: 0, assetIndex: 0, amount: '10000000' })`
- **Expected:** Sends transfer with INV:invoiceId:F memo; returns TransferResult
- **Spec ref:** §2.1 payInvoice()

#### UT-PAY-002: Memo contains invoice reference
- **Preconditions:** Module with invoice
- **Action:** `payInvoice(invoiceId, { ... })`
- **Expected:** On-chain memo includes INV:invoiceId:F prefix per §4 (verified by mock send)
- **Spec ref:** §4 invoice memo format

#### UT-PAY-003: Cannot pay terminated (CLOSED) invoice
- **Preconditions:** Module with CLOSED invoice
- **Action:** `payInvoice(invoiceId, { ... })`
- **Expected:** Throws SphereError with INVOICE_TERMINATED
- **Spec ref:** §8.5, §10 INVOICE_TERMINATED

#### UT-PAY-004: Cannot pay terminated (CANCELLED) invoice
- **Preconditions:** Module with CANCELLED invoice
- **Action:** `payInvoice(invoiceId, { ... })`
- **Expected:** Throws SphereError with INVOICE_TERMINATED
- **Spec ref:** §8.5, §10 INVOICE_TERMINATED

#### UT-PAY-005: Invalid target index
- **Preconditions:** Module with 1-target invoice
- **Action:** `payInvoice(invoiceId, { targetIndex: 5, assetIndex: 0, ... })`
- **Expected:** Throws SphereError with INVOICE_INVALID_TARGET
- **Spec ref:** §8.5, §10 INVOICE_INVALID_TARGET

#### UT-PAY-006: Invalid asset index
- **Preconditions:** Module with invoice with 1 asset per target
- **Action:** `payInvoice(invoiceId, { targetIndex: 0, assetIndex: 5, ... })`
- **Expected:** Throws SphereError with INVOICE_INVALID_ASSET_INDEX
- **Spec ref:** §8.5, §10 INVOICE_INVALID_ASSET_INDEX

#### UT-PAY-007: Invalid refund address format
- **Preconditions:** Module with invoice
- **Action:** `payInvoice(invoiceId, { ..., refundAddress: 'invalid' })`
- **Expected:** Throws SphereError with INVOICE_INVALID_REFUND_ADDRESS
- **Spec ref:** §8.5, §10 INVOICE_INVALID_REFUND_ADDRESS

#### UT-PAY-008: Invoice not found
- **Preconditions:** Module loaded
- **Action:** `payInvoice('nonexistent', { ... })`
- **Expected:** Throws SphereError with INVOICE_NOT_FOUND
- **Spec ref:** §8.5, §10 INVOICE_NOT_FOUND

#### UT-PAY-009: Contact auto-populated from identity.directAddress
- **Preconditions:** Module with invoice, identity.directAddress = 'DIRECT://myaddr'
- **Action:** `payInvoice(invoiceId, { ... })` without contact param
- **Expected:** Transfer sent with contact auto-populated; verified in mock send call
- **Spec ref:** §4.7 "Contact auto-population"

#### UT-PAY-010: Custom contact address provided
- **Preconditions:** Module with invoice
- **Action:** `payInvoice(invoiceId, { contact: { address: 'DIRECT://custom' } })`
- **Expected:** Transfer sent with given contact address
- **Spec ref:** §8.5 contact validation

#### UT-PAY-011: Invalid contact address is rejected
- **Preconditions:** Module with invoice
- **Action:** `payInvoice(invoiceId, { contact: { address: 'not-DIRECT' } })`
- **Expected:** Throws SphereError with INVOICE_INVALID_CONTACT
- **Spec ref:** §8.5, §10 INVOICE_INVALID_CONTACT

#### UT-PAY-012: Contact URL must use https:// or wss://
- **Preconditions:** Module with invoice
- **Action:** `payInvoice(invoiceId, { contact: { url: 'http://unsafe' } })`
- **Expected:** Throws SphereError with INVOICE_INVALID_CONTACT
- **Spec ref:** §8.5, §10 INVOICE_INVALID_CONTACT

---

### 3.10 returnInvoicePayment()

**File:** `tests/unit/modules/AccountingModule.returnInvoicePayment.test.ts`

#### UT-RETURN-001: Return payment to payer
- **Preconditions:** Module with invoice, target received 10 UCT from sender; caller is target
- **Action:** `returnInvoicePayment(invoiceId, { recipient: senderAddress, amount: '5000000', coinId: 'UCT' })`
- **Expected:** Sends return transfer with INV:invoiceId:B memo; returns TransferResult
- **Spec ref:** §2.1 returnInvoicePayment()

#### UT-RETURN-002: Return memo includes B direction code
- **Preconditions:** Module with invoice
- **Action:** `returnInvoicePayment(invoiceId, { ... })`
- **Expected:** On-chain memo includes INV:invoiceId:B
- **Spec ref:** §4 invoice memo format

#### UT-RETURN-003: Return exceeding per-sender net balance is rejected
- **Preconditions:** Module with invoice, sender has net balance 5 UCT (5 forwarded, 0 returned)
- **Action:** `returnInvoicePayment(invoiceId, { recipient: sender, amount: '10000000', ... })`
- **Expected:** Throws SphereError with INVOICE_RETURN_EXCEEDS_BALANCE
- **Spec ref:** §8.6, §10 INVOICE_RETURN_EXCEEDS_BALANCE

#### UT-RETURN-004: Only target parties can return
- **Preconditions:** Module with invoice, caller is NOT a target
- **Action:** `returnInvoicePayment(invoiceId, { ... })`
- **Expected:** Throws SphereError with INVOICE_NOT_TARGET
- **Spec ref:** §8.6, §10 INVOICE_NOT_TARGET

#### UT-RETURN-005: Invoice not found
- **Preconditions:** Module loaded
- **Action:** `returnInvoicePayment('nonexistent', { ... })`
- **Expected:** Throws SphereError with INVOICE_NOT_FOUND
- **Spec ref:** §8.6, §10 INVOICE_NOT_FOUND

#### UT-RETURN-006: Return from CLOSED invoice uses post-freeze balance
- **Preconditions:** Module with CLOSED invoice; before close, sender forwarded 10 UCT; after close, another 5 UCT arrived
- **Action:** `returnInvoicePayment(invoiceId, { recipient: sender, amount: '3000000', ... })`
- **Expected:** Return succeeds; effective returnable is frozen 0 (latest sender only) + post-freeze 5 = 5 total
- **Spec ref:** §8.6 "For CLOSED invoices: the frozen baseline starts at zero for all senders except the latest sender who gets the surplus"

#### UT-RETURN-007: Return from CANCELLED invoice uses post-freeze balance
- **Preconditions:** Module with CANCELLED invoice; frozen balance exists; post-cancellation transfer received
- **Action:** `returnInvoicePayment(invoiceId, { recipient: sender, amount: '3000000', ... })`
- **Expected:** Return succeeds; balance includes post-cancellation balance per §8.6
- **Spec ref:** §8.6 "For CANCELLED invoices: the frozen baseline preserves each sender's full pre-cancellation balance"

---

### 3.11 setAutoReturn() / getAutoReturnSettings()

**File:** `tests/unit/modules/AccountingModule.autoReturn.test.ts`

#### UT-AUTORET-001: Set auto-return globally
- **Preconditions:** Module loaded
- **Action:** `setAutoReturn('*', true)`
- **Expected:** Global auto-return enabled; stored in storage; subsequent getAutoReturnSettings() returns enabled
- **Spec ref:** §2.1 setAutoReturn()

#### UT-AUTORET-002: Disable global auto-return
- **Preconditions:** Module with global auto-return enabled
- **Action:** `setAutoReturn('*', false)`
- **Expected:** Global auto-return disabled; storage updated
- **Spec ref:** §2.1 setAutoReturn()

#### UT-AUTORET-003: Set auto-return for specific invoice
- **Preconditions:** Module with 2 invoices
- **Action:** `setAutoReturn(invoiceId1, true)`
- **Expected:** Only invoice 1 has auto-return enabled; invoice 2 unaffected
- **Spec ref:** §2.1 setAutoReturn()

#### UT-AUTORET-004: Global cooldown: 5-second window
- **Preconditions:** Module loaded, now=1000
- **Action:** `setAutoReturn('*', true)` then immediately `setAutoReturn('*', false)` within 5 seconds
- **Expected:** First call succeeds; second call within 5 seconds throws RATE_LIMITED; after 5 seconds, succeeds
- **Spec ref:** §8.7, §10 RATE_LIMITED

#### UT-AUTORET-005: Per-invoice setAutoReturn not rate-limited
- **Preconditions:** Module loaded
- **Action:** `setAutoReturn(invoiceId1, true)` then `setAutoReturn(invoiceId2, true)` immediately
- **Expected:** Both succeed; no rate limiting for per-invoice calls
- **Spec ref:** §8.7 "invoiceId === '*' called within 5-second cooldown"

#### UT-AUTORET-006: Get global auto-return setting
- **Preconditions:** Module loaded
- **Action:** `getAutoReturnSettings()`
- **Expected:** Returns AutoReturnSettings with global enabled/disabled status + per-invoice overrides
- **Spec ref:** §2.1 getAutoReturnSettings()

#### UT-AUTORET-007: Get per-invoice settings
- **Preconditions:** Module with 2 invoices, one with override true, one with override false
- **Action:** `getAutoReturnSettings()`
- **Expected:** Returns settings showing per-invoice status: { [invoiceId1]: true, [invoiceId2]: false }
- **Spec ref:** §2.1 getAutoReturnSettings()

#### UT-AUTORET-008: Set invoice auto-return non-existent invoice
- **Preconditions:** Module loaded
- **Action:** `setAutoReturn('nonexistent', true)`
- **Expected:** Throws SphereError with INVOICE_NOT_FOUND
- **Spec ref:** §8.7, §10 INVOICE_NOT_FOUND

---

### 3.12 Memo Encoding/Decoding

**File:** `tests/unit/modules/AccountingModule.memo.test.ts`

#### UT-MEMO-001: parseInvoiceMemo() with F direction
- **Preconditions:** N/A (offline utility)
- **Action:** `parseInvoiceMemo('INV:a1b2c3d4e5f6a7b8...:F Payment for consulting')`
- **Expected:** Returns { invoiceId: 'a1b2c3d4e5f6a7b8...', direction: 'forward', freeText: 'Payment for consulting' }
- **Spec ref:** §4 memo format

#### UT-MEMO-002: parseInvoiceMemo() with B direction
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:abc...:B')`
- **Expected:** Returns { invoiceId: 'abc...', direction: 'back', freeText: '' }
- **Spec ref:** §4

#### UT-MEMO-003: parseInvoiceMemo() with RC direction
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:abc...:RC')`
- **Expected:** Returns { invoiceId: 'abc...', direction: 'return_closed', freeText: '' }
- **Spec ref:** §4

#### UT-MEMO-004: parseInvoiceMemo() with RX direction
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:abc...:RX')`
- **Expected:** Returns { invoiceId: 'abc...', direction: 'return_cancelled', freeText: '' }
- **Spec ref:** §4

#### UT-MEMO-005: parseInvoiceMemo() with no match
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('Regular transfer memo')`
- **Expected:** Returns null
- **Spec ref:** §4

#### UT-MEMO-006: parseInvoiceMemo() with malformed ID
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:notahex:F text')`
- **Expected:** Returns null (fails regex validation)
- **Spec ref:** §4

#### UT-MEMO-007: parseInvoiceMemo() with uppercase/lowercase ID
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:A1B2C3D4e5f6a7b8...:F text')`
- **Expected:** Parses successfully (case-insensitive hex)
- **Spec ref:** §4

#### UT-MEMO-008: buildInvoiceMemo() creates valid F memo
- **Preconditions:** N/A
- **Action:** `buildInvoiceMemo(invoiceId, 'forward', 'payment text')`
- **Expected:** Returns 'INV:invoiceId:F payment text'
- **Spec ref:** §4

#### UT-MEMO-009: buildInvoiceMemo() invalid invoice ID
- **Preconditions:** N/A
- **Action:** `buildInvoiceMemo('short', 'forward', '')`
- **Expected:** Throws SphereError with INVOICE_INVALID_ID
- **Spec ref:** §10 INVOICE_INVALID_ID

#### UT-MEMO-010: buildInvoiceMemo() with free text
- **Preconditions:** N/A
- **Action:** `buildInvoiceMemo('a'.repeat(64), 'forward', 'custom text')`
- **Expected:** Returns memo with appended free text
- **Spec ref:** §4

---

### 3.13 Events (Idempotency & Firing)

**File:** `tests/unit/modules/AccountingModule.events.test.ts`

#### UT-EVENTS-001: invoice:created fires on creation
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ ... })`
- **Expected:** Event fired with { invoiceId, confirmed: false }
- **Spec ref:** §6.2 "On createInvoice()"

#### UT-EVENTS-002: invoice:created fires with confirmed: true once proof confirmed
- **Preconditions:** Module with invoice created
- **Action:** Trigger 'transfer:confirmed' event from PaymentsModule for mint proof
- **Expected:** Re-fires invoice:created with confirmed: true
- **Spec ref:** §6.2 "On PaymentsModule 'transfer:confirmed'"

#### UT-EVENTS-003: invoice:payment fires on transfer
- **Preconditions:** Module with invoice
- **Action:** Trigger 'transfer:incoming' with forward memo
- **Expected:** Event fired with { invoiceId, transfer, paymentDirection: 'forward' }
- **Spec ref:** §6.2 step 6a

#### UT-EVENTS-004: invoice:asset_covered fires
- **Preconditions:** Module with invoice
- **Action:** Trigger transfer that covers an asset
- **Expected:** Event fired with { invoiceId, address, coinId, confirmed }
- **Spec ref:** §6.2 step 7a

#### UT-EVENTS-005: invoice:target_covered fires
- **Preconditions:** Module with single-asset target
- **Action:** Trigger transfer covering all assets in target
- **Expected:** Event fired with { invoiceId, address, confirmed }
- **Spec ref:** §6.2 step 7b

#### UT-EVENTS-006: invoice:covered fires when all targets covered
- **Preconditions:** Module with 2-target invoice
- **Action:** Trigger transfers covering all targets
- **Expected:** Event fired with { invoiceId, confirmed: false } (initially unconfirmed)
- **Spec ref:** §6.2 step 7c

#### UT-EVENTS-007: invoice:closed fires on explicit close
- **Preconditions:** Module with invoice
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Event fired with { invoiceId, explicit: true }
- **Spec ref:** §6.2 implicit vs explicit

#### UT-EVENTS-008: invoice:closed fires on implicit close
- **Preconditions:** Module with COVERED + all-confirmed invoice
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Event fired with { invoiceId, explicit: false }
- **Spec ref:** §6.2 step 7c

#### UT-EVENTS-009: invoice:cancelled fires
- **Preconditions:** Module with invoice
- **Action:** `cancelInvoice(invoiceId)`
- **Expected:** Event fired with { invoiceId }
- **Spec ref:** §6.2 "On cancelInvoice()"

#### UT-EVENTS-010: invoice:overpayment fires
- **Preconditions:** Module with invoice requesting 10 UCT
- **Action:** Trigger transfer of 15 UCT
- **Expected:** Event fired with { invoiceId, address, coinId, surplus: '5000000', confirmed }
- **Spec ref:** §6.2 step 7d

#### UT-EVENTS-011: invoice:unknown_reference fires
- **Preconditions:** Module without invoice
- **Action:** Trigger 'transfer:incoming' with INV:nonexistent:F memo
- **Expected:** Event fired with { invoiceId: 'nonexistent', transfer }; transfer not indexed
- **Spec ref:** §6.2 step 2

#### UT-EVENTS-012: invoice:irrelevant fires for unknown address
- **Preconditions:** Module with invoice, transfer to unknown address
- **Action:** Trigger transfer
- **Expected:** Event fired with { invoiceId, transfer, reason: 'unknown_address' }
- **Spec ref:** §6.2 step 6b

#### UT-EVENTS-013: invoice:irrelevant fires for unknown asset
- **Preconditions:** Module with invoice requesting UCT, transfer of USDU
- **Action:** Trigger transfer
- **Expected:** Event fired with { invoiceId, transfer, reason: 'unknown_asset' }
- **Spec ref:** §6.2 step 6b

#### UT-EVENTS-014: invoice:irrelevant fires for self-payment
- **Preconditions:** Module with invoice, wallet is both creator and target
- **Action:** Trigger transfer from self to self
- **Expected:** Event fired with reason: 'self_payment'
- **Spec ref:** §6.2 step 6b

#### UT-EVENTS-015: invoice:irrelevant for unauthorized return
- **Preconditions:** Module with invoice, non-target sends :B memo
- **Action:** Trigger transfer with :B direction from non-target
- **Expected:** Event fired with reason: 'unauthorized_return'; transfer re-indexed as forward
- **Spec ref:** §6.2 step 3a

#### UT-EVENTS-016: invoice:expired fires when dueDate passed
- **Preconditions:** Module with invoice, dueDate in past, still OPEN
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Event fired with { invoiceId }
- **Spec ref:** §6.2 step 7e, §6.4

#### UT-EVENTS-017: Events are idempotent (fire multiple times)
- **Preconditions:** Module with invoice
- **Action:** Trigger same transfer twice (simulating Nostr re-delivery)
- **Expected:** Events fire both times; consumers must deduplicate
- **Spec ref:** §6.3 "Events may fire multiple times"

#### UT-EVENTS-018: invoice:auto_returned fires on close auto-return
- **Preconditions:** Module with 15 UCT received (10 requested), autoReturn enabled
- **Action:** `closeInvoice(invoiceId, { autoReturn: true })`
- **Expected:** Event fired with { invoiceId, originalTransfer, returnTransfer }
- **Spec ref:** §6.2 step 4 "fire 'invoice:auto_returned'"

#### UT-EVENTS-019: invoice:auto_returned fires on cancel auto-return
- **Preconditions:** Module with invoice, autoReturn enabled
- **Action:** `cancelInvoice(invoiceId, { autoReturn: true })`
- **Expected:** Event fired for each auto-returned payment
- **Spec ref:** §6.2 step 4

#### UT-EVENTS-020: invoice:return_received fires
- **Preconditions:** Module with invoice, target receives :RC transfer
- **Action:** Trigger incoming :RC transfer
- **Expected:** Event fired with { invoiceId, transfer, returnReason: 'closed' }
- **Spec ref:** §6.2 step 3b

#### UT-EVENTS-021: invoice:over_refund_warning fires
- **Preconditions:** Module with invoice, sender forwards 10 UCT then receives 15 UCT returned
- **Action:** Receive return transfer
- **Expected:** Event fired with { invoiceId, senderAddress, coinId, forwardedAmount: '10000000', returnedAmount: '15000000' }
- **Spec ref:** §6.2 step 3c

---

### 3.14 Storage (Persistence)

**File:** `tests/unit/modules/AccountingModule.storage.test.ts`

#### UT-STORAGE-001: Cancelled set persisted on cancel
- **Preconditions:** Module with invoice
- **Action:** `cancelInvoice(invoiceId)`
- **Expected:** invoiceId written to storage in cancelled set; survives load/destroy cycle
- **Spec ref:** §7 "Load cancelled set, closed set, frozen balances"

#### UT-STORAGE-002: Closed set persisted on close
- **Preconditions:** Module with invoice
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** invoiceId written to storage in closed set; survives reload
- **Spec ref:** §7 "frozen balances persisted locally"

#### UT-STORAGE-003: Frozen balances persisted on terminal transition
- **Preconditions:** Module with invoice in PARTIAL state
- **Action:** `closeInvoice(invoiceId)`
- **Expected:** Current balances frozen and stored; on subsequent getInvoiceStatus(), frozen balances returned without recompute
- **Spec ref:** §7.6 "frozen balance computation"

#### UT-STORAGE-004: Invoice-transfer index persisted
- **Preconditions:** Module with invoice, transfer received
- **Action:** Reload module (destroy + create + load)
- **Expected:** Transfer index preserved; getInvoiceStatus() returns same balance without rescanning history
- **Spec ref:** §7.4 "persistent invoice-transfer index"

#### UT-STORAGE-005: Auto-return settings persisted
- **Preconditions:** Module loaded
- **Action:** `setAutoReturn('*', true)` then reload
- **Expected:** Auto-return setting preserved across reload
- **Spec ref:** §7 storage keys

#### UT-STORAGE-006: Load reads correct storage keys
- **Preconditions:** Module with custom StorageProvider
- **Action:** Call `load()`
- **Expected:** Reads from STORAGE_KEYS_GLOBAL (or appropriate keys per spec)
- **Spec ref:** §7 storage keys

#### UT-STORAGE-007: Terminal state transition is atomic (write order)
- **Preconditions:** Module with invoice
- **Action:** `closeInvoice(invoiceId)` with injected crash simulation (save terminal set, then crash before saving frozen)
- **Expected:** On reload: if terminal set written but frozen not, recompute balances; if both written, use frozen
- **Spec ref:** §7.6 "Write order: terminal set FIRST, frozen balances SECOND"

---

### 3.15 Validation Rules (Comprehensive)

**File:** `tests/unit/modules/AccountingModule.validation.test.ts`

(All validation rules from §8 covered; sample test IDs provided, full matrix in Appendix B)

#### UT-VAL-001 through UT-VAL-120
[Each error code from §10 has at least one dedicated test case triggering the exact error condition]

---

### 3.16 Connect Protocol Extensions

**File:** `tests/unit/connect/AccountingModuleConnect.test.ts`

#### UT-CONNECT-001: RPC method sphere_getInvoices available
- **Preconditions:** Module loaded, ConnectClient/Host configured
- **Action:** Client calls `client.query('sphere_getInvoices')`
- **Expected:** Returns invoice list matching `getInvoices({})`
- **Spec ref:** §9 RPC methods

#### UT-CONNECT-002: RPC method sphere_getInvoiceStatus available
- **Preconditions:** Module loaded, ConnectClient/Host configured
- **Action:** Client calls `client.query('sphere_getInvoiceStatus', { invoiceId })`
- **Expected:** Returns status matching `getInvoiceStatus(invoiceId)`
- **Spec ref:** §9 RPC methods

#### UT-CONNECT-003: Intent create_invoice requires confirmation
- **Preconditions:** Module loaded, ConnectHost with onIntent handler
- **Action:** Client sends `client.intent('create_invoice', { ... })`
- **Expected:** onIntent handler called; requires explicit approval
- **Spec ref:** §9 intents

#### UT-CONNECT-004: Intent pay_invoice requires confirmation
- **Preconditions:** Module loaded
- **Action:** Client sends intent
- **Expected:** onIntent handler called
- **Spec ref:** §9 intents

#### UT-CONNECT-005: Permission scope invoice:read grants read access
- **Preconditions:** dApp approved with invoice:read scope
- **Action:** Client calls `query()` methods
- **Expected:** Allowed; write intents still blocked
- **Spec ref:** §9 permission scopes

#### UT-CONNECT-006: Permission scope intent:pay_invoice grants write access
- **Preconditions:** dApp approved with intent:pay_invoice scope
- **Action:** Client calls `intent('pay_invoice', ...)`
- **Expected:** Allowed after confirmation
- **Spec ref:** §9 permission scopes

---

## 4. E2E Integration Tests

**File:** `tests/integration/accounting.test.ts`

### 4.1 Full Invoice Lifecycle

#### IT-LIFECYCLE-001: Create → Pay → Close → Receipt
- **Setup:** Module with PaymentsModule + CommunicationsModule, 2 wallets (creator, payer)
- **Flow:**
  1. Creator calls `createInvoice()` on 10 UCT to payer
  2. Payer receives invoice, calls `importInvoice()`
  3. Payer calls `payInvoice()` (sends 10 UCT with INV memo)
  4. Creator receives transfer, status changes to COVERED
  5. Creator calls `closeInvoice()`
  6. Creator calls `sendInvoiceReceipts()`
  7. Payer receives receipt DM
- **Verify:**
  - Invoice moves through OPEN → PARTIAL → COVERED → CLOSED
  - All events fire in correct order
  - Receipt contains correct amount and memo
- **Spec ref:** §Appendix B full lifecycle

### 4.2 Multi-Target Invoices

#### IT-MULTI-001: Payment distribution across targets
- **Setup:** Module with 3-target invoice (10 UCT each to @alice, @bob, @charlie)
- **Flow:**
  1. createInvoice()
  2. @alice pays 10 UCT (target 0 covered)
  3. @bob pays 10 UCT (target 1 covered)
  4. Status should be PARTIAL (1/3 targets covered)
  5. @charlie pays 10 UCT (all targets covered)
  6. Status should be COVERED
- **Verify:** Correct target indexing; balance per target
- **Spec ref:** §5 status computation per target

### 4.3 Multi-Asset Targets

#### IT-MULTIASSET-001: Payment with multiple coins
- **Setup:** Module with 1 target requesting UCT + USDU
- **Flow:**
  1. createInvoice(address, [UCT: 100, USDU: 500])
  2. Receive 100 UCT (asset 0 covered)
  3. Status should be PARTIAL (asset 0 covered, asset 1 not)
  4. Receive 500 USDU (asset 1 covered)
  5. Status should be COVERED
- **Verify:** Per-asset balance tracking; asset coverage events
- **Spec ref:** §5 balance formula per target:asset

### 4.4 Auto-Return Workflows

#### IT-AUTORET-001: Close with auto-return (surplus only)
- **Setup:** Module with 10 UCT requested, 15 UCT received
- **Flow:**
  1. Receive 15 UCT forward
  2. closeInvoice({ autoReturn: true })
  3. Verify auto-return of 5 UCT with :RC memo
- **Verify:** Only surplus returned, not full amount
- **Spec ref:** §2.1 closeInvoice() "Returns SURPLUS ONLY"

#### IT-AUTORET-002: Cancel with auto-return (everything)
- **Setup:** Module with 10 UCT requested, 15 UCT received
- **Flow:**
  1. Receive 15 UCT forward
  2. cancelInvoice({ autoReturn: true })
  3. Verify auto-return of 15 UCT with :RX memo
- **Verify:** Full amount returned, not just surplus
- **Spec ref:** §2.1 cancelInvoice() "Returns EVERYTHING"

#### IT-AUTORET-003: Global auto-return on forward payment
- **Setup:** Module with global auto-return disabled; 2 invoices
- **Flow:**
  1. setAutoReturn('*', true)
  2. Create invoice, pay with surplus
  3. Verify surplus auto-returned with :RC memo
- **Verify:** Global setting applies to new invoices
- **Spec ref:** §2.1 setAutoReturn()

#### IT-AUTORET-004: Per-invoice auto-return override
- **Setup:** Module with global auto-return disabled
- **Flow:**
  1. Create 2 invoices
  2. setAutoReturn(invoiceId1, true)
  3. Pay invoice 1 with surplus → auto-return expected
  4. Pay invoice 2 with surplus → no auto-return
- **Verify:** Per-invoice override respected
- **Spec ref:** §2.1 setAutoReturn()

#### IT-AUTORET-005: Auto-return dedup by transferId (prevent double-return)
- **Setup:** Module with auto-return enabled; transfer arrives twice (Nostr re-delivery)
- **Flow:**
  1. Transfer arrives, auto-return sent, event fired
  2. Same transfer re-delivered
  3. Verify dedup ledger prevents second return
- **Verify:** Only one return sent for same original transfer
- **Spec ref:** §6.2 step 5 dedup ledger

### 4.5 Implicit Close

#### IT-IMPLICIT-001: Implicit close on all-covered + all-confirmed
- **Setup:** Module with invoice
- **Flow:**
  1. Receive transfers covering all targets
  2. All transfers unconfirmed: status COVERED, implicit close NOT triggered
  3. Trigger 'transfer:confirmed' for all transfers
  4. Call getInvoiceStatus()
- **Expected:** Implicit close triggered; status CLOSED with explicit: false
- **Verify:** Frozen balances persisted; no 'invoice:closed' event after implicit (gate acquisition + re-verify)
- **Spec ref:** §5.1 step 7c, §6.2 implicit close logic

### 4.6 Event Ordering and Idempotency

#### IT-EVENTS-001: Events fire in correct order
- **Setup:** Module with invoice
- **Flow:**
  1. Trigger payment
  2. Capture event sequence: invoice:payment → invoice:asset_covered → invoice:target_covered → invoice:covered
- **Verify:** Correct ordering
- **Spec ref:** §6.2 event firing order

#### IT-EVENTS-002: Events idempotent (same transfer re-delivered)
- **Setup:** Module with invoice, mock Nostr re-delivery of same transfer
- **Flow:**
  1. Transfer arrives, events fire
  2. Same transfer re-delivered
  3. Events fire again
- **Verify:** Events fire both times; consumers must handle duplication
- **Spec ref:** §6.3 idempotency contract

### 4.7 P2P Async (Payment Before Invoice)

#### IT-P2P-ASYNC-001: Payment arrives before invoice
- **Setup:** 2 module instances; payload module scans full history
- **Flow:**
  1. Payer sends payment with INV:nonexistent:F memo to aggregator
  2. Receiver's PaymentsModule receives transfer
  3. Receiver's AccountingModule fires 'invoice:unknown_reference'
  4. Receiver creates/imports invoice
  5. Retroactive payment events fire
- **Verify:** No duplicate events after import
- **Spec ref:** §2.1 createInvoice() step 6; §Appendix D P2P async

### 4.8 Frozen Balance Semantics (CLOSED vs CANCELLED)

#### IT-FROZEN-001: CLOSED invoice: latest sender gets surplus, others non-returnable
- **Setup:** Invoice requesting 10 UCT from one target
- **Flow:**
  1. Sender A forwards 5 UCT (status PARTIAL)
  2. Sender B forwards 5 UCT (status COVERED)
  3. closeInvoice()
  4. Frozen balance: A=0, B=5 (B is latest, gets remaining)
  5. Sender B can return up to 5 UCT post-close, Sender A cannot
- **Verify:** Frozen semantics per §8.6
- **Spec ref:** §8.6 CLOSED invoice return balance

#### IT-FROZEN-002: CANCELLED invoice: all senders preserve pre-cancel balance
- **Setup:** Invoice with 2 senders
- **Flow:**
  1. Sender A forwards 5 UCT, Sender B forwards 3 UCT
  2. cancelInvoice()
  3. Frozen balance: A=5, B=3 (both preserved)
  4. Both can return up to their frozen amount
- **Verify:** Frozen semantics per §8.6
- **Spec ref:** §8.6 CANCELLED invoice return balance

### 4.9 Masked Predicate Handling

#### IT-MASKED-001: Unauthorized return from masked sender
- **Setup:** Module with invoice, transfer from masked sender (senderAddress=null) with :B direction
- **Flow:**
  1. Receive transfer with senderAddress=null and :B direction
  2. Verify validation rejects unauthorized return
  3. Transfer re-indexed as forward, not as return
- **Verify:** invoice:irrelevant with reason 'unauthorized_return' fired
- **Spec ref:** §6.2 step 3a

#### IT-MASKED-002: Masked sender with refundAddress
- **Setup:** Module with invoice, payment from masked sender with refundAddress provided
- **Flow:**
  1. Receive forward payment (senderAddress=null, refundAddress provided)
  2. If auto-return enabled, auto-return should go to refundAddress
- **Verify:** Return sent to refundAddress, not null
- **Spec ref:** §7.5 auto-return resolution logic

### 4.10 Expiration Detection

#### IT-EXPIRATION-001: invoice:expired fires when due date passed
- **Setup:** Module with invoice, dueDate=now+1000
- **Flow:**
  1. Advance time to dueDate+1
  2. Call getInvoiceStatus()
  3. Verify invoice:expired event fired
- **Verify:** Event contains invoiceId
- **Spec ref:** §6.4 expiration behavior

---

## 5. E2E CLI Tests

**File:** `tests/scripts/test-e2e-accounting-cli.ts`

### 5.1-5.14: CLI Commands

Each CLI test runs the command via `npm run cli -- <cmd>` with real Sphere instance (mocked providers where needed).

#### CLI-001: invoice-create simple
- **Command:** `invoice-create @alice UCT 10.00 --memo "test"`
- **Verify:** Output contains invoice ID, target, amount; JSON format valid
- **Spec ref:** §11.2.1

#### CLI-002: invoice-create with dueDate duration
- **Command:** `invoice-create @alice UCT 10 --due 7d`
- **Verify:** Due date calculated as now + 7 days
- **Spec ref:** §11.2.1

#### CLI-003: invoice-create multi-target from JSON
- **Command:** `invoice-create --targets targets.json --memo "project"`
- **Verify:** Multiple targets created; output shows all targets
- **Spec ref:** §11.2.1

#### CLI-004: invoice-create invalid duration
- **Command:** `invoice-create @alice UCT 10 --due 0d`
- **Verify:** CLI error: "Invalid duration"; exit code 1
- **Spec ref:** §11.1 duration parsing

#### CLI-005: invoice-create targets file not found
- **Command:** `invoice-create --targets /nonexistent.json`
- **Verify:** CLI error: "File not found"; exit code 1
- **Spec ref:** §11.2.1

#### CLI-006: invoice-import
- **Command:** `invoice-import invoice.txf.json`
- **Verify:** Output shows invoice ID, creator, targets
- **Spec ref:** §11.2.2

#### CLI-007: invoice-status
- **Command:** `invoice-status a1b2c3d4`
- **Verify:** Full status output with balances, confirmed flag
- **Spec ref:** §11.2.3

#### CLI-008: invoice-status prefix matching
- **Command:** `invoice-status a1b`
- **Verify:** CLI error: "Prefix too short" (< 8 chars); exit code 1
- **Spec ref:** §11.1 "Prefix of at least 8 hex characters"

#### CLI-009: invoice-status ambiguous prefix
- **Command:** `invoice-status a1b2c3d4` (matches 2 invoices)
- **Verify:** CLI error: "Ambiguous"; lists matching IDs; exit code 1
- **Spec ref:** §11.1 invoice ID prefix matching

#### CLI-010: invoice-list default
- **Command:** `invoice-list`
- **Verify:** Shows up to 20 invoices; sorted by createdAt desc
- **Spec ref:** §11.2.4

#### CLI-011: invoice-list with state filter
- **Command:** `invoice-list --state OPEN,PARTIAL`
- **Verify:** Only OPEN + PARTIAL invoices shown
- **Spec ref:** §11.2.4

#### CLI-012: invoice-list with pagination
- **Command:** `invoice-list --offset 5 --limit 3`
- **Verify:** Shows invoices 5, 6, 7
- **Spec ref:** §11.2.4

#### CLI-013: invoice-info
- **Command:** `invoice-info a1b2c3d4`
- **Verify:** Shows creator, created date, targets, memo (no status computation)
- **Spec ref:** §11.2.5

#### CLI-014: invoice-close
- **Command:** `invoice-close a1b2c3d4`
- **Verify:** Output: "Invoice closed"; subsequent status shows CLOSED
- **Spec ref:** §11.2.6

#### CLI-015: invoice-cancel
- **Command:** `invoice-cancel a1b2c3d4`
- **Verify:** Output: "Invoice cancelled"; subsequent status shows CANCELLED
- **Spec ref:** §11.2.7

#### CLI-016: invoice-pay default amount
- **Command:** `invoice-pay a1b2c3d4` (no amount specified)
- **Verify:** Computes remaining balance; sends that amount; output shows actual amount sent
- **Spec ref:** §11.2.8 "Default amount: remaining"

#### CLI-017: invoice-pay specific target/asset
- **Command:** `invoice-pay a1b2c3d4 5.00 --target 1 --asset 0`
- **Verify:** Pays target 1, asset 0 with 5.00
- **Spec ref:** §11.2.8

#### CLI-018: invoice-pay with refund address
- **Command:** `invoice-pay a1b2c3d4 10 --refund-address DIRECT://refund`
- **Verify:** Transfer sent with refund address in contact
- **Spec ref:** §11.2.8

#### CLI-019: invoice-return
- **Command:** `invoice-return a1b2c3d4 DIRECT://sender 5.00 UCT`
- **Verify:** Return sent; output shows recipient + amount
- **Spec ref:** §11.2.9

#### CLI-020: invoice-auto-return show
- **Command:** `invoice-auto-return`
- **Verify:** Shows global + per-invoice settings
- **Spec ref:** §11.2.10

#### CLI-021: invoice-auto-return enable global
- **Command:** `invoice-auto-return --enable --global`
- **Verify:** Output: "Auto-return enabled globally"
- **Spec ref:** §11.2.10

#### CLI-022: invoice-auto-return disable per-invoice
- **Command:** `invoice-auto-return --disable --invoice a1b2c3d4`
- **Verify:** Output: "Auto-return disabled for invoice a1b2c3d4"
- **Spec ref:** §11.2.10

#### CLI-023: invoice-receipts
- **Command:** `invoice-receipts a1b2c3d4 --memo "Thank you!"`
- **Verify:** Output shows sent/failed counts; DMs sent to payers
- **Spec ref:** §11.2.11

#### CLI-024: invoice-cancel-notices
- **Command:** `invoice-cancel-notices a1b2c3d4 --reason "Out of stock"`
- **Verify:** Output shows sent/failed; DMs sent to payers
- **Spec ref:** §11.2.12

#### CLI-025: invoice-transfers
- **Command:** `invoice-transfers a1b2c3d4`
- **Verify:** Lists all related transfers chronologically with direction/status
- **Spec ref:** §11.2.13

#### CLI-026: invoice-parse-memo
- **Command:** `invoice-parse-memo "INV:a1b2c3d4:F Payment for consulting"`
- **Verify:** Output: "Invoice ID: a1b2c3d4, Direction: forward, Text: Payment for consulting"
- **Spec ref:** §11.2.14

#### CLI-027: invoice-parse-memo no match
- **Command:** `invoice-parse-memo "Regular memo"`
- **Verify:** Output: "No invoice reference found"
- **Spec ref:** §11.2.14

#### CLI-028: CLI --json output
- **Command:** `invoice-status a1b2c3d4 --json`
- **Verify:** Output is valid JSON; structure matches InvoiceStatus interface
- **Spec ref:** §11.1 "--json flag"

#### CLI-029: Module not available error
- **Preconditions:** Sphere initialized without AccountingModule
- **Command:** `invoice-list`
- **Verify:** Error: "Accounting module not available"; exit code 1
- **Spec ref:** §11.1 "Module guard"

#### CLI-030: getSphere() integration
- **Preconditions:** Sphere instance created
- **Verify:** All CLI commands successfully call getSphere() and obtain module
- **Spec ref:** §11.1 "getSphere() update required"

---

## 6. Cross-Cutting Concerns

### 6.1 Concurrency & Race Conditions

#### CONC-001: Per-invoice gate serialization
- **Setup:** Module with invoice; 2 async handlers (payment + closure)
- **Action:** Trigger payment and close simultaneously
- **Verify:** Per-invoice gate ensures close sees consistent index state; no data corruption
- **Spec ref:** §5.9 per-invoice gate

#### CONC-002: Return + close race
- **Setup:** Module with invoice, auto-return enabled
- **Action:** Return payment and explicit close race
- **Verify:** Both operations complete without deadlock; balance correct
- **Spec ref:** §6.2 gate acquisition

#### CONC-003: Auto-return dedup concurrent sends
- **Setup:** Module with invoice; same transfer arrives twice
- **Action:** Both trigger auto-return simultaneously
- **Verify:** Dedup ledger prevents duplicate return; only one sent
- **Spec ref:** §7.5 dedup ledger

### 6.2 Error Propagation

#### ERR-001: SDK-level errors during payInvoice pass through
- **Setup:** Module with invoice; PaymentsModule.send() fails with insufficient balance
- **Action:** `payInvoice(invoiceId, ...)`
- **Verify:** PaymentsModule error passes through unchanged
- **Spec ref:** §8.5 "Downstream errors: payInvoice() delegates to PaymentsModule.send()"

#### ERR-002: Internal accounting errors do not interrupt inbound transfer processing
- **Setup:** Module with invoice; processTokenTransactions() throws error
- **Action:** Trigger 'transfer:incoming' event
- **Verify:** Error caught, logged; PaymentsModule event processing continues
- **Spec ref:** §10 "accounting errors during inbound transfer event processing are caught internally"

#### ERR-003: DM delivery failures collected in results, not thrown
- **Setup:** Module with invoice; some recipients unresolvable
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Verify:** Partial success returned; failedReceipts array populated; no throw
- **Spec ref:** §8.9 "Per-sender DM delivery failures collected in failedReceipts"

### 6.3 Edge Cases

#### EDGE-001: Zero-amount coin in multi-coin token
- **Setup:** Token with UCT: 100, USDU: 0
- **Action:** Receive transfer; scan for INV reference
- **Verify:** USDU: 0 entry skipped; no balance entry, no event
- **Spec ref:** §8.1 note on zero-value entries; §5.4.3 skip rule

#### EDGE-002: Self-payment (creator is target)
- **Setup:** Invoice where creator is one of the targets
- **Action:** Creator pays their own invoice
- **Verify:** Fires invoice:irrelevant with reason 'self_payment'
- **Spec ref:** §6.2 step 6b

#### EDGE-003: Masked sender (senderAddress = null)
- **Setup:** Transfer with masked predicate and no refundAddress
- **Action:** If auto-return enabled, attempt auto-return
- **Verify:** Fires invoice:auto_return_failed with reason 'sender_unresolvable'
- **Spec ref:** §6.2 step 5 auto-return resolution

#### EDGE-004: Clock skew: createdAt in future
- **Setup:** Token with createdAt = now + 3600000 (within 1-day tolerance)
- **Action:** `importInvoice(token)`
- **Verify:** Accepted without error
- **Spec ref:** §8.2 clock skew tolerance

#### EDGE-005: DueDate expired at creation time
- **Setup:** createInvoice() with dueDate = now - 1
- **Action:** Call createInvoice
- **Verify:** Throws INVOICE_PAST_DUE_DATE
- **Spec ref:** §8.1 "dueDate must be in the future"

---

## Appendix A: Test Matrix

| Category | Test Count | Coverage |
|----------|-----------|----------|
| Module Lifecycle | 8 | load, destroy, MODULE_DESTROYED |
| createInvoice() | 36 | All validation rules + edge cases |
| importInvoice() | 10 | Validation + P2P async |
| getInvoiceStatus() | 11 | All state transitions + balance computation |
| getInvoices() | 10 | Filtering + pagination + sorting |
| getInvoice() | 4 | Lookup + sync behavior |
| closeInvoice() | 7 | Authorization + state + auto-return |
| cancelInvoice() | 6 | Authorization + state + auto-return |
| payInvoice() | 12 | Validation + direction codes + contact |
| returnInvoicePayment() | 7 | Balance validation + terminal state semantics |
| setAutoReturn() / getAutoReturnSettings() | 8 | Global + per-invoice + cooldown |
| Memo Encoding/Decoding | 10 | All direction codes + parse/build |
| Events (Idempotency & Firing) | 21 | All 19 event types + idempotency |
| Storage (Persistence) | 7 | Terminal sets + frozen balances + index |
| Validation Rules | 120+ | All 38 error codes (Appendix B) |
| Connect Protocol | 6 | RPC methods + intents + permissions |
| **Unit Tests Total** | **~330** | All methods + all error paths |
| **E2E Integration Tests** | **~40** | Full workflows + edge cases |
| **E2E CLI Tests** | **~30** | All 14 commands + error handling |
| **Grand Total** | **~400** | Comprehensive coverage |

---

## Appendix B: Error Code Coverage

Every error code from §10 MUST have at least one test case:

| Error Code | Test ID(s) | Precondition | Action | Expected |
|------------|-----------|--------------|--------|----------|
| `INVOICE_NO_TARGETS` | UT-CREATE-008 | Empty targets | createInvoice({targets:[]}) | INVOICE_NO_TARGETS |
| `INVOICE_INVALID_ADDRESS` | UT-CREATE-009 | Bad address | createInvoice with invalid DIRECT | INVOICE_INVALID_ADDRESS |
| `INVOICE_NO_ASSETS` | UT-CREATE-010 | Empty assets in target | createInvoice with assets:[] | INVOICE_NO_ASSETS |
| `INVOICE_INVALID_ASSET` | UT-CREATE-011, UT-CREATE-012 | Both/neither coin+nft | createInvoice | INVOICE_INVALID_ASSET |
| `INVOICE_INVALID_AMOUNT` | UT-CREATE-013 to UT-CREATE-016 | Zero/negative/non-int/78+ digits | createInvoice | INVOICE_INVALID_AMOUNT |
| `INVOICE_INVALID_COIN` | UT-CREATE-017 to UT-CREATE-019 | Empty/non-alphanumeric/20+ chars | createInvoice | INVOICE_INVALID_COIN |
| `INVOICE_INVALID_NFT` | UT-CREATE-021 | Non-64-hex NFT tokenId | createInvoice | INVOICE_INVALID_NFT |
| `INVOICE_PAST_DUE_DATE` | UT-CREATE-006, UT-CREATE-007 | dueDate ≤ now | createInvoice | INVOICE_PAST_DUE_DATE |
| `INVOICE_DUPLICATE_ADDRESS` | UT-CREATE-020 | Same address twice | createInvoice | INVOICE_DUPLICATE_ADDRESS |
| `INVOICE_DUPLICATE_COIN` | UT-CREATE-021 | Same coinId in target | createInvoice | INVOICE_DUPLICATE_COIN |
| `INVOICE_DUPLICATE_NFT` | UT-CREATE-022 | Same NFT in target | createInvoice | INVOICE_DUPLICATE_NFT |
| `INVOICE_MINT_FAILED` | UT-CREATE-032 | Oracle submitTransaction fails | createInvoice | INVOICE_MINT_FAILED |
| `INVOICE_INVALID_PROOF` | UT-IMPORT-002 | Token broken proof | importInvoice | INVOICE_INVALID_PROOF |
| `INVOICE_WRONG_TOKEN_TYPE` | UT-IMPORT-003 | Non-INVOICE tokenType | importInvoice | INVOICE_WRONG_TOKEN_TYPE |
| `INVOICE_INVALID_DATA` | UT-IMPORT-004, UT-IMPORT-005 | Unparseable/invalid terms | importInvoice | INVOICE_INVALID_DATA |
| `INVOICE_ALREADY_EXISTS` | UT-IMPORT-006 | Duplicate import | importInvoice | INVOICE_ALREADY_EXISTS |
| `INVOICE_NOT_FOUND` | UT-STATUS-006, UT-CLOSE-007, UT-PAY-008 | Unknown invoiceId | getInvoiceStatus/close/pay | INVOICE_NOT_FOUND |
| `INVOICE_NOT_TARGET` | UT-CLOSE-002, UT-CANCEL-002 | Caller not target | close/cancel/return | INVOICE_NOT_TARGET |
| `INVOICE_ALREADY_CLOSED` | UT-CLOSE-003, UT-CANCEL-003 | Close/cancel CLOSED | close/cancel | INVOICE_ALREADY_CLOSED |
| `INVOICE_ALREADY_CANCELLED` | UT-CLOSE-004, UT-CANCEL-004 | Close/cancel CANCELLED | close/cancel | INVOICE_ALREADY_CANCELLED |
| `INVOICE_ORACLE_REQUIRED` | UT-CREATE-031 | No oracle | createInvoice | INVOICE_ORACLE_REQUIRED |
| `INVOICE_TERMINATED` | UT-PAY-003, UT-PAY-004 | Pay CLOSED/CANCELLED | payInvoice | INVOICE_TERMINATED |
| `INVOICE_INVALID_TARGET` | UT-PAY-005 | Out-of-bounds targetIndex | payInvoice | INVOICE_INVALID_TARGET |
| `INVOICE_INVALID_ASSET_INDEX` | UT-PAY-006 | Out-of-bounds assetIndex | payInvoice | INVOICE_INVALID_ASSET_INDEX |
| `INVOICE_RETURN_EXCEEDS_BALANCE` | UT-RETURN-003 | Return > net balance | returnInvoicePayment | INVOICE_RETURN_EXCEEDS_BALANCE |
| `INVOICE_INVALID_DELIVERY_METHOD` | UT-CREATE-033 to UT-CREATE-035 | Invalid scheme/length/count | createInvoice | INVOICE_INVALID_DELIVERY_METHOD |
| `INVOICE_INVALID_REFUND_ADDRESS` | UT-PAY-007 | Invalid DIRECT:// | payInvoice | INVOICE_INVALID_REFUND_ADDRESS |
| `INVOICE_INVALID_CONTACT` | UT-PAY-011, UT-PAY-012 | Invalid contact | payInvoice | INVOICE_INVALID_CONTACT |
| `INVOICE_INVALID_ID` | UT-MEMO-009 | Short/invalid invoice ID | buildInvoiceMemo | INVOICE_INVALID_ID |
| `INVOICE_TOO_MANY_TARGETS` | UT-CREATE-024 | 101+ targets | createInvoice | INVOICE_TOO_MANY_TARGETS |
| `INVOICE_TOO_MANY_ASSETS` | UT-CREATE-026 | 51+ assets per target | createInvoice | INVOICE_TOO_MANY_ASSETS |
| `INVOICE_MEMO_TOO_LONG` | UT-CREATE-028 | Memo > 4096 | createInvoice | INVOICE_MEMO_TOO_LONG |
| `INVOICE_TERMS_TOO_LARGE` | UT-CREATE-030 | Terms > 64 KB | createInvoice | INVOICE_TERMS_TOO_LARGE |
| `RATE_LIMITED` | UT-AUTORET-004 | setAutoReturn('*') within 5s | setAutoReturn | RATE_LIMITED |
| `INVOICE_NOT_TERMINATED` | (E2E test) | sendReceipts on non-terminal | sendInvoiceReceipts | INVOICE_NOT_TERMINATED |
| `INVOICE_NOT_CANCELLED` | (E2E test) | sendCancellationNotices on CLOSED | sendCancellationNotices | INVOICE_NOT_CANCELLED |
| `COMMUNICATIONS_UNAVAILABLE` | (E2E test) | No CommunicationsModule | sendReceipts/notices | COMMUNICATIONS_UNAVAILABLE |
| `MODULE_DESTROYED` | UT-LIFECYCLE-007 | After destroy() | All I/O methods | MODULE_DESTROYED |

---

**END OF TEST SPECIFICATION**
