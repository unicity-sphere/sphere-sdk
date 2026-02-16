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

### Complete L3 Wallet Integration Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
// For Node.js: import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// 1. Create providers (all services configured automatically by network)
const providers = createBrowserProviders({ network: 'testnet' });
// Node.js: createNodeProviders({ network: 'testnet', dataDir: './wallet', tokensDir: './tokens' })

// 2. Init wallet (creates new OR loads existing — single entry point)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,   // Generate mnemonic if no wallet exists
  nametag: 'alice',     // Optional: register @alice for receiving payments
  password: 'secret',   // Optional: encrypt mnemonic (plaintext if omitted)
});

if (created && generatedMnemonic) {
  // First run — prompt user to back up mnemonic
  console.log('SAVE THIS:', generatedMnemonic);
}

// 3. Identity is ready
const identity = sphere.identity!;
console.log('L3 address:', identity.directAddress);  // DIRECT://... (primary)
console.log('L1 address:', identity.l1Address);      // alpha1...
console.log('Nametag:', identity.nametag);            // alice

// 4. Check tokens and balance
const assets = await sphere.payments.getAssets();
// [{ coinId, symbol, totalAmount, tokenCount, priceUsd, fiatValueUsd, change24h }]

const balances = sphere.payments.getBalance();        // Asset[] with confirmed/unconfirmed breakdown
const totalUsd = await sphere.payments.getFiatBalance(); // number | null (null if no PriceProvider)

const tokens = sphere.payments.getTokens();           // individual Token[]
const uctOnly = sphere.payments.getTokens({ coinId: 'UCT' }); // filter by coin

// 5. Send tokens (L3)
const result = await sphere.payments.send({
  recipient: '@bob',           // @nametag, DIRECT://..., chain pubkey (02...), or alpha1...
  amount: '1000000',           // in smallest unit (string)
  coinId: 'UCT',              // token coin ID
  memo: 'Payment for coffee', // optional
  // transferMode: 'instant',      // default — fast, receiver resolves proofs
  // transferMode: 'conservative', // slower — sender collects all proofs first
});
// result: { id, status, tokens, tokenTransfers, error? }
// status: 'pending' | 'submitted' | 'delivered' | 'completed' | 'failed'

// 6. Receive tokens (explicit one-shot query + optional finalization)
const { transfers } = await sphere.payments.receive();
await sphere.payments.receive({ finalize: true }); // also resolve unconfirmed V5 tokens

// Listen for incoming transfers
sphere.on('transfer:incoming', (transfer) => {
  console.log(`From: ${transfer.senderNametag}, Tokens: ${transfer.tokens.length}`);
});

// 7. L1 operations (enabled by default, lazy Fulcrum connection)
const l1Balance = await sphere.payments.l1!.getBalance();
// { confirmed, unconfirmed, vested, unvested, total } — all strings in satoshis

const l1Result = await sphere.payments.l1!.send({
  to: 'alpha1...', amount: '100000', feeRate: 5,
});

// 8. Sync with remote storage (IPFS etc.)
const syncResult = await sphere.payments.sync(); // { added, removed }

// 9. Transaction history
const history = sphere.payments.getHistory();
// [{ type, amount, coinId, symbol, timestamp, recipientNametag, senderPubkey }]

// 10. Peer resolution (nametag → addresses)
const peer = await sphere.resolve('@bob');
// { chainPubkey, directAddress, l1Address, nametag, transportPubkey }

// 11. Multi-address
await sphere.switchToAddress(1);
await sphere.registerNametag('alice2');
const addresses = sphere.getActiveAddresses(); // TrackedAddress[]

// 12. Payment requests
const reqResult = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000', coinId: 'UCT', message: 'Pay for order #1234',
});
const response = await sphere.payments.waitForPaymentResponse(reqResult.requestId!, 120000);

sphere.payments.onPaymentRequest((req) => {
  // Handle incoming: req.senderNametag, req.amount, req.symbol
  sphere.payments.payPaymentRequest(req.id);  // or rejectPaymentRequest()
});

