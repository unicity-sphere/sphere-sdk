/**
 * Transport Provider Interface
 * Platform-independent P2P messaging abstraction
 */

import type { BaseProvider, FullIdentity } from '../types';

// =============================================================================
// Transport Provider Interface
// =============================================================================

/**
 * P2P messaging transport provider
 */
export interface TransportProvider extends BaseProvider {
  /**
   * Set identity for signing/encryption
   */
  setIdentity(identity: FullIdentity): void;

  /**
   * Send encrypted direct message
   * @param recipientTransportPubkey - Transport-specific pubkey for messaging
   * @returns Event ID
   */
  sendMessage(recipientTransportPubkey: string, content: string): Promise<string>;

  /**
   * Subscribe to incoming direct messages
   * @returns Unsubscribe function
   */
  onMessage(handler: MessageHandler): () => void;

  /**
   * Send token transfer payload
   * @param recipientTransportPubkey - Transport-specific pubkey for messaging
   * @returns Event ID
   */
  sendTokenTransfer(recipientTransportPubkey: string, payload: TokenTransferPayload): Promise<string>;

  /**
   * Subscribe to incoming token transfers
   * @returns Unsubscribe function
   */
  onTokenTransfer(handler: TokenTransferHandler): () => void;

  /**
   * Resolve nametag to public key
   */
  resolveNametag?(nametag: string): Promise<string | null>;

  /**
   * Resolve nametag to full address information
   * Returns transportPubkey, chainPubkey, l1Address, directAddress, proxyAddress
   */
  resolveNametagInfo?(nametag: string): Promise<NametagInfo | null>;

  /**
   * Recover nametag for current identity by decrypting stored encrypted nametag
   * Used after wallet import to recover associated nametag
   * @returns Decrypted nametag or null if none found
   */
  recoverNametag?(): Promise<string | null>;

  /**
   * Register a nametag for this identity
   * @param nametag - Nametag to register
   * @param chainPubkey - 33-byte compressed secp256k1 public key (for L1/L3)
   * @param directAddress - L3 DIRECT address (DIRECT://...)
   * @returns true if successful, false if already taken
   */
  registerNametag?(nametag: string, chainPubkey: string, directAddress: string): Promise<boolean>;

  /**
   * Publish nametag binding
   */
  publishNametag?(nametag: string, address: string): Promise<void>;

  /**
   * Subscribe to broadcast messages (global/channel)
   */
  subscribeToBroadcast?(tags: string[], handler: BroadcastHandler): () => void;

  /**
   * Publish broadcast message
   */
  publishBroadcast?(content: string, tags?: string[]): Promise<string>;

  // ===========================================================================
  // Payment Requests
  // ===========================================================================

  /**
   * Send payment request to a recipient
   * @param recipientTransportPubkey - Transport-specific pubkey for messaging
   * @returns Event ID
   */
  sendPaymentRequest?(recipientTransportPubkey: string, request: PaymentRequestPayload): Promise<string>;

  /**
   * Subscribe to incoming payment requests
   * @returns Unsubscribe function
   */
  onPaymentRequest?(handler: PaymentRequestHandler): () => void;

  /**
   * Send response to a payment request
   * @param recipientTransportPubkey - Transport-specific pubkey for messaging
   * @returns Event ID
   */
  sendPaymentRequestResponse?(
    recipientTransportPubkey: string,
    response: PaymentRequestResponsePayload
  ): Promise<string>;

  /**
   * Subscribe to incoming payment request responses
   * @returns Unsubscribe function
   */
  onPaymentRequestResponse?(handler: PaymentRequestResponseHandler): () => void;

  // ===========================================================================
  // Dynamic Relay Management (optional)
  // ===========================================================================

  /**
   * Get list of configured relay URLs
   */
  getRelays?(): string[];

  /**
   * Get list of currently connected relay URLs
   */
  getConnectedRelays?(): string[];

  /**
   * Add a relay dynamically
   * @returns true if added successfully
   */
  addRelay?(relayUrl: string): Promise<boolean>;

  /**
   * Remove a relay dynamically
   * @returns true if removed successfully
   */
  removeRelay?(relayUrl: string): Promise<boolean>;

  /**
   * Check if a relay is configured
   */
  hasRelay?(relayUrl: string): boolean;

  /**
   * Check if a relay is currently connected
   */
  isRelayConnected?(relayUrl: string): boolean;

  // ===========================================================================
  // Instant Split Support (optional)
  // ===========================================================================

  /**
   * Send an instant split bundle to a recipient.
   * This is a specialized method for INSTANT_SPLIT V5 bundles.
   *
   * @param recipientTransportPubkey - Transport-specific pubkey for messaging
   * @param bundle - The InstantSplitBundleV5 to send
   * @returns Event ID
   */
  sendInstantSplitBundle?(
    recipientTransportPubkey: string,
    bundle: InstantSplitBundlePayload
  ): Promise<string>;

  /**
   * Subscribe to incoming instant split bundles.
   *
   * @param handler - Handler for received bundles
   * @returns Unsubscribe function
   */
  onInstantSplitReceived?(handler: InstantSplitBundleHandler): () => void;
}

// =============================================================================
// Instant Split Types
// =============================================================================

