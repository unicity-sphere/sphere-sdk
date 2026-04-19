# Adversarial Architecture Review: UXF (Universal eXchange Format)

## 1. Architectural Risks

### FINDING 1.1 -- Nametag Representation Mismatch (CRITICAL)

**Observation:** The TASK.md states (line 55-56) that `nametags[]` in a token are "each ... itself a full Token -- recursive" and the DAG model assumes nametag tokens are full token sub-DAGs that can be shared. However, the actual `TxfToken` type at `/home/vrogojin/uxf/types/txf.ts` line 21 defines `nametags?: string[]` -- nametags are plain strings, not embedded token objects. The `NametagData` type (line 117-123) does contain a `token: object` field, but this lives in `TxfStorageData._nametags`, not inside `TxfToken.nametags`.

**Impact:** The entire nametag deduplication argument in TASK.md (Section "Key Deduplication Targets" item 2: "the same nametag token may appear in dozens of other tokens") is predicated on a data model that does not exist in the current codebase. Nametag tokens are not recursively embedded in `TxfToken`. This means one of the four claimed deduplication targets is phantom.

**Resolution:** Either (a) the TASK.md must be corrected to reflect the actual TxfToken structure, where nametags are string references, or (b) UXF must be designed against the `ITokenJson` format from `state-transition-sdk` (not TxfToken), which may have recursive nametag embedding. Clarify which source-of-truth token structure UXF operates on. If it is `ITokenJson`, provide its full type definition in the spec.

---

### FINDING 1.2 -- Instance Chain Branching is Undefined (CRITICAL)

**Observation:** The instance chain model (TASK.md lines 146-223) assumes a singly-linked chain (newest-to-oldest). But the spec never addresses what happens when two independent agents create alternative instances of the same element concurrently. For example: Agent A creates a consolidated proof referencing element X, and Agent B creates a ZK proof also referencing element X. Both claim to be the head of X's instance chain with X as their predecessor.

**Impact:** This creates a fork in the instance chain. The "instance chain index" (line 223) maps each element hash to "the head of its instance chain," but with two competing heads, the index is undefined. The `merge()` operation (line 281) must combine two packages, potentially with conflicting instance chain heads for the same element.

**Resolution:** Define a merge strategy for conflicting instance chains. Options: (a) instance chains become DAGs, not linear chains (but this breaks the "singly-linked" invariant); (b) define a deterministic ordering (e.g., by content hash) to pick a canonical head; (c) allow multiple heads and treat instance chains as a set rather than a list. This must be specified before implementation.

---

### FINDING 1.3 -- Garbage Collection with Shared Elements is NP-Hard Adjacent (MAJOR)

**Observation:** TASK.md scope item 1 mentions "garbage collection" for the element pool. Since elements are shared across tokens, removing a token requires reference counting or graph traversal to determine if each element is still referenced by another token. The spec does not define the GC algorithm.

**Impact:** Naive reference counting fails with instance chains (an instance may reference elements also referenced by other instance chains). Full graph traversal from all manifest roots on every `removeToken()` is O(total_elements * tokens), which is expensive. For a wallet with 1000 tokens averaging 50 elements each, that is 50,000 nodes to traverse per removal.

**Resolution:** Specify the GC algorithm explicitly. Options: (a) mark-and-sweep from all manifest roots (simple but slow); (b) reference counting with instance chain awareness; (c) lazy GC with periodic compaction (pragmatic for a wallet use case where pools are small). Note that the `removeToken` API returns `UxfPackage`, implying it produces a new package -- is the old package's pool left dirty?

---

### FINDING 1.4 -- Circular Reference Potential in DAG (MAJOR)

**Observation:** TASK.md line 69 states "An element from one token may contain (reference) subelements that belong to a different token -- this is natural and expected in the DAG model." Combined with the recursive nametag claim, consider: Token A references nametag Token B in its transaction. Token B is itself a full token in the manifest. If Token B's genesis references a unicity certificate that happens to be shared with Token A's inclusion proof, there is no true circularity (just shared leaves). However, the spec never explicitly forbids circular references at the element level, nor does it specify cycle detection during reassembly.

