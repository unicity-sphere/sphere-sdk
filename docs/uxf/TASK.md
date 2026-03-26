# UXF: Universal eXchange Format for Unicity Tokens

## Task Definition

Design and implement a content-addressable packaging format for storing and exchanging Unicity token materials across users, devices, and distributed storage systems such as IPFS.

---

## Problem Statement

A Unicity token is a self-contained cryptographic container that carries its complete ownership history (genesis, state transitions, inclusion proofs) off-chain. Users maintain pools of tokens representing diverse asset types (fungible coins, NFTs, nametags) where:

- A single asset class (e.g., BTC, ETH, UCT) may be spread across multiple tokens.
- A single token may carry multiple asset classes simultaneously.
- Tokens exchanged between users must be serialized, transmitted, and imported as complete verifiable units.

The existing SDK serialization (`ITokenJson`, CBOR) handles individual token round-trips but lacks a **multi-token pool-level packaging format** that:

1. **Deduplicates shared cryptographic materials** (e.g., inclusion proofs referencing the same aggregator round, shared unicity certificates, common nametag tokens embedded in multiple tokens).
2. **Supports efficient extraction** of a single token at its latest locally-known state or at any historical state.
3. **Enables incremental updates** — adding, removing, or updating individual token records without rewriting the entire package.
4. **Preserves token integrity** — the format must allow verification of any extracted token without access to the full pool.
5. **Aligns with content-addressable storage** (IPFS/IPLD) — structuring data so that shared sub-trees between users and tokens naturally deduplicate at the storage layer.

---

## Token Structure Model

### Tokens as Append-Only Structures

A token is an ever-growing, append-only data structure. Once an element (e.g., a transaction, genesis record) is added to a token, it cannot be modified or removed — the token's integrity depends on the immutability of its historical chain. The sole exception is **unicity proofs**, which may be updated in place (e.g., replaced with a more compact or more recent proof) because their semantics — proving that a specific state transition was committed exactly once — remain invariant regardless of the proof's representation.

**Invariant:** The semantics of any element, once committed to a token, must never change. Representation (encoding, field ordering, compression) may evolve across versions, but the logical meaning of the element must be preserved exactly.

### Hierarchical Structure and Content-Addressed DAG

A token is a deeply hierarchical data structure — its JSON/CBOR form is a tree, not a flat record. For example:

```
Token
├── genesis
│   ├── transactionData (tokenId, tokenType, coinData, salt, recipient, ...)
│   ├── inclusionProof
│   │   ├── merkleTreePath (array of SMT nodes)
│   │   ├── authenticator (pubkey, signature, stateHash)
│   │   └── unicityCertificate
│   │       ├── inputRecord (roundNumber, epoch, hash, ...)
│   │       ├── shardTreeCertificate
│   │       ├── unicityTreeCertificate
│   │       └── unicitySeal (BFT signatures)
│   └── destinationState (predicate, data)
├── transactions[]
│   └── (each has the same deep structure as genesis)
├── state (current predicate + data)
└── nametags[] (each is itself a full Token — recursive)
```

