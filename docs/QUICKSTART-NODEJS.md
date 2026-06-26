# Sphere SDK - Node.js Quick Start

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
> **Networks:** since the v1→v2 cutover, `network: 'testnet'` points at the **testnet2 v2 gateway** (`https://gateway.testnet2.unicity.network`; the network id comes from the trust base). `'testnet2'` is an alias of the same configuration. `mainnet`/`dev` still point at v1-era aggregators and cannot serve the v2 engine yet — wallet operations there fail with `AGGREGATOR_ERROR`.

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

# Top up with test tokens (self-mint via the v2 token engine — no faucet)
sphere topup 10 UCT

# Register nametag (publishes a Nostr identity binding)
sphere nametag myname

# Verify tokens against the gateway (detect spent tokens)
sphere verify-balance
```

> **Note:** Nametag registration publishes a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). A self-issued v2 Unicity ID token is additionally minted and stored best-effort; runtime name resolution uses only the Nostr binding.

### Transfer Mode

v2 transfers are **sender-driven**: the sender certifies the transfer on-chain (collects the inclusion proof) and delivers a finished token via wallet-api mailbox — the receiver stores it as confirmed with no finalization phase. The old `instant`/`conservative` transfer modes from the v1 engine no longer exist; the `transferMode` field on `TransferRequest` is still accepted for backwards compatibility but ignored.

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
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

async function main() {
  // 1. Create base providers (handles storage, transport, oracle)
  const base = createNodeProviders({
    network: 'testnet',
    dataDir: './wallet-data',
    tokensDir: './tokens-data',
    oracle: {
      apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key
    },
  });

  // 2. Compose v2 wallet-api providers (adds delivery + token storage ports)
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-stable-device-id',
  });

  // 3. Initialize wallet (auto-creates if doesn't exist)
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet2', // Required for v2 testnet2 operations
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

./tokens-data/
  ├── _meta.json       # Token storage metadata
  └── _<tokenId>.json  # One file per token
```

## Configuration Options

```typescript
// Step 1: Create base providers
const base = createNodeProviders({
  // Network: 'mainnet' | 'testnet' | 'testnet2' | 'dev'
  // ('testnet' IS testnet2 — the v2 gateway; mainnet/dev are still v1-era and
  //  cannot serve the v2 engine yet)
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

// Step 2: Compose wallet-api providers (required for v2 mailbox delivery)
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',  // Wallet-api server
  network: 'testnet2',                             // Must match v2 network
  deviceId: 'my-device-id',                        // Stable per-device label (optional — random if omitted)
});
```

## IPFS Token Sync (Optional)

Enable decentralized token backup to IPFS/IPNS. No extra packages needed — uses built-in HTTP API.

```typescript
const base = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  tokenSync: {
    ipfs: { enabled: true },
  },
});

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId: 'my-stable-device-id',
});

const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,
});

// Sync tokens with IPFS (merges local and remote data)
const result = await sphere.payments.sync();
console.log(`Sync: +${result.added} -${result.removed}`);
```

**Recovery after local data loss:** Re-initialize the wallet with the same mnemonic and call `sync()`. Tokens stored on IPFS will be restored automatically.

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

// Per-coin balances (synchronous, no price data)
const balances = sphere.payments.getBalance(); // Asset[]

// Total portfolio value in USD (null if PriceProvider not configured)
const totalUsd = await sphere.payments.getFiatBalance();
console.log('Total USD:', totalUsd); // number | null
```

### Top Up (Testnet Self-Mint)

There is no faucet — on testnet you top up by **self-minting** tokens via the v2 token engine:

```typescript
import { TokenRegistry } from '@unicitylabs/sphere-sdk';

// mintFungibleToken takes the hex coin id, not the symbol
const coinId = TokenRegistry.getInstance().getCoinIdBySymbol('UCT');
const res = await sphere.payments.mintFungibleToken(coinId!, 100_000_000n);
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

> The legacy `transferMode` field (`'instant' | 'conservative'`) is still accepted on `TransferRequest` for backwards compatibility but **ignored** — v2 has a single sender-driven transfer flow.

### Fetch Pending Transfers (Explicit Receive)

For batch/CLI apps, use `receive()` to explicitly query the wallet-api mailbox for pending events:

```typescript
// Fetch and process all pending incoming transfers
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);

// With callback for each transfer (called as transfers are processed)
await sphere.payments.receive(undefined, (transfer) => {
  console.log(`Received ${transfer.tokens.length} tokens`);
  for (const token of transfer.tokens) {
    console.log(`  ${token.amount} ${token.symbol}`);
  }
  console.log(`From: ${transfer.senderNametag ?? transfer.senderPubkey}`);
});
```

> The legacy `ReceiveOptions` (`finalize`, `timeout`, `pollInterval`) are deprecated **no-ops**: v2 transfers arrive as finished tokens via the mailbox provider and are stored confirmed immediately — there is no finalization phase.

### Register Nametag

> **Note:** `registerNametag()` registers the name by publishing a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). A self-issued v2 Unicity ID token is additionally minted and stored **best-effort** — registration never fails because of it. Runtime name resolution uses only the Nostr binding.

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

const base = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
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
// Commonly used events (see SphereEventMap in types/index.ts for the full list)
sphere.on('transfer:incoming', handler);
sphere.on('transfer:confirmed', handler);
sphere.on('transfer:failed', handler);
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

## Invoicing

> **⚠️ Experimental — not production-ready.** Invoicing/accounting is implemented and
> unit-tested, but it has no live/e2e verification, is used by no shipped app, and is **not
> enabled in the Sphere wallet** (nor supported over Connect). Treat the API as unstable.

