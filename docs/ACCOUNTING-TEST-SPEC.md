# AccountingModule Test Suite Specification

> **Status:** Specification document (no code) for comprehensive test coverage of AccountingModule
> **Framework:** Vitest
> **Target Files:** `tests/unit/modules/AccountingModule.test.ts`, `tests/integration/accounting.test.ts`, `tests/scripts/test-e2e-accounting-cli.ts`
> **Scope:** Unit tests covering all 17 API methods (fully specified). E2E integration and CLI test outlines (pending expansion).

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

- **Methods tested:** All 17 public methods (load, destroy, createInvoice, importInvoice, getInvoiceStatus, getInvoices, getInvoice, closeInvoice, cancelInvoice, payInvoice, returnInvoicePayment, setAutoReturn, getAutoReturnSettings, sendInvoiceReceipts, sendCancellationNotices, getRelatedTransfers, parseInvoiceMemo)
- **Error codes:** All 38 error codes (§10)
- **State machine:** All transitions (OPEN → PARTIAL → COVERED → CLOSED/CANCELLED/EXPIRED)
- **Events:** All 19 event types (including 4 DM-related) with idempotency
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
// - getTokens(filter?): Promise<Token[]>
// - getAssets(coinId?): Promise<Asset[]>
// - getHistory(limit?): HistoryRecord[]
// - send(request: SendRequest): Promise<TransferResult>
// - on(event, handler): () => void (unsubscribe)
// --- Test helpers (not part of PaymentsModule interface) ---
// - emit(event, data): void (for triggering test events)
// - l1: null (or MockL1PaymentsModule if needed)
```

#### MockOracleProvider

```typescript
// Returns a mock with:
// - validate(token): Promise<{ valid: boolean; proof?: any }>
// - submitTransaction(tx): Promise<{ success: boolean; txHash?: string; requestId?: string }>
// - getStatus(txHash): Promise<TransactionStatus>
// - trustBase(): Uint8Array
// - getStateTransitionClient(): StateTransitionClient
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
// - loadTokens(): Promise<Token[]>
// - saveToken(token): Promise<void>
// - addToken(token): Promise<void>
// - removeToken(tokenId): Promise<void>
// - archiveToken(tokenId): Promise<void>
// - clear(): Promise<void>
```

#### MockCommunicationsModule

```typescript
// Returns a mock with:
// - sendDM(recipient, content): Promise<{ eventId: string }>
// - getConversation(peer): DirectMessage[]
// - on(event, handler): () => void (supports 'message:dm' event emission)
// - emit(event, data): void (for test DM injection)
// NOTE: emit() must invoke all handlers registered via on('message:dm', handler).
// Use an internal EventEmitter to connect emit() → on() subscriptions.
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
- **Multi-coin token:** Token with 2+ coin entries in coinData
- **Invoice token (non-fungible):** coinData: null

#### Sample Transfers

- **Forward payment (F):** Transfer to invoice target address with TransferMessagePayload in message field
- **Back payment (B):** Transfer from invoice target address with :B direction in message
- **Return on close (RC):** Transfer with RC direction code in on-chain message
- **Return on cancel (RX):** Transfer with RX direction code in on-chain message
- **Masked sender:** Transfer with senderAddress = null
- **Unknown recipient:** Transfer to address not in invoice targets
- **Multi-coin transfer:** Single token with 2+ coin entries
- **Zero-amount in multi-coin:** Mixed zero and non-zero entries
- **Legacy fallback:** Transfer with message: null, fallback to HistoryRecord.memo

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
Returns a valid TxfToken with given terms in genesis.data.tokenData, proper INVOICE_TOKEN_TYPE_HEX = SHA-256(UTF-8("unicity.invoice.v1")), and valid proof chain (mocked for unit tests).

#### `createTestTransfer(invoiceId, direction, amount, senderAddress?, recipientAddress?)`
Returns a TxfToken with a transaction entry carrying a properly encoded TransferMessagePayload in the message field. The payload contains INV:invoiceId:direction reference. CRITICAL: Must produce proper on-chain message, not just HistoryRecord.memo. For legacy fallback tests, use createLegacyTestTransfer() instead. The message field must be a JSON string: JSON.stringify({ inv: { id: invoiceId, dir: direction } }). Encoding to bytes follows the same path as production code — consult txf-serializer.ts for the exact format.

#### `createLegacyTestTransfer(invoiceId, direction, amount, memo)`
Returns a HistoryRecord representing legacy transport-only memo transfer (message: null on TxfToken.transactions[]), used for testing §4.8 fallback path where on-chain message is null and module falls back to HistoryRecord.memo.

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
- **Expected:** Returns successfully; cancelled/closed sets are empty; no events fired; subscribes to PaymentsModule 'transfer:incoming' and 'history:updated'; subscribes to CommunicationsModule 'message:dm' if available
- **Spec ref:** §2.1 load() steps 1-7

#### UT-LIFECYCLE-002: load() with existing invoices
- **Preconditions:** Storage contains 3 invoice tokens (INVOICE_TOKEN_TYPE_HEX)
- **Action:** Call `load()`
- **Expected:** All 3 tokens parsed and indexed; cancelled/closed sets loaded from storage; subscribes to PaymentsModule events and CommunicationsModule if available; token scan watermark persisted
- **Spec ref:** §2.1 load() steps 1-4

#### UT-LIFECYCLE-003: load() with pre-existing payments (retroactive events)
- **Preconditions:** 1 invoice in storage, full history contains 2 transfers referencing it
- **Action:** Call `load()`
- **Expected:** History scanned retroactively via Phase 1 and 2; payment + coverage events fired; no double events on subsequent transfer
- **Spec ref:** §2.1 load() step 5, §6.2 "On createInvoice() or importInvoice()"

#### UT-LIFECYCLE-004: load() clears previous in-memory state
- **Preconditions:** Module in use with 1 invoice, then `destroy()` is called, then module is re-initialized with different storage
- **Action:** Call `load()` on new storage with 0 invoices
- **Expected:** In-memory invoice map is cleared; previous invoice is no longer queryable
- **Spec ref:** §2.1 load() step 1 (enumerate tokens)

#### UT-LIFECYCLE-005: destroy() stops event listeners
- **Preconditions:** Module loaded with PaymentsModule listener registered
- **Action:** Call `destroy()`
- **Expected:** PaymentsModule 'transfer:incoming' and 'history:updated' listeners are unsubscribed; CommunicationsModule 'message:dm' listener unsubscribed; subsequent transfers/DMs do not fire accounting events
- **Spec ref:** §2.1 destroy

#### UT-LIFECYCLE-006: destroy() is idempotent
- **Preconditions:** Module loaded
- **Action:** Call `destroy()` twice
- **Expected:** No error on second call; module state remains destroyed
- **Spec ref:** §2.1 destroy

#### UT-LIFECYCLE-007: MODULE_DESTROYED error on I/O methods after destroy
- **Preconditions:** Module destroyed
- **Action:** Call each of: createInvoice(), importInvoice(), getInvoices(), getInvoiceStatus(), closeInvoice(), cancelInvoice(), payInvoice(), returnInvoicePayment(), setAutoReturn(), sendInvoiceReceipts(), sendCancellationNotices(), getRelatedTransfers()
- **Expected:** All throw SphereError with code MODULE_DESTROYED
- **Spec ref:** §10 MODULE_DESTROYED

#### UT-LIFECYCLE-008: MODULE_DESTROYED exempt methods remain callable
- **Preconditions:** Module destroyed
- **Action:** Call getInvoice('abc'), getAutoReturnSettings() (synchronous), parseInvoiceMemo('memo')
- **Expected:** All return without error (in-memory, no I/O)
- **Spec ref:** §10 MODULE_DESTROYED

#### UT-LIFECYCLE-009: Load-subscribe gap re-scan
- **Preconditions:** Module starts load(); a new transfer arrives referencing a known invoice between initial scan and subscription registration
- **Action:** Complete load(); await re-scan completion
- **Mechanism:** Mock PaymentsModule.getHistory() to return different results on first vs. second call (simulating new arrivals during load-subscribe gap). Verify the second call is made and events fire for the newly discovered transfer.
- **Expected:** Re-scan detects the gap transfer; appropriate events fire
- **Spec ref:** §7.6 load() step 7b "Load-subscribe gap"

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
- **Preconditions:** Module loaded; targets array with 1 valid target + 1 valid asset
- **Action:** `createInvoice({ targets: [...], deliveryMethods: ['http://example.com/pay'] })` — note `http://` not `https://`
- **Expected:** Throws SphereError with INVOICE_INVALID_DELIVERY_METHOD; only `https://` and `wss://` schemes accepted
- **Spec ref:** §8.1, §10 INVOICE_INVALID_DELIVERY_METHOD

#### UT-CREATE-034: deliveryMethods URL exceeding 2048 characters is rejected
- **Preconditions:** Module loaded; targets array with 1 valid target + 1 valid asset
- **Action:** `createInvoice({ targets: [...], deliveryMethods: ['https://' + 'x'.repeat(2041)] })` — total URL length = 2049 chars (exceeds 2048 limit)
- **Expected:** Throws SphereError with INVOICE_INVALID_DELIVERY_METHOD; individual URL must not exceed 2048 characters
- **Spec ref:** §8.1, §10 INVOICE_INVALID_DELIVERY_METHOD

#### UT-CREATE-035: deliveryMethods array exceeding 10 entries is rejected
- **Preconditions:** Module loaded; targets array with 1 valid target + 1 valid asset
- **Action:** `createInvoice({ targets: [...], deliveryMethods: Array.from({length: 11}, (_, i) => 'https://example.com/pay/' + i) })` — 11 valid URLs
- **Expected:** Throws SphereError with INVOICE_INVALID_DELIVERY_METHOD; maximum 10 delivery methods allowed
- **Spec ref:** §8.1, §10 INVOICE_INVALID_DELIVERY_METHOD

#### UT-CREATE-036: P2P async: payment already in history
- **Preconditions:** Module loaded, history contains transfer referencing non-existent invoice before createInvoice() is called
- **Action:** Create that invoice
- **Expected:** Retroactive payment event fired immediately; invoice terms stored
- **Spec ref:** §2.1 createInvoice() flow step 6; see also ARCHITECTURE.md §7.3 P2P Async

