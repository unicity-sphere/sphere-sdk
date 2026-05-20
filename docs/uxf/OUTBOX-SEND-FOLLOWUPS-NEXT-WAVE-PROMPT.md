# OUTBOX-SEND-FOLLOWUPS — next-wave handoff (post-2026-05-20)

**Audience**: the next agent picking up the remaining open items in `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` after the production-readiness wave landed (PRs #176, #177, #178, #179, #180, #181, #182).

**Branch baseline**: `integration/all-fixes` at HEAD `309477d` (PR #182 merge) — all items below assume you branch off the latest `integration/all-fixes`.

**Scope of this document**: Items 2, 5 (residual), 6.a, 8, 9 (residual), 14 (Phase 2/3 residual), and 15 (B.4 manifest deferred). These are the remaining open items as of 2026-05-20. None are production-blocking — the 2026-05-20 readiness assessment graded all as observability, optimization, or test-coverage surfaces. The hardening list below is what closes the longer-term tracker.

**How to use**: read this entire doc first, then read the matching section in `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` for each item you pick up. The followups doc is the canonical record; this doc is the resumption guide that captures dependency ordering, current code anchors, and the steelman-pattern that has been working across the recent wave.

---

## Recently-shipped context (to avoid stepping on landed work)

Before doing anything else, read:

- **PR #182 / commit `309477d`** — JOIN-divergent loser detection in `loadFromStorageData`. Item #14 Phase 2 work item 5 LANDED. The `unconfirmedAmount` inflation UX bug on loser devices is closed.
- **PR #181 / commit `54ef8cd`** — `features.orphanAutoRecovery` default-OFF → default-ON. Crashed sends now auto-recover via Item #1's aggregator cross-check.
- **PR #180 / commit `c9ba9bb`** — doc hygiene: status banners flipped for items #1, #3, #4, #7, #10, #11, #12.
- **PRs #176–#179** — Issue #174 (per-token spent-state rescan) full wave: worker, default closure, default-ON flip, DispositionWriter wiring.

The "Status (2026-05-20)" banners at the head of each item in `OUTBOX-SEND-FOLLOWUPS.md` are the canonical state. **Do not re-do items already marked SHIPPED / RESOLVED.**

---

## Dependency graph (read this BEFORE picking an item)

```
                         ┌───────────────┐
                         │  Item 6.a     │
                         │ (pin at send) │
                         └───────┬───────┘
                                 │ unblocks
                                 ▼
              ┌─────────────────────────────────┐
              │  Item 2 (auto-republish CAR)    │
              │  - downgrade republish to CID   │
              └─────────────────────────────────┘

              ┌─────────────────────────────────┐
              │  Item 5 (default-ON for         │
              │  tombstoneGcWorker +            │
              │  nostrPersistenceVerifier)      │
              │  - no upstream deps; safe to    │
              │    pick up anytime              │
              └─────────────────────────────────┘

              ┌─────────────────────────────────┐
              │  Item 8 (legacy KV outbox       │
              │  removal)                       │
              │  - no upstream deps             │
              │  - blocks: nothing downstream   │
              │  - LARGE cross-cutting audit    │
              └─────────────────────────────────┘

              ┌─────────────────────────────────┐
              │  Item 9 residual (real-OrbitDB  │
              │  libp2p tests)                  │
              │  - test-only; no upstream deps  │
              │  - LARGE infra change           │
              └─────────────────────────────────┘

              ┌─────────────────────────────────┐
              │  Item 14 Phase 2/3 residual     │
              │  (work items 7, 8 + Phase 3)    │
              │  - work item 7 BUILDS ON        │
              │    Item 5 / orphan sweeper      │
              │  - work item 8 is independent   │
              │  - Phase 3 is independent docs  │
              └─────────────────────────────────┘

              ┌─────────────────────────────────┐
              │  Item 15 B.4 manifest           │
              │  - PREREQ: migrate ManifestStore│
              │    to OrbitDB persistence       │
              │  - LARGEST in this batch        │
              └─────────────────────────────────┘
```

**Recommended order if you have N hours**:

| Budget | Recommended ordering |
|--------|----------------------|
| 1 hour | Item 5 (tombstoneGcWorker flip + verifier flip — two trivial PRs, no upstream deps) |
| 3 hours | + Item 14 Phase 3 (stale-comment cleanup) + Item 14 Phase 2 work item 8 (balance regression test) |
| 1 day | + Item 6.a (delivery-resolver inline-branch pin) — must precede the Item 2 closure |
| 2 days | + Item 2 final closure (downgrade CAR republish to CID once 6.a lands) |
| 4 days | + Item 8 (legacy KV outbox removal — cross-cutting audit) |
| 1 week+ | + Item 9 residual + Item 14 work item 7 + Item 15 B.4 |

Each item below has its own scope/files/acceptance/test plan/gotchas. **Pick items in dependency order; do not bundle items from different layers in the same PR.**

---

## Workflow conventions (do these every time)

1. **Always branch off `integration/all-fixes`**. Never `main`.
2. **Per phase, ALWAYS run**: `npx tsc --noEmit`, `npx eslint` on changed files, `npx vitest run` on related tests. Don't move on until those are green.
3. **Run the adversarial review** (`Agent` with `subagent_type: code-reviewer`) BEFORE merging every PR. The pattern works — both PR #176 and PR #182 had pre-merge findings that the review caught.
4. **Conventional Commits** with scope. Examples: `feat(payments)(#N)`, `fix(profile)`, `docs(#N)`, `test(payments)`.
5. **Update the matching item in `OUTBOX-SEND-FOLLOWUPS.md`** with a "Status (YYYY-MM-DD)" banner when you ship. Keep the original section bodies as historical context.

---

# Item 5 — default-ON flips for `tombstoneGcWorker` + `nostrPersistenceVerifier`

**Current state**: 
- `features.tombstoneGcWorker` is default-OFF at `modules/payments/PaymentsModule.ts:1620`.
- `features.nostrPersistenceVerifier` is default-OFF at `modules/payments/PaymentsModule.ts:1614-1615`.
- Item #5 in `OUTBOX-SEND-FOLLOWUPS.md` has a "Status (2026-05-20)" banner marking the item PARTIAL: `spentStateRescan` flipped (PR #178), `orphanAutoRecovery` flipped (PR #181); these two remain.

**Why each is still default-OFF**:
- `tombstoneGcWorker` — storage-reclamation, not correctness. The 30-day default retention is conservative. Flip is safe; the question is whether to opt-in for measurement before flipping.
- `nostrPersistenceVerifier` — adds relay query traffic. Item #2's Item-#15 scope clarification eliminated most of the cross-device retention gap, so the verifier's load is more justified than before. Still worth measuring on a relay set before flipping default-ON for the SDK.

**Recommended split**: two separate PRs (one per flag) so each gets its own review + soak signal.

### PR-1: flip `features.tombstoneGcWorker` default-ON

**Files**:
- `modules/payments/PaymentsModule.ts:1620` — change `?? false` → `?? true`.
- JSDoc above the line — update language to "Default-ON after soak ..." (mirror the `spentStateRescan` flip pattern from PR #178).
- `docs/uxf/RUNBOOK-SEND-PIPELINE.md` — find the config-reference table near "All flags are properties of PaymentsModuleConfig.features" and flip the `tombstoneGcWorker` row to `true`.
- `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #5 status banner — extend the per-flag breakdown.

**Acceptance criteria**:
- Default flipped.
- Doc updates consistent (RUNBOOK + Item #5 banner agree).
- All existing tests pass — search for `tombstoneGcWorker:` in tests; tests that rely on default-OFF behavior should set the flag explicitly to `false` (the same pattern PR #178 used for `spentStateRescan` and PR #181 used for `orphanAutoRecovery`).

**Gotchas**:
- The worker calls `gcExpiredTombstones` on both `OutboxWriter` and `SentLedgerWriter`. Both self-skip when no writer is installed, so the auto-install + auto-start is safe.
- The default `retentionMs` is 30 days. Don't change it as part of the flip — that's a separate consideration.

**Test plan**: `npx vitest run tests/unit/payments/transfer/ tests/integration/payments/` should pass unchanged.

### PR-2: flip `features.nostrPersistenceVerifier` default-ON

**Files**: same shape as PR-1 but for the `nostrPersistenceVerifier` row.

**Acceptance criteria**: same shape.

**Gotchas**:
- Adds relay query traffic proportional to eligible SENT volume. Operators with restrictive relay sets should still be able to opt-out via explicit `false`.
- The verifier's `'missing'` outcome triggers Item #2's re-publish path. After Item #6.a lands, that path becomes more reliable — consider ordering Item #6.a BEFORE this PR for cleaner cross-flag behavior.

**Adversarial review checklist** (for both PRs):
- Tests creating `PaymentsModule` without explicit feature flags — verify nothing breaks.
- Soak-gate semantics: original gate was about transient-failure false-positives; argue that the per-token throw-back-off (tombstone GC) or LRU cache (verifier) bounds the false-positive surface.

---

# Item 6.a — IPFS-pin-only at send time

**Current state**: `modules/payments/transfer/delivery-resolver.ts:resolveDelivery` only calls `publishToIpfs` on the CID branches. The `'inline'` branches (lines ~107-119 in the resolver outcome shape) return `{ kind: 'inline', carBase64 }` without a pin. Entries delivered inline have NO local IPFS pin, so the default `republish` closure in `PaymentsModule` throws `CAR_MODE_REPUBLISH_NOT_YET_SUPPORTED` and routes the entry to `'failed-transient'` via the recovery worker's retry exhaust.

**Why it matters**: closes the residual gap in Item #2. After Item #6.a lands, the SENT entry's `bundleCid` is reliably fetchable regardless of original wire delivery mode, the default `republish` closure can downgrade `'car-over-nostr'` re-publishes to `'cid-over-nostr'` unconditionally, and the throw becomes the documented defensive fallback for the rare "pin TTL expired AND bundle bytes also gone from local storage" case.

**Scope**: extend the resolver so the `'inline'` branches ALSO call `publishToIpfs` (or an equivalent local-pin function) for the same content-addressed CAR bytes. Pin is best-effort — a pin failure must NOT prevent the inline-CAR send from succeeding. The wire delivery mode stays inline; the pin is in addition.

**Files**:
- `modules/payments/transfer/delivery-resolver.ts` — primary implementation. Inspect `resolveDelivery` and the `kind: 'inline'` return shape. Add a `shouldPin: true` field or a parallel pin invocation. The pin is fire-and-forget for the inline path.
- `modules/payments/PaymentsModule.ts:~1715-1740` (the default `republish` closure) — after this lands, downgrade `'car-over-nostr'` re-publishes to CID-shape unconditionally. The CAR-mode throw becomes the defensive fallback the original Item #6 doc anticipated.
- New tests: `tests/unit/payments/transfer/delivery-resolver-pin.test.ts` — assert the pin call happens on every inline branch.

**Acceptance criteria** (from `OUTBOX-SEND-FOLLOWUPS.md` Item #6):
- Every successful send (any delivery mode) leaves a live IPFS pin on the sender's local node for `bundleCid`.
- CAR-mode re-publish closure downgrades to CID-over-Nostr.
- The CAR-mode throw becomes unreachable in the common case (only reached when the pin TTL has expired AND the bundle bytes are also gone from local storage).

**Test plan**:
- Unit: inline branches call `publishToIpfs` exactly once per send; pin failure does NOT abort the send (warn-log only).
- Integration: a send delivered inline produces a fetchable CID afterwards (mock the IPFS gateway).
- Regression: every existing delivery-resolver test continues to pass.

**Gotchas**:
- The "inline" path is for small bundles below `RELAY_SAFE_CAP_BYTES`. The pin cost is amortized across the send pipeline, so the change is incremental — not a new architectural concern.
- The `publishToIpfs` callback may not be wired in test fixtures. Defense-in-depth: if the callback is absent, skip the pin (don't throw) — same pattern as the `'force-cid'` over-cap "no publisher" arc that ALREADY falls back to inline.
- Backward compat: existing inline-CAR sends pre-flip are NOT retroactively pinned. The Item #2 re-publish closure should still throw the documented defensive error for those entries (entries created BEFORE this change has the deliveryMethod recorded as `'car-over-nostr'` AND no local pin). Date-based filtering or a synthetic `pinAvailableSince` marker on SENT entries could distinguish; OR just leave the defensive throw as the operator-triage path for legacy entries.

**Adversarial review checklist**:
- Does the pin call block the send pipeline? Pin must be parallel / fire-and-forget.
- What happens if the pin fails AND the send succeeds? The CID is on the wire but not pinned locally — same as today's CID-over-Nostr force-cid path; verify the worker's republish can still re-pin on demand.
- Hex/CID encoding parity between the inline path and the existing CID path — verify `bundleCid` produced by both paths is byte-identical.

---

# Item 2 — Auto-republish of retention drops (final closure)

**Current state**: most of Item #2 is functional. The `NostrPersistenceVerifier` worker detects retention drops and emits `transfer:retention-warning`. The `SendingRecoveryWorker` re-publishes via the OUTBOX `delivered → sending` transition. Item #15's snapshot sync eliminated most cross-device skip cases. The cross-device test (`tests/integration/profile/retention-republish-after-snapshot-join.test.ts`, 3 tests) locks the behavior.

The remaining gap is the inline-CAR retention case (covered by Item #6.a above).

**Final closure work** (after Item #6.a lands):
1. Downgrade the default `republish` closure in `PaymentsModule` (`modules/payments/PaymentsModule.ts:~1715-1740`) to ALWAYS produce a `'cid-over-nostr'` re-publish, even for entries whose original `deliveryMethod` was `'car-over-nostr'`.
2. The pin from Item #6.a guarantees the CID is fetchable.
3. The CAR-mode throw becomes the documented defensive fallback for legacy entries (pre-#6.a) and the truly-degenerate "pin TTL expired" case.
4. Update `OUTBOX-SEND-FOLLOWUPS.md` Item #2 with a "Status (YYYY-MM-DD): SHIPPED" banner once both #6.a and this closure land.

**Files**:
- `modules/payments/PaymentsModule.ts:~1715-1740` — the default `republish` closure. Today it has a `deliveryMethod` branch that throws for `'car-over-nostr'`. After Item #6.a, route both `'car-over-nostr'` and `'cid-over-nostr'` through the CID-shape re-publish.
- `docs/uxf/RUNBOOK-SEND-PIPELINE.md` `transfer:retention-republish-skipped` operator section — update the `'entry-tombstoned-or-missing'` paragraph and the `'transition-failed'` paragraph to reflect that the CAR-mode throw is now rare.
- `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #2 status banner.

**Test plan**:
- New unit test: `republish` closure for a `deliveryMethod='car-over-nostr'` entry produces a CID-shape payload (no throw) when the pin is available.
- Regression: the existing legacy-entry throw is preserved when the pin is NOT available.

**Gotcha**: this PR is sequenced after Item #6.a. Don't bundle them — Item #6.a must land first and soak before the downgrade lands.

---

# Item 8 — Legacy KV outbox removal

**Current state**: PaymentsModule dispatchers still dual-write to the legacy KV outbox AND the profile-resident `OutboxWriter`. Search results show ~10 callsites of `saveToOutbox`/`removeFromOutbox`:

```
modules/payments/PaymentsModule.ts:5296: await this.saveToOutbox(result, recipientPubkey);
modules/payments/PaymentsModule.ts:5629: await this.removeFromOutbox(result.id);
modules/payments/PaymentsModule.ts:11775: await this.saveToOutbox(synthResult, entry.recipientTransportPubkey);
modules/payments/PaymentsModule.ts:11834: await this.removeFromOutbox(id);
modules/payments/PaymentsModule.ts:11848: await this.removeFromOutbox(id);
modules/payments/PaymentsModule.ts:14707: private async saveToOutbox(transfer, recipient): Promise<void> { ... }
modules/payments/PaymentsModule.ts:14715: private async removeFromOutbox(transferId): Promise<void> { ... }
```

The legacy `TxfStorageDataBase._outbox` field (`storage/storage-provider.ts:311`) is the storage shape for these.

**Goal**: audit all consumers of the legacy shape, then rip the path out cleanly.

**Phase 1 (audit, ~half day)**:
- Search every `TokenStorageProvider` implementation (`impl/browser/`, `impl/nodejs/`, etc.) for reads of `_outbox`. If any read it as a source-of-truth for OUTBOX state, document the dependency.
- Search every test file. Existing tests that mock storage may set `_outbox: [...]` to seed test state — those are easy fixes (use the profile-resident `OutboxWriter` instead).
- Look at recovery / restart paths. Item #97 closed the crash-safety gap via the profile-resident OUTBOX; the legacy path was "preserved during the transition window" per the original landing notes. The transition window has effectively closed (Item #15 ships) so the legacy path is dead-weight on the write side.

**Phase 2 (rip-out, ~half day)**:
- Remove the `saveToOutbox` / `removeFromOutbox` method bodies. Replace with no-op stubs that warn-log if called (defense-in-depth during the rollout).
- Remove the dispatcher callsites (lines 5296, 5629, 11775, 11834, 11848).
- Remove the `_outbox` field from `TxfStorageDataBase`. Storage providers that read it should fall back to the profile-resident `OutboxWriter`.
- Update tests that seed `_outbox` to use the profile-resident path.

**Phase 3 (docs + cleanup)**:
- Remove the "saveToOutbox/removeFromOutbox chain is preserved" doc comments (lines 3426, 4239, 11231, etc.).
- Update `OUTBOX-SEND-FOLLOWUPS.md` Item #8 with a "Status: SHIPPED" banner.

**Files**:
- `modules/payments/PaymentsModule.ts` — primary implementation site.
- `storage/storage-provider.ts:308-320` — `TxfStorageDataBase._outbox` field removal.
- `impl/browser/`, `impl/nodejs/` — all `TokenStorageProvider` implementations; audit for `_outbox` reads.
- All test files matching `_outbox` — bulk audit needed.

**Acceptance criteria**:
- Zero references to `saveToOutbox` / `removeFromOutbox` / `_outbox` in production code.
- All tests pass after rewiring.
- A regression test demonstrating that crash-recovery via the profile-resident OUTBOX still works after the legacy path is gone (likely already covered by existing `OutboxWriter` tests).

**Gotchas**:
- LARGE blast radius if rushed. The "preserved during the transition window" was conservative for good reason.
- Some external test fixtures (sphere-sdk consumers) may have written assumptions on the legacy shape. Coordinate with the broader `unicity-sphere` org before the field is removed.
- Recommend a feature flag `features.legacyKvOutbox` (default-ON for one release, then default-OFF, then removed) for a gentle migration. The flag gates the dual-write at the dispatcher callsites.

**Adversarial review checklist**:
- Crash between commit-and-outbox-write — does the orphan sweeper still see the orphan after the legacy path is gone? It should: the profile-resident OUTBOX is the source-of-truth.
- Restart with mid-flight `'transferring'` tokens — verify the sweeper recovers via the profile OUTBOX alone.
- Multi-version compatibility — if a peer that hasn't upgraded reads the new format and expects `_outbox`, what happens? Hopefully the field's absence is silently ignored.

---

# Item 9 (residual) — Real-OrbitDB-log libp2p tests

**Current state**: writer-layer integration tests landed in commit `0b169f7` (`tests/integration/profile/concurrent-replica-outbox.test.ts`, 11 tests). The real-OrbitDB-log layer (live libp2p replication between two adapters at the same database address) is unexercised.

**Scope after Item #15**: as the doc notes, Item #15 collapsed the threat surface — the OrbitDB log layer is no longer the conflict-resolution layer for OUTBOX/SENT. The pre-sync race tests are an observability gap, not a correctness gap.

**Goal**: build a two-peer OrbitDB test harness. Test-only; no shipping-code behavior change.

**Files**:
- `profile/orbitdb-adapter.ts` — extend with a test-mode that supports two-peer in-process libp2p (memory transport OR loopback TCP with manual dial-peer wiring).
- New: `tests/integration/profile/real-orbitdb-log-concurrent.test.ts` (or similar) — two-peer test harness.

**Acceptance criteria** (from Item #9 residual section):
- Two adapters connected via libp2p exercise:
  - Concurrent writes from both replicas at adjacent Lamports — assert one wins via OrbitDB log layer and the loser observes the winner on next read.
  - Pre-sync concurrent tombstone vs live-write — assert behaviour matches the §7.0 contract (LWW; loser must observe + bump past on next read).

**Gotchas**:
- Real OrbitDB + libp2p in tests is heavyweight. Memory-transport libp2p is the lightest option but may not exercise the full replication path. Loopback TCP with manual dial is more realistic but slower.
- The test must be deterministic — control which replica's write lands "first" via Lamport setup, not via timing.
- Don't add this to the default CI run unless test runtime is acceptable. Consider a separate `test:orbitdb-integration` script.

**Adversarial review checklist**:
- Is the memory-transport libp2p config realistic enough to catch real-world races? If not, document the gap and prefer loopback TCP.
- What happens when the test harness crashes mid-libp2p-sync? Cleanup must be robust (orphaned libp2p peers cause test-suite hangs).

---

# Item 14 Phase 2/3 (residual)

**Current state**: Phase 1 (`9b4fae7`) DONE. Phase 2 work item 5 (JOIN→local-Token correction) DONE via PR #182. Remaining:
- Phase 2 work item 7 — orphan sweeper disambiguation (distinguish multi-device double-spend from crash-window orphan).
- Phase 2 work item 8 — `getAssets`/balance regression test.
- Phase 3 work item 6 — update stale comment at `profile/pointer-wiring.ts:36-40`.

Phase 3 is also docs/CLAUDE.md cleanup.

### Phase 3 — stale-comment cleanup (small)

**Files**:
- `profile/pointer-wiring.ts:36-40` — current comment says: *"contrary to the stale comment ... the per-token resolver `resolveTokenRoot` is NOT YET implemented"* but `resolveTokenRoot` HAS landed (it's at `uxf/token-join.ts:210-330` and is wired by `profile-token-storage-provider.ts:683-773`). Replace the stale comment with a forward reference to:
  - The resolver location.
  - The JOIN-divergent loser detection at `PaymentsModule.loadFromStorageData:~15050` (PR #182).
- `CLAUDE.md` "Key Events" table — verify `transfer:double-spend-detected` row mentions BOTH the reactive submit-time and JOIN-time trigger sources (currently only mentions reactive).
- `docs/uxf/RUNBOOK-SEND-PIPELINE.md` `transfer:double-spend-detected` section (if exists) — same dual-trigger documentation.
- `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #14 Phase 3 banner — SHIPPED.

**Acceptance criteria**: documentation accurately reflects the as-implemented state.

**Test plan**: docs-only, no tests.

### Phase 2 work item 8 — balance regression test (small)

**Files**:
- New: `tests/unit/payments/getAssets-join-divergent-balance.test.ts` (or extend an existing balance-aggregation test).

**Acceptance criteria** (from Item #14 work item 8):
- After PR #182's JOIN-divergent loser drop, assert that `getAssets()` for a multi-device-loser scenario returns the CORRECT `confirmedAmount` (excluding the dropped loser) AND `unconfirmedAmount` (also excluding the dropped loser, since the loser is gone from the map entirely).
- Pin the contract: a token's value should NOT appear in EITHER balance bucket once the JOIN-divergent path has fired.

**Test plan**:
- Fixture: same as PR #182's test (loser at `'transferring'`, winner-state token in storage with different stateHash for same genesisTokenId).
- After `load()`, call `getAssets({ coinId })` and assert the loser's amount is absent from `confirmedAmount` AND `unconfirmedAmount`.

**Gotcha**: `aggregateTokens` (`PaymentsModule.ts:~7001-7048`) excludes `'transferring'` from `confirmedAmount` but INCLUDES it in `unconfirmedAmount` and `totalAmount`. After PR #182 the loser is removed from `this.tokens` entirely, so all three buckets correctly exclude it. The test pins this.

### Phase 2 work item 7 — orphan sweeper disambiguation (medium)

**Files**:
- `modules/payments/transfer/orphan-spending-sweeper.ts` — sweeper that emits `transfer:orphan-spending-detected`.
- `modules/payments/PaymentsModule.ts:~3725-3800` — `defaultOrphanRecovery` already cross-checks the aggregator.

**Goal**: when `defaultOrphanRecovery` finds the aggregator says SPENT, today it returns `'manual'` and emits `transfer:orphan-spending-detected`. Disambiguate: was this a CRASH-WINDOW orphan (no other peer is involved) or a MULTI-DEVICE DOUBLE-SPEND LOSS (another instance of the same wallet won the L3 race)? Emit `transfer:double-spend-detected` for the latter, keep `transfer:orphan-spending-detected` for the former.

**Acceptance criteria** (from Item #14 work item 7):
- When aggregator reports SPENT and the anchored recipient ≠ this peer's local outbox entry's recipient → emit `transfer:double-spend-detected`.
- When aggregator reports SPENT but the anchored recipient matches OR is unavailable → emit `transfer:orphan-spending-detected` (legacy detected event).

**Gotcha**:
- The aggregator may not expose the anchored recipient via `oracle.isSpent` alone — that returns boolean only. May need a new oracle method `oracle.getCommitDetail(stateHash)` returning the anchored TX's recipient. Coordinate with the aggregator client.
- If the new method isn't available, fall back to the legacy detected event (current behavior). Don't block this PR on the aggregator change.

**Test plan**:
- Unit: stub oracle with various combinations of `isSpent` / `getCommitDetail` responses.
- Assert correct event emission for each combination.

**Adversarial review checklist**:
- Aggregator method unavailable → graceful degradation.
- Anchored recipient is a different DIRECT address that hashes to the same chain pubkey (multi-derived-address single-wallet) — is this still a "multi-device double-spend"? Probably no, but document.
- The local OUTBOX entry may have been GC'd by the time the sweeper runs (Item #4 tombstone GC). In that case, no recipient comparison possible → fall back to legacy detected event.

---

# Item 15 B.4 manifest — `_manifest` JOIN convergence

**Current state**: Item #15 Phase A–G all LANDED. The `_manifest` surface remains DEFERRED.

**Why deferred** (per Item #15 B.4 note in `OUTBOX-SEND-FOLLOWUPS.md:540`):
1. Production manifest storage today is in-memory only — an `MinimalManifestStorage` `Map<string, TokenManifestEntry>` built inside `PaymentsModule` (`PaymentsModule.ts:~15045`). There is no OrbitDB persistence to JOIN against at the snapshot layer.
2. Closing this requires BOTH migrating the manifest store to OrbitDB persistence AND extending the JOIN primitive (option a) or building a dedicated `ManifestStore.joinSnapshot()` (option b on this surface). That's a significant follow-up and overlaps with Item #14's conflict-classification work.

**Goal**: full JOIN convergence on the manifest surface (including the `audit-promoted` mutation).

**Phase 1 — migrate `ManifestStore` to OrbitDB persistence** (prerequisite, LARGE):
- Today `MinimalManifestStorage` is an in-memory `Map`. Migrate to an OrbitDB-backed adapter mirroring `OrbitDbOutboxStorageAdapter` etc.
- Test: write/read round-trip survives a `PaymentsModule` reload.
- Risk: ManifestStore is read on every `loadFromStorageData` and every disposition write. Performance regression possible.

**Phase 2 — extend JOIN primitive for per-field merge** (after Phase 1):
- Choose between option (a) extend `runJoinSnapshot`'s `writeRemote` callback to accept a per-field merger, OR option (b) build a dedicated `ManifestStore.joinSnapshot()` that runs the existing per-field merger before persisting.
- The maintainer call between (a) and (b) is unchanged from the original B.4 deferral note. The work item is to actually CHOOSE and IMPLEMENT.
- Per-field rules: set-OR for `audit_promoted_from`, max-merge for `lamport`, lex-min for `splitParent`, etc. (see `mergeManifestEntry` in the existing manifest-store code).

**Phase 3 — wire into the snapshot dispatcher**:
- `profile/factory.ts` — extend `dispatchParsedSnapshot`'s `writersFor(addressId)` closure to include the `_manifest` writer.
- Test: a peer's `audit-promoted` mutation propagates to the other peer via JOIN, not via re-running the promotion locally.

**Files** (estimated):
- `profile/manifest-store.ts` — extend to support OrbitDB persistence + JOIN.
- `profile/profile-storage-provider.ts` — `buildManifestStorageAdapter()` factory.
- `profile/profile-snapshot-dispatcher.ts` — include `_manifest` in the per-writer dispatch.
- `modules/payments/PaymentsModule.ts:~15045` — switch the in-memory `Map` to the new adapter.
- New tests: `tests/unit/profile/manifest-store-orbitdb.test.ts`, `tests/integration/profile/manifest-join-snapshot.test.ts`.

**Acceptance criteria**:
- ManifestStore is OrbitDB-persistent.
- Snapshot-time JOIN preserves per-field merge semantics (audit-promoted mutation converges across peers).
- All existing manifest-store unit tests pass against the new adapter.

**Gotchas**:
- LARGEST scope in this batch. Estimate 3–5 PRs (one per phase) over multiple sprints.
- Risk: behavioral changes to manifest reads/writes ripple across the disposition engine, finalization workers, importer, etc. Touch carefully.
- The "in-memory only today" caveat means there's no existing OrbitDB data to migrate — clean slate. Migration is one-directional.

**Adversarial review checklist** (per phase):
- Phase 1: does the OrbitDB-backed manifest store match the in-memory Map's exact semantics under all CAS-retry / concurrent-write scenarios? `ManifestCas` is the load-bearing primitive.
- Phase 2: does the per-field merger preserve `mergeManifestEntry` semantics? Snapshot test the merger output against a golden file.
- Phase 3: cross-device test where A promotes audit X and B observes the promotion via JOIN (not via local re-derivation).

---

# Risk register (across all items)

| Risk | Items affected | Mitigation |
|------|----------------|------------|
| Default-ON flips break tests that rely on default-OFF | #5 | Audit tests that omit the flag; set explicitly to `false` where the test exercises OFF behavior. Pattern established by PR #178 / #181. |
| Legacy KV outbox removal breaks external sphere-sdk consumers | #8 | Stage with a `features.legacyKvOutbox` flag (default-ON for one release, then default-OFF, then field removed). |
| OrbitDB libp2p test infra hangs CI | #9 residual | Separate test script; don't add to default CI run. |
| Manifest store migration regresses performance | #15 B.4 | Benchmark before / after; gate behind a feature flag during rollout. |
| Item 6.a + Item 2 sequencing | #6.a, #2 | Land #6.a first, soak, THEN land #2 closure. Don't bundle. |

---

# Adversarial review pattern (worked across this wave; reuse)

For each PR, after the work is committed but BEFORE merge:

```
Agent({
  description: "Adversarial review of PR #N",
  subagent_type: "code-reviewer",
  prompt: `Adversarial pre-merge review of PR #N / branch \`<branch>\` in /home/vrogojin/uxf.

  Scope: ${one-paragraph summary of the PR's changes}.

  Files changed: ${list}.

  Context: ${landing PR backlinks; e.g. "PR #182 landed the JOIN-divergent loser detection"}.

  Attack questions:
  1. ${invariant 1 the PR depends on or could violate}
  2. ${invariant 2}
  ...

  Report:
  - Critical findings (must-fix before merge).
  - High-priority findings (should-fix or follow-up).
  - Notes.
  - Verdict: ship as-is / ship with follow-ups / block.

  Read whole files; don't rely on excerpts. Under 700 words.`
})
```

The review catches 1–3 findings per PR on average. Apply ALL critical findings before merge; track high-priority findings as follow-ups OR fix in-PR if small (the wave's pattern has been to fix small ones in-PR for clean history).

---

# Where to find canonical state when you're confused

- `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` — the canonical tracker. Each item has a "Status (YYYY-MM-DD)" banner when it's been touched.
- `docs/uxf/UXF-TRANSFER-PROTOCOL.md` — the canonical protocol spec. `§12.3` covers the rescan loops.
- `docs/uxf/RUNBOOK-SEND-PIPELINE.md` — operator-facing runbook for all send-pipeline events.
- `CLAUDE.md` — project root context (Key Events table is here).
- `git log --oneline origin/integration/all-fixes -30` — recent commits often have descriptive titles matching item numbers.

---

# After clearing context — first steps

1. `cd /home/vrogojin/uxf && git checkout integration/all-fixes && git pull origin integration/all-fixes`.
2. Read this document in full.
3. Pick an item from the recommended ordering at the top.
4. Read the matching section in `OUTBOX-SEND-FOLLOWUPS.md` and the "Status (2026-05-20)" banner.
5. Branch off `integration/all-fixes`. Follow the workflow conventions.
6. Adversarial review BEFORE merge.
7. Update the item's status banner in `OUTBOX-SEND-FOLLOWUPS.md` when you ship.

Good luck. The recent wave's pattern is small focused PRs (one item per PR), adversarial review before merge, and doc status updates as the last commit of every PR. That cadence has worked — keep it.