// 13. Cleanup
await sphere.destroy();
```

### What's Included by Default

| Component | Browser | Node.js |
|-----------|---------|---------|
| Storage | IndexedDB (`IndexedDBStorageProvider`) | File-based JSON (`FileStorageProvider`) |
| Token Storage | IndexedDB per-address | File-based per-address |
| Transport (Nostr) | Native WebSocket | `ws` package (install separately) |
| Oracle (Aggregator) | Included with API key | Included with API key |
| L1 (ALPHA blockchain) | Enabled, lazy Fulcrum connect | Enabled, lazy Fulcrum connect |
| L1 Vesting Cache | IndexedDB (`SphereVestingCacheV5`) | Memory-only (no persistence) |
| Price (CoinGecko) | Optional (`price` config) | Optional (`price` config) |
| Token Registry | Remote fetch + localStorage cache | Remote fetch + file cache |
| IPFS sync | Built-in (HTTP) | Built-in (HTTP) |

### Key API Methods Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `Sphere.init(options)` | `{ sphere, created, generatedMnemonic? }` | Create or load wallet |
| `Sphere.exists(storage)` | `boolean` | Check if wallet exists |
| `Sphere.clear({ storage, tokenStorage? })` | `void` | Delete all wallet data |
| `Sphere.import(options)` | `Sphere` | Import from mnemonic/masterKey |
| `sphere.payments.getAssets(coinId?)` | `Asset[]` | Get assets grouped by coin |
| `sphere.payments.getBalance()` | `number \| null` | Total USD value |
| `sphere.payments.getTokens(filter?)` | `Token[]` | Get individual tokens |
| `sphere.payments.send(request)` | `TransferResult` | Send L3 tokens |
| `sphere.payments.sync()` | `{ added, removed }` | Sync with remote storage |
| `sphere.payments.validate()` | `{ valid, invalid }` | Validate against aggregator |
| `sphere.payments.getHistory()` | `TransactionHistoryEntry[]` | Transaction history |
| `sphere.payments.l1.getBalance()` | `L1Balance` | L1 balance (strings in sats) |
| `sphere.payments.l1.send(request)` | `L1SendResult` | Send L1 transaction |
| `sphere.payments.l1.getHistory(limit?)` | `L1Transaction[]` | L1 tx history |
| `sphere.resolve(identifier)` | `PeerInfo \| null` | Resolve @nametag/address/pubkey |
| `sphere.registerNametag(name)` | `void` | Register nametag (mints on-chain) |
| `sphere.switchToAddress(index)` | `void` | Switch HD address |
| `sphere.getActiveAddresses()` | `TrackedAddress[]` | Non-hidden tracked addresses |
| `sphere.on(event, handler)` | `() => void` (unsubscribe) | Subscribe to events |

### Key Events

| Event | Payload | When |
|-------|---------|------|
| `transfer:incoming` | `{ senderPubkey, senderNametag?, tokens, receivedAt }` | Received tokens via Nostr |
| `transfer:confirmed` | `TransferResult` | Outgoing transfer confirmed |
| `transfer:failed` | `TransferResult` | Outgoing transfer failed |
| `identity:changed` | `{ l1Address, directAddress, chainPubkey, nametag, addressIndex }` | Address switch |
| `nametag:registered` | `{ nametag, addressIndex }` | Nametag registered |
| `nametag:recovered` | `{ nametag }` | Nametag recovered from Nostr on import |
| `address:activated` | `{ address: TrackedAddress }` | New address tracked |
| `sync:provider` | `{ providerId, success, added, removed }` | Per-provider sync result |
| `payment_request:incoming` | `IncomingPaymentRequest` | Received payment request |

See [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) and [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) for detailed guides.

---

## Project Overview

**Sphere SDK** (`@unicitylabs/sphere-sdk`) is a modular TypeScript SDK for Unicity wallet operations supporting:
- **L1 (ALPHA blockchain)** - UTXO-based blockchain transactions via Electrum
- **L3 (Unicity state transition network)** - Token transfers with state proofs via Aggregator

**Version:** 0.3.3
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
│   ├── groupchat/
│   │   ├── GroupChatModule.ts     # NIP-29 group chat (relay-based)
│   │   ├── types.ts               # GroupData, GroupMessageData, etc.
│   │   └── index.ts               # Barrel exports + factory
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
│   ├── browser/            # IndexedDB storage (kv + tokens), browser IPFS factory
│   ├── nodejs/             # FileStorage, FileTokenStorage, Node.js IPFS factory
│   └── shared/             # Common config, resolvers, and IPFS provider
│       └── ipfs/           # Cross-platform IPFS/IPNS storage (HTTP-based)
│
├── l1/                      # ALPHA blockchain utilities
│   ├── address.ts          # Address generation
│   ├── tx.ts               # Transaction construction
│   ├── vesting.ts          # Vesting classification
│   └── ...
│
├── registry/                # Token metadata registry
│   └── TokenRegistry.ts    # Remote fetch + cache singleton
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

interface TransferRequest {
  recipient: string;        // @nametag, DIRECT://..., chain pubkey, alpha1...
  amount: string;           // Amount in smallest unit
  coinId: string;           // Token coin ID (e.g., 'UCT')
  memo?: string;            // Optional message
}

interface TransferResult {
  readonly id: string;
  status: 'pending' | 'submitted' | 'delivered' | 'completed' | 'failed';
  readonly tokens: Token[];
  txHash?: string;
  error?: string;
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
| Storage | `StorageProvider` | IndexedDBStorageProvider (browser default), LocalStorageProvider (browser legacy), FileStorageProvider (Node.js) |
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
npm run typecheck
```

