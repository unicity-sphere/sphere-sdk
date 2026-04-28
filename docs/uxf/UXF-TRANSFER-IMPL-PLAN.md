# UXF Transfer Implementation Plan

> Companion document to [`UXF-TRANSFER-PROTOCOL.md`](UXF-TRANSFER-PROTOCOL.md). The protocol spec is the contract; this plan structures the work into PR-sized tasks for parallel execution. References of the form "§N.N" point at the canonical protocol unless prefixed (PA = PROFILE-ARCHITECTURE.md, OL = PROFILE-OPLOG-SCHEMA.md, INV = SDK-STORAGE-INVENTORY.md, DD = DESIGN-DECISIONS.md, API = docs/API.md).

---

## §1 Overview & critical path

### Goal

Land §13 waves T.1–T.8 of the inter-wallet transfer protocol behind a feature flag (`UXF_TRANSFER_V1`), in a way that lets multiple agents work in parallel and lets us cut over from the legacy single-coin TXF send path to the bundle-grained UXF path without a flag day.

### Architectural core (load-bearing)

Three artifacts gate every other task:

1. **Wire-format types** (`types/uxf-transfer.ts`, NEW) — `UxfTransferPayload` discriminated union, `DeliveryStrategy`, the widened `TransferMode = 'instant' | 'conservative' | 'txf'`, `DispositionReason`, `AuditStatus`. Anything that encodes, decodes, persists, queues, or dispatches a transfer touches these types.
2. **Profile key mapping extension** (`profile/types.ts` `PROFILE_KEY_MAPPING`) — adding `audit` (NEW), `finalization_queue` (NEW), and the multi-representation key form for `invalid` (widened) MUST land before any disposition writer can target those collections.
3. **OrbitDB CRDT primitives** (`profile/profile-token-storage-provider.ts`) — the per-tokenId mutex / CAS pathway and the Lamport-clock writer for `UxfTransferOutboxEntry` are the bedrock for §5.5 step 9 and §7.1 conflict resolution.

These three items are the **critical path**. Everything else parallelizes off them.

### Wave topology

```
T.1 (foundations: types + key-mapping + OrbitDB primitives)
 │
 ├───────────────────────┬──────────────────────┬─────────────────────┐
 │                       │                      │                     │
 ▼                       ▼                      ▼                     ▼
T.2 (sender              T.3 (recipient ingest  T.6 (outbox refactor  T.8.tests-prep
     conservative             + decision matrix       + CRDT semantics       (fixtures,
     UXF + delivery           + _audit/_invalid       + legacy migration     adversarial
     strategy)                multi-rep storage)      §7.2)                  scaffolding)
 │                       │                       │                     │
 │                       ▼                       │                     │
 │                  T.4 (CID-pin delivery)       │                     │
 │                       │                       │                     │
 └───────────────────────┴───────────┬───────────┘                     │
                                     │                                 │
                                     ▼                                 │
                        T.5 (instant mode + finalization workers)      │
                              │                                        │
                              ▼                                        │
                        T.7 (TXF as opt-in; legacy adapter ───────────┘
                              receiver-side; production
                              call-site migration)
                              │
                              ▼
                        T.8 (capability hints, error surfacing,
                              chain-mode integration tests, rollout)
```

### Critical path (longest serial chain)

`T.1.A → T.1.B → T.1.E → T.6.A → T.6.B → T.5.A → T.5.B → T.5.D → T.7.E → T.8.E` ≈ 10 PRs that must land in order. Everything else (T.2.*, T.3.*, T.4.*, fixture work, adversarial tests) can hang off the appropriate prefix.

### Feature flag

`UXF_TRANSFER_V1` is a global runtime flag (env var + Sphere config option):
- **Off (default through end of T.6)**: existing single-coin TXF send/receive path. The widened types from T.1 are present and TypeScript-checked but unused at runtime.
- **On**: route `payments.send()` through the new bundle dispatcher; activate UXF inbound handler ahead of the legacy adapter; run the dual-write outbox (legacy + new) for migration safety.
- **Cutover**: T.8.D removes the legacy code path entirely; flag becomes vestigial.

---

## §2 Wave breakdown (T.1 through T.8)

Each task lists `id, title, wave, files_touched, depends_on, parallel_with, skill_tag, acceptance, est_loc, risks, spec_refs`. `est_loc` is a senior-eng estimate including tests.

### T.1 — Wire-format types (foundation)

T.1 lands the types, enums, and key-mapping rows. Nothing in T.1 changes runtime behavior — call-sites still hit the legacy path. T.1 unblocks T.2/T.3/T.6 in parallel.

---

#### T.1.A — `UxfTransferPayload` discriminated union + `DeliveryStrategy`

- **wave**: T.1
- **files_touched**:
  - NEW: `types/uxf-transfer.ts` (~150 LOC) — `UxfTransferPayload`, `UxfTransferPayloadCar`, `UxfTransferPayloadCid`, `LegacyTokenTransferPayload`, `DeliveryStrategy`.
  - MODIFIED: `types/index.ts` (re-export from `uxf-transfer`).
  - NEW: `tests/unit/types/uxf-transfer.types.test.ts` (compile-time + runtime guard tests).
- **depends_on**: none.
- **parallel_with**: T.1.B, T.1.C, T.1.D, T.8.A (fixtures scaffold).
- **skill_tag**: `types`
- **acceptance**:
  - `UxfTransferPayload` discriminated on `kind: 'uxf-car' | 'uxf-cid' | 'legacy'`; `version: '1.0'`; `mode: 'conservative' | 'instant'`.
  - `DeliveryStrategy` = `{kind:'auto', inlineCapBytes?:number} | {kind:'force-inline'} | {kind:'force-cid'}`.
  - `isUxfTransferPayload(value): value is UxfTransferPayload` runtime guard returns `false` on null/undefined/missing fields.
  - `isLegacyTokenTransferPayload(value)` recognizes all four legacy shapes (§3.4).
  - Discriminator narrowing demonstrated in a TypeScript fixture file (compile-only test).
- **est_loc**: 220.
- **risks**: legacy shape detection ambiguity (V5 INSTANT_SPLIT and V6 COMBINED_TRANSFER overlap on some keys) — write detector with version-precedence rules, document precedence inline.
- **spec_refs**: §3.1, §3.2, §3.3, §3.3.1, §3.4.

---

#### T.1.B — Widen `TransferMode` to `'instant' | 'conservative' | 'txf'` and update `TransferRequest`

- **wave**: T.1
- **files_touched**:
  - MODIFIED: `types/index.ts` (`TransferMode`, `TransferRequest` widening per §10.1).
  - NEW: `types/asset-target.ts` (~50 LOC) — `AdditionalAsset`, `AssetTarget` discriminated unions.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — add `// TODO(T.1.B)` markers on the two existing `transferMode === 'conservative'` switches; do NOT route the new path yet. ADD a default arm that throws `UNSUPPORTED_TRANSFER_MODE` for `'txf'` so the breaking-widening lands cleanly without a runtime regression (T.7.A re-implements that arm).
  - MODIFIED: `cli/index.ts:2812` (the `transferMode = forceConservative ? 'conservative' : 'instant'` assignment retains semantics; add explicit union annotation).
  - MODIFIED: any other site flagged by `tsc` exhaustiveness (target audit list — see Migration §6.B).
  - NEW: `tests/unit/payments/transfer-mode-widening.test.ts` — verifies `'txf'` is rejected with the typed error pre-T.7.
- **depends_on**: T.1.A.
- **parallel_with**: T.1.C, T.1.D.
- **skill_tag**: `types`
- **acceptance**:
  - `TransferRequest` declares `coinId?: string`, `amount?: string`, `additionalAssets?: ReadonlyArray<AdditionalAsset>`, `allowPendingTokens?: boolean`, `confirmNftPending?: boolean`, `delivery?: DeliveryStrategy`, `txfFinalization?: 'instant' | 'conservative'`.
  - `AdditionalAsset = {kind:'coin', coinId, amount} | {kind:'nft', tokenId}` per API.md §`send` widening.
  - All call-sites in `modules/`, `cli/`, `tests/` compile under strict mode without `as any`.
  - `payments.send({ transferMode: 'txf', ... })` rejects with `UNSUPPORTED_TRANSFER_MODE` (placeholder until T.7.A).
  - `payments.send({})` (no `coinId`/`amount`/`additionalAssets`) returns `EMPTY_TRANSFER` validation error (already enforced in §4.1 step 1; we just confirm the type permits the call).
- **est_loc**: 280.
- **risks**: hidden exhaustiveness check in third-party code (e.g., agentsphere, sphere app) — gate by exporting the enum and adding a release note.
- **spec_refs**: §10.1, §4.1 step 1, API.md `send`.

---

#### T.1.C — `DispositionReason` and `AuditStatus` enums; `InvalidEntry` / `AuditEntry` records

- **wave**: T.1
- **files_touched**:
  - NEW: `types/disposition.ts` (~120 LOC) — `DispositionReason`, `AuditStatus`, `InvalidEntry`, `AuditEntry`, `ManifestEntry` (re-exporting the augmented version from PA §10.11).
  - MODIFIED: `types/index.ts` (re-export).
  - NEW: `tests/unit/types/disposition.test.ts` — enum stability snapshot (the spec uses these strings on disk; renaming = migration).
- **depends_on**: T.1.A.
- **parallel_with**: T.1.B, T.1.D.
- **skill_tag**: `types`
- **acceptance**:
  - `DispositionReason` covers exactly the 13 strings in §5.4 (`structural`, `predicate-eval`, `auth-invalid`, `continuity-broken`, `proof-invalid`, `proof-throw`, `oracle-rejected`, `belief-divergence`, `parent-rejected`, `race-lost`, `not-our-state`, `off-record-spend`, `gateway-fetch-failed`).
  - `AuditStatus` covers `audit-not-our-state | audit-off-record-spend | audit-promoted`.
  - `InvalidEntry` carries `tokenId, observedTokenContentHash, reason, observedAt, bundleCid, senderTransportPubkey`.
  - `AuditEntry` carries `tokenId, observedTokenContentHash, auditStatus, reason, recordedAt, bundleCidsObserved, promotedToManifestRef?, audit_promoted_from?`.
  - Snapshot test asserts the on-wire string forms — failing the test forces an ADR.
- **est_loc**: 180.
- **risks**: drift between this enum and per-record schemas in T.3.B and T.5.D — single source of truth in `types/disposition.ts` plus runtime re-validation at storage write time.
- **spec_refs**: §5.4, §8, PA §10.11.

---

#### T.1.D — Encode/decode helpers for `UxfTransferPayload`

