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

## Remaining phases

- **Phase 4 — Hierarchical profile snapshots.** Migrate
  `entries[]` (per-address ledger slices) into addressable sub-blocks
  so partial recovery can fetch only relevant slices.
- **Phase 5 — Profile export/import alignment.** Migrate the
  `.sphere` backup file format to the same hierarchical CAR shape so
  imports dedup against bundles already on the receiving wallet.

Both depend on the bundle-CAR shape stabilising. With Phase 2 + 3 in
place that shape is now stable and verified.

## See also

- [Issue #199](https://github.com/unicity-sphere/sphere-sdk/issues/199) — the snapshot path bug that exposed the
  raw-CID-vs-dag-cbor-CID mismatch and shipped the `pinCarBlocksToIpfs`
  primitive.
- `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #15 — the broader
  full-profile-snapshot sync work.
- `profile/ipfs-client.ts` — primary source-of-truth for the per-block
  pin/fetch primitives.
- `uxf/ipld.ts` — primary source-of-truth for the bundle DAG layout.
