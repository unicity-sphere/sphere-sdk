# RFC-251 — Same-Identity Cross-Device Pointer Coordination

**Status:** Draft — design RFC, no implementation yet
**Source:** [Issue #251](https://github.com/unicity-sphere/sphere-sdk/issues/251) Problem 1
**Companion specs:**
- [`PROFILE-AGGREGATOR-POINTER-SPEC.md`](./PROFILE-AGGREGATOR-POINTER-SPEC.md) — pointer wire format & W7 walkback floor
- [`PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md`](./PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md) §8.5 — many-device burst publish characterisation
- PR #246 — WALKBACK_FLOOR throttle (#245 #3)
- PR #249 — W7 reconcile-downward (#247 short-term fix)

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

**Sketch.** Extend the aggregator's `submit_commitment` RPC with an optional
`expectedPriorVersion` field. The aggregator atomically rejects with a new
`VERSION_CONFLICT` status if the slot already holds a commitment at the
claimed version. The client retries with the aggregator-reported `currentVersion`
as its new baseline — single round trip, no walkback needed.

**Pros:**
- Eliminates the read-replica race entirely (CAS is anchored at the aggregator's
  authoritative view, not its replica).
- Backwards-compatible: existing clients omit the field and behave as before.
- Convergence is O(k) round trips in the cohort, deterministic — same complexity
  as today's §8.5 analysis, but with one round trip per conflict instead of an
  exponential probe + walkback + throttle cycle (~2 – 3 minutes per).

**Cons:**
- Requires an aggregator-side schema change. Coordinated rollout with
  `aggregator-go` (Go service) — touches the L3 layer, not just SDK-side.
- The "what is the current version of slot X" answer requires the aggregator to
  index by `(wallet_signing_pubkey, slot)` — a derived index it does not
  maintain today (commitments are stored by `requestId` only).

**Effort.** Medium-high. Bilateral SDK + aggregator change; needs a real
testcontainer-based integration test to exercise the conflict path.

---

### 2.2 Approach B — Single-writer election via Nostr presence

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
- Failure modes are subtle: split-brain during failover can produce two
  pointers at the same version, replaying the same race we want to eliminate.

**Effort.** High. New protocol surface, new failure modes, careful test matrix
required.

---

### 2.3 Approach C — Server-side anchoring

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
  version, leaving us where we started for client-side races.

**Effort.** Very high. Re-architects the trust boundary; would need a separate
spec.

---

## 3. Recommendation

**Pursue Approach A (Aggregator CAS).** Rationale:

1. **Smallest blast radius.** CAS is a one-field, additive change to the
   `submit_commitment` RPC. Existing clients are unaffected.
2. **Deterministic convergence.** Each conflict costs one extra round trip,
   not 60 – 90 s of walkback + throttle.
3. **Layer-clean.** Coordination lives at the layer that owns the SMT — no
   new transport-layer protocol, no new trust dependencies.
4. **Testable.** A testcontainer-based aggregator can simulate the race
   precisely in a unit-of-work that finishes in seconds, not minutes.

Approach B is a viable Plan B if the aggregator team rejects the schema
change. Approach C is deferred indefinitely (changes the trust model).

---

## 4. Acceptance Criteria for the Implementation PR

Any implementation MUST satisfy:

1. **Convergence under simulated replica lag.** A new test (testcontainer-based)
   simulates two clients sharing one identity, each publishing concurrently
   against an aggregator with 30 s of read-replica lag. Both clients reach
   pointer-publish success within 10 s of the first conflict.

2. **No regression on the single-writer happy path.** `pointer-roundtrip.test.ts`
   and `tests/unit/profile/pointer/walkback-floor-retry.test.ts` pass without
   modification.

3. **Backwards compatibility.** A new-protocol client submitting against an
   old-protocol aggregator (no `expectedPriorVersion` support) falls back to
   the current walkback/throttle path without error.

4. **Operator observability.** Emit `pointer:cas-conflict-resolved` (new typed
   event) with `{fromVersion, toVersion, attemptsUsed}` when CAS resolves a
   conflict.

5. **Acceptance for §C.4 in `manual-test-full-recovery.sh`.** The script
   reaches §F (script end) on > 5 consecutive runs with **zero**
   `AGGREGATOR_POINTER_WALKBACK_FLOOR` warn lines per cycle.

---

## 5. Out of Scope for This RFC

- **Aggregator-side implementation details.** The Go service team owns the
  CAS index and storage decisions. This RFC defines the protocol contract,
  not the implementation strategy.
- **Multi-writer fairness.** With > 2 devices the cohort still races, but
  each conflict is one round trip (vs minutes). The §8.5 `O(k)` analysis
  still applies — fairness improvements (e.g., backoff jitter) can ride a
  follow-up PR if they prove necessary.
- **Cross-device profile-level coordination.** Pointer-layer races are one
  symptom; OrbitDB OpLog merges across devices have their own race surface
  documented in `PROFILE-ARCHITECTURE.md §10.4`. That is a separate work
  stream — fixing pointer races here unblocks observability of those issues
  but does not solve them.

---

## 6. Open Questions

1. **Aggregator API extension** — coordinate with `aggregator-go` maintainers
   on the exact field name (`expectedPriorVersion` vs `cas_version` vs
   `slot_version`) and whether to bundle it under a sub-object for future
   extensibility.
2. **Migration window** — for the few weeks where some aggregator instances
   support CAS and others don't, do we feature-flag the client-side use of
   CAS (off by default), or trust the graceful-fallback path on
   `METHOD_NOT_FOUND`?
3. **Test fixtures** — the existing `goggregator-test.unicity.network` is
   shared; a CAS-aware aggregator testcontainer needs to be added to
   `test/integration/` for deterministic CI runs.

---

## 7. Decision Record

When this RFC is approved or rejected, add an ADR entry:

```
docs/uxf/ADR-NNN-pointer-cas.md
```

referencing this RFC and the decision rationale.
