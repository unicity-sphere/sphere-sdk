/**
 * Tests for GroupChatModule pagination (`getMessagesPage()`)
 *
 * Covers:
 * - getMessagesPage() with default limit (20)
 * - getMessagesPage() with custom limit
 * - getMessagesPage() with before cursor
 * - getMessagesPage() returns chronological order
 * - getMessagesPage() empty group
 * - getMessagesPage() hasMore flag
 */

import { describe, it, expect, vi } from 'vitest';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';
import type { GroupData, GroupMessageData } from '../../../modules/groupchat/types';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// Mock NostrClient + NostrKeyManager (GroupChatModule uses them in initialize)
// =============================================================================

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrKeyManager: {
      fromPrivateKey: vi.fn().mockReturnValue({
        getPublicKey: vi.fn().mockReturnValue('mock-pubkey'),
        signEvent: vi.fn(),
      }),
    },
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(false),
      subscribe: vi.fn().mockReturnValue('mock-sub-id'),
      unsubscribe: vi.fn(),
      publishEvent: vi.fn().mockResolvedValue('mock-event-id'),
      addConnectionListener: vi.fn(),
    })),
  };
});

// Import AFTER mocks are set up
const { GroupChatModule } = await import('../../../modules/groupchat/GroupChatModule');
type GroupChatModuleDependencies = import('../../../modules/groupchat/GroupChatModule').GroupChatModuleDependencies;

// =============================================================================
// Mock Factories
// =============================================================================

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
const SENDER_A = '02' + 'b'.repeat(64);

function createMockIdentity(): FullIdentity {
  return {
    privateKey: '01'.padStart(64, '0'), // valid non-zero key
    chainPubkey: MY_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
}

function createDeps(overrides?: Partial<GroupChatModuleDependencies>): GroupChatModuleDependencies {
  return {
    identity: createMockIdentity(),
    storage: createMockStorage(),
    emitEvent: vi.fn(),
    ...overrides,
  };
}

function makeGroup(id: string): GroupData {
  return {
    id,
    relayUrl: 'wss://relay.test',
    name: `Group ${id}`,
    visibility: 'PUBLIC',
    createdAt: 1000,
  };
}

function makeMessage(id: string, groupId: string, timestamp: number, content = 'hello'): GroupMessageData {
  return {
    id,
    groupId,
    content,
    timestamp,
    senderPubkey: SENDER_A,
  };
}

/**
 * Set up a GroupChatModule with pre-loaded messages via storage mock.
 */
async function setupWithMessages(
  groups: GroupData[],
  messages: GroupMessageData[],
): Promise<{ mod: InstanceType<typeof GroupChatModule>; deps: GroupChatModuleDependencies }> {
  const storage = createMockStorage();
  (storage.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
    if (key === STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS) {
      return Promise.resolve(JSON.stringify(groups));
    }
    if (key === STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES) {
      return Promise.resolve(JSON.stringify(messages));
    }
    return Promise.resolve(null);
  });

  const deps = createDeps({ storage });
  const mod = new GroupChatModule();
  mod.initialize(deps);
  await mod.load();

  return { mod, deps };
}

// =============================================================================
// Tests — getMessagesPage()
// =============================================================================

