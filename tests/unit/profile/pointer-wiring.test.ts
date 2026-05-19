/**
 * Unit tests for profile/pointer-wiring.ts — the Phase D wiring helper
 * that constructs a ProfilePointerLayer from the dependencies available
 * inside ProfileStorageProvider.
 *
 * Focus: precondition handling + happy-path construction. We do NOT
 * exercise publish / recoverLatest in these tests — those paths require
 * a live aggregator + OrbitDB OpLog and belong in integration tests.
 * Here we assert the helper returns the expected skip reason (or a
 * working layer) for each precondition branch.
 */

import 'fake-indexeddb/auto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';

// Mock the IPFS client so fetchAndJoin tests don't hit the network.
// The mock is per-test via `mockImplementation` to keep each scenario
// independent.
vi.mock('../../../profile/ipfs-client', () => ({
  fetchFromIpfs: vi.fn(),
  pinToIpfs: vi.fn(),
  verifyCidAccessible: vi.fn(),
  verifyCidMatchesBytes: vi.fn(),
}));

import type { StorageProvider } from '../../../storage/storage-provider';
import type { FullIdentity, TrackedAddressEntry } from '../../../types';
import type { OracleProvider } from '../../../oracle';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import {
  DURABLE_STORAGE,
  ProfilePointerLayer,
} from '../../../profile/aggregator-pointer';
import { buildProfilePointerLayer } from '../../../profile/pointer-wiring';
import { createFileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';

/** Minimal in-memory ProfileDatabase stub for the wiring tests. */
function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {},
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 32-byte secret used for all tests — the pointer layer denylist rejects
 *  the `0x01…01` all-ones key; we use a different, non-denylisted value. */
const TEST_PRIVATE_KEY_HEX =
  '1122334411223344112233441122334411223344112233441122334411223344';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'bb'.repeat(32),
  l1Address: 'alpha1test',
  directAddress: 'DIRECT://test',
  privateKey: TEST_PRIVATE_KEY_HEX,
};

/**
 * Create an in-memory storage provider. The `markDurable` flag toggles
 * the DURABLE_STORAGE symbol — pointer-layer construction demands it.
 */
function createCache(opts: { markDurable: boolean }): StorageProvider {
  const store = new Map<string, string>();
  let tracked: TrackedAddressEntry[] = [];
  const impl: Record<string, unknown> = {
    id: 'mock-cache',
    name: 'Mock Cache',
    type: 'local' as const,
    description: 'in-memory',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity(_i: FullIdentity) {},
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
    },
    async remove(k: string) {
      store.delete(k);
    },
    async has(k: string) {
      return store.has(k);
    },
    async keys(prefix?: string) {
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear() {
      store.clear();
    },
    async saveTrackedAddresses(entries: TrackedAddressEntry[]) {
      tracked = entries;
    },
    async loadTrackedAddresses() {
      return tracked;
    },
  };
  if (opts.markDurable) {
    // Sentinel marker — only the pointer layer's imported Symbol
    // satisfies isDurableProvider().
    (impl as Record<symbol, unknown>)[DURABLE_STORAGE] = true;
  }
  return impl as unknown as StorageProvider;
}

/**
 * Build a minimal OracleProvider stub. Each optional returning method
 * is controllable so a test can opt in or out of the precondition.
 */
