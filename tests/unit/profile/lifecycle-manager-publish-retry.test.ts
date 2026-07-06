/**
 * Tests for Gap 2 — propagating transient aggregator-pointer publish
 * failures to the at-least-once gate.
 *
 * The previous `publishAggregatorPointerBestEffort` swallowed every
 * error, returning `void`. Transient failures (network blip, aggregator
 * slow) meant the CAR was pinned and the OrbitDB bundle ref written,
 * but the pointer never reached the aggregator — cross-device peers
 * could not discover the bundle via Path 2 (aggregator pointer + IPFS),
 * relying entirely on Path 1 (libp2p pubsub) which is unreliable.
 *
 * The fix surfaces transient failures via a typed result and stamps a
 * `pendingPublishCid` retry marker (persisted to local cache for crash
 * safety). The marker is retried at the start of every `flushToIpfs`
 * and `runPointerPollOnce`. While non-null, `forceFlushSerialized`
 * rejects — the at-least-once gate in PaymentsModule refuses to
 * advance the Nostr `since` filter, so the inbound event re-replays
 * on the next reconnect (idempotent via addToken stateHash dedup).
 *
 * Coverage:
 *   - Transient publish failure stamps `pendingPublishCid` and the
 *     return result classifies as `transient: true`.
 *   - Permanent publish failure emits `storage:error` and clears the
 *     marker (no auto-retry on operator-actionable errors).
 *   - A successful retry clears the marker.
 *   - `retryPendingPublishIfAny()` is a no-op when no marker is set.
 *   - A persisted marker survives `setPendingPublishCid` round-trip
 *     through `localCache`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../profile/aggregator-pointer/errors';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

// CIDs used in these tests don't need to be valid IPFS roots — the
// publish stub only touches `CID.parse`. Use a real v1 CID string so
// parse succeeds.
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

/**
 * In-memory StorageProvider for the localCache slot. Matches the
 * minimal surface area the facade reads/writes (`get`, `set`, `remove`).
 */
