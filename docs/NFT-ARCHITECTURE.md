# NFT Module Architecture

> **Status:** Draft specification — no code yet
> **Module path:** `modules/nft/NFTModule.ts`
> **Barrel:** `modules/nft/index.ts`
> **Prerequisite reading:** [NFT-STANDARDS-RESEARCH.md](NFT-STANDARDS-RESEARCH.md)

---

## 1. Overview

The NFT Module extends Sphere SDK with non-fungible token creation, transfer, collection management, and metadata handling. It follows the SDK's established module pattern (like `AccountingModule`, `PaymentsModule`) and integrates with the existing token and transfer infrastructure without modifying core.

### Design Principles

| Principle | Rationale |
|-----------|-----------|
| **NFT IS a token** | An NFT is a minted on-chain token — the metadata lives in the token's genesis `tokenData` field. There is no external state beyond the token itself. The token ID (guaranteed unique by the aggregator) is the NFT ID. |
| **Predicate-based ownership** | Ownership is proven by satisfying the token's predicate, not by querying a contract ledger. Transfer = predicate transition. Inspired by Cardano's minting policy model. |
| **Collection = tokenType** | All NFTs minted with the same `tokenType` constant belong to the same collection. The tokenType is derived from SHA-256 of the collection definition — analogous to Cardano's policy ID. |
| **Immutable genesis, mutable state** | The NFT's metadata (name, description, image, attributes) is immutable once minted (stored in `genesis.data.tokenData`). Only the ownership predicate changes via state transitions. |
| **Read-only dependency on PaymentsModule** | NFTModule reads from PaymentsModule (getTokens, events) and calls `send()` only for transfers. All other interactions are read-only. |
| **Compatible metadata format** | NFT metadata follows the ERC-721 JSON schema (name, description, image, attributes) for interoperability with existing tools and marketplaces. |
| **Non-blocking inbound observer** | NFT-related errors during inbound transfer processing MUST NEVER break the token transfer flow. |

---

## 2. Architecture Diagram

```
+--------------------------------------------------------------------+
|                            Sphere                                   |
|                                                                     |
|  +----------------+   reads     +----------------------------------+|
|  |  Payments      |<-----------|       NFTModule                   ||
|  |  Module        |            |                                    ||
|  |                |  events    |  - mintNFT()                       ||
|  |  getTokens()   |----------->|  - mintCollection()                ||
|  |  on(transfer)  |            |  - transferNFT()                   ||
|  |                |  send()    |  - getNFT()                        ||
|  |  send()       |<-----------|  - getNFTs()                       ||
|  +-------+--------+  (transfer)|  - getCollection()                 ||
|          |                     |  - getCollections()                 ||
|  +-------v--------+            |  - getCollectionNFTs()              ||
|  |  Oracle         |            |  - verifyNFT()                     ||
|  |  (Aggregator)   |<-----------|  - getNFTHistory()                 ||
|  |                 |  mint      |  - importNFT()                     ||
|  |                 |            |  - exportNFT()                     ||
|  +-----------------+            |  - load() / destroy()              ||
|                                 |                                    ||
|  +------------------+  sendDM  |  Internal:                          ||
|  | Communications   |<---------|  - _parseNFTMetadata()              ||
|  | Module           |  onDM    |  - _buildCollectionIndex()          ||
|  | (optional)       |--------->|  - _onIncomingTransfer()            ||
|  +------------------+          +------+-------+-------+--------------+|
|                                       |  TokenStorage  | Storage     ||
|                                       |  (per-address) | Provider    ||
|                                       |  NFT tokens    | Collection  ||
|                                       |  (TXF format)  | registry    ||
|                                       +----------------+-------------+|
+--------------------------------------------------------------------+
```

---

## 3. Token Type System

### 3.1 NFT Token Type Derivation

Following the established pattern from invoice tokens:

```
INVOICE_TOKEN_TYPE_HEX = SHA-256(UTF-8("unicity.invoice.v1"))
NAMETAG_TOKEN_TYPE_HEX = SHA-256(UTF-8("unicity.nametag.v1"))  // existing

NFT_TOKEN_TYPE_HEX     = '8b0136c928f34e13ba73274a71bc3e96cd7f6799e876d89842ed4a541d0b963c'
                       = SHA-256(UTF-8("unicity.nft.v1"))       // NEW: base NFT type
```

This identifies a token as an NFT in the type system. All NFTs share this base token type.

### 3.2 Collection Identity

A **collection** is identified by a `collectionId` — a deterministic hash derived from the collection definition:

```
collectionId = SHA-256(canonicalSerialize(CollectionDefinition))
```

The `collectionId` is stored in the NFT's metadata within `genesis.data.tokenData`, NOT in `genesis.data.tokenType`. This means:

- `tokenType` = `NFT_TOKEN_TYPE_HEX` — identifies the token as an NFT (constant for all NFTs)
- `collectionId` (in metadata) — identifies which collection the NFT belongs to
- `tokenId` = SHA-256 of full genesis data — unique per NFT (standard derivation)

### 3.3 Token Classification Table

| Token Kind | `genesis.data.tokenType` | `genesis.data.coinData` | `genesis.data.tokenData` |
|------------|--------------------------|-------------------------|--------------------------|
| Fungible (UCT, etc.) | coin-specific hash | `[["UCT", "1000000"]]` | `""` |
| Nametag | `UNICITY_TOKEN_TYPE_HEX` | `null` | nametag string |
| Invoice | `INVOICE_TOKEN_TYPE_HEX` | `null` | serialized `InvoiceTerms` |
| **NFT** | **`NFT_TOKEN_TYPE_HEX`** | **`null`** | **serialized `NFTTokenData`** |

---

## 4. Data Model

### 4.1 Collection Definition

```typescript
/**
 * Defines an NFT collection. Serialized deterministically to derive collectionId.
 * Immutable once the first NFT is minted — the collectionId is a hash of this.
 */
interface CollectionDefinition {
  /** Human-readable collection name */
  readonly name: string;
  /** Collection description (markdown-enabled) */
  readonly description: string;
  /** Creator's chain pubkey (33-byte compressed secp256k1, hex) */
  readonly creator: string;
  /** Creation timestamp (ms, creator's local clock) */
  readonly createdAt: number;
  /** Maximum supply (null = unlimited) */
  readonly maxSupply: number | null;
  /** Collection-level image URI (IPFS, HTTPS, or data:) */
  readonly image?: string;
  /** Collection-level external URL */
  readonly externalUrl?: string;
  /** Royalty configuration (optional, informational only) */
  readonly royalty?: RoyaltyConfig;
  /** Whether tokens in this collection are transferable (default: true) */
  readonly transferable?: boolean;
}

/**
 * Royalty configuration (informational, not enforced on-chain).
 * Follows ERC-2981 semantics adapted for Unicity.
 */
interface RoyaltyConfig {
  /** Recipient address (DIRECT://... or chain pubkey) */
  readonly recipient: string;
  /** Royalty percentage in basis points (e.g., 500 = 5%) */
  readonly basisPoints: number;
}
```

### 4.2 NFT Token Data (Stored in genesis.data.tokenData)

