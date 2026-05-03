/**
 * UXF Transfer T.5.B — sender-side finalization worker (`§6.1`).
 *
 * Verifies the §6.1 mapping table verbatim:
 *
 *  - SUCCESS path → `delivered-instant → finalizing → finalized`,
 *    proof attached via §5.5 step 5 4-step write order, queue entry
 *    removed, `transfer:confirmed` emitted.
 *  - REQUEST_ID_EXISTS at submit + matching transactionHash at poll
 *    → idempotent SUCCESS.
 *  - REQUEST_ID_EXISTS at submit + MISMATCHING transactionHash at
 *    poll → race-lost (NO cascade — C12).
 *  - REQUEST_ID_MISMATCH at submit → client-error (NO cascade —
 *    C12/C13) + `transfer:operator-alert` emitted.
 *  - AUTHENTICATOR_VERIFICATION_FAILED at submit →
 *    belief-divergence (cascade fires).
 *  - Transient submit errors → eventual SUCCESS after retries.
 *  - PATH_INVALID after retries → proof-invalid (cascade).
 *  - NOT_AUTHENTICATED → `transfer:trustbase-warning` then proof-
 *    invalid hard-fail.
 *
 * Spec refs: §6.1, §5.5 step 5–6, §6.3 (most-recent-proof),
 * §6.1.1 (cascade rules).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  CountingSemaphore,
  FinalizationWorkerSender,
  SCAN_LIST_HARD_GUARD,
  type AnchoredProofDescriptor,
  type FinalizationAggregatorClient,
  type FinalizationOutboxWriter,
  type PoolReadAdapter,
  type RequestContext,
  type RequestContextResolver,
  type SubmitOutcome,
  type PollOutcome,
} from '../../../../modules/payments/transfer/finalization-worker-sender';
import {
  type FinalizationQueueAdapter,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
} from '../../../../modules/payments/transfer/manifest-cid-rewrite';
import { ManifestCas, type MinimalManifestStorage } from '../../../../profile/manifest-cas';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import { contentHash } from '../../../../uxf/types';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../../types';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';
import type { TokenManifestEntry } from '../../../../profile/token-manifest';

// =============================================================================
// 1. Test fixtures + helpers
// =============================================================================

const ADDR = 'DIRECT://addr-A';
const TOKEN_ID = 'token-1';
const REQUEST_ID = 'req-1';
const PREVIOUS_CID = contentHash('00'.repeat(32));
const NEW_CID = contentHash('11'.repeat(32));

/** A transactionHash imprint hex (68 chars = 4 prefix + 64 digest). */
const LOCAL_TX_HASH = `0000${'aa'.repeat(32)}`;
const RACE_TX_HASH = `0000${'bb'.repeat(32)}`;
const LOCAL_AUTHENTICATOR = 'cc'.repeat(32);

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
    id: 'outbox-1',
    bundleCid: 'bafy-bundle',
    tokenIds: [TOKEN_ID],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'recipient-pk',
    mode: 'instant',
    status: 'delivered-instant',
    outstandingRequestIds: [REQUEST_ID],
    completedRequestIds: [],
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    lamport: 1,
    ...overrides,
  };
}

function makeFakeOutboxWriter(initial: UxfTransferOutboxEntry): {
  readonly writer: FinalizationOutboxWriter;
  readonly entries: () => UxfTransferOutboxEntry;
  readonly transitions: ReadonlyArray<{ from: string; to: string }>;
} {
  let current = initial;
  const transitions: Array<{ from: string; to: string }> = [];
  return {
    transitions,
    entries: () => current,
    writer: {
      async readOne() {
        return current;
      },
      async update(id, mutator) {
        const prev = current;
        const next = mutator(prev);
        if (next.status !== prev.status) {
          transitions.push({ from: prev.status, to: next.status });
        }
        current = next;
        return next;
      },
    },
  };
}

function makeFakePool(): PoolWriteAdapter & {
  readonly attached: Set<string>;
  readonly attachCalls: Array<{ tokenId: string; requestId: string }>;
} {
  const attached = new Set<string>();
  const attachCalls: Array<{ tokenId: string; requestId: string }> = [];
  return {
    attached,
    attachCalls,
    async isProofAttached(tokenId, requestId) {
      return attached.has(`${tokenId}:${requestId}`);
    },
    async attachProof(tokenId, requestId) {
      attachCalls.push({ tokenId, requestId });
      attached.add(`${tokenId}:${requestId}`);
    },
  };
}

function makeFakePoolRead(
  initial: ReadonlyArray<{
    tokenId: string;
    requestId: string;
    proof: AnchoredProofDescriptor;
  }> = [],
): PoolReadAdapter & {
  readonly proofs: Map<string, AnchoredProofDescriptor>;
} {
  const proofs = new Map<string, AnchoredProofDescriptor>();
  for (const e of initial) {
    proofs.set(`${e.tokenId}:${e.requestId}`, e.proof);
  }
  return {
    proofs,
    async getAttachedProof(tokenId, requestId) {
      return proofs.get(`${tokenId}:${requestId}`) ?? null;
    },
  };
}

function makeFakeTombstones(): TombstoneWriteAdapter & {
  readonly records: Set<string>;
  readonly insertCalls: Array<{ tokenId: string; cid: string }>;
} {
  const records = new Set<string>();
  const insertCalls: Array<{ tokenId: string; cid: string }> = [];
  return {
    records,
    insertCalls,
    async hasTombstone(tokenId, cid) {
      return records.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId, cid) {
      insertCalls.push({ tokenId, cid });
      records.add(`${tokenId}:${cid}`);
    },
  };
}

function makeFakeQueue(
  initialEntries: ReadonlyArray<{ addr: string; requestId: string }> = [],
): FinalizationQueueAdapter & {
  readonly entries: Set<string>;
  readonly removeCalls: Array<{ addr: string; requestId: string }>;
} {
  const entries = new Set<string>();
  for (const e of initialEntries) entries.add(`${e.addr}:${e.requestId}`);
  const removeCalls: Array<{ addr: string; requestId: string }> = [];
  return {
    entries,
    removeCalls,
    async hasEntry(addr, requestId) {
      return entries.has(`${addr}:${requestId}`);
    },
    async removeEntry(addr, requestId) {
      removeCalls.push({ addr, requestId });
      entries.delete(`${addr}:${requestId}`);
    },
  };
}

