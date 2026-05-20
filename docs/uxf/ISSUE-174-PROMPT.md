# Issue #174 prompt — per-token spent-state rescan worker

**Task: Implement Issue #174 — per-token spent-state rescan worker (UXF-TRANSFER-PROTOCOL.md §12.3.2)**

You're picking up Issue #174 in the `unicity-sphere/sphere-sdk` repo. Read the issue first via `gh issue view 174 --json title,body --jq .body | less` — it has the full acceptance criteria, file inventory, and rationale.

**Branch off `integration/all-fixes`** (per project convention for OUTBOX/SEND follow-ups). Suggested branch: `feat/spent-state-rescan-worker`.

## What this is

Implement the **proactive** per-token spent-state rescan that the protocol spec §12.3.2 calls for. Today only the **reactive** surface exists (PR #173 / commit `9b4fae7` — Item #14 Phase 1: `STATE_ALREADY_SPENT_BY_OTHER` typed throw + `transfer:double-spend-detected` event fire at next `send()` attempt). The proactive piece is a low-rate background worker that iterates over the active token pool and asks `oracle.isSpent(currentDestinationStateHash)` per token, so the UI doesn't show a token as spendable when another instance of the same wallet (e.g., recovered backup) has already spent it.

## Required reading (in order, ~30 min total)

1. `gh issue view 174` — the acceptance criteria.
2. `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §12.3 (whole section — the status banner explains 12.3.1 is shipped and 12.3.2 is what you're building). ~30 lines.
3. `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #16 — the closure summary that points back to this issue. ~50 lines.
4. `modules/payments/transfer/nostr-persistence-verifier.ts` — **this is the structural pattern to mirror.** A low-rate background scanner with start/stop lifecycle, eligibility filter, `runScanCycle()` testable entry point, in-flight `Promise` for graceful drain on stop, structured error classification. Read the whole file; it's ~600 lines and pretty digestible.
5. `modules/payments/transfer/disposition-engine.ts:~810-830` — the §5.3 [E] hook that already implements the off-record-spend transition. **You do NOT need to re-implement the disposition; you only need to invoke the existing path** when `isSpent === true`. Search for `currentDestinationStateHash` to see how the engine consumes it.
6. `tests/unit/payments/transfer/nostr-persistence-verifier.test.ts` — the test pattern to mirror (event recorder, deps fakes, time-skipping with vitest fake timers, eligibility/concurrency/back-off coverage).

## Key technical anchors

- **`oracle.isSpent(stateHash: string)` signature** — `oracle/oracle-provider.ts:67`. Returns `Promise<boolean>`. May throw on transient aggregator unavailability; you MUST treat throws as `unverifiable` and continue (the existing disposition engine pattern). Never produce false-positives on probe failure.
- **`currentDestinationStateHash` derivation** — this is the imprint hex of the token's *latest* destination-state hash (the state hash the next transition would consume). The disposition engine receives it pre-computed in the chain-extractor pipeline (`disposition-engine.ts:~190`), but for an active-pool token the worker needs to derive it from the token's `sdkData`. Look at how the existing chain extractor in `PaymentsModule.ts` (search for `extractPendingChain`) builds chains — the head's `destinationState.calculateHash().toJSON()` gives you the imprint hex. Reuse that pattern; don't reinvent.
- **`PaymentsModule.tokens`** — the in-memory token map. Filter to `status === 'confirmed'` (the active pool). Tokens at `'transferring'` / `'spent'` / `'pending'` are out of scope for THIS worker (orphan-spending sweeper handles `'transferring'`).
- **`suspectedSiblingInstance` detection** — when `isSpent === true`, check whether local OUTBOX + SENT have any entry referencing the token's `tokenId`. If neither does, set `suspectedSiblingInstance: true` (another instance with the same keys is the spender). If either does, set `false` (local instance is the spender; the manifest just hasn't been GC'd yet — rare edge case).
- **The `_audit` disposition path is already implemented** — `disposition-engine.ts` returns the audit record; `disposition-writer.ts:writeAudit()` routes to OrbitDB. The new worker shouldn't write to `_audit` directly; instead, instantiate the disposition engine with the same hooks Wave T.3 already uses and invoke it. Search for `oracleIsSpent` callsites in `PaymentsModule.ts` to find the wiring example.

## Acceptance criteria (from Issue #174)

1. New worker `modules/payments/transfer/spent-state-rescan-worker.ts` — structural mirror of `nostr-persistence-verifier.ts`. Default interval `TOKEN_SPENT_RESCAN_INTERVAL = 5 * 60 * 1000` ms per token; cap concurrent ≤ `MAX_CONCURRENT_SPENT_RESCANS = 4`. Respects the `oracle.isSpent` LRU cache (a recently-cached `false` doesn't force a re-query).
2. On `isSpent === true` → invoke the existing disposition writer path with `reason: 'off-record-spend'`. **DO NOT write to OrbitDB from the worker directly.**
3. New event `'transfer:off-record-spent'` in `types/index.ts` with payload `{ tokenId, detectedAt, suspectedSiblingInstance: boolean }`. Add to both `SphereEventType` union AND `SphereEventMap` interface (search the existing `'transfer:retention-warning'` event for the pattern; mirror it).
4. New feature flag `features.spentStateRescan` (default-OFF during soak). Mirror the existing `features.nostrPersistenceVerifier` / `features.orphanAutoRecovery` flags in `PaymentsModule.ts` (~line 1440). The worker only starts when this flag is true.
5. Runbook entry in `docs/uxf/RUNBOOK-SEND-PIPELINE.md` for the new event — operator action: confirm the spend happened on a sibling device, decide whether to keep the audit record or operator-override back to `'valid'` (if the spend turns out to be a false positive from a transient cache issue).
6. Tests:
   - **Unit** (`tests/unit/payments/transfer/spent-state-rescan-worker.test.ts`): happy path (`isSpent === true` → event fires with correct `suspectedSiblingInstance` value); `false` → no event; throws → no event; concurrency cap respected; LRU cache respected; start/stop idempotent; graceful drain on stop.
   - **Integration** (`tests/integration/payments/spent-state-rescan.test.ts`): full PaymentsModule fixture with a sibling-spend scenario (the token has no local SENT entry but the oracle says spent → `suspectedSiblingInstance: true`, transitions to `_audit`); the local-spend scenario (token DOES have a SENT entry → `false`).

## Workflow conventions for this repo

- **Branch:** off `integration/all-fixes` (not `main`). Use a descriptive name like `feat/spent-state-rescan-worker`.
- **Commits:** Conventional Commits. Use the `(#174)` scope so they cross-reference cleanly. Multiple small commits OK; project preserves history via merge commits, not squash.
- **Per phase, ALWAYS:** `npm run typecheck`, `npx eslint` on changed files, `npx vitest run` on related tests. Don't move on until those are green.
- **Doc updates:** when the worker lands, flip the doc status in `OUTBOX-SEND-FOLLOWUPS.md` Item #16 + `UXF-TRANSFER-PROTOCOL.md §12.3.2` (mirror the pattern used for §12.3.1 / Item #15).
- **PR:** `gh pr create --base integration/all-fixes --head <branch>` with the template the previous PRs used (search `gh pr view 173` for an example).
- **No CI** runs on `integration/all-fixes` (CI gates `main` only) — your test pass IS the merge gate.

## Suggested PR split

If the worker grows past ~600 LOC, split into two PRs:

1. **PR-A: types + worker shell + unit tests.** Lands the event type, the feature flag, the worker class skeleton with `runScanCycle()` exposed, but the `isSpent === true` branch wired to a stub that just emits the event (doesn't yet route through the disposition engine). Worker default-OFF.
2. **PR-B: disposition wiring + integration test + doc flip.** Routes `isSpent === true` through the disposition engine so the token actually transitions to `_audit`. Adds the integration test. Flips Issue #174 closed.

If it stays under ~500 LOC, ship as a single PR.

## Risk points to watch

1. **False-positive on aggregator transient failure.** The existing `oracle.isSpent` LRU cache helps. Add an extra defense: if you get N consecutive throws on the same token's probe within a window, back off that specific token rather than treating intermittent throws as "still unspent." Don't auto-transition any token to `_audit` on probe ambiguity.
2. **Race with active send.** If `send()` is mid-flight on a token, you might race the spend it's about to do. Solution: check the per-token mutex (search `PerTokenMutex` in `profile/`) or just exclude tokens that have an active OUTBOX entry from the scan eligibility filter. The orphan-spending sweeper handles the OUTBOX-active cases; this worker handles the OUTBOX-quiet cases. Don't overlap.
3. **Empty / new wallets.** When `tokens.size === 0`, the cycle should be a no-op (don't fire `oracle.isSpent` at all). Same for tokens with no `sdkData` (legacy edge case).
4. **`oracle === undefined`** — no oracle wired = no scan. Skip the cycle cleanly (mirrors how the verifier handles `sentProvider() === null`).
5. **suspectedSiblingInstance detection accuracy.** Walk OUTBOX (live entries) + SENT (durable record). If you see *any* entry referencing the token's `tokenId`, set `suspectedSiblingInstance: false`. The flag is a hint, not authoritative — operators interpret it.
6. **Test determinism.** Use vitest fake timers (`vi.useFakeTimers()`) for the interval-firing tests. The existing `nostr-persistence-verifier.test.ts` patterns work.

## What to NOT do

- **Don't re-implement the disposition engine.** It already classifies `oracle.isSpent === true` as UNSPENDABLE_BY_US per §5.3 [E]. You're wiring a NEW caller, not a new classifier.
- **Don't write to `_audit` directly from the worker.** Route through `disposition-writer.ts:writeAudit()` so the per-entry-key disposition writes go through the same path Wave T.3 ships.
- **Don't add a new `SphereErrorCode`.** This worker doesn't throw at the wallet's call boundary; it emits an event and transitions storage. No new error type needed.
- **Don't flip `features.spentStateRescan` to default-ON in the implementation PR.** That's a separate soak-gated commit later (mirrors `features.orphanAutoRecovery` Item #1's flip pattern).
- **Don't try to detect the `'_recovery-needed'` case** where the local instance IS spending the token but the local SENT entry hasn't been written yet. That's a tight race window the OUTBOX state machine already handles via `'transferring'` → `'sending'` → `'delivered'` → SENT. Trust those transitions and exclude `'transferring'` tokens from the scan.

## Quick start checklist

1. `git fetch origin integration/all-fixes && git checkout -b feat/spent-state-rescan-worker origin/integration/all-fixes`
2. `gh issue view 174` (full spec)
3. Read `nostr-persistence-verifier.ts` and its test in full
4. Read `disposition-engine.ts` lines ~190 and ~810-830
5. Skim `PaymentsModule.ts` for the `features` block (~1440) and worker start/stop pattern
6. Draft the types (event payload, feature flag, worker options)
7. Implement the worker skeleton with the `runScanCycle()` testable entry
8. Write unit tests (mirror the existing verifier tests)
9. Wire into `PaymentsModule.ts` (start/stop alongside other workers)
10. Integration test with a sibling-spend scenario
11. Doc updates: flip Item #16 in `OUTBOX-SEND-FOLLOWUPS.md`, update `UXF-TRANSFER-PROTOCOL.md §12.3.2`
12. Runbook entry in `docs/uxf/RUNBOOK-SEND-PIPELINE.md`
13. PR against `integration/all-fixes`

Expected total: 2-3 days of focused work for one senior agent. ~600 LOC of code + ~400 LOC of tests + ~50 LOC of doc updates.

Good luck. The pattern is well-established by the existing verifier worker — your job is to mirror it for the spent-state surface.
