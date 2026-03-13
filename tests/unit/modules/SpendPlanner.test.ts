/**
 * SpendPlanner test suite
 *
 * Covers:
 * - Immediate planning (Case A): plan found, reservation created
 * - Queued planning (Case B): tokens exist but all reserved
 * - Rejected planning (Case C): total inventory insufficient
 * - calculateOptimalSplitSync: exact match, combination, greedy+split, insufficient
 * - Free amount reads from ledger during planning
 * - Queue enqueue for Case B
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpendPlanner, type ParsedTokenPool, type ParsedTokenEntry, type PlanResult } from '../../../modules/payments/SpendQueue';
import { TokenReservationLedger } from '../../../modules/payments/TokenReservationLedger';
import { SphereError } from '../../../core/errors';
import type { Token } from '../../../types';
import type { SplitPlan } from '../../../modules/payments/TokenSplitCalculator';

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal Token mock with the required fields. */
function makeToken(id: string, coinId: string, amount: string, status: Token['status'] = 'confirmed'): Token {
  return {
    id,
    coinId,
    symbol: 'UCT',
    name: 'Test Token',
    decimals: 8,
    amount,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Create a ParsedTokenEntry with a stub sdkToken. */
function makeEntry(id: string, coinId: string, amount: bigint): ParsedTokenEntry {
  return {
    token: makeToken(id, coinId, amount.toString()),
    sdkToken: {} as any,
    amount,
  };
}

/** Build a ParsedTokenPool from an array of [id, coinId, amount] tuples. */
function buildPool(...entries: Array<[string, string, bigint]>): ParsedTokenPool {
  const pool: ParsedTokenPool = new Map();
  for (const [id, coinId, amount] of entries) {
    pool.set(id, makeEntry(id, coinId, amount));
  }
  return pool;
}

/** Build a candidate array for calculateOptimalSplitSync. */
function buildCandidates(...entries: Array<[string, bigint]>) {
  return entries.map(([id, amount]) => ({
    token: makeToken(id, 'UCT', amount.toString()),
    sdkToken: {} as any,
    amount,
  }));
}

/** Create a mock SpendQueue with an enqueue spy. */
function makeMockQueue() {
  return {
    enqueue: vi.fn(),
  } as any;
}

// =============================================================================
// Tests
// =============================================================================

describe('SpendPlanner', () => {
  let planner: SpendPlanner;
  let ledger: TokenReservationLedger;
  let mockQueue: ReturnType<typeof makeMockQueue>;

  beforeEach(() => {
    planner = new SpendPlanner();
    ledger = new TokenReservationLedger();
    mockQueue = makeMockQueue();
  });

  // ===========================================================================
  // calculateOptimalSplitSync
  // ===========================================================================

  describe('calculateOptimalSplitSync', () => {
    it('returns null for empty candidates', () => {
      const result = planner.calculateOptimalSplitSync([], 100n);
      expect(result).toBeNull();
    });

    it('returns null when total available is less than target', () => {
      const candidates = buildCandidates(['tok-1', 300n], ['tok-2', 200n]);
      const result = planner.calculateOptimalSplitSync(candidates, 600n);
      expect(result).toBeNull();
    });

    it('finds exact match with a single token', () => {
      const candidates = buildCandidates(['tok-1', 500n], ['tok-2', 1000n]);
      const result = planner.calculateOptimalSplitSync(candidates, 1000n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(1000n);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(1000n);
      expect(result!.tokenToSplit).toBeNull();
    });

    it('finds exact match when target equals smallest token', () => {
      const candidates = buildCandidates(['tok-1', 100n], ['tok-2', 500n]);
      const result = planner.calculateOptimalSplitSync(candidates, 100n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(100n);
    });

    it('finds exact two-token combination', () => {
      const candidates = buildCandidates(['tok-1', 300n], ['tok-2', 700n]);
      const result = planner.calculateOptimalSplitSync(candidates, 1000n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(1000n);
      expect(result!.tokensToTransferDirectly).toHaveLength(2);
    });

    it('finds exact three-token combination', () => {
      const candidates = buildCandidates(
        ['tok-1', 100n],
        ['tok-2', 200n],
        ['tok-3', 300n],
        ['tok-4', 900n],
      );
      // 100 + 200 + 300 = 600
      const result = planner.calculateOptimalSplitSync(candidates, 600n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(600n);
    });

    it('uses greedy + split when no exact match exists', () => {
      const candidates = buildCandidates(['tok-1', 300n], ['tok-2', 500n]);
      // Target 400: greedy picks tok-1(300), then needs 100 from tok-2(500) => split
      const result = planner.calculateOptimalSplitSync(candidates, 400n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.totalTransferAmount).toBe(400n);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(300n);
      expect(result!.tokenToSplit).not.toBeNull();
      expect(result!.splitAmount).toBe(100n);
      expect(result!.remainderAmount).toBe(400n); // 500 - 100
    });

    it('splits a single token when target is less than smallest', () => {
      const candidates = buildCandidates(['tok-1', 1000n]);
      const result = planner.calculateOptimalSplitSync(candidates, 100n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokensToTransferDirectly).toHaveLength(0);
      expect(result!.tokenToSplit).not.toBeNull();
      expect(result!.splitAmount).toBe(100n);
      expect(result!.remainderAmount).toBe(900n);
    });

    it('handles target equal to total available (all tokens, no split)', () => {
      const candidates = buildCandidates(['tok-1', 300n], ['tok-2', 700n]);
      const result = planner.calculateOptimalSplitSync(candidates, 1000n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(1000n);
    });

    it('prefers exact match over combination', () => {
      // tok-1(500) + tok-2(500) = 1000, but tok-3(1000) is an exact match
      const candidates = buildCandidates(['tok-1', 500n], ['tok-2', 500n], ['tok-3', 1000n]);
      const result = planner.calculateOptimalSplitSync(candidates, 1000n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      // Exact match should use a single token
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(1000n);
    });

    it('sorts candidates ascending by amount', () => {
      // Provide in descending order; internal sort should handle
      const candidates = buildCandidates(['tok-big', 900n], ['tok-small', 100n]);
      const result = planner.calculateOptimalSplitSync(candidates, 150n);

      // Greedy ascending: picks 100 first, then needs 50 from 900 => split
      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
      expect(result!.tokensToTransferDirectly[0].amount).toBe(100n);
      expect(result!.splitAmount).toBe(50n);
    });

    it('handles a single candidate that exactly matches', () => {
      const candidates = buildCandidates(['tok-1', 500n]);
      const result = planner.calculateOptimalSplitSync(candidates, 500n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
    });

    it('combination search limited to 5 tokens', () => {
      // 6 tokens each worth 100; target = 600 requires all 6 (combination of 6).
      // Combination search max is 5, so it falls through to greedy which
      // accumulates all 6 (exact sum in greedy loop).
      const candidates = buildCandidates(
        ['t1', 100n], ['t2', 100n], ['t3', 100n],
        ['t4', 100n], ['t5', 100n], ['t6', 100n],
      );
      const result = planner.calculateOptimalSplitSync(candidates, 600n);

      expect(result).not.toBeNull();
      expect(result!.totalTransferAmount).toBe(600n);
      // Greedy picks them all and hits exact sum
      expect(result!.requiresSplit).toBe(false);
    });

    it('greedy accumulates multiple tokens before splitting remainder', () => {
      const candidates = buildCandidates(
        ['tok-1', 100n],
        ['tok-2', 200n],
        ['tok-3', 500n],
      );
      // Target 450: greedy picks 100, 200 (=300), then needs 150 from 500 => split
      const result = planner.calculateOptimalSplitSync(candidates, 450n);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokensToTransferDirectly).toHaveLength(2);
      expect(result!.splitAmount).toBe(150n);
      expect(result!.remainderAmount).toBe(350n);
    });
  });

  // ===========================================================================
  // planSend — Immediate Planning (Case A)
  // ===========================================================================

  describe('planSend — immediate planning (Case A)', () => {
    it('returns PlanResult when single token covers the amount', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      );

      expect(result).not.toBe('queued');
      const plan = result as PlanResult;
      expect(plan.reservationId).toBe('res-1');
      expect(plan.splitPlan).toBeDefined();
      expect(plan.splitPlan.coinId).toBe('UCT');
    });

    it('creates a reservation in the ledger', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      );

      const reservation = ledger.getReservation('res-1');
      expect(reservation).toBeDefined();
      expect(reservation!.status).toBe('active');
      expect(reservation!.coinId).toBe('UCT');
    });

    it('reserves the correct amount for an exact match', () => {
      const pool = buildPool(['tok-1', 'UCT', 500_000n]);
      planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      );

      // Full token reserved
      expect(ledger.getTotalReserved('tok-1')).toBe(500_000n);
      expect(ledger.getFreeAmount('tok-1', 500_000n)).toBe(0n);
    });

    it('reserves full token amount when split is needed (entire token consumed)', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      const result = planner.planSend(
        { amount: '600000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      // Split: 600000 from tok-1 (token amount 1000000)
      expect(result.splitPlan.requiresSplit).toBe(true);
      expect(result.splitPlan.splitAmount).toBe(600_000n);
      // The reservation covers the FULL token amount since a split consumes
      // the entire source token (replaced by two new tokens)
      expect(ledger.getTotalReserved('tok-1')).toBe(1_000_000n);
    });

    it('handles multi-token plan reserving all participating tokens', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 300_000n],
        ['tok-2', 'UCT', 400_000n],
      );
      planner.planSend(
        { amount: '700000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      );

      // Both tokens should be reserved
      expect(ledger.getTotalReserved('tok-1')).toBe(300_000n);
      expect(ledger.getTotalReserved('tok-2')).toBe(400_000n);
    });

    it('does not call queue.enqueue for immediate plans', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      );

      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('concurrent planSend calls on separate tokens each reserve their own', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 600_000n],
        ['tok-2', 'UCT', 400_000n],
      );

      // First send takes tok-1 + tok-2 (exact combo = 1M is impossible, but 600k is)
      planner.planSend(
        { amount: '600000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      );

      // Second send should see tok-2 still free (400k) and plan from it
      const result = planner.planSend(
        { amount: '400000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-2',
      ) as PlanResult;

      expect(result.reservationId).toBe('res-2');
      expect(ledger.getTotalReserved('tok-1')).toBe(600_000n);
      expect(ledger.getTotalReserved('tok-2')).toBe(400_000n);
    });

    it('filters pool entries by coinId', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 500_000n],
        ['tok-2', 'USDC', 1_000_000n],
      );

      // Should only consider UCT tokens; USDC tokens ignored for coinId='UCT'
      try {
        planner.planSend(
          { amount: '600000', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SphereError);
        expect(err.code).toBe('SEND_INSUFFICIENT_BALANCE');
      }
    });
  });

  // ===========================================================================
  // planSend — Queued Planning (Case B)
  // ===========================================================================

  describe('planSend — queued planning (Case B)', () => {
    it('returns "queued" when tokens exist but are fully reserved', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 1_000_000n],
        ['tok-2', 'UCT', 1_000_000n],
      );

      // Reserve all of tok-1 and tok-2
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');
      ledger.reserve('existing-2', [
        { tokenId: 'tok-2', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-new',
      );

      expect(result).toBe('queued');
    });

    it('calls queue.enqueue when returning "queued"', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);

      // Reserve all tokens
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-new',
      );

      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      const enqueueArg = mockQueue.enqueue.mock.calls[0][0];
      expect(enqueueArg.id).toBe('res-new');
      expect(enqueueArg.coinId).toBe('UCT');
      expect(enqueueArg.amount).toBe(500_000n);
    });

    it('does not create a reservation in the ledger when queued', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-new',
      );

      expect(ledger.getReservation('res-new')).toBeUndefined();
    });

    it('queues when free amount is insufficient but total inventory covers it', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 600_000n],
        ['tok-2', 'UCT', 600_000n],
      );

      // Reserve most of each token, leaving insufficient free for a 500k send
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 400_000n, tokenAmount: 600_000n },
      ], 'UCT');
      ledger.reserve('existing-2', [
        { tokenId: 'tok-2', amount: 400_000n, tokenAmount: 600_000n },
      ], 'UCT');

      // Free: 200k + 200k = 400k < 500k, but total inventory = 1.2M >= 500k
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-new',
      );

      expect(result).toBe('queued');
    });

    it('passes parsedPool in the enqueue call', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-new',
      );

      const enqueueArg = mockQueue.enqueue.mock.calls[0][0];
      expect(enqueueArg.parsedPool).toBe(pool);
    });
  });

  // ===========================================================================
  // planSend — Rejection (Case C)
  // ===========================================================================

  describe('planSend — rejection (Case C)', () => {
    it('throws SEND_INSUFFICIENT_BALANCE when total inventory is less than requested', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 300_000n],
        ['tok-2', 'UCT', 200_000n],
      );

      try {
        planner.planSend(
          { amount: '600000', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SphereError);
        expect(err.code).toBe('SEND_INSUFFICIENT_BALANCE');
      }
    });

    it('throws SEND_INSUFFICIENT_BALANCE for empty pool', () => {
      const pool: ParsedTokenPool = new Map();

      try {
        planner.planSend(
          { amount: '1', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SphereError);
        expect(err.code).toBe('SEND_INSUFFICIENT_BALANCE');
      }
    });

    it('throws SEND_INSUFFICIENT_BALANCE when pool has only other coinIds', () => {
      const pool = buildPool(['tok-1', 'USDC', 1_000_000n]);

      try {
        planner.planSend(
          { amount: '500000', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(SphereError);
        expect(err.code).toBe('SEND_INSUFFICIENT_BALANCE');
      }
    });

    it('does not create a reservation on rejection', () => {
      const pool = buildPool(['tok-1', 'UCT', 100n]);

      try {
        planner.planSend(
          { amount: '500000', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
      } catch {
        // expected
      }

      expect(ledger.getReservation('res-1')).toBeUndefined();
    });

    it('does not enqueue on rejection', () => {
      const pool = buildPool(['tok-1', 'UCT', 100n]);

      try {
        planner.planSend(
          { amount: '500000', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
      } catch {
        // expected
      }

      expect(mockQueue.enqueue).not.toHaveBeenCalled();
    });

    it('error message contains available and required amounts', () => {
      const pool = buildPool(['tok-1', 'UCT', 300_000n]);

      try {
        planner.planSend(
          { amount: '500000', coinId: 'UCT' },
          pool, ledger, mockQueue, 'res-1',
        );
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('300000');
        expect(err.message).toContain('500000');
      }
    });

    it('uses total inventory (ignoring reservations) for the sufficiency check', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);

      // Reserve 800k, but total inventory is still 1M
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 800_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      // Request for 900k: total inventory (1M) >= 900k, so should NOT throw
      // but free = 200k < 900k, so it queues
      const result = planner.planSend(
        { amount: '900000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-new',
      );

      expect(result).toBe('queued');
    });
  });

  // ===========================================================================
  // planSend — Free amount reads from ledger
  // ===========================================================================

  describe('planSend — ledger free amount interaction', () => {
    it('considers partially reserved tokens with remaining free amount', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 1_000_000n],
        ['tok-2', 'UCT', 500_000n],
      );

      // Reserve all of tok-1, leaving tok-2 fully free
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      // Request for 400k should succeed using tok-2 (free portion)
      const result = planner.planSend(
        { amount: '400000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-2',
      ) as PlanResult;

      expect(result.reservationId).toBe('res-2');
      // tok-2 should now have a reservation for the split amount
      expect(ledger.getReservation('res-2')).toBeDefined();
    });

    it('excludes fully reserved tokens from free view', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 500_000n],
        ['tok-2', 'UCT', 500_000n],
      );

      // Fully reserve tok-1
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 500_000n, tokenAmount: 500_000n },
      ], 'UCT');

      // Request 500k should use tok-2 (the only free token)
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-2',
      ) as PlanResult;

      expect(result.reservationId).toBe('res-2');
      expect(ledger.getTotalReserved('tok-2')).toBe(500_000n);
    });

    it('builds free view correctly with unreserved tokens among reserved ones', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 1_000_000n],
        ['tok-2', 'UCT', 300_000n],
        ['tok-3', 'UCT', 200_000n],
      );

      // Fully reserve tok-1, leave tok-2 and tok-3 free
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      // Free: tok-2 = 300k, tok-3 = 200k = 500k total free
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-3',
      ) as PlanResult;

      expect(result.reservationId).toBe('res-3');
      expect(result.splitPlan.totalTransferAmount).toBe(500_000n);
    });

    it('after cancel, freed tokens become available for new plan', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);

      // Reserve all
      ledger.reserve('existing-1', [
        { tokenId: 'tok-1', amount: 1_000_000n, tokenAmount: 1_000_000n },
      ], 'UCT');

      // First attempt: should queue
      const result1 = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-queued',
      );
      expect(result1).toBe('queued');

      // Cancel the blocking reservation
      ledger.cancel('existing-1');

      // Now plan should succeed immediately
      const result2 = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-2',
      ) as PlanResult;

      expect(result2.reservationId).toBe('res-2');
    });
  });

  // ===========================================================================
  // planSend — splitPlan correctness
  // ===========================================================================

  describe('planSend — splitPlan result details', () => {
    it('returns requiresSplit=false for exact match', () => {
      const pool = buildPool(['tok-1', 'UCT', 500_000n]);
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.splitPlan.requiresSplit).toBe(false);
      expect(result.splitPlan.tokenToSplit).toBeNull();
      expect(result.splitPlan.splitAmount).toBeNull();
    });

    it('returns requiresSplit=true with correct split amounts', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      const result = planner.planSend(
        { amount: '300000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.splitPlan.requiresSplit).toBe(true);
      expect(result.splitPlan.splitAmount).toBe(300_000n);
      expect(result.splitPlan.remainderAmount).toBe(700_000n);
    });

    it('sets coinId on the returned splitPlan', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.splitPlan.coinId).toBe('UCT');
    });

    it('direct transfer tokens have correct uiToken references', () => {
      const pool = buildPool(['tok-1', 'UCT', 500_000n]);
      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.splitPlan.tokensToTransferDirectly).toHaveLength(1);
      expect(result.splitPlan.tokensToTransferDirectly[0].uiToken.id).toBe('tok-1');
    });

    it('split token has correct uiToken reference', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      const result = planner.planSend(
        { amount: '300000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.splitPlan.tokenToSplit!.uiToken.id).toBe('tok-1');
    });
  });

  // ===========================================================================
  // planSend — edge cases
  // ===========================================================================

  describe('planSend — edge cases', () => {
    it('handles request for amount of 1 (minimum)', () => {
      const pool = buildPool(['tok-1', 'UCT', 1_000_000n]);
      const result = planner.planSend(
        { amount: '1', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.reservationId).toBe('res-1');
      expect(result.splitPlan.requiresSplit).toBe(true);
      expect(result.splitPlan.splitAmount).toBe(1n);
    });

    it('handles pool with many tokens for the same coinId', () => {
      const entries: Array<[string, string, bigint]> = [];
      for (let i = 0; i < 20; i++) {
        entries.push([`tok-${i}`, 'UCT', 100n]);
      }
      const pool = buildPool(...entries);

      const result = planner.planSend(
        { amount: '500', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.reservationId).toBe('res-1');
      expect(result.splitPlan.totalTransferAmount).toBe(500n);
    });

    it('mixed coinId pool only considers requested coinId', () => {
      const pool = buildPool(
        ['tok-1', 'UCT', 300_000n],
        ['tok-2', 'USDC', 5_000_000n],
        ['tok-3', 'UCT', 200_000n],
      );

      const result = planner.planSend(
        { amount: '500000', coinId: 'UCT' },
        pool, ledger, mockQueue, 'res-1',
      ) as PlanResult;

      expect(result.splitPlan.totalTransferAmount).toBe(500_000n);
      // Only UCT tokens should participate
      const allTokenIds = [
        ...result.splitPlan.tokensToTransferDirectly.map(t => t.uiToken.id),
        ...(result.splitPlan.tokenToSplit ? [result.splitPlan.tokenToSplit.uiToken.id] : []),
      ];
      for (const id of allTokenIds) {
        expect(pool.get(id)!.token.coinId).toBe('UCT');
      }
    });
  });
});
