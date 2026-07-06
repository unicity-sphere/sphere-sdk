/**
 * UXF Inter-Wallet Transfer T.5.F (W41) — trustBase staleness refresh
 * + two-strike escalation integration tests (§9.4.1).
 *
 * Wires the production {@link TrustBaseStaleness} into both
 * {@link FinalizationWorkerSender} and
 * {@link FinalizationWorkerRecipient} and asserts the full surface:
 *
 *   1. **First strike**: poll returns `NOT_AUTHENTICATED` → worker
 *      emits `transfer:trustbase-warning`, calls
 *      {@link TrustBaseStaleness.refreshTrustBase}, retries the poll.
 *      `transfer:security-alert` is NOT emitted.
 *   2. **Second strike (post-refresh)**: poll AGAIN returns
 *      `NOT_AUTHENTICATED` after a successful refresh →
 *      `transfer:security-alert` IS emitted, the entry hard-fails with
 *      `reason: 'proof-invalid'`.
 *   3. **Refresh debouncing**: two requestIds in the SAME entry that
 *      both hit `NOT_AUTHENTICATED` concurrently share ONE refresh
 *      invocation per aggregator.
 *   4. **Failed refresh**: a `'failed'` outcome is treated as transient
 *      — the worker continues into the next poll iteration; the next
 *      strike triggers another refresh (no escalation).
 *   5. **Optional ledger**: workers without `trustBaseStaleness` wired
 *      preserve T.5.B / T.5.C behavior (warning + retries up to
 *      `maxProofErrorRetries` then `proof-invalid` hard-fail).
 *
 * Spec refs: §6.1 NOT_AUTHENTICATED row, §6.3 security-alert
 * reservation, §9.4.1 trustBase staleness model, T.5.F task spec.
 */

import { describe, expect, it } from 'vitest';

import {
  TrustBaseStaleness,
  type RefreshOutcome,
  type TrustBaseRefresher,
} from '../../../extensions/uxf/pipeline/trustbase-staleness';
import {
  FinalizationWorkerSender,
  CountingSemaphore,
} from '../../../extensions/uxf/pipeline/finalization-worker-sender';
import {
  FinalizationWorkerRecipient,
} from '../../../extensions/uxf/pipeline/finalization-worker-recipient';
import { ManifestCas } from '../../../extensions/uxf/profile/manifest-cas';
import { PerTokenMutex } from '../../../extensions/uxf/profile/per-token-mutex';
import {
  ADDR as ADDR_S,
  REQUEST_ID,
  NEW_CID as NEW_CID_S,
  buildWorker as buildSenderHarness,
  makeFakeAggregator as makeFakeAggS,
  makeFakeResolver as makeFakeResolverS,
  makeOutboxEntry,
  makeProof as makeProofS,
} from '../../unit/payments/transfer/finalization-worker-sender-fixtures';
import {
  ADDR as ADDR_R,
  TOKEN_ID,
  NEW_CID as NEW_CID_R,
  buildWorker as buildRecipientHarness,
  makeFakeAggregator as makeFakeAggR,
  makeFakeResolver as makeFakeResolverR,
  makeFakeManifestStorage,
  makeFakePool,
  makeFakePoolRead,
  makeFakeQueueStorage,
  makeFakeTombstones,
  makeFakeCascadeWalker,
  makeFakeDispositionWriter,
  makeFakeRevaluateHooks,
  makeQueueAdapter,
  makeProof as makeProofR,
  makeQueueEntry,
  seedQueue,
  type WorkerHarness as RecipientWorkerHarness,
} from '../../unit/payments/transfer/finalization-worker-recipient-fixtures';
import { FinalizationQueue } from '../../../extensions/uxf/pipeline/finalization-queue';
import { contentHash } from '../../../extensions/uxf/bundle/types';
import type { SphereEventMap, SphereEventType } from '../../../types';

// =============================================================================
// 1. Recording refresher
// =============================================================================

interface RecordingRefresher extends TrustBaseRefresher {
  readonly calls: ReadonlyArray<{ aggregatorId: string }>;
}

