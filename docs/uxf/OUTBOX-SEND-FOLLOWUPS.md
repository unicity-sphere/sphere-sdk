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

> **Scope after Item #15**: under full-profile-snapshot sync, OUTBOX entries propagate across peers via the pointer mechanism, so the `'entry-tombstoned-or-missing'` skip-reason on `transfer:retention-republish-skipped` becomes rare. Bundles remain pinned on our IPFS by definition (IPFS-pin-only directive); re-publishing always has the bundle bytes available via CID. See Item #15.
>
> **Locked by test** (commit `340f65d`): `tests/integration/profile/retention-republish-after-snapshot-join.test.ts` (3 tests) demonstrates the elimination of the `'entry-tombstoned-or-missing'` skip on the cross-device path. The "with snapshot JOIN" scenario asserts that after Peer A's delivered OUTBOX entry propagates to Peer B via the lean-snapshot pull, B's verifier successfully re-arms the retention re-publish (`transfer:retention-republish-rearmed`) instead of skipping. A baseline test without the JOIN step preserves the pre-Item-#15 behaviour as the contrast (the skip DOES fire) so the test scenario actually exercises the contrast. An idempotency test locks the verifier's `checkedIds` semantics.

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

> **Scope after Item #15**: per the IPFS-pin-only architectural directive, every bundle (regardless of original Nostr delivery mode) is pinned on our IPFS node. The CAR-mode re-publish throw added in commit `72879d1` becomes a defensive fallback rather than the common case — `'cid-over-nostr'` re-publish using the SENT entry's `bundleCid` always succeeds when the pin is live. See Item #15.
>
> **Audit verdict (2026-05-19, per ITEM-15-OPERATIONAL-CLOSURE-PROMPT.md gap #4): the throw is NOT YET demotable.** The IPFS-pin-only directive is aspirational; the senders' `modules/payments/transfer/delivery-resolver.ts:resolveDelivery` currently invokes `publishToIpfs` ONLY on the CID branches (`'force-cid'` and `'auto'` over-cap with publisher wired):
>
>   - `'force-inline'` → `{ kind: 'inline', carBase64 }` — **NO pin call.**
>   - `'auto'` ≤ inlineCap → `{ kind: 'inline', carBase64 }` — **NO pin call.**
>   - `'auto'` over-cap, no publisher, bundle ≤ `RELAY_SAFE_CAP_BYTES` → `carInlineFallback` returns inline — **NO pin call.**
>   - `'auto'` over-cap with publisher → `{ kind: 'cid', cid, shouldPin: true }` — pin call IS made.
>   - `'force-cid'` (requires publisher) — pin call IS made.
>
> So entries recorded with `deliveryMethod='car-over-nostr'` were inlined on the Nostr wire and **never pinned to the sender's IPFS node**. The default `republish` closure's CAR-mode throw in `PaymentsModule.ts` is therefore still the correct behaviour today for those entries — there is no IPFS pin to fall back to via `'cid-over-nostr'` re-publish. The throw routes the entry to `'failed-transient'` via the recovery worker's `maxRetries` mechanism, which is the §7.0 escape valve for operator triage.
>
> **Residual gap (sub-item 6.a — NEW)**: implement the IPFS-pin-only directive at send time by extending `delivery-resolver.ts` so the `'inline'` branches ALSO call `publishToIpfs` (or an equivalent local-pin function) for the same content-addressed CAR bytes. Once that change lands, the sender's IPFS node holds the pin for every bundle regardless of wire delivery mode, the SENT entry's `bundleCid` is reliably fetchable, and the default `republish` closure can downgrade `'car-over-nostr'` re-publishes to `'cid-over-nostr'` shape unconditionally. The current throw then truly becomes the defensive-fallback the doc anticipated. Tracked here as part of Item #6's acceptance criteria; spec-text revision suggested: "Acceptance criteria for 6.a: every successful send (any delivery mode) leaves a live IPFS pin on the sender's local node for `bundleCid`; CAR-mode re-publish closure downgrades to CID-over-Nostr; the throw becomes unreachable in the common case (only reached when the pin TTL has expired AND the bundle bytes are also gone from local storage)."

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

> **Scope after Item #15**: the OrbitDB Hash Log layer is no longer the conflict-resolution layer for OUTBOX/SENT — the snapshot pointer + per-writer JOIN takes over. The residual "real-OrbitDB-log lex-sort gap" largely dissolves; the meaningful test surface moves to "two peers concurrently flushing snapshots → JOIN convergence". See Item #15 Phase G for the new test scenarios.

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

> **Resolved by Item #15 (per-entry-key wins)**: under full-profile-snapshot sync, the per-entry-key Lamport+tombstone machinery becomes the JOIN merge function at snapshot-pull time. The complexity that was "paid for multi-replica CRDT safety" is now load-bearing for snapshot-time JOIN. The vector-model alternative loses its appeal. This item can be marked resolved once Item #15 lands.

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

> **Note on scope after Item #15**: under the full-profile-snapshot sync (Item #15), OUTBOX entries propagate via the pointer mechanism, so the racing window where two peers can both reach the aggregator with conflicting commits collapses to the pointer poll interval (typically seconds, not the indefinite "until manual sync" of today). Phase 1 of Item #14 (typed throw + new event + `'failed-conflict'` status) still wanted as the operator-visible signal; Phase 2's local-Token correction is largely subsumed by Item #15's JOIN flow.

---

### 15. Full Profile State Snapshot Sync (NEW 2026-05-18)

**Status**: design confirmed; implementation pending. Replaces the current "pointer-points-to-UXF-bundle-CID" model with "pointer-points-to-full-profile-snapshot-CID". **No backward compatibility** — the pointer scheme moves cleanly to the new format; legacy UXF-bundle-only pointers will not be supported.

**Why it matters**: today the aggregator pointer covers ONLY the UXF token bundle. OUTBOX, SENT, dispositions, finalization queue, recipient context, and all other per-writer profile state live in OrbitDB and do NOT propagate via the pointer mechanism. Cross-peer convergence for those writers relies on OrbitDB pubsub, which is wired but explicitly demoted to a hint channel (`profile/orbitdb-adapter.ts:243-246`, `profile/lifecycle-manager.ts:27-49`) — i.e. unreliable across NAT/firewalls and not authoritative.

The architectural impact of that gap: a peer that mutates an OUTBOX entry (e.g. moves an in-flight send to status `'sending'`) and then crashes leaves NO trace another peer running the same profile can observe via the authoritative channel. The orphan-spending sweeper, duplicate-bundle guard, retention re-publish, and multi-device double-spend reconciliation (items #1, #2, #14) all paper over this gap with peer-local heuristics. The clean fix is to make the pointer authoritative for the FULL profile.

**Architecture**:

The pointer-publish payload changes from "UXF bundle CID" to "lean profile snapshot CID". A snapshot is a content-addressed CAR containing:
- All per-writer encrypted KV entries (OUTBOX, SENT, dispositions, finalization queue, recipient context, etc.). Ciphertext is preserved as stored in OrbitDB — the snapshot layer never decrypts. Security boundary remains the wallet mnemonic.
- All `tokens.bundle.*` references (CIDs only — the bundle CARs themselves are pinned separately on IPFS, unchanged).
- Schema-versioned root.

Sync is:
1. **Mutation**: ANY writer mutation (OUTBOX/SENT/disposition/UXF token state) marks profile dirty.
2. **Flush**: FlushScheduler debounces, builds lean profile snapshot, pins to IPFS, publishes snapshot CID to aggregator at the next pointer version.
3. **Crash safety**: aggregator anchoring is irreversible. A peer that crashes immediately after publish leaves a durable record of its profile state at that version.
4. **Poll**: peers poll the aggregator (existing path). On new version detected, fetch snapshot CAR from IPFS, content-verify CID.
5. **JOIN per writer**: each writer's `joinSnapshot(remoteEntries)` applies CRDT merge against local OrbitDB state. Local-only entries SURVIVE (set union); overlaps resolved by Lamport+tombstone semantics already proven at the writer layer.
6. **Re-publish**: if JOIN produced any local change, mark dirty → next flush re-snapshots → next pointer version.
7. **Convergence**: two peers flushing concurrently race for version V+1; aggregator anchors one; loser re-polls, JOINs winner's snapshot with local, publishes V+2. Bounded by polling interval + aggregator round-trip.

OrbitDB's role degrades to **local encrypted KV cache**. Its CRDT-replication features become unused at the conflict-resolution level. Pubsub stays as a hint channel ("wake up and poll the aggregator now") — already its current role per `lifecycle-manager.ts:27-49`.

**What's already in the tree**:

`profile/profile-export.ts` defines `ProfileSnapshot` v1 — a CAR containing encrypted KV entries + embedded bundle CAR bytes (`profile-export.ts:158-189`). Used today for manual export/import only (operator-facing "back up to file" flow). Hardening already done: schema versioning, size caps (256 MiB / 1 MiB per block / 8 MiB per value / 100k entries / 200k blocks), content-address verification on bundle blocks, deterministic encoding. **The serialization layer is ~70% there.**

Two important deltas needed:
- **"Lean" snapshot variant** — bundle refs by CID only, no embedded CAR bytes. The fat format stays for the export/import CLI. Schema v2.
- **Filter reversal** — today's export filter strips `tokens.bundle.*` and `consolidation.*` (operational state for export). For sync these ARE needed; the new lean snapshot includes them.

**Implementation status** (2026-05-19 — branch `feat/outbox-followups-item15-phase-a`)

Phase A and most of Phase B have landed locally as a sequence of commits on the
branch above (not yet merged to `integration/all-fixes`). Use this status block
to pick up where the work stopped:

| Sub-phase | Status | Commit (short) | Files |
|-----------|--------|----------------|-------|
| Phase A | ✓ Done | `870fcd3` | `profile/profile-lean-snapshot.ts` + tests |
| B.1 (shared merge helper) | ✓ Done | `e999727` | `profile/profile-snapshot-merge.ts` + tests |
| B.2 (OutboxWriter) | ✓ Done | `c56641b` | `profile/outbox-writer.ts` + tests |
| B.3 (SentLedgerWriter) | ✓ Done | `60b8929` | `profile/sent-ledger-writer.ts` + tests |
| B.4 (DispositionWriter — `_invalid` + `_audit` only) | ✓ Done | `0486fc2` | `profile/disposition-storage-adapters.ts` (new `syncWritersFor(addressId)` returning four `PrefixSyncWriter`s for `${addr}.invalid.` / `${addr}.invalid-orphan.` / `${addr}.audit.` / `${addr}.audit-orphan.`; new `notifyProfileDirty` constructor option threaded into all four writers; four exported prefix helpers: `dispositionInvalidPrefix` / `dispositionInvalidOrphanPrefix` / `dispositionAuditPrefix` / `dispositionAuditOrphanPrefix`), `profile/profile-storage-provider.ts` (`buildDispositionStorageAdapter` now threads `this.profileDirtyNotifier`), `profile/factory.ts` (extended `dispatchParsedSnapshot`'s `writersFor(addressId)` closure to include the four disposition writers via `storage.buildDispositionStorageAdapter().syncWritersFor(addressId)`), `tests/unit/profile/disposition-sync.test.ts` (new — 14 tests: wiring, snapshot scope isolation invalid↔audit + orphan↔non-orphan + multi-addressId, JOIN round-trip for invalid + audit, idempotency, tombstone stickiness, orphan/non-orphan no cross-pollination, `notifyProfileDirty` propagation: fires on landings, NOT on empty JOIN). The `_manifest` surface remains DEFERRED — see the "Deferred — B.4 manifest" note below. |
| B.5 (Finalization + RecipientContext) | ✓ Done | `7806b93` | `profile/prefix-sync-writer.ts`, `profile/finalization-queue-storage-adapter.ts` + tests |
| B.6 (BundleIndex) | ✓ Done | `6c3c0ee` | `profile/profile-token-storage/bundle-index.ts` + tests |
| C.1 (notifyProfileDirty wiring) | ✓ Done | `04e423e` | every writer + host interface + `ProfileStorageProvider.setProfileDirtyNotifier` + `tests/unit/profile/notify-profile-dirty.test.ts` |
| C.2 (debounce + dispatch surface) | ✓ Done | `a5a2a90` | `ProfileTokenStorageProvider.notifyProfileDirty` + `dirtyFlushTimer`/`dirtyFlushPending`/`hasShutdown` + `onProfileDirtyFlush` option + `tests/unit/profile/profile-token-storage-dirty-flush.test.ts` |
| C.3 (factory closure wiring) | ✓ Done | `8c241e9` | `profile/factory.ts` (`runProfileDirtyFlush` + `createProfileProviders`), `profile/profile-token-storage-provider.ts` (public `getIdentity()` + `notifyProfileDirty()`) + tests |
| D.1a (route runProfileDirtyFlush via publishAggregatorPointerBestEffort) | ✓ Done | `ccbe3b3` | `profile/factory.ts` (`ProfileDirtyFlushDeps.publishCid` slot replaces direct `pointer.publish`), `profile/types.ts` (new `ProfileSnapshotPublishResult`; `onProfileDirtyFlush` return widened), `profile/profile-token-storage-provider.ts` (new `publishLeanSnapshotCid()` public delegate), `tests/unit/profile/factory-dirty-flush.test.ts` (12 tests) |
| D.1b (flush-scheduler → snapshot publish) | ✓ Done | `49d2894` | `profile/profile-token-storage/flush-scheduler.ts` (publish step rewired to `host.publishSnapshotIfWired()`; legacy `lifecycle.publishAggregatorPointerBestEffort(bundleCid)` call removed — no bundle-CID fallback; `LifecycleManager` import + constructor parameter dropped), `profile/profile-token-storage/host.ts` (new `publishSnapshotIfWired(): Promise<ProfileSnapshotPublishResult \| null>` method on the host interface), `profile/profile-token-storage-provider.ts` (new public `publishSnapshotIfWired()` method coordinating with the dirty-flush debouncer — cancels armed timer, awaits in-flight dispatch, re-arms on signal received during synchronous fire; `FlushScheduler` construction simplified), `tests/unit/profile/flush-scheduler-d1b.test.ts` (10 tests: bail / happy / error / debouncer-coordination paths) |
| D.2 (pull-side dispatcher) | ✓ Done | `da989f7` | `profile/profile-snapshot-dispatcher.ts` (new — pure per-writer JOIN orchestrator: base64-decodes snapshot entries, extracts unique addressIds via `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}` regex, dispatches each writer's `joinSnapshot()` over its prefix-filtered slice, dispatches wallet-global BundleIndex over `tokens.bundle.*`, aggregates `JoinResult` counters; per-writer errors swallowed so a single misbehaving writer cannot block convergence), `profile/pointer-wiring.ts` (new optional `applySnapshot` field on `PointerWiringInput`; `buildFetchAndJoin` now fetches CAR bytes and — when applier is wired — parses via `parseLeanProfileSnapshot`, calls the applier, THEN advances cursor; legacy bundle-CID write path preserved as fallback for tests / pre-D.2 wallets; parse failure throws PROTOCOL_ERROR to avoid silently absorbing malformed remote CARs), `profile/profile-storage-provider.ts` (new private `snapshotApplier` field + public `setSnapshotApplier()` setter; threaded into `buildProfilePointerLayer` via `tryBuildPointerLayer`), `profile/profile-token-storage-provider.ts` (new public `getBundleIndex(): BundleIndex \| null` accessor), `profile/factory.ts` (new exported `runProfileSnapshotApply(snapshot, deps)` testable closure body wrapping `runProfileSnapshotJoin`; `createProfileProviders` wires `storage.setSnapshotApplier(...)` that lazily builds per-address writers via `storage.buildOutboxWriter(addressId)` + `buildSentLedgerWriter` + `buildFinalizationQueueStorageAdapter().syncWriterFor` + `buildRecipientContextStorageAdapter().syncWritersFor` and reads wallet-global BundleIndex via `tokenStorage.getBundleIndex()`), `tests/unit/profile/profile-snapshot-dispatcher.test.ts` (20 tests: address extraction, per-writer routing, BundleIndex routing, aggregation/joinedAny semantics, error isolation, base64 decoding, internal helpers), `tests/unit/profile/pointer-wiring.test.ts` (4 new D.2 tests: happy path with applier wired, applySnapshot throw → no cursor advance, malformed CAR → PROTOCOL_ERROR, legacy fallback when applier omitted), `tests/unit/profile/factory-snapshot-apply.test.ts` (5 tests: writersFor invocation count, getBundleIndex laziness, dispatcher delegation, result shape), `tests/unit/profile/integration.test.ts` (1 new wiring assertion: factory installs the snapshot applier) |
| Phase E (remove UXF-bundle-only pointer code path) | ✓ Done | `952c276` | `profile/pointer-wiring.ts` (`applySnapshot` promoted from optional to required field on `PointerWiringInput` and on `buildFetchAndJoin`'s deps; new `snapshot_applier_missing` skip reason added to `PointerWiringSkipReason`; legacy bundle-CID write block — including `bundleEncryptionKey` parameter, `BUNDLE_KEY_PREFIX`, OrbitDB write path, `withTimeout`/`ORBITDB_WRITE_TIMEOUT_MS`, `db` input field — fully removed; `deriveProfileEncryptionKey`/`encryptProfileValue`/`buildLocalEntry`/`UxfBundleRef`/`ProfileDatabase` imports dropped; precondition added in `buildProfilePointerLayer` so a missing applier surfaces as a clean skip rather than a layer that crashes on first remote), `profile/profile-storage-provider.ts` (pre-flight gate added in `tryBuildPointerLayer`: if `snapshotApplier` is null the layer construction is skipped with `snapshot_applier_missing`; `db` no longer threaded into the wiring helper; doc comments updated to remove "legacy fallback" language and reflect that the applier is now required), `tests/unit/profile/pointer-wiring.test.ts` (legacy bundle-ref write tests removed: `'fetches, verifies, writes an encrypted bundle ref…'`, `'writes the OrbitDB bundle ref BEFORE persisting the local version'`, `'does NOT advance the local version when the OrbitDB write fails'`, `'written bundle ref round-trips through decryptProfileValue'`, `'legacy fallback (no applySnapshot wired) still writes bundle ref'`; surviving pre-flight tests rewritten to assert `applySnapshot` is NOT called when the fetch fails; new `'skips with snapshot_applier_missing when applySnapshot is omitted'` test on `buildProfilePointerLayer`; new `'calls applySnapshot BEFORE persisting the local version'` ordering test; `createMockDb` helper removed) |
| Phase F (tombstone GC at snapshot-build time) | ✓ Done | `0f530eb` | `profile/profile-lean-snapshot.ts` (new optional `gcExpiredTombstones?: () => Promise<void>` field on `BuildLeanProfileSnapshotOptions`; builder invokes the hook BEFORE `readAllKvEntries` so the subsequent `storage.keys()` scan observes the post-GC state; hook exceptions caught + logged, never block snapshot publication), `profile/factory.ts` (new exported `runProfileTombstoneGc(deps)` + `DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS` constant — 30 days; closure extracts active addressIds via the same `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}.` regex as the pull-side dispatcher, instantiates OUTBOX + SENT writers per address, dispatches each writer's `gcExpiredTombstones({ retentionMs })`; per-writer/per-address errors swallowed so one misbehaving writer cannot block GC on the others; `listKeys()` failure → silent return; `createProfileProviders.buildSnapshot` wires the closure into the lean-snapshot builder's new hook with retention resolved per-call from `ProfileConfig.tombstoneRetentionMs` → `DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS`), `profile/types.ts` (new `ProfileConfig.tombstoneRetentionMs?: number` knob), `tests/unit/profile/profile-lean-snapshot.test.ts` (3 new Phase F tests: hook fires BEFORE storage scan, hook exceptions swallowed, omitting hook preserves backwards-compatible behaviour), `tests/unit/profile/factory-tombstone-gc.test.ts` (new — 12 tests on `runProfileTombstoneGc`: addressId extraction, non-prefixed key ignore, empty no-op, dedup across many keys per address, retentionMs threading, null builder skip, per-writer/per-address error isolation, `listKeys()` failure silent return, default retention constant value) |
| Phase G (integration tests) | ✓ Done | `b99b980` | `tests/integration/profile/full-profile-sync.test.ts` (new — 13 tests across the 5 G.* scenarios: G.1 two-peer JOIN propagation + idempotent re-pull + SENT prefix-routing smoke, G.2 tombstone-wins-at-JOIN incl. tie-break sticky semantics, G.3 concurrent V+1 flush race + convergence to V+2 union + bounded-fix-point bidirectional pull, G.4 crash-recovery cross-device + 'finalizing' status survives JOIN with sticky `everFinalizing`, G.5 non-overlapping union + remote-Lamport preservation + asymmetric mutations). Fixture wires real `OutboxWriter` + `SentLedgerWriter` per peer atop `MockProfileDb`; "publish" goes through `buildLeanProfileSnapshot` against a `WrappedStorage` adapter (surfaces `db` keys via `keys()` + `getEncryptedRaw()`); "pull" parses via `parseLeanProfileSnapshot` and dispatches via `runProfileSnapshotJoin` with `writersFor(ADDR) → [OUTBOX, SENT]` and `bundleIndex: null`. Bundle/finalization/recipient-context writers covered by their own unit tests; the integration suite focuses on the canonical OUTBOX/SENT flow per the spec's Phase G acceptance criteria. |
| Phase E follow-up (`applySnapshotIfWired` host method) | ✓ Done | `93190a6` | `profile/profile-token-storage/host.ts` (new `applySnapshotIfWired(cid)` on the host contract), `profile/types.ts` (new `onApplySnapshot` option on `ProfileTokenStorageProviderOptions`), `profile/profile-token-storage-provider.ts` (implementation + new `setApplySnapshotCallback(cb)` late-binding setter), `profile/profile-token-storage/lifecycle-manager.ts` (`recoverFromAggregatorPointerBestEffort` + `runPointerPollOnce` now dispatch the recovered CID through `applySnapshotIfWired` instead of `bundleIndex.addBundle`; idempotency keyed on `lastDiscoveredPointerCid` instead of `knownBundleCids`; `fetchFromIpfs` import dropped — fetch runs inside the factory's wired closure), `profile/factory.ts` (`dispatchParsedSnapshot` helper extracted and reused by both `setSnapshotApplier` and the new `setApplySnapshotCallback`; the recovery closure does fetch + parse + dispatch), `tests/unit/profile/profile-token-storage-apply-snapshot.test.ts` (new — 8 tests: wrapper contract, null-when-no-callback, delegate-when-wired, shutdown gate, error propagation, late-binding wins, construction-time fallback, setter override), updated `tests/unit/profile/lifecycle-manager-pointer-poll.test.ts` (13 tests; 4 new) + `tests/unit/profile/profile-token-storage-pointer.test.ts` (the recovery-records-bundle-ref test rewritten to assert applier dispatch + absence of legacy direct write). |

**Implementation pattern that emerged during Phase B**

Two flavours of per-writer JOIN exist; either pattern is now baked into
the codebase and Phase C/D wiring can rely on both being available.

  1. **Lamport-tracked, mutable entries** — OUTBOX, SENT. Each entry's
     `lamport` field monotonically advances on every local write per §7.1.
     The full Phase B merge table picks the winner by Lamport comparison.
     `OutboxWriter` and `SentLedgerWriter` each implement `ProfileSyncWriter`
     directly with their own decrypt/parse/Lamport-validate classifier.

  2. **Constant-Lamport, content-immutable entries** — Finalization queue,
     RecipientContext (both sub-prefixes), BundleIndex. Each entry is
     written once at a key whose unique disambiguator (entryId, requestId,
     tokenId, CID) ensures two replicas writing the same entry produce
     byte-equivalent content. No explicit Lamport.

     The shared helper `profile/prefix-sync-writer.ts` (`PrefixSyncWriter
     implements ProfileSyncWriter`) wraps the constant-Lamport-0 pattern.
     The merge degenerates to "absent → write; live+live → no-op (first
     wins); tombstones stay sticky at Lamport=0=0 ties". `BundleIndex`
     does NOT use `PrefixSyncWriter` (because of the envelope wrapper)
     but applies the same constant-Lamport-0 semantics via a custom
     classifier.

**Public surface added by Phase B (for Phase D's dispatcher)**

  - `OutboxWriter implements ProfileSyncWriter` (per-address — constructed
    with `addressId`).
  - `SentLedgerWriter implements ProfileSyncWriter` (per-address).
  - `OrbitDbFinalizationQueueStorageAdapter.syncWriterFor(addressId)`
    returns one ProfileSyncWriter for `${addr}.finalizationQueue.*`.
  - `OrbitDbRecipientContextStorageAdapter.syncWritersFor(addressId)`
    returns `{ requestContext, finalizationContext }` — two
    ProfileSyncWriters covering `recipientContext.request.*` and
    `recipientContext.finalization.*`.
  - `BundleIndex implements ProfileSyncWriter` (singleton — no
    addressId; the `tokens.bundle.*` namespace is wallet-global).

The Phase D pull-side dispatcher in `profile/pointer-wiring.ts:387-533`
should iterate active tracked addresses, instantiate per-address sync
writers from the registered writer instances, dispatch each writer's
`joinSnapshot()` over the writer's prefix-filtered slice of the remote
snapshot's `entries[]`, then handle the wallet-global BundleIndex
separately.

**Deferred — B.4 manifest (status: `_invalid` + `_audit` LANDED `0486fc2`; `_manifest` REMAINS deferred)**

Scope call resolved as a hybrid in commit `0486fc2`:

  - `_invalid` (`${addr}.invalid.{tokenId}.{contentHash}`) — content-immutable.
    **PrefixSyncWriter slots in directly.** Default validator (accept any
    plain non-tombstone object) is correct — disposition records are
    heterogeneous shapes without a `_schemaVersion` discriminator. The
    `${addr}.invalid-orphan.` sub-prefix is wired as a separate writer
    so non-orphan and orphan records cannot cross-pollinate.
  - `_audit` (`${addr}.audit.{tokenId}.{contentHash}`) — same as `_invalid`.
    The `_audit` records DO mutate (`auditStatus: 'audit-promoted'` set
    on promotion) but at the same `lamport=0` semantics they'd converge
    eventually-consistently with operator-visible divergence in the
    interim. **Accepted as eventual-consistency per the surface's
    design notes.**
  - `_manifest` (`${addr}.manifest.{tokenId}`) — Lamport-tracked AND CAS-
    guarded via `ManifestStore` with per-field merge rules (set-OR for
    `audit_promoted_from`, max-merge for `lamport`, lex-min for
    `splitParent`, etc.). A snapshot-JOIN that picks ONE side's bytes
    verbatim would lose the per-field merge that `mergeManifestEntry`
    runs at write time. **Option (c) wins for now**: defer manifest
    from the lean-snapshot sync path. Two reasons:
      1. Production manifest storage today is in-memory only — an
         `MinimalManifestStorage` `Map<string, TokenManifestEntry>`
         built inside `PaymentsModule` (`PaymentsModule.ts:~15045`).
         There is no OrbitDB persistence to JOIN against at the
         snapshot layer.
      2. Closing this requires BOTH migrating the manifest store to
         OrbitDB persistence AND extending the JOIN primitive (option
         a) or building a dedicated `ManifestStore.joinSnapshot()`
         (option b on this surface). That's a significant follow-up
         and overlaps with Item #14's conflict-classification work.

When option (a)/(b) eventually lands for `_manifest`:
      (a) extend `runJoinSnapshot`'s `writeRemote` callback to accept a
          per-field merger and have ManifestStore implement it, OR
      (b) handle manifest JOIN outside `runJoinSnapshot` with a dedicated
          `ManifestStore.joinSnapshot()` that runs the existing
          per-field merger before persisting.

The maintainer call between (a) and (b) for `_manifest` is unchanged;
the work to migrate ManifestStore to OrbitDB persistence is a
prerequisite for either path.

**Phase G test scope after Item #15 lands**

The G suite needs at minimum the test scenarios from item #9's "scope after
Item #15" note: two-peer concurrent snapshot flushes where the aggregator
anchors one and the loser re-polls + JOINs + re-publishes V+2.

---

**Acceptance criteria** (phased; each phase can be a separate PR):

**Phase A — Lean snapshot format + builder**

- A.1 Define `LeanProfileSnapshot` (or `ProfileSnapshot v2`) with `bundles[]: { cid, status, createdAt, tokenCount? }` (CID-only, no embedded bytes). Sibling type to v1 or v2 of the existing type — IMO sibling is cleaner.
- A.2 Builder `buildLeanProfileSnapshot(deps)` mirroring `exportProfile` but skipping bundle-byte embedding AND including the keys that the export filter drops. Determinism preserved (entries sorted by key, bundles by CID).
- A.3 Parse / verify `parseLeanProfileSnapshot(carBytes)` with the same content-address re-verification and size caps. Reject `version > 2`.
- A.4 Unit tests: builder/parser round-trip is byte-identical; size caps enforced; deterministic output.

**Phase B — Per-writer snapshot/JOIN API**

Each writer that lives in OrbitDB gains two methods:

```typescript
interface ProfileSyncWriter {
  snapshot(): Promise<ReadonlyArray<{ key: string; encryptedValue: Uint8Array }>>;
  joinSnapshot(remote: ReadonlyArray<{ key: string; encryptedValue: Uint8Array }>): Promise<JoinResult>;
}
```

`snapshot()` is a prefix-scan + read-encrypted-bytes — trivial.

`joinSnapshot()` applies CRDT merge. After decrypt + parse, for each remote key K:

| Local | Remote | Result |
|-------|--------|--------|
| absent | live | write remote |
| absent | tombstone | write remote tombstone |
| live | live | write the one with higher Lamport |
| live | tombstone | tombstone wins if `tombstone.lamport >= live.lamport`; else local wins (the **existing refuse-write guard**, applied at JOIN-time) |
| tombstone | live | live wins ONLY if `live.lamport > tombstone.lamport`; else tombstone preserved |
| tombstone | tombstone | keep the one with higher Lamport |

Wire this for: `OutboxWriter`, `SentLedgerWriter`, `DispositionWriter`, `FinalizationQueueStorageAdapter`, `RecipientContextStorageAdapter`, and the bundle-ref index. A shared generic helper for the Lamport+tombstone merge avoids re-implementing it five times.

The CRDT primitives that the Lamport+tombstone machinery from Issue #166 P1 #2 provides are **exactly the right merge functions** here. Write-time invariants become JOIN-time merge functions.

Unit tests per writer: every cell of the table above, plus idempotence (re-running JOIN on the same remote is a no-op).

**Phase C — Mutation→flush trigger surface**

- ✓ C.1 (commit `04e423e`). Every writer's mutation surface invokes a host-provided `notifyProfileDirty()` callback. Plumbed through OutboxWriter, SentLedgerWriter, PrefixSyncWriter, OrbitDb{Finalization,RecipientContext}StorageAdapter, BundleIndex via `host.notifyProfileDirty()`. Centralised wiring lives on `ProfileStorageProvider.setProfileDirtyNotifier(cb)` so all `build*` factories thread the same callback.
- ✓ C.2 (commit `a5a2a90`). `ProfileTokenStorageProvider` debounces incoming dirty signals over `dirtyFlushDebounceMs` (defaults to `flushDebounceMs`, configurable per-test). On fire, dispatches the host-injected `onProfileDirtyFlush?: () => Promise<void>` callback (new option). Concurrent signals serialize through `dirtyFlushPromise`; mid-flush signals latch via `dirtyFlushPending` and re-arm a fresh debounce. Errors are caught and surfaced via `storage:error` with code `PROFILE_DIRTY_FLUSH_FAILED`. Shutdown cancels the timer and awaits in-flight callbacks.
- ✓ C.3 (commit `8c241e9`). `profile/factory.ts:createProfileProviders` wires the lean-snapshot dirty-flush closure into `ProfileTokenStorageProviderOptions.onProfileDirtyFlush` and registers a writer-side notifier on the storage provider that delegates to `tokenStorage.notifyProfileDirty()`. The closure body is exported as `runProfileDirtyFlush(deps)` for unit-testing without spinning up real OrbitDB / IPFS — it (1) reads `chainPubkey` / `network` from the live identity + config (bail on either missing), (2) verifies the pointer layer is ready (bail otherwise), (3) builds a lean snapshot via `buildLeanProfileSnapshot()`, (4) pins via `pinToIpfs(ipfsGateways, …)`, (5) publishes via `pointer.publish(cidProducer)`. `ProfileTokenStorageProvider.notifyProfileDirty()` is promoted to public (the factory bridge needs to call it from outside). New `ProfileTokenStorageProvider.getIdentity()` public accessor lets the closure read the live `chainPubkey` lazily without leaking the host adapter. Tests: `tests/unit/profile/factory-dirty-flush.test.ts` (10 tests covering bail paths, build→pin→publish ordering, error propagation, fresh-evaluation across calls) + `tests/unit/profile/integration.test.ts` (2 new wiring assertions).

**Phase D — Pointer publish & pull integration**

- D.1 `LifecycleManager.publishAggregatorPointerBestEffort(cid)` receives the SNAPSHOT CID, not the bundle CID. Existing publish-retry / version-monotonicity logic stays.
- D.2 `buildFetchAndJoin` (`profile/pointer-wiring.ts:387-533`) becomes:
  1. Fetch snapshot CAR by CID, content-verify.
  2. Parse via `parseLeanProfileSnapshot`.
  3. For each writer, dispatch the writer's `joinSnapshot()` over the writer's prefix-filtered entries.
  4. Write bundle refs to local OrbitDB (existing path; existing `UxfPackage.merge` at `load()` time runs over the merged ref set unchanged).
  5. Advance version cursor only after all per-writer JOINs persist.
  6. If JOIN produced any local change → mark profile dirty (next flush re-snapshots and publishes the union).

**Phase E — Removal of UXF-bundle-only pointer publishing** ✓ Done (see status table above)

Per the maintainer call: no backward compat. The UXF-bundle-only pointer code path is removed. Existing callers that produced bundle CIDs to the pointer publisher are routed through the new snapshot builder.

Phase E completes the cleanup that Phases D.1b + D.2 left behind. After this phase the pointer layer's `fetchAndJoin` callback has exactly one sink for remote pointer state: the per-writer snapshot dispatcher wired through `applySnapshot`. The push side of this cutover already happened in D.1b (flush-scheduler publishes the lean snapshot CID, not the UXF bundle CID); Phase E removes the matching read-side fallback so a wallet whose factory wiring is broken fails *fast* with a clean diagnostic skip reason rather than constructing a layer that silently writes the wrong CAR shape into the bundle index on first remote.

Concretely Phase E does:
- Promotes `applySnapshot` from optional to required on both `PointerWiringInput` and `buildFetchAndJoin`'s internal deps. The `db: ProfileDatabase` input field is dropped — the wiring helper no longer touches OrbitDB at all because no writes happen on the pointer-read path. The `bundleEncryptionKey` parameter that the legacy bundle-ref encryption used is gone too.
- Removes the entire `// 3b. Legacy fallback — applySnapshot not wired` branch from `buildFetchAndJoin`. That branch previously wrote `{ cid, status: 'active', createdAt }` as an encrypted ref at `tokens.bundle.{cid}` and advanced the local-version cursor; under Item #15 that's structurally wrong because the CID is now the snapshot CID, not a UXF bundle CID. Treating a malformed remote CAR as "legacy bundle CAR" would silently absorb the wrong shape and leave per-writer JOIN unconsumed.
- Adds a new `snapshot_applier_missing` skip reason to `PointerWiringSkipReason`. Both `buildProfilePointerLayer` and `ProfileStorageProvider.tryBuildPointerLayer` check for the applier up front and bail with this reason when wiring is incomplete (typically a test fixture that forgot to set the applier, or a factory bug that constructed the pointer-build before `setSnapshotApplier` ran). The wallet then runs WITHOUT aggregator-pointer recovery — local OrbitDB still works, but cross-device sync via the pointer is paused until the wiring is fixed.
- Cleans up now-unused imports (`encryptProfileValue`, `deriveProfileEncryptionKey`, `buildLocalEntry`, `UxfBundleRef`, `ProfileDatabase`, `BUNDLE_KEY_PREFIX`, `withTimeout`, `ORBITDB_WRITE_TIMEOUT_MS`).

**Known follow-up (latent bug — RESOLVED in Phase E follow-up):** under D.1b/D.2/E the aggregator pointer now carries a *snapshot* CID, but the lifecycle-manager's periodic-poll path (`runPointerPollOnce`) and cold-start recovery path (`recoverFromAggregatorPointerBestEffort`) previously treated the recovered CID as a UXF *bundle* CID — they called `bundleIndex.addBundle(recoveredCid, …)` directly without first parsing the CAR as a lean snapshot. The result was a stale bundle-index entry pointing at snapshot bytes; the next `load()` would then try to parse the snapshot CAR as a UXF package and fail. The bug was latent because the publish-side reconcile loop (where the `fetchAndJoin` path runs) covered most paths in practice.

The fix landed in the "Phase E follow-up (`applySnapshotIfWired` host method)" row of the status table above. A new host method `applySnapshotIfWired(cid)` was added symmetric to `publishSnapshotIfWired()`; both the poll and cold-start paths now route the recovered CID through it (fetch + parse + per-writer JOIN dispatch). The legacy direct-`addBundle` path is gone — silently re-writing the snapshot CID as a bundle ref is precisely what the fix removes. No legacy fallback per Phase E: when no applier is wired the lifecycle logs and skips rather than corrupting the bundle index.

**Phase F — Tombstone GC at snapshot-build time**

Item #4's tombstone GC currently runs against OrbitDB locally. Under #15:
- Snapshot builder drops tombstones older than `retentionMs` at build time (they're not included in the published snapshot).
- Local OrbitDB cleanup can run separately or as a same-time hook.
- Safety contract unchanged: `retentionMs` must exceed the longest realistic concurrent-replica pre-sync window. Existing 30-day default is conservative.

**Phase G — Integration tests + crash-recovery scenario**

- G.1 Two-peer JOIN: A writes OUTBOX entry e_A, snapshots, publishes. B polls, JOINs. Assert e_A is in B's local OUTBOX with A's Lamport.
- G.2 Tombstone-wins-at-JOIN: A tombstones key K at Lamport L_t. B has live entry at K with Lamport L_h < L_t. JOIN preserves the tombstone in B's local state.
- G.3 Race: A and B both flush concurrently for V+1. Aggregator anchors one. Loser re-polls, JOINs, publishes V+2.
- G.4 Crash-recovery (the user-driven scenario): A writes OUTBOX entry then crashes immediately after publish. B detects new version, pulls, JOINs, sees A's OUTBOX entry. B's `SendingRecoveryWorker` can pick it up (same wallet identity = same signing key on both devices).
- G.5 Non-overlapping union: A and B both have OUTBOX entries (different keys). After bidirectional JOIN, both see the full union.

**Files** (proposed touch list):

- `profile/profile-export.ts` — extend or sibling for lean v2 builder/parser.
- `profile/outbox-writer.ts`, `profile/sent-ledger-writer.ts`, `profile/disposition-writer.ts` (if exists), `profile/finalization-queue-storage-adapter.ts`, `profile/recipient-context-storage-adapter.ts` (if exists) — add `snapshot()` + `joinSnapshot()`.
- `profile/profile-token-storage/flush-scheduler.ts` — emit lean snapshot instead of UXF bundle.
- `profile/lifecycle-manager.ts` — receive snapshot CID from flusher.
- `profile/pointer-wiring.ts:387-533` — pull-side dispatcher per writer.
- `profile/profile-token-storage-provider.ts` — wire the `notifyProfileDirty()` callbacks from each writer.
- New: `profile/profile-snapshot-merge.ts` — shared CRDT merge helper.
- Tests: `tests/integration/profile/full-profile-sync.test.ts` (new) + per-writer unit tests.

**Complexity**: Large. Multi-phase (A through G). Each phase can ship independently; Phase A is the prerequisite. Estimated 3-5 PRs.

**Blast radius**: Very High while the work is in flight (touches the pointer-publish + pull paths that every wallet relies on). Mitigation: feature-flag (`features.fullProfileSnapshotSync`?) gating the new publish/pull behaviour, default-OFF during development, flip to default-ON after Phase A-G land and soak.

Migration consideration: existing wallets that have published only UXF-bundle pointers need handling — either (a) they re-publish under the new format on first flush after upgrade, OR (b) the cutover is done at a clean release boundary with no in-flight UXF-bundle pointers expected. The maintainer call is (b): no backward compat. Implementation should arrange for the first post-upgrade flush to emit the new format and never read or write the old format.

**Downstream effects** (forward references):
- Item #2: `'entry-tombstoned-or-missing'` skip becomes rare — OUTBOX entries propagate, so when the verifier needs the entry to transition it's almost always there.
- Item #4: tombstone GC relocates to snapshot-build time (see Phase F).
- Item #6: bundle-bytes always reachable on IPFS pin — the CAR-mode throw at the recovery worker becomes a defensive fallback rather than the common case.
- Item #9: the OrbitDB Hash Log conflict-resolution gap collapses — OrbitDB is no longer the conflict-resolution layer for OUTBOX/SENT.
- Item #10: per-entry-key with Lamport+tombstone is reinforced as the right primitive (it's also the JOIN merge function); vector model loses its appeal.
- Item #14: most of Phase 2 (local-Token correction) is subsumed; Phase 1 (typed throw + new event) still wanted for operator-visible classification but the loser's stuck-`'transferring'` symptom resolves naturally at next sync.

---

## Cross-cutting concerns

### Pointer-layer vs OrbitDB-log layering (architectural clarification — superseded by Item #15)

> **Direction change (2026-05-18)**: Item #15 (Full Profile State Snapshot Sync) collapses the two-layer model into one. Under #15 the aggregator pointer carries the full profile snapshot (including OUTBOX/SENT/dispositions/etc.) — not just the UXF bundle CID. OrbitDB becomes a local encrypted KV cache; its CRDT-replication features are unused for cross-peer convergence. This section describes the **interim state** that holds until Item #15 lands.

The profile layer **currently** has TWO distinct distribution mechanisms running in parallel, often confused:

| Layer | What it carries | Conflict resolution |
|-------|-----------------|---------------------|
| **Aggregator pointer** (today) | The CID of the current UXF token bundle CAR (the `tokens.bundle.*` aggregate). One small commitment per flush, anchored to BFT-backed inclusion proofs. | Unicity aggregator's Sparse Merkle Tree provides total ordering and immutability over the sequence of bundle pointers. Append-only by construction. See `docs/uxf/PROFILE-AGGREGATOR-POINTER-SPEC.md`. |
| **OrbitDB Hash Log** (today) | Per-entry-key writes for OUTBOX/SENT/dispositions/etc. — direct `db.put` calls at keys like `${addr}.outbox.${id}`. NOT bundled into CARs. NOT pointer-published. | OrbitDB's underlying CRDT: LWW lex-sort on entry hashes for concurrent writes to the same key. Lamport stamps + tombstones + refuse-write guard (Issue #166 P1 #2) provide POST-sync safety. |

**Implication for the writer-layer concerns in this doc (pre-#15)**: items #1–#9 concern OUTBOX/SENT entries that live in the OrbitDB Hash Log layer (not the pointer layer). The pointer mechanism's "Single Irreversible Provable History" guarantee covers WHICH bundle CAR is current — it does NOT cover which value wins for an OUTBOX/SENT slot under concurrent same-key writes from two peers.

**Implication after Item #15 lands**: the aggregator pointer carries the full profile state. OUTBOX/SENT and every other writer's state is content-addressed inside the snapshot CAR. Conflict resolution moves to snapshot-pull JOIN time, using the same Lamport+tombstone primitives. OrbitDB pubsub remains as a hint channel only.

**Pubsub clarification**: OrbitDB pubsub IS still wired in `profile/orbitdb-adapter.ts:243-246` (gossipsub is a hard requirement for OrbitDB v3). It is explicitly DEMOTED to a hint channel — `lifecycle-manager.ts:27-49` treats pubsub events as a wake-up signal to poll the aggregator NOW, not as authoritative state. The aggregator pointer is the authority; pubsub is a latency optimisation (collapsing worst-case cross-device sync from ~90 s to ~1-2 s). This stays true under Item #15.

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
