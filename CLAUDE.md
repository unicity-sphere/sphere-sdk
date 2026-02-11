# CLAUDE.md - Sphere SDK Project Context

This file provides context for Claude Code when working with the Sphere SDK project.

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

### Minimal Example

```typescript
// Browser
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

const providers = createBrowserProviders({ network: 'testnet' });
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});

// Node.js
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet',
  tokensDir: './tokens',
});
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
```

### Common Operations

```typescript
// Check total portfolio value in USD (requires PriceProvider)
const balance = await sphere.payments.getBalance(); // number | null

// Get assets with price data
const assets = await sphere.payments.getAssets();
// [{ coinId, symbol, totalAmount, priceUsd, fiatValueUsd, ... }]

// Send tokens
await sphere.payments.send({
  recipient: '@alice',  // or DIRECT://... address
  amount: '1000000',
  coinId: 'UCT',
});

// Register nametag (mints token on-chain!)
await sphere.registerNametag('myname');

// Multi-address management
await sphere.switchToAddress(1);
const addresses = sphere.getActiveAddresses(); // non-hidden tracked addresses
await sphere.setAddressHidden(1, true);        // hide from UI

// Listen for incoming transfers
sphere.on('transfer:incoming', (event) => {
  console.log('Received:', event.data.amount);
});

// Cleanup
await sphere.destroy();
```

### What's Included by Default

| Component | Browser | Node.js |
|-----------|---------|---------|
| Storage | localStorage + IndexedDB | File-based JSON |
| Transport (Nostr) | Native WebSocket | `ws` package (install separately) |
| Oracle (Aggregator) | Included with API key | Included with API key |
| Price (CoinGecko) | Optional (`price` config) | Optional (`price` config) |
| IPFS sync | Optional (`helia`) | Not available |

See [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) and [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) for detailed guides.

---

## Project Overview

**Sphere SDK** (`@unicitylabs/sphere-sdk`) is a modular TypeScript SDK for Unicity wallet operations supporting:
- **L1 (ALPHA blockchain)** - UTXO-based blockchain transactions via Electrum
- **L3 (Unicity state transition network)** - Token transfers with state proofs via Aggregator

**Version:** 0.2.2
**License:** MIT
**Target:** Node.js >= 18.0.0, Browser (ESM/CJS)

## Directory Structure

```
sphere-sdk/
├── core/                    # Core wallet and crypto utilities
│   ├── Sphere.ts           # Main wallet class (72KB) - entry point
│   ├── crypto.ts           # BIP39/BIP32, secp256k1, hashing
│   ├── bech32.ts           # Address encoding/decoding
│   ├── encryption.ts       # AES encryption utilities
│   ├── currency.ts         # Amount formatting/conversion
│   └── utils.ts            # Base58, patterns, UUID, helpers
│
├── types/                   # TypeScript type definitions
│   ├── index.ts            # Main types (Identity, Token, Transfer, etc.)
│   └── txf.ts              # Token eXchange Format types
│
├── modules/                 # Feature modules
│   ├── payments/
│   │   ├── PaymentsModule.ts      # L3 token operations (88KB)
│   │   ├── L1PaymentsModule.ts    # ALPHA blockchain operations
│   │   ├── TokenSplitCalculator.ts
│   │   ├── TokenSplitExecutor.ts
│   │   └── NametagMinter.ts       # On-chain nametag minting
│   └── communications/
│       └── CommunicationsModule.ts # DMs and broadcasts
│
├── transport/               # P2P messaging abstraction
│   ├── transport-provider.ts      # TransportProvider interface
│   └── NostrTransportProvider.ts  # Nostr implementation
│
├── storage/                 # Data persistence abstraction
│   └── token-storage-provider.ts  # TokenStorageProvider interface
│
├── oracle/                  # Token validation (Aggregator)
│   └── oracle-provider.ts         # OracleProvider interface
│
├── price/                   # Token market prices
│   ├── price-provider.ts          # PriceProvider interface
│   ├── CoinGeckoPriceProvider.ts  # CoinGecko implementation
│   └── index.ts                   # Barrel exports + factory
│
├── impl/                    # Platform-specific implementations
│   ├── browser/            # LocalStorage, IndexedDB, IPFS
│   ├── nodejs/             # FileStorage, FileTokenStorage
│   └── shared/             # Common config and resolvers
│
├── l1/                      # ALPHA blockchain utilities
│   ├── address.ts          # Address generation
│   ├── tx.ts               # Transaction construction
│   ├── vesting.ts          # Vesting classification
│   └── ...
│
├── validation/              # Token validation
│   └── TokenValidator.ts
│
├── serialization/           # Legacy format parsing
│   ├── txf-serializer.ts   # TXF format
│   ├── wallet-text.ts      # .txt backup format
│   └── wallet-dat.ts       # SQLite .dat format
│
├── tests/                   # Test suite (Vitest)
│   ├── unit/               # Unit tests
│   └── integration/        # Integration tests
│
├── docs/                    # Documentation
│   ├── API.md              # API reference
│   └── INTEGRATION.md      # Integration guide
│
├── index.ts                 # Main SDK entry point
├── constants.ts             # Global constants and defaults
└── package.json
```