function makeRecordingRefresher(
  outcomes: ReadonlyArray<RefreshOutcome>,
): RecordingRefresher {
  const calls: Array<{ aggregatorId: string }> = [];
  let i = 0;
  return {
    calls,
    async refresh({ aggregatorId }) {
      calls.push({ aggregatorId });
      const o = outcomes[i++];
      if (o === undefined) {
        return outcomes[outcomes.length - 1] ?? { kind: 'applied', tag: 0 };
      }
      return o;
    },
  };
}

// =============================================================================
// 2. Sender — first strike → refresh → retry → SUCCESS
// =============================================================================

describe('FinalizationWorkerSender + TrustBaseStaleness', () => {
  it('first NOT_AUTHENTICATED → warning + refresh + retry succeeds', async () => {
    const aggregator = makeFakeAggS({
      submit: async () => ({ kind: 'SUCCESS' }),
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED', error: 'stale validator sig' },
        { kind: 'OK', proof: makeProofS(), newCid: NEW_CID_S },
      ],
    });
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const staleness = new TrustBaseStaleness({ refresher });
    const h = buildSenderHarness({ aggregator });
    // Re-build worker with staleness wired.
    const worker = new FinalizationWorkerSender({
      addressId: ADDR_S,
      outbox: h.outbox.writer,
      aggregator,
      resolver: h.resolver,
      pool: h.pool,
      poolRead: h.poolRead,
      manifestCas: new ManifestCas(h.manifestStorage),
      tombstones: h.tombstones,
      queue: h.queue,
      perAggregatorSemaphore: h.perAggSemaphore,
      getPerTokenSemaphore: () => h.perTokenSemaphore,
      perTokenMutex: h.mutex,
      perTokenMutexStrategy: 'cas',
      emit: h.events.emit,
      now: () => Date.now(),
      sleep: async () => undefined,
      caps: { maxProofErrorRetries: 3 },
      trustBaseStaleness: staleness,
    });

    const result = await worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');

    // EXACTLY ONE warning, NO security-alert.
    const warnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(1);
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);

    // Refresher invoked exactly once.
    expect(refresher.calls.length).toBe(1);
    expect(refresher.calls[0]!.aggregatorId).toBe('default');
  });

  it('second NOT_AUTHENTICATED after refresh → security-alert + hard-fail proof-invalid', async () => {
    const aggregator = makeFakeAggS({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'NOT_AUTHENTICATED',
        error: 'persistent stale',
      }),
    });
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const staleness = new TrustBaseStaleness({ refresher });
    const h = buildSenderHarness({ aggregator });
    const worker = new FinalizationWorkerSender({
      addressId: ADDR_S,
      outbox: h.outbox.writer,
      aggregator,
      resolver: h.resolver,
      pool: h.pool,
      poolRead: h.poolRead,
      manifestCas: new ManifestCas(h.manifestStorage),
      tombstones: h.tombstones,
      queue: h.queue,
      perAggregatorSemaphore: h.perAggSemaphore,
      getPerTokenSemaphore: () => h.perTokenSemaphore,
      perTokenMutex: h.mutex,
      perTokenMutexStrategy: 'cas',
      emit: h.events.emit,
      now: () => Date.now(),
      sleep: async () => undefined,
      caps: { maxProofErrorRetries: 10 },
      trustBaseStaleness: staleness,
    });

    const result = await worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('proof-invalid');

    // EXACTLY ONE security-alert (the post-refresh strike).
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(1);
    const data = alerts[0]!.data as SphereEventMap['transfer:security-alert'];
    expect(data.tokenId).toBe('token-1');
    expect(data.requestId).toBe(REQUEST_ID);
    expect(data.message).toMatch(/escalating to security-alert/);
    // observedTransactionHash is the local one (the worker's own).
    expect(data.observedTransactionHash.length).toBeGreaterThan(0);

    // Two warnings: one per NOT_AUTHENTICATED observation.
    const warnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(2);

    // Refresher invoked once — debounce within the SAME poll loop.
    expect(refresher.calls.length).toBe(1);
  });

  it('failed refresh → worker continues, no escalation (transient)', async () => {
    // Sequence: NOT_AUTHENTICATED → refresh fails →
    //           NOT_AUTHENTICATED → refresh succeeds →
    //           OK.
    const aggregator = makeFakeAggS({
      submit: async () => ({ kind: 'SUCCESS' }),
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'OK', proof: makeProofS(), newCid: NEW_CID_S },
      ],
    });
    const refresher = makeRecordingRefresher([
      { kind: 'failed', error: 'network' },
      { kind: 'applied', tag: 0 },
    ]);
    const staleness = new TrustBaseStaleness({ refresher });
    const h = buildSenderHarness({ aggregator });
    const worker = new FinalizationWorkerSender({
      addressId: ADDR_S,
      outbox: h.outbox.writer,
      aggregator,
      resolver: h.resolver,
      pool: h.pool,
      poolRead: h.poolRead,
      manifestCas: new ManifestCas(h.manifestStorage),
      tombstones: h.tombstones,
      queue: h.queue,
      perAggregatorSemaphore: h.perAggSemaphore,
      getPerTokenSemaphore: () => h.perTokenSemaphore,
      perTokenMutex: h.mutex,
      perTokenMutexStrategy: 'cas',
      emit: h.events.emit,
      now: () => Date.now(),
      sleep: async () => undefined,
      caps: { maxProofErrorRetries: 5 },
      trustBaseStaleness: staleness,
    });

    const result = await worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');

    // Both refresh attempts happened.
    expect(refresher.calls.length).toBe(2);

    // No security-alert: the failed refresh did not bump the tag.
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });

  it('without staleness ledger wired → preserves T.5.B retry-then-fail', async () => {
    const aggregator = makeFakeAggS({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({ kind: 'NOT_AUTHENTICATED' }),
    });
    const h = buildSenderHarness({ aggregator, maxProofErrorRetries: 2 });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('proof-invalid');
    // No security-alert — backward-compatible behavior.
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });
});

