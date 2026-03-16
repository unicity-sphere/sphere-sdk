# Sphere SDK API Reference

## Sphere

Main entry point for all SDK operations. The constructor is **private** — use static methods to create/load wallets.

### Static Methods

#### `Sphere.init(options: SphereInitOptions): Promise<SphereInitResult>`

Primary entry point. Creates a new wallet or loads an existing one automatically.

```typescript
const { sphere, created, generatedMnemonic } = await Sphere.init({
  storage, transport, oracle,
  tokenStorage,              // Optional (for IPFS sync)
  autoGenerate: true,        // Generate mnemonic if no wallet exists
  mnemonic: 'words...',      // Or provide mnemonic to create/import
  password: 'secret',        // Optional: encrypt mnemonic (plaintext if omitted)
  nametag: 'alice',          // Optional: register @alice on create
  l1: { electrumUrl: '...' }, // Optional L1 config (enabled by default)
  price: priceProvider,      // Optional PriceProvider
  derivationPath: "m/44'/0'/0'", // Optional custom path
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
| `payments` | `PaymentsModule` | L3 token operations + L1 via `.l1` |
| `payments.l1` | `L1PaymentsModule` | L1 ALPHA operations |
| `communications` | `CommunicationsModule` | Messaging operations |

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
console.log(addr0.address); // alpha1...

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
console.log(sphere.identity!.l1Address);      // alpha1... (address at index 1)
```

#### `getActiveAddresses(): TrackedAddress[]`

Get all non-hidden tracked addresses, sorted by index.

```typescript
const addresses = sphere.getActiveAddresses();
for (const addr of addresses) {
  console.log(`#${addr.index}: ${addr.l1Address} (${addr.nametag ?? 'no nametag'})`);
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

// By L1 address
const peer = await sphere.resolve('alpha1qptag...');

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
  l1Address: string;       // alpha1... L1 address
  directAddress: string;   // DIRECT://... L3 address
  proxyAddress?: string;   // PROXY://... (only if nametag registered)
  timestamp: number;       // Binding event timestamp
}
```

---

## PaymentsModule

Access via `sphere.payments`.

Handles all L3 (Unicity state transition network) token operations including transfers, balance queries, token lifecycle management, nametag minting, and multi-provider sync.

### Transfer Modes

`send()` automatically selects the optimal transfer path:

```
Path 1 — Whole-Token NOSTR-FIRST (no split needed):
  ┌─────────┐    commitment + token    ┌───────────┐
  │  Sender  │ ────── Nostr ──────────>│ Recipient  │
  └────┬─────┘                         └─────┬──────┘
       │  submit commitment (background)      │  submit commitment (idempotent)
       └──────> Aggregator <──────────────────┘  poll for proof → finalize

Path 2 — Instant Split V5 (~2.3s sender latency):
  ┌─────────┐  burn  ┌────────────┐  bundle via Nostr  ┌───────────┐
  │  Sender  │──────> │ Aggregator │                    │ Recipient  │
  └────┬─────┘ proof  └────────────┘                    └─────┬──────┘
       │ create mints + transfer commitment                   │
       │ ──────────── Nostr ─────────────────────────────────>│
       │  background: submit mints, save change               │ submit mint
       │                                                      │ wait for proof
       │                                                      │ submit transfer
       │                                                      │ finalize
```

### Methods: Balance & Assets

#### `getFiatBalance(): Promise<number | null>`

Returns total portfolio value in USD. Requires `PriceProvider` to be configured.

```typescript
const totalUsd = await sphere.payments.getFiatBalance();
// 1523.45 — total value of all confirmed tokens in USD
// null    — if PriceProvider is not configured or no prices available
```

#### `getBalance(coinId?: string): Asset[]`

Returns aggregated assets (tokens grouped by coinId) with confirmed/unconfirmed breakdown. Synchronous.

```typescript
const balances = sphere.payments.getBalance();

for (const bal of balances) {
  console.log(`${bal.symbol}:`);
  console.log(`  Confirmed:   ${bal.confirmedAmount} (${bal.confirmedTokenCount} tokens)`);
  console.log(`  Unconfirmed: ${bal.unconfirmedAmount} (${bal.unconfirmedTokenCount} tokens)`);
  console.log(`  Total:       ${bal.totalAmount}`);
  if (bal.fiatValueUsd !== null) {
    console.log(`  USD Value:   $${bal.fiatValueUsd.toFixed(2)}`);
  }
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
  readonly totalAmount: string;  // Sum of all token amounts (smallest units)
  readonly tokenCount: number;   // Number of tokens aggregated
  readonly confirmedAmount: string;     // Confirmed token amounts
  readonly unconfirmedAmount: string;   // Unconfirmed token amounts
  readonly confirmedTokenCount: number; // Number of confirmed tokens
  readonly unconfirmedTokenCount: number; // Number of unconfirmed tokens
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
  readonly sdkData?: string;  // Serialized SDK token
}

// Filter examples
const allTokens = sphere.payments.getTokens();
const uctOnly = sphere.payments.getTokens({ coinId: 'UCT' });
const confirmed = sphere.payments.getTokens({ status: 'confirmed' });
```

#### `getToken(id: string): Token | undefined`

Get a single token by ID.

#### `send(request: TransferRequest): Promise<TransferResult>`

Send tokens to a recipient. Automatically splits tokens when the exact amount is not available as a single token.

```typescript
interface TransferRequest {
  readonly coinId: string;       // Coin type (hex string)
  readonly amount: string;       // Amount in smallest units
  readonly recipient: string;    // @nametag, hex pubkey, DIRECT://, PROXY://, or alpha1... address
  readonly memo?: string;        // Optional message
  readonly addressMode?: AddressMode;  // 'auto' | 'direct' | 'proxy'
  readonly transferMode?: TransferMode;  // 'instant' | 'conservative'
}

type AddressMode = 'auto' | 'direct' | 'proxy';
type TransferMode = 'instant' | 'conservative';

interface TransferResult {
  readonly id: string;                       // Local transfer UUID
  status: TransferStatus;                    // Current status
  readonly tokens: Token[];                  // Tokens involved
  readonly tokenTransfers: TokenTransferDetail[];  // Per-token transfer details
  error?: string;                            // Error message if failed
}

interface TokenTransferDetail {
  readonly sourceTokenId: string;   // Source token ID consumed
  readonly method: 'direct' | 'split';  // Transfer method
  readonly requestIdHex?: string;   // Aggregator commitment request ID (direct)
  readonly splitGroupId?: string;   // Split group ID (split)
  readonly nostrEventId?: string;   // Nostr event ID (split)
}

type TransferStatus = 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';
```

**Events emitted:** `transfer:confirmed` on success, `transfer:failed` on error.

```typescript
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  addressMode: 'auto',
});
console.log(result.status); // 'completed'
```

**Transfer Modes:**

- **`'instant'`** (default) — Sends tokens via Nostr immediately with commitment data. The receiver resolves aggregator proofs in the background. Fastest sender experience (~2-3s for splits).
- **`'conservative'`** — Collects all aggregator proofs at the sender side before delivering fully finalized tokens (with `{ sourceToken, transferTx }`) via Nostr. Slower for the sender but the receiver gets immediately usable tokens with no background proof resolution needed.

```typescript
// Conservative transfer — receiver gets fully finalized tokens
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId: 'UCT',
  transferMode: 'conservative',
});
```

#### `receive(options?, callback?): Promise<ReceiveResult>`

Fetch and process pending incoming transfers from the transport layer (one-shot query).

Unlike the persistent subscription that delivers events asynchronously, `receive()` explicitly
queries the Nostr relay and resolves after all stored events are processed. Useful for
batch/CLI applications.

- **options** (`ReceiveOptions`, optional): Finalization control and progress reporting.
- **callback** (`(transfer: IncomingTransfer) => void`, optional): Invoked for each newly received transfer.

**ReceiveOptions:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `finalize` | `boolean` | `false` | Wait for all tokens to be finalized |
| `timeout` | `number` | `60000` | Finalization timeout in ms |
| `pollInterval` | `number` | `2000` | Poll interval between finalization attempts |
| `onProgress` | `function` | — | Progress callback during finalization |

**ReceiveResult:**

| Field | Type | Description |
|-------|------|-------------|
| `transfers` | `IncomingTransfer[]` | Newly received transfers |
| `finalization` | `UnconfirmedResolutionResult` | Result from resolveUnconfirmed() |
| `timedOut` | `boolean` | Whether finalization timed out |
| `finalizationDurationMs` | `number` | Duration of finalization in ms |

```typescript
// Simple usage — fetch and submit commitments once
const { transfers } = await sphere.payments.receive();

// With callback only
await sphere.payments.receive(undefined, (transfer) => {
  console.log(`Received ${transfer.tokens.length} tokens`);
});

// Wait for finalization
const result = await sphere.payments.receive({
  finalize: true,
  timeout: 30000,
  onProgress: (res) => console.log(`${res.stillPending} pending`),
});

// Both options and callback
const result = await sphere.payments.receive({ finalize: true }, (transfer) => {
  console.log(`Received ${transfer.tokens.length} tokens`);
});
```

---

### Methods: Unconfirmed Token Resolution

#### `resolveUnconfirmed(): Promise<UnconfirmedResolutionResult>`

Attempt to resolve unconfirmed (`status: 'submitted'`) tokens by acquiring missing aggregator proofs.

V5 tokens progress through stages:

```
RECEIVED → MINT_SUBMITTED → MINT_PROVEN → TRANSFER_SUBMITTED → FINALIZED
```

- Uses 500ms quick-timeouts per proof check (non-blocking).
- Tokens exceeding 50 failed attempts are marked `'invalid'`.
- Automatically called (fire-and-forget) by `getBalance()` and `load()`.

```typescript
interface UnconfirmedResolutionResult {
  resolved: number;       // Tokens fully confirmed
  stillPending: number;   // Tokens still waiting for proofs
  failed: number;         // Tokens that exceeded retry limit
  details: Array<{
    tokenId: string;
    stage: string;        // Current V5FinalizationStage
    status: 'resolved' | 'pending' | 'failed';
  }>;
}

