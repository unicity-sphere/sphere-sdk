/**
 * Nostr Transport Provider
 * Platform-independent implementation using Nostr protocol for P2P messaging
 *
 * Uses @unicitylabs/nostr-js-sdk for:
 * - Real secp256k1 event signing
 * - NIP-04 encryption/decryption
 * - Event ID calculation
 * - NostrClient for reliable connection management (ping, reconnect, NIP-42)
 *
 * WebSocket is injected via factory for cross-platform support
 */

import { Buffer } from 'buffer';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as sha256Noble } from '@noble/hashes/sha2.js';
import {
  NostrKeyManager,
  NIP04,
  NIP17,
  Event as NostrEventClass,
  EventKinds,
  hashNametag,
  NostrClient,
  Filter,
} from '@unicitylabs/nostr-js-sdk';
import { getPublicKey, publicKeyToAddress } from '../core/crypto';
import type { ProviderStatus, FullIdentity } from '../types';
import type {
  TransportProvider,
  MessageHandler,
  TokenTransferHandler,
  BroadcastHandler,
  PaymentRequestHandler,
  PaymentRequestResponseHandler,
  IncomingMessage,
  IncomingTokenTransfer,
  IncomingBroadcast,
  IncomingPaymentRequest,
  IncomingPaymentRequestResponse,
  TokenTransferPayload,
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  TransportEvent,
  TransportEventCallback,
  PeerInfo,
} from './transport-provider';
import type { WebSocketFactory, UUIDGenerator } from './websocket';
import { defaultUUIDGenerator } from './websocket';
import {
  DEFAULT_NOSTR_RELAYS,
  NOSTR_EVENT_KINDS,
  TIMEOUTS,
} from '../constants';

// =============================================================================
// Configuration
// =============================================================================

export interface NostrTransportProviderConfig {
  /** Nostr relay URLs */
  relays?: string[];
  /** Connection timeout (ms) */
  timeout?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay (ms) */
  reconnectDelay?: number;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** WebSocket factory (required for platform support) */
  createWebSocket: WebSocketFactory;
  /** UUID generator (optional, defaults to crypto.randomUUID) */
  generateUUID?: UUIDGenerator;
}

// Alias for backward compatibility
const EVENT_KINDS = NOSTR_EVENT_KINDS;

// =============================================================================
// Address Hashing Utility
// =============================================================================

/**
 * Hash an address (DIRECT:// or PROXY://) for use as indexed 't' tag value.
 * Enables reverse lookup: address → binding event → transport pubkey.
 * @param address - Address string (e.g., DIRECT://... or PROXY://...)
 * @returns Hex-encoded SHA-256 hash
 */
function hashAddressForTag(address: string): string {
  const bytes = new TextEncoder().encode('unicity:address:' + address);
  return Buffer.from(sha256Noble(bytes)).toString('hex');
}

// =============================================================================
// Nametag Encryption Utilities
// =============================================================================

/**
 * Derive encryption key from private key using HKDF
 * @param privateKeyHex - 32-byte private key as hex
 * @returns 32-byte derived key as Uint8Array
 */
function deriveNametagEncryptionKey(privateKeyHex: string): Uint8Array {
  const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
  // Use HKDF with SHA-256, salt derived from constant, info = "nametag-encryption"
  const saltInput = new TextEncoder().encode('sphere-nametag-salt');
  const salt = sha256Noble(saltInput);
  const info = new TextEncoder().encode('nametag-encryption');
  return hkdf(sha256Noble, privateKeyBytes, salt, info, 32);
}

/**
 * Encrypt nametag with AES-GCM using derived key
 * @param nametag - Plain text nametag
 * @param privateKeyHex - Private key for key derivation
 * @returns Base64 encoded encrypted data (iv + ciphertext + tag)
 */
async function encryptNametag(nametag: string, privateKeyHex: string): Promise<string> {
  const key = deriveNametagEncryptionKey(privateKeyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
  const encoder = new TextEncoder();
  const data = encoder.encode(nametag);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key).buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer },
    cryptoKey,
    new Uint8Array(data).buffer as ArrayBuffer
  );

  // Combine IV + ciphertext (includes auth tag)
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt nametag with AES-GCM using derived key
 * @param encryptedBase64 - Base64 encoded encrypted data (iv + ciphertext + tag)
 * @param privateKeyHex - Private key for key derivation
 * @returns Decrypted nametag or null if decryption fails
 */
async function decryptNametag(encryptedBase64: string, privateKeyHex: string): Promise<string | null> {
  try {
    const key = deriveNametagEncryptionKey(privateKeyHex);
    const combined = Buffer.from(encryptedBase64, 'base64');

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(key).buffer as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv).buffer as ArrayBuffer },
      cryptoKey,
      new Uint8Array(ciphertext).buffer as ArrayBuffer
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch {
    return null;
  }
}

// =============================================================================
// Implementation
// =============================================================================

export class NostrTransportProvider implements TransportProvider {
  readonly id = 'nostr';
  readonly name = 'Nostr Transport';
  readonly type = 'p2p' as const;
  readonly description = 'P2P messaging via Nostr protocol';

  private config: Required<Omit<NostrTransportProviderConfig, 'createWebSocket' | 'generateUUID'>> & {
    createWebSocket: WebSocketFactory;
    generateUUID: UUIDGenerator;
  };
  private identity: FullIdentity | null = null;
  private keyManager: NostrKeyManager | null = null;
  private status: ProviderStatus = 'disconnected';

  // NostrClient from nostr-js-sdk handles all WebSocket management,
  // keepalive pings, reconnection, and NIP-42 authentication
  private nostrClient: NostrClient | null = null;
  private mainSubscriptionId: string | null = null;

  // Event handlers
  private messageHandlers: Set<MessageHandler> = new Set();
  private pendingMessages: IncomingMessage[] = [];  // buffer for messages arriving before handlers register
  private transferHandlers: Set<TokenTransferHandler> = new Set();
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private broadcastHandlers: Map<string, Set<BroadcastHandler>> = new Map();
  private eventCallbacks: Set<TransportEventCallback> = new Set();

