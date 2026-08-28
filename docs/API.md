# Sphere SDK API Reference

> **0.15.0 surface changes.** `sphere.paymentsV2` and the `paymentsV2: true` init flag are
> **removed** — `sphere.payments` is the only accessor, and it **throws**
> `SphereError('NOT_INITIALIZED')` where the alias returned `null` (see
> [Payments](#payments-spherepayments--the-paymentsv2-facade)). The base SDK pin moved to
> `@unicitylabs/state-transition-sdk@3.0.1`, a wire break that no 2.x client can straddle —
> README's [flag-day section](../README.md#0150--the-state-transition-sdk-301-flag-day) has the
> operational consequences. Nothing on this page's method signatures changed with the pin.

## Sphere

Main entry point for all SDK operations. The constructor is **private** — use static methods to create/load wallets.

### Static Methods

#### `Sphere.init(options: SphereInitOptions): Promise<SphereInitResult>`

Primary entry point. Creates a new wallet or loads an existing one automatically.

```typescript
const { sphere, created, generatedMnemonic } = await Sphere.init({
  storage, transport, oracle,
  walletApi,                 // REQUIRED: wallet-api transport config
                             //   { network, baseUrl, deviceId?, fetchFn?, webSocketFactory?,
                             //     paymentsV2Transport? } — createWalletApiProviders builds it;
                             //   init throws INVALID_CONFIG without it (money moves only
                             //   through the wallet-api vertical)
  autoGenerate: true,        // Generate mnemonic if no wallet exists
  mnemonic: 'words...',      // Or provide mnemonic to create/import
  password: 'secret',        // Optional: encrypt mnemonic (plaintext if omitted)
  nametag: 'alice',          // Optional: register @alice on create
  price: priceProvider,      // Optional PriceProvider
  derivationPath: "m/44'/0'/0'", // Optional custom path
  dmSince: Math.floor(Date.now() / 1000) - 86400, // Optional: DM history fallback (unix seconds)
});
```

**Removed options:** `accounting: true` / `swap: true` **throw** a typed `INVALID_CONFIG` —
invoicing and swaps no longer exist in the SDK, and that refusal is kept deliberately through
0.15.0 (a silent no-op would hide the removal in exactly the release where consumers
re-integrate). `paymentsV2: true` was a deprecated no-op and is **gone in 0.15.0** — passing it
is an excess-property error against `SphereInitOptions`, not a runtime refusal. `tokenStorage` /
`delivery` no longer exist (token custody is the wallet-api backend).

**Password encryption behavior:**
- **No password (default):** Mnemonic stored as plaintext in storage.
- **Password provided on create:** Mnemonic encrypted with AES before storing.
- **Password provided on load:** Decrypts the stored mnemonic. Throws `'Failed to decrypt mnemonic'` if wrong password.
- **Backwards compatibility:** Wallets encrypted with older SDK versions (internal default key) load correctly without a password.

#### `Sphere.exists(storage: StorageProvider): Promise<boolean>`

Check if wallet data exists in storage.

#### `Sphere.create(options: SphereCreateOptions): Promise<Sphere>`

Create wallet from a known mnemonic (low-level; prefer `Sphere.init()`).

#### `Sphere.load(options: SphereLoadOptions): Promise<Sphere>`

Load existing wallet from storage (low-level; prefer `Sphere.init()`).

#### `Sphere.clear(options: { storage: StorageProvider }): Promise<void>`

Delete all SDK-owned wallet data: the KV store (keys, identity, and the `pv2g2:*` payment
journals). In the browser it also sweeps orphaned pre-flip `sphere-token-storage-*`
IndexedDB databases.

This is a wipe, not a migration step: it clears the store with no prefix, so it takes the
mnemonic with it. The 0.15.0 scoped-KV generation bump needs nothing from you — the superseded
`pv2:` keys are swept once when the vertical is composed.

```typescript
await Sphere.clear({ storage: providers.storage });
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `identity` | `FullIdentity \| null` | Current wallet identity (after init/load) |
| `payments` | `PaymentsV2` | The payments facade (assets/tokens/history/send/mint/receive/requests). **Throws** `NOT_INITIALIZED` while no vertical runs — init in flight, mid address-switch, or destroyed |
| `communications` | `CommunicationsModule` | Messaging operations |
| `groupChat` | `GroupChatModule \| null` | NIP-29 group chat (null unless enabled) |
| `market` | `MarketModule \| null` | Market intents (null unless enabled) |

### Instance Methods

#### `signMessage(message: string): string`

Sign an arbitrary message using the wallet's private key (secp256k1 ECDSA with recoverable signature).

Returns a 130-character hex string: `v` (2 chars) + `r` (64 chars) + `s` (64 chars). The recovery byte `v = 31 + recoveryParam`.

```typescript
const signature = sphere.signMessage('Sign in to My App\n\nNonce: abc123');
// → '1f3a5b7c...' (130 hex chars)
```

The private key never leaves the SDK. Use `verifySignedMessage()` to verify on the server side.

#### `destroy(): Promise<void>`

Cleanup and disconnect all providers.

#### `on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void`

Subscribe to events. Returns unsubscribe function. Type-safe — see `SphereEventMap` for event payloads.

#### `deriveAddress(index: number, isChange?: boolean): AddressInfo`

Derive address at a specific index using HD derivation.

```typescript
// Derive first receiving address
const addr0 = sphere.deriveAddress(0);
console.log(addr0.address); // DIRECT://...

// Derive change address
const change = sphere.deriveAddress(0, true);
```

#### `deriveAddressAtPath(path: string): AddressInfo`

Derive address at a full BIP32 path.

```typescript
const addr = sphere.deriveAddressAtPath("m/44'/0'/0'/0/5");
```

#### `deriveAddresses(count: number, includeChange?: boolean): AddressInfo[]`

Derive multiple addresses starting from index 0.

```typescript
// Get first 5 receiving addresses
const addresses = sphere.deriveAddresses(5);

// Get 5 receiving + 5 change addresses
const allAddresses = sphere.deriveAddresses(5, true);
```

#### `getBasePath(): string`

Get the base derivation path (default: `m/44'/0'/0'`).

#### `getDefaultAddressPath(): string`

Get the default address path (`m/44'/0'/0'/0/0`).

#### `hasMasterKey(): boolean`

Check if wallet has BIP32 master key for HD derivation.

#### `getCurrentAddressIndex(): number`

Get the current active address index.

#### `switchToAddress(index: number): Promise<void>`

Switch the active identity to a different HD-derived address. Automatically tracks the address in the registry.

```typescript
await sphere.switchToAddress(1);
console.log(sphere.getCurrentAddressIndex()); // 1
console.log(sphere.identity!.directAddress);  // DIRECT://... (address at index 1)
```

#### `getActiveAddresses(): TrackedAddress[]`

Get all non-hidden tracked addresses, sorted by index.

```typescript
const addresses = sphere.getActiveAddresses();
for (const addr of addresses) {
  console.log(`#${addr.index}: ${addr.directAddress} (${addr.nametag ?? 'no nametag'})`);
}
```

#### `getAllTrackedAddresses(): TrackedAddress[]`

Get all tracked addresses including hidden ones, sorted by index.

#### `getTrackedAddress(index: number): TrackedAddress | undefined`

Get a single tracked address by HD index.

#### `setAddressHidden(index: number, hidden: boolean): Promise<void>`

Hide or unhide a tracked address. Hidden addresses are excluded from `getActiveAddresses()`.

```typescript
await sphere.setAddressHidden(1, true);   // hide
await sphere.setAddressHidden(1, false);  // unhide
```

#### `resolve(identifier: string): Promise<PeerInfo | null>`

Resolve any identifier to full peer information. Delegates to the transport provider.

```typescript
// By nametag
const peer = await sphere.resolve('@alice');

// By DIRECT address
const peer = await sphere.resolve('DIRECT://000059756bc9c2e4c...');

// By chain pubkey (33-byte compressed, 02/03 prefix)
const peer = await sphere.resolve('025412bda2c5b5a15a891c6...');

// By transport pubkey (32-byte hex)
const peer = await sphere.resolve('a1b2c3d4e5f6...');
```

Returns `PeerInfo`:

```typescript
interface PeerInfo {
  nametag?: string;        // @name if registered
  transportPubkey: string; // 32-byte transport key
  chainPubkey: string;     // 33-byte compressed secp256k1
  directAddress: string;   // DIRECT://... L3 address
  timestamp: number;       // Binding event timestamp
}
```

---

## Payments (`sphere.payments` — the PaymentsV2 facade)

The payments vertical (design: `docs/PAYMENTS-V2-DESIGN.md`). Money custody is the
wallet-api backend: token inventory, transfer intents, the delivery mailbox, history and
payment requests live server-side; the client holds keys and a small per-address durable
KV (`pv2g2:{network}:{chainPubkey}:*` — refresh token, cursors, seen-set, journals). The `g2`
generation is 0.15.0's: the prefix rename IS the migration across the base-SDK wire break, and
the superseded `pv2:` keys are swept once at composition.

**`sphere.paymentsV2` is removed** (0.15.0), together with the `paymentsV2: true` init flag.
`sphere.payments` is the same facade the alias returned, with one behavioural difference that
matters at the call site: where the alias evaluated to `null` while no vertical was running, the
getter **throws** `SphereError` with `code: 'NOT_INITIALIZED'`. Code written as
`sphere.paymentsV2?.tokens() ?? []` silently degraded before and now throws — rewrite it to read
the facade only after `Sphere.init()` resolves, or catch that one code where you used to check
for `null`.

### How Transfers Work (sender-driven)

```
  ┌─────────┐  putIntent → engine.transfer/split  ┌──────────┐
  │  Sender  │ ───────────────────────────────────>│ Gateway   │  certify on-chain,
  └────┬─────┘   (durable intent FIRST; per-op     └──────────┘  inclusion proof
       │          signed progress checkpoints)
       │  finished token blob (raw Token.toCBOR()) → recipient's wallet-api MAILBOX
       └────────────────────────────────────────────> Recipient
                     verifies (engine.verify + ownership) BEFORE balance → 'confirmed'
```

- The intent is durable on the server **before** any chain op; a crash at any stage resumes
  the SAME `transferId` inside the facade's start — never a second spend.
- Whole-token transfers use `engine.transfer`; partial amounts use `engine.split` (recipient
  output + change certified in one on-chain operation; split progress is checkpointed
  server-side, field-encrypted and signed).
- A certified-but-undelivered blob is journaled locally (#621) and re-deposited with a bounded
  poison budget (#517) — `deliveryPending: true` on the result, `transfer:attention` when
  deferred/undeliverable.
- **Requirements:** the token engine must be available (oracle supplies a trust base +
  gateway URL; otherwise `AGGREGATOR_ERROR`), and the recipient must have a published chain
  pubkey (otherwise `INVALID_RECIPIENT`).

### `send(req: SendRequest): Promise<TransferResult>`

```typescript
interface SendRequest {
  recipient: string;    // @nametag, hex chain pubkey, or DIRECT:// address
  amount: string;       // Amount in smallest units (decimal string)
  coinId: string;       // Coin type (64-hex canonical; short symbols resolve via registry)
  memo?: string;        // Optional message (recipient-encrypted envelope)
}

interface TransferResult {
  readonly id: string;                       // transferId
  status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';
  readonly tokens: Token[];
  readonly tokenTransfers: TokenTransferDetail[];  // { sourceTokenId, method: 'direct'|'split' }
  error?: string;
  deliveryPending?: boolean;                 // certified on-chain, mailbox deposit still owed — NOT a failure
  deliveryState?: 'landed' | 'pending-delivery';
}
```

```typescript
const result = await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId: 'UCT' });
console.log(result.status);          // 'completed'
console.log(result.deliveryPending); // true when certified but delivery deferred (normal)
```

**Money-safety on rejection:** a `ProofUnconfirmedError` (`code: 'CERTIFICATION_UNCONFIRMED'`)
means the spend MAY be on-chain — the intent stays OPEN and converges automatically (in-process
or at the next start). **Never re-issue `send()`** for it: a fresh transferId on a different
source double-pays the recipient. `isPossiblyCommittedSendOutcome()` classifies error codes.
A clean conflict (`TransferConflictError`) demotes the stale source (`suspectedSpent`, excluded
from selection, recoverable by resync) and re-plans once.

**Events:** `transfer:updated` (every status change), `transfer:attention` (needs operator
attention), `inventory:updated`, `history:updated`.

### `receive(): Promise<{ transfers: IncomingTransfer[] }>`

Explicit one-shot drain of the wallet-api mailbox. While the wallet runs, the mailbox is also
drained continuously (wake WebSocket + poll) — `receive()` exists for batch/CLI flows.

Every incoming token is **verified before entering the balance** (`engine.verify` against the
trust base + ownership check against this wallet's chain pubkey); dedup is by genesis-stable
tokenId via a durable seen-set; the token is stored BEFORE the mailbox claim is acknowledged,
so a crash re-claims instead of losing.

```typescript
const { transfers } = await sphere.payments.receive();
sphere.on('transfer:incoming', (t) => console.log('from', t.senderNametag));
```

### `assets(coinId?: string): Promise<Asset[]>`

Aggregated balances by coin (server read-through), with price data when a `PriceProvider` is
configured. The `Asset` shape is unchanged from pre-flip releases: `unconfirmedAmount` /
`unconfirmedTokenCount` are pinned `'0'` / `0` (nothing is ever unconfirmed in server custody);
`transferringAmount` / `transferringTokenCount` still report in-flight sends (excluded from
`totalAmount`).

```typescript
const assets = await sphere.payments.assets();
const uct = await sphere.payments.assets(coinIdHex);
const totalUsd = assets.reduce((s, a) => s + (a.fiatValueUsd ?? 0), 0);
```

### `tokens(filter?: { coinId?: string }): Token[]`

Synchronous inventory view. Lazy tokens (blob not yet downloaded) carry value metadata only;
the blob is fetched on demand when the token is selected for a spend.

```typescript
const all = sphere.payments.tokens();
const uctOnly = sphere.payments.tokens({ coinId: coinIdHex });
```

### `mint(coinIdHex: string, amount: bigint): Promise<MintResult>`

Self-mint fungible tokens to this wallet via the token engine (no faucet). **Journal-first**:
the mint journal entry is durable before the chain op, and a replay converges by idempotent
same-seed re-call — crash-safe.

```typescript
const result = await sphere.payments.mint(coinIdHex, 1_000_000n);
// { success: true, tokenId } | { success: false, error }
```

- `coinIdHex` must be even-length lowercase hex; `amount` must be `> 0n`.
- Returns an error result instead of throwing when the engine is unavailable.

### `history(page?: { before?: string; limit?: number }): Promise<HistoryPage>`

Server read-through, paged, newest-first.

```typescript
interface HistoryEntry {
  id: string;
  type: 'SENT' | 'RECEIVED' | 'MINT';
  coinId: string;
  amount: string;
  symbol?: string;
  timestamp: number;
  memo?: string;
  transferId?: string;
  tokenId?: string;
  senderPubkey?: string;    senderNametag?: string;
  recipientPubkey?: string; recipientNametag?: string;
  tokenIds?: { id: string; amount: string }[];
}