type V5FinalizationStage = 'RECEIVED' | 'MINT_SUBMITTED' | 'MINT_PROVEN' | 'TRANSFER_SUBMITTED' | 'FINALIZED';
```

---

### Methods: Balance & Token Queries

#### `getBalance(coinId?: string): TokenBalance[]`

Get token balances grouped by coin type. **Synchronous** (no await needed).

Skips tokens with status `'spent'`, `'invalid'`, or `'transferring'`. Fires a non-blocking `resolveUnconfirmed()` call as a side effect.

```typescript
interface TokenBalance {
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly totalAmount: string;          // confirmedAmount + unconfirmedAmount
  readonly confirmedAmount: string;      // Tokens with inclusion proofs
  readonly unconfirmedAmount: string;    // Tokens pending proof (status: 'submitted')
  readonly tokenCount: number;           // Total token count
  readonly confirmedTokenCount: number;
  readonly unconfirmedTokenCount: number;
  readonly decimals: number;
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `coinId` | `string?` | Filter to a specific coin type. Omit for all. |

```typescript
const balances = sphere.payments.getBalance();
for (const bal of balances) {
  console.log(`${bal.symbol}: ${bal.confirmedAmount} confirmed, ${bal.unconfirmedAmount} unconfirmed`);
}
```

#### `getTokens(filter?): Token[]`

Get all tokens, optionally filtered. **Synchronous**.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filter.coinId` | `string?` | Filter by coin type |
| `filter.status` | `TokenStatus?` | Filter by status (e.g. `'submitted'` for unconfirmed) |

```typescript
type TokenStatus = 'pending' | 'submitted' | 'confirmed' | 'transferring' | 'spent' | 'invalid';

interface Token {
  readonly id: string;
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly amount: string;
  status: TokenStatus;
  readonly createdAt: number;
  updatedAt: number;
  readonly sdkData?: string;    // Serialized SDK token JSON
}
```

#### `getToken(id: string): Token | undefined`

Get a single token by its local UUID.

#### `getPendingTransfers(): TransferResult[]`

Get all in-progress (pending) outgoing transfers.

---

### Methods: Token CRUD

#### `addToken(token: Token, skipHistory?: boolean): Promise<boolean>`

Add a token to the wallet.

- **Tombstone check**: Rejected if exact `(tokenId, stateHash)` is tombstoned.
- **Duplicate check**: Rejected if same composite key already exists.
- **State replacement**: If same `tokenId` with different `stateHash`, archives old state and adds new.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `token` | `Token` | — | Token to add |
| `skipHistory` | `boolean` | `false` | Skip creating a RECEIVED history entry |

Returns `true` if added, `false` if rejected.

#### `updateToken(token: Token): Promise<void>`

Update an existing token. Matches by genesis tokenId or `token.id`. Falls back to `addToken()` if not found.

#### `removeToken(tokenId: string, recipientNametag?: string, skipHistory?: boolean): Promise<void>`

Remove a token. Archives it first, creates a tombstone `(tokenId, stateHash)`, and optionally adds a SENT history entry.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tokenId` | `string` | — | Local UUID of the token |
| `recipientNametag` | `string?` | — | Recipient nametag for history |
| `skipHistory` | `boolean` | `false` | Skip creating a SENT history entry |

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

Get transaction history sorted newest-first.

```typescript
interface TransactionHistoryEntry {
  id: string;
  type: 'SENT' | 'RECEIVED' | 'SPLIT' | 'MINT';
  amount: string;
  coinId: string;
  symbol: string;
  timestamp: number;
  recipientNametag?: string;
  senderPubkey?: string;
  transferId?: string;            // Links to TransferResult.id (for SENT entries)
}
```

#### `addToHistory(entry: Omit<TransactionHistoryEntry, 'id'>): Promise<void>`

Append a history entry (UUID auto-generated). Persisted immediately.

---

### Methods: Nametag Management

#### `mintNametag(nametag: string): Promise<MintNametagResult>`

Mint a nametag token on-chain. Required for receiving tokens via PROXY addresses.

```typescript
interface MintNametagResult {
  success: boolean;
  token?: Token;
  nametagData?: NametagData;
  readonly id: string;                       // Local transfer UUID
  status: TransferStatus;                    // Current status
  readonly tokens: Token[];                  // Tokens involved
  readonly tokenTransfers: TokenTransferDetail[];  // Per-token transfer details
  error?: string;                            // Error message if failed
}

interface TokenTransferDetail {
  readonly sourceTokenId: string;   // Source token ID consumed
  readonly method: 'direct' | 'split';  // Transfer method
  readonly requestIdHex?: string;   // Aggregator commitment request ID (direct)
  readonly splitGroupId?: string;   // Split group ID (split)
  readonly nostrEventId?: string;   // Nostr event ID (split)
}

type TransferStatus = 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';
```

#### `isNametagAvailable(nametag: string): Promise<boolean>`

Check if a nametag is available for minting.

#### `setNametag(nametag: NametagData): Promise<void>`

Set nametag data (persists to storage and file).

#### `getNametag(): NametagData | null`

Get current nametag data.

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

Validate tokens against the aggregator (checks state proofs).

```typescript
const { valid, invalid } = await sphere.payments.validate();
```

#### `getHistory(): TransactionHistoryEntry[]`

Get sorted transaction history (L3 transfers).

#### `getPendingTransfers(): TransferResult[]`

Get transfers that are still in progress.

#### `load(): Promise<void>`

Load all token data from storage providers. Restores pending V5 tokens and triggers `resolveUnconfirmed()`.

#### `destroy(): void`

Cleanup all subscriptions, polling jobs, and pending resolvers.

---

### Payment Requests (Incoming)

#### `sendPaymentRequest(recipient: string, request: PaymentRequest): Promise<PaymentRequestResult>`

Send a payment request to a recipient.

```typescript
interface PaymentRequest {
  amount: string;           // Amount in smallest units
  coinId: string;           // Token type (e.g., 'ALPHA')
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

## L1PaymentsModule

L1 (ALPHA blockchain) payments are accessed via `sphere.payments.l1`.

L1 is **enabled by default** with lazy WebSocket connection (connects on first use). Set `l1: null` to disable.

### Configuration

L1 is configured through `Sphere.init()`:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  l1: {
    electrumUrl: 'wss://fulcrum.alpha.unicity.network:50004',  // default
    defaultFeeRate: 10,    // sat/byte, default
    enableVesting: true,   // classify coins as vested/unvested, default
  },
});

// Access L1 via payments module
const balance = await sphere.payments.l1.getBalance();

// Disable L1 entirely
const { sphere } = await Sphere.init({ ...providers, autoGenerate: true, l1: null });
```

### L1Config

```typescript
interface L1Config {
  /** Fulcrum WebSocket URL (default: wss://fulcrum.alpha.unicity.network:50004) */
  electrumUrl?: string;
  /** Default fee rate in sat/byte (default: 10) */
  defaultFeeRate?: number;
  /** Enable vesting classification (default: true) */
  enableVesting?: boolean;
}
```

### Methods

#### `getBalance(): Promise<L1Balance>`

```typescript
interface L1Balance {
  confirmed: string;
  unconfirmed: string;
  vested: string;
  unvested: string;
  total: string;
}
```

#### `getUtxos(): Promise<L1Utxo[]>`

```typescript
interface L1Utxo {
  txid: string;
  vout: number;
  amount: string;
  address: string;
  isVested: boolean;
  confirmations: number;
}
```

#### `send(request: L1SendRequest): Promise<L1SendResult>`

```typescript
interface L1SendRequest {
  to: string;
  amount: string;      // in satoshis
  feeRate?: number;
  useVested?: boolean;  // Send only vested coins
  memo?: string;
}

interface L1SendResult {
  success: boolean;
  txHash?: string;
  fee?: string;
  error?: string;
}
```

#### `getHistory(limit?: number): Promise<L1Transaction[]>`

#### `getTransaction(txid: string): Promise<L1Transaction | null>`

Get a single transaction by txid.

#### `estimateFee(to: string, amount: string): Promise<{ fee: string; feeRate: number }>`

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

**Single Identity Model**: L1 and L3 share the same secp256k1 key pair. The same `privateKey`/`chainPubkey` is used for:
- L1 blockchain transactions (via `l1Address`)
- L3 token ownership and transfers (via `chainPubkey` and `directAddress`)
- Nostr P2P messaging (derived transport key)

```typescript
interface Identity {
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  chainPubkey: string;
  /** L1 bech32 address = alpha1... (hash160 of chainPubkey) */
  l1Address: string;
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
  address: string;      // L1 address (alpha1...)
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
  readonly l1Address: string;      // L1 bech32 address (alpha1...)
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
  | 'message:broadcast'
  | 'sync:started'
  | 'sync:completed'
  | 'sync:provider'
  | 'sync:error'
  | 'connection:changed'
  | 'nametag:registered'
  | 'nametag:recovered'
  | 'identity:changed'
  | 'address:activated'
  | 'address:hidden'
  | 'address:unhidden';
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
  'message:broadcast': BroadcastMessage;
  'sync:started': { source: string };
  'sync:completed': { source: string; count: number };
  'sync:provider': { providerId: string; success: boolean; added?: number; removed?: number; error?: string };
  'sync:error': { source: string; error: string };
  'connection:changed': { provider: string; connected: boolean };
  'nametag:registered': { nametag: string; addressIndex: number };
  'nametag:recovered': { nametag: string };
  'identity:changed': {
    l1Address: string;
    directAddress?: string;
    chainPubkey: string;
    nametag?: string;
    addressIndex: number;
  };
  'address:activated': { address: TrackedAddress };
  'address:hidden': { index: number; addressId: string };
  'address:unhidden': { index: number; addressId: string };
}
```

### InstantSplitBundleV5

The production bundle format for instant split transfers (~2.3s sender latency).

```typescript
interface InstantSplitBundleV5 {
  version: '5.0';
  type: 'INSTANT_SPLIT';
  burnTransaction: string;         // Proven burn transaction JSON
  recipientMintData: string;       // MintTransactionData JSON
  transferCommitment: string;      // Pre-created TransferCommitment JSON
  amount: string;                  // Payment amount
  coinId: string;                  // Coin ID hex
  tokenTypeHex: string;
  splitGroupId: string;            // Recovery correlation ID
  senderPubkey: string;
  recipientSaltHex: string;
  transferSaltHex: string;
  mintedTokenStateJson: string;    // Intermediate minted token state
  finalRecipientStateJson: string; // Final recipient state after transfer
  recipientAddressJson: string;    // PROXY or DIRECT address
  nametagTokenJson?: string;       // Nametag token for PROXY transfers
}
```

### PendingV5Finalization

Metadata stored in unconfirmed token's `sdkData` to track finalization progress.

```typescript
interface PendingV5Finalization {
  type: 'v5_bundle';
  stage: V5FinalizationStage;
  bundleJson: string;
  senderPubkey: string;
  savedAt: number;
  lastAttemptAt?: number;
  attemptCount: number;
  mintProofJson?: string;
}
```

### PaymentsModuleDependencies

```typescript
interface PaymentsModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  tokenStorageProviders?: Map<string, TokenStorageProvider>;
  transport: TransportProvider;
  oracle: OracleProvider;
  emitEvent: (type: SphereEventType, data: SphereEventMap[type]) => void;
  chainCode?: string;
  l1Addresses?: string[];
}
```

---

## Nametag Minting

Mint nametag tokens on-chain for PROXY address support (required for receiving tokens via @nametag).

### Sphere Methods

```typescript
// Mint nametag token on-chain
const result = await sphere.mintNametag('alice');

if (result.success) {
  console.log('Token minted:', result.nametagData?.name);
} else {
  console.error('Failed:', result.error);
}

// Check if nametag is available
const available = await sphere.isNametagAvailable('alice');
```

### MintNametagResult

```typescript
interface MintNametagResult {
  success: boolean;
  token?: Token;           // The minted nametag token
  nametagData?: NametagData;  // Nametag metadata
  error?: string;          // Error message if failed
}

interface NametagData {
  name: string;            // Nametag without @ prefix
  token: object;           // Token JSON (genesis + state)
  timestamp: number;       // Mint timestamp
  format?: string;         // 'txf'
  version?: string;        // '2.0'
}
```

### NametagMinter Class

For advanced usage, create a NametagMinter directly:

```typescript
import { NametagMinter, createNametagMinter } from '@unicitylabs/sphere-sdk';

const minter = createNametagMinter({
  stateTransitionClient: client,
  trustBase: trustBase,
  signingService: signingService,
  debug: false,
  skipVerification: false,
});

// Mint nametag
const result = await minter.mintNametag('alice', ownerAddress);

// Check availability
const available = await minter.isNametagAvailable('alice');
```

### NametagMinterConfig

```typescript
interface NametagMinterConfig {
  stateTransitionClient: StateTransitionClient;  // Required
  trustBase: TrustBase;                          // Required
  signingService: SigningService;                // Required
  debug?: boolean;                               // Default: false
  skipVerification?: boolean;                    // Default: false
}
```

### Auto-mint on Registration

The SDK automatically mints the nametag token on-chain whenever `registerNametag()` is called:

```typescript
// Option 1: During init (new wallet)
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'your words...',
  nametag: 'alice',  // Registers on Nostr AND mints token on-chain
});

// Option 2: Manual registration (e.g., for new derived address)
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');  // Also mints token automatically

// Option 3: On wallet load (auto-mint if token missing)
const { sphere } = await Sphere.init({ ...providers });
// If nametag exists but token is missing, it will be minted automatically
```

**When minting happens:**
- `Sphere.create()` with nametag → mints via `registerNametag()`
- `Sphere.load()` → mints if nametag exists but token is missing
- `Sphere.import()` with nametag → mints via `registerNametag()`
- `registerNametag()` → always mints if token not present

Nametag token is required for receiving tokens via PROXY addresses (`finalizeTransaction` requires nametag token for PROXY scheme).

---

## Token Split Calculator

Utility for calculating optimal token splits for partial transfers.

```typescript
import { createTokenSplitCalculator } from '@unicitylabs/sphere-sdk';

const calculator = createTokenSplitCalculator();

const plan = await calculator.calculateOptimalSplit(
  availableTokens,  // Token[]
  targetAmount,     // bigint
  coinIdHex         // string
);

if (plan) {
  console.log('Requires split:', plan.requiresSplit);
  console.log('Tokens to transfer:', plan.tokensToTransferDirectly);
  console.log('Token to split:', plan.tokenToSplit);
  console.log('Split amount:', plan.splitAmount);
  console.log('Change amount:', plan.changeAmount);
}
```

---

## Factory Functions

```typescript
// Storage
createLocalStorageProvider(config?: LocalStorageProviderConfig): LocalStorageProvider
createBrowserIpfsStorageProvider(config?: IpfsStorageConfig): IpfsStorageProvider  // Browser
createNodeIpfsStorageProvider(config?: IpfsStorageConfig, storage?: StorageProvider): IpfsStorageProvider  // Node.js

// Transport
createNostrTransportProvider(config?: NostrTransportProviderConfig): NostrTransportProvider
// NostrTransportProviderConfig accepts optional `storage` for event timestamp persistence

// Oracle
createUnicityAggregatorProvider(config?: UnicityAggregatorProviderConfig): UnicityAggregatorProvider

// Payments
createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule
// PaymentsModuleConfig includes optional l1?: L1PaymentsModuleConfig
createL1PaymentsModule(config?: L1PaymentsModuleConfig): L1PaymentsModule

// Communications
createCommunicationsModule(config?: CommunicationsModuleConfig): CommunicationsModule

// Token Split
createTokenSplitCalculator(): TokenSplitCalculator
createTokenSplitExecutor(client, trustBase): TokenSplitExecutor

// Validation
createTokenValidator(options?: TokenValidatorOptions): TokenValidator
```

---

## NostrTransportProviderConfig

```typescript
interface NostrTransportProviderConfig {
  relays?: string[];                // Nostr relay URLs
  timeout?: number;                 // Connection timeout (ms)
  autoReconnect?: boolean;          // Auto-reconnect on disconnect
  reconnectDelay?: number;          // Reconnect delay (ms)
  maxReconnectAttempts?: number;    // Max reconnect attempts
  debug?: boolean;                  // Enable debug logging
  createWebSocket: WebSocketFactory; // Platform-specific WebSocket factory
  generateUUID?: UUIDGenerator;      // Optional UUID generator
  storage?: TransportStorageAdapter; // Optional: persist event timestamps
}
```

### TransportStorageAdapter

Minimal key-value storage interface for transport persistence. When provided, the transport persists the last processed wallet event timestamp per pubkey. On reconnect, only events newer than the stored timestamp are fetched.

```typescript
interface TransportStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
```

**Note:** `createBrowserProviders()` and `createNodeProviders()` automatically pass the storage provider to the transport. Custom setups should pass any `StorageProvider` — it satisfies `TransportStorageAdapter` since it has the required `get`/`set` methods.

---

## Core Utilities

### Crypto Functions

```typescript
// Mnemonic operations
generateMnemonic(strength?: 128 | 256): string
validateMnemonic(mnemonic: string): boolean
mnemonicToSeedSync(mnemonic: string, password?: string): string

// Key derivation
generateMasterKey(seedHex: string): MasterKey
deriveChildKey(key: MasterKey, index: number, hardened?: boolean): MasterKey
deriveKeyAtPath(master: MasterKey, path: string): MasterKey
getPublicKey(privateKey: string, compressed?: boolean): string
createKeyPair(privateKey: string): KeyPair
deriveAddressInfo(master: MasterKey, path: string): AddressInfo
identityFromMnemonicSync(mnemonic: string, path?: string): FullIdentity

// Hashing
sha256(data: string, inputEncoding?: 'hex' | 'utf8'): string
ripemd160(data: string, inputEncoding?: 'hex' | 'utf8'): string
hash160(data: string): string  // sha256 + ripemd160
doubleSha256(data: string, inputEncoding?: 'hex' | 'utf8'): string

// Byte conversion
hexToBytes(hex: string): Uint8Array
bytesToHex(bytes: Uint8Array): string
randomBytes(length: number): string

// Message signing (secp256k1 ECDSA with recoverable signatures)
SIGN_MESSAGE_PREFIX: 'Sphere Signed Message:\n'
hashSignMessage(message: string): string  // double-SHA256 with prefix, returns 64-char hex
signMessage(privateKeyHex: string, message: string): string  // returns 130-char hex (v+r+s)
verifySignedMessage(message: string, signature: string, expectedPubkey: string): boolean
```

### Currency Functions

```typescript
// Convert human-readable to smallest unit
toSmallestUnit(amount: number | string, decimals?: number): bigint
// "1.5" with 18 decimals → 1500000000000000000n

// Convert smallest unit to human-readable
toHumanReadable(amount: bigint | string, decimals?: number): string
// 1500000000000000000n with 18 decimals → "1.5"

// Format with options
formatAmount(amount: bigint | string, options?: FormatOptions): string

interface FormatOptions {
  decimals?: number;      // Default: 18
  maxDecimals?: number;   // Max decimal places to show
  symbol?: string;        // Currency symbol
  locale?: string;        // Number formatting locale
}
```

### Bech32 Functions

```typescript
// Encode address
encodeBech32(hrp: string, version: number, program: Uint8Array): string
// encodeBech32('alpha', 1, pubkeyHash) → 'alpha1...'

// Decode address
decodeBech32(addr: string): { hrp: string; witnessVersion: number; data: Uint8Array } | null

// Create address from pubkey hash
createAddress(hrp: string, pubkeyHash: Uint8Array | string): string

// Validation
isValidBech32(addr: string): boolean
getAddressHrp(addr: string): string | null
```

### Utility Functions

```typescript
// Base58 encoding (Bitcoin-style)
base58Encode(hex: string): string
base58Decode(str: string): Uint8Array

// Private key validation
isValidPrivateKey(hex: string): boolean  // 0 < key < secp256k1 order

// Pattern matching
findPattern(data: Uint8Array, pattern: Uint8Array, startIndex?: number): number
extractFromText(text: string, pattern: RegExp): string | null

// Async utilities
sleep(ms: number): Promise<void>
randomHex(byteLength: number): string
randomUUID(): string
```

---

## TXF Serialization

### Token Conversion

```typescript
// Convert SDK Token to TXF format
tokenToTxf(token: Token): TxfToken | null

// Convert any object with sdkData to TXF
objectToTxf(obj: { id: string; sdkData?: string }): TxfToken | null

// Convert TXF back to Token
txfToToken(tokenId: string, txf: TxfToken): Token
```

### Storage Data

```typescript
// Build storage data for IPFS
buildTxfStorageData(
  tokens: Token[],
  meta: TxfMeta,
  options?: {
    nametag?: NametagData;
    tombstones?: TombstoneEntry[];
    archivedTokens?: Map<string, TxfToken>;
    forkedTokens?: Map<string, TxfToken>;
    outboxEntries?: OutboxEntry[];
    mintOutboxEntries?: MintOutboxEntry[];
    invalidatedNametags?: InvalidatedNametagEntry[];
  }
): Promise<TxfStorageData>

// Parse storage data
parseTxfStorageData(data: unknown): ParsedStorageData

interface ParsedStorageData {
  tokens: Token[];
  meta: TxfMeta | null;
  nametag: NametagData | null;
  tombstones: TombstoneEntry[];
  archivedTokens: Map<string, TxfToken>;
  forkedTokens: Map<string, TxfToken>;
  outboxEntries: OutboxEntry[];
  mintOutboxEntries: MintOutboxEntry[];
  invalidatedNametags: InvalidatedNametagEntry[];
  validationErrors: string[];
}
```

### Utility Functions

```typescript
// Normalize SDK token to storage format
normalizeSdkTokenToStorage(sdkTokenJson: unknown): TxfToken

// Get token ID (prefers genesis.data.tokenId)
getTokenId(token: Token): string

// Get current state hash
getCurrentStateHash(txf: TxfToken): string | undefined

// Validation helpers
hasValidTxfData(token: Token): boolean
hasUncommittedTransactions(token: Token): boolean
hasMissingNewStateHash(txf: TxfToken): boolean
countCommittedTransactions(token: Token): number
```

---

## Token Validation

### TokenValidator

```typescript
const validator = createTokenValidator(options?: {
  aggregatorClient?: AggregatorClient;
  trustBase?: unknown;
  skipVerification?: boolean;
});
```

### Methods

```typescript
// Validate all tokens
validateAllTokens(
  tokens: Token[],
  options?: { batchSize?: number; onProgress?: (completed: number, total: number) => void }
): Promise<ValidationResult>

interface ValidationResult {
  validTokens: Token[];
  issues: ValidationIssue[];
}

// Validate single token
validateToken(token: Token): Promise<TokenValidationResult>

interface TokenValidationResult {
  isValid: boolean;
  reason?: string;
  action?: 'ACCEPT' | 'RETRY_LATER' | 'DISCARD_FORK';
}

// Check if token state is spent
isTokenStateSpent(tokenId: string, stateHash: string, publicKey: string): Promise<boolean>

// Check spent tokens in batch
checkSpentTokens(
  tokens: Token[],
  publicKey: string,
  options?: { batchSize?: number; onProgress?: (completed: number, total: number) => void }
): Promise<SpentTokenResult>

interface SpentTokenResult {
  spentTokens: SpentTokenInfo[];
  errors: string[];
}

interface SpentTokenInfo {
  tokenId: string;
  localId: string;
  stateHash: string;
}

// Set/update dependencies
setAggregatorClient(client: AggregatorClient): void
setTrustBase(trustBase: unknown): void

// Cache management
clearSpentStateCache(): void
```

### AggregatorClient Interface

```typescript
interface AggregatorClient {
  getInclusionProof(requestId: unknown): Promise<{
    inclusionProof?: {
      authenticator: unknown | null;
      merkleTreePath: {
        verify(key: bigint): Promise<{
          isPathValid: boolean;
          isPathIncluded: boolean;
        }>;
      };
    };
  }>;
  isTokenStateSpent?(trustBase: unknown, token: unknown, pubKey: Buffer): Promise<boolean>;
}
```

---

## PriceProvider

Optional provider for fetching token market prices. Enables `getBalance()` (total USD value) and price enrichment in `getAssets()`.

### Configuration

```typescript
// Via createBrowserProviders / createNodeProviders
const providers = createBrowserProviders({
  network: 'testnet',
  price: {
    platform: 'coingecko',       // Currently supported: 'coingecko'
    apiKey: 'CG-xxx',            // Optional (free tier works without key)
    baseUrl: '/api/coingecko',   // Optional: custom base URL (e.g., CORS proxy)
    cacheTtlMs: 60000,           // Cache TTL (default: 60s)
    timeout: 10000,              // Request timeout (default: 10s)
    debug: false,                // Enable debug logging
  },
});

// Or set after initialization
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: 'CG-xxx',
}));
```

### PriceProvider Interface

```typescript
type PricePlatform = 'coingecko';

interface TokenPrice {
  readonly tokenName: string;    // CoinGecko ID (e.g., "bitcoin")
  readonly priceUsd: number;
  readonly priceEur?: number;
  readonly change24h?: number;
  readonly timestamp: number;
}

interface PriceProvider {
  readonly platform: PricePlatform;
  getPrices(tokenNames: string[]): Promise<Map<string, TokenPrice>>;
  getPrice(tokenName: string): Promise<TokenPrice | null>;
  clearCache(): void;
}
```

### PriceProviderConfig

```typescript
interface PriceProviderConfig {
  platform: PricePlatform;     // 'coingecko'
  apiKey?: string;             // API key (optional for free tier)
  baseUrl?: string;            // Custom base URL (e.g., for CORS proxy)
  cacheTtlMs?: number;        // Cache TTL in ms (default: 60000)
  timeout?: number;            // Request timeout in ms (default: 10000)
  debug?: boolean;             // Enable debug logging
}
```

### CoinGeckoPriceProvider

- **Free tier**: `api.coingecko.com` (no API key needed, rate-limited)
- **Pro tier**: `pro-api.coingecko.com` (requires API key via `x-cg-pro-api-key` header)
- **Custom URL**: `baseUrl` overrides the default API endpoint (useful for CORS proxy in browser)
- Internal cache with configurable TTL (default 60s)
- **Negative cache**: tokens not found on CoinGecko are cached as "not found" for the TTL duration, preventing repeated API requests for project-specific tokens
- Partial fetch: only requests uncached tokens from API
- Stale-on-error: returns cached data on API failure instead of throwing

### CORS Proxy (Browser)

CoinGecko's free API does not include CORS headers, so browser requests will be blocked. Solutions:

1. **Development**: Use a dev server proxy (e.g., Vite):
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

