/**
 * Communications Module
 * Platform-independent messaging operations
 */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { createTransportAddressResolver, type TransportAddressResolver } from '../../core/transport-resolver';
import { CidRefStore, type CidRef } from '../../profile/cid-ref-store';
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
  /**
   * Optional CID-reference store for OpLog fat-data migration
   * (PROFILE-CID-REFERENCES.md §8.4). When present, DM arrays are pinned
   * to IPFS and the OpLog holds a small ref envelope instead of the fat
   * inline JSON. When absent, falls back to legacy inline storage.
   */
  cidRefStore?: CidRefStore;
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
          // W11: read-state marker update triggered by peer's read receipt
          // — state maintenance of an outgoing message, not a user action.
          this.save('cache_index');
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

    // Try per-address key first — dual-read (CID ref envelope or legacy inline).
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.MESSAGES);

    if (data) {
      const messages = await this.parseMessagesPayload(data, STORAGE_KEYS_ADDRESS.MESSAGES);
      for (const msg of messages) {
        this.messages.set(msg.id, msg);
      }
      return;
    }

    // Migration: fall back to legacy global key, filter for current identity.
    // The legacy global key predates CID-refs and is always inline JSON —
    // no dual-read needed here.
    const legacy = await this.deps!.storage.get('direct_messages');
    if (legacy) {
      let allMessages: DirectMessage[];
      try {
        allMessages = JSON.parse(legacy) as DirectMessage[];
      } catch (err) {
        if (err instanceof SyntaxError) {
          logger.error('Communications', '[MESSAGES] Legacy global key JSON parse failed:', err);
          return;
        }
        throw err;
      }
      if (!Array.isArray(allMessages)) {
        logger.error('Communications', `[MESSAGES] Legacy global key is not an array (got ${typeof allMessages}); skipping.`);
        return;
      }
      const myPubkey = this.deps!.identity.chainPubkey;
      const myMessages = allMessages.filter(
        (m) => m.senderPubkey === myPubkey || m.recipientPubkey === myPubkey,
      );

      for (const msg of myMessages) {
        this.messages.set(msg.id, msg);
      }

      // Persist to new per-address key (will write via CID ref if available).
      if (myMessages.length > 0) {
        // W11: one-time migration of legacy global → per-address storage.
        // Not a user action — system-level schema maintenance.
        await this.save('cache_index');
        logger.debug('Communications', `Migrated ${myMessages.length} messages to per-address storage`);
      }
    }
  }

  /**
   * Parse the raw KV payload for `<addr>.messages`.
   *
   * Dual-read per PROFILE-CID-REFERENCES.md §6:
   *   - If the payload is a CID ref envelope → fetch content from IPFS
   *     via `cidRefStore`. Errors propagate with typed codes.
   *   - If no cidRefStore is injected but a ref is found → throw typed
   *     `ProfileError('CID_REF_UNREADABLE')`. Silent fallback would mean
   *     silently losing all stored DMs for this address.
   *   - Otherwise parse as legacy inline JSON with narrow SyntaxError catch.
   */
  private async parseMessagesPayload(data: string, keyForDiagnostic: string): Promise<DirectMessage[]> {
    const ref = CidRefStore.tryParseRef(data);
    if (ref) {
      if (!this.deps!.cidRefStore) {
        const { ProfileError } = await import('../../profile/errors.js');
        throw new ProfileError(
          'CID_REF_UNREADABLE',
          `CommunicationsModule.load: KV at ${keyForDiagnostic} contains a CID ref ` +
            `(cid=${ref.cid}) but no cidRefStore was injected. DMs cannot be ` +
            `restored without IPFS access. Check CommunicationsModule init — ` +
            `is cidRefStore provided?`,
        );
      }
      const fetched = await this.deps!.cidRefStore.fetchJson<DirectMessage[]>(ref);
      if (!Array.isArray(fetched)) {
        logger.error(
          'Communications',
          `[MESSAGES] CID-ref content at ${ref.cid} is not an array (got ${typeof fetched}); treating as empty.`,
        );
        return [];
      }
      return fetched;
    }

    // Legacy inline JSON — narrow catch for corruption.
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        logger.error(
          'Communications',
          `[MESSAGES] Decoded data is not an array (got ${typeof parsed}); treating as empty.`,
        );
        return [];
      }
      return parsed;
    } catch (err) {
      if (err instanceof SyntaxError) {
        logger.error('Communications', '[MESSAGES] Legacy JSON parse failed (corrupted inline data):', err);
        return [];
      }
      throw err;
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
        // W11: user-initiated outbound DM — the canonical 'dm_send' case.
        // (SPEC §10.2.3.1: outgoing DM → originated='user'.)
        await this.save('dm_send');
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
      // W11: read-state marker update — marking messages read is a local
      // bookkeeping action (displayed as unread-count change, not as a
      // user-replayable action). Classify as cache_index.
      await this.save('cache_index');
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
      // W11: conversation deletion is local bookkeeping — the originated-tag
      // spec (§10.2.3) reserves user-action types for message-lifecycle
      // operations (dm_send, dm_receive). Bulk local deletion lacks a
      // dedicated type, so it maps to cache_index (closest semantic
      // neighbour — a local-state maintenance operation).
      await this.save('cache_index');
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
   * Subscribe to incoming DMs.
   *
   * Replay contract: cached messages that haven't yet been delivered to
   * `handler` are replayed SYNCHRONOUSLY inside this call, before the
   * function returns. This is load-bearing for two callers:
   *   - modules loaded after `Sphere.init` (SwapModule, AccountingModule)
   *     rely on the replay completing before their `load()` returns so
   *     they can recover state without losing DMs that arrived while the
   *     module was being constructed;
   *   - E2E test helpers distinguish replays from live deliveries by
   *     ignoring handler invocations that occur before this function
   *     returns. Changing replay to be asynchronous (deferred via
   *     queueMicrotask, setImmediate, etc.) would silently break those
   *     callers — keep it synchronous and update this comment + the
   *     `synchronous replay` unit test in CommunicationsModule.selffilter
   *     if the contract ever has to change.
   *
   * Self-filter (#155): handleIncomingMessage skips self-sent messages
   * before calling handlers (`handlers` is the "incoming only" contract,
   * see CommunicationsModule.selffilter.test.ts). The cache holds BOTH
   * sent and received messages, so the replay loop must apply the same
   * filter; otherwise newly registered handlers see their own outbound
   * messages — exactly the bug that surfaced in #155 dm-nip17 tests.
   */
  onDirectMessage(handler: (message: DirectMessage) => void): () => void {
    this.dmHandlers.add(handler);

    // Guard: only replay once per handler reference to prevent duplicate
    // processing when a handler is unsubscribed and re-registered.
    if (!this.replayedHandlers.has(handler)) {
      this.replayedHandlers.add(handler);
      const ownKey = CommunicationsModule._normalizeKey(
        this.deps?.identity.chainPubkey ?? ''
      );
      const snapshot = Array.from(this.messages.values());
      for (const message of snapshot) {
        // Defensive: malformed cache entries (legacy migration, corrupted
        // storage) may have a non-string senderPubkey. _normalizeKey reads
        // .length, so undefined/null would crash the entire replay loop
        // and propagate out of onDirectMessage. Skip the self-filter for
        // anything we can't normalize — those messages can't be self-sent
        // by definition, so delivering them is the safe fallback.
        const sender = message.senderPubkey;
        if (
          ownKey &&
          typeof sender === 'string' &&
          CommunicationsModule._normalizeKey(sender) === ownKey
        ) {
          continue;
        }
        try {
          handler(message);
        } catch (err) {
          logger.debug('Communications', `DM replay handler threw for message ${message.id}: ${err}`);
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
        // W11: self-wrap replay recovers an outgoing DM from the relay —
        // delivered through the transport's onMessage handler, so the SAVE
        // triggers from passive receipt rather than a fresh user action.
        // Route through the raw path (same as true incoming DMs) for
        // uniform treatment of transport-triggered saves; the stored
        // envelope's origin tag is resolved by receiver-authority on read.
        this.save('raw');
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
        // W11: incoming DM from a peer — SPEC §10.2.3.1 ORIGIN-SIDE
        // 'replicated' case. The local write bypasses setEntry (which
        // rejects 'replicated' via assertOriginTagLocal); receiver-authority
        // downgrade in OrbitDbAdapter.getEntry labels peer-replicated
        // reads as 'replicated' for downstream wallets.
        this.save('raw');
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

  /**
   * Memoized plaintext + CID ref for the last messages pin. See
   * `_lastPinnedV5Json` in PaymentsModule for rationale: AES-GCM uses
   * random IVs so re-pinning identical plaintext produces a different CID.
   * We'd rather write the cached ref than thrash the IPFS gateway.
   */
  private _lastPinnedMessagesJson: string | null = null;
  private _lastPinnedMessagesRef: CidRef | null = null;

  /**
   * Single-flight chain for save() — DMs arrive over the Nostr subscription
   * and can trigger multiple concurrent save() invocations (one per event).
   * Without serialization, two concurrent saves both read the same Map
   * snapshot and the second clobbers the first. The chain mirrors
   * PaymentsModule._saveChain / _outboxChain discipline.
   *
   * Caveat: guarantees ORDERING, not atomicity — a failing save doesn't
   * roll back state but also doesn't block the next save.
   */
  private _saveChain: Promise<void> = Promise.resolve();

  /**
   * W11 classification sentinel passed through `save()` → `_doSave()`.
   *
   * SPEC §10.2.3 requires each OpLog write to carry an originated tag that
   * matches the intent of the local author at the site of the write. DMs
   * introduce a directional wrinkle (SPEC §10.2.3.1): outgoing sends are
   * user actions (`dm_send`, originated='user'), while an incoming receipt
   * is ORIGIN-SIDE `'replicated'` — the ONE place in the codebase where
   * `replicated` applies at call time rather than via receiver-authority
   * downgrade.
   *
   * Because `ProfileStorageProvider.setEntry` validates via
   * `assertOriginTagLocal` (which rejects `replicated`), we route the
   * incoming-DM save through plain `storage.set` instead (the `'raw'`
   * sentinel below). The read path in `OrbitDbAdapter.getEntry` forces
   * replicated-downgrade for keys NOT in `localAuthoredKeys` — i.e., for
   * peers who see the replicated entry. Locally, the stored envelope
   * defaults to `cache_index/system`; that classification is benign for
   * a snapshot that mixes directions, and receiver-authority downgrade
   * makes it correct for peers either way.
   *
   * Cache/metadata writes (read-state markers, legacy migration, etc.)
   * are passed as `'cache_index'` — system maintenance of the messages
   * snapshot rather than a user action.
   */
  private async save(
    entryType: 'dm_send' | 'cache_index' | 'raw' = 'cache_index',
  ): Promise<void> {
    const chained = this._saveChain
      .catch(() => {
        /* isolate prior failure */
      })
      .then(() => this._doSave(entryType));
    this._saveChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  /**
   * Write the current messages Map — via CID reference when `cidRefStore`
   * is injected, inline JSON otherwise. PROFILE-CID-REFERENCES.md §8.4.
   *
   * Note on pattern choice: §8.4 specifies Pattern B (index of per-message
   * CIDs). This implementation uses Pattern A (single CID for the whole
   * array) for parity with PaymentsModule's migration. Pattern B is a
   * future Phase-2 optimization — both share the same OpLog envelope
   * shape, so the migration path from A → B is transparent to peers.
   * Pattern A is adequate for typical wallets (<1000 DMs per address);
   * Pattern B matters once conversations get very long.
   *
   * W11 `entryType` dispatch (see `save()` docstring):
   *   - 'dm_send'     → setStorageEntry (outgoing user action)
   *   - 'cache_index' → setStorageEntry (system maintenance)
   *   - 'raw'         → plain storage.set (incoming DM — read-time
   *                     downgrade supplies the 'replicated' tag to peers;
   *                     the locally stored envelope defaults to
   *                     cache_index/system, which is benign for a snapshot
   *                     that mixes directions).
   */
  private async _doSave(
    entryType: 'dm_send' | 'cache_index' | 'raw',
  ): Promise<void> {
    const messages = Array.from(this.messages.values());
    const cidRefStore = this.deps!.cidRefStore;

    if (messages.length === 0) {
      // Empty list: write a truthy JSON sentinel ("[]") rather than the empty
      // string. Reason: `load()` treats falsy KV values as "no data" and
      // falls through to the legacy global `direct_messages` key for
      // migration. If we wrote '' here, a user who deleted every DM would
      // see those DMs resurrect from the legacy key on the next reload.
      // Writing "[]" keeps load() on the per-address branch and decodes
      // cleanly to an empty array.
      //
      // Diverges intentionally from outbox/pendingV5 which have no legacy
      // fallback and can safely use the empty-string sentinel.
      await this.writeMessagesKey(STORAGE_KEYS_ADDRESS.MESSAGES, '[]', entryType);
      this._lastPinnedMessagesJson = null;
      this._lastPinnedMessagesRef = null;
      return;
    }

    if (cidRefStore) {
      const json = JSON.stringify(messages);

      // Skip re-pin if plaintext is byte-identical to the last successful pin.
      if (this._lastPinnedMessagesRef && this._lastPinnedMessagesJson === json) {
        const refStr = CidRefStore.stringifyRef(this._lastPinnedMessagesRef);
        await this.writeMessagesKey(STORAGE_KEYS_ADDRESS.MESSAGES, refStr, entryType);
        return;
      }

      const ref = await cidRefStore.pinJson(messages);
      const refStr = CidRefStore.stringifyRef(ref);
      await this.writeMessagesKey(STORAGE_KEYS_ADDRESS.MESSAGES, refStr, entryType);
      // Update memo AFTER storage.set — see PaymentsModule equivalent for
      // the rationale (a set-failure must not leave us pointing at a CID
      // the caller thinks is live).
      this._lastPinnedMessagesJson = json;
      this._lastPinnedMessagesRef = ref;
      return;
    }

    // Legacy path: inline JSON (deprecated for heavy wallets — see §8.4).
    await this.writeMessagesKey(STORAGE_KEYS_ADDRESS.MESSAGES, JSON.stringify(messages), entryType);
  }

  /**
   * Single write funnel for the `<addr>.messages` key. Dispatches between
   * `setStorageEntry` (classified writes) and plain `storage.set` (raw
   * writes used for incoming DM receipts — see the `save()` docstring for
   * the receiver-authority model). Keeping the dispatch on one line of
   * code avoids four-way duplication in `_doSave()`.
   */
  private async writeMessagesKey(
    key: string,
    value: string,
    entryType: 'dm_send' | 'cache_index' | 'raw',
  ): Promise<void> {
    if (entryType === 'raw') {
      // Incoming DM path — SPEC §10.2.3.1. The origin-side tag for a
      // received peer message is `'replicated'`, which
      // `ProfileStorageProvider.setEntry → assertOriginTagLocal` rejects
      // at the local write edge. We bypass the envelope-typed helper here
      // and write raw bytes; the resulting envelope defaults to
      // `cache_index/system`, which receiver-authority downgrade in
      // `OrbitDbAdapter.getEntry` overrides to `'replicated'` for any
      // peer that replicates this key.
      await this.deps!.storage.set(key, value);
      return;
    }
    await this.setStorageEntry(key, value, entryType);
  }

  /**
   * W11 originated-tag helper (SPEC §10.2.3). Mirrors
   * `PaymentsModule.setStorageEntry` — routes through
   * `storage.setEntry(key, value, entryType)` when the provider implements
   * the envelope-typed API, falls back to plain `set()` otherwise.
   *
   * Narrow union: `'dm_send' | 'cache_index'`. The third class of write
   * for this module — an incoming DM received from a peer — is NOT routed
   * through this helper (see `writeMessagesKey` and `save()` docstring).
   *
   * A once-per-provider-class debug log on fallback surfaces silent loss
   * of W11 stamping during a mixed-provider migration.
   */
  private async setStorageEntry(
    key: string,
    value: string,
    entryType: 'dm_send' | 'cache_index',
  ): Promise<void> {
    const storage = this.deps!.storage;
    const setEntryFn = (storage as { setEntry?: (k: string, v: string, t: string) => Promise<void> })
      .setEntry;
    if (typeof setEntryFn === 'function') {
      await setEntryFn.call(storage, key, value, entryType);
      return;
    }
    // Fallback: provider has no envelope-storage layer (plain IndexedDB
    // / file KV). Log once per provider-class so a silent loss of W11
    // stamping during a migration is visible in ops. Subsequent calls
    // from the same class are silent to avoid log spam.
    const providerClass = storage.constructor?.name ?? 'UnknownStorage';
    if (!CommunicationsModule._w11FallbackLogged.has(providerClass)) {
      CommunicationsModule._w11FallbackLogged.add(providerClass);
      logger.debug(
        'Communications',
        `[W11] storage.setEntry not available on ${providerClass}; originated tags will not be stamped ` +
          `(this is expected for plain IndexedDB / file storage, unexpected when ProfileStorageProvider is in the chain).`,
      );
    }
    await storage.set(key, value);
  }

  /** Per-class dedup set for the W11 fallback log (see setStorageEntry). */
  private static _w11FallbackLogged: Set<string> = new Set();

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
