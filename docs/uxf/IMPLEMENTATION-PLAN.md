# UXF Implementation Plan

**Status:** Approved for Phase 1
**Date:** 2026-03-26
**Target:** `@unicitylabs/sphere-sdk/uxf` entry point

This document defines the ordered, parallelism-maximized work plan for implementing the UXF (Universal eXchange Format) module within sphere-sdk.

---

## Dependency Graph

```
Layer 0 (Foundation)     WU-01  WU-02  WU-03       (no deps, all parallel)
                           │      │      │
Layer 1 (Data Structs)    WU-04 ─┤      │          (depends on L0)
                           │    WU-05 ──┤
                           │      │      │
Layer 2 (Algorithms)      WU-06 ─┼──────┤          (depends on L1)
                           │    WU-07 ──┤
                           │      │      │
Layer 3 (Package Ops)     WU-08 ─┼──────┤          (depends on L2)
                           │    WU-09 ──┤
                           │    WU-10 ──┤
                           │      │      │
Layer 4 (Serialization)   WU-11 ─┼──────┤          (depends on L1, parallel with L2-L3)
                          WU-12 ─┤      │
                           │      │      │
Layer 5 (Integration)    WU-13 ─┼──────┤          (depends on all)
                          WU-14 ─┤      │
                          WU-15 ─┤      │
                           │      │      │
Layer 6 (Tests)          WU-16 ─┼──────┤          (depends on all)
                          WU-17 ─┤
```

---

## Layer 0 -- Foundation (No Dependencies)

### WU-01: Type Definitions

- **ID:** WU-01
- **Name:** UXF Type System
- **File(s):** `/home/vrogojin/uxf/uxf/types.ts`
- **Dependencies:** None
- **Parallel Group:** PG-0
- **Estimated Complexity:** M
- **Description:**

  Define all UXF TypeScript types as specified in ARCHITECTURE Section 2. This is the foundational type layer that every other module imports.

  Types to define:
  1. `ContentHash` -- branded string type with `contentHash()` constructor (ARCH 2.1). Validate 64-char lowercase hex.
  2. `UxfElementHeader` -- readonly interface with `representation`, `semantics`, `kind`, `predecessor` (ARCH 2.2).
  3. `UxfInstanceKind` -- union type: `'default' | 'individual-proof' | 'consolidated-proof' | 'zk-proof' | 'full-history' | (string & {})` (ARCH 2.2).
  4. `UxfElementType` -- 12-value string literal union (ARCH 2.3). Values: `'token-root'`, `'genesis'`, `'genesis-data'`, `'transaction'`, `'transaction-data'`, `'inclusion-proof'`, `'authenticator'`, `'unicity-certificate'`, `'predicate'`, `'token-state'`, `'token-coin-data'`, `'smt-path'`.
  5. `UxfElement` -- base DAG node interface with `header`, `type`, `content`, `children` (ARCH 2.4).
  6. `UxfElementContent` -- `Readonly<Record<string, unknown>>` (ARCH 2.4).
  7. Typed element content/children interfaces (ARCH 2.5): `TokenRootContent`, `TokenRootChildren`, `GenesisContent`, `GenesisChildren`, `GenesisDataContent`, `TransactionContent`, `TransactionChildren`, `TransactionDataContent`, `InclusionProofContent`, `InclusionProofChildren`, `AuthenticatorContent`, `SmtPathContent`, `UnicityCertificateContent`, `PredicateContent`, `StateContent`.
  8. `UxfManifest` -- `{ tokens: ReadonlyMap<string, ContentHash> }` (ARCH 2.6).
  9. `InstanceChainEntry` and `InstanceChainIndex` -- chain metadata types (ARCH 2.7).
  10. `InstanceSelectionStrategy` -- discriminated union with `latest`, `original`, `by-representation`, `by-kind`, `custom` variants (ARCH 2.8). Constants `STRATEGY_LATEST` and `STRATEGY_ORIGINAL`.
  11. `UxfEnvelope` -- package metadata (ARCH 2.9).
  12. `UxfIndexes` -- secondary indexes: `byTokenType`, `byCoinId`, `byStateHash` (ARCH 2.9).
  13. `UxfPackageData` -- top-level bundle type (ARCH 2.9).
  14. `UxfStorageAdapter` -- async save/load/clear interface (ARCH 7.2).
  15. `UxfVerificationResult` and `UxfVerificationIssue` (ARCH 8.4).
  16. `UxfDelta` -- diff result type (ARCH 8.5).
  17. `ELEMENT_TYPE_IDS` -- mapping from `UxfElementType` string to SPEC Section 2.1 integer IDs. Export as a const record.

  Edge cases:
  - `contentHash()` must reject uppercase hex, non-hex characters, and wrong-length strings.
  - All interfaces use `readonly` properties per code style.
  - `TransactionChildren.data` and `TransactionChildren.inclusionProof` are `ContentHash | null` (nullable for uncommitted transactions, per SPEC 2.2.3).

- **Acceptance Criteria:**
  1. All types compile with `tsc --noEmit`.
  2. `contentHash('a'.repeat(64))` succeeds; `contentHash('A'.repeat(64))` throws; `contentHash('xyz')` throws.
  3. `ELEMENT_TYPE_IDS` has exactly 12 entries matching SPEC Section 2.1 integer values.
  4. Every typed content interface matches its ARCHITECTURE Section 2.5 definition field-for-field.

---

### WU-02: Error Types

- **ID:** WU-02
- **Name:** UXF Error System
- **File(s):** `/home/vrogojin/uxf/uxf/errors.ts`
- **Dependencies:** None
- **Parallel Group:** PG-0
- **Estimated Complexity:** S
- **Description:**

  Define the `UxfError` class and `UxfErrorCode` type per ARCHITECTURE Section 8.3.

  Error codes to define:
  - `INVALID_HASH` -- malformed content hash
  - `MISSING_ELEMENT` -- element not found in pool
  - `TOKEN_NOT_FOUND` -- token ID not in manifest
  - `STATE_INDEX_OUT_OF_RANGE` -- stateIndex exceeds transaction count
  - `TYPE_MISMATCH` -- element has unexpected type during reassembly
  - `INVALID_INSTANCE_CHAIN` -- chain validation failure (cycle, wrong type, missing predecessor)
  - `DUPLICATE_TOKEN` -- reserved for future strict-mode ingestion
  - `SERIALIZATION_ERROR` -- CBOR/JSON encode/decode failure
  - `VERIFICATION_FAILED` -- content hash mismatch during reassembly or verify
  - `CYCLE_DETECTED` -- DAG cycle found (Decision 8)
  - `INVALID_PACKAGE` -- structural envelope validation failure
  - `NOT_IMPLEMENTED` -- placeholder for Phase 2 features (Decision 9)

  Implementation:
  ```typescript
  export class UxfError extends Error {
    constructor(readonly code: UxfErrorCode, message: string, readonly cause?: unknown) {
      super(`[UXF:${code}] ${message}`);
      this.name = 'UxfError';
    }
  }
  ```