- **wave**: T.1
- **files_touched**:
  - NEW: `uxf/transfer-payload.ts` (~200 LOC) — `encodeTransferPayload`, `decodeTransferPayload`, `decodeNostrEventContent`, `extractCarRootCid`, `MAX_INLINE_CAR_BYTES = 16384`, `RELAY_SAFE_CAP_BYTES = 96 * 1024`, `MAX_FETCHED_CAR_BYTES = 32 * 1024 * 1024`.
  - NEW: `tests/unit/uxf/transfer-payload.test.ts` — encode/decode round-trip; truncated CAR rejection; multi-root CAR rejection (delegated to `pkg.verify()` — see T.3.A); root-CID mismatch rejection; legacy shape passthrough.
- **depends_on**: T.1.A.
- **parallel_with**: T.1.B, T.1.C.
- **skill_tag**: `wire`
- **acceptance**:
  - `encodeTransferPayload(args)` produces the JSON shape from §3.1 byte-deterministically.
  - `decodeTransferPayload(string)` returns a typed `UxfTransferPayload` or throws `BUNDLE_REJECTED:malformed-envelope`.
  - `extractCarRootCid(carBytes)` returns the CIDv1 base32 string for a single-root CAR; throws `BUNDLE_REJECTED:multi-root` for multi-root and `BUNDLE_REJECTED:invalid-car` for malformed.
  - `clampInlineCap(userValue): number` clamps to `[1, RELAY_SAFE_CAP_BYTES]` per §3.3.1 and returns the clamp decision (used for telemetry).
  - 100% branch coverage; tests pass.
- **est_loc**: 320.
- **risks**: CIDv1 binary vs base32 byte order for §5.3 [D-conflict] lex-min tie-break — write the comparator as `compareCidV1Binary(a: string, b: string): -1 | 0 | 1` and document; T.3.D consumes it.
- **spec_refs**: §3.1, §3.3.1, §3.3.2.

---

#### T.1.E — `PROFILE_KEY_MAPPING` extension: add `audit`, widen `invalid`, add `finalization_queue`

- **wave**: T.1
- **files_touched**:
  - MODIFIED: `profile/types.ts` (`PROFILE_KEY_MAPPING`) — add `audit: { profileKey: '{addr}.audit', dynamic: true }`, add `finalization_queue: { profileKey: '{addr}.finalizationQueue', dynamic: true }`. Keep `invalidTokens` for legacy migration; add `invalid: { profileKey: '{addr}.invalid', dynamic: true }` for the multi-rep form.
  - MODIFIED: `profile/profile-storage-provider.ts` — extend the dynamic key matcher to recognize the new `{addr}.audit.${tokenId}.${observedTokenContentHash}` and `{addr}.invalid.${tokenId}.${observedTokenContentHash}` prefixes (per-entry-key form, Wave G.7).
  - MODIFIED: `profile/migration.ts` — pass through new keys without dropping them.
  - NEW: `tests/unit/profile/profile-key-mapping.test.ts` — round-trip mapping for new keys (legacy → profile and back).
  - MODIFIED: `tests/unit/profile/profile-storage-provider.test.ts` — extend the per-address scoping cases to cover `audit` and `finalization_queue`.
- **depends_on**: T.1.A, T.1.C.
- **parallel_with**: T.1.B, T.1.D.
- **skill_tag**: `storage`
- **acceptance**:
  - `PROFILE_KEY_MAPPING` exports the three new entries.
  - Migration path from a wallet that has `invalidTokens` (legacy single-record-per-tokenId) to `invalid.${tokenId}.${observedTokenContentHash}` is one-way and is exercised by a fixture wallet (`tests/fixtures/wallets/legacy-invalidTokens-pre-T1E/`).
  - `profile/profile-storage-provider.ts` per-address scoping recognizes the new prefixes and round-trips.
  - The static `audit`, `invalid`, `finalization_queue` keys do NOT appear at runtime (they are schema declarations; the per-entry-key writer expands them, identical pattern to `outbox`).
  - **CRITICAL**: this lands BEFORE any disposition writer (T.3.B onward). Tasks downstream of T.1.E that touch `_audit` MUST list T.1.E in their `depends_on`.
- **est_loc**: 360.
- **risks**: schema migration corner case — a wallet with stale `invalidTokens` (legacy) AND new `invalid.${tokenId}.${cid}` (someone ran T.3.B against an unmigrated wallet). Write the migration to be additive: legacy records become per-entry-key records keyed by a synthetic `observedTokenContentHash = "legacy-" + tokenId`.
- **spec_refs**: §5.4, PA §10.11, INV §11.

---

#### T.1.F — Lamport clock primitive + per-tokenId mutex / CAS helper

- **wave**: T.1
- **files_touched**:
  - NEW: `profile/lamport.ts` (~80 LOC) — `Lamport` class with `bumpFor(observedRemotes: number[]): number` and `merge(a: number, b: number): number`. Used by outbox + manifest writers.
  - NEW: `profile/per-token-mutex.ts` (~120 LOC) — in-process per-tokenId mutex implementing the `bounded-hold` strategy (§5.5 step 9 lock-vs-network-I/O hold rule, default `MAX_LOCK_HOLD_MS = 5000`). Worker-pool-safe.
  - NEW: `profile/manifest-cas.ts` (~140 LOC) — compare-and-swap helper on a manifest entry's content hash. Implements the CAS-based path; T.5 step 9 prefers this.
  - NEW: `tests/unit/profile/lamport.test.ts`, `tests/unit/profile/per-token-mutex.test.ts`, `tests/unit/profile/manifest-cas.test.ts`.
- **depends_on**: none (pure utility).
- **parallel_with**: T.1.A through T.1.E.
- **skill_tag**: `crdt`
- **acceptance**:
  - `Lamport.bumpFor([3,7,2])` from local 5 returns 8 (max + 1).
  - `Lamport.merge(5, 8)` returns 8.
  - `PerTokenMutex.acquire(tokenId, fn, {timeoutMs: 5000})` enforces serialization and aborts at timeout.
  - `ManifestCas.update(addr, tokenId, prev, next)` returns `{ok: false, reason: 'cas-mismatch'}` when prev hash doesn't match.
  - All three primitives are stateless across SDK destroy/recreate (no module-level globals); each `Sphere` instance gets its own.
- **est_loc**: 440.
- **risks**: the `MAX_LOCK_HOLD_MS` default must not race with realistic aggregator latencies under load — make it configurable and document the trade-off; the CAS-based path (T.5 step 9 default) avoids the issue entirely.
- **spec_refs**: §5.5 step 9, §7.1 Lamport invariants.

---

### T.2 — Sender bundle construction (conservative UXF + delivery overrides)

T.2 ships the UXF wire path for **conservative mode only** (no instant-mode complexity yet — the chain has no unfinalized tail when conservative bundles go out). It implements the 16 KiB inline / 96 KiB clamp / `delivery: 'force-cid'` / `delivery: 'force-inline'` overrides. Recipient-side ingest is T.3.

---

