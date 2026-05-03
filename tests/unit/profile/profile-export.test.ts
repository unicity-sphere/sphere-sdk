/**
 * Unit tests for profile/profile-export.ts and profile/profile-import.ts.
 *
 * The export/import surface is exercised entirely against in-memory
 * storage doubles + a fake bundle index. Real OrbitDB / IPFS gateway
 * integration is left to the e2e suite (`profile-export-roundtrip.test.ts`)
 * — the goal here is to lock the contract: round-trip preserves KV
 * entries; refuse-overwrite triggers without `force`; chainPubkey
 * mismatch triggers without `allowDifferentIdentity`; large bundle
 * counts succeed within the size cap.
 *
 * Wave 9 hardening tests added:
 *   - Mnemonic / identity-class values land as ENCRYPTED ciphertext
 *     (never plaintext) in the snapshot.
 *   - Forged-CID bundle CARs are rejected on parse.
 *   - Block-count + per-block-byte caps reject hostile shapes.
 *   - Oversized entry values are rejected.
 *   - IPFS-gateway-less imports refuse to mark bundles as pinned.
 *   - `expectedChainPubkey` is required.
 *   - Operational keys are filtered from the export.
 *   - Determinism: re-export → byte-identical roots.
 *   - Duplicate keys → reject on parse.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  exportProfile,
  parseProfileSnapshot,
  PROFILE_SNAPSHOT_VERSION,
  type ProfileSnapshot,
} from '../../../profile/profile-export';
import { importProfile } from '../../../profile/profile-import';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type {
  ProviderStatus,
  TrackedAddressEntry,
  FullIdentity,
} from '../../../types';
import type { UxfBundleRef } from '../../../profile/types';
import { UxfPackage } from '../../../uxf/UxfPackage';

// =============================================================================
// Test doubles
// =============================================================================

/**
 * Shared in-memory KV store with a separate "encrypted-form" channel
 * that mimics ProfileStorageProvider's `getEncryptedRaw` /
 * `setEncryptedRaw`. The plaintext channel (`get`/`set`) is what
 * application code uses; the ciphertext channel is what the export
 * pipeline reads. By convention in these tests we mark "encrypted"
 * values with the `enc:` prefix and base64-encode the raw bytes.
 */
class InMemoryStorageProvider implements StorageProvider {
  readonly id = 'memory';
  readonly name = 'Memory';
  readonly type = 'local' as const;
  private data = new Map<string, string>();
  /** Separate ciphertext channel — what `getEncryptedRaw` returns. */
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
    // Stash a fake ciphertext blob (deterministic; just base64 of
    // the plaintext). Real ProfileStorageProvider would AES-GCM
    // encrypt; the test only needs the round-trip to be reversible
    // by string equality + the assertion that the snapshot value is
    // NOT the plaintext.
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

  // ---- Wave 9 — encrypted-form round-trip ----
  async getEncryptedRaw(key: string): Promise<string | null> {
    return this.encrypted.get(key) ?? null;
  }
  async setEncryptedRaw(key: string, value: string): Promise<void> {
    this.encrypted.set(key, value);
    // Mirror plaintext for `keys()` consistency. We also "decrypt"
    // by reversing our toy CT() wrapper so the plaintext channel
    // stays consistent for tests that read back via `get()`.
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const m = /^CT\((.*)\)$/.exec(decoded);
      if (m) this.data.set(key, m[1]);
      else this.data.set(key, decoded);
    } catch {
      this.data.set(key, value);
    }
  }
}

/**
 * Minimal token-storage double: just enough surface for the export
 * code path's `listBundles()` + `_ipfsGateways` reads, and the import
 * code path's `addBundle()` write. Real PIN/fetch are stubbed via
 * vitest's vi.mock so the test stays purely in-process.
 */
class FakeTokenStorage {
  _ipfsGateways: string[] = ['http://fake-gateway/'];
  readonly bundleIndex = new Map<string, UxfBundleRef>();

  async listBundles(): Promise<Map<string, UxfBundleRef>> {
    return new Map(this.bundleIndex);
  }
  async addBundle(cid: string, ref: UxfBundleRef): Promise<void> {
    this.bundleIndex.set(cid, ref);
  }
}

