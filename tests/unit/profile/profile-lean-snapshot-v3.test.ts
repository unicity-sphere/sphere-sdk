/**
 * Phase 4 (issue #200) regression tests for the v3 hierarchical
 * lean-snapshot layout.
 *
 * v3 pins the following architectural claims, beyond what
 * profile-lean-snapshot.test.ts (v2-era) covers:
 *
 *   1. The builder emits a MULTI-BLOCK CAR: one root + one per-group
 *      entries sub-block. The root carries `entryGroups[*]` CID
 *      references; each sub-block holds that group's entries inline.
 *   2. Group keys are derived deterministically:
 *      `DIRECT_[0-9a-f]{6}_[0-9a-f]{6}` keys map to their captured
 *      addressId; everything else maps to `__global__`. The CIDs are
 *      a pure function of the per-group entry bytes — so two snapshots
 *      whose entries for the same group are byte-identical share the
 *      same sub-block CID (cross-snapshot dedup at the IPFS layer).
 *   3. `parseLeanProfileSnapshotFromRootBlock` walks per-group
 *      sub-blocks via the supplied fetcher, returning the fully
 *      materialised entries list.
 *   4. `parseLeanProfileSnapshotPartial` fetches ONLY the requested
 *      address groups (+ global), and reports `unfetchedGroupKeys`
 *      for everything it skipped.
 *   5. Determinism: two builds of the same Profile state produce the
 *      same rootCid AND the same set of sub-block CIDs.
 *   6. Backward compatibility: the parser still accepts v2 single-block
 *      snapshots (no fetcher needed).
 *
 * These are EXTRA tests; the original v2-era suite
 * (profile-lean-snapshot.test.ts) continues to pin the cross-cutting
 * round-trip / determinism / filter-reversal / encrypted-form
 * invariants under the new v3 builder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLeanProfileSnapshot,
  parseLeanProfileSnapshot,
  parseLeanProfileSnapshotFromRootBlock,
  parseLeanProfileSnapshotPartial,
  LEAN_PROFILE_SNAPSHOT_VERSION,
  LEAN_PROFILE_SNAPSHOT_GLOBAL_GROUP_KEY,
  type LeanProfileSnapshotBlockFetcher,
} from '../../../extensions/uxf/profile/profile-lean-snapshot';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import type {
  ProviderStatus,
  TrackedAddressEntry,
  FullIdentity,
} from '../../../types';
import type { UxfBundleRef } from '../../../extensions/uxf/profile/types';
import { CarReader } from '@ipld/car';

// =============================================================================
// Test doubles (mirror profile-lean-snapshot.test.ts; minimal surface)
// =============================================================================

class InMemoryStorageProvider implements StorageProvider {
  readonly id = 'memory';
  readonly name = 'Memory';
  readonly type = 'local' as const;
  private data = new Map<string, string>();
  private encrypted = new Map<string, string>();
  private status: ProviderStatus = 'disconnected';

  async connect(): Promise<void> {
    this.status = 'connected';
  }
  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }
  isConnected(): boolean {
    return this.status === 'connected';
  }
  getStatus(): ProviderStatus {
    return this.status;
  }
  setIdentity(_: FullIdentity): void {}

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    this.encrypted.set(key, Buffer.from(`CT(${value})`).toString('base64'));
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
    this.encrypted.delete(key);
  }
  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }
  async keys(prefix?: string): Promise<string[]> {
    const allKeys: string[] = [];
    this.data.forEach((_, k) => allKeys.push(k));
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }
  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.data.clear();
      this.encrypted.clear();
      return;
    }
    const toDelete: string[] = [];
    this.data.forEach((_, k) => {
      if (k.startsWith(prefix)) toDelete.push(k);
    });
    toDelete.forEach((k) => {
      this.data.delete(k);
      this.encrypted.delete(k);
    });
  }
  async saveTrackedAddresses(_: TrackedAddressEntry[]): Promise<void> {}
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    return [];
  }
  async getEncryptedRaw(key: string): Promise<string | null> {
    return this.encrypted.get(key) ?? null;
  }
  async setEncryptedRaw(key: string, value: string): Promise<void> {
    this.encrypted.set(key, value);
  }
}

class FakeTokenStorage {
  _ipfsGateways: string[] = ['http://fake-gateway/'];
  readonly bundleIndex = new Map<string, UxfBundleRef>();
  async listBundles(): Promise<Map<string, UxfBundleRef>> {
    return new Map(this.bundleIndex);
  }
}

const TEST_CHAIN_PUBKEY = '02' + 'aa'.repeat(32);
const TEST_TS = 1_700_000_000_000;
const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';
const ADDR_C = 'DIRECT_778899_aabbcc';

/**
 * Build a CAR-bytes-keyed block map of every block contained in a
 * snapshot CAR. Used to back the fetcher passed into
 * `parseLeanProfileSnapshotFromRootBlock` / `*Partial` so the v3
 * round-trip exercises the link-walking path without touching IPFS.
 *
 * Production wiring binds the fetcher to `fetchFromIpfs`; the test
 * fetcher must replicate the CID-binding guarantee — i.e. the bytes
 * returned for a given CID MUST be the bytes whose sha256 produced
 * that CID. We satisfy that trivially because the map is populated
 * straight from `CarReader.blocks()`, which already exposes the
 * authenticated (cid, bytes) pairs.
 */
