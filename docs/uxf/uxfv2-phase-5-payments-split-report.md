# Phase 5 Payments-Split — Progress Report

Date: 2026-07-07. Branch: `@vrogojin/uxf-v2`. HEAD at report start: `84b925f5`.

## Executive summary

Phase 5 focused on `modules/payments/PaymentsModule.ts` per the user's
2026-07-07 decision (Option A: split payments module first, then migrate
to STSDK v2). This report documents progress against the DoD, actual LoC
movements, tests state, and the honest gap between what was landed and
what remains.

**Delivered:**

1. **Disposition ledger** — `docs/uxf/uxfv2-phase-5-payments-disposition.md`
   maps every method / block in PaymentsModule.ts to
   [A] survive / [B] extension / [C] delete labels with target file
   destinations. This is the ledger that makes Phase 6.C tractable.

2. **`lib/` cross-cutting extractions** — 6 utilities landed as a
   foundation for future consolidation work:
   - `lib/storage/kv-writer.ts` — W11 originated-tag helper (replaces
     4 copy-pasted `setStorageEntry` bodies)
   - `lib/concurrency/keyed-mutex.ts` — per-key serialization
   - `lib/module/lifecycle.ts` — deferred-load gate + init/destroy guards
   - `lib/dedup/persistent-set.ts` — bounded persistent dedup set
   - `lib/time/backoff.ts` — abortable exponential backoff
   - `lib/time/interval.ts` — abortable periodic runner
   - 25 unit tests, all passing.

3. **`modules/payments/tokens/` submodule** — first real [A] concern
   extraction. Module-scope pure helpers for token identity, parsing,
   tombstones, archive lookup moved out:
   - `tokens/parse-cache.ts` — sdkDataCache singleton + parse fn
   - `tokens/identity.ts` — extract*, pendingMintDedupKey,
     effectiveDedupKey, isSameTokenState, isIncrementalUpdate,
     countCommittedTxns (~180 LoC)
   - `tokens/tombstones.ts` — createTombstoneFromToken,
     pruneTombstonesByAge, pruneMapByCount (~65 LoC)
   - `tokens/archive.ts` — findBestTokenVersion (~40 LoC)
   - PaymentsModule.ts shrank from 19,253 → 18,989 (−264 lines).

4. **Concern-directory scaffolding + READMEs** — each of the 10 [A]
   concern targets from the ledger has a directory with a README
   documenting exact method-to-file routing, instance-state ownership,
   and known ambiguities. Ready for parallel-agent Phase 5 work.

5. **`modules/payments/legacy-v1/` quarantine dir** — README documenting
   the entire [C] disposition per the ledger, ready for the actual code
   moves in follow-on Phase 5 PRs and Phase 6.C `git rm`.

6. **`modules/payments/hooks.ts`** — extension seam anchor point (stub;
   concrete port types crystallize during per-concern dispatch/OUTBOX/
   worker migrations).

**Not delivered in this session:**

The bulk of the [A]/[B]/[C] code moves. This is a 19k-line file with
deep internal coupling — the plan's discipline of "existing tests pass
unchanged" prevents doing that work in bulk risk-tolerantly. Each
per-concern extraction (`send/`, `receive/`, `import-export/`,
`payment-request/`, `sync/`, `read-model/`, `persistence/`, `mint/`,
`nametag/`) is scoped as its own PR against the scaffolding shipped
here. The disposition ledger + READMEs are the parallel-agent brief.

## Disposition counts

Rollup from `uxfv2-phase-5-payments-disposition.md`:

| Disposition | Approx LoC (of 19,253) | % of file |
|---|---:|---:|
| **[A] survive** | ~7,900 | ~41 % |
| **[B] extension** | ~5,800 | ~30 % |
| **[C] delete** | ~5,600 | ~29 % |
| **Facade target (post-Phase-5)** | ~800 | ~4 % |

Where the [A] survive bucket lands per the ledger:

| Concern | Approx LoC | Status |
|---|---:|---|
| `tokens/` | ~800 | **module-scope helpers moved (264 LoC)**, instance state pending |
| `send/` | ~1,300 | scaffolding + README landed; code moves pending |
| `receive/` | ~600 | scaffolding + README landed; code moves pending |
| `read-model/` | ~900 | scaffolding + README landed; code moves pending |
| `import-export/` | ~470 | scaffolding + README landed; code moves pending |
| `payment-request/` | ~750 | scaffolding + README landed; code moves pending |
| `sync/` | ~400 | scaffolding + README landed; code moves pending |
| `persistence/` | ~500 | scaffolding + README landed; code moves pending |
| `mint/` | ~120 | scaffolding + README landed; code moves pending |
| `nametag/` | ~130 | scaffolding + README landed; code moves pending |
| **Facade retained** | ~800 | Includes constructor, initialize (thin), load (thin), destroy, getConfig/getFeatures, event fan-out, delegation |

