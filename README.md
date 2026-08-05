# Sphere SDK

A modular TypeScript SDK for Unicity wallet operations (Unicity state transition network).

## Features

- **Wallet Management** - BIP39/BIP32 key derivation; optional password encryption (PBKDF2)
- **Payments** - Engine-certified token transfers over the **wallet-api vertical** (durable server-side intents, mailbox delivery, crash-safe resume under the same transferId); server custody — the backend holds inventory, keys stay local
- **Payment Requests** - Request payments over the wallet-api rail with encrypted memos and durable settling
- **Market (Intents)** - Signed intent bulletin board with semantic search and live feed
- **Group Chat** - NIP-29 relay-based group messaging with moderation
- **Messaging (Nostr)** - NIP-17 DMs + NIP-29 group chat and nametag publishing — **messaging only; not the payment rail**
- **Multi-Address** - HD address derivation (BIP32/BIP44)
- **Connect Protocol** - dApp ↔ wallet communication via `ConnectClient` / `ConnectHost` (browser extension + popup)
- **CLI** - Comprehensive command-line interface with shell auto-completion

## Installation

```bash
npm install @unicitylabs/sphere-sdk
```

## Quick Start Guides

Choose your platform:

| Platform | Guide | Required | Optional |
|----------|-------|----------|----------|
| **Browser** | [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) | SDK only | IndexedDB storage |
| **Node.js** | [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) | SDK + `ws` | File storage |
| **CLI** | [@unicity-sphere/cli](https://github.com/unicity-sphere/sphere-cli) | Separate package | - |
| **dApp integration** | [CONNECT.md](docs/CONNECT.md) | SDK only | Sphere extension |

## CLI (Command Line Interface)

The CLI has moved to a dedicated package: [`@unicity-sphere/cli`](https://github.com/unicity-sphere/sphere-cli).

```bash
npm install -g @unicity-sphere/cli
sphere --help
```

See [docs/QUICKSTART-CLI.md](docs/QUICKSTART-CLI.md) for the full command reference.

## Quick Start

> **Setup is two provider layers, not one.** `createBrowserProviders` / `createNodeProviders`
> build only the **base** (storage + transport + oracle). You **must** then attach the wallet-api
> transport config with `createWalletApiProviders` — money moves only through the wallet-api
> vertical. Skipping it fails loudly: `Sphere.init` throws `INVALID_CONFIG`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// 1. Base providers: storage + transport + oracle. `network` is REQUIRED here (no default).
//    The testnet2 gateway key is PUBLIC (not a secret); it is required at runtime for send/mint.
const base = createBrowserProviders({
  network: 'testnet',                                          // alias of testnet2 (networkId 4)
  oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },   // public testnet2 key
});

// 2. Attach the wallet-api transport config. Returns { ...base, walletApi } —
//    a plain config object ({ network, baseUrl, deviceId?, ... }) that Sphere.init consumes.
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',   // your wallet-api deployment (testnet2)
  network: 'testnet2',
  deviceId: 'my-stable-device-id',                 // persist this to avoid re-auth each launch
});

// 3. Init the wallet (auto-creates one if none exists).
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});
if (created && generatedMnemonic) {
  console.log('SAVE THIS RECOVERY PHRASE:', generatedMnemonic);
}

// 4. Send — engine-driven, certified on-chain. The recipient needs a published identity
//    (chain pubkey), e.g. a registered Unicity ID; otherwise send fails with INVALID_RECIPIENT.
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',     // decimal STRING — never a JS number
  coinId: 'UCT',         // a symbol auto-resolves to its hex coinId
  memo: 'hello',
});
console.log(result.status);   // 'completed'
// result.deliveryPending === true is NORMAL, not a failure: the token is certified on-chain but
// the recipient's mailbox delivery was deferred and will land on retry (see "Send result" below).

// 5. Receive — incoming transfers land automatically while the wallet runs (mailbox drain +
//    wake socket). To drain explicitly (e.g. a CLI/batch app), call receive():
const { transfers } = await sphere.payments.receive();
sphere.on('transfer:incoming', (t) => console.log('received from', t.senderNametag));

