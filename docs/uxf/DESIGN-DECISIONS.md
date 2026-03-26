# UXF Design Decisions

**Status:** Consolidated from architecture, specification, review, IPFS research, and token analysis agents.
**Date:** 2026-03-26

This document resolves conflicts and ambiguities identified across the five parallel research streams, establishing binding decisions for implementation.

---

## Decision 1: Canonical Input Type — ITokenJson, not TxfToken

**Context:** The reviewer (Finding 2.4) identified that TASK.md references both `ITokenJson` (state-transition-sdk) and `TxfToken` (sphere-sdk). These are structurally different — critically, `TxfToken.nametags` is `string[]` while `ITokenJson.nametags` is recursive `Token[]`. The token analysis confirmed nametag deduplication is the #2 savings target (~350 KB per 100-token wallet).

**Decision:** UXF operates on `ITokenJson` from `@unicitylabs/state-transition-sdk` as its canonical input/output format. The sphere-sdk `TxfToken` type is a convenience wrapper — UXF ingests and emits `ITokenJson` (or its CBOR equivalent).

**Implication:** The `ingest()` and `assemble()` APIs accept/return `ITokenJson`. A thin adapter converts `TxfToken` → `ITokenJson` for sphere-sdk integration. Nametag tokens are recursively deconstructed as full token sub-DAGs, not stored as string names.

---

## Decision 2: UXF Scope — Exchange Format First, Storage Adapter Second

**Context:** The reviewer (Finding 3.2) noted that `TxfStorageData` contains wallet-operational metadata (`_outbox`, `_tombstones`, `_mintOutbox`, `_sent`, `_nametags`) that TASK.md does not address. UXF cannot replace TXF as a storage backend without handling these.

**Decision:** UXF is primarily a **token packaging/exchange format**, not a wallet state format. Implementation proceeds in two phases:

- **Phase 1 (MVP):** UXF as a standalone library that ingests/emits `ITokenJson` tokens. No wallet metadata. `PaymentsModule` continues using `TxfStorageData` for persistence. UXF is used for IPFS export, cross-device sync, and multi-token exchange bundles.
- **Phase 2 (future):** `UxfStorageAdapter` implementing `TokenStorageProvider` that internally uses UXF for persistence, with wallet metadata stored in the package envelope. Migration logic converts existing `TxfStorageData` on first load.

**Implication:** The package envelope metadata section (Section 5.3 of the spec) is kept minimal for Phase 1. Wallet-specific fields (`_outbox`, `_tombstones`) are excluded. The `UxfPackage` class does not depend on `PaymentsModule`, `Sphere`, or any wallet lifecycle class.

---

## Decision 3: Use @ipld/dag-cbor, Not Hand-Written CBOR

**Context:** The architect proposed hand-writing a minimal CBOR encoder (~200 lines) to avoid new dependencies. The IPFS researcher showed that `@ipld/dag-cbor` provides critical determinism guarantees (RFC 8949 canonical encoding, sorted map keys, Tag 42 for CID links) that would be error-prone to reimplement and are essential for content-addressability.

**Decision:** Use `@ipld/dag-cbor` (v9.2.5) + `multiformats` (v13.4.2) as dependencies. These are well-maintained, ESM-native, and provide the exact deterministic serialization + CID computation needed.

**Rationale:**
- dag-cbor canonical encoding is non-trivial to implement correctly (key sorting by CBOR byte order, not string order; BigInt handling; float canonicalization). Getting it wrong breaks content-addressability silently.
- `@ipld/dag-cbor` + `multiformats` together add ~50-80 KB minified. This is acceptable given that the SDK already bundles `@noble/hashes` (~25 KB) and `@noble/curves` (~80 KB).
- Native CID link support (Tag 42) means UXF elements are directly usable as IPLD blocks without transformation.

**Mitigation for bundle size:** UXF is a separate tsup entry point (`@unicitylabs/sphere-sdk/uxf`). Consumers who don't use UXF don't pay the dependency cost. The main SDK barrel re-exports types only, not runtime code.

**Additional dependency:** `@ipld/car` (v5.4.2) for CAR file import/export. This is optional — only imported when CAR operations are used.

---

## Decision 4: A UXF Bundle IS a CAR File

**Context:** The IPFS researcher demonstrated that CAR (Content Addressable aRchive) maps 1:1 to the UXF bundle concept: element pool → IPLD blocks, manifest root → CAR root CID, content hashes → CIDs.

**Decision:** The native binary serialization of a UXF package is a **CARv1 file**. The JSON format remains available for debugging and human inspection.

**Structure:**
- CAR root: CID of the manifest+metadata block (dag-cbor encoded)
- Blocks: one IPLD block per element, each dag-cbor encoded with CID links (Tag 42) for child references
- Block ordering: manifest first, then BFS traversal from each token root (enables streaming)