- **Acceptance Criteria:**
  1. `new UxfError('MISSING_ELEMENT', 'test')` produces `message === '[UXF:MISSING_ELEMENT] test'`.
  2. `instanceof UxfError` works.
  3. `error.code` is typed as `UxfErrorCode`.
  4. `NOT_IMPLEMENTED` is included in the code union.

---

### WU-03: Content Hashing

- **ID:** WU-03
- **Name:** Content Hash Computation
- **File(s):** `/home/vrogojin/uxf/uxf/hash.ts`
- **Dependencies:** WU-01, WU-02 (uses `ContentHash`, `UxfElement`, `UxfError`, `ELEMENT_TYPE_IDS`)
- **Parallel Group:** PG-0 (can start types stub immediately, finalize after WU-01)
- **Estimated Complexity:** M
- **Description:**

  Implement `computeElementHash()` per ARCHITECTURE Section 3.2 and SPECIFICATION Section 4.

  Key behaviors (SPEC 4.2):
  1. The canonical form for hashing is a 4-key CBOR map: `{ header, type, content, children }`.
  2. `header` is encoded as a 4-element CBOR array: `[representation, semantics, kind, predecessor]`.
  3. `type` is the **integer type ID** from `ELEMENT_TYPE_IDS`, NOT the string tag (SPEC 4.2 paragraph 3).
  4. `predecessor` in the header is either a raw 32-byte value (from hex) or null. For hashing, hex strings representing byte values should be converted to `Uint8Array` so that dag-cbor encodes them as CBOR byte strings (`bstr`), not text strings.
  5. Child references are raw hash values (hex -> bytes for CBOR encoding).
  6. Hash = SHA-256 over the dag-cbor deterministic encoding of this map.

  Dependencies:
  - `@ipld/dag-cbor` `encode()` for deterministic CBOR (RFC 8949 Section 4.2.1 + dag-cbor extensions).
  - `@noble/hashes/sha256` for SHA-256.
  - `bytesToHex` from `../core/crypto`.

  Critical implementation detail -- hex-to-bytes normalization:
  - Content hashes stored as hex strings in the in-memory model must be converted to `Uint8Array` before CBOR encoding so they serialize as CBOR `bstr`, not `tstr`. This applies to: `header.predecessor`, all `children` values, and any content fields that are semantically byte data (tokenId, tokenType, salt, publicKey, etc.).
  - Define a helper `prepareContentForHashing(type, content)` that converts hex-encoded byte fields to `Uint8Array` based on the element type. Reference the SPEC Section 2.2 field types (e.g., `bytes(32)` -> convert, `text` -> keep as string).
  - Define a helper `prepareChildrenForHashing(children)` that converts all `ContentHash` values to `Uint8Array`.

  Edge cases:
  - Empty `children` map: `{}` -- must still encode as empty CBOR map.
  - Empty `content` map: `{}` -- same.
  - `null` children (e.g., `TransactionChildren.data = null`): encode as CBOR null (SPEC 4.4 rule 8).
  - `null` predecessor: encode as CBOR null.

- **Acceptance Criteria:**
  1. Hashing the same element twice produces the same `ContentHash`.
  2. Changing any field (even one byte in a leaf) produces a different hash.
  3. The hash is a valid 64-char lowercase hex string.
  4. Two elements with identical logical content but different field order still produce the same hash (dag-cbor sorts keys).
  5. Unit test: construct a known element, hash it, verify against a pre-computed expected hash.

---

## Layer 1 -- Core Data Structures (Depends on Layer 0)

### WU-04: Element Pool

- **ID:** WU-04
- **Name:** Element Pool Implementation
- **File(s):** `/home/vrogojin/uxf/uxf/element-pool.ts`
- **Dependencies:** WU-01, WU-02, WU-03
- **Parallel Group:** PG-1
- **Estimated Complexity:** S
- **Description:**

  Implement the `ElementPool` class per ARCHITECTURE Section 3.1.

  Methods:
  - `get size(): number` -- element count.
  - `has(hash: ContentHash): boolean` -- existence check.
  - `get(hash: ContentHash): UxfElement | undefined` -- fetch by hash.
  - `put(element: UxfElement): ContentHash` -- insert with dedup. Calls `computeElementHash(element)`. If hash already exists, no-op (ARCH 3.1, Decision 12). Returns the content hash.
  - `delete(hash: ContentHash): boolean` -- remove element. Returns true if removed.
  - `entries(): IterableIterator<[ContentHash, UxfElement]>` -- iterate all.
  - `hashes(): IterableIterator<ContentHash>` -- iterate all keys.
  - `values(): IterableIterator<UxfElement>` -- iterate all values.

  Internal: `private readonly elements: Map<ContentHash, UxfElement>`.

  Deduplication (ARCH 4.4): automatic via content-addressed insertion. Two structurally identical elements produce the same hash and only one copy is stored.

- **Acceptance Criteria:**
  1. `pool.put(elem)` returns same hash for identical elements.
  2. `pool.put(elem)` twice does not increase `pool.size`.
  3. `pool.get(hash)` returns the element; `pool.get(unknownHash)` returns `undefined`.
  4. `pool.delete(hash)` returns true on first call, false on second.
  5. Iterator yields all inserted elements.

---

### WU-05: Instance Chain Management

