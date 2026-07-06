# uxf-v2 Phase 1 report — Repo prep + baseline + report-only conformance harness

**Date:** 2026-07-06. **Branch:** `@vrogojin/uxf-v2`. **Executes:** [`uxfv2-execution-plan-v2.md`](../../../tmp)
§4 Phase 1 (scratchpad copy — see plan for full context).

## 1. Branch + tag

- Branch `@vrogojin/uxf-v2` created off `@vrogojin/uxf` and pushed to origin.
- Tag `uxf-v2-base` created at the branch point and pushed to origin.
- Both branch tip and tag point at `1973ee45774e240aaef9457a9f83038db94fa14f`
  (`fix(soak): trader-roundtrip §10 portfolio_balance parser — handle (#616)`).

## 2. Build

`npm run build` (tsup, ESM+CJS+DTS across all subpaths) — **green**, no errors, on Node 22.15.0.

## 3. Test baseline

`npm run test:run` (vitest, per `vitest.config.ts`: excludes `tests/e2e/**`, `tests/relay/**`,
`tests/integration/daemon-cli.test.ts`) — **fully green**:

```
Test Files  567 passed (567)
     Tests  9109 passed | 16 skipped (9125)
  Duration  73.43s (wall clock; ~285s of test time across workers)
```

Zero failures. No flakes observed in this run. Full log saved at
`/tmp/claude-1000/-home-vrogojin-uxf/dc1fd1d7-3f6d-4c05-8c74-819648ba0134/scratchpad/phase1-test-run.log`.

**On the previously-recorded flaky suites** (memory `project_test_followups_20260515.md`:
IPFS-testnet-dependent suites, dm-nip17 idle-timeout suites): those categories live in
`tests/e2e/**` and `tests/relay/**`, both excluded from `test:run` by `vitest.config.ts`. They are
out of scope for the Phase 1 baseline (which per the plan is scoped to `npm run test:run`) and
were not exercised here. No known-flake list is needed for `test:run` itself — this run had zero
flakes end to end. Numerous stderr lines in the log are expected: many tests deliberately exercise
simulated failure/error paths (e.g. `OVER_COVERAGE`, `disk full`, `AGGREGATOR_POINTER_NETWORK_ERROR`
injected faults) and log through `console.error`/`console.warn` as part of asserting on recovery
behavior — none of these are test failures.

## 4. Report-only conformance harness

Landed in `tests/harness/`:

- `dump-exports.mjs` — TypeScript-compiler-API-based export dumper (copied from the prior
  investigation's scratchpad script, unmodified — it's already generic: takes a package dir +
  entry file list, prints `{ entryFile: [{name, kind, sig, file, line}] } `JSON).
- `main-exports.json` — frozen snapshot of upstream sphere-sdk main's exported surface across all
  11 `package.json` `exports` subpaths, generated via `dump-exports.mjs` against the local
  `/home/vrogojin/sphere-sdk` checkout at commit `ce758f6b` (`chore: release v0.11.4`) — the same
  SHA cited throughout the uxf-v2 planning documents. This is source-accurate (TS compiler API over
  the actual `.ts` entry files) rather than derived from an npm-published `.d.ts` bundle, which the
  dumper requires anyway (it type-checks `.ts` sources, not compiled declarations).
- `compare-exports.py` — rewritten from the scratchpad's hardcoded-path prototype into a portable,
  always-exit-0 script: `compare-exports.py <current-dump.json> <main-exports.json>`. Reports per
  subpath (uxf-only / main-only / identical / drifted), flags the 3 main subpaths uxf entirely
  lacks (`/token-engine`, `/wallet-api`, `/impl/shared/wallet-api`) as `MISSING SUBPATH`, and
  separately lists uxf's 5 extension/delete-candidate subpaths main has no equivalent for (`/l1`,
  `/uxf`, `/profile`, `/profile/browser`, `/profile/node`).
- `run-conformance.sh` — orchestrator: dumps the current tree's exports for all 13 uxf entry files
  to a tempfile, runs the comparison, cleans up. Never fails (uses `|| exit 0` around the dump step
  and the compare script never raises a non-zero exit).