describe('GroupChatModule — getMessagesPage()', () => {
  const GROUP_ID = 'test-group-1';

  it('should return first page with default limit (20)', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = Array.from({ length: 30 }, (_, i) =>
      makeMessage(`m${i}`, GROUP_ID, 1000 + i * 100, `msg ${i}`),
    );

    const { mod } = await setupWithMessages([group], messages);
    const page = mod.getMessagesPage(GROUP_ID);

    expect(page.messages).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.oldestTimestamp).not.toBeNull();
  });

  it('should return messages in chronological order (oldest first)', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage(`m${i}`, GROUP_ID, 1000 + i * 100),
    );

    const { mod } = await setupWithMessages([group], messages);
    const page = mod.getMessagesPage(GROUP_ID);

    for (let i = 1; i < page.messages.length; i++) {
      expect(page.messages[i].timestamp).toBeGreaterThan(page.messages[i - 1].timestamp);
    }
  });

  it('should return all messages when fewer than limit', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = [
      makeMessage('m1', GROUP_ID, 1000),
      makeMessage('m2', GROUP_ID, 2000),
      makeMessage('m3', GROUP_ID, 3000),
    ];

    const { mod } = await setupWithMessages([group], messages);
    const page = mod.getMessagesPage(GROUP_ID);

    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(false);
  });

  it('should support custom limit', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeMessage(`m${i}`, GROUP_ID, 1000 + i * 100),
    );

    const { mod } = await setupWithMessages([group], messages);
    const page = mod.getMessagesPage(GROUP_ID, { limit: 5 });

    expect(page.messages).toHaveLength(5);
    expect(page.hasMore).toBe(true);
  });

  it('should support before cursor for pagination', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = Array.from({ length: 30 }, (_, i) =>
      makeMessage(`m${i}`, GROUP_ID, 1000 + i * 100),
    );

    const { mod } = await setupWithMessages([group], messages);

    // First page — most recent 20
    const page1 = mod.getMessagesPage(GROUP_ID, { limit: 20 });
    expect(page1.hasMore).toBe(true);
    expect(page1.messages).toHaveLength(20);

    // Second page — older messages using oldest timestamp as cursor
    const page2 = mod.getMessagesPage(GROUP_ID, {
      limit: 20,
      before: page1.oldestTimestamp!,
    });

    expect(page2.messages).toHaveLength(10);
    expect(page2.hasMore).toBe(false);

    // All page2 messages should be older than page1's oldest
    for (const msg of page2.messages) {
      expect(msg.timestamp).toBeLessThan(page1.oldestTimestamp!);
    }
  });

  it('should return empty page for unknown group', async () => {
    const { mod } = await setupWithMessages([], []);

    const page = mod.getMessagesPage('nonexistent-group');

    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.oldestTimestamp).toBeNull();
  });

  it('should return empty page for group with no messages', async () => {
    const group = makeGroup(GROUP_ID);
    const { mod } = await setupWithMessages([group], []);

    const page = mod.getMessagesPage(GROUP_ID);

    expect(page.messages).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.oldestTimestamp).toBeNull();
  });

  it('should not mix messages from different groups', async () => {
    const group1 = makeGroup('group-1');
    const group2 = makeGroup('group-2');
    const messages = [
      makeMessage('m1', 'group-1', 1000),
      makeMessage('m2', 'group-2', 2000),
      makeMessage('m3', 'group-1', 3000),
      makeMessage('m4', 'group-2', 4000),
    ];

    const { mod } = await setupWithMessages([group1, group2], messages);

    const page1 = mod.getMessagesPage('group-1');
    expect(page1.messages).toHaveLength(2);
    expect(page1.messages.every(m => m.groupId === 'group-1')).toBe(true);

    const page2 = mod.getMessagesPage('group-2');
    expect(page2.messages).toHaveLength(2);
    expect(page2.messages.every(m => m.groupId === 'group-2')).toBe(true);
  });

  it('should set oldestTimestamp to the first message timestamp in the page', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = [
      makeMessage('m1', GROUP_ID, 1000),
      makeMessage('m2', GROUP_ID, 2000),
      makeMessage('m3', GROUP_ID, 3000),
    ];

    const { mod } = await setupWithMessages([group], messages);
    const page = mod.getMessagesPage(GROUP_ID, { limit: 2 });

    // Page returns the most recent 2 messages (2000, 3000) in chronological order
    // oldestTimestamp should be 2000 (the oldest in this page)
    expect(page.oldestTimestamp).toBe(2000);
    expect(page.messages[0].timestamp).toBe(2000);
    expect(page.messages[1].timestamp).toBe(3000);
    expect(page.hasMore).toBe(true);
  });

  it('should handle exact limit match (hasMore = false)', async () => {
    const group = makeGroup(GROUP_ID);
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMessage(`m${i}`, GROUP_ID, 1000 + i * 100),
    );

    const { mod } = await setupWithMessages([group], messages);
    const page = mod.getMessagesPage(GROUP_ID, { limit: 5 });

    expect(page.messages).toHaveLength(5);
    expect(page.hasMore).toBe(false);
  });
});
