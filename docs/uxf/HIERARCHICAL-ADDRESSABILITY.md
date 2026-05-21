# Hierarchical Addressability

**Tracking issue:** [#200 — Hierarchical addressability: unify pin/fetch model
across profile, bundles, tokens, sub-token components][issue-200]

[issue-200]: https://github.com/unicity-sphere/sphere-sdk/issues/200

This document describes the canonical IPFS storage layout the SDK
produces for every content-addressed artifact (profile snapshots,
bundle CARs, token DAGs, and sub-token components) and the per-codec
`dag/put` invariants that make the layout durable across Kubo
deployments.

## TL;DR

1. **Every component is individually addressable by its own CID.**
   The envelope, the manifest, every token root, and every sub-token
   element (genesis, predicate, coinData, each transition, each proof)
   is a separate dag-cbor block reachable via a single `block/get` once
   pinned.
2. **Composite artifacts are DAGs whose nodes are linked by CID.** No
   opaque concatenations, no inline blobs. `manifest.tokens` is a
   `tokenId → CID` map; element children are `CID` references (Tag 42
   in dag-cbor encoding); the envelope holds a single `manifest` CID
   link.
3. **Repeating sub-components dedup automatically.** Byte-identical
   element bytes produce byte-identical CIDs (sha-256 + canonical
   dag-cbor). When two bundles share a token (or a predicate, or a
   tokenType, …) the shared block is pinned **once** across both
   bundles. The realised IPFS storage cost is the count of distinct
   sub-element blocks, not the sum of bundle sizes.

## The canonical DAG layout

```
Bundle CAR (root: CIDv1 dag-cbor)
└─ Envelope block               ← root, contains:
   ├─ version, createdAt, updatedAt, (creator?, description?)
   └─ manifest: CID              → Manifest block
                                    └─ tokens: { tokenId: CID }
                                                          → Token root block
                                                            ├─ header / type
                                                            ├─ content
                                                            └─ children: CID[]
                                                                          → Predicate / genesis / coinData / transitions / proofs …
                                                                            (each a separately-pinned block)
```

Every `←/└─/├─` arrow is an IPFS block reachable by its own CID via
`block/get` (after publishing with `pinCarBlocksToIpfs`). Repeating
sub-components (e.g. the same predicate across two tokens) collapse to
a single stored block.

### Block-level details

- **Envelope block.** dag-cbor, CIDv1, `0x71` codec. One per bundle.
  Bundle-unique by virtue of the `createdAt`/`updatedAt` fields.
- **Manifest block.** dag-cbor, CIDv1, `0x71`. Shared across bundles
  that happen to enumerate the same `(tokenId → tokenRoot)` set
  (rare in production wire transfers, common in dev).
- **Token root block.** dag-cbor, CIDv1, `0x71`. Content-addressed —
  same canonical token bytes → same CID across bundles.
  **This is the primary dedup unit.**
- **Sub-token elements.** dag-cbor, CIDv1, `0x71`. Token-state
  predicates, genesis data, coin data, transition records, inclusion
  proofs — every reachable element is its own block.

## Per-codec `dag/put` invariants

The Phase 2 pin function `pinCarBlocksToIpfs` parses a CAR locally and
pins each block individually via Kubo's
`POST /api/v0/dag/put?input-codec=…&store-codec=…&pin=true&hash=sha2-256`.
The `input-codec` and `store-codec` query parameters MUST match the
block's actual codec — otherwise the gateway reads the bytes as some
other type, computes a different CID, and the recipient's
`block/get(bundleCid)` 404s.

### Codec routing rules

| Multicodec | Hex   | Routing                                   |
|------------|-------|-------------------------------------------|
| `dag-cbor` | 0x71  | `?input-codec=dag-cbor&store-codec=dag-cbor` |
| `raw`      | 0x55  | `?input-codec=raw&store-codec=raw` (legacy backcompat) |
| anything else | —  | rejected — the SDK only emits dag-cbor and raw blocks |

`profile/ipfs-client.ts:pinSingleBlock` derives the codec from the
block's CID multicodec prefix automatically — callers do not need to
know the Kubo wire vocabulary.