#### T.2.A — Source-token preflight: walk pending history and finalize before bundle build

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/preflight-finalize.ts` (~250 LOC) — given `selectedSources: Token[]`, walk every unfinalized predecessor tx and submit-and-await proof for each, in chain order. Reused by conservative path in T.2.D.
  - NEW: `tests/unit/payments/transfer/preflight-finalize.test.ts` — chain depth 0, 1, 3; partial finalization; aggregator transient retries; aggregator hard-rejection cascades to `INSUFFICIENT_BALANCE` reason='source-cascade-failed'.
- **depends_on**: T.1.B, T.1.C.
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

#### T.2.B — Multi-asset target validation (coin + NFT class disjointness)

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/target-validator.ts` (~280 LOC) — implements §4.1 step 1 verbatim: builds `targetList` from `(primary, additionalAssets)`; enforces distinct coinIds, distinct NFT tokenIds, positive amounts, source-class enforcement, NFT-target-source-must-be-NFT, mixed-asset rejection, NFT-pending-without-confirm.
  - NEW: `tests/unit/payments/transfer/target-validator.test.ts` — every error code path (`EMPTY_TRANSFER`, `INVALID_REQUEST`, `INVALID_AMOUNT`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_BALANCE` reason='nft-not-owned', `NFT_PENDING_REQUIRES_CONFIRMATION`, `UNKNOWN_ASSET_KIND`).
- **depends_on**: T.1.B.
- **parallel_with**: T.2.A, T.2.C.
- **skill_tag**: `sender`
- **acceptance**:
  - The class-predicate (`isNft = !token.coins?.length`) is wrapped in a single function `classifyToken(t): 'coin' | 'nft'` and used everywhere.
  - Zero-amount coinData entries are pruned at validation entry (`normalizeCoinData(t)`) per §4.1 paragraph "Implementations MUST prune zero-amount entries".
  - The 14 validation cases in §11.2 ("Validation rejections" bullet list) each have a passing test.
  - The validator is a pure function; no I/O, no mutation.
- **est_loc**: 460.
- **risks**: subtle class-disjointness violations under user-crafted `additionalAssets` (e.g., a coin source that happens to have a `tokenId` matching an NFT target) — exhaustive table-driven test covering every paragraph in §4.1.
- **spec_refs**: §4.1 steps 1–2, §11.2 multi-asset cases.

---

#### T.2.C — `DeliveryStrategy` resolver: 16 KiB / 96 KiB clamp, force-inline, force-cid

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/delivery-resolver.ts` (~160 LOC) — given `(strategy, carBytes)`, returns one of `{kind: 'inline', carBase64: ...} | {kind: 'cid', cid: ..., shouldPin: boolean}` or throws `INLINE_CAR_TOO_LARGE` / `INVALID_INLINE_CAP`.
  - NEW: `tests/unit/payments/transfer/delivery-resolver.test.ts` — auto with default cap; auto with custom cap; auto with cap > 96 KiB (clamps); force-inline within 96 KiB; force-inline above 96 KiB (rejects); force-cid even for tiny bundles.
- **depends_on**: T.1.D.
- **parallel_with**: T.2.A, T.2.B.
- **skill_tag**: `wire`
- **acceptance**:
  - Default `{kind: 'auto'}` resolves to inline iff `carBytes.length <= 16384`.
  - `{kind: 'auto', inlineCapBytes: N}` clamps `N` to `[1, 96 * 1024]` per §3.3.1 hard-upper-bound paragraph.
  - `{kind: 'force-inline'}` throws `INLINE_CAR_TOO_LARGE` for bundles > 96 KiB (the relay-safe ceiling).
  - `{kind: 'force-cid'}` returns `kind: 'cid', shouldPin: true` regardless of size.
  - All branches covered.
- **est_loc**: 280.
- **risks**: NIP-11 dynamic discovery is deferred (§12.2) — leave a `// TODO(T.future-NIP11)` marker and an extension point.
- **spec_refs**: §3.3.1, §3.3.2.

---

#### T.2.D — Conservative-mode UXF send orchestrator (entry point)

- **wave**: T.2
- **files_touched**:
  - NEW: `modules/payments/transfer/conservative-sender.ts` (~520 LOC) — orchestrates: (1) target validation via T.2.B, (2) source selection (existing `spendPlanner`), (3) preflight finalize via T.2.A, (4) build commitments + await proofs (existing aggregator client), (5) `UxfPackage.create()` + `ingestAll()`, (6) `pkg.toCar()`, (7) `extractCarRootCid()` (T.1.D), (8) delivery resolver (T.2.C), (9) IPFS pin if CID, (10) outbox persist (T.6.A — landed via stub returning the legacy entry shape until T.6.A merges, then re-pointed), (11) `transport.sendTokenTransfer(recipientPubkey, payload)`, (12) outbox status `delivered`, (13) emit `transfer:confirmed`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — feature-flag-gated dispatcher: when `UXF_TRANSFER_V1` is on AND `transferMode === 'conservative'`, invoke the new orchestrator; otherwise fall through to the existing path. NO touch to instant or TXF arms in this PR.
  - NEW: `tests/unit/payments/transfer/conservative-sender.test.ts` — 1-token, 5-token, 100-token bundles; CID-only tiny bundle via `force-cid`; force-inline failure path; relay reject auto-fallback to CID.
- **depends_on**: T.1.A, T.1.B, T.1.C, T.1.D, T.2.A, T.2.B, T.2.C; **soft-depends** T.6.A (outbox writer — until T.6.A lands, T.2.D writes a flag-gated sentinel into legacy `_outbox` to keep the existing tests passing).
- **parallel_with**: T.3.A, T.3.B, T.3.C.
- **skill_tag**: `sender`
- **acceptance**:
  - With flag on, conservative-mode sends end-to-end through UXF wire format with byte-identical CAR for a 1-token send to the captured fixture (T.8.A).
  - With flag off, behavior is identical to current main.
  - Bundle-internal token order is deterministic (lex-min `tokenId`) for fixture stability.
  - `transfer:confirmed` event emitted with `tokenTransfers[i].method === 'split' | 'direct'`.
- **est_loc**: 720.
- **risks**: race on `pkg.toCar()` with the IPFS pin (§3.3.2 "the CAR is in fact already pinned by the time we send") — make the pin step idempotent and let the outbox transition naturally per §7.0.
- **spec_refs**: §2.2, §4.1, §4.2.

---

#### T.2.E — Transport-layer send adapter for `UxfTransferPayload`

- **wave**: T.2
- **files_touched**:
  - MODIFIED: `transport/transport-provider.ts` — extend `TokenTransferPayload` to be `LegacyTokenTransferPayload | UxfTransferPayload` (re-exported); the wire layer is shape-agnostic.
  - MODIFIED: `transport/NostrTransportProvider.ts` — `sendTokenTransfer()` now serializes any payload type via JSON; `_handleTokenTransferEvent()` calls `decodeTransferPayload()` from T.1.D and routes appropriately. Preserve current legacy-shape behavior when handler is the legacy adapter.
  - NEW: `tests/unit/transport/NostrTransportProvider.uxf-payload.test.ts` — encodes a UXF-CAR payload, round-trips through `sendTokenTransfer` + `onTokenTransfer` mock pipeline; encodes a UXF-CID payload; encodes a legacy `{sourceToken, transferTx}` payload (regression).
- **depends_on**: T.1.D.
- **parallel_with**: T.2.A, T.2.B, T.2.C, T.2.D.
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

T.3 implements §5.1 (bundle acquisition, including LRU replay defense), §5.2 (bundle-level checks including chain-depth + smuggled-roots caps), §5.3 (the [A]–[F] decision matrix with mandatory ECDSA at [C](1)), §5.4 (multi-rep `_invalid` + new `_audit`). Worker pool from §5.0 lands here too. **No instant-mode handling** — bundles with `mode === 'instant'` are rejected with a typed soft-error to avoid silent token loss in T.2-only deployments.

---

#### T.3.A — Bundle acquisition + verification (CAR-only, CID deferred to T.4)

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/bundle-acquirer.ts` (~280 LOC) — given `UxfTransferPayload`, returns `{pkg: UxfPackage, bundleCid: string}` or throws typed `BUNDLE_REJECTED:*`. Handles `kind: 'uxf-car'` only; emits `BUNDLE_REJECTED:cid-mode-not-yet-supported` for `kind: 'uxf-cid'` (T.4 enables).
  - NEW: `modules/payments/transfer/bundle-verifier.ts` (~340 LOC) — implements §5.2 #1 (`pkg.verify()` wrapper), #2 (token-id claim consistency), #3 (chain-depth cap with two-tier rule), #4 (smuggled-roots count cap with fail-closed type-tag handling).
  - NEW: `modules/payments/transfer/replay-lru.ts` (~80 LOC) — bounded LRU set of bundleCids, default 256, with eviction.
  - NEW: `tests/unit/payments/transfer/bundle-acquirer.test.ts`, `bundle-verifier.test.ts`, `replay-lru.test.ts`.
- **depends_on**: T.1.A, T.1.D.
- **parallel_with**: T.3.B, T.3.C, T.3.D, T.3.E.
- **skill_tag**: `recipient`
- **acceptance**:
  - Multi-root CAR rejected with `BUNDLE_REJECTED:multi-root` (delegated to `pkg.verify()`).
  - Root-CID mismatch rejected with `BUNDLE_REJECTED:root-cid-mismatch`.
  - Chain depth > 64 in claimed tokenIds rejects WHOLE bundle; chain depth > 64 in unclaimed roots SILENTLY DROPS that root (smuggling defense).
  - Unclaimed root count > 16 rejects WHOLE bundle.
  - Unknown type-tag at top level counts toward `MAX_UNCLAIMED_ROOTS` (fail-closed).
  - Replay LRU short-circuits a re-arriving bundleCid as a no-op (idempotent per §5.6).
- **est_loc**: 760.
- **risks**: false-negative on the smuggled-roots cap if `tokenIds` field is empty (sender ships everything as "unclaimed") — explicit test case; documented behavior is "all roots are unclaimed → cap kicks in if > 16".
- **spec_refs**: §5.1, §5.2.

---

#### T.3.B — Disposition matrix [A]/[B]/[C]/[D]/[E]/[F]/[B'] + STRUCTURAL_INVALID throw-paths

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/disposition-engine.ts` (~640 LOC) — pure decision-matrix walker. Inputs: `{tokenRootElement, pool, localPool, identity, oracle, trustBase}`. Output: `DispositionRecord = {kind: 'VALID'|'PENDING'|'CONFLICTING'|'PROOF_INVALID'|'STRUCTURAL_INVALID'|'NOT_OUR_CURRENT_STATE'|'UNSPENDABLE_BY_US', reason?, observedTokenContentHash, ...}`. Throw-paths at every branch route to `STRUCTURAL_INVALID` (no silent fall-through).
  - NEW: `modules/payments/transfer/predicate-evaluator.ts` (~180 LOC) — wraps SDK predicate evaluation with try/catch; returns `{ok: true, bindsToUs: boolean} | {ok: false, threw: true}`.
  - NEW: `modules/payments/transfer/authenticator-verifier.ts` (~140 LOC) — mandatory ECDSA verification of `authenticator.signature` over canonical preimage at [C](1). Throw → STRUCTURAL_INVALID; verify-fails → PROOF_INVALID.
  - NEW: `modules/payments/transfer/proof-verifier.ts` (~200 LOC) — wraps `oracle.verifyInclusionProof()` returning `OK | PATH_INVALID | NOT_AUTHENTICATED | PATH_NOT_INCLUDED | THROWN`. PATH_NOT_INCLUDED at receive maps to PROOF_INVALID per §5.3 [C](3).
  - NEW: `tests/unit/payments/transfer/disposition-engine.test.ts` — at least one test per leaf in §5.3 (per the §11.1 unit-test list); throw-paths.
- **depends_on**: T.1.A, T.1.C, T.3.A.
- **parallel_with**: T.3.C, T.3.D, T.3.E.
- **skill_tag**: `recipient`
- **acceptance**:
  - Every branch listed in Appendix A (rows A through E-unspendable) has at least one passing test.
  - Throw at any branch → STRUCTURAL_INVALID; never silent fall-through.
  - PATH_NOT_INCLUDED at receive (someone shipped a stale proof claiming anchorage) → PROOF_INVALID with `reason='proof-invalid'`.
  - Bundles with `mode === 'instant'` AND any unfinalized tx return a typed soft-error `BUNDLE_REJECTED:instant-mode-not-yet-supported` per the T.3 deferred-handling note.
- **est_loc**: 1320.
- **risks**: subtle proof-verifier wrapper bugs around throw vs. return — exhaustive fault-injection test in `proof-verifier.test.ts`.
- **spec_refs**: §5.3, Appendix A, §11.1.

---

#### T.3.C — `_invalid` + `_audit` storage with multi-rep keys; manifest writes for VALID/PENDING/CONFLICTING

- **wave**: T.3
- **files_touched**:
  - NEW: `profile/disposition-writer.ts` (~380 LOC) — given a `DispositionRecord` and an address, writes to the appropriate OrbitDB collection (`{addr}.invalid.${tokenId}.${observedTokenContentHash}` for invalid; `{addr}.audit.${...}` for audit; `{addr}.manifest.${tokenId}` for active pool). Uses Lamport bumps from T.1.F.
  - NEW: `profile/manifest-store.ts` (~260 LOC) — typed wrapper over manifest reads/writes; preserves the §5.4 metadata-preservation rules (`audit_promoted_from`, `splitParent`, `conflictingHeads[]`, `lamport`) on merge.
  - NEW: `tests/unit/profile/disposition-writer.test.ts` — VALID write to manifest; INVALID write with multi-rep key; AUDIT write with multi-rep key; same tokenId observed in two bundles → two distinct invalid records.
  - NEW: `tests/unit/profile/manifest-store.test.ts` — set-OR merge for `audit_promoted_from`; max-merge for `lamport`; lex-min tie-break on conflicting bundleCids.
- **depends_on**: T.1.C, T.1.E, T.1.F.
- **parallel_with**: T.3.A, T.3.B, T.3.D, T.3.E.
- **skill_tag**: `storage`
- **acceptance**:
  - `_invalid` and `_audit` records key by `${addr}.{invalid|audit}.${tokenId}.${observedTokenContentHash}`.
  - Two distinct bundles for the same tokenId produce two records (idempotent by `observedTokenContentHash`).
  - Manifest merge with conflicting heads picks lex-min `bundleCid` (using `compareCidV1Binary` from T.1.D).
  - Promotion flow (calling `promoteAuditEntry(auditKey, manifestEntry)`) sets `promotedToManifestRef` on the audit record AND `audit_promoted_from: [auditKey]` on the manifest entry; the audit record is NOT deleted.
- **est_loc**: 760.
- **risks**: `audit_promoted_from` widening from `string | undefined` to `string[] | undefined` is a schema change — write a one-shot lifter in T.6.D migration.
- **spec_refs**: §5.4, PA §10.11.

---

#### T.3.D — Conflict / merge engine (§5.3 [D])

- **wave**: T.3
- **files_touched**:
  - NEW: `modules/payments/transfer/conflict-merger.ts` (~340 LOC) — given two manifest entries for the same `tokenId`, decides {`identical-no-op` | `prefix-extension-merge` | `genuinely-divergent-conflict`}. Uses `resolveTokenRoot` (existing Wave G.3 facility) for proof grafting; returns the merged manifest entry plus the `audit_promoted_from` / `splitParent` / `conflictingHeads` deltas.
  - NEW: `tests/unit/payments/transfer/conflict-merger.test.ts` — identical chain (idempotent); strict prefix → graft; strict extension → graft; genuinely divergent → CONFLICTING with lex-min winner; merge with surface-level transfer-out we authored → re-run [B'] → NOT_OUR_CURRENT_STATE.
- **depends_on**: T.1.A, T.1.C, T.1.D, T.1.F (manifest CAS), T.3.B.
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
  - NEW: `modules/payments/transfer/ingest-worker-pool.ts` (~360 LOC) — N=16 default workers, bounded queue=256, per-tokenId mutex coordination via T.1.F. Drops with `INGEST_QUEUE_FULL` when bounded.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — `handleIncomingTransfer()` enqueues onto the worker pool when `UXF_TRANSFER_V1` is on; legacy path unchanged when off.
  - NEW: `tests/unit/payments/transfer/ingest-worker-pool.test.ts` — 100 bundles in flight; one slow bundle does not serialize; queue overflow → `INGEST_QUEUE_FULL`; per-tokenId mutex prevents double-disposition.
- **depends_on**: T.1.F, T.3.A, T.3.B, T.3.C, T.3.D.
- **parallel_with**: none in T.3 (this is the integrator).
- **skill_tag**: `worker`
- **acceptance**:
  - 16 concurrent bundles processed in parallel without per-tokenId data races (verified by deterministic-clock test).
  - Slow bundle (mocked 30s wait) does not block 15 fast bundles.
  - Queue overflow surfaces metric `transfer:ingest-queue-full` (informational).
  - Worker pool destroyed cleanly on `Sphere.destroy()`.
- **est_loc**: 580.
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
- **depends_on**: T.2.D, T.6.A (outbox transitions), T.6.B (retention rules).
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
  - MODIFIED: `modules/payments/transfer/bundle-acquirer.ts` — handle `kind: 'uxf-cid'` by invoking `cid-fetcher`. Emit `transfer:fetch-failed` if all gateways fail.
  - NEW: `tests/unit/payments/transfer/cid-fetcher.test.ts` — happy path (one gateway works); first gateway fails, second succeeds; all fail → `transfer:fetch-failed`; CAR > 32 MiB → `FETCHED_CAR_TOO_LARGE`; root-CID mismatch from gateway → reject.
  - NEW: `tests/integration/transfer/uxf-cid-roundtrip.test.ts` — full sender(force-cid) → recipient(fetch-cid) on a controlled Helia gateway.
- **depends_on**: T.1.D, T.3.A.
- **parallel_with**: T.4.A.
- **skill_tag**: `recipient`
- **acceptance**:
  - Streaming abort at 32 MiB limit (do not buffer the whole CAR before checking size).
  - Gateway list walked in order; first success returns; first failure increments `proofErrorCount`-like counter; total failure emits `transfer:fetch-failed` and does NOT acknowledge to sender.
  - `delivery: 'force-cid'` on a tiny bundle still goes through CID fetch (regression).
- **est_loc**: 560.
- **risks**: hostile gateway returning slightly-different CAR with same root claim — the verified-CAR pipeline's per-block hash check defends; explicit test.
- **spec_refs**: §3.3, §3.3.1, §3.3.2.

---

### T.5 — Instant mode + finalization workers

T.5 is the largest wave. It implements §2.1 instant-mode bundle construction, §5.5 per-token finalization queue, §6.1 sender-side finalization worker, §6.2 recipient-side finalization worker, §6.3 convergence rules including `importInclusionProof()`, the manifest-CID-rewrite + tombstone semantics, and the cascade rule §6.1.1.

---

#### T.5.A — Instant-mode UXF send orchestrator (entry point)

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/instant-sender.ts` (~580 LOC) — like conservative-sender but with `inclusionProof: null` per tx. Submits commitment WITHOUT awaiting; persists `commitmentRequestIds` on the outbox entry (`outstandingRequestIds` set, two-set form per Decision 16); applies unproven tx locally; status `pending`. Triggers sender-side finalization worker.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — feature-flag-gated dispatcher routes `transferMode === 'instant'` to `instant-sender` (was: legacy instant path).
  - NEW: `tests/unit/payments/transfer/instant-sender.test.ts` — single-tx instant; chain-mode (allowPendingTokens=true) with K=3 inherited unfinalized; NFT instant with `confirmNftPending=true`.
- **depends_on**: T.1.A, T.1.B, T.1.C, T.1.D, T.2.B, T.2.C, T.6.A, T.6.B.
- **parallel_with**: T.5.B, T.5.C, T.5.D.
- **skill_tag**: `sender`
- **acceptance**:
  - Outbox entry created with `status='delivered-instant'` after Nostr ack; `outstandingRequestIds` populated with all unfinalized commitment IDs (NEW one + inherited K-1).
  - Local source token marked `pending` until sender-side worker (T.5.B) attaches proofs.
  - `transfer:submitted` (NOT `confirmed`) emitted at this stage.
  - `splitParent: { tokenId, status: 'pending'|'valid' }` set on each child token result.
  - `transfer:cascade-risk-warning` emitted when source is pending and recipient is freshly-minted child.
- **est_loc**: 820.
- **risks**: race between local pool update and Nostr publish — pre-publish persistence ordering (§6.3 last paragraph): outbox commit BEFORE Nostr publish; resumable on restart.
- **spec_refs**: §2.1, §4.3, §6.1, §6.1.1.

---

#### T.5.B — Sender-side finalization worker

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/finalization-worker-sender.ts` (~620 LOC) — implements §6.1 verbatim. Loops over outbox entries with `status='delivered-instant'`; for each `outstandingRequestId`: resolve signedTx, re-verify locally, submit, poll. Backoff schedule 30s, 60s, 120s, 240s, 5min. Honors POLLING_WINDOW (default 30 min) and MIN_POLL_ATTEMPTS (default 5). Per-aggregator concurrency cap.
  - NEW: `modules/payments/transfer/manifest-cid-rewrite.ts` (~180 LOC) — per §5.5 step 5, atomic-ish 4-step write order (pool write proof → manifest CID rewrite → tombstone insert → queue-entry removal LAST). Each step idempotent on replay.
  - NEW: `tests/unit/payments/transfer/finalization-worker-sender.test.ts` — SUCCESS path; REQUEST_ID_EXISTS idempotent; REQUEST_ID_MISMATCH hard-fail; AUTHENTICATOR_VERIFICATION_FAILED hard-fail (`belief-divergence`); transient retries; sustained PATH_NOT_INCLUDED past window → `oracle-rejected`; PATH_INVALID hard-fail; NOT_AUTHENTICATED → trustbase-warning + retry + hard-fail-after-refresh.
- **depends_on**: T.1.A, T.1.C, T.1.F, T.5.A, T.6.A.
- **parallel_with**: T.5.C, T.5.D.
- **skill_tag**: `worker`
- **acceptance**:
  - Configuration validity rule (§5.5 step 6 paragraph "Configuration validity rule (normative)") validated at startup; cumulative backoff for the first MIN_POLL_ATTEMPTS polls ≤ POLLING_WINDOW.
  - Hard safety-net: worker terminates after `2 × POLLING_WINDOW` regardless of MIN_POLL_ATTEMPTS.
  - Transient errors do NOT count toward MIN_POLL_ATTEMPTS.
  - 4-step write order followed; crash-resume produces convergent state on each step.
  - On hard-fail, cascade fires per §6.1.1.
- **est_loc**: 1100.
- **risks**: subtle deadline-vs-attempt-count interaction — every state transition has a directed test; deterministic-clock test harness used throughout.
- **spec_refs**: §6.1, §5.5 step 5–6.

---

#### T.5.C — Recipient-side finalization worker + per-address finalization queue

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/finalization-queue.ts` (~280 LOC) — typed wrapper over OrbitDB-backed per-address queue keyed `${addr}.finalizationQueue.${entryId}` (per Wave G.7 layout). Add/remove/list/lookupByTokenId.
  - NEW: `modules/payments/transfer/finalization-worker-recipient.ts` (~580 LOC) — same logic as T.5.B but driven by the per-address finalization queue rather than the outbox. Implements §5.5 steps 1–9 including the queue-drain status transition with re-run [B]/[D]/[E] under per-tokenId lock (CAS-based path preferred).
  - NEW: `tests/unit/payments/transfer/finalization-queue.test.ts`, `finalization-worker-recipient.test.ts` — single-tx PENDING; chain-mode K=3; queue-drain re-runs [B]/[D]/[E]; concurrent ingest while queue is draining; merge-path (§5.5 last paragraph) with grafted proofs.
- **depends_on**: T.1.A, T.1.C, T.1.E (`finalization_queue` key), T.1.F, T.3.B, T.3.C, T.3.D, T.5.B (`manifest-cid-rewrite`).
- **parallel_with**: T.5.D.
- **skill_tag**: `worker`
- **acceptance**:
  - K queue entries per K-deep chain-mode token; transition `pending → valid` only after all K resolve successfully.
  - Queue drain re-runs [B]/[D]/[E] under CAS per §5.5 step 9 lock-vs-RPC release rule.
  - Tombstone retention 30 days post-canonical-stable; GC test.
  - Merge-path: arriving more-finalized copy grafts proofs in, removes corresponding queue entries WITHOUT aggregator round-trip.
- **est_loc**: 1140.
- **risks**: locking semantics under concurrent ingest + finalization on same tokenId — exhaustive state-machine test with deterministic interleavings.
- **spec_refs**: §5.5, §6.2.

---

#### T.5.D — Cascade rule §6.1.1 + `revalidateCascadedChildren` + `payments.importInclusionProof`

- **wave**: T.5
- **files_touched**:
  - NEW: `modules/payments/transfer/cascade.ts` (~340 LOC) — `cascadeOnHardFail(parentTokenId, reason)`: walks `splitParent` references, marks children invalid with `parent-rejected`, applies parent-flip protection (re-read parent inside CAS payload), bounded depth (MAX_CHAIN_DEPTH=64), cycle defense.
  - NEW: `modules/payments/transfer/revalidate-cascaded.ts` (~220 LOC) — `revalidateCascadedChildren(parentTokenId): RevalidationResult`. Transitive by default; bounded depth; cycle visited-set.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — expose `revalidateCascadedChildren` and `importInclusionProof` on the public API.
  - NEW: `modules/payments/transfer/import-inclusion-proof.ts` (~280 LOC) — implements §6.3 `importInclusionProof(tokenId, proofBytes, options)` with 9 behavior cases.
  - NEW: `tests/unit/payments/transfer/cascade.test.ts`, `revalidate-cascaded.test.ts`, `import-inclusion-proof.test.ts`.
- **depends_on**: T.1.A, T.1.C, T.1.F, T.5.B, T.5.C.
- **parallel_with**: none — sits at the bottom of T.5.
- **skill_tag**: `recipient`
- **acceptance**:
  - All 9 behavior cases of §6.3 `importInclusionProof()` covered by tests, including the K-1 re-queue branch (case 6).
  - `allowInvalidOverride: false` is the default; explicit `true` required to flip out of `_invalid`.
  - Sticky `overrideApplied: true` on outbox entry persists across CRDT merges (T.6.B).
  - Cascade is bounded; cycle test with corrupted `splitParent` does not infinite-loop.
- **est_loc**: 1180.
- **risks**: edge cases in case 6 (K-1 re-queue with fresh `submittedAt`) — tested with deterministic clock.
- **spec_refs**: §6.1.1, §6.3.

---

#### T.5.E — `transfer:trustbase-warning` + `transfer:security-alert` + `transfer:cascade-risk-warning` + `transfer:cascade-failed` events

- **wave**: T.5
- **files_touched**:
  - MODIFIED: `types/index.ts` — extend `SphereEventType` and `SphereEventMap` with the four new events.
  - MODIFIED: appropriate workers (T.5.B sender; T.5.C recipient) to emit the events at the spec'd paths.
  - NEW: `tests/unit/types/sphere-events-uxf.test.ts` — type-level test that the new events are typed.
  - NEW: `tests/integration/transfer/trustbase-warning.test.ts` — simulate stale trustBase NOT_AUTHENTICATED → trustbase-warning emitted, refresh attempted, retry succeeds.
  - NEW: `tests/integration/transfer/security-alert.test.ts` — sustained NOT_AUTHENTICATED after refresh in conservative mode → security-alert.
- **depends_on**: T.5.B, T.5.C.
- **parallel_with**: T.5.D.
- **skill_tag**: `worker`
- **acceptance**:
  - Event payloads exactly match spec (§9.4, §6.3 forbidden-path, §6.1.1 cascade-risk-warning).
  - `transfer:security-alert` is reserved for the explicit out-of-scope cases per §9.4.1; trustbase-warning is the routine case.
- **est_loc**: 280.
- **risks**: false-positive security-alert from a benign trustBase refresh race — make the alert fire only AFTER the refresh path is exhausted.
- **spec_refs**: §6.3, §9.4, §9.4.1.

---

### T.6 — Outbox refactor

T.6 ships the bundle-grained `UxfTransferOutboxEntry`, the §7.0 status-transition table, the §7.1 CRDT merge invariants, and the §7.2 legacy migration. T.6 is **structurally** independent of T.2/T.3/T.5, so T.6.A and T.6.B can land in parallel with sender/recipient work — but those waves transitively depend on T.6.A landing the outbox writer.

---

#### T.6.A — `UxfTransferOutboxEntry` schema + per-entry-key writer

- **wave**: T.6
- **files_touched**:
  - NEW: `types/uxf-outbox.ts` (~140 LOC) — `UxfTransferOutboxEntry` per §7.
  - NEW: `profile/outbox-writer.ts` (~340 LOC) — typed wrapper writing to `${addr}.outbox.${id}` (per-entry-key, Wave G.7). Bumps Lamport on every write per §7.1.
  - MODIFIED: `profile/profile-token-storage-provider.ts` — extend the per-entry-key reader to recognize the new entry shape (legacy entries continue to read via the existing decoder; new entries use the new decoder; selection by entry-shape sniffing).
  - NEW: `tests/unit/profile/outbox-writer.test.ts` — write/read round-trip; Lamport bump on update; per-entry-key isolation (writes don't trample siblings).
- **depends_on**: T.1.A, T.1.B, T.1.F.
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

#### T.6.B — CRDT merger: status partition + override stickiness + two-set requestIds

- **wave**: T.6
- **files_touched**:
  - NEW: `profile/outbox-merger.ts` (~440 LOC) — implements §7.1 verbatim. `mergeOutboxEntries(a, b): UxfTransferOutboxEntry`. Status partition (active / soft-terminal / hard-terminal); override-stickiness exception (`overrideApplied: true` → active wins); two-set requestId merge `outstanding := union - completed`; lattice-based active-state lex (`packaging < pinned < sending < {delivered, delivered-instant} < finalizing`); error-field rule (more-advanced status wins; tie by earlier-Lamport).
  - NEW: `tests/unit/profile/outbox-merger.test.ts` — 30+ targeted tests covering each row of §7.1.
- **depends_on**: T.6.A.
- **parallel_with**: T.6.C, T.6.D.
- **skill_tag**: `crdt`
- **acceptance**:
  - All §7.1 conflict rules (1–6) covered.
  - `failed-permanent` vs `finalizing` with `overrideApplied: true` → `finalizing` wins regardless of Lamport.
  - `outstanding := union(A_outstanding, B_outstanding) - union(A_completed, B_completed)` (NOT plain set-union; verified by an adversarial test with stale replica re-introducing a completed requestId).
  - Two-replica race: same source state → REQUEST_ID_MISMATCH on second submit → loser's outbox entry transitions to `failed-permanent` reason='race-lost'; cascade does NOT fire for race-lost.
- **est_loc**: 760.
- **risks**: Lamport tie-break correctness across replica restarts — driven by T.1.F primitives.
- **spec_refs**: §7.1.

---

#### T.6.C — Status-transition validator + state machine guards

- **wave**: T.6
- **files_touched**:
  - NEW: `profile/outbox-state-machine.ts` (~220 LOC) — validates every `status` transition against the §7.0 table; throws `INVALID_OUTBOX_TRANSITION` on disallowed moves. Used by `outbox-writer` (T.6.A) on every update.
  - NEW: `tests/unit/profile/outbox-state-machine.test.ts` — every legal transition (and a sample of illegal ones) tested.
- **depends_on**: T.6.A.
- **parallel_with**: T.6.B, T.6.D.
- **skill_tag**: `outbox`
- **acceptance**:
  - Disallowed transitions (e.g., `delivered → packaging`) throw with a typed error.
  - The override path `failed-permanent → finalizing` is allowed only when the writer sets `overrideApplied: true` in the same write.
  - The terminal states (`expired`, `finalized`, `failed-permanent` modulo override) are enforced.
- **est_loc**: 360.
- **risks**: spec drift between §7.0 table and this validator — table is the single source of truth; auto-generate validator from a typed transition table.
- **spec_refs**: §7.0.

---

#### T.6.D — Legacy outbox → bundle-grained migration (§7.2)

- **wave**: T.6
- **files_touched**:
  - NEW: `profile/migration-outbox.ts` (~360 LOC) — implements §7.2 verbatim. Group legacy entries by `(recipientPubkey, createdAt-window=60s)`; synthesize one `UxfTransferOutboxEntry` per group; `mode: 'txf'`; preserve `recipientNametag` (extend schema: add `recipientNametag?: string` field on `UxfTransferOutboxEntry`); status mapping (legacy `delivered|confirmed → 'finalized'`; `pending → 'sending'`; `failed → 'failed-permanent'`); one-way migration; legacy collection cleared after.
  - MODIFIED: `types/uxf-outbox.ts` — add `recipientNametag?: string` field to preserve §7.2 paragraph 4.
  - NEW: `tests/unit/profile/migration-outbox.test.ts` — single-token legacy entry → synthetic bundle with `bundleCid='txf-' + tokenId`; multi-token legacy group → synthetic combined bundle with `bundleCid='legacy-' + recipientPubkey + '-' + createdAt`; nametag preservation; one-way (re-running migration is a no-op).
  - NEW: `tests/fixtures/wallets/legacy-outbox-pre-T6D/` — fixture wallet with mixed legacy entries.
- **depends_on**: T.6.A.
- **parallel_with**: T.6.B, T.6.C.
- **skill_tag**: `migration`
- **acceptance**:
  - Legacy fixture migrates cleanly; resulting bundle-grained outbox passes T.6.C state-machine validation.
  - `recipientNametag` preserved in all paths (the §7.2 paragraph 4 extension).
  - One-way: a second run of migration on an already-migrated wallet is a no-op (no double-migration).
  - Migration runs under the `UXF_TRANSFER_V1` flag; legacy wallets without the flag don't trigger migration.
- **est_loc**: 580.
- **risks**: edge case: legacy entry with no `recipientNametag` AND failing-state — ensure synthetic entry's `recipient` is the pubkey form (preserves UI display continuity).
- **spec_refs**: §7.2, §10.3.

---

#### T.6.E — Pre-publish persistence ordering + crash-recovery test harness

- **wave**: T.6
- **files_touched**:
  - MODIFIED: `modules/payments/transfer/conservative-sender.ts`, `instant-sender.ts` — strict ordering: outbox commit (`status='sending'` or `'delivered-instant'`) BEFORE Nostr publish dispatch.
  - NEW: `tests/integration/transfer/crash-recovery.test.ts` — fault-inject between outbox commit and Nostr publish; restart Sphere; verify outbox shows `sending` on restart and re-publish is idempotent (same bundleCid).
- **depends_on**: T.6.A, T.6.C, T.2.D, T.5.A.
- **parallel_with**: none — integration check at end of T.6.
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

---

#### T.7.A — TXF sender for `transferMode: 'txf'` (both finalization variants)

- **wave**: T.7
- **files_touched**:
  - NEW: `modules/payments/transfer/txf-sender.ts` (~440 LOC) — implements §4.4.1 (conservative TXF) and §4.4.2 (instant TXF). Per-token Nostr events; outbox uses synthetic `bundleCid='txf-' + tokenId` and `deliveryMethod='txf-legacy'`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — replace the T.1.B `UNSUPPORTED_TRANSFER_MODE` placeholder; route `transferMode === 'txf'` to `txf-sender` based on `txfFinalization`.
  - NEW: `tests/unit/payments/transfer/txf-sender.test.ts` — conservative TXF (1, 5, 100 tokens); instant TXF (1, 5, 100 tokens); per-token outbox entries; mode tag preserved.
- **depends_on**: T.1.B, T.5.B (for instant-TXF finalization), T.6.A, T.6.C.
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
  - NEW: `modules/payments/transfer/legacy-shape-adapter.ts` (~480 LOC) — given `LegacyTokenTransferPayload` (one of the 4 shapes from §3.4), produces N synthetic single-token disposition passes through T.3.B's disposition engine. Bundle-level checks (§5.2) skipped (no CAR / no bundleCid). Inbound shapes with `inclusionProof: null` recognized as instant-TXF and routed through the chain-mode finalization queue (T.5.C).
  - MODIFIED: `modules/payments/PaymentsModule.ts` — `handleIncomingTransfer()` routing: `kind: 'uxf-car' | 'uxf-cid'` → bundle-acquirer (T.3.A); legacy shape → `legacy-shape-adapter`. The two paths reach the same downstream disposition writer (T.3.C).
  - NEW: `tests/unit/payments/transfer/legacy-shape-adapter.test.ts` — `{sourceToken, transferTx}` → 1 disposition; `COMBINED_TRANSFER` with N tokens → N dispositions; `INSTANT_SPLIT` with N split outputs → N dispositions; `{token, proof}` SDK legacy → 1 disposition; instant-TXF (inclusionProof:null) → routed through finalization queue.
- **depends_on**: T.3.B, T.3.C, T.5.C.
- **parallel_with**: T.7.A, T.7.C.
- **skill_tag**: `recipient`
- **acceptance**:
  - All 4 legacy shapes produce the same set of outcomes (VALID/PENDING/PROOF_INVALID/STRUCTURAL_INVALID/NOT_OUR_CURRENT_STATE/UNSPENDABLE_BY_US/CONFLICTING) as the equivalent UXF bundle would.
  - Per-token granularity: one legacy event → ONE OR MORE disposition records.
  - Instant-TXF arrivals merge into the OrbitDB profile with the same finalization-queue semantics as instant-UXF.
- **est_loc**: 820.
- **risks**: V5 INSTANT_SPLIT vs V6 COMBINED_TRANSFER detection ambiguity — the detector from T.1.A runs in `bundle-acquirer.ts`; the adapter only sees a typed shape after detection.
- **spec_refs**: §10.2, §3.4.

---

#### T.7.C — Production call-site migration: AccountingModule, SwapModule, CLI

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `modules/accounting/AccountingModule.ts` — six call sites (`AccountingModule.ts:2465, 2710, 3655, 3819, 4134, 5812`). Each now passes `transferMode` explicitly; default behavior (`transferMode: 'instant'`) is the new default.
  - MODIFIED: `modules/swap/SwapModule.ts` — find any `payments.send()` call sites and update similarly (deposit / payout flows).
  - MODIFIED: `cli/index.ts:2812` — replace the `forceConservative ? 'conservative' : 'instant'` ternary with explicit `transferMode` selection; ensure `--mode txf` is wired if the CLI exposes it.
  - NEW: `tests/integration/accounting/uxf-transfer.test.ts` — invoice payment goes through new UXF path; verify byte-identical bundle to expected fixture.
  - NEW: `tests/integration/swap/uxf-transfer.test.ts` — swap deposit goes through new UXF path; payout verification still works.
- **depends_on**: T.1.B, T.7.A.
- **parallel_with**: T.7.A, T.7.B (different files).
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - All 6 AccountingModule sites migrated.
  - All SwapModule sites migrated.
  - CLI defaults preserved (no UX regression for the `transfer` and `pay` commands).
  - Byte-identical bundle assertion on the regression fixture (T.8.A).
- **est_loc**: 380.
- **risks**: a hidden call site in `cli/` or `tests/e2e/` — run `git grep -n 'payments\.send'` and triage every result.
- **spec_refs**: §10.1.

---

#### T.7.D — Forced-conservative paths: silent coercion of `allowPendingTokens` to `false`

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `modules/swap/SwapModule.ts` — escrow deposits and similar bridges that require finalized state must coerce `allowPendingTokens` to `false` per §2.5 last paragraph.
  - NEW: `tests/unit/swap/forced-conservative-coercion.test.ts`.
- **depends_on**: T.7.C.
- **parallel_with**: T.7.B.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - Swap deposits with caller-supplied `allowPendingTokens: true` are silently coerced to `false`; the call result surfaces the coercion via a structured field `{ overrides: ['allowPendingTokens-coerced-to-false'] }`.
- **est_loc**: 180.
- **risks**: caller silently observes different behavior — surface the coercion in `TransferResult` as documented.
- **spec_refs**: §2.5.

---

#### T.7.E — Default-mode flip: `transferMode` defaults to `'instant'` over UXF

- **wave**: T.7
- **files_touched**:
  - MODIFIED: `modules/payments/PaymentsModule.ts` — when `request.transferMode` is undefined, default to `'instant'`. Pre-flag the previous default (`'instant'` over legacy TXF) is replaced by `'instant'` over UXF.
  - MODIFIED: `tests/` — any existing tests that snapshotted the legacy-default behavior get migrated.
- **depends_on**: T.5.A, T.7.A, T.7.B, T.7.C.
- **parallel_with**: none.
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

---

#### T.8.A — Backward-compat regression fixture (single-coin v1.0)

- **wave**: T.8 (but lands EARLY — see Parallelization Map §3)
- **files_touched**:
  - NEW: `tests/fixtures/uxf-v1-single-coin/` — generated from a tagged commit (`v0.7.0-rc-uxf-fixture`) with deterministic salt, deterministic timestamp, recorded mnemonic.
  - NEW: `tests/regression/uxf-v1-single-coin.test.ts` — assert byte-identical bundle from a single-coin call against the fixture.
- **depends_on**: T.2.D (for fixture generation; the fixture is generated AFTER T.2 lands but the slot is reserved upfront).
- **parallel_with**: T.8.B, T.8.C, T.8.D, T.8.E.
- **skill_tag**: `tests`
- **acceptance**:
  - Fixture committed; test passes; regenerating it requires bumping a marker and an ADR.
  - Byte-identical assertion gated on the fixture's existence (so the test fails loudly if the fixture is moved).
- **est_loc**: 220.
- **risks**: fixture flakiness from non-deterministic CBOR field order — pin to deterministic CBOR encoder; CI reproducibility check.
- **spec_refs**: §11.2 backward-compat bullet.

---

#### T.8.B — Capability hint surfacing: `wireProtocols` + UI warnings

- **wave**: T.8
- **files_touched**:
  - MODIFIED: `transport/NostrTransportProvider.ts` — identity binding event includes `wireProtocols: ['uxf-car', 'uxf-cid', 'txf']` and `assetKinds: ['coin', 'nft']` (informational, per §10.4).
  - MODIFIED: `core/Sphere.ts` — `sphere.resolve(identifier)` returns the capability hints in `PeerInfo`.
  - MODIFIED: `modules/payments/PaymentsModule.ts` — sender consults `peerInfo.wireProtocols` BEFORE send and emits `transfer:capability-warning` if mismatched. NEVER auto-coerces.
  - NEW: `tests/unit/transport/capability-hint.test.ts`, `tests/unit/payments/capability-warning.test.ts`.
- **depends_on**: T.7.A.
- **parallel_with**: T.8.A, T.8.C, T.8.D, T.8.E.
- **skill_tag**: `transport`
- **acceptance**:
  - Identity binding event encodes the two new fields.
  - `assetKinds: ['coin']` (older peer) + sender ships an NFT entry → emit `transfer:capability-warning`; do NOT auto-strip.
  - Receiver's `UNKNOWN_ASSET_KIND` reject rule (T.2.B) is the actual interop guarantee; the hint is informational.
- **est_loc**: 320.
- **risks**: false-positive warning for older peers that simply omit the hints — treat absent `assetKinds` as `['coin']` per §10.4.
- **spec_refs**: §10.4.

---

#### T.8.C — Error surfacing: `INLINE_CAR_TOO_LARGE`, `FETCHED_CAR_TOO_LARGE`, `UNKNOWN_ASSET_KIND`, `INGEST_QUEUE_FULL`

- **wave**: T.8
- **files_touched**:
  - MODIFIED: `core/errors.ts` — extend `SphereErrorCode` with the 4 new codes (already partially landed in T.2.B/T.4.B; this task is the audit + completion).
  - NEW: `tests/unit/payments/transfer/error-surface.test.ts` — every new error code surfaces through the SphereError path with documented metadata.
- **depends_on**: T.2.C, T.2.B, T.4.B, T.3.E.
- **parallel_with**: T.8.A, T.8.B, T.8.D, T.8.E.
- **skill_tag**: `tests`
- **acceptance**:
  - All 4 codes are typed in `SphereErrorCode`.
  - Each error path tested.
- **est_loc**: 200.
- **risks**: stragglers — run `grep -rn "throw new" modules/payments/transfer/` and verify every throw uses `SphereError`.
- **spec_refs**: §3.3.1, §3.3.2, §10.4, §5.0.

---

#### T.8.D — Production cutover: remove legacy single-coin TXF path; `UXF_TRANSFER_V1` becomes vestigial

- **wave**: T.8
- **files_touched**:
  - MODIFIED: `modules/payments/PaymentsModule.ts` — remove the legacy single-coin code paths. The flag-gated dispatcher becomes unconditional (gated only on the `transferMode` value).
  - MODIFIED: `cli/index.ts`, `modules/accounting/AccountingModule.ts`, `modules/swap/SwapModule.ts` — final pass to remove legacy fall-through code.
  - NEW: `docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md` — operator guide for cutover, including back-out procedure (revert this PR).
- **depends_on**: T.7.C, T.7.E (default flip), T.8.A (regression assertion still passing).
- **parallel_with**: T.8.B, T.8.C, T.8.E.
- **skill_tag**: `cli-cleanup`
- **acceptance**:
  - Legacy code paths removed; `git grep -n 'transferMode === '\''conservative'\''' modules/payments/PaymentsModule.ts` returns only the new dispatcher's branch.
  - All tests still pass.
  - Back-out tested (revert PR; CI green).
- **est_loc**: 380.
- **risks**: hidden code path that depended on legacy behavior — exhaustive smoke test before cutover.
- **spec_refs**: §10.1, §10.2.

---

#### T.8.E — Integration / compatibility / adversarial test suites

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
  - NEW: `tests/adversarial/transfer/forged-authenticator.test.ts`, `multi-root-car.test.ts`, `chain-depth-cap.test.ts`, `unclaimed-roots-cap.test.ts`, `forged-nametag.test.ts`, `replay-bundleCid.test.ts`, `instant-mode-concurrent-split.test.ts`, `forwarder-dies-midchain.test.ts`, `bandwidth-burning-peer.test.ts`, `faulty-aggregator.test.ts`, `aggregator-hard-rejection.test.ts`, `sustained-path-not-included.test.ts`, `orbitdb-crdt-replica-merge.test.ts`, `stuck-pending-escape.test.ts`.
  - NEW: `tests/compatibility/transfer/txf-sender-uxf-recipient.test.ts`, `uxf-sender-txf-only-recipient.test.ts`, `outbox-migration.test.ts`, `capability-hint-warning.test.ts`.
- **depends_on**: T.2.D, T.3.E, T.4.A, T.4.B, T.5.A, T.5.B, T.5.C, T.5.D, T.5.E, T.6.A, T.6.B, T.6.D, T.7.A, T.7.B.
- **parallel_with**: T.8.B, T.8.C, T.8.D.
- **skill_tag**: `tests`
- **acceptance**:
  - All §11.2, §11.3, §11.4 scenarios from the canonical spec have passing tests.
  - Test suite runs in < 8 minutes on CI; flake rate < 0.5%.
- **est_loc**: 2400 (across ~30 test files).
- **risks**: flakiness on real-network paths — use the existing testcontainers-backed Helia and a deterministic-clock harness throughout.
- **spec_refs**: §11.2, §11.3, §11.4.

---

### Out-of-scope for T.1–T.8 (deferred)

Per canonical §12.3, periodic rescans (profile-pointer + per-token spent-state) are deferred. T.1–T.8 wire up the storage, events, and audit-promotion plumbing so future-wave rescan code can drop in cleanly — but no rescan loop ships in this implementation plan. Coordination point only.

---

## §3 Parallelization map

### Lanes

The work decomposes into 6 parallel lanes after T.1 lands. Each lane can be staffed by one senior agent.

| Lane | Tasks | Skill mix | Critical-path? |
|---|---|---|---|
| **Foundations** | T.1.A → T.1.B → T.1.C → T.1.D → T.1.E → T.1.F | types + storage + crdt | YES — gates everything |
| **Sender** | T.2.A, T.2.B, T.2.C → T.2.D, T.2.E → T.4.A → T.5.A → T.7.A → T.7.D, T.7.E → T.8.D | sender + wire | secondary critical |
| **Recipient** | T.3.A, T.3.B, T.3.C, T.3.D → T.3.E → T.4.B → T.7.B | recipient + worker | secondary critical |
| **Outbox / CRDT** | T.6.A → T.6.B, T.6.C, T.6.D → T.6.E | outbox + crdt + migration | gating for T.5 |
| **Workers** | T.5.B, T.5.C → T.5.D → T.5.E | worker + recipient | gating for T.7.A |
| **Tests / Fixtures / Cutover** | T.8.A → T.8.B, T.8.C → T.8.E → cutover | tests | follows everything |

### Critical path (longest serial chain)

```
T.1.A (types)                              [day 1-2]
  ↓
T.1.B + T.1.C + T.1.D + T.1.E + T.1.F      [day 1-2 in parallel]
  ↓
T.6.A (outbox writer)                      [day 3-4]
  ↓
T.6.B (CRDT merger)                        [day 5-6]
  ↓
T.5.A (instant sender) + T.5.B (sender worker) [day 6-9 in parallel]
  ↓
T.5.C (recipient worker)                   [day 8-10]
  ↓
T.5.D (cascade + importInclusionProof)     [day 10-11]
  ↓
T.7.A (TXF sender) + T.7.B (legacy adapter) [day 11-13 in parallel]
  ↓
T.7.C + T.7.D + T.7.E (production migration + default flip) [day 13-14]
  ↓
T.8.D (cutover) + T.8.E (integration tests)  [day 14-16]
```

Roughly 10 PR-sized merges deep on the critical path; with parallel lanes, total wall-clock is **~3 weeks for 4 senior agents**, **~5 weeks for 2 senior agents**.

### Concurrency opportunities

- **Day 1–2**: 5 agents on T.1.A/B/C/D/E/F in parallel (T.1.A is briefly blocking; others run after a few hours).
- **Day 3–6**: 4 agents on T.2.A/B/C, T.3.A/B/C/D, T.6.A/B/C, T.8.A. (Sender and recipient lanes are fully independent.)
- **Day 6–9**: 3 agents on T.5.A/B, T.4.A/B, T.7.A.
- **Day 9–14**: 4 agents on T.5.C/D/E, T.6.D/E, T.7.B/C/D/E, T.8.B/C.
- **Day 14–16**: 2 agents on T.8.D, T.8.E.

### Bottlenecks (where parallelism cannot help)

- **T.1.E `PROFILE_KEY_MAPPING` extension** is a single-file change with ~10 downstream tasks. Has to be perfect on first land.
- **T.6.A outbox writer** is the hub for T.5.A, T.5.B, T.5.C, T.7.A. One bug propagates everywhere.
- **T.5.C recipient worker** integrates T.3.B (disposition), T.3.C (storage), T.3.D (merger), T.5.B (manifest CID rewrite). Best done by one agent who has read all four.
- **T.8.D cutover** touches every entry point. Best done by the same agent who did T.7.E (default flip).

### Anti-patterns to avoid

- **Don't claim T.5.A and T.5.B are parallel without coordinating** — they share the outbox entry shape and need the same Lamport-bump rules.
- **Don't claim T.3.B and T.3.D are parallel with the same agent** — the disposition engine and conflict merger share invariants; one agent reading both is faster than two agents arguing about the boundary.
- **Don't try to parallelize T.6.B (CRDT merger) with the consumer that uses it (T.5.B/C/D)** — they share semantic invariants.

---

## §4 Cross-cutting sequencing rules

These are normative ordering constraints that any task DAG MUST respect:

1. **Types land before consumers**: T.1.A (UxfTransferPayload), T.1.B (TransferRequest widening), T.1.C (DispositionReason / AuditStatus) MUST land before any task that imports those types from `types/uxf-transfer.ts`. The `tsc --noEmit` gate enforces this.
2. **`PROFILE_KEY_MAPPING` extension before any disposition writer**: T.1.E MUST land before T.3.C (`disposition-writer`), T.3.E (worker pool that calls disposition writer), and T.5.D (`importInclusionProof` writes to `_invalid`).
3. **OrbitDB schema additions before workers consume them**: T.6.A (UxfTransferOutboxEntry per-entry-key writer) MUST land before T.5.B and T.5.C (which read/write outbox entries).
4. **Lamport-clock primitive before any CRDT writer**: T.1.F MUST land before T.3.C, T.6.A, T.6.B.
5. **Legacy adapter (T.7.B) cannot land before T.3.B disposition engine**: the adapter routes legacy shapes through the engine — it has no engine to call without T.3.B.
6. **CID-pin path (T.4) cannot land before conservative-sender skeleton (T.2.D)**: T.4.A extends T.2.D; T.4.B extends T.3.A.
7. **Cascade cannot land before manifest-CID-rewrite**: T.5.D depends on T.5.B's `manifest-cid-rewrite.ts` for the parent's invalidation pathway.
8. **Default flip (T.7.E) and cutover (T.8.D) MUST be sequenced last**: removing the legacy path before the new path is fully tested risks production breakage.
9. **Token-id invariance is the bedrock**: any task that handles proofs (T.5.B, T.5.C, T.5.D, T.6.B) MUST preserve the §2.1 audit — `token.id` is immutable across proof attachment; CIDs change. Reviewers MUST check this invariant on every touch.
10. **Bundle-grained outbox for UXF, per-token for TXF (per §7.2)**: the same entry shape but the `mode` field discriminates. T.6.A defines the schema; T.7.A consumes the per-token form; T.7.C migration emits both.
11. **Migration is one-way**: T.6.D (legacy outbox migration) is one-way; T.1.E (PROFILE_KEY_MAPPING) is additive (legacy `invalidTokens` continues to exist for the migration window). T.8.D removes the legacy entirely.

---

## §5 Test strategy per wave

Each wave's test gate blocks the next wave's PR merges.

| Wave | Test gate | Blocks |
|---|---|---|
| **T.1** | T.1.A unit (encode/decode); T.1.D unit (CAR root extraction + CID lex compare); T.1.E migration round-trip; T.1.F Lamport + mutex + CAS unit. | T.2, T.3, T.6 (which import the types). |
| **T.2** | T.2.A unit (preflight finalize); T.2.B unit (target validation, all 14 error paths); T.2.C unit (delivery resolver); T.2.D unit (orchestrator with mocked deps); T.2.E transport adapter unit. **No integration tests yet** — T.3 not landed. | T.4 (CID extension), T.5 (instant variant). |
| **T.3** | T.3.A unit (bundle acquirer + verifier); T.3.B unit (every branch of §5.3 decision matrix per §11.1); T.3.C unit (multi-rep storage); T.3.D unit (merge + lex-min); T.3.E worker pool unit; **first integration**: `tests/integration/transfer/conservative-end-to-end.test.ts` (1 token only — full suite at T.8). | T.4 (CID recipient path), T.5.C (chain-mode merger reuse), T.7.B (legacy adapter that uses the engine). |
| **T.4** | T.4.A unit (sender CID); T.4.B unit (32 MiB cap + verified-CAR); first integration: `tests/integration/transfer/uxf-cid-roundtrip.test.ts`. | T.5 (instant + CID path), T.7.A (TXF sender doesn't use CID, but the path must work for forwarders). |
| **T.5** | T.5.A unit (instant sender); T.5.B unit (every error path of §6.1); T.5.C unit (per-address queue + drain); T.5.D unit (cascade + importInclusionProof, all 9 cases); T.5.E unit (events). **Integration**: 3-hop chain-mode test, merge-path test. | T.7 (TXF instant variant uses the worker), T.8.E (full adversarial suite). |
| **T.6** | T.6.A unit (per-entry-key writer); T.6.B unit (every CRDT row of §7.1); T.6.C unit (every transition of §7.0); T.6.D unit (legacy migration); T.6.E integration (crash recovery). | T.5 (which writes outbox), T.8.D (cutover). |
| **T.7** | T.7.A unit (TXF sender both variants); T.7.B unit (4 legacy shapes); T.7.C integration (production call-site migration). | T.8.D (cutover). |
| **T.8** | T.8.A regression fixture; T.8.B capability hint; T.8.C error surface; T.8.E full integration + compatibility + adversarial suite. T.8.D cutover gated on full suite passing. | None (last wave). |

### Cross-wave gating tests

A handful of tests live across wave boundaries because they exercise multi-wave invariants:

- **`tests/integration/transfer/byte-identical-bundle-fixture.test.ts`** (T.8.A) — gates T.7.E and T.8.D. Any change to the encoder downstream that breaks the fixture forces an explicit ADR + fixture regen.
- **`tests/integration/transfer/orbitdb-crdt-replica-merge.test.ts`** (T.6.B + T.8.E) — gates T.6.B (must pass before T.6.B merges) AND T.5.B/C (must pass with the workers driving real merges).
- **`tests/integration/transfer/chain-mode-3-hop.test.ts`** — gates T.5.C and T.5.D. Three-hop chain is the canonical chain-mode regression case.
- **`tests/integration/transfer/stuck-pending-escape.test.ts`** — gates T.5.D `importInclusionProof` (all 9 cases).
- **`tests/adversarial/transfer/bandwidth-burning-peer.test.ts`** — gates T.5.B + T.5.C cascade short-circuit.

---

## §6 Migration plan

### §6.A Legacy `OutboxEntry` → `UxfTransferOutboxEntry`

Implemented in **T.6.D** per canonical §7.2. Highlights:

- Trigger: first read of `${addr}.outbox.*` after `UXF_TRANSFER_V1` is enabled.
- Group legacy entries by `(recipientPubkey, createdAt within 60s window)`.
- Synthesize one `UxfTransferOutboxEntry` per group with `mode: 'txf'`, `deliveryMethod: 'txf-legacy'`, `bundleCid` synthetic per §7.2 paragraph 2.
- Status mapping: legacy `delivered|confirmed → 'finalized'`; `pending → 'sending'`; `failed → 'failed-permanent'`.
- Preserve `recipientNametag` (extend the new schema with that optional field — done in T.6.D).
- One-way: legacy collection cleared after migration commits.
- Idempotent: re-running on a migrated wallet is a no-op (key prefix indicates schema version).

### §6.B Legacy `invalidTokens` → multi-rep `_invalid` keys

Implemented in **T.1.E**. Each legacy single-record entry becomes a per-entry-key record under `${addr}.invalid.${tokenId}.${observedTokenContentHash}` with `observedTokenContentHash = "legacy-" + tokenId` (synthetic disambiguator). Migration is one-way; legacy `invalidTokens` collection is cleared after.

### §6.C `_audit` is NEW

There is no legacy audit data. T.1.E adds the key mapping; T.3.C creates the writer; the collection is empty for all wallets at first run.

### §6.D Production call-site migration: legacy single-coin `send()` callers

Implemented in **T.7.C**. Order:

1. T.1.B widens the type — call-sites compile but behavior unchanged (legacy default).
2. T.7.C explicitly passes `transferMode: 'instant'` (or whatever the caller intends) at every site. No semantic change for callers that were already on `'instant'`.
3. T.7.E flips the SDK default from "instant over legacy TXF" to "instant over UXF". Now any site that omitted `transferMode` switches to UXF.
4. T.8.D removes the legacy code path entirely.

Sequenced this way, no PR introduces a behavior change without an explicit type-level signal.

### §6.E Order of migrations against canonical §7.2

Per §7.2 paragraph "Migration on first read":

1. **First**: T.1.E lands `PROFILE_KEY_MAPPING` extension (no migration yet — just schema).
2. **Second**: T.6.D runs the outbox migration on first read.
3. **Third**: T.6.D's migration trigger writes a sentinel key `${addr}.uxf_migration_complete = true` to make subsequent reads skip the migration check.
4. **Fourth**: T.6.E's crash-recovery test exercises the migration-mid-flight path (crash before sentinel commit → migration replays cleanly).

---

## §7 Rollout / fallback strategy

### §7.A Feature flag

`UXF_TRANSFER_V1`: a runtime boolean (env var `SPHERE_UXF_TRANSFER_V1=1`, or `Sphere.init({ features: { uxfTransferV1: true } })`).

| Phase | Flag state | Deployment |
|---|---|---|
| T.1 lands | unused | All wallets behave as today. |
| T.2/T.3/T.4 lands | off by default | Code is on disk but unused; opt-in for testing only. |
| T.5/T.6/T.7 lands | off by default | Same; testing on testnet via opt-in. |
| T.8.A–T.8.C lands | off by default | Regression fixture, capability hints, error surfaces all in place. |
| T.8.D removes legacy | flag becomes vestigial | Legacy code paths gone; flag is a no-op (always-on). |

### §7.B Dry-run / dual-write

During T.6.D migration window (post-T.6.A, pre-T.8.D), the outbox can be operated in **dual-write mode**:

- Legacy writes: continue via existing `_outbox` field in TXF data.
- New writes: go to `${addr}.outbox.${id}` per-entry-key form.
- Reads: prefer per-entry-key; fall back to legacy if absent.

Set via `Sphere.init({ features: { uxfTransferV1: 'dual-write' } })`. Once a wallet has 100% per-entry-key entries, flip to `true` (single-source).

### §7.C Back-out procedure

Each wave is reverted by reverting its tagged commit:

1. T.8.D removed legacy code → revert T.8.D PR. Legacy code returns; flag `UXF_TRANSFER_V1` re-enables the dispatcher fork.
2. T.7.E default flip → revert T.7.E PR. Default returns to legacy.
3. T.6.D legacy outbox migration → IRREVERSIBLE for migrated wallets (one-way migration). Mitigation: T.6.D writes a backup copy to `${addr}.legacyOutbox.backup` before clearing the legacy collection; restore script `tools/restore-legacy-outbox.ts` re-creates the legacy entries.

### §7.D Operator runbook (T.8.D)

`docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md` lands in T.8.D and covers:

- Pre-cutover check: regression fixture passes, all 6 production call-sites migrated, capability hints emitted.
- Cutover step: deploy T.8.D (legacy code removed).
- Smoke tests: 5-token send/receive on testnet; chain-mode 3-hop on testnet.
- Rollback: revert T.8.D PR; legacy code returns under flag.
- Postmortem: monitor `transfer:fetch-failed`, `transfer:trustbase-warning`, `transfer:security-alert` rates for 7 days.

### §7.E Telemetry

Counters / events to watch during rollout (each emits via the `sphere.on()` event surface):

- `transfer:bundle-published` (sender, on each Nostr ack).
- `transfer:bundle-received` (recipient, on each disposition).
- `transfer:fetch-failed` (recipient CID fetch failed across all gateways).
- `transfer:trustbase-warning` (recipient or sender).
- `transfer:security-alert` (rare, suspect aggregator).
- `transfer:cascade-failed` (downstream notification).
- `transfer:capability-warning` (sender ships shape recipient may not understand).
- `transfer:ingest-queue-full` (recipient's worker pool overloaded).

---

## §8 Open questions / unknowns

These do not block T.1–T.8 but should be resolved before merge of the corresponding wave:

1. **T.1.D — CIDv1 binary lex-min comparison** — the spec says "raw CIDv1 binary form, NOT base32 string" (§5.3 [D-conflict] paragraph). Confirm the CIDv1 binary format we're comparing on — it's the raw multihash bytes, not the multibase-prefixed binary. Action: `compareCidV1Binary` in T.1.D includes a comment + reference test; reviewer to confirm.
2. **T.5.A — `splitParent` field on existing token records** — the canonical §6.1.1 cascade rule walks `splitParent`. Existing tokens in the wild may not have this field. Behavior: missing `splitParent` → no cascade (the field is set when a child is minted from a still-pending parent in the new path; legacy children predate this).
3. **T.6.B — Lamport-clock initialization on schema migration** — when T.6.D synthesizes a `UxfTransferOutboxEntry` from a legacy `OutboxEntry`, what's the initial Lamport? Choose: max(observed remote Lamports for `${addr}.outbox.*`) + 1, OR fixed `0`? Decision: `0` is safe (any subsequent local write bumps to `max(observed) + 1`); document in T.6.D inline.
4. **T.5.C — Per-tokenId mutex strategy choice** — CAS (preferred) vs lock-with-RPC-release vs lock-with-bounded-hold. T.1.F implements all three; T.5.C selects CAS by default. If the implementation discovers CAS doesn't work well under our OrbitDB version, switch to lock-with-RPC-release. Document the choice in T.5.C inline.
5. **T.7.A — instant-TXF + chain-mode forwarder semantics** — when a forwarder dies mid-chain in TXF mode, the per-token outbox entry must carry inherited `outstandingRequestIds`. This is awkward (TXF was originally per-token-flat); confirm the schema permits it. Action: T.7.A includes an explicit test for this edge case.
6. **T.8.A — fixture regen process** — the byte-identical fixture is gated on a tagged commit. Establish in advance: who can regenerate, on what occasion, with what ADR template.
7. **T.8.E — CI runtime budget** — adversarial test suite is large (~30 files). If wall-clock exceeds 8 minutes on the standard runner, split into a `tests/adversarial/` selective suite that runs nightly + on PRs touching `modules/payments/transfer/`.

Periodic rescans (§12.3) are explicitly **deferred** per the user-supplied constraint and §13 closing paragraph; no T.1–T.8 task includes them. A future plan T.9+ will add the rescan loops on top of the storage and event plumbing landed in this plan.

---

## Appendix: Task summary table

| ID | Title | Wave | Skill | Est LoC | Critical-path? |
|---|---|---|---|---|---|
| T.1.A | UxfTransferPayload + DeliveryStrategy | T.1 | types | 220 | YES |
| T.1.B | Widen TransferMode + TransferRequest | T.1 | types | 280 | YES |
| T.1.C | DispositionReason + AuditStatus enums | T.1 | types | 180 | YES |
| T.1.D | Encode/decode + CAR root extraction | T.1 | wire | 320 | YES |
| T.1.E | PROFILE_KEY_MAPPING extension | T.1 | storage | 360 | YES |
| T.1.F | Lamport + mutex + CAS primitives | T.1 | crdt | 440 | YES |
| T.2.A | Preflight finalize | T.2 | sender | 380 |  |
| T.2.B | Target validation | T.2 | sender | 460 |  |
| T.2.C | Delivery resolver | T.2 | wire | 280 |  |
| T.2.D | Conservative-sender orchestrator | T.2 | sender | 720 |  |
| T.2.E | Transport-layer adapter | T.2 | transport | 240 |  |
| T.3.A | Bundle acquirer + verifier | T.3 | recipient | 760 |  |
| T.3.B | Disposition engine | T.3 | recipient | 1320 |  |
| T.3.C | Multi-rep _invalid + _audit storage | T.3 | storage | 760 |  |
| T.3.D | Conflict / merge engine | T.3 | recipient | 540 |  |
| T.3.E | Worker pool + ingest queue | T.3 | worker | 580 |  |
| T.4.A | Sender CID-pin path | T.4 | sender | 320 |  |
| T.4.B | Recipient verified-CAR fetch | T.4 | recipient | 560 |  |
| T.5.A | Instant-sender orchestrator | T.5 | sender | 820 | YES |
| T.5.B | Sender finalization worker | T.5 | worker | 1100 | YES |
| T.5.C | Recipient finalization worker | T.5 | worker | 1140 | YES |
| T.5.D | Cascade + importInclusionProof | T.5 | recipient | 1180 | YES |
| T.5.E | Trustbase / security-alert events | T.5 | worker | 280 |  |
| T.6.A | UxfTransferOutboxEntry writer | T.6 | outbox | 480 | YES |
| T.6.B | CRDT merger | T.6 | crdt | 760 | YES |
| T.6.C | Status-transition validator | T.6 | outbox | 360 |  |
| T.6.D | Legacy outbox migration | T.6 | migration | 580 |  |
| T.6.E | Crash-recovery test harness | T.6 | tests | 240 |  |
| T.7.A | TXF sender (both variants) | T.7 | sender | 720 | YES |
| T.7.B | Legacy receiver adapter | T.7 | recipient | 820 | YES |
| T.7.C | Production call-site migration | T.7 | cli-cleanup | 380 |  |
| T.7.D | Forced-conservative coercion | T.7 | cli-cleanup | 180 |  |
| T.7.E | Default-mode flip | T.7 | cli-cleanup | 220 | YES |
| T.8.A | Regression fixture | T.8 | tests | 220 |  |
| T.8.B | Capability hint surfacing | T.8 | transport | 320 |  |
| T.8.C | Error surface audit | T.8 | tests | 200 |  |
| T.8.D | Production cutover | T.8 | cli-cleanup | 380 | YES |
| T.8.E | Integration + adversarial tests | T.8 | tests | 2400 |  |

**Total**: 38 tasks, ~22,500 LOC including tests, ~18 critical-path tasks.

---

*End of UXF-TRANSFER-IMPL-PLAN.md.*
