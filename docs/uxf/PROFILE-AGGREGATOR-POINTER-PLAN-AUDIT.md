# Profile Aggregator Pointer — Implementation Plan Audit

**Status:** Draft 1 audit of `PROFILE-AGGREGATOR-POINTER-IMPL-PLAN.md` (569 lines, 57 tasks) against SPEC v3.3, ARCH v3.3, TEST-SPEC v2.1 (146 scenarios), and `PROFILE-AGGREGATOR-POINTER-INTEGRATION-MAP.md`.
**Auditor:** Software Architect (adversarial review)
**Date:** 2026-04-21

---

## §1 Verdict

**APPROVE WITH CORRECTIONS.** The plan is solidly structured, the phase breakdown is sound, the 5-phase gating is appropriately conservative, and the task decomposition tracks the spec competently. However, the plan has eight concrete blind spots relative to the Integration Map's surprises (all 5 material surprises are *acknowledged in risk register* but several are not *addressed by a task*), a critical error-code miscount (SPEC §12 contains 29 `AGGREGATOR_POINTER_*` codes + `SECURITY_ORIGIN_MISMATCH` = 30 total; plan says "23"; integration map says "27"), a contradictory directive for T-E4 (proposes IPNS fallback that ARCH §15.1 and §15.3 explicitly delete with "no grace period"), and several agent-type misassignments. None of these are structural — the plan can ship after incorporating the corrections in §2. Phase A can start *after* C-1, C-2, C-5 are resolved; other corrections can be folded in before their phase gates.

---

## §2 Critical corrections (must fix before proceeding)

### C-1. Error-code count is wrong — T-A2 acceptance criterion undercounts by 7
**Where:** Task T-A2 (plan line 298) — "All 23 error codes + `SECURITY_ORIGIN_MISMATCH` with stable string codes".
**What's wrong:** SPEC §12 (lines 1181–1210) defines **29** distinct `AGGREGATOR_POINTER_*` codes plus `SECURITY_ORIGIN_MISMATCH` = **30 total**. The plan says 23+1=24. The Integration Map (§1 row for `core/errors.ts`) says 27+1=28. None of the three match. The original SPEC is canonical.
**Correction:** Rewrite T-A2 acceptance as "All 29 `AGGREGATOR_POINTER_*` codes plus `SECURITY_ORIGIN_MISMATCH` (30 total); emits stable string identifiers matching SPEC §12 table row-for-row; enumeration test asserts exactly 30 members". Add a unit test that parses SPEC §12 table and asserts every row is emitted as a code.
**Responsible:** typescript-pro (T-A2) + security-auditor (spec review).

### C-2. IPNS fallback contradiction (Integration-Map surprise #2) is not resolved before Phase A kickoff
**Where:** T-E4 (plan line 340) — "Disables pointer layer; falls back to legacy IPNS path (for N14)". ARCH §15.1 (line 1055) — "`profile/profile-ipns.ts` **Deleted.** All exports removed". ARCH §15.3 (line 1086) — "**No grace period required**".
**What's wrong:** The plan's T-E4 proposes retaining IPNS for N14 legacy-wallet recovery. ARCH directly contradicts this. TEST-SPEC §N14 assumes the fallback path exists. Three stakeholders (ARCH, TEST-SPEC, PLAN) are mutually inconsistent. This is a stop-the-line blocker because Phase D's `T-D6` task deletes `profile-ipns.ts` method bodies; if the compat decision flips later, T-D6 must be re-scoped.
**Correction:** Before Phase A kickoff, the spec owners (Aggregator team + SDK team) MUST resolve one of:
- (a) Formally remove N14 from TEST-SPEC (match ARCH); or
- (b) Formally amend ARCH §15.1 to retain `profile-ipns.ts` behind `pointer.enabled === false` under a deprecation window; or
- (c) Reinterpret N14 as "cold-start with NO pointer ever published by anyone" (aggregator returns exclusion at v=1), which is the natural fresh-wallet case and does NOT require legacy IPNS at all.
The plan's current T-E4 implies (b); if (b) is rejected, delete T-E4's "falls back to legacy IPNS path" line and respec N14 to test aggregator-exclusion-at-v=1. Log this as R-14b in the risk register with "BLOCKER — Phase A kickoff" gate.
**Responsible:** Spec editor + Aggregator team + SDK team (must sign off jointly).

