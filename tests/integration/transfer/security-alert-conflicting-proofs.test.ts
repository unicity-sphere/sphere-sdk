/**
 * UXF Inter-Wallet Transfer T.5.E — `transfer:security-alert` for
 * forbidden two-different-proofs case (C10 / §6.3).
 *
 * Per §6.3, observing two proofs for the SAME `requestId` with
 * DIFFERENT `(transactionHash, authenticator)` is the explicit
 * single-spend-invariant violation. This is THE one case where
 * `transfer:security-alert` fires per §9.4.
 *
 * The recipient worker has TWO emission paths for the C10 case:
 *
 *   PATH 1 (pre-merge graft): on entering processQueueEntry, the worker
 *     reads the pool for any pre-attached proof at the entry's requestId.
 *     If one exists with a DIFFERENT (transactionHash, authenticator)
 *     → emit security-alert + hard-fail with `belief-divergence`.
 *
 *   PATH 2 (post-poll conflict): after polling OK, the worker calls
 *     `checkProofConflict()` which re-reads the pool — if a pre-attach
 *     occurred CONCURRENTLY with our submit/poll, the same forbidden
 *     case is detected. Same emission + hard-fail.
 *
 * Both paths route to the same `transfer:security-alert` event with the
 * same payload shape; this test exercises BOTH.
 *
 * Spec refs: §6.3 (most-recent-proof + forbidden case), C10
 * (two-different-proofs), §9.4 (security-alert reservation).
 */

import { describe, expect, it } from 'vitest';

import { hashAuthenticatorForLog } from '../../../extensions/uxf/pipeline/finalization-worker-base';
import {
  ADDR,
  FORGED_AUTHENTICATOR,
  FORGED_TX_HASH,
  LOCAL_AUTHENTICATOR,
  LOCAL_TX_HASH,
  NEW_CID,
  RACE_TX_HASH,
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeFakePoolRead,
  makeProof,
  makeQueueEntry,
  seedQueue,
} from '../../unit/payments/transfer/finalization-worker-recipient-fixtures';