function makeFakeManifestStorage(
  initial: ReadonlyArray<{ addr: string; tokenId: string; entry: TokenManifestEntry }> = [],
): MinimalManifestStorage & {
  readonly entries: Map<string, TokenManifestEntry>;
} {
  const entries = new Map<string, TokenManifestEntry>();
  for (const e of initial) {
    entries.set(`${e.addr}:${e.tokenId}`, e.entry);
  }
  return {
    entries,
    async readEntry(addr, tokenId) {
      return entries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      entries.set(`${addr}:${tokenId}`, entry);
    },
  };
}

function makeFakeResolver(
  ctx: RequestContext = {
    transactionHash: LOCAL_TX_HASH,
    authenticator: LOCAL_AUTHENTICATOR,
    previousCid: PREVIOUS_CID,
    nextEntryRest: { status: 'valid' },
  },
): RequestContextResolver & {
  readonly calls: Array<{ addressId: string; outboxId: string; tokenId: string; requestId: string }>;
} {
  const calls: Array<{ addressId: string; outboxId: string; tokenId: string; requestId: string }> = [];
  return {
    calls,
    async resolve(input) {
      calls.push({
        addressId: input.addressId,
        outboxId: input.outboxId,
        tokenId: input.tokenId,
        requestId: input.requestId,
      });
      return ctx;
    },
  };
}

function makeFakeAggregator(args: {
  readonly submit?: () => Promise<SubmitOutcome>;
  readonly poll?: () => Promise<PollOutcome>;
  readonly submitSequence?: ReadonlyArray<SubmitOutcome>;
  readonly pollSequence?: ReadonlyArray<PollOutcome>;
} = {}): FinalizationAggregatorClient & {
  readonly submitCalls: number;
  readonly pollCalls: number;
} {
  let submitCount = 0;
  let pollCount = 0;
  const obj: FinalizationAggregatorClient & {
    submitCalls: number;
    pollCalls: number;
  } = {
    get submitCalls() {
      return submitCount;
    },
    get pollCalls() {
      return pollCount;
    },
    async submit() {
      const idx = submitCount++;
      if (args.submitSequence !== undefined) {
        return (
          args.submitSequence[idx] ??
          args.submitSequence[args.submitSequence.length - 1] ??
          { kind: 'TRANSIENT' as const }
        );
      }
      if (args.submit !== undefined) return args.submit();
      return { kind: 'SUCCESS' };
    },
    async poll() {
      const idx = pollCount++;
      if (args.pollSequence !== undefined) {
        return (
          args.pollSequence[idx] ??
          args.pollSequence[args.pollSequence.length - 1] ??
          { kind: 'TRANSIENT' as const }
        );
      }
      if (args.poll !== undefined) return args.poll();
      return {
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      };
    },
  };
  return obj;
}

function makeProof(
  overrides: Partial<AnchoredProofDescriptor> = {},
): AnchoredProofDescriptor {
  return {
    transactionHash: LOCAL_TX_HASH,
    authenticator: LOCAL_AUTHENTICATOR,
    roundNumber: 100,
    proof: { merkle: 'irrelevant-for-orchestrator-tests' },
    ...overrides,
  };
}

interface WorkerHarness {
  readonly worker: FinalizationWorkerSender;
  readonly outbox: ReturnType<typeof makeFakeOutboxWriter>;
  readonly aggregator: ReturnType<typeof makeFakeAggregator>;
  readonly resolver: ReturnType<typeof makeFakeResolver>;
  readonly pool: ReturnType<typeof makeFakePool>;
  readonly poolRead: ReturnType<typeof makeFakePoolRead>;
  readonly tombstones: ReturnType<typeof makeFakeTombstones>;
  readonly queue: ReturnType<typeof makeFakeQueue>;
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly perTokenSemaphore: CountingSemaphore;
  readonly perAggSemaphore: CountingSemaphore;
  readonly mutex: PerTokenMutex;
  readonly manifestStorage: ReturnType<typeof makeFakeManifestStorage>;
}

function buildWorker(args: {
  readonly entry?: UxfTransferOutboxEntry;
  readonly aggregator?: ReturnType<typeof makeFakeAggregator>;
  readonly resolver?: ReturnType<typeof makeFakeResolver>;
  readonly poolRead?: ReturnType<typeof makeFakePoolRead>;
  readonly nowFn?: () => number;
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly perToken?: number;
  readonly perAgg?: number;
  readonly maxSubmitRetries?: number;
  readonly maxProofErrorRetries?: number;
} = {}): WorkerHarness {
  const entry = args.entry ?? makeOutboxEntry();
  const outbox = makeFakeOutboxWriter(entry);
  const aggregator = args.aggregator ?? makeFakeAggregator();
  const resolver = args.resolver ?? makeFakeResolver();
  const pool = makeFakePool();
  const poolRead = args.poolRead ?? makeFakePoolRead();
  const tombstones = makeFakeTombstones();
  const queue = makeFakeQueue(entry.outstandingRequestIds!.map((r) => ({ addr: ADDR, requestId: r })));
  const events = makeEventRecorder();
  // Pre-seed manifest with the previousCid entry so step 2 CAS works.
  const manifestStorage = makeFakeManifestStorage([
    {
      addr: ADDR,
      tokenId: TOKEN_ID,
      entry: { rootHash: PREVIOUS_CID, status: 'pending' },
    },
  ]);
  const manifestCas = new ManifestCas(manifestStorage);
  const perTokenSemaphore = new CountingSemaphore(args.perToken ?? 4);
  const perAggSemaphore = new CountingSemaphore(args.perAgg ?? 16);
  const mutex = new PerTokenMutex();

  const worker = new FinalizationWorkerSender({
    addressId: ADDR,
    outbox: outbox.writer,
    aggregator,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    queue,
    perAggregatorSemaphore: perAggSemaphore,
    getPerTokenSemaphore: () => perTokenSemaphore,
    perTokenMutex: mutex,
    perTokenMutexStrategy: 'cas',
    emit: events.emit,
    now: args.nowFn ?? (() => Date.now()),
    sleep: args.sleepFn ?? (async () => undefined),
    caps: {
      maxSubmitRetries: args.maxSubmitRetries ?? 5,
      maxProofErrorRetries: args.maxProofErrorRetries ?? 3,
    },
  });

  return {
    worker,
    outbox,
    aggregator,
    resolver,
    pool,
    poolRead,
    tombstones,
    queue,
    events,
    perTokenSemaphore,
    perAggSemaphore,
    mutex,
    manifestStorage,
  };
}