   // SDK config
   const providers = createBrowserProviders({
     network: 'testnet',
     price: { platform: 'coingecko', baseUrl: '/api/coingecko' },
   });
   ```

2. **Production**: Use a reverse proxy (Nginx, Cloudflare Worker, etc.) or the CoinGecko Pro API which supports CORS natively.

3. **Node.js**: No proxy needed — server-side requests are not subject to CORS.

---

## IpfsStorageProvider

HTTP-based IPFS/IPNS storage provider that implements `TokenStorageProvider`. Works on both browser and Node.js using native `fetch`. Provides decentralized token backup with automatic conflict resolution.

**Source:** `impl/shared/ipfs/ipfs-storage-provider.ts`

### Configuration

```typescript
interface IpfsStorageConfig {
  gateways?: string[];              // Gateway URLs (default: Unicity IPFS nodes)
  fetchTimeoutMs?: number;          // Content fetch timeout (default: 15000)
  resolveTimeoutMs?: number;        // IPNS resolution timeout (default: 10000)
  publishTimeoutMs?: number;        // IPNS publish timeout (default: 30000)
  connectivityTimeoutMs?: number;   // Gateway health check timeout (default: 5000)
  ipnsLifetimeMs?: number;          // IPNS record lifetime (default: 99 years)
  ipnsCacheTtlMs?: number;          // IPNS cache TTL (default: 60000)
  circuitBreakerThreshold?: number; // Failures before cooldown (default: 3)
  circuitBreakerCooldownMs?: number;// Cooldown duration (default: 60000)
  knownFreshWindowMs?: number;      // Known-fresh window (default: 30000)
  debug?: boolean;                  // Enable debug logging (default: false)
}
```

### Factory Functions

#### `createBrowserIpfsStorageProvider(config?)`

Creates a browser IPFS storage provider with `localStorage`-based state persistence.

```typescript
import { createBrowserIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';

const provider = createBrowserIpfsStorageProvider({ debug: true });
```

**Parameters:**
- `config?` — `IpfsStorageConfig` (all fields optional)

**Returns:** `IpfsStorageProvider`

#### `createNodeIpfsStorageProvider(config?, storageProvider?)`

Creates a Node.js IPFS storage provider with file-based state persistence.

```typescript
import { createNodeIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs/ipfs';
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage = new FileStorageProvider('./wallet-data');
const provider = createNodeIpfsStorageProvider({ debug: true }, storage);
```

**Parameters:**
- `config?` — `IpfsStorageConfig` (all fields optional)
- `storageProvider?` — `StorageProvider` for persisting IPNS state between sessions

**Returns:** `IpfsStorageProvider`

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `'ipfs'` | Provider identifier |
| `name` | `'IPFS Storage'` | Display name |
| `type` | `'p2p'` | Provider type |

### Methods

#### `setIdentity(identity: FullIdentity): void`

Set the wallet identity. Must be called before `initialize()`.

#### `initialize(): Promise<boolean>`

Initialize the provider: derive IPNS key pair, load persisted state, test gateway connectivity. Returns `true` on success, `false` on failure.

#### `shutdown(): Promise<void>`

Clear caches and disconnect.

#### `connect(): Promise<void>` / `disconnect(): Promise<void>`

Aliases for `initialize()` / `shutdown()`.

#### `isConnected(): boolean`

Returns `true` if status is `'connected'`.

#### `getStatus(): ProviderStatus`

Returns `'disconnected'` | `'connecting'` | `'connected'` | `'error'`.

#### `save(data: TData): Promise<SaveResult>`

Upload token data to IPFS and publish an IPNS record.

```typescript
interface SaveResult {
  success: boolean;
  cid?: string;       // CID of uploaded content
  error?: string;
  timestamp: number;
}
```

#### `load(identifier?: string): Promise<LoadResult<TData>>`

Load token data from IPFS. Without `identifier`, resolves via IPNS. With a CID `identifier`, fetches directly.

```typescript
interface LoadResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  source: 'local' | 'remote' | 'cache';
  timestamp: number;
}
```

#### `sync(localData: TData): Promise<SyncResult<TData>>`

Sync local data with IPFS: load remote, merge, save merged result.

```typescript
interface SyncResult<T> {
  success: boolean;
  merged?: T;         // Merged data
  added: number;      // Tokens added from remote
  removed: number;    // Tokens removed (tombstoned)
  conflicts: number;  // Conflicts resolved (local wins)
  error?: string;
}
```

#### `exists(): Promise<boolean>`

Check if an IPNS record exists for this wallet.

#### `clear(): Promise<boolean>`

Publish an empty data set and clear local caches.

#### `onEvent(callback: StorageEventCallback): () => void`

Subscribe to storage events. Returns an unsubscribe function.

#### `getIpnsName(): string | null`

Get the derived IPNS name (available after `initialize()`).

#### `getLastCid(): string | null`

Get the last known CID.

#### `getSequenceNumber(): bigint`

Get the current IPNS sequence number.

#### `getDataVersion(): number`

Get the data version counter.

#### `getRemoteCid(): string | null`

Get the CID currently stored on the remote (used for chain validation).

### Types

#### `IpfsPersistedState`

```typescript
interface IpfsPersistedState {
  sequenceNumber: string;   // bigint serialized as string
  lastCid: string | null;
  version: number;
}
```

#### `IpfsStatePersistence`

Platform-specific state storage interface:

```typescript
interface IpfsStatePersistence {
  load(ipnsName: string): Promise<IpfsPersistedState | null>;
  save(ipnsName: string, state: IpfsPersistedState): Promise<void>;
  clear(ipnsName: string): Promise<void>;
}
```

#### `IpfsError`

```typescript
class IpfsError extends Error {
  readonly category: IpfsErrorCategory;
  readonly gateway?: string;
  readonly cause?: Error;
  get shouldTriggerCircuitBreaker(): boolean;
}
```

#### `IpfsErrorCategory`

```typescript
type IpfsErrorCategory =
  | 'NOT_FOUND'          // IPNS record not published (new wallet)
  | 'NETWORK_ERROR'      // Connectivity issues
  | 'TIMEOUT'            // Request timed out
  | 'GATEWAY_ERROR'      // Gateway returned error (5xx)
  | 'INVALID_RESPONSE'   // Response parsing failed
  | 'CID_MISMATCH'       // Content hash mismatch
  | 'SEQUENCE_DOWNGRADE'; // Remote sequence < local
```

### Storage Events

| Event | When |
|-------|------|
| `storage:saving` | Before uploading to IPFS |
| `storage:saved` | After successful save (data: `{ cid, sequence }`) |
| `storage:loading` | Before loading from IPFS |
| `storage:loaded` | After successful load (data: `{ cid, sequence }`) |
| `storage:error` | On any error (error: message string) |
| `sync:started` | Before sync begins |
| `sync:completed` | After sync completes (data: `{ added, removed, conflicts }`) |
| `sync:conflict` | When merge conflicts are resolved (data: `{ conflicts }`) |
| `sync:error` | On sync error (error: message string) |

### Architecture

```
Save Flow:
  data → JSON serialize → POST /api/v0/add (IPFS upload)
       → create signed IPNS record (Ed25519)
       → POST /api/v0/routing/put (IPNS publish to all gateways)
       → update cache + persist state

Load Flow:
  known-fresh check → IPNS TTL cache → POST /api/v0/routing/get (resolve IPNS)
       → GET /ipfs/{cid} (fetch content from fastest gateway)
       → cache content → return data

Sync Flow:
  load remote → merge(local, remote) → save merged
  (if no remote: save local as initial)
```

See [IPFS Storage Guide](./IPFS-STORAGE.md) for complete documentation.

---

## AccountingModule (Invoicing)

Access via `sphere.accounting` (once registered on the `Sphere` instance).

Manages the full invoice lifecycle: creation, import, payment attribution, status tracking, balance computation, auto-return, and receipt/cancellation-notice delivery. Persists invoice tokens, terminal-state sets, frozen balances, and an incremental invoice-transfer index (§5.4).

### Lifecycle

```typescript
import { AccountingModule } from '@unicitylabs/sphere-sdk';

// 1. Construct (once, optional config)
const accounting = new AccountingModule({ debug: false });

// 2. Inject dependencies (must come before load())
accounting.initialize({
  payments,        // PaymentsModule
  tokenStorage,    // TokenStorageProvider
  oracle,          // OracleProvider
  trustBase,       // aggregator trust base (from oracle config)
  identity,        // FullIdentity
  getActiveAddresses: () => sphere.getActiveAddresses(),
  emitEvent: (type, data) => sphere.emit(type, data),
  on: (type, handler) => sphere.on(type, handler),
  storage,         // StorageProvider
  communications,  // CommunicationsModule (optional, enables receipt DMs)
});

// 3. Load persisted state and subscribe to events
await accounting.load();

// 4. Use public API methods (see below)

// 5. Cleanup on wallet lock / app shutdown
await accounting.destroy();
```

### Quick Usage Example

```typescript
// --- Invoice creator (seller) ---

// Create an invoice requesting 1 000 000 UCT to your DIRECT address
const { invoiceId, token, terms } = await accounting.createInvoice({
  targets: [{
    address: identity.directAddress!,
    assets: [{ coin: ['UCT', '1000000'] }],
  }],
  memo: 'Order #42 — coffee beans',
  dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,  // 7 days
});

// Export the raw TXF token to share with the buyer
const txfToken = await sphere.payments.getTokens().find(t => t.id === invoiceId);

// --- Payer (buyer) ---

// Import the invoice token received out-of-band
const terms = await accounting.importInvoice(txfToken);

// Pay the first target's first asset
const result = await accounting.payInvoice(invoiceId!, {
  targetIndex: 0,
  assetIndex: 0,
  refundAddress: identity.directAddress,  // enables auto-return if invoice is cancelled
});

// --- Invoice creator (after payment arrives) ---

// Query status
const status = await accounting.getInvoiceStatus(invoiceId!);
console.log(status.state);  // 'COVERED' or 'CLOSED'

// Explicitly close the invoice and send receipts to payers
await accounting.closeInvoice(invoiceId!);
const receipts = await accounting.sendInvoiceReceipts(invoiceId!, {
  memo: 'Thank you for your order!',
});
console.log(`Sent ${receipts.sent} receipt(s)`);
```

---

### Lifecycle Methods

#### `initialize(deps: AccountingModuleDependencies): void`

Inject dependencies. Must be called before `load()`. Calling again replaces deps without resetting in-memory state — always follow with `load()`.

#### `load(): Promise<void>`

Load persisted state (invoice tokens, terminal sets, frozen balances, auto-return settings) and subscribe to `PaymentsModule` and `CommunicationsModule` event streams.

Calling `load()` while already loading returns the same promise (re-entry safe). Calling `load()` again after initial load re-runs the full restore sequence.

**Throws:**
- `NOT_INITIALIZED` — `initialize()` has not been called.
- `MODULE_DESTROYED` — module has been destroyed.

#### `destroy(): Promise<void>`

Unsubscribe from all events, drain in-flight operations, and mark the module as destroyed. After this call all public API methods throw `MODULE_DESTROYED`. Safe to call multiple times.

---

### Invoice CRUD

#### `createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResult>`

Mint a new invoice token on-chain via the Aggregator. The token IS the invoice: its genesis `tokenData` field contains the serialized `InvoiceTerms`.

```typescript
interface CreateInvoiceRequest {
  /** Payment targets — at least one required, at most 100. */
  readonly targets: InvoiceTarget[];
  /** Optional due date (ms). Must be in the future if provided. */
  readonly dueDate?: number;
  /** Optional free-text memo (max 4096 chars). */
  readonly memo?: string;
  /**
   * Ordered delivery method URLs (placeholder — Nostr delivery only in v1).
   * Max 10 entries, each https:// or wss://, max 2048 chars.
   */
  readonly deliveryMethods?: string[];
  /**
   * If false, omit the creator's chain pubkey from InvoiceTerms.
   * Defaults to true (identified invoice).
   */
  readonly anonymous?: boolean;
}

interface InvoiceTarget {
  /** Destination DIRECT:// address. */
  readonly address: string;
  /** Assets to request at this address. */
  readonly assets: InvoiceRequestedAsset[];
}

interface InvoiceRequestedAsset {
  /** Fungible: [coinId, amount in smallest units]. */
  readonly coin?: CoinEntry;  // [string, string]
  /** NFT (placeholder — not implemented in v1). */
  readonly nft?: NFTEntry;
}

interface CreateInvoiceResult {
  readonly success: boolean;
  readonly invoiceId?: string;     // Invoice token ID (64-char hex)
  readonly token?: TxfToken;       // Raw TXF token
  readonly terms?: InvoiceTerms;   // Parsed invoice terms
  readonly error?: string;
}
```

**Throws:**
- `INVOICE_NO_TARGETS` — targets array is empty.
- `INVOICE_TOO_MANY_TARGETS` — more than 100 targets.
- `INVOICE_INVALID_ADDRESS` — a target address is not a valid `DIRECT://` address.
- `INVOICE_NO_ASSETS` — a target has no assets.
- `INVOICE_TOO_MANY_ASSETS` — a target has more than 10 assets.
- `INVOICE_INVALID_ASSET` — an asset has neither `coin` nor `nft`, or has both.
- `INVOICE_INVALID_AMOUNT` — a coin amount is not a positive integer string.
- `INVOICE_INVALID_COIN` — a coin ID is empty or not a string.
- `INVOICE_DUPLICATE_ADDRESS` — duplicate target addresses.
- `INVOICE_DUPLICATE_COIN` — duplicate coin IDs within a target.
- `INVOICE_PAST_DUE_DATE` — `dueDate` is not in the future.
- `INVOICE_MEMO_TOO_LONG` — memo exceeds 4096 characters.
- `INVOICE_TERMS_TOO_LARGE` — serialized terms exceed storage limit.
- `INVOICE_INVALID_DELIVERY_METHOD` — delivery method fails scheme/length validation.
- `INVOICE_MINT_FAILED` — aggregator submission failed after retries.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `importInvoice(token: TxfToken): Promise<InvoiceTerms>`

Import an invoice token received out-of-band (e.g., shared by a creator via IPFS, DM, or QR code). Validates token type and parses `InvoiceTerms`. Persists the token in `TokenStorage` and adds it to the in-memory cache. Idempotent for the same token but fails if already exists with a different state.

**Returns:** Parsed `InvoiceTerms`.

**Throws:**
- `INVOICE_WRONG_TOKEN_TYPE` — token's `tokenType` is not the invoice type constant.
- `INVOICE_INVALID_DATA` — `tokenData` field is missing or cannot be parsed as `InvoiceTerms`.
- `INVOICE_ALREADY_EXISTS` — an invoice with this token ID is already stored locally.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `getInvoice(invoiceId: string): InvoiceRef | null`

Get a lightweight invoice reference by token ID. **Synchronous** — reads from in-memory cache populated during `load()`.

```typescript
interface InvoiceRef {
  readonly invoiceId: string;
  readonly terms: InvoiceTerms;
  /** True if terms.creator matches the current wallet's chainPubkey. */
  readonly isCreator: boolean;
  readonly cancelled: boolean;
  readonly closed: boolean;
}
```

Returns `null` if the invoice is not found locally. Does **not** throw `INVOICE_NOT_FOUND`.

**Throws:**
- `NOT_INITIALIZED`

#### `getInvoices(options?: GetInvoicesOptions): Promise<InvoiceRef[]>`

List all locally known invoices with optional filtering and sorting. Status (OPEN, PARTIAL, COVERED, etc.) is **not** included in `InvoiceRef` — call `getInvoiceStatus()` per invoice when needed.

```typescript
interface GetInvoicesOptions {
  /** Filter by computed state (requires status computation — may be slower). */
  readonly state?: InvoiceState | InvoiceState[];
  /** Only invoices created by this wallet. */
  readonly createdByMe?: boolean;
  /** Only invoices where this wallet is a target. */
  readonly targetingMe?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  /** Sort field. Invoices without dueDate sort last when sortBy='dueDate'. */
  readonly sortBy?: 'createdAt' | 'dueDate';
  readonly sortOrder?: 'asc' | 'desc';
}
```

**Throws:**
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus>`

Compute the current status of an invoice. For non-terminal invoices (OPEN, PARTIAL, COVERED, EXPIRED) the status is derived fresh on every call from the in-memory invoice-transfer index. For terminal invoices (CLOSED, CANCELLED) the persisted frozen balances are returned.

**Side effect:** if the invoice reaches implicit close (state=COVERED and all tokens confirmed), this call acquires the per-invoice gate, freezes balances, persists them, and may trigger surplus auto-return.

```typescript
type InvoiceState = 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED';

interface InvoiceStatus {
  readonly invoiceId: string;
  readonly state: InvoiceState;
  /** Per-target breakdown. */
  readonly targets: InvoiceTargetStatus[];
  /** Transfers referencing this invoice that do not match any target or asset. */
  readonly irrelevantTransfers: IrrelevantTransfer[];
  /** Sum of all forward payments per coinId (across all targets). */
  readonly totalForward: Record<string, string>;
  /** Sum of all back/return payments per coinId (across all targets). */
  readonly totalBack: Record<string, string>;
  /** Whether ALL related tokens are confirmed (always dynamic, never frozen). */
  readonly allConfirmed: boolean;
  /** Timestamp of the most recent related transfer. */
  readonly lastActivityAt: number;
  /** Whether the invoice was explicitly closed (true) or implicitly (false). Only meaningful when state=CLOSED. */
  readonly explicitClose?: boolean;
}
```

**Throws:**
- `INVOICE_NOT_FOUND` — invoice not in local cache.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

---

### Invoice Termination

Both methods require the calling wallet to be a **target** of the invoice.

#### `closeInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>`

Explicitly close an invoice. Freezes current balances, persists the CLOSED state, and fires `invoice:closed` with `{ explicit: true }`. If `options.autoReturn` is `true`, enables auto-return for this invoice and immediately returns any surplus to payers.

**Throws:**
- `INVOICE_NOT_FOUND` / `INVOICE_NOT_TARGET` / `INVOICE_ALREADY_CLOSED` / `INVOICE_ALREADY_CANCELLED`
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `cancelInvoice(invoiceId: string, options?: { autoReturn?: boolean }): Promise<void>`

Cancel an invoice. Freezes current balances, persists the CANCELLED state, and fires `invoice:cancelled`. If `options.autoReturn` is `true`, enables auto-return and immediately returns all forwarded payments to payers.

**Throws:**
- `INVOICE_NOT_FOUND` / `INVOICE_NOT_TARGET` / `INVOICE_ALREADY_CLOSED` / `INVOICE_ALREADY_CANCELLED`
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

---

### Payments

#### `payInvoice(invoiceId: string, params: PayInvoiceParams): Promise<TransferResult>`

Send a payment toward an invoice. Builds the structured memo (`INV:<invoiceId>:F`), optionally embeds a refund address and contact info in the on-chain `TransferMessagePayload`, and delegates to `PaymentsModule.send()`.

```typescript
interface PayInvoiceParams {
  /** Index into invoice.terms.targets[]. */
  readonly targetIndex: number;
  /** Index into target.assets[]. Defaults to 0. */
  readonly assetIndex?: number;
  /**
   * Amount in smallest units. Defaults to the remaining amount needed to
   * fully cover the requested asset (i.e., requested − already paid).
   */
  readonly amount?: string;
  /** Optional free text appended after the structured memo prefix. */
  readonly freeText?: string;
  /**
   * Explicit refund address (DIRECT:// format). Embedded on-chain in the
   * TransferMessagePayload inv.ra field — not in the transport memo.
   * Required for masked-predicate wallets that cannot be resolved for return.
   * Auto-populated from identity.directAddress when omitted.
   */
  readonly refundAddress?: string;
  /**
   * Contact info for the target to reach the payer (receipts, notices).
   * Embedded on-chain in inv.ct. Not in transport memo.
   * Auto-populated from identity.directAddress when omitted.
   */
  readonly contact?: { address: string; url?: string };
}
```

Returns the `TransferResult` from `PaymentsModule.send()`.

**Throws:**
- `INVOICE_NOT_FOUND` — invoice not found locally.
- `INVOICE_TERMINATED` — invoice is already closed or cancelled.
- `INVOICE_INVALID_TARGET` — targetIndex out of range.
- `INVOICE_INVALID_ASSET_INDEX` — assetIndex out of range.
- `INVOICE_INVALID_REFUND_ADDRESS` — not a valid `DIRECT://` address.
- `INVOICE_INVALID_CONTACT` — contact.address or contact.url fails validation.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `returnInvoicePayment(invoiceId: string, params: ReturnPaymentParams): Promise<TransferResult>`

Manually return a payment to a payer. Requires the calling wallet to be a target. Validates that the return amount does not exceed the payer's net balance for the given coin. Serialized inside the per-invoice gate to prevent concurrent over-refunds.

```typescript
interface ReturnPaymentParams {
  /** The payer's effective address (DIRECT:// format) to return funds to. */
  readonly recipient: string;
  /** Amount in smallest units. */
  readonly amount: string;
  readonly coinId: string;
  /** Optional free text appended to the return memo. */
  readonly freeText?: string;
}
```

**Throws:**
- `INVOICE_NOT_FOUND` / `INVOICE_NOT_TARGET`
- `INVOICE_RETURN_EXCEEDS_BALANCE` — amount exceeds the payer's net balance.
- `INVOICE_INVALID_AMOUNT` — amount is not a positive integer string.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

---

### Auto-Return

Auto-return automatically sends back surplus or full payments to payers when an invoice is terminated (closed or cancelled). It operates on frozen per-sender balances.

#### `setAutoReturn(invoiceId: string | '*', enabled: boolean): Promise<void>`

Enable or disable auto-return.

- **`invoiceId`**: Enable/disable auto-return for a specific invoice. If enabling on a terminated invoice, surplus return is triggered immediately.
- **`'*'`**: Enable/disable globally for all terminated invoices. Enabling `'*'` immediately triggers return on all currently terminated invoices (up to 100). Rate-limited to one call per 5 seconds.

**Throws:**
- `INVOICE_NOT_FOUND` — `invoiceId` is not `'*'` and the invoice does not exist.
- `RATE_LIMITED` — `'*'` was called within the 5-second cooldown.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `getAutoReturnSettings(): AutoReturnSettings`

Get current auto-return settings. **Synchronous**.

```typescript
interface AutoReturnSettings {
  /** Global flag — applies to all terminated invoices unless overridden. */
  readonly global: boolean;
  /** Per-invoice overrides: invoiceId → enabled. */
  readonly perInvoice: Record<string, boolean>;
}
```

**Throws:**
- `NOT_INITIALIZED`

---

### Receipts and Cancellation Notices

Both methods require `CommunicationsModule` to be provided in `AccountingModuleDependencies`. They send structured DMs to each payer who contributed to the invoice.

#### `sendInvoiceReceipts(invoiceId: string, options?: SendInvoiceReceiptsOptions): Promise<SendReceiptsResult>`

Send receipt DMs to payers of a terminated invoice (CLOSED or CANCELLED). One DM per unique effective sender address per target. Requires `CommunicationsModule`.

```typescript
interface SendInvoiceReceiptsOptions {
  /** Optional memo / deal description included in each receipt. Max 4096 chars. */
  readonly memo?: string;
  /** Send receipts to senders with net balance of 0 (default: false). */
  readonly includeZeroBalance?: boolean;
}

interface SendReceiptsResult {
  readonly sent: number;
  readonly failed: number;
  readonly sentReceipts: SentReceiptInfo[];
  readonly failedReceipts: FailedReceiptInfo[];
}
```

**Throws:**
- `INVOICE_NOT_FOUND` / `INVOICE_NOT_TARGET`
- `INVOICE_NOT_TERMINATED` — invoice is not in CLOSED or CANCELLED state.
- `COMMUNICATIONS_UNAVAILABLE` — `CommunicationsModule` not provided.
- `INVOICE_MEMO_TOO_LONG` — memo exceeds 4096 characters.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `sendCancellationNotices(invoiceId: string, options?: SendCancellationNoticesOptions): Promise<SendNoticesResult>`

Send cancellation notice DMs to payers of a CANCELLED invoice. Unlike receipts (which apply to both terminal states), cancellation notices carry cancellation-specific context.

```typescript
interface SendCancellationNoticesOptions {
  /** Free-text cancellation reason. Max 4096 chars. */
  readonly reason?: string;
  /** Context about the deal/service being cancelled. Max 4096 chars. */
  readonly dealDescription?: string;
  /** Send notices to senders with net balance of 0 (default: false). */
  readonly includeZeroBalance?: boolean;
}

interface SendNoticesResult {
  readonly sent: number;
  readonly failed: number;
  readonly sentNotices: SentNoticeInfo[];
  readonly failedNotices: FailedNoticeInfo[];
}
```

**Throws:**
- `INVOICE_NOT_FOUND` / `INVOICE_NOT_TARGET`
- `INVOICE_NOT_CANCELLED` — invoice is not in CANCELLED state (use `sendInvoiceReceipts()` for CLOSED).
- `COMMUNICATIONS_UNAVAILABLE` — `CommunicationsModule` not provided.
- `INVOICE_MEMO_TOO_LONG` — reason or dealDescription exceeds 4096 characters.
- `NOT_INITIALIZED` / `MODULE_DESTROYED`

---

### Utilities

#### `getRelatedTransfers(invoiceId: string): (InvoiceTransferRef | IrrelevantTransfer)[]`

Get all transfers indexed for an invoice, sorted by timestamp ascending. Includes both relevant (forward/back/return) and irrelevant transfers. **Synchronous**.

```typescript
interface InvoiceTransferRef {
  readonly transferId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  readonly coinId: string;
  readonly amount: string;
  readonly destinationAddress: string;
  readonly timestamp: number;
  readonly confirmed: boolean;
  readonly senderAddress: string | null;  // null if sender predicate is masked
  readonly refundAddress?: string;
  readonly contact?: { address: string; url?: string };
  readonly senderPubkey?: string;
  readonly senderNametag?: string;
  readonly recipientPubkey?: string;
  readonly recipientNametag?: string;
}

interface IrrelevantTransfer extends InvoiceTransferRef {
  readonly reason:
    | 'unknown_address'
    | 'unknown_asset'
    | 'unknown_address_and_asset'
    | 'self_payment'
    | 'no_coin_data'
    | 'unauthorized_return';
}
```

**Throws:**
- `INVOICE_NOT_FOUND` / `NOT_INITIALIZED` / `MODULE_DESTROYED`

#### `parseInvoiceMemo(memo: string): InvoiceMemoRef | null`

Parse a transfer memo string and extract invoice reference information. Pure function — no side effects, no state requirements.

```typescript
interface InvoiceMemoRef {
  readonly invoiceId: string;  // 64-char hex token ID
  readonly paymentDirection: 'forward' | 'back' | 'return_closed' | 'return_cancelled';
  readonly freeText?: string;  // Optional text after the structured prefix
}

// Memo format: 'INV:<invoiceId>:<direction>[:<freeText>]'
// Direction codes: F=forward, B=back, RC=return-closed, RX=return-cancelled
```

Returns `null` if the memo does not match the `INV:` format.

---

### Invoice Events

All invoice events are emitted via `sphere.on(eventType, handler)`.

| Event | Payload | Description |
|-------|---------|-------------|
| `invoice:created` | `{ invoiceId, confirmed }` | Invoice token minted and saved |
| `invoice:payment` | `{ invoiceId, transfer, paymentDirection, confirmed }` | New payment transfer indexed |
| `invoice:asset_covered` | `{ invoiceId, address, coinId, confirmed }` | A single coin asset fully covered |
| `invoice:target_covered` | `{ invoiceId, address, confirmed }` | All assets for a target covered |
| `invoice:covered` | `{ invoiceId, confirmed }` | All targets covered (full invoice) |
| `invoice:closed` | `{ invoiceId, explicit }` | Invoice closed (explicit=false if auto-closed on COVERED+confirmed) |
| `invoice:cancelled` | `{ invoiceId }` | Invoice cancelled |
| `invoice:expired` | `{ invoiceId }` | Invoice passed its dueDate while OPEN or PARTIAL |
| `invoice:unknown_reference` | `{ invoiceId, transfer }` | Transfer references an unknown invoice (not in local cache) |
| `invoice:overpayment` | `{ invoiceId, address, coinId, surplus, confirmed }` | Payment exceeds requested amount |
| `invoice:irrelevant` | `{ invoiceId, transfer, reason, confirmed }` | Transfer references invoice but matches no target/asset |
| `invoice:auto_returned` | `{ invoiceId, originalTransfer, returnTransfer }` | Auto-return sent successfully |
| `invoice:auto_return_failed` | `{ invoiceId, transferId, reason, refundAddress?, contactAddresses? }` | Auto-return failed |
| `invoice:return_received` | `{ invoiceId, transfer, returnReason }` | Payer received a return transfer |
| `invoice:over_refund_warning` | `{ invoiceId, senderAddress, coinId, forwardedAmount, returnedAmount }` | Returned amount would exceed forwarded (defense event) |
| `invoice:receipt_sent` | `{ invoiceId, sent, failed }` | Receipt DMs sent |
| `invoice:receipt_received` | `{ invoiceId, receipt }` | Payer received a receipt DM |
| `invoice:cancellation_sent` | `{ invoiceId, sent, failed }` | Cancellation notice DMs sent |
| `invoice:cancellation_received` | `{ invoiceId, notice }` | Payer received a cancellation notice DM |

---

### Invoice Error Codes

| Code | Description |
|------|-------------|
| `INVOICE_NO_TARGETS` | `CreateInvoiceRequest.targets` is empty |
| `INVOICE_TOO_MANY_TARGETS` | More than 100 targets |
| `INVOICE_INVALID_ADDRESS` | Target address is not a valid `DIRECT://` address |
| `INVOICE_NO_ASSETS` | A target has no assets |
| `INVOICE_TOO_MANY_ASSETS` | A target has more than 10 assets |
| `INVOICE_INVALID_ASSET` | Asset has neither `coin` nor `nft`, or has both |
| `INVOICE_INVALID_AMOUNT` | Amount is not a positive integer string (max 78 digits) |
| `INVOICE_INVALID_COIN` | Coin ID is empty or not a string |
| `INVOICE_INVALID_NFT` | NFT entry is malformed |
| `INVOICE_PAST_DUE_DATE` | `dueDate` is not in the future |
| `INVOICE_DUPLICATE_ADDRESS` | Duplicate target addresses in one invoice |
| `INVOICE_DUPLICATE_COIN` | Duplicate coin IDs within a single target |
| `INVOICE_DUPLICATE_NFT` | Duplicate NFT IDs within a single target |
| `INVOICE_MEMO_TOO_LONG` | Memo, reason, or dealDescription exceeds 4096 characters |
| `INVOICE_TERMS_TOO_LARGE` | Serialized `InvoiceTerms` exceeds the storage size limit |
| `INVOICE_INVALID_DELIVERY_METHOD` | Delivery method fails scheme (`https://`/`wss://`) or length validation |
| `INVOICE_INVALID_REFUND_ADDRESS` | refundAddress is not a valid `DIRECT://` address |
| `INVOICE_INVALID_CONTACT` | contact.address or contact.url is malformed |
| `INVOICE_MINT_FAILED` | Aggregator token mint failed after retries |
| `INVOICE_INVALID_PROOF` | Aggregator inclusion proof is invalid |
| `INVOICE_WRONG_TOKEN_TYPE` | Token type does not match the invoice type constant |
| `INVOICE_INVALID_DATA` | `tokenData` is missing, not JSON, or not a valid `InvoiceTerms` object |
| `INVOICE_ALREADY_EXISTS` | Invoice with this token ID already exists locally |
| `INVOICE_NOT_FOUND` | Invoice token not found in local cache |
| `INVOICE_NOT_TARGET` | Calling wallet is not a target of this invoice |
| `INVOICE_ALREADY_CLOSED` | Invoice is already in CLOSED state |
| `INVOICE_ALREADY_CANCELLED` | Invoice is already in CANCELLED state |
| `INVOICE_TERMINATED` | Invoice is in a terminal state (CLOSED or CANCELLED) |
| `INVOICE_NOT_TERMINATED` | Invoice is not yet in a terminal state |
| `INVOICE_NOT_CANCELLED` | Invoice is not in CANCELLED state (sendCancellationNotices only) |
| `INVOICE_ORACLE_REQUIRED` | Oracle provider is required but not configured |
| `INVOICE_INVALID_TARGET` | `targetIndex` is out of range |
| `INVOICE_INVALID_ASSET_INDEX` | `assetIndex` is out of range |
| `INVOICE_RETURN_EXCEEDS_BALANCE` | Return amount exceeds the payer's net balance |
| `INVOICE_INVALID_ID` | Invoice ID is not a valid 64-character hex string |
| `INVOICE_STORAGE_FAILED` | A storage read/write operation failed |

---

## SwapModule (Token Swaps)

Orchestrates two-party atomic token swaps via an escrow service. The module manages the wallet-side state machine, DM-based negotiation with the counterparty, escrow interaction, deposit payment (via AccountingModule invoices), and payout verification.

The module is a **client** of the escrow service -- it does not hold funds or execute payouts. Those responsibilities belong to the escrow.

### Lifecycle

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  accounting: true,   // Required -- swap uses invoices internally
  swap: true,         // Enable with defaults
  // swap: { defaultEscrowAddress: '@escrow-testnet', proposalTimeoutMs: 300000 },
});

