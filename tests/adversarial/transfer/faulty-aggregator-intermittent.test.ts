/**
 * Adversarial test — faulty aggregator (intermittent PATH_NOT_INCLUDED)
 * (§6.1, §11.4, T.5.B).
 *
 * Threat model: NOT a malicious sender — a faulty / restarting / rolling
 * aggregator. The aggregator has anchored a commitment but its
 * IMMEDIATE response on poll #1 is PATH_NOT_INCLUDED (e.g., the SMT
 * cache hasn't been refreshed after a node restart). On poll #2, after
 * the node catches up, the response flips to OK.
 *
 * Spec wording (§11.4):
 *   "Faulty-aggregator path (intermittent PATH_NOT_INCLUDED): aggregator
 *    returns PATH_NOT_INCLUDED transiently (e.g., across an aggregator-
 *    node-restart). Worker keeps polling; eventually one poll returns
 *    OK and the token finalizes correctly. Verify that the worker
 *    DOES NOT terminate on first PATH_NOT_INCLUDED (it's the
 *    not-yet status, not a hard-fail)."
 *
 * Spec defense (§6.1):
 *   "PATH_NOT_INCLUDED is a NOT-YET status, not a hard-fail. The worker
 *    keeps polling per the §5.5 step 6 schedule until either:
 *      (a) a verifiable status is returned (OK / PATH_INVALID /
 *          NOT_AUTHENTICATED), or
 *      (b) the polling-window deadline fires.
 *    A single PATH_NOT_INCLUDED MUST NOT cascade-fail the token."
 *
 * What this test pins:
 *   1. Worker DOES NOT hard-fail on the first PATH_NOT_INCLUDED.
 *   2. Worker continues polling and eventually observes the OK
 *      response, then completes finalization correctly.
 *   3. The proof is attached on OK — proving the token is delivered
 *      as `valid`, not stuck or hard-failed.
 *   4. EVEN UNDER 5+ consecutive transient PATH_NOT_INCLUDED responses
 *      (followed by OK), the worker remains in the polling loop.
 *   5. The terminal disposition is `finalized`, NOT `failed-permanent`.
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
  type PollOutcome,
  type SubmitOutcome,
} from '../../unit/payments/transfer/finalization-worker-sender-fixtures';

/**
 * Build an aggregator whose poll() returns PATH_NOT_INCLUDED for the
 * first `failBefore` calls, then OK with a real proof.
 */
function makeIntermittentAggregator(failBefore: number) {
  let pollCount = 0;
  return makeFakeAggregator({
    submit: async (): Promise<SubmitOutcome> => ({ kind: 'SUCCESS' }),
    poll: async (): Promise<PollOutcome> => {
      pollCount++;
      if (pollCount <= failBefore) {
        return { kind: 'PATH_NOT_INCLUDED' };
      }
      return {
        kind: 'OK',
        proof: makeProof(),
        newCid: NEW_CID,
      };
    },
  });
}

describe('§11.4 — faulty aggregator: intermittent PATH_NOT_INCLUDED → eventual finalize', () => {
  it('1 PATH_NOT_INCLUDED then OK → token finalized', async () => {
    // Scenario: aggregator restart causes one stale-cache response,
    // then catches up. The worker's polling loop must continue.
    const aggregator = makeIntermittentAggregator(1);
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    // CRITICAL invariant 1: terminal is finalized, NOT failed-permanent.
    expect(result.terminal).toBe('finalized');

    // CRITICAL invariant 2: worker polled MORE than once (the
    // PATH_NOT_INCLUDED did NOT short-circuit the loop).
    expect(h.aggregator.pollCalls).toBeGreaterThanOrEqual(2);

    // The 4-step write happened: proof attached.
    expect(h.pool.attachCalls.length).toBeGreaterThan(0);
  });

  it('5 consecutive PATH_NOT_INCLUDED then OK → still finalizes', async () => {
    // Stress: aggregator is intermittently failing across 5 polls.
    // The worker must remain in the loop. (The polling-window has
    // not yet elapsed because the fixture's default sleepFn does not
    // advance the clock, so MIN_POLL_ATTEMPTS exhaustion does not
    // matter — the deadline is never reached.)
    const aggregator = makeIntermittentAggregator(5);
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
    expect(h.aggregator.pollCalls).toBeGreaterThanOrEqual(6);
    // No hard-fail reason — finalized is the terminal disposition.
    expect(result.firstHardFailReason).toBeUndefined();
  });

  it('10 PATH_NOT_INCLUDED + maxProofErrorRetries=0 → still finalizes (PATH_NOT_INCLUDED ≠ proof-error)', async () => {
    // Critical defense: PATH_NOT_INCLUDED is NOT one of the
    // proof-error retry consumers. Only PATH_INVALID and
    // NOT_AUTHENTICATED consume `proofErrorCount`. If a buggy
    // implementation were to count PATH_NOT_INCLUDED toward the
    // retry budget, repeated transient responses would force
    // hard-fail prematurely.
    //
    // We verify the contract by setting maxProofErrorRetries=0 and
    // observing 10 consecutive PATH_NOT_INCLUDED responses BEFORE OK.
    // If PATH_NOT_INCLUDED counted, we'd hit hard-fail at the first
    // retry budget overshoot. Since it does not count, we eventually
    // observe OK and finalize.
    const aggregator = makeIntermittentAggregator(10);
    const h = buildWorker({
      aggregator,
      maxProofErrorRetries: 0, // budget exhausted IF PATH_NOT_INCLUDED counted
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
    expect(result.firstHardFailReason).toBeUndefined();
  });

  it('NO transfer:security-alert emitted on intermittent transient', async () => {
    // Pin a critical defense: a transient PATH_NOT_INCLUDED MUST NOT
    // emit `transfer:security-alert`. Security-alert is reserved for
    // §6.3 "two-different-values for same requestId" — a confirmed
    // single-spend invariant violation. Confusing the two would spam
    // operators and conceal real attacks.
    const aggregator = makeIntermittentAggregator(3);
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    const securityAlerts = h.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(securityAlerts).toHaveLength(0);
  });

  it('NO transfer:trustbase-warning emitted on intermittent transient', async () => {
    // PATH_NOT_INCLUDED is a NOT-YET — neither a security-alert nor a
    // trustbase-warning. trustbase-warning is reserved for
    // NOT_AUTHENTICATED (per §5.5 / §6.1 trustBase staleness path).
    const aggregator = makeIntermittentAggregator(3);
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    const trustbaseWarnings = h.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(trustbaseWarnings).toHaveLength(0);
  });
});
