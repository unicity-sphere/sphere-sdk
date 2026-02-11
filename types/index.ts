/**
 * SDK2 Core Types
 * Platform-independent type definitions
 */

// =============================================================================
// Provider Base Types
// =============================================================================

export type ProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ProviderMetadata {
  readonly id: string;
  readonly name: string;
  readonly type: 'local' | 'cloud' | 'p2p' | 'network';
  readonly description?: string;
}

export interface BaseProvider extends ProviderMetadata {
  connect(config?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;
}

// =============================================================================
// Identity Types
// =============================================================================

export interface Identity {
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  readonly chainPubkey: string;
  /** L1 address (alpha1...) */
  readonly l1Address: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress?: string;
  readonly ipnsName?: string;
  readonly nametag?: string;
}

export interface FullIdentity extends Identity {
  readonly privateKey: string;
}

export interface IdentityConfig {
  mnemonic?: string;
  privateKey?: string;
  derivationPath?: string;
}

// =============================================================================
// Token Types
// =============================================================================

export type TokenStatus =
  | 'pending'      // Initial creation
  | 'submitted'    // Commitment sent, waiting for proof (NOSTR-FIRST)
  | 'confirmed'    // Has inclusion proof
  | 'transferring' // Being transferred
  | 'spent'        // Transferred away
  | 'invalid';     // Validation failed

export interface Token {
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
  readonly sdkData?: string;
}

export interface Asset {
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly iconUrl?: string;
  readonly totalAmount: string;
  readonly tokenCount: number;
  /** Sum of confirmed token amounts (smallest units) */
  readonly confirmedAmount: string;
  /** Sum of unconfirmed (submitted/pending) token amounts (smallest units) */
  readonly unconfirmedAmount: string;
  /** Number of confirmed tokens aggregated */
  readonly confirmedTokenCount: number;
  /** Number of unconfirmed tokens aggregated */
  readonly unconfirmedTokenCount: number;
  /** Price per whole unit in USD (null if PriceProvider not configured) */
  readonly priceUsd: number | null;
  /** Price per whole unit in EUR (null if PriceProvider not configured) */
  readonly priceEur: number | null;
  /** 24h price change percentage (null if unavailable) */
  readonly change24h: number | null;
  /** Total fiat value in USD: (totalAmount / 10^decimals) * priceUsd */
  readonly fiatValueUsd: number | null;
  /** Total fiat value in EUR */
  readonly fiatValueEur: number | null;
}

// =============================================================================
// Transfer Types
// =============================================================================

export type TransferStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'delivered'
  | 'completed'
  | 'failed';

export type AddressMode = 'auto' | 'direct' | 'proxy';

export type TransferMode = 'instant' | 'conservative';

export interface TransferRequest {
  readonly coinId: string;
  readonly amount: string;
  readonly recipient: string;
  readonly memo?: string;
  /** Address mode: 'auto' (default) uses directAddress if available, 'direct' forces DIRECT, 'proxy' forces PROXY */
  readonly addressMode?: AddressMode;
  /** Transfer mode: 'instant' (default) sends via Nostr immediately, 'conservative' collects all proofs first */
  readonly transferMode?: TransferMode;
}

/**
 * Per-token transfer detail tracking the on-chain commitment or split operation
 * for each source token involved in a transfer.
 */
export interface TokenTransferDetail {
  /** Source token ID that was consumed in this transfer */
  readonly sourceTokenId: string;
  /** Transfer method used for this token */
  readonly method: 'direct' | 'split';
  /** Aggregator commitment request ID hex (for direct transfers) */
  readonly requestIdHex?: string;
  /** Split group ID (for split transfers — correlates sender/recipient/change tokens) */
  readonly splitGroupId?: string;
  /** Nostr event ID (for split transfers delivered via Nostr) */
  readonly nostrEventId?: string;
}

export interface TransferResult {
  readonly id: string;
  status: TransferStatus;
  readonly tokens: Token[];
  /** Per-token transfer details — one entry per source token consumed */
  readonly tokenTransfers: TokenTransferDetail[];
  error?: string;
}

export interface IncomingTransfer {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly tokens: Token[];
  readonly memo?: string;
  readonly receivedAt: number;
}

// =============================================================================
// Payment Request Types
// =============================================================================

export type PaymentRequestStatus = 'pending' | 'accepted' | 'rejected' | 'paid' | 'expired';

/**
 * Outgoing payment request (requesting payment from someone)
 */
export interface PaymentRequest {
  /** Unique request ID */
  readonly id: string;
  /** Amount requested (in smallest units) */
  readonly amount: string;
  /** Coin/token type */
  readonly coinId: string;
  /** Optional message/memo */
  readonly message?: string;
  /** Where tokens should be sent */
  readonly recipientNametag?: string;
  /** Custom metadata */
  readonly metadata?: Record<string, unknown>;
  /** Expiration timestamp (ms) */
  readonly expiresAt?: number;
  /** Created timestamp */
  readonly createdAt: number;
}

/**
 * Incoming payment request (someone requesting payment from us)
 */
export interface IncomingPaymentRequest {
  /** Event ID from Nostr */
  readonly id: string;
  /** Sender's public key */
  readonly senderPubkey: string;
  /** Sender's nametag (if known) */
  readonly senderNametag?: string;
  /** Amount requested */
  readonly amount: string;
  /** Coin/token type */
  readonly coinId: string;
  /** Symbol for display */
  readonly symbol: string;
  /** Message from sender */
  readonly message?: string;
  /** Requester's nametag (where tokens should be sent) */
  readonly recipientNametag?: string;
  /** Original request ID from sender */
  readonly requestId: string;
  /** Timestamp */
  readonly timestamp: number;
  /** Current status */
  status: PaymentRequestStatus;
  /** Custom metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result of sending a payment request
 */
export interface PaymentRequestResult {
  readonly success: boolean;
  readonly requestId?: string;
  readonly eventId?: string;
  readonly error?: string;
}

/**
 * Handler for incoming payment requests
 */
export type PaymentRequestHandler = (request: IncomingPaymentRequest) => void;

/**
 * Response type for payment requests
 */
export type PaymentRequestResponseType = 'accepted' | 'rejected' | 'paid';

/**
 * Outgoing payment request (we sent to someone)
 */
export interface OutgoingPaymentRequest {
  /** Unique request ID */
  readonly id: string;
  /** Nostr event ID */
  readonly eventId: string;
  /** Recipient's public key */
  readonly recipientPubkey: string;
  /** Recipient's nametag (if known) */
  readonly recipientNametag?: string;
  /** Amount requested */
  readonly amount: string;
  /** Coin/token type */
  readonly coinId: string;
  /** Message sent with request */
  readonly message?: string;
  /** Created timestamp */
  readonly createdAt: number;
  /** Current status */
  status: PaymentRequestStatus;
  /** Response data (if received) */
  response?: PaymentRequestResponse;
}

/**
 * Response to a payment request
 */
export interface PaymentRequestResponse {
  /** Response event ID */
  readonly id: string;
  /** Responder's public key */
  readonly responderPubkey: string;
  /** Responder's nametag (if known) */
  readonly responderNametag?: string;
  /** Original request ID */
  readonly requestId: string;
  /** Response type */
  readonly responseType: PaymentRequestResponseType;
  /** Optional message */
  readonly message?: string;
  /** Transfer ID (if paid) */
  readonly transferId?: string;
  /** Timestamp */
  readonly timestamp: number;
}

/**
 * Handler for payment request responses
 */
export type PaymentRequestResponseHandler = (response: PaymentRequestResponse) => void;

// =============================================================================
// Message Types
// =============================================================================

export interface DirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}

export interface BroadcastMessage {
  readonly id: string;
  readonly authorPubkey: string;
  readonly authorNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  readonly tags?: string[];
}

// =============================================================================
// Tracked Addresses
// =============================================================================

/**
 * Minimal data stored in persistent storage for a tracked address.
 * Only contains user state — derived fields are computed on load.
 */
export interface TrackedAddressEntry {
  /** HD derivation index (0, 1, 2, ...) */
  readonly index: number;
  /** Whether this address is hidden from UI display */
  hidden: boolean;
  /** Timestamp (ms) when this address was first activated */
  readonly createdAt: number;
  /** Timestamp (ms) of last modification */
  updatedAt: number;
}

/**
 * Full tracked address with derived fields and nametag (available in memory).
 * Returned by Sphere.getActiveAddresses() / getAllTrackedAddresses().
 */
export interface TrackedAddress extends TrackedAddressEntry {
  /** Short address identifier (e.g., "DIRECT_abc123_xyz789") */
  readonly addressId: string;
  /** L1 bech32 address (alpha1...) */
  readonly l1Address: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress: string;
  /** 33-byte compressed secp256k1 public key */
  readonly chainPubkey: string;
  /** Primary nametag (from nametag cache, without @ prefix) */
  readonly nametag?: string;
}

// =============================================================================
// Event Types
// =============================================================================

export type SphereEventType =
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

export interface SphereEventMap {
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
  'identity:changed': { l1Address: string; directAddress?: string; chainPubkey: string; nametag?: string; addressIndex: number };
  'address:activated': { address: TrackedAddress };
  'address:hidden': { index: number; addressId: string };
  'address:unhidden': { index: number; addressId: string };
}

export type SphereEventHandler<T extends SphereEventType> = (
  data: SphereEventMap[T]
) => void;

// =============================================================================
// Configuration Types
// =============================================================================

export interface SphereConfig {
  identity: IdentityConfig;
  storage?: StorageProviderConfig;
  transport?: TransportProviderConfig;
  aggregator?: AggregatorProviderConfig;
  logging?: LoggingConfig;
}

export interface StorageProviderConfig {
  type: 'local' | 'ipfs' | 'hybrid';
  prefix?: string;
  // IPFS specific
  gateways?: string[];
  bootstrapPeers?: string[];
  enableIpns?: boolean;
}

export interface TransportProviderConfig {
  type: 'nostr';
  relays?: string[];
  timeout?: number;
  autoReconnect?: boolean;
}

/**
 * Aggregator (oracle) provider configuration
 * The aggregator provides verifiable truth about token state through inclusion proofs
 */
export interface AggregatorProviderConfig {
  /** Aggregator/oracle URL endpoint */
  url: string;
  /** Request timeout in ms */
  timeout?: number;
  /** Skip proof verification (for testing only) */
  skipVerification?: boolean;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logger?: (level: string, message: string, data?: unknown) => void;
}

// =============================================================================
// Error Types
// =============================================================================

export type SphereErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'INVALID_CONFIG'
  | 'INVALID_IDENTITY'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_RECIPIENT'
  | 'TRANSFER_FAILED'
  | 'STORAGE_ERROR'
  | 'TRANSPORT_ERROR'
  | 'AGGREGATOR_ERROR'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT';

export class SphereError extends Error {
  readonly code: SphereErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: SphereErrorCode, cause?: unknown) {
    super(message);
    this.name = 'SphereError';
    this.code = code;
    this.cause = cause;
  }
}

