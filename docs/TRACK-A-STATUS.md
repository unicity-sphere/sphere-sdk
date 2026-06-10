# Track A — Status (for Track B)
> **Status: HISTORICAL — the v1→v2 cutover completed 2026-06-10 (PRs #479/#480/#481). v1 is removed; see CHANGELOG.md.**

**The v2 token engine is ready to consume.** The full sender-driven engine over
state-transition v2 is implemented, twice adversarially reviewed, and proven to
satisfy the same behavioural contract as `FakeTokenEngine` against a real
aggregator. Track B can start swapping `FakeTokenEngine` → the real engine.

Branch: `feat/migrate-state-transition-sdk-track-a` (7 commits, 49 token-engine tests green).

---

## What's done (safe, standalone — no live v1 code touched)

| | |
|---|---|
| **A6** | `deriveDirectAddress(pubkey)` — legacy `DIRECT://` (Path A), golden-locked byte-for-byte (XP-safe) |
| **A1+A2** | engine core: mint / transfer / readValue / balanceOf / verify / encodeToken / decodeToken / getIdentity / deriveIdentityAddress |
| **A3** | `split` (burn + per-output mint via `SplitMintJustification`) |
| **isSpent + `implements ITokenEngine`** | real engine passes the full `engine-contract` suite (same as the Fake) |
| **A4** | `createSphereTokenEngine(config)` factory |

All on the v2 SDK; every signature verified against source; the engine only
orchestrates (build → submit → wait-proof → certify → realize).

## How to consume it

```ts
import {
  createSphereTokenEngine,   // (config) => Promise<ITokenEngine>
  deriveDirectAddress,       // (pubkey) => Promise<string>  — for B6
  type ITokenEngine,
} from '<rel>/token-engine';
```

**Port (sphere-domain only):** `getIdentity()` · `deriveIdentityAddress(pubkey?): Promise<string>` ·
`readValue(token)` · `balanceOf(token, coinId)` · `mint(params, opts?)` · `transfer(params, opts?)` ·
`split(params, opts?)` · `verify(token, opts?)` · `isSpent(token, opts?)` · `encodeToken(token)` ·
`decodeToken(blob)`. `SphereToken.sdkToken` is an **opaque** handle.

**For your unit tests** keep using `FakeTokenEngine`
(`tests/unit/token-engine/FakeTokenEngine.ts`). The real engine and the Fake are
proven equivalent by `tests/unit/token-engine/engine-contract.ts`
(`runEngineContract`) — run that suite against any engine you inject.

**Fake → real swap (integration tests, Σ2/Σ3):** build the real engine with
`createSphereTokenEngine({ network, aggregatorUrl, privateKey, trustBaseJson })`.

## Engine invariants Track B should rely on

- **Recipients are always `SignaturePredicate(chainPubkey)`** — resolve `@name → chainPubkey`
  via the transport, then pass `recipientPubkey`. No `UnicityIdPredicate` (the aggregator
  doesn't support it; confirmed by Martti).
- **`deriveIdentityAddress` is async** (`Promise<string>`) — the legacy derivation hashes via the
  SDK. `core/Sphere.deriveL3PredicateAddress` is already async, so B6 just delegates to
  `deriveDirectAddress` (one shared helper, golden-locked).
- **transfer/split require the engine to OWN the source** (it fails fast otherwise).
- **`verify` = structural validity** (a spent token is still well-formed); **`isSpent` = spent-status.** Don't conflate.
- Pubkeys must be valid compressed secp256k1; coin ids must be even-length lowercase hex; amounts non-negative — the engine rejects otherwise.

## Pending — coupled to YOUR migration (keep the tree green)

`A5` (rewrite `serialization/txf-serializer` + storage to `TokenBlob`) and `A4-int`
(rewrite `oracle/UnicityAggregatorProvider` to v2) **rewrite live v1 code that your
not-yet-migrated callers still use**. Doing them before B1–B5 migrate would break
the tree. Sequence (Σ2/Σ3): **B migrates callers onto the engine first → then A5/A4-int
land.** Until then the v1 serde/oracle stay as-is and the tree is green.

## What to tell your Claude (paste)

> The v2 token engine (Track A) is ready. Import `createSphereTokenEngine` and the
> `ITokenEngine` port from `token-engine`. Migrate callers (PaymentsModule, etc.) to the
> port, unit-testing against `FakeTokenEngine`; the real engine passes the same
> `engine-contract` suite. Recipients are always `SignaturePredicate(chainPubkey)` —
> resolve `@name → chainPubkey` via transport. `deriveIdentityAddress` is async; B6
> delegates `core/Sphere.deriveL3PredicateAddress` to `deriveDirectAddress`. Do NOT rewrite
> `txf-serializer`/`oracle` yet (Track A's A5/A4-int, after your callers migrate).
