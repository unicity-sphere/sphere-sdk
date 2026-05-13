/**
 * Tests for the periodic Path 2 (aggregator-pointer) poll inside
 * LifecycleManager.
 *
 * Path 1 — OrbitDB pubsub (libp2p gossipsub) — is live and peer-to-peer.
 * Path 2 — aggregator pointer + IPFS — is used at cold-start by
 * `recoverFromAggregatorPointerBestEffort()` but historically was never
 * re-polled afterwards. The periodic poll added by this commit closes
 * that gap: when libp2p pubsub fails (NAT, firewall, peer not
 * discovered), two devices online with the same wallet would diverge
 * for hours; the poll re-checks the aggregator pointer at a randomised
 * interval in [30 s, 90 s) and adds any newly-discovered CID to the
 * bundle index.
 *
 * Coverage targets:
 *   - Random interval falls within [30s, 90s).
 *   - `recoverLatest()` returns null → re-arms without adding a bundle.
 *   - `recoverLatest()` returns a CID already in `knownBundleCids` →
 *     re-arms without adding a bundle (no redundant OrbitDB write).
 *   - `recoverLatest()` returns a NEW CID → bundleIndex.addBundle is
 *     called with that CID, then re-arms.
 *   - `shutdown()` stops the timer (no further `recoverLatest()` calls
 *     after shutdown completes).
 *   - Permanent-error handling — classified errors trigger a 5x
 *     back-off on the next-tick interval.
 *
 * The pointer is a minimal stub with only `recoverLatest()` because
 * that is the sole method the poll touches. The bundle index is the
 * real `BundleIndex` running over a mock `ProfileDatabase`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createDigest } from 'multiformats/hashes/digest';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

// Polling bounds — must mirror constants in lifecycle-manager.ts.
const POINTER_POLL_MIN_MS = 30_000;
const POINTER_POLL_MAX_MS = 90_000; // exclusive upper bound

function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

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
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

function createProvider(opts: {
  db: ProfileDatabase;
  getPointerLayer?: () => ProfilePointerLayer | null;
  getPointerBuildStatus?: () => 'pending' | 'unavailable' | 'ready';
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
      getPointerBuildStatus: opts.getPointerBuildStatus,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

/**
 * Helper: reach into the provider to access the LifecycleManager and
 * its private `pointerPollTimer` field. Tests need this to assert the
 * timer is alive after initialize() and cleared after shutdown().
 */
function getLifecycle(
  provider: ProfileTokenStorageProvider,
): {
  pointerPollTimer: ReturnType<typeof setTimeout> | null;
  samplePointerPollIntervalMs(): number;
} {
  return (provider as unknown as { lifecycleManager: unknown })
    .lifecycleManager as {
    pointerPollTimer: ReturnType<typeof setTimeout> | null;
    samplePointerPollIntervalMs(): number;
  };
}

