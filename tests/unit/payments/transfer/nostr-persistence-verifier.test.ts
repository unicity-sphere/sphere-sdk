/**
 * Tests for `modules/payments/transfer/nostr-persistence-verifier.ts`
 * (Issue #166 P2 #3).
 *
 * Covers:
 *  - No-op when SENT provider returns null OR readAll throws
 *  - Eligibility filter: requires nostrEventId set + past verifyDelayMs
 *    + not already checked
 *  - Outcome handling: retained/missing/unverifiable each route
 *    correctly (set update, event emission, retry semantics)
 *  - Verify throw degrades to 'unverifiable' (no false-positive
 *    warning)
 *  - maxScanPerCycle caps relay query load per cycle (oldest-first)
 *  - Already-classified entries are skipped on subsequent cycles
 *  - emitRetentionWarning failure is swallowed (logged only)
 *  - start/stop idempotent; stop() awaits in-flight scan
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  NostrPersistenceVerifier,
  type NostrPersistenceVerifierDeps,
  type VerifyOutcome,
  type VerifySentEntryFn,
} from '../../../../modules/payments/transfer/nostr-persistence-verifier';
import type { SentLedgerWriter } from '../../../../profile/sent-ledger-writer';
import type { SphereEventMap, SphereEventType } from '../../../../types';
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

function makeSentEntry(
  overrides: Partial<UxfSentLedgerEntry> = {},
): UxfSentLedgerEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: overrides.id ?? 'sent-1',
    tokenIds: overrides.tokenIds ?? ['token-1'],
    bundleCid: 'bafy-bundle',
    recipientTransportPubkey: 'recipient-pk',
    recipient: '@bob',
    deliveryMethod: 'car-over-nostr',
    mode: 'conservative',
    sentAt: 1_700_000_000_000,
    lamport: 5,
    nostrEventId: 'event-1',
    ...overrides,
  };
}

interface FakeSent {
  readonly sent: Pick<SentLedgerWriter, 'readAll'>;
  readonly readAllCalls: () => number;
}

function makeFakeSent(
  initial: ReadonlyArray<UxfSentLedgerEntry>,
  options?: { readonly readAllError?: Error },
): FakeSent {
  let calls = 0;
  return {
    readAllCalls: () => calls,
    sent: {
      async readAll() {
        calls += 1;
        if (options?.readAllError) throw options.readAllError;
        return [...initial];
      },
    },
  };
}

function makeDeps(args: {
  readonly sentFixture: FakeSent | null;
  readonly verify: VerifySentEntryFn;
  readonly nowMs?: number;
  readonly emit?: NostrPersistenceVerifierDeps['emit'];
}): NostrPersistenceVerifierDeps {
  return {
    sentProvider: () => (args.sentFixture === null ? null : args.sentFixture.sent),
    verify: args.verify,
    emit: args.emit ?? ((): void => undefined),
    logger: { warn: () => undefined, info: () => undefined },
    now: args.nowMs !== undefined ? (): number => args.nowMs! : Date.now,
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('NostrPersistenceVerifier (Issue #166 P2 #3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // No-op / skip paths
  // ---------------------------------------------------------------------------

  it('skips silently when SENT provider returns null', async () => {
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('retained');
    const worker = new NostrPersistenceVerifier(
      makeDeps({ sentFixture: null, verify, nowMs: 0 }),
    );

    const result = await worker.runScanCycle();

    expect(result.skipped).toBe(true);
    expect(result.attempted).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it('skips silently when readAll throws', async () => {
    const sentFixture = makeFakeSent([], {
      readAllError: new Error('orbitdb-down'),
    });
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('retained');
    const worker = new NostrPersistenceVerifier(
      makeDeps({ sentFixture, verify, nowMs: 0 }),
    );

    const result = await worker.runScanCycle();

    expect(result.skipped).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Eligibility filter
  // ---------------------------------------------------------------------------

  it('ignores entries without nostrEventId', async () => {
    const entries = [
      makeSentEntry({ id: 'with-id', sentAt: 1_000_000 }),
      makeSentEntry({ id: 'no-id', sentAt: 1_000_000, nostrEventId: undefined }),
    ];
    const sentFixture = makeFakeSent(entries);
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('retained');
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        nowMs: 1_000_000 + 10 * 60 * 1000, // way past verify delay
      }),
    );

    const result = await worker.runScanCycle();

    expect(result.attempted).toBe(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'with-id' }),
    );
  });

  it('skips entries within the verify delay window', async () => {
    const fresh = makeSentEntry({ id: 'fresh', sentAt: 1_000_000 });
    const stale = makeSentEntry({ id: 'stale', sentAt: 800_000 });
    const sentFixture = makeFakeSent([fresh, stale]);
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('retained');
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        // 1 min after `fresh` sent — well under default 5 min delay.
        // `stale` is 4 min old which is ALSO under 5 min default,
        // so neither would qualify with defaults. Override the
        // verifyDelay to 90s so only `stale` qualifies.
        nowMs: 1_060_000,
      }),
      { verifyDelayMs: 90_000 },
    );

    const result = await worker.runScanCycle();

    expect(result.attempted).toBe(1);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stale' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Outcome routing
  // ---------------------------------------------------------------------------

  it("marks entry checked on 'retained' (no event emitted)", async () => {
    const entry = makeSentEntry({ id: 'retained-1' });
    const sentFixture = makeFakeSent([entry]);
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('retained');
    const recorder = makeEventRecorder();
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        nowMs: entry.sentAt + 10 * 60 * 1000,
        emit: recorder.emit,
      }),
    );

    const r1 = await worker.runScanCycle();
    expect(r1.retained).toBe(1);
    expect(recorder.events).toHaveLength(0);

    // Second cycle skips the now-checked entry.
    verify.mockClear();
    const r2 = await worker.runScanCycle();
    expect(r2.attempted).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it("emits transfer:retention-warning on 'missing'; marks entry checked", async () => {
    const entry = makeSentEntry({
      id: 'missing-1',
      tokenIds: ['t1', 't2'],
      nostrEventId: 'evt-xyz',
      bundleCid: 'bafy-missing',
      recipientTransportPubkey: 'rpk',
    });
    const sentFixture = makeFakeSent([entry]);
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('missing');
    const recorder = makeEventRecorder();
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        nowMs: entry.sentAt + 10 * 60 * 1000,
        emit: recorder.emit,
      }),
    );

    const r1 = await worker.runScanCycle();
    expect(r1.missing).toBe(1);

    const warnings = recorder.events.filter(
      (e) => e.type === 'transfer:retention-warning',
    );
    expect(warnings).toHaveLength(1);
    const data = warnings[0].data as {
      sentId: string;
      nostrEventId: string;
      bundleCid: string;
      tokenIds: ReadonlyArray<string>;
      recipientTransportPubkey: string;
    };
    expect(data.sentId).toBe('missing-1');
    expect(data.nostrEventId).toBe('evt-xyz');
    expect(data.bundleCid).toBe('bafy-missing');
    expect(data.tokenIds).toEqual(['t1', 't2']);
    expect(data.recipientTransportPubkey).toBe('rpk');

    // Second cycle skips the now-classified entry — no double warning.
    verify.mockClear();
    recorder.clear();
    await worker.runScanCycle();
    expect(verify).not.toHaveBeenCalled();
    expect(recorder.events).toHaveLength(0);
  });

  it("retries 'unverifiable' on next cycle (does NOT mark checked)", async () => {
    const entry = makeSentEntry({ id: 'maybe-1' });
    const sentFixture = makeFakeSent([entry]);
    const verify = vi
      .fn<VerifySentEntryFn>()
      .mockResolvedValueOnce('unverifiable')
      .mockResolvedValueOnce('unverifiable')
      .mockResolvedValueOnce('retained');
    const recorder = makeEventRecorder();
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        nowMs: entry.sentAt + 10 * 60 * 1000,
        emit: recorder.emit,
      }),
    );

    const r1 = await worker.runScanCycle();
    expect(r1.unverifiable).toBe(1);
    expect(r1.retained).toBe(0);

    const r2 = await worker.runScanCycle();
    expect(r2.unverifiable).toBe(1);
    expect(r2.retained).toBe(0);

    const r3 = await worker.runScanCycle();
    expect(r3.unverifiable).toBe(0);
    expect(r3.retained).toBe(1);

    expect(verify).toHaveBeenCalledTimes(3);
    // No retention warning fired across the three cycles.
    expect(
      recorder.events.filter((e) => e.type === 'transfer:retention-warning'),
    ).toHaveLength(0);
  });

  it("verify throw degrades to 'unverifiable' (no false-positive warning)", async () => {
    const entry = makeSentEntry({ id: 'throws' });
    const sentFixture = makeFakeSent([entry]);
    const verify = vi
      .fn<VerifySentEntryFn>()
      .mockRejectedValue(new Error('unexpected'));
    const recorder = makeEventRecorder();
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        nowMs: entry.sentAt + 10 * 60 * 1000,
        emit: recorder.emit,
      }),
    );

    const r = await worker.runScanCycle();

    expect(r.unverifiable).toBe(1);
    expect(r.missing).toBe(0);
    // No retention warning — the verify throw is NOT treated as missing.
    expect(
      recorder.events.filter((e) => e.type === 'transfer:retention-warning'),
    ).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // maxScanPerCycle cap (oldest-first)
  // ---------------------------------------------------------------------------

  it('caps verify calls per cycle and processes oldest entries first', async () => {
    const entries = [
      makeSentEntry({ id: 'newest', sentAt: 3_000, nostrEventId: 'e-3' }),
      makeSentEntry({ id: 'middle', sentAt: 2_000, nostrEventId: 'e-2' }),
      makeSentEntry({ id: 'oldest', sentAt: 1_000, nostrEventId: 'e-1' }),
    ];
    const sentFixture = makeFakeSent(entries);
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('retained');
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        // All 3 are past 1s verify delay.
        nowMs: 100_000,
      }),
      { verifyDelayMs: 1_000, maxScanPerCycle: 2 },
    );

    const r1 = await worker.runScanCycle();
    expect(r1.attempted).toBe(2);
    expect(r1.eligibleTotal).toBe(3);
    const firstCallIds = verify.mock.calls.map(
      (c) => (c[0] as UxfSentLedgerEntry).id,
    );
    expect(firstCallIds).toEqual(['oldest', 'middle']);

    // Next cycle picks up the remaining 'newest' entry.
    verify.mockClear();
    const r2 = await worker.runScanCycle();
    expect(r2.attempted).toBe(1);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'newest' }),
    );
  });

  // ---------------------------------------------------------------------------
  // Emit failure semantics
  // ---------------------------------------------------------------------------

  it('emit() rejection does not crash the cycle', async () => {
    const entry = makeSentEntry({ id: 'em-fail' });
    const sentFixture = makeFakeSent([entry]);
    const verify = vi.fn<VerifySentEntryFn>().mockResolvedValue('missing');
    const throwingEmit = vi
      .fn<NostrPersistenceVerifierDeps['emit']>()
      .mockRejectedValue(new Error('emit failed'));
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify,
        nowMs: entry.sentAt + 10 * 60 * 1000,
        emit: throwingEmit,
      }),
    );

    const r = await worker.runScanCycle();

    // Cycle completed successfully despite emit rejection.
    expect(r.missing).toBe(1);
    expect(throwingEmit).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  it('start() is idempotent', async () => {
    const sentFixture = makeFakeSent([]);
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify: vi.fn<VerifySentEntryFn>().mockResolvedValue('retained'),
        nowMs: 0,
      }),
    );

    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.start();
    expect(worker.isRunning()).toBe(true);

    await worker.stop();
  });

  it('stop() is idempotent', async () => {
    const sentFixture = makeFakeSent([]);
    const worker = new NostrPersistenceVerifier(
      makeDeps({
        sentFixture,
        verify: vi.fn<VerifySentEntryFn>().mockResolvedValue('retained'),
        nowMs: 0,
      }),
    );
    worker.start();
    await worker.stop();
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('stop() awaits in-flight scan cycle', async () => {
    let resolveScan: (() => void) | null = null;
    const slowSent: Pick<SentLedgerWriter, 'readAll'> = {
      async readAll(): Promise<ReadonlyArray<UxfSentLedgerEntry>> {
        await new Promise<void>((resolve) => {
          resolveScan = resolve;
        });
        return [];
      },
    };
    const worker = new NostrPersistenceVerifier({
      sentProvider: () => slowSent,
      verify: vi.fn<VerifySentEntryFn>().mockResolvedValue('retained'),
      emit: () => undefined,
      now: () => 0,
    });

    worker.start();
    vi.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();
    expect(resolveScan).not.toBeNull();

    let stopped = false;
    const stopP = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveScan!();
    await stopP;
    expect(stopped).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });
});

// =============================================================================
// 3. VerifyOutcome type smoke test
// =============================================================================

describe('VerifyOutcome (Issue #166 P2 #3)', () => {
  it('compiles with the three documented outcomes', () => {
    const outcomes: VerifyOutcome[] = ['retained', 'missing', 'unverifiable'];
    expect(outcomes).toHaveLength(3);
  });
});
