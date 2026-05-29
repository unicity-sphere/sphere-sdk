# T-D0 JOIN Rules Audit — gap report

Audit target: verify that the 5 JOIN rules defined in
`docs/uxf/PROFILE-ARCHITECTURE.md` §10.4 are implemented in the current
Profile / UXF backend. Read-only; no code changes made.

## Summary

One-line verdict: **BLOCKING GAPS** — 2 of 5 rules are effectively absent.
Same-tokenId longest-**valid**-chain and proof-enrichment are not
implemented at the structural layer that performs JOIN. JOIN today relies
on instance-chain prefix-subset logic that deconstructed token-roots
never populate, and the manifest collapses same-tokenId collisions via
"source wins". Phase D must land a real per-token JOIN resolver before
the pointer work can rely on a deterministic joined view.

## Rule-by-rule findings

### Rule 1: Manifests UNIONED

- **Status:** PARTIAL
- **Evidence:**
  - `profile/profile-token-storage-provider.ts:455-464` — `load()`
    iterates every active `tokens.bundle.*` ref and calls
    `mergedPkg.merge(pkg)` once per bundle.
  - `uxf/UxfPackage.ts:473-510` (`mergePkg`) — merges element pools by
    content hash and iterates `source.manifest.tokens` into the target
    manifest at `:493-495`.
  - `profile/consolidation.ts:183-192` — the consolidation path uses the
    same `mergedPkg.merge(pkg)` loop.
- **Gap:** The union is LAST-WRITER-WINS on collision
  (`mutableManifest.set(tokenId, rootHash)` at
  `uxf/UxfPackage.ts:494`). When two bundles list the same tokenId with
  different root hashes (e.g. 5-tx chain vs 3-tx chain — token-roots are
  content-addressed so their hashes differ by tx-list length/content),
  the later-merged bundle simply overwrites the manifest entry. The
  losing root remains in the pool as an orphan but is no longer
  reachable via `manifest.tokens.get(tokenId)`. The iteration order
  over `activeBundles` in `profile-token-storage-provider.ts:455` is
  effectively the Map insertion order of `listActiveBundles()`, so the
  "winner" is implementation-defined rather than rule-driven.

### Rule 2: Element pools UNIONED

- **Status:** IMPLEMENTED
- **Evidence:**
  - `uxf/UxfPackage.ts:477-490` — every incoming element is re-hashed
    (Decision 7), verified against its key, and inserted into the target
    pool only if not already present. This is exactly the
    content-hash-dedup union described in §10.4 rule 2.
  - `uxf/element-pool.ts:28-55` — `ElementPool.put()` is idempotent on
    content hash, which backs the dedup semantics.
- **Gap:** None for the pool itself. Note the related consequence: the
  losing token-root from Rule 1 still lives in the pool (good for Rule 4
  in principle) but there is no code that subsequently uses it.

### Rule 3: Same-tokenId longest-valid-chain

- **Status:** ABSENT
- **Evidence:**
  - `uxf/instance-chain.ts:296-362` (`mergeInstanceChains`) resolves
    same-element divergence via **hash-set prefix** detection: if every
    hash in the source chain appears in the target chain it is a prefix,
    and vice versa. This is strictly a set-containment test; it does
    not look at transaction arrays, inclusion proofs, or chain validity.
  - `uxf/deconstruct.ts:114-121` — every deconstructed element is
    created with `predecessor: null`. `addInstance()` is the only
    populator of instance chains (`uxf/instance-chain.ts:73-157`) and
    is never invoked during deconstruction or merge. `rg addInstance`
    under `modules/` and `profile/` returns no hits.
  - Therefore `mergeInstanceChains()` has no data to work with for
    normal token-roots — two different-length versions of the same
    token end up as two independent token-root elements, and the
    manifest arbitrates via the last-writer-wins rule 1 behaviour.
  - `profile/token-manifest.ts:113-152` (`collectHeads`) scans
    instance-chain entries by tail equality, but because chains are
    empty in practice, it returns a single head and classifies every
    token as `valid` regardless of whether a longer bundle existed.
  - There is a TXF-level analogue in
    `modules/payments/PaymentsModule.ts:672-702` (`isIncrementalUpdate`)
    and `:748-768` (`findBestTokenVersion`) that does compare
    transaction arrays and counts committed (proof-bearing) txs — but
    this operates on already-assembled `TxfToken` pairs for the
    legacy archived/forked maps, not on bundles during JOIN.
- **Gap:** No code path during bundle JOIN:
  1. Validates the transaction chains of the two candidate token-roots.
  2. Compares their lengths.
  3. Inspects inclusion-proof presence to distinguish VALID (longest
     with proofs) from INVALID (longer but broken).
  4. Discards an invalid longer chain in favour of a shorter valid one.
  5. Flags unresolvable divergence for Section 10.7 handling.

### Rule 4: Proof enrichment