// =============================================================================
// Wallet Management Types
// =============================================================================

/**
 * Derivation mode determines how child keys are derived:
 * - "bip32": Standard BIP32 with chain code (IL + parentKey) mod n
 * - "legacy_hmac": Legacy Sphere HMAC derivation with chain code
 * - "wif_hmac": Simple HMAC derivation without chain code (webwallet compatibility)
 */
export type DerivationMode = 'bip32' | 'legacy_hmac' | 'wif_hmac';

/**
 * Source of wallet creation
 */
export type WalletSource = 'mnemonic' | 'file' | 'unknown';

/**
 * Wallet information for backup/export purposes
 */
export interface WalletInfo {
  readonly source: WalletSource;
  readonly hasMnemonic: boolean;
  readonly hasChainCode: boolean;
  readonly derivationMode: DerivationMode;
  readonly basePath: string;
  readonly address0: string | null;
}

/**
 * JSON export format for wallet backup (v1.0)
 */
export interface WalletJSON {
  readonly version: '1.0';
  readonly type: 'sphere-wallet';
  readonly createdAt: string;
  readonly wallet: {
    readonly masterPrivateKey?: string;
    readonly chainCode?: string;
    readonly addresses: ReadonlyArray<{
      readonly address: string;
      readonly publicKey: string;
      readonly path: string;
      readonly index: number;
    }>;
    readonly isBIP32: boolean;
    readonly descriptorPath?: string;
  };
  readonly mnemonic?: string;
  readonly encrypted?: boolean;
  readonly source?: WalletSource;
  readonly derivationMode?: DerivationMode;
}

/**
 * Options for exporting wallet to JSON
 */
export interface WalletJSONExportOptions {
  /** Include mnemonic in export (default: true if available) */
  includeMnemonic?: boolean;
  /** Encrypt sensitive data with password */
  password?: string;
  /** Number of addresses to include (default: 1) */
  addressCount?: number;
}

// =============================================================================
// Address Derivation Types (re-exported from crypto)
// =============================================================================

export type { AddressInfo } from '../core/crypto';

// Re-export TXF types
export * from './txf';

// Re-export instant split types
export * from './instant-split';

// Re-export payment session types
export * from './payment-session';