console.log(await sphere.payments.assets());
```

### What just happened (the provider model)

A wallet is composed from **swappable ports**, layered in two steps:

| Layer | Built by | What it supplies |
|-------|----------|-------------------|
| **Base** | `createBrowserProviders` / `createNodeProviders` | `storage` (keys/identity/journals), `transport` (Nostr — **messaging/nametags only**), `oracle` (gateway/trust base) |
| **wallet-api transport** | `createWalletApiProviders(base, …)` | `walletApi` — the transport CONFIG (`{ network, baseUrl, deviceId?, fetchFn?, webSocketFactory?, paymentsV2Transport? }`) the payments vertical is composed from |

- **The rail is wallet-api, not Nostr.** Transfers are certified on-chain by the token engine and the finished token is deposited into the recipient's **wallet-api mailbox**. Nostr carries messaging/nametags — **it does not move payments.**
- **Custody is server-side.** The wallet-api backend holds your token inventory; your keys never leave the client. (Own-storage custody was rescinded — there is no local token store.)
- **The money ports are contract-enforced.** `StoragePort`/`DeliveryPort` (`modules/payments-v2/ports.ts`) have wallet-api implementations; the `paymentsV2Transport` seam in the `walletApi` config lets tests/custom hosts inject a whole replacement bundle.
- **`network` placement.** Required on `createBrowserProviders`/`createNodeProviders` AND in the `walletApi` config (init throws `INVALID_CONFIG` without either); optional/informational on `Sphere.init`.

For manual/advanced provider wiring, see [Custom Providers Configuration](#custom-providers-configuration). For the deeper integration guide, see [docs/INTEGRATION.md](docs/INTEGRATION.md).

### Send result (`TransferResult`)

`send()` resolves with a `TransferResult`:

| Field | Meaning |
|-------|---------|
| `status` | `'completed'` on success. (`'pending' \| 'submitted' \| 'confirmed' \| 'delivered' \| 'failed'` also exist for in-flight/terminal states.) |
| `deliveryPending` | `true` when the spend is **certified on-chain** but the recipient's **mailbox delivery was deferred** (a full inbox / transient outage). **This is success, not failure** — the token is finalized and the finished blob is journaled and re-delivered automatically. |
| `deliveryState` | `'landed'` (delivered) or `'pending-delivery'` (deferred, as above). |

Treat `status === 'completed'` as sent. Use `deliveryPending` only to show a "delivery pending" hint — never as an error. A stale-but-spent source is self-healed (the next live coin is selected automatically).

#### Handling `send()` rejections — `CERTIFICATION_UNCONFIRMED` is NOT re-sendable (money-safety)

`send()` throws for genuine failures (`INVALID_RECIPIENT`, insufficient balance, a `TransferConflictError` lost race) **and** for one *indeterminate* case you must handle specially: a **`ProofUnconfirmedError`** (`code: 'CERTIFICATION_UNCONFIRMED'`, `mayHaveCertified: true`). It means the spend **may already be on-chain** but the proof fetch was inconclusive — the SDK keeps the intent **open** and completes it later under the **same `transferId`**.

- ⚠️ **Never re-issue `send()` on `CERTIFICATION_UNCONFIRMED`.** A fresh `send()` mints a new `transferId` on a *different* source, so the original resumes **and** the retry sends → **the recipient is double-paid.** Treat it as *"sent, pending confirmation."*
- **Recovery is automatic.** The open intent is replayed under the same `transferId` (recovers the proof + delivery, or records the spend if a rival tx won; **never a second spend**): partially-committed outcomes converge in-process, and every remaining open intent is resumed when the vertical starts (`Sphere.init` / `Sphere.load` / an address switch). There is no public resume API to call.

```ts
import { isSphereError } from '@unicitylabs/sphere-sdk';

try {
  const result = await sphere.payments.send({ recipient: '@bob', amount, coinId });
  // result.status === 'completed' (or result.deliveryPending === true) → sent
} catch (err) {
  if (isSphereError(err) && err.code === 'CERTIFICATION_UNCONFIRMED') {
    // Possibly already sent on-chain — DO NOT re-send. Resume finishes it.
  } else {
    // genuine failure — safe to surface to the user / retry
  }
}
```

## Network Configuration

The SDK ships network presets that configure all services automatically. `network` is **required** — there is no default:

| Network | Aggregator (gateway) | Nostr Relay |
|---------|----------------------|-------------|
| `testnet` | gateway.testnet2.unicity.network (v2) | nostr-relay.testnet.unicity.network |
| `testnet2` | alias of `testnet` (same configuration) | nostr-relay.testnet.unicity.network |
| `mainnet` | aggregator.unicity.network (v1-era) | relay.unicity.network (+ public relays) |
| `dev` | dev-aggregator.dyndns.org (v1-era) | nostr-relay.testnet.unicity.network |

> **v1 → v2 cutover:** `testnet` now points at **testnet2**, the v2 state-transition gateway network (network id 4, taken from the trust base; own testnet2 token registry). The old `goggregator-test` testnet spoke the removed v1 protocol and is gone. `mainnet` and `dev` still point at v1-era aggregators — wallet operations that move money (`send`, `mint`) **fail loudly** (`AGGREGATOR_ERROR`) on those networks until their gateways are cut over to the v2 protocol. The transfer wire payload is the finished v2 token blob (raw `Token.toCBOR()`), deposited into the recipient's wallet-api mailbox.

```typescript
// Use testnet for all services
const providers = createBrowserProviders({ network: 'testnet' });