interface HistoryPage {
  entries: HistoryEntry[];
  more: boolean;
  cursor: string | null;   // pass as `before` for the next page
}

const page = await sphere.payments.history({ limit: 50 });
const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });
```

`TransactionHistoryEntry` (the root export) remains as an alias of the storage-level
`HistoryRecord` shape for UI code that types history rows.

### Payment Requests (`sphere.payments.requests`)

Requests ride the wallet-api rail; the memo travels in a recipient-ECDH encrypted envelope.

```typescript
interface PaymentsRequestsApi {
  create(to: string, terms: { coinId: string; amount: string; memo?: string }):
    Promise<{ success: boolean; requestId?: string; error?: string }>;
  list(): PaymentRequestView[];
  pay(id: string): Promise<TransferResult>;   // durably 'settling' BEFORE any
                                              // possibly-committed throw (#441)
  decline(id: string): Promise<void>;         // server 403/409 propagate
  dismissProcessed(): void;                   // drop terminal entries from list()
}

interface PaymentRequestView {
  id: string;
  requestId: string;
  senderPubkey: string;
  senderNametag?: string;
  amount: string;
  coinId: string;
  symbol?: string;
  message?: string;
  timestamp: number;
  status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired';
}
```

```typescript
await sphere.payments.requests.create('@bob', { coinId: 'UCT', amount: '1000000', memo: 'Order #1234' });

