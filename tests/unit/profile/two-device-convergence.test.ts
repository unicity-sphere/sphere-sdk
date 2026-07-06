/**
 * Two-Device Profile Convergence — unit test.
 *
 * Pins the cross-device JOIN convergence invariant: when two devices
 * sharing the SAME wallet identity each independently produce a CAR
 * with a distinct set of tokens, and the aggregator-pointer-driven
 * `fetchAndJoin` flow eventually replicates BOTH bundle refs into
 * BOTH devices' OrbitDB views, BOTH devices' `load()` must return the
 * JOINT token set.
 *
 * Why a unit test (in addition to pointer-layer category-C and the
 * e2e suite): the pointer-layer tests prove §9.2 conflict resolution
 * at the aggregator-pointer layer (one CID wins, the other CID is
 * fetched + bundle ref recorded). The e2e tests prove the full stack
 * end-to-end against real testnet infrastructure. This unit test
 * sits between them: it isolates the Profile-layer JOIN convergence
 * given replicated bundle-ref state, with zero external infrastructure
 * (no aggregator, no IPFS gateway, no Nostr relay). It catches
 * regressions in the multi-bundle JOIN code path even when the
 * pointer-layer plumbing is healthy.
 *
 * Test architecture:
 *
 *   Device A                                Device B
 *   ┌────────────────────────┐              ┌────────────────────────┐
 *   │ ProfileTokenStorage_A  │              │ ProfileTokenStorage_B  │
 *   │ (own OrbitDB_A)        │              │ (own OrbitDB_B)        │
 *   └────────────┬───────────┘              └────────────┬───────────┘
 *                │                                       │
 *                ├──── shared identity / enc key ────────┤
 *                │                                       │
 *                ├──── shared in-memory IPFS ────────────┤
 *                │     (CAR bytes keyed by CID)          │
 *                │                                       │
 *   simulated convergence: helper copies BOTH devices'   │
 *   bundle refs into BOTH OrbitDBs (models the post-     │
 *   pointer-resolution / post-libp2p-replication state). │
 *
 * The simulation is deliberately a "trust me, replication happened"
 * shortcut. The §9.2 race + aggregator-pointer publish path is
 * covered by `tests/integration/pointer/category-C.test.ts`; this
 * test verifies that, given replicated state, the Profile-layer
 * JOIN correctly assembles the joint token set from both CARs in
 * shared IPFS.
 *
 * Method: instead of driving save() through the multipart-pin path
 * (which is hard to mock without re-implementing Kubo's form-data
 * parser inside the test), we pre-stage CAR bytes in the shared IPFS
 * store and write the corresponding bundle refs directly into each
 * device's OrbitDB. This mirrors the pattern used by `load() merges
 * multiple active bundles` in profile-token-storage-provider.test.ts
 * but extends it to two independent OrbitDB instances + simulated
 * cross-replication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ProfileDatabase,
  OrbitDbConfig,
  UxfBundleRef,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../profile/encryption';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

// ---------------------------------------------------------------------------
// Test identity — shared across both devices (same wallet, two devices)
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function getEncryptionKey(): Uint8Array {
  return deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
}

function cidForBytes(bytes: Uint8Array): string {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest).toString();
}

// ---------------------------------------------------------------------------
// Mock UxfPackage — pass-through that preserves token IDs.
// ---------------------------------------------------------------------------

vi.mock('../../../uxf/UxfPackage.js', async () => {
  // Issue #200 Phase 2: `toCar()` must return a real CAR (not JSON bytes)
  // because the flush scheduler now calls `extractCarRootCid` +
  // `pinCarBlocksToIpfs`. `makeFakeUxfCar` wraps the payload in a
  // minimal valid CAR; `decodeFakeUxfCar` recovers it.
  const { makeFakeUxfCar, decodeFakeUxfCar } = await import(
    './_helpers/fake-uxf-car.js'
  );
  return {
    UxfPackage: {
      create() {
        const tokens: unknown[] = [];
        return {
          _tokens: tokens,
          ingestAll(items: unknown[]) {
            tokens.push(...items);
            this._tokens = tokens;
          },
          merge(other: { _tokens?: unknown[] }) {
            if (other._tokens) {
              tokens.push(...other._tokens);
              this._tokens = tokens;
            }
          },
          assembleAll() {
            const result = new Map<string, unknown>();
            for (let i = 0; i < tokens.length; i++) {
              const t = tokens[i] as Record<string, unknown>;
              const id = (t.id as string) ?? `_token${i}`;
              result.set(id, t);
            }
            return result;
          },
          async toCar() {
            return makeFakeUxfCar({ tokens });
          },
        };
      },
      async fromCar(carBytes: Uint8Array) {
        // Dual-shape decode: prefer the new fake-CAR shape; fall back to
        // raw JSON so legacy fixture bytes still resolve.
        let parsed: { tokens?: unknown[] };
        try {
          parsed = await decodeFakeUxfCar<{ tokens?: unknown[] }>(carBytes);
        } catch {
          parsed = JSON.parse(new TextDecoder().decode(carBytes)) as {
            tokens?: unknown[];
          };
        }
        const tokens: unknown[] = parsed.tokens ?? [];
        return {
          _tokens: tokens,
          ingestAll(items: unknown[]) {
            tokens.push(...items);
          },
          merge(other: { _tokens?: unknown[] }) {
            if (other._tokens) tokens.push(...other._tokens);
          },
          assembleAll() {
            const result = new Map<string, unknown>();
            for (let i = 0; i < tokens.length; i++) {
              const t = tokens[i] as Record<string, unknown>;
              const id = (t.id as string) ?? `_token${i}`;
              result.set(id, t);
            }
            return result;
          },
          async toCar() {
            return makeFakeUxfCar({ tokens });
          },
        };
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Per-device mock OrbitDB (in-memory)
// ---------------------------------------------------------------------------

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  let connected = true;
  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {
      connected = true;
    },
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
    async close() {
      connected = false;
    },
    onReplication() {
      return () => {};
    },
    isConnected() {
      return connected;
    },
  } as MockProfileDb;
}

// ---------------------------------------------------------------------------
// Per-device mock local cache
// ---------------------------------------------------------------------------

function createMockLocalCache() {
  const kv = new Map<string, string>();
  return {
    _kv: kv,
    id: 'mock-local-cache',
    name: 'Mock Local Cache',
    type: 'local' as const,
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity() {},
    async get(key: string) {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string) {
      kv.set(key, value);
    },
    async remove(key: string) {
      kv.delete(key);
    },
    async has(key: string) {
      return kv.has(key);
    },
    async keys(prefix?: string) {
      return [...kv.keys()].filter((k) => !prefix || k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) {
        kv.clear();
        return;
      }
      for (const k of [...kv.keys()]) {
        if (k.startsWith(prefix)) kv.delete(k);
      }
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Shared in-memory IPFS (CAR bytes keyed by CID).
// Both devices' fetches resolve through this same map — modeling the
// fact that in production both devices ultimately read the same content-
// addressed IPFS DHT after libp2p / gateway propagation.
// ---------------------------------------------------------------------------

interface SharedIpfs {
  store: Map<string, Uint8Array>;
  fetchCount: number;
}

function createSharedIpfs(): SharedIpfs {
  return { store: new Map(), fetchCount: 0 };
}

const originalFetch = globalThis.fetch;

function installIpfsFetch(ipfs: SharedIpfs) {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    // FETCH paths used by production fetchFromIpfs:
    //   POST /api/v0/block/get?arg=<cid>
    //   GET  /ipfs/<cid>  (legacy/fallback)
    const blockGetMatch = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    const ipfsPathMatch = url.match(/\/ipfs\/([^?/]+)/);
    const cidArg = blockGetMatch
      ? decodeURIComponent(blockGetMatch[1]!)
      : ipfsPathMatch
        ? ipfsPathMatch[1]
        : null;
    if (cidArg) {
      ipfs.fetchCount += 1;
      const bytes = ipfs.store.get(cidArg);
      if (bytes) {
        return new Response(bytes, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }

    return new Response('unhandled URL: ' + url, { status: 500 });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Per-device provider factory
// ---------------------------------------------------------------------------

function createProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        // Disable IPNS snapshot recovery — this test exercises the
        // bundle-ref JOIN path, not legacy snapshot recovery.
        ipnsSnapshot: false,
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
    },
    localCache as unknown as Parameters<typeof ProfileTokenStorageProvider>[4],
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a CAR-shaped payload (JSON tokens array) and stage it in the
 * shared IPFS under its content-addressed CID. Returns the CID.
 * The bytes match what the mocked `UxfPackage.toCar()` would produce.
 */