// Override specific services while using network preset
const providers = createBrowserProviders({
  network: 'testnet',
  oracle: { url: 'https://custom-gateway.example.com' }, // custom v2 gateway
});
```

### API Key

The SDK bundles **no default API key**. Pass the gateway key via `oracle: { apiKey }` — without it, gateway requests are unauthenticated and money movement on testnet2 fails.

```typescript
const providers = createBrowserProviders({
  network: 'testnet',
  oracle: { apiKey: 'sk_...' },
});
```

The **testnet2 key is not a secret** — it is published in [.env.example](.env.example) and safe to keep in docs and client code. A **mainnet** key, by contrast, IS a secret: keep it in your deploy environment only.

### Testnet2 endpoints (the values we build with)

The `testnet` preset wires most of these automatically — you only pass `network`, `oracle.apiKey`, and the wallet-api `baseUrl`. The full set, for reference and manual wiring:

| What | Value |
|------|-------|
| Network | `testnet` (alias `testnet2`), networkId **4** |
| **Aggregator / gateway** (token engine) | `https://gateway.testnet2.unicity.network` |
| **Aggregator API key** (public — **not** a secret) | `sk_ddc3cfcc001e4a28ac3fad7407f99590` |
| **wallet-api** (delivery + token storage) | `https://wallet-api.unicity.network` |
| **Nostr relay** (messaging / nametags) | `wss://nostr-relay.testnet.unicity.network` |
| **Group-chat relay** (NIP-29) | `wss://sphere-relay.unicity.network` |
| **Token registry** | `https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json` |

The aggregator key above is the **testnet2** key only and is safe in client code; a **mainnet** key is a real secret. `mainnet`/`dev` still point at v1-era aggregators and cannot serve the v2 engine yet (`AGGREGATOR_ERROR`).

## Price Provider (Optional)

Enable fiat price display by adding a `price` config. Currently supports CoinGecko API (free and pro tiers).

```typescript
// With CoinGecko (free tier, no API key)
const providers = createBrowserProviders({
  network: 'testnet',
  price: { platform: 'coingecko' },
});

// With CoinGecko Pro
const providers = createBrowserProviders({
  network: 'testnet',
  price: { platform: 'coingecko', apiKey: 'CG-xxx' },
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

// Assets with price data
const assets = await sphere.payments.assets();
// [{ coinId, symbol, totalAmount, priceUsd: 97500, fiatValueUsd: 975.00, change24h: 2.3, ... }]

// Total portfolio value in USD
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
```

Without `price` config, the price fields in `assets()` are `null`. All other functionality works normally.

You can also set the price provider after initialization — price is a composition-time property of the payments vertical, so verticals composed after the call (the next address switch) pick it up:

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: 'CG-xxx',
}));
```

## Test Tokens on Testnet (Self-Mint)

There is no faucet. On testnet you top up your wallet by **self-minting** fungible tokens via the v2 token engine — `mint(coinIdHex, amount)` mints a finished token directly to this wallet (journal-first: crash-safe, a replay converges idempotently):

```typescript
import { getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// Resolve the coin's hex id from the token registry (or pass a hex coinId directly)
const coinId = getCoinIdBySymbol('UCT');

const result = await sphere.payments.mint(coinId!, 1000n);
if (result.success) {
  console.log('Minted token:', result.tokenId);
} else {
  console.error('Mint failed:', result.error);
}
```

> **Note:** Minting requires a working v2 oracle config (trust base + gateway URL + API key) — it fails with an error result otherwise. See [API Key](#api-key) above.

## Multi-Address Support

The SDK supports HD (Hierarchical Deterministic) wallets with multiple addresses:

```typescript
// Get current address index
const currentIndex = sphere.getCurrentAddressIndex(); // 0

// Switch to a different address
await sphere.switchToAddress(1);
console.log(sphere.identity?.directAddress); // DIRECT://... (address at index 1)

// Register nametag for this address (independent per address)
await sphere.registerNametag('bob');

// Switch back to first address
await sphere.switchToAddress(0);

// Get nametag for specific address
const bobNametag = sphere.getNametagForAddress(1); // 'bob'

// Get all address nametags
const allNametags = sphere.getAllAddressNametags();
// Map { 0 => 'alice', 1 => 'bob' }

// Derive address without switching (for display/receiving)
const addr2 = sphere.deriveAddress(2);
console.log(addr2.address, addr2.publicKey);
```

### Identity Properties

**Important:** The DIRECT address is the primary address for the Unicity network.

```typescript
interface Identity {
  chainPubkey: string;         // 33-byte compressed secp256k1 public key
  directAddress?: string;      // DIRECT address (DIRECT://...) - PRIMARY ADDRESS
  ipnsName?: string;           // IPNS name for token sync
  nametag?: string;            // Registered nametag (@username)
}

// Access identity - use directAddress as primary
console.log(sphere.identity?.directAddress);    // DIRECT://0000be36... (PRIMARY)
console.log(sphere.identity?.nametag);          // alice (human-readable)
console.log(sphere.identity?.chainPubkey);      // 02abc123... (33-byte compressed)
```

### Address Change Event

```typescript
// Listen for address switches
sphere.on('identity:changed', (event) => {
  console.log('Switched to address index:', event.data.addressIndex);
  console.log('L3 address:', event.data.directAddress);
  console.log('Chain pubkey:', event.data.chainPubkey);
  console.log('Nametag:', event.data.nametag);
});

// Listen for nametag recovery (when importing wallet)
sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag from Nostr:', event.data.nametag);
});
```

## Payment Requests

Request payments from others over the wallet-api rail (`sphere.payments.requests`). Request memos ride an encrypted recipient-ECDH envelope; a `pay()` is durably `settling` before any possibly-committed error can surface, so a crash never double-pays:

```typescript
// Send a payment request
const result = await sphere.payments.requests.create('@bob', {
  coinId: 'UCT',
  amount: '1000000',
  memo: 'Payment for order #1234',
});