async function buildBlockMap(carBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = await CarReader.fromBytes(carBytes);
  const map = new Map<string, Uint8Array>();
  for await (const block of reader.blocks()) {
    map.set(block.cid.toString(), block.bytes);
  }
  return map;
}

async function rootBlockBytesFor(carBytes: Uint8Array): Promise<Uint8Array> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  const rootBlock = await reader.get(roots[0]);
  if (!rootBlock) throw new Error('test setup: root block missing from CAR');
  return rootBlock.bytes;
}

function fetcherFromMap(
  map: Map<string, Uint8Array>,
): LeanProfileSnapshotBlockFetcher {
  return async (cid) => {
    const bytes = map.get(cid);
    if (bytes === undefined) {
      throw new Error(`test fetcher: no block for ${cid}`);
    }
    return bytes;
  };
}

// =============================================================================
// 1 + 5. Builder emits multi-block CAR with per-address sub-blocks (determinism)
// =============================================================================

describe('lean snapshot v3 — multi-block emit + determinism', () => {
  it('emits one root + one sub-block per non-empty group', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();

    // Two addresses with multiple keys each, plus wallet-global keys.
    await storage.set(`${ADDR_A}.outbox.id1`, 'enc:a1');
    await storage.set(`${ADDR_A}.outbox.id2`, 'enc:a2');
    await storage.set(`${ADDR_A}.sent.id3`, 'enc:a3');
    await storage.set(`${ADDR_B}.outbox.id4`, 'enc:b1');
    await storage.set('mnemonic', 'mn');
    await storage.set('master_key', 'mk');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const reader = await CarReader.fromBytes(result.carBytes);
    const roots = await reader.getRoots();
    expect(roots).toHaveLength(1);

    const blocks: Array<{ cid: string }> = [];
    for await (const b of reader.blocks()) blocks.push({ cid: b.cid.toString() });

    // 1 root + 3 group sub-blocks (addr_a, addr_b, __global__).
    expect(blocks).toHaveLength(4);
    // Root block first per CAR ordering invariant.
    expect(blocks[0].cid).toBe(roots[0].toString());
  });

  it('groups keys by addressId; non-prefixed keys fall into __global__', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    await storage.set(`${ADDR_A}.sent.y`, 'v2');
    await storage.set('mnemonic', 'mn');
    await storage.set('addresses.tracked', 'at');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const rootBytes = await rootBlockBytesFor(result.carBytes);
    const map = await buildBlockMap(result.carBytes);
    const snapshot = await parseLeanProfileSnapshotFromRootBlock(
      rootBytes,
      fetcherFromMap(map),
    );

    expect(snapshot.version).toBe(LEAN_PROFILE_SNAPSHOT_VERSION);
    // Group keys: `DIRECT_*` sorts before `__global__` (uppercase D = 0x44
    // < underscore = 0x5F in ASCII).
    const groupKeys = snapshot.entryGroups.map((g) => g.groupKey).sort();
    expect(groupKeys).toEqual([ADDR_A, LEAN_PROFILE_SNAPSHOT_GLOBAL_GROUP_KEY]);

    // Round-trip preserves every entry.
    const ks = snapshot.entries.map((e) => e.key).sort();
    expect(ks).toEqual([
      `${ADDR_A}.outbox.x`,
      `${ADDR_A}.sent.y`,
      'addresses.tracked',
      'mnemonic',
    ]);
  });

  it('two builds of the same Profile state yield identical sub-block CIDs', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    await storage.set('mnemonic', 'mn');

    const tokenStorage = new FakeTokenStorage();

    const a = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });
    const b = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    expect(a.rootCid).toBe(b.rootCid);
    expect(a.carBytes.byteLength).toBe(b.carBytes.byteLength);

    const blocksA = Array.from((await buildBlockMap(a.carBytes)).keys()).sort();
    const blocksB = Array.from((await buildBlockMap(b.carBytes)).keys()).sort();
    expect(blocksA).toEqual(blocksB);
  });

  it('emits zero-group root for an empty wallet', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    // No entries — nothing to publish.
    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const blocks = Array.from((await buildBlockMap(result.carBytes)).keys());
    // Only the root block — no sub-blocks since no entries.
    expect(blocks).toHaveLength(1);

    const snapshot = await parseLeanProfileSnapshot(result.carBytes);
    expect(snapshot.entryGroups).toHaveLength(0);
    expect(snapshot.entries).toHaveLength(0);
  });
});