describe('LifecycleManager periodic pointer poll (Path 2 safety net)', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('samples next interval in [30s, 90s)', async () => {
    const pointer = stubPointer({ recoverLatest: vi.fn(async () => null) });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    const lifecycle = getLifecycle(provider);

    // Sample many times — every value must lie in [30s, 90s).
    for (let i = 0; i < 200; i++) {
      const ms = lifecycle.samplePointerPollIntervalMs();
      expect(ms).toBeGreaterThanOrEqual(POINTER_POLL_MIN_MS);
      expect(ms).toBeLessThan(POINTER_POLL_MAX_MS);
    }

    await provider.shutdown();
  });

  it('arms the poll timer at the end of initialize() when a pointer closure is wired', async () => {
    const pointer = stubPointer({ recoverLatest: vi.fn(async () => null) });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

    await provider.shutdown();
  });

  it('does NOT arm the poll timer when no pointer closure is wired', async () => {
    const provider = createProvider({ db /* no getPointerLayer */ });
    await provider.initialize();

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).toBeNull();

    await provider.shutdown();
  });

  it('returns null → re-arms without writing a bundle', async () => {
    const recoverLatest = vi.fn(async () => null);
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    // Cold-start ran one recoverLatest already — track that as the
    // baseline so the assertion focuses on the periodic poll.
    const baselineCalls = recoverLatest.mock.calls.length;

    // Drain: advance enough to fire the next scheduled poll — well
    // beyond the 90s upper bound so we deterministically cross it.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);

    // The poll fired at least once.
    expect(recoverLatest.mock.calls.length).toBeGreaterThan(baselineCalls);

    // No bundle ref written (recoverLatest returned null).
    const bundleCount = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    ).length;
    expect(bundleCount).toBe(0);

    // Timer is re-armed for the next iteration.
    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

    await provider.shutdown();
  });

  it('returns SAME CID as already-known → no bundle write, re-arms', async () => {
    const knownBytes = new TextEncoder().encode('{"tokens":[]}');
    const cid = cidForBytes(knownBytes);
    const cidString = cid.toString();

    // Cold-start path: recoverLatest returns the CID; lifecycle adds
    // it to the index. Subsequent poll iterations must NOT write again.
    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 1 }));
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    // Cold-start added the bundle ref. Snapshot the OrbitDB store so
    // we can check the periodic poll doesn't churn it.
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    const bundleBytesAfterColdStart = db._store.get(bundleKey);
    expect(bundleBytesAfterColdStart).toBeDefined();

    // Drain a poll iteration — same CID returned, must short-circuit.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    expect(recoverLatest.mock.calls.length).toBeGreaterThan(1);

    // Same encrypted bytes — no churn.
    expect(db._store.get(bundleKey)).toBe(bundleBytesAfterColdStart);

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

    await provider.shutdown();
  });

  it('returns a NEW CID → bundleIndex.addBundle called, re-arms', async () => {
    // Cold-start: pointer has no anchor yet (returns null). Then on
    // the first periodic poll a NEW CID becomes available.
    const newBytes = new TextEncoder().encode('{"tokens":["new"]}');
    const cid = cidForBytes(newBytes);
    const cidString = cid.toString();

    let nextResult: { cid: Uint8Array; version: number } | null = null;
    const recoverLatest = vi.fn(async () => nextResult);
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    // Confirm cold-start ran (and recovered nothing — no anchor yet).
    expect(recoverLatest.mock.calls.length).toBeGreaterThanOrEqual(1);
    const bundleCountBefore = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    ).length;
    expect(bundleCountBefore).toBe(0);

    // Now make recoverLatest return the new CID for the next poll.
    nextResult = { cid: cid.bytes, version: 7 };

    // Drain one poll iteration. The poll's async chain (recoverLatest
    // → bundleIndex.addBundle which encrypts via subtle crypto) needs
    // a few microtask flushes after the timer fires; advancing again
    // by 0ms drains pending promise continuations.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Bundle ref written under the canonical key.
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    expect(db._store.has(bundleKey)).toBe(true);

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

    await provider.shutdown();
  });

  it('shutdown() stops the timer (no further poll iterations)', async () => {
    const recoverLatest = vi.fn(async () => null);
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    // Cold-start ran one recoverLatest.
    const callsAfterInit = recoverLatest.mock.calls.length;

    await provider.shutdown();

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).toBeNull();

    // Advance well past the maximum poll interval — no further calls.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS * 6);
    expect(recoverLatest.mock.calls.length).toBe(callsAfterInit);
  });

  it('permanent error → emits storage:error AND backs off (5x interval)', async () => {
    const permanentError = Object.assign(
      new Error('embedded trust base is older than aggregator epoch'),
      { code: 'AGGREGATOR_POINTER_TRUST_BASE_STALE' },
    );

    // Pointer throws permanent error on EVERY call (cold-start + every
    // poll). Cold-start surfaces a storage:error too — we wait for the
    // poll-side event by counting events generated AFTER cold-start.
    const recoverLatest = vi.fn(async () => {
      throw permanentError;
    });
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const errorEvents: Array<{ code?: string }> = [];
    provider.onEvent!((evt) => {
      if (evt.type === 'storage:error') {
        errorEvents.push({ code: evt.code });
      }
    });

    await provider.initialize();

    // Cold-start surfaced the permanent error — that's the first
    // event. Snapshot the count so we can verify the poll surfaces
    // its OWN event (proving the poll path runs the same classifier).
    const errorCountAfterColdStart = errorEvents.length;
    expect(errorCountAfterColdStart).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0].code).toBe('AGGREGATOR_POINTER_TRUST_BASE_STALE');

    // Drain ONE poll iteration (advance past the max normal interval).
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);

    // The poll surfaced its own permanent-error event.
    expect(errorEvents.length).toBeGreaterThan(errorCountAfterColdStart);
    expect(errorEvents[errorEvents.length - 1].code).toBe(
      'AGGREGATOR_POINTER_TRUST_BASE_STALE',
    );

    // Back-off: the next-tick interval is sampled in [30s × 5, 90s × 5)
    // = [150s, 450s). Confirm advancing the normal interval again does
    // NOT fire a third call (it's still parked behind the back-off).
    const callsAfterFirstPoll = recoverLatest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    expect(recoverLatest.mock.calls.length).toBe(callsAfterFirstPoll);

    // But advancing past 5 × normal-max DOES fire the next call.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS * 5);
    expect(recoverLatest.mock.calls.length).toBeGreaterThan(callsAfterFirstPoll);

    await provider.shutdown();
  });

  it('transient error → re-arms at NORMAL interval (no back-off)', async () => {
    const transientError = Object.assign(
      new Error('aggregator offline'),
      { code: 'AGGREGATOR_POINTER_NETWORK_ERROR' },
    );
    const recoverLatest = vi.fn(async () => {
      throw transientError;
    });
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    const callsAfterInit = recoverLatest.mock.calls.length;

    // Drain past normal max — must fire a poll.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    const callsAfterPoll1 = recoverLatest.mock.calls.length;
    expect(callsAfterPoll1).toBeGreaterThan(callsAfterInit);

    // Drain again past normal max — transient errors do NOT back off,
    // so the next iteration must fire.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    expect(recoverLatest.mock.calls.length).toBeGreaterThan(callsAfterPoll1);

    await provider.shutdown();
  });
});
