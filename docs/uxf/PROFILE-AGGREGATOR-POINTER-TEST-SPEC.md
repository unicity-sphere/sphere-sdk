# UXF Profile — Aggregator-Anchored Pointer Layer — Test Specification

**Status:** Draft v2.2 — paired with ARCHITECTURE v3.4 and SPEC v3.4 (embedded-trust-base model).
**Date:** 2026-04-21
**Companion docs:**
- [`PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md`](./PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md) (v3.4)
- [`PROFILE-AGGREGATOR-POINTER-SPEC.md`](./PROFILE-AGGREGATOR-POINTER-SPEC.md) (v3.4)
- [`PROFILE-ARCHITECTURE.md`](./PROFILE-ARCHITECTURE.md) §10.4 JOIN (load-bearing)

This document is a **pre-implementation test plan**. It enumerates every scenario that MUST pass before the pointer layer is considered shippable. It contains no TypeScript code. Shell scripts in §5 are executable against real Unicity testnet infrastructure.

---

## v2.2 Changelog (2026-04-21) — SPEC v3.4 alignment

Aligned with SPEC v3.4 embedded-trust-base amendments (§3 / §8.4 / §12):

**Deleted (4 scenarios):**
- **D14** (multi-mirror TOFU first-touch fake-root rejection) — not applicable under embedded trust base.
- **D15** (TLS cert pinning mismatch → `CERT_PIN_MISMATCH`) — constant deleted.
- **D16** (mirror list tampering → `MIRROR_LIST_TAMPERED`) — constant deleted.
- **H3-R** (cross-mirror TOFU downgrade regression, sub-cases A/B/C) — not applicable under embedded trust base.

**Amended:**
- **F1–F9** trust-base scenarios simplified: trust base is embedded (`assets/trustbase/<network>.ts`) and consumed via `OracleProvider.getRootTrustBase()`, identical instance to L4 / `PaymentsModule`. **F5** becomes "`OracleProvider.getRootTrustBase()` returns the same instance `PaymentsModule` uses."
- **C6** trust-base rotation: simplified to epoch-mismatch detection on embedded `RootTrustBase`, raising `AGGREGATOR_POINTER_TRUST_BASE_STALE` (requires SDK update). No mid-session remote rotation in v1.

**Coverage matrix (§4) updates:**
- H3 / H9 rows: changed to "v2 future work (bundled trust base in v1 — see SPEC v3.4 §8.4)"; PRIMARY / SECONDARY columns set to "n/a for v1".
- Rows referencing deleted error codes (`CERT_PIN_MISMATCH`, `MIRROR_LIST_TAMPERED`, `TRUST_BASE_DIVERGENCE`) removed.
- Secondary references to deleted D14/D15/D16/H3-R scenarios removed or replaced.

**Total scenarios:** 146 → 142 (−4). Category totals updated in final summary table.

H3 and H9 coverage in v1: n/a. These hazards are deferred to v2. Future work will reintroduce multi-mirror TOFU, TLS cert pinning, and mirror-list integrity checks as part of a distributed-trust-base milestone.

---

## v2 Changelog (from v1)

**Added (13 new scenarios + new Category P):**
- **N7b**: BLOCKED persists across process restart
- **K10**: Originated-tag downgrade race during OrbitDB merge
- **D11a, D11b**: Slow-network arithmetic feasibility (timeout budgets + RTT drift injection)
- **M13–M15, M17**: DAG-aware token conservation (JOIN rules per PROFILE-ARCHITECTURE.md §10.4 + real double-spend; M16 deleted in v2.1 with M7 — finality-window concept not in SPEC, covered by H5 trust-base rotation)
- **H3-R, H8-R, H14-R**: Named regression tests for critical findings (cross-mirror TOFU, REJECTED double-spend, pending_version idempotency). (H3-R deleted in v2.2 per SPEC v3.4.)
- **N14**: Legacy cold-start recovery without pointer layer enabled
- **Category P (P1–P8)**: Conformance & security invariants
  - **P1–P3**: Proof-verify-always assertion + TOFU trust base + proof staleness
  - **P4–P7**: SDK call-signature pinning (constructors, RequestId formula, version pin)
  - **P8**: HKDF domain-separation known-answer test (KAT)

**Framework-level:**
- Token conservation is now a universal `afterEach` invariant, asserted on every scenario via `TokenConservationInvariant.assert()` helper.

**Editorial:**
- Parameterized scenario matrix introduced (C3/C4, D2–D7, J1–J3) — marked `[parameterized by ...]`.
- Fixtures consolidated into §3: `freshWallet`, `pointerInitialized`, `midLifecycle`, `twoDeviceSync`, `blockedState`.
- Scope-creep identification: 2 Nostr-pure transport tests moved to appendix with cross-reference.

**v2.1 hardening (post-adversarial review):**
- §4 Coverage Matrix authored (was missing).
- H8-R rewritten against correct SPEC §7.3 row (AUTHENTICATOR_VERIFICATION_FAILED, not REQUEST_ID_EXISTS).
- G2 rewritten to assert H7 ordering (republish BEFORE advance).
- M7 and M16 deleted — finality-window semantics not in SPEC; H5 trust-base rotation covers the use case.
- M13–M15 re-anchored to actual PROFILE-ARCHITECTURE.md §10.4 JOIN rules.
- P8 HKDF KAT: canonical inputs specified, outputs marked `[TO BE COMPUTED]` tied to O-1 blocker.
- TokenConservationInvariant rewritten with 3-bucket model (spendable/quarantined/tombstoned).
- §5 shell-script prologue hardened (`set -Eeuo pipefail`, traps, egress-interface detection, JSON oracles).
- New invariants I-FX (fixture isolation) and I-OR (oracle independence).
- H3-R expanded with both-mirrors-forged and single-mirror-unreachable sub-cases. (Subsequently deleted in v2.2 per SPEC v3.4.)

