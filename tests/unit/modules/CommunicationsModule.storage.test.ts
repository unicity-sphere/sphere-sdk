/**
 * Tests for CommunicationsModule per-address storage, pagination, and pruning
 *
 * Covers:
 * - load() clears in-memory state before loading
 * - load() reads from per-address key (STORAGE_KEYS_ADDRESS.MESSAGES)
 * - load() migrates from legacy global 'direct_messages' key
 * - save() writes to per-address key
 * - initialize() cleans up previous subscriptions on re-init
 * - getConversationPage() pagination with limit, before, hasMore
 * - deleteConversation() removes peer messages and auto-saves
 * - pruneIfNeeded() per-conversation and global caps
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, DirectMessage } from '../../../types';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('mock-event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('mock-event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
  };
}

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    description: 'Mock storage for testing',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: string) => { store.set(key, value); return Promise.resolve(); }),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockImplementation((key: string) => Promise.resolve(store.has(key))),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };
}

const MY_PUBKEY = '02' + 'a'.repeat(64);
const PEER_A_PUBKEY = '02' + 'b'.repeat(64);
const PEER_B_PUBKEY = '02' + 'c'.repeat(64);

function createMockIdentity(): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: MY_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
}

function createDeps(overrides?: Partial<CommunicationsModuleDependencies>): CommunicationsModuleDependencies {
  return {
    identity: createMockIdentity(),
    storage: createMockStorage(),
    transport: createMockTransport(),
    emitEvent: vi.fn(),
    ...overrides,
  };
}

function makeMessage(id: string, sender: string, recipient: string, timestamp: number, content = 'hello'): DirectMessage {
  return { id, senderPubkey: sender, recipientPubkey: recipient, content, timestamp, isRead: false };
}

// =============================================================================
// Tests
// =============================================================================

describe('CommunicationsModule — storage & pagination', () => {
  let mod: CommunicationsModule;

  beforeEach(() => {
    mod = new CommunicationsModule();
  });

  // =========================================================================
  // load()
  // =========================================================================

  describe('load()', () => {
    it('should load messages from per-address key', async () => {
      const messages = [
        makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
        makeMessage('m2', MY_PUBKEY, PEER_A_PUBKEY, 2000),
      ];
      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === STORAGE_KEYS_ADDRESS.MESSAGES) return Promise.resolve(JSON.stringify(messages));
        return Promise.resolve(null);
      });

      const deps = createDeps({ storage });
      mod.initialize(deps);
      await mod.load();

      expect(mod.getConversation(PEER_A_PUBKEY)).toHaveLength(2);
    });

    it('should clear in-memory messages before loading', async () => {
      // Use storage that always returns null (simulates switching to a new address with no data)
      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const deps = createDeps({ storage });
      mod.initialize(deps);

      // Simulate sending a message so in-memory state is populated
      await mod.sendDM(PEER_A_PUBKEY, 'first');
      expect(mod.getConversation(PEER_A_PUBKEY)).toHaveLength(1);

      // Now load — storage returns null for all keys, so in-memory should be cleared
      await mod.load();

      expect(mod.getConversation(PEER_A_PUBKEY)).toHaveLength(0);
    });

    it('should migrate from legacy global key filtering by identity', async () => {
      const otherPubkey = '02' + 'd'.repeat(64);
      const allMessages = [
        makeMessage('m1', MY_PUBKEY, PEER_A_PUBKEY, 1000),       // mine
        makeMessage('m2', PEER_A_PUBKEY, MY_PUBKEY, 2000),       // mine
        makeMessage('m3', otherPubkey, PEER_B_PUBKEY, 3000),     // not mine
      ];

      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'direct_messages') return Promise.resolve(JSON.stringify(allMessages));
        return Promise.resolve(null);
      });

      const deps = createDeps({ storage });
      mod.initialize(deps);
      await mod.load();

      // Only my messages should be loaded
      const conv = mod.getConversation(PEER_A_PUBKEY);
      expect(conv).toHaveLength(2);

      // Other user's messages should NOT be loaded
      const convB = mod.getConversation(PEER_B_PUBKEY);
      expect(convB).toHaveLength(0);
    });

    it('should save migrated messages to per-address key', async () => {
      const messages = [makeMessage('m1', MY_PUBKEY, PEER_A_PUBKEY, 1000)];
      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'direct_messages') return Promise.resolve(JSON.stringify(messages));
        return Promise.resolve(null);
      });

      const deps = createDeps({ storage });
      mod.initialize(deps);
      await mod.load();

      // Should have saved to per-address key
      expect(storage.set).toHaveBeenCalledWith(
        STORAGE_KEYS_ADDRESS.MESSAGES,
        expect.any(String),
      );
    });

    it('should not save if no messages to migrate', async () => {
      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const deps = createDeps({ storage });
      mod.initialize(deps);
      await mod.load();

      expect(storage.set).not.toHaveBeenCalled();
    });

    it('should prefer per-address key over legacy key', async () => {
      const perAddressMessages = [makeMessage('m1', MY_PUBKEY, PEER_A_PUBKEY, 1000)];
      const legacyMessages = [
        makeMessage('m2', MY_PUBKEY, PEER_B_PUBKEY, 2000),
        makeMessage('m3', MY_PUBKEY, PEER_B_PUBKEY, 3000),
      ];

      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === STORAGE_KEYS_ADDRESS.MESSAGES) return Promise.resolve(JSON.stringify(perAddressMessages));
        if (key === 'direct_messages') return Promise.resolve(JSON.stringify(legacyMessages));
        return Promise.resolve(null);
      });

      const deps = createDeps({ storage });
      mod.initialize(deps);
      await mod.load();

      // Should have loaded from per-address key (1 msg with peer A)
      expect(mod.getConversation(PEER_A_PUBKEY)).toHaveLength(1);
      // Legacy messages should NOT be loaded
      expect(mod.getConversation(PEER_B_PUBKEY)).toHaveLength(0);
    });
  });

  // =========================================================================
  // save()
  // =========================================================================

  describe('save()', () => {
    it('should save to per-address storage key', async () => {
      const deps = createDeps();
      mod.initialize(deps);
      await mod.sendDM(PEER_A_PUBKEY, 'hello');

      expect(deps.storage.set).toHaveBeenCalledWith(
        STORAGE_KEYS_ADDRESS.MESSAGES,
        expect.any(String),
      );
    });

    // ----------------------------------------------------------------
    // Issue #551 — save chain must NOT propagate
    // PROFILE_NOT_INITIALIZED throws from the storage layer. The
    // fire-and-forget call site `handleIncomingMessage → save('raw')`
    // crashed `sphere trader spawn` on the first inbound DM when the
    // OrbitDB adapter raced a disconnect mid-save. The in-memory
    // messages map is durable; the next successful save re-emits the
    // entire collection. Strict-throw semantics of
    // ProfileStorageProvider.set() (used by AutoReturnLedger's
    // write-first rollback) are preserved by moving the catch up to
    // the actual fire-and-forget owner.
    // ----------------------------------------------------------------

    it('#551: sendDM swallows transient PROFILE_NOT_INITIALIZED from storage.set', async () => {
      const deps = createDeps();
      const profileNotInitErr = Object.assign(new Error('OrbitDB adapter is not connected'), {
        code: 'PROFILE_NOT_INITIALIZED',
      });
      (deps.storage.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(profileNotInitErr);
      mod.initialize(deps);

      // sendDM awaits save() internally. With the #551 catch, the
      // transient throw is swallowed and sendDM resolves normally.
      await expect(mod.sendDM(PEER_A_PUBKEY, 'hello')).resolves.toMatchObject({
        senderPubkey: MY_PUBKEY,
      });
    });

    it('#551: save() still propagates non-PROFILE_NOT_INITIALIZED errors', async () => {
      // Pump messages directly so we can await save() via deleteConversation,
      // which is the simplest awaited save() path that exposes throws.
      const deps = createDeps();
      const realErr = new Error('disk-full');
      (deps.storage.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(realErr);
      mod.initialize(deps);

      // deleteConversation triggers save('cache_index'). A non-PROFILE_NOT_INITIALIZED
      // throw must propagate.
      // Add a message first so deleteConversation has something to remove.
      (mod as unknown as { messages: Map<string, DirectMessage> }).messages.set(
        'm1',
        makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
      );
      await expect(mod.deleteConversation(PEER_A_PUBKEY)).rejects.toThrow(/disk-full/);
    });

    it('#551: incoming DM handler does not crash on PROFILE_NOT_INITIALIZED', async () => {
      const deps = createDeps();
      let onMessageHandler: ((msg: unknown) => void) | undefined;
      (deps.transport.onMessage as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
        onMessageHandler = cb as (msg: unknown) => void;
        return () => {};
      });
      const profileNotInitErr = Object.assign(new Error('OrbitDB adapter is not connected'), {
        code: 'PROFILE_NOT_INITIALIZED',
      });
      (deps.storage.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(profileNotInitErr);
      mod.initialize(deps);
      expect(onMessageHandler).toBeDefined();

      // Simulate inbound DM — handleIncomingMessage fires save('raw')
      // fire-and-forget. Before #551 fix this rejected the chained
      // promise and the rejection leaked. After fix the chain catches.
      onMessageHandler!({
        id: 'evt-1',
        senderTransportPubkey: PEER_A_PUBKEY,
        recipientTransportPubkey: MY_PUBKEY,
        content: 'inbound',
        timestamp: Date.now(),
        isSelfWrap: false,
      });

      // Yield to let the fire-and-forget save chain settle.
      await new Promise((r) => setTimeout(r, 0));
      // Drain the save chain — should resolve, not reject.
      await expect(
        (mod as unknown as { _saveChain: Promise<void> })._saveChain,
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // initialize() — subscription cleanup
  // =========================================================================

  describe('initialize() subscription cleanup', () => {
    it('should clean up previous subscriptions on re-initialization', () => {
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();

      const transport1 = createMockTransport();
      (transport1.onMessage as ReturnType<typeof vi.fn>).mockReturnValue(unsub1);
      (transport1 as Record<string, unknown>).onComposing = vi.fn().mockReturnValue(unsub2);

      const deps1 = createDeps({ transport: transport1 });
      mod.initialize(deps1);

      // Re-initialize with new deps (simulates address switch)
      const deps2 = createDeps();
      mod.initialize(deps2);

      expect(unsub1).toHaveBeenCalled();
      expect(unsub2).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getConversationPage()
  // =========================================================================

  describe('getConversationPage()', () => {
    function setupWithMessages(messages: DirectMessage[]): void {
      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === STORAGE_KEYS_ADDRESS.MESSAGES) return Promise.resolve(JSON.stringify(messages));
        return Promise.resolve(null);
      });
      const deps = createDeps({ storage });
      mod.initialize(deps);
    }

    it('should return first page with default limit', async () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        makeMessage(`m${i}`, PEER_A_PUBKEY, MY_PUBKEY, 1000 + i * 100),
      );
      setupWithMessages(messages);
      await mod.load();

      const page = mod.getConversationPage(PEER_A_PUBKEY);

      expect(page.messages).toHaveLength(20);
      expect(page.hasMore).toBe(true);
      // Messages should be in chronological order (oldest first)
      expect(page.messages[0].timestamp).toBeLessThan(page.messages[19].timestamp);
    });

    it('should return all messages when fewer than limit', async () => {
      const messages = [
        makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
        makeMessage('m2', MY_PUBKEY, PEER_A_PUBKEY, 2000),
      ];
      setupWithMessages(messages);
      await mod.load();

      const page = mod.getConversationPage(PEER_A_PUBKEY);

      expect(page.messages).toHaveLength(2);
      expect(page.hasMore).toBe(false);
    });

    it('should support custom limit', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage(`m${i}`, PEER_A_PUBKEY, MY_PUBKEY, 1000 + i * 100),
      );
      setupWithMessages(messages);
      await mod.load();

      const page = mod.getConversationPage(PEER_A_PUBKEY, { limit: 5 });

      expect(page.messages).toHaveLength(5);
      expect(page.hasMore).toBe(true);
    });

    it('should support before cursor for pagination', async () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        makeMessage(`m${i}`, PEER_A_PUBKEY, MY_PUBKEY, 1000 + i * 100),
      );
      setupWithMessages(messages);
      await mod.load();

      // Get first page (most recent 20)
      const page1 = mod.getConversationPage(PEER_A_PUBKEY, { limit: 20 });
      expect(page1.hasMore).toBe(true);

      // Get second page using oldest timestamp as cursor
      const page2 = mod.getConversationPage(PEER_A_PUBKEY, {
        limit: 20,
        before: page1.messages[0].timestamp,
      });

      expect(page2.messages).toHaveLength(10);
      expect(page2.hasMore).toBe(false);
      // All page2 messages should be older than page1's oldest
      for (const msg of page2.messages) {
        expect(msg.timestamp).toBeLessThan(page1.messages[0].timestamp);
      }
    });

    it('should return empty page for unknown peer', async () => {
      setupWithMessages([]);
      await mod.load();

      const page = mod.getConversationPage('unknown-peer');

      expect(page.messages).toHaveLength(0);
      expect(page.hasMore).toBe(false);
      expect(page.oldestTimestamp).toBeNull();
    });

    it('should only return messages for the specified peer', async () => {
      const messages = [
        makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
        makeMessage('m2', PEER_B_PUBKEY, MY_PUBKEY, 2000),
        makeMessage('m3', MY_PUBKEY, PEER_A_PUBKEY, 3000),
      ];
      setupWithMessages(messages);
      await mod.load();

      const page = mod.getConversationPage(PEER_A_PUBKEY);

      expect(page.messages).toHaveLength(2);
      expect(page.messages.every(
        m => m.senderPubkey === PEER_A_PUBKEY || m.recipientPubkey === PEER_A_PUBKEY,
      )).toBe(true);
    });
  });

  // =========================================================================
  // deleteConversation()
  // =========================================================================

  describe('deleteConversation()', () => {
    it('should remove all messages with a peer', async () => {
      const messages = [
        makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
        makeMessage('m2', MY_PUBKEY, PEER_A_PUBKEY, 2000),
        makeMessage('m3', PEER_B_PUBKEY, MY_PUBKEY, 3000),
      ];
      const storage = createMockStorage();
      (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === STORAGE_KEYS_ADDRESS.MESSAGES) return Promise.resolve(JSON.stringify(messages));
        return Promise.resolve(null);
      });

      const deps = createDeps({ storage });
      mod.initialize(deps);
      await mod.load();

      await mod.deleteConversation(PEER_A_PUBKEY);

      expect(mod.getConversation(PEER_A_PUBKEY)).toHaveLength(0);
      // Peer B should be unaffected
      expect(mod.getConversation(PEER_B_PUBKEY)).toHaveLength(1);
    });

    it('should auto-save after deletion', async () => {
      const deps = createDeps();
      mod.initialize(deps);
      await mod.sendDM(PEER_A_PUBKEY, 'hello');

      vi.clearAllMocks();
      await mod.deleteConversation(PEER_A_PUBKEY);

      expect(deps.storage.set).toHaveBeenCalledWith(
        STORAGE_KEYS_ADDRESS.MESSAGES,
        expect.any(String),
      );
    });
  });

  // =========================================================================
  // pruneIfNeeded() — per-conversation and global caps
  // =========================================================================

  describe('pruning', () => {
    it('should prune per-conversation when exceeding maxPerConversation', async () => {
      mod = new CommunicationsModule({ maxPerConversation: 3 });

      const transport = createMockTransport();
      let messageHandler: ((msg: unknown) => void) | null = null;
      (transport.onMessage as ReturnType<typeof vi.fn>).mockImplementation((handler: (msg: unknown) => void) => {
        messageHandler = handler;
        return () => {};
      });

      const deps = createDeps({ transport });
      mod.initialize(deps);

      // Simulate receiving 5 messages from same peer
      for (let i = 0; i < 5; i++) {
        messageHandler!({
          id: `msg-${i}`,
          senderTransportPubkey: PEER_A_PUBKEY,
          content: `message ${i}`,
          timestamp: 1000 + i * 100,
        });
      }

      // Should have been pruned to 3 (most recent)
      const conv = mod.getConversation(PEER_A_PUBKEY);
      expect(conv.length).toBeLessThanOrEqual(3);
      // The remaining messages should be the newest ones
      expect(conv[conv.length - 1].content).toBe('message 4');
    });

    it('should apply global cap after per-conversation pruning', async () => {
      mod = new CommunicationsModule({ maxMessages: 5, maxPerConversation: 100 });

      const transport = createMockTransport();
      let messageHandler: ((msg: unknown) => void) | null = null;
      (transport.onMessage as ReturnType<typeof vi.fn>).mockImplementation((handler: (msg: unknown) => void) => {
        messageHandler = handler;
        return () => {};
      });

      const deps = createDeps({ transport });
      mod.initialize(deps);

      // Simulate receiving 8 messages across two peers
      for (let i = 0; i < 8; i++) {
        const peer = i % 2 === 0 ? PEER_A_PUBKEY : PEER_B_PUBKEY;
        messageHandler!({
          id: `msg-${i}`,
          senderTransportPubkey: peer,
          content: `message ${i}`,
          timestamp: 1000 + i * 100,
        });
      }

      const totalMessages = mod.getConversation(PEER_A_PUBKEY).length +
        mod.getConversation(PEER_B_PUBKEY).length;
      expect(totalMessages).toBeLessThanOrEqual(5);
    });
  });
});