// Track status via the event stream
sphere.on('payment_request:updated', ({ id, status }) => {
  // status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
  if (id === result.requestId && status === 'paid') console.log('Payment received!');
});

// Handle incoming payment requests
sphere.on('payment_request:incoming', async (request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);

  // Accept and pay
  await sphere.payments.requests.pay(request.id);

  // Or decline (a server 403/409 propagates — a refused decline is not success)
  await sphere.payments.requests.decline(request.id);
});

// Current views + housekeeping
const open = sphere.payments.requests.list();
sphere.payments.requests.dismissProcessed();
```

## Group Chat (NIP-29)

Relay-based group messaging using the NIP-29 protocol. The module embeds its own Nostr connection separate from the wallet transport.

### Enabling Group Chat

```typescript
// Enable with network defaults (wss://sphere-relay.unicity.network)
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  groupChat: true,
});

// Enable with custom relay
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  groupChat: { relays: ['wss://my-nip29-relay.com'] },
});

// Access the module
const gc = sphere.groupChat!;
```

### Connection

```typescript
// Connect to the NIP-29 relay
await gc.connect();
console.log('Connected:', gc.getConnectionStatus());

// Check if current user is a relay admin
const isRelayAdmin = await gc.isCurrentUserRelayAdmin();
```

### Groups

```typescript
import { GroupVisibility } from '@unicitylabs/sphere-sdk';

// Create a public group
const group = await gc.createGroup({
  name: 'General',
  description: 'Public discussion',
});

// Create a private group
const privateGroup = await gc.createGroup({
  name: 'Team',
  visibility: GroupVisibility.PRIVATE,
});

// Create a write-restricted group (only admins/writers can post)
const announcements = await gc.createGroup({
  name: 'Announcements',
  writeRestricted: true,
});

// Discover and join
const available = await gc.fetchAvailableGroups(); // public groups on relay
await gc.joinGroup(group.id);

// Join private group with invite
await gc.joinGroup(privateGroup.id, inviteCode);

// List joined groups
const groups = gc.getGroups();

// Leave or delete
await gc.leaveGroup(group.id);
await gc.deleteGroup(group.id); // admin only
```

### Messaging

```typescript
// Send a message
const msg = await gc.sendMessage(group.id, 'Hello!');

// Reply to a message
await gc.sendMessage(group.id, 'Agreed', { replyToId: msg.id });

// Fetch messages from relay
const messages = await gc.fetchMessages(group.id, { limit: 50 });

// Get locally cached messages
const cached = gc.getMessages(group.id);

// Listen for new messages in real-time
const unsubscribe = gc.onMessage((message) => {
  console.log(`[${message.groupId}] ${message.senderPubkey}: ${message.content}`);
});
```

### Members & Moderation

```typescript
// Get members
const members = gc.getMembers(group.id);

// Check roles
gc.isCurrentUserAdmin(group.id);     // boolean
gc.isCurrentUserModerator(group.id); // boolean
await gc.canModerateGroup(group.id); // includes relay admin check
gc.canWriteToGroup(group.id);       // false if write-restricted and not admin/moderator

// Moderate (requires admin/moderator role)
await gc.kickUser(group.id, userPubkey, 'reason');
await gc.deleteMessage(group.id, messageId);
```

### Invites (Private Groups)

```typescript
// Create invite code (admin only)
const invite = await gc.createInvite(group.id);

// Share invite code, recipient joins with:
await gc.joinGroup(group.id, invite);
```

### Unread Counts

```typescript
const total = gc.getTotalUnreadCount();
gc.markGroupAsRead(group.id);
```

### Key Types

```typescript
interface GroupData {
  id: string;
  relayUrl: string;
  name: string;
  description?: string;
  visibility: GroupVisibility;  // 'PUBLIC' | 'PRIVATE'
  writeRestricted?: boolean;   // Only admins and moderators can post
  memberCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
  lastMessageText?: string;
}

interface GroupMessageData {
  id?: string;
  groupId: string;
  content: string;
  timestamp: number;
  senderPubkey: string;
  senderNametag?: string;
  replyToId?: string;
}

interface GroupMemberData {
  pubkey: string;
  groupId: string;
  role: GroupRole;  // 'ADMIN' | 'MODERATOR' | 'MEMBER'
  nametag?: string;
  joinedAt: number;
}
```

## Direct Messages (NIP-17)

End-to-end encrypted DMs via NIP-17 gift wrap, accessed through `sphere.communications`:

```typescript
// Send a DM (by nametag or pubkey)
await sphere.communications.sendDM('@alice', 'Hello!');

