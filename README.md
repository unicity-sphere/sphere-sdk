# Sphere SDK

A modular TypeScript SDK for Unicity wallet operations supporting both Layer 1 (ALPHA blockchain) and Layer 3 (Unicity state transition network).

## Features

- **Wallet Management** - BIP39/BIP32 key derivation, AES-256 encryption
- **L1 Payments** - ALPHA blockchain transactions via Fulcrum WebSocket
- **L3 Payments** - Token transfers with state transition proofs
- **Payment Requests** - Request payments with async response tracking
- **Nostr Transport** - P2P messaging with NIP-04 encryption
- **IPFS Storage** - Decentralized token backup with Helia
- **Token Splitting** - Partial transfer amount calculations
- **Multi-Address** - HD address derivation (BIP32/BIP44)
- **TXF Serialization** - Token eXchange Format for storage and transfer
- **Token Validation** - Aggregator-based token verification
- **Core Utilities** - Crypto, currency, bech32, base58 functions

## Installation

```bash
npm install @unicitylabs/sphere-sdk
```

## Quick Start Guides

Choose your platform:

| Platform | Guide | Required | Optional |
|----------|-------|----------|----------|
| **Browser** | [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) | SDK only | `helia` (IPFS sync) |
| **Node.js** | [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) | SDK + `ws` | - |
| **CLI** | See below | SDK + `tsx` | - |

## CLI (Command Line Interface)

The SDK includes a CLI for quick testing and development:

```bash
# Show help
npm run cli -- --help

# Initialize new wallet on testnet
npm run cli -- init --network testnet

# Initialize with nametag (mints token on-chain)
npm run cli -- init --network testnet --nametag alice

# Import existing wallet
npm run cli -- init --mnemonic "your 24 words here"

# Check wallet status
npm run cli -- status

# Check balance
npm run cli -- balance

# Fetch pending transfers and finalize unconfirmed tokens
npm run cli -- balance --finalize

# Check for incoming transfers
npm run cli -- receive

# Check for incoming transfers and finalize unconfirmed tokens
npm run cli -- receive --finalize

# Send tokens (instant mode, default)
npm run cli -- send @alice 1 --coin UCT --instant

# Send tokens (conservative mode — collect all proofs first)
npm run cli -- send @alice 1 --coin UCT --conservative

# Request test tokens from faucet
npm run cli -- topup

# Register nametag
npm run cli -- nametag myname

# Show transaction history
npm run cli -- history 10

# Verify tokens against aggregator (detect spent tokens)
npm run cli -- verify-balance
```

### Available CLI Commands

| Category | Command | Description |
|----------|---------|-------------|
| **Wallet** | `init [--network <net>] [--mnemonic "<words>"] [--nametag <name>]` | Create or import wallet |
| | `status` | Show wallet identity |
| | `config` | Show/set configuration |
| **Profiles** | `wallet list` | List all wallet profiles |
| | `wallet use <name>` | Switch to a wallet profile |
| | `wallet create <name> [--network <net>]` | Create a new wallet profile |
| | `wallet delete <name>` | Delete a wallet profile |
| | `wallet current` | Show current wallet profile |
| **Balance** | `balance [--finalize]` | Show L3 token balance (--finalize: fetch pending + resolve) |
| | `tokens` | List all tokens with details |
| | `l1-balance` | Show L1 (ALPHA) balance |
| | `topup [coin] [amount]` | Request test tokens from faucet |
| | `verify-balance [--remove] [-v]` | Verify tokens against aggregator |
| **Transfers** | `send <to> <amount> [--coin SYM] [--instant\|--conservative]` | Send tokens |
| | `receive [--finalize]` | Check for incoming transfers |
| | `history [limit]` | Show transaction history |
| **Nametags** | `nametag <name>` | Register a nametag |
| | `nametag-info <name>` | Lookup nametag info |
| | `my-nametag` | Show current nametag |
| | `nametag-sync` | Re-publish nametag with chainPubkey |
| **Utils** | `generate-key` | Generate random key |
| | `to-human <amount>` | Convert to human readable |
| | `parse-wallet <file>` | Parse wallet file |

CLI data is stored in `./.sphere-cli/` directory.

## Quick Start

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

// Create providers (browser) - defaults to mainnet
const providers = createBrowserProviders();

// Or use testnet for development
const testnetProviders = createBrowserProviders({ network: 'testnet' });

// Initialize (auto-creates wallet if needed)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,  // Generate mnemonic if wallet doesn't exist
});

