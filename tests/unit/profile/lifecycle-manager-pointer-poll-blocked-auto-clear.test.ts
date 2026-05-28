/**
 * Issue #319 — pointer-poll auto-clear of transient BLOCKED state.
 *
 * Before #319, when the aggregator pointer publish path exhausted its
 * 5-attempt retry budget against HTTP 5xx, the wallet entered a
 * permanent BLOCKED state with `reason='retry_exhausted'`. Even after
 * the aggregator recovered, every subsequent flush refused with
 * AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED. The only way out was
 * a manual `sphere.profile.recoverLatest()` call.
 *
 * #319 makes the periodic pointer-poll worker self-heal: when
 * `pointer.recoverLatest()` succeeds AND the wallet is BLOCKED with a
 * transient-connectivity reason, the flag is cleared automatically and
 * a `storage:blocked-auto-cleared` event is emitted.
 *
 * Persistent BLOCKED reasons (`aggregator_rejected`, `protocol_error`,
 * `marker_corrupt`, `rejected`) are NEVER auto-cleared — they require
 * explicit operator action per SPEC §10.2.4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

// Polling bounds — must mirror constants in lifecycle-manager.ts.
const POINTER_POLL_MAX_MS = 90_000;

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

function stubPointer(overrides: Partial<ProfilePointerLayer>): ProfilePointerLayer {
  return {
    async recoverLatest() {
      return null;
    },
    async clearBlockedIfTransient() {
      return { cleared: false };
    },
    // Default: not blocked after clear (happy path). Tests that
    // exercise the immediate-reblock suppression override this.
    async isPublishBlocked() {
      return false;
    },
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

function createProvider(opts: {
  db: ProfileDatabase;
  getPointerLayer: () => ProfilePointerLayer | null;
}): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    opts.db,
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: opts.getPointerLayer,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

describe('LifecycleManager.runPointerPollOnce — issue #319 auto-clear', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears BLOCKED and emits storage:blocked-auto-cleared when recoverLatest succeeds and reason was retry_exhausted', async () => {
    const clearBlockedIfTransient = vi.fn(async () => ({
      cleared: true,
      reason: 'retry_exhausted' as const,
    }));
    const recoverLatest = vi.fn(async () => null);
    const pointer = stubPointer({ recoverLatest, clearBlockedIfTransient });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const events: Array<{ type: string; data?: unknown }> = [];
    provider.onEvent((ev) => {
      if (ev.type === 'storage:blocked-auto-cleared') {
        events.push({ type: ev.type, data: ev.data });
      }
    });

    await provider.initialize();
    try {
      // Drain at least one periodic poll tick.
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);

      // The auto-clear was called at least once after recoverLatest
      // succeeded (cold-start runs through the same path).
      expect(clearBlockedIfTransient).toHaveBeenCalled();
      expect(events.length).toBeGreaterThanOrEqual(1);
      const evt = events[0];
      expect(evt.type).toBe('storage:blocked-auto-cleared');
      expect((evt.data as { clearedReason?: string }).clearedReason).toBe('retry_exhausted');
      expect(typeof (evt.data as { clearedAt?: number }).clearedAt).toBe('number');
    } finally {
      await provider.shutdown();
    }
  });

  it.each(['network_timeout', 'dns_failure', 'tls_failure'] as const)(
    'auto-clears transient reason %s when recoverLatest succeeds',
    async (reason) => {
      const clearBlockedIfTransient = vi.fn(async () => ({
        cleared: true,
        reason,
      }));
      const pointer = stubPointer({ clearBlockedIfTransient });
      const provider = createProvider({ db, getPointerLayer: () => pointer });

      const events: Array<{ type: string; data?: unknown }> = [];
      provider.onEvent((ev) => {
        if (ev.type === 'storage:blocked-auto-cleared') {
          events.push({ type: ev.type, data: ev.data });
        }
      });

      await provider.initialize();
      try {
        await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect((events[0].data as { clearedReason?: string }).clearedReason).toBe(reason);
      } finally {
        await provider.shutdown();
      }
    },
  );

  it('does NOT emit storage:blocked-auto-cleared when nothing was cleared', async () => {
    const clearBlockedIfTransient = vi.fn(async () => ({ cleared: false }));
    const pointer = stubPointer({ clearBlockedIfTransient });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const events: Array<{ type: string }> = [];
    provider.onEvent((ev) => {
      if (ev.type === 'storage:blocked-auto-cleared') events.push({ type: ev.type });
    });

    await provider.initialize();
    try {
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
      expect(clearBlockedIfTransient).toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      await provider.shutdown();
    }
  });

  it('does NOT emit storage:blocked-auto-cleared when a persistent reason remains in place', async () => {
    // clearBlockedIfTransient on a persistent reason reports
    // { cleared: false, reason: 'aggregator_rejected' } — the reason
    // surfaces back to the caller but no event fires (UI keeps the
    // banner up; operator must take action).
    const clearBlockedIfTransient = vi.fn(async () => ({
      cleared: false,
      reason: 'aggregator_rejected' as const,
    }));
    const pointer = stubPointer({ clearBlockedIfTransient });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const events: Array<{ type: string }> = [];
    provider.onEvent((ev) => {
      if (ev.type === 'storage:blocked-auto-cleared') events.push({ type: ev.type });
    });

    await provider.initialize();
    try {
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
      expect(events).toHaveLength(0);
    } finally {
      await provider.shutdown();
    }
  });

  it('suppresses storage:blocked-auto-cleared event when the same-tick retry immediately re-blocks the wallet', async () => {
    // Steelman²³: avoid UI flicker. If the post-clear retry trips the
    // wallet back into BLOCKED (e.g., retry hit another transient and
    // exhausted), emitting the auto-cleared event would tell the UI
    // "wallet recovered" only to immediately tell it "wallet blocked"
    // again. Suppress the event in this case.
    const clearBlockedIfTransient = vi.fn(async () => ({
      cleared: true,
      reason: 'retry_exhausted' as const,
    }));
    // After clear, the same-tick retry re-blocks → isPublishBlocked
    // returns true → event is suppressed.
    const isPublishBlocked = vi.fn(async () => true);
    const pointer = stubPointer({ clearBlockedIfTransient, isPublishBlocked });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const events: Array<{ type: string }> = [];
    provider.onEvent((ev) => {
      if (ev.type === 'storage:blocked-auto-cleared') events.push({ type: ev.type });
    });

    await provider.initialize();
    try {
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
      // The clear happened (we logged it internally) but no event
      // was emitted because the wallet was immediately re-blocked.
      expect(clearBlockedIfTransient).toHaveBeenCalled();
      expect(isPublishBlocked).toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      await provider.shutdown();
    }
  });

  it('emits the event when isPublishBlocked throws (defaults to emit — at-least-once observability)', async () => {
    // If we can't query the post-retry BLOCKED state, default to
    // emitting. The alternative — silently dropping the event — would
    // make telemetry less reliable than just over-reporting.
    const clearBlockedIfTransient = vi.fn(async () => ({
      cleared: true,
      reason: 'retry_exhausted' as const,
    }));
    const isPublishBlocked = vi.fn(async () => {
      throw new Error('storage layer unavailable');
    });
    const pointer = stubPointer({ clearBlockedIfTransient, isPublishBlocked });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const events: Array<{ type: string }> = [];
    provider.onEvent((ev) => {
      if (ev.type === 'storage:blocked-auto-cleared') events.push({ type: ev.type });
    });

    await provider.initialize();
    try {
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      await provider.shutdown();
    }
  });

  it('does NOT call clearBlockedIfTransient when recoverLatest throws (no proof of connectivity)', async () => {
    const clearBlockedIfTransient = vi.fn(async () => ({ cleared: false }));
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => {
        throw new Error('network unreachable');
      }),
      clearBlockedIfTransient,
    });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    await provider.initialize();
    try {
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
      // recoverLatest threw, so we never reached the auto-clear branch.
      expect(clearBlockedIfTransient).not.toHaveBeenCalled();
    } finally {
      await provider.shutdown();
    }
  });

  it('re-runs retryPendingPublishIfAny after a successful auto-clear (same-tick recovery)', async () => {
    // Issue #319 efficiency tweak: after clearing BLOCKED inside the
    // poll, re-run the pending-publish retry in the SAME tick so a
    // wallet that was blocked with a pending publish recovers
    // immediately instead of waiting ~60s for the next poll.
    let clearCalls = 0;
    const clearBlockedIfTransient = vi.fn(async () => {
      clearCalls += 1;
      // Report cleared only on the first call within this tick — the
      // post-clear retry shouldn't observe a still-blocked state.
      return clearCalls === 1
        ? { cleared: true, reason: 'retry_exhausted' as const }
        : { cleared: false };
    });
    const pointer = stubPointer({ clearBlockedIfTransient });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    // Spy on the lifecycle's retryPendingPublishIfAny so we can count
    // invocations across the tick.
    const lifecycleAny = (provider as unknown as { lifecycleManager: unknown })
      .lifecycleManager as {
      retryPendingPublishIfAny: () => Promise<{
        attempted: boolean;
        ok: boolean;
        transient: boolean;
        code?: string;
      }>;
    };
    const originalRetry = lifecycleAny.retryPendingPublishIfAny.bind(lifecycleAny);
    const retrySpy = vi.fn(originalRetry);
    lifecycleAny.retryPendingPublishIfAny = retrySpy;

    await provider.initialize();
    try {
      await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
      // Expected: one pre-recoverLatest call PLUS one post-clear call
      // per poll tick where clearing happened. Cold-start path may add
      // additional calls; we just assert the total is >= 2 (the post-
      // clear re-run did fire).
      expect(retrySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await provider.shutdown();
    }
  });
});
