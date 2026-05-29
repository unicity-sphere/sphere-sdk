# Profile Aggregator Pointer Layer — Integration / Refactoring Map

Status: PRE-IMPLEMENTATION (complement to the greenfield module plan)
Scope: every existing codebase touchpoint required to land the pointer layer
Read first: `PROFILE-AGGREGATOR-POINTER-SPEC.md`, `PROFILE-AGGREGATOR-POINTER-ARCHITECTURE.md` §11–§15, `PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md` Appendix E

---

## §1 Touchpoints summary

| File | Lines (approx) | Change type | Why | Risk |
|---|---|---|---|---|
| `profile/profile-token-storage-provider.ts` | 808–893 (`flushToIpfs`), 975–1035 (`publishIpnsSnapshotBestEffort`), 1046–1085 (`recoverFromIpnsSnapshot`), 248–298 (`initialize`) | **Replace** IPNS call-sites with pointer-layer equivalents; keep flush-correctness boundary (CAR pin + OrbitDB write) unchanged | ARCH §3.2 / §15.1 | High — flush is hot path; IPNS fallback path must be preserved for backward-compat (§5 below) |
| `profile/profile-ipns.ts` | full file (346 lines) | **Keep as fallback** under legacy flag; ARCH §15.1 says delete but §5 argues for a compat window | Migration — live wallets have IPNS sequences published pre-pointer | High — premature deletion breaks N14 cold-start scenario |
| `profile/profile-storage-provider.ts` | 378–493 (`connect`/`doConnect`), 580–612 (`setIdentity`) | **Extend** lazy-attach flow to initialize the pointer layer after `setIdentity` + OrbitDB attach | SPEC §10 (recovery runs at init), ARCH §3.3 | Medium — must not regress two-phase connect semantics |
| `profile/types.ts` | 38–70 (`ProfileConfig`), 67 (`ipnsSnapshot` flag) | **Rename/add** `pointerAnchor?: boolean` (ARCH §15.1) or add `pointer?: { enabled, allowOperatorOverrides }` | ARCH §15.1, SPEC §13 capability flag | Low |
| `core/Sphere.ts` | 169–390 (options interfaces), 624–706 (`init`), 795–902 (`create`), 903–993 (`load`), 998–1149 (`import`), 3827 (`destroy`) | **Add** `pointer?: {...}` and `allowOperatorOverrides?: boolean` to all four options interfaces; wire recovery step into load/create/import progress reporter | SPEC §13 (capability gate on `acceptCarLoss`/`clearPendingMarker`/`acceptCorruptStreak`) | Medium — public API; needs careful defaults (enabled=true, overrides=false) |
| `core/Sphere.ts` | 3827 (`destroy()`) | **Extend** to release pointer-layer mutex, stop probe-fingerprint telemetry, flush BLOCKED flag state | SPEC §7.1.1 mutex cleanup | Low |
| `core/errors.ts` | 27–107 (`SphereErrorCode` union) | **Extend** with 27 `AGGREGATOR_POINTER_*` codes + `SECURITY_ORIGIN_MISMATCH` | SPEC §12 | Low — additive; error-code consumers (Connect dApps) need documentation only |
| `constants.ts` | 22–62 (`STORAGE_KEYS_GLOBAL`) | **Add** 3 keys: `POINTER_VERSION` (scoped), `POINTER_PENDING_VERSION`, `POINTER_BLOCKED_FLAG`, `POINTER_MUTEX` | SPEC §7.1.1, §7.1.2, §10.2.1 | Low — additive |
| `constants.ts` | anywhere after §NETWORKS | **Add** `POINTER_*` timing/retry constants from SPEC §3 (`PUBLISH_RETRY_BUDGET`, `PUBLISH_BACKOFF_MAX_MS`, `DISCOVERY_INITIAL_VERSION`, `DISCOVERY_HARD_CEILING`, `DISCOVERY_CORRUPT_WALKBACK`, `MARKER_MAX_JUMP`, `CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS`, `CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS`, `POINTER_PEER_DISCOVERY_MS`, `MAX_CAR_BYTES`, `MAX_CAR_FETCH_TOTAL_MS`, `MAX_CAR_FETCH_STALL_MS`, `PROBE_REQUEST_TIMEOUT_MS`, `VERSION_MIN`, `VERSION_MAX`, `CID_MAX_BYTES`). SPEC v3.4 removed `MIN_MIRROR_COUNT`, `MIRROR_LIST_SHA256`, `MIRROR_CERT_PINS`. | SPEC §3 (normative, v3.4) | Low |
| `oracle/oracle-provider.ts` | 25–88 | **Minor extend**: declare optional `submitPointerCommitment?(req)` and `getExclusionProof?(requestId)`, OR require consumers to call `getAggregatorClient()` and use the SDK client directly (no interface change) | SPEC §4.6, §8.1 | Low if latter route taken |
| `oracle/UnicityAggregatorProvider.ts` | 123–310 | **No change** — already exposes `getAggregatorClient()` which returns the underlying `@unicitylabs/state-transition-sdk/AggregatorClient`. Pointer layer uses that directly | ARCH §3.4, §4.6 | Low |
| `impl/shared/ipfs/ipns-key-derivation.ts` | full file | **Keep** (still used by non-Profile IPFS path); pointer layer uses the same HKDF pattern with different info strings | ARCH §3.4 | Low |
| `impl/shared/trustbase-loader.ts` | full file | **Consumed unchanged** (SPEC v3.4 §8.4 embedded-trust-base model). No refactor needed: the existing single-embedded-TrustBase-per-network loader is the v1 correct pattern. Pointer layer obtains the same instance via `OracleProvider.getRootTrustBase()` (T-C7). | ARCH §6.5, SPEC v3.4 §8.4 | None in v1 — multi-mirror TOFU deferred to v2 |
| `impl/shared/ipfs/ipfs-http-client.ts` | full file | **Extend** with CAR-fetch stall-rate enforcement, content-encoding rejection, multi-gateway race with timeouts | SPEC §3 (`MAX_CAR_FETCH_STALL_MS`), §10.7, §12 `CAR_UNEXPECTED_ENCODING` | Medium — shared with existing non-Profile IPFS paths |
| `impl/browser/index.ts` + `createBrowserProviders` | factory function | **Extend** to inject Web Locks API verification (reject fallback) for pointer mutex (SPEC §7.1.1) and pass the `RootTrustBase` to the Profile storage provider | SPEC §7.1.1 | Medium |
| `impl/nodejs/index.ts` + `createNodeProviders` | factory function | **Extend** to configure `proper-lockfile`-based publish mutex at `<dataDir>/profile/<hex(pubkey)>/publish.lock` | SPEC §7.1.1 | Low — `proper-lockfile` already a dep |
| `modules/payments/PaymentsModule.ts` | 2393, 4113, 4127, 4165, 6102–6109 (5+ storage.set call sites); `addTransactionHistory` sites | **Stamp** `originated: 'user'` tag on OpLog entries; `'system'` on cache-index/session-state writes | SPEC §10.2.3.1 (W11 mandatory) | Medium — 5+ sites, touched by hot payment path |
| `modules/accounting/AccountingModule.ts` | 6052, 6213 (+invoice lifecycle events) | **Stamp** `originated: 'user'` on `invoice_mint`, `invoice_pay`, `invoice_close`; `'system'` on balance-cache refresh | SPEC §10.2.3.1 | Low |
| `modules/swap/SwapModule.ts` | per-swap state writes under `swap:{swapId}` | **Stamp** `originated: 'user'` on `swap_propose`, `swap_accept`, `swap_deposit`; `'system'` on status cache | SPEC §10.2.3.1 | Low |
| `modules/communications/CommunicationsModule.ts` | 194, 209, 268, 587, 626, 702 | **Stamp** `originated: 'user'` on `dm_send`; `'replicated'` on `dm_receive` | SPEC §10.2.3 ("receiver stamps as replicated regardless") | Medium — DM receive path is subtle |
| `profile/orbitdb-adapter.ts` | `put`/`get` API | **Extend** to accept/propagate originated-tag metadata; add entry-type→`originated` validation pass on replicated writes (SPEC §10.2.3 "semantic re-validation D5") | SPEC §10.2.3 D5 | Medium — new cross-cutting contract |
| `cli/index.ts` | 1720 (`init`), 1830 (`status`), 1886 (`clear`) + new cases | **Add** commands: `profile pointer status`, `profile pointer recover`, `profile unblock`, `profile flush`, flag `--no-pointer` on `init` | TEST-SPEC Appendix E | Low — additive |
| `cli/bin.mjs` | 17 lines | **No change** — dispatcher unchanged | — | — |
| `package.json` | 161–181 (deps) | **No new deps**: HKDF in `@noble/hashes`, secp256k1 in `@noble/curves`, SDK primitives in `@unicitylabs/state-transition-sdk`, `proper-lockfile` already present | — | — |
| `index.ts` | 521–532 (Profile exports) | **Add** pointer-layer barrel exports (`ProfilePointerLayer` type, error codes) | — | Low |
| `profile/index.ts` | factory + exports | **Add** `createProfilePointerLayer({ identity, oracle, trustBase, storage, mutex })` factory | — | Low |
| `tests/unit/profile/` | new `pointer/` subdir | **Add** unit test files (see §7) | — | — |
| `tests/e2e/` | new `pointer-n*.sh` | **Add** 14 N-scenario scripts per TEST-SPEC | — | — |
| `.github/workflows/ci.yml` | pipeline | **Verify** `npm run test:run` picks up new tests; consider adding `test:pointer` stage if heavy | — | Low |

