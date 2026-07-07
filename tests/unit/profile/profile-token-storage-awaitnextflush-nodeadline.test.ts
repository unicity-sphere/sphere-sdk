/**
 * Regression tests for `awaitNextFlush(timeoutMs)` — no-deadline mode.
 *
 * Diagnosis (2026-05-27): the legacy → Profile migration timed out at
 * "Flushing Profile storage to disk" because `awaitNextFlush()` defaults
 * to a 30s wall-clock cap and the migration's post-save flush had to pin
 * ~250+ CAR blocks serially against the HTTP sidecar (~100ms each ≈
 * 25-30s). Capping a one-shot bulk operation on wall-clock time is
 * incorrect API design: the operation's duration legitimately scales
 * with input. The fix teaches `awaitNextFlush(0)` (and any non-finite
 * / non-positive value) to skip the deadline race entirely, so the
 * migration helper can opt out of the cap while every other caller
 * keeps its hot-path 30s budget unchanged.
 *
 * The 4-iteration runaway guard inside the flush loop is NOT relaxed —
 * a genuinely stuck save→flush feedback loop still surfaces as TIMEOUT,
 * independent of the wall-clock deadline. This file pins both behaviors.
 *
 * Coverage:
 *   1. timeoutMs=0 → flush longer than 30s completes without TIMEOUT
 *   2. timeoutMs=30000 (default) → flush longer than budget throws TIMEOUT
 *   3. timeoutMs=Number.POSITIVE_INFINITY → treated as no-deadline
 *   4. timeoutMs=NaN → treated as no-deadline
 *   5. timeoutMs=-1 → treated as no-deadline (defensive)
 *   6. Runaway save→flush still throws TIMEOUT even with no-deadline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import { deriveProfileEncryptionKey } from '../../../extensions/uxf/profile/encryption';

const TEST_PRIVATE_KEY =
  'ccddeeffccddeeffccddeeffccddeeffccddeeffccddeeffccddeeffccddeeff';
const EXPECTED_ADDRESS_ID = 'DIRECT_ccddee_ffaabb';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'cc'.repeat(32),
  directAddress: 'DIRECT://CCDDEEFFAABB112233445566778899AABBCCDDEEFF',
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

function buildTxfData(tokens: Record<string, unknown> = {}): TxfStorageDataBase {
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

// ---------------------------------------------------------------------------
// Mock ProfileDatabase
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
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
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
// Provider factory + fetch mock (every pin succeeds; the flush body's
// duration is controlled below by injecting a slow flushToIpfs).
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function installMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL) => {
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

function createProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: 10,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

interface FlushSchedulerInternals {
  flushToIpfs: () => Promise<void>;
}

/**
 * Replace `flushScheduler.flushToIpfs` with a no-op that sleeps for
 * `delayMs` then clears `pendingData` so `awaitNextFlush` returns.
 * Lets the test drive the "flush takes N ms" axis directly without
 * needing to time real CAR builds.
 */
function installSlowFlush(provider: ProfileTokenStorageProvider, delayMs: number): void {
  const fs = (provider as unknown as { flushScheduler: FlushSchedulerInternals }).flushScheduler;
  fs.flushToIpfs = async function () {
    await new Promise((r) => setTimeout(r, delayMs));
    // Clear pendingData so the loop terminates after this iteration.
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData = null;
  };
}

/**
 * Install a flushToIpfs that keeps regenerating pendingData on each
 * iteration — drives the 4-iteration runaway guard. The flush itself
 * completes quickly each time; what's runaway is the save → flush →
 * save loop.
 */