  constructor(config: NostrTransportProviderConfig) {
    this.config = {
      relays: config.relays ?? [...DEFAULT_NOSTR_RELAYS],
      timeout: config.timeout ?? TIMEOUTS.WEBSOCKET_CONNECT,
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? TIMEOUTS.NOSTR_RECONNECT_DELAY,
      maxReconnectAttempts: config.maxReconnectAttempts ?? TIMEOUTS.MAX_RECONNECT_ATTEMPTS,
      debug: config.debug ?? false,
      createWebSocket: config.createWebSocket,
      generateUUID: config.generateUUID ?? defaultUUIDGenerator,
    };
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    try {
      // Ensure keyManager exists for NostrClient
      if (!this.keyManager) {
        // Create a temporary key manager - will be replaced when setIdentity is called
        const tempKey = Buffer.alloc(32);
        crypto.getRandomValues(tempKey);
        this.keyManager = NostrKeyManager.fromPrivateKey(tempKey);
      }

      // Create NostrClient with robust connection handling:
      // - autoReconnect: automatic reconnection with exponential backoff
      // - pingIntervalMs: keepalive pings to detect stale connections
      // - NIP-42 AUTH handling built-in
      this.nostrClient = new NostrClient(this.keyManager, {
        autoReconnect: this.config.autoReconnect,
        reconnectIntervalMs: this.config.reconnectDelay,
        maxReconnectIntervalMs: this.config.reconnectDelay * 16, // exponential backoff cap
        pingIntervalMs: 15000, // 15 second keepalive pings (more aggressive to prevent drops)
      });

      // Add connection event listener for logging
      this.nostrClient.addConnectionListener({
        onConnect: (url) => {
          this.log('NostrClient connected to relay:', url);
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
        },
        onDisconnect: (url, reason) => {
          this.log('NostrClient disconnected from relay:', url, 'reason:', reason);
        },
        onReconnecting: (url, attempt) => {
          this.log('NostrClient reconnecting to relay:', url, 'attempt:', attempt);
          this.emitEvent({ type: 'transport:reconnecting', timestamp: Date.now() });
        },
        onReconnected: (url) => {
          this.log('NostrClient reconnected to relay:', url);
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
        },
      });

      // Connect to all relays
      await this.nostrClient.connect(...this.config.relays);

      // Need at least one successful connection
      if (!this.nostrClient.isConnected()) {
        throw new Error('Failed to connect to any relay');
      }

      this.status = 'connected';
      this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
      this.log('Connected to', this.nostrClient.getConnectedRelays().size, 'relays');

      // Set up subscriptions
      if (this.identity) {
        this.subscribeToEvents();
      }
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.nostrClient) {
      this.nostrClient.disconnect();
      this.nostrClient = null;
    }
    this.mainSubscriptionId = null;
    this.walletSubscriptionId = null;
    this.chatSubscriptionId = null;
    this.status = 'disconnected';
    this.emitEvent({ type: 'transport:disconnected', timestamp: Date.now() });
    this.log('Disconnected from all relays');
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.nostrClient?.isConnected() === true;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // Dynamic Relay Management
  // ===========================================================================

  /**
   * Get list of configured relay URLs
   */
  getRelays(): string[] {
    return [...this.config.relays];
  }

  /**
   * Get list of currently connected relay URLs
   */
  getConnectedRelays(): string[] {
    if (!this.nostrClient) return [];
    return Array.from(this.nostrClient.getConnectedRelays());
  }

  /**
   * Add a new relay dynamically
   * Will connect immediately if provider is already connected
   */
  async addRelay(relayUrl: string): Promise<boolean> {
    // Check if already configured
    if (this.config.relays.includes(relayUrl)) {
      this.log('Relay already configured:', relayUrl);
      return false;
    }

    // Add to config
    this.config.relays.push(relayUrl);

    // Connect if provider is connected
    if (this.status === 'connected' && this.nostrClient) {
      try {
        await this.nostrClient.connect(relayUrl);
        this.log('Added and connected to relay:', relayUrl);
        this.emitEvent({
          type: 'transport:relay_added',
          timestamp: Date.now(),
          data: { relay: relayUrl, connected: true },
        });
        return true;
      } catch (error) {
        this.log('Failed to connect to new relay:', relayUrl, error);
        this.emitEvent({
          type: 'transport:relay_added',
          timestamp: Date.now(),
          data: { relay: relayUrl, connected: false, error: String(error) },
        });
        return false;
      }
    }

    this.emitEvent({
      type: 'transport:relay_added',
      timestamp: Date.now(),
      data: { relay: relayUrl, connected: false },
    });
    return true;
  }

  /**
   * Remove a relay dynamically
   * Will disconnect from the relay if connected
   * NOTE: NostrClient doesn't support removing individual relays at runtime.
   * We remove from config so it won't be used on next connect().
   */
  async removeRelay(relayUrl: string): Promise<boolean> {
    const index = this.config.relays.indexOf(relayUrl);
    if (index === -1) {
      this.log('Relay not found:', relayUrl);
      return false;
    }

    // Remove from config
    this.config.relays.splice(index, 1);
    this.log('Removed relay from config:', relayUrl);

    this.emitEvent({
      type: 'transport:relay_removed',
      timestamp: Date.now(),
      data: { relay: relayUrl },
    });

    // Check if we still have connections
    if (this.nostrClient && !this.nostrClient.isConnected() && this.status === 'connected') {
      this.status = 'error';
      this.emitEvent({
        type: 'transport:error',
        timestamp: Date.now(),
        data: { error: 'No connected relays remaining' },
      });
    }

    return true;
  }

  /**
   * Check if a relay is configured
   */
  hasRelay(relayUrl: string): boolean {
    return this.config.relays.includes(relayUrl);
  }

  /**
   * Check if a relay is currently connected
   */
  isRelayConnected(relayUrl: string): boolean {
    if (!this.nostrClient) return false;
    return this.nostrClient.getConnectedRelays().has(relayUrl);
  }

  // ===========================================================================
  // TransportProvider Implementation
  // ===========================================================================

  async setIdentity(identity: FullIdentity): Promise<void> {
    this.identity = identity;

    // Create NostrKeyManager from private key
    const secretKey = Buffer.from(identity.privateKey, 'hex');
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    // Use Nostr-format pubkey (32 bytes / 64 hex chars) from keyManager
    const nostrPubkey = this.keyManager.getPublicKeyHex();
    this.log('Identity set, Nostr pubkey:', nostrPubkey.slice(0, 16) + '...');

    // If we already have a NostrClient with a temp key, we need to reconnect with the real key
    // NostrClient doesn't support changing key at runtime
    if (this.nostrClient && this.status === 'connected') {
      this.log('Identity changed while connected - recreating NostrClient');
      const oldClient = this.nostrClient;

      // Create new client with real identity
      this.nostrClient = new NostrClient(this.keyManager, {
        autoReconnect: this.config.autoReconnect,
        reconnectIntervalMs: this.config.reconnectDelay,
        maxReconnectIntervalMs: this.config.reconnectDelay * 16,
        pingIntervalMs: 15000, // 15 second keepalive pings
      });

      // Add connection event listener
      this.nostrClient.addConnectionListener({
        onConnect: (url) => {
          this.log('NostrClient connected to relay:', url);
        },
        onDisconnect: (url, reason) => {
          this.log('NostrClient disconnected from relay:', url, 'reason:', reason);
        },
        onReconnecting: (url, attempt) => {
          this.log('NostrClient reconnecting to relay:', url, 'attempt:', attempt);
        },
        onReconnected: (url) => {
          this.log('NostrClient reconnected to relay:', url);
        },
      });

      // Connect with new identity, set up subscriptions, then disconnect old client
      await this.nostrClient.connect(...this.config.relays);
      this.subscribeToEvents();
      oldClient.disconnect();
    } else if (this.isConnected()) {
      // Already connected with right key, just subscribe
      this.subscribeToEvents();
    }
  }

  /**
   * Get the Nostr-format public key (32 bytes / 64 hex chars)
   * This is the x-coordinate only, without the 02/03 prefix.
   */
  getNostrPubkey(): string {
    if (!this.keyManager) {
      throw new Error('KeyManager not initialized - call setIdentity first');
    }
    return this.keyManager.getPublicKeyHex();
  }

  async sendMessage(recipientPubkey: string, content: string): Promise<string> {
    this.ensureReady();

    // NIP-17 requires 32-byte x-only pubkey; strip 02/03 prefix if present
    const nostrRecipient = recipientPubkey.length === 66 && (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    // Wrap content with sender nametag for Sphere app compatibility
    const senderNametag = this.identity?.nametag;
    const wrappedContent = senderNametag
      ? JSON.stringify({ senderNametag, text: content })
      : content;

    // Create NIP-17 gift-wrapped message (kind 1059)
    const giftWrap = NIP17.createGiftWrap(this.keyManager!, nostrRecipient, wrappedContent);

    await this.publishEvent(giftWrap);

    this.emitEvent({
      type: 'message:sent',
      timestamp: Date.now(),
      data: { recipient: recipientPubkey },
    });

    return giftWrap.id;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);

    // Flush any messages that arrived before this handler was registered
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      this.log('Flushing', pending.length, 'buffered messages to new handler');
      for (const message of pending) {
        try {
          handler(message);
        } catch (error) {
          this.log('Message handler error (buffered):', error);
        }
      }
    }

    return () => this.messageHandlers.delete(handler);
  }