---

## §2 Extension points (no-breakage)

### 2.1 OracleProvider / AggregatorClient
The `OracleProvider` interface in `oracle/oracle-provider.ts:25–88` already has two escape hatches:
- `getAggregatorClient()` (line 78–81) returns `@unicitylabs/state-transition-sdk/AggregatorClient` — this is the EXACT primitive SPEC §4.6 requires (`aggregatorClient.submitCommitment(request)`, inclusion/exclusion proofs).
- `waitForProofSdk?(commitment, signal)` (line 87) is commitment-based.

**Decision:** pointer layer should consume via `oracle.getAggregatorClient()` rather than `oracle.submitCommitment()`. The existing `submitCommitment()` shape (`TransferCommitment`) assumes a token-bound transfer — pointer commitments are deliberately NOT token-bound. No interface change needed.

**Open question:** should we add a discoverability hint to `OracleProvider` (e.g., `supportsRawCommitments: boolean`) or just fail loudly if `getAggregatorClient()` returns `undefined`? Prefer the latter — fewer interface surfaces.

**SPEC v3.4 addition:** `OracleProvider.getRootTrustBase()` (added by T-C7) returns the embedded `RootTrustBase` instance from `assets/trustbase/<network>.ts` — the same instance `PaymentsModule` / L4 consumes (H6 shared-base contract, SPEC v3.4 §8.4.2). The pointer layer consumes this getter directly; no mirror list, no multi-mirror cross-check, no runtime fetch. Multi-mirror TOFU is v2 future work.