## Key Concepts

### L1 Payments (Enabled by Default)
- L1 module (`sphere.payments.l1`) is created automatically
- Fulcrum WebSocket connection is **lazy** — deferred until first L1 operation
- Set `l1: null` in `PaymentsModuleConfig` to explicitly disable
- `importFromJSON()` and `importFromLegacyFile()` accept `l1` config option
- **Vesting cache**: `VestingClassifier` uses IndexedDB (`SphereVestingCacheV5`) in browser for persistent UTXO→coinbase tracing cache. In Node.js, falls back to memory-only cache (re-fetched from network each session)

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

### Token Registry (Remote + Cached)
- `TokenRegistry` is a singleton that provides token metadata (symbol, name, decimals, icons) by coin ID
- **No bundled data** — starts empty, data comes from remote URL + persistent cache
- Configured in two places due to tsup bundle duplication (see below):
  - By `createBrowserProviders()` / `createNodeProviders()` — configures the impl bundle's singleton
  - By `Sphere.init()` / `Sphere.load()` / `Sphere.create()` — configures the main bundle's singleton
- **Data flow:** on `configure()` → `performInitialLoad()`: try cache first (if fresh) → fall back to remote fetch (if `autoRefresh` is true) → start periodic auto-refresh
- **Readiness:** `TokenRegistry.waitForReady(timeoutMs?)` — returns a promise that resolves when initial data is loaded (cache or remote). `PaymentsModule.load()` awaits this before parsing tokens to ensure metadata is available.
- **Graceful degradation:** if no cache and no network, lookup methods return fallbacks (truncated coinId for symbol, 0 for decimals)
- Remote URL per network: `constants.ts` → `NETWORKS[network].tokenRegistryUrl`
- Cache keys: `STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE` (JSON) and `TOKEN_REGISTRY_CACHE_TS` (timestamp)
- Race-safe: cache load skipped if remote data is already newer (`lastRefreshAt > cacheTs`)
- Concurrent `refreshFromRemote()` calls are deduplicated (only one fetch at a time)
- `TokenRegistry.destroy()` stops auto-refresh and resets singleton

**tsup bundle duplication note:** tsup compiles multiple entry points (`index.ts`, `impl/browser/index.ts`, etc.) into separate bundles, each inlining its own copy of `TokenRegistry`. The static singleton in `dist/impl/browser/index.js` is a different instance from the one in `dist/index.js`. This is why `Sphere` must call `TokenRegistry.configure()` in its own bundle context, not rely on the factory functions alone.

### Price Provider (CoinGecko)
- `CoinGeckoPriceProvider` fetches token prices from CoinGecko API with multi-layer caching
- **In-memory cache:** prices cached with configurable TTL (`cacheTtlMs`, default 60s)
- **Persistent cache:** when `StorageProvider` is passed, prices are persisted to survive page reloads
  - Cache keys: `STORAGE_KEYS_GLOBAL.PRICE_CACHE` (JSON) and `PRICE_CACHE_TS` (timestamp)
  - On first `getPrices()` call: loads from storage if within TTL, populates in-memory cache
  - After each successful API fetch: saves all cached prices to storage (fire-and-forget)
  - Factory functions (`createBrowserProviders`, `createNodeProviders`) pass storage automatically
