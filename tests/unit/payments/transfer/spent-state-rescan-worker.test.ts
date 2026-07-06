/**
 * Tests for `modules/payments/transfer/spent-state-rescan-worker.ts`
 * (Issue #174 — per-token spent-state rescan, UXF-TRANSFER-PROTOCOL §12.3.2).
 *
 * Covers:
 *  - No-op when oracleProvider returns null
 *  - Eligibility filter: status='confirmed' only; skips tokens with
 *    no sdkData / unparseable state hash; skips OUTBOX-active tokens;
 *    skips tokens still within `perTokenIntervalMs` window
 *  - Outcome routing:
 *    - isSpent=true → event emitted with suspectedSiblingInstance
 *      derived from SENT + OUTBOX presence; transitionToAudit invoked
 *    - isSpent=false → no event, lastCheckedAt updated
 *    - oracle.isSpent throw → no event, throw counter bumped, back-off
 *      applied after threshold
 *  - suspectedSiblingInstance branches (true/false based on local
 *    OUTBOX/SENT state)
 *  - Concurrency cap respected (≤ maxConcurrent simultaneous probes)
 *  - Lifecycle: start/stop idempotent; stop() awaits in-flight scan;
 *    timer-driven cycle (fake timers)
 *  - emit() throw doesn't crash the cycle; transitionToAudit throw
 *    doesn't crash either (event already fired)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  SpentStateRescanWorker,
  type SpentStateRescanWorkerDeps,
  type TransitionToAuditFn,
} from '../../../../extensions/uxf/pipeline/spent-state-rescan-worker';
import type { OutboxWriter } from '../../../../extensions/uxf/profile/outbox-writer';
import type { SentLedgerWriter } from '../../../../extensions/uxf/profile/sent-ledger-writer';
import type { SphereEventMap, SphereEventType, Token } from '../../../../types';

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

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: overrides.id ?? 'tok-1',
    coinId: overrides.coinId ?? 'UCT-coin',
    symbol: overrides.symbol ?? 'UCT',
    name: overrides.name ?? 'Unicity',
    decimals: overrides.decimals ?? 8,
    amount: overrides.amount ?? '1000',
    status: overrides.status ?? 'confirmed',
    createdAt: overrides.createdAt ?? 1_000_000,
    updatedAt: overrides.updatedAt ?? 1_000_000,
    sdkData: overrides.sdkData ?? '{"genesis":{},"state":{}}',
    ...overrides,
  };
}

interface FakeOracle {
  // Issue #245 #1 — isSpent receives the token so callers can derive
  // per-token publicKey from token.sdkData (the PaymentsModule wrapper
  // does this). Test fakes ignore the token and key on stateHash only.
  readonly isSpent: (token: Token, stateHash: string) => Promise<boolean>;
  readonly calls: () => ReadonlyArray<string>;
}

function makeOracle(
  outcomes: Map<string, boolean | Error> | ((stateHash: string) => boolean | Error),
): FakeOracle {
  const calls: string[] = [];
  const resolve = typeof outcomes === 'function'
    ? outcomes
    : (sh: string): boolean | Error => {
        const o = outcomes.get(sh);
        if (o === undefined) {
          throw new Error(`unmapped stateHash in fixture: ${sh}`);
        }
        return o;
      };
  return {
    calls: () => calls,
    async isSpent(_token: Token, stateHash: string): Promise<boolean> {
      calls.push(stateHash);
      const o = resolve(stateHash);
      if (o instanceof Error) throw o;
      return o;
    },
  };
}

interface FakeSent {
  readonly writer: Pick<SentLedgerWriter, 'contains'>;
  readonly hits: Set<string>;
}

function makeSent(hitTokenIds: ReadonlyArray<string> = []): FakeSent {
  const hits = new Set(hitTokenIds);
  return {
    hits,
    writer: {
      async contains(tokenId: string): Promise<boolean> {
        return hits.has(tokenId);
      },
    },
  };
}

interface FakeOutbox {
  readonly writer: Pick<OutboxWriter, 'readAll'>;
  readonly entries: Array<{ entry: { tokenIds: ReadonlyArray<string> } }>;
}

function makeOutbox(entryTokenIds: ReadonlyArray<ReadonlyArray<string>> = []): FakeOutbox {
  const entries = entryTokenIds.map((tokenIds) => ({
    entry: { tokenIds },
  }));
  return {
    entries,
    writer: {
      // Type assertion: we only need the tokenIds shape; OutboxWriter
      // surfaces the ClassifiedOutboxEntry discriminator we ignore here.
      readAll: (async () => entries) as unknown as OutboxWriter['readAll'],
    },
  };
}

interface FakeAudit {
  readonly fn: TransitionToAuditFn;
  readonly calls: ReadonlyArray<{
    tokenId: string;
    stateHash: string;
    suspectedSiblingInstance: boolean;
  }>;
}

function makeAudit(options?: { readonly shouldThrow?: Error }): FakeAudit {
  const calls: Array<{
    tokenId: string;
    stateHash: string;
    suspectedSiblingInstance: boolean;
  }> = [];
  return {
    calls,
    fn: async (params): Promise<void> => {
      calls.push({
        tokenId: params.token.id,
        stateHash: params.currentStateHash,
        suspectedSiblingInstance: params.suspectedSiblingInstance,
      });
      if (options?.shouldThrow) throw options.shouldThrow;
    },
  };
}

function makeDeps(args: {
  readonly tokens: ReadonlyArray<Token>;
  readonly oracle: FakeOracle | null;
  readonly stateHashFor?: (token: Token) => string;
  readonly sent?: FakeSent | null;
  readonly outbox?: FakeOutbox | null;
  readonly audit?: FakeAudit;
  readonly emit?: SpentStateRescanWorkerDeps['emit'];
  readonly nowMs?: number;
}): SpentStateRescanWorkerDeps {
  const deps: SpentStateRescanWorkerDeps = {
    tokensProvider: () => args.tokens,
    oracleProvider: () => (args.oracle === null ? null : args.oracle),
    extractCurrentStateHash: args.stateHashFor ?? ((t): string => `hash-${t.id}`),
    emit: args.emit ?? ((): void => undefined),
    logger: { warn: () => undefined, info: () => undefined },
    now: args.nowMs !== undefined ? (): number => args.nowMs! : Date.now,
    ...(args.sent !== undefined
      ? { sentProvider: () => (args.sent === null ? null : args.sent.writer) }
      : {}),
    ...(args.outbox !== undefined
      ? {
          outboxProvider: () =>
            args.outbox === null ? null : args.outbox.writer,
        }
      : {}),
    ...(args.audit !== undefined ? { transitionToAudit: args.audit.fn } : {}),
  };
  return deps;
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('SpentStateRescanWorker — basics (Issue #174)', () => {
  it('skips when oracleProvider returns null', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const recorder = makeEventRecorder();
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens, oracle: null, emit: recorder.emit }),
    );
    const r = await worker.runScanCycle();
    expect(r.skipped).toBe(true);
    expect(r.probed).toBe(0);
    expect(recorder.events).toHaveLength(0);
  });

  it('skips tokens with non-confirmed status', async () => {
    const tokens = [
      makeToken({ id: 't-pending', status: 'pending' }),
      makeToken({ id: 't-transferring', status: 'transferring' }),
      makeToken({ id: 't-confirmed', status: 'confirmed' }),
    ];
    const oracle = makeOracle(new Map([['hash-t-confirmed', false]]));
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens, oracle, nowMs: 1_000_000 }),
    );
    const r = await worker.runScanCycle();
    expect(r.eligibleTotal).toBe(1);
    expect(oracle.calls()).toEqual(['hash-t-confirmed']);
  });

  it('skips tokens without parseable sdkData / empty state hash', async () => {
    const tokens = [
      makeToken({ id: 't-no-sdk', sdkData: undefined }),
      makeToken({ id: 't-empty-sdk', sdkData: '' }),
      makeToken({ id: 't-no-hash', sdkData: '{"genesis":{}}' }),
      makeToken({ id: 't-ok' }),
    ];
    const oracle = makeOracle(new Map([['hash-t-ok', false]]));
    const stateHashFor = (token: Token): string =>
      token.id === 't-no-hash' ? '' : `hash-${token.id}`;
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens, oracle, stateHashFor, nowMs: 1_000_000 }),
    );
    const r = await worker.runScanCycle();
    expect(r.eligibleTotal).toBe(1);
    expect(oracle.calls()).toEqual(['hash-t-ok']);
  });

  it('skips tokens with an active OUTBOX entry', async () => {
    const tokens = [
      makeToken({ id: 't-active' }),
      makeToken({ id: 't-quiet' }),
    ];
    const oracle = makeOracle(
      new Map([
        ['hash-t-quiet', false],
      ]),
    );
    const outbox = makeOutbox([['t-active']]);
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens, oracle, outbox, nowMs: 1_000_000 }),
    );
    const r = await worker.runScanCycle();
    expect(r.eligibleTotal).toBe(1);
    expect(oracle.calls()).toEqual(['hash-t-quiet']);
  });

  it('respects per-token interval (skip within window)', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', false]]));
    let mockNow = 1_000_000;
    const deps = makeDeps({
      tokens,
      oracle,
      nowMs: mockNow,
    });
    // Override `now` so we can advance it between cycles.
    const worker = new SpentStateRescanWorker({
      ...deps,
      now: () => mockNow,
    });

    // First cycle probes the token.
    await worker.runScanCycle();
    expect(oracle.calls()).toHaveLength(1);

    // Advance well under perTokenIntervalMs (default 5 min).
    mockNow += 60_000; // +1 min
    await worker.runScanCycle();
    expect(oracle.calls()).toHaveLength(1); // no new probe

    // Advance past the per-token interval.
    mockNow += 5 * 60 * 1000;
    await worker.runScanCycle();
    expect(oracle.calls()).toHaveLength(2);
  });
});

describe('SpentStateRescanWorker — outcomes (Issue #174)', () => {
  it('isSpent=false → no event, lastCheckedAt updates', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', false]]));
    const recorder = makeEventRecorder();
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens, oracle, emit: recorder.emit, nowMs: 1_000_000 }),
    );
    const r = await worker.runScanCycle();
    expect(r.unspent).toBe(1);
    expect(r.spent).toBe(0);
    expect(recorder.events).toHaveLength(0);
  });

  it('isSpent=true → fires transfer:off-record-spent with payload + transitionToAudit', async () => {
    const tokens = [
      makeToken({ id: 't1', coinId: 'UCT-coin', amount: '12345' }),
    ];
    const oracle = makeOracle(new Map([['hash-t1', true]]));
    const recorder = makeEventRecorder();
    const audit = makeAudit();
    const worker = new SpentStateRescanWorker(
      makeDeps({
        tokens,
        oracle,
        emit: recorder.emit,
        audit,
        nowMs: 9_876_543,
      }),
    );

    const r = await worker.runScanCycle();
    expect(r.spent).toBe(1);

    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    const data = fired[0].data as {
      tokenId: string;
      detectedAt: number;
      suspectedSiblingInstance: boolean;
      coinId: string;
      amount: string;
    };
    expect(data.tokenId).toBe('t1');
    expect(data.detectedAt).toBe(9_876_543);
    expect(data.coinId).toBe('UCT-coin');
    expect(data.amount).toBe('12345');
    // No SENT / OUTBOX wired → conservatively true.
    expect(data.suspectedSiblingInstance).toBe(true);

    // transitionToAudit invoked with the same flags.
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0].tokenId).toBe('t1');
    expect(audit.calls[0].stateHash).toBe('hash-t1');
    expect(audit.calls[0].suspectedSiblingInstance).toBe(true);
  });

  it('isSpent=true with local SENT entry → suspectedSiblingInstance=false', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', true]]));
    const sent = makeSent(['t1']);
    const recorder = makeEventRecorder();
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens, oracle, sent, emit: recorder.emit, nowMs: 1 }),
    );
    await worker.runScanCycle();
    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    const data = fired[0].data as { suspectedSiblingInstance: boolean };
    expect(data.suspectedSiblingInstance).toBe(false);
  });

  it('isSpent=true with local OUTBOX entry → suspectedSiblingInstance=false', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', true]]));
    // OUTBOX-active filter would normally exclude this. To test the
    // post-detection path, we need the token to PASS the eligibility
    // filter (no live OUTBOX entry at cycle start) AND fail the
    // suspectedSiblingInstance check (we look at OUTBOX again at the
    // detection moment).
    //
    // Trick: use a separate OUTBOX fixture that returns the entry
    // only on the SECOND readAll call (cycle-start exclusion uses
    // call #1; suspectedSiblingInstance uses call #2).
    let calls = 0;
    const outboxWriter = {
      async readAll(): Promise<ReadonlyArray<{ entry: { tokenIds: string[] } }>> {
        calls += 1;
        if (calls === 1) return [];
        return [{ entry: { tokenIds: ['t1'] } }];
      },
    } as unknown as OutboxWriter;
    const recorder = makeEventRecorder();
    const worker = new SpentStateRescanWorker({
      tokensProvider: () => tokens,
      oracleProvider: () => oracle,
      extractCurrentStateHash: (t): string => `hash-${t.id}`,
      emit: recorder.emit,
      outboxProvider: () => outboxWriter,
      logger: { warn: () => undefined },
      now: () => 1,
    });
    await worker.runScanCycle();
    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    const data = fired[0].data as { suspectedSiblingInstance: boolean };
    expect(data.suspectedSiblingInstance).toBe(false);
  });

  it('oracle.isSpent throw → no event, throw counter bumped, eventually backs off', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', new Error('aggregator-down')]]));
    const recorder = makeEventRecorder();
    let mockNow = 1_000_000;
    const audit = makeAudit();
    const worker = new SpentStateRescanWorker(
      {
        tokensProvider: () => tokens,
        oracleProvider: () => oracle,
        extractCurrentStateHash: (t): string => `hash-${t.id}`,
        emit: recorder.emit,
        transitionToAudit: audit.fn,
        logger: { warn: () => undefined },
        now: () => mockNow,
      },
      {
        consecutiveThrowBackoffThreshold: 2,
        throwBackoffMs: 10 * 60 * 1000, // 10 min back-off
        perTokenIntervalMs: 0, // remove interval gate so throws repeat
      },
    );

    // First throw — counter = 1 (under threshold).
    let r = await worker.runScanCycle();
    expect(r.threw).toBe(1);
    expect(oracle.calls()).toHaveLength(1);

    // Second throw — counter = 2 (= threshold), back-off applied.
    r = await worker.runScanCycle();
    expect(r.threw).toBe(1);
    expect(oracle.calls()).toHaveLength(2);

    // Third cycle, within back-off window — token filtered out.
    mockNow += 1_000; // tiny advance, still in back-off
    r = await worker.runScanCycle();
    expect(r.eligibleTotal).toBe(0);
    expect(oracle.calls()).toHaveLength(2);

    // Advance past back-off — token re-eligible.
    mockNow += 10 * 60 * 1000;
    r = await worker.runScanCycle();
    expect(r.eligibleTotal).toBe(1);
    expect(oracle.calls()).toHaveLength(3);

    // No events fired across any cycle.
    expect(recorder.events).toHaveLength(0);
    expect(audit.calls).toHaveLength(0);
  });

  it('successful probe clears the throw counter', async () => {
    const tokens = [makeToken({ id: 't1' })];
    let throwNext = true;
    const oracle = {
      isSpent: vi.fn(async (_token: Token, _sh: string) => {
        if (throwNext) throw new Error('flake');
        return false;
      }),
    };
    let mockNow = 1_000_000;
    const worker = new SpentStateRescanWorker(
      {
        tokensProvider: () => tokens,
        oracleProvider: () => oracle,
        extractCurrentStateHash: (t): string => `hash-${t.id}`,
        emit: (): void => undefined,
        logger: { warn: () => undefined },
        now: () => mockNow,
      },
      {
        consecutiveThrowBackoffThreshold: 3,
        perTokenIntervalMs: 0,
      },
    );

    await worker.runScanCycle(); // throws (counter=1)
    await worker.runScanCycle(); // throws (counter=2)
    throwNext = false;
    await worker.runScanCycle(); // success → counter reset
    throwNext = true;
    await worker.runScanCycle(); // throws (counter=1 again — back to 0+1)

    expect(oracle.isSpent).toHaveBeenCalledTimes(4);
    // No back-off should have been triggered — final cycle was at
    // counter=1, threshold=3.
    // Advance below back-off interval — token still eligible.
    mockNow += 100;
    const r = await worker.runScanCycle();
    expect(r.eligibleTotal).toBe(1); // throw counter didn't trigger back-off
  });
});

describe('SpentStateRescanWorker — concurrency cap (Issue #174)', () => {
  it('caps simultaneous probes at maxConcurrent (4 default)', async () => {
    const tokens = Array.from({ length: 12 }, (_, i) =>
      makeToken({ id: `t-${i}` }),
    );
    let inFlight = 0;
    let peak = 0;
    const oracle = {
      isSpent: async (_token: Token, _sh: string): Promise<boolean> => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        // Yield so we can observe concurrent in-flights.
        await new Promise<void>((r) => setTimeout(r, 0));
        inFlight -= 1;
        return false;
      },
    };
    const worker = new SpentStateRescanWorker(
      {
        tokensProvider: () => tokens,
        oracleProvider: () => oracle,
        extractCurrentStateHash: (t): string => `hash-${t.id}`,
        emit: (): void => undefined,
        logger: { warn: () => undefined },
        now: () => 1,
      },
      { maxConcurrent: 4 },
    );
    const r = await worker.runScanCycle();
    expect(r.probed).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });
});

describe('SpentStateRescanWorker — emit / transitionToAudit failures (Issue #174)', () => {
  it('emit() throw does not crash the cycle (transition still fires)', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', true]]));
    const audit = makeAudit();
    const throwingEmit = vi
      .fn<SpentStateRescanWorkerDeps['emit']>()
      .mockRejectedValue(new Error('emit boom'));
    const worker = new SpentStateRescanWorker(
      makeDeps({
        tokens,
        oracle,
        audit,
        emit: throwingEmit,
        nowMs: 1,
      }),
    );
    const r = await worker.runScanCycle();
    expect(r.spent).toBe(1);
    expect(audit.calls).toHaveLength(1);
  });

  it('transitionToAudit throw does not crash the cycle (event already fired)', async () => {
    const tokens = [makeToken({ id: 't1' })];
    const oracle = makeOracle(new Map([['hash-t1', true]]));
    const audit = makeAudit({ shouldThrow: new Error('audit boom') });
    const recorder = makeEventRecorder();
    const worker = new SpentStateRescanWorker(
      makeDeps({
        tokens,
        oracle,
        audit,
        emit: recorder.emit,
        nowMs: 1,
      }),
    );
    const r = await worker.runScanCycle();
    expect(r.spent).toBe(1);
    expect(
      recorder.events.filter((e) => e.type === 'transfer:off-record-spent'),
    ).toHaveLength(1);
  });
});

describe('SpentStateRescanWorker — lifecycle (Issue #174)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() is idempotent', async () => {
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens: [], oracle: null }),
    );
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    await worker.stop();
  });

  it('stop() is idempotent', async () => {
    const worker = new SpentStateRescanWorker(
      makeDeps({ tokens: [], oracle: null }),
    );
    worker.start();
    await worker.stop();
    await worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('stop() awaits in-flight scan cycle', async () => {
    let resolveProbe: ((v: boolean) => void) | null = null;
    const oracle = {
      isSpent: (_token: Token, _sh: string): Promise<boolean> =>
        new Promise<boolean>((r) => {
          resolveProbe = r;
        }),
    };
    const tokens = [makeToken({ id: 't1' })];
    const worker = new SpentStateRescanWorker({
      tokensProvider: () => tokens,
      oracleProvider: () => oracle,
      extractCurrentStateHash: (t): string => `hash-${t.id}`,
      emit: (): void => undefined,
      logger: { warn: () => undefined },
      now: () => 0,
    });
    worker.start();
    vi.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();
    expect(resolveProbe).not.toBeNull();
    let stopped = false;
    const p = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveProbe!(false);
    await p;
    expect(stopped).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });
});
