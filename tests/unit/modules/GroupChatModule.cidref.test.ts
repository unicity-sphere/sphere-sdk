/**
 * GroupChatModule CID-refs tests (#98b — commit 7b.2 of fat-data migration).
 *
 * Validates the split-encryption policy:
 *   - groups          → Pattern A, ENCRYPTED (per-wallet membership view)
 *   - members:<gid>   → Pattern A, ENCRYPTED (per-wallet view of group)
 *   - messages:<gid>  → Pattern A, PLAINTEXT (NIP-29 messages relay-plaintext →
 *                       IPFS content-addressed dedup across member wallets)
 *
 * Covers:
 *   1. Encrypted CID refs for groups + members
 *   2. PLAINTEXT CID refs for messages + the dedup property (same content
 *      across different wallet keys → same CID)
 *   3. Self-describing fetch — ref.enc drives decryption
 *   4. requireEncrypted strict mode rejects poisoned refs for groups + members
 *   5. Dual-read migration from partitioned plaintext blobs → CID refs
 *   6. Per-group memoization isolation (mutating g1 doesn't re-pin g2)
 *   7. CID_REF_UNREADABLE on config error (ref present + no cidRefStore)
 *   8. Orphan cleanup still works and also evicts per-group memos
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
    description: 'Mock',
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

function createDeps(storage: StorageProvider, cidRefStore?: unknown): GroupChatModuleDependencies {
  const identity: FullIdentity = {
    privateKey: '01'.padStart(64, '0'),
    chainPubkey: MY_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    nametag: 'testuser',
  };
  return {
    identity,
    storage,
    emitEvent: vi.fn(),
    cidRefStore: cidRefStore as never,
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
  return { groupId, pubkey, role: GroupRoleEnum.MEMBER, joinedAt: 1000 } as GroupMemberData;
}

/**
 * Fake CidRefStore with the full plaintext/encrypted mode surface.
 * Uses real base32-encoded CIDv1 strings so tryParseRef accepts them.
 * The "cid" is assigned deterministically from an index counter so tests
 * can observe which index maps to which pin.
 */
function makeFakeCidRefStore() {
  const ipfsStore = new Map<string, { bytes: Uint8Array; enc: boolean }>();
  const FAKE_CIDS = [
    'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
    'bafkreif4jkpxy2j7hezb2kjfb2mk23wsq5s7vzlqfkwnofkcfxsikiznna',
    'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau',
    'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu',
    'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq',
    'bafkreif5kllzmkgl2euhmuarujbx2c4qc6ys4ezbdkotl4vfzywifgj36i',
    'bafkreihgwgjb76y4evzixnyhurnscy46rtuekx2gojy63zvyexmptzq4pi',
    'bafkreib5rv2rsfv3d7x57grexkl2prw2wmz4eojpyk2xmeugzszvtefyfy',
  ];
  let next = 0;
  const pickCid = () => FAKE_CIDS[next++ % FAKE_CIDS.length]!;

  const fakeStore = {
    pinBytes: vi.fn(async (bytes: Uint8Array, opts?: { encrypted?: boolean }) => {
      const encryptedMode = opts?.encrypted ?? true;
      const cid = pickCid();
      ipfsStore.set(cid, { bytes: new Uint8Array(bytes), enc: encryptedMode });
      const ref: any = {
        v: 1,
        cid,
        size: bytes.byteLength,
        ts: Date.now(),
      };
      if (!encryptedMode) ref.enc = false;
      return ref;
    }),
    pinJson: vi.fn(async (value: unknown, opts?: { encrypted?: boolean }) => {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json);
      return fakeStore.pinBytes(bytes, opts);
    }),
    fetchBytes: vi.fn(async (ref: { cid: string }) => {
      const entry = ipfsStore.get(ref.cid);
      if (!entry) throw new Error(`CID not found: ${ref.cid}`);
      return entry.bytes;
    }),
    fetchJson: vi.fn(async (ref: { cid: string; enc?: boolean }, opts?: { requireEncrypted?: boolean }) => {
      // Simulate requireEncrypted enforcement — the real CidRefStore does this.
      if (opts?.requireEncrypted && ref.enc === false) {
        const err: any = new Error('requireEncrypted violated');
        err.code = 'CID_REF_CORRUPT';
        throw err;
      }
      const entry = ipfsStore.get(ref.cid);
      if (!entry) throw new Error(`CID not found: ${ref.cid}`);
      return JSON.parse(new TextDecoder().decode(entry.bytes));
    }),
  };
  return { fakeStore, ipfsStore };
}

