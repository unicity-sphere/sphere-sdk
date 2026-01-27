/**
 * Communications Module
 * Platform-independent messaging operations
 */

import type {
  DirectMessage,
  BroadcastMessage,
  FullIdentity,
  SphereEventType,
  SphereEventMap,
} from '../../types';
import type { StorageProvider } from '../../storage';
import type { TransportProvider, IncomingMessage, IncomingBroadcast } from '../../transport';

// =============================================================================
// Configuration
// =============================================================================

export interface CommunicationsModuleConfig {
  /** Auto-save messages */
  autoSave?: boolean;
  /** Max messages in memory */
  maxMessages?: number;
  /** Enable read receipts */
  readReceipts?: boolean;
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
  private broadcastSubscriptions: Map<string, () => void> = new Map();

  // Handlers
  private dmHandlers: Set<(message: DirectMessage) => void> = new Set();
  private broadcastHandlers: Set<(message: BroadcastMessage) => void> = new Set();

  constructor(config?: CommunicationsModuleConfig) {
    this.config = {
      autoSave: config?.autoSave ?? true,
      maxMessages: config?.maxMessages ?? 1000,
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
    this.deps = deps;

    // Subscribe to incoming messages
    this.unsubscribeMessages = deps.transport.onMessage((msg) => {
      this.handleIncomingMessage(msg);
    });
  }

  /**
   * Load messages from storage
   */
  async load(): Promise<void> {
    this.ensureInitialized();

    const data = await this.deps!.storage.get('direct_messages');
    if (data) {
      const messages = JSON.parse(data) as DirectMessage[];
      this.messages.clear();
      for (const msg of messages) {
        this.messages.set(msg.id, msg);
      }
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.unsubscribeMessages?.();
    this.unsubscribeMessages = null;

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
    const recipientPubkey = await this.resolveRecipient(recipient);

    // Send via transport
    const eventId = await this.deps!.transport.sendMessage(recipientPubkey, content);

    // Create message record
    const message: DirectMessage = {
      id: eventId,
      senderPubkey: this.deps!.identity.publicKey,
      senderNametag: this.deps!.identity.nametag,
      recipientPubkey,
      content,
      timestamp: Date.now(),
      isRead: true,
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
        message.senderPubkey === this.deps?.identity.publicKey
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
  }

  /**
   * Get unread count
   */
  getUnreadCount(peerPubkey?: string): number {
    let messages = Array.from(this.messages.values()).filter(
      (m) => !m.isRead && m.senderPubkey !== this.deps?.identity.publicKey
    );

    if (peerPubkey) {
      messages = messages.filter((m) => m.senderPubkey === peerPubkey);
    }

    return messages.length;
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
      authorPubkey: this.deps!.identity.publicKey,
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
  // Private: Message Handling
  // ===========================================================================

  private handleIncomingMessage(msg: IncomingMessage): void {
    // Skip own messages
    if (msg.senderPubkey === this.deps?.identity.publicKey) return;

    const message: DirectMessage = {
      id: msg.id,
      senderPubkey: msg.senderPubkey,
      recipientPubkey: this.deps!.identity.publicKey,
      content: msg.content,
      timestamp: msg.timestamp,
      isRead: false,
    };

    this.messages.set(message.id, message);

    // Emit event
    this.deps!.emitEvent('message:dm', message);

    // Notify handlers
    for (const handler of this.dmHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[Communications] Handler error:', error);
      }
    }

    // Auto-save
    if (this.config.autoSave) {
      this.save();
    }

    // Prune if needed
    this.pruneIfNeeded();
  }

  private handleIncomingBroadcast(incoming: IncomingBroadcast): void {
    const message: BroadcastMessage = {
      id: incoming.id,
      authorPubkey: incoming.authorPubkey,
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
        console.error('[Communications] Handler error:', error);
      }
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private async save(): Promise<void> {
    const messages = Array.from(this.messages.values());
    await this.deps!.storage.set('direct_messages', JSON.stringify(messages));
  }

  private pruneIfNeeded(): void {
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

  private async resolveRecipient(recipient: string): Promise<string> {
    if (recipient.startsWith('@')) {
      const pubkey = await this.deps!.transport.resolveNametag?.(recipient.slice(1));
      if (!pubkey) {
        throw new Error(`Nametag not found: ${recipient}`);
      }
      return pubkey;
    }
    return recipient;
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