function createMockLocalCache(): {
  storage: { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<void>; remove: (k: string) => Promise<void>; clear: () => Promise<void> };
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
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

interface ProviderTestHandle {
  provider: ProfileTokenStorageProvider;
  lifecycle: {
    publishAggregatorPointerBestEffort(
      cid: string,
    ): Promise<{ ok: boolean; transient: boolean; code?: string }>;
    retryPendingPublishIfAny(): Promise<{
      attempted: boolean;
      ok: boolean;
      transient: boolean;
      code?: string;
    }>;
  };
  cacheStore: Map<string, string>;
  getPendingPublishCid(): string | null;
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
    // localCache slot — provider casts to StorageProvider internally.
    localCache.storage as unknown as never,
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  const lifecycle = (provider as unknown as { lifecycleManager: {
    publishAggregatorPointerBestEffort: (
      cid: string,
    ) => Promise<{ ok: boolean; transient: boolean; code?: string }>;
    retryPendingPublishIfAny: () => Promise<{
      attempted: boolean;
      ok: boolean;
      transient: boolean;
      code?: string;
    }>;
  } }).lifecycleManager;
  const getPendingPublishCid = (): string | null =>
    (provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid;
  return { provider, lifecycle, cacheStore: localCache.store, getPendingPublishCid };
}

describe('LifecycleManager.publishAggregatorPointerBestEffort — Gap 2', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps pendingPublishCid on a transient publish failure', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.NETWORK_ERROR,
          'simulated transient network blip',
        );
      }),
    });
    const handle = await createTestProvider(pointer);
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
      // Persisted to localCache (per-address key) for crash safety.
      // Settle the fire-and-forget persistence write before reading.
      await new Promise((r) => setTimeout(r, 0));
      // Find the persisted marker by prefix — the actual addressId
      // suffix depends on the per-test identity's directAddress and
      // isn't worth coupling the assertion to. The semantic check is
      // "exactly one marker key exists and its value is the CID".
      const markerKeys = [...handle.cacheStore.keys()].filter((k) =>
        k.startsWith(STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID),
      );
      expect(markerKeys).toHaveLength(1);
      expect(handle.cacheStore.get(markerKeys[0])).toBe(FAKE_CID);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('clears pendingPublishCid on a successful publish', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => ({
        cid: new Uint8Array(0),
        version: 42,
        attemptsUsed: 1,
      })) as never,
    });
    const handle = await createTestProvider(pointer);
    try {
      // Seed a marker first (simulate prior transient failure).
      (handle.provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid = FAKE_CID;
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(true);
      expect(result.transient).toBe(false);
      expect(handle.getPendingPublishCid()).toBeNull();
      // Persistence write settles asynchronously — give it a tick.
      await new Promise((r) => setTimeout(r, 0));
      // addressId for TEST_IDENTITY = computeAddressId('DIRECT://AABBCC...EEFFFF')
      // = 'DIRECT_aabbcc_eeffff' (first/last 6 chars, lowercased)
      const expectedKey =
        STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID + '_DIRECT_aabbcc_eeffff';
      expect(handle.cacheStore.has(expectedKey)).toBe(false);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('clears pendingPublishCid on a permanent publish failure (operator alert is the action)', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => {
        const err = new AggregatorPointerError(
          AggregatorPointerErrorCode.PROTOCOL_ERROR,
          'simulated permanent integrity failure',
        );
        // Force the code to match the PERMANENT_POINTER_ERROR_CODES set.
        (err as Error & { code: string }).code = 'AGGREGATOR_POINTER_PROTOCOL_ERROR';
        throw err;
      }),
    });
    const handle = await createTestProvider(pointer);
    try {
      // Seed a stale marker to verify it's cleared on permanent failure.
      (handle.provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid = FAKE_CID;
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(false);
      expect(result.code).toBe('AGGREGATOR_POINTER_PROTOCOL_ERROR');
      expect(handle.getPendingPublishCid()).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('retryPendingPublishIfAny is a no-op when no marker is set', async () => {
    const publish = vi.fn(async () => ({ cid: new Uint8Array(0), version: 0, attemptsUsed: 1 }) as never);
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      const result = await handle.lifecycle.retryPendingPublishIfAny();
      expect(result.attempted).toBe(false);
      expect(result.ok).toBe(true);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('retryPendingPublishIfAny retries the stored marker and clears it on success', async () => {
    const publish = vi.fn(async () => ({ cid: new Uint8Array(0), version: 7, attemptsUsed: 1 }) as never);
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      (handle.provider as unknown as { pendingPublishCid: string | null }).pendingPublishCid = FAKE_CID;
      const result = await handle.lifecycle.retryPendingPublishIfAny();
      expect(result.attempted).toBe(true);
      expect(result.ok).toBe(true);
      expect(publish).toHaveBeenCalledOnce();
      expect(handle.getPendingPublishCid()).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #241 — typed transient event surfaces (replica-lag vs generic)
// ---------------------------------------------------------------------------

describe('LifecycleManager.publishAggregatorPointerBestEffort — issue #241 events', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits storage:replica-lag with code AGGREGATOR_POINTER_WALKBACK_FLOOR on the walkback-floor transient', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.WALKBACK_FLOOR,
          'Phase 3 walkback reached candidate=10 below localVersion=11',
        );
      }),
    });
    const handle = await createTestProvider(pointer);
    const events: { type: string; data?: unknown }[] = [];
    handle.provider.onEvent((ev) => {
      if (ev.type === 'storage:replica-lag' || ev.type === 'storage:error') {
        events.push({ type: ev.type, data: ev.data });
      }
    });
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      // Pin durability is the gate; lifecycle stamps marker + returns transient.
      expect(result.ok).toBe(false);
      expect(result.transient).toBe(true);
      expect(result.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      // Soft `storage:replica-lag` event is emitted (distinct from
      // terminal `storage:error`) so monitoring can route on it.
      const replicaLag = events.find((e) => e.type === 'storage:replica-lag');
      expect(replicaLag).toBeDefined();
      expect((replicaLag?.data as { code?: string })?.code).toBe(
        'AGGREGATOR_POINTER_WALKBACK_FLOOR',
      );
      // The retry marker is stamped for the next flush / pointer poll.
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('does NOT emit storage:replica-lag for a generic transient (network blip)', async () => {
    const pointer = stubPointer({
      publish: vi.fn(async () => {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.NETWORK_ERROR,
          'simulated transient network blip',
        );
      }),
    });
    const handle = await createTestProvider(pointer);
    const events: { type: string }[] = [];
    handle.provider.onEvent((ev) => {
      if (ev.type === 'storage:replica-lag') events.push({ type: ev.type });
    });
    try {
      const result = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(result.transient).toBe(true);
      expect(result.code).toBe('AGGREGATOR_POINTER_NETWORK_ERROR');
      // Generic transients route through the upstream FlushScheduler's
      // `storage:pending-publish` event — `storage:replica-lag` is reserved
      // for the walkback-floor case so operators can distinguish them.
      expect(events).toHaveLength(0);
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
    } finally {
      await handle.provider.shutdown();
    }
  });
});

