/**
 * Issue #330 — Tests for the read-only token-storage fallback path.
 *
 * Pre-#330 the Profile token-storage provider had no fallback when the
 * primary (OrbitDB) read returned empty or failed. After memory-only
 * blockstore eviction + gateway 404, the wallet silently reported "0
 * tokens" — losing tokens that WERE durable in the legacy IDB.
 *
 * The fix adds `setFallbackTokenStorage(legacy)` on
 * `ProfileTokenStorageProvider`. The fallback is consulted at three
 * sites inside `load()`:
 *   1. `activeBundles.size === 0` AND no seed in `lastLoadedData` — would
 *      otherwise return empty.
 *   2. All bundle fetches failed despite bundle refs existing — would
 *      otherwise return success with empty `loadedBundles`.
 *   3. Outer catch — would otherwise propagate the error.
 *
 * The fallback is strictly read-only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import type { LoadResult, TokenStorageProvider } from '../../../storage';
import type { TxfStorageDataBase } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

function createMockDb(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  return {
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
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as ProfileDatabase;
}

function createMockLocalCache() {
  const store = new Map<string, string>();
  return {
    storage: {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async set(k: string, v: string) {
        store.set(k, v);
      },
      async remove(k: string) {
        store.delete(k);
      },
      async clear() {
        store.clear();
      },
    },
    store,
  };
}

/**
 * Minimal fake `TokenStorageProvider` for the fallback slot. Returns the
 * configured load result; tracks whether `save`/`clear` were called so
 * we can assert read-only invariant.
 */
