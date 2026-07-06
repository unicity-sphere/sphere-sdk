/**
 * Tests for `modules/payments/transfer/sent-reconciliation-worker.ts`
 * (Issue #166 P2 #4).
 *
 * Covers:
 *  - No-op when either OUTBOX or SENT provider returns null
 *    (legacy-only wallets, post-destroy state).
 *  - Eligibility filter (status in 'delivered'/'delivered-instant',
 *    past staleThreshold, not in suspended set).
 *  - already-converged path: SENT entry exists → OUTBOX tombstoned, no
 *    SENT write attempted.
 *  - missing-SENT path: SENT entry absent → writeSentEntry called →
 *    OUTBOX tombstoned → `transfer:sent-reconciliation-recovered`
 *    emitted.
 *  - Retry/suspend: consecutive failures up to maxRetries → entry
 *    added to suspended set, `transfer:sent-reconciliation-failed`
 *    emitted, no further retries.
 *  - SENT readOne error counted the same as write-failure (no
 *    premature tombstone).
 *  - Post-recovery OUTBOX-delete failure is non-fatal (next cycle
 *    hits already-converged path).
 *  - start/stop idempotent; stop() awaits in-flight scan.
 *  - writeSentEntry returning 'skipped' is a silent skip (not
 *    counted as failure).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  SentReconciliationWorker,
  type SentReconciliationWorkerDeps,
  type WriteSentEntryFn,
} from '../../../../extensions/uxf/pipeline/sent-reconciliation-worker';
import type { OutboxWriter } from '../../../../extensions/uxf/profile/outbox-writer';
import type { SentLedgerWriter } from '../../../../extensions/uxf/profile/sent-ledger-writer';
import type { SphereEventMap, SphereEventType } from '../../../../types';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';
import type { UxfSentLedgerEntry } from '../../../../types/uxf-sent';

// =============================================================================
// 1. Fixtures
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

function makeOutboxEntry(
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
    status: 'delivered',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lamport: 1,
    ...overrides,
  };
}

function makeSentEntry(
  overrides: Partial<UxfSentLedgerEntry> = {},
): UxfSentLedgerEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: overrides.id ?? 'outbox-1',
    tokenIds: overrides.tokenIds ?? ['token-1'],
    bundleCid: 'bafy-bundle',
    recipientTransportPubkey: 'recipient-pk',
    recipient: '@bob',
    deliveryMethod: 'car-over-nostr',
    mode: 'conservative',
    sentAt: 1_700_000_000_000,
    lamport: 5,
    ...overrides,
  };
}

interface FakeOutbox {
  readonly outbox: Pick<OutboxWriter, 'readAllNew' | 'delete'>;
  readonly entries: () => Map<string, UxfTransferOutboxEntry>;
  readonly tombstoned: () => ReadonlyArray<string>;
}

function makeFakeOutbox(
  initial: ReadonlyArray<UxfTransferOutboxEntry>,
  options?: {
    readonly readAllNewError?: Error;
    readonly deleteError?: Error;
    /** When set, only the first N delete() calls throw; subsequent
     *  calls succeed. Used to test "tombstone fails this cycle but
     *  succeeds next cycle on the already-converged path." */
    readonly deleteFailuresBeforeSuccess?: number;
  },
): FakeOutbox {
  const entries = new Map<string, UxfTransferOutboxEntry>();
  for (const e of initial) entries.set(e.id, e);
  const tombstoned: string[] = [];
  let deleteFailuresRemaining = options?.deleteFailuresBeforeSuccess ?? 0;
  return {
    entries: () => entries,
    tombstoned: () => tombstoned,
    outbox: {
      async readAllNew() {
        if (options?.readAllNewError) throw options.readAllNewError;
        return Array.from(entries.values());
      },
      async delete(id) {
        if (deleteFailuresRemaining > 0) {
          deleteFailuresRemaining -= 1;
          throw new Error('orbitdb delete failed');
        }
        if (options?.deleteError) throw options.deleteError;
        entries.delete(id);
        tombstoned.push(id);
      },
    },
  };
}

interface FakeSent {
  readonly sent: Pick<SentLedgerWriter, 'readOne'>;
  /** Records of every readOne(id) call for assertions. */
  readonly reads: () => ReadonlyArray<string>;
}

