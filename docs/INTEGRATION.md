# Sphere SDK Integration Guide

> **Quick Start**: For a fast setup, see the platform-specific guides:
> - [Browser Quick Start](./QUICKSTART-BROWSER.md) - Web applications
> - [Node.js Quick Start](./QUICKSTART-NODEJS.md) - Server-side / CLI
> - [Connect Protocol](./CONNECT.md) - Wallet ↔ dApp communication
>
> This document covers advanced integration patterns and custom provider implementations.

## Table of Contents

1. [Setup](#setup)
2. [Wallet Operations](#wallet-operations)
3. [L3 Payments](#l3-payments)
4. [Operator Escape Hatches (UXF)](#operator-escape-hatches-uxf)
5. [Payment Requests](#payment-requests)
6. [L1 Payments](#l1-payments)
7. [Communications](#communications)
8. [Invoicing / Accounting](#invoicing--accounting)
9. [Custom Providers](#custom-providers)
10. [Events](#events)
11. [Error Handling](#error-handling)
12. [Testing](#testing)

---

## Setup

### Recommended: Factory Functions

The easiest way to set up providers is using the factory functions:

```typescript
// Browser (requires CORS proxy for free CoinGecko API — see "CORS Proxy" section below)
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
const providers = createBrowserProviders({
  network: 'testnet',
  price: {
    platform: 'coingecko',
    baseUrl: '/api/coingecko',  // CORS proxy path (see below)
  },
});

// Node.js (no proxy needed)
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet',
  tokensDir: './tokens',
  price: { platform: 'coingecko', apiKey: 'CG-xxx' },  // Optional
});
```

### Initialize Wallet

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';

// Sphere.init() is the main entry point — it creates OR loads a wallet automatically
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,  // Generate mnemonic if no wallet exists
  nametag: 'alice',    // Optional: register @alice nametag
  password: 'secret',  // Optional: encrypt mnemonic (plaintext if omitted)
});

if (created && generatedMnemonic) {
  // First launch — show mnemonic to user for backup
  console.log('Save this mnemonic:', generatedMnemonic);
}

// Wallet is ready — L3 and L1 payments are available
console.log('Address:', sphere.identity?.directAddress);  // DIRECT://... (L3)
console.log('L1:', sphere.identity?.l1Address);           // alpha1... (L1)
```

---

## Wallet Operations

### Check if Wallet Exists

```typescript
const exists = await Sphere.exists(providers.storage);
```

### Create or Load Wallet (Recommended)

```typescript
// Sphere.init() handles both creation and loading automatically
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,  // Generate mnemonic if wallet doesn't exist
  nametag: 'alice',    // Optional: register nametag
});

if (created && generatedMnemonic) {
  console.log('Backup these words:', generatedMnemonic);
}
```

### Import from Mnemonic

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'abandon abandon abandon ...',
});
```

### Get Identity

```typescript
const identity = sphere.identity;

console.log('L1 Address:', identity.l1Address);       // alpha1...
console.log('Chain Pubkey:', identity.chainPubkey);   // 33-byte compressed secp256k1
console.log('Direct Address:', identity.directAddress); // DIRECT://... (L3)
console.log('Nametag:', identity.nametag);            // e.g., 'alice'
```

### Clear Wallet

```typescript
await Sphere.clear({ storage: providers.storage, tokenStorage: providers.tokenStorage });
```

### Multi-Address Derivation

SDK2 supports HD (Hierarchical Deterministic) address derivation following BIP32/BIP44 standards.

```typescript
// Derive additional receiving addresses
const addr1 = sphere.deriveAddress(1);  // m/44'/0'/0'/0/1
const addr2 = sphere.deriveAddress(2);  // m/44'/0'/0'/0/2

console.log('Address 1:', addr1.address);
console.log('Address 2:', addr2.address);

// Derive change addresses
const change0 = sphere.deriveAddress(0, true);  // m/44'/0'/0'/1/0

// Derive at arbitrary path
const custom = sphere.deriveAddressAtPath("m/44'/0'/0'/0/10");

// Get multiple addresses at once
const addresses = sphere.deriveAddresses(5);  // First 5 receiving addresses
const allAddrs = sphere.deriveAddresses(5, true);  // 5 receiving + 5 change

// Check derivation capability
if (sphere.hasMasterKey()) {
  console.log('HD derivation available');
  console.log('Base path:', sphere.getBasePath());
}
```

Each derived address has its own keypair but shares the same master seed:

```typescript
interface AddressInfo {
  privateKey: string;  // Unique per address
  publicKey: string;   // Unique per address
  address: string;     // alpha1... format
  path: string;        // Full BIP32 path
  index: number;       // Address index
}
```

### Tracked Addresses

The SDK tracks which addresses have been activated (via create, switchToAddress, registerNametag). This lets UI display the list of used addresses with metadata.

```typescript
// Get all active (non-hidden) addresses
const addresses = sphere.getActiveAddresses();
for (const addr of addresses) {
  console.log(`#${addr.index}: ${addr.l1Address}`);
  console.log(`  DIRECT: ${addr.directAddress}`);
  console.log(`  Nametag: ${addr.nametag ?? 'none'}`);
  console.log(`  Created: ${new Date(addr.createdAt)}`);
}

// Switch to a new address (auto-tracked)
await sphere.switchToAddress(2);

// Register nametag for current address
await sphere.registerNametag('bob');

// Hide an address from UI
await sphere.setAddressHidden(1, true);

// Get all including hidden
const all = sphere.getAllTrackedAddresses();

// Get single address
const addr = sphere.getTrackedAddress(0);

// Listen for new address activations
sphere.on('address:activated', ({ address }) => {
  console.log(`New address tracked: #${address.index}`);
});

sphere.on('address:hidden', ({ index, addressId }) => {
  console.log(`Address #${index} hidden`);
});
```

---

## L3 Payments

L3 is the primary payment layer. Tokens are transferred peer-to-peer via Nostr with state proofs committed to the Unicity aggregator.

### Typical Wallet Flow

```typescript
// 1. Init wallet
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true, nametag: 'alice' });

// 2. Check what tokens we have
const assets = await sphere.payments.getAssets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
}

// 3. Send tokens
const result = await sphere.payments.send({
  recipient: '@bob',
  amount: '1000000',
  coinId: 'UCT',
});

// 4. Listen for incoming transfers
sphere.on('transfer:incoming', (transfer) => {
  console.log(`Received from ${transfer.senderNametag}: ${transfer.tokens.length} tokens`);
});

// 5. Sync with remote storage (IPFS, etc.)
await sphere.payments.sync();

// 6. View history
const history = sphere.payments.getHistory();

// 7. Cleanup
await sphere.destroy();
```

### Get Balance & Assets

`getBalance()` is **synchronous** and returns `TokenBalance[]` — one entry per coin type.

```typescript
// Get per-coin balances with confirmed/unconfirmed breakdown (synchronous)
const balances = sphere.payments.getBalance();

for (const bal of balances) {
  console.log(`${bal.symbol}:`);
  console.log(`  Confirmed:   ${bal.confirmedAmount} (${bal.confirmedTokenCount} tokens)`);
  console.log(`  Unconfirmed: ${bal.unconfirmedAmount} (${bal.unconfirmedTokenCount} tokens)`);
  console.log(`  Total:       ${bal.totalAmount}`);
}

// Filter to a single coin
const uctBalances = sphere.payments.getBalance('UCT_COIN_ID_HEX');

// Total portfolio value in USD (null if PriceProvider not configured)
const totalUsd = await sphere.payments.getFiatBalance();
console.log('Total USD:', totalUsd); // number | null

// Get assets grouped by coin, with price data
const assets = await sphere.payments.getAssets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  console.log(`  Price: $${asset.priceUsd ?? 'N/A'}`);
  console.log(`  Value: $${asset.fiatValueUsd?.toFixed(2) ?? 'N/A'}`);
  console.log(`  24h change: ${asset.change24h ?? 'N/A'}%`);
}

// Get assets for a specific coin
const uctAssets = await sphere.payments.getAssets('UCT');
```

### Get Individual Tokens

```typescript
// All tokens
const tokens = sphere.payments.getTokens();

for (const token of tokens) {
  console.log(`Token ${token.id}: ${token.amount} ${token.symbol}`);
  console.log(`  Coin ID: ${token.coinId}`);
}

// Filter by coin
const uctTokens = sphere.payments.getTokens({ coinId: 'UCT' });

// Get specific token by ID
const token = sphere.payments.getToken('token-id-123');
```

### Send Tokens

```typescript
// Send to nametag (resolved via Nostr)
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  memo: 'Payment for coffee',
});

// Send to DIRECT address
const result = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId: 'UCT',
});

// Send to chain pubkey (33-byte compressed secp256k1)
const result = await sphere.payments.send({
  recipient: '02abc123...',
  amount: '500000',
  coinId: 'UCT',
});

// Check result
console.log('Transfer ID:', result.id);
console.log('Status:', result.status);  // 'pending' | 'submitted' | 'delivered' | 'completed' | 'failed'
if (result.error) {
  console.error('Error:', result.error);
}
```

**TransferRequest fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `recipient` | Yes | `@nametag`, `DIRECT://...`, chain pubkey, or `alpha1...` address |
| `amount` | Yes | Primary asset amount, in smallest unit (string) |
| `coinId` | Yes | Primary asset coin ID (e.g., `'UCT'`) |
| `additionalAssets` | No | Multi-asset extension. Array of additional assets — each entry is either a fungible coin (`{kind:'coin', coinId, amount}`) or a whole-token / NFT reference (`{kind:'nft', tokenId}`). All `coinId`s (including the primary) must be distinct; all `tokenId`s in NFT entries must be distinct. See examples below. |
| `memo` | No | Optional message to recipient |
| `transferMode` | No | `'instant'` (default) or `'conservative'` — see Transfer Modes section |
| `allowPendingTokens` | No | Default `false`. When `true`, the source-token selector may pick `pending` tokens after exhausting `valid` ones (chain mode) |
| `confirmNftPending` | Conditionally | Default `false`. Required `true` when sending NFT entries with `allowPendingTokens: true` AND any NFT source has unfinalized predecessor txs. Without it, the call rejects with `NFT_PENDING_REQUIRES_CONFIRMATION`. NFT cascades are irrecoverable (no fungible replacement) — see "Pending NFT cascade caveat" below. |

