/**
 * Issue #364 Item #2 — Suppress `applySnapshotIfWired` invocations
 * during {@link ProfileTokenStorageProvider.clear}.
 *
 * Trace (from issue #363 §D.3 baseline): the periodic pointer-poll
 * fires during `Sphere.clear()` teardown. `pointerLayer.recoverLatest()`
 * returns a CID; `applySnapshotIfWired(cid)` runs the wired callback,
 * which fetches the CAR, parses it as a lean snapshot, and dispatches
 * a per-writer JOIN against state that is about to be wiped. 23
 * invocations were observed in a 41 s clear-all-wallets phase, wasting
 * IPFS round-trips and racing the destructive deletes.
 *
 * The fix is a per-provider `isClearing` latch checked by
 * `_applySnapshotIfWiredImpl`. Set at the top of `clear()`, unset on
 * completion; a concurrent applySnapshot returns null and bumps
 * `profile.applySnapshot.suppressedDuringClear`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ApplySnapshotResult } from '../../../profile/profile-snapshot-dispatcher';
import {
  __setPerfEnabledForTest,
  __stopAutoDumpForTest,
  dumpAndReset,
  snapshot,
} from '../../../core/perf-counters.js';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1test',
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

function makeApplyResult(joinedAny = false): ApplySnapshotResult {
  return {
    joinedAny,
    addressesSeen: joinedAny ? 1 : 0,
    bundleEntriesSeen: 0,
    counters: {
      entriesEvaluated: joinedAny ? 1 : 0,
      liveLanded: joinedAny ? 1 : 0,
      tombstonesLanded: 0,
      localWon: 0,
      remoteRejectedMalformed: 0,
    },
  };
}

function createProvider(): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    createMockDb(),
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
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

describe('Issue #364 Item #2 — applySnapshot suppression during clear()', () => {
  beforeEach(() => {
    __stopAutoDumpForTest();
    __setPerfEnabledForTest(true);
    // Drop any cross-test residue from the shared counter map.
    dumpAndReset();
  });

  afterEach(() => {
    __setPerfEnabledForTest(false);
    __stopAutoDumpForTest();
  });

  it('applySnapshotIfWired() called during clear() returns null without invoking callback', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    // Spy on db.all so we can intercept mid-clear and fire an
    // applySnapshotIfWired race during the await chain inside clear().
    const db = (provider as unknown as { db: ProfileDatabase }).db;
    const realAll = db.all.bind(db);
    let raceResult: ApplySnapshotResult | null | undefined;
    let allCalls = 0;
    db.all = (async (prefix?: string) => {
      allCalls += 1;
      if (allCalls === 1) {
        // Fire the race BEFORE returning from db.all() — the clear()
        // method is awaiting us, so isClearing is already true.
        raceResult = await provider.applySnapshotIfWired('bafy-snapshot-cid');
      }
      return realAll(prefix);
    }) as ProfileDatabase['all'];

    const ok = await provider.clear();
    expect(ok).toBe(true);

    expect(raceResult).toBeNull();
    expect(applier).not.toHaveBeenCalled();
  });

  it('bumps profile.applySnapshot.suppressedDuringClear when the gate trips', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    const db = (provider as unknown as { db: ProfileDatabase }).db;
    const realAll = db.all.bind(db);
    let allCalls = 0;
    db.all = (async (prefix?: string) => {
      allCalls += 1;
      if (allCalls === 1) {
        await provider.applySnapshotIfWired('bafy-cid-1');
        await provider.applySnapshotIfWired('bafy-cid-2');
      }
      return realAll(prefix);
    }) as ProfileDatabase['all'];

    await provider.clear();

    const counters = snapshot();
    expect(counters['profile.applySnapshot.suppressedDuringClear']?.count).toBe(2);
    expect(counters['profile.applySnapshot.fired']?.count ?? 0).toBe(0);
    expect(applier).not.toHaveBeenCalled();
  });

  it('applySnapshotIfWired() works normally after clear() completes', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    const ok = await provider.clear();
    expect(ok).toBe(true);

    // Gate has been unset in finally — a fresh call should proceed.
    const result = await provider.applySnapshotIfWired('bafy-after-clear');
    expect(result).not.toBeNull();
    expect(applier).toHaveBeenCalledTimes(1);
    expect(applier).toHaveBeenCalledWith('bafy-after-clear');
  });

  it('unsets isClearing even when clear() throws mid-way', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    // Force db.all to reject so clear() takes the catch branch.
    const db = (provider as unknown as { db: ProfileDatabase }).db;
    db.all = (async () => {
      throw new Error('synthetic db.all failure');
    }) as ProfileDatabase['all'];

    const ok = await provider.clear();
    expect(ok).toBe(false);

    // Latch released in `finally`; a subsequent applySnapshot should
    // dispatch normally.
    const result = await provider.applySnapshotIfWired('bafy-after-failed-clear');
    expect(result).not.toBeNull();
    expect(applier).toHaveBeenCalledTimes(1);
  });

  it('isClearing gate takes precedence over shutdown gate', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    // Force the isClearing latch directly to simulate an in-flight clear.
    (provider as unknown as { isClearing: boolean }).isClearing = true;
    try {
      const result = await provider.applySnapshotIfWired('bafy-cid');
      expect(result).toBeNull();
      expect(applier).not.toHaveBeenCalled();

      const counters = snapshot();
      expect(
        counters['profile.applySnapshot.suppressedDuringClear']?.count,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      (provider as unknown as { isClearing: boolean }).isClearing = false;
    }
  });

  it('returns false (without setting isClearing) when provider not initialized', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);

    // Skip initialize() — clear() should short-circuit.
    const ok = await provider.clear();
    expect(ok).toBe(false);

    // Gate must be in the un-set state — applySnapshot proceeds normally.
    const result = await provider.applySnapshotIfWired('bafy-cid');
    expect(result).not.toBeNull();
    expect(applier).toHaveBeenCalledTimes(1);
  });
});