**Impact:** If a bug in deconstruction or a malicious element pool creates a cycle (element X references element Y which references element X), reassembly would infinite-loop. Since the spec claims reassembly is "recursive traversal," this is an unbounded recursion risk.

**Resolution:** Add an explicit invariant: "The element pool MUST be a DAG (no cycles). Reassembly implementations MUST track visited nodes and terminate with an error if a cycle is detected." Include this in the `verify()` operation.

---

### FINDING 1.5 -- Content-Addressing Overhead for Small Elements (MINOR)

**Observation:** TASK.md proposes that every node at every depth is independently content-hashed. For small elements like a `TxfAuthenticator` (4 string fields, ~200 bytes) or a `TxfState` (2 string fields, ~100 bytes), the overhead of a CID (36+ bytes for SHA-256 multihash + codec) plus the element header (`[repr, sem, kind, predecessor]`) may exceed 30-50% of the element's actual content.

**Impact:** For tokens with few shared elements (a solo user's wallet where every token has unique authenticators and states), UXF could be larger than raw TXF. The "Size efficiency" constraint (line 341) says UXF should be "significantly smaller" but this only holds when sharing is common.

**Resolution:** Define a threshold below which elements are inlined rather than stored as separate DAG nodes. For example, elements under 128 bytes could be embedded directly in their parent. This is standard practice in IPLD (inline CIDs for small blocks). Add a benchmark for the worst case (no sharing) to acceptance criteria.

---

## 2. Integration Concerns

### FINDING 2.1 -- TXF to UXF Migration Path is Absent (CRITICAL)

**Observation:** The existing codebase stores tokens as `TxfStorageData` (a flat JSON object keyed by `_<tokenId>` containing `TxfToken` objects). The IPFS storage provider uploads this as a single JSON blob. UXF proposes a fundamentally different storage model (DAG of content-addressed elements). TASK.md does not specify:
- How existing wallets migrate from TxfStorageData to UXF packages
- Whether UXF replaces `TxfStorageData` entirely or coexists
- Whether `TokenStorageProvider` interface changes
- Whether `IpfsStorageProvider` is modified or replaced

**Impact:** `PaymentsModule.ts` (the 88KB main consumer) calls `parseTxfStorageData()` and `buildTxfStorageData()` extensively. Every load/save cycle goes through these functions. Changing the storage format without a migration strategy risks breaking all existing wallets.

**Resolution:** Define three phases: (1) UXF as a library that can ingest/emit `ITokenJson`/`TxfToken`, independent of storage; (2) a new `UxfStorageProvider` implementing `TokenStorageProvider<TxfStorageDataBase>` that internally uses UXF but exposes the same interface; (3) migration logic that reads existing TxfStorageData and converts to UXF on first load. Phase 1 should be the MVP.

---

### FINDING 2.2 -- IPFS Integration Model Mismatch (MAJOR)

**Observation:** The existing IPFS integration (`/home/vrogojin/uxf/impl/shared/ipfs/`) uses a simple model: serialize entire `TxfStorageData` as JSON, upload as a single IPFS object, get a CID, publish via IPNS. It uses `FormData` with `api/v0/add` (line 151 of `ipfs-http-client.ts`). 

TASK.md proposes IPLD DAG nodes with CID-based links between elements. This requires `dag-cbor` codec, `dag-put` API calls, and CAR file exports -- none of which exist in the current HTTP client. The current client does not even import or use IPLD libraries.

**Impact:** The "IPFS/IPLD alignment" scope item implies the current IPFS integration is compatible. It is not. A new DAG-native client layer would be required, or the IPLD alignment becomes a future aspiration rather than an implementation target.

**Resolution:** Either (a) scope down Phase 1 to use IPFS as a dumb blob store (upload the UXF package as a single serialized object, like TXF does today) and add true IPLD DAG integration later; or (b) acknowledge that a new `IpldClient` class is needed alongside `IpfsHttpClient`, with `dag-cbor` encoding and per-node `dag/put` calls. Option (b) has significant performance implications (N HTTP calls for N nodes vs. 1 call for a blob).

---

### FINDING 2.3 -- Bundle Size Impact of IPLD Dependencies (MAJOR)

**Observation:** TASK.md scope item 4 lists "IPLD-compatible DAG export" and "CBOR and JSON serialization." This implies dependencies on `@ipld/dag-cbor`, `multiformats`, `@ipld/car`, and potentially `@ipld/dag-json`. The current `package.json` has none of these.

**Impact:** `@ipld/dag-cbor` + `multiformats` together add approximately 50-100KB minified to the browser bundle. The SDK already has `@noble/hashes` and `@noble/curves` as crypto dependencies. Adding IPLD stack could increase bundle size by 15-25%, which matters for the browser entry point. The tsup multi-entry-point build (noted in CLAUDE.md as causing singleton duplication issues) would duplicate these dependencies across bundles.

**Resolution:** Make IPLD dependencies optional/lazy-loaded. The core UXF deconstruction/reassembly should work with a pluggable hash function (SHA-256 from `@noble/hashes`, already present) and a minimal CID implementation. True IPLD export should be a separate entry point (`@unicitylabs/sphere-sdk/uxf/ipld`). This keeps the main bundle lean.

---

### FINDING 2.4 -- TxfToken vs ITokenJson Ambiguity (MAJOR)

**Observation:** TASK.md references both `ITokenJson` (from `state-transition-sdk`) and `TxfToken` (from sphere-sdk). These are different types with different structures. For example:
- `TxfToken.nametags` is `string[]`
- `ITokenJson.nametags` (per TASK.md line 55) is recursive token objects
- `TxfToken.transactions[].data` is `Record<string, unknown>`
- `ITokenJson` transactions have typed `MintTransactionData`/`TransferTransactionData`
- `TxfToken` has `_integrity` metadata not present in `ITokenJson`

The spec says UXF must "ingest and emit standard `ITokenJson` / CBOR v2.0 tokens" (line 337) but also references TXF structures throughout. The `ingest()` function takes `Token` (the sphere-sdk type), not `ITokenJson`.

**Resolution:** Define the canonical input/output types explicitly. If UXF operates on `ITokenJson` from state-transition-sdk, say so and define the mapping. If it operates on `TxfToken`, the nametag DAG claims are invalid. The API signatures in scope (lines 275-286) use `Token` which is the sphere-sdk UI type that contains `sdkData: string` (serialized JSON). This means `ingest` would need to parse `token.sdkData` to get the actual token structure -- adding another layer of indirection.

---

## 3. Specification Gaps

### FINDING 3.1 -- Element Taxonomy is Not Defined (CRITICAL)

**Observation:** TASK.md scope item 1 lists "Element taxonomy -- formal definition of each element type" but the body of the spec never actually defines it. We do not know:
- Which fields of `TxfGenesis` become separate elements vs. inline data?
- Is `TxfGenesisData` one element, or is `coinData` a separate element?
- Is each `TxfMerkleStep` a separate element, or is the entire `merkleTreePath` one element?
- Is `unicityCertificate` (a hex-encoded CBOR string in TxfToken) decoded and decomposed, or stored as an opaque blob?
- Is `TxfState` (predicate + data) one element or two?

**Impact:** Without this taxonomy, it is impossible to implement `ingest()` or evaluate deduplication effectiveness. The granularity of decomposition determines both the deduplication ratio and the overhead.

**Resolution:** Produce a complete element taxonomy table before implementation. For each element type: name, parent element, fields that are child references vs. inline data, expected size range, sharing likelihood. This is the single most important pre-implementation deliverable.

---

### FINDING 3.2 -- Pending Transactions and Outbox are Unaddressed (CRITICAL)

**Observation:** `TxfStorageData` contains `_outbox` (pending transfers), `_mintOutbox` (pending mints), `_tombstones` (spent markers), and `_sent` (completed transfers). These are wallet-operational metadata, not part of the token's cryptographic structure. TASK.md never mentions how these are represented in UXF.

The spec says UXF is a "packaging format for storing and exchanging Unicity token materials" but the actual storage format (`TxfStorageData`) is more than just tokens -- it is a complete wallet state snapshot. If UXF replaces `TxfStorageData` as the storage format, it must handle these fields. If UXF is only for exchange (not storage), the scope must be clarified.

**Impact:** The `PaymentsModule` depends on `_outbox` for tracking in-flight transfers and `_tombstones` for preventing double-spend. Without these in UXF, it cannot serve as a storage backend.

**Resolution:** Define whether UXF is: (a) a pure token exchange format (in which case operational metadata lives outside UXF and the "storage" use case requires a wrapper); or (b) a complete wallet state format (in which case _outbox, _tombstones, _mintOutbox, _nametags, _history must be part of the package envelope). The "Package Envelope (version, metadata)" in the diagram (line 76) needs to be specified.

---

### FINDING 3.3 -- Deterministic Serialization Rules are Unspecified (MAJOR)

**Observation:** Design constraint 4 (line 340) requires "identical logical content must produce identical byte sequences." This is essential for content-addressable storage. However, the spec does not define:
- CBOR canonical form (RFC 7049 Section 3.9, or RFC 8949 deterministic encoding?)
- JSON canonical form (key ordering? number formatting?)
- How hex strings are normalized (lowercase? uppercase? mixed allowed?)
- Whether the `unicityCertificate` field (already hex-encoded CBOR) is decoded and re-encoded deterministically, or kept as-is

The existing `normalizeSdkTokenToStorage()` function converts bytes to hex strings, but does not enforce key ordering or other deterministic properties.

**Resolution:** Choose a canonical encoding (RFC 8949 deterministic CBOR is recommended for new formats). Specify normalization rules for all string fields. Add a "canonicalize" step to `ingest()` that normalizes before hashing. Define whether hex-encoded opaque blobs (like `unicityCertificate`) are decoded or treated as raw bytes.

---

### FINDING 3.4 -- "Version" Semantics are Overloaded (MAJOR)

**Observation:** The versioning model defines four different version concepts:
1. Token-level version (e.g., `"2.0"`)
2. Representation version (encoding format, `repr` in header)
3. Semantic version (protocol rules, `sem` in header)  
4. TxfMeta.version (storage data version counter, incremented on merge)
5. TxfMeta.formatVersion (`"2.0"`)

The element header has `representation` and `semantics` as uints, but existing TxfToken uses `version: '2.0'` as a string. Are these the same versioning scheme? When TASK.md says "v1 semantics" vs "v2 semantics," does v1 correspond to the pre-existing format and v2 to UXF? This is never defined.

**Resolution:** Create a version mapping table. Define what semantic version 1 means concretely (which validation rules, which hash algorithm). Define the relationship between `TxfToken.version: '2.0'` and element-level `semantics: uint`. If semantic version 1 = everything that exists today, say so explicitly.

---

### FINDING 3.5 -- ZK Proof Substitution is Aspirational (MINOR)

**Observation:** TASK.md describes ZK proof substitution (lines 172-183) and includes it in acceptance criteria (criterion 13, line 362). However, no ZK proof system exists in the current codebase or dependencies. There is no `ZkProofVerifier`, no ZK circuit, and no ZK library in `package.json`. The acceptance criterion requires "a valid reassembled token under ZK verification."

**Impact:** This acceptance criterion is impossible to satisfy without building or integrating a ZK proof system, which is a major undertaking orthogonal to UXF format design.

**Resolution:** Move ZK proof substitution to "Future Work" or "Phase 2." The instance chain mechanism should support it by design (the architecture is sound), but the acceptance criterion should test instance chains with a mock alternative instance type, not actual ZK proofs.

---

### FINDING 3.6 -- Proof Consolidation Semantics are Undefined (MAJOR)

**Observation:** TASK.md describes "proof consolidation" where multiple individual unicity proofs are merged into "a single subtree of the aggregator's Sparse Merkle Tree" (line 159). The acceptance criterion (12) requires this to produce "a valid, smaller element." But:
- How is a consolidated SMT subtree constructed? This requires knowledge of the aggregator's tree structure.
- Is this an operation the client can perform locally, or does it require the aggregator?
- The current `InclusionProof` contains a `merkleTreePath` from leaf to root. A "consolidated" proof that covers multiple leaves would have a different structure -- what is it?

**Impact:** Without defining the consolidated proof format, `consolidateProofs()` cannot be implemented.

**Resolution:** Either (a) defer proof consolidation to Phase 2 with the aggregator team, or (b) define the consolidated proof format explicitly, including how multiple Merkle paths are merged into a shared subtree and what the verification algorithm is.

---

## 4. Performance Concerns

### FINDING 4.1 -- DAG Node Count Explosion (MAJOR)

**Observation:** Consider a wallet with 100 tokens, each with 5 transactions. Each transaction contains: `inclusionProof` (which contains `authenticator`, `merkleTreePath` with ~20 steps, `unicityCertificate`, `transactionHash`), `predicate`, `data`, `previousStateHash`, `newStateHash`. Plus genesis with similar structure, plus state.

Per token: ~1 (root) + 1 (genesis) + 1 (genesis data) + 1 (genesis proof) + 1 (authenticator) + 20 (merkle steps) + 1 (cert) + 5 * (1 tx + 1 proof + 1 auth + 20 steps + 1 cert) + 1 (state) = ~140 elements minimum per token. With 100 tokens: 14,000 elements. Even with 50% deduplication (optimistic): 7,000 unique elements.

Each element needs: content hash computation (SHA-256), CID encoding, pool lookup, header encoding. On `ingest()` of a single token with 5 transactions: ~140 hash computations and pool lookups.

**Impact:** For `assembleAll()` (not in API but implied by `getTokens()`): reassembling 100 tokens means 14,000 DAG traversals. If each traversal is a Map lookup (O(1)), this is fast in memory. But if the pool is persisted to IndexedDB (as implied by browser use), each lookup is an async IDB get. 14,000 async IDB reads would take seconds.

**Resolution:** Define storage tiers: (a) in-memory pool for active session (fast), (b) serialized pool for persistence (single read/write of entire pool, not per-element). The pool should never require per-element async IO. Add the node count estimate to benchmarks.

---

### FINDING 4.2 -- Streaming Reassembly is Infeasible with DAG Structure (MAJOR)

**Observation:** Design constraint 3 (line 339) requires "streaming-friendly -- it should be possible to begin extracting tokens before the entire package is downloaded." But a DAG-structured pool means a token's root may reference elements scattered throughout the serialized pool. Without downloading the entire element pool (or at least the index), you cannot know which elements belong to which token.

**Impact:** True streaming (process bytes as they arrive) is incompatible with a shared element pool unless elements are topologically sorted and preceded by a manifest. Even then, an element might be referenced by a token whose root hasn't been read yet.

**Resolution:** Redefine "streaming-friendly" to mean: (a) the manifest is at the beginning of the serialized format, allowing early knowledge of which tokens exist; (b) elements can be lazily resolved (fetched on demand from IPFS by CID) rather than pre-loaded. True byte-level streaming is not feasible with a shared DAG; lazy resolution is the closest achievable property. Alternatively, use CAR format with a deterministic element ordering (manifest first, then BFS traversal of each token's DAG), but acknowledge that cross-token shared elements will be referenced before they are defined in the stream.

---

### FINDING 4.3 -- Instance Chain Index Maintenance Cost (MINOR)

**Observation:** The instance chain index maps "each element hash to the head of its instance chain." When a new instance is added via `addInstance()`, every element in the chain needs its index entry updated to point to the new head. For a chain of length N, this is O(N) index updates per `addInstance()`.

**Impact:** For proof consolidation where a single consolidated proof replaces a chain of N individual proofs, the index must update entries for all N predecessors. This is O(N) but N is bounded by the number of transactions (typically small, <100).

**Resolution:** This is manageable at wallet scale. Document the O(N) cost and note that the index is a convenience structure that can be rebuilt from the pool by scanning all elements. No design change needed, but the cost should be acknowledged.

---

## 5. Security Concerns

### FINDING 5.1 -- No Element Integrity Verification During Reassembly (CRITICAL)

**Observation:** The spec says elements are content-addressed (hash is their identifier). During reassembly, an element is fetched from the pool by its hash. But the spec never states that the reassembly algorithm MUST verify that the element's actual content matches its claimed hash. If the pool is corrupted (disk error) or malicious (tampered IPFS node), an element could have been replaced with different content while keeping the same key.

**Impact:** A malicious actor who controls an IPFS gateway could serve modified element content for a valid CID. The reassembled token would contain corrupted data but appear valid to the reassembly algorithm (which just follows references). Token validation would catch cryptographic inconsistencies, but only if the consumer runs full verification -- and the spec says reassembled tokens should be "indistinguishable from the original" without mentioning mandatory re-verification.

**Resolution:** Mandate that `assemble()` re-hashes every element fetched from the pool and compares against the expected CID. If any mismatch is found, reassembly fails with an integrity error. This is cheap (SHA-256 is fast) and essential. Add this to the `verify()` operation as well.

---

### FINDING 5.2 -- Instance Chain Poisoning (MAJOR)

**Observation:** An attacker who can add elements to the pool (e.g., via a `merge()` with a malicious package) can create a fraudulent instance chain entry. For example: the attacker creates an element with `predecessor: hash_of_legitimate_proof` and `kind: "consolidated-proof"`, containing a fabricated proof. The instance chain index would point to this as the head, and `strategy=latest` would select it during reassembly.

**Impact:** The reassembled token would contain a fake proof. If the consumer does not independently verify the proof against the aggregator, they would accept a forged state transition.

**Resolution:** Instance chain entries must be validated before being added to the index. At minimum: (a) verify that the new instance's content hash is correct; (b) verify that the predecessor reference points to an existing element; (c) for proof-type instances, verify that the new proof is semantically equivalent to the predecessor (e.g., proves the same state transitions). Criterion (c) requires domain-specific validation and should be a pluggable verifier.

---

### FINDING 5.3 -- SHA-256 Collision Resistance is Sufficient (MINOR)

**Observation:** TASK.md does not explicitly name the hash function, but references CIDs and SHA-256 (line 315: "SHA-256(pubkey || stateHash)"). SHA-256 provides 128-bit collision resistance, which is well above the threshold for any practical attack. Content-addressable systems like IPFS and Git use SHA-256 successfully.

**Impact:** No risk. SHA-256 is appropriate.

**Resolution:** None needed. Explicitly name SHA-256 as the hash function in the spec for clarity, and use the multihash encoding from multiformats for forward-compatibility with future hash upgrades.

---

## 6. Contradictions Within TASK.md

### FINDING 6.1 -- "Append-Only" vs "Proof Updates" Contradiction (MAJOR)

**Observation:** Line 30-31 states: "Once an element is added to a token, it cannot be modified or removed." Then immediately: "The sole exception is unicity proofs, which may be updated in place." But the instance chain model (lines 146-148) says "An updated instance is stored as a separate DAG node... The previous instance is never removed." These are contradictory: the first statement says proofs can be "updated in place" (implying mutation), while the instance chain model says updates are append-only (new nodes, old preserved).

**Resolution:** Remove the "updated in place" language from line 31. Replace with: "The sole exception is unicity proofs, which may have alternative representations added via instance chains (see Versioning Model). The original proof is always preserved."

---

### FINDING 6.2 -- "Flat Element Pool" vs "DAG" Terminology Confusion (MINOR)

**Observation:** Line 62 says "a shared, flat element pool" and line 109 says "the element pool is a shared DAG." A flat store and a DAG are different concepts. The pool is flat in the sense of being a key-value store (hash -> element), but the elements form a DAG via their references. The text conflates the storage structure (flat) with the logical structure (DAG).

**Resolution:** Clarify: "The element pool is a flat content-addressed store (hash-to-element mapping). The elements within it form a directed acyclic graph via their child references."

---

### FINDING 6.3 -- API Inconsistency: ingest vs addToken (MINOR)

**Observation:** The API lists both `ingest(pkg, token)` (line 275-276) and `addToken(pkg, token)` (line 279). Both appear to add a token to a package. The difference is not explained. `ingest` says "deconstruct a self-contained token into elements, deduplicate against the pool, and add/update its manifest entry." `addToken` says "incremental addition." Are these the same operation?

**Resolution:** Either merge them into one function, or define the difference. If `addToken` is the public API and `ingest` is the internal operation, make that explicit. If `addToken` handles metadata (like updating indexes) that `ingest` does not, specify it.

---

### FINDING 6.4 -- Requirement Conflict: Self-Describing vs Deterministic (MINOR)

**Observation:** Constraint 2 says "self-describing -- must include enough metadata to be parsed without external schema knowledge." Constraint 4 says "deterministic serialization -- identical logical content must produce identical byte sequences." Self-describing formats (like JSON with type markers) inherently include metadata that can vary in representation (key order, whitespace, type marker encoding). Deterministic serialization requires stripping all such variation.

**Resolution:** These are compatible if the canonical form includes the self-describing metadata in a deterministic way. Use CBOR with deterministic encoding (RFC 8949) which includes type tags (self-describing) in a canonical byte order (deterministic). Explicitly state that the self-describing metadata is part of the content that is deterministically serialized.

---

## Summary by Severity

| Severity | Count | Key Findings |
|----------|-------|-------------|
| CRITICAL | 5 | Nametag representation mismatch (1.1), Instance chain branching undefined (1.2), TXF migration path absent (2.1), Element taxonomy undefined (3.1), Pending transactions unaddressed (3.2), No integrity verification on reassembly (5.1) |
| MAJOR | 9 | GC algorithm undefined (1.3), Circular reference unhandled (1.4), IPFS model mismatch (2.2), Bundle size impact (2.3), TxfToken vs ITokenJson ambiguity (2.4), Deterministic serialization unspecified (3.3), Version overloading (3.4), Proof consolidation undefined (3.6), DAG node explosion (4.1), Streaming infeasible (4.2), Instance chain poisoning (5.2), Append-only contradiction (6.1) |
| MINOR | 5 | Content-addressing overhead (1.5), ZK aspirational (3.5), Instance chain index cost (4.3), SHA-256 sufficient (5.3), Flat vs DAG confusion (6.2), API inconsistency (6.3), Self-describing vs deterministic (6.4) |

## Recommended Pre-Implementation Actions

1. **Produce the element taxonomy** (addresses 3.1, 1.5, 4.1). This is the single highest-priority deliverable. Without it, nothing can be implemented or benchmarked.

2. **Clarify the source-of-truth token type** (addresses 1.1, 2.4). Decide whether UXF decomposes `ITokenJson` or `TxfToken`. Get the actual type definition from `state-transition-sdk` and include it in the spec.

3. **Define the scope boundary** (addresses 3.2, 2.1). Is UXF a storage format (replacing TxfStorageData) or an exchange format (complementing it)? This drives half the design decisions.

4. **Defer ZK proofs and proof consolidation** (addresses 3.5, 3.6). Test instance chains with mock alternative instances. Real proof consolidation requires aggregator cooperation.

5. **Resolve the instance chain branching problem** (addresses 1.2, 5.2). Define merge semantics for conflicting instance chain heads.

6. **Add mandatory integrity checks** (addresses 5.1, 5.2). Hash verification on reassembly and instance chain validation on merge.