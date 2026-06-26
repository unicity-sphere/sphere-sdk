# Sphere SDK API Reference

## Sphere

Main entry point for all SDK operations. The constructor is **private** — use static methods to create/load wallets.

### Static Methods

#### `Sphere.init(options: SphereInitOptions): Promise<SphereInitResult>`

Primary entry point. Creates a new wallet or loads an existing one automatically.

```typescript
const { sphere, created, generatedMnemonic } = await Sphere.init({
  storage, transport, oracle,
  delivery,                  // Optional: DeliveryProvider for v2 token delivery (wallet-api)
  tokenStorage,              // Optional: token storage port (supplied by createWalletApiProviders)
  walletApi,                 // Optional: wallet-api port for E.3 intent lifecycle & history
  autoGenerate: true,        // Generate mnemonic if no wallet exists
  mnemonic: 'words...',      // Or provide mnemonic to create/import
  password: 'secret',        // Optional: encrypt mnemonic (plaintext if omitted)
  nametag: 'alice',          // Optional: register @alice on create
  price: priceProvider,      // Optional PriceProvider
  accounting: true,          // Optional: enable invoicing module
  swap: true,                // Optional: enable swap module (requires accounting)
  derivationPath: "m/44'/0'/0'", // Optional custom path
  dmSince: Math.floor(Date.now() / 1000) - 86400, // Optional: DM history fallback (unix seconds)
});
```

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

#### `Sphere.clear(storageOrOptions): Promise<void>`

Delete all SDK-owned wallet data from storage. Accepts either a `StorageProvider` directly (legacy) or an options object with optional `tokenStorage`.

```typescript
// Recommended: clear wallet keys + token data
await Sphere.clear({
  storage: providers.storage,
  tokenStorage: providers.tokenStorage,
});

// Legacy (backward compatible): clear wallet keys only
await Sphere.clear(storage);
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `identity` | `FullIdentity \| null` | Current wallet identity (after init/load) |
| `payments` | `PaymentsModule` | L3 token operations |
| `communications` | `CommunicationsModule` | Messaging operations |
| `accounting` | `AccountingModule \| null` | Invoice lifecycle and payment attribution |
| `swap` | `SwapModule \| null` | P2P token swap orchestration |

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

## PaymentsModule

Access via `sphere.payments`.

Handles all L3 (Unicity state transition network) token operations including transfers, balance queries, token lifecycle management, self-mint, and multi-provider sync.

### How Transfers Work (v2, sender-driven)

`send()` runs the entire transfer through the v2 token engine on the **sender** side, with delivery via `DeliveryProvider` (wallet-api mailbox):

```
  ┌─────────┐  engine.transfer / engine.split   ┌──────────┐
  │  Sender  │ ─────────────────────────────────>│ Gateway   │  certify on-chain,
  └────┬─────┘     (source state is spent)       └──────────┘  wait inclusion proof
       │
       │  Finished token blob (V2_TRANSFER) via delivery (wallet-api mailbox or transport)
       └──────────────────────────────────────────> Recipient
                                  verifies (engine.verify + ownership) → stores 'confirmed'
```

**Architecture (v2):**
- The v2 token engine is the **only send path** — a finished token blob is sent to the recipient via the `DeliveryProvider` port (wallet-api mailbox with `createWalletApiMailboxProvider`, or transport fallback).
- Whole-token transfers use `engine.transfer`; partial amounts use `engine.split` (recipient output + change output certified in one on-chain operation — the change token is real and immediately spendable, no placeholder).
- Finished-but-undelivered blobs are journaled under the `PENDING_V2_DELIVERIES` storage key **before** transport send and replayed by `load()` — a transport failure or crash never loses the recipient's token.
- The recipient receives a **finished** token with status `'confirmed'` — there is no commitment submission, proof polling, or finalization phase on the receiving side.
- **Requirements:** the token engine must be available (oracle supplies a v2 trust base + gateway URL; otherwise `AGGREGATOR_ERROR`), and the recipient must have a published chain pubkey (otherwise `INVALID_RECIPIENT`).

### Methods: Transfer

#### `send(request: TransferRequest): Promise<TransferResult>`

Send tokens to a recipient via the v2 token engine (the only send path). Automatically splits a token when the exact amount is not available as a single token.

```typescript
interface TransferRequest {
  readonly coinId: string;       // Coin type (hex string)
  readonly amount: string;       // Amount in smallest units (decimal string)
  readonly recipient: string;    // @nametag, hex chain pubkey, or DIRECT:// address
  readonly memo?: string;        // Optional message (transport-only; invoice refs also go on-chain)
  readonly addressMode?: AddressMode;    // 'auto' | 'direct' — both resolve to the recipient's key-based DIRECT address
  readonly transferMode?: TransferMode;  // @deprecated: accepted but IGNORED (single engine path)
  readonly invoiceRefundAddress?: string; // Invoice refund address (DIRECT://) — embedded in the on-chain message
  readonly invoiceContact?: { address: string; url?: string }; // Invoice contact — embedded in the on-chain message
}