### C-3. Trustbase-loader single-mirror gap (Integration-Map surprise #4) lacks a dedicated task
**Where:** `impl/shared/trustbase-loader.ts` — Integration-Map §1 row flags "Currently returns a single embedded TrustBase per network. Multi-mirror design not yet reflected in loader interface." Plan tasks T-C3/T-C4 build `mirror-tofu.ts` + `trust-base-rotation.ts` but DO NOT edit `trustbase-loader.ts` itself.
**What's wrong:** The loader's interface is not multi-mirror-aware. Without an edit to `trustbase-loader.ts`, T-C3 has to implement its own multi-mirror trust-base resolution path in parallel with the existing loader — creating dual sources of truth. This violates H6 (shared trust-base across L4 + pointer).
**Correction:** Add new task T-C4b to the P-group C-3: "Extend `impl/shared/trustbase-loader.ts` to expose `getMirrorTrustBases(): Promise<RootTrustBase[]>` returning all mirrors' TrustBase values for cross-check; preserve existing `getEmbeddedTrustBase()` for single-mirror backward-compat. Contract must be idempotent across L4 PaymentsModule + pointer-layer callers (H6 shared-instance)." Depends on T-C3, T-C4; blocks T-D4.
**Responsible:** backend-architect.

### C-4. `OracleProvider.submitCommitment` signature mismatch (Integration-Map surprise #5) is not addressed in task acceptance
**Where:** Integration-Map §9.5 flags that `oracle.submitCommitment()` signature assumes a `TransferCommitment` with `sourceToken` — pointer commitments have no source token. Plan task T-C1 (aggregator-submit.ts) does not mention this.
**What's wrong:** Without an explicit acceptance criterion, T-C1 will consume `oracle.getAggregatorClient()` by default (the integration map's recommended path), but the plan never verifies this decision. If a reviewer naively wires T-C1 to `oracle.submitCommitment()`, the type system will reject it — but only at integration time (T-D1). Catching this in T-C1 acceptance saves a late cycle.
**Correction:** Amend T-C1 acceptance: "MUST consume `oracle.getAggregatorClient()` directly (returns `AggregatorClient` from `@unicitylabs/state-transition-sdk`); MUST NOT use `oracle.submitCommitment()` (which requires `sourceToken`, not applicable to raw pointer commitments). Unit test asserts `AggregatorClient.submitCommitment(request)` is called with a bare `SubmitCommitmentRequest` — not wrapped in `TransferCommitment`." Mirror change in T-C2 (`aggregator-probe.ts`).
**Responsible:** backend-architect (T-C1) + SDK integration reviewer.

### C-5. `--no-pointer` attack vector (Integration-Map surprise #10) has no task or mitigation
**Where:** Integration-Map §9.10 flags: "A malicious app on the same device could pass `--no-pointer` to silently desync. Recommend: `--no-pointer` MUST emit a loud one-time warning per wallet that is persisted; re-enabling must trigger a full recovery." Plan T-E4 adds the flag without any mitigation.
**What's wrong:** T-E4 currently disables the pointer layer silently. A malicious local process or CI fixture could silently desync a wallet by passing `--no-pointer` once, waiting for the BLOCKED flag to stay unset, then stealing tokens. No UI warning, no persisted "pointer was disabled" state, no re-enable recovery path.
**Correction:** Amend T-E4 acceptance: "(a) When `--no-pointer` is passed, write a persisted warning cell `POINTER_DISABLED_AT` = now() into `StorageProvider` for the active wallet. (b) Every subsequent `load()` call detects this cell and emits a `pointer:disabled_warning` event until explicitly re-enabled. (c) Re-enabling the pointer layer (next `init()` without `--no-pointer`) triggers a full pointer recovery BEFORE any local writes. (d) CLI prints a single-line warning `WARNING: Pointer layer disabled; cross-device anchoring not active. Re-enable to recover automatically.` to stderr on every invocation while disabled." Add new task T-E4b for the recovery-on-re-enable logic. Depends on T-D4.
**Responsible:** typescript-pro (CLI) + backend-architect (recovery-on-re-enable).