sphere.on('payment_request:incoming', (view) => { /* PaymentRequestView */ });
sphere.on('payment_request:updated', ({ id, status }) => { /* track outgoing + incoming */ });

await sphere.payments.requests.pay(id);
```

---

## CommunicationsModule

### Methods

#### `sendDM(recipient: string, content: string): Promise<DirectMessage>`

Send a direct message using NIP-17 gift wrapping (kind 1059). The recipient can be a `@nametag` or a hex public key. Content is wrapped in the Sphere messaging format (`{senderNametag, text}`) for compatibility with the Sphere app.

```typescript
interface DirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}
```

#### `getConversation(peerPubkey: string): DirectMessage[]`

#### `getConversations(): Map<string, DirectMessage[]>`

#### `markAsRead(messageIds: string[]): Promise<void>`

#### `getUnreadCount(peerPubkey?: string): number`

#### `broadcast(content: string, tags?: string[]): Promise<BroadcastMessage>`

#### `subscribeToBroadcasts(tags: string[]): () => void`

#### `getBroadcasts(limit?: number): BroadcastMessage[]`

#### `resolvePeerNametag(peerPubkey: string): Promise<string | undefined>`

Resolve a peer's nametag by their transport pubkey via live lookup from Nostr relay binding events. Returns `undefined` if the transport doesn't support resolution, the peer has no registered nametag, or the lookup fails. Useful as a fallback when no nametag is available in stored messages.

#### `onDirectMessage(handler: (msg: DirectMessage) => void): () => void`

Subscribe to incoming direct messages. Supports both NIP-17 gift-wrapped messages (kind 1059, used by Sphere app) and NIP-04 encrypted DMs (kind 4, legacy). For NIP-17 messages, the sender's nametag is extracted from the Sphere messaging format if present.

**DM history on connect:** The SDK persists the timestamp of the last processed DM event. On reconnect, only DMs newer than that timestamp are fetched from the relay. On first connect (no persisted timestamp), the SDK starts from "now" unless `dmSince` is set in `Sphere.init()` options — a unix timestamp (seconds) controlling how far back to fetch. This is a fallback: once the SDK processes a DM, the persisted timestamp takes priority on subsequent connects.

#### `onBroadcast(handler: (msg: BroadcastMessage) => void): () => void`

---

## GroupChatModule

NIP-29 relay-based group chat. Access via `createGroupChatModule()` factory.

```typescript
import { createGroupChatModule } from '@unicitylabs/sphere-sdk/modules/groupchat';