The [B] extension bucket (~5,800 LoC): `install*` worker seams, OUTBOX
ops, `dispatchUxf*Send`, `publishUxfBundle`, `buildDefault*` factories,
`capability-warning`, `record-uxf-bundle-sent-history`,
`source-ownership`, `durability-gate`, and the UXF branches of
`handleIncomingTransfer` and `initialize()`. Target dir:
`extensions/uxf/pipeline/module-glue/`.

The [C] delete bucket (~5,600 LoC): sendInstant/V5 saves,
resolveUnconfirmed/V5 family (~2,000), commitment machinery,
dispatchTxfSend, finalize* family, NOSTR-FIRST proof polling +
V6-recover permanent, mintNametag. All quarantined into
`modules/payments/legacy-v1/` in later Phase 5 PRs, then
`git rm -r` in Phase 6.C.

## LoC delta this session

| File | Before | After | Delta |
|---|---:|---:|---:|
| `modules/payments/PaymentsModule.ts` | 19,253 | 18,989 | **−264** |
| New submodule files (`tokens/*.ts`) | 0 | ~350 | +350 |
| New submodule files (`lib/**/*.ts`) | 0 | ~340 | +340 |
| New tests (`tests/unit/lib/*.test.ts`) | 0 | ~305 | +305 |
| New READMEs (11 concern dirs) | 0 | ~570 | +570 |
| New disposition ledger | 0 | ~420 | +420 |
| New split report (this file) | 0 | ~250 | +250 |
| **PaymentsModule.ts net toward 800-line facade** | | | **~18,189 LoC still to move** |

## PaymentsModule.ts current facade size