### C-6. Worker-threads mutex gap (Integration-Map surprise #12) has no mitigation in risk register or tasks
**Where:** Integration-Map §9.12 — "`proper-lockfile` guards against cross-process but NOT cross-thread within the same process. If any consumer runs Sphere in a Node worker_thread, the mutex is insufficient. Flag for v2." Plan §6 risk register has 16 risks; none covers worker_threads.
**What's wrong:** The risk is silently deferred to v2 without a tracking entry. A Node worker_thread consumer (agentsphere, orchestrator, any server-side SDK embed) can subvert the publish mutex and trigger OTP reuse. The plan must at minimum document + detect + fail-closed on worker_thread contexts.
**Correction:** Add R-17 to the risk register: "Worker-thread mutex gap — `proper-lockfile` is cross-process but not cross-thread. Node worker_thread consumers can subvert the mutex. v1 mitigation: T-B4 (Node mutex) detects `isMainThread === false` via `worker_threads` and refuses to initialize, raising `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME`. v2: expose thread-safe primitive (Atomics + SharedArrayBuffer) and re-enable." Add new sub-task to T-B4 acceptance: "MUST detect Node worker_thread context (via `require('worker_threads').isMainThread === false`) and raise `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME` at mutex acquisition." Add corresponding test to T-B8.
**Responsible:** typescript-pro (T-B4) + test-automator (T-B8).

### C-7. Gate for "every API method verified byte-for-byte against SPEC §13" is vague
**Where:** Phase D DONE criterion (plan line 495) — "API surface matches SPEC §13 method-for-method".
**What's wrong:** "Method-for-method" is vague. SPEC §13 has 9 methods plus TypeScript JSDoc contracts with preconditions, postconditions, and error-code enumerations. A literal method-name match would pass with empty stubs.
**Correction:** Rewrite gate criterion: "Conformance test `conformance/pointer/api-surface.test.ts` reflects SPEC §13 byte-for-byte: (a) all 9 method names present; (b) signatures type-check against SPEC-extracted `.d.ts` fixture; (c) every method's documented error-code enumeration is reachable per AST-grep (each error code appears in at least one throw path); (d) capability-gated methods (`acceptCarLoss`, `clearPendingMarker`, `acceptCorruptStreak`) raise `AGGREGATOR_POINTER_CAPABILITY_DENIED` when `allowOperatorOverrides` is absent." Add this as task T-E18b.
**Responsible:** security-auditor + test-automator.

### C-8. Agent-type misassignment: T-B3 + T-B4 mutex work is cross-process concurrency — requires security-auditor review
**Where:** Task T-B3 (browser Web Locks), T-B4 (Node `proper-lockfile`) assigned to `typescript-pro` only.
**What's wrong:** Mutex correctness is the load-bearing defense against OTP reuse (SPEC §7.1, §11.2, §7.1.1). The H3 finding (multi-mirror TOFU downgrade) and the crash-safety invariant both depend on correctness of these two files. Browser Web Locks API has well-known identity-switch bugs; `proper-lockfile` has stale-lock-timeout edge cases. Neither is vanilla TypeScript.
**Correction:** Add `security-auditor` as mandatory co-reviewer on T-B3, T-B4. Both must be signed off by security-auditor in addition to typescript-pro author. Update §5 agent-assignment table accordingly.
**Responsible:** Agent coordinator.

---

## §3 Warnings (should fix, not blocking)

### W-1. T-E4 CLI flag implementation: no `profile flush` command listed
**Where:** Integration-Map §6 table lists `sphere profile pointer flush` as an alias for `profile flush`. Plan §3 Phase E (line 262) says "`sphere profile flush` — exposes `publish()` (may already exist; verify)". Plan task list has no T-E for this command — it's only referenced informally.
**Correction:** Add task T-E4c: "Ensure `sphere profile flush` routes to `publish()`; add if missing. Required by N1, N2 scripts." Depends on T-D4.

