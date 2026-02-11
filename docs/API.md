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
  nametag: 'alice',          // Optional: register @alice on create
  l1: { electrumUrl: '...' }, // Optional L1 config (enabled by default)
  price: priceProvider,      // Optional PriceProvider
  derivationPath: "m/44'/0'/0'", // Optional custom path
});
```

#### `Sphere.exists(storage: StorageProvider): Promise<boolean>`

Check if encrypted wallet data exists in storage.

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

### Methods

#### `getBalance(): Promise<number | null>`

Returns total portfolio value in USD. Requires `PriceProvider` to be configured.

```typescript
const totalUsd = await sphere.payments.getBalance();
// 1523.45 — total value of all confirmed tokens in USD
// null    — if PriceProvider is not configured or no prices available
```

#### `getAssets(coinId?: string): Promise<Asset[]>`

Returns aggregated assets (tokens grouped by coinId) with price data. Only includes confirmed tokens.

```typescript
interface Asset {
  readonly coinId: string;       // Token coin ID
  readonly symbol: string;       // e.g., 'UCT'
  readonly name: string;         // e.g., 'Unicity'
  readonly decimals: number;     // e.g., 18
  readonly iconUrl?: string;     // Token icon URL
  readonly totalAmount: string;  // Sum of all token amounts (smallest units)
  readonly tokenCount: number;   // Number of tokens aggregated
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

```typescript
interface TransferRequest {
  recipient: string;  // @nametag, DIRECT://..., PROXY://..., alpha1... address, chain pubkey
  amount: string;
  coinId: string;
  memo?: string;
}

interface TransferResult {
  readonly id: string;
  status: TransferStatus;  // 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed'
  readonly tokens: Token[];
  txHash?: string;
  error?: string;
}
```

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
