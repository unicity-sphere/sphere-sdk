# NFT Quickstart Guide

Create, mint, transfer, and verify non-fungible tokens with the Sphere SDK. This guide covers both CLI and programmatic (SDK) usage.

**Time estimate:** 15-20 minutes

**What you will build:** By the end of this guide you will have created a collection, minted NFTs with metadata and attributes, transferred an NFT to another wallet, and verified its on-chain state.

---

## Overview

NFTs in Sphere SDK are standard L3 tokens with a special token type (`NFT_TOKEN_TYPE_HEX`). The metadata -- name, image, description, attributes -- is stored immutably in the token's genesis data. There are two kinds of NFTs:

- **Standalone NFTs** -- one-off tokens not associated with any collection.
- **Collection NFTs** -- tokens grouped under a collection definition that can enforce supply limits, transferability rules, and deterministic minting.

An NFT's token ID is its unique identifier, derived from its metadata and a salt. Once minted, the metadata is immutable; only ownership changes via predicate transitions.

---

## Prerequisites

**Node.js version:** 18.0.0 or higher

### CLI Setup

```bash
# Initialize a wallet on testnet
npm run cli -- init --network testnet

# (Optional) Register a nametag for easier addressing
npm run cli -- nametag alice
```

### SDK Setup

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({ network: 'testnet', dataDir: './wallet', tokensDir: './tokens' });

const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  nft: true,  // Enable NFT module
});
```

> **Important:** Pass `nft: true` to `Sphere.init()` to enable the NFT module. Without it, `sphere.nft` will throw an error.

---

## 1. Create a Collection (Optional)

Collections group related NFTs under a shared definition. They are optional -- you can mint standalone NFTs without one.

Creating a collection is a local-only operation. No on-chain transaction occurs; the collection ID is derived deterministically from the definition.

### CLI

```bash
# Minimal collection
npm run cli -- nft-collection-create "My Art" "Digital art collection"

# With a supply cap
npm run cli -- nft-collection-create "Rare Spheres" "Limited edition spheres" --max-supply 100

# Soulbound (non-transferable) collection
npm run cli -- nft-collection-create "Membership Badges" "Non-transferable badges" --non-transferable
```

### SDK

```typescript
const result = await sphere.nft.createCollection({
  name: 'My Art',
  description: 'Digital art collection',
  maxSupply: 100,
});

console.log('Collection ID:', result.collectionId);
// a1b2c3d4e5f67890...
```

The returned `collectionId` is a 64-character hex string. You will use it (or a unique prefix) when minting into this collection.

---

## 2. Mint an NFT

Minting creates a new NFT token on-chain. It submits a commitment to the aggregator and waits for an inclusion proof.

### Standalone NFT (No Collection)

#### CLI

```bash
npm run cli -- nft-mint "My Artwork" "ipfs://QmImageHash" --description "A one-of-a-kind piece"
```

#### SDK

```typescript
const result = await sphere.nft.mintNFT({
  name: 'My Artwork',
  image: 'ipfs://QmImageHash',
  description: 'A one-of-a-kind piece',
});

console.log('Token ID:', result.tokenId);
console.log('Confirmed:', result.confirmed);
```

### Collection NFT

#### CLI

```bash
# Use the first few characters of the collection ID as a prefix
npm run cli -- nft-mint "Sphere #1" "ipfs://QmSphereHash" --collection a1b2c3
```

#### SDK

```typescript
const result = await sphere.nft.mintNFT(
  { name: 'Sphere #1', image: 'ipfs://QmSphereHash' },
  collectionId,  // full 64-char hex or resolved from prefix
);

console.log('Edition:', result.nft.edition);
```

Edition numbers auto-increment within a collection. To set an explicit edition, pass it as the third argument:

```typescript
const result = await sphere.nft.mintNFT(
  { name: 'Sphere #42', image: 'ipfs://QmSphere42' },
  collectionId,
  42,   // explicit edition number
  100,  // total editions (informational)
);
```

### With Attributes

Attributes follow the ERC-721 format for cross-ecosystem compatibility.

#### CLI

```bash
npm run cli -- nft-mint "Dragon" "ipfs://QmDragon" \
  --collection a1b2c3 \
  --attribute "Color:Red" \
  --attribute "Power:95" \
  --attribute "Rarity:Legendary"
```

The `--attribute` flag is repeatable. Each value is split on the first `:` into trait_type and value.

#### SDK

```typescript
const result = await sphere.nft.mintNFT(
  {
    name: 'Dragon',
    image: 'ipfs://QmDragon',
    attributes: [
      { trait_type: 'Color', value: 'Red' },
      { trait_type: 'Power', value: 95 },
      { trait_type: 'Rarity', value: 'Legendary' },
    ],
  },
  collectionId,
);
```

### Minting to Another Wallet

#### CLI

```bash
npm run cli -- nft-mint "Gift NFT" "ipfs://QmGift" --recipient @bob
```

#### SDK

```typescript
const result = await sphere.nft.mintNFT(
  { name: 'Gift NFT', image: 'ipfs://QmGift' },
  undefined,     // no collection (standalone)
  undefined,     // auto edition
  undefined,     // total editions
  '@bob',        // recipient
);
```

---

## 3. List Your NFTs

### CLI

```bash
# List all NFTs
npm run cli -- nft-list

