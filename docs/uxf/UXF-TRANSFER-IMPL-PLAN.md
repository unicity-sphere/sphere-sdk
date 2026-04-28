# UXF Transfer Implementation Plan

> Companion document to [`UXF-TRANSFER-PROTOCOL.md`](UXF-TRANSFER-PROTOCOL.md). The protocol spec is the contract; this plan structures the work into PR-sized tasks for parallel execution. References of the form "§N.N" point at the canonical protocol unless prefixed (PA = PROFILE-ARCHITECTURE.md, OL = PROFILE-OPLOG-SCHEMA.md, INV = SDK-STORAGE-INVENTORY.md, DD = DESIGN-DECISIONS.md, API = docs/API.md).

> **Revision history**: this is the v2 plan, post-audit. Five specialist agents (architect, specs writer, refactoring, security auditor, Unicity expert) produced 13 critical + ~25 warning + ~15 note findings; the spec was corrected in two places (race-lost detection via `REQUEST_ID_EXISTS` + poll mismatch; `§6.1.1` cascade split into coin-class via `splitParent` walk vs NFT-class via outbox-driven notification). This plan reflects every applied finding. The task count grew from 38 → 49 with new sub-tasks (T.5.B.0, T.5.B.5, T.6.D.2, T.7.B.5, T.7.C.5, T.5.F, T.1.B.1/2, T.3.B.1/2, T.8.E.1/2/3, T.2.D.1/2).

---

## §1 Overview & critical path

### Goal

Land §13 waves T.1–T.8 of the inter-wallet transfer protocol behind a feature-flag config object (not a single boolean), in a way that lets multiple agents work in parallel and lets us cut over from the legacy single-coin TXF send path to the bundle-grained UXF path without a flag day.

### Architectural core (load-bearing)

Three artifacts gate every other task:

1. **Wire-format types** (`types/uxf-transfer.ts`, NEW) — `UxfTransferPayload` discriminated union, `DeliveryStrategy`, the widened `TransferMode = 'instant' | 'conservative' | 'txf'` (PUBLIC: `'instant' | 'conservative'`; INTERNAL: `'instant' | 'conservative' | 'txf'` — see Note N8), `DispositionReason` (now includes `'client-error'`), `AuditStatus`. Anything that encodes, decodes, persists, queues, or dispatches a transfer touches these types.
2. **Profile key mapping extension** (`profile/types.ts` `PROFILE_KEY_MAPPING`) — adding `audit` (NEW), `finalization_queue` (NEW), and the multi-representation key form for `invalid` (widened) MUST land before any disposition writer can target those collections. **`Sphere.clear()` reaches these via parent storage clear**, not a mapping table — see W46.
3. **OrbitDB CRDT primitives** (`profile/profile-token-storage-provider.ts`) — the per-tokenId mutex / CAS pathway and the Lamport-clock writer for `UxfTransferOutboxEntry` are the bedrock for §5.5 step 9 and §7.1 conflict resolution.

These three items are the **critical path**. Everything else parallelizes off them.

### Wave topology

```
T.1 (foundations: types + key-mapping + OrbitDB primitives + constants module)
 │
 ├───────────────────────┬──────────────────────┬─────────────────────┐
 │                       │                      │                     │
 ▼                       ▼                      ▼                     ▼
T.2 (sender              T.3 (recipient ingest  T.6 (outbox refactor  T.8.tests-prep
     conservative             + decision matrix       + CRDT semantics       (fixtures,
     UXF + delivery           + _audit/_invalid       + legacy migration     adversarial
     strategy)                multi-rep storage       + restore script)      scaffolding)
                              + continuity walker)    │                     │
 │                       │                       │                     │
 │                       ▼                       │                     │
 │                  T.4 (CID-pin delivery)       │                     │
 │                       │                       │                     │
 └───────────────────────┴───────────┬───────────┘                     │
                                     │                                 │
                                     ▼                                 │
                        T.5 (instant mode + finalization workers       │
                              + cascade walker (per-class)             │
                              + trustBase staleness)                   │
                              │                                        │
                              ▼                                        │
                        T.7 (TXF as opt-in; legacy adapter ───────────┘
                              receiver-side; production
                              call-site migration; ConnectHost
                              external-repo coordination)
                              │
                              ▼
                        T.8 (capability hints, error surfacing,
                              chain-mode integration tests, rollout)
```

### Critical path (longest serial chain) — VERIFIED

The architect computed the real longest serial chain (15 PRs):

```
T.1.A  (UxfTransferPayload + DeliveryStrategy)
  ↓
T.1.B  (TransferMode/TransferRequest widening — split into B.1+B.2)
  ↓
T.1.E  (PROFILE_KEY_MAPPING extension)
  ↓
T.1.F  (Lamport + mutex + CAS primitives — all 3 strategies)
  ↓
T.6.A  (UxfTransferOutboxEntry per-entry-key writer)
  ↓
T.6.B  (CRDT merger: status partition + override + two-set requestIds)
  ↓
T.5.A  (instant-sender orchestrator)
  ↓
T.5.B  (sender-side finalization worker)
  ↓
T.5.B.5 (cascade walker — per-class coin/NFT)              [NEW]
  ↓
T.5.C  (recipient-side finalization worker)
  ↓
T.5.D  (importInclusionProof + revalidateCascadedChildren)
  ↓
T.7.A  (TXF sender)
  ↓
T.7.B  (legacy receiver adapter)
  ↓
T.7.E  (default-mode flip)
  ↓
T.8.D  (production cutover)
```

That's **15 PRs** wall-clock (counted: T.1.A, T.1.B, T.1.E, T.1.F, T.6.A, T.6.B, T.5.A, T.5.B, T.5.B.5, T.5.C, T.5.D, T.7.A, T.7.B, T.7.E, T.8.D). With 4 senior agents working in parallel on independent lanes, total is **~18–22 days**. With 2 agents, **~6–7 weeks**.

> Note: prior plan cited a 10-PR critical path which omitted T.1.E, T.1.F, T.5.B.5, and T.7.B. The 15-PR chain is the correct figure; §3 parallelization map and the appendix are aligned to it.

### Feature flag config (replaces single boolean)

`UXF_TRANSFER_V1` is now a **feature config object** (not a boolean), exposed via env vars + `Sphere.init({ features })`:

```typescript
interface UxfTransferFeatures {
  readonly typesWidening: boolean;          // T.1.B.1 — type-level only, default true after T.1.B.1 merges
  readonly senderUxf: boolean;              // T.2.D — route conservative sends through UXF
  readonly recipientUxf: boolean;           // T.3 — accept UXF inbound
  readonly cidDelivery: boolean;            // T.4 — enable CID path
  readonly instantMode: boolean;            // T.5 — enable instant-mode workers
  readonly outbox: 'legacy' | 'dual-write' | 'uxf';  // T.6 — outbox storage mode
  readonly txfOptIn: boolean;               // T.7.A — accept transferMode:'txf'
  readonly defaultModeIsUxf: boolean;       // T.7.E — flip the default
}
```

| Phase | Setting | Effect |
|---|---|---|
| T.1 lands | `{typesWidening:true, ...all false}` | Compile-time only; runtime unchanged. |
| T.2/T.3/T.4 lands | senderUxf/recipientUxf/cidDelivery=false default | Code on disk; opt-in. |
| T.5/T.6 lands | instantMode=false default; outbox='legacy' default | Same; testnet opt-in. |
| Pre-cutover | outbox='dual-write' (formalized in §7.0 outbox state machine, T.6.D dual-write mode) | Migration safety. |
| T.8.D | Legacy code removed; flag becomes vestigial | Cutover. |

Per-feature flags allow staged enablement and surgical rollback (revert one flag, not all). See W42.

---

## §2 Wave breakdown (T.1 through T.8)

Each task lists `id, title, wave, files_touched, depends_on, parallel_with, skill_tag, acceptance, est_loc, risks, spec_refs`. `est_loc` is a senior-eng estimate including tests.

### T.0 — Pre-T.1 prerequisites

> **Round-2 W5 split**: the original single T.0.G7-prereq carried a 5x scope-creep risk (80→400 LOC if G.7 is incomplete). Split into T.0.G7-verify (test-only, fails fast) and T.0.G7-fill-gaps (conditional, lands only if verify fails). Honest about the worst case.

#### T.0.G7-verify — Wave G.7 per-entry-key layout verified on `main` (test-only)

- **wave**: T.0 (prerequisite, lands BEFORE T.1)
- **files_touched**:
  - `tests/unit/profile/wave-g7-prereq.test.ts` (NEW, ~80 LOC) — assertions that:
    - `profile/profile-token-storage-provider.ts` exposes the per-entry-key writer used at runtime to expand `{addr}.outbox` → `${addr}.outbox.${id}` (and similarly for `audit`, `invalid`, `finalizationQueue`).
    - `profile/profile-storage-provider.ts`'s dynamic-key matcher recognizes prefix-scan queries `${addr}.outbox.*`.
    - Round-trip a synthetic per-entry-key record and prove it survives the OrbitDB → KV translation.
- **depends_on**: (none — this is the entry point)
- **parallel_with**: (lands first; serialized)
- **skill_tag**: `storage`
- **acceptance**:
  - If all 4 prefix-scan key shapes (`{addr}.outbox.*`, `{addr}.audit.*`, `{addr}.invalid.*`, `{addr}.finalizationQueue.*`) pass round-trip on `main`: this task lands the test only.
  - If any fail: this task fails CI and `T.0.G7-fill-gaps` becomes a hard prerequisite for T.1.E.
- **est_loc**: 80
- **risks**: low — pure verification; either passes (T.0.G7-fill-gaps not needed) or fails clearly.
- **spec_refs**: §7 (outbox key shape); PROFILE-ARCHITECTURE.md §10.12.

#### T.0.G7-fill-gaps — Land missing per-entry-key writers (CONTINGENT — only materializes if T.0.G7-verify fails)

> **Round-3 N1 semantics**: this task is CONTINGENT. If T.0.G7-verify passes (all 4 prefix-scan key shapes already work on `main`), T.0.G7-fill-gaps is dropped from the schedule entirely — implementers proceed directly from T.0.G7-verify to T.1.E. If T.0.G7-verify fails, T.0.G7-fill-gaps becomes a hard prerequisite for T.1.E and adds 1–3 days to the critical path. The dep edge `T.1.E depends_on T.0.G7-fill-gaps` is conditional in CI/scheduling — it materializes only when verify reports FAIL.

- **wave**: T.0 (prerequisite, lands ONLY if T.0.G7-verify fails)
- **files_touched** (estimated; exact files depend on what verify exposes):
  - MODIFIED: `profile/profile-token-storage-provider.ts` — extend per-entry-key writer to cover any missing collections (`audit`, `invalid` multi-rep, `finalizationQueue`).
  - MODIFIED: `profile/profile-storage-provider.ts` — extend dynamic-key matcher to recognize new prefixes.
  - NEW: `tests/unit/profile/per-entry-key-writers.test.ts` — round-trip tests per missing writer.
- **depends_on**: T.0.G7-verify (with FAIL outcome).
- **parallel_with**: (none — must merge before T.1.E).
- **skill_tag**: `storage`
- **acceptance**:
  - All 4 prefix-scan key shapes pass round-trip after this task.
  - Re-running T.0.G7-verify on the same commit passes.
- **est_loc**: 0–400 (CONDITIONAL — only LOC if verify fails). Range = 0 (best case: G.7 complete) to ~400 (worst case: 4 collections missing writers).
- **risks**: blocks T.1.E if it triggers; could add 1–3 days to the critical path under worst case.
- **spec_refs**: §7; PROFILE-ARCHITECTURE.md §10.12.

---

### T.1 — Wire-format types (foundation)

T.1 lands the types, enums, key-mapping rows, and constants module. Nothing in T.1 changes runtime behavior — call-sites still hit the legacy path. T.1 unblocks T.2/T.3/T.6 in parallel.

---

#### T.1.A — `UxfTransferPayload` discriminated union + `DeliveryStrategy`

- **wave**: T.1
- **files_touched**:
  - NEW: `types/uxf-transfer.ts` (~150 LOC) — `UxfTransferPayload`, `UxfTransferPayloadCar`, `UxfTransferPayloadCid`, `LegacyTokenTransferPayload`, `DeliveryStrategy`.
  - MODIFIED: `types/index.ts` (re-export from `uxf-transfer`).
  - NEW: `tests/unit/types/uxf-transfer.types.test.ts` (compile-time + runtime guard tests).
- **depends_on**: none.
- **parallel_with**: T.1.C, T.1.D, T.8.A (fixtures scaffold).
- **skill_tag**: `types`
- **acceptance**:
  - `UxfTransferPayload` discriminated on `kind: 'uxf-car' | 'uxf-cid' | 'legacy'`; `version: '1.0'`; `mode: 'conservative' | 'instant'`.
  - `DeliveryStrategy` = `{kind:'auto', inlineCapBytes?:number} | {kind:'force-inline'} | {kind:'force-cid'}`.
  - `isUxfTransferPayload(value): value is UxfTransferPayload` runtime guard returns `false` on null/undefined/missing fields.
  - `isLegacyTokenTransferPayload(value)` recognizes all four legacy shapes (§3.4).
  - Discriminator narrowing demonstrated in a TypeScript fixture file (compile-only test). See Note N7 — fixtures bracket the V6 `COMBINED_TRANSFER` and V5 `INSTANT_SPLIT` shapes.
  - `payload.sender.nametag` field is documented as **untrusted on wire** (re-resolution required at receive — see T.7.B.5).
- **est_loc**: 220.
- **risks**: legacy shape detection ambiguity (V5 INSTANT_SPLIT and V6 COMBINED_TRANSFER overlap on some keys) — write detector with version-precedence rules, document precedence inline.
- **spec_refs**: §3.1, §3.2, §3.3, §3.3.1, §3.4, §5.6, §9.3.

---

#### T.1.B.1 — Public-API type widening + per-call-site narrow-or-throw shims

- **wave**: T.1
- **files_touched**:
  - MODIFIED: `types/index.ts` (`TransferMode`, `TransferRequest` widening per §10.1). Public `TransferMode = 'instant' | 'conservative'`; INTERNAL `InternalTransferMode = 'instant' | 'conservative' | 'txf'` (Note N8).
  - NEW: `types/asset-target.ts` (~50 LOC) — `AdditionalAsset`, `AssetTarget` discriminated unions.
  - NEW: `modules/payments/transfer/transfer-mode-shims.ts` (~120 LOC) — per-call-site shim that narrows public `TransferMode` to `InternalTransferMode` or throws `UNSUPPORTED_TRANSFER_MODE`. **Used by EVERY call-site flagged by `tsc --strict`** so the widening lands without a rupture.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — invoke shim at entry; do NOT route the new path yet.
  - MODIFIED: `cli/index.ts:2831` (the `transferMode = forceConservative ? 'conservative' : 'instant'` assignment retains semantics; add explicit union annotation).
  - MODIFIED: any other site flagged by `tsc` exhaustiveness (target audit list — see Migration §6.B).
  - NEW: `tests/unit/payments/transfer-mode-widening.test.ts` — verifies `'txf'` is rejected with the typed error pre-T.7 (shim works).
- **depends_on**: T.1.A.
- **parallel_with**: T.1.C, T.1.D.
- **skill_tag**: `types`
- **acceptance**:
  - `TransferRequest` declares `coinId?: string`, `amount?: string`, `additionalAssets?: ReadonlyArray<AdditionalAsset>`, `allowPendingTokens?: boolean`, `confirmNftPending?: boolean`, `delivery?: DeliveryStrategy`, `txfFinalization?: 'instant' | 'conservative'`.
  - `AdditionalAsset = {kind:'coin', coinId, amount} | {kind:'nft', tokenId}` per API.md `send` widening.
  - `tsc --strict` passes after T.1.B.1 lands; **no `as any` casts**. The shim file is the only place that does the runtime narrow.
  - `payments.send({ transferMode: 'txf', ... })` rejects with `UNSUPPORTED_TRANSFER_MODE` (placeholder until T.7.A).
- **est_loc**: 320 (was 280; the +40 accounts for shim file + per-call-site test).
- **risks**: hidden exhaustiveness check in third-party code (e.g., agentsphere, sphere app) — gate by exporting the enum and adding a release note (W1).
- **spec_refs**: §10.1, §4.1 step 1, API.md `send`.

---

#### T.1.B.2 — Audit shim removal (post-T.7.C)

- **wave**: T.7 (lands AFTER T.7.C migrates production call-sites)
- **files_touched**:
  - MODIFIED: `modules/payments/transfer/transfer-mode-shims.ts` — remove shims that were replaced by explicit `transferMode` passes; document residual shims (TXF arm, internal-only mode).
  - NEW: `tests/unit/payments/transfer-mode-shims-residue.test.ts` — assert each remaining shim is gated by a comment + reason.
- **depends_on**: T.7.C.
- **parallel_with**: T.7.D, T.7.E.
- **skill_tag**: `cleanup`
- **acceptance**:
  - Shim file shrinks; only INTERNAL-only narrowings remain.
  - PR is no-net-LOC (deletes ~150 LOC, adds ~30 LOC of comments).
- **est_loc**: 80.
- **risks**: a missed call-site reaches the shim and rejects unexpectedly — guarded by T.8.E full integration suite.
- **spec_refs**: §10.1.

---

#### T.1.C — `DispositionReason` and `AuditStatus` enums; `InvalidEntry` / `AuditEntry` records

- **wave**: T.1
- **files_touched**:
  - NEW: `types/disposition.ts` (~140 LOC) — `DispositionReason`, `AuditStatus`, `InvalidEntry`, `AuditEntry`, `ManifestEntry` (re-exporting the augmented version from PA §10.11).
  - MODIFIED: `types/index.ts` (re-export).
  - NEW: `tests/unit/types/disposition.test.ts` — enum stability snapshot (the spec uses these strings on disk; renaming = migration). **ADR snapshot test for DispositionReason enum strings (Note N2).**
- **depends_on**: T.1.A.
- **parallel_with**: T.1.B.1, T.1.D.
- **skill_tag**: `types`
- **acceptance**:
  - `DispositionReason` covers exactly the 14 strings in §5.4 (the original 13 plus the new `'client-error'` per spec correction): `structural | predicate-eval | auth-invalid | continuity-broken | proof-invalid | proof-throw | oracle-rejected | belief-divergence | parent-rejected | race-lost | not-our-state | off-record-spend | gateway-fetch-failed | client-error`. **C13 applied.**
  - `AuditStatus` covers `audit-not-our-state | audit-off-record-spend | audit-promoted` (Note N6: documented as enum, prefix `_audit`).
  - `InvalidEntry` carries `tokenId, observedTokenContentHash, reason, observedAt, bundleCid, senderTransportPubkey`.
  - `AuditEntry` carries `tokenId, observedTokenContentHash, auditStatus, reason, recordedAt, bundleCidsObserved, promotedToManifestRef?, audit_promoted_from?`.
  - Snapshot test asserts the on-wire string forms — failing the test forces an ADR.
- **est_loc**: 200 (was 180; +20 for new variant).
- **risks**: drift between this enum and per-record schemas in T.3.B and T.5.D — single source of truth in `types/disposition.ts` plus runtime re-validation at storage write time.
- **spec_refs**: §5.4, §6.1, §8, PA §10.11.

---

#### T.1.D — Encode/decode helpers for `UxfTransferPayload` + Constants module

- **wave**: T.1
- **files_touched**:
  - NEW: `uxf/transfer-payload.ts` (~200 LOC) — `encodeTransferPayload`, `decodeTransferPayload`, `decodeNostrEventContent`, `extractCarRootCid`.
  - NEW: `modules/payments/transfer/limits.ts` (~80 LOC) — **consolidated constants module (W36)**: `MAX_INLINE_CAR_BYTES = 16 * 1024`, `RELAY_SAFE_CAP_BYTES = 96 * 1024`, `MAX_FETCHED_CAR_BYTES = 32 * 1024 * 1024`, `MAX_UNCLAIMED_ROOTS = 16`, `MAX_CHAIN_DEPTH = 64`, `REPLAY_LRU_SIZE = 256`, `MAX_CONCURRENT_POLLS_PER_TOKEN = 4`, `MAX_CONCURRENT_POLLS_PER_AGGREGATOR = 16`, `INGEST_QUEUE_SIZE = 256`, `INGEST_QUEUE_PER_TOKEN_CAP = 16` (W7).
  - NEW: `tests/unit/uxf/transfer-payload.test.ts` — encode/decode round-trip; truncated CAR rejection; multi-root CAR rejection (delegated to `pkg.verify()` — see T.3.A); root-CID mismatch rejection; legacy shape passthrough.
  - NEW: `tests/unit/payments/transfer/limits.test.ts` — values are stable; importing the module never has side effects.