if (created && generatedMnemonic) {
  console.log('Save this mnemonic:', generatedMnemonic);
}

// Get identity (L3 DIRECT address is primary)
console.log('Address:', sphere.identity?.directAddress);

// Get assets with price data
const assets = await sphere.payments.getAssets();
console.log('Assets:', assets);

// Get total portfolio value in USD (requires PriceProvider)
const balance = await sphere.payments.getBalance();
console.log('Total USD:', balance); // number | null

// Send tokens
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
});

// Derive additional addresses
const addr1 = sphere.deriveAddress(1);
console.log('Address 1:', addr1.address);
```

## Network Configuration

The SDK supports three network presets that configure all services automatically:

| Network | Aggregator | Nostr Relay | Electrum (L1) |
|---------|------------|-------------|---------------|
| `mainnet` | aggregator.unicity.network | relay.unicity.network | fulcrum.alpha.unicity.network |
| `testnet` | goggregator-test.unicity.network | nostr-relay.testnet.unicity.network | fulcrum.alpha.testnet.unicity.network |
| `dev` | dev-aggregator.dyndns.org | nostr-relay.testnet.unicity.network | fulcrum.alpha.testnet.unicity.network |

```typescript
// Use testnet for all services
const providers = createBrowserProviders({ network: 'testnet' });

// Override specific services while using network preset
const providers = createBrowserProviders({
  network: 'testnet',
  oracle: { url: 'https://custom-aggregator.example.com' }, // custom oracle
});

// L1 is enabled by default — customize if needed
const providers = createBrowserProviders({
  network: 'testnet',
  l1: { enableVesting: true },  // uses testnet electrum URL automatically
});
```

## Price Provider (Optional)

Enable fiat price display by adding a `price` config. Currently supports CoinGecko API (free and pro tiers).

```typescript
// With CoinGecko (free tier, no API key)
const providers = createBrowserProviders({
  network: 'testnet',
  price: { platform: 'coingecko' },
});

