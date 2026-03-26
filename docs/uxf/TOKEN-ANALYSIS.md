# Unicity Token Data Structure Deep Analysis for UXF

## 1. Token Field-by-Field Decomposition

The canonical token JSON structure (ITokenJson / TXF v2.0) has five top-level fields. What follows is a field-by-field analysis based on the actual SDK source and sphere-sdk usage patterns.

### 1.1 `token.version`

- **Value:** String `"2.0"` (currently the only production version)
- **Byte size:** 3 bytes as UTF-8; in JSON with key: ~18 bytes (`"version":"2.0"`)
- **Shared across tokens in same wallet:** Yes, always identical
- **Shared across wallets:** Yes, always identical (single protocol version)
- **Mutable:** No, fixed at token creation
- **UXF recommendation:** Inline. Too small to warrant a separate DAG element. Include in the token root element header.

### 1.2 `token.state` (TokenState)

```typescript
{
  data: string,       // Hex-encoded state data or null
  predicate: string   // Hex-encoded CBOR predicate
}
```

- **Byte size:** The predicate is a CBOR-encoded `UnmaskedPredicate` containing:
  - `tokenId` (32 bytes)
  - `tokenType` (32 bytes)
  - `signingAlgorithm` identifier
  - `hashAlgorithm` identifier (SHA256)
  - `publicKey` (33 bytes compressed secp256k1)
  - `salt` (32 bytes)
  - Total CBOR: approximately **150-200 bytes** hex-encoded as ~300-400 characters