// =============================================================================
// 2. Cross-snapshot dedup at the sub-block CID level
// =============================================================================

describe('lean snapshot v3 — cross-snapshot dedup', () => {
  it('two snapshots sharing a per-address group reuse that sub-block CID', async () => {
    // Snapshot A: address A has entries {x:v1, y:v2}; global has {mn}.
    // Snapshot B: address A has the SAME entries; address B has new
    // entries; global has the SAME mn entry.
    // The dedup claim: the sub-block CID for address A is identical
    // across both snapshots (so an IPFS gateway storing both pins
    // would dedup that block), and the sub-block CID for global also
    // matches.
    const storageA = new InMemoryStorageProvider();
    await storageA.connect();
    await storageA.set(`${ADDR_A}.outbox.x`, 'v1');
    await storageA.set(`${ADDR_A}.outbox.y`, 'v2');
    await storageA.set('mnemonic', 'mn');

    const storageB = new InMemoryStorageProvider();
    await storageB.connect();
    // Address A: same entries as snapshot A.
    await storageB.set(`${ADDR_A}.outbox.x`, 'v1');
    await storageB.set(`${ADDR_A}.outbox.y`, 'v2');
    // Address B: new content.
    await storageB.set(`${ADDR_B}.outbox.z`, 'v3');
    // Global: same mnemonic.
    await storageB.set('mnemonic', 'mn');

    const tokenStorage = new FakeTokenStorage();

    const a = await buildLeanProfileSnapshot({
      storage: storageA,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });
    const b = await buildLeanProfileSnapshot({
      storage: storageB,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    // Roots differ — the entryGroups list is different.
    expect(a.rootCid).not.toBe(b.rootCid);

    const aBlocks = await buildBlockMap(a.carBytes);
    const bBlocks = await buildBlockMap(b.carBytes);

    // Distinct CIDs across the two CARs (intersection != empty for the
    // shared sub-blocks).
    const intersection = new Set<string>();
    for (const cid of aBlocks.keys()) {
      if (bBlocks.has(cid)) intersection.add(cid);
    }
    // At least the address A sub-block + global sub-block must dedup.
    expect(intersection.size).toBeGreaterThanOrEqual(2);

    // Unique-CID count strictly less than sum — concrete dedup at the
    // storage layer.
    const union = new Set<string>([...aBlocks.keys(), ...bBlocks.keys()]);
    expect(union.size).toBeLessThan(aBlocks.size + bBlocks.size);
  });

  it('byte-identical snapshots share every sub-block CID', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    await storage.set('mnemonic', 'mn');
    const tokenStorage = new FakeTokenStorage();

    const a = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });
    const b = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const aCids = Array.from((await buildBlockMap(a.carBytes)).keys()).sort();
    const bCids = Array.from((await buildBlockMap(b.carBytes)).keys()).sort();
    expect(aCids).toEqual(bCids);
  });
});