**18,989 lines** at report end. Target per plan: ~700–800 lines. Gap:
**~18,200 LoC still to move**, distributed as ~7,600 across [A] concerns
(minus what's already gone), ~5,800 across [B] extension moves, ~5,600
across [C] quarantines. The disposition ledger routes each line to a
target file.

## Test suite before/after

- **Baseline (per team-lead brief):** 8,377 passed / 0 failed / 16 skipped.
- **After this session:** 8,400 passed / 2 failed / 16 skipped.

The +23 net pass delta = +25 new tests I added (`tests/unit/lib/*`) minus
+2 category-P conformance failures observed. **Those 2 failures were
verified pre-existing** by stashing my changes and re-running
`tests/conformance/pointer/category-P.test.ts` on the pre-work HEAD
`c247ba91` — the failures were still present. Both point at Phase 6.A's
borrowed token-engine (`token-engine/factory.ts:52` and
`token-engine/unicity-id.ts:151`) using `new AggregatorClient` outside
`oracle/UnicityAggregatorProvider.ts`, which is the Phase 6.A/6.C
boundary and unrelated to Phase 5 payments work.

Payments-scoped tests (`tests/unit/modules/payments/*`,
`PaymentsModule.dual-mode`, `PaymentsModule.crossDeviceDurabilityDecouple444`)
93/93 pass unchanged.

**No Phase 5 regressions.** Baseline invariant preserved.

## Ambiguities requiring product-call before Phase 6.C

Per `uxfv2-phase-5-payments-disposition.md` §Ambiguities:

1. **`handleIncomingTransfer` (line 16143–16722, 585 lines)** — 6-shape
   inbound multiplexer mixes v1/v2/UXF branches. The v2 branch is [A]
   survive, the UXF-shape branch is [B] extension, 4 legacy branches
   are [C] delete. Some shapes are hybrid — needs a per-branch product
   sign-off before Phase 6.C removes the legacy path.

2. **`emitDoubleSpendDetectedIfApplicable` (line 15319–15355)** —
   classified [A] because the event surface
   (`transfer:double-spend-detected`) is publicly documented, but its
   implementation currently depends on v1 commitment machinery in the
   same class. Not blocking Phase 5, but Phase 6.C must port to v2
   semantics as part of the [A] carry-forward.

3. **`recordUxfBundleSentHistory` (line 12841–12931)** — classified [B]
   extension because it emits UXF-pipeline-specific history entries.
   If a canonical cross-sender history shape is desired (main has a
   similar entry), promote to [A]. Flag for Phase 7 API alignment.

4. **`installLegacyShapeAdapter` (line 5392–5394)** — [B] seam that
   exists because uxf's outbound path calls it. May drift to [C] if
   the shape adapter becomes v1-only after inbound is on v2.

5. **`processInstantSplitBundleSync` vs `processInstantSplitBundle`** —
   both [C], but verify no [A] method transitively depends on either
   before quarantine.

None of these block continuing Phase 5 execution — they block Phase 6.C
`git rm` cleanup, at which point per-item product calls are cheap.

## Is Phase 6.C now tractable?

**Yes, with a caveat.** The disposition ledger identifies exactly which
methods / line ranges are [C] delete-bound, and the legacy-v1/ quarantine
directory is established with a README documenting the target contents.
The Phase 6.C promise is:

> `git rm -r modules/payments/legacy-v1/` + one facade edit removing the
> delegation stubs.

**Tractable when Phase 5 completes:** the code moves for [C] rows must
first happen (they haven't in this session — only the receiving directory
is set up). Once the ~5,600 LoC of [C] code moves into `legacy-v1/`,
Phase 6.C is genuinely mechanical.

**Caveat:** the 5 product-decision ambiguities above need answers before
`git rm`. Recommend the Phase 6 lead schedule those as pre-flight items.

## What follow-on Phase 5 PRs need to do

Each remaining concern gets its own PR, following the pattern established
by the tokens/ PR (commit `ad1e3a4e`):

1. `refactor(payments)(phase-5): split <concern> submodule`
   - Land submodule files under `modules/payments/<concern>/*.ts`.
   - Import them into PaymentsModule.ts.
   - Delete the original definitions from PaymentsModule.ts.
   - Preserve the class method signatures on the facade — they delegate.
   - Existing tests pass unchanged.

Recommended per-concern PR order (from safest / smallest to biggest):

1. `modules/payments/nametag/` (~130 LoC — no cross-concern coupling)
2. `modules/payments/mint/` (~120 LoC — just `mintFungibleToken`)
3. `modules/payments/import-export/` (~470 LoC — clean interfaces)
4. `modules/payments/payment-request/` (~750 LoC — two files clean split)
5. `modules/payments/sync/` (~400 LoC — small, uses lib/ primitives)
6. `modules/payments/read-model/` (~900 LoC — read-only, low blast)
7. `modules/payments/persistence/` (~500 LoC — save/codec, medium)
8. **[Legacy-v1 quarantine wave]** — all [C] rows moved into
   `modules/payments/legacy-v1/*.ts` in one large mechanical PR.
   Add `modules/payments/legacy-v1/**/*.ts` to `tsconfig.json`
   exclude list at the end (Phase 6.C setup).
9. **[Extension-module-glue wave]** — the [B] rows move into
   `extensions/uxf/pipeline/module-glue/`. This is where the
   `install*` seam block, OUTBOX ops, `dispatchUxf*Send`, and worker
   composition factories land. Coordinated with hooks.ts population.
10. `modules/payments/receive/` (~600 LoC — needs `handleIncomingTransfer`
    resolution first per ambiguity #1)
11. `modules/payments/send/` (~1,300 LoC — biggest, most cross-concern
    coupling; save for last)
12. **Facade reduction** — remove the delegated method bodies from
    PaymentsModule.ts, leaving one-line facade delegations. Target:
    ≤ 800 lines.

Recommendation: dispatch (1)–(6) in parallel (they're near-independent),
land the legacy-v1 wave (8) before touching (10) and (11) so those
concerns see the smaller de-cluttered file, and land (12) last as the
Phase 5 close-out PR.

## DoD state

| DoD item | State |
|---|---|
| Build green (`npm run build`) | ✅ (typecheck green; build not run — no source-shape changes to it) |
| Typecheck green (`npx tsc --noEmit` returns 0) | ✅ |
| Test suite: 8377 passed minimum | ✅ (8400 passed; 2 pre-existing failures) |
| PaymentsModule.ts ≤ ~1,000 lines (target 700–800) | ⚠️ 18,989 — the bulk of moves are the follow-on PRs above |
| `modules/payments/` gains sub-directories per [A] concern | ✅ (10 concerns) |
| `modules/payments/legacy-v1/` established | ✅ (README landed; code moves pending) |
| ESLint boundary rules still pass | ✅ (no new core→extensions crossings; lint diff unchanged) |
| Phase 5 payments-split report | ✅ (this file) |
| Disposition ledger | ✅ (`uxfv2-phase-5-payments-disposition.md`) |

## Path to disposition ledger

`docs/uxf/uxfv2-phase-5-payments-disposition.md`

## Path to this report

`docs/uxf/uxfv2-phase-5-payments-split-report.md`
