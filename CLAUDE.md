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
  `TransferConflictError`). The `STATE_ID_EXISTS` aggregator lag is OVER (M7 live e2e observed
  2026-06-12: the gateway answers `SUCCESS` for duplicate AND conflicting submits — the status
  carries no conflict signal; see the dated OBSERVED note in `../wallet-api/sdk-changes.md` E.2);
  tolerant parsing shipped via state-transition-sdk-js#125 and stays.
- **Ports rule (design §10 / covenant):** the money ports are `StoragePort` and `DeliveryPort`
  (`modules/payments-v2/ports.ts`) — independent, swappable, contract-test-enforced
  (`tests/unit/payments-v2/contracts/`); the Sphere frontend is a **view** — no provider-specific
  logic outside implementations; custody (`intoInventory`) is a composition-time property, never a
  per-call flag.
- **Never weaken a test to make it pass**; no `.skip`/`.only`. Known pre-existing flaky/failing
  tests are tracked in #487.
- **Releases:** npm dev versions publish via `publish.yml` (workflow_dispatch, version input) —
  current line **`0.14.0-dev.#`**, dist-tag `dev`. Consumers (wallet-api backend, sphere frontend)
  pin exact dev versions. The backend consumes ONLY the `./token-engine` subpath (must stay
  browser/Nostr-free — keep `token-engine/` clean).
- Pinned base SDK: `@unicitylabs/state-transition-sdk@2.0.3` (stable release; bump only via PR).
  2.0.3 fixes the lost-abort hang in `waitInclusionProof` (state-transition-sdk-js#140/#141):
  its poll loop now checks `aborted` before subscribing, races each poll against the
  signal, and cancels the in-flight request. `tests/unit/token-engine/proof-deadline.test.ts`
  is the guard that it keeps doing so — do not delete it on a future bump.

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
  network: 'testnet', // alias of testnet2 — the v2 gateway network
  oracle: { apiKey: 'sk_...' },
});
// Node.js: createNodeProviders({ network: 'testnet', oracle: { apiKey: 'sk_...' },
//                                dataDir: './sphere-data' })

// 2. Attach the wallet-api transport config — REQUIRED for money. Sphere.init
//    throws INVALID_CONFIG without `walletApi`; tokens are server-custody
//    (the wallet-api backend holds inventory; keys stay local).
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.example',  // wallet-api backend
  network: 'testnet2',
  deviceId: 'my-device',                  // stable per device — keeps the refresh-token row
});

// 3. Init wallet (creates new OR loads existing — single entry point)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,   // Generate mnemonic if no wallet exists
  nametag: 'alice',     // Optional: register @alice (only on create)
  password: 'secret',   // Optional: encrypt mnemonic (plaintext if omitted)
});
// NOTE: `accounting: true` / `swap: true` THROW INVALID_CONFIG — invoicing and
// swaps no longer exist in the SDK (P11 flip). `paymentsV2: true` is a
// deprecated no-op for one release.

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
//    coinId must be even-length lowercase hex (the canonical v2 AssetId form)
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
| `Sphere.clear({ storage })` | `void` | Delete all wallet data (KV incl. `pv2:*` + orphaned pre-flip token DBs) |
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
- `sphere.paymentsV2` is a **deprecated alias** of `sphere.payments` (same facade), kept one
  release for the live frontend; new code uses `sphere.payments`.
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
| `history:updated` | `{}` | History changed |
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
- **L3 (Unicity state transition network)** - Token transfers via the **v2 state-transition SDK**, consumed exclusively through the `token-engine/` port. Wallets are L3-only.
- **Money custody:** wallet-api backend (server inventory + mailbox delivery). Nostr carries DMs, group chat and nametag bindings ONLY — no asset or payment-request traffic.

**Version:** `0.14.0-dev.#` line — see `package.json` for the exact current version (post P11 flip; see CHANGELOG `[Unreleased]`)
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
├── token-engine/            # ⭐ Anti-corruption layer over the v2 state-transition SDK
│   ├── engine.ts           # ITokenEngine port (frozen contract) + EngineConfig
│   ├── types.ts            # Sphere-domain types: SphereToken, TokenBlob, Mint/Transfer/SplitParams
│   ├── factory.ts          # createSphereTokenEngine(config)
│   ├── SphereTokenEngine.ts # The real adapter (engine implementation)
│   ├── SpherePaymentData.ts # Value envelope codec (coins inside v2 tokens)
│   ├── token-blob.ts       # TokenBlob CBOR encode/decode
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
│   │   ├── stores.ts              # pv2:{network}:{pubkey}: scoped KV — §6 durable state
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
  KV (`pv2:{network}:{chainPubkey}:*` in the plain `StorageProvider`) with the refresh token,
  cursors, seen-set and journals — nothing else. There is no client token store to sync
  (`sphere.sync()` is gone).
