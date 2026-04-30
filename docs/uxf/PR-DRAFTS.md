---
status: draft (pre-push)
purpose: PR description bodies prepared for the user to copy into GitHub when opening the cutover PR series. NOT meant to be reviewed as part of any PR — purely a staging artifact.
---

# PR Description Drafts

Two PRs are needed to land the UXF Inter-Wallet Transfer Protocol:

- **PR #1** — `feature/uxf-packaging-format` → `main` — the implementation. Covers Phase 5 (51 of 52 plan tasks across 12 waves), Phase 6 review fixes, Phase 7 steelman + recursion, and Phase 8 post-cutover refactors. **Does NOT remove legacy paths.** Default-off feature flags. Safe to merge once reviewed; produces zero behavior change for existing callers.
- **PR #2** — T.8.D production cutover — flips defaults, removes legacy single-coin TXF paths, requires the 3 external maintainer acks via `external-acks-gate.yml` CI workflow. Land after PR #1 + soak period.

---

## PR #1 — UXF Inter-Wallet Transfer Protocol — implementation

### Title

```
feat(uxf): inter-wallet transfer protocol — implementation (51 of 52 plan tasks; T.8.D cutover separate PR)
```

### Body

```markdown
## Summary

Lands the UXF Inter-Wallet Transfer Protocol implementation per
`docs/uxf/UXF-TRANSFER-PROTOCOL.md` (canonical spec) and
`docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` (52-task plan). 51 of 52 plan
tasks shipped on this branch; T.8.D (production cutover) is a separate
follow-up PR gated on external maintainer acks.

## Phases included

- **Phase 5** — implementation, 12 dependency-respecting waves, 51 of
  52 plan tasks (T.0 through T.8.E.3). Each wave verified clean (tsc
  + eslint + targeted tests + full suite) before merging the next.
- **Phase 6** — 6-agent validation review (code, refactoring,
  architecture, specs, security, ecosystem). Verdict: SHIP IT across
  all 6 agents. 9 cleanup fixes landed (commit `bb5d892`): obsolete
  `as unknown as` casts removed, stale TODO removed, ManifestCas
  docstring tightened, bounded-hold cancellation contract documented,
  CHANGELOG completeness, MAX_CLAIMED_TOKEN_IDS=256 cap.
- **Phase 7** — steelman adversarial pass + recursion. 14 hardening
  fixes (commits `3c621d7`, `6597ff6`): strict boolean enforcement on
  predicate/authenticator (defective SDK no longer can grant ownership
  / accept forged signatures), CIDv1+base32 validation in
  extractCarRootCid, tokenIds string validation + non-empty carBase64,
  decodeTransferPayload 8 MiB cap before JSON.parse, cid-fetcher
  per-gateway IDLE timer (resets on chunk read), Promise.all →
  Promise.allSettled in workers, replay-LRU senderPubkey
  canonicalization, redactCause throwing-getter defense, lamport
  Math.max → reduce (avoids RangeError on large arrays).
- **Phase 8** — 7 post-cutover refactors. 6 done (1 skipped per design
  decision):
  - importInclusionProof per-tokenId mutex.
  - Symmetric mergeManifestEntry rootHash defense-in-depth.
  - profile-token-storage-provider god-object split into 4 sub-modules
    (facade-preserved — public API byte-identical).
  - W26 cross-restart persistence + per-aggregator process-global
    semaphore.
  - sending-recovery-worker (catches `'sending'` outbox entries stuck
    by crash between commit and Nostr publish; idempotent re-publish).
  - Worker dedup (option b — functional extraction): new
    finalization-worker-base.ts owns all shared §6.1 cycle helpers;
    sender + recipient become thin clients (~3201 → ~3065 LOC, ~600
    LOC of duplicate logic deduplicated).

## Capabilities delivered

- **Three transfer modes**: conservative (proofs first, then send),
  instant (send unproven, finalize async), TXF (legacy single-token
  fallback). Feature-flag-gated dispatcher in PaymentsModule.
- **Multi-asset wire**: `additionalAssets[]` with `kind:'coin'` /
  `kind:'nft'` discriminator. Class-disjoint asset model (NFT = empty
  coinData; coin = non-empty). NFT cascade-asymmetry safeguard
  (`confirmNftPending: true` required when sending NFT-class targets
  backed by pending sources).
- **Sender pipeline**: target-validator (§4.1 step 1 + the 14 §11.2
  validation cases) → source-selector → preflight-finalize → bundle
  build (UxfPackage + CAR encode) → delivery resolver (16 KiB inline
  cap / 96 KiB relay-safe ceiling / `force-cid` / `force-inline`) →
  outbox writer → transport publish.
- **Recipient pipeline**: bundle-acquirer + bundle-verifier + replay
  LRU (per-sender sub-buckets, Note N5) → 16-worker ingest pool with
  per-tokenId queue cap (W7) → disposition engine ([A]-[F] decision
  matrix) routing through per-element verifiers (predicate /
  authenticator / continuity / proof) → disposition writer.
- **CRDT outbox**: 10-status state machine (T.6.C 17 transitions),
  CRDT merger (T.6.B 3-file split, fast-check property tests for
  associativity / commutativity / idempotency), Lamport with W39
  bounds defense, two-set commitmentRequestIds (outstanding +
  completed).
- **Operator escape hatches**: `importInclusionProof()` with all 10
  §6.3 sub-cases including override path (W30/W31/N4 audit trail);
  `revalidateCascadedChildren()` with bounded-depth + cycle defense.
- **Defenses**: race-lost detection at poll boundary
  (REQUEST_ID_EXISTS + transactionHash mismatch — NOT
  REQUEST_ID_MISMATCH); §6.3 forbidden-case → transfer:security-alert;
  trustBase staleness with two-strike refresh (T.5.F);
  per-aggregator process-global concurrency cap (W14, fixed in Phase
  8); cascade walker class-aware (coin via splitParent, NFT via
  outbox-driven); error redaction (W40) for signedTransferTxBytes.

## Test surface added

- 60+ new test files spanning unit / integration / compatibility /
  adversarial / regression / property-based suites.
- Full suite: 376 test files / 6242 passing / 13 skipped (all 13 are
  intentional — see runbook for details). 0 failures.
- T.8.A reference snapshot fixture: byte-identical CAR for a 1-token
  send pinned in `tests/fixtures/uxf-t2d-reference-snapshot/`.

## Backward compatibility

- Public API surface unchanged. `payments.send()` widening adds
  optional fields only.
- Feature flags default OFF in this PR — no behavior change for
  existing callers.
- ConnectHost `onIntent` callback widened with optional 4th
  `schemaVersion` argument; 3-argument integrators unaffected.
- 4 legacy wire shapes (Sphere TXF, V6 COMBINED_TRANSFER, V5/V4
  INSTANT_SPLIT, SDK legacy) continue to be accepted by the legacy-
  shape-adapter (T.7.B).

## Specifications & docs

- `docs/uxf/UXF-TRANSFER-PROTOCOL.md` — canonical wire-format spec.
- `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` — 52-task plan with
  dependency graph.
- `docs/uxf/CONNECT-HOST-MIGRATION-NOTE.md` — cross-repo migration
  note for agentsphere / sphere / openclaw-unicity.
- `docs/uxf/ADR-005-orbitdb-write-fairness.md` — write-fairness
  cap decision + revisit criteria.
- `docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md` — operator runbook for
  the eventual T.8.D cutover (this PR does NOT cut over; runbook is
  reference material).
- `docs/INTEGRATION.md` — operator escape hatches + 13 `transfer:*`
  events table (Phase 6 specs writer warning closed).
- `CHANGELOG.md` — Unreleased section enumerates every public API
  addition.

## Reviewing this PR

This PR is large by design (51 plan tasks landed on one feature
branch). Review approaches:

1. **Architecture-first**: read `docs/uxf/UXF-TRANSFER-PROTOCOL.md`
   §1-3 + `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §1-3. Then walk the
   commit log; each commit's title maps to a plan task.
