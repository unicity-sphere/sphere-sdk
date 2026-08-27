# Sphere SDK - Node.js Quick Start

> **On 0.15.0.** The base SDK pin moved to `@unicitylabs/state-transition-sdk@3.0.1` — a wire
> break that no client can straddle, so your wallet-api deployment has to bump with you (see the
> [flag-day section](../README.md#0150--the-state-transition-sdk-301-flag-day)). What that
> changes in this guide is `sphere.paymentsV2` — the alias is **removed**, and `sphere.payments`
> **throws** `NOT_INITIALIZED` where the alias returned `null` while no vertical was running —
> plus the payment-journal key prefix below (`pv2:` → `pv2g2:`, swept for you). Everything else
> is untouched, and everything below already uses `sphere.payments`.

Get up and running with Sphere SDK in Node.js in under 5 minutes.

## Installation

```bash
npm install @unicitylabs/sphere-sdk ws
```

| Package | Required | Description |
|---------|----------|-------------|
| `@unicitylabs/sphere-sdk` | Yes | The SDK |
| `ws` | Node < 22 | WebSocket for the Nostr transport (messaging); optional on Node ≥ 22 (global `WebSocket`) |

**Node.js version:** 18.0.0 or higher

> **Note:** No API key is bundled with the SDK. The `testnet` gateway (testnet2, see below) requires one — inject it via `oracle: { apiKey: '...' }`. The testnet2 key is **not a secret** (see `.env.example`): `sk_ddc3cfcc001e4a28ac3fad7407f99590`. A mainnet key, by contrast, IS a secret — keep it in your deploy environment only.
>
> **Networks:** since the v1→v2 cutover, `network: 'testnet'` points at the **testnet2 gateway network** (`https://gateway.testnet2.unicity.network`; the network id comes from the trust base). `'testnet2'` is an alias of the same configuration. `mainnet`/`dev` still point at v1-era aggregators and cannot serve the engine — wallet operations there fail with `AGGREGATOR_ERROR`. The "2" in testnet2 names the **gateway network**, not the base-SDK major: testnet2 is still testnet2 on state-transition-sdk 3.x.

## CLI (Quick Testing)

The CLI has moved to a dedicated package — [`@unicity-sphere/cli`](https://github.com/unicity-sphere/sphere-cli). See [QUICKSTART-CLI.md](QUICKSTART-CLI.md) for the full command reference.

```bash
npm install -g @unicity-sphere/cli
sphere --help
```

The examples below use `sphere <command>` — replace any old `npm run cli -- <command>` references accordingly.

```bash
# Initialize wallet
sphere init --network testnet

# Initialize wallet WITH nametag (publishes a Nostr identity binding)
sphere init --network testnet --nametag alice

# Check status
sphere status

# Check balance (fetches pending transfers first)
sphere balance

# Send tokens (the sender certifies the transfer on-chain, then delivers
# the finished token via wallet-api mailbox)
sphere send @alice 1 UCT

# Show receive address
sphere receive

# Top up with test tokens (self-mint via the token engine — no faucet)
sphere topup 10 UCT

# Register nametag (publishes a Nostr identity binding)
sphere nametag myname

# Verify tokens against the gateway (detect spent tokens)
sphere verify-balance
```

> **Note:** Nametag registration publishes a Nostr identity binding (name ↔ chain pubkey, first-seen-wins); runtime name resolution uses only the Nostr binding.

### Transfer Mode

Transfers are **sender-driven**: the sender certifies the transfer on-chain (collects the inclusion proof) and deposits the finished token into the recipient's wallet-api mailbox — the receiver verifies and stores it as confirmed with no finalization phase. There is a single transfer flow; the old `instant`/`conservative` modes no longer exist.

### Address Management

```bash
sphere addresses                        # List all tracked addresses
sphere switch 1                         # Switch to address at HD index 1
sphere hide 2                           # Hide address from active list
sphere unhide 2                         # Unhide address
```

### Direct Messages

```bash
sphere dm @alice "Hello, how are you?"  # Send a DM
sphere dm-inbox                         # List conversations + unread counts
sphere dm-history @alice                 # Show conversation history
sphere dm-history @alice --limit 20      # Limit messages shown
```

### Group Chat (NIP-29)

```bash
sphere group-list                                        # List available groups
sphere group-create "Trading Chat" --description "Discuss trades"  # Create group
sphere group-create "Private" --private                  # Create private group
sphere group-join <groupId>                              # Join a group
sphere group-join <groupId> --invite <code>              # Join with invite code
sphere group-send <groupId> "Hello everyone!"            # Send message
sphere group-send <groupId> "Reply" --reply <eventId>    # Reply to message
sphere group-messages <groupId> --limit 20               # Show messages
sphere group-members <groupId>                           # List members
sphere group-info <groupId>                              # Show group details
sphere group-leave <groupId>                             # Leave group
sphere group-my                                          # List your groups
```

### Market (Intent Bulletin Board)

```bash
sphere market-post "Buying 100 UCT" --type buy                    # Post buy intent
sphere market-post "Selling ETH" --type sell --price 50 --currency USD  # Post sell intent
sphere market-post "Web dev services" --type service              # Post service intent
sphere market-search "UCT tokens" --type sell --limit 5           # Search intents
sphere market-search "tokens" --min-score 0.7                     # Search with score threshold
sphere market-my                                                  # List own intents
sphere market-close <id>                                          # Close an intent
sphere market-feed                                                # Watch live feed (WebSocket)
sphere market-feed --rest                                         # Fetch recent (REST fallback)
```

### Wallet Profiles

Manage multiple wallets for testing:

```bash
sphere wallet create alice              # Create profile "alice"
sphere init --nametag alice             # Initialize wallet in profile
sphere wallet create bob                # Create another profile
sphere init --nametag bob               # Initialize second wallet
sphere wallet list                      # List all profiles
sphere wallet use alice                 # Switch to alice
sphere send @bob 0.1 BTC                 # Send from alice to bob
sphere wallet use bob                   # Switch to bob
sphere balance                          # Check bob's balance
```

CLI stores data in `./.sphere-cli/` directory.

## Storage

Node.js implementation uses **file-based storage** for local state; token custody is the wallet-api backend:

| Data | Location | Format |
|------|----------|--------|
| Wallet (keys, nametag) + payment journals (`pv2g2:*`) | `dataDir/wallet.json` (or custom file name) | JSON (plaintext or password-encrypted mnemonic) |
| Token inventory + transfer intents + mailbox + history | Wallet API server | Server custody |


## Minimal Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

async function main() {
  // 1. Create base providers (handles storage, transport, oracle)
  const base = createNodeProviders({
    network: 'testnet',
    dataDir: './wallet-data',
    oracle: {
      apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key
    },
  });

  // 2. Attach the wallet-api transport config (REQUIRED — money rides the wallet-api vertical)
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-stable-device-id',
  });

  // 3. Initialize wallet (auto-creates if doesn't exist)
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet2', // Required: it selects the token registry, and it must equal
                         // walletApi.network (a mismatch throws INVALID_CONFIG)
    autoGenerate: true,
  });

  // 4. Save mnemonic on first run!
  if (created && generatedMnemonic) {
    console.log('SAVE THIS MNEMONIC:', generatedMnemonic);
  }

  // 5. Use the wallet
  console.log('Direct Address:', sphere.identity?.directAddress);

  // 6. Cleanup
  await sphere.destroy();
}

