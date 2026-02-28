/**
 * Communications Module
 * Platform-independent messaging operations
 */

import { logger } from '../../core/logger';
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
  private composingHandlers: Set<(indicator: ComposingIndicator) => void> = new Set();
  private broadcastHandlers: Set<(message: BroadcastMessage) => void> = new Set();

  // Timestamp of module initialization — messages older than this are historical
  private initializedAt: number = 0;

  constructor(config?: CommunicationsModuleConfig) {
    this.config = {
      autoSave: config?.autoSave ?? true,
      maxMessages: config?.maxMessages ?? 1000,
      maxPerConversation: config?.maxPerConversation ?? 200,
      readReceipts: config?.readReceipts ?? true,
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
  }

  /**
   * Load messages from storage.
   * Uses per-address key (STORAGE_KEYS_ADDRESS.MESSAGES) which is automatically
   * scoped by LocalStorageProvider to sphere_DIRECT_xxx_yyy_messages.
   * Falls back to legacy global 'direct_messages' key for migration.
   */
  async load(): Promise<void> {
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

    // Save
    this.messages.set(message.id, message);
    if (this.config.autoSave) {
      await this.save();
    }

    return message;
  }

  /**
   * Get conversation with peer
   */
  getConversation(peerPubkey: string): DirectMessage[] {
    return Array.from(this.messages.values())
      .filter(
        (m) => m.senderPubkey === peerPubkey || m.recipientPubkey === peerPubkey
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get all conversations grouped by peer
   */
  getConversations(): Map<string, DirectMessage[]> {
    const conversations = new Map<string, DirectMessage[]>();

    for (const message of this.messages.values()) {
      const peer =
        message.senderPubkey === this.deps?.identity.chainPubkey
          ? message.recipientPubkey
          : message.senderPubkey;

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

    if (this.config.autoSave) {
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
    let messages = Array.from(this.messages.values()).filter(
      (m) => !m.isRead && m.senderPubkey !== this.deps?.identity.chainPubkey
    );

    if (peerPubkey) {
      messages = messages.filter((m) => m.senderPubkey === peerPubkey);
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

    const all = Array.from(this.messages.values())
      .filter(
        (m) =>
          (m.senderPubkey === peerPubkey || m.recipientPubkey === peerPubkey) &&
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
    for (const [id, msg] of this.messages) {
      if (msg.senderPubkey === peerPubkey || msg.recipientPubkey === peerPubkey) {
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
      // Dedup: skip if already known
      if (this.messages.has(msg.id)) return;

      const message: DirectMessage = {
        id: msg.id,
        senderPubkey: this.deps!.identity.chainPubkey,
        senderNametag: msg.senderNametag,
        recipientPubkey: msg.recipientTransportPubkey,
        content: msg.content,
        timestamp: msg.timestamp,
        isRead: isHistorical,
      };

      this.messages.set(message.id, message);

      // Emit as sent message replay (same event, UI can pick it up)
      this.deps!.emitEvent('message:dm', message);

      if (this.config.autoSave) {
        this.save();
      }
      return;
    }

    // Skip own messages (non-self-wrap)
    if (msg.senderTransportPubkey === this.deps?.identity.chainPubkey) return;

    // Dedup: skip if already known
    if (this.messages.has(msg.id)) return;

    const message: DirectMessage = {
      id: msg.id,
      senderPubkey: msg.senderTransportPubkey,
      senderNametag: msg.senderNametag,
      recipientPubkey: this.deps!.identity.chainPubkey,
      content: msg.content,
      timestamp: msg.timestamp,
      isRead: isHistorical,
    };

    this.messages.set(message.id, message);

    // Emit event
    this.deps!.emitEvent('message:dm', message);

    // Notify handlers
    for (const handler of this.dmHandlers) {
      try {
        handler(message);
      } catch (error) {
        logger.error('Communications', 'Handler error:', error);
      }
    }

    // Auto-save
    if (this.config.autoSave) {
      this.save();
    }

    // Prune if needed
    this.pruneIfNeeded();
  }

  private handleComposingIndicator(indicator: ComposingIndicator): void {
    const composing: ComposingIndicator = {
      senderPubkey: indicator.senderPubkey,
      senderNametag: indicator.senderNametag,
      expiresIn: indicator.expiresIn,
    };

    // Emit event
    this.deps!.emitEvent('composing:started', composing);

    // Notify handlers
    for (const handler of this.composingHandlers) {
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

    // Notify handlers
    for (const handler of this.broadcastHandlers) {
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
    // Per-conversation pruning
    const byPeer = new Map<string, DirectMessage[]>();
    for (const msg of this.messages.values()) {
      const peer =
        msg.senderPubkey === this.deps?.identity.chainPubkey
          ? msg.recipientPubkey
          : msg.senderPubkey;
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

  private async resolveRecipient(recipient: string): Promise<{ pubkey: string; nametag?: string }> {
    if (recipient.startsWith('@')) {
      const nametag = recipient.slice(1);
      const pubkey = await this.deps!.transport.resolveNametag?.(nametag);
      if (!pubkey) {
        throw new Error(`Nametag not found: ${recipient}`);
      }
      return { pubkey, nametag };
    }
    return { pubkey: recipient };
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new Error('CommunicationsModule not initialized');
    }
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
