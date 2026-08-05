# Migrating to payments-v2 (sphere-sdk 0.14 → the flip release)

> For app builders on sphere-sdk ≤0.13.x. The payments vertical was rebuilt
> from scratch as a wallet-api-only money path (design:
> `docs/PAYMENTS-V2-DESIGN.md`). During 0.14.0-dev.\* it was opt-in
> (`paymentsV2: true`); **the flip release (this version) makes it the only
> path and deletes the legacy module.** This guide is the whole migration — a
> worked example is the Sphere frontend's own migration (sphere PR #470:
> +326 −325 across 23 files, rename-shaped).

## 0. THE FLIP RELEASE — what changed at the switch

- **`sphere.payments` IS the v2 facade.** The v1 `PaymentsModule` is deleted;
  the old surface no longer exists to throw. `sphere.paymentsV2` remains as a
  **deprecated alias** of the same facade for one release — new code uses
  `sphere.payments`.
- **The `paymentsV2` init flag is a no-op** (accepted, deprecated, removed
  next release). Drop it in your migration PR.
- **Init is fail-closed on the wallet-api composition:** pass `walletApi`
  (`{ network, baseUrl, deviceId?, fetchFn?, webSocketFactory?, paymentsV2Transport? }`,
  built by `createWalletApiProviders` from `impl/shared/wallet-api`) or
  `Sphere.init` throws `INVALID_CONFIG` before touching storage.
- `accounting: true` / `swap: true` **throw** typed `INVALID_CONFIG` (the one
  sanctioned refusal fossil — public flags whose silent-ignore would hide that
  invoices/swaps no longer exist). Scheduled for deletion after one release.
- `Sphere.clear` collapses to `{ storage }`; it wipes the `pv2:*` scoped KV
  with the KV store and sweeps orphaned pre-flip `sphere-token-storage-*`
  IndexedDB databases.
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

## 4. Deleted at the flip (DONE in this release)

`modules/accounting` (invoices) and `modules/swap`, the Connect invoice
surface (`sphere_getInvoices`, `sphere_getInvoiceStatus`, the 9 invoice
intents, `invoice:read|write` scopes — Connect protocol stays 2.1; they were
never enabled in any wallet host), own-storage custody (`TokenStorageProvider`
+ both platform providers + `tokenStorage`/`tokensDir` options), the S1
`WalletApiClient` (`./wallet-api` subpath), the Nostr asset/payment-request
rail, and the v1 TXF relic handling. The code is gone.

## 5. Can mixed versions transact?

The fleet reality this was tested against: every client ≥0.12 runs wallet-api
custody. Old (v1-module) and new (v2) clients share the same mailbox rail,
the same raw `Token.toCBOR()` wire blobs, the same predicates, trust base,
and memo envelope — so they interoperate fully:

| | old recipient | v2 recipient |
|---|---|---|
| **old sender** | ✅ (status quo) | ✅ witnessed live |
| **v2 sender** | ✅ witnessed live (incl. a split output) | ✅ (the v2 matrix) |

Witnessed on deployed staging (testnet2, real transactions, 2026-08-05):
`tests/e2e/cross-version-interop.staging.e2e.test.ts`, 4/4 — old-module mint;
old→v2 send of 300 (the 0.13 sender's own resume converged a keep-open, the
v2 recipient verified-before-balance, exactly-once); v2→old send of 100
forcing a real split (the old stack received the split output and it entered
its SPENDABLE pool); an old-module payment request listed, memo-decrypted,
and paid by the v2 client, resolving `paid` on the old side. The entire run
executed under an active gateway rate limiter, so every leg additionally
proved keep-open convergence across versions — no operation was ever
re-issued, and end balances conserved exactly.

Pre-wallet-api compositions (Nostr-asset era) are NOT reachable from v2: a
v2 send deposits to the recipient's wallet-api mailbox, which such clients
never read. The funds are not lost — the entry waits, blob retained, and
arrives when that user upgrades — but they do not arrive before then.

## 6. dApps (Connect): change nothing

The Connect wire contract is preserved by the host adapter: `sphere_getBalance`,
`sphere_getFiatBalance`, `sphere_getHistory` and the old event names keep
working against a v2 host. dApp builders need no changes (except invoice
surface consumers — see §4).
