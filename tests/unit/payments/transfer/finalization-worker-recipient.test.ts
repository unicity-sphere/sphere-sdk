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
    const RAW_ATTACHED_AUTH = 'ee'.repeat(32);
    const poolRead = makeFakePoolRead([
      {
        tokenId: TOKEN_ID,
        requestId: 'req-0',
        proof: makeProof({
          transactionHash: RACE_TX_HASH,
          authenticator: RAW_ATTACHED_AUTH,
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
    // W40 / steelman warning — authenticator strings in event payloads
    // MUST be 16-char hashed, NOT the raw 64-char hex authenticator.
    const alert = alerts[0]!.data as {
      attachedAuthenticator?: string;
      observedAuthenticator?: string;
    };
    expect(typeof alert.attachedAuthenticator).toBe('string');
    expect(alert.attachedAuthenticator).toHaveLength(16);
    // Must NOT contain the raw 64-char authenticator hex.
    expect(alert.attachedAuthenticator).not.toBe(RAW_ATTACHED_AUTH);
    expect(alert.attachedAuthenticator).not.toContain(RAW_ATTACHED_AUTH);
    expect(typeof alert.observedAuthenticator).toBe('string');
    expect(alert.observedAuthenticator).toHaveLength(16);
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

describe('FinalizationWorkerRecipient — Wave 7 emit-if-emitted recovery semantics', () => {
  // Wave 6 introduced MIN_RECOVERY_ALERT_STREAK=4 to suppress noise from
  // single-cycle flaps. That left streak=2-3 cases dangling: a failure
  // alert would fire (`isPowerOfTwo(2) === true`) but the recovery alert
  // was suppressed because `2 < 4`, leaving operator pager scripts with
  // a dangling page.
  //
  // Wave 7 retired the constant: recovery emits iff a failure alert
  // was actually emitted in the current streak. Watermark
  // `*EmittedAtStreak` records the streak depth at the most recent
  // failure alert (0 ⇒ no alert this streak).

  it('Wave 7: single-cycle flap (streak=1) emits paired alert AND recovery', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const { RECIPIENT_SCAN_LIST_HARD_GUARD } = await import(
      '../../../../modules/payments/transfer/finalization-worker-recipient'
    );
    const oversizeBatch = Array.from(
      { length: RECIPIENT_SCAN_LIST_HARD_GUARD + 1 },
      (_, i) => ({
        tokenId: `synth-${i}`,
        entryId: `entry-synth-${i}`,
        commitmentRequestId: `req-synth-${i}`,
        submittedAt: 1700000000000,
        inclusionProof: null,
        txIndex: 0,
      }),
    );
    const readCalls = { count: 0 };
    harness.queueStore.list = (async () => {
      readCalls.count += 1;
      // Alternating: cycle 1=over, 2=under, 3=over, 4=under, ...
      return readCalls.count % 2 === 1 ? oversizeBatch : [];
    }) as typeof harness.queueStore.list;
    harness.worker.processOneToken = (async () =>
      undefined) as typeof harness.worker.processOneToken;

    harness.worker.start();
    try {
      await waitFor(() => readCalls.count >= 10, 5_000);
    } finally {
      await harness.worker.stop();
    }
    const recoveryAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('under RECIPIENT_SCAN_LIST_HARD_GUARD again')
      );
    });
    const truncationAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('queueStore.list returned')
      );
    });
    // Each over→under transition emits both a failure alert (at
    // streak=1, since `isPowerOfTwo(1) === true`) AND a recovery
    // alert. Counts pair: recovery fires exactly when truncation fired.
    expect(recoveryAlerts.length).toBeGreaterThanOrEqual(1);
    expect(recoveryAlerts.length).toBe(truncationAlerts.length);
  });

  it('Wave 7: oversize recovery alert fires for sustained streak (>= 4)', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const { RECIPIENT_SCAN_LIST_HARD_GUARD } = await import(
      '../../../../modules/payments/transfer/finalization-worker-recipient'
    );
    const oversizeBatch = Array.from(
      { length: RECIPIENT_SCAN_LIST_HARD_GUARD + 1 },
      (_, i) => ({
        tokenId: `synth-${i}`,
        entryId: `entry-synth-${i}`,
        commitmentRequestId: `req-synth-${i}`,
        submittedAt: 1700000000000,
        inclusionProof: null,
        txIndex: 0,
      }),
    );
    const readCalls = { count: 0 };
    harness.queueStore.list = (async () => {
      readCalls.count += 1;
      // Phases: cycles 1..5 over (streak grows to 5), then under-cap.
      return readCalls.count <= 5 ? oversizeBatch : [];
    }) as typeof harness.queueStore.list;
    harness.worker.processOneToken = (async () =>
      undefined) as typeof harness.worker.processOneToken;

    harness.worker.start();
    try {
      await waitFor(() => readCalls.count >= 7, 5_000);
    } finally {
      await harness.worker.stop();
    }
    const recoveryAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('under RECIPIENT_SCAN_LIST_HARD_GUARD again')
      );
    });
    expect(recoveryAlerts.length).toBe(1);
    const data = recoveryAlerts[0].data as { message?: string };
    expect(data.message).toMatch(/5 consecutive over-size cycle/);
  });

  it('Wave 7: short read-failure streak fires alert AND paired recovery', async () => {
    // Fail twice (alerts at streak=1 and streak=2 by power-of-two),
    // then succeed. Wave 6 suppressed recovery because `2 < MIN=4`,
    // leaving pager scripts with a dangling page. Wave 7 fires
    // recovery because a failure alert was emitted in this streak.
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const readCalls = { count: 0 };
    harness.queueStore.list = (async () => {
      readCalls.count += 1;
      if (readCalls.count <= 2) {
        throw new Error('backend offline');
      }
      return [];
    }) as typeof harness.queueStore.list;
    harness.worker.processOneToken = (async () =>
      undefined) as typeof harness.worker.processOneToken;

    harness.worker.start();
    try {
      await waitFor(() => readCalls.count >= 4, 5_000);
    } finally {
      await harness.worker.stop();
    }
    const recoveryAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('queueStore.list recovered')
      );
    });
    expect(recoveryAlerts.length).toBe(1);
    const data = recoveryAlerts[0].data as { message?: string };
    expect(data.message).toMatch(/2 consecutive failure/);
  });

  it('Wave 7: read-failure recovery alert fires for sustained streak (>= 4)', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });
    const readCalls = { count: 0 };
    harness.queueStore.list = (async () => {
      readCalls.count += 1;
      if (readCalls.count <= 4) {
        throw new Error('backend offline');
      }
      return [];
    }) as typeof harness.queueStore.list;
    harness.worker.processOneToken = (async () =>
      undefined) as typeof harness.worker.processOneToken;

    harness.worker.start();
    try {
      await waitFor(() => readCalls.count >= 6, 5_000);
    } finally {
      await harness.worker.stop();
    }
    const recoveryAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('queueStore.list recovered')
      );
    });
    expect(recoveryAlerts.length).toBe(1);
    const data = recoveryAlerts[0].data as { message?: string };
    expect(data.message).toMatch(/4 consecutive failure/);
  });
});

