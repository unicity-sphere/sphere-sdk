/**
 * W26 cross-restart persistence — steelman post-cutover.
 *
 * Bug: the finalization workers captured `startedAt = now()` per
 * `runRequestPipeline` invocation. On crash/restart, the worker
 * re-entered the poll phase with `startedAt = now()`, getting a fresh
 * 60-min hard safety net window — a token stuck PENDING across many
 * restarts could poll indefinitely.
 *
 * Fix: the deadline anchor is PERSISTED on the entry (sender:
 * `pollStartedAt`; recipient: `submittedAt`) and read from the
 * entry on subsequent passes — including post-restart.
 *
 * The pinned invariants (sender):
 *   1. First processOne() with `pollStartedAt === undefined` stamps it
 *      via outbox.update().
 *   2. Subsequent processOne() calls (simulating restart) DO NOT
 *      overwrite the persisted value.
 *   3. The deadline computation reads from the persisted anchor —
 *      a worker started at T0 + 50W observes elapsed = 50W against
 *      the prior anchor and the safety net fires immediately, even
 *      though `now() - thisProcessOneEntryTime ≈ 0`.
 */

import { describe, expect, it } from 'vitest';

import { POLLING_WINDOW_MS } from '../../../../extensions/uxf/pipeline/limits';
import {
  buildWorker,
  makeFakeAggregator,
  makeOutboxEntry,
} from './finalization-worker-sender-fixtures';

describe('FinalizationWorkerSender — W26 cross-restart persistence (steelman)', () => {
  it('first processOne() stamps pollStartedAt via outbox.update()', async () => {
    const T0 = 1700000000000;
    // The poll loop will safety-net-fire as soon as elapsed >= 2*W.
    // We use a clock that advances fast enough to terminate the loop
    // promptly while observing the W26 stamp behavior.
    let now = T0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        // Advance the clock past the safety net so the loop can
        // converge on the next isPollingTimedOut check.
        now += 3 * POLLING_WINDOW_MS;
        return { kind: 'PATH_NOT_INCLUDED' };
      },
    });
    const entry = makeOutboxEntry();
    expect(entry.pollStartedAt).toBeUndefined();

    const h = buildWorker({
      entry,
      aggregator,
      nowFn: () => now,
    });

    await h.worker.processOne(entry);

    // The persisted entry now carries pollStartedAt = T0 (the first
    // stamp value, captured before the clock advanced).
    const persisted = h.outbox.entries();
    expect(persisted.pollStartedAt).toBeDefined();
    expect(persisted.pollStartedAt).toBe(T0);
  });

  it('subsequent processOne() (simulating restart) reuses persisted pollStartedAt — safety net fires immediately', async () => {
    const T0 = 1700000000000;

    // Build with an entry that ALREADY has pollStartedAt = a long
    // time ago, simulating a worker restart well past the deadline.
    const PRIOR_POLL_STARTED_AT = T0 - 50 * POLLING_WINDOW_MS;
    const entry = makeOutboxEntry({
      status: 'finalizing',
      pollStartedAt: PRIOR_POLL_STARTED_AT,
    });

    // Clock at T0. The persisted anchor is 50 windows in the past, so
    // elapsed = 50W >> 2W → safety net fires on the FIRST poll-loop
    // check, before any sleep / poll.
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      // We don't expect this to be called, but defensively make it
      // a hard-fail path so a regression (failure to fire safety
      // net) surfaces as an infinite loop terminated by vitest's
      // own test timeout, not as a passing test.
      poll: async () => ({ kind: 'PATH_NOT_INCLUDED' }),
    });

    const h = buildWorker({
      entry,
      aggregator,
      nowFn: () => T0,
    });

    const result = await h.worker.processOne(entry);

    // The persisted entry's pollStartedAt is unchanged (no overwrite).
    const persisted = h.outbox.entries();
    expect(persisted.pollStartedAt).toBe(PRIOR_POLL_STARTED_AT);

    // The deadline computation used the PRIOR anchor, so the safety
    // net fired on the first poll-loop iteration. Worker hard-fails
    // with oracle-rejected on the safety-net path.
    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('oracle-rejected');
    const msg = result.firstHardFailMessage ?? '';
    expect(msg).toMatch(/safety-net-fired|2×/);
  });

  it('regression: pollStartedAt is monotonic (never overwritten on re-entry)', async () => {
    const T0 = 1700000000000;
    let now = T0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        // Advance enough to trip the safety net, terminating the
        // loop after one iteration.
        now += 3 * POLLING_WINDOW_MS;
        return { kind: 'PATH_NOT_INCLUDED' };
      },
    });

    // First pass — stamps pollStartedAt = T0.
    const entry = makeOutboxEntry();
    const h = buildWorker({ entry, aggregator, nowFn: () => now });
    await h.worker.processOne(entry);
    const stampedAt = h.outbox.entries().pollStartedAt;
    expect(stampedAt).toBe(T0);

    // The first call already terminated to failed-permanent. A
    // second call is now a no-op per the early-return guard. We
    // verify the persisted field stays put.
    await h.worker.processOne(h.outbox.entries());
    expect(h.outbox.entries().pollStartedAt).toBe(T0);
  });
});