2. **Wave-by-wave**: 12 implementation waves landed in dependency
   order. Each wave's commit prefix tells you which task and which
   spec sections it touches.
3. **Layer-by-layer**: review by directory:
   - `types/`, `core/errors.ts` — wire format + error taxonomy.
   - `modules/payments/transfer/` — orchestrators, workers, decision
     engine, verifiers. ~30 files.
   - `profile/` — outbox, manifest store, CRDT merger, state
     machine, lifecycle.
   - `tests/` — unit / integration / compatibility / adversarial /
     regression / property-based suites.
4. **Phase 6 / 7 / 8 review reports**: the validation pass surfaced
   findings + fixes. Reports are referenced in commit messages.

## What this PR does NOT do

- **Does NOT cut over.** Legacy single-coin TXF code paths are still
  present and used. Default feature flags remain OFF. No behavior
  change for existing users.
- **Does NOT flip defaults.** That's T.8.D's job (separate PR).
- **Does NOT require external maintainer acks.** That gate applies
  only to T.8.D.

## Known limitations carried into v1

- One Phase 7 steelman concern intentionally NOT fixed: the
  per-aggregator semaphore is held across the entire poll cycle
  (W14 cap = 16). Releasing across sleep windows would reduce
  head-of-line blocking under chain-mode bursts but remove the
  current backpressure guarantee. User direction: keep backpressure.
  Documented in runbook.

