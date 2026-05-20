Resume Item #15 operational-closure work on branch feat/outbox-followups-item15-phase-a.
Canonical status: docs/uxf/OUTBOX-SEND-FOLLOWUPS.md (Item #15 status table + cross-cutting items).
Phase A–G already shipped; soak/default-ON is OUT OF SCOPE.

Address these gaps, each as its own commit (`feat(#166): ...` or `fix(#166): ...`)
with a follow-up `docs(#166): record ...` to flip the doc:

1. Phase E "Known follow-up" — latent bug in poll/recovery paths.
   profile/lifecycle-manager.ts:runPointerPollOnce and
   recoverFromAggregatorPointerBestEffort still call
   bundleIndex.addBundle(recoveredCid, …) on what is now a SNAPSHOT CID,
   not a UXF bundle CID. Next load() will try to parse a snapshot CAR
   as a UXF package and fail. Add a host method
   applySnapshotIfWired(cid) symmetric to publishSnapshotIfWired(), route
   both paths through it, drop the addBundle call. Unit-test the new
   method + both poll paths.

2. Item #15 B.4 — DispositionWriter scope decision + implementation.
   Three surfaces: _invalid + _audit (content-immutable, PrefixSyncWriter
   slots in directly), _manifest (Lamport+CAS with per-field merge in
   mergeManifestEntry — byte-verbatim JOIN would lose the per-field
   merge). Pick option (a)/(b)/(c) from the doc, justify briefly,
   implement, add per-writer snapshot/joinSnapshot tests mirroring
   B.2/B.3, wire into profile/factory.ts:createProfileProviders
   writersFor closure.

3. Item #2 downstream sweep — `'entry-tombstoned-or-missing'` skip should
   now be rare on the retention-republish path. Add a two-peer test in
   tests/integration/profile/ that exercises the scenario from the
   "Scope after Item #15" note and asserts the skip reason no longer
   fires once the OUTBOX entry has propagated via snapshot JOIN.

4. Item #6 downstream sweep — CAR-mode recovery worker re-publish path.
   Audit profile/* + payments/* for the CAR-mode throw added in 72879d1
   (per the "Scope after Item #15" note); confirm the bundle CID stored
   on the SENT entry is now always pinned-on-our-IPFS, so cid-over-nostr
   republish always succeeds. If true, demote the throw to a defensive
   fallback per the doc; if false, document the residual gap as a new
   item.

5. Item #14 Phase 1 — typed throw + new event + `'failed-conflict'`
   status on the transition step. Even though #15 resolves the
   loser-stuck-`'transferring'` symptom at next sync, the operator-
   visible classification is still wanted per the doc. Add the typed
   throw, emit the new event, wire the status, and unit-test.

Before starting any item, read its full section in
docs/uxf/OUTBOX-SEND-FOLLOWUPS.md and the referenced source files.
Run `npm run typecheck`, `npx eslint .` on changed files, and the
relevant `npx vitest run …` suites before each commit. Update the
canonical status (Item #15 table + the per-item "Scope after Item #15"
boxes) in the same doc commit pattern used for Phases A–G.
