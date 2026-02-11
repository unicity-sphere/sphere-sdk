# Sphere SDK Test Coverage Plan

## Overview

Comprehensive test plan covering all SDK modules. Tests use **Vitest** with mocks for external dependencies (WebSocket, Nostr, Aggregator).

## Current Status

| Module | Tests | Status |
|--------|-------|--------|
| `core/crypto` | 43 | ✅ Done |
| `core/bech32` | 30 | ✅ Done |
| `core/currency` | 34 | ✅ Done |
| `core/encryption` | 30 | ✅ Done |
| `core/utils` | 32 | ✅ Done |
| `l1/address` | 18 | ✅ Done |
| `l1/addressToScriptHash` | 7 | ✅ Done |
| `l1/tx` | 23 | ✅ Done |
| `l1/crypto` | 22 | ✅ Done |
| `l1/addressHelpers` | 36 | ✅ Done |
| `serialization/txf-serializer` | 44 | ✅ Done |
| `serialization/wallet-text` | 32 | ✅ Done |
| `serialization/wallet-dat` | 18 | ✅ Done |
| `modules/TokenSplitCalculator` | 23 | ✅ Done |
| `impl/shared/ipfs/ipfs-cache` | 59 | ✅ Done |
| `impl/shared/ipfs/ipfs-error-types` | 18 | ✅ Done |
| `impl/shared/ipfs/ipfs-http-client` | 18 | ✅ Done |
| `impl/shared/ipfs/ipfs-storage-provider` | 28 | ✅ Done |
| `impl/browser/ipfs/browser-ipfs-state-persistence` | 7 | ✅ Done |
| `impl/nodejs/ipfs/nodejs-ipfs-state-persistence` | 7 | ✅ Done |
| `e2e/ipfs-sync` | 6 | ✅ Done |
| **Total** | **535** | **✅ Passing** |

### Not Yet Covered (Requires Mocking)

| Module | Reason |
|--------|--------|
| `core/Sphere` | Integration class, requires all providers |
| `l1/network` | WebSocket/Electrum network calls |
| `l1/vesting` | Requires network tracing |
| `modules/PaymentsModule` | Requires `@unicitylabs/state-transition-sdk` mocks |
| `modules/L1PaymentsModule` | Requires network mocks |
| `validation/token-validator` | Requires SDK mocks |
| `transport/*` | Network interfaces |
| `oracle/*` | HTTP interfaces |

---

## 1. Core Module (`core/`)

### 1.1 `crypto.ts` - Cryptographic Functions
| Function | Test Cases |
|----------|------------|
| `generateMnemonic()` | 12/24 words, valid BIP39 |
| `validateMnemonic()` | valid/invalid phrases, edge cases |
| `mnemonicToSeedSync()` | known test vectors (BIP39) |
| `generateMasterKey()` | BIP32 test vectors |
| `deriveChildKey()` | hardened/non-hardened derivation |
| `deriveKeyAtPath()` | full BIP44 paths |
| `getPublicKey()` | compressed/uncompressed |
| `sha256()` / `ripemd160()` / `hash160()` | known hashes |
| `doubleSha256()` | Bitcoin-style double hash |
| `publicKeyToAddress()` | alpha1... generation |
| `deriveAddressInfo()` | HD address derivation |

### 1.2 `bech32.ts` - Address Encoding
| Function | Test Cases |
|----------|------------|
| `encodeBech32()` | valid witness programs |
| `decodeBech32()` | valid/invalid addresses |
| `isValidBech32()` | alpha1... validation |
| `createAddress()` | pubkey → address |
| `getAddressHrp()` | HRP extraction |

### 1.3 `currency.ts` - Amount Formatting
| Function | Test Cases |
|----------|------------|
| `toSmallestUnit()` | "1.5" → bigint, edge cases |
| `toHumanReadable()` | bigint → "1.5" |
| `formatAmount()` | localization, decimals |