type AddressMode = 'auto' | 'direct';
type TransferMode = 'instant' | 'conservative'; // @deprecated: both treated as instant (ignored)

interface TransferResult {
  readonly id: string;                       // Local transfer UUID
  status: TransferStatus;                    // Current status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed'
  readonly tokens: Token[];                  // Tokens involved in this transfer
  readonly tokenTransfers: TokenTransferDetail[];  // Per-token transfer details
  error?: string;                            // Error message if failed
  deliveryPending?: boolean;                 // True when certified on-chain but recipient delivery deferred (covenant §3.1 #621) — NOT a failure
  deliveryState?: 'landed' | 'pending-delivery'; // 'landed' = delivered to recipient mailbox; 'pending-delivery' = certified, journaled, awaiting retry
}

type TransferStatus = 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';

interface TokenTransferDetail {
  readonly sourceTokenId: string;   // Source token ID consumed
  readonly method: 'direct' | 'split';  // Transfer method
}
```

**Events emitted:** `transfer:confirmed` on success, `transfer:failed` on error.

```typescript
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
});
console.log(result.status);          // 'completed' or 'submitted' (pending delivery)
console.log(result.deliveryPending); // true if certified but delivery deferred (normal, not a failure)
```

**Semantics (v2):**

- The wire payload is always `V2_TRANSFER` — a finished v2 token blob (hex CBOR). The recipient verifies it (`engine.verify` + ownership check) and stores it as `'confirmed'`; no receiver-side proof resolution exists.
- The token engine and the recipient's published chain pubkey are **mandatory**: `send()` throws `AGGREGATOR_ERROR` when the engine is unavailable (no v2 oracle config) and `INVALID_RECIPIENT` when the recipient has no published identity.
- Every finished output blob is journaled under the `PENDING_V2_DELIVERIES` storage key **before** delivery and removed after success; `load()` replays undelivered blobs from a previous session with exponential backoff (up to 6 total attempts across sessions before surfacing as `'delivery:undeliverable'` poison).
- **Failure handling:** source tokens whose spend was certified on-chain during a failed send become terminal `'spent'` — never restored to `'confirmed'` (the finished output blob stays journaled for delivery replay); genuinely untouched tokens are restored to `'confirmed'`.
- **deliveryPending semantics (§3.1 #621):** when `deliveryPending === true`, the transfer certified on-chain and the recipient's mailbox quota was full (429) or the peer is not claiming delivery. The blob is deferred and will retry later — this is **normal and not a failure**. The user's tokens are spent and safe with the recipient (the journal guarantee ensures re-delivery).

#### `receive(options?, callback?): Promise<ReceiveResult>`

Fetch and process pending incoming transfers from the delivery provider (one-shot query).

Unlike the persistent subscription that delivers events asynchronously, `receive()` explicitly queries the delivery mailbox and resolves after all stored events are processed. Useful for batch/CLI applications.

v2 transfers arrive as **finished** tokens — there is no finalization phase. Incoming tokens are verified (`engine.verify` + ownership check against this wallet's chain pubkey) and stored as `'confirmed'` before the call resolves.

- **options** (`ReceiveOptions`, optional): **Deprecated.** The former finalization options (`finalize`, `timeout`, `pollInterval`) are accepted for backwards compatibility and ignored.
- **callback** (`(transfer: IncomingTransfer) => void`, optional): Invoked for each newly received transfer.

**ReceiveResult:**

| Field | Type | Description |
|-------|------|-------------|
| `transfers` | `IncomingTransfer[]` | Newly received transfers |

```typescript
// Fetch and process pending transfers once
const { transfers } = await sphere.payments.receive();

// With per-transfer callback
await sphere.payments.receive(undefined, (transfer) => {
  console.log(`Received ${transfer.tokens.length} tokens`);
});
```

---

### Methods: Balance & Assets

#### `getFiatBalance(): Promise<number | null>`

Returns total portfolio value in USD. Requires `PriceProvider` to be configured.

```typescript
const totalUsd = await sphere.payments.getFiatBalance();
// 1523.45 — total value of all confirmed tokens in USD
// null    — if PriceProvider is not configured or no prices available
```

#### `getBalance(coinId?: string): Asset[]`

Returns aggregated assets (tokens grouped by coinId) with confirmed/unconfirmed breakdown. Synchronous — price fields are always `null` here; use `getAssets()` for fiat values.

```typescript
const balances = sphere.payments.getBalance();

