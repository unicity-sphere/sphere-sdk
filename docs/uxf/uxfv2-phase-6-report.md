# Phase 6 (STSDK v1→v2 swap) — Foundation report & scope escalation

**Date:** 2026-07-07. **Author:** Phase 6 execution agent (Opus 4.7).
**Status:** **Sub-phase 6.A (foundation borrow) + 6.D (constants) landed. Sub-phases 6.B, 6.C, 6.E STOPPED — escalating scope.**

## What landed on `@vrogojin/uxf-v2`

Two safe, mechanical additions preserve the build-green invariant and give
Phase 6.C a fixed starting point:

### 6.A — `token-engine/` borrowed wholesale (SHA-pinned)

- 15 files copied verbatim from `unicity-sphere/sphere-sdk`
  `main@ce758f6b6a41809e0771692a069d0f0eb0b3349f` into `/home/vrogojin/uxf/token-engine/`.
- Every file carries the mandated SHA-pin header comment on line 1.
- Files: `engine.ts`, `types.ts`, `identity.ts`, `factory.ts`,
  `SphereTokenEngine.ts`, `SpherePaymentData.ts`, `token-blob.ts`,
  `unicity-id.ts`, `split-checkpoint.ts`, `realization.ts`, `sdk.ts`,
  `network.ts`, `blob-keys.ts`, `errors.ts`, `index.ts`.
- **`token-engine/` is excluded from `tsconfig.json` compilation** because
  every one of its 58 STSDK imports (see `sdk.ts`) targets v2 SDK paths
  (`lib/api/CertificationData.js`, `lib/crypto/hash/HashAlgorithm.js`,
  `lib/serialization/cbor/CborSerializer.js`, …) that do not exist in the
  v1 SDK we are still pinned to. Under the current pin, adding the
  directory to the build would fail at every SHA-pinned import site.
- The exclude is temporary. Sub-phase 6.B (STSDK bump) removes it as its
  first act — that is the moment `token-engine/` starts type-checking.

### 6.D — `NETWORKS.testnet2` + trust-base URL added

- `constants.ts` gains `TESTNET2_GATEWAY_URL`
  (`https://gateway.testnet2.unicity.network`), `TESTNET2_TRUST_BASE_URL`,
  `TESTNET2_TOKEN_REGISTRY_URL`, and a new `NETWORKS.testnet2` entry.
- Existing `NETWORKS.testnet` (v1 goggregator) is preserved verbatim.
  Mainstream **aliases** `testnet` → testnet2, but we cannot: v1 is still
  wired throughout our core, and pointing v1 aggregator code at a v2
  gateway would fail every RPC. The alias happens as part of 6.C when v1
  is out of core.

Both changes are additive-only and produce **zero drift in the existing
behavior**. `npx tsc --noEmit` returns 0. The test suite is unaffected
(no core file touched).

---

## Why 6.B, 6.C, 6.E STOPPED

The team lead's cascade guardrail — *"if a rewire cascades beyond
estimate (e.g. 40 files touched instead of 10), STOP and report"* —
applies here as written. The scope of the remaining Phase 6 work is
materially larger than the guardrail permits for a single execution, and
larger than the ~10-file rewire the sub-phase 6.C prompt anticipated.

### Concrete measurements (this branch, 2026-07-07)