- **ID:** WU-05
- **Name:** Instance Chain Index and Selection
- **File(s):** `/home/vrogojin/uxf/uxf/instance-chain.ts`
- **Dependencies:** WU-01, WU-02, WU-03, WU-04
- **Parallel Group:** PG-1
- **Estimated Complexity:** M
- **Description:**

  Implement instance chain management per ARCHITECTURE Section 3.3 and SPECIFICATION Section 7.

  Functions to implement:

  1. `createInstanceChainIndex(): MutableInstanceChainIndex` -- create an empty mutable index (a `Map<ContentHash, InstanceChainEntry>`).

  2. `addInstance(pool: ElementPool, index: MutableInstanceChainIndex, originalHash: ContentHash, newInstance: UxfElement): ContentHash` -- append a new instance to an existing element's chain. Per SPEC 7.2:
     - Validate same element type (rule 1).
     - Validate `newInstance.header.predecessor === currentHead` (rule 2).
     - Validate `newInstance.header.semantics >= predecessor's semantics` (rule 3).
     - Insert new instance into pool.
     - Update index: all hashes in the chain point to the same updated `InstanceChainEntry` with the new head.
     - Return the new instance's content hash.

  3. `selectInstance(chainEntry: InstanceChainEntry, strategy: InstanceSelectionStrategy, pool: ElementPool): ContentHash` -- select an instance per SPEC 7.4:
     - `latest`: return `chainEntry.head` (O(1)).
     - `original`: return last element in `chainEntry.chain` (the tail).
     - `by-representation`: walk chain head-to-tail, return first with matching `representation` version.
     - `by-kind`: walk chain, return first with matching `kind`. If not found and `fallback` is set, recurse with fallback strategy.
     - `custom`: walk chain, return first where `predicate(element)` returns true. Fallback if not found.

  4. `resolveElement(pool: ElementPool, hash: ContentHash, instanceChains: InstanceChainIndex, strategy: InstanceSelectionStrategy): UxfElement` -- resolve a hash to its selected instance element (ARCH 3.3). Checks instance chain index first; if no chain, resolves directly from pool. Throws `MISSING_ELEMENT` if not found.

  5. `validateInstanceChain(pool: ElementPool, chainEntry: InstanceChainEntry): UxfVerificationIssue[]` -- validate chain per SPEC 7.3: all same type, linear sequence, tail has null predecessor, all present in pool, content hashes match.

  6. `rebuildInstanceChainIndex(pool: ElementPool): MutableInstanceChainIndex` -- rebuild the index from scratch by scanning all elements for non-null predecessors (SPEC 5.5 note: "can be rebuilt by following predecessor links").

  Edge cases:
  - Adding instance to an element that has no existing chain: creates a new chain of length 2 (original + new).
  - Adding instance with wrong predecessor hash: throw `INVALID_INSTANCE_CHAIN`.
  - Adding instance with different element type: throw `INVALID_INSTANCE_CHAIN`.
  - Chain with divergent heads (merge scenario, Decision 6): both heads kept as sibling entries.

  Type for mutable index: `type MutableInstanceChainIndex = Map<ContentHash, InstanceChainEntry>`.

- **Acceptance Criteria:**
  1. Adding an instance creates a chain of length 2; the original and new instance both map to the same `InstanceChainEntry`.
  2. `selectInstance` with `latest` returns the head; `original` returns the tail.
  3. `by-kind` with a missing kind falls back to the fallback strategy.
  4. `resolveElement` with instance chain returns the selected instance; without chain returns the direct element.
  5. `validateInstanceChain` detects: wrong type, missing element, cycle, hash mismatch.
  6. `rebuildInstanceChainIndex` produces the same index as incremental construction.

---

## Layer 2 -- Algorithms (Depends on Layer 1)

### WU-06: Deconstruction (ITokenJson to DAG)

- **ID:** WU-06
- **Name:** Token Deconstruction Algorithm
- **File(s):** `/home/vrogojin/uxf/uxf/deconstruct.ts`
- **Dependencies:** WU-01, WU-02, WU-03, WU-04
- **Parallel Group:** PG-2
- **Estimated Complexity:** L
- **Description:**

  Implement the deconstruction algorithm per ARCHITECTURE Section 4 and SPECIFICATION Section 8.

  The input type is `ITokenJson` from `@unicitylabs/state-transition-sdk`. However, because the SDK type may not be directly importable (it is an external dependency), the implementation should also accept the structurally equivalent `TxfToken`-like shape from `types/txf.ts` after conversion. The primary input remains `ITokenJson`.

  **Important structural difference:** `ITokenJson` uses `genesis.destinationState` (the post-genesis TokenState), while `TxfTransaction` uses `previousStateHash`/`newStateHash` (derived hash strings) and `predicate` (string). The deconstruction must handle both structural representations -- see the TxfToken adapter (WU-15).

  For the canonical `ITokenJson` path, the decomposition follows ARCH 4.1 exactly:

  Functions to implement:

  1. `deconstructToken(pool: ElementPool, token: ITokenJson): ContentHash` -- main entry point (ARCH 4.3). Recursively deconstructs genesis, transactions[], state, nametags[]. Returns the content hash of the token-root element.

  2. `deconstructGenesis(pool: ElementPool, genesis): ContentHash` -- deconstructs:
     - `genesis.data` -> `genesis-data` element (leaf). Fields: tokenId, tokenType, coinData (as `[string, string][]`), tokenData, salt, recipient, recipientDataHash, reason.
     - `genesis.inclusionProof` -> via `deconstructInclusionProof()`.
     - `genesis.destinationState` -> `token-state` element (leaf). This is the post-genesis state.
     - Builds `genesis` element with children refs to all three.

  3. `deconstructInclusionProof(pool: ElementPool, proof): ContentHash` -- deconstructs:
     - `proof.authenticator` -> `authenticator` element (leaf). Fields: algorithm, publicKey, signature, stateHash.
     - `proof.merkleTreePath` -> `smt-path` element (leaf). Fields: root, segments (inline `[data, path]` tuples from `steps[]`). Per Decision 5, segments are NOT separate elements.
     - `proof.unicityCertificate` -> `unicity-certificate` element (leaf). Field: raw (the hex-encoded CBOR blob, stored opaquely).
     - `proof.transactionHash` -> inline in inclusion-proof content.
     - Builds `inclusion-proof` element with 3 child refs + transactionHash content.

  4. `deconstructTransaction(pool: ElementPool, tx): ContentHash` -- deconstructs:
     - `tx.sourceState` -> `token-state` element.
     - `tx.data` -> `transaction-data` element (if present and non-empty). Content: `{ fields: tx.data }`.
     - `tx.inclusionProof` -> via `deconstructInclusionProof()` (if non-null).
     - `tx.destinationState` -> `token-state` element.
     - Builds `transaction` element. `data` and `inclusionProof` children are `null` for uncommitted transactions (SPEC 2.2.3).

  5. `deconstructState(pool: ElementPool, state): ContentHash` -- creates `token-state` element with `{ data, predicate }` content.

  6. `makeHeader(overrides?)` -- helper creating default header: `{ representation: 1, semantics: 1, kind: 'default', predecessor: null }`.

  Nametag handling (Decision 1): `token.nametags` in `ITokenJson` is `Token[]` (recursive token objects). Each nametag is fully deconstructed via recursive `deconstructToken()` call. This is the primary nametag dedup mechanism.

  Edge cases:
  - Token with zero transactions: `transactions` child is `[]` (empty array).
  - Token with no nametags: `nametags` child is `[]`.
  - Uncommitted transaction: `data: null`, `inclusionProof: null` in children.
  - `genesis.data.recipientDataHash` may be null.
  - `genesis.data.reason` may be null.
  - `state.data` may be empty string `""`.

- **Acceptance Criteria:**
  1. Deconstructing a token with 1 genesis + 2 transfers produces ~22 elements (per SPEC 10.1).
  2. Deconstructing the same token twice adds zero new elements (dedup).
  3. Two tokens sharing a unicity certificate round produce a shared certificate element.
  4. Nametag tokens are recursively deconstructed.
  5. Uncommitted transactions have null data/proof children.
  6. The returned hash is the content hash of the token-root element.

