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
  Event as NostrEventClass,
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
  // TransportProvider Implementation
  // ===========================================================================

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;

    // Create NostrKeyManager from private key
    const secretKey = Buffer.from(identity.privateKey, 'hex');
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    this.log('Identity set:', identity.publicKey.slice(0, 16) + '...');

    // Re-subscribe if already connected
    if (this.isConnected()) {
      this.subscribeToEvents();
    }
  }

  async sendMessage(recipientPubkey: string, content: string): Promise<string> {
    this.ensureReady();

    // Create NIP-04 encrypted DM event
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.DIRECT_MESSAGE,
      content,
      [['p', recipientPubkey]]
    );

    await this.publishEvent(event);

    this.emitEvent({
      type: 'message:sent',
      timestamp: Date.now(),
      data: { recipient: recipientPubkey },
    });

    return event.id;
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
    const content = JSON.stringify(payload);
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [
        ['p', recipientPubkey],
        ['d', 'token-transfer'],
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

    // Build request content
    const requestContent = {
      requestId: this.config.generateUUID(),
      amount: typeof payload.amount === 'bigint' ? payload.amount.toString() : payload.amount,
      coinId: payload.coinId,
      message: payload.message,
      recipientNametag: payload.recipientNametag,
      metadata: payload.metadata,
    };

    // Create encrypted payment request event
    const content = JSON.stringify(requestContent);
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.PAYMENT_REQUEST,
      content,
      [
        ['p', recipientPubkey],
        ['d', 'payment-request'],
      ]
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
    const content = JSON.stringify(responseContent);
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      content,
      [
        ['p', recipientPubkey],
        ['e', payload.requestId], // Reference to original request
        ['d', 'payment-request-response'],
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

    // Query for nametag binding events
    const filter = {
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      '#d': [nametag],
      limit: 1,
    };

    const events = await this.queryEvents(filter);
    if (events.length === 0) return null;

    // Parse binding event
    const bindingEvent = events[0];
    const pubkeyTag = bindingEvent.tags.find((t: string[]) => t[0] === 'p');
    return pubkeyTag?.[1] ?? null;
  }

  async publishNametag(nametag: string, address: string): Promise<void> {
    this.ensureReady();

    const event = await this.createEvent(EVENT_KINDS.NAMETAG_BINDING, address, [
      ['d', nametag],
      ['a', address],
    ]);

    await this.publishEvent(event);
    this.log('Published nametag binding:', nametag);
  }

  async registerNametag(nametag: string, publicKey: string): Promise<boolean> {
    this.ensureReady();

    // Check if nametag is already taken
    const existing = await this.resolveNametag(nametag);
    if (existing && existing !== publicKey) {
      this.log('Nametag already taken:', nametag);
      return false;
    }

    // If already registered to this pubkey, success
    if (existing === publicKey) {
      this.log('Nametag already registered to this pubkey:', nametag);
      return true;
    }

    // Publish nametag binding
    const event = await this.createEvent(EVENT_KINDS.NAMETAG_BINDING, publicKey, [
      ['d', nametag],
      ['p', publicKey],
    ]);

    await this.publishEvent(event);
    this.log('Registered nametag:', nametag, 'for pubkey:', publicKey.slice(0, 16) + '...');
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
    if (!this.identity) return;

    // Skip our own messages
    if (event.pubkey === this.identity.publicKey) return;

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
    const subId = this.config.generateUUID().slice(0, 8);
    const events: NostrEvent[] = [];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.unsubscribe(subId);
        resolve(events);
      }, 5000);

      // Subscribe to first connected relay
      const ws = this.connections.values().next().value;
      if (!ws) {
        clearTimeout(timeout);
        reject(new Error('No connected relays'));
        return;
      }

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
          this.unsubscribe(subId);
          resolve(events);
        }
      };

      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
  }

  // ===========================================================================
  // Private: Subscriptions
  // ===========================================================================

  private subscribeToEvents(): void {
    if (!this.identity) return;

    const subId = 'main';
    const filter: NostrFilter = {
      kinds: [
        EVENT_KINDS.DIRECT_MESSAGE,
        EVENT_KINDS.TOKEN_TRANSFER,
        EVENT_KINDS.PAYMENT_REQUEST,
        EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      ],
      '#p': [this.identity.publicKey],
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

  private unsubscribe(subId: string): void {
    const message = JSON.stringify(['CLOSE', subId]);

    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocketReadyState.OPEN) {
        ws.send(message);
      }
    }

    this.subscriptions.delete(subId);
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

    return decrypted;
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
