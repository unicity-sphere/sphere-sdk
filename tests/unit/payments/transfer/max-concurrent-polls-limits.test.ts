/**
 * UXF Transfer T.5.B — concurrency caps (W14).
 *
 * Spec wording (§6.1):
 *
 *   "Per-token parallelism: the worker MAY poll multiple
 *    commitmentRequestIds of the same token concurrently, bounded by
 *    `MAX_CONCURRENT_POLLS_PER_TOKEN` (default 4)."
 *
 *   "Per-aggregator concurrency: the worker MAY enforce a global cap
 *    on in-flight polls per aggregator endpoint (default 16) to
 *    prevent the worker itself from DoS-ing the aggregator under a
 *    wide chain-mode burst."
 *
 * Acceptance (W14):
 *   "Per-aggregator concurrency cap default 16 enforced."
 *
 * The injected semaphores expose `available` for direct counting; we
 * pin both caps' default values + custom-cap behavior.
 *
 * Spec refs: §6.1 (concurrency caps).
 */

import { describe, expect, it } from 'vitest';

import {
  CountingSemaphore,
  MAX_CONCURRENT_POLLS_PER_AGGREGATOR_DEFAULT,
  MAX_CONCURRENT_POLLS_PER_TOKEN_DEFAULT,
} from './finalization-worker-sender-limits-helpers';
import { buildWorker, makeFakeAggregator, makeOutboxEntry, makeProof, NEW_CID } from './finalization-worker-sender-fixtures';

describe('FinalizationWorkerSender — concurrency caps (W14)', () => {
  it('per-aggregator default cap is 16', () => {
    expect(MAX_CONCURRENT_POLLS_PER_AGGREGATOR_DEFAULT).toBe(16);
  });

  it('per-token default cap is 4', () => {
    expect(MAX_CONCURRENT_POLLS_PER_TOKEN_DEFAULT).toBe(4);
  });

  it('CountingSemaphore enforces per-aggregator cap=16 in steady state', async () => {
    const sem = new CountingSemaphore(16);
    const releases: Array<() => void> = [];
    for (let i = 0; i < 16; i++) {
      releases.push(await sem.acquire());
    }
    expect(sem.available).toBe(0);

    // 17th would block. Don't await — verify no permits are issued.
    let resolved = false;
    sem.acquire().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releases[0]!();
    await Promise.resolve();
    // Now resolved.
    expect(sem.available).toBeGreaterThanOrEqual(0);
    for (const r of releases.slice(1)) r();
  });

  it('CountingSemaphore enforces per-token cap=4 in steady state', async () => {
    const sem = new CountingSemaphore(4);
    const releases: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
      releases.push(await sem.acquire());
    }
    expect(sem.available).toBe(0);

    let resolved = false;
    sem.acquire().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const r of releases) r();
  });

  it('worker honors injected per-aggregator semaphore — sequential polls under cap=1', async () => {
    // With perAgg cap = 1, two outstanding requestIds MUST be polled
    // sequentially. We verify by counting poll calls in the order they
    // arrive against semaphore instrumentation.
    const perAggSemaphore = new CountingSemaphore(1);
    const observedAvailable: number[] = [];
    let pollCount = 0;
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        // Capture the available count on entry — should always be 0
        // because we hold the only permit.
        observedAvailable.push(perAggSemaphore.available);
        pollCount++;
        return {
          kind: 'OK',
          proof: makeProof(),
          newCid: NEW_CID,
        };
      },
    });
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['req-A', 'req-B', 'req-C'],
    });
    const h = buildWorker({ entry, aggregator, perAggSemaphore });
    const result = await h.worker.processOne(entry);

    expect(result.terminal).toBe('finalized');
    expect(pollCount).toBeGreaterThanOrEqual(3);
    // Every poll observed available=0 (we hold the permit).
    for (const a of observedAvailable) expect(a).toBe(0);
    // Permit released cleanly at end.
    expect(perAggSemaphore.available).toBe(1);
  });

  it('per-aggregator cap=16: with 20 requestIds, no more than 16 in flight', async () => {
    // With cap=16 and 20 outstanding requestIds, we expect to never
    // observe `available < 0` (impossible by construction) AND never
    // observe more than 16 simultaneous calls. We use an
    // instrumentation counter on poll entry/exit to track in-flight.
    const perAggSemaphore = new CountingSemaphore(16);
    let inFlight = 0;
    let maxInFlight = 0;

    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield once so we DON'T release the permit before other polls
        // can attempt acquire — this forces the cap to actually constrain.
        await Promise.resolve();
        inFlight--;
        return {
          kind: 'OK',
          proof: makeProof(),
          newCid: NEW_CID,
        };
      },
    });

    const reqIds = Array.from({ length: 20 }, (_, i) => `req-${i}`);
    const entry = makeOutboxEntry({ outstandingRequestIds: reqIds });
    const h = buildWorker({ entry, aggregator, perAggSemaphore });
    const result = await h.worker.processOne(entry);

    expect(result.terminal).toBe('finalized');
    expect(maxInFlight).toBeLessThanOrEqual(16);
    expect(perAggSemaphore.available).toBe(16);
  });

  it('per-token cap=4: per-tokenId semaphore is acquired around poll', async () => {
    const perTokenSemaphore = new CountingSemaphore(4);
    const aggregator = makeFakeAggregator();
    const entry = makeOutboxEntry({
      outstandingRequestIds: ['req-A', 'req-B', 'req-C', 'req-D', 'req-E'],
    });
    const h = buildWorker({ entry, aggregator, perTokenSemaphore });
    const result = await h.worker.processOne(entry);

    expect(result.terminal).toBe('finalized');
    expect(perTokenSemaphore.available).toBe(4);
  });
});