**Multi-coin transfer example** (deliver UCT + USDU + ALPHA in one call):

```typescript
const result = await sphere.payments.send({
  recipient: '@bob',
  // Primary asset (legacy single-coin fields remain required):
  coinId: 'UCT',
  amount: '1000000',
  // Additional assets — multi-coin via discriminated union:
  additionalAssets: [
    { kind: 'coin', coinId: 'USDU', amount: '500000' },
    { kind: 'coin', coinId: 'ALPHA', amount: '250000' },
  ],
  memo: 'Multi-asset payment',
});
// All three asset deliveries are bundled in a single UXF transfer; the
// recipient receives one or more child tokens carrying exactly
// (UCT,1000000), (USDU,500000), (ALPHA,250000). All other coin balances
// in the sender's source tokens stay with the sender as change.
```

**Mixed coin + NFT transfer example** (deliver UCT + a specific NFT):

```typescript
const result = await sphere.payments.send({
  recipient: '@bob',
  // Primary asset is always a coin (backward-compat slot):
  coinId: 'UCT',
  amount: '1000000',
  // Additional assets can mix coins and NFTs:
  additionalAssets: [
    { kind: 'nft', tokenId: '0xabc123...the-nft-token-id...' },
  ],
  memo: 'Coin + NFT bundle',
});
// The recipient receives:
//   - One or more child tokens carrying (UCT, 1000000) (split from sender's
//     coin tokens as usual);
//   - The NFT token transferred whole — its tokenId stays the same; only its
//     current state's predicate changes to bind to @bob.
```

**NFT-only transfer** (no coin component): the type signature retains `coinId`/`amount` as required for v1.0 backward compatibility; the implementation wave widens them to optional. **Until the widening releases, NFT-only sends are not expressible against the v1.0 type signature** — defer to the widening release. Do NOT fabricate a placeholder coin slice (any non-zero amount would silently transfer real coin value; the spec abolishes the placeholder convention per UXF-TRANSFER-PROTOCOL §4.1 — coin amounts MUST be > 0 with no exceptions). Once optional, NFT-only sends omit the primary slot entirely:

```typescript
// Post-widening (NFT-only):
await sphere.payments.send({
  recipient: '@bob',
  // coinId / amount omitted — NFT-only:
  additionalAssets: [
    { kind: 'nft', tokenId: '0xabc123...' },
  ],
});
```

**NFT model** (canonical, per UXF-TRANSFER-PROTOCOL §4.1): an NFT is a token with empty/null `coinData`, transferred whole-token. NFT and coin tokens are class-disjoint — no single token carries both. NFT transfers preserve the source `tokenId`; coin transfers split via mint, producing fresh `tokenId`s for recipient and change.

**Pending NFT cascade caveat**: when `allowPendingTokens: true` is set AND any NFT target's source has unfinalized predecessor txs in its history, you MUST pass `confirmNftPending: true` to acknowledge the cascade-asymmetry risk (otherwise the call rejects with `NFT_PENDING_REQUIRES_CONFIRMATION`). Finalized (valid) NFT sources do NOT require the confirmation even with `allowPendingTokens: true` — the requirement is gated on the NFT source actually being pending. A cascaded coin can be recovered with fungible value from elsewhere; a cascaded NFT identity is irrecoverable.

Single-coin callers omitting `additionalAssets` behave identically to prior versions of the SDK — the field is purely additive.

### Receive Tokens

Incoming tokens arrive automatically via Nostr. Subscribe to the event:

```typescript
sphere.on('transfer:incoming', (transfer) => {
  console.log('Sender:', transfer.senderPubkey);
  console.log('Sender nametag:', transfer.senderNametag);
  console.log('Tokens:', transfer.tokens.length);
  console.log('Received at:', new Date(transfer.receivedAt));
});
```

### Sync & Refresh

```typescript
// Sync with all remote storage providers (IPFS, etc.)
// Merges local and remote token data
const syncResult = await sphere.payments.sync();
console.log(`Sync: +${syncResult.added} -${syncResult.removed}`);

// Validate tokens against the aggregator
const { valid, invalid } = await sphere.payments.validate();
console.log(`Valid: ${valid.length}, Invalid: ${invalid.length}`);
```

### IPFS Sync Configuration

Enable decentralized IPFS/IPNS token backup (works on both browser and Node.js):

```typescript
// Enable at initialization
const providers = createBrowserProviders({
  network: 'testnet',
  tokenSync: {
    ipfs: { enabled: true },
  },
});
```

Add IPFS sync at runtime:

```typescript
import { createBrowserIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';
// For Node.js: import { createNodeIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs/ipfs';

const ipfsProvider = createBrowserIpfsStorageProvider({ debug: true });
await sphere.addTokenStorageProvider(ipfsProvider);

// Sync merges local and remote token data
const result = await sphere.payments.sync();
console.log(`Added: ${result.added}, Removed: ${result.removed}`);
```

See [IPFS Storage Guide](./IPFS-STORAGE.md) for full configuration, caching, merge rules, and troubleshooting.

### Transaction History

```typescript
const history = sphere.payments.getHistory();

for (const entry of history) {
  console.log(`${entry.type}: ${entry.amount} ${entry.coinId}`);
  console.log(`  Date: ${new Date(entry.timestamp)}`);
  if (entry.recipientNametag) {
    console.log(`  To: @${entry.recipientNametag}`);
  }
}
```

### Pending Transfers

```typescript
// Get transfers that are still in progress
const pending = sphere.payments.getPendingTransfers();
for (const transfer of pending) {
  console.log(`${transfer.id}: ${transfer.status}`);
}
```

### Peer Resolution

```typescript
// Resolve any identifier to PeerInfo (nametag, address, pubkey)
const peer = await sphere.resolve('@alice');
if (peer) {
  console.log('Chain pubkey:', peer.chainPubkey);
  console.log('Direct address:', peer.directAddress);
  console.log('L1 address:', peer.l1Address);
  console.log('Nametag:', peer.nametag);
}
```

### Price Provider (Optional)

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

// Set or replace PriceProvider at runtime
sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: userProvidedKey,  // Optional for free tier
  baseUrl: '/api/coingecko',  // CORS proxy for browser (see below)
}));
```

Without a PriceProvider, `getBalance()` returns `null` and price fields in `getAssets()` are `null`. All other functionality works normally.

**CORS Proxy (Browser only):** CoinGecko's free API lacks CORS headers. Add a proxy in development:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api/coingecko': {
        target: 'https://api.coingecko.com/api/v3',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coingecko/, ''),
      },
    },
  },
});
```

Then pass `baseUrl: '/api/coingecko'` in the `price` config. In production, use Nginx or a Cloudflare Worker as a reverse proxy. CoinGecko Pro API supports CORS natively and doesn't require a proxy.

Node.js environments are not subject to CORS — no proxy needed.

### Get Tokens

`getTokens()` is **synchronous** and returns `Token[]`.

```typescript
const tokens = sphere.payments.getTokens();

for (const token of tokens) {
  console.log(`Token ${token.id}: ${token.amount} ${token.symbol}`);
  console.log(`  Status: ${token.status}`);
  // Possible statuses: 'pending' | 'submitted' | 'confirmed' | 'transferring' | 'spent' | 'invalid'
}

// Filter by status — e.g., get only unconfirmed tokens
const unconfirmed = sphere.payments.getTokens({ status: 'submitted' });
```

### Send Tokens

`send()` auto-selects the optimal transfer path (whole-token NOSTR-FIRST or instant split V5).

```typescript
// Send to nametag (auto address mode, instant transfer — default)
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  memo: 'Payment for coffee',
});

// Send with conservative mode (collect all proofs first, then deliver)
const result2 = await sphere.payments.send({
  recipient: '@bob',
  amount: '500000',
  coinId: 'UCT',
  transferMode: 'conservative',  // 'instant' (default) | 'conservative'
});

// Send with explicit address mode
const result3 = await sphere.payments.send({
  recipient: '@bob',
  amount: '500000',
  coinId: 'UCT',
  addressMode: 'direct',  // 'auto' | 'direct' | 'proxy'
});

// Check result
if (result.status === 'completed') {
  console.log('Transfer completed, details:', result.tokenTransfers);
} else {
  console.error('Transfer failed:', result.error);
}
```

**Transfer Modes:**

| Mode | Description |
|------|-------------|
| `'instant'` (default) | Sends tokens via Nostr immediately. Receiver resolves proofs in background. Fastest sender experience (~2-3s for splits). |
| `'conservative'` | Collects all aggregator proofs first, then sends fully finalized tokens. Slower but receiver gets immediately usable tokens. |

### Receive Tokens

Incoming tokens are received automatically via the persistent Nostr subscription. Subscribe to events:

```typescript
sphere.on('transfer:incoming', (transfer) => {
  console.log('Received tokens from:', transfer.senderPubkey);
  for (const token of transfer.tokens) {
    console.log(`  ${token.amount} ${token.symbol} (status: ${token.status})`);
  }
});
```

For batch/CLI applications that need explicit receive (one-shot query instead of persistent subscription):