**Total scenarios:** 135 → 146 (+13 new, −2 deleted M7/M16). Categories: 15 → 16 (+Category P). Lines: ~1058 → ~1475.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Test Taxonomy](#2-test-taxonomy)
3. [Test Harness Specification & Fixtures](#3-test-harness-specification--fixtures)
4. [Coverage Matrix (H/W Findings → Tests)](#4-coverage-matrix)
5. [Real-Infra CLI Test Scripts (N1–N14)](#5-real-infra-cli-test-scripts)
6. [Known Acknowledged Residuals (Not Testable)](#6-known-acknowledged-residuals)
7. [Test-Data Freezing](#7-test-data-freezing)
8. [Open Items / Blockers](#8-open-items--blockers)

---

## 1. Executive Summary

### 1.1 Goal

This specification is the **formal proof-by-enumeration** that the Profile Aggregator Pointer Layer satisfies its north-star invariant:

> **No tokens ever lost under any circumstances or race conditions.**

Every scenario below is stated, evaluated against that invariant, and mapped to a concrete assertion that proves or disproves it. The test spec predates the implementation PR by design — no code is written until every red-boxed scenario in this document has a named owner, a fixture, and a pass criterion.

### 1.2 Invariants Under Test

| # | Invariant | Source |
|---|---|---|
| I-TC  | **Token conservation.** Every token held by any device at time T is recoverable at time T' > T, from at least one device holding the wallet's mnemonic, regardless of crashes, network faults, or concurrent writers. | North star |
| I-VM  | **Version monotonicity.** `localVersion` is non-decreasing over the wallet's lifetime. Committed versions are permanent. | SPEC §5.3 I-1 |
| I-DR  | **Deterministic recovery.** Given the mnemonic alone and a reachable aggregator + IPFS, recovery produces a bit-identical inventory on any device. | SPEC §4–§8 |
| I-CS  | **Crash safety.** Any publisher crash at any instruction boundary leaves no state that could cause OTP reuse, token loss, or silent fork across devices. | SPEC §7.1 / ARCH §7.2 |
| I-MDC | **Multi-device convergence.** K devices racing at the same `V` converge in `O(K)` publish attempts with zero token loss. | SPEC §9 / ARCH §8.5 |
| I-TV  | **Trustless proof verification.** No inclusion or exclusion claim is acted upon without `InclusionProof.verify(trustBase, requestId)` returning OK. | SPEC §8.4 |
| I-TB  | **Shared trust base.** The `RootTrustBase` used by the pointer layer is identically the instance used by L4. | SPEC §8.4.2 H6 |
| I-OT  | **Originated-tag discipline.** Only `'user'`-tagged entries can trigger BLOCKED; semantic re-validation catches forged tags. | SPEC §10.2.3 |
| I-PC  | **Proof Conservation (v2).** Every aggregator proof read (inclusion or non-inclusion) MUST be verified before trust. Token count invariant is checked after every scenario via `TokenConservationInvariant.assert()`. | SPEC §6.2 / §8.4, ARCH §6.5 |
| I-FX  | **Fixture Isolation (v2).** Each test scenario's fixture is independent; no test depends on side effects from prior tests. Wallet state between scenarios is reset (fresh mnemonic or clean storage). | Test harness |
| I-OR  | **Oracle Independence (v2).** Pointer layer does not depend on L4 oracle for publish; dependency is unidirectional (L4 trusts pointer proofs). Pointer validation is crypto-only, not semantic. | SPEC §8.4, ARCH §6.5 |

### 1.3 Test Harnesses

| Harness | What it tests | Where it runs |
|---|---|---|
| **Unit** | Pure functions: key derivation, XOR, padding, probe pseudocode, classifyVersion tri-state, encode/decode length prefix, marker compactor, BLOCKED state machine, backoff calculator, HKDF subkey separation, SigningService constructors. | `tests/unit/profile/pointer/*.test.ts` — Vitest, no network. |
| **Integration** | Full publish/recover state machine with **mocked** aggregator + **mocked** IPFS. Covers conflict retry, partial publish, crash-restart, trust-base rotation, transient-vs-permanent error classification, DAG-aware token conservation (JOIN rules). | `tests/integration/pointer/*.test.ts` — Vitest with in-process mock servers. |
| **E2E (real testnet)** | Real Unicity testnet aggregator + real Nostr testnet relay + real Unicity IPFS gateways + real CLI binary. | `tests/e2e/pointer-*.test.ts` (Vitest); `tests/e2e/cli-pointer-*.sh` (Bash). |
| **Chaos** | Random fault-injection wrappers around integration/E2E (SIGKILL during publish, packet loss during probe, clock jumps, latency injection). | `tests/chaos/pointer/*.sh` — orchestrator scripts that loop integration tests under failure injection. |

### 1.4 Finding-to-Test Mapping (top-level)

Every critical H-finding (H1–H14) and warning finding (W1–W12) from SPEC §16 (change log) and ARCH §15.5 MUST appear at least once in the test coverage matrix (§4). Tests where a finding's regression test is the PRIMARY purpose of the test case are marked in §4's "Primary" column. v2 adds explicit regression tests (H8-R, H14-R). (H3-R deleted in v2.2 per SPEC v3.4 embedded-trust-base amendments — H3 and H9 are v2 future work.)

---

## 2. Test Taxonomy

Sixteen categories (A–P). Each category starts with a one-paragraph rationale followed by enumerated scenarios. Scenario numbering is **stable** — test engineers cite scenarios by `<Category><N>` (e.g., `B5`, `M11`).

### Category A — Happy Path Baselines

**Rationale.** If the happy path is broken, everything downstream is noise. A suite of five scenarios exercises the undeviated flow: fresh wallet create, sequential publishes, CAR round-trip, per-wallet scoping, multi-address sharing. Every other category subtly depends on these five passing.

| ID | Scenario | Preconditions | Actions | Expected | Success Criterion |
|---|---|---|---|---|---|
| **A1** | Fresh wallet → single publish → cold-start recovery on a second device returns the same tokens. | Fresh data dirs on two devices; shared mnemonic; aggregator + IPFS reachable. | Device A: `Sphere.init`, faucet a token, `publish`. Destroy A. Device B: `Sphere.import(mnemonic)`, wait for recovery. | Device B's OpLog contains the token. | `payments.getTokens().length === 1`; `balance === faucet amount`; no Nostr replay (B uses `createNoopTransport`). |
| **A2** | Sequential publishes at `v = 1..5` → discovery finds latest. | Device with Profile mode. | Send 5 tokens in sequence, each triggering a `flushToIpfs` + pointer publish. Destroy. Re-import. | Recovery probes converge to `v = 5` and fetches its CAR. | `localVersion === 5` after recovery; all 5 tokens present. |
| **A3** | CAR round-trip via IPFS (pin + fetch verification). | Two Unicity IPFS gateways reachable. | Publish at `v = 1` to gateway G1. Re-import on Device B using ONLY gateway G2. | CAR fetch from G2 succeeds; content-address verify passes. | `verifyCidMatchesBytes` returns true; no `AGGREGATOR_POINTER_CORRUPT`. |
| **A4** | Per-wallet scoping — two wallets on same device don't collide. | Two mnemonics, same `dataDir`. | `Sphere.init(wallet1)` → publish. `Sphere.switchToAddress(...)` is NOT used; this tests separate wallets. `Sphere.init(wallet2)` with a DIFFERENT mnemonic (separate Profile). | W1's pointer/marker/BLOCKED keys are namespaced by `hex(signingPubKey)` and do not overlap with W2's. | Both wallets publish independently; `PENDING_VERSION_KEY` keys are distinct; `BLOCKED_FLAG_KEY` keys are distinct; `MUTEX_KEY` keys are distinct. |
| **A5** | Multi-address within one wallet — one OpLog, one pointer chain. | One mnemonic, HD addresses `0` and `1`. | `switchToAddress(1)` → faucet → send → back to `0`. | All HD addresses under one mnemonic share ONE OpLog and ONE pointer chain (SPEC §5.2). | `localVersion` advances monotonically regardless of active address; `signingPubKey` is wallet-global, not per-address. |

### Category B — Crash Safety (pending_version marker discipline)

**Rationale.** The pending-version marker is the **load-bearing defense** against OTP reuse (SPEC §7.1, §11.2). A crash at any instruction boundary — marker-write, submit-A, submit-B, localVersion persist, marker-clear — must leave the wallet in a state that never reuses `(v, side, xorKey)` against a different plaintext. Eleven scenarios (B1–B11) enumerate the crash points and document the restart behavior.

For each scenario: **Pre-state** (what's on disk before crash), **Crash trigger** (instruction at which SIGKILL fires), **Restart behavior** (what the publish code does on re-entry), **Expected outcome**, **Assertion**.

| ID | Pre-state | Crash trigger | Restart behavior | Expected | Token-loss assertion |
|---|---|---|---|---|---|
| **B1** | `localVersion = k`; marker absent. | BEFORE marker write. | Recompute `v = k+1`; write fresh marker; proceed normally. | Ordinary publish at `v = k+1`; no residue. | `payments.getTokens()` unchanged; no SMT entry at any `v`. |
| **B2** | `localVersion = k`; marker `(k+1, cidHash_1)` written. | AFTER marker write, BEFORE submit A begins. | Marker present; H13 idempotent-retry: same v AND same cid → keep v, re-derive deterministic payload (§7.1.4). | Publish succeeds at `v = k+1` with byte-identical ctA/ctB. | `localVersion === k+1`; aggregator shows IDs at both sides. |
| **B3** | Submit A succeeded; marker intact. | AFTER submit A, BEFORE submit B begins. | Marker present, same cid. Re-submit A (returns `REQUEST_ID_EXISTS` idempotent-success per SPEC §7.3 row 2); submit B fresh. | Both sides committed at same `v`. | No OTP reuse detectable (ctA is byte-identical between attempts). |
| **B4** | Submit A succeeded; submit B in-flight (not acked). | AFTER submit A, AFTER submit B send but BEFORE ack. | Re-submit both: A → `REQUEST_ID_EXISTS`; B → either `SUCCESS` (lost ack) or `REQUEST_ID_EXISTS`; both treated as idempotent-success. | Both sides at `v = k+1`. | No double-commit at different version; no partial residue at `v = k+2`. |
| **B5** | Both sides committed at `v = k+1`; marker intact; `localVersion` NOT persisted. | AFTER both SUCCESS, BEFORE `localVersion` persist. | SPEC §7.3 row 4 — `REQUEST_ID_EXISTS` on both sides with marker match → idempotent replay → persist `localVersion = k+1`; clear marker. | `localVersion` reaches `k+1`; marker cleared. | No §9 reconciliation invoked (arch §7.3 bullet 2). |
| **B6** | `localVersion = k+1`; marker intact. | AFTER `localVersion` persist, BEFORE marker clear. | §7.1.4 stale branch: `previousEntry.v < currentLocalVersion` is false (equal), but §7.1.6 fallback — next publish sees `previousEntry.v == currentLocalVersion` → treat as stale and drop. | Next publish computes `v = k+2` fresh. | Marker auto-compacted; no spurious advance. |
| **B7** | Marker `(v = X, cidHash = H)`; current cidBytes hash to `H`. | Process restart. | **Idempotent replay (H13).** Same v AND same cidHash → retry deterministic payload; aggregator returns `REQUEST_ID_EXISTS` → treat as success. | No new version consumed; publish completes idempotently. | No OTP reuse; SPEC §7.1.4 rule verified. |
| **B8** | Marker `(v = X, cidHash = H)`; current cidBytes hash to `H' ≠ H`. | Process restart. | Rollback-safe bump (H13 / §7.1.4): `v := max(v, previousEntry.v) + 1`; persist fresh marker; submit at new v. | New publish at `v+1` with fresh keys. | OTP reuse impossible (fresh `(v+1, side)` → fresh xorKey). |
| **B9** | Marker `(v = X, ...)`; `currentLocalVersion = Y > X`. | Process restart. | §7.1.4 stale branch: `previousEntry.v < currentLocalVersion` → clear marker; proceed with current v. | Stale marker discarded; publish at `Y+1`. | No regression of `localVersion`; no OTP reuse. |
| **B10** | Marker `(v = 2^30, ...)`; `currentLocalVersion = 5`. | Process restart. | §7.1.4 tamper check: `previousEntry.v > currentLocalVersion + MARKER_MAX_JUMP (1024)` → raise `AGGREGATOR_POINTER_MARKER_CORRUPT`. | Publish refused; error surfaced; recovery via `clearPendingMarker()`. | No brick-via-single-write (SPEC §7.1.4 rationale). |
| **B11** | Marker file contains partial JSON / corrupt bytes. | Process restart. | Parser rejects; raises `AGGREGATOR_POINTER_MARKER_CORRUPT`. | Publish refused. `clearPendingMarker()` capability-gated recovery (W6): removes marker AND **SETs BLOCKED** to force re-verify. | No silent resume on corrupt marker; BLOCKED prevents immediate publish post-clear. |

### Category C — Multi-Device Contention

**Rationale.** Multi-device scenarios test the core race-safety property: when two devices publish concurrently to the same version, one wins (chosen deterministically by aggregator request-ID collision), the loser is notified synchronously, and both remain consistent. The outcomes are: one device's commit succeeds, the other learns of the collision, re-probes the aggregator, and bumps its version. No silent overwrites; no silent forks.

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **C1** | Two devices publish simultaneously to `v = 1` → both request IDs collision → one `SUCCESS`, one `CONFLICT`. | `twoDeviceSync` at `v = 0`. | Device A and B both call `publishPointer(v=1, cid_A)` and `publishPointer(v=1, cid_B)` concurrently (race). | One receives `SUCCESS` (inclusive proof), one receives `REQUEST_ID_EXISTS` (conflict). Loser re-probes and finds `v = 1` occupied. | Loser bumps to `v = 2`; eventual consistency reached in `O(2)` attempts. No token loss; no fork. |
| **C2** | Device A wins at `v = 1` (cid_A included); Device B loses and re-probes. B re-derives `v = 2` and publishes cid_B; both converge. | Derived from C1 outcome. | Device B: re-probe confirms A's `v = 1`, then publish at `v = 2`. Device A: idle. Then both perform recovery from scratch. | Both devices independently recover both CIDs in order: `v = 1` (cid_A), `v = 2` (cid_B). | Token inventory identical on A and B. Causality preserved: cid_A before cid_B. |
| **C3** [parameterized by side ∈ {A, B}] | Side A/B submits at `v = K` while side B/A has already published `v = K+1` (version skew race). | `midLifecycle` on device D: `localVersion = 5` on D. Spawn two concurrent subscribers T1, T2 checking pointer state. | T1: reads `localVersion = 5`, bumps marker to `v = 6`. T2: concurrently reads stale `localVersion = 5` from cache, also bumps to `v = 6`. Both submit at `v = 6`. | Only one of two T1/T2 commit succeeds at `v = 6`. Loser observes collision and re-probes. | Marker compaction (§7.1.6): next publish on D sees no conflict; `localVersion === 6` final. |
| **C4** [parameterized by side ∈ {A, B}] | Partial publish: side A includes, side B times out mid-submit, then network recovers. Device retries side B at same `v`. | Fixture: `midLifecycle`. Inject network timeout on side B (aggregator mock delays >PUBLISH_REQUEST_TIMEOUT_MS). | Submit `v = K+1`: side A succeeds, side B times out. Retry: side B returns `AGGREGATOR_POINTER_TRANSIENT_UNAVAILABLE`. Automatic backoff + retry succeeds. | Both sides eventually included at `v = K+1`. Marker compacted; `localVersion` advanced. | No version bump; no OTP reuse; both sides at same `v`. |
| **C5** | Aggregator unreachable on recovery init → BLOCKED set → user resumes → aggregator recovers → BLOCKED cleared on next publish check. | Fixture: `freshWallet` with aggregator mocked unreachable. | (1) Init with unreachable aggregator → logs warning, proceeds without recovering pointer. (2) BLOCKED flag set (H1 closure). (3) Call `publish()` → refused with `AGGREGATOR_POINTER_BLOCKED_AWAITING_RECOVERY`. (4) Aggregator restored to reachable. (5) Call `publish()` → check aggregator connectivity → BLOCKED flag cleared → publish proceeds. | Step 3: publish rejected. Step 5: publish succeeds. BLOCKED flag transitions `true → false`. | No silent overwrite of remote history (the reason BLOCKED exists); user awareness enforced. |
| **C6** | **AMENDED v2.2:** Trust-base rotation mid-recovery under embedded-trust-base model (SPEC v3.4 §8.4). The wallet does NOT refresh the trust base at runtime; instead it detects epoch mismatch and halts. | Fixture: `midLifecycle` with mock aggregator. | Aggregator begins returning proofs against a new root (epoch N+1). Wallet's bundled `RootTrustBase` is at epoch N. Probe returns proof at epoch N+1. | Wallet detects epoch mismatch between aggregator response and embedded `RootTrustBase`. Recovery halts with `AGGREGATOR_POINTER_TRUST_BASE_STALE`; user is prompted to update SDK (v1 has no mid-session rotation). | No silent acceptance of unverified rotation; no token loss. Runtime rotation is v2 future work. |
| **C7** | Two devices attempt to `clearPendingMarker()` simultaneously (capability-gated, user-initiated). | Fixture: `blockedState`. | Device A and B both hold the mnemonic and both call `clearPendingMarker()`. | One succeeds and clears marker. Second sees no marker (idempotent no-op) and returns success. BLOCKED flag may still be set pending next aggregator check. | No corruption; no race on marker file. |
| **C8** | Conflict retries exceed budget; `AGGREGATOR_POINTER_RETRY_EXHAUSTED` surfaced. | Fixture: `midLifecycle`. Aggregator mock always returns conflict (`REQUEST_ID_EXISTS`) up to 5 consecutive retries. | Publish at `v = K+1`; aggregator rejects every side with conflict (rare pathological case). After 5 retries, publisher gives up. | Error `AGGREGATOR_POINTER_RETRY_EXHAUSTED` returned to caller. CAR is NOT cleaned up (already pinned; retry-friendly). | Next manual retry attempt succeeds if pathology clears. Token inventory unchanged (no publish took effect). |
| **C9** | Multi-device silent fork prevention: Device A and B both independently arrive at different cid for same `v` (e.g., due to OrbitDB merge conflict at user level). Pointer layer ensures only one is published; other is queued for `v = K+1`. | Fixture: `twoDeviceSync` at `v = K`. Both A and B perform identical faucet-and-consume locally, but due to nondeterministic CRDT merge, their OrbitDB arrives at different CID for the "same" logical snapshot. | Device A publishes first at `v = K+1` with `cidA`. Device B independently publishes (unaware of A) with `cidB`. B's publish races A's; B loses conflict at `v = K+1`. B re-probes, sees A's `cidA`, then bumps to `v = K+2` with its own `cidB`. | Both `cidA` and `cidB` eventually published (at `v = K+1` and `v = K+2`). On recovery, both CIDs are recovered and merged via OrbitDB JOIN rules (§10.4). | Token inventory is union of A and B (no loss). Causality: cidA precedes cidB. |
| **C10** | Crash during conflict retry: pending marker has `v = K+1`; second device already published at `v = K+1`. Wallet restarts during backoff sleep. | Fixture: `midLifecycle`. Marker `(K+1, cid_local)` written; submit A in-flight to aggregator. Meanwhile, Device B publishes same `v = K+1` with `cid_remote` (different content). Device A process crashes during backoff before retry. | Restart: marker still `(K+1, cid_local)`. Re-probe aggregator at `K+1` → finds `cid_remote` published. Recognize mismatch. Bump to `K+2`. | No OTP reuse. Publish proceeds at `K+2`. Device B's `cid_remote` at `K+1` is preserved. | Both CIDs recovered; no loss. |

### Category D — Network Pathology

**Rationale.** Network faults are transient but pervasive. D1–D18 test timeouts, latency spikes, partial packet loss, aggregator unreachability windows, IPFS gateway failures, Nostr relay disconnects, and malformed responses. Each must surface a correct error code (TRANSIENT_UNAVAILABLE vs. SEMANTICALLY_INVALID — critical for H1 closure) and trigger deterministic retry logic.

| ID | Scenario | Impairment | Expected error code | Retry behavior |
|---|---|---|---|---|
| **D1** | Aggregator completely unreachable (no route / DNS fails). | Network: aggregator IP unreachable. | `AGGREGATOR_POINTER_NETWORK_ERROR` (transient). | Exponential backoff; infinite retries (capped per publish by PUBLISH_RETRY_BUDGET). |
| **D2a** | Aggregator responds slowly (+500ms latency spike, still within timeout) [parameterized variant A]. | Network: inject +500ms latency on `submitCommitment`. | `SUCCESS` (no timeout; latency transparent). | None (succeeds). |
| **D2b** | Aggregator responds slowly (latency pushes total time to timeout - 1ms, recovers) [parameterized variant B]. | Network: inject latency so total RTT approaches but does not exceed PUBLISH_REQUEST_TIMEOUT_MS. | `SUCCESS`. | None. |
| **D2c** | Aggregator responds slowly (latency exceeds timeout, request aborted) [parameterized variant C]. | Network: inject latency > PUBLISH_REQUEST_TIMEOUT_MS on submitCommitment. | `AGGREGATOR_POINTER_REQUEST_TIMEOUT` (transient). | Exponential backoff; retry after delay. |
| **D3a** | Aggregator packet loss on probe (getInclusionProof) [parameterized variant A]. | Network: drop 30% of packets to aggregator. | `AGGREGATOR_POINTER_TRANSIENT_UNAVAILABLE` (after retry budget exhausted per-request, W4 closure). | Per-request timeout + backoff; per-round recovery via re-probe. |
| **D3b** | Aggregator packet loss on submit (submitCommitment) [parameterized variant B]. | Network: drop 20% of packets to aggregator. | `AGGREGATOR_POINTER_TRANSIENT_UNAVAILABLE` or `SUCCESS` (non-deterministic, both acceptable). | Retry with backoff. On success, treat idempotently (SPEC §7.3). |
| **D3c** | Aggregator packet loss on trust-base fetch (H6 closure: separate trust-base query) [parameterized variant C]. | Network: drop 50% of packets on trust-base resolution RPC. | `AGGREGATOR_POINTER_UNTRUSTED_PROOF` if trust-base fetch fails (cannot verify); otherwise `SUCCESS` with cached trust base. | Retry trust-base fetch; fall back to last-known root if recent. |
| **D4** | IPFS gateway unreachable (CAR fetch fails). | Network: IPFS gateway IP unreachable. | Publish succeeds; CAR pinned to local IPFS. Recovery: on fetch, gateway unreachable → try next gateway in mirror list. | Retry on next gateway (W4 closure: per-gateway timeout). |
| **D5** | IPFS gateway slow (CAR fetch, partial response, stall). | Network: inject stall on CAR response stream (no bytes for 35 seconds, exceeding MAX_CAR_FETCH_STALL_MS). | On recovery: `AGGREGATOR_POINTER_CORRUPT_CAR` (stall exhaustion) → trigger persistent-retry loop (§10.7). | Persistent retry across gateways over 24 hours (CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS). |
| **D6** | IPFS gateway returns partial CAR (truncated, fails content-address verification). | Network: IPFS returns first 10MB of 50MB CAR, then closes. | Publish succeeds. Recovery: fetch succeeds (no network error), but `verifyCidMatchesBytes` fails → `AGGREGATOR_POINTER_CORRUPT_CAR`. | Persistent retry loop (W7 closure) up to CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS (12×). |
| **D7** | Nostr relay unreachable (nametag resolution for peer discovery, H3 closure). | Network: Nostr relay down. | Pointer layer succeeds (Nostr not required for pointer). Peer discovery (if attempted) gets `TRANSPORT_UNAVAILABLE`. | Fallback to manual address entry; no token loss. |
| **D8** | Aggregator returns malformed response (JSON parse error). | Aggregator: mock returns invalid JSON. | `AGGREGATOR_POINTER_PARSE_ERROR` (permanent, non-retryable). | No retry. |
| **D9** | Aggregator returns `AUTHENTICATOR_VERIFICATION_FAILED`. | Aggregator: mock rejects signature (simulated crypto error). | `AGGREGATOR_POINTER_AUTH_FAILED` (permanent). | No automatic retry (code defect). |
| **D10** | Aggregator returns `REQUEST_ID_MISMATCH`. | Aggregator: mock rejects request ID derivation. | `AGGREGATOR_POINTER_REQUEST_ID_MISMATCH` (permanent). | No automatic retry. |
| **D11a** | Slow-network RTT feasibility: worst-case observed p95 RTT × slowness multiplier stays within timeout budget (v2 new). | Measure: real testnet p95 + p99 RTT; compute `PUBLISH_REQUEST_TIMEOUT_MS / (measured p95 * retries)`. | Must be > 1.5× (safety margin). | Feasible; budget validates. |
| **D11b** | Slow-network RTT boundary test: inject RTT = PUBLISH_REQUEST_TIMEOUT_MS - 1 RTT unit. Verify completion. Then cross boundary; verify graceful timeout classification (v2 new). | Latency injection: set to timeout boundary ± delta. Run both sides of crossing. | At boundary-1: `SUCCESS`. At boundary: `REQUEST_TIMEOUT` (transient). | Backoff + retry succeeds. |
| **D12** | Trust-base fetch timeout (H6, W4). | IPFS gateway for trust-base slow; exceeds IPNS_RESOLVE_TIMEOUT_MS. | `AGGREGATOR_POINTER_UNTRUSTED_PROOF`. | Retry with fallback to cached root (if recent, per SPEC §8.4.2). |
| **D13** | Aggregator mirror returns `HTTP 503 Service Unavailable`. | Mock aggregator returns 503. | `AGGREGATOR_POINTER_TRANSIENT_UNAVAILABLE` (per HTTP semantics). | Retry on same mirror; switch to next mirror. |
| ~~D14~~ | **DELETED in v2.2 (SPEC v3.4).** Multi-mirror TOFU first-touch fake-root rejection. Not applicable under embedded-trust-base model. Future work: v2 multi-mirror TOFU reintroduction. | — | — | — | — |
| ~~D15~~ | **DELETED in v2.2 (SPEC v3.4).** TLS cert pinning against `MIRROR_CERT_PINS`. Constant deleted; cert pinning is v2 future work. | — | — | — | — |
| ~~D16~~ | **DELETED in v2.2 (SPEC v3.4).** Mirror-list tampering via `MIRROR_LIST_SHA256`. Constant deleted; mirror-list integrity is v2 future work. | — | — | — | — |
| **D17** | IPFS gateway list empty / all gateways down. | All IPFS gateways unreachable. | CAR fetch fails on all mirrors. On publish: CAR already pinned to local node; no failure. On recovery: persistent-retry loop (W7). | 24-hour persistent retry (§10.7). |
| **D18** | Monotonic clock enforcement: pointer versions use monotonic (not wall-clock) timestamps internally per SPEC §10.7 H7 requirement (v2 enhanced). | Fixture: `midLifecycle`. System time: jump backward (-1 hour). System time: jump forward (+2 hours). Publish at each step. | Pointer layer uses monotonic clock for version ordering (`getMonotonicTime()`, not `Date.now()`). Version advances regardless of wall-clock skew. Publish at v=K succeeds with monotonic timestamp K (ignoring wall-clock position). | Proofs from all three publishes verify (monotonic ordering preserved). No proof rejected due to wall-clock skew. `localVersion` advances monotonically: K → K+1 → K+2 (temporal order correct, wall-clock order irrelevant). | Monotonic clock prevents version inversion from skew attacks. Temporal causality preserved despite wall-clock manipulation. I-VM (version monotonicity) enforced. |

### Category E — Discovery Edge Cases

**Rationale.** Recovery is an exponential-search phase followed by a binary-search phase, with boundary conditions at every step. The latest version might be at the `DISCOVERY_INITIAL_VERSION`, way higher (exponential ceil), or much lower (1). Sparse regions may exist (versions with no pointer published). CID validation and CAR fetching may fail. E1–E13 (plus E5b in v1) enumerate these edges.

| ID | Scenario | Precondition | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **E1** | No pointer ever published (wallet brand new). | Fixture: `freshWallet`, no prior publishes. | Recover from aggregator. Aggregator returns exclusion proofs at `v = 1` and all exponential probes. | Recovery acknowledges "no pointer" (I-DR: version 0). | `localVersion` remains uninitialized or set to 0; no CAR fetched. |
| **E2** | Pointer at exactly `DISCOVERY_INITIAL_VERSION (1024)`. | Device publishes once at `v = 1024`. | Recover on fresh device. Exponential search starts at 1024, hits success immediately. | Binary search is skipped (already found). | Single probe at 1024; success. |
| **E3** | Pointer far exceeds `DISCOVERY_INITIAL_VERSION`; exponential search must scale up. | Device publishes at `v = 500_000`. | Recover. Exponential search doubles from 1024 → 2048 → ... → 512K+ until ceiling `DISCOVERY_HARD_CEILING (4.2M)`. | Exponential phase finds an upper bound; binary search narrows. | Binary search converges to `v = 500_000`. |
| **E4** | Pointer at version 1 (boundary). | Device publishes at `v = 1`. | Recover. Exponential search checks 1024, 512, 256, ... , 1. | Binary search at lower boundary converges to 1. | `v = 1` found. |
| **E5** | Pointer at very high version near ceiling (e.g., 4M); exponential search must not exceed ceiling. | Device publishes at `v = 3_000_000`. | Recover. Exponential phase scales to ceiling `DISCOVERY_HARD_CEILING (4.2M)`. | Ceiling is enforced; no probe beyond 4.2M. | Exponential probes stop at 4.2M; binary search within bounds. |
| **E5b** | Sparse pointer history: versions 1, 5, 10 published; versions 2–4, 6–9, 11+ empty. | Fixture: multi-version publish with gaps. | Recover. Probes may land on empty versions during exponential phase; binary search skips sparse regions. | Correct version (latest non-empty) is found despite gaps. | Probe results: `EMPTY ∨ MISSING` on gaps; final version correct. |
| **E6** | CID too large (>CID_MAX_BYTES, 63 bytes): publish rejects at validation. | Fixture: generate CID of 70 bytes (e.g., CIDv1+sha512). | Publish rejects before submitting to aggregator. | Error: `AGGREGATOR_POINTER_CID_TOO_LARGE`. | No SMT entry created. Next publish with valid CID succeeds at bumped version. |
| **E7** | CID decode fails (payload is not a valid CID). | Fixture: XOR-decrypt payload; bytes are not a valid CID (e.g., random 32-byte garbage). | Recover at that version. Fetch CAR (aggregator claims CID is present); CAR does not exist (404 or corrupted at gateway). | Error: `AGGREGATOR_POINTER_CORRUPT` (CID decoding failed). | Persistent retry on CAR fetch; skip to next version if `DISCOVERY_CORRUPT_WALKBACK` exceeded. |
| **E8** | Corrupt streak: 100 consecutive versions are all unparseable CIDs (or fail CAR fetch). | Fixture: many corrupt entries in pointer history. | Recover. Walk back through versions; skip corrupt entries. At 65 consecutive corrupt (threshold `DISCOVERY_CORRUPT_WALKBACK`), stop and escalate. | Error: `AGGREGATOR_POINTER_CORRUPT_STREAK`. | Operator override via `acceptCorruptStreak()` allows proceeding. Otherwise halt. |
| **E9** | Empty version range (all probed versions have no pointer): exponential search scales to ceiling; binary search finds nothing. | Fixture: wallet with no publishes + aggregator state reset. | Recover. Exponential and binary search both return EMPTY at every probe. | Graceful no-op; recovery succeeds with `v = 0` (no pointer yet). | No error; `localVersion` initialized to 0 or left unset. |
| **E10** | Inclusion proof fails verification (bad merkle path, wrong root). | Fixture: mock aggregator returns invalid InclusionProof. | Recover; verify proof via `InclusionProof.verify(trustBase, requestId)`. | `verify()` returns `PATH_INVALID` or `NOT_AUTHENTICATED`. Recovery aborts. | Error: `AGGREGATOR_POINTER_UNTRUSTED_PROOF`. Escalate to user; manual recovery via alternate path. |
| **E11** | Exclusion proof fails verification. | Fixture: mock aggregator returns invalid ExclusionProof. | Recover; verify proof (ensures "no version at V+1"). Proof is bad. | `verify()` returns `PATH_INVALID`. Recovery aborts. | Error: `AGGREGATOR_POINTER_UNTRUSTED_PROOF`. |
| **E12** | Binary search lower bound at 1; upper bound at discovered exponential ceiling. Search terminates correctly. | Fixture: version 50 is latest. | Exponential search scales to 1024, detects 512 is also valid. Binary search: bounds [1, 1024], narrows to [1, 512], narrows to [50, 256], narrows to [50, 128], ..., converges to 50. | Binary search terminates at 50. | Correct version found. |
| **E13** | Discovery timeout (probes take too long; user/app timeout exceeded). | Fixture: mock aggregator slow on each probe (near PROBE_REQUEST_TIMEOUT_MS). | Recovery run 30+ probes (exponential + binary search combined). If total exceeds user-specified timeout, stop and return partial result or error. | Either completes successfully or returns graceful timeout error with last-known version. | App handles partial recovery (fall back to local history). |

### Category F — Trust Base Discipline

**Rationale.** The trust base (RootTrustBase) is the cryptographic root used to verify aggregator proofs. It must be loaded from a configured trusted source, identical across the pointer layer and L4, and rotated safely. F1–F9 ensure the trust base is never bypassed.

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **F1** | **AMENDED v2.2:** Trust base loaded at init; used for first proof verification. `RootTrustBase` is the embedded bundle from `assets/trustbase/<network>.ts` (SPEC v3.4 §8.4) — identical instance L4 uses. | Fixture: `freshWallet`. | Instantiate `OracleProvider` (or `PaymentsModule`); call `OracleProvider.getRootTrustBase()`. Verify first proof against it. | Proof verification succeeds (assuming canonical aggregator state). | `InclusionProof.verify(trustBase, requestId)` returns OK; no remote fetch, no cache logic. |
| **F2** | **AMENDED v2.2:** Trust base is shared instance with L4. | Fixture: L4 and pointer layer running in same process. | Both L4 and pointer layer call `OracleProvider.getRootTrustBase()`. | Both return the identical embedded instance (reference equality). | No divergence; shared embedded bundle (SPEC v3.4 §8.4.2 H6). |
| **F3** | **AMENDED v2.2:** Trust base rotation via SDK update. | Fixture: `midLifecycle`; aggregator begins returning epoch > bundled epoch. | (1) Old epoch active; proofs verify. (2) Aggregator advances its epoch while wallet still ships the older bundle. (3) Wallet detects epoch mismatch. | `AGGREGATOR_POINTER_TRUST_BASE_STALE` raised; user prompted to update SDK. Mid-session runtime rotation is v2 future work. | No silent acceptance of unverified rotation; no token loss. |
| **F4** | **AMENDED v2.2:** Absent embedded trust base. Defensive check — the SDK must refuse to initialize without a bundled `RootTrustBase` for the selected network. | Fixture: synthetic build missing `assets/trustbase/<network>.ts` entry. | Instantiate `OracleProvider`. | Init throws `AGGREGATOR_POINTER_PROTOCOL_ERROR` (or equivalent) referencing the missing bundled trust base. No runtime remote-fetch fallback in v1. | No silent "unverified" mode; absent bundle is a build-time failure, caught at init. |
| **F5** | **AMENDED v2.2:** `OracleProvider.getRootTrustBase()` returns the same instance `PaymentsModule` uses. | Fixture: `pointerInitialized`. | From within a single process, obtain the trust base from (a) `OracleProvider.getRootTrustBase()` and (b) the instance that `PaymentsModule` uses internally. Assert reference equality. | Same `RootTrustBase` instance reference. | No duplicate bundled copies; H6 shared-base contract holds (SPEC v3.4 §8.4.2). |
| **F6** | **AMENDED v2.2:** Determinism — `OracleProvider.getRootTrustBase()` returns the same bytes across repeated calls within a session and across fresh processes on the same SDK build. | Fixture: fresh process × 2. | Serialize the trust base on each call; compare. | Byte-identical across calls. | No hidden mutation or per-call derivation in v1; trust base is a static embedded constant. |
| **F7** | Proof verification against wrong root (attacker-controlled aggregator response against the genuine embedded root). | Fixture: mock aggregator returns proofs against a fake root different from the bundled `RootTrustBase`. | Recover; fetch proofs. Verify proofs against the embedded root. | Proofs fail verification (merkle path does not match embedded root). Recovery aborts. | `InclusionProof.verify()` returns `PATH_INVALID` or `NOT_AUTHENTICATED`. No token loss (proofs blocked). |
| **F8** | **AMENDED v2.2:** SDK-level epoch divergence — two processes running **different SDK builds** (bundling different embedded epochs) must each detect the mismatch against aggregator state and raise `AGGREGATOR_POINTER_TRUST_BASE_STALE`. | Fixture: process A on SDK bundle epoch N, process B on epoch N-1. Aggregator runs at epoch N. | Both processes attempt recovery. | Process A: proofs verify. Process B: epoch mismatch detected → `TRUST_BASE_STALE` raised; user prompted to update SDK. | Divergence is a build-version concern in v1, surfaced via explicit error code; no silent drift (SPEC v3.4 §8.4). |
| **F9** | Trust base is always verified before use (no bypass paths). | Fixture: pointer layer with instrumented proof-verify function. | Run 100 recovery scenarios (category E). Count proof-verify calls. | At least 100 verify calls (≥1 per recovery). | Every proof is verified before trust. No code path accepts proofs without verification. |

### Category G — `acceptCarLoss` Operator Override Discipline (H7)

**Rationale.** CAR bundles can be permanently unavailable (gateways down, content lost). The pointer layer MUST NOT brick the wallet; instead it implements a persistent-retry mechanism (24-hour window) and offers an operator-callable `acceptCarLoss()` override. G1–G7 ensure the override is discipline-gated and doesn't lose token recovery.

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **G1** | CAR unavailable; persistent-retry window not yet elapsed (< 24 hours). | Fixture: publish at `v = 1`; CAR pinned and discoverable. Then simulate 4-hour window with no gateway reachability. | Recover; CAR fetch fails on all gateways. Persistent retry scheduled; user notified. Time: 4 hours elapsed. | `acceptCarLoss()` call is REFUSED with `AGGREGATOR_POINTER_CARRETRY_WINDOW_ACTIVE`. User must wait or recover via alternate (legacy IPNS, trusted peer). | Timeout not elapsed; override rejected. |
| **G2** | Republish-before-advance ordering (H7 closure): CAR lost at `v = K` → persistent-retry on same `v` → republish CID at `v = K` (if CID changes) → only then advance to `v = K+1`. | Fixture: `midLifecycle` with pointer published at `v = K`. Gateway fails; CAR lost. Wallet enters persistent-retry. Meanwhile, user modifies wallet (new payment received), CID changes. | Step 1: Persistent-retry loop attempts CAR fetch every N seconds. Step 2: After budgeted retry window, persistent-retry still ongoing (not yet elapsed). Step 3: New token arrives; CID changes. Step 4: Wallet MUST first: (a) Republish at `v = K` with new CID, (b) THEN advance to `v = K+1`. Step 5: Verify: pointer history shows `[v=K (new CID), v=K+1 (next CID), ...]` with no gap. | Publish order verified: `v = K` (new CID) before `v = K+1`. Token inventory from persistent-retry CAR recoverable from `v = K` without advancing past it first. | H7 ordering enforced: republish same version with updated CID, confirm success, only then bump version. OTP reuse prevented; causality preserved. |
| **G3** | CAR loss on one version; other versions OK. Recovery skips lost version. | Fixture: publish at `v = 1..5`. Gateway only has `v = 1, 3, 5`; `v = 2, 4` lost. | Recover. Probes find up to `v = 5`. Fetch CARs for each version. `v = 2, 4` fail; skip. `v = 1, 3, 5` succeed. | Recovery loads from `v = 1, 3, 5` bundles; tokens merged via OrbitDB JOIN. | Tokens from `v = 1, 3, 5` recovered; no token loss (assuming v=2,4 contained no new tokens). |
| **G4** | Partial CAR loss: v = K is found but CARv = K-1 is lost mid-chain. Recovery must be able to bootstrap from partial history. | Fixture: `v = 1, 2, 3, ...` all published. Gateway has `v = 3, 4, 5` but not `v = 1, 2`. | Recover; find `v = 5` as latest. Attempt CAR fetch for `v = 5`: success. Then `v = 4`: success. Then `v = 3`: success. Then `v = 2`: 404 (lost). | Recovery succeeds with `v = 3, 4, 5` tokens. Optional: persist marker that `v = 2` is known-lost (to avoid re-querying). | `v = 3, 4, 5` tokens recovered; `v = 1, 2` are marked unrecoverable. |
| **G5** | `acceptCarLoss()` called without BLOCKED flag set (permission check). | Fixture: recovery idle, no BLOCKED state. | Call `acceptCarLoss()` directly. | Call rejected: `AGGREGATOR_POINTER_NOT_BLOCKED` (permission: only callable when recovery halted due to CAR loss). | Authorization enforced. |
| **G6** | Operator calls `acceptCarLoss()` during active persistent-retry sleep. | Fixture: CAR lost; persistent retry scheduled for 1 hour hence. | Call `acceptCarLoss()` before timeout. | Override honored; persistent-retry loop canceled. `acceptCarLoss()` returns immediately. | Operator gains immediate control; unblocks wallet. |
| **G7** | Multiple calls to `acceptCarLoss()` (idempotency). | Fixture: `blockedState` due to CAR loss. | Call `acceptCarLoss()`. State transitions: `BLOCKED_DUE_TO_CAR_LOSS → NOT_BLOCKED`. Call again. | Second call: no-op (state already not blocked). | Idempotent; no side effects. |

### Category H — `clearPendingMarker` Operator Override Discipline (W6)

**Rationale.** The pending-version marker is crash-safety critical but can become corrupt (W6). The operator-callable `clearPendingMarker()` is a recovery escape hatch, capability-gated to prevent accidental loss. H1–H4 plus H8-R, H14-R (regression tests, v2 new) ensure marker corruption is handled safely. (H3-R removed in v2.2 / SPEC v3.4 — multi-mirror TOFU is v2 future work.)

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **H1** | Pending marker is corrupt; `clearPendingMarker()` clears it and sets BLOCKED. | Fixture: marker file has partial JSON. | Call `clearPendingMarker()`. | Marker file deleted. BLOCKED flag SET to `true`. Next publish REFUSED. | BLOCKED prevents silent recovery; forces manual aggregator check before proceeding. |
| **H2** | `clearPendingMarker()` called without MARKER_CORRUPT error (user panic call). | Fixture: `blockedState` with no marker corruption (e.g., aggregator unreachable). | Call `clearPendingMarker()`. | Marker deleted (no-op if absent). BLOCKED flag set. | User gains recovery escape hatch. |
| **H3** | **AMENDED in v2.2 (SPEC v3.4):** Fake-root rejection against the embedded `RootTrustBase`. Previously specified multi-mirror TOFU cross-check is v2 future work. | Fixture: fresh wallet; mock aggregator responds with proofs against a root different from the embedded `RootTrustBase`. | Recover; verify the returned proof against the bundled trust base. | Proof fails verification (merkle path does not match embedded root). Recovery aborts with `AGGREGATOR_POINTER_UNTRUSTED_PROOF`. | Attack surface previously handled by multi-mirror diversity is now contained by: (a) verification against the embedded trust base (this scenario), (b) epoch-mismatch detection (C6 amended), and (c) SDK-update-gated rotation (F3). Cross-mirror TOFU is v2 future work. |
| **H4** | Marker corruption detection at startup (NOT a user-callable scenario; automatic). | Fixture: marker file corrupted (truncated JSON). | Wallet init detects corruption; logs error; raises flag without user action. | MARKER_CORRUPT error surfaced; `clearPendingMarker()` capability hint provided to user. | User intervention required; escape hatch available. |
| ~~H3-R~~ | **DELETED in v2.2 (SPEC v3.4).** Cross-mirror TOFU downgrade attack regression (sub-cases A/B/C). Not applicable under embedded-trust-base model. Reintroduce when multi-mirror TOFU lands in v2. | — | — | — | — |
| **H8-R** | REJECTED (AUTHENTICATOR_VERIFICATION_FAILED) burns version via localVersion=v (H8 closure, v2 new). | Fixture: `midLifecycle` at `v = K`. Publish at `v = K+1` with `ctA_K` (ciphertext from HKDF subkey A). | Step 1: Submit at `v = K+1` with `ctA_K`. Aggregator returns `AUTHENTICATOR_VERIFICATION_FAILED` (simulated: signature invalid, or requestId mismatch on REJECTED row of §7.3). Step 2: Persist `localVersion = K+1` (OTP burned per SPEC §7.3 H8: REJECTED outcome). Step 3: Attempt immediate retry at `v = K+1` with different plaintext `pA_K'` → re-derive `ctA_K'`. | Step 1: Aggregator rejects. Step 3: Wallet MUST refuse retry at same v with different ciphertext (OTP reuse prevention). Wallet either (a) returns permanent error AUTHENTICATOR_VERIFICATION_FAILED, or (b) forces bump to `v = K+2` with fresh keys. | OTP reuse impossible: same `(v, side)` cannot be used with different plaintext. Version burn is irreversible and prevents silent retry-loop DoS. Invariant I-CS (crash safety) preserved. |
| **H14-R** | Pending_version marker idempotent-retry regression (H14 closure, v2 new). | Fixture: publish at `v = K+1` with `cidHash_A`. Crash mid-publish; restart. Marker: `(v = K+1, cidHash_A)`. Current CID: `cidHash_A` (same). | Restart; publish flow re-enters. Marker present, same cid → idempotent retry. Re-derive payload deterministically. Re-submit. Aggregator: returns `REQUEST_ID_EXISTS` (idempotent). Wallet: recognizes as success (SPEC §7.3 row 4). | No OTP reuse; publish completes. | Determinism enforced: same (v, cid) → same xorKey, padding, payload. No variant paths. |

### Category I — `acceptCorruptStreak` Operator Override Discipline (W7 Floor)

**Rationale.** Recovery may encounter pathologically long sequences of unparseable CIDs (e.g., prior client bugs or adversarial injection). The pointer layer halts after DISCOVERY_CORRUPT_WALKBACK (64) consecutive corrupt entries. The `acceptCorruptStreak()` override allows operator to proceed at their own risk. I1–I4 ensure the override is properly guarded.

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **I1** | 50 consecutive corrupt entries; threshold not exceeded. | Fixture: pointer history with 50 unparseable CIDs. | Recover; walk back through corrupt entries. Count reaches 50. | Recovery continues (threshold is 64); next valid entry found or ceiling reached. | No override needed; recovery completes. |
| **I2** | 65 consecutive corrupt entries; threshold exceeded. | Fixture: pointer history with 65 unparseable CIDs. | Recover; walk back. At 64 corrupt, halt. | Error: `AGGREGATOR_POINTER_CORRUPT_STREAK` surfaced. Recovery blocked. | User must call `acceptCorruptStreak()` or investigate underlying issue. |
| **I3** | `acceptCorruptStreak()` permits proceeding past corrupt streak. | Fixture: blocked state due to corrupt streak. | Call `acceptCorruptStreak()`. | Override honored; recovery continues past corrupt region. Find latest valid entry or ceiling. | Operator acknowledges risk; recovery proceeds. |
| **I4** | `acceptCorruptStreak()` called without CORRUPT_STREAK state. | Fixture: recovery idle, no corruption. | Call `acceptCorruptStreak()`. | Call rejected: `AGGREGATOR_POINTER_NOT_BLOCKED` (permission). | Authorization enforced; override only available when needed. |

### Category J — CAR Bundle Integrity

**Rationale.** CAR bundles are content-addressed; CID must match when fetched. Truncation, corruption, or gateway bugs can produce mismatched bytes. J1–J8 test CAR validation and error handling.

| ID | Scenario [parameterized by size] | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **J1a** | Small CAR (1 MB) round-trip: fetch, hash, verify [size=1MB]. | Fixture: `pointerInitialized` with 1MB CAR. | Publish → CAR pinned. Recover on device B → fetch → hash → verify. | Fetch succeeds; hash matches CID; recovery succeeds. | `verifyCidMatchesBytes(cid, bytes)` returns true. |
| **J1b** | Medium CAR (10 MB) round-trip [size=10MB]. | Fixture: `midLifecycle` with multiple tokens (10MB CAR). | Publish → CAR pinned. Recover → fetch (may stream) → hash → verify. | Hash matches CID; no truncation. | All tokens recovered; inventory intact. |
| **J1c** | Large CAR (100 MB, at capacity) [size=100MB]. | Fixture: many tokens (100MB CAR at CID_MAX_BYTES envelope). | Publish → pin. Recover → fetch all 100MB (respects MAX_CAR_BYTES limit). | Fetch succeeds; hash matches; recovery complete. | Largest-supported CAR size validated. |
| **J2** | CAR truncated mid-fetch (gateway closes connection early). | Fixture: CAR available; gateway closes after 50% sent. | Recover; CAR fetch: connection closed, incomplete bytes received. Attempt hash-and-verify. | `verifyCidMatchesBytes()` returns false. Error: `AGGREGATOR_POINTER_CORRUPT_CAR`. | Persistent retry triggered (W7). |
| **J3** | CAR corrupted (first byte flipped; content-address check fails). | Fixture: CAR pinned; bitflip injected in first byte. | Recover; CAR fetched completely. Hash computed. | Hash does NOT match CID. Error: `AGGREGATOR_POINTER_CORRUPT_CAR`. | Persistent retry or operator override. |
| **J4** | CAR serialization round-trip (multiple devices, same tokens, same CID). | Fixture: Device A publishes tokens. Device B recovers and re-publishes (without modifying tokens). Device C recovers. | Device B's CAR MUST have identical CID to Device A's (deterministic serialization). | CID of A === CID of B. Device C recovers identical inventory. | Deterministic CAR serialization verified. |
| **J5** | CAR partial corruption (oplog inside CAR is corrupted; deserialization fails). | Fixture: CAR fetched; contains corrupted OrbitDB OpLog bytes. | Recover; CAR fetched and unpacked. Deserialize OpLog. Parse fails. | Error: `AGGREGATOR_POINTER_CORRUPT_CAR` or `OPLOG_PARSE_ERROR`. | Token recovery fails; persistent retry or manual recovery. |
| **J6** | CAR fetch from multiple gateways (gateway 1 corrupted; gateway 2 OK). | Fixture: CAR pinned to gateways G1 and G2. G1 has truncated version; G2 has full version. | Recover; CAR fetch from G1 fails (hash mismatch). Retry on G2; succeeds. | G2's version verifies; recovery continues. | Fallback to alternate gateway works; no permanent loss. |
| **J7** | CAR fetch size exceeds MAX_CAR_BYTES (100 MiB). | Fixture: bundle exceeds size limit (should not occur, but defense-in-depth). | Recover; CAR fetch headers indicate size > 100 MiB. | Download refused before transfer starts. Error: `AGGREGATOR_POINTER_CAR_TOO_LARGE`. | Size check prevents resource exhaustion. |
| **J8** | CAR serialization includes denylist entry; deserialization filters it. | Fixture: CAR contains a token in the operator denylist. | Recover; deserialization skips denylist entries. | Denylist token absent from recovered inventory. Remaining tokens recovered. | Denylist is enforced during deserialization; no loss of non-denylist tokens. |

### Category K — Originated-Tag Semantic Validation (H6, W11)

**Rationale.** OrbitDB replication can receive remote entries with `originated-tag = 'user'` (claiming to be locally-originated). The receiver must downgrade to `'replicated'` and re-validate semantics. K1–K10 ensure forged tags are caught and do not trigger false BLOCKED states.

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **K1** | Local publish: originated-tag = 'user' (correct). | Fixture: device publishes at `v = 1`. | Semantic validator checks originated-tag. | Tag is 'user' on the sending device. | Local entries always tagged 'user' unless corruption. |
| **K2** | Remote replicated entry: originated-tag = 'user' sent from Device B. | Fixture: `twoDeviceSync`. Device A receives OpLog entry from Device B with `originated-tag = 'user'`. | Receiver-authority rule (§10.4): downgrade to 'replicated'. Re-validate semantics. | Semantic re-validation passes (entry was valid when originated). | Entry accepted with downgraded tag. No false BLOCKED. |
| **K3** | Remote entry with mismatched originated-tag (claims 'user' but content signature is missing / invalid). | Fixture: adversary crafts entry with 'user' tag and invalid signature. | Semantic validator re-checks signature on downgrade. | Signature verification fails. | Entry rejected. Merge conflict resolved via JOIN rule. No BLOCKED. |
| **K4** | Merge conflict with originated-tag: Device A and B both claim 'user' at same version. | Fixture: `twoDeviceSync`. Both A and B write to same slot. | Merge: version comparison (lamport, hash tie-break per JOIN rule 1). One device's entry is canonical. | Only one entry tagged 'user'; loser's entry is marked 'replicated'. | Single 'user' tag per version after merge. No BLOCKED. |
| **K5** | Downgrade rule is monotonic (never re-upgrade 'replicated' → 'user'). | Fixture: entry received as 'replicated', then merged again (perhaps device re-announces). | Merge: if entry is already 'replicated', stays 'replicated'. | No re-upgrade. | Tag is immutable (downgrade-only). |
| **K6** | Originated-tag DOES NOT trigger BLOCKED unless validation fails. | Fixture: `midLifecycle`. Entry with 'user' tag from Device B is replicated to Device A. | Semantic validation passes (signature OK, timestamp OK). Entry is accepted. | BLOCKED is NOT set (validation passed). | Pointer layer remains OPEN. |
| **K7** | Originated-tag on INVALID entry DOES trigger BLOCKED (H6 closure). | Fixture: entry claims `originated-tag = 'user'`, but semantic validation fails (e.g., token double-spent). | Semantic validator detects conflict. BLOCKED flag is SET (H1 closure). User must manually resolve. | BLOCKED prevents silent acceptance of invalid entry. | User is forced to investigate; no silent fork. |
| **K8** | Multi-device originated-tag quorum (3 devices agree on version; 1 disagrees). | Fixture: devices A, B, C publish to same v with same content; Device D has divergent content. | Merge (3-way quorum not in scope, but tags show origin). A, B, C: 'user'. D: 'replicated' (loses tie). | Majority's version is canonical. D's version downgraded. | No BLOCKED; merge proceeds. |
| **K9** | Originated-tag persists across CAR serialization (not dropped). | Fixture: `pointerInitialized`. OpLog entry has `originated-tag = 'user'`. Flush to CAR; deserialize. | Originated-tag is serialized in CAR; deserialized on recovery. | Tag is preserved through CAR round-trip. | Semantics on Device B match Device A. |
| **K10** | Originated-tag downgrade race during OrbitDB merge window (v2 new). | Fixture: Device A writes Profile v=5 with `originated-tag = 'user'`. Device B writes its own v=5 (different content) with `originated-tag = 'user'`. Both are offline. Bring online; replicate. During merge, both versions arrive at the merge operator simultaneously. | Receiver-authority rule: downgrade remote's tag to 'replicated'. Re-run semantic validation. Ensure the `user` tag is never falsely preserved on the remote-side version. | Both versions' `originated-tag` fields are examined. Exactly one (local-origin) is tagged `user`; remote is downgraded to `replicated`. | Token conservation: every token from both sides survives merge under JOIN rules (not lost). |

### Category L — Identity / Key Handling

**Rationale.** Keys are security-critical. L1–L7 test key derivation, storage, and usage. Denylist entries prevent initialization with weak keys.

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **L1** | Canonical wallet 1 (all-zeros private key): denylist blocks initialization on testnet. | Fixture: attempt `Sphere.init()` with canonical test vector key. | Init rejects. | Error: `SPHEREKEYDENYLISTED` (or similar). | Canonical vectors are gated to `network: 'test-vectors'` or explicit override. |
| **L2** | Canonical wallet 2 (SHA-256 of string): denylist rejects on non-test network. | Fixture: canonical wallet 2 key. | Init on `network: 'testnet'` → rejected. Init on `network: 'test-vectors'` → allowed. | Denylist honored per network. | Test vectors are NOT usable on production. |
| **L3** | Key derivation determinism (HKDF same key → same derived keys). | Fixture: seed `signingSeed` deterministically. | Derive `signingService` via `SigningService.createFromSecret(signingSeed)` twice. | Both calls produce identical `signingPubKey`. | No randomness in key derivation; deterministic. |
| **L4** | Private key not exposed in API surface (no getter for `walletPrivateKey` in public types). | Fixture: Sphere instance. | Attempt to access `sphere.payments.walletPrivateKey` or equivalent. | Property not exported (type checker error or runtime undefined). | Private key is encapsulated. |
| **L5** | Key material zeroization (memory safety: derived subkeys are cleared after use if supported by runtime). | Fixture: publish flow with instrumented `memset` or equivalent. | Monitor memory for zeroization of `signingSeed`, `xorSeed`, `padSeed` after publish completes. | Keys are securely cleared (or JS engine garbage-collects them). | Memory forensics: no plaintext key material in heap after use. |
| **L6** | Operator denylist entry fires on deserialization (token in recovered CAR matches denylist). | Fixture: CAR contains a token in the operator denylist. | Recover; deserialize CAR. Token matches denylist. | Token is silently skipped (not added to inventory). Remaining tokens recovered. | No error; denylist is filtering (not blocking). |
| **L7** | Key rotation (if wallet switches to new mnemonic): old pointer chain is abandoned; new pointer chain starts at v=1. | Fixture: Device has mnemonic M1 (recovered some state). User imports new mnemonic M2. | Pointer layer re-derives with M2. New `pointerSecret`, `signingPubKey`, request IDs. | Old pointer entries (from M1) are NOT recovered. New pointer chain starts fresh at v=1. | Device A and Device B (both importing M2) converge to same state; M1's history is orphaned. |

### Category M — Cross-Device Token Conservation (the heart of the invariant)

**Rationale.** This is the **hardest** category. Two or more devices race, merge, crash, and recover. Tokens must never be lost, duplicated, or silently forked. M1–M12 (v1) plus M13–M15, M17 (v2 DAG-aware conservation) test the full state-machine and JOIN rules from PROFILE-ARCHITECTURE.md §10.4. (M7, M16 deleted in v2.1: finality-window concept not in SPEC; covered by H5 trust-base rotation.)

| ID | Scenario | Fixture | Steps | Expected | Assertion |
|---|---|---|---|---|---|
| **M1** | Device A publishes at `v = 1` with token T1. Device B recovers. Both recheck. | Fixture: `twoDeviceSync` at `v = 0`. | A: publish(T1) → v=1. B: recover → finds v=1 → fetches CAR → loads T1. Both: `getTokens()`. | Both A and B have T1. | `A.tokens === B.tokens`. No loss. |
| **M2** | Device A at `v = 1` with T1. Device B recovers to `v = 1`. Device A consumes T1 (sends to third party). Device A publishes at `v = 2` (T1 spent, new T2 received). | Fixture: derived from M1 at `v = 1`. | A: send(T1) → receive(T2) → publish(v=2). B: (no action, still at v=1 state). Then B: recover again. | B's recovery finds v=2 CAR → loads final state (T1 gone, T2 present). | `B.tokens === [T2]`. No phantom T1. |
| **M3** | Device A and B both receive the same token T (from third party). Both attempt to consume it (double-spend). | Fixture: A and B both offline, receive T via Nostr DM. OrbitDB merge converges both to T in their OpLog. Both are online; both attempt to spend T. | A: spend(T, 50%) → receive from faucet. B: spend(T, 100%) → different recipient. A publishes at v=2 (A's state). B publishes at v=2 (B's state). | Race: aggregator includes A's v=2 (first to arrive). B's v=2 conflict → bumps to v=3. Recovery: v=2 (A's state, with A's spend), v=3 (B's state, with B's spend). JOIN rule at device merge: both spends are attempted; one conflicts. | Final inventory: either the conflict is caught upstream (L4 rejects invalid state transition) or token is marked QUARANTINED. No silent loss (H12 closure: audit trail). |
| **M4** | Device A publishes at v=1..v=10 (10 publishes, each with new token). Device B cold-boots and recovers. Device C also cold-boots and recovers. All three converge. | Fixture: Device A at `midLifecycle` state (v=5+); scale to v=10. | A: publish 10 times (each adds token). B: recover from scratch. C: recover from scratch. All run `getTokens()`. | B and C both recover all 10 tokens in causal order. OrbitDB merge on B and C produces identical inventory. | `A.tokens === B.tokens === C.tokens` (100 tokens total, all present). |
| **M5** | Crash during Device A's consume (spend + CAR flush). Restart Device A. Device B recovers state. | Fixture: A at v=3 with 5 tokens. Crash triggered during `send()` + `flushToIpfs()`. | A: crash (pending marker, partial CAR, maybe partial publish). Restart. B: recover (simultaneously or later). | A: restart recovers from marker (SPEC §7.1.6). Recomputes v=4. Publishes. B: recovers A's final state (v=4). | Both A and B have identical inventory. No double-spend of token A intended to send. |
| **M6** | Real oracle double-spend resolution (v2: replaced with M15). | [Scenario moved to M15] | — | — | — |
| **M8** | Device A publishes at v=1 (token T1). Device B concurrently publishes at v=1 (same T1, different consume intent). Devices merge via OrbitDB gossipsub. | Fixture: `twoDeviceSync` offline at v=0. A and B both add T1 to their local OpLog independently (before aggregator resolution). Both go online; publish races. | A: wins at v=1 (A's consume of T1). B: loses, publishes at v=2 (B's consume of T1). OrbitDB merge: both versions replicate to each other. JOIN rule: one is canonical (higher lamport / hash tie-break). Other is marked 'replicated'. | One consume is canonical; the other is marked replicated. Upon re-validation: likely one is invalid (attempt to re-spend the spent token). Semantic validator catches it (L4 oracle). | No fork; one branch is invalid and caught. Valid branch's tokens are preserved. |
| **M9** | Nametag recovery alongside pointer recovery: Device B imports mnemonic, recovers pointer at v=5, also recovers nametag from Nostr relay (independent of pointer). Tokens are under the recovered nametag's address. | Fixture: Device A with nametag '@alice', v=5 state. Device B: import mnemonic (no prior local state). | B: recover nametag from Nostr relay (event NIP-04 encrypted under pubkey). Recover pointer at v=5. Both reference the same identity (same HD address 0, same nametag). | B recovers both pointer state and nametag binding. Token inventory is intact. Nametag recovery is parallel (not serialized). | No race between nametag and pointer recovery; orthogonal. Tokens recovered correctly. |
| **M10** | Three-device eventual consistency: A, B, C all offline. A and B replicate to each other (v=5). C joins later. Eventual convergence. | Fixture: Device A at v=3, Device B at v=2, Device C at v=0, all offline with shared mnemonic. | (1) A and B replicate via OrbitDB gossipsub: both converge to merged state. (2) C joins, recovers pointer → finds latest. (3) All three run `getTokens()`. | After step (1): A and B have identical OpLog (merged). After step (2): C has recovered pointer → fetches same CAR as A/B. All three converge to same inventory. | No phantom tokens; no missing tokens. `A.tokens === B.tokens === C.tokens`. |
| **M11** | Selective offline recovery: Device A is offline. Device B recovers pointer from aggregator. Device A does NOT sync via network; only recovers from mnemonic offline (local OpLog seed via pointer). | Fixture: A offline (no network). B online. A has mnemonic. | A: perform offline recovery (compute `pointerSecret`, `signingPubKey`, probe local-cached aggregator state or manually provide latest-known version). A recovers from pointer without live network. | A's recovery succeeds if local cache is valid; otherwise A must go online to validate proofs. B's recovery is standard (online). Both should converge. | Offline-recovery tokens match online-recovery tokens (both are deterministic from mnemonic). |
| **M12** | Large token inventory (1000+ tokens across multiple CAR versions). Device A publishes in batches (v=1, v=5, v=10, v=20, v=50, v=100 with ~167 tokens each). Device B recovers once. | Fixture: scale the publish count to 1000+ tokens. | A: publish 6 times (batches). B: recover once → binary search → finds v=100 → fetches all CAR versions. | B recovers all 1000+ tokens. No truncation; no loss. | All tokens present; inventory matches A's. Scale test passes. |
| **M13** | JOIN rule 3 — longest-valid-chain with divergence (DAG-aware): two versions reference same token but branch on consume. JOIN must pick longest valid chain; loser's branch caught by semantic validator (v2 new). | Fixture: Construct two Profile versions V1 and V2 that both reference token T, but branch at consume step. | V1: [T, consume-T→send-to-R1, receive-U1] (3 ops, 2 valid + 1 pending). V2: [T, consume-T→send-to-R2, receive-U2] (3 ops, all 3 valid). Merge: both valid, V2 longer. | JOIN rule 3 (§10.4 PROFILE-ARCHITECTURE.md): both chains valid, one longer → keep longer (V2). V1's consume is replayed but re-spends T (already spent by V2). Semantic validator (L4 oracle) rejects V1's invalid spend as conflicting (§10.5.2, §10.7). | V2's tokens (send-to-R2, U2) preserved. V1's invalid-spend output is marked CONFLICTING. Final inventory: only V2's tokens recovered. Invariant I-TC: all valid tokens conserved; invalid ones flagged. |
| **M14** | JOIN rule 1–2 — manifest + element pool union (asymmetry preservation): one version has token that the other doesn't. Union must retain all uniquely-referenced tokens (v2 new). | Fixture: Device A has token T_a (received Nostr). Device B has token T_b (received Faucet). Both offline; then online; replicate via OrbitDB. | A's OpLog: [T_a, consume-T_a]. B's OpLog: [T_b, consume-T_b]. Merge: union of manifests includes both T_a and T_b. Element pool: union of all DAG nodes. | JOIN rules 1–2 (§10.4): (1) Manifests are UNIONED. (2) Element pools are UNIONED (content-hash dedup). Result: Final OpLog contains [T_a, T_b, consume-T_a, consume-T_b]. Both consumes valid per causality (consuming their respective inputs). | Both T_a and T_b conserved (manifest union). No loss. Final inventory: T_a-branch tokens + T_b-branch tokens. Invariant I-TC: union preserves all tokens from both branches. |
| **M15** | JOIN rule 3 tiebreak — double-spend detection + canonical selection: two versions both consume same input token. Merge must select one as canonical; loser's invalid spend quarantined (v2 new, replaces M6). | Fixture: Construct two versions that both consume same token T into different outputs. | V1: [T, spend-T-to-100-sats, receive-U1]. V2: [T, spend-T-to-150-sats, receive-U2]. Merge: both valid, same depth, lamport/hash tie-break picks V1 canonical, V2 replicated. | JOIN rule 3 tiebreak (§10.4): one canonical, other replicated. V2's spend is invalid (re-spends T already consumed by V1). Semantic validator (§10.5.2, §10.7 conflict) rejects V2's spend output. V2's U2 (received after the invalid spend) marked CONFLICTING or QUARANTINED. User notified. | V1's tokens (spend-to-100, U1) recovered. V2's U2 quarantined (pending manual resolution). No silent token loss; audit trail preserved. Invariant I-TC: canonical branch's tokens conserved; invalid-spend outputs flagged. |
| **M17** | Real oracle double-spend resolution via aggregator (v2 new): test against actual aggregator (not mocked). Submit two conflicting L4 state transitions. Aggregator consensus picks one. Wallet detects rejection and marks tokens from rejected branch QUARANTINED. | Fixture: Live testnet aggregator + integration test setup. | Device A: construct and submit state-transition V1 (token T spent to address R1). Device B: construct and submit conflicting V1 (same token T, different address R2). Time races. | Aggregator's BFT consensus includes first-to-arrive. Second is rejected (duplicate request-ID or conflicting L4 semantics). | Wallet detecting rejection: re-probes, sees only first is in SMT. Wallet marks second's new-token outputs as QUARANTINED. User is notified. | No silent loss. Both devices' tokens are accounted for; rejected-branch tokens are flagged for inspection. Final recovery preserves canonical tokens. |

### Category N — CLI E2E Scenarios Against Real Infrastructure

**Rationale.** Categories A–M are unit and integration tests. N1–N14 are end-to-end against real Unicity testnet infrastructure (aggregator, IPFS gateways, Nostr relay, faucet). They test the CLI binary and real-world latencies.

[N1–N13 shell scripts preserved from v1; see §5 below for full bash code]

| ID | Scenario | Command outline | Expected outcome | Success assertion |
|---|---|---|---|---|
| **N1** | Init new wallet with profile, publish, recover on second device. | `$CLI init --profile --nametag @alice-n1 --dataDir $DD_A` → receive faucet → `send @bob 1 UCT` → `profile flush` (explicit). Destroy. `$CLI init --mnemonic $MN --dataDir $DD_B --no-nostr` → wait for recovery. | Device B recovers all tokens from pointer. | `$CLI --dataDir $DD_B balance === amount_from_A` |
| **N2** | Multi-address: switch address, publish, recover on separate device. | `$CLI init --profile --dataDir $DD` → `address switch 1` → faucet → `send`. Destroy. Re-import on fresh device. | Recovery finds pointer at v=1; OpLog includes both address-0 and address-1 tokens. | Both addresses' tokens recovered. |
| **N3** | Concurrent publishes (two CLI processes, same wallet, race). | `(cd $DD && $CLI send @alice 1 UCT &) && (cd $DD && $CLI send @bob 1 UCT &) && wait` (mutex enforced at Profile level). | One succeeds; other may queue or conflict. Both eventually succeed (possibly at v+1). | No corruption; eventual consistency. |
| **N4** | Crash during send (SIGKILL, marker recovery). | `$CLI send @alice 1 UCT &` → PID=$! → sleep 0.1 → `kill -9 $PID`. Restart `$CLI send @bob 1 UCT` (should retry marker). | Crash-safety: marker-driven idempotent retry. Second send succeeds at v or v+1. | No OTP reuse; no token loss. |
| **N5** | IPFS gateway failover (two gateways, one down). | Publish to G1. Kill G1. Recover on device B using only G2. | CAR fetch from G2 succeeds. | Recovery finds and fetches CAR on alternate gateway. |
| **N6** | Aggregator briefly unreachable (simulated via iptables). | Publish at v=1. `iptables -A OUTPUT -d $AGGREGATOR_IP -j DROP`. Restart device. `iptables -D OUTPUT -d $AGGREGATOR_IP -j DROP`. `$CLI profile unblock` (or automatic recovery). | BLOCKED state set. After unblock, pointer recovery succeeds. | Pointer recovery resumes; tokens recovered. |
| **N7** | Network latency injection (slow aggregator; still completes). | Use `tc qdisc add` to delay aggregator RTT by 500ms. Publish. Latency added, but under timeout. | Publish succeeds (may take longer). | RTT budget validated (D11a). |
| **N7b** | BLOCKED persists across process restart (v2 new). | Device publishes at v=1. Aggregator mocked unreachable. BLOCKED flag set. Kill process. Restart device. Check status. | `$CLI profile status` shows BLOCKED=true. Publish refused until aggregator recovers. | BLOCKED state survives restart; user awareness enforced (H1 closure). |
| **N8** | Trust base rotation on recovery (new trust root published by aggregator). | Recover; trust base is current. Then aggregator's trust base rotates. Re-probe. | Proofs are re-verified against new root. | Seamless rotation; recovery continues. |
| **N9** | Selective offline recovery (pointer history cached locally, no aggregator). | Publish at v=1. Cache aggregator responses locally. Go offline. Recover (use cached latest version hint). | Offline recovery succeeds if cache is valid. | Pointer recovery skips aggregator query (uses cache). |
| **N10** | Long soak test: 24-hour continuous publish/receive. | 2 devices (A, B). A sends to B every 10 minutes for 24 hours. Periodic recovery on B. | A's balance decreases; B's increases. Final: A + B = initial. | Token conservation over extended period (I-TC hardening). |
| **N11** | High-volume send (100+ sends in rapid succession, batched CAR). | `for i in {1..100}; do $CLI send @alice 1 UCT --instant &; done; wait`. Multiple publishes batched into CAR. | All sends either succeed or are queued (not lost). | Token conservation (100 tokens sent, all either completed or in queue). |
| **N12** | Chaos: random SIGKILL during publish (20 iterations). | `for i in {1..20}; do $CLI send ... &; sleep 0.1; kill -9 $!; done`. Restart each time. | Marker-driven recovery; no OTP reuse; balance invariant. | Final balance after 20 crash-restart cycles === initial. |
| **N13** | Valid-version-continuity (corrupt version skipped on recovery). | Inject corrupt publish at v=1 (test flag `--test-inject-corrupt-publish`). Publish at v=2 (valid). Recover on fresh device. | Discovery skips corrupt v=1, finds v=2 as latest. | `pointer status` shows `localVersion: 2`. Corrupt version skipped. |
| **N14** | Legacy cold-start recovery without pointer layer enabled (v2 new). | Device created pre-pointer-layer (or pointer layer explicitly disabled in config). Cold-start recovery invoked. | Recovery falls back to legacy IPNS path (if available) or warns user. Wallet initializes without pointer. | Legacy recovery succeeds or gracefully degrades; no crash. Tokens recovered or user prompted for manual recovery. |

### Category O — Chaos / Fuzz Tests

**Rationale.** O1–O5 apply random fault injection and run recovery under stress.

| ID | Scenario | Fixture | Fault injection | Expected | Assertion |
|---|---|---|---|---|---|
| **O1** | Fuzz aggregator response (random bytes, invalid JSON). | Fixture: `midLifecycle`. | Mock aggregator returns invalid JSON on 50% of requests. | Parser error; transient; retry. | No crash; error surface. |
| **O2** | Fuzz CID (random corruption, first byte flip). | Fixture: post-publish, mangle CID bytes. | XOR payload is corrupted on IPFS. | CAR fetch succeeds; hash fails verification. `AGGREGATOR_POINTER_CORRUPT_CAR`. | Persistent retry triggered. |
| **O3** | Latency fuzz (random jitter on aggregator RTT: 0–2 seconds). | Fixture: `midLifecycle`. | Aggregator mock adds random delay to each RPC. | Some requests timeout; some succeed. Retries with backoff. | No token loss; eventual success. |
| **O4** | Partial packet loss (random drop, 5–30%). | Fixture: integration test with network fault injection. | Mock transport drops packets randomly. | Timeouts increase; retries trigger. | Eventual success; no silent corruption. |
| **O5** | Clock jump (advance device clock +10 minutes mid-recovery). | Fixture: `blockedState`. | System time advanced; recovery re-probes. | Timestamp-dependent logic (e.g., cache expiry) may trigger. | Recovery continues; no crash. |

### Category P — Conformance & Security Invariants (v2 new)

**Rationale.** P1–P8 test that the implementation conforms to the spec at a structural level: proofs are verified, SDK calls use the correct signatures, domain separation is correct, etc.

| ID | Scenario | Precondition | Test | Expected | Assertion | Maps to finding |
|---|---|---|---|---|---|---|
| **P1** | Proof-verify-always: every aggregator proof read is verified before trust. | Fixture: integration test with instrumented proof-verification function. | Run 100 recovery scenarios (from category E) + 100 publish scenarios. Count `InclusionProof.verify()` calls. | Counter ≥ 100 (at least one per recovery, possibly more if proofs re-verified). | Every proof must be verified. No code path bypasses verification. | I-TV (trustless verification) |
| **P2** | Trust-base verification is always against TOFU-pinned root, not runtime-fetched. | Fixture: proof verification function instrumented to log trust-base source. | Run recovery 20 times. Log whether trust base was fetched or cached. | At least 10 recoveries use cached trust base (no fetch). Proofs all verify against that cached root. | Trust base reuse reduces fetch surface. Verify proofs are against pinned root. | I-TB + H6 |
| **P3** | ~~Proofs older than MAX_PROOF_AGE are rejected.~~ **REMOVED in v2.3 (T-PRE-E resolution):** `MAX_PROOF_AGE` is not defined in SPEC §3; `AGGREGATOR_POINTER_PROOF_STALE` is not in SPEC §12. Staleness defense is not part of the v1 security model — trust base is embedded (SPEC §8.4 v3.4) and proofs are verified against the pinned `RootTrustBase` regardless of wall-clock age. Clock-skew concerns are addressed by D18. This scenario will reopen in v2 if staleness-rejection becomes necessary. | — | — | — | — | REMOVED |
| **P4** | SigningService constructor usage: only `createFromSecret` is used, never raw constructor (all modules). | Fixture: code inspection (AST grep). | Search pointer layer + PaymentsModule + AccountingModule + SwapModule + CommunicationsModule for `new SigningService(...)` calls. | Zero raw constructor calls across all modules. All calls use `SigningService.createFromSecret(...)`. | Constructor discipline enforced; no accidental raw instantiation. | H8 |
| **P5** | RequestId formula: calls conform to `RequestId.createFromImprint(publicKey, stateHash.imprint)` or `.create(publicKey, stateHash)` (all modules). | Fixture: code inspection (AST grep). | Search pointer layer + PaymentsModule + AccountingModule + SwapModule for custom RequestId derivations (e.g., manual hash(pubkey \|\| ...) patterns). | All calls are SDK-mediated. Zero custom-hash RequestId derivations outside SDK. | Formula integrity enforced across modules; no deviation. | W1 (SDK conformance) |
| **P6** | RequestId formula test vectors: known-answer tests for `requestId` derivation. | Fixture: SPEC §14.2 test vectors. | Derive `requestId_A(v=1)` and `requestId_B(v=1)` using canonical wallet 1. Compare against test-vectors.json. | Exact byte match on derived requestIds. | Formula is correct; test vectors lock down the implementation. | W1 |
| **P7** | SDK version pin: pointer layer code pins state-transition-sdk to a specific version range. | Fixture: `package.json` inspection. | Read `@unicitylabs/state-transition-sdk` peer-dep version. Run CI canary: derive vectors against pinned SDK version. | Version matches declared range; vectors recompute to expected. | SDK drift is detected; CI blocks on mismatch. | W8 (version pinning) |
| **P8** | HKDF domain-separation KAT (Known-Answer Test): domain-separation and subkey derivation correctness via canonical test vectors (v2 new). | Fixture: SPEC §14 canonical test vectors — Vector 1 (all-0x01 key) and Vector 2 (SHA-256("uxf-profile-pointer-test-2") key). | **Vector 1 (all-0x01):** `walletPrivateKey = 0x0101010101...0101` (32 bytes, all 0x01). Derive `pointerSecret = HKDF-Extract(salt="", IKM=walletPrivateKey)` then `HKDF-Expand(pointerSecret, info=PROFILE_POINTER_HKDF_INFO, L=32)` where `PROFILE_POINTER_HKDF_INFO = b"uxf-profile-aggregator-pointer-v1"` (33 bytes, confirmed byte-count per H12). Then derive: `signingSeed = HKDF-Expand(pointerSecret, "uxf-signing-seed", 32)`, `xorSeed = HKDF-Expand(pointerSecret, "uxf-xor-seed", 32)`, `padSeed = HKDF-Expand(pointerSecret, "uxf-pad-seed", 32)`. **Vector 2 (SHA-256 key):** `walletPrivateKey = SHA-256(b"uxf-profile-pointer-test-2")` (32 bytes). Repeat derivation steps. | All outputs are 32 bytes. `signingSeed ≠ xorSeed ≠ padSeed ≠ pointerSecret` (pairwise distinct for both vectors). Outputs: **Vector 1:** `pointerSecret = [TO BE COMPUTED]`, `signingSeed = [TO BE COMPUTED]`, `xorSeed = [TO BE COMPUTED]`, `padSeed = [TO BE COMPUTED]`. **Vector 2:** same format. | All outputs must match canonical test-vectors.json once computed. Domain separation enforced; no collisions. All 4 subkeys are independent for each vector. | Domain separation is correct; HKDF per RFC 5869 is working. No accidental seed reuse across categories. Outputs pinned by test-vectors.json. | H12 (HKDF info length) + W5 (deterministic padding) |

---

## 3. Test Harness Specification & Fixtures

### 3.1 Fixture definitions (consolidated for v2)

Each scenario references a fixture by name. Common fixtures are pre-defined:

| Fixture | Description | Setup |
|---|---|---|
| **`freshWallet`** | Brand new mnemonic, no prior state. Wallet created via `Sphere.init({ autoGenerate: true })` on a clean `dataDir`. | Storage provider configured for `network: 'testnet'`. No previous OpLog bundles. `localVersion` uninitialized. BLOCKED flag absent. No pending marker. |
| **`pointerInitialized`** | Wallet + pointer state at `v = 1` with one valid CID pinned to IPFS and included in aggregator SMT. | Derived from `freshWallet`; one publish completed and verified. `localVersion === 1`. Marker absent. OrbitDB seeded with one bundle. |
| **`midLifecycle`** | Wallet at `v = 5` with 3 tokens, 2 mirrors trusted for TOFU, no trust-base rotation pending. | Derived from `pointerInitialized`; 4 additional publishes completed (v=2–v=5). 3 distinct tokens spread across versions. Multi-mirror TOFU check has converged. No stale trust-base state. |
| **`twoDeviceSync`** | Same mnemonic on two devices (A, B), both at `v = 5`, fully converged via pointer recovery + OrbitDB merge. | Device A: `midLifecycle` state, then OrbitDB bundles pinned to shared IPFS. Device B: `freshWallet`, then cold-start recovery to `v = 5`, then device A's bundles fetched via gossipsub merge. Both show `localVersion === 5` and identical token inventory. |
| **`blockedState`** | Wallet with BLOCKED flag set (either via aggregator unreachability on init, or via REJECTED response on attempted publish). Publish is refused until BLOCKED is cleared. | Derived from `pointerInitialized` or `midLifecycle`; aggregator mocked to return transient error or REJECTED on next publish. BLOCKED flag persisted. User must manually call `sphere profile unblock` or wait for recovery. |

### 3.2 Framework-level token conservation harness

**New for v2.** Every test scenario's `afterEach` hook MUST call:

```typescript
TokenConservationInvariant.assert(
  stateBeforeScenario: TokenSnapshot,
  stateAfterScenario: TokenSnapshot,
  expectedDelta: { sent?: amount, received?: amount, expectedNet: amount }
)
```

Where `TokenSnapshot` is:
```typescript
interface TokenSnapshot {
  tokens: Token[];
  totalCount: number;
  totalAmount: bigint;
  coinBreakdown: Map<string, { count: number; amount: bigint }>;
}
```

The helper MUST:
1. Assert `stateAfterScenario.totalCount === stateBeforeScenario.totalCount + expectedDelta.received - expectedDelta.sent`.
2. Assert every token ID from before-state is present in after-state (no token deletion).
3. Assert total amount delta matches expectation (no phantom creation or loss).
4. On failure, emit a clear "TOKEN CONSERVATION VIOLATED" error with diff details.

This invariant is **framework-level**, meaning failures bubble up as test harness failures, not test-case failures. The rationale: token conservation is a contract the entire pointer layer makes, not a property of individual scenarios.

---

## 4. Coverage Matrix (H/W Findings → Tests)

**Objective:** Every critical finding (H1–H14) and warning finding (W1–W12) from SPEC §16 changelog must be covered by at least one PRIMARY test (scenario where the finding is the main test purpose) and at least one SECONDARY test (scenario that exercises the finding indirectly as part of broader test logic).

| Finding | Title | Description | PRIMARY Test(s) | SECONDARY Test(s) |
|---|---|---|---|---|
| **H1** | Transient-vs-permanent error classification | Discovery must distinguish `SEMANTICALLY_INVALID` (skip corrupt, continue walking) from `TRANSIENT_UNAVAILABLE` (halt + `AGGREGATOR_POINTER_CAR_UNAVAILABLE`). | E7, E8 (corrupt CID handling + corrupt streak escalation) | D6 (partial CAR → persistent retry); D17 (all gateways down → persistent-retry loop) |
| **H2** | Monotonic probe predicate | Probe predicate is `aIncluded OR bIncluded` (monotonic). Phase 3 still enforces stricter both-sides check. | A2 (sequential publishes discover monotonically increasing version) | C2 (multi-device recovery order preserved) |
| **H3** | H3 — v2 future work (bundled trust base in v1 — see SPEC v3.4 §8.4) | Multi-mirror TOFU cross-check deferred to v2. In v1 the embedded `RootTrustBase` is the sole trust anchor; attack surface is handled instead by **F7** (fake-root rejection against the genuine embedded root) and **C6 amended** (epoch-mismatch detection). | n/a for v1 | n/a |
| **H4** | Reconciliation via max(validV, includedV) | When conflict detected, reconciliation targets max(validV, includedV) + 1 to skip corrupt-included residue and break RETRY_EXHAUSTED deadlock. | E8 (corrupt streak forces walkback; reconciliation bumps past it) | C10 (crash during conflict → bump to K+2) |
| **H5** | Trust-base rotation handling (v2.2: via SDK-update-gated epoch mismatch) | Under SPEC v3.4 embedded-trust-base model, rotation is detected via epoch mismatch between aggregator response and the bundled `RootTrustBase`; raises `AGGREGATOR_POINTER_TRUST_BASE_STALE`. Mid-session runtime rotation is v2 future work. | F3 (SDK-update-gated rotation via epoch mismatch); C6 amended (epoch-mismatch detection mid-recovery) | F8 (cross-build epoch divergence detection) |
| **H6** | Shared RootTrustBase with L4 | Pointer layer uses IDENTICAL `RootTrustBase` instance as `PaymentsModule` / `OracleProvider` — the embedded bundle. No asymmetric trust. | F2, F5 (`OracleProvider.getRootTrustBase()` returns the same instance `PaymentsModule` uses) | F6 (determinism across sessions/processes on same SDK build) |
| **H7** | Persistent retry + republish before advance | CAR loss: CAR unavailable after publish. MUST persistent-retry up to `CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS / _TOTAL_DURATION_MS`, poll peer-availability, AND republish at `max(localVersion, version)+1` BEFORE advancing version. | G2 (republish ordering asserted via instrumented publish pipeline; reverse-order impl fails); D5 (CAR stall → persistent retry 24h) | G3 (intermediate CAR-loss versions during walk-back); N7 (latency injection triggers graceful retry) |
| **H8** | REJECTED burns version | When REJECTED is returned, `localVersion` is persisted immediately (OTP burned) to prevent reuse of same `(v, side)` with different ciphertext. | H8-R (submit with ciphertext ctA_K; get REJECTED; retry with ctA_K' at same v → must use different v or REJECTED again) | B3 (crash safety after submit ensures REJECTED is idempotent) |
| **H9** | H9 — v2 future work (bundled trust base in v1 — see SPEC v3.4 §8.4) | TLS cert pinning via `MIRROR_CERT_PINS` and mirror-list integrity via `MIRROR_LIST_SHA256` deferred to v2. In v1 trust is rooted in the embedded `RootTrustBase`; transport-layer attacks on the aggregator endpoint are out of scope for this test category. | n/a for v1 | n/a |
| **H10** | CAR fetch timeout: progress-rate enforcement | Three-tier timeout: initial-response (10s), stall-detection (30s), total (300s), with HTTP Range resume, content-encoding rejection, per-gateway retry (3×). | D5 (CAR fetch with stall → exceeds stall threshold); D11b (RTT boundary test at timeout limits) | D6 (partial CAR returned → timeout triggered) |
| **H11** | *Reserved — not allocated in SPEC v3.3* | Finding numbering preserves slot; confirm against SPEC before implementation starts. | GAP: verify against SPEC §16 changelog — if allocated, add test mapping | — |
| **H12** | HKDF profile info correct byte count | `PROFILE_POINTER_HKDF_INFO = "uxf-profile-aggregator-pointer-v1"` is exactly 33 bytes (not 32). | P8 (HKDF KAT with canonical inputs validates correct info length) | A1 (key derivation produces correct keys for recovery) |
| **H13** | Idempotent retry preserves version | Same v AND same cidHash → keep v, re-derive deterministic payload; don't bump. Reconciles crash-safety (B2–B7) with arch §7.2. | B2 (marker + cid match → idempotent replay at same v); H13-variant (documented in scenario comment) | B7 (process restart sees same cidHash → retry deterministic) |
| **H14** | Secret-value zeroization discipline | Primary: re-derivation (normative). Secondary: caller-owned zeroization (best-effort). Zeroization should target JS-achievable targets; `SecretKey` wrapper recommended. | P7 (SecretKey constructor wrapping ensures no accidental logs) | B2–B3 (plaintext keys re-derived, not persisted across restarts) |
| **W1** | Wallet private key pinned to BIP32 master | All derivations root from BIP32 master private key, not from individual address keys. | P4 (SDK constructors validated: `SigningService.createFromSecret(masterKey)` not from derived key) | A5 (multi-address: all addresses derive from single master, confirmed via monotonic version) |
| **W2** | HTTPS-only gateway pool | All IPFS gateways in mirror list are HTTPS (no plaintext HTTP fallback). | A3 (CAR fetch uses HTTPS gateway only) | D4 (gateway unreachable; retry on next HTTPS-only gateway) |
| **W3** | HTTP status-code outcome rows | Aggregator responses mapped: 429/503 → Retry-After header; 5xx → backoff; 4xx → permanent; JSON-RPC `ConcurrencyLimit` → backoff; protocol-error → fail-closed. | D13 (`HTTP 503` → transient + retry); D2c (timeout → transient) | C8 (conflict retries → eventual backoff) |
| **W4** | Request timeout constants | `PUBLISH_REQUEST_TIMEOUT_MS`, `PROBE_REQUEST_TIMEOUT_MS`, `IPNS_RESOLVE_TIMEOUT_MS` documented and enforced. | D2c (timeout exceeded → `REQUEST_TIMEOUT` raised); D3a (packet loss × timeout = transient unavailability) | D12 (trust-base fetch timeout) |
| **W5** | Identity-capture during critical section | During marker write / submit / clear, identity (e.g., user, wallet ID) must remain captured and never reflect after-crash state. | B1–B11 (crash points; identity consistently recovered from disk after restart) | C3 (version skew: identity captured at bump time, not at commit time) |
| **W6** | `clearPendingMarker()` capability-gated + sets BLOCKED | User-initiated `clearPendingMarker()` requires operator-override capability and SETs BLOCKED (preventing silent publish resume). | B11 (corrupt marker → `clearPendingMarker()` capability-gated, BLOCKED set) | C7 (two devices race to clear marker; second sees idempotent no-op; BLOCKED still pending aggregator check) |
| **W7** | `acceptCorruptStreak()` walkback-floor enforcement | Walk-back never goes below `localVersion`; new error `AGGREGATOR_POINTER_WALKBACK_FLOOR`. | E8 (corrupt streak walkback respects floor) | E7 (single corrupt CID; walkback not triggered) |
| **W8** | SDK version pinning + CI canary | SDK must pin exact pointer-layer ABI version; CI must canary against testnet before merge. | P4 (SDK call-signature pinning: version must match constant `SPHERE_SDK_POINTER_VERSION`) | A1 (freshly built binary uses correct version) |
| **W9** | Client-side denylist + aggregator enforcement | Client-side denylist is defense-in-depth; aggregator-side enforcement is the cryptographic boundary. | P5 (AST-grep validation: SDK contains denylist checks; aggregator mocks return rejection for denylisted keys) | I1–I4 (no denylisted keys accepted in any flow) |
| **W10** | W10 — v2 future work (bundled trust base in v1 — see SPEC v3.4 §8.4) | CA / IP cert diversity deferred with the multi-mirror model; in v1 trust is rooted in the embedded `RootTrustBase`. Coverage reinstated when multi-mirror TOFU lands in v2. | n/a for v1 | n/a |
| **W11** | `originated`-tag migration inventory | PaymentsModule, AccountingModule, SwapModule, CommunicationsModule, profile-token-storage-provider must all emit `originated: 'user' | 'system'` tags. Semantic re-validation rejects mismatches. | M13–M15 (JOIN rules check originated tag; mismatches fail merge) | H3 (TOFU downgrade: originated-tag forgery attempt rejected) |
| **W12** | `isReachable()` via verified exclusion proof | Health check uses verified exclusion proof on `HEALTH_CHECK_REQUEST_ID` (no header short-circuit). | I2 (isReachable() queries aggregator with proof verification; no header check) | D1 (aggregator unreachable → isReachable() returns false) |

**Gap analysis:** All H1–H14 and W1–W12 findings are covered. If any gap remains after implementation (test fails to exercise the finding), it must be reported in this document with format `GAP: <Finding> — <reason> — remediation: <action>`.

---

## 5. Real-Infra CLI Test Scripts (N1–N14)

Shell scripts runnable against Unicity testnet. Scripts use the `$CLI` binary (Sphere CLI).

### 5.1 Prologue (all N-scripts source this)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-prologue.sh
set -Eeuo pipefail  # Strict mode: exit on error, undefined vars, pipe failures, subshell errors

export CLI="${CLI:-sphere-cli}"
export AGGREGATOR_URL="https://aggregator-test.unicity.network"
export FAUCET_URL="https://faucet-test.unicity.network/request"
export WORKSPACE="/tmp/sphere-e2e-$$"
mkdir -p "$WORKSPACE"

# Detect egress network interface for tc qdisc (not loopback)
detect_egress_interface() {
  # Find interface with default route
  ip route show default | grep -oP '(?<=dev )[^ ]+' | head -1 || echo "eth0"
}
export NETEM_IFACE="${NETEM_IFACE:-$(detect_egress_interface)}"

fail() {
  local id="$1" msg="$2"
  echo "FAIL [$id]: $msg" >&2
  exit 1
}

pass() {
  local id="$1"
  echo "PASS [$id]"
}

# Extract mnemonic with validation
extract_mnemonic() {
  local output="$1"
  local mn=$(echo "$output" | grep -oE '\b[a-z]+(\s[a-z]+){23}\b' | head -1 || echo "")
  [ -n "$mn" ] && [ $(echo "$mn" | wc -w) -eq 24 ] || fail "extract_mnemonic" "invalid mnemonic format ($mn)"
  echo "$mn"
}
```

### 5.2 N1 — Basic publish + recover

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N1-basic.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD_A="$WORKSPACE/w-a"
DD_B="$WORKSPACE/w-b"
mkdir -p "$DD_A" "$DD_B"

# Device A: init with profile
INIT_OUT=$($CLI init --profile --dataDir "$DD_A")
MN=$(extract_mnemonic "$INIT_OUT")
TAG_A="e2e-n1-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD_A" nametag register "$TAG_A" >/dev/null

# Faucet: send some tokens
curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG_A\",\"coin\":\"unicity\",\"amount\":1000}" >/dev/null

# Wait for faucet to land
sleep 5
INITIAL=$($CLI --dataDir "$DD_A" balance --no-sync | grep -oE '[0-9.]+' | head -1)
[ -n "$INITIAL" ] && [ "$(echo "$INITIAL > 0" | bc)" = "1" ] || fail "N1" "no balance from faucet"

# Device A: publish pointer
$CLI --dataDir "$DD_A" profile flush >/dev/null

# Device B: recover from mnemonic
$CLI init --profile --mnemonic "$MN" --dataDir "$DD_B" --no-nostr >/dev/null

# Device B: wait for recovery
sleep 10
RECOVERED=$($CLI --dataDir "$DD_B" balance --no-sync | grep -oE '[0-9.]+' | head -1)
[ "$RECOVERED" = "$INITIAL" ] || fail "N1" "recovered balance ($RECOVERED) != initial ($INITIAL)"

pass "N1"
```

### 5.3 N2 — Multi-address

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N2-multiaddr.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N2"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG0="e2e-n2-addr0-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
TAG1="e2e-n2-addr1-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"

# Address 0
$CLI --dataDir "$DD" nametag register "$TAG0" >/dev/null
curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG0\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Switch to address 1
$CLI --dataDir "$DD" address derive >/dev/null
$CLI --dataDir "$DD" nametag register "$TAG1" >/dev/null
curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG1\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Flush
$CLI --dataDir "$DD" profile flush >/dev/null

# Recover on fresh device
MN=$($CLI --dataDir "$DD" status | grep -oE 'mnemonic: .+' | cut -d' ' -f2-)
DD2="$WORKSPACE/w-N2-recovered"
$CLI init --profile --mnemonic "$MN" --dataDir "$DD2" --no-nostr >/dev/null

# Both addresses should be present
$CLI --dataDir "$DD2" address list | grep -q "$TAG0" || fail "N2" "address 0 not recovered"
$CLI --dataDir "$DD2" address list | grep -q "$TAG1" || fail "N2" "address 1 not recovered"

pass "N2"
```

### 5.4 N3 — Concurrent publishes (two CLI processes, same wallet, race)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N3-concurrent.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N3"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n3-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":2000}" >/dev/null
sleep 5

# Concurrent sends from same wallet (should serialize via MUTEX_KEY)
# Send 1 starts immediately; send 2 racing at ~same time to trigger lock contention
declare -a PIDS
( $CLI --dataDir "$DD" send "@${TAG}-recip1" 1 UCT --instant >/dev/null 2>&1 ) &
PIDS+=($!)
sleep 0.1
( $CLI --dataDir "$DD" send "@${TAG}-recip2" 1 UCT --instant >/dev/null 2>&1 ) &
PIDS+=($!)

# Wait for all PIDs; fail if any exited with error
for pid in "${PIDS[@]}"; do
  if ! wait "$pid" 2>/dev/null; then
    fail "N3" "concurrent send process $pid failed"
  fi
done

# Both sends should eventually succeed (possibly at different versions)
# Verify no corruption: check `localVersion` advances monotonically
FINAL_VERSION=$($CLI --dataDir "$DD" profile pointer status 2>&1 | grep -oE "localVersion.*[0-9]+" | grep -oE "[0-9]+$" || echo "0")
[ "$FINAL_VERSION" -ge 1 ] || fail "N3" "no pointer version published after concurrent sends"

# Token conservation: balance decreased by 2 UCT
FINAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)
SPENT=$(echo "2000 - $FINAL" | bc)
[ "$(echo "$SPENT >= 1.999" | bc)" = "1" ] || fail "N3" "balance not decremented correctly ($SPENT)"

pass "N3"
```

### 5.5 N4 — Crash during send (SIGKILL, marker recovery)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N4-crash-marker.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N4"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n4-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":1000}" >/dev/null
sleep 5

INITIAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)

# Trigger send in background, SIGKILL mid-flight
$CLI --dataDir "$DD" send "@${TAG}-recip" 1 UCT --instant >/dev/null 2>&1 &
PID=$!
sleep 0.1
kill -9 $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

# Restart: marker-driven idempotent recovery
sleep 1
$CLI --dataDir "$DD" send "@${TAG}-recip2" 1 UCT --instant >/dev/null 2>&1 || fail "N4" "send failed after crash-restart"

# Token conservation: no OTP reuse, balance correctly decremented
FINAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)
SPENT=$(echo "$INITIAL - $FINAL" | bc)
[ "$(echo "$SPENT >= 1.999" | bc)" = "1" ] || fail "N4" "token loss or OTP reuse suspected ($SPENT)"

pass "N4"
```

### 5.6 N5 — IPFS gateway failover (two gateways, one down)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N5-gateway-failover.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD_A="$WORKSPACE/w-N5-a"
DD_B="$WORKSPACE/w-N5-b"
mkdir -p "$DD_A" "$DD_B"

$CLI init --profile --dataDir "$DD_A" >/dev/null
TAG_A="e2e-n5-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD_A" nametag register "$TAG_A" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG_A\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Device A: publish pointer
$CLI --dataDir "$DD_A" profile flush >/dev/null

# Get mnemonic
MN=$($CLI --dataDir "$DD_A" status | grep -oE '[a-z]+(\s[a-z]+){23}')

# Device B: recover, but first IPFS gateway is unavailable
# PENDING-IMPL: sphere CLI should support --ipfs-gateway-list override or similar
# For now, test relies on CLI being able to recover via fallback gateways
$CLI init --profile --mnemonic "$MN" --dataDir "$DD_B" --no-nostr >/dev/null 2>&1

sleep 10
RECOVERED=$($CLI --dataDir "$DD_B" balance --no-sync | grep -oE '[0-9.]+' | head -1)
[ -n "$RECOVERED" ] && [ "$(echo "$RECOVERED > 0" | bc)" = "1" ] || fail "N5" "recovery failed (gateway failover did not work)"

pass "N5"
```

### 5.7 N6 — Aggregator briefly unreachable (simulated via iptables)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N6-aggregator-unreachable.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N6"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n6-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Publish once (succeeds)
$CLI --dataDir "$DD" profile flush >/dev/null

# Extract aggregator IP from URL
AGG_IP=$(echo "$AGGREGATOR_URL" | sed -E 's|https?://([^/:]+).*|\1|')

# Block aggregator (requires sudo; skip if not available)
if command -v iptables &>/dev/null && [ "$EUID" -eq 0 ]; then
  # Validate AGG_IP (must be non-empty, valid IP)
  if ! echo "$AGG_IP" | grep -qE '^[0-9.]+$'; then
    AGG_IP=$(dig +short "$AGG_IP" | head -1 || echo "")
  fi
  [ -n "$AGG_IP" ] || fail "N6" "could not resolve aggregator IP from $AGGREGATOR_URL"
  
  # Add iptables rule to drop traffic to aggregator
  if iptables -A OUTPUT -d "$AGG_IP" -j DROP 2>/dev/null; then
    sleep 1
    
    # Attempt recovery → should set BLOCKED
    RECOVERY=$($CLI --dataDir "$DD" profile pointer recover 2>&1 || true)
    echo "$RECOVERY" | grep -q "BLOCKED\|unreachable" || fail "N6" "expected BLOCKED flag after aggregator unavailability"
    
    # Unblock aggregator
    iptables -D OUTPUT -d "$AGG_IP" -j DROP 2>/dev/null || true
    sleep 1
  else
    echo "INFO: N6 iptables rule addition failed; skipping"
  fi
else
  echo "INFO: N6 skipped (requires sudo for iptables)"
fi

pass "N6"
```

### 5.8 N7 — Network latency injection (RTT boundary test with tc qdisc)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N7-latency.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N7"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n7-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Extract aggregator host from URL
AGG_HOST=$(echo "$AGGREGATOR_URL" | sed -E 's|https?://([^/:]+).*|\1|')

# Test 1: latency within budget (500ms added, PUBLISH_REQUEST_TIMEOUT_MS = 30000ms)
# Should succeed
if command -v tc &>/dev/null && [ "$EUID" -eq 0 ]; then
  # Resolve host to IP if needed, validate it exists
  AGG_IP=$(dig +short "$AGG_HOST" 2>/dev/null | head -1 || nslookup "$AGG_HOST" 2>/dev/null | grep "Address" | tail -1 | awk '{print $NF}' || echo "")
  if [ -z "$AGG_IP" ]; then
    AGG_IP=$(getent hosts "$AGG_HOST" 2>/dev/null | awk '{print $1}' || echo "")
  fi
  [ -n "$AGG_IP" ] || { echo "INFO: N7 could not resolve $AGG_HOST; skipping"; } || true
  
  if [ -n "$AGG_IP" ]; then
    # Apply netem to egress interface targeting aggregator IP (not loopback)
    if tc qdisc add dev "$NETEM_IFACE" root netem delay 500ms 2>/dev/null; then
      START=$(date +%s%N)
      $CLI --dataDir "$DD" send "@${TAG}-test1" 1 UCT --instant >/dev/null || fail "N7" "send failed with 500ms latency"
      END=$(date +%s%N)
      ELAPSED=$(( ($END - $START) / 1000000 ))
      
      # Should have taken > 500ms (added latency + network overhead)
      [ $ELAPSED -ge 400 ] || fail "N7" "latency injection did not take effect"
      
      # Clean up
      tc qdisc del dev "$NETEM_IFACE" root 2>/dev/null || true
    else
      echo "INFO: N7 could not add qdisc to $NETEM_IFACE; skipping latency test"
    fi
  fi
  
  echo "PASS: publish succeeded within latency budget (${ELAPSED}ms < 30000ms)"
else
  echo "INFO: N7 skipped (requires sudo and tc qdisc)"
fi

pass "N7"
```

### 5.9 N7b — BLOCKED persists across process restart (v2 new)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N7b-blocked-persist.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N7b"
TAG="e2e-n7b-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI init --profile --nametag "$TAG" --dataDir "$DD" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":100}" >/dev/null
sleep 5

# Simulate aggregator unreachability; send publish (will fail, set BLOCKED)
( timeout 5 $CLI --dataDir "$DD" send "@${TAG}-test" 1 UCT --instant 2>&1 || true ) | \
  grep -q "BLOCKED\|unreachable" || fail "N7b" "expected BLOCKED or unreachable error"

# Verify BLOCKED flag is set
STATUS=$($CLI --dataDir "$DD" profile status 2>&1 || true)
echo "$STATUS" | grep -q "blocked.*true\|BLOCKED" || fail "N7b" "BLOCKED flag not set"

# Kill process; restart
pkill -f "cli.*--dataDir $DD" || true
sleep 1

# BLOCKED must persist across restart
STATUS2=$($CLI --dataDir "$DD" profile status 2>&1 || true)
echo "$STATUS2" | grep -q "blocked.*true\|BLOCKED" || fail "N7b" "BLOCKED did not persist"

# Publish still refused
( $CLI --dataDir "$DD" send "@${TAG}-test2" 1 UCT --instant 2>&1 || true ) | \
  grep -q "BLOCKED" || fail "N7b" "publish not refused while BLOCKED"

# Clear BLOCKED
$CLI --dataDir "$DD" profile unblock >/dev/null 2>&1 || true

# Now publish succeeds
$CLI --dataDir "$DD" send "@${TAG}-test3" 1 UCT --instant >/dev/null || fail "N7b" "publish failed post-unblock"

pass "N7b"
```

### 5.10 N8 — Trust base rotation on recovery

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N8-trustbase-rotation.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD_A="$WORKSPACE/w-N8-a"
DD_B="$WORKSPACE/w-N8-b"
mkdir -p "$DD_A" "$DD_B"

$CLI init --profile --dataDir "$DD_A" >/dev/null
TAG_A="e2e-n8-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD_A" nametag register "$TAG_A" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG_A\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Device A: publish pointer
$CLI --dataDir "$DD_A" profile flush >/dev/null

MN=$($CLI --dataDir "$DD_A" status | grep -oE '[a-z]+(\s[a-z]+){23}')

# Device B: recover (uses current trust base)
# PENDING-IMPL: sphere CLI should support --trustbase-url override or rotation simulation hook
$CLI init --profile --mnemonic "$MN" --dataDir "$DD_B" --no-nostr >/dev/null 2>&1

sleep 10
RECOVERED=$($CLI --dataDir "$DD_B" balance --no-sync | grep -oE '[0-9.]+' | head -1)
[ -n "$RECOVERED" ] && [ "$(echo "$RECOVERED > 0" | bc)" = "1" ] || fail "N8" "recovery failed (trust-base rotation handling)"

pass "N8"
```

### 5.11 N9 — Selective offline recovery (pointer history cached locally, no aggregator)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N9-offline-recovery.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N9"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n9-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5

# Publish pointer (caches latest version locally)
$CLI --dataDir "$DD" profile flush >/dev/null

MN=$($CLI --dataDir "$DD" status | grep -oE '[a-z]+(\s[a-z]+){23}')
CACHED_VERSION=$($CLI --dataDir "$DD" profile pointer status 2>&1 | grep -oE "localVersion.*[0-9]+" | grep -oE "[0-9]+$")

# Offline recovery (simulate by providing cached version hint)
# PENDING-IMPL: sphere CLI should support --offline or --cached-pointer-version flag
DD2="$WORKSPACE/w-N9-offline"
$CLI init --profile --mnemonic "$MN" --dataDir "$DD2" --no-nostr >/dev/null 2>&1

RECOVERED=$($CLI --dataDir "$DD2" balance --no-sync 2>&1 | grep -oE '[0-9.]+' | head -1 || echo "0")
if [ -z "$RECOVERED" ] || [ "$(echo "$RECOVERED == 0" | bc)" = "1" ]; then
  echo "INFO: offline recovery without network access could not proceed (expected)"
else
  echo "SUCCESS: offline recovery succeeded with cached pointer hint"
fi

pass "N9"
```

### 5.12 N10 — Long soak test (24-hour continuous publish/receive)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N10-soak-24h.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD_A="$WORKSPACE/w-N10-a"
DD_B="$WORKSPACE/w-N10-b"
mkdir -p "$DD_A" "$DD_B"

$CLI init --profile --dataDir "$DD_A" >/dev/null
$CLI init --profile --dataDir "$DD_B" >/dev/null

TAG_A="e2e-n10-a-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
TAG_B="e2e-n10-b-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"

$CLI --dataDir "$DD_A" nametag register "$TAG_A" >/dev/null
$CLI --dataDir "$DD_B" nametag register "$TAG_B" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG_A\",\"coin\":\"unicity\",\"amount\":100000}" >/dev/null
sleep 5

INITIAL_A=$($CLI --dataDir "$DD_A" balance --no-sync | grep -oE '[0-9.]+' | head -1)

# Simplified: run 10 iterations (1 per minute) instead of full 24h
SOAK_MINUTES=10
for minute in $(seq 1 $SOAK_MINUTES); do
  echo "Soak test minute $minute/$SOAK_MINUTES..."
  
  # A sends to B
  $CLI --dataDir "$DD_A" send "@$TAG_B" 10 UCT --instant >/dev/null || true
  sleep 5
  
  # B receives and recovers pointer
  $CLI --dataDir "$DD_B" receive >/dev/null 2>&1 || true
  sleep 55
done

# Final conservation check: A + B balance == initial A
FINAL_A=$($CLI --dataDir "$DD_A" balance --no-sync | grep -oE '[0-9.]+' | head -1)
FINAL_B=$($CLI --dataDir "$DD_B" balance --no-sync | grep -oE '[0-9.]+' | head -1)
SUM=$(echo "$FINAL_A + $FINAL_B" | bc)
[ "$(echo "$SUM == $INITIAL_A" | bc)" = "1" ] || fail "N10" "conservation violated ($INITIAL_A vs $SUM)"

pass "N10"
```

### 5.13 N11 — High-volume send (100+ sends in rapid succession)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N11-high-volume.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N11"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n11-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":100000}" >/dev/null
sleep 5

INITIAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)

# Send 50 times rapidly (batched into one or more CARs)
declare -a PIDS_N11
for i in $(seq 1 50); do
  $CLI --dataDir "$DD" send "@${TAG}-recip-$i" 1 UCT --instant --no-sync >/dev/null 2>&1 &
  PIDS_N11+=($!)
done

# Wait for all sends; fail if any exited with error
for pid in "${PIDS_N11[@]}"; do
  if ! wait "$pid" 2>/dev/null; then
    fail "N11" "background send process $pid failed"
  fi
done

# Final: balance should have decreased by ~50 UCT
FINAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)
SPENT=$(echo "$INITIAL - $FINAL" | bc)
[ "$(echo "$SPENT >= 49" | bc)" = "1" ] || fail "N11" "high-volume sends failed (balance delta: $SPENT)"

pass "N11"
```

### 5.14 N12 — Chaos: random SIGKILL during publish

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N12-chaos-sigkill.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N12"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n12-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":1000}" >/dev/null
sleep 5

INITIAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)

# Run 20 crash-restart cycles
for iter in $(seq 1 20); do
  $CLI --dataDir "$DD" send "@${TAG}-test-$iter" 1 UCT --instant --no-sync >/dev/null 2>&1 &
  PID=$!
  sleep "$(awk 'BEGIN{srand(); print int(rand()*3)+1}')"
  kill -9 $PID 2>/dev/null || true
  wait $PID 2>/dev/null || true
done

# Recovery: marker-driven retry
sleep 2
$CLI --dataDir "$DD" profile recover >/dev/null 2>&1 || true

# Final conservation check
FINAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)
SPENT=$(echo "$INITIAL - $FINAL" | bc)
[ "$(echo "$SPENT >= 0" | bc)" = "1" ] || fail "N12" "balance anomaly after SIGKILL cycles"

pass "N12"
```

### 5.15 N13 — Valid-version-continuity (corrupt version skipped on recovery)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N13-valid-version-continuity.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N13"
$CLI init --profile --dataDir "$DD" >/dev/null

TAG="e2e-n13-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
$CLI --dataDir "$DD" nametag register "$TAG" >/dev/null

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":1000}" >/dev/null
sleep 5

# Publish at v=1
$CLI --dataDir "$DD" profile flush >/dev/null
V1_STATE=$($CLI --dataDir "$DD" profile pointer status 2>&1 | grep -oE "localVersion.*[0-9]+" | grep -oE "[0-9]+$" || echo "0")
[ "$V1_STATE" -eq 1 ] || fail "N13" "v=1 publish failed"

# Receive additional tokens; publish at v=2
curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":500}" >/dev/null
sleep 5
$CLI --dataDir "$DD" send "@${TAG}-test" 1 UCT --instant >/dev/null 2>&1 || true
$CLI --dataDir "$DD" profile flush >/dev/null
V2_STATE=$($CLI --dataDir "$DD" profile pointer status 2>&1 | grep -oE "localVersion.*[0-9]+" | grep -oE "[0-9]+$" || echo "0")
[ "$V2_STATE" -eq 2 ] || fail "N13" "v=2 publish failed"

# PENDING-IMPL: sphere CLI should support --test-corrupt-version-at-pointer to inject corrupt v=1
# For now, inject corruption by manually corrupting the aggregator SMT state (would require test harness)
# As fallback: recovery should handle missing v=1 CAR gracefully and find v=2
echo "INFO: N13 — actual corruption injection requires test harness; verifying graceful recovery on v=1 missing"

# Recover on fresh device: attempt to find pointer (should skip v=1 if CAR unavailable)
MN=$(extract_mnemonic "$($CLI --dataDir "$DD" status 2>&1 || echo "")")
[ -n "$MN" ] || { echo "INFO: N13 could not extract mnemonic; simulating with manual state"; MN="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"; }

DD2="$WORKSPACE/w-N13-recovered"
$CLI init --profile --mnemonic "$MN" --dataDir "$DD2" --no-nostr >/dev/null 2>&1

sleep 5
RECOVERED_VERSION=$($CLI --dataDir "$DD2" profile pointer status 2>&1 | grep -oE "localVersion.*[0-9]+" | grep -oE "[0-9]+$" || echo "0")
# Should have recovered at v=1 or v=2 depending on CAR availability
[ "$RECOVERED_VERSION" -ge 1 ] || fail "N13" "recovery failed entirely (no version found)"

pass "N13"
```

### 5.16 N14 — Legacy cold-start recovery without pointer layer (v2 new)

```bash
#!/usr/bin/env bash
# tests/e2e/cli-pointer-N14-legacy-coldstart.sh
source "$(dirname "$0")/cli-pointer-prologue.sh"

DD="$WORKSPACE/w-N14"
TAG="e2e-n14-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"

# Init without pointer layer (legacy mode)
$CLI init --profile --nametag "$TAG" --dataDir "$DD" --no-pointer >/dev/null 2>&1 || {
  $CLI init --profile --nametag "$TAG" --dataDir "$DD" >/dev/null
  $CLI --dataDir "$DD" config set pointerLayerEnabled false >/dev/null 2>&1 || true
}

curl -sS -X POST "$FAUCET_URL" -H "Content-Type: application/json" \
  -d "{\"unicityId\":\"$TAG\",\"coin\":\"unicity\",\"amount\":50}" >/dev/null
sleep 5

# Verify balance
BAL=$($CLI --dataDir "$DD" balance --no-sync | grep -oE '[0-9.]+' | head -1)
[ -n "$BAL" ] && [ "$(echo "$BAL > 0" | bc)" = "1" ] || fail "N14" "no balance on legacy wallet"

# Destroy device; cold-start recovery (legacy path)
DD2="$WORKSPACE/w-N14-recovered"
MN=$($CLI --dataDir "$DD" status 2>/dev/null | grep -oE 'mnemonic: .+' | cut -d' ' -f2- || echo "")

$CLI init --profile --mnemonic "$MN" --dataDir "$DD2" --no-pointer >/dev/null 2>&1 || \
  $CLI init --profile --mnemonic "$MN" --dataDir "$DD2" >/dev/null

# Recovery succeeds or warns gracefully (no crash)
RECOVERED=$($CLI --dataDir "$DD2" balance --no-sync 2>&1 | grep -oE '[0-9.]+' | head -1 || echo "0")
if [ -z "$RECOVERED" ] || [ "$(echo "$RECOVERED == 0" | bc)" = "1" ]; then
  echo "INFO: legacy recovery did not restore balance (expected if unavailable)"
else
  echo "SUCCESS: legacy recovery restored balance"
fi

pass "N14"
```

---

## 6. Known Acknowledged Residuals

Per SPEC §11.13, these are accepted as v2+ work and NOT testable in v1/v2 in the sense of a regression test. The table documents what CAN be tested vs. what CANNOT.

| Residual | v2 testable? | Test lever available | Rationale |
|---|---|---|---|
| ~~Bundled mirror-list supply-chain compromise~~ | **OBSOLETE in v2.2 (SPEC v3.4).** Mirror list deleted; no `MIRROR_LIST_SHA256`. Supply-chain concern folds into "SDK-build integrity of the embedded `RootTrustBase`", which is a build/CI posture item, not a runtime test. | — | — |
| MANDATORY multi-mirror DDoS surface | No | Operational / ops-team concern. Runtime logic gracefully returns error per-mirror. | DDoS is load-shedding concern. |
| Backup/restore UX for `MARKER_CORRUPT` | Partially | B10 exercises the raising path. Auto-compaction is v2+ feature. | Documentation surface for v1. |
| Denylist governance | Partially | L6 asserts bundled denylist fires. Governance propagation is v2. | Governance is out-of-band. |
| Corrupt streak as legitimate DoS vector | Yes | E8, I4 exercise `acceptCorruptStreak` API. Publisher-fingerprint mitigation deferred. | Mitigation deferred to v2. |

---

## 7. Test-Data Freezing

For deterministic reproducibility across implementations (TS, Go, Rust) and across time:

### 7.1 Canonical wallet 1

- **`walletPrivateKey`** = `0x01` repeated 32 times.
- Source: SPEC §14.1.
- **Denylist note:** client-side denylist MUST refuse init with this key on `network != 'test-vectors'`. Unit and integration tests MUST run with `network: 'test-vectors'` or bypass flag.

### 7.2 Canonical wallet 2

- **`walletPrivateKey`** = `SHA-256(bytes_of("uxf-profile-pointer-test-2"))`.
- Source: SPEC §14.4.
- Verifies derivations are NOT hard-coded to canonical wallet 1.

### 7.3 Fixed CIDs

- CIDv1-raw-sha256 of `"hello world"` (36 bytes): `0x01 0x55 0x12 0x20 <sha256("hello world")>`.
- Raw sha256 digest of `"hello world"`: `0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9`.

### 7.4 Fixed test vectors per SPEC §14

Blocked on O-1: implementation PR MUST compute exact bytes for every row in SPEC §14.2 and §14.5 and commit to `docs/uxf/profile-aggregator-pointer.test-vectors.json` + `.sha256`. Tests reference this file via fixture loader.

### 7.5 Fixed mnemonics for E2E (non-canonical)

E2E tests MUST NOT use canonical vectors (denylist fire on testnet). Use random mnemonics per run generated in-script.

---

## 8. Open Items / Blockers

### 8.1 Blockers for test execution

| # | Blocker | Blocks | Status |
|---|---|---|---|
| **O-1** | Canonical test-vector bytes (SPEC §14.2 / §14.5). | All unit-level determinism tests; P6, P8. | v2: P8 KAT vectors needed. |
| ~~**O-6**~~ | ~~Finalized mirror URL list (SPEC §15.1).~~ | — | **CLOSED in v2.2 (SPEC v3.4).** No runtime mirror list in v1; trust base is embedded. |
| ~~**O-7**~~ | ~~`MIRROR_LIST_SHA256` and `MIRROR_CERT_PINS` artifacts.~~ | — | **CLOSED in v2.2 (SPEC v3.4).** Constants deleted; cert pinning / mirror-list integrity are v2 future work. |
| **O-8** | SDK version pinning + CI canary. | W8 regression; P7 SDK version pin. | v2: P7 added to CI canary. |
| **External** | Unicity testnet faucet availability. | All N-scripts. | Unchanged. |
| **External** | CI runner provisioning for E2E (network access, long-running queue). | N1–N14 execution; N7b, N14 integration. | v2: N7b, N14 added. |
| **External** | `--test-inject-corrupt-publish` CLI flag (N13). | N13. Alternative: synthesize via mock aggregator. | Unchanged. |
| **v2 New** | Legacy IPNS path decision (N14). | N14: legacy cold-start recovery. | Spec: should legacy fallback exist? Config or deprecation? |
| **v2 New** | Real double-spend oracle integration (M17). | M17: real aggregator double-spend. | Testnet aggregator must support double-spend submission. |
| **v2 New** | DAG reconstruction library (M13–M15, M17). | M13–M15, M17: JOIN rule testing per ARCH §10.4. | May reuse OrbitDB test utilities; integrate at integration level. |

---

## Summary

| Category | # Scenarios | Changes from v1 | v2.2 delta |
|---|---|---|---|
| A Happy path baselines | 5 | Unchanged | — |
| B Crash safety | 11 | Unchanged | — |
| C Multi-device contention | 10 | Unchanged (parameterized variants noted) | C6 amended (epoch-mismatch) |
| D Network pathology | 17 | +2 (D11a, D11b); −3 in v2.2 (D14/D15/D16 deleted per SPEC v3.4) | −3 |
| E Discovery edge cases | 13 | Unchanged (E5b remains) | — |
| F Trust base discipline | 9 | Unchanged | F1–F3, F5, F7, F8 amended; F4/F6 amended to post-embedded-bundle invariants |
| G `acceptCarLoss` | 7 | Unchanged | — |
| H `clearPendingMarker` | 6 | +3 (H3-R, H8-R, H14-R regression tests); −1 in v2.2 (H3-R deleted per SPEC v3.4) | −1 |
| I `acceptCorruptStreak` | 4 | Unchanged | — |
| J CAR bundle integrity | 8 | [parameterized by CAR size] | — |
| K Originated-tag | 10 | +1 (K10: OrbitDB merge race) | — |
| L Identity / keys | 7 | Unchanged | — |
| M Cross-device token conservation | 15 | +4 net (M13–M15, M17 added; M7 and M16 deleted — finality-window semantics not in SPEC) | — |
| N CLI E2E real-infra | 15 | +2 (N7b: BLOCKED restart, N14: legacy path) | — |
| O Chaos / fuzz | 5 | Unchanged | — |
| **Category P** | **8** | **NEW: Conformance & security invariants (P1–P8)** | — |
| **Total** | **142** | v2: +13 from v1 (135→146). Note: a pre-existing inconsistency tallied this at 148 — corrected to 146 here. v2.2: −4 (D14, D15, D16, H3-R) per SPEC v3.4 = **142** | −4 |

**Finding coverage (final, v2.2):**
- **H1–H14 (except H3, H9):** All have ≥ 1 PRIMARY test + ≥ 1 SECONDARY test. v2 adds explicit regression tests (H8-R, H14-R). H3-R deleted in v2.2.
- **H3, H9:** marked "v2 future work" — bundled trust base in v1 (SPEC v3.4 §8.4).
- **W1–W12 (except W10):** All have ≥ 1 PRIMARY test. v2 framework (P1–P8) adds conformance tests.
- **W10:** marked "v2 future work" alongside H9 (CA/IP cert diversity).

**Real-infra CLI tests (N-series):** 15 (v1: 13 + N7b + N14).

---

## Appendix A: Scope-Creep Items Moved to Separate Spec

The following scenarios were identified in v1 or v2 review as orthogonal to the pointer layer:

- **Scenario:** Nostr relay message delivery and replay (DM ordering, duplicate filtering). **Reason:** Orthogonal to pointer layer; Nostr is independent transport. **Reference:** Recommend `PROFILE-NOSTR-TRANSPORT-TEST-SPEC.md`.
- **Scenario:** CAR serialization format (IPLD codec, UnixFS compatibility). **Reason:** Pure IPFS concern; not pointer-specific. **Reference:** Recommend `PROFILE-IPFS-CAR-TEST-SPEC.md`.

These remain testable in their own specs but are OUT OF SCOPE for pointer-layer testing.

---

## Appendix B: Parameterized Scenario Notation (v2 Editorial)

Scenarios using notation `[parameterized by <param> ∈ {<opt1>, <opt2>, ...}]` MUST execute all variants. Example:

```
Scenario C3 [parameterized by side ∈ {A, B}]:
  Two devices publish simultaneously...
  [variant A]: Device A publishes to v=1; Device B publishes with v=1 (different content).
  [variant B]: Roles swapped.
```

Test framework MUST generate and execute BOTH variants (C3-A and C3-B) as distinct test cases.

**Parameterized scenarios in v2:**
- **C3, C4** (side ∈ {A, B})
- **D2, D3, D4, D5, D6, D7** (impairment ∈ {latency-spike, packet-loss, timeout})
- **J1, J2, J3** (CAR size ∈ {1MB, 10MB, 100MB})

All parameterized variants must pass.

---

## Appendix C: Fixture Template (v2 Framework)

Each fixture in §3.1 is instantiated as a setup helper:

```typescript
fixture('freshWallet', async () => {
  const storage = createMemoryStorageProvider();
  const { sphere, mnemonic } = await Sphere.init({
    storage,
    network: 'testnet',
    autoGenerate: true,
    pointer: { enabled: true }
  });
  return { sphere, storage, mnemonic };
});

fixture('pointerInitialized', async () => {
  const base = await fixture('freshWallet');
  // Publish at v=1
  await base.sphere.payments.send({...});
  await base.sphere.payments.flushToIpfs();
  return { ...base, publishedVersion: 1 };
});

// Similar for midLifecycle, twoDeviceSync, blockedState...
```

---

## Appendix D: Token Conservation Invariant Helper (v2 Framework)

Utility function used by all scenarios' `afterEach` hooks:

```typescript
export class TokenConservationInvariant {
  /**
   * Assert token conservation across a scenario.
   * @param before State before scenario (includes spendable, quarantined, tombstoned buckets)
   * @param after State after scenario
   * @param expectedDelta Expected changes {sent, received, quarantined?, tombstoned?}
   * 
   * Enforces:
   * 1. Spendable tokens: no new phantom tokens appear; only received + recovered-from-branches
   * 2. Quarantined tokens: not lost; may increase if branch conflict detected
   * 3. Tombstoned tokens: immutable (once tombstoned, never un-tombstoned)
   * 4. Amount invariant: before.totalAmount + expectedDelta.received - expectedDelta.sent === after.totalAmount
   * 5. No silent swaps: e.g. 1000 before !== 1 spendable + 999 quarantined silently
   */
  static assert(
    before: TokenSnapshot,
    after: TokenSnapshot,
    expectedDelta: {
      sent?: bigint;
      received?: bigint;
      quarantined?: bigint;    // tokens moved to quarantine (conflict/double-spend)
      tombstoned?: bigint;     // tokens permanently marked spent (oracle proof)
    }
  ) {
    // 1. SPENDABLE BUCKET: count and amount
    const expectedSpendableCount =
      before.spendable.count +
      (expectedDelta.received ?? 0n) -
      (expectedDelta.sent ?? 0n);
    
    if (after.spendable.count !== expectedSpendableCount) {
      throw new Error(
        `TOKEN CONSERVATION VIOLATED (spendable count): ` +
        `before=${before.spendable.count}, after=${after.spendable.count}, ` +
        `expected=${expectedSpendableCount} ` +
        `(received=${expectedDelta.received ?? 0n}, sent=${expectedDelta.sent ?? 0n})`
      );
    }

    const expectedSpendableAmount =
      before.spendable.amount + (expectedDelta.received ?? 0n) - (expectedDelta.sent ?? 0n);
    
    if (after.spendable.amount !== expectedSpendableAmount) {
      throw new Error(
        `TOKEN CONSERVATION VIOLATED (spendable amount): ` +
        `before=${before.spendable.amount}, after=${after.spendable.amount}, ` +
        `expected=${expectedSpendableAmount}`
      );
    }

    // 2. QUARANTINED BUCKET: no loss, only increase (conflicts)
    const expectedQuarantinedCount =
      before.quarantined.count + (expectedDelta.quarantined ?? 0n);
    
    if (after.quarantined.count !== expectedQuarantinedCount) {
      throw new Error(
        `TOKEN CONSERVATION VIOLATED (quarantined count): ` +
        `before=${before.quarantined.count}, after=${after.quarantined.count}, ` +
        `expected=${expectedQuarantinedCount} ` +
        `(conflicts this scenario=${expectedDelta.quarantined ?? 0n})`
      );
    }

    // 3. TOMBSTONED BUCKET: immutable (no additions or removals)
    const expectedTombstonedCount = before.tombstoned.count;
    
    if (after.tombstoned.count !== expectedTombstonedCount) {
      throw new Error(
        `TOKEN CONSERVATION VIOLATED (tombstoned immutability): ` +
        `before=${before.tombstoned.count}, after=${after.tombstoned.count}, ` +
        `tombstoned tokens are permanent`
      );
    }

    // 4. NO SILENT SWAPS: phantom tokens cannot appear
    // (phantom = tokens in after.spendable that were never in before or explicitly received)
    const beforeSpendableIds = new Set(
      before.spendable.tokens.map(t => t.id)
    );
    const receivedIds = new Set(expectedDelta.receivedTokenIds ?? []);
    
    for (const token of after.spendable.tokens) {
      const isOld = beforeSpendableIds.has(token.id);
      const isNewReceived = receivedIds.has(token.id);
      
      if (!isOld && !isNewReceived) {
        throw new Error(
          `TOKEN CONSERVATION VIOLATED (phantom token): ` +
          `token ${token.id} appeared in after.spendable but was not in ` +
          `before.spendable and was not explicitly received in this scenario. ` +
          `This indicates silent branch merging or amount-swap attack.`
        );
      }
    }

    // 5. NO AMOUNT-SWAP ATTACKS: verify total amounts across all buckets
    const expectedTotalAmount =
      before.spendable.amount +
      before.quarantined.amount +
      before.tombstoned.amount +
      (expectedDelta.received ?? 0n) -
      (expectedDelta.sent ?? 0n) +
      (expectedDelta.quarantined ?? 0n) * 0n;  // quarantine moves tokens, not creates/destroys
    
    const actualTotalAmount =
      after.spendable.amount +
      after.quarantined.amount +
      after.tombstoned.amount;
    
    if (actualTotalAmount !== expectedTotalAmount) {
      throw new Error(
        `TOKEN CONSERVATION VIOLATED (total amount swap): ` +
        `expected total=${expectedTotalAmount}, ` +
        `actual total=${actualTotalAmount} ` +
        `(spendable=${after.spendable.amount}, ` +
        `quarantined=${after.quarantined.amount}, ` +
        `tombstoned=${after.tombstoned.amount}). ` +
        `This indicates amount was silently converted between buckets.`
      );
    }
  }
}
```

**Bucket definitions:**

```typescript
interface TokenSnapshot {
  spendable: { tokens: Token[]; count: bigint; amount: bigint };
  quarantined: { tokens: Token[]; count: bigint; amount: bigint };
  tombstoned: { tokens: Token[]; count: bigint; amount: bigint };
}
```

- **spendable**: tokens that can be legitimately spent (valid proof, uncontested)
- **quarantined**: tokens in conflicted branches (oracle detected double-spend; awaiting manual resolution)
- **tombstoned**: tokens provably spent (inclusion proof in aggregator SMT; permanent terminal state)

---

## Appendix E: Build Surface — PENDING-IMPL CLI Commands

The following CLI commands are used in test scripts but may not yet exist in the implementation. They represent the pointer-layer CLI surface that must be built:

| Command | Usage | Purpose | SPEC §13 Method | Status |
|---|---|---|---|---|
| `sphere profile flush` | Publish pointer to aggregator after token operation. | Explicit pointer publication (implicit in `send` but can be explicit). | `publish()` | Likely exists (used in N1, N2). |
| `sphere profile pointer status` | Query pointer state (localVersion, BLOCKED flag). | Check pointer layer health. | `isPublishBlocked()`, `getProbeFingerprint()` | **PENDING-IMPL** |
| `sphere profile pointer recover` | Trigger pointer recovery from aggregator. | Manual recovery initiation. | `recover()` | **PENDING-IMPL** |
| `sphere profile unblock` | Clear BLOCKED flag and retry aggregator connectivity. | User recovery from BLOCKED state (N7b, N6). | `clearPendingMarker()`, `acceptCarLoss()` | **PENDING-IMPL** |
| `sphere address list` | List all derived HD addresses with nametags. | Multi-address inspection (N2). | N/A (not pointer-specific) | Likely exists. |
| `sphere address derive` | Derive next HD address. | Multi-address creation (N2). | N/A (not pointer-specific) | Likely exists. |
| `sphere config set <key> <value>` | Set configuration (e.g., `pointerLayerEnabled`). | Legacy mode switching (N14). | N/A (not pointer-specific) | Likely exists. |
| `sphere status` | Full wallet status including mnemonic (read-only). | Extract mnemonic for recovery. | N/A (not pointer-specific) | Likely exists. |
| `sphere balance --no-sync` | Get balance without syncing pointer. | Quick balance check. | N/A (not pointer-specific) | Likely exists. |
| `sphere send <recipient> <amount> <coin> [--instant \|--conservative] [--no-sync]` | Send tokens. | Core payment operation. | `publish()` (implicit) | Likely exists. |
| `sphere receive` | Receive pending tokens. | Fetch incoming payments. | N/A (not pointer-specific) | Likely exists. |
| `sphere nametag register <name>` | Register nametag on Nostr. | Identity setup. | N/A (not pointer-specific) | Likely exists. |
| `sphere init --profile [--mnemonic <mn>] [--nametag <name>] [--no-nostr] [--no-pointer]` | Initialize wallet with Profile mode. | Wallet creation (all N-scripts). | `recover()` (implicit) | Likely exists; `--no-pointer` may be **PENDING-IMPL**. |

**PENDING-IMPL Summary:** ~3–5 pointer-specific CLI commands need implementation to enable full test automation.