describe('§6.3 / C10 — transfer:security-alert (forbidden two-proofs)', () => {
  it('PATH 1: pre-attached proof DIFFERENT value → security-alert + belief-divergence', async () => {
    // Pre-populate the pool with a "forged" proof for our requestId
    // that disagrees on BOTH transactionHash AND authenticator.
    const poolRead = makeFakePoolRead([
      {
        tokenId: TOKEN_ID,
        requestId: 'req-0',
        proof: makeProof({
          transactionHash: FORGED_TX_HASH,
          authenticator: FORGED_AUTHENTICATOR,
        }),
      },
    ]);
    const harness = buildWorker({ poolRead });
    await seedQueue(harness, [
      makeQueueEntry({ commitmentRequestId: 'req-0' }),
    ]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.firstHardFailReason).toBe('belief-divergence');
    expect(result.terminal).toBe('invalid');

    // Exactly ONE security-alert emitted with the correct payload.
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(1);

    const a = alerts[0]!.data as {
      tokenId: string;
      requestId: string;
      attachedTransactionHash: string;
      observedTransactionHash: string;
      attachedAuthenticator?: string;
      observedAuthenticator?: string;
      message: string;
    };
    expect(a.tokenId).toBe(TOKEN_ID);
    expect(a.requestId).toBe('req-0');
    // The "attached" was the forged one; the "observed" was ours
    // (the local request context).
    expect(a.attachedTransactionHash).toBe(FORGED_TX_HASH);
    expect(a.observedTransactionHash).toBe(LOCAL_TX_HASH);
    // W40 — security-alert event payload carries hashAuthenticatorForLog(...)
    // (16-hex SHA-256 prefix), not the raw authenticator. See commit eec34bd.
    expect(a.attachedAuthenticator).toBe(hashAuthenticatorForLog(FORGED_AUTHENTICATOR));
    expect(a.observedAuthenticator).toBe(hashAuthenticatorForLog(LOCAL_AUTHENTICATOR));
    expect(a.message.length).toBeGreaterThan(0);

    // §9.4 — trustbase-warning is RESERVED for routine NOT_AUTHENTICATED;
    // C10 is the §6.3 forbidden case that ONLY raises security-alert.
    const warnings = harness.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(0);

    // Self-invalidation written.
    const invalidWrites = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalidWrites.length).toBeGreaterThanOrEqual(1);

    // Sanity: queue drained.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);
  });

  it('PATH 1: pre-attached proof DIFFERENT authenticator only → security-alert', async () => {
    // Sub-case: same transactionHash, different authenticator — STILL
    // a §6.3 forbidden divergence (the (txHash, authenticator) pair
    // must match exactly).
    const poolRead = makeFakePoolRead([
      {
        tokenId: TOKEN_ID,
        requestId: 'req-0',
        proof: makeProof({
          transactionHash: LOCAL_TX_HASH,
          authenticator: FORGED_AUTHENTICATOR,
        }),
      },
    ]);
    const harness = buildWorker({ poolRead });
    await seedQueue(harness, [
      makeQueueEntry({ commitmentRequestId: 'req-0' }),
    ]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('belief-divergence');

    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(1);

    const a = alerts[0]!.data as {
      attachedAuthenticator?: string;
      observedAuthenticator?: string;
    };
    // W40 — security-alert event payload carries hashAuthenticatorForLog(...)
    // (16-hex SHA-256 prefix), not the raw authenticator. See commit eec34bd.
    expect(a.attachedAuthenticator).toBe(hashAuthenticatorForLog(FORGED_AUTHENTICATOR));
    expect(a.observedAuthenticator).toBe(hashAuthenticatorForLog(LOCAL_AUTHENTICATOR));
  });

  it('PATH 2: post-poll concurrent attach DIFFERENT value → security-alert via checkProofConflict', async () => {
    // Pre-populate poolRead with a forged attachedProof, but ALSO have
    // the aggregator return OK with our proof. The worker's
    // pre-merge-graft check (PATH 1) sees the attached proof first and
    // hard-fails before the poll even runs. To exercise PATH 2 we need
    // a poolRead that returns:
    //   - call 1 (merge-path graft check)  → null   (no conflict yet)
    //   - call 2 (post-poll checkProofConflict) → forged proof   (conflict)
    //
    // This mirrors a race where another concurrent ingest worker
    // grafted in a forged proof between our submit and our poll.
    let callCount = 0;
    const poolRead = {
      proofs: new Map(),
      async getAttachedProof(_tokenId: string, _requestId: string) {
        callCount += 1;
        if (callCount === 1) return null;
        return {
          transactionHash: FORGED_TX_HASH,
          authenticator: FORGED_AUTHENTICATOR,
          roundNumber: 200,
          proof: { merkle: 'forged' },
        };
      },
    };

    const aggregator = makeFakeAggregator({
      pollSequence: [
        {
          kind: 'OK',
          proof: makeProof(),
          newCid: NEW_CID,
        },
      ],
    });

    const harness = buildWorker({ aggregator, poolRead });
    await seedQueue(harness, [
      makeQueueEntry({ commitmentRequestId: 'req-0' }),
    ]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('belief-divergence');

    // Exactly ONE security-alert from PATH 2.
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(1);
    const a = alerts[0]!.data as {
      attachedTransactionHash: string;
      observedTransactionHash: string;
    };
    expect(a.attachedTransactionHash).toBe(FORGED_TX_HASH);
    expect(a.observedTransactionHash).toBe(LOCAL_TX_HASH);
  });

  it('legitimate same-value proof at requestId is NOT a security-alert', async () => {
    // Sanity: the §6.3 forbidden case is SPECIFICALLY
    // (txHash, authenticator) divergence. A pre-attached proof with
    // the SAME value is the merge-path graft (W15 idempotency) — fast
    // path, no event emitted.
    const poolRead = makeFakePoolRead([
      {
        tokenId: TOKEN_ID,
        requestId: 'req-0',
        proof: makeProof(),
      },
    ]);
    const harness = buildWorker({ poolRead });
    await seedQueue(harness, [
      makeQueueEntry({ commitmentRequestId: 'req-0' }),
    ]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('valid');

    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });

  it('race-lost (mismatching txHash from poll) is NOT a security-alert', async () => {
    // Sanity: race-lost (§6.1.1) is when our local txHash disagrees
    // with the aggregator's poll-returned proof — that's the
    // race-loser detection, NOT C10. Different code path, NO
    // security-alert; race-lost specifically skips cascade per §6.1.1.
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
    expect(result.firstHardFailReason).toBe('race-lost');
    expect(result.cascadeInvoked).toBe(false);

    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });
});