```typescript
// Fetch and process all pending incoming transfers from Nostr
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);

// With per-transfer callback
await sphere.payments.receive(undefined, (transfer) => {
  console.log(`Received ${transfer.tokens.length} tokens`);
});
```

### Reload Tokens

To reload tokens from storage (e.g., after external changes):

```typescript
await sphere.payments.load();
```

---

## Operator Escape Hatches (UXF)

The UXF transfer protocol pins state into one of three buckets — active pool (`valid` / `pending`), `_invalid` (failed validation), or `_audit` (forensic). Per §5.6, the active state cannot regress to `_invalid` once it has reached `valid`; per §6.1.1, a child token whose source parent is invalid is `parent-rejected` and stays in `_invalid` until the parent is unblocked. These two rules are intentionally one-way to keep merge semantics deterministic across CRDT replicas.

The escape hatches are the **only** legal breach of those rules. Operators use them when:

- A token is stuck in `_invalid` because the recipient's local view never received an inclusion proof, but the operator can produce the proof out-of-band (a relay re-publish, a manual fetch from the aggregator, a recovery dump).
- After flipping a parent token back to the active pool, the operator wants to revisit each `parent-rejected` child and re-run §5.3 [B]/[C]/[E] now that the parent is once again `valid`.

Both methods are off the hot path — they are **operator-driven**, not auto-fired by the wallet. They emit `transfer:override-applied` (audit trail) on success of cases 5/6 and stamp `overrideApplied: true` / `overrideAppliedAt` / `overrideAppliedBy` onto the manifest entry so the override survives every future CRDT merge.

### `payments.importInclusionProof()`

Accept an inclusion proof from outside the normal aggregator path and apply it to local state. Routes through ten sub-cases per UXF-TRANSFER-PROTOCOL §6.3.

```typescript
const result = await sphere.payments.importInclusionProof(
  addr,             // address scope (DIRECT://...)
  tokenId,          // canonical token id
  {
    requestId: '...',         // hex aggregator commitment requestId
    transactionHash: '...',   // 68-char imprint hex
    authenticator: '...',     // authenticator hex
    proof: rawProofBytes,     // opaque — handed to trustBase verifier
  },
  {
    allowInvalidOverride: true,    // REQUIRED to flip from `_invalid` (cases 5/6)
    operatorPubkey: '02ab...',     // optional — stamped into audit trail
    // currentTime: 1714000000000  // optional — tests use deterministic clocks
  },
);

if (result.ok) {
  console.log('transition:', result.transition);
  // 'pending-still' | 'pending→valid' | 'pending→unspendable'
  // | 'invalid→valid' | 'invalid→pending'
} else {
  console.error('reason:', result.reason);
  // 'no-such-token' | 'tokenId-already-valid' | 'tokenId-in-invalid'
  // | 'proof-trustbase-failed' | 'proof-not-anchored' | 'requestid-mismatch'
}
```

**§6.3 case decision table.** The 10 sub-cases the importer routes through:

| # | Token state | Override flag | Proof verify | Queue match | Outcome | Result |
|---|-------------|---------------|--------------|-------------|---------|--------|
| 1 | not in pool / not in `_invalid` / not in `_audit` | n/a | not run | n/a | reject — nothing to apply against | `{ok: false, reason: 'no-such-token'}` |
| 2 | already `valid` | n/a | not run | n/a | idempotent no-op | `{ok: true, transition: 'pending-still'}` |
| 3 | `pending`, proof matches OUTSTANDING `requestId` | n/a | OK | live entry | graft proof; pending → valid if last outstanding | `{ok: true, transition: 'pending→valid'}` or `'pending-still'` |
| 4a | `pending`, proof matches a `completedRequestIds` entry | n/a | OK | completed/`attached` | already-attached | `{ok: true, transition: 'pending-still'}` |
| 4b | `pending`, proof matches NO outstanding OR completed entry | n/a | OK | none | reject — proof is for a different requestId | `{ok: false, reason: 'requestid-mismatch'}` |
| 5 | `_invalid`, EXACTLY ONE hard-failed queue entry matches | `true` | OK | one hard-fail | move to active pool with `manifest.status='valid'` | `{ok: true, transition: 'invalid→valid'}` |
| 6 | `_invalid`, MULTIPLE hard-failed entries (chain mode) | `true` | OK | one of K hard-fails | move to active pool with `status='pending'`; re-queue K-1 entries | `{ok: true, transition: 'invalid→pending'}` |
| 7 | `_invalid`, override flag missing | `false` (default) | OK | n/a | reject — silent default would breach §5.6 monotonicity | `{ok: false, reason: 'tokenId-in-invalid'}` |
| 8 | any | n/a | `PATH_NOT_INCLUDED` | n/a | proof was not anchored on the aggregator | `{ok: false, reason: 'proof-not-anchored'}` |
| 9 | any | n/a | `PATH_INVALID` / `NOT_AUTHENTICATED` / `THROWN` | n/a | trustBase did not accept the proof (most likely stale local trustBase) | `{ok: false, reason: 'proof-trustbase-failed'}` |

Cases 5 and 6 are the only paths that mutate the §5.6 monotonicity invariant. They emit `transfer:override-applied` exactly once per success, with the previous `DispositionReason` and the transition kind, so an operator console can render an audit row.

### `payments.revalidateCascadedChildren()`

Operator-explicit cascade reversal. After `importInclusionProof()` flips a parent token back to the active pool, cascaded children that were previously `parent-rejected` do **not** auto-revalidate — `revalidateCascadedChildren()` is the next step.

```typescript
// 1. Operator imported a fresh proof and the parent is now `valid`.
const importResult = await sphere.payments.importInclusionProof(
  addr,
  parentTokenId,
  proof,
  { allowInvalidOverride: true, operatorPubkey: opPubkey },
);

if (importResult.ok && importResult.transition === 'invalid→valid') {
  // 2. Walk every cascaded child and re-run §5.3 [B]/[C]/[E].
  const result = await sphere.payments.revalidateCascadedChildren(
    addr,
    parentTokenId,
  );

  console.log('checked:', result.checked);              // children inspected
  console.log('revalidated:', result.revalidated);      // moved back to active pool
  console.log('stillInvalid:', result.stillInvalid);    // failed for an unrelated reason
  console.log('cycleDefenseFired:', result.cycleDefenseFired); // depth/visited-set hits
}
```

**Behavior.** The runner walks every child whose manifest entry has `splitParent === parentTokenId` AND `invalidReason === 'parent-rejected'`, asks the injected validator to re-run §5.3, and recurses transitively into successfully-revalidated children's children. Bounded depth (`MAX_CHAIN_DEPTH` = 64) and a per-call-stack visited set defend against corrupted-manifest cycles (W32). Two concurrent revalidations for different parents do not share state.

**Errors.** Both methods throw `SphereError` with code `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` if the bootstrap layer has not installed the importer / runner. The Sphere bootstrap installs them automatically when the UXF features are wired; in legacy environments, the methods surface a clear error rather than silently no-oping.

---

## Instant Transfers & Token Resolution

### How Transfers Work Internally

When you call `send()`, the SDK automatically selects the optimal path:

1. **Whole-token transfers** (no split needed): Sends the commitment and source token via Nostr immediately, then submits the commitment to the aggregator in the background. The recipient polls for the inclusion proof and finalizes.

2. **Split transfers** (exact amount unavailable): Uses the Instant Split V5 flow — burns the source token, creates mint commitments for the payment and change amounts, and sends the bundle via Nostr. The recipient saves the token as unconfirmed and resolves proofs lazily.

### Receiving Unconfirmed Tokens

V5 split tokens arrive as unconfirmed (status: `'submitted'`). They are immediately usable for balance display but require proof resolution before they can be spent.

```typescript
sphere.on('transfer:incoming', (transfer) => {
  for (const token of transfer.tokens) {
    if (token.status === 'submitted') {
      console.log('Unconfirmed token received — will resolve automatically');
    } else if (token.status === 'confirmed') {
      console.log('Fully confirmed token received');
    }
  }
});
```

### Checking Confirmed vs Unconfirmed Balance

```typescript
const balances = sphere.payments.getBalance();
for (const bal of balances) {
  if (BigInt(bal.unconfirmedAmount) > 0n) {
    console.log(`${bal.symbol}: ${bal.unconfirmedAmount} awaiting confirmation`);
  }
}
```

### Resolving Unconfirmed Tokens

`resolveUnconfirmed()` is called automatically by `load()`, but you can call it explicitly:

```typescript
const result = await sphere.payments.resolveUnconfirmed();
console.log(`Resolved: ${result.resolved}, Still pending: ${result.stillPending}, Failed: ${result.failed}`);

for (const detail of result.details) {
  console.log(`  Token ${detail.tokenId}: stage=${detail.stage}, status=${detail.status}`);
}
```

### Waiting for Full Confirmation

To wait until all tokens are confirmed, poll `resolveUnconfirmed()`:

```typescript
async function waitForAllConfirmed(maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await sphere.payments.resolveUnconfirmed();
    if (result.stillPending === 0) {
      console.log(`All tokens confirmed (${result.resolved} resolved)`);
      return;
    }
    console.log(`Still pending: ${result.stillPending}`);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('Timeout waiting for confirmation');
}
```

---

## Payment Requests

Payment requests allow you to request payment from another user and track the response.

### Send Payment Request

```typescript
// Request payment from @bob
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Payment for order #1234',
});

if (result.success) {
  console.log('Request sent, ID:', result.requestId);
}
```

### Wait for Response