---

### WU-07: Reassembly (DAG to ITokenJson)

- **ID:** WU-07
- **Name:** Token Reassembly Algorithm
- **File(s):** `/home/vrogojin/uxf/uxf/assemble.ts`
- **Dependencies:** WU-01, WU-02, WU-03, WU-04, WU-05
- **Parallel Group:** PG-2
- **Estimated Complexity:** L
- **Description:**

  Implement reassembly per ARCHITECTURE Section 5 and SPECIFICATION Section 9.

  Functions to implement:

  1. `assembleToken(pool, manifest, tokenId, instanceChains, strategy?): ITokenJson` -- main entry (ARCH 5.1). Looks up root hash from manifest, resolves via `resolveElement()`, recursively reassembles all children.

  2. `assembleTokenFromRoot(pool, rootHash, instanceChains, strategy?): ITokenJson` -- same logic but takes a root hash directly. Used for nametag sub-DAGs that may not be in the manifest (ARCH 5.1).

  3. `assembleTokenAtState(pool, manifest, tokenId, stateIndex, instanceChains, strategy?): ITokenJson` -- historical state reassembly (ARCH 5.2, SPEC 9.3). stateIndex=0 means genesis only; stateIndex=N means genesis + first N transactions. State is the destination state of the Nth transaction (or genesis destination if N=0).

  4. Internal helpers:
     - `assembleGenesis(pool, genesisElement, instanceChains, strategy)` -- resolves genesis-data, inclusion-proof, destination-state children.
     - `assembleTransaction(pool, txElement, instanceChains, strategy)` -- resolves source-state, data, inclusion-proof, destination-state children.
     - `assembleInclusionProof(pool, proofElement, instanceChains, strategy)` -- resolves authenticator, smt-path, unicity-certificate children.
     - `assertType(element, expectedType)` -- throws `TYPE_MISMATCH` if wrong type.

  Integrity checks (Decision 7, SPEC 9.5):
  - Every element fetched from the pool is re-hashed with `computeElementHash()` and compared against the expected content hash. Mismatch throws `VERIFICATION_FAILED`.

  Cycle detection (Decision 8):
  - Maintain a `Set<ContentHash>` of visited hashes during reassembly. If a hash is visited twice, throw `CYCLE_DETECTED`.

  Instance selection:
  - All `resolveElement()` calls pass through the instance chain index and strategy (ARCH 3.3, SPEC 9.2).

  Output format:
  - Must produce a valid `ITokenJson` that is semantically identical to the original (SPEC 9.4).
  - `version` comes from token-root content.
  - `nametags` is the recursively reassembled array of `ITokenJson` (or `undefined` if empty).

  Edge cases:
  - Token with zero transactions: `transactions` array is `[]`.
  - Token with no nametags: `nametags` is `undefined` (not empty array).
  - Uncommitted transaction: `data` and `inclusionProof` are null in the reassembled transaction.
  - `stateIndex` = 0: state comes from genesis destination state.
  - `stateIndex` > transaction count: throw `STATE_INDEX_OUT_OF_RANGE`.

- **Acceptance Criteria:**
  1. Round-trip: `assemble(deconstruct(token))` produces output semantically identical to the original.
  2. `assembleTokenAtState(tokenId, 0)` returns genesis-only token.
  3. `assembleTokenAtState(tokenId, N)` returns token with first N transactions.
  4. Corrupted element (content hash mismatch) throws `VERIFICATION_FAILED`.
  5. DAG cycle throws `CYCLE_DETECTED`.
  6. Missing element throws `MISSING_ELEMENT`.
  7. Wrong element type throws `TYPE_MISMATCH`.

---

## Layer 3 -- Package Operations (Depends on Layer 2)

### WU-08: UxfPackage Class

- **ID:** WU-08
- **Name:** UxfPackage Class Implementation
- **File(s):** `/home/vrogojin/uxf/uxf/UxfPackage.ts`
- **Dependencies:** WU-01 through WU-07
- **Parallel Group:** PG-3
- **Estimated Complexity:** L
- **Description:**

  Implement the `UxfPackage` class per ARCHITECTURE Section 8.1. This is the primary public interface wrapping `UxfPackageData`.

  Static constructors:
  - `create(options?)` -- new empty package with default envelope.
  - `fromJson(json)` -- deserialize from JSON (delegates to `packageFromJson()`).
  - `fromCar(car)` -- deserialize from CAR bytes (delegates to `importFromCar()`).
  - `open(storage)` -- load from `UxfStorageAdapter`.

  Ingestion methods:
  - `ingest(token: ITokenJson)` -- calls `deconstructToken()`, updates manifest with tokenId -> root hash, updates secondary indexes (byTokenType, byCoinId, byStateHash). Extracts tokenType from genesis data for indexing (ARCH 2.5 note). Updates `envelope.updatedAt`.
  - `ingestAll(tokens)` -- batch version of `ingest()`.

  Reassembly methods:
  - `assemble(tokenId, strategy?)` -- delegates to `assembleToken()`.
  - `assembleAtState(tokenId, stateIndex, strategy?)` -- delegates to `assembleTokenAtState()`.
  - `assembleAll(strategy?)` -- assembles all manifest tokens into a `Map<string, ITokenJson>`.

  Token management:
  - `removeToken(tokenId)` -- removes from manifest and indexes. Does NOT gc. Returns `this`.
  - `tokenIds()` -- list all token IDs.
  - `hasToken(tokenId)` -- check manifest.
  - `transactionCount(tokenId)` -- resolve root, return `children.transactions.length`.

  Instance chains:
  - `addInstance(originalHash, newInstance)` -- delegates to instance-chain module.
  - `consolidateProofs(tokenId, txRange)` -- throws `NOT_IMPLEMENTED` (Decision 9).

  Package operations:
  - `merge(other)` -- merge another package's elements and manifest into this one. For each element in `other.pool`, add to this pool (dedup by hash). For manifest collisions, other's entry wins. Merge instance chain indexes (Decision 6: prefix detection, sibling heads for divergent chains). Rebuild secondary indexes. Returns `this`.
  - `gc()` -- mark-and-sweep from manifest roots (ARCH 3.4, Decision 11). Walk all reachable elements from every manifest root; delete unreachable. Prune orphaned instance chain entries. Returns count removed.

  Query methods:
  - `filterTokens(predicate)` -- iterate manifest, resolve root elements, apply predicate.
  - `tokensByCoinId(coinId)` -- lookup in `indexes.byCoinId`.
  - `tokensByTokenType(tokenType)` -- lookup in `indexes.byTokenType`.

  Serialization:
  - `toJson()` -- delegates to `packageToJson()`.
  - `toCar()` -- delegates to `exportToCar()`.
  - `save(storage)` -- delegates to `storage.save(this.data)`.

  Statistics:
  - `tokenCount`, `elementCount`, `estimatedSize`, `packageData` getters.

  Free functions (ARCH 8.2):
  - Export all operations as standalone functions that operate on `UxfPackageData` directly: `ingest()`, `ingestAll()`, `assemble()`, `assembleAtState()`, `removeToken()`, `merge()`, `diff()`, `applyDelta()`, `verify()`, `addInstance()`, `consolidateProofs()`, `collectGarbage()`.

  Secondary index maintenance:
  - On `ingest()`: extract `tokenType` from genesis-data element content, extract `coinId` from genesis-data `coinData[0][0]`, extract current state hash from the state element. Populate `byTokenType`, `byCoinId`, `byStateHash`.
  - On `removeToken()`: remove from all indexes.
  - On `merge()`: rebuild indexes from scratch (simplest correct approach).