### 1.4 `encryption.ts` - Wallet Encryption
| Function | Test Cases |
|----------|------------|
| `encryptData()` | AES-256 encryption |
| `decryptData()` | decryption, wrong password |

### 1.5 `utils.ts` - Utilities
| Function | Test Cases |
|----------|------------|
| `hexToBytes()` / `bytesToHex()` | round-trip |
| `base58Encode()` / `base58Decode()` | Bitcoin vectors |
| `isValidPrivateKey()` | range validation |
| `sleep()` | async timing |
| `randomHex()` / `randomUUID()` | format validation |

### 1.6 `Sphere.ts` - Main Entry Point
| Method | Test Cases |
|--------|------------|
| `Sphere.create()` | new wallet, duplicate error |
| `Sphere.load()` | existing wallet, not found |
| `Sphere.import()` | mnemonic, master key |
| `Sphere.init()` | auto-create/load |
| `Sphere.exists()` | storage check |
| `Sphere.clear()` | cleanup |
| `deriveAddress()` | HD derivation |
| `registerNametag()` | nametag registration |
| `exportToJSON()` / `importFromJSON()` | wallet backup |

---

## 2. L1 Module (`l1/`)

### 2.1 `address.ts` - Key Derivation
| Function | Test Cases |
|----------|------------|
| `generateMasterKeyFromSeed()` | BIP32 vectors |
| `generateHDAddressBIP32()` | standard derivation |
| `generateAddressFromMasterKey()` | legacy HMAC derivation |
| `deriveChildKey()` | legacy compatibility |

### 2.2 `addressToScriptHash.ts` - Electrum Format
| Function | Test Cases |
|----------|------------|
| `addressToScriptHash()` | known address → scripthash |

### 2.3 `network.ts` - Fulcrum WebSocket
| Function | Test Cases |
|----------|------------|
| `connectFulcrum()` | connection, reconnect |
| `getBalance()` | mock response |
| `getUtxos()` | UTXO parsing |
| `getHistory()` | tx history |
| `broadcastTransaction()` | tx broadcast |

### 2.4 `tx.ts` - Transaction Building
| Function | Test Cases |
|----------|------------|
| `buildTransaction()` | UTXO selection, change |
| `signTransaction()` | SegWit signing |
| `serializeWitness()` | witness serialization |
| `calculateTxSize()` | fee estimation |

### 2.5 `vesting.ts` - UTXO Classification
| Function | Test Cases |
|----------|------------|
| `classifyUtxo()` | vested/unvested |
| `traceToGenesis()` | coinbase tracing |
| `VESTING_THRESHOLD` | block 280000 |

---

## 3. Modules (`modules/`)

### 3.1 `PaymentsModule.ts` - L3 Token Operations
| Method | Test Cases |
|--------|------------|
| `initialize()` | setup with deps |
| `getTokens()` | token list |
| `getBalance()` | balance aggregation |
| `send()` | transfer flow (mocked) |
| `refresh()` | sync from storage |
| `addToken()` / `removeToken()` | CRUD |
| Payment Requests | send/receive/pay/reject |

### 3.2 `L1PaymentsModule.ts` - L1 Operations
| Method | Test Cases |
|--------|------------|
| `initialize()` | identity setup |
| `getBalance()` | aggregated balance |
| `getUtxos()` | UTXO list |
| `send()` | transaction flow |
| `getHistory()` | tx history |
| `estimateFee()` | fee calculation |

### 3.3 `TokenSplitCalculator.ts`
| Method | Test Cases |
|--------|------------|
| `calculateOptimalSplit()` | exact match, split needed, insufficient |

### 3.4 `CommunicationsModule.ts`
| Method | Test Cases |
|--------|------------|
| `sendDM()` | direct message |
| `getConversation()` | message history |
| `broadcast()` | public broadcast |

---

## 4. Providers

### 4.1 `StorageProvider` (interface + LocalStorage impl)
| Method | Test Cases |
|--------|------------|
| `save()` / `load()` | basic CRUD |
| `remove()` | deletion |
| `list()` | key enumeration |