// Listen for incoming DMs
sphere.communications.onDirectMessage((msg) => {
  console.log(`From ${msg.senderNametag ?? msg.senderPubkey}: ${msg.content}`);
});
```

### DM History on Connect

By default, the SDK resumes from the last processed DM timestamp (persisted in storage). On first connect, it starts from "now" — no historical replay.

Use `dmSince` to control how far back to fetch DMs on first connect:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  dmSince: Math.floor(Date.now() / 1000) - 86400,  // last 24 hours
});
```

Once the SDK processes DMs, the timestamp is persisted and `dmSince` is ignored on subsequent connects.

### Ephemeral Mode (No Caching)

For anonymous agents or LLM bots that don't need message history, disable DM caching:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  communications: { cacheMessages: false },
});

// Stream-only: receive, process, forget
sphere.communications.onDirectMessage((msg) => {
  processAndReply(msg);
});

// sendDM still works — message is sent but not stored locally
await sphere.communications.sendDM('@alice', 'response');
```

When `cacheMessages` is `false`:
- `onDirectMessage()` handlers and `message:dm` events fire normally
- Messages are never stored in memory or persisted to storage
- `getConversation()` / `getConversations()` return empty results
- Deduplication is skipped (duplicate relay deliveries may trigger duplicate events)

## Alternative: Manual Create/Load

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import {
  createLocalStorageProvider,
  createNostrTransportProvider,
  createUnicityAggregatorProvider,
} from '@unicitylabs/sphere-sdk/impl/browser';

const storage = createLocalStorageProvider();
// Without config the transport defaults to mainnet relays — pass the
// testnet relay explicitly when pairing with the testnet2 gateway below.
const transport = createNostrTransportProvider({
  relays: ['wss://nostr-relay.testnet.unicity.network'],
});
// `network` (or `trustBaseUrl`) is required — it selects the trust base the
// v2 token engine is built from. The apiKey authenticates gateway requests.
const oracle = createUnicityAggregatorProvider({
  url: 'https://gateway.testnet2.unicity.network',
  apiKey: 'sk_...',
  network: 'testnet',
});

// The wallet-api transport config — REQUIRED for money (init throws INVALID_CONFIG without it)
const walletApi = {
  network: 'testnet2',
  baseUrl: 'https://wallet-api.unicity.network',
  deviceId: 'my-device',
};

// Check if wallet exists
if (await Sphere.exists(storage)) {
  // Load existing wallet
  const sphere = await Sphere.load({ storage, transport, oracle, walletApi });
} else {
  // Create new wallet with mnemonic
  const mnemonic = Sphere.generateMnemonic();
  const sphere = await Sphere.create({
    mnemonic,
    storage,
    transport,
    oracle,
    walletApi,
  });
  console.log('Save this mnemonic:', mnemonic);
}
```

## Import from Master Key (Legacy Wallets)

For wallets whose master key was extracted elsewhere (e.g. an older backup):

```typescript
// Import from master key + chain code (BIP32 mode)
const sphere = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  chainCode: '64-hex-chars-chain-code',
  basePath: "m/84'/1'/0'",  // BIP84 account path
  derivationMode: 'bip32',
  storage, transport, oracle, walletApi,
});

// Import from master key only (WIF HMAC mode)
const sphere = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  derivationMode: 'wif_hmac',
  storage, transport, oracle, walletApi,
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

## Core Utilities

The SDK exports commonly needed utility functions:

```typescript
import {
  // Crypto
  bytesToHex, hexToBytes,
  generateMnemonic, validateMnemonic,
  sha256,
  getPublicKey, createKeyPair,

  // Currency conversion
  parseTokenAmount,     // "1.5" → 1500000000000000000n (strict; throws on invalid input)
  safeParseTokenAmount, // like parseTokenAmount but returns null instead of throwing
  toHumanReadable,      // 1500000000000000000n → "1.5"
  formatAmount,         // Format with decimals and symbol

  // Base58 (Bitcoin-style)
  base58Encode, base58Decode,
  isValidPrivateKey,

  // General utilities
  sleep, randomHex, randomUUID,
  findPattern, extractFromText,
} from '@unicitylabs/sphere-sdk';
```

## Token format & verification

Tokens are opaque **v2 CBOR blobs** (`Token.sdkData` carries the hex when a blob is loaded). Inventory lives in the wallet-api backend; the SDK downloads blobs on demand (lazy tokens carry value metadata only until selected for a spend). Every incoming token is engine-verified (full trust-base proof check) and ownership-checked **before it enters the balance** — there is no separate validate step to run.

## Architecture

**Single Identity Model**: A single secp256k1 key pair backs the L3 identity. One mnemonic = one wallet.

```
mnemonic → master key → BIP32 derivation → identity
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        │              shared keys                  │
                        │  privateKey:   "abc..."  (hex secp256k1)  │
                        │  chainPubkey:  "02def..." (33-byte comp.) │
                        │  directAddress: "DIRECT://..." (L3)       │
                        └─────────────────────┬─────────────────────┘
                                              ↓
              ┌──────────────────┬──────────────────┐
              ↓                  ↓                  ↓
         L3 (Unicity)        Group Chat           Nostr
       sphere.payments    sphere.groupChat  sphere.communications
      Tokens, v2 engine   NIP-29 messaging    P2P messaging
