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

  // Steelman finding #158: the release closure returned by acquire()
  // MUST be idempotent. Without a `released` guard, a finally-then-
  // catch double-release inflates `permits` past `maxConcurrent` and
  // the W14/W26 cap silently degrades after a few error iterations.
  describe('CountingSemaphore — release idempotency (#158)', () => {
    it('double-release on the fast-path closure is a no-op', async () => {
      const sem = new CountingSemaphore(2);
      const release = await sem.acquire();
      expect(sem.available).toBe(1);
      release();
      expect(sem.available).toBe(2);
      // Second call: must NOT push permits past the configured cap.
      release();
      expect(sem.available).toBe(2);
    });

    it('triple-release is still capped at the original maxConcurrent', async () => {
      const sem = new CountingSemaphore(1);
      const release = await sem.acquire();
      release();
      release();
      release();
      expect(sem.available).toBe(1);
    });

    it('double-release on the wait-path closure is also a no-op', async () => {
      // Force the waiter codepath: drain the semaphore, queue a waiter,
      // release one permit to wake it, then verify the woken closure
      // is also idempotent.
      const sem = new CountingSemaphore(1);
      const r1 = await sem.acquire();
      let woken: (() => void) | null = null;
      const wakerPromise = sem.acquire().then((release) => {
        woken = release;
      });
      // Release first permit to wake the waiter.
      r1();
      await wakerPromise;
      expect(woken).not.toBeNull();
      expect(sem.available).toBe(0);
      woken!();
      expect(sem.available).toBe(1);
      // Double-release: must NOT inflate.
      woken!();
      expect(sem.available).toBe(1);
    });

    it('double-release on N concurrently-acquired permits keeps total at maxConcurrent', async () => {
      // Worst case: a buggy caller double-releases every single permit.
      // Without idempotency, `available` drifts to 2*maxConcurrent.
      const sem = new CountingSemaphore(8);
      const releases: Array<() => void> = [];
      for (let i = 0; i < 8; i++) {
        releases.push(await sem.acquire());
      }
      expect(sem.available).toBe(0);
      // First release wave (legit).
      for (const r of releases) r();
      expect(sem.available).toBe(8);
      // Buggy second release wave.
      for (const r of releases) r();
      expect(sem.available).toBe(8);
    });
  });
});

// =============================================================================
// 4. Wave 3 #6 — head-pointer compaction under heavy contention
// =============================================================================

describe('CountingSemaphore — head-pointer waiter queue (Wave 3 #6)', () => {
  it('1000+ waiters drain in FIFO order', async () => {
    // Pre-fix `Array.shift()` is O(n) per release; with 1000+ waiters
    // a release wave is O(n²) total. The post-fix head-pointer
    // strategy is amortized O(1) per dequeue. This test asserts FIFO
    // ordering across a 1000-waiter drain — the bug would surface as
    // either an ordering violation OR a stack-blowing performance
    // collapse on slow runners.
    const sem = new CountingSemaphore(1);
    const r0 = await sem.acquire();
    const N = 1000;
    const observed: number[] = [];
    const completions: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      completions.push(
        sem.acquire().then((release) => {
          observed.push(i);
          release();
        }),
      );
    }
    expect(sem.available).toBe(0);
    // Confirm waiterCount reflects the queue size (this surface is
    // exposed for telemetry / test assertions specifically).
    expect((sem as unknown as { waiterCount: number }).waiterCount).toBe(N);

    // Release the initial permit — the chain reaction wakes every
    // waiter in order. Each waiter releases its own permit before
    // exiting, so the chain runs synchronously (queue is drained).
    r0();
    await Promise.all(completions);

    expect(observed.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(observed[i]).toBe(i);
    }
    expect((sem as unknown as { waiterCount: number }).waiterCount).toBe(0);
    expect(sem.available).toBeGreaterThanOrEqual(1);
  });

  it('compaction runs under sustained churn — internal array stays bounded', async () => {
    // Beyond 32 dequeues with 2x consumed-vs-live, the implementation
    // slices off the consumed prefix. We can't directly observe the
    // backing array length, but `waiterCount` lets us assert the live
    // queue is correctly sized after a long sequence of pushes/pops.
    const sem = new CountingSemaphore(1);
    const r0 = await sem.acquire();
    // Push 200 waiters.
    const completions: Array<Promise<void>> = [];
    for (let i = 0; i < 200; i++) {
      completions.push(sem.acquire().then((rel) => rel()));
    }
    expect(
      (sem as unknown as { waiterCount: number }).waiterCount,
    ).toBe(200);
    r0();
    await Promise.all(completions);
    expect(
      (sem as unknown as { waiterCount: number }).waiterCount,
    ).toBe(0);
  });

  it('head-pointer drain preserves correctness when interleaved with new pushes', async () => {
    // Acquire / release / re-acquire pattern that exercises the
    // compaction path while new waiters arrive between drains.
    const sem = new CountingSemaphore(2);
    const acquired: Array<() => void> = [];
    acquired.push(await sem.acquire());
    acquired.push(await sem.acquire());
    const queued: Array<{ idx: number; promise: Promise<() => void> }> = [];
    for (let i = 0; i < 50; i++) {
      queued.push({ idx: i, promise: sem.acquire() });
    }
    // Drain in interleaved batches to push the head pointer past 32.
    for (let i = 0; i < 50; i++) {
      acquired[i % 2]!();
      const next = await queued[i]!.promise;
      acquired[i % 2] = next;
    }
    // Final cleanup.
    for (const r of acquired) r();
    expect(sem.available).toBeGreaterThanOrEqual(2);
    expect(
      (sem as unknown as { waiterCount: number }).waiterCount,
    ).toBe(0);
  });
});