main().catch(console.error);
```

## What Gets Created

```
./wallet-data/
  └── wallet.json      # Wallet data (mnemonic stored plaintext or password-encrypted)
                       # + per-address payment journals under pv2g2:* keys
```

Tokens live in the wallet-api backend (server custody) — no local token files.

The `pv2g2:` prefix is 0.15.0's generation of the scoped KV (it was `pv2:` through 0.14.x). The
rename is the migration — the superseded keys are swept once when the wallet composes its
payments vertical, and there is nothing for you to run or delete.

## Configuration Options

```typescript
// Step 1: Create base providers
const base = createNodeProviders({
  // Network: 'mainnet' | 'testnet' | 'testnet2' | 'dev'
  // ('testnet' IS testnet2 — the v2 gateway network; mainnet/dev are still
  //  v1-era and cannot serve the engine)
  network: 'testnet',

  // Storage directory (required)
  dataDir: './wallet-data',

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

  // Oracle (v2 gateway) options
  oracle: {
    url: 'https://gateway.testnet2.unicity.network',  // Replace default gateway URL
    trustBasePath: './trustbase.json',                // Local trust base file (optional)
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',    // Gateway API key (public testnet2 key)
  },

  // Price provider (optional — enables fiat value display)
  price: {
    platform: 'coingecko',    // Currently supported: 'coingecko'
    apiKey: 'CG-xxx',         // Optional (free tier works without key)
    cacheTtlMs: 60000,        // Cache TTL in ms (default: 60s)
  },
});