// =============================================================================
// 2. Configuration validity rule (§5.5 step 6)
// =============================================================================

describe('FinalizationWorkerSender — configuration validity (§5.5 step 6)', () => {
  it('accepts default polling-policy configuration', () => {
    expect(() => buildWorker()).not.toThrow();
  });

  it('rejects construction when caps.perAggregator is invalid', () => {
    const entry = makeOutboxEntry();
    const outbox = makeFakeOutboxWriter(entry);
    const events = makeEventRecorder();
    const manifestStorage = makeFakeManifestStorage();
    expect(() => {
      new FinalizationWorkerSender({
        addressId: ADDR,
        outbox: outbox.writer,
        aggregator: makeFakeAggregator(),
        resolver: makeFakeResolver(),
        pool: makeFakePool(),
        poolRead: makeFakePoolRead(),
        manifestCas: new ManifestCas(manifestStorage),
        tombstones: makeFakeTombstones(),
        queue: makeFakeQueue(),
        perAggregatorSemaphore: new CountingSemaphore(1),
        getPerTokenSemaphore: () => new CountingSemaphore(1),
        perTokenMutex: new PerTokenMutex(),
        emit: events.emit,
        now: Date.now,
        sleep: async () => undefined,
        caps: { perAggregator: 0 },
      });
    }).toThrow(/perAggregator must be > 0/);
  });

  it('rejects construction when caps.perToken is invalid', () => {
    const entry = makeOutboxEntry();
    const outbox = makeFakeOutboxWriter(entry);
    const events = makeEventRecorder();
    const manifestStorage = makeFakeManifestStorage();
    expect(() => {
      new FinalizationWorkerSender({
        addressId: ADDR,
        outbox: outbox.writer,
        aggregator: makeFakeAggregator(),
        resolver: makeFakeResolver(),
        pool: makeFakePool(),
        poolRead: makeFakePoolRead(),
        manifestCas: new ManifestCas(manifestStorage),
        tombstones: makeFakeTombstones(),
        queue: makeFakeQueue(),
        perAggregatorSemaphore: new CountingSemaphore(1),
        getPerTokenSemaphore: () => new CountingSemaphore(1),
        perTokenMutex: new PerTokenMutex(),
        emit: events.emit,
        now: Date.now,
        sleep: async () => undefined,
        caps: { perToken: NaN },
      });
    }).toThrow(/perToken must be > 0/);
  });
});

// =============================================================================
// 3. SUCCESS / happy path
// =============================================================================

describe('FinalizationWorkerSender — SUCCESS happy path', () => {
  it('SUCCESS at submit + matching transactionHash at poll → finalized', async () => {
    const h = buildWorker();
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
    expect(result.successCount).toBe(1);
    expect(result.hardFailCount).toBe(0);

    // Outbox transitioned through delivered-instant → finalizing → finalized.
    expect(h.outbox.transitions).toEqual([
      { from: 'delivered-instant', to: 'finalizing' },
      { from: 'finalizing', to: 'finalized' },
    ]);

    // 4-step write happened.
    expect(h.pool.attachCalls).toHaveLength(1);
    expect(h.tombstones.insertCalls).toHaveLength(1);
    expect(h.queue.entries.has(`${ADDR}:${REQUEST_ID}`)).toBe(false);

    // Outbox entry's outstandingRequestIds drained.
    expect(h.outbox.entries().outstandingRequestIds).toEqual([]);
    expect(h.outbox.entries().completedRequestIds).toEqual([REQUEST_ID]);

    // transfer:confirmed emitted.
    const confirmed = h.events.events.filter((e) => e.type === 'transfer:confirmed');
    expect(confirmed).toHaveLength(1);
  });

  it('REQUEST_ID_EXISTS at submit + matching tx hash → idempotent SUCCESS', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_EXISTS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
    // Same final outcome as a fresh SUCCESS — that's the idempotency guarantee.
    expect(h.pool.attachCalls).toHaveLength(1);
  });
});

// =============================================================================
// 4. Race-lost (C12)
// =============================================================================

describe('FinalizationWorkerSender — race-lost (C12)', () => {
  it('REQUEST_ID_EXISTS + MISMATCHING tx hash → race-lost, NO cascade', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_EXISTS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({ transactionHash: RACE_TX_HASH }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('race-lost');
    expect(result.cascadeFailedEmitted).toBe(false); // NO cascade per §6.1.1

    // No 4-step write — race-lost does NOT attach the proof.
    expect(h.pool.attachCalls).toHaveLength(0);
    expect(h.queue.entries.has(`${ADDR}:${REQUEST_ID}`)).toBe(true);

    // No transfer:cascade-failed event emitted (the cascade-skipping rule).
    const cascadeEvents = h.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(0);
  });
});

// =============================================================================
// 5. Client-error (C12 / C13)
// =============================================================================

describe('FinalizationWorkerSender — client-error (C12/C13)', () => {
  it('REQUEST_ID_MISMATCH at submit → client-error, NO cascade, operator-alert emitted', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH', error: 'inconsistent tuple' }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('client-error');
    expect(result.cascadeFailedEmitted).toBe(false);

    // operator-alert emitted with code='client-error'.
    const operatorAlerts = h.events.events.filter(
      (e) => e.type === 'transfer:operator-alert',
    );
    expect(operatorAlerts).toHaveLength(1);
    expect((operatorAlerts[0]!.data as { code: string }).code).toBe(
      'client-error',
    );

    // No proof attached, no poll happened (client-error short-circuits at submit).
    expect(h.pool.attachCalls).toHaveLength(0);
    expect(h.aggregator.pollCalls).toBe(0);
  });
});

// =============================================================================
// 6. Belief-divergence
// =============================================================================

describe('FinalizationWorkerSender — belief-divergence', () => {
  it('AUTHENTICATOR_VERIFICATION_FAILED at submit → belief-divergence + cascade', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('belief-divergence');
    expect(result.cascadeFailedEmitted).toBe(true);

    // transfer:cascade-failed emitted.
    const cascadeEvents = h.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(1);
    expect((cascadeEvents[0]!.data as { reason: string }).reason).toBe(
      'belief-divergence',
    );
  });
});

