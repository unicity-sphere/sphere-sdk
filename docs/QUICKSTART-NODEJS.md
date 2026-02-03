# Sphere SDK - Node.js Quick Start

Get up and running with Sphere SDK in Node.js in under 5 minutes.

## Installation

```bash
npm install @unicitylabs/sphere-sdk ws
```

| Package | Required | Description |
|---------|----------|-------------|
| `@unicitylabs/sphere-sdk` | Yes | The SDK |
| `ws` | Yes (Node.js) | WebSocket for Nostr relay communication |

**Node.js version:** 18.0.0 or higher

## Storage

Node.js implementation uses **file-based storage**:

| Data | Location | Format |
|------|----------|--------|
| Wallet (keys, nametag) | `dataDir/wallet.json` | Encrypted JSON |
| Tokens | `tokensDir/_<tokenId>.json` | One JSON file per token |

> **Note:** IPFS sync is currently only available for browser. Node.js uses local file storage only.

## Minimal Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

async function main() {
  // 1. Create providers (handles storage, transport, oracle)
  const providers = createNodeProviders({
    network: 'testnet',
    dataDir: './wallet-data',
    tokensDir: './tokens-data',
  });

  // 2. Initialize wallet (auto-creates if doesn't exist)
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  // 3. Save mnemonic on first run!
  if (created && generatedMnemonic) {
    console.log('SAVE THIS MNEMONIC:', generatedMnemonic);
  }

  // 4. Use the wallet
  console.log('Address:', sphere.identity?.l1Address);
  console.log('Direct Address:', sphere.identity?.directAddress);

  // 5. Cleanup
  await sphere.destroy();
}

main().catch(console.error);
```

## What Gets Created

```
./wallet-data/
  └── wallet.json      # Encrypted wallet data (mnemonic, keys, nametag)

./tokens-data/
  ├── _meta.json       # Token storage metadata
  └── _<tokenId>.json  # One file per token
```

## Configuration Options

```typescript
const providers = createNodeProviders({
  // Network: 'mainnet' | 'testnet' | 'dev'
  network: 'testnet',

  // Storage directories (required)
  dataDir: './wallet-data',
  tokensDir: './tokens-data',

  // Transport options
  transport: {
    relays: ['wss://custom-relay.com'],           // Replace default relays
    additionalRelays: ['wss://extra-relay.com'],  // Add to defaults
    timeout: 5000,
    autoReconnect: true,
    debug: false,
  },

  // Oracle options
  oracle: {
    aggregatorUrl: 'https://custom-aggregator.com/rpc',
    trustBasePath: './trustbase.json',  // Local trustbase file
    apiKey: 'your-api-key',             // If required
  },

  // L1 blockchain options
  l1: {
    electrumUrl: 'wss://custom-electrum:50004',
    enableVesting: true,
  },
});
```

## Common Operations

### Check Balance

```typescript
// L3 token balance
const balance = await sphere.payments.getBalance();
console.log('L3 Balance:', balance);

// L1 (ALPHA) balance
const l1Balance = await sphere.payments.l1.getBalance();
console.log('L1 Balance:', l1Balance);
```

### Send Tokens

```typescript
// Send to nametag
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',  // In base units
  coinId: 'UCT',
});

// Send to direct address
const result = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId: 'UCT',
});
```

### Register Nametag

```typescript
await sphere.registerNametag('myusername');
console.log('Registered:', sphere.identity?.nametag);
```

### Listen for Incoming Transfers

```typescript
sphere.on('transfer:incoming', (event) => {
  console.log('Received:', event.data.amount, event.data.coinId);
  console.log('From:', event.data.sender);
});
```

### Send Direct Messages

```typescript
await sphere.communications.sendDM('@alice', 'Hello!');

sphere.communications.onDirectMessage((msg) => {
  console.log('Message from', msg.sender, ':', msg.content);
});
```

## Import Existing Wallet

```typescript
// From mnemonic
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve word mnemonic phrase here ...',
});

