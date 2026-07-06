/**
 * Unit tests for profile/profile-lean-snapshot.ts (Item #15 Phase A).
 *
 * The lean snapshot is the payload published to the aggregator pointer
 * under the full-profile-sync architecture. The tests lock the
 * contract: builder/parser byte-identical round-trip; size caps
 * enforced; deterministic output; previously-filtered keys
 * (tokens.bundle.*, consolidation.pending) ARE included in the lean
 * variant; per-device transport cursors (last_*_event_ts_*) remain
 * filtered; v1 payloads are NOT accepted by the v2 reader.
 *
 * The test doubles mirror those in `profile-export.test.ts` — in-memory
 * KV with a separate "encrypted-form" channel, fake bundle index. No
 * real OrbitDB / IPFS.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLeanProfileSnapshot,
  parseLeanProfileSnapshot,
  LEAN_PROFILE_SNAPSHOT_VERSION,
} from '../../../extensions/uxf/profile/profile-lean-snapshot';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import type {
  ProviderStatus,
  TrackedAddressEntry,
  FullIdentity,
} from '../../../types';
import type { UxfBundleRef } from '../../../extensions/uxf/profile/types';

// =============================================================================
// Test doubles
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
    // Toy ciphertext mirror — base64 of `CT(plaintext)`. Lean
    // snapshot reads ENCRYPTED form, so this is what lands in the CAR.
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

const TEST_CHAIN_PUBKEY_A = '02' + 'aa'.repeat(32);
const TEST_CHAIN_PUBKEY_B = '02' + 'bb'.repeat(32);

// A real-looking CIDv1 (raw codec) for use as a bundle.cid placeholder
// in tests that don't need to fetch the underlying CAR. Hand-built once
// so the test doesn't depend on the multiformats CID parser shape.
const FAKE_BUNDLE_CID_1 =
  'bafkreigh2akiscaildc5xwhtwkkkjwxowwxuvvdzc6lkrymccq6n2lvzee';
const FAKE_BUNDLE_CID_2 =
  'bafkreidsxnp7rgmpijobv7hxydqe7lztkj32hghdufrlqu5xnz7gciukzy';
const FAKE_BUNDLE_CID_3 =
  'bafkreidnj7yvb7r5oraagdoknwepvjxabxqf67dkc3jbf2vfocrgaftgke';

// =============================================================================
// Round-trip
// =============================================================================

describe('profile-lean-snapshot — round-trip', () => {
  it('preserves all KV entries through build → parse', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'super-secret-mnemonic');
    await storage.set('master_key', 'deadbeefcafe');
    await storage.set('addresses.tracked', '{"version":1,"addresses":[]}');
    await storage.set('DIRECT_aabbcc_ddeeff_outbox', 'enc:ghi789');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    expect(result.entryCount).toBe(4);
    expect(result.bundleCount).toBe(0);
    expect(result.carBytes.byteLength).toBeGreaterThan(0);
    expect(result.rootCid).toMatch(/^[a-z2-7]+$/i);

    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    expect(parsed.version).toBe(LEAN_PROFILE_SNAPSHOT_VERSION);
    expect(parsed.chainPubkey).toBe(TEST_CHAIN_PUBKEY_A);
    expect(parsed.network).toBe('testnet');
    expect(parsed.entries).toHaveLength(4);
    const keys = parsed.entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      'DIRECT_aabbcc_ddeeff_outbox',
      'addresses.tracked',
      'master_key',
      'mnemonic',
    ]);
    expect(parsed.bundles).toHaveLength(0);
  });

  it('round-trips bundle refs (cid + status + createdAt + tokenCount) without embedding CAR bytes', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');

    const tokenStorage = new FakeTokenStorage();
    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_1, {
      cid: FAKE_BUNDLE_CID_1,
      status: 'active',
      createdAt: 1_700_000_000,
      tokenCount: 3,
    });
    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_2, {
      cid: FAKE_BUNDLE_CID_2,
      status: 'superseded',
      createdAt: 1_700_000_100,
    });

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    expect(result.bundleCount).toBe(2);

    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    expect(parsed.bundles).toHaveLength(2);
    // Deterministic ordering — bundles sorted by CID.
    const sortedCids = [FAKE_BUNDLE_CID_1, FAKE_BUNDLE_CID_2].sort();
    expect(parsed.bundles.map((b) => b.cid)).toEqual(sortedCids);

    const b1 = parsed.bundles.find((b) => b.cid === FAKE_BUNDLE_CID_1)!;
    expect(b1.status).toBe('active');
    expect(b1.createdAt).toBe(1_700_000_000);
    expect(b1.tokenCount).toBe(3);

    const b2 = parsed.bundles.find((b) => b.cid === FAKE_BUNDLE_CID_2)!;
    expect(b2.status).toBe('superseded');
    expect(b2.createdAt).toBe(1_700_000_100);
    expect(b2.tokenCount).toBeUndefined();

    // No bundle bytes embedded — the lean snapshot is exactly the root
    // block plus CAR framing; size is bounded by the dag-cbor doc.
    // (Coarse upper bound: 8 KiB is generous for two bundle refs + one
    // KV entry. Catches any accidental re-embedding regressions.)
    expect(result.carBytes.byteLength).toBeLessThan(8 * 1024);
  });

  it('skips unverified bundles', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();

    const tokenStorage = new FakeTokenStorage();
    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_1, {
      cid: FAKE_BUNDLE_CID_1,
      status: 'active',
      createdAt: 1_700_000_000,
    });
    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_2, {
      cid: FAKE_BUNDLE_CID_2,
      status: 'unverified',
      createdAt: 1_700_000_100,
    });

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    expect(result.bundleCount).toBe(1);
    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0].cid).toBe(FAKE_BUNDLE_CID_1);
  });
});

// =============================================================================
// Filter reversal — tokens.bundle.* and consolidation.* ARE included
// =============================================================================

describe('profile-lean-snapshot — filter reversal (Item #15)', () => {
  it('INCLUDES tokens.bundle.* and consolidation.pending in entries[]', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();

    await storage.set('mnemonic', 'enc:m1');
    // Operational keys that v1 strips but lean v2 must propagate.
    await storage.set(
      'tokens.bundle.bafyabc',
      JSON.stringify({ cid: 'bafyabc', status: 'active', createdAt: 1 }),
    );
    await storage.set(
      'tokens.bundle.bafydef',
      JSON.stringify({ cid: 'bafydef', status: 'active', createdAt: 2 }),
    );
    await storage.set('consolidation.pending', '{"queue":[]}');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    const exportedKeys = parsed.entries.map((e) => e.key).sort();
    expect(exportedKeys).toEqual([
      'consolidation.pending',
      'mnemonic',
      'tokens.bundle.bafyabc',
      'tokens.bundle.bafydef',
    ]);
  });

  it('STILL filters per-device transport cursors (last_*_event_ts_*)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();

    await storage.set('mnemonic', 'enc:m1');
    // Per-device sync cursors — propagating these would corrupt the
    // receiver's transport-event filter (it would skip events it has
    // not actually seen).
    await storage.set('last_wallet_event_ts_02deadbeef', '17000000000');
    await storage.set('last_dm_event_ts_02deadbeef', '17000000001');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    const exportedKeys = parsed.entries.map((e) => e.key);
    expect(exportedKeys).toEqual(['mnemonic']);
    expect(exportedKeys.find((k) => k.startsWith('last_wallet_event_ts_'))).toBeUndefined();
    expect(exportedKeys.find((k) => k.startsWith('last_dm_event_ts_'))).toBeUndefined();
  });
});

// =============================================================================
// Encrypted-form invariant (mnemonic leak prevention)
// =============================================================================

describe('profile-lean-snapshot — encrypted-form invariant', () => {
  it('embeds ENCRYPTED ciphertext for every KV value, never plaintext', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const PLAINTEXT_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon about';
    await storage.set('mnemonic', PLAINTEXT_MNEMONIC);
    await storage.set('master_key', 'plaintext-master-key');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    const mnemonicEntry = parsed.entries.find((e) => e.key === 'mnemonic')!;
    expect(mnemonicEntry.value).not.toBe(PLAINTEXT_MNEMONIC);
    expect(mnemonicEntry.value).not.toContain('abandon');
    const decoded = Buffer.from(mnemonicEntry.value, 'base64').toString('utf8');
    expect(decoded).toBe(`CT(${PLAINTEXT_MNEMONIC})`);

    // Defense in depth: plaintext mnemonic must not appear ANYWHERE in
    // the CAR bytes — even by accidental inclusion in some other field.
    const carUtf8 = Buffer.from(result.carBytes).toString('utf8');
    expect(carUtf8).not.toContain('abandon abandon abandon');
  });

  it('throws when the storage provider does not implement getEncryptedRaw', async () => {
    class LegacyStorageProvider extends InMemoryStorageProvider {
      override getEncryptedRaw = undefined as unknown as InMemoryStorageProvider['getEncryptedRaw'];
    }
    const legacy = new LegacyStorageProvider();
    await legacy.connect();
    await legacy.set('mnemonic', 'plaintext');

    const tokenStorage = new FakeTokenStorage();

    await expect(
      buildLeanProfileSnapshot({
        storage: legacy,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        chainPubkey: TEST_CHAIN_PUBKEY_A,
        network: 'testnet',
      }),
    ).rejects.toThrow(/getEncryptedRaw/);
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('profile-lean-snapshot — determinism', () => {
  it('produces byte-identical roots for two builds of the same Profile state', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');
    await storage.set('master_key', 'mk1');
    await storage.set('tokens.bundle.bafyabc', '{"cid":"bafyabc"}');

    const tokenStorage = new FakeTokenStorage();
    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_1, {
      cid: FAKE_BUNDLE_CID_1,
      status: 'active',
      createdAt: 1_700_000_000,
    });
    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_2, {
      cid: FAKE_BUNDLE_CID_2,
      status: 'active',
      createdAt: 1_700_000_100,
    });

    const FIXED_TS = 1_700_000_000_000;
    const a = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });
    const b = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    expect(a.rootCid).toBe(b.rootCid);
    expect(a.carBytes.byteLength).toBe(b.carBytes.byteLength);
    for (let i = 0; i < a.carBytes.byteLength; i++) {
      expect(a.carBytes[i]).toBe(b.carBytes[i]);
    }
  });

  it('produces a DIFFERENT root after the Profile is mutated', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');

    const tokenStorage = new FakeTokenStorage();
    const FIXED_TS = 1_700_000_000_000;

    const before = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    await storage.set('master_key', 'mk1');

    const after = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    expect(after.rootCid).not.toBe(before.rootCid);
  });

  it('produces a DIFFERENT root after a bundle ref is added', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');

    const tokenStorage = new FakeTokenStorage();
    const FIXED_TS = 1_700_000_000_000;

    const before = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    tokenStorage.bundleIndex.set(FAKE_BUNDLE_CID_3, {
      cid: FAKE_BUNDLE_CID_3,
      status: 'active',
      createdAt: 1_700_000_500,
    });

    const after = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    expect(after.rootCid).not.toBe(before.rootCid);
    expect(after.bundleCount).toBe(1);
    expect(before.bundleCount).toBe(0);
  });
});

// =============================================================================
// Schema-version + shape validation
// =============================================================================

describe('parseLeanProfileSnapshot — validation', () => {
  async function buildCarWithDoc(doc: Record<string, unknown>): Promise<Uint8Array> {
    const { CarWriter } = await import('@ipld/car/writer');
    const { encode } = await import('@ipld/dag-cbor');
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { create: createMultihash } = await import('multiformats/hashes/digest');
    const bytes = encode(doc);
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
    const result = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      result.set(c, off);
      off += c.byteLength;
    }
    return result;
  }

  it('rejects v1 payloads — those go to parseProfileSnapshot', async () => {
    const carBytes = await buildCarWithDoc({
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [],
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(
      /version 1 is not accepted/,
    );
  });

  it('rejects unknown future version (>3)', async () => {
    // Phase 4 (issue #200) — v3 became the current builder version;
    // v4+ is still ahead of this SDK and must be rejected.
    const carBytes = await buildCarWithDoc({
      version: 4,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entryGroups: [],
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(
      /version 4 is newer/,
    );
  });

  it('rejects missing version', async () => {
    const carBytes = await buildCarWithDoc({
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [],
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/missing `version`/);
  });

  it('rejects non-integer version', async () => {
    const carBytes = await buildCarWithDoc({
      version: 1.5,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [],
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/Invalid lean snapshot version/);
  });

  it('rejects missing chainPubkey', async () => {
    const carBytes = await buildCarWithDoc({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      network: 'testnet',
      createdAt: Date.now(),
      entryGroups: [],
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/chainPubkey/);
  });

  it('rejects multi-root CARs', async () => {
    const { CarWriter } = await import('@ipld/car/writer');
    const { encode } = await import('@ipld/dag-cbor');
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { create: createMultihash } = await import('multiformats/hashes/digest');

    const a = encode({ version: LEAN_PROFILE_SNAPSHOT_VERSION, hello: 'a' });
    const b = encode({ version: LEAN_PROFILE_SNAPSHOT_VERSION, hello: 'b' });
    const cidA = CID.createV1(0x71, createMultihash(0x12, sha256(a)));
    const cidB = CID.createV1(0x71, createMultihash(0x12, sha256(b)));

    const { writer, out } = CarWriter.create([cidA, cidB]);
    const chunks: Uint8Array[] = [];
    const collect = (async () => {
      for await (const c of out) chunks.push(c);
    })();
    await writer.put({ cid: cidA, bytes: a });
    await writer.put({ cid: cidB, bytes: b });
    await writer.close();
    await collect;
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const carBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      carBytes.set(c, off);
      off += c.byteLength;
    }

    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(
      /Expected exactly one CAR root/,
    );
  });

  it('rejects bundle entry with invalid status', async () => {
    const carBytes = await buildCarWithDoc({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entryGroups: [],
      bundles: [
        { cid: FAKE_BUNDLE_CID_1, status: 'unverified', createdAt: 1 },
      ],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/invalid status/);
  });

  it('rejects bundle entry with unparseable cid', async () => {
    const carBytes = await buildCarWithDoc({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entryGroups: [],
      bundles: [{ cid: 'not-a-cid!@#', status: 'active', createdAt: 1 }],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/unparseable cid/);
  });

  it('rejects duplicate bundle cids', async () => {
    const carBytes = await buildCarWithDoc({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entryGroups: [],
      bundles: [
        { cid: FAKE_BUNDLE_CID_1, status: 'active', createdAt: 1 },
        { cid: FAKE_BUNDLE_CID_1, status: 'superseded', createdAt: 2 },
      ],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/Duplicate bundle cid/);
  });

  it('rejects empty network string', async () => {
    const carBytes = await buildCarWithDoc({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: '',
      createdAt: Date.now(),
      entryGroups: [],
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(/network/);
  });

  it('rejects non-array entryGroups', async () => {
    const carBytes = await buildCarWithDoc({
      version: LEAN_PROFILE_SNAPSHOT_VERSION,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entryGroups: 'not-an-array',
      bundles: [],
    });
    await expect(parseLeanProfileSnapshot(carBytes)).rejects.toThrow(
      /`entryGroups` must be an array/,
    );
  });
});

// =============================================================================
// Cross-version isolation: v2 reader rejects v1, v1 reader rejects v2
// =============================================================================

describe('profile-lean-snapshot — cross-version isolation', () => {
  it('v1 reader (parseProfileSnapshot) rejects lean v3 CARs', async () => {
    const { parseProfileSnapshot } = await import('../../../extensions/uxf/profile/profile-export');

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    // Phase 4 (issue #200) — builder now emits v3. The v1 reader still
    // caps PROFILE_SNAPSHOT_VERSION=1 and rejects anything newer.
    await expect(parseProfileSnapshot(result.carBytes)).rejects.toThrow(
      /version 3 is newer/,
    );
  });

  it('round-trip preserves identity-class keys (mnemonic / master_key / chain_code)', async () => {
    // Identity-class keys must survive the lean snapshot path for the
    // receiver to derive the same master key. Phase D's import path
    // will replay them; here we just verify the snapshot does not strip
    // them.
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'M');
    await storage.set('master_key', 'MK');
    await storage.set('chain_code', 'CC');
    await storage.set('derivation_path', 'DP');
    await storage.set('base_path', 'BP');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_B,
      network: 'testnet',
    });

    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    const keys = new Set(parsed.entries.map((e) => e.key));
    expect(keys.has('mnemonic')).toBe(true);
    expect(keys.has('master_key')).toBe(true);
    expect(keys.has('chain_code')).toBe(true);
    expect(keys.has('derivation_path')).toBe(true);
    expect(keys.has('base_path')).toBe(true);
  });
});

// =============================================================================
// Size cap
// =============================================================================

describe('profile-lean-snapshot — size caps', () => {
  it('respects maxSizeBytes option when set very low', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');
    await storage.set('master_key', 'mk1');

    const tokenStorage = new FakeTokenStorage();

    // 32 bytes is far below the minimum CAR overhead — must throw.
    await expect(
      buildLeanProfileSnapshot({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        chainPubkey: TEST_CHAIN_PUBKEY_A,
        network: 'testnet',
        maxSizeBytes: 32,
      }),
    ).rejects.toThrow(/exceeds maxSizeBytes/);
  });

  it('refuses to build with > 100k KV entries', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    // Cheat the cap by stubbing `keys()` to return a 100_001-long list.
    // We avoid filling the actual map (which would blow up Node's heap).
    const stubKeys = Array.from({ length: 100_001 }, (_, i) => `k${i}`);
    (storage as unknown as { keys: () => Promise<string[]> }).keys = async () => stubKeys;

    const tokenStorage = new FakeTokenStorage();

    await expect(
      buildLeanProfileSnapshot({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        chainPubkey: TEST_CHAIN_PUBKEY_A,
        network: 'testnet',
      }),
    ).rejects.toThrow(/cap 100000/);
  });
});

// =============================================================================
// Phase F — tombstone GC hook
// =============================================================================

describe('profile-lean-snapshot — Item #15 Phase F tombstone GC hook', () => {
  it('invokes gcExpiredTombstones BEFORE reading KV entries', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    // Seed the storage with an "expired tombstone" key. The hook will
    // remove it before the builder scans `storage.keys()`.
    await storage.set('mnemonic', 'm1');
    await storage.set('DIRECT_aaaaaa_bbbbbb.outbox.expired', 'tomb-old');
    await storage.set('DIRECT_aaaaaa_bbbbbb.outbox.live', 'live-data');

    const tokenStorage = new FakeTokenStorage();

    const callOrder: string[] = [];
    const originalKeys = storage.keys.bind(storage);
    (storage as unknown as { keys: (p?: string) => Promise<string[]> }).keys = async (
      p?: string,
    ) => {
      callOrder.push('keys');
      return originalKeys(p);
    };

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      gcExpiredTombstones: async () => {
        callOrder.push('gc');
        // Simulate per-writer GC db.del() on the expired tombstone key.
        await storage.remove('DIRECT_aaaaaa_bbbbbb.outbox.expired');
      },
    });

    // GC fires before the scan; expired tombstone is absent from the
    // published entries[].
    expect(callOrder[0]).toBe('gc');
    expect(callOrder.indexOf('gc')).toBeLessThan(callOrder.indexOf('keys'));
    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    const keys = parsed.entries.map((e) => e.key);
    expect(keys).not.toContain('DIRECT_aaaaaa_bbbbbb.outbox.expired');
    expect(keys).toContain('DIRECT_aaaaaa_bbbbbb.outbox.live');
    expect(keys).toContain('mnemonic');
  });

  it('swallows hook exceptions and proceeds with snapshot build', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');

    const tokenStorage = new FakeTokenStorage();

    let hookCalled = false;
    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      gcExpiredTombstones: async () => {
        hookCalled = true;
        throw new Error('GC pass failure (simulated)');
      },
    });

    expect(hookCalled).toBe(true);
    // Snapshot still produced — failing GC must not block publication.
    expect(result.entryCount).toBe(1);
    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    expect(parsed.entries.map((e) => e.key)).toEqual(['mnemonic']);
  });

  it('omitting the hook preserves pre-Phase-F behavior (no-op)', async () => {
    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');
    await storage.set('DIRECT_aaaaaa_bbbbbb.outbox.expired', 'tomb-old');

    const tokenStorage = new FakeTokenStorage();

    const result = await buildLeanProfileSnapshot({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    // Without the hook every storage key is propagated — including
    // tombstones the operator might consider expired. This locks the
    // backwards-compatible contract.
    const parsed = await parseLeanProfileSnapshot(result.carBytes);
    const keys = parsed.entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      'DIRECT_aaaaaa_bbbbbb.outbox.expired',
      'mnemonic',
    ]);
  });
});