```

```
Sphere (main entry point)
├── identity       - Wallet identity (address, publicKey, nametag)
├── payments       - The payments facade: assets/tokens/history/send/mint/receive/requests
├── market         - Intent bulletin board (via sphere.market)
├── groupChat      - NIP-29 group messaging (via sphere.groupChat)
└── communications - Direct messages & broadcasts

Payments vertical (modules/payments-v2/ — docs/PAYMENTS-V2-DESIGN.md)
└── PaymentsFacade over swappable money ports (StoragePort / DeliveryPort,
    contract-test-enforced) + TransferMachine (durable server-side intents,
    resume under the same transferId) + receive drain (verified before
    balance) + requests + paged history. Composed per address from the
    `walletApi` transport config (core/payments-v2-wiring.ts).

Token Engine (token-engine/)
└── The wallet's boundary to the v2 state-transition SDK: all mint /
    transfer / split / verify / spent-check operations go through the
    ITokenEngine port. Sphere builds the engine from the oracle's config
    (trust base JSON + gateway URL + API key); no state-transition SDK
    objects cross this boundary.

Providers (injectable)
├── StorageProvider      - Key-value persistence: keys/identity + the pv2:* scoped KV
├── TransportProvider    - Messaging (Nostr) — NOT the payment rail
├── OracleProvider       - Token-engine config (trust base JSON + gateway URL + API key)
└── walletApi (config)   - WalletApiTransportConfig — the wallet-api wire the
                           money ports are composed from (not a provider object)

Implementation (platform-specific)
├── impl/shared/            - Common interfaces & resolvers
├── impl/shared/wallet-api/ - createWalletApiProviders() → { ...base, walletApi }
├── impl/wallet-api-v2/     - The wallet-api wire: session (auth + wake WS), client,
│                             storage/mailbox/checkpoint port implementations
├── impl/browser/        - Browser base: LocalStorage/IndexedDB + createBrowserProviders()
└── impl/nodejs/         - Node.js base: File storage + createNodeProviders()

Core Utilities
├── crypto     - Key derivation, hashing, signatures
├── currency   - Amount formatting and conversion
└── utils      - Base58, patterns, sleep, random
```

## Shared Configuration Pattern

Both browser and Node.js implementations share common configuration interfaces and resolution logic:

```typescript
// Base interfaces (impl/shared/config.ts)
import type {
  BaseTransportConfig,  // Common transport options
  BaseOracleConfig,     // Common oracle options
  BaseProviders,        // Common result structure
} from '@unicitylabs/sphere-sdk/impl/shared';

// Resolver utilities (impl/shared/resolvers.ts)
import {
  getNetworkConfig,        // Get mainnet/testnet/dev config
  resolveTransportConfig,  // Apply extend/override pattern for relays
  resolveOracleConfig,     // Resolve oracle URL with fallback
  resolveArrayConfig,      // Generic array merge helper
} from '@unicitylabs/sphere-sdk/impl/shared';
```

### Extend/Override Pattern

The configuration resolution follows a consistent pattern across platforms:

```typescript
// Priority for arrays: replace > extend > defaults
const result = resolveArrayConfig(
  networkDefaults,    // ['a', 'b']
  config.relays,      // If set, replaces entirely
  config.additionalRelays  // If set, extends defaults
);

// Examples:
// No config → ['a', 'b'] (defaults)
// { relays: ['x'] } → ['x'] (replace)
// { additionalRelays: ['c'] } → ['a', 'b', 'c'] (extend)
```

### Platform-Specific Extensions

Each platform extends the base interfaces with platform-specific options:

```typescript
// Browser: adds reconnectDelay, maxReconnectAttempts
type TransportConfig = BaseTransportConfig & BrowserTransportExtensions;

// Node.js: adds trustBasePath for file-based trust base
type NodeOracleConfig = BaseOracleConfig & NodeOracleExtensions;
```

## Documentation

- [Integration Guide](./docs/INTEGRATION.md)
- [API Reference](./docs/API.md)

## Browser Providers

The SDK includes browser-ready provider implementations:

| Provider | Description |
|----------|-------------|
| `LocalStorageProvider` | Browser localStorage with SSR fallback |
| `NostrTransportProvider` | Nostr relay messaging with NIP-04 |
| `UnicityAggregatorProvider` | Network config for the v2 token engine (trust base + gateway URL + API key) |

## Node.js Providers

For CLI and server applications:

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// Quick start with testnet
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
});

const { sphere } = await Sphere.init({
  ...createWalletApiProviders(providers, { baseUrl: 'https://wallet-api.unicity.network', network: 'testnet2' }),
  autoGenerate: true,
});

// Full configuration
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  transport: {
    additionalRelays: ['wss://my-relay.com'],
    timeout: 10000,
    debug: true,
  },
  oracle: {
    apiKey: 'my-api-key',
    trustBasePath: './trustbase.json',  // Node.js specific
  },
});
```