- **Composition:** `Sphere.init({ walletApi })` → `resolvePaymentsV2Composition` →
  `composePaymentsV2` builds one `PaymentsFacade` per active address over the wallet-api-v2
  ports (`WalletApiStoragePort`, `WalletApiDeliveryPort`, `WalletApiSplitCheckpointStore`) and
  a `WalletApiSession` (challenge sign-in → JWT + refresh token, wake WebSocket, single-flight
  re-auth). The `paymentsV2Transport` seam in the config injects a whole custom bundle (tests,
  custom hosts). Init is FAIL-CLOSED: no `walletApi` → `INVALID_CONFIG`, before any storage write.
- **Send:** `TransferMachine` — durable intent on the server first (`putIntent`), then engine
  ops (transfer/split), per-op progress checkpoints (field-encrypted, signed), mailbox deposit,
  signed complete (`completeSignMessage` — the server's seedGate verifies it). Resume is THE SAME
  machine replaying the SAME transferId — runs inside `facade.start()` (off critical path),
  never re-issues a spend. A possibly-committed outcome keeps the intent OPEN (never a fresh
  send); a clean conflict with a demoted source triggers one bounded re-plan (#625 marks the
  source `suspectedSpent`, excluded from selection, recoverable by resync).
- **Receive:** continuous mailbox drain while started + explicit `receive()`. Every incoming
  token is engine-verified and ownership-checked BEFORE entering the balance; seen-set dedup by
  genesis tokenId; store-before-ack (a crash between store and claim re-claims, never loses).
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

### Token Engine (v2) — the only chain-op path

The canonical package name resolves to the **v2 SDK, pinned `2.0.3`** (stable).

- The SDK is imported in exactly ONE file: `token-engine/sdk.ts`. An ESLint
  `no-restricted-imports` rule blocks any other import of
  `@unicitylabs/state-transition-sdk` — everything else codes against the
  `ITokenEngine` port and sphere-domain types from `token-engine/`.
- `ITokenEngine` operations: `getIdentity`, `deriveIdentityAddress`, `tokenId`,
  `readValue`, `balanceOf`, `readMemo`, `readTokenData`, `mint`, `mintDataToken`,
  `transfer`, `split`, `verify`, `isSpent`, `isOwnedBy`, `encodeToken`,
  `decodeToken`, `deliveryKeys`, and the optional `dispose` (worker-pool teardown).
- `Sphere` builds the engine from the oracle's config surface
  (`getTrustBaseJson()` / `getAggregatorUrl()` / `getApiKey()`) via
  `createSphereTokenEngine(EngineConfig)`. The trust base JSON is the single
  source of truth for the network id (`RootTrustBase.networkId`, e.g. testnet2 = 4).
- `SphereToken.sdkToken` is an OPAQUE handle — callers store it and hand it back
  to the engine, never call methods on it.
- **Verification is sequential by default; parallel is opt-in** (2.0.2+). Pass
  `verification: { createWorker, poolSize? }` to `Sphere.init` (or `EngineConfig`)
  and `engine.verify` fans per-transfer work out to a worker pool. The entry
  script is the CONSUMER's (only their bundler can emit a worker) and its
  predicate verifier must match the engine's or the verdict silently diverges.
  Workers spawn lazily; `sphere.destroy()` / an address switch / an api-key change
  call `engine.dispose()` to terminate the pool. See `docs/VERIFICATION-WORKERS.md`.
- **The engine is mandatory for money movement**: `send()` / `mint()` fail loudly
  (`AGGREGATOR_ERROR`) when the oracle does not supply a v2 trust base + gateway URL.

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
  v: number;        // blob format version (sphere storage migrations)
  network: number;  // NetworkId.id
  tokenId: string;  // genesis-stable 64-hex id (same across all states)
  token: Uint8Array; // CBOR of the v2 Token
}

interface SphereToken {
  sdkToken: Token;          // OPAQUE v2 SDK handle — never touch outside token-engine/
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
- `getTrustBaseJson()` / `getAggregatorUrl()` / `getApiKey()` — REQUIRED members; the v2 engine is built from exactly these three

Custom `OracleProvider` implementations MUST provide the three config accessors.

### Network Configuration (`constants.ts` → `NETWORKS`)

| Network | Aggregator/Gateway | Status |
|---------|--------------------|--------|
| `testnet` | `https://gateway.testnet2.unicity.network` | ⭐ **Alias of testnet2** (v2 gateway, trust-base networkId 4, testnet2 token registry) |
| `testnet2` | `https://gateway.testnet2.unicity.network` | Same config as `testnet` |
| `mainnet` | `aggregator.unicity.network/rpc` | v1-era; **no embedded trust base** — provider factories refuse it (`INVALID_CONFIG`) |
| `dev` | `dev-aggregator.dyndns.org/rpc` | v1-era aggregator — wallet operations fail loudly (`AGGREGATOR_ERROR`) until cut over |

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

# Mutation probes (17 probes over payments-v2 + wallet-api-v2; all must be KILLED)
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
  `requests`); `sphere.paymentsV2` is a deprecated alias for one release.
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
- **The ONE sanctioned refusal fossil** (revisit after one release): `accounting:`/`swap:` init
  options throw typed `INVALID_CONFIG` — silent-ignore would hide that invoices/swaps no longer
  exist.
