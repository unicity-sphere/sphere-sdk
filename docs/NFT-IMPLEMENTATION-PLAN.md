# NFT Module Implementation Plan

> **Status:** Reviewed — steelman-verified
> **Branch:** `feat/nft-module-spec`
> **Specs:** NFT-SPEC.md, NFT-ARCHITECTURE.md, ACCOUNTING-SPEC-NFT.md

---

## Overview

The NFT module adds non-fungible token creation, transfer, collection management, and metadata handling to the Sphere SDK. It follows the established module pattern (like `AccountingModule`) and integrates with existing token/transfer infrastructure.

**4 implementation waves**, 22 tasks, maximum parallelism.

---

## Pre-Flight Verification

Before starting implementation, verify these already-completed items:

- [x] `NFT_TOKEN_TYPE_HEX` exists in `constants.ts` (line 432) — `8b0136c9...`
- [x] `serialization/txf-serializer.ts` imports `NFT_TOKEN_TYPE_HEX` from `../constants` (line 33)
- [x] `txf-serializer.ts` uses `NFT_TOKEN_TYPE_HEX` for NFT detection (line 221)
- [x] `coinData: []` (empty array) works with `txfToToken()` — `.reduce()` on `[]` returns `"0"`, no crash
- [x] `NFTEntry` type exists in `modules/accounting/types.ts` (line 35) — placeholder ready
- [x] `InvoiceRequestedAsset.nft?: NFTEntry` exists (line 55) — wired into invoice targets
- [x] `createInvoice()` validates NFT entries (64-char hex tokenId, no duplicates) — line 859

---

## File Structure

### New files

```
modules/nft/
├── index.ts                  # Barrel exports + createNFTModule factory
├── types.ts                  # All NFT type definitions + limit constants
├── NFTModule.ts              # Main module class (~800 lines)
├── serialization.ts          # Canonical serialization + deriveCollectionId + parseNFTTokenData
├── validation.ts             # Input validation (metadata, collection, URIs)
└── collection-registry.ts    # Collection definition persistence + mint counters
```

### Modified files

| File | Change |
|------|--------|
| `types/index.ts` | Add `_nftTransfer`, `_tokenIds` to `TransferRequest`; add 8 NFT event types to `SphereEventType` + `SphereEventMap` |
| `core/errors.ts` | Add 12 error codes (9 NFT + 3 invoice-NFT) to `SphereErrorCode` |
| `constants.ts` | Add `NFT_COLLECTIONS`, `NFT_MINT_COUNTER` to `STORAGE_KEYS_ADDRESS` |
| `core/Sphere.ts` | Add `_nft` property, getter, init/load/destroy/switchToAddress wiring |
| `modules/payments/PaymentsModule.ts` | `_nftTransfer`/`_tokenIds` support in `send()` |
| `modules/accounting/AccountingModule.ts` | NFT payment path, transfer attribution, auto-return, freeze |
| `modules/accounting/balance-computer.ts` | NFT coverage: `isCovered` + `anyPayment` + `buildNFTAssetStatus()` |
| `modules/accounting/types.ts` | Add `'nft_mismatch'` to `IrrelevantTransfer.reason` |
| `modules/accounting/auto-return.ts` | NFT dedup key format in crash recovery |
| `connect/protocol.ts` | Add NFT RPC methods + intent actions |
| `connect/permissions.ts` | Add `nft:read`, `intent:nft_send`, `intent:nft_mint` scopes |
| `connect/host/ConnectHost.ts` | NFT query handlers + `_nftTransfer`/`_tokenIds` stripping |
| `index.ts` | Re-export NFT module |

### Unchanged files

- `serialization/txf-serializer.ts` — already uses `NFT_TOKEN_TYPE_HEX` (verified)
- `types/txf.ts` — NFTs use existing `TxfToken` with `coinData: []`

---

## Wave 0: Prerequisites (no dependencies, all 3 parallel)

### T0a: PaymentsModule `_nftTransfer`/`_tokenIds` support — M

**Files:** `types/index.ts`, `modules/payments/PaymentsModule.ts`
**Spec:** NFT-SPEC Prerequisites 1-3
**Dependencies:** None

Add to `TransferRequest` (line 123-136):
```typescript
readonly _nftTransfer?: boolean;   // skip token splitting
readonly _tokenIds?: string[];     // explicit token selection by ID
```

In `send()` (~line 1066):
- When `_tokenIds` set: bypass `spendPlanner` pool, select tokens by exact ID
- When `_nftTransfer` true: skip `TokenSplitCalculator`/`TokenSplitExecutor`, transfer as-is
- Verify `coinData: []` does not crash (Prerequisite 3)

### T0b: NFT error codes — S

**Files:** `core/errors.ts`
**Spec:** NFT-SPEC §11, ACCT-NFT N9
**Dependencies:** None