### W-2. Per-parallel-group PR boundary (plan §10) breaks when two tasks in the same group edit the same file
**Where:** S11 slot has T-D3, T-D4, T-D7, T-D8, T-D9, T-D10, T-D11 concurrent. T-D11 edits `profile-token-storage-provider.ts`; T-D6 (S12 slot) edits the *same file*. S11 + S12 serialize naturally. But within S11, are T-D7–T-D11 truly parallel? They edit 5 different module files each — yes, non-overlapping. Check: T-D4 (ProfilePointerLayer.ts) + T-D5 (config.ts) — separate files, OK.
**Correction:** Add a pre-PR check: run `git diff --name-only` per-group before squash-merge; if any file appears in two tasks' diffs, serialize them. Document this in plan §10 "Commit Cadence".

### W-3. Risk R-14 ("PUBLISH_RETRY_BUDGET reset semantics") punts to "assume non-resetting" without a documented test
**Where:** Plan R-14 (line 399).
**Correction:** Add a conformance test to T-E18 Category P: "P9 — PUBLISH_RETRY_BUDGET never resets across publish() invocations; remains a 'consecutive conflict-retries' counter that decrements on retry and resets only on success. Mock aggregator returns CONFLICT 5 times → first 4 retries consume budget, 5th raises `AGGREGATOR_POINTER_RETRY_EXHAUSTED`." This locks the semantic in CI without waiting for spec owner response.

### W-4. Plan §7 O-2 (RootTrustBase source) is marked "unresolved by Phase-D start → ship static-bundled v1" — no CI check
**Where:** Risk R-3 (line 388).
**Correction:** Add CI check to T-A10 (`.github/workflows/pointer-vectors.yml`): "Verify that `RootTrustBase` source-type constant in `constants.ts` matches a single pre-declared value ('static' | 'remote' | 'hybrid') — fails if 'TBD' or missing." Prevents silent ship.

### W-5. Plan §3 Phase B deliverable list conflates `mutex-lock.ts (browser)` and `(Node)` as one file — but they're separate platform-specific backends
**Where:** Plan §3 Phase B line 182 / §4 T-B3, T-B4.
**Correction:** Clarify file naming: `mutex-lock.ts` exports platform-agnostic interface; `mutex-lock.browser.ts` and `mutex-lock.node.ts` contain backends. tsup is configured for conditional exports per platform. Update Phase B deliverables block and acceptance criteria in T-B3/T-B4 to reflect three files instead of one.

### W-6. DM-protocol, peer-discovery via Nostr gossipsub (integration-map §2.2) is handwaved in plan
**Where:** Plan's aggregator-probe + car-loss-tracker reference peer-availability poll but not the gossipsub subscription path.
**Correction:** Add subtask to T-C5: "Integrate with `NostrTransportProvider` for `POINTER_PEER_DISCOVERY_MS` poll — reuse existing gossipsub subscription, no new transport." Add integration test: "CAR loss tracker polls gossipsub; a peer advertisement aborts `acceptCarLoss()` with `pointer:car_loss_aborted_peer_found`."

### W-7. BLOCKED flag multi-address scope (integration-map §9.8) is undefined in plan
**Where:** Integration-map §9.8 flags open question: "CLI's `profile pointer status` must report per-active-address. Do we also support querying all addresses at once?"
**Correction:** Decide: default `profile pointer status` reports active-address only. Add `--all-addresses` flag for multi-address query. Amend T-E1 acceptance accordingly.

### W-8. Originated-tag stamping during replication (integration-map §9.7) requires adapter-level refactor, not a hook
**Where:** Plan T-D7–T-D11 stamp at CALLER site. Integration-map §9.7 flags: "Current `onReplication` callbacks fire AFTER entries are already persisted locally — which means the stamping must be upstream of persistence."
**Correction:** Add a new task T-D11b: "Refactor `profile/orbitdb-adapter.ts` `onReplication` to fire the originated-tag downgrade BEFORE persistence to local OpLog; reject entries that fail D5 semantic re-validation pre-persistence. Current post-persistence hook is insufficient (replicated entry lands locally with stale 'user' tag for a window)." backend-architect.