**Implication:** `UxfPackage.toCar()` and `UxfPackage.fromCar()` are the primary serialization methods. CAR files can be uploaded directly to IPFS pinning services (Storacha, Pinata) or exchanged peer-to-peer. The existing sphere-sdk IPFS integration can be extended to upload CAR files instead of JSON blobs.

---

## Decision 5: Decomposition Granularity — Mid-Level, Data-Driven

**Context:** The token analysis provided concrete byte sizes and sharing ratios. The reviewer (Finding 1.5) warned about overhead for small elements. The IPFS researcher recommended mid-level granularity.

**Decision:** Decompose at the level where measured deduplication benefit exceeds CID overhead (~36 bytes per reference). Based on token analysis data:

| Element | Separate DAG node? | Rationale |
|---------|-------------------|-----------|
| **UnicityCertificate** | Yes | 1-4 KB, shared by 5-10 tokens/round. Primary dedup target. |
| **Nametag Token** | Yes (full recursive sub-DAG) | 5-8 KB, shared by 10-100 tokens. Second dedup target. |
| **InclusionProof** | Yes | Container for auth + path + cert references. Enables cert sharing. |
| **Authenticator** | Yes | ~300 bytes. Separating it enables proof restructuring without touching auth data. |
| **SmtPath** | Yes (single node, not per-segment) | 1.5-5.5 KB. Per-segment sharing is minimal (<15%). Keep as one node. |
| **GenesisTransaction** | Yes | Container for data + proof + state references. |
| **TransferTransaction** | Yes | Container for state + data + proof references. |
| **MintTransactionData** | Yes | ~500 bytes. Unique per token but structurally needed for the DAG. |
| **TransferTransactionData** | Yes | ~200 bytes. Structurally needed. |
| **TokenState** | Yes | ~500 bytes. Referenced by transactions as source/destination. |
| **Predicate** | Yes | ~400 bytes. Referenced by TokenState. Low sharing but cleanly separable. |
| **TokenCoinData** | Yes | ~150 bytes. Same-value tokens share it. |
| **SmtPathSegment** | **No — inline in SmtPath** | ~140 bytes each. Per-segment sharing is minimal. CID overhead exceeds savings. |

**Key change from spec draft:** SmtPathSegments are NOT separate elements. The SmtPath element contains the full steps array inline. This eliminates 10-40 tiny elements per proof with negligible dedup loss.

**Estimated element count per token (5 transactions):** ~35 elements (down from ~140 with per-segment decomposition). For 100 tokens: ~3,500 elements, ~1,750 after dedup.

---

## Decision 6: Instance Chain Branching — Last-Writer-Wins with Merge Detection

**Context:** The reviewer (Finding 1.2) identified that concurrent independent updates to the same element create forks in the instance chain.

**Decision:** Instance chains remain singly-linked (not DAGs). On `merge()`:
1. If both packages have an instance chain for the same element, and one chain is a prefix of the other, the longer chain wins.
2. If the chains diverge (different heads, neither is a prefix), both heads are kept as **sibling instances** — the instance chain index records multiple heads for that element, and the selection strategy can choose between them.
3. The `verify()` operation reports divergent chains as warnings (not errors).

**Rationale:** True forks are rare in practice (they require two independent agents updating the same proof concurrently). The simple last-writer-wins model handles the common case; sibling tracking handles the edge case without breaking the chain model.

---

## Decision 7: Mandatory Integrity Checks on Reassembly

**Context:** The reviewer (Finding 5.1) noted that the spec never mandates re-hashing elements during reassembly to detect corruption.

**Decision:** `assemble()` re-hashes every element fetched from the pool and compares against the expected content hash. If any mismatch is detected, reassembly fails with a `VERIFICATION_FAILED` error. This is cheap (SHA-256 is fast) and essential for security.

**Additional:** `merge()` verifies all incoming elements' content hashes before adding them to the pool, preventing instance chain poisoning (Finding 5.2).

---

## Decision 8: DAG Acyclicity Enforcement

**Context:** The reviewer (Finding 1.4) noted that circular references could cause infinite recursion during reassembly.

**Decision:** Reassembly tracks visited element hashes in a `Set`. If an element is visited twice during the same reassembly operation, it throws a `CYCLE_DETECTED` error. `verify()` also performs a full cycle check on the element pool.

---

## Decision 9: Defer ZK Proofs and Proof Consolidation to Phase 2

**Context:** The reviewer (Findings 3.5, 3.6) noted that ZK proof substitution requires a ZK system (none exists in the codebase) and proof consolidation requires aggregator cooperation (undefined semantics).

