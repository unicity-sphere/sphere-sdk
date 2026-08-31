# CLAUDE.md - Sphere SDK Project Context

This file provides context for Claude Code when working with the Sphere SDK project.

## ⚡ wallet-api program — current work (read first)

This repo is part of the wallet-api program (process: `../wallet-api/development-workflow.md`).

- **Branch topology (updated 2026-07-31):** all work branches from and PRs back to **`main`** —
  the `feat/wallet-api-integration` era ended when the integration branches merged (releases ship
  from `main`; wallet-api#119 records this in the process doc). Every PR links a GitHub issue
  (`Closes #N`, docs-only changes exempt); squash-merge after green CI (typecheck + lint + build +
  unit tests + typecheck:tests).
- **The normative spec for the program's SDK work is `../wallet-api/docs/sdk-changes.md`** — Part E
  (recoverable engine), then S1–S7 (thin wallet, ports, wallet-api providers). It was adversarially
  verified; build it, don't redesign it. Spec-first: contract changes land in the spec in the same
  PR, before code. **The payments vertical (P11 flip landed) is the ONLY money path — design +
  build tracker: `docs/PAYMENTS-V2-DESIGN.md` (read it before touching `modules/payments-v2/` or
  `impl/wallet-api-v2/`). Migration guide for consumers: `docs/MIGRATION-PAYMENTS-V2.md`.**
- **Resume is status-agnostic** (sdk-changes E.2): never key engine resume off a submit status —
  submit, always `getInclusionProof`, match-verify (`OK` = mine, `TRANSACTION_HASH_MISMATCH` =
  `TransferConflictError`). That stays the ONLY conflict signal under 3.x: a null
  `inclusionProof` means "not certified YET", and the time-dependent statuses the bump added —
  `REQUEST_EXPIRED` and `REFERENCE_TIME_AFTER_ROUND` on verify, `REQUEST_EXPIRED` and
  `SERVICE_NOT_READY` on submit — each report only that THIS attempt was not admitted, never that
  no earlier attempt certified, so none of them is a clean reject. The `STATE_ID_EXISTS`
  aggregator lag is OVER (M7 live e2e observed 2026-06-12: the gateway answers `SUCCESS` for
  duplicate AND conflicting submits — the status carries no conflict signal; see the dated
  OBSERVED note in `../wallet-api/sdk-changes.md` E.2);
  tolerant parsing shipped via state-transition-sdk-js#125 and stays.
- **Sphere sets no request deadline, ANYWHERE** (#760): every mint / transfer / split burn /
  split mint leg omits `expiresAt`, so the Unicity Service assigns one from consensus time and
  does not record it. The reason is not determinism — a deadline persisted on the durable intent
  would rebuild byte-identically — it is (a) an untrusted browser clock, where one skewed wallet
  pinning a past deadline is a wallet-wide payment outage, and (b) unrecoverability across
  downtime longer than the window: every resume would rebuild an already-expired transaction and
  the intent would sit open forever with its sources reserved, and there is currently NO attempt
  budget on the certify/resume path at all. What makes the policy load-bearing rather than
  cosmetic: `expiresAt` is committed by the transaction HASH but is NOT part of the StateId, so
  two attempts that disagree about it address the SAME leaf with DIFFERENT hashes — and
  `InclusionProofVerificationRule` compares the hash BEFORE the certification data, so the
  disagreement surfaces as `TRANSACTION_HASH_MISMATCH`, i.e. as a foreign spend, which
  `token-engine/certification-outcome.ts` maps to `TransferConflictError` (abort + re-plan). A
  clock-derived deadline would therefore make every crash-resume abort an intent whose spend is
  already on chain. Pinned by `tests/unit/token-engine/expires-at.test.ts`, including a 24-hour
  clock jump between two attempts.
- **Ports rule (design §10 / covenant):** the money ports are `StoragePort` and `DeliveryPort`
  (`modules/payments-v2/ports.ts`) — independent, swappable, contract-test-enforced
  (`tests/unit/payments-v2/contracts/`); the Sphere frontend is a **view** — no provider-specific
  logic outside implementations; custody (`intoInventory`) is a composition-time property, never a
  per-call flag.
- **Never weaken a test to make it pass**; no `.skip`/`.only`. Known pre-existing flaky/failing
  tests are tracked in #487.
- **Releases:** npm versions publish via `publish.yml` (workflow_dispatch, version input) — the
  workflow runs `npm version` itself, so `package.json` on a branch still reads the PREVIOUS
  version; never hand-edit the field. Publishing from `main` takes dist-tag `latest`, any other
  branch takes `dev` (line **`<next version>-dev.#`**). Consumers (wallet-api backend, sphere
  frontend) pin exact versions. The backend consumes ONLY the `./token-engine` subpath (must stay
  browser/Nostr-free — keep `token-engine/` clean).
- **The 3.x bump is a fleet-wide flag day** (#760, shipping as **0.15.0**). The forcing function
  is `aggregator-go`, whose main already carries `CertificationDataVersion = 2` with a hard reject
  of version 1 — nothing can straddle the gateway cutover. `wallet-api` must bump in LOCKSTEP:
  both repos pin `@unicitylabs/state-transition-sdk` EXACTLY, so bumping sphere-sdk alone makes
  npm dedupe impossible and runs both wire realms live; they cross at
  `../wallet-api/src/validation/verifier.ts`. A testnet + wallet-api backend reset accompanies the
  release.
- Pinned base SDK: `@unicitylabs/state-transition-sdk@3.0.1` (exact pin; bump only via PR).
  **What 3.x is:** every transaction now carries `expiresAt` — an exclusive request deadline in
  Unix seconds — and every inclusion proof carries the `referenceTime` of the round that certified
  it; the sparse-Merkle leaf value became H(transactionHash, referenceTime) instead of the bare
  transaction hash. The Token / MintTransaction / TransferTransaction / CertificationData wire
  versions all moved with it: **nothing written by 2.x decodes, and nothing 2.x writes is accepted
  by the upgraded aggregator** — in either direction, no exceptions.
  The lost-abort hang in `waitInclusionProof` that 2.0.3 fixed (state-transition-sdk-js#140/#141)
  is still fixed in 3.0.1: its poll loop checks `aborted` before subscribing, races each poll
  against the signal, and cancels the in-flight request.
  `tests/unit/token-engine/proof-deadline.test.ts` is the guard that it keeps doing so — do not
  delete it on a future bump.

## Quick Start (Using SDK as Dependency)

### Installation

**Browser:**
```bash
npm install @unicitylabs/sphere-sdk
```

**Node.js:**
```bash
npm install @unicitylabs/sphere-sdk ws
```

### Complete L3 Wallet Integration Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
// For Node.js: import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// 1. Create base providers. `network` is REQUIRED (throws INVALID_CONFIG otherwise).
//    There is NO bundled gateway API key — inject it via oracle.apiKey.
//    The testnet2 key is NOT a secret (see .env.example); a mainnet key IS.
const base = createBrowserProviders({
  network: 'testnet2', // 'testnet' is an alias of it — the gateway the engine talks to
  oracle: { apiKey: 'sk_...' },
});
// Node.js: createNodeProviders({ network: 'testnet2', oracle: { apiKey: 'sk_...' },
//                                dataDir: './sphere-data' })

// 2. Attach the wallet-api transport config — REQUIRED for money. Sphere.init
//    throws INVALID_CONFIG without `walletApi`; tokens are server-custody
//    (the wallet-api backend holds inventory; keys stay local).
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.example',  // wallet-api backend
  network: 'testnet2',
  deviceId: 'my-device',                  // stable per device — keeps the refresh-token row
});

// 3. Init wallet (creates new OR loads existing — single entry point).
//    `network` is required here too and is compared to `walletApi.network` as a
//    STRING — 'testnet' vs 'testnet2' is a mismatch (INVALID_CONFIG), alias or not.
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  network: 'testnet2',  // must equal walletApi.network and the base providers' network
  autoGenerate: true,   // Generate mnemonic if no wallet exists
  nametag: 'alice',     // Optional: register @alice (only on create)
  password: 'secret',   // Optional: encrypt mnemonic (plaintext if omitted)
});
// NOTE: `accounting: true` / `swap: true` THROW INVALID_CONFIG — invoicing and
// swaps no longer exist in the SDK (P11 flip). The `paymentsV2:` flag is GONE
// (0.15.0): the vertical is the only path, so there was nothing left to switch.

