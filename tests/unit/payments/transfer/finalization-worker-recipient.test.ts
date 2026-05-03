/**
 * UXF Transfer T.5.C — recipient-side finalization worker.
 *
 * Verifies the §5.5 step 1-9 mapping verbatim:
 *
 *  - K queue entries per K-deep chain-mode token; transition `pending →
 *    valid` only after ALL K resolve successfully.
 *  - Queue-drain re-runs [B]/[D]/[E] under the per-tokenId mutex (CAS
 *    default per W34).
 *  - On hard-fail: cascade walker invoked + self-invalidation.
 *  - Race-lost short-circuits cascade.
 *  - Merge-path: arriving more-finalized copy grafts proofs in,
 *    removes queue entries WITHOUT aggregator round-trip.
 *  - W15 §5.6 idempotency: replay convergence with same transactionHash.
 *
 * Spec refs: §5.5, §5.6, §6.1, §6.1.1, §6.2, §6.3.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  NEW_CID,
  PREVIOUS_CID,
  RACE_TX_HASH,
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeFakePoolRead,
  makeFakeRevaluateHooks,
  makeProof,
  makeQueueEntry,
  seedQueue,
} from './finalization-worker-recipient-fixtures';
import { entryIdFor } from '../../../../modules/payments/transfer/finalization-queue';

describe('FinalizationWorkerRecipient — single queue entry success path', () => {
  it('K=1: submit + poll OK + attach proof + queue drained → VALID', async () => {
    const harness = buildWorker();
    const entry = makeQueueEntry();
    await seedQueue(harness, [entry]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('valid');
    expect(result.entriesProcessed).toBe(1);
    expect(result.successCount).toBe(1);
    expect(result.hardFailCount).toBe(0);
    expect(result.cascadeInvoked).toBe(false);

    // Queue is drained.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);

    // Proof attached.
    expect(harness.pool.attached.size).toBe(1);

    // Tombstone of previous CID written.
    expect(harness.tombstones.records.has(`${TOKEN_ID}:${PREVIOUS_CID}`)).toBe(
      true,
    );

    // Disposition writer wrote VALID.
    const writes = harness.dispositionWriter.writes;
    expect(writes.length).toBe(1);
    expect(writes[0].record.disposition).toBe('VALID');

    // transfer:incoming with confirmed:true emitted.
    const incoming = harness.events.events.filter(
      (e) => e.type === 'transfer:incoming',
    );
    expect(incoming.length).toBe(1);
  });
});

describe('FinalizationWorkerRecipient — K=3 chain-mode', () => {
  it('3 queue entries → all resolve → token transitions to valid', async () => {
    const reqs = ['req-0', 'req-1', 'req-2'];
    const aggregator = makeFakeAggregator({
      perRequestSubmit: new Map(reqs.map((r) => [r, [{ kind: 'SUCCESS' as const }]])),
      perRequestPoll: new Map(
        reqs.map((r) => [
          r,
          [
            {
              kind: 'OK' as const,
              proof: makeProof(),
              newCid: NEW_CID,
            },
          ],
        ]),
      ),
    });
    const harness = buildWorker({ aggregator });

    const entries = reqs.map((req, i) =>
      makeQueueEntry({
        entryId: entryIdFor(TOKEN_ID, i),
        txIndex: i,
        commitmentRequestId: req,
      }),
    );
    await seedQueue(harness, entries);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.entriesProcessed).toBe(3);
    expect(result.successCount).toBe(3);
    expect(result.hardFailCount).toBe(0);
    expect(result.terminal).toBe('valid');

    // Aggregator polled exactly K=3 times (one per requestId; the
    // per-request sequence yields OK on first poll).
    expect(aggregator.pollCalls.length).toBe(3);
    expect(aggregator.submitCalls.length).toBe(3);

    // Queue drained.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);

    // Step 9 re-run produced one VALID disposition.
    const validWrites = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'VALID',
    );
    expect(validWrites.length).toBe(1);
  });

  it('does not transition to valid until ALL K entries resolve', async () => {
    // First two entries resolve OK, third returns TRANSIENT forever
    // — the worker eventually times out via the polling-window
    //   safety net. We can't reach the safety net cheaply in a test;
    //   instead, drive a budget that exhausts via a finite poll
    //   sequence.
    const reqs = ['req-0', 'req-1', 'req-2'];
    const okPoll = {
      kind: 'OK' as const,
      proof: makeProof(),
      newCid: NEW_CID,
    };
    // For req-2, poll returns PATH_NOT_INCLUDED forever; we limit by
    // setting a tiny polling window so the worker bails quickly with
    // oracle-rejected (= hard-fail).
    const aggregator = makeFakeAggregator({
      perRequestPoll: new Map([
        ['req-0', [okPoll]],
        ['req-1', [okPoll]],
        ['req-2', Array.from({ length: 20 }, () => ({ kind: 'PATH_NOT_INCLUDED' as const }))],
      ]),
    });

    let now = 1_000_000_000_000;
    const harness = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        // Advance the deterministic clock by 5 minutes per sleep.
        now += 5 * 60 * 1000;
      },
      pollingWindowMs: 30 * 60 * 1000,
    });

    const entries = reqs.map((req, i) =>
      makeQueueEntry({
        entryId: entryIdFor(TOKEN_ID, i),
        txIndex: i,
        commitmentRequestId: req,
      }),
    );
    await seedQueue(harness, entries);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.successCount).toBe(2);
    expect(result.hardFailCount).toBe(1);
    // Hard-fail cascades to terminal 'invalid'.
    expect(result.terminal).toBe('invalid');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    expect(result.cascadeInvoked).toBe(true);

    // Self-invalidation written.
    const invalidWrites = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalidWrites.length).toBeGreaterThanOrEqual(1);
    expect(invalidWrites[0].record.tokenId).toBe(TOKEN_ID);
  });
});

describe('FinalizationWorkerRecipient — race-lost (C12)', () => {
  it('poll OK with mismatching transactionHash → race-lost; NO cascade', async () => {
    const aggregator = makeFakeAggregator({
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({ transactionHash: RACE_TX_HASH }),
        newCid: NEW_CID,
      }),
    });
    const harness = buildWorker({ aggregator });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('invalid');
    expect(result.firstHardFailReason).toBe('race-lost');
    // Race-lost SKIPS cascade per §6.1.1.
    expect(result.cascadeInvoked).toBe(false);
    expect(harness.cascadeWalker.cascadeCalls.length).toBe(0);

    // Self-invalidation STILL applies — recipient's own copy is
    // still invalid (we observed a different transactionHash anchored).
    const invalidWrites = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalidWrites.length).toBe(1);
  });
});

describe('FinalizationWorkerRecipient — submit-side hard-fails', () => {
  it('AUTHENTICATOR_VERIFICATION_FAILED → belief-divergence + cascade', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const harness = buildWorker({ aggregator });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('belief-divergence');
    expect(result.cascadeInvoked).toBe(true);
    expect(harness.cascadeWalker.cascadeCalls.length).toBe(1);
    expect(harness.cascadeWalker.cascadeCalls[0].reason).toBe(
      'belief-divergence',
    );
  });

  it('REQUEST_ID_MISMATCH → client-error + operator-alert + NO cascade', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH' }),
    });
    const harness = buildWorker({ aggregator });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('client-error');
    expect(result.cascadeInvoked).toBe(false);
    // Operator alert emitted.
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:operator-alert',
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FinalizationWorkerRecipient — poll-side hard-fails (after retries)', () => {
  it('PATH_INVALID exhausts retries → proof-invalid + cascade', async () => {
    const aggregator = makeFakeAggregator({
      pollSequence: [
        { kind: 'PATH_INVALID' },
        { kind: 'PATH_INVALID' },
        { kind: 'PATH_INVALID' },
      ],
    });
    const harness = buildWorker({
      aggregator,
      maxProofErrorRetries: 3,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('proof-invalid');
    expect(result.cascadeInvoked).toBe(true);
  });

  it('NOT_AUTHENTICATED emits trustbase-warning before terminal', async () => {
    const aggregator = makeFakeAggregator({
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
      ],
    });
    const harness = buildWorker({
      aggregator,
      maxProofErrorRetries: 3,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('proof-invalid');
    const warnings = harness.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FinalizationWorkerRecipient — merge-path graft (§5.6)', () => {
  it('proof already attached + same value → fast-path remove without aggregator', async () => {
    const aggregator = makeFakeAggregator();
    // Pre-populate the pool's attached-proof map with a matching proof.
    const poolRead = makeFakePoolRead([
      {
        tokenId: TOKEN_ID,
        requestId: 'req-0',
        proof: makeProof(),
      },
    ]);
    const harness = buildWorker({ aggregator, poolRead });
    await seedQueue(harness, [
      makeQueueEntry({
        entryId: entryIdFor(TOKEN_ID, 0),
        commitmentRequestId: 'req-0',
      }),
    ]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('valid');
    expect(result.mergePathGraftCount).toBe(1);
    expect(result.successCount).toBe(0);
    // Aggregator NEVER called — merge-path bypasses submit + poll.
    expect(aggregator.submitCalls.length).toBe(0);
    expect(aggregator.pollCalls.length).toBe(0);

    // Queue drained.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);
  });

  it('proof already attached + DIFFERENT value → security-alert + hard-fail', async () => {
    const poolRead = makeFakePoolRead([
      {
        tokenId: TOKEN_ID,
        requestId: 'req-0',
        proof: makeProof({
          transactionHash: RACE_TX_HASH,
          authenticator: 'ee'.repeat(32),
        }),
      },
    ]);
    const harness = buildWorker({ poolRead });
    await seedQueue(harness, [
      makeQueueEntry({
        entryId: entryIdFor(TOKEN_ID, 0),
        commitmentRequestId: 'req-0',
      }),
    ]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('belief-divergence');
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('FinalizationWorkerRecipient — re-evaluator dispositions', () => {
  it('queue-drain re-runs [B]/[D]/[E]; [B] surfaces NOT_OUR_CURRENT_STATE → AUDIT(not-our-state)', async () => {
    const harness = buildWorker({
      revaluateHooks: makeFakeRevaluateHooks({ bindsToUs: false }),
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('not-our-state');
    const auditWrites = harness.dispositionWriter.writes.filter(
      (w) =>
        w.record.disposition === 'AUDIT' &&
        w.record.reason === 'not-our-state',
    );
    expect(auditWrites.length).toBe(1);
  });

  it('queue-drain re-runs [E]; isSpent=true → AUDIT(off-record-spend) → unspendable', async () => {
    const harness = buildWorker({
      revaluateHooks: makeFakeRevaluateHooks({ oracleIsSpent: true }),
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.terminal).toBe('unspendable');
    const auditWrites = harness.dispositionWriter.writes.filter(
      (w) =>
        w.record.disposition === 'AUDIT' &&
        w.record.reason === 'off-record-spend',
    );
    expect(auditWrites.length).toBe(1);
  });

  it('queue-drain re-runs [D]; conflicting head → CONFLICTING terminal', async () => {
    const harness = buildWorker({
      revaluateHooks: makeFakeRevaluateHooks({
        localManifest: { rootHash: PREVIOUS_CID, status: 'valid' },
      }),
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('conflicting');
    const conflictingWrites = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'CONFLICTING',
    );
    expect(conflictingWrites.length).toBe(1);
  });

  it('revaluateHooks returns null → re-evaluation skipped (terminal=in-progress)', async () => {
    const harness = buildWorker({
      revaluateHooks: makeFakeRevaluateHooks({ returnNull: true }),
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('in-progress');
  });
});

describe('FinalizationWorkerRecipient — concurrent ingest while queue draining', () => {
  it('parallel processQueueEntry calls do not corrupt queue', async () => {
    // Drive two entries in parallel; with cas-default mutex strategy
    // the worker proceeds without serializing.
    const reqs = ['req-0', 'req-1'];
    const aggregator = makeFakeAggregator({
      perRequestPoll: new Map(
        reqs.map((r) => [
          r,
          [
            {
              kind: 'OK' as const,
              proof: makeProof(),
              newCid: NEW_CID,
            },
          ],
        ]),
      ),
    });
    const harness = buildWorker({ aggregator });
    const entries = reqs.map((r, i) =>
      makeQueueEntry({
        entryId: entryIdFor(TOKEN_ID, i),
        txIndex: i,
        commitmentRequestId: r,
      }),
    );
    await seedQueue(harness, entries);

    const [r1, r2] = await Promise.all([
      harness.worker.processQueueEntry(entries[0]),
      harness.worker.processQueueEntry(entries[1]),
    ]);
    expect(r1.outcome.kind).toBe('success');
    expect(r2.outcome.kind).toBe('success');

    // Queue drained.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);
  });
});

describe('FinalizationWorkerRecipient — empty queue / replay', () => {
  it('processOneToken on empty queue still attempts re-evaluation (replay)', async () => {
    const harness = buildWorker();
    // No queue entries seeded.
    const result = await harness.worker.processOneToken(TOKEN_ID);
    // Re-evaluation runs even on empty queue (covers crash-between-
    // last-removal-and-revaluate per §5.5 step 5 step 4 idempotency).
    expect(result.entriesProcessed).toBe(0);
    expect(result.terminal).toBe('valid');
  });

  it('processOneToken with no hooks (returnNull) on empty queue → in-progress', async () => {
    const harness = buildWorker({
      revaluateHooks: makeFakeRevaluateHooks({ returnNull: true }),
    });
    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.entriesProcessed).toBe(0);
    expect(result.terminal).toBe('in-progress');
  });
});

describe('FinalizationWorkerRecipient — start/stop lifecycle', () => {
  it('start is idempotent; stop is idempotent', async () => {
    const harness = buildWorker({
      sleepFn: async () => undefined,
    });
    expect(harness.worker.isRunning()).toBe(false);
    harness.worker.start();
    expect(harness.worker.isRunning()).toBe(true);
    harness.worker.start(); // idempotent
    expect(harness.worker.isRunning()).toBe(true);
    await harness.worker.stop();
    expect(harness.worker.isRunning()).toBe(false);
    await harness.worker.stop(); // idempotent
    expect(harness.worker.isRunning()).toBe(false);
  });
});

describe('FinalizationWorkerRecipient — validation', () => {
  it('processOneToken rejects empty tokenId', async () => {
    const harness = buildWorker();
    await expect(harness.worker.processOneToken('')).rejects.toThrow();
  });

  it('rejects perAggregator <= 0', () => {
    expect(() =>
      buildWorker({
        perAgg: 0,
      }),
    ).toThrow();
  });

  it('rejects perToken <= 0', () => {
    expect(() =>
      buildWorker({
        perToken: 0,
      }),
    ).toThrow();
  });
});

// =============================================================================
// scanLoop production scheduler (#168)
// =============================================================================

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitFor timed out'));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * Real-yielding sleep so the scan loop's `safeSleep(0)` cooperative
 * yield actually gives the event loop a turn — required for `await
 * setTimeout` macrotasks (waitFor's polling, test deadlines) to fire.
 * `async () => undefined` is microtask-only and starves the loop into a
 * tight spin.
 */
const yieldingSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.min(ms, 5)));

describe('FinalizationWorkerRecipient — scanLoop (#168)', () => {
  it('processes a queued token within scanIntervalMs', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const entry = makeQueueEntry();
    await seedQueue(harness, [entry]);

    const processedTokenIds: string[] = [];
    const original = harness.worker.processOneToken.bind(harness.worker);
    harness.worker.processOneToken = async (id) => {
      processedTokenIds.push(id);
      return original(id);
    };

    harness.worker.start();
    try {
      await waitFor(() => processedTokenIds.includes(TOKEN_ID), 2000);
      expect(processedTokenIds).toContain(TOKEN_ID);
    } finally {
      await harness.worker.stop();
    }
  });

  it('processes ten tokens', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeQueueEntry({
          tokenId: `token-${i}`,
          entryId: entryIdFor(`token-${i}`, 0),
          commitmentRequestId: `req-${i}`,
        }),
      );
    }
    await seedQueue(harness, entries);

    const processedTokenIds = new Set<string>();
    const original = harness.worker.processOneToken.bind(harness.worker);
    harness.worker.processOneToken = async (id) => {
      processedTokenIds.add(id);
      return original(id);
    };

    harness.worker.start();
    try {
      await waitFor(() => processedTokenIds.size === 10, 3000);
      expect(processedTokenIds.size).toBe(10);
    } finally {
      await harness.worker.stop();
    }
  });

  it('continues on processOneToken throw — other tokens still process', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const entries = [
      makeQueueEntry({
        tokenId: 'token-throw',
        entryId: entryIdFor('token-throw', 0),
        commitmentRequestId: 'req-throw',
      }),
      makeQueueEntry({
        tokenId: 'token-ok-1',
        entryId: entryIdFor('token-ok-1', 0),
        commitmentRequestId: 'req-ok-1',
      }),
      makeQueueEntry({
        tokenId: 'token-ok-2',
        entryId: entryIdFor('token-ok-2', 0),
        commitmentRequestId: 'req-ok-2',
      }),
    ];
    await seedQueue(harness, entries);

    const processedTokenIds = new Set<string>();
    const original = harness.worker.processOneToken.bind(harness.worker);
    harness.worker.processOneToken = async (id) => {
      processedTokenIds.add(id);
      if (id === 'token-throw') throw new Error('synthetic');
      return original(id);
    };

    harness.worker.start();
    try {
      await waitFor(
        () =>
          processedTokenIds.has('token-ok-1') &&
          processedTokenIds.has('token-ok-2'),
        3000,
      );
      expect(processedTokenIds.has('token-ok-1')).toBe(true);
      expect(processedTokenIds.has('token-ok-2')).toBe(true);
      expect(processedTokenIds.has('token-throw')).toBe(true);
      const alerts = harness.events.events.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBeGreaterThan(0);
    } finally {
      await harness.worker.stop();
    }
  });

  it('stop() during scan exits cleanly', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const entry = makeQueueEntry();
    await seedQueue(harness, [entry]);

    harness.worker.start();
    expect(harness.worker.isRunning()).toBe(true);
    const start = Date.now();
    await harness.worker.stop();
    const elapsed = Date.now() - start;
    expect(harness.worker.isRunning()).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  it('default loop drives processOneToken (manualScan: false default)', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const entry = makeQueueEntry();
    await seedQueue(harness, [entry]);

    const processedTokenIds: string[] = [];
    const original = harness.worker.processOneToken.bind(harness.worker);
    harness.worker.processOneToken = async (id) => {
      processedTokenIds.push(id);
      return original(id);
    };

    harness.worker.start();
    try {
      await waitFor(() => processedTokenIds.length > 0, 2000);
      expect(processedTokenIds.length).toBeGreaterThan(0);
    } finally {
      await harness.worker.stop();
    }
  });
});

