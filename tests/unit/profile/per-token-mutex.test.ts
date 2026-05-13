/**
 * Tests for profile/per-token-mutex.ts — §5.5 step 9 strategies.
 *
 * Covers all 3 strategies (`'cas'`, `'rpc-release'`, `'bounded-hold'`),
 * per-tokenId serialization, parallelism across distinct tokenIds,
 * cleanup on rejection, and per-instance scoping.
 *
 * Bounded-hold timeout coverage lives in
 * `per-token-mutex-bounded-hold.test.ts` (W35) — kept separate so the
 * timer-bound test runs with real timers.
 */

import { describe, it, expect } from 'vitest';
import { PerTokenMutex } from '../../../profile/per-token-mutex';

/** Defer to the next microtask (does not yield to setTimeout). */
const microtask = (): Promise<void> => Promise.resolve();

/** Resolve after `ms` real-time milliseconds via setTimeout. */
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PerTokenMutex', () => {
  describe("strategy: 'cas'", () => {
    it('runs fn immediately (pass-through; no serialization)', async () => {
      const m = new PerTokenMutex();
      let aDone = false;
      let bSeenADone = false;

      const aPromise = m.acquire(
        'token1',
        async () => {
          await sleep(20);
          aDone = true;
          return 'a';
        },
        { strategy: 'cas' },
      );

      // While `a` is sleeping, fire `b` — under CAS, it should run
      // immediately (concurrent), NOT wait for `a`.
      const bPromise = m.acquire(
        'token1',
        async () => {
          // If we are pass-through, `aDone` should be false here.
          bSeenADone = aDone;
          return 'b';
        },
        { strategy: 'cas' },
      );

      const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
      expect(aResult).toBe('a');
      expect(bResult).toBe('b');
      // `b` ran while `a` was still sleeping → bSeenADone === false.
      expect(bSeenADone).toBe(false);
    });

    it('does not register inflight (so size stays 0 for CAS)', async () => {
      const m = new PerTokenMutex();
      const p = m.acquire('token1', async () => 'x', { strategy: 'cas' });
      // Synchronously after acquire, no inflight registered.
      expect(m.size()).toBe(0);
      await p;
    });
  });

  describe("strategy: 'rpc-release'", () => {
    it('serializes acquires for the same tokenId', async () => {
      const m = new PerTokenMutex();
      const order: string[] = [];

      const a = m.acquire(
        'token1',
        async () => {
          order.push('a-start');
          await sleep(20);
          order.push('a-end');
        },
        { strategy: 'rpc-release' },
      );

      const b = m.acquire(
        'token1',
        async () => {
          order.push('b-start');
          await sleep(5);
          order.push('b-end');
        },
        { strategy: 'rpc-release' },
      );

      await Promise.all([a, b]);

      // Order MUST be a-start, a-end, b-start, b-end (no interleave).
      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    it('different tokenIds run in parallel', async () => {
      const m = new PerTokenMutex();
      const order: string[] = [];

      const a = m.acquire(
        'token-A',
        async () => {
          order.push('A-start');
          await sleep(20);
          order.push('A-end');
        },
        { strategy: 'rpc-release' },
      );
      const b = m.acquire(
        'token-B',
        async () => {
          order.push('B-start');
          await sleep(5);
          order.push('B-end');
        },
        { strategy: 'rpc-release' },
      );

      await Promise.all([a, b]);

      // B runs while A is sleeping → B-end appears before A-end.
      expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
    });

    it('fn rejection releases the lock for the next caller', async () => {
      const m = new PerTokenMutex();
      const order: string[] = [];

      const a = m
        .acquire(
          'token1',
          async () => {
            order.push('a-start');
            await sleep(10);
            order.push('a-throw');
            throw new Error('a failed');
          },
          { strategy: 'rpc-release' },
        )
        .catch((e: unknown) => `rejected:${(e as Error).message}`);

      const b = m.acquire(
        'token1',
        async () => {
          order.push('b-start');
          return 'b-ok';
        },
        { strategy: 'rpc-release' },
      );

      const [aResult, bResult] = await Promise.all([a, b]);
      expect(aResult).toBe('rejected:a failed');
      expect(bResult).toBe('b-ok');
      expect(order).toEqual(['a-start', 'a-throw', 'b-start']);
      // Inflight cleared.
      expect(m.size()).toBe(0);
    });

    it('returns the fn result', async () => {
      const m = new PerTokenMutex();
      const result = await m.acquire(
        'token1',
        async () => 42,
        { strategy: 'rpc-release' },
      );
      expect(result).toBe(42);
    });

    it('clears inflight after success', async () => {
      const m = new PerTokenMutex();
      await m.acquire('token1', async () => undefined, { strategy: 'rpc-release' });
      // Allow microtasks for finally cleanup.
      await microtask();
      expect(m.size()).toBe(0);
    });
  });

  describe("strategy: 'bounded-hold'", () => {
    it('serializes acquires for the same tokenId (same as rpc-release)', async () => {
      const m = new PerTokenMutex();
      const order: string[] = [];

      const a = m.acquire(
        'token1',
        async () => {
          order.push('a-start');
          await sleep(20);
          order.push('a-end');
        },
        { strategy: 'bounded-hold', timeoutMs: 1000 },
      );
      const b = m.acquire(
        'token1',
        async () => {
          order.push('b-start');
          await sleep(5);
          order.push('b-end');
        },
        { strategy: 'bounded-hold', timeoutMs: 1000 },
      );

      await Promise.all([a, b]);

      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });

    it('rejects when timeoutMs is non-positive', async () => {
      const m = new PerTokenMutex();
      await expect(
        m.acquire('token1', async () => undefined, {
          strategy: 'bounded-hold',
          timeoutMs: 0,
        }),
      ).rejects.toThrow(/timeoutMs/);
    });

    it('returns fn result when fn completes within timeout', async () => {
      const m = new PerTokenMutex();
      const result = await m.acquire(
        'token1',
        async () => 'ok',
        { strategy: 'bounded-hold', timeoutMs: 1000 },
      );
      expect(result).toBe('ok');
    });
  });

  describe('per-instance scoping', () => {
    it('two PerTokenMutex instances are independent', async () => {
      const a = new PerTokenMutex();
      const b = new PerTokenMutex();

      // Hold a lock on instance `a`.
      let release!: () => void;
      const blocker = new Promise<void>((r) => {
        release = r;
      });

      const aHold = a.acquire('token1', async () => blocker, {
        strategy: 'rpc-release',
      });

      // The same tokenId on instance `b` should run immediately
      // (no shared state).
      let bRan = false;
      await b.acquire(
        'token1',
        async () => {
          bRan = true;
        },
        { strategy: 'rpc-release' },
      );
      expect(bRan).toBe(true);

      release();
      await aHold;
    });
  });

  describe('isLocked / size diagnostics', () => {
    it('isLocked tracks rpc-release acquires', async () => {
      const m = new PerTokenMutex();
      let release!: () => void;
      const blocker = new Promise<void>((r) => {
        release = r;
      });

      const p = m.acquire('token1', async () => blocker, {
        strategy: 'rpc-release',
      });
      // Yield once so the acquire chain has installed inflight.
      await microtask();
      expect(m.isLocked('token1')).toBe(true);
      release();
      await p;
      // After settle + microtasks, lock cleared.
      await microtask();
      expect(m.isLocked('token1')).toBe(false);
    });
  });
});
