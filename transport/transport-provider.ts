/**
 * Transport Provider Interface
 * Platform-independent P2P messaging abstraction
 */

import type { BaseProvider, FullIdentity, ComposingIndicator } from '../types';
import type { UxfTransferPayload } from '../types/uxf-transfer';

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
   * @param options - Optional behaviors (see {@link SendMessageOptions})
   * @returns Event ID of the gift-wrap to the recipient (NOT the self-wrap)
   */
  sendMessage(
    recipientTransportPubkey: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<string>;

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
   * Resolve any identifier to full peer information.
   * Accepts @nametag, bare nametag, DIRECT://, PROXY://, L1 address, chain pubkey, or transport pubkey.
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
   * Returns transportPubkey, chainPubkey, l1Address, directAddress, proxyAddress
   */
  resolveNametagInfo?(nametag: string): Promise<PeerInfo | null>;

  /**
   * Resolve a DIRECT://, PROXY://, or L1 address to full peer info.
   * Performs reverse lookup: address → binding event → PeerInfo.
   * @param address - L3 address (DIRECT://... or PROXY://...) or L1 address (alpha1...)
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
   * Without nametag: publishes base binding (chainPubkey, l1Address, directAddress).
   * With nametag: adds nametag hash, proxy address, encrypted nametag for recovery.
   * Uses parameterized replaceable event (kind 30078, d=hash(nostrPubkey)).
   * @returns true if successful, false if nametag is taken by another pubkey
   */
  publishIdentityBinding?(
    chainPubkey: string,
    l1Address: string,
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
   * Issue #166 P2 #3 — Re-query the underlying transport (e.g. Nostr
   * relay set) to verify that a previously published event identified
   * by `eventId` is still persisted / available for delivery.
   *
   * Used by the {@link NostrPersistenceVerifier} worker to detect
   * relay retention drops AFTER the immediate post-publish
   * verification window has passed (the `publishWithVerification` path
   * in NostrTransportProvider catches losses within the first second;
   * this method catches longer-term eviction or relay-segregation
   * failures minutes to hours later).
   *
   * Return semantics:
   *  - `'retained'` — the event is present on at least one queried
   *    relay. Worker marks the SENT entry as verified and skips it on
   *    subsequent cycles.
   *  - `'missing'`  — the event is NOT present on any queried relay
   *    despite a successful past publish. Worker emits
   *    `transfer:retention-warning`. The bundle is still
   *    content-addressed via `bundleCid` so the recipient's replay-LRU
   *    deduplicates on re-publish, but THIS PR does not attempt
   *    re-publication — that is gated to a follow-up wave because the
   *    safety surface (preserved bundle data, recipient pubkey, key
   *    rotation interaction) is too large to ship as a backfill.
   *  - `'unverifiable'` — the query itself failed (relay timeout,
   *    connection lost, malformed response). Worker leaves the entry
   *    untouched and retries next cycle. NOT treated as missing
   *    because a transient query failure must not produce false
   *    `retention-warning` events.
   *
   * Implementations SHOULD make this method best-effort and never
   * throw — convert exceptions to `'unverifiable'` internally.
   *
   * @param eventId  The relay-assigned event id returned by
   *                 {@link sendTokenTransfer}.
   * @returns        See above.
   */
  verifyTokenTransferRetained?(
    eventId: string,
  ): Promise<'retained' | 'missing' | 'unverifiable'>;

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
  /** Set when this is a self-wrap replay (sent message recovered from relay) */
  isSelfWrap?: boolean;
  /** Recipient pubkey — only present on self-wrap replays */
  recipientTransportPubkey?: string;
}

export type MessageHandler = (message: IncomingMessage) => void;

/**
 * Per-call options for {@link TransportProvider.sendMessage}.
 *
 * Default behavior — when `options` is omitted or `selfWrap` is unset — is
 * unchanged from before these options existed (gift-wrap + self-wrap both
 * publish).
 */
export interface SendMessageOptions {
  /**
   * When `true` (default), publish a second NIP-17 gift-wrap addressed to the
   * sender's own pubkey so a returning client can replay outbound history on
   * reconnect.
   *
   * When `false`, skip the self-wrap publish. Use for short-lived senders
   * (e.g. one-shot CLI RPC like `sphere trader portfolio`) that exit before
   * they could ever read their own self-wrap — see sphere-sdk#555.
   */
  selfWrap?: boolean;
}

// =============================================================================
// Token Transfer Types
// =============================================================================