for (const bal of balances) {
  console.log(`${bal.symbol}:`);
  console.log(`  Confirmed:   ${bal.confirmedAmount} (${bal.confirmedTokenCount} tokens)`);
  console.log(`  Unconfirmed: ${bal.unconfirmedAmount} (${bal.unconfirmedTokenCount} tokens)`);
  console.log(`  Total:       ${bal.totalAmount}`);
}

// Filter to a single coin
const uctBalances = sphere.payments.getBalance('UCT_COIN_ID_HEX');
```

#### `getAssets(coinId?: string): Promise<Asset[]>`

Returns aggregated assets with price data. Alias for `getBalance()` with async price resolution.

```typescript
interface Asset {
  readonly coinId: string;       // Token coin ID
  readonly symbol: string;       // e.g., 'UCT'
  readonly name: string;         // e.g., 'Unicity'
  readonly decimals: number;     // e.g., 18
  readonly iconUrl?: string;     // Token icon URL
  readonly totalAmount: string;  // Spendable balance: confirmed + unconfirmed (in-flight EXCLUDED), smallest units
  readonly tokenCount: number;   // Number of confirmed + unconfirmed tokens aggregated
  readonly confirmedAmount: string;     // Confirmed token amounts
  readonly unconfirmedAmount: string;   // Unconfirmed token amounts (NOT in-flight)
  readonly confirmedTokenCount: number; // Number of confirmed tokens
  readonly unconfirmedTokenCount: number; // Number of unconfirmed tokens
  readonly transferringTokenCount: number; // Number of in-flight tokens (NOT spendable)
  readonly transferringAmount: string;  // Sum of in-flight token amounts — excluded from totalAmount
  readonly priceUsd: number | null;     // Price per unit in USD
  readonly priceEur: number | null;     // Price per unit in EUR
  readonly change24h: number | null;    // 24h price change %
  readonly fiatValueUsd: number | null; // totalAmount * priceUsd (in human units)
  readonly fiatValueEur: number | null; // totalAmount * priceEur (in human units)
}

// All assets
const assets = await sphere.payments.getAssets();

// Filter by coinId
const uctAssets = await sphere.payments.getAssets('0xabc...');
```

> **Note:** Price fields are `null` when `PriceProvider` is not configured. The SDK works fully without it — prices are optional.

#### `getTokens(filter?: { coinId?: string; status?: TokenStatus }): Token[]`

Synchronous. Returns current in-memory token list.

```typescript
interface Token {
  readonly id: string;
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly amount: string;
  status: TokenStatus;  // 'pending' | 'submitted' | 'confirmed' | 'transferring' | 'spent' | 'invalid'
  readonly createdAt: number;
  updatedAt: number;
  readonly sdkData?: string;  // Serialized SDK token (v2: hex CBOR; legacy v1: JSON)
}

// Filter examples
const allTokens = sphere.payments.getTokens();
const uctOnly = sphere.payments.getTokens({ coinId: 'UCT' });
const confirmed = sphere.payments.getTokens({ status: 'confirmed' });
```

#### `getToken(id: string): Token | undefined`

Get a single token by ID.

---

### Methods: Self-Mint

#### `mintFungibleToken(coinIdHex: string, amount: bigint): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }>`

Self-mint fungible tokens to this wallet via the v2 token engine (`engine.mint` — a finished token, no commitment round-trip). There is no faucet in v2; this is the way to top up a fresh wallet on networks where standalone mint is allowed (e.g. testnet2).

- `coinIdHex` must be even-length lowercase hex; `amount` must be `> 0n`.
- Requires the token engine (v2 oracle config with trust base + gateway); otherwise returns `{ success: false, error }` — this method returns an error result instead of throwing.
- On success the minted token is stored as a `'confirmed'` wallet token; `tokenId` is the genesis-stable 64-char hex id.

```typescript
const result = await sphere.payments.mintFungibleToken(coinIdHex, 1_000_000n);
if (result.success) {
  console.log('Minted token:', result.tokenId, result.token.amount);
} else {
  console.error('Mint failed:', result.error);
}
```

---

### Methods: Token CRUD

#### `addToken(token: Token): Promise<boolean>`

Add a token to the wallet.

- **Tombstone check**: Rejected if exact `(tokenId, stateHash)` is tombstoned.
- **Duplicate check**: Rejected if same composite key already exists.
- **State replacement**: If same `tokenId` with different `stateHash`, archives old state and adds new.

Returns `true` if added, `false` if rejected.

#### `updateToken(token: Token): Promise<void>`

Update an existing token. Matches by genesis tokenId or `token.id`. Falls back to `addToken()` if not found.

#### `removeToken(tokenId: string, excludeReservationId?: string): Promise<void>`

Remove a token. Archives it first and creates a tombstone `(tokenId, stateHash)`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tokenId` | `string` | — | Local UUID of the token |
| `excludeReservationId` | `string?` | — | Reservation to exclude when notifying the spend queue (internal send-path use) |