function stageCar(ipfs: SharedIpfs, tokens: unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ tokens }));
  const cid = cidForBytes(bytes);
  ipfs.store.set(cid, bytes);
  return cid;
}

/**
 * Write an (encrypted) bundle ref into `db` under the `tokens.bundle.{cid}`
 * key — the same shape `ProfileTokenStorageProvider.addBundle` writes.
 */
async function writeBundleRef(
  db: MockProfileDb,
  cid: string,
  createdAt: number,
): Promise<void> {
  const ref: UxfBundleRef = { cid, status: 'active', createdAt };
  const enc = await encryptProfileValue(
    getEncryptionKey(),
    new TextEncoder().encode(JSON.stringify(ref)),
  );
  db._store.set(`${BUNDLE_KEY_PREFIX}${cid}`, enc);
}

/**
 * Replicate every bundle ref from `src` into `dst`. Models the
 * post-pointer-resolution / post-libp2p-replication state where the
 * destination device has seen the source device's bundle ref.
 * Returns the list of CIDs newly replicated.
 */
function replicateBundleRefs(
  src: MockProfileDb,
  dst: MockProfileDb,
): string[] {
  const cids: string[] = [];
  for (const [key, value] of src._store) {
    if (!key.startsWith(BUNDLE_KEY_PREFIX)) continue;
    if (!dst._store.has(key)) {
      dst._store.set(key, value);
      cids.push(key.slice(BUNDLE_KEY_PREFIX.length));
    }
  }
  return cids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Profile two-device convergence (joint view after independent saves)', () => {
  let ipfs: SharedIpfs;
  let dbA: MockProfileDb;
  let dbB: MockProfileDb;
  let providerA: ProfileTokenStorageProvider;
  let providerB: ProfileTokenStorageProvider;

  beforeEach(async () => {
    ipfs = createSharedIpfs();
    installIpfsFetch(ipfs);
    dbA = createMockDb();
    dbB = createMockDb();
    // Note: providers are constructed but NOT yet initialized — each
    // test populates OrbitDB with bundle refs first, then calls
    // initialize() so the bundle-index picks up the staged refs.
    providerA = createProvider(dbA);
    providerB = createProvider(dbB);
  });

  afterEach(async () => {
    try {
      await providerA.shutdown();
    } catch {
      /* cleanup */
    }
    try {
      await providerB.shutdown();
    } catch {
      /* cleanup */
    }
    restoreFetch();
  });

  // TXF token keys are leading-underscore; `_meta` is the storage
  // envelope, not a token. This filter mirrors the one in the
  // existing `load() merges multiple active bundles` test.
  const tokenIdsOf = (data: TxfStorageDataBase | undefined): Set<string> => {
    if (!data) return new Set();
    return new Set(
      Object.keys(data).filter((k) => k.startsWith('_') && k !== '_meta'),
    );
  };

  it('joint view: each device sees both devices\' tokens after cross-replication of bundle refs', async () => {
    // Device A "mints" two tokens locally (T_A1, T_A2). Stage A's CAR
    // in shared IPFS and record the bundle ref in A's OrbitDB —
    // exactly what `save()` + `addBundle()` would write in production.
    const tokensA = [
      { id: '_ta1', amount: '100', symbol: 'UCT-A' },
      { id: '_ta2', amount: '50', symbol: 'UCT-A' },
    ];
    const cidA = stageCar(ipfs, tokensA);
    await writeBundleRef(dbA, cidA, 1000);

    // Device B "mints" two different tokens locally (T_B1, T_B2). Stage
    // B's CAR in the SAME shared IPFS and record B's bundle ref in B's
    // OrbitDB. Note: identical tokens on both sides would collapse to
    // the same CID — we deliberately use disjoint tokens so each
    // device produces a unique CID.
    const tokensB = [
      { id: '_tb1', amount: '200', symbol: 'UCT-B' },
      { id: '_tb2', amount: '75', symbol: 'UCT-B' },
    ];
    const cidB = stageCar(ipfs, tokensB);
    await writeBundleRef(dbB, cidB, 2000);

    // Sanity: each device has only its OWN bundle ref so far.
    expect(cidA).not.toBe(cidB);
    expect(ipfs.store.size).toBe(2);
    expect([...dbA._store.keys()].filter((k) => k.startsWith(BUNDLE_KEY_PREFIX)))
      .toEqual([`${BUNDLE_KEY_PREFIX}${cidA}`]);
    expect([...dbB._store.keys()].filter((k) => k.startsWith(BUNDLE_KEY_PREFIX)))
      .toEqual([`${BUNDLE_KEY_PREFIX}${cidB}`]);

    // ===== Simulate cross-device replication =====
    // Production delivers this via:
    //   (a) aggregator-pointer publish + recover + fetchAndJoin
    //   (b) libp2p gossipsub OrbitDB op replication
    // Here we shortcut: copy each side's bundle ref into the other.
    const newOnA = replicateBundleRefs(dbB, dbA);
    const newOnB = replicateBundleRefs(dbA, dbB);
    expect(newOnA).toEqual([cidB]);
    expect(newOnB).toEqual([cidA]);

    // Initialize NOW so each provider's bundle-index picks up BOTH
    // refs (its own + the replicated one).
    await providerA.initialize();
    await providerB.initialize();

    // ===== Both devices' load() must now return the JOINT token set =====
    const loadA = await providerA.load();
    const loadB = await providerB.load();
    expect(loadA.success).toBe(true);
    expect(loadB.success).toBe(true);

    const expected = new Set(['_ta1', '_ta2', '_tb1', '_tb2']);
    expect(tokenIdsOf(loadA.data)).toEqual(expected);
    expect(tokenIdsOf(loadB.data)).toEqual(expected);
  });

  it('each device pulls the OTHER device\'s CAR via shared IPFS during JOIN load()', async () => {
    // Device A has T_A1; Device B has T_B1. Replicate refs.
    const cidA = stageCar(ipfs, [{ id: '_ta1', amount: '100' }]);
    const cidB = stageCar(ipfs, [{ id: '_tb1', amount: '200' }]);
    await writeBundleRef(dbA, cidA, 1000);
    await writeBundleRef(dbB, cidB, 2000);
    replicateBundleRefs(dbB, dbA);
    replicateBundleRefs(dbA, dbB);

    await providerA.initialize();
    await providerB.initialize();

    const fetchBefore = ipfs.fetchCount;
    const loadA = await providerA.load();
    const loadB = await providerB.load();
    expect(loadA.success).toBe(true);
    expect(loadB.success).toBe(true);

    // Each load() must trigger CAR fetches against the shared IPFS —
    // the content-addressed store is the only place each device can
    // retrieve the other side's CAR bytes.
    expect(ipfs.fetchCount).toBeGreaterThan(fetchBefore);
  });

  it('joint set is order-independent: A-then-B vs B-then-A yield identical views', async () => {
    const cidA = stageCar(ipfs, [
      { id: '_ta1', amount: '11' },
      { id: '_ta2', amount: '22' },
    ]);
    const cidB = stageCar(ipfs, [{ id: '_tb1', amount: '33' }]);
    await writeBundleRef(dbA, cidA, 1000);
    await writeBundleRef(dbB, cidB, 2000);
    replicateBundleRefs(dbB, dbA);
    replicateBundleRefs(dbA, dbB);

    await providerA.initialize();
    await providerB.initialize();

    const loadA1 = await providerA.load();
    const loadB1 = await providerB.load();
    // Repeat in opposite order — load() must be idempotent and the
    // result must not depend on which device loads first.
    const loadB2 = await providerB.load();
    const loadA2 = await providerA.load();

    const expected = new Set(['_ta1', '_ta2', '_tb1']);
    expect(tokenIdsOf(loadA1.data)).toEqual(expected);
    expect(tokenIdsOf(loadB1.data)).toEqual(expected);
    expect(tokenIdsOf(loadA2.data)).toEqual(expected);
    expect(tokenIdsOf(loadB2.data)).toEqual(expected);
  });

  it('regression guard: WITHOUT cross-replication each device sees only its OWN tokens', async () => {
    // Negative case — confirms that the joint-view assertions in the
    // other tests would FAIL without the replicateBundleRefs() step.
    // A future refactor that accidentally shares OrbitDB state between
    // providers would make the convergence tests pass for the wrong
    // reason; this test pins the pre-convergence isolation.
    const cidA = stageCar(ipfs, [{ id: '_ta1', amount: '100' }]);
    const cidB = stageCar(ipfs, [{ id: '_tb1', amount: '200' }]);
    await writeBundleRef(dbA, cidA, 1000);
    await writeBundleRef(dbB, cidB, 2000);
    // NOTE: no replicateBundleRefs() call.

    await providerA.initialize();
    await providerB.initialize();

    const loadA = await providerA.load();
    const loadB = await providerB.load();

    // Each side sees ONLY its own token before convergence.
    expect(tokenIdsOf(loadA.data)).toEqual(new Set(['_ta1']));
    expect(tokenIdsOf(loadB.data)).toEqual(new Set(['_tb1']));
  });

  it('asymmetric replication: A receives B\'s ref but B has not yet seen A\'s — only A converges', async () => {
    // Models the in-flight propagation window where one direction of
    // replication has completed but the reverse is still pending.
    // Catches regressions where the JOIN code path assumes symmetric
    // bundle visibility.
    const cidA = stageCar(ipfs, [{ id: '_ta1', amount: '100' }]);
    const cidB = stageCar(ipfs, [{ id: '_tb1', amount: '200' }]);
    await writeBundleRef(dbA, cidA, 1000);
    await writeBundleRef(dbB, cidB, 2000);

    // Only replicate B → A. (Models libp2p delivery from B to A landing
    // first; the reverse direction is still in flight.)
    replicateBundleRefs(dbB, dbA);

    await providerA.initialize();
    await providerB.initialize();

    const loadA = await providerA.load();
    const loadB = await providerB.load();

    // A has BOTH refs → sees the joint set.
    expect(tokenIdsOf(loadA.data)).toEqual(new Set(['_ta1', '_tb1']));
    // B only has its own ref → still sees only its own token.
    expect(tokenIdsOf(loadB.data)).toEqual(new Set(['_tb1']));

    // Finish replication in the other direction → B catches up after
    // re-loading bundle index (sync() does this).
    replicateBundleRefs(dbA, dbB);
    await providerB.sync(loadB.data ?? ({} as TxfStorageDataBase));
    const loadB2 = await providerB.load();
    expect(tokenIdsOf(loadB2.data)).toEqual(new Set(['_ta1', '_tb1']));
  });
});