```typescript
// Send and wait for response (with timeout)
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Coffee purchase',
});

if (result.success) {
  try {
    // Wait up to 2 minutes for response
    const response = await sphere.payments.waitForPaymentResponse(result.requestId!, 120000);

    switch (response.responseType) {
      case 'paid':
        console.log('Payment received! Transfer:', response.transferId);
        // Deliver the ticket
        break;
      case 'accepted':
        console.log('Request accepted, waiting for payment...');
        break;
      case 'rejected':
        console.log('Request rejected');
        break;
    }
  } catch (error) {
    console.log('Response timeout or cancelled');
  }
}
```

### Subscribe to Responses

```typescript
// React to all payment request responses
sphere.payments.onPaymentRequestResponse((response) => {
  console.log(`Response from ${response.responderPubkey}: ${response.responseType}`);

  if (response.responseType === 'paid') {
    // Handle successful payment
    deliverProduct(response.requestId);
  }
});
```

### Handle Incoming Requests

```typescript
// Listen for incoming payment requests
sphere.payments.onPaymentRequest((request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);
  console.log(`Message: ${request.message}`);

  // Show UI to user...
});

// Get pending requests
const pending = sphere.payments.getPaymentRequests({ status: 'pending' });

// Accept and pay a request
await sphere.payments.payPaymentRequest(requestId, 'Payment for ticket');

// Or reject
await sphere.payments.rejectPaymentRequest(requestId);
```

### Track Outgoing Requests

```typescript
// Get all outgoing requests
const outgoing = sphere.payments.getOutgoingPaymentRequests();

// Filter by status
const pendingOutgoing = sphere.payments.getOutgoingPaymentRequests({ status: 'pending' });

// Clear completed/expired requests
sphere.payments.clearCompletedOutgoingPaymentRequests();
```

---

## L1 Payments

L1 module handles ALPHA blockchain transactions with vesting classification support.
L1 is **enabled by default** — the Fulcrum WebSocket connection is lazy (deferred until first L1 operation).
To explicitly disable L1, pass `l1: null` in the `PaymentsModuleConfig`.

### Get L1 Balance

```typescript
const balance = await sphere.payments.l1.getBalance();

console.log('Total:', balance.total);           // Total in satoshis
console.log('Confirmed:', balance.confirmed);   // Confirmed balance
console.log('Unconfirmed:', balance.unconfirmed);
console.log('Vested:', balance.vested);         // Coins from blocks ≤280,000
console.log('Unvested:', balance.unvested);     // Coins from blocks >280,000
```

### Get UTXOs

```typescript
const utxos = await sphere.payments.l1.getUtxos();

for (const utxo of utxos) {
  console.log(`${utxo.txid}:${utxo.vout} - ${utxo.amount} sats`);
  console.log(`  Vested: ${utxo.isVested}`);
  console.log(`  Confirmations: ${utxo.confirmations}`);
  if (utxo.coinbaseHeight) {
    console.log(`  Coinbase height: ${utxo.coinbaseHeight}`);
  }
}
```

### Send L1 Transaction

```typescript
const result = await sphere.payments.l1.send({
  to: 'alpha1abc123...',
  amount: '10000000',  // in satoshis
});

if (result.success) {
  console.log('TX Hash:', result.txHash);
} else {
  console.error('Error:', result.error);
}
```

### Get Transaction History

```typescript
const history = await sphere.payments.l1.getHistory(10);  // last 10 transactions

for (const tx of history) {
  console.log(`${tx.type}: ${tx.amount} sats`);
  console.log(`  Confirmations: ${tx.confirmations}`);
  console.log(`  Timestamp: ${new Date(tx.timestamp * 1000)}`);
}
```

### Vesting Classification

ALPHA coins are classified as "vested" or "unvested" based on their coinbase origin:
- **Vested**: Coins traced back to coinbase transactions in blocks ≤280,000
- **Unvested**: Coins from blocks >280,000

The vesting classifier traces each UTXO through the transaction chain to its coinbase origin. Results are cached in IndexedDB (`SphereVestingCacheV5`) for performance. In Node.js, where IndexedDB is not available, the cache is memory-only (re-fetched from network each session).

```typescript
// Vesting is enabled by default. Configure via providers:
const providers = createBrowserProviders({
  network: 'mainnet',
  l1: {
    enableVesting: true,  // default: true
  },
});
```

---

## Communications

### Send Direct Message

```typescript
const message = await sphere.communications.sendDM('@bob', 'Hello!');
console.log('Message ID:', message.id);
```

### Get Conversations

```typescript
const conversations = sphere.communications.getConversations();

for (const [peer, messages] of conversations) {
  console.log(`Conversation with ${peer}: ${messages.length} messages`);
}
```

### Subscribe to Messages

```typescript
// Direct messages
sphere.communications.onDirectMessage((message) => {
  console.log(`${message.senderNametag}: ${message.content}`);
});

// Broadcasts
sphere.communications.subscribeToBroadcasts(['news', 'updates']);
sphere.communications.onBroadcast((broadcast) => {
  console.log(`[${broadcast.tags}] ${broadcast.content}`);
});
```

### Publish Broadcast

```typescript
await sphere.communications.broadcast('Hello world!', ['general']);
```

---

## Invoicing / Accounting

The `AccountingModule` manages the full lifecycle of on-chain invoices: creation, sharing, payment attribution, status tracking, returns, and receipts. An invoice is a special token minted on the Unicity aggregator. Its terms (payment targets, amounts, due date, memo) are embedded in the token's genesis data, making them tamper-evident and independently verifiable by any party who holds the token.

### Enable the Accounting Module

The module is opt-in. Pass `accounting: true` (or a config object) when initializing the wallet:

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({ network: 'testnet', dataDir: './wallet', tokensDir: './tokens' });

const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  accounting: true,  // Enable with defaults
});

// Access the module
const accounting = sphere.accounting!;
```

Custom configuration:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  accounting: {
    debug: true,                    // Enable debug logging
    autoTerminateOnReturn: false,   // Do not auto-close invoice when a return arrives (default)
    maxCoinDataEntries: 50,         // Max coin entries processed per token transaction (default)
  },
});
```

> `sphere.accounting` is `null` when the module is not configured.

### Create an Invoice

An invoice specifies one or more payment targets. Each target has a `DIRECT://` destination address and a list of assets (coin type + amount) it expects to receive.

```typescript
// Create a simple single-target invoice requesting 1 000 000 UCT
const result = await accounting.createInvoice({
  targets: [
    {
      address: sphere.identity!.directAddress!,  // Pay to this wallet
      assets: [
        { coin: ['UCT', '1000000'] },  // [coinId, amount in smallest units]
      ],
    },
  ],
  memo: 'Payment for order #1234',
  dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,  // Due in 7 days
});

if (!result.success) {
  console.error('Invoice creation failed:', result.error);
} else {
  console.log('Invoice ID:', result.invoiceId);      // 64-char hex token ID
  console.log('Terms:', result.terms);               // Parsed InvoiceTerms
  console.log('Token (TXF):', result.token);         // Raw TxfToken for sharing
}
```

Multi-target invoices — where separate parties each receive a different asset — are supported by adding more entries to `targets`. Each target address must be a valid `DIRECT://` address and must appear only once.

### Share an Invoice

The `result.token` is a plain `TxfToken` object (JSON-serializable). Share it with payers over any channel — DM, email, QR code, file, etc.:

```typescript
// Serialize for transmission
const invoiceJson = JSON.stringify(result.token);

// Send over DM (example — use your preferred transport)
await sphere.communications.sendDM('@bob', invoiceJson);
```

### Import an Invoice (Payer Side)

The payer imports the token to start tracking the invoice locally:

```typescript
import type { TxfToken } from '@unicitylabs/sphere-sdk';

const token: TxfToken = JSON.parse(receivedJson);

const terms = await accounting.importInvoice(token);
console.log('Invoice creator:', terms.creator);     // Chain pubkey of issuer
console.log('Due date:', terms.dueDate ? new Date(terms.dueDate) : 'none');
console.log('Targets:', terms.targets.length);
```

`importInvoice()` validates the inclusion proof embedded in the token and rejects tokens with an invalid or tampered proof chain.

### Pay an Invoice

Use `payInvoice()` to send tokens against a specific target and asset within the invoice. The module constructs the correct memo automatically and embeds your return address so the payee can issue refunds.

```typescript
// Pay the first target's first asset (index 0, 0)
const transfer = await accounting.payInvoice(invoiceId, {
  targetIndex: 0,    // Which target to pay
  assetIndex: 0,     // Which asset within that target (default: 0)
  // amount is optional — defaults to the remaining uncovered amount
});

console.log('Transfer ID:', transfer.id);
console.log('Status:', transfer.status);  // 'pending' | 'submitted' | 'delivered' | 'completed' | 'failed'
```

Paying a specific amount (partial payment):

```typescript
await accounting.payInvoice(invoiceId, {
  targetIndex: 0,
  amount: '500000',          // Pay half now
  freeText: 'First tranche', // Optional note appended to the memo
  refundAddress: sphere.identity!.directAddress!,  // Explicit refund destination
});
```

### Check Invoice Status

`getInvoiceStatus()` computes the current payment state from local transaction history. It returns a full breakdown per target and per coin asset.

```typescript
const status = await accounting.getInvoiceStatus(invoiceId);

console.log('State:', status.state);
// 'OPEN'      — no payments yet
// 'PARTIAL'   — some targets partially covered
// 'COVERED'   — all targets fully covered, awaiting confirmation
// 'CLOSED'    — explicitly or implicitly closed
// 'CANCELLED' — cancelled by a target party
// 'EXPIRED'   — due date passed, not yet covered

console.log('All confirmed:', status.allConfirmed);
console.log('Last activity:', new Date(status.lastActivityAt));

// Per-target breakdown
for (const target of status.targets) {
  console.log(`Target ${target.address}: covered=${target.isCovered}`);
  for (const coinAsset of target.coinAssets) {
    const [coinId, requested] = coinAsset.coin;
    console.log(`  ${coinId}: ${coinAsset.netCoveredAmount}/${requested}`);
    if (coinAsset.surplusAmount !== '0') {
      console.log(`  Surplus: ${coinAsset.surplusAmount}`);
    }
  }
}
```