/**
 * Payload for sending instant split bundles
 */
export interface InstantSplitBundlePayload {
  /** The bundle JSON string (InstantSplitBundleV5 serialized) */
  bundle: string;
  /** Optional memo */
  memo?: string;
  /** Sender info */
  sender?: {
    transportPubkey: string;
    nametag?: string;
  };
}

/**
 * Incoming instant split bundle
 */
export interface IncomingInstantSplitBundle {
  /** Event ID */
  id: string;
  /** Transport-specific pubkey of sender */
  senderTransportPubkey: string;
  /** The bundle JSON string */
  bundle: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Handler for instant split bundles
 */
export type InstantSplitBundleHandler = (bundle: IncomingInstantSplitBundle) => void;

// =============================================================================
// Message Types
// =============================================================================

export interface IncomingMessage {
  id: string;
  /** Transport-specific pubkey of sender */
  senderTransportPubkey: string;
  /** Sender's nametag (if known from NIP-17 unwrap) */
  senderNametag?: string;
  content: string;
  timestamp: number;
  encrypted: boolean;
}

export type MessageHandler = (message: IncomingMessage) => void;

// =============================================================================
// Token Transfer Types
// =============================================================================

export interface TokenTransferPayload {
  /** Serialized token data */
  token: string;
  /** Inclusion proof */
  proof: unknown;
  /** Optional memo */
  memo?: string;
  /** Sender info */
  sender?: {
    /** Transport-specific pubkey */
    transportPubkey: string;
    nametag?: string;
  };
}

export interface IncomingTokenTransfer {
  id: string;
  /** Transport-specific pubkey of sender */
  senderTransportPubkey: string;
  payload: TokenTransferPayload;
  timestamp: number;
}

export type TokenTransferHandler = (transfer: IncomingTokenTransfer) => void;

// =============================================================================
// Payment Request Types
// =============================================================================

export interface PaymentRequestPayload {
  /** Amount requested (in smallest units) */
  amount: string | bigint;
  /** Coin/token type ID */
  coinId: string;
  /** Message/memo for recipient */
  message?: string;
  /** Recipient's nametag (who should pay) */
  recipientNametag?: string;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface IncomingPaymentRequest {
  /** Event ID */
  id: string;
  /** Transport-specific pubkey of sender */
  senderTransportPubkey: string;
  /** Parsed request data */
  request: {
    requestId: string;
    amount: string;
    coinId: string;
    message?: string;
    recipientNametag?: string;
    metadata?: Record<string, unknown>;
  };
  /** Timestamp */
  timestamp: number;
}

export type PaymentRequestHandler = (request: IncomingPaymentRequest) => void;

// =============================================================================
// Payment Request Response Types
// =============================================================================

export type PaymentRequestResponseType = 'accepted' | 'rejected' | 'paid';

export interface PaymentRequestResponsePayload {
  /** Original request ID */
  requestId: string;
  /** Response type */
  responseType: PaymentRequestResponseType;
  /** Optional message */
  message?: string;
  /** Transfer ID (if paid) */
  transferId?: string;
}

export interface IncomingPaymentRequestResponse {
  /** Event ID */
  id: string;
  /** Transport-specific pubkey of responder */
  responderTransportPubkey: string;
  /** Parsed response data */
  response: {
    requestId: string;
    responseType: PaymentRequestResponseType;
    message?: string;
    transferId?: string;
  };
  /** Timestamp */
  timestamp: number;
}

export type PaymentRequestResponseHandler = (response: IncomingPaymentRequestResponse) => void;

// =============================================================================
// Broadcast Types
// =============================================================================

export interface IncomingBroadcast {
  id: string;
  /** Transport-specific pubkey of author */
  authorTransportPubkey: string;
  content: string;
  tags: string[];
  timestamp: number;
}

export type BroadcastHandler = (broadcast: IncomingBroadcast) => void;

// =============================================================================
// Transport Events
// =============================================================================

export type TransportEventType =
  | 'transport:connected'
  | 'transport:disconnected'
  | 'transport:reconnecting'
  | 'transport:error'
  | 'transport:relay_added'
  | 'transport:relay_removed'
  | 'message:received'
  | 'message:sent'
  | 'transfer:received'
  | 'transfer:sent';

export interface TransportEvent {
  type: TransportEventType;
  timestamp: number;
  data?: unknown;
  error?: string;
}

export type TransportEventCallback = (event: TransportEvent) => void;

// =============================================================================
// Provider Factory Type
// =============================================================================

export type TransportProviderFactory<TConfig, TProvider extends TransportProvider> = (
  config?: TConfig
) => TProvider;

// =============================================================================
// Nametag Info Types
// =============================================================================

/**
 * Full nametag address information
 * Used for resolving nametag to all address formats
 */
export interface NametagInfo {
  /** Nametag name (without @) */
  nametag: string;
  /** Transport-specific pubkey (for messaging/encryption) */
  transportPubkey: string;
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  chainPubkey: string;
  /** L1 address (alpha1...) */
  l1Address: string;
  /** L3 DIRECT address (DIRECT://...) */
  directAddress: string;
  /** L3 PROXY address derived from nametag hash (PROXY:...) */
  proxyAddress: string;
  /** Event timestamp */
  timestamp: number;
}