// =============================================================================
// 7. Transient retries
// =============================================================================

describe('FinalizationWorkerSender — transient retries', () => {
  it('3 transient submits then SUCCESS → eventual finalized', async () => {
    const submitSequence: ReadonlyArray<SubmitOutcome> = [
      { kind: 'TRANSIENT', error: 'connection refused' },
      { kind: 'TRANSIENT', error: 'gateway timeout' },
      { kind: 'TRANSIENT', error: 'service unavailable' },
      { kind: 'SUCCESS' },
    ];
    const aggregator = makeFakeAggregator({ submitSequence });
    const h = buildWorker({ aggregator, maxSubmitRetries: 5 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
    expect(h.aggregator.submitCalls).toBe(4);
  });

  it('exhausting MAX_SUBMIT_RETRIES → oracle-rejected hard-fail', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'TRANSIENT', error: 'persistent failure' }),
    });
    const h = buildWorker({ aggregator, maxSubmitRetries: 2 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    // Wave 3 #1 fix: `maxSubmitRetries` now bounds total submit
    // attempts (was: initial+retries). With max=2 → exactly 2 calls.
    expect(h.aggregator.submitCalls).toBe(2);
  });
});

// =============================================================================
// 8. PATH_INVALID
// =============================================================================

describe('FinalizationWorkerSender — PATH_INVALID', () => {
  it('repeated PATH_INVALID exhausts retries → proof-invalid + cascade', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({ kind: 'PATH_INVALID', error: 'malformed merkle' }),
    });
    const h = buildWorker({ aggregator, maxProofErrorRetries: 2 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('proof-invalid');
    expect(result.cascadeFailedEmitted).toBe(true);
  });
});

// =============================================================================
// 9. NOT_AUTHENTICATED → trustbase-warning
// =============================================================================

describe('FinalizationWorkerSender — NOT_AUTHENTICATED', () => {
  it('emits trustbase-warning per attempt, then hard-fails proof-invalid', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'NOT_AUTHENTICATED',
        error: 'stale trustBase',
      }),
    });
    const h = buildWorker({ aggregator, maxProofErrorRetries: 2 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('proof-invalid');

    // trustbase-warning emitted on each NOT_AUTHENTICATED.
    const warnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// 10. Sustained PATH_NOT_INCLUDED past window (W17 wired here too)
// =============================================================================

describe('FinalizationWorkerSender — sustained PATH_NOT_INCLUDED', () => {
  it('past polling window after MIN_POLL_ATTEMPTS → oracle-rejected', async () => {
    let now = 1700000000000;
    const startedAt = now;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({ kind: 'PATH_NOT_INCLUDED' }),
    });
    const h = buildWorker({
      aggregator,
      // Fake clock — advance "now" past the polling window after enough attempts.
      nowFn: () => now,
      sleepFn: async () => {
        // Advance the clock by one backoff interval per simulated sleep.
        now += 1_000_000; // big jump to force window timeout.
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    void startedAt;
  });
});

// =============================================================================
// 11. Outbox state machine — start/stop, isRunning
// =============================================================================

describe('FinalizationWorkerSender — start/stop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start + stop is idempotent', async () => {
    const h = buildWorker();
    expect(h.worker.isRunning()).toBe(false);
    h.worker.start();
    expect(h.worker.isRunning()).toBe(true);
    h.worker.start(); // idempotent
    expect(h.worker.isRunning()).toBe(true);
    await h.worker.stop();
    expect(h.worker.isRunning()).toBe(false);
    await h.worker.stop(); // idempotent
  });
});

// =============================================================================
// 12. Already-terminal entries
// =============================================================================

describe('FinalizationWorkerSender — already-terminal entries', () => {
  it('finalized entry is a no-op', async () => {
    const entry = makeOutboxEntry({ status: 'finalized' });
    const h = buildWorker({ entry });
    const result = await h.worker.processOne(entry);
    expect(result.terminal).toBe('finalized');
    expect(h.aggregator.submitCalls).toBe(0);
    expect(h.aggregator.pollCalls).toBe(0);
  });

  it('failed-permanent entry is a no-op', async () => {
    const entry = makeOutboxEntry({ status: 'failed-permanent' });
    const h = buildWorker({ entry });
    const result = await h.worker.processOne(entry);
    expect(result.terminal).toBe('failed-permanent');
    expect(h.aggregator.submitCalls).toBe(0);
  });
});

// =============================================================================
// 13. Resolver returning null → STRUCTURAL_INVALID
// =============================================================================

describe('FinalizationWorkerSender — resolver null path', () => {
  it('resolver returning null → structural hard-fail (skip cascade + operator-alert)', async () => {
    const resolver: RequestContextResolver = {
      async resolve() {
        return null;
      },
    };
    const h = buildWorker({ resolver: resolver as never });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('structural');
    // Wave 3 #5 fix: when the resolver returns null we have NO evidence
    // the chain is dead — cascading would propagate `structural` to
    // descendant tokens despite no proof of finalization failure.
    // Treat similarly to race-lost (skip cascade) and emit an
    // operator-alert so the missing-signedTx is visible.
    expect(result.cascadeFailedEmitted).toBe(false);
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:operator-alert',
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(
      alerts.some(
        (a) => (a.data as { code?: string }).code === 'structural',
      ),
    ).toBe(true);
  });
});

// =============================================================================
// 14. Multi-requestId entries
// =============================================================================

describe('FinalizationWorkerSender — multi-requestId entries', () => {
  it('two outstanding requestIds, both succeed → finalized', async () => {
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['req-A', 'req-B'],
    });
    const h = buildWorker({ entry });
    const result = await h.worker.processOne(entry);
    expect(result.successCount).toBe(2);
    expect(result.terminal).toBe('finalized');
  });

  it('two outstanding requestIds, one race-lost, one success → failed-permanent', async () => {
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['req-A', 'req-B'],
    });
    let pollCount = 0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_EXISTS' }),
      poll: async () => {
        const idx = pollCount++;
        if (idx === 0) {
          return {
            kind: 'OK',
            proof: makeProof({ transactionHash: RACE_TX_HASH }),
            newCid: NEW_CID,
          };
        }
        return { kind: 'OK', proof: makeProof(), newCid: NEW_CID };
      },
    });
    const h = buildWorker({ entry, aggregator });
    const result = await h.worker.processOne(entry);
    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('race-lost');
    // Race-lost skips cascade — but ONLY if every failure is race-lost.
    // The test has one race-lost failure; cascadeFailedEmitted should be
    // FALSE because that single failure is race-lost.
    expect(result.cascadeFailedEmitted).toBe(false);
    void aggregator;
  });
});

