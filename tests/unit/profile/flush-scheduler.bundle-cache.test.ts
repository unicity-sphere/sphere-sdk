/**
 * Issue #360 Finding #3 — `BundleIndex.listActiveBundles()` is memoized
 * within `FlushScheduler.flushToIpfs()`.
 *
 * # Why this exists
 *
 * `db.all(BUNDLE_KEY_PREFIX)` underneath does NOT push the prefix down
 * into OrbitDB's keyvalue store — it walks the entire oplog and filters
 * in JS. The flush body asks for the active-bundle set at 3+ gates
 * (no-data short-circuit, pointer-monotonicity bundle-set check,
 * cached-CID validation, `shouldConsolidate()`); without memoization
 * each gate pays a full oplog walk.
 *
 * The fix opens a per-flush "scope" on `BundleIndex` at `flushToIpfs()`
 * entry and tears it down in a `finally` block. Inside the scope,
 * `listActiveBundlesCached()` returns a single snapshot. Writes via
 * `addBundle()` and remote-merge via `joinSnapshot()` invalidate the
 * snapshot so gates that run AFTER a write see the post-write state.
 *
 * # What this test asserts
 *
 *   - During a single `flushToIpfs()` run that touches all the gates,
 *     `BundleIndex.listActiveBundles()` is called AT MOST ONCE despite
 *     three call sites consulting `listActiveBundlesCached()`.
 *   - After `addBundle()` writes the pinned ref, the in-flight cache is
 *     invalidated so `shouldConsolidate()` sees the post-write state
 *     (it re-walks once). Total walks per flush: at most 2 (pre-write
 *     gates share one walk; post-write `shouldConsolidate` runs the
 *     second walk).
 *   - Outside a flush scope the accessor degrades to a pass-through
 *     (sanity check that we did not break callers like `load()`).
 *
 * The instrumentation patches `BundleIndex.listBundles()` (the actual
 * OrbitDB walker that `listActiveBundles()` delegates to) so we count
 * every oplog walk regardless of which entry point triggers it.
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
} from '../../../profile/encryption';
import { waitForFlushSettled } from '../../helpers/profile/waitForFlushSettled';

// =============================================================================
// Test fixtures (parallel to profile-token-storage-flush-serialization.test.ts)
// =============================================================================

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

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

function buildTxfData(
  tokens: Record<string, unknown> = {},
): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: EXPECTED_ADDRESS_ID,
      formatVersion: '1.0.0',
      updatedAt: 1_700_000_000_000,
    },
    ...tokens,
  };
}

// =============================================================================
// Mock ProfileDatabase
// =============================================================================

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  const listeners: Array<() => void> = [];
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
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
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
  } as MockProfileDb;
}

// =============================================================================
// UxfPackage mock — same shape as the flush-serialization test so the
// flush body can `toCar()` / `extractCarRootCid` cleanly.
// =============================================================================

vi.mock('../../../uxf/UxfPackage.js', async () => {
  const { makeFakeUxfCar, decodeFakeUxfCar } = await import(
    './_helpers/fake-uxf-car.js'
  );

  function makePkg(): {
    _tokens: unknown[];
    ingestAll(tokens: unknown[]): void;
    merge(other: { _tokens?: unknown[] }): void;
    assembleAll(): Map<string, unknown>;
    toCar(): Promise<Uint8Array>;
  } {
    const tokens: unknown[] = [];
    return {
      _tokens: tokens,
      ingestAll(items: unknown[]) {
        for (const t of items) tokens.push(t);
      },
      merge(other: { _tokens?: unknown[] }) {
        if (other._tokens) for (const t of other._tokens) tokens.push(t);
      },
      assembleAll() {
        const result = new Map<string, unknown>();
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i] as Record<string, unknown>;
          result.set((t.id as string) ?? `_t${i}`, t);
        }
        return result;
      },
      async toCar() {
        const sorted = [...tokens].sort((a, b) => {
          const aid = (a as Record<string, unknown>).id as string ?? '';
          const bid = (b as Record<string, unknown>).id as string ?? '';
          return aid.localeCompare(bid);
        });
        return makeFakeUxfCar({ tokens: sorted });
      },
    };
  }

  return {
    UxfPackage: {
      create() {
        return makePkg();
      },
      async fromCar(carBytes: Uint8Array) {
        let parsed: { tokens?: unknown[] };
        try {
          parsed = await decodeFakeUxfCar<{ tokens?: unknown[] }>(carBytes);
        } catch {
          const text = new TextDecoder().decode(carBytes);
          parsed = JSON.parse(text) as { tokens?: unknown[] };
        }
        const pkg = makePkg();
        pkg.ingestAll(parsed.tokens ?? []);
        return pkg;
      },
    },
  };
});

// =============================================================================
// Mock fetch — IPFS pin always succeeds (returns dummy CID).
// =============================================================================

const originalFetch = globalThis.fetch;

function installMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.includes('/api/v0/dag/put') || url.includes('/api/v0/block/put')) {
      return new Response(JSON.stringify({ Cid: { '/': 'bafymockcid' } }), {
        status: 200,
      });
    }
    return new Response('', { status: 404 });
  };
}

function uninstallMockFetch() {
  globalThis.fetch = originalFetch;
}

// =============================================================================
// Provider factory
// =============================================================================

function createProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: 10,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

interface BundleIndexInternals {
  listBundles: () => Promise<Map<string, UxfBundleRef>>;
  listActiveBundles: () => Promise<Map<string, UxfBundleRef>>;
  listActiveBundlesCached: () => Promise<Map<string, UxfBundleRef>>;
  beginFlushScope: () => void;
  endFlushScope: () => void;
}

interface FlushSchedulerInternals {
  scheduleFlush: () => void;
}

function getBundleIndex(
  provider: ProfileTokenStorageProvider,
): BundleIndexInternals {
  return (provider as unknown as { bundleIndex: BundleIndexInternals }).bundleIndex;
}

function getFlushScheduler(
  provider: ProfileTokenStorageProvider,
): FlushSchedulerInternals {
  return (provider as unknown as { flushScheduler: FlushSchedulerInternals }).flushScheduler;
}

/**
 * Wrap `BundleIndex.listBundles` to count invocations. Counts the
 * underlying oplog walk — the metric we are trying to drive down.
 */