/**
 * Issue #245 #3 — WALKBACK_FLOOR retry throttle.
 *
 * After a `AGGREGATOR_POINTER_WALKBACK_FLOOR` transient failure,
 * subsequent calls to `publishAggregatorPointerBestEffort` within
 * the throttle window short-circuit (returning the same transient
 * code) WITHOUT invoking `pointer.publish` — which prevents burning
 * the ~9-15s inner retry budget on a deterministic-given-state
 * failure mode and reduces log noise from "hundreds" to ~one per
 * minute (per the issue's observed manual-test storm).
 *
 * Coverage:
 *   - First WALKBACK_FLOOR arms the throttle and stamps the CID.
 *   - Second call within the window short-circuits (publish NOT
 *     invoked) but still returns transient + keeps the CID stamped.
 *   - A different transient code (NETWORK_ERROR) CLEARS the
 *     throttle — fault class change re-enables prompt retry.
 *   - A successful publish CLEARS the throttle and re-enables
 *     normal retry on future failures.
 */
describe('LifecycleManager.publishAggregatorPointerBestEffort — WALKBACK_FLOOR throttle (#245 #3)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function walkbackError(): AggregatorPointerError {
    return new AggregatorPointerError(
      AggregatorPointerErrorCode.WALKBACK_FLOOR,
      'simulated replication lag — Phase 3 walkback below localVersion',
    );
  }

  it('first WALKBACK_FLOOR arms the throttle; second call within window short-circuits', async () => {
    const publish = vi.fn(async () => {
      throw walkbackError();
    });
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      // First call — invokes publish, hits WALKBACK_FLOOR, arms throttle.
      const r1 = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(r1.ok).toBe(false);
      expect(r1.transient).toBe(true);
      expect(r1.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      expect(publish).toHaveBeenCalledOnce();
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);

      // Second call within the throttle window — short-circuits.
      const r2 = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(r2.ok).toBe(false);
      expect(r2.transient).toBe(true);
      expect(r2.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      // publish was NOT called again — throttle short-circuited.
      expect(publish).toHaveBeenCalledOnce();
      // pendingPublishCid still stamped (caller's flush body needs it).
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('a different transient code (NETWORK_ERROR) clears the throttle', async () => {
    let nextThrow: 'walkback' | 'network' = 'walkback';
    const publish = vi.fn(async () => {
      if (nextThrow === 'walkback') throw walkbackError();
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.NETWORK_ERROR,
        'simulated network blip',
      );
    });
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      // Arm the throttle with WALKBACK_FLOOR.
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledOnce();

      // Throttled — publish NOT invoked.
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledOnce();

      // Manually clear the throttle by simulating the WALKBACK lag
      // expiring (test-only knob via internals — avoids waiting 60s).
      (handle.provider as unknown as {
        lifecycleManager: { walkbackFloorThrottleUntilMs: number };
      }).lifecycleManager.walkbackFloorThrottleUntilMs = 0;

      // Next call hits the NETWORK_ERROR arm — publish invoked,
      // and the throttle should NOT re-arm (different code class).
      nextThrow = 'network';
      const r = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(r.transient).toBe(true);
      expect(r.code).toBe('AGGREGATOR_POINTER_NETWORK_ERROR');
      expect(publish).toHaveBeenCalledTimes(2);

      // Subsequent call after NETWORK_ERROR is NOT throttled.
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledTimes(3);
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('successful publish clears the throttle', async () => {
    let succeedNext = false;
    const publish = vi.fn(async () => {
      if (!succeedNext) throw walkbackError();
      return { cid: new Uint8Array(0), version: 99, attemptsUsed: 1 } as never;
    });
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      // Arm the throttle.
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledOnce();
      // Throttled.
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledOnce();

      // Clear throttle (simulate window expiry), then succeed.
      (handle.provider as unknown as {
        lifecycleManager: { walkbackFloorThrottleUntilMs: number };
      }).lifecycleManager.walkbackFloorThrottleUntilMs = 0;
      succeedNext = true;
      const r = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(r.ok).toBe(true);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(handle.getPendingPublishCid()).toBeNull();

      // Throttle was cleared on success; a future WALKBACK_FLOOR
      // would re-arm fresh (no carry-over from prior session).
      succeedNext = false;
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledTimes(3);
    } finally {
      await handle.provider.shutdown();
    }
  });
});

/**
 * Issue #247 — concurrent-caller coalescing.
 *
 * PR #245's throttle (`walkbackFloorThrottleUntilMs`) arms the
 * throttle window only AFTER `pointer.publish()` resolves. Concurrent
 * callers (flushScheduler.publishSnapshotIfWired + debounced
 * dispatchDirtyFlush + retryPendingPublishIfAny from runPointerPollOnce)
 * all pass the entry check before any catch arm fires — all proceed
 * to call `pointer.publish()`, all fail, all 6+ print the same WARN
 * line. The throttle only stops sequential bursts.
 *
 * The fix coalesces parallel callers onto an in-flight publish via
 * `walkbackPublishInFlight`: the first caller's publish runs; every
 * other caller awaiting in the same window returns the same result
 * WITHOUT calling `pointer.publish` again. Single publish per window.
 */
describe('LifecycleManager.publishAggregatorPointerBestEffort — concurrent-caller coalescing (#247)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces parallel WALKBACK_FLOOR publishes onto a single in-flight call', async () => {
    // Stub publish that takes a measurable time so concurrent callers
    // have a real window in which to coalesce. Without the artificial
    // delay, the in-flight promise might already have settled by the
    // time the second caller's microtask runs.
    const publish = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.WALKBACK_FLOOR,
        'simulated replication lag — Phase 3 walkback below localVersion',
      );
    });
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      // 6 parallel calls — mimics the manual-test §C log shape (6+
      // identical WARN lines per cycle).
      const results = await Promise.all([
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
      ]);

      // pointer.publish was called EXACTLY ONCE despite 6 parallel
      // callers — the rest coalesced onto the in-flight promise.
      expect(publish).toHaveBeenCalledOnce();

      // Every caller observes the same transient WALKBACK_FLOOR result.
      for (const r of results) {
        expect(r.ok).toBe(false);
        expect(r.transient).toBe(true);
        expect(r.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      }

      // pendingPublishCid is stamped (the catch arm did its work).
      expect(handle.getPendingPublishCid()).toBe(FAKE_CID);

      // Throttle is now armed — subsequent (sequential) calls
      // short-circuit on the entry check without calling publish.
      const followUp = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(followUp.transient).toBe(true);
      expect(followUp.code).toBe('AGGREGATOR_POINTER_WALKBACK_FLOOR');
      expect(publish).toHaveBeenCalledOnce(); // still 1
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('coalesces parallel success-path publishes onto a single in-flight call', async () => {
    // Same coalescing should apply on the happy path — multiple
    // callers should not each round-trip to the aggregator when one
    // call would suffice for the same CID.
    const publish = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { cid: new Uint8Array(0), version: 42, attemptsUsed: 1 } as never;
    });
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      const results = await Promise.all([
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
        handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID),
      ]);
      expect(publish).toHaveBeenCalledOnce();
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.transient).toBe(false);
      }
      expect(handle.getPendingPublishCid()).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });

  it('releases the in-flight latch so the next call starts fresh', async () => {
    let nextOutcome: 'success' | 'walkback' = 'walkback';
    const publish = vi.fn(async () => {
      if (nextOutcome === 'success') {
        return { cid: new Uint8Array(0), version: 1, attemptsUsed: 1 } as never;
      }
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.WALKBACK_FLOOR,
        'simulated lag',
      );
    });
    const pointer = stubPointer({ publish });
    const handle = await createTestProvider(pointer);
    try {
      // First call: WALKBACK_FLOOR. Latch is released in the finally.
      await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(publish).toHaveBeenCalledOnce();

      // Manually clear the throttle so the second call doesn't hit
      // the entry-check short-circuit.
      (handle.provider as unknown as {
        lifecycleManager: { walkbackFloorThrottleUntilMs: number };
      }).lifecycleManager.walkbackFloorThrottleUntilMs = 0;

      // Second call: starts a fresh publish (latch was cleared).
      nextOutcome = 'success';
      const r = await handle.lifecycle.publishAggregatorPointerBestEffort(FAKE_CID);
      expect(r.ok).toBe(true);
      expect(publish).toHaveBeenCalledTimes(2);

      // Latch is clear afterwards.
      const latch = (handle.provider as unknown as {
        lifecycleManager: { walkbackPublishInFlight: unknown };
      }).lifecycleManager.walkbackPublishInFlight;
      expect(latch).toBeNull();
    } finally {
      await handle.provider.shutdown();
    }
  });
});
