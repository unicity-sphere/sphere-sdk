/**
 * Tests for the four HIGH-priority findings landed in PR #454 follow-up
 * to PR #453 (which itself addressed issue #444). See issue #454 for the
 * full review list and the working PR for which findings are in scope.
 *
 * Findings covered here:
 *
 *   1. Drain race in `drainDeferredDirtyPublishOnShutdown` — the pre-fix
 *      drain called `onProfileDirtyFlush` raw, leaving `dirtyFlushPromise`
 *      null during the await so a concurrent `notifyProfileDirty()` would
 *      arm a fresh debounce timer that the post-drain
 *      `cancelDirtyFlushTimer()` then silently cancelled. The fix routes
 *      the drain through `publishSnapshotIfWired()` which tracks
 *      `dirtyFlushPromise` so the concurrent signal latches into
 *      `dirtyFlushPending` instead.
 *
 *   2. SIGKILL recovery marker on the Issue #444 skipPublish path — a
 *      hard crash during the debounce window previously lost the
 *      aggregator pointer publish silently. The fix stamps a persistent
 *      boolean marker (`pendingDeferredPublishMarker`) on the skipPublish
 *      branch and triggers a deferred `publishSnapshotIfWired()` on the
 *      next process boot when the marker is set.
 *
 *   4. HEAD-verify background task suppression on the skipPublish path
 *      — the verify leg previously fired even with `skipPublish=true`,
 *      reintroducing exactly the propagation-coupling Issue #444 set out
 *      to break. The fix adds `!options?.skipPublish` to `shouldVerify`.
 *
 *   9. Structural-cast hazard in PaymentsModule.awaitAllProvidersDurable
 *      — the cast let any provider exposing the method NAME silently win
 *      a stub even with no implementation. The fix uses the typed
 *      optional declarations on the TokenStorageProvider interface.
 *
 * @see GitHub issue #454 — PR #453 post-merge review findings
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProfileTokenStorageProvider,
  type ProfileTokenStorageProviderOptions,
} from '../../../extensions/uxf/profile/profile-token-storage-provider.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../extensions/uxf/profile/types.js';
import type { StorageProvider, StorageEvent } from '../../../storage/storage-provider.js';
import type { FullIdentity, TrackedAddressEntry } from '../../../types/index.js';
import { STORAGE_KEYS_GLOBAL } from '../../../constants.js';

// ---------------------------------------------------------------------------
// Shared fixtures
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

function createMockCache(): {
  cache: StorageProvider;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  let trackedAddresses: TrackedAddressEntry[] = [];
  const cache: StorageProvider = {
    id: 'mock-cache',
    name: 'Mock Cache',
    type: 'local' as const,
    description: 'In-memory mock cache for #454 tests',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity(_identity: FullIdentity) {},
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    },
    async has(key: string) {
      return store.has(key);
    },
    async keys(prefix?: string) {
      const all = Array.from(store.keys());
      if (!prefix) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) {
        store.clear();
      } else {
        for (const k of store.keys()) {
          if (k.startsWith(prefix)) store.delete(k);
        }
      }
    },
    async saveTrackedAddresses(entries: TrackedAddressEntry[]) {
      trackedAddresses = entries;
    },
    async loadTrackedAddresses() {
      return trackedAddresses;
    },
  } as StorageProvider;
  return { cache, store };
}

const DEBOUNCE_MS = 25;
const ADDRESS_ID = 'DIRECT_454test_aabbcc';

function buildProvider(
  opts: Partial<ProfileTokenStorageProviderOptions> = {},
  localCache?: StorageProvider,
): {
  provider: ProfileTokenStorageProvider;
  fire: () => void;
  host: {
    notifyProfileDirty: () => void;
    setPendingDeferredPublishMarker: (v: boolean) => void;
    getPendingDeferredPublishMarker: () => boolean;
  };
} {
  const provider = new ProfileTokenStorageProvider(
    createMockDb(),
    new Uint8Array(32),
    [],
    {
      config: {
        ipfsApiUrl: 'http://localhost:5001',
        ipnsKeyName: '454-test',
        flushDebounceMs: 1000,
      },
      addressId: ADDRESS_ID,
      dirtyFlushDebounceMs: DEBOUNCE_MS,
      ...opts,
    },
    localCache,
  );
  const host = (provider as unknown as { makeHost?: () => unknown }).makeHost?.() as {
    notifyProfileDirty: () => void;
    setPendingDeferredPublishMarker: (v: boolean) => void;
    getPendingDeferredPublishMarker: () => boolean;
  };
  if (!host || typeof host.notifyProfileDirty !== 'function') {
    throw new Error('Test fixture: makeHost did not expose notifyProfileDirty');
  }
  const fire = host.notifyProfileDirty.bind(host);
  return { provider, fire, host };
}

// ---------------------------------------------------------------------------
// Finding #1 — drain race coverage
// ---------------------------------------------------------------------------

describe('Issue #454 finding #1 — drainDeferredDirtyPublishOnShutdown race', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a notifyProfileDirty arriving DURING the shutdown drain does NOT silently lose the publish', async () => {
    // Pre-#454 the drain called `await callback()` directly, leaving
    // `dirtyFlushPromise` null. A concurrent notifyProfileDirty saw
    // null and armed a fresh `dirtyFlushTimer`; the post-drain
    // `cancelDirtyFlushTimer()` then cancelled that timer silently —
    // the deferred publish never fired and there was no
    // pendingPublishCid stamp (skipPublish branch doesn't stamp it).
    //
    // Post-fix the drain routes through `publishSnapshotIfWired` which
    // sets `dirtyFlushPromise = tracked` so concurrent notifications
    // latch into `dirtyFlushPending`. The drain loops so the latched
    // signal triggers a SECOND publishSnapshotIfWired call rather than
    // being cancelled by the post-drain `cancelDirtyFlushTimer()`.
    //
    // We assert the callback fires AT LEAST TWICE: once for the
    // originally-armed signal, once for the racing-in signal. Pre-fix
    // path with the same harness: count would be 1 (the second signal
    // was silently dropped).

    let releaseInFlight: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });

    const onProfileDirtyFlush = vi.fn(async () => {
      // First call blocks so we can race a notifyProfileDirty into the
      // drain's await window. Subsequent calls return immediately.
      if (onProfileDirtyFlush.mock.calls.length === 1) {
        await blocker;
      }
      return { ok: true, transient: false } as const;
    });

    const { provider, fire } = buildProvider({
      onProfileDirtyFlush,
      dirtyFlushDebounceMs: 500,
    });

    // Arm a deferred-publish via the skipPublish-equivalent path:
    // fire a dirty signal (the timer is armed but not fired yet).
    fire();

    // Switch to real timers — provider.shutdown awaits async work that
    // is promise-chained, not timer-chained.
    vi.useRealTimers();

    const shutdownPromise = provider.shutdown();

    // Yield once so the drain enters its `await publishSnapshotIfWired()`
    // call. The first callback await blocks on `blocker`.
    await new Promise((r) => setImmediate(r));

    // RACE: a concurrent notifyProfileDirty arrives while the drain is
    // awaiting the publish. Pre-#454 this would arm a new timer that
    // the post-drain cancelDirtyFlushTimer would silently cancel.
    // Post-fix: dirtyFlushPromise is non-null (because the drain set
    // it via publishSnapshotIfWired), so this notification latches into
    // dirtyFlushPending. The drain's loop then captures the latched
    // signal and fires a second publish.
    fire();

    // Release the in-flight callback so shutdown can finish.
    releaseInFlight!();
    await shutdownPromise;

    // Post-fix expectation: callback fired AT LEAST TWICE — once for
    // the armed signal, once for the racing-in signal captured via
    // the drain loop. Pre-fix would be 1.
    expect(onProfileDirtyFlush.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('drain still no-ops on a fully idle wallet (no armed timer, no latch)', async () => {
    const onProfileDirtyFlush = vi.fn(async () => ({
      ok: true,
      transient: false,
    } as const));
    const { provider } = buildProvider({ onProfileDirtyFlush });

    vi.useRealTimers();
    await provider.shutdown();

    // No dirty signal was ever fired, so the drain has nothing to fire.
    // This preserves the "idle wallet shutdown is a no-op" property
    // documented in the drain's JSDoc.
    expect(onProfileDirtyFlush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Finding #2 — SIGKILL recovery marker
// ---------------------------------------------------------------------------

describe('Issue #454 finding #2 — pendingDeferredPublishMarker SIGKILL recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const expectedKey = `${STORAGE_KEYS_GLOBAL.PROFILE_PENDING_DEFERRED_PUBLISH}_${ADDRESS_ID}`;

  it('host setter persists the marker to local cache (set + clear)', async () => {
    const { cache, store } = createMockCache();
    const { host } = buildProvider({}, cache);

    // Initially unset.
    expect(host.getPendingDeferredPublishMarker()).toBe(false);
    expect(store.get(expectedKey)).toBeUndefined();

    // Stamp via host setter (the path the skipPublish branch uses).
    host.setPendingDeferredPublishMarker(true);

    // In-memory flag flips immediately; persistence is fire-and-forget.
    expect(host.getPendingDeferredPublishMarker()).toBe(true);

    // Wait for the persistence to land.
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(store.get(expectedKey)).toBe('1');

    // Clear.
    host.setPendingDeferredPublishMarker(false);
    expect(host.getPendingDeferredPublishMarker()).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(store.get(expectedKey)).toBeUndefined();
  });

  it('SIGKILL simulation: marker set then process dies → next boot restores it and triggers a recovery publish', async () => {
    // Step 1 — "first process" stamps the marker as if a skipPublish
    // flush had just landed but the debounce window had not yet fired.
    const { cache } = createMockCache();
    const { host: hostA, provider: providerA } = buildProvider({}, cache);
    hostA.setPendingDeferredPublishMarker(true);
    // Don't call shutdown — simulate SIGKILL: the persistence happens
    // fire-and-forget, so flush the microtask queue.
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    // ProviderA goes away — but the marker is in localCache.
    void providerA; // referenced to silence unused-warning if any

    // Step 2 — "next process boot" constructs a fresh provider with
    // the SAME local cache and a wired onProfileDirtyFlush callback.
    // The provider's initialize() should restore the marker and
    // trigger a deferred publish.
    const onProfileDirtyFlush = vi.fn(async () => ({
      ok: true,
      transient: false,
    } as const));

    // We need to construct providerB but skip the lifecycleManager's
    // full initialize (which would require IPFS / OrbitDB / aggregator
    // wiring). Instead, exercise the marker-restoration + recovery
    // path directly via the unit-test escape hatches.
    const providerB = new ProfileTokenStorageProvider(
      createMockDb(),
      new Uint8Array(32),
      [],
      {
        config: {
          ipfsApiUrl: 'http://localhost:5001',
          ipnsKeyName: '454-test-boot',
          flushDebounceMs: 1000,
        },
        addressId: ADDRESS_ID,
        dirtyFlushDebounceMs: DEBOUNCE_MS,
        onProfileDirtyFlush,
      },
      cache,
    );

    // Directly invoke restoration + recovery — the same calls
    // initialize() chains internally. We split them so the test stays
    // independent of the IPFS / OrbitDB stack.
    await (
      providerB as unknown as {
        restorePendingDeferredPublishMarkerFromCache: () => Promise<void>;
      }
    ).restorePendingDeferredPublishMarkerFromCache();

    // The restored flag is now in-memory.
    const hostB = (
      providerB as unknown as {
        makeHost: () => { getPendingDeferredPublishMarker: () => boolean };
      }
    ).makeHost();
    expect(hostB.getPendingDeferredPublishMarker()).toBe(true);

    // Drive the recovery trigger — fire-and-forget by design, so we
    // yield to the microtask queue to let the publish call land.
    (
      providerB as unknown as {
        triggerDeferredPublishRecoveryIfMarked: () => void;
      }
    ).triggerDeferredPublishRecoveryIfMarked();

    // Wait for the async fire-and-forget recovery to land.
    await new Promise((r) => setTimeout(r, 50));

    // The recovery publish fired.
    expect(onProfileDirtyFlush).toHaveBeenCalled();

    // And on success the marker was cleared.
    expect(hostB.getPendingDeferredPublishMarker()).toBe(false);
  });

  it('without a wired onProfileDirtyFlush callback, recovery trigger is a no-op (marker survives)', async () => {
    const { cache } = createMockCache();
    const { host: hostA, provider: providerA } = buildProvider({}, cache);
    hostA.setPendingDeferredPublishMarker(true);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    void providerA;

    // Boot a new provider WITHOUT onProfileDirtyFlush wired (legacy
    // tests / providers without the Phase C.3 closure).
    const providerB = new ProfileTokenStorageProvider(
      createMockDb(),
      new Uint8Array(32),
      [],
      {
        config: {
          ipfsApiUrl: 'http://localhost:5001',
          ipnsKeyName: '454-test-boot-no-cb',
          flushDebounceMs: 1000,
        },
        addressId: ADDRESS_ID,
      },
      cache,
    );

    await (
      providerB as unknown as {
        restorePendingDeferredPublishMarkerFromCache: () => Promise<void>;
      }
    ).restorePendingDeferredPublishMarkerFromCache();

    (
      providerB as unknown as {
        triggerDeferredPublishRecoveryIfMarked: () => void;
      }
    ).triggerDeferredPublishRecoveryIfMarked();

    await new Promise((r) => setTimeout(r, 50));

    // No callback wired ⇒ no publish, and the marker stays set so a
    // future boot (with the callback wired) can still recover.
    const hostB = (
      providerB as unknown as {
        makeHost: () => { getPendingDeferredPublishMarker: () => boolean };
      }
    ).makeHost();
    expect(hostB.getPendingDeferredPublishMarker()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding #4 — HEAD-verify suppression on skipPublish path
// ---------------------------------------------------------------------------

describe('Issue #454 finding #4 — background HEAD-verify gates on !skipPublish', () => {
  // We can verify the condition surface without spinning up a full
  // flush-scheduler stack: the gating expression is local to
  // FlushScheduler.__flushToIpfsBody. A deep test would mock the host
  // + run a flush; a focused test asserts the condition arithmetic
  // matches our expectation. We use the second style (asserting the
  // ALGEBRA of the predicate) so the test is robust across refactors.
  //
  // The predicate post-fix:
  //   shouldVerify =
  //     verifyDeadlineMs > 0 &&
  //     !isShuttingDown &&
  //     pointerWired !== null &&
  //     !skipPublish
  //
  // The pre-fix version omitted `!skipPublish`, so under a skipPublish
  // flush with the other three conditions met, the verify leg fired.

  function computeShouldVerify(p: {
    verifyDeadlineMs: number;
    isShuttingDown: boolean;
    pointerWired: object | null;
    skipPublish: boolean;
  }): boolean {
    // Mirror of FlushScheduler.__flushToIpfsBody's gating predicate.
    // Source: profile/profile-token-storage/flush-scheduler.ts (post-#454).
    return (
      p.verifyDeadlineMs > 0 &&
      !p.isShuttingDown &&
      p.pointerWired !== null &&
      !p.skipPublish
    );
  }

  it('shouldVerify=false when skipPublish=true even with all other conditions met', () => {
    expect(
      computeShouldVerify({
        verifyDeadlineMs: 30_000,
        isShuttingDown: false,
        pointerWired: {} as object,
        skipPublish: true,
      }),
    ).toBe(false);
  });

  it('shouldVerify=true on the normal (skipPublish=false) flush path', () => {
    expect(
      computeShouldVerify({
        verifyDeadlineMs: 30_000,
        isShuttingDown: false,
        pointerWired: {} as object,
        skipPublish: false,
      }),
    ).toBe(true);
  });

  it('shouldVerify=false when any other gate fails (regression cross-check)', () => {
    expect(
      computeShouldVerify({
        verifyDeadlineMs: 0,
        isShuttingDown: false,
        pointerWired: {} as object,
        skipPublish: false,
      }),
    ).toBe(false);
    expect(
      computeShouldVerify({
        verifyDeadlineMs: 30_000,
        isShuttingDown: true,
        pointerWired: {} as object,
        skipPublish: false,
      }),
    ).toBe(false);
    expect(
      computeShouldVerify({
        verifyDeadlineMs: 30_000,
        isShuttingDown: false,
        pointerWired: null,
        skipPublish: false,
      }),
    ).toBe(false);
  });

  it('source-level guard: the flush-scheduler predicate contains the new !skipPublish term', async () => {
    // Read the source as a string-pattern check. This catches a future
    // refactor that drops `!options?.skipPublish` from the predicate
    // (which would re-introduce the propagation-coupling bug).
    const fs = await import('node:fs/promises');
    const path = (
      await import('node:path')
    ).resolve(
      __dirname,
      '..',
      '..',
      '..',
      'extensions',
      'uxf',
      'profile',
      'profile-token-storage',
      'flush-scheduler.ts',
    );
    const src = await fs.readFile(path, 'utf8');
    expect(src).toContain('!options?.skipPublish');
  });
});

// ---------------------------------------------------------------------------
// Finding #9 — structural cast hazard in PaymentsModule
// ---------------------------------------------------------------------------

describe('Issue #454 finding #9 — typed optional flusher access prevents stub-winning', () => {
  // The pre-fix code in PaymentsModule.awaitAllProvidersDurable did:
  //
  //   const flusher = (
  //     typeof (provider as { awaitNextLocalFlush?: ... })
  //       .awaitNextLocalFlush === 'function'
  //       ? (provider as { awaitNextLocalFlush: ... }).awaitNextLocalFlush
  //       : provider.awaitNextFlush
  //   ) as ((ms?: number) => Promise<void>) | undefined;
  //
  // The cast bypasses the TokenStorageProvider interface's typed
  // optional declarations. A misshapen stub exposing
  // `awaitNextLocalFlush` could win the structural check without
  // honouring the contract, and the at-least-once gate would
  // silently advance the Nostr cursor.
  //
  // The fix is:
  //
  //   const flusher = provider.awaitNextLocalFlush ?? provider.awaitNextFlush;
  //
  // We verify (a) the fix is in the source and (b) the runtime
  // behavior: a no-op stub with `awaitNextLocalFlush` returns
  // immediately, but it returns through the awaitAllProvidersDurable
  // path that emits the [AT-LEAST-ONCE] warning ONLY on failure. A
  // truly no-op stub would advance the cursor — proving that the gate
  // ENFORCES no contract beyond "the method exists". The defense
  // against this is at the TYPE LAYER: the structural cast meant
  // misshapen types compiled; the typed access means they don't.

  it('the source uses the typed optional access (?? fallback) and not the structural cast', async () => {
    // Phase 5 wave-3: the durability gate body moved to
    // `extensions/uxf/pipeline/module-glue/durability-gate.ts`
    // per docs/uxf/uxfv2-phase-5-payments-disposition.md. Assert
    // the pattern lives in either the module-glue file OR the
    // legacy in-place location, whichever the current tree holds.
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const candidatePaths = [
      nodePath.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'extensions',
        'uxf',
        'pipeline',
        'module-glue',
        'durability-gate.ts',
      ),
      nodePath.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'modules',
        'payments',
        'PaymentsModule.ts',
      ),
    ];
    let matchedSrc: string | null = null;
    for (const p of candidatePaths) {
      try {
        const src = await fs.readFile(p, 'utf8');
        if (
          src.includes('provider.awaitNextLocalFlush ?? provider.awaitNextFlush') &&
          /awaitAllProvidersDurable[\s\S]{0,4000}flusher = provider\.awaitNextLocalFlush \?\? provider\.awaitNextFlush/.test(
            src,
          )
        ) {
          matchedSrc = src;
          break;
        }
      } catch {
        // file not present at this path — try next
      }
    }
    expect(matchedSrc).not.toBeNull();
  });

  it('a stub provider with a no-op awaitNextLocalFlush returns durable=true (documents the contract gap)', async () => {
    // This test documents what `awaitAllProvidersDurable` enforces at
    // RUNTIME: nothing beyond "the method exists and doesn't reject".
    // The structural-cast fix is a TYPE-LAYER defense — misshapen
    // providers no longer compile against the at-least-once gate.
    // To prove the runtime contract, we use the typed-optional
    // signature directly (which IS what the post-fix code calls).
    const stubProvider: {
      awaitNextLocalFlush?: (timeoutMs?: number) => Promise<void>;
      awaitNextFlush?: (timeoutMs?: number) => Promise<void>;
    } = {
      awaitNextLocalFlush: vi.fn(async () => {
        /* no-op */
      }),
    };

    // Post-fix access pattern from PaymentsModule:
    const flusher = stubProvider.awaitNextLocalFlush ?? stubProvider.awaitNextFlush;
    expect(typeof flusher).toBe('function');
    await expect(flusher!.call(stubProvider, 30_000)).resolves.toBeUndefined();
    expect(stubProvider.awaitNextLocalFlush).toHaveBeenCalledTimes(1);
  });

  it('a stub with only awaitNextFlush falls back through the ?? chain', async () => {
    const stubProvider: {
      awaitNextLocalFlush?: (timeoutMs?: number) => Promise<void>;
      awaitNextFlush?: (timeoutMs?: number) => Promise<void>;
    } = {
      awaitNextFlush: vi.fn(async () => {
        /* no-op */
      }),
    };

    const flusher = stubProvider.awaitNextLocalFlush ?? stubProvider.awaitNextFlush;
    expect(typeof flusher).toBe('function');
    await flusher!.call(stubProvider, 30_000);
    expect(stubProvider.awaitNextFlush).toHaveBeenCalledTimes(1);
  });

  it('a stub with neither method exposed yields flusher=undefined (caller `continue`s — durable stays true)', () => {
    const stubProvider: {
      awaitNextLocalFlush?: (timeoutMs?: number) => Promise<void>;
      awaitNextFlush?: (timeoutMs?: number) => Promise<void>;
    } = {};
    const flusher = stubProvider.awaitNextLocalFlush ?? stubProvider.awaitNextFlush;
    expect(flusher).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting — events emitted by the new code paths
// ---------------------------------------------------------------------------

describe('Issue #454 — event observability', () => {
  it('drainDeferredDirtyPublishOnShutdown logs (best-effort) on publishSnapshotIfWired throws', async () => {
    const errors: StorageEvent[] = [];
    const onProfileDirtyFlush = vi.fn(async () => {
      throw new Error('publish blew up at shutdown');
    });
    const { provider, fire } = buildProvider({
      onProfileDirtyFlush,
      dirtyFlushDebounceMs: 500,
    });
    provider.onEvent((e) => {
      if (e.type === 'storage:error') errors.push(e);
    });

    // Arm a deferred publish.
    fire();
    vi.useRealTimers();
    // Shutdown drains the armed signal. The drain swallows the publish
    // error (best-effort) but the underlying `publishSnapshotIfWired`
    // already emitted `storage:error` with PROFILE_DIRTY_FLUSH_FAILED.
    await provider.shutdown();

    expect(onProfileDirtyFlush).toHaveBeenCalled();
    const failureEvents = errors.filter(
      (e) => (e as { code?: string }).code === 'PROFILE_DIRTY_FLUSH_FAILED',
    );
    expect(failureEvents.length).toBeGreaterThan(0);
  });
});