## Architecture

### Single Identity Model
L1 and L3 share the same secp256k1 key pair:

```
mnemonic → master key → BIP32 derivation → identity
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        │  chainPubkey:   33-byte compressed pubkey │
                        │  l1Address:     alpha1... (bech32)        │
                        │  directAddress: DIRECT://... (L3)         │
                        │  transportPubkey: derived for Nostr       │
                        └─────────────────────────────────────────────┘
```

### Key Types

```typescript
interface Identity {
  chainPubkey: string;      // 33-byte compressed secp256k1 (for L3)
  l1Address: string;        // L1 bech32 address (alpha1...)
  directAddress?: string;   // L3 DIRECT address
  ipnsName?: string;        // IPFS/IPNS identifier
  nametag?: string;         // Human-readable alias (@username)
}

interface FullIdentity extends Identity {
  privateKey: string;       // secp256k1 private key (hex)
}

// Tracked address (returned by getActiveAddresses(), etc.)
interface TrackedAddress {
  index: number;            // HD derivation index
  addressId: string;        // "DIRECT_abc123_xyz789"
  l1Address: string;        // alpha1...
  directAddress: string;    // DIRECT://...
  chainPubkey: string;      // 33-byte compressed pubkey
  nametag?: string;         // primary nametag (without @)
  hidden: boolean;          // manual hide flag for UI
  createdAt: number;        // ms timestamp
  updatedAt: number;        // ms timestamp
}
```

### Provider Pattern
Abstract interfaces for platform independence:

| Provider | Interface | Implementations |
|----------|-----------|-----------------|
| Storage | `StorageProvider` | LocalStorageProvider, FileStorageProvider |
| TokenStorage | `TokenStorageProvider` | IndexedDBTokenStorageProvider, FileTokenStorageProvider, IpfsStorageProvider |
| Transport | `TransportProvider` | NostrTransportProvider |
| Oracle | `OracleProvider` | UnicityAggregatorProvider |
| Price | `PriceProvider` | CoinGeckoPriceProvider |

### Network Configuration

| Network | Aggregator | Nostr Relay | Electrum |
|---------|------------|-------------|----------|
| mainnet | aggregator.unicity.network | relay.unicity.network | fulcrum.alpha.unicity.network |
| testnet | goggregator-test.unicity.network | nostr-relay.testnet.unicity.network | fulcrum.alpha.testnet.unicity.network |
| dev | dev-aggregator.dyndns.org | nostr-relay.testnet.unicity.network | fulcrum.alpha.testnet.unicity.network |

## Common Commands

```bash
# Build (ESM + CJS via tsup)
npm run build

# Test (watch mode)
npm test

# Test (single run)
npm run test:run

# Lint
npm run lint

# Type check
npm run type-check
```

## Key Concepts

### Nametags
- Human-readable aliases (e.g., `@alice`) for receiving payments
- Registered via Nostr relay events (NIP-04 encrypted)
- Can be recovered from Nostr when importing wallet
- Each derived HD address can have its own nametag

**When nametag token is minted on-chain:**
- `Sphere.init({ nametag: 'alice' })` → mints via `registerNametag()`
- `sphere.registerNametag('alice')` → mints token
- CLI: `npm run cli -- init --nametag alice` → mints token
- CLI: `npm run cli -- nametag alice` → mints token

**When NO minting happens:**
- `Sphere.init({ autoGenerate: true })` without nametag → only creates wallet
- CLI: `npm run cli -- init` → only creates wallet

**Requirements for minting:**
- Oracle (Aggregator) provider - included by default with `createBrowserProviders()` / `createNodeProviders()`
- API key - embedded by default for testnet/mainnet

### L3 Transfers
- Use `DirectAddress` (not PROXY) for transfers
- Finalization required to generate local state for tracking
- Recipient resolved via unified `transport.resolve(identifier)` → returns `PeerInfo`

### Peer Resolution
- `sphere.resolve(identifier)` / `transport.resolve(identifier)` — unified lookup
- Accepts: `@nametag`, `DIRECT://...`, `PROXY://...`, `alpha1...`, chain pubkey (`02`/`03` prefix), transport pubkey (64-hex)
- Returns `PeerInfo` with all address formats, or `null` if not found
- Identity binding event published on `init()`/`load()` — wallet discoverable without nametag

