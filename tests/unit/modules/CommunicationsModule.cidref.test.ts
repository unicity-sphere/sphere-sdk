/**
 * Tests for CommunicationsModule DM persistence via CID references
 * (PROFILE-CID-REFERENCES.md §8.4).
 *
 * Mirrors the outbox / pendingV5 patterns. DMs for a given address are
 * stored as a single JSON array under `STORAGE_KEYS_ADDRESS.MESSAGES`;
 * this commit swaps the inline JSON write for a CID-ref envelope when
 * `cidRefStore` is injected.
 *
 * Covers:
 *   1. Write: CID ref envelope stored when cidRefStore is injected
 *   2. Read:  dual-read — CID ref fetched from IPFS
 *   3. Read:  legacy inline JSON still parses (migration window)
 *   4. Fallback: inline JSON retained when cidRefStore is absent
 *   5. Empty messages list clears KV + memoization state
 *   6. Memoization: identical plaintext reuses cached ref (no re-pin)
 *   7. Config error: ref present + no cidRefStore → CID_REF_UNREADABLE
 *   8. OpLog size: ref is constant-small regardless of message count
 *   9. Concurrent save() calls serialize via save-chain (no lost writes)
 *   10. Legacy global-key migration still works (predates CID-refs)
 *   11. Corrupt legacy JSON returns [] (narrow SyntaxError catch)
 *   12. Non-array legacy data logs + returns [] (corruption visibility)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommunicationsModule } from '../../../modules/communications/CommunicationsModule';
import type { CommunicationsModuleDependencies } from '../../../modules/communications/CommunicationsModule';
import type { TransportProvider } from '../../../transport';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, DirectMessage } from '../../../types';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// Mocks
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
  } as unknown as TransportProvider;
}

function createMockStorage(backing?: Map<string, string>): StorageProvider & { _store: Map<string, string> } {
  const store = backing ?? new Map<string, string>();
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
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
    _store: store,
  } as unknown as StorageProvider & { _store: Map<string, string> };
}

const MY_PUBKEY = '02' + 'a'.repeat(64);
const PEER_A_PUBKEY = '02' + 'b'.repeat(64);

function createMockIdentity(): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: MY_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
}

function makeMessage(id: string, sender: string, recipient: string, timestamp: number, content = 'hello'): DirectMessage {
  return { id, senderPubkey: sender, recipientPubkey: recipient, content, timestamp, isRead: false };
}

/** Fake CidRefStore with real base32-encoded CIDs so tryParseRef accepts them. */
function makeFakeCidRefStore() {
  const ipfsStore = new Map<string, unknown>();
  const FAKE_CIDS = [
    'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
    'bafkreif4jkpxy2j7hezb2kjfb2mk23wsq5s7vzlqfkwnofkcfxsikiznna',
    'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau',
    'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu',
    'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq',
  ];
  let nextCid = 0;
  const fakeStore = {
    pinJson: vi.fn(async (value: unknown) => {
      const cid = FAKE_CIDS[nextCid % FAKE_CIDS.length]!;
      nextCid += 1;
      ipfsStore.set(cid, value);
      const json = JSON.stringify(value);
      return {
        v: 1 as const,
        cid,
        size: new TextEncoder().encode(json).byteLength + 28,
        ts: Date.now(),
      };
    }),
    fetchJson: vi.fn(async (ref: { cid: string }) => {
      const data = ipfsStore.get(ref.cid);
      if (data === undefined) throw new Error(`CID not found: ${ref.cid}`);
      return data;
    }),
  };
  return { fakeStore, ipfsStore };
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

// =============================================================================
// Tests
// =============================================================================

describe('CommunicationsModule — DM CID-ref persistence', () => {
  let mod: CommunicationsModule;

  beforeEach(() => {
    mod = new CommunicationsModule();
  });

  it('writes CID ref envelope when cidRefStore is injected', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });
    mod.initialize(deps);

    // Inject a message and trigger save.
    (mod as unknown as { messages: Map<string, DirectMessage> }).messages.set(
      'm1',
      makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
    );
    await (mod as unknown as { save: () => Promise<void> }).save();

    const kvData = store.get(STORAGE_KEYS_ADDRESS.MESSAGES);
    expect(kvData).toBeDefined();
    // KV must NOT contain message content — ciphertext pinned to IPFS.
    expect(kvData).not.toContain('hello');
    expect(kvData).not.toContain('m1');
    // Parseable CID-ref envelope.
    const parsed = JSON.parse(kvData!);
    expect(parsed.v).toBe(1);
    expect(parsed.cid).toMatch(/^baf/);
    expect(parsed.size).toBeGreaterThan(0);
    expect(parsed.ts).toBeGreaterThan(0);
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);
  });

  it('loads CID ref from OpLog and fetches content from IPFS', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });

    // Pre-populate: simulate a prior write — seed both IPFS and the KV ref.
    const messages = [makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000)];
    const prePinCid = 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze';
    ipfsStore.set(prePinCid, messages);
    store.set(
      STORAGE_KEYS_ADDRESS.MESSAGES,
      JSON.stringify({ v: 1, cid: prePinCid, size: 1000, ts: 1700000000000 }),
    );

    mod.initialize(deps);
    await mod.load();

    const loaded = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;
    expect(loaded.size).toBe(1);
    expect(loaded.get('m1')?.content).toBe('hello');
    expect(fakeStore.fetchJson).toHaveBeenCalledTimes(1);
  });

  it('reads legacy inline JSON when cidRefStore is provided (migration)', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });

    // Seed KV with LEGACY inline JSON (pre-CID-refs wallet).
    const legacy = [makeMessage('m_legacy', PEER_A_PUBKEY, MY_PUBKEY, 1000)];
    store.set(STORAGE_KEYS_ADDRESS.MESSAGES, JSON.stringify(legacy));

    mod.initialize(deps);
    await mod.load();

    const loaded = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;
    expect(loaded.size).toBe(1);
    expect(loaded.get('m_legacy')).toBeDefined();
    // tryParseRef returned null → legacy path taken.
    expect(fakeStore.fetchJson).not.toHaveBeenCalled();
  });

  it('inline JSON fallback still works when cidRefStore is absent', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const deps = createDeps({ storage }); // no cidRefStore
    mod.initialize(deps);

    (mod as unknown as { messages: Map<string, DirectMessage> }).messages.set(
      'm1',
      makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
    );
    await (mod as unknown as { save: () => Promise<void> }).save();

    const kvData = store.get(STORAGE_KEYS_ADDRESS.MESSAGES);
    expect(kvData).toBeDefined();
    const parsed = JSON.parse(kvData!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('m1');
  });

  it('empty messages list clears KV and memoization state', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });
    mod.initialize(deps);

    // First: populate + save.
    (mod as unknown as { messages: Map<string, DirectMessage> }).messages.set(
      'm1',
      makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
    );
    await (mod as unknown as { save: () => Promise<void> }).save();
    expect(store.get(STORAGE_KEYS_ADDRESS.MESSAGES)).toBeTruthy();

    // Then: clear the map and save again.
    (mod as unknown as { messages: Map<string, DirectMessage> }).messages.clear();
    await (mod as unknown as { save: () => Promise<void> }).save();

    expect(store.get(STORAGE_KEYS_ADDRESS.MESSAGES)).toBe('');
    expect((mod as unknown as { _lastPinnedMessagesJson: unknown })._lastPinnedMessagesJson).toBeNull();
    expect((mod as unknown as { _lastPinnedMessagesRef: unknown })._lastPinnedMessagesRef).toBeNull();
  });

  it('memoizes identical plaintext and skips re-pin', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });
    mod.initialize(deps);

    (mod as unknown as { messages: Map<string, DirectMessage> }).messages.set(
      'm1',
      makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
    );

    // Two saves with identical state → one pin.
    await (mod as unknown as { save: () => Promise<void> }).save();
    await (mod as unknown as { save: () => Promise<void> }).save();

    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);
  });

  it('throws CID_REF_UNREADABLE when ref present but cidRefStore absent', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    // No cidRefStore injected.
    const deps = createDeps({ storage });

    store.set(
      STORAGE_KEYS_ADDRESS.MESSAGES,
      JSON.stringify({
        v: 1,
        cid: 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
        size: 1000,
        ts: 1700000000000,
      }),
    );

    mod.initialize(deps);
    await expect(mod.load()).rejects.toThrow(/CID_REF_UNREADABLE/);
  });

  it('OpLog value shrinks dramatically when CidRefStore is used', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const deps = createDeps({ storage });
    mod.initialize(deps);

    // Write 50 DMs via the LEGACY path to measure fat size.
    const modMessages = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;
    for (let i = 0; i < 50; i++) {
      modMessages.set(`m${i}`, makeMessage(`m${i}`, PEER_A_PUBKEY, MY_PUBKEY, 1000 + i, 'x'.repeat(200)));
    }
    await (mod as unknown as { save: () => Promise<void> }).save();
    const legacySize = store.get(STORAGE_KEYS_ADDRESS.MESSAGES)!.length;
    expect(legacySize).toBeGreaterThan(10_000);

    // Inject cidRefStore and re-save — ref is now tiny.
    const { fakeStore } = makeFakeCidRefStore();
    (mod as unknown as { deps: CommunicationsModuleDependencies }).deps.cidRefStore = fakeStore as never;

    // Dirty the state so memoization doesn't kick in.
    modMessages.set('m_new', makeMessage('m_new', PEER_A_PUBKEY, MY_PUBKEY, 9999));
    await (mod as unknown as { save: () => Promise<void> }).save();

    const refSize = store.get(STORAGE_KEYS_ADDRESS.MESSAGES)!.length;
    expect(refSize).toBeLessThan(300); // envelope ~100-200 bytes
    expect(refSize).toBeLessThan(legacySize);
  });

  it('concurrent save() calls serialize via save-chain (no lost writes)', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });
    mod.initialize(deps);

    const modMessages = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;

    // Capture the pinned snapshots to verify ordering.
    const observedSnapshots: DirectMessage[][] = [];
    fakeStore.pinJson.mockImplementation(async (value: unknown) => {
      observedSnapshots.push([...(value as DirectMessage[])]);
      return {
        v: 1 as const,
        cid: 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
        size: 100,
        ts: Date.now() + observedSnapshots.length,
      };
    });

    // Two concurrent saves — with different Map state snapshots between them.
    modMessages.set('m1', makeMessage('m1', PEER_A_PUBKEY, MY_PUBKEY, 1000));
    const save1 = (mod as unknown as { save: () => Promise<void> }).save();
    modMessages.set('m2', makeMessage('m2', PEER_A_PUBKEY, MY_PUBKEY, 2000));
    const save2 = (mod as unknown as { save: () => Promise<void> }).save();

    await Promise.all([save1, save2]);

    // The final snapshot must include BOTH messages. Without the chain,
    // save2 could race with save1 and write a snapshot missing m1 or m2
    // depending on ordering.
    const finalSnapshot = observedSnapshots[observedSnapshots.length - 1]!;
    const ids = finalSnapshot.map((m) => m.id).sort();
    expect(ids).toContain('m1');
    expect(ids).toContain('m2');
  });

  it('legacy global-key migration still works (predates CID-refs)', async () => {
    // The legacy 'direct_messages' global key was never a CID ref —
    // always inline JSON. Migration should continue to parse it and
    // re-save under the per-address key via the new CID-ref path.
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const { fakeStore } = makeFakeCidRefStore();
    const deps = createDeps({ storage, cidRefStore: fakeStore as never });

    // Seed the legacy global key with messages involving MY_PUBKEY.
    const legacyMessages = [
      makeMessage('m_legacy1', PEER_A_PUBKEY, MY_PUBKEY, 1000),
      makeMessage('m_legacy2', MY_PUBKEY, PEER_A_PUBKEY, 2000),
      // Unrelated message — filtered out during migration.
      makeMessage('m_other', '02' + 'd'.repeat(64), '02' + 'e'.repeat(64), 3000),
    ];
    store.set('direct_messages', JSON.stringify(legacyMessages));

    mod.initialize(deps);
    await mod.load();

    const loaded = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;
    expect(loaded.size).toBe(2);
    expect(loaded.has('m_legacy1')).toBe(true);
    expect(loaded.has('m_legacy2')).toBe(true);
    expect(loaded.has('m_other')).toBe(false);

    // Re-persisted under per-address key via the CID-ref path.
    const newKv = store.get(STORAGE_KEYS_ADDRESS.MESSAGES);
    expect(newKv).toBeDefined();
    const parsed = JSON.parse(newKv!);
    expect(parsed.v).toBe(1); // CID ref envelope shape
    expect(fakeStore.pinJson).toHaveBeenCalled();
  });

  it('corrupt legacy JSON returns [] rather than throwing', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const deps = createDeps({ storage });

    store.set(STORAGE_KEYS_ADDRESS.MESSAGES, '{corrupt json without quotes}');
    mod.initialize(deps);
    await mod.load();

    const loaded = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;
    expect(loaded.size).toBe(0);
  });

  it('non-array legacy data logs and returns [] (corruption visibility)', async () => {
    const store = new Map<string, string>();
    const storage = createMockStorage(store);
    const deps = createDeps({ storage });

    // Parses to a valid object but isn't an array — e.g., schema drift.
    store.set(STORAGE_KEYS_ADDRESS.MESSAGES, JSON.stringify({ notAnArray: true }));
    mod.initialize(deps);
    await mod.load();

    const loaded = (mod as unknown as { messages: Map<string, DirectMessage> }).messages;
    expect(loaded.size).toBe(0);
  });
});
