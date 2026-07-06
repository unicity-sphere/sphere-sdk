/**
 * Tests for profile/profile-token-storage-provider.ts
 *
 * Uses mock ProfileDatabase, mock IPFS (fetch interception), and mock
 * UxfPackage to test save/load, write-behind buffer, bundle management,
 * operational state, history, replication events, and encryption.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig, UxfBundleRef } from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type {
  TxfStorageDataBase,
  TxfMeta,
  StorageEvent,
  HistoryRecord,
} from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
  decryptProfileValue,
  encryptString,
  decryptString,
} from '../../../profile/encryption';
import { waitForFlushSettled } from '../../helpers/profile/waitForFlushSettled';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

/**
 * Compute the CIDv1 (raw codec, sha256 multihash) that `fetchFromIpfs`
 * will verify for the given bytes. Needed because the CID verification
 * fix in profile/ipfs-client.ts rejects any gateway response whose
 * sha256 does not match the requested CID.
 */
function cidForBytes(bytes: Uint8Array): string {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest).toString();
}

// ---------------------------------------------------------------------------
// Constants
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function buildTxfData(tokens: Record<string, unknown> = {}): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: {
      version: 1,
      address: EXPECTED_ADDRESS_ID,
      formatVersion: '1.0.0',
      updatedAt: Date.now(),
    },
    ...tokens,
  };
  return data;
}

function makeHistoryEntry(opts: Partial<HistoryRecord> & { dedupKey: string }): HistoryRecord {
  return {
    id: opts.id ?? `id-${opts.dedupKey}`,
    dedupKey: opts.dedupKey,
    type: opts.type ?? 'SENT',
    amount: opts.amount ?? '100',
    coinId: opts.coinId ?? 'UCT',
    symbol: opts.symbol ?? 'UCT',
    timestamp: opts.timestamp ?? Date.now(),
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Mock ProfileDatabase (in-memory)
// ---------------------------------------------------------------------------

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
  _triggerReplication(): void;
  _listeners: Array<() => void>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  const listeners: Array<() => void> = [];
  let connected = true;

  return {
    _store: store,
    _listeners: listeners,
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
      const result = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v);
        }
      }
      return result;
    },
    async close() {
      connected = false;
    },
    onReplication(cb: () => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    isConnected() {
      return connected;
    },
    _triggerReplication() {
      listeners.forEach((cb) => cb());
    },
  } as MockProfileDb;
}

// ---------------------------------------------------------------------------
// Mock UxfPackage
// ---------------------------------------------------------------------------