const swap = sphere.swap!;
```

### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultEscrowAddress` | `string` | `undefined` | Default escrow `@nametag` or `DIRECT://` address |
| `proposalTimeoutMs` | `number` | `300000` (5 min) | Client-side timeout for proposal acceptance |
| `maxPendingSwaps` | `number` | `100` | Max non-terminal swaps tracked simultaneously |
| `announceTimeoutMs` | `number` | `30000` (30 sec) | Timeout for escrow announce response |
| `terminalPurgeTtlMs` | `number` | `604800000` (7 days) | TTL before completed/cancelled swaps are purged from storage |

### Core Types

#### `SwapDeal`

User-facing description of what is being exchanged. Passed to `proposeSwap()`.

```typescript
interface SwapDeal {
  readonly partyA: string;          // Proposer address: @nametag, DIRECT://, or chain pubkey
  readonly partyB: string;          // Counterparty address
  readonly partyACurrency: string;  // Coin ID party A deposits (e.g., 'UCT')
  readonly partyAAmount: string;    // Amount in smallest units (positive integer string)
  readonly partyBCurrency: string;  // Coin ID party B deposits
  readonly partyBAmount: string;    // Amount in smallest units
  readonly timeout: number;         // Swap timeout in seconds [60, 86400]
  readonly escrowAddress?: string;  // Escrow service address (falls back to config default)
}
```

