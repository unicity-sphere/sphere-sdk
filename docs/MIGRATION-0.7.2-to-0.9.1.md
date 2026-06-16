# Migrating Sphere bots: `sphere-sdk` 0.7.2 → 0.9.1-dev

A practical, bot-author–focused guide for moving a Node.js bot from **0.7.2** (the Nostr-relay / IPFS asset path) to the **0.9.1-dev** line (the **wallet-api** "thin wallet" path on **testnet2**).

> **Status:** 0.9.1 is still on `-dev.x`. Pin a specific `0.9.1-dev.N` (the integration uses the `2.0.0-rc` state-transition SDK line; testnet2 `networkId = 4`). The final `0.9.1` ships once the wallet-api work stabilizes and merges.

---

## 0. Read this first — what this migration actually is

You are crossing **two unrelated breaking boundaries at once**, plus a **network cutover**:

1. **`0.9.0` — the state-transition v1 → v2 cutover.** The v1 engine is *deleted*. A v2 token engine becomes mandatory for any money movement, incoming transfers are cryptographically verified before they credit a balance, PROXY addressing and on-chain nametag *minting* are retired (identity is now **`chainPubkey`-centric**), and `network` becomes a **required, fail-loud** parameter. `testnet` is repointed to **testnet2**.
2. **`0.9.1-dev` — the wallet-api program.** Asset transfer/receipt stop riding the Nostr relay and go through a **wallet-api mailbox** (deposit → claim). Payment requests move to REST. Storage can be a thin/lazy server-backed inventory. Composition is **fail-closed**.

> ⚠️ **Skip `0.8.0`.** `0.8.0` added a "UXF" transfer protocol (`importInclusionProof`, multi-asset `additionalAssets` send, instant-split events, …) that was **largely removed again in `0.9.0`**. If you read the `0.8.0` changelog, do **not** migrate toward those APIs — they are a dead end.

### What carries over vs. what does **not** (the testnet → testnet2 reality)

This is a **testnet → testnet2 cutover**, so:

| | Carries over? | Why |
|---|---|---|
| **Seed / keys / `chainPubkey`** | ✅ Yes | Same mnemonic → same identity. |
| **Nostr bindings** — nametag ↔ pubkey, DM history, group-chat membership | ✅ Yes | They live on Nostr, not on-chain. Your bot keeps its `@name` and its conversations. |
| **On-chain assets / token holdings** | ❌ **No** | They live on the old testnet. On testnet2 the wallet starts **empty**. (v1 holdings are frozen display-only by design — there is *no* migration path, and that's intentional.) |
| **Unicity ID token** (the on-chain side of a nametag) | 🔁 Re-minted | It re-mints automatically on first load — deterministic per `(name, key)`. The **Nostr binding** is what persists. |

> **There is no "port your tokens" step.** Don't write one. The flow is: re-establish identity → confirm the nametag binding still resolves → **re-fund from zero via self-mint** → adopt the new send/receive/payment flows.

### The good news

Your **call sites barely change.** `sphere.payments.send/receive/getBalance`, `sphere.registerNametag/resolve`, and the payment-request verbs (`sendPaymentRequest`/`payPaymentRequest`/`rejectPaymentRequest`) keep their names **and** signatures. ~95 % of the work is in the **bootstrap** (wiring the v2 engine + wallet-api compose) and deleting a **short list of removed APIs**.

---

## 1. Prerequisites & environment

| Requirement | 0.7.2 | 0.9.1-dev |
|---|---|---|
| **Node** | — | **≥ 22** (the v2 SDK requires it; on Node < 22 inject a `WebSocket` factory) |
| **`network`** | optional (silently defaulted) | **required** — `Sphere.init` / `createNodeProviders` throw `INVALID_CONFIG` if missing. Use `'testnet2'` (`'testnet'` is now an alias for it). |
| **Aggregator API key** | hardcoded default | must be **injected** (`oracle.apiKey`). testnet2 has a public default key, but pass yours explicitly. |
| **Wallet-api URL** | n/a | `WALLET_API_URL` — the testnet2 wallet-api base URL (currently `https://wallet-api.staging.unicity.network`). **Must be `https` off-loopback** (enforced at client construction). |
| **`deviceId`** | n/a | a **stable, persisted** id per bot/device — it holds the rotating refresh token, so a fresh value re-challenges every run. |
| **Aggregator + trustbase** | aggregator only | both still required (the engine does state transitions client-side): `AGGREGATOR_URL`, `TRUSTBASE_URL` (declares `networkId`; testnet2 = **4**). testnet2 defaults are baked in. |

Example `.env` for a testnet2 bot:

```dotenv
NETWORK=testnet2
WALLET_API_URL=https://wallet-api.staging.unicity.network   # the testnet2 wallet-api deployment (note: 'staging' host, not 'testnet2')
WALLET_API_DEVICE_ID=bot-prod-1                              # STABLE; persists the refresh token
AGGREGATOR_KEY=sk_...                                        # aggregator/gateway API key
# Optional overrides — testnet2 defaults are built in:
# AGGREGATOR_URL=https://gateway.testnet2.unicity.network
# TRUSTBASE_URL=https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/bft-trustbase.testnet2.json
```

---

## 2. The bootstrap — BEFORE → AFTER (the one big change)

### BEFORE (0.7.2) — Nostr + IPFS

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({
  network: 'testnet',          // was optional
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
});

const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,                // storage, tokenStorage, transport(Nostr), oracle, l1
  autoGenerate: true,
});
```

### AFTER (0.9.1-dev) — wallet-api full preset

The base bundle still comes from `createNodeProviders` (it keeps the **Nostr transport** for messaging / nametag publishing, the oracle, and storage). You then **wrap it** with `createWalletApiProviders`, which composes **one** `WalletApiClient` and returns `{ ...base, tokenStorage, delivery, walletApi }`. Spread all of it into `Sphere.init`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import WebSocket from 'ws'; // only needed on Node < 22 (Node ≥ 22 has a global WebSocket)

// 1. Base bundle: Nostr transport (messaging/nametag), oracle (aggregator + trustbase), storage.
//    `network` is now REQUIRED; the aggregator apiKey must be injected.
const base = createNodeProviders({
  network: 'testnet2',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  oracle: { apiKey: process.env.AGGREGATOR_KEY },
});

// 2. wallet-api FULL preset: server keeps inventory custody; mailbox delivery (custody 'inventory').
const providers = createWalletApiProviders(base, {
  baseUrl: process.env.WALLET_API_URL!,        // https off-loopback (enforced)
  network: 'testnet2',                         // required end-to-end
  deviceId: process.env.WALLET_API_DEVICE_ID,  // STABLE per device (persists the refresh token)
  webSocketFactory: (url) => new WebSocket(url) as any, // §9 wake socket on Node < 22
  // stateStore defaults to base.storage (refresh token / cursors / seen-set live there)
});

// 3. Sphere.init accepts `delivery` + `walletApi` directly alongside the base providers.
//    The v2 token engine is built internally from the oracle config (aggregator + trustbase + apiKey).
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,                // storage, transport(Nostr), oracle, tokenStorage, delivery, walletApi
  autoGenerate: true,
});
if (created && generatedMnemonic) console.log('SAVE THIS MNEMONIC:', generatedMnemonic);
```

**Wiring facts that bite if you miss them:**

- **Fail-closed.** Passing wallet-api custody artifacts (thin storage, or `custody:'inventory'` delivery) **without** the `walletApi` client throws `INVALID_CONFIG`. Always pass all three from the preset — don't half-wire.
- **Sign-in is automatic.** `Sphere.init` runs the wallet-api sign-in (challenge → verify → JWT) and resumes open intents for you via `startWalletApiSession`. You don't call `signIn()` yourself unless you wire the client raw.
- **Two presets:**
  - `createWalletApiProviders` — **server-custody** (thin/lazy inventory served by wallet-api; `custody:'inventory'`). Best default for a bot.
  - `createOwnStorageWalletApiProviders` — **app keeps token custody** in its own storage; wallet-api is used **only as the delivery rail** (`custody:'external'`, every claim writes zero server inventory).
- The token engine isn't in the preset config — `Sphere.init` builds it from the oracle (aggregator URL + trustbase + apiKey). If you instead drive `PaymentsModule` directly (advanced), build the engine yourself with `createSphereTokenEngine({ aggregatorUrl, trustBaseJson, apiKey, privateKey })` from `@unicitylabs/sphere-sdk/token-engine` and pass it as `deps.tokenEngine` — see `tests/harness/support/harness-wallet.ts` for the canonical raw wiring.