// =============================================================================
// 3. Recipient — same surface, queue-driven
// =============================================================================

/**
 * Build a recipient worker with a wired-in trustBase staleness ledger.
 * Mirrors `buildRecipientHarness` but exposes the ledger so tests can
 * assert against it.
 */
function buildRecipientWithStaleness(args: {
  readonly aggregator: ReturnType<typeof makeFakeAggR>;
  readonly staleness: TrustBaseStaleness;
  readonly maxProofErrorRetries?: number;
}): RecipientWorkerHarness {
  const queueStorage = makeFakeQueueStorage();
  const queueStore = new FinalizationQueue({ storage: queueStorage });
  const queueAdapter = makeQueueAdapter(queueStore);
  const resolver = makeFakeResolverR();
  const pool = makeFakePool();
  const poolRead = makeFakePoolRead();
  const tombstones = makeFakeTombstones();
  const events = (() => {
    const buf: Array<{ type: SphereEventType; data: unknown }> = [];
    return {
      events: buf,
      emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
        buf.push({ type, data });
      },
      clear: () => {
        buf.length = 0;
      },
    };
  })();
  const manifestStorage = makeFakeManifestStorage([
    {
      addr: ADDR_R,
      tokenId: TOKEN_ID,
      entry: { rootHash: contentHash('00'.repeat(32)), status: 'pending' },
    },
  ]);
  const manifestCas = new ManifestCas(manifestStorage);
  const perTokenSemaphore = new CountingSemaphore(4);
  const perAggSemaphore = new CountingSemaphore(16);
  const mutex = new PerTokenMutex();
  const cascadeWalker = makeFakeCascadeWalker();
  const dispositionWriter = makeFakeDispositionWriter();
  const revaluateHooks = makeFakeRevaluateHooks();

  const worker = new FinalizationWorkerRecipient({
    addressId: ADDR_R,
    queueStore,
    queueAdapter,
    aggregator: args.aggregator,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    perAggregatorSemaphore: perAggSemaphore,
    getPerTokenSemaphore: () => perTokenSemaphore,
    perTokenMutex: mutex,
    perTokenMutexStrategy: 'cas',
    cascadeWalker,
    dispositionWriter,
    revaluateHooks,
    emit: events.emit,
    // Anchor at the queue-entry fixture's `submittedAt` so the W26
    // cross-restart safety net does not trip on the wide gap between
    // 2023-fixed `submittedAt` and `Date.now()`.
    now: () => 1700000000000,
    sleep: async () => undefined,
    caps: { maxProofErrorRetries: args.maxProofErrorRetries ?? 5 },
    trustBaseStaleness: args.staleness,
  });

  return {
    worker,
    queueStore,
    queueStorage,
    aggregator: args.aggregator,
    resolver,
    pool,
    poolRead,
    tombstones,
    events,
    perTokenSemaphore,
    perAggSemaphore,
    mutex,
    manifestStorage,
    cascadeWalker,
    dispositionWriter,
  };
}

