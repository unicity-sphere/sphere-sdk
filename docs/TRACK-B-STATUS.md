# Track B — Status
> **Status: HISTORICAL — the v1→v2 cutover completed 2026-06-10 (PRs #479/#480/#481). v1 is removed; see CHANGELOG.md.**

> Caller / identity / test side of the `@unicitylabs/state-transition-sdk` **v1 → v2** migration.
> Companion to [`TRACK-B-KICKOFF.md`](TRACK-B-KICKOFF.md) (scope, locked decisions) and
> [`TRACK-B-PREP.md`](TRACK-B-PREP.md) (per-file map). Track A owns the engine/SDK side
> (`token-engine/`, oracle, storage); Track B migrates every SDK *consumer* onto the frozen
> `ITokenEngine` port.

**Branch:** `feat/migrate-state-transition-sdk-track-b`
**Suite:** 2807 / 2807 passing (144 files) · `tsc` 0 errors · changed files lint-clean.

---

## 1. TL;DR — task status

| Task | Module / concern | Status |
|------|------------------|--------|
| **B1** | `PaymentsModule` — L3 send/receive, value/key reads | ✅ **done** (dual-path) |
| **B2** | `AccountingModule` — invoices (mint/import/attribution) | ✅ **done** (dual-path) |
| **B3** | `SpendQueue` / `TokenSplitCalculator` — value reads | ✅ **done** (dual-path) |
| **B4** | nametag/PROXY removal (D5 — Nostr-binding identity) | ✅ **done** |
| **B5** | `TokenValidator` → `ITokenEngine` | ✅ **done** |
| **B6** | identity / `Sphere` — `DIRECT://` derivation (D10/Path A) | ✅ **done** |
| **B7** | XP-login + anti-bot tests | ⏳ **deferred** (blocked on sphere-api login gate) |

**The entire Payments + Accounting caller layer is migrated.** What remains is the Σ2 cutover,
owned by Track A (A4-int + A5), plus the deferred B7.

---

## 2. Strategy — Path B (optional-engine, dual-path)

Each migrated module takes an **optional** `tokenEngine?: ITokenEngine` dependency:

- **engine present** → the v2 path runs (engine does mint/transfer/split/verify/reads);
- **engine absent** → the legacy **v1 path runs unchanged** (the fallback).

This keeps the tree green at every commit while the real engine is not yet constructed in
`Sphere`. The engine is injected by Sphere only once Track A lands **A4-int** (oracle → engine
construction). Until then the engine is `undefined` in production and **every committed change is
a no-op on the live v1 path** — exercised only by unit tests that inject `FakeTokenEngine`.

### The storage bridge (B-led)
The transitional storage representation, established in B3 and reused everywhere:

```
write:  token.sdkData = bytesToHex(encodeTokenBlob(engine.encodeToken(token)))
read:   engine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData)))
```

`encodeTokenBlob` / `decodeTokenBlob` live in `token-engine/token-blob.ts` (CBOR). Format
auto-detection is `sdkData[0] !== '{'` + even-length lowercase-hex (v1 TXF is JSON, v2 is a hex
blob). **A5 (Track A) finalises this storage representation and removes the v1 serializer.**

### The wire contract
`types/v2-transfer.ts` — `V2TransferPayload { type:'V2_TRANSFER', version:'2.0', tokenBlob, memo? }`
+ `isV2TransferPayload`. v2 is **sender-driven**: the sender hands the recipient a *finished*
token (the blob); the receiver just stores it — no commitment / inclusion-proof / finalization
(contrast v1 `{ sourceToken, transferTx }` and the V5/V6 bundles).

---

## 3. What each task did

### B1 — PaymentsModule (L3)
- **Reads** (`parseTokenInfo`, `buildParsedPool`, token-key extraction) dual-path: coin/amount via
  `engine.readValue`/`balanceOf`, `tokenId` from the blob, per-state key = `tokenId_SHA256(blob.token)`.
  Tombstone/dedup/spent keys are **engine-free** (the blob self-describes), so they work on v2 tokens
  without an injected engine.
- **Send** branches on `engine + recipient chainPubkey`: whole-token via `engine.transfer`, partial via
  `engine.split` (recipient output emitted + change stored immediately, no placeholder/background mint).
  Emits a `V2_TRANSFER` payload; the v1 conservative/instant paths remain as fallback. On-chain memo =
  the structured `onChainMessage` (`{inv:{id,dir}}` for invoice payments, `null`/transport-only for plain).
- **Receive** — `handleV2Transfer` decodes the finished blob, dedups by `v2_<tokenId>`, stores it confirmed,
  emits `transfer:incoming` + a `RECEIVED` history entry. No proof round-trip.

### B2 — AccountingModule (invoices)
*An invoice IS a data token.*
- **createInvoice** → `engine.mintDataToken({ data: invoiceBytes, tokenType: INVOICE, salt })`. The invoice
  id = `engine.tokenId` (**64-char**, deterministic from the existing `SHA-256(key‖terms)` salt) — which
  also resolves the latent 64-vs-68-char inconsistency the id index/regex already assumed.
- **importInvoice** — accepts the v2 blob; verifies via `engine.verify` (the proof chain binds terms↔token),
  reads terms from `engine.readTokenData`. The v1 terms→id re-hash (CR-M1) and SDK `Token.verify` are guarded
  to the legacy path; shared term-validation / dedup / store / finalize are untouched.
- **attribution** — a v2 payment carries one on-chain memo; `_scanTokenForAttribution` shims it into a
  v1-shaped `txf` (coinData ← `readValue`, memo ← `readMemo`) and feeds the **unchanged, battle-hardened**
  `_processTokenTransactions` (preserving all provisional/synthetic/orphan dedup + watermark logic). Wired
  into the 6 async scan sites.

### B3 — SpendQueue / TokenSplitCalculator
`SpendPlanner.buildParsedPool` value reads dual-path (`engine.balanceOf`); `TokenSplitCalculator` reduced to
SDK-free types-only (dead `calculateOptimalSplit` removed). `tokenEngine?` added to `PaymentsModuleDependencies`.

### B4 / B5 / B6 (earlier on the branch)
- **B4** — retired on-chain nametags + removed PROXY (Nostr-binding identity only, D5).
- **B5** — `TokenValidator` rewritten over `engine.verify`/`isSpent`.
- **B6** — `DIRECT://` identity via the shared `deriveDirectAddress` (XP-invariant, D10/Path A).

---

## 4. Test coverage (clean v2 harnesses — no SDK `vi.mock`, `FakeTokenEngine` injected)

| File | Covers |
|------|--------|
| `tests/unit/modules/PaymentsModule.v2-receive.test.ts` | receive store-only, send direct + split round-trips, on-chain memo encoding |
| `tests/unit/modules/PaymentsModule.token-keys.test.ts` | dual-format tombstone/dedup/spent keys |
| `tests/unit/modules/PaymentsModule.parseTokenInfo.test.ts` | engine value-read path |
| `tests/unit/modules/SpendPlanner.test.ts` (engine block) | `buildParsedPool` via `balanceOf` |
| `tests/unit/modules/AccountingModule.v2-createInvoice.test.ts` | createInvoice / importInvoice / attribution (v2) |
| `tests/unit/types/v2-transfer.test.ts` | wire payload guard |
| `tests/unit/validation/TokenValidator.test.ts` | engine-based validator |

Each new behaviour was added test-first (red verified by disabling the engine branch). v1 paths stay
covered by their existing suites (e.g. AccountingModule 407, importInvoice 16) — all green.

---

## 5. The v1 → v2 boundary

Files still importing the v1 SDK (i.e. still holding a **v1 fallback** path):

```
modules/payments/PaymentsModule.ts        ← dual-path (v1 fallback)
modules/payments/SpendQueue.ts            ← dual-path (v1 fallback)
modules/accounting/AccountingModule.ts    ← dual-path (v1 fallback)
modules/payments/InstantSplitExecutor.ts  ← v1 send machinery (fallback executors)
modules/payments/InstantSplitProcessor.ts ← v1 send machinery
modules/payments/TokenSplitExecutor.ts    ← v1 send machinery
oracle/UnicityAggregatorProvider.ts       ← Track A (A4-int)
```

All of these are removed/rewritten at the Σ2 cutover.

---

## 6. Σ2 cutover — handoff to Track A

Track B's callers are ready. The cutover needs **A4-int + A5** (Track A, off-limits to Track B):

1. **A4-int** — construct the real engine in `Sphere` (via the oracle: aggregator URL + trust base +
   identity private key → `createSphereTokenEngine`) and inject it into the module deps
   (`tokenEngine`). This flips every dual-path module to the engine path in production.
2. **A5** — finalise `Token.sdkData` as the v2 blob (adopt the storage bridge from §2) and retire the
   v1 `txf-serializer`.

Once the engine is the default, Track B (or whoever owns cleanup) **deletes the v1 fallbacks**:
- the v1 send branches in `PaymentsModule` + `InstantSplitExecutor` / `InstantSplitProcessor` /
  `TokenSplitExecutor` (the whole V5/V6/commitment-only machinery);
- the v1 mint/verify branches in `AccountingModule` (createInvoice `else`, importInvoice `if (!isV2)`);
- the v1 parse branches in `SpendQueue` / `parseTokenInfo` / `_scanTokenForAttribution`;
- the **unconditional `stClient` / `trustBase` requirement checks** in `PaymentsModule.send` /
  `AccountingModule` (currently required even on the engine path — see §7).

---

## 7. Known follow-ups & traps

- **Unconditional oracle checks on the engine path.** `PaymentsModule.send` still throws if
  `oracle.getStateTransitionClient()` / `getTrustBase()` are absent, *before* the engine branch; the
  engine path ignores them. Tests inject stubs. A4-int must either keep the oracle providing them or
  relax these checks for the engine path.
- **`readTokenType` gap.** The port exposes no token-type read, so v2 `importInvoice` skips the
  `tokenType === INVOICE` check (the type is fixed at mint, and `engine.verify` binds the genesis).
- **v2 invoice-id is salt-derived** (`SHA-256([SHA-256(key‖terms), networkId])`). An importer can't
  re-derive it from terms alone (no creator key) — binding comes from the **proof chain** + `readTokenData`,
  not the v1 terms→id re-hash. By design.
- **Left v1 (deliberate):** `AccountingModule._handleTokenChange` (sync; v2 covered by the async
  incoming/confirmed handlers), the archived-token attribution loops (v2 archived is out of Track B's
  scope), and `load()` invoice loading @ ~392 (separate concern).
- **Pre-existing lint (not Track B):** 3 errors in `modules/swap/SwapModule.ts` + `tests/e2e/swap-continuous.test.ts`
  (present in the baseline; untouched by this work).

---

## 8. Remaining

- **B7** — XP-login + anti-bot tests. Deferred pending the sphere-api login-gate resolution.
- **Σ2 cutover** — Track A's A4-int + A5, then v1-fallback deletion (§6).

---

## 9. Commit map (this branch)

```
58922d9  fix(B1)   v2 send encodes the structured on-chain invoice memo
145f6a8  feat(B2)  attribution via engine.readMemo (v2 payment tokens)
0ef1fba  style     fix pre-existing no-useless-escape in AccountingModule
dfdf87c  feat(B2)  importInvoice via engine.decodeToken/verify (v2 blob)
4cd4f5c  feat(B2)  createInvoice via engine.mintDataToken (invoice as data token)
0928226  feat(B1)  v2 engine send split (engine.split + immediate change)
d5e4e05  feat(B1)  v2 engine send (whole-token direct via engine.transfer)
2b1ac34  feat(B1)  handleV2Transfer receiver (store finished v2 token)
5444853  feat(B1)  v2 transfer wire payload contract
3654ca8  feat(B1)  parseTokenInfo v2 engine value-read path
3a5a71d  feat(B1)  dual-format token-key extraction (tombstones/dedup/spent on v2 blobs)
f0fd557  feat(B3)  SpendPlanner.buildParsedPool engine value-reads
702c41a  refactor  TokenSplitCalculator → types-only (drop dead calculateOptimalSplit)
b01bc94  feat(B5)  migrate TokenValidator to ITokenEngine
84a3b1c  test(B7)  chainPubkey stability cross-check (D9)
f5ce630  feat(B4)  retire on-chain nametags + kill PROXY (D5)
f79982a  refactor  delete dead V5 recovery/background services (sender-driven)
a49bb3b  feat(B6)  DIRECT:// identity via shared deriveDirectAddress (XP-invariant)
```