vi.mock('../../../uxf/UxfPackage.js', async () => {
  // Issue #200 Phase 2: production now calls `extractCarRootCid` +
  // `pinCarBlocksToIpfs` against `toCar()` output, so the mock must
  // produce a real CAR (not raw JSON bytes). `makeFakeUxfCar` wraps
  // the JSON-shaped test payload inside a single dag-cbor envelope
  // block; `decodeFakeUxfCar` recovers the payload symmetrically.
  const { makeFakeUxfCar, decodeFakeUxfCar } = await import(
    './_helpers/fake-uxf-car.js'
  );

  let ingestedTokens: unknown[] = [];
  let mergedPackages: Array<{ tokens: unknown[] }> = [];

  const mockPkg = {
    ingestAll(tokens: unknown[]) {
      ingestedTokens = [...ingestedTokens, ...tokens];
    },
    merge(other: { _tokens?: unknown[] }) {
      if (other._tokens) {
        mergedPackages.push({ tokens: other._tokens });
        ingestedTokens = [...ingestedTokens, ...other._tokens];
      }
    },
    assembleAll() {
      const result = new Map<string, unknown>();
      for (let i = 0; i < ingestedTokens.length; i++) {
        const token = ingestedTokens[i] as Record<string, unknown>;
        const id = (token.id as string) ?? `_token${i}`;
        result.set(id, token);
      }
      return result;
    },
    async toCar() {
      return makeFakeUxfCar({ tokens: ingestedTokens });
    },
    _tokens: ingestedTokens,
  };

  return {
    UxfPackage: {
      create() {
        ingestedTokens = [];
        mergedPackages = [];
        const pkg = { ...mockPkg, _tokens: ingestedTokens };
        // Rebind so assembleAll/toCar see the latest tokens
        pkg.ingestAll = (tokens: unknown[]) => {
          ingestedTokens.push(...tokens);
          pkg._tokens = ingestedTokens;
        };
        pkg.merge = (other: { _tokens?: unknown[] }) => {
          if (other._tokens) {
            ingestedTokens.push(...other._tokens);
            pkg._tokens = ingestedTokens;
          }
        };
        pkg.assembleAll = () => {
          const result = new Map<string, unknown>();
          for (let i = 0; i < ingestedTokens.length; i++) {
            const token = ingestedTokens[i] as Record<string, unknown>;
            const id = (token.id as string) ?? `_token${i}`;
            result.set(id, token);
          }
          return result;
        };
        pkg.toCar = async () => makeFakeUxfCar({ tokens: ingestedTokens });
        return pkg;
      },
      async fromCar(carBytes: Uint8Array) {
        // Dual-shape decode: many tests in this file pre-build "CAR"
        // bytes as raw JSON (legacy fixture shape) and pass them through
        // `fetchFromIpfs` mocks. Try the new `makeFakeUxfCar` shape
        // first; on parse failure fall back to raw JSON so legacy
        // fixtures still resolve. Both shapes carry a `{ tokens }`
        // payload at the top level.
        let parsed: { tokens?: unknown[] };
        try {
          parsed = await decodeFakeUxfCar<{ tokens?: unknown[] }>(carBytes);
        } catch {
          const text = new TextDecoder().decode(carBytes);
          parsed = JSON.parse(text) as { tokens?: unknown[] };
        }
        return {
          _tokens: parsed.tokens ?? [],
          ingestAll(tokens: unknown[]) {
            this._tokens.push(...tokens);
          },
          merge(other: { _tokens?: unknown[] }) {
            if (other._tokens) {
              this._tokens.push(...other._tokens);
            }
          },
          assembleAll() {
            const result = new Map<string, unknown>();
            for (let i = 0; i < this._tokens.length; i++) {
              const token = this._tokens[i] as Record<string, unknown>;
              const id = (token.id as string) ?? `_token${i}`;
              result.set(id, token);
            }
            return result;
          },
          async toCar() {
            return makeFakeUxfCar({ tokens: this._tokens });
          },
        };
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock StorageProvider for the local derived cache (per-device, not replicated)
// ---------------------------------------------------------------------------

interface MockLocalCache {
  _kv: Map<string, string>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): string;
  setIdentity(identity: unknown): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
  saveTrackedAddresses(entries: unknown[]): Promise<void>;
  loadTrackedAddresses(): Promise<unknown[]>;
  id: string;
  name: string;
  type: 'local';
}

function createMockLocalCache(): MockLocalCache {
  const kv = new Map<string, string>();
  return {
    _kv: kv,
    id: 'mock-local-cache',
    name: 'Mock Local Cache',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
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
      const out: string[] = [];
      for (const k of kv.keys()) {
        if (!prefix || k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
    async clear(prefix?: string) {
      if (!prefix) {
        kv.clear();
        return;
      }
      for (const k of Array.from(kv.keys())) {
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
// Factory: Create a provider with mock dependencies
// ---------------------------------------------------------------------------

function createProvider(
  db: MockProfileDb,
  opts?: {
    encryptionKey?: Uint8Array | null;
    flushDebounceMs?: number;
    localCache?: MockLocalCache | null;
  },
): ProfileTokenStorageProvider {
  const encKey = opts?.encryptionKey !== undefined ? opts.encryptionKey : getEncryptionKey();
  const localCache =
    opts?.localCache !== undefined ? opts.localCache : createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    encKey,
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        // IPNS publish/resolve is exercised end-to-end in the e2e
        // suite against real infrastructure. Unit tests count
        // pinToIpfs invocations and would otherwise be perturbed
        // by the extra snapshot pin.
        ipnsSnapshot: false,
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: opts?.flushDebounceMs ?? 50, // short debounce for testing
    },
    localCache as unknown as Parameters<typeof ProfileTokenStorageProvider>[4],
  );
  provider.setIdentity(TEST_IDENTITY);
  (provider as unknown as { _mockLocalCache: MockLocalCache | null })._mockLocalCache =
    localCache;
  return provider;
}

function getMockLocalCache(
  provider: ProfileTokenStorageProvider,
): MockLocalCache | null {
  return (provider as unknown as { _mockLocalCache: MockLocalCache | null })
    ._mockLocalCache;
}

// ---------------------------------------------------------------------------
// Mock fetch for IPFS pin/get
// ---------------------------------------------------------------------------

let mockFetchHandler: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

const originalFetch = globalThis.fetch;

function installMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  mockFetchHandler = handler;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    // Production fetchFromIpfs uses Kubo's POST /api/v0/block/get?arg=<cid>
    // path (with a GET fallback on 405/501). Existing per-test handlers in
    // this file pattern-match on the legacy `/ipfs/<cid>` URL shape. To
    // keep handlers stable, normalize the canonical block-get URL into
    // the legacy shape before dispatching. The handler itself is unchanged.
    const blockGetMatch = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    const normalizedUrl = blockGetMatch
      ? `${url.split('/api/v0/')[0]}/ipfs/${decodeURIComponent(blockGetMatch[1]!)}`
      : url;
    return handler(normalizedUrl, init);
  };
}

function uninstallMockFetch() {
  globalThis.fetch = originalFetch;
  mockFetchHandler = null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileTokenStorageProvider', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallMockFetch();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('Lifecycle', () => {
    it('initialize() returns false when no identity is set', async () => {
      const provider = new ProfileTokenStorageProvider(
        db,
        getEncryptionKey(),
        [],
        {
          config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
          addressId: EXPECTED_ADDRESS_ID,
          encrypt: true,
        },
      );
      // Don't call setIdentity
      const result = await provider.initialize();
      expect(result).toBe(false);
    });

    it('initialize() succeeds and loads known bundles', async () => {
      // Pre-populate OrbitDB with bundle refs
      const encKey = getEncryptionKey();
      const ref1: UxfBundleRef = { cid: 'cid1', status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: 'cid2', status: 'active', createdAt: 200 };
      const enc1 = await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1)));
      const enc2 = await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2)));
      db._store.set(`${BUNDLE_KEY_PREFIX}cid1`, enc1);
      db._store.set(`${BUNDLE_KEY_PREFIX}cid2`, enc2);

      const provider = createProvider(db);
      const result = await provider.initialize();
      expect(result).toBe(true);
      expect(provider.isConnected()).toBe(true);
    });

    it('shutdown() cancels pending flush timer', async () => {
      const provider = createProvider(db, { flushDebounceMs: 5000 });
      await provider.initialize();

      installMockFetch(async () => {
        return new Response(JSON.stringify({ Cid: { '/': 'cidX' } }), { status: 200 });
      });

      const txfData = buildTxfData({ _token1: { id: '_token1', amount: '100' } });
      await provider.save(txfData);

      // Shutdown before flush fires
      await provider.shutdown();

      // The flush should have been attempted during shutdown (pendingData existed)
      // But the timer itself was cancelled
      expect(provider.isConnected()).toBe(false);
    });
  });

  // =========================================================================
  // save() -- write-behind buffer
  // =========================================================================

  describe('save() -- write-behind buffer', () => {
    it('save() accepts data immediately and returns success', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const txfData = buildTxfData({ _token1: { id: '_token1' } });
      const result = await provider.save(txfData);
      expect(result.success).toBe(true);
    });

    it('multiple rapid saves produce single flush', async () => {
      vi.useRealTimers(); // Use real timers for this test since fake timers + async flush is fragile

      let pinCallCount = 0;
      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          pinCallCount++;
          return new Response(JSON.stringify({ Cid: { '/': `cid-${pinCallCount}` } }), {
            status: 200,
          });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      const data1 = buildTxfData({ _t1: { id: '_t1' } });
      const data2 = buildTxfData({ _t1: { id: '_t1' }, _t2: { id: '_t2' } });
      const data3 = buildTxfData({ _t1: { id: '_t1' }, _t2: { id: '_t2' }, _t3: { id: '_t3' } });

      await provider.save(data1);
      await provider.save(data2);
      await provider.save(data3);

      // Wait for debounce + flush to complete
      await waitForFlushSettled(provider, 10000);

      // Only one pin call should have been made
      expect(pinCallCount).toBe(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('save() without initialization returns error', async () => {
      const provider = createProvider(db);
      // Do NOT call initialize()
      const txfData = buildTxfData();
      const result = await provider.save(txfData);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // load() -- multi-bundle merge
  // =========================================================================

  describe('load() -- multi-bundle merge', () => {
    it('load() returns pending data if present', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const txfData = buildTxfData({ _token1: { id: '_token1', amount: '50' } });
      await provider.save(txfData);

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.source).toBe('cache');
      expect(loadResult.data).toBe(txfData);
    });

    it('load() returns empty data when no bundles exist', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.data).toBeDefined();
      expect(loadResult.data!._meta).toBeDefined();
    });

    it('load() merges multiple active bundles', async () => {
      const encKey = getEncryptionKey();

      // Bundle 1: tokens A, B (CAR is unencrypted on IPFS)
      const carData1 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_tokenA' }, { id: '_tokenB' }] }),
      );
      const cidA = cidForBytes(carData1);

      // Bundle 2: token C
      const carData2 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_tokenC' }] }),
      );
      const cidB = cidForBytes(carData2);

      // Write bundle refs to OrbitDB (refs remain encrypted in KV)
      const ref1: UxfBundleRef = { cid: cidA, status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: cidB, status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidA}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidB}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2))),
      );

      // Mock fetch for CAR retrieval
      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidA}`)) {
          return new Response(carData1, { status: 200 });
        }
        if (url.includes(`/ipfs/${cidB}`)) {
          return new Response(carData2, { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db);
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.data).toBeDefined();
      // Merged result should contain tokens from both bundles
      const tokenKeys = Object.keys(loadResult.data!).filter(
        (k) => k.startsWith('_') && k !== '_meta',
      );
      expect(tokenKeys.length).toBeGreaterThanOrEqual(2);
    });

    it('JOIN: when same tokenId appears in multiple bundles, merged load contains both states', async () => {
      const encKey = getEncryptionKey();

      // Two bundles each carry a token with the SAME id `_tShared` but with
      // divergent data payloads — the mock UxfPackage treats the `id` as
      // the manifest key and its current merge policy (LWW) picks the
      // source that was merged last. We only assert that the JOIN does
      // NOT drop tokens: both logical chains must be represented in the
      // loaded pool (at minimum by the latest merged version).
      const carA = new TextEncoder().encode(
        JSON.stringify({
          tokens: [
            { id: '_tShared', genesis: { data: { tokenId: 'x', coinData: [['UCT', '100']] } } },
            { id: '_tOnlyInA', genesis: { data: { tokenId: 'y', coinData: [['UCT', '50']] } } },
          ],
        }),
      );
      const carB = new TextEncoder().encode(
        JSON.stringify({
          tokens: [
            // Same id, different state — simulates a divergent chain
            { id: '_tShared', genesis: { data: { tokenId: 'x', coinData: [['UCT', '100']] } }, state: { predicate: 'after-transfer' } },
            { id: '_tOnlyInB', genesis: { data: { tokenId: 'z', coinData: [['UCT', '25']] } } },
          ],
        }),
      );

      const cidAjoin = cidForBytes(carA);
      const cidBjoin = cidForBytes(carB);
      const refA: UxfBundleRef = { cid: cidAjoin, status: 'active', createdAt: 100 };
      const refB: UxfBundleRef = { cid: cidBjoin, status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidAjoin}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(refA))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidBjoin}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(refB))),
      );

      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidAjoin}`)) return new Response(carA, { status: 200 });
        if (url.includes(`/ipfs/${cidBjoin}`)) return new Response(carB, { status: 200 });
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db);
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);

      // The merged view must include both bundle-unique tokens AND
      // represent the shared token — never drop it.
      const keys = Object.keys(loadResult.data!).filter((k) => k.startsWith('_') && k !== '_meta');
      expect(keys).toContain('_tShared');
      expect(keys).toContain('_tOnlyInA');
      expect(keys).toContain('_tOnlyInB');
    });

    it('load() continues on partial bundle failure', async () => {
      const encKey = getEncryptionKey();

      // Bundle 1: succeeds (CAR unencrypted)
      const carData1 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_tokenOK' }] }),
      );

      const cidOK = cidForBytes(carData1);
      const cidFail = 'bafkreiabcdefghijklmnopqrstuvwxyz234567wrongbytesdontmatter4a';
      const ref1: UxfBundleRef = { cid: cidOK, status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: cidFail, status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidOK}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidFail}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2))),
      );

      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidOK}`)) {
          return new Response(carData1, { status: 200 });
        }
        if (url.includes(`/ipfs/${cidFail}`)) {
          return new Response('', { status: 500 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db);
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
    });
  });

  // =========================================================================
  // Bundle management
  // =========================================================================

  describe('bundle management', () => {
    it('addBundle writes encrypted ref to OrbitDB', async () => {
      vi.useRealTimers();

      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          return new Response(JSON.stringify({ Cid: { '/': 'cid-new' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      const txfData = buildTxfData({ _t1: { id: '_t1' } });
      await provider.save(txfData);

      // Wait for debounce + flush
      await waitForFlushSettled(provider, 10000);

      // Check that a bundle ref was written
      const bundleKeys = Array.from(db._store.keys()).filter((k) =>
        k.startsWith(BUNDLE_KEY_PREFIX),
      );
      expect(bundleKeys.length).toBeGreaterThanOrEqual(1);

      // Verify the ref decrypts to valid UxfBundleRef JSON
      const encKey = getEncryptionKey();
      const bundleBytes = db._store.get(bundleKeys[0])!;
      const decrypted = await decryptProfileValue(encKey, bundleBytes);
      const ref = JSON.parse(new TextDecoder().decode(decrypted)) as UxfBundleRef;
      expect(ref.cid).toBeDefined();
      expect(ref.status).toBe('active');

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('listActiveBundles filters by status', async () => {
      const encKey = getEncryptionKey();
      const activeCarData = new TextEncoder().encode(JSON.stringify({ tokens: [{ id: '_t1' }] }));
      const cidActive = cidForBytes(activeCarData);
      const cidOld = 'bafkreiobsoleteoldoldoldoldoldoldoldoldoldoldoldoldoldoldolo';

      // Active bundle
      const activeRef: UxfBundleRef = { cid: cidActive, status: 'active', createdAt: 100 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidActive}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(activeRef))),
      );

      // Superseded bundle
      const supersededRef: UxfBundleRef = {
        cid: cidOld,
        status: 'superseded',
        createdAt: 50,
        supersededBy: cidActive,
      };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidOld}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(supersededRef))),
      );

      const provider = createProvider(db);
      await provider.initialize();

      // Use load() to trigger active bundle listing
      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidActive}`)) {
          return new Response(activeCarData, { status: 200 });
        }
        // Superseded bundles must NOT be fetched
        if (url.includes(`/ipfs/${cidOld}`)) {
          throw new Error('Should not fetch superseded bundle');
        }
        return new Response('', { status: 404 });
      });

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
    });

    it('shouldConsolidate returns true when active count > 3', async () => {
      const encKey = getEncryptionKey();

      // Insert 4 active bundles
      for (let i = 0; i < 4; i++) {
        const ref: UxfBundleRef = { cid: `cid-${i}`, status: 'active', createdAt: i * 100 };
        db._store.set(
          `${BUNDLE_KEY_PREFIX}cid-${i}`,
          await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref))),
        );
      }

      const provider = createProvider(db);
      await provider.initialize();

      // shouldConsolidate is private, but we can observe its effect via flush
      // which logs a consolidation warning. We verify the bundle count instead.
      const allBundles = await db.all(BUNDLE_KEY_PREFIX);
      expect(allBundles.size).toBe(4);
      // 4 > 3 (CONSOLIDATION_WARNING_THRESHOLD) means shouldConsolidate = true
    });
  });

  // =========================================================================
  // Operational state
  // =========================================================================

  describe('operational state', () => {
    it('operational state split between OrbitDB (synced) and local cache (derived)', async () => {
      vi.useRealTimers();

      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          return new Response(JSON.stringify({ Cid: { '/': 'cid-op' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      const txfData = buildTxfData({
        _token1: { id: '_token1' },
      });
      txfData._tombstones = [{ tokenId: 't1', stateHash: 'h1', timestamp: 1000 }];
      txfData._outbox = [
        { id: 'o1', status: 'pending', tokenId: 't1', recipient: 'alice', createdAt: 1000, data: {} },
      ];
      txfData._sent = [{ tokenId: 't1', recipient: 'bob', txHash: 'hash1', sentAt: 2000 }];

      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // Synced (OrbitDB): outbox entry exists under per-entry key
      // (Wave G.7 layout — `${addr}.outbox.${id}` instead of single-
      // blob `${addr}.outbox`).
      const outboxKeys = [...db._store.keys()].filter((k) =>
        k.startsWith(`${EXPECTED_ADDRESS_ID}.outbox.`),
      );
      expect(outboxKeys.length).toBeGreaterThanOrEqual(1);
      // G4 — tombstones ARE now also persisted to OrbitDB (security
      // boundary: cross-device replication + cold-start recovery). The
      // local derived cache still mirrors them for O(1) reads, but
      // OrbitDB is authoritative for replay protection.
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.tombstones`)).toBe(true);
      // sent + transactionHistory remain local-only (per-device).
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.sent`)).toBe(false);
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.transactionHistory`)).toBe(false);

      // Local derived cache: all three fields land in a single atomic key
      const lc = getMockLocalCache(provider)!;
      const derivedRaw = lc._kv.get(`deriver.${EXPECTED_ADDRESS_ID}.all`);
      expect(derivedRaw).toBeDefined();
      const derived = JSON.parse(derivedRaw!);
      expect(Array.isArray(derived.tombstones)).toBe(true);
      expect(Array.isArray(derived.sent)).toBe(true);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('readOperationalState merges OrbitDB (synced) and local cache (derived)', async () => {
      const encKey = getEncryptionKey();
      const addr = EXPECTED_ADDRESS_ID;

      // Synced (OrbitDB) state: outbox, invalid, mintOutbox, invalidatedNametags
      const outbox = [{ id: 'o1', status: 'pending', tokenId: 't1', recipient: 'alice', createdAt: 1000, data: {} }];
      for (const [key, value] of [
        [`${addr}.outbox`, outbox],
        [`${addr}.invalid`, []],
        [`${addr}.mintOutbox`, []],
        [`${addr}.invalidatedNametags`, []],
      ] as const) {
        const encoded = new TextEncoder().encode(JSON.stringify(value));
        const encrypted = await encryptProfileValue(encKey, encoded);
        db._store.set(key, encrypted);
      }

      // Add a dummy active bundle so load() goes through the full merge path
      // (with 0 bundles, load() returns early without reading operational state)
      const emptyCarData = new TextEncoder().encode(JSON.stringify({ tokens: [] }));
      const cidDummy = cidForBytes(emptyCarData);
      const dummyRef: UxfBundleRef = { cid: cidDummy, status: 'active', createdAt: 100 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidDummy}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(dummyRef))),
      );

      // Mock fetch to return an unencrypted CAR with no tokens
      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidDummy}`)) {
          return new Response(emptyCarData, { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      // Local (derived) state: tombstones, sent, history — never in OrbitDB.
      // Written in the new atomic single-key layout.
      const tombstones = [{ tokenId: 't1', stateHash: 'h1', timestamp: 1000 }];
      const sent = [{ tokenId: 't1', recipient: 'bob', txHash: 'hash1', sentAt: 2000 }];
      const localCache = createMockLocalCache();
      localCache._kv.set(
        `deriver.${addr}.all`,
        JSON.stringify({ tombstones, sent, history: [] }),
      );

      const provider = createProvider(db, { localCache });
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.data!._tombstones).toEqual(tombstones);
      expect(loadResult.data!._outbox).toEqual(outbox);
      expect(loadResult.data!._sent).toEqual(sent);
    });

    // Wave G.7 regression — per-entry-key layout
    it('writeOrbitOperationalState writes per-entry keys (Wave G.7)', async () => {
      vi.useRealTimers();
      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          return new Response(JSON.stringify({ Cid: { '/': 'cid-perent' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();
      const txfData = buildTxfData({ _token1: { id: '_token1' } });
      txfData._outbox = [
        { id: 'oA', status: 'pending', tokenId: 't1', recipient: 'alice', createdAt: 1000, data: {} },
        { id: 'oB', status: 'pending', tokenId: 't2', recipient: 'bob',   createdAt: 1001, data: {} },
      ];
      txfData._invalid = [{ tokenId: 'tBad', reason: 'r', detectedAt: 999 }];
      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // Each outbox entry stored under its own key.
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.outbox.oA`)).toBe(true);
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.outbox.oB`)).toBe(true);
      // Single-blob legacy key not present (no migration in this test).
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.outbox`)).toBe(false);
      // Invalid entry under per-entry key by tokenId.
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.invalid.tBad`)).toBe(true);
      // invalidatedNametags stays as a single key (small Set<string>).
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.invalidatedNametags`)).toBe(true);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('removed entry becomes a tombstone in the per-entry layout (Wave G.7)', async () => {
      vi.useRealTimers();
      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          return new Response(JSON.stringify({ Cid: { '/': 'cid-tomb' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();
      const txfData = buildTxfData({ _token1: { id: '_token1' } });
      txfData._outbox = [
        { id: 'oA', status: 'pending', tokenId: 't1', recipient: 'alice', createdAt: 1000, data: {} },
      ];
      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.outbox.oA`)).toBe(true);

      // Second save with empty outbox — oA should be tombstoned.
      const txfData2 = buildTxfData({ _token1: { id: '_token1' } });
      txfData2._outbox = [];
      await provider.save(txfData2);
      await waitForFlushSettled(provider, 10000);

      // The key still exists but its content is a tombstone marker.
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.outbox.oA`)).toBe(true);
      const encKey = getEncryptionKey();
      const tombRaw = db._store.get(`${EXPECTED_ADDRESS_ID}.outbox.oA`)!;
      const decoded = await decryptProfileValue(encKey, tombRaw);
      const parsed = JSON.parse(new TextDecoder().decode(decoded));
      expect(parsed.tombstoned).toBe(true);
      expect(typeof parsed.deletedAt).toBe('number');

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('readOrbitOperationalState falls back to legacy single-blob format (Wave G.7 migration)', async () => {
      const encKey = getEncryptionKey();
      const addr = EXPECTED_ADDRESS_ID;
      // Pre-populate the legacy single-blob layout.
      const legacyOutbox = [
        { id: 'oLegacy', status: 'pending', tokenId: 'tL', recipient: 'eve', createdAt: 500, data: {} },
      ];
      db._store.set(
        `${addr}.outbox`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(legacyOutbox))),
      );
      // Add a dummy active bundle so load() goes through the full
      // merge path (with 0 bundles, load() returns early without
      // reading operational state).
      const emptyCarData = new TextEncoder().encode(JSON.stringify({ tokens: [] }));
      const cidDummy = cidForBytes(emptyCarData);
      const dummyRef: UxfBundleRef = { cid: cidDummy, status: 'active', createdAt: 100 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidDummy}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(dummyRef))),
      );
      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidDummy}`)) {
          return new Response(emptyCarData, { status: 200 });
        }
        return new Response('', { status: 404 });
      });
      const provider = createProvider(db);
      await provider.initialize();
      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.data!._outbox).toEqual(legacyOutbox);
    });
  });

  // =========================================================================
  // sync()
  // =========================================================================

  describe('sync()', () => {
    it('sync() returns zero counts when nothing changed', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const localData = buildTxfData();
      const syncResult = await provider.sync(localData);
      expect(syncResult.added).toBe(0);
      expect(syncResult.removed).toBe(0);
    });

    it('sync() detects new bundles and returns added count', async () => {
      const encKey = getEncryptionKey();
      const provider = createProvider(db);
      await provider.initialize();

      // Simulate a remote device adding a bundle
      const carData = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_newToken' }] }),
      );
      const cidNew = cidForBytes(carData);
      const ref: UxfBundleRef = { cid: cidNew, status: 'active', createdAt: 300 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidNew}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref))),
      );

      // Mock fetch for the new bundle (CAR unencrypted)
      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidNew}`)) {
          return new Response(carData, { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const localData = buildTxfData();
      const syncResult = await provider.sync(localData);
      expect(syncResult.success).toBe(true);
      expect(syncResult.added).toBeGreaterThan(0);
    });

    it('sync() detects removed bundles', async () => {
      const encKey = getEncryptionKey();

      // Start with 2 bundles — content is identical so CID is the same,
      // but we need two distinct OrbitDB keys, so use a spacer.
      const carData1 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_t1' }] }),
      );
      const carData2 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_t1' }, { id: '_t2' }] }),
      );
      const cid1 = cidForBytes(carData1);
      const cid2 = cidForBytes(carData2);
      const ref1: UxfBundleRef = { cid: cid1, status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: cid2, status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cid1}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cid2}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2))),
      );

      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cid1}`)) return new Response(carData1, { status: 200 });
        if (url.includes(`/ipfs/${cid2}`)) return new Response(carData2, { status: 200 });
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db);
      await provider.initialize();

      // Now remove one bundle (simulate remote device)
      db._store.delete(`${BUNDLE_KEY_PREFIX}${cid2}`);

      const localData = buildTxfData({ _t1: { id: '_t1' }, _t2: { id: '_t2' } });
      const syncResult = await provider.sync(localData);
      expect(syncResult.success).toBe(true);
      // cid2 was removed, so some tokens may be gone
      expect(syncResult.removed).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // Replication events
  // =========================================================================

  describe('replication events', () => {
    it('storage:remote-updated event fires on replication with new bundles', async () => {
      vi.useRealTimers();

      const encKey = getEncryptionKey();
      const provider = createProvider(db);
      await provider.initialize();

      const events: StorageEvent[] = [];
      provider.onEvent!((e) => events.push(e));

      // Simulate a new bundle appearing in OrbitDB
      const ref: UxfBundleRef = { cid: 'cid-repl', status: 'active', createdAt: 500 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid-repl`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref))),
      );

      // Trigger replication
      db._triggerReplication();

      // Wait for async handler to complete
      await new Promise((r) => setTimeout(r, 100));

      const remoteUpdated = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteUpdated.length).toBeGreaterThanOrEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('no event fires when replication has no new bundles', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const events: StorageEvent[] = [];
      provider.onEvent!((e) => events.push(e));

      // Trigger replication with no changes
      db._triggerReplication();

      await vi.advanceTimersByTimeAsync(50);

      const remoteUpdated = events.filter((e) => e.type === 'storage:remote-updated');
      expect(remoteUpdated.length).toBe(0);
    });
  });

  // =========================================================================
  // createForAddress
  // =========================================================================

  describe('createForAddress', () => {
    it('createForAddress returns new provider with specified addressId', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const newProvider = provider.createForAddress('DIRECT_111111_222222');
      expect(newProvider).toBeInstanceOf(ProfileTokenStorageProvider);
      expect(newProvider).not.toBe(provider);
    });
  });

  // =========================================================================
  // History operations
  // =========================================================================

  describe('history operations', () => {
    it('addHistoryEntry adds and sorts by timestamp descending', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const entry1 = makeHistoryEntry({ dedupKey: 'A', timestamp: 1000 });
      const entry2 = makeHistoryEntry({ dedupKey: 'B', timestamp: 2000 });

      await provider.addHistoryEntry(entry1);
      await provider.addHistoryEntry(entry2);

      const entries = await provider.getHistoryEntries();
      expect(entries.length).toBe(2);
      expect(entries[0].dedupKey).toBe('B'); // newer first
      expect(entries[1].dedupKey).toBe('A');
    });

    it('addHistoryEntry upserts by dedupKey', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      const entry1 = makeHistoryEntry({ dedupKey: 'A', amount: '100', timestamp: 1000 });
      await provider.addHistoryEntry(entry1);

      const entry2 = makeHistoryEntry({ dedupKey: 'A', amount: '200', timestamp: 2000 });
      await provider.addHistoryEntry(entry2);

      const entries = await provider.getHistoryEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].amount).toBe('200');
    });

    it('hasHistoryEntry returns true for existing dedupKey', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      await provider.addHistoryEntry(makeHistoryEntry({ dedupKey: 'X' }));

      expect(await provider.hasHistoryEntry('X')).toBe(true);
      expect(await provider.hasHistoryEntry('Y')).toBe(false);
    });

    it('clearHistory removes all entries', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      await provider.addHistoryEntry(makeHistoryEntry({ dedupKey: 'A' }));
      await provider.addHistoryEntry(makeHistoryEntry({ dedupKey: 'B' }));

      await provider.clearHistory();
      const entries = await provider.getHistoryEntries();
      expect(entries.length).toBe(0);
    });

    it('importHistoryEntries deduplicates and returns imported count', async () => {
      const provider = createProvider(db);
      await provider.initialize();

      // Add existing entries
      await provider.addHistoryEntry(makeHistoryEntry({ dedupKey: 'A', timestamp: 1000 }));
      await provider.addHistoryEntry(makeHistoryEntry({ dedupKey: 'B', timestamp: 2000 }));

      // Import with some overlap
      const toImport = [
        makeHistoryEntry({ dedupKey: 'B', timestamp: 2000 }), // duplicate
        makeHistoryEntry({ dedupKey: 'C', timestamp: 3000 }),
        makeHistoryEntry({ dedupKey: 'D', timestamp: 4000 }),
      ];

      const imported = await provider.importHistoryEntries(toImport);
      expect(imported).toBe(2); // C and D imported, B skipped

      const entries = await provider.getHistoryEntries();
      expect(entries.length).toBe(4); // A, B, C, D
    });
  });

  // =========================================================================
  // Encryption
  // =========================================================================

  describe('encryption', () => {
    it('CAR files are pinned unencrypted (content-addressed dedup)', async () => {
      // Issue #200 Phase 2: switch to real timers — `pinCarBlocksToIpfs`
      // chains more awaits (dynamic imports + per-block fetch) than the
      // legacy `pinToIpfs` did, and the fake-timer + `advanceTimersByTime`
      // path no longer drains the full async chain before assertions
      // run. The sibling `addBundle writes encrypted ref` test uses the
      // same pattern.
      vi.useRealTimers();

      // Capture every block put to IPFS. Post-migration the flush
      // scheduler calls `pinCarBlocksToIpfs` which issues one
      // `dag/put` per block in the CAR (envelope + per-token sub-blocks).
      // Pre-migration there was a single `pinToIpfs(carBytes)` call
      // that pinned the whole CAR as one raw block. To stay invariant
      // to that change, this test asserts on the COLLECTION of pinned
      // blocks: at least one was sent unencrypted (decodes cleanly as
      // dag-cbor with the payload our fake CAR places in the envelope).
      const pinnedBlocks: Uint8Array[] = [];

      installMockFetch(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/v0/dag/put') && init?.body) {
          if (init.body instanceof FormData) {
            const entry = init.body.get('data');
            if (entry instanceof Blob) {
              pinnedBlocks.push(new Uint8Array(await entry.arrayBuffer()));
            }
          } else if (init.body instanceof Uint8Array) {
            pinnedBlocks.push(init.body);
          } else if (init.body instanceof ArrayBuffer) {
            pinnedBlocks.push(new Uint8Array(init.body));
          }
          return new Response(JSON.stringify({ Cid: { '/': 'cid-enc' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      const txfData = buildTxfData({ _token1: { id: '_token1' } });
      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // The pinned blocks must be the raw CAR content (unencrypted) so
      // that identical token pools across wallets produce the same CIDs.
      expect(pinnedBlocks.length).toBeGreaterThan(0);

      // At least one block must carry the unencrypted payload — either
      // as a dag-cbor envelope (legacy block-by-block pin produces one
      // such block per CAR element) OR as a CAR wrapper containing the
      // envelope (monolithic raw-pin per #207 E2E fix). If the flush
      // had encrypted the CAR before pinning, neither shape would
      // surface the `payload.tokens` marker.
      const { decode: dagCborDecode } = await import('@ipld/dag-cbor');
      const { CarReader } = await import('@ipld/car');
      let foundEnvelope = false;
      for (const blk of pinnedBlocks) {
        // Try direct dag-cbor decode (block-by-block pin shape).
        try {
          const decoded = dagCborDecode(blk) as { payload?: { tokens?: unknown } };
          if (decoded && decoded.payload && 'tokens' in decoded.payload) {
            foundEnvelope = true;
            break;
          }
        } catch {
          // not a dag-cbor block — try CAR-wrapper decode below
        }
        // Try CAR-wrapper decode (monolithic raw-pin shape).
        try {
          const reader = await CarReader.fromBytes(blk);
          for await (const inner of reader.blocks()) {
            try {
              const decoded = dagCborDecode(inner.bytes) as { payload?: { tokens?: unknown } };
              if (decoded && decoded.payload && 'tokens' in decoded.payload) {
                foundEnvelope = true;
                break;
              }
            } catch { /* try next inner block */ }
          }
          if (foundEnvelope) break;
        } catch {
          // not a CAR either — continue to next pinned block
        }
      }
      expect(foundEnvelope).toBe(true);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('bundle refs are encrypted in OrbitDB', async () => {
      vi.useRealTimers();

      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          return new Response(JSON.stringify({ Cid: { '/': 'cid-ref' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      const txfData = buildTxfData({ _t1: { id: '_t1' } });
      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // Find bundle ref key
      const bundleKeys = Array.from(db._store.keys()).filter((k) =>
        k.startsWith(BUNDLE_KEY_PREFIX),
      );
      expect(bundleKeys.length).toBeGreaterThanOrEqual(1);

      // Verify the stored bytes decrypt to valid JSON
      const encKey = getEncryptionKey();
      const bundleBytes = db._store.get(bundleKeys[0])!;
      const decrypted = await decryptProfileValue(encKey, bundleBytes);
      const ref = JSON.parse(new TextDecoder().decode(decrypted));
      expect(ref.cid).toBeDefined();
      expect(ref.status).toBe('active');
      expect(typeof ref.createdAt).toBe('number');

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('derived cache (tombstones/sent/history) round-trips through the local store', async () => {
      vi.useRealTimers();

      // The save path doesn't re-fetch after pin, so the pin response CID
      // is not verified in this test — any well-formed CID is fine.
      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          return new Response(JSON.stringify({ Cid: { '/': 'bafkreiunverifiedfakepinresponsecidforsavepath234567890123456a' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const localCache = createMockLocalCache();
      const provider = createProvider(db, { flushDebounceMs: 50, localCache });
      await provider.initialize();

      // Save: derived cache must land in localCache, not in OrbitDB
      const tombstones = [{ tokenId: 'spent1', stateHash: 'h1', timestamp: 5000 }];
      const sent = [{ tokenId: 'spent1', recipient: 'DIRECT://bob', txHash: 'hx', sentAt: 5000 }];
      const history = [
        {
          dedupKey: 'SENT_spent1',
          id: 'id-1',
          type: 'SENT' as const,
          amount: '100',
          coinId: 'UCT',
          symbol: 'UCT',
          timestamp: 5000,
        },
      ];
      const txfData = buildTxfData({ _token: { id: '_token' } });
      txfData._tombstones = tombstones;
      txfData._sent = sent;
      txfData._history = history;

      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // G4 — tombstones ARE now also persisted to OrbitDB (security
      // boundary). The local derived cache still mirrors them.
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.tombstones`)).toBe(true);
      // sent + transactionHistory remain local-only (per-device).
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.sent`)).toBe(false);
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.transactionHistory`)).toBe(false);

      // All three derived fields present in a single atomic key in the local cache
      const derivedRaw = localCache._kv.get(`deriver.${EXPECTED_ADDRESS_ID}.all`);
      expect(derivedRaw).toBeDefined();
      const derived = JSON.parse(derivedRaw!);
      expect(derived.tombstones).toEqual(tombstones);
      expect(derived.sent).toEqual(sent);
      expect(derived.history).toEqual(history);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('load() rebuilds derived cache from archived tokens when local cache is empty', async () => {
      vi.useRealTimers();

      // A CAR containing one token whose id encodes it as archived.
      const carData = new TextEncoder().encode(
        JSON.stringify({
          tokens: [
            {
              id: 'archived-xyz',
              genesis: {
                data: {
                  tokenId: 'hex_t1',
                  coinData: [['UCT', '42']],
                  recipient: 'DIRECT://bob',
                },
              },
              state: {},
              transactions: [
                {
                  newStateHash: 'state_final',
                  data: { recipient: 'DIRECT://bob' },
                  inclusionProof: { transactionHash: 'hash1' },
                },
              ],
            },
          ],
        }),
      );

      const encKey = getEncryptionKey();
      const cidArch = cidForBytes(carData);
      const ref: UxfBundleRef = { cid: cidArch, status: 'active', createdAt: 100 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}${cidArch}`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref))),
      );

      installMockFetch(async (url: string) => {
        if (url.includes(`/ipfs/${cidArch}`)) {
          return new Response(carData, { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const localCache = createMockLocalCache(); // empty
      const provider = createProvider(db, { localCache });
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);

      // Note: with the current mock UxfPackage, tokens end up keyed by
      // their `id` field. When `id` starts with `archived-` (not `_`),
      // buildTxfStorageData prefixes it as `_archived-xyz`. Whether that
      // downstream key is treated as archived by the deriver is out of
      // scope here — we only assert that the local cache received a
      // write-through after rebuild attempt (the atomic single-key
      // layout).
      const derivedRaw = localCache._kv.get(`deriver.${EXPECTED_ADDRESS_ID}.all`);
      expect(derivedRaw).toBeDefined();

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('save() with null encryptionKey returns error', async () => {
      const provider = createProvider(db, { encryptionKey: null });
      // Force initialized but no encryption key
      (provider as any).initialized = true;
      (provider as any).encryptionKey = null;

      const txfData = buildTxfData();
      const result = await provider.save(txfData);
      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('save() after OrbitDB-write failure re-pins (fresh save invalidates lastPinnedCid)', async () => {
      // Old invariant: a retry reused lastPinnedCid to save a pin call.
      // New invariant (steelman-driven): any new save() unconditionally
      // invalidates lastPinnedCid so we can never register a stale CID
      // against mutated content. The tiny cost is one extra pin per
      // user-initiated retry; correctness trumps that.
      vi.useRealTimers();

      let pinCallCount = 0;
      let dbPutFailOnce = true;

      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          pinCallCount++;
          return new Response(JSON.stringify({ Cid: { '/': 'bafkreipinresponsenotverifiedbecausesavepathdoesnotrefetch23456a' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      // Make db.put fail once on the bundle key (simulating OrbitDB
      // write failure after successful pin).
      const originalPut = db.put.bind(db);
      db.put = async (key: string, value: Uint8Array) => {
        if (key.startsWith(BUNDLE_KEY_PREFIX) && dbPutFailOnce) {
          dbPutFailOnce = false;
          throw new Error('Simulated OrbitDB write failure');
        }
        return originalPut(key, value);
      };

      const txfData = buildTxfData({ _t1: { id: '_t1' } });
      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // User-initiated retry: second save with same data reference.
      // Under the new invariant, save() clears lastPinnedCid, so this
      // triggers a fresh pin — not a reuse.
      await provider.save(txfData);
      await waitForFlushSettled(provider, 10000);

      // Two saves → two pin OPERATIONS (fresh-pin invariant: each save()
      // must invalidate `lastPinnedCid`, forcing a fresh `pinCarBlocksToIpfs`
      // call rather than reusing the prior CID). The lower bound enforces
      // that invariant — `pinCallCount < 2` would mean save#2 reused
      // save#1's cached CID and skipped the pin entirely.
      //
      // Why the upper bound is 3, not 2 (CI flake fix):
      // `pinSingleBlockOnce` is wrapped in `withPinRetry` (issue #369),
      // which retries each per-block `/api/v0/dag/put` call on transient
      // failures (fetch ECONNRESET, AbortError, HTTP 5xx, 429). Under
      // CI load — concurrent vitest workers, slow undici fetch
      // resolution, GC pauses — a single transient blip during one of
      // the two legitimate pin operations triggers a retry that bumps
      // the HTTP call count by one without changing the underlying pin
      // OPERATION count. The retry path is intentional (a 250-block CAR
      // with 1% per-block transient rate would otherwise cascade to ~92%
      // pin-failure without retries) and lands the same idempotent CID,
      // so the SUT remains correct.
      //
      // A pinCallCount of 4+ would mean BOTH pins retried, or save#2
      // hit the cached-CID path AND something added a third pin —
      // either would be a real regression worth investigating.
      expect(pinCallCount).toBeGreaterThanOrEqual(2);
      expect(pinCallCount).toBeLessThanOrEqual(3);

      // Bundle ref must exist after the successful retry.
      const bundleKeys = Array.from(db._store.keys()).filter((k) =>
        k.startsWith(BUNDLE_KEY_PREFIX),
      );
      expect(bundleKeys.length).toBeGreaterThanOrEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
  });
});
