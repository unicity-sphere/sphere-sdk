# Sphere SDK Integration Guide

> **Quick Start**: For a fast setup, see the platform-specific guides:
> - [Browser Quick Start](./QUICKSTART-BROWSER.md) - Web applications
> - [Node.js Quick Start](./QUICKSTART-NODEJS.md) - Server-side / CLI
> - [Connect Protocol](./CONNECT.md) - Wallet ↔ dApp communication
>
> This document covers advanced integration patterns, the v2 wallet composition model, custom provider implementations, and production custody patterns.

## Table of Contents

1. [Setup](#setup)
2. [Wallet Composition](#wallet-composition)
3. [Custody Model](#custody-model)
4. [Wallet Operations](#wallet-operations)
5. [L3 Payments](#l3-payments)
6. [Payment Requests](#payment-requests)
7. [Communications](#communications)
8. [Custom Providers](#custom-providers)
9. [Events](#events)
10. [Error Handling](#error-handling)
11. [Testing](#testing)

---

## Setup

### Step 1: Create Base Providers

The first step is to create a base provider bundle with storage, transport, and oracle configuration:

```typescript
// Browser (requires CORS proxy for free CoinGecko API — see "CORS Proxy" section below)
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

const baseProviders = createBrowserProviders({
  network: 'testnet',  // = testnet2: the v2 gateway network (gateway.testnet2.unicity.network)
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',  // testnet2 public key (NOT secret)
  },
  price: {
    platform: 'coingecko',
    baseUrl: '/api/coingecko',  // CORS proxy path (see "CORS Proxy" section)
  },
});
```

```typescript
// Node.js (no proxy needed)
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const baseProviders = createNodeProviders({
  network: 'testnet',  // = testnet2 (alias 'testnet2' also accepted)
  dataDir: './wallet-data',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',  // testnet2 public key
  },
  price: { platform: 'coingecko', apiKey: 'CG-xxx' },  // Optional
});
```

### Networks (Post v1-Cutover)

- **testnet / testnet2**: v2 state-transition gateway network. `testnet` is an alias for `testnet2`. Both resolve to `gateway.testnet2.unicity.network`.
- **mainnet / dev**: Still point at v1-era aggregators. The v2 token engine **cannot** operate against them and will fail loudly with `AGGREGATOR_ERROR` until these gateways are cut over.

### Aggregator API Key

The SDK does **not** ship a default aggregator API key. Pass it explicitly via `oracle.apiKey` when creating providers:

- **testnet / testnet2 keys are NOT secret** — safe to commit in `.env.example` and show in docs.
- **mainnet keys ARE secret** — keep them only in your deploy environment, never committed.

If no `apiKey` is provided, the v2 token engine still constructs, but its gateway requests are unauthenticated and the SDK logs a `TokenEngine` warning. On testnet2, an explicit key is **required** for `send()` and `mint()` operations.

---

## Wallet Composition

### Money requires the wallet-api transport config — init fails closed

Money moves ONLY through the wallet-api vertical. `Sphere.init` **throws `INVALID_CONFIG`**
when the provider bundle carries no `walletApi` transport config — there is no silent
degraded mode. `createWalletApiProviders` builds the config.

### Step 2: Attach the Wallet-Api Transport Config

```typescript
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const providers = createWalletApiProviders(baseProviders, {
  baseUrl: 'https://wallet-api.unicity.network',  // Canonical wallet-api host for testnet2
  network: 'testnet2',
  deviceId: 'my-stable-device-id',  // Stable identifier for this device (e.g., UUID or hostname)
});

// providers now includes:
// - all baseProviders (storage, transport, oracle)
// - walletApi: WalletApiTransportConfig — the plain config the payments
//   vertical is composed from ({ network, baseUrl, deviceId })
```

**WalletApiCompositionConfig:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | string | Yes* | Base URL of the wallet-api instance (e.g., `https://wallet-api.unicity.network` for testnet2). *Not required when `paymentsV2Transport` is supplied. |
| `network` | string | Yes | Network identifier; must match the base providers' network (`testnet2`, `testnet`, etc.) |
| `deviceId` | string | No | Stable device label — the refresh-token row's key. If omitted, a random UUID is generated and every run performs a fresh challenge sign-in. |
| `fetchFn` | function | No | Injectable fetch (defaults to `globalThis.fetch`) |
| `webSocketFactory` | function | No | Injectable WebSocket factory (e.g. the `ws` package on Node < 22) |
| `paymentsV2Transport` | function | No | DI seam: supply the whole per-address transport bundle (`{ session, client }`) — offline tests, custom hosts |

### Step 3: Initialize the Wallet

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';

const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,  // storage, transport, oracle, walletApi
  autoGenerate: true,  // Generate mnemonic if no wallet exists
  nametag: 'alice',    // Optional: register @alice nametag
  password: 'secret',  // Optional: encrypt mnemonic (PBKDF2; plaintext if omitted)
});

if (created && generatedMnemonic) {
  // First launch — show mnemonic to user for backup
  console.log('Save this mnemonic:', generatedMnemonic);
}

console.log('Address:', sphere.identity?.directAddress);  // DIRECT://... (L3)
```

**Removed init options (P11 flip):** `accounting: true` / `swap: true` **throw** typed
`INVALID_CONFIG` (invoicing and swaps no longer exist in the SDK); `paymentsV2: true` is a
deprecated no-op for one release; `tokenStorage` / `delivery` no longer exist.

### Complete Node.js Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// Step 1: Base providers
const baseProviders = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
});

// Step 2: Attach the wallet-api transport config
const providers = createWalletApiProviders(baseProviders, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId: 'my-stable-device-id',
});

// Step 3: Initialize wallet
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});

// Step 4: Use payments (sender-driven, certified on-chain, delivered via mailbox)
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  memo: 'hi',
});

console.log('Status:', result.status);  // 'completed'
console.log('Delivery pending:', result.deliveryPending);  // true = certified on-chain, mailbox deposit deferred (NORMAL)

// Receive tokens (explicit drain; automatic while running)
const { transfers } = await sphere.payments.receive();
```

---

## Custody Model

Token custody is **server-side**: the wallet-api backend holds the token inventory, transfer
intents, delivery mailbox, history and payment requests. The client holds the keys (nothing
money-critical can happen without the wallet's signatures) plus a small per-address durable KV
(`pv2:{network}:{chainPubkey}:*` in the plain `StorageProvider`) — refresh token, sync cursors,
receive seen-set, and the intent/delivery/mint journals.

- **Multi-device**: inventory is server-backed, so a second device signs in (challenge → JWT)
  and sees the same funds. `deviceId` keys the per-device refresh-token row.
- **Trust boundary**: the server is *record*, not *authority* — every incoming token is
  verified against the trust base (engine.verify + ownership) BEFORE it enters the balance,
  and every spend is signed client-side.
- **Own-storage custody was rescinded** (spec amendment, wallet-api sdk-changes S7): there is
  no local token store and no `TokenStorageProvider` port. What remains swappable is the
  transport — the `paymentsV2Transport` seam injects a whole custom wire (tests, custom hosts),
  and the `StoragePort`/`DeliveryPort` contracts (`modules/payments-v2/ports.ts`) are
  contract-test-enforced.

---

## Wallet Operations

### Check if Wallet Exists

```typescript
const exists = await Sphere.exists(providers.storage);
```

### Create or Load Wallet (Recommended)

```typescript
// Sphere.init() handles both creation and loading automatically
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,  // Generate mnemonic if wallet doesn't exist
  nametag: 'alice',    // Optional: register nametag
});

if (created && generatedMnemonic) {
  console.log('Backup these words:', generatedMnemonic);
}
```

### Import from Mnemonic

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'abandon abandon abandon ...',
});
```

### Get Identity

```typescript
const identity = sphere.identity;

console.log('Chain Pubkey:', identity.chainPubkey);   // 33-byte compressed secp256k1
console.log('Direct Address:', identity.directAddress); // DIRECT://... (L3)
console.log('Nametag:', identity.nametag);            // e.g., 'alice'
```

### Clear Wallet

```typescript
await Sphere.clear({ storage: providers.storage });
// Clears the KV store (keys + pv2:* payment journals); in the browser it also
// sweeps orphaned pre-flip sphere-token-storage-* databases.
```

### Multi-Address Derivation

SDK2 supports HD (Hierarchical Deterministic) address derivation following BIP32/BIP44 standards.

```typescript
// Derive additional receiving addresses
const addr1 = sphere.deriveAddress(1);  // m/44'/0'/0'/0/1
const addr2 = sphere.deriveAddress(2);  // m/44'/0'/0'/0/2

console.log('Address 1:', addr1.address);
console.log('Address 2:', addr2.address);

// Derive change addresses
const change0 = sphere.deriveAddress(0, true);  // m/44'/0'/0'/1/0

// Derive at arbitrary path
const custom = sphere.deriveAddressAtPath("m/44'/0'/0'/0/10");

// Get multiple addresses at once
const addresses = sphere.deriveAddresses(5);  // First 5 receiving addresses
const allAddrs = sphere.deriveAddresses(5, true);  // 5 receiving + 5 change

// Check derivation capability
if (sphere.hasMasterKey()) {
  console.log('HD derivation available');
  console.log('Base path:', sphere.getBasePath());
}
```

Each derived address has its own keypair but shares the same master seed:

```typescript
interface AddressInfo {
  privateKey: string;  // Unique per address
  publicKey: string;   // Unique per address
  path: string;        // Full BIP32 path
  index: number;       // Address index
}
```

### Tracked Addresses

The SDK tracks which addresses have been activated (via create, switchToAddress, registerNametag). This lets UI display the list of used addresses with metadata.

```typescript
// Get all active (non-hidden) addresses
const addresses = sphere.getActiveAddresses();
for (const addr of addresses) {
  console.log(`#${addr.index}: ${addr.directAddress}`);
  console.log(`  Nametag: ${addr.nametag ?? 'none'}`);
  console.log(`  Created: ${new Date(addr.createdAt)}`);
}

// Switch to a new address (auto-tracked)
await sphere.switchToAddress(2);

// Register nametag for current address
await sphere.registerNametag('bob');

// Hide an address from UI
await sphere.setAddressHidden(1, true);

// Get all including hidden
const all = sphere.getAllTrackedAddresses();

// Get single address
const addr = sphere.getTrackedAddress(0);

// Listen for new address activations
sphere.on('address:activated', ({ address }) => {
  console.log(`New address tracked: #${address.index}`);
});

sphere.on('address:hidden', ({ index, addressId }) => {
  console.log(`Address #${index} hidden`);
});
```

---

## L3 Payments

L3 is the primary payment layer. Transfers are **sender-driven** (v2): the sender's token engine
certifies the transfer on-chain via the gateway and delivers a **finished** token to the
recipient over the wallet-api mailbox — the recipient verifies it and stores it as `'confirmed'` immediately.

### Typical Wallet Flow

```typescript
// 1. Init wallet (walletApi config required)
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true, nametag: 'alice' });

// 2. Check what tokens we have
const assets = await sphere.payments.assets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
}

// 3. Send tokens
const result = await sphere.payments.send({
  recipient: '@bob',
  amount: '1000000',
  coinId: 'UCT',
});

// 4. Listen for incoming transfers
sphere.on('transfer:incoming', (transfer) => {
  console.log(`Received from ${transfer.senderNametag}: ${transfer.tokens.length} tokens`);
});

// 5. View history (server read-through, paged)
const page = await sphere.payments.history({ limit: 50 });

// 6. Cleanup
await sphere.destroy();
```

There is no `sync()` and no `validate()`: the server is the record (nothing to flush), and
every incoming token is verified before it enters the balance.

### Get Balance & Assets

```typescript
// Aggregated balances by coin, with price data when a PriceProvider is configured
const assets = await sphere.payments.assets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  console.log(`  Price: $${asset.priceUsd ?? 'N/A'}`);
  console.log(`  Value: $${asset.fiatValueUsd?.toFixed(2) ?? 'N/A'}`);
  console.log(`  24h change: ${asset.change24h ?? 'N/A'}%`);
}

// Filter to a single coin
const uctAssets = await sphere.payments.assets(coinIdHex);

// Total portfolio value in USD
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
```

The `Asset` shape is unchanged from pre-flip releases: `unconfirmedAmount`/`unconfirmedTokenCount`
are pinned `'0'`/`0` (nothing is ever unconfirmed in server custody);
`transferringAmount`/`transferringTokenCount` still report in-flight sends.

### Get Individual Tokens

```typescript
// All tokens (synchronous inventory view)
const tokens = sphere.payments.tokens();

for (const token of tokens) {
  console.log(`Token ${token.id}: ${token.amount} ${token.symbol}`);
  console.log(`  Coin ID: ${token.coinId}`);
}

// Filter by coin
const uctTokens = sphere.payments.tokens({ coinId: coinIdHex });
```

Lazy tokens (blob not yet downloaded) carry value metadata only; the blob is fetched on demand
when the token is selected for a spend.

### Send Tokens

```typescript
// Send to nametag (resolved via Nostr)
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  memo: 'Payment for coffee',
});

// Send to DIRECT address
const result = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId: 'UCT',
});

