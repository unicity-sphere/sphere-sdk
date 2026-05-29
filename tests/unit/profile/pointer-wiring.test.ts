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
import {
  DURABLE_STORAGE,
  ProfilePointerLayer,
} from '../../../profile/aggregator-pointer';
import { buildProfilePointerLayer } from '../../../profile/pointer-wiring';
import { createFileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';

/**
 * Item #15 Phase E: the pointer layer now requires an applySnapshot
 * callback. A no-op stub satisfies the precondition for tests that
 * cover the OTHER precondition branches.
 */
const NO_OP_APPLY_SNAPSHOT = async () => ({
  joinedAny: false,
  addressesSeen: 0,
  bundleEntriesSeen: 0,
  counters: {
    entriesEvaluated: 0,
    liveLanded: 0,
    tombstonesLanded: 0,
    localWon: 0,
    remoteRejectedMalformed: 0,
  },
});

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
    applySnapshot: NO_OP_APPLY_SNAPSHOT,
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

  // Item #15 Phase E: applySnapshot is now REQUIRED for pointer-layer
  // construction. Wiring without it is a skip rather than a runtime
  // crash on the first remote pointer.
  it('skips with snapshot_applier_missing when applySnapshot is omitted', async () => {
    const result = await buildProfilePointerLayer({
      ...commonInput(),
      // Override the common stub with undefined to trigger the skip.
      applySnapshot: undefined as unknown as typeof NO_OP_APPLY_SNAPSHOT,
      localCache: createCache({ markDurable: true }),
      oracle: createOracle({ withAggregatorClient: true, withTrustBase: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('snapshot_applier_missing');
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
//
// Item #15 Phase E: the legacy bundle-CID-only write path was removed
// from `buildFetchAndJoin`. The pre-flight failure modes (gateway
// missing, malformed CID, CAR fetch failure) still belong here; the
// post-fetch contract is now snapshot-only and is covered in the
// "Item #15 Phase D.2 snapshot apply" block below.
// ---------------------------------------------------------------------------

describe('fetchAndJoin pre-flight (Item #15 Phase E)', () => {
  // A real CIDv1 raw-codec, SHA-256 hash of the 3-byte string "hi\n".
  // Stable and small — used to avoid hand-crafting varint-prefixed bytes.
  const TEST_CID_STRING = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

  it('throws CAR_UNAVAILABLE when the IPFS fetch fails', async () => {
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => {
      throw new Error('all gateways exhausted');
    });

    const applySnapshot = vi.fn();
    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {},
      applySnapshot,
    });

    await expect(
      callback(CID.parse(TEST_CID_STRING).bytes, 4),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_CAR_UNAVAILABLE',
    });
    // Snapshot applier MUST NOT see the CAR — fetch failed before parse.
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('throws CAR_UNAVAILABLE when no gateways are configured', async () => {
    const applySnapshot = vi.fn();
    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      gateways: [],
      persistLocalVersion: async () => {},
      applySnapshot,
    });
    await expect(
      callback(CID.parse(TEST_CID_STRING).bytes, 2),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_CAR_UNAVAILABLE',
    });
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('throws PROTOCOL_ERROR on malformed CID bytes', async () => {
    const applySnapshot = vi.fn();
    const { __internal } = await import('../../../profile/pointer-wiring');
    const callback = __internal.buildFetchAndJoin({
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {},
      applySnapshot,
    });
    // 64 zero bytes is not a valid CID encoding.
    await expect(
      callback(new Uint8Array(64), 1),
    ).rejects.toMatchObject({
      code: 'AGGREGATOR_POINTER_PROTOCOL_ERROR',
    });
    expect(applySnapshot).not.toHaveBeenCalled();
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
   * Build a snapshot and return both the full CAR bytes (for tests that
   * still want to exercise the legacy in-process CAR path) AND the
   * dag-cbor root block bytes (what `fetchFromIpfs(rootCid)` returns now
   * that the producer pins via `dag/import`). Phase E follow-up: the
   * pointer-wiring fetch path consumes the root block bytes directly —
   * see `profile/factory.ts` for the symmetric production wiring.
   */
  async function buildSnapshotCar(): Promise<{
    carBytes: Uint8Array;
    rootBlockBytes: Uint8Array;
    rootCid: string;
    /**
     * Phase 4 (issue #200) — v3 snapshots are multi-block (root + one
     * sub-block per entry group). Tests that mock `fetchFromIpfs` for
     * the entire walk now look up by CID via this map; the mock's
     * `mockImplementation` should dispatch through it.
     */
    blockMap: Map<string, Uint8Array>;
  }> {
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
    // Extract every block from the CAR. The root block is the dag-cbor
    // envelope; the others are per-group entry sub-blocks linked from
    // the root. `fetchFromIpfs` returns each block's bytes under its
    // canonical CID, so mocks must dispatch by CID via blockMap.
    const { CarReader } = await import('@ipld/car');
    const reader = await CarReader.fromBytes(result.carBytes);
    const roots = await reader.getRoots();
    const blockMap = new Map<string, Uint8Array>();
    let rootBlockBytes: Uint8Array | undefined;
    for await (const block of reader.blocks()) {
      blockMap.set(block.cid.toString(), block.bytes);
      if (block.cid.toString() === roots[0]?.toString()) {
        rootBlockBytes = block.bytes;
      }
    }
    if (!rootBlockBytes) throw new Error('test: root block missing from CAR');
    return {
      carBytes: result.carBytes,
      rootBlockBytes,
      rootCid: result.rootCid,
      blockMap,
    };
  }

  it('parses the snapshot root block, calls applySnapshot, and persists the version', async () => {
    const { rootCid, blockMap } = await buildSnapshotCar();

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_gateways: string[], cid: string) => {
      const bytes = blockMap.get(cid);
      if (!bytes) throw new Error(`test mock: no block for ${cid}`);
      return bytes;
    });

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
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async (v: number) => {
        persisted.push(v);
      },
      applySnapshot,
    });

    await callback(CID.parse(rootCid).bytes, 12);

    expect(applySnapshot).toHaveBeenCalledTimes(1);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].entryCount).toBe(1);
    expect(persisted).toEqual([12]);
  });

  it('calls applySnapshot BEFORE persisting the local version', async () => {
    // Ordering invariant for Phase E: per-writer JOIN must land before
    // the pointer cursor advances. A failure in applySnapshot keeps the
    // cursor behind the unconsumed remote, so the next reconcile pass
    // re-fetches + re-applies idempotently. Reversing the order would
    // strand the cursor past unapplied snapshot state.
    const { rootCid, blockMap } = await buildSnapshotCar();
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_gateways: string[], cid: string) => {
      const bytes = blockMap.get(cid);
      if (!bytes) throw new Error(`test mock: no block for ${cid}`);
      return bytes;
    });

    const order: string[] = [];
    const applySnapshot = vi.fn(async () => {
      order.push('applySnapshot');
      return {
        joinedAny: true,
        addressesSeen: 1,
        bundleEntriesSeen: 0,
        counters: {
          entriesEvaluated: 0,
          liveLanded: 0,
          tombstonesLanded: 0,
          localWon: 0,
          remoteRejectedMalformed: 0,
        },
      };
    });

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        order.push('persistLocalVersion');
      },
      applySnapshot,
    });

    await callback(CID.parse(rootCid).bytes, 11);
    expect(order).toEqual(['applySnapshot', 'persistLocalVersion']);
  });

  it('does NOT advance the version when applySnapshot throws', async () => {
    const { rootCid, blockMap } = await buildSnapshotCar();

    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_gateways: string[], cid: string) => {
      const bytes = blockMap.get(cid);
      if (!bytes) throw new Error(`test mock: no block for ${cid}`);
      return bytes;
    });

    let persistCalled = false;
    const applySnapshot = vi.fn(async () => {
      throw new Error('dispatcher exploded');
    });

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        persistCalled = true;
      },
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

  it('throws PROTOCOL_ERROR when the snapshot root block is not a valid lean snapshot', async () => {
    const { fetchFromIpfs } = await import('../../../profile/ipfs-client');
    const fetchMock = fetchFromIpfs as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    // Return bytes that are not a parseable dag-cbor block — definitely
    // not a lean snapshot. Phase E removed the legacy bundle-CID fallback,
    // so malformed snapshot bytes are a hard error (the next reconcile
    // pass will re-fetch + re-attempt; operator intervention required if
    // the remote keeps publishing malformed snapshots).
    fetchMock.mockImplementation(async () => new Uint8Array([0, 1, 2, 3, 4]));

    let persistCalled = false;
    const applySnapshot = vi.fn();

    const { __internal } = await import('../../../profile/pointer-wiring');
    const { CID } = await import('multiformats/cid');
    const callback = __internal.buildFetchAndJoin({
      gateways: ['https://ipfs.example'],
      persistLocalVersion: async () => {
        persistCalled = true;
      },
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
});