### Manual Provider Creation

```typescript
import {
  FileStorageProvider,
  createNostrTransportProvider,
  createNodeTrustBaseLoader,
} from '@unicitylabs/sphere-sdk/impl/nodejs';

// File-based wallet storage (keys/identity/journals — tokens are server custody)
const storage = new FileStorageProvider('./wallet-data');

// Nostr with Node.js WebSocket
const transport = createNostrTransportProvider({
  relays: ['wss://relay.unicity.network'],
});

// Load trust base from local file
const trustBaseLoader = createNodeTrustBaseLoader('./trustbase-testnet.json');
const trustBase = await trustBaseLoader.load();
```

## Custom Providers Configuration

The SDK uses an **extend/override pattern** for flexible configuration:

| Option | Behavior |
|--------|----------|
| `relays` | **Replaces** default relays entirely |
| `additionalRelays` | **Adds** to default relays |
| `url` | **Replaces** default URL (uses network default if not set) |

```typescript
// Simple: use network preset
const providers = createBrowserProviders({ network: 'testnet' });

// Add extra relays to testnet defaults
const providers = createBrowserProviders({
  network: 'testnet',
  transport: {
    additionalRelays: ['wss://my-relay.com', 'wss://backup-relay.com'],
    // Result: testnet relay + my-relay + backup-relay
  },
});

// Replace relays entirely (ignores network defaults)
const providers = createBrowserProviders({
  network: 'testnet',
  transport: {
    relays: ['wss://only-this-relay.com'],
    // Result: only-this-relay (testnet default ignored)
  },
});

// Override aggregator, keep other testnet defaults
const providers = createBrowserProviders({
  network: 'testnet',
  oracle: {
    url: 'https://my-aggregator.com',  // replaces testnet aggregator
    apiKey: 'my-api-key',
  },
});

// Full custom configuration
const providers = createBrowserProviders({
  network: 'testnet',
  storage: {
    prefix: 'myapp_',
  },
  transport: {
    additionalRelays: ['wss://extra-relay.com'],
    timeout: 15000,
    autoReconnect: true,
    debug: true,
  },
  oracle: {
    url: 'https://custom-aggregator.com',
    apiKey: 'secret',
    timeout: 60000,
  },
});

```


## Custom Money Transport (Advanced)

Token custody is the wallet-api backend — there is no local token store to swap. What IS swappable is the money transport: the `paymentsV2Transport` seam in the `walletApi` config injects a whole per-address bundle (session + wire client) in place of the default HTTP+WebSocket wire. This is how the SDK's own offline test suites run. The port contracts live in `modules/payments-v2/ports.ts` (`StoragePort`, `DeliveryPort`) with conformance suites under `tests/unit/payments-v2/contracts/`.

```typescript
const providers = createWalletApiProviders(base, {
  network: 'testnet2',
  // Instead of baseUrl — supply the transport yourself:
  paymentsV2Transport: (args) => myTransportBundle(args), // { session, client }
});
```

## Dynamic Relay Management

Nostr relays can be added or removed at runtime through the transport provider:

```typescript
const transport = sphere.getTransport();

// Get current relays
const configuredRelays = transport.getRelays();       // All configured
const connectedRelays = transport.getConnectedRelays(); // Currently connected

// Add a new relay (connects immediately if provider is connected)
await transport.addRelay('wss://new-relay.com');

// Remove a relay (disconnects if connected)
await transport.removeRelay('wss://old-relay.com');

// Check relay status
transport.hasRelay('wss://relay.com');         // Is configured?
transport.isRelayConnected('wss://relay.com'); // Is connected?
```

### Relay Events

```typescript
// Listen for relay changes
sphere.on('transport:relay_added', (event) => {
  console.log(`Relay added: ${event.data.relay}`);
  console.log(`Connected: ${event.data.connected}`);
});

sphere.on('transport:relay_removed', (event) => {
  console.log(`Relay removed: ${event.data.relay}`);
});

sphere.on('transport:error', (event) => {
  console.log(`Transport error: ${event.data.error}`);
});
```

### UI Integration Example

```typescript
// User adds relay via settings UI
async function handleAddRelay(relayUrl: string) {
  const transport = sphere.getTransport();

  if (transport.hasRelay(relayUrl)) {
    showError('Relay already configured');
    return;
  }

  const success = await transport.addRelay(relayUrl);
  if (success) {
    showSuccess(`Added ${relayUrl}`);
  } else {
    showWarning(`Added but failed to connect to ${relayUrl}`);
  }
}

// User removes relay via settings UI
async function handleRemoveRelay(relayUrl: string) {
  const transport = sphere.getTransport();
  await transport.removeRelay(relayUrl);
  showSuccess(`Removed ${relayUrl}`);
}

// Display relay status in UI
function getRelayStatuses() {
  const transport = sphere.getTransport();
  return transport.getRelays().map(relay => ({
    url: relay,
    connected: transport.isRelayConnected(relay),
  }));
}
```