```typescript
/**
 * Complete NFT data payload, serialized into genesis.data.tokenData.
 * This is immutable once the token is minted.
 */
interface NFTTokenData {
  /** Collection ID (64-char hex) — links this NFT to its collection */
  readonly collectionId: string;
  /** NFT metadata (ERC-721-compatible JSON schema) */
  readonly metadata: NFTMetadata;
  /** Edition number within the collection (1-based, optional) */
  readonly edition?: number;
  /** Total editions planned (optional, informational) */
  readonly totalEditions?: number;
  /** Minter's chain pubkey (may differ from collection creator for delegated minting) */
  readonly minter?: string;
  /** Mint timestamp (ms) */
  readonly mintedAt: number;
}

/**
 * NFT metadata — follows ERC-721 JSON schema for cross-ecosystem compatibility.
 */
interface NFTMetadata {
  /** Human-readable token name */
  readonly name: string;
  /** Token description (markdown-enabled) */
  readonly description?: string;
  /** Primary image URI (IPFS recommended: ipfs://Qm...) */
  readonly image: string;
  /** Animation/multimedia URI (video, audio, 3D model, HTML) */
  readonly animationUrl?: string;
  /** External link to creator's page for this token */
  readonly externalUrl?: string;
  /** Background color for display (hex, no # prefix) */
  readonly backgroundColor?: string;
  /** Trait attributes (ERC-721 attributes array format) */
  readonly attributes?: NFTAttribute[];
  /** Arbitrary structured properties */
  readonly properties?: Record<string, unknown>;
  /** Content URIs for different resolutions/formats */
  readonly content?: NFTContent;
}

/**
 * A single trait attribute (ERC-721 attributes format).
 */
interface NFTAttribute {
  /** Trait category name */
  readonly trait_type: string;
  /** Trait value (string, number, or boolean) */
  readonly value: string | number | boolean;
  /** Display type hint: "number", "boost_number", "boost_percentage", "date" */
  readonly display_type?: string;
  /** Maximum value (for numeric display types) */
  readonly max_value?: number;
}

/**
 * Multi-resolution content references.
 */
interface NFTContent {
  /** Thumbnail image URI (small, for lists) */
  readonly thumbnail?: string;
  /** Preview image URI (medium, for cards) */
  readonly preview?: string;
  /** Full-resolution image URI */
  readonly full?: string;
  /** Original source file URI */
  readonly original?: string;
}
```

### 4.3 NFT Reference (Lightweight In-Memory)

```typescript
/**
 * Lightweight NFT reference for listing/filtering.
 * Constructed from token data on load(), held in memory.
 */
interface NFTRef {
  /** Token ID (= NFT ID, 64-char hex) */
  readonly tokenId: string;
  /** Collection ID (64-char hex) */
  readonly collectionId: string;
  /** NFT name (from metadata) */
  readonly name: string;
  /** Primary image URI */
  readonly image: string;
  /** Edition number (if applicable) */
  readonly edition?: number;
  /** Whether this NFT is confirmed (has inclusion proof) */
  readonly confirmed: boolean;
  /** Token status */
  readonly status: TokenStatus;
  /** Mint timestamp */
  readonly mintedAt: number;
}

/**
 * Collection reference for listing/filtering.
 * Derived from tokens + stored collection definitions.
 */
interface CollectionRef {
  /** Collection ID (64-char hex) */
  readonly collectionId: string;
  /** Collection name */
  readonly name: string;
  /** Collection image URI */
  readonly image?: string;
  /** Creator's chain pubkey */
  readonly creator: string;
  /** Number of NFTs from this collection in the wallet */
  readonly tokenCount: number;
  /** Maximum supply (null = unlimited) */
  readonly maxSupply: number | null;
  /** Whether the current wallet is the creator */
  readonly isCreator: boolean;
  /** Royalty config (if set) */
  readonly royalty?: RoyaltyConfig;
  /** Whether tokens are transferable */
  readonly transferable: boolean;
}
```

---

## 5. Module API

### 5.1 Minting