describe('FinalizationWorkerRecipient + TrustBaseStaleness', () => {
  it('first NOT_AUTHENTICATED → warning + refresh + retry succeeds', async () => {
    const aggregator = makeFakeAggR({
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'OK', proof: makeProofR(), newCid: NEW_CID_R },
      ],
    });
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const staleness = new TrustBaseStaleness({ refresher });
    const h = buildRecipientWithStaleness({ aggregator, staleness });
    await seedQueue(h, [makeQueueEntry()]);

    const result = await h.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('valid');
    expect(result.successCount).toBe(1);

    const warnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(1);
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
    expect(refresher.calls.length).toBe(1);
  });

  it('second NOT_AUTHENTICATED after refresh → security-alert + hard-fail proof-invalid', async () => {
    const aggregator = makeFakeAggR({
      poll: async () => ({ kind: 'NOT_AUTHENTICATED' }),
    });
    const refresher = makeRecordingRefresher([{ kind: 'applied', tag: 0 }]);
    const staleness = new TrustBaseStaleness({ refresher });
    const h = buildRecipientWithStaleness({
      aggregator,
      staleness,
      maxProofErrorRetries: 10,
    });
    await seedQueue(h, [makeQueueEntry()]);

    const result = await h.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('invalid');
    expect(result.firstHardFailReason).toBe('proof-invalid');

    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(1);
    const data = alerts[0]!.data as SphereEventMap['transfer:security-alert'];
    expect(data.message).toMatch(/escalating to security-alert/);
    // Warnings counted: at least one per strike.
    const warnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    // Refresher invoked exactly once during the loop.
    expect(refresher.calls.length).toBe(1);
  });

  it('failed refresh treated as transient — eventual OK still succeeds', async () => {
    const aggregator = makeFakeAggR({
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'OK', proof: makeProofR(), newCid: NEW_CID_R },
      ],
    });
    const refresher = makeRecordingRefresher([
      { kind: 'failed', error: 'oracle-down' },
      { kind: 'applied', tag: 0 },
    ]);
    const staleness = new TrustBaseStaleness({ refresher });
    const h = buildRecipientWithStaleness({ aggregator, staleness });
    await seedQueue(h, [makeQueueEntry()]);

    const result = await h.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('valid');

    expect(refresher.calls.length).toBe(2);
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });

  it('without staleness ledger → preserves T.5.C retry-then-fail', async () => {
    const aggregator = makeFakeAggR({
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
      ],
    });
    const h = buildRecipientHarness({
      aggregator,
      maxProofErrorRetries: 3,
    });
    await seedQueue(h, [makeQueueEntry()]);

    const result = await h.worker.processOneToken(TOKEN_ID);

    expect(result.firstHardFailReason).toBe('proof-invalid');
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });
});

// =============================================================================
// 4. Per-aggregator debouncing — concurrent requests share one refresh
// =============================================================================