// Step 2: Attach the wallet-api transport config (required for money)
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',  // Wallet-api server
  network: 'testnet2',                             // Must match v2 network
  deviceId: 'my-device-id',                        // Stable per-device label (optional — random if omitted)
});
```

## Common Operations

### Check Balance & Assets

```typescript
// Get assets with price data (price fields are null without PriceProvider)
const assets = await sphere.payments.assets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  if (asset.fiatValueUsd != null) {
    console.log(`  Value: $${asset.fiatValueUsd.toFixed(2)}`);
  }
}

// Individual tokens (synchronous inventory view)
const tokens = sphere.payments.tokens();

// Total portfolio value in USD
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
console.log('Total USD:', totalUsd);
```

### Top Up (Testnet Self-Mint)

There is no faucet — on testnet you top up by **self-minting** tokens via the token engine:

```typescript
import { TokenRegistry } from '@unicitylabs/sphere-sdk';

// mint takes the hex coin id, not the symbol
const coinId = TokenRegistry.getInstance().getCoinIdBySymbol('UCT');
const res = await sphere.payments.mint(coinId!, 100_000_000n);
if (res.success) {
  console.log('Minted token:', res.tokenId);
} else {
  console.error('Mint failed:', res.error);
}
```

### Look Up Asset Metadata

The `TokenRegistry` provides metadata (symbol, name, decimals, icons) for all registered assets on the network:

```typescript
import { TokenRegistry } from '@unicitylabs/sphere-sdk';

const registry = TokenRegistry.getInstance();

// List all registered assets
const allAssets = registry.getAllDefinitions();
const coins = registry.getFungibleTokens();
const nfts = registry.getNonFungibleTokens();

// Look up a specific asset
const uct = registry.getDefinitionBySymbol('UCT');
console.log(uct?.name, uct?.decimals);  // 'Unicity Token', 8

// Reverse lookup: symbol → coin ID
const coinId = registry.getCoinIdBySymbol('UCT');
```

> **Note:** The registry is configured automatically by `createNodeProviders()` and `Sphere.init()`. Data is fetched from the network and cached to disk.

### Send Tokens

```typescript
// Send to nametag — the sender certifies the transfer on-chain (collects the
// inclusion proof) and delivers a finished token via wallet-api mailbox
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',  // In base units
  coinId: 'UCT',      // Short symbols are resolved via the TokenRegistry
});

console.log('Transfer ID:', result.id);
console.log('Status:', result.status);
if (result.deliveryPending) {
  console.log('Note: certified on-chain, delivery deferred (normal behavior)');
}