// With CoinGecko Pro
const providers = createBrowserProviders({
  network: 'testnet',
  price: { platform: 'coingecko', apiKey: 'CG-xxx' },
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

// Total portfolio value in USD
const totalUsd = await sphere.payments.getBalance();
// 1523.45

// Assets with price data
const assets = await sphere.payments.getAssets();
// [{ coinId, symbol, totalAmount, priceUsd: 97500, fiatValueUsd: 975.00, change24h: 2.3, ... }]
```

Without `price` config, `getBalance()` returns `null` and price fields in `getAssets()` are `null`. All other functionality works normally.

You can also set the price provider after initialization:

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: 'CG-xxx',
}));
```

## Testnet Faucet

To get test tokens on testnet, you **must first register a nametag**:

```typescript
// 1. Create wallet and register nametag
const { sphere } = await Sphere.init({
  ...createBrowserProviders({ network: 'testnet' }),
  autoGenerate: true,
  nametag: 'myname',  // Register @myname
});

// 2. Request tokens from faucet using nametag
const response = await fetch('https://faucet.unicity.network/api/v1/faucet/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ unicityId: 'myname', coin: 'unicity', amount: 100 }),
});
```

> **Note:** The faucet requires a registered nametag. Requests without a valid nametag will fail.

## Multi-Address Support

The SDK supports HD (Hierarchical Deterministic) wallets with multiple addresses:

```typescript
// Get current address index
const currentIndex = sphere.getCurrentAddressIndex(); // 0

// Switch to a different address
await sphere.switchToAddress(1);
console.log(sphere.identity?.l1Address); // alpha1... (address at index 1)

// Register nametag for this address (independent per address)
await sphere.registerNametag('bob');

// Switch back to first address
await sphere.switchToAddress(0);

// Get nametag for specific address
const bobNametag = sphere.getNametagForAddress(1); // 'bob'

// Get all address nametags
const allNametags = sphere.getAllAddressNametags();
// Map { 0 => 'alice', 1 => 'bob' }

// Derive address without switching (for display/receiving)
const addr2 = sphere.deriveAddress(2);
console.log(addr2.address, addr2.publicKey);
```

### Identity Properties

**Important:** L3 (DIRECT address) is the primary address for the Unicity network. L1 address is only used for ALPHA blockchain operations.

```typescript
interface Identity {
  chainPubkey: string;         // 33-byte compressed secp256k1 public key (for L3 chain)
  directAddress?: string;      // L3 DIRECT address (DIRECT://...) - PRIMARY ADDRESS
  l1Address: string;           // L1 address (alpha1...) - for ALPHA blockchain only
  ipnsName?: string;           // IPNS name for token sync
  nametag?: string;            // Registered nametag (@username)
}

// Access identity - use directAddress as primary
console.log(sphere.identity?.directAddress);    // DIRECT://0000be36... (PRIMARY)
console.log(sphere.identity?.nametag);          // alice (human-readable)
console.log(sphere.identity?.l1Address);        // alpha1qw3e... (L1 only)
console.log(sphere.identity?.chainPubkey);      // 02abc123... (33-byte compressed)
```

### Address Change Event

```typescript
// Listen for address switches
sphere.on('identity:changed', (event) => {
  console.log('Switched to address index:', event.data.addressIndex);
  console.log('L1 address:', event.data.l1Address);
  console.log('L3 address:', event.data.directAddress);
  console.log('Chain pubkey:', event.data.chainPubkey);
  console.log('Nametag:', event.data.nametag);
});

// Listen for nametag recovery (when importing wallet)
sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag from Nostr:', event.data.nametag);
});
```

## Payment Requests

Request payments from others with response tracking:

```typescript
// Send payment request
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Payment for order #1234',
});

// Wait for response (with 2 minute timeout)
if (result.success) {
  const response = await sphere.payments.waitForPaymentResponse(result.requestId!, 120000);
  if (response.responseType === 'paid') {
    console.log('Payment received! Transfer:', response.transferId);
  }
}

// Or subscribe to responses
sphere.payments.onPaymentRequestResponse((response) => {
  console.log(`Response: ${response.responseType}`);
});

// Handle incoming payment requests
sphere.payments.onPaymentRequest((request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);

  // Accept and pay
  await sphere.payments.payPaymentRequest(request.id);

  // Or reject
  await sphere.payments.rejectPaymentRequest(request.id);
});
```

## L1 (ALPHA Blockchain) Operations

Access L1 payments through `sphere.payments.l1`:

```typescript
// L1 is enabled by default with lazy Fulcrum connection.
// Connection to Fulcrum is deferred until first L1 operation.
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  // L1 config is optional — defaults are applied automatically:
  // electrumUrl: network-specific (mainnet: fulcrum.alpha.unicity.network)
  // defaultFeeRate: 10 sat/byte
  // enableVesting: true
});

// To explicitly disable L1:
// const { sphere } = await Sphere.init({ ...providers, l1: null });

// Get L1 balance
const balance = await sphere.payments.l1.getBalance();
console.log('L1 Balance:', balance.total);
console.log('Vested:', balance.vested);
console.log('Unvested:', balance.unvested);

// Get UTXOs
const utxos = await sphere.payments.l1.getUtxos();
console.log('UTXOs:', utxos.length);

// Send L1 transaction
const result = await sphere.payments.l1.send({
  to: 'alpha1qxyz...',
  amount: '100000',  // in satoshis
  feeRate: 5,        // optional, sat/byte
});

if (result.success) {
  console.log('TX Hash:', result.txHash);
}

// Get transaction history
const history = await sphere.payments.l1.getHistory(10);

// Estimate fee
const { fee, feeRate } = await sphere.payments.l1.estimateFee('alpha1...', '50000');
```

## Alternative: Manual Create/Load

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import {
  createLocalStorageProvider,
  createNostrTransportProvider,
  createUnicityAggregatorProvider,
} from '@unicitylabs/sphere-sdk/impl/browser';

const storage = createLocalStorageProvider();
const transport = createNostrTransportProvider();
const oracle = createUnicityAggregatorProvider({ url: '/rpc' });

// Check if wallet exists
if (await Sphere.exists(storage)) {
  // Load existing wallet
  const sphere = await Sphere.load({ storage, transport, oracle });
} else {
  // Create new wallet with mnemonic
  const mnemonic = Sphere.generateMnemonic();
  const sphere = await Sphere.create({
    mnemonic,
    storage,
    transport,
    oracle,
  });
  console.log('Save this mnemonic:', mnemonic);
}
```

## Import from Master Key (Legacy Wallets)

For compatibility with legacy wallet files (.dat, .txt):

```typescript
// Import from master key + chain code (BIP32 mode)
const sphere = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  chainCode: '64-hex-chars-chain-code',
  basePath: "m/84'/1'/0'",  // from wallet.dat descriptor
  derivationMode: 'bip32',
  storage, transport, oracle,
});