```typescript
/**
 * Create a new NFT collection definition and store it locally.
 * Does NOT mint any tokens — just registers the collection.
 * Returns the deterministic collectionId.
 */
createCollection(request: CreateCollectionRequest): Promise<CreateCollectionResult>

interface CreateCollectionRequest {
  name: string;
  description: string;
  maxSupply?: number | null;
  image?: string;
  externalUrl?: string;
  royalty?: RoyaltyConfig;
  transferable?: boolean;   // default: true
}

interface CreateCollectionResult {
  collectionId: string;
  definition: CollectionDefinition;
}

/**
 * Mint a single NFT in a collection.
 * Mints on-chain: creates commitment, waits for inclusion proof, stores token.
 */
mintNFT(request: MintNFTRequest): Promise<MintNFTResult>

interface MintNFTRequest {
  collectionId: string;
  metadata: NFTMetadata;
  edition?: number;
  totalEditions?: number;
  /** Recipient (default: self). Supports @nametag, DIRECT://, chain pubkey */
  recipient?: string;
}

interface MintNFTResult {
  tokenId: string;
  collectionId: string;
  confirmed: boolean;
  /** The NFTRef for the newly minted token */
  nft: NFTRef;
}

/**
 * Mint multiple NFTs in a collection (batch).
 * Each NFT gets its own token ID and inclusion proof.
 * Minting is parallelized where possible.
 */
batchMintNFT(request: BatchMintNFTRequest): Promise<BatchMintNFTResult>

interface BatchMintNFTRequest {
  collectionId: string;
  items: Array<{
    metadata: NFTMetadata;
    edition?: number;
    recipient?: string;
  }>;
}

interface BatchMintNFTResult {
  results: MintNFTResult[];
  successCount: number;
  failureCount: number;
  errors?: Array<{ index: number; error: string }>;
}
```

### 5.2 Transfer

```typescript
/**
 * Transfer an NFT to another wallet.
 * Uses PaymentsModule.send() under the hood.
 */
transferNFT(request: TransferNFTRequest): Promise<TransferResult>

interface TransferNFTRequest {
  /** Token ID of the NFT to transfer */
  tokenId: string;
  /** Recipient: @nametag, DIRECT://..., chain pubkey, alpha1... */
  recipient: string;
  /** Optional memo */
  memo?: string;
}
```

### 5.3 Queries

```typescript
/**
 * Get a single NFT by token ID.
 * Returns full metadata, collection info, and ownership status.
 */
getNFT(tokenId: string): Promise<NFTDetail | null>

interface NFTDetail extends NFTRef {
  /** Full NFT metadata */
  metadata: NFTMetadata;
  /** Full collection definition (if available locally) */
  collection?: CollectionDefinition;
  /** Total editions */
  totalEditions?: number;
  /** Minter pubkey */
  minter?: string;
  /** Full token data (TXF) */
  token: Token;
}

/**
 * List all NFTs in the wallet.
 * Supports filtering and pagination.
 */
getNFTs(options?: GetNFTsOptions): NFTRef[]

interface GetNFTsOptions {
  /** Filter by collection ID */
  collectionId?: string;
  /** Filter by status */
  status?: TokenStatus | TokenStatus[];
  /** Sort field */
  sortBy?: 'name' | 'mintedAt' | 'collectionId';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
  /** Pagination: offset */
  offset?: number;
  /** Pagination: limit */
  limit?: number;
}

/**
 * Get a collection definition by ID.
 */
getCollection(collectionId: string): CollectionRef | null

/**
 * List all collections known to the wallet.
 * Includes both created and received collections.
 */
getCollections(options?: GetCollectionsOptions): CollectionRef[]

interface GetCollectionsOptions {
  /** Only collections created by this wallet */
  createdByMe?: boolean;
  /** Sort field */
  sortBy?: 'name' | 'tokenCount' | 'creator';
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Get all NFTs in a specific collection within this wallet.
 */
getCollectionNFTs(collectionId: string): NFTRef[]

/**
 * Get the transfer/ownership history of an NFT.
 * Derived from the token's transaction chain.
 */
getNFTHistory(tokenId: string): NFTHistoryEntry[]

interface NFTHistoryEntry {
  /** Event type */
  type: 'mint' | 'transfer_in' | 'transfer_out';
  /** Counterparty pubkey */
  counterparty?: string;
  /** Counterparty nametag */
  counterpartyNametag?: string;
  /** Timestamp (from inclusion proof) */
  timestamp: number;
  /** Transaction hash */
  txHash?: string;
  /** Whether this event is confirmed */
  confirmed: boolean;
}
```

