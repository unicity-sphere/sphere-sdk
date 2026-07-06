/**
 * Tests for `modules/payments/transfer/sending-recovery-worker.ts`
 * (Phase 8 steelman post-cutover).
 *
 * Closes the steelman gap: the conservative-sender's pre-publish
 * persistence comments (lines 212, 886, 903) PROMISE a recovery worker
 * to re-publish entries left stuck in `'sending'` after a crash. This
 * test file gates the contract.
 *
 * Coverage:
 *  - Single stuck entry → re-publish → transition to delivered
 *    (conservative mode).
 *  - Single stuck entry in instant mode → transition to
 *    delivered-instant.
 *  - Multiple stuck entries in one cycle → all re-published.
 *  - Republish fails maxRetries times → entry transitions to
 *    failed-transient with forensic error.
 *  - Entry not stuck (recently updated) → skipped.
 *  - stop() awaits in-flight scan.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  SendingRecoveryWorker,
  type RepublishFn,
  type SendingRecoveryWorkerDeps,
} from '../../../../extensions/uxf/pipeline/sending-recovery-worker';
import type { OutboxWriter } from '../../../../profile/outbox-writer';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../../types';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';

// =============================================================================
// 1. Fixtures + helpers
// =============================================================================

interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

function makeEventRecorder(): {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
  readonly clear: () => void;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      events.push({ type, data });
    },
    clear: () => {
      events.length = 0;
    },
  };
}

function makeEntry(
  overrides: Partial<UxfTransferOutboxEntry> = {},
): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: overrides.id ?? 'outbox-1',
    bundleCid: 'bafy-bundle',
    tokenIds: ['token-1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'recipient-pk',
    mode: 'conservative',
    status: 'sending',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lamport: 1,
    ...overrides,
  };
}

interface FakeOutbox {
  readonly outbox: Pick<OutboxWriter, 'readAllNew' | 'update'>;
  readonly entries: () => Map<string, UxfTransferOutboxEntry>;
  readonly transitions: () => ReadonlyArray<{
    id: string;
    from: string;
    to: string;
  }>;
}

function makeFakeOutbox(initial: ReadonlyArray<UxfTransferOutboxEntry>): FakeOutbox {
  const entries = new Map<string, UxfTransferOutboxEntry>();
  for (const e of initial) entries.set(e.id, e);
  const transitions: Array<{ id: string; from: string; to: string }> = [];
  return {
    entries: () => entries,
    transitions: () => transitions,
    outbox: {
      async readAllNew() {
        return Array.from(entries.values());
      },
      async update(id, mutator) {
        const prev = entries.get(id);
        if (!prev) {
          throw new Error(`OutboxWriter.update: no entry "${id}"`);
        }
        const next = mutator(prev);
        if (next.status !== prev.status) {
          transitions.push({ id, from: prev.status, to: next.status });
        }
        entries.set(id, next);
        return next;
      },
    },
  };
}

function makeDeps(
  overrides: Partial<SendingRecoveryWorkerDeps> & {
    readonly outboxFixture: FakeOutbox;
    readonly republish: RepublishFn;
    readonly nowMs: number;
  },
): SendingRecoveryWorkerDeps {
  const recorder = makeEventRecorder();
  return {
    outbox: overrides.outboxFixture.outbox,
    republish: overrides.republish,
    emit: overrides.emit ?? recorder.emit,
    logger: overrides.logger ?? { warn: () => undefined, info: () => undefined },
    now: overrides.now ?? ((): number => overrides.nowMs),
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('SendingRecoveryWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-publishes a single stuck conservative-mode entry and transitions to delivered', async () => {
    const stuckEntry = makeEntry({
      id: 'outbox-stuck',
      mode: 'conservative',
      status: 'sending',
      updatedAt: 1_000_000,
    });
    const outboxFixture = makeFakeOutbox([stuckEntry]);
    const republish = vi.fn<RepublishFn>().mockResolvedValue(undefined);
    const recorder = makeEventRecorder();

    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        emit: recorder.emit,
        // 90s after updatedAt — well past 60s default threshold.
        nowMs: 1_000_000 + 90_000,
      }),
    );

    const attempted = await worker.runScanCycle();

    expect(attempted).toBe(1);
    expect(republish).toHaveBeenCalledTimes(1);
    expect(republish).toHaveBeenCalledWith(stuckEntry);
    const transitions = outboxFixture.transitions();
    expect(transitions).toEqual([
      { id: 'outbox-stuck', from: 'sending', to: 'delivered' },
    ]);
    const recoveryEvents = recorder.events.filter(
      (e) => e.type === 'transfer:recovery-republished',
    );
    expect(recoveryEvents).toHaveLength(1);
    const eventData = recoveryEvents[0].data as {
      outboxId: string;
      bundleCid: string;
      mode: string;
      targetStatus: string;
    };
    expect(eventData.outboxId).toBe('outbox-stuck');
    expect(eventData.bundleCid).toBe('bafy-bundle');
    expect(eventData.mode).toBe('conservative');
    expect(eventData.targetStatus).toBe('delivered');
  });

  it('transitions instant-mode stuck entry to delivered-instant', async () => {
    const stuckEntry = makeEntry({
      id: 'outbox-instant',
      mode: 'instant',
      status: 'sending',
      updatedAt: 2_000_000,
    });
    const outboxFixture = makeFakeOutbox([stuckEntry]);
    const republish = vi.fn<RepublishFn>().mockResolvedValue(undefined);
    const recorder = makeEventRecorder();

    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        emit: recorder.emit,
        nowMs: 2_000_000 + 70_000,
      }),
    );

    await worker.runScanCycle();

    const transitions = outboxFixture.transitions();
    expect(transitions).toEqual([
      { id: 'outbox-instant', from: 'sending', to: 'delivered-instant' },
    ]);
    const recovery = recorder.events.find(
      (e) => e.type === 'transfer:recovery-republished',
    );
    expect(recovery).toBeDefined();
    expect(
      (recovery!.data as { targetStatus: string }).targetStatus,
    ).toBe('delivered-instant');
  });

  it('re-publishes every stuck entry in a single scan cycle', async () => {
    const a = makeEntry({ id: 'a', updatedAt: 1_000 });
    const b = makeEntry({ id: 'b', updatedAt: 2_000 });
    const c = makeEntry({ id: 'c', updatedAt: 3_000 });
    const outboxFixture = makeFakeOutbox([a, b, c]);
    const republish = vi.fn<RepublishFn>().mockResolvedValue(undefined);

    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        // All three were updated long ago vs. a 60s threshold.
        nowMs: 1_000_000_000,
      }),
    );

    const attempted = await worker.runScanCycle();

    expect(attempted).toBe(3);
    expect(republish).toHaveBeenCalledTimes(3);
    const transitions = outboxFixture.transitions();
    expect(transitions.map((t) => t.id).sort()).toEqual(['a', 'b', 'c']);
    for (const t of transitions) {
      expect(t.from).toBe('sending');
      expect(t.to).toBe('delivered');
    }
  });

  it('transitions to failed-transient after maxRetries consecutive republish failures', async () => {
    const stuckEntry = makeEntry({
      id: 'outbox-fail',
      updatedAt: 1_000,
    });
    const outboxFixture = makeFakeOutbox([stuckEntry]);
    const republish = vi
      .fn<RepublishFn>()
      .mockRejectedValue(new Error('relay down'));

    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        nowMs: 1_000_000,
      }),
      // Force a tight retry budget for the test.
      { maxRetries: 3 },
    );

    // First two cycles fail without transitioning (count < maxRetries).
    await worker.runScanCycle();
    await worker.runScanCycle();
    expect(outboxFixture.transitions()).toEqual([]);
    expect(outboxFixture.entries().get('outbox-fail')?.status).toBe('sending');

    // Third cycle hits maxRetries → transition to failed-transient.
    await worker.runScanCycle();

    expect(republish).toHaveBeenCalledTimes(3);
    const transitions = outboxFixture.transitions();
    expect(transitions).toEqual([
      { id: 'outbox-fail', from: 'sending', to: 'failed-transient' },
    ]);
    const finalEntry = outboxFixture.entries().get('outbox-fail');
    expect(finalEntry?.status).toBe('failed-transient');
    expect(finalEntry?.error).toContain('sending-recovery-worker');
    expect(finalEntry?.error).toContain('relay down');
  });

  it('Issue #401: emits transfer:recovery-republish-exhausted on maxRetries exhaustion (and not on intermediate failures)', async () => {
    const stuckEntry = makeEntry({
      id: 'outbox-exhaust',
      bundleCid: 'bafy-exhaust',
      tokenIds: ['invoice-token-id'],
      mode: 'instant',
      recipient: '@bob',
      updatedAt: 1_000,
    });
    const outboxFixture = makeFakeOutbox([stuckEntry]);
    const republish = vi
      .fn<RepublishFn>()
      .mockRejectedValue(new Error('relay down for 90s'));

    const recorder = makeEventRecorder();
    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        nowMs: 2_000_000,
        emit: recorder.emit,
      }),
      { maxRetries: 3 },
    );

    // First two cycles fail without exhaustion — no event yet.
    await worker.runScanCycle();
    await worker.runScanCycle();
    expect(
      recorder.events.filter((e) => e.type === 'transfer:recovery-republish-exhausted'),
    ).toHaveLength(0);

    // Third cycle exhausts; event fires exactly once.
    await worker.runScanCycle();

    const exhausted = recorder.events.filter(
      (e) => e.type === 'transfer:recovery-republish-exhausted',
    );
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.data).toMatchObject({
      outboxId: 'outbox-exhaust',
      bundleCid: 'bafy-exhaust',
      tokenIds: ['invoice-token-id'],
      mode: 'instant',
      recipient: '@bob',
      lastError: expect.stringContaining('relay down'),
    });
    expect((exhausted[0]!.data as { exhaustedAt: number }).exhaustedAt).toBe(2_000_000);
  });

  it('skips entries whose updatedAt is within the stuck threshold', async () => {
    const fresh = makeEntry({
      id: 'fresh',
      // Just 10s old vs. default 60s threshold.
      updatedAt: 999_000,
    });
    const stuck = makeEntry({
      id: 'stuck',
      // 90s old.
      updatedAt: 919_000,
    });
    const outboxFixture = makeFakeOutbox([fresh, stuck]);
    const republish = vi.fn<RepublishFn>().mockResolvedValue(undefined);

    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        // 1s ms after `fresh` was updated — fresh is 10s old, stuck is 90s old.
        nowMs: 1_009_000,
      }),
    );

    const attempted = await worker.runScanCycle();

    expect(attempted).toBe(1);
    expect(republish).toHaveBeenCalledTimes(1);
    expect(republish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stuck' }),
    );
    const transitions = outboxFixture.transitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0].id).toBe('stuck');
  });

  // ===========================================================================
  // Wave 3 steelman regression — concurrency races
  // ===========================================================================
  //
  // The recovery worker's previous `recoverOne` impl called `republish()`
  // BEFORE checking the entry was still in `'sending'`, then unconditionally
  // emitted `transfer:recovery-republished` even when the post-republish
  // CAS no-op'd. A concurrent process advancing the entry to
  // `delivered-instant` between the scan snapshot and `recoverOne()` would:
  //   (a) trigger a duplicate Nostr publish (wasted relay traffic), and
  //   (b) emit a false-success event that downstream subscribers
  //       interpret as proof of recovery.
  //
  // The fix re-reads the entry under the writer's CAS path BEFORE calling
  // republish (skip if status changed), AND moves `emitRepublished` inside
  // the mutator's success branch (gate emit on actual transition).
  describe('Wave 3 — concurrency race against in-flight status change', () => {
    // FIX 5: snapshot is now authoritative; recoverOne does NOT re-read
    // before republishing. The race between snapshot and republish is
    // handled by the CAS guard inside transitionToDelivered's update
    // closure — no false-success emit fires.
    it('FIX 5: snapshot authoritative; republish fires when entry advances DURING republish, but no false-success emit', async () => {
      const stuckEntry = makeEntry({
        id: 'race-advance-during-republish',
        mode: 'instant',
        status: 'sending',
        updatedAt: 1_000,
      });
      const outboxFixture = makeFakeOutbox([stuckEntry]);

      // Hand-rolled republish: when called, mutates the live outbox
      // to simulate a concurrent advance HAPPENING during the publish.
      const republish: RepublishFn = vi.fn(async (): Promise<void> => {
        const entries = outboxFixture.entries();
        const live = entries.get('race-advance-during-republish');
        if (live !== undefined && live.status === 'sending') {
          entries.set('race-advance-during-republish', {
            ...live,
            status: 'delivered-instant',
          });
        }
      });

      const recorder = makeEventRecorder();

      const worker = new SendingRecoveryWorker({
        outbox: outboxFixture.outbox,
        republish,
        emit: recorder.emit,
        logger: { warn: () => undefined, info: () => undefined },
        now: () => 1_000_000,
      });

      const attempted = await worker.runScanCycle();

      // FIX 5: snapshot-authoritative — republish IS called.
      expect(attempted).toBe(1);
      expect(republish).toHaveBeenCalledTimes(1);
      // Post-republish CAS detected the advance — no false-success.
      const recoveryEvents = recorder.events.filter(
        (e) => e.type === 'transfer:recovery-republished',
      );
      expect(recoveryEvents).toHaveLength(0);
      expect(outboxFixture.transitions()).toEqual([]);
    });

    it('does not emit recovery-republished when CAS no-ops on status change post-republish', async () => {
      // Variant where the entry advances DURING `republish()` (between
      // the pre-flight CAS check and the post-republish CAS write).
      // The republish call DOES go out (the worker observed `'sending'`
      // when it pre-checked), but the post-write CAS hits the
      // already-advanced status and self-loops. No emit must fire.
      const stuckEntry = makeEntry({
        id: 'race-advance-mid-republish',
        status: 'sending',
        updatedAt: 1_000,
      });
      const outboxFixture = makeFakeOutbox([stuckEntry]);
      const recorder = makeEventRecorder();

      // Hand-rolled republish: when called, mutates the outbox to
      // simulate a concurrent advance.
      const republish: RepublishFn = async (): Promise<void> => {
        const entries = outboxFixture.entries();
        const live = entries.get('race-advance-mid-republish');
        if (live !== undefined && live.status === 'sending') {
          entries.set('race-advance-mid-republish', {
            ...live,
            status: 'delivered',
          });
        }
      };

      const worker = new SendingRecoveryWorker({
        outbox: outboxFixture.outbox,
        republish,
        emit: recorder.emit,
        logger: { warn: () => undefined, info: () => undefined },
        now: () => 1_000_000,
      });

      await worker.runScanCycle();

      // Post-republish, the writer CAS'd against the advanced status
      // and returned `prev` unchanged. The transitions array picks up
      // self-loops only when status changes — should be empty.
      expect(outboxFixture.transitions()).toEqual([]);
      // CRITICAL: no false-success emit even though the publish path
      // ran. The fix gates the emit on the actual write transition.
      const recoveryEvents = recorder.events.filter(
        (e) => e.type === 'transfer:recovery-republished',
      );
      expect(recoveryEvents).toHaveLength(0);
    });

    it('emits recovery-republished exactly once when CAS actually transitions', async () => {
      // Sanity: the happy path still emits. This pins that the fix
      // narrows the emit, NOT silences it entirely.
      const stuckEntry = makeEntry({
        id: 'happy-path',
        status: 'sending',
        updatedAt: 1_000,
      });
      const outboxFixture = makeFakeOutbox([stuckEntry]);
      const republish = vi.fn<RepublishFn>().mockResolvedValue(undefined);
      const recorder = makeEventRecorder();

      const worker = new SendingRecoveryWorker(
        makeDeps({
          outboxFixture,
          republish,
          emit: recorder.emit,
          nowMs: 1_000_000,
        }),
      );

      await worker.runScanCycle();

      const recoveryEvents = recorder.events.filter(
        (e) => e.type === 'transfer:recovery-republished',
      );
      expect(recoveryEvents).toHaveLength(1);
      expect(outboxFixture.transitions()).toEqual([
        { id: 'happy-path', from: 'sending', to: 'delivered' },
      ]);
    });
  });

  // ===========================================================================
  // FIX 4 — errMessage(err) routes unknown-shape errors through W40
  // redactCause so sensitive own-properties never leak into the log line.
  // ===========================================================================
  describe('FIX 4 — errMessage redacts sensitive own-properties on non-Error throws', () => {
    it('does NOT leak signedTransferTxBytes content into the warn log on republish failure', async () => {
      const stuckEntry = makeEntry({
        id: 'forensic-entry',
        status: 'sending',
        updatedAt: 1_000,
      });
      const outboxFixture = makeFakeOutbox([stuckEntry]);

      const SECRET_BYTES = new Uint8Array([
        0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
      ]);
      const hostileThrow = {
        kind: 'transient',
        signedTransferTxBytes: SECRET_BYTES,
        nestedDetail: {
          signedCommitmentBytes: SECRET_BYTES,
        },
      };
      const republish: RepublishFn = vi.fn(async () => {
        throw hostileThrow;
      });

      const warnLogs: Array<{ msg: string; ctx: unknown }> = [];
      const worker = new SendingRecoveryWorker({
        outbox: outboxFixture.outbox,
        republish,
        emit: () => undefined,
        logger: {
          warn: (msg: string, ctx?: Record<string, unknown>) => {
            warnLogs.push({ msg, ctx });
          },
          info: () => undefined,
        },
        now: () => 1_000_000,
      });

      await worker.runScanCycle();

      const failureLogs = warnLogs.filter((l) => l.msg.includes('republish failed'));
      expect(failureLogs.length).toBeGreaterThanOrEqual(1);
      const errStr = String((failureLogs[0]!.ctx as { err: string }).err);
      expect(errStr.toLowerCase()).not.toContain('deadbeef');
      const b64 = Buffer.from(SECRET_BYTES).toString('base64');
      expect(errStr).not.toContain(b64);
      // The redaction marker DOES surface (proves redactCause ran).
      expect(errStr).toContain('REDACTED: signedTransferTxBytes');
      expect(errStr).toContain('REDACTED: signedCommitmentBytes');
      expect(errStr).toContain('transient');
    });
  });

  // ===========================================================================
  // FIX 5 — runScanCycle is O(N) reads, not O(N²).
  // ===========================================================================
  describe('FIX 5 — O(N) read budget per scan cycle', () => {
    it('readAllNew is invoked exactly once per scan cycle, regardless of N stuck entries', async () => {
      const N = 10;
      const stuck: UxfTransferOutboxEntry[] = [];
      for (let i = 0; i < N; i++) {
        stuck.push(
          makeEntry({
            id: `stuck-${i}`,
            status: 'sending',
            updatedAt: 1_000,
          }),
        );
      }
      const outboxFixture = makeFakeOutbox(stuck);

      let readCount = 0;
      const baseReadAll = outboxFixture.outbox.readAllNew;
      const baseUpdate = outboxFixture.outbox.update;
      const countingOutbox: Pick<typeof outboxFixture.outbox, 'readAllNew' | 'update'> = {
        async readAllNew() {
          readCount += 1;
          return baseReadAll();
        },
        update: baseUpdate,
      };

      const republish = vi.fn<RepublishFn>().mockResolvedValue(undefined);
      const recorder = makeEventRecorder();

      const worker = new SendingRecoveryWorker({
        outbox: countingOutbox,
        republish,
        emit: recorder.emit,
        logger: { warn: () => undefined, info: () => undefined },
        now: () => 1_000_000,
      });

      const attempted = await worker.runScanCycle();

      // Pre-FIX 5: readCount would be N+1 (1 outer scan + N pre-flight).
      // Post-FIX 5: exactly 1 (snapshot at scan time only).
      expect(readCount).toBe(1);
      expect(attempted).toBe(N);
      expect(republish).toHaveBeenCalledTimes(N);
      const recoveryEvents = recorder.events.filter(
        (e) => e.type === 'transfer:recovery-republished',
      );
      expect(recoveryEvents).toHaveLength(N);
    });
  });

  it('stop() awaits the in-flight scan cycle', async () => {
    const stuckEntry = makeEntry({ id: 'in-flight', updatedAt: 1_000 });
    const outboxFixture = makeFakeOutbox([stuckEntry]);

    // Build a republish that resolves under our control so we can
    // observe stop()'s await behavior. The hand-rolled deferred is
    // released by the test below to confirm stop() blocks until the
    // in-flight cycle completes.
    let republishInvoked = false;
    let releaseRepublish!: () => void;
    const republishComplete = new Promise<void>((resolve) => {
      releaseRepublish = resolve;
    });
    const republish: RepublishFn = async (): Promise<void> => {
      republishInvoked = true;
      await republishComplete;
    };

    const worker = new SendingRecoveryWorker(
      makeDeps({
        outboxFixture,
        republish,
        nowMs: 1_000_000,
      }),
      // Tight interval so the timer fires fast under fake timers.
      { intervalMs: 10 },
    );

    worker.start();
    expect(worker.isRunning()).toBe(true);

    // Advance to fire the first scheduled scan. The cycle is now
    // suspended inside `republish` (which awaits `republishComplete`).
    await vi.advanceTimersByTimeAsync(10);
    expect(republishInvoked).toBe(true);

    // Begin stop() — it should await the in-flight scan cycle.
    let stopResolved = false;
    const stopPromise = worker.stop().then(() => {
      stopResolved = true;
    });

    // Spin the microtask queue: stop() should NOT have resolved yet
    // because the in-flight republish is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(worker.isRunning()).toBe(false); // running flag flipped immediately

    // Release the in-flight republish; stop() should now resolve.
    releaseRepublish();
    await stopPromise;
    expect(stopResolved).toBe(true);

    // The transition to 'delivered' should have been applied because
    // the republish resolved before stop() returned.
    const transitions = outboxFixture.transitions();
    expect(transitions).toEqual([
      { id: 'in-flight', from: 'sending', to: 'delivered' },
    ]);
  });
});