---

## 3. The new operational model (internalize this)

1. **Identity = `chainPubkey` + a per-owner JWT.** Auth is challenge → verify: the client signs a server challenge with the spend key and gets a JWT + a rotating refresh token (persisted in `stateStore`, keyed per `(network, chainPubkey, deviceId)`). All automatic.
2. **A transfer = client-side state transition + a mailbox deposit.** Your engine does the certified state transition locally against the aggregator (the **backend never calls the aggregator**), producing a finished token blob; the SDK then uploads it and `POST /v1/mailbox` deposits it to the **recipient's chain pubkey**.
3. **Receive is pull, not push.** The recipient pulls `GET /v1/mailbox?since=<seq>`, **verifies the blob bytes locally** (re-derives `tokenId`/`stateHash`, never trusts the backend), then claims it. A WebSocket "wake" is only a nudge — correctness comes from the pull. **Your bot must run `receive()` (or let the background pump run).** Nothing lands by push.
4. **Inventory/balances are served by wallet-api** (not IPFS/relay) in the full preset.
5. **Payment requests go over REST** (`POST /v1/payment-requests`), discovered by polling a gap-free `seq` cursor.
6. **Messaging, group chat, and nametag *publishing* still ride Nostr.** Only assets/payments moved to wallet-api.

---

## 4. Step-by-step API changes

### 4.1 Identity & addressing — drop PROXY

- `Sphere.getProxyAddress()` → **removed.** Use `sphere.identity.directAddress` (or `sphere.resolve('@name')`).
- `AddressMode` lost `'proxy'` (now `'auto' | 'direct'`). Remove any `addressMode: 'proxy'`.
- **Send now gates on the recipient's published `chainPubkey`.** A recipient with no published chain pubkey is unsendable — handle `INVALID_RECIPIENT`.
- `FullIdentity` is **unchanged**: `{ chainPubkey, l1Address, directAddress?, ipnsName?, nametag?, privateKey }`. The pubkey field is `chainPubkey` (never `pubkey`/`signingPubkey`); L1 is `l1Address`; L3 is `directAddress`.

### 4.2 Sending

```typescript
// Unchanged call — now requires the v2 engine (wired automatically via the bootstrap).
const result = await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId: '<lowercase-hex-coinId>' });
```
- `payments.sendInstant(...)` → **removed.** Use `send(...)` (split is internal).
- `coinId` must be **lowercase hex**.
- Amounts are **decimal strings** on the wire ⇄ `bigint` in types. Never use JS numbers.
- `send()` throws (`AGGREGATOR_ERROR`) if no token engine is wired.

### 4.3 Receiving — pull, and no more "finalize"

```typescript
// Run this on a schedule (or rely on the wake-driven background pump).
const { transfers } = await sphere.payments.receive(undefined, (t) => {
  const who = (t as any).senderNametag ?? t.senderPubkey; // nametag rides the encrypted memo — see 4.5
  console.log(`received from ${who}: ${t.tokens.length} token(s)`);
});
// or, low-level: await sphere.payments.pumpIncomingDeliveries();
```
- `payments.resolveUnconfirmed()` and **all finalization machinery** → **removed.** v2 tokens arrive **finished and verified**; there is no finalization phase.
- `ReceiveOptions` (`finalize`/`timeout`/`pollInterval`) are **ignored no-ops**; `ReceiveResult` is trimmed to `{ transfers }` (no `finalization`/`timedOut`).
- Incoming transfers are **verified + ownership-checked** before crediting; a bad one is rejected and emits **`transfer:invalid`** — subscribe to it.

### 4.4 Balance / inventory / history — unchanged

```typescript
const assets = sphere.payments.getBalance();        // Asset[] (one per coin), synchronous
const withFiat = await sphere.payments.getAssets();
const tokens = sphere.payments.getTokens();
const history = sphere.payments.getHistory();
```
In the full preset the numbers come from `GET /v1/balances` / `GET /v1/inventory` (server inventory).

### 4.5 Nametags / Unicity ID — stop minting on-chain

