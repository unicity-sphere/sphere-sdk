# Track B — Prep (state-transition v2 migration)
> **Status: HISTORICAL — the v1→v2 cutover completed 2026-06-10 (PRs #479/#480/#481). v1 is removed; see CHANGELOG.md.**

> **Status: PREP ONLY. No implementation written yet.** Produced while Phase 0's
> hard-stop is interpreted conservatively (no code changes). Track A has already
> delivered A1–A6 + the `createSphereTokenEngine` factory + `deriveDirectAddress`
> (golden-locked), and the `ITokenEngine` contract is frozen — so the substance
> below is verified against the **real** frozen port (`token-engine/engine.ts` +
> `types.ts`), not the (sometimes stale) migration prose.
>
> Companion docs: `STATE-TRANSITION-V2-MIGRATION.md` (§2 decisions, §8 tracks),
> `STATE-TRANSITION-V2-MIGRATION-DETAILED.md` (Part C per-file), `TRACK-B-KICKOFF.md`,
> `TRACK-A-STATUS.md`. Per-file maps were produced by a 10-agent read-only sweep
> (file:line anchors below are from that sweep + direct reads).

---

## 1. Locked decisions (D1–D10) — the 5 that drive Track B

| # | Decision | Track-B consequence |
|---|----------|---------------------|
| **D3** | **Single `token-engine/` wrapper** is the ONLY SDK importer. | Every Track-B file imports `ITokenEngine`/sphere-domain types from `token-engine`, never `@unicitylabs/state-transition-sdk`. ESLint `no-restricted-imports` enforces it. |
| **D4** | **Public sphere-sdk API frozen.** | `send/receive/getTokens/getBalance/...`, the invoice API, `Sphere.getProxyAddress()`, `Sphere.mintNametag()`, `TransferRequest.addressMode`, `PeerInfo.proxyAddress`, `TokenValidator`, `AggregatorClient` re-export — **all are public and need a ruling before removal** (see §7). |
| **D5** | **Nametag = Nostr binding only** (`@name ↔ chainPubkey`). No on-chain `UnicityIdToken`/`UnicityIdPredicate`. **Receive is ALWAYS `SignaturePredicate(chainPubkey)`.** | `NametagMinter` retires entirely; PROXY addressing dies everywhere; recipient resolution always yields a `chainPubkey` → `engine.transfer({recipientPubkey})`. |
| **D10** | **Path A** — keep byte-identical legacy `DIRECT://` as the identity key → Quest XP preserved, **sphere-api untouched** (B8 = N/A). | `core/Sphere.deriveL3PredicateAddress` delegates to `deriveDirectAddress` **preserving the SHA-256 pre-hash** (see §6, XP-CRITICAL). |
| **Sender-driven** | Sender hands over a **FINISHED** token; receiver only stores. | Delete ALL receiver-side recovery / unconfirmed / finalize machinery. `engine.transfer`/`engine.split` build+submit+wait+certify internally and return finished `SphereToken`s. |

Also locked: D1 balances reset (no token/balance migration, **no cross-version interop** — this is what makes the receiver-branch deletions safe); D6 anti-bot gate preserved (lives in sphere-api; B6 just keeps publishing `directAddress`); D8 spec/PR/commit language = English; D9 `chainPubkey` stable across v1→v2; `mint()` stays on the port (issuer/dev issuance only — **NOT** the nametag/invoice path).

---

## 2. The frozen port I code against (verified, `token-engine/engine.ts` + `types.ts`)

sphere-domain only — `Uint8Array` pubkeys, `string` lowercase-hex coin ids, `bigint` amounts.

```
getIdentity(): EngineIdentity                                   // sync {chainPubkey: Uint8Array(33)}
deriveIdentityAddress(pubkey?): Promise<string>                 // ASYNC — legacy DIRECT:// (Path A)
readValue(token): SphereValue | null                           // sync
balanceOf(token, coinId): bigint                               // sync
mint({recipientPubkey, value?}, opts?): Promise<SphereToken>   // issuer/dev only
transfer({token, recipientPubkey}, opts?): Promise<SphereToken>// sender does everything
split({token, outputs: SplitOutput[]}, opts?): Promise<SplitResult>   // SplitResult = { outputs: SphereToken[] }
verify(token, opts?): Promise<{ ok, reason? }>                 // structural validity only
isSpent(token, opts?): Promise<boolean>                        // network spent-status (NO cache)
encodeToken(token): TokenBlob                                  // sync
decodeToken(blob): Promise<SphereToken>
```
Plus, exported from `token-engine`: `deriveDirectAddress(pubkey): Promise<string>` (A6, for B6),
`createSphereTokenEngine(config): Promise<ITokenEngine>` (factory; `trustBaseJson` is **required**).
`SphereToken = { sdkToken /*OPAQUE*/, blob: TokenBlob, value: SphereValue|null }`.
`TokenBlob = { v:number, network:number, token:Uint8Array }`. `SplitOutput = { recipientPubkey, coinId, amount }`.
`EngineOpOptions = { signal? }`. `EngineConfig = { network, aggregatorUrl, privateKey, trustBaseJson, proofPollIntervalMs?, proofTimeoutMs? }`.

**Test harness:** unit-test against `tests/unit/token-engine/FakeTokenEngine.ts` (deterministic, value-conserving split, in-memory spent-set; proven equivalent to the real engine by `tests/unit/token-engine/engine-contract.ts`/`runEngineContract`). Spy double: `tests/unit/support/mock-token-engine.ts` (`createMockTokenEngine` / `mockSphereToken`) — **already exists and is frozen-port-aligned**. Swap Fake→real (`createSphereTokenEngine`) **only** in integration tests at Σ2/Σ3; trust base via `tests/unit/token-engine/support/RootTrustBaseFixture.ts`.

### Doc-vs-code traps (trust the code)
- **T1 — no memo field, no token-id accessor.** `TransferParams`/`MintParams`/`SplitOutput` have **no** `message`/`data` field; `SphereToken` has **no** `tokenId`/`stateHash` accessor. (See §5 — biggest cross-cutting risk.)
- **T2 — `SphereNetwork = 'mainnet'|'testnet'|'local'`, NO `'dev'`.** sphere's `dev` maps to `'local'`.
- **T3 — `split` returns `{ outputs }`, not `{ burn, outputs }`.** DETAILED §A.4 (`STATE_ID_EXISTS`) and §E.1 mock sketch (`deriveReceivePredicate`/`readPaymentData`) are **stale**. The current correct mock is `tests/unit/support/mock-token-engine.ts`.
- **T4 — MIGRATION §6 illustrative port** (`buildTransfer`/`finalizeTransfer`/`deriveReceivePredicate`) does NOT match the real 12-method port. Map to `readValue/balanceOf/verify/decodeToken/mint/transfer/split` only.

### v2 sequences the engine now owns (I no longer hand-roll these)
`mint`: `MintTransaction.create → CertificationData.fromMintTransaction → submit → waitInclusionProof → toCertifiedTransaction → Token.mint`. `transfer`: `TransferTransaction.create → SignaturePredicateUnlockScript → CertificationData.fromTransaction → submit → waitInclusionProof → token.transfer` (returns a NEW Token). `split`: `TokenSplit.split(token, decodePaymentData, requests)` → burn source + per-output mint with `SplitMintJustification`. **All proof-waiting (~2.3 s/op, polling-only) is internal to the engine** (`EngineConfig.proofPollIntervalMs/proofTimeoutMs`, `EngineOpOptions.signal`).

---

## 3. Per-file change/delete map (Track B scope, with anchors)

Legend: ✅ start now (unblocked vs Fake) · ⏸ blocked (decision/sync) · 🔴 XP/money-critical.

### B1 — PaymentsModule.ts (HIGH) — `modules/payments/PaymentsModule.ts` (6034 lines)
- **Imports:** 17 static v1 (88–104) + 7 dynamic ProxyAddress/UnmaskedPredicateReference/AddressFactory (2347/3538/3554/4468-69/4563-65/5132-33/5164-65/5309) → all gone; add `tokenEngine: ITokenEngine` to `PaymentsModuleDependencies` (647).
- **Reads → engine:** `parseTokenInfo` (194–369, `SdkToken.fromJSON`) → `engine.decodeToken`/`readValue`; `extractCoinAmountForCache` (1598, `coins.get`) → `engine.balanceOf`; `validate()` (5007–30) → `engine.decodeToken` + combine `!verify.ok || isSpent`.
- **Send → engine:** conservative branch (1202–1304) and **three** sender paths — `send()` instant (1305–1477), `instantSplitSend()` (1633+, uses `InstantSplitExecutor` 1752), `processCombinedTransferBundle` — all → `engine.transfer`/`engine.split` then `transport.sendToken(FINISHED)`. **Easy to migrate one path and miss the others.**
- **Mint:** `mintFungibleToken` (4545–4660) → `engine.mint`. (`mintNametag` is D5/B4, NOT `engine.mint`.)
- **GUT** `handleIncomingTransfer` (5435–5693) → store-only (decode → optional verify → parseTokenInfo → addToken → resolveSenderInfo **keep nametag** → history → emit). Delete branches 5449–5621.
- **DELETE (all provably dead under sender-driven + D1):** `resolveUnconfirmed`/`scheduleResolveUnconfirmed`/`stopResolveUnconfirmedPolling` (3227–3320) + timer; V5 pending machinery `loadPendingV5Tokens`/`savePendingV5Tokens`/`finalizeV5PendingToken` (3331–3700); `InstantSplitProcessor` usage (73, 2331); NOSTR-FIRST proof polling (`startProofPolling`/`saveCommitmentOnlyToken`/`handleCommitmentOnlyTransfer`, 1945–2040/5218–5275); `finalizeTransferToken` (5281–5340); `createSdkCommitment`/`createSigningService`/`createDirectAddressFromPubkey` (5078–5153). Async `ReceiveOptions` fields {finalize,timeout,pollInterval,onProgress} (135–157) — ⏸ D4 ruling (keep as ignored no-ops vs remove).
- 🔴 **T1 here:** tombstone/archive/fork/history dedup uses `createTokenStateKey` (442) = `${tokenId}_${stateHash}` parsed from `sdkData` JSON (`parseSdkDataCached` 381–409). SphereToken/blob expose neither → **must derive a Track-B-local token identity** (e.g. `SHA-256(blob.token)`). Getting this wrong silently breaks dedup/sync. (Note: `SpendQueue` reservation keying does **not** hit this — see B3.)

### B1 — InstantSplitExecutor.ts (rebuild) + InstantSplitProcessor.ts (DELETE)
- `InstantSplitProcessor.ts` (1–475): 100% receiver-side V5 finishing → **DELETE file**; remove barrel `modules/payments/index.ts:11`. Only importer = PaymentsModule:73/2331 (deleted with the receiver gut). Also delete the duplicated `finalizeFromV5Bundle` (PaymentsModule:3481).
- `InstantSplitExecutor.ts`: `buildSplitBundle`/`executeSplitInstant` (144–395) → `engine.split({token, outputs:[recipient(splitAmount), self(remainder)]})` + `engine.transfer(recipientOutput)`. Delete `submitBackgroundV5` (451–591), `createTransferCommitmentFromMintData` (403–443), `waitInclusionProofWithDevBypass` (597–619), sha256/salt seed helpers (92–163). Re-point `onChangeTokenCreated` to the FINISHED split self-output; **verify per-coin conservation** so the user doesn't silently lose change. Strip all PROXY/nametag-token branches (270–276).

### B1 — TokenSplitExecutor.ts (rewrite) + B3 — TokenSplitCalculator.ts
- `TokenSplitExecutor.executeSplit` (84–208): collapse burn→mint×2→reconstruct→transfer onto `engine.split` + `engine.transfer`; **drop `recipientTransferTx`** from `SplitResult` (no receiver-applied tx in sender-driven). Signature `recipientAddress: IAddress` → `recipientPubkey: Uint8Array`; config → `{ engine }`. Whole-file may be deletable if PaymentsModule calls the engine inline (decide).
- `TokenSplitCalculator` (B3): value reads only — `SdkToken.fromJSON` (66) → `engine.decodeToken`; `coins.get` (154) → `engine.balanceOf`; retype `TokenWithAmount.sdkToken` (17) → `SphereToken`. **Split-plan math unchanged.** ⚠ likely-dead: `calculateOptimalSplit` (async) appears unused (prod uses `SpendQueue.calculateOptimalSplitSync`) — grep-confirm before porting.

### B1 — TokenRecoveryService.ts + BackgroundCommitmentService.ts → **DELETE BOTH** ✅
- **Both files are entirely DEAD even in v1** — referenced ONLY by self + their two `modules/payments/index.ts` barrel lines (12, 13). Zero instantiations, zero tests, zero type consumers. `TokenRecoveryService` methods are already stubs (`return null` / "not fully implemented"). The `BackgroundCommitmentService` header "Used by InstantSplitExecutor" comment is **stale/false** (grep-verified).
- **DELETE both files + barrel lines 12,13.** S1-independent (S1 governs inline PaymentsModule fire-and-forget, not these). They statically import deep v1 paths → will trip the ESLint boundary, so they must go, not lie dormant.

### B3 — SpendQueue.ts ✅ (then ⏸ on storage contract)
- Only `SpendPlanner` (not `SpendQueue`) touches the SDK: `buildParsedPool` (86–111, `SdkToken.fromJSON`) + `getTokenBalance` (304–312, `coins.get`). → `engine.decodeToken` (async pre-pass) + `engine.balanceOf`. Delete imports 19–20.
- **Reservation/queue critical section + `TokenReservationLedger` keep byte-identical.** **Refined T1:** the queue keys on the sphere-domain `Token.id` (string DTO field, set upstream from the genesis tokenId), **NOT** on any SphereToken accessor → **Q3 is not triggered here**; SpendQueue inherits whatever `Token.id` B1/B2 set upstream. `balanceOf` is sync → critical section stays sync (keep `decode` out of `planSend`).
- Inject `ITokenEngine` into `SpendPlanner` (PaymentsModule:745 `new SpendPlanner(engine)`); confirm engine exists at construction (may move to `initialize()`).

### B2 — AccountingModule.ts (HIGH) ⏸ **BLOCKED (2 Track-A surface gaps)**
- Verify/read path is clean: `SdkToken.fromJSON/.verify` (1573–97) → `engine.decodeToken` + `engine.verify`; balances → `engine.balanceOf`/`readValue`.
- 🔴 **BLOCKER 1 (invoice MINT shape):** invoice = terms serialized into `tokenData` + custom `INVOICE_TOKEN_TYPE_HEX` tokenType + deterministic salt → stable tokenId (1018–1271). Frozen `mint() = {recipientPubkey, value?}` has **nowhere to put invoice terms**. `createInvoice` cannot be ported as-is.
- 🔴 **BLOCKER 2 (on-chain memo / attribution, = Q2):** `SHA-256(invoiceId)` is embedded on-chain via the transfer `message` (written by PaymentsModule `createSdkCommitment`:5100). Attribution reads it back at 4436–4459. The port carries **no memo channel** → attribution breaks unless re-routed.
- **Invoice-id width trap:** ids are **68-char** (imprint = 2-byte algo tag + 32-byte hash). A naive `crypto.subtle` SHA-256 gives 64 and won't match `INVOICE_ID_REGEX`/hash index. A Track-B-local id helper must reproduce the 68-char form (golden-test it).
- Keep frozen (D4): full invoice API, `OPEN→PARTIAL→COVERED→CLOSED`, auto-return ledger, `canonicalSerialize` byte-exact.

### B4 — NametagMinter.ts (DELETE) + transport/NostrTransportProvider.ts ✅ (modulo D4)
- `NametagMinter.ts` (1–269): 100% on-chain SDK mint, **no surviving Nostr code** (binding publish/resolve already lives in the transport) → **DELETE file** + barrel `index.ts:5` + `tests/.../NametagMinter.test.ts`. PaymentsModule: drop import (36), delete `mintNametag` (4442–4515) + on-chain `isNametagAvailable` (4672–4695).
- PROXY kill: `resolveRecipientAddress` (5159–5215) drop ProxyAddress + both emit paths (5193–95 forced, 5207–14 fallback) — nametag without `directAddress` → `throw INVALID_RECIPIENT`. Transport: strip ProxyAddress from `bindingInfoToPeerInfo` (899–901) + `publishIdentityBinding` (1089–90,1100); **keep `directAddress`** everywhere (Path A/D6). Sphere: drop 4 `mintNametag` sites (963/2403/2422/3376); `registerNametag` → `publishIdentityBinding` becomes the sole first-seen-wins registration act.
- ⏸ **D4:** `Sphere.getProxyAddress()` (public), `Sphere.mintNametag(): MintNametagResult` (public), `TransferRequest.addressMode='proxy'`, `PeerInfo.proxyAddress` — keep-as-no-op vs remove? Needs a user ruling.

### B5 — validation/token-validator.ts ⏸ (decide migrate-vs-deprecate)
- **NOT in the live flow** — zero `modules/`/`core/` refs (live validation goes via `oracle.validateToken` / `oracle.isSpent`, Track A). Only its own test instantiates it. → public-surface refresh / deprecation candidate.
- 6 string dynamic imports (RequestId 259/331, DataHash 262/380, Token 328/483) → `verify` → `engine.verify`, spent → `engine.isSpent` (StateId-based, the `publicKey` param becomes vestigial). **Keep the TTL `spentStateCache`** — `engine.isSpent` does NOT cache.
- ⚠ **Impedance mismatch:** every public method takes the domain `Token` (`sdkData: string` TXF JSON); the engine takes `SphereToken`/`TokenBlob`. **The bridge is unbuilt** (domain `Token` has no `blob` field). `AggregatorClient` re-export (index.ts:376) is public (D4).

### B6 — core/Sphere.ts identity + connect/** (XP-CRITICAL) ✅ (A6 shipped → UNBLOCKED)
- 🔴 **XP-CRITICAL (CONFIRMED in code):** v1 `SigningService.createFromSecret(secret)` **SHA-256-hashes the secret** before deriving the pubkey (`SigningService.js:33-41`). So the wallet's `DIRECT://` = `f(getPublicKey(SHA256(privateKey)))`, **not** `f(chainPubkey)`. Naive delegation **wipes all Quest XP.** Correct: `deriveL3PredicateAddress(privKey) = deriveDirectAddress(hexToBytes(getPublicKey(sha256(privateKey,'hex'))))` (keep the `(privateKey:string)=>Promise<string>` signature so all 7 call sites — 2250/3488/3537/3588/4058/4105/4159 — are untouched). `sha256` defaults to `'hex'` (core/crypto:265); pin it.
- A6's golden test only locks the **raw-pubkey** path → **B6 MUST add a characterization test** (real legacy `deriveL3PredicateAddress` ≡ new formula, real keys, golden-locked) BEFORE swapping the body (TDD).
- Remove dead v1 imports (120–123) + `UNICITY_TOKEN_TYPE_HEX` (407) after swap.
- **Connect: ≈ no change** — `PublicIdentity` (protocol.ts:178) already exposes `chainPubkey` + optional `directAddress`; confirm **no `receivePredicate`** is added (D5).
- ⏸ **`getAddressId` re-base on chainPubkey** (kickoff suggests it): **recommend NOT doing it.** It's a shared helper used by 3 storage providers with `directAddress`; re-basing orphans storage + breaks `migrateFromOldNametagFormat`. Under Path A `directAddress` is byte-stable, so the swap does NOT require it. Keep `getAddressId(directAddress)`, treat re-base as deferred. PROXY removal in Sphere (485/3286/3328/3334) gated on the same D4 ruling as B4.

### B7 — tests + swap facade
- **Swap is UNTOUCHED (D4)** and imports **zero** SDK (grep-confirmed). Its only coupling: `deps.payments.validate(): {valid: Token[], invalid: Token[]}` (swap reads `t.id` at SwapModule:2013) + `accounting.getTokenIdsForInvoice()` (1989, via an `as-unknown` cast, invisible to TS). If `validate()` returns `SphereToken[]`, swap breaks unless both sides key on the **same** token identity → R6 acceptance + a fail-closed guard test.
- **16 test files mock v1** (Accounting ×6, Payments ×6, NametagMinter, TokenSplitCalculator, TokenValidator, NostrTransportProvider.nametag) → rewrite to mock the **engine** via `createMockTokenEngine`/`mockSphereToken`. `PaymentsModule.v5-finalization.test.ts` → **delete** (receiver finalize gone). `NametagMinter.test.ts` → delete/binding-only (NOT `engine.mint`).
- **NEW tests to add** (none exist today): chainPubkey-stability, sphere-api XP-login (Path A keeps XP), anti-bot/bot-rejected (D6). The identity golden-vector already exists (Track A's `identity.test.ts`).

---

## 4. Recommended implementation order (when the stop lifts)

Ordered by value × unblocked-ness. **Define the cross-cutting token-identity helper (§5) first — it gates B1/B2/B5/swap.**

1. **B6 identity (🔴 XP, fully unblocked, A6 shipped).** TDD: characterization test FIRST, then delegate `deriveL3PredicateAddress` with the SHA-256 pre-hash. Highest risk, lowest external dependency.
2. **B1 delete-dead: TokenRecoveryService + BackgroundCommitmentService** (trivial, unblocks ESLint boundary).
3. **B4 nametag retire + PROXY kill** (pure removal; engine recipient contract is frozen) — *after the D4 ruling on public getProxyAddress/mintNametag*.
4. **Cross-cutting: settle the Track-B-local token-identity helper + what `Token.id` becomes** (§5).
5. **B1 PaymentsModule core**: imports/injection → read path → token-identity helper → send (all 3 paths) + receive gut → deletions. *Invoice-payment-through-send blocked on Q2.*
6. **B3 SpendQueue** (after B1/B2 settle the `sdkData`↔blob storage shape).
7. **B5 token-validator** (after migrate-vs-deprecate decision + the domain-Token→SphereToken bridge exists).
8. **B2 Accounting** (after Track A unblocks invoice-mint surface + the Q2 memo decision).
9. **B7 tests** throughout; swap R6 acceptance + new identity/XP/bot tests at the end.

Keep the tree green: v1 stays installed for not-yet-migrated callers; migrate slice-by-slice with tests; delete only when provably dead.

---

## 5. The #1 cross-cutting decision — token identity (T1)

The frozen `SphereToken`/`TokenBlob` expose **no** `tokenId`/`stateHash`. Four surfaces need a token identity, and they must agree on ONE derivation:
- **B1** tombstone/archive/fork/history dedup (`createTokenStateKey` = `tokenId_stateHash`).
- **B2** invoice id (68-char imprint form — a *separate* hash of canonical terms, but same "no engine helper" problem).
- **B5** `spentStateCache` keys + public `SpentTokenInfo.{tokenId,stateHash}`.
- **swap** `validate().invalid[].id` ↔ `accounting.getTokenIdsForInvoice()` must key identically.

**Proposed:** a Track-B-local `tokenIdOf(blob) = SHA-256(blob.token)` helper (precedent: `FakeTokenEngine.idOf` hashes decoded state). **Open:** must it equal the v2 on-chain `TokenId` (genesis-derived, stable across transfers) or just be locally-unique-per-state? Dedup needs the genesis-stable id for "same token across states"; spent-cache needs the per-state id. **These are two different ids** — clarify the exact recipe with Track A before B1. Whatever `Token.id` becomes flows into SpendQueue + swap unchanged.

---

## 6. Questions for Track A (engine surface)

- **Q2 (memo, may BLOCK B2 + invoice-payment-through-send):** how does `SHA-256(invoiceId)` on-chain attribution survive with no memo/data field on `TransferParams`/`MintParams`? (a) add optional `data: Uint8Array` to transfer/mint + a read-back; (b) re-route to transport DM (loses on-chain SMT-verifiable binding); (c) keep in the TXF blob outside the engine.
- **Q-invoice-mint (NEW, BLOCKS B2):** the invoice token (terms-in-`tokenData` + custom tokenType + deterministic salt) has no representation in frozen `MintParams`. Dedicated invoice-mint surface, or terms move off-chain (only an id committed)?
- **Q-token-id (gates §5):** canonical Track-B-local id recipe for dedup vs spent-cache. Genesis-stable id available? `SHA-256(blob.token)` acceptable?
- **Q-storage (Σ2, crosses A5):** does `Token.sdkData` now hold the engine `TokenBlob` (CBOR bytes hex + v + network) or a JSON wrapper? Determines whether the TXF tombstone/archive layer can still parse identity out of stored tokens.
- **Q-facade (B7/R6):** does `deps.payments.validate()` return `Token[]` or `SphereToken[]`, and what stable per-token id does swap read?
- **Q-engine-availability (B3):** when does the `ITokenEngine` instance exist relative to `PaymentsModule`/`SpendPlanner` construction?

## 7. Decisions for the user (D4 public-API rulings)

- `Sphere.getProxyAddress(): string|undefined`, `Sphere.mintNametag(): MintNametagResult`, `TransferRequest.addressMode='proxy'`, `PeerInfo.proxyAddress` — **keep as no-ops/always-undefined (back-compat) or remove (breaking)?**
- `ReceiveOptions.{finalize,timeout,pollInterval,onProgress}` + `ReceiveResult.{finalization,timedOut,...}` — keep as accepted-but-ignored, or remove?
- **B5 `TokenValidator`** — migrate to the engine, or deprecate (it's not in the live flow; live validation is via the oracle)? `AggregatorClient` is a public re-export.
- **`getAddressId` re-base on chainPubkey** — kickoff suggests it; prep **recommends keeping `directAddress`** (Path A keeps it stable; re-base breaks legacy-nametag migration). Confirm.

---

## 8. Sync points
- **Σ0/Σ1 — DONE.** Phase 0 merged; A6 `deriveDirectAddress` + golden vector shipped → **B6 unblocked now.**
- **Σ2 — A2 (mint/transfer) DONE** (real engine + factory present) → swap Fake→real in Payments/Accounting **integration** tests.
- **Σ3 — A3 (split) DONE; A5 (storage→TokenBlob) + A4-int (oracle→v2) land AFTER B migrates callers** (per TRACK-A-STATUS, to keep the tree green) → split + storage e2e on testnet.
- **Σ4 — both green → joint merge gate → cut-over** (remove v1 + alias; flip ESLint strict).