const groupChat = createGroupChatModule({ relays: ['wss://relay.example.com'] });
groupChat.initialize({ identity, storage, emitEvent });
await groupChat.connect();
```

### Group Management

#### `createGroup(options: CreateGroupOptions): Promise<GroupData | null>`

```typescript
interface CreateGroupOptions {
  name: string;
  description?: string;
  picture?: string;
  visibility?: GroupVisibility;    // 'PUBLIC' | 'PRIVATE' (default: PUBLIC)
  writeRestricted?: boolean;       // Only admins and moderators can post (default: false)
}

// Create a read-only announcement channel
const group = await groupChat.createGroup({
  name: 'Announcements',
  writeRestricted: true,
});
```

#### `fetchAvailableGroups(): Promise<GroupData[]>`

Fetches public groups from the relay. Returns `GroupData` objects including the `writeRestricted` flag.

#### `joinGroup(groupId: string, inviteCode?: string): Promise<boolean>`
#### `leaveGroup(groupId: string): Promise<boolean>`
#### `deleteGroup(groupId: string): Promise<boolean>`
#### `createInvite(groupId: string): Promise<string | null>`

### Messaging

#### `sendMessage(groupId: string, content: string, replyToId?: string): Promise<GroupMessageData | null>`

Returns `null` if the relay rejects the message (e.g., write-restricted group and user lacks permission).

#### `fetchMessages(groupId: string, limit?: number): Promise<GroupMessageData[]>`
#### `getMessages(groupId: string): GroupMessageData[]`

### Members & Permissions

#### `getMembers(groupId: string): GroupMemberData[]`
#### `getMember(groupId: string, pubkey: string): GroupMemberData | undefined`
#### `isCurrentUserAdmin(groupId: string): boolean`
#### `isCurrentUserModerator(groupId: string): boolean`
#### `canModerateGroup(groupId: string): Promise<boolean>`

#### `canWriteToGroup(groupId: string): boolean`

Check if the current user can post messages to a group. For write-restricted groups, only admins and moderators can post. For normal groups, any member can write.

```typescript
if (!groupChat.canWriteToGroup(groupId)) {
  // Disable message input — group is read-only for this user
}
```

### Write-Restricted Groups

Groups with `writeRestricted: true` are read-only for regular members. Only users with admin or moderator roles can post messages. The relay enforces this server-side — rejected messages return `null` from `sendMessage()`.

```typescript
// Check via group metadata
const group = groupChat.getGroup(groupId);
if (group?.writeRestricted) {
  // Show read-only indicator in UI
}