// From master key (legacy)
const sphere = await Sphere.import({
  masterKey: '64-char-hex-master-key',
  chainCode: '64-char-hex-chain-code',
  basePath: "m/84'/1'/0'",
  derivationMode: 'bip32',
  ...providers,
});
```

## Multi-Address Wallet

```typescript
// Get current address index
const index = sphere.getCurrentAddressIndex(); // 0

// Switch to different address
await sphere.switchToAddress(1);
console.log('New address:', sphere.identity?.l1Address);

// Register nametag for this address
await sphere.registerNametag('myname-work');

// Derive address without switching
const addr = sphere.deriveAddress(2);
console.log(addr.address, addr.publicKey);
```

## Event Handling

```typescript
// All available events
sphere.on('transfer:incoming', handler);
sphere.on('transfer:sent', handler);
sphere.on('transfer:pending', handler);
sphere.on('payment_request:received', handler);
sphere.on('payment_request:paid', handler);
sphere.on('message:dm', handler);
sphere.on('message:broadcast', handler);
sphere.on('sync:started', handler);
sphere.on('sync:completed', handler);
sphere.on('sync:error', handler);
sphere.on('connection:changed', handler);
sphere.on('nametag:registered', handler);
sphere.on('nametag:recovered', handler);
sphere.on('identity:changed', handler);

// Unsubscribe
const unsubscribe = sphere.on('transfer:incoming', handler);
unsubscribe(); // Stop listening
```

## Error Handling

```typescript
try {
  await sphere.payments.send({
    recipient: '@alice',
    amount: '1000000',
    coinId: 'UCT',
  });
} catch (error) {
  if (error.message.includes('Insufficient balance')) {
    console.error('Not enough tokens');
  } else if (error.message.includes('Nametag not found')) {
    console.error('Recipient nametag does not exist');
  } else {
    console.error('Transfer failed:', error.message);
  }
}
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  Identity,
  FullIdentity,
  StorageProvider,
  TransportProvider,
  OracleProvider,
  ProviderStatus,
  SphereEventType,
} from '@unicitylabs/sphere-sdk';
```

## Complete CLI Example

```typescript
#!/usr/bin/env node
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

async function main() {
  const providers = createNodeProviders({
    network: 'testnet',
    dataDir: './my-wallet',
    tokensDir: './my-tokens',
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  if (created) {
    console.log('\n=== NEW WALLET CREATED ===');
    console.log('Mnemonic (SAVE THIS!):', generatedMnemonic);
    console.log('==========================\n');
  }

  console.log('L1 Address:', sphere.identity?.l1Address);
  console.log('Direct Address:', sphere.identity?.directAddress);
  console.log('Nametag:', sphere.identity?.nametag || '(not registered)');

  // Listen for incoming transfers
  sphere.on('transfer:incoming', (event) => {
    console.log('\nIncoming transfer!');
    console.log('Amount:', event.data.amount);
    console.log('From:', event.data.sender);
  });

  // Keep running
  console.log('\nListening for transfers... Press Ctrl+C to exit');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await sphere.destroy();
    process.exit(0);
  });
}

main().catch(console.error);
```

## Troubleshooting

### "Cannot find module 'ws'"
```bash
npm install ws
```

### "Failed to connect to relay"
Check network connectivity and relay URLs:
```typescript
const providers = createNodeProviders({
  network: 'testnet',
  transport: {
    debug: true,  // Enable debug logging
    timeout: 10000,  // Increase timeout
  },
});
```

### "Trustbase not found"
Download or specify trustbase path:
```typescript
oracle: {
  trustBasePath: './path/to/trustbase.json',
}
```

### Data not persisting
Ensure directories exist and are writable:
```typescript
import fs from 'fs';
fs.mkdirSync('./wallet-data', { recursive: true });
fs.mkdirSync('./tokens-data', { recursive: true });
```

## Next Steps

- [API Reference](./API.md) - Full API documentation
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns
- [Browser Quick Start](./QUICKSTART-BROWSER.md) - For web applications
