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
    // Pattern B: per-message pin + per-group index pin.
    // First persist = 2 groups × (1 message + 1 index) = 4 pins.
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(4);

    // Mutate only g2 — append one new message.
    (mod as any).messages.get('g2').push(makeMessage('m3', 'g2'));
    await (mod as any).persistMessages();

    // Expected delta on the second persist:
    //   g1: index memo hit → 0 pins (messages unchanged).
    //   g2: m2 is in the per-message memo → no re-pin; m3 is new → 1 pin;
    //       index changed → 1 index pin.
    // Total delta = 2. Cumulative = 4 + 2 = 6.
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(6);
  });

  // ---------------------------------------------------------------------------
  // Config degrade: CID_REF_DEGRADE
  //
  // When a stored value carries a CID ref but the wallet was opened without
  // a cidRefStore (e.g. legacy `createBrowserProviders` factory), load() used
  // to throw `ProfileError(CID_REF_UNREADABLE)` and brick every other module's
  // load via the shared `Promise.allSettled`. The page-freeze investigation
  // 2026-05-29 moved this to a logger.warn + start-empty fallback so relay
  // re-delivery can repopulate the state on the next sync.
  // ---------------------------------------------------------------------------

  it('degrades to empty state when groups ref present and cidRefStore absent', async () => {
    // Inject cidRefStore only to create the ref, then detach.
    const { fakeStore } = makeFakeCidRefStore();
    const ref = await fakeStore.pinJson([makeGroup('g1')]);
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(ref));

    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage)); // NO cidRefStore

    // No throw: load resolves, but the groups Map is empty because we
    // can't dereference the CID without a store.
    await expect(mod.load()).resolves.toBeUndefined();
    expect((mod as any).groups.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Orphan cleanup + memo eviction
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Pattern B: per-message CID index (commit 7c / task #101)
  // ---------------------------------------------------------------------------

  it('Pattern B: persistMessages writes an index blob referencing per-message CIDs', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    const messages = [makeMessage('m1', 'g1', 1000), makeMessage('m2', 'g1', 2000)];
    (mod as any).messages.set('g1', messages);
    await (mod as any).persistMessages();

    // KV has the index ref.
    const kv = storage._data.get(MESSAGES_PREFIX + 'g1')!;
    const indexRef = JSON.parse(kv);
    expect(indexRef.v).toBe(1);
    expect(indexRef.cid).toMatch(/^baf/);
    expect(indexRef.enc).toBe(false); // plaintext mode

    // IPFS content at indexRef.cid is a Pattern B index, not a message array.
    const indexBytes = ipfsStore.get(indexRef.cid)!.bytes;
    const index = JSON.parse(new TextDecoder().decode(indexBytes));
    expect(index.v).toBe(1);
    expect(index.items).toHaveLength(2);
    expect(index.items[0]).toMatchObject({ id: 'm1', ts: 1000 });
    expect(index.items[1]).toMatchObject({ id: 'm2', ts: 2000 });
    expect(index.items[0].cid).toMatch(/^baf/);
    expect(index.items[0].cid).not.toBe(index.items[1].cid); // different messages → different CIDs
    expect(typeof index.items[0].size).toBe('number');

    // Each message CID's content is the individual message (not the whole array).
    const m1Bytes = ipfsStore.get(index.items[0].cid)!.bytes;
    const m1 = JSON.parse(new TextDecoder().decode(m1Bytes));
    expect(m1).toEqual(messages[0]);
  });

  it('Pattern B: load reconstructs message array from index + per-message fetches', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    // Round-trip: persist, then recreate a fresh module and load — assert
    // reconstructed state matches what we persisted.
    const original = [
      makeMessage('m1', 'g1', 1000),
      makeMessage('m2', 'g1', 2000),
      makeMessage('m3', 'g1', 3000),
    ];
    (mod as any).messages.set('g1', original);
    await (mod as any).persistMessages();

    const mod2 = new GroupChatModule();
    mod2.initialize(createDeps(storage, fakeStore));
    await mod2.load();

    const reconstructed = (mod2 as any).messages.get('g1') as GroupMessageData[];
    expect(reconstructed).toHaveLength(3);
    const ids = reconstructed.map((m) => m.id).sort();
    expect(ids).toEqual(['m1', 'm2', 'm3']);
  });

  it('Pattern B dedup property: identical messages produce identical message CIDs across wallets', async () => {
    // The whole point of Pattern B — one CID per (content of) message,
    // regardless of array position, regardless of which wallet pinned it.
    // Use two CidRefStore fakes with DIFFERENT "wallet keys" (indicated by
    // separate stores; fakes honor encrypted:false by recording raw bytes,
    // so identical plaintext → identical CID lookup under a content-hash).
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
      let h = 0x811c9dc5;
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
      return VALID_CIDS[h % VALID_CIDS.length]!;
    }
    function makeContentAddressingFake() {
      const localIpfs = new Map<string, Uint8Array>();
      return {
        localIpfs,
        store: {
          pinJson: vi.fn(async (value: unknown, opts?: { encrypted?: boolean }) => {
            const bytes = new TextEncoder().encode(JSON.stringify(value));
            const encryptedMode = opts?.encrypted ?? true;
            // Plaintext mode: content-addressed CID.
            // Encrypted mode: random CID (different per invocation — simulate IV).
            const cid = encryptedMode
              ? VALID_CIDS[Math.floor(Math.random() * VALID_CIDS.length)]!
              : cidFromContent(bytes);
            localIpfs.set(cid, bytes);
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
        },
      };
    }

    const aliceFake = makeContentAddressingFake();
    const bobFake = makeContentAddressingFake();

    // Alice has [m1, m2, m3] in THIS order.
    const aliceMessages = [
      makeMessage('m1', 'g1', 1000),
      makeMessage('m2', 'g1', 2000),
      makeMessage('m3', 'g1', 3000),
    ];
    // Bob has the SAME messages in DIFFERENT order — this is the scenario
    // Pattern A couldn't dedup. Under Pattern B, individual message CIDs
    // are identical regardless of position; only the index CID differs.
    const bobMessages = [
      makeMessage('m1', 'g1', 1000),
      makeMessage('m3', 'g1', 3000),
      makeMessage('m2', 'g1', 2000),
    ];

    const aliceMod = new GroupChatModule();
    aliceMod.initialize(createDeps(createMockStorage(), aliceFake.store));
    (aliceMod as any).groups.set('g1', makeGroup('g1'));
    (aliceMod as any).messages.set('g1', aliceMessages);
    await (aliceMod as any).persistMessages();

    const bobMod = new GroupChatModule();
    bobMod.initialize(createDeps(createMockStorage(), bobFake.store));
    (bobMod as any).groups.set('g1', makeGroup('g1'));
    (bobMod as any).messages.set('g1', bobMessages);
    await (bobMod as any).persistMessages();

    // Collect the per-message CIDs each wallet pinned (exclude the index
    // CID, which differs because of array-order differences).
    // Each pinJson call for a message returns a ref whose cid is in localIpfs.
    // The index is the LAST pinJson call per wallet in our persistMessages
    // implementation. Strip it and compare the remaining message CIDs.
    const aliceMessageCids = Array.from(aliceFake.localIpfs.keys()).slice(0, 3).sort();
    const bobMessageCids = Array.from(bobFake.localIpfs.keys()).slice(0, 3).sort();

    // Same content → same CIDs across wallets, independent of pin order.
    expect(aliceMessageCids).toEqual(bobMessageCids);
  });

  it('Pattern B: per-message memo deduplicates re-pinning within a wallet across persists', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    // First persist: 5 messages + 1 index = 6 pins.
    const msgs = [0, 1, 2, 3, 4].map((i) => makeMessage(`m${i}`, 'g1', 1000 + i));
    (mod as any).messages.set('g1', msgs);
    await (mod as any).persistMessages();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(6);

    // Append one message. Re-persist.
    // Expected: 5 old messages memo hit → 0 re-pins; 1 new message pin;
    // index changed → 1 new index pin. Delta = 2. Cumulative = 6 + 2 = 8.
    (mod as any).messages.get('g1').push(makeMessage('m5', 'g1', 1005));
    await (mod as any).persistMessages();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(8);
  });

  it('Pattern B backward-compat: loads Pattern A content (direct array) and migrates on next persist', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    // Seed: groups + a Pattern A ref (whole array pinned as one CID).
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    const patternAMessages = [makeMessage('m1', 'g1', 1000), makeMessage('m2', 'g1', 2000)];
    const patternARef = await fakeStore.pinJson(patternAMessages, { encrypted: false });
    storage._data.set(MESSAGES_PREFIX + 'g1', JSON.stringify(patternARef));

    await mod.load();
    // Loaded from Pattern A content.
    const loaded = (mod as any).messages.get('g1') as GroupMessageData[];
    expect(loaded.map((m) => m.id).sort()).toEqual(['m1', 'm2']);

    // Migrate on next persist — KV now holds a Pattern B index ref.
    await (mod as any).persistMessages();
    const newKv = storage._data.get(MESSAGES_PREFIX + 'g1')!;
    const newRef = JSON.parse(newKv);
    // The ref points to a new index CID (not the Pattern A array CID).
    expect(newRef.cid).not.toBe(patternARef.cid);
    const newContent = JSON.parse(new TextDecoder().decode(ipfsStore.get(newRef.cid)!.bytes));
    expect(newContent.v).toBe(1);
    expect(Array.isArray(newContent.items)).toBe(true);
    expect(newContent.items).toHaveLength(2);
  });

  it('Pattern B: partial fetch failure on load preserves other messages', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    const msgs = [makeMessage('m1', 'g1', 1000), makeMessage('m2', 'g1', 2000), makeMessage('m3', 'g1', 3000)];
    (mod as any).messages.set('g1', msgs);
    await (mod as any).persistMessages();

    // Corrupt one message's IPFS content by removing it from the fake
    // store. On reload, that fetch fails; the other two still load.
    const kv = JSON.parse(storage._data.get(MESSAGES_PREFIX + 'g1')!);
    const index = JSON.parse(new TextDecoder().decode(ipfsStore.get(kv.cid)!.bytes));
    ipfsStore.delete(index.items[1].cid); // delete m2's content

    const mod2 = new GroupChatModule();
    mod2.initialize(createDeps(storage, fakeStore));
    await mod2.load();
    const survivors = (mod2 as any).messages.get('g1') as GroupMessageData[];
    // 2 of 3 messages survive — the m2 fetch failure was logged and
    // skipped without aborting the whole group.
    expect(survivors).toHaveLength(2);
    const survivorIds = survivors.map((m) => m.id).sort();
    expect(survivorIds).toEqual(['m1', 'm3']);
  });

  // ---------------------------------------------------------------------------
  // Pattern B hardening — caps against hostile indexes (steelman fixes)
  // ---------------------------------------------------------------------------

  it('hardening: rejects index exceeding MAX_INDEX_ITEMS (10 000)', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));

    // Craft a hostile index claiming 10 001 items — exceeds the cap.
    // We don't need 10 001 valid sub-CIDs because the cap check fires
    // BEFORE any per-message fetch.
    const hostileIndex = {
      v: 1,
      items: Array.from({ length: 10_001 }, (_, i) => ({
        id: `m${i}`,
        ts: 1000 + i,
        cid: 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
        size: 100,
      })),
    };
    const indexBytes = new TextEncoder().encode(JSON.stringify(hostileIndex));
    // Install the hostile content into ipfsStore directly + seed the KV
    // with a ref envelope pointing at it.
    const fakeCid = 'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau';
    ipfsStore.set(fakeCid, { bytes: indexBytes, enc: false });
    storage._data.set(
      MESSAGES_PREFIX + 'g1',
      JSON.stringify({ v: 1, cid: fakeCid, size: indexBytes.byteLength, ts: 1700000000000, enc: false }),
    );

    await mod.load();

    // Per-message fetchJson must NOT have been called — cap check fires
    // BEFORE spawning the parallel fetches. The fake's fetchJson is
    // invoked once (for the index itself); anything more would mean the
    // cap was bypassed.
    const perMessageFetches = (fakeStore.fetchJson as any).mock.calls.length - 1; // subtract index fetch
    expect(perMessageFetches).toBe(0);
    // Group's messages map should NOT be populated from the rejected index.
    expect((mod as any).messages.has('g1')).toBe(false);
  });

  it('hardening: skips index items exceeding MAX_GROUP_MESSAGE_SIZE (64 KiB)', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));

    // Index with one legitimate message and one oversized attacker-crafted
    // item pointing at our legitimate content (we don't need to actually
    // pin oversized content — the size-cap check aborts before fetch).
    const legitMessage = makeMessage('m_ok', 'g1', 1000);
    const legitRef = await fakeStore.pinJson(legitMessage, { encrypted: false });

    const hostileIndex = {
      v: 1,
      items: [
        { id: 'm_ok', ts: 1000, cid: legitRef.cid, size: legitRef.size },
        {
          id: 'm_evil',
          ts: 2000,
          cid: legitRef.cid, // irrelevant, cap fires before fetch
          size: 50 * 1024 * 1024, // 50 MiB — way over the 64 KiB cap
        },
      ],
    };
    const indexBytes = new TextEncoder().encode(JSON.stringify(hostileIndex));
    const indexCid = 'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu';
    ipfsStore.set(indexCid, { bytes: indexBytes, enc: false });
    storage._data.set(
      MESSAGES_PREFIX + 'g1',
      JSON.stringify({ v: 1, cid: indexCid, size: indexBytes.byteLength, ts: 1700000000000, enc: false }),
    );

    await mod.load();

    // Legit message loaded; oversized one dropped.
    const loaded = (mod as any).messages.get('g1') as GroupMessageData[];
    expect(loaded.map((m) => m.id)).toEqual(['m_ok']);
  });

  it('hardening: skips malformed index items (missing / wrong-type fields)', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));

    const legitMessage = makeMessage('m_ok', 'g1', 1000);
    const legitRef = await fakeStore.pinJson(legitMessage, { encrypted: false });

    // Index with one legitimate item plus three malformed variants:
    //   * null entry
    //   * primitive (number)
    //   * object missing `cid` field
    const hostileIndex = {
      v: 1,
      items: [
        { id: 'm_ok', ts: 1000, cid: legitRef.cid, size: legitRef.size },
        null,
        42,
        { id: 'm_no_cid', ts: 2000, size: 100 }, // no cid
      ],
    };
    const indexBytes = new TextEncoder().encode(JSON.stringify(hostileIndex));
    const indexCid = 'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq';
    ipfsStore.set(indexCid, { bytes: indexBytes, enc: false });
    storage._data.set(
      MESSAGES_PREFIX + 'g1',
      JSON.stringify({ v: 1, cid: indexCid, size: indexBytes.byteLength, ts: 1700000000000, enc: false }),
    );

    await mod.load();

    const loaded = (mod as any).messages.get('g1') as GroupMessageData[];
    expect(loaded.map((m) => m.id)).toEqual(['m_ok']);
  });

  // ---------------------------------------------------------------------------
  // Save-chain — serializes persist invocations so a fresh message arriving
  // mid-persist can't race the in-flight persist's storage.set.
  // ---------------------------------------------------------------------------

  it('save-chain: concurrent persists serialize — final KV reflects latest state', async () => {
    // Under Pattern B, persistMessages does N+1 awaits. A fresh message
    // arriving while persist-1 is mid-fetch would, pre-chain, kick off
    // persist-2 concurrently. Whoever writes storage last wins; persist-1
    // could finish AFTER persist-2 and overwrite storage with its
    // stale-snapshot index ref.
    //
    // With the chain: persist-2 must wait until persist-1 fully completes
    // before starting. storage.set calls happen in strict order; the
    // LATER persist's ref is the one that ends up in KV.
    const ipfsStore = new Map<string, { bytes: Uint8Array; enc: boolean }>();
    const cidSequence = [
      'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
      'bafkreif4jkpxy2j7hezb2kjfb2mk23wsq5s7vzlqfkwnofkcfxsikiznna',
      'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau',
      'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu',
      'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq',
      'bafkreif5kllzmkgl2euhmuarujbx2c4qc6ys4ezbdkotl4vfzywifgj36i',
      'bafkreihgwgjb76y4evzixnyhurnscy46rtuekx2gojy63zvyexmptzq4pi',
      'bafkreib5rv2rsfv3d7x57grexkl2prw2wmz4eojpyk2xmeugzszvtefyfy',
    ];
    const cidIdx = 0;

    // Gate the FIRST pin call to create a race window — persist-1 is
    // suspended on pinJson while persist-2 is kicked off.
    let pinGateResolve: (() => void) | null = null;
    const pinGate = new Promise<void>((resolve) => {
      pinGateResolve = resolve;
    });
    let pinCallCount = 0;

    const gatedStore = {
      pinJson: vi.fn(async (value: unknown, opts?: { encrypted?: boolean }) => {
        const call = pinCallCount++;
        const cid = cidSequence[call % cidSequence.length]!;
        if (call === 0) {
          // First pin blocks until the test releases it — persist-2 will
          // attempt to schedule during this window.
          await pinGate;
        }
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        const encryptedMode = opts?.encrypted ?? true;
        ipfsStore.set(cid, { bytes, enc: encryptedMode });
        return {
          v: 1 as const,
          cid,
          size: bytes.byteLength,
          ts: Date.now() + call,
          ...(!encryptedMode ? { enc: false as const } : {}),
        };
      }),
      fetchJson: vi.fn(),
      pinBytes: vi.fn(),
      fetchBytes: vi.fn(),
    };

    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, gatedStore));
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify([makeGroup('g1')]));
    await mod.load();

    // Seed initial state.
    (mod as any).messages.set('g1', [makeMessage('m1', 'g1', 1000)]);

    // Kick off persist #1 (blocked on pinGate on its first pin call).
    const persist1 = (mod as any).persistAll();

    // Yield so persist #1 enters the gated pin.
    await Promise.resolve();
    await Promise.resolve();

    // Fresh message arrives mid-persist. Kick off persist #2.
    (mod as any).messages.get('g1').push(makeMessage('m2', 'g1', 2000));
    const persist2 = (mod as any).persistAll();

    // Release the gate — persist #1 completes, then persist #2 runs
    // (chain serializes).
    pinGateResolve!();
    await Promise.all([persist1, persist2]);

    // Distinguishing invariant: the final KV ref points at the INDEX
    // produced by persist #2 (which saw BOTH m1 and m2). Under a broken
    // chain, persist #1's stale-snapshot index ref would have clobbered
    // persist #2's.
    const finalKv = storage._data.get(MESSAGES_PREFIX + 'g1')!;
    const finalRef = JSON.parse(finalKv);
    // Resolve the final index and verify it contains both messages.
    const indexBytes = ipfsStore.get(finalRef.cid)!.bytes;
    const index = JSON.parse(new TextDecoder().decode(indexBytes));
    expect(index.v).toBe(1);
    const ids = (index.items as Array<{ id: string }>).map((i) => i.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

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
    // 2 groups × (1 message pin + 1 index pin) = 4 pins.
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(4);

    // Leave g2.
    (mod as any).messages.delete('g2');
    await (mod as any).persistMessages();

    // g1 memo hit, g2 orphan-cleaned (key removed AND memo evicted).
    expect(storage._data.has(MESSAGES_PREFIX + 'g2')).toBe(false);
    expect((mod as any)._lastPinnedMessagesByGroup.has('g2')).toBe(false);
    expect((mod as any)._lastPinnedMessagesByGroup.has('g1')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // processedEvents — NIP-29 event-id dedup ledger (#285)
  //
  // Production observed 263 KB at this key after routine sphere.telco use
  // and 660 KB at the 10k-entry size cap — both blow the 128 KiB OpLog
  // hard limit. The migration uses Pattern A ENCRYPTED (per-wallet view
  // of which events were processed — a privacy footprint, dedup across
  // wallets has zero value).
  // ---------------------------------------------------------------------------

  it('processedEvents: writes ENCRYPTED CID ref (per-wallet, no plaintext dedup)', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    // No groups needed — processedEvents is module-global.
    await mod.load();
    (mod as any).processedEventIds = new Set(['evt1', 'evt2', 'evt3']);
    await (mod as any).persistProcessedEvents();

    const kv = storage._data.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS)!;
    const refEnv = JSON.parse(kv);
    expect(refEnv.v).toBe(1);
    expect(refEnv.cid).toMatch(/^baf/);
    // Encrypted mode → no `enc` field serialized (default is encrypted).
    expect(refEnv.enc).toBeUndefined();
    expect(getStoredMode(ipfsStore, refEnv.cid)).toBe(true);
    // Pinned content is the array form of the Set.
    const content = JSON.parse(new TextDecoder().decode(ipfsStore.get(refEnv.cid)!.bytes));
    expect(new Set(content)).toEqual(new Set(['evt1', 'evt2', 'evt3']));
  });

  it('processedEvents: identical Set across persists reuses memoised ref (no extra pin)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    await mod.load();

    (mod as any).processedEventIds = new Set(['evtA', 'evtB']);
    await (mod as any).persistProcessedEvents();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);

    // Persist again — no new event → memo hit, no re-pin.
    await (mod as any).persistProcessedEvents();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);

    // Adding an event invalidates the memo → one more pin.
    (mod as any).processedEventIds.add('evtC');
    await (mod as any).persistProcessedEvents();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(2);
  });

  it('processedEvents: load reads via CID ref (requireEncrypted strict)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    // Pre-seed: pin events and write the ref to the KV.
    const events = ['evtX', 'evtY', 'evtZ'];
    const ref = await fakeStore.pinJson(events);
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS, JSON.stringify(ref));

    await mod.load();

    expect((mod as any).processedEventIds).toEqual(new Set(events));
    // Verify strict mode was demanded on the fetch.
    expect(fakeStore.fetchJson).toHaveBeenCalledWith(
      expect.any(Object),
      { requireEncrypted: true },
    );
  });

  it('processedEvents: load tolerates legacy inline JSON (dual-read backward compat)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    // Pre-existing wallet — legacy inline array at the key.
    const events = ['legacy1', 'legacy2'];
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS, JSON.stringify(events));

    await mod.load();

    expect((mod as any).processedEventIds).toEqual(new Set(events));
    // CID-ref fetch path NOT taken — legacy values are plain JSON.
    expect(fakeStore.fetchJson).not.toHaveBeenCalled();
  });

  it('processedEvents: load CID-ref-without-store degrades to empty set', async () => {
    // Matches the groups-key fallback added 2026-05-29 — when the legacy
    // factory wires the module without a cidRefStore, the processedEvents
    // ledger starts fresh and relay re-delivery rehydrates via the
    // idempotent event handlers. The previous throw bricked module load.
    const { fakeStore } = makeFakeCidRefStore();
    const ref = await fakeStore.pinJson(['evt']);
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS, JSON.stringify(ref));

    // Build the module WITHOUT cidRefStore.
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, undefined));

    await expect(mod.load()).resolves.toBeUndefined();
    expect((mod as any).processedEventIds.size).toBe(0);
  });

  it('processedEvents: load CID-ref fetch failure starts fresh (best-effort)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    // Build a ref that points at a CID NOT in the fake store — fetch will throw.
    const orphanRef = {
      v: 1,
      cid: 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
      size: 32,
      ts: Date.now(),
    };
    storage._data.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS, JSON.stringify(orphanRef));

    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));

    // load() must NOT throw — falling back to empty ledger is the right
    // behaviour because relay re-delivery repopulates idempotently.
    await mod.load();
    expect((mod as any).processedEventIds).toEqual(new Set());
  });

  it('processedEvents: legacy fallback when no cidRefStore — inline JSON write (still under cap when small)', async () => {
    // No cidRefStore → write inline. Verifies the legacy code path still
    // functions (used by tests/fallback environments without IPFS).
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, undefined));
    await mod.load();
    (mod as any).processedEventIds = new Set(['e1', 'e2']);
    await (mod as any).persistProcessedEvents();

    const kv = storage._data.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS)!;
    // Plain JSON array — NOT a CID-ref envelope.
    const parsed = JSON.parse(kv);
    expect(Array.isArray(parsed)).toBe(true);
    expect(new Set(parsed)).toEqual(new Set(['e1', 'e2']));
  });

  it('processedEvents: large 10k-entry ledger (~660 KB) round-trips via CID ref under the 128 KiB cap', async () => {
    // Stress-test the #285 BLOCKING case: at 10k entries the legacy inline
    // payload was ~660 KB (5× over the 128 KiB OpLog cap). Through the
    // CID-ref path the OpLog entry shrinks to the ~150-byte ref envelope
    // while the full payload lives at IPFS. This is the production-realistic
    // size we needed to migrate.
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    const mod = new GroupChatModule();
    mod.initialize(createDeps(storage, fakeStore));
    await mod.load();

    // 10000 entries × 64-char IDs ≈ 660 KB plaintext.
    const big = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      big.add(`evt_${i.toString(16).padStart(60, '0')}`);
    }
    (mod as any).processedEventIds = big;
    await (mod as any).persistProcessedEvents();

    const kvRaw = storage._data.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS)!;
    // The OpLog entry itself is now a small CID-ref envelope — under 1 KiB.
    expect(kvRaw.length).toBeLessThan(1024);
    const refEnv = JSON.parse(kvRaw);
    expect(refEnv.v).toBe(1);
    // The big payload now lives at IPFS. Verify size is multiple-MB-scale.
    const stored = ipfsStore.get(refEnv.cid)!;
    expect(stored.bytes.byteLength).toBeGreaterThan(500_000);

    // Round-trip — wipe in-memory state and reload from the seeded KV.
    (mod as any).processedEventIds = new Set();
    await mod.load();
    expect((mod as any).processedEventIds.size).toBe(10_000);
  });
});