# Filter by collection
npm run cli -- nft-list --collection a1b2c3

# JSON output for scripting
npm run cli -- nft-list --status confirmed --json
```

### SDK

```typescript
const allNFTs = sphere.nft.getNFTs();
console.log(`You own ${allNFTs.length} NFTs`);

// Filter by collection
const collectionNFTs = sphere.nft.getNFTs({ collectionId });

// Filter by status
const confirmed = sphere.nft.getNFTs({ status: 'confirmed' });
```

Each `NFTRef` in the returned array contains `tokenId`, `name`, `image`, `collectionId`, `edition`, `status`, and `mintedAt`.

---

## 4. View NFT Details

### CLI

```bash
# Use a prefix of the token ID
npm run cli -- nft-info a1b2c3
```

This prints the full NFT detail as JSON, including metadata, collection info, edition, minter, and token status.

### SDK

```typescript
const detail = await sphere.nft.getNFT(tokenId);
if (detail) {
  console.log('Name:', detail.name);
  console.log('Image:', detail.metadata.image);
  console.log('Attributes:', detail.metadata.attributes);
  console.log('Collection:', detail.collection?.name ?? '(standalone)');
}
```

---

## 5. Send an NFT

NFTs are atomic -- they transfer as a whole unit, no splitting.

### CLI

```bash
# Send by token ID prefix to a nametag
npm run cli -- nft-send a1b2c3 @alice

# With a memo
npm run cli -- nft-send a1b2c3 @bob --memo "Happy birthday!"
```

### SDK

```typescript
const transferResult = await sphere.nft.sendNFT(tokenId, '@alice', 'Happy birthday!');
console.log('Status:', transferResult.status);
// 'pending' | 'submitted' | 'delivered' | 'completed' | 'failed'
```

> **Note:** NFTs in a non-transferable (soulbound) collection cannot be sent. The command will fail with `NFT_NOT_TRANSFERABLE`.

---

## 6. Verify an NFT

Verification checks the NFT's inclusion proof against the aggregator and reports whether it has been spent (transferred away).

### CLI

```bash
npm run cli -- nft-verify a1b2c3

# Use in scripts -- exit code 0 means valid, 1 means invalid/spent
npm run cli -- nft-verify a1b2c3 && echo "VALID" || echo "INVALID"
```

### SDK

```typescript
const verification = await sphere.nft.verifyNFT(tokenId);
console.log('Valid:', verification.valid);
console.log('Spent:', verification.spent);
if (verification.errors) {
  console.log('Errors:', verification.errors);
}
```

---

## 7. Export and Import

Export saves an NFT as a TXF JSON file for backup or out-of-band transfer. Import loads it back.

### CLI

```bash
# Export to a file
npm run cli -- nft-export a1b2c3 --output ./my-nft.json

# Export to stdout (pipe to jq for inspection)
npm run cli -- nft-export a1b2c3 | jq '.genesis.data'

# Import from a file
npm run cli -- nft-import ./my-nft.json
```

### SDK

```typescript
// Export
const txfToken = await sphere.nft.exportNFT(tokenId);
if (txfToken) {
  // Save to file, send via API, etc.
  const json = JSON.stringify(txfToken, null, 2);
}

// Import
const nftRef = await sphere.nft.importNFT(txfToken);
console.log('Imported:', nftRef.name, nftRef.tokenId);
```

Importing is idempotent -- importing the same token twice returns the existing NFT without error.

---

## 8. Batch Minting

Mint up to 50 NFTs in a single operation from a JSON manifest file.

### JSON Manifest Format

Create a file `nfts.json`:

```json
[
  {
    "name": "Sphere #1",
    "image": "ipfs://QmHash1",
    "description": "First sphere",
    "attributes": [
      { "trait_type": "Color", "value": "Blue" },
      { "trait_type": "Size", "value": "Large" }
    ]
  },
  {
    "name": "Sphere #2",
    "image": "ipfs://QmHash2",
    "description": "Second sphere"
  },
  {
    "name": "Sphere #3",
    "image": "ipfs://QmHash3",
    "recipient": "@alice"
  }
]
```

### CLI

```bash
# Batch mint standalone NFTs
npm run cli -- nft-batch-mint ./nfts.json

# Batch mint into a collection
npm run cli -- nft-batch-mint ./nfts.json --collection a1b2c3
```

### SDK

```typescript
const items = [
  { metadata: { name: 'Sphere #1', image: 'ipfs://QmHash1' } },
  { metadata: { name: 'Sphere #2', image: 'ipfs://QmHash2' } },
  { metadata: { name: 'Sphere #3', image: 'ipfs://QmHash3' }, recipient: '@alice' },
];

