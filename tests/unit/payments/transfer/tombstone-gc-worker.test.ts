/**
 * Tests for `modules/payments/transfer/tombstone-gc-worker.ts`
 * (OUTBOX-SEND-FOLLOWUPS item #4).
 *
 * Covers:
 *  - Cycle wires both writers' `gcExpiredTombstones` and aggregates
 *    counts.
 *  - Null provider for either writer is a per-writer skip (not a
 *    cycle skip); aggregate counts reflect the still-present writer.
 *  - A throw from one writer's gc is contained — the other writer's
 *    sweep still runs and contributes counts.
 *  - retentionMs option is threaded through to the writer call.
 *  - Lifecycle: start/stop idempotent; stop awaits in-flight scan.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TombstoneGcWorker,
  type TombstoneGcWorkerDeps,
} from '../../../../extensions/uxf/pipeline/tombstone-gc-worker';
import type { OutboxWriter } from '../../../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../../../profile/sent-ledger-writer';
import type { TombstoneGcResult } from '../../../../profile/types';

// =============================================================================
// 1. Fixtures
// =============================================================================

type OutboxGc = Pick<OutboxWriter, 'gcExpiredTombstones'>;
type SentGc = Pick<SentLedgerWriter, 'gcExpiredTombstones'>;

interface FakeWriter {
  readonly gc: ReturnType<typeof vi.fn>;
  readonly writer: OutboxGc & SentGc;
}

function makeFakeWriter(
  result: Partial<TombstoneGcResult> = {},
  options?: { readonly throws?: Error },
): FakeWriter {
  const full: TombstoneGcResult = {
    scanned: 0,
    purged: 0,
    kept: 0,
    skipped: false,
    ...result,
  };
  const gc = vi.fn<
    (opts: { retentionMs: number; now?: number }) => Promise<TombstoneGcResult>
  >(async () => {
    if (options?.throws !== undefined) throw options.throws;
    return full;
  });
  return {
    gc,
    writer: { gcExpiredTombstones: gc },
  };
}

function makeDeps(args: {
  readonly outboxFixture?: FakeWriter | null;
  readonly sentFixture?: FakeWriter | null;
  readonly nowMs?: number;
}): TombstoneGcWorkerDeps {
  return {
    outboxProvider: () =>
      args.outboxFixture === null
        ? null
        : (args.outboxFixture?.writer ?? null),
    sentProvider: () =>
      args.sentFixture === null ? null : (args.sentFixture?.writer ?? null),
    logger: { warn: () => undefined, info: () => undefined },
    now: args.nowMs !== undefined ? (): number => args.nowMs! : Date.now,
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('TombstoneGcWorker (OUTBOX-SEND-FOLLOWUPS item #4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates counts from both writers', async () => {
    const outboxFixture = makeFakeWriter({ scanned: 3, purged: 2, kept: 1 });
    const sentFixture = makeFakeWriter({ scanned: 5, purged: 4, kept: 1 });
    const worker = new TombstoneGcWorker(
      makeDeps({ outboxFixture, sentFixture }),
    );

    const result = await worker.runScanCycle();

    expect(result.outbox).toMatchObject({ scanned: 3, purged: 2, kept: 1 });
    expect(result.sent).toMatchObject({ scanned: 5, purged: 4, kept: 1 });
    expect(result.scanned).toBe(8);
    expect(result.purged).toBe(6);
    expect(result.kept).toBe(2);
  });

  it('null outbox provider → outbox skipped; sent sweep still runs', async () => {
    const sentFixture = makeFakeWriter({ scanned: 2, purged: 1, kept: 1 });
    const worker = new TombstoneGcWorker(
      makeDeps({ outboxFixture: null, sentFixture }),
    );

    const result = await worker.runScanCycle();

    expect(result.outbox.skipped).toBe(true);
    expect(result.outbox.scanned).toBe(0);
    expect(result.sent.scanned).toBe(2);
    expect(sentFixture.gc).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(2);
  });

  it('null sent provider → sent skipped; outbox sweep still runs', async () => {
    const outboxFixture = makeFakeWriter({ scanned: 7, purged: 6, kept: 1 });
    const worker = new TombstoneGcWorker(
      makeDeps({ outboxFixture, sentFixture: null }),
    );

    const result = await worker.runScanCycle();

    expect(result.sent.skipped).toBe(true);
    expect(result.outbox.scanned).toBe(7);
    expect(result.purged).toBe(6);
  });

  it("contains a writer's throw: aggregate cycle still completes; other writer still contributes", async () => {
    const outboxFixture = makeFakeWriter(
      {},
      { throws: new Error('orbitdb-down') },
    );
    const sentFixture = makeFakeWriter({ scanned: 2, purged: 1, kept: 1 });
    const worker = new TombstoneGcWorker(
      makeDeps({ outboxFixture, sentFixture }),
    );

    const result = await worker.runScanCycle();

    // The throwing outbox is treated as skipped.
    expect(result.outbox.skipped).toBe(true);
    expect(result.outbox.purged).toBe(0);
    // The sent sweep still ran and contributed.
    expect(result.sent.purged).toBe(1);
    expect(result.purged).toBe(1);
  });

  it('threads retentionMs option through to the writer', async () => {
    const outboxFixture = makeFakeWriter();
    const sentFixture = makeFakeWriter();
    const worker = new TombstoneGcWorker(
      makeDeps({ outboxFixture, sentFixture, nowMs: 1_000_000 }),
      { retentionMs: 12_345 },
    );

    await worker.runScanCycle();

    expect(outboxFixture.gc).toHaveBeenCalledWith({
      retentionMs: 12_345,
      now: 1_000_000,
    });
    expect(sentFixture.gc).toHaveBeenCalledWith({
      retentionMs: 12_345,
      now: 1_000_000,
    });
  });

  it('start() is idempotent', async () => {
    const worker = new TombstoneGcWorker(makeDeps({ nowMs: 0 }));
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    await worker.stop();
  });

  it('stop() is idempotent', async () => {
    const worker = new TombstoneGcWorker(makeDeps({ nowMs: 0 }));
    worker.start();
    await worker.stop();
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('stop() awaits in-flight scan cycle', async () => {
    let resolveGc: (() => void) | null = null;
    const slowOutbox: OutboxGc = {
      async gcExpiredTombstones(): Promise<TombstoneGcResult> {
        await new Promise<void>((resolve) => {
          resolveGc = resolve;
        });
        return { scanned: 0, purged: 0, kept: 0, skipped: false };
      },
    };
    const worker = new TombstoneGcWorker(
      {
        outboxProvider: () => slowOutbox,
        sentProvider: () => null,
        logger: { warn: () => undefined },
        now: (): number => 0,
      },
      { intervalMs: 1_000 },
    );

    worker.start();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(resolveGc).not.toBeNull();

    let stopped = false;
    const stopP = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveGc!();
    await stopP;
    expect(stopped).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });
});
