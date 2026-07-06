/**
 * Tests for Item #15 Phase D.1b — `ProfileTokenStorageProvider.
 * publishSnapshotIfWired()`, the synchronous fire path used by
 * `FlushScheduler.flushToIpfs()` to publish the LEAN PROFILE
 * SNAPSHOT CID via the aggregator pointer layer (in place of the
 * legacy bundle-CID publish path which D.1b removes).
 *
 * Direct surface coverage:
 *   - returns null when no `onProfileDirtyFlush` callback is wired
 *     (no legacy bundle-CID fallback — caller skips publish).
 *   - invokes the wired callback synchronously and returns its
 *     structured `ProfileSnapshotPublishResult`.
 *   - normalises a `void` callback return to
 *     `{ ok: true, transient: false }` (back-compat for the legacy
 *     `() => Promise<void>` shape).
 *   - re-throws on callback throw AND emits `storage:error` with
 *     code `PROFILE_DIRTY_FLUSH_FAILED`.
 *   - cancels an armed dirty-flush debounce timer so the debouncer
 *     does NOT double-fire for the same writer-side mutations
 *     covered by our synchronous run.
 *   - returns null when called post-shutdown (no-op gate).
 *   - re-arms the debounce when a `notifyProfileDirty()` signal
 *     arrives DURING our synchronous fire (no signal loss).
 *
 * The end-to-end "FlushScheduler.flushToIpfs publishes a snapshot
 * CID" path is exercised by the existing
 * `profile-token-storage-flush-serialization.test.ts`,
 * `pointer-monotonicity.test.ts`, and `profile-token-storage-
 * pointer.test.ts` suites — those continue to pass after D.1b
 * (publish step replaced by `publishSnapshotIfWired()` returning
 * null when no callback is wired, preserving the previous
 * "no-op publish" effective behaviour).
 *
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase D.1b
 * @see profile/profile-token-storage/flush-scheduler.ts — flushToIpfs step 9
 * @see profile/profile-token-storage-provider.ts — publishSnapshotIfWired
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProfileTokenStorageProvider,
  type ProfileTokenStorageProviderOptions,
} from '../../../extensions/uxf/profile/profile-token-storage-provider.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
  ProfileSnapshotPublishResult,
} from '../../../extensions/uxf/profile/types.js';
import type { StorageEvent } from '../../../storage/storage-provider.js';

// ---------------------------------------------------------------------------
// Mock OrbitDB
// ---------------------------------------------------------------------------

function createMockDb(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  return {
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
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

const DEBOUNCE_MS = 25;

function buildProvider(
  opts: Partial<ProfileTokenStorageProviderOptions> = {},
): ProfileTokenStorageProvider {
  return new ProfileTokenStorageProvider(
    createMockDb(),
    new Uint8Array(32),
    [],
    {
      config: {
        ipfsApiUrl: 'http://localhost:5001',
        ipnsKeyName: 'phase-d1b-test',
        flushDebounceMs: 1000,
      },
      addressId: 'DIRECT_aabbcc_ddeeff',
      dirtyFlushDebounceMs: DEBOUNCE_MS,
      ...opts,
    },
  );
}

function fire(provider: ProfileTokenStorageProvider): void {
  const host = (provider as unknown as { makeHost?: () => unknown }).makeHost?.();
  (host as { notifyProfileDirty: () => void }).notifyProfileDirty.bind(host)();
}

// ===========================================================================
// publishSnapshotIfWired — direct surface tests
// ===========================================================================

describe('ProfileTokenStorageProvider.publishSnapshotIfWired — bail paths', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no onProfileDirtyFlush callback is wired', async () => {
    const provider = buildProvider();
    const result = await provider.publishSnapshotIfWired();
    expect(result).toBeNull();
  });

  it('returns null when called after shutdown', async () => {
    const onProfileDirtyFlush = vi.fn(async () => undefined);
    const provider = buildProvider({ onProfileDirtyFlush });
    await provider.shutdown();
    const got = await provider.publishSnapshotIfWired();
    expect(got).toBeNull();
    expect(onProfileDirtyFlush).not.toHaveBeenCalled();
  });
});

describe('ProfileTokenStorageProvider.publishSnapshotIfWired — happy path', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes the callback and returns its structured result', async () => {
    const result: ProfileSnapshotPublishResult = { ok: true, transient: false };
    const onProfileDirtyFlush = vi.fn(async () => result);
    const provider = buildProvider({ onProfileDirtyFlush });
    const got = await provider.publishSnapshotIfWired();
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
    expect(got).toEqual(result);
  });

  it('normalises a void callback return to { ok: true, transient: false }', async () => {
    const onProfileDirtyFlush = vi.fn(async () => {});
    const provider = buildProvider({ onProfileDirtyFlush });
    const got = await provider.publishSnapshotIfWired();
    expect(got).toEqual({ ok: true, transient: false });
  });

  it('propagates a permanent failure result (ok:false, transient:false) without throwing', async () => {
    const result: ProfileSnapshotPublishResult = {
      ok: false,
      transient: false,
      code: 'AGGREGATOR_POINTER_REJECTED',
    };
    const onProfileDirtyFlush = vi.fn(async () => result);
    const provider = buildProvider({ onProfileDirtyFlush });
    const got = await provider.publishSnapshotIfWired();
    expect(got).toEqual(result);
    // Callers (FlushScheduler) treat this as "publish failed but no
    // retry would help" — storage:saved still fires, no throw.
  });

  it('returns a transient failure result intact without throwing (issue #241 — gate rides on pin durability)', async () => {
    // Issue #241: prior to the decoupling, runProfileDirtyFlush threw on
    // transient results so the at-least-once gate stayed closed. Now the
    // factory returns the structured result; the upstream FlushScheduler
    // emits `storage:pending-publish` and the gate advances based on the
    // bundle CAR's IPFS pin durability (verifyFlushDurability) — which
    // IS the cross-device recoverability invariant.
    const result: ProfileSnapshotPublishResult = {
      ok: false,
      transient: true,
      code: 'AGGREGATOR_POINTER_WALKBACK_FLOOR',
    };
    const onProfileDirtyFlush = vi.fn(async () => result);
    const provider = buildProvider({ onProfileDirtyFlush });
    const errors: StorageEvent[] = [];
    provider.onEvent((event) => {
      if (event.type === 'storage:error') errors.push(event);
    });
    const got = await provider.publishSnapshotIfWired();
    expect(got).toEqual(result);
    // No terminal error event for a transient publish — the soft
    // `storage:pending-publish` is emitted at the FlushScheduler layer
    // (see profile/profile-token-storage/flush-scheduler.ts).
    expect(errors).toHaveLength(0);
  });
});

describe('ProfileTokenStorageProvider.publishSnapshotIfWired — error propagation', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-throws on callback throw AND emits storage:error PROFILE_DIRTY_FLUSH_FAILED', async () => {
    const errors: StorageEvent[] = [];
    const onProfileDirtyFlush = vi.fn(async () => {
      throw new Error('callback exploded');
    });
    const provider = buildProvider({ onProfileDirtyFlush });
    provider.onEvent((event) => {
      if (event.type === 'storage:error') errors.push(event);
    });
    await expect(provider.publishSnapshotIfWired()).rejects.toThrow(
      'callback exploded',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('PROFILE_DIRTY_FLUSH_FAILED');
  });

  it('re-throws when the callback itself throws (programmer error / snapshot build failure)', async () => {
    // Issue #241: `runProfileDirtyFlush` no longer throws on a
    // transient publishCid result — it returns the structured result
    // intact (so FlushScheduler can emit `storage:pending-publish`
    // instead of closing the at-least-once gate). This test stays as
    // a contract guard for OTHER throw classes: a callback that
    // throws (programmer error, snapshot build failure, etc.) MUST
    // still propagate through `publishSnapshotIfWired` unchanged.
    const onProfileDirtyFlush = vi.fn(async () => {
      throw new Error(
        'snapshot build failed: simulated programmer error',
      );
    });
    const provider = buildProvider({ onProfileDirtyFlush });
    await expect(provider.publishSnapshotIfWired()).rejects.toThrow(
      /snapshot build failed/,
    );
  });
});

describe('ProfileTokenStorageProvider.publishSnapshotIfWired — debouncer coordination', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels an armed debounce timer so the debouncer does not double-fire', async () => {
    const onProfileDirtyFlush = vi.fn(async () => undefined);
    const provider = buildProvider({ onProfileDirtyFlush });
    // Arm the debouncer.
    fire(provider);
    // The timer is armed; debouncer hasn't fired yet.
    expect(onProfileDirtyFlush).not.toHaveBeenCalled();
    // Synchronous fire — should cancel the debounce.
    await provider.publishSnapshotIfWired();
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
    // Advance past the original debounce window — the cancelled
    // timer must not fire.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    await vi.runAllTimersAsync();
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
  });

  it('re-arms the debounce when a signal arrives DURING our synchronous fire', async () => {
    let resolveFire: (() => void) | null = null;
    const onProfileDirtyFlush = vi.fn(async () => {
      if (onProfileDirtyFlush.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFire = resolve;
        });
      }
    });
    const provider = buildProvider({ onProfileDirtyFlush });
    // Synchronously fire — will block on the blocker.
    const inflight = provider.publishSnapshotIfWired();
    // Yield once so the callback starts executing and reaches the
    // blocker await (await callback() entered).
    await Promise.resolve();
    await Promise.resolve();
    // While in-flight, schedule a follow-up signal — should latch
    // dirtyFlushPending (because our run owns dirtyFlushPromise).
    fire(provider);
    // Unblock the in-flight fire.
    resolveFire!();
    await inflight;
    // After settling, the re-arm path inside our `finally` should have
    // scheduled a fresh debounce timer. Advance past it.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    await vi.runAllTimersAsync();
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent publishSnapshotIfWired calls (second awaits first)', async () => {
    let resolveFirst: (() => void) | null = null;
    const onProfileDirtyFlush = vi.fn(async () => {
      if (onProfileDirtyFlush.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
    });
    const provider = buildProvider({ onProfileDirtyFlush });
    // First call — blocks.
    const first = provider.publishSnapshotIfWired();
    // Yield so the first call enters callback().
    await Promise.resolve();
    await Promise.resolve();
    // Second call concurrent with first — must drain the in-flight
    // promise before firing its own callback.
    const second = provider.publishSnapshotIfWired();
    // Unblock first.
    resolveFirst!();
    await first;
    await second;
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(2);
  });
});