### 2.2 Nostr transport
Not reused. Pointer layer is strict HTTP JSON-RPC to the aggregator. The one cross-call is the `POINTER_PEER_DISCOVERY_MS` poll over OrbitDB gossipsub / Nostr for the `acceptCarLoss` protocol (SPEC §10.7.1 step 3) — this uses the existing `NostrTransportProvider` and OrbitDB gossipsub pubsub, no new transport.

### 2.3 BIP32 key derivation (`core/crypto.ts`)
SPEC §4 requires `pointerSecret = HKDF-SHA256-Extract+Expand(walletPrivateKey, info="uxf-profile-aggregator-pointer-v1")`. The existing wallet private key is available via `FullIdentity.privateKey` (hex) in Sphere and Profile; the existing `deriveProfileIpnsIdentity` in `profile/profile-ipns.ts:111–127` already shows the correct HKDF pattern. **No changes needed to BIP32 derivation** — pointer layer derives from the private key post-BIP32 via HKDF, not a new BIP32 path.

### 2.4 HTTP client / fetch wrapper
`impl/shared/ipfs/ipfs-http-client.ts` is a shared fetch wrapper. The pointer layer's aggregator JSON-RPC path reuses the AggregatorClient's internal HTTP transport (from `state-transition-sdk`), not this one. CAR-fetch with stall-rate enforcement (SPEC §10.7) needs a hardened HTTP layer with:
- Content-encoding header rejection for CAR fetches.
- Per-gateway timeout + retry.