function createFakeFallback(loadData: TxfStorageDataBase | null): {
  provider: TokenStorageProvider<TxfStorageDataBase>;
  loadCalls: number;
  saveCalls: number;
  clearCalls: number;
} {
  const counters = { loadCalls: 0, saveCalls: 0, clearCalls: 0 };
  const provider = {
    id: 'fake-fallback',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    setIdentity() {},
    async initialize() {},
    async load(): Promise<LoadResult<TxfStorageDataBase>> {
      counters.loadCalls += 1;
      if (!loadData) {
        return {
          success: true,
          data: { _meta: { version: 1 } } as unknown as TxfStorageDataBase,
          source: 'cache',
          timestamp: Date.now(),
        };
      }
      return {
        success: true,
        data: loadData,
        source: 'cache',
        timestamp: Date.now(),
      };
    },
    async save() {
      counters.saveCalls += 1;
      return { success: true, timestamp: Date.now() };
    },
    async clear() {
      counters.clearCalls += 1;
    },
    on() {
      return () => {};
    },
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
  return {
    provider,
    get loadCalls() {
      return counters.loadCalls;
    },
    get saveCalls() {
      return counters.saveCalls;
    },
    get clearCalls() {
      return counters.clearCalls;
    },
  };
}

async function makeProvider() {
  const db = createMockDb();
  const localCache = createMockLocalCache();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: 'test',
      encrypt: true,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  return provider;
}

describe('Issue #330 — ProfileTokenStorageProvider.setFallbackTokenStorage', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('load() returns fallback data when primary has no bundles and no seed', async () => {
    const provider = await makeProvider();
    try {
      const fallbackTokenData: TxfStorageDataBase = {
        _meta: { version: 1 } as never,
        '_aaa': { mock: true } as never,
        '_bbb': { mock: true } as never,
      } as TxfStorageDataBase;
      const fallback = createFakeFallback(fallbackTokenData);
      provider.setFallbackTokenStorage(fallback.provider);

      const result = await provider.load();
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // The exact key set is opaque; assert the two token keys made it through.
      const tokenKeys = Object.keys(result.data!).filter((k) =>
        k.startsWith('_') && k !== '_meta' && k !== '_tombstones' && k !== '_sent' && k !== '_outbox' && k !== '_history' && k !== '_nametag' && k !== '_nametags' && k !== '_mintOutbox' && k !== '_invalid' && k !== '_invalidatedNametags' && k !== '_integrity',
      );
      expect(tokenKeys.sort()).toEqual(['_aaa', '_bbb']);

      expect(fallback.loadCalls).toBeGreaterThan(0);
      expect(fallback.saveCalls).toBe(0);
      expect(fallback.clearCalls).toBe(0);
    } finally {
      await provider.shutdown();
    }
  });

  it('load() returns empty (NOT fallback) when fallback also has no tokens', async () => {
    const provider = await makeProvider();
    try {
      // Fallback is wired but has no token data — should NOT be used as
      // a stale seed; the empty-wallet path applies.
      const fallback = createFakeFallback(null);
      provider.setFallbackTokenStorage(fallback.provider);

      const result = await provider.load();
      expect(result.success).toBe(true);
      const tokenKeys = Object.keys(result.data!).filter((k) =>
        k.startsWith('_') && k !== '_meta' && k !== '_tombstones' && k !== '_sent' && k !== '_outbox' && k !== '_history' && k !== '_nametag' && k !== '_nametags' && k !== '_mintOutbox' && k !== '_invalid' && k !== '_invalidatedNametags' && k !== '_integrity',
      );
      expect(tokenKeys).toEqual([]);
    } finally {
      await provider.shutdown();
    }
  });

  it('load() returns empty when no fallback is wired (regression check)', async () => {
    const provider = await makeProvider();
    try {
      const result = await provider.load();
      expect(result.success).toBe(true);
      expect(Object.keys(result.data!).filter((k) => k.startsWith('_') && k !== '_meta' && k !== '_tombstones' && k !== '_sent' && k !== '_outbox' && k !== '_history' && k !== '_nametag' && k !== '_nametags' && k !== '_mintOutbox' && k !== '_invalid' && k !== '_invalidatedNametags' && k !== '_integrity')).toEqual([]);
    } finally {
      await provider.shutdown();
    }
  });

  it('fallback is never written to (read-only invariant)', async () => {
    const provider = await makeProvider();
    try {
      const fallbackTokenData: TxfStorageDataBase = {
        _meta: { version: 1 } as never,
        '_xyz': { mock: true } as never,
      } as TxfStorageDataBase;
      const fallback = createFakeFallback(fallbackTokenData);
      provider.setFallbackTokenStorage(fallback.provider);

      // Multiple load calls
      await provider.load();
      await provider.load();

      // Now mutate via save() — should NOT route to fallback
      await provider.save({
        _meta: { version: 2 } as never,
        '_new': { mock: true } as never,
      } as TxfStorageDataBase);

      expect(fallback.saveCalls).toBe(0);
      expect(fallback.clearCalls).toBe(0);
    } finally {
      await provider.shutdown();
    }
  });

  it('load() returns fallback data when all bundle fetches fail (site #2)', async () => {
    const provider = await makeProvider();
    try {
      const fallbackTokenData: TxfStorageDataBase = {
        _meta: { version: 1 } as never,
        '_recovered-from-fallback': { mock: true } as never,
      } as TxfStorageDataBase;
      const fallback = createFakeFallback(fallbackTokenData);
      provider.setFallbackTokenStorage(fallback.provider);

      // Monkey-patch the bundleIndex to return one active bundle that
      // will fail to fetch (the gateway URL `https://mock-ipfs.test`
      // does not resolve, so `fetchCarFromIpfs` throws for every CID).
      // This drives `loadedBundles.length === 0 && activeBundles.size > 0`
      // — the site-#2 condition.
      const inner = (provider as unknown as {
        bundleIndex: {
          listActiveBundles: () => Promise<Map<string, unknown>>;
        };
      }).bundleIndex;
      const originalList = inner.listActiveBundles.bind(inner);
      inner.listActiveBundles = async () => {
        return new Map<string, unknown>([
          [
            'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy',
            { cid: 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy', status: 'active' },
          ],
        ]);
      };

      try {
        const result = await provider.load();
        expect(result.success).toBe(true);
        const tokenKeys = Object.keys(result.data!).filter(
          (k) =>
            k.startsWith('_') &&
            k !== '_meta' &&
            k !== '_tombstones' &&
            k !== '_sent' &&
            k !== '_outbox' &&
            k !== '_history' &&
            k !== '_nametag' &&
            k !== '_nametags' &&
            k !== '_mintOutbox' &&
            k !== '_invalid' &&
            k !== '_invalidatedNametags' &&
            k !== '_integrity',
        );
        expect(tokenKeys).toEqual(['_recovered-from-fallback']);
        expect(fallback.loadCalls).toBeGreaterThan(0);
      } finally {
        inner.listActiveBundles = originalList;
      }
    } finally {
      await provider.shutdown();
    }
  }, 30_000);

  it('load() returns fallback data when an inner error throws (site #3 outer-catch)', async () => {
    const provider = await makeProvider();
    try {
      const fallbackTokenData: TxfStorageDataBase = {
        _meta: { version: 1 } as never,
        '_recovered-on-error': { mock: true } as never,
      } as TxfStorageDataBase;
      const fallback = createFakeFallback(fallbackTokenData);
      provider.setFallbackTokenStorage(fallback.provider);

      // Make bundleIndex.listActiveBundles itself THROW to drive the
      // outer try/catch path (`load-error` reason). Mirrors what a
      // CRITICAL-BLOCK-EVICTED would do when reading the OrbitDB
      // OpLog head fails.
      const inner = (provider as unknown as {
        bundleIndex: {
          listActiveBundles: () => Promise<Map<string, unknown>>;
        };
      }).bundleIndex;
      const originalList = inner.listActiveBundles.bind(inner);
      inner.listActiveBundles = async () => {
        const err = new Error('simulated LoadBlockFailedError') as Error & {
          code?: string;
        };
        err.code = 'LOAD_BLOCK_FAILED';
        throw err;
      };

      try {
        const result = await provider.load();
        expect(result.success).toBe(true);
        const tokenKeys = Object.keys(result.data!).filter(
          (k) =>
            k.startsWith('_') &&
            k !== '_meta' &&
            k !== '_tombstones' &&
            k !== '_sent' &&
            k !== '_outbox' &&
            k !== '_history' &&
            k !== '_nametag' &&
            k !== '_nametags' &&
            k !== '_mintOutbox' &&
            k !== '_invalid' &&
            k !== '_invalidatedNametags' &&
            k !== '_integrity',
        );
        expect(tokenKeys).toEqual(['_recovered-on-error']);
        expect(fallback.loadCalls).toBeGreaterThan(0);
      } finally {
        inner.listActiveBundles = originalList;
      }
    } finally {
      await provider.shutdown();
    }
  });

  it('null fallback clears the wiring', async () => {
    const provider = await makeProvider();
    try {
      const fallbackTokenData: TxfStorageDataBase = {
        _meta: { version: 1 } as never,
        '_only-in-fallback': { mock: true } as never,
      } as TxfStorageDataBase;
      const fallback = createFakeFallback(fallbackTokenData);

      provider.setFallbackTokenStorage(fallback.provider);
      const r1 = await provider.load();
      expect(
        Object.keys(r1.data!).filter((k) => k.startsWith('_') && k !== '_meta' && k !== '_tombstones' && k !== '_sent' && k !== '_outbox' && k !== '_history' && k !== '_nametag' && k !== '_nametags' && k !== '_mintOutbox' && k !== '_invalid' && k !== '_invalidatedNametags' && k !== '_integrity'),
      ).toEqual(['_only-in-fallback']);

      // Clear the fallback — next load should NOT see fallback tokens.
      provider.setFallbackTokenStorage(null);
      // Force a fresh load by invalidating pending data — re-set
      // identity is overkill; just call load directly. The provider's
      // pendingData / lastLoadedData caches will short-circuit, so to
      // verify the wiring change we read after a save+clear cycle.
      await provider.clear();
      // After clear() the in-memory caches are reset; load() now hits
      // the activeBundles path which is empty, with no fallback.
      const r2 = await provider.load();
      expect(
        Object.keys(r2.data!).filter((k) => k.startsWith('_') && k !== '_meta' && k !== '_tombstones' && k !== '_sent' && k !== '_outbox' && k !== '_history' && k !== '_nametag' && k !== '_nametags' && k !== '_mintOutbox' && k !== '_invalid' && k !== '_invalidatedNametags' && k !== '_integrity'),
      ).toEqual([]);
    } finally {
      await provider.shutdown();
    }
  });
});