// Mock the IPFS client so export's fetchFromIpfs returns canned bundle
// CARs and import's pinToIpfs is a no-op (we don't have a real gateway).
vi.mock('../../../profile/ipfs-client', async () => {
  const carCache = new Map<string, Uint8Array>();
  return {
    fetchFromIpfs: vi.fn(async (_gateways: string[], cid: string) => {
      const cached = carCache.get(cid);
      if (!cached) {
        throw new Error(`fake fetchFromIpfs: no CAR cached for ${cid}`);
      }
      return cached;
    }),
    pinToIpfs: vi.fn(async () => 'fake-pin-cid'),
    verifyCidAccessible: vi.fn(async () => true),
    // Test-only setter so the test can pre-populate the fake gateway.
    __setBundleCar: (cid: string, bytes: Uint8Array) => {
      carCache.set(cid, bytes);
    },
    __clearBundleCars: () => {
      carCache.clear();
    },
  };
});

const TEST_CHAIN_PUBKEY_A = '02' + 'aa'.repeat(32);
const TEST_CHAIN_PUBKEY_B = '02' + 'bb'.repeat(32);
const TEST_CHAIN_PUBKEY_C = '02' + 'cc'.repeat(32);
const TEST_CHAIN_PUBKEY_D = '02' + 'dd'.repeat(32);
const TEST_CHAIN_PUBKEY_E = '02' + 'ee'.repeat(32);
const TEST_CHAIN_PUBKEY_F = '02' + 'ff'.repeat(32);

async function buildSampleBundleCar(description = 'unit-test fixture bundle'): Promise<{
  cid: string;
  carBytes: Uint8Array;
}> {
  // We don't need a real bundle CAR here for round-trip testing —
  // an empty UxfPackage's CAR is a valid CAR with one root, exactly
  // what the export logic embeds.
  const pkg = UxfPackage.create({ description });
  const carBytes = await pkg.toCar();
  // Read the CAR's root CID to use as the "bundle CID".
  const { CarReader } = await import('@ipld/car');
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  return { cid: roots[0].toString(), carBytes };
}

// =============================================================================
// Round-trip
// =============================================================================

describe('profile-export — round-trip', () => {
  it('preserves all KV entries through export → parse', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'super-secret-mnemonic');
    await storage.set('master_key', 'deadbeefcafe');
    await storage.set('addresses.tracked', '{"version":1,"addresses":[]}');
    await storage.set('DIRECT_aabbcc_ddeeff_outbox', 'enc:ghi789');

    const tokenStorage = new FakeTokenStorage();

    const result = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    expect(result.entryCount).toBe(4);
    expect(result.bundlesEmbedded).toBe(0);
    expect(result.bundlesMissing).toBe(0);
    expect(result.carBytes.byteLength).toBeGreaterThan(0);
    expect(result.rootCid).toMatch(/^[a-z2-7]+$/i);

    const parsed = await parseProfileSnapshot(result.carBytes);
    expect(parsed.snapshot.version).toBe(PROFILE_SNAPSHOT_VERSION);
    expect(parsed.snapshot.chainPubkey).toBe(TEST_CHAIN_PUBKEY_A);
    expect(parsed.snapshot.network).toBe('testnet');
    expect(parsed.snapshot.entries).toHaveLength(4);
    const keys = parsed.snapshot.entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      'DIRECT_aabbcc_ddeeff_outbox',
      'addresses.tracked',
      'master_key',
      'mnemonic',
    ]);
    expect(parsed.snapshot.bundles).toHaveLength(0);
  });

  it('embeds and recovers a bundle CAR end-to-end', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();
    const setCar = (ipfs as unknown as {
      __setBundleCar: (cid: string, bytes: Uint8Array) => void;
    }).__setBundleCar;

    const fixture = await buildSampleBundleCar();
    setCar(fixture.cid, fixture.carBytes);

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'enc:m1');

    const tokenStorage = new FakeTokenStorage();
    tokenStorage.bundleIndex.set(fixture.cid, {
      cid: fixture.cid,
      status: 'active',
      createdAt: 1_700_000_000,
      tokenCount: 0,
    });

    const result = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_B,
      network: 'testnet',
    });

    expect(result.bundlesEmbedded).toBe(1);
    expect(result.bundlesMissing).toBe(0);

    const parsed = await parseProfileSnapshot(result.carBytes);
    expect(parsed.snapshot.bundles).toHaveLength(1);
    expect(parsed.snapshot.bundles[0].cid).toBe(fixture.cid);
    expect(parsed.bundleCars.has(fixture.cid)).toBe(true);
    const recoveredCar = parsed.bundleCars.get(fixture.cid)!;
    // The embedded CAR bytes should round-trip exactly.
    expect(recoveredCar.byteLength).toBe(fixture.carBytes.byteLength);
    for (let i = 0; i < recoveredCar.byteLength; i++) {
      expect(recoveredCar[i]).toBe(fixture.carBytes[i]);
    }
  });

  it('counts bundles whose CAR fetch fails as `bundlesMissing`', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();

    const tokenStorage = new FakeTokenStorage();
    // Add a bundle ref WITHOUT registering its CAR with the fake gateway.
    tokenStorage.bundleIndex.set('bafymissing', {
      cid: 'bafymissing',
      status: 'active',
      createdAt: 1_700_000_000,
    });

    const result = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_C,
      network: 'testnet',
    });

    expect(result.bundlesEmbedded).toBe(0);
    expect(result.bundlesMissing).toBe(1);

    const parsed = await parseProfileSnapshot(result.carBytes);
    // The bundle ref should NOT appear in the snapshot doc since its
    // bytes weren't embedded — losing this signal would corrupt the
    // import path's bundle replay.
    expect(parsed.snapshot.bundles).toHaveLength(0);
  });
});