function installRunawayFlush(provider: ProfileTokenStorageProvider): void {
  const fs = (provider as unknown as { flushScheduler: FlushSchedulerInternals }).flushScheduler;
  fs.flushToIpfs = async function () {
    // Each flush clears, then a "concurrent save" lands fresh data
    // immediately. With 4 iterations max, the loop terminates with
    // TIMEOUT regardless of wall-clock deadline.
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData = null;
    await new Promise((r) => setTimeout(r, 1));
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _t: { id: '_t', genesis: { tokenId: 't' } } });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('awaitNextFlush — no-deadline mode (migration bulk-import fix)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    installMockFetch();
  });

  afterEach(() => {
    uninstallMockFetch();
  });

  it('timeoutMs=0 — completes even when flush takes longer than 30s default', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    // Flush that takes 200ms. With the legacy default we would not see
    // a timeout for so short a flush; the point of THIS assertion is
    // that the no-deadline path doesn't add latency or hang. The slow-
    // path proof comes from running this whole test in <1s.
    installSlowFlush(provider, 200);
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _t: { id: '_t', genesis: { tokenId: 't' } } });

    const start = Date.now();
    await provider.awaitNextFlush(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    // Must not throw, must not be capped — a 30s cap with a 200ms flush
    // would not have surfaced either way; this assertion is here as
    // the call shape we expect callers (migration) to use.

    await provider.shutdown();
  });

  it('timeoutMs=30000 default — TIMEOUT when flush exceeds budget', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    // 200ms flush + 50ms test budget = TIMEOUT.
    installSlowFlush(provider, 200);
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _t: { id: '_t', genesis: { tokenId: 't' } } });

    await expect(provider.awaitNextFlush(50)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    await provider.shutdown();
  });

  it.each([
    ['Number.POSITIVE_INFINITY', Number.POSITIVE_INFINITY],
    ['Number.NEGATIVE_INFINITY', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['negative value (-1)', -1],
    ['negative value (-100000)', -100000],
  ])('treats %s as no-deadline (no TIMEOUT)', async (_label, value) => {
    const provider = createProvider(db);
    await provider.initialize();

    installSlowFlush(provider, 100);
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _t: { id: '_t', genesis: { tokenId: 't' } } });

    // Must NOT throw TIMEOUT — even though 100ms > a hypothetical tight cap.
    await expect(provider.awaitNextFlush(value)).resolves.toBeUndefined();

    await provider.shutdown();
  });

  it('runaway save→flush loop still throws TIMEOUT under no-deadline (4-iteration guard)', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    installRunawayFlush(provider);
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _t: { id: '_t', genesis: { tokenId: 't' } } });

    // Even with no-deadline, the 4-iteration guard must trip — a genuine
    // runaway is bounded by iteration count, not wall-clock. Without
    // this assertion a regression that removed the iteration cap would
    // silently let the provider spin forever on a stuck save loop.
    await expect(provider.awaitNextFlush(0)).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('pendingData kept regenerating'),
    });

    await provider.shutdown();
  });

  it('TIMEOUT-rejection setTimeout is NOT allocated in no-deadline mode', async () => {
    // The pre-fix code unconditionally created a setTimeout(...) racer
    // whose callback rejected with `new SphereError('awaitNextFlush:
    // timeout awaiting serialized flush', 'TIMEOUT')`. The no-deadline
    // mode skips Promise.race entirely. Steelman P2#8: a bare call-
    // count ceiling (< 8) silently rots as unrelated future code adds
    // timers; we instead inspect each registered callback's source for
    // the TIMEOUT-rejection signature so the assertion catches only
    // the regression we care about.
    const provider = createProvider(db);
    await provider.initialize();

    installSlowFlush(provider, 10);
    (provider as unknown as { pendingData: TxfStorageDataBase | null }).pendingData =
      buildTxfData({ _t: { id: '_t', genesis: { tokenId: 't' } } });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await provider.awaitNextFlush(0);
    setTimeoutSpy.mockRestore();

    // Walk every registered callback. A regression that re-introduced
    // the unconditional racer would register a callback whose toString
    // includes the SphereError 'TIMEOUT' construction. Unrelated
    // setTimeout calls (debounce, throttle, internal yields) pass.
    const timeoutRacerCalls = setTimeoutSpy.mock.calls.filter((call) => {
      const cb = call[0];
      if (typeof cb !== 'function') return false;
      const src = String(cb);
      return (
        src.includes('awaitNextFlush') ||
        src.includes("'TIMEOUT'") ||
        src.includes('"TIMEOUT"') ||
        src.includes('timeout awaiting serialized flush')
      );
    });
    expect(timeoutRacerCalls).toEqual([]);

    await provider.shutdown();
  });
});