### Why not `dag/import`

Kubo exposes a `/api/v0/dag/import` endpoint that imports a full CAR
in one round-trip, but the Unicity gateways disable it by default
(hardened API surface). `dag/put` is universally available across
Kubo deployments, including the public testnet gateway. The trade-off
is one HTTP round-trip per block; the SDK can parallelise if latency
becomes a concern.

## Why this model

### Goal: dedup at every layer

Before Phase 2 (PR landed in commit f938e4c), the SDK pinned each
bundle CAR as a **single raw block** (`pinToIpfs(carBytes)` with raw
codec, CID = `sha256(carBytes)`). Consequences:

- A bundle that re-published the same token N+1 times across N+1
  send/receive cycles produced N+1 distinct raw-CID blobs on IPFS even
  though all but one byte of content was repeated.
- Sub-token components (predicates, types, proofs) were never
  individually addressable. Recipients could not verify a single token
  in isolation.

Phase 2 migrated the bundle path to `pinCarBlocksToIpfs` + per-block
`dag/put`. The block-level dedup payoff is realised immediately at the
storage layer; the architectural payoff (per-token / per-sub-element
addressability) is realised by the existing canonical
`uxf/ipld.ts:exportToCar` builder, which already emits a hierarchical
DAG with CID links between layers.

### Goal: partial recovery

Once profile snapshots and bundle CARs share the hierarchical model
(Phase 4), a wallet can fetch the snapshot root, decode the bundle CID
list, and selectively fetch only the bundles relevant to its tracked
addresses. Likewise, a recipient that only needs one token from a
multi-token bundle can fetch that token's root CID directly and walk
its subtree without paying for the sibling tokens' blocks.

### Goal: forward-compat with new sub-component types

Future SDK versions might add new sub-token components (e.g. richer
proofs, multi-issuer signatures, …). Because every element is its own
content-addressed block, adding a new element type does not change the
CIDs of existing elements. Old recipients ignore unknown CIDs in
unfamiliar fields and continue to verify the known sub-tree. The
manifest's `tokens` map is the only fixed interop surface.

## Determinism — what defeats dedup

Dedup payoff is realized **only when content is byte-identical**.
Anything that introduces non-determinism into the serialisation
defeats it:

- **Timestamps in element bodies.** Avoid `Date.now()` inside any
  element content. Bundle envelopes carry timestamps deliberately and
  are bundle-unique by design; element bodies must not.
- **Randomised salts that vary per emit.** A salt MUST be fixed by the
  underlying token state, not regenerated each export. The deconstructor
  pool already enforces this — `deconstructToken(pool, token)` is a
  pure function of `token`.
- **Map iteration order.** The dag-cbor encoder sorts map keys
  lexicographically as part of its canonical form, so JavaScript
  `Map` insertion order does not leak into the CID. Verified by
  `tests/unit/uxf/ipld.test.ts:computeCid > deterministic`.
- **Floating-point fields.** Avoid. All numeric fields are integers or
  string-encoded big integers.

## Implementation map

| Concern                                  | File                                                 | Function                              |
|------------------------------------------|------------------------------------------------------|---------------------------------------|
| Element → IPLD block                     | `uxf/ipld.ts`                                        | `elementToIpldBlock`, `computeCid`    |
| Bundle build (envelope+manifest+tokens) | `uxf/ipld.ts`                                        | `exportToCar`                         |
| Bundle import (BFS, verify, repool)      | `uxf/ipld.ts`                                        | `importFromCar`                       |
| Per-block IPFS pin (producer)            | `profile/ipfs-client.ts`                             | `pinCarBlocksToIpfs`, `pinSingleBlock`|
| Per-block IPFS fetch (consumer, BFS)     | `profile/ipfs-client.ts`                             | `fetchCarFromIpfs`                    |
| Canonical UXF publisher (wire path)      | `modules/payments/transfer/ipfs-publisher.ts`        | `createUxfCarPublisher`               |
| Phase 1 wiring (PaymentsModule deps)     | `modules/payments/PaymentsModule.ts`                 | `PaymentsModuleDependencies.publishToIpfs` |
| Phase 1 wiring (Sphere → factories)      | `core/Sphere.ts`, `impl/browser/index.ts`, `impl/nodejs/index.ts` | `_publishToIpfs`, `publishToIpfs` field |