`getInvoiceStatus()` has a side effect: when the invoice transitions from `COVERED` to fully confirmed (`allConfirmed === true`), it implicitly closes the invoice, freezes balances, and fires `invoice:closed`.

### List Invoices

`getInvoices()` returns lightweight `InvoiceRef` objects (no status computed unless a state filter is passed):

```typescript
// All invoices
const all = await accounting.getInvoices();

// Only open invoices created by this wallet
const mine = await accounting.getInvoices({
  state: 'OPEN',
  createdByMe: true,
  sortBy: 'dueDate',
  sortOrder: 'asc',
  limit: 20,
  offset: 0,
});

for (const ref of mine) {
  console.log(`${ref.invoiceId}: creator=${ref.isCreator} closed=${ref.closed} cancelled=${ref.cancelled}`);
  console.log(`  Memo: ${ref.terms.memo ?? 'none'}`);
  console.log(`  Due: ${ref.terms.dueDate ? new Date(ref.terms.dueDate) : 'none'}`);
}

// Single invoice by ID (synchronous, in-memory)
const ref = accounting.getInvoice(invoiceId);
if (!ref) {
  console.log('Invoice not found locally');
}
```

### Close an Invoice (Payee Side)

Only a wallet whose address appears in `terms.targets` can close an invoice. Closing freezes the current balance snapshot and stops further dynamic recomputation.

```typescript
// Explicit close — balance is frozen at this moment
await accounting.closeInvoice(invoiceId);

// Close and immediately return any surplus to payers
await accounting.closeInvoice(invoiceId, { autoReturn: true });
```

Implicit close happens automatically when `getInvoiceStatus()` detects `state === 'COVERED'` with `allConfirmed === true`.

### Cancel an Invoice

Cancellation is also restricted to target parties. All received payments become eligible for return.

```typescript
// Cancel and return all payments to payers
await accounting.cancelInvoice(invoiceId, { autoReturn: true });
```

### Return a Payment (Manual)

The payee can return tokens to a specific payer at any time. The amount is capped at that payer's net balance for the given coin.

```typescript
// Return 250 000 UCT to the original payer
const result = await accounting.returnInvoicePayment(invoiceId, {
  recipient: 'DIRECT://...',  // Payer's address (from status.targets[i].coinAssets[j].senderBalances)
  amount: '250000',
  coinId: 'UCT',
  freeText: 'Partial refund — order cancelled',
});
```

### Auto-Return Setup

Auto-return automatically sends tokens back to payers when an invoice is terminated (closed or cancelled). It can be enabled globally or per invoice.

```typescript
// Enable for all terminated invoices (global setting)
await accounting.setAutoReturn('*', true);

// Enable for a specific invoice only
await accounting.setAutoReturn(invoiceId, true);

// Check current settings
const settings = accounting.getAutoReturnSettings();
console.log('Global:', settings.global);
console.log('Per-invoice:', settings.perInvoice);
```

When enabled, auto-return fires immediately for invoices already in a terminal state, and continues to process new forward payments that arrive after termination.

### Send Receipts (Payee Side)

After closing or cancelling an invoice, the payee can send structured receipt DMs to each payer confirming their contribution:

```typescript
// Send receipt to all payers after close
const result = await accounting.sendInvoiceReceipts(invoiceId, {
  memo: 'Thank you for your payment — order dispatched',
  includeZeroBalance: false,  // Skip payers with net balance of 0 (default)
});

console.log(`Sent: ${result.sent}, Failed: ${result.failed}`);
```

### Send Cancellation Notices

After cancelling an invoice, the payee can notify payers with a structured cancellation DM:

```typescript
const result = await accounting.sendCancellationNotices(invoiceId, {
  reason: 'Item out of stock',
  dealDescription: 'Limited edition UCT merchandise',
  includeZeroBalance: false,
});

console.log(`Notices sent: ${result.sent}, Failed: ${result.failed}`);
```

### Listen to Invoice Events

Subscribe via `sphere.on()` — the same event bus used by all other modules:

```typescript
// Invoice created or imported
sphere.on('invoice:created', ({ invoiceId, confirmed }) => {
  console.log(`New invoice: ${invoiceId} (confirmed: ${confirmed})`);
});

// Incoming payment against an invoice
sphere.on('invoice:payment', ({ invoiceId, transfer, paymentDirection, confirmed }) => {
  console.log(`Payment on ${invoiceId}: direction=${paymentDirection}`);
});

// Asset fully covered (requested amount reached for a coin)
sphere.on('invoice:asset_covered', ({ invoiceId, address, coinId, confirmed }) => {
  console.log(`${coinId} covered for ${address} on invoice ${invoiceId}`);
});

// All assets for a target covered
sphere.on('invoice:target_covered', ({ invoiceId, address, confirmed }) => {
  console.log(`Target ${address} covered on invoice ${invoiceId}`);
});

// All targets covered
sphere.on('invoice:covered', ({ invoiceId, confirmed }) => {
  console.log(`Invoice ${invoiceId} fully covered`);
});

// Invoice closed (explicit: user called closeInvoice(); implicit: auto-close after COVERED+confirmed)
sphere.on('invoice:closed', ({ invoiceId, explicit }) => {
  console.log(`Invoice ${invoiceId} closed (explicit: ${explicit})`);
});

// Invoice cancelled
sphere.on('invoice:cancelled', ({ invoiceId }) => {
  console.log(`Invoice ${invoiceId} cancelled`);
});

// Overpayment detected on a coin asset
sphere.on('invoice:overpayment', ({ invoiceId, address, coinId, surplus, confirmed }) => {
  console.log(`Overpayment of ${surplus} ${coinId} on invoice ${invoiceId}`);
});

// Auto-return executed
sphere.on('invoice:auto_returned', ({ invoiceId, originalTransfer, returnTransfer }) => {
  console.log(`Auto-return sent for invoice ${invoiceId}`);
});

// Auto-return failed
sphere.on('invoice:auto_return_failed', ({ invoiceId, transferId, reason }) => {
  console.warn(`Auto-return failed for ${invoiceId}: ${reason}`);
});

// Return received by the payer
sphere.on('invoice:return_received', ({ invoiceId, transfer, returnReason }) => {
  console.log(`Return received on ${invoiceId}: reason=${returnReason}`);
});

// Receipt received (payer side — sent by the payee after close/cancel)
sphere.on('invoice:receipt_received', ({ invoiceId, receipt }) => {
  console.log(`Receipt for ${invoiceId} from ${receipt.targetAddress}`);
  console.log(`State: ${receipt.receipt.terminalState}`);
  for (const asset of receipt.receipt.senderContribution.assets) {
    console.log(`  ${asset.coinId}: forwarded=${asset.forwardedAmount} returned=${asset.returnedAmount}`);
  }
});

// Cancellation notice received (payer side)
sphere.on('invoice:cancellation_received', ({ invoiceId, notice }) => {
  console.log(`Invoice ${invoiceId} was cancelled: ${notice.notice.reason ?? 'no reason given'}`);
});
```

### Complete Workflow Example

The following example walks through the full lifecycle from the payee's perspective (creating and closing) and the payer's perspective (importing and paying):

```typescript
// ---- PAYEE SIDE ----

const { sphere: payee } = await Sphere.init({
  ...payeeProviders,
  autoGenerate: true,
  nametag: 'shop',
  accounting: true,
});
const payeeAccounting = payee.accounting!;

// 1. Create the invoice
const { invoiceId, token } = await payeeAccounting.createInvoice({
  targets: [{
    address: payee.identity!.directAddress!,
    assets: [{ coin: ['UCT', '2000000'] }],
  }],
  memo: 'Order #5678 — 2 items',
  dueDate: Date.now() + 3 * 24 * 60 * 60 * 1000,
});

// 2. Share with payer (here via DM)
await payee.communications.sendDM('@customer', JSON.stringify(token));

// 3. Listen for payments
payee.on('invoice:covered', async ({ invoiceId: id }) => {
  // All targets are paid — send receipt
  await payeeAccounting.sendInvoiceReceipts(id, { memo: 'Your order has been dispatched.' });
});

// ---- PAYER SIDE ----

const { sphere: payer } = await Sphere.init({
  ...payerProviders,
  autoGenerate: true,
  nametag: 'customer',
  accounting: true,
});
const payerAccounting = payer.accounting!;

// 4. Receive the invoice token via DM
payer.communications.onDirectMessage(async (msg) => {
  let token;
  try { token = JSON.parse(msg.content); } catch { return; }

  // 5. Import and pay
  await payerAccounting.importInvoice(token);

  const status = await payerAccounting.getInvoiceStatus(token.id);
  console.log('Invoice state before payment:', status.state);  // 'OPEN'

  await payerAccounting.payInvoice(token.id, { targetIndex: 0 });
});

// 6. Payer receives a receipt DM once payee confirms
payer.on('invoice:receipt_received', ({ invoiceId: id, receipt }) => {
  console.log(`Invoice ${id} settled. Memo: ${receipt.receipt.memo}`);
});
```

### Get Related Transfers

Inspect the full transfer history attributed to an invoice, including transfers the module classified as irrelevant (wrong address, wrong asset, self-payment):

```typescript
const transfers = accounting.getRelatedTransfers(invoiceId);

for (const t of transfers) {
  console.log(`${t.transferId}: direction=${t.direction} paymentDirection=${t.paymentDirection}`);
  console.log(`  Amount: ${t.amount} ${t.coinId}`);
  if ('reason' in t) {
    // IrrelevantTransfer — did not count toward coverage
    console.log(`  Irrelevant: ${t.reason}`);
  }
}
```