function instrumentListBundles(provider: ProfileTokenStorageProvider): {
  count: () => number;
  reset: () => void;
} {
  const bundleIndex = getBundleIndex(provider);
  let calls = 0;
  const original = bundleIndex.listBundles.bind(bundleIndex);
  bundleIndex.listBundles = async function (): Promise<Map<string, UxfBundleRef>> {
    calls++;
    return original();
  };
  return {
    count: () => calls,
    reset: () => {
      calls = 0;
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('FlushScheduler — per-flush listActiveBundles memoization (Issue #360 Finding #3)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installMockFetch();
  });

  afterEach(() => {
    uninstallMockFetch();
  });

  it('a single save-driven flush triggers AT MOST 2 listBundles walks (pre-addBundle gates + post-addBundle shouldConsolidate)', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    // Reset instrumentation AFTER initialize so we measure only the
    // flush itself (initialize() may walk the OpLog while seeding
    // `knownBundleCids`).
    const meter = instrumentListBundles(provider);
    meter.reset();

    // Plant data so flushToIpfs has tokens to publish. This exercises
    // multiple gates: the bundle-set monotonicity check (when
    // `lastLoadedFromBundleCids` is non-null), the cached-CID gate
    // (skipped on the first flush because `getLastPinnedCid()` is
    // null), and `shouldConsolidate()` after `addBundle()`. The
    // bundle-set check needs the baseline to be non-null to engage —
    // seed it so the pre-write gate actually walks.
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string> | null;
    }).lastLoadedFromBundleCids = new Set();
    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _tokenA: tokenA });

    const scheduler = getFlushScheduler(provider);
    scheduler.scheduleFlush();
    await waitForFlushSettled(provider, 10000);

    // Memoization invariant: the underlying oplog walk runs AT MOST
    // TWICE per flush. The first walk feeds every pre-`addBundle()`
    // gate (currently the bundle-set monotonicity check); the cache
    // is invalidated when `addBundle()` writes the pinned ref, so
    // `shouldConsolidate()` re-walks once to see the post-write
    // state. Without memoization the pre-#360 code path walked 3-4x.
    const calls = meter.count();
    console.log(`[Finding #3] listBundles walks per save-driven flush: ${calls}`);
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(2);

    await provider.shutdown();
  });

  it('two back-to-back save-driven flushes each open a fresh scope (cache scoped to one flush)', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    const meter = instrumentListBundles(provider);
    meter.reset();

    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _tokenA: tokenA });

    const scheduler = getFlushScheduler(provider);
    scheduler.scheduleFlush();
    await waitForFlushSettled(provider, 10000);

    const firstFlushCalls = meter.count();
    expect(firstFlushCalls).toBeLessThanOrEqual(2);

    // Second flush — must re-walk (no cross-flush cache). Confirms the
    // scope is closed between flushes.
    const tokenB = { id: '_tokenB', genesis: { tokenId: 'B' } };
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _tokenA: tokenA, _tokenB: tokenB });

    scheduler.scheduleFlush();
    await waitForFlushSettled(provider, 10000);

    const secondFlushCalls = meter.count() - firstFlushCalls;
    expect(secondFlushCalls).toBeGreaterThanOrEqual(1);
    expect(secondFlushCalls).toBeLessThanOrEqual(2);

    await provider.shutdown();
  });

  it('outside a flush scope, listActiveBundlesCached is a pass-through (no stale cache leaks to load())', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    const bundleIndex = getBundleIndex(provider);
    const meter = instrumentListBundles(provider);
    meter.reset();

    // No flush scope open — each call walks fresh.
    await bundleIndex.listActiveBundlesCached();
    await bundleIndex.listActiveBundlesCached();
    await bundleIndex.listActiveBundlesCached();

    expect(meter.count()).toBe(3);

    await provider.shutdown();
  });

  it('beginFlushScope + listActiveBundlesCached × N collapses to ONE walk; endFlushScope tears the cache down', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    const bundleIndex = getBundleIndex(provider);
    const meter = instrumentListBundles(provider);
    meter.reset();

    bundleIndex.beginFlushScope();
    await bundleIndex.listActiveBundlesCached();
    await bundleIndex.listActiveBundlesCached();
    await bundleIndex.listActiveBundlesCached();
    expect(meter.count()).toBe(1);

    bundleIndex.endFlushScope();
    // After teardown, accessor is a pass-through again.
    await bundleIndex.listActiveBundlesCached();
    expect(meter.count()).toBe(2);

    await provider.shutdown();
  });
});
