# RFC-251 — Same-Identity Cross-Device Pointer Coordination

**Status:** Phase 1 prototype landed (#257, draft) — Approach D selected. See §3 + Update below.
**Source:** [Issue #251](https://github.com/unicity-sphere/sphere-sdk/issues/251) Problem 1, [Issue #255](https://github.com/unicity-sphere/sphere-sdk/issues/255) Problem B
**Companion specs:**
- [`PROFILE-AGGREGATOR-POINTER-SPEC.md`](./PROFILE-AGGREGATOR-POINTER-SPEC.md) — pointer wire format & W7 walkback floor
- [`PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md`](./PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md) §8.5 — many-device burst publish characterisation
- PR #246 — WALKBACK_FLOOR throttle (#245 #3)
- PR #249 — W7 reconcile-downward (#247 short-term fix)
- PR #257 (draft) — Approach D Phase 1 prototype (this RFC's chosen path)
- `unicitynetwork/ipfs-storage#7` — IPFS instant-pin sidecar (Stage B.1 prerequisite)

---

## Update — 2026-05-24

**Approach A (aggregator-side CAS) is ruled out by owner directive.** Project owner directed:

> Treat aggregator as one-time KV authenticated storage. Design the pointer protocol around it.

This forecloses any change to `aggregator-go` (new RPC fields, reverse indexes, per-wallet metadata, schema migrations). The aggregator's existing semantics — first-writer-wins per `requestId`, ECDSA-authenticated submits, eventually-consistent read replica — are the contract the SDK must live within.

**Approach C** (server-side anchoring) was already ruled out in §2.3 of this RFC (hard variant requires aggregator to hold per-wallet master key; weak variant has no implementation merit). The directive above doesn't change that.

**Approach B** (Nostr writer election) is still viable in principle but the silent-split-via-asymmetric-Nostr-reachability failure mode (§2.2 Cons) means it's at best a tied alternative to Approach D — same authentication primitive (sibling shares wallet key), same transport (Nostr), but with new election complexity layered on. We **drop B in favor of D**.

**New approaches added** (§§2.4–2.6):
- **D — Nostr win-broadcast** (chosen). Authenticated optimistic-notify after successful publish; siblings adopt without waiting for replica lag.
- **E — Aggregator claim-lock** (alternative; doubles aggregator load).
- **G — Per-device pointer slots** (longer-term architectural fit; large protocol revision).

**Recommendation flipped to D.** See §3. Phase 1 prototype landed in PR #257; Phase 2 (eager-subscribe + direct adopt) is conditional on Stage B.1 verdict.

---

## 1. Problem Statement

Two devices sharing one wallet identity (same secp256k1 master key, e.g. peer1
CLI and peer2 daemon in `manual-test-full-recovery.sh`) publish pointers to the
**same aggregator slot** concurrently. Both write valid commitments under the
same signing identity, but the aggregator's read replica lag (30 – 60 s)
combined with the W7 walkback-floor rule (a wallet refuses to walk past a
version it has already confirmed as its own) produces a deadlock pattern:

- Device A publishes `V=N`. Local cursor advances to `N`.
- Device B (read-replica still showing `V=N-1`) attempts to publish at `V=N`.
  Sees its own `V=N-1` floor, walks back hits `V=N-1 < localVersion=N`, raises
  `AGGREGATOR_POINTER_WALKBACK_FLOOR`.
- After PR #249 the responder calls `recoverLatest()` → `reconcileLocalVersionDownward`
  to adopt A's `V=N` if visible. This unblocks the deterministic case, but in
  practice with a 60 s read-replica window + 30 – 90 s poll cadence + 60 s
  WALKBACK throttle, convergence is **statistical** and may never complete
  inside a 4-minute test window. The captured run at
  `/home/vrogojin/sphere-full-test-keep/20260524T115411Z/peer2-alice/.sphere-cli/daemon.log`
  shows **zero** successful pointer publishes from peer2-alice across the
  entire test window.

The wallet's user-facing failure mode is the §C.4 assertion: peer2-alice's
balance / invoice lookup is stale because the writes that should anchor its
view never made it onto a pointer.

### 1.1 Why the existing throttle and reconcile don't suffice

The current state machine handles the FAULT once it has been observed — but
the *fault is structural*, not transient. The throttle gates retry frequency
(good — prevents inner-budget burn) and the reconcile widens the visibility
window (good — closes the deterministic case). Neither closes the underlying
race window:

| Mechanism | What it solves | What it leaves open |
|---|---|---|
| WALKBACK throttle (PR #246) | Backs off after deterministic failure | The next throttle expiry retries blindly — still races |
| W7 reconcile-downward (PR #249) | Adopts the peer's visible version as new baseline | Two devices' baselines flip-flop while replica lag persists |
| `walkbackPublishInFlight` coalescing (#247) | Eliminates intra-process burst storms | Inter-process races unaffected |

The dominant residual cost is **time-to-convergence**, not log noise.

---

## 2. Candidate Approaches

### 2.1 Approach A — Aggregator-side compare-and-swap (CAS)

**STATUS: RULED OUT (2026-05-24 owner directive). Section preserved for the record; see Update at top of RFC.**

**Sketch.** Extend the aggregator's `submit_commitment` RPC with an optional
`expectedPriorVersion` field. The aggregator atomically rejects with a new
`VERSION_CONFLICT` status if the slot already holds a commitment at the
claimed version. The client retries with the aggregator-reported `currentVersion`
as its new baseline — single round trip, no walkback needed.

**Pros:**
- Eliminates the read-replica race entirely (CAS is anchored at the aggregator's
  authoritative view, not its replica).
- Designed to be backwards-compatible — existing clients omit the field and
  behave as before; new clients gracefully fall back when the aggregator
  returns `METHOD_NOT_FOUND` / ignores the field. **Subject to confirmation
  by the `aggregator-go` team (Open Question 1).**
- **Asymptotic complexity unchanged** versus today's §8.5 analysis (both are
  `O(k)` in the cohort). **The win is the per-conflict constant**: today each
  publish attempt costs the full walkback + reconcile + throttle cycle
  (~60 – 90 s); under CAS each conflict costs a single extra round trip
  (~200 ms). For a 2-device cohort that is the difference between
  ~minutes-to-converge and ~seconds-to-converge.

**Cons:**
- Requires an aggregator-side schema change. Coordinated rollout with
  `aggregator-go` (Go service) — touches the L3 layer, not just SDK-side.
- The "what is the current version of slot X" answer requires the aggregator to
  maintain an auxiliary reverse index by `(wallet_signing_pubkey, slot)`.
  **This is qualitatively different from "adding an optional field to an
  RPC."** The aggregator's commitment store is keyed by `requestId` only;
  the SMT stores blinded leaf values, so the new index cannot be derived
  on-the-fly from existing storage. Introducing it requires the aggregator
  to hold per-wallet signing-key metadata it currently never touches —
  approaching a schema migration with new trust-surface exposure rather
  than a pure protocol extension.

**Effort.** Medium-high. Bilateral SDK + aggregator change with **server-side
data-model implications** (not just protocol-level). Needs a real
testcontainer-based integration test to exercise the conflict path.

---

### 2.2 Approach B — Single-writer election via Nostr presence

**STATUS: DROPPED in favor of Approach D (2026-05-24). Section preserved for the record; the silent-split-via-asymmetric-Nostr-reachability failure mode in Cons reproduces exactly the race this RFC tries to eliminate.**

**Sketch.** Wallet processes that share an identity participate in a Nostr-based
"writer election." Only the elected writer publishes pointers; followers poll
the elected writer's published pointers and rebase locally. Election uses
Lamport clocks tiebroken on a presence-event signature; if the elected writer
goes silent for `T_failover`, the next-priority follower takes over.

**Pros:**
- Pure SDK / transport-layer change. No aggregator dependency.
- Eliminates writer collisions at the source — the W7 floor never fires because
  only one writer exists.
- Reuses existing Nostr transport — no new infrastructure.

**Cons:**
- Requires a non-trivial election protocol (Lamport + tiebreak + failover
  timeout). Network partitions degrade the guarantee — two writers can run
  concurrently during a split.
- Convergence cost shifts to election latency (~10 s) per wallet boot.
- Followers' local writes (OUTBOX, finalization queue) still need to be
  collected by the elected writer's flush — additional follower → writer
  channel needed, or followers must publish their writes via OrbitDB OpLog
  replication ONLY and rely on the writer's flush to anchor them.
- Failure modes are subtle:
  - **Split-brain during failover** can produce two pointers at the same
    version, replaying the same race we want to eliminate.
  - **Silent split via asymmetric Nostr reachability.** Two devices share an
    identity. The relay is fully operational. Device A reaches the relay
    fine; device B reaches the relay fine; but B cannot observe A's presence
    events (e.g., due to relay-side gossip-partition, NIP-29 group-membership
    drift, or asymmetric NAT). B's Lamport+tiebreak election protocol cannot
    detect A's prior election — B elects itself as writer while A is already
    writing. Both write concurrently to the same aggregator slot, exactly
    the failure mode this approach is meant to eliminate. Detection requires
    a sentinel signal stronger than "absence of presence events," which adds
    further protocol complexity.

**Effort.** High. New protocol surface, new failure modes, careful test matrix
required.

---

### 2.3 Approach C — Server-side anchoring

**STATUS: RULED OUT. Hard variant requires the aggregator to hold per-wallet master keys (trust-model hard-no). Weak variant has no implementation merit per the Cons below — also fully blocked by the 2026-05-24 owner directive against any aggregator-side change. Section preserved for the record.**

**Sketch.** The aggregator (or a sidecar service) listens for OpLog updates
via libp2p and anchors them itself, eliminating client-side pointer publishing
entirely. Clients only submit bundles; the server publishes pointers.

**Pros:**
- Cleanest from the client's perspective — no race exists if there's only one
  writer (the server).
- Server can batch anchors across wallets, amortising cost.

**Cons:**
- The aggregator becomes a Profile dependency, blurring the layer boundary
  established in `ARCHITECTURE.md`. Server availability becomes a wallet
  availability dependency.
- Requires the server to hold per-wallet metadata (which slot owns which
  OpLog stream) and to derive the per-version signing keys — which would
  require it to hold the wallet's master key. **Hard no** for the current
  trust model.
- A weaker variant — server witnesses the client's signed update and rebroadcasts
  — sidesteps the key-custody issue but still requires the wallet to sign each
  version, leaving us where we started for client-side races. Worse, the
  server's rebroadcast is itself a write at an aggregator slot, so it inherits
  the same `WALKBACK_FLOOR` problem one layer of indirection later. There is
  no implementation merit to this variant even if the trust-model objection
  to the strong variant were relaxed.

**Effort.** Very high. Re-architects the trust boundary; would need a separate
spec.

---

### 2.4 Approach D — Nostr win-broadcast (optimistic notify)

**STATUS: SELECTED (2026-05-24). Phase 1 prototype landed in PR #257 (draft).**

**Sketch.** After a successful `submit_commitment` for pointer `(walletId, v=N)`, the winning device immediately broadcasts an authenticated event over Nostr:

```
kind:       1 (NIP-01 short note; tag-discriminated)
tag:        pointer-win:<signingPubKeyHex>
content:    JSON { _kind, v=1, version=N, cid, signingPubKey, ts, sig }
sig:        secp256k1 over SHA-256(uint8 v ‖ uint32be version ‖ uint64be ts ‖ pubkey33 ‖ utf8 cid)
```

Same-identity siblings subscribe to `pointer-win:<ownSigningPubKeyHex>` and verify the payload signature against their own pointer signingPubKey (sibling = same key ⇒ trivial authentication). On valid receipt: dedupe `(signingPubKey, version)` via bounded LRU, trigger an early `recoverLatest()` + `reconcileLocalVersionDownward()` without waiting for the WALKBACK_FLOOR throttle to expire.

**Pros.**
- **Pure client-side change.** Aggregator stays as one-time KV authenticated storage; satisfies owner directive. Approach A's server-side reverse-index complexity is not needed.
- **Strictly no-worse-than-today degradation.** Nostr broken / partitioned / sibling offline ⇒ falls back to existing WALKBACK_FLOOR + reconcileLocalVersionDownward cycle. The aggregator is still authoritative; Nostr is just a convergence-time hint.
- **Authentication trivial.** Siblings share the wallet's signing key by construction. Spoofing requires possession of the wallet key, in which case the attacker can already publish to the aggregator directly — no new attack surface.
- **Replay-bounded.** 5-minute `ts` window + dedup LRU bound replay attempts even on a hoarding relay.
- **Backward compatible.** Old clients don't subscribe to the tag; they fall back to the existing path. New clients ignore broadcasts they can't verify (different wallet, expired, malformed) and drop silently.

**Cons.**
- **Doesn't address same-version race directly.** `reconcileLocalVersionDownward` is a strict downgrade (`candidate.version < localVersion`). In the dominant *same-version* race (both at V=N, A wins), local already equals broadcast.version, so the existing reconcile is a no-op. The broadcast becomes informational in that case — siblings learn about A's win ~1 s faster than the aggregator replica would tell them, but the 60 s WALKBACK_FLOOR throttle is not directly cleared. *Phase 2* adds an `adoptBroadcast(payload)` entrypoint on `ProfilePointerLayer` that bypasses the `>=` comparison and resets the throttle explicitly.
- **Lazy subscription install** (Phase 1). Receive-only devices that never publish themselves don't install their sibling subscription until their own first publish. *Phase 2* adds an eager polling loop or a `storage:pointer-ready` event from `ProfileStorageProvider`.
- **Nostr fanout cost.** Each successful publish ⇒ one signed event per relay subscribed. For a high-frequency wallet (multiple publishes per minute) this adds bandwidth. Bounded by the publish cadence the aggregator already enforces; not a new scaling concern.

**Effort.** Small. Phase 1 (PR #257): 1 standalone crypto module (~233 LOC), 3 plumbing accessors, 1 event type, 1 lifecycle-manager hook, 1 Sphere subscriber + publisher. Phase 2 (conditional on Stage B.1 verdict): add `adoptBroadcast(payload)` entrypoint and eager-subscribe trigger.

---

### 2.5 Approach E — Aggregator claim-lock (explicit lease via second requestId)

**STATUS: ALTERNATIVE / NOT SELECTED. Kept as fallback if Approach D Phase 2 proves insufficient.**

**Sketch.** Before publishing `requestId(walletId, N, "publish")`, write a tiny claim commitment to `requestId(walletId, N, "claim")`. The aggregator's existing one-shot KV semantics atomically pick a claim winner. The loser sees rejection on its own claim submit (~1 RTT) and switches to follower mode without ever attempting the publish.

**Pros.**
- **Aggregator unchanged.** Same RPC, new requestId derivation; satisfies owner directive.
- **Deterministic per-conflict latency.** 1 extra aggregator round trip (~200 ms) instead of 60–90 s WALKBACK + reconcile + throttle cycle. *Bounded by network RTT, not by replica lag.*
- **Loser knows immediately.** Doesn't need a broadcast — the aggregator's rejection IS the signal.

**Cons.**
- **Doubles aggregator submit load** per pointer publish (claim + publish). Operationally non-trivial if pointer publishes are frequent.
- **Stuck-claim failure mode.** Winner crashes between claim and publish ⇒ V=N slot is held but no V=N pointer exists. Other devices can't claim V=N (slot taken) and can't follow (no publish to fetch). Mitigation: encode a claim TTL via an `epoch` field in the requestId derivation (`requestId(walletId, N, "claim", epoch=t)`); after epoch expiry next epoch's claims are accepted. Requires aggregator clock-sync assumption (loose).
- **State machine more complex than Approach D.** Two new states: "won-claim-but-not-published-yet" (winner) and "lost-claim-waiting-for-winner's-publish" (loser). Both need timeouts + re-attempt logic.

**Effort.** Medium. New requestId derivation, two new state-machine states, TTL/epoch handling. Smaller than Approach G; larger than D.

---

### 2.6 Approach G — Per-device pointer slots (eliminate race at the source)

**STATUS: LONG-TERM ARCHITECTURAL DIRECTION. Not for immediate implementation.**

**Sketch.** Each device of the same wallet writes to a slot keyed by `(walletId, deviceId, N_device)` rather than `(walletId, N_wallet)`. No two devices ever race for the same slot. Readers enumerate all known device slots for a walletId, merge OpLogs across them (natural fit for OrbitDB's multi-writer CRDT model).

**Pros.**
- **Zero conflicts.** Each device only competes with itself for its own monotonic slot. The §1 race vanishes at the source.
- **Aggregator unchanged.** New slot derivation; no new aggregator features needed.
- **Architecturally aligned.** Matches OrbitDB's native multi-writer OpLog model — possibly the "right" long-term shape for cross-device coordination, with the pointer layer just publishing per-device heads instead of trying to elect a global winner.

**Cons.**
- **Large protocol revision.** Slot derivation change, reader logic change, device-list publication, stale-device pruning heuristic (devices that go offline for weeks).
- **Bootstrap problem.** New device must discover existing siblings before it can enumerate slots. Solvable via existing Nostr identity-binding events but adds boot-time latency.
- **Migration complexity.** Coexistence of old `(walletId, N)` slots with new `(walletId, deviceId, N_device)` slots during rollout window. Requires read-path fallback ordering.
- **Cardinality.** Aggregator state size grows linearly in device count × publish count rather than linearly in publish count. For wallets with many devices (rare but possible), this matters.

**Effort.** Large. Slot derivation, reader logic, device discovery via Nostr, stale-device pruning, migration of existing wallets. Needs its own RFC (RFC-251-G).

---

## 3. Recommendation

**Pursue Approach D (Nostr win-broadcast).** Phased rollout:

**Phase 1 — landed in PR #257 (draft):**
- Authenticated win-broadcast fires after every successful pointer publish.
- Sibling devices verify the signature against their own pointer signing pubkey, dedupe (signingPubKey, version) via bounded 256-entry LRU, trigger an early `recoverLatest()` + `reconcileLocalVersionDownward()` on receipt.
- Crypto module fully unit-tested (24 tests). Lifecycle-manager emission contract tested (4 tests). Full unit suite: 8132 pass, 0 regressions.
- Gated as DRAFT until Stage B.1 verdict (5× `manual-test-full-recovery.sh` run after `unicitynetwork/ipfs-storage#7` deploys).

**Phase 2 — conditional on Stage B.1 outcome:**
- Add `ProfilePointerLayer.adoptBroadcast(payload)` — direct entrypoint that bypasses `reconcileLocalVersionDownward`'s `>=` comparison so same-version races (the dominant remaining failure mode after Phase 1) get resolved.
- Add eager-subscribe trigger — `storage:pointer-ready` event from `ProfileStorageProvider` so receive-only devices install their sibling subscription before their own first publish.
- Decision criterion for proceeding to Phase 2: if Stage B.1 shows §C.2 still timing out OR WALKBACK_FLOOR > 5/run AND Phase 1 broadcast logs show ≥ 1 broadcast/conflict reaching siblings (signal Phase 1 is firing but not closing the gap), proceed to Phase 2.

**Phase 3 — long-term architectural direction (separate RFC):**
- Move toward Approach G (per-device pointer slots). Eliminates the race at the source. Major protocol revision; needs its own RFC for slot derivation, device discovery, migration, stale-pruning. Phase 1 + Phase 2 don't preclude G — D and G compose (per-device slots remove the conflict, broadcasts continue serving as fast OpLog-head propagation).

**Approach E (claim-lock) is held as fallback** if D Phase 1 + Phase 2 prove insufficient AND G is too large a project for the timeline. E's deterministic per-conflict latency is attractive, but the doubled aggregator load and stuck-claim TTL complexity make it second-choice to D + G.

### Rationale for D over the alternatives

| Criterion | D (Phase 1) | E (claim-lock) | G (per-device slots) |
|---|---|---|---|
| Aggregator change | None | None (new requestId derivation) | None (new requestId derivation) |
| Implementation effort | Small (landed) | Medium | Large (own RFC) |
| Per-conflict latency | ~1 s (Nostr RTT) | ~200 ms (1 extra agg RTT) | 0 (no race) |
| Strict same-version race | Phase 2 needed | Resolved | Resolved by construction |
| Degradation on transport failure | Falls back to today | Falls back to today | N/A — no race |
| Aggregator load delta | None | Doubled | Linear in device count |
| Operational risk | Low | Medium (stuck claims) | High during migration |

**D is the smallest first step** that yields measurable progress on the convergence-time problem while leaving room for E (fallback) and G (long-term) as Stage B.1's empirical data informs the next decision.

---

## 4. Acceptance Criteria (Approach D)

### Phase 1 (PR #257 — landed, draft)

1. **Crypto correctness.** Sign / verify roundtrip on real secp256k1 with canonical fixed-width hash; tamper rejection per field (`version`, `cid`, `ts`, `signingPubKey`, `sig`); schema-version rejection; replay-window enforcement (5-minute `ts` bound); anti-spoof guard at sign time. ✅ Covered by 24 unit tests in `tests/unit/pointer/win-broadcast.test.ts`.

2. **Lifecycle-manager emission contract.** Successful pointer publish ⇒ emits `storage:pointer-published` event carrying signed payload + per-wallet broadcast tag. Transient/permanent publish failures DO NOT emit. Pointer layer without the `getSignerForWinBroadcast` accessor (legacy stub) gracefully skips with a log; publish-success contract preserved. ✅ Covered by 4 integration tests in `tests/unit/profile/lifecycle-manager-pointer-win-broadcast.test.ts`.

3. **No regression on existing pointer paths.** `tests/unit/pointer/category-*.test.ts`, `tests/unit/profile/pointer/walkback-floor-retry.test.ts`, `tests/unit/profile/lifecycle-manager-reconcile-downward.test.ts`, `tests/unit/profile/lifecycle-manager-publish-retry.test.ts` pass unchanged. ✅ Full unit suite: 8132 pass, 0 regressions.

4. **Operator observability.** New typed event `storage:pointer-published` declared in `StorageEventType` with explicit doc that it is *additive* to the existing `storage:replica-lag-reconciled` (does NOT replace — they fire from different code paths and signal different conditions). Phase 1 broadcast logs (debug-level `[Sphere] pointer-win broadcast {published|received}: ...`) provide the diagnostic surface for Stage B.1 measurement.

5. **Degradation contract.** If `transport.publishBroadcast` is absent or rejects, the publish-success return is unaffected. If the Nostr subscription drops, missed broadcasts simply leave siblings on the existing WALKBACK_FLOOR + reconcile path. ✅ Verified by 4th integration test ("pointer without getSignerForWinBroadcast gracefully skips").

### Phase 2 (conditional)

6. **`adoptBroadcast(payload)` entrypoint** on `ProfilePointerLayer` bypasses the `reconcileLocalVersionDownward`'s `>=` comparison and explicitly resets the WALKBACK_FLOOR throttle when called. Authentication: the payload's `signingPubKey` MUST equal this layer's own `signingPubKey` (caller has already verified the signature; this is a defense-in-depth check at the layer boundary).

7. **Eager-subscribe trigger.** `ProfileStorageProvider` emits `storage:pointer-ready` once `getPointerLayer()` first returns non-null. Sphere subscribes and installs the per-wallet pointer-win subscription on receipt — fixes the Phase 1 lazy-install gap for receive-only devices.

8. **Convergence under simulated replica lag.** A new integration test simulates two same-identity clients each publishing concurrently against an aggregator with 30 s of read-replica lag. Sibling adopts the winner's V=N within `2× Nostr RTT` (~2 s) of the first conflict — empirical proof that Phase 2 closes the convergence-time gap.

### End-to-end (manual-test contract)

9. **`manual-test-full-recovery.sh` §C.4 reaches §F on > 5 consecutive runs** with the IPFS sidecar from `unicitynetwork/ipfs-storage#7` deployed AND Approach D Phase 1 (+ Phase 2 if needed) active. WALKBACK_FLOOR count per run ≤ 5 (matches Approach A's original target). The first conflict per cycle still discovers the race naturally (no pre-emptive prediction); the broadcast just resolves it cheaply within ~1 s instead of re-entering the 60–90 s WALKBACK cycle.

---

## 5. Out of Scope for This RFC

- **Aggregator-side changes.** Out by owner directive — see Update at top of RFC. The aggregator stays as one-time KV authenticated storage; this RFC's protocol lives entirely above that layer.
- **Approach G's slot-derivation + migration spec.** The long-term per-device pointer slot architecture is in scope for `RFC-251-G` (a future RFC). This RFC's §2.6 only sketches G's shape and tradeoffs as a directional pointer.
- **Multi-writer fairness.** With > 2 devices the cohort still races, but each conflict is bounded by Nostr RTT (Phase 1) or `adoptBroadcast` (Phase 2). Backoff jitter or other fairness improvements can ride a follow-up PR if observed to matter.
- **Cross-device profile-level coordination.** Pointer-layer races are one symptom; OrbitDB OpLog merges across devices have their own race surface documented in `PROFILE-ARCHITECTURE.md §10.4`. That is a separate work stream — fixing pointer races here unblocks observability of those issues but does not solve them.
- **IPFS slow-pin amplification.** Tracked separately as `unicitynetwork/ipfs-storage#7` (the instant-pin sidecar). Stage B.1 — re-running the manual test 5× after the sidecar deploys — is the empirical measurement that decides whether D Phase 1 is sufficient or whether D Phase 2 also needs to land.

---

## 6. Open Questions (Approach D)

1. **Phase 2 trigger — Stage B.1 verdict.** What WALKBACK_FLOOR-per-run + §C.2-success-rate thresholds promote us from "Phase 1 sufficient" to "implement Phase 2 now"? Provisional threshold proposed in §3: §C.2 failing on any of 5 runs OR WALKBACK_FLOOR > 5/run AND Phase 1 broadcast logs show ≥ 1 broadcast/conflict reaching siblings (Phase 1 firing but not closing the gap). To be finalized after Stage B.1 data lands.

2. **Same-version race — adopt-broadcast authentication boundary.** Phase 2 adds `ProfilePointerLayer.adoptBroadcast(payload)`. The Sphere subscriber has already verified the payload signature against own signing pubkey before calling. Does the layer redundantly re-verify (defense-in-depth, ~5 ms cost) or trust the caller (zero cost, smaller blast radius if a future caller forgets the verify step)? Provisional choice: redundant verify — pointer layer is a security boundary, the cost is negligible, and untrusted-caller scenarios become real if `adoptBroadcast` ever leaks beyond Sphere wiring.

3. **Eager-subscribe — Phase 1 vs Phase 2 timing.** Phase 1's lazy-on-own-publish install is acceptable for *measurement* (Stage B.1's 2-device scenario where both devices publish). For PRODUCTION rollout, the receive-only case matters — wallets used only for receiving (cold-storage observers) never publish and would never install the subscription under Phase 1. Should Phase 2's `storage:pointer-ready` event ship sooner regardless of Stage B.1 verdict, just to fix the production gap?

4. **Multi-device fanout cost.** A wallet with N active devices ⇒ each successful publish ⇒ N-1 broadcast deliveries. For N ≤ 3 (the realistic upper bound for personal wallets) this is negligible. If we ever support N > 10 (organizational wallets shared across many devices), the broadcast fanout becomes a real cost. Defer specific mitigation (relay-side TTL, broadcast batching, throttling) until N > 10 is observed.

5. **Replay-window calibration.** Phase 1 uses 5-minute `ts` window. Too short ⇒ legitimate broadcasts dropped under clock skew between devices. Too long ⇒ replay attempts hoarded by malicious relays remain valid longer. 5 min is a reasonable starting bound (NTP-synced devices stay within seconds) but should be calibrated against observed clock skew distributions in production. Add a `pointer-win:replay-rejected` debug log to enable measurement.

6. **Broadcast dedup LRU sizing.** Phase 1 uses 256 entries. Each entry is a `${signingPubKeyHex}:${version}` string (~80 bytes). 256 × 80 = ~20 KB memory — trivial. Sized to comfortably bound replay attempts within the 5-min `ts` window even for a hyperactive wallet publishing every second (300 unique versions/5 min ⇒ 256 entries covers the window). Validate during Stage B.1 — if observed broadcast rates are higher, bump.

7. **Compatibility with future Approach G.** When per-device pointer slots (Approach G) eventually land, do per-device broadcasts continue using the same Nostr event kind and tag scheme, or do they need a parallel namespace to disambiguate per-wallet-aggregate vs per-device-slot broadcasts? Likely the latter (`pointer-win-device:<deviceId>` tag) to avoid receivers conflating the two. Defer the design until G is on the critical path.

---

## 7. Decision Record

### 2026-05-24 — Initial direction (Approach A, CAS)

Drafted as design RFC recommending Approach A (aggregator-side compare-and-swap). Open Question 1 (server-side reverse-index data-model) identified as the gating prerequisite. No implementation.

### 2026-05-24 — Direction superseded by owner directive

Owner directive: *"Treat aggregator as one-time KV authenticated storage. Design the pointer protocol around it."*

This forecloses Approach A (requires aggregator schema change) and reaffirms Approach C's existing rule-out. Approach B's silent-split failure mode (§2.2 Cons) was already documented as load-bearing — combined with the directive forcing pure-client-side design, B is dropped in favor of Approach D (same authentication primitive, same transport, simpler state machine, no election complexity).

### 2026-05-24 — Recommendation flipped to Approach D

§§2.4–2.6 added (Approaches D, E, G). §3 rewritten to recommend D with phased rollout. §4 acceptance criteria rewritten for D Phase 1 + Phase 2. §6 open questions rewritten for D-specific unknowns.

### 2026-05-24 — Phase 1 prototype landed

PR #257 (draft) implements Approach D Phase 1:
- `profile/aggregator-pointer/win-broadcast.ts` — standalone signed payload module (24 unit tests).
- `ProfilePointerLayer.getSignerForWinBroadcast()` accessor.
- `storage:pointer-published` event variant on `StorageEventType`.
- Lifecycle-manager emits signed payload + per-wallet tag after successful publish (4 integration tests).
- Sphere subscribes both directions: forwards `storage:pointer-published` to Nostr; lazy-installs `pointer-win:<signingPubKeyHex>` subscription on first own publish; verified broadcasts trigger early `recoverLatest()` + `reconcileLocalVersionDownward()`.

Full unit suite: 8132 pass, 0 regressions. Held as DRAFT pending Stage B.1 verdict.

### Next decision point — Stage B.1 verdict

After `unicitynetwork/ipfs-storage#7` (IPFS instant-pin sidecar) lands and deploys: re-run `manual-test-full-recovery.sh` 5×. Tally WALKBACK_FLOOR per run, §C.2/§C.4 outcomes, broadcast fire/receive rates from PR #257's debug logs.

Decision tree:
- §C.2 succeeds on all 5 AND WALKBACK_FLOOR ≤ 5/run → Problem B mitigated; PR #257 may merge as defense-in-depth or stay draft (the broadcasts add no harm).
- §C.2 still flaky AND Phase 1 broadcasts are firing → Phase 2 implementation (adoptBroadcast + eager-subscribe).
- §C.2 still flaky AND Phase 1 broadcasts are NOT firing → diagnose Phase 1 wiring before adding more surface.

Per the §3 phased plan, Approach G remains the long-term direction regardless of B.1 outcome — D solves the symptom, G eliminates the race at the architectural source. G is deferred to its own RFC (`RFC-251-G`).

### Optional ADR

If desired post-merge, an ADR can be added at `docs/uxf/ADR-NNN-pointer-coordination.md` referencing this RFC and the 2026-05-24 decision rationale. Lower priority than the Stage B.1 measurement.