### Parse an Invoice Memo

When inspecting raw transaction history (e.g., from `sphere.payments.getHistory()`), use `parseInvoiceMemo()` to check whether a memo references an invoice:

```typescript
const parsed = accounting.parseInvoiceMemo('INV:abc123:F');
if (parsed) {
  console.log('Invoice ID:', parsed.invoiceId);           // 'abc123'
  console.log('Direction:', parsed.paymentDirection);     // 'forward'
  console.log('Free text:', parsed.freeText ?? 'none');
}
```

### Accounting Error Codes

All accounting errors are `SphereError` instances with a typed `.code`. Use `isSphereError()` to handle them:

```typescript
import { isSphereError } from '@unicitylabs/sphere-sdk';

try {
  await accounting.closeInvoice(invoiceId);
} catch (err) {
  if (isSphereError(err)) {
    switch (err.code) {
      case 'INVOICE_NOT_FOUND':
        console.error('Invoice not found locally — was it imported?');
        break;
      case 'INVOICE_NOT_TARGET':
        console.error('Only target parties can close an invoice');
        break;
      case 'INVOICE_ALREADY_CLOSED':
        console.error('Invoice is already closed');
        break;
      case 'INVOICE_ALREADY_CANCELLED':
        console.error('Invoice is already cancelled');
        break;
      case 'INVOICE_TERMINATED':
        console.error('Cannot pay a closed or cancelled invoice');
        break;
      case 'INVOICE_RETURN_EXCEEDS_BALANCE':
        console.error('Return amount exceeds the payer\'s net balance for this coin');
        break;
      case 'INVOICE_MINT_FAILED':
        console.error('Aggregator submission failed — check network connection');
        break;
      case 'INVOICE_NOT_TERMINATED':
        console.error('Receipts can only be sent for closed or cancelled invoices');
        break;
      case 'COMMUNICATIONS_UNAVAILABLE':
        console.error('DM receipts require the CommunicationsModule to be available');
        break;
      default:
        console.error(err.message);
    }
  }
}
```

**Full list of accounting error codes:**

| Code | Thrown by | Meaning |
|------|-----------|---------|
| `INVOICE_NO_TARGETS` | `createInvoice` | Targets array is empty |
| `INVOICE_NO_ASSETS` | `createInvoice` | A target has no assets |
| `INVOICE_INVALID_AMOUNT` | `createInvoice`, `payInvoice` | Asset amount is not a positive integer, or zero-amount send |
| `INVOICE_INVALID_ADDRESS` | `createInvoice` | A target address is not a valid `DIRECT://` address |
| `INVOICE_ORACLE_REQUIRED` | `createInvoice` | Oracle provider is not available (required for minting) |
| `INVOICE_MINT_FAILED` | `createInvoice` | Aggregator submission failed after retries |
| `INVOICE_INVALID_PROOF` | `importInvoice` | Inclusion proof is invalid or tampered |
| `INVOICE_WRONG_TOKEN_TYPE` | `importInvoice` | Token is not an invoice token |
| `INVOICE_INVALID_DATA` | `importInvoice` | `tokenData` cannot be parsed as `InvoiceTerms` |
| `INVOICE_ALREADY_EXISTS` | `importInvoice` | Invoice token already held locally |
| `INVOICE_NOT_FOUND` | Most methods | Invoice is not known locally |
| `INVOICE_NOT_TARGET` | `closeInvoice`, `cancelInvoice`, `returnInvoicePayment`, `sendInvoiceReceipts`, `sendCancellationNotices` | Wallet is not one of the invoice targets |
| `INVOICE_ALREADY_CLOSED` | `closeInvoice` | Invoice is already in CLOSED state |
| `INVOICE_ALREADY_CANCELLED` | `cancelInvoice` | Invoice is already in CANCELLED state |
| `INVOICE_TERMINATED` | `payInvoice` | Invoice is CLOSED or CANCELLED — no further payments accepted |
| `INVOICE_RETURN_EXCEEDS_BALANCE` | `returnInvoicePayment` | Return amount exceeds per-sender net balance |
| `INVOICE_NOT_TERMINATED` | `sendInvoiceReceipts` | Invoice must be CLOSED or CANCELLED before sending receipts |
| `INVOICE_NOT_CANCELLED` | `sendCancellationNotices` | Invoice must be in CANCELLED state |
| `COMMUNICATIONS_UNAVAILABLE` | `sendInvoiceReceipts`, `sendCancellationNotices` | `CommunicationsModule` is not available |
| `INVOICE_MEMO_TOO_LONG` | `createInvoice`, `sendInvoiceReceipts`, `sendCancellationNotices` | Memo or reason exceeds 4096 characters |
| `RATE_LIMITED` | `setAutoReturn('*', ...)` | Global auto-return setting changed within 5-second cooldown |

---

## Custom Providers

### Storage Provider Interface

The default browser implementation is `IndexedDBStorageProvider` (database: `sphere-storage`, object store: `kv`). For Node.js, `FileStorageProvider` is used. Both support per-address key scoping via `setIdentity()`.

```typescript
interface StorageProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;

  setIdentity(identity: FullIdentity): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;

  // Tracked addresses registry
  saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void>;
  loadTrackedAddresses(): Promise<TrackedAddressEntry[]>;
}
```

### Transport Provider Interface

```typescript
interface TransportProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  setIdentity(identity: FullIdentity): void;
  sendMessage(recipientPubkey: string, content: string): Promise<string>;
  onMessage(callback: (msg: IncomingMessage) => void): () => void;
  sendTokenTransfer(recipientPubkey: string, payload: TokenTransferPayload): Promise<string>;
  onTokenTransfer(handler: TokenTransferHandler): () => void;

  // Peer resolution (optional)
  resolve?(identifier: string): Promise<PeerInfo | null>;
  resolveNametagInfo?(nametag: string): Promise<PeerInfo | null>;
  resolveAddressInfo?(address: string): Promise<PeerInfo | null>;

  // Identity binding (optional)
  publishIdentityBinding?(chainPubkey: string, l1Address: string, directAddress: string, nametag?: string): Promise<boolean>;

  // Broadcast (optional)
  publishBroadcast?(content: string, tags?: string[]): Promise<string>;
  subscribeToBroadcast?(tags: string[], callback: (b: IncomingBroadcast) => void): () => void;
}
```

### Oracle Provider Interface

```typescript
interface OracleProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  submitCommitment(commitment: TransferCommitment): Promise<SubmitResult>;
  getInclusionProof(requestId: string): Promise<InclusionProof | null>;
  validateToken(tokenData: unknown): Promise<ValidationResult>;
  getCurrentRound(): Promise<bigint>;
}
```

---

## Events

### Available Events

```typescript
// Wallet events
sphere.on('wallet:created', () => { });
sphere.on('wallet:loaded', () => { });
sphere.on('wallet:cleared', () => { });

// Transfer events
sphere.on('transfer:incoming', (transfer) => { });
sphere.on('transfer:outgoing', (transfer) => { });
sphere.on('transfer:confirmed', (transfer) => { });
sphere.on('transfer:failed', (transfer) => { });

// Payment request events
sphere.on('payment_request:incoming', (request) => { });
sphere.on('payment_request:accepted', (request) => { });
sphere.on('payment_request:rejected', (request) => { });
sphere.on('payment_request:paid', (request) => { });
sphere.on('payment_request:response', (response) => { });

// Message events
sphere.on('message:dm', (message) => { });
sphere.on('message:broadcast', (broadcast) => { });

// Sync events
sphere.on('sync:started', ({ source }) => { });
sphere.on('sync:completed', ({ source, count }) => { });
sphere.on('sync:error', ({ source, error }) => { });

// Connection events
sphere.on('connection:changed', ({ provider, connected }) => { });
sphere.on('nametag:registered', ({ nametag, addressIndex }) => { });
sphere.on('nametag:recovered', ({ nametag }) => { });

// Identity events
sphere.on('identity:changed', ({ l1Address, directAddress, chainPubkey, nametag, addressIndex }) => { });

// Address tracking events
sphere.on('address:activated', ({ address }) => { });  // New address tracked
sphere.on('address:hidden', ({ index, addressId }) => { });
sphere.on('address:unhidden', ({ index, addressId }) => { });
```

### UXF Transfer Events

The UXF inter-wallet transfer protocol introduces a richer event surface than the legacy `transfer:incoming` / `transfer:confirmed` / `transfer:failed` triple. The 13 events below split into four bands — **lifecycle**, **failure-class**, **advisory**, and **ops** — each with a distinct integrator-side intent.

**Lifecycle** events fire on the happy path and the normal failure path. Most consumers wire these and ignore the rest.

| Event | Payload | When fired | Typical handler intent |
|-------|---------|------------|------------------------|
| `transfer:incoming` | `IncomingTransfer` (`{senderPubkey, senderNametag?, tokens, receivedAt}`) | A UXF bundle was received and the recipient's `T.2.B` ingest accepted it. | Update the wallet UI's inbox, emit a notification, refresh balances. |
| `transfer:submitted` | `TransferResult` | T.5.A — instant-mode UXF send acked by the relay; the bundle reached the recipient but source-token proofs are still being polled. | Update the outbox UI from `'pending'` to `'submitted'`. Sender-side worker takes over for proofs. |
| `transfer:confirmed` | `TransferResult` | Outgoing transfer's source-token inclusion proofs have all landed locally — the transfer is finalized end-to-end. (Mapped from spec language `transfer:finalized`.) | Mark the transfer "complete" in UI, remove from "in-flight" list. |
| `transfer:failed` | `TransferResult` | Outgoing transfer reached a terminal failure that does NOT need operator escalation (e.g. recipient rejected, transient delivery exhaustion past retry limit). | Surface the failure reason; offer retry / cancel UX. |