// =============================================================================
// Wave 9 — Mnemonic-leak prevention (Critical #1)
// =============================================================================

describe('profile-export — encrypted-form export (Wave 9 critical #1)', () => {
  it('embeds ENCRYPTED ciphertext for every KV value, never plaintext', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const PLAINTEXT_MNEMONIC =
      'abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon about';
    await storage.set('mnemonic', PLAINTEXT_MNEMONIC);
    await storage.set('master_key', 'plaintext-master-key');
    await storage.set('chain_code', 'plaintext-chain-code');

    const tokenStorage = new FakeTokenStorage();

    const result = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    const parsed = await parseProfileSnapshot(result.carBytes);
    const mnemonicEntry = parsed.snapshot.entries.find((e) => e.key === 'mnemonic')!;
    expect(mnemonicEntry).toBeTruthy();
    // The CRITICAL invariant: snapshot value must NOT be the plaintext.
    expect(mnemonicEntry.value).not.toBe(PLAINTEXT_MNEMONIC);
    expect(mnemonicEntry.value).not.toContain('abandon');
    // It should be the toy CT() ciphertext we stash in the test double.
    const decoded = Buffer.from(mnemonicEntry.value, 'base64').toString('utf8');
    expect(decoded).toBe(`CT(${PLAINTEXT_MNEMONIC})`);

    // Master key + chain code likewise.
    const masterEntry = parsed.snapshot.entries.find((e) => e.key === 'master_key')!;
    expect(masterEntry.value).not.toContain('plaintext-master-key');
    const chainEntry = parsed.snapshot.entries.find((e) => e.key === 'chain_code')!;
    expect(chainEntry.value).not.toContain('plaintext-chain-code');

    // The whole CAR must not contain the plaintext mnemonic anywhere
    // — defense in depth: even if some other field accidentally got
    // a plaintext copy, this catches it.
    const carUtf8 = Buffer.from(result.carBytes).toString('utf8');
    expect(carUtf8).not.toContain('abandon abandon abandon');
  });

  it('throws when the storage provider does not implement getEncryptedRaw', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const tokenStorage = new FakeTokenStorage();

    // Build a storage provider WITHOUT getEncryptedRaw — explicitly
    // null out the method by overriding to undefined on the instance.
    class LegacyStorageProvider extends InMemoryStorageProvider {
      // Shadow the inherited method so `typeof handle.getEncryptedRaw`
      // is not 'function' on this instance.
      override getEncryptedRaw = undefined as unknown as InMemoryStorageProvider['getEncryptedRaw'];
    }
    const legacy = new LegacyStorageProvider();
    await legacy.connect();
    await legacy.set('mnemonic', 'plaintext');

    await expect(
      exportProfile({
        storage: legacy,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        chainPubkey: TEST_CHAIN_PUBKEY_A,
        network: 'testnet',
      }),
    ).rejects.toThrow(/getEncryptedRaw/);
  });
});