  async sendTokenTransfer(
    recipientPubkey: string,
    payload: TokenTransferPayload
  ): Promise<string> {
    this.ensureReady();

    // Create encrypted token transfer event
    // Content must have "token_transfer:" prefix for nostr-js-sdk compatibility
    const content = 'token_transfer:' + JSON.stringify(payload);
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [
        ['p', recipientPubkey],
        ['d', 'token-transfer'],
        ['type', 'token_transfer'],
      ]
    );

    await this.publishEvent(event);

    this.emitEvent({
      type: 'transfer:sent',
      timestamp: Date.now(),
      data: { recipient: recipientPubkey },
    });

    return event.id;
  }

  onTokenTransfer(handler: TokenTransferHandler): () => void {
    this.transferHandlers.add(handler);
    return () => this.transferHandlers.delete(handler);
  }

  async sendPaymentRequest(
    recipientPubkey: string,
    payload: PaymentRequestPayload
  ): Promise<string> {
    this.ensureReady();

    const requestId = this.config.generateUUID();
    const amount = typeof payload.amount === 'bigint' ? payload.amount.toString() : payload.amount;

    // Build request content matching nostr-js-sdk format
    const requestContent = {
      requestId,
      amount,
      coinId: payload.coinId,
      message: payload.message,
      recipientNametag: payload.recipientNametag,
      deadline: Date.now() + 5 * 60 * 1000, // 5 minutes default
    };

    // Content must have "payment_request:" prefix for nostr-js-sdk compatibility
    const content = 'payment_request:' + JSON.stringify(requestContent);

    // Build tags matching nostr-js-sdk format
    const tags: string[][] = [
      ['p', recipientPubkey],
      ['type', 'payment_request'],
      ['amount', amount],
    ];
    if (payload.recipientNametag) {
      tags.push(['recipient', payload.recipientNametag]);
    }

    const event = await this.createEncryptedEvent(
      EVENT_KINDS.PAYMENT_REQUEST,
      content,
      tags
    );

    await this.publishEvent(event);

    this.log('Sent payment request:', event.id);

    return event.id;
  }

  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    this.paymentRequestHandlers.add(handler);
    return () => this.paymentRequestHandlers.delete(handler);
  }

  async sendPaymentRequestResponse(
    recipientPubkey: string,
    payload: PaymentRequestResponsePayload
  ): Promise<string> {
    this.ensureReady();

    // Build response content
    const responseContent = {
      requestId: payload.requestId,
      responseType: payload.responseType,
      message: payload.message,
      transferId: payload.transferId,
    };

    // Create encrypted payment request response event
    // Content must have "payment_response:" prefix for nostr-js-sdk compatibility
    const content = 'payment_response:' + JSON.stringify(responseContent);
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      content,
      [
        ['p', recipientPubkey],
        ['e', payload.requestId], // Reference to original request
        ['d', 'payment-request-response'],
        ['type', 'payment_response'],
      ]
    );

    await this.publishEvent(event);

    this.log('Sent payment request response:', event.id, 'type:', payload.responseType);

    return event.id;
  }

  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    this.paymentRequestResponseHandlers.add(handler);
    return () => this.paymentRequestResponseHandlers.delete(handler);
  }

  /**
   * Resolve any identifier to full peer information.
   * Routes to the appropriate specific resolve method based on identifier format.
   */
  async resolve(identifier: string): Promise<PeerInfo | null> {
    // @nametag
    if (identifier.startsWith('@')) {
      return this.resolveNametagInfo(identifier.slice(1));
    }

    // DIRECT:// or PROXY:// address
    if (identifier.startsWith('DIRECT:') || identifier.startsWith('PROXY:')) {
      return this.resolveAddressInfo(identifier);
    }

    // L1 address (alpha1... or alphat1...)
    if (identifier.startsWith('alpha1') || identifier.startsWith('alphat1')) {
      return this.resolveAddressInfo(identifier);
    }

    // 66-char hex starting with 02/03 → compressed chain pubkey (33 bytes)
    if (/^0[23][0-9a-f]{64}$/i.test(identifier)) {
      return this.resolveAddressInfo(identifier);
    }

    // 64-char hex string → transport pubkey
    if (/^[0-9a-f]{64}$/i.test(identifier)) {
      return this.resolveTransportPubkeyInfo(identifier);
    }

    // Fallback: treat as bare nametag
    return this.resolveNametagInfo(identifier);
  }

  async resolveNametag(nametag: string): Promise<string | null> {
    this.ensureConnected();

    // Query for nametag binding events using hashed nametag (privacy-preserving)
    // Try both '#d' and '#t' filters for compatibility with nostr-js-sdk
    const hashedNametag = hashNametag(nametag);

    // First try '#t' tag (nostr-js-sdk format)
    let events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      '#t': [hashedNametag],
      limit: 1,
    });

    // Fallback to '#d' tag (legacy format)
    if (events.length === 0) {
      events = await this.queryEvents({
        kinds: [EVENT_KINDS.NAMETAG_BINDING],
        '#d': [hashedNametag],
        limit: 1,
      });
    }

    if (events.length === 0) return null;

    // Parse binding event
    const bindingEvent = events[0];

    // For Nostr messaging (NIP-04 encryption), we MUST use the event author's pubkey.
    // The 'address' tag contains the Unicity blockchain address (not a hex pubkey),
    // which cannot be used for Nostr encryption.
    // The event.pubkey is always the hex pubkey of the nametag owner.
    if (bindingEvent.pubkey) {
      return bindingEvent.pubkey;
    }

    // Fallback: try 'p' tag (our SDK format uses hex pubkey here)
    const pubkeyTag = bindingEvent.tags.find((t: string[]) => t[0] === 'p');
    if (pubkeyTag?.[1]) return pubkeyTag[1];

    return null;
  }

  async resolveNametagInfo(nametag: string): Promise<PeerInfo | null> {
    this.ensureConnected();

    // Query for nametag binding events using hashed nametag (privacy-preserving)
    const hashedNametag = hashNametag(nametag);

    // First try '#t' tag (nostr-js-sdk format)
    let events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      '#t': [hashedNametag],
      limit: 1,
    });

    // Fallback to '#d' tag (legacy format)
    if (events.length === 0) {
      events = await this.queryEvents({
        kinds: [EVENT_KINDS.NAMETAG_BINDING],
        '#d': [hashedNametag],
        limit: 1,
      });
    }

    if (events.length === 0) return null;

    const bindingEvent = events[0];

    try {
      const content = JSON.parse(bindingEvent.content);

      // Compute proper PROXY address using state-transition-sdk
      const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
      const proxyAddr = await ProxyAddress.fromNameTag(nametag);
      const proxyAddress = proxyAddr.toString();

      // Check if event has extended fields
      if (content.public_key && content.l1_address) {
        return {
          nametag,
          transportPubkey: bindingEvent.pubkey,
          chainPubkey: content.public_key,
          l1Address: content.l1_address,
          directAddress: content.direct_address || '',
          proxyAddress,
          timestamp: bindingEvent.created_at * 1000,
        };
      }

      // Legacy event - only has Nostr pubkey
      // Cannot derive l1_address or l3_address without 33-byte pubkey
      this.log('Legacy nametag event without extended fields:', nametag);

      // Try to get info from tags as fallback
      const pubkeyTag = bindingEvent.tags.find((t: string[]) => t[0] === 'pubkey');
      const l1Tag = bindingEvent.tags.find((t: string[]) => t[0] === 'l1');

      if (pubkeyTag?.[1] && l1Tag?.[1]) {
        return {
          nametag,
          transportPubkey: bindingEvent.pubkey,
          chainPubkey: pubkeyTag[1],
          l1Address: l1Tag[1],
          directAddress: '',
          proxyAddress,
          timestamp: bindingEvent.created_at * 1000,
        };
      }

      // Return partial info with empty addresses for legacy events
      return {
        nametag,
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: '', // Cannot derive from 32-byte Nostr pubkey
        l1Address: '', // Cannot derive without 33-byte pubkey
        directAddress: '',
        proxyAddress,
        timestamp: bindingEvent.created_at * 1000,
      };
    } catch {
      // If content is not JSON, try legacy format
      const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
      const proxyAddr = await ProxyAddress.fromNameTag(nametag);
      return {
        nametag,
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: '',
        l1Address: '',
        directAddress: '',
        proxyAddress: proxyAddr.toString(),
        timestamp: bindingEvent.created_at * 1000,
      };
    }
  }

  /**
   * Resolve a DIRECT://, PROXY://, or L1 address to full peer info.
   * Performs reverse lookup: hash(address) → query '#t' tag → parse binding event.
   * Works with both new identity binding events and legacy nametag binding events.
   */
  async resolveAddressInfo(address: string): Promise<PeerInfo | null> {
    this.ensureConnected();

    const addressHash = hashAddressForTag(address);

    const events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      '#t': [addressHash],
      limit: 1,
    });

    if (events.length === 0) return null;

    const bindingEvent = events[0];

    try {
      const content = JSON.parse(bindingEvent.content);

      return {
        nametag: content.nametag || undefined,
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: content.public_key || '',
        l1Address: content.l1_address || '',
        directAddress: content.direct_address || '',
        proxyAddress: content.proxy_address || undefined,
        timestamp: bindingEvent.created_at * 1000,
      };
    } catch {
      return {
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: '',
        l1Address: '',
        directAddress: '',
        timestamp: bindingEvent.created_at * 1000,
      };
    }
  }

  /**
   * Resolve transport pubkey (Nostr pubkey) to full peer info.
   * Queries binding events authored by the given pubkey.
   */
  async resolveTransportPubkeyInfo(transportPubkey: string): Promise<PeerInfo | null> {
    this.ensureConnected();

    const events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      authors: [transportPubkey],
      limit: 5,
    });

    if (events.length === 0) return null;

    // Sort by timestamp descending and take the most recent
    events.sort((a, b) => b.created_at - a.created_at);
    const bindingEvent = events[0];

    try {
      const content = JSON.parse(bindingEvent.content);

      return {
        nametag: content.nametag || undefined,
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: content.public_key || '',
        l1Address: content.l1_address || '',
        directAddress: content.direct_address || '',
        proxyAddress: content.proxy_address || undefined,
        timestamp: bindingEvent.created_at * 1000,
      };
    } catch {
      return {
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: '',
        l1Address: '',
        directAddress: '',
        timestamp: bindingEvent.created_at * 1000,
      };
    }
  }

  /**
   * Recover nametag for the current identity by searching for encrypted nametag events
   * Used after wallet import to recover associated nametag
   * @returns Decrypted nametag or null if none found
   */
  async recoverNametag(): Promise<string | null> {
    this.ensureReady();

    if (!this.identity || !this.keyManager) {
      throw new Error('Identity not set');
    }

    const nostrPubkey = this.getNostrPubkey();
    this.log('Searching for nametag events for pubkey:', nostrPubkey.slice(0, 16) + '...');

    // Query for nametag binding events authored by this pubkey
    const events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      authors: [nostrPubkey],
      limit: 10, // Get recent events in case of updates
    });

    if (events.length === 0) {
      this.log('No nametag events found for this pubkey');
      return null;
    }

    // Sort by timestamp descending to get most recent
    events.sort((a, b) => b.created_at - a.created_at);

    // Try to decrypt nametag from events
    for (const event of events) {
      try {
        const content = JSON.parse(event.content);
        if (content.encrypted_nametag) {
          const decrypted = await decryptNametag(
            content.encrypted_nametag,
            this.identity.privateKey
          );
          if (decrypted) {
            this.log('Recovered nametag:', decrypted);
            return decrypted;
          }
        }
      } catch {
        // Try next event
        continue;
      }
    }

    this.log('Could not decrypt nametag from any event');
    return null;
  }

  /**
   * Publish identity binding event on Nostr.
   * Without nametag: publishes base binding (chainPubkey, l1Address, directAddress).
   * With nametag: also publishes nametag hash, proxy address, encrypted nametag for recovery.
   *
   * Uses kind 30078 parameterized replaceable event with d=SHA256('unicity:identity:' + nostrPubkey).
   * Each HD address index has its own Nostr key → its own binding event.
   *
   * @returns true if successful, false if nametag is taken by another pubkey
   */
  async publishIdentityBinding(
    chainPubkey: string,
    l1Address: string,
    directAddress: string,
    nametag?: string,
  ): Promise<boolean> {
    this.ensureReady();

    if (!this.identity) {
      throw new Error('Identity not set');
    }

    const nostrPubkey = this.getNostrPubkey();

    // Deterministic d-tag: SHA256('unicity:identity:' + nostrPubkey) — privacy-preserving
    const dTagBytes = new TextEncoder().encode('unicity:identity:' + nostrPubkey);
    const dTag = Buffer.from(sha256Noble(dTagBytes)).toString('hex');

    // Content — event.pubkey already identifies the author, event.created_at provides timestamp
    const contentObj: Record<string, unknown> = {
      public_key: chainPubkey,
      l1_address: l1Address,
      direct_address: directAddress,
    };

    // Tags — 'd' for replacement, 't' for indexed lookups
    const tags: string[][] = [
      ['d', dTag],
      ['t', hashAddressForTag(chainPubkey)],
      ['t', hashAddressForTag(directAddress)],
      ['t', hashAddressForTag(l1Address)],
    ];

    // If nametag provided, check availability and add nametag-specific fields
    if (nametag) {
      const existing = await this.resolveNametag(nametag);
      if (existing && existing !== nostrPubkey) {
        this.log('Nametag already taken:', nametag, '- owner:', existing);
        return false;
      }

      // Compute proxy address
      const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
      const proxyAddr = await ProxyAddress.fromNameTag(nametag);
      const proxyAddress = proxyAddr.toString();

      // Encrypt nametag for recovery
      const encryptedNametag = await encryptNametag(nametag, this.identity.privateKey);
      const hashedNametag = hashNametag(nametag);

      // Add nametag fields to content
      contentObj.nametag = nametag;
      contentObj.encrypted_nametag = encryptedNametag;
      contentObj.proxy_address = proxyAddress;

      // Add nametag-specific 't' tags for indexed lookup
      tags.push(['t', hashedNametag]);
      tags.push(['t', hashAddressForTag(proxyAddress)]);
    }

    const content = JSON.stringify(contentObj);
    const event = await this.createEvent(EVENT_KINDS.NAMETAG_BINDING, content, tags);
    await this.publishEvent(event);

    if (nametag) {
      this.log('Published identity binding with nametag:', nametag, 'for pubkey:', nostrPubkey.slice(0, 16) + '...');
    } else {
      this.log('Published identity binding (no nametag) for pubkey:', nostrPubkey.slice(0, 16) + '...');
    }

    return true;
  }

  /** @deprecated Use publishIdentityBinding instead */
  async publishNametag(nametag: string, address: string): Promise<void> {
    this.ensureReady();

    // Use hashed nametag (privacy-preserving)
    const hashedNametag = hashNametag(nametag);
    const event = await this.createEvent(EVENT_KINDS.NAMETAG_BINDING, address, [
      ['d', hashedNametag],
      ['a', address],
    ]);

    await this.publishEvent(event);
    this.log('Published nametag binding:', nametag);
  }

  async registerNametag(nametag: string, _publicKey: string, directAddress: string = ''): Promise<boolean> {
    this.ensureReady();

    if (!this.identity) {
      throw new Error('Identity not set');
    }

    // Always use 32-byte Nostr-format pubkey from keyManager (not the 33-byte compressed key)
    const nostrPubkey = this.getNostrPubkey();

    // Check if nametag is already taken by someone else
    const existing = await this.resolveNametag(nametag);

    this.log('registerNametag:', nametag, 'existing:', existing, 'myPubkey:', nostrPubkey);

    if (existing && existing !== nostrPubkey) {
      this.log('Nametag already taken:', nametag, '- owner:', existing);
      return false;
    }

    // Always (re)publish to ensure event has correct format with all required tags
    // This is a parameterized replaceable event (kind 30078), so publishing with same 'd' tag
    // will replace any old event. This ensures the event has ['t', hash] tag for nostr-js-sdk.

    // Derive extended address info for full nametag support:
    // - encrypted_nametag: AES-GCM encrypted nametag for recovery
    // - public_key: 33-byte compressed public key for L3 operations
    // - l1_address: L1 address (alpha1...) for L1 transfers
    const privateKeyHex = this.identity.privateKey;
    const compressedPubkey = getPublicKey(privateKeyHex, true); // 33-byte compressed
    const l1Address = publicKeyToAddress(compressedPubkey, 'alpha'); // alpha1...
    const encryptedNametag = await encryptNametag(nametag, privateKeyHex);

    // Compute PROXY address for reverse lookup
    const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
    const proxyAddr = await ProxyAddress.fromNameTag(nametag);
    const proxyAddress = proxyAddr.toString();

    // Publish nametag binding with extended info
    const hashedNametag = hashNametag(nametag);
    const content = JSON.stringify({
      nametag_hash: hashedNametag,
      address: nostrPubkey,
      verified: Date.now(),
      // Extended fields for nametag recovery and address lookup
      encrypted_nametag: encryptedNametag,
      public_key: compressedPubkey,
      l1_address: l1Address,
      direct_address: directAddress,
      proxy_address: proxyAddress,
    });

    // Build tags with indexed 't' tags for reverse lookup by nametag and address
    const tags: string[][] = [
      ['d', hashedNametag],
      ['nametag', hashedNametag],
      ['t', hashedNametag],
      ['t', hashAddressForTag(directAddress)],
      ['t', hashAddressForTag(proxyAddress)],
      ['address', nostrPubkey],
      ['pubkey', compressedPubkey],
      ['l1', l1Address],
    ];

    const event = await this.createEvent(EVENT_KINDS.NAMETAG_BINDING, content, tags);

    await this.publishEvent(event);
    this.log('Registered nametag:', nametag, 'for pubkey:', nostrPubkey.slice(0, 16) + '...', 'l1:', l1Address.slice(0, 12) + '...');
    return true;
  }

  // Track broadcast subscriptions
  private broadcastSubscriptions: Map<string, string> = new Map(); // key -> subId

  subscribeToBroadcast(tags: string[], handler: BroadcastHandler): () => void {
    const key = tags.sort().join(':');

    if (!this.broadcastHandlers.has(key)) {
      this.broadcastHandlers.set(key, new Set());

      // Subscribe to relay
      if (this.isConnected() && this.nostrClient) {
        this.subscribeToTags(tags);
      }
    }

    this.broadcastHandlers.get(key)!.add(handler);

    return () => {
      this.broadcastHandlers.get(key)?.delete(handler);
      if (this.broadcastHandlers.get(key)?.size === 0) {
        this.broadcastHandlers.delete(key);
        // Unsubscribe from relay
        const subId = this.broadcastSubscriptions.get(key);
        if (subId && this.nostrClient) {
          this.nostrClient.unsubscribe(subId);
          this.broadcastSubscriptions.delete(key);
        }
      }
    };
  }

  async publishBroadcast(content: string, tags?: string[]): Promise<string> {
    this.ensureReady();

    const eventTags = tags?.map((t) => ['t', t]) ?? [];
    const event = await this.createEvent(EVENT_KINDS.BROADCAST, content, eventTags);

    await this.publishEvent(event);
    return event.id;
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  onEvent(callback: TransportEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // ===========================================================================
  // Private: Message Handling
  // ===========================================================================

  private async handleEvent(event: NostrEvent): Promise<void> {
    this.log('Processing event kind:', event.kind, 'id:', event.id?.slice(0, 12));
    try {
      switch (event.kind) {
        case EVENT_KINDS.DIRECT_MESSAGE:
          await this.handleDirectMessage(event);
          break;
        case EventKinds.GIFT_WRAP:
          this.log('Handling gift wrap (NIP-17 DM)');
          await this.handleGiftWrap(event);
          break;
        case EVENT_KINDS.TOKEN_TRANSFER:
          await this.handleTokenTransfer(event);
          break;
        case EVENT_KINDS.PAYMENT_REQUEST:
          await this.handlePaymentRequest(event);
          break;
        case EVENT_KINDS.PAYMENT_REQUEST_RESPONSE:
          await this.handlePaymentRequestResponse(event);
          break;
        case EVENT_KINDS.BROADCAST:
          this.handleBroadcast(event);
          break;
      }
    } catch (error) {
      this.log('Failed to handle event:', error);
    }
  }

  private async handleDirectMessage(event: NostrEvent): Promise<void> {
    // NIP-04 (kind 4) is deprecated for DMs - only used for legacy token transfers
    // DMs should come through NIP-17 (kind 1059 gift wrap) via handleGiftWrap
    // This handler is kept for backwards compatibility but does NOT dispatch to messageHandlers
    this.log('Ignoring NIP-04 kind 4 event (DMs use NIP-17):', event.id?.slice(0, 12));
  }

  private async handleGiftWrap(event: NostrEvent): Promise<void> {
    if (!this.identity || !this.keyManager) {
      this.log('handleGiftWrap: no identity/keyManager');
      return;
    }

    try {
      const pm = NIP17.unwrap(event as any, this.keyManager);
      this.log('Gift wrap unwrapped, sender:', pm.senderPubkey?.slice(0, 16), 'kind:', pm.kind);
      if (pm.senderPubkey === this.keyManager.getPublicKeyHex()) {
        this.log('Skipping own message');
        return;
      }
      if (pm.kind !== EventKinds.CHAT_MESSAGE) {
        this.log('Skipping non-chat message, kind:', pm.kind);
        return;
      }

      // Sphere app wraps DM content as JSON: {senderNametag, text}
      let content = pm.content;
      let senderNametag: string | undefined;
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed.text !== undefined) {
          content = parsed.text;
          senderNametag = parsed.senderNametag || undefined;
        }
      } catch {
        // Plain text — use as-is
      }

      this.log('DM received from:', senderNametag || pm.senderPubkey?.slice(0, 16), 'content:', content?.slice(0, 50));

      const message: IncomingMessage = {
        id: pm.eventId,
        senderTransportPubkey: pm.senderPubkey,
        senderNametag,
        content,
        timestamp: pm.timestamp * 1000,
        encrypted: true,
      };

      this.emitEvent({ type: 'message:received', timestamp: Date.now() });

      if (this.messageHandlers.size === 0) {
        this.log('No message handlers registered, buffering message for later delivery');
        this.pendingMessages.push(message);
      } else {
        this.log('Dispatching to', this.messageHandlers.size, 'handlers');
        for (const handler of this.messageHandlers) {
          try {
            handler(message);
          } catch (error) {
            this.log('Message handler error:', error);
          }
        }
      }
    } catch (err) {
      // Expected for gift wraps meant for other recipients
      this.log('Gift wrap decrypt failed (expected if not for us):', (err as Error)?.message?.slice(0, 50));
    }
  }

  private async handleTokenTransfer(event: NostrEvent): Promise<void> {
    if (!this.identity) return;

    // Decrypt content
    const content = await this.decryptContent(event.content, event.pubkey);
    const payload = JSON.parse(content) as TokenTransferPayload;

    const transfer: IncomingTokenTransfer = {
      id: event.id,
      senderTransportPubkey: event.pubkey,
      payload,
      timestamp: event.created_at * 1000,
    };

    this.emitEvent({ type: 'transfer:received', timestamp: Date.now() });

    for (const handler of this.transferHandlers) {
      try {
        handler(transfer);
      } catch (error) {
        this.log('Transfer handler error:', error);
      }
    }
  }

  private async handlePaymentRequest(event: NostrEvent): Promise<void> {
    if (!this.identity) return;

    try {
      // Decrypt content
      const content = await this.decryptContent(event.content, event.pubkey);
      const requestData = JSON.parse(content) as {
        requestId: string;
        amount: string;
        coinId: string;
        message?: string;
        recipientNametag?: string;
        metadata?: Record<string, unknown>;
      };

      const request: IncomingPaymentRequest = {
        id: event.id,
        senderTransportPubkey: event.pubkey,
        request: {
          requestId: requestData.requestId,
          amount: requestData.amount,
          coinId: requestData.coinId,
          message: requestData.message,
          recipientNametag: requestData.recipientNametag,
          metadata: requestData.metadata,
        },
        timestamp: event.created_at * 1000,
      };

      this.log('Received payment request:', request.id);

      for (const handler of this.paymentRequestHandlers) {
        try {
          handler(request);
        } catch (error) {
          this.log('Payment request handler error:', error);
        }
      }
    } catch (error) {
      this.log('Failed to handle payment request:', error);
    }
  }

  private async handlePaymentRequestResponse(event: NostrEvent): Promise<void> {
    if (!this.identity) return;

    try {
      // Decrypt content
      const content = await this.decryptContent(event.content, event.pubkey);
      const responseData = JSON.parse(content) as {
        requestId: string;
        responseType: 'accepted' | 'rejected' | 'paid';
        message?: string;
        transferId?: string;
      };

      const response: IncomingPaymentRequestResponse = {
        id: event.id,
        responderTransportPubkey: event.pubkey,
        response: {
          requestId: responseData.requestId,
          responseType: responseData.responseType,
          message: responseData.message,
          transferId: responseData.transferId,
        },
        timestamp: event.created_at * 1000,
      };

      this.log('Received payment request response:', response.id, 'type:', responseData.responseType);

      for (const handler of this.paymentRequestResponseHandlers) {
        try {
          handler(response);
        } catch (error) {
          this.log('Payment request response handler error:', error);
        }
      }
    } catch (error) {
      this.log('Failed to handle payment request response:', error);
    }
  }

  private handleBroadcast(event: NostrEvent): void {
    const tags = event.tags
      .filter((t: string[]) => t[0] === 't')
      .map((t: string[]) => t[1]);

    const broadcast: IncomingBroadcast = {
      id: event.id,
      authorTransportPubkey: event.pubkey,
      content: event.content,
      tags,
      timestamp: event.created_at * 1000,
    };

    // Find matching handlers
    for (const [key, handlers] of this.broadcastHandlers) {
      const subscribedTags = key.split(':');
      if (tags.some((t) => subscribedTags.includes(t))) {
        for (const handler of handlers) {
          try {
            handler(broadcast);
          } catch (error) {
            this.log('Broadcast handler error:', error);
          }
        }
      }
    }
  }

  // ===========================================================================
  // Private: Event Creation & Publishing
  // ===========================================================================

  private async createEvent(
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<NostrEvent> {
    if (!this.identity) throw new Error('Identity not set');
    if (!this.keyManager) throw new Error('KeyManager not initialized');

    // Create and sign event using SDK
    const signedEvent = NostrEventClass.create(this.keyManager, {
      kind,
      content,
      tags,
    });

    // Convert to our interface
    const event: NostrEvent = {
      id: signedEvent.id,
      kind: signedEvent.kind,
      content: signedEvent.content,
      tags: signedEvent.tags,
      pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at,
      sig: signedEvent.sig,
    };

    return event;
  }

  private async createEncryptedEvent(
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<NostrEvent> {
    if (!this.keyManager) throw new Error('KeyManager not initialized');

    // Extract recipient pubkey from tags (first 'p' tag)
    const recipientTag = tags.find((t) => t[0] === 'p');
    if (!recipientTag || !recipientTag[1]) {
      throw new Error('No recipient pubkey in tags for encryption');
    }
    const recipientPubkey = recipientTag[1];

    // Encrypt content with NIP-04 (using hex variant for string keys)
    const encrypted = await NIP04.encryptHex(
      content,
      this.keyManager.getPrivateKeyHex(),
      recipientPubkey
    );

    return this.createEvent(kind, encrypted, tags);
  }

  private async publishEvent(event: NostrEvent): Promise<void> {
    if (!this.nostrClient) {
      throw new Error('NostrClient not initialized');
    }

    // Convert to nostr-js-sdk Event and publish
    const sdkEvent = NostrEventClass.fromJSON(event);
    await this.nostrClient.publishEvent(sdkEvent);
  }

  private async queryEvents(filterObj: NostrFilter): Promise<NostrEvent[]> {
    if (!this.nostrClient || !this.nostrClient.isConnected()) {
      throw new Error('No connected relays');
    }

    const events: NostrEvent[] = [];
    const filter = new Filter(filterObj);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (subId) {
          this.nostrClient?.unsubscribe(subId);
        }
        resolve(events);
      }, 5000);

      const subId = this.nostrClient!.subscribe(filter, {
        onEvent: (event) => {
          events.push({
            id: event.id,
            kind: event.kind,
            content: event.content,
            tags: event.tags,
            pubkey: event.pubkey,
            created_at: event.created_at,
            sig: event.sig,
          });
        },
        onEndOfStoredEvents: () => {
          clearTimeout(timeout);
          this.nostrClient?.unsubscribe(subId);
          resolve(events);
        },
      });
    });
  }

  // ===========================================================================
  // Private: Subscriptions
  // ===========================================================================

  // Track subscription IDs for cleanup
  private walletSubscriptionId: string | null = null;
  private chatSubscriptionId: string | null = null;

  private subscribeToEvents(): void {
    this.log('subscribeToEvents called, identity:', !!this.identity, 'keyManager:', !!this.keyManager, 'nostrClient:', !!this.nostrClient);
    if (!this.identity || !this.keyManager || !this.nostrClient) {
      this.log('subscribeToEvents: skipped - no identity, keyManager, or nostrClient');
      return;
    }

    // Unsubscribe from previous subscriptions if any
    if (this.walletSubscriptionId) {
      this.nostrClient.unsubscribe(this.walletSubscriptionId);
      this.walletSubscriptionId = null;
    }
    if (this.chatSubscriptionId) {
      this.nostrClient.unsubscribe(this.chatSubscriptionId);
      this.chatSubscriptionId = null;
    }
    if (this.mainSubscriptionId) {
      this.nostrClient.unsubscribe(this.mainSubscriptionId);
      this.mainSubscriptionId = null;
    }

    // Use 32-byte Nostr pubkey (x-coordinate only), not 33-byte compressed key
    const nostrPubkey = this.keyManager.getPublicKeyHex();
    this.log('Subscribing with Nostr pubkey:', nostrPubkey);

    // Subscribe to wallet events (token transfers, payment requests) with since filter
    // Matches Sphere app's approach
    const walletFilter = new Filter();
    walletFilter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
    ];
    walletFilter['#p'] = [nostrPubkey];
    walletFilter.since = Math.floor(Date.now() / 1000) - 86400; // Last 24h

    this.walletSubscriptionId = this.nostrClient.subscribe(walletFilter, {
      onEvent: (event) => {
        this.log('Received wallet event kind:', event.kind, 'id:', event.id?.slice(0, 12));
        this.handleEvent({
          id: event.id,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          pubkey: event.pubkey,
          created_at: event.created_at,
          sig: event.sig,
        });
      },
      onEndOfStoredEvents: () => {
        this.log('Wallet subscription ready (EOSE)');
      },
      onError: (_subId, error) => {
        this.log('Wallet subscription error:', error);
      },
    });
    this.log('Wallet subscription created, subId:', this.walletSubscriptionId);

    // Subscribe to chat events (NIP-17 gift wrap) WITHOUT since filter
    // This matches Sphere app's approach - chat messages rely on deduplication
    const chatFilter = new Filter();
    chatFilter.kinds = [EventKinds.GIFT_WRAP];
    chatFilter['#p'] = [nostrPubkey];
    // NO since filter for chat - we want real-time messages

    this.chatSubscriptionId = this.nostrClient.subscribe(chatFilter, {
      onEvent: (event) => {
        this.log('Received chat event kind:', event.kind, 'id:', event.id?.slice(0, 12));
        this.handleEvent({
          id: event.id,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          pubkey: event.pubkey,
          created_at: event.created_at,
          sig: event.sig,
        });
      },
      onEndOfStoredEvents: () => {
        this.log('Chat subscription ready (EOSE)');
      },
      onError: (_subId, error) => {
        this.log('Chat subscription error:', error);
      },
    });
    this.log('Chat subscription created, subId:', this.chatSubscriptionId);
  }

  private subscribeToTags(tags: string[]): void {
    if (!this.nostrClient) return;

    const key = tags.sort().join(':');
    const filter = new Filter({
      kinds: [EVENT_KINDS.BROADCAST],
      '#t': tags,
      since: Math.floor(Date.now() / 1000) - 3600, // Last hour
    });

    const subId = this.nostrClient.subscribe(filter, {
      onEvent: (event) => {
        this.handleBroadcast({
          id: event.id,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          pubkey: event.pubkey,
          created_at: event.created_at,
          sig: event.sig,
        });
      },
    });

    this.broadcastSubscriptions.set(key, subId);
  }

  // ===========================================================================
  // Private: Encryption
  // ===========================================================================

  private async decryptContent(content: string, senderPubkey: string): Promise<string> {
    if (!this.keyManager) throw new Error('KeyManager not initialized');

    // Decrypt content using NIP-04 (using hex variant for string keys)
    const decrypted = await NIP04.decryptHex(
      content,
      this.keyManager.getPrivateKeyHex(),
      senderPubkey
    );

    // Strip known prefixes for compatibility with nostr-js-sdk
    return this.stripContentPrefix(decrypted);
  }

  /**
   * Strip known content prefixes (nostr-js-sdk compatibility)
   * Handles: payment_request:, token_transfer:, etc.
   */
  private stripContentPrefix(content: string): string {
    const prefixes = [
      'payment_request:',
      'token_transfer:',
      'payment_response:',
    ];

    for (const prefix of prefixes) {
      if (content.startsWith(prefix)) {
        return content.slice(prefix.length);
      }
    }

    return content;
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error('NostrTransportProvider not connected');
    }
  }

  private ensureReady(): void {
    this.ensureConnected();
    if (!this.identity) {
      throw new Error('Identity not set');
    }
  }

  private emitEvent(event: TransportEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.log('Event callback error:', error);
      }
    }
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[NostrTransportProvider]', ...args);
    }
  }
}

// =============================================================================
// Types
// =============================================================================

interface NostrEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig: string;
}

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#p'?: string[];
  '#t'?: string[];
  '#d'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}