### W-9. Integration-Map surprise #1 (TokenRegistry-like bundle duplication for trust-base constants) is listed but not a task
**Where:** Integration-Map §9.1 flags risk that `constants.ts` bundle duplication may fork `MIRROR_LIST_SHA256` across bundles.
**Correction:** Add acceptance to T-A1: "`MIRROR_LIST_SHA256` and `MIRROR_CERT_PINS` are exported from a SINGLE top-level `constants.ts`, not duplicated across bundles. Import-path test asserts all consumers reach the same constant (identity equality, not structural)."

### W-10. Conformance test P1 (proof-verify-always) requires instrumentation, but T-E18 has no instrumentation task
**Where:** TEST-SPEC Category P1 requires counting `InclusionProof.verify()` calls across 100 scenarios. Plan T-E18 is "AST-grep based + KAT vectors" — AST-grep alone can't verify runtime call counts.
**Correction:** Amend T-E18 acceptance: "P1 requires an instrumented proxy wrapping `InclusionProof.verify` that records call counts. Test harness asserts ≥ 1 verify call per scenario that reads aggregator data. Instrumentation is a vitest setup fixture, not an AST-grep check."

### W-11. Release cadence (plan §10.6) assumes O-2 + O-6 + O-7 resolved 2 weeks before GA — no go/no-go checkpoint
**Where:** Plan §10.6 "v1.0.0 after O-2 + O-6 + O-7 resolved + 2-week field soak."
**Correction:** Add explicit go/no-go: "A release manager signs off after: (a) O-2 resolved with documented source-type; (b) O-6 signed off with finalized mirror list; (c) O-7 artifacts in CI canary for 2 weeks without failure; (d) 0 Category-P regressions in 2 weeks; (e) 2 consecutive green nightly N-series runs." Document in `docs/uxf/RELEASE-GATES.md`.

---

## §4 Per-lens findings

