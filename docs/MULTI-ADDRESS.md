# Multiple addresses

One recovery phrase can produce many independent addresses (a hierarchical‑deterministic, or "HD", wallet). Each address has its own balance, its own `@nametag`, and its own message history.

```typescript
// Current address index
const currentIndex = sphere.getCurrentAddressIndex(); // 0

// Switch to a different address
await sphere.switchToAddress(1);
console.log(sphere.identity?.l1Address); // the address at index 1

// Register a nametag for this address (independent per address)
await sphere.registerNametag('bob');

// Switch back
await sphere.switchToAddress(0);

// Look up a nametag for a specific address — by its addressId (a string), not its index
const addresses = sphere.getActiveAddresses();            // TrackedAddress[] (index, addressId, nametag, …)
const bobNametag = sphere.getNametagForAddress(addresses[1].addressId); // 'bob'

// (sphere.getAllAddressNametags() also exists but is @deprecated and returns a
//  nested Map<addressId, Map<index, nametag>>; prefer getActiveAddresses().)

// Derive an address without switching to it (e.g. just to display or receive)
const addr2 = sphere.deriveAddress(2);
console.log(addr2.address, addr2.publicKey);
```

## Identity properties

A wallet exposes several addresses. People normally use your `@nametag`; the rest are machine addresses.

```typescript
interface Identity {
  directAddress?: string;   // your primary wallet address (DIRECT://…)
  nametag?: string;         // human-readable handle (@username)
  l1Address: string;        // your ALPHA coin address (alpha1…)
  chainPubkey: string;      // 33-byte compressed public key
  ipnsName?: string;        // identifier used for IPFS token backup
}

console.log(sphere.identity?.directAddress);  // DIRECT://0000be36…  (primary)
console.log(sphere.identity?.nametag);        // alice               (human-readable)
console.log(sphere.identity?.l1Address);      // alpha1qw3e…         (ALPHA coin only)
console.log(sphere.identity?.chainPubkey);    // 02abc123…
```

For how these addresses are all derived from one key, see [ARCHITECTURE.md](../ARCHITECTURE.md#1-one-key-many-identities).

## Address‑change event

```typescript
sphere.on('identity:changed', (event) => {
  console.log('Switched to address index:', event.data.addressIndex);
  console.log('Primary address:',           event.data.directAddress);
  console.log('ALPHA address:',             event.data.l1Address);
  console.log('Public key:',                event.data.chainPubkey);
  console.log('Nametag:',                   event.data.nametag);
});

// Fired when a nametag is recovered while importing a wallet
sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag:', event.data.nametag);
});
```

See also [NAMETAGS.md → Multi-address nametags](NAMETAGS.md#multi-address-nametags).