// =============================================================================
// 3. parseLeanProfileSnapshotFromRootBlock walks sub-blocks via fetcher
// =============================================================================

describe('lean snapshot v3 — parseLeanProfileSnapshotFromRootBlock', () => {
  it('walks per-group sub-blocks via the supplied fetcher', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    await storage.set(`${ADDR_B}.outbox.y`, 'v2');
    await storage.set('mnemonic', 'mn');
    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const rootBytes = await rootBlockBytesFor(result.carBytes);
    const map = await buildBlockMap(result.carBytes);

    // Track which sub-block CIDs the fetcher served — confirms the
    // parser walked the entryGroups[*].entriesCid list.
    const fetchedCids: string[] = [];
    const fetcher: LeanProfileSnapshotBlockFetcher = async (cid) => {
      fetchedCids.push(cid);
      const bytes = map.get(cid);
      if (!bytes) throw new Error(`missing ${cid}`);
      return bytes;
    };

    const snapshot = await parseLeanProfileSnapshotFromRootBlock(rootBytes, fetcher);
    expect(snapshot.entries.map((e) => e.key).sort()).toEqual(
      [`${ADDR_A}.outbox.x`, `${ADDR_B}.outbox.y`, 'mnemonic'].sort(),
    );

    // Three groups → three sub-block fetches.
    expect(fetchedCids).toHaveLength(3);
    // Fetched CIDs exactly equal the entryGroups[*].entriesCid set.
    expect(new Set(fetchedCids)).toEqual(
      new Set(snapshot.entryGroups.map((g) => g.entriesCid)),
    );
  });

  it('returns entryGroups but empty entries when fetcher omitted on v3', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    await storage.set('mnemonic', 'mn');
    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });
    const rootBytes = await rootBlockBytesFor(result.carBytes);
    const snapshot = await parseLeanProfileSnapshotFromRootBlock(rootBytes);
    expect(snapshot.version).toBe(LEAN_PROFILE_SNAPSHOT_VERSION);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.entryGroups.length).toBeGreaterThan(0);
  });

  it('rejects sub-block whose entry count does not match the ref metadata', async () => {
    // Equivalent of the v2 "duplicate entry keys / non-array entries"
    // checks — those used to fire on inline `entries[]`; in v3 they
    // live in the sub-block parser. This pins one such mismatch
    // explicitly: a forged sub-block returns 0 entries but the root
    // ref claims N > 0.
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    await storage.set(`${ADDR_A}.outbox.y`, 'v2');
    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const rootBytes = await rootBlockBytesFor(result.carBytes);
    const { encode } = await import('@ipld/dag-cbor');
    // Sub-block lies about its entry count vs what the root ref
    // declares — must trip the metadata cross-check.
    const forged = encode({ groupKey: ADDR_A, entries: [] });
    const lyingFetcher: LeanProfileSnapshotBlockFetcher = async (_) => forged;

    await expect(
      parseLeanProfileSnapshotFromRootBlock(rootBytes, lyingFetcher),
    ).rejects.toThrow(/entries, but root metadata claims/);
  });

  it('rejects sub-block whose entries[] contains duplicate keys', async () => {
    // Forge BOTH root and sub-block by hand so the root ref claims
    // entryCount=2 (matching the duplicate-key sub-block) and the
    // dedup check inside `validateGroupBlockShape` is what fires.
    const { encode } = await import('@ipld/dag-cbor');
    const forgedTwoEntries = encode({
      groupKey: ADDR_A,
      entries: [
        { key: 'dup', value: 'a' },
        { key: 'dup', value: 'b' },
      ],
    });
    const subCidBytes = await import('multiformats/cid').then(async (m) => {
      const { sha256 } = await import('@noble/hashes/sha2.js');
      const { create: createMultihash } = await import('multiformats/hashes/digest');
      return m.CID.createV1(0x71, createMultihash(0x12, sha256(forgedTwoEntries)));
    });
    const forgedRoot = encode({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
      entryGroups: [
        { groupKey: ADDR_A, entriesCid: subCidBytes, entryCount: 2 },
      ],
      bundles: [],
    });

    const fetcher: LeanProfileSnapshotBlockFetcher = async (_) =>
      forgedTwoEntries;

    // Re-run via the root-block parser against the forged root.
    await expect(
      parseLeanProfileSnapshotFromRootBlock(forgedRoot, fetcher),
    ).rejects.toThrow(/Duplicate entry key/);
  });

  it('rejects sub-block whose decoded groupKey does not match the ref', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'v1');
    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    const rootBytes = await rootBlockBytesFor(result.carBytes);

    // Substitute a sub-block whose internal groupKey lies — fetcher
    // serves a forged block. (We don't actually need cid-binding sound
    // bytes for this test: the parser MUST cross-check the decoded
    // groupKey against the ref before trusting the bytes.)
    const { encode } = await import('@ipld/dag-cbor');
    const forgedBytes = encode({ groupKey: 'WRONG', entries: [] });
    const adversarialFetcher: LeanProfileSnapshotBlockFetcher = async (_) =>
      forgedBytes;

    await expect(
      parseLeanProfileSnapshotFromRootBlock(rootBytes, adversarialFetcher),
    ).rejects.toThrow(/wrong groupKey/);
  });
});