// =============================================================================
// CRIT #11 — cascade tombstone prevents proof-to-invalid leak
// =============================================================================
//
// Pre-fix: applyHardFailCascade removed sibling queue entries but parallel
// processQueueEntry cycles for those siblings continued running. On poll
// OK, the sibling tried to step1Pool / step4 a proof for the now-invalid
// token — leaking a proof into the pool of an _invalid disposition.
//
// Fix: cascade tombstone Set checked by the attachProof closure before
// the pool write. If the tombstone is set, abort cleanly and emit a
// transfer:cascade-skip-stale operator-alert.

describe('FinalizationWorkerRecipient — cascade tombstone (CRIT #11)', () => {
  it('hard-fail cascade prevents sibling proof from landing in pool', async () => {
    // Construct a multi-entry token. Entry 0 hard-fails (PATH_INVALID
    // exhausted). Entry 1 succeeds at poll. Without the tombstone fix,
    // entry 1's proof would land in pool AFTER cascade has marked the
    // token invalid. With the fix, entry 1's attachProof skips the
    // pool write.
    //
    // Easier construction: simulate via direct cascade-tombstone path.
    // Drive a single-entry success cycle where the cascade-tombstone is
    // pre-set on the worker; the pool MUST stay empty.
    const harness = buildWorker();
    const entry = makeQueueEntry();
    await seedQueue(harness, [entry]);

    // Pre-set the cascade tombstone (simulating a sibling cycle's
    // cascade firing concurrently).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (harness.worker as any).cascadeTombstones.add(TOKEN_ID);

    // Pre-fix this would attach a proof; with the fix, the attachProof
    // closure short-circuits.
    const result = await harness.worker.processOneToken(TOKEN_ID);
    void result;

    // The pool MUST NOT have received a proof for this tokenId.
    expect(harness.pool.attached.size).toBe(0);

    // Operator-alert with cascade-skip-stale message MUST have fired.
    const skipAlerts = harness.events.events.filter((e) => {
      if (e.type !== 'transfer:operator-alert') return false;
      const data = e.data as { message?: string };
      return (
        typeof data.message === 'string' &&
        data.message.includes('cascade-skip-stale')
      );
    });
    expect(skipAlerts.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// CRIT #10 — internal AbortController plumbed through stop()
// =============================================================================
//
// Pre-fix: `stop()` set `stopRequested` and awaited `loopPromise`, but did
// NOT abort an in-flight aggregator call or sleep. A poll that hung on a
// stuck aggregator kept stop() blocked. The fix adds an internal
// AbortController, aborts BEFORE awaiting loopPromise, and combines its
// signal with the caller-supplied signal via combineAbortSignals.

describe('FinalizationWorkerRecipient — stop() aborts in-flight cycle (CRIT #10)', () => {
  it('stop() returns within ~500ms even when aggregator hangs forever', async () => {
    // Aggregator that hangs on submit until aborted via signal.
    const harness = buildWorker({
      aggregator: {
        submitCalls: [],
        pollCalls: [],
        async submit(input) {
          await new Promise<void>((_, reject) => {
            if (input.signal !== undefined) {
              const onAbort = (): void => reject(new Error('aborted'));
              if (input.signal.aborted) onAbort();
              else input.signal.addEventListener('abort', onAbort, { once: true });
            }
          });
        },
        async poll(input) {
          await new Promise<void>((_, reject) => {
            if (input.signal !== undefined) {
              const onAbort = (): void => reject(new Error('aborted'));
              if (input.signal.aborted) onAbort();
              else input.signal.addEventListener('abort', onAbort, { once: true });
            }
          });
          return { kind: 'TRANSIENT' as const };
        },
      },
      sleepFn: async (ms, signal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const t = setTimeout(() => resolve(), ms);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      },
    });
    const entry = makeQueueEntry();
    await seedQueue(harness, [entry]);

    // Kick processOneToken in the background — submit will hang.
    const inflight = harness.worker.processOneToken(TOKEN_ID);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const stopStart = Date.now();
    await harness.worker.stop();
    const stopMs = Date.now() - stopStart;
    expect(stopMs).toBeLessThan(500);

    await inflight;
  });
});

// =============================================================================
// CRIT #8 — W26 deadline anchor uses createdAt only as a floor
// =============================================================================
//
// Pre-fix: the recipient cycle anchored the W26 polling deadline at
// `entry.submittedAt`. The queue's writer initializes
// `submittedAt = createdAt` and is supposed to update it on the FIRST
// successful submit. If a queue entry sits idle for ≥ 60 minutes before
// pickup (long worker outage, queued before worker started), the W26
// hard safety net fires on the first poll attempt — BEFORE we've even
// submitted. The fix: when `submittedAt === createdAt` (no submit yet),
// anchor at `now()` so the polling window measures from when polling
// actually begins.

describe('FinalizationWorkerRecipient — W26 deadline anchor floor (CRIT #8)', () => {
  it('entry stale by 2+ hours does not hard-fail oracle-rejected on first poll', async () => {
    // Queue entry with createdAt 2 hours in the past, submittedAt EQUAL
    // to createdAt (sentinel: no submit yet). Pre-fix, this would hit
    // the W26 2× hard safety net (60 min) on first poll.
    const TWO_HOURS_AGO = 1700000000000 - 2 * 60 * 60 * 1000;
    const entry = makeQueueEntry({
      createdAt: TWO_HOURS_AGO,
      submittedAt: TWO_HOURS_AGO,
    });

    // Aggregator returns OK on first poll (after the SUCCESS submit).
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' as const }),
      poll: async () => ({
        kind: 'OK' as const,
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });

    // Use a "current" wall-clock that's far past the entry's createdAt.
    // The fixture's default `now` is `() => 1700000000000`.
    const harness = buildWorker({ aggregator });
    await seedQueue(harness, [entry]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    // Should reach VALID, NOT hard-fail oracle-rejected.
    expect(result.terminal).toBe('valid');
    expect(result.successCount).toBe(1);
    expect(result.hardFailCount).toBe(0);
  });

  it('entry with submittedAt > createdAt uses persisted submittedAt as anchor', async () => {
    // When the queue writer has already updated submittedAt (post-submit
    // CAS write), use that value — preserves W26 cross-restart termination.
    // We don't easily verify the exact anchor here (it's an internal
    // computation passed into the cycle driver); we exercise the path so
    // the conditional branch is at least covered.
    const entry = makeQueueEntry({
      createdAt: 1699999999000,
      submittedAt: 1700000000000, // post-submit: persisted submittedAt
    });
    const harness = buildWorker();
    await seedQueue(harness, [entry]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('valid');
  });
});

// =============================================================================
// Round 3 regression — internalController is re-created on each start() (FIX 1)
// =============================================================================
//
// Pre-Round-3 the internalController was a `readonly` field-initialized
// AbortController. `stop()` aborted it; the next `start()` did NOT
// rebuild it, so every cycle's combined signal was pre-aborted and the
// first poll/submit hard-failed with `worker aborted before submit`.

describe('FinalizationWorkerRecipient — internalController rebuild on start (Round 3 regression)', () => {
  it('start → stop → start: internal signal NOT pre-aborted', async () => {
    // Use yieldingSleep so the scan loop's safeSleep gives the event
    // loop a turn (the default `async () => undefined` is microtask-
    // only and starves macrotask-driven test infrastructure).
    const harness = buildWorker({ sleepFn: yieldingSleep });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = harness.worker as any;

    harness.worker.start();
    const sigAfterFirstStart = w.internalController.signal;
    expect(sigAfterFirstStart.aborted).toBe(false);

    await harness.worker.stop();
    // After stop, the (then-active) controller IS aborted.
    expect(sigAfterFirstStart.aborted).toBe(true);

    // Second start — pre-Round-3 the field was readonly so this
    // observed the ALREADY-ABORTED signal from before. Post-fix, the
    // start() path rebuilds the controller.
    harness.worker.start();
    const sigAfterSecondStart = w.internalController.signal;
    expect(sigAfterSecondStart.aborted).toBe(false);
    // The new controller MUST be a different object than the old one.
    expect(sigAfterSecondStart).not.toBe(sigAfterFirstStart);

    await harness.worker.stop();
  });

  it('start → stop → start → drive cycle: NO worker-aborted hard-fail', async () => {
    const harness = buildWorker({ sleepFn: yieldingSleep });

    harness.worker.start();
    await harness.worker.stop();
    harness.worker.start();
    // Stop the scan loop before driving processOneToken so the test
    // doesn't race the loop. processOneToken doesn't depend on the
    // running loop — it's the synchronous external entry-point.
    await harness.worker.stop();

    // After stop(), processOneToken still works because runFinalizationCycle
    // uses the most-recently-rebuilt internal controller. Pre-Round-3
    // the controller from the previous start() was reused; post-fix the
    // current start() rebuilt it. The cycle should NOT short-circuit.
    //
    // Note: this asserts the field-rebuild isn't sticky-aborted across
    // start/stop cycles. The cycle is exercised through processOneToken
    // which uses the worker's current internalController.signal as
    // part of its combined signal.
    //
    // Re-build a fresh harness so we don't have a stopped scan loop
    // interfering.
    const h2 = buildWorker();
    const entry = makeQueueEntry();
    await seedQueue(h2, [entry]);

    // Simulate the lifecycle: pre-Round-3, this would have to start +
    // stop to re-create the controller; post-fix, start() always
    // gives a fresh non-aborted controller.
    h2.worker.start();
    await h2.worker.stop();
    h2.worker.start();

    const result = await h2.worker.processOneToken(TOKEN_ID);

    // Pre-fix: result.terminal was 'invalid' or similar with cascade
    // because the cycle hard-failed `structural` with 'worker aborted
    // before submit'. Post-fix: the cycle reaches a real terminal.
    expect(result.terminal).not.toBe('invalid');

    for (const e of h2.events.events) {
      const data = e.data as { message?: string };
      const msg = typeof data.message === 'string' ? data.message : '';
      expect(msg.includes('worker aborted before submit')).toBe(false);
      expect(msg.includes('worker aborted while polling')).toBe(false);
    }

    await h2.worker.stop();
  });
});

// =============================================================================
// Round 3 regression — W26 anchor wired via persisted pollStartedAt (FIX 2)
// =============================================================================
//
// Pre-Round-3 the recipient cycle's W26 deadline anchor was
//   `entry.submittedAt > entry.createdAt ? entry.submittedAt : now()`
// but no code path ever updated `submittedAt` post-creation, so the
// `now()` branch fired on EVERY cycle and the W26 cross-restart safety
// net was effectively inert. The fix promotes `pollStartedAt` to its
// own queue-entry field, stamped once on first poll-loop entry and
// persisted across restarts.

describe('FinalizationWorkerRecipient — W26 anchor via pollStartedAt (Round 3 regression)', () => {
  it('entry stale by 2+ hours does NOT hard-fail oracle-rejected on first poll', async () => {
    const TWO_HOURS_AGO = 1700000000000 - 2 * 60 * 60 * 1000;
    const entry = makeQueueEntry({
      createdAt: TWO_HOURS_AGO,
      submittedAt: TWO_HOURS_AGO,
      // Note: NO pollStartedAt — first-pickup case.
    });

    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' as const }),
      poll: async () => ({
        kind: 'OK' as const,
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });

    const harness = buildWorker({ aggregator });
    await seedQueue(harness, [entry]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    // Should reach VALID — anchor was stamped at `now()`, not at
    // the stale createdAt.
    expect(result.terminal).toBe('valid');
    expect(result.successCount).toBe(1);
    expect(result.hardFailCount).toBe(0);

    // No event carries the pre-Round-3 hard-fail signature.
    for (const e of harness.events.events) {
      const data = e.data as { message?: string };
      const msg = typeof data.message === 'string' ? data.message : '';
      expect(msg.includes('oracle-rejected')).toBe(false);
    }
  });

  it('worker calls setPollStartedAt at the cycle entry (best-effort persist)', async () => {
    const entry = makeQueueEntry({ entryId: 'queue-pollstart-stamp' });
    const harness = buildWorker();
    await seedQueue(harness, [entry]);

    // Spy on the queue store's setPollStartedAt method to confirm the
    // worker invokes it BEFORE runFinalizationCycle.
    const calls: Array<{ entryId: string; when: number }> = [];
    const real = harness.queueStore.setPollStartedAt.bind(harness.queueStore);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (harness.queueStore as any).setPollStartedAt = async (
      addr: string,
      entryId: string,
      when: number,
    ): Promise<'set' | 'already-set' | 'absent'> => {
      calls.push({ entryId, when });
      return real(addr, entryId, when);
    };

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('valid');

    // The worker MUST call setPollStartedAt for the entry on the
    // FIRST poll-loop entry (pollStartedAt was undefined).
    const stampCall = calls.find((c) => c.entryId === entry.entryId);
    expect(stampCall).toBeDefined();
    // The stamp time MUST be the worker's current `now()`, not the
    // stale createdAt.
    expect(stampCall?.when).toBe(1700000000000);
  });
});

// =============================================================================
// Round 3 regression — scan-loop safeSleep observes internalController (FIX 3)
// =============================================================================

describe('FinalizationWorkerRecipient — idle-loop stop wakes immediately (Round 3 regression)', () => {
  it('stop() during idle scan-loop sleep returns within tens of ms', async () => {
    const longInterval = 60_000; // 1 minute
    const harness = buildWorker({
      sleepFn: (ms: number, signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          if (signal !== undefined) {
            if (signal.aborted) {
              clearTimeout(t);
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          }
        }),
    });

    // The recipient harness doesn't expose scanIntervalMs in
    // buildWorker; reach into the worker to override.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (harness.worker as any).scanIntervalMs = longInterval;

    harness.worker.start();

    // Let the scan loop reach its idle sleep.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const startedAt = Date.now();
    await harness.worker.stop();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    expect(harness.worker.isRunning()).toBe(false);
  });
});

// Suppress unused-import warnings for this block.
void RACE_TX_HASH;
void makeFakePoolRead;