/** Helper to read the `enc` field recorded at IPFS-side (for plaintext-pin assertions). */
function getStoredMode(ipfsStore: Map<string, { bytes: Uint8Array; enc: boolean }>, cid: string): boolean {
  return ipfsStore.get(cid)!.enc;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// =============================================================================
// Tests
// =============================================================================

describe('GroupChatModule — CID-refs persistence (commit 7b.2)', () => {
  let storage: StorageProvider & { _data: Map<string, string> };

  beforeEach(() => {
    storage = createMockStorage();
  });

  // ---------------------------------------------------------------------------
  // Encryption-mode policy per key class
  // ---------------------------------------------------------------------------

  it('groups: writes ENCRYPTED CID ref', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    // Trigger persist by calling direct.
    await (mod as any).persistGroups();

    const kv = storage._data.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS)!;
    const refEnv = JSON.parse(kv);
    expect(refEnv.v).toBe(1);
    expect(refEnv.cid).toMatch(/^baf/);
    // Encrypted mode → no `enc` field in envelope (stays absent for backward compat).
    expect(refEnv.enc).toBeUndefined();
    expect(getStoredMode(ipfsStore, refEnv.cid)).toBe(true);
  });

  it('members: writes ENCRYPTED CID ref per groupId', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    (mod as any).members.set('g1', [makeMember('g1', PEER_B)]);
    await (mod as any).persistMembers();

    const kv = storage._data.get(MEMBERS_PREFIX + 'g1')!;
    const refEnv = JSON.parse(kv);
    expect(refEnv.enc).toBeUndefined();
    expect(getStoredMode(ipfsStore, refEnv.cid)).toBe(true);
  });

  it('messages: writes PLAINTEXT CID ref per groupId (dedup-enabling)', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    (mod as any).messages.set('g1', [makeMessage('m1', 'g1')]);
    await (mod as any).persistMessages();

    const kv = storage._data.get(MESSAGES_PREFIX + 'g1')!;
    const refEnv = JSON.parse(kv);
    // Plaintext mode → `enc: false` serialized in envelope (self-describing).
    expect(refEnv.enc).toBe(false);
    expect(getStoredMode(ipfsStore, refEnv.cid)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Dedup property — the whole reason messages pin plaintext
  // ---------------------------------------------------------------------------

  it('dedup: two wallets pinning the same message content produce the same CID', async () => {
    // Simulate Alice and Bob independently pinning identical message lists
    // for group g1. With plaintext mode, both should produce the same CID
    // (content-addressing converges across wallets).
    //
    // The fake uses a pre-baked lookup table: valid base32 CIDs keyed by
    // a trivial hash of the serialized content. Two invocations with the
    // same content pick the same CID → models IPFS content-addressing
    // faithfully enough for the dedup assertion.
    const VALID_CIDS = [
      'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
      'bafkreif4jkpxy2j7hezb2kjfb2mk23wsq5s7vzlqfkwnofkcfxsikiznna',
      'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau',
      'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu',
      'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq',
      'bafkreif5kllzmkgl2euhmuarujbx2c4qc6ys4ezbdkotl4vfzywifgj36i',
      'bafkreihgwgjb76y4evzixnyhurnscy46rtuekx2gojy63zvyexmptzq4pi',
      'bafkreib5rv2rsfv3d7x57grexkl2prw2wmz4eojpyk2xmeugzszvtefyfy',
    ];
    function cidFromContent(bytes: Uint8Array): string {
      // Trivial FNV-like hash over the plaintext — enough to distinguish
      // distinct content within test scope while being deterministic.
      let h = 0x811c9dc5;
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
      return VALID_CIDS[h % VALID_CIDS.length]!;
    }

    const aliceIpfs = new Map<string, { bytes: Uint8Array; enc: boolean }>();
    const bobIpfs = new Map<string, { bytes: Uint8Array; enc: boolean }>();

    function makeContentAddressingFake(localIpfs: typeof aliceIpfs) {
      return {
        pinJson: vi.fn(async (value: unknown, opts?: { encrypted?: boolean }) => {
          const bytes = new TextEncoder().encode(JSON.stringify(value));
          const encryptedMode = opts?.encrypted ?? true;
          // IMPORTANT: encrypted pins would go through AES-GCM which mixes
          // in a random IV, producing different ciphertexts per wallet. We
          // simulate that by seeding the hash with a wallet-unique salt
          // when encrypting. Plaintext pins skip salting → dedup converges.
          const contentForHash = encryptedMode
            ? concatBytes(new TextEncoder().encode(String(Math.random())), bytes)
            : bytes;
          const cid = cidFromContent(contentForHash);
          localIpfs.set(cid, { bytes, enc: encryptedMode });
          return {
            v: 1 as const,
            cid,
            size: bytes.byteLength,
            ts: Date.now(),
            ...(!encryptedMode ? { enc: false as const } : {}),
          };
        }),
        fetchJson: vi.fn(),
        pinBytes: vi.fn(),
        fetchBytes: vi.fn(),
      };
    }

    const aliceStore = makeContentAddressingFake(aliceIpfs);
    const bobStore = makeContentAddressingFake(bobIpfs);

    const messages = [makeMessage('m1', 'g1'), makeMessage('m2', 'g1', 2000)];

    const aliceMod = new GroupChatModule();
    aliceMod.initialize(createDeps(createMockStorage(), aliceStore));
    (aliceMod as any).groups.set('g1', makeGroup('g1'));
    (aliceMod as any).messages.set('g1', messages);
    await (aliceMod as any).persistMessages();

    const bobMod = new GroupChatModule();
    bobMod.initialize(createDeps(createMockStorage(), bobStore));
    (bobMod as any).groups.set('g1', makeGroup('g1'));
    (bobMod as any).messages.set('g1', messages);
    await (bobMod as any).persistMessages();

    // Both pinned plaintext → same content hash → same CID.
    expect(Array.from(aliceIpfs.keys())).toEqual(Array.from(bobIpfs.keys()));
  });

  // ---------------------------------------------------------------------------
  // Load path — CID ref round-trip + requireEncrypted enforcement
  // ---------------------------------------------------------------------------

  it('load: reads groups via CID ref (requires encrypted)', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    // Pre-populate: pin groups list + seed a ref envelope.
    const groups = [makeGroup('g1')];
    const ref = await fakeStore.pinJson(groups);
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(ref));

    await mod.load();
    expect((mod as any).groups.get('g1')).toEqual(groups[0]);
    // Verify requireEncrypted was passed on the fetch.
    expect(fakeStore.fetchJson).toHaveBeenCalledWith(
      expect.any(Object),
      { requireEncrypted: true },
    );
  });

  it('load: reads messages via plaintext CID ref (no requireEncrypted)', async () => {
    const { fakeStore, ipfsStore: _unused } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    const messages = [makeMessage('m1', 'g1')];
    const ref = await fakeStore.pinJson(messages, { encrypted: false });
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify(ref));

    await mod.load();
    expect((mod as any).messages.get('g1')).toEqual(messages);
    // Verify fetch was NOT called with requireEncrypted.
    const callArgs = fakeStore.fetchJson.mock.calls[0]!;
    expect(callArgs[1]).toBeUndefined();
  });

  it('load: rejects a hostile plaintext ref for members (requireEncrypted strict)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    // Attacker pins a plaintext ref and smuggles it into a members key.
    // The fake store's fetchJson simulates the real requireEncrypted check.
    const hostileRef = await fakeStore.pinJson([makeMember('g1', PEER_B)], { encrypted: false });
    storage._data.set(MEMBERS_PREFIX + 'g1', JSON.stringify(hostileRef));

    await mod.load();
    // Members for g1 should NOT be populated — the fetch was rejected.
    expect((mod as any).members.has('g1')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Legacy → CID-ref migration
  // ---------------------------------------------------------------------------

  it('migration: legacy partitioned messages plaintext blob is read, then re-pinned as plaintext CID ref', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    // Legacy (post-#98a, pre-#98b) partitioned inline JSON.
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify([makeMessage('m1', 'g1')]));

    await mod.load();
    expect((mod as any).messages.get('g1')?.length).toBe(1);

    // No auto-migration on load — persist happens on next write. Simulate:
    (mod as any).messages.get('g1').push(makeMessage('m2', 'g1'));
    await (mod as any).persistMessages();

    // Now the KV holds a CID ref envelope, not inline JSON.
    const kv = storage._data.get(MESSAGES_PREFIX + 'g1')!;
    const env = JSON.parse(kv);
    expect(env.cid).toMatch(/^baf/);
    expect(env.enc).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Per-group memoization isolation
  // ---------------------------------------------------------------------------

  it('memoization: unchanged messages for g1 do not re-pin when g2 changes', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    storage._data.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS,
      JSON.stringify([makeGroup('g1'), makeGroup('g2')]),
    );
    await mod.load();

    (mod as any).messages.set('g1', [makeMessage('m1', 'g1')]);
    (mod as any).messages.set('g2', [makeMessage('m2', 'g2')]);
    await (mod as any).persistMessages();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(2);

    // Mutate only g2.
    (mod as any).messages.get('g2').push(makeMessage('m3', 'g2'));
    await (mod as any).persistMessages();

    // g1 memo hit; g2 re-pinned → exactly 3 pin calls total.
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------------------
  // Config error: CID_REF_UNREADABLE
  // ---------------------------------------------------------------------------

  it('throws CID_REF_UNREADABLE when ref present and cidRefStore absent', async () => {
    // Inject cidRefStore only to create the ref, then detach.
    const { fakeStore } = makeFakeCidRefStore();
    const ref = await fakeStore.pinJson([makeGroup('g1')]);
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(ref));

    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage)); // NO cidRefStore
    await expect(mod.load()).rejects.toThrow(/CID_REF_UNREADABLE/);
  });

  // ---------------------------------------------------------------------------
  // Orphan cleanup + memo eviction
  // ---------------------------------------------------------------------------

  it('leaving a group evicts the per-group memo (next rejoin pins fresh)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    storage._data.set(
      STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS,
      JSON.stringify([makeGroup('g1'), makeGroup('g2')]),
    );
    await mod.load();

    (mod as any).messages.set('g1', [makeMessage('m1', 'g1')]);
    (mod as any).messages.set('g2', [makeMessage('m2', 'g2')]);
    await (mod as any).persistMessages();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(2);

    // Leave g2.
    (mod as any).messages.delete('g2');
    await (mod as any).persistMessages();

    // g1 memo hit, g2 orphan-cleaned (key removed AND memo evicted).
    expect(storage._data.has(MESSAGES_PREFIX + 'g2')).toBe(false);
    expect((mod as any)._lastPinnedMessagesByGroup.has('g2')).toBe(false);
    expect((mod as any)._lastPinnedMessagesByGroup.has('g1')).toBe(true);
  });
});