## Verification

- **CID-correspondence contract.** `tests/unit/payments/transfer/ipfs-publisher.test.ts`
  — the publisher's returned CID equals `extractCarRootCid(carBytes)`.
- **Per-block pin walk.** `tests/unit/profile/fetchCarFromIpfs.test.ts`
  — Phase 2 BFS walker round-trips, raw-codec backcompat, shared-block
  dedup, malformed-CID rejection.
- **Cross-bundle dedup.** `tests/unit/uxf/cross-bundle-dedup.test.ts`
  — two bundles sharing a token (and even bundles whose tokens differ
  but share sub-elements) collapse to fewer unique CIDs than the naive
  block-count sum.
- **Per-token addressability.** `tests/unit/uxf/per-token-addressability.test.ts`
  — envelope→manifest→token-root chain is walkable by CID; each token
  subtree is isolated from siblings.
- **Production wiring.** `tests/unit/payments/publish-to-ipfs-wiring.test.ts`,
  `tests/unit/impl/nodejs/providers-publish-to-ipfs.test.ts` —
  `publishToIpfs` propagates from provider factory → Sphere →
  PaymentsModule → sender deps.

## Phase 4 — Hierarchical profile snapshots (lean snapshot v3)

The lean profile snapshot — the payload published to the aggregator
pointer to propagate every per-device write across a wallet's HD
addresses — followed the bundle-CAR migration in Phase 4. Schema
**v3** replaces the v2 single-block layout (`entries[]` inline in the
root block) with a hierarchical DAG: the root block carries a sorted
list of `entryGroups[*]` CID references, one per group; each ref
points at a dag-cbor sub-block holding that group's encrypted KV
entries.

### v3 root + sub-block layout

```
Snapshot root (dag-cbor, codec 0x71)
├─ version: 3
├─ chainPubkey, network, createdAt
├─ entryGroups: [                                  ← sorted by groupKey
│    { groupKey: "DIRECT_aabbcc_ddeeff",
│      entriesCid: CID(...) ───────────────────→ Per-group entries sub-block
│      entryCount: N }                                ├─ groupKey: "DIRECT_aabbcc_ddeeff"
│    { groupKey: "DIRECT_112233_445566",              └─ entries: [{ key, value }, …]
│      entriesCid: CID(...) },                                       (sorted by key)
│    { groupKey: "__global__",
│      entriesCid: CID(...) },
│  ]
└─ bundles: [{ cid, status, createdAt, tokenCount? }, …]    ← already CIDs, inline
```

### Group key derivation

A KV key's group is the leading addressId capture of the regex
`^(DIRECT_[0-9a-f]{6}_[0-9a-f]{6})\.` — mirroring the regex used by
`profile/profile-snapshot-dispatcher.ts` to partition incoming
snapshots by writer. Keys that do not match (mnemonic, master_key,
addresses.tracked, tokens.bundle.*, consolidation.*, etc.) map to
`__global__`. The grouping is byte-deterministic — two builds of the
same Profile state produce identical sub-block CIDs.

### What v3 buys

1. **Cross-snapshot dedup.** Two snapshots whose entries for a given
   address group are byte-identical share the same sub-block CID and
   dedup at the IPFS storage layer. A wallet whose `__global__` group
   never changes (no new mnemonic, no new master key, etc.) republishes
   the same global sub-block CID across every snapshot — only the
   root and the changed per-address sub-blocks accumulate fresh CIDs.
2. **Partial-recovery fetch.** A receiver that knows it only needs a
   specific HD address can fetch the root block plus that single
   address sub-block, skipping every other group. The wire cost of a
   targeted apply drops from O(total wallet KV bytes) to O(address
   KV bytes + root metadata).
3. **Group-level fault isolation.** A corrupted per-address sub-block
   surfaces as a clean error scoped to that group's writers; the rest
   of the snapshot still applies.