// Import from master key only (WIF HMAC mode)
const sphere = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  derivationMode: 'wif_hmac',
  storage, transport, oracle,
});
```

## Wallet Export/Import (JSON)

```typescript
// Export to JSON (for backup)
const json = sphere.exportToJSON();
console.log(JSON.stringify(json));

// Export with encryption
const encryptedJson = sphere.exportToJSON({ password: 'user-password' });

// Export with multiple addresses
const multiJson = sphere.exportToJSON({ addressCount: 5 });

// Import from JSON
const { success, mnemonic, error } = await Sphere.importFromJSON({
  jsonContent: JSON.stringify(json),
  password: 'user-password',  // if encrypted
  storage, transport, oracle,
});

if (success && mnemonic) {
  console.log('Recovered mnemonic:', mnemonic);
}
```

## Wallet Info & Backup

```typescript
// Get wallet info
const info = sphere.getWalletInfo();
console.log('Source:', info.source);        // 'mnemonic' | 'file'
console.log('Has mnemonic:', info.hasMnemonic);
console.log('Derivation mode:', info.derivationMode);
console.log('Base path:', info.basePath);

// Get mnemonic for backup (if available)
const mnemonic = sphere.getMnemonic();
if (mnemonic) {
  console.log('Backup this:', mnemonic);
}
```

## Import from Legacy Files (.dat, .txt)

```typescript
// Import from wallet.dat file
const fileBuffer = await file.arrayBuffer();
const result = await Sphere.importFromLegacyFile({
  fileContent: new Uint8Array(fileBuffer),
  fileName: 'wallet.dat',
  password: 'wallet-password',  // if encrypted
  onDecryptProgress: (i, total) => console.log(`Decrypting: ${i}/${total}`),
  storage, transport, oracle,
});

if (result.needsPassword) {
  // Re-prompt user for password
}

if (result.success) {
  const sphere = result.sphere;
  console.log('Imported wallet:', sphere.identity?.l1Address);
}

// Import from text backup file
const textContent = await file.text();
const result = await Sphere.importFromLegacyFile({
  fileContent: textContent,
  fileName: 'backup.txt',
  storage, transport, oracle,
});

// Detect file type and encryption status
const fileType = Sphere.detectLegacyFileType(fileName, content);
// Returns: 'dat' | 'txt' | 'json' | 'mnemonic' | 'unknown'

const isEncrypted = Sphere.isLegacyFileEncrypted(fileName, content);
```

## Core Utilities

The SDK exports commonly needed utility functions:

```typescript
import {
  // Crypto
  bytesToHex, hexToBytes,
  generateMnemonic, validateMnemonic,
  sha256, ripemd160, hash160,
  getPublicKey, createKeyPair,
  deriveAddressInfo,

  // Currency conversion
  toSmallestUnit,    // "1.5" → 1500000000000000000n
  toHumanReadable,   // 1500000000000000000n → "1.5"
  formatAmount,      // Format with decimals and symbol

  // Address encoding
  encodeBech32, decodeBech32,
  createAddress, isValidBech32,

  // Base58 (Bitcoin-style)
  base58Encode, base58Decode,
  isValidPrivateKey,

  // General utilities
  sleep, randomHex, randomUUID,
  findPattern, extractFromText,
} from '@unicitylabs/sphere-sdk';
```

## TXF Serialization

Token eXchange Format for storage and transfer:

```typescript
import {
  tokenToTxf,           // Token → TXF format
  txfToToken,           // TXF → Token
  buildTxfStorageData,  // Build IPFS storage data
  parseTxfStorageData,  // Parse storage data
  getCurrentStateHash,  // Get token's current state hash
  hasUncommittedTransactions,
} from '@unicitylabs/sphere-sdk';

// Convert token to TXF
const txf = tokenToTxf(token);
console.log(txf.genesis.data.tokenId);

// Build storage data for IPFS
const storageData = await buildTxfStorageData(tokens, {
  version: 1,
  address: 'alpha1...',
  ipnsName: 'k51...',
});
```

## Token Validation

Validate tokens against the aggregator:

```typescript
import { createTokenValidator } from '@unicitylabs/sphere-sdk';

const validator = createTokenValidator({
  aggregatorClient: oracleProvider,
  trustBase: trustBaseData,
  skipVerification: false,
});

// Validate all tokens
const { validTokens, issues } = await validator.validateAllTokens(tokens);

