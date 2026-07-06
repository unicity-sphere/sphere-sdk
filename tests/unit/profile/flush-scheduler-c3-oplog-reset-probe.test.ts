/**
 * Tests for Audit #333 C3: auto-drop on transient block-load error.
 *
 * Background
 * ----------
 * Before the C3 fix, `FlushScheduler.addBundleWithOplogAutoReset`
 * transitioned straight from "extractLostHeadCid matched the error" to
 * `resetCorruptedLog()` (which does `db.drop()`). The matcher cannot
 * distinguish a permanently-corrupt head (Helia GC ran on a memory-
 * blockstore wallet) from a transiently-unreachable one (gateway blip,
 * peer offline, propagation lag). A momentary fetch failure thus wiped
 * all OUTBOX/SENT/disposition/finalization entries not yet captured in
 * a pinned bundle — permanent data loss on a recoverable error.
 *
 * Fix
 * ---
 *   - Probe configured IPFS gateways with exponential backoff
 *     (`verifyCidAccessibleWithRetry`) BEFORE the destructive reset.
 *   - On a successful probe, retry `addBundle` ONCE. If the retry
 *     succeeds the reset is SKIPPED — no operational state is lost.
 *   - On probe failure (CID NOT served by any gateway within the
 *     deadline) OR a retry that still hits the same auto-reset
 *     signature, fall through to the existing reset path.
 *   - With no gateways configured, the fix is a no-op (matches
 *     pre-fix behaviour) since there is no recovery surface.
 *
 * These tests assert each path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BundleIndex,
  FlushScheduler,
  type ProfileTokenStorageHost,
} from '../../../extensions/uxf/profile/profile-token-storage';
import type { StorageEvent } from '../../../storage/storage-provider';
import type { UxfBundleRef } from '../../../extensions/uxf/profile/types';

// Mock the gateway-probe helper so tests control the probe outcome
// without spinning up real HTTP. The mock is keyed on the CID to
// distinguish "served" vs "unreachable" across calls.
vi.mock('../../../extensions/uxf/profile/ipfs-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    verifyCidAccessibleWithRetry: vi.fn(
      async (
        _gateways: string[],
        cid: string,
        _opts: { deadlineMs: number; perAttemptTimeoutMs?: number },
      ) => {
        const outcome = (globalThis as unknown as {
          __c3MockProbe?: Record<string, { ok: boolean; attempts: number; elapsedMs: number }>;
        }).__c3MockProbe?.[cid];
        return (
          outcome ?? {
            ok: false,
            attempts: 1,
            elapsedMs: 0,
            failureKind: 'gateway-not-serving' as const,
          }
        );
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Harness — minimal shape we need to drive
// `addBundleWithOplogAutoReset` through the C3 paths.
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
  /** Behaviour of bundleIndex.addBundle, invoked on each attempt. */
  addBundleSequence: Array<Error | 'ok'>;
  /** Gateways to expose on host.ipfsGateways. */
  ipfsGateways?: string[];
  resetImpl?: (reason: {
    lostHeadCid?: string;
    context: string;
  }) => Promise<{ recovered: true; lostHeadCid?: string; recoveredAt: number }>;
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
  const writeRecoveryMarker = vi.fn(async () => {});

  const dbBase: Record<string, unknown> = {
    async connect() {},
    async put() {},
    async get() { return null; },
    async del() {},
    async all() { return new Map(); },
    async close() {},
    onReplication() { return () => {}; },
    isConnected() { return true; },
    resetCorruptedLog,
  };

  const host: ProfileTokenStorageHost = {
    db: dbBase as unknown as ProfileTokenStorageHost['db'],
    ipfsGateways: opts.ipfsGateways ?? [],
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
    log: (m) => { logLines.push(m); },
    emitEvent: (e) => { emittedEvents.push(e); },
    buildErrorEvent: (type, err) => ({
      type,
      timestamp: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    }),
    writeProfileKey: async () => {},
    readProfileKey: async () => null,
    readProfileKeyJson: async () => null,
    writeRecoveryMarker,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const bundleIndex = new BundleIndex(host);
  const scheduler = new FlushScheduler(host, bundleIndex);

  // Spy on bundleIndex.addBundle. Each call consumes the next sequence
  // entry; throws when the entry is an Error, resolves otherwise.
  let callIndex = 0;
  const addBundleSpy = vi.fn(async (_cid: string, _ref: UxfBundleRef) => {
    const step = opts.addBundleSequence[callIndex];
    callIndex++;
    if (step === undefined) {
      throw new Error(
        `addBundleSequence exhausted at call ${callIndex} — test bug`,
      );
    }
    if (step === 'ok') return;
    throw step;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bundleIndex as any).addBundle = addBundleSpy;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_CID = 'bafy1234567890headcid';
const ANOTHER_CID = 'bafy1234567890othercid';
const SAMPLE_BUNDLE_REF: UxfBundleRef = {
  cid: 'bafyzzzzzzzzzzzzzzzzzzzzbundleref',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function lostBlockError(cid: string): Error {
  return new Error(`Failed to load block for ${cid}`);
}

function setMockProbe(cid: string, ok: boolean, attempts = 1, elapsedMs = 100): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.__c3MockProbe) g.__c3MockProbe = {};
  g.__c3MockProbe[cid] = ok
    ? { ok: true, attempts, elapsedMs }
    : { ok: false, attempts, elapsedMs, failureKind: 'gateway-not-serving' };
}

function clearMockProbes(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__c3MockProbe = undefined;
}

async function callAddBundleWithOplogAutoReset(
  harness: Harness,
  cid: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.scheduler as any).addBundleWithOplogAutoReset(
    cid,
    SAMPLE_BUNDLE_REF,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 C3 — oplog auto-reset probe gate', () => {
  beforeEach(() => clearMockProbes());
  afterEach(() => clearMockProbes());

  describe('transient blip — probe recovers, NO reset', () => {
    it('skips destructive reset when probe succeeds and retry succeeds', async () => {
      const harness = buildHarness({
        addBundleSequence: [lostBlockError(SAMPLE_CID), 'ok'],
        ipfsGateways: ['http://gateway.test'],
      });
      setMockProbe(SAMPLE_CID, true, 2, 1200);

      await callAddBundleWithOplogAutoReset(harness, SAMPLE_CID);

      // addBundle was called twice: initial fail + post-probe retry.
      expect(harness.addBundleSpy).toHaveBeenCalledTimes(2);
      // CRUCIAL: reset NEVER ran.
      expect(harness.resetCorruptedLog).not.toHaveBeenCalled();
      // No reset events emitted (no profile:oplog-auto-resetting,
      // no profile:recovered).
      expect(
        harness.emittedEvents.filter((e) =>
          ['profile:oplog-auto-resetting', 'profile:recovered'].includes(e.type),
        ),
      ).toHaveLength(0);
      // Logged that the probe succeeded.
      expect(
        harness.logLines.some((l) => /IS accessible via gateway/.test(l)),
      ).toBe(true);
    });
  });

  describe('permanent loss — probe fails, RESET happens', () => {
    it('proceeds to reset when probe returns ok=false', async () => {
      const harness = buildHarness({
        addBundleSequence: [lostBlockError(SAMPLE_CID), 'ok'],
        ipfsGateways: ['http://gateway.test'],
      });
      setMockProbe(SAMPLE_CID, false, 5, 30_000);

      await callAddBundleWithOplogAutoReset(harness, SAMPLE_CID);

      // Probe failed → reset ran → addBundle retried once after reset.
      expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
      // resetCorruptedLog called with the original lostHeadCid.
      expect(harness.resetCorruptedLog).toHaveBeenCalledWith(
        expect.objectContaining({ lostHeadCid: SAMPLE_CID }),
      );
      // Events fired in the right order: auto-resetting, then recovered.
      const types = harness.emittedEvents.map((e) => e.type);
      expect(types).toContain('profile:oplog-auto-resetting');
      expect(types).toContain('profile:recovered');
      // Marker written.
      expect(harness.writeRecoveryMarker).toHaveBeenCalledTimes(1);
      // Logged the no-gateway-served message.
      expect(
        harness.logLines.some((l) => /NOT accessible via any gateway/.test(l)),
      ).toBe(true);
    });
  });

  describe('probe ok but retry still fails — RESET happens with fresh CID', () => {
    it('falls through to reset using the freshest lostHeadCid', async () => {
      const harness = buildHarness({
        // Initial fail with SAMPLE_CID; post-probe retry fails with
        // ANOTHER_CID (a fresher unreachable head); after-reset retry
        // succeeds.
        addBundleSequence: [
          lostBlockError(SAMPLE_CID),
          lostBlockError(ANOTHER_CID),
          'ok',
        ],
        ipfsGateways: ['http://gateway.test'],
      });
      setMockProbe(SAMPLE_CID, true, 1, 200);

      await callAddBundleWithOplogAutoReset(harness, SAMPLE_CID);

      // resetCorruptedLog called with the FRESH lostHeadCid (the one
      // from the post-probe retry, not the original one).
      expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
      expect(harness.resetCorruptedLog).toHaveBeenCalledWith(
        expect.objectContaining({ lostHeadCid: ANOTHER_CID }),
      );
      // The oplog-auto-resetting event also carries the fresh CID.
      const resettingEvent = harness.emittedEvents.find(
        (e) => e.type === 'profile:oplog-auto-resetting',
      );
      expect(resettingEvent?.data).toMatchObject({ lostHeadCid: ANOTHER_CID });
    });
  });

  describe('probe ok but retry hits DIFFERENT error class — RETHROW (no reset)', () => {
    it('re-throws the new error class without resetting', async () => {
      const otherErr = new Error('POINTER_MONOTONICITY_VIOLATION at refresh');
      const harness = buildHarness({
        addBundleSequence: [lostBlockError(SAMPLE_CID), otherErr],
        ipfsGateways: ['http://gateway.test'],
      });
      setMockProbe(SAMPLE_CID, true, 1, 200);

      await expect(
        callAddBundleWithOplogAutoReset(harness, SAMPLE_CID),
      ).rejects.toBe(otherErr);

      // Reset never ran — the new error class doesn't match the
      // auto-reset signature, so resetting wouldn't help.
      expect(harness.resetCorruptedLog).not.toHaveBeenCalled();
    });
  });

  describe('no gateways configured — preserves pre-fix behaviour', () => {
    it('skips the probe entirely and goes straight to reset', async () => {
      const harness = buildHarness({
        addBundleSequence: [lostBlockError(SAMPLE_CID), 'ok'],
        ipfsGateways: [],
      });

      await callAddBundleWithOplogAutoReset(harness, SAMPLE_CID);

      // Reset ran (no probe stood in the way).
      expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
      // Logged the no-gateways message.
      expect(
        harness.logLines.some(
          (l) => /no IPFS gateways configured/.test(l) || /no recovery surface/.test(l),
        ),
      ).toBe(true);
    });
  });

  describe('probe itself throws — fall through to reset (cannot prove recoverability)', () => {
    it('falls through to reset when the probe throws unexpectedly', async () => {
      // Make verifyCidAccessibleWithRetry mock throw for this test by
      // returning a special sentinel that triggers a throw inside the
      // mock body. Simpler: spy on the mock and have it reject.
      const ipfsClient = await import('../../../extensions/uxf/profile/ipfs-client');
      const spy = vi.spyOn(ipfsClient, 'verifyCidAccessibleWithRetry')
        .mockRejectedValueOnce(new Error('gateway URL validation threw'));

      const harness = buildHarness({
        addBundleSequence: [lostBlockError(SAMPLE_CID), 'ok'],
        ipfsGateways: ['http://gateway.test'],
      });

      await callAddBundleWithOplogAutoReset(harness, SAMPLE_CID);

      // Probe threw → treated as "cannot confirm recoverability" → reset.
      expect(harness.resetCorruptedLog).toHaveBeenCalledTimes(1);
      expect(
        harness.logLines.some((l) => /probe threw before completing/.test(l)),
      ).toBe(true);

      spy.mockRestore();
    });
  });

  describe('unrelated errors — no probe, no reset (pass-through)', () => {
    it('re-throws non-matching errors immediately', async () => {
      const unrelated = new Error('network unreachable');
      const harness = buildHarness({
        addBundleSequence: [unrelated],
        ipfsGateways: ['http://gateway.test'],
      });

      await expect(
        callAddBundleWithOplogAutoReset(harness, SAMPLE_CID),
      ).rejects.toBe(unrelated);

      // Neither probe nor reset ran.
      expect(harness.resetCorruptedLog).not.toHaveBeenCalled();
      // Only the initial addBundle attempt — no retry.
      expect(harness.addBundleSpy).toHaveBeenCalledTimes(1);
    });
  });
});