### Lens 1: Plan ↔ Integration Map consistency
Integration Map flagged 5 surprises: ARCH/TEST-SPEC IPNS contradiction (#2), single-mirror trustbase-loader (#4), `OracleProvider.submitCommitment` signature mismatch (#5), `--no-pointer` attack vector (#10), worker_threads mutex gap (#12). **All 5 acknowledged in plan's §6 or §7, but only #5 has an implicit mitigation (via `oracle.getAggregatorClient()` default) and none has an atomic task.** Corrections C-2 through C-6 address all 5 — add them before Phase A.

### Lens 2: Plan ↔ Spec coverage
Spot-checks:
- SPEC §13 API — 9 methods — plan T-D4 acceptance lists "verbatim signatures" but no test file asserts match. Remediated by C-7.
- SPEC §12 — 29 `AGGREGATOR_POINTER_*` + `SECURITY_ORIGIN_MISMATCH` = 30 — T-A2 says 23. Remediated by C-1.
- SPEC §3 constants — mostly covered, but `MARKER_MAX_JUMP`, `MIN_MIRROR_COUNT`, `MAX_CT_RESIDENT_MS`, `CID_MAX_BYTES`, `VERSION_MIN`, `VERSION_MAX` — all in T-A1 acceptance.
- SPEC §8.4.1 trust-base rotation → T-C4. OK.
- SPEC §11.12 denylist → T-A8. OK.
- SPEC §10.8 corrupt-streak bail → T-D2, T-E15 OK.
- SPEC §7.1.4 MARKER_MAX_JUMP clamp → T-B2 acceptance. OK.
- SPEC §11.11(a′) `MAX_CT_RESIDENT_MS = 500` ciphertext zeroization — **NOT EXPLICITLY IN ANY TASK** (W-12 below).
- SPEC §10.2.6 deleted in v3.2 (replaced by D1/§10.8) — plan does not reference the obsolete §10.2.6. OK.

**New Warning W-12:** Add acceptance to T-A6 or T-C1: "`MAX_CT_RESIDENT_MS = 500` enforced: retry-window ciphertext buffers are scheduled for zeroization via `setTimeout(zero, 500)` after creation. Unit test asserts ciphertext buffer contents are zeroed after 500ms."

### Lens 3: Plan ↔ Test-Spec coverage
Phase E tasks map 1:1 to categories A–P. Category P1 requires runtime instrumentation not covered by AST-grep (W-10). H3-R has sub-cases A/B/C — T-C10 lists all three. K1–K10 → T-E9. M17 → T-E17 + R-7 tier-2 flag. Token Conservation Invariant harness → T-E21. Coverage-matrix audit → T-E23. **H11 "reserved" slot** (TEST-SPEC line 450) is flagged in plan R-17's open questions but no task removes it. Acceptable — leave as-is, it's a spec editorial issue.

### Lens 4: Parallelization feasibility
Walking the dependency graph in §8:
- S8 (6 agents) concurrent on T-C1, T-C2, T-C3, T-C5, T-C6, T-C7 — all different files, no overlap. OK.
- S11 (6 agents) concurrent on T-D3, T-D4, T-D7, T-D8, T-D9, T-D10, T-D11 — seven tasks listed, but only 6 agents. Minor mis-count in plan. T-D7–T-D11 edit 5 different modules; T-D3 edits reconcile-algorithm.ts; T-D4 edits ProfilePointerLayer.ts. No file overlap.
- **HIDDEN DEPENDENCY:** T-D3 + T-D4 both depend on stable types from T-A3. If T-A3 amended late in Phase A (e.g., to fix C-1), T-D3/T-D4 blocked.
- **HIDDEN DEPENDENCY:** T-D11 (edits `profile-token-storage-provider.ts`) overlaps with T-D6 (same file, different slot S12). Per W-2, natural serialization.

**Peak concurrency: 7 agents at S15** — plausible. 6 test-automators + 1 other.

### Lens 5: Task granularity
Tasks are mostly atomic. A few too-coarse:
- T-C1 "All 13 rows of §7.3 outcome matrix" — could be 3–4 separate tasks if §7.3 rows are implemented in groups.
- T-E17 "M1–M5, M8–M15, M17" — 13 scenarios in one task. Split into M1–M5 (basic), M8–M12 (multi-device), M13–M15 + M17 (JOIN rules / double-spend).
**Correction optional:** Split T-E17 into T-E17a, T-E17b, T-E17c.

Too-fine: none found.

### Lens 6: Agent-type fitness
- **T-B3, T-B4** (mutex) — `typescript-pro` only; should include `security-auditor` co-review. See C-8.
- **T-C5** (car-loss-tracker) — `backend-architect`; acceptable but includes wall-clock-enforced 24h window which touches security invariants. Consider adding security-auditor sign-off on acceptCarLoss gating logic.
- **T-E18** (Category P conformance) — `security-auditor + test-automator`, correct.
- **T-D6** (wiring edit) — `backend-architect`, correct.
- **T-E19, T-E20** (bash scripts) — `bash-pro`, correct per CLAUDE.md and TEST-SPEC §5.1 strict-mode requirement.
- **T-E24** (runbook) — `documentation-generation:architecture-decision-records`, correct.

### Lens 7: Risk register completeness
Missing risks identified:
- Worker-thread mutex gap (C-6).
- R-14b: IPNS contradiction stop-the-line (C-2).
- R-17: OracleProvider single-point-of-failure via `getAggregatorClient()` undefined return (weakening of V11 integration).
- R-18: Agent coordinator conflict on shared files — W-2 addresses technically; add as risk for clarity.
- R-19: Concurrency hazard — `profile/orbitdb-adapter.ts` onReplication pre-persistence refactor (W-8) may regress existing profile tests.
- R-20: Sphere.destroy() mutex cleanup (integration-map §9.6) has no task — it's a line in T-B3/T-B4 acceptance but not named. Add explicit test.

### Lens 8: Gate criteria objectivity
Most Phase DONE criteria are specific (test names, file paths, AST-grep rules). A few vague:
- Phase B DONE "B1–B11 scenarios (crash safety) all pass" — tight, OK.
- Phase C DONE "IPFS client enforces H10 progress-rate timeouts + D6 streaming byte-cap + rejects `Content-Encoding`" — OK (specific).
- Phase D DONE "API surface matches SPEC §13 method-for-method" — vague. See C-7.
- Phase E DONE "Token Conservation Invariant harness never violated across suite" — OK.

### Lens 9: Commit / PR cadence realism
Per-parallel-group PRs. Feasible except W-2 (same-file overlap in S11 vs S12). Plan explicitly addresses that T-D6 precedes T-D11 — good. Branch-protection rules are tight. `chore(pointer)` scope used for infra — matches CLAUDE.md.

### Lens 10: Open questions disposition
Three plan-flagged + one integration-map-flagged:
- R-14 (PUBLISH_RETRY_BUDGET reset) — **non-blocking for Phase A**; lock via test W-3.
- R-15 (H6 OracleProvider.getPinnedTrustBase getter) — **non-blocking**; addressed by T-C7.
- H11 reserved slot — **non-blocking**; editorial.
- IPNS contradiction (integration-map surprise #2) — **BLOCKING Phase A kickoff**. See C-2.

---

## §5 Task-ID corrections table

| Task ID | Current | Correction needed | Severity |
|---|---|---|---|
| T-A2 | "All 23 error codes + `SECURITY_ORIGIN_MISMATCH`" | "All 29 `AGGREGATOR_POINTER_*` codes + `SECURITY_ORIGIN_MISMATCH` (30 total); per SPEC §12 table row-for-row" | CRITICAL |
| T-B3 | Agent: `typescript-pro` | Add `security-auditor` co-review | CRITICAL |
| T-B4 | Agent: `typescript-pro` | Add `security-auditor` co-review; detect `worker_threads` main-thread check | CRITICAL |
| T-C1 | "wraps `AggregatorClient.submitCommitment`" | Explicit: "MUST consume `oracle.getAggregatorClient()`; MUST NOT use `oracle.submitCommitment()`" | HIGH |
| T-C3 | "integrates with `MIRROR_LIST_SHA256`" | Add dependency on T-C4b `getMirrorTrustBases()` | HIGH |
| T-D4 | "SPEC §13 verbatim signatures" | Add: "runtime capability-gate raises `AGGREGATOR_POINTER_CAPABILITY_DENIED`" + byte-for-byte `.d.ts` extract match | HIGH |
| T-D6 | Line ranges "279 + 879 + delete 975–1046" | IF C-2 lands (b): do not delete, wrap in `if (config.pointer.enabled)` branch | CRITICAL (dep on C-2) |
| T-E4 | "falls back to legacy IPNS path (for N14)" | Rewrite per C-2 outcome + C-5 (persist warning, re-enable recovery) | CRITICAL |
| T-E17 | "M1–M5, M8–M15, M17" | Split into T-E17a/b/c per Lens 5 | LOW (optional) |
| T-E18 | "P1–P8; P4/P5 via AST-grep" | Add P1 runtime instrumentation harness (not AST-grep) | HIGH |
| T-E18 | Missing P9 test | Add P9 (PUBLISH_RETRY_BUDGET never resets) per W-3 | MED |
| T-E22 | CI canary pins SDK version range | Add: "fails if `RootTrustBase` source-type constant is 'TBD'" | MED |

---

## §6 New tasks required

| Task ID | Phase | P-group | File path | Agent | Depends on | Acceptance | SPEC ref |
|---|---|---|---|---|---|---|---|
| **T-A1b** | A | A-1 | `constants.ts` (edit) | typescript-pro | T-A1 | `MIRROR_LIST_SHA256` / `MIRROR_CERT_PINS` exported from single bundle; no duplication across tsup entry points (import-path test) | §3, W-9 |
| **T-A6b** | A | A-2 | `profile/aggregator-pointer/payload-codec.ts` (edit) | security-auditor | T-A6 | `MAX_CT_RESIDENT_MS = 500` ciphertext zeroization via scheduled cleanup | §11.11(a′), W-12 |
| **T-B4b** | B | B-2 | `profile/aggregator-pointer/mutex-lock.node.ts` (edit) | typescript-pro + security-auditor | T-B4 | Detect `worker_threads.isMainThread === false`; raise `AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME` | §7.1.1, C-6 |
| **T-C4b** | C | C-3 | `impl/shared/trustbase-loader.ts` (edit) | backend-architect | T-C3, T-C4 | Expose `getMirrorTrustBases(): Promise<RootTrustBase[]>`; preserve `getEmbeddedTrustBase()` backward-compat | §8.4, H6, C-3 |
| **T-D11b** | D | D-5 | `profile/orbitdb-adapter.ts` (edit) | backend-architect | T-B6, T-D10 | `onReplication` fires BEFORE local persistence; rejects D5 mismatches pre-persistence | §10.2.3, W-8 |
| **T-E4b** | E | E-1 | `cli/index.ts` (edit) + `core/Sphere.ts` (edit) | typescript-pro | T-E4, T-D4 | `--no-pointer` persists `POINTER_DISABLED_AT` cell; re-enable triggers full pointer recovery before writes; stderr warning | C-5, W-9.10 |
| **T-E4c** | E | E-1 | `cli/index.ts` (edit) | typescript-pro | T-D4 | `sphere profile flush` routes to `publish()`; verified or added | TEST-SPEC N1, N2, W-1 |
| **T-E18b** | E | E-4 | `tests/conformance/pointer/api-surface.test.ts` | security-auditor + test-automator | T-D4 | Extract `.d.ts` from SPEC §13; assert byte-for-byte match; capability-gate unreachability tests | §13, C-7 |
| **T-E18c** | E | E-4 | `tests/conformance/pointer/retry-budget.test.ts` | test-automator | T-D3 | P9: PUBLISH_RETRY_BUDGET never resets; locks R-14 semantic | §9.4, W-3 |
| **T-E19b** | E | E-5 | `tests/e2e/pointer-N-review.md` (note) | bash-pro | (C-2 resolution) | Reconcile N14 script with C-2 outcome: either deleted, rewritten as aggregator-exclusion-at-v=1, or retained with IPNS fallback path | TEST-SPEC N14 |
| **T-RISK-1** | PreA | (blocker) | `docs/uxf/PROFILE-AGGREGATOR-POINTER-SPEC.md` (discussion) | spec-editor + aggregator-team + SDK-team | — | Resolve IPNS / N14 contradiction (C-2); sign off on one of three options | C-2 |

**Net: 10 new tasks; total = 67.** Effort increase: ~8 person-days; critical-path latency unchanged (all but T-RISK-1 are within-phase parallel to existing tasks).

---

## §7 Approved-for-Phase-A checklist

Before Phase A kickoff is approved, all of the following MUST be green:

- [ ] **C-1 resolved:** T-A2 acceptance updated to "30 error codes" with row-by-row SPEC §12 assertion test.
- [ ] **C-2 resolved:** IPNS / N14 contradiction — spec-editor + Aggregator team + SDK team sign off on one of three options; T-D6, T-E4, T-E19 rewritten accordingly. **BLOCKER.**
- [ ] **C-3 planned:** T-C4b added (multi-mirror trustbase loader).
- [ ] **C-4 planned:** T-C1 acceptance amended to mandate `oracle.getAggregatorClient()` path.
- [ ] **C-5 planned:** T-E4 amended + T-E4b added (persisted disable warning + re-enable recovery).
- [ ] **C-6 planned:** T-B4b added (worker_thread detection); R-17 logged in risk register.
- [ ] **C-7 planned:** T-E18b added (API-surface conformance test).
- [ ] **C-8 resolved:** T-B3, T-B4 agent roster updated to include `security-auditor` co-reviewer.
- [ ] **Risk register updated:** R-17 through R-20 added per Lens 7.
- [ ] **Agent coordinator briefed:** W-2 file-overlap check is automated pre-PR.
- [ ] **T-A1b added:** bundle duplication check for `MIRROR_LIST_SHA256`.
- [ ] **Vector O-1 handoff confirmed:** SDK team has committed owner + ETA for `test-vectors.json` (T-A9); CI canary (T-A10) placeholder is in `main`.
- [ ] **O-6 / O-7 escalated:** Infra team has acknowledged mirror list + `MIRROR_LIST_SHA256` + `MIRROR_CERT_PINS` artifact deliverables with committed ETA; plan R-3/R-4/R-5 mitigations are current.

**Phase A may begin concurrently with C-2 resolution**, provided all Phase A tasks are self-contained to derivation primitives and do NOT reference IPNS. T-D6, T-E4, T-E19 are Phase D/E tasks and gated on C-2.

---

**End of audit. Re-review required if C-1 through C-8 corrections introduce structural changes beyond §5/§6 task-IDs.**
