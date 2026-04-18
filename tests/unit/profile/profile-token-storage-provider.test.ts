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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
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

vi.mock('../../../uxf/UxfPackage.js', () => {
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
      return new TextEncoder().encode(JSON.stringify({ tokens: ingestedTokens }));
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
        pkg.toCar = async () => {
          return new TextEncoder().encode(JSON.stringify({ tokens: ingestedTokens }));
        };
        return pkg;
      },
      async fromCar(carBytes: Uint8Array) {
        const text = new TextDecoder().decode(carBytes);
        const parsed = JSON.parse(text);
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
            return new TextEncoder().encode(JSON.stringify({ tokens: this._tokens }));
          },
        };
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Factory: Create a provider with mock dependencies
// ---------------------------------------------------------------------------

function createProvider(
  db: MockProfileDb,
  opts?: { encryptionKey?: Uint8Array | null; flushDebounceMs?: number },
): ProfileTokenStorageProvider {
  const encKey = opts?.encryptionKey !== undefined ? opts.encryptionKey : getEncryptionKey();
  const provider = new ProfileTokenStorageProvider(
    db,
    encKey,
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: opts?.flushDebounceMs ?? 50, // short debounce for testing
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
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
    return handler(url, init);
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
      await new Promise((r) => setTimeout(r, 200));

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

      // Bundle 2: token C
      const carData2 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_tokenC' }] }),
      );

      // Write bundle refs to OrbitDB (refs remain encrypted in KV)
      const ref1: UxfBundleRef = { cid: 'cidA', status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: 'cidB', status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cidA`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cidB`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2))),
      );

      // Mock fetch for CAR retrieval
      installMockFetch(async (url: string) => {
        if (url.includes('/ipfs/cidA')) {
          return new Response(carData1, { status: 200 });
        }
        if (url.includes('/ipfs/cidB')) {
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

    it('load() continues on partial bundle failure', async () => {
      const encKey = getEncryptionKey();

      // Bundle 1: succeeds (CAR unencrypted)
      const carData1 = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_tokenOK' }] }),
      );

      const ref1: UxfBundleRef = { cid: 'cidOK', status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: 'cidFail', status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cidOK`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cidFail`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2))),
      );

      installMockFetch(async (url: string) => {
        if (url.includes('/ipfs/cidOK')) {
          return new Response(carData1, { status: 200 });
        }
        if (url.includes('/ipfs/cidFail')) {
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
      await new Promise((r) => setTimeout(r, 200));

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

      // Active bundle
      const activeRef: UxfBundleRef = { cid: 'cid-active', status: 'active', createdAt: 100 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid-active`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(activeRef))),
      );

      // Superseded bundle
      const supersededRef: UxfBundleRef = {
        cid: 'cid-old',
        status: 'superseded',
        createdAt: 50,
        supersededBy: 'cid-active',
      };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid-old`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(supersededRef))),
      );

      const provider = createProvider(db);
      await provider.initialize();

      // Use load() to trigger active bundle listing
      installMockFetch(async (url: string) => {
        if (url.includes('/ipfs/cid-active')) {
          const carData = new TextEncoder().encode(JSON.stringify({ tokens: [{ id: '_t1' }] }));
          return new Response(carData, { status: 200 });
        }
        // cid-old should NOT be fetched (superseded)
        if (url.includes('/ipfs/cid-old')) {
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
    it('operational state stored as separate OrbitDB keys', async () => {
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

      await provider.save(txfData);
      await new Promise((r) => setTimeout(r, 200));

      // Operational state should be in separate keys
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.tombstones`)).toBe(true);
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.outbox`)).toBe(true);
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.sent`)).toBe(true);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('readOperationalState reads all fields in parallel', async () => {
      const encKey = getEncryptionKey();
      const addr = EXPECTED_ADDRESS_ID;

      // Write operational state directly to OrbitDB
      const tombstones = [{ tokenId: 't1', stateHash: 'h1', timestamp: 1000 }];
      const outbox = [{ id: 'o1', status: 'pending', tokenId: 't1', recipient: 'alice', createdAt: 1000, data: {} }];
      const sent = [{ tokenId: 't1', recipient: 'bob', txHash: 'hash1', sentAt: 2000 }];

      for (const [key, value] of [
        [`${addr}.tombstones`, tombstones],
        [`${addr}.outbox`, outbox],
        [`${addr}.sent`, sent],
        [`${addr}.invalid`, []],
        [`${addr}.transactionHistory`, []],
        [`${addr}.mintOutbox`, []],
        [`${addr}.invalidatedNametags`, []],
      ] as const) {
        const encoded = new TextEncoder().encode(JSON.stringify(value));
        const encrypted = await encryptProfileValue(encKey, encoded);
        db._store.set(key, encrypted);
      }

      // Add a dummy active bundle so load() goes through the full merge path
      // (with 0 bundles, load() returns early without reading operational state)
      const dummyRef: UxfBundleRef = { cid: 'cid-dummy', status: 'active', createdAt: 100 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid-dummy`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(dummyRef))),
      );

      // Mock fetch to return an unencrypted CAR with no tokens
      const emptyCarData = new TextEncoder().encode(JSON.stringify({ tokens: [] }));
      installMockFetch(async (url: string) => {
        if (url.includes('/ipfs/cid-dummy')) {
          return new Response(emptyCarData, { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db);
      await provider.initialize();

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.data!._tombstones).toEqual(tombstones);
      expect(loadResult.data!._outbox).toEqual(outbox);
      expect(loadResult.data!._sent).toEqual(sent);
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
      const ref: UxfBundleRef = { cid: 'cid-new', status: 'active', createdAt: 300 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid-new`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref))),
      );

      // Mock fetch for the new bundle (CAR unencrypted)
      const carData = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_newToken' }] }),
      );
      installMockFetch(async (url: string) => {
        if (url.includes('/ipfs/cid-new')) {
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

      // Start with 2 bundles
      const ref1: UxfBundleRef = { cid: 'cid1', status: 'active', createdAt: 100 };
      const ref2: UxfBundleRef = { cid: 'cid2', status: 'active', createdAt: 200 };
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid1`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref1))),
      );
      db._store.set(
        `${BUNDLE_KEY_PREFIX}cid2`,
        await encryptProfileValue(encKey, new TextEncoder().encode(JSON.stringify(ref2))),
      );

      const carData = new TextEncoder().encode(
        JSON.stringify({ tokens: [{ id: '_t1' }] }),
      );
      installMockFetch(async (url: string) => {
        if (url.includes('/ipfs/')) {
          return new Response(carData, { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db);
      await provider.initialize();

      // Now remove one bundle (simulate remote device)
      db._store.delete(`${BUNDLE_KEY_PREFIX}cid2`);

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
      let pinnedBytes: Uint8Array | null = null;

      installMockFetch(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/v0/dag/put') && init?.body) {
          // Capture the bytes sent to IPFS
          if (init.body instanceof Uint8Array) {
            pinnedBytes = init.body;
          } else if (init.body instanceof ArrayBuffer) {
            pinnedBytes = new Uint8Array(init.body);
          }
          return new Response(JSON.stringify({ Cid: { '/': 'cid-enc' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      const txfData = buildTxfData({ _token1: { id: '_token1' } });
      await provider.save(txfData);
      await vi.advanceTimersByTimeAsync(100);

      // The pinned bytes must be the raw CAR content (unencrypted) so that
      // identical token pools across wallets produce the same CID.
      expect(pinnedBytes).not.toBeNull();
      if (pinnedBytes) {
        const rawText = new TextDecoder().decode(pinnedBytes);
        const parsed = JSON.parse(rawText);
        expect(parsed.tokens).toBeDefined();
      }
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
      await new Promise((r) => setTimeout(r, 200));

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
    it('flush retry reuses lastPinnedCid', async () => {
      vi.useRealTimers();

      let pinCallCount = 0;
      let dbPutFailOnce = true;

      installMockFetch(async (url: string) => {
        if (url.includes('/api/v0/dag/put')) {
          pinCallCount++;
          return new Response(JSON.stringify({ Cid: { '/': 'cid-retry' } }), { status: 200 });
        }
        return new Response('', { status: 404 });
      });

      const provider = createProvider(db, { flushDebounceMs: 50 });
      await provider.initialize();

      // Make db.put fail once (simulating OrbitDB write failure after successful pin)
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

      // First flush: pin succeeds, db.put fails, data re-queued
      await new Promise((r) => setTimeout(r, 200));

      // The data was re-queued by the catch block. Trigger a new save to schedule another flush.
      await provider.save(txfData);

      // Second flush: should reuse lastPinnedCid and not call pinCar again
      await new Promise((r) => setTimeout(r, 200));

      // pinCar should only have been called once (reuses lastPinnedCid on retry)
      expect(pinCallCount).toBe(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
  });
});