**Failure-class** events fire when the wallet detects a condition that warrants operator attention. None of these auto-resolve — every one needs a human (or an automated operator console) to react.

| Event | Payload | When fired | Typical handler intent |
|-------|---------|------------|------------------------|
| `transfer:cascade-failed` | `{outboxId, tokenId, bundleCid, recipientTransportPubkey, reason}` | T.5.B — sender-side finalization worker hard-failed a queue entry whose token had outgoing instant-mode bundles; the cascade walker (T.5.B.5) will mark dependent children `parent-rejected`. The `reason: 'race-lost'` short-circuit is excluded by spec — that path does NOT emit. | Page the operator if `reason ∉ {'oracle-rejected'}`; surface to the audit log. |
| `transfer:operator-alert` | `{code, tokenId?, bundleCid?, observedTokenContentHash?, senderTransportPubkey?, message}` | T.3.C / §6.1 — disposition path surfaces a condition needing human attention but is not a normal `transfer:failed` (e.g. C13: `client-error` from `REQUEST_ID_MISMATCH` — wallet computed an inconsistent tuple, indicating a CLIENT BUG). | Forward to monitoring, file a ticket. |
| `transfer:security-alert` | `{tokenId, requestId, outboxId?, attachedTransactionHash, observedTransactionHash, attachedAuthenticator?, observedAuthenticator?, message}` | T.5.B / T.5.C — §6.3 forbidden case: TWO distinct proofs for the SAME `requestId` with DIFFERENT `(transactionHash, authenticator)`. The single-spend invariant guarantees this never happens in a non-faulty deployment. | Halt — investigate trust boundary. The protocol does NOT auto-recover. |

**Advisory** events are informational warnings — the wallet keeps working, but a downstream issue is hinted at. Consumers usually log these and surface them to a "system health" panel.

| Event | Payload | When fired | Typical handler intent |
|-------|---------|------------|------------------------|
| `transfer:cascade-risk-warning` | `{transferId, bundleCid, recipientTransportPubkey, pendingSourceTokenIds, freshlyMintedChildTokenIds}` | T.5.A — instant-mode sender about to ship a freshly-minted child whose source token is still pending (§6.1.1 cascade rule). Recipient may have to wait for source-token proofs. | Surface a "delivery may be delayed" hint in the sender UI. |
| `transfer:trustbase-warning` | `{tokenId, requestId, outboxId?, bundleCid?, attempt, message}` | T.5.B / T.5.C / T.5.F — proof verifier returned `NOT_AUTHENTICATED`. Likely cause: stale local trustBase. The worker retries up to `MAX_PROOF_ERROR_RETRIES`; on overrun, hard-fails with `'proof-invalid'`. | Trigger a trustBase refresh; fall back to `transfer:security-alert` semantics if the warning persists across refresh. |
| `transfer:capability-warning` | `{recipientTransportPubkey, recipientAssetKinds, recipientWireProtocols?, outboundAssetKinds, outboundWireProtocol, mismatchedAssetKinds, wireProtocolMismatch}` | T.8.B (§10.4 W20) — sender BEFORE a UXF send: resolved recipient's identity-binding-event capability hints suggest the recipient may not understand the bundle. **Informational only** — sender does NOT auto-strip. The actual interop guarantee comes from the receiver's `UNKNOWN_ASSET_KIND` reject rule. | Optionally surface a "recipient may not support X" hint in the send UI. |

**Ops** events fire on edge-case operational paths — gateway exhaustion, queue back-pressure, proof maintenance, operator overrides, recovery worker re-publishes.

| Event | Payload | When fired | Typical handler intent |
|-------|---------|------------|------------------------|
| `transfer:fetch-failed` | `{bundleCid, senderTransportPubkey, gatewaysAttempted, failureReasons}` | T.4.B — recipient's CID-by-reference fetch (`kind: 'uxf-cid'`) exhausted EVERY configured gateway. Per W13 NO disposition record is written (failure is transient by definition). | Forward to operator dashboard for gateway-health monitoring; do NOT mark the transfer failed. |
| `transfer:ingest-queue-full` | `{cause, senderTransportPubkey, bundleCid, queueSize, capacity, tokenIds?}` | T.3.E / W7 — recipient's ingest pool back-pressure cap fires (`'queue-full'` for global cap, `'queue-full-per-token'` for per-token cap). Recipient does NOT acknowledge the sender. | Alert on sustained pressure; consider raising `INGEST_QUEUE_SIZE` / `INGEST_QUEUE_PER_TOKEN_CAP`. |
| `transfer:proof-superseded` | `{tokenId, requestId, outboxId?, previousCid, newCid}` | T.5.B / T.5.C / W16 — fresh poll returned a NEWER proof for an already-attached `requestId` (same value, newer round). Worker replaces the old proof and tombstones the previous CID per §6.3 most-recent-proof canonicalization. | Log; consider exposing a "proof refresh" metric. Distinct from `transfer:security-alert` — superseded means SAME value, newer snapshot. |
| `transfer:override-applied` | `{tokenId, overrideAppliedAt, overrideAppliedBy?, previousReason, transition}` | T.5.D — successful `payments.importInclusionProof({allowInvalidOverride: true})` flipped a token from `_invalid` back to active pool. The pair stamped on the manifest entry survives every future CRDT merge. | Render an "operator override" row in the audit log. The event represents an explicit breach of §5.6 monotonicity — surface prominently. |
| `transfer:recovery-republished` | `{outboxId, bundleCid, tokenIds, mode, targetStatus, recoveredAt}` | Phase 8 — sending-recovery worker (gated behind `features.recoveryWorker`) re-published a stuck-in-`'sending'` outbox entry and successfully advanced it forward (§7.0 transition). | Update outbox UI to the new `targetStatus` (`'delivered'` / `'delivered-instant'`); log for recovery-rate metrics. |

#### Subscribing to UXF events

```typescript
// Lifecycle — most apps wire only these:
sphere.on('transfer:incoming', (t) => updateInbox(t));
sphere.on('transfer:submitted', (t) => updateOutbox(t.id, 'submitted'));
sphere.on('transfer:confirmed', (t) => updateOutbox(t.id, 'confirmed'));
sphere.on('transfer:failed', (t) => surfaceFailure(t.id, t.error));

// Operator console — wire the failure-class + ops events:
sphere.on('transfer:cascade-failed', ({ outboxId, tokenId, reason }) => {
  if (reason !== 'race-lost') page(`cascade-failed: ${tokenId} (${reason})`);
});
sphere.on('transfer:security-alert', (data) => {
  // §6.3 forbidden case — investigate trust boundary
  haltAndAlert('security-alert', data);
});
sphere.on('transfer:override-applied', ({ tokenId, transition, previousReason, overrideAppliedBy }) => {
  auditLog.append({
    kind: 'operator-override',
    tokenId,
    transition,             // 'invalid→valid' | 'invalid→pending'
    previousReason,
    operator: overrideAppliedBy,
  });
});
sphere.on('transfer:recovery-republished', ({ outboxId, targetStatus }) => {
  metrics.increment('recovery_worker.republished_total');
  outboxUi.update(outboxId, targetStatus);
});

// Advisory — usually log + dashboard:
sphere.on('transfer:trustbase-warning', ({ requestId, attempt }) => {
  if (attempt > 1) refreshTrustBase();
});
sphere.on('transfer:capability-warning', ({ mismatchedAssetKinds }) => {
  if (mismatchedAssetKinds.length > 0) {
    showHint('Recipient may not support: ' + mismatchedAssetKinds.join(', '));
  }
});
```

All payload shapes are exported from `types/index.ts` (`SphereEventMap`); see the JSDoc on each entry for canonical field semantics and spec back-references.

### Unsubscribe

```typescript
const unsubscribe = sphere.on('transfer:incoming', handler);

// Later...
unsubscribe();
```

---

## Unicity IDs

Unicity IDs provide human-readable addresses (e.g., `@alice`) for receiving tokens.

### Registration Flow

```typescript
// Register during wallet creation
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  nametag: 'alice',
});

// Or register after wallet is created
await sphere.registerNametag('alice');

// Mint nametag token on-chain (required for PROXY address transfers)
const result = await sphere.mintNametag('alice');
```

### Multi-Address Unicity IDs

Each derived address can have its own Unicity ID:

```typescript
// Register @alice for address 0
await sphere.registerNametag('alice');

// Switch to address 1 and register @bob
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');

// Query nametags
sphere.getNametagForAddress(0);  // 'alice'
sphere.getNametagForAddress(1);  // 'bob'
sphere.getAllAddressNametags();  // Map { 0 => 'alice', 1 => 'bob' }
```

### Troubleshooting: "Unicity ID already taken"

**Error:**
```
Failed to register nametag. It may already be taken.
[NostrTransportProvider] Nametag already taken: myname - owner: f124f93ae6...
```

**Cause:** The Unicity ID is registered to a different public key. This happens when:

1. **Storage cleared or inaccessible** → `Sphere.exists()` returns `false` → new wallet created
2. **Different mnemonic provided** on subsequent runs

**Note:** `autoGenerate: true` does NOT generate new mnemonic every restart. It only generates if `Sphere.exists()` returns `false`.

**Solution:**

```typescript
// ✅ Use persistent file storage (recommended for backend)
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data');
const { sphere } = await Sphere.init({
  storage,  // Persists mnemonic to disk
  autoGenerate: true,
  nametag: 'myservice',
});

// ✅ Or use fixed mnemonic from environment
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: process.env.WALLET_MNEMONIC,
  nametag: 'myservice',
});
```