// =============================================================================
// 4. Partial-fetch — only requested groups served
// =============================================================================

describe('lean snapshot v3 — parseLeanProfileSnapshotPartial', () => {
  async function buildThreeAddressSnapshot(): Promise<{
    carBytes: Uint8Array;
    rootBytes: Uint8Array;
    map: Map<string, Uint8Array>;
  }> {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'a1');
    await storage.set(`${ADDR_B}.outbox.y`, 'b1');
    await storage.set(`${ADDR_C}.outbox.z`, 'c1');
    await storage.set('mnemonic', 'mn');

    const tokenStorage = new FakeTokenStorage();
    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });

    return {
      carBytes: result.carBytes,
      rootBytes: await rootBlockBytesFor(result.carBytes),
      map: await buildBlockMap(result.carBytes),
    };
  }

  it('fetches only the requested address sub-blocks', async () => {
    const { rootBytes, map } = await buildThreeAddressSnapshot();

    const fetchedCids: string[] = [];
    const fetcher: LeanProfileSnapshotBlockFetcher = async (cid) => {
      fetchedCids.push(cid);
      const bytes = map.get(cid);
      if (!bytes) throw new Error(`missing ${cid}`);
      return bytes;
    };

    // Ask for ADDR_A only. ADDR_B + ADDR_C must be skipped; global
    // is fetched by default.
    const result = await parseLeanProfileSnapshotPartial(rootBytes, fetcher, {
      addressIds: [ADDR_A],
    });

    // Two fetches: ADDR_A group + global group.
    expect(fetchedCids).toHaveLength(2);

    expect(result.entries.map((e) => e.key).sort()).toEqual([
      `${ADDR_A}.outbox.x`,
      'mnemonic',
    ]);
    expect(result.unfetchedGroupKeys.sort()).toEqual([ADDR_B, ADDR_C].sort());

    // entryGroups[] still includes ALL 4 groups (root metadata
    // doesn't get trimmed; it's the entries[] slice that does).
    expect(result.entryGroups).toHaveLength(4);
  });

  it('honors includeGlobal=false to skip the global sub-block too', async () => {
    const { rootBytes, map } = await buildThreeAddressSnapshot();

    const fetchedCids: string[] = [];
    const fetcher: LeanProfileSnapshotBlockFetcher = async (cid) => {
      fetchedCids.push(cid);
      const bytes = map.get(cid);
      if (!bytes) throw new Error(`missing ${cid}`);
      return bytes;
    };

    const result = await parseLeanProfileSnapshotPartial(rootBytes, fetcher, {
      addressIds: [ADDR_B],
      includeGlobal: false,
    });

    // One fetch only: ADDR_B group.
    expect(fetchedCids).toHaveLength(1);
    expect(result.entries.map((e) => e.key)).toEqual([`${ADDR_B}.outbox.y`]);
    expect(new Set(result.unfetchedGroupKeys)).toEqual(
      new Set([
        ADDR_A,
        ADDR_C,
        LEAN_PROFILE_SNAPSHOT_GLOBAL_GROUP_KEY,
      ]),
    );
  });

  it('fetches all groups when no addressIds filter is supplied', async () => {
    const { rootBytes, map } = await buildThreeAddressSnapshot();
    const fetchedCids: string[] = [];
    const fetcher: LeanProfileSnapshotBlockFetcher = async (cid) => {
      fetchedCids.push(cid);
      const bytes = map.get(cid);
      if (!bytes) throw new Error(`missing ${cid}`);
      return bytes;
    };

    const result = await parseLeanProfileSnapshotPartial(rootBytes, fetcher);
    // Four fetches: ADDR_A, ADDR_B, ADDR_C, global.
    expect(fetchedCids).toHaveLength(4);
    expect(result.unfetchedGroupKeys).toHaveLength(0);
    expect(result.entries.map((e) => e.key).sort()).toEqual(
      [
        `${ADDR_A}.outbox.x`,
        `${ADDR_B}.outbox.y`,
        `${ADDR_C}.outbox.z`,
        'mnemonic',
      ].sort(),
    );
  });

  it('bundles[] is always present even when addressIds filter skips everything', async () => {
    // The bundles[] list lives inline in the root block — it MUST be
    // returned regardless of the entries-side filter (bundles dedup
    // independently of the per-address grouping).
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set(`${ADDR_A}.outbox.x`, 'a1');
    const tokenStorage = new FakeTokenStorage();
    tokenStorage.bundleIndex.set(
      'bafkreigh2akiscaildc5xwhtwkkkjwxowwxuvvdzc6lkrymccq6n2lvzee',
      {
        cid: 'bafkreigh2akiscaildc5xwhtwkkkjwxowwxuvvdzc6lkrymccq6n2lvzee',
        status: 'active',
        createdAt: TEST_TS,
      },
    );

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
    });
    const rootBytes = await rootBlockBytesFor(result.carBytes);
    const map = await buildBlockMap(result.carBytes);

    const partial = await parseLeanProfileSnapshotPartial(
      rootBytes,
      fetcherFromMap(map),
      { addressIds: [], includeGlobal: false },
    );
    expect(partial.entries).toHaveLength(0);
    expect(partial.bundles).toHaveLength(1);
  });
});