// Check if token state is spent
const isSpent = await validator.isTokenStateSpent(tokenId, stateHash, publicKey);

// Check spent tokens in batch
const { spentTokens, errors } = await validator.checkSpentTokens(tokens, publicKey);
```

## Architecture

**Single Identity Model**: L1 and L3 share the same secp256k1 key pair. One mnemonic = one wallet for both layers.

```
mnemonic → master key → BIP32 derivation → identity
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        │              shared keys                  │
                        │  privateKey:   "abc..."  (hex secp256k1)  │
                        │  chainPubkey:  "02def..." (33-byte comp.) │
                        │  l1Address:    "alpha1..." (bech32)       │
                        │  directAddress: "DIRECT://..." (L3)       │
                        └─────────────────────┬─────────────────────┘
                                              ↓
              ┌───────────────────────────────┼───────────────────────────────┐
              ↓                               ↓                               ↓
         L1 (ALPHA)                     L3 (Unicity)                      Nostr
     sphere.payments.l1              sphere.payments               sphere.communications
      UTXOs, blockchain              Tokens, aggregator              P2P messaging
```

```
Sphere (main entry point)
├── identity    - Wallet identity (address, publicKey, nametag)
├── payments    - L3 token operations
│   └── l1      - L1 ALPHA transactions (via sphere.payments.l1)
└── communications - Direct messages & broadcasts

Providers (injectable dependencies)
├── StorageProvider      - Key-value persistence
├── TransportProvider    - P2P messaging (Nostr)
├── OracleProvider       - State validation (Aggregator)
└── TokenStorageProvider - Token backup (IPFS)

Implementation (platform-specific)
├── impl/shared/         - Common interfaces & resolvers
│   ├── config.ts        - Base configuration types
│   └── resolvers.ts     - Extend/override pattern utilities
├── impl/browser/        - Browser implementations
│   ├── LocalStorageProvider
│   ├── IndexedDBTokenStorageProvider
│   └── createBrowserProviders()
└── impl/nodejs/         - Node.js implementations
    ├── FileStorageProvider
    ├── FileTokenStorageProvider
    └── createNodeProviders()

Core Utilities
├── crypto     - Key derivation, hashing, signatures
├── currency   - Amount formatting and conversion
├── bech32     - Address encoding (BIP-173)
└── utils      - Base58, patterns, sleep, random
```

## Shared Configuration Pattern

Both browser and Node.js implementations share common configuration interfaces and resolution logic:

```typescript
// Base interfaces (impl/shared/config.ts)
import type {
  BaseTransportConfig,  // Common transport options
  BaseOracleConfig,     // Common oracle options
  L1Config,             // L1 configuration (same for all platforms)
  BaseProviders,        // Common result structure
} from '@unicitylabs/sphere-sdk/impl/shared';

// Resolver utilities (impl/shared/resolvers.ts)
import {
  getNetworkConfig,        // Get mainnet/testnet/dev config
  resolveTransportConfig,  // Apply extend/override pattern for relays
  resolveOracleConfig,     // Resolve oracle URL with fallback
  resolveL1Config,         // Resolve L1 with network defaults
  resolveArrayConfig,      // Generic array merge helper
} from '@unicitylabs/sphere-sdk/impl/shared';
```

### Extend/Override Pattern

The configuration resolution follows a consistent pattern across platforms:

```typescript
// Priority for arrays: replace > extend > defaults
const result = resolveArrayConfig(
  networkDefaults,    // ['a', 'b']
  config.relays,      // If set, replaces entirely
  config.additionalRelays  // If set, extends defaults
);

// Examples:
// No config → ['a', 'b'] (defaults)
// { relays: ['x'] } → ['x'] (replace)
// { additionalRelays: ['c'] } → ['a', 'b', 'c'] (extend)
```

### Platform-Specific Extensions

Each platform extends the base interfaces with platform-specific options:

```typescript
// Browser: adds reconnectDelay, maxReconnectAttempts
type TransportConfig = BaseTransportConfig & BrowserTransportExtensions;