// =============================================================================
// 15. Concurrency caps — counting semaphore behavior
// =============================================================================

describe('FinalizationWorkerSender — concurrency primitive (CountingSemaphore)', () => {
  it('CountingSemaphore allows up to N concurrent acquires', async () => {
    const sem = new CountingSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.available).toBe(0);

    // Third acquire should wait.
    let resolved = false;
    const p3 = sem.acquire().then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release one; p3 resolves.
    r1();
    const r3 = await p3;
    expect(resolved).toBe(true);
    r2();
    r3();
    expect(sem.available).toBe(2);
  });

  it('rejects invalid maxConcurrent at construction', () => {
    expect(() => new CountingSemaphore(0)).toThrow(/must be > 0/);
    expect(() => new CountingSemaphore(-1)).toThrow(/must be > 0/);
    expect(() => new CountingSemaphore(NaN)).toThrow(/must be > 0/);
  });
});

// =============================================================================
// 16. scanLoop production scheduler (#168)
// =============================================================================

/**
 * Build a sender harness whose outbox writer exposes `readAllNew` so the
 * scan loop has real work to drive. The fake outbox is backed by a Map
 * keyed by id; `readAllNew()` returns its values.
 */
function buildScanHarness(args: {
  readonly initialEntries?: ReadonlyArray<UxfTransferOutboxEntry>;
  readonly aggregator?: ReturnType<typeof makeFakeAggregator>;
  readonly scanIntervalMs?: number;
  readonly maxEntriesPerScan?: number;
  readonly processOneOverride?: (
    entry: UxfTransferOutboxEntry,
  ) => Promise<void>;
} = {}): {
  readonly worker: FinalizationWorkerSender;
  readonly outboxMap: Map<string, UxfTransferOutboxEntry>;
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly processedIds: string[];
} {
  const outboxMap = new Map<string, UxfTransferOutboxEntry>();
  for (const e of args.initialEntries ?? []) outboxMap.set(e.id, e);

  const writer: FinalizationOutboxWriter = {
    async readOne(id) {
      return outboxMap.get(id) ?? null;
    },
    async update(id, mutator) {
      const prev = outboxMap.get(id);
      if (!prev) throw new Error(`no entry ${id}`);
      const next = mutator(prev);
      outboxMap.set(id, next);
      return next;
    },
    async readAllNew() {
      return Array.from(outboxMap.values());
    },
  };

  const aggregator = args.aggregator ?? makeFakeAggregator();
  const resolver = makeFakeResolver();
  const pool = makeFakePool();
  const poolRead = makeFakePoolRead();
  const tombstones = makeFakeTombstones();
  // Seed queue with EVERY outstanding requestId across initial entries
  // so the manifest-CID-rewrite's `hasEntry` check passes during the
  // 4-step write.
  const queueSeed: Array<{ addr: string; requestId: string }> = [];
  for (const e of args.initialEntries ?? []) {
    for (const r of e.outstandingRequestIds ?? []) {
      queueSeed.push({ addr: ADDR, requestId: r });
    }
  }
  if (queueSeed.length === 0) {
    queueSeed.push({ addr: ADDR, requestId: REQUEST_ID });
  }
  const queue = makeFakeQueue(queueSeed);
  const events = makeEventRecorder();
  const manifestStorage = makeFakeManifestStorage([
    {
      addr: ADDR,
      tokenId: TOKEN_ID,
      entry: { rootHash: PREVIOUS_CID, status: 'pending' },
    },
  ]);
  const manifestCas = new ManifestCas(manifestStorage);
  const mutex = new PerTokenMutex();
  const processedIds: string[] = [];

  const worker = new FinalizationWorkerSender({
    addressId: ADDR,
    outbox: writer,
    aggregator,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    queue,
    perAggregatorSemaphore: new CountingSemaphore(16),
    getPerTokenSemaphore: () => new CountingSemaphore(4),
    perTokenMutex: mutex,
    perTokenMutexStrategy: 'cas',
    emit: events.emit,
    now: () => Date.now(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    scanIntervalMs: args.scanIntervalMs ?? 5,
    maxEntriesPerScan: args.maxEntriesPerScan ?? 100,
  });

  // Spy on processOne to record which ids the loop touched. After the
  // override (or fallback to no-op), we mark the outbox entry as
  // 'finalized' so the scan loop's filter (`status === 'delivered-instant'
  // || 'finalizing'`) skips it on the next pass — preventing tight
  // re-fire loops in tests with overrides that don't drive real state.
  const originalProcessOne = worker.processOne.bind(worker);
  worker.processOne = async (entry) => {
    processedIds.push(entry.id);
    if (args.processOneOverride !== undefined) {
      let threw: unknown;
      try {
        await args.processOneOverride(entry);
      } catch (err) {
        threw = err;
      }
      // Force the entry to a terminal status so the loop doesn't re-fire.
      const cur = outboxMap.get(entry.id);
      if (cur !== undefined) {
        outboxMap.set(entry.id, { ...cur, status: 'finalized' });
      }
      if (threw !== undefined) throw threw;
      return {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        successCount: 1,
        hardFailCount: 0,
        cascadeFailedEmitted: false,
        terminal: 'finalized',
      };
    }
    return originalProcessOne(entry);
  };

  return { worker, outboxMap, events, processedIds };
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitForCondition timed out'));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('FinalizationWorkerSender — scanLoop (#168)', () => {
  it('processes a delivered-instant entry within scanIntervalMs', async () => {
    const entry = makeOutboxEntry({ id: 'outbox-scan-1' });
    const h = buildScanHarness({
      initialEntries: [entry],
      processOneOverride: async () => undefined,
    });
    h.worker.start();
    try {
      await waitForCondition(() => h.processedIds.includes('outbox-scan-1'));
      expect(h.processedIds).toContain('outbox-scan-1');
    } finally {
      await h.worker.stop();
    }
  });

  it('processes ten queued entries', async () => {
    // Use processOneOverride: a no-op marks each entry processed and
    // flips its status to 'finalized' (via the harness wrapper) so the
    // loop terminates rather than re-firing forever. We assert the
    // loop *visited* every entry; correctness of the §6.1 cycle is
    // exercised by the other tests in this file.
    const entries: UxfTransferOutboxEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeOutboxEntry({
          id: `outbox-scan-${i}`,
          outstandingRequestIds: [`req-${i}`],
        }),
      );
    }
    const h = buildScanHarness({
      initialEntries: entries,
      processOneOverride: async () => undefined,
    });
    h.worker.start();
    try {
      await waitForCondition(() => {
        const unique = new Set(h.processedIds);
        return unique.size === 10;
      }, 3000);
      const unique = new Set(h.processedIds);
      expect(unique.size).toBe(10);
    } finally {
      await h.worker.stop();
    }
  });

  it('continues on processOne throw — other entries still process', async () => {
    const entries = [
      makeOutboxEntry({ id: 'outbox-throw' }),
      makeOutboxEntry({ id: 'outbox-ok-1' }),
      makeOutboxEntry({ id: 'outbox-ok-2' }),
    ];
    const h = buildScanHarness({
      initialEntries: entries,
      processOneOverride: async (entry) => {
        if (entry.id === 'outbox-throw') {
          throw new Error('synthetic throw');
        }
      },
    });
    h.worker.start();
    try {
      await waitForCondition(
        () =>
          h.processedIds.includes('outbox-ok-1') &&
          h.processedIds.includes('outbox-ok-2'),
      );
      expect(h.processedIds).toContain('outbox-ok-1');
      expect(h.processedIds).toContain('outbox-ok-2');
      // The thrown entry was attempted and the loop emitted an alert.
      expect(h.processedIds).toContain('outbox-throw');
      const alerts = h.events.events.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBeGreaterThan(0);
    } finally {
      await h.worker.stop();
    }
  });

  it('stop() during scan exits cleanly within ~scanIntervalMs', async () => {
    const entry = makeOutboxEntry({ id: 'outbox-stop' });
    const h = buildScanHarness({
      initialEntries: [entry],
      scanIntervalMs: 50,
      processOneOverride: async () => undefined,
    });
    h.worker.start();
    expect(h.worker.isRunning()).toBe(true);
    const start = Date.now();
    await h.worker.stop();
    const elapsed = Date.now() - start;
    expect(h.worker.isRunning()).toBe(false);
    // Should exit within a small multiple of scanIntervalMs (allow
    // generous slack for CI jitter).
    expect(elapsed).toBeLessThan(500);
  });

  it('manualScan: true → loop is sleep-only stub', async () => {
    const entry = makeOutboxEntry({ id: 'outbox-manual' });
    const outboxMap = new Map<string, UxfTransferOutboxEntry>([[entry.id, entry]]);
    const writer: FinalizationOutboxWriter = {
      async readOne(id) {
        return outboxMap.get(id) ?? null;
      },
      async update(id, mutator) {
        const prev = outboxMap.get(id)!;
        const next = mutator(prev);
        outboxMap.set(id, next);
        return next;
      },
      async readAllNew() {
        return Array.from(outboxMap.values());
      },
    };
    const events = makeEventRecorder();
    const aggregator = makeFakeAggregator();
    const resolver = makeFakeResolver();
    const pool = makeFakePool();
    const poolRead = makeFakePoolRead();
    const tombstones = makeFakeTombstones();
    const queue = makeFakeQueue([{ addr: ADDR, requestId: REQUEST_ID }]);
    const manifestStorage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: TOKEN_ID,
        entry: { rootHash: PREVIOUS_CID, status: 'pending' },
      },
    ]);
    const manifestCas = new ManifestCas(manifestStorage);
    const mutex = new PerTokenMutex();
    const worker = new FinalizationWorkerSender({
      addressId: ADDR,
      outbox: writer,
      aggregator,
      resolver,
      pool,
      poolRead,
      manifestCas,
      tombstones,
      queue,
      perAggregatorSemaphore: new CountingSemaphore(16),
      getPerTokenSemaphore: () => new CountingSemaphore(4),
      perTokenMutex: mutex,
      emit: events.emit,
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
      scanIntervalMs: 5,
      manualScan: true,
    });
    const processedIds: string[] = [];
    const originalProcessOne = worker.processOne.bind(worker);
    worker.processOne = async (e) => {
      processedIds.push(e.id);
      return originalProcessOne(e);
    };
    worker.start();
    try {
      await new Promise((r) => setTimeout(r, 50));
      // manualScan stub never invokes processOne.
      expect(processedIds.length).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it('rejects scanIntervalMs <= 0', () => {
    const entry = makeOutboxEntry();
    expect(() =>
      buildScanHarness({ initialEntries: [entry], scanIntervalMs: 0 }),
    ).toThrow(/scanIntervalMs/);
    expect(() =>
      buildScanHarness({ initialEntries: [entry], scanIntervalMs: -1 }),
    ).toThrow(/scanIntervalMs/);
  });

  it('rejects maxEntriesPerScan <= 0', () => {
    const entry = makeOutboxEntry();
    expect(() =>
      buildScanHarness({ initialEntries: [entry], maxEntriesPerScan: 0 }),
    ).toThrow(/maxEntriesPerScan/);
  });

  it('skips entry already in flight (concurrent processOne + scan)', async () => {
    // Build a scan harness whose READ enumerator stays "live" but which
    // we can stretch via a custom slow processOne override. The test
    // verifies the loop's `inFlight` filter prevents double-processing
    // the same outbox id when an external caller is already mid-flight.
    const entry = makeOutboxEntry({ id: 'outbox-concurrent' });
    const outboxMap = new Map<string, UxfTransferOutboxEntry>([[entry.id, entry]]);
    const writer: FinalizationOutboxWriter = {
      async readOne(id) {
        return outboxMap.get(id) ?? null;
      },
      async update(id, mutator) {
        const prev = outboxMap.get(id)!;
        const next = mutator(prev);
        outboxMap.set(id, next);
        return next;
      },
      async readAllNew() {
        return Array.from(outboxMap.values());
      },
    };
    const events = makeEventRecorder();
    const aggregator = makeFakeAggregator();
    const resolver = makeFakeResolver();
    const pool = makeFakePool();
    const poolRead = makeFakePoolRead();
    const tombstones = makeFakeTombstones();
    const queue = makeFakeQueue([{ addr: ADDR, requestId: REQUEST_ID }]);
    const manifestStorage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: TOKEN_ID,
        entry: { rootHash: PREVIOUS_CID, status: 'pending' },
      },
    ]);
    const manifestCas = new ManifestCas(manifestStorage);
    const mutex = new PerTokenMutex();
    const worker = new FinalizationWorkerSender({
      addressId: ADDR,
      outbox: writer,
      aggregator,
      resolver,
      pool,
      poolRead,
      manifestCas,
      tombstones,
      queue,
      perAggregatorSemaphore: new CountingSemaphore(16),
      getPerTokenSemaphore: () => new CountingSemaphore(4),
      perTokenMutex: mutex,
      perTokenMutexStrategy: 'cas',
      emit: events.emit,
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
      scanIntervalMs: 5,
    });

    // Wrap the resolver to add a 50ms delay on first use, simulating a
    // slow aggregator / network. This stretches processOne enough for
    // the scan loop to observe `inFlight` and skip the entry.
    let resolveCount = 0;
    const slowResolver: RequestContextResolver = {
      async resolve(input) {
        resolveCount++;
        if (resolveCount === 1) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return resolver.resolve(input);
      },
    };
    // Re-wire by replacing the inner resolver via a one-shot closure.
    // Since we already built the worker, we instead retry: build with
    // slowResolver from the start.
    const worker2 = new FinalizationWorkerSender({
      addressId: ADDR,
      outbox: writer,
      aggregator,
      resolver: slowResolver,
      pool,
      poolRead,
      manifestCas,
      tombstones,
      queue,
      perAggregatorSemaphore: new CountingSemaphore(16),
      getPerTokenSemaphore: () => new CountingSemaphore(4),
      perTokenMutex: mutex,
      perTokenMutexStrategy: 'cas',
      emit: events.emit,
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
      scanIntervalMs: 5,
    });
    void worker;

    const processedIds: string[] = [];
    const orig = worker2.processOne.bind(worker2);
    worker2.processOne = async (e) => {
      processedIds.push(e.id);
      return orig(e);
    };

    // Kick off external processOne BEFORE start() so it grabs the
    // inFlight slot; the slow resolver holds the cycle ~50ms.
    const externalP = worker2.processOne(entry);
    worker2.start();
    try {
      // Wait for external call to register.
      await waitForCondition(() => processedIds.length >= 1, 1000);
      // Loop tries to scan; the inFlight Set should cause it to skip
      // processing the same entry. Let the loop tick a few times.
      await new Promise((r) => setTimeout(r, 30));
      // External call still in flight → loop has NOT added another
      // processedIds entry.
      const beforeWait = processedIds.length;
      expect(beforeWait).toBe(1);
      // Let external complete; status flips to finalized so subsequent
      // loop ticks skip on status filter.
      const result = await externalP;
      void result;
    } finally {
      await worker2.stop();
    }
  });
});