#### `SwapRef`

The persistent swap record stored locally. Contains all state needed to resume across restarts.

```typescript
interface SwapRef {
  readonly swapId: string;           // 64 hex chars, content-addressed from manifest
  readonly deal: SwapDeal;
  readonly manifest: SwapManifest;   // Wire-format manifest (DIRECT:// addresses)
  readonly role: SwapRole;           // 'proposer' | 'acceptor'
  progress: SwapProgress;            // Current state in the client-side state machine
  depositInvoiceId?: string;         // Set after escrow announcement
  payoutInvoiceId?: string;          // Set after escrow delivers payout
  escrowState?: string;              // Last known escrow state (informational)
  counterpartyPubkey?: string;       // Resolved counterparty chain pubkey
  localDepositTransferId?: string;   // Transfer ID of local deposit
  escrowPubkey?: string;             // Resolved escrow chain pubkey
  payoutVerified: boolean;           // Whether payout was verified
  readonly createdAt: number;        // ms timestamp
  announcedAt?: number;              // ms timestamp when escrow acknowledged
  updatedAt: number;                 // ms timestamp of last state change
  error?: string;                    // Error message if progress is 'failed'
}
```

#### `SwapProgress`

Client-side state machine:

```
proposed -> accepted -> announced -> depositing -> awaiting_counter
  -> concluding -> completed

Terminal states: completed, cancelled, failed
```

