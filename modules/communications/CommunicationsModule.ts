/**
 * Communications Module
 * Platform-independent messaging operations
 */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { createTransportAddressResolver, type TransportAddressResolver } from '../../core/transport-resolver';
import type {
  DirectMessage,
  BroadcastMessage,
  ComposingIndicator,
  FullIdentity,
  SphereEventType,
  SphereEventMap,
} from '../../types';
import type { StorageProvider } from '../../storage';
import type { TransportProvider, IncomingMessage, IncomingBroadcast } from '../../transport';
import { STORAGE_KEYS_ADDRESS } from '../../constants';

// =============================================================================
// Configuration
// =============================================================================

export interface CommunicationsModuleConfig {
  /** Auto-save messages */
  autoSave?: boolean;
  /** Max messages in memory (global cap) */
  maxMessages?: number;
  /** Max messages per conversation (default: 200) */
  maxPerConversation?: number;
  /** Enable read receipts */
  readReceipts?: boolean;
  /** Cache messages in memory and storage (default: true).
   *  When false, DMs flow through onDirectMessage handlers and events
   *  but are never stored. Useful for anonymous/ephemeral agents.
   *  Note: deduplication is skipped when caching is disabled, so duplicate
   *  events may occur if the relay delivers the same message twice. */
  cacheMessages?: boolean;
}

// =============================================================================
// Pagination Types
// =============================================================================

export interface ConversationPage {
  messages: DirectMessage[];
  hasMore: boolean;
  oldestTimestamp: number | null;
}

export interface GetConversationPageOptions {
  /** Max messages to return (default: 20) */
  limit?: number;
  /** Return messages older than this timestamp */
  before?: number;
}

// =============================================================================
// Dependencies Interface
// =============================================================================

export interface CommunicationsModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  transport: TransportProvider;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
}

// =============================================================================
// Implementation
// =============================================================================

export class CommunicationsModule {
  private config: Required<CommunicationsModuleConfig>;
  private deps: CommunicationsModuleDependencies | null = null;

  // State
  private messages: Map<string, DirectMessage> = new Map();
  private broadcasts: Map<string, BroadcastMessage> = new Map();

  // Subscriptions
  private unsubscribeMessages: (() => void) | null = null;
  private unsubscribeComposing: (() => void) | null = null;
  private broadcastSubscriptions: Map<string, () => void> = new Map();

  // Handlers
  private dmHandlers: Set<(message: DirectMessage) => void> = new Set();
  private replayedHandlers: WeakSet<(message: DirectMessage) => void> = new WeakSet();
  private composingHandlers: Set<(indicator: ComposingIndicator) => void> = new Set();
  private broadcastHandlers: Set<(message: BroadcastMessage) => void> = new Set();

  // Timestamp of module initialization — messages older than this are historical
  private initializedAt: number = 0;

  /** Shared transport address resolver (with cache). Created during initialize(). */
  private transportResolver: TransportAddressResolver | null = null;