### No back-compat with v2

Per the issue #200 non-goal disclaimer, the parser does NOT accept the
pre-cutover v2 single-block layout. Both the builder AND the parser
are pinned to v3 exactly — a v2 payload reaching the parser triggers
an explicit `version 2 is not accepted` error. Wallets re-flush on
first publish under the new layout (the pointer's local-version
cursor stays behind; the next reconcile pass naturally picks up the
fresh v3 head). v1 (the fat `profile-export.ts` back-up format)
remains rejected by the lean reader.

### Parser API

- `parseLeanProfileSnapshot(carBytes)` — single-shot parser for the
  in-process CAR path. Walks every per-group sub-block present in
  the same CAR (no IPFS round-trip) and materialises the flat
  `entries[]` view.
- `parseLeanProfileSnapshotFromRootBlock(rootBytes, fetcher?)` — the
  production path. Pass a `fetcher` (production wiring binds to
  `fetchFromIpfs(gateways, cid)`) to pull each per-group sub-block by
  CID. Omitting the fetcher returns the root metadata plus an empty
  `entries[]` (useful when the caller defers entry loading to a
  partial fetch). On an empty wallet (zero entry groups) the fetcher
  is never invoked and may be omitted.
- `parseLeanProfileSnapshotPartial(rootBytes, fetcher, options)` —
  fetches ONLY the requested address groups (and, by default, the
  global group). Returns the materialised entry slice plus
  `unfetchedGroupKeys` listing every group the filter skipped.
  `bundles[]` is always populated regardless of the entries-side
  filter (it lives in the root block).

### Implementation map

| Concern                                  | File                                                 | Function                              |
|------------------------------------------|------------------------------------------------------|---------------------------------------|
| v3 builder (groupKey partition + emit)   | `profile/profile-lean-snapshot.ts`                   | `buildEntryGroupBlocks`, `assembleCarBytes` |
| v3 root-block parser + sub-block walker  | `profile/profile-lean-snapshot.ts`                   | `parseLeanProfileSnapshotFromRootBlock`, `fetchAndDecodeAllGroupEntries` |
| v3 partial-fetch parser                  | `profile/profile-lean-snapshot.ts`                   | `parseLeanProfileSnapshotPartial`     |
| Production fetcher wiring (pointer-poll) | `profile/factory.ts`                                 | `setApplySnapshotCallback` (binds fetcher to `fetchFromIpfs`) |
| Production fetcher wiring (fetchAndJoin) | `profile/pointer-wiring.ts`                          | `buildFetchAndJoin` (binds fetcher to `fetchFromIpfs`) |
| Per-block IPFS pin (producer)            | `profile/ipfs-client.ts`                             | `pinCarBlocksToIpfs` — already handles multi-block CARs |

### Verification

- **Multi-block emit + determinism.** `tests/unit/profile/profile-lean-snapshot-v3.test.ts`
  — root + N sub-blocks; two builds of the same state yield identical
  sub-block CIDs.
- **Cross-snapshot dedup.** `tests/unit/profile/profile-lean-snapshot-v3.test.ts`
  — two snapshots sharing an address group share that group's
  sub-block CID; union of pinned blocks < sum of per-snapshot blocks.
- **Fetcher walk + group validation.** `tests/unit/profile/profile-lean-snapshot-v3.test.ts`
  — parser walks per-group sub-blocks via the supplied fetcher;
  sub-block with wrong internal `groupKey` is rejected.
- **Partial fetch.** `tests/unit/profile/profile-lean-snapshot-v3.test.ts`
  — only requested address sub-blocks fetched; `unfetchedGroupKeys`
  reports skipped groups; `includeGlobal: false` skips the global
  sub-block too.
- **No v2 back-compat.** `tests/unit/profile/profile-lean-snapshot-v3.test.ts`
  — hand-crafted v2 single-block CAR is rejected with an explicit
  version error (both via the CAR parser and the root-block parser).
- **Sub-block validation.** `tests/unit/profile/profile-lean-snapshot-v3.test.ts`
  — sub-block with wrong internal groupKey, mismatched entry count,
  or duplicate keys is rejected.