- `Sphere.mintNametag()` and `PaymentsModule.mintNametag()` / `isNametagAvailable()` → **removed.**
- Use `sphere.registerNametag('mybot')` — it publishes the **Nostr binding** and best-effort mints a v2 Unicity ID token. `sphere.isNametagAvailable(name)` still exists on `Sphere`.
- **The counterparty nametag now rides the *encrypted delivery memo*** (recipient-ECDH), so for incoming transfers you generally **don't** need a `resolve()` reverse-lookup — `t.senderNametag` is already there.
- **Bot rule:** set a canonical nametag, or your outgoing transfers/requests render a raw pubkey instead of `@name`. (Since your Nostr binding persisted across the cutover, your existing `@name` should still resolve once the bot re-registers/loads on testnet2.)

### 4.6 Payment requests — REST + two cursor families

```typescript
// Requester:
await sphere.payments.sendPaymentRequest('@bob', { amount: '500000', coinId: '<hex>', message: 'invoice #7' });
const mine = sphere.payments.getOutgoingPaymentRequests();

// Payer (poll the incoming seq stream, then act):
await sphere.payments.syncPaymentRequests();                         // drains the §16 feed
const incoming = sphere.payments.getPaymentRequests({ status: 'pending' });
await sphere.payments.payPaymentRequest(incoming[0].id);            // fulfils + POSTs {paid, transferId}
// or: await sphere.payments.rejectPaymentRequest(incoming[0].id);  // server-confirmed before the local flip
```
- Verb names/signatures are **unchanged**; they route to wallet-api when the port is present.
- `acceptPaymentRequest` is **local UI state only** (the backend models `open → paid | declined | expired`); `rejectPaymentRequest` is **server-confirmed** before flipping locally.
- Two cursor families that never mix: **incoming** = gap-free `bigint` `seq` (`syncPaymentRequests` drains it; a `syncEpoch` change → re-pull from `0`); **outgoing** = newest-first opaque `before` keyset.

### 4.7 Events & errors

- New events to subscribe to: `transfer:invalid`, `payment_request:expired`, `storage:degraded`, `walletapi:session` (`{status:'online'|'offline'}`), `realtime:status`. None removed.
- All SDK methods now throw a typed **`SphereError`** with `.code` (`isSphereError()` guard). New codes you'll meet: `INVALID_CONFIG`, `INVALID_RECIPIENT`, `AGGREGATOR_ERROR`, `STORAGE_ERROR`, `INVOICE_ORACLE_REQUIRED`. Update catch blocks.
- On reconnect/crash recovery, call `sphere.payments.resumeOpenIntents()` (E.3) — but `Sphere.init` already does this on unlock.

### 4.8 Re-funding on testnet2

The wallet starts empty. Re-fund via **self-mint** (`sphere.payments.mintFungibleToken(coinIdHex, amount)` — engine-backed now; `coinId` lowercase hex) or your testnet2 faucet, exactly as a fresh wallet would. There is nothing to import from the old testnet.

---

## 5. Removed / changed API quick reference

| Operation | 0.7.2 | 0.9.1-dev |
|---|---|---|
| Build providers | `createNodeProviders({ tokensDir })` | `createNodeProviders({ network, tokensDir, oracle:{apiKey} })` — **network required** |
| Compose wallet-api | — | `createWalletApiProviders(base, { baseUrl, network, deviceId })` → spread into `Sphere.init` |
| Own address | `sphere.getProxyAddress()` | **removed** → `sphere.identity.directAddress` |
| Send | `payments.send(req)` | same (engine required) |
| Instant/split send | `payments.sendInstant(req, opts)` | **removed** → `send(req)` |
| Receive | `payments.receive(opts, cb)` | `payments.receive(cb)` (opts ignored) / `pumpIncomingDeliveries()` |
| Finalize received | `payments.resolveUnconfirmed()` | **removed** (arrives finished) |
| Balance / assets / history | `getBalance` / `getAssets` / `getHistory` | **unchanged** |
| Mint nametag (low-level) | `sphere.mintNametag` / `payments.mintNametag` | **removed** → `sphere.registerNametag` |
| Nametag availability | `payments.isNametagAvailable` | **removed** → `sphere.isNametagAvailable` |
| Signing pubkey | `payments.getSigningPublicKey()` | **removed** (internal) |
| Switch address | `sphere.switchToAddress(i, { nametag? })` | **unchanged** |
| Payment-request verbs | `sendPaymentRequest` / `accept` / `reject` / `pay` | **unchanged** (route to wallet-api) |
| Oracle interface | full aggregator (`submit`/`getProof`/`mint`/…) | network-config only (`getTrustBaseJson`/`getAggregatorUrl`/`getApiKey`) — calls moved to `./token-engine` |
| Removed type imports | `…/types/instant-split`, `…/types/payment-session` | **deleted** — remove these imports |

