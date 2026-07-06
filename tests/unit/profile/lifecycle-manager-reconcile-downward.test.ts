/**
 * Issue #247 — `LifecycleManager.publishAggregatorPointerBestEffort`
 * WALKBACK_FLOOR reconcile-downward integration tests.
 *
 * When `pointer.publish()` throws `AGGREGATOR_POINTER_WALKBACK_FLOOR`
 * the catch arm now opportunistically calls `pointer.recoverLatest()`
 * and, if the visible version is strictly below the wallet's local
 * cursor, invokes `pointer.reconcileLocalVersionDownward()` to adopt
 * it. Reconciliation succeeded → the 60s WALKBACK throttle is NOT
 * armed (the floor that caused the deadlock has been removed; the
 * next publish has a fresh chance to land).
 *
 * Safety invariant: foreign-author candidates can NEVER reach
 * `reconcileLocalVersionDownward` as a non-null `RecoverResult` —
 * `recoverLatest()` XOR-decodes inclusion proofs under the wallet's
 * own signing identity, so a foreign-author commitment at the same
 * version produces SEMANTICALLY_INVALID classification and surfaces
 * as `recoverLatest() === null`. We assert this property by stubbing
 * `recoverLatest()` to return `null` (the same outcome a foreign-
 * author candidate would produce) and verifying the throttle DOES
 * arm normally (no reconciliation path taken).
 *
 * Coverage:
 *   - Same-author candidate (recoverLatest returns lower version,
 *     reconcile reports reconciled=true) → throttle NOT armed,
 *     `storage:replica-lag-reconciled` event emitted.
 *   - recoverLatest returns null (foreign-author or no-visible-pointer)
 *     → reconcile NOT called, throttle armed normally.
 *   - recoverLatest returns a version, reconcile reports
 *     reconciled=false (candidate.version >= localVersion) → throttle
 *     armed normally, no reconcile event.
 *   - recoverLatest throws → reconcile attempt fails gracefully,
 *     throttle armed normally (best-effort fallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../extensions/uxf/profile/aggregator-pointer';
import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../extensions/uxf/profile/aggregator-pointer/errors';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const FAKE_CID = 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy';

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
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
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

function createMockLocalCache(): {
  storage: {
    get: (k: string) => Promise<string | null>;
    set: (k: string, v: string) => Promise<void>;
    remove: (k: string) => Promise<void>;
    clear: () => Promise<void>;
  };
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
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
  };
}

function stubPointer(overrides: Partial<ProfilePointerLayer>): ProfilePointerLayer {
  return {
    async recoverLatest() {
      return null;
    },
    async publish() {
      return { cid: new Uint8Array(0), version: 0, attemptsUsed: 1 } as never;
    },
    async reconcileLocalVersionDownward() {
      return { reconciled: false, fromVersion: 0, toVersion: 0 } as never;
    },
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

interface ProviderTestHandle {
  provider: ProfileTokenStorageProvider;
  lifecycle: {
    publishAggregatorPointerBestEffort(
      cid: string,
    ): Promise<{ ok: boolean; transient: boolean; code?: string }>;
  };
  getPendingPublishCid(): string | null;
  getThrottleUntilMs(): number;
}

async function createTestProvider(
  pointer: ProfilePointerLayer,
): Promise<ProviderTestHandle> {
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
      getPointerLayer: () => pointer,
    },
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  const lifecycle = (provider as unknown as {
    lifecycleManager: {
      publishAggregatorPointerBestEffort: (
        cid: string,
      ) => Promise<{ ok: boolean; transient: boolean; code?: string }>;
    };
  }).lifecycleManager;
  const getPendingPublishCid = (): string | null =>
    (provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid;
  const getThrottleUntilMs = (): number =>
    (provider as unknown as {
      lifecycleManager: { walkbackFloorThrottleUntilMs: number };
    }).lifecycleManager.walkbackFloorThrottleUntilMs;
  return { provider, lifecycle, getPendingPublishCid, getThrottleUntilMs };
}

function walkbackError(): AggregatorPointerError {
  return new AggregatorPointerError(
    AggregatorPointerErrorCode.WALKBACK_FLOOR,
    'simulated walkback floor — Phase 3 candidate below localVersion',
  );
}

describe('LifecycleManager WALKBACK_FLOOR reconcile-downward (#247)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles localVersion downward when recoverLatest returns a same-author lower version; throttle NOT armed', async () => {
    const publish = vi.fn(async () => {
      throw walkbackError();
    });
    const recoverLatest = vi.fn(async () => ({
      cid: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      version: 5 as never,
    }));
    const reconcileLocalVersionDownward = vi.fn(async () => ({
      reconciled: true,
      fromVersion: 10,
      toVersion: 5,
    }) as never);
    const pointer = stubPointer({
      publish,
      recoverLatest,
      reconcileLocalVersionDownward,
    });
    const handle = await createTestProvider(pointer);
    // The provider's `initialize()` ran cold-start recovery which may
    // already have invoked `recoverLatest` one or more times (see
    // LifecycleManager#recoverFromAggregatorPointerBestEffort). Snapshot
    // the call counts AFTER initialize so subsequent assertions count
    // only the calls made inside `publishAggregatorPointerBestEffort`.
    const baselineRecoverCalls = recoverLatest.mock.calls.length;
    const baselineReconcileCalls = reconcileLocalVersionDownward.mock.calls.length;
    const events: { type: string; data?: unknown }[] = [];
    handle.provider.onEvent((ev) => {
      if (
        ev.type === 'storage:replica-lag' ||
        ev.type === 'storage:replica-lag-reconciled'
      ) {
        events.push({ type: ev.type, data: ev.data });
      }
    });
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);
      expect(result.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      // Reconcile fired exactly once during the publish call.
      expect(recoverLatest.mock.calls.length - baselineRecoverCalls).toBe(1);
      expect(reconcileLocalVersionDownward.mock.calls.length - baselineReconcileCalls).toBe(1);
      // The pendingPublishCid marker is still set (the next flush /
      // poll re-attempts publish from the reconciled baseline).
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
      // Throttle is NOT armed — reconciliation removed the floor.
      expect(handle.getThrottleUntilMs()).toBe(0);
      // Two events fired: the standard replica-lag (#241) AND the new
      // replica-lag-reconciled (#247).
      expect(events.map((e) => e.type)).toContain('storage:replica-lag');
      const reconciledEvent = events.find(
        (e) => e.type === 'storage:replica-lag-reconciled',
      );
      expect(reconciledEvent).toBeDefined();
      expect(reconciledEvent?.data).toMatchObject({
        cid: FAKE_CID,
        fromVersion: 10,
        toVersion: 5,
      });
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('does NOT reconcile when recoverLatest returns null (foreign-author or no visible pointer); throttle armed normally', async () => {
    const publish = vi.fn(async () => {
      throw walkbackError();
    });
    const recoverLatest = vi.fn(async () => null);
    const reconcileLocalVersionDownward = vi.fn(async () => ({
      reconciled: false,
      fromVersion: 0,
      toVersion: 0,
    }) as never);
    const pointer = stubPointer({
      publish,
      recoverLatest,
      reconcileLocalVersionDownward,
    });
    const handle = await createTestProvider(pointer);
    const baselineRecoverCalls = recoverLatest.mock.calls.length;
    const baselineReconcileCalls = reconcileLocalVersionDownward.mock.calls.length;
    const events: { type: string }[] = [];
    handle.provider.onEvent((ev) => {
      if (ev.type === 'storage:replica-lag-reconciled') {
        events.push({ type: ev.type });
      }
    });
    try {
      const t0 = Date.now();
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.transient).toBe(true);
      expect(result.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      // recoverLatest was called, but reconcile was NOT (null candidate
      // short-circuits — the foreign-author / no-visible-pointer case).
      expect(recoverLatest.mock.calls.length - baselineRecoverCalls).toBe(1);
      expect(reconcileLocalVersionDownward.mock.calls.length - baselineReconcileCalls).toBe(0);
      // Throttle IS armed (60s window).
      const throttleUntil = handle.getThrottleUntilMs();
      expect(throttleUntil).toBeGreaterThan(t0);
      expect(throttleUntil - Date.now()).toBeLessThanOrEqual(60_000);
      // No reconcile event fired.
      expect(events).toHaveLength(0);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('does NOT reconcile (no downgrade reported) when reconcile returns reconciled=false; throttle armed normally', async () => {
    const publish = vi.fn(async () => {
      throw walkbackError();
    });
    // recoverLatest returns a version, but reconcileLocalVersionDownward
    // (the real method) decides it's not a downgrade — modelled here by
    // having the stub return reconciled=false (e.g. candidate.version
    // >= localVersion).
    const recoverLatest = vi.fn(async () => ({
      cid: new Uint8Array([0xab]),
      version: 12 as never,
    }));
    const reconcileLocalVersionDownward = vi.fn(async () => ({
      reconciled: false,
      fromVersion: 10,
      toVersion: 10,
    }) as never);
    const pointer = stubPointer({
      publish,
      recoverLatest,
      reconcileLocalVersionDownward,
    });
    const handle = await createTestProvider(pointer);
    const baselineRecoverCalls = recoverLatest.mock.calls.length;
    const baselineReconcileCalls = reconcileLocalVersionDownward.mock.calls.length;
    const events: { type: string }[] = [];
    handle.provider.onEvent((ev) => {
      if (ev.type === 'storage:replica-lag-reconciled') {
        events.push({ type: ev.type });
      }
    });
    try {
      const t0 = Date.now();
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.transient).toBe(true);
      expect(recoverLatest.mock.calls.length - baselineRecoverCalls).toBe(1);
      expect(reconcileLocalVersionDownward.mock.calls.length - baselineReconcileCalls).toBe(1);
      // Throttle IS armed because reconcile reported no downgrade.
      const throttleUntil = handle.getThrottleUntilMs();
      expect(throttleUntil).toBeGreaterThan(t0);
      // No reconcile event.
      expect(events).toHaveLength(0);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('falls through to throttle when recoverLatest throws (best-effort)', async () => {
    const publish = vi.fn(async () => {
      throw walkbackError();
    });
    const recoverLatest = vi.fn(async () => {
      throw new Error('simulated discovery network error');
    });
    const reconcileLocalVersionDownward = vi.fn();
    const pointer = stubPointer({
      publish,
      recoverLatest,
      reconcileLocalVersionDownward: reconcileLocalVersionDownward as never,
    });
    const handle = await createTestProvider(pointer);
    const baselineRecoverCalls = recoverLatest.mock.calls.length;
    const baselineReconcileCalls = reconcileLocalVersionDownward.mock.calls.length;
    try {
      const t0 = Date.now();
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.transient).toBe(true);
      expect(result.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      expect(recoverLatest.mock.calls.length - baselineRecoverCalls).toBe(1);
      expect(reconcileLocalVersionDownward.mock.calls.length - baselineReconcileCalls).toBe(0);
      // Throttle armed normally.
      expect(handle.getThrottleUntilMs()).toBeGreaterThan(t0);
    } finally {
      await handle.provider.shutdown();
    }
  });
});