## Phase 5 — Hierarchical fat profile snapshot (export/import)

The operator-facing back-up format (`profile/profile-export.ts`,
`profile/profile-import.ts`) was the last CAR-producing path still
embedding bundle bytes as opaque concatenations. Phase 5 migrates it
to the hierarchical CAR shape so:

1. Two bundles sharing a sub-component (the same predicate, the same
   token, an empty manifest, …) collapse to a single block in the
   snapshot CAR.
2. Importing a snapshot into a wallet that already has some bundles
   pinned is a no-op for the shared blocks — `dag/put` is idempotent
   under canonical CID.
3. Backup files shrink in proportion to the bundle-internal
   redundancy ratio of the source wallet.

### v2 root + bundle DAG layout

```
Snapshot root (dag-cbor, codec 0x71)
├─ version: 2
├─ chainPubkey, network, createdAt
├─ entries: [{ key, value }, …]                  ← ciphertext KV entries, sorted by key
└─ bundles: [                                    ← sorted by cid (string)
     { cid: <bundle root CID>, status, createdAt, tokenCount? },
     …
   ]

CAR blocks following the root (one entry per unique CID across all bundles):

  <bundle1RootCid>  (dag-cbor envelope)
  <manifest1Cid>    (dag-cbor)
  <token1Cid>       (dag-cbor)
  <predicateCid>    (dag-cbor)                   ← shared between bundle1 + bundle2 → ONE block
  <bundle2RootCid>  (dag-cbor envelope — different from bundle1's)
  …
```

The `bundles[i].cid` strings are the bundle root CIDs; the importer
walks each root via dag-cbor link traversal across the snapshot's
shared block map to reconstruct the bundle's full reachable DAG.

### What v2 buys

1. **Cross-bundle dedup in the snapshot.** A shared sub-component
   appears once in the CAR regardless of how many bundles reference
   it. `result.uniqueBundleBlocks` reports the union size.
2. **Per-block re-pin on import.** `pinCarBlocksToIpfs` re-pins every
   block in each reconstructed bundle CAR under its canonical CID —
   the gateway's `dag/put` is idempotent, so an importer hitting a
   block already pinned by an earlier bundle is a no-op.
3. **Schema continuity with Phase 2 wire path.** The bundle blocks in
   the snapshot CAR are byte-for-byte the same dag-cbor sub-blocks
   that `pinCarBlocksToIpfs` emits on the bundle-publish path; no
   format translation is needed across export → import → re-pin.

### Legacy raw-codec bundles

Some wallets may carry pre-Phase-2 bundle index entries whose `cid`
is a raw-codec `sha256(carBytes)` over the whole bundle CAR. The
export path handles those defensively:

- `fetchCarFromIpfs` short-circuits raw-codec roots to a single
  `block/get` (the legacy semantics).
- The export side stores the returned bytes under the original raw
  CID as a single raw block in the snapshot CAR.
- The import side walks the raw block as a single-block bundle DAG
  (raw blocks are dag-cbor-link leaves by definition) and re-pins
  through `pinCarBlocksToIpfs`, which preserves the raw-codec pin
  semantics for legacy CIDs.

### No back-compat with v1

Per the issue #200 non-goal disclaimer, the parser does NOT accept
the pre-Phase-5 v1 flat-CAR layout (each bundle CAR wrapped as a
single raw block keyed by `sha256(bundleCar)` and authenticated by a
re-hash pass). Both the builder and the parser are pinned to v2
exactly — a v1 payload reaching `parseProfileSnapshot` triggers an
explicit `Snapshot version 1 is older than this SDK accepts` error.
Operators with pre-cutover backup files must re-export from a wallet
running this SDK version.

### Implementation map