| State | Description |
|-------|-------------|
| `proposed` | Proposal sent (proposer) or received (acceptor) |
| `accepted` | Counterparty accepted, announcing to escrow |
| `announced` | Escrow acknowledged, deposit invoice available |
| `depositing` | Local deposit sent, awaiting confirmation |
| `awaiting_counter` | Local deposit confirmed, waiting for counterparty |
| `concluding` | Both deposited, escrow executing payouts |
| `completed` | Swap done, tokens exchanged (terminal) |
| `cancelled` | Swap cancelled (terminal) |
| `failed` | Unrecoverable error (terminal) |

### Methods

#### `proposeSwap(deal: SwapDeal, options?: ProposeSwapOptions): Promise<SwapProposalResult>`

Propose a swap to a counterparty. Resolves addresses, computes the content-addressed swap ID, sends a proposal DM, and creates a local `SwapRef` with `progress='proposed'`.

```typescript
const result = await swap.proposeSwap({
  partyA: sphere.identity!.directAddress!,
  partyB: '@bob',
  partyACurrency: 'UCT',
  partyAAmount: '1000000',
  partyBCurrency: 'USDU',
  partyBAmount: '500000',
  timeout: 3600,
  escrowAddress: '@escrow-testnet',
}, { message: 'Trading 1 UCT for 0.5 USDU' });

console.log(result.swapId);     // 64-char hex
console.log(result.manifest);   // Wire-format manifest
console.log(result.swap);       // SwapRef
```