if (created && generatedMnemonic) {
  // First run — prompt user to back up mnemonic
  console.log('SAVE THIS:', generatedMnemonic);
}

// 4. Identity is ready
const identity = sphere.identity!;
console.log('L3 address:', identity.directAddress);  // DIRECT://... (primary)
console.log('Unicity ID:', identity.nametag);        // alice

// 5. Balances and tokens (server-read-through; Asset keeps its legacy shape —
//    unconfirmed* fields are pinned '0'/0 by the v2 presentation)
const assets = await sphere.payments.assets();        // Asset[] grouped by coin
const uct = await sphere.payments.assets(coinIdHex);  // filter by coin
const tokens = sphere.payments.tokens();              // individual Token[] (sync view)
const filtered = sphere.payments.tokens({ coinId: '...' });

// 6. Send tokens (L3). Recipient must have a PUBLISHED chain pubkey
//    (@nametag / DIRECT:// resolve via Nostr binding); fails loudly otherwise.
const result = await sphere.payments.send({
  recipient: '@bob',           // @nametag, DIRECT://..., or chain pubkey (02...)
  amount: '1000000',           // in smallest unit (string)
  coinId: 'UCT',               // coin ID (64-hex canonical; short symbols resolved via registry)
  memo: 'Payment for coffee',  // optional (recipient-encrypted envelope)
});
// result: TransferResult { id, status, tokens, tokenTransfers, error?,
//                          deliveryPending?, deliveryState? }
// status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed'
// deliveryPending: certified on-chain but mailbox deposit still owed — NOT a failure.

// 7. Receive: the facade drains the wallet-api mailbox continuously while
//    started; receive() is an explicit one-shot drain (returns what landed).
const { transfers } = await sphere.payments.receive();
sphere.on('transfer:incoming', (transfer) => {
  console.log(`From: ${transfer.senderNametag}, Tokens: ${transfer.tokens.length}`);
});

// 8. Self-mint fungible tokens (testnet top-up; journal-first, crash-safe)
//    coinId must be even-length lowercase hex (the canonical SDK AssetId form)
const mint = await sphere.payments.mint(coinIdHex, 1000000n);
// MintResult: { success: true, tokenId } | { success: false, error }

// 9. Transaction history — server read-through, PAGED
const page = await sphere.payments.history({ limit: 50 });
// HistoryPage: { entries: HistoryEntry[], more, cursor }
const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });

// 10. Peer resolution (Unicity ID → addresses)
const peer = await sphere.resolve('@bob');
// PeerInfo | null: { nametag?, transportPubkey, chainPubkey, directAddress, timestamp }

// 11. Multi-address
await sphere.switchToAddress(1);
await sphere.registerNametag('alice2');
const addresses = sphere.getActiveAddresses(); // TrackedAddress[]

// 12. Payment requests (wallet-api rail; encrypted memo envelope)
const req = await sphere.payments.requests.create('@bob', {
  coinId: 'UCT', amount: '1000000', memo: 'Pay for order #1234',
});
sphere.on('payment_request:incoming', (view) => {
  // PaymentRequestView: { id, requestId, senderPubkey, senderNametag?, amount,
  //                       coinId, symbol?, message?, timestamp, status }
  sphere.payments.requests.pay(view.id);      // or .decline(view.id)
});
sphere.on('payment_request:updated', ({ id, status }) => {
  // status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
});
const open = sphere.payments.requests.list();  // PaymentRequestView[]
sphere.payments.requests.dismissProcessed();   // drop terminal entries from list()