| Concern                                  | File                                                 | Function                              |
|------------------------------------------|------------------------------------------------------|---------------------------------------|
| Bundle DAG fetch + block-union assemble  | `profile/profile-export.ts`                          | `readAndFetchBundles`, `assembleCarBytes` |
| Snapshot CAR parse + per-bundle DAG walk | `profile/profile-export.ts`                          | `parseProfileSnapshot`, `reconstructBundleCar` |
| Per-bundle re-pin (block-by-block)       | `profile/profile-import.ts`                          | `pinAndRegisterBundle` (delegates to `pinCarBlocksToIpfs`) |
| Per-block IPFS pin (producer)            | `profile/ipfs-client.ts`                             | `pinCarBlocksToIpfs`, `pinSingleBlock` |

### Verification

- **Round-trip.** `tests/unit/profile/profile-export.test.ts`
  — export+parse preserves KV entries; embedded bundles recoverable;
  byte-deterministic with fixed `createdAt`.
- **Cross-bundle dedup.** `tests/unit/profile/profile-export.test.ts`
  ("dedups bundle sub-blocks shared across multiple bundles") — two
  bundles whose manifest blocks are byte-identical share that block
  in the snapshot; `uniqueBundleBlocks < sum of per-bundle block
  counts`.
- **Diagnostic count.** `tests/unit/profile/profile-export.test.ts`
  ("reports `uniqueBundleBlocks` count") — surfaces the union size
  for CLI / operator reporting.
- **Version cutover.** `tests/unit/profile/profile-export.test.ts`
  ("rejects pre-Phase-5 v1 snapshots") — hand-crafted v1 doc
  rejected with an explicit version error.
- **Bundle authentication.** `tests/unit/profile/profile-export.test.ts`
  ("rejects forged-CID bundle CARs") — bundle ref pointing at a CID
  absent from the snapshot CAR is skipped on parse; the snapshot
  root's CID-binding check rejects a CAR whose framed root does not
  match the root block content.

## Known follow-up: bundle CAR sub-block CID/bytes mismatch

Surfaced by the PR #201 steelman pass. `uxf/ipld.ts:elementToIpldBlock`
deliberately computes a sub-block's framed CID from the **hash
canonical form** of an element (children encoded as raw hash bytes)
while emitting the sub-block bytes as the **IPLD form** (children
encoded as CID-link Tag-42 references). The two encodings differ
byte-for-byte, so for any non-empty bundle:

```
sha256(block.bytes) != block.cid.multihash.digest
```

Consequence: a recipient calling `block/get(subBlockCid)` against a
Kubo gateway that recomputed CIDs at `dag/put` time (as Kubo does by
default) will 404 on the affected sub-blocks. The gateway stored the
bytes under `sha256(bytes)` rather than under the framed CID.

Bundle ROOT CIDs (envelope + manifest) match by construction —
those blocks have no child CID refs and the hash/IPLD forms coincide.
The current `fetchCarFromIpfs` walk works for envelope + manifest
but degrades to 404 for the deeper sub-blocks.

This is **pre-existing behavior** (predates issue #200 — the Phase 2
work migrated to per-block pinning but did not reconcile the codec
mismatch). Production paths today don't hit the failure mode because
recipients fetch the bundle by ROOT CID via `fetchCarFromIpfs` and
decode the bundle locally rather than fetching each sub-block
individually. The mismatch matters only if someone introduces a
direct `block/get(subBlockCid)` consumer.

**To fully close the issue:** make `elementToIpldBlock` compute the
framed CID from the actual emitted bytes (`sha256(dagCborEncode(ipldForm))`)
and propagate the change through `contentHashToCid` so OrbitDB refs,
manifest links, and on-wire CID tags all reference the canonical
post-IPLD CID. This would also re-enable per-block CID-binding
verification at every receiver site (including
`parseProfileSnapshot`). Scope is too large for #200; tracked as a
separate follow-up issue.

## See also

- [Issue #199](https://github.com/unicity-sphere/sphere-sdk/issues/199) — the snapshot path bug that exposed the
  raw-CID-vs-dag-cbor-CID mismatch and shipped the `pinCarBlocksToIpfs`
  primitive.
- `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #15 — the broader
  full-profile-snapshot sync work.
- `profile/ipfs-client.ts` — primary source-of-truth for the per-block
  pin/fetch primitives.
- `uxf/ipld.ts` — primary source-of-truth for the bundle DAG layout.