- **depends_on**: T.1.A.
- **parallel_with**: T.1.B.1, T.1.C.
- **skill_tag**: `wire`
- **acceptance**:
  - `encodeTransferPayload(args)` produces the JSON shape from §3.1 byte-deterministically.
  - `decodeTransferPayload(string)` returns a typed `UxfTransferPayload` or throws `BUNDLE_REJECTED:malformed-envelope`.
  - `extractCarRootCid(carBytes)` returns the CIDv1 base32 string for a single-root CAR; throws `BUNDLE_REJECTED:multi-root` for multi-root and `BUNDLE_REJECTED:invalid-car` for malformed.
  - `clampInlineCap(userValue): number` clamps to `[1, RELAY_SAFE_CAP_BYTES]` per §3.3.1 and returns the clamp decision (used for telemetry).
  - 100% branch coverage; tests pass.
- **est_loc**: 380 (was 320; +60 for limits module).
- **risks**: CIDv1 binary vs base32 byte order for §5.3 [D-conflict] lex-min tie-break — write the comparator as `compareCidV1Binary(a: string, b: string): -1 | 0 | 1` and document; T.3.D consumes it.
- **spec_refs**: §3.1, §3.3.1, §3.3.2, §5.0.

---

#### T.1.E — `PROFILE_KEY_MAPPING` extension: add `audit`, widen `invalid`, add `finalization_queue`; `Sphere.clear()` coverage

- **wave**: T.1
- **files_touched**:
  - MODIFIED: `profile/types.ts` (`PROFILE_KEY_MAPPING`) — add `audit: { profileKey: '{addr}.audit', dynamic: true }`, add `finalization_queue: { profileKey: '{addr}.finalizationQueue', dynamic: true }`. Keep `invalidTokens` for legacy migration; add `invalid: { profileKey: '{addr}.invalid', dynamic: true }` for the multi-rep form.
  - MODIFIED: `profile/profile-storage-provider.ts` — extend the dynamic key matcher to recognize the new `{addr}.audit.${tokenId}.${observedTokenContentHash}` and `{addr}.invalid.${tokenId}.${observedTokenContentHash}` prefixes (per-entry-key form, Wave G.7). **Pre-task check**: T.0.G7-verify gates this; T.0.G7-fill-gaps lands the prefix-recognizer scaffolding first if needed.
  - MODIFIED: `profile/migration.ts` — pass through new keys without dropping them.
  - MODIFIED: `core/Sphere.ts` — extend `clear()` coverage so the new key-prefixes are wiped; this is via parent storage clear, not a new mapping (W46). **C6 applied.**
  - NEW: `tests/unit/profile/profile-key-mapping.test.ts` — round-trip mapping for new keys (legacy → profile and back).
  - MODIFIED: `tests/unit/profile/profile-storage-provider.test.ts` — extend the per-address scoping cases to cover `audit` and `finalization_queue`.
  - NEW: `tests/unit/core/Sphere.clear.test.ts` (extension) — assert the new key-prefixes are cleared on `Sphere.clear()`.
  - NEW: `profile/types.ts` doc comment block — explicit note that `Sphere.clear()` reaches these via parent storage clear, not via the mapping table (W46, prevents future "mapping is incomplete" confusion).
- **depends_on**: T.1.A, T.1.C, **T.0.G7-verify** (must pass) AND **T.0.G7-fill-gaps if verify failed** (conditional). See round-2 W5 split.
- **parallel_with**: T.1.B.1, T.1.D.
- **skill_tag**: `storage`
- **acceptance**:
  - `PROFILE_KEY_MAPPING` exports the three new entries.
  - Migration path from a wallet that has `invalidTokens` (legacy single-record-per-tokenId) to `invalid.${tokenId}.${observedTokenContentHash}` is one-way and is exercised by a fixture wallet (`tests/fixtures/wallets/legacy-invalidTokens-pre-T1E/`).
  - `profile/profile-storage-provider.ts` per-address scoping recognizes the new prefixes and round-trips.
  - The static `audit`, `invalid`, `finalization_queue` keys do NOT appear at runtime (they are schema declarations; the per-entry-key writer expands them, identical pattern to `outbox`).
  - `Sphere.clear()` deletes all three new prefixes (verified by `tests/unit/core/Sphere.clear.test.ts`).
  - **CRITICAL**: this lands BEFORE any disposition writer (T.3.B onward). Tasks downstream of T.1.E that touch `_audit` or `_invalid` per-entry-key form MUST list T.1.E in their `depends_on`. **C4 applied: T.5.D now lists T.1.E.**
- **est_loc**: 460 (was 360; +100 for Sphere.clear coverage + doc comment + Wave G.7 prereq check).
- **risks**: schema migration corner case — a wallet with stale `invalidTokens` (legacy) AND new `invalid.${tokenId}.${cid}` (someone ran T.3.B against an unmigrated wallet). Write the migration to be additive: legacy records become per-entry-key records keyed by a synthetic `observedTokenContentHash = "legacy-" + tokenId`.
- **spec_refs**: §5.4, PA §10.11, INV §11.

---

#### T.1.F — Lamport clock primitive + per-tokenId mutex (3 strategies) + manifest CAS

- **wave**: T.1
- **files_touched**:
  - NEW: `profile/lamport.ts` (~80 LOC) — `Lamport` class with `bumpFor(observedRemotes: number[]): number` and `merge(a: number, b: number): number`. Used by outbox + manifest writers.
  - NEW: `profile/per-token-mutex.ts` (~180 LOC) — in-process per-tokenId mutex implementing **all three** §5.5 step 9 lock-vs-RPC strategies (W34): (1) **CAS-preferred** (default), (2) **lock-with-RPC-release**, (3) **lock-with-bounded-hold** with `MAX_LOCK_HOLD_MS = 5000`. Worker-pool-safe. T.5.C selects via config.
  - NEW: `profile/manifest-cas.ts` (~140 LOC) — compare-and-swap helper on a manifest entry's content hash. Implements the CAS-based path; T.5.C step 9 default.
  - NEW: `tests/unit/profile/lamport.test.ts`, `tests/unit/profile/per-token-mutex.test.ts`, `tests/unit/profile/manifest-cas.test.ts`.
  - NEW: `tests/unit/profile/per-token-mutex-bounded-hold.test.ts` — **explicit test that `MAX_LOCK_HOLD_MS` actually fires (W35)**.
  - NEW: `tests/unit/profile/orbitdb-lamport-bounds.test.ts` — **adversarial test that `lamport > 2 × max(localKnownLamports)` from untrusted replicas is rejected (W39)**.
- **depends_on**: none (pure utility).
- **parallel_with**: T.1.A through T.1.E.
- **skill_tag**: `crdt`
- **acceptance**:
  - `Lamport.bumpFor([3,7,2])` from local 5 returns 8 (max + 1).
  - `Lamport.merge(5, 8)` returns 8.
  - `PerTokenMutex.acquire(tokenId, fn, {strategy: 'cas' | 'rpc-release' | 'bounded-hold', timeoutMs?: number})` enforces serialization.
  - `MAX_LOCK_HOLD_MS` bounded-hold actually fires when an RPC takes longer than the bound (W35).
  - `ManifestCas.update(addr, tokenId, prev, next)` returns `{ok: false, reason: 'cas-mismatch'}` when prev hash doesn't match.
  - All three primitives are stateless across SDK destroy/recreate (no module-level globals); each `Sphere` instance gets its own.
  - **OrbitDB Lamport bounds defense**: `bumpFor()` rejects observed remote lamports `> 2 × max(localKnownLamports)` with `LAMPORT_BOUND_VIOLATION` (W39).
- **est_loc**: 580 (was 440; +140 for 3-strategy mutex + bounds test).
- **risks**: the `MAX_LOCK_HOLD_MS` default must not race with realistic aggregator latencies under load — make it configurable and document the trade-off; the CAS-based path (T.5 step 9 default) avoids the issue entirely.
- **spec_refs**: §5.5 step 9, §7.1 Lamport invariants.

---

### T.2 — Sender bundle construction (conservative UXF + delivery overrides)

T.2 ships the UXF wire path for **conservative mode only** (no instant-mode complexity yet — the chain has no unfinalized tail when conservative bundles go out). It implements the 16 KiB inline / 96 KiB clamp / `delivery: 'force-cid'` / `delivery: 'force-inline'` overrides. Recipient-side ingest is T.3. **T.2.D is split into D.1 (orchestrator-no-outbox) + D.2 (outbox integration)** — D.2 hard-depends on T.6.A. **C2 applied.**

---

