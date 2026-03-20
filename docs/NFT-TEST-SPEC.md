# NFT Module Test Specification

> **Status:** Draft — no tests yet
> **Test path:** `tests/unit/modules/NFTModule.*.test.ts`
> **Spec:** [NFT-SPEC.md](NFT-SPEC.md)
> **Architecture:** [NFT-ARCHITECTURE.md](NFT-ARCHITECTURE.md)
> **Framework:** Vitest

---

## Table of Contents

1. [Test Infrastructure](#1-test-infrastructure)
2. [Collection Management Tests](#2-collection-management-tests)
3. [Minting Tests](#3-minting-tests)
4. [Transfer Tests](#4-transfer-tests)
5. [Query Tests](#5-query-tests)
6. [Import / Export Tests](#6-import--export-tests)
7. [Verification Tests](#7-verification-tests)
8. [Event Processing Tests](#8-event-processing-tests)
9. [Lifecycle Tests](#9-lifecycle-tests)
10. [Serialization Tests](#10-serialization-tests)
11. [Concurrency Tests](#11-concurrency-tests)
12. [Error Handling Tests](#12-error-handling-tests)
13. [Storage Tests](#13-storage-tests)
14. [Integration Tests](#14-integration-tests)

---

## 1. Test Infrastructure

### 1.1 Test File Organization

```
tests/unit/modules/
├── NFTModule.collection.test.ts      # §2 Collection management
├── NFTModule.mint.test.ts            # §3 Minting
├── NFTModule.transfer.test.ts        # §4 Transfer
├── NFTModule.query.test.ts           # §5 Queries
├── NFTModule.importExport.test.ts    # §6 Import/Export
├── NFTModule.verification.test.ts    # §7 Verification
├── NFTModule.events.test.ts          # §8 Event processing
├── NFTModule.lifecycle.test.ts       # §9 Module lifecycle
├── NFTModule.serialization.test.ts   # §10 Serialization
├── NFTModule.concurrency.test.ts     # §11 Concurrency
├── NFTModule.errors.test.ts          # §12 Error handling
├── NFTModule.storage.test.ts         # §13 Storage
└── nft-test-helpers.ts               # Shared test utilities
```

### 1.2 Test Helper: `nft-test-helpers.ts`

```typescript
// Shared test utilities for NFT module tests

export { SphereError, NFT_TOKEN_TYPE_HEX };

/**
 * Create a mock NFTModuleConfig with all dependencies stubbed.
 */
export function createMockNFTConfig(overrides?: Partial<NFTModuleConfig>): NFTModuleConfig;

/**
 * Create a valid CollectionDefinition for testing.
 */
export function createTestCollectionDef(overrides?: Partial<CollectionDefinition>): CollectionDefinition;

/**
 * Create a valid NFTMetadata for testing.
 */
export function createTestMetadata(overrides?: Partial<NFTMetadata>): NFTMetadata;

/**
 * Create a valid NFTTokenData for testing.
 */
export function createTestNFTTokenData(overrides?: Partial<NFTTokenData>): NFTTokenData;

/**
 * Create a valid TxfToken representing an NFT with the given metadata.
 * Sets tokenType = NFT_TOKEN_TYPE_HEX, coinData = null,
 * tokenData = canonicalSerializeNFT(nftTokenData).
 */
export function createNFTTxfToken(nftData?: Partial<NFTTokenData>): TxfToken;

/**
 * Create a valid TxfToken representing a non-NFT token (for negative tests).
 */
export function createFungibleTxfToken(): TxfToken;

/**
 * Create a mock PaymentsModule with standard stubs.
 */
export function createMockPayments(): MockPaymentsModule;

/**
 * Create a mock OracleProvider that simulates successful minting.
 */
export function createMockOracle(): MockOracleProvider;

/**
 * Create a mock StorageProvider with in-memory backing.
 */
export function createMockStorage(): MockStorageProvider;

/**
 * Create a mock TokenStorageProvider with in-memory backing.
 */
export function createMockTokenStorage(): MockTokenStorageProvider;

/**
 * Standard test identity for NFT tests.
 */
export const TEST_IDENTITY: FullIdentity;

/**
 * Standard test collection ID (deterministic from TEST_COLLECTION_DEF).
 */
export const TEST_COLLECTION_ID: string;

/**
 * Standard test collection definition.
 */
export const TEST_COLLECTION_DEF: CollectionDefinition;
```

### 1.3 Mock Patterns

Following the accounting module's mock patterns:

- **PaymentsModule:** Stub `getTokens()` to return configured token arrays, `send()` to return success/failure, `on()` to capture event handlers.
- **OracleProvider:** Stub `submitMintCommitment()` to return `{ status: 'SUCCESS', requestId }`, `waitForProofSdk()` to return mocked inclusion proof.
- **StorageProvider:** In-memory `Map<string, string>` backing `get()`/`set()`/`remove()`.
- **TokenStorageProvider:** In-memory per-address maps for `get()`/`put()`/`remove()`/`list()`.

---

## 2. Collection Management Tests

### File: `NFTModule.collection.test.ts`

#### UT-COL-001: createCollection — basic happy path

- **Input:** `{ name: "Test Art", description: "A test collection" }`
- **Expected:** Returns `{ collectionId: <64-char hex>, definition: { name, description, creator: TEST_IDENTITY.chainPubkey, createdAt: <number>, maxSupply: null, ... } }`
- **Verify:** `collectionId` is deterministic SHA-256 of canonical serialization. `definition.creator` matches test identity. `definition.transferable` defaults to `true`.

#### UT-COL-002: createCollection — with all optional fields

- **Input:** `{ name: "Full Collection", description: "...", maxSupply: 100, image: "ipfs://QmHash", externalUrl: "https://example.com", royalty: { recipient: "DIRECT://...", basisPoints: 500 }, transferable: false }`
- **Expected:** All fields preserved in returned definition. `collectionId` reflects all fields.

#### UT-COL-003: createCollection — idempotent (same definition)

- **Precondition:** Call `createCollection(def)` → collectionId_1
- **Action:** Call `createCollection(def)` again with identical input
- **Expected:** Returns same `collectionId_1`. No duplicate in storage.

#### UT-COL-004: createCollection — different definitions yield different IDs

- **Input:** Two definitions differing only in name
- **Expected:** Different `collectionId` values.

#### UT-COL-005: createCollection — persists to storage

- **Action:** Create collection, then read `NFT_COLLECTIONS` key from StorageProvider
- **Expected:** Storage contains serialized `NFTCollectionsStorage` with the new collection.

#### UT-COL-006: createCollection — emits nft:collection_created event

- **Action:** Create collection
- **Expected:** `emitEvent` called with `('nft:collection_created', { collectionId, name })`.

#### UT-COL-007: createCollection — validation: empty name

- **Input:** `{ name: "", description: "..." }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-COL-008: createCollection — validation: name too long

- **Input:** `{ name: "a".repeat(129), description: "..." }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-COL-009: createCollection — validation: maxSupply zero

- **Input:** `{ name: "Test", description: "...", maxSupply: 0 }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-COL-010: createCollection — validation: maxSupply exceeds limit

- **Input:** `{ name: "Test", description: "...", maxSupply: 1_000_001 }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-COL-011: createCollection — validation: invalid royalty basisPoints

- **Input:** `{ ..., royalty: { recipient: "DIRECT://...", basisPoints: 10001 } }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-COL-012: createCollection — validation: negative royalty basisPoints

- **Input:** `{ ..., royalty: { recipient: "DIRECT://...", basisPoints: -1 } }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-COL-013: getCollection — returns existing collection

- **Precondition:** Collection created
- **Expected:** Returns `CollectionRef` with correct fields, `isCreator: true`, `tokenCount: 0`.

#### UT-COL-014: getCollection — returns null for unknown ID

- **Input:** Random 64-char hex
- **Expected:** Returns `null`.

#### UT-COL-015: getCollections — returns all collections

- **Precondition:** 3 collections created
- **Expected:** Returns array of 3 `CollectionRef` objects.

#### UT-COL-016: getCollections — filter createdByMe

- **Precondition:** 2 collections: one created locally, one from imported NFT (different creator)
- **Input:** `{ createdByMe: true }`
- **Expected:** Returns only the locally created collection.

#### UT-COL-017: getCollections — sort by name

- **Precondition:** Collections "Zebra", "Alpha", "Middle"
- **Input:** `{ sortBy: 'name', sortOrder: 'asc' }`
- **Expected:** ["Alpha", "Middle", "Zebra"].

#### UT-COL-018: getCollections — sort by tokenCount

- **Precondition:** Collections with 0, 5, 2 tokens
- **Input:** `{ sortBy: 'tokenCount', sortOrder: 'desc' }`
- **Expected:** [5, 2, 0].

---

## 3. Minting Tests

### File: `NFTModule.mint.test.ts`

#### UT-MINT-001: NFT_TOKEN_TYPE_HEX = SHA-256(UTF-8("unicity.nft.v1"))

- **Expected:** `NFT_TOKEN_TYPE_HEX` is 64 lowercase hex chars. Value matches `SHA-256("unicity.nft.v1")`.

#### UT-MINT-002: mintNFT — basic happy path

- **Precondition:** Collection exists
- **Input:** `{ collectionId, metadata: { name: "Art #1", image: "ipfs://QmHash" } }`
- **Expected:**
  - Oracle `submitMintCommitment` called once
  - Token stored in TokenStorage with `tokenType === NFT_TOKEN_TYPE_HEX`
  - `genesis.data.coinData` is `null` or empty array
  - `genesis.data.tokenData` contains serialized NFTTokenData
  - Returns `{ tokenId: <64-hex>, confirmed: true, nft: NFTRef }`

#### UT-MINT-003: mintNFT — with explicit edition

- **Input:** `{ collectionId, metadata: {...}, edition: 42, totalEditions: 100 }`
- **Expected:** NFTTokenData in tokenData contains `edition: 42`, `totalEditions: 100`.

#### UT-MINT-004: mintNFT — auto-increment edition

- **Precondition:** Collection exists, no prior mints
- **Action:** Mint 3 NFTs without specifying edition
- **Expected:** Editions are 1, 2, 3 respectively.

#### UT-MINT-005: mintNFT — with all metadata fields

- **Input:** Metadata with name, description, image, animationUrl, externalUrl, backgroundColor, attributes (3 items), properties, content
- **Expected:** All fields preserved in stored token's genesis.data.tokenData.

#### UT-MINT-006: mintNFT — with recipient (not self)

- **Input:** `{ collectionId, metadata: {...}, recipient: "@bob" }`
- **Expected:** Token minted to resolved recipient address. Oracle receives recipient's DirectAddress.

#### UT-MINT-007: mintNFT — collection not found

- **Input:** `{ collectionId: "unknown_hex_id", metadata: {...} }`
- **Expected:** Throws `SphereError('NFT_COLLECTION_NOT_FOUND')`.

#### UT-MINT-008: mintNFT — maxSupply exceeded

- **Precondition:** Collection with maxSupply: 2, 2 NFTs already minted
- **Input:** Mint 3rd NFT
- **Expected:** Throws `SphereError('NFT_MAX_SUPPLY_EXCEEDED')`.

#### UT-MINT-009: mintNFT — maxSupply boundary (exactly at limit)

- **Precondition:** Collection with maxSupply: 3, 2 NFTs already minted
- **Input:** Mint 3rd NFT
- **Expected:** Success (at limit, not over).

#### UT-MINT-010: mintNFT — unlimited maxSupply (null)

- **Precondition:** Collection with maxSupply: null
- **Action:** Mint 100 NFTs
- **Expected:** All succeed.

#### UT-MINT-011: mintNFT — invalid metadata: missing name

- **Input:** `{ collectionId, metadata: { image: "ipfs://..." } }` (no name)
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-MINT-012: mintNFT — invalid metadata: missing image

- **Input:** `{ collectionId, metadata: { name: "Test" } }` (no image)
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-MINT-013: mintNFT — invalid metadata: name too long

- **Input:** `{ collectionId, metadata: { name: "a".repeat(257), image: "..." } }`
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-MINT-014: mintNFT — invalid metadata: too many attributes

- **Input:** Metadata with 101 attributes
- **Expected:** Throws `SphereError('NFT_INVALID_METADATA')`.

#### UT-MINT-015: mintNFT — oracle rejection

- **Precondition:** Oracle `submitMintCommitment` returns failure
- **Expected:** Throws `SphereError('NFT_MINT_FAILED')`.

#### UT-MINT-016: mintNFT — oracle idempotent (REQUEST_ID_EXISTS)

- **Precondition:** Oracle returns `REQUEST_ID_EXISTS`
- **Expected:** Continues with proof polling (idempotent).

#### UT-MINT-017: mintNFT — emits nft:minted event

- **Action:** Successful mint
- **Expected:** `emitEvent` called with `('nft:minted', { tokenId, collectionId, name, confirmed: true })`.

#### UT-MINT-018: mintNFT — updates in-memory index

- **Action:** Mint NFT
- **Expected:** `getNFTs()` returns the new NFT. `getCollection().tokenCount` increments.

#### UT-MINT-019: mintNFT — unique token IDs per mint

- **Action:** Mint 2 NFTs with identical metadata in same collection
- **Expected:** Different token IDs (different salts).

#### UT-MINT-020: mintNFT — minter field set to identity

- **Action:** Mint NFT
- **Expected:** Parsed NFTTokenData has `minter === identity.chainPubkey`.

#### UT-MINT-021: batchMintNFT — happy path

- **Input:** 5 items with different metadata
- **Expected:** All 5 succeed. Returns `{ results: [5 items], successCount: 5, failureCount: 0 }`.

#### UT-MINT-022: batchMintNFT — partial failure

- **Precondition:** Oracle fails on 3rd submission
- **Input:** 5 items
- **Expected:** 4 succeed, 1 fails. `errors` contains `[{ index: 2, error: "..." }]`.

#### UT-MINT-023: batchMintNFT — exceeds batch size limit

- **Input:** 51 items
- **Expected:** Throws error (exceeds `NFT_MAX_BATCH_SIZE`).

#### UT-MINT-024: batchMintNFT — maxSupply check before batch

- **Precondition:** Collection maxSupply: 5, 3 already minted
- **Input:** Batch of 3 items
- **Expected:** Throws `SphereError('NFT_MAX_SUPPLY_EXCEEDED')` (3 + 3 > 5).

#### UT-MINT-025: batchMintNFT — auto-increment editions across batch

- **Action:** Batch mint 3 items without explicit editions
- **Expected:** Editions are sequential (e.g., 1, 2, 3).

---

## 4. Transfer Tests

### File: `NFTModule.transfer.test.ts`

#### UT-XFER-001: transferNFT — happy path

- **Precondition:** NFT exists in wallet
- **Input:** `{ tokenId, recipient: "@bob" }`
- **Expected:** `PaymentsModule.send()` called with correct parameters. Returns `TransferResult`. NFT removed from in-memory index.

#### UT-XFER-002: transferNFT — emits nft:transferred event

- **Action:** Successful transfer
- **Expected:** `emitEvent` called with `('nft:transferred', { tokenId, collectionId, recipientPubkey, recipientNametag })`.

#### UT-XFER-003: transferNFT — NFT not found

- **Input:** `{ tokenId: "nonexistent", recipient: "@bob" }`
- **Expected:** Throws `SphereError('NFT_NOT_FOUND')`.

#### UT-XFER-004: transferNFT — non-transferable collection

- **Precondition:** NFT in collection with `transferable: false`
- **Expected:** Throws `SphereError('NFT_NOT_TRANSFERABLE')`.

#### UT-XFER-005: transferNFT — wrong token type

- **Precondition:** Token exists but is a fungible token
- **Expected:** Throws `SphereError('NFT_WRONG_TOKEN_TYPE')`.

#### UT-XFER-006: transferNFT — send() failure propagated

- **Precondition:** `PaymentsModule.send()` throws/returns failed status
- **Expected:** Error propagated to caller.

#### UT-XFER-007: transferNFT — with memo

- **Input:** `{ tokenId, recipient: "@bob", memo: "Gift for you" }`
- **Expected:** `send()` called with memo.

#### UT-XFER-008: transferNFT — NFT atomicity (no splitting)

- **Action:** Transfer NFT
- **Expected:** `send()` called with `_nftTransfer: true` to prevent token splitting.

#### UT-XFER-009: transferNFT — recipient resolution

- **Input:** Different recipient formats: @nametag, DIRECT://, chain pubkey, alpha1...
- **Expected:** All resolve correctly and pass to `send()`.

#### UT-XFER-010: transferNFT — updates collection tokenCount

- **Precondition:** Collection with 3 NFTs
- **Action:** Transfer 1 NFT
- **Expected:** `getCollection().tokenCount === 2`.

---

## 5. Query Tests

### File: `NFTModule.query.test.ts`

#### UT-QUERY-001: getNFT — returns full detail

- **Precondition:** NFT exists
- **Expected:** Returns `NFTDetail` with metadata, collection, token, edition.

#### UT-QUERY-002: getNFT — returns null for unknown ID

- **Expected:** Returns `null`.

#### UT-QUERY-003: getNFT — returns null for non-NFT token

- **Precondition:** Fungible token with known ID
- **Expected:** Returns `null`.

#### UT-QUERY-004: getNFTs — returns all NFTs

- **Precondition:** 5 NFTs across 2 collections
- **Expected:** Returns 5 `NFTRef` objects.

#### UT-QUERY-005: getNFTs — filter by collectionId

- **Precondition:** 3 NFTs in collection A, 2 in collection B
- **Input:** `{ collectionId: collectionA }`
- **Expected:** Returns 3 NFTs.

#### UT-QUERY-006: getNFTs — filter by status

- **Precondition:** 3 confirmed, 1 pending NFTs
- **Input:** `{ status: 'confirmed' }`
- **Expected:** Returns 3 NFTs.

#### UT-QUERY-007: getNFTs — filter by multiple statuses

- **Input:** `{ status: ['confirmed', 'pending'] }`
- **Expected:** Returns all matching NFTs.

#### UT-QUERY-008: getNFTs — sort by name ascending

- **Precondition:** NFTs named "Zebra", "Alpha", "Middle"
- **Input:** `{ sortBy: 'name', sortOrder: 'asc' }`
- **Expected:** ["Alpha", "Middle", "Zebra"].

#### UT-QUERY-009: getNFTs — sort by mintedAt descending

- **Precondition:** NFTs minted at t1, t2, t3 (t1 < t2 < t3)
- **Input:** `{ sortBy: 'mintedAt', sortOrder: 'desc' }`
- **Expected:** [t3, t2, t1].

#### UT-QUERY-010: getNFTs — pagination

- **Precondition:** 10 NFTs
- **Input:** `{ offset: 3, limit: 4 }`
- **Expected:** Returns 4 NFTs starting from index 3.

#### UT-QUERY-011: getNFTs — empty wallet

- **Precondition:** No NFTs
- **Expected:** Returns `[]`.

#### UT-QUERY-012: getCollectionNFTs — returns NFTs in collection

- **Precondition:** 3 NFTs in target collection
- **Expected:** Returns 3 NFTs, all with matching `collectionId`.

#### UT-QUERY-013: getCollectionNFTs — unknown collection

- **Expected:** Returns `[]`.

#### UT-QUERY-014: getNFTHistory — mint event

- **Precondition:** NFT with 1 transaction (genesis)
- **Expected:** Returns `[{ type: 'mint', timestamp, confirmed: true }]`.

#### UT-QUERY-015: getNFTHistory — transfer chain

- **Precondition:** NFT with genesis + 2 transfer transactions
- **Expected:** Returns 3 entries in chronological order.

#### UT-QUERY-016: getNFTHistory — unknown token

- **Expected:** Returns `[]`.

---

## 6. Import / Export Tests

### File: `NFTModule.importExport.test.ts`

#### UT-IMP-001: importNFT — happy path

- **Input:** Valid `TxfToken` with `tokenType === NFT_TOKEN_TYPE_HEX` and valid NFTTokenData
- **Expected:** Token stored. NFTRef added to index. Collection registered. Event emitted.

#### UT-IMP-002: importNFT — wrong token type

- **Input:** `TxfToken` with `tokenType !== NFT_TOKEN_TYPE_HEX`
- **Expected:** Throws `SphereError('NFT_WRONG_TOKEN_TYPE')`.

#### UT-IMP-003: importNFT — invalid tokenData (parse error)

- **Input:** `TxfToken` with `tokenType === NFT_TOKEN_TYPE_HEX` but `tokenData` is garbage
- **Expected:** Throws `SphereError('NFT_PARSE_ERROR')`.

#### UT-IMP-004: importNFT — idempotent (duplicate token ID)

- **Action:** Import same token twice
- **Expected:** Second call returns existing NFTRef without error.

#### UT-IMP-005: importNFT — registers unknown collection

- **Input:** Token from collection not in local registry
- **Expected:** Synthetic `CollectionRef` created from NFT metadata. Collection available via `getCollection()`.

#### UT-IMP-006: importNFT — emits nft:imported event

- **Expected:** `emitEvent` called with `('nft:imported', { tokenId, collectionId, name })`.

#### UT-IMP-007: importNFT — updates collection tokenCount

- **Precondition:** Collection with 2 NFTs
- **Action:** Import 1 more NFT from same collection
- **Expected:** `tokenCount === 3`.

#### UT-EXP-001: exportNFT — happy path

- **Precondition:** NFT exists
- **Expected:** Returns complete `TxfToken` with all fields.

#### UT-EXP-002: exportNFT — unknown token

- **Expected:** Returns `null`.

#### UT-EXP-003: exportNFT — non-NFT token

- **Precondition:** Fungible token exists
- **Expected:** Returns `null` (only exports NFTs).

#### UT-EXP-004: importNFT then exportNFT — round-trip

- **Action:** Import token, then export by same tokenId
- **Expected:** Exported token matches imported token (byte-level comparison after normalization).

---

## 7. Verification Tests

### File: `NFTModule.verification.test.ts`

#### UT-VER-001: verifyNFT — valid token

- **Precondition:** Oracle returns `{ valid: true, spent: false }`
- **Expected:** Returns `{ valid: true, spent: false, stateHash: "..." }`.

#### UT-VER-002: verifyNFT — spent token

- **Precondition:** Oracle returns `{ valid: true, spent: true }`
- **Expected:** Returns `{ valid: true, spent: true }`.

#### UT-VER-003: verifyNFT — invalid token

- **Precondition:** Oracle returns `{ valid: false }`
- **Expected:** Returns `{ valid: false, errors: [...] }`.

#### UT-VER-004: verifyNFT — unknown token

- **Expected:** Throws `SphereError('NFT_NOT_FOUND')`.

#### UT-VER-005: verifyNFT — emits nft:verified event

- **Expected:** Event emitted with `{ tokenId, valid, spent }`.

---

## 8. Event Processing Tests

### File: `NFTModule.events.test.ts`

#### UT-EVT-001: incoming transfer with NFT tokens

- **Precondition:** Module subscribed to `transfer:incoming`
- **Action:** Simulate incoming transfer with 1 NFT token (tokenType === NFT_TOKEN_TYPE_HEX)
- **Expected:** `nft:received` event emitted. NFT added to index. Collection registered.

#### UT-EVT-002: incoming transfer with mixed tokens

- **Action:** Simulate incoming transfer with 1 NFT + 1 fungible token
- **Expected:** `nft:received` emitted for NFT only. Fungible token ignored.

#### UT-EVT-003: incoming transfer with no NFTs

- **Action:** Simulate incoming transfer with only fungible tokens
- **Expected:** No `nft:received` event.

#### UT-EVT-004: incoming transfer — parse error logged but not thrown

- **Action:** Simulate incoming transfer with NFT token that has malformed tokenData
- **Expected:** Error logged. NO exception thrown. Transfer processing continues.

#### UT-EVT-005: incoming transfer — multiple NFTs in one transfer

- **Action:** Simulate incoming transfer with 3 NFT tokens
- **Expected:** 3 `nft:received` events emitted. All 3 NFTs in index.

#### UT-EVT-006: incoming transfer — unknown collection auto-registered

- **Action:** Receive NFT from unknown collection
- **Expected:** `CollectionRef` created with `isCreator: false`. Available via `getCollections()`.

#### UT-EVT-007: transfer:confirmed updates NFT status

- **Action:** Simulate `transfer:confirmed` for an outgoing NFT
- **Expected:** NFT removed from index (transferred away).

#### UT-EVT-008: event handler resilience — error in one NFT doesn't block others

- **Action:** Transfer with 3 NFTs, 2nd has malformed metadata
- **Expected:** 1st and 3rd processed. 2nd logged as error. No throw.

---

## 9. Lifecycle Tests

### File: `NFTModule.lifecycle.test.ts`

#### UT-LIFE-001: load() discovers existing NFTs

- **Precondition:** TokenStorage has 3 NFT tokens and 2 fungible tokens
- **Action:** `module.load()`
- **Expected:** `getNFTs()` returns 3. `getTokens()` not filtered (that's PaymentsModule's job).

#### UT-LIFE-002: load() builds collection index from tokens

- **Precondition:** 5 NFTs across 2 collections, no collection definitions in storage
- **Action:** `module.load()`
- **Expected:** 2 synthetic collections in index. Token counts accurate.

#### UT-LIFE-003: load() merges stored definitions with discovered tokens

- **Precondition:** StorageProvider has 1 collection definition. TokenStorage has NFTs from that collection + 1 unknown collection.
- **Action:** `module.load()`
- **Expected:** Stored definition preserved. Unknown collection gets synthetic entry.

#### UT-LIFE-004: load() subscribes to transfer events

- **Action:** `module.load()`
- **Expected:** `payments.on('transfer:incoming')` and `payments.on('transfer:confirmed')` called.

#### UT-LIFE-005: destroy() unsubscribes from events

- **Action:** `module.destroy()`
- **Expected:** Event unsubscribe functions called. Index cleared.

#### UT-LIFE-006: destroy() then load() — full reset

- **Action:** load(), mint NFT, destroy(), load()
- **Expected:** Minted NFT rediscovered from storage on second load.

#### UT-LIFE-007: load() handles empty wallet

- **Precondition:** No tokens in storage
- **Expected:** Empty indexes, no errors.

#### UT-LIFE-008: load() handles corrupt NFT token data

- **Precondition:** TokenStorage has NFT token with malformed tokenData
- **Expected:** Token skipped with warning log. Other tokens loaded normally.

---

## 10. Serialization Tests

### File: `NFTModule.serialization.test.ts`

#### UT-SER-001: canonicalSerializeNFT — deterministic output

- **Action:** Serialize same NFTTokenData twice
- **Expected:** Identical strings.

#### UT-SER-002: canonicalSerializeNFT — key ordering

- **Action:** Serialize NFTTokenData with all fields
- **Expected:** Keys appear in strict alphabetical order at every level.

#### UT-SER-003: canonicalSerializeNFT — null normalization

- **Action:** Serialize NFTTokenData with optional fields omitted
- **Expected:** Optional fields appear as `null` in output.

#### UT-SER-004: canonicalSerializeNFT — attribute sorting

- **Action:** Serialize metadata with attributes `[{trait_type:"Z",...}, {trait_type:"A",...}]`
- **Expected:** Attributes sorted: `A` before `Z`.

#### UT-SER-005: canonicalSerializeNFT — compact JSON (no whitespace)

- **Expected:** No spaces after `:` or `,`. No newlines.

#### UT-SER-006: canonicalSerializeCollection — deterministic

- **Action:** Serialize same CollectionDefinition twice
- **Expected:** Identical strings.

#### UT-SER-007: canonicalSerializeCollection — key ordering

- **Expected:** Keys in alphabetical order: `createdAt`, `creator`, `description`, `externalUrl`, `image`, `maxSupply`, `name`, `royalty`, `transferable`.

#### UT-SER-008: canonicalSerializeCollection — null normalization for optionals

- **Action:** Serialize definition without optional fields
- **Expected:** `externalUrl: null`, `image: null`, `maxSupply: null`, `royalty: null`.

#### UT-SER-009: canonicalSerializeCollection — transferable defaults to true

- **Action:** Serialize definition without explicit `transferable`
- **Expected:** `"transferable":true` in output.

#### UT-SER-010: collectionId derivation — SHA-256 of serialized definition

- **Action:** Compute SHA-256 of canonical serialization
- **Expected:** Matches `collectionId` returned by `createCollection()`.

#### UT-SER-011: tokenId stability — same metadata + salt = same ID

- **Expected:** Given identical NFTTokenData and salt, tokenId is identical.

#### UT-SER-012: tokenId uniqueness — different salt = different ID

- **Expected:** Same metadata with different salt produces different tokenId.

#### UT-SER-013: round-trip — serialize then parse

- **Action:** Serialize NFTTokenData, parse back from JSON
- **Expected:** Parsed data matches original (all fields, types, values).

#### UT-SER-014: unicode in metadata — handled correctly

- **Input:** Metadata with name containing emoji, CJK characters, RTL text
- **Expected:** Serialization preserves exact characters. Round-trip is lossless.

---

## 11. Concurrency Tests

### File: `NFTModule.concurrency.test.ts`

#### UT-CONC-001: concurrent mintNFT — edition numbers don't conflict

- **Action:** Fire 5 concurrent `mintNFT()` calls for same collection
- **Expected:** All 5 get unique, sequential edition numbers (1-5).

#### UT-CONC-002: concurrent mintNFT — maxSupply respected

- **Precondition:** Collection maxSupply: 3
- **Action:** Fire 5 concurrent `mintNFT()` calls
- **Expected:** 3 succeed, 2 fail with `NFT_MAX_SUPPLY_EXCEEDED`.

#### UT-CONC-003: concurrent createCollection — idempotent

- **Action:** Fire 3 concurrent `createCollection()` with identical definition
- **Expected:** All return same `collectionId`. Only 1 stored.

#### UT-CONC-004: concurrent mint + transfer — no race

- **Action:** Mint NFT, immediately fire transfer before mint completes
- **Expected:** Transfer waits for mint (or fails with NFT_NOT_FOUND). No corrupt state.

#### UT-CONC-005: per-collection gate isolation

- **Action:** Concurrent mints to collection A and collection B
- **Expected:** Collection A and B mints execute independently (not serialized with each other).

---

## 12. Error Handling Tests

### File: `NFTModule.errors.test.ts`

#### UT-ERR-001: all error codes use SphereError

- **Expected:** Every error thrown by NFTModule is an instance of `SphereError` with a known error code.

#### UT-ERR-002: NFT_COLLECTION_NOT_FOUND — message includes collectionId

- **Expected:** Error message contains the collectionId that was not found.

#### UT-ERR-003: NFT_NOT_FOUND — message includes tokenId

- **Expected:** Error message contains the tokenId that was not found.

#### UT-ERR-004: NFT_MAX_SUPPLY_EXCEEDED — message includes current and max

- **Expected:** Error message includes current count and maxSupply.

#### UT-ERR-005: NFT_INVALID_METADATA — message indicates which field

- **Expected:** Error message specifies which field failed validation.

#### UT-ERR-006: NFT_MINT_FAILED — includes oracle error

- **Expected:** Error message includes the oracle's rejection reason.

#### UT-ERR-007: NFT_PARSE_ERROR — includes parse details

- **Expected:** Error message indicates what parsing step failed.

#### UT-ERR-008: NFT_WRONG_TOKEN_TYPE — includes actual type

- **Expected:** Error message shows the actual tokenType vs expected NFT_TOKEN_TYPE_HEX.

#### UT-ERR-009: NFT_NOT_TRANSFERABLE — includes collection name

- **Expected:** Error message includes the collection name/ID.

---

## 13. Storage Tests

### File: `NFTModule.storage.test.ts`

#### UT-STOR-001: collection definitions persist across load/destroy

- **Action:** Create collection, destroy(), load()
- **Expected:** Collection still available via `getCollection()`.

#### UT-STOR-002: mint counter persists across load/destroy

- **Action:** Mint 3 NFTs, destroy(), load(), mint 1 more
- **Expected:** New NFT gets edition 4 (counter persisted).

#### UT-STOR-003: collection registry storage format (version field)

- **Action:** Read raw storage value for `NFT_COLLECTIONS` key
- **Expected:** Parsed JSON has `version: 1` and `collections: Record<string, CollectionDefinition>`.

#### UT-STOR-004: NFT tokens in TokenStorage — correct format

- **Action:** Read raw token from TokenStorage after mint
- **Expected:** Valid TxfToken with `version: "2.0"`, `genesis.data.tokenType === NFT_TOKEN_TYPE_HEX`, `genesis.data.coinData === null`, `genesis.data.tokenData` is parseable NFTTokenData JSON.

#### UT-STOR-005: storage key format matches convention

- **Expected:** Keys follow `sphere_{addressIndex}_{key}` pattern.

#### UT-STOR-006: multiple addresses — isolated storage

- **Action:** Create collection at address 0, switch to address 1
- **Expected:** Address 1 does not see address 0's collection definitions.

---

## 14. Integration Tests

### File: `tests/integration/nft-integration.test.ts`

These tests use real (or near-real) dependencies, not mocks.

#### IT-NFT-001: full lifecycle — create collection, mint, query, export, import

```
1. Create collection
2. Mint 3 NFTs
3. Query: getNFTs() returns 3
4. Query: getCollection() shows tokenCount: 3
5. Export 1 NFT
6. Import exported NFT (simulating receive)
7. Query: getNFTs() still returns 3 (import is idempotent)
```

#### IT-NFT-002: full lifecycle — mint and transfer

```
1. Create collection
2. Mint 1 NFT
3. Transfer to recipient
4. Verify NFT removed from sender's getNFTs()
5. Verify transfer result has correct status
```

#### IT-NFT-003: batch mint — 10 NFTs

```
1. Create collection with maxSupply: 10
2. Batch mint 10 NFTs with different metadata
3. Verify all 10 in getNFTs()
4. Verify editions are 1-10
5. Attempt 11th mint → NFT_MAX_SUPPLY_EXCEEDED
```

#### IT-NFT-004: receive NFT from unknown collection

```
1. Simulate receiving NFT transfer with unknown collectionId
2. Verify NFT appears in getNFTs()
3. Verify synthetic CollectionRef created in getCollections()
4. Verify nft:received event fired
```

#### IT-NFT-005: soulbound collection — mint but cannot transfer

```
1. Create collection with transferable: false
2. Mint NFT
3. Attempt transfer → NFT_NOT_TRANSFERABLE
4. Verify NFT still in wallet
```

#### IT-NFT-006: address switch — NFTs are per-address

```
1. Mint NFT at address 0
2. Switch to address 1
3. Verify getNFTs() returns [] at address 1
4. Switch back to address 0
5. Verify getNFTs() returns the minted NFT
```

#### IT-NFT-007: persistence — destroy and reload

```
1. Create collection, mint 3 NFTs
2. Destroy module
3. Load module
4. Verify all 3 NFTs and collection available
5. Verify mint counter at 4 (next edition)
```

---

## Appendix: Test Count Summary

| Section | File | Test Count |
|---------|------|------------|
| §2 Collection | `NFTModule.collection.test.ts` | 18 |
| §3 Minting | `NFTModule.mint.test.ts` | 25 |
| §4 Transfer | `NFTModule.transfer.test.ts` | 10 |
| §5 Queries | `NFTModule.query.test.ts` | 16 |
| §6 Import/Export | `NFTModule.importExport.test.ts` | 11 |
| §7 Verification | `NFTModule.verification.test.ts` | 5 |
| §8 Events | `NFTModule.events.test.ts` | 8 |
| §9 Lifecycle | `NFTModule.lifecycle.test.ts` | 8 |
| §10 Serialization | `NFTModule.serialization.test.ts` | 14 |
| §11 Concurrency | `NFTModule.concurrency.test.ts` | 5 |
| §12 Errors | `NFTModule.errors.test.ts` | 9 |
| §13 Storage | `NFTModule.storage.test.ts` | 6 |
| §14 Integration | `nft-integration.test.ts` | 7 |
| **Total** | | **142** |