// Node.js: adds trustBasePath for file-based trust base
type NodeOracleConfig = BaseOracleConfig & NodeOracleExtensions;
```

## Documentation

- [Integration Guide](./docs/INTEGRATION.md)
- [API Reference](./docs/API.md)

## Browser Providers

The SDK includes browser-ready provider implementations:

| Provider | Description |
|----------|-------------|
| `LocalStorageProvider` | Browser localStorage with SSR fallback |
| `NostrTransportProvider` | Nostr relay messaging with NIP-04 |
| `UnicityAggregatorProvider` | Unicity aggregator for state proofs |
| `IpfsStorageProvider` | Helia-based IPFS with HTTP fallback |

## Node.js Providers

For CLI and server applications:

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// Quick start with testnet
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens',
});

const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});

// Full configuration
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens',
  transport: {
    additionalRelays: ['wss://my-relay.com'],
    timeout: 10000,
    debug: true,
  },
  oracle: {
    apiKey: 'my-api-key',
    trustBasePath: './trustbase.json',  // Node.js specific
  },
  l1: {
    enableVesting: true,
  },
});
```

### Manual Provider Creation

```typescript
import {
  FileStorageProvider,
  FileTokenStorageProvider,
  createNostrTransportProvider,
  createNodeTrustBaseLoader,
} from '@unicitylabs/sphere-sdk/impl/nodejs';

// File-based wallet storage
const storage = new FileStorageProvider('./wallet-data');

// File-based token storage (TXF format)
const tokenStorage = new FileTokenStorageProvider('./tokens');

// Nostr with Node.js WebSocket
const transport = createNostrTransportProvider({
  relays: ['wss://relay.unicity.network'],
});

// Load trust base from local file
const trustBaseLoader = createNodeTrustBaseLoader('./trustbase-testnet.json');
const trustBase = await trustBaseLoader.load();
```

## Custom Providers Configuration

The SDK uses an **extend/override pattern** for flexible configuration:

| Option | Behavior |
|--------|----------|
| `relays` | **Replaces** default relays entirely |
| `additionalRelays` | **Adds** to default relays |
| `gateways` | **Replaces** default IPFS gateways |
| `additionalGateways` | **Adds** to default gateways |
| `url`, `electrumUrl` | **Replaces** default URL (uses network default if not set) |

```typescript
// Simple: use network preset
const providers = createBrowserProviders({ network: 'testnet' });

// Add extra relays to testnet defaults
const providers = createBrowserProviders({
  network: 'testnet',
  transport: {
    additionalRelays: ['wss://my-relay.com', 'wss://backup-relay.com'],
    // Result: testnet relay + my-relay + backup-relay
  },
});

// Replace relays entirely (ignores network defaults)
const providers = createBrowserProviders({
  network: 'testnet',
  transport: {
    relays: ['wss://only-this-relay.com'],
    // Result: only-this-relay (testnet default ignored)
  },
});

// Override aggregator, keep other testnet defaults
const providers = createBrowserProviders({
  network: 'testnet',
  oracle: {
    url: 'https://my-aggregator.com',  // replaces testnet aggregator
    apiKey: 'my-api-key',
  },
});

// Full custom configuration
const providers = createBrowserProviders({
  network: 'testnet',
  storage: {
    prefix: 'myapp_',
  },
  transport: {
    additionalRelays: ['wss://extra-relay.com'],
    timeout: 15000,
    autoReconnect: true,
    debug: true,
  },
  oracle: {
    url: 'https://custom-aggregator.com',
    apiKey: 'secret',
    timeout: 60000,
  },
  l1: {
    electrumUrl: 'wss://custom-fulcrum.com:50004',
    defaultFeeRate: 5,
    enableVesting: true,
  },
  tokenSync: {
    ipfs: {
      enabled: true,
      additionalGateways: ['https://my-ipfs-gateway.com'],
    },
  },
});

```

## Token Sync Backends

The SDK supports multiple token sync backends that can be enabled independently:

| Backend | Status | Description |
|---------|--------|-------------|
| `ipfs` | ✅ Ready | Decentralized IPFS/IPNS with Helia browser DHT |
| `mongodb` | 🚧 Planned | MongoDB for centralized token storage |
| `file` | 🚧 Planned | Local file system (Node.js) |
| `cloud` | 🚧 Planned | Cloud storage (AWS S3, GCP, Azure) |

```typescript
// Enable IPFS sync with custom gateways
const providers = createBrowserProviders({
  network: 'testnet',
  tokenSync: {
    ipfs: {
      enabled: true,
      additionalGateways: ['https://my-gateway.com'],
      useDht: true,  // Enable browser DHT (Helia)
    },
  },
});
```

## Custom Token Storage Provider

You can implement your own `TokenStorageProvider` for custom storage backends:

```typescript
import type { TokenStorageProvider, TxfStorageDataBase, SaveResult, LoadResult, SyncResult } from '@unicitylabs/sphere-sdk/storage';
import type { FullIdentity, ProviderStatus } from '@unicitylabs/sphere-sdk/types';

class MyCustomStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'my-storage';
  readonly name = 'My Custom Storage';
  readonly type = 'remote' as const;

  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
  }

  async initialize(): Promise<boolean> {
    // Connect to your storage backend
    this.status = 'connected';
    return true;
  }

  async shutdown(): Promise<void> {
    this.status = 'disconnected';
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async load(): Promise<LoadResult<TxfStorageDataBase>> {
    // Load tokens from your storage
    return {
      success: true,
      data: { _meta: { version: 1, address: this.identity?.l1Address ?? '', formatVersion: '2.0', updatedAt: Date.now() } },
      source: 'remote',
      timestamp: Date.now(),
    };
  }

  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    // Save tokens to your storage
    return { success: true, timestamp: Date.now() };
  }

  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    // Merge local and remote data
    await this.save(localData);
    return { success: true, merged: localData, added: 0, removed: 0, conflicts: 0 };
  }
}

// Use your custom provider
const myProvider = new MyCustomStorageProvider();

const { sphere } = await Sphere.init({
  ...providers,
  tokenStorage: myProvider,
  autoGenerate: true,
});
```

## Dynamic Provider Management (Runtime)

After `Sphere.init()` is called, you can add/remove token storage providers dynamically:

```typescript
import { createIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';

// Add a new provider at runtime (e.g., user enables IPFS sync in settings)
const ipfsProvider = createIpfsStorageProvider({
  gateways: ['https://ipfs.io'],
  useDht: true,
});

await sphere.addTokenStorageProvider(ipfsProvider);

// Provider is now active and will be used in sync operations

// Check if provider exists
if (sphere.hasTokenStorageProvider('ipfs-token-storage')) {
  console.log('IPFS sync is enabled');
}

// Get all active providers
const providers = sphere.getTokenStorageProviders();
console.log('Active providers:', Array.from(providers.keys()));

// Remove a provider (e.g., user disables IPFS sync)
await sphere.removeTokenStorageProvider('ipfs-token-storage');

// Listen for per-provider sync events
sphere.on('sync:provider', (event) => {
  console.log(`Provider ${event.providerId}: ${event.success ? 'synced' : 'failed'}`);
  if (event.success) {
    console.log(`  Added: ${event.added}, Removed: ${event.removed}`);
  } else {
    console.log(`  Error: ${event.error}`);
  }
});

// Trigger sync (syncs with all active providers)
await sphere.payments.sync();
```

## Dynamic Relay Management

Nostr relays can be added or removed at runtime through the transport provider:

```typescript
const transport = sphere.getTransport();

// Get current relays
const configuredRelays = transport.getRelays();       // All configured
const connectedRelays = transport.getConnectedRelays(); // Currently connected

// Add a new relay (connects immediately if provider is connected)
await transport.addRelay('wss://new-relay.com');

// Remove a relay (disconnects if connected)
await transport.removeRelay('wss://old-relay.com');

// Check relay status
transport.hasRelay('wss://relay.com');         // Is configured?
transport.isRelayConnected('wss://relay.com'); // Is connected?
```

### Relay Events

```typescript
// Listen for relay changes
sphere.on('transport:relay_added', (event) => {
  console.log(`Relay added: ${event.data.relay}`);
  console.log(`Connected: ${event.data.connected}`);
});

sphere.on('transport:relay_removed', (event) => {
  console.log(`Relay removed: ${event.data.relay}`);
});

sphere.on('transport:error', (event) => {
  console.log(`Transport error: ${event.data.error}`);
});
```

### UI Integration Example

```typescript
// User adds relay via settings UI
async function handleAddRelay(relayUrl: string) {
  const transport = sphere.getTransport();

  if (transport.hasRelay(relayUrl)) {
    showError('Relay already configured');
    return;
  }

  const success = await transport.addRelay(relayUrl);
  if (success) {
    showSuccess(`Added ${relayUrl}`);
  } else {
    showWarning(`Added but failed to connect to ${relayUrl}`);
  }
}

// User removes relay via settings UI
async function handleRemoveRelay(relayUrl: string) {
  const transport = sphere.getTransport();
  await transport.removeRelay(relayUrl);
  showSuccess(`Removed ${relayUrl}`);
}

// Display relay status in UI
function getRelayStatuses() {
  const transport = sphere.getTransport();
  return transport.getRelays().map(relay => ({
    url: relay,
    connected: transport.isRelayConnected(relay),
  }));
}
```

