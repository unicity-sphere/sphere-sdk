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
| `wallet` | `WalletManager` | Wallet operations |
| `payments` | `PaymentsModule` | L3 token operations |
| `l1` | `L1PaymentsModule` | L1 ALPHA operations |
| `comms` | `CommunicationsModule` | Messaging operations |

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

### Methods

#### `getBalance(): Promise<Balance>`

```typescript
interface Balance {
  total: string;      // Total balance in smallest units
  available: string;  // Spendable balance
  pending: string;    // Unconfirmed balance
}
```

#### `getTokens(): Promise<Token[]>`

```typescript
interface Token {
  id: string;
  symbol: string;
  amount: string;
  coinId: string;
  status: 'confirmed' | 'pending' | 'spent';
  sdkData: string;  // Serialized SDK token
}
```

#### `send(request: TransferRequest): Promise<TransferResult>`

```typescript
interface TransferRequest {
  recipient: string;  // Nametag (@name) or public key
  amount: string;
  coinId: string;
  memo?: string;
}

interface TransferResult {
  success: boolean;
  transferId?: string;
  error?: string;
}
```

#### `refresh(): Promise<void>`

Refresh token list from storage and network.

#### `validateTransfer(request: TransferRequest): Promise<ValidationResult>`

```typescript
interface ValidationResult {
  valid: boolean;
  errors: string[];
}
```

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
  coinId: 'ALPHA',
  message: 'Lottery ticket #42',
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
  coinId: 'ALPHA',
  message: 'Lottery ticket',
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

#### `onBroadcast(handler: (msg: BroadcastMessage) => void): () => void`

---

## Types

### FullIdentity

```typescript
interface FullIdentity {
  address: string;           // L1 address
  publicKey: string;         // secp256k1 public key (hex)
  privateKey: string;        // secp256k1 private key (hex)
  nostrPublicKey: string;    // Nostr npub
  nostrPrivateKey: string;   // Nostr nsec
  nametag?: string;          // Registered @name
  ipnsName?: string;         // IPNS identifier
}
```

### AddressInfo

```typescript
interface AddressInfo {
  privateKey: string;  // secp256k1 private key (hex)
  publicKey: string;   // Compressed public key (hex)
  address: string;     // L1 address (alpha1...)
  path: string;        // Full BIP32 path
  index: number;       // Address index
}
```

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
  | 'nametag:registered';
```

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
