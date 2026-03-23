/**
 * Multi-Address Transport Multiplexer
 *
 * Wraps a single NostrTransportProvider to support multiple HD addresses
 * simultaneously. Each address gets a lightweight AddressTransportAdapter
 * that implements TransportProvider but shares the single WebSocket connection.
 *
 * Event routing:
 * - Wallet events (kind 4, 31113, 31115, 31116): routed by #p tag (recipient pubkey)
 * - Chat events (kind 1059 gift wrap): try decrypt with each address keyManager
 *
 * Sending: each adapter delegates to the inner transport with its own keyManager.
 */

import { Buffer } from 'buffer';
import {
  NostrKeyManager,
  NIP04,
  NIP17,
  Event as NostrEventClass,
  EventKinds,
  NostrClient,
  Filter,
  isChatMessage,
  isReadReceipt,
} from '@unicitylabs/nostr-js-sdk';
import { logger } from '../core/logger';
import { SphereError } from '../core/errors';
import type { ProviderStatus, FullIdentity } from '../types';
import type {
  TransportProvider,
  MessageHandler,
  ComposingHandler,
  TokenTransferHandler,
  BroadcastHandler,
  PaymentRequestHandler,
  PaymentRequestResponseHandler,
  IncomingMessage,
  IncomingTokenTransfer,
  IncomingPaymentRequest,
  IncomingPaymentRequestResponse,
  TokenTransferPayload,
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  TransportEvent,
  TransportEventCallback,
  PeerInfo,
  ReadReceiptHandler,
  IncomingReadReceipt,
  TypingIndicatorHandler,
  IncomingTypingIndicator,
  InstantSplitBundlePayload,
  InstantSplitBundleHandler,
  IncomingInstantSplitBundle,
} from './transport-provider';
import type { WebSocketFactory, UUIDGenerator } from './websocket';
import { defaultUUIDGenerator } from './websocket';
import { NostrTransportProvider } from './NostrTransportProvider';
import type { TransportStorageAdapter, NostrTransportProviderConfig } from './NostrTransportProvider';
import {
  DEFAULT_NOSTR_RELAYS,
  NOSTR_EVENT_KINDS,
  STORAGE_KEYS_GLOBAL,
  TIMEOUTS,
} from '../constants';

// Alias for backward compatibility
const EVENT_KINDS = NOSTR_EVENT_KINDS;
const COMPOSING_INDICATOR_KIND = 25050;

// NIP-17 gift wraps randomize created_at by ±2 days for privacy.
// Subscriptions and one-shot queries must look further back by this window
// so the relay returns events whose actual send time is recent even if their
// created_at was shifted into the past.
const NIP17_TIMESTAMP_RANDOMIZATION = 2 * 24 * 60 * 60; // 172800 s

// =============================================================================
// Nostr Event type (local, matching NostrTransportProvider)
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

// =============================================================================
// Address Entry — per-address state managed by the mux
// =============================================================================

interface AddressEntry {
  index: number;
  identity: FullIdentity;
  keyManager: NostrKeyManager;
  nostrPubkey: string;
  adapter: AddressTransportAdapter;
  lastEventTs: number;
  lastDmEventTs: number;
  fallbackSince: number | null;
  fallbackDmSince: number | null;
}

// =============================================================================
// MultiAddressTransportMux
// =============================================================================

export interface MultiAddressTransportMuxConfig {
  relays?: string[];
  timeout?: number;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  createWebSocket: WebSocketFactory;
  generateUUID?: UUIDGenerator;
  storage?: TransportStorageAdapter;
}

export class MultiAddressTransportMux {
  private config: Required<Omit<MultiAddressTransportMuxConfig, 'createWebSocket' | 'generateUUID' | 'storage'>> & {
    createWebSocket: WebSocketFactory;
    generateUUID: UUIDGenerator;
  };
  private storage: TransportStorageAdapter | null = null;

  // Single NostrClient — one WebSocket connection for all addresses
  private nostrClient: NostrClient | null = null;
  // KeyManager used for NostrClient creation (uses first address or temp key)
  private primaryKeyManager: NostrKeyManager | null = null;
  private status: ProviderStatus = 'disconnected';

  // Per-address entries
  private addresses = new Map<number, AddressEntry>();
  // pubkey → address index (for fast routing)
  private pubkeyToIndex = new Map<string, number>();

  // Subscription IDs
  private walletSubscriptionId: string | null = null;
  private chatSubscriptionId: string | null = null;
  private chatEoseFired = false;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWalletEventAt: number = Date.now();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private chatEoseHandlers: Array<() => void> = [];

  // Dedup
  private processedEventIds = new Set<string>();

  // Event callbacks (mux-level, forwarded to all adapters)
  private eventCallbacks: Set<TransportEventCallback> = new Set();

  constructor(config: MultiAddressTransportMuxConfig) {
    this.config = {
      relays: config.relays ?? [...DEFAULT_NOSTR_RELAYS],
      timeout: config.timeout ?? TIMEOUTS.WEBSOCKET_CONNECT,
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? TIMEOUTS.NOSTR_RECONNECT_DELAY,
      maxReconnectAttempts: config.maxReconnectAttempts ?? TIMEOUTS.MAX_RECONNECT_ATTEMPTS,
      createWebSocket: config.createWebSocket,
      generateUUID: config.generateUUID ?? defaultUUIDGenerator,
    };
    this.storage = config.storage ?? null;
  }

  // ===========================================================================
  // Address Management
  // ===========================================================================

  /**
   * Add an address to the multiplexer.
   * Creates an AddressTransportAdapter for this address.
   * If already connected, updates subscriptions to include the new pubkey.
   */
  async addAddress(index: number, identity: FullIdentity, resolveDelegate?: TransportProvider | null): Promise<AddressTransportAdapter> {
    // If already registered, update identity and return existing adapter
    const existing = this.addresses.get(index);
    if (existing) {
      existing.identity = identity;
      existing.keyManager = NostrKeyManager.fromPrivateKey(Buffer.from(identity.privateKey, 'hex'));
      existing.nostrPubkey = existing.keyManager.getPublicKeyHex();
      // Update pubkey mapping
      for (const [pk, idx] of this.pubkeyToIndex) {
        if (idx === index) this.pubkeyToIndex.delete(pk);
      }
      this.pubkeyToIndex.set(existing.nostrPubkey, index);
      logger.debug('Mux', `Updated address ${index}, pubkey: ${existing.nostrPubkey.slice(0, 16)}...`);
      await this.updateSubscriptions();
      return existing.adapter;
    }

    const keyManager = NostrKeyManager.fromPrivateKey(Buffer.from(identity.privateKey, 'hex'));
    const nostrPubkey = keyManager.getPublicKeyHex();

    const adapter = new AddressTransportAdapter(this, index, identity, resolveDelegate);

    const entry: AddressEntry = {
      index,
      identity,
      keyManager,
      nostrPubkey,
      adapter,
      lastEventTs: 0,
      lastDmEventTs: 0,
      fallbackSince: null,
      fallbackDmSince: null,
    };

    this.addresses.set(index, entry);
    this.pubkeyToIndex.set(nostrPubkey, index);

    logger.debug('Mux', `Added address ${index}, pubkey: ${nostrPubkey.slice(0, 16)}..., total: ${this.addresses.size}`);

    // Update primary key manager if this is the first address
    if (this.addresses.size === 1) {
      this.primaryKeyManager = keyManager;
    }

    // If already connected, update subscriptions
    if (this.isConnected()) {
      await this.updateSubscriptions();
    }

    return adapter;
  }