This hierarchy maps naturally to a **content-addressed DAG** (as in IPFS/IPLD): every node in the tree — at any depth — is independently content-hashed and addressable. A "subelement" of one token (e.g., a unicity certificate buried inside a transaction's inclusion proof) can be the exact same DAG node referenced by a completely different token's transaction. Sharing is not limited to top-level elements; it occurs at every level of the tree.

### Storage Model: Deconstruction and Reassembly

A UXF bundle does **not** store tokens as monolithic objects. Instead, each token is **recursively deconstructed** into its constituent elements — and those elements into their subelements, and so on down the full depth of the hierarchy — upon ingestion. Every node in the resulting DAG is content-hashed and stored exactly once in a shared, flat **element pool**. Parent elements reference their children by content hash rather than embedding them inline.

This recursive deconstruction is what enables deep deduplication: sharing happens at every level of the tree, not just at the top. For instance:

- Two tokens transacted in the same aggregator round share the same **unicity certificate** node (a sub-sub-element of their respective inclusion proofs).
- A nametag token embedded inside token A's transaction may itself be a full token that also appears independently in the bundle — it is stored once and referenced from both locations.
- Two inclusion proofs from the same round share upper **SMT path segments** as common subtree nodes.
- An element from one token may contain (reference) subelements that belong to a different token — this is natural and expected in the DAG model.

The bundle maintains a **token manifest** — a lightweight index that maps each `tokenId` to the content hash of its root element. From that root, the full token tree can be traversed by following child references through the element pool. The manifest contains no element data, only root references.

```
UXF Bundle
├── Package Envelope (version, metadata)
├── Element Pool (shared, content-addressed DAG nodes)
│   ├── node[hash_A] — unicity certificate (shared by 5 inclusion proofs across 3 tokens)
│   ├── node[hash_B] — authenticator (subelement of an inclusion proof)
│   ├── node[hash_C] — inclusion proof → references [hash_A, hash_B, hash_D]
│   ├── node[hash_D] — SMT path segment (shared by 2 inclusion proofs)
│   ├── node[hash_E] — transaction → references [hash_C, hash_F, ...]
│   ├── node[hash_F] — destination state (predicate + data)
│   ├── node[hash_G] — genesis → references [hash_H, hash_I, ...]
│   ├── node[hash_J] — nametag token root (itself a full token DAG, shared by 12 transactions)
│   └── ...
├── Token Manifest
│   ├── token_id_1 → hash_root_1  (root of token 1's DAG)
│   ├── token_id_2 → hash_root_2  (root of token 2's DAG; subtrees overlap with token 1)
│   └── ...
└── Indexes (by tokenType, by state hash, etc.)
```

**Reassembly** is the process of starting from a token's root hash in the manifest, recursively resolving all child references through the element pool, and recomposing the full hierarchical structure into a self-contained token (e.g., `ITokenJson` / CBOR v2.0). The reassembled token is indistinguishable from the original — it passes the same validation and can be exported for exchange via existing SDK mechanisms.

For **historical state reassembly**, the token's root node references an ordered list of transaction sub-DAGs; reassembling at state N means traversing only the genesis sub-DAG plus the first N transaction sub-DAGs and their transitive children.

**Deconstruction** is the reverse: a self-contained token tree is recursively walked, each node is content-hashed, and only nodes not already present in the pool are added. Since the pool is content-addressed, ingesting a token that shares sub-trees with already-stored tokens adds only the novel nodes.

### Element Composition and Cross-Token References

Each node in the element pool is a self-contained unit with its own version, type, and content hash. A node references its children by their content hashes — never by embedding them inline. Inline embedding only occurs at **reassembly** time, when a self-contained token is recomposed for export.

Because the pool is a flat content-addressed store, the parent-child relationship is not confined to a single token's tree. A node that is a subelement of one token may equally be a subelement of another:

- A **unicity certificate** (deep inside token A's transaction → inclusion proof → certificate) may be the same DAG node referenced by token B's transaction → inclusion proof → certificate.
- A **nametag token** referenced by a transaction's `dest_ref` is itself a complete token sub-DAG. If that same nametag token exists independently in the bundle, it is the same set of nodes — no duplication.
- An **SMT path segment** shared by two inclusion proofs (from different tokens, same aggregator round) is stored once and referenced twice.

This means the element pool is a **shared DAG**, not a collection of independent per-token trees. Token boundaries are defined by the manifest (which root hash belongs to which `tokenId`), not by the DAG structure itself.

### Versioning Model

Every token and every element within a token carries a **version** that governs both its **representation** (serialization format, field layout, encoding) and its **semantics** (the logical meaning and processing rules).

#### Version Dimensions

| Dimension | What it controls | When it changes | Compatibility rule |
|---|---|---|---|
| **Representation version** | Binary/JSON encoding, field names, field order, optional field presence | When the serialization format evolves (e.g., new CBOR layout, field renaming) | Parsers must support reading all known representation versions and normalizing to the latest internal form |
| **Semantic version** | Processing rules, validation logic, hash computation, cryptographic algorithms | When the protocol itself evolves (e.g., new signing algorithm, new proof structure) | Semantic changes must be backward-compatible at the element level: a v1 transaction retains v1 validation rules forever, even inside a v2 token |

#### Version Granularity

- **Token-level version** — declares the overall token format version (e.g., `"2.0"`). Determines the envelope structure and which element versions are expected.
- **Element-level version** — each element (genesis, transaction, inclusion proof, predicate, authenticator) carries its own version. This enables **mixed-version tokens**: a token minted under v1 semantics can accumulate v2 transactions as it evolves through state transitions.

#### Mixed-Version Evolution

A token's lifecycle may span multiple protocol versions:

```
Token (v2.0 envelope)
├── genesis (v1 semantics, v1 representation)
├── transaction[0] (v1 semantics, v1 representation)
├── transaction[1] (v1 semantics, v2 representation)  ← re-serialized, same meaning
├── transaction[2] (v2 semantics, v2 representation)  ← new protocol rules
└── state (v2 semantics)
```

This means:
- A parser encountering an element must inspect its version to select the correct deserialization and validation logic.
- An element's semantic version is fixed at creation and never changes (append-only invariant).
- An element's representation version may change (e.g., when the package is re-serialized into a newer format), provided the semantics are preserved exactly.
- The token-level version reflects the highest semantic version present, or the version of the envelope format, not necessarily the version of every element within.

#### Element Instance Chains

An element in the pool may have multiple **instances** — alternative representations of the same logical element that are all semantically equivalent (they prove or assert the same thing). An updated instance is stored as a **separate DAG node that references its predecessor**, forming a singly-linked **instance chain** (newest to oldest, analogous to a blockchain). The previous instance is never removed — content-addressability and existing references are preserved.

Instance chains serve three distinct purposes, all using the same chaining mechanism:

**1. Representation evolution** — an element is re-serialized into a newer encoding format (e.g., CBOR v2 layout) without changing its version number or semantics:

```
element[hash_v2] (repr=2, sem=1) → predecessor: hash_v1
element[hash_v1] (repr=1, sem=1) → predecessor: null  (original)
```

**2. Proof consolidation** — multiple individual unicity proofs are merged into a single subtree of the aggregator's Sparse Merkle Tree, dramatically reducing space. The consolidated proof is semantically equivalent (it still proves the same set of state transitions were committed exactly once) but structurally different:

```
consolidatedProof[hash_C] (proves transitions 0..4 via shared SMT subtree)
  → predecessor: hash_P4
individualProof[hash_P4] (transition 4) → predecessor: hash_P3
individualProof[hash_P3] (transition 3) → predecessor: hash_P2
individualProof[hash_P2] (transition 2) → predecessor: hash_P1
individualProof[hash_P1] (transition 1) → predecessor: null
```

Here the consolidated proof replaces a chain of individual proofs with a single compact element. Both forms are valid — the consumer can choose either during reassembly.

**3. ZK proof substitution** — a full transaction history (genesis + N transitions with all their subelements) is replaced by a compact zero-knowledge proof that attests to the correctness of the entire state transition chain. The ZK proof is semantically equivalent to the full history — it proves the same thing — but is orders of magnitude smaller:

```
zkProof[hash_ZK] (proves valid chain from genesis to state N)
  → predecessor: hash_HISTORY_ROOT
historyRoot[hash_HISTORY_ROOT] (full: genesis + transitions[0..N])
  → predecessor: null
```

The full history and the ZK proof are **alternative instances** of the same logical element (the token's provenance). During reassembly, the consumer selects which to include:
- **ZK proof** — for compact transfer payloads where the recipient trusts ZK verification.
- **Full history** — for recipients who require the complete auditable chain, or for archival purposes.

#### Instance Selection During Reassembly

During reassembly, each element reference in the DAG is resolved through the instance chain. The consumer provides an **instance selection strategy** that governs which alternative to use:

| Strategy | Behavior | Use case |
|---|---|---|
| **latest** (default) | Use the head of the chain (most recent instance) | General use — picks the most compact/optimized form |
| **original** | Walk to the tail of the chain (first instance) | Archival, debugging, or when the original encoding is required |
| **by representation version** | Select the instance matching a specific `repr` version | Compatibility with older SDK versions |
| **by kind** | Select by instance kind (e.g., `full-history` vs. `zk-proof` vs. `consolidated-proof`) | When the consumer needs a specific proof form |
| **custom predicate** | Caller-supplied function evaluating each instance | Advanced use cases |

Multiple strategies can be composed: e.g., "prefer ZK proof, fall back to consolidated proof, fall back to full history."

A reassembled token is always valid regardless of which instance is selected — all instances in a chain are semantically equivalent. The choice affects only size, verification method, and level of detail.

```
UXF Bundle — Element Pool (with instance chains)

consolidatedProof[hash_CP] → predecessor: hash_P2
  (compact SMT subtree covering 2 proofs)
individualProof[hash_P2] → predecessor: hash_P1
individualProof[hash_P1] → predecessor: null

zkProof[hash_ZK] → predecessor: hash_HR
  (attests to full genesis→stateN chain)
historyRoot[hash_HR] → predecessor: null
  (full transaction history sub-DAG)

transaction[hash_T1] → references proof: hash_P1  (original reference)
  ↳ reassembly with strategy=latest resolves to hash_CP
  ↳ reassembly with strategy=original resolves to hash_P1

tokenRoot[hash_R1] → references history: hash_HR  (original reference)
  ↳ reassembly with strategy={kind: zk-proof} resolves to hash_ZK
  ↳ reassembly with strategy=original resolves to hash_HR
```

**Instance chain index**: the bundle maintains a lightweight index mapping each element hash to the head of its instance chain, enabling O(1) lookup of the latest instance without walking the chain. The index also records the **kind** of each instance for efficient kind-based selection.

#### Element Header Encoding

Each element includes a header as the first item in its serialized form, encoding its version, lineage, and kind:

```
header = {
  representation: <uint>,        — encoding format version
  semantics: <uint>,             — protocol semantic version (fixed at creation)
  kind: <string>,                — instance kind (e.g., "individual-proof", "consolidated-proof",
                                   "zk-proof", "full-history", "default")
  predecessor: <hash | null>     — content hash of the previous instance, or null for the original
}
```

Or as a compact tuple `[repr_version, sem_version, kind, predecessor_hash]` in CBOR. The `predecessor` field is `null` for the original instance and contains the content hash of the previous instance for all subsequent entries in the chain. The `kind` field enables efficient instance selection during reassembly without inspecting element contents. The representation version is local to the encoding; the semantic version is protocol-global and monotonically increasing.

---

## Scope

### In Scope

1. **Format specification** — a formal schema for the UXF package structure, covering:
   - Package envelope (version, metadata, content manifest).
   - **Element pool** — the shared, content-addressed DAG store; every node (at any depth of the token hierarchy) is stored once and addressed by content hash; insertion, lookup, garbage collection, and version chain management semantics.
   - **Token manifest** — maps each `tokenId` to the content hash of its root DAG node; the full token tree is recoverable by recursively traversing child references from the root.
   - Token record layout (referencing existing `ITokenJson` / CBOR v2.0 structures from `@unicitylabs/state-transition-sdk`; defines the reassembled output format).
   - **Versioning and instance chains** — token-level and element-level version fields encoding representation version, semantic version, instance kind, and predecessor reference; element instance chains (newer instances referencing their predecessors); instance chain index; rules for mixed-version token construction, validation, and instance selection during reassembly (by kind, by version, by strategy).
   - **Element taxonomy** — formal definition of each element type (genesis, transaction, inclusion proof, predicate, authenticator, nametag reference, unicity certificate), its subelement structure, and its reference/inline embedding rules.
   - **Mutability rules** — all elements are immutable once stored; "updates" are expressed as new instances appended to the instance chain (never in-place mutation). Rules governing which element types may have alternative instances (e.g., proofs may be consolidated, transaction histories may be replaced by ZK proofs) vs. which are strictly single-instance (e.g., individual transaction data).
   - Deduplication scheme for shared materials (unicity certificates, SMT path segments, nametag tokens, predicates).
   - Indexing structures for O(1) token lookup by `tokenId`, by `tokenType`, by state hash, and by transaction history position.
   - Incremental update protocol (append, remove, update operations on the package).
   - Integrity metadata (per-token and package-level content hashes).

2. **IPFS/IPLD alignment** — the UXF element pool is inherently a content-addressed DAG, making the mapping to IPFS/IPLD natural and direct:
   - Define how each DAG node (element) maps to an IPLD block with CID-based links to children.
   - Chunking strategy for large token pools (manifest partitioning, element pool sharding).
   - Cross-user deduplication: when two users' bundles share sub-DAGs (e.g., tokens with common history or shared nametags), IPFS automatically deduplicates at the block level because identical content produces identical CIDs.
   - IPNS integration points for mutable package roots (the manifest root CID changes as tokens are added; IPNS provides a stable name for the latest version).

3. **Deconstruction and reassembly operations** — specify and implement:
   - **Deconstruct** a self-contained token (`ITokenJson` / CBOR) into elements and ingest into the pool, deduplicating against existing elements.
   - **Reassemble** a token at its latest locally-known state from the element pool — the result is a self-contained, verifiable `ITokenJson` indistinguishable from the original.
   - **Reassemble at historical state N** — collect genesis + first N transaction elements and their associated proofs; produce a valid self-contained token reflecting that historical state.
   - Extract subset of tokens by filter (token type, coin class, value threshold).
   - Extract minimal transfer payload (token + pending transaction, as per existing `exportFlow` semantics).

4. **Reference implementation** — TypeScript library providing:
   - `UxfPackage` class: create, open, read, write UXF bundles. Encapsulates the element pool, token manifest, and indexes.
   - `ingest(pkg: UxfPackage, token: Token) -> void`: deconstruct a self-contained token into elements, deduplicate against the pool, and add/update its manifest entry.
   - `ingestAll(pkg: UxfPackage, tokens: Token[]) -> void`: batch deconstruction of multiple tokens.
   - `assemble(pkg: UxfPackage, tokenId: TokenId) -> Token`: reassemble a token at its latest locally-known state from the element pool. The result is a self-contained, verifiable token.
   - `assembleAtState(pkg: UxfPackage, tokenId: TokenId, stateIndex: number) -> Token`: reassemble at a specific historical state (genesis + first N transitions).
   - `removeToken(pkg: UxfPackage, tokenId: TokenId) -> UxfPackage`: remove a token from the manifest (elements are not garbage-collected automatically).
   - `merge(a: UxfPackage, b: UxfPackage) -> UxfPackage`: combine two packages with deduplication.
   - `diff(a: UxfPackage, b: UxfPackage) -> UxfDelta`: compute minimal delta between package versions.
   - `verify(pkg: UxfPackage) -> VerificationResult`: validate package and token integrity.
   - `addInstance(pkg: UxfPackage, originalHash: Hash, newInstance: Element) -> void`: append a new instance (consolidated proof, ZK proof, re-encoded element) to an element's instance chain; the new instance references the previous head as its predecessor.
   - `consolidateProofs(pkg: UxfPackage, tokenId: TokenId, txRange: [number, number]) -> void`: merge a range of individual unicity proofs into a consolidated SMT subtree instance.
   - `assemble` / `assembleAtState` accept an optional **instance selection strategy** (latest, original, by-kind, by-representation-version, or custom predicate) to control which instance from each element's chain is used during reassembly.
   - Version-aware serialization: read any known representation version, write the latest.
   - CBOR and JSON serialization for all structures.
   - IPLD-compatible DAG export.

### Out of Scope

- Aggregator protocol changes or on-chain modifications.
- Transport-layer concerns (NFC, Bluetooth, HTTP — UXF is transport-agnostic).
- Wallet UI or application-level token management logic.
- Encryption or access control on the package contents (may be layered on top separately).

---

## Existing Structures to Build Upon

### Base SDK (`@unicitylabs/state-transition-sdk` v2.0)

| Structure | Role | Serialization |
|---|---|---|
| `Token` (`ITokenJson`) | Self-contained token with full history | JSON (hex strings) + CBOR |
| `TokenId` | 32-byte unique token identifier | 64-char hex / CBOR bytes |
| `TokenType` | 32-byte asset class identifier | 64-char hex / CBOR bytes |
| `TokenState` | Current ownership predicate + optional data | JSON object / CBOR array |
| `MintTransactionData` | Genesis parameters (immutable) | JSON object / CBOR array |
| `TransferTransactionData` | Per-transfer parameters | JSON object / CBOR array |
| `InclusionProof` | SMT path + authenticator + unicity certificate | JSON object / CBOR array |
| `UnicityCertificate` | BFT-signed aggregator round commitment | Hex-encoded CBOR (tag 1007) |
| `Authenticator` | Public key + signature + state hash | JSON object / CBOR array |
| `RequestId` | SHA-256(pubkey \|\| stateHash) — SMT leaf address | DataHash imprint |

### Sphere SDK (existing TXF layer)

| Structure | Role | Notes |
|---|---|---|
| `TxfStorageData` | Wallet-level token pool container | Keyed by `_<tokenId>`, includes metadata, tombstones, outbox |
| `TxfToken` | Simplified token representation | Adds `_integrity`, string-only nametags |
| `TxfTransaction` | Transfer with `previousStateHash` / `newStateHash` | Derived fields for quick lookups |
| `TxfMeta` | Package metadata (version, address, IPNS name, device ID) | Wallet-specific, needs generalization |

### Key Deduplication Targets

1. **Unicity certificates** — tokens transacted in the same aggregator round share the same certificate. Certificates are ~500-2000 bytes each and dominate proof size.
2. **Nametag tokens** — embedded recursively in `ITokenJson.nametags[]`; the same nametag token may appear in dozens of other tokens.
3. **SMT path prefixes** — inclusion proofs for tokens in the same round share upper path segments in the sparse Merkle tree.
4. **Predicate parameters** — tokens owned by the same user share `tokenType`, `signingAlgorithm`, `hashAlgorithm` fields (though `nonce` and `publicKey` differ per state).

---

## Design Constraints

1. **Backward compatibility** — UXF must be able to ingest and emit standard `ITokenJson` / CBOR v2.0 tokens without loss.
2. **Self-describing** — the format must include enough metadata to be parsed without external schema knowledge (version field, content type markers).
3. **Streaming-friendly** — it should be possible to begin extracting tokens before the entire package is downloaded.
4. **Deterministic serialization** — identical logical content must produce identical byte sequences (required for content-addressable storage).
5. **Size efficiency** — a UXF package of N tokens with shared materials should be significantly smaller than N independent `ITokenJson` serializations.
6. **Representation/semantics separation** — representation (encoding) may change freely across versions; semantics (meaning, validation rules, hash computation) of an element are fixed at the element's creation and must never be altered. A v1 element re-serialized into v2 representation must validate identically under v1 semantic rules.
7. **Mixed-version tolerance** — parsers and validators must handle tokens containing elements of heterogeneous semantic versions. Validation dispatches to the correct semantic version handler per element, not per token.
8. **Reassembly completeness** — a token reassembled from the element pool must be fully self-contained and indistinguishable from the original. It must pass the same validation, produce the same state hashes, and be directly usable by existing SDK import/export mechanisms without any knowledge of UXF.

---

## Acceptance Criteria

1. A formal specification document defining the UXF binary and JSON formats with field-level descriptions, CDDL or JSON Schema definitions, and worked examples.
2. A TypeScript reference implementation passing unit tests for all operations listed in scope.
3. Deduplication benchmarks showing measured size reduction on realistic token pools (10, 100, 1000 tokens with varying overlap).
4. Round-trip tests: `assemble(ingest(token))` produces a token identical to the original for all supported token configurations (fungible, NFT, nametag, multi-coin, with and without pending transactions). Deconstructing the same token twice does not duplicate elements in the pool.
5. IPLD DAG export produces valid CIDs and the structure is navigable via standard IPFS tooling.
6. Historical state extraction is verified: extracting a token at state N and replaying from genesis yields the same state hash as the Nth transition's destination.
7. Mixed-version round-trip: a token with v1 genesis + v2 transactions is packed, unpacked, and validated correctly — each element applying its own semantic version's rules.
8. Proof update test: replacing a unicity proof via `updateProof` preserves token validity; attempting to modify any other element type is rejected.
9. Re-serialization test: re-encoding a v1-representation element into v2 representation produces a byte-different but semantically identical element that passes validation under v1 semantic rules.
10. Cross-token DAG sharing: ingesting two tokens that share a sub-DAG (e.g., same unicity certificate, same nametag token) results in a single copy of the shared nodes in the pool; both tokens reassemble correctly from the shared structure.
11. Instance chain test: after adding an alternative instance (e.g., consolidated proof, re-encoded element), the old instance remains in the pool; the chain is walkable from head to original; reassembly with `strategy=latest` uses the head; `strategy=original` uses the tail; `strategy={kind: X}` selects by kind.
12. Proof consolidation test: merging N individual proofs into a consolidated SMT subtree instance produces a valid, smaller element; reassembly with the consolidated instance produces a token that passes verification; reassembly with `strategy=original` still produces the token with individual proofs.
13. ZK proof substitution test: replacing a full transaction history with a ZK proof instance produces a valid reassembled token under ZK verification; reassembly with `strategy={kind: full-history}` returns the complete auditable chain; both forms are semantically equivalent.