#### UT-CREATE-037: Invalid NFT tokenId (non-64-hex)
- **Preconditions:** Module loaded
- **Action:** `createInvoice({ targets: [{ address: '...', assets: [{ nft: { tokenId: 'not-hex' } }] }] })`
- **Expected:** Throws SphereError with INVOICE_INVALID_NFT
- **Spec ref:** §8.1, §10 INVOICE_INVALID_NFT

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
- **Spec ref:** §2.1 importInvoice() "scans full transaction history"; see also ARCHITECTURE.md §7.3 P2P Async

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
- **Action:** `getInvoiceStatus(invoiceId)` twice
- **Expected:** First call returns CLOSED with frozen balances from storage; does NOT recompute from history. Second call also returns same frozen state (idempotent).
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
- **Expected:** Fires 'invoice:expired' event; status.state becomes EXPIRED (not OPEN)
- **Spec ref:** §5.1 step 7e; expiration behavior

#### UT-STATUS-012: PARTIAL → OPEN (all forward payments returned via :B)
- **Preconditions:** Module with PARTIAL invoice; sender forwarded 5 UCT, then sent return :B for 5 UCT
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Status reverts to OPEN; all balances zero again
- **Spec ref:** §5.7 EXPIRED State Semantics (reverse transitions)

#### UT-STATUS-013: COVERED → PARTIAL (return reduces below full coverage)
- **Preconditions:** Module with COVERED invoice; 10 UCT required, 12 received; then :B return of 3 UCT
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Status changes from COVERED to PARTIAL (9 UCT net, below 10 required)
- **Spec ref:** §5.7 EXPIRED State Semantics (reverse transitions)

#### UT-STATUS-014: COVERED → CANCELLED (explicit cancel from COVERED)
- **Preconditions:** Module with COVERED invoice
- **Action:** `cancelInvoice(invoiceId)` then `getInvoiceStatus(invoiceId)`
- **Expected:** Status is CANCELLED; frozen balances persisted
- **Spec ref:** §5.1 status computation; ARCHITECTURE.md §4.2 state transitions

#### UT-STATUS-015: EXPIRED → COVERED (all payments arrive after dueDate)
- **Preconditions:** Module with invoice, dueDate passed, invoice is EXPIRED (partial), then final payment arrives covering all targets
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Status changes to COVERED (not EXPIRED), as all targets now covered
- **Spec ref:** §5.7 "EXPIRED is NOT reachable from COVERED" (converse: coverage is recomputed)

#### UT-STATUS-016: EXPIRED → CLOSED (all confirmed after due date)
- **Preconditions:** Module with EXPIRED invoice, all confirmed
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Implicit close triggered; status is CLOSED
- **Spec ref:** §5.1 step 7c

#### UT-STATUS-017: EXPIRED → CANCELLED (explicit cancel from EXPIRED state)
- **Preconditions:** Module with EXPIRED invoice
- **Action:** `cancelInvoice(invoiceId)` then `getInvoiceStatus(invoiceId)`
- **Expected:** Status is CANCELLED
- **Spec ref:** §5.1 status computation; ARCHITECTURE.md §4.2 state transitions

#### UT-STATUS-018: EXPIRED stays EXPIRED after return (not OPEN)
- **Preconditions:** Module with EXPIRED invoice (partially covered, past due), then :B return reducing coverage to zero
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Status stays EXPIRED (not OPEN), because step 7e priority (EXPIRED check) fires before 7f (state computation)
- **Spec ref:** §5.1 step 7e-7f ordering

#### UT-STATUS-019: COVERED with past dueDate remains COVERED (not EXPIRED)
- **Preconditions:** Module with COVERED invoice whose dueDate is now in the past
- **Action:** `getInvoiceStatus(invoiceId)`
- **Expected:** Status is COVERED, not EXPIRED (all targets covered supersedes dueDate check)
- **Spec ref:** §5.7 "EXPIRED is NOT reachable from COVERED"

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
- **Action:** `getInvoices({ sortBy: 'createdAt', sortOrder: 'desc' })`
- **Expected:** Returns in order: 300, 200, 100
- **Spec ref:** §2.1 getInvoices() options

#### UT-INVOICES-009: Sort by dueDate ascending with null-last
- **Preconditions:** Module with invoices with dueDate [1000, none, 500, 2000]
- **Action:** `getInvoices({ sortBy: 'dueDate', sortOrder: 'asc' })`
- **Expected:** Returns in order: 500, 1000, 2000, [undated] (null-last ordering)
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
- **Expected:** Sends transfer with INV:invoiceId:F memo in on-chain message; returns TransferResult
- **Spec ref:** §2.1 payInvoice()

#### UT-PAY-002: Memo contains invoice reference
- **Preconditions:** Module with invoice
- **Action:** `payInvoice(invoiceId, { ... })`
- **Expected:** On-chain message includes INV:invoiceId:F prefix per §4 (verified by mock send)
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
- **Preconditions:** Module with CLOSED invoice; before close, sender A forwarded 5 UCT; before close, sender B forwarded 5 UCT (latest); after close, another 5 UCT arrived from new sender C
- **Action:** `returnInvoicePayment(invoiceId, { recipient: senderB, amount: '3000000', ... })`
- **Expected:** Return succeeds; sender A frozen=0 (not latest), sender B frozen=5 (latest, gets surplus)
- **Follow-up assertion:** Also verify: returnInvoicePayment(invoiceId, { recipient: senderA, amount: '1', coin: 'UCT' }) throws INVOICE_RETURN_EXCEEDS_BALANCE (sender A frozen balance is 0 under latest-sender semantics)
- **Spec ref:** §8.6 "For CLOSED invoices: the frozen baseline starts at zero for all senders except the latest sender who gets the surplus"

#### UT-RETURN-007: Return from CANCELLED invoice uses post-freeze balance
- **Preconditions:** Module with CANCELLED invoice; frozen balance exists for sender A (5 UCT); post-cancellation transfer received from sender A (3 more UCT)
- **Action:** `returnInvoicePayment(invoiceId, { recipient: senderA, amount: '6000000', ... })`
- **Expected:** Return succeeds; effective returnable = frozen 5 + post-freeze 3 = 8 total
- **Boundary assertion:** Also verify: returnInvoicePayment with amount '8000001' throws INVOICE_RETURN_EXCEEDS_BALANCE (cap = frozen 5 + post-freeze 3 = 8)
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
- **Action:** Call `setAutoReturn('*', true)` (succeeds at t=1000); call `setAutoReturn('*', false)` at t=4999; call again at t=5001
- **Expected:** First call succeeds; second call within 5 seconds throws RATE_LIMITED; third call after 5 seconds succeeds
- **Spec ref:** §8.7, §10 RATE_LIMITED

#### UT-AUTORET-005: Per-invoice setAutoReturn not rate-limited
- **Preconditions:** Module loaded
- **Action:** `setAutoReturn(invoiceId1, true)` then `setAutoReturn(invoiceId2, true)` immediately
- **Expected:** Both succeed; no rate limiting for per-invoice calls
- **Spec ref:** §8.7 "invoiceId === '*' called within 5-second cooldown"

#### UT-AUTORET-006: Get global auto-return setting (synchronous)
- **Preconditions:** Module loaded
- **Action:** `getAutoReturnSettings()` (note: synchronous, no await needed)
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
- **Expected:** Returns { invoiceId: 'a1b2c3d4e5f6a7b8...', paymentDirection: 'forward', freeText: 'Payment for consulting' }
- **Spec ref:** §4 memo format

#### UT-MEMO-002: parseInvoiceMemo() with B direction
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:abc...:B')`
- **Expected:** Returns { invoiceId: 'abc...', paymentDirection: 'back', freeText: '' }
- **Spec ref:** §4

#### UT-MEMO-003: parseInvoiceMemo() with RC direction
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:abc...:RC')`
- **Expected:** Returns { invoiceId: 'abc...', paymentDirection: 'return_closed', freeText: '' }
- **Spec ref:** §4

#### UT-MEMO-004: parseInvoiceMemo() with RX direction
- **Preconditions:** N/A
- **Action:** `parseInvoiceMemo('INV:abc...:RX')`
- **Expected:** Returns { invoiceId: 'abc...', paymentDirection: 'return_cancelled', freeText: '' }
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

#### UT-MEMO-011: Legacy fallback — on-chain message null, transport memo INV: reference
- **Preconditions:** Module loaded with invoice; transfer token has TxfTransaction.data.message = null (no on-chain message)
- **Action:** Process transfer where HistoryRecord.memo contains 'INV:invoiceId:F Payment text'
- **Expected:** Fallback path activates; transfer indexed correctly against the invoice; invoice:payment event fires
- **Spec ref:** §4.8 legacy fallback path

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
- **Action:** Trigger 'transfer:confirmed' event from PaymentsModule for mint proof via tokenId map
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

#### UT-EVENTS-011: invoice:expired fires
- **Preconditions:** Module with invoice, dueDate in the past
- **Action:** Call `getInvoiceStatus(invoiceId)`
- **Expected:** Event fired with { invoiceId }
- **Spec ref:** §6.2 step 7e

#### UT-EVENTS-012: invoice:return_received fires on :RC/:RX transfer
- **Preconditions:** Module with invoice
- **Action:** Trigger transfer with RC direction code from target
- **Expected:** Event fired with { invoiceId, transfer, returnReason: 'closed' }
- **Spec ref:** §6.2 step 5

#### UT-EVENTS-013: invoice:irrelevant fires for transfer to unknown address
- **Preconditions:** Module with invoice targeting @alice
- **Action:** Trigger transfer referencing the invoice but sent to @bob (not a target)
- **Expected:** Event fired with { invoiceId, transfer, reason: 'unknown_address', confirmed }
- **Spec ref:** §6.2 step 6c

#### UT-EVENTS-014: invoice:irrelevant with reason 'unauthorized_return'
- **Preconditions:** Module with invoice; transfer from masked sender with :B direction
- **Action:** Trigger transfer
- **Expected:** Event fired with reason 'unauthorized_return'
- **Spec ref:** §6.2 step 3a

#### UT-EVENTS-015: invoice:irrelevant with reason 'self_payment'
- **Preconditions:** Module with invoice where creator is a target
- **Action:** Creator sends payment to own invoice
- **Expected:** Event fired with reason 'self_payment'
- **Spec ref:** §6.2 step 6b

#### UT-EVENTS-016: invoice:irrelevant with reason 'no_coin_data'
- **Preconditions:** Module with invoice; transfer of invoice token itself (coinData: null)
- **Action:** Receive transfer
- **Expected:** Event fired with reason 'no_coin_data'
- **Spec ref:** §5.3 empty coinData handling