---

### Methods: Tombstones

Tombstones prevent spent tokens from being re-added (e.g. via Nostr re-delivery). Each tombstone is keyed by `(tokenId, stateHash)`.

#### `getTombstones(): TombstoneEntry[]`

Get all tombstone entries.

```typescript
interface TombstoneEntry {
  tokenId: string;
  stateHash: string;
  timestamp: number;
}
```

#### `isStateTombstoned(tokenId: string, stateHash: string): boolean`

Check if a specific `(tokenId, stateHash)` is tombstoned.

#### `mergeTombstones(remoteTombstones: TombstoneEntry[]): Promise<number>`

Merge remote tombstones (union). Removes any local tokens matching remote tombstones. Returns number of local tokens removed.

#### `pruneTombstones(maxAge?: number): Promise<void>`

Remove tombstones older than `maxAge` (default: 30 days) and cap at 100 entries.

---

### Methods: Archives

Archived tokens are spent or superseded token versions kept for recovery and sync.

#### `getArchivedTokens(): Map<string, TxfToken>`

Get all archived tokens. Key is genesis token ID.

#### `getBestArchivedVersion(tokenId: string): TxfToken | null`

Get the version with the most committed transactions from both archives and forks.

#### `mergeArchivedTokens(remoteArchived: Map<string, TxfToken>): Promise<number>`

Merge remote archived tokens. Handles incremental updates and forks. Returns count of tokens updated/added.

#### `pruneArchivedTokens(maxCount?: number): Promise<void>`

Keep at most `maxCount` archived tokens (default: 100).

---

### Methods: Forked Tokens

Forked tokens are alternative histories detected during sync.

#### `getForkedTokens(): Map<string, TxfToken>`

Get all forked tokens. Key is `{tokenId}_{stateHash}`.

#### `storeForkedToken(tokenId: string, stateHash: string, txfToken: TxfToken): Promise<void>`

Store a forked token version. No-op if key already exists.

#### `mergeForkedTokens(remoteForked: Map<string, TxfToken>): Promise<number>`

Merge remote forked tokens (adds missing keys). Returns count added.

#### `pruneForkedTokens(maxCount?: number): Promise<void>`

Keep at most `maxCount` forked tokens (default: 50).

---

### Methods: Transaction History

#### `getHistory(): TransactionHistoryEntry[]`

Get transaction history sorted newest-first. `TransactionHistoryEntry` is an alias of the shared `HistoryRecord` storage type:

```typescript
interface TransactionHistoryEntry {
  dedupKey: string;               // Composite dedup key (primary key)
  id: string;                     // UUID for public API consumption
  type: 'SENT' | 'RECEIVED' | 'SPLIT' | 'MINT';
  amount: string;
  coinId: string;
  symbol: string;
  timestamp: number;
  transferId?: string;            // Links to TransferResult.id (for SENT entries)
  tokenId?: string;               // Genesis tokenId this entry relates to
  // Sender info (for RECEIVED)
  senderPubkey?: string;
  senderAddress?: string;
  senderNametag?: string;
  // Recipient info (for SENT)
  recipientPubkey?: string;
  recipientAddress?: string;
  recipientNametag?: string;
  memo?: string;                  // Optional memo attached to the transfer
  tokenIds?: Array<{ id: string; amount: string; source: 'split' | 'direct' }>;
}
```

#### `addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void>`

Append a history entry (UUID and dedup key auto-generated). Persisted immediately.

---

### Methods: Nametag Data (Unicity ID)

