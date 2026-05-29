/**
 * Tests for Item #15 Phase C.2 — debounced dispatch of
 * `notifyProfileDirty` signals to a host-injected
 * `onProfileDirtyFlush` callback.
 *
 * Covers:
 *   1. Single dirty signal → callback fires once after debounce.
 *   2. N dirty signals within the debounce window → callback fires once.
 *   3. A signal arriving DURING an in-flight callback latches a
 *      follow-up flush.
 *   4. Callback exceptions are caught, surfaced via
 *      `storage:error` (code = `PROFILE_DIRTY_FLUSH_FAILED`), and do
 *      NOT propagate.
 *   5. Shutdown cancels armed timers and awaits in-flight callbacks.
 *   6. No callback wired → notifyProfileDirty is a safe no-op.
 *   7. Notifications post-shutdown are ignored.
 *
 * Driven via the host's `notifyProfileDirty()` entry point — which is
 * exactly the path BundleIndex / OutboxWriter / etc. use in production.
 *
 * Uses fake timers throughout (vi.useFakeTimers) so the test file
 * doesn't leak real-timer state into adjacent test files that rely on
 * fake-timer isolation.
 *
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase C
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProfileTokenStorageProvider,
  type ProfileTokenStorageProviderOptions,
} from '../../../profile/profile-token-storage-provider.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../profile/types.js';

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

function buildProvider(opts: Partial<ProfileTokenStorageProviderOptions> = {}): {
  provider: ProfileTokenStorageProvider;
  fire: () => void;
} {
  const provider = new ProfileTokenStorageProvider(
    createMockDb(),
    new Uint8Array(32),
    [],
    {
      config: {
        ipfsApiUrl: 'http://localhost:5001',
        ipnsKeyName: 'phase-c-test',
        flushDebounceMs: 1000,
      },
      addressId: 'DIRECT_aabbcc_ddeeff',
      dirtyFlushDebounceMs: DEBOUNCE_MS,
      ...opts,
    },
  );
  const host = (provider as unknown as { makeHost?: () => unknown }).makeHost?.();
  if (
    !host ||
    typeof (host as { notifyProfileDirty?: unknown }).notifyProfileDirty !== 'function'
  ) {
    throw new Error('Test fixture: makeHost did not expose notifyProfileDirty');
  }
  const fire = (host as { notifyProfileDirty: () => void }).notifyProfileDirty.bind(host);
  return { provider, fire };
}

describe('ProfileTokenStorageProvider — notifyProfileDirty debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the host callback once after a single signal', async () => {
    const onProfileDirtyFlush = vi.fn(async () => {});
    const { fire } = buildProvider({ onProfileDirtyFlush });
    fire();
    expect(onProfileDirtyFlush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
  });

  it('coalesces N rapid signals into a single flush', async () => {
    const onProfileDirtyFlush = vi.fn(async () => {});
    const { fire } = buildProvider({ onProfileDirtyFlush });
    for (let i = 0; i < 50; i++) fire();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
  });

  it('re-arms after a flush completes if a signal arrived mid-flush', async () => {
    let blockResolve: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      blockResolve = resolve;
    });
    const onProfileDirtyFlush = vi.fn(async () => {
      if (onProfileDirtyFlush.mock.calls.length === 1) {
        await blocker;
      }
    });
    const { fire } = buildProvider({ onProfileDirtyFlush });
    fire();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
    // Mid-flush signal — latches.
    fire();
    // Unblock the first flush.
    blockResolve!();
    // Settle the promise + re-arm + second debounce.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    // Microtask drain — the .finally() that re-arms runs at microtask
    // boundary after blocker resolves.
    await vi.runAllTimersAsync();
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(2);
  });

  it('surfaces callback errors via storage:error without propagating', async () => {
    const errors: Array<{ code?: string; error?: unknown }> = [];
    const onProfileDirtyFlush = vi.fn(async () => {
      throw new Error('boom from callback');
    });
    const { provider, fire } = buildProvider({ onProfileDirtyFlush });
    provider.onEvent((event) => {
      if (event.type === 'storage:error') errors.push(event);
    });
    fire();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    // Microtask drain — error path runs inside the awaited callback's
    // .finally block.
    await vi.runAllTimersAsync();
    expect(onProfileDirtyFlush).toHaveBeenCalledTimes(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.code).toBe('PROFILE_DIRTY_FLUSH_FAILED');
  });

  it('shutdown cancels armed timers — pending signal never fires', async () => {
    const onProfileDirtyFlush = vi.fn(async () => {});
    const { provider, fire } = buildProvider({
      onProfileDirtyFlush,
      dirtyFlushDebounceMs: 500,
    });
    fire();
    // Switch to real timers for the await provider.shutdown() — shutdown
    // chains promises, not timers, so fake-timer fakery would deadlock.
    // The cancelDirtyFlushTimer path uses clearTimeout on the fake
    // timer that's still pending.
    vi.useRealTimers();
    await provider.shutdown();
    // Re-enable fake timers, advance past the cancelled debounce.
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onProfileDirtyFlush).not.toHaveBeenCalled();
  });

  it('shutdown waits for an in-flight dirty flush', async () => {
    let resolved = false;
    let resolveFlush: (() => void) | null = null;
    const onProfileDirtyFlush = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveFlush = resolve;
      });
      resolved = true;
    });
    const { provider, fire } = buildProvider({ onProfileDirtyFlush });
    fire();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    // Now the callback is in flight (awaiting the manual gate).
    // Shutdown should observe the dirtyFlushPromise and await it.
    vi.useRealTimers();
    const shutdownDone = provider.shutdown();
    // Release the gate so the callback finishes; shutdown can then settle.
    resolveFlush!();
    await shutdownDone;
    expect(resolved).toBe(true);
  });

  it('signals arriving post-shutdown are ignored', async () => {
    const onProfileDirtyFlush = vi.fn(async () => {});
    const { provider, fire } = buildProvider({ onProfileDirtyFlush });
    vi.useRealTimers();
    await provider.shutdown();
    vi.useFakeTimers();
    fire();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    expect(onProfileDirtyFlush).not.toHaveBeenCalled();
  });

  it('without a host callback, notifyProfileDirty is a safe no-op', async () => {
    const { fire } = buildProvider({});
    expect(() => {
      for (let i = 0; i < 10; i++) fire();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 5);
    // No assertions beyond not-throwing — the only observable surface
    // is the absent callback. The point is that the debounce dispatch
    // gracefully handles the missing-option case.
  });
});