### Transport vs Chain Pubkeys
- `chainPubkey`: 33-byte compressed secp256k1 for L3 chain operations
- `transportPubkey`: Derived key for transport messaging (HKDF from private key)
- Identity binding events include both for cross-resolution

### Token Storage (TXF Format)
```typescript
TxfStorageDataBase {
  _meta: TxfMeta           // Metadata (version, address, timestamp)
  _tombstones?: []         // Deleted token markers
  _outbox?: []             // Pending outgoing transfers
  _sent?: []               // Completed transfers
  [tokenId]: TxfToken      // Token data
}
```

## Recent Changes

### v0.2.2 (current)

1. **L1 payments enabled by default**: `PaymentsModule` creates `L1PaymentsModule` automatically.
   - Set `l1: null` in config to explicitly disable L1
   - Fulcrum WebSocket connection is **lazy** — deferred until first L1 operation
   - `importFromJSON()` and `importFromLegacyFile()` now accept `l1` config option

2. **IndexedDB deadlock fix**: `tokenStorage.clear()` has timeout protection (2s) to prevent
   deadlock on repeated calls. `indexedDB.databases()` also has a 1.5s timeout.

3. **L1 transaction history fix**: Correctly resolves send/receive direction by looking up
   previous transaction outputs instead of comparing txids to addresses.

4. **Payment request fix**: `senderNametag` now correctly populated on incoming payment requests.
   `recipientNametag` semantics clarified (where tokens should be sent, not who should pay).

### Earlier changes

5. **Identity field renaming** (consistent naming):
   - `publicKey` → `chainPubkey`
   - `address` → `l1Address`
   - `predicateAddress` → `directAddress`

6. **Nametag recovery**: Automatic recovery from Nostr on wallet import

7. **DirectAddress for L3**: Using DirectAddress instead of ProxyAddress

8. **Events**:
   - `nametag:recovered` - Emitted when nametag found on Nostr during import
   - `identity:changed` - Updated with new field names
   - `address:activated` - Emitted when new address first tracked
   - `address:hidden` / `address:unhidden` - Address visibility changes

9. **PriceProvider** (optional): CoinGecko integration for token fiat prices
   - `getBalance()` returns total USD value (`number | null`)
   - `getAssets()` returns assets enriched with `priceUsd`, `fiatValueUsd`, `change24h`
   - `baseUrl` config for CORS proxy in browser environments
   - Negative cache: tokens not found on CoinGecko are cached to prevent repeated requests
   - `setPriceProvider()` for runtime provider configuration

## Testing

**Framework:** Vitest
**Total tests:** 882 (34 test files)

Key test files:
- `tests/unit/core/Sphere.nametag-sync.test.ts` - Nametag sync/recovery
- `tests/unit/transport/NostrTransportProvider.test.ts` - Transport layer
- `tests/unit/modules/PaymentsModule.test.ts` - Payment operations
- `tests/unit/modules/NametagMinter.test.ts` - Nametag minting
- `tests/unit/price/CoinGeckoPriceProvider.test.ts` - Price provider
- `tests/unit/l1/*.test.ts` - L1 blockchain utilities
- `tests/unit/l1/L1PaymentsHistory.test.ts` - L1 transaction history direction/amounts
- `tests/integration/tracked-addresses.test.ts` - Tracked addresses registry

## Dependencies

**Core:**
- `@unicitylabs/state-transition-sdk` - L3 token/state operations
- `@unicitylabs/nostr-js-sdk` - Nostr protocol
- `@noble/hashes`, `@noble/curves` - Cryptography
- `bip39` - Mnemonic generation
- `elliptic` - secp256k1 operations

**Optional (IPFS):**
- `helia` - IPFS node for browser
- `@helia/json`, `@helia/ipns` - IPFS extensions

## Wallet Lifecycle

```typescript
// 1. Create new wallet
const { sphere, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  nametag: 'alice',
});

// 2. Load existing wallet
const { sphere } = await Sphere.init({ ...providers });

// 3. Import from mnemonic
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'twelve words...',
});

// 4. Operations
const balance = await sphere.payments.getBalance(); // total USD value or null
const assets = await sphere.payments.getAssets();    // assets with price data
await sphere.payments.send({ recipient: '@bob', amount: '1000000', coinId: 'UCT' });

// 5. Cleanup
await sphere.destroy();
```

## File Size Reference

Largest files (for context):
- `modules/payments/PaymentsModule.ts` - 88KB (main payment logic)
- `core/Sphere.ts` - 72KB (wallet lifecycle)
- `transport/NostrTransportProvider.ts` - ~15KB (Nostr messaging)

## Code Style

- TypeScript strict mode
- ESLint with TypeScript rules
- ESM modules (with CJS build output)
- Prefer `interface` over `type` for objects
- Use `readonly` for immutable properties
- Async/await over raw promises
