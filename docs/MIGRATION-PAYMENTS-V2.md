# Migrating to payments-v2 (sphere-sdk 0.14 → the flip release)

> For app builders on sphere-sdk ≤0.13.x. The payments vertical was rebuilt
> from scratch as a wallet-api-only money path (design:
> `docs/PAYMENTS-V2-DESIGN.md`). During 0.14.0-dev.\* it was opt-in
> (`paymentsV2: true`); **the flip release (0.14.x) made it the only path and
> deleted the legacy module.** This guide is the whole migration — a
> worked example is the Sphere frontend's own migration (sphere PR #470:
> +326 −325 across 23 files, rename-shaped).
>
> **Amended for 0.15.0 (#760).** 0.15.0 pins
> `@unicitylabs/state-transition-sdk@3.0.1` and serves the one-release
> deprecations this guide announced: the `sphere.paymentsV2` alias and the
> `paymentsV2` init flag are gone (§0), and the wire break makes §5's
> mixed-version matrix history rather than guidance — read §5 before planning
> any staged rollout.

## 0. THE FLIP RELEASE — what changed at the switch

- **`sphere.payments` IS the v2 facade.** The v1 `PaymentsModule` is deleted;
  the old surface no longer exists to throw. `sphere.paymentsV2` was a
  **deprecated alias** of the same facade for one release; **0.15.0 removed
  it.** One behavioural difference to handle when you drop the alias: it
  returned `null` while no vertical was running, whereas `sphere.payments`
  **throws `NOT_INITIALIZED`** (init in flight, mid address-switch, destroyed).
  Code that probed `sphere.paymentsV2` for nullness must catch instead.
- **The `paymentsV2` init flag is a no-op** at the flip (accepted, deprecated)
  and **is removed in 0.15.0**. Drop it in your migration PR.
- **Init is fail-closed on the wallet-api composition:** pass `walletApi`
  (`{ network, baseUrl, deviceId?, fetchFn?, webSocketFactory?, paymentsV2Transport? }`,
  built by `createWalletApiProviders` from `impl/shared/wallet-api`) or
  `Sphere.init` throws `INVALID_CONFIG` before touching storage.
- `accounting: true` / `swap: true` **throw** typed `INVALID_CONFIG` (the one
  sanctioned refusal fossil — public flags whose silent-ignore would hide that
  invoices/swaps no longer exist). Deliberately **kept through 0.15.0**, unlike
  the `paymentsV2` deprecations above.
- `Sphere.clear` collapses to `{ storage }`; it wipes the whole KV store —
  the payments scoped KV with it — and sweeps orphaned pre-flip
  `sphere-token-storage-*` IndexedDB databases. In 0.15.0 that scoped KV moved
  generation, from `pv2:{network}:{pubkey}:` to `pv2g2:{network}:{pubkey}:`;
  the superseded prefix is cleared automatically the first time the vertical
  composes, so upgrading needs no clear (and `Sphere.clear` is not a substitute
  — it takes the mnemonic too). Renaming IS the migration: see design §6 for
  why a surviving epoch latch across a backend reset is the money-critical case.
- The dir names stay `modules/payments-v2/` / `impl/wallet-api-v2/` and the
  subpath exports stay `./payments-v2` / `./impl/wallet-api-v2` — no import
  churn for subpath consumers.

## 1. Init: one flag (transition) → default (flip)

```ts
const { sphere } = await Sphere.init({
  ...providers,          // wallet-api composition REQUIRED (see §3)
});
sphere.payments.send({ recipient: '@bob', amount: '1000', coinId: 'UCT' });
```

## 2. API map (old → new)

| v1 (`sphere.payments`, ≤0.13) | v2 (`sphere.payments` post-flip) |
|---|---|
| `getAssets(coinId?)` | `assets(coinId?)` |
| `getBalance(coinId?)` | derive from `assets()` (sync balance dropped) |
| `getFiatBalance()` | sum `assets()[].fiatValueUsd` |
| `getTokens(filter?)` | `tokens(filter?)` |
| `getHistory()` | `history({ before?, limit? })` — **paged**; entries keep `timestamp` |
| `send(request)` | `send(request)` — same shape; `addressMode`/`transferMode` gone |
| `mintFungibleToken(hex, amt)` | `mint(hex, amt)` |
| `receive(options?)` | `receive()` — options were already no-ops |
| `sendPaymentRequest(to, {message})` | `requests.create(to, { memo })` |
| `getPaymentRequests()` | `requests.list()` |
| `payPaymentRequest(id)` | `requests.pay(id)` |
| `rejectPaymentRequest(id)` | `requests.decline(id)` — 403/409 now propagate |
| `clearProcessedPaymentRequests()` | `requests.dismissProcessed()` |
| `sync()` / `validate()` | gone — the server is the record; nothing to flush |
| `sphere.walletApiSessionStatus` (getter, deleted at the flip) | `payments.connectionStatus()` — readable at any time; `connection:status` stays the change notification (sphere#473) |
| ~25 further members | gone (zero consumers existed; see design doc §4) |

Events: `transfer:incoming` unchanged. `transfer:confirmed` +
`transfer:delivery_pending` + `transfer:failed` → `transfer:updated`
(`TransferResult`; read `status`/`deliveryPending`).
`split:checkpoint-stuck` / `delivery:undeliverable` / `delivery:deferred` →
`transfer:attention` `{ transferId, code, detail? }`. `sync:*` →
`inventory:updated`. `realtime:status` + `storage:degraded` →
`connection:status` `{ status }`. `payment_request:paid|rejected|expired` →
`payment_request:updated` `{ id, status }`.

Error contract is UNCHANGED and load-bearing: the typed codes
(`CERTIFICATION_UNCONFIRMED`, `SEND_SYNC_PENDING`, the checkpoint trio,
`SEND_PARTIALLY_COMPLETED`, …), `isPossiblyCommittedSendOutcome()`, and
`ProofUnconfirmedError.cause` carrying the raw network error all survive
verbatim. Keep your PENDING_COMMIT handling exactly as it is.

## 3. Composition changes

- **wallet-api is required** for money. `FileTokenStorageProvider` /
  `IndexedDBTokenStorageProvider` and own-storage custody are deleted at the
  flip (spec amendment: wallet-api docs/sdk-changes.md S7, 2026-07-31).
- Keys/mnemonic/identity storage (`StorageProvider`) stays local — unchanged.
- Nostr remains for DMs, group chat, and nametag bindings ONLY. No asset or
  payment-request traffic rides it in v2.
- **Own-storage custody holders**: relocate funds BEFORE upgrading — switch
  the composition to wallet-api custody on your current version and
  send-to-self, so tokens enter server inventory. Upgrading a build that
  holds local-only tokens strands them until you downgrade and relocate.
  This route closes at the 0.15.0 cutover: a 2.x client cannot certify
  anything once the gateway flips, so there is no version left to relocate
  from (§5).

## 4. Deleted at the flip (DONE since 0.14.x)

`modules/accounting` (invoices) and `modules/swap`, the Connect invoice
surface (`sphere_getInvoices`, `sphere_getInvoiceStatus`, the 9 invoice
intents, `invoice:read|write` scopes — Connect protocol stays 2.1; they were
never enabled in any wallet host), own-storage custody (`TokenStorageProvider`
+ both platform providers + `tokenStorage`/`tokensDir` options), the S1
`WalletApiClient` (`./wallet-api` subpath), the Nostr asset/payment-request
rail, and the v1 TXF relic handling. The code is gone.

## 5. Can mixed versions transact? Across 0.15.0, no — it is a flag day

0.15.0 pins `@unicitylabs/state-transition-sdk@3.0.1`. v3 moved every wire
version underneath a token — `Token`, `MintTransaction`, `TransferTransaction`,
`CertificationData` — and made the sparse-Merkle leaf value
`H(transactionHash, referenceTime)` instead of the bare transaction hash.
**Nothing a 2.x client wrote decodes, and nothing a 2.x client writes is
accepted.** The forcing function is not this SDK but the aggregator:
`aggregator-go` main already carries `CertificationDataVersion = 2` with a hard
reject of version 1, so the gateway cutover is a fleet-wide flag day that
nothing can straddle. There is no cross-major interop in either direction, and
no adapter can create one:

| | 0.14.x holder (st-sdk 2.x) | 0.15.0 holder (st-sdk 3.x) |
|---|---|---|
| **0.14.x sender** | works only against the pre-cutover gateway — dead the moment it cuts over | ❌ the deposited blob does not decode |
| **0.15.0 sender** | ❌ the recipient cannot decode the blob; the upgraded gateway would not have certified it anyway | ✅ |

Operationally that means three things. **`wallet-api` bumps in lockstep**: both
repos pin st-sdk exactly, so bumping sphere-sdk alone makes an npm dedupe
impossible and puts two protocol realms in one running system — they cross at
`wallet-api/src/validation/verifier.ts`, which verifies deposited tokens with
the SDK's own trust-base machinery. **A testnet and wallet-api backend reset
accompanies the release**: no balance is expected to survive it, no data
migration is attempted (design §1 non-goals), and the durable client state
moves key generation rather than converting (design §6). **Anything in flight
across the cutover is lost, not queued** — including a split interrupted between
its burn and its mint legs, whose checkpoint no longer decodes and whose burnt
source is unrecoverable (design §5.5, E.4).

Plan the rollout as a cutover, not a staged migration: upgrade wallet-api and
the wallet clients together with the gateway, and treat any wallet left on
0.14.x as offline for money rather than as a degraded peer.

**Dated record — the 0.13 → 0.14 flip (2026-08-05), on the 2.x wire.** The
matrix this section used to carry was true of that flip and is kept only as a
record: every client ≥0.12 ran wallet-api custody, and old (v1-module) and v2
clients shared the same mailbox rail, the same raw `Token.toCBOR()` blobs, the
same predicates, trust base and memo envelope, so they interoperated fully.
Witnessed on deployed staging (testnet2, real transactions) by
`tests/e2e/cross-version-interop.staging.e2e.test.ts`, 4/4 — old-module mint;
old→v2 send of 300 (the 0.13 sender's own resume converged a keep-open, the v2
recipient verified-before-balance, exactly-once); v2→old send of 100 forcing a
real split (the old stack received the split output into its SPENDABLE pool);
an old-module payment request listed, memo-decrypted and paid by the v2 client,
resolving `paid` on the old side — the whole run under an active gateway rate
limiter, so every leg additionally proved keep-open convergence across versions
with no operation ever re-issued and end balances conserved exactly. That suite
was deleted with the P11 test estate (it needed the old module to exist), and
its result says nothing about 2.x ↔ 3.x: both clients in it spoke the same wire
major. In the same era, pre-wallet-api compositions (the Nostr-asset era) were
already unreachable — a v2 send deposits to the recipient's wallet-api mailbox,
which such clients never read; across the 3.x break they are simply gone.

## 6. dApps (Connect): change nothing

The Connect wire contract is preserved by the host adapter: `sphere_getBalance`,
`sphere_getFiatBalance`, `sphere_getHistory` and the old event names keep
working against a v2 host. dApp builders need ONE change: bump
`@unicitylabs/sphere-sdk` to **≥ 0.15.0** — wallet hosts enforce an SDK version
floor at the handshake (`UNSUPPORTED_PROTOCOL_VERSION` with a message naming the
minimum; clients that report no version are rejected as such). The floor MOVED
to `0.15.0-0` with the 3.x bump: the wire is unchanged, but `sphere_getTokens`
hands raw token CBOR across it and a 2.x-line client cannot decode a 3.x token,
so it is already non-functional against a 0.15.x wallet. Invoice-surface
consumers additionally see §4.

**Wallet hosts (not dApps) see one shape change in 0.15.0.** With the
`paymentsV2` alias gone, the `SphereInstance` a `ConnectHost` is constructed
over declares `readonly payments: PaymentsV2` — the old legacy shape
(`getBalance`/`getAssets`/`getFiatBalance`/`getTokens`/`getHistory`) and the
optional `paymentsV2` member are both deleted, and the host reads `payments`
LAZILY per query branch so `sphere_getIdentity` still answers while no vertical
runs. The legacy-host fallbacks are gone with them (dead since the flip):
`sphere_getBalance` and `sphere_getAssets` are now the same call, and
`sphere_getFiatBalance` is summed from `assets()`. Pass a real `Sphere` and
nothing changes; a hand-rolled host object must be updated. The wire a dApp
sees is byte-for-byte what it saw before.
