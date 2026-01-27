# SDK2 Integration Guide

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

---

## Setup

### Browser Environment

```typescript
import {
  Sphere,
  createLocalStorageProvider,
  createNostrTransportProvider,
  createUnicityAggregatorProvider,
  createIpfsStorageProvider,
} from '@unicitylabs/sphere-sdk';

// Create providers
const storage = createLocalStorageProvider({
  prefix: 'sphere_',  // localStorage key prefix
  debug: false,
});

const transport = createNostrTransportProvider({
  relays: ['wss://relay.unicity.network'],
  debug: false,
});

const oracle = createUnicityAggregatorProvider({
  aggregatorUrl: 'https://aggregator.unicity.network',
  stateTransitionUrl: 'https://state.unicity.network',
});

const ipfsStorage = createIpfsStorageProvider({
  gateways: ['https://ipfs.unicity.network'],
  bootstrapPeers: [
    '/dns4/unicity-ipfs2.dyndns.org/tcp/4001/p2p/12D3KooWLNi5NDPPHbrfJakAQqwBqymYTTwMQXQKEWuCrJNDdmfh',
  ],
});

// Initialize Sphere
const sphere = new Sphere();

await sphere.initialize({
  storage,
  transport,
  oracle,
  ipfsStorage,  // optional
});
```

### Node.js Environment

For Node.js, implement custom providers or use provided interfaces:

```typescript
import { Sphere, StorageProvider } from '@unicitylabs/sphere-sdk';

// Custom file-based storage
class FileStorageProvider implements StorageProvider {
  async get(key: string): Promise<string | null> { /* ... */ }
  async set(key: string, value: string): Promise<void> { /* ... */ }
  // ... other methods
}

const sphere = new Sphere();
await sphere.initialize({
  storage: new FileStorageProvider(),
  // ... other providers
});
```

---

## Wallet Operations

### Check if Wallet Exists

```typescript
const exists = await sphere.wallet.exists();
```

### Create New Wallet

```typescript
// Generate new mnemonic
const mnemonic = await sphere.wallet.create('password123');
console.log('Backup these words:', mnemonic);

// Or create with existing mnemonic
await sphere.wallet.import(
  'abandon abandon abandon ...',
  'password123'
);
```

### Load Existing Wallet

```typescript
try {
  await sphere.wallet.load('password123');
  console.log('Wallet loaded:', sphere.identity.address);
} catch (error) {
  console.error('Wrong password or wallet not found');
}
```

### Get Identity

```typescript
const identity = sphere.identity;

console.log('Address:', identity.address);
console.log('Public Key:', identity.publicKey);
console.log('Nametag:', identity.nametag);  // e.g., '@alice'
console.log('Nostr Pubkey:', identity.nostrPublicKey);
```

### Clear Wallet

```typescript
await sphere.wallet.clear();
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

---

## L3 Payments

### Get Balance

```typescript
const balance = await sphere.payments.getBalance();
// Returns: { total: '1000000', available: '1000000', pending: '0' }
```

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
  coinId: 'ALPHA',
  memo: 'Payment for coffee',
});

// Send to public key
const result = await sphere.payments.send({
  recipient: '02abc123...',
  amount: '500000',
  coinId: 'ALPHA',
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
  coinId: 'ALPHA',
  message: 'Lottery ticket #42',
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
  coinId: 'ALPHA',
  message: 'Lottery ticket',
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

### Get L1 Balance

```typescript
const balance = await sphere.l1.getBalance();
// Returns: { confirmed: '100000000', unconfirmed: '0', total: '100000000' }
```

### Get UTXOs

```typescript
const utxos = await sphere.l1.getUtxos();

for (const utxo of utxos) {
  console.log(`${utxo.txid}:${utxo.vout} - ${utxo.amount} sats`);
}
```

### Send L1 Transaction

```typescript
const result = await sphere.l1.send({
  to: 'alpha1abc123...',
  amount: '10000000',  // in satoshis
});

if (result.success) {
  console.log('TX Hash:', result.txHash);
  console.log('Fee:', result.fee);
}
```

### Get Transaction History

```typescript
const history = await sphere.l1.getHistory(10);  // last 10 transactions

for (const tx of history) {
  console.log(`${tx.type}: ${tx.amount} (${tx.confirmations} confirmations)`);
}
```

---

## Communications

### Send Direct Message

```typescript
const message = await sphere.comms.sendDM('@bob', 'Hello!');
console.log('Message ID:', message.id);
```

### Get Conversations

```typescript
const conversations = sphere.comms.getConversations();

for (const [peer, messages] of conversations) {
  console.log(`Conversation with ${peer}: ${messages.length} messages`);
}
```

### Subscribe to Messages

```typescript
// Direct messages
sphere.comms.onDirectMessage((message) => {
  console.log(`${message.senderNametag}: ${message.content}`);
});

// Broadcasts
sphere.comms.subscribeToBroadcasts(['news', 'updates']);
sphere.comms.onBroadcast((broadcast) => {
  console.log(`[${broadcast.tags}] ${broadcast.content}`);
});
```

### Publish Broadcast

```typescript
await sphere.comms.broadcast('Hello world!', ['general']);
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
}
```

### Transport Provider Interface

```typescript
interface TransportProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  setIdentity(identity: FullIdentity): Promise<void>;
  sendMessage(recipientPubkey: string, content: string): Promise<string>;
  onMessage(callback: (msg: IncomingMessage) => void): () => void;

  // Optional
  resolveNametag?(nametag: string): Promise<string | null>;
  registerNametag?(nametag: string): Promise<boolean>;
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
sphere.on('nametag:registered', ({ nametag }) => { });
```

### Unsubscribe

```typescript
const unsubscribe = sphere.on('transfer:incoming', handler);

// Later...
unsubscribe();
```

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
  coinId: 'ALPHA',
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
  await sphere.initialize(providers);

  if (!await sphere.wallet.exists()) {
    // Show create/import wallet UI
    return;
  }

  // Show password prompt
  const password = await promptPassword();

  try {
    await sphere.wallet.load(password);
  } catch {
    // Show error, retry
  }
}
```

### 2. Subscribe to Events Early

```typescript
// Set up listeners before loading wallet
sphere.on('transfer:incoming', handleIncomingTransfer);
sphere.on('message:dm', handleMessage);

// Then load wallet
await sphere.wallet.load(password);
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
