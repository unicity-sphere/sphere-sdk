/**
 * SpendQueue unit tests.
 *
 * Covers: enqueue/waitForEntry, notifyChange, timeout, capacity,
 * cancelAll, destroy, skip-ahead starvation protection, multi-coinId isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SpendQueue,
  SpendPlanner,
  QUEUE_TIMEOUT_MS,
  QUEUE_MAX_SIZE,
  MAX_SKIP_COUNT,
} from '../../../modules/payments/SpendQueue';
import type { ParsedTokenPool, ParsedTokenEntry, PlanResult } from '../../../modules/payments/SpendQueue';
import { TokenReservationLedger } from '../../../modules/payments/TokenReservationLedger';
import type { SplitPlan, TokenWithAmount } from '../../../modules/payments/TokenSplitCalculator';
import type { Token } from '../../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeToken(overrides: Partial<Token> & { id: string; coinId: string; amount: string }): Token {
  return {
    symbol: 'UCT',
    name: 'Test',
    decimals: 8,
    status: 'confirmed' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Token;
}

function makeSdkTokenStub(): any {
  return { coins: new Map() };
}

function makeParsedEntry(token: Token, amount: bigint): ParsedTokenEntry {
  return {
    token,
    sdkToken: makeSdkTokenStub(),
    amount,
  };
}

function buildPool(entries: Array<{ id: string; coinId: string; amount: bigint }>): ParsedTokenPool {
  const pool: ParsedTokenPool = new Map();
  for (const e of entries) {
    const tok = makeToken({ id: e.id, coinId: e.coinId, amount: e.amount.toString() });
    pool.set(e.id, makeParsedEntry(tok, e.amount));
  }
  return pool;
}

function nextId(): string {
  return `entry-${++idCounter}`;
}

/**
 * Create a direct (no-split) SplitPlan where the full token is transferred.
 * The reservation will reserve the full tokenAmount.
 */
function directPlan(entry: ParsedTokenEntry, coinId: string): SplitPlan {
  const twa: TokenWithAmount = { sdkToken: entry.sdkToken, amount: entry.amount, uiToken: entry.token };
  return {
    tokensToTransferDirectly: [twa],
    tokenToSplit: null,
    splitAmount: null,
    remainderAmount: null,
    totalTransferAmount: entry.amount,
    coinId,
    requiresSplit: false,
  };
}

/**
 * Create a split SplitPlan -- sends `sendAmount` from the entry, remainder stays.
 * The reservation will reserve only sendAmount from the token.
 */