  /**
   * Remove an address from the multiplexer.
   * Stops routing events to this address.
   */
  async removeAddress(index: number): Promise<void> {
    const entry = this.addresses.get(index);
    if (!entry) return;

    this.pubkeyToIndex.delete(entry.nostrPubkey);
    this.addresses.delete(index);

    logger.debug('Mux', `Removed address ${index}, remaining: ${this.addresses.size}`);

    // Update subscriptions if connected
    if (this.isConnected() && this.addresses.size > 0) {
      await this.updateSubscriptions();
    }
  }

  /**
   * Get adapter for a specific address index.
   */
  getAdapter(index: number): AddressTransportAdapter | undefined {
    return this.addresses.get(index)?.adapter;
  }

  /**
   * Set fallback 'since' for an address (consumed once on next subscription setup).
   */
  setFallbackSince(index: number, sinceSeconds: number): void {
    const entry = this.addresses.get(index);
    if (entry) {
      entry.fallbackSince = sinceSeconds;
    }
  }

  setFallbackDmSince(index: number, sinceSeconds: number): void {
    const entry = this.addresses.get(index);
    if (entry) {
      entry.fallbackDmSince = sinceSeconds;
    }
  }

  // ===========================================================================
  // Connection Management (delegated from adapters)
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;
    this.status = 'connecting';