// Send to chain pubkey (33-byte compressed secp256k1)
const result = await sphere.payments.send({
  recipient: '02abc123...',
  amount: '500000',
  coinId: 'UCT',
});

// Check result
console.log('Transfer ID:', result.id);
console.log('Status:', result.status);  // 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed'
console.log('Delivery pending:', result.deliveryPending);  // true means on-chain but recipient mailbox deposit deferred
if (result.error) {
  console.error('Error:', result.error);
}
```

**SendRequest fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `recipient` | Yes | `@nametag`, `DIRECT://...`, or chain pubkey |
| `amount` | Yes | Amount in smallest unit (string) |
| `coinId` | Yes | Token coin ID (64-hex canonical; short symbols resolve via registry) |
| `memo` | No | Optional message (recipient-encrypted envelope) |

The recipient must have a **published chain pubkey** (Nostr identity binding) — otherwise
`send()` throws `INVALID_RECIPIENT`. The token engine must be available (oracle with a v2
trust base + gateway URL) — otherwise `AGGREGATOR_ERROR`.

### Receive Tokens

Incoming tokens arrive automatically via the wallet-api mailbox while the wallet runs.
Subscribe to the event:

```typescript
sphere.on('transfer:incoming', (transfer) => {
  console.log('Sender:', transfer.senderPubkey);
  console.log('Sender nametag:', transfer.senderNametag);
  console.log('Tokens:', transfer.tokens.length);
  console.log('Received at:', new Date(transfer.receivedAt));
});
```