// 13. Cleanup
await sphere.destroy();
```

---

## Connect Protocol (dApp ↔ Wallet Integration)

Typed RPC layer for dApp ↔ wallet communication. Full guide: [`docs/CONNECT.md`](docs/CONNECT.md)

| Role | Class | Where it runs |
|------|-------|--------------|
| dApp (client) | `ConnectClient` | any web page / app |
| Wallet (host) | `ConnectHost` | Sphere app / extension background |

**Transports:** `PostMessageTransport` (iframe/popup), `ExtensionTransport` (browser extension), `WebSocketTransport` (Node.js).

**Queries (14):** `sphere_getIdentity`, `sphere_getBalance`, `sphere_getAssets`, `sphere_getFiatBalance`, `sphere_getTokens`, `sphere_getHistory`, `sphere_resolve`, `sphere_subscribe`, `sphere_unsubscribe`, `sphere_disconnect`, `sphere_getConversations`, `sphere_getMessages`, `sphere_getDMUnreadCount`, `sphere_markAsRead`. (The two invoice queries were removed with the P11 flip — they were experimental and never enabled in any wallet host.)

**Intents (6):** `send`, `dm`, `payment_request`, `receive`, `sign_message`, `mint`. (The 9 invoice intents were removed with the P11 flip.)

**Permission scopes (13):** `identity:read`, `balance:read`, `tokens:read`, `history:read`, `events:subscribe`, `resolve:peer`, `transfer:request`, `dm:request`, `dm:read`, `dm:manage`, `payment:request`, `sign:request`, `mint:request`.

**Wire-compat adapter (`connect/host/payments-compat.ts`):** dApps written against the pre-flip event/query contract change NOTHING. On a v2 host, `sphere_getBalance`/`getAssets`/`getFiatBalance`/`getTokens`/`getHistory` are served from the facade (`assets()`/`tokens()`/`history()` — old result shapes held), and the old subscribable event names are re-emitted from the 8 v2 events: `transfer:confirmed`/`transfer:delivery_pending`/`transfer:failed` ← `transfer:updated`; `payment_request:paid|rejected|expired` ← `payment_request:updated`; `split:checkpoint-stuck`/`delivery:undeliverable`/`delivery:deferred` ← `transfer:attention`; `realtime:status`/`storage:degraded` ← `connection:status`; `sync:completed`/`sync:remote-update` ← `inventory:updated`. (`send:partial-remainder` is NOT re-emitted — folded by design, no consumer existed.)

**Host-side shape (0.15.0):** the WIRE is unchanged — dApps see exactly what they saw before — but `SphereInstance` (`connect/host/SphereInstance.ts`) dropped its legacy `payments: { getBalance/getAssets/getFiatBalance/getTokens/getHistory }` object and its optional `paymentsV2`; it now declares `readonly payments: PaymentsV2`, read **lazily per query branch** because the real getter throws while no vertical runs and `sphere_getIdentity` must still answer. The ConnectHost's legacy-host fallbacks are gone (dead since the P11 flip), so `sphere_getBalance` and `sphere_getAssets` are now literally the same call and `sphere_getFiatBalance` is summed from `assets()`.

**Silent mode:** `new ConnectClient({ ..., silent: true })` — fast-check approved list without UI popup.

**Wallet-pushed events (4):** `WALLET_EVENTS.LOCKED` (`wallet:locked`), `WALLET_EVENTS.UNLOCKED` (`wallet:unlocked`), `WALLET_EVENTS.DISCONNECTED` (`wallet:disconnected`), `WALLET_EVENTS.IDENTITY_CHANGED` (`identity:changed`) — pushed by the host without subscription, and `sphere_subscribe` **refuses** them (`Sphere.on()` would accept the name and silently never emit).

**Graceful wallet lock (Connect 2.1):** a lock is a **state, not a teardown** — the session survives. Host verbs: `setLocked()` (session preserved, push `wallet:locked`), `updateSphere(next)` (unlock, push `wallet:unlocked`), `revokeSession()` (teardown, push `wallet:disconnected`), `setUnavailable()` (Sphere gone for a non-lock reason). `notifyWalletLocked()` was **removed**, not aliased — its old meaning was the opposite of its new one. While locked a host that HOLDS a session answers four of fourteen `RPC_METHODS` — `sphere_getIdentity` (from an immutable snapshot), `sphere_subscribe`, `sphere_unsubscribe`, `sphere_disconnect` — and refuses the other ten plus every intent with `WALLET_LOCKED` (4009). That ten includes `sphere_resolve` and **all four DM reads**: messaging does NOT keep working while locked. Nothing is cached. A host that COLD-STARTS locked has no session and an empty snapshot, so the handshake itself is refused with an errorless empty response — the dApp sees no code at all, not 4009, and must treat it as "not ready yet" and wait for `HOST_READY`. `onLockedRequest` is notify-only and **must never raise a credential surface** — a passive badge only. See `docs/CONNECT.md`.

---

### What's Included by Default

| Component | Browser | Node.js |
|-----------|---------|---------|
| Storage (keys/identity/journals) | IndexedDB (`IndexedDBStorageProvider`) | File-based JSON (`FileStorageProvider`) |
| Token custody | wallet-api backend (server inventory; `walletApi` config required) | Same |
| Transport (Nostr: DMs, nametags, groupchat) | Native WebSocket | `ws` package (install separately) |
| Oracle (network config) | Embedded trust base per network; API key injected via `oracle.apiKey` | Same (+ optional `trustBasePath` file) |
| Price (CoinGecko) | Optional (`price` config) | Optional (`price` config) |
| Token Registry | Remote fetch + persistent cache | Remote fetch + file cache |

### Key API Methods Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `Sphere.init(options)` | `{ sphere, created, generatedMnemonic? }` | Create or load wallet (requires `walletApi` config) |
| `Sphere.exists(storage)` | `Promise<boolean>` | Check if wallet exists |
| `Sphere.clear({ storage })` | `void` | Delete all wallet data (the whole KV, both `pv2g2:*` and superseded `pv2:*`, + orphaned pre-flip token DBs) |
| `Sphere.import(options)` | `Sphere` | Import from mnemonic/masterKey |
| `Sphere.importFromLegacyFile(options)` | `Sphere` | Import a `.txt` / flat-JSON / bare-mnemonic backup |
| `sphere.payments.assets(coinId?)` | `Promise<Asset[]>` | Assets grouped by coin (server read-through) |
| `sphere.payments.tokens(filter?)` | `Token[]` | Individual tokens (sync inventory view) |
| `sphere.payments.send(request)` | `Promise<TransferResult>` | Send L3 tokens (wallet-api vertical) |
| `sphere.payments.mint(coinIdHex, amount)` | `Promise<MintResult>` | Self-mint via engine (journal-first, no faucet) |
| `sphere.payments.receive()` | `Promise<{ transfers }>` | Explicit one-shot mailbox drain |
| `sphere.payments.history(page?)` | `Promise<HistoryPage>` | Paged history (`{ before?, limit? }`) |
| `sphere.payments.requests.create(to, terms)` | `{ success, requestId?, error? }` | Send a payment request |
| `sphere.payments.requests.list()` | `PaymentRequestView[]` | Current request views |
| `sphere.payments.requests.pay(id)` | `Promise<TransferResult>` | Pay an incoming request (durably `settling` first) |
| `sphere.payments.requests.decline(id)` | `Promise<void>` | Decline (server 403/409 propagate) |
| `sphere.payments.requests.dismissProcessed()` | `void` | Drop terminal entries from `list()` |
| `sphere.resolve(identifier)` | `PeerInfo \| null` | Resolve @nametag/address/pubkey |
| `sphere.communications.resolvePeerNametag(pubkey)` | `string \| undefined` | Resolve peer Unicity ID via transport |
| `sphere.registerNametag(name)` | `void` | Register Unicity ID (Nostr binding) |
| `sphere.signMessage(message)` | `string` | Sign with wallet key (secp256k1 ECDSA) |
| `sphere.switchToAddress(index, options?)` | `void` | Switch HD address |
| `sphere.getActiveAddresses()` | `TrackedAddress[]` | Non-hidden tracked addresses |
| `sphere.setOracleApiKey(key)` | `Promise<void>` | Rebuild the engine with a new gateway key |
| `sphere.exportToTxt(options?)` | `string` | Text backup (optionally password-encrypted) |
| `sphere.on(event, handler)` | `() => void` (unsubscribe) | Subscribe to events |

Notes:
- `sphere.paymentsV2` is **GONE** (0.15.0) — `sphere.payments` is the only accessor. The
  behavioural difference consumers must handle: the alias returned `null` while no vertical ran,
  `sphere.payments` **THROWS `NOT_INITIALIZED`** (init in flight, mid address-switch, destroyed).
  Read it lazily at the call site, never once at construction.
- `sphere.groupChat`, `sphere.market` are nullable getters — `null` unless enabled in init
  options. `sphere.accounting` / `sphere.swap` DO NOT EXIST (P11 flip); passing
  `accounting:`/`swap:` init options throws `INVALID_CONFIG`.

### Key Events

The payments vertical emits exactly 8 events; identity/comms/groupchat events ride the same bus.

| Event | Payload | When |
|-------|---------|------|
| `transfer:incoming` | `IncomingTransfer` (`{ senderPubkey, senderNametag?, tokens, memo?, receivedAt }`) | Tokens landed from the wallet-api mailbox (verified before entering balance) |
| `transfer:updated` | `TransferResult` | Outgoing transfer changed status (read `status` / `deliveryPending`) |
| `transfer:attention` | `{ transferId, code, detail? }` | A transfer needs operator attention (stuck checkpoint, undeliverable, deferred) |
| `inventory:updated` | `{}` | Inventory changed (send/receive/mint/resync) |
| `history:updated` | `HistoryEntry` (the just-recorded entry) | History changed |
| `payment_request:incoming` | `PaymentRequestView` | Received payment request |
| `payment_request:updated` | `{ id, status }` | Request moved (`settling`/`paid`/`rejected`/`expired`) |
| `connection:status` | `{ status: 'connected' \| 'degraded' \| 'offline' }` | Wallet-api session/wake-socket health |
| `identity:changed` | `{ directAddress?, chainPubkey, nametag?, addressIndex }` | Address switch |
| `nametag:registered` | `{ nametag, addressIndex }` | Unicity ID registered |
| `nametag:recovered` | `{ nametag }` | Unicity ID recovered from Nostr on import |
| `address:activated` | `{ address: TrackedAddress }` | New address tracked |
| `message:dm` / `message:broadcast` / `groupchat:*` | see `types/index.ts` | Communications |

The pre-flip event names (`transfer:confirmed`, `sync:*`, `invoice:*`, `swap:*`, …) are GONE from
the public event map — dApps on the Connect wire still receive the old names via the ConnectHost
compat adapter, but direct `sphere.on()` consumers must use the v2 names.

See [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) and [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) for detailed guides.

---

## Project Overview

**Sphere SDK** (`@unicitylabs/sphere-sdk`) is a modular TypeScript SDK for Unicity wallet operations supporting:
- **L3 (Unicity state transition network)** - Token transfers via the **v3 state-transition SDK** (pinned `3.0.1`), consumed exclusively through the `token-engine/` port. Wallets are L3-only.
- **Money custody:** wallet-api backend (server inventory + mailbox delivery). Nostr carries DMs, group chat and nametag bindings ONLY — no asset or payment-request traffic.

**Version:** `0.15.x` — the state-transition-sdk 3.x bump ships as **0.15.0**, a breaking release (no cross-major wire interop in either direction). `package.json` on a branch still reads the previous version: `publish.yml` sets the field at publish time from its `version` input. Releases ship from `main` under the npm `latest` tag; `-dev.#` builds are published from a branch and land under `dev`. Per-release notes: CHANGELOG (versioned sections start at `0.14.11`; older entries are pooled under `[0.14.10] and earlier`)
**License:** MIT
**Target:** Node.js >= 22.0.0, Browser (ESM/CJS)
**CLI:** moved out to `@unicity-sphere/cli` (`npm run cli` only prints a pointer)