    try {
      // Create primary keyManager if none exists
      if (!this.primaryKeyManager) {
        const tempKey = Buffer.alloc(32);
        crypto.getRandomValues(tempKey);
        this.primaryKeyManager = NostrKeyManager.fromPrivateKey(tempKey);
      }

      this.nostrClient = new NostrClient(this.primaryKeyManager, {
        autoReconnect: this.config.autoReconnect,
        reconnectIntervalMs: this.config.reconnectDelay,
        maxReconnectIntervalMs: this.config.reconnectDelay * 16,
        pingIntervalMs: 15000,
      });

      this.nostrClient.addConnectionListener({
        onConnect: (url) => {
          logger.debug('Mux', 'Connected to relay:', url);
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
        },
        onDisconnect: (url, reason) => {
          logger.debug('Mux', 'Disconnected from relay:', url, 'reason:', reason);
        },
        onReconnecting: (url, attempt) => {
          logger.debug('Mux', 'Reconnecting to relay:', url, 'attempt:', attempt);
          this.emitEvent({ type: 'transport:reconnecting', timestamp: Date.now() });
        },
        onReconnected: (url) => {
          logger.debug('Mux', 'Reconnected to relay:', url);
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
        },
      });

      await Promise.race([
        this.nostrClient.connect(...this.config.relays),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Transport connection timed out after ${this.config.timeout}ms`
          )), this.config.timeout)
        ),
      ]);

      if (!this.nostrClient.isConnected()) {
        throw new SphereError('Failed to connect to any relay', 'TRANSPORT_ERROR');
      }

      this.status = 'connected';
      this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });

      // Set up subscriptions for all registered addresses
      if (this.addresses.size > 0) {
        await this.updateSubscriptions();
      }
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.nostrClient) {
      this.nostrClient.disconnect();
      this.nostrClient = null;
    }
    this.walletSubscriptionId = null;
    this.chatSubscriptionId = null;
    this.chatEoseFired = false;
    this.status = 'disconnected';
    this.emitEvent({ type: 'transport:disconnected', timestamp: Date.now() });
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.nostrClient?.isConnected() === true;
  }

  /**
   * One-shot fetch of pending events from the relay.
   * Creates a temporary subscription, waits for EOSE (or timeout),
   * then processes all collected events through the mux dispatch chain.
   * This ensures DMs (swap proposals, invoice receipts, etc.) are processed
   * before the CLI reads in-memory state.
   */
  async fetchPendingEvents(): Promise<void> {
    // Capture client reference to avoid race with concurrent disconnect() call
    const client = this.nostrClient;
    if (!client?.isConnected() || this.addresses.size === 0) return;

    const allPubkeys: string[] = [];
    for (const entry of this.addresses.values()) {
      allPubkeys.push(entry.nostrPubkey);
    }

    // Fetch gift-wrapped DMs (NIP-17, kind 1059) — these carry swap proposals,
    // invoice receipts, escrow messages, etc.
    const filter = new Filter();
    filter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      EventKinds.GIFT_WRAP,
    ];
    filter['#p'] = allPubkeys;
    // Look back 24h for wallet events, plus the NIP-17 ±2-day randomization
    // window for gift wraps. Without this, gift wraps whose created_at was
    // shifted more than 24h into the past would be invisible to the relay filter.
    filter.since = Math.floor(Date.now() / 1000) - 86400 - NIP17_TIMESTAMP_RANDOMIZATION;

    const events: NostrEvent[] = [];
    // Declared outside the Promise so it's available for cleanup after resolve.
    let subId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      // settle() only resolves the Promise — unsubscribe happens AFTER the Promise
      // resolves (below), where subId is guaranteed to be the real subscription ID.
      // This fixes a synchronous-EOSE race: if EOSE fires inside subscribe() before
      // the call returns, settle() is called with subId still undefined, so we must
      // not unsubscribe here.
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      try {
        subId = client.subscribe(filter, {
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
          onEndOfStoredEvents: () => settle(),
        });
      } catch (err) {
        reject(err);
        return;
      }

      if (!settled) {
        timeout = setTimeout(() => settle(), 5000);
      }
    });

    // Unsubscribe AFTER the Promise resolves — subId is now the real subscription ID.
    // This also ensures onEvent cannot fire while we iterate events below.
    if (subId) { try { client.unsubscribe(subId); } catch { /* disconnected */ } }

    // Process through mux dispatch chain (dedup handles already-seen events)
    for (const event of events) {
      await this.handleEvent(event);
    }

    logger.debug('Mux', `fetchPendingEvents: processed ${events.length} events`);
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // Relay Management
  // ===========================================================================

  getRelays(): string[] {
    return [...this.config.relays];
  }

  getConnectedRelays(): string[] {
    if (!this.nostrClient) return [];
    return Array.from(this.nostrClient.getConnectedRelays());
  }

  async addRelay(relayUrl: string): Promise<boolean> {
    if (this.config.relays.includes(relayUrl)) return false;
    this.config.relays.push(relayUrl);

    if (this.status === 'connected' && this.nostrClient) {
      try {
        await this.nostrClient.connect(relayUrl);
        this.emitEvent({ type: 'transport:relay_added', timestamp: Date.now(), data: { relay: relayUrl, connected: true } });
        return true;
      } catch (error) {
        this.emitEvent({ type: 'transport:relay_added', timestamp: Date.now(), data: { relay: relayUrl, connected: false, error: String(error) } });
        return false;
      }
    }
    return true;
  }

  async removeRelay(relayUrl: string): Promise<boolean> {
    const idx = this.config.relays.indexOf(relayUrl);
    if (idx === -1) return false;
    this.config.relays.splice(idx, 1);
    this.emitEvent({ type: 'transport:relay_removed', timestamp: Date.now(), data: { relay: relayUrl } });
    return true;
  }

  hasRelay(relayUrl: string): boolean {
    return this.config.relays.includes(relayUrl);
  }

  isRelayConnected(relayUrl: string): boolean {
    if (!this.nostrClient) return false;
    return this.nostrClient.getConnectedRelays().has(relayUrl);
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  /**
   * Update Nostr subscriptions to listen for events on ALL registered address pubkeys.
   * Called whenever addresses are added/removed.
   */
  private async updateSubscriptions(): Promise<void> {
    if (!this.nostrClient || this.addresses.size === 0) return;

    // Unsubscribe existing
    if (this.walletSubscriptionId) {
      this.nostrClient.unsubscribe(this.walletSubscriptionId);
      this.walletSubscriptionId = null;
    }
    if (this.chatSubscriptionId) {
      this.nostrClient.unsubscribe(this.chatSubscriptionId);
      this.chatSubscriptionId = null;
    }

    // Collect all pubkeys
    const allPubkeys: string[] = [];
    for (const entry of this.addresses.values()) {
      allPubkeys.push(entry.nostrPubkey);
    }

    logger.debug('Mux', `Subscribing for ${allPubkeys.length} address(es):`, allPubkeys.map(p => p.slice(0, 12)).join(', '));

    // Determine global 'since' for wallet and DM subscriptions in one pass.
    // Each address has independent stored timestamps; we take the minimum.
    let globalSince = Math.floor(Date.now() / 1000);
    let globalDmSince = Math.floor(Date.now() / 1000);
    const entries = [...this.addresses.values()];
    const sinceResults = await Promise.all(
      entries.map(async (entry) => {
        const [walletSince, dmSince] = await Promise.all([
          this.getAddressSince(entry),
          this.getAddressDmSince(entry),
        ]);
        return { walletSince, dmSince };
      }),
    );
    for (const { walletSince, dmSince } of sinceResults) {
      if (walletSince < globalSince) globalSince = walletSince;
      if (dmSince < globalDmSince) globalDmSince = dmSince;
    }

    // Subscribe to wallet events for ALL pubkeys
    const walletFilter = new Filter();
    walletFilter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
    ];
    walletFilter['#p'] = allPubkeys;
    walletFilter.since = globalSince;

    logger.warn('Mux', `updateSubscriptions: wallet filter kinds=${walletFilter.kinds} pubkeys=[${allPubkeys.map(p => p.slice(0,16)).join(',')}] since=${globalSince}`);

    this.walletSubscriptionId = this.nostrClient.subscribe(walletFilter, {
      onEvent: (event) => {
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
        logger.debug('Mux', 'Wallet subscription EOSE');
      },
      onError: (_subId, error) => {
        logger.warn('Mux', 'Wallet subscription closed by relay:', error);
        this.scheduleResubscribe();
      },
    });

    const chatFilter = new Filter();
    chatFilter.kinds = [EventKinds.GIFT_WRAP];
    chatFilter['#p'] = allPubkeys;
    // NIP-17 gift wraps use a randomized created_at (±2 days) for privacy.
    // Subtract the maximum randomization window so the relay returns events
    // whose actual send time is >= globalDmSince even if their created_at
    // was shifted backwards. processedEventIds dedup prevents re-processing.
    chatFilter.since = Math.max(0, globalDmSince - NIP17_TIMESTAMP_RANDOMIZATION);

    this.chatSubscriptionId = this.nostrClient.subscribe(chatFilter, {
      onEvent: (event) => {
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
        logger.debug('Mux', 'Chat subscription EOSE');
        if (!this.chatEoseFired) {
          this.chatEoseFired = true;
          for (const handler of this.chatEoseHandlers) {
            try { handler(); } catch { /* ignore */ }
          }
        }
      },
      onError: (_subId, error) => {
        logger.warn('Mux', 'Chat subscription closed by relay:', error);
        this.scheduleResubscribe();
      },
    });

    logger.warn('Mux', `updateSubscriptions: walletSub=${this.walletSubscriptionId} chatSub=${this.chatSubscriptionId}`);

    // Start subscription health check — if no events arrive for 90s,
    // the relay may have silently dropped our subscriptions without
    // sending CLOSED. Force re-subscribe to recover.
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      if (!this.isConnected()) return;
      // Check wallet subscription health separately from chat subscription.
      // DMs (gift wraps) keep the chat subscription alive, but the wallet
      // subscription (TOKEN_TRANSFER events) can die silently.
      const elapsed = Date.now() - this.lastWalletEventAt;
      if (elapsed > 60_000) {
        logger.warn('Mux', `No wallet events for ${Math.round(elapsed / 1000)}s — re-subscribing`);
        this.lastWalletEventAt = Date.now(); // prevent rapid re-subscribe
        this.updateSubscriptions().catch((err) => {
          logger.warn('Mux', 'Health check re-subscription failed:', err);
        });
      }
    }, 30_000);
  }

  /**
   * Schedule a re-subscription after a relay-initiated subscription closure.
   * Debounced: if both wallet and chat subscriptions fire onError in quick
   * succession, only one updateSubscriptions() call runs.
   */
  private scheduleResubscribe(): void {
    if (this.resubscribeTimer) return; // already scheduled
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (!this.isConnected()) return;
      logger.warn('Mux', 'Re-subscribing after relay-initiated subscription closure');
      this.updateSubscriptions().catch((err) => {
        logger.warn('Mux', 'Re-subscription failed:', err);
      });
    }, 2000);
  }

  /**
   * Determine 'since' timestamp for an address entry.
   */
  private async getAddressSince(entry: AddressEntry): Promise<number> {
    if (this.storage) {
      const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_WALLET_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;
      try {
        const stored = await this.storage.get(storageKey);
        if (stored) {
          const ts = parseInt(stored, 10);
          entry.lastEventTs = ts;
          entry.fallbackSince = null;
          return ts;
        } else if (entry.fallbackSince !== null) {
          const ts = entry.fallbackSince;
          entry.lastEventTs = ts;
          entry.fallbackSince = null;
          return ts;
        }
      } catch {
        // Fall through to default
      }
    }
    return Math.floor(Date.now() / 1000);
  }

  // ===========================================================================
  // Event Routing
  // ===========================================================================

  /**
   * Route an incoming Nostr event to the correct address adapter.
   */
  private async handleEvent(event: NostrEvent): Promise<void> {
    // Dedup
    if (event.id && this.processedEventIds.has(event.id)) return;
    if (event.id) this.processedEventIds.add(event.id);
    // Track wallet events (non-gift-wrap) for subscription health check.
    if (event.kind !== EventKinds.GIFT_WRAP) {
      this.lastWalletEventAt = Date.now();
    }

    try {
      if (event.kind === EventKinds.GIFT_WRAP) {
        // Gift wrap (NIP-17): must try decryption with each address's keyManager
        await this.routeGiftWrap(event);
      } else {
        // Wallet events: route by #p tag
        const recipientPubkey = this.extractRecipientPubkey(event);
        if (!recipientPubkey) {
          logger.debug('Mux', 'Event has no #p tag, dropping:', event.id?.slice(0, 12));
          return;
        }

        const addressIndex = this.pubkeyToIndex.get(recipientPubkey);
        if (addressIndex === undefined) {
          logger.debug('Mux', 'Event for unknown pubkey:', recipientPubkey.slice(0, 16), 'dropping');
          return;
        }

        const entry = this.addresses.get(addressIndex);
        if (!entry) return;

        await this.dispatchWalletEvent(entry, event);
      }
    } catch (error) {
      logger.debug('Mux', 'Failed to handle event:', event.id?.slice(0, 12), error);
    }
  }

  /**
   * Extract recipient pubkey from event's #p tag.
   * Returns the first #p value that matches a known address pubkey,
   * or the first #p value if none match.
   */
  private extractRecipientPubkey(event: NostrEvent): string | null {
    const pTags = event.tags?.filter(t => t[0] === 'p');
    if (!pTags || pTags.length === 0) return null;

    // Prefer a #p tag that matches a known address
    for (const tag of pTags) {
      if (tag[1] && this.pubkeyToIndex.has(tag[1])) {
        return tag[1];
      }
    }
    // Fallback: first #p tag
    return pTags[0]?.[1] ?? null;
  }

  /**
   * Route a gift wrap event by trying decryption with each address keyManager.
   */
  private async routeGiftWrap(event: NostrEvent): Promise<void> {
    for (const entry of this.addresses.values()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pm = NIP17.unwrap(event as any, entry.keyManager);

        // Successfully decrypted — route to this address.
        // Persist DM timestamp after successful unwrap so failed decryptions
        // do not advance the since filter and permanently skip events.
        // Use real wall-clock time, NOT event.created_at — NIP-17 gift wraps
        // randomize created_at by ±2 days for privacy, so it can be in the future.
        this.updateLastDmEventTimestamp(entry, Math.floor(Date.now() / 1000));
        logger.debug('Mux', `Gift wrap decrypted by address ${entry.index}, sender: ${pm.senderPubkey?.slice(0, 16)}`);

        // Handle self-wrap
        if (pm.senderPubkey === entry.nostrPubkey) {
          try {
            const parsed = JSON.parse(pm.content);
            if (parsed?.selfWrap && parsed.recipientPubkey) {
              // Skip self-wrapped read receipts and typing indicators (legacy bug)
              try {
                const innerParsed = typeof parsed.text === 'string' ? JSON.parse(parsed.text) : null;
                if (innerParsed?.type === 'read_receipt' || innerParsed?.type === 'typing') {
                  return;
                }
              } catch { /* not JSON inner, continue as message */ }

              // Parse inner JSON envelope (same as normal message handler)
              let selfWrapContent = parsed.text ?? '';
              let selfWrapNametag: string | undefined = parsed.senderNametag;
              try {
                const innerParsed = JSON.parse(selfWrapContent);
                if (typeof innerParsed === 'object' && innerParsed.text !== undefined) {
                  selfWrapContent = innerParsed.text;
                  selfWrapNametag = innerParsed.senderNametag || selfWrapNametag;
                }
              } catch { /* plain text */ }

              const message: IncomingMessage = {
                id: parsed.originalId || pm.eventId,
                senderTransportPubkey: pm.senderPubkey,
                senderNametag: selfWrapNametag,
                recipientTransportPubkey: parsed.recipientPubkey,
                content: selfWrapContent,
                timestamp: pm.timestamp * 1000,
                encrypted: true,
                isSelfWrap: true,
              };
              entry.adapter.dispatchMessage(message);
              return;
            }
          } catch {
            // Not JSON self-wrap
          }
          // Skip own non-self-wrap message
          return;
        }

        // Handle read receipts
        if (isReadReceipt(pm)) {
          if (pm.replyToEventId) {
            const receipt: IncomingReadReceipt = {
              senderTransportPubkey: pm.senderPubkey,
              messageEventId: pm.replyToEventId,
              timestamp: pm.timestamp * 1000,
            };
            entry.adapter.dispatchReadReceipt(receipt);
          }
          return;
        }

        // Handle composing indicators
        if (pm.kind === COMPOSING_INDICATOR_KIND) {
          let senderNametag: string | undefined;
          let expiresIn = 30000;
          try {
            const parsed = JSON.parse(pm.content);
            senderNametag = parsed.senderNametag || undefined;
            expiresIn = parsed.expiresIn ?? 30000;
          } catch { /* defaults */ }
          entry.adapter.dispatchComposingIndicator({
            senderPubkey: pm.senderPubkey,
            senderNametag,
            expiresIn,
          });
          return;
        }

        // Filter control messages sent as kind-14 (legacy bug — should use dedicated kinds)
        try {
          const parsed = JSON.parse(pm.content);
          if (parsed?.type === 'read_receipt' && parsed.messageEventId) {
            const receipt: IncomingReadReceipt = {
              senderTransportPubkey: pm.senderPubkey,
              messageEventId: parsed.messageEventId,
              timestamp: pm.timestamp * 1000,
            };
            entry.adapter.dispatchReadReceipt(receipt);
            return;
          }
          if (parsed?.type === 'typing') {
            const indicator: IncomingTypingIndicator = {
              senderTransportPubkey: pm.senderPubkey,
              senderNametag: parsed.senderNametag,
              timestamp: pm.timestamp * 1000,
            };
            entry.adapter.dispatchTypingIndicator(indicator);
            return;
          }
          if (parsed?.senderNametag !== undefined && parsed?.expiresIn !== undefined && !parsed?.text) {
            entry.adapter.dispatchComposingIndicator({
              senderPubkey: pm.senderPubkey,
              senderNametag: parsed.senderNametag || undefined,
              expiresIn: parsed.expiresIn ?? 30000,
            });
            return;
          }
        } catch { /* not JSON, continue */ }

        // Handle chat messages
        if (!isChatMessage(pm)) return;

        let content = pm.content;
        let senderNametag: string | undefined;
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed === 'object' && parsed.text !== undefined) {
            content = parsed.text;
            senderNametag = parsed.senderNametag || undefined;
          }
        } catch { /* plain text */ }

        const message: IncomingMessage = {
          id: event.id,
          senderTransportPubkey: pm.senderPubkey,
          senderNametag,
          content,
          timestamp: pm.timestamp * 1000,
          encrypted: true,
        };

        entry.adapter.dispatchMessage(message);
        return; // Successfully routed, stop trying other addresses
      } catch {
        // Decryption failed for this address — try next
        continue;
      }
    }
    // None could decrypt — expected for events not meant for us
    logger.debug('Mux', 'Gift wrap could not be decrypted by any address');
  }

  /**
   * Dispatch a wallet event (non-gift-wrap) to the correct address adapter.
   */
  private async dispatchWalletEvent(entry: AddressEntry, event: NostrEvent): Promise<void> {
    switch (event.kind) {
      case EVENT_KINDS.DIRECT_MESSAGE:
        // NIP-04 kind 4 is deprecated for DMs, ignore
        break;

      case EVENT_KINDS.TOKEN_TRANSFER:
        await this.handleTokenTransfer(entry, event);
        break;

      case EVENT_KINDS.PAYMENT_REQUEST:
        await this.handlePaymentRequest(entry, event);
        break;

      case EVENT_KINDS.PAYMENT_REQUEST_RESPONSE:
        await this.handlePaymentRequestResponse(entry, event);
        break;
    }

    // Update last event timestamp for this address
    if (event.created_at) {
      this.updateLastEventTimestamp(entry, event.created_at);
    }
  }

  private async handleTokenTransfer(entry: AddressEntry, event: NostrEvent): Promise<void> {
    try {
      const content = await this.decryptContent(entry, event.content, event.pubkey);
      const payload = JSON.parse(content) as TokenTransferPayload;

      const transfer: IncomingTokenTransfer = {
        id: event.id,
        senderTransportPubkey: event.pubkey,
        payload,
        timestamp: event.created_at * 1000,
      };

      entry.adapter.dispatchTokenTransfer(transfer);
    } catch (err) {
      logger.debug('Mux', `Token transfer decrypt failed for address ${entry.index}:`, (err as Error)?.message?.slice(0, 50));
    }
  }

  private async handlePaymentRequest(entry: AddressEntry, event: NostrEvent): Promise<void> {
    try {
      const content = await this.decryptContent(entry, event.content, event.pubkey);
      const requestData = JSON.parse(content);

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

      entry.adapter.dispatchPaymentRequest(request);
    } catch (err) {
      logger.debug('Mux', `Payment request decrypt failed for address ${entry.index}:`, (err as Error)?.message?.slice(0, 50));
    }
  }

  private async handlePaymentRequestResponse(entry: AddressEntry, event: NostrEvent): Promise<void> {
    try {
      const content = await this.decryptContent(entry, event.content, event.pubkey);
      const responseData = JSON.parse(content);

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

      entry.adapter.dispatchPaymentRequestResponse(response);
    } catch (err) {
      logger.debug('Mux', `Payment response decrypt failed for address ${entry.index}:`, (err as Error)?.message?.slice(0, 50));
    }
  }

  // ===========================================================================
  // Crypto Helpers
  // ===========================================================================

  private async decryptContent(entry: AddressEntry, content: string, senderPubkey: string): Promise<string> {
    const decrypted = await NIP04.decryptHex(
      content,
      entry.keyManager.getPrivateKeyHex(),
      senderPubkey
    );
    return this.stripContentPrefix(decrypted);
  }

  private stripContentPrefix(content: string): string {
    const prefixes = ['payment_request:', 'token_transfer:', 'payment_response:'];
    for (const prefix of prefixes) {
      if (content.startsWith(prefix)) return content.slice(prefix.length);
    }
    return content;
  }

  // ===========================================================================
  // Sending (called by adapters)
  // ===========================================================================

  /**
   * Create an encrypted event using a specific address's keyManager.
   * Used by AddressTransportAdapter for sending.
   */
  async createAndPublishEncryptedEvent(
    addressIndex: number,
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<string> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    // Extract recipient pubkey from tags
    const recipientTag = tags.find(t => t[0] === 'p');
    if (!recipientTag?.[1]) throw new SphereError('No recipient pubkey in tags', 'VALIDATION_ERROR');

    // Encrypt with this address's keyManager
    const encrypted = await NIP04.encryptHex(
      content,
      entry.keyManager.getPrivateKeyHex(),
      recipientTag[1]
    );

    // Create and sign event
    const signedEvent = NostrEventClass.create(entry.keyManager, { kind, content: encrypted, tags });
    const nostrEvent = NostrEventClass.fromJSON({
      id: signedEvent.id, kind: signedEvent.kind, content: signedEvent.content,
      tags: signedEvent.tags, pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at, sig: signedEvent.sig,
    });
    await this.nostrClient.publishEvent(nostrEvent);
    return signedEvent.id;
  }

  /**
   * Create and publish a NIP-17 gift wrap message for a specific address.
   */
  async sendGiftWrap(
    addressIndex: number,
    recipientPubkey: string,
    content: string
  ): Promise<string> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    // NIP-17 requires 32-byte x-only pubkey
    const nostrRecipient = recipientPubkey.length === 66 &&
      (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    const giftWrap = NIP17.createGiftWrap(entry.keyManager, nostrRecipient, content);
    const giftWrapEvent = NostrEventClass.fromJSON(giftWrap);
    await this.nostrClient.publishEvent(giftWrapEvent);

    // Self-wrap for relay replay
    const selfPubkey = entry.keyManager.getPublicKeyHex();
    const senderNametag = entry.identity.nametag;
    const selfWrapContent = JSON.stringify({
      selfWrap: true,
      originalId: giftWrap.id,
      recipientPubkey,
      senderNametag,
      text: content,
    });
    const selfGiftWrap = NIP17.createGiftWrap(entry.keyManager, selfPubkey, selfWrapContent);
    const selfGiftWrapEvent = NostrEventClass.fromJSON(selfGiftWrap);
    this.nostrClient.publishEvent(selfGiftWrapEvent).catch((err: unknown) => {
      logger.debug('Mux', 'Self-wrap publish failed:', err);
    });

    return giftWrap.id;
  }

  /**
   * Send a NIP-17 read receipt (kind 15) for a specific address.
   */
  async sendReadReceipt(addressIndex: number, recipientPubkey: string, messageEventId: string): Promise<void> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    const nostrRecipient = recipientPubkey.length === 66 &&
      (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    const event = NIP17.createReadReceipt(entry.keyManager, nostrRecipient, messageEventId);
    const giftWrapEvent = NostrEventClass.fromJSON(event);
    await this.nostrClient.publishEvent(giftWrapEvent);
    logger.debug('Mux', `Sent read receipt for ${messageEventId} to ${nostrRecipient.slice(0, 16)}`);
  }

  /**
   * Send a composing indicator (kind 25050) gift wrap for a specific address.
   */
  async sendComposingIndicator(addressIndex: number, recipientPubkey: string, content: string): Promise<void> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    const nostrRecipient = recipientPubkey.length === 66 &&
      (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    const giftWrap = NostrTransportProvider.createCustomKindGiftWrap(entry.keyManager, nostrRecipient, content, COMPOSING_INDICATOR_KIND);
    const giftWrapEvent = NostrEventClass.fromJSON(giftWrap);
    await this.nostrClient.publishEvent(giftWrapEvent);
  }

  /**
   * Publish a raw event (e.g., identity binding, broadcast).
   */
  async publishRawEvent(addressIndex: number, kind: number, content: string, tags: string[][]): Promise<string> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    const signedEvent = NostrEventClass.create(entry.keyManager, { kind, content, tags });
    const nostrEvent = NostrEventClass.fromJSON({
      id: signedEvent.id, kind: signedEvent.kind, content: signedEvent.content,
      tags: signedEvent.tags, pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at, sig: signedEvent.sig,
    });
    await this.nostrClient.publishEvent(nostrEvent);
    return signedEvent.id;
  }

  // ===========================================================================
  // Resolve Methods (delegates to inner — these are stateless relay queries)
  // ===========================================================================

  /**
   * Get the NostrClient for resolve operations.
   * Adapters use this for resolve*, publishIdentityBinding, etc.
   */
  getNostrClient(): NostrClient | null {
    return this.nostrClient;
  }

  /**
   * Get keyManager for a specific address (used by adapters for resolve/binding).
   */
  getKeyManager(addressIndex: number): NostrKeyManager | null {
    return this.addresses.get(addressIndex)?.keyManager ?? null;
  }

  /**
   * Get identity for a specific address.
   */
  getIdentity(addressIndex: number): FullIdentity | null {
    return this.addresses.get(addressIndex)?.identity ?? null;
  }

  // ===========================================================================
  // Event timestamp persistence
  // ===========================================================================

  private updateLastEventTimestamp(entry: AddressEntry, createdAt: number): void {
    if (!this.storage) return;
    if (createdAt <= entry.lastEventTs) return;

    entry.lastEventTs = createdAt;
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_WALLET_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;

    this.storage.set(storageKey, createdAt.toString()).catch(err => {
      logger.debug('Mux', 'Failed to save last event timestamp:', err);
    });
  }

  private updateLastDmEventTimestamp(entry: AddressEntry, createdAt: number): void {
    if (!this.storage) return;
    if (createdAt <= entry.lastDmEventTs) return;

    entry.lastDmEventTs = createdAt;
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;

    this.storage.set(storageKey, createdAt.toString()).catch(err => {
      logger.debug('Mux', 'Failed to save last DM event timestamp:', err);
    });
  }

  private async getAddressDmSince(entry: AddressEntry): Promise<number> {
    if (this.storage) {
      const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;
      try {
        const stored = await this.storage.get(storageKey);
        const parsed = stored ? parseInt(stored, 10) : NaN;
        if (Number.isFinite(parsed)) {
          entry.lastDmEventTs = parsed;
          entry.fallbackDmSince = null; // Stored value takes priority
          return parsed;
        } else if (entry.fallbackDmSince !== null) {
          const ts = entry.fallbackDmSince;
          entry.lastDmEventTs = ts;
          entry.fallbackDmSince = null; // Consume once
          return ts;
        }
      } catch {
        if (entry.fallbackDmSince !== null) {
          const ts = entry.fallbackDmSince;
          entry.lastDmEventTs = ts;
          entry.fallbackDmSince = null;
          return ts;
        }
      }
    } else if (entry.fallbackDmSince !== null) {
      const ts = entry.fallbackDmSince;
      entry.lastDmEventTs = ts;
      entry.fallbackDmSince = null;
      return ts;
    }
    // No storage, no fallback — start from now (no historical replay)
    return Math.floor(Date.now() / 1000);
  }

  // ===========================================================================
  // Mux-level event system
  // ===========================================================================

  onTransportEvent(callback: TransportEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  onChatReady(handler: () => void): () => void {
    if (this.chatEoseFired) {
      try { handler(); } catch { /* ignore */ }
      return () => {};
    }
    this.chatEoseHandlers.push(handler);
    return () => {
      const idx = this.chatEoseHandlers.indexOf(handler);
      if (idx >= 0) this.chatEoseHandlers.splice(idx, 1);
    };
  }

  private emitEvent(event: TransportEvent): void {
    for (const cb of this.eventCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
    // Also forward to all adapters
    for (const entry of this.addresses.values()) {
      entry.adapter.emitTransportEvent(event);
    }
  }

  // ===========================================================================
  // Dedup Management
  // ===========================================================================

  /**
   * Clear processed event IDs (e.g., on address change or periodic cleanup).
   */
  clearProcessedEvents(): void {
    this.processedEventIds.clear();
  }

  /**
   * Get the storage adapter (for adapters that need it).
   */
  getStorage(): TransportStorageAdapter | null {
    return this.storage;
  }

  /**
   * Get the UUID generator.
   */
  getUUIDGenerator(): UUIDGenerator {
    return this.config.generateUUID;
  }
}

// =============================================================================
// AddressTransportAdapter
// =============================================================================

/**
 * Lightweight TransportProvider implementation for a single address.
 * Does NOT own a WebSocket — delegates to MultiAddressTransportMux.
 * Each per-address module (PaymentsModule, CommunicationsModule) uses one of these.
 */
export class AddressTransportAdapter implements TransportProvider {
  readonly id: string;
  readonly name: string;
  readonly type = 'p2p' as const;
  readonly description: string;

  private mux: MultiAddressTransportMux;
  private addressIndex: number;
  private identity: FullIdentity;
  private resolveDelegate: TransportProvider | null;

  // Per-address handler sets
  private messageHandlers: Set<MessageHandler> = new Set();
  private transferHandlers: Set<TokenTransferHandler> = new Set();
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private readReceiptHandlers: Set<ReadReceiptHandler> = new Set();
  private typingIndicatorHandlers: Set<TypingIndicatorHandler> = new Set();
  private composingHandlers: Set<ComposingHandler> = new Set();
  private instantSplitBundleHandlers: Set<InstantSplitBundleHandler> = new Set();
  private broadcastHandlers: Map<string, Set<BroadcastHandler>> = new Map();
  private eventCallbacks: Set<TransportEventCallback> = new Set();
  private pendingMessages: IncomingMessage[] = [];
  private chatEoseHandlers: Array<() => void> = [];

  constructor(
    mux: MultiAddressTransportMux,
    addressIndex: number,
    identity: FullIdentity,
    resolveDelegate?: TransportProvider | null,
  ) {
    this.mux = mux;
    this.addressIndex = addressIndex;
    this.identity = identity;
    this.resolveDelegate = resolveDelegate ?? null;
    this.id = `nostr-addr-${addressIndex}`;
    this.name = `Nostr Transport (address ${addressIndex})`;
    this.description = `P2P messaging for address index ${addressIndex}`;
  }

  // ===========================================================================
  // BaseProvider — delegates to mux
  // ===========================================================================

  async connect(): Promise<void> {
    await this.mux.connect();
  }

  async disconnect(): Promise<void> {
    // Individual adapters don't disconnect the shared transport
    // Use mux.disconnect() to close the connection
  }

  isConnected(): boolean {
    return this.mux.isConnected();
  }

  getStatus(): ProviderStatus {
    return this.mux.getStatus();
  }

  // ===========================================================================
  // Identity (no-op — mux manages identity via addAddress)
  // ===========================================================================

  async setIdentity(identity: FullIdentity): Promise<void> {
    this.identity = identity;
    // Mux handles re-subscription
    await this.mux.addAddress(this.addressIndex, identity);
  }

  // ===========================================================================
  // Sending — delegates to mux with this address's keyManager
  // ===========================================================================

  async sendMessage(recipientPubkey: string, content: string): Promise<string> {
    const senderNametag = this.identity.nametag;
    const wrappedContent = senderNametag
      ? JSON.stringify({ senderNametag, text: content })
      : content;

    return this.mux.sendGiftWrap(this.addressIndex, recipientPubkey, wrappedContent);
  }

  async sendTokenTransfer(recipientPubkey: string, payload: TokenTransferPayload): Promise<string> {
    const content = 'token_transfer:' + JSON.stringify(payload);
    const uniqueD = `token-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [['p', recipientPubkey], ['d', uniqueD], ['type', 'token_transfer']]
    );
  }

  async sendPaymentRequest(recipientPubkey: string, payload: PaymentRequestPayload): Promise<string> {
    const requestId = this.mux.getUUIDGenerator()();
    const amount = typeof payload.amount === 'bigint' ? payload.amount.toString() : payload.amount;
    const requestContent = {
      requestId,
      amount,
      coinId: payload.coinId,
      message: payload.message,
      recipientNametag: payload.recipientNametag,
      deadline: Date.now() + 5 * 60 * 1000,
    };
    const content = 'payment_request:' + JSON.stringify(requestContent);
    const tags: string[][] = [
      ['p', recipientPubkey],
      ['type', 'payment_request'],
      ['amount', amount],
    ];
    if (payload.recipientNametag) {
      tags.push(['recipient', payload.recipientNametag]);
    }
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.PAYMENT_REQUEST,
      content,
      tags
    );
  }

