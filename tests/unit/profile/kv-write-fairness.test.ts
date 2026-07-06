/**
 * Unit tests for `profile/kv-write-fairness.ts` (T.5.B.0.5).
 *
 * Covers: bounded concurrency, FIFO/round-robin ordering, `run`
 * try/finally semantics, metrics, and per-instance independence.
 *
 * Spec / ADR: `docs/uxf/ADR-005-kv-write-fairness.md`.
 */

import { describe, it, expect } from 'vitest';

import { KvWriteFairness } from '../../../extensions/uxf/profile/kv-write-fairness';
import { MAX_CONCURRENT_KV_WRITES } from '../../../extensions/uxf/pipeline/limits';

/**
 * Yield to the microtask queue enough times for queued promise
 * resolutions and `then` chains to flush. Vitest's fake timers are not
 * needed here — `KvWriteFairness` only uses microtasks.
 */
async function flushMicrotasks(): Promise<void> {
  // 4 awaits is sufficient for the chains in these tests; bumps higher
  // if future tests grow.
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

describe('KvWriteFairness — defaults & construction', () => {
  it('uses MAX_CONCURRENT_KV_WRITES as the default cap', async () => {
    const queue = new KvWriteFairness();
    // Acquire up to the cap — all should resolve immediately.
    for (let i = 0; i < MAX_CONCURRENT_KV_WRITES; i++) {
      await queue.acquire();
    }
    expect(queue.getMetrics()).toEqual({
      inflightCount: MAX_CONCURRENT_KV_WRITES,
      waitQueueDepth: 0,
    });
  });

  it('rejects non-finite or sub-1 maxConcurrent', () => {
    expect(() => new KvWriteFairness(0)).toThrow(/maxConcurrent/);
    expect(() => new KvWriteFairness(-1)).toThrow(/maxConcurrent/);
    expect(() => new KvWriteFairness(Number.NaN)).toThrow(/maxConcurrent/);
    expect(() => new KvWriteFairness(Number.POSITIVE_INFINITY)).toThrow(
      /maxConcurrent/,
    );
  });

  it('floors fractional maxConcurrent', async () => {
    const queue = new KvWriteFairness(2.9);
    // Cap is 2 → 3rd acquire must queue.
    await queue.acquire();
    await queue.acquire();
    let third = false;
    void queue.acquire().then(() => {
      third = true;
    });
    await flushMicrotasks();
    expect(third).toBe(false);
    expect(queue.getMetrics()).toEqual({
      inflightCount: 2,
      waitQueueDepth: 1,
    });
  });
});

describe('KvWriteFairness — bounded concurrency', () => {
  it('first N acquires resolve immediately when under cap=N', async () => {
    const queue = new KvWriteFairness(2);
    let firstResolved = false;
    let secondResolved = false;
    void queue.acquire().then(() => {
      firstResolved = true;
    });
    void queue.acquire().then(() => {
      secondResolved = true;
    });
    await flushMicrotasks();
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });

  it('the (N+1)-th acquire queues until a slot is released', async () => {
    const queue = new KvWriteFairness(2);
    await queue.acquire();
    await queue.acquire();

    let thirdResolved = false;
    const thirdPromise = queue.acquire().then(() => {
      thirdResolved = true;
    });
    await flushMicrotasks();
    expect(thirdResolved).toBe(false);
    expect(queue.getMetrics()).toEqual({
      inflightCount: 2,
      waitQueueDepth: 1,
    });

    queue.release();
    await thirdPromise;
    expect(thirdResolved).toBe(true);
    // Slot count is conserved: one was released, one was handed to the
    // queued waiter, so we should be back to inflightCount=2.
    expect(queue.getMetrics()).toEqual({
      inflightCount: 2,
      waitQueueDepth: 0,
    });
  });
});

describe('KvWriteFairness — FIFO / round-robin ordering', () => {
  it('5 queued acquires release in insertion order under cap=1', async () => {
    const queue = new KvWriteFairness(1);
    await queue.acquire(); // saturates the cap

    const order: number[] = [];
    const waiters: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      waiters.push(
        queue.acquire().then(() => {
          order.push(i);
        }),
      );
    }
    await flushMicrotasks();
    expect(queue.getMetrics()).toEqual({
      inflightCount: 1,
      waitQueueDepth: 5,
    });

    // Release one slot at a time. Each release should wake exactly the
    // next waiter in insertion order.
    for (let i = 0; i < 5; i++) {
      queue.release();
      await flushMicrotasks();
      expect(order).toEqual(Array.from({ length: i + 1 }, (_, k) => k));
    }
    await Promise.all(waiters);
    // After all 5 are released, the original holder still owns its slot;
    // we manually drain to leave the queue empty.
    queue.release();
    expect(queue.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
  });

  it('a fresh acquire racing with release does NOT jump the queue', async () => {
    // This is the load-bearing fairness test: even if a brand-new caller
    // arrives synchronously *between* a release and the queued waiter
    // resolving, the queued waiter gets the slot. The implementation
    // achieves this by handing the slot directly to the next waiter
    // without ever transiently dropping inflightCount.
    const queue = new KvWriteFairness(1);
    await queue.acquire(); // cap-saturating holder

    const order: string[] = [];
    const queued = queue.acquire().then(() => {
      order.push('queued');
    });
    await flushMicrotasks();

    // Release synchronously, then immediately schedule a fresh acquire
    // in the same tick. The queued waiter MUST be served first.
    queue.release();
    const fresh = queue.acquire().then(() => {
      order.push('fresh');
    });

    // Queued waiter resolved synchronously inside release(); flush to
    // observe.
    await queued;
    expect(order).toEqual(['queued']);
    expect(queue.getMetrics()).toEqual({
      inflightCount: 1,
      waitQueueDepth: 1,
    });

    // Now release the slot the formerly-queued waiter holds; that wakes
    // the fresh waiter.
    queue.release();
    await fresh;
    expect(order).toEqual(['queued', 'fresh']);

    // Drain.
    queue.release();
    expect(queue.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
  });
});

describe('KvWriteFairness — run() try/finally semantics', () => {
  it('releases the slot on resolve', async () => {
    const queue = new KvWriteFairness(1);
    const result = await queue.run(async () => {
      expect(queue.getMetrics().inflightCount).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(queue.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
  });

  it('releases the slot on reject', async () => {
    const queue = new KvWriteFairness(1);
    await expect(
      queue.run(async () => {
        expect(queue.getMetrics().inflightCount).toBe(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Critical: the slot is back even though the body threw.
    expect(queue.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
  });

  it('serializes work under cap=1 (round-robin via run)', async () => {
    const queue = new KvWriteFairness(1);
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) =>
      queue.run(async () => {
        order.push(i);
        await Promise.resolve();
        order.push(-i - 1);
      }),
    );
    await Promise.all(tasks);
    // No interleaving: each task's start and end are adjacent in `order`.
    expect(order).toEqual([0, -1, 1, -2, 2, -3, 3, -4, 4, -5]);
  });
});

describe('KvWriteFairness — metrics & instance isolation', () => {
  it('metrics reflect caller observations', async () => {
    const queue = new KvWriteFairness(3);
    expect(queue.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
    await queue.acquire();
    await queue.acquire();
    expect(queue.getMetrics()).toEqual({
      inflightCount: 2,
      waitQueueDepth: 0,
    });
    await queue.acquire();
    expect(queue.getMetrics()).toEqual({
      inflightCount: 3,
      waitQueueDepth: 0,
    });
    // 4th queues.
    void queue.acquire();
    void queue.acquire();
    await flushMicrotasks();
    expect(queue.getMetrics()).toEqual({
      inflightCount: 3,
      waitQueueDepth: 2,
    });
  });

  it('two instances are fully independent (no shared state)', async () => {
    const a = new KvWriteFairness(1);
    const b = new KvWriteFairness(1);
    await a.acquire();
    // a is saturated; b should still be free.
    expect(a.getMetrics()).toEqual({
      inflightCount: 1,
      waitQueueDepth: 0,
    });
    expect(b.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
    await b.acquire();
    expect(b.getMetrics()).toEqual({
      inflightCount: 1,
      waitQueueDepth: 0,
    });
    // Releasing a does not affect b.
    a.release();
    expect(a.getMetrics()).toEqual({
      inflightCount: 0,
      waitQueueDepth: 0,
    });
    expect(b.getMetrics()).toEqual({
      inflightCount: 1,
      waitQueueDepth: 0,
    });
    b.release();
  });
});

describe('KvWriteFairness — cap value defaults to limits.ts', () => {
  it('MAX_CONCURRENT_KV_WRITES is exported and equals 8', () => {
    expect(MAX_CONCURRENT_KV_WRITES).toBe(8);
  });
});