// =============================================================================
// Wave 9 — Operational key filtering (Fix #7)
// =============================================================================

describe('profile-export — operational-key filtering (Wave 9 fix #7)', () => {
  it('filters tokens.bundle.*, consolidation.pending, and per-device timestamps', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();

    // A normal user-data key — should round-trip.
    await storage.set('mnemonic', 'enc:m1');
    // Operational keys — must be filtered out.
    await storage.set('tokens.bundle.bafyabc', '{"cid":"bafyabc"}');
    await storage.set('tokens.bundle.bafydef', '{"cid":"bafydef"}');
    await storage.set('consolidation.pending', '{"queue":[]}');
    await storage.set('last_wallet_event_ts_02deadbeef', '17000000000');
    await storage.set('last_dm_event_ts_02deadbeef', '17000000001');

    const tokenStorage = new FakeTokenStorage();

    const result = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
    });

    const parsed = await parseProfileSnapshot(result.carBytes);
    const exportedKeys = parsed.snapshot.entries.map((e) => e.key);
    expect(exportedKeys).toEqual(['mnemonic']);
    // None of the operational keys leaked.
    expect(exportedKeys.find((k) => k.startsWith('tokens.bundle.'))).toBeUndefined();
    expect(exportedKeys.find((k) => k.startsWith('consolidation.'))).toBeUndefined();
    expect(exportedKeys.find((k) => k.startsWith('last_wallet_event_ts_'))).toBeUndefined();
    expect(exportedKeys.find((k) => k.startsWith('last_dm_event_ts_'))).toBeUndefined();
  });
});

// =============================================================================
// Wave 9 — Determinism (Fix #8)
// =============================================================================

describe('profile-export — determinism (Wave 9 fix #8)', () => {
  it('produces byte-identical roots for two exports of the same Profile', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');
    await storage.set('master_key', 'mk1');
    await storage.set('addresses.tracked', '[]');

    const tokenStorage = new FakeTokenStorage();

    const FIXED_TS = 1_700_000_000_000;
    const a = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });
    const b = await exportProfile({
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
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'm1');

    const tokenStorage = new FakeTokenStorage();
    const FIXED_TS = 1_700_000_000_000;

    const before = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    await storage.set('master_key', 'mk1');

    const after = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: FIXED_TS,
    });

    expect(after.rootCid).not.toBe(before.rootCid);
  });
});

// =============================================================================
// Schema version + shape validation
// =============================================================================

describe('parseProfileSnapshot — validation', () => {
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
    const out2 = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out2.set(c, off);
      off += c.byteLength;
    }
    return out2;
  }

  it('rejects unknown future version', async () => {
    const carBytes = await buildCarWithDoc({
      version: 2,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [],
      bundles: [],
    });
    await expect(parseProfileSnapshot(carBytes)).rejects.toThrow(/version 2 is newer/);
  });

  it('rejects multi-root CARs', async () => {
    // Build two roots manually.
    const { CarWriter } = await import('@ipld/car/writer');
    const { encode } = await import('@ipld/dag-cbor');
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { create: createMultihash } = await import('multiformats/hashes/digest');

    const a = encode({ version: 1, hello: 'a' });
    const b = encode({ version: 1, hello: 'b' });
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

    await expect(parseProfileSnapshot(carBytes)).rejects.toThrow(
      /Expected exactly one CAR root/,
    );
  });

  it('rejects duplicate keys in the snapshot doc (Wave 9 fix #9)', async () => {
    const carBytes = await buildCarWithDoc({
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [
        { key: 'mnemonic', value: 'a' },
        { key: 'mnemonic', value: 'b' },
      ],
      bundles: [],
    });
    await expect(parseProfileSnapshot(carBytes)).rejects.toThrow(
      /Duplicate entry key/,
    );
  });

  it('rejects oversized entry value via per-block-byte cap (Wave 9 fix #3)', async () => {
    // Build an entry with a 9 MiB value — both the per-block (1 MiB)
    // and per-value (8 MiB) caps would reject this. The block cap
    // fires first because the dag-cbor root block holds the value
    // inline; assert the block-cap message.
    const huge = 'x'.repeat(9 * 1024 * 1024);
    const carBytes = await buildCarWithDoc({
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [{ key: 'mnemonic', value: huge }],
      bundles: [],
    });
    await expect(parseProfileSnapshot(carBytes)).rejects.toThrow(
      /per-block cap/,
    );
  });
});