const result = await sphere.nft.batchMintNFT(items, collectionId);
console.log(`Minted: ${result.successCount}/${items.length}`);
if (result.errors) {
  for (const err of result.errors) {
    console.error(`Item ${err.index}: ${err.error}`);
  }
}
```

Partial failures are reported per item. Successfully minted NFTs are not rolled back.

---

## 9. Advanced: Deterministic Minting

By default, NFTs get a random salt, producing unpredictable token IDs. For controlled collections where only the creator should be able to mint valid token IDs, use deterministic minting.

With deterministic minting enabled, the salt is derived as `HMAC-SHA256(privateKey, collectionId || edition)`. This means:

- Only the holder of the creator's private key can compute valid token IDs.
- Re-minting the same edition produces the same token ID (useful for crash recovery).
- Third parties cannot pre-mint or front-run editions.

### CLI

```bash
npm run cli -- nft-collection-create "Controlled Series" "Only I can mint" \
  --max-supply 100 --deterministic
```

### SDK

```typescript
const result = await sphere.nft.createCollection({
  name: 'Controlled Series',
  description: 'Only I can mint',
  maxSupply: 100,
  deterministicMinting: true,
});
```

After creating the collection with `deterministicMinting: true`, all subsequent `mintNFT()` calls into this collection automatically use deterministic salt derivation.

---

## 10. Collections and Lists

### List Collections

#### CLI

```bash
# All collections
npm run cli -- nft-collection-list

# Only collections you created
npm run cli -- nft-collection-list --mine

# JSON output
npm run cli -- nft-collection-list --json
```

#### SDK

```typescript
const allCollections = sphere.nft.getCollections();
const myCollections = sphere.nft.getCollections({ createdByMe: true });

for (const col of myCollections) {
  console.log(`${col.name}: ${col.tokenCount}/${col.maxSupply ?? 'unlimited'}`);
}
```

### Collection Details

#### CLI

```bash
npm run cli -- nft-collection-info a1b2c3
```

#### SDK

```typescript
const collection = sphere.nft.getCollection(collectionId);
if (collection) {
  console.log('Name:', collection.name);
  console.log('Creator:', collection.isCreator ? '(you)' : collection.creator);
  console.log('Transferable:', collection.transferable);
}
```

---

## 11. Listening for NFT Events

The SDK emits events for NFT lifecycle changes.

```typescript
// NFT minted (by you)
sphere.on('nft:minted', (event) => {
  console.log(`Minted: ${event.name} (${event.tokenId})`);
});

// NFT received from someone
sphere.on('nft:received', (event) => {
  console.log(`Received "${event.name}" from ${event.senderNametag ?? event.senderPubkey}`);
});

// NFT sent to someone
sphere.on('nft:transferred', (event) => {
  console.log(`Sent NFT ${event.tokenId} to ${event.recipientPubkey}`);
});

// New collection registered
sphere.on('nft:collection_created', (event) => {
  console.log(`Collection created: ${event.name} (${event.collectionId})`);
});
```

---

## Common Patterns

### ID Prefix Resolution

NFT token IDs and collection IDs are 64-character hex strings. Both the CLI and SDK support unique prefix matching -- use the first 8-12 characters instead of the full ID:

```bash
# These are equivalent (assuming the prefix is unambiguous)
npm run cli -- nft-info a1b2c3d4e5f6
npm run cli -- nft-info a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890
```

If a prefix matches multiple IDs, the CLI reports an ambiguity error and asks you to use more characters.

### Checking Collection Supply

```typescript
const collection = sphere.nft.getCollection(collectionId);
if (collection && collection.maxSupply !== null) {
  const remaining = collection.maxSupply - collection.tokenCount;
  console.log(`${remaining} mints remaining`);
}
```

### Soulbound (Non-Transferable) NFTs

Collections marked with `transferable: false` produce soulbound NFTs. These can be minted (including to other wallets via `--recipient`) but cannot be transferred after minting.

```bash
npm run cli -- nft-collection-create "Certificates" "Course completion" --non-transferable
npm run cli -- nft-mint "Certificate #1" "ipfs://QmCert" --collection a1b2c3 --recipient @student
```

### NFT Transfer History

```bash
npm run cli -- nft-history a1b2c3
```

```typescript
const history = await sphere.nft.getNFTHistory(tokenId);
for (const entry of history) {
  console.log(`${entry.type} at ${new Date(entry.timestamp).toISOString()}`);
}
```

---

## Next Steps

- **NFT Architecture** -- see [NFT-ARCHITECTURE.md](NFT-ARCHITECTURE.md) for the full module design, data model, and integration points.
- **NFT Specification** -- see [NFT-SPEC.md](NFT-SPEC.md) for detailed algorithms, serialization rules, and error handling.
- **CLI Reference** -- see [NFT-CLI-SPEC.md](NFT-CLI-SPEC.md) for the complete list of CLI commands, flags, and output formats.
- **Payments Quickstart** -- see [QUICKSTART-NODEJS.md](QUICKSTART-NODEJS.md) for L3 token payments and wallet management.