// Check via convenience method (combines group flag + user role)
const canWrite = groupChat.canWriteToGroup(groupId);
```

### Queries

#### `getGroups(): GroupData[]`
#### `getGroup(groupId: string): GroupData | undefined`
#### `getCurrentUserRole(groupId: string): GroupRole | null`
#### `getConnectionStatus(): boolean`

### GroupData

```typescript
interface GroupData {
  id: string;
  relayUrl: string;
  name: string;
  description?: string;
  picture?: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  writeRestricted?: boolean;       // Only admins and moderators can post
  createdAt: number;
  updatedAt?: number;
  memberCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
  lastMessageText?: string;
}
```

---

## Types

### FullIdentity

**Single Identity Model**: the same secp256k1 key pair powers all wallet operations. The same `privateKey`/`chainPubkey` is used for:
- L3 token ownership and transfers (via `chainPubkey` and `directAddress`)
- Nostr P2P messaging (derived transport key)

```typescript
interface Identity {
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  chainPubkey: string;
  /** L3 DIRECT address (DIRECT://...) */
  directAddress?: string;
  /** Legacy derived id; retained in the TXF `_meta` shape */
  ipnsName?: string;
  /** Registered @name alias */
  nametag?: string;
}

interface FullIdentity extends Identity {
  privateKey: string;        // secp256k1 private key (hex)
}
```

### AddressInfo

```typescript
interface AddressInfo {
  privateKey: string;   // secp256k1 private key (hex)
  publicKey: string;    // 33-byte compressed public key (hex)
  address: string;      // L3 DIRECT address (DIRECT://...)
  path: string;         // Full BIP32 path
  index: number;        // Address index
}
```

Note: `AddressInfo.publicKey` is the same format as `Identity.chainPubkey` (33-byte compressed secp256k1).

### TrackedAddressEntry

Minimal data stored in persistent storage for a tracked address.

```typescript
interface TrackedAddressEntry {
  readonly index: number;      // HD derivation index
  hidden: boolean;             // Whether hidden from UI
  readonly createdAt: number;  // Timestamp (ms) when first activated
  updatedAt: number;           // Timestamp (ms) of last modification
}
```

### TrackedAddress

Full tracked address with derived fields (available in memory via `getActiveAddresses()`, etc.).

```typescript
interface TrackedAddress extends TrackedAddressEntry {
  readonly addressId: string;      // Short ID (e.g., "DIRECT_abc123_xyz789")
  readonly directAddress: string;  // L3 DIRECT address (DIRECT://...)
  readonly chainPubkey: string;    // 33-byte compressed secp256k1
  readonly nametag?: string;       // Primary nametag (without @ prefix)
}
```

### ProviderStatus

```typescript
type ProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
```

### SphereEventType

```typescript
type SphereEventType =
  // The 8 payments-vertical events
  | 'transfer:incoming'
  | 'transfer:updated'
  | 'transfer:attention'
  | 'inventory:updated'
  | 'history:updated'
  | 'payment_request:incoming'
  | 'payment_request:updated'
  | 'connection:status'
  // Messaging
  | 'message:dm'
  | 'message:read'
  | 'message:typing'
  | 'composing:started'
  | 'message:broadcast'
  // Lifecycle / identity
  | 'connection:changed'
  | 'nametag:registered'
  | 'nametag:recovered'
  | 'identity:changed'
  | 'address:activated'
  | 'address:hidden'
  | 'address:unhidden'
  | 'communications:ready';
  // ...plus group chat ('groupchat:*') events — see the GroupChatModule section.