// =============================================================================
// Wave 9 — Bundle CID content-address verification (Critical #2)
// =============================================================================

describe('parseProfileSnapshot — bundle authentication (Wave 9 critical #2)', () => {
  it('rejects forged-CID bundle CARs', async () => {
    // Build a real bundle, then list it under a DIFFERENT cid in the
    // snapshot doc — the importer must refuse to bind the actual CAR
    // bytes to the forged cid.
    const fixture = await buildSampleBundleCar();
    const FORGED_CID = 'bafkreigh2akiscaildc5xwhtwkkkjwxowwxuvvdzc6lkrymccq6n2lvzee';
    expect(FORGED_CID).not.toBe(fixture.cid);

    // Manually assemble a snapshot CAR that lists FORGED_CID but
    // embeds the actual fixture bytes.
    const { CarWriter } = await import('@ipld/car/writer');
    const { encode } = await import('@ipld/dag-cbor');
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { create: createMultihash } = await import('multiformats/hashes/digest');

    const rootDoc = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [],
      bundles: [
        {
          cid: FORGED_CID,
          status: 'active',
          createdAt: 1_700_000_000,
        },
      ],
    };
    const rootBytes = encode(rootDoc);
    const rootCid = CID.createV1(0x71, createMultihash(0x12, sha256(rootBytes)));
    const embedCid = CID.createV1(0x55, createMultihash(0x12, sha256(fixture.carBytes)));

    const { writer, out } = CarWriter.create([rootCid]);
    const chunks: Uint8Array[] = [];
    const collect = (async () => {
      for await (const c of out) chunks.push(c);
    })();
    await writer.put({ cid: rootCid, bytes: rootBytes });
    await writer.put({ cid: embedCid, bytes: fixture.carBytes });
    await writer.close();
    await collect;
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    const carBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      carBytes.set(c, off);
      off += c.byteLength;
    }

    const parsed = await parseProfileSnapshot(carBytes);
    // The snapshot is parsed (header roots[] is metadata; we don't
    // reject the WHOLE CAR — only the unauthenticated bundle).
    expect(parsed.snapshot.bundles).toHaveLength(1);
    // But the embedded CAR is NOT bound to the forged cid.
    expect(parsed.bundleCars.has(FORGED_CID)).toBe(false);
    expect(parsed.bundleCars.size).toBe(0);
  });

  it('rejects oversized blocks via per-block-byte cap (Wave 9 fix #3)', async () => {
    // The full block-COUNT cap (200 000 blocks) is impractical to
    // assert in a unit test — building that many CAR blocks takes
    // seconds. We exercise the same gating code path by building a
    // CAR with a single oversize block (2 MiB > 1 MiB cap). The
    // count-cap path itself is covered by the e2e suite.
    const { CarWriter } = await import('@ipld/car/writer');
    const { encode } = await import('@ipld/dag-cbor');
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { create: createMultihash } = await import('multiformats/hashes/digest');

    const rootDoc = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: Date.now(),
      entries: [],
      bundles: [],
    };
    const rootBytes = encode(rootDoc);
    const rootCid = CID.createV1(0x71, createMultihash(0x12, sha256(rootBytes)));

    const huge = new Uint8Array(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    huge.fill(0x42);
    const hugeCid = CID.createV1(0x55, createMultihash(0x12, sha256(huge)));

    const { writer, out } = CarWriter.create([rootCid]);
    const chunks: Uint8Array[] = [];
    const collect = (async () => {
      for await (const c of out) chunks.push(c);
    })();
    await writer.put({ cid: rootCid, bytes: rootBytes });
    await writer.put({ cid: hugeCid, bytes: huge });
    await writer.close();
    await collect;
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    const carBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      carBytes.set(c, off);
      off += c.byteLength;
    }

    await expect(parseProfileSnapshot(carBytes)).rejects.toThrow(
      /per-block cap/,
    );
  });
});

