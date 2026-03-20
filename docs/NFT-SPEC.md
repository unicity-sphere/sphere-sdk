# NFT Module Specification

> **Status:** Draft specification — no code yet
> **Module path:** `modules/nft/NFTModule.ts`
> **Architecture:** [NFT-ARCHITECTURE.md](NFT-ARCHITECTURE.md)
> **Standards research:** [NFT-STANDARDS-RESEARCH.md](NFT-STANDARDS-RESEARCH.md)

---

## Table of Contents

1. [Constants](#1-constants)
2. [Canonical Serialization](#2-canonical-serialization)
3. [Collection Management](#3-collection-management)
4. [Minting](#4-minting)
5. [Transfer](#5-transfer)
6. [Queries](#6-queries)
7. [Import / Export](#7-import--export)
8. [Verification](#8-verification)
9. [Event Processing](#9-event-processing)
10. [Storage Schema](#10-storage-schema)
11. [Error Handling](#11-error-handling)
12. [Module Lifecycle](#12-module-lifecycle)
13. [Concurrency](#13-concurrency)
14. [Integration Points](#14-integration-points)

---

## Prerequisites (must be implemented before NFTModule)

The following changes to existing modules are required before the NFT module can function:

1. **PaymentsModule.send() — `_nftTransfer` flag:** Add optional `_nftTransfer?: boolean` to `TransferRequest`. When `true`, PaymentsModule MUST skip token splitting logic (NFTs are atomic and cannot be split).
2. **PaymentsModule.send() — `_tokenIds` flag:** Add optional `_tokenIds?: string[]` to `TransferRequest`. When set, PaymentsModule MUST use only the specified tokens (by token ID) instead of selecting by coinId/amount. This is the primary token selection mechanism for NFT transfers.
3. **TxfGenesisData.coinData — nullable or empty array:** Verify that the minting flow and `txfToToken()` handle `coinData: []` (empty array) without crashing. Currently `txfToToken()` calls `coinData.reduce()` — this works with `[]` but would crash with `null`.

---

## 1. Constants

### 1.1 Token Type

```typescript
// constants.ts — add alongside INVOICE_TOKEN_TYPE_HEX
export const NFT_TOKEN_TYPE_HEX = '8b0136c928f34e13ba73274a71bc3e96cd7f6799e876d89842ed4a541d0b963c' as const;
// = SHA-256(UTF-8("unicity.nft.v1"))
```

Derivation:
```
input  = UTF-8 encode "unicity.nft.v1"
output = SHA-256(input) → 64-char lowercase hex string
```

### 1.2 Storage Keys

```typescript
// constants.ts — add to STORAGE_KEYS_ADDRESS
NFT_COLLECTIONS: 'nft_collections',       // Collection definitions registry
NFT_MINT_COUNTER: 'nft_mint_counter',      // Per-collection edition counters
```

Final storage key format: `sphere_{addressId}_{key}` where `addressId` is the DIRECT address ID (e.g., `DIRECT_abc123_xyz789`).

### 1.3 Limits

| Constant | Value | Rationale |
|----------|-------|-----------|
| `NFT_MAX_NAME_LENGTH` | 256 | Reasonable display name limit |
| `NFT_MAX_DESCRIPTION_LENGTH` | 4096 | Markdown description |
| `NFT_MAX_ATTRIBUTES` | 100 | Trait attributes per NFT |
| `NFT_MAX_IMAGE_URI_LENGTH` | 2048 | URI length limit |
| `NFT_MAX_BATCH_SIZE` | 50 | Parallel mint limit |
| `NFT_MAX_COLLECTION_NAME_LENGTH` | 128 | Collection name limit |
| `COLLECTION_MAX_SUPPLY_LIMIT` | 1_000_000 | Upper bound for maxSupply |

---

## 2. Canonical Serialization

### 2.1 NFTTokenData Serialization

The `NFTTokenData` object is serialized to a deterministic JSON string for use as `genesis.data.tokenData`. This string is part of the SHA-256 input for token ID derivation — any change breaks token identity.

**Serialization Rules:**

1. **Key ordering:** Strict alphabetical at every nesting level.
2. **Null normalization:** Optional fields absent from the input are serialized as `null`. `collectionId` is `null` for standalone NFTs. `edition` and `totalEditions` are `0` for standalone NFTs (not `null`).
3. **Attribute sorting:** `metadata.attributes` sorted by `trait_type` (ascending, lexicographic).
4. **Compact JSON:** No whitespace, no pretty-printing.
5. **String encoding:** UTF-8.

**Top-level key order:**
```
collectionId, edition, metadata, mintedAt, minter, totalEditions
```

**metadata key order:**
```
animationUrl, attributes, backgroundColor, content, description, externalUrl, image, name, properties
```

**attribute key order (per element):**
```
display_type, max_value, trait_type, value
```

**content key order:**
```
full, original, preview, thumbnail
```

**Example (collection NFT):**
```json
{"collectionId":"a1b2...","edition":1,"metadata":{"animationUrl":null,"attributes":[{"display_type":null,"max_value":null,"trait_type":"Color","value":"Blue"}],"backgroundColor":null,"content":null,"description":"A blue sphere","externalUrl":null,"image":"ipfs://QmHash","name":"Blue Sphere #1","properties":null},"mintedAt":1700000000000,"minter":null,"totalEditions":100}
```

**Example (standalone NFT):**
```json
{"collectionId":null,"edition":0,"metadata":{"animationUrl":null,"attributes":null,"backgroundColor":null,"content":null,"description":"One-of-a-kind artwork","externalUrl":null,"image":"ipfs://QmUniqueHash","name":"My Art","properties":null},"mintedAt":1700000000000,"minter":null,"totalEditions":0}
```

### 2.2 CollectionDefinition Serialization

**Key order:**
```
createdAt, creator, description, deterministicMinting, externalUrl, image, maxSupply, name, royalty, transferable
```

**royalty key order (if present):**
```
basisPoints, recipient
```

**Null normalization:**
- `deterministicMinting`: false if absent (default)
- `externalUrl`: null if absent
- `image`: null if absent
- `maxSupply`: null if absent (= unlimited)
- `royalty`: null if absent
- `transferable`: true if absent (default)

### 2.3 Deterministic ID Derivation

```
collectionId = hex(SHA-256(UTF-8(canonicalSerializeCollection(definition))))
tokenId      = hex(SHA-256(tokenDataBytes + salt))
               // TokenId is derived by the caller (NOT by state-transition-sdk internally).
               // MintTransactionData.create() takes tokenId as its first argument.
               // Including salt in the hash guarantees uniqueness even for identical metadata.
```

The `collectionId` is computed client-side before any on-chain interaction. It is stable — the same `CollectionDefinition` always produces the same `collectionId`.

The `tokenId` includes the salt in its derivation input. This ensures:
- Two standalone NFTs with identical metadata but different random salts get different tokenIds.
- Deterministic minting (same salt for same edition) produces the same tokenId for crash recovery.

### 2.4 Salt Derivation Strategy

The `salt` used in `MintTransactionData` determines the `tokenId`. Two strategies are supported:

#### Strategy A: Random Salt (default)

```
salt = crypto.getRandomValues(new Uint8Array(32))
```

Produces a fully random, unpredictable `tokenId`. Suitable for one-off NFTs, art drops, or collections where any authorized wallet can mint independently. The resulting `tokenId` cannot be predicted by anyone before minting.

#### Strategy B: Deterministic Salt (controlled collections)

```
salt = HMAC-SHA256(privateKey, collectionId || editionCounter)
```

Where:
- `privateKey` is the emitter's secp256k1 private key (32 bytes)
- `collectionId` is the 64-char hex collection ID (32 bytes)
- `editionCounter` is the edition number encoded as a big-endian uint64 (8 bytes)

This produces a deterministic `tokenId` that is:

1. **Predictable only by the emitter** — only the holder of the private key can compute valid salts and therefore valid tokenIds for a given collection + edition.
2. **Unpredictable to everyone else** — without the private key, an observer cannot compute the next `tokenId` even if they know the counter and collectionId. HMAC-SHA256 is a PRF (pseudo-random function) — its outputs are indistinguishable from random without the key.
3. **Idempotent** — re-minting the same edition produces the same `tokenId` and commitment. The aggregator returns `REQUEST_ID_EXISTS` (same pattern as nametag recovery).

**Use cases for deterministic salt:**
- **Collection integrity:** Only the genuine collection manager/emitter can mint NFTs with valid tokenIds. Third parties cannot pre-mint or front-run editions.
- **Verifiable sequence:** Given the emitter's public key and the collection definition, anyone can verify that a claimed NFT belongs to the collection by checking the inclusion proof — but no one can predict the next tokenId without the private key.
- **Crash recovery:** The same wallet can re-derive the salt for a previously minted edition and recover the token from the aggregator (via `REQUEST_ID_EXISTS`).

**Selection:** The strategy is chosen at `createCollection()` time via the `deterministicMinting` flag in `CollectionDefinition`. When `true`, `mintNFT()` uses Strategy B. When `false` or omitted, `mintNFT()` uses Strategy A.

---

## 3. Collection Management

### 3.1 createCollection(request)

**Input:** `CreateCollectionRequest`

| Field | Type | Required | Default | Validation |
|-------|------|----------|---------|------------|
| `name` | string | Yes | — | 1-128 chars, non-empty after trim |
| `description` | string | Yes | — | 1-4096 chars |
| `maxSupply` | number \| null | No | null | If set: integer, 1 ≤ n ≤ 1,000,000 |
| `image` | string | No | — | Valid URI (ipfs://, https://, data:), ≤ 2048 chars |
| `externalUrl` | string | No | — | Valid URL, ≤ 2048 chars |
| `royalty` | RoyaltyConfig | No | — | See §3.1.1 |
| `transferable` | boolean | No | true | — |
| `deterministicMinting` | boolean | No | false | When true, salt = HMAC-SHA256(privateKey, collectionId \|\| edition) — only emitter can mint valid tokenIds |

**3.1.1 RoyaltyConfig Validation:**

| Field | Type | Validation |
|-------|------|------------|
| `recipient` | string | Valid DIRECT:// address or chain pubkey |
| `basisPoints` | number | Integer, 0 ≤ n ≤ 10000 (0-100%) |

**Algorithm:**

```
1. Validate all input fields
2. Construct CollectionDefinition:
   - creator = identity.chainPubkey
   - createdAt = Date.now()
   - All optional fields normalized
3. collectionId = SHA-256(canonicalSerializeCollection(definition))
4. Check: if collectionId already exists in storage → return existing (idempotent)
5. Store definition in NFT_COLLECTIONS registry
6. Emit nft:collection_created event
7. Return { collectionId, definition }
```

**Output:** `CreateCollectionResult { collectionId: string, definition: CollectionDefinition }`

**Errors:**

| Condition | Error Code |
|-----------|------------|
| Empty name | `NFT_INVALID_METADATA` |
| Name too long | `NFT_INVALID_METADATA` |
| maxSupply < 1 or > 1,000,000 | `NFT_INVALID_METADATA` |
| Invalid royalty basisPoints | `NFT_INVALID_METADATA` |
| Invalid image URI | `NFT_INVALID_METADATA` |

### 3.2 getCollection(collectionId)

**Input:** `collectionId: string` (64-char hex)

**Algorithm:**

```
1. Look up collectionId in in-memory collection index
2. If found → return CollectionRef
3. If not found → return null
```

**Output:** `CollectionRef | null`

### 3.3 getCollections(options?)

**Input:** `GetCollectionsOptions` (optional)

| Field | Type | Default |
|-------|------|---------|
| `createdByMe` | boolean | false |
| `sortBy` | 'name' \| 'tokenCount' \| 'creator' | 'name' |
| `sortOrder` | 'asc' \| 'desc' | 'asc' |

**Algorithm:**

```
1. Start with all entries in in-memory collection index
2. If createdByMe → filter where creator === identity.chainPubkey
3. Sort by specified field and direction
4. Return CollectionRef[]
```

**Output:** `CollectionRef[]`

---

## 4. Minting

### 4.1 mintNFT(metadata, collectionId?, edition?, totalEditions?, recipient?)

**Signature:** `mintNFT(metadata: NFTMetadata, collectionId?: string, edition?: number, totalEditions?: number, recipient?: string): Promise<MintNFTResult>`

| Parameter | Type | Required | Default | Validation |
|-----------|------|----------|---------|------------|
| `metadata` | NFTMetadata | Yes | — | See §4.1.1 |
| `collectionId` | string | No | null | If set: 64-char hex, collection must exist locally |
| `edition` | number | No | 0 | If collectionId set: auto-increment or explicit. If no collection: 0 |
| `totalEditions` | number | No | 0 | Integer ≥ 0 |
| `recipient` | string | No | self | Valid recipient identifier |

When `collectionId` is omitted (standalone NFT):
- The NFT is not linked to any collection
- `edition` and `totalEditions` default to 0
- Salt is always random (Strategy A) — no deterministic minting without a collection
- No maxSupply check, no edition auto-increment, no collection-level transferability check

**4.1.1 NFTMetadata Validation:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | string | Yes | 1-256 chars, non-empty after trim |
| `description` | string | No | ≤ 4096 chars |
| `image` | string | Yes | Valid URI (ipfs://, https://, data:), ≤ 2048 chars |
| `animationUrl` | string | No | Valid URI, ≤ 2048 chars |
| `externalUrl` | string | No | Valid URL, ≤ 2048 chars |
| `backgroundColor` | string | No | 6-char hex (no # prefix) |
| `attributes` | NFTAttribute[] | No | ≤ 100 elements, each with trait_type and value |
| `properties` | object | No | JSON-serializable |
| `content` | NFTContent | No | All fields valid URIs |

**Algorithm:**

```
 1. Validate metadata fields (see §4.1.1)
 2. Resolve collection (if collectionId provided):
    IF collectionId is set:
      collection = lookup collectionId → CollectionDefinition
      - Error NFT_COLLECTION_NOT_FOUND if not registered locally
    ELSE:
      collection = null  // standalone NFT
 3. Check maxSupply (collection-only):
    IF collection AND collection.maxSupply is set:
      - Read mint counter for this collection
      - If counter >= maxSupply → error NFT_MAX_SUPPLY_EXCEEDED
 4. Determine edition number:
    IF collection:
      - If edition param is set → use it
      - Else → auto-increment from mint counter
    ELSE:
      - edition = 0  // standalone NFTs have no edition
 5. Resolve recipient:
    - If recipient param → transport.resolve(recipient) → DirectAddress
    - Else → self (identity.directAddress)
 6. Construct NFTTokenData:
    {
      collectionId: collectionId ?? null,   // null for standalone NFTs
      metadata: metadata,
      edition: resolvedEdition,             // 0 for standalone
      totalEditions: totalEditions ?? 0,    // 0 for standalone
      minter: identity.chainPubkey,
      mintedAt: Date.now()
    }
 7. tokenData = canonicalSerializeNFT(nftTokenData)
    tokenDataBytes = UTF-8 encode tokenData
 8. Generate salt:
    IF collection AND collection.deterministicMinting:
      // Strategy B: deterministic — only the emitter can compute valid tokenIds
      salt = HMAC-SHA256(identity.privateKey, collectionId || uint64BE(edition))
    ELSE:
      // Strategy A: random — used for standalone NFTs and non-deterministic collections
      salt = crypto.getRandomValues(new Uint8Array(32))
 8a. Persist mint intent for crash recovery (write-ahead):
    // Ensures re-mint after crash uses identical mintedAt/salt/tokenData.
    // Without this, Date.now() on retry produces different tokenData → different tokenId.
    await storage.set(`nft_mint_intent_${collectionId ?? 'standalone'}_${edition}`,
      JSON.stringify({ collectionId, edition, mintedAt, salt: hex(salt), tokenData }))
 9. Import state-transition-sdk types:
    - MintTransactionData, MintCommitment, Token, TokenType, TokenId,
      DataHasher, HashAlgorithm, UnmaskedPredicate, TokenState, SigningService
10. Derive TokenId from SHA-256(tokenDataBytes + salt):
    // Include salt in hash to guarantee uniqueness even for identical metadata
    hash = DataHasher(SHA256).update(tokenDataBytes).update(salt).digest()
    nftTokenId = new TokenId(hash.imprint)
11. Create MintTransactionData (8 arguments — matches actual SDK signature):
    tokenType = new TokenType(Buffer.from(NFT_TOKEN_TYPE_HEX, 'hex'))
    mintData = await MintTransactionData.create(
      nftTokenId,         // tokenId: TokenId
      tokenType,          // tokenType: TokenType
      tokenDataBytes,     // tokenData: Uint8Array (NOT string)
      null,               // coinData: null (NOT [] — SDK expects TokenCoinData | null)
      recipientAddress,   // recipient: IAddress (DirectAddress)
      salt,               // salt: Uint8Array
      null,               // recipientDataHash: null
      null,               // reason: null
    )
12. commitment = await MintCommitment.create(mintData)
13. Submit to oracle:
    response = await oracleProvider.submitMintCommitment(commitment)
    - Handle SUCCESS → continue
    - Handle REQUEST_ID_EXISTS → idempotent, continue
    - Handle failure → error NFT_MINT_FAILED
14. Wait for inclusion proof:
    inclusionProof = await waitInclusionProof(trustBase, client, commitment)
15. Create predicate:
    predicate = await UnmaskedPredicate.create(
      nftTokenId, tokenType, signingService, HashAlgorithm.SHA256, salt
    )
16. Construct token:
    tokenState = new TokenState(predicate, null)
    genesisTransaction = commitment.toTransaction(inclusionProof)
    token = await Token.mint(trustBase, tokenState, genesisTransaction)
17. Store token:
    txfToken = normalizeSdkTokenToStorage(token.toJSON())
    await tokenStorage.put(addressId, `_${nftTokenId.toJSON()}`, txfToken)
18. Delete mint intent (crash recovery cleanup):
    await storage.delete(`nft_mint_intent_${collectionId ?? 'standalone'}_${edition}`)
19. Update mint counter (collection-only): IF collection → counter + 1
20. Update in-memory index: add NFTRef
21. Emit nft:minted { tokenId, collectionId: collectionId ?? null, name: metadata.name, confirmed: true }
22. Return MintNFTResult { tokenId, collectionId: collectionId ?? null, confirmed: true, nft: nftRef }
```

**Errors:**

| Condition | Error Code |
|-----------|------------|
| Collection not found | `NFT_COLLECTION_NOT_FOUND` |
| Max supply exceeded | `NFT_MAX_SUPPLY_EXCEEDED` |
| Invalid metadata | `NFT_INVALID_METADATA` |
| Oracle rejection | `NFT_MINT_FAILED` |
| Recipient not found | Standard transport resolution error |

### 4.2 batchMintNFT(items, collectionId?)

**Signature:** `batchMintNFT(items: Array<{ metadata: NFTMetadata; edition?: number; recipient?: string }>, collectionId?: string): Promise<BatchMintNFTResult>`

| Parameter | Type | Required | Validation |
|-----------|------|----------|------------|
| `items` | Array<{metadata, edition?, recipient?}> | Yes | 1-50 items |
| `collectionId` | string | No | If set: 64-char hex, collection must exist. If omitted: standalone NFTs. |

**Algorithm:**

```
1. IF collectionId → validate collection exists
2. Validate items.length ≤ NFT_MAX_BATCH_SIZE
3. IF collection AND collection.maxSupply → pre-check: currentCount + items.length ≤ maxSupply
4. IF collection:
     Reserve edition range atomically inside the collection gate:
     - editions = [nextEdition, nextEdition+1, ..., nextEdition+items.length-1]
     - Update mint counter to nextEdition + items.length
   ELSE:
     All editions default to 0 (standalone NFTs)
5. For each item in items (oracle submissions parallelized):
   a. Call internal _mintSingleNFT() with pre-assigned edition (or 0 for standalone)
   b. Collect result or error
6. Aggregate results:
   - results: MintNFTResult[] (successful mints)
   - errors: Array<{ index, error }> (failed mints)
7. Return { results, successCount, failureCount, errors }
```

**Parallelization:** Edition numbers are reserved atomically inside the per-collection gate (step 4). After reservation, oracle commitments for individual NFTs can be submitted in parallel since each has its own salt, token ID, and pre-assigned edition. Items within the same collection are NOT individually serialized through the gate — only the edition reservation step is.

**Partial failure:** Batch mint does NOT roll back on partial failure. Successfully minted NFTs remain minted. Failed items are reported in `errors`.

---

## 5. Transfer

### 5.1 sendNFT(tokenId, recipient, memo?)

**Signature:** `sendNFT(tokenId: string, recipient: string, memo?: string): Promise<TransferResult>`

Follows the same pattern as `PaymentsModule.send()` — simple positional arguments, no wrapper type.

| Parameter | Type | Required | Validation |
|-----------|------|----------|------------|
| `tokenId` | string | Yes | 64-char hex, must exist in wallet, must be NFT type |
| `recipient` | string | Yes | Valid recipient (@nametag, DIRECT://, pubkey, alpha1...) |
| `memo` | string | No | ≤ 256 chars |

**Algorithm:**

```
1. Look up tokenId in in-memory NFT index
   - Error NFT_NOT_FOUND if not present
2. Get full token data from TokenStorage
3. Verify tokenType === NFT_TOKEN_TYPE_HEX
   - Error NFT_WRONG_TOKEN_TYPE if not
4. Parse NFTTokenData from genesis.data.tokenData
5. Look up collection:
   - If collection.transferable === false → error NFT_NOT_TRANSFERABLE
6. Delegate to PaymentsModule:
   result = await payments.send({
     recipient,
     amount: "1",
     coinId: tokenId,    // fallback identifier only
     memo,
     // PREREQUISITE: these flags must be added to TransferRequest (see Prerequisites)
     _nftTransfer: true,  // skip token splitting (NFTs are atomic)
     _tokenIds: [tokenId] // PRIMARY token selection — selects by token ID, not coinId
   })
7. On success:
   - Remove from in-memory NFT index
   - Emit nft:transferred { tokenId, collectionId, recipientPubkey, recipientNametag }
8. Return TransferResult (from PaymentsModule)
```

**NFT Atomicity:** NFTs cannot be split. The `_nftTransfer` flag tells PaymentsModule to:
- Skip token splitting logic
- Use the exact token specified by `_tokenIds`
- Transfer the complete token as-is

**Errors:**

| Condition | Error Code |
|-----------|------------|
| Token not found | `NFT_NOT_FOUND` |
| Wrong token type | `NFT_WRONG_TOKEN_TYPE` |
| Non-transferable collection | `NFT_NOT_TRANSFERABLE` |
| Transfer failure | Standard PaymentsModule errors |

---

## 6. Queries

### 6.1 getNFT(tokenId)

**Input:** `tokenId: string` (64-char hex)

**Algorithm:**

```
1. Look up tokenId in in-memory NFT index
2. If not found → return null
3. Get full token from PaymentsModule.getTokens({ tokenIds: [tokenId] })
4. Parse NFTTokenData from genesis.data.tokenData
5. Look up collection definition
6. Construct NFTDetail:
   - All NFTRef fields
   - Full metadata from NFTTokenData
   - Collection definition (if available)
   - Full Token object
7. Return NFTDetail
```

### 6.2 getNFTs(options?)

**Input:** `GetNFTsOptions` (optional)

**Algorithm:**

```
1. Start with all entries in in-memory NFT index
2. Apply filters:
   - collectionId → filter by collectionId match
   - status → filter by TokenStatus match
3. Apply sorting:
   - sortBy + sortOrder → sort the filtered array
4. Apply pagination:
   - offset → skip first N entries
   - limit → take next M entries
5. Return NFTRef[]
```

**Performance:** All operations are on in-memory index. No storage reads required.

### 6.3 getCollectionNFTs(collectionId)

Equivalent to `getNFTs({ collectionId })` without other filters.

### 6.4 getNFTHistory(tokenId)

**Input:** `tokenId: string`

**Returns:** `Promise<NFTHistoryEntry[]>`

**Algorithm:**

```
1. Get token from TokenStorage (async)
2. If not found or not NFT → return []
3. Parse TXF transactions array
4. For each transaction:
   - Determine type: mint (first), transfer_in/transfer_out (subsequent)
   - Extract counterparty from predicate/state data
   - Extract timestamp from inclusion proof
5. Return NFTHistoryEntry[] ordered by timestamp ascending
```

---

## 7. Import / Export

### 7.1 importNFT(token)

**Input:** `token: TxfToken`

**Algorithm:**

```
1. Validate token.genesis.data.tokenType === NFT_TOKEN_TYPE_HEX
   - Error NFT_WRONG_TOKEN_TYPE if not
2. Parse NFTTokenData from token.genesis.data.tokenData
   - Error NFT_PARSE_ERROR if parsing fails
3. Extract collectionId from parsed data
4. If collectionId not in local collection registry:
   - Create synthetic CollectionRef from available metadata
   - Store in collection registry (best-effort, may be incomplete)
5. Check for duplicate: if tokenId already in index
   - If same token → idempotent, return existing NFTRef
   - Error NFT_ALREADY_EXISTS if different token with same ID (should never happen)
6. Store token in TokenStorage
7. Add to in-memory NFT index
8. Emit nft:imported { tokenId, collectionId, name }
9. Return NFTRef
```

### 7.2 exportNFT(tokenId)

**Input:** `tokenId: string`

**Algorithm:**

```
1. Get token from TokenStorage
2. If not found → return null
3. Verify tokenType === NFT_TOKEN_TYPE_HEX
4. Return TxfToken as-is (complete TXF format)
```

---

## 8. Verification

### 8.1 verifyNFT(tokenId)

**Input:** `tokenId: string`

**Algorithm:**

```
1. Get token from TokenStorage
2. If not found → error NFT_NOT_FOUND
3. Verify tokenType === NFT_TOKEN_TYPE_HEX
4. Delegate to oracle validation:
   result = await oracleProvider.validateToken(tokenData)
5. Check inclusion proof locally:
   - Verify merkle tree path
   - Verify authenticator signature
   - Verify state hash chain
6. Return NFTVerificationResult {
     valid: result.valid && localVerification.passed,
     spent: result.spent,
     stateHash: result.stateHash,
     errors: [...collected errors]
   }
7. Emit nft:verified { tokenId, valid, spent }
```

---

## 9. Event Processing

### 9.1 Inbound Transfer Handler

The NFT module subscribes to `transfer:incoming` events from PaymentsModule:

```typescript
private _onIncomingTransfer(transfer: IncomingTransfer): void {
  try {
    for (const token of transfer.tokens) {
      if (!token.sdkData) continue;
      const txf = JSON.parse(token.sdkData);
      if (txf.genesis?.data?.tokenType !== NFT_TOKEN_TYPE_HEX) continue;

      const nftData = this._parseNFTTokenData(txf.genesis.data.tokenData);
      if (!nftData) {
        this.logger?.warn(`Failed to parse NFT data for token ${token.id}`);
        continue;
      }

      // Register collection if unknown
      this._ensureCollectionRegistered(nftData.collectionId, nftData);

      // Add to index
      const nftRef = this._buildNFTRef(token, nftData);
      this._nftIndex.set(token.id, nftRef);

      // Emit event
      this._emitEvent('nft:received', {
        tokenId: token.id,
        collectionId: nftData.collectionId,
        name: nftData.metadata.name,
        senderPubkey: transfer.senderPubkey,
        senderNametag: transfer.senderNametag,
      });
    }
  } catch (err) {
    // NEVER block transfer processing — log and continue
    this.logger?.error('NFT inbound processing error:', err);
  }
}
```

### 9.2 Event Types (New SphereEventType Entries)

```typescript
// types/index.ts — add to SphereEventType union
| 'nft:minted'
| 'nft:received'
| 'nft:transferred'
| 'nft:verified'
| 'nft:collection_created'
| 'nft:imported'
```

### 9.3 Event Payloads

```typescript
// types/index.ts — add to SphereEventMap
'nft:minted': {
  tokenId: string;
  collectionId: string | null;  // null for standalone NFTs
  name: string;
  confirmed: boolean;
};
'nft:received': {
  tokenId: string;
  collectionId: string | null;
  name: string;
  senderPubkey: string;
  senderNametag?: string;
};
'nft:transferred': {
  tokenId: string;
  collectionId: string | null;
  recipientPubkey: string;
  recipientNametag?: string;
};
'nft:verified': {
  tokenId: string;
  valid: boolean;
  spent: boolean;
};
'nft:collection_created': {
  collectionId: string;
  name: string;
};
'nft:imported': {
  tokenId: string;
  collectionId: string | null;
  name: string;
};
```

---

## 10. Storage Schema

### 10.1 Collection Registry

**Key:** `sphere_{addressId}_nft_collections`

**Value:** JSON string of:

```typescript
interface NFTCollectionsStorage {
  /** Version for future migration */
  version: 1;
  /** Map of collectionId → CollectionDefinition */
  collections: Record<string, CollectionDefinition>;
}
```

### 10.2 Mint Counter

**Key:** `sphere_{addressId}_nft_mint_counter_{collectionId}`

**Value:** JSON string of number (next edition number).

Initial value: `1` (editions are 1-based).

### 10.3 Token Storage

NFT tokens are stored in `TokenStorageProvider` as `TxfToken` objects, identical to all other token types. The NFT module discovers them by filtering `genesis.data.tokenType === NFT_TOKEN_TYPE_HEX`.

```
TokenStorage (per-address)
  _${tokenId} → TxfToken {
    version: "2.0",
    genesis: {
      data: {
        tokenId: "abc123...",
        tokenType: NFT_TOKEN_TYPE_HEX,   ← identifies as NFT
        coinData: [],                     ← empty (non-fungible)
        tokenData: "{...}",              ← serialized NFTTokenData
        salt: "def456...",
        recipient: "DIRECT://...",
        recipientDataHash: null,
        reason: null
      },
      inclusionProof: { ... }
    },
    state: { data: "...", predicate: "..." },
    transactions: [...]
  }
```

---

## 11. Error Handling

### 11.1 Error Code Table

| Code | HTTP-like | Description | Recovery |
|------|-----------|-------------|----------|
| `NFT_COLLECTION_NOT_FOUND` | 404 | Collection ID not in local registry | Create collection first |
| `NFT_NOT_FOUND` | 404 | Token ID not found or not NFT type | Check token ID |
| `NFT_MAX_SUPPLY_EXCEEDED` | 409 | Mint would exceed collection maxSupply | Cannot mint more |
| `NFT_NOT_TRANSFERABLE` | 403 | Collection is soulbound | Cannot transfer |
| `NFT_INVALID_METADATA` | 400 | Missing/invalid required metadata fields | Fix metadata |
| `NFT_MINT_FAILED` | 502 | Oracle/aggregator rejected commitment | Retry or check network |
| `NFT_PARSE_ERROR` | 422 | Failed to parse NFTTokenData | Token data corrupted |
| `NFT_ALREADY_EXISTS` | 409 | Token ID collision (shouldn't happen) | Use existing token |
| `NFT_WRONG_TOKEN_TYPE` | 422 | Token type is not NFT_TOKEN_TYPE_HEX | Wrong token provided |

### 11.2 Error Propagation

All errors use `SphereError` (existing error class):

```typescript
throw new SphereError('NFT_COLLECTION_NOT_FOUND', `Collection ${collectionId} not registered`);
```

### 11.3 Non-Blocking Inbound Rule

**CRITICAL:** Errors during inbound NFT processing (event handler `_onIncomingTransfer`) MUST:
1. Be caught and logged
2. NEVER throw or propagate
3. NEVER block the underlying token transfer
4. NEVER prevent other NFTs in the same transfer batch from being processed

This matches the accounting module's pattern: "NFT-related errors during inbound transfer processing MUST NEVER break the token transfer flow."

---

## 12. Module Lifecycle

### 12.1 Constructor

```typescript
constructor(config: NFTModuleConfig)

interface NFTModuleConfig {
  payments: PaymentsModule;
  storage: StorageProvider;
  tokenStorage: TokenStorageProvider;
  oracle: OracleProvider;
  identity: FullIdentity;
  addressId: string;
  addressIndex: number;
  communications?: CommunicationsModule;
  emitEvent: (type: SphereEventType, payload: unknown) => void;
  logger?: Logger;
}
```

### 12.2 load()

Called by `Sphere.init()` / `Sphere.load()` after PaymentsModule is loaded.

```
1. Load collection definitions from StorageProvider
2. Build collection index (Map<collectionId, CollectionRef>)
3. Enumerate all tokens via PaymentsModule.getTokens()
4. Filter by tokenType === NFT_TOKEN_TYPE_HEX
5. Parse NFTTokenData from each token's genesis.data.tokenData
6. Build NFT index (Map<tokenId, NFTRef>)
7. Update collection token counts
8. Subscribe to transfer events:
   - payments.on('transfer:incoming', this._onIncomingTransfer)
   - payments.on('transfer:confirmed', this._onTransferConfirmed)
```

### 12.3 destroy()

```
1. Unsubscribe from all event listeners
2. Clear in-memory indexes
3. No storage cleanup needed (tokens persist)
```

### 12.4 Address Switch

When `Sphere.switchToAddress(index)` is called:

```
1. destroy() current NFTModule
2. Create new NFTModule with new addressId/addressIndex
3. load() for new address
```

---

## 13. Concurrency

### 13.1 Mint Serialization

Multiple concurrent `mintNFT()` calls for the same collection MUST be serialized to prevent edition number conflicts and maxSupply races.

Implementation: per-collection promise chain (same pattern as accounting module's `withInvoiceGate`).

```typescript
private _collectionGates = new Map<string, Promise<unknown>>();

private async _withCollectionGate<T>(collectionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = this._collectionGates.get(collectionId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // Always chain, even on failure
  this._collectionGates.set(collectionId, next);
  return next;
}
```

### 13.2 Index Consistency

In-memory indexes (`_nftIndex`, `_collectionIndex`) are updated synchronously after each storage write. Since JavaScript is single-threaded, no explicit locking is needed for index reads.

### 13.3 Idempotent Operations

- `createCollection()`: If collectionId already exists, returns existing definition.
- `mintNFT()`: Oracle handles `REQUEST_ID_EXISTS` idempotently. Token storage `put()` is overwrite-safe.
- `importNFT()`: Duplicate token ID → return existing NFTRef.

---

## 14. Integration Points

### 14.1 PaymentsModule Integration

**Read operations:**
- `getTokens()` — enumerate all tokens to discover NFTs
- `getTokens({ tokenIds: [id] })` — get specific token
- `on('transfer:incoming')` — detect incoming NFTs
- `on('transfer:confirmed')` — confirm outgoing NFT transfers

**Write operations:**
- `send()` — transfer NFT to another wallet

**PaymentsModule modifications required** (see Prerequisites section):
1. Accept `_nftTransfer` flag to skip splitting logic
2. Accept `_tokenIds` for explicit token selection by token ID

### 14.2 TokenStorage Integration

Standard `TokenStorageProvider` operations:
- `put(addressId, key, txfToken)` — store minted/imported NFT
- `get(addressId, key)` — retrieve specific token
- `delete(addressId, key)` — remove transferred token (handled by PaymentsModule)
- Enumeration via PaymentsModule (TokenStorage does not expose enumeration directly)

### 14.3 Oracle Integration

Standard `OracleProvider` operations:
- `submitMintCommitment(commitment)` — submit NFT mint
- `waitForProof(requestId)` / `waitForProofSdk(commitment)` — poll for inclusion proof
- `validateToken(tokenData)` — verify NFT against aggregator

### 14.4 Transport Integration

- `resolve(identifier)` — resolve recipient for NFT transfer
- NFT delivery via existing token transfer mechanism (Nostr NIP-04/NIP-17)

### 14.5 TXF Serializer Update

Update `serialization/txf-serializer.ts` to use `NFT_TOKEN_TYPE_HEX` constant:

```typescript
// Before (hardcoded):
const isNft = tokenType === '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';

// After:
import { NFT_TOKEN_TYPE_HEX } from '../constants';
const isNft = tokenType === NFT_TOKEN_TYPE_HEX;
```

### 14.6 Sphere.ts Integration

```typescript
// core/Sphere.ts — add to Sphere class

private _nft: NFTModule | null = null;

get nft(): NFTModule {
  if (!this._nft) {
    throw new SphereError('NFT_NOT_INITIALIZED', 'NFT module not initialized');
  }
  return this._nft;
}

// In init()/load(), after payments module is loaded:
this._nft = createNFTModule({
  payments: this._payments,
  storage: this._storage,
  tokenStorage: this._tokenStorage,
  oracle: this._oracle,
  identity: this._identity,
  addressId: this._addressId,
  addressIndex: this._addressIndex,
  communications: this._communications,
  emitEvent: this._emitEvent.bind(this),
  logger: this._logger,
});
await this._nft.load();
```

### 14.7 Constants Update

```typescript
// constants.ts — add

/** NFT token type identifier: SHA-256(UTF-8("unicity.nft.v1")) */
export const NFT_TOKEN_TYPE_HEX = '8b0136c928f34e13ba73274a71bc3e96cd7f6799e876d89842ed4a541d0b963c' as const;

// Add to STORAGE_KEYS_ADDRESS:
NFT_COLLECTIONS: 'nft_collections',
NFT_MINT_COUNTER: 'nft_mint_counter',
```
