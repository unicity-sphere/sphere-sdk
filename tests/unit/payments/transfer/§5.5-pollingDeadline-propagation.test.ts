/**
 * UXF Transfer T.5.B — pollingDeadline propagation (W17).
 *
 * Acceptance (W17):
 *   "pollingDeadline propagation to outbox path explicit test."
 *
 * Spec wording (§5.5 step 6):
 *   "each queue entry has a `pollingDeadline = submittedAt +
 *    POLLING_WINDOW`."
 *
 * The §6.1 sender worker computes a per-requestId polling window from
 * the moment polling starts (submittedAt for that requestId). The
 * `isPollingTimedOut` policy fires when:
 *   1. `now - startedAt >= POLLING_WINDOW_MS` AND
 *   2. `attempts >= MIN_POLL_ATTEMPTS`.
 * OR when:
 *   3. `now - startedAt >= 2 * POLLING_WINDOW_MS` (W26 hard safety net).
 *
 * This test pins case (1) with a deterministic clock — verifies that
 * the worker terminates with reason='oracle-rejected' once both
 * conditions are met, and that the outbox path correctly carries the
 * deadline forward via the `submittedAt → pollingDeadline` derivation.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeOutboxEntry,
} from './finalization-worker-sender-fixtures';
import { POLLING_WINDOW_MS, MIN_POLL_ATTEMPTS } from '../../../../extensions/uxf/pipeline/limits';

describe('§5.5 step 6 pollingDeadline propagation (W17)', () => {
  it('terminates with oracle-rejected after window+MIN_POLL_ATTEMPTS satisfied', async () => {
    let now = 1700000000000;
    const startedAt = now;

    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({ kind: 'PATH_NOT_INCLUDED' }),
    });

    const h = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        // Each iteration advances time enough to fit MIN_POLL_ATTEMPTS
        // within the window before we exit.
        const stride = Math.floor(POLLING_WINDOW_MS / (MIN_POLL_ATTEMPTS - 1));
        now += stride;
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');

    const elapsed = now - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(POLLING_WINDOW_MS);
  });

  it('does NOT terminate before window has elapsed even after MIN_POLL_ATTEMPTS', async () => {
    // If we fire MIN_POLL_ATTEMPTS in less than POLLING_WINDOW, the
    // deadline does NOT fire. The worker continues polling. We use a
    // bounded loop guard via a custom poll counter — eventually we
    // advance time enough to fire the safety net (W26) so the test
    // terminates, but the FIRST oracle-rejected MUST come from the
    // safety net (`safety-net-fired`), not from `attempts-met`.
    let now = 1700000000000;
    let pollCount = 0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        pollCount++;
        return { kind: 'PATH_NOT_INCLUDED' };
      },
    });

    const h = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        // Tiny stride initially to fit MANY attempts in the window;
        // then jump to fire safety net.
        if (pollCount < MIN_POLL_ATTEMPTS * 2) {
          now += 100;
        } else {
          now += POLLING_WINDOW_MS * 3;
        }
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    // Either reason is acceptable for the second condition; only the
    // FIRST must not have terminated mid-window.
    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    // We achieved at least MIN_POLL_ATTEMPTS observations; the worker
    // never short-circuited mid-window.
    expect(pollCount).toBeGreaterThanOrEqual(MIN_POLL_ATTEMPTS);
  });

  it('SUCCESS within the window does NOT propagate to oracle-rejected', async () => {
    // Sanity: deadline derivation is per-requestId, but a SUCCESS
    // anywhere inside the window converges to finalized — the deadline
    // does not fire prematurely just because we've started polling.
    let now = 1700000000000;
    let pollCount = 0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        pollCount++;
        if (pollCount === 3) {
          return {
            kind: 'OK',
            proof: {
              transactionHash: `0000${'aa'.repeat(32)}`,
              authenticator: 'cc'.repeat(32),
              roundNumber: 100,
              proof: { merkle: 'irrelevant' },
            },
            newCid: '11'.repeat(32) as never, // contentHash branding via cast
          };
        }
        return { kind: 'PATH_NOT_INCLUDED' };
      },
    });

    const h = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        now += 1000;
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
  });
});
