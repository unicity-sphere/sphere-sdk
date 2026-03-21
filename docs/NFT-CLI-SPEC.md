# NFT CLI Commands Specification

> **Status:** Draft specification
> **Module path:** `modules/nft/NFTModule.ts`
> **API spec:** [NFT-SPEC.md](NFT-SPEC.md)
> **CLI entry point:** `cli/index.ts`

---

## Table of Contents

1. [Conventions](#conventions)
2. [Common Flags](#common-flags)
3. [ID Prefix Resolution](#id-prefix-resolution)
4. [Collection Commands](#collection-commands)
   - [nft-collection-create](#nft-collection-create)
   - [nft-collection-list](#nft-collection-list)
   - [nft-collection-info](#nft-collection-info)
5. [Minting Commands](#minting-commands)
   - [nft-mint](#nft-mint)
   - [nft-batch-mint](#nft-batch-mint)
6. [Transfer Commands](#transfer-commands)
   - [nft-send](#nft-send)
7. [Query Commands](#query-commands)
   - [nft-list](#nft-list)
   - [nft-info](#nft-info)
   - [nft-history](#nft-history)
8. [Import/Export Commands](#importexport-commands)
   - [nft-export](#nft-export)
   - [nft-import](#nft-import)
9. [Verification Commands](#verification-commands)
   - [nft-verify](#nft-verify)
10. [printUsage Integration](#printusage-integration)
11. [Completions Integration](#completions-integration)
12. [COMMAND_HELP Entries](#command_help-entries)

---

## Conventions

All NFT CLI commands follow the established patterns from the existing CLI:

- **Flat hyphenated names:** `nft-mint`, `nft-list`, `nft-send` (not subcommands like `nft mint`).
- **Manual arg parsing:** `args.indexOf('--flag')` for flags, `args[1]`, `args[2]` for positional arguments.
- **Module availability check:** Every command that touches the NFT module must guard with:
  ```typescript
  if (!sphere.nft) {
    console.error('NFT module not enabled. Initialize with NFT support.');
    process.exit(1);
  }
  ```
- **Sphere lifecycle:** `getSphere()` then `ensureSync()` then work then `syncAfterWrite()` then `closeSphere()`.
- **ID prefix resolution:** Short hex prefixes are matched against full 64-char hex IDs. See [ID Prefix Resolution](#id-prefix-resolution).
- **Output:** `JSON.stringify(obj, null, 2)` for structured data, labeled lines for status, tabular format for lists.
- **Error output:** `console.error(msg)` followed by `process.exit(1)`.

---

## Common Flags

These flags are handled globally in `main()` before command dispatch. They apply to all commands that initialize a Sphere instance.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--network <net>` | `'mainnet' \| 'testnet' \| 'dev'` | From config | Override network (applied via `loadConfig()`) |
| `--no-nostr` | boolean | `false` | Disable Nostr transport (use no-op) |
| `--no-sync` | boolean | `false` | Skip `ensureSync()` before reading state |

These flags are NOT re-documented on every command. They are implicitly available on any command that calls `getSphere()`.

---

## ID Prefix Resolution

NFT token IDs and collection IDs are 64-character lowercase hex strings (SHA-256 hashes). To avoid requiring users to type the full ID, all commands that accept an ID also accept a unique prefix.

### Resolution Algorithm

The resolution algorithm is the same for both token IDs and collection IDs, differing only in the source list:

```
1. If argument is exactly 64 hex chars → use as-is (exact match)
2. Otherwise, treat as prefix:
   a. Collect all IDs from the relevant index that start with the prefix
   b. If 0 matches → error: "No NFT found matching prefix: <prefix>"
      or "No collection found matching prefix: <prefix>"
   c. If 1 match → use the full ID
   d. If >1 matches → error: "Ambiguous prefix "<prefix>" matches <N> NFTs. Use more characters."
```

### Implementation Pattern

For **token IDs** (used by `nft-info`, `nft-send`, `nft-history`, `nft-export`, `nft-verify`):

```typescript
const allNFTs = sphere.nft.getNFTs();
const matched = allNFTs.filter(n => n.tokenId.startsWith(idOrPrefix));
if (matched.length === 0) {
  console.error(`No NFT found matching prefix: ${idOrPrefix}`);
  process.exit(1);
}
if (matched.length > 1) {
  console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} NFTs. Use more characters.`);
  process.exit(1);
}
const tokenId = matched[0].tokenId;
```

For **collection IDs** (used by `nft-collection-info`, `--collection` flag):

```typescript
const allCollections = sphere.nft.getCollections();
const matched = allCollections.filter(c => c.collectionId.startsWith(idOrPrefix));
if (matched.length === 0) {
  console.error(`No collection found matching prefix: ${idOrPrefix}`);
  process.exit(1);
}
if (matched.length > 1) {
  console.error(`Ambiguous prefix "${idOrPrefix}" matches ${matched.length} collections. Use more characters.`);
  process.exit(1);
}
const collectionId = matched[0].collectionId;
```

### Prefix Display Convention

When displaying IDs in tabular output, show the first 12 characters followed by `...`:

```
a1b2c3d4e5f6...   Blue Sphere #1   CryptoSpheres   1/100
```

When displaying IDs in JSON or detailed output, show the full 64-character ID.

---

## Collection Commands

### nft-collection-create

Create a new NFT collection definition (local-only, no on-chain transaction).

**Usage:**

```
nft-collection-create <name> <description> [flags]
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `name` | string | Yes | Collection name (1-128 chars) |
| 2 | `description` | string | Yes | Collection description (1-4096 chars, quote if spaces) |

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--max-supply <n>` | integer | unlimited | Maximum number of NFTs in this collection (1-1,000,000) |
| `--image <uri>` | string | none | Collection image URI (ipfs://, https://, or data:) |
| `--royalty <bps> <recipient>` | integer + string | none | Royalty in basis points (0-10000) and recipient address |
| `--non-transferable` | boolean | false | Mark collection as soulbound (NFTs cannot be transferred) |
| `--deterministic` | boolean | false | Use deterministic salt derivation for minting |
| `--external-url <url>` | string | none | External URL for the collection |

**Sync Mode:** None required (local-only operation). Calls `syncAfterWrite()` after to persist.

**Algorithm:**

```
1. Parse positional args: name = args[1], description = args[2]
2. Validate name and description are present
3. Parse all optional flags
4. Build CreateCollectionRequest
5. getSphere() → sphere.nft.createCollection(request)
6. Print result as JSON
7. syncAfterWrite() → closeSphere()
```

**Output Format:**

```json
{
  "collectionId": "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "name": "CryptoSpheres",
  "creator": "02abc123...",
  "maxSupply": 100,
  "transferable": true,
  "deterministicMinting": false
}
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing name | `Usage: nft-collection-create <name> <description> [--max-supply <n>] ...` |
| Missing description | Same usage message |
| Name too long (>128 chars) | `Collection name must be 1-128 characters` |
| Invalid maxSupply | `--max-supply must be an integer between 1 and 1000000` |
| Invalid royalty bps | `--royalty basis points must be an integer between 0 and 10000` |
| Missing royalty recipient | `--royalty requires both <bps> and <recipient>` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Minimal collection
npm run cli -- nft-collection-create "CryptoSpheres" "A collection of digital spheres"

# Collection with supply cap and image
npm run cli -- nft-collection-create "Rare Art" "Limited digital art" \
  --max-supply 100 --image "ipfs://QmHash123"

# Soulbound collection with royalty and deterministic minting
npm run cli -- nft-collection-create "Membership Badges" "Non-transferable badges" \
  --non-transferable --deterministic --royalty 500 @treasury
```

---

### nft-collection-list

List all NFT collections known to this wallet.

**Usage:**

```
nft-collection-list [flags]
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--mine` | boolean | false | Show only collections created by this wallet |
| `--json` | boolean | false | Output as JSON array instead of table |

**Sync Mode:** `ensureSync(sphere, 'nostr')` -- collections are local but NFT counts depend on received tokens.

**Algorithm:**

```
1. getSphere() → ensureSync(sphere, 'nostr')
2. sphere.nft.getCollections({ createdByMe: mineFlag })
3. Print as table or JSON
4. closeSphere()
```

**Output Format (table):**

```
Collections (3):

ID               Name              Tokens   Max Supply   Creator        Transferable
a1b2c3d4e5f6...  CryptoSpheres     12       100          (you)          Yes
b2c3d4e5f678...  Digital Art        3        unlimited    02def456...    Yes
c3d4e5f67890...  Membership        45       unlimited    (you)          No
```

**Output Format (--json):**

```json
[
  {
    "collectionId": "a1b2c3d4e5f6...",
    "name": "CryptoSpheres",
    "tokenCount": 12,
    "maxSupply": 100,
    "creator": "02abc123...",
    "isCreator": true,
    "transferable": true
  }
]
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |
| No collections found | `No collections found.` (exit 0, not an error) |

**Examples:**

```bash
# List all collections
npm run cli -- nft-collection-list

# List only collections you created
npm run cli -- nft-collection-list --mine

# JSON output for scripting
npm run cli -- nft-collection-list --json
```

---

### nft-collection-info

Show detailed information about a specific collection.

**Usage:**

```
nft-collection-info <collectionId|prefix>
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `collectionId` | string | Yes | Full collection ID or unique prefix |

**Sync Mode:** `ensureSync(sphere, 'nostr')`

**Algorithm:**

```
1. getSphere() → ensureSync(sphere, 'nostr')
2. Resolve collection ID from prefix (see ID Prefix Resolution)
3. sphere.nft.getCollection(collectionId) → CollectionRef
4. Print full collection details as JSON
5. closeSphere()
```

**Output Format:**

```json
{
  "collectionId": "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "name": "CryptoSpheres",
  "creator": "02abc123def456789...",
  "isCreator": true,
  "tokenCount": 12,
  "maxSupply": 100,
  "transferable": true,
  "image": "ipfs://QmHash123",
  "royalty": {
    "basisPoints": 500,
    "recipient": "DIRECT://..."
  }
}
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing argument | `Usage: nft-collection-info <collectionId or prefix>` |
| No match | `No collection found matching prefix: <prefix>` |
| Ambiguous prefix | `Ambiguous prefix "<prefix>" matches <N> collections. Use more characters.` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Full ID
npm run cli -- nft-collection-info a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890

# Prefix (unambiguous)
npm run cli -- nft-collection-info a1b2c3

# Very short prefix (may be ambiguous)
npm run cli -- nft-collection-info a1
```

---

## Minting Commands

### nft-mint

Mint a single NFT. Can be standalone or part of a collection.

**Usage:**

```
nft-mint <name> <image-uri> [flags]
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `name` | string | Yes | NFT name (1-256 chars, quote if spaces) |
| 2 | `image-uri` | string | Yes | Primary image URI (ipfs://, https://, or data:) |

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--collection <id>` | string | none | Collection ID or prefix to mint into |
| `--description <text>` | string | none | NFT description (quote if spaces) |
| `--edition <n>` | integer | auto-increment | Explicit edition number (collection mints only) |
| `--total-editions <n>` | integer | 0 | Total planned editions (informational) |
| `--recipient <addr>` | string | self | Mint directly to another wallet (@nametag, DIRECT://, pubkey) |
| `--attribute <trait:value>` | string | none | Add a trait attribute (repeatable) |
| `--animation-url <uri>` | string | none | Animation/multimedia URI |
| `--external-url <url>` | string | none | External URL |
| `--background-color <hex>` | string | none | Background color (6-char hex, no #) |
| `--json` | boolean | false | Output result as JSON instead of formatted text |

**Sync Mode:** `ensureSync(sphere, 'full')` -- needs up-to-date token inventory for collection counters.

**Algorithm:**

```
1. Parse positional args: name = args[1], imageUri = args[2]
2. Validate name and image-uri are present
3. Parse all optional flags
4. If --collection provided, resolve collection ID from prefix
5. Parse --attribute flags (repeatable):
   For each --attribute occurrence:
     Split value on first ':' → trait_type, value
6. Build NFTMetadata object
7. getSphere() → ensureSync(sphere, 'full')
8. sphere.nft.mintNFT(metadata, collectionId, edition, totalEditions, recipient)
9. Print result
10. syncAfterWrite() → closeSphere()
```

**Repeatable --attribute Parsing:**

The `--attribute` flag can appear multiple times. Each value is split on the first `:` character:

```bash
--attribute "Color:Blue" --attribute "Rarity:Legendary" --attribute "Power:95"
```

Produces:

```json
[
  { "trait_type": "Color", "value": "Blue" },
  { "trait_type": "Rarity", "value": "Legendary" },
  { "trait_type": "Power", "value": "95" }
]
```

Implementation for repeatable flags:

```typescript
const attributes: NFTAttribute[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--attribute' && args[i + 1]) {
    const colonIdx = args[i + 1].indexOf(':');
    if (colonIdx === -1) {
      console.error(`Invalid --attribute format: "${args[i + 1]}". Expected "trait:value".`);
      process.exit(1);
    }
    attributes.push({
      trait_type: args[i + 1].slice(0, colonIdx),
      value: args[i + 1].slice(colonIdx + 1),
    });
  }
}
```

**Output Format:**

```
NFT minted:
  Token ID:      a1b2c3d4e5f67890...
  Name:          Blue Sphere #1
  Collection:    a1b2c3d4e5f6... (CryptoSpheres)
  Edition:       1
  Confirmed:     true
```

With `--json` flag or when piped, output as JSON:

```json
{
  "tokenId": "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "collectionId": "b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890ab",
  "edition": 1,
  "confirmed": true
}
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing name | `Usage: nft-mint <name> <image-uri> [--collection <id>] [--description <text>] ...` |
| Missing image-uri | Same usage message |
| Collection not found | `No collection found matching prefix: <prefix>` |
| Max supply exceeded | `Max supply reached for collection <id>` |
| Invalid attribute format | `Invalid --attribute format: "<value>". Expected "trait:value".` |
| Mint failed (oracle) | `Failed to mint NFT: <oracle error message>` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Standalone NFT (no collection)
npm run cli -- nft-mint "My Art" "ipfs://QmImageHash" --description "One-of-a-kind artwork"

# Mint into a collection with auto-increment edition
npm run cli -- nft-mint "Blue Sphere #1" "ipfs://QmBlue" --collection a1b2c3

# Mint with attributes and explicit edition
npm run cli -- nft-mint "Dragon" "ipfs://QmDragon" \
  --collection a1b2c3 --edition 42 --total-editions 100 \
  --attribute "Color:Red" --attribute "Power:95" --attribute "Rarity:Legendary"

# Mint directly to another wallet
npm run cli -- nft-mint "Gift NFT" "ipfs://QmGift" --recipient @alice
```

---

### nft-batch-mint

Mint multiple NFTs from a JSON manifest file.

**Usage:**

```
nft-batch-mint <json-file> [flags]
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `json-file` | string | Yes | Path to JSON file containing NFT definitions |

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--collection <id>` | string | none | Collection ID or prefix (applies to all items) |

**JSON File Format:**

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
    "description": "Second sphere",
    "edition": 5,
    "recipient": "@alice"
  }
]
```

Each item in the array can contain:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | NFT name |
| `image` | string | Yes | Primary image URI |
| `description` | string | No | NFT description |
| `attributes` | NFTAttribute[] | No | Trait attributes |
| `animationUrl` | string | No | Animation URI |
| `externalUrl` | string | No | External URL |
| `backgroundColor` | string | No | Background color (6-char hex) |
| `properties` | object | No | Arbitrary properties |
| `edition` | number | No | Explicit edition (collection mints only) |
| `recipient` | string | No | Mint to specific recipient |

**Sync Mode:** `ensureSync(sphere, 'full')`

**Algorithm:**

```
1. Parse json-file path from args[1]
2. Read and parse JSON file
3. Validate it is an array with 1-50 items
4. If --collection provided, resolve collection ID from prefix
5. Transform array into batchMintNFT items:
   For each item:
     metadata = { name, image, description, attributes, ... }
     edition = item.edition (optional)
     recipient = item.recipient (optional)
6. getSphere() → ensureSync(sphere, 'full')
7. sphere.nft.batchMintNFT(items, collectionId)
8. Print summary
9. syncAfterWrite() → closeSphere()
```

**Output Format:**

```
Batch mint complete:
  Success: 8/10
  Failed:  2/10

Minted:
  [0] a1b2c3d4e5f6...  Sphere #1   edition 1   confirmed
  [1] b2c3d4e5f678...  Sphere #2   edition 2   confirmed
  [2] c3d4e5f67890...  Sphere #3   edition 3   confirmed
  ...

Errors:
  [4] Failed to mint NFT: Oracle rejected commitment
  [7] Invalid metadata: name too long
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing file argument | `Usage: nft-batch-mint <json-file> [--collection <id>]` |
| File not found | `File not found: "<path>"` |
| Invalid JSON | `Invalid JSON in batch file "<path>"` |
| Not an array | `Batch file must contain a JSON array of NFT definitions` |
| Empty array | `Batch file must contain at least one item` |
| Too many items (>50) | `Batch size <N> exceeds maximum of 50` |
| Collection not found | `No collection found matching prefix: <prefix>` |
| Max supply exceeded | `Batch mint would exceed maxSupply: <current> + <batch> > <max>` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Batch mint standalone NFTs
npm run cli -- nft-batch-mint ./nfts.json

# Batch mint into a collection
npm run cli -- nft-batch-mint ./nfts.json --collection a1b2c3

# Batch mint with full collection ID
npm run cli -- nft-batch-mint ./nfts.json --collection a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890
```

---

## Transfer Commands

### nft-send

Send an NFT to another wallet.

**Usage:**

```
nft-send <tokenId|prefix> <recipient> [flags]
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `tokenId` | string | Yes | Token ID or unique prefix |
| 2 | `recipient` | string | Yes | Recipient (@nametag, DIRECT://, chain pubkey, alpha1...) |

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--memo <text>` | string | none | Transfer memo (max 256 chars) |

**Sync Mode:** `ensureSync(sphere, 'full')` -- needs up-to-date token inventory.

**Algorithm:**

```
1. Parse args: tokenIdOrPrefix = args[1], recipient = args[2]
2. Validate both are present
3. getSphere() → ensureSync(sphere, 'full')
4. Resolve token ID from prefix (see ID Prefix Resolution)
5. Parse --memo flag
6. sphere.nft.sendNFT(tokenId, recipient, memo)
7. Print transfer result
8. syncAfterWrite() → closeSphere()
```

**Output Format:**

```
NFT sent:
  Token ID:   a1b2c3d4e5f67890...
  Recipient:  @alice
  Status:     delivered
  Memo:       Gift for your birthday
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing tokenId | `Usage: nft-send <tokenId or prefix> <recipient> [--memo <text>]` |
| Missing recipient | Same usage message |
| NFT not found | `No NFT found matching prefix: <prefix>` |
| Ambiguous prefix | `Ambiguous prefix "<prefix>" matches <N> NFTs. Use more characters.` |
| Non-transferable | `NFT belongs to a non-transferable (soulbound) collection` |
| Transfer failed | `Failed to send NFT: <error message>` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Send by prefix to a nametag
npm run cli -- nft-send a1b2c3 @alice

# Send with a memo
npm run cli -- nft-send a1b2c3 @bob --memo "Here is your NFT"

# Send to a DIRECT address
npm run cli -- nft-send a1b2c3d4e5f67890 "DIRECT://abc123..."
```

---

## Query Commands

### nft-list

List all NFTs in the wallet.

**Usage:**

```
nft-list [flags]
```

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--collection <id>` | string | none | Filter by collection ID or prefix |
| `--status <status>` | `'confirmed' \| 'pending'` | all | Filter by token status |
| `--json` | boolean | false | Output as JSON array |

**Sync Mode:** `ensureSync(sphere, 'nostr')`

**Algorithm:**

```
1. getSphere() → ensureSync(sphere, 'nostr')
2. Parse filter flags
3. If --collection provided, resolve collection ID from prefix
4. Build GetNFTsOptions from flags
5. sphere.nft.getNFTs(options)
6. Print as table or JSON
7. closeSphere()
```

**Output Format (table):**

```
NFTs (5):

ID               Name              Collection        Edition   Status
a1b2c3d4e5f6...  Blue Sphere #1    CryptoSpheres     1/100     confirmed
b2c3d4e5f678...  Red Sphere #2     CryptoSpheres     2/100     confirmed
c3d4e5f67890...  My Art            (standalone)       -         confirmed
d4e5f6789012...  Gift Card         Membership        12        pending
e5f678901234...  Dragon            Monsters          1         confirmed
```

**Output Format (--json):**

```json
[
  {
    "tokenId": "a1b2c3d4e5f67890...",
    "name": "Blue Sphere #1",
    "collectionId": "b2c3d4e5f67890...",
    "edition": 1,
    "image": "ipfs://QmHash",
    "status": "confirmed",
    "mintedAt": 1700000000000
  }
]
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Invalid status filter | `--status must be "confirmed" or "pending"` |
| Collection prefix not found | `No collection found matching prefix: <prefix>` |
| No NFTs found | `No NFTs found.` (exit 0, not an error) |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# List all NFTs
npm run cli -- nft-list

# Filter by collection
npm run cli -- nft-list --collection a1b2c3

# Show only confirmed NFTs in JSON
npm run cli -- nft-list --status confirmed --json
```

---

### nft-info

Show full details for a single NFT.

**Usage:**

```
nft-info <tokenId|prefix>
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `tokenId` | string | Yes | Token ID or unique prefix |

**Sync Mode:** `ensureSync(sphere, 'nostr')`

**Algorithm:**

```
1. Parse tokenIdOrPrefix from args[1]
2. getSphere() → ensureSync(sphere, 'nostr')
3. Resolve token ID from prefix
4. sphere.nft.getNFT(tokenId) → NFTDetail
5. Print full details as JSON
6. closeSphere()
```

**Output Format:**

```json
{
  "tokenId": "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "name": "Blue Sphere #1",
  "collectionId": "b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890ab",
  "edition": 1,
  "totalEditions": 100,
  "status": "confirmed",
  "mintedAt": 1700000000000,
  "minter": "02abc123...",
  "metadata": {
    "name": "Blue Sphere #1",
    "description": "A blue sphere from the CryptoSpheres collection",
    "image": "ipfs://QmBlueHash",
    "attributes": [
      { "trait_type": "Color", "value": "Blue" },
      { "trait_type": "Rarity", "value": "Common" }
    ]
  },
  "collection": {
    "name": "CryptoSpheres",
    "creator": "02abc123...",
    "maxSupply": 100,
    "transferable": true
  }
}
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing argument | `Usage: nft-info <tokenId or prefix>` |
| No match | `No NFT found matching prefix: <prefix>` |
| Ambiguous prefix | `Ambiguous prefix "<prefix>" matches <N> NFTs. Use more characters.` |
| NFT not found (after resolution) | `NFT not found: <tokenId>` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Full token ID
npm run cli -- nft-info a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890

# Prefix
npm run cli -- nft-info a1b2c3

# Very short prefix
npm run cli -- nft-info a1b2
```

---

### nft-history

Show the ownership and transfer history for an NFT.

**Usage:**

```
nft-history <tokenId|prefix>
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `tokenId` | string | Yes | Token ID or unique prefix |

**Sync Mode:** `ensureSync(sphere, 'nostr')`

**Algorithm:**

```
1. Parse tokenIdOrPrefix from args[1]
2. getSphere() → ensureSync(sphere, 'nostr')
3. Resolve token ID from prefix
4. sphere.nft.getNFTHistory(tokenId) → NFTHistoryEntry[]
5. Print chronological history
6. closeSphere()
```

**Output Format:**

```
History for a1b2c3d4e5f6... "Blue Sphere #1" (3 events):

  Time                   Type            Counterparty         Confirmed
  2024-01-15 10:30:00    mint            DIRECT://abc123...   yes
  2024-02-20 14:15:30    transfer_out    @alice               yes
  2024-03-10 09:45:00    transfer_in     @bob                 yes
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing argument | `Usage: nft-history <tokenId or prefix>` |
| No match | `No NFT found matching prefix: <prefix>` |
| Ambiguous prefix | `Ambiguous prefix "<prefix>" matches <N> NFTs. Use more characters.` |
| No history | `No history found for NFT <tokenId>.` (exit 0) |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# View history by prefix
npm run cli -- nft-history a1b2c3

# View history by full ID
npm run cli -- nft-history a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890
```

---

## Import/Export Commands

### nft-export

Export an NFT as a TXF JSON file for backup or external transfer.

**Usage:**

```
nft-export <tokenId|prefix> [flags]
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `tokenId` | string | Yes | Token ID or unique prefix |

**Flags:**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--output <file>` | string | stdout | Write TXF JSON to file instead of stdout |

**Sync Mode:** `ensureSync(sphere, 'nostr')`

**Algorithm:**

```
1. Parse tokenIdOrPrefix from args[1]
2. getSphere() → ensureSync(sphere, 'nostr')
3. Resolve token ID from prefix
4. sphere.nft.exportNFT(tokenId) → TxfToken | null
5. If null → error
6. Serialize as JSON
7. If --output specified → write to file
   Else → print to stdout
8. closeSphere()
```

**Output Format (stdout):**

The full TXF JSON is printed to stdout. When `--output` is specified, the JSON is written to the file and a confirmation message is printed to stderr:

```
Exported NFT a1b2c3d4e5f6... to ./my-nft.json
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing argument | `Usage: nft-export <tokenId or prefix> [--output <file>]` |
| No match | `No NFT found matching prefix: <prefix>` |
| Ambiguous prefix | `Ambiguous prefix "<prefix>" matches <N> NFTs. Use more characters.` |
| Export returned null | `Failed to export NFT: token not found or not an NFT type` |
| File write error | `Failed to write to "<path>": <error>` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Export to stdout (pipe to file or jq)
npm run cli -- nft-export a1b2c3

# Export to a file
npm run cli -- nft-export a1b2c3 --output ./my-nft.json

# Export and pipe to jq for inspection
npm run cli -- nft-export a1b2c3 | jq '.genesis.data'
```

---

### nft-import

Import an NFT from a TXF JSON file.

**Usage:**

```
nft-import <json-file>
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `json-file` | string | Yes | Path to TXF JSON file |

**Sync Mode:** None required before. Calls `syncAfterWrite()` after.

**Algorithm:**

```
1. Parse file path from args[1]
2. Read and parse JSON file
3. getSphere()
4. sphere.nft.importNFT(txfToken) → NFTRef
5. Print imported NFT info
6. syncAfterWrite() → closeSphere()
```

**Output Format:**

```
NFT imported:
  Token ID:      a1b2c3d4e5f67890...
  Name:          Blue Sphere #1
  Collection:    b2c3d4e5f678... (CryptoSpheres)
  Edition:       1
  Status:        confirmed
```

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing file argument | `Usage: nft-import <json-file>` |
| File not found | `File not found: "<path>"` |
| Access denied | `Access denied: "<path>"` |
| Invalid JSON | `Invalid JSON in file "<path>"` |
| Wrong token type | `Token is not an NFT (wrong tokenType)` |
| Parse error | `Failed to parse NFT token data` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Import from a file
npm run cli -- nft-import ./my-nft.json

# Import from a received token file
npm run cli -- nft-import ./received-token.txf.json
```

---

## Verification Commands

### nft-verify

Verify an NFT's validity against the aggregator/oracle.

**Usage:**

```
nft-verify <tokenId|prefix>
```

**Positional Arguments:**

| Position | Name | Type | Required | Description |
|----------|------|------|----------|-------------|
| 1 | `tokenId` | string | Yes | Token ID or unique prefix |

**Sync Mode:** `ensureSync(sphere, 'nostr')`

**Algorithm:**

```
1. Parse tokenIdOrPrefix from args[1]
2. getSphere() → ensureSync(sphere, 'nostr')
3. Resolve token ID from prefix
4. sphere.nft.verifyNFT(tokenId) → NFTVerificationResult
5. Print verification result
6. closeSphere()
```

**Output Format:**

Success case:
```
NFT Verification:
  Token ID:    a1b2c3d4e5f67890...
  Valid:       true
  Spent:       false
  State Hash:  abc123def456...
```

Failure case:
```
NFT Verification:
  Token ID:    a1b2c3d4e5f67890...
  Valid:       false
  Spent:       true
  Errors:
    - Inclusion proof verification failed
    - State hash mismatch
```

The exit code reflects the verification result:
- Exit 0: valid and not spent
- Exit 1: invalid or spent (allows scripting with `&&` chains)

**Error Cases:**

| Condition | Message |
|-----------|---------|
| Missing argument | `Usage: nft-verify <tokenId or prefix>` |
| No match | `No NFT found matching prefix: <prefix>` |
| Ambiguous prefix | `Ambiguous prefix "<prefix>" matches <N> NFTs. Use more characters.` |
| NFT not found (internal) | `NFT <tokenId> not found in wallet` |
| Wrong token type | `Token <tokenId> is not an NFT` |
| NFT module not enabled | `NFT module not enabled. Initialize with NFT support.` |

**Examples:**

```bash
# Verify by prefix
npm run cli -- nft-verify a1b2c3

# Verify and check exit code in a script
npm run cli -- nft-verify a1b2c3 && echo "VALID" || echo "INVALID"

# Verify by full ID
npm run cli -- nft-verify a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890
```

---

## printUsage Integration

Add the following section to the `printUsage()` function in `cli/index.ts`, between the SWAPS section and the EVENT DAEMON section:

```
NFTs:
  nft-collection-create             Create a new NFT collection
  nft-collection-list               List collections
  nft-collection-info <id>          Show collection details
  nft-mint <name> <image>           Mint a single NFT
  nft-batch-mint <file>             Batch mint NFTs from JSON
  nft-send <id> <recipient>         Send an NFT
  nft-list                          List all NFTs in wallet
  nft-info <id>                     Show NFT details
  nft-history <id>                  Show NFT transfer history
  nft-export <id>                   Export NFT as TXF JSON
  nft-import <file>                 Import NFT from TXF JSON
  nft-verify <id>                   Verify NFT against aggregator
```

---

## Completions Integration

Add the following entries to the `getCompletionCommands()` array in `cli/index.ts`:

```typescript
{ name: 'nft-collection-create', description: 'Create a new NFT collection', flags: ['--max-supply', '--image', '--royalty', '--non-transferable', '--deterministic', '--external-url'] },
{ name: 'nft-collection-list', description: 'List collections', flags: ['--mine', '--json'] },
{ name: 'nft-collection-info', description: 'Show collection details' },
{ name: 'nft-mint', description: 'Mint a single NFT', flags: ['--collection', '--description', '--edition', '--total-editions', '--recipient', '--attribute', '--animation-url', '--external-url', '--background-color'] },
{ name: 'nft-batch-mint', description: 'Batch mint NFTs from JSON', flags: ['--collection'] },
{ name: 'nft-send', description: 'Send an NFT', flags: ['--memo'] },
{ name: 'nft-list', description: 'List all NFTs', flags: ['--collection', '--status', '--json'] },
{ name: 'nft-info', description: 'Show NFT details' },
{ name: 'nft-history', description: 'Show NFT transfer history' },
{ name: 'nft-export', description: 'Export NFT as TXF JSON', flags: ['--output'] },
{ name: 'nft-import', description: 'Import NFT from TXF JSON' },
{ name: 'nft-verify', description: 'Verify NFT against aggregator' },
```

---

## COMMAND_HELP Entries

Add the following entries to the `COMMAND_HELP` record in `cli/index.ts`. Each entry powers the `npm run cli -- help <command>` output.

```typescript
// --- NFTs ---
'nft-collection-create': {
  usage: 'nft-collection-create <name> <description> [--max-supply <n>] [--image <uri>] [--royalty <bps> <recipient>] [--non-transferable] [--deterministic] [--external-url <url>]',
  description: 'Create a new NFT collection definition. This is a local-only operation that registers the collection for minting. No on-chain transaction occurs. The collection ID is derived deterministically from its definition — the same inputs always produce the same ID.',
  flags: [
    { flag: '<name>', description: 'Collection name (1-128 chars)' },
    { flag: '<description>', description: 'Collection description (1-4096 chars, quote if spaces)' },
    { flag: '--max-supply <n>', description: 'Maximum number of NFTs (1-1,000,000). Omit for unlimited.' },
    { flag: '--image <uri>', description: 'Collection image URI (ipfs://, https://, data:)' },
    { flag: '--royalty <bps> <recipient>', description: 'Royalty in basis points (0-10000) and recipient address' },
    { flag: '--non-transferable', description: 'Mark as soulbound — NFTs cannot be transferred after minting' },
    { flag: '--deterministic', description: 'Use deterministic salt derivation — only the creator can mint valid token IDs' },
    { flag: '--external-url <url>', description: 'External URL for the collection' },
  ],
  examples: [
    'npm run cli -- nft-collection-create "My Art" "Digital artwork collection"',
    'npm run cli -- nft-collection-create "Badges" "Membership badges" --max-supply 1000 --non-transferable',
    'npm run cli -- nft-collection-create "Limited" "Rare items" --max-supply 100 --royalty 500 @treasury --deterministic',
  ],
  notes: [
    'Collection IDs are deterministic from the full definition (including creation timestamp). Re-running the command produces a new collection with a different timestamp and therefore a different ID.',
    'Use --deterministic for controlled collections where only the creator should mint.',
  ],
},

'nft-collection-list': {
  usage: 'nft-collection-list [--mine] [--json]',
  description: 'List all NFT collections known to this wallet. Includes both collections you created and collections from received NFTs.',
  flags: [
    { flag: '--mine', description: 'Show only collections created by this wallet' },
    { flag: '--json', description: 'Output as JSON array instead of table' },
  ],
  examples: [
    'npm run cli -- nft-collection-list',
    'npm run cli -- nft-collection-list --mine',
    'npm run cli -- nft-collection-list --json',
  ],
},

'nft-collection-info': {
  usage: 'nft-collection-info <collectionId or prefix>',
  description: 'Show detailed information about a specific collection, including name, creator, supply, royalty, and transferability settings.',
  flags: [
    { flag: '<collectionId or prefix>', description: 'Full 64-char collection ID or a unique prefix' },
  ],
  examples: [
    'npm run cli -- nft-collection-info a1b2c3',
    'npm run cli -- nft-collection-info a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890',
  ],
},

'nft-mint': {
  usage: 'nft-mint <name> <image-uri> [--collection <id>] [--description <text>] [--edition <n>] [--total-editions <n>] [--recipient <addr>] [--attribute <trait:value>]...',
  description: 'Mint a single NFT on-chain. Can be standalone (no collection) or part of a collection. Minting submits a commitment to the aggregator and waits for an inclusion proof.',
  flags: [
    { flag: '<name>', description: 'NFT name (1-256 chars, quote if spaces)' },
    { flag: '<image-uri>', description: 'Primary image URI (ipfs://, https://, data:)' },
    { flag: '--collection <id>', description: 'Collection ID or prefix — mint into this collection' },
    { flag: '--description <text>', description: 'NFT description (quote if spaces)' },
    { flag: '--edition <n>', description: 'Explicit edition number (collection only, otherwise auto-increment)' },
    { flag: '--total-editions <n>', description: 'Total planned editions (informational)' },
    { flag: '--recipient <addr>', description: 'Mint to another wallet (@nametag, DIRECT://, pubkey)' },
    { flag: '--attribute <trait:value>', description: 'Add a trait attribute (repeatable, e.g., --attribute "Color:Blue")' },
    { flag: '--animation-url <uri>', description: 'Animation/multimedia URI' },
    { flag: '--external-url <url>', description: 'External URL' },
    { flag: '--background-color <hex>', description: 'Background color (6-char hex, no # prefix)' },
  ],
  examples: [
    'npm run cli -- nft-mint "My Art" "ipfs://QmImageHash"',
    'npm run cli -- nft-mint "Sphere #1" "ipfs://QmHash" --collection a1b2c3 --attribute "Color:Blue"',
    'npm run cli -- nft-mint "Gift" "ipfs://QmGift" --recipient @alice --description "A gift NFT"',
  ],
  notes: [
    'Minting requires an oracle (aggregator) connection.',
    '--attribute can be specified multiple times for different traits.',
    'Edition numbers auto-increment within a collection unless --edition is set explicitly.',
  ],
},

'nft-batch-mint': {
  usage: 'nft-batch-mint <json-file> [--collection <id>]',
  description: 'Mint multiple NFTs from a JSON manifest file. Each item in the array defines one NFT. Maximum 50 items per batch. Partial failures are reported — successfully minted NFTs are not rolled back.',
  flags: [
    { flag: '<json-file>', description: 'Path to JSON file containing an array of NFT definitions' },
    { flag: '--collection <id>', description: 'Collection ID or prefix — applies to all items in the batch' },
  ],
  examples: [
    'npm run cli -- nft-batch-mint ./nfts.json',
    'npm run cli -- nft-batch-mint ./nfts.json --collection a1b2c3',
  ],
  notes: [
    'JSON format: [{ "name": "...", "image": "...", "attributes": [...] }, ...]',
    'Maximum 50 items per batch (NFT_MAX_BATCH_SIZE).',
    'Partial failures: successfully minted NFTs remain minted; errors are reported per item.',
  ],
},

'nft-send': {
  usage: 'nft-send <tokenId or prefix> <recipient> [--memo <text>]',
  description: 'Send an NFT to another wallet. The NFT is transferred atomically (cannot be split). Soulbound (non-transferable) NFTs cannot be sent.',
  flags: [
    { flag: '<tokenId or prefix>', description: 'Full token ID or unique prefix' },
    { flag: '<recipient>', description: 'Recipient: @nametag, DIRECT://..., chain pubkey, or alpha1...' },
    { flag: '--memo <text>', description: 'Transfer memo (max 256 chars)' },
  ],
  examples: [
    'npm run cli -- nft-send a1b2c3 @alice',
    'npm run cli -- nft-send a1b2c3 @bob --memo "Gift for you"',
    'npm run cli -- nft-send a1b2c3d4e5f67890 "DIRECT://abc123..."',
  ],
  notes: [
    'NFTs are atomic — they cannot be split or partially transferred.',
    'Non-transferable (soulbound) NFTs will produce an error.',
  ],
},

'nft-list': {
  usage: 'nft-list [--collection <id>] [--status <confirmed|pending>] [--json]',
  description: 'List all NFTs in the wallet. Can be filtered by collection and status. Operates on the in-memory index — no storage reads required.',
  flags: [
    { flag: '--collection <id>', description: 'Filter by collection ID or prefix' },
    { flag: '--status <status>', description: 'Filter by token status: "confirmed" or "pending"' },
    { flag: '--json', description: 'Output as JSON array instead of table' },
  ],
  examples: [
    'npm run cli -- nft-list',
    'npm run cli -- nft-list --collection a1b2c3',
    'npm run cli -- nft-list --status confirmed --json',
  ],
},

'nft-info': {
  usage: 'nft-info <tokenId or prefix>',
  description: 'Show full details for a single NFT, including all metadata fields, collection definition, edition info, minter, and token status.',
  flags: [
    { flag: '<tokenId or prefix>', description: 'Full token ID or unique prefix' },
  ],
  examples: [
    'npm run cli -- nft-info a1b2c3',
    'npm run cli -- nft-info a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890',
  ],
},

'nft-history': {
  usage: 'nft-history <tokenId or prefix>',
  description: 'Show the ownership and transfer history for an NFT. Events are listed chronologically: mint, transfer_in, transfer_out.',
  flags: [
    { flag: '<tokenId or prefix>', description: 'Full token ID or unique prefix' },
  ],
  examples: [
    'npm run cli -- nft-history a1b2c3',
  ],
},

'nft-export': {
  usage: 'nft-export <tokenId or prefix> [--output <file>]',
  description: 'Export an NFT as a complete TXF JSON object. By default, prints to stdout (suitable for piping to jq or redirecting to a file). With --output, writes directly to the specified file.',
  flags: [
    { flag: '<tokenId or prefix>', description: 'Full token ID or unique prefix' },
    { flag: '--output <file>', description: 'Write TXF JSON to file instead of stdout' },
  ],
  examples: [
    'npm run cli -- nft-export a1b2c3',
    'npm run cli -- nft-export a1b2c3 --output ./my-nft.json',
    'npm run cli -- nft-export a1b2c3 | jq .genesis.data',
  ],
},

'nft-import': {
  usage: 'nft-import <json-file>',
  description: 'Import an NFT from a TXF JSON file. Validates that the token type is NFT, parses metadata, registers the collection if unknown, and stores the token. Idempotent: importing the same token twice returns the existing NFT.',
  flags: [
    { flag: '<json-file>', description: 'Path to TXF JSON file containing the NFT token' },
  ],
  examples: [
    'npm run cli -- nft-import ./my-nft.json',
    'npm run cli -- nft-import ./received-token.txf.json',
  ],
},

'nft-verify': {
  usage: 'nft-verify <tokenId or prefix>',
  description: 'Verify an NFT against the aggregator/oracle. Checks inclusion proof validity and whether the token has been spent (transferred away). Exits with code 0 if valid and unspent, code 1 otherwise.',
  flags: [
    { flag: '<tokenId or prefix>', description: 'Full token ID or unique prefix' },
  ],
  examples: [
    'npm run cli -- nft-verify a1b2c3',
    'npm run cli -- nft-verify a1b2c3 && echo "VALID" || echo "INVALID"',
  ],
},
```

---

## Command Summary Table

| Command | Sync Mode | Writes | Module Method |
|---------|-----------|--------|---------------|
| `nft-collection-create` | none | yes (syncAfterWrite) | `nft.createCollection()` |
| `nft-collection-list` | nostr | no | `nft.getCollections()` |
| `nft-collection-info` | nostr | no | `nft.getCollection()` |
| `nft-mint` | full | yes (syncAfterWrite) | `nft.mintNFT()` |
| `nft-batch-mint` | full | yes (syncAfterWrite) | `nft.batchMintNFT()` |
| `nft-send` | full | yes (syncAfterWrite) | `nft.sendNFT()` |
| `nft-list` | nostr | no | `nft.getNFTs()` |
| `nft-info` | nostr | no | `nft.getNFT()` |
| `nft-history` | nostr | no | `nft.getNFTHistory()` |
| `nft-export` | nostr | no | `nft.exportNFT()` |
| `nft-import` | none | yes (syncAfterWrite) | `nft.importNFT()` |
| `nft-verify` | nostr | no | `nft.verifyNFT()` |

---

## Sphere.init Integration

The `getSphere()` function must pass `nft: true` to `Sphere.init()` to enable the NFT module:

```typescript
const result = await Sphere.init({
  ...initProviders,
  autoGenerate: options?.autoGenerate,
  mnemonic: options?.mnemonic,
  nametag: options?.nametag,
  market: true,
  groupChat: true,
  accounting: true,
  swap: true,
  nft: true,   // <-- add this
});
```

The NFT module is then accessible as `sphere.nft`. If NFT support is not enabled, `sphere.nft` throws `SphereError('NFT_NOT_INITIALIZED')`.
