/**
 * GroupChatModule schema migration tests (#98a).
 *
 * Before #98a: `group_chat_messages` and `group_chat_members` were each a
 * single global blob carrying ALL groups' data. After #98a: per-groupId
 * keys (`group_chat_messages:<groupId>` / `group_chat_members:<groupId>`).
 *
 * This file covers the schema boundary:
 *   1. Fresh install — per-group keys are written, legacy never read.
 *   2. Legacy blob present — migrated forward, legacy key deleted.
 *   3. Post-migration boot — per-group keys read, legacy never consulted.
 *   4. Partial migration — messages migrated, members still on legacy:
 *      only the missing side migrates on the next load.
 *   5. Orphan cleanup — leaving a group removes its per-group keys.
 *   6. Mixed content — legacy blob with messages from multiple groups
 *      splits correctly into per-group keys.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';
import type { GroupData, GroupMessageData, GroupMemberData } from '../../../modules/groupchat/types';
import { GroupRole as GroupRoleEnum } from '../../../modules/groupchat/types';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

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

const { GroupChatModule } = await import('../../../modules/groupchat/GroupChatModule');
type GroupChatModuleDependencies = import('../../../modules/groupchat/GroupChatModule').GroupChatModuleDependencies;

// Module-internal prefix constants duplicated here so tests can inspect/seed
// storage without exporting internals from the module.
const MESSAGES_PREFIX = 'group_chat_messages:';
const MEMBERS_PREFIX = 'group_chat_members:';

// =============================================================================
// Helpers
// =============================================================================

function createMockStorage(): StorageProvider & { _data: Map<string, string> } {
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
    remove: vi.fn().mockImplementation((key: string) => { store.delete(key); return Promise.resolve(); }),
    has: vi.fn().mockImplementation((key: string) => Promise.resolve(store.has(key))),
    keys: vi.fn().mockImplementation((prefix?: string) => {
      const all = Array.from(store.keys());
      return Promise.resolve(prefix == null ? all : all.filter((k) => k.startsWith(prefix)));
    }),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
    _data: store,
  } as unknown as StorageProvider & { _data: Map<string, string> };
}

const MY_PUBKEY = '02' + 'a'.repeat(64);
const PEER_B = '02' + 'b'.repeat(64);
const PEER_C = '02' + 'c'.repeat(64);

function createDeps(storage: StorageProvider): GroupChatModuleDependencies {
  const identity: FullIdentity = {
    privateKey: '01'.padStart(64, '0'),
    chainPubkey: MY_PUBKEY,
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
  return {
    identity,
    storage,
    emitEvent: vi.fn(),
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

function makeMessage(id: string, groupId: string, ts = 1000): GroupMessageData {
  return { id, groupId, content: `msg ${id}`, timestamp: ts, senderPubkey: PEER_B };
}

function makeMember(groupId: string, pubkey: string): GroupMemberData {
  return {
    groupId,
    pubkey,
    role: GroupRoleEnum.MEMBER,
    joinedAt: 1000,
  } as GroupMemberData;
}

// =============================================================================
// Tests
// =============================================================================

describe('GroupChatModule — per-groupId schema migration', () => {
  let storage: StorageProvider & { _data: Map<string, string> };
  let mod: InstanceType<typeof GroupChatModule>;

  beforeEach(() => {
    storage = createMockStorage();
    mod = new GroupChatModule();
    mod.initialize(createDeps(storage));
  });

  it('fresh install: no legacy read, per-group writes', async () => {
    // Seed groups only (no messages/members in storage).
    storage._data.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS,
      JSON.stringify([makeGroup('g1')]),
    );

    await mod.load();

    // Simulate receiving a message by direct state injection + persist.
    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    messagesMap.set('g1', [makeMessage('m1', 'g1')]);
    await (mod as any).persistMessages();

    expect(storage._data.has(MESSAGES_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES)).toBe(false);
  });

  it('migrates legacy blob forward and removes it', async () => {
    const groups = [makeGroup('g1'), makeGroup('g2')];
    const legacyMessages: GroupMessageData[] = [
      makeMessage('m1', 'g1', 1000),
      makeMessage('m2', 'g1', 2000),
      makeMessage('m3', 'g2', 3000),
    ];

    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES, JSON.stringify(legacyMessages));

    await mod.load();

    // Per-group keys written.
    expect(storage._data.has(MESSAGES_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(MESSAGES_PREFIX + 'g2')).toBe(true);
    // Legacy key removed.
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES)).toBe(false);
    // Content partitioned correctly.
    const g1 = JSON.parse(storage._data.get(MESSAGES_PREFIX + 'g1')!);
    const g2 = JSON.parse(storage._data.get(MESSAGES_PREFIX + 'g2')!);
    expect(g1).toHaveLength(2);
    expect(g2).toHaveLength(1);
    expect(g1.map((m: GroupMessageData) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(g2[0].id).toBe('m3');
  });

  it('migrates legacy members blob forward and removes it', async () => {
    const groups = [makeGroup('g1'), makeGroup('g2')];
    const legacyMembers: GroupMemberData[] = [
      makeMember('g1', PEER_B),
      makeMember('g1', PEER_C),
      makeMember('g2', MY_PUBKEY),
    ];

    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS, JSON.stringify(legacyMembers));

    await mod.load();

    expect(storage._data.has(MEMBERS_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(MEMBERS_PREFIX + 'g2')).toBe(true);
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS)).toBe(false);
    const g1 = JSON.parse(storage._data.get(MEMBERS_PREFIX + 'g1')!);
    expect(g1).toHaveLength(2);
  });

  it('post-migration boot reads per-group keys and ignores absent legacy', async () => {
    // Seed only per-group keys (no legacy blob).
    storage._data.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS,
      JSON.stringify([makeGroup('g1'), makeGroup('g2')]),
    );
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify([makeMessage('m1', 'g1')]));
    storage._data.set(MESSAGES_PREFIX + 'g2', JSON.stringify([makeMessage('m2', 'g2')]));

    await mod.load();

    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    expect(messagesMap.get('g1')).toHaveLength(1);
    expect(messagesMap.get('g2')).toHaveLength(1);
    // Storage shouldn't have gained the legacy blob.
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES)).toBe(false);
  });

  it('partial migration: messages on per-group, members still legacy', async () => {
    // Simulate a prior run that migrated messages successfully but failed to
    // migrate members before `storage.remove(LEGACY_MEMBERS)`.
    const groups = [makeGroup('g1')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify([makeMessage('m1', 'g1')]));
    // Legacy members blob still there from the prior run.
    storage._data.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS,
      JSON.stringify([makeMember('g1', PEER_B)]),
    );

    await mod.load();

    // Messages loaded from per-group; legacy never touched.
    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    expect(messagesMap.get('g1')).toHaveLength(1);
    // Members migrated on this boot; legacy gone.
    expect(storage._data.has(MEMBERS_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS)).toBe(false);
  });

  it('orphan cleanup: leaving a group removes its per-group keys', async () => {
    const groups = [makeGroup('g1'), makeGroup('g2')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify([makeMessage('m1', 'g1')]));
    storage._data.set(MESSAGES_PREFIX + 'g2', JSON.stringify([makeMessage('m2', 'g2')]));
    storage._data.set(MEMBERS_PREFIX + 'g1', JSON.stringify([makeMember('g1', PEER_B)]));
    storage._data.set(MEMBERS_PREFIX + 'g2', JSON.stringify([makeMember('g2', PEER_B)]));

    await mod.load();

    // Simulate leaving g2: drop from in-memory state + persist.
    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    const membersMap = (mod as any).members as Map<string, GroupMemberData[]>;
    messagesMap.delete('g2');
    membersMap.delete('g2');

    await (mod as any).persistMessages();
    await (mod as any).persistMembers();

    // g1 keys retained, g2 keys cleaned up.
    expect(storage._data.has(MESSAGES_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(MESSAGES_PREFIX + 'g2')).toBe(false);
    expect(storage._data.has(MEMBERS_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(MEMBERS_PREFIX + 'g2')).toBe(false);
  });

  it('corrupt legacy blob: leaves legacy in place, starts fresh in memory', async () => {
    const groups = [makeGroup('g1')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES, '{corrupt json without quotes');

    await mod.load();

    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    expect(messagesMap.size).toBe(0);
    // Corrupt legacy is deliberately NOT removed — preserves forensic data
    // and prevents inadvertent data loss on transient parse failures.
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES)).toBe(true);
  });

  it('corrupt per-group blob: that group loads empty, others unaffected', async () => {
    const groups = [makeGroup('g1'), makeGroup('g2')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(MESSAGES_PREFIX + 'g1', '{garbage');
    storage._data.set(MESSAGES_PREFIX + 'g2', JSON.stringify([makeMessage('m2', 'g2')]));

    await mod.load();

    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    expect(messagesMap.has('g1')).toBe(false); // corrupt → skipped
    expect(messagesMap.get('g2')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Steelman fixes — critical + warnings
  // ---------------------------------------------------------------------------

  it('regression: partial migration across groups completes on next load (critical fix)', async () => {
    // Scenario: a prior migration wrote per-group messages for g1 but
    // crashed before g2/g3. Legacy blob was never removed. On the next
    // load, g2 and g3 must still migrate — pre-fix, the presence of g1's
    // per-group key caused the whole legacy migration to be skipped.
    const groups = [makeGroup('g1'), makeGroup('g2'), makeGroup('g3')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    // g1 already migrated to per-group (fresher data — per-group wins).
    storage._data.set(
      MESSAGES_PREFIX + 'g1',
      JSON.stringify([makeMessage('m1_new', 'g1', 5000)]),
    );
    // Legacy still present with g1 (stale) + g2 + g3.
    const legacy: GroupMessageData[] = [
      makeMessage('m1_stale', 'g1', 1000), // superseded by per-group
      makeMessage('m2', 'g2', 2000),
      makeMessage('m3a', 'g3', 3000),
      makeMessage('m3b', 'g3', 3500),     // multiple messages per group — must all migrate
    ];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES, JSON.stringify(legacy));

    await mod.load();

    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    // Per-group data for g1 preserved (newer — "per-group wins" policy).
    expect(messagesMap.get('g1')?.map((m) => m.id)).toEqual(['m1_new']);
    // g2 migrated from legacy.
    expect(messagesMap.get('g2')?.map((m) => m.id)).toEqual(['m2']);
    // g3 migrated from legacy — BOTH messages, not just the first
    // (guards the perGroupCovered snapshot fix).
    expect(messagesMap.get('g3')?.map((m) => m.id).sort()).toEqual(['m3a', 'm3b']);
    // Per-group keys written for the migrated groups.
    expect(storage._data.has(MESSAGES_PREFIX + 'g2')).toBe(true);
    expect(storage._data.has(MESSAGES_PREFIX + 'g3')).toBe(true);
    // Legacy blob removed after successful migration.
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES)).toBe(false);
  });

  it('pre-existing orphan cleanup: persist removes keys for groups not in current membership', async () => {
    // Simulate: prior session wrote per-group keys for g1/g2/g3. Current
    // session only knows about g1/g2 (user left g3 while offline, groups
    // blob updated on the relay). On first persist, the stale g3 key
    // should be removed — pre-fix, only keys written IN this session were
    // tracked for cleanup, so g3 would orphan indefinitely.
    const groups = [makeGroup('g1'), makeGroup('g2')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify([makeMessage('m1', 'g1')]));
    storage._data.set(MESSAGES_PREFIX + 'g2', JSON.stringify([makeMessage('m2', 'g2')]));
    // Orphan from a prior session — g3 no longer in this.groups.
    storage._data.set(MESSAGES_PREFIX + 'g3', JSON.stringify([makeMessage('m3', 'g3')]));

    await mod.load();
    // Trigger a persist — any mutation path would do; here we call directly.
    await (mod as any).persistMessages();

    expect(storage._data.has(MESSAGES_PREFIX + 'g1')).toBe(true);
    expect(storage._data.has(MESSAGES_PREFIX + 'g2')).toBe(true);
    // Pre-fix: g3 stayed. Post-fix: cleaned up because `keys()`-seeded
    // tracking observed it.
    expect(storage._data.has(MESSAGES_PREFIX + 'g3')).toBe(false);
  });

  it('non-array legacy data: leaves legacy blob in place, no migration', async () => {
    // Parses cleanly but is an object, not an array — e.g., schema drift
    // or mixed-up file. Pre-fix, the for-of loop would have produced
    // `undefined` groupIds and polluted storage with `group_chat_messages:undefined`.
    // Post-fix, the Array.isArray guard bails out early.
    const groups = [makeGroup('g1')];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(groups));
    storage._data.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES,
      JSON.stringify({ notAnArray: true }),
    );

    await mod.load();

    const messagesMap = (mod as any).messages as Map<string, GroupMessageData[]>;
    expect(messagesMap.size).toBe(0);
    // Legacy left in place (forensic preservation).
    expect(storage._data.has(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES)).toBe(true);
    // No `group_chat_messages:undefined` garbage key.
    expect(storage._data.has(MESSAGES_PREFIX + 'undefined')).toBe(false);
  });
});