// =============================================================================
// 21. Wave 3 #2 — separate PATH_INVALID / NOT_AUTHENTICATED counters
// =============================================================================

describe('FinalizationWorkerSender — separate proof-error counters (Wave 3 #2)', () => {
  it('PATH_INVALID burst then NOT_AUTHENTICATED uses fresh budget', async () => {
    // Pre-fix behavior: a shared `proofErrorRetries` counter let a
    // PATH_INVALID burst eat the NOT_AUTHENTICATED budget, so the
    // first NOT_AUTHENTICATED would immediately exhaust the counter
    // and hard-fail. With the post-fix split counters, each error
    // type owns its own budget.
    //
    // Sequence with maxProofErrorRetries=2:
    //   poll 1: PATH_INVALID → pathInvalidRetries=1 (under budget)
    //   poll 2: NOT_AUTHENTICATED → notAuthenticatedRetries=1
    //   poll 3: NOT_AUTHENTICATED → notAuthenticatedRetries=2 → hard-fail
    // Pre-fix: poll 2 would have been counter=2 → immediate hard-fail.
    const pollSequence: ReadonlyArray<PollOutcome> = [
      { kind: 'PATH_INVALID', error: 'malformed-1' },
      { kind: 'NOT_AUTHENTICATED', error: 'stale-1' },
      { kind: 'NOT_AUTHENTICATED', error: 'stale-2' },
    ];
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      pollSequence,
    });
    const h = buildWorker({ aggregator, maxProofErrorRetries: 2 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('proof-invalid');
    // 3 polls reached BEFORE hard-fail → counter independence is the
    // load-bearing assertion. Pre-fix: the shared counter would have
    // capped at 2 polls (PATH_INVALID then a single NOT_AUTHENTICATED)
    // because the counter pre-fix incremented to budget after the
    // 2nd verifiable observation.
    expect(h.aggregator.pollCalls).toBe(3);
    // Trail of trustbase-warnings: one per NOT_AUTHENTICATED (=2 in
    // this sequence). Confirms that the NOT_AUTHENTICATED branch ran
    // its own budget twice rather than being immediately exhausted.
    const warnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(2);
  });

  it('NOT_AUTHENTICATED burst then PATH_INVALID uses fresh budget', async () => {
    const pollSequence: ReadonlyArray<PollOutcome> = [
      { kind: 'NOT_AUTHENTICATED', error: 'stale-1' },
      { kind: 'PATH_INVALID', error: 'malformed-1' },
      { kind: 'PATH_INVALID', error: 'malformed-2' },
    ];
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      pollSequence,
    });
    const h = buildWorker({ aggregator, maxProofErrorRetries: 2 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('proof-invalid');
    expect(h.aggregator.pollCalls).toBe(3);
    // The PATH_INVALID counter — independent of NOT_AUTHENTICATED's
    // earlier observation — reaches budget on poll 3.
  });
});

