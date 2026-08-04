// The shared concurrency primitives (PR #727 review: seven hand-rolled copies
// collapsed into async.ts). The load-bearing property both pins: progress on
// SETTLED, never fulfilled — one rejection must never brick later work.

import { describe, expect, it } from 'vitest';

import { SerialChain, SingleFlight } from '../../../modules/payments-v2/async';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SingleFlight', () => {
  it('coalesces concurrent calls onto ONE run and returns the same promise', async () => {
    const flight = new SingleFlight<number>();
    const gate = deferred<number>();
    let runs = 0;
    const p1 = flight.run(() => {
      runs += 1;
      return gate.promise;
    });
    const p2 = flight.run(() => {
      runs += 1;
      return gate.promise;
    });
    expect(p2).toBe(p1);
    gate.resolve(7);
    expect(await Promise.all([p1, p2])).toEqual([7, 7]);
    expect(runs).toBe(1);
  });

  it('starts a fresh run after the previous one fulfilled', async () => {
    const flight = new SingleFlight<number>();
    expect(await flight.run(async () => 1)).toBe(1);
    expect(await flight.run(async () => 2)).toBe(2);
  });

  it('rejection-recovery: a rejected flight reaches every coalesced caller and the NEXT call runs fresh', async () => {
    const flight = new SingleFlight<number>();
    const gate = deferred<number>();
    const p1 = flight.run(() => gate.promise);
    const p2 = flight.run(() => gate.promise);
    gate.reject(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    expect(await flight.run(async () => 42)).toBe(42);
  });
});

describe('SerialChain', () => {
  it('runs enqueued work strictly FIFO — the next fn starts only after the prior one settled', async () => {
    const chain = new SerialChain();
    const order: string[] = [];
    const gate = deferred<void>();
    const p1 = chain.enqueue(async () => {
      order.push('a:start');
      await gate.promise;
      order.push('a:end');
    });
    const p2 = chain.enqueue(async () => {
      order.push('b');
    });
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('each caller receives its own outcome (values and rejections stay per-enqueue)', async () => {
    const chain = new SerialChain();
    const p1 = chain.enqueue(async () => 'first');
    const p2 = chain.enqueue(async () => {
      throw new Error('second failed');
    });
    const p3 = chain.enqueue(async () => 'third');
    expect(await p1).toBe('first');
    await expect(p2).rejects.toThrow('second failed');
    expect(await p3).toBe('third');
  });

  it('rejection-recovery (the addSeen bricking class): a rejected head never blocks later enqueues', async () => {
    const chain = new SerialChain();
    await chain.enqueue(async () => {
      throw new Error('head rejected');
    }).catch(() => undefined);
    const ran: number[] = [];
    await chain.enqueue(async () => {
      ran.push(1);
    });
    await chain.enqueue(async () => {
      ran.push(2);
    });
    expect(ran).toEqual([1, 2]);
  });
});
