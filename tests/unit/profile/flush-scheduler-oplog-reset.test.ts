/**
 * Tests for `FlushScheduler.addBundleWithOplogAutoReset` (Item #157).
 *
 * Drives the private method directly through `(scheduler as any)`. The
 * full `flushToIpfs` body is covered by other suites; here we focus
 * narrowly on the detection / recovery / event-emission contract of
 * the auto-reset wrapper around `BundleIndex.addBundle`.
 *
 * @see profile/profile-token-storage/flush-scheduler.ts
 * @see profile/orbitdb-adapter.ts (extractLostHeadCid + resetCorruptedLog)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BundleIndex,
  FlushScheduler,
  type ProfileTokenStorageHost,
} from '../../../profile/profile-token-storage';
import type { StorageEvent } from '../../../storage/storage-provider';
import type { UxfBundleRef } from '../../../profile/types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  scheduler: FlushScheduler;
  bundleIndex: BundleIndex;
  emittedEvents: StorageEvent[];
  resetCorruptedLog: ReturnType<typeof vi.fn>;
  writeRecoveryMarker: ReturnType<typeof vi.fn>;
  logLines: string[];
  addBundleSpy: ReturnType<typeof vi.fn>;
}

function buildHarness(opts: {
  addBundleImpl?: () => Promise<void>;
  resetImpl?: (reason: { lostHeadCid?: string; context: string }) => Promise<{
    recovered: true;
    lostHeadCid?: string;
    recoveredAt: number;
  }>;
  markerImpl?: () => Promise<void>;
  /** If true, omit resetCorruptedLog from the db stub entirely. */
  omitResetFn?: boolean;
}): Harness {
  const emittedEvents: StorageEvent[] = [];
  const logLines: string[] = [];

  const resetCorruptedLog = vi.fn(
    opts.resetImpl ??
      (async (reason: { lostHeadCid?: string; context: string }) => ({
        recovered: true as const,
        lostHeadCid: reason.lostHeadCid,
        recoveredAt: Date.now(),
      })),
  );
  const writeRecoveryMarker = vi.fn(opts.markerImpl ?? (async () => {}));

  // Minimal in-memory db. Only `put`/`putEntry` are needed because the
  // BundleIndex addBundle path writes envelopes; we replace bundleIndex.addBundle
  // entirely with a spy below so the db doesn't have to be realistic.
  const dbBase: Record<string, unknown> = {
    async connect() {},
    async put() {},
    async get() {
      return null;
    },
    async del() {},
    async all() {
      return new Map();
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  };
  if (!opts.omitResetFn) {
    dbBase.resetCorruptedLog = resetCorruptedLog;
  }

  // Host stub — only the methods FlushScheduler.addBundleWithOplogAutoReset
  // exercises need realistic implementations.
  const host: ProfileTokenStorageHost = {
    db: dbBase as unknown as ProfileTokenStorageHost['db'],
    ipfsGateways: [],
    options: undefined,
    localCache: null,
    flushDebounceMs: 0,
    eventCallbacks: new Set(),
    getHelia: () => null,
    getStatus: () => 'ready',
    setStatus: () => {},
    getInitialized: () => true,
    setInitialized: () => {},
    getIsShuttingDown: () => false,
    setIsShuttingDown: () => {},
    getIdentity: () => null,
    setIdentityState: () => {},
    getEncryptionKey: () => null,
    setEncryptionKey: () => {},
    getComputedAddressId: () => null,
    setComputedAddressId: () => {},
    getReplicationUnsub: () => null,
    setReplicationUnsub: () => {},
    getPendingData: () => null,
    setPendingData: () => {},
    getFlushTimer: () => null,
    setFlushTimer: () => {},
    getFlushPromise: () => null,
    setFlushPromise: () => {},
    getLastPinnedCid: () => null,
    setLastPinnedCid: () => {},
    getLastPinnedBundleCid: () => null,
    setLastPinnedBundleCid: () => {},
    getLastVerifiedBundleCid: () => null,
    setLastVerifiedBundleCid: () => {},
    getLastVerifiedSnapshotCid: () => null,
    setLastVerifiedSnapshotCid: () => {},
    getLastDiscoveredPointerCid: () => null,
    setLastDiscoveredPointerCid: () => {},
    getPendingPublishCid: () => null,
    setPendingPublishCid: () => {},
    getKnownBundleCids: () => new Set<string>(),
    setKnownBundleCids: () => {},
    getLastLoadedData: () => null,
    setLastLoadedData: () => {},
    getLastLoadedFromBundleCids: () => null,
    setLastLoadedFromBundleCids: () => {},
    getLastTokenManifest: () => null,
    setLastTokenManifest: () => {},
    getAddressId: () => 'DIRECT_abc_def',
    log: (m) => {
      logLines.push(m);
    },
    emitEvent: (e) => {
      emittedEvents.push(e);
    },
    buildErrorEvent: (type, err) => ({
      type,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    }),
    writeProfileKey: async () => {},
    readProfileKey: async () => null,
    readProfileKeyJson: async () => null,
    writeRecoveryMarker,
    readRecoveryMarker: async () => null,
    flushToIpfs: async () => {},
    refreshBaselineForMonotonicity: async () => true,
    extractTokensFromTxfData: () => new Map(),
    extractOperationalState: () => ({
      tombstones: [],
      outbox: [],
      sent: [],
      invalid: [],
      history: [],
      mintOutbox: [],
      invalidatedNametags: [],
      audit: [],
      finalizationQueue: [],
    }),
    writeOrbitOperationalState: async () => {},
    writeLocalDerivedCache: async () => true,
    notifyProfileDirty: () => {},
    publishSnapshotIfWired: async () => null,
    applySnapshotIfWired: async () => null,
    verifyFlushDurability: async () => {},
  };

  const bundleIndex = new BundleIndex(host);
  // Stub addBundle to the caller-supplied implementation so we can drive
  // throws + retry behavior deterministically.
  const addBundleSpy = vi.fn(
    opts.addBundleImpl ?? (async () => {}),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bundleIndex as any).addBundle = addBundleSpy;

  const scheduler = new FlushScheduler(host, bundleIndex);

  return {
    scheduler,
    bundleIndex,
    emittedEvents,
    resetCorruptedLog,
    writeRecoveryMarker,
    logLines,
    addBundleSpy,
  };
}

const SAMPLE_REF: UxfBundleRef = {
  cid: 'bafytarget',
  status: 'active',
  createdAt: 1717000000,
  tokenCount: 0,
};

// Convenience accessor for the private method under test.
async function invoke(
  scheduler: FlushScheduler,
  cid: string,
  ref: UxfBundleRef,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (scheduler as any).addBundleWithOplogAutoReset(cid, ref);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlushScheduler.addBundleWithOplogAutoReset (Item #157)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: reset succeeds + retry succeeds → profile:recovered with retrySucceeded:true', async () => {
    let attempt = 0;
    const harness = buildHarness({
      addBundleImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Failed to load block for bafyheadlost');
        }
      },
    });

    await invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF);

    expect(harness.addBundleSpy).toHaveBeenCalledTimes(2);
    expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
    expect(harness.resetCorruptedLog).toHaveBeenCalledWith({
      lostHeadCid: 'bafyheadlost',
      context: 'flush-scheduler.bundle-write',
    });
    expect(harness.writeRecoveryMarker).toHaveBeenCalledTimes(1);
    const marker = harness.writeRecoveryMarker.mock.calls[0][0];
    expect(marker.version).toBe(1);
    expect(marker.walkBackClosed).toBe(true);
    expect(marker.lostHeadCid).toBe('bafyheadlost');
    expect(marker.context).toBe('flush-scheduler.bundle-write');
    expect(typeof marker.recoveredAt).toBe('number');

    const recoveredEvents = harness.emittedEvents.filter(
      (e) => e.type === 'profile:recovered',
    );
    const armingEvents = harness.emittedEvents.filter(
      (e) => e.type === 'profile:oplog-auto-resetting',
    );
    expect(armingEvents).toHaveLength(1);
    expect(recoveredEvents).toHaveLength(1);
    const ev = recoveredEvents[0];
    expect((ev.data as { retrySucceeded: boolean }).retrySucceeded).toBe(true);
    expect((ev.data as { resetFailed?: boolean }).resetFailed).toBeUndefined();
    expect((ev.data as { lostHeadCid: string }).lostHeadCid).toBe('bafyheadlost');
    expect((ev.data as { context: string }).context).toBe('flush-scheduler.bundle-write');
  });

  it('reset throws → profile:recovered with resetFailed:true + original error propagates', async () => {
    const originalErr = new Error('Failed to load block for bafyboom');
    const harness = buildHarness({
      addBundleImpl: async () => {
        throw originalErr;
      },
      resetImpl: async () => {
        throw new Error('reset internal failure');
      },
    });

    let caught: unknown = null;
    try {
      await invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(originalErr);
    expect(harness.addBundleSpy).toHaveBeenCalledTimes(1); // no retry
    expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
    expect(harness.writeRecoveryMarker).not.toHaveBeenCalled();

    const recoveredEvents = harness.emittedEvents.filter(
      (e) => e.type === 'profile:recovered',
    );
    expect(recoveredEvents).toHaveLength(1);
    const data = recoveredEvents[0].data as {
      retrySucceeded: boolean;
      resetFailed?: boolean;
    };
    expect(data.retrySucceeded).toBe(false);
    expect(data.resetFailed).toBe(true);

    // Arming event still fired.
    expect(
      harness.emittedEvents.some((e) => e.type === 'profile:oplog-auto-resetting'),
    ).toBe(true);
  });

  it('reset succeeds but retry throws → profile:recovered with retrySucceeded:false + retry error propagates', async () => {
    let attempt = 0;
    const retryErr = new Error('Failed to load block for bafyretrystill');
    const harness = buildHarness({
      addBundleImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Failed to load block for bafyfirsterr');
        }
        throw retryErr;
      },
    });

    let caught: unknown = null;
    try {
      await invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(retryErr);
    expect(harness.addBundleSpy).toHaveBeenCalledTimes(2);
    expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
    expect(harness.writeRecoveryMarker).toHaveBeenCalledTimes(1);

    const recoveredEvents = harness.emittedEvents.filter(
      (e) => e.type === 'profile:recovered',
    );
    expect(recoveredEvents).toHaveLength(1);
    const data = recoveredEvents[0].data as {
      retrySucceeded: boolean;
      resetFailed?: boolean;
    };
    expect(data.retrySucceeded).toBe(false);
    expect(data.resetFailed).toBeUndefined();
  });

  it('non-matching error (ECONNRESET) → reset is NOT called, error propagates unchanged', async () => {
    const netErr = new Error('ECONNRESET') as Error & { code?: string };
    netErr.code = 'ECONNRESET';
    const harness = buildHarness({
      addBundleImpl: async () => {
        throw netErr;
      },
    });

    let caught: unknown = null;
    try {
      await invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(netErr);
    expect(harness.addBundleSpy).toHaveBeenCalledTimes(1);
    expect(harness.resetCorruptedLog).not.toHaveBeenCalled();
    expect(harness.writeRecoveryMarker).not.toHaveBeenCalled();
    expect(
      harness.emittedEvents.filter((e) => e.type === 'profile:recovered'),
    ).toHaveLength(0);
    expect(
      harness.emittedEvents.filter((e) => e.type === 'profile:oplog-auto-resetting'),
    ).toHaveLength(0);
  });

  it('adapter without resetCorruptedLog (legacy stub) → reset is NOT attempted, original error propagates', async () => {
    const originalErr = new Error('Failed to load block for bafylegacy');
    const harness = buildHarness({
      addBundleImpl: async () => {
        throw originalErr;
      },
      omitResetFn: true,
    });

    let caught: unknown = null;
    try {
      await invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(originalErr);
    expect(harness.addBundleSpy).toHaveBeenCalledTimes(1);
    // No resetCorruptedLog on the db at all.
    expect(harness.resetCorruptedLog).not.toHaveBeenCalled();
    expect(harness.writeRecoveryMarker).not.toHaveBeenCalled();
    expect(
      harness.emittedEvents.filter((e) => e.type === 'profile:recovered'),
    ).toHaveLength(0);
  });

  it('marker write failure is logged but does NOT block the retry path', async () => {
    let attempt = 0;
    const harness = buildHarness({
      addBundleImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('Failed to load block for bafymarkerfail');
        }
      },
      markerImpl: async () => {
        throw new Error('marker storage broken');
      },
    });

    await invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF);

    // Retry still happened.
    expect(harness.addBundleSpy).toHaveBeenCalledTimes(2);
    expect(harness.writeRecoveryMarker).toHaveBeenCalledTimes(1);
    // Marker failure surfaced in log.
    expect(
      harness.logLines.some((l) =>
        l.includes('Recovery marker write failed'),
      ),
    ).toBe(true);
    // profile:recovered with retrySucceeded:true still fired.
    const recoveredEvents = harness.emittedEvents.filter(
      (e) => e.type === 'profile:recovered',
    );
    expect(recoveredEvents).toHaveLength(1);
    expect(
      (recoveredEvents[0].data as { retrySucceeded: boolean }).retrySucceeded,
    ).toBe(true);
  });

  it('arming event fires BEFORE the reset (visible even if reset hangs/fails)', async () => {
    const order: string[] = [];
    const harness = buildHarness({
      addBundleImpl: async () => {
        throw new Error('Failed to load block for bafyorder');
      },
      resetImpl: async () => {
        order.push('reset-invoked');
        throw new Error('reset failed');
      },
    });
    // Wrap emitEvent to record arming-event ordering.
    const origEmit = harness.scheduler['host'].emitEvent.bind(
      harness.scheduler['host'],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (harness.scheduler['host'] as any).emitEvent = (e: StorageEvent) => {
      if (e.type === 'profile:oplog-auto-resetting') order.push('arming');
      if (e.type === 'profile:recovered') order.push('recovered');
      origEmit(e);
    };

    await expect(
      invoke(harness.scheduler, SAMPLE_REF.cid, SAMPLE_REF),
    ).rejects.toThrow(/Failed to load block/);

    expect(order).toEqual(['arming', 'reset-invoked', 'recovered']);
  });
});