function makeFakeSent(
  existing: ReadonlyArray<UxfSentLedgerEntry>,
  options?: { readonly readError?: Error },
): FakeSent {
  const map = new Map<string, UxfSentLedgerEntry>();
  for (const e of existing) map.set(e.id, e);
  const reads: string[] = [];
  return {
    reads: () => reads,
    sent: {
      async readOne(id) {
        reads.push(id);
        if (options?.readError) throw options.readError;
        return map.get(id) ?? null;
      },
    },
  };
}

function makeDeps(args: {
  readonly outboxFixture: FakeOutbox;
  readonly sentFixture: FakeSent;
  readonly writeSentEntry: WriteSentEntryFn;
  readonly nowMs?: number;
  readonly emit?: SentReconciliationWorkerDeps['emit'];
}): SentReconciliationWorkerDeps {
  return {
    outboxProvider: () => args.outboxFixture.outbox,
    sentProvider: () => args.sentFixture.sent,
    writeSentEntry: args.writeSentEntry,
    emit: args.emit ?? ((): void => undefined),
    logger: { warn: () => undefined, info: () => undefined },
    now: args.nowMs !== undefined ? (): number => args.nowMs! : Date.now,
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('SentReconciliationWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // No-op / skip paths
  // ---------------------------------------------------------------------------

  it('skips silently when OUTBOX provider returns null', async () => {
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const worker = new SentReconciliationWorker({
      outboxProvider: () => null,
      sentProvider: () => sentFixture.sent,
      writeSentEntry,
      emit: () => undefined,
    });

    const result = await worker.runScanCycle();

    expect(result.skipped).toBe(true);
    expect(result.attempted).toBe(0);
    expect(writeSentEntry).not.toHaveBeenCalled();
  });

  it('skips silently when SENT provider returns null', async () => {
    const outboxFixture = makeFakeOutbox([makeOutboxEntry()]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const worker = new SentReconciliationWorker({
      outboxProvider: () => outboxFixture.outbox,
      sentProvider: () => null,
      writeSentEntry,
      emit: () => undefined,
    });

    const result = await worker.runScanCycle();

    expect(result.skipped).toBe(true);
    expect(writeSentEntry).not.toHaveBeenCalled();
  });

  it('skips silently when readAllNew throws (does not retry SENT)', async () => {
    const outboxFixture = makeFakeOutbox([], {
      readAllNewError: new Error('orbitdb unavailable'),
    });
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const worker = new SentReconciliationWorker(
      makeDeps({ outboxFixture, sentFixture, writeSentEntry, nowMs: 0 }),
    );

    const result = await worker.runScanCycle();

    expect(result.skipped).toBe(true);
    expect(writeSentEntry).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Eligibility filter
  // ---------------------------------------------------------------------------

  it('ignores entries in non-delivered statuses', async () => {
    const entries = [
      makeOutboxEntry({ id: 'sending', status: 'sending', updatedAt: 0 }),
      makeOutboxEntry({ id: 'packaging', status: 'packaging', updatedAt: 0 }),
      makeOutboxEntry({ id: 'finalizing', status: 'finalizing', updatedAt: 0 }),
      makeOutboxEntry({ id: 'failed-transient', status: 'failed-transient', updatedAt: 0 }),
      makeOutboxEntry({ id: 'pinned', status: 'pinned', updatedAt: 0 }),
      makeOutboxEntry({ id: 'finalized', status: 'finalized', updatedAt: 0 }),
      makeOutboxEntry({ id: 'expired', status: 'expired', updatedAt: 0 }),
      makeOutboxEntry({ id: 'delivered-old', status: 'delivered', updatedAt: 0 }),
      makeOutboxEntry({ id: 'delivered-instant-old', status: 'delivered-instant', updatedAt: 0 }),
    ];
    const outboxFixture = makeFakeOutbox(entries);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const worker = new SentReconciliationWorker(
      makeDeps({ outboxFixture, sentFixture, writeSentEntry, nowMs: 1_000_000 }),
    );

    const result = await worker.runScanCycle();

    expect(result.attempted).toBe(2);
    // Both delivered + delivered-instant routed through writeSentEntry.
    expect(writeSentEntry).toHaveBeenCalledTimes(2);
    const calledIds = writeSentEntry.mock.calls.map(
      (c) => (c[0] as UxfTransferOutboxEntry).id,
    );
    expect(calledIds.sort()).toEqual(['delivered-instant-old', 'delivered-old']);
  });

  it('skips delivered entries within the stale threshold', async () => {
    const fresh = makeOutboxEntry({
      id: 'fresh',
      status: 'delivered',
      updatedAt: 999_000,
    });
    const stale = makeOutboxEntry({
      id: 'stale',
      status: 'delivered',
      updatedAt: 900_000,
    });
    const outboxFixture = makeFakeOutbox([fresh, stale]);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        // 1s after `fresh` updated; `stale` is 100s old vs default 30s threshold.
        nowMs: 1_000_000,
      }),
    );

    const result = await worker.runScanCycle();

    expect(result.attempted).toBe(1);
    expect(writeSentEntry).toHaveBeenCalledTimes(1);
    expect((writeSentEntry.mock.calls[0][0] as UxfTransferOutboxEntry).id).toBe(
      'stale',
    );
  });

  // ---------------------------------------------------------------------------
  // already-converged path
  // ---------------------------------------------------------------------------

  it('tombstones OUTBOX without retrying SENT when SENT entry already exists', async () => {
    const entry = makeOutboxEntry({ id: 'already-sent' });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([makeSentEntry({ id: 'already-sent' })]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const recorder = makeEventRecorder();

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
        emit: recorder.emit,
      }),
    );

    const result = await worker.runScanCycle();

    expect(result.attempted).toBe(1);
    expect(result.alreadyConverged).toBe(1);
    expect(result.recovered).toBe(0);
    expect(writeSentEntry).not.toHaveBeenCalled();
    expect(outboxFixture.tombstoned()).toEqual(['already-sent']);
    // No reconciliation event fires on the already-converged path.
    const recovered = recorder.events.filter(
      (e) => e.type === 'transfer:sent-reconciliation-recovered',
    );
    expect(recovered).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // missing-SENT path (the happy recovery path)
  // ---------------------------------------------------------------------------

  it('retries writeSentEntry and tombstones OUTBOX when SENT is missing', async () => {
    const entry = makeOutboxEntry({
      id: 'needs-recovery',
      tokenIds: ['t1', 't2'],
      mode: 'instant',
      status: 'delivered-instant',
    });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const recorder = makeEventRecorder();

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
        emit: recorder.emit,
      }),
    );

    const result = await worker.runScanCycle();

    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(1);
    expect(writeSentEntry).toHaveBeenCalledTimes(1);
    expect(writeSentEntry).toHaveBeenCalledWith(entry, 'sentReconciliationWorker');
    expect(outboxFixture.tombstoned()).toEqual(['needs-recovery']);
    const recovered = recorder.events.filter(
      (e) => e.type === 'transfer:sent-reconciliation-recovered',
    );
    expect(recovered).toHaveLength(1);
    const data = recovered[0].data as {
      outboxId: string;
      tokenIds: ReadonlyArray<string>;
      mode: string;
    };
    expect(data.outboxId).toBe('needs-recovery');
    expect(data.tokenIds).toEqual(['t1', 't2']);
    expect(data.mode).toBe('instant');
  });

  it("treats writeSentEntry='skipped' as a silent skip (no failure count)", async () => {
    const entry = makeOutboxEntry({ id: 'no-writer' });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('skipped');

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
      }),
      { maxRetries: 2 },
    );

    // Even if we run twice as many cycles as maxRetries, the entry is
    // NOT suspended — 'skipped' doesn't count.
    await worker.runScanCycle();
    await worker.runScanCycle();
    await worker.runScanCycle();
    await worker.runScanCycle();

    expect(writeSentEntry).toHaveBeenCalledTimes(4);
    // Entry is still live (no tombstone).
    expect(outboxFixture.entries().get('no-writer')).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Retry budget + suspend
  // ---------------------------------------------------------------------------

  it('emits transfer:sent-reconciliation-failed after maxRetries consecutive failures', async () => {
    const entry = makeOutboxEntry({ id: 'unrecoverable' });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('failed');
    const recorder = makeEventRecorder();

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
        emit: recorder.emit,
      }),
      { maxRetries: 3 },
    );

    // First two cycles fail silently — no event, entry stays live.
    await worker.runScanCycle();
    expect(
      recorder.events.filter(
        (e) => e.type === 'transfer:sent-reconciliation-failed',
      ),
    ).toHaveLength(0);
    expect(outboxFixture.entries().get('unrecoverable')).toBeDefined();

    await worker.runScanCycle();
    expect(
      recorder.events.filter(
        (e) => e.type === 'transfer:sent-reconciliation-failed',
      ),
    ).toHaveLength(0);

    // Third cycle hits maxRetries → emit + suspend.
    const result = await worker.runScanCycle();
    expect(result.suspended).toBe(1);

    const failed = recorder.events.filter(
      (e) => e.type === 'transfer:sent-reconciliation-failed',
    );
    expect(failed).toHaveLength(1);
    const data = failed[0].data as {
      outboxId: string;
      consecutiveFailures: number;
      lastError: string;
    };
    expect(data.outboxId).toBe('unrecoverable');
    expect(data.consecutiveFailures).toBe(3);
    expect(data.lastError).toContain('SENT write returned failed');

    // OUTBOX entry remains live (round-2 forensic-record contract).
    expect(outboxFixture.entries().get('unrecoverable')).toBeDefined();

    // Subsequent cycles do not retry the suspended entry.
    writeSentEntry.mockClear();
    await worker.runScanCycle();
    await worker.runScanCycle();
    expect(writeSentEntry).not.toHaveBeenCalled();
  });

  it('SENT readOne error counts toward maxRetries (does not tombstone)', async () => {
    const entry = makeOutboxEntry({ id: 'sent-read-fail' });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([], { readError: new Error('orbitdb get failed') });
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockResolvedValue('success');
    const recorder = makeEventRecorder();

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
        emit: recorder.emit,
      }),
      { maxRetries: 2 },
    );

    await worker.runScanCycle();
    await worker.runScanCycle();

    // writeSentEntry never invoked — readOne threw before we could
    // classify missing-vs-present.
    expect(writeSentEntry).not.toHaveBeenCalled();
    // OUTBOX entry NEVER tombstoned on read-error path.
    expect(outboxFixture.tombstoned()).toEqual([]);
    // After 2 read-error retries, suspend fires.
    const failed = recorder.events.filter(
      (e) => e.type === 'transfer:sent-reconciliation-failed',
    );
    expect(failed).toHaveLength(1);
  });

  it('writeSentEntry throw counts toward maxRetries the same as returned-failed', async () => {
    const entry = makeOutboxEntry({ id: 'throws' });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi
      .fn<WriteSentEntryFn>()
      .mockRejectedValue(new Error('unexpected throw'));

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
      }),
      { maxRetries: 2 },
    );

    await worker.runScanCycle();
    await worker.runScanCycle();

    expect(writeSentEntry).toHaveBeenCalledTimes(2);
    // OUTBOX still live (no premature tombstone on throw path).
    expect(outboxFixture.tombstoned()).toEqual([]);
  });

  it('successful retry after a transient failure resets the failure counter', async () => {
    const entry = makeOutboxEntry({ id: 'transient' });
    const outboxFixture = makeFakeOutbox([entry]);
    const sentFixture = makeFakeSent([]);
    const writeSentEntry = vi
      .fn<WriteSentEntryFn>()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('success');
    const recorder = makeEventRecorder();

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
        emit: recorder.emit,
      }),
      { maxRetries: 2 },
    );

    await worker.runScanCycle();
    expect(outboxFixture.tombstoned()).toEqual([]);

    await worker.runScanCycle();

    expect(outboxFixture.tombstoned()).toEqual(['transient']);
    // No failure event since the counter reset on success before
    // crossing maxRetries.
    expect(
      recorder.events.filter(
        (e) => e.type === 'transfer:sent-reconciliation-failed',
      ),
    ).toHaveLength(0);
    // One recovery event.
    expect(
      recorder.events.filter(
        (e) => e.type === 'transfer:sent-reconciliation-recovered',
      ),
    ).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Post-recovery tombstone failure
  // ---------------------------------------------------------------------------

  it('post-recovery OUTBOX delete failure is non-fatal; next cycle hits already-converged path', async () => {
    // Setup: writeSentEntry "succeeds" in the test fixture by adding to
    // a side-effect Map (simulating the real SENT writer). On the next
    // cycle, the SENT readOne for that id returns the new entry.
    const entry = makeOutboxEntry({ id: 'tombstone-fails-once' });
    const sentMap = new Map<string, UxfSentLedgerEntry>();
    const outboxFixture = makeFakeOutbox([entry], {
      deleteFailuresBeforeSuccess: 1,
    });
    const sentFixture: FakeSent = {
      reads: () => [],
      sent: {
        async readOne(id) {
          return sentMap.get(id) ?? null;
        },
      },
    };
    const writeSentEntry = vi.fn<WriteSentEntryFn>().mockImplementation(async (e) => {
      sentMap.set(e.id, makeSentEntry({ id: e.id, tokenIds: [...e.tokenIds] }));
      return 'success';
    });
    const recorder = makeEventRecorder();

    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry,
        nowMs: entry.updatedAt + 60_000,
        emit: recorder.emit,
      }),
    );

    // First cycle: SENT write succeeds, tombstone throws.
    const r1 = await worker.runScanCycle();
    expect(r1.recovered).toBe(1);
    expect(writeSentEntry).toHaveBeenCalledTimes(1);
    // Recovery event STILL fires — the SENT write is the durable record.
    expect(
      recorder.events.filter(
        (e) => e.type === 'transfer:sent-reconciliation-recovered',
      ),
    ).toHaveLength(1);
    // OUTBOX entry still present (tombstone failed).
    expect(outboxFixture.entries().get('tombstone-fails-once')).toBeDefined();

    // Second cycle: SENT entry now exists → already-converged path
    // tombstones the OUTBOX entry without another SENT write.
    const r2 = await worker.runScanCycle();
    expect(r2.alreadyConverged).toBe(1);
    expect(writeSentEntry).toHaveBeenCalledTimes(1); // unchanged
    expect(outboxFixture.tombstoned()).toEqual(['tombstone-fails-once']);
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  it('start() is idempotent', async () => {
    const outboxFixture = makeFakeOutbox([]);
    const sentFixture = makeFakeSent([]);
    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry: vi.fn<WriteSentEntryFn>().mockResolvedValue('success'),
        nowMs: 0,
      }),
    );

    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.start();
    expect(worker.isRunning()).toBe(true);

    await worker.stop();
  });

  it('stop() awaits in-flight scan cycle', async () => {
    let resolveScan: (() => void) | null = null;
    const slowOutbox: Pick<OutboxWriter, 'readAllNew' | 'delete'> = {
      async readAllNew(): Promise<ReadonlyArray<UxfTransferOutboxEntry>> {
        await new Promise<void>((resolve) => {
          resolveScan = resolve;
        });
        return [];
      },
      async delete() {
        // unused
      },
    };
    const sentFixture = makeFakeSent([]);
    const worker = new SentReconciliationWorker({
      outboxProvider: () => slowOutbox,
      sentProvider: () => sentFixture.sent,
      writeSentEntry: vi.fn<WriteSentEntryFn>().mockResolvedValue('success'),
      emit: () => undefined,
      now: () => 0,
    });

    worker.start();
    // Advance to fire the first scheduled scan.
    vi.advanceTimersByTime(60_000);
    // Microtask drain so the scan's readAllNew Promise enters its await.
    await Promise.resolve();
    expect(resolveScan).not.toBeNull();

    // Initiate stop — it must wait for the scan to settle.
    let stopped = false;
    const stopP = worker.stop().then(() => {
      stopped = true;
    });

    // stopP should still be pending while readAllNew is suspended.
    await Promise.resolve();
    expect(stopped).toBe(false);

    // Resolve the in-flight scan; stopP must now settle.
    resolveScan!();
    await stopP;
    expect(stopped).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });

  it('stop() is idempotent', async () => {
    const outboxFixture = makeFakeOutbox([]);
    const sentFixture = makeFakeSent([]);
    const worker = new SentReconciliationWorker(
      makeDeps({
        outboxFixture,
        sentFixture,
        writeSentEntry: vi.fn<WriteSentEntryFn>().mockResolvedValue('success'),
        nowMs: 0,
      }),
    );
    worker.start();
    await worker.stop();
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});