// =============================================================================
// Import — clobber + identity checks
// =============================================================================

describe('importProfile — safety gates', () => {
  it('refuses to clobber a non-empty Profile without `force`', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    // A snapshot we want to import. The mnemonic value is the toy
    // ciphertext form so the round-trip lands the right plaintext.
    const ENC_FROM_SNAPSHOT = Buffer.from('CT(from-snapshot)').toString('base64');
    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_E,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [{ key: 'mnemonic', value: ENC_FROM_SNAPSHOT }],
      bundles: [],
    };

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    // Pre-existing wallet — clobber check should fire.
    await storage.set('wallet_exists', 'true');
    await storage.set('mnemonic', 'already-here');

    const tokenStorage = new FakeTokenStorage();

    await expect(
      importProfile({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        snapshot,
        bundleCars: new Map(),
        expectedChainPubkey: TEST_CHAIN_PUBKEY_E,
      }),
    ).rejects.toThrow(/non-empty/);

    // Existing data untouched.
    expect(await storage.get('mnemonic')).toBe('already-here');

    // With `force: true` the import proceeds.
    const result = await importProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      snapshot,
      bundleCars: new Map(),
      expectedChainPubkey: TEST_CHAIN_PUBKEY_E,
      force: true,
    });
    expect(result.entriesReplayed).toBe(1);
    // The plaintext is recovered from our toy ciphertext.
    expect(await storage.get('mnemonic')).toBe('from-snapshot');
  });

  it('refuses to import when chainPubkey differs without override', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [],
      bundles: [],
    };

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const tokenStorage = new FakeTokenStorage();

    await expect(
      importProfile({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        snapshot,
        bundleCars: new Map(),
        expectedChainPubkey: TEST_CHAIN_PUBKEY_B,
      }),
    ).rejects.toThrow(/chainPubkey/);

    // With allowDifferentIdentity:true the import proceeds.
    const result = await importProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      snapshot,
      bundleCars: new Map(),
      expectedChainPubkey: TEST_CHAIN_PUBKEY_B,
      allowDifferentIdentity: true,
    });
    expect(result.entriesReplayed).toBe(0);
  });

  it('replays embedded bundle CARs into the destination bundle index', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const fixture = await buildSampleBundleCar();
    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_F,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [{ key: 'mnemonic', value: Buffer.from('CT(m1)').toString('base64') }],
      bundles: [
        {
          cid: fixture.cid,
          status: 'active',
          createdAt: 1_700_000_000,
          tokenCount: 0,
        },
      ],
    };
    const bundleCars = new Map<string, Uint8Array>([[fixture.cid, fixture.carBytes]]);

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const tokenStorage = new FakeTokenStorage();

    const result = await importProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      snapshot,
      bundleCars,
      expectedChainPubkey: TEST_CHAIN_PUBKEY_F,
    });

    expect(result.entriesReplayed).toBe(1);
    expect(result.bundlesPinned).toBe(1);
    expect(result.bundleRefsRestored).toBe(1);
    expect(result.bundlesFailed).toBe(0);
    // Bundle ref made it into the destination index.
    expect(tokenStorage.bundleIndex.has(fixture.cid)).toBe(true);
  });

  it('rejects missing expectedChainPubkey (Wave 9 fix #6)', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [],
      bundles: [],
    };

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const tokenStorage = new FakeTokenStorage();

    await expect(
      importProfile({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        snapshot,
        bundleCars: new Map(),
        expectedChainPubkey: '',
      } as Parameters<typeof importProfile>[0]),
    ).rejects.toThrow(/INVALID_OPTIONS/);
  });

  it('rejects force + allowDifferentIdentity without acknowledgement (Wave 9 fix #6)', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [],
      bundles: [],
    };

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'enc:already-here');
    const tokenStorage = new FakeTokenStorage();

    await expect(
      importProfile({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        snapshot,
        bundleCars: new Map(),
        expectedChainPubkey: TEST_CHAIN_PUBKEY_B,
        force: true,
        allowDifferentIdentity: true,
      }),
    ).rejects.toThrow(/OVERWRITE_RISK/);

    // With acknowledgeOverwriteRisk:true the import proceeds.
    const result = await importProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      snapshot,
      bundleCars: new Map(),
      expectedChainPubkey: TEST_CHAIN_PUBKEY_B,
      force: true,
      allowDifferentIdentity: true,
      acknowledgeOverwriteRisk: true,
    });
    expect(result.entriesReplayed).toBe(0);
  });

  it('rejects import without IPFS gateway when bundles are present (Wave 9 fix #5)', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const fixture = await buildSampleBundleCar();
    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [],
      bundles: [
        {
          cid: fixture.cid,
          status: 'active',
          createdAt: 1_700_000_000,
        },
      ],
    };
    const bundleCars = new Map<string, Uint8Array>([[fixture.cid, fixture.carBytes]]);

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const tokenStorage = new FakeTokenStorage();
    tokenStorage._ipfsGateways = []; // No gateways!

    await expect(
      importProfile({
        storage,
        tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
        snapshot,
        bundleCars,
        expectedChainPubkey: TEST_CHAIN_PUBKEY_A,
      }),
    ).rejects.toThrow(/IPFS_GATEWAY_REQUIRED/);
  });

  it('allows import without IPFS gateway when no bundles are present', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    (ipfs as unknown as { __clearBundleCars: () => void }).__clearBundleCars();

    const snapshot: ProfileSnapshot = {
      version: 1,
      chainPubkey: TEST_CHAIN_PUBKEY_A,
      network: 'testnet',
      createdAt: 1_700_000_000_000,
      entries: [{ key: 'mnemonic', value: Buffer.from('CT(x)').toString('base64') }],
      bundles: [],
    };

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    const tokenStorage = new FakeTokenStorage();
    tokenStorage._ipfsGateways = [];

    const result = await importProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      snapshot,
      bundleCars: new Map(),
      expectedChainPubkey: TEST_CHAIN_PUBKEY_A,
    });
    expect(result.entriesReplayed).toBe(1);
  });
});