#### UT-EVENTS-017: invoice:auto_returned fires on successful auto-return
- **Preconditions:** Module with invoice, terminal state, auto-return enabled, balance available
- **Action:** Trigger implicit auto-return via terminal state trigger
- **Expected:** Event fired with { invoiceId, originalTransfer, returnTransfer }
- **Spec ref:** §6.2 step 5

#### UT-EVENTS-018: invoice:auto_return_failed fires on send failure
- **Preconditions:** Module with invoice, auto-return enabled; PaymentsModule.send() throws
- **Action:** Trigger inbound transfer causing auto-return attempt
- **Expected:** Event fired with { invoiceId, reason: 'send_failed' }
- **Spec ref:** §4.5 auto-return failure

#### UT-EVENTS-019: Repeated transfer delivery does not double-count balance (events fire twice)
- **Preconditions:** Module with invoice
- **Action:** Trigger 'transfer:incoming' twice with same transfer data (simulate Nostr re-delivery)
- **Expected:** Events fire both times (module does NOT suppress re-fires); balance is NOT doubled — idempotency applies to ledger computations only, not event emission. Dedup key prevents double-counting in the balance.
- **Spec ref:** §6.3 idempotency contract

#### UT-EVENTS-020: invoice:receipt_sent fires after sendInvoiceReceipts()
- **Preconditions:** Module with CLOSED invoice
- **Action:** `sendInvoiceReceipts(invoiceId)` completes successfully
- **Expected:** Event fired with { invoiceId, sent, failed }
- **Spec ref:** §6.2

#### UT-EVENTS-021: invoice:cancellation_sent fires after sendCancellationNotices()
- **Preconditions:** Module with CANCELLED invoice
- **Action:** `sendCancellationNotices(invoiceId)` completes successfully
- **Expected:** Event fired with { invoiceId, sent, failed }
- **Spec ref:** §6.2

#### UT-EVENTS-022: invoice:receipt_received fires on receipt DM
- **Preconditions:** Module loaded; CommunicationsModule 'message:dm' event subscription active
- **Action:** Emit DM with `invoice_receipt:` prefix and valid JSON payload
- **Expected:** Event fired with { invoiceId, senderNametag, senderContribution }
- **Spec ref:** §5.11

#### UT-EVENTS-023: invoice:cancellation_received fires on cancellation DM
- **Preconditions:** Module loaded; CommunicationsModule subscription active
- **Action:** Emit DM with `invoice_cancellation:` prefix and valid JSON payload
- **Expected:** Event fired with { invoiceId, senderNametag, reason }
- **Spec ref:** §5.12

#### UT-EVENTS-024: invoice:unknown_reference fires for unrecognized invoice ID
- **Preconditions:** Module loaded; NO invoice with ID 'abc123...' in local storage
- **Action:** Trigger inbound transfer with INV:abc123...:F memo referencing a non-existent invoice
- **Expected:** Event fired with { invoiceId: 'abc123...', transfer }; transfer proceeds normally (not blocked)
- **Spec ref:** §6.2 step 2 "invoice not in local storage"

#### UT-EVENTS-025: invoice:over_refund_warning fires when returns exceed forwards
- **Preconditions:** Module loaded; invoice with sender A who forwarded 5 UCT; target sends :B return of 3 UCT; then target sends another :B return of 3 UCT (total returns 6 > forwarded 5)
- **Action:** Process the second return transfer
- **Expected:** Event fired with { invoiceId, senderAddress, coinId: 'UCT', forwardedAmount: '5000000', returnedAmount: '6000000' }
- **Spec ref:** §6.2 step 3c "over-refund warning"

---

### 3.14 On-Chain Message Decoding

**File:** `tests/unit/modules/AccountingModule.decodeTransferMessage.test.ts`

#### UT-DECODE-001: Valid TransferMessagePayload parsed correctly
- **Preconditions:** N/A
- **Action:** Call `decodeTransferMessage` with valid JSON: `{ "inv": { "id": "a1b2c3d4...", "dir": "F" } }`
- **Expected:** Returns { invoiceId, paymentDirection: 'forward' }
- **Spec ref:** §4.1

#### UT-DECODE-002: inv as array → null
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": [] }')`
- **Expected:** Returns null (structural type guard rejects array)
- **Spec ref:** §4.1 "Structural type guard"

#### UT-DECODE-003: inv as string → null
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": "notobject" }')`
- **Expected:** Returns null
- **Spec ref:** §4.1

#### UT-DECODE-004: inv as null → null
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": null }')`
- **Expected:** Returns null
- **Spec ref:** §4.1

#### UT-DECODE-005: inv.id as number → null
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": 12345, "dir": "F" } }')`
- **Expected:** Returns null (id must be string)
- **Spec ref:** §4.1

#### UT-DECODE-006: inv.id not 64-hex → null
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": "notahex", "dir": "F" } }')`
- **Expected:** Returns null
- **Spec ref:** §4.1

#### UT-DECODE-007: inv.dir unknown value → null
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": "a1b2c3d4...", "dir": "INVALID" } }')`
- **Expected:** Returns null
- **Spec ref:** §4.1

#### UT-DECODE-008: inv.ra malformed → silently stripped
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": "a1b2c3d4...", "dir": "F", "ra": "not-an-address" } }')`
- **Expected:** Returns valid result with ra field absent (silently stripped)
- **Spec ref:** §4.1 "malformed ra stripped"

#### UT-DECODE-009: inv.ct with control characters in url → stripped
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": "a1b2c3d4...", "dir": "F", "ct": { "u": "https://example.com\r\n" } } }')`
- **Expected:** Returns valid result with control characters stripped from ct.u
- **Spec ref:** §4.1 "control characters stripped"

#### UT-DECODE-010: inv.txt exceeding 1024 code points → truncated
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": "a1b2c3d4...", "dir": "F", "txt": "x".repeat(1025) } }')`
- **Expected:** Returns result with txt truncated to 1024 code points
- **Spec ref:** §4.1

#### UT-DECODE-011: inv.id case normalization (uppercase → lowercase)
- **Preconditions:** N/A
- **Action:** `decodeTransferMessage('{ "inv": { "id": "A1B2C3D4ABCD...", "dir": "F" } }')`
- **Expected:** Returns with invoiceId normalized to lowercase: "a1b2c3d4abcd..."
- **Spec ref:** §4.1

---

### 3.15 Token Minting Internals

**File:** `tests/unit/modules/AccountingModule.tokenMinting.test.ts`

#### UT-MINT-001: INVOICE_TOKEN_TYPE_HEX = SHA-256(UTF-8("unicity.invoice.v1"))
- **Preconditions:** N/A
- **Action:** Calculate SHA-256 hash and compare to constant
- **Expected:** Constant equals the SHA-256 hash (64-char hex)
- **Spec ref:** §3.4

#### UT-MINT-002: Canonical serialization key order
- **Preconditions:** N/A
- **Action:** Create two InvoiceTerms with same data but different field order
- **Expected:** Both serialize to identical canonical JSON (key order: createdAt, [creator], deliveryMethods, dueDate, memo, targets)
- **Spec ref:** §3.4

