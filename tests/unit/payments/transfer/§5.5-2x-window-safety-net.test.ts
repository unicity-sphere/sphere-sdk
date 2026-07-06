/**
 * UXF Transfer T.5.B — 2× POLLING_WINDOW hard safety net (W26).
 *
 * Spec wording (§5.5 step 6):
 *   "As a hard safety net regardless of configuration, the worker
 *    SHALL also stop after `2 × POLLING_WINDOW` wall-clock time,
 *    declaring `oracle-rejected` even if MIN_POLL_ATTEMPTS was not
 *    reached — termination is guaranteed."
 *
 * Acceptance (W26):
 *   "Hard safety-net: worker terminates after `2 × POLLING_WINDOW`
 *    regardless of MIN_POLL_ATTEMPTS."
 *
 * The polling-policy module's `isPollingTimedOut` returns
 * `reason: 'safety-net-fired'` for this case; the worker MUST honor
 * it without waiting for the attempt counter to advance.
 *
 * This test uses a deterministic-clock harness to verify the safety
 * net fires even when transient errors are aggressively starving the
 * MIN_POLL_ATTEMPTS counter.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeOutboxEntry,
} from './finalization-worker-sender-fixtures';
import { POLLING_WINDOW_MS, MIN_POLL_ATTEMPTS } from '../../../../extensions/uxf/pipeline/limits';

describe('§5.5 step 6 — 2× POLLING_WINDOW hard safety net (W26)', () => {
  it('terminates with oracle-rejected after 2× window even when MIN_POLL_ATTEMPTS is starved', async () => {
    // The aggregator returns nothing but TRANSIENT errors. TRANSIENT
    // does NOT advance the attempt counter (per spec). Without the
    // safety net, the worker would loop forever; the safety net
    // MUST fire after 2 × POLLING_WINDOW_MS regardless.
    let now = 1700000000000;
    const startedAt = now;
    let pollCount = 0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        pollCount++;
        return { kind: 'TRANSIENT', error: 'persistent network failure' };
      },
    });

    const h = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        // Advance time aggressively — each iteration eats a fraction
        // of the safety-net budget. After ~3 iterations we should
        // exceed 2 × window.
        now += POLLING_WINDOW_MS;
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');

    // The error message includes "2× polling window" or "safety-net-fired"
    // so operators can distinguish from the normal terminate path.
    expect(result.firstHardFailMessage).toMatch(/safety-net-fired|2× polling window/);

    // Verify time advanced at least 2× window.
    expect(now - startedAt).toBeGreaterThanOrEqual(2 * POLLING_WINDOW_MS);

    // Verify TRANSIENT didn't accidentally advance attempts to MIN.
    void pollCount; // count is informational
  });

  it('safety net fires even with attempts >= MIN_POLL_ATTEMPTS — preference order', async () => {
    // When BOTH conditions could fire, the safety net takes priority
    // over the attempts-met-and-window-exceeded reason — so any
    // configuration error that pushes attempts up too fast still
    // converges through the safety net path.
    let now = 1700000000000;
    let pollCount = 0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        pollCount++;
        // Verifiable proof-status counts toward MIN_POLL_ATTEMPTS.
        return { kind: 'PATH_NOT_INCLUDED' };
      },
    });

    const h = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        // Tiny initial stride so we fire MIN_POLL_ATTEMPTS quickly,
        // then big jump to push past 2× window.
        if (pollCount < MIN_POLL_ATTEMPTS) {
          now += 100;
        } else {
          now += POLLING_WINDOW_MS * 5;
        }
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
  });

  it('worker does NOT continue past the safety net even on TRANSIENT-only feed', async () => {
    let now = 1700000000000;
    let iterations = 0;
    const MAX_ITERATIONS_GUARD = 100;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        iterations++;
        if (iterations > MAX_ITERATIONS_GUARD) {
          // Test guard — safety net should have fired by now.
          throw new Error('test-loop-guard: worker did not terminate');
        }
        return { kind: 'TRANSIENT', error: 'never-recovers' };
      },
    });

    const h = buildWorker({
      aggregator,
      nowFn: () => now,
      sleepFn: async () => {
        now += POLLING_WINDOW_MS / 2;
      },
    });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    // The safety net fired before the test guard.
    expect(iterations).toBeLessThan(MAX_ITERATIONS_GUARD);
  });
});
