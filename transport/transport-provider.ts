/**
 * Transport Provider Interface
 * Platform-independent P2P messaging abstraction
 */

import type { BaseProvider, FullIdentity, ComposingIndicator } from '../types';

// =============================================================================
// Transport Provider Interface
// =============================================================================

/**
 * P2P messaging transport provider
 */
export interface TransportProvider extends BaseProvider {
  /**
   * Set identity for signing/encryption.
   * If the transport is already connected, reconnects with the new identity.
   */
  setIdentity(identity: FullIdentity): void | Promise<void>;

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
   * Resolve any identifier to full peer information.
   * Accepts @nametag, bare nametag, DIRECT://, chain pubkey, or transport pubkey.
   * @param identifier - Any supported identifier format
   * @returns PeerInfo or null if not found
   */
  resolve?(identifier: string): Promise<PeerInfo | null>;

  /**
   * Resolve nametag to public key
   */
  resolveNametag?(nametag: string): Promise<string | null>;

  /**
   * Resolve nametag to full peer information
   * Returns transportPubkey, chainPubkey, directAddress
   */
  resolveNametagInfo?(nametag: string): Promise<PeerInfo | null>;

  /**
   * Resolve a DIRECT:// address to full peer info.
   * Performs reverse lookup: address → binding event → PeerInfo.
   * @param address - L3 address (DIRECT://...)
   * @returns PeerInfo or null if no binding found for this address
   */
  resolveAddressInfo?(address: string): Promise<PeerInfo | null>;

  /**
   * Resolve transport pubkey to full peer info.
   * Queries binding events authored by the given transport pubkey.
   * @param transportPubkey - Transport-specific pubkey (e.g. 64-char hex string)
   * @returns PeerInfo or null if no binding found
   */
  resolveTransportPubkeyInfo?(transportPubkey: string): Promise<PeerInfo | null>;

  /**
   * Batch-resolve multiple transport pubkeys to peer info.
   * Used for HD address discovery: derives transport pubkeys for indices 0..N
   * and queries binding events in a single batch.
   * @param transportPubkeys - Array of transport-specific pubkeys to look up
   * @returns Array of PeerInfo for pubkeys that have binding events (may be shorter than input)
   */
  discoverAddresses?(transportPubkeys: string[]): Promise<PeerInfo[]>;

  /**
   * Recover nametag for current identity by decrypting stored encrypted nametag
   * Used after wallet import to recover associated nametag
   * @returns Decrypted nametag or null if none found
   */
  recoverNametag?(): Promise<string | null>;

  /**
   * Publish identity binding event.
   * Without nametag: publishes base binding (chainPubkey, directAddress).
   * With nametag: adds nametag hash, proxy address, encrypted nametag for recovery.
   * Uses parameterized replaceable event (kind 30078, d=hash(nostrPubkey)).
   * @returns true if successful, false if nametag is taken by another pubkey
   */
  publishIdentityBinding?(
    chainPubkey: string,
    directAddress: string,
    nametag?: string,
  ): Promise<boolean>;

  /**
   * Subscribe to broadcast messages (global/channel)
   */
  subscribeToBroadcast?(tags: string[], handler: BroadcastHandler): () => void;

  /**
   * Publish broadcast message
   */
  publishBroadcast?(content: string, tags?: string[]): Promise<string>;

  // ===========================================================================
  // Read Receipts
  // ===========================================================================

  /**
   * Send a read receipt for a message
   * @param recipientTransportPubkey - Transport pubkey of the message sender
   * @param messageEventId - Event ID of the message being acknowledged
   */
  sendReadReceipt?(recipientTransportPubkey: string, messageEventId: string): Promise<void>;

  /**
   * Subscribe to incoming read receipts
   * @returns Unsubscribe function
   */
  onReadReceipt?(handler: ReadReceiptHandler): () => void;

  // ===========================================================================
  // Typing Indicators
  // ===========================================================================

  /**
   * Send typing indicator to a recipient
   * @param recipientTransportPubkey - Transport pubkey of the conversation partner
   */
  sendTypingIndicator?(recipientTransportPubkey: string): Promise<void>;

  /**
   * Subscribe to incoming typing indicators
   * @returns Unsubscribe function
   */
  onTypingIndicator?(handler: TypingIndicatorHandler): () => void;

  // ===========================================================================
  // Composing Indicators (NIP-59 kind 25050)
  // ===========================================================================

