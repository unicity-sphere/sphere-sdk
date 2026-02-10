# SDK2 API Reference

## Sphere

Main entry point for all SDK operations.

### Constructor

```typescript
new Sphere(config?: SphereConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `storagePrefix` | `string` | `'sphere_'` | localStorage key prefix |
| `aggregatorUrl` | `string` | `'https://aggregator.unicity.network'` | Aggregator endpoint |
| `nostrRelays` | `string[]` | `['wss://relay.unicity.network']` | Nostr relay URLs |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `identity` | `FullIdentity` | Current wallet identity (after load) |
| `payments` | `PaymentsModule` | L3 token operations + L1 via `.l1` |
| `payments.l1` | `L1PaymentsModule` | L1 ALPHA operations |
| `communications` | `CommunicationsModule` | Messaging operations |

### Methods

#### `initialize(providers: Providers): Promise<void>`

Initialize SDK with provider implementations.

#### `destroy(): Promise<void>`

Cleanup and disconnect all providers.

#### `on<T>(event: string, handler: (data: T) => void): () => void`

Subscribe to events. Returns unsubscribe function.

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

---

## WalletManager

### Methods

#### `exists(): Promise<boolean>`

Check if encrypted wallet data exists in storage.

#### `create(password: string): Promise<string>`

Create new wallet. Returns mnemonic phrase (24 words).

#### `load(password: string): Promise<void>`

Load and decrypt existing wallet.

#### `import(mnemonic: string, password: string): Promise<void>`

Import wallet from mnemonic phrase.

#### `clear(): Promise<void>`

Delete all wallet data from storage.

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

### Address Modes

| Mode | Description |
|------|-------------|
| `'auto'` (default) | Uses `DirectAddress` if stored in nametag info; falls back to `ProxyAddress` for legacy nametags |
| `'direct'` | Forces `DirectAddress` — fails if recipient has no stored direct address |
| `'proxy'` | Forces `ProxyAddress` via nametag lookup |

---

### Methods: Token Transfers

#### `send(request: TransferRequest): Promise<TransferResult>`

Send tokens to a recipient. Automatically splits tokens when the exact amount is not available as a single token.

```typescript
interface TransferRequest {
  readonly coinId: string;       // Coin type (hex string)
  readonly amount: string;       // Amount in smallest units
  readonly recipient: string;    // @nametag, hex pubkey, DIRECT://, or PROXY://
  readonly memo?: string;        // Optional message
  readonly addressMode?: AddressMode;  // 'auto' | 'direct' | 'proxy'
}

type AddressMode = 'auto' | 'direct' | 'proxy';

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

#### `processInstantSplitBundle(bundle: InstantSplitBundle, senderPubkey: string): Promise<InstantSplitProcessResult>`

Process a received instant split bundle (recipient side).

- **V5 bundles**: Saved immediately as unconfirmed (`status: 'submitted'`), proofs resolved lazily via `resolveUnconfirmed()`.
- **V4 bundles** (dev mode): Processed synchronously — all proofs acquired before returning.

```typescript
interface InstantSplitProcessResult {
  success: boolean;
  token?: any;           // Finalized SDK token (if successful)
  error?: string;
  durationMs: number;
}
```

#### `isInstantSplitBundle(payload: unknown): payload is InstantSplitBundle`

Type-guard to check if a payload is a valid InstantSplitBundle (V4 or V5).

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
  error?: string;
}
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

Sync with all configured token storage providers. Emits `sync:started`, `sync:completed`, `sync:error` events.

#### `validate(): Promise<{ valid: Token[]; invalid: Token[] }>`

Validate all tokens against the aggregator. Invalid/spent tokens are marked `'invalid'`.

#### `load(): Promise<void>`

Load all token data from storage providers. Restores pending V5 tokens and triggers `resolveUnconfirmed()`.

#### `destroy(): void`

Cleanup all subscriptions, polling jobs, and pending resolvers.