function splitPlan(entry: ParsedTokenEntry, sendAmount: bigint, coinId: string): SplitPlan {
  const twa: TokenWithAmount = { sdkToken: entry.sdkToken, amount: entry.amount, uiToken: entry.token };
  return {
    tokensToTransferDirectly: [],
    tokenToSplit: twa,
    splitAmount: sendAmount,
    remainderAmount: entry.amount - sendAmount,
    totalTransferAmount: sendAmount,
    coinId,
    requiresSplit: true,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SpendQueue', () => {
  let ledger: TokenReservationLedger;
  let planner: SpendPlanner;
  let tokensMap: Map<string, Token>;
  let parsedTokenCache: Map<string, ParsedTokenEntry>;
  let queue: SpendQueue;

  /** Track all enqueued promises so we can catch rejections in afterEach. */
  let pendingPromises: Promise<PlanResult>[];

  /** Wrapper around queue.enqueue that tracks promises for cleanup. */
  function enq(
    entry: Parameters<typeof queue.enqueue>[0],
  ): Promise<PlanResult> {
    const p = queue.enqueue(entry);
    pendingPromises.push(p);
    return p;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    idCounter = 0;
    pendingPromises = [];

    ledger = new TokenReservationLedger();
    planner = new SpendPlanner();
    tokensMap = new Map();
    parsedTokenCache = new Map();

    queue = new SpendQueue(
      ledger,
      planner,
      () => tokensMap,
      parsedTokenCache,
    );
  });

  afterEach(async () => {
    queue.destroy();
    // Drain all pending promises to prevent unhandled rejections
    await Promise.allSettled(pendingPromises);
    vi.useRealTimers();
  });

  // =========================================================================
  // Basic enqueue + waitForEntry
  // =========================================================================

  describe('enqueue and waitForEntry', () => {
    it('enqueue returns a promise that resolves when notifyChange finds a plan', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const id = nextId();

      const promise = enq({
        id,
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      expect(queue.size()).toBe(1);

      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);

      // Use splitPlan so reservation is only for 100n, not the full 500n
      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        splitPlan(entry, 100n, 'UCT'),
      );

      queue.notifyChange('UCT');

      const result = await promise;
      expect(result.reservationId).toBe(id);
      expect(result.splitPlan).toBeDefined();
      expect(result.splitPlan.totalTransferAmount).toBe(100n);
      expect(queue.size()).toBe(0);
    });

    it('waitForEntry returns the same promise as enqueue', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const id = nextId();

      const enqueuePromise = enq({
        id,
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      const waitPromise = queue.waitForEntry(id);
      expect(waitPromise).toBe(enqueuePromise);
    });

    it('waitForEntry rejects for unknown entry id', async () => {
      await expect(queue.waitForEntry('nonexistent')).rejects.toThrow('Queue entry not found');
    });

    it('enqueue increments size per coinId', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);

      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '200', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 200n, enqueuedAt: Date.now() });

      expect(queue.size('UCT')).toBe(2);
      expect(queue.size()).toBe(2);
    });

    it('enqueue returns a promise that can be awaited via waitForEntry before resolution', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);
      const id = nextId();

      enq({
        id,
        request: { amount: '500', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 500n,
        enqueuedAt: Date.now(),
      });

      // waitForEntry must be called BEFORE resolution (promise exists in internal map)
      const waitPromise = queue.waitForEntry(id);

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        directPlan(entry, 'UCT'),
      );

      queue.notifyChange('UCT');

      const result = await waitPromise;
      expect(result.reservationId).toBe(id);
      expect(result.splitPlan.coinId).toBe('UCT');
    });
  });

  // =========================================================================
  // notifyChange
  // =========================================================================

  describe('notifyChange', () => {
    it('is synchronous and attempts planning for queued entries matching coinId', () => {
      // Use two separate tokens so both entries can be reserved independently
      const pool = buildPool([
        { id: 'tok-1', coinId: 'UCT', amount: 100n },
        { id: 'tok-2', coinId: 'UCT', amount: 200n },
      ]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);
      parsedTokenCache.set('tok-2', pool.get('tok-2')!);

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');
      spy.mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT'))
         .mockReturnValueOnce(directPlan(pool.get('tok-2')!, 'UCT'));

      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '200', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 200n, enqueuedAt: Date.now() });

      queue.notifyChange('UCT');

      expect(spy).toHaveBeenCalledTimes(2);
      expect(queue.size('UCT')).toBe(0);
    });

    it('does not affect entries for a different coinId', () => {
      const uctPool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 1000n }]);
      const usdcPool = buildPool([{ id: 'tok-2', coinId: 'USDC', amount: 1000n }]);

      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      queue.notifyChange('USDT'); // unrelated

      expect(spy).not.toHaveBeenCalled();
      expect(queue.size()).toBe(2);
    });

    it('resolves entry and creates ledger reservation', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);

      const id = nextId();
      const promise = enq({
        id,
        request: { amount: '300', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 300n,
        enqueuedAt: Date.now(),
      });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        splitPlan(entry, 300n, 'UCT'),
      );

      queue.notifyChange('UCT');

      const result = await promise;
      expect(result.reservationId).toBe(id);

      const reservation = ledger.getReservation(id);
      expect(reservation).toBeDefined();
      expect(reservation!.status).toBe('active');
      // Split reserves the FULL token amount (not just splitAmount)
      expect(reservation!.amounts.get('tok-1')).toBe(500n);
    });

    it('does nothing when there are no queued entries for the coinId', () => {
      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');
      queue.notifyChange('UCT');
      expect(spy).not.toHaveBeenCalled();
    });

    it('merges parsedTokenCache entries into the pool for planning', async () => {
      // Original pool has tok-1 (small), cache has tok-2 (new, large token)
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const tok2 = makeToken({ id: 'tok-2', coinId: 'UCT', amount: '500' });
      const cacheEntry = makeParsedEntry(tok2, 500n);
      parsedTokenCache.set('tok-2', cacheEntry);

      const id = nextId();
      const promise = enq({ id, request: { amount: '400', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 400n, enqueuedAt: Date.now() });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        splitPlan(cacheEntry, 400n, 'UCT'),
      );

      queue.notifyChange('UCT');

      const result = await promise;
      expect(result.reservationId).toBe(id);
      expect(queue.size()).toBe(0);
    });

    it('leaves entry in queue when planner returns null', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);

      enq({ id: nextId(), request: { amount: '1000', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 1000n, enqueuedAt: Date.now() });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValue(null);

      queue.notifyChange('UCT');

      expect(queue.size('UCT')).toBe(1);
    });

    it('reserves correct split amount in ledger for split plan', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 1000n }]);
      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);

      const id = nextId();
      const promise = enq({ id, request: { amount: '300', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 300n, enqueuedAt: Date.now() });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        splitPlan(entry, 300n, 'UCT'),
      );

      queue.notifyChange('UCT');

      await promise;

      // Split reserves the ENTIRE source token (split consumes whole token)
      expect(ledger.getTotalReserved('tok-1')).toBe(1000n);
      expect(ledger.getFreeAmount('tok-1', 1000n)).toBe(0n);
    });
  });

  // =========================================================================
  // Timeout
  // =========================================================================

  describe('timeout', () => {
    it('rejects entry with SEND_QUEUE_TIMEOUT after QUEUE_TIMEOUT_MS via setTimeout', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const promise = enq({
        id: nextId(),
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);

      await expect(promise).rejects.toThrow('Send queue timeout');
      expect(queue.size()).toBe(0);
    });

    it('timeout fires per-entry setTimeout independently', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const p1 = enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      vi.advanceTimersByTime(15_000);

      const p2 = enq({ id: nextId(), request: { amount: '200', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 200n, enqueuedAt: Date.now() });

      // Advance to expire first (31s total) but not second (16s total)
      vi.advanceTimersByTime(16_000);

      await expect(p1).rejects.toThrow('Send queue timeout');
      expect(queue.size('UCT')).toBe(1); // second still alive

      // Clean up
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS);
      await p2.catch(() => {});
    });

    it('notifyChange detects expired entry by enqueuedAt check', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const p1 = enq({
        id: nextId(),
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      // Advance system time past timeout (Date.now() updates but setTimeout doesn't fire)
      vi.setSystemTime(Date.now() + QUEUE_TIMEOUT_MS + 1);

      queue.notifyChange('UCT');

      await expect(p1).rejects.toThrow('Send queue timeout');
      expect(queue.size()).toBe(0);
    });

    it('per-entry timeout expires stale entries', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const p1 = enq({
        id: nextId(),
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);

      await expect(p1).rejects.toThrow('Send queue timeout');
      expect(queue.size()).toBe(0);
    });

    it('entry resolved before timeout does not fire timeout callback', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);
      const id = nextId();

      const promise = enq({
        id,
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        splitPlan(entry, 100n, 'UCT'),
      );

      vi.advanceTimersByTime(10_000);
      queue.notifyChange('UCT');

      const result = await promise;
      expect(result.reservationId).toBe(id);

      // Advance well past timeout — should be harmless since entry is already resolved
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS);

      expect(queue.size()).toBe(0);
    });

    it('timeout error has SEND_QUEUE_TIMEOUT error code', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const promise = enq({
        id: nextId(),
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);

      try {
        await promise;
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('SEND_QUEUE_TIMEOUT');
      }
    });
  });

  // =========================================================================
  // Queue capacity
  // =========================================================================

  describe('queue capacity', () => {
    it('rejects with SEND_QUEUE_FULL when queue reaches QUEUE_MAX_SIZE', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        enq({
          id: nextId(),
          request: { amount: '100', coinId: 'UCT' },
          parsedPool: pool,
          coinId: 'UCT',
          amount: 100n,
          enqueuedAt: Date.now(),
        });
      }

      expect(queue.size()).toBe(QUEUE_MAX_SIZE);

      const overflowPromise = enq({
        id: nextId(),
        request: { amount: '100', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 100n,
        enqueuedAt: Date.now(),
      });

      await expect(overflowPromise).rejects.toThrow('Send queue is full');
    });

    it('SEND_QUEUE_FULL error has correct error code', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      }

      try {
        await enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('SEND_QUEUE_FULL');
      }
    });

    it('counts entries across all coinIds toward QUEUE_MAX_SIZE', async () => {
      const uctPool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const usdcPool = buildPool([{ id: 'tok-2', coinId: 'USDC', amount: 100n }]);

      for (let i = 0; i < 50; i++) {
        enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      }
      for (let i = 0; i < 50; i++) {
        enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });
      }

      expect(queue.size()).toBe(100);

      const overflow = enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      await expect(overflow).rejects.toThrow('Send queue is full');
    });

    it('allows enqueue after removal brings size below QUEUE_MAX_SIZE', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      }

      // Expire all entries
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);
      expect(queue.size()).toBe(0);

      // Now should accept
      const newPromise = enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      expect(queue.size()).toBe(1);

      // Clean up
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);
      await newPromise.catch(() => {});
    });

    it('queue size does not increase for rejected overflow entries', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      for (let i = 0; i < QUEUE_MAX_SIZE; i++) {
        enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      }

      // Attempt overflow 5 times
      for (let i = 0; i < 5; i++) {
        await enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() }).catch(() => {});
      }

      expect(queue.size()).toBe(QUEUE_MAX_SIZE);
    });
  });

  // =========================================================================
  // cancelAll
  // =========================================================================

  describe('cancelAll', () => {
    it('rejects all pending entries with given reason', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() }),
        );
      }

      expect(queue.size()).toBe(5);

      queue.cancelAll('test cancellation');

      expect(queue.size()).toBe(0);

      for (const p of promises) {
        await expect(p).rejects.toThrow('test cancellation');
      }
    });

    it('clears entries across all coinIds', () => {
      const uctPool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const usdcPool = buildPool([{ id: 'tok-2', coinId: 'USDC', amount: 100n }]);

      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });

      expect(queue.size()).toBe(2);

      queue.cancelAll('shutdown');

      expect(queue.size()).toBe(0);
      expect(queue.size('UCT')).toBe(0);
      expect(queue.size('USDC')).toBe(0);
    });

    it('clears timeout handles so they do not fire after cancel', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const p = enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      queue.cancelAll('cancelled');

      // Advance past timeout -- should not cause additional errors
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);

      await expect(p).rejects.toThrow('cancelled');
    });

    it('rejects entries with MODULE_DESTROYED error code', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const p = enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      queue.cancelAll('some reason');

      try {
        await p;
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('MODULE_DESTROYED');
      }
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('cancels all entries with MODULE_DESTROYED error', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      const p = enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      queue.destroy();

      await expect(p).rejects.toThrow('Module destroyed');
      expect(queue.size()).toBe(0);
    });

    it('is idempotent', () => {
      queue.destroy();
      expect(() => queue.destroy()).not.toThrow();
    });

    it('clears all internal state', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      expect(queue.size()).toBe(2);

      queue.destroy();

      expect(queue.size()).toBe(0);
    });
  });

  // =========================================================================
  // size()
  // =========================================================================

  describe('size', () => {
    it('returns 0 for empty queue', () => {
      expect(queue.size()).toBe(0);
    });

    it('returns total count across all coinIds', () => {
      const uctPool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const usdcPool = buildPool([{ id: 'tok-2', coinId: 'USDC', amount: 100n }]);
      const usdtPool = buildPool([{ id: 'tok-3', coinId: 'USDT', amount: 100n }]);

      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDT' }, parsedPool: usdtPool, coinId: 'USDT', amount: 100n, enqueuedAt: Date.now() });

      expect(queue.size()).toBe(6);
      expect(queue.size('UCT')).toBe(2);
      expect(queue.size('USDC')).toBe(3);
      expect(queue.size('USDT')).toBe(1);
    });

    it('returns 0 for coinId with no entries', () => {
      expect(queue.size('UCT')).toBe(0);
    });

    it('decrements after entry is resolved', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);

      enq({ id: nextId(), request: { amount: '500', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 500n, enqueuedAt: Date.now() });
      expect(queue.size()).toBe(1);

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        directPlan(entry, 'UCT'),
      );
      queue.notifyChange('UCT');

      expect(queue.size()).toBe(0);
    });
  });

  // =========================================================================
  // Skip-ahead and starvation protection
  // =========================================================================

  describe('skip-ahead with starvation protection', () => {
    it('serves entries in FIFO order when all can be planned with separate tokens', async () => {
      // Two entries, two tokens -- each gets its own token
      const pool = buildPool([
        { id: 'tok-1', coinId: 'UCT', amount: 100n },
        { id: 'tok-2', coinId: 'UCT', amount: 100n },
      ]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);
      parsedTokenCache.set('tok-2', pool.get('tok-2')!);

      const resolveOrder: string[] = [];

      const p1 = enq({ id: 'first', request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      const p2 = enq({ id: 'second', request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      p1.then(() => resolveOrder.push('first'));
      p2.then(() => resolveOrder.push('second'));

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');
      spy.mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT'))
         .mockReturnValueOnce(directPlan(pool.get('tok-2')!, 'UCT'));

      queue.notifyChange('UCT');

      await Promise.all([p1, p2]);

      expect(resolveOrder).toEqual(['first', 'second']);
    });

    it('increments skipCount when head entry cannot be planned but later one can', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const entry1 = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry1);

      // Large entry first (needs 1000), small entry second (needs 100)
      const largeProm = enq({ id: 'large', request: { amount: '1000', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 1000n, enqueuedAt: Date.now() });
      const smallProm = enq({ id: 'small', request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      vi.spyOn(planner, 'calculateOptimalSplitSync')
        .mockReturnValueOnce(null)                    // large: can't plan
        .mockReturnValueOnce(directPlan(entry1, 'UCT')); // small: full token

      queue.notifyChange('UCT');

      const result = await smallProm;
      expect(result.reservationId).toBe('small');
      expect(queue.size('UCT')).toBe(1);

      // Clean up large
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);
      await largeProm.catch(() => {});
    });

    it('continues queue scan past entry that reaches MAX_SKIP_COUNT', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 50n }]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);

      enq({ id: 'large', request: { amount: '1000', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 1000n, enqueuedAt: Date.now() });
      enq({ id: 'small', request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      // Rounds 1..9: large can't plan (null), small served, skipCount goes 0->1, 1->2, ..., 8->9
      for (let round = 1; round <= MAX_SKIP_COUNT - 1; round++) {
        spy.mockReset();
        spy.mockReturnValueOnce(null); // large
        spy.mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT')); // small
        queue.notifyChange('UCT');
        ledger.clear();

        // Re-add small for next round (previous one was resolved and removed)
        if (round < MAX_SKIP_COUNT - 1) {
          enq({ id: `small-${round + 1}`, request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });
        }
      }

      // After 9 rounds, large skipCount = 9. Queue: [large] (last small was served in round 9).
      // Add two small entries.
      enq({ id: 'small-a', request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });
      enq({ id: 'small-b', request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });

      // Round 10: large skipCount 9 -> 10, can't plan. Queue continues to small-a and small-b.
      spy.mockReset();
      spy.mockReturnValueOnce(null); // large
      spy.mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT')); // small-a served
      spy.mockReturnValueOnce(null); // small-b can't plan (token reserved by small-a)

      queue.notifyChange('UCT');

      // Planner called for all 3 entries — queue does not halt on blocked entry
      expect(spy).toHaveBeenCalledTimes(3);
      // Queue: large + small-b (small-a was served)
      expect(queue.size('UCT')).toBe(2);
    });

    it('after head entry is served, later entries can proceed normally', async () => {
      const pool = buildPool([
        { id: 'tok-1', coinId: 'UCT', amount: 1000n },
        { id: 'tok-2', coinId: 'UCT', amount: 100n },
      ]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);
      parsedTokenCache.set('tok-2', pool.get('tok-2')!);

      const largeProm = enq({ id: 'large', request: { amount: '1000', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 1000n, enqueuedAt: Date.now() });
      enq({ id: 'small', request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      // First notify: large can plan with tok-1, small can plan with tok-2
      spy.mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT'))
         .mockReturnValueOnce(directPlan(pool.get('tok-2')!, 'UCT'));

      queue.notifyChange('UCT');

      await largeProm;
      expect(queue.size('UCT')).toBe(0); // both served
    });

    it('skipCount increments each time head is skipped, allowing later entries through', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 50n }]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);

      enq({ id: 'large', request: { amount: '1000', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 1000n, enqueuedAt: Date.now() });
      enq({ id: 'small', request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      // Round 1: large null, small planned -> small served, large skipCount = 1
      spy.mockReturnValueOnce(null).mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT'));
      queue.notifyChange('UCT');
      ledger.clear();
      // After round 1: queue = [large], skipCount = 1

      // Add small-2
      enq({ id: 'small-2', request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });

      // Round 2: large null, small-2 planned -> small-2 served, large skipCount = 2
      spy.mockReturnValueOnce(null).mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT'));
      queue.notifyChange('UCT');
      ledger.clear();
      // After round 2: queue = [large], skipCount = 2

      // Add small-3
      enq({ id: 'small-3', request: { amount: '50', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 50n, enqueuedAt: Date.now() });

      // Round 3: large null (skipCount 2->3, still < 10), small-3 planned
      // Reset the spy call count to isolate round 3
      spy.mockClear();
      spy.mockReturnValueOnce(null).mockReturnValueOnce(directPlan(pool.get('tok-1')!, 'UCT'));
      queue.notifyChange('UCT');

      // Planner was called twice in round 3 (large failed, small-3 succeeded)
      // This confirms skipCount < MAX_SKIP_COUNT, so queue scan continues past large
      expect(spy).toHaveBeenCalledTimes(2);
      expect(queue.size('UCT')).toBe(1); // only large remains
    });
  });

  // =========================================================================
  // Multiple coinIds - isolation
  // =========================================================================

  describe('multiple coinIds isolation', () => {
    it('notifyChange for UCT does not trigger planning for USDC entries', () => {
      const uctPool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const usdcPool = buildPool([{ id: 'tok-2', coinId: 'USDC', amount: 100n }]);
      parsedTokenCache.set('tok-1', uctPool.get('tok-1')!);

      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      enq({ id: nextId(), request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValue(
        directPlan(uctPool.get('tok-1')!, 'UCT'),
      );

      queue.notifyChange('UCT');

      expect(queue.size('UCT')).toBe(0);
      expect(queue.size('USDC')).toBe(1);
    });

    it('entries for different coinIds can be resolved independently', async () => {
      const tok1 = makeToken({ id: 'tok-1', coinId: 'UCT', amount: '500' });
      const tok2 = makeToken({ id: 'tok-2', coinId: 'USDC', amount: '500' });
      const e1 = makeParsedEntry(tok1, 500n);
      const e2 = makeParsedEntry(tok2, 500n);
      parsedTokenCache.set('tok-1', e1);
      parsedTokenCache.set('tok-2', e2);

      const uctPool = new Map<string, ParsedTokenEntry>([['tok-1', e1]]);
      const usdcPool = new Map<string, ParsedTokenEntry>([['tok-2', e2]]);

      const p1 = enq({ id: 'uct-1', request: { amount: '500', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 500n, enqueuedAt: Date.now() });
      const p2 = enq({ id: 'usdc-1', request: { amount: '500', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 500n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      // Resolve USDC first
      spy.mockReturnValueOnce(directPlan(e2, 'USDC'));
      queue.notifyChange('USDC');
      const r2 = await p2;
      expect(r2.reservationId).toBe('usdc-1');

      expect(queue.size('UCT')).toBe(1);

      // Now resolve UCT
      spy.mockReturnValueOnce(directPlan(e1, 'UCT'));
      queue.notifyChange('UCT');
      const r1 = await p1;
      expect(r1.reservationId).toBe('uct-1');

      expect(queue.size()).toBe(0);
    });

    it('timeout for one coinId does not affect another', async () => {
      const uctPool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      const usdcPool = buildPool([{ id: 'tok-2', coinId: 'USDC', amount: 100n }]);

      const uctPromise = enq({ id: 'uct-1', request: { amount: '100', coinId: 'UCT' }, parsedPool: uctPool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      vi.advanceTimersByTime(15_000);

      const usdcPromise = enq({ id: 'usdc-1', request: { amount: '100', coinId: 'USDC' }, parsedPool: usdcPool, coinId: 'USDC', amount: 100n, enqueuedAt: Date.now() });

      // UCT times out
      vi.advanceTimersByTime(16_000);
      await expect(uctPromise).rejects.toThrow('Send queue timeout');

      expect(queue.size('USDC')).toBe(1);
      expect(queue.size('UCT')).toBe(0);

      // Clean up
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS);
      await usdcPromise.catch(() => {});
    });

    it('notifyChange for unrelated coinId has no effect', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      queue.notifyChange('USDC');
      queue.notifyChange('USDT');
      queue.notifyChange('BTC');

      expect(spy).not.toHaveBeenCalled();
      expect(queue.size('UCT')).toBe(1);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('notifyChange with empty parsedTokenCache still uses entry parsedPool', async () => {
      const tok1 = makeToken({ id: 'tok-1', coinId: 'UCT', amount: '500' });
      const entry = makeParsedEntry(tok1, 500n);
      const pool = new Map<string, ParsedTokenEntry>([['tok-1', entry]]);
      // parsedTokenCache is empty

      const id = nextId();
      const promise = enq({
        id,
        request: { amount: '500', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 500n,
        enqueuedAt: Date.now(),
      });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        directPlan(entry, 'UCT'),
      );

      queue.notifyChange('UCT');

      const result = await promise;
      expect(result.reservationId).toBe(id);
    });

    it('multiple sequential notifyChange calls process remaining entries', async () => {
      // Two separate tokens so no reservation conflict
      const tok1 = makeToken({ id: 'tok-1', coinId: 'UCT', amount: '100' });
      const tok2 = makeToken({ id: 'tok-2', coinId: 'UCT', amount: '100' });
      const entry1 = makeParsedEntry(tok1, 100n);
      const entry2 = makeParsedEntry(tok2, 100n);
      parsedTokenCache.set('tok-1', entry1);
      parsedTokenCache.set('tok-2', entry2);
      const pool = new Map<string, ParsedTokenEntry>([['tok-1', entry1], ['tok-2', entry2]]);

      const p1 = enq({ id: 'e1', request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });
      const p2 = enq({ id: 'e2', request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync');

      // First notifyChange resolves first entry, second can't plan
      spy.mockReturnValueOnce(directPlan(entry1, 'UCT'));
      spy.mockReturnValueOnce(null);
      queue.notifyChange('UCT');

      const r1 = await p1;
      expect(r1.reservationId).toBe('e1');
      expect(queue.size('UCT')).toBe(1);

      // Second notifyChange resolves second entry
      spy.mockReturnValueOnce(directPlan(entry2, 'UCT'));
      queue.notifyChange('UCT');

      const r2 = await p2;
      expect(r2.reservationId).toBe('e2');
      expect(queue.size()).toBe(0);
    });

    it('enqueue with zero amount still enters queue', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);

      enq({
        id: nextId(),
        request: { amount: '0', coinId: 'UCT' },
        parsedPool: pool,
        coinId: 'UCT',
        amount: 0n,
        enqueuedAt: Date.now(),
      });

      expect(queue.size()).toBe(1);
    });

    it('destroy after cancelAll is safe', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      enq({ id: nextId(), request: { amount: '100', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 100n, enqueuedAt: Date.now() });

      queue.cancelAll('reason');
      expect(() => queue.destroy()).not.toThrow();
    });

    it('notifyChange called multiple times synchronously processes queue once per call', () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 100n }]);
      parsedTokenCache.set('tok-1', pool.get('tok-1')!);

      enq({ id: nextId(), request: { amount: '1000', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 1000n, enqueuedAt: Date.now() });

      const spy = vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValue(null);

      // Call 3 times synchronously -- each call processes independently
      queue.notifyChange('UCT');
      queue.notifyChange('UCT');
      queue.notifyChange('UCT');

      // Each call invokes planner once for the single entry
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('resolved entry promise not accessible via waitForEntry after resolution', async () => {
      const pool = buildPool([{ id: 'tok-1', coinId: 'UCT', amount: 500n }]);
      const entry = pool.get('tok-1')!;
      parsedTokenCache.set('tok-1', entry);
      const id = nextId();

      enq({ id, request: { amount: '500', coinId: 'UCT' }, parsedPool: pool, coinId: 'UCT', amount: 500n, enqueuedAt: Date.now() });

      vi.spyOn(planner, 'calculateOptimalSplitSync').mockReturnValueOnce(
        directPlan(entry, 'UCT'),
      );

      queue.notifyChange('UCT');

      // After resolution, the promise is deleted from internal map
      await expect(queue.waitForEntry(id)).rejects.toThrow('Queue entry not found');
    });
  });
});