```

The pre-flip names (`transfer:confirmed`, `transfer:failed`, `payment_request:paid`, `sync:*`,
`invoice:*`, `swap:*`, `walletapi:session`, …) are gone from the public event map. dApps on the
Connect wire still receive the old names via the ConnectHost compat adapter (see
`docs/CONNECT.md`), but direct `sphere.on()` consumers use the v2 names.

### SphereEventMap

```typescript
interface SphereEventMap {
  'transfer:incoming': IncomingTransfer;
  'transfer:updated': TransferResult;                 // read status / deliveryPending
  'transfer:attention': { transferId: string; code: string; detail?: string };
  'inventory:updated': Record<string, never>;
  'history:updated': HistoryEntry;                    // the just-recorded entry
  'payment_request:incoming': PaymentRequestView;
  'payment_request:updated': { id: string; status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired' };
  'connection:status': { status: 'connected' | 'degraded' | 'offline' };
  'message:dm': DirectMessage;
  'message:read': { messageIds: string[]; peerPubkey: string };
  'message:typing': { senderPubkey: string; senderNametag?: string; timestamp: number };
  'message:broadcast': BroadcastMessage;
  'connection:changed': { provider: string; connected: boolean; status?: ProviderStatus; enabled?: boolean; error?: string };
  'nametag:registered': { nametag: string; addressIndex: number };
  'nametag:recovered': { nametag: string };
  'identity:changed': {
    directAddress?: string;
    chainPubkey: string;
    nametag?: string;
    addressIndex: number;
  };
  'address:activated': { address: TrackedAddress };
  'address:hidden': { index: number; addressId: string };
  'address:unhidden': { index: number; addressId: string };
  'communications:ready': { conversationCount: number };
  // ... plus 'groupchat:*' payloads (see module section)
}
```

---

## Unicity ID (Nametag) Registration

Nametags (Unicity IDs, `@alice`) are **Nostr identity bindings** (name ↔ chainPubkey) — there is no PROXY address scheme and receive is always locked to the recipient's chain pubkey (`SignaturePredicate`). Registration publishes the binding; global uniqueness is first-seen-wins on the binding.

### Sphere Methods

```typescript
// Register the nametag for the current active address.
// Publishes the Nostr identity binding; throws SphereError('VALIDATION_ERROR')
// when the name is invalid or already taken.
await sphere.registerNametag('alice');

// Check if a nametag is available (no binding resolves for it)
const available = await sphere.isNametagAvailable('alice');
```

### Storage

Registration is **Nostr-binding-only**. The self-issued `UnicityIdToken` on-chain claim was
removed back at the 2.0.0 state-transition-sdk bump (upstream deleted the unicity-id primitive);
`NametagData` relics from older versions are no longer readable — the Nostr binding is the
registration, and it is recovered from Nostr on wallet import.

---

## Provider Setup

### Base Providers (Platform-Specific)

Create a base provider bundle with storage, transport, and oracle. These are platform-specific and export from `./impl`:

**Node.js variant:**
```typescript
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({
  network: 'testnet2',                // Required
  dataDir: './wallet-data',           // Required for Node.js
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key (NOT a secret)
  },
});
```

**Browser variant:**
```typescript
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