- **Unlisted tokens:** tokens not found on CoinGecko (e.g., UCT, USDU) are cached with zero-price `TokenPrice` entries (`priceUsd: 0`), persisted to storage, and not re-requested until TTL expires
- **Request deduplication:** concurrent `getPrices()` calls share an in-flight fetch promise if all requested tokens are covered by the current request
- **Rate-limit backoff:** on 429 response, extends stale cache entries by 60s to prevent retry hammering
- **Error resilience:** on fetch failure, returns stale cached data if available; corrupted storage data is silently ignored

### Event Timestamp Persistence
- Transport persists last processed wallet event timestamp via `TransportStorageAdapter`
- Storage key: `last_wallet_event_ts_{pubkey_prefix}` (per-wallet, in `STORAGE_KEYS_GLOBAL`)
- On reconnect: `since = stored timestamp` (existing wallet) or `since = now` (fresh wallet)
- Only wallet events update the timestamp (TOKEN_TRANSFER, PAYMENT_REQUEST, PAYMENT_REQUEST_RESPONSE, DIRECT_MESSAGE)
- Chat events (GIFT_WRAP/NIP-17) have no `since` filter — always real-time
- Factory functions (`createBrowserProviders`, `createNodeProviders`) pass storage to transport automatically

### IndexedDB Databases (Browser)
The SDK manages multiple IndexedDB databases:

| Database | Provider | Purpose |
|----------|----------|---------|
| `sphere-storage` | `IndexedDBStorageProvider` | Wallet keys, per-address data (messages, etc.) |
| `sphere-token-storage-{addressId}` | `IndexedDBTokenStorageProvider` | Token data per address (TXF format) |
| `SphereVestingCacheV5` | `VestingClassifier` | L1 UTXO→coinbase tracing cache |

`Sphere.clear()` deletes all three via:
1. `vestingClassifier.destroy()` → deletes `SphereVestingCacheV5`
2. Bulk `indexedDB.databases()` → deletes all `sphere*` databases
3. `tokenStorage.clear()` → deletes per-address token databases
4. `storage.clear()` → deletes `sphere-storage`

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

## Testing

**Framework:** Vitest
**Total tests:** 1613 (63 test files)

Key test files:
- `tests/unit/core/Sphere.nametag-sync.test.ts` - Nametag sync/recovery
- `tests/unit/core/Sphere.clear.test.ts` - Wallet data cleanup (storage + tokenStorage + vesting)
- `tests/unit/transport/NostrTransportProvider.test.ts` - Transport layer, event timestamp persistence
- `tests/unit/modules/PaymentsModule.test.ts` - Payment operations
- `tests/unit/modules/NametagMinter.test.ts` - Nametag minting
- `tests/unit/modules/CommunicationsModule.storage.test.ts` - DM per-address storage, migration, pagination
- `tests/unit/registry/TokenRegistry.test.ts` - Token registry: remote fetch, caching, auto-refresh, waitForReady
- `tests/unit/price/CoinGeckoPriceProvider.test.ts` - Price provider: caching, deduplication, rate-limit backoff, persistent storage, unlisted tokens
- `tests/unit/l1/*.test.ts` - L1 blockchain utilities (incl. vesting Node.js fallback)
- `tests/unit/l1/L1PaymentsHistory.test.ts` - L1 transaction history direction/amounts
- `tests/unit/impl/browser/IndexedDBStorageProvider.test.ts` - IndexedDB kv storage, per-address scoping
- `tests/integration/tracked-addresses.test.ts` - Tracked addresses registry
- `tests/relay/groupchat-relay.test.ts` - GroupChat NIP-29 relay integration (Docker + remote)

### Relay Integration Tests

```bash
# Run with Docker (testcontainers)
npm run test:relay

# Run against deployed relay
RELAY_URL=wss://sphere-relay.unicity.network npm run test:relay
```

## Dependencies

**Core:**
- `@unicitylabs/state-transition-sdk` - L3 token/state operations
- `@unicitylabs/nostr-js-sdk` - Nostr protocol
- `@noble/hashes`, `@noble/curves` - Cryptography
- `bip39` - Mnemonic generation
- `elliptic` - secp256k1 operations

**IPFS (built-in):**
- `@libp2p/crypto` - Ed25519 key generation for IPNS
- `@libp2p/peer-id` - PeerId derivation for IPNS names
- `ipns` - IPNS record creation and marshalling

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