### 4.2 `TransportProvider` (interface + Nostr impl)
| Method | Test Cases |
|--------|------------|
| `connect()` / `disconnect()` | lifecycle |
| `sendTokenTransfer()` | transfer via Nostr |
| `onTokenTransfer()` | incoming handler |

### 4.3 `OracleProvider` (interface + Aggregator impl)
| Method | Test Cases |
|--------|------------|
| `submitCommitment()` | state transition |
| `getInclusionProof()` | proof retrieval |
| `waitForInclusion()` | polling |

---

## 5. Serialization (`serialization/`)

### 5.1 `txf-serializer.ts` - Token Format
| Function | Test Cases |
|----------|------------|
| `tokenToTxf()` | Token → TXF |
| `txfToToken()` | TXF → Token |
| `buildTxfStorageData()` | IPFS format |
| `parseTxfStorageData()` | parse + validate |
| `getCurrentStateHash()` | state extraction |

### 5.2 `wallet-text.ts` - Legacy Text Format
| Function | Test Cases |
|----------|------------|
| `parseWalletText()` | plain text parsing |
| `parseAndDecryptWalletText()` | encrypted text |
| `isWalletTextFormat()` | format detection |

### 5.3 `wallet-dat.ts` - Legacy DAT Format
| Function | Test Cases |
|----------|------------|
| `parseWalletDat()` | SQLite parsing |
| `isSQLiteDatabase()` | format detection |
| `decryptCMasterKey()` | key decryption |

---

## 6. Validation (`validation/`)

### 6.1 `token-validator.ts`
| Method | Test Cases |
|--------|------------|
| `validateToken()` | valid/invalid token |
| `validateAllTokens()` | batch validation |
| `isTokenStateSpent()` | spent check |
| `checkSpentTokens()` | batch spent check |

---

## 7. Integration Tests

### 7.1 Full Wallet Flow
```
create wallet → derive addresses → L1 balance → L3 tokens → send L1 → send L3
```

### 7.2 Import/Export Flow
```
create → export JSON → clear → import JSON → verify identity
```

### 7.3 Legacy Import Flow
```
parse txt file → import → verify addresses match
```

---

## 8. IPFS Storage Provider (`impl/shared/ipfs/`)

### 8.1 `ipfs-cache.ts` - Multi-Tier Cache (59 tests)
| Feature | Test Cases |
|---------|------------|
| IPNS record cache | TTL expiry, get/set, invalidation |
| Content cache | Immutable CID cache, get/set |
| Circuit breaker | Failure tracking, threshold, cooldown, reset on success |
| Known-fresh | Fresh window timing, mark/check, expiry |
| Cache management | Clear all, independent layer isolation |

### 8.2 `ipfs-error-types.ts` - Error Classification (18 tests)
| Feature | Test Cases |
|---------|------------|
| `IpfsError` | Category assignment, gateway tracking, circuit breaker flag |
| `classifyFetchError()` | AbortError→TIMEOUT, TypeError→NETWORK, generic errors |
| `classifyHttpStatus()` | 404→NOT_FOUND, 500 routing→NOT_FOUND, 5xx→GATEWAY |

### 8.3 `ipfs-http-client.ts` - HTTP Operations (18 tests)
| Feature | Test Cases |
|---------|------------|
| `upload()` | JSON upload, parallel gateways, all-fail handling |
| `fetchContent()` | CID fetch, cache hit, content caching |
| `resolveIpns()` | Progressive resolution, highest sequence, no results |
| `publishIpns()` | Multi-gateway publish, partial success |
| `testConnectivity()` | Gateway health, timeout, errors |

### 8.4 `ipfs-storage-provider.ts` - Provider Lifecycle (28 tests)
| Feature | Test Cases |
|---------|------------|
| Initialization | Identity derivation, state persistence load |
| Save | Upload + IPNS publish, version increment, chain validation |
| Load | Known-fresh, IPNS cache, network resolution, stale fallback |
| Sync | Remote merge, initial upload, same-version skip |
| Version conflicts | Concurrent device protection, lastCid chaining |
| Events | Storage and sync event emission |

