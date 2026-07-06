/**
 * Regression tests for the flush-serialization invariant — PR #127
 * follow-up addressing the partial-CAR / pointer-version-inversion race.
 *
 * # The race (without serialization)
 *
 * Two `flushToIpfs()` calls run concurrently: an OLDER call captures
 * `pendingData_1`, a NEWER call captures `pendingData_2`. Both proceed
 * through `pkg.toCar()` → `pinToIpfs()` → `publishAggregatorPointerBestEffort()`
 * in parallel. The aggregator's per-wallet publish mutex serializes the
 * publishes in MUTEX-ACQUISITION order — NOT capture order. A slower-
 * pinning OLDER flush can publish AFTER a faster-pinning NEWER flush,
 * placing the older (partial) CAR behind the higher pointer version. A
 * remote device joining via `recoverLatest()` walks to that higher
 * version, fetches the partial CAR, and silently misses tokens that
 * lived only in the newer save. The Mode-A monotonicity assertion
 * (b5d347e) reads `lastLoadedData` BEFORE the publish step, so it does
 * NOT catch this inversion — the older flush's lastLoadedData snapshot
 * is consistent with its own data at check time.
 *
 * # The fix
 *
 * `startSerializedFlush()` chains every new flush after the in-flight
 * `flushPromise`. New flush only starts after previous chain settles.
 * Publish order matches save order; latest pointer always references
 * the freshest CAR.
 *
 * # Coverage
 *
 *   - Two save-driven scheduleFlush() calls in succession run serially.
 *   - A scheduleFlushNoData() call concurrent with an in-flight save
 *     flush also serializes.
 *   - Three flushes back-to-back complete in capture order.
 *
 * The instrumentation wraps `flushScheduler.flushToIpfs` to track
 * concurrency: `inFlight` increments at start, decrements at end. With
 * serialization, `inFlight` is always ≤ 1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
} from '../../../profile/encryption';
import { waitForFlushSettled } from '../../helpers/profile/waitForFlushSettled';

// =============================================================================
// Test fixtures (mirrors profile-token-storage-no-data-flush.test.ts setup)
// =============================================================================

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
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
// Mock ProfileDatabase (same in-memory KV as sibling test)
// =============================================================================

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
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
// UxfPackage mock — slow toCar() so concurrent flushes have a real overlap
// window if serialization is broken.
// =============================================================================

vi.mock('../../../uxf/UxfPackage.js', async () => {
  // Issue #200 Phase 2: `toCar()` must return a real CAR (not JSON bytes)
  // because the flush scheduler now calls `extractCarRootCid` +
  // `pinCarBlocksToIpfs`. `makeFakeUxfCar` wraps the payload in a
  // minimal valid CAR; `decodeFakeUxfCar` recovers it.
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
        // 30ms artificial delay — wide enough that two concurrent flushes
        // would have an overlapping in-flight window if serialization
        // were broken. With serialization, this is a no-op (each flush
        // sees its own delay sequentially).
        await new Promise((r) => setTimeout(r, 30));
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
        // Dual-shape decode: prefer the new fake-CAR shape; fall back to
        // raw JSON so legacy fixture bytes still resolve.
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
      // Tight debounce so timers fire quickly inside the test budget.
      flushDebounceMs: 10,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

interface ConcurrencyTracker {
  inFlight: number;
  maxInFlight: number;
  startCount: number;
  endCount: number;
  /** ordered log of 'start:N' / 'end:N' for sequence assertions */
  events: string[];
}

interface FlushSchedulerInternals {
  flushToIpfs: () => Promise<void>;
  scheduleFlush: () => void;
  scheduleFlushNoData: () => void;
}

function instrumentFlushScheduler(
  provider: ProfileTokenStorageProvider,
): { tracker: ConcurrencyTracker; flushScheduler: FlushSchedulerInternals } {
  const flushScheduler = (
    provider as unknown as { flushScheduler: FlushSchedulerInternals }
  ).flushScheduler;
  const tracker: ConcurrencyTracker = {
    inFlight: 0,
    maxInFlight: 0,
    startCount: 0,
    endCount: 0,
    events: [],
  };
  const original = flushScheduler.flushToIpfs.bind(flushScheduler);
  flushScheduler.flushToIpfs = async function () {
    const id = tracker.startCount++;
    tracker.events.push(`start:${id}`);
    tracker.inFlight++;
    if (tracker.inFlight > tracker.maxInFlight) {
      tracker.maxInFlight = tracker.inFlight;
    }
    try {
      await original();
    } finally {
      tracker.inFlight--;
      tracker.endCount++;
      tracker.events.push(`end:${id}`);
    }
  };
  return { tracker, flushScheduler };
}

// =============================================================================
// Tests
// =============================================================================