## Nametags

Nametags provide human-readable addresses (e.g., `@alice`) for receiving payments. Valid formats: lowercase alphanumeric with `_` or `-` (3–20 chars), or E.164 phone numbers (e.g., `+14155552671`). Input is normalized to lowercase automatically.

> **Important:** Nametags are required to use the testnet faucet. Register a nametag before requesting test tokens.

> **Note:** Nametag minting requires an aggregator API key for proof verification. Configure it via the `oracle.apiKey` option when creating providers. Contact Unicity to obtain an API key.

### Registering a Nametag

```typescript
// During wallet creation
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  nametag: 'alice',  // Will register @alice
});

// Or after creation
await sphere.registerNametag('alice');

// Mint on-chain nametag token (required for receiving via PROXY addresses)
const result = await sphere.mintNametag('alice');
if (result.success) {
  console.log('Nametag minted:', result.nametagData?.name);
}
```

### Common Pitfall: Nametag Already Taken

If you see this error:
```
Failed to register nametag. It may already be taken.
[NostrTransportProvider] Nametag already taken: myname - owner: f124f93ae6946ffd...
```

This means the nametag is registered to a **different public key**. Common causes:

1. **Storage cleared or not persisting**:
   - `Sphere.exists()` returns `false` because storage is empty/inaccessible
   - SDK creates a new wallet with new keypair
   - Nametag registration fails because old pubkey owns it on Nostr

2. **Different mnemonic provided**:
   ```typescript
   // ❌ WRONG: Random mnemonic each time
   const mnemonic = Sphere.generateMnemonic();
   const { sphere } = await Sphere.init({
     mnemonic,
     nametag: 'myservice',  // Fails after first run
   });
   ```

**Note:** `autoGenerate: true` does NOT generate a new mnemonic on every restart. It only generates one if `Sphere.exists()` returns `false` (wallet not found in storage).

### Solution: Persistent Storage or Fixed Mnemonic

**Option 1: Persistent file storage** (recommended for backend):

```typescript
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data');  // Persists to disk

const { sphere } = await Sphere.init({
  storage,
  autoGenerate: true,  // OK: mnemonic saved to disk, reused on restart
  nametag: 'myservice',
});
```

**Option 2: Fixed mnemonic from environment**:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: process.env.WALLET_MNEMONIC,  // Same mnemonic every time
  nametag: 'myservice',
});
```

### Debugging Storage Issues

If nametag fails unexpectedly, check if wallet exists:

```typescript
const exists = await Sphere.exists(storage);
console.log('Wallet exists:', exists);  // Should be true after first run

// If false - storage is not persisting properly
```

### Nametag Recovery on Import

When importing a wallet (from mnemonic or file), the SDK automatically attempts to recover the nametag from Nostr:

```typescript
// Import wallet - nametag will be recovered automatically if found on Nostr
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  // No nametag specified - will try to recover from Nostr
});

// Listen for recovery event
sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag:', event.data.nametag);  // e.g., 'alice'
});

// After init, check if nametag was recovered
console.log(sphere.identity?.nametag);  // 'alice' (if found on Nostr)
```

### Multi-Address Nametags

Each derived address can have its own independent nametag:

```typescript
// Address 0: @alice
await sphere.registerNametag('alice');

// Switch to address 1 and register different nametag
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');

// Now:
// - Address 0 → @alice
// - Address 1 → @bob

// Get nametag for specific address
const aliceTag = sphere.getNametagForAddress(0);  // 'alice'
const bobTag = sphere.getNametagForAddress(1);    // 'bob'
```

---

## Known Limitations / TODO

### Wallet Encryption

Currently, wallet mnemonics are encrypted using a default key (`DEFAULT_ENCRYPTION_KEY` in constants.ts). This provides basic protection but is not secure for production use.

**Future implementation needed:**
- Add user password parameter to `Sphere.create()`, `Sphere.load()`, and `Sphere.init()`
- Derive encryption key from user password using PBKDF2/Argon2
- Migration strategy for existing wallets:
  1. Try decrypting with user-provided password first
  2. If decryption fails, fallback to `DEFAULT_ENCRYPTION_KEY`
  3. If fallback succeeds, re-encrypt with new user password
  4. This ensures backwards compatibility with wallets created before password support

## License

MIT
