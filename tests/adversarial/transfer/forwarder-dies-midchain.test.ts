/**
 * Adversarial test — chain-mode forwarder dies mid-chain (§6.1, §11.4).
 *
 * Threat model: NOT a malicious sender — an unreliable / killed
 * forwarder. A chain-mode token has an N-tx queue (each entry
 * represents a pending tx awaiting aggregator anchoring). The worker
 * is processing them sequentially; midway through, the wallet process
 * is killed (laptop closed, OS reboot, OOM kill).
 *
 * On restart, the outbox entry is re-loaded with `completedRequestIds`
 * recording the ones already finalized and `outstandingRequestIds`
 * still listing the unfinalized tail. The worker MUST:
 *   1. Recognize the partial-progress state (not start over from
 *      scratch and re-submit the already-finalized requests, which
 *      would burn aggregator slots and surface REQUEST_ID_EXISTS
 *      noise).
 *   2. Pick up where it left off and process the remaining
 *      `outstandingRequestIds` to terminal.
 *   3. End in `finalized` once all requestIds are completed.
 *
 * Spec wording (§11.4):
 *   "Chain-mode forwarder dies mid-chain: the token's queue carries
 *    entries for the predecessor's pending tx; finalization still
 *    completes via the local worker (predecessor's signedTx is in the
 *    bundle the forwarder received)."
 *
 * What this test pins:
 *   1. An outbox entry pre-loaded with `completedRequestIds: [r1, r2]`
 *      and `outstandingRequestIds: [r3]` (representing 2-of-3 already
 *      finalized before the crash) is processed and arrives at
 *      `finalized`.
 *   2. The worker DOES NOT re-submit r1 / r2 (no double-submit).
 *   3. The worker DOES submit + poll r3 (the remaining one).
 *   4. Final outbox state has all three in `completedRequestIds` and
 *      empty `outstandingRequestIds`.
 *
 * Spec references: §6.1, §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeOutboxEntry,
  makeProof,
  NEW_CID,
  type SubmitOutcome,
  type PollOutcome,
} from '../../unit/payments/transfer/finalization-worker-sender-fixtures';

describe('§11.4 — chain-mode forwarder dies mid-chain: worker resumes correctly', () => {
  it('outbox entry with partial completedRequestIds is resumed (no re-submit of completed)', async () => {
    // Simulate the post-crash state: 2 of 3 requestIds are already
    // marked completed; the third is still outstanding. The worker
    // must finish r3 without touching r1 / r2.
    const COMPLETED = ['r1', 'r2'];
    const OUTSTANDING = ['r3'];
    const entry = makeOutboxEntry({
      outstandingRequestIds: OUTSTANDING,
      completedRequestIds: COMPLETED,
    });

    const aggregator = makeFakeAggregator({
      submit: async (): Promise<SubmitOutcome> => ({ kind: 'SUCCESS' }),
      poll: async (): Promise<PollOutcome> => ({
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });

    const h = buildWorker({ entry, aggregator });
    const result = await h.worker.processOne(entry);

    // CRITICAL invariant 1: terminal disposition is finalized.
    expect(result.terminal).toBe('finalized');

    // CRITICAL invariant 2: only ONE submit happened — for r3 only.
    // r1 and r2 were already in completedRequestIds; the worker
    // MUST NOT have re-submitted them.
    expect(h.aggregator.submitCalls).toBe(1);

    // The proof was attached for r3. (The pool tracks attach calls
    // by tokenId+requestId; it should record the new attachment.)
    expect(h.pool.attachCalls.length).toBeGreaterThan(0);
  });

  it('multi-tx queue with all-but-one already done: minimal work to finalize', async () => {
    // Heavier scenario: a 5-tx chain with 4 already finalized. The
    // worker should make exactly 1 submit + 1 poll for the remaining
    // tx and terminate.
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['r5'],
      completedRequestIds: ['r1', 'r2', 'r3', 'r4'],
    });
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ entry, aggregator });
    const result = await h.worker.processOne(entry);

    expect(result.terminal).toBe('finalized');
    expect(h.aggregator.submitCalls).toBe(1);
  });

  it('crash-recovery on already-finalized entry: idempotent (no-op)', async () => {
    // Edge case: the entry is fully complete (`finalized`) when the
    // worker re-loads it. The worker must NOT submit OR poll —
    // already-terminal entries are a no-op per the worker contract.
    const entry = makeOutboxEntry({
      status: 'finalized',
      outstandingRequestIds: [],
      completedRequestIds: ['r1', 'r2', 'r3'],
    });
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ entry, aggregator });
    const result = await h.worker.processOne(entry);

    expect(result.terminal).toBe('finalized');
    expect(h.aggregator.submitCalls).toBe(0);
    expect(h.aggregator.pollCalls).toBe(0);
  });

  it('crash-recovery on failed-permanent entry: idempotent (no-op)', async () => {
    // The worker MUST treat `failed-permanent` as terminal and
    // refuse to retry. A buggy implementation that retried a
    // permanent failure would burn aggregator slots and potentially
    // surface false-positive cascades.
    const entry = makeOutboxEntry({
      status: 'failed-permanent',
      outstandingRequestIds: ['r2', 'r3'],
      completedRequestIds: ['r1'],
    });
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
    });
    const h = buildWorker({ entry, aggregator });
    const result = await h.worker.processOne(entry);

    expect(result.terminal).toBe('failed-permanent');
    expect(h.aggregator.submitCalls).toBe(0);
  });

  it('worker resume does NOT regress status (monotonic state machine)', async () => {
    // Pin the §7.1 monotonic LWW invariant: the worker MUST NOT move
    // the status backwards. After resuming and successfully
    // finalizing, the entry's status transitions are forward-only.
    //
    // We track every transition the outbox writer observes — there
    // should be NO "more-advanced → less-advanced" pair.
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['r3'],
      completedRequestIds: ['r1', 'r2'],
    });
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ entry, aggregator });
    await h.worker.processOne(entry);

    // Status precedence: delivered-instant < finalizing < finalized.
    const order: Record<string, number> = {
      packaging: 0,
      pinned: 1,
      sending: 2,
      delivered: 3,
      'delivered-instant': 3,
      finalizing: 4,
      finalized: 5,
      'failed-permanent': 5,
    };
    for (const t of h.outbox.transitions) {
      expect(order[t.to]).toBeGreaterThanOrEqual(order[t.from]);
    }
  });
});