**SPEC v3.4 scope reduction:** TLS cert pinning (formerly via `MIRROR_CERT_PINS`), bundled mirror-list integrity (formerly via `MIRROR_LIST_SHA256`), and multi-mirror parallel fetch with byte-identical cross-check are **deferred to v2** under the embedded-trust-base model. No pointer-specific HTTP hardening beyond the CAR-fetch stall/encoding concerns above.

**Open question:** should this live in `impl/shared/ipfs/` (reuse existing HTTP client) or in a new `profile/pointer/http-client.ts` isolated to the pointer path? Under SPEC v3.4 reduced scope, reusing the shared IPFS HTTP client is preferable — no pointer-specific cert-pinning / mirror-list hardening to isolate.

---

## §3 Files that require modification

### 3.1 `core/Sphere.ts`
- **What changes:** Add `pointer?: { enabled?: boolean; allowOperatorOverrides?: boolean; mirrors?: string[] }` and `allowOperatorOverrides?: boolean` to `SphereInitOptions` (328–390), `SphereCreateOptions` (169–219), `SphereLoadOptions` (220–264), `SphereImportOptions` (265–327). Wire into `load()` (line 947 `initializeProviders()`) and `create()` to attach pointer after `setIdentity()` but before returning. Emit progress step `{ step: 'pointer_recovery', message: 'Recovering from aggregator pointer…' }`.
- **Why:** SPEC §13 requires `allowOperatorOverrides` at init time (capability gate); ARCH §3.3 requires recovery to run during `initialize()`.
- **Risk:** Changes to public `SphereInitResult` / option shapes. Existing callers in `openclaw-unicity`, `sphere` app, `agentsphere` must be verified.
- **Test coverage needed:** N1 (first-run), N14 (legacy IPNS fallback), recovery progress event firing, operator-override gate rejection.

### 3.2 `profile/profile-storage-provider.ts`
- **What changes:** In `doConnect()` (425–493), after Phase B OrbitDB attach, invoke the pointer-layer `initialize()` (SPEC §10 recovery flow). Pointer recovery MUST run **before** `ProfileTokenStorageProvider.initialize()` because it writes bundle refs that the latter reads (ARCH §3.3). Thread BLOCKED-flag state through to `isConnected()` — a blocked wallet reports a new `readonly` substate.
- **Why:** SPEC §10 recovery is an init-time concern; ARCH §3.3 specifies the trigger point.
- **Risk:** Two-phase connect already has 3 `dbStatus` states (`attached`/`attaching`/`fatal`). Adding pointer recovery states risks combinatorial explosion. Recommend keeping pointer-layer state INTERNAL to the pointer-layer object, surfacing only a single `pointerReady` boolean back to ProfileStorageProvider.
- **Test coverage needed:** Existing `tests/unit/profile/profile-storage-provider.test.ts` must not regress. New tests: pointer init failure during connect must not break cache; BLOCKED state blocks writes but not reads (N7a/N7b).

### 3.3 `profile/profile-token-storage-provider.ts`
- **What changes:**
  1. `flushToIpfs()` (808–893): replace `publishIpnsSnapshotBestEffort()` call at line 879 with `publishAggregatorPointerBestEffort(cid, nextVersion)`. Preserve the best-effort semantics and the pre-flush `lastPinnedCid` idempotence.
  2. `initialize()` (248–298): replace `recoverFromIpnsSnapshot()` call at line 279 with `recoverFromAggregatorPointer()`. **Keep** the `knownBundleCids.size === 0` trigger condition (ARCH §3.3 unchanged).
  3. Delete or hide `publishIpnsSnapshotBestEffort()` (975–1035) and `recoverFromIpnsSnapshot()` (1046–1085) behind a `pointerAnchor === false` fallback (§5).
- **Why:** ARCH §3.2, §3.3 — this is the primary integration surface.
- **Risk:** `flushToIpfs` is the hot path for every `save()`; any synchronous blocking cost added here affects every UI interaction. Pointer publish MUST remain best-effort (never throws, never blocks flush success).
- **Test coverage needed:** N1–N14 (all end-to-end scenarios), plus: `tests/unit/profile/profile-token-storage-provider.test.ts` regression set.