describe('ProfileTokenStorageProvider — flush serialization (PR #127 partial-CAR race fix)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installMockFetch();
  });

  afterEach(() => {
    uninstallMockFetch();
  });

  it('two concurrent save-driven flushes run serially (max 1 in flight)', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    const { tracker, flushScheduler } = instrumentFlushScheduler(provider);

    // Plant pendingData so flushToIpfs has data to flush.
    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _tokenA: tokenA });

    // Schedule first flush; wait long enough for its timer (10ms) to fire
    // and for flushToIpfs to enter (its toCar mock yields after 30ms).
    flushScheduler.scheduleFlush();
    await new Promise((r) => setTimeout(r, 20));
    // First flush should now be in flight.
    expect(tracker.inFlight).toBe(1);

    // Plant fresh pendingData and schedule a second flush WHILE the first
    // is still in its 30ms toCar() yield.
    const tokenB = { id: '_tokenB', genesis: { tokenId: 'B' } };
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _tokenA: tokenA, _tokenB: tokenB });
    flushScheduler.scheduleFlush();

    // Wait for both flushes to settle.
    await waitForFlushSettled(provider, 10000);

    // Critical assertion: serialization held — never two flushes in
    // flight at the same time.
    expect(tracker.maxInFlight).toBe(1);
    expect(tracker.startCount).toBe(2);
    expect(tracker.endCount).toBe(2);
    // Order: start:0 → end:0 → start:1 → end:1 (no interleaving).
    expect(tracker.events).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);

    await provider.shutdown();
  });

  it('save flush + no-data flush concurrent → also serialized', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    const { tracker, flushScheduler } = instrumentFlushScheduler(provider);

    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    const data = buildTxfData({ _tokenA: tokenA });
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData = data;
    (provider as unknown as { lastLoadedData: TxfStorageDataBase | null }).lastLoadedData = data;

    // Save flush armed.
    flushScheduler.scheduleFlush();
    await new Promise((r) => setTimeout(r, 20));
    expect(tracker.inFlight).toBe(1);

    // No-data flush armed while save flush is running. The save-flush
    // timer has already fired and cleared this.flushTimer, so
    // scheduleFlushNoData arms a fresh timer rather than re-using the
    // existing one.
    flushScheduler.scheduleFlushNoData();

    await waitForFlushSettled(provider, 10000);

    expect(tracker.maxInFlight).toBe(1);
    expect(tracker.startCount).toBe(2);
    expect(tracker.events).toEqual(['start:0', 'end:0', 'start:1', 'end:1']);

    await provider.shutdown();
  });

  it('three rapid scheduleFlush() calls — all serialize, none overlap', async () => {
    const provider = createProvider(db);
    await provider.initialize();
    const { tracker, flushScheduler } = instrumentFlushScheduler(provider);

    const data1 = buildTxfData({ _t1: { id: '_t1', genesis: { tokenId: 'T1' } } });
    const data2 = buildTxfData({
      _t1: { id: '_t1', genesis: { tokenId: 'T1' } },
      _t2: { id: '_t2', genesis: { tokenId: 'T2' } },
    });
    const data3 = buildTxfData({
      _t1: { id: '_t1', genesis: { tokenId: 'T1' } },
      _t2: { id: '_t2', genesis: { tokenId: 'T2' } },
      _t3: { id: '_t3', genesis: { tokenId: 'T3' } },
    });

    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData = data1;
    flushScheduler.scheduleFlush();
    await new Promise((r) => setTimeout(r, 20));

    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData = data2;
    flushScheduler.scheduleFlush();
    await new Promise((r) => setTimeout(r, 20));

    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData = data3;
    flushScheduler.scheduleFlush();

    await waitForFlushSettled(provider, 10000);

    expect(tracker.maxInFlight).toBe(1);
    expect(tracker.startCount).toBe(3);
    expect(tracker.endCount).toBe(3);
    expect(tracker.events).toEqual([
      'start:0', 'end:0',
      'start:1', 'end:1',
      'start:2', 'end:2',
    ]);

    await provider.shutdown();
  });

  it('flushPromise chain awaitable end-to-end (load() / shutdown() see latest)', async () => {
    // load() and shutdown() both await flushPromise. With serialization,
    // flushPromise is the LATEST chained flush — awaiting it transitively
    // awaits all earlier chained flushes via the chain's `.then`.
    const provider = createProvider(db);
    await provider.initialize();
    const { tracker, flushScheduler } = instrumentFlushScheduler(provider);

    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _tokenA: { id: '_tokenA', genesis: { tokenId: 'A' } } });
    flushScheduler.scheduleFlush();
    await new Promise((r) => setTimeout(r, 20));

    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({
        _tokenA: { id: '_tokenA', genesis: { tokenId: 'A' } },
        _tokenB: { id: '_tokenB', genesis: { tokenId: 'B' } },
      });
    flushScheduler.scheduleFlush();
    await new Promise((r) => setTimeout(r, 20));

    // Read flushPromise — should be the latest chained promise.
    const flushPromise = (
      provider as unknown as { flushPromise: Promise<void> | null }
    ).flushPromise;
    expect(flushPromise).not.toBeNull();

    // Awaiting it must resolve only after BOTH flushes finished.
    await flushPromise;
    expect(tracker.startCount).toBe(2);
    expect(tracker.endCount).toBe(2);
    expect(tracker.inFlight).toBe(0);

    await provider.shutdown();
  });
});