// =============================================================================
// Wave 5 steelman fix #2 — RECIPIENT_SCAN_LIST_HARD_GUARD truncation backoff
// =============================================================================

describe('FinalizationWorkerRecipient — RECIPIENT_SCAN_LIST_HARD_GUARD truncation backoff (Wave 5)', () => {
  it('truncation alert fires only at power-of-two cycle boundaries on permanent overrun', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    // Stub `queueStore.list` to return SCAN_LIST_HARD_GUARD + 1
    // synthetic entries every cycle. We use the recipient's exposed
    // constant via a probe import below.
    const { RECIPIENT_SCAN_LIST_HARD_GUARD } = await import(
      '../../../../modules/payments/transfer/finalization-worker-recipient'
    );
    const stubEntries = Array.from(
      { length: RECIPIENT_SCAN_LIST_HARD_GUARD + 1 },
      (_, i) =>
        // Use a tokenId outside any active address scope so the
        // worker's filter / inFlight guard never invokes processOneToken.
        // We only assert on the truncation alert pattern.
        ({
          tokenId: `synth-${i}`,
          entryId: `entry-synth-${i}`,
          commitmentRequestId: `req-synth-${i}`,
          submittedAt: 1700000000000,
          inclusionProof: null,
          txIndex: 0,
        }),
    );
    const readCalls = { count: 0 };
    // Hijack `list` to return our oversize batch.
    harness.queueStore.list = (async () => {
      readCalls.count += 1;
      return stubEntries;
    }) as typeof harness.queueStore.list;
    // Make processOneToken a no-op so the loop just iterates fast.
    harness.worker.processOneToken = (async () => undefined) as typeof harness.worker.processOneToken;

    harness.worker.start();
    try {
      await waitFor(() => readCalls.count >= 8, 5_000);
    } finally {
      await harness.worker.stop();
    }
    const truncationAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('truncating to first')
      );
    });
    // Strict-bounded: alerts < readCalls (the original bug fired
    // every cycle).
    expect(truncationAlerts.length).toBeGreaterThanOrEqual(1);
    expect(truncationAlerts.length).toBeLessThan(readCalls.count);
    const maxExpected = Math.floor(Math.log2(readCalls.count)) + 1;
    expect(truncationAlerts.length).toBeLessThanOrEqual(maxExpected);
  });
});

// Suppress unused-import warnings for this block.
void NEW_CID;
void RACE_TX_HASH;
void makeFakeAggregator;
void makeFakePoolRead;
void makeProof;