// =============================================================================
// 6. No back-compat: v2 single-block payloads are rejected
// =============================================================================

describe('lean snapshot v3 — no v2 back-compat (issue #200 non-goal)', () => {
  it('rejects a hand-crafted v2 single-block CAR with an explicit version error', async () => {
    const { CarWriter } = await import('@ipld/car/writer');
    const { encode } = await import('@ipld/dag-cbor');
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { create: createMultihash } = await import('multiformats/hashes/digest');

    const root = {
      version: 2,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
      entries: [
        { key: 'mnemonic', value: Buffer.from('CT(mn)').toString('base64') },
      ],
      bundles: [],
    };
    const bytes = encode(root);
    const cid = CID.createV1(0x71, createMultihash(0x12, sha256(bytes)));
    const { writer, out } = CarWriter.create([cid]);
    const chunks: Uint8Array[] = [];
    const collect = (async () => {
      for await (const c of out) chunks.push(c);
    })();
    await writer.put({ cid, bytes });
    await writer.close();
    await collect;
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    const carBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      carBytes.set(c, off);
      off += c.byteLength;
    }

    // The lean reader must reject v2 — issue #200 non-goal disclaims
    // back-compat with pre-v3 lean snapshots. Wallets re-flush on
    // first publish under the new layout.
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(
      /version 2 is not accepted/,
    );
  });

  it('parseLeanProfileSnapshotFromRootBlock rejects v2 root-block bytes', async () => {
    const { encode } = await import('@ipld/dag-cbor');
    const v2RootBytes = encode({
      version: 2,
      chainPubkey: TEST_CHAIN_PUBKEY,
      network: 'testnet',
      createdAt: TEST_TS,
      entries: [
        { key: 'mnemonic', value: Buffer.from('CT(mn)').toString('base64') },
      ],
      bundles: [],
    });

    await expect(
      parseLeanProfileSnapshotFromRootBlock(v2RootBytes),
    ).rejects.toThrow(/version 2 is not accepted/);
  });
});
