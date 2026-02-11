# Sphere SDK Integration Guide

> **Quick Start**: For a fast setup, see the platform-specific guides:
> - [Browser Quick Start](./QUICKSTART-BROWSER.md) - Web applications
> - [Node.js Quick Start](./QUICKSTART-NODEJS.md) - Server-side / CLI
>
> This document covers advanced integration patterns and custom provider implementations.

## Table of Contents

1. [Setup](#setup)
2. [Wallet Operations](#wallet-operations)
3. [L3 Payments](#l3-payments)
4. [Payment Requests](#payment-requests)
5. [L1 Payments](#l1-payments)
6. [Communications](#communications)
7. [Custom Providers](#custom-providers)
8. [Events](#events)
9. [Error Handling](#error-handling)
10. [Testing](#testing)

---

## Setup

### Recommended: Factory Functions

The easiest way to set up providers is using the factory functions:

```typescript
// Browser (requires CORS proxy for free CoinGecko API — see "CORS Proxy" section below)
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
const providers = createBrowserProviders({
  network: 'testnet',
  price: {
    platform: 'coingecko',
    baseUrl: '/api/coingecko',  // CORS proxy path (see below)
  },
});

// Node.js (no proxy needed)
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet',
  tokensDir: './tokens',
  price: { platform: 'coingecko', apiKey: 'CG-xxx' },  // Optional
});
```

### Manual Setup (Advanced)

For fine-grained control, create providers manually:

### Browser Environment

```typescript
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { Sphere } from '@unicitylabs/sphere-sdk';

const providers = createBrowserProviders({
  network: 'testnet',
  // L1 is enabled by default with lazy Fulcrum connection
  // Set l1: undefined (default) to use network defaults
  // Set l1: null in Sphere.init() to explicitly disable L1
});

// Initialize (auto-creates wallet if needed)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});
```

### Node.js Environment

```typescript
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { Sphere } from '@unicitylabs/sphere-sdk';

const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens',
});

const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});
```

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

console.log('L1 Address:', identity.l1Address);       // alpha1...
console.log('Chain Pubkey:', identity.chainPubkey);   // 33-byte compressed secp256k1
console.log('Direct Address:', identity.directAddress); // DIRECT://... (L3)
console.log('Nametag:', identity.nametag);            // e.g., 'alice'
```

### Clear Wallet

```typescript
await Sphere.clear({ storage: providers.storage, tokenStorage: providers.tokenStorage });
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
  address: string;     // alpha1... format
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
  console.log(`#${addr.index}: ${addr.l1Address}`);
  console.log(`  DIRECT: ${addr.directAddress}`);
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

### Get Balance & Assets

```typescript
// Total portfolio value in USD (null if PriceProvider not configured)
const totalUsd = await sphere.payments.getBalance();
console.log('Total USD:', totalUsd); // number | null

// Get assets with price data
const assets = await sphere.payments.getAssets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount}`);
  console.log(`  Price: $${asset.priceUsd ?? 'N/A'}`);
  console.log(`  Value: $${asset.fiatValueUsd?.toFixed(2) ?? 'N/A'}`);
}
```

### Set Price Provider After Init

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

// Set or replace PriceProvider at runtime
sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: userProvidedKey,
}));
```

### CORS Proxy (Browser)

CoinGecko's free API does not include CORS headers. In browser environments, you need a proxy:

**Vite (development):**

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

### Get Tokens

```typescript
const tokens = await sphere.payments.getTokens();

for (const token of tokens) {
  console.log(`Token ${token.id}: ${token.amount} ${token.symbol}`);
  console.log(`  Status: ${token.status}`);  // 'confirmed' | 'pending' | 'spent'
  console.log(`  Coin ID: ${token.coinId}`);
}
```

### Send Tokens

```typescript
// Send to nametag
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  memo: 'Payment for coffee',
});

// Send to public key
const result = await sphere.payments.send({
  recipient: '02abc123...',
  amount: '500000',
  coinId: 'UCT',
});

if (result.success) {
  console.log('Transfer ID:', result.transferId);
} else {
  console.error('Transfer failed:', result.error);
}
```

### Receive Tokens

Incoming tokens are received automatically via Nostr. Subscribe to events:

```typescript
sphere.on('transfer:incoming', (transfer) => {
  console.log('Received tokens from:', transfer.senderNametag);
  console.log('Amount:', transfer.amount);
});
```

### Refresh Tokens

```typescript
await sphere.payments.refresh();
```

---

## Payment Requests

Payment requests allow you to request payment from another user and track the response.

### Send Payment Request

```typescript
// Request payment from @bob
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Payment for order #1234',
});

if (result.success) {
  console.log('Request sent, ID:', result.requestId);
}
```

### Wait for Response

```typescript
// Send and wait for response (with timeout)
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Coffee purchase',
});

if (result.success) {
  try {
    // Wait up to 2 minutes for response
    const response = await sphere.payments.waitForPaymentResponse(result.requestId!, 120000);

    switch (response.responseType) {
      case 'paid':
        console.log('Payment received! Transfer:', response.transferId);
        // Deliver the ticket
        break;
      case 'accepted':
        console.log('Request accepted, waiting for payment...');
        break;
      case 'rejected':
        console.log('Request rejected');
        break;
    }
  } catch (error) {
    console.log('Response timeout or cancelled');
  }
}
```

### Subscribe to Responses

```typescript
// React to all payment request responses
sphere.payments.onPaymentRequestResponse((response) => {
  console.log(`Response from ${response.responderPubkey}: ${response.responseType}`);

  if (response.responseType === 'paid') {
    // Handle successful payment
    deliverProduct(response.requestId);
  }
});
```

### Handle Incoming Requests

```typescript
// Listen for incoming payment requests
sphere.payments.onPaymentRequest((request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);
  console.log(`Message: ${request.message}`);

  // Show UI to user...
});

// Get pending requests
const pending = sphere.payments.getPaymentRequests({ status: 'pending' });

// Accept and pay a request
await sphere.payments.payPaymentRequest(requestId, 'Payment for ticket');

// Or reject
await sphere.payments.rejectPaymentRequest(requestId);
```

### Track Outgoing Requests

```typescript
// Get all outgoing requests
const outgoing = sphere.payments.getOutgoingPaymentRequests();

// Filter by status
const pendingOutgoing = sphere.payments.getOutgoingPaymentRequests({ status: 'pending' });

// Clear completed/expired requests
sphere.payments.clearCompletedOutgoingPaymentRequests();
```

---

## L1 Payments

L1 module handles ALPHA blockchain transactions with vesting classification support.
L1 is **enabled by default** — the Fulcrum WebSocket connection is lazy (deferred until first L1 operation).
To explicitly disable L1, pass `l1: null` in the `PaymentsModuleConfig`.

### Get L1 Balance

```typescript
const balance = await sphere.payments.l1.getBalance();

console.log('Total:', balance.total);           // Total in satoshis
console.log('Confirmed:', balance.confirmed);   // Confirmed balance
console.log('Unconfirmed:', balance.unconfirmed);
console.log('Vested:', balance.vested);         // Coins from blocks ≤280,000
console.log('Unvested:', balance.unvested);     // Coins from blocks >280,000
```

### Get UTXOs

```typescript
const utxos = await sphere.payments.l1.getUtxos();

for (const utxo of utxos) {
  console.log(`${utxo.txid}:${utxo.vout} - ${utxo.amount} sats`);
  console.log(`  Vested: ${utxo.isVested}`);
  console.log(`  Confirmations: ${utxo.confirmations}`);
  if (utxo.coinbaseHeight) {
    console.log(`  Coinbase height: ${utxo.coinbaseHeight}`);
  }
}
```

### Send L1 Transaction

```typescript
const result = await sphere.payments.l1.send({
  to: 'alpha1abc123...',
  amount: '10000000',  // in satoshis
});

if (result.success) {
  console.log('TX Hash:', result.txHash);
} else {
  console.error('Error:', result.error);
}
```

### Get Transaction History

```typescript
const history = await sphere.payments.l1.getHistory(10);  // last 10 transactions

for (const tx of history) {
  console.log(`${tx.type}: ${tx.amount} sats`);
  console.log(`  Confirmations: ${tx.confirmations}`);
  console.log(`  Timestamp: ${new Date(tx.timestamp * 1000)}`);
}
```

### Vesting Classification

ALPHA coins are classified as "vested" or "unvested" based on their coinbase origin:
- **Vested**: Coins traced back to coinbase transactions in blocks ≤280,000
- **Unvested**: Coins from blocks >280,000

```typescript
// Vesting is enabled by default, configure via L1PaymentsModule:
import { createL1PaymentsModule } from '@unicitylabs/sphere-sdk';

const l1Module = createL1PaymentsModule({
  electrumUrl: 'wss://fulcrum.alpha.unicity.network:50004',
  enableVesting: true,  // default: true
});
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

### Storage Provider Interface

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
  sendTokenTransfer(recipientPubkey: string, payload: TokenTransferPayload): Promise<string>;
  onTokenTransfer(handler: TokenTransferHandler): () => void;

  // Peer resolution (optional)
  resolve?(identifier: string): Promise<PeerInfo | null>;
  resolveNametagInfo?(nametag: string): Promise<PeerInfo | null>;
  resolveAddressInfo?(address: string): Promise<PeerInfo | null>;

  // Identity binding (optional)
  publishIdentityBinding?(chainPubkey: string, l1Address: string, directAddress: string, nametag?: string): Promise<boolean>;

  // Broadcast (optional)
  publishBroadcast?(content: string, tags?: string[]): Promise<string>;
  subscribeToBroadcast?(tags: string[], callback: (b: IncomingBroadcast) => void): () => void;
}
```

### Oracle Provider Interface

```typescript
interface OracleProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  submitCommitment(commitment: TransferCommitment): Promise<SubmitResult>;
  getInclusionProof(requestId: string): Promise<InclusionProof | null>;
  validateToken(tokenData: unknown): Promise<ValidationResult>;
  getCurrentRound(): Promise<bigint>;
}
```

---

## Events

### Available Events

```typescript
// Wallet events
sphere.on('wallet:created', () => { });
sphere.on('wallet:loaded', () => { });
sphere.on('wallet:cleared', () => { });

// Transfer events
sphere.on('transfer:incoming', (transfer) => { });
sphere.on('transfer:outgoing', (transfer) => { });
sphere.on('transfer:confirmed', (transfer) => { });
sphere.on('transfer:failed', (transfer) => { });

// Payment request events
sphere.on('payment_request:incoming', (request) => { });
sphere.on('payment_request:accepted', (request) => { });
sphere.on('payment_request:rejected', (request) => { });
sphere.on('payment_request:paid', (request) => { });
sphere.on('payment_request:response', (response) => { });

// Message events
sphere.on('message:dm', (message) => { });
sphere.on('message:broadcast', (broadcast) => { });

// Sync events
sphere.on('sync:started', ({ source }) => { });
sphere.on('sync:completed', ({ source, count }) => { });
sphere.on('sync:error', ({ source, error }) => { });

// Connection events
sphere.on('connection:changed', ({ provider, connected }) => { });
sphere.on('nametag:registered', ({ nametag, addressIndex }) => { });
sphere.on('nametag:recovered', ({ nametag }) => { });

// Identity events
sphere.on('identity:changed', ({ l1Address, directAddress, chainPubkey, nametag, addressIndex }) => { });

// Address tracking events
sphere.on('address:activated', ({ address }) => { });  // New address tracked
sphere.on('address:hidden', ({ index, addressId }) => { });
sphere.on('address:unhidden', ({ index, addressId }) => { });
```

### Unsubscribe

```typescript
const unsubscribe = sphere.on('transfer:incoming', handler);

// Later...
unsubscribe();
```

---

## Nametags

Nametags provide human-readable addresses (e.g., `@alice`) for receiving tokens.

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

// Mint nametag token on-chain (required for PROXY address transfers)
const result = await sphere.mintNametag('alice');
```

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
// ✅ Use persistent file storage (recommended for backend)
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data');
const { sphere } = await Sphere.init({
  storage,  // Persists mnemonic to disk
  autoGenerate: true,
  nametag: 'myservice',
});

// ✅ Or use fixed mnemonic from environment
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

### Error Types

```typescript
try {
  await sphere.payments.send({ ... });
} catch (error) {
  if (error.code === 'INSUFFICIENT_BALANCE') {
    console.error('Not enough tokens');
  } else if (error.code === 'RECIPIENT_NOT_FOUND') {
    console.error('Nametag not registered');
  } else if (error.code === 'NETWORK_ERROR') {
    console.error('Connection failed');
  }
}
```

### Validation Errors

```typescript
// Check before sending
const validation = await sphere.payments.validateTransfer({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
});

if (!validation.valid) {
  console.error(validation.errors);
  // ['Insufficient balance', 'Invalid recipient']
}
```

---

## Best Practices

### 1. Always Handle Wallet State

```typescript
async function initApp() {
  const providers = createBrowserProviders({ network: 'testnet' });

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

# Run with coverage
npm test -- --coverage
```

### Test Coverage

| Module | Tests | Description |
|--------|-------|-------------|
| `core/crypto` | 43 | BIP39, BIP32, hashing, address generation |
| `core/bech32` | 30 | Bech32 encoding/decoding |
| `core/currency` | 37 | Amount conversion and formatting |
| `core/encryption` | 39 | AES-256-CBC encryption |
| `core/utils` | 40 | Base58, validation, utilities |
| `l1/address` | 18 | HD key derivation |
| `l1/addressToScriptHash` | 7 | Electrum scripthash |
| `l1/tx` | 23 | SegWit transactions, UTXO selection |
| `l1/crypto` | 22 | Wallet encryption, WIF conversion |
| `l1/addressHelpers` | 36 | Address management utilities |
| `l1/vesting` | 16 | Vesting classification |
| `l1/L1PaymentsHistory` | 12 | L1 transaction history direction/amounts |
| `serialization/txf` | 44 | TXF token format |
| `serialization/wallet-text` | 32 | Text wallet backup format |
| `serialization/wallet-dat` | 18 | SQLite wallet.dat parsing |
| `modules/TokenSplitCalculator` | 23 | Token split optimization |
| `modules/TokenSplitExecutor` | 16 | Token split execution |
| `modules/PaymentsModule` | 36 | Payments, nametag, PROXY |
| `modules/NametagMinter` | 22 | On-chain nametag minting |
| `price/CoinGeckoPriceProvider` | 29 | Price provider, cache, negative cache |
| `transport/NostrTransportProvider` | 24 | Nostr P2P messaging |
| `integration/wallet-import-export` | 20 | Wallet import/export |
| `integration/nametag-roundtrip` | 9 | Nametag serialization |
| `impl/shared/resolvers` | 41 | Config resolution utilities |
| **Total** | **882** | All passing (34 test files) |

### Writing Tests

Tests follow the structure:

```
tests/
├── unit/
│   ├── core/
│   │   ├── crypto.test.ts
│   │   ├── bech32.test.ts
│   │   ├── currency.test.ts
│   │   ├── encryption.test.ts
│   │   ├── utils.test.ts
│   │   ├── Sphere.providers.test.ts
│   │   └── Sphere.nametag-sync.test.ts
│   ├── l1/
│   │   ├── address.test.ts
│   │   ├── addressHelpers.test.ts
│   │   ├── addressToScriptHash.test.ts
│   │   ├── crypto.test.ts
│   │   ├── L1PaymentsHistory.test.ts
│   │   ├── tx.test.ts
│   │   └── vesting.test.ts
│   ├── modules/
│   │   ├── TokenSplitCalculator.test.ts
│   │   ├── TokenSplitExecutor.test.ts
│   │   ├── PaymentsModule.test.ts
│   │   └── NametagMinter.test.ts
│   ├── price/
│   │   └── CoinGeckoPriceProvider.test.ts
│   ├── transport/
│   │   └── NostrTransportProvider.test.ts
│   ├── serialization/
│   │   ├── txf-serializer.test.ts
│   │   ├── wallet-text.test.ts
│   │   └── wallet-dat.test.ts
│   └── impl/
│       └── shared/
│           └── resolvers.test.ts
├── integration/
│   ├── wallet-import-export.test.ts
│   └── nametag-roundtrip.test.ts
└── fixtures/
    └── test-vectors.ts
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