**Throws:** `SWAP_LIMIT_EXCEEDED`, `INVALID_RECIPIENT`, `TRANSPORT_ERROR`

#### `acceptSwap(swapId: string): Promise<void>`

Accept a swap proposal. Sends an acceptance DM to the proposer, announces the manifest to the escrow, and waits for the escrow's `announce_result`. After successful announcement, the swap transitions to `announced` and a deposit invoice is available.

```typescript
await swap.acceptSwap(swapId);
// swap.progress is now 'announced'
```

**Throws:** `SWAP_NOT_FOUND`, `SWAP_INVALID_STATE` (if not in `proposed` state)

#### `rejectSwap(swapId: string, reason?: string): Promise<void>`

Reject a swap proposal. Sends a rejection DM to the proposer. The swap transitions to `cancelled` locally.

```typescript
await swap.rejectSwap(swapId, 'Price too high');
```

#### `deposit(swapId: string): Promise<TransferResult>`

Deposit into an announced swap. Pays the escrow's deposit invoice with the correct currency and amount for this party's role.

```typescript
const result = await swap.deposit(swapId);
console.log(result.id, result.status);
```

**Throws:** `SWAP_NOT_FOUND`, `SWAP_INVALID_STATE` (if not `announced` or `awaiting_counter`), `INSUFFICIENT_BALANCE`