**CI wiring:** `.github/workflows/ci.yml` gained a new `conformance-report` job
(`continue-on-error: true`, Node 22) running `bash tests/harness/run-conformance.sh` after
`npm install`. **Also fixed a latent problem discovered along the way:** the existing `ci.yml`
triggers only matched `branches: [main]` for both `push` and `pull_request` — meaning CI has never
actually run on the `@vrogojin/uxf` branch lineage (confirmed via `gh pr checks 616` → "no checks
reported"). Added `'@vrogojin/uxf-v2'` to both trigger lists so build/test/harness all actually run
on this branch and its PRs going forward. This is a minimal, in-scope fix — without it the new
harness job would never execute.

**First report run** (local, matches plan's expected ballpark almost exactly):

```
Drift-vs-main (report-only; frozen snapshot main v0.11.4 @ce758f6b):
  .: uxf-only=133 main-only=50 identical=289 drifted=64
  /core: uxf-only=41 main-only=19 identical=77 drifted=20
  /impl/browser: uxf-only=1 main-only=15 identical=41 drifted=12
  /impl/browser/ipfs: uxf-only=0 main-only=0 identical=3 drifted=2
  /impl/nodejs: uxf-only=5 main-only=15 identical=21 drifted=10
  /connect: uxf-only=2 main-only=3 identical=31 drifted=10
  /connect/browser: uxf-only=0 main-only=0 identical=15 drifted=1
  /connect/nodejs: uxf-only=0 main-only=0 identical=5 drifted=0
  /token-engine: MISSING SUBPATH (32 main symbols not reachable from uxf)
  /wallet-api: MISSING SUBPATH (44 main symbols not reachable from uxf)
  /impl/shared/wallet-api: MISSING SUBPATH (15 main symbols not reachable from uxf)

Extension/delete-candidate subpaths (main has no equivalent):
  /l1: 77 uxf-only symbols
  /uxf: 83 uxf-only symbols
  /profile: 108 uxf-only symbols
  /profile/browser: 7 uxf-only symbols
  /profile/node: 6 uxf-only symbols

TOTAL (11 main subpaths): uxf-only=182 main-only=193 identical=482 drifted=119 missing-subpaths=3
```

Root-level counts (`.`: uxf-only=133, main-only=50, identical=289, drifted=64) and
missing-subpaths=3 match the plan's expected ballpark ([API §0]) exactly. This is the burn-down
metric every later phase measures against; it goes to zero-unwhitelisted-drift only at Phase 7/8.

## 5. D12 re-verification — nostr-js-sdk 0.6.0 self-wrap

Full detail: [`D12-nostr-js-06-verification.md`](D12-nostr-js-06-verification.md).

**Verdict: confirmed.** nostr-js-sdk 0.6.0's `PrivateMessageOptions`
(`dist/types/messaging/types.d.ts:55-58`) has only `replyToEventId?: string` — no `selfWrap`
concept anywhere in the package (full-tree grep returned zero matches). The [DROP Item 14]
suspicion holds: sphere-sdk's own NIP-17 self-wrap opt-out (#555/#558/#614) is not superseded by
the 0.6.0 upgrade and must be preserved through the refactor. **C1 remains a live, unresolved
decision** (whitelist `SendMessageOptions` as an additive core delta vs. push behind
`sphere.uxf.comms.sendDM`).

## 6. Deviations from the plan / anomalies

- No `dump-exports.mjs`/`compare-exports.py`/`main-exports.json` files existed on disk in the repo
  itself (as expected — they were scratchpad-only from prior investigation agents). Copied
  `dump-exports.mjs` and `main-exports.json` verbatim; `compare-exports.py` was substantially
  rewritten (the scratchpad version had absolute `/tmp/.../scratchpad` paths hardcoded and only
  covered 8 of the 11 main subpaths, silently omitting `/token-engine`, `/wallet-api`,
  `/impl/shared/wallet-api` as "missing" rather than reporting them). The rewrite fixes both.
- Fixed the CI trigger gap (branches: [main] only) described in §4 — necessary for the harness (and
  build/test) to run at all on this branch.
- Two pre-existing untracked files (`docs/DEMO-PLAYBOOK.md`,
  `docs/.#DEMO-PLAYBOOK-SWAP-ROUNDTRIP.md`) were present before this session started and are left
  untouched — unrelated in-progress work, not part of this commit.

## 7. DoD checklist

- [x] Branch exists, baseline tagged (both at `1973ee45`, pushed to origin).
- [x] Build green (Node 22.15.0, tsup, all subpaths).
- [x] Test suite green (567/567 files, 9109 passed / 16 skipped, 0 failed).
- [x] Report-only harness landed, wired into CI, publishing drift counts matching the plan's
      expected ballpark.
- [x] D12 re-verified against a real 0.6.0 install.

## 8. Can Phase 2 (L1 deletion) proceed?

**Yes.** Baseline is clean, harness is live, no blockers surfaced. Phase 2 should branch/worktree
off `@vrogojin/uxf-v2` per the plan's §4 Phase 2 spec (L1 catalog, 5-step order, cherry-pick
shortcut evaluation against upstream `cbac6f38`).