### 5.4 Import / Export

```typescript
/**
 * Import an NFT received via transport (Nostr DM with TXF payload).
 * Parses metadata, indexes collection, stores token.
 */
importNFT(token: TxfToken): Promise<NFTRef>

/**
 * Export an NFT as a TXF-format JSON object.
 * For sharing, backup, or cross-wallet transfer.
 */
exportNFT(tokenId: string): Promise<TxfToken | null>
```

### 5.5 Verification

```typescript
/**
 * Verify an NFT's authenticity against the aggregator.
 * Checks inclusion proof, state hash, and predicate validity.
 */
verifyNFT(tokenId: string): Promise<NFTVerificationResult>

interface NFTVerificationResult {
  /** Whether the token is valid */
  valid: boolean;
  /** Whether the token has been spent (transferred away) */
  spent: boolean;
  /** Current state hash from aggregator */
  stateHash?: string;
  /** Verification errors (if any) */
  errors?: string[];
}
```

---

## 6. Storage Schema

### 6.1 Token Storage

NFT tokens are stored in `TokenStorageProvider` using the same format as all other tokens:

```
TokenStorage (per-address database)
├── _meta: TxfMeta
├── _${tokenId}: TxfToken       ← NFT token (genesis.data.tokenType = NFT_TOKEN_TYPE_HEX)
├── _${tokenId}: TxfToken       ← Another NFT token
├── _${otherTokenId}: TxfToken  ← Fungible token (different tokenType)
└── ...
```

NFTs are identified by `genesis.data.tokenType === NFT_TOKEN_TYPE_HEX`. No separate NFT storage needed.

### 6.2 Collection Registry (StorageProvider)

Collection definitions are stored in the per-address `StorageProvider`:

```
StorageProvider key: sphere_{addressIndex}_nft_collections
Value: JSON string of Record<collectionId, CollectionDefinition>
```

Storage key constant:

```typescript
STORAGE_KEYS_ADDRESS.NFT_COLLECTIONS = 'nft_collections'
```

### 6.3 Mint Counter (StorageProvider)

Tracks the next edition number for auto-incrementing editions:

```
StorageProvider key: sphere_{addressIndex}_nft_mint_counter_{collectionId}
Value: JSON string of number (next edition number)
```

---

## 7. Serialization

### 7.1 Canonical Serialization for NFTTokenData

Following the accounting module's pattern, NFT token data is canonically serialized for deterministic token ID derivation:

```typescript
function canonicalSerializeNFT(data: NFTTokenData): string {
  // Key ordering: alphabetical, strict
  // 1. attributes: sorted by trait_type (ascending)
  // 2. collectionId: always present
  // 3. edition: null if absent
  // 4. metadata: {
  //      animationUrl, attributes, backgroundColor,
  //      content, description, externalUrl, image, name, properties
  //    }
  // 5. mintedAt: always present
  // 6. minter: null if absent
  // 7. totalEditions: null if absent
  //
  // Compact JSON — no trailing whitespace.
}
```

### 7.2 Collection Definition Serialization

```typescript
function canonicalSerializeCollection(def: CollectionDefinition): string {
  // Key ordering: alphabetical, strict
  // createdAt, creator, description, externalUrl (null if absent),
  // image (null if absent), maxSupply (null if absent),
  // name, royalty (null if absent), transferable (default true)
  //
  // Compact JSON.
}
```

---

## 8. Events

### 8.1 NFT Events

| Event | Payload | When |
|-------|---------|------|
| `nft:minted` | `{ tokenId, collectionId, name, confirmed }` | NFT token successfully minted |
| `nft:received` | `{ tokenId, collectionId, name, senderPubkey, senderNametag? }` | NFT received via transport |
| `nft:transferred` | `{ tokenId, collectionId, recipientPubkey, recipientNametag? }` | NFT transferred out |
| `nft:verified` | `{ tokenId, valid, spent }` | NFT verification completed |
| `nft:collection_created` | `{ collectionId, name }` | New collection registered |
| `nft:imported` | `{ tokenId, collectionId, name }` | NFT imported from TXF |