For batch/CLI applications that need explicit receive (one-shot drain):

```typescript
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);
```

Every incoming token is engine-verified against the trust base and ownership-checked BEFORE it
enters the balance; dedup is by genesis-stable tokenId via a durable seen-set; tokens are stored
before the mailbox claim is acknowledged (a crash re-claims, never loses).

### Transaction History

Server read-through, paged, newest-first:

```typescript
const page = await sphere.payments.history({ limit: 50 });

for (const entry of page.entries) {
  console.log(`${entry.type}: ${entry.amount} ${entry.coinId}`);
  console.log(`  Date: ${new Date(entry.timestamp)}`);
  if (entry.recipientNametag) {
    console.log(`  To: @${entry.recipientNametag}`);
  }
}

if (page.more) {
  const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });
}
```

### Peer Resolution

```typescript
// Resolve any identifier to PeerInfo (nametag, address, pubkey)
const peer = await sphere.resolve('@alice');
if (peer) {
  console.log('Chain pubkey:', peer.chainPubkey);
  console.log('Direct address:', peer.directAddress);
  console.log('Nametag:', peer.nametag);
}
```

### Price Provider (Optional)

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

// Set or replace PriceProvider at runtime
sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: userProvidedKey,  // Optional for free tier
  baseUrl: '/api/coingecko',  // CORS proxy for browser (see below)
}));
```

Without a PriceProvider, the price fields in `assets()` are `null`. All other functionality works normally.

**CORS Proxy (Browser only):** CoinGecko's free API lacks CORS headers. Add a proxy in development:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api/coingecko': {
        target: 'https://api.coingecko.com/api/v3',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coingecko/, ''),
      },
    },
  },
});
```