**Will break at compile/runtime:** `getProxyAddress`, `mintNametag`, `sendInstant`, `resolveUnconfirmed`, `getSigningPublicKey`, `addressMode:'proxy'`, `createNodeProviders` without `network`, imports of the deleted `instant-split`/`payment-session` types, reading `ReceiveResult.finalization`/`.timedOut`.
**Silently no-ops without wiring:** `send`/`mintFungibleToken` need a token engine; delivery/intents/history need the `delivery` + `walletApi` ports.

---

## 6. Bot-specific gotchas

- **Multi-address = multi-owner = multi-JWT.** The preset composes **one** `WalletApiClient` with a single identity+JWT. `switchToAddress` logs out and re-binds the client to the new owner. **Inventory / mailbox / payment-requests never carry over between HD addresses** — each address is a distinct owner. (A re-visit-switch bleed bug here was just fixed; pin a `dev.N` that includes it.)
- **Received assets arrive via mailbox, not push.** Run `receive()`/the pump or you'll never see them.
- **Set a canonical nametag** so transfers/requests render `@name` (the nametag rides the encrypted memo from the *sender's* canonical nametag).
- **Persist `stateStore` durably** (refresh token, inventory cursors, the delivery seen-set live there). Losing it forces a fresh challenge and a full re-sync.
- **Keep `deviceId` stable** across restarts.

---

## 7. Migration checklist

1. Node **≥ 22**; pin a `0.9.1-dev.N`.
2. Pass `network: 'testnet2'` everywhere; inject `oracle.apiKey`. Set `WALLET_API_URL` + a stable `deviceId`.
3. Replace the bootstrap with `createNodeProviders` → `createWalletApiProviders` → `Sphere.init` (don't half-wire — it's fail-closed).
4. Delete: `getProxyAddress`, `mintNametag`, `sendInstant`, `resolveUnconfirmed`, `getSigningPublicKey`, `addressMode:'proxy'`, `instant-split`/`payment-session` type imports, and any `ReceiveResult.finalization` usage.
5. Send to `chainPubkey`/`@name`; handle `INVALID_RECIPIENT`.
6. Run `receive()`/`pumpIncomingDeliveries()` on a schedule; subscribe to `transfer:invalid`.
7. Move payment-request polling to `syncPaymentRequests()` + the incoming `seq` cursor.
8. Switch catch blocks to typed `SphereError` / `isSphereError()`.
9. **Re-establish identity on testnet2, confirm `@name` resolves, re-fund via self-mint.** Do **not** attempt to migrate holdings.
10. Subscribe to `walletapi:session` / `storage:degraded`; call `resumeOpenIntents()` on reconnect if you drive providers raw.

---

## 8. Canonical references (in this repo)

- **`tests/harness/support/harness-wallet.ts`** — the authoritative end-to-end real wiring (engine + presets + `PaymentsModule` against a real backend).
- `impl/shared/wallet-api/composition.ts` — the presets (`createWalletApiProviders`, `createOwnStorageWalletApiProviders`) and the fail-closed config contract.
- `wallet-api/client.ts` / `wallet-api/types.ts` — the `WalletApiClient` and wire types (auth, inventory, mailbox, payment-requests, intents).
- `core/Sphere.ts` — `SphereInitOptions` (`delivery` / `walletApi`), `startWalletApiSession`, `switchToAddress`/`rebindWalletApiIdentity`.
- `token-engine/` — `createSphereTokenEngine` (v2 engine).
- `core/delivery-envelope.ts` (recipient-ECDH memo) and `core/field-encryption.ts` (self-scoped `enc1.`).

> The existing `README.md`, `docs/QUICKSTART-NODEJS.md`, and `docs/INTEGRATION.md` still describe the **Nostr/IPFS** path only — they have **not** been updated for wallet-api. Until they are, this guide + the harness are the wallet-api references.