- **Acceptance Criteria:**
  1. `UxfPackage.create()` produces an empty package with valid envelope.
  2. `pkg.ingest(token); pkg.assemble(tokenId)` round-trips correctly.
  3. `pkg.ingestAll([t1, t2])` adds both tokens; shared elements are deduped.
  4. `pkg.removeToken(id); pkg.gc()` removes orphaned elements.
  5. `pkg.merge(other)` combines manifests and pools; dedup works.
  6. `pkg.tokensByCoinId('UCT')` returns correct token IDs after ingestion.
  7. `pkg.consolidateProofs()` throws `NOT_IMPLEMENTED`.
  8. `pkg.toJson()` and `UxfPackage.fromJson()` round-trip.

---

### WU-09: Verification

- **ID:** WU-09
- **Name:** Package Verification
- **File(s):** `/home/vrogojin/uxf/uxf/verify.ts`
- **Dependencies:** WU-01, WU-02, WU-03, WU-04, WU-05
- **Parallel Group:** PG-3
- **Estimated Complexity:** M
- **Description:**

  Implement `verify()` per ARCHITECTURE Section 8.4 and SPECIFICATION Section 7.3.

  `verify(pkg: UxfPackageData): UxfVerificationResult`

  Checks performed:

  1. **Manifest root existence:** Every token in the manifest must have a root hash that exists in the pool. Missing root -> error.

  2. **Child reference resolution:** Starting from each manifest root, BFS/DFS walk all child references. Every referenced hash must exist in the pool. Missing child -> error.

  3. **Content hash integrity (Decision 7):** For every element in the pool, re-compute `computeElementHash(element)` and compare against its stored key. Mismatch -> error.

  4. **Element type consistency:** During DAG walk, validate that child references point to elements of the expected type (e.g., `genesis` child of token-root must be a `genesis` element). Mismatch -> error.

  5. **Instance chain validation (SPEC 7.3):** For every chain in the index: all elements share the same type, linear sequence (no cycles), tail has null predecessor, all elements present in pool, content hashes match. Violations -> error.

  6. **Cycle detection (Decision 8):** During DAG walk, track visited hashes. If a hash is visited twice within the same token's subgraph -> error.

  7. **Orphaned elements:** Count elements in the pool that are not reachable from any manifest root. Report as warning (not error) -- orphans are valid but indicate GC opportunity.

  8. **Divergent instance chains (Decision 6):** Chains with multiple heads reported as warnings.

  Return value: `UxfVerificationResult` with `valid` (true if zero errors), `errors[]`, `warnings[]`, `stats`.

- **Acceptance Criteria:**
  1. A freshly ingested package verifies as valid.
  2. Corrupting an element's content (post-insertion) causes `VERIFICATION_FAILED` error.
  3. Removing an element that is referenced produces `MISSING_ELEMENT` error.
  4. Invalid instance chain (wrong type) produces `INVALID_INSTANCE_CHAIN` error.
  5. Orphaned elements are reported as warnings with count.
  6. Stats accurately report `tokensChecked`, `elementsChecked`, `orphanedElements`, `instanceChainsChecked`.

---

### WU-10: Diff and Delta Operations

- **ID:** WU-10
- **Name:** Package Diff and Delta
- **File(s):** `/home/vrogojin/uxf/uxf/diff.ts`
- **Dependencies:** WU-01, WU-02, WU-04
- **Parallel Group:** PG-3
- **Estimated Complexity:** M
- **Description:**

  Implement diff and delta operations per ARCHITECTURE Section 8.5.

  Functions:

  1. `diff(source: UxfPackageData, target: UxfPackageData): UxfDelta` -- compute the minimal delta to transform `source` into `target`.
     - `addedElements`: elements in target pool but not in source pool (by hash).
     - `removedElements`: element hashes in source pool but not in target pool.
     - `addedTokens`: manifest entries in target but not in source, or changed (different root hash).
     - `removedTokens`: token IDs in source manifest but not in target.
     - `addedChainEntries`: instance chain entries in target but not in source.

  2. `applyDelta(pkg: UxfPackageData, delta: UxfDelta): void` -- apply a delta to a package.
     - Add all `addedElements` to the pool.
     - Remove all `removedElements` from the pool.
     - Update manifest: add `addedTokens`, remove `removedTokens`.
     - Add `addedChainEntries` to instance chain index.
     - Rebuild secondary indexes.

  Edge cases:
  - Applying a delta to a package that has diverged from the source: addedElements that already exist are no-ops; removedElements that don't exist are no-ops.
  - Empty delta: no changes applied.

- **Acceptance Criteria:**
  1. `diff(A, B)` followed by `applyDelta(A, delta)` makes A equivalent to B.
  2. `diff(A, A)` produces an empty delta.
  3. `diff(empty, B)` produces a delta with all of B's elements and manifest entries.
  4. Delta correctly handles manifest entry changes (same tokenId, different root hash).

---

## Layer 4 -- Serialization (Depends on Layer 1, Partially Parallel with Layers 2-3)

### WU-11: JSON Serialization