**Decision:** Phase 1 implements the instance chain mechanism and tests it with mock alternative instances. The `addInstance()` API works for any element type. `consolidateProofs()` is **not implemented** in Phase 1 — it is a placeholder that throws `NOT_IMPLEMENTED`. ZK proof acceptance criteria (#13) are moved to Phase 2.

**What IS tested in Phase 1:**
- Instance chains with representation evolution (re-encoded elements)
- Instance selection strategies (latest, original, by-kind, by-repr-version)
- `addInstance()` with a mock "consolidated-proof" kind
- Chain integrity validation

---

## Decision 10: Streaming Semantics — Lazy Resolution, Not Byte-Level Streaming

**Context:** The reviewer (Finding 4.2) noted that true byte-level streaming is infeasible with a shared DAG. The IPFS researcher confirmed CAR supports sequential reading.

**Decision:** Redefine "streaming-friendly" as:
1. The manifest is at the beginning of the serialized format (CAR root), enabling early knowledge of which tokens exist.
2. Elements can be **lazily resolved** (fetched on demand by CID from IPFS) rather than requiring the entire pool to be loaded.
3. CAR block ordering (manifest first, then BFS per token) enables progressive loading.

True byte-level streaming of reassembly is NOT a goal.

---

## Decision 11: Garbage Collection — Explicit Mark-and-Sweep

**Context:** The reviewer (Finding 1.3) noted GC with shared elements is expensive.

**Decision:** GC is explicit via `pkg.gc()`. It performs mark-and-sweep from all manifest roots. Not called automatically on `removeToken()`. For typical wallet sizes (100-1000 tokens, <5000 elements), a full mark-and-sweep takes <10ms.

---

## Decision 12: "Append-Only" Wording Correction

**Context:** The reviewer (Finding 6.1) identified a contradiction: TASK.md says proofs can be "updated in place" but the instance chain model says updates are append-only.

**Decision:** Correct the language. All elements in the pool are immutable. "Updates" are new instances appended to the instance chain. The original element is never modified or removed. TASK.md will be updated to remove "updated in place" language.

---

## Decision 13: API Cleanup — Remove addToken, Keep ingest

**Context:** The reviewer (Finding 6.3) noted `ingest()` and `addToken()` appear to do the same thing.

**Decision:** `addToken()` is removed. `ingest()` is the sole method for adding tokens to a package — it deconstructs, deduplicates, and updates the manifest. `ingestAll()` handles batch ingestion. There is no alias or convenience wrapper.

---

## Decision 14: Module Placement in sphere-sdk

**Context:** The architect proposed a top-level `uxf/` directory.

**Decision:** Accepted. UXF lives at `sphere-sdk/uxf/` as a top-level module (not under `modules/`). It is platform-agnostic with no dependencies on `Sphere`, `PaymentsModule`, or transport. It gets its own tsup entry point (`@unicitylabs/sphere-sdk/uxf`).

**File structure:**
```
uxf/
├── index.ts              # Barrel exports
├── types.ts              # All UXF type definitions
├── UxfPackage.ts         # Package class
├── deconstruct.ts        # Token → DAG decomposition
├── assemble.ts           # DAG → Token reassembly
├── element-pool.ts       # ElementPool class
├── instance-chain.ts     # Instance chain management
├── hash.ts               # Content hashing
├── verify.ts             # Integrity verification
├── ipld.ts               # IPLD/CAR import/export
└── errors.ts             # Error types
```

---

## Summary: Phase 1 Implementation Scope

| Component | Status | Notes |
|-----------|--------|-------|
| Element type taxonomy (13 types) | Defined | SmtPathSegment inlined in SmtPath |
| Element pool (in-memory Map) | Phase 1 | Content-addressed, dedup on insert |
| Deconstruction (ITokenJson → DAG) | Phase 1 | Recursive, mid-level granularity |
| Reassembly (DAG → ITokenJson) | Phase 1 | With integrity checks, cycle detection |
| Instance chains | Phase 1 | Mechanism + mock instances, no ZK/consolidation |
| Instance selection strategies | Phase 1 | latest, original, by-kind, by-repr, custom |
| Package serialization (JSON) | Phase 1 | For debugging and interchange |
| Package serialization (CAR) | Phase 1 | Primary binary format |
| Content hashing (dag-cbor + SHA-256) | Phase 1 | Via @ipld/dag-cbor |
| Manifest + indexes | Phase 1 | byTokenType, byCoinId, byStateHash |
| GC (mark-and-sweep) | Phase 1 | Explicit via gc() |
| merge() / diff() | Phase 1 | With instance chain conflict handling |
| verify() | Phase 1 | Hash verification + cycle check + chain validation |
| TxfToken adapter | Phase 1 | Thin conversion layer |
| Proof consolidation | Phase 2 | Requires aggregator cooperation |
| ZK proof substitution | Phase 2 | Requires ZK system |
| UxfStorageAdapter | Phase 2 | Replaces TxfStorageData for persistence |
| Wallet metadata in envelope | Phase 2 | _outbox, _tombstones, etc. |
| HAMT sharding for large pools | Phase 2 | Only needed at >10K elements |