// Send to direct address
const result2 = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId: 'UCT',
});
```

### Fetch Pending Transfers (Explicit Receive)

For batch/CLI apps, use `receive()` to explicitly drain the wallet-api mailbox:

```typescript
// Fetch and process all pending incoming transfers
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);
for (const transfer of transfers) {
  for (const token of transfer.tokens) {
    console.log(`  ${token.amount} ${token.symbol}`);
  }
  console.log(`From: ${transfer.senderNametag ?? transfer.senderPubkey}`);
}
```

> `receive()` takes no options: transfers arrive as finished tokens, verified against the trust base and stored confirmed immediately — there is no finalization phase. While the wallet runs, the mailbox is also drained automatically.

### Register Nametag

> **Note:** `registerNametag()` registers the name by publishing a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). Runtime name resolution uses only the Nostr binding.

```typescript
// Publishes the Nostr binding; throws if the name is already taken
await sphere.registerNametag('myusername');
console.log('Registered:', sphere.identity?.nametag);
```

### Listen for Incoming Transfers

```typescript
// Handlers receive the event payload directly (IncomingTransfer)
sphere.on('transfer:incoming', (transfer) => {
  for (const token of transfer.tokens) {
    console.log('Received:', token.amount, token.symbol);
  }
  console.log('From:', transfer.senderNametag ?? transfer.senderPubkey);
});
```

### Send Direct Messages

```typescript
await sphere.communications.sendDM('@alice', 'Hello!');

sphere.communications.onDirectMessage((msg) => {
  console.log('Message from', msg.senderNametag ?? msg.senderPubkey, ':', msg.content);
});
```

## Import Existing Wallet

```typescript
// From mnemonic (plaintext storage — default)
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve word mnemonic phrase here ...',
});

// From mnemonic with password encryption
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve word mnemonic phrase here ...',
  password: 'my-secret-password',
});

// From master key (legacy)
const sphere = await Sphere.import({
  masterKey: '64-char-hex-master-key',
  chainCode: '64-char-hex-chain-code',
  basePath: "m/84'/1'/0'",
  derivationMode: 'bip32',
  network: 'testnet2',
  ...providers,
});
```

## Password Encryption

By default, the mnemonic is stored as **plaintext** in `wallet.json`. You can optionally encrypt it with a password:

```typescript
// Create wallet with password encryption
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,
  password: 'my-secret-password',
});

// Load wallet with password
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  password: 'my-secret-password',
});

// Load wallet without password (plaintext mnemonic — default)
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2' });
```

**Backwards compatibility:** Wallets created with older SDK versions (encrypted with the internal default key) will load correctly without a password.

### Custom Wallet File Names

```typescript
// Use a custom file name
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  walletFileName: 'my-wallet.json',
});

// Use .txt extension — stores only the mnemonic (no JSON wrapper)
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
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

const base = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
  },
});

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId: 'my-device-id',
});

const { sphere } = await Sphere.init({
  ...providers,
  storage, // Override with custom storage
  network: 'testnet2',
});
```

## Multi-Address Wallet

```typescript
// Get current address index
const index = sphere.getCurrentAddressIndex(); // 0

// Switch to different address
await sphere.switchToAddress(1);
console.log('New address:', sphere.identity?.directAddress);

// Register nametag for this address
await sphere.registerNametag('myname-work');

// Derive address without switching
const addr = sphere.deriveAddress(2);
console.log(addr.path, addr.publicKey);
```

## Event Handling

```typescript
// The payments vertical emits exactly 8 events; identity/comms events ride the
// same bus (see SphereEventMap in types/index.ts for the full list)
sphere.on('transfer:incoming', handler);        // IncomingTransfer
sphere.on('transfer:updated', handler);         // TransferResult (read status/deliveryPending)
sphere.on('transfer:attention', handler);       // { transferId, code, detail? }
sphere.on('inventory:updated', handler);        // {}
sphere.on('history:updated', handler);          // HistoryEntry (the recorded entry)
sphere.on('payment_request:incoming', handler); // PaymentRequestView
sphere.on('payment_request:updated', handler);  // { id, status }
sphere.on('connection:status', handler);        // { status: 'connected'|'degraded'|'offline' }
sphere.on('message:dm', handler);
sphere.on('message:broadcast', handler);
sphere.on('connection:changed', handler);
sphere.on('nametag:registered', handler);
sphere.on('nametag:recovered', handler);
sphere.on('identity:changed', handler);