### 3.4 `core/errors.ts`
- **What changes:** Add 27 new `AGGREGATOR_POINTER_*` codes to `SphereErrorCode` union (lines 27–107), plus `SECURITY_ORIGIN_MISMATCH`. All per SPEC §12.
- **Why:** SPEC §12 mandates specific error codes; Connect dApps and UIs will `switch` on them.
- **Risk:** Low — additive. Any consumer that doesn't handle new codes falls through to the default branch (`showToast(err.message)` in the example).
- **Test coverage needed:** every error code must have at least one emitting test case; TEST-SPEC explicitly enumerates scenarios N1–N14 covering most codes.

### 3.5 `constants.ts`
- **What changes:** Add a new block `POINTER_CONSTANTS` mirroring SPEC §3 (v3.4) exactly. SPEC v3.4 removed `MIN_MIRROR_COUNT`, `MIRROR_LIST_SHA256`, `MIRROR_CERT_PINS` — none to bundle.
- **Why:** SPEC §3 is normative; constants must be in-bundle so they can't be tampered via runtime config.
- **Risk:** Low. Mirror-related constants are absent in v1; if multi-mirror TOFU returns in v2, they will be reintroduced alongside the bundled trustbase assets.
- **Test coverage needed:** Constants freeze test — verify no runtime mutation.

### 3.6 `package.json`
- **What changes:** **None** — see §8.

---

## §4 Originated-tag migration (W11)

SPEC §10.2.3.1 explicitly enumerates the W11 stamping mandate. Required changes:

| Module:function | Current write | Target `originated` | Migration strategy |
|---|---|---|---|
| `modules/payments/PaymentsModule.ts:2393` | `storage.set(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY, …)` (token transfer recorded) | `'user'` | Wrap in helper `stampAndPersist(key, value, { originated: 'user' })` that sets a parallel `{key}_origin` metadata cell, OR extend the storage adapter to accept an `originated` option |
| `modules/payments/PaymentsModule.ts:4113, 4127, 4165` | V5 pending token writes, processed-split dedup | `'system'` | Same helper |
| `modules/payments/PaymentsModule.ts:6102, 6109` | Outbox push / drain | `'user'` (outbox is user-authored intent) | Same helper |
| `modules/accounting/AccountingModule.ts:6052, 6213` | Invoice state updates (mint/pay/close) | `'user'` | Same helper |
| `modules/swap/SwapModule.ts` (swap-record prefix `swap:{swapId}`) | Swap state machine transitions | `'user'` on propose/accept/deposit; `'system'` on status-cache refresh | Same helper |
| `modules/communications/CommunicationsModule.ts:194, 209, 268, 587, 626, 702` | DM save paths (incoming + outgoing) | Outgoing `dm_send` → `'user'`; incoming `dm_receive` → `'replicated'` regardless of sender's stamped value | Per-call-site explicit tag — the sender/receiver distinction is only visible at the message-ingest call site |
| `profile/profile-token-storage-provider.ts:879` (flushToIpfs batch bundle event) | `tokens.bundle.{cid}` write | `'system'` | Stamp directly in `flushToIpfs` |

