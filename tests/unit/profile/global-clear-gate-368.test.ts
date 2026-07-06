/**
 * Issue #368 — process-wide `applySnapshot` suppression during
 * multi-wallet `Sphere.clear()` batches.
 *
 * Item #2 (issue #364, sibling PR #365) added the per-instance
 * `isClearing` latch on `ProfileTokenStorageProvider`. It correctly
 * suppresses `applySnapshotIfWired` for THE provider whose `clear()`
 * is in flight but leaves a gap when `Sphere.clear()` is invoked
 * sequentially across several wallets in the same process (or when
 * multi-wallet apps run many providers concurrently): while wallet A's
 * `clear()` is running, wallets B/C/D's periodic pointer-polls keep
 * firing `applySnapshotIfWired` against state that is about to be
 * wiped next.
 *
 * The fix is a process-wide reference-counted gate
 * (`profile/global-clear-gate.ts`) consulted by
 * `_applySnapshotIfWiredImpl` AFTER the per-instance latch. While the
 * gate is held (depth > 0), every provider in the process suppresses
 * snapshot dispatch and bumps
 * `profile.applySnapshot.suppressedDuringGlobalClear`.
 *
 * This test file pins the gate's semantics in isolation — it does NOT
 * exercise the full `Sphere.clear()` body (that's covered by the
 * Item #2 file). It verifies:
 *
 *   - depth tracking composes (begin / end nest);
 *   - end is no-op-safe at depth 0;
 *   - a HELD gate suppresses applySnapshot even when isClearing=false;
 *   - the counter `profile.applySnapshot.suppressedDuringGlobalClear`
 *     fires the expected number of times;
 *   - after the gate releases, applySnapshot proceeds normally.
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
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import type { ApplySnapshotResult } from '../../../extensions/uxf/profile/profile-snapshot-dispatcher';
import {
  beginGlobalClear,
  endGlobalClear,
  isGlobalClearActive,
  __resetGlobalClearForTest,
} from '../../../extensions/uxf/profile/global-clear-gate';
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

function makeApplyResult(): ApplySnapshotResult {
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
}

function createProvider(addressId: string): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    createMockDb(),
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId,
      encrypt: true,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

describe('Issue #368 — process-wide global-clear gate', () => {
  beforeEach(() => {
    __stopAutoDumpForTest();
    __setPerfEnabledForTest(true);
    dumpAndReset();
    __resetGlobalClearForTest();
  });

  afterEach(() => {
    __setPerfEnabledForTest(false);
    __stopAutoDumpForTest();
    __resetGlobalClearForTest();
  });

  // ---------------------------------------------------------------------------
  // Counter semantics
  // ---------------------------------------------------------------------------

  it('begin / end track depth and isGlobalClearActive() returns true while held', () => {
    expect(isGlobalClearActive()).toBe(false);
    beginGlobalClear();
    expect(isGlobalClearActive()).toBe(true);
    endGlobalClear();
    expect(isGlobalClearActive()).toBe(false);
  });

  it('depth nests: two begins require two ends to release', () => {
    beginGlobalClear();
    beginGlobalClear();
    expect(isGlobalClearActive()).toBe(true);
    endGlobalClear();
    expect(isGlobalClearActive()).toBe(true);
    endGlobalClear();
    expect(isGlobalClearActive()).toBe(false);
  });

  it('endGlobalClear is no-op-safe at depth 0 — a stray double-end cannot go negative', () => {
    expect(isGlobalClearActive()).toBe(false);
    endGlobalClear();
    endGlobalClear();
    expect(isGlobalClearActive()).toBe(false);

    // Subsequent begin still moves the gate to 1 cleanly.
    beginGlobalClear();
    expect(isGlobalClearActive()).toBe(true);
    endGlobalClear();
    expect(isGlobalClearActive()).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Gate effect on applySnapshotIfWired
  // ---------------------------------------------------------------------------

  it('held gate suppresses applySnapshotIfWired across an UNRELATED provider (isClearing=false)', async () => {
    // Two providers: A is "being cleared" via the bracket; B is a
    // sibling whose periodic-poll fires while A is mid-clear. The
    // per-instance `isClearing` latch on B is unset.
    const providerA = createProvider('addrA');
    const providerB = createProvider('addrB');
    const applierA = vi.fn(async () => makeApplyResult());
    const applierB = vi.fn(async () => makeApplyResult());
    providerA.setApplySnapshotCallback(applierA);
    providerB.setApplySnapshotCallback(applierB);
    await providerA.initialize();
    await providerB.initialize();

    beginGlobalClear();
    try {
      const a = await providerA.applySnapshotIfWired('bafy-A');
      const b = await providerB.applySnapshotIfWired('bafy-B');
      expect(a).toBeNull();
      expect(b).toBeNull();
      expect(applierA).not.toHaveBeenCalled();
      expect(applierB).not.toHaveBeenCalled();
    } finally {
      endGlobalClear();
    }
  });

  it('bumps profile.applySnapshot.suppressedDuringGlobalClear exactly once per gated call', async () => {
    const provider = createProvider('addr');
    const applier = vi.fn(async () => makeApplyResult());
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    beginGlobalClear();
    try {
      await provider.applySnapshotIfWired('bafy-1');
      await provider.applySnapshotIfWired('bafy-2');
      await provider.applySnapshotIfWired('bafy-3');
    } finally {
      endGlobalClear();
    }

    const counters = snapshot();
    expect(
      counters['profile.applySnapshot.suppressedDuringGlobalClear']?.count,
    ).toBe(3);
    expect(counters['profile.applySnapshot.fired']?.count ?? 0).toBe(0);
    expect(applier).not.toHaveBeenCalled();
  });

  it('per-instance isClearing takes precedence over the global gate', async () => {
    // When BOTH latches would gate, the per-instance one fires first
    // (it's checked earlier in `_applySnapshotIfWiredImpl`). This pins
    // the ordering so counters stay attributable.
    const provider = createProvider('addr');
    const applier = vi.fn(async () => makeApplyResult());
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    (provider as unknown as { isClearing: boolean }).isClearing = true;
    beginGlobalClear();
    try {
      await provider.applySnapshotIfWired('bafy-1');
    } finally {
      endGlobalClear();
      (provider as unknown as { isClearing: boolean }).isClearing = false;
    }

    const counters = snapshot();
    expect(counters['profile.applySnapshot.suppressedDuringClear']?.count).toBe(1);
    // Global gate stayed quiet (the per-instance branch returned first).
    expect(
      counters['profile.applySnapshot.suppressedDuringGlobalClear']?.count ?? 0,
    ).toBe(0);
  });

  it('after the gate releases, applySnapshot proceeds normally', async () => {
    const provider = createProvider('addr');
    const applier = vi.fn(async () => makeApplyResult());
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();

    beginGlobalClear();
    const blocked = await provider.applySnapshotIfWired('bafy-blocked');
    expect(blocked).toBeNull();
    endGlobalClear();

    const allowed = await provider.applySnapshotIfWired('bafy-allowed');
    expect(allowed).not.toBeNull();
    expect(applier).toHaveBeenCalledTimes(1);
    expect(applier).toHaveBeenCalledWith('bafy-allowed');
  });
});