## Test plan

- [x] tsc clean.
- [x] eslint clean on all new/modified files.
- [x] Full test suite: 376 files / 6242 pass / 13 skipped / 0 fail.
- [x] T.8.A byte-identical CAR fixture preserved across all phases.
- [x] All Phase 7 steelman fixes' tests pass.
- [x] Phase 8 worker dedup: 27 existing test files unchanged, all
      pass.
- [x] No flaky-suite regressions (2 known pre-existing flakes pass
      in isolation; documented in runbook).

Refs: `docs/uxf/UXF-TRANSFER-PROTOCOL.md`,
`docs/uxf/UXF-TRANSFER-IMPL-PLAN.md`,
`docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md`.
```

---

## PR #2 — T.8.D Production Cutover

### Title

```
feat(uxf): T.8.D production cutover — flip defaults + remove legacy single-coin TXF paths
```

### Labels

```
t8d-cutover
```

(Required for `external-acks-gate.yml` to fire.)

### Body

```markdown
## Summary

Production cutover for the UXF Inter-Wallet Transfer Protocol.

**Pre-requisite**: PR #<NN> (`feat(uxf): inter-wallet transfer
protocol — implementation`) must be merged + soak period complete.

**External-acks gate** (REQUIRED before merge): all 3 maintainer
tracking issues must be CLOSED with label `uxf-transfer-v1-ack`:

- [ ] `unicity-sphere/agentsphere#NN` — agentsphere maintainer ack
- [ ] `unicity-sphere/sphere#NN` — sphere app maintainer ack
- [ ] `unicity-sphere/openclaw-unicity#NN` — openclaw-unicity maintainer ack

CI workflow `.github/workflows/external-acks-gate.yml` enforces this
gate. Required secret `EXTERNAL_ACKS_TOKEN` (fine-grained PAT with
`Issues: Read` scope on the 3 upstream repos) must be configured in
this repo's secrets.

## What this PR does

- **Flips feature flag defaults** (per `UXF-TRANSFER-CUTOVER-RUNBOOK.md`
  §Feature flag flips):
  - `senderUxf`: false → true
  - `recipientUxf`: false → true
  - `recipientLegacyAdapter`: false → true (so legacy senders still
    interop)
  - `recoveryWorker`: false → true
- **Removes legacy single-coin TXF code paths** per W33 ADR
  appendix in the runbook. Specific deletions enumerated in commit
  `<NN>` of this PR.
- Default `transferMode` is now `'instant'` over UXF (T.7.E semantic
  flip already documented; this PR makes it active).

## What this PR does NOT do

- **Does NOT remove the legacy-shape-adapter** (T.7.B). Inbound
  legacy wire shapes from senders that haven't migrated continue
  to be accepted indefinitely.
- **Does NOT remove the TXF sender** (T.7.A). `transferMode: 'txf'`
  remains a valid public-API value for callers that explicitly opt
  in.
- **Does NOT touch the cutover-runbook documentation** beyond a
  changelog entry. The runbook stays as reference material for the
  ops team.

## Rollout

Per `docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md`:

1. Testnet deploy + 24-hour soak.
2. Mainnet staged rollout: 5% → 50% → 100% over the documented
   window.
3. 7-day post-rollout monitoring period before declaring stable.

## Back-out

Per the runbook: revert this PR + run `tools/restore-legacy-outbox.ts
--addr <addr> --profile-path <path>` on each affected wallet.
Idempotent. Sentinel preserved by default; `--clear-sentinel` opts
in to allow migration re-run.

## Test plan

- [x] tsc clean.
- [x] T.8.A byte-identical CAR regression fixture passes.
- [x] T.6.D.2 restore-legacy-outbox round-trip integration test
      passes.
- [x] external-acks-gate.yml workflow fires on this PR (label
      `t8d-cutover` set).
- [ ] All 3 external-ack tracking issues closed.
- [ ] Testnet 24-hour soak completed.
- [ ] Operations team sign-off per runbook §Pre-cutover checklist.

Refs: `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.8.D,
`docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md`.
```