- **`data` field:** Usually `null` or empty string for fungible tokens; variable for NFTs
- **Total typical size:** 400-500 bytes JSON
- **Shared across tokens in same wallet:** Partially. The `publicKey`, `signingAlgorithm`, `hashAlgorithm` fields repeat. But `tokenId`, `tokenType`, and `salt` differ per token, making the full predicate unique per token state.
- **Shared across wallets:** No. Different keys mean different predicates.
- **Mutable:** Yes, this is the CURRENT state. It changes on every transfer (new owner's predicate replaces it).
- **UXF recommendation:** Separate DAG element. The state is mutable (replaced on transfer) and unique per token, but its sub-components (predicate engine/algorithm identifiers) could be shared. However, the predicate as a whole is small enough that splitting it further adds complexity without meaningful deduplication. Store as a single DAG node.

### 1.3 `token.genesis` (MintTransaction)

The genesis is the immutable birth record of the token. It has three sub-components.

#### 1.3.1 `token.genesis.data` (MintTransactionData)

```typescript
{
  tokenId: string,           // 64-char hex (32 bytes)
  tokenType: string,         // 64-char hex (32 bytes)
  coinData: [string, string][], // [[coinIdHex, amountString], ...]
  tokenData: string,         // Usually empty string
  salt: string,              // 64-char hex (32 bytes)
  recipient: string,         // "DIRECT://..." (~80 chars)
  recipientDataHash: string | null,
  reason: string | null      // null for regular mints, set for splits
}
```

- **Byte size (typical JSON):** 400-550 bytes
  - `tokenId`: 66 bytes (with quotes)
  - `tokenType`: 66 bytes
  - `coinData`: 150-200 bytes (one coin entry with 64-char coinId hex + amount string)
  - `salt`: 66 bytes
  - `recipient`: ~85 bytes
  - Other fields: ~50 bytes
- **Shared:** `tokenType` is shared across all tokens of the same asset class (e.g., all UCT tokens share `455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89`). `coinData`'s coinId is shared. Everything else is unique.
- **Mutable:** No, immutable forever (genesis is written once)
- **UXF recommendation:** Separate DAG element. This is medium-sized, fully immutable, and its `tokenType` sub-field is highly shared. Could further decompose `tokenType` and `coinData` as shared leaf nodes, but the gains are marginal (64 bytes saved per token for tokenType). Keep as one DAG node with inline content.

#### 1.3.2 `token.genesis.inclusionProof` (InclusionProof)

This is the dominant size contributor. Structure:

```typescript
{
  authenticator: {
    algorithm: string,    // "secp256k1" (~10 bytes)
    publicKey: string,    // 66-char hex (33 bytes compressed)
    signature: string,    // ~140-144 char hex (70-72 byte DER-encoded ECDSA)
    stateHash: string     // 64-char hex (32 bytes)
  },
  merkleTreePath: {
    root: string,         // 64-char hex (32 bytes)
    steps: [{
      data: string,       // 64-char hex per step (32 bytes hash)
      path: string        // bit string for direction
    }, ...]
  },
  transactionHash: string,      // 64-char hex (32 bytes)
  unicityCertificate: string    // Hex-encoded CBOR (variable, large)
}
```

**Size breakdown:**

- **Authenticator:** ~300 bytes JSON
  - `algorithm`: ~25 bytes
  - `publicKey`: ~70 bytes  
  - `signature`: ~150 bytes
  - `stateHash`: ~70 bytes
- **Merkle tree path:** Variable, depends on tree depth
  - SMT has 256 levels (2^256 leaves)
  - Typical path: 10-40 steps (sparse tree collapses empty subtrees)
  - Each step: ~140 bytes JSON (`data` 66 chars + `path` variable)
  - **Typical total: 1,400 - 5,600 bytes**
- **Transaction hash:** ~70 bytes
- **Unicity certificate (hex-encoded CBOR):** This is the largest single field
  - Contains: InputRecord, ShardTreeCertificate, UnicityTreeCertificate, UnicitySeal
  - CBOR tags 1007, 1008, 1001 wrap the sub-structures
  - **Typical size: 1,000 - 4,000 bytes hex-encoded** (500-2000 bytes binary)
  - The UnicitySeal contains BFT validator signatures (multiple validators)

**Total inclusion proof: 2,800 - 10,000 bytes JSON (typical: ~5,000 bytes)**

- **Shared:** The `unicityCertificate` is shared by ALL tokens committed in the same aggregator round. This is the primary deduplication target. Upper SMT path segments are also shared between tokens in the same round.
- **Mutable:** No, immutable once assigned
- **UXF recommendation:** Decompose into THREE separate DAG elements:
  1. **Authenticator** (unique per token) - separate node, ~300 bytes
  2. **MerkleTreePath** (partially shared) - separate node, with potential for sharing upper path segments
  3. **UnicityCertificate** (highly shared) - separate node, THE primary deduplication win

#### 1.3.3 `token.genesis.destinationState`

Referenced in the TASK.md hierarchy but in TXF format this appears to be folded into the initial `token.state`. In the SDK's `MintTransaction.toJSON()`, the destination state is the token state after genesis. It is structurally identical to `token.state` described in 1.2.

- **Byte size:** ~400-500 bytes (same as state)
- **Shared:** No
- **Mutable:** No (historical state)
- **UXF recommendation:** Inline within the genesis DAG node or separate if the predicate pattern is shared.

### 1.4 `token.transactions[]` (TransferTransaction[])

Each transfer transaction has this structure:

```typescript
{
  previousStateHash: string,  // 64-char hex
  newStateHash?: string,      // 64-char hex (optional, for quick lookups)
  predicate: string,          // Hex-encoded CBOR predicate (~300-400 chars)
  inclusionProof: {           // Same structure as genesis proof
    authenticator: {...},
    merkleTreePath: {...},
    transactionHash: string,
    unicityCertificate: string
  } | null,                   // null = uncommitted/pending
  data?: Record<string, unknown>  // Optional transfer metadata
}
```

- **Byte size per transaction:** ~5,500 - 11,000 bytes (when committed with proof)
  - State hashes: ~140 bytes
  - Predicate: ~400 bytes
  - Inclusion proof: ~5,000 bytes (same analysis as genesis proof)
  - Data: usually small or absent, ~0-200 bytes
- **Without proof (pending):** ~600 bytes
- **Shared components:** Same as genesis proof analysis:
  - Unicity certificates shared across tokens in same round
  - Upper SMT path segments shared
  - Predicate algorithm identifiers shared
- **Mutable:** No, each transaction is append-only and immutable
- **UXF recommendation:** Each transaction should be its own DAG element, with its inclusion proof decomposed the same way as the genesis proof (authenticator + path + certificate as separate child nodes).

### 1.5 `token.nametags[]`

In TXF format: `nametags: string[]` (simplified to nametag name strings).

In the full SDK ITokenJson: `nametags: Token[]` (recursive! each nametag is a complete token).

- **Byte size per nametag token:** A nametag token is a full token with genesis + proof but typically zero transfer transactions. Size: ~5,500 - 8,000 bytes.
- **Shared:** The SAME nametag token appears in EVERY token that was transferred to/from a PROXY address associated with that nametag. A user with 50 tokens all received via their nametag has the same nametag token embedded 50 times.
- **Mutable:** No
- **UXF recommendation:** Critical deduplication target. The nametag token should be stored as its own complete token sub-DAG in the element pool, referenced by content hash from every parent token that embeds it. This is potentially the second-largest deduplication win after unicity certificates.

## 2. Unicity Certificate Analysis

### Structure

The unicity certificate is CBOR-encoded with tagged structures:

```
UnicityCertificate (tag 1007)
├── InputRecord
│   ├── roundNumber: uint
│   ├── epoch: uint  
│   ├── previousHash: bytes(32)
│   ├── hash: bytes(32)  (SMT root hash for this round)
│   └── blockHash: bytes(32)
├── ShardTreeCertificate (tag 1008)
│   ├── shardId: bytes
│   └── merkleTreePath: [...path steps...]
├── UnicityTreeCertificate
│   ├── unicityTreeRootHash: bytes(32)
│   └── merkleTreePath: [...path steps...]
└── UnicitySeal (tag 1001)
    ├── roundNumber: uint
    ├── rootChainRoundNumber: uint
    └── signatures: Map<validatorId, signature>
        ├── validator1: bytes(64-72)  // ECDSA signature
        ├── validator2: bytes(64-72)
        └── ...
```

### Size Analysis

- **InputRecord:** ~150-200 bytes CBOR (~300-400 hex chars)
- **ShardTreeCertificate:** ~200-500 bytes CBOR (depends on shard path depth)
- **UnicityTreeCertificate:** ~200-500 bytes CBOR  
- **UnicitySeal:** ~300-1000+ bytes CBOR (depends on validator count)
  - Each validator signature: ~70 bytes
  - With 4-8 validators: 280-560 bytes just for signatures
- **Total certificate CBOR:** ~500-2000 bytes binary, **1000-4000 hex chars**

### Sharing Statistics

- **ALL tokens committed in the same aggregator round share the identical unicity certificate** (the certificate is a per-round object, not per-token)
- Aggregator rounds occur every ~1-2 seconds (BFT consensus interval)
- In a batch operation (e.g., wallet sync, split operation), multiple tokens are commonly committed in the same round
- Estimated sharing: in a wallet with 100 tokens, if tokens were received in batches of 5-10, approximately **10-20 unique certificates** cover all 100 tokens
- For split operations specifically, ALL resulting tokens (sender change + recipient) share the same certificate

### Sub-component Sharing

- **UnicitySeal:** Identical across ALL certificates from the same BFT round (even across different shards). This is the most shareable sub-component.
- **InputRecord:** Identical per round.
- **ShardTreeCertificate:** Per-shard, per-round. If all tokens are in the same shard (likely for a single user), this is shared across the round.
- **UnicityTreeCertificate:** Per-round across all shards.

**UXF recommendation:** The certificate should be decomposed into its four sub-components as separate DAG nodes. The UnicitySeal is the most valuable sharing target as it's the largest component and identical per round.

## 3. SMT Path Analysis

### Structure

```typescript
SparseMerkleTreePath {
  root: string,        // 32-byte hash (64 hex chars)
  steps: Array<{
    data: string,      // 32-byte sibling hash (64 hex chars)
    path: string       // Bit string indicating left/right direction
  }>
}
```

### Path Characteristics

- **Tree depth:** 256 levels (2^256 address space)
- **Actual path length:** 10-40 steps (sparse tree; empty subtrees are collapsed)
- **Step size:** ~140 bytes JSON per step (data hash + path bits)
- **Total path size:** 1,400 - 5,600 bytes JSON

### Path Overlap

Tokens committed in the same aggregator round share **upper path segments** of the SMT:
- The root hash is identical (by definition, same round = same tree)
- Path steps from the root downward are shared until the paths diverge toward different leaves
- For two random leaves in a 256-bit space, paths diverge quickly (often within 1-2 steps from the root)
- However, if `RequestId` values have any structural locality (they do -- `RequestId = SHA-256(pubkey || stateHash)`), tokens from the same user cluster somewhat in the address space

### Practical Sharing Assessment

- **Root hash:** Always shared within a round. But it's just 32 bytes -- not worth a separate DAG node.
- **Upper path steps:** Shared only if leaf addresses happen to be close in the 256-bit space. For random addresses, expect 0-3 shared steps before divergence.
- **Typical savings from path sharing:** Minimal for randomly-distributed leaves. Perhaps 5-15% of path data.

**UXF recommendation:** Store the merkle tree path as a single DAG node. Splitting individual path segments provides minimal deduplication benefit and adds significant DAG complexity. The natural sharing unit is the whole path (or the whole inclusion proof).

## 4. Predicate Analysis

### Structure (Unmasked Predicate)

CBOR-encoded structure containing:
```
UnmaskedPredicate {
  engine: "embedded"          // Predicate execution engine
  code: "unmasked_v1"        // Predicate type identifier
  parameters: {
    tokenId: bytes(32)        // Token this predicate controls
    tokenType: bytes(32)      // Asset class
    signingAlgorithm: "secp256k1"
    hashAlgorithm: "SHA256"
    publicKey: bytes(33)      // Owner's compressed pubkey
    salt: bytes(32)           // Random per-predicate
  }
}
```

### Size

- **Binary CBOR:** ~170-200 bytes
- **Hex-encoded:** ~340-400 characters
- **In JSON (with key):** ~420-500 bytes

### Sharing Analysis

- **Within same token (across states):** `tokenId` and `tokenType` are constant; `publicKey` changes on transfer; `salt` changes per state. So predicates for the same token at different states share `tokenId` + `tokenType` but differ in owner and salt. Not practically shareable as whole units.
- **Between different tokens (same owner):** `publicKey`, `signingAlgorithm`, `hashAlgorithm` are identical. But `tokenId`, `tokenType`, and `salt` differ. Not shareable as whole units.
- **Between different owners:** Nothing shared except algorithm identifiers.

**UXF recommendation:** Keep predicates inline within their parent element (state or transaction). The algorithm identifiers (`secp256k1`, `SHA256`, `embedded`, `unmasked_v1`) are tiny constants not worth extracting. Predicates are small (~400 bytes) and rarely shared as complete units.

## 5. Nametag Token Analysis

### Embedding Pattern

In the full SDK `ITokenJson`, `nametags` is an array of complete `Token` objects. A nametag token is a full token that was minted on-chain to register a human-readable name.

A nametag token appears in:
- The `nametags[]` array of every token that was transferred using a PROXY address (nametag-based addressing)
- The user's own nametag storage (as `NametagData.token`)

### Typical Nametag Token Structure

```json
{
  "version": "2.0",
  "state": { "data": null, "predicate": "<CBOR hex ~400 chars>" },
  "genesis": {
    "data": {
      "tokenId": "<64 hex>",
      "tokenType": "f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509",
      "coinData": [],
      "tokenData": "<nametag string data>",
      "salt": "<64 hex>",
      "recipient": "DIRECT://...",
      "recipientDataHash": null,
      "reason": null
    },
    "inclusionProof": { /* same structure as any token */ }
  },
  "transactions": [],
  "nametags": []
}
```

- **Typical size:** 5,000 - 8,000 bytes (mostly the genesis inclusion proof)
- **Always zero transactions** (nametags are minted and never transferred)
- **Frequency of duplication:** A user with N tokens transferred via their nametag has the same nametag token embedded N times. For an active user, N could be 10-100+.

### Deduplication Impact

For a wallet with 50 tokens, if 40 were received via nametag:
- Without dedup: 40 * ~6,000 = **240,000 bytes** of duplicated nametag tokens
- With dedup: **6,000 bytes** (one copy)
- **Savings: ~234,000 bytes (97.5%)**

**UXF recommendation:** This is the highest-impact deduplication target after unicity certificates. The nametag token MUST be stored as a single DAG entry referenced by hash from all parent tokens.

## 6. Real-World Size Statistics

### Token Size by Transaction Count

| Transactions | Typical Size (JSON bytes) | Proof % | Certificate % | Unique Data % |
|---|---|---|---|---|
| 0 (just minted) | 6,000 - 9,000 | 70-80% | 25-40% | 10-15% |
| 1 transfer | 11,000 - 18,000 | 75-85% | 25-40% | 8-12% |
| 5 transfers | 31,000 - 54,000 | 80-88% | 25-40% | 5-8% |
| 10 transfers | 56,000 - 100,000 | 82-90% | 25-40% | 4-6% |

### Component Size Breakdown (single token, 1 transfer)

| Component | Typical Bytes | % of Total |
|---|---|---|
| Genesis data (tokenId, type, coinData, salt, recipient) | 500 | 3-4% |
| Genesis inclusion proof (authenticator + path) | 2,500 | 17-20% |
| Genesis unicity certificate | 2,500 | 17-20% |
| Transaction data (state hashes, predicate) | 600 | 4-5% |
| Transaction inclusion proof (auth + path) | 2,500 | 17-20% |
| Transaction unicity certificate | 2,500 | 17-20% |
| Token state (current predicate) | 500 | 3-4% |
| Nametag token (if present) | 6,000 | 40%+ |
| Version + structure overhead | 200 | 1-2% |

**Note:** When a nametag token is embedded, it dominates the size.

### Pool-Level Deduplication Estimates

For a wallet with 100 tokens (mix of direct and PROXY transfers, received over 20 aggregator rounds):

| Without UXF | With UXF (estimated) | Savings |
|---|---|---|
| Raw JSON per token: ~12,000 bytes avg | After dedup: ~4,000 bytes avg | **67%** |
| 100 tokens: ~1.2 MB | Pool total: ~400 KB | **~800 KB saved** |

Breakdown of savings sources:
- **Unicity certificates:** ~20 unique certificates instead of 100 copies. Saves ~200 KB (50+ certificates * ~4KB each)
- **Nametag tokens:** 1-2 unique nametags instead of 60+ copies. Saves ~350 KB
- **SMT path sharing:** Minimal, ~20 KB
- **Predicate overhead sharing:** Minimal, ~10 KB

For a 1,000-token pool, savings scale super-linearly because certificate and nametag sharing ratios improve.

## 7. Existing Serialization Formats and Their Limitations

### TXF Format (`types/txf.ts` + `serialization/txf-serializer.ts`)

**What it does well:**
- Normalizes SDK byte objects to hex strings for storage
- Handles version metadata, tombstones, outbox, and nametag tracking
- Round-trips through `normalizeSdkTokenToStorage()` -> storage -> `txfToToken()`
- Supports archived and forked token variants via key prefixes

**Limitations UXF must address:**

1. **No deduplication:** Each token is stored as a complete, independent JSON blob (the `sdkData` string). The `TxfStorageData` map stores `_<tokenId>: TxfToken` with full inline content. Two tokens sharing a unicity certificate store it twice.

2. **Flat key-value structure:** `TxfStorageData` is a flat object keyed by `_<tokenId>`. No hierarchical structure, no content addressing, no reference sharing between entries.

3. **String-only nametags:** TXF simplifies `nametags` from full recursive tokens to `string[]` (nametag names only). The actual nametag token data is stored separately in `_nametag` / `_nametags`. This loses the recursive token structure needed for PROXY address verification at the token level.

4. **No incremental updates:** Saving requires serializing the entire `TxfStorageData` object. Adding one token means rewriting the complete pool.

5. **No content addressing:** No hashing, no CIDs, no IPLD compatibility. IPFS sync is done at the whole-document level.

6. **No historical state extraction:** The format stores the current state and all transactions but provides no efficient mechanism to reconstruct a token at an intermediate state without parsing the full structure.

7. **Per-wallet scoping only:** `TxfStorageData` is scoped to a single address (`_meta.address`). No support for cross-wallet token exchange bundles.

### Wallet Text Format (`serialization/wallet-text.ts`)

This is for wallet key backup only (master key, chain code, addresses). Not relevant to token serialization.

### Wallet .dat Format (`serialization/wallet-dat.ts`)

This is for importing legacy Bitcoin Core wallet files. Not relevant to token serialization.

---

## Summary: UXF Decomposition Priorities

Ranked by deduplication impact:

| Priority | Element | Typical Size | Sharing Ratio | Annual Savings (100-token wallet) |
|---|---|---|---|---|
| 1 | **Unicity Certificate** | 2-4 KB | 5-10 tokens per cert | ~200 KB |
| 2 | **Nametag Token** (recursive) | 5-8 KB | 10-100 tokens per nametag | ~350 KB |
| 3 | **UnicitySeal** (cert sub-component) | 0.5-2 KB | Same as certificate | Included in #1 |
| 4 | **Whole Inclusion Proof** | 5-10 KB | If decomposed into cert + path + auth | Enables #1 |
| 5 | **SMT Path segments** | 1.5-5.5 KB | Low overlap for random leaves | ~20 KB |
| 6 | **Token Type identifier** | 32 bytes | All same-coin tokens | Negligible |
| 7 | **Predicate** | 400 bytes | Not practically shared | None |
| 8 | **Genesis/Transaction data** | 500 bytes | Unique per token | None |

**Key files examined in this analysis:**
- `/home/vrogojin/uxf/types/txf.ts` -- TXF type definitions
- `/home/vrogojin/uxf/serialization/txf-serializer.ts` -- TXF serializer/deserializer
- `/home/vrogojin/uxf/modules/payments/NametagMinter.ts` -- Nametag token construction
- `/home/vrogojin/uxf/modules/payments/InstantSplitExecutor.ts` -- Split token construction
- `/home/vrogojin/uxf/modules/payments/InstantSplitProcessor.ts` -- Token finalization with proofs
- `/home/vrogojin/uxf/modules/payments/PaymentsModule.ts` -- Token parsing and SDK integration
- `/home/vrogojin/uxf/validation/token-validator.ts` -- Proof verification patterns
- `/home/vrogojin/uxf/oracle/UnicityAggregatorProvider.ts` -- Aggregator client
- `/home/vrogojin/uxf/tests/unit/modules/PaymentsModule.v5-finalization.test.ts` -- Token structure fixtures
- `/home/vrogojin/uxf/tests/unit/validation/TokenValidator.test.ts` -- Token structure fixtures
- `/home/vrogojin/uxf/TASK.md` -- UXF specification and requirements