function createOracle(opts: {
  withAggregatorClient?: boolean;
  withTrustBase?: boolean;
}): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    description: 'test stub',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    async initialize() {},
    async submitCommitment() {
      return { success: false, timestamp: 0 };
    },
    async getProof() {
      return null;
    },
    async waitForProof() {
      throw new Error('not used in wiring tests');
    },
    async validateToken() {
      return { valid: false, spent: false };
    },
    async isSpent() {
      return false;
    },
    async getTokenState() {
      return null;
    },
    async getCurrentRound() {
      return 0;
    },
    getAggregatorClient() {
      if (!opts.withAggregatorClient) return null;
      // A bare object is sufficient — the wiring helper only checks
      // for truthiness. Methods are exercised inside the pointer
      // layer, which the wiring tests do not invoke.
      return {} as unknown;
    },
    getRootTrustBase() {
      if (!opts.withTrustBase) return null;
      return {} as unknown;
    },
  } as OracleProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildProfilePointerLayer', () => {
  const commonInput = () => ({
    identity: TEST_IDENTITY,
    ipfsGateways: ['https://ipfs.example'],
    lockFilePath: '/tmp/test-publish.lock',
    db: createMockDb(),
  });

  it('skips with oracle_missing when no oracle is provided', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      localCache: createCache({ markDurable: true }),
      oracle: undefined as unknown as OracleProvider,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('oracle_missing');
    }
  });

  it('skips with aggregator_client_unavailable when oracle returns null', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      localCache: createCache({ markDurable: true }),
      oracle: createOracle({ withAggregatorClient: false, withTrustBase: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('aggregator_client_unavailable');
    }
  });

  it('skips with trust_base_unavailable when oracle has client but no trust base', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      localCache: createCache({ markDurable: true }),
      oracle: createOracle({ withAggregatorClient: true, withTrustBase: false }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('trust_base_unavailable');
    }
  });

  it('skips with storage_not_durable when local cache lacks durability marker', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      localCache: createCache({ markDurable: false }),
      oracle: createOracle({ withAggregatorClient: true, withTrustBase: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('storage_not_durable');
    }
  });

  it('skips with identity_missing when identity has no private key', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      identity: { ...TEST_IDENTITY, privateKey: '' },
      localCache: createCache({ markDurable: true }),
      oracle: createOracle({ withAggregatorClient: true, withTrustBase: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('identity_missing');
    }
  });

  it('skips with lock_file_path_missing in Node when lockFilePath absent', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      lockFilePath: undefined,
      localCache: createCache({ markDurable: true }),
      oracle: createOracle({ withAggregatorClient: true, withTrustBase: true }),
    });
    // In Node.js the helper must demand a lock file path; in the
    // browser it would skip Web Locks check — we only run Node tests
    // here so the negative branch is the expected one.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('lock_file_path_missing');
    }
  });

  it('returns a ProfilePointerLayer when all preconditions are met', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      localCache: createCache({ markDurable: true }),
      oracle: createOracle({ withAggregatorClient: true, withTrustBase: true }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layer).toBeInstanceOf(ProfilePointerLayer);
    }
  });

  it('constructs successfully with the real FileStorageProvider (durability marker live)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pointer-wiring-file-'));
    try {
      const cache = createFileStorageProvider({ dataDir: tmpDir });
      const result = await buildProfilePointerLayer({
        ...commonInput(),
        localCache: cache,
        oracle: createOracle({ withAggregatorClient: true, withTrustBase: true }),
        lockFilePath: path.join(tmpDir, 'publish.lock'),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.layer).toBeInstanceOf(ProfilePointerLayer);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Callback builders — direct unit coverage (T-D3c wiring)
// ---------------------------------------------------------------------------

describe('fetchAndJoin (T-D3c)', () => {
  // A real CIDv1 raw-codec, SHA-256 hash of the 3-byte string "hi\n".
  // Stable and small — used to avoid hand-crafting varint-prefixed bytes.
  const TEST_CID_STRING = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

  it('fetches, verifies, writes an encrypted bundle ref, and persists the version', async () => {
    const db = createMockDb();
    const persisted: number[] = [];
    const persistLocalVersion = async (v: number) => {
      persisted.push(v);
    };

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_gateways: string[], cid: string) => {
      expect(cid).toBe(TEST_CID_STRING);
      return new Uint8Array([1, 2, 3]);
    });

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const cidBytes = CID.parse(TEST_CID_STRING).bytes;

    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion,
      bundleEncryptionKey: new Uint8Array(32).fill(0x42),
    });

    await callback(cidBytes, 7);

    // Bundle ref exists at the canonical key.
    const bundleKey = `tokens.bundle.${TEST_CID_STRING}`;
    expect(db._store.has(bundleKey)).toBe(true);

    // Payload is NOT plaintext JSON — it's been encrypted.
    const payload = db._store.get(bundleKey)!;
    const asText = new TextDecoder().decode(payload);
    expect(asText.startsWith('{')).toBe(false);

    // Version was advanced.
    expect(persisted).toEqual([7]);
  });

  it('throws CAR_UNAVAILABLE when the IPFS fetch fails', async () => {
    const db = createMockDb();
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      throw new Error('all gateways exhausted');
    });

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {},
      bundleEncryptionKey: new Uint8Array(32),
    });

    await expect(
      callback(CID.parse(TEST_CID_STRING).bytes, 4),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_CAR_UNAVAILABLE',
    });
    expect(db._store.size).toBe(0);
  });

  it('throws CAR_UNAVAILABLE when no gateways are configured', async () => {
    const db = createMockDb();
    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: [],
      persistLocalVersion: async () => {},
      bundleEncryptionKey: new Uint8Array(32),
    });
    await expect(
      callback(CID.parse(TEST_CID_STRING).bytes, 2),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_CAR_UNAVAILABLE',
    });
  });

  it('throws PROTOCOL_ERROR on malformed CID bytes', async () => {
    const db = createMockDb();
    const { __internal } = await import('../../../profile/pointer-wiring');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {},
      bundleEncryptionKey: new Uint8Array(32),
    });
    // 64 zero bytes is not a valid CID encoding.
    await expect(
      callback(new Uint8Array(64), 1),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_PROTOCOL_ERROR',
    });
  });

  it('writes the OrbitDB bundle ref BEFORE persisting the local version', async () => {
    // Critical ordering: the OrbitDB bundle ref must land first so a
    // persistLocalVersion failure does not leave the cursor advanced
    // past a bundle that was never written. The original ordering
    // (persistLocalVersion → put) was unsafe: any put-side error
    // (OrbitDB sync timeout, replication-layer hang) would strand the
    // bundle while the cursor moved on, causing silent token loss on
    // cross-device recovery. Reversing the order makes a put failure
    // recoverable — the cursor stays behind OrbitDB and the next
    // reconcile re-attempts the same `(cidBytes, version)` pair.
    const order: string[] = [];
    const db = createMockDb();
    const originalPut = db.put.bind(db);
    db.put = async (k, v) => {
      order.push('db.put');
      return originalPut(k, v);
    };

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Uint8Array([0xbe, 0xef]));

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');

    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        order.push('persistLocalVersion');
      },
      bundleEncryptionKey: new Uint8Array(32),
    });

    await callback(CID.parse(TEST_CID_STRING).bytes, 11);
    expect(order).toEqual(['db.put', 'persistLocalVersion']);
  });

  it('does NOT advance the local version when the OrbitDB write fails', async () => {
    // Recoverability invariant for Gap 1: when the put-path errors,
    // persistLocalVersion must never run — otherwise the cursor would
    // advance past a bundle that the next reconcile won't re-fetch.
    let persistCalled = false;
    const db = createMockDb();
    db.put = async () => {
      throw new Error('simulated OrbitDB write failure');
    };

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Uint8Array([0xbe, 0xef]));

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');

    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        persistCalled = true;
      },
      bundleEncryptionKey: new Uint8Array(32),
    });

    await expect(callback(CID.parse(TEST_CID_STRING).bytes, 99)).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_PROTOCOL_ERROR',
    });
    expect(persistCalled).toBe(false);
  });

  it('written bundle ref round-trips through decryptProfileValue', async () => {
    // Guards against a future regression where fetchAndJoin and
    // ProfileTokenStorageProvider.listBundles drift on the encryption
    // key or payload shape — both sides must read/write identically.
    const db = createMockDb();
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Uint8Array([0xca, 0xfe]));

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const { decryptProfileValue } = await import('../../../profile/encryption');

    const encKey = new Uint8Array(32).fill(0x77);
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {},
      bundleEncryptionKey: encKey,
    });

    await callback(CID.parse(TEST_CID_STRING).bytes, 42);

    const bundleKey = `tokens.bundle.${TEST_CID_STRING}`;
    const encrypted = db._store.get(bundleKey)!;
    const decrypted = await decryptProfileValue(encKey, encrypted);
    const parsed = JSON.parse(new TextDecoder().decode(decrypted));
    expect(parsed).toMatchObject({
      cid: TEST_CID_STRING,
      status: 'active',
    });
    expect(typeof parsed.createdAt).toBe('number');
  });
});

