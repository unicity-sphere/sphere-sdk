/**
 * SpendQueue.starvation.test.ts
 *
 * Deep dive into skip-ahead fairness guarantees of the SpendQueue class.
 * Tests that the queue never blocks on any single entry — entries behind
 * a blocked one are always scanned and served if tokens are available.
 *
 * Key constants under test:
 *   MAX_SKIP_COUNT = 10   — skipCount tracks how many times an entry was skipped
 *   QUEUE_TIMEOUT_MS = 30000 — entries expire after 30s
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SpendQueue,
  SpendPlanner,
  MAX_SKIP_COUNT,
  QUEUE_TIMEOUT_MS,
  type ParsedTokenPool,
  type ParsedTokenEntry,
  type PlanResult,
} from '../../../modules/payments/SpendQueue';
import { TokenReservationLedger } from '../../../modules/payments/TokenReservationLedger';
import type { Token } from '../../../types';
import type { SplitPlan, TokenWithAmount } from '../../../modules/payments/TokenSplitCalculator';

// =============================================================================
// Test helpers
// =============================================================================

let tokenCounter = 0;

/** Create a minimal mock Token with the given coinId and amount. */
function makeToken(coinId: string, amount: bigint, id?: string): Token {
  tokenCounter++;
  return {
    id: id ?? `tok-${tokenCounter}`,
    coinId,
    symbol: coinId,
    name: coinId,
    decimals: 8,
    amount: amount.toString(),
    status: 'confirmed' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: '{}',
  } as Token;
}

/** Create a stub SdkToken-like object (we only need it as an opaque reference). */
function makeSdkToken(): any {
  return { _stub: true };
}

/** Create a ParsedTokenEntry for the parsedTokenCache. */
function makeParsedEntry(token: Token, amount: bigint): ParsedTokenEntry {
  return { token, sdkToken: makeSdkToken(), amount };
}

/**
 * Build a ParsedTokenPool from an array of { token, amount } pairs.
 */
function buildPool(entries: Array<{ token: Token; amount: bigint }>): ParsedTokenPool {
  const pool: ParsedTokenPool = new Map();
  for (const e of entries) {
    pool.set(e.token.id, makeParsedEntry(e.token, e.amount));
  }
  return pool;
}

/**
 * Create a direct (no-split) SplitPlan for the given tokens summing to totalAmount.
 * The returned plan uses the token objects that the ledger will reference.
 */
function makeDirectPlan(
  tokens: Array<{ token: Token; amount: bigint }>,
  totalAmount: bigint,
): SplitPlan {
  const twaList: TokenWithAmount[] = tokens.map((t) => ({
    sdkToken: makeSdkToken(),
    amount: t.amount,
    uiToken: t.token,
  }));
  return {
    tokensToTransferDirectly: twaList,
    tokenToSplit: null,
    splitAmount: null,
    remainderAmount: null,
    totalTransferAmount: totalAmount,
    coinId: '',
    requiresSplit: false,
  };
}

/**
 * Attach a .catch() to a promise to prevent unhandled rejection warnings.
 * The error is still available via the returned promise.
 */
function catchUnhandled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

// =============================================================================
// Test suite
// =============================================================================