Add to `SphereErrorCode`:
```
NFT_COLLECTION_NOT_FOUND, NFT_NOT_FOUND, NFT_MAX_SUPPLY_EXCEEDED,
NFT_NOT_TRANSFERABLE, NFT_INVALID_METADATA, NFT_MINT_FAILED,
NFT_PARSE_ERROR, NFT_ALREADY_EXISTS, NFT_WRONG_TOKEN_TYPE,
INVOICE_NFT_NOT_FOUND, INVOICE_NFT_ALREADY_SENT, INVOICE_NFT_MISMATCH
```

### T0c: NFT storage keys — S

**Files:** `constants.ts`
**Spec:** NFT-SPEC §1.2
**Dependencies:** None

Add to `STORAGE_KEYS_ADDRESS`:
```typescript
NFT_COLLECTIONS: 'nft_collections',
NFT_MINT_COUNTER: 'nft_mint_counter',
```

---

## Wave 1: Types + Serialization (depends on Wave 0, 5 tasks parallel)

### T1a: NFT type definitions — M

**Files:** Create `modules/nft/types.ts`
**Spec:** NFT-ARCH §4, NFT-SPEC §1.3
**Dependencies:** T0b, T0c

All types: `CollectionDefinition` (with `deterministicMinting?: boolean`), `RoyaltyConfig`, `NFTTokenData` (collectionId: `string | null`), `NFTMetadata`, `NFTAttribute`, `NFTContent`, `NFTRef`, `NFTDetail`, `CollectionRef`, `NFTHistoryEntry`, `NFTVerificationResult`, `CreateCollectionResult`, `MintNFTResult` (collectionId: `string | null`), `BatchMintNFTResult`, `GetNFTsOptions`, `GetCollectionsOptions`, `NFTModuleConfig`, `NFTCollectionsStorage`.

Limit constants: `NFT_MAX_NAME_LENGTH=256`, `NFT_MAX_BATCH_SIZE=50`, `COLLECTION_MAX_SUPPLY_LIMIT=1_000_000`, etc.

### T1b: Canonical serialization — M

**Files:** Create `modules/nft/serialization.ts`
**Spec:** NFT-SPEC §2.1-2.4
**Dependencies:** T1a

- `canonicalSerializeNFT(data: NFTTokenData): string`
- `canonicalSerializeCollection(def: CollectionDefinition): string` — includes `deterministicMinting`
- `deriveCollectionId(def: CollectionDefinition): string` — SHA-256
- `parseNFTTokenData(tokenDataStr: string): NFTTokenData | null`
- Re-export `NFT_TOKEN_TYPE_HEX`

Uses `@noble/hashes/sha256`, `@noble/hashes/utils`.

### T1c: NFT event types — S

**Files:** `types/index.ts`
**Spec:** NFT-SPEC §9.2-9.3, ACCT-NFT N8
**Dependencies:** T0b

Add to `SphereEventType`:
```
'nft:minted', 'nft:received', 'nft:transferred', 'nft:verified',
'nft:collection_created', 'nft:imported',
'invoice:nft_received', 'invoice:nft_returned'
```

Add payloads to `SphereEventMap` — all `collectionId` fields typed `string | null`.

### T1d: Input validation — S

**Files:** Create `modules/nft/validation.ts`
**Spec:** NFT-SPEC §3.1, §4.1.1
**Dependencies:** T1a

- `validateNFTMetadata(metadata)` — name, image required; length limits; attribute count ≤ 100
- `validateCreateCollectionRequest(request)` — name, description, maxSupply, royalty
- `validateRoyaltyConfig(royalty)` — basisPoints 0-10000
- `validateImageUri(uri)` — ipfs://, https://, data: schemes

### T1e: Collection registry — M

**Files:** Create `modules/nft/collection-registry.ts`
**Spec:** NFT-SPEC §3.1, §10
**Dependencies:** T1a, T0c

`CollectionRegistry` class: load/save/get/set/getAll, `getNextEdition(collectionId)`, `buildCollectionRef()`.

---

## Wave 2: Core Module + Accounting (depends on Wave 1)

> **IMPORTANT:** Tasks T2c, T2d, T2f all modify `AccountingModule.ts` (4000+ lines).
> T2e modifies `balance-computer.ts` but is logically dependent on T2d's NFT classification.
> The chain T2c → T2d → T2e → T2f MUST execute sequentially to avoid merge conflicts
> and maintain logical dependency. The NFT module tasks (T2a-mint, T2a-query) run
> in parallel alongside on different files.

### T2a-mint: NFTModule — minting + collections — L

**Files:** Create `modules/nft/NFTModule.ts` (partial — minting half)
**Spec:** NFT-SPEC §3, §4, §12-13
**Dependencies:** T1a-T1e, T0a