- **Status:** ABSENT
- **Evidence:**
  - `uxf/UxfPackage.ts:545-562` — `consolidateProofs()` is declared
    but throws `NOT_IMPLEMENTED` with the comment
    "not implemented in Phase 1 (Decision 9)".
  - `uxf/UxfPackage.ts:473-510` (`mergePkg`) does not cross-reference
    transactions between bundles: an incoming element is inserted only
    if the pool does not already contain an element with the same hash
    (`:487`). A pending transaction (no proof) and a finalised
    transaction (with proof) are two DIFFERENT elements with DIFFERENT
    content hashes, so both land in the pool — but no code then
    promotes the finalised version into the token-root's transaction
    list for the pending side.
  - Manifest overwrite (rule 1) prevents the finalised token-root from
    coexisting with the pending one: whichever was merged last wins
    the manifest slot, and the orphan is unreachable from assembly.
  - `profile/token-manifest.ts` deliberately scopes itself to structural
    validity and declares (line 25-27) "the oracle pass is async and
    network-dependent" — it does not touch enrichment either.
- **Gap:** No element-level proof lifting between bundles. Rule 4's
  example (Bundle A has tx[2] pending, Bundle B has tx[2] with proof →
  joined result should have tx[2] with proof) cannot occur: neither the
  instance-chain merge nor the manifest merge can produce it.

### Rule 5: Non-joined coexistence

- **Status:** IMPLEMENTED
- **Evidence:**
  - `docs/uxf/PROFILE-ARCHITECTURE.md:999` — "OrbitDB may contain
    multiple non-joined bundles temporarily — this is accepted by
    design. JOIN happens on the client when loading."
  - `profile/consolidation.ts:10-18` — consolidation is explicitly
    background / threshold-driven (3 active bundles), and superseded
    bundles are retained for 7 days; between loads each bundle exists
    independently as its own `tokens.bundle.*` KV key.
  - `profile/profile-token-storage-provider.ts:414-415` — every
    `load()` re-derives the joined view; OrbitDB itself is never
    mutated by the JOIN. If JOIN fails for a bundle the loop at
    `:460-463` simply continues, leaving that bundle available for a
    future re-load.
  - `uxf/UxfPackage.ts:473-490` — merge operates on an empty target
    package (`UxfPackage.create()` at
    `profile-token-storage-provider.ts:432`), so input bundles are
    never mutated by JOIN either.
- **Gap:** None. This rule is trivially satisfied because the system
  simply keeps each bundle's CAR intact on IPFS and its ref intact in
  OrbitDB; JOIN is a client-side, read-side derivation.

## Recommended Phase D adjustments

Rules 3 and 4 are the blocking gaps. Phase D should not assume a
correctly joined package comes out of `UxfPackage.merge()` today.

Suggested pre-Phase-D work items:

1. **Per-token JOIN resolver (`uxf/token-join.ts` or equivalent).** Given
   a tokenId and a set of `{rootHash, UxfPackageData}` candidates,
   return the `rootHash` to use and a `JoinOutcome` enum
   (`single | longest-valid | truncated | divergent`). Inputs: pool
   access for walking transaction arrays; decoder for inclusion proofs.
   Rule 3 lives here.

2. **Proof-enriched token-root rebuild.** When the resolver picks the
   longer chain but the shorter chain has better proof coverage on the
   common prefix, emit a synthesised token-root whose transaction array
   is `[enrichedTx0..enrichedTxK, longerTxK+1..longerTxN]`. Put the new
   token-root into the pool and point the manifest at it. This replaces
   the declared-but-unimplemented `consolidateProofs()` for the JOIN
   path. Rule 4 lives here.

3. **Invoke the resolver from `UxfPackage.merge()` (or a new
   `UxfPackage.join()` flavour).** The current `mergePkg` manifest
   collision handler at `uxf/UxfPackage.ts:493-495` must call the
   resolver instead of blindly overwriting. Because `mergePkg` is used
   both by runtime JOIN (`profile-token-storage-provider.ts:459`) and
   by consolidation (`profile/consolidation.ts:192`), both sites benefit
   automatically.

4. **Extend `deriveStructuralManifest()` to observe the resolver's
   `JoinOutcome`** rather than relying on instance-chain siblings — the
   current tail-anchored detector at `profile/token-manifest.ts:113-152`
   will mark nothing as conflicting because chains are never populated.

5. **Test matrix:** at minimum the four variants called out in §10.4 —
   both-valid-one-longer, both-valid-same-length-different-proofs,
   one-valid-one-invalid, divergent-siblings — plus a rule-4 enrichment
   case. No existing tests in `tests/unit/uxf/` or
   `tests/unit/profile/` exercise any of these (`rg longest|enrich`
   under `tests/` returns docs-only hits).

Until (1) and (2) land, any Phase D work that relies on the
"deterministically joined" view (pointer anchoring, oracle
reconciliation, derived caches) must treat post-merge state as
best-effort and document the caveat.