describe('SpendQueue Starvation Protection', () => {
  let ledger: TokenReservationLedger;
  let planner: SpendPlanner;
  let queue: SpendQueue;
  let tokenMap: Map<string, Token>;
  let parsedCache: Map<string, ParsedTokenEntry>;

  // We spy on calculateOptimalSplitSync to control when plans succeed/fail
  let calculateSpy: ReturnType<typeof vi.spyOn>;

  // Shared tokens used across tests — large enough pool to support various scenarios
  let smallToken: Token;
  let largeToken: Token;

  beforeEach(() => {
    vi.useFakeTimers();
    tokenCounter = 0;

    ledger = new TokenReservationLedger();
    planner = new SpendPlanner();
    tokenMap = new Map();
    parsedCache = new Map();

    queue = new SpendQueue(ledger, planner, () => tokenMap, parsedCache);

    // Create shared tokens
    smallToken = makeToken('UCT', 100_000n, 'small-tok');
    largeToken = makeToken('UCT', 1_000_000n, 'large-tok');

    // By default, spy on the planner so tests can control outcomes
    calculateSpy = vi.spyOn(planner, 'calculateOptimalSplitSync');
  });

  afterEach(() => {
    queue.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Helper: enqueue an entry directly
  // ---------------------------------------------------------------------------
  function enqueueEntry(
    id: string,
    coinId: string,
    amount: bigint,
    pool?: ParsedTokenPool,
  ): Promise<PlanResult> {
    const p = queue.enqueue({
      id,
      request: { amount: amount.toString(), coinId },
      parsedPool: pool ?? new Map(),
      coinId,
      amount,
      enqueuedAt: Date.now(),
    });
    // Always attach a catch handler so destroy() rejections don't go unhandled.
    // Tests that need to assert rejection can still use the returned promise.
    p.catch(() => {});
    return p;
  }

  // =========================================================================
  // 1. FIFO order respected when all requests are same size
  // =========================================================================
  describe('FIFO ordering', () => {
    it('serves same-size requests in enqueue order', async () => {
      const coinId = 'UCT';
      const amount = 100_000n;
      const tok = makeToken(coinId, amount, 'fifo-tok');
      const pool = buildPool([{ token: tok, amount }]);
      parsedCache.set(tok.id, makeParsedEntry(tok, amount));
      tokenMap.set(tok.id, tok);

      calculateSpy.mockRestore();

      const servedOrder: string[] = [];
      const promises: Promise<PlanResult>[] = [];

      for (let i = 1; i <= 5; i++) {
        const p = enqueueEntry(`req-${i}`, coinId, amount, pool);
        p.then(() => servedOrder.push(`req-${i}`)).catch(() => {});
        promises.push(p);
      }

      expect(queue.size(coinId)).toBe(5);

      // Serve one at a time: notify, then release reservation for next
      for (let i = 1; i <= 5; i++) {
        queue.notifyChange(coinId);
        ledger.cancel(`req-${i}`);
      }

      await vi.runAllTimersAsync();
      await Promise.allSettled(promises);

      expect(servedOrder).toEqual(['req-1', 'req-2', 'req-3', 'req-4', 'req-5']);
    });
  });

  // =========================================================================
  // 2. Skip-ahead activation
  // =========================================================================
  describe('Skip-ahead activation', () => {
    it('small request jumps large one when large cannot be served', async () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));
      tokenMap.set(smallToken.id, smallToken);

      const pool = buildPool([{ token: smallToken, amount: 100_000n }]);

      const largePromise = catchUnhandled(enqueueEntry('large-1', coinId, 1_000_000n, pool));
      const smallPromise = enqueueEntry('small-1', coinId, 100_000n, pool);

      // Real planner: pool only has 100k, so large fails, small succeeds
      calculateSpy.mockRestore();

      queue.notifyChange(coinId);

      const smallResult = await smallPromise;
      expect(smallResult.reservationId).toBe('small-1');
      // Large still queued
      expect(queue.size(coinId)).toBe(1);
    });

    it('increments skipCount on the large entry when it is skipped', () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));

      // large fails, small succeeds
      calculateSpy.mockImplementation((_candidates: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) return null;
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      catchUnhandled(enqueueEntry('large-1', coinId, 1_000_000n));
      enqueueEntry('small-1', coinId, 100_000n);

      queue.notifyChange(coinId);

      // small-1 served, large-1 still queued (skipCount incremented internally)
      expect(queue.size(coinId)).toBe(1);
    });

    it('does not skip-ahead when the first entry can be planned', async () => {
      const coinId = 'UCT';
      const tok = makeToken(coinId, 500_000n, 'big-tok');
      parsedCache.set(tok.id, makeParsedEntry(tok, 500_000n));
      tokenMap.set(tok.id, tok);

      calculateSpy.mockRestore();

      const pool = buildPool([{ token: tok, amount: 500_000n }]);

      const servedOrder: string[] = [];

      const p1 = enqueueEntry('first', coinId, 500_000n, pool);
      p1.then(() => servedOrder.push('first')).catch(() => {});
      const p2 = catchUnhandled(enqueueEntry('second', coinId, 100_000n, pool));
      p2.then(() => servedOrder.push('second')).catch(() => {});

      queue.notifyChange(coinId);

      await Promise.resolve();
      await Promise.resolve();
      expect(servedOrder[0]).toBe('first');
    });
  });

  // =========================================================================
  // 3. Starvation bound — MAX_SKIP_COUNT tracking (queue never blocks)
  // =========================================================================
  describe('Starvation bound', () => {
    it('continues past entry that reaches MAX_SKIP_COUNT to serve later entries', () => {
      const coinId = 'UCT';

      // All entries always fail to plan — this lets us count skip increments
      calculateSpy.mockReturnValue(null);

      catchUnhandled(enqueueEntry('large-1', coinId, 1_000_000n));
      catchUnhandled(enqueueEntry('small-1', coinId, 100_000n));
      catchUnhandled(enqueueEntry('small-2', coinId, 100_000n));

      // Fire notifyChange MAX_SKIP_COUNT times — large gets skipped each time
      // but small-1 and small-2 also can't be planned (null), so they just
      // get their own skipCounts incremented too.
      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
      }

      // All 3 still in queue since nothing can be planned.
      expect(queue.size(coinId)).toBe(3);

      // Now make small plannable but large still fails.
      // Use two different tokens so both smalls can be served independently.
      const smallToken2 = makeToken('UCT', 100_000n, 'small-tok-2');
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));
      parsedCache.set(smallToken2.id, makeParsedEntry(smallToken2, 100_000n));
      let smallCallCount = 0;
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) return null;
        smallCallCount++;
        if (smallCallCount === 1) return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
        return makeDirectPlan([{ token: smallToken2, amount: 100_000n }], 100_000n);
      });

      queue.notifyChange(coinId);

      // Queue continues past large-1 and serves both small-1 and small-2.
      // Only large-1 remains.
      expect(queue.size(coinId)).toBe(1);
    });

    it('large entry that reaches MAX_SKIP_COUNT is served when tokens become available', async () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));

      let largeCanPlan = false;
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) {
          if (!largeCanPlan) return null;
          return makeDirectPlan([{ token: largeToken, amount: 1_000_000n }], 1_000_000n);
        }
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      const largePromise = enqueueEntry('large-1', coinId, 1_000_000n);
      catchUnhandled(enqueueEntry('small-1', coinId, 100_000n));

      // Skip large MAX_SKIP_COUNT times
      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
        ledger.cancel('small-1');
      }

      // Allow large to be planned
      largeCanPlan = true;
      parsedCache.set(largeToken.id, makeParsedEntry(largeToken, 1_000_000n));

      queue.notifyChange(coinId);

      const result = await largePromise;
      expect(result.reservationId).toBe('large-1');
    });

    it('after blocking entry is served, remaining entries resume normal processing', async () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));

      let largeCanPlan = false;
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) {
          if (!largeCanPlan) return null;
          return makeDirectPlan([{ token: largeToken, amount: 1_000_000n }], 1_000_000n);
        }
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      const largePromise = enqueueEntry('large-1', coinId, 1_000_000n);
      // Use a dummy small that gets served during skip-ahead rounds
      catchUnhandled(enqueueEntry('small-dummy', coinId, 100_000n));

      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
        ledger.cancel('small-dummy');
      }

      // Enqueue another small that should be served after the blocker
      const smallPromise = enqueueEntry('small-after', coinId, 100_000n);

      // Serve the blocker
      largeCanPlan = true;
      parsedCache.set(largeToken.id, makeParsedEntry(largeToken, 1_000_000n));

      queue.notifyChange(coinId);

      const largeResult = await largePromise;
      expect(largeResult.reservationId).toBe('large-1');

      // Release large reservation, notify again for small
      ledger.cancel('large-1');
      queue.notifyChange(coinId);

      const smallResult = await smallPromise;
      expect(smallResult.reservationId).toBe('small-after');
    });
  });

  // =========================================================================
  // 4. Skip count increments correctly
  // =========================================================================
  describe('Skip count tracking', () => {
    it('skipCount increments by 1 per notifyChange when entry cannot be planned', () => {
      const coinId = 'UCT';
      calculateSpy.mockReturnValue(null);

      catchUnhandled(enqueueEntry('entry-1', coinId, 500_000n));

      for (let i = 0; i < 5; i++) {
        queue.notifyChange(coinId);
      }

      expect(queue.size(coinId)).toBe(1);
    });

    it('skipCount increments for all entries and entries behind a blocked one are served', async () => {
      const coinId = 'UCT';
      calculateSpy.mockReturnValue(null);

      catchUnhandled(enqueueEntry('blocker', coinId, 1_000_000n));
      catchUnhandled(enqueueEntry('behind', coinId, 100_000n));

      // Push both entries' skipCounts up — both get incremented each round
      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
      }

      // Both still queued since nothing could be planned
      expect(queue.size(coinId)).toBe(2);

      // Make 'behind' plannable — queue continues past blocker and serves it
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) return null;
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      queue.notifyChange(coinId);

      // behind was served, only blocker remains
      expect(queue.size(coinId)).toBe(1);
    });

    it('successfully planned entry is removed without affecting others', () => {
      const coinId = 'UCT';

      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 500_000n) return null;
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      catchUnhandled(enqueueEntry('fails', coinId, 500_000n));
      enqueueEntry('succeeds', coinId, 100_000n);

      queue.notifyChange(coinId);

      // 'succeeds' removed, 'fails' still queued
      expect(queue.size(coinId)).toBe(1);
    });
  });

  // =========================================================================
  // 5. Cross-coinId independence
  // =========================================================================
  describe('Cross-coinId independence', () => {
    it('entries for different coinIds do not affect each other skip counts', async () => {
      const tokB = makeToken('COIN_B', 100_000n, 'b-tok');
      parsedCache.set(tokB.id, makeParsedEntry(tokB, 100_000n));

      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) return null; // COIN_A large
        return makeDirectPlan([{ token: tokB, amount: 100_000n }], 100_000n);
      });

      catchUnhandled(enqueueEntry('a-large', 'COIN_A', 1_000_000n));
      const bPromise = enqueueEntry('b-small', 'COIN_B', 100_000n);

      // notifyChange for COIN_B should not touch COIN_A queue
      queue.notifyChange('COIN_B');

      const bResult = await bPromise;
      expect(bResult.reservationId).toBe('b-small');
      expect(queue.size('COIN_A')).toBe(1);
      expect(queue.size('COIN_B')).toBe(0);
    });

    it('notifyChange for one coinId does not scan other coinId queues', () => {
      calculateSpy.mockReturnValue(null);

      catchUnhandled(enqueueEntry('a-1', 'COIN_A', 500_000n));
      catchUnhandled(enqueueEntry('b-1', 'COIN_B', 500_000n));

      queue.notifyChange('COIN_A');

      expect(queue.size('COIN_B')).toBe(1);
      expect(queue.size('COIN_A')).toBe(1);
    });

    it('starvation blocking in one coinId does not block other coinIds', async () => {
      const tokB = makeToken('COIN_B', 100_000n, 'b-tok-2');
      parsedCache.set(tokB.id, makeParsedEntry(tokB, 100_000n));

      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) return null;
        return makeDirectPlan([{ token: tokB, amount: 100_000n }], 100_000n);
      });

      catchUnhandled(enqueueEntry('a-blocker', 'COIN_A', 1_000_000n));
      const bPromise = enqueueEntry('b-ok', 'COIN_B', 100_000n);

      // Skip COIN_A blocker past MAX_SKIP_COUNT
      for (let i = 0; i < MAX_SKIP_COUNT + 1; i++) {
        queue.notifyChange('COIN_A');
      }

      // COIN_B should still be servable
      queue.notifyChange('COIN_B');

      const bResult = await bPromise;
      expect(bResult.reservationId).toBe('b-ok');
    });
  });

  // =========================================================================
  // 6. Edge: skipCount reaches limit on same pass as another entry served
  // =========================================================================
  describe('Edge cases', () => {
    it('when blocker reaches MAX_SKIP_COUNT, entries behind it are still served on that pass', () => {
      const coinId = 'UCT';
      const tinyTok = makeToken(coinId, 50_000n, 'tiny-tok');
      parsedCache.set(tinyTok.id, makeParsedEntry(tinyTok, 50_000n));

      // large and small fail, tiny succeeds
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 50_000n) {
          return makeDirectPlan([{ token: tinyTok, amount: 50_000n }], 50_000n);
        }
        return null;
      });

      catchUnhandled(enqueueEntry('large', coinId, 1_000_000n));
      catchUnhandled(enqueueEntry('small', coinId, 500_000n));
      catchUnhandled(enqueueEntry('tiny', coinId, 50_000n));

      // Push large to MAX_SKIP_COUNT - 1 = 9
      // During each round, large is skipped, small is skipped, tiny is served
      for (let i = 0; i < MAX_SKIP_COUNT - 1; i++) {
        queue.notifyChange(coinId);
        // Release tiny reservation so it can be re-served next round
        ledger.cancel('tiny');
      }

      // tiny gets served and removed on the first notify. So after round 1:
      // queue = [large(skip=1), small(skip=1)]
      // Subsequent rounds: both fail, both get skip incremented.
      // After 9 rounds: large(skip=9), small(skip=9)

      // Re-add tiny
      catchUnhandled(enqueueEntry('tiny-2', coinId, 50_000n));

      // This notify: large can't plan (skip=10), small can't plan (skip=10),
      // tiny-2 is served. Queue continues past blocked entries.
      queue.notifyChange(coinId);

      // tiny-2 served, large and small remain (both unplannable)
      expect(queue.size(coinId)).toBe(2);
    });

    it('entry at MAX_SKIP_COUNT - 1 gets served on that pass if tokens arrive', async () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));

      let largeCanPlan = false;
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) {
          if (!largeCanPlan) return null;
          return makeDirectPlan([{ token: largeToken, amount: 1_000_000n }], 1_000_000n);
        }
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      const largePromise = enqueueEntry('large', coinId, 1_000_000n);
      catchUnhandled(enqueueEntry('small', coinId, 100_000n));

      // Push large to MAX_SKIP_COUNT - 1
      for (let i = 0; i < MAX_SKIP_COUNT - 1; i++) {
        queue.notifyChange(coinId);
        ledger.cancel('small');
      }

      // Allow large to plan before it hits MAX
      largeCanPlan = true;
      parsedCache.set(largeToken.id, makeParsedEntry(largeToken, 1_000_000n));

      queue.notifyChange(coinId);

      const result = await largePromise;
      expect(result.reservationId).toBe('large');
    });
  });

  // =========================================================================
  // 7. Concurrent notifyChange calls
  // =========================================================================
  describe('Concurrent notifyChange', () => {
    it('multiple synchronous notifyChange calls increment skipCount independently', () => {
      const coinId = 'UCT';
      calculateSpy.mockReturnValue(null);

      catchUnhandled(enqueueEntry('entry-1', coinId, 500_000n));

      // Fire 3 synchronous notifyChange calls — each is fully sync
      queue.notifyChange(coinId);
      queue.notifyChange(coinId);
      queue.notifyChange(coinId);

      // Entry still queued — not at MAX yet (3 < 10)
      expect(queue.size(coinId)).toBe(1);
    });

    it('notifyChange correctly handles entry resolved in earlier call', async () => {
      const coinId = 'UCT';
      const tok = makeToken(coinId, 500_000n, 'reentrant-tok');
      parsedCache.set(tok.id, makeParsedEntry(tok, 500_000n));

      let callCount = 0;
      calculateSpy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return null;
        return makeDirectPlan([{ token: tok, amount: 500_000n }], 500_000n);
      });

      const promise = enqueueEntry('entry-1', coinId, 500_000n);

      // First notify: fails
      queue.notifyChange(coinId);
      expect(queue.size(coinId)).toBe(1);

      // Second notify: succeeds
      queue.notifyChange(coinId);

      const result = await promise;
      expect(result.reservationId).toBe('entry-1');
      expect(queue.size(coinId)).toBe(0);
    });

    it('three notifyChange calls with nothing plannable leave entries queued; MAX_SKIP_COUNT blocks', () => {
      const coinId = 'UCT';
      calculateSpy.mockReturnValue(null);

      catchUnhandled(enqueueEntry('e1', coinId, 500_000n));
      catchUnhandled(enqueueEntry('e2', coinId, 500_000n));

      queue.notifyChange(coinId);
      queue.notifyChange(coinId);
      queue.notifyChange(coinId);

      // Both still queued, not at MAX (3 < 10)
      expect(queue.size(coinId)).toBe(2);

      // 7 more should push e1 to MAX_SKIP_COUNT
      for (let i = 0; i < 7; i++) {
        queue.notifyChange(coinId);
      }

      // e1 is now at 10 (blocks). e2 also at 10 but behind e1.
      // One more notify: e1 still can't be planned, scan breaks immediately.
      queue.notifyChange(coinId);

      // Both still queued — blocked at head
      expect(queue.size(coinId)).toBe(2);
    });
  });

  // =========================================================================
  // 8. Pathological: impossible request times out without starving others
  // =========================================================================
  describe('Pathological cases', () => {
    it('impossible request times out at 30s without permanently blocking others', async () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));

      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 1_000_000n) return null; // impossible
        return makeDirectPlan([{ token: smallToken, amount: targetAmount }], targetAmount);
      });

      const impossiblePromise = catchUnhandled(enqueueEntry('impossible', coinId, 1_000_000n));

      // Serve some possible entries while impossible accumulates skips
      for (let i = 0; i < MAX_SKIP_COUNT - 1; i++) {
        const p = enqueueEntry(`possible-${i}`, coinId, 100_000n);
        queue.notifyChange(coinId);
        await p; // each is served immediately via skip-ahead
        ledger.cancel(`possible-${i}`);
      }

      // impossible now at skipCount = 9. One more notify pushes it to 10.
      // Queue continues past impossible and serves possible-last.
      const possibleLastPromise = enqueueEntry('possible-last', coinId, 100_000n);
      queue.notifyChange(coinId);

      // possible-last served immediately (queue scans past impossible)
      await possibleLastPromise;
      expect(queue.size(coinId)).toBe(1); // only impossible remains

      // Advance past timeout
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);

      // notifyChange expires the impossible entry
      queue.notifyChange(coinId);

      await expect(impossiblePromise).rejects.toThrow('Send queue timeout');
      expect(queue.size(coinId)).toBe(0);
    });

    it('many small sends competing for same token are served in FIFO order', async () => {
      const coinId = 'UCT';
      const tok = makeToken(coinId, 100_000n, 'shared-tok');
      const pool = buildPool([{ token: tok, amount: 100_000n }]);
      parsedCache.set(tok.id, makeParsedEntry(tok, 100_000n));
      tokenMap.set(tok.id, tok);

      calculateSpy.mockRestore();

      const servedOrder: string[] = [];
      const promises: Promise<PlanResult>[] = [];

      for (let i = 0; i < 10; i++) {
        const p = enqueueEntry(`s-${i}`, coinId, 100_000n, pool);
        p.then(() => servedOrder.push(`s-${i}`)).catch(() => {});
        promises.push(p);
      }

      // Serve one at a time
      for (let i = 0; i < 10; i++) {
        queue.notifyChange(coinId);
        ledger.cancel(`s-${i}`);
      }

      // Let all .then() callbacks settle
      await Promise.allSettled(promises);

      expect(servedOrder).toEqual(
        Array.from({ length: 10 }, (_, i) => `s-${i}`),
      );
    });

    it('one large send among many smalls is served within MAX_SKIP_COUNT rounds', async () => {
      const coinId = 'UCT';

      // Create unique tokens for each small entry to avoid INSUFFICIENT_FREE_AMOUNT
      const smallTokens: Token[] = [];
      for (let i = 0; i < 5; i++) {
        const t = makeToken(coinId, 50_000n, `small-tok-${i}`);
        smallTokens.push(t);
        parsedCache.set(t.id, makeParsedEntry(t, 50_000n));
      }

      let allowLarge = false;
      let smallIdx = 0;
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount >= 1_000_000n) {
          if (!allowLarge) return null;
          return makeDirectPlan([{ token: largeToken, amount: 1_000_000n }], 1_000_000n);
        }
        // Use the corresponding small token for each small entry
        const tok = smallTokens[smallIdx % smallTokens.length];
        smallIdx++;
        return makeDirectPlan([{ token: tok, amount: 50_000n }], 50_000n);
      });

      const largePromise = enqueueEntry('large', coinId, 1_000_000n);

      for (let i = 0; i < 5; i++) {
        catchUnhandled(enqueueEntry(`small-${i}`, coinId, 50_000n));
      }

      // Skip large up to MAX_SKIP_COUNT
      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
        // Release all small reservations
        for (let j = 0; j < 5; j++) {
          ledger.cancel(`small-${j}`);
        }
      }

      // After MAX_SKIP_COUNT rounds, large blocks the queue.
      allowLarge = true;
      parsedCache.set(largeToken.id, makeParsedEntry(largeToken, 1_000_000n));

      queue.notifyChange(coinId);

      const result = await largePromise;
      expect(result.reservationId).toBe('large');
    });
  });

  // =========================================================================
  // 9. Timeout interaction with starvation
  // =========================================================================
  describe('Timeout interaction', () => {
    it('entries behind a blocked head are served immediately without waiting for timeout', async () => {
      const coinId = 'UCT';
      parsedCache.set(smallToken.id, makeParsedEntry(smallToken, 100_000n));

      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 999_999n) return null;
        return makeDirectPlan([{ token: smallToken, amount: 100_000n }], 100_000n);
      });

      const headPromise = catchUnhandled(enqueueEntry('head', coinId, 999_999n));

      // Push head to MAX_SKIP_COUNT so its skipCount is high
      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
      }

      // Advance time partially so "behind" is enqueued at a later time
      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS / 2);

      const behindPromise = enqueueEntry('behind', coinId, 100_000n);

      // Queue continues past head and serves behind immediately
      queue.notifyChange(coinId);
      const behindResult = await behindPromise;
      expect(behindResult.reservationId).toBe('behind');
      expect(queue.size(coinId)).toBe(1); // only head remains

      // Advance past head's timeout
      vi.advanceTimersByTime((QUEUE_TIMEOUT_MS / 2) + 1);

      // notifyChange expires the head entry
      queue.notifyChange(coinId);

      await expect(headPromise).rejects.toThrow('Send queue timeout');
      expect(queue.size(coinId)).toBe(0);
    });

    it('entry that times out while blocked at MAX_SKIP_COUNT is properly cleaned up', async () => {
      const coinId = 'UCT';
      calculateSpy.mockReturnValue(null);

      const p = catchUnhandled(enqueueEntry('doomed', coinId, 1_000_000n));

      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
      }

      expect(queue.size(coinId)).toBe(1);

      vi.advanceTimersByTime(QUEUE_TIMEOUT_MS + 1);

      queue.notifyChange(coinId);

      await expect(p).rejects.toThrow('Send queue timeout');
      expect(queue.size(coinId)).toBe(0);
    });
  });

  // =========================================================================
  // 10. Merged pool in notifyChange picks up new tokens from cache
  // =========================================================================
  describe('Merged pool behavior', () => {
    it('notifyChange merges parsedTokenCache into entry pool for planning', async () => {
      const coinId = 'UCT';
      calculateSpy.mockRestore();

      const emptyPool: ParsedTokenPool = new Map();
      const promise = enqueueEntry('entry-1', coinId, 100_000n, emptyPool);

      // First notify — no tokens available
      queue.notifyChange(coinId);
      expect(queue.size(coinId)).toBe(1);

      // Add token to cache and live token map (simulating change token arrival)
      const newTok = makeToken(coinId, 100_000n, 'new-arrival');
      parsedCache.set(newTok.id, makeParsedEntry(newTok, 100_000n));
      tokenMap.set(newTok.id, newTok);

      queue.notifyChange(coinId);

      const result = await promise;
      expect(result.reservationId).toBe('entry-1');
      expect(queue.size(coinId)).toBe(0);
    });
  });

  // =========================================================================
  // 11. cancelAll resets everything
  // =========================================================================
  describe('cancelAll clears starvation state', () => {
    it('cancelAll rejects all entries including those at MAX_SKIP_COUNT', async () => {
      const coinId = 'UCT';
      calculateSpy.mockReturnValue(null);

      const p1 = catchUnhandled(enqueueEntry('e1', coinId, 500_000n));
      const p2 = catchUnhandled(enqueueEntry('e2', coinId, 100_000n));

      for (let i = 0; i < MAX_SKIP_COUNT; i++) {
        queue.notifyChange(coinId);
      }

      queue.cancelAll('test reset');

      await expect(p1).rejects.toThrow('test reset');
      await expect(p2).rejects.toThrow('test reset');
      expect(queue.size()).toBe(0);
    });
  });

  // =========================================================================
  // 12. Skip-count reset after head served
  // =========================================================================
  describe('Skip count reset after head is served', () => {
    it('entries behind a served entry continue with their own skipCounts unchanged', async () => {
      const coinId = 'UCT';

      // Round 1: first entry fails, second entry fails
      // Round 2: first entry succeeds, second entry fails
      // Round 3: second entry succeeds
      let round = 0;
      calculateSpy.mockImplementation((_c: any, targetAmount: bigint) => {
        if (targetAmount === 200_000n) {
          if (round >= 2) return makeDirectPlan([{ token: smallToken, amount: 200_000n }], 200_000n);
          return null;
        }
        if (targetAmount === 300_000n) {
          if (round >= 3) return makeDirectPlan([{ token: largeToken, amount: 300_000n }], 300_000n);
          return null;
        }
        return null;
      });

      const p1 = enqueueEntry('first', coinId, 200_000n);
      const p2 = enqueueEntry('second', coinId, 300_000n);

      round = 1;
      queue.notifyChange(coinId); // both fail, skipCount = 1

      round = 2;
      queue.notifyChange(coinId); // first succeeds and is removed

      const r1 = await p1;
      expect(r1.reservationId).toBe('first');

      round = 3;
      ledger.cancel('first');
      queue.notifyChange(coinId); // second now succeeds

      const r2 = await p2;
      expect(r2.reservationId).toBe('second');
      expect(queue.size(coinId)).toBe(0);
    });
  });
});