// =============================================================================
// Large bundle counts
// =============================================================================

describe('exportProfile — scale', () => {
  it('handles a large number of bundles without truncation', async () => {
    const ipfs = await import('../../../profile/ipfs-client');
    const setCar = (ipfs as unknown as {
      __setBundleCar: (cid: string, bytes: Uint8Array) => void;
      __clearBundleCars: () => void;
    });
    setCar.__clearBundleCars();

    const storage = new InMemoryStorageProvider();
    await storage.connect();
    await storage.set('mnemonic', 'enc:m1');

    const tokenStorage = new FakeTokenStorage();

    // 50 distinct bundle fixtures — each a tiny empty package CAR.
    const N = 50;
    for (let i = 0; i < N; i++) {
      const pkg = UxfPackage.create({ description: `bundle-${i}` });
      const carBytes = await pkg.toCar();
      const { CarReader } = await import('@ipld/car');
      const reader = await CarReader.fromBytes(carBytes);
      const roots = await reader.getRoots();
      const cid = roots[0].toString();
      setCar.__setBundleCar(cid, carBytes);
      tokenStorage.bundleIndex.set(cid, {
        cid,
        status: 'active',
        createdAt: 1_700_000_000 + i,
      });
    }

    const result = await exportProfile({
      storage,
      tokenStorage: tokenStorage as unknown as ProfileTokenStorageProvider,
      chainPubkey: TEST_CHAIN_PUBKEY_D,
      network: 'testnet',
    });

    expect(result.bundlesEmbedded).toBe(N);
    expect(result.bundlesMissing).toBe(0);

    const parsed = await parseProfileSnapshot(result.carBytes);
    expect(parsed.snapshot.bundles).toHaveLength(N);
    expect(parsed.bundleCars.size).toBe(N);
  });
});