#### `getConfig(): PaymentsModuleConfig`

Get module configuration with defaults applied.

```typescript
interface PaymentsModuleConfig {
  autoSync?: boolean;      // Default: true
  autoValidate?: boolean;  // Default: true
  retryFailed?: boolean;   // Default: true
  maxRetries?: number;     // Default: 3
  debug?: boolean;         // Default: false
  l1?: L1PaymentsModuleConfig;
}
```

#### `updateTokenStorageProviders(providers: Map<string, TokenStorageProvider>): void`

Replace token storage providers at runtime.

---

### Payment Requests (Incoming)

#### `sendPaymentRequest(recipient: string, request: PaymentRequest): Promise<PaymentRequestResult>`

Send a payment request to a recipient.

```typescript
interface PaymentRequest {
  amount: string;           // Amount in smallest units
  coinId: string;           // Token type (e.g., 'ALPHA')
  message?: string;         // Optional message
  recipientNametag?: string; // Who should pay
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
  recipientNametag?: string;   // Our nametag (if specified)
  requestId: string;           // Original request ID
  timestamp: number;           // Request timestamp
  status: PaymentRequestStatus;
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

### Configuration

L1 is configured through `Sphere.init()`, `Sphere.create()`, or `Sphere.load()`:

```typescript
const sphere = await Sphere.init({
  storage, transport, oracle,
  l1: {
    electrumUrl: 'wss://fulcrum.alpha.unicity.network:50004',  // default
    defaultFeeRate: 10,    // sat/byte, default
    enableVesting: true,   // classify coins as vested/unvested, default
  },
});

// Access L1 via payments module
const balance = await sphere.payments.l1.getBalance();
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
  amount: string;  // in satoshis
  feeRate?: number;
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

#### `estimateFee(to: string, amount: string): Promise<{ fee: string; feeRate: number }>`

---

## CommunicationsModule

### Methods

#### `sendDM(recipient: string, content: string): Promise<DirectMessage>`

Send a direct message using NIP-17 gift wrapping (kind 1059). The recipient can be a `@nametag` or a hex public key. Content is wrapped in the Sphere messaging format (`{senderNametag, text}`) for compatibility with the Sphere app.

```typescript
interface DirectMessage {
  id: string;
  senderPubkey: string;
  senderNametag?: string;
  recipientPubkey: string;
  content: string;
  timestamp: number;
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

#### `onDirectMessage(handler: (msg: DirectMessage) => void): () => void`

Subscribe to incoming direct messages. Supports both NIP-17 gift-wrapped messages (kind 1059, used by Sphere app) and NIP-04 encrypted DMs (kind 4, legacy). For NIP-17 messages, the sender's nametag is extracted from the Sphere messaging format if present.

#### `onBroadcast(handler: (msg: BroadcastMessage) => void): () => void`

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

### ProviderStatus

```typescript
type ProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
```

### SphereEventType

```typescript
type SphereEventType =
  | 'wallet:created'
  | 'wallet:loaded'
  | 'wallet:cleared'
  | 'transfer:incoming'
  | 'transfer:outgoing'
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
  | 'sync:error'
  | 'connection:changed'
  | 'nametag:registered'
  | 'nametag:recovered'   // New: emitted when nametag is recovered from Nostr
  | 'identity:changed';   // Emitted when switching addresses
```

### SphereEventMap

```typescript
interface SphereEventMap {
  // ... other events ...
  'nametag:registered': { nametag: string; addressIndex: number };
  'nametag:recovered': { nametag: string };
  'identity:changed': {
    l1Address: string;
    directAddress?: string;
    chainPubkey: string;
    nametag?: string;
    addressIndex: number;
  };
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
createIpfsStorageProvider(config?: IpfsStorageProviderConfig): IpfsStorageProvider

// Transport
createNostrTransportProvider(config?: NostrTransportProviderConfig): NostrTransportProvider

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