Then pass `baseUrl: '/api/coingecko'` in the `price` config. In production, use Nginx or a Cloudflare Worker as a reverse proxy. CoinGecko Pro API supports CORS natively and doesn't require a proxy.

Node.js environments are not subject to CORS — no proxy needed.

---

## How Transfers Work (Sender-Driven)

When you call `send()`, the transfer runs as a durable server-side intent:

1. **Intent first** — the transfer intent is recorded on the wallet-api server BEFORE any
   chain op (crash-safe by construction).
2. **Engine spends** the source token (or splits it when the exact amount is unavailable);
   each op posts a signed, field-encrypted progress checkpoint.
3. **Certification** — submitted to the gateway; the inclusion proof finishes the token.
4. **Mailbox deposit** — the finished token blob (raw `Token.toCBOR()`) is deposited into
   the recipient's wallet-api mailbox, and the intent is closed with a signed complete.

The recipient verifies it (`engine.verify` + ownership check) and stores it as `'confirmed'` —
there is no receiver-side commitment submission, proof polling, or finalization phase.

**Money safety:**

- A crash at ANY stage resumes the SAME `transferId` when the vertical starts — never a second
  spend. A possibly-committed outcome (`CERTIFICATION_UNCONFIRMED`) keeps the intent OPEN;
  **never re-issue `send()`** for it (a fresh transferId on a different source double-pays).