**Debug storage issues:**
```typescript
const exists = await Sphere.exists(storage);
console.log('Wallet exists:', exists);  // Should be true after first run

// Enable storage debug logs
logger.setTagDebug('LocalStorage', true);
logger.setTagDebug('IndexedDB', true);
logger.setTagDebug('IPFS-Storage', true);
```

### Unicity ID Sync on Load

When loading an existing wallet, the SDK automatically syncs the Unicity ID with Nostr:

```typescript
// On Sphere.load(), if local nametag exists:
// 1. Checks if nametag is registered on Nostr
// 2. If not registered or owned by this pubkey, re-publishes it
// 3. Logs warning if owned by different pubkey
```

### Unicity ID Recovery on Import

When importing a wallet without specifying a Unicity ID, the SDK automatically attempts to recover it from Nostr:

```typescript
// Import wallet - nametag will be recovered if found on Nostr
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  // No nametag specified
});

// Listen for recovery
sphere.on('nametag:recovered', ({ nametag }) => {
  console.log('Recovered nametag:', nametag);
});

// Or check after init
if (sphere.identity?.nametag) {
  console.log('Nametag recovered:', sphere.identity.nametag);
}
```

The recovery process:
1. Derives transport pubkey from wallet keys
2. Queries Nostr for Unicity ID events owned by this pubkey
3. If found, sets the Unicity ID locally and emits `nametag:recovered` event

---

## Error Handling

### Send Error Handling

`send()` returns a `TransferResult` — check its `status` and `error` fields:

```typescript
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
});

if (result.status === 'failed') {
  console.error('Transfer failed:', result.error);
  // Common errors:
  // - Insufficient balance
  // - Recipient not found (nametag not registered)
  // - Network/aggregator errors
}
```

### Token Validation

```typescript
// Validate all tokens against the aggregator
const { valid, invalid } = await sphere.payments.validate();

if (invalid.length > 0) {
  console.warn(`${invalid.length} tokens marked invalid`);
  for (const token of invalid) {
    console.warn(`  ${token.id}: ${token.amount} ${token.symbol}`);
  }
}

// Subscribe to transfer lifecycle events
sphere.on('transfer:confirmed', (transfer) => {
  console.log('Transfer confirmed:', transfer.id);
});

sphere.on('transfer:failed', (transfer) => {
  console.error('Transfer failed:', transfer.id, transfer.error);
});
```

### Typed Error Handling

All SDK methods throw `SphereError` with a typed `.code` field. Use `isSphereError()` type guard to handle errors programmatically:

```typescript
import { isSphereError } from '@unicitylabs/sphere-sdk';

try {
  await sphere.payments.send({ coinId, amount, recipient });
} catch (err) {
  if (isSphereError(err)) {
    // err.code is typed as SphereErrorCode
    switch (err.code) {
      case 'INSUFFICIENT_BALANCE':
        showError('Not enough funds');
        break;
      case 'INVALID_RECIPIENT':
        showError('Recipient not found');
        break;
      case 'TRANSPORT_ERROR':
        showError('Network issue');
        break;
      case 'AGGREGATOR_ERROR':
        showError('Oracle unavailable');
        break;
      default:
        showError(err.message);
    }
  }
}
```

### Debug Logging

Enable the centralized logger to diagnose issues:

```typescript
import { logger } from '@unicitylabs/sphere-sdk';

logger.configure({ debug: true });

// Or enable specific modules:
logger.setTagDebug('Payments', true);
logger.setTagDebug('Nostr', true);
```

---

## Best Practices

### 1. Always Handle Wallet State

```typescript
async function initApp() {
  const providers = createBrowserProviders({ network: 'testnet' });

  // Sphere.init() handles both creation and loading
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  if (created && generatedMnemonic) {
    // Show mnemonic backup UI
    console.log('Save your mnemonic:', generatedMnemonic);
  }
}
```

### 2. Subscribe to Events Early

```typescript
// Sphere.init() returns an initialized sphere — subscribe to events right after
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

sphere.on('transfer:incoming', handleIncomingTransfer);
sphere.on('message:dm', handleMessage);
```

### 3. Graceful Shutdown

```typescript
window.addEventListener('beforeunload', async () => {
  await sphere.destroy();
});
```

### 4. Handle Reconnection

```typescript
sphere.on('connection:changed', async ({ provider, connected }) => {
  if (!connected) {
    console.log(`${provider} disconnected, attempting reconnect...`);
    // SDK handles reconnection automatically
  }
});
```

### 5. Event Timestamp Persistence

The transport layer persists the timestamp of the last processed wallet event. On reconnect or app restart, only events newer than the stored timestamp are fetched — preventing duplicate token processing.

This is handled automatically when using `createBrowserProviders()` or `createNodeProviders()`. The storage provider is passed to the transport, and timestamps are persisted per wallet pubkey.

**Behavior by scenario:**

| Scenario | `since` filter |
|----------|---------------|
| Existing wallet with stored timestamp | Resume from last event timestamp |
| Fresh wallet (no stored timestamp) | `now` — no historical events |
| No storage adapter (legacy) | `now - 24h` fallback |

**Note:** The `since` filter only applies to wallet events (token transfers, payment requests). Chat messages (NIP-17 GIFT_WRAP) are always real-time with no `since` filter.

---

## Testing

The SDK includes a comprehensive test suite using Vitest.

### Running Tests

```bash
# Run all tests (watch mode)
npm test

# Run once (CI mode)
npm run test:run

# Run specific test file
npx vitest run tests/unit/core/crypto.test.ts

# Run with coverage
npm test -- --coverage
```

### Test Coverage

| Module | Tests | Description |
|--------|-------|-------------|
| `core/crypto` | 43 | BIP39, BIP32, hashing, address generation |
| `core/bech32` | 30 | Bech32 encoding/decoding |
| `core/currency` | 37 | Amount conversion and formatting |
| `core/encryption` | 39 | AES-256-CBC encryption |
| `core/utils` | 40 | Base58, validation, utilities |
| `core/Sphere.clear` | 11 | Wallet data cleanup (storage + tokenStorage) |
| `l1/address` | 18 | HD key derivation |
| `l1/addressToScriptHash` | 7 | Electrum scripthash |
| `l1/tx` | 23 | SegWit transactions, UTXO selection |
| `l1/crypto` | 22 | Wallet encryption, WIF conversion |
| `l1/addressHelpers` | 36 | Address management utilities |
| `l1/vesting` | 20 | Vesting classification, Node.js memory-only fallback |
| `l1/L1PaymentsHistory` | 12 | L1 transaction history direction/amounts |
| `serialization/txf` | 44 | TXF token format |
| `serialization/wallet-text` | 32 | Text wallet backup format |
| `serialization/wallet-dat` | 18 | SQLite wallet.dat parsing |
| `modules/TokenSplitCalculator` | 23 | Token split optimization |
| `modules/TokenSplitExecutor` | 16 | Token split execution |
| `modules/PaymentsModule` | 36 | Payments, Unicity ID, PROXY |
| `modules/NametagMinter` | 22 | On-chain Unicity ID minting |
| `modules/CommunicationsModule.storage` | 16 | DM per-address storage, migration, pagination |
| `price/CoinGeckoPriceProvider` | 29 | Price provider, cache, negative cache |
| `transport/NostrTransportProvider` | 43 | Nostr P2P messaging, event timestamp persistence |
| `impl/browser/IndexedDBStorageProvider` | 17 | IndexedDB kv storage, per-address key scoping |
| `integration/wallet-import-export` | 20 | Wallet import/export |
| `integration/nametag-roundtrip` | 9 | Unicity ID serialization |
| `impl/shared/resolvers` | 41 | Config resolution utilities |
| **Total** | **1613** | All passing (63 test files) |

### Writing Tests

Tests follow the structure:

```
tests/
├── unit/
│   ├── core/
│   │   ├── crypto.test.ts
│   │   ├── bech32.test.ts
│   │   ├── currency.test.ts
│   │   ├── encryption.test.ts
│   │   ├── utils.test.ts
│   │   ├── Sphere.providers.test.ts
│   │   ├── Sphere.nametag-sync.test.ts
│   │   └── Sphere.clear.test.ts
│   ├── l1/
│   │   ├── address.test.ts
│   │   ├── addressHelpers.test.ts
│   │   ├── addressToScriptHash.test.ts
│   │   ├── crypto.test.ts
│   │   ├── L1PaymentsHistory.test.ts
│   │   ├── tx.test.ts
│   │   └── vesting.test.ts
│   ├── modules/
│   │   ├── TokenSplitCalculator.test.ts
│   │   ├── TokenSplitExecutor.test.ts
│   │   ├── PaymentsModule.test.ts
│   │   ├── NametagMinter.test.ts
│   │   └── CommunicationsModule.storage.test.ts
│   ├── price/
│   │   └── CoinGeckoPriceProvider.test.ts
│   ├── transport/
│   │   └── NostrTransportProvider.test.ts
│   ├── serialization/
│   │   ├── txf-serializer.test.ts
│   │   ├── wallet-text.test.ts
│   │   └── wallet-dat.test.ts
│   └── impl/
│       ├── browser/
│       │   └── IndexedDBStorageProvider.test.ts
│       └── shared/
│           └── resolvers.test.ts
├── integration/
│   ├── wallet-import-export.test.ts
│   └── nametag-roundtrip.test.ts
└── fixtures/
    └── test-vectors.ts
```

Example test:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic } from '../../../core/crypto';

describe('generateMnemonic()', () => {
  it('should generate valid 12-word mnemonic', () => {
    const mnemonic = generateMnemonic(12);
    const words = mnemonic.split(' ');

    expect(words).toHaveLength(12);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });
});
```