const base = createBrowserProviders({
  network: 'testnet2',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
  },
});
```

### Wallet-API Transport Config (REQUIRED for money)

`createWalletApiProviders` attaches the plain transport config (`walletApi`) the payments
vertical is composed from. Without it, `Sphere.init` throws `INVALID_CONFIG`.

```typescript
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',  // Canonical testnet2 host
  network: 'testnet2',
  deviceId: 'my-stable-device-id',                // Persisted device ID (for multi-device)
});
// providers = { ...base, walletApi: { network, baseUrl, deviceId } }

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
```

Advanced fields on the config: `fetchFn` (injectable fetch), `webSocketFactory` (e.g. the `ws`
package on Node < 22), and `paymentsV2Transport(args)` — a DI seam that replaces the whole
per-address transport bundle (`{ session, client }`) for tests or custom hosts; when supplied,
`baseUrl` is not required.

### Full Initialization Example (Node.js)

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// 1. Create base providers (storage, transport, oracle)
const base = createNodeProviders({
  network: 'testnet2',
  dataDir: './wallet-data',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key
  },
});

// 2. Attach the wallet-api transport config (required for money)
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId: 'my-stable-device-id',
});

// 3. Initialize the wallet
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  password: 'my-password', // Optional: encrypt mnemonic
});

// 4. Send a token
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  memo: 'hi',
});
console.log(result.status);          // 'completed'
console.log(result.deliveryPending); // true if deferred, false if landed

// 5. Receive transfers (explicit mailbox drain)
const { transfers } = await sphere.payments.receive();
console.log('received', transfers.length, 'transfers');
```

---

## OracleProvider (Network-Config Provider)

The oracle is a **thin network-config provider** for the token engine: it loads the root trust base (JSON) and exposes the gateway URL + API key. The engine (`token-engine/`) builds its own SDK clients from these — no state-transition SDK objects cross this boundary.

```typescript
interface OracleProvider extends BaseProvider {
  /**
   * Initialize the provider. Loads the trust base JSON via the configured
   * platform loader when none is passed explicitly.
   */
  initialize(trustBaseJson?: unknown): Promise<void>;

  /** Raw trust-base JSON (the engine parses it; the networkId comes from it). */
  getTrustBaseJson(): unknown | null;

  /** Gateway (aggregator) base URL. */
  getAggregatorUrl(): string;

  /** Gateway API key, when the gateway requires one (e.g. testnet2). */
  getApiKey(): string | undefined;

  /** Optional: swap the gateway key on a live provider (pair with Sphere.setOracleApiKey). */
  setApiKey?(apiKey: string): void;
}
```

Network configuration:

- **testnet2:** `https://gateway.testnet2.unicity.network` (networkId 4)
- **mainnet/dev:** v1-era aggregators — the engine cannot operate against them (`AGGREGATOR_ERROR`); use testnet2

