/**
 * Nostr Transport Provider
 * Platform-independent implementation using Nostr protocol for P2P messaging
 *
 * Uses @unicitylabs/nostr-js-sdk for:
 * - Real secp256k1 event signing
 * - NIP-04 encryption/decryption
 * - Event ID calculation
 *
 * WebSocket is injected via factory for cross-platform support
 */

import { Buffer } from 'buffer';
import {
  NostrKeyManager,
  NIP04,
  NIP17,
  Event as NostrEventClass,
  EventKinds,
  hashNametag,
} from '@unicitylabs/nostr-js-sdk';
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
} from './transport-provider';
import type { IWebSocket, IMessageEvent, WebSocketFactory, UUIDGenerator } from './websocket';
import { WebSocketReadyState, defaultUUIDGenerator } from './websocket';
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

  // WebSocket connections to relays
  private connections: Map<string, IWebSocket> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();

  // Event handlers
  private messageHandlers: Set<MessageHandler> = new Set();
  private transferHandlers: Set<TokenTransferHandler> = new Set();
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private broadcastHandlers: Map<string, Set<BroadcastHandler>> = new Map();
  private eventCallbacks: Set<TransportEventCallback> = new Set();

  // Subscriptions
  private subscriptions: Map<string, string[]> = new Map(); // subId -> relays

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
      // Connect to all relays in parallel
      const connectPromises = this.config.relays.map((relay) =>
        this.connectToRelay(relay)
      );

      await Promise.allSettled(connectPromises);

      // Need at least one successful connection
      if (this.connections.size === 0) {
        throw new Error('Failed to connect to any relay');
      }

      this.status = 'connected';
      this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
      this.log('Connected to', this.connections.size, 'relays');

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
    for (const [url, ws] of this.connections) {
      ws.close();
      this.connections.delete(url);
    }

    this.subscriptions.clear();
    this.status = 'disconnected';
    this.emitEvent({ type: 'transport:disconnected', timestamp: Date.now() });
    this.log('Disconnected from all relays');
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.connections.size > 0;
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
    return Array.from(this.connections.keys());
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
    if (this.status === 'connected') {
      try {
        await this.connectToRelay(relayUrl);
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
   */
  async removeRelay(relayUrl: string): Promise<boolean> {
    const index = this.config.relays.indexOf(relayUrl);
    if (index === -1) {
      this.log('Relay not found:', relayUrl);
      return false;
    }

    // Remove from config
    this.config.relays.splice(index, 1);

    // Disconnect if connected
    const ws = this.connections.get(relayUrl);
    if (ws) {
      ws.close();
      this.connections.delete(relayUrl);
      this.reconnectAttempts.delete(relayUrl);
      this.log('Removed and disconnected from relay:', relayUrl);
    }

    this.emitEvent({
      type: 'transport:relay_removed',
      timestamp: Date.now(),
      data: { relay: relayUrl },
    });

    // Check if we still have connections
    if (this.connections.size === 0 && this.status === 'connected') {
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
    const ws = this.connections.get(relayUrl);
    return ws !== undefined && ws.readyState === WebSocketReadyState.OPEN;
  }

  // ===========================================================================
  // TransportProvider Implementation
  // ===========================================================================

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;

    // Create NostrKeyManager from private key
    const secretKey = Buffer.from(identity.privateKey, 'hex');
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    // Use Nostr-format pubkey (32 bytes / 64 hex chars) from keyManager
    const nostrPubkey = this.keyManager.getPublicKeyHex();
    this.log('Identity set, Nostr pubkey:', nostrPubkey.slice(0, 16) + '...');

    // Re-subscribe if already connected
    if (this.isConnected()) {
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

    // Wrap content with sender nametag for Sphere app compatibility
    const senderNametag = this.identity?.nametag;
    const wrappedContent = senderNametag
      ? JSON.stringify({ senderNametag, text: content })
      : content;

    // Create NIP-17 gift-wrapped message (kind 1059)
    const giftWrap = NIP17.createGiftWrap(this.keyManager!, recipientPubkey, wrappedContent);

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

  async resolveNametag(nametag: string): Promise<string | null> {
    this.ensureReady();

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

  async registerNametag(nametag: string, _publicKey: string): Promise<boolean> {
    this.ensureReady();

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

    // Publish nametag binding matching nostr-js-sdk format
    // Use Nostr pubkey (32 bytes) for all fields
    const hashedNametag = hashNametag(nametag);
    const content = JSON.stringify({
      nametag_hash: hashedNametag,
      address: nostrPubkey,
      verified: Date.now(),
    });

    const event = await this.createEvent(EVENT_KINDS.NAMETAG_BINDING, content, [
      ['d', hashedNametag],
      ['nametag', hashedNametag],
      ['t', hashedNametag],
['address', nostrPubkey],
    ]);

    await this.publishEvent(event);
    this.log('Registered nametag:', nametag, 'for pubkey:', nostrPubkey.slice(0, 16) + '...');
    return true;
  }

  subscribeToBroadcast(tags: string[], handler: BroadcastHandler): () => void {
    const key = tags.sort().join(':');

    if (!this.broadcastHandlers.has(key)) {
      this.broadcastHandlers.set(key, new Set());

      // Subscribe to relay
      if (this.isConnected()) {
        this.subscribeToTags(tags);
      }
    }

    this.broadcastHandlers.get(key)!.add(handler);

    return () => {
      this.broadcastHandlers.get(key)?.delete(handler);
      if (this.broadcastHandlers.get(key)?.size === 0) {
        this.broadcastHandlers.delete(key);
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
  // Private: Connection Management
  // ===========================================================================

  private async connectToRelay(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.config.createWebSocket(url);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timeout: ${url}`));
      }, this.config.timeout);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.connections.set(url, ws);
        this.reconnectAttempts.set(url, 0);
        this.log('Connected to relay:', url);
        resolve();
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        this.log('Relay error:', url, error);
        reject(error);
      };

      ws.onclose = () => {
        this.connections.delete(url);
        if (this.config.autoReconnect && this.status === 'connected') {
          this.scheduleReconnect(url);
        }
      };

      ws.onmessage = (event: IMessageEvent) => {
        this.handleRelayMessage(url, event.data);
      };
    });
  }

  private scheduleReconnect(url: string): void {
    const attempts = this.reconnectAttempts.get(url) ?? 0;
    if (attempts >= this.config.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached for:', url);
      return;
    }

    this.reconnectAttempts.set(url, attempts + 1);
    const delay = this.config.reconnectDelay * Math.pow(2, attempts);

    this.emitEvent({ type: 'transport:reconnecting', timestamp: Date.now() });

    setTimeout(() => {
      this.connectToRelay(url).catch(() => {
        // Will retry again if still below max attempts
      });
    }, delay);
  }

  // ===========================================================================
  // Private: Message Handling
  // ===========================================================================

  private handleRelayMessage(relay: string, data: string): void {
    try {
      const message = JSON.parse(data);
      const [type, ...args] = message;

      switch (type) {
        case 'EVENT':
          this.handleEvent(args[1]);
          break;
        case 'EOSE':
          // End of stored events
          break;
        case 'OK':
          // Event accepted
          break;
        case 'NOTICE':
          this.log('Relay notice:', relay, args[0]);
          break;
      }
    } catch (error) {
      this.log('Failed to parse relay message:', error);
    }
  }

  private async handleEvent(event: NostrEvent): Promise<void> {
    try {
      switch (event.kind) {
        case EVENT_KINDS.DIRECT_MESSAGE:
          await this.handleDirectMessage(event);
          break;
        case EventKinds.GIFT_WRAP:
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
    if (!this.identity || !this.keyManager) return;

    // Skip our own messages (compare with 32-byte Nostr pubkey)
    if (event.pubkey === this.keyManager.getPublicKeyHex()) return;

    // Decrypt content
    const content = await this.decryptContent(event.content, event.pubkey);

    const message: IncomingMessage = {
      id: event.id,
      senderPubkey: event.pubkey,
      content,
      timestamp: event.created_at * 1000,
      encrypted: true,
    };

    this.emitEvent({ type: 'message:received', timestamp: Date.now() });

    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.log('Message handler error:', error);
      }
    }
  }

  private async handleGiftWrap(event: NostrEvent): Promise<void> {
    if (!this.identity || !this.keyManager) return;

    try {
      const pm = NIP17.unwrap(event as any, this.keyManager);
      if (pm.senderPubkey === this.keyManager.getPublicKeyHex()) return;
      if (pm.kind !== EventKinds.CHAT_MESSAGE) return;

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

      const message: IncomingMessage = {
        id: pm.eventId,
        senderPubkey: pm.senderPubkey,
        senderNametag,
        content,
        timestamp: pm.timestamp * 1000,
        encrypted: true,
      };

      this.emitEvent({ type: 'message:received', timestamp: Date.now() });

      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch (error) {
          this.log('Message handler error:', error);
        }
      }
    } catch {
      // Expected for gift wraps meant for other recipients
    }
  }

  private async handleTokenTransfer(event: NostrEvent): Promise<void> {
    if (!this.identity) return;

    // Decrypt content
    const content = await this.decryptContent(event.content, event.pubkey);
    const payload = JSON.parse(content) as TokenTransferPayload;

    const transfer: IncomingTokenTransfer = {
      id: event.id,
      senderPubkey: event.pubkey,
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
        senderPubkey: event.pubkey,
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
        responderPubkey: event.pubkey,
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
      authorPubkey: event.pubkey,
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
    const message = JSON.stringify(['EVENT', event]);

    const publishPromises = Array.from(this.connections.values()).map((ws) => {
      return new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocketReadyState.OPEN) {
          reject(new Error('WebSocket not open'));
          return;
        }

        ws.send(message);
        resolve();
      });
    });

    await Promise.any(publishPromises);
  }

  private async queryEvents(filter: NostrFilter): Promise<NostrEvent[]> {
    if (this.connections.size === 0) {
      throw new Error('No connected relays');
    }

    // Query all relays in parallel and return first non-empty result
    const queryPromises = Array.from(this.connections.values()).map(ws =>
      this.queryEventsFromRelay(ws, filter)
    );

    // Wait for first relay that returns events, or all to complete
    const results = await Promise.allSettled(queryPromises);

    // Find first successful result with events
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        return result.value;
      }
    }

    // No events found on any relay
    return [];
  }

  private async queryEventsFromRelay(ws: IWebSocket, filter: NostrFilter): Promise<NostrEvent[]> {
    const subId = this.config.generateUUID().slice(0, 8);
    const events: NostrEvent[] = [];

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.unsubscribeFromRelay(ws, subId);
        resolve(events);
      }, 5000);

      const originalHandler = ws.onmessage;
      ws.onmessage = (event: IMessageEvent) => {
        const message = JSON.parse(event.data);
        const [type, sid, data] = message;

        if (sid !== subId) {
          originalHandler?.call(ws, event);
          return;
        }

        if (type === 'EVENT') {
          events.push(data);
        } else if (type === 'EOSE') {
          clearTimeout(timeout);
          ws.onmessage = originalHandler;
          this.unsubscribeFromRelay(ws, subId);
          resolve(events);
        }
      };

      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
  }

  private unsubscribeFromRelay(ws: IWebSocket, subId: string): void {
    if (ws.readyState === WebSocketReadyState.OPEN) {
      ws.send(JSON.stringify(['CLOSE', subId]));
    }
  }

  // ===========================================================================
  // Private: Subscriptions
  // ===========================================================================

  private subscribeToEvents(): void {
    if (!this.identity || !this.keyManager) return;

    const subId = 'main';
    // Use 32-byte Nostr pubkey (x-coordinate only), not 33-byte compressed key
    const nostrPubkey = this.keyManager.getPublicKeyHex();
    const filter: NostrFilter = {
      kinds: [
        EVENT_KINDS.DIRECT_MESSAGE,
        EventKinds.GIFT_WRAP,
        EVENT_KINDS.TOKEN_TRANSFER,
        EVENT_KINDS.PAYMENT_REQUEST,
        EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      ],
      '#p': [nostrPubkey],
      since: Math.floor(Date.now() / 1000) - 86400, // Last 24h
    };

    const message = JSON.stringify(['REQ', subId, filter]);

    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocketReadyState.OPEN) {
        ws.send(message);
      }
    }

    this.subscriptions.set(subId, Array.from(this.connections.keys()));
    this.log('Subscribed to events');
  }

  private subscribeToTags(tags: string[]): void {
    const subId = `tags:${tags.join(':')}`;
    const filter: NostrFilter = {
      kinds: [EVENT_KINDS.BROADCAST],
      '#t': tags,
      since: Math.floor(Date.now() / 1000) - 3600, // Last hour
    };

    const message = JSON.stringify(['REQ', subId, filter]);

    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocketReadyState.OPEN) {
        ws.send(message);
      }
    }

    this.subscriptions.set(subId, Array.from(this.connections.keys()));
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

  private ensureReady(): void {
    if (!this.isConnected()) {
      throw new Error('NostrTransportProvider not connected');
    }
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