## Directory Structure

```
sphere-sdk/
├── core/                    # Core wallet and crypto utilities
│   ├── Sphere.ts           # Main wallet class - entry point
│   ├── payments-v2-wiring.ts # Composition: walletApi config → facade (resolvePaymentsV2Composition)
│   ├── wallet-api-protocol.ts # Cross-repo contract strings (auth challenge, intent signing)
│   ├── address.ts          # DIRECT:// address parsing/validation
│   ├── crypto.ts           # BIP39/BIP32, secp256k1, hashing, message signing
│   ├── encryption.ts       # AES/Argon2+ChaCha20 encryption utilities
│   ├── field-encryption.ts / delivery-envelope.ts # pv2 field crypto + S6 memo envelope
│   ├── errors.ts           # SphereError + SphereErrorCode
│   ├── logger.ts           # Centralized logger singleton
│   ├── currency.ts         # Amount formatting/conversion
│   ├── discover.ts         # HD address scanning/discovery
│   ├── network-health.ts   # checkNetworkHealth()
│   └── utils.ts            # Base58, patterns, UUID, helpers
│
├── token-engine/            # ⭐ Anti-corruption layer over the v3 state-transition SDK
│   ├── engine.ts           # ITokenEngine port (frozen contract) + EngineConfig
│   ├── types.ts            # Sphere-domain types: SphereToken, TokenBlob, Mint/Transfer/SplitParams
│   ├── factory.ts          # createSphereTokenEngine(config)
│   ├── SphereTokenEngine.ts # The real adapter (engine implementation)
│   ├── SpherePaymentData.ts # Value envelope codec (coins inside SDK tokens, CBOR tag 39050)
│   ├── proof-wait.ts       # Bounded proof wait + transient policy (TransientSubmitAnswer)
│   ├── certification-outcome.ts # conflict vs possibly-committed classification
│   ├── split-checkpoint.ts # Durable burn checkpoint (CHECKPOINT_VERSION 2)
│   ├── blob-keys.ts        # deriveDeliveryKeys() over raw Token.toCBOR() bytes
│   ├── identity.ts         # deriveDirectAddress() — vendored v1-identical DIRECT:// derivation
│   ├── network.ts          # SphereNetwork ↔ SDK NetworkId mapping
│   └── sdk.ts              # ⚠️ THE ONLY file allowed to import @unicitylabs/state-transition-sdk
│
├── types/                   # TypeScript type definitions
│   └── index.ts            # Main types (Identity, Token, Asset, Transfer, events, etc.)
│
├── modules/                 # Feature modules
│   ├── payments-v2/               # ⭐ The payments vertical (docs/PAYMENTS-V2-DESIGN.md)
│   │   ├── api.ts                 # PaymentsV2 facade surface + the 8 events (§4)
│   │   ├── PaymentsFacade.ts      # Facade: lifecycle, send/mint/receive orchestration
│   │   ├── ports.ts               # StoragePort / DeliveryPort (contract-test-enforced)
│   │   ├── stores.ts              # pv2g2:{network}:{pubkey}: scoped KV — §6 durable state
│   │   ├── restore.ts             # §5.1 epoch-change reseed (see the KV generation note below)
│   │   ├── machine/               # TransferMachine + resume (E.2/E.4) + intent journal
│   │   ├── select/                # CoinSelector, Reservations ledger, op queue
│   │   ├── receive/               # Mailbox drain, seen-set, claim, verified-before-balance
│   │   ├── requests/              # Payment requests (streams + settling journal)
│   │   ├── history/               # Server read-through paged history
│   │   ├── inventory/             # InventoryView + Asset presentation (legacy shape held)
│   │   └── compose.ts / async.ts / index.ts
│   ├── groupchat/                 # NIP-29 group chat (relay-based)
│   ├── market/                    # Market intents
│   └── communications/            # DMs and broadcasts
│
├── impl/                    # Platform-specific implementations
│   ├── browser/            # IndexedDB storage, browser oracle/transport, connect
│   ├── nodejs/             # FileStorage, Node oracle/transport, connect
│   ├── shared/             # Config resolvers, network checks, trust-base loaders
│   │   └── wallet-api/     # createWalletApiProviders → { walletApi: WalletApiTransportConfig }
│   └── wallet-api-v2/      # Wallet-api wire: session (auth+wake WS), client, http,
│                           #   storage/mailbox/checkpoints port implementations
│
├── transport/               # P2P messaging abstraction (NostrTransportProvider)
├── storage/                 # StorageProvider port (keys/identity/journals) + HistoryRecord
├── oracle/                  # Network-config provider for the token engine
├── price/                   # Token market prices (CoinGeckoPriceProvider)
├── registry/                # Token metadata registry (remote fetch + cache singleton)
├── serialization/           # Text wallet backup format (.txt) parsing/writing
├── connect/                 # Sphere Connect protocol (client/, host/ incl. payments-compat)
├── assets/                  # Embedded trust bases per network (trustbase.ts)
│
├── tests/                   # Vitest: unit/ (incl. payments-v2 + contracts), integration/,
│                           #   e2e/ (live staging), relay/, mutation/ (probes.json)
├── docs/                    # PAYMENTS-V2-DESIGN, MIGRATION-PAYMENTS-V2, CONNECT, QUICKSTART-*, ...
├── index.ts                 # Main SDK entry point
├── constants.ts             # Global constants, NETWORKS, storage keys
└── package.json
```