### 8.5 `browser-ipfs-state-persistence.ts` - Browser Persistence (7 tests)
| Feature | Test Cases |
|---------|------------|
| localStorage | Save/load/clear, missing key handling, JSON round-trip |

### 8.6 `nodejs-ipfs-state-persistence.ts` - Node.js Persistence (7 tests)
| Feature | Test Cases |
|---------|------------|
| File-based | Save/load/clear via StorageProvider, missing key handling |

### 8.7 E2E `ipfs-sync.test.ts` - Live Network (6 tests)
| Feature | Test Cases |
|---------|------------|
| End-to-end | Save→load round-trip, sync merge, recovery after wipe |
| Identity | Deterministic IPNS name derivation, cross-session persistence |

---

## Test Infrastructure

### Setup
```bash
npm install -D vitest @vitest/coverage-v8
```

### Config (`vitest.config.ts`)
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['core/**', 'l1/**', 'modules/**', 'serialization/**', 'validation/**'],
    },
  },
});
```

### Directory Structure
```
tests/
├── unit/
│   ├── core/
│   │   ├── crypto.test.ts
│   │   ├── bech32.test.ts
│   │   ├── currency.test.ts
│   │   └── encryption.test.ts
│   ├── l1/
│   │   ├── address.test.ts
│   │   ├── tx.test.ts
│   │   └── network.test.ts
│   ├── modules/
│   │   ├── PaymentsModule.test.ts
│   │   ├── L1PaymentsModule.test.ts
│   │   └── TokenSplitCalculator.test.ts
│   ├── serialization/
│   │   ├── txf-serializer.test.ts
│   │   └── wallet-text.test.ts
│   ├── validation/
│   │   └── token-validator.test.ts
│   └── impl/
│       ├── shared/ipfs/
│       │   ├── ipfs-cache.test.ts
│       │   ├── ipfs-error-types.test.ts
│       │   ├── ipfs-http-client.test.ts
│       │   └── ipfs-storage-provider.test.ts
│       ├── browser/ipfs/
│       │   └── browser-ipfs-state-persistence.test.ts
│       └── nodejs/ipfs/
│           └── nodejs-ipfs-state-persistence.test.ts
├── e2e/
│   └── ipfs-sync.test.ts
├── integration/
│   ├── sphere.test.ts
│   └── wallet-flow.test.ts
└── fixtures/
    ├── test-vectors.ts
    └── mock-providers.ts
```

### Mocking Strategy
- **WebSocket**: Mock Fulcrum responses
- **Nostr**: Mock relay connections
- **Aggregator**: Mock HTTP responses
- **Storage**: In-memory Map-based provider

---

## Coverage Targets

| Module | Target |
|--------|--------|
| `core/crypto` | 95% |
| `core/bech32` | 95% |
| `core/currency` | 90% |
| `l1/*` | 85% |
| `modules/*` | 80% |
| `serialization/*` | 85% |
| `validation/*` | 80% |
| **Overall** | **85%** |

---

## Priority Order

1. **P0 (Critical)**: `core/crypto`, `core/bech32`, `l1/address`, `l1/tx` ✅ **DONE**
2. **P1 (High)**: `core/encryption`, `core/currency`, `core/utils`, `serialization/txf` ✅ **DONE**
3. **P2 (Medium)**: `Sphere`, `PaymentsModule`, `L1PaymentsModule` - requires mocking
4. **P3 (Low)**: Providers (interface-based), Communications, Validation - requires mocking

## Running Tests

```bash
# Run all tests
npm test

# Run once (CI mode)
npm run test:run

# Run specific file
npx vitest run tests/unit/core/crypto.test.ts

# Run with coverage (requires @vitest/coverage-v8)
npm test -- --coverage
```
