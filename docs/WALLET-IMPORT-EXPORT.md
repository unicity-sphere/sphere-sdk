# Wallets: Create, Import, Export, Backup

**`Sphere.init()` is the recommended entry point** — it creates a wallet if none exists, or loads the existing one, in a single call. `Sphere.create()`, `Sphere.load()`, and `Sphere.import()` are the lower‑level building blocks it calls; reach for them only when you need explicit control (you'll see `create`/`load` in some source docstrings, but prefer `init` in app code). This guide covers those lower‑level paths: manual create/load, importing from a recovery phrase or master key, JSON export/import, legacy wallet files, and backups.

## Manual create / load

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import {
  createLocalStorageProvider,
  createNostrTransportProvider,
  createUnicityAggregatorProvider,
} from '@unicitylabs/sphere-sdk/impl/browser';

const storage   = createLocalStorageProvider();
const transport = createNostrTransportProvider();
const oracle    = createUnicityAggregatorProvider({ url: '/rpc' });

if (await Sphere.exists(storage)) {
  const sphere = await Sphere.load({ storage, transport, oracle });
} else {
  const mnemonic = Sphere.generateMnemonic();
  const sphere = await Sphere.create({ mnemonic, storage, transport, oracle });
  console.log('Save this recovery phrase:', mnemonic);
}
```

## Import from a master key (legacy wallets)

For compatibility with older wallet files:

```typescript
// BIP32 mode: master key + chain code
const sphere = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  chainCode: '64-hex-chars-chain-code',
  basePath: "m/84'/1'/0'",   // from a wallet.dat descriptor
  derivationMode: 'bip32',
  storage, transport, oracle,
});

// WIF HMAC mode: master key only
const sphere = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  derivationMode: 'wif_hmac',
  storage, transport, oracle,
});
```

## Export / import as JSON

```typescript
// Export (optionally encrypted, optionally with multiple addresses)
const json          = sphere.exportToJSON();
const encryptedJson = sphere.exportToJSON({ password: 'user-password' });
const multiJson     = sphere.exportToJSON({ addressCount: 5 });

// Import
const { success, mnemonic, error } = await Sphere.importFromJSON({
  jsonContent: JSON.stringify(json),
  password: 'user-password',  // if encrypted
  storage, transport, oracle,
});
if (success && mnemonic) console.log('Recovered phrase:', mnemonic);
```

## Wallet info & backup

```typescript
const info = sphere.getWalletInfo();
console.log(info.source);          // 'mnemonic' | 'file'
console.log(info.hasMnemonic);
console.log(info.derivationMode);
console.log(info.basePath);

const mnemonic = sphere.getMnemonic();   // for the user to back up, if available
```

## Import from legacy files (.dat, .txt)

```typescript
// wallet.dat (binary, possibly encrypted)
const fileBuffer = await file.arrayBuffer();
const result = await Sphere.importFromLegacyFile({
  fileContent: new Uint8Array(fileBuffer),
  fileName: 'wallet.dat',
  password: 'wallet-password',  // if encrypted
  onDecryptProgress: (i, total) => console.log(`Decrypting: ${i}/${total}`),
  storage, transport, oracle,
});

if (result.needsPassword) {
  // re-prompt the user for a password
}
if (result.success) {
  console.log('Imported:', result.sphere.identity?.l1Address);
}

// text backup
const textContent = await file.text();
const r = await Sphere.importFromLegacyFile({
  fileContent: textContent,
  fileName: 'backup.txt',
  storage, transport, oracle,
});

// detect type & encryption before importing
Sphere.detectLegacyFileType(fileName, content);    // 'dat' | 'txt' | 'json' | 'mnemonic' | 'unknown'
Sphere.isLegacyFileEncrypted(fileName, content);   // boolean
```

## Core utilities

The SDK also exports common helpers:

```typescript
import {
  bytesToHex, hexToBytes,
  generateMnemonic, validateMnemonic,
  sha256, ripemd160, hash160,
  getPublicKey, createKeyPair, deriveAddressInfo,
  toSmallestUnit, toHumanReadable, formatAmount,   // amount conversion
  encodeBech32, decodeBech32, createAddress, isValidBech32,
  base58Encode, base58Decode, isValidPrivateKey,
  sleep, randomHex, randomUUID, findPattern, extractFromText,
} from '@unicitylabs/sphere-sdk';
```
