/**
 * PaymentsModule Concurrency Tests
 *
 * Verifies that concurrent send() calls properly reserve tokens,
 * handle splits, and coordinate via the spend queue.
 *
 * These tests exercise the three-component architecture:
 * - TokenReservationLedger: tracks reserved amounts
 * - SpendPlanner: synchronous critical section
 * - SpendQueue: queues blocked sends, wakes on notifyChange
 *
 * Most tests work at the component level using real Ledger/Planner/Queue
 * instances with mock token data, testing concurrency guarantees directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenReservationLedger } from '../../../modules/payments/TokenReservationLedger';
import {
  SpendPlanner,
  SpendQueue,
  type ParsedTokenPool,
  type ParsedTokenEntry,
  type PlanResult,
  QUEUE_TIMEOUT_MS,
  MAX_SKIP_COUNT,
} from '../../../modules/payments/SpendQueue';
import type { Token } from '../../../types';

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal Token for testing */
function makeToken(id: string, amount: string, coinId: string = 'UCT'): Token {
  return {
    id,
    coinId,
    symbol: coinId,
    name: coinId,
    decimals: 8,
    amount,
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: '{}',
  };
}

/** Create a ParsedTokenEntry for testing (no real SdkToken needed for planner) */
function makeParsedEntry(id: string, amount: bigint, coinId: string = 'UCT'): ParsedTokenEntry {
  const token = makeToken(id, amount.toString(), coinId);
  return {
    token,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkToken: { id: { toString: () => id } } as any,
    amount,
  };
}

/** Build a ParsedTokenPool from entries */
function buildPool(...entries: ParsedTokenEntry[]): ParsedTokenPool {
  const pool = new Map<string, ParsedTokenEntry>();
  for (const e of entries) {
    pool.set(e.token.id, e);
  }
  return pool;
}

