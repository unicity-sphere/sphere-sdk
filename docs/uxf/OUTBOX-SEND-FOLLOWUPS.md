# OUTBOX/SEND Pipeline — Open Follow-Up Work

**Status**: Issue #166 closed 2026-05-17. This document tracks deferred work that did NOT land in the closing PRs but is structurally part of the same pipeline.

**Integration branch**: `integration/all-fixes` (head as of close: `9051159`).

**Audience**: a fresh agent / future maintainer resuming work on the sending side of UXF transfers. Each item is self-contained — read the linked code, then the item's own section, and you should have enough to start.

---

## Architecture recap (skip if you already know)

The OUTBOX/SEND pipeline coordinates a token bundle's journey from the sender's wallet to the recipient and to the permanent SENT ledger. Components, in order of execution:

1. **Source selection** (`PaymentsModule.dispatchUxf{Conservative,Instant}Send` → `selectSources` hook) — picks tokens, marks them `'transferring'`.
2. **Duplicate-bundle guard** (`PaymentsModule.assertNoDuplicateBundleMembership`, Issue #166 P2 #2) — refuses if any picked token already in OUTBOX/SENT unless `allowDuplicateBundleMembership=true`.
3. **Commit** (`commitSources` hook) — creates aggregator commitments.
4. **Bundle packaging** (`modules/payments/transfer/{conservative,instant}-sender.ts`) — assembles the UXF CAR file, pins to IPFS (if CID-mode), writes OUTBOX entry at `'packaging' → 'pinned' → 'sending'`.
5. **Publish** (`transport.sendTokenTransfer`) — Nostr publish; returns event id. Conservative + instant paths both capture the eventId now (Issue #166 P2 #3).
6. **Delivered transition** — OUTBOX entry → `'delivered'` (conservative) / `'delivered-instant'` (instant). The eventId is persisted onto the OUTBOX entry.
7. **SENT-ledger write** (`PaymentsModule.writeSentEntryFromOutbox`) — copies the OUTBOX entry into the SENT ledger (the permanent record). `nostrEventId` propagates from OUTBOX to SENT.
8. **OUTBOX tombstone** — on SENT-write success the OUTBOX entry is tombstoned (Lamport-stamped per Issue #166 P1 #2). On SENT-write failure the OUTBOX entry is **kept live at `'delivered'` for forensic record** (round-2 steelman fix in `fcf1d53`).
9. **Reconciliation** (`SentReconciliationWorker`, Issue #166 P2 #4, default-ON) — retries SENT writes for delivered-but-unreconciled entries.
10. **Recovery** (`SendingRecoveryWorker`, default-ON) — re-publishes entries stuck in `'sending'`.
11. **Retention verification** (`NostrPersistenceVerifier`, Issue #166 P2 #3, default-OFF) — re-queries the relay for retained events; emits `transfer:retention-warning` on detected drops.
12. **Orphan detection** (`PaymentsModule.detectOrphanSpendingTokens` → `sweepOrphanSpendingTokens`, Issue #166 P2 #1) — finds tokens stuck `'transferring'` with no matching OUTBOX/SENT entry; optionally auto-recovers (default-OFF).

The OUTBOX is a working queue that **drains** to SENT as deliveries complete. Tombstones (NOT `db.del()`) are the drain mechanism — they survive CRDT merge against concurrent writes.

---

## What landed in Issue #166 (for reference)

| Bucket | Item | PR | Merge |
|--------|------|----|-------|
| P3 + P4 | 8 test-coverage gaps + 4 defensive hardening | #167 | `d109ff8` |
| P2 #4 | SENT-write reconciliation worker | #168 | `2f379c5` |
| P2 #2 | Duplicate-bundle guard | #169 | `c612c5c` |
| P2 #3 | Nostr persistence verification | #170 | `2072f06` |
| P2 #1 | Orphan-spending auto-recovery hook | #171 | `96af490` |
| P1 #2 + #3 | Tombstone Lamport + DoS bounds | #172 | `9051159` |
| P1 #1 | AAD encryption | **DEFERRED** | — |

---

## Open follow-ups (priority order)

### 1. Aggregator cross-check before orphan recovery (P2 #1 follow-up)

**Why it matters**: today `defaultOrphanRecovery` (gated by `features.orphanAutoRecovery`, default-OFF) flips orphan token status from `'transferring'` to `'confirmed'` based purely on "not in OUTBOX or SENT." This assumes the spending commit never reached the aggregator. In the rare race where the commit DID land (crash happened between `commitSources` returning and `outbox.create` writing), the restored token's local state hash drifts from the aggregator's view — the next operation surfaces a confusing state-mismatch error.

**Acceptance criteria**:
- Before flipping status, query the aggregator for the source token's commitment state via `OracleProvider`.
- If aggregator has NO commitment → safe to restore (current behavior).
- If aggregator HAS a commitment → return `'manual'` (operator triage required because the source IS burned on-chain; recovery would require re-packaging the bundle, which is out of scope).
- Once this lands, `features.orphanAutoRecovery` can be flipped from default-OFF to default-ON.

**Files**:
- `modules/payments/PaymentsModule.ts:~3430` — `defaultOrphanRecovery` private method
- `modules/payments/transfer/orphan-spending-sweeper.ts` — sweeper passes finding to recovery hook
- `oracle/oracle-provider.ts` — find the right API to query commitment state

**Complexity**: Medium. New aggregator round-trip per orphan. Tests need a stub oracle that returns "present" / "absent" for specific token states.

**Blast radius**: Low — gated behind default-OFF flag until soak-tested.

---

### 2. Automatic re-publication of detected retention drops (P2 #3 follow-up)

**Why it matters**: today `NostrPersistenceVerifier` (default-OFF) detects a relay retention drop and emits `transfer:retention-warning`. That's all. The bundle was successfully delivered earlier (relay ack'd it) but is now gone — the recipient may have already seen it, may not have. Closing the loop means actually re-publishing.

**Acceptance criteria**:
- On `'missing'` outcome from `transport.verifyTokenTransferRetained`, transition the OUTBOX entry from `'delivered'`/`'delivered-instant'` back to `'sending'` (or new `'retention-republish-pending'` status — needs §7.0 state-machine edit).
- `SendingRecoveryWorker` then picks up the entry and re-publishes via its existing `republish` callback.
- The SENT entry stays put (it's the durable record; re-publishing doesn't unmake the historical delivery).
- Idempotency: the recipient's replay-LRU short-circuits duplicates by `bundleCid` (§6.3 / T.3.A), so re-publish is safe to fire multiple times.

**Surface area concerns**:
- Bundle payload preservation: if the original CAR was inline (`uxf-car`), the bundle bytes must still be reachable. Today they're not stored after the initial publish. Need to either (a) store the CAR locally for the retention window, or (b) downgrade re-publishes to CID-mode (requires the IPFS pin still being valid). The latter is simpler if the pin TTL exceeds the retention window.
- Recipient identity binding: if the recipient rotated keys since the original publish, re-publishing to the old key fails silently. Need a re-resolve step before re-publish.
- Key rotation on sender side: if sender rotated since publish, the original event was signed with the old key. Republishing with the new key has different event id; recipient sees it as a new event (deduplication by bundleCid still works).

**Files**:
- `modules/payments/transfer/nostr-persistence-verifier.ts` — current emit-only behavior
- `modules/payments/transfer/sending-recovery-worker.ts` — recovery worker (would handle re-publish via existing mechanism)
- `profile/outbox-state-machine.ts` — §7.0 transition table (may need a new arc)
- `modules/payments/PaymentsModule.ts:~1715-1740` — the `republish` callback the recovery worker calls

**Complexity**: Large. Probably needs its own design doc + multiple PRs (state-machine edit, bundle-payload retention, re-resolve path, etc.).

**Blast radius**: Medium. Default-OFF feature flag, but touches the §7.0 state machine.

---

### 3. `SentLedgerWriter.contains()` in-memory index (P4 #3 follow-up)

**Why it matters**: `contains(tokenId)` is O(n × m) — prefix-scan SENT, decrypt every entry, scan tokenIds. The duplicate-bundle guard (now active by default) calls `contains` per-token per-send. At ~1000 SENT entries × ~4 tokenIds = 4000 decrypts per send. Acceptable today; bad at higher SENT volumes.

**Acceptance criteria**:
- Add a lazy in-memory index `Map<tokenId, Set<entryId>>` to `SentLedgerWriter`.
- Populated on first `readAll()` call; updated on every `write()` and `delete()`.
- `contains()` uses the index for O(1) lookup.
- Index is local (not persisted) — re-derived from `readAll()` on each Sphere instantiation.
- Cost contract test from #167 P4 #3 should be updated to verify the O(1) behavior once the index is in place.

**Files**:
- `profile/sent-ledger-writer.ts:~250-275` — current `contains()` + `findByTokenId()`
- `tests/unit/profile/sent-ledger-writer.test.ts:~368-403` — existing cost-contract test that pins O(n × m); update for O(1).

**Complexity**: Small. Pure in-memory data-structure change.

**Blast radius**: Low. Behavior-preserving optimization.

---

### 4. Storage GC for tombstones

**Why it matters**: tombstones are `db.put(marker)` not `db.del()`. The OrbitDB log grows monotonically. Long-running wallets accumulate dead-key bytes forever.

**Acceptance criteria**:
- Periodic worker (or sweep at load time) finds tombstoned slots where `now - deletedAt > retentionMs` (configurable, default 30 days).
- For each, call `db.del(key)` to actually reclaim storage.
- Retention window must be long enough that no concurrent replica's pre-sync state could revive the slot. 30 days is conservative; could be tightened with measurement.
- Test: write entry, delete, advance clock past retention, sweep, verify `db.get()` returns null AND OrbitDB log no longer contains the key.

**Files**:
- New worker module: `modules/payments/transfer/tombstone-gc-worker.ts` (proposed)
- `profile/outbox-writer.ts` — needs a new method to enumerate tombstoned slots (currently they're invisible to all read paths)
- `profile/sent-ledger-writer.ts` — same

**Complexity**: Medium. The "enumerate tombstoned slots" path is new code; the worker structure can copy from `SentReconciliationWorker`.

**Blast radius**: Medium. Touches the storage layer directly; bug in retention math could prematurely delete tombstones and re-enable resurrection.

---

### 5. Soak validation + default-ON flip for the new workers

**Why it matters**: two new workers landed in default-OFF state pending soak validation:
- `features.nostrPersistenceVerifier` — adds relay query traffic
- `features.orphanAutoRecovery` — has the unsafe-race trade-off (item #1 above)

Until flipped to default-ON, these are dead code for any wallet that doesn't explicitly opt in.

**Acceptance criteria**:
- For each flag, run soak in a non-production environment for at least 7 days with the flag ON.
- Measure: relay query rate (for verifier), false-positive orphan recoveries (for recovery — should be zero after item #1 lands).
- Document soak findings; flip the flag default to `true` in `PaymentsModule.ts:~1440-1460` (`features` defaults block).
- Update tests that explicitly disable these flags via `features: { ... = false }` — those tests run with the default; flip is backward-compatible.

**Files**:
- `modules/payments/PaymentsModule.ts:~1419-1450` — feature defaults block
- `tests/unit/modules/payments/__fixtures__/payments-module-fixture.ts` — many test fixtures disable workers; review what should change

**Complexity**: Small change once soak proves safe. Soak itself takes time.

**Blast radius**: Low — the workers are designed to self-skip when prerequisites missing.

---

### 6. Re-publish on CAR vs CID modes — bundle availability

**Why it matters**: `SendingRecoveryWorker.republish` (the default in PaymentsModule) ships `kind: 'uxf-cid'` for every re-publish, regardless of the original delivery mode. For an entry originally delivered via `kind: 'uxf-car'` (inline CAR), the IPFS pin may not exist — the recipient gets a CID they can't fetch.

**Acceptance criteria**:
- Default `republish` closure inspects `entry.deliveryMethod`:
  - `'car-over-nostr'` → re-publish inline CAR. Requires storing the CAR bytes locally for the retention window OR re-pinning to IPFS.
  - `'cid-over-nostr'` → re-publish CID (current behavior).
- If CAR bytes unavailable AND re-pin fails, log an error and transition entry to `'failed-transient'` so an operator sees it.

**Files**:
- `modules/payments/PaymentsModule.ts:~1715-1740` — default `republish` closure
- `modules/payments/transfer/sending-recovery-worker.ts` — re-publish call

**Complexity**: Medium. Bundle storage is a real architectural concern.

**Blast radius**: Low if gated behind the existing `features.recoveryWorker` flag (default-ON but already in production).

---

### 7. `lamport: 0` synthetic placeholder

**Why it matters**: `PaymentsModule.ts:~12108` synthesizes a `UxfTransferOutboxEntry` with `lamport: 0` purely so `writeSentEntryFromOutbox` can read fields off it. The `0` is a placeholder — it doesn't correspond to any real CRDT clock value. If a future code path uses `lamport` from the synthesized entry, it gets a misleading 0.

**Acceptance criteria**:
- Either thread the real Lamport from the writer's return value, or change `writeSentEntryFromOutbox`'s contract to accept an input shape that doesn't include `lamport`.
- Tests verify the SENT entry's Lamport is `>= max(observed)` not 0.

**Files**:
- `modules/payments/PaymentsModule.ts:~12099-12114` — the synthetic-construction site
- `modules/payments/PaymentsModule.ts:~3239-3275` — `writeSentEntryFromOutbox` helper

**Complexity**: Small.

**Blast radius**: Low. Cosmetic / type-correctness fix; no behavior change today because nothing reads the synthetic's `lamport`.

---

### 8. Legacy KV outbox removal

**Why it matters**: dispatchers still dual-write to the legacy KV outbox (`saveToOutbox`/`removeFromOutbox`) AND the profile-resident `OutboxWriter`. The legacy path was "preserved during the transition window" per #97's landing notes. No documented end-date.

**Acceptance criteria**:
- Audit all callers of `saveToOutbox`/`removeFromOutbox`. Determine if any consumer outside the dispatchers still depends on the legacy storage shape.
- If none: rip out the legacy storage path. Dispatchers stop calling `saveToOutbox`/`removeFromOutbox`. The legacy storage adapter (`TxfStorageDataBase._outbox`) becomes dead code.
- If some: document the constraint and set a hard end-date.

**Files**:
- `modules/payments/PaymentsModule.ts` — search `saveToOutbox`, `removeFromOutbox`
- `storage/token-storage-provider.ts` — `TxfStorageDataBase` shape
- All `TokenStorageProvider` implementations — check if any read the legacy `_outbox` field

**Complexity**: Medium. Cross-cutting; needs careful audit.

**Blast radius**: High if rushed. Multiple consumers may have written assumptions on the legacy shape.

---

### 9. Concurrent-replica integration tests

**Status (2026-05-18)**: Writer-layer scope **MERGED** on `integration/all-fixes` (commit `0b169f7`). Real-OrbitDB-log scope **STILL OPEN**.

**Scope clarification.** Originally this item was framed as "OrbitDB Hash Log lex-sort conflict resolution between concurrent profile peers." A subsequent architectural review (see "Pointer-layer vs OrbitDB-log layering" in Cross-cutting concerns below) showed that framing conflated two different layers:

- **Profile-state convergence** — "which CAR is the current profile?" — is resolved by the **aggregator pointer mechanism**, not by OrbitDB log layer. Each profile flush publishes a CID to the Unicity aggregator (`profile/aggregator-pointer/*`, `profile/lifecycle-manager.ts`); peer reconciliation reads the latest authoritative pointer, fetches its CAR from IPFS, and JOINs into local state via `pointer-wiring.ts:buildFetchAndJoin`. OrbitDB's pubsub is wired but **demoted to a hint channel** that triggers an aggregator poll. OrbitDB's LWW lex-sort only arbitrates which small `tokens.bundle.{cid}` ref survives a concurrent same-key write — and the IPFS-level JOIN then operates over all bundle refs present regardless of which LWW win put each one there. **No correctness gap at this layer.**

- **Per-entry-key OUTBOX/SENT writes** — the `${addr}.outbox.${id}` and `${addr}.sent.${id}` slots written directly by `OutboxWriter` / `SentLedgerWriter`. **These are NOT pointer-published.** They are not bundled into CARs. Their conflict resolution is OrbitDB's Hash Log layer (LWW lex-sort on entry hashes for concurrent writes to the same key). The CRDT machinery shipped under #166 P1 #2 (Lamport stamps + tombstones + refuse-write guard) is the right layer of defense for these — and **this is the layer this item now targets**.

**What MERGED covers (writer-layer)**

`tests/integration/profile/concurrent-replica-outbox.test.ts` exercises every invariant the writer layer can guarantee against concurrent peers via a shared-storage two-writer harness (one `MockProfileDb` shared between two `OutboxWriter` / `SentLedgerWriter` instances with separate Lamport clocks). 11 tests cover:
- Refuse-write guard across writer instances (post-sync resurrection blocked).
- Lamport monotonicity across writers, including observing remote *tombstone* Lamports.
- Pre-sync race resolution (tombstone-arrives-first → guard fires; live-write-arrives-first → tombstone wins on subsequent reads).
- SentLedgerWriter mirrors the same invariants, including cross-instance `contains()` index visibility after item #3.

**What's STILL OPEN (real-OrbitDB-log layer)**

Real `@orbitdb/core` Hash Log lex-sort under live libp2p replication is not exercised. Specifically: two replicas write the **same** OUTBOX/SENT key at the **same Lamport** before either sees the other. OrbitDB picks one via lex-sort on entry hashes; the loser's write is lost. The writer-layer refuse-write guard catches POST-sync resurrection attempts, but does NOT catch the PRE-sync race where both writes land "first" from their own perspective. See the "Lamport-on-tombstone" cross-cutting concern below for the full closure path.

**Acceptance criteria (residual scope)**:
- Extend `OrbitDbAdapter` to support a two-peer test mode (currently `bootstrapPeers: []` isolated only). Either a "memory transport" libp2p config or in-process TCP with manual dial-peer wiring.
- New integration test that spins up two adapters pointing at the same OrbitDB database address, connected via libp2p, and exercises:
  - Concurrent writes from both replicas at adjacent Lamports — assert one wins via OrbitDB log layer and the loser observes the winner on next read.
  - Pre-sync concurrent tombstone vs live-write — assert behaviour matches the §7.0 contract (LWW; loser must observe + bump past on next read).
- Quantify how often the pre-sync race occurs in practice (operational data — separate effort).

**Files**:
- Done: `tests/integration/profile/concurrent-replica-outbox.test.ts` (writer-layer harness).
- Open: extend `profile/orbitdb-adapter.ts` for two-peer test mode; add a follow-up integration test that uses it.

**Complexity (residual)**: Large. Real OrbitDB + libp2p in tests is heavyweight; adapter changes touch the libp2p config path.

**Blast radius (residual)**: Low. Test-only addition; adapter test-mode changes are gated behind an opt-in config.

---

### 10. Vector vs per-entry-key design decision

**Why it matters**: in our prior conversation we surfaced that the per-entry-key OUTBOX design exists for multi-replica CRDT safety. Tombstones, Lamport bookkeeping, hydration-race handling, and the refuse-write guard are all complexity paid for that safety. If the project commits to "one active writer per wallet at a time" as a constraint, a single-vector approach (whole OUTBOX as one OrbitDB value, rewritten on add/remove) drops ~1000+ lines.

**Acceptance criteria**:
- Maintainer decision documented: either "multi-replica is a hard requirement" (keep current design) or "single-writer is an acceptable constraint" (begin migration to vector model).
- If migrating: design doc covering the migration path, on-disk format change, and how SENT (currently per-entry-key for a good reason — append-only) would or would not also migrate.
- If keeping: document the multi-replica use case explicitly so future contributors understand the cost.

**Files**:
- New: `docs/uxf/ADR-XXX-outbox-storage-model.md` (proposed)

**Complexity**: The decision is small; the migration (if chosen) is Large.

**Blast radius**: N/A for the decision; Very High for migration.

---

### 11. Operator runbooks for the new events

**Why it matters**: Issue #166 added five new operator-facing events. None have documented runbooks:
- `transfer:orphan-spending-detected`
- `transfer:orphan-recovered`
- `transfer:sent-reconciliation-recovered`
- `transfer:sent-reconciliation-failed`
- `transfer:retention-warning`

Operators receiving these have no documented "do this" guidance.

**Acceptance criteria**:
- New doc `docs/uxf/RUNBOOK-SEND-PIPELINE.md` with a section per event.
- For each: what the event means, what state the system is in, what diagnostic data to collect, what actions to take.
- Reference from CLAUDE.md.

**Files**:
- New: `docs/uxf/RUNBOOK-SEND-PIPELINE.md`
- `CLAUDE.md` — add a pointer

**Complexity**: Small (writing only).

**Blast radius**: None — documentation.

---

### 12. Consumer-facing API docs for new events

**Why it matters**: same five events lack public API documentation. Apps consuming `sphere.on('transfer:...')` need to know the payload shapes and when they fire.

**Acceptance criteria**:
- Add each event to `CLAUDE.md`'s "Key Events" table.
- Update `docs/API.md` (if it exists) or wherever the public event reference lives.

**Files**:
- `CLAUDE.md` lines around the "Key Events" table

**Complexity**: Small (writing only).

**Blast radius**: None.

---

### 13. AAD per-record encryption (P1 #1 — DEFERRED)

**Status**: deliberately deferred per maintainer call. Not on the near-term roadmap.

**Why it's deferred**: implementing requires threading `AAD = TextEncoder().encode(fullKey)` through every `encrypt` / `decrypt` call across all profile writers: `OutboxWriter`, `SentLedgerWriter`, `DispositionWriter`, `FinalizationQueueStorageAdapter`, `RecipientContextStorageAdapter`. Project-wide change.

**Risk if left undone**: the keyspace ciphertext-lift attack documented in `profile/encryption.ts:85-94` — an attacker with OrbitDB write access can swap encrypted blobs between any two keys that share the same encryption key. Two writers sharing the same key (e.g. outbox + sent on same address) can have ciphertext lifted from one keyspace into the other.

**When to revisit**: when threat model includes peers with OrbitDB write access, or when peer-replicated profile writers are extended to a new data type that warrants the audit.

**Files** (for the future):
- `profile/encryption.ts` — current `encryptProfileValue` / `decryptProfileValue` signatures
- Every callsite of those two functions (search for them with `grep -rn`)

---

### 14. Multi-device concurrent double-spend reconciliation (NEW 2026-05-18)

**Why it matters**: when two peers share the same Profile (e.g. desktop + mobile signed into the same wallet) and concurrently spend the SAME token T to DIFFERENT destination addresses, the L3 aggregator anchors exactly ONE commitment (the source `stateHash` can only be spent once). The other peer's `submitTransferCommitment` throws. The codebase handles the on-chain safety correctly — no double-delivery of value — but the LOSER's local state is left in an inconsistent state that the system has the information to fix automatically but currently doesn't.

**Background evidence** (from the 2026-05-18 code investigation):

- Aggregator-level: only one commit lands. `PaymentsModule.ts:11207-11212` throws on the loser's `submitTransferCommitment` rejection. **The throw is not caught with a state-recovery handler** — the loser's source token stays at `status='transferring'` indefinitely.
- Balance: `aggregateTokens` (`PaymentsModule.ts:~7001-7048`) correctly excludes `'transferring'` tokens from `confirmedAmount` (spendable balance is conservative). BUT it INCLUDES them in `unconfirmedAmount` and `totalAmount`. **Loser's unconfirmed balance is inflated by the token's value indefinitely.**
- JOIN at sync: contrary to the stale comment at `profile/pointer-wiring.ts:36-40`, the per-token resolver `resolveTokenRoot` (`uxf/token-join.ts:210-330`) IS implemented and IS wired by `profile-token-storage-provider.ts:683-773`. It ranks chain heads by `(committedCount DESC, length DESC, rootHash ASC)` and surfaces incompatible chains as `kind: 'divergent'`. Rule 4 enrichment fires when an oracle is wired (`verifyInclusionProof`).
- Orphan sweeper: `defaultOrphanRecovery` (post-item-#1) correctly returns `'manual'` for the loser's stuck token (aggregator says SPENT — but by the winner's commit, not by the loser's). Emits `transfer:orphan-spending-detected`. **This conflates a crash-window orphan with a concurrent-peer double-spend loss.**

So the JOIN layer already knows the truth. The OUTBOX state machine and the local Token status do not learn it.

**What works correctly today**

- No fund double-spend. The L3 aggregator is the conflict authority.
- No spendable-balance corruption. Both peers correctly exclude `'transferring'` tokens from confirmed/spendable balance.
- JOIN-time resolution. When both peers' profiles are merged on any device (post-sync), the on-chain winner's chain head is deterministically preferred.
- Audit trail. Loser's failed OUTBOX entry is preserved.

**Acceptance criteria** (numbered work items; can be split into separate PRs):

1. **Classify the aggregator rejection.** Tag the throw at `PaymentsModule.ts:11207-11212` with a typed `SphereError` code distinguishing `STATE_ALREADY_SPENT_BY_OTHER` from generic commit failure. The aggregator response should carry enough metadata to detect "the state IS spent — but by a commit whose recipient differs from the one we just tried to submit." Where it doesn't, the dispatcher re-queries `oracle.isSpent(sourceStateHash)` to disambiguate.

2. **Dispatcher catch + state transition.** On `STATE_ALREADY_SPENT_BY_OTHER`:
   - Move the OUTBOX entry to a terminal `'failed-conflict'` status (NEW — see #3 below). The bundle was never delivered; the entry is a forensic record of the lost race.
   - Restore the source token's `status` from `'transferring'` to a state that reflects "spent by another peer" — proposal: a new `'spent-by-other'` status (or reuse `'spent'` with an `error`-style marker) so balance computation excludes it from `unconfirmedAmount` as well as `confirmedAmount`.
   - Emit the new `transfer:double-spend-detected` event (see #4).

3. **§7.0 state-machine: add `'failed-conflict'` status + arcs.** New canonical UxfOutboxStatus. Reachable via `sending → failed-conflict` (and possibly `packaging → failed-conflict` if the commit throws very early). Terminal — no outgoing arcs except the operator override (mirrors `'failed-permanent'`). Update `outbox-state-machine.test.ts` snapshot count (19 → 21 rows assuming two new arcs).

4. **New event `transfer:double-spend-detected`.** Payload: `{ tokenId, sourceStateHash, ourIntendedRecipient, winningChainHead?, detectedAt }`. Distinct from `transfer:orphan-spending-detected` (crash-window) so operators / UIs can route them differently. Add to `SphereEventMap` in `types/index.ts` and to the Key Events table in `CLAUDE.md`. Operator action documented in `docs/uxf/RUNBOOK-SEND-PIPELINE.md`.

5. **Wire JOIN divergent outcome → local Token.status.** When `UxfPackage.merge` produces a `divergent` outcome and the winning rootHash is NOT the local belief, update the local Token (`status`, `sdkData`) to reflect the winner's chain head. Today this signal is computed inside the resolver and used to write the merged package, but the consumer (`PaymentsModule`'s token cache) doesn't observe the divergent flag — it just consumes the merged package's tokens. Tests: a JOIN-divergent test that asserts the local `Token.status` flips after merge.

6. **Update the stale comment** at `profile/pointer-wiring.ts:36-40`. It currently claims Rules 3+4 are absent; the resolver landed and is wired. Replace with a forward reference to the resolver and to this item for the residual local-state-update wiring.

7. **Orphan sweeper disambiguation.** When `defaultOrphanRecovery` finds the aggregator says SPENT, today it returns `'manual'` and emits `transfer:orphan-spending-detected`. Once #4's event lands, the sweeper should re-query the aggregator's commit DETAIL (which recipient was anchored?) and, if the anchored recipient ≠ this peer's local outbox entry's recipient, emit `transfer:double-spend-detected` instead. If aggregator returns ambiguous data or no detail, fall back to the legacy detected event.

8. **`getAssets` / balance regression test.** Assert that a `'spent-by-other'` (or equivalent terminal) token is excluded from BOTH `confirmedAmount` and `unconfirmedAmount` — so the loser's UI numbers converge to the truth after reconciliation.

**Files**:
- `modules/payments/PaymentsModule.ts:~11207-11212` — submit throw classification + dispatcher catch.
- `core/errors.ts` — new `STATE_ALREADY_SPENT_BY_OTHER` error code.
- `types/index.ts` — new `'transfer:double-spend-detected'` event + payload; possibly new `TokenStatus = 'spent-by-other'`.
- `profile/outbox-state-machine.ts` — new `'failed-conflict'` status + arcs.
- `tests/unit/profile/outbox-state-machine.test.ts` — row-count snapshot bump.
- `profile/profile-token-storage-provider.ts:~683-773` — wire JOIN divergent outcome to local Token.status.
- `modules/payments/transfer/orphan-spending-sweeper.ts` — disambiguation with aggregator detail.
- `modules/payments/PaymentsModule.ts` (`defaultOrphanRecovery` ~3462) — emit `transfer:double-spend-detected` when applicable.
- `profile/pointer-wiring.ts:36-40` — update stale comment.
- `CLAUDE.md` — add new event to Key Events table.
- `docs/uxf/RUNBOOK-SEND-PIPELINE.md` — add new event's operator section.

**Complexity**: Medium. Cuts across the dispatcher, the §7.0 state machine, balance computation, and the JOIN consumer. Each work item (1-8) is small in isolation; the integration is the medium part. Tests must cover the multi-device scenario end-to-end with a deterministic loser/winner setup.

**Blast radius**: Medium. New state-machine arcs require careful release coordination with already-deployed wallets (a wallet that hasn't learned about `'failed-conflict'` would treat it as an unknown status and the type guards would filter it out — same conservative behaviour as today). Local Token-status mutations on JOIN divergence are observable to UIs subscribed to `transfer:*` and `address:*` events; UI changes may be needed downstream.

**Suggested PR split**:
- Phase 1 (small): items 1, 2, 4 — classify the throw, surface the new event, transition OUTBOX to `'failed-conflict'`. Don't yet update local Token.status — rely on the existing JOIN at next sync for that. Phase 1 alone is enough to stop the "stuck `'transferring'` forever" symptom for the operator-visible surface.
- Phase 2 (medium): items 3, 5, 7, 8 — proper §7.0 state-machine entry, JOIN→Token wiring, orphan sweeper disambiguation, balance regression test. Closes the unconfirmed-balance gap.
- Phase 3 (small): item 6 + the CLAUDE.md / runbook updates from work items 4 and 6 — docs cleanup.

---

## Cross-cutting concerns

### Pointer-layer vs OrbitDB-log layering (architectural clarification)

The profile layer has TWO distinct distribution mechanisms running in parallel, often confused:

| Layer | What it carries | Conflict resolution |
|-------|-----------------|---------------------|
| **Aggregator pointer** | The CID of the current profile-state CAR (the `tokens.bundle.*` aggregate). One small commitment per flush, anchored to BFT-backed inclusion proofs. | Unicity aggregator's Sparse Merkle Tree provides total ordering and immutability over the sequence of profile-state pointers. Append-only by construction. See `docs/uxf/PROFILE-AGGREGATOR-POINTER-SPEC.md`. |
| **OrbitDB Hash Log** | Per-entry-key writes for OUTBOX/SENT/dispositions/etc. — direct `db.put` calls at keys like `${addr}.outbox.${id}`. NOT bundled into CARs. NOT pointer-published. | OrbitDB's underlying CRDT: LWW lex-sort on entry hashes for concurrent writes to the same key. Lamport stamps + tombstones + refuse-write guard (Issue #166 P1 #2) provide POST-sync safety. |

**Implication for the writer-layer concerns in this doc**: items #1–#9 concern OUTBOX/SENT entries that live in the OrbitDB Hash Log layer (not the pointer layer). The pointer mechanism's "Single Irreversible Provable History" guarantee covers WHICH CAR is the current profile state — it does NOT cover which value wins for an OUTBOX/SENT slot under concurrent same-key writes from two peers.

**Pubsub clarification**: OrbitDB pubsub IS still wired in `profile/orbitdb-adapter.ts:243-246` (gossipsub is a hard requirement for OrbitDB v3). It is explicitly DEMOTED to a hint channel — `lifecycle-manager.ts:27-49` treats pubsub events as a wake-up signal to poll the aggregator NOW, not as authoritative state. The aggregator pointer is the authority; pubsub is a latency optimisation (collapsing worst-case cross-device sync from ~90 s to ~1-2 s).

### Lamport-on-tombstone is incomplete CRDT semantics

We documented this in the conversation thread that led to Issue #166's close. The refuse-write guard catches the **post-sync** resurrection attempt (replica B observes A's tombstone, attempts write, refused). It does **NOT** catch the pre-sync concurrent race (both replicas write at the same time, OrbitDB picks one via LWW, the loser's signal is lost). Fully closing this requires:

- In-memory mirror that tracks tombstone Lamports
- Reader-side merge that prefers tombstone over live entry when tombstone.lamport >= live.lamport
- Two-phase tombstone propagation (replicas exchange tombstones before either acts on a key)

That's a real CRDT implementation, well beyond the scope of #166. Item #9's residual scope (real-OrbitDB-log integration test under live libp2p replication) should at least quantify how often the pre-sync race occurs in practice. **Note**: this concern lives at the OrbitDB Hash Log layer — the aggregator pointer mechanism does NOT address it because OUTBOX/SENT entries are not pointer-published (see "Pointer-layer vs OrbitDB-log layering" above).

### D0 JOIN Rules 3 & 4 — same-tokenId chain resolution (NEW)

Surfaced by the 2026-05-18 architectural review of the pointer mechanism. Documented in `docs/uxf/PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md`; called out inline at `profile/pointer-wiring.ts:36-40`.

When two profile flushes from different devices result in CARs that both list the **same `tokenId`** with **different root hashes** (concurrent operations on the same token), the JOIN at `UxfPackage.merge()` resolves the collision by **last-writer-wins on manifest insertion order** rather than by **longest-valid-chain** with proof verification:

- **Rule 3 (longest-valid-chain)**: when two manifests collide on a tokenId, prefer the chain whose head has the most aggregator-verified transitions behind it. Not implemented for the LWW path.
- **Rule 4 (proof-enrichment)**: lift verified proofs from one merge candidate into the synthesised token-root when only one side carries them. Wired for the proof-verifier path but does not influence Rule 3's gap.

**Why this is a real concern**: the pointer layer correctly resolves "which CAR is current" — both devices' CARs will be discoverable via their respective historical pointers. But when both CARs are JOINed at load time, conflicting tokenIds are resolved by insertion order (and that order is itself a function of OrbitDB LWW lex-sort timing on the `tokens.bundle.*` ref writes). For non-trivial concurrent operations on the same token from two devices, this can silently discard one device's token history.

**Why it's not in the numbered items above**: it sits one layer below the OUTBOX/SENT writer concerns and requires its own design effort. It belongs in this cross-cutting section as a forward reference; the actual closure work is tracked in the D0 audit doc.

**Recommended next action**: open a tracking issue against `pointer-wiring.ts` / `UxfPackage.merge` for the Rules 3 + 4 closure work, with proof-verifier integration to use `OracleProvider.verifyInclusionProof` as the longest-valid-chain arbiter.

### "Re-publish from where?" — bundle storage

Items #2 (retention re-publish) and #6 (CAR mode re-publish) both run into the same question: where does the re-publisher get the bundle bytes after the initial publish?

**Architectural directive (2026-05-18)**: bundle bytes are **NEVER** stored in OUTBOX, SENT, or tombstones. Only the CID is retained. The IPFS pin on our node is the source of truth for bundle bytes; Nostr carries either inline CAR (sender's choice for small bundles) or the CID-by-reference. This rules out the "keep CAR bytes in OUTBOX entry" option from the earlier draft.

**Forward path** (not yet implemented; tracked here for the future PR):

- The SENT entry already carries `bundleCid`. The IPFS pin keyed by that CID is the only place the original CAR bytes live.
- A retention-driven re-publish (item #2, post-MVP) materialises a fresh OUTBOX entry from the SENT entry (`id`, `bundleCid`, `tokenIds`, `recipientTransportPubkey`, etc.), status `'sending'`, and lets the SendingRecoveryWorker republish via its existing path. Item #6's `'cid-over-nostr'` arm handles this trivially.
- For `'car-over-nostr'` entries the sender can fetch the CAR bytes from our IPFS pin (using the SENT entry's `bundleCid`) and re-emit inline — OR transparently downgrade to `'cid-over-nostr'` if the receiver accepts either. Item #6's current behaviour (throw → `'failed-transient'`) becomes the fallback when the IPFS pin is gone.

This unblocks the `'entry-tombstoned-or-missing'` skip reason on `transfer:retention-republish-skipped` (item #2's most common skip case) for both delivery modes.

---

## How to resume cold

1. **Read this file top to bottom.**
2. **Check the integration branch head** (`git log integration/all-fixes -1`). If it's still at `9051159` or thereabouts, the work below the table starts from there. If it's advanced, check what's landed since.
3. **Pick a numbered item.** Items 1, 2, and 3 are the highest-value next steps. Items 11 and 12 are quick wins (docs only).
4. **Branch off `integration/all-fixes`** (per CLAUDE.md convention).
5. **For each item, the "Files" section is the entry point.** Read those files first; the rest of the codebase will follow.
6. **Run the suite frequently**: `npx vitest run tests/unit/profile/ tests/unit/modules/payments/ tests/unit/payments/transfer/ tests/unit/core/` covers everything #166-adjacent in ~60s.
7. **Open one PR per numbered item** unless two are tightly entangled (item #1 might enable flipping #5's flag — fine to bundle).

## How to NOT resume

- Don't open another PR against `main`; the integration branch is `integration/all-fixes`.
- Don't re-litigate the tombstone vs vector debate (item #10) without first getting a maintainer call. We had this conversation; it's documented but not decided.
- Don't try to start P1 #1 (AAD) — explicitly deferred. If you think it should be revisited, ping the maintainer first.
- Don't flip `features.orphanAutoRecovery` or `features.nostrPersistenceVerifier` to default-ON without first landing items #1 and #5 respectively. They're default-OFF for documented reasons.

## See also

- Issue #166 (closed): https://github.com/unicity-sphere/sphere-sdk/issues/166
- PR #167 — P3 + P4
- PR #168 — P2 #4 SENT reconciliation
- PR #169 — P2 #2 duplicate-bundle guard
- PR #170 — P2 #3 Nostr persistence verification
- PR #171 — P2 #1 orphan auto-recovery
- PR #172 — P1 #2 + #3 tombstone Lamport + DoS bounds
- `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7 — outbox state machine
- `docs/uxf/PROFILE-ARCHITECTURE.md` §10.12 — per-entry-key storage layout
- `profile/encryption.ts:85-94` — the AAD attack vector documented in source