  async sendPaymentRequestResponse(
    recipientPubkey: string,
    response: PaymentRequestResponsePayload
  ): Promise<string> {
    const content = 'payment_response:' + JSON.stringify(response);
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      content,
      [['p', recipientPubkey], ['type', 'payment_response']]
    );
  }

  async sendReadReceipt(recipientPubkey: string, messageEventId: string): Promise<void> {
    // Read receipts must use NIP-17 kind 15 (not regular gift wrap kind 14)
    await this.mux.sendReadReceipt(this.addressIndex, recipientPubkey, messageEventId);
  }

  async sendTypingIndicator(recipientPubkey: string): Promise<void> {
    // Typing indicators use composing kind 25050
    const content = JSON.stringify({
      type: 'typing',
      senderNametag: this.identity.nametag,
    });
    await this.mux.sendComposingIndicator(this.addressIndex, recipientPubkey, content);
  }

  async sendComposingIndicator(recipientPubkey: string, content: string): Promise<void> {
    // Composing indicators must use kind 25050 (not regular gift wrap kind 14)
    await this.mux.sendComposingIndicator(this.addressIndex, recipientPubkey, content);
  }

  async sendInstantSplitBundle(
    recipientPubkey: string,
    bundle: InstantSplitBundlePayload
  ): Promise<string> {
    const content = 'token_transfer:' + JSON.stringify({
      type: 'instant_split',
      ...bundle,
    });
    const uniqueD = `instant-split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [['p', recipientPubkey], ['d', uniqueD], ['type', 'instant_split']]
    );
  }

  // ===========================================================================
  // Subscription handlers — per-address
  // ===========================================================================

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    // Flush pending
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      for (const msg of pending) {
        try { handler(msg); } catch { /* ignore */ }
      }
    }
    return () => this.messageHandlers.delete(handler);
  }

  onTokenTransfer(handler: TokenTransferHandler): () => void {
    this.transferHandlers.add(handler);
    return () => this.transferHandlers.delete(handler);
  }

  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    this.paymentRequestHandlers.add(handler);
    return () => this.paymentRequestHandlers.delete(handler);
  }

  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    this.paymentRequestResponseHandlers.add(handler);
    return () => this.paymentRequestResponseHandlers.delete(handler);
  }

  onReadReceipt(handler: ReadReceiptHandler): () => void {
    this.readReceiptHandlers.add(handler);
    return () => this.readReceiptHandlers.delete(handler);
  }

  onTypingIndicator(handler: TypingIndicatorHandler): () => void {
    this.typingIndicatorHandlers.add(handler);
    return () => this.typingIndicatorHandlers.delete(handler);
  }

  onComposing(handler: ComposingHandler): () => void {
    this.composingHandlers.add(handler);
    return () => this.composingHandlers.delete(handler);
  }

  onInstantSplitReceived(handler: InstantSplitBundleHandler): () => void {
    this.instantSplitBundleHandlers.add(handler);
    return () => this.instantSplitBundleHandlers.delete(handler);
  }

  subscribeToBroadcast(tags: string[], handler: BroadcastHandler): () => void {
    const key = tags.sort().join(':');
    if (!this.broadcastHandlers.has(key)) {
      this.broadcastHandlers.set(key, new Set());
    }
    this.broadcastHandlers.get(key)!.add(handler);
    return () => this.broadcastHandlers.get(key)?.delete(handler);
  }

  async publishBroadcast(content: string, tags?: string[]): Promise<string> {
    // Broadcasts are not encrypted, use raw event
    const eventTags: string[][] = tags ? tags.map(t => ['t', t]) : [];
    return this.mux.publishRawEvent(this.addressIndex, 30023, content, eventTags);
  }

  // ===========================================================================
  // Resolve methods — delegate to original NostrTransportProvider
  // These are stateless relay queries, shared across all addresses
  // ===========================================================================

  async resolve(identifier: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolve?.(identifier) ?? null;
  }

  async resolveNametag(nametag: string): Promise<string | null> {
    return this.resolveDelegate?.resolveNametag?.(nametag) ?? null;
  }

  async resolveNametagInfo(nametag: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolveNametagInfo?.(nametag) ?? null;
  }

  async resolveAddressInfo(address: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolveAddressInfo?.(address) ?? null;
  }

  async resolveTransportPubkeyInfo(transportPubkey: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolveTransportPubkeyInfo?.(transportPubkey) ?? null;
  }

  async discoverAddresses(transportPubkeys: string[]): Promise<PeerInfo[]> {
    return this.resolveDelegate?.discoverAddresses?.(transportPubkeys) ?? [];
  }

  async recoverNametag(): Promise<string | null> {
    // recoverNametag is identity-specific — uses the adapter's keyManager
    // For now, delegate to original transport (which must have correct identity set)
    return this.resolveDelegate?.recoverNametag?.() ?? null;
  }

  async publishIdentityBinding(
    chainPubkey: string,
    l1Address: string,
    directAddress: string,
    nametag?: string,
  ): Promise<boolean> {
    return this.resolveDelegate?.publishIdentityBinding?.(chainPubkey, l1Address, directAddress, nametag) ?? false;
  }

  // ===========================================================================
  // Relay Management — delegates to mux
  // ===========================================================================

  getRelays(): string[] { return this.mux.getRelays(); }
  getConnectedRelays(): string[] { return this.mux.getConnectedRelays(); }
  async addRelay(relayUrl: string): Promise<boolean> { return this.mux.addRelay(relayUrl); }
  async removeRelay(relayUrl: string): Promise<boolean> { return this.mux.removeRelay(relayUrl); }
  hasRelay(relayUrl: string): boolean { return this.mux.hasRelay(relayUrl); }
  isRelayConnected(relayUrl: string): boolean { return this.mux.isRelayConnected(relayUrl); }

  setFallbackSince(sinceSeconds: number): void {
    this.mux.setFallbackSince(this.addressIndex, sinceSeconds);
  }

  setFallbackDmSince(sinceSeconds: number): void {
    this.mux.setFallbackDmSince(this.addressIndex, sinceSeconds);
  }

  async fetchPendingEvents(): Promise<void> {
    // Fetching is handled by subscription — no-op for mux-based adapters
    // The mux subscription already includes this address's pubkey
  }

  onChatReady(handler: () => void): () => void {
    return this.mux.onChatReady(handler);
  }

  // ===========================================================================
  // Dispatch methods — called by MultiAddressTransportMux to route events
  // ===========================================================================

  dispatchMessage(message: IncomingMessage): void {
    if (this.messageHandlers.size === 0) {
      this.pendingMessages.push(message);
      return;
    }
    for (const handler of this.messageHandlers) {
      try { handler(message); } catch (e) { logger.debug('MuxAdapter', 'Message handler error:', e); }
    }
  }

  dispatchTokenTransfer(transfer: IncomingTokenTransfer): void {
    for (const handler of this.transferHandlers) {
      try { handler(transfer); } catch (e) { logger.debug('MuxAdapter', 'Transfer handler error:', e); }
    }
  }

  dispatchPaymentRequest(request: IncomingPaymentRequest): void {
    for (const handler of this.paymentRequestHandlers) {
      try { handler(request); } catch (e) { logger.debug('MuxAdapter', 'Payment request handler error:', e); }
    }
  }

  dispatchPaymentRequestResponse(response: IncomingPaymentRequestResponse): void {
    for (const handler of this.paymentRequestResponseHandlers) {
      try { handler(response); } catch (e) { logger.debug('MuxAdapter', 'Payment response handler error:', e); }
    }
  }

  dispatchReadReceipt(receipt: IncomingReadReceipt): void {
    for (const handler of this.readReceiptHandlers) {
      try { handler(receipt); } catch (e) { logger.debug('MuxAdapter', 'Read receipt handler error:', e); }
    }
  }

  dispatchTypingIndicator(indicator: IncomingTypingIndicator): void {
    for (const handler of this.typingIndicatorHandlers) {
      try { handler(indicator); } catch (e) { logger.debug('MuxAdapter', 'Typing handler error:', e); }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchComposingIndicator(indicator: any): void {
    for (const handler of this.composingHandlers) {
      try { handler(indicator); } catch (e) { logger.debug('MuxAdapter', 'Composing handler error:', e); }
    }
  }

  dispatchInstantSplitBundle(bundle: IncomingInstantSplitBundle): void {
    for (const handler of this.instantSplitBundleHandlers) {
      try { handler(bundle); } catch (e) { logger.debug('MuxAdapter', 'Instant split handler error:', e); }
    }
  }

  emitTransportEvent(event: TransportEvent): void {
    for (const cb of this.eventCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }
}