// Unsubscribe
const unsubscribe = sphere.on('transfer:incoming', handler);
unsubscribe(); // Stop listening
```

## Payment Requests

Request payments over the wallet-api rail (`sphere.payments.requests`):

```typescript
// Send a payment request (memo travels in an encrypted envelope)
const result = await sphere.payments.requests.create('@bob', {
  coinId: 'UCT',
  amount: '1000000',
  memo: 'Order #1234',
});

// Track outgoing request status
sphere.on('payment_request:updated', ({ id, status }) => {
  // 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
  console.log(`Request ${id}: ${status}`);
});

// Handle incoming requests
sphere.on('payment_request:incoming', async (request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);
  await sphere.payments.requests.pay(request.id);      // pay...
  // await sphere.payments.requests.decline(request.id); // ...or decline
});

// Current views + housekeeping
const requests = sphere.payments.requests.list();
sphere.payments.requests.dismissProcessed();
```

> Paying is crash-safe: a request is durably `settling` before any possibly-committed
> error can surface, so a restart never double-pays.

## Transaction History

History is a server read-through, paged:

```typescript
const page = await sphere.payments.history({ limit: 50 });
for (const entry of page.entries) {
  console.log(entry.type, entry.amount, entry.symbol, new Date(entry.timestamp));
}
if (page.more) {
  const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });
}
```

## Error Handling

```typescript
import { isSphereError } from '@unicitylabs/sphere-sdk';

try {
  const result = await sphere.payments.send({
    coinId: 'UCT',
    amount: '1000000',
    recipient: '@alice',
  });
  console.log('Sent:', result.id, result.status);
} catch (error) {
  if (isSphereError(error)) {
    switch (error.code) {
      case 'INSUFFICIENT_BALANCE':
        console.error('Not enough funds');
        break;
      case 'INVALID_RECIPIENT':
        console.error('Recipient not found');
        break;
      case 'TRANSPORT_ERROR':
        console.error('Network issue, try again');
        break;
      default:
        console.error('Transfer failed:', error.message);
    }
  } else {
    console.error('Unexpected error:', error);
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
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

async function main() {
  const base = createNodeProviders({
    network: 'testnet',
    dataDir: './my-wallet',
    oracle: {
      apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
    },
  });

  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-device-id',
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet2',
    autoGenerate: true,
  });

  if (created) {
    console.log('\n=== NEW WALLET CREATED ===');
    console.log('Mnemonic (SAVE THIS!):', generatedMnemonic);
    console.log('==========================\n');
  }

  console.log('Direct Address:', sphere.identity?.directAddress);
  console.log('Nametag:', sphere.identity?.nametag || '(not registered)');

  // Listen for incoming transfers (handler receives the IncomingTransfer payload)
  sphere.on('transfer:incoming', (transfer) => {
    console.log('\nIncoming transfer!');
    for (const token of transfer.tokens) {
      console.log('Amount:', token.amount, token.symbol);
    }
    console.log('From:', transfer.senderNametag ?? transfer.senderPubkey);
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
const base = createNodeProviders({
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
Ensure the data directory exists and is writable:
```typescript
import fs from 'fs';
fs.mkdirSync('./wallet-data', { recursive: true });
```

### Debug Logging

Enable SDK debug logging to diagnose issues:

```typescript
import { logger } from '@unicitylabs/sphere-sdk';

// Enable all debug logging
logger.configure({ debug: true });

// Enable only specific modules
logger.setTagDebug('Nostr', true);    // Transport logs
logger.setTagDebug('Payments', true); // Payment logs

// Custom log handler (e.g., write to file)
logger.configure({
  debug: true,
  handler: (level, tag, message, ...args) => {
    fs.appendFileSync('sdk.log', `[${level}] [${tag}] ${message}\n`);
  },
});
```

## Next Steps

- [API Reference](./API.md) - Full API documentation
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns, and [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150)
- [Connect Protocol](./CONNECT.md) - dApp ↔ wallet RPC (protocol version `2.1`)
- [Parallel token verification](./VERIFICATION-WORKERS.md) - The opt-in worker pool
- [Browser Quick Start](./QUICKSTART-BROWSER.md) - For web applications