- Constructor, `load()`, `destroy()` lifecycle
- `createCollection(request)`, `getCollection(id)`, `getCollections(options?)`
- `mintNFT(metadata, collectionId?, edition?, totalEditions?, recipient?)`
- `batchMintNFT(items, collectionId?)`
- `_withCollectionGate()` concurrency control
- Salt derivation: Strategy A (random) + Strategy B (HMAC-SHA256)
- State-transition-sdk: MintTransactionData, MintCommitment, Token, UnmaskedPredicate, waitInclusionProof
- `@noble/hashes/hmac` for deterministic salt

### T2a-query: NFTModule — queries + transfer + events — M

**Files:** `modules/nft/NFTModule.ts` (continued), create `modules/nft/index.ts`
**Spec:** NFT-SPEC §5-9
**Dependencies:** T2a-mint

- `sendNFT(tokenId, recipient, memo?)` — delegates to `payments.send()` with `_nftTransfer`/`_tokenIds`
- `getNFT(tokenId)`, `getNFTs(options?)`, `getCollectionNFTs(collectionId)`, `getNFTHistory(tokenId)`
- `importNFT(token)`, `exportNFT(tokenId)`
- `verifyNFT(tokenId)`
- `_onIncomingTransfer()` — non-blocking event handler with `sdkData` null guard
- Barrel exports in `index.ts`

### T2c: AccountingModule — payInvoice NFT path — M

**Files:** `modules/accounting/AccountingModule.ts`
**Spec:** ACCT-NFT N2
**Dependencies:** T0a, T0b, T1c, T2g

Refactor guard at ~line 2330: `if (asset.coin) { ...coin... } else if (asset.nft) { ...NFT path per N2.2... } else { throw }`

NFT path: validate amount, already-sent check, locate NFT in wallet, build memo (`'F'` wire code), send with `_nftTransfer`/`_tokenIds` + `invoiceRefundAddress`/`invoiceContact` (same field pattern as coin path — no `_message` field).

### T2d: AccountingModule — NFT transfer attribution — M

**Files:** `modules/accounting/AccountingModule.ts`, `modules/accounting/types.ts`
**Spec:** ACCT-NFT N3, N6
**Dependencies:** T0b, T1c, **T2c** (serial — same file)

Insert NFT type check BEFORE `coinData.length === 0` guard (~line 4296). Add `_processNFTTransaction()`. Add `'nft_mismatch'` to `IrrelevantTransfer.reason`. Emit `invoice:nft_received`.

### T2e: AccountingModule — NFT coverage computation — M

**Files:** `modules/accounting/balance-computer.ts`
**Spec:** ACCT-NFT N4
**Dependencies:** **T2d** (serial chain)

Update `isCovered` (~line 275): include both coin AND NFT coverage. Update `anyPayment` (~line 546): add `nftAssets.some(na => na.received)`. Implement `buildNFTAssetStatus()`.

### T2f: AccountingModule — NFT auto-return + freeze — M

**Files:** `modules/accounting/AccountingModule.ts`, `modules/accounting/auto-return.ts`
**Spec:** ACCT-NFT N5, N7
**Dependencies:** **T2e** (serial chain: T2c → T2d → T2e → T2f)

NFT auto-return: sender-first priority, `_nftTransfer`/`_tokenIds`, dedup key `${invoiceId}:nft:${tokenId}`. Crash recovery for NFT dedup keys. Freeze `FrozenTargetBalances.nftAssets` with real data.

### T2g: Accounting — createInvoice NFT validation — S

**Files:** `modules/accounting/AccountingModule.ts`
**Spec:** ACCT-NFT N3.4
**Dependencies:** T0b

Verify and harden `createInvoice()` NFT target validation: cross-target duplicate tokenId prevention (already exists at ~line 906, verify scope is entire invoice not per-target).

---

## Wave 3: Integration (depends on Wave 2, 4 tasks parallel)

### T3a: Sphere.ts integration — M

**Files:** `core/Sphere.ts`
**Spec:** NFT-ARCH §10.1
**Dependencies:** T2a-query

- `private _nft: NFTModule | null = null`
- `get nft(): NFTModule` getter
- `init()`/`load()`: create via `createNFTModule()`, call `load()`
- `destroy()`: `_nft?.destroy()`
- `switchToAddress()`: destroy + recreate for new address
- `clear()`: verify storage.clear() covers `nft_collections` and `nft_mint_counter_*`

### T3b: Connect Protocol + Security — M

**Files:** `connect/protocol.ts`, `connect/permissions.ts`, `connect/host/ConnectHost.ts`
**Spec:** NFT-ARCH §10.2, ACCT-NFT Security S2
**Dependencies:** T2a-query