// =============================================================================
// Item #15 Phase D.2 — snapshot-aware fetchAndJoin path
// =============================================================================

describe('fetchAndJoin — Item #15 Phase D.2 snapshot apply', () => {
  // Use a real CIDv1 (any). The actual content-address check happens
  // inside the lean-snapshot parser, not in fetchAndJoin itself.
  const TEST_CID_STRING = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

  /**
   * Build a CAR that parseLeanProfileSnapshot accepts. The factory
   * uses the production builder so the format stays in lockstep with
   * the producer side.
   */
  async function buildSnapshotCar(): Promise<{ carBytes: Uint8Array; rootCid: string }> {
    const { buildLeanProfileSnapshot } = await import('../../../profile/profile-lean-snapshot');
    // Stub storage with one KV entry under an addressId.
    const tokenStorageStub = {
      listBundles: async () => new Map(),
    };
    const storageStub = {
      keys: async () => ['DIRECT_aabbcc_ddeeff.outbox.id1'],
      getEncryptedRaw: async (key: string) => {
        if (key === 'DIRECT_aabbcc_ddeeff.outbox.id1') {
          return Buffer.from(new Uint8Array([1, 2, 3])).toString('base64');
        }
        return null;
      },
    };
    const result = await buildLeanProfileSnapshot({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storage: storageStub as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tokenStorage: tokenStorageStub as any,
      chainPubkey: '02' + 'bb'.repeat(32),
      network: 'testnet',
      createdAt: 1_700_000_000_000,
    });
    return { carBytes: result.carBytes, rootCid: result.rootCid };
  }

  it('parses the CAR, calls applySnapshot, and persists the version', async () => {
    const db = createMockDb();
    const { carBytes, rootCid } = await buildSnapshotCar();

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => carBytes);

    const persisted: number[] = [];
    const applyCalls: Array<{ entryCount: number; bundleCount: number }> = [];
    const applySnapshot = vi.fn(async (snapshot) => {
      applyCalls.push({
        entryCount: snapshot.entries.length,
        bundleCount: snapshot.bundles.length,
      });
      return {
        joinedAny: true,
        addressesSeen: 1,
        bundleEntriesSeen: 0,
        counters: {
          entriesEvaluated: 1,
          liveLanded: 1,
          tombstonesLanded: 0,
          localWon: 0,
          remoteRejectedMalformed: 0,
        },
      };
    });

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async (v: number) => {
        persisted.push(v);
      },
      bundleEncryptionKey: new Uint8Array(32),
      applySnapshot,
    });

    await callback(CID.parse(rootCid).bytes, 12);

    expect(applySnapshot).toHaveBeenCalledTimes(1);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].entryCount).toBe(1);
    expect(persisted).toEqual([12]);

    // Legacy bundle-ref write path MUST NOT run when applySnapshot is wired.
    expect(db._store.size).toBe(0);
  });

  it('does NOT advance the version when applySnapshot throws', async () => {
    const db = createMockDb();
    const { carBytes, rootCid } = await buildSnapshotCar();

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => carBytes);

    let persistCalled = false;
    const applySnapshot = vi.fn(async () => {
      throw new Error('dispatcher exploded');
    });

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        persistCalled = true;
      },
      bundleEncryptionKey: new Uint8Array(32),
      applySnapshot,
    });

    await expect(
      callback(CID.parse(rootCid).bytes, 99),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_PROTOCOL_ERROR',
    });
    expect(persistCalled).toBe(false);
    expect(applySnapshot).toHaveBeenCalledTimes(1);
  });

  it('throws PROTOCOL_ERROR when the CAR is not a valid lean snapshot', async () => {
    const db = createMockDb();
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    // Return bytes that are not a parseable CAR — definitely not a
    // lean snapshot.
    fetchMock.mockImplementation(async () => new Uint8Array([0, 1, 2, 3, 4]));

    let persistCalled = false;
    const applySnapshot = vi.fn();

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        persistCalled = true;
      },
      bundleEncryptionKey: new Uint8Array(32),
      applySnapshot,
    });

    await expect(
      callback(CID.parse(TEST_CID_STRING).bytes, 33),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_PROTOCOL_ERROR',
    });
    expect(persistCalled).toBe(false);
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('legacy fallback (no applySnapshot wired) still writes bundle ref', async () => {
    // Regression check: removing the snapshot-aware path should NOT
    // affect callers that haven't wired the new callback.
    const db = createMockDb();
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Uint8Array([0xbe, 0xef]));

    const persisted: number[] = [];
    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      db,
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async (v: number) => {
        persisted.push(v);
      },
      bundleEncryptionKey: new Uint8Array(32).fill(0x99),
      // applySnapshot intentionally omitted.
    });

    await callback(CID.parse(TEST_CID_STRING).bytes, 7);

    // Legacy bundle-ref path ran.
    const bundleKey = `tokens.bundle.${TEST_CID_STRING}`;
    expect(db._store.has(bundleKey)).toBe(true);
    expect(persisted).toEqual([7]);
  });
});