  constructor(config?: CommunicationsModuleConfig) {
    this.config = {
      autoSave: config?.autoSave ?? true,
      maxMessages: config?.maxMessages ?? 1000,
      maxPerConversation: config?.maxPerConversation ?? 200,
      readReceipts: config?.readReceipts ?? true,
      cacheMessages: config?.cacheMessages ?? true,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Initialize module with dependencies
   */
  initialize(deps: CommunicationsModuleDependencies): void {
    // Clean up previous subscriptions before re-initializing
    this.unsubscribeMessages?.();
    this.unsubscribeComposing?.();

    this.deps = deps;
    this.initializedAt = Date.now();

    // Create shared transport address resolver (used by sendDM, sendComposingIndicator, etc.)
    this.transportResolver = createTransportAddressResolver(deps.transport);

    // Subscribe to incoming messages
    this.unsubscribeMessages = deps.transport.onMessage((msg) => {
      this.handleIncomingMessage(msg);
    });

    // Subscribe to incoming read receipts
    if (deps.transport.onReadReceipt) {
      deps.transport.onReadReceipt((receipt) => {
        const msg = this.messages.get(receipt.messageEventId);
        // Only process if this is our own sent message being read by the recipient
        if (msg && msg.senderPubkey === this.deps!.identity.chainPubkey) {
          msg.isRead = true;
          this.save();
          this.deps!.emitEvent('message:read', {
            messageIds: [receipt.messageEventId],
            peerPubkey: receipt.senderTransportPubkey,
          });
        }
      });
    }

    // Subscribe to incoming typing indicators
    if (deps.transport.onTypingIndicator) {
      deps.transport.onTypingIndicator((indicator) => {
        this.deps!.emitEvent('message:typing', {
          senderPubkey: indicator.senderTransportPubkey,
          senderNametag: indicator.senderNametag,
          timestamp: indicator.timestamp,
        });
      });
    }

    // Subscribe to composing indicators
    this.unsubscribeComposing = deps.transport.onComposing?.((indicator) => {
      this.handleComposingIndicator(indicator);
    }) ?? null;

    // Emit ready event when relay EOSE fires (historical DMs delivered)
    if (deps.transport.onChatReady) {
      deps.transport.onChatReady(() => {
        const conversations = this.getConversations();
        deps.emitEvent('communications:ready', { conversationCount: conversations.size });
      });
    }
  }

  /**
   * Load messages from storage.
   * Uses per-address key (STORAGE_KEYS_ADDRESS.MESSAGES) which is automatically
   * scoped by LocalStorageProvider to sphere_DIRECT_xxx_yyy_messages.
   * Falls back to legacy global 'direct_messages' key for migration.
   */
  async load(): Promise<void> {
    if (!this.config.cacheMessages) return;
    this.ensureInitialized();

    // Always clear in-memory state before loading new address data.
    // Without this, switching to an address with no stored messages
    // would leave the previous address's messages visible.
    this.messages.clear();

    // Try per-address key first
    let data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.MESSAGES);

    if (data) {
      const messages = JSON.parse(data) as DirectMessage[];
      for (const msg of messages) {
        this.messages.set(msg.id, msg);
      }
      return;
    }

    // Migration: fall back to legacy global key, filter for current identity
    data = await this.deps!.storage.get('direct_messages');
    if (data) {
      const allMessages = JSON.parse(data) as DirectMessage[];
      const myPubkey = this.deps!.identity.chainPubkey;
      const myMessages = allMessages.filter(
        (m) => m.senderPubkey === myPubkey || m.recipientPubkey === myPubkey,
      );

      for (const msg of myMessages) {
        this.messages.set(msg.id, msg);
      }

      // Persist to new per-address key
      if (myMessages.length > 0) {
        await this.save();
        logger.debug('Communications', `Migrated ${myMessages.length} messages to per-address storage`);
      }
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.unsubscribeMessages?.();
    this.unsubscribeMessages = null;

    this.unsubscribeComposing?.();
    this.unsubscribeComposing = null;

    for (const unsub of this.broadcastSubscriptions.values()) {
      unsub();
    }
    this.broadcastSubscriptions.clear();
  }

  // ===========================================================================
  // Public API - Direct Messages
  // ===========================================================================

  /**
   * Send direct message
   */
  async sendDM(recipient: string, content: string): Promise<DirectMessage> {
    this.ensureInitialized();

    // Resolve recipient
    const resolved = await this.resolveRecipient(recipient);

    // Send via transport
    const eventId = await this.deps!.transport.sendMessage(resolved.pubkey, content);

    // Create message record
    // isRead=false for sent messages means "not yet read by recipient".
    // Set to true when a read receipt arrives.
    const message: DirectMessage = {
      id: eventId,
      senderPubkey: this.deps!.identity.chainPubkey,
      senderNametag: this.deps!.identity.nametag,
      recipientPubkey: resolved.pubkey,
      ...(resolved.nametag ? { recipientNametag: resolved.nametag } : {}),
      content,
      timestamp: Date.now(),
      isRead: false,
    };

    // Cache and save (skipped when cacheMessages is false)
    if (this.config.cacheMessages) {
      this.messages.set(message.id, message);
      if (this.config.autoSave) {
        await this.save();
      }
    }

    return message;
  }

  /**
   * Get conversation with peer.
   * Normalizes the key to x-only format so lookups work regardless of whether
   * the caller passes a compressed (02.../03...) or x-only (64-char) pubkey.
   */
  getConversation(peerPubkey: string): DirectMessage[] {
    const normalized = CommunicationsModule._normalizeKey(peerPubkey);
    return Array.from(this.messages.values())
      .filter(
        (m) =>
          CommunicationsModule._normalizeKey(m.senderPubkey) === normalized ||
          CommunicationsModule._normalizeKey(m.recipientPubkey) === normalized
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all conversations grouped by peer.
   * Keys are normalized to x-only format so compressed and x-only pubkeys
   * map to the same conversation.
   */
  getConversations(): Map<string, DirectMessage[]> {
    const conversations = new Map<string, DirectMessage[]>();
    const ownKey = CommunicationsModule._normalizeKey(this.deps?.identity.chainPubkey ?? '');

    for (const message of this.messages.values()) {
      const rawPeer =
        CommunicationsModule._normalizeKey(message.senderPubkey) === ownKey
          ? message.recipientPubkey
          : message.senderPubkey;
      const peer = CommunicationsModule._normalizeKey(rawPeer);

      if (!conversations.has(peer)) {
        conversations.set(peer, []);
      }
      conversations.get(peer)!.push(message);
    }

    // Sort each conversation
    for (const msgs of conversations.values()) {
      msgs.sort((a, b) => a.timestamp - b.timestamp);
    }

    return conversations;
  }

  /**
   * Mark messages as read
   */
  async markAsRead(messageIds: string[]): Promise<void> {
    for (const id of messageIds) {
      const msg = this.messages.get(id);
      if (msg) {
        msg.isRead = true;
      }
    }

    if (this.config.cacheMessages && this.config.autoSave) {
      await this.save();
    }

    // Send NIP-17 read receipts for incoming messages
    if (this.config.readReceipts && this.deps?.transport.sendReadReceipt) {
      for (const id of messageIds) {
        const msg = this.messages.get(id);
        if (msg && msg.senderPubkey !== this.deps.identity.chainPubkey) {
          this.deps.transport.sendReadReceipt(msg.senderPubkey, id).catch((err) => {
            logger.warn('Communications', 'Failed to send read receipt:', err);
          });
        }
      }
    }
  }

  /**
   * Get unread count
   */
  getUnreadCount(peerPubkey?: string): number {
    const ownKey = CommunicationsModule._normalizeKey(this.deps?.identity.chainPubkey ?? '');
    let messages = Array.from(this.messages.values()).filter(
      (m) => !m.isRead && CommunicationsModule._normalizeKey(m.senderPubkey) !== ownKey
    );

    if (peerPubkey) {
      const normalized = CommunicationsModule._normalizeKey(peerPubkey);
      messages = messages.filter((m) => CommunicationsModule._normalizeKey(m.senderPubkey) === normalized);
    }

    return messages.length;
  }

  /**
   * Get a page of messages from a conversation (for lazy loading).
   * Returns messages in chronological order with a cursor for loading older messages.
   */
  getConversationPage(peerPubkey: string, options?: GetConversationPageOptions): ConversationPage {
    const limit = options?.limit ?? 20;
    const before = options?.before ?? Infinity;
    const normalized = CommunicationsModule._normalizeKey(peerPubkey);

    const all = Array.from(this.messages.values())
      .filter(
        (m) =>
          (CommunicationsModule._normalizeKey(m.senderPubkey) === normalized ||
           CommunicationsModule._normalizeKey(m.recipientPubkey) === normalized) &&
          m.timestamp < before,
      )
      .sort((a, b) => b.timestamp - a.timestamp); // newest first for slicing

    const page = all.slice(0, limit);
    return {
      messages: page.reverse(), // chronological order for display
      hasMore: all.length > limit,
      oldestTimestamp: page.length > 0 ? page[0].timestamp : null,
    };
  }

  /**
   * Delete all messages in a conversation with a peer
   */
  async deleteConversation(peerPubkey: string): Promise<void> {
    if (!this.config.cacheMessages) return;
    const normalized = CommunicationsModule._normalizeKey(peerPubkey);
    for (const [id, msg] of this.messages) {
      if (CommunicationsModule._normalizeKey(msg.senderPubkey) === normalized ||
          CommunicationsModule._normalizeKey(msg.recipientPubkey) === normalized) {
        this.messages.delete(id);
      }
    }
    if (this.config.autoSave) {
      await this.save();
    }
  }

  /**
   * Send typing indicator to a peer
   */
  async sendTypingIndicator(peerPubkey: string): Promise<void> {
    this.ensureInitialized();
    if (this.deps!.transport.sendTypingIndicator) {
      await this.deps!.transport.sendTypingIndicator(peerPubkey);
    }
  }

  /**
   * Send a composing indicator to a peer.
   * Fire-and-forget — does not save to message history.
   */
  async sendComposingIndicator(recipientPubkeyOrNametag: string): Promise<void> {
    this.ensureInitialized();

    const resolved = await this.resolveRecipient(recipientPubkeyOrNametag);

    const content = JSON.stringify({
      senderNametag: this.deps!.identity.nametag,
      expiresIn: 30000,
    });

    await this.deps!.transport.sendComposingIndicator?.(resolved.pubkey, content);
  }

  /**
   * Subscribe to incoming composing indicators
   */
  onComposingIndicator(handler: (indicator: ComposingIndicator) => void): () => void {
    this.composingHandlers.add(handler);
    return () => this.composingHandlers.delete(handler);
  }

  /**
   * Subscribe to incoming DMs
   */
  onDirectMessage(handler: (message: DirectMessage) => void): () => void {
    this.dmHandlers.add(handler);

    // Replay existing messages to new handler — ensures DMs that arrived
    // before this handler was registered (e.g., swap proposals arriving
    // during Sphere.init before SwapModule.load) are not lost.
    // Guard: only replay once per handler reference to prevent duplicate
    // processing when a handler is unsubscribed and re-registered.
    if (!this.replayedHandlers.has(handler)) {
      this.replayedHandlers.add(handler);
      const snapshot = Array.from(this.messages.values());
      for (const message of snapshot) {
        try {
          handler(message);
        } catch {
          // Tolerated — handler may reject messages it doesn't care about
        }
      }
    }

    return () => this.dmHandlers.delete(handler);
  }

  // ===========================================================================
  // Public API - Broadcasts
  // ===========================================================================

  /**
   * Publish broadcast message
   */
  async broadcast(content: string, tags?: string[]): Promise<BroadcastMessage> {
    this.ensureInitialized();

    const eventId = await this.deps!.transport.publishBroadcast?.(content, tags);

    const message: BroadcastMessage = {
      id: eventId ?? crypto.randomUUID(),
      authorPubkey: this.deps!.identity.chainPubkey,
      authorNametag: this.deps!.identity.nametag,
      content,
      timestamp: Date.now(),
      tags,
    };

    this.broadcasts.set(message.id, message);
    return message;
  }

  /**
   * Subscribe to broadcasts with tags
   */
  subscribeToBroadcasts(tags: string[]): () => void {
    this.ensureInitialized();

    const key = tags.sort().join(':');
    if (this.broadcastSubscriptions.has(key)) {
      return () => {};
    }

    const unsub = this.deps!.transport.subscribeToBroadcast?.(tags, (broadcast) => {
      this.handleIncomingBroadcast(broadcast);
    });

    if (unsub) {
      this.broadcastSubscriptions.set(key, unsub);
    }

    return () => {
      const sub = this.broadcastSubscriptions.get(key);
      if (sub) {
        sub();
        this.broadcastSubscriptions.delete(key);
      }
    };
  }

  /**
   * Get broadcasts
   */
  getBroadcasts(limit?: number): BroadcastMessage[] {
    const messages = Array.from(this.broadcasts.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    return limit ? messages.slice(0, limit) : messages;
  }

  /**
   * Subscribe to incoming broadcasts
   */
  onBroadcast(handler: (message: BroadcastMessage) => void): () => void {
    this.broadcastHandlers.add(handler);
    return () => this.broadcastHandlers.delete(handler);
  }

  // ===========================================================================
  // Public API - Peer Resolution
  // ===========================================================================

  /**
   * Resolve a peer's nametag by their transport pubkey.
   * Uses transport.resolveTransportPubkeyInfo() for live lookup from relay binding events.
   * Returns undefined if transport doesn't support resolution or peer has no nametag.
   */
  async resolvePeerNametag(peerPubkey: string): Promise<string | undefined> {
    if (!this.deps?.transport.resolveTransportPubkeyInfo) return undefined;
    try {
      const info = await this.deps.transport.resolveTransportPubkeyInfo(peerPubkey);
      return info?.nametag;
    } catch {
      return undefined;
    }
  }

  // ===========================================================================
  // Private: Message Handling
  // ===========================================================================

  private handleIncomingMessage(msg: IncomingMessage): void {
    // Messages older than initialization are historical (e.g. recovered after
    // storage clear). Mark them as read so they don't inflate unread counts.
    const isHistorical = msg.timestamp < this.initializedAt;

    // Self-wrap replay: sent message recovered from relay
    if (msg.isSelfWrap && msg.recipientTransportPubkey) {
      // Dedup: skip if already known (only relevant when caching)
      if (this.config.cacheMessages && this.messages.has(msg.id)) return;

      const message: DirectMessage = {
        id: msg.id,
        senderPubkey: this.deps!.identity.chainPubkey,
        senderNametag: msg.senderNametag,
        recipientPubkey: msg.recipientTransportPubkey,
        content: msg.content,
        timestamp: msg.timestamp,
        isRead: isHistorical,
      };

      if (this.config.cacheMessages) {
        this.messages.set(message.id, message);
      }

      // Emit as sent message replay (same event, UI can pick it up)
      this.deps!.emitEvent('message:dm', message);

      if (this.config.cacheMessages && this.config.autoSave) {
        this.save();
      }
      return;
    }

    // Skip own messages (non-self-wrap).
    // Compare transport pubkey (32-byte x-only) against both chainPubkey (33-byte
    // compressed, with 02/03 prefix) and its x-only form (prefix stripped).
    const ownChainPubkey = this.deps?.identity.chainPubkey;
    if (ownChainPubkey) {
      const tp = msg.senderTransportPubkey;
      if (tp === ownChainPubkey) return;
      // x-only comparison: strip 02/03 prefix from chainPubkey
      if (ownChainPubkey.length === 66 &&
          (ownChainPubkey.startsWith('02') || ownChainPubkey.startsWith('03')) &&
          tp === ownChainPubkey.slice(2)) return;
    }

    // Dedup: skip if already known (only relevant when caching)
    if (this.config.cacheMessages && this.messages.has(msg.id)) return;

    const message: DirectMessage = {
      id: msg.id,
      senderPubkey: msg.senderTransportPubkey,
      senderNametag: msg.senderNametag,
      recipientPubkey: this.deps!.identity.chainPubkey,
      content: msg.content,
      timestamp: msg.timestamp,
      isRead: isHistorical,
    };

    if (this.config.cacheMessages) {
      this.messages.set(message.id, message);
    }

    // Emit event
    this.deps!.emitEvent('message:dm', message);

    // Notify handlers — snapshot Set before iterating to prevent mid-dispatch
    // registration (JS Set spec: new entries added during for-of are visited)
    const handlers = Array.from(this.dmHandlers);
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Communications', 'Handler error:', error);
      }
    }

    // Auto-save and prune (only when caching)
    if (this.config.cacheMessages) {
      if (this.config.autoSave) {
        this.save();
      }
      this.pruneIfNeeded();
    }
  }

  private handleComposingIndicator(indicator: ComposingIndicator): void {
    const composing: ComposingIndicator = {
      senderPubkey: indicator.senderPubkey,
      senderNametag: indicator.senderNametag,
      expiresIn: indicator.expiresIn,
    };

    // Emit event
    this.deps!.emitEvent('composing:started', composing);

    // Notify handlers — snapshot Set to prevent mid-dispatch registration side-effects
    for (const handler of Array.from(this.composingHandlers)) {
      try {
        handler(composing);
      } catch (error) {
        logger.error('Communications', 'Composing handler error:', error);
      }
    }
  }

  private handleIncomingBroadcast(incoming: IncomingBroadcast): void {
    const message: BroadcastMessage = {
      id: incoming.id,
      authorPubkey: incoming.authorTransportPubkey,
      content: incoming.content,
      timestamp: incoming.timestamp,
      tags: incoming.tags,
    };

    this.broadcasts.set(message.id, message);

    // Emit event
    this.deps!.emitEvent('message:broadcast', message);

    // Notify handlers — snapshot Set to prevent mid-dispatch registration side-effects
    for (const handler of Array.from(this.broadcastHandlers)) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Communications', 'Handler error:', error);
      }
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private async save(): Promise<void> {
    const messages = Array.from(this.messages.values());
    await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.MESSAGES, JSON.stringify(messages));
  }

  private pruneIfNeeded(): void {
    // Per-conversation pruning (normalize keys for consistent grouping)
    const ownKey = CommunicationsModule._normalizeKey(this.deps?.identity.chainPubkey ?? '');
    const byPeer = new Map<string, DirectMessage[]>();
    for (const msg of this.messages.values()) {
      const rawPeer =
        CommunicationsModule._normalizeKey(msg.senderPubkey) === ownKey
          ? msg.recipientPubkey
          : msg.senderPubkey;
      const peer = CommunicationsModule._normalizeKey(rawPeer);
      if (!byPeer.has(peer)) byPeer.set(peer, []);
      byPeer.get(peer)!.push(msg);
    }

    for (const [, msgs] of byPeer) {
      if (msgs.length <= this.config.maxPerConversation) continue;
      msgs.sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = msgs.slice(0, msgs.length - this.config.maxPerConversation);
      for (const msg of toRemove) {
        this.messages.delete(msg.id);
      }
    }

    // Global cap
    if (this.messages.size <= this.config.maxMessages) return;

    const sorted = Array.from(this.messages.entries())
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);

    const toRemove = sorted.slice(0, sorted.length - this.config.maxMessages);
    for (const [id] of toRemove) {
      this.messages.delete(id);
    }
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  /**
   * Resolve a Unicity address to a transport-level pubkey for DM delivery.
   * Delegates to the shared TransportAddressResolver (with cache).
   */
  private async resolveRecipient(recipient: string): Promise<{ pubkey: string; nametag?: string }> {
    if (!this.transportResolver) {
      throw new SphereError('CommunicationsModule not initialized', 'NOT_INITIALIZED');
    }
    return this.transportResolver.resolve(recipient);
  }

  /**
   * Pre-resolve a Unicity address to warm the transport address cache.
   *
   * Call before a batch of DM operations to avoid resolution latency
   * on the first sendDM() call. Subsequent calls use the cache.
   *
   * @param address - Any valid Unicity address (@nametag, DIRECT://, PROXY://, hex pubkey)
   * @returns The resolved transport pubkey (caller should NOT use this — it's transport-specific)
   */
  async preResolve(address: string): Promise<string> {
    this.ensureInitialized();
    const result = await this.resolveRecipient(address);
    return result.pubkey;
  }

  /**
   * Invalidate the resolution cache for a specific address or all entries.
   * Use after a known key rotation or nametag transfer.
   */
  invalidateResolveCache(address?: string): void {
    this.transportResolver?.invalidateCache(address);
  }

  /**
   * Get the shared transport address resolver (for use by other modules
   * that need the same resolution + caching, e.g., PaymentsModule).
   */
  getTransportResolver(): TransportAddressResolver | null {
    return this.transportResolver;
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError('CommunicationsModule not initialized', 'NOT_INITIALIZED');
    }
  }

  /**
   * Normalize a pubkey to x-only (64-char lowercase hex) for consistent lookups.
   * Compressed keys (02.../03... 66-char) are stripped to x-only.
   * Already x-only keys are lowercased. Non-hex strings pass through unchanged.
   */
  static _normalizeKey(key: string): string {
    if (key.length === 66 && /^0[23][0-9a-f]{64}$/i.test(key)) {
      return key.slice(2).toLowerCase();
    }
    if (key.length === 64 && /^[0-9a-f]{64}$/i.test(key)) {
      return key.toLowerCase();
    }
    return key;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createCommunicationsModule(
  config?: CommunicationsModuleConfig
): CommunicationsModule {
  return new CommunicationsModule(config);
}