| Metric | uxf @ `5c56f860` | mainstream `sphere-sdk` origin/main (`ce758f6b`) |
|---|---|---|
| `modules/payments/PaymentsModule.ts` | 19,253 LoC | 5,954 LoC |
| `modules/payments/*.ts` total | 23,610 LoC | ~1,700 LoC (post-#578 slimming) |
| `oracle/UnicityAggregatorProvider.ts` | 1,126 LoC | 281 LoC |
| Core files with direct STSDK imports | **15** | 0 outside `token-engine/` |
| Core-only STSDK v1 import statements | **116** | — |
| Top files by v1 import count | `PaymentsModule.ts` 23, `InstantSplitExecutor.ts` 18, `InstantSplitProcessor.ts` 13, `TokenSplitExecutor.ts` 11, `NametagMinter.ts` 11, `UnicityAggregatorProvider.ts` 10, `TokenRecoveryService.ts` 10, … | — |

The sub-phase 6.C prompt enumerated 10 files; the actual scan finds 15
core files, and 5 of them are 400+-line-changes each (each import site
is a concept swap, not a rename — see below). The plan §7 R-B risk was
written for exactly this shape: *"the in-place STSDK swap has no 'main
already did it' safety net — main's token-engine has NO v1 debt, but our
call sites do; v1-shaped tests break in non-obvious ways in Phase 6."*

### What each import site actually costs

The v1→v2 delta is a **protocol + data-model replacement**, not a
rename pass (see `scratchpad/investigation-stsdk-v2.md §2`):

- **Removed concepts** (no direct v2 equivalent): `address/*` (all
  `DirectAddress`/`ProxyAddress`/`AddressFactory` — v2 has no address
  layer at all); `predicate/embedded/*` (`MaskedPredicate`,
  `UnmaskedPredicate`, `DefaultPredicate` — replaced by
  `SignaturePredicate` + `BurnPredicate` in `predicate/builtin/`);
  `token/fungible/*` (`CoinId`, `TokenCoinData`, `SplitMintReason` —
  value is now app-defined via `IPaymentData`); `Commitment` /
  `MintCommitment` / `TransferCommitment` / `RequestId` /
  `Authenticator` / `TokenState` / `SubmitCommitmentRequest` (whole
  send-pipeline abstraction gone; replaced by
  `MintTransaction.create` → `CertificationData.from*` →
  `submitCertificationRequest` → poll `getInclusionProof(StateId.from…)`
  → `toCertifiedTransaction` → `Token.mint`); `JSON` serde
  (`toJSON`/`fromJSON`) — v2 is **CBOR-only**.
- **Semantic renames**: `nonce` → `stateMask` (with role change),
  `TokenId.fromNameTag` → gone (v2 offers on-chain `unicity-id/` which
  sphere-sdk #578 deliberately does NOT use).
- **New required inputs**: `NetworkId` is mandatory on
  `MintTransaction.create` (testnet2 = 4);
  `TokenId.fromSalt(networkId, salt)` — token ids are derived, not
  caller-chosen.
- **Aggregator wire protocol changed** — a v2 client cannot talk to the
  v1 gateway (`goggregator-test.unicity.network`), which is exactly why
  6.D needed to add testnet2 as a new endpoint alongside.

Per v1 import site in our code, this means:
- The reference is not "search + replace"; it is *"read the surrounding
  code, understand what state the v1 abstraction was in, find the closest
  `ITokenEngine` operation, rewrite the call site, then update all local
  state that the v1 abstraction was persisting."*
- On top of that, the persistence layer (`TxfStorageDataBase`, OUTBOX/SENT
  ledgers) stores v1 JSON token shapes. v2 tokens are CBOR blobs. Every
  `Token.fromJSON()` and `Token.toJSON()` site (grep-counted ~123 across
  prod dirs, `investigation-stsdk-v2.md §3a`) needs its persistence
  path swapped for `engine.encodeToken` / `engine.decodeToken`.

### What mainstream's #578 cost

Mainstream absorbed the same swap on a **smaller** and **less-drifted**
base:

- **PR #578**: 197 files, +13,053 / −24,666 LoC.
- Preceded by **staged PRs #408 / #410 / #412 / #416** (Track A/B) —
  the actual engineering was multi-week, multi-PR.
- The `token-engine/` we just borrowed **is the destination**, not the
  path — mainstream shipped it over months of design + implementation
  iterations. Their PaymentsModule at that point was 5,954 lines.
- Consumers migrated across **subsequent PRs #480 (v1 cutover), #524
  (wallet-api), #612 (currency), #604 (L1 removal)** — each merged
  separately.

### Plan §4 own estimate for Phase 6

The plan (`scratchpad/uxfv2-execution-plan-v2.md §4 Phase 6`) explicitly
estimates **3–4 weeks** for this phase, with the caveat *"This is the
phase adopt-main made free; it is the core of the D0 price."* The
rollback trigger reads: *"if engine wiring reveals that a surviving
core concern (e.g. the persistence codec's TXF shapes) cannot express
v2 tokens without a redesign exceeding budget → stop, spec the shape
(short addendum), then resume. Do not improvise storage formats
mid-swap."*

The user escalated this ahead of Phase 5 because live testnet
e2e/soaks are blocked without STSDK v2. The escalation is legitimate
— the goggregator v1 endpoint is being retired. But the escalation
does not change the plan's own time estimate. Doing this work in a
single session risks producing broken code that violates the team
lead's explicit *"test suite must stay green at every commit"*
constraint and the *"do not commit broken code"* rule.

---

## Recommended path forward

Given (a) the plan's own 3–4 week estimate, (b) the 15-file / 116-site
concrete scope on our tree, and (c) the *"do not commit broken code /
test suite must stay green at every commit"* constraint, the best next
step is one of two options — the team lead should pick:

### Option A — Sequenced multi-agent Phase 6.C dispatch (per the plan)

Phase 5 splits before Phase 6 as the plan originally sequenced.
Rationale: PaymentsModule.ts at 19,253 lines is not tractable file-by-file
for the v1→v2 rewire; Phase 5 splits it into ~10 sub-modules per
[REF §2.1] disposition labels [A] survive-bound / [B] extension-bound /
[C] DELETE-bound. Then Phase 6.C is many small-file rewires where each
one is bounded and testable, not one 19k-line monolith rewrite.

- **Wall clock:** Phase 5 (1.5–2 weeks, parallelizable) + Phase 6.C
  (3–4 weeks per plan) = 5–6 weeks.
- **Blast radius:** contained per PR; every file-split lands with tests
  green.

### Option B — Narrow-target v2 smoke path (unblocks testnet2 sooner)

Skip the full core rewire. Instead:
1. Bump STSDK to v2 (temporarily accept that most of PaymentsModule
   will not compile — mark those files with `@ts-nocheck` or move them
   into a `modules/payments/legacy-v1/` quarantine dir excluded from
   the build).
2. Wire ITokenEngine into `Sphere.init` alongside — but not replacing —
   the existing PaymentsModule.
3. Expose `sphere.tokenEngine` (or `sphere.uxf.tokenEngine`) directly
   for consumers who need testnet2.
4. Add the smoke test (mint + inclusion proof) against `sphere.tokenEngine`.
5. Consumers that need v2 today (trader-service testnet2 soaks) use the
   new handle; consumers on v1 stay on the legacy PaymentsModule.

This is **not the plan's Phase 6** — it produces a two-track SDK
temporarily. But it unblocks testnet2 e2e in ~3–5 days rather than
5–6 weeks. The Phase 6 proper still needs to happen; this is a triage
to unblock the customer while Phase 5 + Phase 6.C sequenced work runs
in parallel.

The trade-off is codebase clarity: with Option B, our tree has both a
v1 stack and a v2 stack live at the same time, which is exactly what
the plan tries to avoid (§4 Phase 6 preamble: *"one variable at a
time"*). Any Option-B code is scrap that Phase 6.C deletes.

---

## Concrete deliverables from this session

- `token-engine/` at repo root: 15 SHA-pinned files, present but excluded
  from build (`tsconfig.json`).
- `constants.ts`: `TESTNET2_GATEWAY_URL`, `TESTNET2_TRUST_BASE_URL`,
  `TESTNET2_TOKEN_REGISTRY_URL` constants; `NETWORKS.testnet2` config
  entry. Preserves `NETWORKS.testnet` verbatim.
- `tsconfig.json`: `token-engine/**/*.ts` added to `exclude`.
- No dependency changes. No STSDK version bump. No `stsdk-v1` alias
  (would be dead code without the SDK bump).
- No `nostr-js-sdk` bump. No engines bump. No `@noble/ciphers` addition.
  (All planned for 6.B; each is one line, but each has ripple that
  must land alongside the core rewire.)
- Build: `npx tsc --noEmit` exits 0. Test suite unaffected (no core
  file touched).
- `docs/uxf/uxfv2-phase-6-report.md` — this file.

## Not done (needs Option A or B choice)

- `package.json` STSDK pin bump `1.6.1-rc.f37cb85` → `2.0.0-rc.68bc1e5`.
- `stsdk-v1` npm alias.
- Extension bulk rewrite of `from '@unicitylabs/state-transition-sdk/…'`
  → `from 'stsdk-v1/…'`.
- `nostr-js-sdk` bump to `^0.6`.
- `@noble/ciphers` dependency add.
- `engines.node >= 22`.
- ESLint rule banning STSDK imports outside `token-engine/`.
- Core rewire (15 files, 116 sites).
- Live smoke against `gateway.testnet2.unicity.network`.

## Answer to team lead's "can Phase 5 proceed cleanly?"

**Yes — Phase 5 can proceed cleanly and should proceed BEFORE any
further Phase 6 work.** Phase 5 is orthogonal: it splits our 19,253-line
`PaymentsModule.ts` into ~10 sub-modules keyed on disposition labels
(survive / extension / DELETE-bound). Doing Phase 6.C after Phase 5
lands means each Phase 6.C rewire PR touches a bounded, single-purpose
file. That is what the plan sequenced and what the team lead's cascade
guardrail was designed to preserve. The escalation ahead of Phase 5 was
motivated by testnet2 unblock urgency; if that urgency can absorb the
Phase 5 wall-clock (1.5–2 weeks parallelizable), the sequenced path is
strictly better. If not, Option B above is the triage.