/**
 * Wire payload for the Nostr `TOKEN_TRANSFER` event (kind 31113).
 *
 * Shape-agnostic at the transport layer — this is a tagged union of:
 *
 *  - {@link UxfTransferPayloadCar} (`kind: 'uxf-car'`) — inline CAR via base64
 *  - {@link UxfTransferPayloadCid} (`kind: 'uxf-cid'`) — CID-by-reference
 *  - {@link LegacyTokenTransferPayload} — one of four pre-UXF shapes
 *    (Sphere TXF `{sourceToken, transferTx}`, V6 `COMBINED_TRANSFER`,
 *    V5/V4 `INSTANT_SPLIT`, SDK `{token, proof}`).
 *
 * The transport layer SERIALIZES whichever shape it is handed (UXF via
 * the canonical encoder from {@link "../uxf/transfer-payload"}, legacy via
 * pass-through `JSON.stringify`), and DELIVERS whichever shape arrives over
 * the wire to {@link TokenTransferHandler}. Shape discrimination is the
 * receiver/handler's responsibility — see `PaymentsModule` (T.7.A).
 *
 * Re-exported from `types/uxf-transfer` (T.1.A) so all transport callers
 * share one source of truth for the union.
 *
 * @see UxfTransferPayload
 * @see LegacyTokenTransferPayload
 */
export type TokenTransferPayload = UxfTransferPayload;

export interface IncomingTokenTransfer {
  id: string;
  /** Transport-specific pubkey of sender */
  senderTransportPubkey: string;
  payload: TokenTransferPayload;
  timestamp: number;
}

/**
 * Token-transfer handler return contract (at-least-once invariant):
 *  - `true` (or `void`/`undefined` — legacy backward-compat): the inbound
 *    event has been durably processed (token persisted to all configured
 *    TokenStorageProviders, including IPFS pin for the Profile provider).
 *    The transport MAY advance `lastEventTs` past this event.
 *  - `false`: the event was received but the handler could not durably
 *    persist its tokens (flush failure, IPFS unreachable, monotonicity
 *    violation, etc.). The transport MUST NOT advance `lastEventTs` so
 *    the event is re-replayed on the next reconnect. Re-processing is
 *    idempotent (addToken stateHash dedup; processedCombinedTransferIds
 *    dedup; etc.).
 *
 * Returning `void`/`undefined` preserves the pre-invariant contract for
 * external handlers — they default to "durable" so existing code does
 * not regress to "never ack".
 */
export type TokenTransferHandler = (
  transfer: IncomingTokenTransfer,
) => void | boolean | Promise<void | boolean>;

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
  /** Sender's nametag (if included in encrypted content) */
  senderNametag?: string;
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
// Peer Info Types
// =============================================================================

/**
 * Resolved peer identity information.
 * Returned by resolve methods — contains all public address formats for a peer.
 * Fields nametag and proxyAddress are optional (only present if nametag is registered).
 */
export interface PeerInfo {
  /** Nametag name (without @), if registered */
  nametag?: string;
  /** Transport-specific pubkey (for messaging/encryption) */
  transportPubkey: string;
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  chainPubkey: string;
  /** L1 address (alpha1...) */
  l1Address: string;
  /** L3 DIRECT address (DIRECT://...) */
  directAddress: string;
  /** L3 PROXY address derived from nametag hash (PROXY:...), only if nametag registered */
  proxyAddress?: string;
  /** Event timestamp */
  timestamp: number;

  // ───────────────────────────────────────────────────────────────────────
  // T.8.B — Capability hints (informational, per UXF §10.4).
  //
  // Fields are OPTIONAL on the type but a publishing peer SHOULD set both
  // when its identity binding event is constructed; absence at the wire
  // level encodes "older peer with unknown capability". Receivers MUST
  // NOT auto-coerce or auto-strip based on these hints — they are
  // ADVISORY ONLY. The actual interop guarantee comes from the receiver's
  // T.2.B `UNKNOWN_ASSET_KIND` reject rule and the bundle wire-format
  // negotiation in §3.3.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Wire protocols the peer advertises support for. Canonical v1.0 set is
   * `['uxf-car', 'uxf-cid', 'txf']`. Empty/absent means "unknown".
   */
  wireProtocols?: ReadonlyArray<string>;
  /**
   * Asset kinds the peer advertises support for. Canonical v1.0 set is
   * `['coin', 'nft']`. Per §10.4 / W20: ABSENT ⇒ assume `['coin']`
   * (forward-compatibility default for older peers that pre-date NFTs).
   */
  assetKinds?: ReadonlyArray<string>;
}

// =============================================================================
// T.8.B — Canonical capability values (UXF §10.4)
// =============================================================================

/**
 * Wire protocols supported by this SDK build. Published in identity binding
 * events so peers can detect mismatches before sending.
 */
export const SUPPORTED_WIRE_PROTOCOLS: ReadonlyArray<string> = [
  'uxf-car',
  'uxf-cid',
  'txf',
];

/**
 * Asset kinds supported by this SDK build. Published in identity binding
 * events so peers can detect mismatches before sending.
 */
export const SUPPORTED_ASSET_KINDS: ReadonlyArray<string> = ['coin', 'nft'];

/**
 * W20 forward-compat default: when an identity binding event is silent
 * about `assetKinds`, treat the peer as a v1.0 coin-only wallet.
 */
export const DEFAULT_ASSET_KINDS_WHEN_ABSENT: ReadonlyArray<string> = ['coin'];

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