- **Interop:** old (≤0.13 module) and v2 clients transact freely — same mailbox rail, same raw
  `Token.toCBOR()` blobs, same predicates/trust base/memo envelope. Witnessed live 4/4 on
  deployed staging (see MIGRATION guide §5). Pre-wallet-api (Nostr-asset era) clients are NOT
  reachable — a v2 send waits in their mailbox until they upgrade.

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
- Incoming tokens arrive as FINISHED v2 tokens via the wallet-api mailbox (continuous drain
  while started; `receive()` for an explicit one-shot).
- **Verified before entering the balance:** `engine.verify` (full trust-base proof check) +
  `engine.isOwnedBy(token, own chainPubkey)`; failures are rejected (warn log). Dedup by
  genesis-stable tokenId via the durable seen-set. Store-before-ack: the token is stored before
  the mailbox claim is acknowledged, so a crash re-claims instead of losing.

### Minting
- `payments.mint(coinIdHex, amount: bigint)` = **engine self-mint** (v2 standalone mint to the
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
  `pv2:{network}:{chainPubkey}:*` inside the plain `StorageProvider` — refresh token, sync
  cursors, receive seen-set, intent backstop, delivery journal (#621), mint journal, request
  settling journal. One writer per store. Being self-prefixed with the network, it never rides
  the legacy `isNetworkScopedAddressKey` mechanism (which still guards the remaining
  chat/identity keys in the platform storage providers).
- Chat/identity keys stay network-agnostic; storage providers keep their `network` parameter
  for the legacy scoped keys.

### IndexedDB Databases (Browser)

| Database | Provider | Purpose |
|----------|----------|---------|
| `sphere-storage` | `IndexedDBStorageProvider` | Wallet keys, per-address data, `pv2:*` scoped KV |

`Sphere.clear({ storage })` deletes it (including the pv2 scoped KV) and sweeps orphaned
pre-flip `sphere-token-storage-*` databases.

## Testing

**Framework:** Vitest
**Run:** `npm run test:run` (unit/integration), `npm run test:mutation` (probes must be KILLED),
`npm run test:e2e` (live staging/testnet2, needs `.env`), `npm run test:relay`

Key test areas:
- `tests/unit/payments-v2/` — the vertical: TransferMachine send/resume, receive drain,
  requests, mint journal, history, facade assembly, inventory presentation, adversarial fakes
  (`fakes/FakeWalletApi` — 61 behavior pins — + FakeGateway), port contract suites
  (`contracts/{storage,delivery}-port.contract.ts` — swappability enforced)
- `tests/mutation/probes.json` — 17 mutation probes over `modules/payments-v2/*` and
  `impl/wallet-api-v2/*`; `npm run test:mutation` must report all KILLED
- `tests/unit/token-engine/` — engine contract, factory, FakeTokenEngine,
  identity golden test (`identity.test.ts` locks the DIRECT:// derivation), token-blob codec
- `tests/unit/connect/` — protocol surface guard (14/6/13 counts), lock semantics,
  payments-compat adapter conformance (34 tests: old wire names/payloads from the v2 facade)
- `tests/unit/core/` — Sphere lifecycle, clear, nametag sync/recovery, wallet-api-protocol pins
- `tests/integration/` — Sphere payments wiring (defaults + walletApi config), per-address KV
  bleed invariants, kv/file network isolation, wallet lifecycle
- `tests/e2e/` — live staging: `payments-v2-vertical.staging` (money matrix incl. splits +
  crash-resume), `sphere-paymentsv2-wiring.staging` (the REAL Sphere composition),
  `wallet-api-v2-session.staging`, `token-engine.testnet2`
- `tests/relay/groupchat-relay.test.ts` — NIP-29 relay integration (Docker + remote)

## Dependencies

**Core (from package.json):**
- `@unicitylabs/state-transition-sdk` — **pinned `2.0.3`** (v2 engine; imported only via `token-engine/sdk.ts`)
- `@unicitylabs/nostr-js-sdk` `^0.5.0` — Nostr protocol
- `@noble/hashes` `^2`, `@noble/curves` `^2` — cryptography
- `bip39`, `elliptic`, `crypto-js`, `canonicalize`, `buffer`

**Optional/peer (Node WebSocket):**
- `ws` — Node.js WebSocket (peer, optional)

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