Subpath exports: `.` (root), `./core`, `./token-engine`, `./payments-v2` (the facade module),
`./impl/wallet-api-v2`, `./impl/shared/wallet-api`, `./impl/browser`, `./impl/nodejs`,
`./connect` (+ platform connect entries). The `./wallet-api` subpath (old S1 client) is GONE.

## Architecture

### Payments vertical (the only money path)

`docs/PAYMENTS-V2-DESIGN.md` is the authoritative design. The short version:

- **Server is the record.** Token inventory, blobs, transfer intents, mailbox, history and
  payment requests live in the wallet-api backend. The client holds keys, a per-address scoped
  KV (`pv2g2:{network}:{chainPubkey}:*` in the plain `StorageProvider`) with the refresh token,
  cursors, seen-set and journals — nothing else. There is no client token store to sync
  (`sphere.sync()` is gone).
- **Composition:** `Sphere.init({ walletApi })` → `resolvePaymentsV2Composition` →
  `composePaymentsV2` builds one `PaymentsFacade` per active address over the wallet-api-v2
  ports (`WalletApiStoragePort`, `WalletApiDeliveryPort`, `WalletApiSplitCheckpointStore`) and
  a `WalletApiSession` (challenge sign-in → JWT + refresh token, wake WebSocket, single-flight
  re-auth), and fires `sweepSupersededState()` once (the `pv2:` generation — see below). The
  `paymentsV2Transport` seam in the config injects a whole custom bundle (tests, custom hosts).
  Init is FAIL-CLOSED: no `walletApi` → `INVALID_CONFIG`, before any storage write.