describe('TrustBaseStaleness — per-aggregator refresh debouncing under workers', () => {
  it('two requestIds polling concurrently share ONE refresh call', async () => {
    // Build a sender entry with TWO outstandingRequestIds. Both polls
    // return NOT_AUTHENTICATED first, then OK. Both NOT_AUTHENTICATED
    // observations land within one refresh-flight; the worker should
    // invoke refresher.refresh ONCE per aggregatorId.
    const proof = makeProofS();
    const aggregator = makeFakeAggS({
      submit: async () => ({ kind: 'SUCCESS' }),
      // sequence returns NOT_AUTHENTICATED for the FIRST 2 polls, OK
      // afterwards. With 2 requestIds, that's one NOT_AUTHENTICATED
      // each then OK each.
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'OK', proof, newCid: NEW_CID_S },
        { kind: 'OK', proof, newCid: NEW_CID_S },
      ],
    });

    // The fake refresher delays one tick so concurrent strikes share
    // the same in-flight promise.
    let inFlight = 0;
    let maxInFlight = 0;
    let refreshCalls = 0;
    const refresher: TrustBaseRefresher = {
      async refresh() {
        refreshCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 1));
          return { kind: 'applied', tag: 0 };
        } finally {
          inFlight--;
        }
      },
    };
    const staleness = new TrustBaseStaleness({ refresher });

    const h = buildSenderHarness({ aggregator });
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['req-A', 'req-B'],
    });

    const worker = new FinalizationWorkerSender({
      addressId: ADDR_S,
      outbox: {
        async readOne() {
          return entry;
        },
        async update(_id, mutator) {
          return mutator(entry);
        },
      },
      aggregator,
      resolver: makeFakeResolverS(),
      pool: h.pool,
      poolRead: h.poolRead,
      manifestCas: new ManifestCas(h.manifestStorage),
      tombstones: h.tombstones,
      queue: h.queue,
      perAggregatorSemaphore: new CountingSemaphore(16),
      getPerTokenSemaphore: () => new CountingSemaphore(4),
      perTokenMutex: new PerTokenMutex(),
      perTokenMutexStrategy: 'cas',
      emit: h.events.emit,
      now: () => Date.now(),
      sleep: async () => undefined,
      caps: { maxProofErrorRetries: 3 },
      trustBaseStaleness: staleness,
    });

    const result = await worker.processOne(entry);

    expect(result.terminal).toBe('finalized');
    // Debounce: refresher.refresh invoked at most once per aggregator
    // even under two concurrent NOT_AUTHENTICATED strikes.
    expect(refreshCalls).toBe(1);
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// 5. Local-strike accounting — sibling refresh must not escalate first
//    NOT_AUTHENTICATED on a fresh poll loop
// =============================================================================

describe('TrustBaseStaleness — local-strike accounting', () => {
  it('a sibling worker bumping the global tag does NOT escalate this worker on its FIRST strike', async () => {
    // Pre-populate the staleness ledger with a refresh that bumps the
    // tag to 1 BEFORE this worker observes any NA. The worker's first
    // observed NA must STILL be a first-strike (locally) — escalation
    // requires the worker to have observed at least one prior strike
    // AND a refresh applied since.
    const refresher = makeRecordingRefresher([
      { kind: 'applied', tag: 0 }, // pre-bump
      { kind: 'applied', tag: 0 }, // worker's own refresh
    ]);
    const staleness = new TrustBaseStaleness({ refresher });

    // Pre-bump the tag — simulate a sibling worker.
    await staleness.refreshTrustBase('default');
    expect(staleness.getRefreshTag('default')).toBe(1);

    // Now wire a worker. Its first NA → should be a first-strike that
    // refreshes + retries (NOT a security-alert).
    const aggregator = makeFakeAggS({
      submit: async () => ({ kind: 'SUCCESS' }),
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'OK', proof: makeProofS(), newCid: NEW_CID_S },
      ],
    });
    const h = buildSenderHarness({ aggregator });
    const worker = new FinalizationWorkerSender({
      addressId: ADDR_S,
      outbox: h.outbox.writer,
      aggregator,
      resolver: h.resolver,
      pool: h.pool,
      poolRead: h.poolRead,
      manifestCas: new ManifestCas(h.manifestStorage),
      tombstones: h.tombstones,
      queue: h.queue,
      perAggregatorSemaphore: h.perAggSemaphore,
      getPerTokenSemaphore: () => h.perTokenSemaphore,
      perTokenMutex: h.mutex,
      perTokenMutexStrategy: 'cas',
      emit: h.events.emit,
      now: () => Date.now(),
      sleep: async () => undefined,
      caps: { maxProofErrorRetries: 3 },
      trustBaseStaleness: staleness,
    });

    const result = await worker.processOne(makeOutboxEntry());
    expect(result.terminal).toBe('finalized');

    // No security-alert — the FIRST NA is always a first-strike
    // locally, regardless of how many siblings have bumped the tag.
    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });
});