## Nametags (Unicity IDs)

Nametags provide human-readable addresses (e.g., `@alice`) for receiving payments. Valid formats: lowercase alphanumeric with `_` or `-` (3–20 chars), or E.164 phone numbers (e.g., `+14155552671`). Input is normalized to lowercase automatically.

**How registration works:** registering a nametag publishes a **Nostr identity binding** (name ↔ chain pubkey). Uniqueness is first-seen-wins — a name is available iff no binding already resolves for it (`sphere.isNametagAvailable(name)`). Runtime name resolution is binding-only; payments always go to the recipient's key-based `DIRECT://` address (there are no PROXY addresses).

In addition, a self-issued v2 `UnicityIdToken` (the on-chain claim) is minted and stored **best-effort** at registration — a gateway outage or missing v2 oracle config never fails registration; the mint is retried on the next load, and the token is not consumed anywhere at runtime yet.

### Registering a Nametag

```typescript
// During wallet creation
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  nametag: 'alice',  // Will register @alice
});

// Or after creation
await sphere.registerNametag('alice');

// Check availability first
const free = await sphere.isNametagAvailable('alice');
```

### Common Pitfall: Nametag Already Taken

If you see this error:
```
Failed to register Unicity ID. It may already be taken.
```

This means the nametag is registered (bound on Nostr) to a **different public key**. Common causes:

1. **Storage cleared or not persisting**:
   - `Sphere.exists()` returns `false` because storage is empty/inaccessible
   - SDK creates a new wallet with new keypair
   - Nametag registration fails because old pubkey owns it on Nostr

2. **Different mnemonic provided**:
   ```typescript
   // ❌ WRONG: Random mnemonic each time
   const mnemonic = Sphere.generateMnemonic();
   const { sphere } = await Sphere.init({
     mnemonic,
     nametag: 'myservice',  // Fails after first run
   });
   ```

**Note:** `autoGenerate: true` does NOT generate a new mnemonic on every restart. It only generates one if `Sphere.exists()` returns `false` (wallet not found in storage).

### Solution: Persistent Storage or Fixed Mnemonic

**Option 1: Persistent file storage** (recommended for backend):

```typescript
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data');  // Persists to disk

const { sphere } = await Sphere.init({
  storage,
  autoGenerate: true,  // OK: mnemonic saved to disk, reused on restart
  nametag: 'myservice',
});
```

**Option 2: Fixed mnemonic from environment**:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: process.env.WALLET_MNEMONIC,  // Same mnemonic every time
  nametag: 'myservice',
});
```

### Debugging Storage Issues

If nametag fails unexpectedly, check if wallet exists:

```typescript
const exists = await Sphere.exists(storage);
console.log('Wallet exists:', exists);  // Should be true after first run

// If false - storage is not persisting properly
```

### Nametag Recovery on Import

When importing a wallet (from mnemonic or file), the SDK automatically attempts to recover the nametag from Nostr:

```typescript
// Import wallet - nametag will be recovered automatically if found on Nostr
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your twelve words...',
  // No nametag specified - will try to recover from Nostr
});

// Listen for recovery event
sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag:', event.data.nametag);  // e.g., 'alice'
});

// After init, check if nametag was recovered
console.log(sphere.identity?.nametag);  // 'alice' (if found on Nostr)
```

### Multi-Address Nametags

Each derived address can have its own independent nametag:

```typescript
// Address 0: @alice
await sphere.registerNametag('alice');

// Switch to address 1 and register different nametag
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');

// Now:
// - Address 0 → @alice
// - Address 1 → @bob

// Get nametag for specific address
const aliceTag = sphere.getNametagForAddress(0);  // 'alice'
const bobTag = sphere.getNametagForAddress(1);    // 'bob'
```

---

## Wallet Security & Encryption

The wallet seed can be encrypted with a **user password** — PBKDF2-derived key, 100k iterations
(`core/encryption.ts`). Pass `password` to `Sphere.init` / `Sphere.create` / `Sphere.load`:

```typescript
// Init/create with a password — the seed is encrypted at rest under a PBKDF2-derived key.
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true, password: userPassword });

// Loading later requires the same password.
const { sphere } = await Sphere.load({ ...providers, password: userPassword });

// Encrypted JSON export/import use the same scheme.
const encrypted = sphere.exportToJSON({ password: userPassword });
```

If no `password` is supplied, the seed is stored under a built-in default key
(`DEFAULT_ENCRYPTION_KEY`) — that is obfuscation at rest, **not** a substitute for a user password.
Supply a password for any wallet holding real value.

## License

MIT