- **Send:** `TransferMachine` — durable intent on the server first (`putIntent`), then engine
  ops (transfer/split), per-op progress checkpoints (field-encrypted, signed), mailbox deposit,
  signed complete (`completeSignMessage` — the server's seedGate verifies it). Resume is THE SAME
  machine replaying the SAME transferId — runs inside `facade.start()` (off critical path),
  never re-issues a spend. A possibly-committed outcome keeps the intent OPEN (never a fresh
  send); a clean conflict with a demoted source triggers one bounded re-plan (#625 marks the
  source `suspectedSpent`, excluded from selection, recoverable by resync).
- **Receive:** continuous mailbox drain while started + explicit `receive()`. Every incoming
  token is engine-verified and ownership-checked BEFORE entering the balance; seen-set dedup by
  **(tokenId, stateHash)** — genesis id alone would refuse a token legitimately re-acquired at a
  later state; store-before-ack (a crash between store and claim re-claims, never loses).
- **Delivery journal (#621):** a certified-but-undelivered blob is journaled in the scoped KV
  and replayed with a poison budget (#517) — `deliveryPending` on the TransferResult, `landed`
  vs `pending-delivery` in `deliveryState`, `transfer:attention` when undeliverable/deferred.
- **Mint:** journal-first (`mint` journal in scoped KV), idempotent same-seed re-call converges
  a replay — crash-safe without a faucet.
- **Error contract (load-bearing, unchanged):** `CERTIFICATION_UNCONFIRMED`
  (`ProofUnconfirmedError` with `.cause`), `SEND_SYNC_PENDING`, the checkpoint trio,
  `SEND_PARTIALLY_COMPLETED`, `isPossiblyCommittedSendOutcome()` — callers keep PENDING_COMMIT
  handling exactly as before; never re-issue a send after a possibly-committed reject.
- **Lifecycle:** `facade.start()`/`stop()` are Sphere-internal (init/destroy/address switch);
  there is no public session or resume API. An address switch stops the old facade and starts a
  fresh one (a stopped `WalletApiSession` does not restart).

### Token Engine (v3) — the only chain-op path

The canonical package name resolves to the **v3 SDK, pinned `3.0.1`** (exact). The whole 3.x wire
break is absorbed here: `ITokenEngine` did not change shape for the bump, and the only
sphere-domain type that moved is `TokenBlob` (two never-read fields dropped — below).

- The SDK is imported in exactly ONE file: `token-engine/sdk.ts`. An ESLint
  `no-restricted-imports` rule blocks any other import of
  `@unicitylabs/state-transition-sdk` — everything else codes against the
  `ITokenEngine` port and sphere-domain types from `token-engine/`.
- `ITokenEngine` operations: `getIdentity`, `deriveIdentityAddress`, `tokenId`,
  `readValue`, `balanceOf`, `readMemo`, `readTokenData`, `mint`, `mintDataToken`,
  `transfer`, `split`, `verify`, `isSpent`, `isOwnedBy`, `encodeToken`,
  `decodeToken`, `deliveryKeys`, and the optional `dispose` (worker-pool teardown).
- **The 3.x SDK surface** (visible only inside `token-engine/`): the three `create`/`split`
  builders take an options object where 2.x took trailing positionals, and
  `InclusionProofResponse.inclusionProof` is `InclusionProof | null` where **null IS "not certified
  yet"** — `isSpent` and the split pre-flight read the response, never a field inside the proof.
  Exact signatures are in the types; the CHANGELOG 0.15.0 entry lists the status-enum moves.
- **No request deadline is set on anything** (see the program bullet above for WHY it is
  money-critical): `expiresAt` is omitted on every mint, transfer, split burn and split mint leg.
- **Submit-status classification did NOT change.** `CLEAN_REJECT_STATUSES` — the proven
  "nothing certified" set that permits an abort — still excludes both 3.x additions.
  `SERVICE_NOT_READY` is instead RETRIED at the submit call site (`TransientSubmitAnswer` in
  `token-engine/proof-wait.ts`, sharing the one certification deadline): it is a 503 in a 200
  body, and left alone a booting gateway surfaced `CERTIFICATION_UNCONFIRMED`. `REQUEST_EXPIRED`
  must NEVER be retried. `TRANSACTION_HASH_MISMATCH` remains the only conflict signal.
- **`TokenBlob` is `{ tokenId, token }`** and `token` is the SDK's own `Token.toCBOR()` bytes —
  the sphere-private CBOR envelope (`token-engine/token-blob.ts`, tag 39051, `v`/`network` fields)
  was DELETED: nothing ever read `v` or `network`, and the wallet-api wire form was the inner
  bytes anyway. `deriveDeliveryKeys` decodes those bytes directly.
- **Split checkpoints are generation 2** (`token-engine/split-checkpoint.ts`): `CHECKPOINT_VERSION`
  1 → 2, `CHECKPOINT_SDK_VERSION` → `@unicitylabs/state-transition-sdk@3.0.1`. Every stored 2.x
  checkpoint is unreadable; the version check now names that cause instead of letting the
  byte-comparison blame "derivation drift" and send the reader hunting a realization bug.
- `Sphere` builds the engine from the oracle's config surface
  (`getTrustBaseJson()` / `getAggregatorUrl()` / `getApiKey()`) via
  `createSphereTokenEngine(EngineConfig)`. The trust base JSON is the single
  source of truth for the network id (`RootTrustBase.networkId`, e.g. testnet2 = 4).
- `SphereToken.sdkToken` is an OPAQUE handle — callers store it and hand it back
  to the engine, never call methods on it.
- **Verification is sequential by default; parallel is opt-in** (since 2.0.2). Pass
  `verification: { createWorker, poolSize? }` to `Sphere.init` (or `EngineConfig`)
  and `engine.verify` fans per-transfer work out to a worker pool. The entry
  script is the CONSUMER's (only their bundler can emit a worker) and its
  predicate verifier must match the engine's or the verdict silently diverges.
  Workers spawn lazily; `sphere.destroy()` / an address switch / an api-key change
  call `engine.dispose()` to terminate the pool. The consumer-facing entry-script contract is
  UNCHANGED by the 3.x bump (the SDK's `IWorker`/`WorkerTokenVerifier` declarations are
  diff-clean; only the main-thread side moved). See `docs/VERIFICATION-WORKERS.md`.
- **The engine is mandatory for money movement**: `send()` / `mint()` fail loudly
  (`AGGREGATOR_ERROR`) when the oracle does not supply a trust base + gateway URL.

### Single Identity Model
A single secp256k1 key pair backs the L3 identity:

```
mnemonic → master key → BIP32 derivation → identity
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        │  chainPubkey:   33-byte compressed pubkey │
                        │  directAddress: DIRECT://... (L3)         │
                        │  transportPubkey: derived for Nostr       │
                        └─────────────────────────────────────────────┘
```

The `DIRECT://` address is derived by `token-engine/identity.ts`
(`deriveDirectAddress`) — a vendored, byte-identical reproduction of the v1
derivation. It MUST stay stable: external systems (Quest XP) key user identity
on it.

### Key Types

```typescript
interface Identity {
  chainPubkey: string;      // 33-byte compressed secp256k1 (for L3)
  directAddress?: string;   // L3 DIRECT address
  ipnsName?: string;        // legacy derived id; retained for backup-format stability
  nametag?: string;         // Unicity ID (@username)
}

interface FullIdentity extends Identity {
  privateKey: string;       // secp256k1 private key (hex)
}

interface SendRequest {     // sphere.payments.send()
  recipient: string;        // @nametag, DIRECT://..., chain pubkey
  amount: string;           // Amount in smallest unit
  coinId: string;           // Coin ID (64-hex canonical; short symbols resolved via registry)
  memo?: string;            // Optional message (recipient-encrypted envelope)
}

interface TransferResult {
  readonly id: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';
  readonly tokens: Token[];
  readonly tokenTransfers: TokenTransferDetail[];  // { sourceTokenId, method: 'direct'|'split' }
  error?: string;
  deliveryPending?: boolean;                        // certified, mailbox deposit still owed
  deliveryState?: 'landed' | 'pending-delivery';
}

// token-engine sphere-domain types
interface TokenBlob {
  tokenId: string;   // genesis-stable 64-hex id (same across all states)
  token: Uint8Array; // the SDK's own Token.toCBOR() bytes — no sphere envelope
}

interface SphereToken {
  sdkToken: Token;          // OPAQUE SDK handle — never touch outside token-engine/
  blob: TokenBlob;          // serializable form
  value: SphereValue | null; // decoded { assets: [{ coinId, amount: bigint }] }
}
```

`Asset` keeps its full legacy shape for UI compatibility — the v2 presentation pins
`unconfirmedAmount: '0'` / `unconfirmedTokenCount: 0` (nothing is ever unconfirmed in server
custody) and still populates `transferringAmount`/`transferringTokenCount` for in-flight sends.

### Provider Pattern
Abstract interfaces for platform independence:

| Provider | Interface | Implementations |
|----------|-----------|-----------------|
| Storage | `StorageProvider` | IndexedDBStorageProvider (browser), FileStorageProvider (Node.js) |
| Transport | `TransportProvider` | NostrTransportProvider |
| Oracle | `OracleProvider` | UnicityAggregatorProvider |
| Price | `PriceProvider` | CoinGeckoPriceProvider |
| Money ports | `StoragePort` / `DeliveryPort` (`modules/payments-v2/ports.ts`) | WalletApiStoragePort, WalletApiDeliveryPort (`impl/wallet-api-v2/`) |

There is NO TokenStorageProvider — token custody is the wallet-api backend. The `walletApi`
member of the provider bundle is a plain transport CONFIG (`WalletApiTransportConfig`), not a
provider object.

**Oracle is a thin network-config provider.** Its surface:
- `initialize(trustBaseJson?)` — loads trust base via the platform loader unless passed explicitly
- `getTrustBaseJson()` / `getAggregatorUrl()` / `getApiKey()` — REQUIRED members; the engine is built from exactly these three

Custom `OracleProvider` implementations MUST provide the three config accessors.

### Network Configuration (`constants.ts` → `NETWORKS`)

| Network | Aggregator/Gateway | Status |
|---------|--------------------|--------|
| `testnet` | `https://gateway.testnet2.unicity.network` | ⭐ **Alias of testnet2** (the current gateway, trust-base networkId 4, testnet2 token registry) |
| `testnet2` | `https://gateway.testnet2.unicity.network` | Same config as `testnet` |
| `mainnet` | `gateway.mainnet.unicity.network` | Live v3 gateway; embedded trust base, **networkId 1** (pinned in `EXPECTED_NETWORK_ID`). No mainnet wallet-api yet, so the money path is unreachable; registry URL still the v1 testnet file; shares testnet's Nostr relay |

All networks share Nostr relays (`nostr-relay.testnet.unicity.network` for test
nets) and group relays per `NETWORKS`.
`assertNetworkConsistency()` (impl/shared/network.ts) refuses provably-broken
networks at provider creation (null or networkId-mismatched trust base).

**API key:** there is NO bundled default. Consumers inject `oracle.apiKey`
(plumbed through `createBrowserProviders`/`createNodeProviders` →
`UnicityAggregatorProvider` → engine). The testnet2 key is non-secret and
pre-filled in `.env.example`; a mainnet key is a secret.

## Common Commands

```bash
# Build (ESM + CJS via tsup, multiple entry points)
npm run build

# Test (watch mode)
npm test

# Test (single run)
npm run test:run

# Mutation probes (payments-v2, token-engine, wallet-api-v2, wiring; all must be KILLED)
npm run test:mutation

# E2E tests (live testnet2/staging; needs .env — see .env.example)
npm run test:e2e

# Relay integration tests (Docker testcontainers, or RELAY_URL=...)
npm run test:relay

# Lint
npm run lint

# Type check (+ tests project)
npm run typecheck
npm run typecheck:tests
```

⚠️ **Windows note:** the tsup DTS build is known to segfault on Windows +
Node 22.x. This is a local toolchain trap, NOT a real break — CI (Linux) is
authoritative for build success.

## Key Concepts

### P11 flip (what changed — see docs/MIGRATION-PAYMENTS-V2.md)
- **`sphere.payments` IS the v2 facade** (`assets`/`tokens`/`history`/`send`/`mint`/`receive`/
  `requests`), and since 0.15.0 the only accessor — the `paymentsV2` alias and the `paymentsV2:`
  init flag are both gone. The getter THROWS `NOT_INITIALIZED` where the alias returned `null`.
- **Removed wholesale:** the legacy `PaymentsModule` stack, `modules/accounting` (invoices),
  `modules/swap`, the S1 `WalletApiClient` (`wallet-api/` + `./wallet-api` subpath), own-storage
  token custody (`TokenStorageProvider` + both platform providers + `tokenStorage`/`tokensDir`
  options), the S7 `DeliveryProvider` port, the Nostr asset/payment-request rail (kinds
  31113/31115/31116), TXF types/serializer, `validation/`, `sphere.sync()`,
  `startWalletApiSession`/`resumeOpenIntents`/`walletApiSessionStatus`, the old event names,
  and the Connect invoice surface (2 queries, 9 intents, 2 scopes).
- **Kept deliberately:** `Sphere.importFromLegacyFile`/`detectLegacyFileType`/
  `isLegacyFileEncrypted` + `exportToTxt` (live onboarding/backup path);
  `Asset.unconfirmed*` fields (pinned 0); the `:pv2` deviceId suffix (deployed refresh-token
  rows are keyed `<deviceId>:pv2`); `core/wallet-api-protocol.ts` (cross-repo contract strings).
- **The ONE sanctioned refusal fossil**, deliberately KEPT through 0.15.0: `accounting:`/`swap:`
  init options throw typed `INVALID_CONFIG` — silent-ignore would hide that invoices/swaps no
  longer exist, and 0.15.0 is exactly the release where consumers re-integrate across the wire
  break.
- **Interop, as of the 3.x bump: there is none across the major.** Pre-0.15 clients (including
  the pre-flip ≤0.13 module clients that used to transact freely with the vertical over the same
  mailbox rail) speak the 2.x wire: nothing they wrote decodes here, and once the gateway cuts
  over nothing they write gets certified at all. That is what makes it a flag day — sphere-sdk,
  `wallet-api` and `aggregator-go` move together or not at all, with a testnet + backend reset
  alongside. Within 0.15.x the rail itself is unchanged: same mailbox, same raw `Token.toCBOR()`
  blobs, same predicates/trust base/memo envelope.

### Send Pipeline (money-safety)
- `send()` requires a recipient with a published chain pubkey (`INVALID_RECIPIENT` otherwise).
  Transfers lock to `SignaturePredicate(recipient chainPubkey)`.
- Concurrency: reservations ledger + op queue (`modules/payments-v2/select/`) — concurrent sends
  queue for sources instead of failing; open intents keep their sources reserved until resume
  adopts them.
- Durable-intent-first: the server records the intent BEFORE any chain op; every op posts a
  signed, field-encrypted progress checkpoint; the mailbox deposit and the signed complete close
  it. A crash at ANY stage resumes the SAME transferId — never a second spend (E.2/E.4, #631,
  #676, #690).
- **Never re-issue `send()` after a possibly-committed outcome** (`CERTIFICATION_UNCONFIRMED` /
  `isPossiblyCommittedSendOutcome()`): the intent stays OPEN and `facade.start()` converges it.
  A proven clean reject or `TransferConflictError` aborts (with #625 source demotion + one
  bounded re-plan).

### Receive & Verification
- Incoming tokens arrive as FINISHED SDK tokens via the wallet-api mailbox (continuous drain
  while started; `receive()` for an explicit one-shot).
- **Verified before entering the balance:** `engine.verify` (full trust-base proof check) +
  `engine.isOwnedBy(token, own chainPubkey)`; failures are rejected (warn log). Dedup by
  **(tokenId, stateHash)** via the durable seen-set — keyed on the genesis id alone, a token sent
  away and legitimately received back (A→B→A) would be dropped as a duplicate. Store-before-ack:
  the token is stored before the mailbox claim is acknowledged, so a crash re-claims instead of
  losing.

### Minting
- `payments.mint(coinIdHex, amount: bigint)` = **engine self-mint** (standalone SDK mint to the
  wallet's own pubkey, no faucet). Journal-first: the mint journal entry is durable before the
  chain op; a replay converges by idempotent same-seed re-call. Lets a fresh wallet top up on
  testnet2.

### Unicity IDs (nametags)
- Human-readable aliases (e.g., `@alice`) for receiving payments.
- **Registration = publishing the Nostr identity binding** (name ↔ chainPubkey,
  first-seen-wins is the global uniqueness guard). Runtime name resolution is
  Nostr-binding-only; receive is always `SignaturePredicate(chainPubkey)`;
  there is **no PROXY addressing anywhere**.
- The self-issued `UnicityIdToken` mint was REMOVED with the 2.0.0 SDK bump
  (upstream deleted the unicity-id primitive, state-transition-sdk-js#132) —
  registration is Nostr-binding-only.
- Recovered from Nostr when importing a wallet; each HD address can have its own.

### Peer Resolution
- `sphere.resolve(identifier)` — unified lookup via transport.
- Accepts: `@nametag`, `DIRECT://...`, chain pubkey (`02`/`03`),
  transport pubkey (64-hex). Returns `PeerInfo` or `null`.
- Identity binding event published on init/load — wallet discoverable without a Unicity ID.
- The payments vertical rides the same resolution for `send()`/`requests.create()` recipients;
  the recipient's network is pinned to the session network.

### Token Registry (Remote + Cached)
- `TokenRegistry` singleton provides token metadata (symbol, name, decimals,
  icons) by coin ID. No bundled data — remote URL per network
  (`NETWORKS[network].tokenRegistryUrl`; testnet/testnet2 use
  `unicity-ids.testnet2.json`) + persistent cache.
- The facade consumes it for Asset presentation and short-symbol → coinId resolution.
- Configured both by provider factories and by `Sphere` itself (tsup bundles
  duplicate the singleton per entry point — both bundle contexts need `configure()`).

### Durable client state (the complete inventory — design §6)
- Everything the client persists for money lives in the per-(network, address) scoped KV:
  `pv2g2:{network}:{chainPubkey}:*` inside the plain `StorageProvider` — refresh token, sync
  cursors, receive seen-set, intent backstop, delivery journal (#621), mint journal, request
  settling journal. One writer per store. Being self-prefixed with the network, it never rides
  the legacy `isNetworkScopedAddressKey` mechanism (which still guards the remaining
  chat/identity keys in the platform storage providers).
- **The `pv2:` → `pv2g2:` rename IS the 3.x local migration** (`modules/payments-v2/stores.ts`;
  `sweepSupersededState()` clears the old prefix once per composition, from
  `core/payments-v2-wiring.ts`). Not hygiene — money-critical: the sync-epoch latch lives in that
  KV, so after a backend reset a SURVIVING latch makes the session see a CHANGED epoch and run the
  restore protocol (`modules/payments-v2/restore.ts`), which re-PUTs every locally-open intent
  into the freshly wiped backend. Those intents reference tokens that no longer exist, so they can
  never complete — and the server now calls them open, so nothing can drop them: a permanent
  `pendingTransfers()` row holding its sources reserved, with no error surface. `Sphere.clear()`
  is not a mitigation (it calls `storage.clear()` with no prefix and takes the mnemonic with it).
  Under the new prefix the latch reads `null`, `noteEpoch` takes its `previous === null` early
  return, and no restore fires. Pinned by `tests/unit/payments-v2/kv-generation.test.ts` and a
  case in `tests/integration/sphere-payments-v2-wiring.test.ts`. A prefix must never START with a
  superseded one — the sweep matches by `startsWith`, so `pv2:g2:` would have deleted itself.
- Chat/identity keys stay network-agnostic; storage providers keep their `network` parameter
  for the legacy scoped keys.

### IndexedDB Databases (Browser)

| Database | Provider | Purpose |
|----------|----------|---------|
| `sphere-storage` | `IndexedDBStorageProvider` | Wallet keys, per-address data, `pv2g2:*` scoped KV |

`Sphere.clear({ storage })` deletes it (both KV generations with it) and sweeps orphaned
pre-flip `sphere-token-storage-*` databases.

## Testing

**Framework:** Vitest
**Run:** `npm run test:run` (unit/integration), `npm run test:mutation` (probes must be KILLED),
`npm run test:e2e` (live staging/testnet2, needs `.env`), `npm run test:relay`,
`npm run test:aggregator` (a REAL aggregator-go, stood up by Testcontainers — needs Docker,
no manual setup and no local build)

**Know what each layer can and cannot prove.** Everything else that exercises the chain runs
against `TestAggregatorClient`, which orchestrates the SDK's OWN smt / CertificationData /
verification rule — so it proves this client is self-consistent, never that the client and the
SERVICE agree. `tests/integration/sphere-payments-v2-*` prove less about the wire still: they
swap a fake engine in via `setEngine`, so they pin facade orchestration and would pass with the
CBOR wrong. Only `tests/aggregator/` closes that gap.

Key test areas:
- `tests/unit/payments-v2/` — the vertical: TransferMachine send/resume, receive drain,
  requests, mint journal, history, facade assembly, inventory presentation, the KV generation
  rename (`kv-generation.test.ts`), adversarial fakes (`fakes/FakeWalletApi` — 61 behavior pins —
  + FakeGateway), port contract suites
  (`contracts/{storage,delivery}-port.contract.ts` — swappability enforced)
- `tests/aggregator/` — the real engine against a REAL aggregator-go v3, stood up by
  Testcontainers (`npm run test:aggregator`; ~1m45s cold). `docker/docker-compose.yml` is copied
  from state-transition-sdk-js, which the Java SDK mirrors too — keep the three in step, or
  "passes against a real aggregator" means something different in each repo. It pins a prebuilt
  `ghcr.io/unicitynetwork/aggregator-go` image rather than building rocksdb locally.
  `support/aggregatorStack.ts` waits for consensus to CERTIFY A ROUND, not merely for health:
  until it has a reference time the service answers every request `SERVICE_NOT_READY`.
  Mint / transfer / split / same-transferId resume, each verified against the service's own
  generated trust base. `verify()` passing is the assertion no fake can make: the leaf value this
  client computes — `H(transactionHash, referenceTime)` since 3.x — reproduces the leaf the Go
  service inserted. Guard against it going vacuous: with a well-formed but WRONG root key it must
  fail `INVALID_TRUSTBASE`.
- `tests/mutation/probes.json` — mutation probes over `modules/payments-v2/*`,
  `token-engine/{proof-wait,SphereTokenEngine}.ts`, `impl/wallet-api-v2/*`, the `core/` wiring and
  `transport/NostrTransportProvider.ts`; `npm run test:mutation` must report every one KILLED
  (a probe count belongs in the file, not here — it has gone stale twice)
- `tests/unit/token-engine/` — engine contract, factory, FakeTokenEngine,
  identity golden test (`identity.test.ts` locks the DIRECT:// derivation),
  `expires-at.test.ts` (no deadline on any submitted request nor on the token itself; two
  transactions differing ONLY in the deadline share a StateId but not a transaction hash; a
  24-hour clock jump between two attempts still rebuilds byte-identical bytes; `REQUEST_EXPIRED`
  and `SERVICE_NOT_READY` end keep-open, and a booting gateway is retried through),
  `wire-version.test.ts` (a real 2.1.0-encoded token from `fixtures/token-sdk-2.1.0.hex` is
  refused with an error naming the version — that fixture is uncapturable once the pin moves
  again), `proof-deadline.test.ts` (the abort guard)
- `tests/unit/connect/` — protocol surface guard (14/6/13 counts), lock semantics,
  payments-compat adapter conformance (36 tests: old wire names/payloads from the v2 facade,
  against a mock Sphere whose `payments` getter THROWS exactly like the real one)
- `tests/unit/core/` — Sphere lifecycle, clear, nametag sync/recovery, wallet-api-protocol pins
- `tests/integration/` — Sphere payments wiring (defaults + walletApi config, incl. the
  superseded-`pv2:` sweep on composition), per-address KV bleed invariants, kv/file network
  isolation, wallet lifecycle
- `tests/e2e/` — live staging: `payments-v2-vertical.staging` (money matrix incl. splits +
  crash-resume), `sphere-paymentsv2-wiring.staging` (the REAL Sphere composition),
  `wallet-api-v2-session.staging`, `token-engine.testnet2`
- `tests/relay/groupchat-relay.test.ts` — NIP-29 relay integration (Docker + remote)

## Dependencies

**Core (from package.json):**
- `@unicitylabs/state-transition-sdk` — **pinned `3.0.1`** (exact; imported only via `token-engine/sdk.ts`)
- `@unicitylabs/nostr-js-sdk` `^0.6.0` — Nostr protocol
- `@noble/hashes` `^2`, `@noble/curves` `^2`, `@noble/ciphers` `^2` — cryptography
- `bip39`, `crypto-js`, `canonicalize`, `buffer`

**Optional/peer (Node WebSocket):**
- `ws` `>=8.0.0` — Node.js WebSocket (peer, `peerDependenciesMeta.optional`)

## File Size Reference

Largest files (for context):
- `core/Sphere.ts` — wallet lifecycle (~4,000 lines post-flip)
- `modules/payments-v2/machine/TransferMachine.ts` — the send/resume machine
- `modules/payments-v2/PaymentsFacade.ts` — facade + lifecycle
- `impl/wallet-api-v2/session.ts` — auth cell + wake socket

## Code Style

- TypeScript strict mode
- ESLint with TypeScript rules (+ the token-engine SDK import boundary)
- ESM modules (with CJS build output)
- Prefer `interface` over `type` for objects
- Use `readonly` for immutable properties
- Async/await over raw promises
