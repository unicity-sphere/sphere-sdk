/**
 * UXF Transfer T.5.B — §6.1 race-lost detection (C12).
 *
 * The race-lost case is detected via the spec's TWO-STEP discriminator:
 *
 *   1. Submit returns `REQUEST_ID_EXISTS` — ambiguous: could be our own
 *      retry OR a race-winner's submit.
 *   2. Poll returns `OK` with a `transactionHash` that DOES NOT match
 *      our locally tracked one. The race-loser is now identified.
 *
 * Acceptance (C12, verbatim from T.5.B impl plan):
 *   "Race-lost detected via REQUEST_ID_EXISTS at submit + OK with
 *    mismatching transactionHash at poll. NOT via REQUEST_ID_MISMATCH."
 *
 * Cascade behavior (§6.1.1 race-lost special case):
 *   The cascade does NOT fire for race-lost — the source token is
 *   genuinely valid (race-winner's tx is on-chain), and the recipient
 *   never received our bundle. The outbox transitions to
 *   `failed-permanent` with reason='race-lost'; no
 *   `transfer:cascade-failed` events are emitted.
 *
 * Spec refs: §6.1 (race-loser detection at poll), §6.1.1 (race-lost
 * special case in cascade rule), §7.1 (OUTBOX_RACE_LOST).
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeOutboxEntry,
  makeProof,
  RACE_TX_HASH,
  NEW_CID,
} from './finalization-worker-sender-fixtures';

describe('§6.1 race-lost — REQUEST_ID_EXISTS + tx-hash mismatch on poll (C12)', () => {
  it('detects race-lost via the EXISTS+poll-mismatch path (NOT via REQUEST_ID_MISMATCH)', async () => {
    // Spec invariant: requestId = SHA-256(publicKey ‖ stateHash.imprint)
    // does NOT include transactionHash. Two different transitions over
    // the same source state therefore have IDENTICAL requestId. The
    // aggregator returns REQUEST_ID_EXISTS for the second submitter;
    // the second's worker polls, sees the proof's transactionHash
    // differs from local, and concludes race-lost.
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
    expect(result.firstHardFailMessage).toContain('OUTBOX_RACE_LOST');
  });

  it('race-lost SKIPS cascade per §6.1.1 special case', async () => {
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

    expect(result.cascadeFailedEmitted).toBe(false);
    const cascadeEvents = h.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(0);
  });

  it('race-lost does NOT attach the proof (the race-winner already won)', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_EXISTS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({ transactionHash: RACE_TX_HASH }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    expect(h.pool.attachCalls).toHaveLength(0);
    expect(h.tombstones.insertCalls).toHaveLength(0);
    // Queue entry stays — the source state is genuinely valid; only
    // the outbox entry is marked failed-permanent.
    expect(h.queue.entries.size).toBe(1);
  });

  it('race-lost via SUCCESS submit (not REQUEST_ID_EXISTS) is also handled', async () => {
    // Even when our submit returned SUCCESS (we thought we won), the
    // poll could still surface a different transactionHash if the
    // aggregator's anchor decision was for a different transition. The
    // worker handles this symmetrically.
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
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
  });

  it('outbox carries OUTBOX_RACE_LOST in the error field', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_EXISTS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof({ transactionHash: RACE_TX_HASH }),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    expect(h.outbox.entries().status).toBe('failed-permanent');
    expect(h.outbox.entries().error).toContain('OUTBOX_RACE_LOST');
  });
});