- **ID:** WU-11
- **Name:** JSON Package Serialization
- **File(s):** `/home/vrogojin/uxf/uxf/json.ts`
- **Dependencies:** WU-01, WU-02, WU-04, WU-05
- **Parallel Group:** PG-4 (can start as soon as Layer 1 is done)
- **Estimated Complexity:** M
- **Description:**

  Implement JSON serialization per ARCHITECTURE Section 6.2 and SPECIFICATION Sections 5.8, 6b.

  Functions:

  1. `packageToJson(pkg: UxfPackageData): string` -- serialize the full package.

     JSON structure (SPEC 5.8):
     ```json
     {
       "uxf": "1.0.0",
       "metadata": { "version", "createdAt", "updatedAt", "creator?", "description?", "elementCount", "tokenCount" },
       "manifest": { "<tokenId>": "<rootHash>", ... },
       "instanceChainIndex": { "<hash>": { "head": "<hash>", "chain": [...] }, ... },
       "indexes": { "byTokenType": {...}, "byCoinId": {...}, "byStateHash": {...} },
       "elements": { "<hash>": { "header": {...}, "type": <int>, "content": {...}, "children": {...} }, ... }
     }
     ```

     Conventions (SPEC 6b.1):
     - Binary fields: lowercase hex strings.
     - Content hashes: 64-char lowercase hex.
     - `type` field in elements: integer type ID (SPEC 2.1), NOT string tag.
     - Null values: JSON `null`.
     - Empty arrays: `[]`.
     - Field names: camelCase.
     - Map types (`ReadonlyMap`) serialized as plain objects.
     - Set types (`ReadonlySet`) serialized as arrays.

  2. `packageFromJson(json: string): UxfPackageData` -- deserialize.
     - Validate the `"uxf"` version field.
     - Parse manifest into `Map<string, ContentHash>`.
     - Parse elements, converting integer type IDs back to string tags.
     - Parse instance chain index.
     - Parse secondary indexes.
     - Validate all content hashes are well-formed.

  Edge cases:
  - Unknown element types in JSON: preserve as-is (forward compatibility).
  - Missing optional fields (`creator`, `description`): default to undefined.
  - `indexes` field absent: reconstruct empty indexes.

- **Acceptance Criteria:**
  1. `packageFromJson(packageToJson(pkg))` produces equivalent package data.
  2. Output is valid JSON matching SPEC 5.8 structure.
  3. All hashes in output are 64-char lowercase hex.
  4. Element type in JSON is integer, not string.
  5. Deserializing invalid JSON throws `SERIALIZATION_ERROR`.
  6. Deserializing JSON with malformed hashes throws `INVALID_HASH`.

---

### WU-12: IPLD/CAR Serialization

- **ID:** WU-12
- **Name:** IPLD Block and CAR File Export/Import
- **File(s):** `/home/vrogojin/uxf/uxf/ipld.ts`
- **Dependencies:** WU-01, WU-02, WU-03, WU-04, WU-05
- **Parallel Group:** PG-4
- **Estimated Complexity:** L
- **Description:**

  Implement IPLD/CAR serialization per ARCHITECTURE Section 6.3-6.4 and SPECIFICATION Section 6c.

  New dependencies to add:
  - `@ipld/dag-cbor` (v9.x) -- deterministic CBOR encoding with CID link support.
  - `@ipld/car` (v5.x) -- CARv1 encoding/decoding.
  - `multiformats` (already in optional/peer deps) -- CID construction.

  Functions:

  1. `computeCid(element: UxfElement): CID` -- compute CIDv1 for an element.
     - Codec: dag-cbor (0x71).
     - Hash: sha2-256 (0x12).
     - CID version: 1.
     - The CID's multihash digest is identical to the UXF content hash (SPEC 6c.1).

  2. `contentHashToCid(hash: ContentHash): CID` -- convert a content hash to a CID without re-encoding the element (optimization for CAR export when the hash is already known).

  3. `cidToContentHash(cid: CID): ContentHash` -- extract the SHA-256 digest from a CID and return as a ContentHash.

  4. `elementToIpldBlock(element: UxfElement, hash: ContentHash): { cid: CID; bytes: Uint8Array }` -- encode an element as an IPLD block.
     - The block data is dag-cbor encoding of `{ header, type, content, children }`.
     - Child references are encoded as CID links (CBOR Tag 42) per SPEC 6c.2, NOT raw hash bytes. This is the key difference from the hash computation form.

  5. `exportToCar(pkg: UxfPackageData): Uint8Array` -- export full package as CARv1.
     - CAR root: CID of the package envelope block (SPEC 6c.3).
     - Package envelope block: dag-cbor encoded `{ version, createdAt, updatedAt, manifest: { tokenId: CID, ... }, ... }` with CID links for manifest values.
     - Block ordering (SPEC 6c.4): envelope first, then token roots in manifest order, then remaining elements in BFS traversal. Shared elements appear once at first reference.

  6. `importFromCar(car: Uint8Array): UxfPackageData` -- import from CARv1.
     - Read root CID, decode envelope.
     - Iterate blocks, decode each as an element, verify CID matches content hash.
     - Reconstruct manifest, pool, instance chain index.
     - Rebuild secondary indexes.

  Edge cases:
  - CID version mismatch: only CIDv1 with dag-cbor codec is accepted.
  - Block with CID that doesn't match re-computed hash: throw `VERIFICATION_FAILED`.
  - CAR with no root: throw `INVALID_PACKAGE`.
  - Large packages: CAR encoding is streaming-friendly by design.

- **Acceptance Criteria:**
  1. `importFromCar(exportToCar(pkg))` round-trips to equivalent package data.
  2. CID digest matches content hash for every element.
  3. CAR root is the envelope CID.
  4. Block order: envelope first, then BFS from token roots.
  5. Child references in IPLD blocks use CID links (Tag 42), not raw hashes.
  6. The exported CAR is valid per CARv1 spec (verifiable with `go-car` or `@ipld/car` reader).

---

## Layer 5 -- Integration (Depends on All Above)

### WU-13: Barrel Exports and Index

- **ID:** WU-13
- **Name:** UXF Module Barrel Exports
- **File(s):**
  - `/home/vrogojin/uxf/uxf/index.ts` (create)
  - `/home/vrogojin/uxf/uxf/storage-adapters.ts` (create)
- **Dependencies:** WU-01 through WU-12
- **Parallel Group:** PG-5
- **Estimated Complexity:** S
- **Description:**

  Create the barrel export file per ARCHITECTURE Section 8.6. Also implement the two storage adapters per ARCHITECTURE Section 7.

  Storage adapters (`storage-adapters.ts`):
  1. `InMemoryUxfStorage` -- trivial in-memory adapter (ARCH 7.3).
  2. `KvUxfStorageAdapter` -- delegates to existing `StorageProvider` via JSON serialization (ARCH 7.4).

  Barrel exports (`index.ts`): re-export everything listed in ARCH 8.6:
  - Types (all from `./types`)
  - Constants (`STRATEGY_LATEST`, `STRATEGY_ORIGINAL`, `contentHash`)
  - Classes (`UxfPackage`, `ElementPool`, `UxfError`)
  - Functions (functional API from `./UxfPackage`)
  - Serialization (`packageToJson`, `packageFromJson`, `exportToCar`, `importFromCar`, `computeCid`, `elementToIpldBlock`, `computeElementHash`)
  - Storage adapters
  - Advanced exports (`deconstructToken`, `assembleToken`, `assembleTokenFromRoot`, `assembleTokenAtState`)