- A certified-but-undelivered blob is journaled locally (#621) and re-deposited with a bounded
  poison budget (#517); `deliveryPending: true` on the result is **normal, not a failure** —
  the token is safe on-chain and will be delivered asynchronously.
- A clean conflict (`TransferConflictError`) demotes the stale source (`suspectedSpent` —
  excluded from selection, recoverable by resync) and re-plans once.
- For splits, your change token is minted by the same on-chain operation and is immediately
  spendable (no placeholder, no background proof step).

---

## Payment Requests

Payment requests ride the wallet-api rail (`sphere.payments.requests`); the memo travels in a
recipient-ECDH encrypted envelope.

### Send Payment Request

```typescript
const result = await sphere.payments.requests.create('@bob', {
  coinId: 'UCT',
  amount: '1000000',
  memo: 'Payment for order #1234',
});

if (result.success) {
  console.log('Request sent, ID:', result.requestId);
}
```

### Track Status

```typescript
sphere.on('payment_request:updated', ({ id, status }) => {
  // 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
  if (status === 'paid') {
    deliverProduct(id);
  }
});
```

### Handle Incoming Requests

```typescript
sphere.on('payment_request:incoming', (request) => {
  // PaymentRequestView: { id, requestId, senderPubkey, senderNametag?, amount,
  //                       coinId, symbol?, message?, timestamp, status }
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);
});

// Current views (incoming + outgoing)
const requests = sphere.payments.requests.list();

// Accept and pay a request — durably 'settling' BEFORE any possibly-committed
// error can surface, so a crash never double-pays (#441)
await sphere.payments.requests.pay(requestId);

// Or decline — a server 403/409 propagates (a refused decline is not success)
await sphere.payments.requests.decline(requestId);

// Drop terminal entries from list()
sphere.payments.requests.dismissProcessed();
```

---

## Communications

### Send Direct Message

```typescript
const message = await sphere.communications.sendDM('@bob', 'Hello!');
console.log('Message ID:', message.id);
```

### Get Conversations

```typescript
const conversations = sphere.communications.getConversations();

for (const [peer, messages] of conversations) {
  console.log(`Conversation with ${peer}: ${messages.length} messages`);
}
```

### Subscribe to Messages

```typescript
// Direct messages
sphere.communications.onDirectMessage((message) => {
  console.log(`${message.senderNametag}: ${message.content}`);
});

// Broadcasts
sphere.communications.subscribeToBroadcasts(['news', 'updates']);
sphere.communications.onBroadcast((broadcast) => {
  console.log(`[${broadcast.tags}] ${broadcast.content}`);
});
```

### Publish Broadcast

```typescript
await sphere.communications.broadcast('Hello world!', ['general']);
```

---

## Custom Providers

> **Money ports:** token custody is the wallet-api backend — there is no TokenStorageProvider
> to implement. The swappable money surface is (a) the `paymentsV2Transport` seam in the
> `walletApi` config (inject a whole per-address transport bundle `{ session, client }`), and
> (b) the `StoragePort` / `DeliveryPort` contracts in `modules/payments-v2/ports.ts`, enforced
> by the conformance suites under `tests/unit/payments-v2/contracts/`.

### Storage Provider Interface

The default browser implementation is `IndexedDBStorageProvider` (database: `sphere-storage`, object store: `kv`). For Node.js, `FileStorageProvider` is used. Both support per-address key scoping via `setIdentity()`.

```typescript
interface StorageProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;

  setIdentity(identity: FullIdentity): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;

  // Tracked addresses registry
  saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void>;
  loadTrackedAddresses(): Promise<TrackedAddressEntry[]>;
}
```

### Transport Provider Interface

```typescript
interface TransportProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  setIdentity(identity: FullIdentity): void;
  sendMessage(recipientPubkey: string, content: string): Promise<string>;
  onMessage(callback: (msg: IncomingMessage) => void): () => void;

  // Peer resolution (optional)
  resolve?(identifier: string): Promise<PeerInfo | null>;
  resolveNametagInfo?(nametag: string): Promise<PeerInfo | null>;
  resolveAddressInfo?(address: string): Promise<PeerInfo | null>;

  // Identity binding (optional)
  publishIdentityBinding?(chainPubkey: string, directAddress: string, nametag?: string): Promise<boolean>;

  // Broadcast (optional)
  publishBroadcast?(content: string, tags?: string[]): Promise<string>;
  subscribeToBroadcast?(tags: string[], callback: (b: IncomingBroadcast) => void): () => void;
}
```

### Oracle Provider Interface

Post v1-cutover the oracle is a thin **network-config provider** for the v2 token engine: it
loads the root trust base (JSON) and exposes the gateway URL + API key. The engine builds its
own clients from these — custom implementations MUST provide the three config accessors.

```typescript
interface OracleProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;

  /** Loads the trust base JSON (via the platform loader when not passed explicitly). */
  initialize(trustBaseJson?: unknown): Promise<void>;

  // v2 token-engine config surface (REQUIRED)
  getTrustBaseJson(): unknown | null;   // raw trust-base JSON (networkId comes from it)
  getAggregatorUrl(): string;           // gateway (aggregator) base URL
  getApiKey(): string | undefined;      // gateway API key, when required (e.g. testnet2)
}
```

---

## Events

### Available Events

```typescript
// The 8 payments-vertical events
sphere.on('transfer:incoming', (transfer) => { });        // IncomingTransfer
sphere.on('transfer:updated', (result) => { });           // TransferResult — read status/deliveryPending
sphere.on('transfer:attention', ({ transferId, code, detail }) => { });  // stuck checkpoint / undeliverable / deferred
sphere.on('inventory:updated', () => { });
sphere.on('history:updated', () => { });
sphere.on('payment_request:incoming', (view) => { });     // PaymentRequestView
sphere.on('payment_request:updated', ({ id, status }) => { });
sphere.on('connection:status', ({ status }) => { });      // 'connected' | 'degraded' | 'offline'

// Message events
sphere.on('message:dm', (message) => { });
sphere.on('message:broadcast', (broadcast) => { });

// Connection events
sphere.on('connection:changed', ({ provider, connected }) => { });
sphere.on('nametag:registered', ({ nametag, addressIndex }) => { });
sphere.on('nametag:recovered', ({ nametag }) => { });

// Identity events
sphere.on('identity:changed', ({ directAddress, chainPubkey, nametag, addressIndex }) => { });

// Address tracking events
sphere.on('address:activated', ({ address }) => { });  // New address tracked
sphere.on('address:hidden', ({ index, addressId }) => { });
sphere.on('address:unhidden', ({ index, addressId }) => { });
```

The pre-flip names (`transfer:confirmed`, `transfer:failed`, `payment_request:paid`, `sync:*`,
`invoice:*`, `swap:*`, …) are gone from the public event map — dApps on the Connect wire still
receive them via the ConnectHost compat adapter (see [CONNECT.md](CONNECT.md)).

### Unsubscribe

```typescript
const unsubscribe = sphere.on('transfer:incoming', handler);

// Later...
unsubscribe();
```

---

## Nametags (Unicity IDs)

Nametags provide human-readable addresses (e.g., `@alice`) for receiving tokens. A nametag is a
**Nostr identity binding** (name ↔ chainPubkey) — receive is always locked to your chain pubkey;
there is no PROXY address scheme.

### Registration Flow

```typescript
// Register during wallet creation
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  nametag: 'alice',
});

// Or register after wallet is created
await sphere.registerNametag('alice');

// Check availability first (no binding resolves for the name)
const available = await sphere.isNametagAvailable('alice');
```

Registration also mints + stores a self-issued v2 **UnicityIdToken** as an on-chain claim
(best-effort and idempotent — a gateway outage never fails registration; the claim is re-minted
on a later load if missing). The claim is not used at runtime — name resolution stays
Nostr-binding-only.

### Multi-Address Nametags

Each derived address can have its own nametag:

```typescript
// Register @alice for address 0
await sphere.registerNametag('alice');

// Switch to address 1 and register @bob
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');

// Query nametags
sphere.getNametagForAddress(0);  // 'alice'
sphere.getNametagForAddress(1);  // 'bob'
sphere.getAllAddressNametags();  // Map { 0 => 'alice', 1 => 'bob' }
```

### Troubleshooting: "Nametag already taken"

**Error:**
```
Failed to register nametag. It may already be taken.
[NostrTransportProvider] Nametag already taken: myname - owner: f124f93ae6...
```

**Cause:** The nametag is registered to a different public key. This happens when:

1. **Storage cleared or inaccessible** → `Sphere.exists()` returns `false` → new wallet created
2. **Different mnemonic provided** on subsequent runs

**Note:** `autoGenerate: true` does NOT generate new mnemonic every restart. It only generates if `Sphere.exists()` returns `false`.

**Solution:**

```typescript
// Use persistent file storage (recommended for backend)
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data');
const { sphere } = await Sphere.init({
  storage,  // Persists mnemonic to disk
  autoGenerate: true,
  nametag: 'myservice',
});

// Or use fixed mnemonic from environment
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: process.env.WALLET_MNEMONIC,
  nametag: 'myservice',
});
```

**Debug storage issues:**
```typescript
const exists = await Sphere.exists(storage);
console.log('Wallet exists:', exists);  // Should be true after first run

// Enable storage debug logs
logger.setTagDebug('LocalStorage', true);
logger.setTagDebug('IndexedDB', true);
```

### Nametag Sync on Load

When loading an existing wallet, the SDK automatically syncs the nametag with Nostr:

```typescript
// On Sphere.load(), if local nametag exists:
// 1. Checks if nametag is registered on Nostr
// 2. If not registered or owned by this pubkey, re-publishes it
// 3. Logs warning if owned by different pubkey
```

### Nametag Recovery on Import

When importing a wallet without specifying a nametag, the SDK automatically attempts to recover it from Nostr:

```typescript
// Import wallet - nametag will be recovered if found on Nostr
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  // No nametag specified
});

// Listen for recovery
sphere.on('nametag:recovered', ({ nametag }) => {
  console.log('Recovered nametag:', nametag);
});

// Or check after init
if (sphere.identity?.nametag) {
  console.log('Nametag recovered:', sphere.identity.nametag);
}
```

The recovery process:
1. Derives transport pubkey from wallet keys
2. Queries Nostr for nametag events owned by this pubkey
3. If found, sets the nametag locally and emits `nametag:recovered` event

---

## Error Handling

### Send Error Handling

`send()` returns a `TransferResult` — check its `status` and `error` fields:

```typescript
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
});

if (result.status === 'failed') {
  console.error('Transfer failed:', result.error);
  // Common errors:
  // - Insufficient balance
  // - Recipient not found (nametag not registered)
  // - Network/aggregator errors
}
```

### Verification Is Built In

There is no `validate()` to call: every incoming token is engine-verified against the trust
base and ownership-checked BEFORE it enters the balance, and a stale source discovered during
a send is demoted (`suspectedSpent`) and excluded from selection automatically.

```typescript
// Subscribe to transfer lifecycle events
sphere.on('transfer:updated', (transfer) => {
  console.log('Transfer update:', transfer.id, transfer.status);
});

sphere.on('transfer:attention', ({ transferId, code }) => {
  console.warn('Transfer needs attention:', transferId, code);
});
```

### Typed Error Handling

All SDK methods throw `SphereError` with a typed `.code` field. Use `isSphereError()` type guard to handle errors programmatically:

```typescript
import { isSphereError } from '@unicitylabs/sphere-sdk';

try {
  await sphere.payments.send({ coinId, amount, recipient });
} catch (err) {
  if (isSphereError(err)) {
    // err.code is typed as SphereErrorCode
    switch (err.code) {
      case 'INSUFFICIENT_BALANCE':
        showError('Not enough funds');
        break;
      case 'INVALID_RECIPIENT':
        showError('Recipient not found');
        break;
      case 'TRANSPORT_ERROR':
        showError('Network issue');
        break;
      case 'AGGREGATOR_ERROR':
        showError('Oracle unavailable');
        break;
      default:
        showError(err.message);
    }
  }
}
```

### Debug Logging

Enable the centralized logger to diagnose issues:

```typescript
import { logger } from '@unicitylabs/sphere-sdk';

logger.configure({ debug: true });

// Or enable specific modules:
logger.setTagDebug('Payments', true);
logger.setTagDebug('Nostr', true);
```

---

## Best Practices

### 1. Always Handle Wallet State

```typescript
async function initApp() {
  const baseProviders = createBrowserProviders({ network: 'testnet' });
  const providers = createWalletApiProviders(baseProviders, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-device',
  });

  // Sphere.init() handles both creation and loading
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  if (created && generatedMnemonic) {
    // Show mnemonic backup UI
    console.log('Save your mnemonic:', generatedMnemonic);
  }
}
```

### 2. Subscribe to Events Early

```typescript
// Sphere.init() returns an initialized sphere — subscribe to events right after
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

sphere.on('transfer:incoming', handleIncomingTransfer);
sphere.on('message:dm', handleMessage);
```

### 3. Graceful Shutdown

```typescript
window.addEventListener('beforeunload', async () => {
  await sphere.destroy();
});
```

### 4. Handle Reconnection

```typescript
sphere.on('connection:changed', async ({ provider, connected }) => {
  if (!connected) {
    console.log(`${provider} disconnected, attempting reconnect...`);
    // SDK handles reconnection automatically
  }
});
```

### 5. Event Timestamp Persistence

The transport layer persists the timestamp of the last processed wallet event. On reconnect or app restart, only events newer than the stored timestamp are fetched — preventing duplicate token processing.

This is handled automatically when using `createBrowserProviders()` or `createNodeProviders()`. The storage provider is passed to the transport, and timestamps are persisted per wallet pubkey.

**Behavior by scenario:**

| Scenario | `since` filter |
|----------|---------------|
| Existing wallet with stored timestamp | Resume from last event timestamp |
| Fresh wallet (no stored timestamp) | `now` — no historical events |
| No storage adapter (legacy) | `now - 24h` fallback |

**Note:** The `since` filter only applies to wallet events (token transfers, payment requests). Chat messages (NIP-17 GIFT_WRAP) are always real-time with no `since` filter.

---

## Testing

The SDK includes a comprehensive test suite using Vitest.

### Running Tests

```bash
# Run all tests (watch mode)
npm test

# Run once (CI mode)
npm run test:run

# Run specific test file
npx vitest run tests/unit/core/crypto.test.ts

# E2E tests against live testnet2 (requires .env — see .env.example)
npm run test:e2e

# Run with coverage
npm test -- --coverage
```

### Test Coverage

The suite spans ~170 test files. Major areas:

| Area | Description |
|------|-------------|
| `tests/unit/core` | Crypto (BIP39/BIP32), currency, encryption, Sphere lifecycle |
| `tests/unit/token-engine` | v2 engine adapter: mint, transfer, split, verify, Unicity ID mint |
| `tests/unit/payments-v2` | The payments vertical: TransferMachine send/resume, receive drain, requests, mint journal, history, facade, port contracts, adversarial fakes |
| `tests/unit/modules` | Communications, GroupChat, Market |
| `tests/unit/serialization` | Wallet text backups |
| `tests/unit/transport` | Nostr P2P messaging, event timestamp persistence |
| `tests/unit/impl` | Storage providers (IndexedDB, file), config resolvers |
| `tests/mutation` | 17 mutation probes over the payments vertical (`npm run test:mutation`, all must be KILLED) |
| `tests/integration` | Sphere payments wiring, per-address bleed invariants, wallet import/export, nametag round-trips |
| `tests/e2e` | Live staging/testnet2 flows (gated behind `.env` keys; skipped otherwise) |

### Writing Tests

Tests follow the structure:

```
tests/
├── unit/
│   ├── core/            # crypto, currency, encryption, Sphere.*
│   ├── token-engine/    # v2 engine adapter
│   ├── payments-v2/     # the vertical: machine, receive, requests, fakes, contracts/
│   ├── modules/         # Communications*, GroupChat*, Market*
│   ├── price/
│   ├── transport/
│   ├── serialization/
│   ├── connect/         # protocol surface, lock, payments-compat adapter
│   └── impl/            # browser / nodejs / shared providers
├── integration/
├── e2e/                 # live-network tests (vitest.e2e.config.ts)
├── mutation/            # probes.json (scripts/test-mutation.mjs)
├── relay/
└── fixtures/
```

Example test:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic } from '../../../core/crypto';

describe('generateMnemonic()', () => {
  it('should generate valid 12-word mnemonic', () => {
    const mnemonic = generateMnemonic(12);
    const words = mnemonic.split(' ');

    expect(words).toHaveLength(12);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });
});
```
