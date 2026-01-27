# Sphere SDK2

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

## Quick Start

```typescript
import { Sphere, createBrowserProviders } from '@unicitylabs/sphere-sdk';

// Create providers
const providers = createBrowserProviders({
  oracle: { url: '/rpc' },
});

// Initialize (auto-creates wallet if needed)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,  // Generate mnemonic if wallet doesn't exist
});

if (created && generatedMnemonic) {
  console.log('Save this mnemonic:', generatedMnemonic);
}

// Get identity
console.log('Address:', sphere.identity?.address);

// Check balance
const balance = await sphere.payments.getBalance();
console.log('L3 Balance:', balance);

// Send tokens
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'ALPHA',
});

// Derive additional addresses
const addr1 = sphere.deriveAddress(1);
console.log('Address 1:', addr1.address);
```

## Payment Requests

Request payments from others with response tracking:

```typescript
// Send payment request
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'ALPHA',
  message: 'Lottery ticket #42',
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

## Alternative: Manual Create/Load

```typescript
import {
  Sphere,
  createLocalStorageProvider,
  createNostrTransportProvider,
  createUnicityAggregatorProvider,
} from '@unicitylabs/sphere-sdk';

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
  console.log('Imported wallet:', sphere.identity?.address);
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

SDK2 exports commonly needed utility functions:

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

```
Sphere (main entry point)
├── identity    - Wallet identity (address, publicKey, nametag)
├── payments    - L3 token operations
├── l1          - L1 ALPHA transactions (coming soon)
└── communications - Direct messages & broadcasts

Providers (injectable dependencies)
├── StorageProvider      - Key-value persistence
├── TransportProvider    - P2P messaging (Nostr)
├── OracleProvider       - State validation (Aggregator)
└── TokenStorageProvider - Token backup (IPFS)

Core Utilities
├── crypto     - Key derivation, hashing, signatures
├── currency   - Amount formatting and conversion
├── bech32     - Address encoding (BIP-173)
└── utils      - Base58, patterns, sleep, random
```

## Documentation

- [Integration Guide](./docs/INTEGRATION.md)
- [API Reference](./docs/API.md)
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)

## Browser Providers

SDK2 includes browser-ready provider implementations:

| Provider | Description |
|----------|-------------|
| `LocalStorageProvider` | Browser localStorage with SSR fallback |
| `NostrTransportProvider` | Nostr relay messaging with NIP-04 |
| `UnicityAggregatorProvider` | Unicity aggregator for state proofs |
| `IpfsStorageProvider` | Helia-based IPFS with HTTP fallback |

## Node.js Providers

For CLI and server applications:

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

```typescript
const providers = createBrowserProviders({
  storage: {
    prefix: 'myapp_',  // localStorage key prefix
  },
  transport: {
    relays: ['wss://relay.unicity.network'],
  },
  oracle: {
    url: 'https://aggregator.unicity.network',
  },
});
```

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