- **Acceptance Criteria:**
  1. `import { UxfPackage } from './uxf'` resolves.
  2. All public types are importable.
  3. `InMemoryUxfStorage` save/load/clear works.
  4. `KvUxfStorageAdapter` delegates correctly to a mock `StorageProvider`.

---

### WU-14: Build Configuration

- **ID:** WU-14
- **Name:** tsup and package.json Configuration
- **File(s):**
  - `/home/vrogojin/uxf/tsup.config.ts` (modify)
  - `/home/vrogojin/uxf/package.json` (modify)
- **Dependencies:** WU-13
- **Parallel Group:** PG-5
- **Estimated Complexity:** S
- **Description:**

  Add UXF as a new tsup entry point per ARCHITECTURE Section 1.2.

  `tsup.config.ts` -- add a new entry:
  ```typescript
  {
    entry: { 'uxf/index': 'uxf/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    platform: 'neutral',
    target: 'es2022',
    external: [
      /^@unicitylabs\//,
      '@ipld/dag-cbor',
      '@ipld/car',
      'multiformats',
    ],
  }
  ```

  `package.json` -- add:
  1. New `exports` entry:
     ```json
     "./uxf": {
       "import": { "types": "./dist/uxf/index.d.ts", "default": "./dist/uxf/index.js" },
       "require": { "types": "./dist/uxf/index.d.cts", "default": "./dist/uxf/index.cjs" }
     }
     ```
  2. New dependencies:
     - `@ipld/dag-cbor`: `^9.2.5` (runtime dependency for deterministic CBOR)
     - `@ipld/car`: `^5.4.2` (runtime dependency for CAR export/import, could be optional)
     - `multiformats` is already in optional/peer deps -- move to regular dependencies since UXF needs it at runtime.

  `index.ts` (main barrel) -- add UXF re-exports per ARCHITECTURE Section 8.7. Types-only re-export for the main barrel to avoid pulling IPLD deps into non-UXF consumers:
  ```typescript
  export type { ContentHash, UxfElementHeader, ... } from './uxf';
  export { UxfPackage, UxfError, ... } from './uxf';
  ```

- **Acceptance Criteria:**
  1. `npm run build` succeeds without errors.
  2. `dist/uxf/index.js`, `dist/uxf/index.cjs`, `dist/uxf/index.d.ts` are generated.
  3. `import { UxfPackage } from '@unicitylabs/sphere-sdk/uxf'` resolves in both ESM and CJS.
  4. Main barrel `import { UxfPackage } from '@unicitylabs/sphere-sdk'` also resolves.
  5. `npm run typecheck` passes.

---

### WU-15: TxfToken Adapter

- **ID:** WU-15
- **Name:** TxfToken to ITokenJson Adapter
- **File(s):** `/home/vrogojin/uxf/uxf/txf-adapter.ts`
- **Dependencies:** WU-01, WU-06
- **Parallel Group:** PG-5
- **Estimated Complexity:** M
- **Description:**

  Implement the thin adapter converting sphere-sdk's `TxfToken` to the canonical `ITokenJson` form, per Decision 1 and ARCHITECTURE Section 1.3.

  The key structural differences between `TxfToken` and `ITokenJson`:

  | Field | TxfToken | ITokenJson |
  |-------|----------|------------|
  | `nametags` | `string[]` (name strings) | `Token[]` (recursive token objects) |
  | `genesis.destinationState` | not present | `TokenState` (post-genesis state) |
  | `transactions[n].sourceState` | not present (derived from `previousStateHash`) | `TokenState` |
  | `transactions[n].destinationState` | not present (derived from `newStateHash`) | `TokenState` |
  | `transactions[n].predicate` | inline string | part of destination state |

  Function: `txfTokenToITokenJson(token: TxfToken, nametagTokens?: Map<string, ITokenJson>): ITokenJson`

  Implementation:
  1. Map genesis fields directly (structure is compatible).
  2. Derive `genesis.destinationState` from the first transaction's `previousStateHash` or from `token.state` if no transactions.
  3. For each transaction, derive `sourceState` and `destinationState` from `previousStateHash`/`newStateHash` and `predicate`.
  4. For nametags: if `nametagTokens` map is provided, look up each nametag string to get the full token object. If not provided, nametags are omitted (they cannot be reconstructed from strings alone).

  Also provide the reverse: `iTokenJsonToTxfToken(token: ITokenJson): TxfToken` for re-export to sphere-sdk format.

  Edge cases:
  - TxfToken with empty nametags array: produces ITokenJson with no nametags.
  - TxfToken with nametag strings but no `nametagTokens` map: nametags are `undefined` in output.
  - Transaction without `newStateHash` (uncommitted): destination state uses predicate only.

- **Acceptance Criteria:**
  1. Adapter converts a valid `TxfToken` to a valid `ITokenJson` (with nametag tokens provided).
  2. Adapter converts back from `ITokenJson` to `TxfToken`.
  3. Fields map correctly per the table above.
  4. Missing nametag tokens are handled gracefully.

---

## Layer 6 -- Tests (Depends on All Above)

### WU-16: Unit Tests

- **ID:** WU-16
- **Name:** Comprehensive Unit Test Suite
- **File(s):**
  - `/home/vrogojin/uxf/tests/unit/uxf/types.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/errors.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/hash.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/element-pool.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/instance-chain.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/deconstruct.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/assemble.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/UxfPackage.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/verify.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/diff.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/json.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/ipld.test.ts`
  - `/home/vrogojin/uxf/tests/unit/uxf/txf-adapter.test.ts`
- **Dependencies:** WU-01 through WU-15
- **Parallel Group:** PG-6 (individual test files can be written in parallel with their corresponding WU)
- **Estimated Complexity:** L
- **Description:**

  Write unit tests using Vitest (project standard). Each test file corresponds to a source module.

  Test fixtures:
  - Create a shared `tests/unit/uxf/fixtures.ts` with:
    - A minimal valid `ITokenJson` (1 genesis, 0 transfers).
    - A standard `ITokenJson` (1 genesis, 2 transfers, per SPEC 10.1).
    - Two tokens sharing a unicity certificate (per SPEC 10.2).
    - A token with nametag sub-DAGs.
    - A `TxfToken` for adapter tests.

  Test categories per module:

  **types.test.ts:** `contentHash()` validation (valid, uppercase, short, non-hex).

  **errors.test.ts:** Error construction, message format, instanceof.

  **hash.test.ts:** Determinism, field sensitivity, null handling, empty maps, type ID mapping.

  **element-pool.test.ts:** Put/get/has/delete, dedup, iteration, size.

  **instance-chain.test.ts:** Chain creation, selection strategies (all 5), validation, rebuild, divergent chains.

  **deconstruct.test.ts:** Element count per SPEC 10.1, dedup across tokens (SPEC 10.2), nametag recursion, uncommitted transactions, null fields.

  **assemble.test.ts:** Round-trip fidelity, historical state, cycle detection, hash integrity, missing element, type mismatch, nametag reassembly.

  **UxfPackage.test.ts:** Create/ingest/assemble, batch operations, removeToken+gc, merge, indexes, consolidateProofs throws, statistics.

  **verify.test.ts:** Valid package, corrupted element, missing element, invalid chain, orphan detection, cycle detection.

  **diff.test.ts:** Diff identity, diff empty-to-full, applyDelta roundtrip, manifest changes.

  **json.test.ts:** Roundtrip, format compliance (integer types, hex hashes), malformed input.

  **ipld.test.ts:** CID computation, CID-hash equivalence, CAR roundtrip, block ordering, Tag 42 links.

  **txf-adapter.test.ts:** TxfToken -> ITokenJson conversion, reverse conversion, nametag handling.

