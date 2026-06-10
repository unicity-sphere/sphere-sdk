# Track B — Kickoff (state-transition v2 migration)
> **Status: HISTORICAL — the v1→v2 cutover completed 2026-06-10 (PRs #479/#480/#481). v1 is removed; see CHANGELOG.md.**

You own **Track B: callers, identity wiring & tests** (Person 2). Phase 0 is merged: the
`ITokenEngine` contract is **frozen** and `FakeTokenEngine` exists, so you can start now —
you do **not** wait for Track A (the real engine) until the integration-test sync points.

- **Branch:** `feat/migrate-state-transition-sdk-track-b`
- **Full plan:** [`STATE-TRANSITION-V2-MIGRATION.md`](./STATE-TRANSITION-V2-MIGRATION.md) — §8 (Track B + file ownership + sync points)
- **Per-file caller details:** [`STATE-TRANSITION-V2-MIGRATION-DETAILED.md`](./STATE-TRANSITION-V2-MIGRATION-DETAILED.md) — Part C

---

## Golden rules

1. **Work against `FakeTokenEngine`** — `tests/unit/token-engine/FakeTokenEngine.ts`. Inject it where callers need an engine. Swap to the real engine only in integration tests at Σ2/Σ3.
2. **Do NOT touch `token-engine/**`** — Track A owns it (the SDK boundary, contract, value codec, network map). If you think the contract needs changing, raise it; don't edit it.
3. **Keep the tree green.** v1 (`@unicitylabs/state-transition-sdk`) stays installed for your not-yet-migrated callers; v2 is engine-only behind the boundary. Run **tests + lint before every push**.
4. **Don't reimplement what exists** — reuse SDK / existing helpers; no copy-paste of logic.

## The contract you call (frozen)

Import from the engine port, never the SDK:
```ts
import type { ITokenEngine, SphereToken, SphereValue, CoinId } from '<rel>/token-engine';
```
Surface (sphere-domain only — `Uint8Array` pubkeys, `string` coin ids, `bigint` amounts):
`getIdentity` · `deriveIdentityAddress(pubkey?)` · `readValue` · `balanceOf` · `mint` · `transfer` · `split` · `verify` · `isSpent` · `encodeToken` · `decodeToken`. Treat `SphereToken.sdkToken` as **opaque**.

## Your tasks (B1–B7)

| # | Task | Notes |
|---|---|---|
| **B1** | `PaymentsModule` → engine | `send()` = sender flow via `engine.transfer`/`engine.split`. **DELETE** `resolveUnconfirmed` / `scheduleResolveUnconfirmed` / `stopResolveUnconfirmedPolling` / `loadPendingV5Tokens` / `InstantSplitProcessor`; **gut** `handleIncomingTransfer` → store-only; **drop** async `ReceiveOptions`. (sender-driven model) |
| **B2** | `AccountingModule` → engine | invoice mint/verify via `engine.mint`/`engine.verify`; `txfToToken` → `TokenBlob` |
| **B3** | `SpendQueue` + `TokenSplitCalculator` | value reads → `engine.balanceOf`/`decodeToken` (no `coins.get`/`fromJSON`); queue/reservation logic unchanged |
| **B4** | Nametag | **α (confirmed by Martti):** retire `NametagMinter`'s on-chain mint; `transport/NostrTransportProvider` **remove `ProxyAddress`**, resolve `@name → chainPubkey` via the transport binding. **Also remove the PROXY fallback in `resolveRecipientAddress`** so no PROXY transfer is ever emitted. |
| **B5** | `token-validator` | `verify`/`isSpent` → `engine` |
| **B6** | Identity wiring (**XP-critical**) | **waits for A6 (Σ1).** `core/Sphere.deriveL3PredicateAddress` → A6 helper (Path A, byte-identical); `getAddressId` re-base on `chainPubkey`; `publishIdentityBinding` keeps `directAddress`; Connect `PublicIdentity`; **preserve the anti-bot gate** |
| **B7** | Tests | rewrite the ~14 SDK-mocking tests to mock the **engine**; add identity/XP-login (existing user keeps XP) + bot-rejected tests |

**B8 = N/A:** Path A decided → **sphere-api is NOT touched** (it's a third-party consumer of the SDK).

## Key decisions already locked

- **α / transport-resolved names** — `@name → chainPubkey` via the transport (Nostr today, any transport). **No on-chain Unicity ID token, no `UnicityIdPredicate`** (Martti: unused whitepaper functionality). Receive is always `SignaturePredicate(pubkey)`.
- **Path A** — keep the byte-identical legacy `DIRECT://` address as the identity key → XP preserved, **sphere-api untouched**.
- **Sender-driven** — sender hands over a finished token; receiver just stores. Delete receiver recovery machinery.
- **`mint()` stays** on the port (issuer/developer token issuance) — separate from nametags.

## Your files (ownership — avoid conflicts)

`modules/payments/**`, `modules/accounting/**`, `modules/swap/**` (facade checks), `validation/token-validator.ts`, `core/Sphere.ts`, `transport/NostrTransportProvider.ts`, `connect/**`, `tests/**` (non-engine).
**Off-limits (Track A):** `token-engine/**`, `oracle/UnicityAggregatorProvider.ts`, `serialization/txf-serializer.ts`, `types/txf.ts`, `impl/**/storage/**`.

## Sync points that affect you

- **Σ1** — Track A ships `A6` (DIRECT:// helper + golden vector) → you start **B6** (XP) then.
- **Σ2** — Track A ships `A2` (mint/transfer) → swap Fake→real engine in Payments/Accounting integration tests.
- **Σ3** — Track A ships `A3`+`A5` (split + storage) → run split + storage e2e on testnet.
- **Σ4** — both green → joint merge gate → cut-over.

## What to tell your Claude (paste this)

> You're on **Track B** of the state-transition v2 migration in `sphere-sdk`, branch
> `feat/migrate-state-transition-sdk-track-b`. Read `docs/TRACK-B-KICKOFF.md`, then
> `docs/STATE-TRANSITION-V2-MIGRATION.md` (§8 Track B) and `…-DETAILED.md` (Part C).
> Route callers (PaymentsModule, AccountingModule, SpendQueue, nametag, token-validator)
> to the **frozen `ITokenEngine` port**, developing + unit-testing against
> `FakeTokenEngine` (`tests/unit/token-engine/FakeTokenEngine.ts`). **Do NOT touch
> `token-engine/**`** (Track A owns it). Keep the tree green; run tests + lint before any
> push. Start with B1 (PaymentsModule). B6 (identity/XP) waits for Track A's A6.