### 8.2 Integration with Existing Events

The NFT module subscribes to existing transfer events from PaymentsModule:

```
transfer:incoming → check if tokenType === NFT_TOKEN_TYPE_HEX → emit nft:received
transfer:confirmed → check if NFT transfer → emit nft:transferred (confirmed)
```

---

## 9. Lifecycle

### 9.1 Initialization

```
Sphere.init() / Sphere.load()
  └── NFTModule.load()
        ├── Enumerate tokens via PaymentsModule.getTokens()
        ├── Filter by tokenType === NFT_TOKEN_TYPE_HEX
        ├── Parse NFTTokenData from genesis.data.tokenData
        ├── Build in-memory NFTRef index
        ├── Load collection definitions from StorageProvider
        ├── Build CollectionRef index
        └── Subscribe to transfer events
```

### 9.2 Minting Flow

```
mintNFT(request)
  ├── 1. Resolve collectionId → CollectionDefinition (must exist locally)
  ├── 2. Validate: maxSupply not exceeded (if set)
  ├── 3. Construct NFTTokenData { collectionId, metadata, edition, mintedAt }
  ├── 4. canonicalSerializeNFT(data) → tokenData string
  ├── 5. Generate salt (32 random bytes)
  ├── 6. Create MintTransactionData {
  │       tokenId: SHA-256(tokenData + salt + recipient),
  │       tokenType: NFT_TOKEN_TYPE_HEX,
  │       coinData: null,  // NFTs have no fungible value
  │       tokenData: serialized NFTTokenData,
  │       salt, recipient
  │     }
  ├── 7. Create MintCommitment
  ├── 8. Submit to Oracle (aggregator)
  ├── 9. Wait for inclusion proof
  ├── 10. Create token state + predicate
  ├── 11. Construct final Token
  ├── 12. Store in TokenStorage
  ├── 13. Update in-memory index
  ├── 14. Increment mint counter
  └── 15. Emit nft:minted event
```

### 9.3 Transfer Flow

```
transferNFT(request)
  ├── 1. Resolve tokenId → Token (must exist, must be NFT)
  ├── 2. Validate: collection.transferable !== false
  ├── 3. Resolve recipient via transport.resolve()
  ├── 4. Delegate to PaymentsModule.send({
  │       recipient, amount: "1", coinId: tokenId,
  │       memo: request.memo,
  │       tokenIds: [tokenId]  // explicit token selection
  │     })
  ├── 5. Wait for transfer result
  ├── 6. Update in-memory index (remove from local)
  └── 7. Emit nft:transferred event
```

### 9.4 Incoming Transfer Processing

```
on(transfer:incoming)
  ├── 1. Check if any received token has tokenType === NFT_TOKEN_TYPE_HEX
  ├── 2. For each NFT token:
  │     ├── Parse NFTTokenData from genesis.data.tokenData
  │     ├── Extract collectionId
  │     ├── If collection unknown locally → create CollectionRef from metadata
  │     ├── Add to in-memory NFTRef index
  │     └── Emit nft:received event
  └── 3. Errors are logged but never block transfer processing
```

---

## 10. Integration with Sphere

### 10.1 Sphere Class Integration

```typescript
class Sphere {
  private _nft: NFTModule | null = null;

  /** NFT module — minting, transfer, collection management */
  get nft(): NFTModule {
    if (!this._nft) throw new SphereError('NFT module not initialized');
    return this._nft;
  }
}
```

### 10.2 Connect Protocol Extensions

New RPC methods for dApp integration:

| Method | Description |
|--------|-------------|
| `sphere_getNFTs` | List NFTs in wallet (with filters) |
| `sphere_getNFT` | Get single NFT detail |
| `sphere_getCollections` | List collections |
| `sphere_getCollectionNFTs` | List NFTs in a collection |

New intent actions:

| Action | User sees | Description |
|--------|-----------|-------------|
| `nft_transfer` | Transfer modal | Transfer an NFT to another wallet |
| `nft_mint` | Mint modal | Mint a new NFT |

New permission scopes:

| Scope | Grants access to |
|-------|-----------------|
| `nft:read` | NFT and collection queries |
| `intent:nft_transfer` | NFT transfer intent |
| `intent:nft_mint` | NFT mint intent |

### 10.3 Token Registry Integration

The `TokenRegistry` already supports `assetKind: 'non-fungible'`. NFT collections can be registered in the token registry for ecosystem-wide metadata:

```typescript
interface TokenDefinition {
  network: string;
  assetKind: 'fungible' | 'non-fungible';  // Already exists
  name: string;
  symbol?: string;       // Not used for NFTs
  decimals?: number;     // Not used for NFTs
  description: string;
  icons?: TokenIcon[];
  id: string;            // For NFTs: the collectionId
}
```

### 10.4 TXF Serializer Update

The existing `txf-serializer.ts` already has a hardcoded NFT detection:

```typescript
// serialization/txf-serializer.ts:220
const isNft = tokenType === '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
```

This legacy value (`455ad872...`) does NOT match `SHA-256("unicity.nft.v1")` and must be replaced with the canonical `NFT_TOKEN_TYPE_HEX` constant (`8b0136c9...`).

---

## 11. Error Codes

| Code | When |
|------|------|
| `NFT_COLLECTION_NOT_FOUND` | Collection ID not registered locally |
| `NFT_NOT_FOUND` | Token ID not found or not an NFT |
| `NFT_MAX_SUPPLY_EXCEEDED` | Mint would exceed collection's maxSupply |
| `NFT_NOT_TRANSFERABLE` | Collection marked as non-transferable (soulbound) |
| `NFT_INVALID_METADATA` | Metadata missing required fields (name, image) |
| `NFT_MINT_FAILED` | Oracle/aggregator rejected the mint commitment |
| `NFT_PARSE_ERROR` | Failed to parse NFTTokenData from genesis.data.tokenData |
| `NFT_ALREADY_EXISTS` | Token ID already exists in storage (idempotent retry) |
| `NFT_WRONG_TOKEN_TYPE` | Token's tokenType is not NFT_TOKEN_TYPE_HEX |

---

## 12. Dependencies

### Existing (No New External Dependencies)

| Dependency | Usage |
|------------|-------|
| `@unicitylabs/state-transition-sdk` | MintTransactionData, MintCommitment, TokenType, etc. |
| `@noble/hashes` | SHA-256 for token ID and collection ID derivation |
| PaymentsModule | Token enumeration, send(), transfer events |
| StorageProvider | Collection definitions, mint counters |
| TokenStorageProvider | Token storage (existing, shared with all token types) |
| OracleProvider | Mint submission, inclusion proof polling |
| TransportProvider | Recipient resolution, NFT delivery via DM |

### No New Dependencies Required

The NFT module reuses all existing infrastructure. No new npm packages needed.

---

## 13. Future Extensions (Out of Scope for V1)

| Feature | Description | Prerequisite |
|---------|-------------|-------------|
| **Marketplace integration** | List/buy/sell NFTs with price discovery | Marketplace protocol |
| **Royalty enforcement** | Auto-split payments on secondary sales | Marketplace protocol |
| **Token-bound accounts** | NFTs holding other tokens | ERC-6551-like predicate model |
| **Compressed NFTs** | Merkle tree compression for mass minting | Aggregator SMT support |
| **Cross-chain NFTs** | L1↔L3 NFT portability | Cross-layer bridge |
| **Dynamic metadata** | Mutable NFT state (game items, etc.) | State data extension |
| **Fractional ownership** | Multiple owners of a single NFT | New predicate type |
| **Lazy minting** | Defer on-chain minting until first transfer | Off-chain commitment pattern |
| **IPFS auto-upload** | Upload images to IPFS as part of mint flow | IPFS write integration |