- **Acceptance Criteria:**
  1. All tests pass with `npm run test:run`.
  2. Test coverage of all error paths and edge cases listed above.
  3. Round-trip tests verify semantic equivalence (not byte-for-byte, since field ordering may differ).
  4. SPEC 10.1 worked example is reproduced: 22 elements for a 3-state token.
  5. SPEC 10.2 worked example: two tokens sharing a certificate have shared element count.

---

### WU-17: Integration Tests

- **ID:** WU-17
- **Name:** End-to-End Integration Tests
- **File(s):** `/home/vrogojin/uxf/tests/integration/uxf-integration.test.ts`
- **Dependencies:** WU-01 through WU-15
- **Parallel Group:** PG-6
- **Estimated Complexity:** M
- **Description:**

  Integration tests that exercise the full UXF pipeline with realistic data.

  Scenarios:
  1. **Full lifecycle:** Create package -> ingest 10 tokens -> assemble all -> verify -> toJson -> fromJson -> verify -> assemble all -> compare with originals.
  2. **CAR roundtrip:** Create package -> ingest tokens -> toCar -> fromCar -> verify -> assemble all -> compare.
  3. **Merge workflow:** Create two packages from overlapping token sets -> merge -> verify -> assert dedup savings.
  4. **Diff/apply workflow:** Package A -> add tokens -> Package B. Compute diff(A, B). Apply delta to fresh copy of A. Verify equivalence with B.
  5. **Instance chain workflow:** Ingest token -> add consolidated proof instance -> assemble with latest (gets consolidated) -> assemble with original (gets individual).
  6. **GC workflow:** Ingest 5 tokens -> remove 3 -> gc -> verify pool size decreased -> remaining 2 tokens still assemble correctly.
  7. **Storage adapter:** Use `InMemoryUxfStorage` and `KvUxfStorageAdapter` to save/load packages.
  8. **Large token set:** Ingest 100 tokens with shared certificates -> verify dedup ratio matches expected (~50% element reduction, per Decision 5 estimates).

  Test data generation:
  - Use the existing `@unicitylabs/state-transition-sdk` test utilities if available.
  - Otherwise, construct synthetic `ITokenJson` objects that match the format exactly.

- **Acceptance Criteria:**
  1. All integration tests pass.
  2. Full lifecycle test demonstrates zero data loss across all serialization roundtrips.
  3. Merge test demonstrates dedup savings (shared elements counted once).
  4. GC test demonstrates orphan removal without data loss for retained tokens.
  5. Large token set test completes within 5 seconds.

---

## Execution Schedule

| Phase | Parallel Group | Work Units | Dependencies | Est. Duration |
|-------|---------------|------------|--------------|---------------|
| 1 | PG-0 | WU-01, WU-02, WU-03 | None | 1 day |
| 2 | PG-1 | WU-04, WU-05 | PG-0 | 1 day |
| 3 | PG-2 + PG-4 | WU-06, WU-07, WU-11, WU-12 | PG-1 | 2 days |
| 4 | PG-3 | WU-08, WU-09, WU-10 | PG-2 | 2 days |
| 5 | PG-5 | WU-13, WU-14, WU-15 | PG-3 + PG-4 | 1 day |
| 6 | PG-6 | WU-16, WU-17 | PG-5 | 2 days |

**Critical path:** WU-01 -> WU-04 -> WU-06 -> WU-08 -> WU-13 -> WU-16

**Maximum parallelism:** Phase 3 runs 4 work units simultaneously (deconstruct, assemble, JSON serialization, IPLD/CAR).

---

## New Dependencies Summary

| Package | Version | Type | Purpose |
|---------|---------|------|---------|
| `@ipld/dag-cbor` | ^9.2.5 | runtime | Deterministic CBOR encoding (Decision 3) |
| `@ipld/car` | ^5.4.2 | runtime | CARv1 file format (Decision 4) |
| `multiformats` | ^13.4.2 | runtime (promote from optional) | CID construction, hashing |

---

## File Inventory

| File | WU | New/Modify | Purpose |
|------|-----|-----------|---------|
| `uxf/types.ts` | WU-01 | New | All type definitions |
| `uxf/errors.ts` | WU-02 | New | Error types |
| `uxf/hash.ts` | WU-03 | New | Content hashing |
| `uxf/element-pool.ts` | WU-04 | New | Element pool class |
| `uxf/instance-chain.ts` | WU-05 | New | Instance chain management |
| `uxf/deconstruct.ts` | WU-06 | New | Token deconstruction |
| `uxf/assemble.ts` | WU-07 | New | Token reassembly |
| `uxf/UxfPackage.ts` | WU-08 | New | Package class + free functions |
| `uxf/verify.ts` | WU-09 | New | Verification |
| `uxf/diff.ts` | WU-10 | New | Diff/delta operations |
| `uxf/json.ts` | WU-11 | New | JSON serialization |
| `uxf/ipld.ts` | WU-12 | New | IPLD/CAR serialization |
| `uxf/index.ts` | WU-13 | New | Barrel exports |
| `uxf/storage-adapters.ts` | WU-13 | New | Storage adapters |
| `uxf/txf-adapter.ts` | WU-15 | New | TxfToken adapter |
| `tsup.config.ts` | WU-14 | Modify | Add UXF entry point |
| `package.json` | WU-14 | Modify | Add exports + dependencies |
| `index.ts` | WU-14 | Modify | Add UXF re-exports |
| `tests/unit/uxf/*.test.ts` | WU-16 | New | Unit tests (13 files) |
| `tests/unit/uxf/fixtures.ts` | WU-16 | New | Shared test fixtures |
| `tests/integration/uxf-integration.test.ts` | WU-17 | New | Integration tests |

**Total new files:** 18 source + 14 test = 32 files
**Total modified files:** 3 (`tsup.config.ts`, `package.json`, `index.ts`)
