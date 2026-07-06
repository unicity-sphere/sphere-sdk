/**
 * UXF Transfer T.5.C — recipient cascade-on-hard-fail.
 *
 * Verifies the §5.5 step 7 short-circuit semantics for the RECIPIENT
 * worker:
 *
 *  1. Hard-fail of any queue entry triggers the cascade walker (T.5.B.5).
 *  2. The recipient's own copy of the failing token is moved to
 *     `_invalid` via the disposition writer.
 *  3. ALL other queue entries for the same tokenId are removed
 *     (cascade short-circuit) — polling is cancelled.
 *  4. Race-lost SKIPS cascade per §6.1.1 — but self-invalidation
 *     STILL applies.
 *
 * Spec refs: §5.5 step 7, §6.1.1 (cascade rule + race-lost EXCEPTION),
 * §6.2 (recipient driver).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  NEW_CID,
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeFakeCascadeWalker,
  makeProof,
  makeQueueEntry,
  seedQueue,
} from './finalization-worker-recipient-fixtures';
import { entryIdFor } from '../../../../extensions/uxf/pipeline/finalization-queue';

describe('recipient cascade — invoked on hard-fail', () => {
  it('belief-divergence triggers cascade walker', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const cascadeWalker = makeFakeCascadeWalker({ tokenClass: 'coin' });
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.cascadeInvoked).toBe(true);
    expect(harness.cascadeWalker.cascadeCalls.length).toBe(1);
    expect(harness.cascadeWalker.cascadeCalls[0]).toEqual({
      addr: ADDR,
      tokenId: TOKEN_ID,
      reason: 'belief-divergence',
    });

    // Self-invalidation written.
    const invalid = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalid.length).toBe(1);
    expect(invalid[0].record.tokenId).toBe(TOKEN_ID);
    expect(
      invalid[0].record.disposition === 'INVALID' &&
        invalid[0].record.reason,
    ).toBe('belief-divergence');
  });

  it('hard-fail short-circuit removes ALL sibling queue entries for the tokenId', async () => {
    // K=3 chain entries; first one hard-fails → siblings cancelled.
    const reqs = ['req-0', 'req-1', 'req-2'];
    const aggregator = makeFakeAggregator({
      perRequestSubmit: new Map([
        ['req-0', [{ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' as const }]],
        ['req-1', [{ kind: 'SUCCESS' as const }]],
        ['req-2', [{ kind: 'SUCCESS' as const }]],
      ]),
      perRequestPoll: new Map([
        ['req-1', [{ kind: 'OK' as const, proof: makeProof(), newCid: NEW_CID }]],
        ['req-2', [{ kind: 'OK' as const, proof: makeProof(), newCid: NEW_CID }]],
      ]),
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

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('invalid');
    expect(result.cascadeInvoked).toBe(true);

    // After cascade, ALL queue entries for this tokenId removed.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);
  });

  it('proof-invalid hard-fail (after retries) triggers cascade', async () => {
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
    expect(harness.cascadeWalker.cascadeCalls[0].reason).toBe(
      'proof-invalid',
    );
  });

  it('oracle-rejected hard-fail triggers cascade', async () => {
    let now = 1_000_000_000_000;
    const aggregator = makeFakeAggregator({
      pollSequence: Array.from({ length: 20 }, () => ({
        kind: 'PATH_NOT_INCLUDED' as const,
      })),
    });
    const harness = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        now += 5 * 60 * 1000; // advance 5 min per sleep
      },
      pollingWindowMs: 30 * 60 * 1000,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    expect(result.cascadeInvoked).toBe(true);
  });
});

describe('recipient cascade — race-lost EXCEPTION (§6.1.1)', () => {
  it('race-lost triggers self-invalidation but NOT cascade', async () => {
    const aggregator = makeFakeAggregator({
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({
          transactionHash: `0000${'bb'.repeat(32)}`, // mismatching
        }),
        newCid: NEW_CID,
      }),
    });
    const cascadeWalker = makeFakeCascadeWalker({ tokenClass: 'coin' });
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.firstHardFailReason).toBe('race-lost');
    expect(result.cascadeInvoked).toBe(false);
    // Cascade walker NOT invoked.
    expect(harness.cascadeWalker.cascadeCalls.length).toBe(0);
    // Self-invalidation STILL applies.
    const invalid = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalid.length).toBe(1);
    if (invalid[0].record.disposition === 'INVALID') {
      expect(invalid[0].record.reason).toBe('race-lost');
    }
  });

  it('client-error (REQUEST_ID_MISMATCH) skips cascade like race-lost', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH' }),
    });
    const cascadeWalker = makeFakeCascadeWalker({ tokenClass: 'coin' });
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('client-error');
    // client-error sets skipCascade=true (matches T.5.B behavior).
    expect(harness.cascadeWalker.cascadeCalls.length).toBe(0);
  });
});
