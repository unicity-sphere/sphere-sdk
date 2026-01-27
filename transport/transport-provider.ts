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
   * @returns Event ID
   */
  sendMessage(recipientPubkey: string, content: string): Promise<string>;

  /**
   * Subscribe to incoming direct messages
   * @returns Unsubscribe function
   */
  onMessage(handler: MessageHandler): () => void;

  /**
   * Send token transfer payload
   * @returns Event ID
   */
  sendTokenTransfer(recipientPubkey: string, payload: TokenTransferPayload): Promise<string>;

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
   * Register a nametag for this identity
   * @returns true if successful, false if already taken
   */
  registerNametag?(nametag: string, publicKey: string): Promise<boolean>;

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
   * @returns Event ID
   */
  sendPaymentRequest?(recipientPubkey: string, request: PaymentRequestPayload): Promise<string>;

  /**
   * Subscribe to incoming payment requests
   * @returns Unsubscribe function
   */
  onPaymentRequest?(handler: PaymentRequestHandler): () => void;

  /**
   * Send response to a payment request
   * @returns Event ID
   */
  sendPaymentRequestResponse?(
    recipientPubkey: string,
    response: PaymentRequestResponsePayload
  ): Promise<string>;

  /**
   * Subscribe to incoming payment request responses
   * @returns Unsubscribe function
   */
  onPaymentRequestResponse?(handler: PaymentRequestResponseHandler): () => void;
}

// =============================================================================
// Message Types
// =============================================================================

export interface IncomingMessage {
  id: string;
  senderPubkey: string;
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
    pubkey: string;
    nametag?: string;
  };
}

export interface IncomingTokenTransfer {
  id: string;
  senderPubkey: string;
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
  /** Sender's public key */
  senderPubkey: string;
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
  /** Responder's public key */
  responderPubkey: string;
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
  authorPubkey: string;
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