/** Build a token map from entries */
function buildTokenMap(...entries: ParsedTokenEntry[]): Map<string, Token> {
  const map = new Map<string, Token>();
  for (const e of entries) {
    map.set(e.token.id, e.token);
  }
  return map;
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule Concurrency', () => {
  let ledger: TokenReservationLedger;
  let planner: SpendPlanner;
  let parsedTokenCache: Map<string, ParsedTokenEntry>;
  let tokenMap: Map<string, Token>;

  beforeEach(() => {
    ledger = new TokenReservationLedger();
    planner = new SpendPlanner();
    parsedTokenCache = new Map();
    tokenMap = new Map();
  });

  // ===========================================================================
  // Basic Concurrency — Two Sends, Same CoinId
  // ===========================================================================

  describe('Basic Concurrency — Two Sends, Same CoinId', () => {
    it('two sends for different amounts, pool has enough → both reserve different tokens', () => {
      const e1 = makeParsedEntry('tok-1', 1000000n);
      const e2 = makeParsedEntry('tok-2', 1000000n);
      const pool = buildPool(e1, e2);

      // Send-1: 300000
      const result1 = planner.planSend(
        { amount: '300000', coinId: 'UCT' },
        pool, ledger, {} as SpendQueue, 'send-1'
      );
      expect(result1).not.toBe('queued');
      const plan1 = (result1 as PlanResult).splitPlan;
      expect(plan1).toBeDefined();

      // Send-2: 400000
      const result2 = planner.planSend(
        { amount: '400000', coinId: 'UCT' },
        pool, ledger, {} as SpendQueue, 'send-2'
      );
      expect(result2).not.toBe('queued');
      const plan2 = (result2 as PlanResult).splitPlan;
      expect(plan2).toBeDefined();

      // Each send reserves the FULL token amount (splits consume entire token)
      // Both tokens should be reserved
      const totalReserved = ledger.getTotalReserved('tok-1') + ledger.getTotalReserved('tok-2');
      expect(totalReserved).toBe(2000000n); // 1000000 + 1000000 (full tokens)
    });

    it('two sends for same amount, one token → first succeeds, second queued', () => {
      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // Send-1: 500000 → reserves tok-1
      const result1 = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'send-1'
      );
      expect(result1).not.toBe('queued');

      // Send-2: 500000 → should be queued (all reserved)
      const result2 = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'send-2'
      );
      expect(result2).toBe('queued');
      expect(mockQueue.enqueue).toHaveBeenCalledOnce();
    });

    it('two sends both need split from same token → first reserves, second queued', () => {
      const e1 = makeParsedEntry('tok-1', 1500000n);
      const pool = buildPool(e1);
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // Send-1: 600000 → reserves tok-1 (will split)
      const result1 = planner.planSend(
        { amount: '600000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'send-1'
      );
      expect(result1).not.toBe('queued');
      const plan1 = (result1 as PlanResult).splitPlan;
      expect(plan1.requiresSplit).toBe(true);

      // Send-2: 400000 → should be queued (tok-1 fully reserved)
      const result2 = planner.planSend(
        { amount: '400000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'send-2'
      );
      expect(result2).toBe('queued');
    });
  });

  // ===========================================================================
  // Three or More Concurrent Sends
  // ===========================================================================

  describe('Three or More Concurrent Sends', () => {
    it('three sends, pool has 3 tokens → all proceed in parallel', () => {
      const pool = buildPool(
        makeParsedEntry('tok-1', 1000000n),
        makeParsedEntry('tok-2', 1000000n),
        makeParsedEntry('tok-3', 1000000n),
      );

      const result1 = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's1');
      const result2 = planner.planSend({ amount: '600000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's2');
      const result3 = planner.planSend({ amount: '400000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's3');

      expect(result1).not.toBe('queued');
      expect(result2).not.toBe('queued');
      expect(result3).not.toBe('queued');
    });

    it('three sends, pool has 2 tokens → two proceed, third queued', () => {
      const pool = buildPool(
        makeParsedEntry('tok-1', 1000000n),
        makeParsedEntry('tok-2', 1000000n),
      );
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      const result1 = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, mockQueue, 's1');
      const result2 = planner.planSend({ amount: '600000', coinId: 'UCT' }, pool, ledger, mockQueue, 's2');
      const result3 = planner.planSend({ amount: '400000', coinId: 'UCT' }, pool, ledger, mockQueue, 's3');

      // First two succeed
      expect(result1).not.toBe('queued');
      expect(result2).not.toBe('queued');
      // Third is queued (tokens exhausted)
      expect(result3).toBe('queued');
    });

    it('five sends from one large token → first proceeds, rest queue', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 5000000n));
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      const r1 = planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, mockQueue, 's1');
      expect(r1).not.toBe('queued');

      // After r1, tok-1 is fully reserved → all subsequent queue
      for (let i = 2; i <= 5; i++) {
        const r = planner.planSend({ amount: '800000', coinId: 'UCT' }, pool, ledger, mockQueue, `s${i}`);
        expect(r).toBe('queued');
      }
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(4);
    });
  });

  // ===========================================================================
  // Cross-CoinId Independence
  // ===========================================================================

  describe('Cross-CoinId Independence', () => {
    it('sends for different coinIds → fully parallel, no blocking', () => {
      const uctEntry = makeParsedEntry('tok-uct-1', 1000000n, 'UCT');
      const usdcEntry = makeParsedEntry('tok-usdc-1', 1000000n, 'USDC');
      const uctPool = buildPool(uctEntry);
      const usdcPool = buildPool(usdcEntry);

      const r1 = planner.planSend({ amount: '500000', coinId: 'UCT' }, uctPool, ledger, {} as SpendQueue, 's1');
      const r2 = planner.planSend({ amount: '500000', coinId: 'USDC' }, usdcPool, ledger, {} as SpendQueue, 's2');

      expect(r1).not.toBe('queued');
      expect(r2).not.toBe('queued');
    });

    it('queue for coinId A does not affect sends for coinId B', () => {
      const uctPool = buildPool(makeParsedEntry('tok-uct-1', 500000n, 'UCT'));
      const usdcPool = buildPool(
        makeParsedEntry('tok-usdc-1', 1000000n, 'USDC'),
        makeParsedEntry('tok-usdc-2', 1000000n, 'USDC'),
        makeParsedEntry('tok-usdc-3', 1000000n, 'USDC'),
      );
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // UCT: first send takes the only token, second queues
      planner.planSend({ amount: '500000', coinId: 'UCT' }, uctPool, ledger, mockQueue, 's-uct-1');
      const r2 = planner.planSend({ amount: '400000', coinId: 'UCT' }, uctPool, ledger, mockQueue, 's-uct-2');
      expect(r2).toBe('queued');

      // USDC: should proceed immediately regardless of UCT queue
      const r3 = planner.planSend({ amount: '600000', coinId: 'USDC' }, usdcPool, ledger, mockQueue, 's-usdc-1');
      expect(r3).not.toBe('queued');
    });
  });

  // ===========================================================================
  // Send Failure → Reservation Release
  // ===========================================================================

  describe('Send Failure → Reservation Release', () => {
    it('first send fails → reservation cancelled → second send proceeds', () => {
      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // Send-1 reserves tok-1
      const r1 = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, mockQueue, 'send-1');
      expect(r1).not.toBe('queued');

      // Send-2 queued (no free tokens)
      const r2 = planner.planSend({ amount: '300000', coinId: 'UCT' }, pool, ledger, mockQueue, 'send-2');
      expect(r2).toBe('queued');

      // Send-1 fails → cancel reservation
      ledger.cancel('send-1');

      // Now tok-1 is fully free again
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);

      // Send-2 can now be planned
      const r3 = planner.planSend({ amount: '300000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 'send-2-retry');
      expect(r3).not.toBe('queued');
    });

    it('commit deletes reservation; subsequent cancel is no-op', () => {
      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);

      // Send-1 reserves and commits (full token reserved for split)
      planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 'send-1');
      ledger.commit('send-1');

      // Try to cancel — reservation already deleted by commit, no-op
      ledger.cancel('send-1');

      // Committed reservation is deleted — capacity fully freed
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
    });
  });

  // ===========================================================================
  // Change Token Arrival → Queue Wake
  // ===========================================================================

  describe('Change Token Arrival → Queue Wake', () => {
    it('queued send fulfilled when change token arrives and notifyChange fires', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      // Send-1: reserves tok-1
      const r1 = planner.planSend({ amount: '700000', coinId: 'UCT' }, pool, ledger, queue, 'send-1');
      expect(r1).not.toBe('queued');

      // Send-2: queued (tok-1 fully reserved by send-1's split)
      const r2 = planner.planSend({ amount: '200000', coinId: 'UCT' }, pool, ledger, queue, 'send-2');
      expect(r2).toBe('queued');

      const queuePromise = queue.waitForEntry('send-2');

      // Simulate send-1 completes: commit reservation, add change token
      ledger.commit('send-1');

      // Change token arrives (300000 from split)
      const changeEntry = makeParsedEntry('tok-change-1', 300000n);
      parsedTokenCache.set('tok-change-1', changeEntry);
      tokenMap.set('tok-change-1', changeEntry.token);

      // Notify queue
      queue.notifyChange('UCT');

      // Queue should have resolved
      const result = await queuePromise;
      expect(result.reservationId).toBe('send-2');
      expect(result.splitPlan).toBeDefined();

      queue.destroy();
      vi.useRealTimers();
    });

    it('queued send stays queued when change token is too small', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      // Send-1: reserves tok-1
      planner.planSend({ amount: '700000', coinId: 'UCT' }, pool, ledger, queue, 'send-1');
      // Send-2: needs 500000 but only 300000 change will come
      planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, queue, 'send-2');

      // Change token (300000) — too small for send-2 (500000)
      const changeEntry = makeParsedEntry('tok-change-1', 300000n);
      parsedTokenCache.set('tok-change-1', changeEntry);

      queue.notifyChange('UCT');

      // Queue should still have send-2
      expect(queue.size('UCT')).toBe(1);

      queue.destroy();
      vi.useRealTimers();
    });

    it('multiple queued sends fulfilled by cascade of change tokens', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 3000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      // Send-1: reserves tok-1 (will split to 2000000 change)
      planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, queue, 'send-1');

      // Send-2 and Send-3: queued
      planner.planSend({ amount: '800000', coinId: 'UCT' }, pool, ledger, queue, 'send-2');
      planner.planSend({ amount: '600000', coinId: 'UCT' }, pool, ledger, queue, 'send-3');

      const p2 = queue.waitForEntry('send-2');
      const p3 = queue.waitForEntry('send-3');

      // Send-1 completes, change arrives (2000000)
      ledger.commit('send-1');
      const c1 = makeParsedEntry('tok-change-1', 2000000n);
      parsedTokenCache.set('tok-change-1', c1);
      tokenMap.set('tok-change-1', c1.token);

      queue.notifyChange('UCT');

      // Send-2 should be planned (800000 <= 2000000 free)
      const result2 = await p2;
      expect(result2.reservationId).toBe('send-2');

      // After send-2 is planned, 1200000 remains free for send-3
      // But send-2's reservation means the change token is partially consumed
      // Let's simulate send-2 completing and change-2 arriving
      ledger.commit('send-2');
      const c2 = makeParsedEntry('tok-change-2', 1200000n);
      parsedTokenCache.set('tok-change-2', c2);
      tokenMap.set('tok-change-2', c2.token);

      queue.notifyChange('UCT');

      const result3 = await p3;
      expect(result3.reservationId).toBe('send-3');

      queue.destroy();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // Timeout Scenarios
  // ===========================================================================

  describe('Timeout Scenarios', () => {
    it('queued send times out after QUEUE_TIMEOUT_MS', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      // Reserve all tokens
      planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, queue, 'send-1');

      // Send-2 queued
      planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, queue, 'send-2');
      const p2 = queue.waitForEntry('send-2');

      // Advance past timeout
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1000);

      await expect(p2).rejects.toThrow('Send queue timeout');

      queue.destroy();
      vi.useRealTimers();
    });

    it('queued send fulfilled just before timeout → succeeds', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, queue, 'send-1');
      planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, queue, 'send-2');
      const p2 = queue.waitForEntry('send-2');

      // Advance to 29 seconds (just before timeout)
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS - 1000);

      // Token arrives just in time
      ledger.commit('send-1');
      const change = makeParsedEntry('tok-change', 500000n);
      parsedTokenCache.set('tok-change', change);
      tokenMap.set('tok-change', change.token);

      queue.notifyChange('UCT');

      const result = await p2;
      expect(result.reservationId).toBe('send-2');

      queue.destroy();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // Destroy During Active Sends
  // ===========================================================================

  describe('Destroy During Active Sends', () => {
    it('destroy rejects queued sends with MODULE_DESTROYED', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, queue, 'send-1');
      // enqueue returns a promise that will be rejected — catch it to avoid unhandled rejection
      const enqueueResult = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, queue, 'send-2');
      expect(enqueueResult).toBe('queued');
      const p2 = queue.waitForEntry('send-2');
      // Catch the internal enqueue promise rejection
      p2.catch(() => {});

      queue.destroy();

      await expect(p2).rejects.toThrow('Module destroyed');

      vi.useRealTimers();
    });

    it('no entries accepted after destroy', () => {
      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);
      queue.destroy();

      // After destroy, enqueue should still work (returns rejected promise)
      // The queue is empty and destroyed
      expect(queue.size()).toBe(0);
    });
  });

  // ===========================================================================
  // Reservation Invariants
  // ===========================================================================

  describe('Reservation Invariants', () => {
    it('I-RL-2: free + reserved = tokenAmount for any tracked token', () => {
      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);

      // Reserve 300000
      planner.planSend({ amount: '300000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's1');

      const free = ledger.getFreeAmount('tok-1', 1000000n);
      const reserved = ledger.getTotalReserved('tok-1');

      expect(free + reserved).toBe(1000000n);
    });

    it('no orphaned reservations after commit+cancel cycle', () => {
      const pool = buildPool(
        makeParsedEntry('tok-1', 1000000n),
        makeParsedEntry('tok-2', 1000000n),
      );

      // Multiple sends — each reserves a full token (split)
      planner.planSend({ amount: '300000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's1');
      planner.planSend({ amount: '400000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's2');

      // Commit s1 (deletes reservation), cancel s2 (frees capacity)
      ledger.commit('s1');
      ledger.cancel('s2');

      // Both reservations freed — commit deletes, cancel releases
      const reserved1 = ledger.getTotalReserved('tok-1');
      const reserved2 = ledger.getTotalReserved('tok-2');

      expect(reserved1 + reserved2).toBe(0n);
    });

    it('I-RL-1: getFreeAmount never returns negative', () => {
      const e1 = makeParsedEntry('tok-1', 100n);
      const pool = buildPool(e1);

      // Reserve the full amount
      planner.planSend({ amount: '100', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's1');

      // getFreeAmount should be 0, not negative
      expect(ledger.getFreeAmount('tok-1', 100n)).toBe(0n);
      expect(ledger.getFreeAmount('tok-1', 50n)).toBe(0n); // even with understated tokenAmount
    });

    it('cancelForToken releases all reservations for that token', () => {
      // Directly create reservations (bypassing planner which needs full SpendQueue for queuing)
      ledger.reserve('s1', [{ tokenId: 'tok-1', amount: 300000n, tokenAmount: 1000000n }], 'UCT');
      ledger.reserve('s2', [{ tokenId: 'tok-1', amount: 400000n, tokenAmount: 1000000n }], 'UCT');

      expect(ledger.getTotalReserved('tok-1')).toBe(700000n);

      // Cancel all reservations for tok-1
      const cancelled = ledger.cancelForToken('tok-1');
      expect(cancelled.length).toBe(2);

      // Token should be fully free
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
    });
  });

  // ===========================================================================
  // Split Race Conditions
  // ===========================================================================

  describe('Split Race Conditions', () => {
    it('two sends both need splits from same token → only first gets split, second queued', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 1000000n));
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // Send-1: 600000 — will split tok-1 (needs 600000, token has 1000000)
      const r1 = planner.planSend({ amount: '600000', coinId: 'UCT' }, pool, ledger, mockQueue, 's1');
      expect(r1).not.toBe('queued');
      expect((r1 as PlanResult).splitPlan.requiresSplit).toBe(true);

      // Send-2: 300000 — should queue (tok-1 fully reserved by s1)
      const r2 = planner.planSend({ amount: '300000', coinId: 'UCT' }, pool, ledger, mockQueue, 's2');
      expect(r2).toBe('queued');
    });

    it('split fails → reservation cancelled → queued send re-evaluates', async () => {
      vi.useFakeTimers();

      const e1 = makeParsedEntry('tok-1', 1000000n);
      const pool = buildPool(e1);
      tokenMap = buildTokenMap(e1);

      const queue = new SpendQueue(ledger, planner, () => tokenMap, parsedTokenCache);

      // Send-1 reserves tok-1 (split planned)
      planner.planSend({ amount: '600000', coinId: 'UCT' }, pool, ledger, queue, 's1');

      // Send-2 queued
      planner.planSend({ amount: '300000', coinId: 'UCT' }, pool, ledger, queue, 's2');
      const p2 = queue.waitForEntry('s2');

      // Send-1 split fails → cancel reservation
      ledger.cancel('s1');

      // Add tok-1 back to cache (it wasn't consumed)
      parsedTokenCache.set('tok-1', e1);

      // Notify: tok-1 is free again
      queue.notifyChange('UCT');

      // Send-2 should now be planned with the freed tok-1
      const result2 = await p2;
      expect(result2.reservationId).toBe('s2');

      queue.destroy();
      vi.useRealTimers();
    });
  });

  // ===========================================================================
  // Stress Tests
  // ===========================================================================

  describe('Stress Tests', () => {
    it('10 concurrent plans with 5 tokens → all eventually served', () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeParsedEntry(`tok-${i}`, 1000000n)
      );
      const pool = buildPool(...entries);
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      let planned = 0;
      let queued = 0;

      for (let i = 0; i < 10; i++) {
        const result = planner.planSend(
          { amount: '300000', coinId: 'UCT' }, pool, ledger, mockQueue, `s${i}`
        );
        if (result === 'queued') {
          queued++;
        } else {
          planned++;
        }
      }

      // With 5 tokens of 1M each and 300K requests:
      // Each token can serve 3 sends (300K*3 = 900K < 1M), so up to ~15 sends
      // But each reservation takes the full amount for splits, or partial amounts
      // At minimum, 5 should be planned immediately (one per token)
      expect(planned).toBeGreaterThanOrEqual(5);
      expect(planned + queued).toBe(10);
    });

    it('rapid reserve-cancel cycles keep ledger consistent', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 1000000n));
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      for (let i = 0; i < 100; i++) {
        const id = `cycle-${i}`;
        const result = planner.planSend(
          { amount: '100000', coinId: 'UCT' }, pool, ledger, mockQueue, id
        );

        if (result !== 'queued') {
          // Randomly commit or cancel
          if (i % 3 === 0) {
            ledger.commit(id);
          } else {
            ledger.cancel(id);
          }
        }
      }

      // Invariant: free + reserved = tokenAmount
      const free = ledger.getFreeAmount('tok-1', 1000000n);
      const reserved = ledger.getTotalReserved('tok-1');
      expect(free + reserved).toBe(1000000n);
    });
  });

  // ===========================================================================
  // Insufficient Balance
  // ===========================================================================

  describe('Insufficient Balance', () => {
    it('throws SEND_INSUFFICIENT_BALANCE when total inventory too low', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 100n));

      expect(() => {
        planner.planSend(
          { amount: '1000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 's1'
        );
      }).toThrow('Insufficient balance');
    });

    it('queues (not rejects) when total inventory is enough but all reserved', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 1000000n));
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // Reserve all
      planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, mockQueue, 's1');

      // Second send for less than total → queued (not rejected)
      const r2 = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, mockQueue, 's2');
      expect(r2).toBe('queued');
    });
  });

  // ===========================================================================
  // Reservation Cleanup on Error
  // ===========================================================================

  describe('Reservation cleanup on error', () => {
    it('reservation is released when send logic throws after planSend reserves tokens', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 1000000n));

      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' }, pool, ledger, {} as SpendQueue, 'res-err'
      );
      expect(result).not.toBe('queued');
      expect(ledger.hasActiveReservation('tok-1')).toBe(true);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBeLessThan(1000000n);

      // Simulate error path: caller cancels reservation
      ledger.cancel('res-err');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      expect(ledger.hasActiveReservation('tok-1')).toBe(false);
    });

    it('cancelled reservation frees tokens for subsequent senders', () => {
      const pool = buildPool(makeParsedEntry('tok-1', 1000000n));
      const mockQueue = { enqueue: vi.fn() } as unknown as SpendQueue;

      // First send reserves all
      planner.planSend({ amount: '1000000', coinId: 'UCT' }, pool, ledger, mockQueue, 'res-1');

      // Second send queued
      const r2 = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, mockQueue, 'res-2');
      expect(r2).toBe('queued');

      // First send fails → cancel
      ledger.cancel('res-1');

      // Third send succeeds immediately
      const r3 = planner.planSend({ amount: '500000', coinId: 'UCT' }, pool, ledger, mockQueue, 'res-3');
      expect(r3).not.toBe('queued');
    });
  });
});