The `AccountingModule` handles the full invoice lifecycle — creation, status queries, payment, and closing. Enable it by passing `accounting: true` to `Sphere.init()`.

> **Note:** The accounting module requires the Oracle provider (v2 gateway config), which is included by default with `createNodeProviders()`. Invoices are minted as data tokens via the v2 token engine.

```typescript
const base = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
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
  network: 'testnet2',
  autoGenerate: true,
  accounting: true,   // Enable with defaults
});

const accounting = sphere.accounting!;
```

### Create an Invoice

```typescript
const result = await accounting.createInvoice({
  targets: [
    {
      address: sphere.identity!.directAddress!,  // Pay to own address
      assets: [
        { coin: ['UCT', '1000000'] },            // 1 UCT in smallest units
      ],
    },
  ],
  memo: 'Order #1234',
  dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days from now
});

if (result.success) {
  console.log('Invoice ID:', result.invoiceId);
  console.log('Terms:', result.terms);
}
```

### Check Invoice Status

```typescript
const status = await accounting.getInvoiceStatus(result.invoiceId!);

// state: 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED'
console.log('State:', status.state);
console.log('All confirmed:', status.allConfirmed);

for (const target of status.targets) {
  for (const asset of target.assets) {
    console.log(`  ${asset.coinId}: paid ${asset.totalForward} of ${asset.requested}`);
  }
}
```

### Pay an Invoice

```typescript
// Pay the first asset of the first target (defaults to the remaining needed amount)
const transfer = await accounting.payInvoice(invoiceId, {
  targetIndex: 0,
  assetIndex: 0,    // Optional, defaults to 0
});

console.log('Transfer status:', transfer.status);
```

### List All Invoices

```typescript
// All invoices
const all = await accounting.getInvoices();

// Filter by state
const open = await accounting.getInvoices({ state: 'OPEN' });
const mine = await accounting.getInvoices({ createdByMe: true });
```

### Close an Invoice

```typescript
// Marks invoice as CLOSED; no further payments are attributed
await accounting.closeInvoice(invoiceId);

// Optionally auto-return any overpayments before closing
await accounting.closeInvoice(invoiceId, { autoReturn: true });
```

### Listen to Invoice Events

```typescript
sphere.on('invoice:created', ({ invoiceId, confirmed }) => {
  console.log('Invoice minted:', invoiceId, confirmed ? '(confirmed)' : '(unconfirmed)');
});

sphere.on('invoice:payment', ({ invoiceId, paymentDirection, confirmed }) => {
  console.log(`Payment on ${invoiceId}: direction=${paymentDirection}`);
});

sphere.on('invoice:covered', ({ invoiceId, confirmed }) => {
  console.log('Invoice fully covered:', invoiceId);
});

sphere.on('invoice:closed', ({ invoiceId, explicit }) => {
  console.log('Invoice closed:', invoiceId, explicit ? '(by owner)' : '(auto)');
});

sphere.on('invoice:overpayment', ({ invoiceId, coinId, surplus }) => {
  console.log(`Overpayment on ${invoiceId}: +${surplus} ${coinId}`);
});
```

## Token Swaps

The swap module enables trustless two-party token exchanges via an escrow service. Enable it when initializing:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,
  accounting: true,  // Required (swap uses invoices internally)
  swap: true,        // Enable swap module
});
```

**Propose a swap:**

```typescript
const result = await sphere.swap!.proposeSwap({
  partyA: sphere.identity!.directAddress!,
  partyB: '@bob',
  partyACurrency: 'UCT',
  partyAAmount: '1000000',
  partyBCurrency: 'USDU',
  partyBAmount: '500000',
  timeout: 3600,
  escrowAddress: '@escrow-testnet',
});

console.log('Swap ID:', result.swapId);
```

**Accept and deposit (counterparty side):**

```typescript
sphere.on('swap:proposal_received', async (data) => {
  console.log('Swap proposal from:', data.senderNametag ?? data.senderPubkey);

  await sphere.swap!.acceptSwap(data.swapId);
  const transfer = await sphere.swap!.deposit(data.swapId);
  console.log('Deposit sent:', transfer.id);
});
```

**Deposit (proposer side, after counterparty accepts):**

```typescript
sphere.on('swap:announced', async (data) => {
  const transfer = await sphere.swap!.deposit(data.swapId);
  console.log('Deposit sent:', transfer.id);
});
```

**Monitor swap lifecycle:**

```typescript
sphere.on('swap:completed', ({ swapId, payoutVerified }) => {
  console.log('Swap completed:', swapId, 'Verified:', payoutVerified);
});

sphere.on('swap:cancelled', ({ swapId, reason, depositsReturned }) => {
  console.log('Swap cancelled:', swapId, reason, 'Returned:', depositsReturned);
});

sphere.on('swap:failed', ({ swapId, error }) => {
  console.log('Swap failed:', swapId, error);
});
```

**List and query:**

```typescript
const swaps = sphere.swap!.getSwaps({ excludeTerminal: true });
const status = await sphere.swap!.getSwapStatus(swapId, { queryEscrow: true });
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
    tokensDir: './my-tokens',
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
Ensure directories exist and are writable:
```typescript
import fs from 'fs';
fs.mkdirSync('./wallet-data', { recursive: true });
fs.mkdirSync('./tokens-data', { recursive: true });
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
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns
- [Browser Quick Start](./QUICKSTART-BROWSER.md) - For web applications