**Cross-cutting infrastructure.** Recommend a single `originated` column on OpLog entries (CRDT-safe since it's an additive tag, not a mutation). Two possible designs:
1. Extend `profile/orbitdb-adapter.ts` `put(key, value, meta?: { originated })` — explicit per-site, easy to audit.
2. Default to `'user'` fail-closed at the adapter level, require explicit `'system'` / `'replicated'` opt-in — matches SPEC §10.2.3 "treated conservatively as `'user'`".

**Semantic re-validation (D5).** The adapter MUST run entry-type → expected-originated validation on both locally-authored and replicated writes. Reject mismatches with `SECURITY_ORIGIN_MISMATCH` before persistence.

**Test coverage:** `tests/unit/profile/originated-tag.test.ts` — every emit site has a test proving the tag is stamped correctly; D5 re-validation blocks forged tags.

---

## §5 Backward compatibility

### 5.1 Wallets initialized BEFORE pointer layer exists
A pre-pointer wallet has:
- `profile.ipns.sequence` in local storage (see `profile/profile-ipns.ts:57`).
- An IPNS record pointing to a snapshot with active bundle CIDs.
- No `profile.pointer.*` state.

On cold-start recovery (N14 per TEST-SPEC), the pointer layer:
1. Probes aggregator at `v=1` (SPEC §8.2 Phase 1).
2. Gets an exclusion proof → "no pointer ever published" → falls through to legacy IPNS recovery.
3. Once legacy recovery succeeds, the FIRST subsequent `flushToIpfs()` publishes at `v=1` via the pointer layer, seeding the new anchor.

**Required implementation:** `recoverFromAggregatorPointer()` must NOT delete `recoverFromIpnsSnapshot()` — it must fall through to it when the aggregator returns exclusion-at-v=1 AND local config permits. This contradicts ARCH §15.1's "delete the file" directive but is necessary for N14 unless we forbid legacy-wallet recovery. **Open question:** do we enforce migration (break N14) or run both channels (file stays)?

### 5.2 `--no-pointer` config flag
- Lives in `SphereInitOptions.pointer = { enabled: false }` (§3.1).
- Surfaced in CLI via `sphere init --no-pointer` (§6 below, TEST-SPEC line 1486).
- When `enabled: false`, `ProfileTokenStorageProvider` falls through to legacy IPNS; `publishAggregatorPointerBestEffort` is a no-op; errors table entries `AGGREGATOR_POINTER_*` are unreachable.

### 5.3 Migration strategy
**Automatic opt-in.** Existing wallets get pointer layer on next load. First successful pointer publish "graduates" the wallet; the legacy IPNS publish remains a no-op warning in that flush for one more cycle, then can be removed.

**Fail-forward.** A pointer-init failure must NOT block load. The pointer layer signals its blocked state via `isPublishBlocked()` / `AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED`; the wallet remains read-only until reachability is restored.

---

## §6 CLI surface additions

TEST-SPEC Appendix E (line 1468+) enumerates 3 PENDING-IMPL pointer-specific commands plus the `--no-pointer` flag. Mapped to current CLI structure (`cli/index.ts` uses a flat `case` dispatcher, lines 1720+):

| Command | Location | Output format | Exit codes |
|---|---|---|---|
| `sphere profile pointer status` | new `case 'profile':` subcommand `pointer status` near existing `case 'status':` (1830) | JSON: `{ localVersion, blocked, probeFingerprint, lastRecoveryAt, carLossPending?, markerCorrupt? }` — machine-readable per I-OR oracle-independence rule from TEST-SPEC | 0 success, 1 blocked, 2 network-error |
| `sphere profile pointer recover` | same location, subcommand `pointer recover` | JSON: `{ discoveredVersion, carFetched, durationMs, outcome }` | 0 success, 3 `_CORRUPT_STREAK`, 4 `_CAR_UNAVAILABLE` |
| `sphere profile pointer flush` | aliases to `profile flush` (used by N1/N2) | JSON: `{ publishedVersion, cid }` | 0 success, 5 `_CONFLICT` (after retry budget), 6 `_BLOCKED` |
| `sphere profile unblock` | new top-level `case 'profile-unblock':` OR subcommand under `profile` | JSON: `{ cleared: 'marker' \| 'car_loss' \| 'corrupt_streak', reason, acknowledged }` — gated behind `--i-understand-risks` confirmation | 0 cleared, 7 `_CAPABILITY_DENIED` |
| `sphere init --no-pointer` | extend existing `case 'init':` (1720) | existing JSON output + `{ pointerEnabled: false }` | existing codes |

**Cross-cutting CLI concerns:**
- All new commands must honor existing `--dataDir` / `--tokensDir` / `--network` flags.
- All outputs must include `{ pointerVersion?: number, aggregatorReachable?: boolean }` in a common wallet-status JSON stanza for test-script parsing (TEST-SPEC uses `grep -oE "localVersion.*[0-9]+"` which implies a human-readable line too).
- Completions (`completions bash/zsh/fish` in cli/index.ts:5607–5609) must be regenerated to include `profile pointer` and `profile unblock`.

---

## §7 Test-harness integration

### 7.1 Unit tests — `tests/unit/profile/pointer/`
New subdirectory. Files:
- `key-derivation.test.ts` — HKDF chain, test vectors from SPEC §14.
- `payload-encoding.test.ts` — length-prefix, 64-byte envelope, deterministic padding.
- `xor-round-trip.test.ts` — encode/decode symmetry, canonical vector.
- `request-id.test.ts` — `RequestId.createFromImprint` agreement with canonical vector.
- `discovery.test.ts` — exponential + binary-search + walk-back, mocked aggregator (reuse `mockAggregator` harness pattern).
- `publish.test.ts` — conflict retry, partial publish, REQUEST_ID_EXISTS idempotence.
- `crash-safety.test.ts` — pending-version marker, stale-marker compaction, MARKER_CORRUPT.
- `originated-tag.test.ts` — every module emits the correct tag; D5 re-validation.
- `blocked-flag.test.ts` — SET on unreachable + user-write; CLEAR on (a) exclusion-at-1 or (b) successful recovery.

### 7.2 Integration tests
Reuse existing mocks: `tests/unit/profile/profile-token-storage-provider.test.ts` already mocks IPFS + OrbitDB — extend with a `mockAggregator` that implements `submitCommitment` / `getInclusionProof` against an in-memory SMT.

### 7.3 E2E scripts — `tests/e2e/pointer-n*.sh`
Per TEST-SPEC, 14 scenarios (N1–N14). The 14 scripts source `tests/e2e/pointer-N0-prologue.sh` for shared setup/teardown (preflight gate, CLI resolution, workspace bootstrap). Pattern: each script declares its `TEST_NAME`, sources the prologue, and runs the scenario.

**Open question:** N3 and N5 require aggregator downtime simulation — do we mock via network-level blocking (iptables) or via a test-harness aggregator that can be paused? Recommend the latter for CI portability.

### 7.4 Vitest config
No changes. New `.test.ts` files are picked up by default. Heavy E2E (`.sh`) runs are invoked individually (e.g. `bash tests/e2e/pointer-N1.sh`); a future batch runner would source the standard pass/fail sentinel lines emitted by `pointer-N0-prologue.sh`.

### 7.5 CI — `.github/workflows/ci.yml`
Add a `test-pointer` job or extend `test` with `POINTER_LAYER=1` env. Ensure CI has network egress to a mocked aggregator (testcontainers) — real testnet aggregator is rate-limited and non-deterministic.

---

## §8 Dependency additions

Scanned `package.json` (lines 161–181). Required primitives per SPEC §4.6:

| Primitive | Already present? | Import path |
|---|---|---|
| HKDF-SHA256 | YES (`@noble/hashes` ^2.0.1) | `@noble/hashes/hkdf.js` — same usage as `profile/profile-ipns.ts:32` |
| SHA-256 | YES (`@noble/hashes`) | `@noble/hashes/sha2.js` |
| secp256k1 signing | YES (via `@unicitylabs/state-transition-sdk` SigningService, and `@noble/curves`) | `@unicitylabs/state-transition-sdk/lib/...` |
| DataHasher / DataHash / RequestId / Authenticator / InclusionProof / RootTrustBase / AggregatorClient | YES | `@unicitylabs/state-transition-sdk/lib/...` — already used by `oracle/UnicityAggregatorProvider.ts` |
| Node file-lock (`proper-lockfile`) | YES (^4.1.2, already listed) | unchanged |
| Web Locks API (browser) | N/A (native browser API) | `navigator.locks.request(...)` |

**Conclusion: zero new npm dependencies.** This is rare and load-bearing — verify with lockfile diff during implementation. The `package-lock.json` is currently conflicted (`UU` in git status) which is orthogonal.

---

## §9 Surprises / unknowns

1. **Duplicate TokenRegistry bundles (existing, CLAUDE.md-documented).** `Sphere.configureTokenRegistry()` (Sphere.ts:787) runs TWICE — once in `createBrowserProviders`, once in `Sphere.init`, because tsup duplicates the singleton. The pointer layer has a similar risk with its `RootTrustBase` bundled constants. Recommend: make the pointer layer a pure function module with no singleton state; pass `trustBase` explicitly (the embedded instance obtained via `OracleProvider.getRootTrustBase()` per SPEC v3.4 §8.4.2). No `mirrors` parameter in v1.

2. **IPNS fallback contradicts ARCH §15.1 "delete the file".** ARCH declares `profile/profile-ipns.ts` deleted wholesale. But §5 backward compatibility requires it for N14 (pre-pointer wallet cold-start). **Open question:** strict migration (break N14, matching ARCH §15.3 "no grace period") or compat window? The spec's own test case N14 assumes compat exists — contradiction.

3. **`ipnsSnapshot` flag rename to `pointerAnchor`.** `ProfileConfig.ipnsSnapshot` (profile/types.ts:67) is documented as default `true`. Renaming per ARCH §15.1 breaks every downstream consumer that sets it explicitly (tests, config files). Recommend: add `pointerAnchor` alongside `ipnsSnapshot`, deprecate the latter across one release.

4. ~~**Multi-mirror trustbase loader.**~~ **RESOLVED in SPEC v3.4.** The single-embedded-TrustBase-per-network loader (`impl/shared/trustbase-loader.ts:getEmbeddedTrustBase`) is the correct v1 model. No refactor needed per SPEC v3.4 amendment — embedded trust base is the correct v1 model. Multi-mirror TOFU is deferred to v2 and will be a moderate refactor then, not now.

5. **`OracleProvider.submitCommitment` signature mismatch.** The existing `TransferCommitment` (oracle/oracle-provider.ts:94–103) requires a `sourceToken` — pointer commitments have no source token. Using `oracle.getAggregatorClient()` bypasses this cleanly, but introduces a tighter coupling to the SDK client version. **Flag:** if `@unicitylabs/state-transition-sdk` bumps its commitment API, the pointer layer breaks along with the oracle module.

6. **Sphere.destroy() and mutex cleanup.** `Sphere.destroy()` at core/Sphere.ts:3827 must release the publish mutex. If a tab is killed mid-publish, the Web Locks API auto-releases; but `proper-lockfile` has a stale-lock timeout (SPEC §7.1.1 says `PUBLISH_BACKOFF_MAX_MS * 2 = 8000ms`). Need a `destroy()` path that explicitly releases.

7. **Originated-tag stamping during replication.** SPEC §10.2.3 says replicated entries must stamp `'replicated'` at the RECEIVER. But `profile/orbitdb-adapter.ts` currently has `onReplication` callbacks that fire AFTER entries are already persisted locally — which means the stamping must be upstream of persistence. Risk: existing replication code path needs refactor, not just hook.

8. **BLOCKED flag scope under multi-wallet single-device.** SPEC §10.2.1 scopes `BLOCKED_FLAG_KEY` by `hex(signingPubKey)`. If a user has two wallets on one device (Sphere supports this via `TRACKED_ADDRESSES`), each HD address's pointer layer has its own BLOCKED state. The current CLI's `profile pointer status` must report per-active-address. **Open question:** do we also support querying all addresses at once?

9. **`init` already does two things.** `Sphere.init()` at 624 either loads OR creates. The pointer layer's recovery is needed in both paths. The progress callback (`onProgress`) already has 14 steps in `load()` — adding a 15th step `pointer_recovery` is fine, but telemetry consumers may depend on the fixed step list.

10. **`--no-pointer` might be an attack vector.** If a user CLI-flag-disables the pointer layer to "work around a bug," they lose cross-device anchoring. A malicious app on the same device could also pass `--no-pointer` to silently desync. Recommend: `--no-pointer` MUST emit a loud one-time warning per wallet that is persisted; re-enabling must trigger a full recovery.

11. **HKDF info-string collision.** `PROFILE_IPNS_HKDF_INFO = 'uxf-profile-ed25519-v1'` (profile-ipns.ts:51) and `pointerSecret` uses `'uxf-profile-aggregator-pointer-v1'` (SPEC §4.1). Both derive from the same wallet private key. HKDF domain separation makes outputs independent — but the info-string convention should be linted to prevent future drift.

12. **`proper-lockfile` vs Node worker threads.** SPEC §7.1.1 requires cross-context mutex. `proper-lockfile` guards against cross-process but NOT cross-thread within the same process. If any consumer runs Sphere in a Node worker_thread, the mutex is insufficient. Flag for v2.
