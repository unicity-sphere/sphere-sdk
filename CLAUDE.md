# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install --include=optional    # Install all deps (helia is optional)
npm run build                     # Build all entry points with tsup
npm run build:watch               # Watch mode build
npm run clean                     # Remove dist/

npm test                          # Run tests in watch mode
npm run test:run                  # Run tests once (CI mode)
npm run test:run -- tests/unit/core/crypto.test.ts  # Run single test file

npm run lint                      # Run ESLint on TypeScript
npm run lint -- --fix             # Auto-fix lint issues
npm run typecheck                 # Run tsc --noEmit (type check only)

npm run cli -- <command>          # Run CLI tool (see below)
```

## CLI Commands

Run with `npm run cli -- <command> [args...]`

| Command | Description |
|---------|-------------|
| `encrypt <data> <password>` | AES-256 encrypt data |
| `decrypt <json> <password>` | Decrypt encrypted JSON |
| `parse-wallet <file> [password]` | Parse .txt or .dat wallet files |
| `wallet-info <file>` | Show wallet format info |
| `generate-key` | Generate random private key (hex, WIF, pubkey, address) |
| `validate-key <hex>` | Validate secp256k1 private key |
| `hex-to-wif <hex>` | Convert hex to WIF format |
| `derive-pubkey <hex>` | Get public key from private key |
| `derive-address <hex> [index]` | Derive address at HD index (default: 0) |
| `to-smallest <amount>` | Convert human readable to smallest unit |
| `to-human <amount>` | Convert smallest unit to human readable |
| `format <amount> [decimals]` | Format with decimals (default: 8) |
| `base58-encode <hex>` | Encode hex to base58 |
| `base58-decode <string>` | Decode base58 to hex |

## Architecture Overview

### Multi-Layer Wallet SDK

The Sphere SDK supports two blockchain layers with a single identity (secp256k1 keypair):

- **Layer 1 (L1)**: ALPHA blockchain - UTXO-based transactions via Electrum WebSocket
- **Layer 3 (L3)**: Unicity state transition network - Token transfers with cryptographic proofs

### Provider Pattern (Dependency Injection)

Core modules are platform-agnostic. Platform-specific code lives in `impl/`:

```
impl/
├── browser/    # LocalStorage, IndexedDB, browser Nostr
├── nodejs/     # FileStorage, Node.js Nostr, CLI support
└── shared/     # Network configs, resolver utilities
```

Provider interfaces:
- `StorageProvider` - Wallet data persistence
- `TokenStorageProvider` - Token sync backends (IndexedDB, IPFS, MongoDB, files)
- `TransportProvider` - P2P messaging (Nostr with NIP-04 encryption)
- `OracleProvider` - Aggregator for token state verification

### Build Entry Points (tsup.config.ts)

Six separate bundles for different use cases:
- `index.ts` → Main entry (ESM + CJS, universal)
- `core/index.ts` → Core without browser deps
- `l1/index.ts` → L1-only operations
- `impl/browser/index.ts` → Browser providers (no IPFS)
- `impl/browser/ipfs.ts` → Optional IPFS support (Helia)
- `impl/nodejs/index.ts` → Node.js providers

### Key Modules

| Path | Purpose |
|------|---------|
| `core/Sphere.ts` | Main SDK entry, wallet lifecycle, HD derivation |
| `modules/payments/PaymentsModule.ts` | L3 token operations, instant split V5 |
| `modules/payments/L1PaymentsModule.ts` | L1 blockchain transactions |
| `modules/communications/` | Nostr-based P2P messaging |
| `l1/` | ALPHA blockchain: tx building, UTXO, vesting |
| `serialization/txf-serializer.ts` | Token eXchange Format for storage |
| `validation/token-validator.ts` | Aggregator-based token verification |

### Network Configuration

Three presets configure all services: `mainnet`, `testnet`, `dev`

```typescript
createBrowserProviders({ network: 'testnet' })  // All services use testnet
createBrowserProviders({
  network: 'testnet',
  oracle: { url: 'custom-url' },  // Override specific service
  transport: { additionalRelays: [...] },  // Extend defaults
})
```

### Event-Driven Architecture

Sphere emits typed events: `transfer:incoming`, `identity:changed`, `sync:provider`, `transport:relay_added`, etc.

## Code Conventions

- Storage keys prefixed with `sphere_` (see `constants.ts`)
- Amount units: Internal operations use smallest unit (satoshi-equivalent); use `toSmallestUnit`/`toHumanReadable` for conversion
- Addresses: L1 uses `alpha1...` (bech32), L3 uses `DIRECT://` predicate format
- Nametags: Human-readable identifiers prefixed with `@` (e.g., `@alice`)

## Test Structure

```
tests/
├── unit/           # Pure function tests (no network)
│   ├── core/       # crypto, bech32, currency, utils, encryption
│   ├── l1/         # address, crypto, tx, addressHelpers
│   ├── modules/    # TokenSplitCalculator, shared config
│   └── serialization/  # txf, wallet-text, wallet-dat
└── integration/    # Multi-module workflows
```

Test framework: Vitest with globals enabled. Use `fake-indexeddb` for browser storage mocks.
