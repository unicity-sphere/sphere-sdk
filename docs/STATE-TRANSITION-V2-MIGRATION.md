# Migration Plan — State Transition SDK v1.6.1 → v2

**Repository:** `sphere-sdk` · **Branch:** `feat/migrate-state-transition-sdk` (cut from `v0.7.2`)
**Target dependency:** `@unicitylabs/state-transition-sdk@2.0.0-rc.a57c080` (replaces `1.6.1-rc.f37cb85`)
**Status:** Draft for team review · **Owner:** TBD

> This is money/identity code. Correctness, isolation, and continuity of **user identity + Quest XP**
> come before speed. It is **not** an MVP plan. The document is written to be split into independent,
> parallelizable workstreams.
>
> **Scope decision (team):** on testnet we **do NOT preserve token balances/assets** — they reset on v2,
> and that is acceptable. We **DO** preserve **users' Quest XP** and **their Unicity IDs**. Everything in
> this plan is prioritized around that.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Locked Decisions & Open Decisions](#2-locked-decisions--open-decisions)
3. [What changed in v2 (verified)](#3-what-changed-in-v2-verified)
4. [Identity, Auth & Continuity — the heart of this migration](#4-identity-auth--continuity--the-heart-of-this-migration)
5. [Target Architecture — the Token Engine wrapper](#5-target-architecture--the-token-engine-wrapper)
6. [The Contract: `ITokenEngine`](#6-the-contract-itokenengine)
7. [Cross-cutting specifications](#7-cross-cutting-specifications)
8. [Workstreams (parallelizable units of work)](#8-workstreams-parallelizable-units-of-work)
9. [Phasing & dependency graph](#9-phasing--dependency-graph)
10. [Testing strategy & merge gate](#10-testing-strategy--merge-gate)
11. [Rollout & cutover](#11-rollout--cutover)
12. [Risks & open spikes](#12-risks--open-spikes)
13. [Appendix A — Old → New API mapping](#appendix-a--old--new-api-mapping)
14. [Appendix B — File-by-file change inventory](#appendix-b--file-by-file-change-inventory)

---

## 1. Goals & Non-Goals

### Goals
- Replace the legacy token engine (`@unicitylabs/state-transition-sdk@1.6.1`) with v2, behind **one** internal wrapper (anti-corruption layer) that is the **only** importer of the new SDK.
- **Preserve user identity continuity:** existing users keep their **Quest XP** and **Unicity IDs** after the wallet ships v2.
- Keep the **public sphere-sdk API frozen** so downstream consumers (`sphere` incl. its popup wallet host, `sphere-quest-frontend`) keep working unchanged.
- Production-grade: clean architecture, explicit contracts, no spaghetti, no leaking of v2 types outside the wrapper, full tests.

### Non-Goals
- **No token/balance preservation.** Testnet balances reset on v2; this is accepted. No legacy token read, no TXF balance migration, no cross-version P2P, no orphaned-token recovery.
- **No on-chain Unicity ID tokens.** Unicity IDs stay as **Nostr bindings** (name↔pubkey); we do **not** use v2's on-chain `UnicityIdToken`/`UnicityIdPredicate`.
- No new product features — behavior parity (same `send`/`receive`/`invoice` UX, new engine underneath).
- No changes to non-token modules that don't touch the SDK (`communications`, `groupchat`, `market`, `l1`, `price`, `connect` internals) beyond the wrapper boundary + the identity additions in §4.

---

## 2. Locked Decisions & Open Decisions

| # | Topic | Decision |
|---|-------|----------|
| D1 | Token balances / assets | **Reset on v2 (clean start).** Testnet, no real funds. No data migration. |
| D2 | What we preserve | **Quest XP + Unicity IDs.** These drive the whole plan (see §4). |
| D3 | Integration architecture | **Single wrapper / Ports & Adapters.** Rest of sphere-sdk depends on `ITokenEngine`; only `token-engine/` imports the SDK. |
| D4 | Public API | **Frozen** — no breaking changes to the exported surface. |
| D5 | Unicity ID / nametag | **Nostr-binding only** (name↔pubkey). No on-chain `UnicityIdToken`. Receive is always `SignaturePredicate(pubkey)`. |
| D6 | Anti-bot gate | **Preserve.** The Nostr binding resolution at login is the bot filter — it stays. |
| D7 | Rollout | **Build fully on branch → hard test-gate → merge to `main` → bump npm.** |
| D8 | Spec/PR/commit language | **English.** |
| D9 | `chainPubkey` stability | **Verified stable** across v1→v2 (proof in §4.1). It is the identity anchor. |
| **D10** | **Quest user keying (D-IDENTITY)** | **✅ DECIDED — Path A.** Keep the byte-identical legacy `DIRECT://` as the identity key via the ported helper; **sphere-api is NOT touched**; existing XP is safe automatically. Path B (re-key on `chainPubkey`) is **deferred** (a future option, out of scope for this migration). |

### D-IDENTITY — DECIDED: Path A (keep legacy `DIRECT://`)
**Rationale:** since we already build the ported `DIRECT://` helper (the address is a deterministic, reproducible function of `chainPubkey`), keeping the legacy identity address for everyone is the logical, lowest-risk start — XP is preserved for free and the backend is untouched. Full detail in §4.2.

| | **Path A — chosen** | Path B — deferred |
|---|---|---|
| sphere-api change | **None** | Re-key users + change auth lookup |
| existing XP | safe automatically (resolve to same address) | one-time migration of all `userId` refs |
| legacy `DIRECT://` derivation | the identity for all users (old + new) | (would be only a one-time migration bridge) |
| new users get `DIRECT://`? | yes | no |
| precondition | none | DB audit: every user has `chainPubkey` (§4.2) |
| risk | lowest | higher (live XP data migration) |

> Path B remains documented (§4.2) only as a possible future cleanup; it is **not** part of this migration's scope and requires the backend team + the §4.2 DB audit if ever revived.

---

## 3. What changed in v2 (verified)

Verified first-hand against the published tarball + source at `a57c080`. Full reference: team memory `state-transition-sdk-v2`.

- **No fungible value in the SDK.** `Token` exposes only `genesis/transactions/id/type` — no coins/amount. Value is app-defined via `MintTransaction.data` + an app `IPaymentData` (→ §7.1).
- **CBOR only** (`toCBOR`/`fromCBOR`; no `toJSON`/`fromJSON`).
- **No "commitment"/`finalizeTransaction`.** Flow: build `Mint`/`TransferTransaction` → `CertificationData.from*` → `submitCertificationRequest` → `waitInclusionProof` → `toCertifiedTransaction` → `Token.mint`/`token.transfer`.
- **NetworkId + TokenSalt (new in a57c080).** `MintTransaction.create(networkId, recipient, data?, tokenType?, salt?, justification?)`. `TokenId = TokenId.fromSalt(networkId, salt) = SHA256(CBOR[salt, networkId.id])`. `NetworkId.MAINNET=1 / TESTNET=2 / LOCAL=3`.
- **No address layer.** v2 deleted `DirectAddress`/`ProxyAddress`/`AddressScheme`. Only predicates (`SignaturePredicate`/`EncodedPredicate`/`UnicityIdPredicate`/`BurnPredicate`) + `StateId`. A "receive address" = an `EncodedPredicate`.
- **No masked/one-time addresses.** Only `SignaturePredicate(pubkey)`; unlinkability on the aggregator comes from a random `stateMask` per transfer.
- **Real import path:** `@unicitylabs/state-transition-sdk/lib/src/<path>.js` (note `/src/`; no barrel; `main` is broken).
- **`waitInclusionProof(client, trustBase, predicateVerifier, transaction, signal?, interval?)`** — arg order differs from v1.

> **Spike S0 (blocks the Phase 0 contract freeze):** re-verify exact **transfer** and **split** signatures on `a57c080` (mint already re-verified).

---

## 4. Identity, Auth & Continuity — the heart of this migration

Because balances reset (D1), **this section is the real work.** The wallet's identity values split into two groups.

### 4.1 What is STABLE vs what CHANGES

| Value | Derived from | Touches token-SDK? | Changes on v2? |
|-------|--------------|--------------------|----------------|
| **`chainPubkey`** (33-byte secp256k1) | mnemonic → BIP32 → `getPublicKey` (`elliptic`) | **No** | **No — PROVEN** |
| **Nostr `npub`** (= `chainPubkey.slice(2)`) | same key, via `nostr-js-sdk` | No | No |
| **L1 `alpha1…` address** | bech32(hash160(pubkey)) | No | No |
| **Private key / signing** | BIP32 | No | No |
| **L3 `DIRECT://` address** | `UnmaskedPredicateReference(...).toAddress()` (v1 SDK) | **Yes** | **Yes** (different predicate encoding) |

**`chainPubkey` stability — proof (D9).** Two independent layers:
1. **Code:** `core/crypto.ts` has **zero** `state-transition-sdk` imports; `chainPubkey = getPublicKey(privKey) = ec.keyFromPrivate(priv).getPublic(compressed)` via `elliptic`. The SDK imports in `core/Sphere.ts` are used **only** for `directAddress`.
2. **Crypto cross-check:** for a fixed private key, `elliptic` (sphere), `@noble/curves` (v2's underlying lib), and the v2 `SigningService` all produce the **byte-identical** compressed pubkey. So even if `chainPubkey` were ever computed via the v2 SDK, the value is unchanged.

→ **`chainPubkey` is the identity anchor. Everything trustworthy hangs off it.**

### 4.2 Quest XP continuity (D-IDENTITY = Path A, decided)
sphere-api keys the user and **all** progress on `walletAddress = directAddress` (not pubkey): `User.walletAddress`, `PointsLedger.userId`, `Completion.userId`, `AchievementProgress.userId`. Login: sign challenge → recover `chainPubkey` → resolve via Nostr → `directAddress` → lookup.

Since `directAddress` changes under naive v2, a naive migration makes existing users resolve to a new address → silent new account → **XP lost.** **Decision: Path A** (Path B documented below only as a deferred future option):

- **Path A — keep `DIRECT://` stable (recommended, no backend change).** Port the exact v1.6.1 derivation into a frozen helper so the wallet emits the **byte-identical** legacy `DIRECT://` for any pubkey. Existing users resolve unchanged → XP safe. New users also get a `DIRECT://`.
  - **Recipe (port into `token-engine/`, primitives all exist in v2 — `CborSerializer`/`DataHasher`/`HashAlgorithm`/`DataHash.imprint`):**
    ```
    ref      = SHA256( CBOR.array(
                 byteString([0x00]),               // EmbeddedPredicateType.UNMASKED = 0
                 byteString(tokenType.toCBOR()),   // tokenType = UNICITY_TOKEN_TYPE_HEX (f8aa13…7509)
                 textString("secp256k1"),
                 unsignedInteger(0),               // HashAlgorithm.SHA256.id = 0
                 byteString(publicKey) ) )         // 33-byte compressed pubkey
    checksum = SHA256(ref.imprint).slice(0, 4)     // imprint = 2-byte algo-id + 32-byte hash
    DIRECT:// = "DIRECT://" + hex(ref.imprint) + hex(checksum)
    ```
  - **Safest capture:** before removing `1.6.1`, run the *old* derivation for a fixed mnemonic and record the `DIRECT://` as a **golden vector**; the ported helper must reproduce it byte-for-byte.

- **Path B — re-key sphere-api to `chainPubkey` (cleaner, needs backend migration).**
  - **Precondition — DB audit (backend team, on prod):**
    ```js
    db.users.countDocuments({ $or: [ { chainPubkey:{$exists:false} }, { chainPubkey:null }, { chainPubkey:"" } ] })  // → 0 ?
    db.users.aggregate([ { $group:{ _id:"$chainPubkey", n:{$sum:1} } }, { $match:{ n:{$gt:1} } }, { $count:"dups" } ])  // → none ?
    ```
  - Mechanism (NOT "resolve via Nostr" — that's reverse/hijack-risky): re-key from the **stored** `chainPubkey`; for any legacy record missing it, migrate **lazily on next login** — recover pubkey from the signature, deterministically derive the legacy `DIRECT://` (the recipe above), find the old XP record, merge it onto `chainPubkey`.
  - Bonus: identity becomes `chainPubkey` everywhere; but **the Nostr binding check stays** (anti-bot, D6).

### 4.3 Nostr identity binding — extend, don't break
Today: `publishIdentityBinding(chainPubkey, l1Address, directAddress, nametag?)`.

- **Anti-bot gate (D6) — keep.** The binding resolution at login filters bots (no binding → no access). The migration must NOT drop it. *Confirm with the team exactly what the gate checks (binding existence vs. nametag/social match) so we don't weaken it.*
- **Do NOT publish `receivePredicate` in the binding — it's redundant.** `receivePredicate = SignaturePredicate(chainPubkey)` is a *pure function of `chainPubkey`*, which is already the binding key. Any sender derives it itself. The engine builds it on the fly at send time (`deriveReceivePredicate`). The binding stays minimal:
  ```
  chainPubkey → { l1Address, nametag, directAddress? }
  ```
  (Only publish a predicate explicitly **if** the receive predicate ever stops being pubkey-only — e.g. a `UnicityIdPredicate` or a scheme with extra params. Not the case under D5.)
- **New users (SDK+Nostr level):** bind `chainPubkey + l1 + nametag`; **Path A** also binds `directAddress` (identity), **Path B** omits it.
- **`getAddressId()` storage namespacing:** re-base on `chainPubkey` (not `directAddress`) so it's stable regardless of A/B.

### 4.4 Nametag / Unicity ID = Nostr only (D5)
- No on-chain `UnicityIdToken`/`UnicityIdPredicate`; no nametag-token mint (retire `NametagMinter`'s on-chain mint).
- Unicity ID = `name ↔ pubkey` Nostr binding.
- **Send by `@alice`:** resolve Nostr binding → `pubkey` → `SignaturePredicate(pubkey)`. There is **one** receive path (key-based); the receive predicate is always derivable from the pubkey.
- Name-ownership trust = the Nostr binding (+ anti-bot gate), **not** the chain. (v2's on-chain Unicity ID remains available as a future feature if ever wanted.)

### 4.5 Connect & the trust model
- **Connect already exposes `chainPubkey`** as a required, stable field in `PublicIdentity` → identity works by `chainPubkey` unchanged. **No `receivePredicate` field needed** — it's derivable from `chainPubkey`, and token sends go through the wallet's frozen `payments` API (the dApp passes a recipient identifier; the wallet's engine builds the predicate). dApps key identity on `chainPubkey`.
- **Trust model (claim vs proof):** the `PublicIdentity` object is an **overridable claim** — fine for display, not for trust. Trusted identity comes from the **`sign_message` intent** (`sign:request` permission) → `recoverPubkeyFromSignature` → **proven `chainPubkey`**; then **derive** `receivePredicate` from it (never trust the raw string). The future challenge anchors on the signature; its text may replace the legacy `Address:` line with `chainPubkey`. Nametag-based receive needs separate Nostr-binding verification.

---

## 5. Target Architecture — the Token Engine wrapper

```
        sphere-sdk (public API frozen)  ── depends only on the port ──►  token-engine/
        Payments · Accounting · Swap · Sphere · SpendQueue · Validator        │ ITokenEngine (port)
                                                                              │ SphereTokenEngine (wrapper/adapter)
                                                                              │ SpherePaymentData · domain · errors
                                                                              ▼  the ONLY importer of the SDK
                                            @unicitylabs/state-transition-sdk@2.0.0-rc.a57c080 (/lib/src/...)
```
- **`ITokenEngine`** = the port (contract everyone codes against). **`SphereTokenEngine`** = the wrapper that holds the SDK and implements the port. **`FakeTokenEngine`** = in-memory impl for parallel dev + contract tests.
- **Enforced boundary:** ESLint `no-restricted-imports` bans `@unicitylabs/state-transition-sdk` outside `token-engine/` (+ a CI grep catching dynamic `import()`); v2 types never appear outside the wrapper.
- Patterns: Ports & Adapters, Anti-Corruption Layer, Contract-first, DI, typed-error mapping, immutable value objects.

---

## 6. The Contract: `ITokenEngine`

Illustrative; finalized & frozen in **Phase 0**. All types are sphere-domain.

```ts
export interface ITokenEngine {
  // identity / recipients  (NB: v2 has no "address" — recipients are predicates)
  deriveIdentityAddress(identity: EngineIdentity): string;            // stable legacy DIRECT:// (Path A) — frozen recipe; the ONLY real "address"
  deriveReceivePredicate(identity: EngineIdentity): Promise<ReceivePredicate>;  // v2 EncodedPredicate (where tokens are sent)
  // value
  readPaymentData(token: SphereToken): SpherePaymentData;
  balanceOf(token: SphereToken, coinId: CoinId): bigint;
  // mint / transfer / split
  mint(params: MintParams): Promise<SphereToken>;
  buildTransfer(params: TransferParams): Promise<PreparedTransfer>;   // offline
  submitTransfer(prepared: PreparedTransfer): Promise<SubmittedTransfer>;
  finalizeTransfer(submitted: SubmittedTransfer): Promise<SphereToken>;
  split(params: SplitParams): Promise<SplitResult>;
  // verification
  verify(token: SphereToken): Promise<EngineVerifyResult>;
  isSpent(token: SphereToken): Promise<boolean>;
  // serialization
  encodeToken(token: SphereToken): TokenBlob;
  decodeToken(blob: TokenBlob): Promise<SphereToken>;
}
```
Supporting types (Phase 0): `EngineIdentity`, `ReceivePredicate` (wraps v2 `EncodedPredicate`; this is the recipient, *not* an address), `CoinId` (= `AssetId` bytes), `SpherePaymentData`, `SphereToken`, `MintParams`, `TransferParams`, `PreparedTransfer`, `SubmittedTransfer`, `SplitParams`, `SplitResult`, `EngineVerifyResult`, `TokenBlob`, `EngineError`.

> **Naming convention (avoid confusion):** the only thing called an *address* is the legacy `DIRECT://` **identity** address (`deriveIdentityAddress`, Path A). The thing a sender transfers tokens to is a **predicate** (`ReceivePredicate`/`EncodedPredicate`), never an "address" — and it is **derived from `chainPubkey` on demand, not stored/published** anywhere (bindings/Connect carry only `chainPubkey`).

---

## 7. Cross-cutting specifications

### 7.1 Value model — `SpherePaymentData` (implements v2 `IPaymentData`)
- `CoinId` ↔ v2 `AssetId` (define hex encoding once, keep `TokenRegistry` ↔ engine in lock-step).
- Encodes `Map<CoinId, bigint>` into `MintTransaction.data` via `PaymentAssetCollection` of `Asset(assetId, value)` + CBOR (versioned envelope).
- The `decodePaymentData` callback (needed by `TokenSplit.split` + verification) is this codec. Single source of truth for balance/spend/split.
- **Mandatory wiring:** the engine's `MintJustificationVerifierService` MUST register `SplitMintJustificationVerifier(trustBase, predicateVerifier, decodePaymentData)`, else split-minted tokens fail verification.
- **Bound adversarial input:** cap asset counts/sizes when decoding untrusted tokens (mirror old `maxCoinDataEntries`).

### 7.2 Serialization & storage
- New `TokenBlob` = CBOR-hex of v2 `Token` + small sphere metadata header (coinId, amount cache, status, version).
- Rewrite `serialization/txf-serializer.ts` + `types/txf.ts`; bump format version.
- **Old storage is wiped, not migrated** (D1). On load, **reject** unknown/old-format blobs loudly (never silent mis-parse). New format only.

### 7.3 NetworkId & trust base
- `mainnet→MAINNET(1)`, `testnet→TESTNET(2)`, `dev/local→LOCAL(3)`. Thread active `NetworkId` through mint/derive.
- `RootTrustBase.fromJSON(trustBaseJson)` per network via the existing `TrustBaseLoader`. **Confirm the v2 trust-base JSON shape + NetworkId per env with the network team.**

### 7.4 Aggregator / oracle boundary & errors
- Rewrite `oracle/UnicityAggregatorProvider` to build v2 `AggregatorClient`/`StateTransitionClient` and expose them (+ `RootTrustBase`, `PredicateVerifierService`) to the engine only.
- Handle `CertificationStatus` (esp. `STATE_ID_EXISTS` for idempotent re-submit, `INVALID_SHARD`). Map v2 `VerificationResult`/`CertificationStatus`/`InclusionProofVerificationStatus` → `SphereError` in one mapper. Strict `status === OK` checks; fail closed.

### 7.5 Security & key-material checklist (reviewed checkpoint)
- Private keys never leave the engine, never in DTOs; **zero key/salt buffers after signing** (parity with old `AccountingModule`).
- No silent-pass on verification. No silent mis-parse of money/format.
- Dedicated security review gates Track A (A2 transfer / A3 split / A5 serde).

---

## 8. Parallel execution — 2 owners

Structured so **two engineers run in parallel** with one shared seam (the `ITokenEngine` contract) and **disjoint file ownership** (few merge conflicts). Track B codes against `FakeTokenEngine` and is never hard-blocked on Track A.

### Phase 0 — Foundation & contract (BOTH, ~2–3 days, pair on it)
The only step both do together. Output = a frozen contract that decouples the two tracks.
- Swap dep → `2.0.0-rc.a57c080` (imports `@unicitylabs/state-transition-sdk/lib/src/...`); ESLint `no-restricted-imports` + CI grep (dynamic import / v2 type leaks); NetworkId + trust-base plumbing; bring `TestAggregatorClient` into test utils.
- **Spike S0** — verify exact transfer/split signatures on a57c080.
- **Freeze** `ITokenEngine` + all DTOs + `SpherePaymentData` CBOR layout + `TokenBlob` format (Detailed doc Parts A & D).
- Ship `FakeTokenEngine` (deterministic in-memory).
- **Exit:** contract reviewed & merged; `FakeTokenEngine` passes the contract test skeleton → tracks split.

### Track A — **Person 1: Engine, serialization & identity primitive** (the SDK-facing producer)
Owns everything that touches the v2 SDK. Builds behind the contract.
- **A1 Engine core** — `SigningService`/`SignaturePredicate`/`EncodedPredicate`/`StateId`; `SpherePaymentData` codec; `balanceOf`/`readPaymentData`; `TokenSalt`/`NetworkId`/`TokenId.fromSalt`.
- **A2 Mint + transfer (sender-driven)** — `engine.mint` / `engine.transfer` (+ granular `buildTransfer`/`submit`/`awaitProof`/`certifyTransfer`); `verify`/`isSpent`; error map; idempotent re-submit (`STATE_ID_EXISTS`).
- **A3 Split** — `TokenSplit.split` + mandatory `SplitMintJustificationVerifier` wiring; value conservation. Includes **Spike S1** (send-UX: sync-wait vs background-submit job — note: a *sender* job, not the deleted receiver `resolveUnconfirmed`).
- **A4 Oracle boundary** — rewrite `oracle/UnicityAggregatorProvider` to build v2 `AggregatorClient`/`StateTransitionClient`/`RootTrustBase.fromJSON`/verifiers and hand them to `SphereTokenEngine`.
- **A5 Serialization & storage** — `TokenBlob` codec (rewrite `txf-serializer` + `types/txf`); storage providers store/parse new blob keyed by v2 tokenId; **wipe-not-migrate** (loud reject of old format); IPFS merge simplification.
- **A6 Identity primitive (deliver EARLY — small, unblocks B6)** — ported legacy `DIRECT://` helper in `token-engine/identity/` + **golden-vector test** + `chainPubkey`-stability test.
- **A7 Engine tests** — unit (mock aggregator via `TestAggregatorClient`) + contract suite (`FakeTokenEngine` ≡ `SphereTokenEngine`).

### Track B — **Person 2: Integration, identity wiring & tests** (the consumer)
Owns the sphere-side modules + identity wiring. Works against `FakeTokenEngine`, swaps to the real engine per sync points.
- **B1 PaymentsModule → engine** — `send()` = full sender flow via `engine.transfer`/`engine.split`. **DELETE** `resolveUnconfirmed`/`scheduleResolveUnconfirmed`/`stopResolveUnconfirmedPolling`/`loadPendingV5Tokens`/`InstantSplitProcessor`; **gut** `handleIncomingTransfer` → store-only; **drop** async `ReceiveOptions`.
- **B2 AccountingModule → engine** — invoice mint/verify via `engine.mint`/`engine.verify`; `txfToToken` → `TokenBlob`.
- **B3 SpendQueue + TokenSplitCalculator** — value reads → `engine.balanceOf`/`decodeToken` (no `coins.get`/`fromJSON`); queue/reservation logic unchanged.
- **B4 Nametag** — `NametagMinter` retire on-chain mint (Nostr-only); `transport/NostrTransportProvider` remove `ProxyAddress`, resolve `@name → chainPubkey` via binding.
- **B5 token-validator** — `verify`/`isSpent` → `engine`.
- **B6 Identity wiring (XP-critical; uses A6)** — `core/Sphere.deriveL3PredicateAddress` → A6 helper (Path A); `getAddressId` decision; `publishIdentityBinding` keeps `directAddress`; Connect `PublicIdentity`; **preserve & confirm the anti-bot gate**.
- **B7 Tests** — rewrite the ~14 SDK-mocking tests to mock the **engine**; add identity/XP-login (existing user keeps XP) + bot-rejected tests.
- **B8 — N/A (Path A decided):** sphere-api is **not** touched. (The Path B re-key sub-track exists only if Path B is ever revived — out of scope.)

### Sync points
| # | Trigger | Hand-off |
|---|---------|----------|
| Σ0 | Phase 0 merged | contract + `FakeTokenEngine` frozen → tracks start |
| Σ1 | **A6** done (early) | DIRECT:// helper + golden vector → B starts **B6** (XP-critical) immediately |
| Σ2 | **A2** done | B swaps Fake→real engine in PaymentsModule/Accounting integration tests |
| Σ3 | **A3 + A5** done | B runs split + storage e2e on testnet |
| Σ4 | both green | joint **merge gate** (§10) → cutover (§11) |

### File ownership (avoid merge conflicts)
| Owner | Files |
|---|---|
| **Person 1 (A)** | `token-engine/**`, `oracle/UnicityAggregatorProvider.ts`, `serialization/txf-serializer.ts`, `types/txf.ts`, `impl/**/storage/**`, `impl/shared/ipfs/**` |
| **Person 2 (B)** | `modules/payments/**`, `modules/accounting/**`, `modules/swap/**` (facade checks), `validation/token-validator.ts`, `core/Sphere.ts`, `transport/NostrTransportProvider.ts`, `connect/**`, `tests/**` (non-engine) |
| **Shared (Phase 0 only, then stable)** | `token-engine/ITokenEngine.ts` + DTOs, `constants.ts` (NetworkId), `package.json`, ESLint config |

### Notes
- **No hard block:** B implements all caller code against `FakeTokenEngine`; only *integration tests* need the real engine (Σ2/Σ3).
- **Critical ordering:** A6 (identity primitive) is small — front-load it so B6 (XP) isn't late.
- **Rough balance:** A = deep but bounded (engine + serde + oracle + 1 helper); B = broad but mostly mechanical (route callers to engine) + identity wiring + tests.
- **Pairing moments:** Phase 0 (contract), Σ1 (golden vector), Σ4 (gate).

---

## 9. Timeline (2-track)

```
Week 1   [BOTH]  Phase 0 — dep swap, boundary, Spike S0, freeze ITokenEngine + DTOs + TokenBlob, FakeTokenEngine
            │
            ├──► [P1·Track A]  A1 engine core → A6 DIRECT:// helper(early) ─Σ1─► A2 mint+transfer → A4 oracle → A5 serde/storage → A3 split(+S1) → A7 engine tests
            │                                                         └Σ2─► (real engine to B)        └Σ3─►
            └──► [P2·Track B]  B1 Payments(+deletions) ‖ B2 Accounting ‖ B3 SpendQueue/Calc ‖ B4 nametag ‖ B5 validator   (all vs FakeTokenEngine)
                               └Σ1─► B6 identity wiring (XP)            B7 tests ─────────────────────────────────────────►
Final    [BOTH]  Σ4 — merge gate (§10) → cutover (§11)
```
- **Critical path:** Phase 0 → A2 (mint/transfer) → B integration → merge gate.
- **XP path (must not slip):** A6 → B6 → identity/XP-login test (gate item).
- Person 2 can start B1–B5 immediately after Phase 0 (against Fake), so both tracks run full-throttle from week 1.

---

## 10. Testing strategy & merge gate

**Levels:** unit (aggregator mocked) · contract (`ITokenEngine` suite vs both `Fake` and `Sphere` engines) · property (split conservation, payment-data/serialization round-trip) · e2e (testnet) · **identity (golden-vector `DIRECT://`, `chainPubkey` stability, sphere-api login keeps XP, bot rejected)** · downstream smoke (`sphere` popup builds & boots).

**Merge gate (all required):** `typecheck` + `lint` (incl. no-SDK-import) clean · `test:run` green · `test:e2e` green · **identity/XP test green** · zero SDK imports outside `token-engine/` · public API snapshot unchanged · two reviewers on A3 (split), A5 (serialization), and B6 (identity).

---

## 11. Rollout & cutover

Per D7: build fully on branch → pass the gate → merge → bump npm. The wrapper makes an optional internal feature-flag trivial if a staged rollout is ever wanted. Coordinate the npm bump with `sphere` (popup), `sphere-quest-frontend`, `sphere-api` (no backend change needed under Path A — they re-pin and smoke). 

---

## 12. Risks & open spikes

| ID | Risk / unknown | Mitigation |
|----|----------------|------------|
| **R0** | 🔴 **Existing users lose Quest XP** (sphere-api keys on `directAddress`, which is token-SDK-derived) | **Resolved by Path A (decided):** freeze the legacy `DIRECT://` derivation in a ported helper + golden-vector test; sphere-api untouched. XP-login test in the merge gate. |
| **R1** | Anti-bot binding gate weakened by the migration | Preserve the Nostr binding + its login resolution (D6); confirm exactly what it checks before touching it. |
| S0 | transfer/split sigs on a57c080 not re-verified | Blocking task in Phase 0. |
| S1 | v2 send-UX latency (sync-wait vs background-send) | Spike in A3 (Track A); decide UX + measure. |
| R2 | v2 trust-base JSON shape / NetworkId per env unconfirmed | Confirm with network team in Phase 0; e2e validates. |
| R3 | `CoinId` ↔ `AssetId` continuity (registry vs engine) | Define encoding once (§7.1); property tests. |
| R4 | `waitInclusionProof` default timeout (10s) vs legacy (~60s) | Make timeout/interval engine config; benchmark in A7/B7 tests. |
| R5 | Split-minted tokens fail verify if `SplitMintJustificationVerifier` not registered | Mandatory wiring (§7.1); verify-split test. |
| R6 | `swap` facade drift (`payments.validate`, `accounting.getTokenIdsForInvoice`) | Keep signatures; acceptance test that swap flows still pass. |

---

## Appendix A — Old → New API mapping

| Legacy (v1.6.1) | v2 (a57c080) | Note |
|---|---|---|
| `Token.coins.get` / `CoinId` / `TokenCoinData` | **none** — `SpherePaymentData` (`Asset`/`AssetId`/`PaymentAssetCollection`) | value app-defined |
| `TransferCommitment.create` | `TransferTransaction.create` + `CertificationData.fromTransaction` + `submitCertificationRequest` | commitment split |
| `MintCommitment`/`MintTransactionData` | `MintTransaction.create(networkId, recipient, data?, tokenType?, salt?, justification?)` + `CertificationData.fromMintTransaction` | param order changed; tokenId derived from salt+networkId |
| `TokenId.fromNameTag` / `ProxyAddress` / nametag-token | **Nostr binding** (name↔pubkey) → `SignaturePredicate(pubkey)` | D5: no on-chain Unicity ID token |
| `UnmaskedPredicateReference` / `DirectAddress` | `SignaturePredicate`/`EncodedPredicate` (receive) **+ ported legacy `DIRECT://` helper** (identity) | identity address decoupled from receive address |
| `StateTransitionClient.submit*Commitment` / `finalizeTransaction` | `submitCertificationRequest` + poll `getInclusionProof(StateId.fromTransaction)` → `toCertifiedTransaction` → `token.transfer` | no finalize |
| `waitInclusionProof(trustBase, client, commitment)` | `waitInclusionProof(client, trustBase, predicateVerifier, transaction, …)` | arg order changed |
| `Token.toJSON/fromJSON` | `Token.toCBOR/fromCBOR` | storage format change |
| `TokenSplitBuilder` | `TokenSplit.split(token, decodePaymentData, splitTokens)` | single call |

## Appendix B — File-by-file change inventory

**New `token-engine/`** (only SDK importer): `ITokenEngine`, `SphereTokenEngine`, `FakeTokenEngine`, `SpherePaymentData`, `domain/*`, `serialization/*`, `errors/*`, **`identity/legacy-direct-address.ts`** (ported recipe).

**Rewrite (touch the SDK / identity today)** — owner in brackets (P1=Track A, P2=Track B), full per-file spec in the Detailed doc Part C:
- **[P1]** `oracle/UnicityAggregatorProvider.ts` (A4) · `serialization/txf-serializer.ts` + `types/txf.ts` (A5) · `impl/**/storage/**` + `impl/shared/ipfs/**` (A5).
- **[P2]** `modules/payments/*` incl. Instant/Token split executors (B1; **delete** `InstantSplitProcessor` + receiver machinery) · `modules/payments/NametagMinter.ts` → Nostr-only (B4) · `modules/accounting/AccountingModule.ts` (B2) · `modules/payments/SpendQueue.ts` / `TokenSplitCalculator.ts` (B3) · `validation/token-validator.ts` (B5) · `core/Sphere.ts` identity derivation (B6) · `transport/NostrTransportProvider.ts` nametag resolve (B4/B6) · `connect/host/ConnectHost.ts` + `connect/protocol.ts` `PublicIdentity` (B6).

**Tests to rewrite (mock the engine):** AccountingModule ×7, PaymentsModule ×5, TokenSplitCalculator, NametagMinter. **+ new:** identity golden-vector, chainPubkey-stability, sphere-api XP-login.

**Untouched:** `modules/swap/*`, `modules/communications/*`, `modules/groupchat/*`, `modules/market/*`, `l1/*`, `price/*`, `registry/*`, `storage/*` interfaces.
