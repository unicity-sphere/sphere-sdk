# Nametags

A **nametag** is a human‑readable handle (e.g. `@alice`) that people use to pay or message a wallet, instead of a long machine address. Each wallet can claim one per address.

Valid formats: lowercase alphanumeric with `_` or `-` (3–20 characters), or an E.164 phone number (e.g. `+14155552671`). Input is normalized to lowercase automatically.

> **Testnet faucet requires a nametag.** Register one before requesting test tokens.

> **Minting requires an aggregator API key** for proof verification. Configure it via the `oracle.apiKey` option when creating providers. Contact Unicity to obtain a key.

## Registering a nametag

```typescript
// During wallet creation
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  nametag: 'alice',  // registers @alice
});

// Or after creation
await sphere.registerNametag('alice');

// Mint the on-chain nametag token (required to receive via PROXY addresses)
const result = await sphere.mintNametag('alice');
if (result.success) {
  console.log('Nametag minted:', result.nametagData?.name);
}
```

## Common pitfall: "nametag already taken"

If you see:

```
Failed to register nametag. It may already be taken.
[NostrTransportProvider] Nametag already taken: myname - owner: f124f93ae6946ffd...
```

…the nametag is registered to a **different public key**. The usual causes:

1. **Storage was cleared or isn't persisting.** `Sphere.exists()` returns `false`, so the SDK creates a *new* wallet with a new key — and the old key still owns the nametag on the relay.
2. **A different recovery phrase each run:**
   ```typescript
   // WRONG: a new random phrase every start
   const mnemonic = Sphere.generateMnemonic();
   const { sphere } = await Sphere.init({ mnemonic, nametag: 'myservice' }); // fails after first run
   ```

> `autoGenerate: true` does **not** generate a new phrase on every restart — only when `Sphere.exists()` is `false` (no wallet found in storage).

## Solution: persistent storage or a fixed phrase

**Option 1 — persistent file storage (recommended for backends):**
```typescript
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data'); // persists to disk
const { sphere } = await Sphere.init({
  storage,
  autoGenerate: true,   // OK: phrase saved to disk, reused on restart
  nametag: 'myservice',
});
```

**Option 2 — fixed phrase from the environment:**
```typescript
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: process.env.WALLET_MNEMONIC, // same phrase every time
  nametag: 'myservice',
});
```

## Debugging storage

```typescript
const exists = await Sphere.exists(storage);
console.log('Wallet exists:', exists); // should be true after the first run
// If false, storage is not persisting.
```

## Recovery on import

When importing a wallet (from a phrase or file), the SDK automatically tries to recover the nametag from the relay:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  // no nametag specified — recovered from the relay if found
});

sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag:', event.data.nametag);
});

console.log(sphere.identity?.nametag); // set if recovered
```

## Multi-address nametags

Each derived address can have its own independent nametag:

```typescript
await sphere.registerNametag('alice');      // address 0 → @alice

await sphere.switchToAddress(1);
await sphere.registerNametag('bob');         // address 1 → @bob

// getNametagForAddress takes an addressId (string), not an index:
const addresses = sphere.getActiveAddresses();             // TrackedAddress[] with addressId + nametag
sphere.getNametagForAddress(addresses[0].addressId); // 'alice'
sphere.getNametagForAddress(addresses[1].addressId); // 'bob'
```