#### T.2.A — Source-token preflight: walk pending history and finalize before bundle build

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/preflight-finalize.ts` (~250 LOC) — given `selectedSources: Token[]`, walk every unfinalized predecessor tx and submit-and-await proof for each, in chain order. Reused by conservative path in T.2.D.1.
  - NEW: `tests/unit/payments/transfer/preflight-finalize.test.ts` — chain depth 0, 1, 3; partial finalization; aggregator transient retries; aggregator hard-rejection cascades to `INSUFFICIENT_BALANCE` reason='source-cascade-failed'.
- **depends_on**: T.1.B.1, T.1.C.
- **parallel_with**: T.2.B, T.2.C.
- **skill_tag**: `sender`
- **acceptance**:
  - For a finalized source token, the function is a no-op.
  - For a pending source token (1 unfinalized tx), submits + waits for proof before returning.
  - For a chain-mode source (K unfinalized), processes all K in topological order; failure at any step propagates as `SOURCE_CHAIN_HARD_FAIL` with the failing tx's `requestId` and `DispositionReason`.
  - Idempotent: re-running on a partially-finalized source picks up where it left off (uses `requestId` lookup against aggregator).
- **est_loc**: 380.
- **risks**: long preflight time for deep chains — log progress events `transfer:preflight-progress`; abort cleanly on caller-supplied `AbortSignal`.
- **spec_refs**: §2.2, §13 Wave T.2 statement "Sender also walks the source token's history and finalizes any inherited pending txs before bundle build."

---

#### T.2.B — Multi-asset target validation (coin + NFT class disjointness) + classifyToken

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/target-validator.ts` (~280 LOC) — implements §4.1 step 1 verbatim: builds `targetList` from `(primary, additionalAssets)`; enforces distinct coinIds, distinct NFT tokenIds, positive amounts, source-class enforcement, NFT-target-source-must-be-NFT, mixed-asset rejection, NFT-pending-without-confirm.
  - NEW: `modules/payments/transfer/classify-token.ts` (~60 LOC) — single source of truth for `classifyToken(t): 'coin' | 'nft'`. **Used everywhere; cascade walker (T.5.B.5) and importInclusionProof (T.5.D) consume this**. C11 applied.
  - NEW: `tests/unit/payments/transfer/target-validator.test.ts` — every error code path (`EMPTY_TRANSFER`, `INVALID_REQUEST`, `INVALID_AMOUNT`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_BALANCE` reason='nft-not-owned', `NFT_PENDING_REQUIRES_CONFIRMATION`, `UNKNOWN_ASSET_KIND`).
  - NEW: `tests/unit/payments/transfer/§4.1-step2-confirmNftPending.test.ts` — **explicit test for `confirmNftPending` rejection at T.5.A (W11)**, mirroring §4.1 step 2.
  - NEW: `tests/unit/payments/transfer/§4.1-empty-transfer.test.ts` — **explicit runtime test for `payments.send({})` → `EMPTY_TRANSFER` (W22)**.
- **depends_on**: T.1.B.1.
- **parallel_with**: T.2.A, T.2.C.
- **skill_tag**: `sender`
- **acceptance**:
  - The class-predicate (`isNft = !token.coins?.length`) is wrapped in `classifyToken(t): 'coin' | 'nft'` and used everywhere — including T.5.B.5 cascade walker (coin path uses `splitParent`; NFT path uses outbox-driven notification).
  - Zero-amount coinData entries are pruned at validation entry (`normalizeCoinData(t)`) per §4.1 paragraph "Implementations MUST prune zero-amount entries".
  - The 14 validation cases in §11.2 ("Validation rejections" bullet list) each have a passing test.
  - The validator is a pure function; no I/O, no mutation.
  - `confirmNftPending: false` (default) on a pending NFT source rejects with `NFT_PENDING_REQUIRES_CONFIRMATION` (W11); `confirmNftPending: true` permits the send.
  - `EMPTY_TRANSFER` runtime test passes (W22).
- **est_loc**: 540 (was 460; +80 for classify-token + W11 + W22 tests).
- **risks**: subtle class-disjointness violations under user-crafted `additionalAssets` (e.g., a coin source that happens to have a `tokenId` matching an NFT target) — exhaustive table-driven test covering every paragraph in §4.1.
- **spec_refs**: §4.1 steps 1–2, §11.2 multi-asset cases.

---

#### T.2.C — `DeliveryStrategy` resolver: 16 KiB / 96 KiB clamp, force-inline, force-cid + INVALID_INLINE_CAP rejection

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/delivery-resolver.ts` (~160 LOC) — given `(strategy, carBytes)`, returns one of `{kind: 'inline', carBase64: ...} | {kind: 'cid', cid: ..., shouldPin: boolean}` or throws `INLINE_CAR_TOO_LARGE` / `INVALID_INLINE_CAP`.
  - NEW: `tests/unit/payments/transfer/delivery-resolver.test.ts` — auto with default cap; auto with custom cap; auto with cap > 96 KiB (clamps); force-inline within 96 KiB; force-inline above 96 KiB (rejects); force-cid even for tiny bundles.
  - NEW: `tests/unit/payments/transfer/§3.3.1-invalid-inline-cap.test.ts` — **deterministic choice for INVALID_INLINE_CAP rejection vs clamp (W12)**: cap < 1 → `INVALID_INLINE_CAP`; cap > 96 KiB → silent clamp + telemetry.
- **depends_on**: T.1.D.
- **parallel_with**: T.2.A, T.2.B.
- **skill_tag**: `wire`
- **acceptance**:
  - Default `{kind: 'auto'}` resolves to inline iff `carBytes.length <= 16384`.
  - `{kind: 'auto', inlineCapBytes: N}` clamps `N` to `[1, 96 * 1024]` per §3.3.1 hard-upper-bound paragraph.
  - `inlineCapBytes < 1` rejects with `INVALID_INLINE_CAP` (W12, deterministic).
  - `{kind: 'force-inline'}` throws `INLINE_CAR_TOO_LARGE` for bundles > 96 KiB (the relay-safe ceiling).
  - `{kind: 'force-cid'}` returns `kind: 'cid', shouldPin: true` regardless of size.
  - All branches covered.
- **est_loc**: 320 (was 280; +40 for W12 test).
- **risks**: NIP-11 dynamic discovery is deferred (§12.2) — leave a `// TODO(T.future-NIP11)` marker and an extension point.
- **spec_refs**: §3.3.1, §3.3.2.

---

#### T.2.D.1 — Conservative-mode UXF send orchestrator (without outbox integration)

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/conservative-sender.ts` (~440 LOC) — orchestrates: (1) target validation via T.2.B, (2) source selection (existing `spendPlanner`), (3) preflight finalize via T.2.A, (4) build commitments + await proofs (existing aggregator client), (5) `UxfPackage.create()` + `ingestAll()`, (6) `pkg.toCar()`, (7) `extractCarRootCid()` (T.1.D), (8) delivery resolver (T.2.C), (9) IPFS pin if CID, (10) **stub outbox call** (returns synthetic legacy entry; D.2 replaces this), (11) `transport.sendTokenTransfer(recipientPubkey, payload)`, (12) emit `transfer:confirmed`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — feature-flag-gated dispatcher: when `features.senderUxf === true` AND `transferMode === 'conservative'`, invoke the new orchestrator; otherwise fall through to the existing path. NO touch to instant or TXF arms in this PR.
  - NEW: `tests/unit/payments/transfer/conservative-sender.test.ts` — 1-token, 5-token, 100-token bundles; CID-only tiny bundle via `force-cid`; force-inline failure path; relay reject auto-fallback to CID.
- **depends_on**: T.1.A, T.1.B.1, T.1.C, T.1.D, T.2.A, T.2.B, T.2.C.
- **parallel_with**: T.3.A, T.3.B.1, T.3.B.2, T.3.C.
- **skill_tag**: `sender`
- **acceptance**:
  - With `senderUxf=true` flag, conservative-mode sends end-to-end through UXF wire format with byte-identical CAR for a 1-token send to the captured fixture (T.8.A).
  - With flag off, behavior is identical to current main.
  - Bundle-internal token order is deterministic (lex-min `tokenId`) for fixture stability.
  - `transfer:confirmed` event emitted with `tokenTransfers[i].method === 'split' | 'direct'`.
  - **Stub outbox writer**: synthetic legacy entry created so existing tests pass; T.2.D.2 replaces with real per-entry-key writes.
- **est_loc**: 600.
- **risks**: race on `pkg.toCar()` with the IPFS pin (§3.3.2 "the CAR is in fact already pinned by the time we send") — make the pin step idempotent and let the outbox transition naturally per §7.0.
- **spec_refs**: §2.2, §4.1, §4.2.

---

#### T.2.D.2 — Conservative-sender outbox integration (gated on T.6.A)

- **wave**: T.2
- **files_touched**:
  - MODIFIED: `modules/payments/transfer/conservative-sender.ts` — replace stub outbox call with real `OutboxWriter.create()` (T.6.A). Outbox transitions: `packaging → sending → delivered` per §7.0.
  - NEW: `tests/unit/payments/transfer/conservative-sender-outbox.test.ts` — outbox entry created with correct schema; status transitions on each step; crash-recovery semantics (T.6.E).
- **depends_on**: T.2.D.1, **T.6.A** (hard dep — C2 applied).
- **parallel_with**: T.2.E, T.4.A (which extends conservative-sender too).
- **skill_tag**: `sender`
- **acceptance**:
  - Outbox entry created with `status='sending'` BEFORE Nostr publish (pre-publish persistence ordering, §6.3 last paragraph).
  - On Nostr ack, status transitions to `delivered`.
  - Outbox entry persists `recipientNametag`, `bundleCid`, `mode`, `deliveryMethod`.
- **est_loc**: 240.
- **risks**: ordering bug — see T.6.E for the deterministic crash-recovery harness.
- **spec_refs**: §7.0, §6.3.

---

#### T.2.E — Transport-layer send adapter for `UxfTransferPayload`

- **wave**: T.2
- **files_touched**:
  - MODIFIED: `transport/transport-provider.ts` — extend `TokenTransferPayload` to be `LegacyTokenTransferPayload | UxfTransferPayload` (re-exported); the wire layer is shape-agnostic.
  - MODIFIED: `transport/NostrTransportProvider.ts` — `sendTokenTransfer()` now serializes any payload type via JSON; `_handleTokenTransferEvent()` calls `decodeTransferPayload()` from T.1.D and routes appropriately. Preserve current legacy-shape behavior when handler is the legacy adapter.
  - NEW: `tests/unit/transport/NostrTransportProvider.uxf-payload.test.ts` — encodes a UXF-CAR payload, round-trips through `sendTokenTransfer` + `onTokenTransfer` mock pipeline; encodes a UXF-CID payload; encodes a legacy `{sourceToken, transferTx}` payload (regression).
- **depends_on**: T.1.D.
- **parallel_with**: T.2.A, T.2.B, T.2.C, T.2.D.1.
- **skill_tag**: `transport`
- **acceptance**:
  - The transport layer accepts both legacy and UXF payloads as a tagged-union input.
  - Inbound events route unchanged through `onTokenTransfer(handler)`; the handler (PaymentsModule) decides shape via the discriminator.
  - No regression in existing transport tests.
- **est_loc**: 240.
- **risks**: a relay rejecting on size — leverage the existing `failed-transient` path in `NostrTransportProvider` and ensure the outbox sees the rejection (T.6.A wires this).
- **spec_refs**: §3.3.2, §10.2.

---

### T.3 — Recipient bundle ingest + decision matrix

T.3 implements §5.1 (bundle acquisition, including LRU replay defense), §5.2 (bundle-level checks including chain-depth + smuggled-roots caps), §5.3 (the [A]–[F] decision matrix with mandatory ECDSA at [C](1) AND **full-chain source-state continuity walk at [C](2) — C8 applied**), §5.4 (multi-rep `_invalid` + new `_audit`). Worker pool from §5.0 lands here too. **No instant-mode handling** — bundles with `mode === 'instant'` are rejected with a typed soft-error to avoid silent token loss in T.2-only deployments.

**T.3.B is split into T.3.B.1 (per-element verifiers) + T.3.B.2 (decision-matrix walker)** to keep PRs reviewable. **W2 applied.**

---

#### T.3.A — Bundle acquisition + verification (CAR-only, CID deferred to T.4)

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/bundle-acquirer.ts` (~280 LOC) — given `UxfTransferPayload`, returns `{pkg: UxfPackage, bundleCid: string}` or throws typed `BUNDLE_REJECTED:*`. Handles `kind: 'uxf-car'` only; emits `BUNDLE_REJECTED:cid-mode-not-yet-supported` for `kind: 'uxf-cid'` (T.4 enables).
  - NEW: `modules/payments/transfer/bundle-verifier.ts` (~340 LOC) — implements §5.2 #1 (`pkg.verify()` wrapper), #2 (token-id claim consistency), #3 (chain-depth cap with two-tier rule), #4 (smuggled-roots count cap with fail-closed type-tag handling).
  - NEW: `modules/payments/transfer/replay-lru.ts` (~120 LOC) — bounded LRU set of bundleCids, default 256, with eviction. **Per-sender-pubkey sub-buckets for cross-sender eviction defense (Note N5)**.
  - NEW: `tests/unit/payments/transfer/bundle-acquirer.test.ts`, `bundle-verifier.test.ts`, `replay-lru.test.ts`.
  - NEW: `tests/unit/payments/transfer/§5.2-2-advisory-tokenIds-positive.test.ts` — **§5.2 #2 advisory tokenIds positive test (W24)**: unclaimed root binds to recipient → processed normally.
- **depends_on**: T.1.A, T.1.D.
- **parallel_with**: T.3.B.1, T.3.B.2, T.3.C, T.3.D, T.3.E.
- **skill_tag**: `recipient`
- **acceptance**:
  - Multi-root CAR rejected with `BUNDLE_REJECTED:multi-root` (delegated to `pkg.verify()`).
  - Root-CID mismatch rejected with `BUNDLE_REJECTED:root-cid-mismatch`.
  - Chain depth > 64 in claimed tokenIds rejects WHOLE bundle; chain depth > 64 in unclaimed roots SILENTLY DROPS that root (smuggling defense).
  - Unclaimed root count > 16 rejects WHOLE bundle.
  - Unknown type-tag at top level counts toward `MAX_UNCLAIMED_ROOTS` (fail-closed).
  - Replay LRU short-circuits a re-arriving bundleCid as a no-op (idempotent per §5.6).
  - Per-sender-pubkey sub-bucket eviction prevents a hostile sender from evicting honest entries (Note N5).
  - §5.2 #2 advisory tokenIds positive case passes (W24).
- **est_loc**: 820 (was 760; +60 for sub-buckets + W24 test).
- **risks**: false-negative on the smuggled-roots cap if `tokenIds` field is empty (sender ships everything as "unclaimed") — explicit test case; documented behavior is "all roots are unclaimed → cap kicks in if > 16".
- **spec_refs**: §5.1, §5.2.

---

#### T.3.B.1 — Per-element verifiers (predicate, authenticator, proof, **continuity**)

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/predicate-evaluator.ts` (~180 LOC) — wraps SDK predicate evaluation with try/catch; returns `{ok: true, bindsToUs: boolean} | {ok: false, threw: true}`.
  - NEW: `modules/payments/transfer/authenticator-verifier.ts` (~140 LOC) — mandatory ECDSA verification of `authenticator.signature` over canonical preimage at [C](1). Throw → STRUCTURAL_INVALID; verify-fails → PROOF_INVALID. **For K-tx chains: verify K authenticators (W37)**.
  - NEW: `modules/payments/transfer/continuity-walker.ts` (~220 LOC) — **C8 applied**: walks the full transaction chain, asserts `tx[i].sourceState === tx[i-1].destinationState` for every i. Returns `{ok: true} | {ok: false, brokenAt: i, reason: 'continuity-broken'}`. Hostile-mid-chain forgeries are caught here.
  - NEW: `modules/payments/transfer/proof-verifier.ts` (~200 LOC) — wraps `oracle.verifyInclusionProof()` returning `OK | PATH_INVALID | NOT_AUTHENTICATED | PATH_NOT_INCLUDED | THROWN`. PATH_NOT_INCLUDED at receive maps to PROOF_INVALID per §5.3 [C](3).
  - NEW: `tests/unit/payments/transfer/predicate-evaluator.test.ts`.
  - NEW: `tests/unit/payments/transfer/authenticator-verifier.test.ts`.
  - NEW: `tests/adversarial/transfer/forged-authenticator-mid-chain.test.ts` (per-tx ECDSA, mid-chain forgery — C8/W37).
  - NEW: `tests/unit/payments/transfer/continuity-walker.test.ts`.
  - NEW: `tests/adversarial/transfer/broken-continuity.test.ts` — **C8 adversarial test**: hostile sender ships chain where `tx[2].sourceState !== tx[1].destinationState` → `continuity-broken` disposition.
  - NEW: `tests/unit/payments/transfer/proof-verifier.test.ts`.
- **depends_on**: T.1.A, T.1.C, T.3.A.
- **parallel_with**: T.3.B.2, T.3.C, T.3.D.
- **skill_tag**: `recipient`
- **acceptance**:
  - Each verifier is a pure function with try/catch around SDK calls. Throw → STRUCTURAL_INVALID (no silent fall-through).
  - Authenticator verification runs **per-tx** for K-tx chains (W37); mid-chain forgery test confirms catch.
  - Continuity walker walks the full chain; `continuity-broken` disposition fires at the broken link with the broken index.
  - PATH_NOT_INCLUDED at receive (someone shipped a stale proof claiming anchorage) → PROOF_INVALID with `reason='proof-invalid'`.
- **est_loc**: 760.
- **risks**: subtle proof-verifier wrapper bugs around throw vs. return — exhaustive fault-injection test.
- **spec_refs**: §5.3 [C], §5.3 [C](2) source-state continuity, §6.3.

---

#### T.3.B.2 — Disposition matrix walker [A]/[B]/[C]/[D]/[E]/[F]/[B'] + STRUCTURAL_INVALID throw-paths

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/disposition-engine.ts` (~480 LOC) — pure decision-matrix walker. Inputs: `{tokenRootElement, pool, localPool, identity, oracle, trustBase}`. Output: `DispositionRecord`. Calls T.3.B.1 verifiers; routes per the [A]–[F] decision matrix.
  - NEW: `tests/unit/payments/transfer/disposition-engine.test.ts` — at least one test per leaf in §5.3 (per the §11.1 unit-test list); throw-paths.
- **depends_on**: T.3.B.1.
- **parallel_with**: T.3.C, T.3.D, T.3.E.
- **skill_tag**: `recipient`
- **acceptance**:
  - Every branch listed in Appendix A (rows A through E-unspendable) has at least one passing test.
  - Throw at any branch → STRUCTURAL_INVALID; never silent fall-through.
  - Bundles with `mode === 'instant'` AND any unfinalized tx return a typed soft-error `BUNDLE_REJECTED:instant-mode-not-yet-supported` per the T.3 deferred-handling note.
  - **C-continuity branch** (W24-related): the engine routes through the continuity walker first, before [B]/[B'] checks.
- **est_loc**: 720 (was 1320 in monolithic T.3.B; B.1 takes ~760, B.2 takes ~720).
- **risks**: tight coupling to T.3.B.1; ensure the test seam is clean (B.2 mocks B.1 verifiers in unit tests).
- **spec_refs**: §5.3, Appendix A, §11.1.

---

#### T.3.C — `_invalid` + `_audit` storage with multi-rep keys; manifest writes for VALID/PENDING/CONFLICTING

- **wave**: T.3
- **files_touched**:
  - NEW: `profile/disposition-writer.ts` (~380 LOC) — given a `DispositionRecord` and an address, writes to the appropriate OrbitDB collection (`{addr}.invalid.${tokenId}.${observedTokenContentHash}` for invalid; `{addr}.audit.${...}` for audit; `{addr}.manifest.${tokenId}` for active pool). Uses Lamport bumps from T.1.F. **Handles `'client-error'` reason path (C13)**.
  - NEW: `profile/manifest-store.ts` (~260 LOC) — typed wrapper over manifest reads/writes; preserves the §5.4 metadata-preservation rules (`audit_promoted_from`, `splitParent`, `conflictingHeads[]`, `lamport`) on merge.
  - NEW: `tests/unit/profile/disposition-writer.test.ts` — VALID write to manifest; INVALID write with multi-rep key; AUDIT write with multi-rep key; same tokenId observed in two bundles → two distinct invalid records; **`'client-error'` reason routes to `_invalid` correctly (C13)**.
  - NEW: `tests/unit/profile/manifest-store.test.ts` — set-OR merge for `audit_promoted_from`; max-merge for `lamport`; lex-min tie-break on conflicting bundleCids.
- **depends_on**: T.1.C, T.1.E, T.1.F.
- **parallel_with**: T.3.A, T.3.B.1, T.3.B.2, T.3.D, T.3.E.
- **skill_tag**: `storage`
- **acceptance**:
  - `_invalid` and `_audit` records key by `${addr}.{invalid|audit}.${tokenId}.${observedTokenContentHash}`.
  - Two distinct bundles for the same tokenId produce two records (idempotent by `observedTokenContentHash`).
  - Manifest merge with conflicting heads picks lex-min `bundleCid` (using `compareCidV1Binary` from T.1.D).
  - Promotion flow (calling `promoteAuditEntry(auditKey, manifestEntry)`) sets `promotedToManifestRef` on the audit record AND `audit_promoted_from: [auditKey]` on the manifest entry; the audit record is NOT deleted.
  - **`'client-error'` reason path (C13)**: writes to `_invalid` with reason='client-error'; operator-alert event emitted.
- **est_loc**: 800 (was 760; +40 for client-error path).
- **risks**: `audit_promoted_from` widening from `string | undefined` to `string[] | undefined` is a schema change — write a one-shot lifter in T.6.D migration.
- **spec_refs**: §5.4, §6.1, PA §10.11.

---

#### T.3.D — Conflict / merge engine (§5.3 [D])

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/conflict-merger.ts` (~340 LOC) — given two manifest entries for the same `tokenId`, decides {`identical-no-op` | `prefix-extension-merge` | `genuinely-divergent-conflict`}. Uses `resolveTokenRoot` (existing Wave G.3 facility) for proof grafting; returns the merged manifest entry plus the `audit_promoted_from` / `splitParent` / `conflictingHeads` deltas.
  - NEW: `tests/unit/payments/transfer/conflict-merger.test.ts` — identical chain (idempotent); strict prefix → graft; strict extension → graft; genuinely divergent → CONFLICTING with lex-min winner; merge with surface-level transfer-out we authored → re-run [B'] → NOT_OUR_CURRENT_STATE.
- **depends_on**: T.1.A, T.1.C, T.1.D, T.1.F (manifest CAS), T.3.B.2.
- **parallel_with**: T.3.A, T.3.C, T.3.E.
- **skill_tag**: `recipient`
- **acceptance**:
  - Lex-min tie-break uses CIDv1 binary, not base32 string (per §5.3 [D-conflict] paragraph).
  - Proof grafting is monotonic — proofs accumulate, never delete.
  - Post-merge re-run of [B'] surfaces NOT_OUR_CURRENT_STATE when the merge contains a transfer-out we authored.
- **est_loc**: 540.
- **risks**: Wave G.3 `resolveTokenRoot` semantics — ensure we use the verified-proofs branch with the new bundle's proofs only; a hostile sender's proofs get re-verified at [C].
- **spec_refs**: §5.3 [D], §5.6.

---

#### T.3.E — Worker pool (§5.0) + per-worker resource caps + ingest queue

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/ingest-worker-pool.ts` (~360 LOC) — N=16 default workers, bounded queue=256, **per-tokenId queue cap (default 16, W7)**, per-tokenId mutex coordination via T.1.F. Drops with `INGEST_QUEUE_FULL` when bounded; drops with `INGEST_QUEUE_FULL_PER_TOKEN` when a single tokenId exceeds its cap (W7).
  - MODIFIED: `modules/payments/PaymentsModule.ts` — `handleIncomingTransfer()` enqueues onto the worker pool when `features.recipientUxf=true`; legacy path unchanged when off.
  - NEW: `tests/unit/payments/transfer/ingest-worker-pool.test.ts` — 100 bundles in flight; one slow bundle does not serialize; queue overflow → `INGEST_QUEUE_FULL`; per-tokenId mutex prevents double-disposition.
  - NEW: `tests/unit/payments/transfer/§5.0-bundle-internal-sequential.test.ts` — **§5.0 bundle-internal sequential token processing (W23)**.
  - NEW: `tests/unit/payments/transfer/ingest-queue-full-per-token.test.ts` — **W7 per-tokenId cap test**.
  - NEW: `tests/integration/transfer/§4.B-gateway-failure-no-disposition.test.ts` — **W13: gateway-fetch-failed routes through transient retry only; NO disposition record written**.
- **depends_on**: T.1.F, T.3.A, T.3.B.2, T.3.C, T.3.D.
- **parallel_with**: none in T.3 (this is the integrator).
- **skill_tag**: `worker`
- **acceptance**:
  - 16 concurrent bundles processed in parallel without per-tokenId data races (verified by deterministic-clock test).
  - Slow bundle (mocked 30s wait) does not block 15 fast bundles.
  - Queue overflow surfaces metric `transfer:ingest-queue-full` (informational).
  - Per-tokenId queue cap (W7) rejects with `INGEST_QUEUE_FULL_PER_TOKEN`.
  - Worker pool destroyed cleanly on `Sphere.destroy()`.
  - **W23**: bundle-internal token processing is sequential (within a bundle); cross-bundle is parallel.
  - **W13**: gateway-fetch-failed never writes a disposition record (transient retry only).
- **est_loc**: 660 (was 580; +80 for per-token cap + W23 + W13 tests).
- **risks**: per-tokenId lock leak under panic — every worker wraps in try/finally with explicit release.
- **spec_refs**: §5.0.

---

### T.4 — CID-pin delivery for large bundles

T.4 enables the `kind: 'uxf-cid'` path. Sender pins to IPFS (already-pinned-via-outbox per §3.3.2 paragraph), then sends only the CID over Nostr. Recipient fetches via verified-CAR pipeline with the 32 MiB cap.

---

#### T.4.A — Sender CID-pin path: extend conservative-sender to `kind: 'uxf-cid'`

- **wave**: T.4
- **files_touched**:
  - MODIFIED: `modules/payments/transfer/conservative-sender.ts` — when delivery resolver returns `kind: 'cid'`, pin the CAR to IPFS (using existing `IpfsHttpClient.pin`), record the CID, build `UxfTransferPayloadCid`. Outbox transition `packaging → pinned → sending → delivered`.
  - MODIFIED: `modules/payments/transfer/delivery-resolver.ts` — already returns `shouldPin`; the sender hooks the pin call.
  - NEW: `tests/unit/payments/transfer/conservative-sender-cid.test.ts` — `force-cid` for tiny bundle; auto-cid for >16 KiB bundle; pin failure → outbox `failed-permanent`; `senderGateways` hint set per spec.
- **depends_on**: T.2.D.2, T.6.A (outbox transitions), T.6.B (retention rules).
- **parallel_with**: T.4.B.
- **skill_tag**: `sender`
- **acceptance**:
  - Bundle > 16 KiB auto-routes to CID path with default delivery.
  - Pin failure transitions outbox `pinned → failed-permanent` per §3.3.2 (Nostr publish must NOT happen if pin fails).
  - `senderGateways` set from local config (informational; recipient walks its own list).
- **est_loc**: 320.
- **risks**: races between outbox pinning and the IPFS pipeline already pinning the bundle (§3.3.2 paragraph) — make the outbox-side pin idempotent (no-op when CID already retrievable).
- **spec_refs**: §3.3, §3.3.2.

---

#### T.4.B — Recipient verified-CAR fetch with 32 MiB cap + gateway walking

- **wave**: T.4
- **files_touched**:
  - NEW: `modules/payments/transfer/cid-fetcher.ts` (~280 LOC) — given `bundleCid` and `gateways: string[]`, walks each gateway, streaming-fetches the CAR with byte-counter capped at `MAX_FETCHED_CAR_BYTES = 32 * 1024 * 1024`. Verifies the CAR root CID matches `bundleCid` (Wave G.5 / I.b verifier). Aborts on cap exceed with `FETCHED_CAR_TOO_LARGE`.
  - MODIFIED: `modules/payments/transfer/bundle-acquirer.ts` — handle `kind: 'uxf-cid'` by invoking `cid-fetcher`. Emit `transfer:fetch-failed` if all gateways fail; **NO disposition record written (W13)**.
  - NEW: `tests/unit/payments/transfer/cid-fetcher.test.ts` — happy path (one gateway works); first gateway fails, second succeeds; all fail → `transfer:fetch-failed`; CAR > 32 MiB → `FETCHED_CAR_TOO_LARGE`; root-CID mismatch from gateway → reject.
  - NEW: `tests/integration/transfer/uxf-cid-roundtrip.test.ts` — full sender(force-cid) → recipient(fetch-cid) on a controlled Helia gateway.
- **depends_on**: T.1.D, T.3.A.
- **parallel_with**: T.4.A.
- **skill_tag**: `recipient`
- **acceptance**:
  - Streaming abort at 32 MiB limit (do not buffer the whole CAR before checking size).
  - Gateway list walked in order; first success returns; first failure increments `proofErrorCount`-like counter; total failure emits `transfer:fetch-failed` and does NOT acknowledge to sender.
  - **No disposition record on gateway failure (W13)**: only the transient retry path runs.
  - `delivery: 'force-cid'` on a tiny bundle still goes through CID fetch (regression).
- **est_loc**: 600 (was 560; +40 for W13 test).
- **risks**: hostile gateway returning slightly-different CAR with same root claim — the verified-CAR pipeline's per-block hash check defends; explicit test.
- **spec_refs**: §3.3, §3.3.1, §3.3.2.

---

### T.5 — Instant mode + finalization workers + cascade walker (per-class)

T.5 is the largest wave. It implements §2.1 instant-mode bundle construction, §5.5 per-token finalization queue, §6.1 sender-side finalization worker, §6.2 recipient-side finalization worker, §6.3 convergence rules including `importInclusionProof()`, the manifest-CID-rewrite + tombstone semantics, and the cascade rule §6.1.1 (split into coin-class walker + NFT-class outbox-driven notification — **C11 applied**).

**Sub-task ordering (W3 + C3)**: `T.5.B.0 (manifest-cid-rewrite, peeled out, lands first) → T.5.B (sender worker) → T.5.B.5 (cascade walker, NEW, dedicated owner) → T.5.C (recipient worker) → T.5.D (importInclusionProof + revalidateCascadedChildren) → T.5.E (events) → T.5.F (trustBase staleness, NEW)`.

---

#### T.5.A — Instant-mode UXF send orchestrator (entry point)

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/instant-sender.ts` (~580 LOC) — like conservative-sender but with `inclusionProof: null` per tx. Submits commitment WITHOUT awaiting; persists `commitmentRequestIds` on the outbox entry (`outstandingRequestIds` set, two-set form per Decision 16); applies unproven tx locally; status `pending`. Triggers sender-side finalization worker. **`splitParent` is set on coin children only (C11)** — NFTs do NOT get `splitParent` (whole-token transfer preserves tokenId).
  - MODIFIED: `modules/payments/PaymentsModule.ts` — feature-flag-gated dispatcher routes `transferMode === 'instant'` to `instant-sender` (was: legacy instant path).
  - NEW: `tests/unit/payments/transfer/instant-sender.test.ts` — single-tx instant; chain-mode (allowPendingTokens=true) with K=3 inherited unfinalized; NFT instant with `confirmNftPending=true`.
  - NEW: `tests/unit/payments/transfer/§4.1-step2-confirmNftPending-rejection.test.ts` — **W11: replicate the §4.1 step 2 acceptance row at T.5.A**.
- **depends_on**: T.1.A, T.1.B.1, T.1.C, T.1.D, T.2.B, T.2.C, T.6.A, T.6.B.
- **parallel_with**: T.5.B.0 (peer — both depend on T.6.A/T.6.B). T.5.B / T.5.B.5 / T.5.C / T.5.D are downstream of T.5.A (T.5.B `depends_on T.5.A`); they are NOT peers.
- **skill_tag**: `sender`
- **acceptance**:
  - Outbox entry created with `status='delivered-instant'` after Nostr ack; `outstandingRequestIds` populated with all unfinalized commitment IDs (NEW one + inherited K-1).
  - Local source token marked `pending` until sender-side worker (T.5.B) attaches proofs.
  - `transfer:submitted` (NOT `confirmed`) emitted at this stage.
  - **For coin children (TokenSplitBuilder path, C11)**: `splitParent: { tokenId, status: 'pending'|'valid' }` set on each child token result.
  - **For NFT direct transfers (C11)**: NO `splitParent` set; whole-token transfer preserves `tokenId`.
  - `transfer:cascade-risk-warning` emitted when source is pending and recipient is freshly-minted child.
  - **W11: `confirmNftPending` rejection** triggers at T.5.A entry too (defense-in-depth) — uses the shared validator from T.2.B.
- **est_loc**: 880 (was 820; +60 for W11 + class-disjoint splitParent test).
- **risks**: race between local pool update and Nostr publish — pre-publish persistence ordering (§6.3 last paragraph): outbox commit BEFORE Nostr publish; resumable on restart.
- **spec_refs**: §2.1, §4.3, §6.1, §6.1.1.

---

#### T.5.B.0 — Manifest-CID-rewrite (peeled out, lands FIRST in T.5)

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/manifest-cid-rewrite.ts` (~180 LOC) — **W3 applied**: per §5.5 step 5, atomic-ish 4-step write order (pool write proof → manifest CID rewrite → tombstone insert → queue-entry removal LAST). Each step idempotent on replay.
  - NEW: `modules/payments/transfer/polling-policy.ts` (~120 LOC) — **W6 applied**: shared validity rule, 2× safety net, MIN_POLL_ATTEMPTS, POLLING_WINDOW. Imported by T.5.B AND T.5.C.
  - NEW: `tests/unit/payments/transfer/manifest-cid-rewrite.test.ts` — 4-step ordering; idempotency on each step; crash-resume produces convergent state.
  - NEW: `tests/unit/payments/transfer/§5.5-step5-atomicity.test.ts` — **W25: fault-injection test for crash between step 3 and step 4 (test name uses §5.5 spec citation per Note N1)**.
  - NEW: `tests/unit/payments/transfer/polling-policy.test.ts` — validity rule + 2× safety net.
- **depends_on**: T.1.A, T.1.C, T.1.F.
- **parallel_with**: T.5.A.
- **skill_tag**: `worker`
- **acceptance**:
  - 4-step write order validated by deterministic-clock fault injection.
  - Crash between step 3 and step 4 → next worker pass commits cleanly (W25).
  - Polling policy module is shared between T.5.B and T.5.C; no duplication.
- **est_loc**: 380.
- **risks**: subtle ordering bug — exhaustive fault injection at every step boundary.
- **spec_refs**: §5.5 step 5–6, §6.1.

---

#### T.5.B.0.5 — OrbitDB-write-fairness ADR + cap (NEW per round-2 W8)

- **wave**: T.5 (lands BEFORE T.5.C's design is frozen)
- **files_touched**:
  - NEW: `docs/uxf/ADR-005-orbitdb-write-fairness.md` (~50 LOC) — decision record on `MAX_CONCURRENT_ORBITDB_WRITES` cap value + fairness-queue strategy. Default proposed: 8 (half of MAX_INGEST_WORKERS to leave OrbitDB headroom for replication merges); revisit-criteria section requires re-eval if T.8.E.1 load test shows >50% queue depth at the cap.
  - MODIFIED: `modules/payments/transfer/limits.ts` — add `MAX_CONCURRENT_ORBITDB_WRITES = 8` constant.
  - NEW: `profile/orbitdb-write-fairness.ts` (~30 LOC) — fairness-queue stub (round-robin across pending writers; bounded concurrent in-flight count). **T.5.B and T.5.C consume this primitive** (added explicitly to their depends_on); T.6.A landed earlier in the chain and uses unmediated OrbitDB writes. A follow-up T.6.A-fairness-wrap task is OPTIONAL and not on the critical path — exists only if T.8.E.1 load test shows T.6.A's outbox writes contending with T.5.B/T.5.C's worker writes.
- **depends_on**: T.5.B.0 (manifest-cid-rewrite needs the fairness queue available to call into).
- **parallel_with**: T.5.B (after T.5.B.0 lands).
- **skill_tag**: `crdt`
- **acceptance**:
  - ADR documents the choice + revisit criteria.
  - `MAX_CONCURRENT_ORBITDB_WRITES` is exported from `limits.ts`.
  - Fairness-queue stub passes basic round-robin unit tests.
  - T.8.E.1 load test gates verify the cap is appropriate; if wrong, ADR revisit triggered.
- **est_loc**: 80
- **risks**: cap too low → bottleneck under load; too high → OrbitDB merge thrashing. ADR's load-test gate catches both before T.8.D cutover.
- **spec_refs**: PROFILE-ARCHITECTURE.md §10.

---

#### T.5.B — Sender-side finalization worker

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/finalization-worker-sender.ts` (~620 LOC) — implements §6.1 verbatim. Loops over outbox entries with `status='delivered-instant'`; for each `outstandingRequestId`: resolve signedTx, re-verify locally, submit, poll. Backoff schedule 30s, 60s, 120s, 240s, 5min. Honors POLLING_WINDOW (default 30 min) and MIN_POLL_ATTEMPTS (default 5). Per-aggregator concurrency cap **default 16 (W14)**. Uses `polling-policy.ts` from T.5.B.0 and `manifest-cid-rewrite.ts` from T.5.B.0.
  - **Race-lost detection (C12)**: at submit, `REQUEST_ID_EXISTS` → continue to poll; at poll, `OK` with proof's `transactionHash` matching local → SUCCESS; `OK` with mismatching `transactionHash` → race-lost (hard-fail, reason='race-lost', NO cascade per §6.1.1 race-lost special case). `REQUEST_ID_MISMATCH` → hard-fail, reason='client-error' (operator alert, NO cascade).
  - **Most-recent-proof tombstone path (W16)**: when a fresh poll returns a NEWER proof for an already-attached requestId, replace the proof; tombstone the previous CID. Test: `tests/unit/payments/transfer/§6.3-most-recent-proof-tombstone.test.ts`.
  - **`transfer:security-alert` for two-different-values path (C10)**: if two proofs for the same requestId disagree on `(transactionHash, authenticator)` — the §6.3 forbidden case — refuse to merge, emit `transfer:security-alert`. Test: `tests/adversarial/transfer/conflicting-proofs-same-requestid.test.ts`.
  - NEW: `tests/unit/payments/transfer/finalization-worker-sender.test.ts` — SUCCESS path; REQUEST_ID_EXISTS + matching transactionHash (idempotent retry); REQUEST_ID_EXISTS + MISMATCHING transactionHash (race-lost, NO cascade — C12); REQUEST_ID_MISMATCH hard-fail (`client-error`, NO cascade — C12/C13); AUTHENTICATOR_VERIFICATION_FAILED hard-fail (`belief-divergence`); transient retries; sustained PATH_NOT_INCLUDED past window → `oracle-rejected`; PATH_INVALID hard-fail; NOT_AUTHENTICATED → trustbase-warning + retry + hard-fail-after-refresh.
  - NEW: `tests/unit/payments/transfer/§6.1-race-lost-poll-mismatch.test.ts` — **C12: race-lost detected via poll-side `OK` + transactionHash mismatch**.
  - NEW: `tests/unit/payments/transfer/§6.1-client-error-request-id-mismatch.test.ts` — **C12/C13: client-error reason for REQUEST_ID_MISMATCH**.
  - NEW: `tests/unit/payments/transfer/max-concurrent-polls-limits.test.ts` — **W14**: per-tokenId cap=4, per-aggregator cap=16.
  - NEW: `tests/unit/payments/transfer/§5.5-pollingDeadline-propagation.test.ts` — **W17**: pollingDeadline propagation to T.5.B's polling loop in outbox path.
  - NEW: `tests/unit/payments/transfer/§5.5-2x-window-safety-net.test.ts` — **W26**: 2× POLLING_WINDOW safety net via deterministic clock.
- **depends_on**: T.1.A, T.1.C, T.1.F, T.5.A, T.5.B.0, T.6.A.
- **parallel_with**: T.5.F (only — see note below).
  - **Note (round-3 fix)**: T.5.B and T.5.C are NOT peers. T.5.C transitively depends on T.5.B via T.5.B.5 (`T.5.C depends_on T.5.B.5; T.5.B.5 depends_on T.5.B`). The serial chain `T.5.B → T.5.B.5 → T.5.C` is the correct ordering, matching §1 critical-path. Do not run T.5.C in parallel with T.5.B.
- **skill_tag**: `worker`
- **acceptance**:
  - Configuration validity rule (§5.5 step 6 paragraph "Configuration validity rule (normative)") validated at startup; cumulative backoff for the first MIN_POLL_ATTEMPTS polls ≤ POLLING_WINDOW.
  - Hard safety-net: worker terminates after `2 × POLLING_WINDOW` regardless of MIN_POLL_ATTEMPTS (W26).
  - Transient errors do NOT count toward MIN_POLL_ATTEMPTS.
  - 4-step write order followed (delegated to T.5.B.0 module); crash-resume produces convergent state on each step.
  - **C12**: race-lost detected via `REQUEST_ID_EXISTS` at submit + `OK` with mismatching `transactionHash` at poll. NOT via `REQUEST_ID_MISMATCH`.
  - **C12/C13**: `REQUEST_ID_MISMATCH` → hard-fail, reason='client-error' (operator alert).
  - **C10**: two-different-values proof → `transfer:security-alert` emitted; refuse merge.
  - **W16**: most-recent-proof tombstone-after-replacement path triggered by FRESH proof for already-attached requestId.
  - **W14**: per-aggregator concurrency cap default 16 enforced.
  - **W17**: `pollingDeadline` propagation to outbox path explicit test.
  - On hard-fail, **delegate cascade to T.5.B.5 walker (C3 applied: T.5.B no longer owns cascade — it's a consumer of T.5.B.5)**.
- **est_loc**: 1580 (was 1180; +400 per round-2 W7 — restoring 1:1.5 impl:test ratio for race-lost / conflicting-proofs / retry / trustbase deterministic-clock tests).
- **risks**: subtle deadline-vs-attempt-count interaction — every state transition has a directed test; deterministic-clock test harness used throughout.
- **spec_refs**: §6.1, §5.5 step 5–6, §6.3.

---

#### T.5.B.5 — Cascade walker (per-class: coin via splitParent, NFT via outbox-driven) — NEW, dedicated owner

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/cascade-walker.ts` (~340 LOC) — **C3 + C11 applied**. Single owner of the cascade logic. Two paths:
    - **Coin path** (token from `classifyToken` returns `'coin'`): walk `splitParent` references via local manifest scan; mark each child invalid (reason='parent-rejected'); emit `transfer:cascade-failed` for any outgoing outbox entries referencing the cascaded children.
    - **NFT path** (token from `classifyToken` returns `'nft'`): NO `splitParent` walk. Examine outbox entries that shipped this NFT in instant mode; emit `transfer:cascade-failed` per recipient-pubkey + tokenId. Best-effort delivery; recipients independently arrive at the same disposition.
  - **Race-lost special case**: cascade does NOT fire for `reason='race-lost'` (per §6.1.1). Test asserts.
  - **Bounded depth**: MAX_CHAIN_DEPTH=64; cycle defense via visited-set (per-call-stack scope, NOT global — W32).
  - **Parent-flip protection**: re-read parent inside CAS payload (W27 deterministic-interleaving test).
  - NEW: `tests/unit/payments/transfer/cascade-walker-coin.test.ts` — coin-path cascade walks splitParent references.
  - NEW: `tests/unit/payments/transfer/cascade-walker-nft.test.ts` — NFT-path cascade emits outbox-driven notifications without splitParent walk (C11).
  - NEW: `tests/unit/payments/transfer/cascade-walker-race-lost-no-fire.test.ts` — race-lost does NOT trigger cascade.
  - NEW: `tests/unit/payments/transfer/cascade-walker-cycle-defense.test.ts` — corrupted splitParent does not infinite-loop.
  - NEW: `tests/unit/payments/transfer/§6.1.1-cascade-parent-flip.test.ts` — **W27 deterministic-interleaving**.
  - NEW: `tests/unit/payments/transfer/cascade-visited-set-scope.test.ts` — **W32: per-call-stack, not global**.
- **depends_on**: T.1.A, T.1.C, T.1.F, T.2.B (for `classifyToken`), T.5.B.
- **parallel_with**: T.5.C.
- **skill_tag**: `recipient`
- **acceptance**:
  - **C11**: coin-class cascade walks `splitParent`; NFT-class cascade emits outbox-driven `transfer:cascade-failed` events.
  - Race-lost reason → cascade does NOT fire.
  - Cycle defense (visited-set, per-call-stack — W32) prevents infinite recursion on corrupted manifest.
  - Parent-flip protection re-reads inside CAS (W27).
  - T.5.B and T.5.D consume this walker; they do NOT own cascade logic.
- **est_loc**: 540.
- **risks**: shared between sender and recipient workers; ensure thread-safe access to visited-set.
- **spec_refs**: §6.1.1, §6.1, §4.1.

---

#### T.5.C — Recipient-side finalization worker + per-address finalization queue + step-9 re-evaluator

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/finalization-queue.ts` (~280 LOC) — typed wrapper over OrbitDB-backed per-address queue keyed `${addr}.finalizationQueue.${entryId}` (per Wave G.7 layout). Add/remove/list/lookupByTokenId.
  - NEW: `modules/payments/transfer/finalization-worker-recipient.ts` (~580 LOC) — same logic as T.5.B but driven by the per-address finalization queue rather than the outbox. Implements §5.5 steps 1–9 including the queue-drain status transition with re-run [B]/[D]/[E] under per-tokenId lock (CAS-based path preferred; T.1.F provides all 3 strategies — selection via config, W34).
  - **Step-9 re-evaluator (W5)**: `revaluate(tokenId, identity, oracle)` entry-point in disposition-engine integration.
  - **Race-lost detection (C12)**: identical to T.5.B — REQUEST_ID_EXISTS at submit + OK-with-mismatching-transactionHash at poll.
  - **§5.6 idempotency invariant adversarial test (W15)**.
  - NEW: `tests/unit/payments/transfer/finalization-queue.test.ts`, `finalization-worker-recipient.test.ts` — single-tx PENDING; chain-mode K=3; queue-drain re-runs [B]/[D]/[E]; concurrent ingest while queue is draining; merge-path (§5.5 last paragraph) with grafted proofs.
  - NEW: `tests/unit/payments/transfer/§5.6-idempotency-invariant.test.ts` — **W15 adversarial: replay with different proof, same transactionHash, must converge**.
  - NEW: `tests/unit/payments/transfer/disposition-engine-revaluate.test.ts` — **W5: step-9 re-evaluator entry-point**.
- **depends_on**: T.1.A, T.1.C, T.1.E (`finalization_queue` key), T.1.F, T.3.B.1, T.3.B.2, T.3.C, T.3.D, T.5.B.0 (polling-policy + manifest-cid-rewrite — peer dep, NOT through T.5.B), **T.5.B.0.5 (fairness queue — recipient consumes per ADR-005, round-3 fix)**, T.5.B.5 (cascade walker — recipient worker invokes cascade on hard-fail, must depend on the walker).
- **parallel_with**: T.5.D (peers — both downstream of T.5.B.5). NOT T.5.B (transitively dependent via T.5.B.5; round-3 critical fix mirror — round-4 C1).

  **Acceptance addendum (C3 fix, refined per round-2 W4)**: on hard-fail of any queue entry for a `tokenId`, the recipient worker MUST invoke T.5.B.5 cascade-walker. Recipient-side cascade semantics (clarified):
   - **Coin path**: a recipient who has not split or forwarded the received token has no `splitParent` references locally — the coin-class walk is a NO-OP (zero children). This is the typical case (recipient just received it). The walk is required only for chain-mode recipients who themselves split the received token in instant mode before resolution.
   - **NFT path**: the recipient invokes the outbox-driven notification only if THEY have an outbox entry forwarding the failed-NFT to a further downstream recipient. Pure-receive (no forward) → no notification fires.
   - **Self-invalidation**: in BOTH classes, the recipient's own copy of the token transitions to `_invalid` (reason='oracle-rejected' or 'race-lost' per source).
   Tests:
   - `recipient-cascade-on-hard-fail.test.ts` — hard-fail self-invalidates the received token.
   - `recipient-cascade-no-children.test.ts` — pure-receive case (no local splits/forwards) → coin walk is no-op; NFT notification empty.
   - `recipient-cascade-with-forward.test.ts` — recipient who forwarded the received NFT in instant mode emits `transfer:cascade-failed` for the further-downstream recipient.
- **skill_tag**: `worker`
- **acceptance**:
  - K queue entries per K-deep chain-mode token; transition `pending → valid` only after all K resolve successfully.
  - Queue drain re-runs [B]/[D]/[E] under CAS per §5.5 step 9 lock-vs-RPC release rule (CAS-default; lock-with-RPC-release fallback; lock-with-bounded-hold last resort — W34).
  - Tombstone retention 30 days post-canonical-stable; GC test.
  - Merge-path: arriving more-finalized copy grafts proofs in, removes corresponding queue entries WITHOUT aggregator round-trip.
  - **C12**: race-lost detected via poll-mismatch path.
  - **W5**: step-9 `revaluate(tokenId, identity, oracle)` entry-point on disposition-engine.
  - **W15**: §5.6 idempotency invariant — replay with different proof but same transactionHash converges.
- **est_loc**: 1740 (was 1240; +500 per round-2 W7 — restoring 1:1.5 impl:test ratio for queue-drain / re-evaluator / cascade-on-hard-fail / step-9 atomic update tests).
- **risks**: locking semantics under concurrent ingest + finalization on same tokenId — exhaustive state-machine test with deterministic interleavings.
- **spec_refs**: §5.5, §5.6, §6.2.

---

#### T.5.D — `importInclusionProof` + `revalidateCascadedChildren` (no cascade-walker — owned by T.5.B.5)

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/import-inclusion-proof.ts` (~280 LOC) — implements §6.3 `importInclusionProof(tokenId, proofBytes, options)` with **10 sub-cases** (W4: cases 1, 2, 3, 4a, 4b, 5, 6, 7, 8, 9 — was incorrectly listed as 9).
  - NEW: `modules/payments/transfer/revalidate-cascaded.ts` (~220 LOC) — `revalidateCascadedChildren(parentTokenId): RevalidationResult`. Transitive by default; bounded depth; cycle visited-set (per-call-stack, W32). **Calls T.5.B.5 cascade-walker for the actual walk** (C3 — T.5.D is consumer, not author).
  - MODIFIED: `modules/payments/PaymentsModule.ts` — expose `revalidateCascadedChildren` and `importInclusionProof` on the public API.
  - **Operator override audit trail (W30 + W31 + N4)**: `importInclusionProof({allowInvalidOverride: true})` records `overrideAppliedAt`, `overrideAppliedBy` audit-trail fields on the override record; emits `transfer:override-applied` event.
  - NEW: `tests/unit/payments/transfer/import-inclusion-proof.test.ts` — **all 10 sub-cases (W4)**: 1, 2, 3, 4a, 4b, 5, 6 (K-1 re-queue), 7, 8, 9. Each covered.
  - NEW: `tests/unit/payments/transfer/import-inclusion-proof-client-error.test.ts` — **C13: handles `'client-error'` reason path on storage**.
  - NEW: `tests/unit/payments/transfer/revalidate-cascaded.test.ts`.
  - NEW: `tests/unit/payments/transfer/override-audit-trail.test.ts` — **W30/W31/N4: overrideAppliedAt + transfer:override-applied event**.
- **depends_on**: T.1.A, T.1.C, **T.1.E (C4 applied)**, T.1.F, T.3.C (writes to `_invalid`), T.5.B (manifest-cid-rewrite via T.5.B.0), T.5.B.5 (cascade-walker), T.5.C.
- **parallel_with**: (none — T.5.E and T.5.F are downstream of T.5.D; round-5 W1 fix).
- **skill_tag**: `recipient`
- **acceptance**:
  - **W4**: all 10 sub-cases of §6.3 `importInclusionProof()` covered by tests, including the K-1 re-queue branch (case 6).
  - `allowInvalidOverride: false` is the default; explicit `true` required to flip out of `_invalid`.
  - Sticky `overrideApplied: true` on outbox entry persists across CRDT merges (T.6.B).
  - **W30/W31/N4**: override audit trail (`overrideAppliedAt`, `overrideAppliedBy`) recorded; `transfer:override-applied` event emitted on operator override.
  - Cascade is bounded; cycle test with corrupted `splitParent` does not infinite-loop. **W32: visited-set is per-call-stack, not global.**
  - **C3**: cascade walking is delegated to T.5.B.5; T.5.D is a consumer.
  - **C13**: `'client-error'` reason path handled correctly when writing to `_invalid`.
  - **C4 dependency on T.1.E**: writes to `_invalid` (cases 5/6 importInclusionProof) and to manifest after override use the new key prefixes — explicit dep on T.1.E.
- **est_loc**: 1120 (was 1180; -60 since cascade-walker moved to T.5.B.5; +60 for W30/W31/N4 audit trail tests).
- **risks**: edge cases in case 6 (K-1 re-queue with fresh `submittedAt`) — tested with deterministic clock.
- **spec_refs**: §6.1.1, §6.3.

---

#### T.5.E — `transfer:trustbase-warning` + `transfer:security-alert` + `transfer:cascade-risk-warning` + `transfer:cascade-failed` + `transfer:override-applied` events

- **wave**: T.5
- **files_touched**:
  - MODIFIED: `types/index.ts` — extend `SphereEventType` and `SphereEventMap` with the **5 new events** (added `transfer:override-applied` from W31).
  - MODIFIED: appropriate workers (T.5.B sender; T.5.B.5 cascade walker; T.5.C recipient; T.5.D override path) to emit the events at the spec'd paths.
  - NEW: `tests/unit/types/sphere-events-uxf.test.ts` — type-level test that the new events are typed.
  - NEW: `tests/integration/transfer/trustbase-warning.test.ts` — simulate stale trustBase NOT_AUTHENTICATED → trustbase-warning emitted, refresh attempted, retry succeeds.
  - NEW: `tests/integration/transfer/security-alert.test.ts` — sustained NOT_AUTHENTICATED after refresh in conservative mode → security-alert.
  - NEW: `tests/integration/transfer/security-alert-conflicting-proofs.test.ts` — **C10: two-different-values proof for same requestId → security-alert**.
  - NEW: `tests/integration/transfer/override-applied-event.test.ts` — **W31: emit on operator override**.
  - NEW: `tests/integration/transfer/operator-override-audit-listener.test.ts` — **N4: operator override audit trail event listener**.
- **depends_on**: T.5.B, T.5.B.5, T.5.C, T.5.D.
- **parallel_with**: (none — T.5.F is downstream of T.5.E; round-5 W2 fix).
- **skill_tag**: `worker`
- **acceptance**:
  - Event payloads exactly match spec (§9.4, §6.3 forbidden-path, §6.1.1 cascade-risk-warning, §6.3 most-recent-proof override).
  - `transfer:security-alert` is reserved for §9.4.1 explicit out-of-scope cases AND §6.3 forbidden-path (two-different-values for same requestId, C10); trustbase-warning is the routine case.
  - `transfer:override-applied` emitted on every `importInclusionProof({allowInvalidOverride: true})` success.
- **est_loc**: 360 (was 280; +80 for W31/N4 + C10).
- **risks**: false-positive security-alert from a benign trustBase refresh race — make the alert fire only AFTER the refresh path is exhausted.
- **spec_refs**: §6.3, §9.4, §9.4.1.

---

#### T.5.F — trustBase staleness detection + refresh on NOT_AUTHENTICATED (NEW — W41)

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/trustbase-staleness.ts` (~220 LOC) — **W41 applied**: exposes `isTrustBaseStale(): boolean`, `refreshTrustBase(): Promise<void>`. Workers (T.5.B, T.5.C) call `refreshTrustBase()` on first NOT_AUTHENTICATED before retrying. If the second attempt also returns NOT_AUTHENTICATED, escalate to `transfer:security-alert`.
  - MODIFIED: `modules/payments/transfer/finalization-worker-sender.ts` (T.5.B) — invoke `refreshTrustBase()` on NOT_AUTHENTICATED.
  - MODIFIED: `modules/payments/transfer/finalization-worker-recipient.ts` (T.5.C) — invoke `refreshTrustBase()` on NOT_AUTHENTICATED.
  - NEW: `tests/unit/payments/transfer/trustbase-staleness.test.ts`.
  - NEW: `tests/integration/transfer/trustbase-refresh-on-not-authenticated.test.ts`.
- **depends_on**: T.5.B, T.5.C, T.5.E.
- **parallel_with**: none — sits at the bottom of T.5.
- **skill_tag**: `worker`
- **acceptance**:
  - First NOT_AUTHENTICATED → emit `transfer:trustbase-warning`, refresh, retry.
  - Second NOT_AUTHENTICATED after refresh → emit `transfer:security-alert`, hard-fail with reason='proof-invalid' (per §6.1).
  - Refresh is debounced (one in flight per-aggregator).
- **est_loc**: 360.
- **risks**: refresh storm — debounce + cool-down.
- **spec_refs**: §6.1, §9.4.

---

### T.6 — Outbox refactor

T.6 ships the bundle-grained `UxfTransferOutboxEntry`, the §7.0 status-transition table, the §7.1 CRDT merge invariants, and the §7.2 legacy migration. T.6 is **structurally** independent of T.2/T.3/T.5, so T.6.A and T.6.B can land in parallel with sender/recipient work — but those waves transitively depend on T.6.A landing the outbox writer.

**T.6.B is split into 3 files (Note N3) + property-based tests via fast-check (W9).** **T.6.D adds a backup-restore sub-task T.6.D.2 (C7).**

---

#### T.6.A — `UxfTransferOutboxEntry` schema + per-entry-key writer

- **wave**: T.6
- **files_touched**:
  - NEW: `types/uxf-outbox.ts` (~140 LOC) — `UxfTransferOutboxEntry` per §7.
  - NEW: `profile/outbox-writer.ts` (~340 LOC) — typed wrapper writing to `${addr}.outbox.${id}` (per-entry-key, Wave G.7). Bumps Lamport on every write per §7.1.
  - MODIFIED: `profile/profile-token-storage-provider.ts` — extend the per-entry-key reader to recognize the new entry shape (legacy entries continue to read via the existing decoder; new entries use the new decoder; selection by entry-shape sniffing).
  - NEW: `tests/unit/profile/outbox-writer.test.ts` — write/read round-trip; Lamport bump on update; per-entry-key isolation (writes don't trample siblings).
- **depends_on**: T.1.A, T.1.B.1, T.1.F.
- **parallel_with**: T.6.B (CRDT merger), T.6.C (state machine validator), T.6.D (legacy migration).
- **skill_tag**: `outbox`
- **acceptance**:
  - Per-entry-key writer commits under `${addr}.outbox.${id}`.
  - Lamport bump rule from T.1.F applied; observed remote Lamports queried before write.
  - Reading an entry with the legacy `OutboxEntry` shape returns it via the legacy decoder; readers handle both forms during the migration window.
- **est_loc**: 480.
- **risks**: schema-sniff confusion between legacy (`status: 'pending' | 'submitted' | ...`) and new (`status: 'packaging' | 'pinned' | ...`). Use a dedicated `_schemaVersion: 'uxf-1' | 'legacy'` field on the new entries; legacy entries lack it.
- **spec_refs**: §7, §7.0, PA §10.12, INV §11.

---

#### T.6.B — CRDT merger (3-file split): status partition + override stickiness + two-set requestIds + property-based tests

- **wave**: T.6
- **files_touched**:
  - NEW: `profile/outbox-merger-status.ts` (~180 LOC) — **N3 split**: status partition + override stickiness exception.
  - NEW: `profile/outbox-merger-requestids.ts` (~150 LOC) — **N3 split**: two-set requestId merge.
  - NEW: `profile/outbox-merger-error-fields.ts` (~120 LOC) — **N3 split**: error-field rule (more-advanced status wins; tie by earlier-Lamport).
  - NEW: `profile/outbox-merger.ts` (~80 LOC) — top-level orchestrator, combines the three above.
  - NEW: `tests/unit/profile/outbox-merger.test.ts` — 30+ targeted tests covering each row of §7.1.
  - NEW: `tests/unit/profile/outbox-merger.property.test.ts` (~300 LOC) — **W9: property-based tests via fast-check** (commutative merge, idempotent merge, monotonic Lamport, set-OR for `audit_promoted_from`).
  - NEW: `tests/unit/profile/outbox-merger-g-counter-rule4.test.ts` — **W28: G-counter rule 4 (submitRetryCount, proofErrorCount max-merge)**.
  - NEW: `tests/unit/profile/outbox-merger-audit-promoted-from.test.ts` — **W45: `audit_promoted_from` array merge as set-OR**.
- **depends_on**: T.6.A.
- **parallel_with**: T.6.C, T.6.D.
- **skill_tag**: `crdt`
- **acceptance**:
  - All §7.1 conflict rules (1–6) covered.
  - `failed-permanent` vs `finalizing` with `overrideApplied: true` → `finalizing` wins regardless of Lamport.
  - `outstanding := union(A_outstanding, B_outstanding) - union(A_completed, B_completed)` (NOT plain set-union; verified by an adversarial test with stale replica re-introducing a completed requestId).
  - **C12 race-lost CRDT acceptance**: two-replica race: same source state → REQUEST_ID_EXISTS on second submit + poll mismatch detection → loser's outbox entry transitions to `failed-permanent` reason='race-lost'; cascade does NOT fire for race-lost (delegated to T.5.B.5 which respects the special case).
  - **W28**: G-counter max-merge for `submitRetryCount`, `proofErrorCount`.
  - **W45**: `audit_promoted_from` array merge as set-OR (adding [a,b] ∪ [b,c] = [a,b,c]).
  - **W9**: property-based tests via fast-check confirm commutativity and idempotency.
- **est_loc**: 1060 (was 760; +300 for property-based tests + N3 split + W28 + W45).
- **risks**: Lamport tie-break correctness across replica restarts — driven by T.1.F primitives.
- **spec_refs**: §7.1.

---

#### T.6.C — Status-transition validator + state machine guards + dual-write mode formalized

- **wave**: T.6
- **files_touched**:
  - NEW: `profile/outbox-state-machine.ts` (~260 LOC) — validates every `status` transition against the §7.0 table; throws `INVALID_OUTBOX_TRANSITION` on disallowed moves. Used by `outbox-writer` (T.6.A) on every update. **W43**: dual-write mode formalized in §7 outbox state machine — explicit `dual-write` arc allowed during migration window.
  - NEW: `tests/unit/profile/outbox-state-machine.test.ts` — every legal transition (and a sample of illegal ones) tested.
  - NEW: `tests/unit/profile/outbox-state-machine-dual-write.test.ts` — **W43**: dual-write transition arcs validated.
- **depends_on**: T.6.A.
- **parallel_with**: T.6.B, T.6.D.
- **skill_tag**: `outbox`
- **acceptance**:
  - Disallowed transitions (e.g., `delivered → packaging`) throw with a typed error.
  - The override path `failed-permanent → finalizing` is allowed only when the writer sets `overrideApplied: true` in the same write.
  - The terminal states (`expired`, `finalized`, `failed-permanent` modulo override) are enforced.
  - **W43**: dual-write arcs (`legacy ↔ uxf`) allowed during migration window only.
- **est_loc**: 420 (was 360; +60 for W43 dual-write).
- **risks**: spec drift between §7.0 table and this validator — table is the single source of truth; auto-generate validator from a typed transition table.
- **spec_refs**: §7.0.

---

#### T.6.D — Legacy outbox → bundle-grained migration (§7.2) + backup write

- **wave**: T.6
- **files_touched**:
  - NEW: `profile/migration-outbox.ts` (~420 LOC) — implements §7.2 verbatim. Group legacy entries by `(recipientPubkey, createdAt-window=60s)`; synthesize one `UxfTransferOutboxEntry` per group; `mode: 'txf'`; preserve `recipientNametag`. **C7 applied**: explicit backup write to `${addr}.legacyOutbox.backup` BEFORE legacy clear; ordering invariant: backup → migrate → sentinel → clear-legacy; idempotent under partial-migration crash.
  - **Status mapping**: legacy `delivered|confirmed → 'finalized'`; `pending → 'sending'`; `failed → 'failed-permanent'`. One-way migration; legacy collection cleared after.
  - **`recipientNametag` handling (W18)**: explicitly first-class field on `UxfTransferOutboxEntry` (not error-metadata fallback). T.6.D.acceptance declares the choice.
  - MODIFIED: `types/uxf-outbox.ts` — add `recipientNametag?: string` field to preserve §7.2 paragraph 4.
  - NEW: `tests/unit/profile/migration-outbox.test.ts` — single-token legacy entry → synthetic bundle with `bundleCid='txf-' + tokenId`; multi-token legacy group → synthetic combined bundle with `bundleCid='legacy-' + recipientPubkey + '-' + createdAt`; nametag preservation; one-way (re-running migration is a no-op).
  - NEW: `tests/unit/profile/migration-outbox-backup-ordering.test.ts` — **C7**: backup → migrate → sentinel → clear ordering; partial-crash idempotency.
  - NEW: `tests/fixtures/wallets/legacy-outbox-pre-T6D/` — fixture wallet with mixed legacy entries.
- **depends_on**: T.6.A.
- **parallel_with**: T.6.B, T.6.C.
- **skill_tag**: `migration`
- **acceptance**:
  - Legacy fixture migrates cleanly; resulting bundle-grained outbox passes T.6.C state-machine validation.
  - **C7 explicit backup**: `${addr}.legacyOutbox.backup` written BEFORE clearing legacy; ordering invariant holds; idempotent under partial-migration crash.
  - **W18: `recipientNametag` is first-class** (preserved on `UxfTransferOutboxEntry.recipientNametag`); not via error-metadata fallback. Acceptance row makes the choice explicit.
  - One-way: a second run of migration on an already-migrated wallet is a no-op (no double-migration).
  - Migration runs under the per-feature flag `features.outbox === 'dual-write' || 'uxf'`; legacy wallets without the flag don't trigger migration.
- **est_loc**: 700 (was 580; +120 for C7 backup ordering + W18).
- **risks**: edge case: legacy entry with no `recipientNametag` AND failing-state — ensure synthetic entry's `recipient` is the pubkey form (preserves UI display continuity).
- **spec_refs**: §7.2, §10.3.

---

#### T.6.D.2 — Restore script + round-trip test (NEW — C7)

- **wave**: T.6
- **files_touched**:
  - NEW: `tools/restore-legacy-outbox.ts` (~280 LOC) — **C7 applied**: standalone CLI tool that reads `${addr}.legacyOutbox.backup` and re-creates the legacy entries in `_outbox` field. Idempotent.
  - NEW: `tests/integration/profile/legacy-outbox-restore-roundtrip.test.ts` — full round-trip: write legacy → migrate (T.6.D) → backup verify → restore → assert byte-identity to original.
- **depends_on**: T.6.D.
- **parallel_with**: T.6.E.
- **skill_tag**: `migration`
- **acceptance**:
  - Restore script reads backup, writes legacy entries cleanly.
  - Round-trip: legacy → migrate → restore → byte-identical to original (modulo Lamport).
  - **C7 PR gating**: T.8.D merge gated on this test passing.
- **est_loc**: 380.
- **risks**: backup format drift — pin to a versioned schema; future migrations bump version + add migrator.
- **spec_refs**: §7.2 paragraph 5, §7.C back-out.

---

#### T.6.E — Pre-publish persistence ordering + crash-recovery test harness

- **wave**: T.6
- **files_touched**:
  - MODIFIED: `modules/payments/transfer/conservative-sender.ts`, `instant-sender.ts` — strict ordering: outbox commit (`status='sending'` or `'delivered-instant'`) BEFORE Nostr publish dispatch.
  - NEW: `tests/integration/transfer/crash-recovery.test.ts` — fault-inject between outbox commit and Nostr publish; restart Sphere; verify outbox shows `sending` on restart and re-publish is idempotent (same bundleCid).
- **depends_on**: T.6.A, T.6.C, T.2.D.2, T.5.A.
- **parallel_with**: T.6.D.2.
- **skill_tag**: `tests`
- **acceptance**:
  - Crash between outbox commit and Nostr publish → restart re-publishes the SAME bundleCid (idempotent at recipient).
  - Crash between Nostr publish ack and outbox status update → restart DOES NOT republish (the `delivered` transition is the durability anchor; if ack was received but status not yet committed, the next worker pass will commit).
- **est_loc**: 240.
- **risks**: subtle ordering bug — the test must be deterministic via a fault-injection seam, not a sleep loop.
- **spec_refs**: §6.3 last paragraph, §7.0 paragraph "pre-publish persistence ordering".

---

### T.7 — TXF mode as explicit opt-in + production call-site migration

T.7 implements `transferMode: 'txf'` (both `txfFinalization` variants), the receiver-side legacy adapter that routes the four legacy shapes through the §5.3 decision matrix, and the migration of all production call-sites that currently rely on the legacy single-coin TXF path.

**T.7.C call-site count corrected (C5)**: 6 in AccountingModule, **0** in SwapModule (uses `accounting.payInvoice()`), **0** in ConnectHost (delegates to dApp wallet host's `onIntent` callback — see new T.7.C.5), 1 in CLI, 1 internal recursive in PaymentsModule, 37 in tests. **T.7.D re-targeted from "find any payments.send() in SwapModule" to "expose `allowPendingTokens` knob in `accounting.payInvoice()` for §2.5 forced-conservative coercion".** **T.7.B adds the nametag re-resolution sub-task T.7.B.5 (C9).**

---

#### T.7.A — TXF sender for `transferMode: 'txf'` (both finalization variants)

- **wave**: T.7
- **files_touched**:
  - NEW: `modules/payments/transfer/txf-sender.ts` (~440 LOC) — implements §4.4.1 (conservative TXF) and §4.4.2 (instant TXF). Per-token Nostr events; outbox uses synthetic `bundleCid='txf-' + tokenId` and `deliveryMethod='txf-legacy'`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — replace the T.1.B.1 `UNSUPPORTED_TRANSFER_MODE` placeholder; route `transferMode === 'txf'` to `txf-sender` based on `txfFinalization`.
  - NEW: `tests/unit/payments/transfer/txf-sender.test.ts` — conservative TXF (1, 5, 100 tokens); instant TXF (1, 5, 100 tokens); per-token outbox entries; mode tag preserved.
- **depends_on**: T.1.B.1, T.5.B (for instant-TXF finalization), T.6.A, T.6.C.
- **parallel_with**: T.7.B, T.7.C.
- **skill_tag**: `sender`
- **acceptance**:
  - Conservative TXF: N tokens → N Nostr events; outbox has N entries each with `mode: 'txf'`, `status: 'delivered'` after each ack.
  - Instant TXF: same but `status: 'delivered-instant'`; sender-side worker (T.5.B) drives finalization per-token.
  - The exhaustive-switch arm in PaymentsModule no longer throws; `transferMode === 'txf'` works end-to-end.
- **est_loc**: 720.
- **risks**: instant-TXF + chain-mode (forwarder dies mid-chain) — the per-token outbox MUST carry the inherited unfinalized commitmentRequestIds; verified by `tests/unit/payments/transfer/txf-instant-chain.test.ts`.
- **spec_refs**: §2.4, §4.4, §10.1.

---

#### T.7.B — Legacy receiver adapter: route 4 legacy shapes through §5.3

- **wave**: T.7
- **files_touched**:
  - NEW: `modules/payments/transfer/legacy-shape-adapter.ts` (~480 LOC) — given `LegacyTokenTransferPayload` (one of the 4 shapes from §3.4), produces N synthetic single-token disposition passes through T.3.B.2's disposition engine. Bundle-level checks (§5.2) skipped (no CAR / no bundleCid). Inbound shapes with `inclusionProof: null` recognized as instant-TXF and routed through the chain-mode finalization queue (T.5.C).
  - MODIFIED: `modules/payments/PaymentsModule.ts` — `handleIncomingTransfer()` routing: `kind: 'uxf-car' | 'uxf-cid'` → bundle-acquirer (T.3.A); legacy shape → `legacy-shape-adapter`. The two paths reach the same downstream disposition writer (T.3.C).
  - NEW: `tests/unit/payments/transfer/legacy-shape-adapter.test.ts` — `{sourceToken, transferTx}` → 1 disposition; `COMBINED_TRANSFER` with N tokens → N dispositions; `INSTANT_SPLIT` with N split outputs → N dispositions; `{token, proof}` SDK legacy → 1 disposition; instant-TXF (inclusionProof:null) → routed through finalization queue.
- **depends_on**: T.3.B.2, T.3.C, T.5.C.
- **parallel_with**: T.7.A, T.7.C (T.7.B.5 is downstream — round-5 W3 fix).
- **skill_tag**: `recipient`
- **acceptance**:
  - All 4 legacy shapes produce the same set of outcomes (VALID/PENDING/PROOF_INVALID/STRUCTURAL_INVALID/NOT_OUR_CURRENT_STATE/UNSPENDABLE_BY_US/CONFLICTING) as the equivalent UXF bundle would.
  - Per-token granularity: one legacy event → ONE OR MORE disposition records.
  - Instant-TXF arrivals merge into the OrbitDB profile with the same finalization-queue semantics as instant-UXF.
- **est_loc**: 820.
- **risks**: V5 INSTANT_SPLIT vs V6 COMBINED_TRANSFER detection ambiguity — the detector from T.1.A runs in `bundle-acquirer.ts`; the adapter only sees a typed shape after detection.
- **spec_refs**: §10.2, §3.4.

---

#### T.7.B.5 — Nametag re-resolution at receive (NEW — C9)

- **wave**: T.7
- **files_touched**:
  - NEW: `modules/payments/transfer/nametag-reresolver.ts` (~180 LOC) — **C9 applied**: gates UI nametag display through `transport.resolveTransportPubkeyInfo()`. The `payload.sender.nametag` field is treated as untrusted; the canonical nametag is the one bound to the Nostr signing pubkey via the identity binding event. Result: `{nametag: string | null, source: 'binding-event' | 'untrusted-payload'}`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — call re-resolver before emitting `transfer:incoming` events; UI consumers see the binding-event nametag.
  - NEW: `tests/unit/payments/transfer/nametag-reresolver.test.ts`.
  - NEW: `tests/adversarial/transfer/forged-nametag.test.ts` — **C9 adversarial**: hostile sender ships `payload.sender.nametag = 'alice'` while signing with Bob's pubkey. Re-resolved peerInfo shows `nametag = 'bob' | null`, NOT `'alice'`.
- **depends_on**: T.7.B.
- **parallel_with**: T.7.C, T.7.D, T.7.E.
- **skill_tag**: `recipient`
- **acceptance**:
  - **C9**: re-resolved peerInfo.nametag wins over `payload.sender.nametag` in UI display.
  - Adversarial forged-nametag test asserts the binding-event nametag is the canonical one.
- **est_loc**: 320.
- **risks**: cache invalidation for nametag binding events — defer to existing transport.resolveTransportPubkeyInfo TTL.
- **spec_refs**: §3.1, §5.6, §9.3.

---

#### T.7.C — Production call-site migration: AccountingModule + CLI + internal PaymentsModule recursion

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `modules/accounting/AccountingModule.ts` — **6 call sites (C5 verified)**: `AccountingModule.ts:2465, 2710, 3655, 3819, 4134, 5812`. Each now passes `transferMode` explicitly; default behavior (`transferMode: 'instant'`) is the new default.
  - MODIFIED: `cli/index.ts:2831` — replace the `forceConservative ? 'conservative' : 'instant'` ternary with explicit `transferMode` selection; ensure `--mode txf` is wired if the CLI exposes it.
  - MODIFIED: `modules/payments/PaymentsModule.ts:2799` — internal recursive `payments.send()` call updated to pass explicit `transferMode`.
  - **NOT touched**: SwapModule (uses `accounting.payInvoice()`, see T.7.D); ConnectHost (delegates to dApp wallet host's `onIntent`, see T.7.C.5).
  - NEW: `tests/integration/accounting/uxf-transfer.test.ts` — invoice payment goes through new UXF path; verify byte-identical bundle to expected fixture (T.8.A).
  - NEW: `tests/integration/cli/uxf-transfer.test.ts` — CLI `transfer` and `pay` commands go through new UXF path.
- **depends_on**: T.1.B.1, T.7.A.
- **parallel_with**: T.7.B, T.7.B.5, T.7.C.5, T.7.D.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - All 6 AccountingModule sites migrated.
  - CLI defaults preserved (no UX regression for the `transfer` and `pay` commands).
  - Internal recursive PaymentsModule:2799 site migrated.
  - Byte-identical bundle assertion on the regression fixture (T.8.A).
- **est_loc**: 420 (was 380; +40 for verified call-site list).
- **risks**: a hidden call site in `cli/` or `tests/e2e/` — run `git grep -n 'payments\.send'` and triage every result.
- **spec_refs**: §10.1.

---

#### T.7.C.5 — ConnectHost coordination + external repo type-widening (NEW — C5)

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `connect/ConnectHost.ts` — emit `onIntent` schema-version field on the intent payload (`schemaVersion: 'uxf-1' | 'legacy'`). dApp-side wallet hosts (in external repos: agentsphere, sphere app, etc.) MUST widen their `onIntent` callback type to accept the new shape.
  - NEW: `docs/uxf/CONNECT-HOST-MIGRATION-NOTE.md` — changelog entry for external integrators.
  - NEW: `tests/unit/connect/connect-host-schema-version.test.ts`.
- **depends_on**: T.7.A, T.7.C.
- **parallel_with**: T.7.B.5, T.7.D, T.7.E.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - ConnectHost emits `schemaVersion` on every `onIntent` payload.
  - External integrators have a documented widening path.
  - **C5**: the call-site count for ConnectHost is 0 in our repo; coordination is via documentation + schema-version field, not via direct widening of our call-sites.
- **est_loc**: 220.
- **risks**: external-repo breakage — proactively notify agentsphere + sphere app maintainers; release-note entry.
- **spec_refs**: §10.1, docs/CONNECT.md.

> **⚠️ T.7.C.5 is a documentation + schema-version task, NOT an end-to-end implementation task** (round-1 steelman finding #10). The **actual external-repo migration** (agentsphere, sphere app, openclaw-unicity, third-party dApps) is unsolved by this task — only documented. Concrete tracking item for T.8.D blocker:
>
> - **agentsphere**: PR landing the widened `onIntent` callback shape — required before T.8.D.
> - **sphere app**: PR landing the widened `onIntent` callback shape — required before T.8.D.
> - **openclaw-unicity**: ditto (if used).
>
> Without external acks, T.8.D removes legacy code while external integrators still rely on the old `onIntent` shape. Add to T.8.D depends_on a non-code "external-acks-received" gating note: "T.8.D MUST NOT merge until at least the agentsphere + sphere app maintainers have ack'd the widened type shape." Until then, T.8.D is BLOCKED on coordination, not on plan implementation.

---

#### T.7.D — Forced-conservative coercion: expose `allowPendingTokens` knob in `accounting.payInvoice()` (RE-TARGETED — C5)

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `modules/accounting/AccountingModule.ts` — **C5 re-target**: expose `allowPendingTokens` in `payInvoice()` request shape; for invoice flows that bridge to escrow, coerce `allowPendingTokens` to `false` per §2.5 last paragraph. Surfaces coercion via `{ overrides: ['allowPendingTokens-coerced-to-false'] }` in the result.
  - **NOT touched**: SwapModule (deposits flow through `accounting.payInvoice()`, so the coercion lives in AccountingModule).
  - NEW: `tests/unit/accounting/forced-conservative-coercion.test.ts` — **W21**: enumerate every payInvoice call-site that triggers coercion.
- **depends_on**: T.7.C.
- **parallel_with**: T.7.B, T.7.B.5, T.7.C.5, T.7.E.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - Invoice payments with caller-supplied `allowPendingTokens: true` are silently coerced to `false` when the invoice flow bridges to escrow; surfaces via `{ overrides: ['allowPendingTokens-coerced-to-false'] }` in `TransferResult`.
  - **W21**: call-site enumeration tightened — every coercion site has a test.
- **est_loc**: 240 (was 180; +60 for re-target + W21 enumeration).
- **risks**: caller silently observes different behavior — surface the coercion in `TransferResult` as documented.
- **spec_refs**: §2.5.

---

#### T.7.E — Default-mode flip: `transferMode` defaults to `'instant'` over UXF

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `modules/payments/PaymentsModule.ts` — when `request.transferMode` is undefined, default to `'instant'`. Pre-flag the previous default (`'instant'` over legacy TXF) is replaced by `'instant'` over UXF.
  - MODIFIED: `tests/` — any existing tests that snapshotted the legacy-default behavior get migrated.
- **depends_on**: T.5.A, T.7.A, T.7.B, T.7.B.5, T.7.C, T.7.C.5.
- **parallel_with**: T.7.D, T.1.B.2.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - `payments.send({ recipient, coinId, amount })` (no mode specified) goes via `instant-sender` (T.5.A) and emits a UXF bundle.
  - Backward-compat regression test (single-coin call) still produces a byte-identical bundle to the captured fixture.
- **est_loc**: 220.
- **risks**: third-party integrations relying on the legacy default — call out in the changelog.
- **spec_refs**: §2.5.

---

### T.8 — Capability hints, error surfacing, integration tests, rollout

T.8 ships the informational `wireProtocols` field on the identity binding event, the `INLINE_CAR_TOO_LARGE` / `FETCHED_CAR_TOO_LARGE` error surfaces, full integration / compatibility / adversarial test suites, and the production cutover.

**T.8.E is split into T.8.E.1 (integration), T.8.E.2 (compatibility), T.8.E.3 (adversarial)** for reviewability — **W10 applied**.

---

#### T.8.A — T.2.D reference snapshot fixture (renamed from "v1.0 backward-compat")

- **wave**: T.8 (but lands EARLY — see Parallelization Map §3)
- **files_touched**:
  - NEW: `tests/fixtures/uxf-t2d-reference-snapshot/` — **W44 applied**: renamed from "v1.0 single-coin" to "T.2.D reference snapshot" to avoid the false v1.0 claim. Generated from a tagged commit (`v0.7.0-rc-uxf-fixture`) with deterministic salt, deterministic timestamp, recorded mnemonic.
  - NEW: `tests/regression/uxf-t2d-reference-snapshot.test.ts` — assert byte-identical bundle from a single-coin call against the fixture.
- **depends_on**: T.2.D.2 (for fixture generation; the fixture is generated AFTER T.2 lands but the slot is reserved upfront).
- **parallel_with**: T.8.B, T.8.C, T.8.D, T.8.E.1/2/3.
- **skill_tag**: `tests`
- **acceptance**:
  - Fixture committed; test passes; regenerating it requires bumping a marker and an ADR.
  - Byte-identical assertion gated on the fixture's existence (so the test fails loudly if the fixture is moved).
- **est_loc**: 220.
- **risks**: fixture flakiness from non-deterministic CBOR field order — pin to deterministic CBOR encoder; CI reproducibility check.
- **spec_refs**: §11.2 backward-compat bullet.

---

#### T.8.B — Capability hint surfacing: `wireProtocols` + UI warnings + assetKinds-absent forward-compat

- **wave**: T.8
- **files_touched**:
  - MODIFIED: `transport/NostrTransportProvider.ts` — identity binding event includes `wireProtocols: ['uxf-car', 'uxf-cid', 'txf']` and `assetKinds: ['coin', 'nft']` (informational, per §10.4).
  - MODIFIED: `core/Sphere.ts` — `sphere.resolve(identifier)` returns the capability hints in `PeerInfo`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — sender consults `peerInfo.wireProtocols` BEFORE send and emits `transfer:capability-warning` if mismatched. NEVER auto-coerces.
  - NEW: `tests/unit/transport/capability-hint.test.ts`, `tests/unit/payments/capability-warning.test.ts`.
  - NEW: `tests/unit/transport/assetkinds-absent-forward-compat.test.ts` — **W20**: `assetKinds` absent ⇒ assume `['coin']` per §10.4.
- **depends_on**: T.7.A, T.7.B.5 (re-resolved nametag is fed back into `peerInfo`).
- **parallel_with**: T.8.A, T.8.C, T.8.D, T.8.E.1/2/3.
- **skill_tag**: `transport`
- **acceptance**:
  - Identity binding event encodes the two new fields.
  - `assetKinds: ['coin']` (older peer) + sender ships an NFT entry → emit `transfer:capability-warning`; do NOT auto-strip.
  - Receiver's `UNKNOWN_ASSET_KIND` reject rule (T.2.B) is the actual interop guarantee; the hint is informational.
  - **W20**: `assetKinds` absent → sender treats as `['coin']`; warning emitted for NFT sends to such peers.
- **est_loc**: 380 (was 320; +60 for W20 + nametag re-resolution feedback).
- **risks**: false-positive warning for older peers that simply omit the hints — treat absent `assetKinds` as `['coin']` per §10.4.
- **spec_refs**: §10.4.

---

#### T.8.C — Error surfacing + SphereError redaction

- **wave**: T.8
- **files_touched**:
  - MODIFIED: `core/errors.ts` — extend `SphereErrorCode` with the 4 new codes (already partially landed in T.2.B/T.4.B; this task is the audit + completion).
  - **W40**: SphereError redaction layer for `signedTransferTxBytes`. Errors carrying signed transfer bytes (e.g., REQUEST_ID_MISMATCH client-error path) MUST redact the bytes before logging or surfacing to UI consumers.
  - NEW: `tests/unit/payments/transfer/error-surface.test.ts` — every new error code surfaces through the SphereError path with documented metadata.
  - NEW: `tests/unit/payments/transfer/sphere-error-redaction.test.ts` — **W40**: `signedTransferTxBytes` never appears in `error.message` or `error.context`.
- **depends_on**: T.2.C, T.2.B, T.4.B, T.3.E.
- **parallel_with**: T.8.A, T.8.B, T.8.D, T.8.E.1/2/3.
- **skill_tag**: `tests`
- **acceptance**:
  - All 4 codes are typed in `SphereErrorCode`.
  - Each error path tested.
  - **W40**: `signedTransferTxBytes` redaction layer enforced; redaction test passes.
- **est_loc**: 280 (was 200; +80 for W40 redaction).
- **risks**: stragglers — run `grep -rn "throw new" modules/payments/transfer/` and verify every throw uses `SphereError`.
- **spec_refs**: §3.3.1, §3.3.2, §10.4, §5.0.

---

#### T.8.D — Production cutover: remove legacy single-coin TXF path; per-feature flag becomes vestigial

- **wave**: T.8
- **files_touched**:
  - MODIFIED: `modules/payments/PaymentsModule.ts` — remove the legacy single-coin code paths. The flag-gated dispatcher becomes unconditional (gated only on the `transferMode` value).
  - MODIFIED: `cli/index.ts`, `modules/accounting/AccountingModule.ts` — final pass to remove legacy fall-through code.
  - NEW: `.github/workflows/external-acks-gate.yml` (~50 LOC) — round-4 W1: GitHub Actions workflow implementing the external-acks gate; uses `gh issue list --state closed` against the three tracking-issue labels. Fails the T.8.D PR until all three external maintainers close their `uxf-transfer-v1-ack`-labeled issues.
  - NEW: `docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md` — operator guide for cutover, including back-out procedure (revert this PR + run `tools/restore-legacy-outbox.ts` from T.6.D.2).
  - **W33**: ADR appendix in cutover runbook listing every export/function/type slated for deletion (legacy_outbox decoder, legacy TXF send fast path, etc.).
- **depends_on**: T.7.C, T.7.E (default flip), T.6.D.2 (restore script ready), T.8.A (regression assertion still passing), **external-acks-received** (NON-CODE GATE: agentsphere maintainer ack on `onIntent` widening + sphere app maintainer ack + openclaw-unicity maintainer ack — round-2 W6).

  **CI mechanism (round-3 W2)**: a new GitHub Actions workflow `.github/workflows/external-acks-gate.yml` runs as a required check on the T.8.D PR. It uses `gh issue list --state closed --search "label:uxf-transfer-v1-ack repo:unicity-sphere/agentsphere"` (and same for sphere-app, openclaw-unicity) — fails the PR check if any of the three tracking issues is still open. Tracking issues:
  - `unicity-sphere/agentsphere#NN` (label `uxf-transfer-v1-ack`)
  - `unicity-sphere/sphere#NN` (label `uxf-transfer-v1-ack`)
  - `unicity-sphere/openclaw-unicity#NN` (label `uxf-transfer-v1-ack`)
  T.8.D PR description must reference these three issues; CI verifies all are closed before allowing merge.
- **parallel_with**: T.8.B, T.8.C, T.8.E.1/2/3.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - Legacy code paths removed; `git grep -n 'transferMode === '\''conservative'\''' modules/payments/PaymentsModule.ts` returns only the new dispatcher's branch.
  - All tests still pass.
  - Back-out tested (revert PR; CI green; `restore-legacy-outbox.ts` round-trip passes).
  - **W33**: ADR appendix enumerates every legacy export/function/type slated for deletion.
- **est_loc**: 480 (was 380; +100 for ADR appendix).
- **risks**: hidden code path that depended on legacy behavior — exhaustive smoke test before cutover.
- **spec_refs**: §10.1, §10.2.

---

#### T.8.E.1 — Integration test suite

- **wave**: T.8
- **files_touched**:
  - NEW: `tests/integration/transfer/conservative-end-to-end.test.ts` — 1, 5, 100 tokens.
  - NEW: `tests/integration/transfer/instant-end-to-end.test.ts` — 1, 5, 100 tokens; both sides converge to `valid`.
  - NEW: `tests/integration/transfer/txf-end-to-end.test.ts` — both finalization variants.
  - NEW: `tests/integration/transfer/chain-mode-3-hop.test.ts` — A→B→C→D before any aggregator round-trip.
  - NEW: `tests/integration/transfer/chain-mode-merge.test.ts` — backup import grafts proofs in mid-resolution.
  - NEW: `tests/integration/transfer/multi-coin-token.test.ts` — multi-coin token, single-coin send.
  - NEW: `tests/integration/transfer/multi-coin-additional-assets.test.ts` — `additionalAssets` happy path.
  - NEW: `tests/integration/transfer/nft-only-send.test.ts`, `tests/integration/transfer/mixed-coin-nft.test.ts`.
  - NEW: `tests/integration/transfer/forced-cid-tiny.test.ts`, `tests/integration/transfer/forced-inline-oversized.test.ts`.
  - NEW: `tests/integration/transfer/§11.2-cross-mode-cid-delivery-5min-delay.test.ts` — **W29: §11.2 cross-mode CID delivery 5-min-delay timing test**.
- **depends_on**: T.2.D.2, T.3.E, T.4.A, T.4.B, T.5.A, T.5.B, T.5.B.5, T.5.C, T.5.D, T.5.E, T.5.F, T.6.A, T.6.B, T.6.D, T.7.A, T.7.B.
- **parallel_with**: T.8.A, T.8.B, T.8.C, T.8.D, T.8.E.2, T.8.E.3.
- **skill_tag**: `tests`
- **acceptance**:
  - All §11.2 integration scenarios from the canonical spec have passing tests.
  - **W29**: cross-mode CID delivery 5-min-delay timing test added.
- **est_loc**: 1100.
- **risks**: flakiness on real-network paths — use the existing testcontainers-backed Helia and a deterministic-clock harness throughout.
- **spec_refs**: §11.2, §11.3.

---

#### T.8.E.2 — Compatibility test suite

- **wave**: T.8
- **files_touched**:
  - NEW: `tests/compatibility/transfer/txf-sender-uxf-recipient.test.ts`, `uxf-sender-txf-only-recipient.test.ts`.
  - NEW: `tests/compatibility/transfer/outbox-migration.test.ts`.
  - NEW: `tests/compatibility/transfer/capability-hint-warning.test.ts`.
- **depends_on**: T.7.A, T.7.B, T.7.B.5, T.6.D, T.6.D.2, T.8.B.
- **parallel_with**: T.8.E.1, T.8.E.3.
- **skill_tag**: `tests`
- **acceptance**:
  - Cross-mode interop (TXF↔UXF) verified.
  - Outbox migration round-trip.
  - Capability hint warning on legacy peers.
- **est_loc**: 600.
- **risks**: legacy fixtures drifting — pin via T.8.A.
- **spec_refs**: §11.2.

---

#### T.8.E.3 — Adversarial test suite

- **wave**: T.8
- **files_touched**:
  - NEW: `tests/adversarial/transfer/forged-authenticator.test.ts`, `multi-root-car.test.ts`, `chain-depth-cap.test.ts`, `unclaimed-roots-cap.test.ts`.
  - NEW: `tests/adversarial/transfer/replay-bundleCid.test.ts`, `instant-mode-concurrent-split.test.ts`, `forwarder-dies-midchain.test.ts`, `bandwidth-burning-peer.test.ts`.
  - NEW: `tests/adversarial/transfer/faulty-aggregator.test.ts`, `aggregator-hard-rejection.test.ts`, `sustained-path-not-included.test.ts`.
  - NEW: `tests/adversarial/transfer/orbitdb-crdt-replica-merge.test.ts`, `stuck-pending-escape.test.ts`.
  - NEW: `tests/adversarial/transfer/conflicting-proofs-same-requestid.test.ts` — **C10**.
  - NEW: `tests/adversarial/transfer/forged-nametag.test.ts` — **C9** (paired with T.7.B.5).
  - NEW: `tests/adversarial/transfer/forged-authenticator-mid-chain.test.ts` — **C8** (paired with T.3.B.1).
  - NEW: `tests/adversarial/transfer/broken-continuity.test.ts` — **C8**.
  - NEW: `tests/adversarial/transfer/cid-delivery-no-ack.test.ts` — **W38**: sender outbox doesn't transition `delivered` if recipient never fetches.
  - NEW: `tests/adversarial/transfer/§9.4.1-bft-collusion-observation.test.ts` — **W19**: OUT-OF-SCOPE failure-mode (BFT collusion observation case).
  - NEW: `tests/adversarial/transfer/race-lost-poll-mismatch.test.ts` — **C12**.
  - NEW: `tests/adversarial/transfer/client-error-request-id-mismatch.test.ts` — **C13**.
- **depends_on**: T.3.B.1, T.3.B.2, T.5.B, T.5.B.5, T.5.C, T.5.D, T.5.E, T.5.F, T.6.B, T.7.B, T.7.B.5, T.8.B, T.8.C.
- **parallel_with**: T.8.E.1, T.8.E.2.
- **skill_tag**: `tests`
- **acceptance**:
  - All §11.4 adversarial scenarios from the canonical spec have passing tests.
  - Test files use **§N.N spec-citation prefix** in names per Note N1 where applicable.
  - Test suite runs in < 8 minutes on CI; flake rate < 0.5%.
- **est_loc**: 1100.
- **risks**: flakiness on real-network paths — use the existing testcontainers-backed Helia and a deterministic-clock harness throughout.
- **spec_refs**: §11.4, §9.4.1.

---

### Out-of-scope for T.1–T.8 (deferred)

Per canonical §12.3, periodic rescans (profile-pointer + per-token spent-state) are deferred. T.1–T.8 wire up the storage, events, and audit-promotion plumbing so future-wave rescan code can drop in cleanly — but no rescan loop ships in this implementation plan. Coordination point only.

---

## §3 Parallelization map

### Lanes

The work decomposes into 6 parallel lanes after T.1 lands. Each lane can be staffed by one senior agent.

| Lane | Tasks | Skill mix | Critical-path? |
|---|---|---|---|
| **Foundations** | T.1.A → T.1.B.1 → T.1.C → T.1.D → T.1.E → T.1.F | types + storage + crdt | YES — gates everything |
| **Sender** | T.2.A, T.2.B, T.2.C → T.2.D.1 → T.2.D.2 → T.2.E → T.4.A → T.5.A → T.7.A → T.7.D, T.7.E → T.8.D | sender + wire | secondary critical |
| **Recipient** | T.3.A, T.3.B.1, T.3.B.2, T.3.C, T.3.D → T.3.E → T.4.B → T.7.B → T.7.B.5 | recipient + worker | secondary critical |
| **Outbox / CRDT** | T.6.A → T.6.B, T.6.C, T.6.D → T.6.D.2 → T.6.E | outbox + crdt + migration | gating for T.5 |
| **Workers / Cascade** | T.5.B.0 → T.5.B → T.5.B.5, T.5.C → T.5.D → T.5.E → T.5.F | worker + recipient | gating for T.7.A |
| **Tests / Fixtures / Cutover** | T.8.A → T.8.B, T.8.C → T.8.E.1/2/3 → cutover | tests | follows everything |

### Critical path (longest serial chain) — 15 PRs (16 if T.0.G7-fill-gaps triggers)

```
T.1.A    (types)                                     [day 1-2]
  ↓
T.1.B.1  (TransferMode widening + shims)             [day 2]
  ↓
T.1.E    (PROFILE_KEY_MAPPING ext + Sphere.clear)    [day 3-4]
  ↓
T.1.F    (Lamport + 3-strategy mutex + CAS)          [day 3-4 in parallel]
  ↓
T.6.A    (outbox writer)                             [day 5-6]
  ↓
T.6.B    (CRDT merger, 3-file split + property)      [day 6-7]
  ↓
T.5.A    (instant sender)                            [day 7-8]
  ↓
T.5.B    (sender finalization worker, race-lost)     [day 8-10]
  ↓
T.5.B.5  (cascade walker per-class)                  [day 10-11]
  ↓
T.5.C    (recipient finalization worker)             [day 11-13]
  ↓
T.5.D    (importInclusionProof)                      [day 13-14]
  ↓
T.7.A    (TXF sender)                                [day 14-15]
  ↓
T.7.B    (legacy adapter)                            [day 14-15 in parallel]
  ↓
T.7.E    (default flip)                              [day 15-16]
  ↓
[external-acks gate + soak/smoke window]             [day 16-18 buffer — round-3 W2]
  ↓
T.8.D    (cutover)                                   [day 18-22]
```

15 PR-sized merges deep on the critical path (16 if `T.0.G7-fill-gaps` triggers); with parallel lanes, total wall-clock is **~18-22 days for 4 senior agents**, **~6-7 weeks for 2 senior agents**.

### Concurrency opportunities

- **Day 1–2**: 5 agents on T.1.A/B.1/C/D/E/F in parallel (T.1.A is briefly blocking; others run after a few hours). T.8.A scaffold can also start.
- **Day 3–6**: 4 agents on T.2.A/B/C, T.3.A/B.1/B.2/C/D, T.6.A/B/C, T.8.A. (Sender and recipient lanes are fully independent.)
- **Day 6–10**: 4 agents on T.5.A/B.0/B/B.5, T.4.A/B, T.6.D/D.2/E, T.7.A.
- **Day 10–14**: 4 agents on T.5.C/D/E/F, T.7.B/B.5/C/C.5/D, T.8.B/C, T.8.E.1/2/3.
- **Day 14–18**: 2 agents on T.7.E/T.1.B.2, T.8.D, T.8.E.1/2/3 finishing.

### Bottlenecks (where parallelism cannot help)

- **T.1.E `PROFILE_KEY_MAPPING` extension** is a single-file change with ~10 downstream tasks. Has to be perfect on first land. **Wave G.7 layout prerequisite (W8) — pre-task check before T.6.A.**
- **T.6.A outbox writer** is the hub for T.5.A, T.5.B, T.5.C, T.7.A. One bug propagates everywhere.
- **T.5.B.5 cascade walker** is the canonical owner; T.5.B and T.5.D are consumers. One agent reads §6.1.1 + classifies coin/NFT and ships the walker.
- **T.5.C recipient worker** integrates T.3.B.1+B.2 (dispositions), T.3.C (storage), T.3.D (merger), T.5.B (manifest CID rewrite via T.5.B.0). Best done by one agent who has read all four.
- **T.8.D cutover** touches every entry point. Best done by the same agent who did T.7.E (default flip).

### Anti-patterns to avoid

- **Don't claim T.5.A and T.5.B are parallel without coordinating** — they share the outbox entry shape and need the same Lamport-bump rules.
- **Don't claim T.3.B.2 and T.3.D are parallel with the same agent** — the disposition engine and conflict merger share invariants; one agent reading both is faster than two agents arguing about the boundary.
- **Don't try to parallelize T.6.B (CRDT merger) with the consumer that uses it (T.5.B/C/D)** — they share semantic invariants.
- **Don't have T.5.B own cascade logic AND T.5.D own cascade logic** — that was the original mistake (C3); cascade has a single owner: T.5.B.5.

---

## §4 Cross-cutting sequencing rules

These are normative ordering constraints that any task DAG MUST respect:

1. **Types land before consumers**: T.1.A (UxfTransferPayload), T.1.B.1 (TransferRequest widening + shims), T.1.C (DispositionReason / AuditStatus + `'client-error'`) MUST land before any task that imports those types from `types/uxf-transfer.ts`. The `tsc --noEmit` gate enforces this.
2. **`PROFILE_KEY_MAPPING` extension before any disposition writer**: T.1.E MUST land before T.3.C (`disposition-writer`), T.3.E (worker pool that calls disposition writer), and **T.5.D (`importInclusionProof` writes to `_invalid` — C4 applied)**.
3. **OrbitDB schema additions before workers consume them**: T.6.A (UxfTransferOutboxEntry per-entry-key writer) MUST land before T.5.B and T.5.C (which read/write outbox entries). **T.2.D.2 hard-deps on T.6.A (C2 applied; was soft-dep).**
4. **Lamport-clock primitive before any CRDT writer**: T.1.F MUST land before T.3.C, T.6.A, T.6.B.
5. **Legacy adapter (T.7.B) cannot land before T.3.B.2 disposition engine**: the adapter routes legacy shapes through the engine — it has no engine to call without T.3.B.2.
6. **CID-pin path (T.4) cannot land before conservative-sender skeleton (T.2.D.1+D.2)**: T.4.A extends T.2.D.2; T.4.B extends T.3.A.
7. **Cascade walker is single-owner**: **T.5.B.5 owns cascade logic** (C3 applied); T.5.B and T.5.D are consumers. T.5.B.5 distinguishes coin-class (splitParent walk) from NFT-class (outbox-driven notification) per §6.1.1 (C11 applied).
8. **Manifest-CID-rewrite peeled out**: T.5.B.0 lands first, blocking both T.5.B and T.5.C (W3 applied).
9. **Default flip (T.7.E) and cutover (T.8.D) MUST be sequenced last**: removing the legacy path before the new path is fully tested risks production breakage.
10. **Token-id invariance is the bedrock**: any task that handles proofs (T.5.B, T.5.B.5, T.5.C, T.5.D, T.6.B) MUST preserve the §2.1 audit — `token.id` is immutable across proof attachment; CIDs change. Reviewers MUST check this invariant on every touch.
11. **Bundle-grained outbox for UXF, per-token for TXF (per §7.2)**: the same entry shape but the `mode` field discriminates. T.6.A defines the schema; T.7.A consumes the per-token form; T.7.C migration emits both.
12. **Migration is one-way**: T.6.D (legacy outbox migration) is one-way; T.1.E (PROFILE_KEY_MAPPING) is additive (legacy `invalidTokens` continues to exist for the migration window). T.8.D removes the legacy entirely. **T.6.D.2 restore script is the back-out path (C7 applied).**
13. **Continuity walker is mandatory at receive (C8 applied)**: T.3.B.1 includes a full-chain source-state continuity walker; `'continuity-broken'` reason is wired end-to-end. T.5.B (sender worker) and T.5.C (recipient worker) MUST verify continuity on every receive.
14. **Race-lost via poll-mismatch (C12 applied)**: T.5.B and T.5.C use `REQUEST_ID_EXISTS` at submit + `OK`-with-mismatching-`transactionHash` at poll, NOT `REQUEST_ID_MISMATCH`. `REQUEST_ID_MISMATCH` is reason='client-error'.
15. **Nametag re-resolution is mandatory at receive (C9 applied)**: T.7.B.5 gates UI nametag display through `transport.resolveTransportPubkeyInfo()`. The wire-payload nametag is untrusted.
16. **Per-feature flag config (W42 applied)**: replaces the single boolean `UXF_TRANSFER_V1`. Each task lists which flag(s) gate its runtime behavior.
17. **Constants module (W36 applied)**: T.1.D's `modules/payments/transfer/limits.ts` is the single source of truth for MAX_UNCLAIMED_ROOTS, MAX_CHAIN_DEPTH, REPLAY_LRU_SIZE, MAX_FETCHED_CAR_BYTES, etc. All consumers import from this module.

---

## §5 Test strategy per wave

Each wave's test gate blocks the next wave's PR merges. **Test files use §N.N spec-citation prefix in names where applicable (Note N1).**

| Wave | Test gate | Blocks |
|---|---|---|
| **T.1** | T.1.A unit (encode/decode); T.1.D unit (CAR root extraction + CID lex compare); T.1.E migration round-trip + `Sphere.clear()` test (C6); T.1.F Lamport + 3-strategy mutex + CAS unit + bounded-hold-fires test (W35) + Lamport-bounds adversarial test (W39). | T.2, T.3, T.6 (which import the types). |
| **T.2** | T.2.A unit (preflight finalize); T.2.B unit (target validation + `confirmNftPending` rejection W11 + `EMPTY_TRANSFER` W22); T.2.C unit (delivery resolver + `INVALID_INLINE_CAP` W12); T.2.D.1 unit (orchestrator stub-outbox); T.2.D.2 unit (outbox-integrated, after T.6.A); T.2.E transport adapter unit. | T.4 (CID extension), T.5 (instant variant). |
| **T.3** | T.3.A unit (bundle acquirer + verifier + §5.2-2-advisory-tokenIds W24); T.3.B.1 unit (per-element verifiers, including continuity walker C8 + per-tx ECDSA W37 + `tests/adversarial/transfer/broken-continuity.test.ts` C8 + `tests/adversarial/transfer/forged-authenticator-mid-chain.test.ts` C8/W37); T.3.B.2 unit (decision-matrix walker, every leaf of §5.3); T.3.C unit (multi-rep storage + client-error reason path C13); T.3.D unit (merge + lex-min); T.3.E worker pool + per-token cap (W7) + bundle-internal sequential (W23) + gateway-failure-no-disposition (W13); **first integration**: `tests/integration/transfer/conservative-end-to-end.test.ts` (1 token only — full suite at T.8.E.1). | T.4, T.5.C, T.7.B. |
| **T.4** | T.4.A unit (sender CID); T.4.B unit (32 MiB cap + verified-CAR + W13 no-disposition); first integration: `tests/integration/transfer/uxf-cid-roundtrip.test.ts`. | T.5, T.7.A. |
| **T.5** | T.5.A unit (instant sender + W11 confirmNftPending rejection); T.5.B.0 unit (manifest-cid-rewrite + §5.5-step5-atomicity W25 + polling-policy W6); T.5.B unit (every error path of §6.1 + race-lost C12 + client-error C13 + W14/W16/W17/W26 + C10 conflicting-proofs); T.5.B.5 unit (coin/NFT cascade + race-lost no-fire + parent-flip W27 + visited-set scope W32); T.5.C unit (per-address queue + drain + W5 revaluate + W15 idempotency invariant); T.5.D unit (importInclusionProof, all 10 cases W4 + W30/W31/N4 audit trail); T.5.E unit (events + override-applied N4); T.5.F unit (trustBase staleness W41). **Integration**: 3-hop chain-mode test, merge-path test. | T.7, T.8.E.1/2/3. |
| **T.6** | T.6.A unit (per-entry-key writer); T.6.B unit (every CRDT row of §7.1 + property-based W9 + N3 split + G-counter W28 + audit_promoted_from W45); T.6.C unit (every transition of §7.0 + dual-write W43); T.6.D unit (legacy migration + backup-ordering C7 + W18 recipientNametag); T.6.D.2 round-trip (C7); T.6.E integration (crash recovery). | T.5 (which writes outbox), T.8.D (cutover). |
| **T.7** | T.7.A unit (TXF sender both variants); T.7.B unit (4 legacy shapes); T.7.B.5 unit (nametag re-resolver + adversarial forged-nametag C9); T.7.C integration (production call-site migration, 6 AccountingModule + 1 CLI + 1 internal); T.7.C.5 unit (ConnectHost schema-version C5); T.7.D unit (forced-conservative coercion, payInvoice W21 enumeration); T.1.B.2 cleanup (audit shim removal). | T.8.D (cutover). |
| **T.8** | T.8.A regression fixture (renamed "T.2.D reference snapshot" W44); T.8.B capability hint + assetKinds-absent W20; T.8.C error surface + redaction W40; T.8.E.1 integration suite (incl. W29 cross-mode-CID 5min); T.8.E.2 compatibility suite; T.8.E.3 adversarial suite (incl. W19 OUT-OF-SCOPE collusion + W38 cid-no-ack). T.8.D cutover gated on full suite passing (and T.6.D.2 round-trip). | None (last wave). |

### Cross-wave gating tests

A handful of tests live across wave boundaries because they exercise multi-wave invariants:

- **`tests/regression/uxf-t2d-reference-snapshot.test.ts`** (T.8.A) — gates T.7.E and T.8.D. Any change to the encoder downstream that breaks the fixture forces an explicit ADR + fixture regen (W44).
- **`tests/integration/transfer/orbitdb-crdt-replica-merge.test.ts`** (T.6.B + T.8.E.1) — gates T.6.B (must pass before T.6.B merges) AND T.5.B/C (must pass with the workers driving real merges).
- **`tests/integration/transfer/chain-mode-3-hop.test.ts`** — gates T.5.C and T.5.D. Three-hop chain is the canonical chain-mode regression case.
- **`tests/integration/transfer/stuck-pending-escape.test.ts`** — gates T.5.D `importInclusionProof` (all 10 cases — W4).
- **`tests/adversarial/transfer/bandwidth-burning-peer.test.ts`** — gates T.5.B + T.5.B.5 cascade short-circuit.
- **`tests/integration/profile/legacy-outbox-restore-roundtrip.test.ts`** (T.6.D.2) — **C7**: gates T.8.D merge.
- **`tests/adversarial/transfer/conflicting-proofs-same-requestid.test.ts`** (T.5.B / T.8.E.3) — **C10**: gates T.5.B and T.5.E.
- **`tests/adversarial/transfer/forged-nametag.test.ts`** (T.7.B.5 / T.8.E.3) — **C9**: gates T.7.B.5 and T.8.B (capability hints feed re-resolved nametag).
- **`tests/adversarial/transfer/broken-continuity.test.ts`** (T.3.B.1 / T.8.E.3) — **C8**: gates T.3.B.1 and T.5.B/C (which invoke the walker).

---

## §6 Migration plan

### §6.A Legacy `OutboxEntry` → `UxfTransferOutboxEntry`

Implemented in **T.6.D + T.6.D.2** per canonical §7.2. Highlights:

- Trigger: first read of `${addr}.outbox.*` after `features.outbox === 'dual-write' || 'uxf'` is enabled.
- **C7 ordering invariant**: backup → migrate → sentinel → clear-legacy. Backup goes to `${addr}.legacyOutbox.backup` BEFORE legacy clear.
- Group legacy entries by `(recipientPubkey, createdAt within 60s window)`.
- Synthesize one `UxfTransferOutboxEntry` per group with `mode: 'txf'`, `deliveryMethod: 'txf-legacy'`, `bundleCid` synthetic per §7.2 paragraph 2.
- Status mapping: legacy `delivered|confirmed → 'finalized'`; `pending → 'sending'`; `failed → 'failed-permanent'`.
- **W18: `recipientNametag` first-class** in the new schema (extend `UxfTransferOutboxEntry`); not via error-metadata fallback.
- One-way: legacy collection cleared after migration commits.
- Idempotent: re-running on a migrated wallet is a no-op (key prefix indicates schema version).
- **Restore script (T.6.D.2)**: `tools/restore-legacy-outbox.ts` reverses the migration via the backup; round-trip test gates T.8.D merge (C7).

### §6.B Legacy `invalidTokens` → multi-rep `_invalid` keys

Implemented in **T.1.E**. Each legacy single-record entry becomes a per-entry-key record under `${addr}.invalid.${tokenId}.${observedTokenContentHash}` with `observedTokenContentHash = "legacy-" + tokenId` (synthetic disambiguator). Migration is one-way; legacy `invalidTokens` collection is cleared after.

### §6.C `_audit` is NEW

There is no legacy audit data. T.1.E adds the key mapping; T.3.C creates the writer; the collection is empty for all wallets at first run.

### §6.D Production call-site migration: legacy single-coin `send()` callers

Implemented in **T.7.C / T.7.C.5 / T.7.D**. **Verified call-site count (C5)**:

- 6 in `AccountingModule.ts` (lines 2465, 2710, 3655, 3819, 4134, 5812).
- 0 in `SwapModule.ts` (uses `accounting.payInvoice()` — see T.7.D for the `allowPendingTokens` knob).
- 0 in `ConnectHost.ts` (delegates to dApp wallet host's `onIntent` callback — see T.7.C.5 for schema-version coordination).
- 1 in `cli/index.ts:2831`.
- 1 internal recursive in `PaymentsModule.ts:2799`.
- 37 in `tests/`.

Order:

1. T.1.B.1 widens the type — call-sites compile (via shims) but behavior unchanged (legacy default).
2. T.7.C explicitly passes `transferMode: 'instant'` (or whatever the caller intends) at every site. No semantic change for callers that were already on `'instant'`.
3. T.7.C.5 adds `schemaVersion` to ConnectHost intents (external repos: agentsphere, sphere app — coordination via documentation + changelog).
4. T.7.D exposes `allowPendingTokens` knob in `payInvoice()` for §2.5 forced-conservative coercion (W21 enumerates every site).
5. T.1.B.2 removes the no-longer-needed shims (audit cleanup).
6. T.7.E flips the SDK default from "instant over legacy TXF" to "instant over UXF". Now any site that omitted `transferMode` switches to UXF.
7. T.8.D removes the legacy code path entirely.

Sequenced this way, no PR introduces a behavior change without an explicit type-level signal.

### §6.E Order of migrations against canonical §7.2

Per §7.2 paragraph "Migration on first read":

1. **First**: T.1.E lands `PROFILE_KEY_MAPPING` extension + `Sphere.clear()` coverage (no migration yet — just schema).
2. **Second**: T.6.D writes backup (C7), runs the outbox migration on first read.
3. **Third**: T.6.D's migration trigger writes a sentinel key `${addr}.uxf_migration_complete = true` to make subsequent reads skip the migration check.
4. **Fourth**: T.6.D.2 restore script ready (C7); T.8.D back-out runbook documents the path.
5. **Fifth**: T.6.E's crash-recovery test exercises the migration-mid-flight path (crash before sentinel commit → migration replays cleanly).

---

## §7 Rollout / fallback strategy

### §7.A Per-feature flag config (W42)

`UxfTransferFeatures` is a config object (not a boolean) — env vars + `Sphere.init({ features })`:

```typescript
interface UxfTransferFeatures {
  readonly typesWidening: boolean;
  readonly senderUxf: boolean;
  readonly recipientUxf: boolean;
  readonly cidDelivery: boolean;
  readonly instantMode: boolean;
  readonly outbox: 'legacy' | 'dual-write' | 'uxf';
  readonly txfOptIn: boolean;
  readonly defaultModeIsUxf: boolean;
}
```

| Phase | Setting | Effect |
|---|---|---|
| T.1 lands | `{typesWidening:true, ...all false}` | All wallets behave as today; types compile. |
| T.2/T.3/T.4 lands | sender/recipient/cid features flagged off | Code on disk; opt-in for testing. |
| T.5/T.6/T.7 lands | `outbox: 'legacy'` default | Same; testnet opt-in. |
| Pre-cutover | `outbox: 'dual-write'` | Migration safety. Legacy + new writers run in parallel; readers prefer new. |
| T.8.D | Legacy code removed; flag becomes vestigial | Cutover. |

Per-feature flags allow staged enablement and surgical rollback (revert one flag, not all). See W42.

#### Valid feature-flag combinations (round-1 steelman finding #5)

The 8 booleans + tri-state outbox naively allow 768 combinations. Most are nonsensical (e.g., `senderUxf: true` with `outbox: 'legacy'` would write UXF bundles but persist outbox entries that can't represent them). `Sphere.init()` MUST validate the combination and throw `INVALID_FEATURE_COMBINATION` for any invalid setting at startup. The **valid configurations** are:

| # | Name | Settings | Use |
|---|---|---|---|
| V0 | Pre-T.1 (legacy)         | all false | Pre-feature-branch baseline |
| V1 | Types-widened, runtime legacy | `typesWidening: true`; rest false | Post-T.1 default; safe for production |
| V2 | Sender opt-in (testnet)  | V1 + `senderUxf: true`, `outbox: 'dual-write'` | Sender writes UXF; outbox dual-writes |
| V3 | Sender + recipient opt-in | V2 + `recipientUxf: true` | Both ends UXF; outbox dual-writes |
| V4 | + CID delivery            | V3 + `cidDelivery: true` | Adds large-bundle CID path |
| V5 | + Instant mode            | V4 + `instantMode: true` | Adds async finalization workers |
| V6 | + TXF opt-in              | V5 + `txfOptIn: true` | Allows `transferMode: 'txf'` |
| V7 | Cutover                  | V6 + `defaultModeIsUxf: true`, `outbox: 'uxf'` | Default = UXF; legacy outbox cleared |

**Invalid combinations** that `Sphere.init()` MUST reject:
- `senderUxf: true` AND `outbox: 'legacy'` — sender writes can't be represented in legacy outbox.
- `recipientUxf: true` AND `outbox: 'legacy'` — recipient writes can't be represented.
- `instantMode: true` AND `senderUxf: false` — instant mode requires UXF sender.
- `instantMode: true` AND `recipientUxf: false` — instant mode requires UXF recipient (chain-mode finalization).
- `cidDelivery: true` AND `senderUxf: false` — CID delivery requires UXF sender.
- `defaultModeIsUxf: true` AND ANY of (senderUxf, recipientUxf, instantMode) is false — cutover requires full UXF on both sides.
- `txfOptIn: true` AND `typesWidening: false` — TXF mode is part of the widened TransferMode enum.
- `outbox: 'uxf'` AND `senderUxf: false` — UXF-only outbox requires UXF sender.

**`validateFeatures` semantics — strict whitelist (round-2 steelman C2)**: T.1.B.1's `validateFeatures(features): void` throws `INVALID_FEATURE_COMBINATION` for **any** setting that does not exactly match one of V0–V7 (strict whitelist, NOT blacklist). The 8 explicit invalid combinations listed above are illustrative — they document the *reasoning* for the whitelist's exclusions but are not the only rejected cases. The 753 unenumerated combinations all fail validation, by construction. The unit test `tests/unit/core/feature-validation.test.ts` enumerates: (a) ALL 8 valid configurations (V0–V7) → pass; (b) 8 explicit invalid combinations → throw; (c) at least 10 randomly-sampled non-V combinations (e.g., V1 + `txfOptIn:true` + `outbox:'dual-write'`) → throw with the canonical error code.

### §7.B Dual-write mode (formalized in §7.0 outbox state machine — W43)

During the T.6.D migration window (post-T.6.A, pre-T.8.D), the outbox can be operated in **dual-write mode** with formalized state-machine arcs (T.6.C):

- Legacy writes: continue via existing `_outbox` field in TXF data.
- New writes: go to `${addr}.outbox.${id}` per-entry-key form.
- Reads: prefer per-entry-key; fall back to legacy if absent.
- **W43**: the dual-write arc (`legacy ↔ uxf`) is an explicit transition in §7.0 outbox state machine; T.6.C validates the arc semantics.

Set via `Sphere.init({ features: { outbox: 'dual-write' } })`. Once a wallet has 100% per-entry-key entries, flip to `'uxf'` (single-source).

### §7.C Back-out procedure

Each wave is reverted by reverting its tagged commit:

1. T.8.D removed legacy code → revert T.8.D PR. Legacy code returns; flag `features.senderUxf=false, recipientUxf=false` re-enables the dispatcher fork.
2. T.7.E default flip → revert T.7.E PR. Default returns to legacy.
3. T.6.D legacy outbox migration → IRREVERSIBLE for migrated wallets (one-way migration). **Mitigation: T.6.D writes a backup copy to `${addr}.legacyOutbox.backup` BEFORE clearing the legacy collection (C7); restore script `tools/restore-legacy-outbox.ts` (T.6.D.2) re-creates the legacy entries. Round-trip test gates T.8.D merge.**

### §7.D Operator runbook (T.8.D)

`docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md` lands in T.8.D and covers:

- Pre-cutover check: regression fixture (T.8.A) passes, all 6 production call-sites migrated, capability hints emitted, T.6.D.2 restore round-trip green.
- Cutover step: deploy T.8.D (legacy code removed).
- Smoke tests: 5-token send/receive on testnet; chain-mode 3-hop on testnet.
- Rollback: revert T.8.D PR; legacy code returns under flag. If migrated wallets need rollback: run `tools/restore-legacy-outbox.ts` per affected wallet.
- **W33 ADR appendix**: enumerates every legacy export/function/type slated for deletion (audit trail for cutover).
- Postmortem: monitor `transfer:fetch-failed`, `transfer:trustbase-warning`, `transfer:security-alert`, `transfer:override-applied` rates for 7 days.

### §7.E Telemetry

Counters / events to watch during rollout (each emits via the `sphere.on()` event surface):

- `transfer:bundle-published` (sender, on each Nostr ack).
- `transfer:bundle-received` (recipient, on each disposition).
- `transfer:fetch-failed` (recipient CID fetch failed across all gateways).
- `transfer:trustbase-warning` (recipient or sender; debounced via T.5.F).
- `transfer:security-alert` (rare, suspect aggregator OR §6.3 forbidden two-different-values path).
- `transfer:cascade-failed` (downstream notification — coin-class via splitParent walk OR NFT-class via outbox).
- `transfer:cascade-risk-warning` (sender warns on still-pending parent).
- `transfer:capability-warning` (sender ships shape recipient may not understand).
- `transfer:override-applied` (operator override via `importInclusionProof`).
- `transfer:ingest-queue-full` / `transfer:ingest-queue-full-per-token` (recipient's worker pool overloaded).

---

## §8 Open questions / unknowns

These do not block T.1–T.8 but should be resolved before merge of the corresponding wave. **Items resolved by this revision are marked [RESOLVED].**

1. **[RESOLVED]** ~~T.1.D — CIDv1 binary lex-min comparison~~ — confirmed: raw multihash bytes; `compareCidV1Binary` in T.1.D includes a comment + reference test.
2. **[RESOLVED]** ~~T.5.A — `splitParent` field on existing token records~~ — settled via C11: NFT tokens NEVER have `splitParent`; coin children ALWAYS have it post-T.5.A. Legacy tokens predate the field; missing → no cascade (NFT path) or no walk (coin path).
3. **[RESOLVED]** ~~T.6.B — Lamport-clock initialization on schema migration~~ — `0` is safe (any subsequent local write bumps to `max(observed) + 1`); documented in T.6.D inline.
4. **[RESOLVED]** ~~T.5.C — Per-tokenId mutex strategy choice~~ — T.1.F implements all 3 strategies (CAS preferred, lock-with-RPC-release fallback, lock-with-bounded-hold last resort — W34); T.5.C selects via config.
5. **[RESOLVED]** ~~T.7.A — instant-TXF + chain-mode forwarder semantics~~ — T.7.A explicit test for forwarder-dies-mid-chain in TXF mode; per-token outbox carries inherited `outstandingRequestIds`.
6. **[RESOLVED]** ~~T.8.A — fixture regen process~~ — round-4 N1 resolution: T.8.A's implementing PR includes an inline ADR (in the test file's header comment) declaring: (a) the SDK version + commit hash that produced the fixture, (b) deterministic salt + timestamp + mnemonic used, (c) regen-trigger criteria — fixture is regenerated ONLY if a) the canonical bundle's wire format changes (rare; would require a separate spec change) OR b) a critical SDK upgrade requires it (e.g., state-transition-sdk major bump). Regeneration PRs require sign-off from the spec-owner (currently vladimir.rogojin@blockyinnovations.com). Routine PR authors do NOT regenerate the fixture; mismatches signal an unintended wire-format break.
7. **[RESOLVED]** ~~T.8.E — CI runtime budget~~ — split via W10 into T.8.E.1/2/3; adversarial suite runs nightly + on PRs touching `modules/payments/transfer/`.
8. **[NEW]** T.5.B.5 — cascade walker visited-set sharing across worker threads — **W32** clarified per-call-stack scope, but for a single Sphere instance with multiple workers, two cascades from different parents may visit a shared child. Confirm: per-call-stack visited-set + per-tokenId mutex (T.1.F) prevents double-cascade; document the proof in T.5.B.5 inline.
9. **[NEW]** T.5.F — trustBase refresh storm — debounce + cool-down for refresh; confirm rate limit on aggregator side; coordinate with aggregator team.
10. **[NEW]** T.7.C.5 — external-repo coordination — proactive notification to agentsphere + sphere app maintainers about the `schemaVersion` field. Track ack from each downstream maintainer before T.8.D. **Steelman round 1 #10**: T.7.C.5 itself is documentation + a schemaVersion field; the actual external migration is unsolved and must NOT block T.8.D's coordination gate.
11. **[RESOLVED]** ~~T.5.B / T.5.C test-LoC ratios~~ — round-2 W7: T.5.B est_loc bumped 1180 → 1580 (+400); T.5.C bumped 1240 → 1740 (+500). 1:1.5 impl:test ratio restored for both critical-path tasks.
12. **[NEW — actionable, not punted]** Cross-tokenId disk-I/O contention (round-1 #8 / round-2 W8). Add a NEW pre-T.5.C task: `T.5.B.0.5 — OrbitDB-write-fairness ADR + cap` (~80 LOC: 1 ADR doc + `MAX_CONCURRENT_ORBITDB_WRITES` constant in `limits.ts` + a fairness-queue stub). Lands BEFORE T.5.C's design is frozen. T.8.E.1 load test then verifies the cap value; if cap is wrong, revisit per ADR's revisit-criteria section.
13. **[NEW]** Per-feature flag invalid-combination matrix is now enumerated in §7.A (round-1 #5 / #7); `validateFeatures(features)` is a T.1.B.1 deliverable. Steelman should verify each combo's effect on a stale wallet (e.g., V3 → V2 rollback during dual-write).
14. **[NEW]** T.6.D.2 byte-identity definition (round-1 #13): "byte-identical" excludes `lamport`, `observedAt` timestamps, `_schemaVersion`, sentinel keys. Implementers test against the explicit field-list, not raw byte equality.
15. **[NEW]** Spec-citation prefix on test filenames (round-1 #12): mandatory for spec-defined behavior tests (cite the §section), optional for adversarial-only tests where no normative requirement applies. Implementers follow the convention; reviewers enforce it on PRs that introduce tests.
16. **[NEW]** `MAX_LOCK_HOLD_MS` placement (round-1 #14): lives in `profile/per-token-mutex.ts` as a co-located constant (per-strategy concern, not a global limit). The constants module `modules/payments/transfer/limits.ts` cross-references it as the per-token-mutex source-of-truth.
17. **[NEW]** `MAX_PROOF_ERROR_RETRIES`, `MAX_SUBMIT_RETRIES`, `POLLING_WINDOW`, `MIN_POLL_ATTEMPTS` placement (round-1 #14): in `modules/payments/transfer/polling-policy.ts` (T.5.B.0). The constants module `limits.ts` re-exports them so external readers have a single source of truth for ALL transfer-related defaults.
18. **[NEW]** T.0.G7-verify + T.0.G7-fill-gaps tasks (round-1 #9 / round-2 W5 split): NEW PRs added before T.1.E. T.0.G7-verify is test-only (always lands); T.0.G7-fill-gaps is contingent (lands only if verify fails). Hard-gate T.1.E.

Periodic rescans (§12.3) are explicitly **deferred** per the user-supplied constraint and §13 closing paragraph; no T.1–T.8 task includes them. A future plan T.9+ will add the rescan loops on top of the storage and event plumbing landed in this plan.

---

## Appendix: Task summary table

| ID | Title | Wave | Skill | Est LoC | Critical-path? |
|---|---|---|---|---|---|
| T.0.G7-verify | Wave G.7 layout verification | T.0 | storage | 80 | YES |
| T.0.G7-fill-gaps | Land missing per-entry-key writers (conditional) | T.0 | storage | 0–400 | YES (if triggers) |
| T.1.A | UxfTransferPayload + DeliveryStrategy | T.1 | types | 220 | YES |
| T.1.B.1 | TransferMode/Request widening + shims | T.1 | types | 320 | YES |
| T.1.B.2 | Audit shim removal (post-T.7.C) | T.7 | cleanup | 80 |  |
| T.1.C | DispositionReason + AuditStatus enums | T.1 | types | 200 |  |
| T.1.D | Encode/decode + limits module | T.1 | wire | 380 |  |
| T.1.E | PROFILE_KEY_MAPPING + Sphere.clear | T.1 | storage | 460 | YES |
| T.1.F | Lamport + 3-strategy mutex + CAS | T.1 | crdt | 580 | YES |
| T.2.A | Preflight finalize | T.2 | sender | 380 |  |
| T.2.B | Target validation + classifyToken | T.2 | sender | 540 |  |
| T.2.C | Delivery resolver + INVALID_INLINE_CAP | T.2 | wire | 320 |  |
| T.2.D.1 | Conservative-sender (no outbox) | T.2 | sender | 600 |  |
| T.2.D.2 | Conservative-sender outbox integration | T.2 | sender | 240 |  |
| T.2.E | Transport-layer adapter | T.2 | transport | 240 |  |
| T.3.A | Bundle acquirer + verifier | T.3 | recipient | 820 |  |
| T.3.B.1 | Per-element verifiers (incl. continuity) | T.3 | recipient | 760 |  |
| T.3.B.2 | Disposition matrix walker | T.3 | recipient | 720 |  |
| T.3.C | Multi-rep _invalid + _audit storage | T.3 | storage | 800 |  |
| T.3.D | Conflict / merge engine | T.3 | recipient | 540 |  |
| T.3.E | Worker pool + per-token cap | T.3 | worker | 660 |  |
| T.4.A | Sender CID-pin path | T.4 | sender | 320 |  |
| T.4.B | Recipient verified-CAR fetch | T.4 | recipient | 600 |  |
| T.5.A | Instant-sender orchestrator | T.5 | sender | 880 | YES |
| T.5.B.0 | Manifest-CID-rewrite + polling-policy | T.5 | worker | 380 |  |
| T.5.B.0.5 | OrbitDB-write-fairness ADR + cap | T.5 | crdt | 80 |  |
| T.5.B | Sender finalization worker | T.5 | worker | 1580 | YES |
| T.5.B.5 | Cascade walker (per-class) | T.5 | recipient | 540 | YES |
| T.5.C | Recipient finalization worker | T.5 | worker | 1740 | YES |
| T.5.D | importInclusionProof + revalidate | T.5 | recipient | 1120 | YES |
| T.5.E | Trustbase / security-alert / override events | T.5 | worker | 360 |  |
| T.5.F | trustBase staleness + refresh | T.5 | worker | 360 |  |
| T.6.A | UxfTransferOutboxEntry writer | T.6 | outbox | 480 | YES |
| T.6.B | CRDT merger (3-file split + property) | T.6 | crdt | 1060 | YES |
| T.6.C | Status-transition validator + dual-write | T.6 | outbox | 420 |  |
| T.6.D | Legacy outbox migration + backup | T.6 | migration | 700 |  |
| T.6.D.2 | Restore script + round-trip test | T.6 | migration | 380 |  |
| T.6.E | Crash-recovery test harness | T.6 | tests | 240 |  |
| T.7.A | TXF sender (both variants) | T.7 | sender | 720 | YES |
| T.7.B | Legacy receiver adapter | T.7 | recipient | 820 | YES |
| T.7.B.5 | Nametag re-resolution at receive | T.7 | recipient | 320 |  |
| T.7.C | Production call-site migration | T.7 | cli-cleanup | 420 |  |
| T.7.C.5 | ConnectHost coordination | T.7 | cli-cleanup | 220 |  |
| T.7.D | Forced-conservative coercion (payInvoice) | T.7 | cli-cleanup | 240 |  |
| T.7.E | Default-mode flip | T.7 | cli-cleanup | 220 | YES |
| T.8.A | T.2.D reference snapshot fixture | T.8 | tests | 220 |  |
| T.8.B | Capability hint surfacing | T.8 | transport | 380 |  |
| T.8.C | Error surface + redaction | T.8 | tests | 280 |  |
| T.8.D | Production cutover | T.8 | cli-cleanup | 480 | YES |
| T.8.E.1 | Integration test suite | T.8 | tests | 1100 |  |
| T.8.E.2 | Compatibility test suite | T.8 | tests | 600 |  |
| T.8.E.3 | Adversarial test suite | T.8 | tests | 1100 |  |

**Total**: 52 tasks (was 38; +14 from all splits + new tasks: T.0.G7-verify, T.0.G7-fill-gaps (conditional), T.5.B.0.5, T.7.B.5, T.7.C.5, T.5.F, T.6.D.2, plus pairs from C2/W1/W2/W3/W10), ~27,500 LOC including tests (was ~22,500), **15 critical-path tasks** (16 if T.0.G7-fill-gaps triggers).

**Tasks added/split (delta from v1)**:
- Split: T.1.B → T.1.B.1 + T.1.B.2 (W1)
- Split: T.2.D → T.2.D.1 + T.2.D.2 (C2)
- Split: T.3.B → T.3.B.1 + T.3.B.2 (W2)
- Split: T.5.B (peeled out T.5.B.0 + T.5.B.5) (W3 + C3)
- Split: T.8.E → T.8.E.1 + T.8.E.2 + T.8.E.3 (W10)
- New: T.5.F (trustBase staleness, W41)
- New: T.6.D.2 (restore script, C7)
- New: T.7.B.5 (nametag re-resolution, C9)
- New: T.7.C.5 (ConnectHost coordination, C5)

Critical-path tasks marked YES form the 15-PR longest serial chain detailed in §1 and §3 (16 PRs if T.0.G7-fill-gaps triggers).

---

*End of UXF-TRANSFER-IMPL-PLAN.md (v2, post-audit revision).*