#### UT-MINT-003: Target address lexicographic sorting
- **Preconditions:** N/A
- **Action:** Create invoice with targets [DIRECT://z, DIRECT://a, DIRECT://m]
- **Expected:** Canonical serialization sorts targets lexicographically by address
- **Spec ref:** §3.4

#### UT-MINT-004: Asset ordering (coins before NFTs, then by coinId)
- **Preconditions:** N/A
- **Action:** Create invoice with mixed coin and NFT assets
- **Expected:** Serialization orders coins first, then NFTs, within each group by coinId alphabetically
- **Spec ref:** §3.4

#### UT-MINT-005: Identical params → same token ID (determinism)
- **Preconditions:** N/A
- **Action:** Call `createInvoice()` twice with identical parameters
- **Expected:** Both produce the same token ID
- **Spec ref:** §3.4 deterministic minting

#### UT-MINT-006: Different params → different token ID
- **Preconditions:** N/A
- **Action:** Call `createInvoice()` with different memo/target/amount
- **Expected:** Each produces distinct token ID
- **Spec ref:** §3.4

#### UT-MINT-007: deliveryMethods: [] and undefined serialize the same (null normalization)
- **Preconditions:** N/A
- **Action:** Create two invoices, one with `deliveryMethods: []`, one with `deliveryMethods: undefined`
- **Expected:** Both serialize identically (both become null in canonical form)
- **Spec ref:** §3.4

#### UT-MINT-008: Anonymous invoice — creator absent (not null) in serialization
- **Preconditions:** N/A
- **Action:** Create invoice with `anonymous: true`
- **Expected:** Canonical serialization omits the creator field entirely (not set to null)
- **Spec ref:** §3.4

#### UT-MINT-009: REQUEST_ID_EXISTS treated as success, waitInclusionProof still called
- **Preconditions:** Module loaded; oracle.submitTransaction() returns `{ success: false, requestId: '...' }` (REQUEST_ID_EXISTS condition)
- **Action:** `createInvoice({ ... })`
- **Expected:** Treats as success; still awaits `waitInclusionProof()` and returns result with confirmed: false initially
- **Spec ref:** §2.1 createInvoice()

#### UT-MINT-010: MintTransactionData.create() assertions
- **Preconditions:** N/A
- **Action:** Verify mock oracle that `submitTransaction()` receives transaction with correct structure
- **Expected:** tokenType matches INVOICE_TOKEN_TYPE_HEX; coinData: null (invoice is non-fungible); tokenData contains encoded InvoiceTerms
- **Spec ref:** §3.4

---

### 3.16 Invoice-Transfer Index

**File:** `tests/unit/modules/AccountingModule.index.test.ts`

#### UT-INDEX-001: Cold-start loads persisted inv_ledger:{id} entries
- **Preconditions:** Storage contains inv_ledger:abc123 with previous transfer entries
- **Action:** `load()`
- **Expected:** Index loaded from storage; queryable without re-scan
- **Spec ref:** §5.4 Phase 1

#### UT-INDEX-002: Token scan watermark persisted and respected on restart
- **Preconditions:** Storage contains token_scan_state with last processed index
- **Action:** `load()` then receive new transfer
- **Expected:** Scan resumes from watermark, not from index 0; only new transactions indexed
- **Spec ref:** §5.4.2 watermark

#### UT-INDEX-003: Incremental update on transfer:incoming
- **Preconditions:** Module loaded with invoice indexed
- **Action:** Trigger 'transfer:incoming' event with new transfer
- **Expected:** Index updated incrementally; watermark advanced; no full re-scan
- **Spec ref:** §5.4 Phase 3

#### UT-INDEX-004: Multi-asset token produces multiple index entries
- **Preconditions:** Module with invoice; receive token with 3 coin entries
- **Action:** Scan token
- **Expected:** Three separate per-coin index entries created (one per coin)
- **Spec ref:** §5.4.3 step 5 "per-coin expansion"

#### UT-INDEX-005: Dedup key ${transferId}::${coinId} prevents duplicates
- **Preconditions:** Module with invoice
- **Action:** Same transfer delivered twice via Nostr
- **Expected:** Dedup key ensures only one index entry; no double-counting
- **Spec ref:** §5.4.3 dedup key

#### UT-INDEX-006: Same transfer delivered twice → only one entry per coinId
- **Preconditions:** Module with invoice; mock emit transfer:incoming twice
- **Action:** Trigger two deliveries
- **Expected:** Only one index entry per coinId; balance not doubled
- **Spec ref:** §5.4.3 dedup

#### UT-INDEX-007: maxCoinDataEntries cap (51 entries → only 50 processed)
- **Preconditions:** Module with default maxCoinDataEntries=50; token with 51 coin entries
- **Action:** Receive transfer
- **Expected:** Only first 50 entries indexed; 51st silently ignored; no error
- **Spec ref:** §5.4.3 step 6 cap

#### UT-INDEX-008: Zero-amount coinData entry silently skipped
- **Preconditions:** Module with token containing amount "0"
- **Action:** Receive transfer
- **Expected:** Zero-amount entry not added to index
- **Spec ref:** §5.4.3 step 6a regex

#### UT-INDEX-009: Amount exceeding 78 digits silently skipped
- **Preconditions:** Module with token containing amount "1" + "0".repeat(79)
- **Action:** Receive transfer
- **Expected:** Entry skipped; no error; watermark still advances
- **Spec ref:** §5.4.3 step 6a length check

#### UT-INDEX-010: Per-transaction error isolation
- **Preconditions:** Module with token; tx[0] valid, tx[1] throws error, tx[2] valid
- **Action:** Receive transfer
- **Expected:** tx[0] and tx[2] indexed; error from tx[1] logged but does not block others; watermark = 3
- **Spec ref:** §5.4.3 error handling

#### UT-INDEX-011: getInvoiceStatus() reads from in-memory index, NOT getHistory()
- **Preconditions:** Module with invoice indexed
- **Action:** Mock getHistory() to throw; call getInvoiceStatus()
- **Expected:** Status returned from index (getHistory NOT called on live invoices)
- **Spec ref:** §5.4.1 "NOT from PaymentsModule.getHistory() on every query"

---

### 3.17 Payer-Side DM Processing

**File:** `tests/unit/modules/AccountingModule.dmProcessing.test.ts`

#### UT-DM-001: DM with invoice_receipt: prefix → invoice:receipt_received event
- **Preconditions:** Module loaded with CommunicationsModule
- **Action:** Emit message:dm event with `invoice_receipt: { ... }` payload
- **Expected:** Event fired with { invoiceId, senderNametag, senderContribution }
- **Spec ref:** §5.11

#### UT-DM-002: DM with invoice_cancellation: prefix → invoice:cancellation_received event
- **Preconditions:** Module loaded with CommunicationsModule
- **Action:** Emit message:dm event with `invoice_cancellation: { ... }` payload
- **Expected:** Event fired with { invoiceId, senderNametag, reason, dealDescription }
- **Spec ref:** §5.12

#### UT-DM-003: Malformed JSON after prefix → treated as regular DM
- **Preconditions:** Module loaded
- **Action:** Emit DM with `invoice_receipt: {invalid json}`
- **Expected:** Treated as regular DM; no event; no error
- **Spec ref:** §5.11 lenient parsing

#### UT-DM-004: version > 1 → silently ignored
- **Preconditions:** Module loaded
- **Action:** Emit DM with `invoice_receipt: { version: 2, ... }`
- **Expected:** Silently ignored; no event; forward-compatible
- **Spec ref:** §5.11 forward compatibility

#### UT-DM-005: version < 1 or non-integer version → validation failure (silent)
- **Preconditions:** Module loaded
- **Action:** Emit DM with `invoice_receipt: { version: 0, ... }` or `version: "1"`
- **Expected:** Silently ignored; no event
- **Spec ref:** §5.11

#### UT-DM-006: Unknown invoiceId → silently dropped
- **Preconditions:** Module loaded; no invoice with given ID
- **Action:** Emit DM with `invoice_receipt: { invoiceId: "unknown", ... }`
- **Expected:** Silently ignored; no event
- **Spec ref:** §5.11 step 5b

#### UT-DM-007: Content > 64KB → skipped before JSON.parse
- **Preconditions:** Module loaded
- **Action:** Emit DM with `invoice_receipt:` followed by 65 KB of content
- **Expected:** Treated as regular DM; no parse attempt; no event
- **Spec ref:** §5.11 content size guard

#### UT-DM-008: CommunicationsModule DM subscription torn down on destroy()
- **Preconditions:** Module loaded with subscription active
- **Action:** Call `destroy()` then emit DM event
- **Expected:** No event fired (subscription unsubscribed)
- **Spec ref:** §2.1 destroy()

#### UT-DM-009: senderNametag falls back to payload.targetNametag
- **Preconditions:** Module loaded; DM has no senderNametag field
- **Action:** Emit DM with `invoice_receipt: { targetNametag: "alice", ... }`
- **Expected:** Event fired with senderNametag = "alice" (from payload fallback)
- **Spec ref:** §5.11

#### UT-DM-010: Self-asserted receipt amounts → event fires without cross-validation
- **Preconditions:** Module loaded; DM payload contains senderContribution: { UCT: "999999" } (fabricated, not matching frozen)
- **Action:** Emit DM
- **Expected:** Event fires without amount validation; applications must validate independently
- **Spec ref:** §5.11 "Receipt content is self-asserted"

---

### 3.18 autoTerminateOnReturn

**File:** `tests/unit/modules/AccountingModule.autoTerminateOnReturn.test.ts`

#### UT-AUTOTERM-001: Receiving :RC with autoTerminateOnReturn: true → invoice auto-closed
- **Preconditions:** Module configured with autoTerminateOnReturn: true; invoice is OPEN/PARTIAL
- **Action:** Receive transfer with RC direction from a target
- **Expected:** Invoice state changes to CLOSED; 'invoice:closed' event fires with explicit: false; no deadlock; public closeInvoice() is NOT re-entered
- **Spec ref:** §4.5 autoTerminateOnReturn

#### UT-AUTOTERM-002: Receiving :RX with autoTerminateOnReturn: true → invoice auto-cancelled
- **Preconditions:** Module configured with autoTerminateOnReturn: true; invoice is OPEN
- **Action:** Receive transfer with RX direction from a target
- **Expected:** Invoice is automatically cancelled locally; no deadlock
- **Spec ref:** §4.5 autoTerminateOnReturn

#### UT-AUTOTERM-003: autoTerminateOnReturn: false → no auto-termination
- **Preconditions:** Module configured with autoTerminateOnReturn: false (default)
- **Action:** Receive :RC/:RX transfer
- **Expected:** No auto-termination; invoice remains in current state
- **Spec ref:** §4.5

#### UT-AUTOTERM-004: Auto-termination completes without deadlock on concurrent operation
- **Preconditions:** Module with autoTerminateOnReturn: true; concurrent gate operation in progress
- **Action:** Receive :RC transfer while another operation holds the per-invoice gate
- **Expected:** No deadlock; state correctly transitions to CLOSED; no hung promises or timeout errors
- **Spec ref:** §4.5 auto-termination path

#### UT-AUTOTERM-005: Spoofed :RC from legitimate non-target sender behavior
- **Preconditions:** Module with autoTerminateOnReturn: true; invoice has target A and target B; receive :RC from non-target C claiming to be from target A
- **Action:** Receive transfer with masked sender
- **Expected:** Transfer rejected at authorization step; no auto-termination; invoice stays open
- **Spec ref:** §6.2 step 3a authorization

---

### 3.19 Storage & Crash Recovery

**File:** `tests/unit/modules/AccountingModule.storage.test.ts`

#### UT-STORAGE-001: Terminal set written before frozen balances (atomic write order)
- **Preconditions:** Module with invoice; mock storage to track write order
- **Action:** Close invoice
- **Mechanism:** Use a write-log array. Override MockStorageProvider.set() to push { key, timestamp: Date.now() } to the log. After closeInvoice(), assert that log[0].key matches the terminal set key and log[1].key matches the frozen balances key.
- **Expected:** terminal set written FIRST, frozen balances written SECOND
- **Spec ref:** §7.6 step 3-4 write order

#### UT-STORAGE-002: Load with FROZEN_BALANCES missing but terminal set present (forward reconciliation)
- **Preconditions:** Storage has invoice in closed set but no frozen balances entry; storage has history with transfers
- **Action:** `load()`
- **Expected:** Balances recomputed from history using highest-forwarded-amount heuristic for latest sender; frozen entry persisted
- **Spec ref:** §7.6 step 4c forward reconciliation

#### UT-STORAGE-003: Load with inv_ledger:{invoiceId} corrupted (full rescan)
- **Preconditions:** Storage has inv_ledger:abc corrupted (invalid JSON)
- **Action:** `load()`
- **Expected:** Key deleted; tokenScanState entries for tokens referencing that invoice reset; full rescan performed
- **Spec ref:** §7.6 step 6c corruption handling

#### UT-STORAGE-004: Auto-return dedup ledger entries pruned after 30 days on load()
- **Preconditions:** Storage has auto-return dedup ledger with completed entry from 31 days ago
- **Action:** `load()`
- **Expected:** Entry pruned; failed entries retained indefinitely
- **Spec ref:** §7.5 pruning

#### UT-STORAGE-005: Secondary dedup via getHistory scan
- **Preconditions:** Module with invoice; primary dedup ledger pruned (after 30 days); PaymentsModule.getHistory() contains existing :RC transfer
- **Action:** Trigger implicit auto-return again
- **Expected:** Secondary dedup check against history prevents duplicate send
- **Spec ref:** §7.5 "Before executing any auto-return send, check getHistory()"

#### UT-STORAGE-006: TXF coinData: null vs [] roundtrip
- **Preconditions:** N/A
- **Action:** Create invoice token, serialize, deserialize
- **Expected:** coinData: null preserved on roundtrip (not converted to [])
- **Spec ref:** §7.1 TXF format

#### UT-STORAGE-007: Exact storage key strings verified
- **Preconditions:** N/A
- **Action:** Verify that all storage keys use exact format: `closed_invoices`, `cancelled_invoices`, `frozen_balances:{id}`, `inv_ledger:{id}`, `token_scan_state`, etc.
- **Expected:** Keys match specification exactly
- **Spec ref:** §7.6

#### UT-STORAGE-008: inv_ledger_index corruption → rebuild from inv_ledger:* keys
- **Preconditions:** Storage has inv_ledger:* keys but index is corrupted
- **Action:** `load()`
- **Expected:** Index rebuilt by enumerating inv_ledger:* keys discovered via storage scan
- **Spec ref:** §7.6 step 6c

#### UT-STORAGE-009: Normal load — both frozen balances and terminal set exist (no reconciliation)
- **Preconditions:** Storage has complete FROZEN_BALANCES and terminal set entries
- **Action:** `load()`
- **Expected:** No reconciliation branches fire; balances loaded directly
- **Spec ref:** §7.6 steps 4b-4c normal case

---

### 3.20 Validation Gauntlet (Edge Cases & Security)

**File:** `tests/unit/modules/AccountingModule.validation.test.ts`

#### UT-VAL-001: Creator field self-assertion not granted authorization
- **Preconditions:** Module loaded; import token claiming `creator = victim_pubkey`
- **Action:** `importInvoice(token)`
- **Expected:** Invoice imported; victim has NO special authority over it (target-based authorization only)
- **Spec ref:** §3.4 "creator field is self-asserted"

#### UT-VAL-002: Memo injection: newline in freeText does not create second reference
- **Preconditions:** N/A
- **Action:** `buildInvoiceMemo('..., 'forward', 'text\nINV:fakeid:F')`
- **Expected:** Newlines stripped; resulting memo cannot split into two invoice references
- **Spec ref:** §4.6 "Strip newlines from freeText"

#### UT-VAL-003: ct.u control character injection (HTTP header injection)
- **Preconditions:** Module with transfer containing `ct.u = "https://...?x=y\r\nInjected-Header: value"`
- **Action:** Parse message
- **Expected:** Control characters stripped; resulting URL safe
- **Spec ref:** §4.1 "must not contain control characters"

#### UT-VAL-005: Concurrent returnInvoicePayment() — only one succeeds
- **Preconditions:** Module with invoice, sender has 5 UCT balance; two concurrent return requests for 5 UCT each
- **Action:** Fire both with `Promise.all()`
- **Expected:** First succeeds; second throws INVOICE_RETURN_EXCEEDS_BALANCE
- **Note:** See also CONC-004 in §6.1 for the integration version of this concurrency test.
- **Spec ref:** §5.9 gate serialization

#### UT-VAL-006: Concurrent closeInvoice() + implicit close race
- **Preconditions:** Module with COVERED+all-confirmed invoice; explicit close and implicit close race
- **Action:** Fire `closeInvoice()` and `getInvoiceStatus()` simultaneously
- **Expected:** Both complete without deadlock; only one freeze; one fires explicit event, other sees already-closed
- **Spec ref:** §5.9 concurrency

#### UT-VAL-007: BigInt 78-digit boundary
- **Preconditions:** N/A
- **Action:** Create transfer with amount '1' + '0'.repeat(77) (78 digits); then '1' + '0'.repeat(78) (79 digits)
- **Expected:** First accepted; second rejected at processTokenTransactions() step 6a
- **Spec ref:** §5.2 "Length limit: Amount strings MUST NOT exceed 78 digits"

#### UT-VAL-008: inv.id case normalization on-chain match
- **Preconditions:** Module with invoice ID = "abc123def456..."; transfer message has id uppercase
- **Action:** Receive transfer with `inv.id = "ABC123DEF456..."`
- **Expected:** After normalization to lowercase, matches stored ID; indexed correctly
- **Spec ref:** §4.1 normalization

#### UT-VAL-009: Contact accumulation 10-entry cap
- **Preconditions:** Module with invoice; sender sends 12 transfers with distinct contact addresses
- **Action:** Scan all transfers
- **Expected:** InvoiceSenderBalance.contacts limited to 10 entries; oldest contacts removed
- **Spec ref:** §5.4.6 MAX_CONTACTS_PER_SENDER

#### UT-VAL-010: effectiveSender collision — two senders sharing refund address
- **Preconditions:** Module with invoice; sender A and B provide same refundAddress
- **Action:** Both send payments
- **Expected:** Merged into single balance bucket; auto-return goes to shared refundAddress
- **Spec ref:** §5.2 "Balance collision"

#### UT-VAL-011: effectiveSender split — same sender with/without refund address
- **Preconditions:** Module with invoice; same sender sends payment with refundAddress, then without
- **Action:** Both transfers received
- **Expected:** Two separate balance buckets; caller can distinguish via refundAddress field
- **Spec ref:** §5.2 "Balance split"

#### UT-VAL-012: 60-second timeout on returnInvoicePayment send()
- **Preconditions:** Module with invoice; mock PaymentsModule.send() to hang indefinitely
- **Action:** Call `returnInvoicePayment()`
- **Expected:** After 60 seconds, gate released; return rejected with timeout error; dedup ledger NOT written
- **Note:** See also CONC-008 in §6.1 for the integration version of this timeout test.
- **Spec ref:** §5.9 timeout

---

### 3.21 CLI Integration

**File:** `tests/unit/modules/AccountingModule.cli.test.ts`

#### CLI-001: invoice-create happy path
- **Command:** `invoice-create @alice UCT 10000000 --memo "Test"`
- **Verify:** Invoice created; output shows ✓ and invoice ID; exit code 0
- **Spec ref:** §11.2.1

#### CLI-002: invoice-create --targets mode
- **Command:** `invoice-create --targets targets.json`
- **Verify:** Multi-target invoice created; exit code 0
- **Spec ref:** §11.2.1

#### CLI-003: invoice-create validation error
- **Command:** `invoice-create @alice UCT 0`
- **Verify:** Error: INVOICE_INVALID_AMOUNT; exit code 1
- **Spec ref:** §11.2.1

#### CLI-004: invoice-import happy path
- **Command:** `invoice-import invoice.txf`
- **Verify:** Invoice imported; output shows ✓; exit code 0
- **Spec ref:** §11.2.2

#### CLI-005: invoice-import invalid file
- **Command:** `invoice-import nonexistent.txf`
- **Verify:** Error: file not found; exit code 1
- **Spec ref:** §11.2.2

#### CLI-006: invoice-status happy path
- **Command:** `invoice-status a1b2c3d4e5f6a7b8`
- **Verify:** Status display with state, per-target balances; exit code 0
- **Spec ref:** §11.2.3

#### CLI-007: invoice-status --json output
- **Command:** `invoice-status a1b2c3d4e5f6a7b8 --json`
- **Verify:** Valid JSON output with all status fields
- **Spec ref:** §11.2.3

#### CLI-008: invoice-list happy path
- **Command:** `invoice-list --state OPEN,PARTIAL --limit 5`
- **Verify:** Filtered list displayed; exit code 0
- **Spec ref:** §11.2.4

#### CLI-009: invoice-list --json output
- **Command:** `invoice-list --json`
- **Verify:** Valid JSON array output
- **Spec ref:** §11.2.4

#### CLI-010: invoice-info happy path
- **Command:** `invoice-info a1b2c3d4e5f6a7b8`
- **Verify:** Invoice details (terms, creator, targets) displayed; exit code 0
- **Spec ref:** §11.2.5

#### CLI-011: invoice-close happy path
- **Command:** `invoice-close a1b2c3d4e5f6a7b8`
- **Verify:** ✓ Invoice closed; exit code 0
- **Spec ref:** §11.2.6

#### CLI-012: invoice-close with --auto-return
- **Command:** `invoice-close a1b2c3d4e5f6a7b8 --auto-return`
- **Verify:** Invoice closed + auto-return triggered; exit code 0
- **Spec ref:** §11.2.6

#### CLI-013: invoice-cancel happy path
- **Command:** `invoice-cancel a1b2c3d4e5f6a7b8`
- **Verify:** ✓ Invoice cancelled; exit code 0
- **Spec ref:** §11.2.7

#### CLI-014: invoice-cancel non-target error
- **Command:** `invoice-cancel a1b2c3d4e5f6a7b8` (wallet is not target)
- **Verify:** Error: INVOICE_NOT_TARGET; exit code 1
- **Spec ref:** §11.2.7

#### CLI-015: invoice-pay happy path (amount specified)
- **Command:** `invoice-pay a1b2c3d4e5f6a7b8 10000000`
- **Verify:** Payment sent; ✓ output; exit code 0
- **Spec ref:** §11.2.8

#### CLI-016: invoice-pay happy path (amount omitted = remaining)
- **Command:** `invoice-pay a1b2c3d4e5f6a7b8`
- **Verify:** Pays remaining balance; exit code 0
- **Spec ref:** §11.2.8

#### CLI-017: invoice-pay terminated invoice error
- **Command:** `invoice-pay a1b2c3d4e5f6a7b8 10000000` (invoice CLOSED)
- **Verify:** Error: INVOICE_TERMINATED; exit code 1
- **Spec ref:** §11.2.8

#### CLI-018: invoice-return happy path
- **Command:** `invoice-return a1b2c3d4 DIRECT://sender 5000000 UCT`
- **Verify:** Return sent; ✓ output; exit code 0
- **Spec ref:** §11.2.9

#### CLI-019: invoice-return exceeds balance error
- **Command:** `invoice-return a1b2c3d4 DIRECT://sender 99999999 UCT`
- **Verify:** Error: INVOICE_RETURN_EXCEEDS_BALANCE; exit code 1
- **Spec ref:** §11.2.9

#### CLI-020: invoice-auto-return show mode (no flags)
- **Command:** `invoice-auto-return`
- **Verify:** Displays current auto-return settings; exit code 0
- **Spec ref:** §11.2.10

#### CLI-021: invoice-auto-return set mode
- **Command:** `invoice-auto-return --enable --invoice a1b2c3d4`
- **Verify:** Auto-return enabled for invoice; exit code 0
- **Spec ref:** §11.2.10

#### CLI-022: invoice-receipts happy path
- **Command:** `invoice-receipts a1b2c3d4e5f6a7b8`
- **Verify:** Receipts sent; summary displayed; exit code 0
- **Spec ref:** §11.2.11

#### CLI-023: invoice-receipts non-terminal error
- **Command:** `invoice-receipts a1b2c3d4` (invoice OPEN)
- **Verify:** Error: INVOICE_NOT_TERMINATED; exit code 1
- **Spec ref:** §11.2.11

#### CLI-024: invoice-cancel-notices happy path
- **Command:** `invoice-cancel-notices a1b2c3d4 --reason "Out of stock"`
- **Verify:** Notices sent; summary displayed; exit code 0
- **Spec ref:** §11.2.12

#### CLI-025: invoice-cancel-notices non-CANCELLED error
- **Command:** `invoice-cancel-notices a1b2c3d4` (invoice CLOSED)
- **Verify:** Error: INVOICE_NOT_CANCELLED; exit code 1
- **Spec ref:** §11.2.12

#### CLI-026: invoice-transfers happy path
- **Command:** `invoice-transfers a1b2c3d4e5f6a7b8`
- **Verify:** Chronological transfer list displayed; exit code 0
- **Spec ref:** §11.2.13

#### CLI-027: invoice-transfers --json output
- **Command:** `invoice-transfers a1b2c3d4e5f6a7b8 --json`
- **Verify:** Valid JSON array output
- **Spec ref:** §11.2.13

#### CLI-028: invoice-parse-memo happy path
- **Command:** `invoice-parse-memo "INV:a1b2c3d4e5f6a7b8:F"`
- **Verify:** Parsed output: invoiceId, direction; exit code 0
- **Spec ref:** §11.2.14

#### CLI-029: invoice-parse-memo invalid memo
- **Command:** `invoice-parse-memo "not a valid memo"`
- **Verify:** Output: null/no match; exit code 0
- **Spec ref:** §11.2.14

#### CLI-030: invoice help listing
- **Command:** `invoice`
- **Verify:** Lists all 14 commands with brief descriptions
- **Spec ref:** §11.3 help listing

#### CLI-031: --targets with path traversal (/etc/passwd) → error message
- **Command:** `invoice-create --targets /etc/passwd`
- **Verify:** Error: "File not found" or "Access denied"; exit code 1; no file system leak
- **Spec ref:** §11.2.1 security

#### CLI-032: invoice-parse-memo with null bytes and control characters
- **Command:** `invoice-parse-memo "memo\x00with\x1bnull"`
- **Verify:** Parser returns null (no match) or safe output
- **Spec ref:** §11.2.14

#### CLI-033: Prefix of exactly 8 hex chars (minimum valid) → accepted
- **Command:** `invoice-status a1b2c3d4`
- **Verify:** Lookup succeeds if unique; fails with ambiguous if multiple matches
- **Spec ref:** §11.1 prefix validation

---

### 3.22 sendInvoiceReceipts()

**File:** `tests/unit/modules/AccountingModule.sendInvoiceReceipts.test.ts`

#### UT-RECEIPTS-001: Happy path — send receipts for CLOSED invoice
- **Preconditions:** Module loaded; invoice CLOSED with frozen balances; 2 senders with non-zero balances; CommunicationsModule available
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** 2 DMs sent via CommunicationsModule.sendDM(); each DM has `invoice_receipt:` prefix; returns { sent: 2, failed: 0 }; fires invoice:receipt_sent event
- **Spec ref:** §2.1 sendInvoiceReceipts(), §4.10

#### UT-RECEIPTS-002: Happy path — send receipts for CANCELLED invoice
- **Preconditions:** Module loaded; invoice CANCELLED with frozen balances; 1 sender
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** 1 DM sent; returns { sent: 1, failed: 0 }; fires invoice:receipt_sent
- **Spec ref:** §2.1 sendInvoiceReceipts()

#### UT-RECEIPTS-003: Receipt DM content includes per-asset breakdown
- **Preconditions:** Module loaded; invoice CLOSED; sender paid 5 UCT + 3 USDU
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** DM payload includes InvoiceReceiptPayload with correct per-asset amounts
- **Spec ref:** §4.10 receipt payload structure

#### UT-RECEIPTS-004: Custom memo included in receipt DM
- **Preconditions:** Module loaded; invoice CLOSED; 1 sender
- **Action:** `sendInvoiceReceipts(invoiceId, { memo: 'Thank you!' })`
- **Expected:** Receipt DM includes custom memo field
- **Spec ref:** §2.1 sendInvoiceReceipts() options.memo

#### UT-RECEIPTS-005: includeZeroBalance sends to senders with zero balance
- **Preconditions:** Module loaded; invoice CLOSED; sender A has balance 5, sender B has balance 0
- **Action:** `sendInvoiceReceipts(invoiceId, { includeZeroBalance: true })`
- **Expected:** 2 DMs sent (including sender B with zero balance)
- **Spec ref:** §2.1 sendInvoiceReceipts() options.includeZeroBalance

#### UT-RECEIPTS-006: Without includeZeroBalance, zero-balance senders skipped
- **Preconditions:** Same as UT-RECEIPTS-005
- **Action:** `sendInvoiceReceipts(invoiceId)` (no includeZeroBalance)
- **Expected:** 1 DM sent (only sender A); sender B skipped
- **Spec ref:** §2.1 sendInvoiceReceipts()

#### UT-RECEIPTS-007: Contact resolution priority: contacts[0].address → senderAddress → skip
- **Preconditions:** Module loaded; invoice CLOSED; sender A has contacts[0].address, sender B has only senderAddress, sender C has neither (masked, no refundAddress)
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** DM to A uses contacts[0].address; DM to B uses senderAddress; C skipped (in failedReceipts)
- **Spec ref:** §2.1 sendInvoiceReceipts() contact resolution

#### UT-RECEIPTS-008: Partial DM failure — some succeed, some fail
- **Preconditions:** Module loaded; invoice CLOSED; 3 senders; CommunicationsModule.sendDM() fails for sender B
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Returns { sent: 2, failed: 1, failedReceipts: [{ address: senderB, error: ... }] }; does NOT throw
- **Spec ref:** §8.9 per-sender DM delivery failures

#### UT-RECEIPTS-009: INVOICE_NOT_FOUND — nonexistent invoice
- **Preconditions:** Module loaded
- **Action:** `sendInvoiceReceipts('nonexistent')`
- **Expected:** Throws SphereError with code INVOICE_NOT_FOUND
- **Spec ref:** §10 INVOICE_NOT_FOUND

#### UT-RECEIPTS-010: INVOICE_NOT_TARGET — caller is not a target
- **Preconditions:** Module loaded; invoice exists; caller is not in targets array
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_TARGET
- **Spec ref:** §10 INVOICE_NOT_TARGET

#### UT-RECEIPTS-011: INVOICE_MEMO_TOO_LONG — options.memo exceeds 4096 chars
- **Preconditions:** Module loaded; invoice CLOSED
- **Action:** `sendInvoiceReceipts(invoiceId, { memo: 'x'.repeat(4097) })`
- **Expected:** Throws SphereError with code INVOICE_MEMO_TOO_LONG
- **Spec ref:** §10 INVOICE_MEMO_TOO_LONG

#### UT-RECEIPTS-012: INVOICE_NOT_TERMINATED — invoice is COVERED (non-terminal)
- **Preconditions:** Module loaded; invoice in COVERED state (all assets covered but not yet closed)
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_TERMINATED
- **Spec ref:** §10 INVOICE_NOT_TERMINATED

#### UT-RECEIPTS-013: INVOICE_NOT_TERMINATED — invoice is OPEN
- **Preconditions:** Module loaded; invoice in OPEN state
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_TERMINATED
- **Spec ref:** §10 INVOICE_NOT_TERMINATED

#### UT-RECEIPTS-014: COMMUNICATIONS_UNAVAILABLE — no CommunicationsModule
- **Preconditions:** Module loaded WITHOUT CommunicationsModule dependency; invoice CLOSED
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Throws SphereError with code COMMUNICATIONS_UNAVAILABLE
- **Spec ref:** §10 COMMUNICATIONS_UNAVAILABLE

#### UT-RECEIPTS-015: INVOICE_NOT_TERMINATED — invoice is PARTIAL
- **Preconditions:** Module loaded; invoice in PARTIAL state
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_TERMINATED
- **Spec ref:** §10 INVOICE_NOT_TERMINATED

#### UT-RECEIPTS-016: INVOICE_NOT_TERMINATED — invoice is EXPIRED (non-terminal)
- **Preconditions:** Module loaded; invoice in EXPIRED state (not closed/cancelled)
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_TERMINATED
- **Spec ref:** §10 INVOICE_NOT_TERMINATED

---

### 3.23 sendCancellationNotices()

**File:** `tests/unit/modules/AccountingModule.sendCancellationNotices.test.ts`

#### UT-NOTICES-001: Happy path — send cancellation notices for CANCELLED invoice
- **Preconditions:** Module loaded; invoice CANCELLED with frozen balances; 2 senders with non-zero balances; CommunicationsModule available
- **Action:** `sendCancellationNotices(invoiceId)`
- **Expected:** 2 DMs sent with `invoice_cancellation:` prefix; returns { sent: 2, failed: 0 }; fires invoice:cancellation_sent event
- **Spec ref:** §2.1 sendCancellationNotices(), §4.11

#### UT-NOTICES-002: INVOICE_NOT_CANCELLED — invoice is CLOSED (not CANCELLED)
- **Preconditions:** Module loaded; invoice in CLOSED state
- **Action:** `sendCancellationNotices(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_CANCELLED
- **Spec ref:** §10 INVOICE_NOT_CANCELLED

#### UT-NOTICES-003: Custom reason and dealDescription included
- **Preconditions:** Module loaded; invoice CANCELLED; 1 sender
- **Action:** `sendCancellationNotices(invoiceId, { reason: 'Out of stock', dealDescription: 'Order #1234' })`
- **Expected:** Cancellation DM payload includes reason and dealDescription fields
- **Spec ref:** §4.11 cancellation notice payload

#### UT-NOTICES-004: INVOICE_MEMO_TOO_LONG — reason exceeds 4096 chars
- **Preconditions:** Module loaded; invoice CANCELLED
- **Action:** `sendCancellationNotices(invoiceId, { reason: 'x'.repeat(4097) })`
- **Expected:** Throws SphereError with code INVOICE_MEMO_TOO_LONG
- **Spec ref:** §10 INVOICE_MEMO_TOO_LONG

#### UT-NOTICES-005: INVOICE_MEMO_TOO_LONG — dealDescription exceeds 4096 chars
- **Preconditions:** Module loaded; invoice CANCELLED
- **Action:** `sendCancellationNotices(invoiceId, { dealDescription: 'x'.repeat(4097) })`
- **Expected:** Throws SphereError with code INVOICE_MEMO_TOO_LONG
- **Spec ref:** §10 INVOICE_MEMO_TOO_LONG

#### UT-NOTICES-006: INVOICE_NOT_TARGET — non-target caller
- **Preconditions:** Module loaded; invoice CANCELLED; wallet address not in targets
- **Action:** `sendCancellationNotices(invoiceId)`
- **Expected:** Throws SphereError with code INVOICE_NOT_TARGET
- **Spec ref:** §10 INVOICE_NOT_TARGET

#### UT-NOTICES-007: COMMUNICATIONS_UNAVAILABLE — no CommunicationsModule
- **Preconditions:** Module loaded WITHOUT CommunicationsModule; invoice CANCELLED
- **Action:** `sendCancellationNotices(invoiceId)`
- **Expected:** Throws SphereError with code COMMUNICATIONS_UNAVAILABLE
- **Spec ref:** §10 COMMUNICATIONS_UNAVAILABLE

#### UT-NOTICES-008: Partial DM failure — some succeed, some fail
- **Preconditions:** Module loaded; invoice CANCELLED; 3 senders; sendDM fails for sender B
- **Action:** `sendCancellationNotices(invoiceId)`
- **Expected:** Returns { sent: 2, failed: 1, failedNotices: [{ address: senderB, error: ... }] }; does NOT throw
- **Spec ref:** §8.9 per-sender DM delivery failures

#### UT-NOTICES-009: INVOICE_NOT_FOUND — nonexistent invoice
- **Preconditions:** Module loaded
- **Action:** `sendCancellationNotices('nonexistent')`
- **Expected:** Throws SphereError with code INVOICE_NOT_FOUND
- **Spec ref:** §10 INVOICE_NOT_FOUND

#### UT-NOTICES-010: includeZeroBalance sends notices to zero-balance senders
- **Preconditions:** Module loaded; invoice CANCELLED; sender A has balance, sender B has zero
- **Action:** `sendCancellationNotices(invoiceId, { includeZeroBalance: true })`
- **Expected:** 2 DMs sent (including sender B)
- **Spec ref:** §2.1 sendCancellationNotices() options.includeZeroBalance

---

### 3.24 getRelatedTransfers()

**File:** `tests/unit/modules/AccountingModule.getRelatedTransfers.test.ts`

#### UT-TRANSFERS-001: Happy path — returns all related transfers chronologically
- **Preconditions:** Module loaded; invoice with 3 forward payments and 1 return
- **Action:** `getRelatedTransfers(invoiceId)`
- **Expected:** Returns array of 4 InvoiceTransferRef entries in chronological order (oldest first)
- **Spec ref:** §2.1 getRelatedTransfers()

#### UT-TRANSFERS-002: Includes irrelevant transfers
- **Preconditions:** Module loaded; invoice with 1 relevant forward + 1 irrelevant (wrong target)
- **Action:** `getRelatedTransfers(invoiceId)`
- **Expected:** Both transfers returned; irrelevant transfer has `reason` field set (e.g., reason: 'unknown_address') per IrrelevantTransfer type
- **Spec ref:** §2.1 getRelatedTransfers()

#### UT-TRANSFERS-003: Empty result — no transfers for invoice
- **Preconditions:** Module loaded; newly created invoice with no payments
- **Action:** `getRelatedTransfers(invoiceId)`
- **Expected:** Returns empty array []
- **Spec ref:** §2.1 getRelatedTransfers()

#### UT-TRANSFERS-004: INVOICE_NOT_FOUND — unknown invoice ID
- **Preconditions:** Module loaded
- **Action:** `getRelatedTransfers('nonexistent')`
- **Expected:** Throws SphereError with code INVOICE_NOT_FOUND
- **Spec ref:** §10 INVOICE_NOT_FOUND

#### UT-TRANSFERS-005: Multi-coin transfers expanded correctly
- **Preconditions:** Module loaded; invoice with 1 multi-coin transfer (UCT + USDU in same token)
- **Action:** `getRelatedTransfers(invoiceId)`
- **Expected:** Returns 2 InvoiceTransferRef entries (one per coin), both referencing same transferId
- **Spec ref:** §5.4.3 multi-coin expansion

#### UT-TRANSFERS-006: Post-termination transfers included
- **Preconditions:** Module loaded; invoice CLOSED; 1 pre-close payment + 1 post-close payment
- **Action:** `getRelatedTransfers(invoiceId)`
- **Expected:** Both transfers returned (post-close transfer included, not filtered out)
- **Spec ref:** §2.1 getRelatedTransfers() includes all transfers regardless of state

---

## 4. E2E Integration Tests

**File:** `tests/integration/accounting.test.ts`

### 4.1 Module Lifecycle

#### IT-LIFECYCLE-001: Full workflow: create, pay, close, verify
- **Setup:** Module with PaymentsModule + CommunicationsModule, 2 Sphere instances (creator, payer)
- **Flow:**
  1. Creator creates invoice for 10 UCT
  2. Payer calls payInvoice with 10 UCT
  3. Payer receives transfer confirmation
  4. Creator calls getInvoiceStatus → shows COVERED
  5. Creator calls closeInvoice
  6. Payer receives sendInvoiceReceipts DM
  7. Creator calls sendCancellationNotices (error expected: INVOICE_NOT_CANCELLED)
- **Verify:** Events fire in order: [invoice:created, invoice:payment, invoice:covered, invoice:closed, invoice:receipt_sent]; final balance = 10 UCT covered; frozen balances persisted to storage
- **Spec ref:** §2.1 full lifecycle

### 4.2–4.10 E2E Workflow Tests (Planned)

> **Note:** These sections are planned for expansion. The E2E integration tests will cover multi-party workflows, auto-return end-to-end, DM delivery, and edge cases. Test IDs IT-002 through IT-010 will be specified in a future revision.

---

## 5. E2E CLI Tests

**File:** `tests/scripts/test-e2e-accounting-cli.ts`

### CLI E2E Tests (Planned)

> **Note:** Full CLI E2E test specifications pending. Will cover all 14 commands with real module setup, file I/O, and output verification. CLI test IDs will be enumerated in a future revision.

---

## 6. Cross-Cutting Concerns

### 6.1 Concurrency & Race Conditions

#### CONC-001: Per-invoice gate serialization
- **Setup:** Module with invoice; 2 async handlers (payment + closure)
- **Action:** Trigger payment and close simultaneously using `Promise.all([payInvoice(), closeInvoice()])`
- **Verify:** Per-invoice gate ensures close sees consistent index state; invoice ends in terminal state (CLOSED); frozen balances are non-null; no duplicate storage writes
- **Spec ref:** §5.9 per-invoice gate

#### CONC-002: Return + close race
- **Setup:** Module with invoice, auto-return enabled
- **Action:** `Promise.all([returnInvoicePayment(), closeInvoice()])`
- **Verify:** Both operations complete without deadlock; net balance = 0 after full return; invoice in terminal state
- **Spec ref:** §6.2 gate acquisition

#### CONC-003: Auto-return dedup concurrent sends
- **Setup:** Module with invoice; same transfer arrives twice
- **Action:** Both trigger auto-return simultaneously via Promise.all()
- **Verify:** Dedup ledger prevents duplicate return; only one sent
- **Spec ref:** §7.5 dedup ledger

#### CONC-004: Concurrent double-return attempt
- **Setup:** Module with invoice, 5 UCT balance; two concurrent returnInvoicePayment calls for 5 UCT each
- **Action:** Fire both with Promise.all()
- **Verify:** First succeeds; second throws INVOICE_RETURN_EXCEEDS_BALANCE
- **Spec ref:** §5.9 gate prevents overpayment

#### CONC-005: Concurrent closeInvoice + implicit close
- **Setup:** Module with COVERED+all-confirmed invoice
- **Action:** Fire `closeInvoice()` and `getInvoiceStatus()` simultaneously
- **Verify:** Only one freeze; no double-firing; both return CLOSED state
- **Spec ref:** §5.1 step 7c re-verify inside gate

#### CONC-006: payInvoice TOCTOU — implicit close between gate release and send
- **Setup:** Module with invoice, gate delays measured
- **Action:** `payInvoice()` releases gate before send; concurrent implicit close in that window
- **Verify:** Send completes on terminated invoice; auto-return (if enabled) handles post-close payment
- **Spec ref:** §5.9 "Accepted race: A narrow window exists"

#### CONC-007: destroy() awaits active gate tails
- **Setup:** Module with invoice; closeInvoice() in progress inside gate
- **Action:** Call `destroy()` while closeInvoice() is mid-operation
- **Verify:** `destroy()` blocks until closeInvoice() completes; then returns
- **Spec ref:** §2.1 destroy() "Await the current promise-chain tail"

#### CONC-008: returnInvoicePayment 60-second timeout on send()
- **Setup:** Module with invoice; mock PaymentsModule.send() to hang
- **Action:** Call `returnInvoicePayment()` and wait 61 seconds
- **Verify:** Gate released; return rejected with timeout error; dedup ledger NOT written
- **Spec ref:** §5.9 60-second timeout

### 6.2 Error Propagation

#### ERR-001: SDK-level errors during payInvoice pass through
- **Setup:** Module with invoice; PaymentsModule.send() fails with insufficient balance
- **Action:** `payInvoice(invoiceId, ...)`
- **Verify:** PaymentsModule error passes through unchanged
- **Spec ref:** §8.5 "Downstream errors"

#### ERR-002: Internal accounting errors do not interrupt inbound transfer processing
- **Setup:** Module with invoice; processTokenTransactions() throws error
- **Action:** Trigger 'transfer:incoming' event
- **Verify:** Error caught, logged; PaymentsModule event processing continues
- **Spec ref:** §4.7 "Non-blocking inbound observer"

#### ERR-003: DM delivery failures collected in results, not thrown
- **Setup:** Module with invoice; some recipients unresolvable
- **Action:** `sendInvoiceReceipts(invoiceId)`
- **Verify:** Partial success returned; failedReceipts array populated; no throw
- **Spec ref:** §8.9 "Per-sender DM delivery failures"

### 6.3 Edge Cases

#### EDGE-001: Zero-amount coin in multi-coin token
- **Setup:** Token with UCT: 100, USDU: 0
- **Action:** Receive transfer; scan for INV reference
- **Verify:** USDU: 0 entry skipped; no balance entry, no event
- **Spec ref:** §5.4.3 skip rule

#### EDGE-002: Self-payment (creator is target)
- **Setup:** Invoice where creator is one of the targets
- **Action:** Creator pays their own invoice
- **Verify:** Fires invoice:irrelevant with reason 'self_payment'
- **Spec ref:** §6.2 step 6b

#### EDGE-003: Masked sender (senderAddress = null) with auto-return
- **Setup:** Transfer with masked predicate and no refundAddress; auto-return enabled
- **Action:** Receive forward transfer with masked sender (senderAddress=null, no refundAddress); auto-return is triggered
- **Verify:** Fires invoice:auto_return_failed with reason 'sender_unresolvable'
- **Spec ref:** §6.2 step 5 auto-return resolution

#### EDGE-004: Clock skew: createdAt in future
- **Setup:** Token with createdAt = now + 3600000 (within 1-day tolerance)
- **Action:** `importInvoice(token)`
- **Verify:** Accepted without error
- **Spec ref:** §8.2 clock skew tolerance

#### EDGE-005: DueDate expired at creation time
- **Setup:** Now = 1000
- **Action:** `createInvoice({ dueDate: 999 })`
- **Verify:** Throws INVOICE_PAST_DUE_DATE
- **Spec ref:** §8.1 "dueDate must be in the future"

---

## Appendix A: Test Matrix

| Category | Test Count | Coverage |
|----------|-----------|----------|
| Module Lifecycle | 9 | load, destroy, MODULE_DESTROYED, load-subscribe gap |
| createInvoice() | 37 | All validation rules + edge cases + NFT invalid |
| importInvoice() | 10 | Validation + P2P async + timestamp checks |
| getInvoiceStatus() | 19 | All state transitions + implicit close + EXPIRED states |
| getInvoices() | 10 | Filtering + pagination + sorting + null-last |
| getInvoice() | 4 | Lookup + sync behavior |
| closeInvoice() | 7 | Authorization + state + auto-return |
| cancelInvoice() | 6 | Authorization + state + auto-return |
| payInvoice() | 12 | Validation + direction codes + contact |
| returnInvoicePayment() | 7 | Balance validation + terminal state semantics |
| setAutoReturn() / getAutoReturnSettings() | 8 | Global + per-invoice + cooldown + synchronous |
| Memo Encoding/Decoding | 11 | All direction codes + parse/build + normalization + legacy fallback |
| Events (Idempotency & Firing) | 25 | All 19 event types (including unknown_reference + over_refund_warning) |
| On-Chain Message Decoding | 11 | Type guards + control character stripping + truncation |
| Token Minting Internals | 10 | Determinism + serialization + REQUEST_ID_EXISTS |
| Invoice-Transfer Index | 11 | Cold-start + watermark + dedup + caps + error isolation |
| Payer-Side DM Processing | 10 | Receipt/cancellation DM parsing + size guards |
| autoTerminateOnReturn | 5 | RC/RX handling + deadlock prevention |
| Storage & Crash Recovery | 9 | Write order + reconciliation + pruning + corruption |
| Validation Gauntlet | 10 | Creator self-assertion + injection vectors + concurrency (UT-VAL-004 removed as duplicate; IDs skip from 003 to 005) |
| sendInvoiceReceipts() | 16 | Happy path + error paths + contact resolution + partial failures |
| sendCancellationNotices() | 10 | Happy path + error paths + reason/deal validation |
| getRelatedTransfers() | 6 | Query + irrelevant + empty + multi-coin + post-termination |
| CLI Integration | 33 | All 14 CLI commands (30 tests) + 3 security tests |
| **Unit Tests Total** | **~275** | All 17 methods + all error paths |
| **E2E Integration Tests** | **1 specified + planned** | Full workflow IT-LIFECYCLE-001; §4.2–4.10 planned |
| **E2E CLI Tests** | **Planned** | Pending expansion |
| **Concurrency Tests** | **8** | Gate serialization + race conditions + timeout |
| **Error Propagation** | **3** | SDK passthrough + non-blocking + partial DM failure |
| **Edge Cases** | **5** | Zero-amount + self-payment + masked sender + clock skew + past due |

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
| `INVOICE_INVALID_NFT` | UT-CREATE-037 | Non-64-hex NFT tokenId | createInvoice | INVOICE_INVALID_NFT |
| `INVOICE_PAST_DUE_DATE` | UT-CREATE-006, UT-CREATE-007 | dueDate ≤ now | createInvoice | INVOICE_PAST_DUE_DATE |
| `INVOICE_DUPLICATE_ADDRESS` | UT-CREATE-020 | Same address twice | createInvoice | INVOICE_DUPLICATE_ADDRESS |
| `INVOICE_DUPLICATE_COIN` | UT-CREATE-021 | Same coinId in target | createInvoice | INVOICE_DUPLICATE_COIN |
| `INVOICE_DUPLICATE_NFT` | UT-CREATE-022 | Same NFT in target | createInvoice | INVOICE_DUPLICATE_NFT |
| `INVOICE_MINT_FAILED` | UT-CREATE-032 | Oracle submitTransaction fails | createInvoice | INVOICE_MINT_FAILED |
| `INVOICE_INVALID_PROOF` | UT-IMPORT-002 | Token broken proof | importInvoice | INVOICE_INVALID_PROOF |
| `INVOICE_WRONG_TOKEN_TYPE` | UT-IMPORT-003 | Non-INVOICE tokenType | importInvoice | INVOICE_WRONG_TOKEN_TYPE |
| `INVOICE_INVALID_DATA` | UT-IMPORT-004, UT-IMPORT-005 | Unparseable/invalid terms | importInvoice | INVOICE_INVALID_DATA |
| `INVOICE_ALREADY_EXISTS` | UT-IMPORT-006 | Duplicate import | importInvoice | INVOICE_ALREADY_EXISTS |
| `INVOICE_NOT_FOUND` | UT-STATUS-006, UT-CLOSE-007, UT-CANCEL-006, UT-PAY-008, UT-RETURN-005, UT-AUTORET-008, UT-RECEIPTS-009, UT-NOTICES-009, UT-TRANSFERS-004 | Unknown invoiceId | getStatus/close/cancel/pay/return/autoReturn/receipts/notices/transfers | INVOICE_NOT_FOUND |
| `INVOICE_NOT_TARGET` | UT-CLOSE-002, UT-CANCEL-002, UT-RETURN-004, UT-RECEIPTS-010, UT-NOTICES-006 | Caller not target | close/cancel/return/receipts/notices | INVOICE_NOT_TARGET |
| `INVOICE_ALREADY_CLOSED` | UT-CLOSE-003, UT-CANCEL-003 | Close/cancel CLOSED | close/cancel | INVOICE_ALREADY_CLOSED |
| `INVOICE_ALREADY_CANCELLED` | UT-CLOSE-004, UT-CANCEL-004 | Close/cancel CANCELLED | close/cancel | INVOICE_ALREADY_CANCELLED |
| `INVOICE_ORACLE_REQUIRED` | UT-CREATE-031 | No oracle | createInvoice | INVOICE_ORACLE_REQUIRED |
| `INVOICE_TERMINATED` | UT-PAY-003, UT-PAY-004 | Pay CLOSED/CANCELLED | payInvoice | INVOICE_TERMINATED |
| `INVOICE_INVALID_TARGET` | UT-PAY-005 | Out-of-bounds targetIndex | payInvoice | INVOICE_INVALID_TARGET |
| `INVOICE_INVALID_ASSET_INDEX` | UT-PAY-006 | Out-of-bounds assetIndex | payInvoice | INVOICE_INVALID_ASSET_INDEX |
| `INVOICE_RETURN_EXCEEDS_BALANCE` | UT-RETURN-003, CONC-004 | Return > net balance | returnInvoicePayment | INVOICE_RETURN_EXCEEDS_BALANCE |
| `INVOICE_INVALID_DELIVERY_METHOD` | UT-CREATE-033 to UT-CREATE-035 | Invalid scheme/length/count | createInvoice | INVOICE_INVALID_DELIVERY_METHOD |
| `INVOICE_INVALID_REFUND_ADDRESS` | UT-PAY-007 | Invalid DIRECT:// | payInvoice | INVOICE_INVALID_REFUND_ADDRESS |
| `INVOICE_INVALID_CONTACT` | UT-PAY-011, UT-PAY-012 | Invalid contact | payInvoice | INVOICE_INVALID_CONTACT |
| `INVOICE_INVALID_ID` | UT-MEMO-009 | Short/invalid invoice ID | buildInvoiceMemo | INVOICE_INVALID_ID |
| `INVOICE_TOO_MANY_TARGETS` | UT-CREATE-024 | 101+ targets | createInvoice | INVOICE_TOO_MANY_TARGETS |
| `INVOICE_TOO_MANY_ASSETS` | UT-CREATE-026 | 51+ assets per target | createInvoice | INVOICE_TOO_MANY_ASSETS |
| `INVOICE_MEMO_TOO_LONG` | UT-CREATE-028, UT-RECEIPTS-011, UT-NOTICES-004, UT-NOTICES-005 | Memo > 4096 | createInvoice/sendReceipts/sendNotices | INVOICE_MEMO_TOO_LONG |
| `INVOICE_TERMS_TOO_LARGE` | UT-CREATE-030 | Terms > 64 KB | createInvoice | INVOICE_TERMS_TOO_LARGE |
| `RATE_LIMITED` | UT-AUTORET-004 | setAutoReturn('*') within 5s | setAutoReturn | RATE_LIMITED |
| `INVOICE_NOT_TERMINATED` | UT-RECEIPTS-012, UT-RECEIPTS-013, UT-RECEIPTS-015, UT-RECEIPTS-016 | sendReceipts on non-terminal (COVERED/OPEN/PARTIAL/EXPIRED) | sendInvoiceReceipts | INVOICE_NOT_TERMINATED |
| `INVOICE_NOT_CANCELLED` | UT-NOTICES-002 | sendCancellationNotices on CLOSED | sendCancellationNotices | INVOICE_NOT_CANCELLED |
| `COMMUNICATIONS_UNAVAILABLE` | UT-RECEIPTS-014, UT-NOTICES-007 | No CommunicationsModule | sendReceipts/notices | COMMUNICATIONS_UNAVAILABLE |
| `MODULE_DESTROYED` | UT-LIFECYCLE-007 | After destroy() | All I/O methods | MODULE_DESTROYED |

---

**END OF TEST SPECIFICATION**
