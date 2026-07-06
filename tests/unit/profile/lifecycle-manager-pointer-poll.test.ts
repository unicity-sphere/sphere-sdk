/**
 * Tests for the periodic Path 2 (aggregator-pointer) poll inside
 * LifecycleManager.
 *
 * Path 1 — OrbitDB pubsub (libp2p gossipsub) — is live and peer-to-peer.
 * Path 2 — aggregator pointer + IPFS — is used at cold-start by
 * `recoverFromAggregatorPointerBestEffort()` and also re-polled at a
 * randomised interval in [30 s, 90 s) so two devices online with the
 * same wallet converge even when libp2p pubsub stalls (NAT / firewall /
 * peer not discovered).
 *
 * Item #15 Phase E follow-up: the recovered pointer CID is a SNAPSHOT
 * CID, NOT a UXF bundle CID. The legacy code in this manager called
 * `bundleIndex.addBundle(cidString, …)` directly — that path wrote the
 * snapshot bytes into the bundle index and the next `load()` would
 * fail to parse the snapshot CAR as a UXF package. The fix routes both
 * the poll and cold-start recovery paths through the host's
 * `applySnapshotIfWired(cid)` which fetches + parses + dispatches per-
 * writer JOIN. These tests verify the new contract:
 *
 *   - Random interval falls within [30s, 90s).
 *   - `recoverLatest()` returns null → re-arms without invoking the
 *     applier.
 *   - `recoverLatest()` returns the SAME snapshot CID we last applied
 *     → re-arms without invoking the applier again (idempotency).
 *   - `recoverLatest()` returns a NEW snapshot CID → applier is
 *     called with that CID; `onPollDiscoveredNewCid` fires; re-arms.
 *   - With NO applier wired (legacy / test default) → poll logs and
 *     skips (no fallback to `bundleIndex.addBundle` — that's the bug
 *     this change fixes). `knownBundleCids` stays empty.
 *   - `shutdown()` stops the timer.
 *   - Permanent-error handling — classified errors trigger 5x back-off.
 *
 * The pointer is a minimal stub with only `recoverLatest()` because
 * that is the sole method the poll touches.
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
  /**
   * Item #15 Phase E follow-up — install a snapshot applier on the
   * provider. When omitted, the provider runs in the legacy mode
   * where `applySnapshotIfWired` returns null (tests can then assert
   * "applier-not-wired ⇒ skip + bundle index untouched").
   */
  onApplySnapshot?: (cidString: string) => Promise<{
    joinedAny: boolean;
    addressesSeen: number;
    bundleEntriesSeen: number;
    counters: {
      entriesEvaluated: number;
      liveLanded: number;
      tombstonesLanded: number;
      localWon: number;
      remoteRejectedMalformed: number;
    };
  }>;
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
  if (opts.onApplySnapshot) {
    provider.setApplySnapshotCallback(opts.onApplySnapshot);
  }
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

  it('returns SAME snapshot CID we last applied → re-arms without re-applying', async () => {
    // Item #15 Phase E follow-up: idempotency is keyed on
    // `lastDiscoveredPointerCid` (the last snapshot CID we dispatched
    // through the applier), NOT on `knownBundleCids` — the snapshot
    // CID is structurally not a bundle CID under Item #15.
    const knownBytes = new TextEncoder().encode('{"tokens":[]}');
    const cid = cidForBytes(knownBytes);

    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 1 }));
    const applyResult = {
      joinedAny: false,
      addressesSeen: 0,
      bundleEntriesSeen: 0,
      counters: {
        entriesEvaluated: 0,
        liveLanded: 0,
        tombstonesLanded: 0,
        localWon: 0,
        remoteRejectedMalformed: 0,
      },
    };
    const onApplySnapshot = vi.fn(async () => applyResult);
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
      onApplySnapshot,
    });
    await provider.initialize();

    // Cold-start path invoked the applier exactly once for the
    // initial CID.
    const applyCallsAfterColdStart = onApplySnapshot.mock.calls.length;
    expect(applyCallsAfterColdStart).toBeGreaterThanOrEqual(1);

    // Drain a poll iteration — same CID returned, must short-circuit
    // via the `lastDiscoveredPointerCid === cidString` check.
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    expect(recoverLatest.mock.calls.length).toBeGreaterThan(1);

    // Applier NOT called again — idempotency held.
    expect(onApplySnapshot.mock.calls.length).toBe(applyCallsAfterColdStart);

    // Bundle index was NEVER directly written by the lifecycle — the
    // legacy `bundleIndex.addBundle(snapshotCid, …)` path is gone.
    const bundleCount = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    ).length;
    expect(bundleCount).toBe(0);

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

    await provider.shutdown();
  });

  it('returns a NEW snapshot CID → applier is invoked, re-arms', async () => {
    // Item #15 Phase E follow-up: a newly-discovered snapshot CID
    // dispatches through `applySnapshotIfWired` (fetch + parse +
    // per-writer JOIN). The lifecycle does NOT call
    // `bundleIndex.addBundle` directly on the snapshot CID.
    const newBytes = new TextEncoder().encode('{"tokens":["new"]}');
    const cid = cidForBytes(newBytes);
    const cidString = cid.toString();

    let nextResult: { cid: Uint8Array; version: number } | null = null;
    const recoverLatest = vi.fn(async () => nextResult);
    const applierCalls: string[] = [];
    const onApplySnapshot = vi.fn(async (cidArg: string) => {
      applierCalls.push(cidArg);
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
    });
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
      onApplySnapshot,
    });
    await provider.initialize();

    // Cold-start ran (and recovered nothing — no anchor yet).
    expect(recoverLatest.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(applierCalls).toEqual([]);

    // Now make recoverLatest return the new snapshot CID.
    nextResult = { cid: cid.bytes, version: 7 };

    // Drain one poll iteration. Microtask flushes drain the async
    // chain (recoverLatest → applySnapshotIfWired → onPollDiscoveredNewCid).
    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Applier was invoked with the new snapshot CID.
    expect(applierCalls).toContain(cidString);

    // Bundle ref was NOT directly written by the lifecycle — the
    // applier owns whatever it wants to write through the BundleIndex
    // JOIN writer; the lifecycle no longer short-circuits that path.
    // The mock applier doesn't write either, so the bundle key is
    // absent (verifying the legacy direct-write is gone).
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    expect(db._store.has(bundleKey)).toBe(false);

    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

    // Issue #369 — the apply-snapshot path schedules a flush whose
    // CAR-pin now sits behind `withPinRetry` (retry-with-backoff on
    // transient pin failures). Under `vi.useFakeTimers()` the retry's
    // setTimeout-based backoff doesn't fire on its own, so the
    // shutdown's flush would block forever waiting for retries. Switch
    // to real timers for teardown so the retries drain promptly — the
    // assertions above already cover the test's intent (applier was
    // invoked with the new snapshot CID); the shutdown is only here to
    // satisfy the test's resource-cleanup discipline.
    vi.useRealTimers();
    await provider.shutdown();
  });

  it('NEW snapshot CID without applier wired → poll skips, bundle index untouched', async () => {
    // Item #15 Phase E follow-up: the legacy `bundleIndex.addBundle`
    // fallback is REMOVED — silently writing a snapshot CID as a
    // bundle ref is precisely the bug Phase E's pull-side fix
    // addresses. With no applier wired, the poll logs and skips.
    const newBytes = new TextEncoder().encode('{"tokens":["new"]}');
    const cid = cidForBytes(newBytes);
    const cidString = cid.toString();

    let nextResult: { cid: Uint8Array; version: number } | null = null;
    const recoverLatest = vi.fn(async () => nextResult);
    const pointer = stubPointer({ recoverLatest });
    // No onApplySnapshot — provider runs in the legacy mode.
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    await provider.initialize();

    nextResult = { cid: cid.bytes, version: 9 };

    await vi.advanceTimersByTimeAsync(POINTER_POLL_MAX_MS + 1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // The bundle key must NOT exist — the legacy direct-write path
    // is gone, and no applier dispatched.
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    expect(db._store.has(bundleKey)).toBe(false);

    // Timer re-armed despite the skip.
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

  it('cold-start recovery: applier wired → dispatches snapshot CID through applySnapshotIfWired', async () => {
    // Item #15 Phase E follow-up: cold-start recoverLatest returning
    // a CID dispatches through `applySnapshotIfWired` (NOT through
    // `bundleIndex.addBundle` on the snapshot CID).
    const newBytes = new TextEncoder().encode('{"tokens":["initial"]}');
    const cid = cidForBytes(newBytes);
    const cidString = cid.toString();

    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 3 }));
    const applierCalls: string[] = [];
    const onApplySnapshot = vi.fn(async (cidArg: string) => {
      applierCalls.push(cidArg);
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
    });
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
      onApplySnapshot,
    });
    await provider.initialize();

    // Cold-start invoked the applier with the recovered snapshot CID.
    expect(applierCalls).toContain(cidString);

    // The legacy `addBundle(snapshotCid, …)` path is gone — bundle
    // index untouched by the lifecycle.
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    expect(db._store.has(bundleKey)).toBe(false);

    await provider.shutdown();
  });

  it('cold-start recovery: applier NOT wired → logs and skips (no legacy fallback)', async () => {
    // Item #15 Phase E follow-up: cold-start MUST NOT fall back to
    // the legacy `bundleIndex.addBundle(snapshotCid, …)` path — that
    // was the latent bug. With no applier wired the recovery becomes
    // a no-op (a subsequent poll will retry).
    const newBytes = new TextEncoder().encode('{"tokens":["initial"]}');
    const cid = cidForBytes(newBytes);
    const cidString = cid.toString();

    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 3 }));
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({ db, getPointerLayer: () => pointer });
    // No onApplySnapshot wired.
    await provider.initialize();

    // Bundle index NEVER written for the snapshot CID.
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    expect(db._store.has(bundleKey)).toBe(false);

    await provider.shutdown();
  });

  it('cold-start recovery: applier throws → returns true (keeps caller off legacy IPNS path)', async () => {
    // Item #15 Phase E follow-up: a transient applier failure during
    // cold-start must NOT fall through to the legacy IPNS migration
    // (which would stamp the migration-done marker before the
    // snapshot path can retry). The recovery returns `true` so the
    // caller skips the legacy path; the periodic poll retries.
    const newBytes = new TextEncoder().encode('{"tokens":["bad"]}');
    const cid = cidForBytes(newBytes);

    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 4 }));
    const applierCalls: number[] = [];
    const onApplySnapshot = vi.fn(async () => {
      applierCalls.push(Date.now());
      throw new Error('IPFS gateway exhausted');
    });
    const pointer = stubPointer({ recoverLatest });
    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
      onApplySnapshot,
    });
    await provider.initialize();

    // Cold-start invoked the applier (and it threw).
    expect(applierCalls.length).toBeGreaterThanOrEqual(1);

    // Periodic poll re-armed — error did not torpedo the timer.
    const lifecycle = getLifecycle(provider);
    expect(lifecycle.pointerPollTimer).not.toBeNull();

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
