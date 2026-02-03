# CLAUDE.md - Sphere SDK Project Context

This file provides context for Claude Code when working with the Sphere SDK project.

## Project Overview

**Sphere SDK** (`@unicitylabs/sphere-sdk`) is a modular TypeScript SDK for Unicity wallet operations supporting:
- **L1 (ALPHA blockchain)** - UTXO-based blockchain transactions via Electrum
- **L3 (Unicity state transition network)** - Token transfers with state proofs via Aggregator

**Version:** 0.1.2-beta.1
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
```

### Provider Pattern
Abstract interfaces for platform independence:

| Provider | Interface | Implementations |
|----------|-----------|-----------------|
| Storage | `StorageProvider` | LocalStorageProvider, FileStorageProvider |
| TokenStorage | `TokenStorageProvider` | IndexedDBTokenStorageProvider, FileTokenStorageProvider, IpfsStorageProvider |
| Transport | `TransportProvider` | NostrTransportProvider |
| Oracle | `OracleProvider` | UnicityAggregatorProvider |

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
- On-chain minting via `NametagMinter` for PROXY addresses

### L3 Transfers
- Use `DirectAddress` (not PROXY) for transfers
- Finalization required to generate local state for tracking
- Recipient resolved via `resolveNametagInfo` for 33-byte pubkey

### Transport vs Chain Pubkeys
- `chainPubkey`: 33-byte compressed secp256k1 for L3 chain operations
- `transportPubkey`: Derived key for Nostr messaging (HKDF from private key)
- Nametag events include both for cross-compatibility

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

## Recent Changes (feature/nametag-enhancements)

1. **Identity field renaming** (consistent naming):
   - `publicKey` → `chainPubkey`
   - `address` → `l1Address`
   - `predicateAddress` → `directAddress`

2. **Nametag recovery**: Automatic recovery from Nostr on wallet import

3. **DirectAddress for L3**: Using DirectAddress instead of ProxyAddress

4. **New events**:
   - `nametag:recovered` - Emitted when nametag found on Nostr during import
   - `identity:changed` - Updated with new field names

5. **TypeScript 5.6 compatibility**: Web Crypto API ArrayBuffer types fixed

## Testing

**Framework:** Vitest
**Total tests:** 611+

Key test files:
- `tests/unit/core/Sphere.nametag-sync.test.ts` - Nametag sync/recovery
- `tests/unit/transport/NostrTransportProvider.test.ts` - Transport layer
- `tests/unit/modules/PaymentsModule.test.ts` - Payment operations
- `tests/unit/modules/NametagMinter.test.ts` - Nametag minting
- `tests/unit/l1/*.test.ts` - L1 blockchain utilities

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
const balance = await sphere.payments.getBalance();
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