// =============================================================================
// Wave 5 steelman fix #2 — SCAN_LIST_HARD_GUARD truncation alert backoff
// =============================================================================

describe('FinalizationWorkerSender — SCAN_LIST_HARD_GUARD truncation backoff (Wave 5)', () => {
  /**
   * Build a harness whose `readAllNew()` returns N entries every cycle.
   * We assert the loop emits a truncation alert ONLY at power-of-two
   * cycle boundaries (1, 2, 4, 8, …) and NOT on every cycle.
   */
  function buildOversizeHarness(args: { readonly listSize: number }): {
    readonly worker: FinalizationWorkerSender;
    readonly events: ReturnType<typeof makeEventRecorder>;
    readonly readCalls: { count: number };
  } {
    // Synthesize `listSize` minimal entries — they don't need to be
    // valid for the loop to materialize them and hit the truncation
    // branch, but we DO need the truncation slice to consist of
    // entries that won't trip processOne errors. We supply a single
    // fake entry slot and replicate it; its `status` is `finalized`
    // so the loop's filter rejects it (no processOne calls).
    const stubEntry: UxfTransferOutboxEntry = {
      ...makeOutboxEntry({ id: 'stub-finalized' }),
      status: 'finalized',
    };
    const entries: UxfTransferOutboxEntry[] = Array.from(
      { length: args.listSize },
      (_, i) => ({ ...stubEntry, id: `stub-${i}` }),
    );

    const readCalls = { count: 0 };
    const writer: FinalizationOutboxWriter = {
      async readOne(_id) {
        return null;
      },
      async update(_id, _mutator) {
        throw new Error('not used in this test');
      },
      async readAllNew() {
        readCalls.count += 1;
        return entries;
      },
    };

    const events = makeEventRecorder();
    const aggregator = makeFakeAggregator();
    const resolver = makeFakeResolver();
    const pool = makeFakePool();
    const poolRead = makeFakePoolRead();
    const tombstones = makeFakeTombstones();
    const queue = makeFakeQueue([{ addr: ADDR, requestId: REQUEST_ID }]);
    const manifestStorage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: TOKEN_ID,
        entry: { rootHash: PREVIOUS_CID, status: 'pending' },
      },
    ]);
    const manifestCas = new ManifestCas(manifestStorage);
    const mutex = new PerTokenMutex();

    const worker = new FinalizationWorkerSender({
      addressId: ADDR,
      outbox: writer,
      aggregator,
      resolver,
      pool,
      poolRead,
      manifestCas,
      tombstones,
      queue,
      perAggregatorSemaphore: new CountingSemaphore(16),
      getPerTokenSemaphore: () => new CountingSemaphore(4),
      perTokenMutex: mutex,
      emit: events.emit,
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
      scanIntervalMs: 1,
      maxEntriesPerScan: 100,
    });

    return { worker, events, readCalls };
  }

  it('truncation alert fires only at power-of-two cycle boundaries on permanent overrun', async () => {
    // Use a small over-cap multiplier so the test is fast — the cap
    // is 16384, list size = 16385 just barely exceeds it. The slice
    // truncates to 16384 entries, all stub-finalized so the loop
    // filter discards them and goes to sleep promptly.
    const h = buildOversizeHarness({ listSize: SCAN_LIST_HARD_GUARD + 1 });
    h.worker.start();
    try {
      // Wait until at least 8 read cycles have completed. With
      // scanIntervalMs=1 + sleep clamp 5ms this is well under 1s.
      await waitForCondition(() => h.readCalls.count >= 8, 5_000);
    } finally {
      await h.worker.stop();
    }
    const truncationAlerts = h.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('truncating to first')
      );
    });
    // Across N cycles (N >= 8), alerts fire only on power-of-two
    // boundaries: 1, 2, 4, 8 → at most 4 alerts. The exact upper
    // bound is `floor(log2(readCalls)) + 1`. We assert
    // strict-bounded: alerts < readCalls (the original bug).
    expect(truncationAlerts.length).toBeGreaterThanOrEqual(1);
    expect(truncationAlerts.length).toBeLessThan(h.readCalls.count);
    // Stronger: alerts should be at most floor(log2(readCalls)) + 1.
    const maxExpected = Math.floor(Math.log2(h.readCalls.count)) + 1;
    expect(truncationAlerts.length).toBeLessThanOrEqual(maxExpected);
  });

  it('emits a recovery info-alert on first under-cap read after a streak', async () => {
    // Custom writer toggles between over-cap and under-cap to simulate
    // the queue store recovering after tombstone GC catches up.
    const stubEntry: UxfTransferOutboxEntry = {
      ...makeOutboxEntry({ id: 'stub-finalized' }),
      status: 'finalized',
    };
    const oversizeBatch: UxfTransferOutboxEntry[] = Array.from(
      { length: SCAN_LIST_HARD_GUARD + 1 },
      (_, i) => ({ ...stubEntry, id: `stub-${i}` }),
    );
    // Three explicit phases:
    //   call 1, 2 → oversize (streak grows to 2)
    //   call 3+   → under-cap (recovery alert fires once on call 3)
    const readCalls = { count: 0 };
    const writer: FinalizationOutboxWriter = {
      async readOne(_id) {
        return null;
      },
      async update(_id, _mutator) {
        throw new Error('not used in this test');
      },
      async readAllNew() {
        readCalls.count += 1;
        if (readCalls.count <= 2) return oversizeBatch;
        return [] as UxfTransferOutboxEntry[];
      },
    };

    const events = makeEventRecorder();
    const aggregator = makeFakeAggregator();
    const resolver = makeFakeResolver();
    const pool = makeFakePool();
    const poolRead = makeFakePoolRead();
    const tombstones = makeFakeTombstones();
    const queue = makeFakeQueue([{ addr: ADDR, requestId: REQUEST_ID }]);
    const manifestStorage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: TOKEN_ID,
        entry: { rootHash: PREVIOUS_CID, status: 'pending' },
      },
    ]);
    const manifestCas = new ManifestCas(manifestStorage);
    const mutex = new PerTokenMutex();

    const worker = new FinalizationWorkerSender({
      addressId: ADDR,
      outbox: writer,
      aggregator,
      resolver,
      pool,
      poolRead,
      manifestCas,
      tombstones,
      queue,
      perAggregatorSemaphore: new CountingSemaphore(16),
      getPerTokenSemaphore: () => new CountingSemaphore(4),
      perTokenMutex: mutex,
      emit: events.emit,
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
      scanIntervalMs: 1,
      maxEntriesPerScan: 100,
    });

    worker.start();
    try {
      await waitForCondition(() => readCalls.count >= 4, 5_000);
    } finally {
      await worker.stop();
    }
    const recoveryAlerts = events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('under SCAN_LIST_HARD_GUARD again')
      );
    });
    // Exactly one recovery alert when we transition from over-cap to
    // under-cap, with the consecutive-overrun count.
    expect(recoveryAlerts.length).toBe(1);
    const data = recoveryAlerts[0].data as { message?: string };
    expect(data.message).toMatch(/2 consecutive over-size cycle/);
  });
});
