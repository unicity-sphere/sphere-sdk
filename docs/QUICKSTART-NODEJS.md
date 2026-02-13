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

> **Note:** API key for aggregator is included by default. For custom deployments, configure via `oracle: { apiKey: 'your-key' }`.

## CLI (Quick Testing)

The SDK includes a built-in CLI for quick testing without writing code:

```bash
# Initialize wallet (no token minted)
npm run cli -- init --network testnet

# Initialize wallet WITH nametag (mints token on-chain!)
npm run cli -- init --network testnet --nametag alice

# Check status
npm run cli -- status

# Check balance
npm run cli -- balance

# Fetch pending transfers and finalize unconfirmed tokens
npm run cli -- balance --finalize

# Send tokens (instant mode — default, ~2-3s sender latency)
npm run cli -- send @alice 1 --coin UCT --instant

# Send tokens (conservative mode — collect all proofs first)
npm run cli -- send @alice 1 --coin UCT --conservative

# Show receive address
npm run cli -- receive

# Request test tokens from faucet
npm run cli -- topup

# Register nametag (mints token on-chain!)
npm run cli -- nametag myname

# Verify tokens against aggregator (detect spent tokens)
npm run cli -- verify-balance

# Full help
npm run cli -- --help
```

> **Important:** Commands with `--nametag` or `nametag` mint a token on-chain. This uses the Oracle (Aggregator) provider which is included by default with `createNodeProviders()`.

### Transfer Modes

| Mode | Flag | Description |
|------|------|-------------|
| **Instant** (default) | `--instant` | Sends tokens via Nostr immediately. Receiver resolves proofs in background. Fastest sender experience (~2-3s). |
| **Conservative** | `--conservative` | Collects all aggregator proofs first, then sends fully finalized tokens. Slower but receiver gets immediately usable tokens. |

### Wallet Profiles

Manage multiple wallets for testing:

```bash
npm run cli -- wallet create alice              # Create profile "alice"
npm run cli -- init --nametag alice             # Initialize wallet in profile
npm run cli -- wallet create bob                # Create another profile
npm run cli -- init --nametag bob               # Initialize second wallet
npm run cli -- wallet list                      # List all profiles
npm run cli -- wallet use alice                 # Switch to alice
npm run cli -- send @bob 0.1 --coin BTC         # Send from alice to bob
npm run cli -- wallet use bob                   # Switch to bob
npm run cli -- balance --finalize               # Check bob's balance (fetch + finalize)
```

CLI stores data in `./.sphere-cli/` directory.

## Storage

Node.js implementation uses **file-based storage**:

| Data | Location | Format |
|------|----------|--------|
| Wallet (keys, nametag) | `dataDir/wallet.json` (or custom file name) | JSON (plaintext or password-encrypted mnemonic) |
| Tokens | `tokensDir/_<tokenId>.json` | One JSON file per token |

> **Note:** IPFS sync is available for both browser and Node.js. See [IPFS Token Sync](#ipfs-token-sync-optional) below.

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
  └── wallet.json      # Wallet data (mnemonic stored plaintext or password-encrypted)

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

  // Custom wallet file name (default: 'wallet.json')
  // Use .txt extension for plain mnemonic files (no JSON wrapper)
  walletFileName: 'my-wallet.json',

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

  // Price provider (optional — enables fiat value display)
  price: {
    platform: 'coingecko',    // Currently supported: 'coingecko'
    apiKey: 'CG-xxx',         // Optional (free tier works without key)
    cacheTtlMs: 60000,        // Cache TTL in ms (default: 60s)
  },
});
```

## IPFS Token Sync (Optional)

Enable decentralized token backup to IPFS/IPNS. No extra packages needed — uses built-in HTTP API.

```typescript
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  tokenSync: {
    ipfs: { enabled: true },
  },
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

// Sync tokens with IPFS (merges local and remote data)
const result = await sphere.payments.sync();
console.log(`Sync: +${result.added} -${result.removed}`);
```

**Recovery after local data loss:** Re-initialize the wallet with the same mnemonic and call `sync()`. Tokens stored on IPFS will be restored automatically.

See [IPFS Storage Guide](./IPFS-STORAGE.md) for full configuration, caching details, and troubleshooting.

## Common Operations

### Check Balance & Assets

```typescript
// Get assets with price data (price fields are null without PriceProvider)
const assets = await sphere.payments.getAssets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  if (asset.fiatValueUsd != null) {
    console.log(`  Value: $${asset.fiatValueUsd.toFixed(2)}`);
  }
}

// Total portfolio value in USD (null if PriceProvider not configured)
const totalUsd = await sphere.payments.getBalance();
console.log('Total USD:', totalUsd); // number | null

// L1 (ALPHA) balance
const l1Balance = await sphere.payments.l1.getBalance();
console.log('L1 Balance:', l1Balance);
```

### Send Tokens

```typescript
// Send to nametag (instant mode — default)
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',  // In base units
  coinId: 'UCT',
});

// Send with conservative mode (collect proofs first, then deliver)
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  transferMode: 'conservative',
});

// Send to direct address
const result = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId: 'UCT',
});
```

### Fetch Pending Transfers (Explicit Receive)

For batch/CLI apps, use `receive()` to explicitly query the Nostr relay for pending events:

```typescript
// Fetch and process all pending incoming transfers
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);

// With callback for each transfer
await sphere.payments.receive(undefined, (transfer) => {
  console.log(`Received ${transfer.tokens.length} tokens`);
});
```

### Register Nametag

> **Note:** `registerNametag()` mints a token on-chain. This uses the Oracle (Aggregator) provider which is included by default with `createNodeProviders()`.

```typescript
// This registers on Nostr AND mints token on-chain
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
// From mnemonic (plaintext storage — default)
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve word mnemonic phrase here ...',
});

// From mnemonic with password encryption
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve word mnemonic phrase here ...',
  password: 'my-secret-password',
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

## Password Encryption

By default, the mnemonic is stored as **plaintext** in `wallet.json`. You can optionally encrypt it with a password:

```typescript
// Create wallet with password encryption
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  password: 'my-secret-password',
});

// Load wallet with password
const { sphere } = await Sphere.init({
  ...providers,
  password: 'my-secret-password',
});

// Load wallet without password (plaintext mnemonic — default)
const { sphere } = await Sphere.init({ ...providers });
```

**Backwards compatibility:** Wallets created with older SDK versions (encrypted with the internal default key) will load correctly without a password.

### Custom Wallet File Names

```typescript
// Use a custom file name
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  walletFileName: 'my-wallet.json',
});

// Use .txt extension — stores only the mnemonic (no JSON wrapper)
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  walletFileName: 'mnemonic.txt',
});
```

### Loading External Wallet Files

If you have a plaintext mnemonic file from another source, simply point `FileStorageProvider` at it:

```typescript
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

// Load from any .txt file containing a mnemonic
const storage = new FileStorageProvider({
  dataDir: './wallet-data',
  fileName: 'external-mnemonic.txt',
});

const { sphere } = await Sphere.init({
  storage,
  tokenStorage: providers.tokenStorage,
  transport: providers.transport,
  oracle: providers.oracle,
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
sphere.on('payment_request:incoming', handler);
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

## Custom CLI Example

Build your own CLI tool using the SDK:

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
- [IPFS Storage Guide](./IPFS-STORAGE.md) - IPFS/IPNS token sync configuration
- [Browser Quick Start](./QUICKSTART-BROWSER.md) - For web applications