**protocol.ts:** Add RPC methods (`sphere_getNFTs`, `sphere_getNFT`, `sphere_getCollections`, `sphere_getCollectionNFTs`) and intent actions (`nft_send`, `nft_mint`).

**permissions.ts:** Add scopes `nft:read`, `intent:nft_send`, `intent:nft_mint`. Add method→permission and intent→permission mappings.

**ConnectHost.ts:**
- Add handler cases for NFT RPC methods (delegate to `sphere.nft.*`)
- **SECURITY-CRITICAL:** Strip `_nftTransfer` and `_tokenIds` from all Connect Protocol intent params before passing to `PaymentsModule.send()`

### T3c: Main index exports — S

**Files:** `index.ts`
**Spec:** —
**Dependencies:** T2a-query

Re-export NFT module types and factory.

### T3d: CLAUDE.md update — S

**Files:** `CLAUDE.md`
**Spec:** —
**Dependencies:** T2a-query

Add NFT module API, events, types to SDK documentation for AI assistant context.

---

## Dependency Graph

```
Wave 0:  T0a ─────┐   T0b ──┐   T0c ──┐
                   │         │         │
Wave 1:  T1c ──────┤   T1a ──┼── T1e ──┤
                   │    │    │         │
                   │   T1b   T1d       │
                   │    │    │         │
Wave 2:            │  T2a-mint ──┐     │   T2g (parallel)
                   │    │        │     │    │
                   │  T2a-query  │     │   T2c ──── (serial chain on AccountingModule.ts)
                   │             │     │    │
                   │             │     │   T2d
                   │             │     │    │
                   │             │     │   T2e
                   │             │     │    │
                   │             │     │   T2f
                   │             │     │
Wave 3:           T3a    T3b   T3c   T3d
```

## Critical Paths (two parallel)

**NFT module path:** `T0a → T1a → T1b → T2a-mint → T2a-query → T3a` (6 tasks)

**Accounting path:** `T0a → T1c → T2g → T2c → T2d → T2e → T2f` (7 tasks, serial chain)

The accounting path is now the true critical path (7 tasks serial due to AccountingModule.ts file contention). The NFT module path runs concurrently and finishes earlier.

## Parallelism Summary

| Wave | Tasks | Parallel structure |
|------|-------|--------------------|
| 0 | T0a, T0b, T0c | All 3 parallel |
| 1 | T1a, T1b, T1c, T1d, T1e | T1a+T1c parallel; then T1b+T1d+T1e parallel |
| 2 | T2a-mint, T2a-query, T2g, T2c, T2d, T2e, T2f | **Two parallel lanes:** NFT lane (T2a-mint → T2a-query) and Accounting lane (T2g → T2c → T2d → T2e → T2f serial) |
| 3 | T3a, T3b, T3c, T3d | All 4 parallel |

---

## Spec Section Coverage Matrix

| Spec Section | Task(s) |
|-------------|---------|
| NFT-SPEC Prerequisites 1-3 | T0a |
| NFT-SPEC §1 Constants | T0b, T0c (pre-verified: NFT_TOKEN_TYPE_HEX) |
| NFT-SPEC §2 Serialization | T1b |
| NFT-SPEC §3 Collections | T2a-mint, T1e |
| NFT-SPEC §4 Minting | T2a-mint |
| NFT-SPEC §5 Transfer | T2a-query |
| NFT-SPEC §6 Queries | T2a-query |
| NFT-SPEC §7 Import/Export | T2a-query |
| NFT-SPEC §8 Verification | T2a-query |
| NFT-SPEC §9 Events | T1c, T2a-query |
| NFT-SPEC §10 Storage | T0c, T1e |
| NFT-SPEC §11 Errors | T0b |
| NFT-SPEC §12 Lifecycle | T2a-mint |
| NFT-SPEC §13 Concurrency | T2a-mint |
| NFT-SPEC §14 Integration | T0a, T3a, T3b |
| ACCT-NFT N1 Overview | (design context) |
| ACCT-NFT N2 payInvoice | T2c |
| ACCT-NFT N3 Attribution | T2d |
| ACCT-NFT N4 Coverage | T2e |
| ACCT-NFT N5 Auto-return | T2f |
| ACCT-NFT N6 Classification | T2d |
| ACCT-NFT N7 Frozen balances | T2f |
| ACCT-NFT N8 Events | T1c |
| ACCT-NFT N9 Error codes | T0b |
| ACCT-NFT N10 Test cases | (test phase — separate) |
| ACCT-NFT Security S1-S5 | T2f (S1), T3b (S2), (S3-S5 informational) |
| NFT-ARCH §10.1 Sphere integration | T3a |
| NFT-ARCH §10.2 Connect Protocol | T3b |
| NFT-ARCH §10.3 Token Registry | Out of scope V1 |