  /**
   * Send composing indicator to a recipient using NIP-44 encrypted gift wrap
   * @param recipientTransportPubkey - Transport pubkey of the conversation partner
   * @param content - JSON payload with senderNametag and expiresIn
   */
  sendComposingIndicator?(recipientTransportPubkey: string, content: string): Promise<void>;

  /**
   * Subscribe to incoming composing indicators
   * @returns Unsubscribe function
   */
  onComposing?(handler: ComposingHandler): () => void;

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

  /**
   * Set fallback 'since' timestamp for event subscriptions.
   * Used when switching to an address that has never subscribed before.
   * The transport uses this instead of 'now' as the initial since filter,
   * ensuring events sent while the address was inactive are not missed.
   * Consumed once by the next subscription setup, then cleared.
   *
   * @param sinceSeconds - Unix timestamp in seconds
   */
  setFallbackSince?(sinceSeconds: number): void;

  /**
   * Set fallback 'since' timestamp for DM (gift-wrap) subscriptions.
   * Used when no persisted DM timestamp exists in storage (e.g. first connect).
   * Consumed once by the next subscription setup, then cleared.
   *
   * @param sinceSeconds - Unix timestamp in seconds
   */
  setFallbackDmSince?(sinceSeconds: number): void;

  /**
   * Fetch pending events from transport (one-shot query).
   * Creates a temporary subscription, processes events through normal handlers,
   * and resolves after EOSE (End Of Stored Events).
   */
  fetchPendingEvents?(): Promise<void>;

  /**
   * Register a handler to be called when the chat subscription receives EOSE
   * (End Of Stored Events), indicating that historical DMs have been delivered.
   * The handler fires at most once per subscription lifecycle.
   *
   * @returns Unsubscribe function
   */
  onChatReady?(handler: () => void): () => void;
}

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
  /** Set when this is a self-wrap replay (sent message recovered from relay) */
  isSelfWrap?: boolean;
  /** Recipient pubkey — only present on self-wrap replays */
  recipientTransportPubkey?: string;
}

export type MessageHandler = (message: IncomingMessage) => void;

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
  | 'message:sent';

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
// Peer Info Types
// =============================================================================

/**
 * Resolved peer identity information.
 * Returned by resolve methods — contains all public address formats for a peer.
 * The nametag field is optional (only present if a nametag is registered).
 */
export interface PeerInfo {
  /** Nametag name (without @), if registered */
  nametag?: string;
  /** Transport-specific pubkey (for messaging/encryption) */
  transportPubkey: string;
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  chainPubkey: string;
  /** L3 DIRECT address (DIRECT://...) */
  directAddress: string;
  /**
   * Network the peer's identity binding DECLARES ('testnet2', …) — absent when
   * the binding carries none, which is every binding published so far. Parsed
   * only, never invented: money refuses a PROVEN foreign network (§5.6).
   *
   * Absent is also the STRUCTURAL answer on the `@nametag` and `DIRECT://`
   * routes of the Nostr transport, whichever binding is out there: those two
   * resolve through nostr-js-sdk's `queryBindingBy*`, whose parser drops every
   * content field outside its whitelist and never hands back the signed event
   * (#734 tracks the upstream fix). Only routes that parse the raw event —
   * `resolveTransportPubkeyInfo`, `discoverAddresses` — can populate it today.
   */
  network?: string;
  /** Event timestamp */
  timestamp: number;
}

/** @deprecated Use PeerInfo instead */
export type NametagInfo = PeerInfo;

// =============================================================================
// Read Receipt Types
// =============================================================================

export interface IncomingReadReceipt {
  /** Transport-specific pubkey of the sender who read the message */
  senderTransportPubkey: string;
  /** Event ID of the message that was read */
  messageEventId: string;
  /** Timestamp */
  timestamp: number;
}

export type ReadReceiptHandler = (receipt: IncomingReadReceipt) => void;

// =============================================================================
// Typing Indicator Types
// =============================================================================

export interface IncomingTypingIndicator {
  /** Transport-specific pubkey of the sender who is typing */
  senderTransportPubkey: string;
  /** Sender's nametag (if known) */
  senderNametag?: string;
  /** Timestamp */
  timestamp: number;
}

export type TypingIndicatorHandler = (indicator: IncomingTypingIndicator) => void;

export type ComposingHandler = (indicator: ComposingIndicator) => void;