#### `getSwapStatus(swapId: string, options?: GetSwapStatusOptions): Promise<SwapRef>`

Get the current swap status. By default, queries the escrow for active swaps (not for terminal swaps).

```typescript
const ref = await swap.getSwapStatus(swapId, { queryEscrow: true });
console.log(ref.progress, ref.escrowState);
```

**Options:**
- `queryEscrow?: boolean` -- If true, sends a status DM to the escrow and merges the response.

#### `getSwaps(filter?: GetSwapsFilter): SwapRef[]`

List swaps with optional filtering.

```typescript
// All active swaps
const active = swap.getSwaps({ excludeTerminal: true });

// Only swaps where I am the proposer
const proposed = swap.getSwaps({ role: 'proposer' });

// Specific progress state
const depositing = swap.getSwaps({ progress: 'depositing' });

// Multiple progress states
const pending = swap.getSwaps({ progress: ['proposed', 'accepted', 'announced'] });
```

**Filter options:**
- `progress?: SwapProgress | SwapProgress[]` -- Filter by state(s)
- `role?: SwapRole` -- Filter by `'proposer'` or `'acceptor'`
- `excludeTerminal?: boolean` -- Exclude completed/cancelled/failed swaps

#### `verifyPayout(swapId: string): Promise<boolean>`

Verify that the payout invoice has been correctly fulfilled. Checks that the payout invoice terms match the swap manifest and that the invoice is covered. Returns `true` if verification passes, `false` otherwise.

```typescript
const verified = await swap.verifyPayout(swapId);
console.log('Payout verified:', verified);
```

#### `cancelSwap(swapId: string): Promise<void>`

Cancel a swap locally. The swap transitions to `cancelled`. This does NOT communicate with the escrow -- use this for local cleanup of swaps that are stuck in non-terminal states.

```typescript
await swap.cancelSwap(swapId);
```

**Throws:** `SWAP_NOT_FOUND`, `SWAP_INVALID_STATE` (if already terminal)

### Swap Events

| Event | Payload | When |
|-------|---------|------|
| `swap:proposal_received` | `{ swapId, deal, senderPubkey, senderNametag? }` | Incoming swap proposal DM |
| `swap:proposed` | `{ swapId, deal, recipientPubkey }` | Outgoing proposal sent |
| `swap:accepted` | `{ swapId, role }` | Swap accepted (either side) |
| `swap:rejected` | `{ swapId, reason? }` | Swap rejected (either side) |
| `swap:announced` | `{ swapId, depositInvoiceId }` | Escrow acknowledged, deposit invoice ready |
| `swap:deposit_sent` | `{ swapId, transferResult }` | Local deposit payment sent |
| `swap:deposit_confirmed` | `{ swapId, party, amount, coinId }` | Deposit confirmed by escrow |
| `swap:deposits_covered` | `{ swapId }` | Both deposits fully covered |
| `swap:concluding` | `{ swapId }` | Escrow executing payouts |
| `swap:payout_received` | `{ swapId, payoutInvoiceId }` | Payout invoice token received |
| `swap:completed` | `{ swapId, payoutVerified }` | Swap completed (terminal) |
| `swap:cancelled` | `{ swapId, reason, depositsReturned? }` | Swap cancelled (terminal) |
| `swap:failed` | `{ swapId, error }` | Swap failed (terminal) |
| `swap:deposit_returned` | `{ swapId, transfer, returnReason }` | Deposit returned after cancellation |
| `swap:bounce_received` | `{ swapId, reason, returnedAmount, returnedCurrency }` | Wrong-currency deposit bounced back |

### Escrow Communication

The swap module communicates with the escrow service via encrypted DMs (NIP-17). The escrow sends the following message types:

| Type | When | Key Fields |
|------|------|------------|
| `announce_result` | After manifest announcement | `swap_id`, `state`, `deposit_invoice_id` |
| `invoice_delivery` | Deposit or payout invoice token | `swap_id`, `invoice_type`, `invoice_token` |
| `status_result` | In response to status query | `swap_id`, `state` |
| `payment_confirmation` | After escrow pays payout invoice | `swap_id`, `party` |
| `swap_cancelled` | Swap cancelled (timeout/manual) | `swap_id`, `reason`, `deposits_returned?` |
| `bounce_notification` | Wrong-currency deposit returned | `swap_id`, `reason`, `returned_amount` |
| `error` | Escrow-side error | `error`, `swap_id?` |

---

## Error Handling

### SphereError

All SDK methods throw `SphereError` with a typed `code` field for programmatic error handling:

```typescript
import { SphereError, isSphereError } from '@unicitylabs/sphere-sdk';
import type { SphereErrorCode } from '@unicitylabs/sphere-sdk';

try {
  await sphere.payments.send({ ... });
} catch (err) {
  if (isSphereError(err)) {
    switch (err.code) {
      case 'INSUFFICIENT_BALANCE': showToast('Not enough funds'); break;
      case 'INVALID_RECIPIENT': showToast('Recipient not found'); break;
      case 'TRANSPORT_ERROR': showToast('Network connection issue'); break;
      case 'TIMEOUT': showToast('Request timed out, try again'); break;
      default: showToast(err.message);
    }
  }
}
```

#### Error Codes

| Code | Description |
|------|-------------|
| `NOT_INITIALIZED` | SDK or module not initialized |
| `ALREADY_INITIALIZED` | Wallet already exists |
| `INVALID_CONFIG` | Invalid configuration parameters |
| `INVALID_IDENTITY` | Invalid mnemonic or key |
| `INSUFFICIENT_BALANCE` | Not enough funds for transfer |
| `INVALID_RECIPIENT` | Recipient nametag not found or invalid |
| `TRANSFER_FAILED` | Token transfer/mint/burn failed |
| `STORAGE_ERROR` | Storage read/write failed |
| `TRANSPORT_ERROR` | Relay/network transport error |
| `AGGREGATOR_ERROR` | Oracle/aggregator request failed |
| `VALIDATION_ERROR` | Input validation failed |
| `NETWORK_ERROR` | HTTP/API request failed |
| `TIMEOUT` | Operation timed out |
| `DECRYPTION_ERROR` | Wallet decryption failed |
| `MODULE_NOT_AVAILABLE` | Requested module not registered |

### Logger

Centralized debug logging with per-module control:

```typescript
import { logger } from '@unicitylabs/sphere-sdk';

// Enable all debug logging
logger.configure({ debug: true });

// Per-module control
logger.setTagDebug('Nostr', true);     // Only transport logs
logger.setTagDebug('Payments', true);  // Only payment logs
logger.setTagDebug('GroupChat', true); // Only group chat logs

// Check if debug enabled
logger.isDebugEnabled();        // global
logger.isDebugEnabled('Nostr'); // per-tag

// Custom log handler
logger.configure({
  debug: true,
  handler: (level, tag, message, ...args) => {
    // Send to your logging service
  },
});
```

**Log levels:**
- `debug` — detailed operational info (hidden when `debug=false`)
- `warn` — important warnings like timeouts (always shown)
- `error` — critical failures (always shown)