Nametag **registration** lives on the `Sphere` instance (`sphere.registerNametag()`, `sphere.isNametagAvailable()`) — see the [Unicity ID (Nametag) Registration](#unicity-id-nametag-registration) section. `PaymentsModule` only stores/loads the per-address `NametagData` records (including the self-issued v2 UnicityIdToken claim):

#### `setNametag(nametag: NametagData): Promise<void>`

Set nametag data (persists to storage and token storage).

#### `getNametag(): NametagData | null`

Get the current (first) nametag data record.

#### `getNametags(): NametagData[]`

Get all nametag data records for the active address.

#### `hasNametag(): boolean`

Check if a nametag is set.

#### `clearNametag(): Promise<void>`

Remove nametag data from memory and storage.

---

### Methods: Sync & Validation

#### `sync(): Promise<{ added: number; removed: number }>`

Sync with all remote storage providers (IPFS, etc.). Merges local and remote token data.

```typescript
const result = await sphere.payments.sync();
console.log(`Sync: +${result.added} -${result.removed}`);
```

#### `validate(): Promise<{ valid: Token[]; invalid: Token[] }>`

Validate all tokens. v2 blob tokens are verified via the token engine (`engine.verify` + on-chain `engine.isSpent`); legacy v1 TXF tokens fall back to the oracle's best-effort `validateToken` RPC. Tokens that fail are marked `'invalid'`; transient engine/network failures skip the token instead of invalidating funds.

```typescript
const { valid, invalid } = await sphere.payments.validate();
```

#### `getHistory(): TransactionHistoryEntry[]`

Get sorted transaction history (L3 transfers).

#### `getPendingTransfers(): TransferResult[]`

Get transfers that are still in progress.

#### `load(): Promise<void>`

Load all token data from storage providers. Also performs v2 recovery work:

- terminalizes orphaned pending-V5 tokens (from the removed v1 instant-split receiver) to `'invalid'` (data kept for audit);
- reconciles tokens stuck in `'transferring'` after a crash against the network (`spent` on-chain → terminal `'spent'`, unspent → back to `'confirmed'`);
- replays finished-but-undelivered transfer blobs from the `PENDING_V2_DELIVERIES` journal with exponential backoff (max 6 total attempts across sessions; undeliverable entries after 6 attempts surface as `'delivery:undeliverable'` poison and stop auto-retry).

#### `destroy(): void`

Cleanup all subscriptions, polling jobs, and pending resolvers.

---

### Payment Requests (Incoming)

#### `sendPaymentRequest(recipient: string, request: PaymentRequest): Promise<PaymentRequestResult>`

Send a payment request to a recipient.

```typescript
interface PaymentRequest {
  amount: string;           // Amount in smallest units
  coinId: string;           // Token type (e.g., 'UCT')
  message?: string;         // Optional message
  recipientNametag?: string; // Where tokens should be sent
  metadata?: Record<string, unknown>;
}

interface PaymentRequestResult {
  success: boolean;
  requestId?: string;   // Local request ID for tracking
  eventId?: string;     // Nostr event ID
  error?: string;
}

// Example
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Payment for order #1234',
});
```

#### `getPaymentRequests(filter?: { status?: PaymentRequestStatus }): IncomingPaymentRequest[]`

Get incoming payment requests.

```typescript
type PaymentRequestStatus = 'pending' | 'accepted' | 'rejected' | 'paid' | 'expired';

interface IncomingPaymentRequest {
  id: string;                  // Event ID
  senderPubkey: string;        // Requester's public key
  senderNametag?: string;      // Requester's nametag
  amount: string;              // Requested amount
  coinId: string;              // Token type
  symbol: string;              // Token symbol for display
  message?: string;            // Request message
  recipientNametag?: string;   // Requester's nametag (where to send tokens)
  requestId: string;           // Original request ID
  timestamp: number;           // Request timestamp
  status: PaymentRequestStatus;
  metadata?: Record<string, unknown>; // Custom metadata
}

// Example
const pending = sphere.payments.getPaymentRequests({ status: 'pending' });
```

#### `getPendingPaymentRequestsCount(): number`

Get count of pending payment requests.

#### `acceptPaymentRequest(requestId: string): Promise<void>`

Accept a payment request (marks as accepted, sends response to requester).

#### `rejectPaymentRequest(requestId: string): Promise<void>`

Reject a payment request (marks as rejected, sends response to requester).

#### `payPaymentRequest(requestId: string, memo?: string): Promise<TransferResult>`

Accept and pay a payment request in one operation.

```typescript
// Pay a request directly
const result = await sphere.payments.payPaymentRequest(requestId, 'Payment for ticket');
```

#### `markPaymentRequestPaid(requestId: string): void`

Mark a payment request as paid (local status update only).

Typically called after a successful `send()` to record that the request has been fulfilled.

#### `clearProcessedPaymentRequests(): void`

Remove all non-pending incoming payment requests from memory.

Keeps only requests with status `'pending'`.

#### `removePaymentRequest(requestId: string): void`

Remove a specific incoming payment request by ID.

#### `onPaymentRequest(handler: (request: IncomingPaymentRequest) => void): () => void`

Subscribe to incoming payment requests. Returns unsubscribe function.

```typescript
const unsubscribe = sphere.payments.onPaymentRequest((request) => {
  console.log(`Received request for ${request.amount} ${request.symbol}`);
});
```

---

### Payment Requests (Outgoing)

#### `getOutgoingPaymentRequests(filter?: { status?: PaymentRequestStatus }): OutgoingPaymentRequest[]`

Get outgoing payment requests (requests we sent to others).

```typescript
interface OutgoingPaymentRequest {
  id: string;                  // Local request ID
  eventId: string;             // Nostr event ID
  recipientPubkey: string;     // Recipient's public key
  recipientNametag?: string;   // Recipient's nametag
  amount: string;              // Requested amount
  coinId: string;              // Token type
  message?: string;            // Request message
  createdAt: number;           // Creation timestamp
  status: PaymentRequestStatus;
  response?: PaymentRequestResponse;
}

// Example
const pending = sphere.payments.getOutgoingPaymentRequests({ status: 'pending' });
```

#### `onPaymentRequestResponse(handler: (response: PaymentRequestResponse) => void): () => void`

Subscribe to payment request responses.

```typescript
interface PaymentRequestResponse {
  id: string;                  // Response event ID
  responderPubkey: string;     // Responder's public key
  responderNametag?: string;   // Responder's nametag
  requestId: string;           // Original request ID
  responseType: 'accepted' | 'rejected' | 'paid';
  message?: string;            // Response message
  transferId?: string;         // Transfer ID (if paid)
  timestamp: number;           // Response timestamp
}

const unsubscribe = sphere.payments.onPaymentRequestResponse((response) => {
  if (response.responseType === 'paid') {
    console.log('Payment received! Transfer:', response.transferId);
  }
});
```

#### `waitForPaymentResponse(requestId: string, timeoutMs?: number): Promise<PaymentRequestResponse>`

Wait for a response to a payment request with optional timeout (default: 60000ms).

```typescript
// Send request and wait for response
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Coffee purchase',
});

if (result.success) {
  try {
    const response = await sphere.payments.waitForPaymentResponse(result.requestId!, 120000);
    if (response.responseType === 'paid') {
      console.log('Payment received!');
    }
  } catch (error) {
    console.log('Timeout or cancelled');
  }
}
```

#### `cancelWaitForPaymentResponse(requestId: string): void`

Cancel waiting for a payment response.

#### `removeOutgoingPaymentRequest(requestId: string): void`

Remove an outgoing payment request from tracking.

#### `clearCompletedOutgoingPaymentRequests(): void`

Clear all completed, rejected, or expired outgoing requests.

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
  /** IPNS identifier for storage */
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
  | 'transfer:incoming'
  | 'transfer:confirmed'
  | 'transfer:failed'
  | 'payment_request:incoming'
  | 'payment_request:accepted'
  | 'payment_request:rejected'
  | 'payment_request:paid'
  | 'payment_request:response'
  | 'message:dm'
  | 'message:read'
  | 'message:typing'
  | 'composing:started'
  | 'message:broadcast'
  | 'sync:started'
  | 'sync:completed'
  | 'sync:provider'
  | 'sync:error'
  | 'sync:remote-update'
  | 'inventory:conflict'
  | 'delivery:undeliverable'
  | 'connection:changed'
  | 'nametag:registered'
  | 'nametag:recovered'
  | 'identity:changed'
  | 'address:activated'
  | 'address:hidden'
  | 'address:unhidden'
  | 'communications:ready'
  | 'history:updated';
  // ...plus group chat ('groupchat:*'), invoice ('invoice:*'), and swap ('swap:*')
  // events — see the GroupChatModule, AccountingModule, and SwapModule sections.
```

### SphereEventMap

```typescript
interface SphereEventMap {
  'transfer:incoming': IncomingTransfer;
  'transfer:confirmed': TransferResult;
  'transfer:failed': TransferResult;
  'payment_request:incoming': IncomingPaymentRequest;
  'payment_request:accepted': IncomingPaymentRequest;
  'payment_request:rejected': IncomingPaymentRequest;
  'payment_request:paid': IncomingPaymentRequest;
  'payment_request:response': PaymentRequestResponse;
  'message:dm': DirectMessage;
  'message:read': { messageIds: string[]; peerPubkey: string };
  'message:typing': { senderPubkey: string; senderNametag?: string; timestamp: number };
  'message:broadcast': BroadcastMessage;
  'sync:started': { source: string };
  'sync:completed': { source: string; count: number };
  'sync:provider': { providerId: string; success: boolean; added?: number; removed?: number; error?: string };
  'sync:error': { source: string; error: string };
  'sync:remote-update': { providerId: string; name: string; sequence: number; cid: string; added: number; removed: number };
  // A send lost a race on a stale-inventory source (Part E.2 TransferConflictError) — surfaced so a UI can prompt refresh+retry.
  'inventory:conflict': { transferId: string; coinId: string; error: string };
  // A journaled undelivered transfer blob exhausted its bounded replay budget (#517) — surfaced as poison (kept journaled, no longer auto-retried).
  'delivery:undeliverable': { transferId: string; recipientPubkey: string; attempts: number; error: string };
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
  'history:updated': TransactionHistoryEntry;
  // ... plus 'groupchat:*', 'invoice:*', and 'swap:*' payloads (see module sections)
}
```

### V2_TRANSFER Wire Payload

The only supported token-transfer payload post v1-cutover — a **finished** v2 token blob:

```typescript
{
  type: 'V2_TRANSFER';
  version: '2.0';
  tokenBlob: string;   // hex of CBOR(TokenBlob) — the finished recipient token
  memo?: string;       // optional transport-level memo
}
```

Incoming v1-era payloads (V5/V6 instant-split bundles, NOSTR-FIRST, `{sourceToken, transferTx}`, plain token JSON) are dropped with an explicit error log — peers must run a >=0.8 wallet to send to this wallet.

### PaymentsModuleDependencies

```typescript
interface PaymentsModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  /** @deprecated Use tokenStorageProviders instead */
  tokenStorage?: TokenStorageProvider;
  /** Multiple token storage providers (e.g., IPFS, MongoDB, file) */
  tokenStorageProviders?: Map<string, TokenStorageProvider>;
  transport: TransportProvider;
  oracle: OracleProvider;
  /** v2 token engine — required for send/mint/validate of v2 tokens (wired by Sphere) */
  tokenEngine?: ITokenEngine;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /** Chain code for BIP32 HD derivation (for multi-address support) */
  chainCode?: string;
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
  /** Set of disabled provider IDs — skipped during sync/save */
  disabledProviderIds?: ReadonlySet<string>;
  /** Delivery provider (v2 asset delivery via wallet-api mailbox or transport fallback) */
  delivery?: DeliveryProvider;
  /** wallet-api client port (E.3 intent lifecycle, history, payment requests) */
  walletApi?: PaymentsWalletApiPort;
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

### On-chain Claim (best-effort)

In addition to the Nostr binding, `registerNametag()` mints + stores a **self-issued v2 `UnicityIdToken`** as an on-chain claim:

- Stored via `payments.setNametag()` as `NametagData { format: 'v2-cbor', token: <hex CBOR> }`.
- **Best-effort and idempotent** — a gateway outage or missing v2 oracle config never fails registration; the mint is deterministic per (name, wallet key), so a later load re-mints the identical token (lost-storage recovery). On networks without a v2 oracle config a warning is logged on each load.
- **Unused at runtime** — name resolution stays Nostr-binding-only; the token is kept for a future issuer/verification model.

The claim is also (re-)minted on wallet init/load and on address switch when a nametag exists but the v2 token is missing.

### NametagData

```typescript
interface NametagData {
  name: string;            // Nametag without @ prefix
  token: object | string;  // 'v2-cbor': hex-encoded UnicityIdToken CBOR (string)
                           // legacy 'txf': v1 nametag token JSON (object, inert)
  timestamp: number;       // Mint timestamp
  format: string;          // 'v2-cbor' (current) | 'txf' (legacy)
  version: string;         // '2.0'
}
```

### Standalone Minter (token-engine)

For advanced usage, mint the self-issued UnicityIdToken directly. `createUnicityIdMinter`, `IUnicityIdMinter`, and `UnicityIdMintResult` are exported from the SDK's `token-engine` module (`token-engine/index.ts`; not currently re-exported from the package root):

```typescript
import { createUnicityIdMinter } from './token-engine';          // sphere-sdk token-engine module
import type { IUnicityIdMinter, UnicityIdMintResult } from './token-engine';

// Built from the same config shape the token engine uses (EngineConfig)
const minter: IUnicityIdMinter = createUnicityIdMinter({
  aggregatorUrl: 'https://gateway.testnet2.unicity.network',
  apiKey: 'sk_...',                  // optional gateway API key
  privateKey: privateKeyBytes,       // Uint8Array (32-byte secp256k1 scalar)
  trustBaseJson,                     // required — throws INVALID_CONFIG when missing
});

const result: UnicityIdMintResult = await minter.mintUnicityIdToken('alice');
console.log(result.tokenCborHex);  // UnicityIdToken CBOR, hex-encoded (storable form)
console.log(result.tokenId);       // 64-char hex token id, stable across re-mints
```

```typescript
// Real signatures (token-engine/unicity-id.ts)
interface UnicityIdMintResult {
  readonly tokenCborHex: string;  // UnicityIdToken CBOR, hex — UnicityIdToken.fromCBOR round-trips it
  readonly tokenId: string;       // 64-char hex, derived from the name (stable across re-mints)
}

interface IUnicityIdMinter {
  mintUnicityIdToken(name: string, options?: EngineOpOptions): Promise<UnicityIdMintResult>;
}

function createUnicityIdMinter(config: EngineConfig): IUnicityIdMinter;
```

Trust model: **self-issued** — the wallet's own key is the issuer lock script, the recipient, and the target predicate. `tokenId = SHA256(CBOR["NAMETAG_", null, name])` with a pinned token type, so a re-mint re-certifies the same state and yields the identical token. On-chain uniqueness is per-issuer only; global name uniqueness remains the Nostr binding's job. Mint failures throw `SphereError('AGGREGATOR_ERROR')`.

---

## Provider Setup (v2)

### Base Providers (Platform-Specific)

Create a base provider bundle with storage, transport, and oracle. These are platform-specific and export from `./impl`:

**Node.js variant:**
```typescript
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({
  network: 'testnet2',                // Required
  dataDir: './wallet-data',           // Required for Node.js
  tokensDir: './tokens-data',         // Required for Node.js
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

### Wallet-API Providers (v2, Recommended)

The v2 reference implementation uses wallet-api for asset delivery (mailbox), intent lifecycle, and history. Create providers from the base:

```typescript
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',  // Canonical testnet2 host
  network: 'testnet2',
  deviceId: 'my-stable-device-id',                // Persisted device ID (for multi-device)
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
```

### Own-Storage Variant (v2)

For custom token storage backends (instead of thin wallet-api storage):

```typescript
import { createOwnStorageWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import { createNodeIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({ network: 'testnet2', ... });
const ipfsStorage = createNodeIpfsStorageProvider({ /* config */ }, base.storage);

// Put the custody token-storage port on the base bundle; the own-storage preset preserves it
// (its config has no `tokenStorage` field — it only adds the `delivery` + `walletApi` ports).
const ownStorageBase = { ...base, tokenStorage: ipfsStorage };

const providers = createOwnStorageWalletApiProviders(ownStorageBase, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId: 'my-stable-device-id',
});
```

### Full Initialization Example (Node.js v2)

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// 1. Create base providers (storage, transport, oracle)
const base = createNodeProviders({
  network: 'testnet2',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key
  },
});

// 2. Wrap with wallet-api (v2 delivery + intent lifecycle)
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
console.log(result.status);          // 'completed' or 'submitted' (pending delivery)
console.log(result.deliveryPending); // true if deferred, false if landed

// 5. Receive transfers (incoming mailbox polling)
const { transfers } = await sphere.payments.receive(undefined, (t) =>
  console.log('received', t.tokens.length, 'tokens')
);
```

---

## OracleProvider (Network-Config Provider)

Post v1-cutover the oracle is a **thin network-config provider** for the v2 token engine: it loads the root trust base (JSON) and exposes the gateway URL + API key. The engine (`token-engine/`) builds its own SDK clients from these — no state-transition SDK objects cross this boundary. The v1 client surface (`submitCommitment`, `getProof`, `waitForProof`, `isSpent`, `getTokenState`, `getCurrentRound`, `mint`, `getStateTransitionClient`, `getAggregatorClient`, `waitForProofSdk`, …) is gone.

```typescript
interface OracleProvider extends BaseProvider {
  /**
   * Initialize the provider. Loads the trust base JSON via the configured
   * platform loader when none is passed explicitly.
   */
  initialize(trustBaseJson?: unknown): Promise<void>;

  /**
   * Validate a LEGACY v1 TXF token against the aggregator (best-effort JSON-RPC, no retry).
   * v2 blob tokens use the engine (`engine.verify`).
   */
  validateToken(token: TxfToken): Promise<boolean>;

  /** Gateway URL for the v2 token engine. */
  getGatewayUrl(): string;

  /** Optional API key for aggregator endpoints. */
  getApiKey(): string | undefined;

  /** Load the trust base JSON (required for v2 operations). */
  getTrustBase(): unknown;
}
```

Network configuration:

- **testnet2:** `https://gateway.testnet2.unicity.network` (networkId 4)
- **mainnet/dev:** v1 aggregators (no v2 ops; use testnet2 for v2 testing)

<SendUserFile files=["/tmp/claude-1000/-home-pavelg-unicity-wallet-api/1e32e555-19ef-4bb4-b860-9f3a6a90260f/scratchpad/API.md"] status="normal" caption="Complete rewritten API.md for sphere-sdk v2" />
