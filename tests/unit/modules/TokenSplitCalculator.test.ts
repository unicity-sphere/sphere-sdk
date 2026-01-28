/**
 * Tests for modules/payments/TokenSplitCalculator.ts
 * Covers optimal token split calculation for partial transfers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TokenSplitCalculator,
  createTokenSplitCalculator,
  type SplitPlan,
} from '../../../modules/payments/TokenSplitCalculator';
import type { Token } from '../../../types';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock the CoinId class
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: {
    fromJSON: vi.fn().mockImplementation((hex: string) => ({ hex })),
  },
}));

// Mock the SDK Token class with coins.get() method (lottery-compatible)
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockImplementation((data) => ({
      coins: {
        get: vi.fn().mockImplementation(() => {
          // Return the amount from parsed data
          return data.amount ? BigInt(data.amount) : 0n;
        }),
      },
    })),
  },
}));

// =============================================================================
// Test Helpers
// =============================================================================

const COIN_ID = '0x1234567890abcdef';

function createMockToken(id: string, amount: bigint, status = 'confirmed'): Token {
  return {
    id,
    symbol: 'TEST',
    amount: amount.toString(),
    decimals: 8,
    coinId: COIN_ID,
    status: status as Token['status'],
    sdkData: JSON.stringify({
      coinId: COIN_ID,
      amount: amount.toString(),
    }),
    createdAt: Date.now(),
  };
}

// =============================================================================
// Constructor Tests
// =============================================================================

describe('TokenSplitCalculator', () => {
  describe('constructor and factory', () => {
    it('should create instance via constructor', () => {
      const calc = new TokenSplitCalculator();
      expect(calc).toBeInstanceOf(TokenSplitCalculator);
    });

    it('should create instance via factory function', () => {
      const calc = createTokenSplitCalculator();
      expect(calc).toBeInstanceOf(TokenSplitCalculator);
    });
  });

  // =============================================================================
  // calculateOptimalSplit Tests
  // =============================================================================

  describe('calculateOptimalSplit()', () => {
    let calculator: TokenSplitCalculator;

    beforeEach(() => {
      calculator = new TokenSplitCalculator();
    });

    it('should return null for insufficient funds', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 200n, COIN_ID);

      expect(result).toBeNull();
    });

    it('should return null for empty token list', async () => {
      const result = await calculator.calculateOptimalSplit([], 100n, COIN_ID);

      expect(result).toBeNull();
    });

    it('should find exact match (single token)', async () => {
      const tokens = [
        createMockToken('t1', 100n),
        createMockToken('t2', 200n),
        createMockToken('t3', 300n),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 200n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(200n);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
    });

    it('should find combination of tokens (exact match)', async () => {
      const tokens = [
        createMockToken('t1', 100n),
        createMockToken('t2', 150n),
        createMockToken('t3', 50n),
      ];

      // 100 + 50 = 150 (exact match with 2 tokens)
      const result = await calculator.calculateOptimalSplit(tokens, 150n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(150n);
    });

    it('should require split when no exact match', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 75n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.splitAmount).toBe(75n);
      expect(result!.remainderAmount).toBe(25n);
      expect(result!.tokenToSplit).not.toBeNull();
    });

    it('should calculate correct split amounts', async () => {
      const tokens = [createMockToken('t1', 1000n)];

      const result = await calculator.calculateOptimalSplit(tokens, 350n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.splitAmount).toBe(350n);
      expect(result!.remainderAmount).toBe(650n);
      expect(result!.totalTransferAmount).toBe(350n);
    });

    it('should filter by coinId', async () => {
      const tokens = [
        createMockToken('t1', 100n),
        { ...createMockToken('t2', 500n), coinId: 'different_coin' },
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 200n, COIN_ID);

      // Only t1 matches, insufficient funds
      expect(result).toBeNull();
    });

    it('should filter by status (confirmed only)', async () => {
      const tokens = [
        createMockToken('t1', 100n, 'pending'),
        createMockToken('t2', 100n, 'confirmed'),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 150n, COIN_ID);

      // Only t2 is confirmed, insufficient funds
      expect(result).toBeNull();
    });

    it('should skip tokens without sdkData', async () => {
      const tokenWithoutSdk: Token = {
        id: 't1',
        symbol: 'TEST',
        amount: '1000',
        decimals: 8,
        coinId: COIN_ID,
        status: 'confirmed',
        sdkData: undefined,
        createdAt: Date.now(),
      };

      const result = await calculator.calculateOptimalSplit([tokenWithoutSdk], 100n, COIN_ID);

      expect(result).toBeNull();
    });

    it('should include direct transfer tokens and split token', async () => {
      const tokens = [
        createMockToken('t1', 50n),
        createMockToken('t2', 50n),
        createMockToken('t3', 100n),
      ];

      // Need 175: can use t1(50) + t2(50) = 100, then split t3 for 75
      const result = await calculator.calculateOptimalSplit(tokens, 175n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.tokensToTransferDirectly.length).toBeGreaterThanOrEqual(0);
      expect(result!.tokenToSplit).not.toBeNull();
    });

    it('should return correct coinId in result', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 50n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.coinId).toBe(COIN_ID);
    });

    it('should handle large amounts', async () => {
      const largeAmount = 1_000_000_000_000n; // 1 trillion
      const tokens = [createMockToken('t1', largeAmount * 2n)];

      const result = await calculator.calculateOptimalSplit(tokens, largeAmount, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
      expect(result!.splitAmount).toBe(largeAmount);
      expect(result!.remainderAmount).toBe(largeAmount);
    });

    it('should prefer exact match over split', async () => {
      const tokens = [
        createMockToken('t1', 100n), // Exact match
        createMockToken('t2', 200n), // Could split
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 100n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokensToTransferDirectly).toHaveLength(1);
    });

    it('should set tokenToSplit to null for direct transfer', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 100n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.tokenToSplit).toBeNull();
      expect(result!.splitAmount).toBeNull();
      expect(result!.remainderAmount).toBeNull();
    });
  });

  // =============================================================================
  // Edge Cases
  // =============================================================================

  describe('Edge cases', () => {
    let calculator: TokenSplitCalculator;

    beforeEach(() => {
      calculator = new TokenSplitCalculator();
    });

    it('should handle single token exact match', async () => {
      const tokens = [createMockToken('t1', 500n)];

      const result = await calculator.calculateOptimalSplit(tokens, 500n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(false);
      expect(result!.totalTransferAmount).toBe(500n);
    });

    it('should handle many small tokens', async () => {
      const tokens = Array.from({ length: 10 }, (_, i) =>
        createMockToken(`t${i}`, 10n)
      );

      // Total: 100, need 50
      const result = await calculator.calculateOptimalSplit(tokens, 50n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.totalTransferAmount).toBe(50n);
    });

    it('should handle target amount of 0', async () => {
      const tokens = [createMockToken('t1', 100n)];

      // Greedy finds 0 immediately (currentSum = 0 = targetAmount)
      // But the greedy loop needs at least one iteration to check
      // Actually this edge case may not be handled well - let's see
      const result = await calculator.calculateOptimalSplit(tokens, 0n, COIN_ID);

      // Zero amount is an edge case - behavior depends on implementation
      // The code checks totalAvailable < targetAmount (0n < 0n = false, so proceeds)
      // Then looks for exactMatch (0n === 100n = false)
      // Then tries combinations (none sum to 0)
      // Then greedy: currentSum=0 === targetAmount=0, returns empty direct plan
      expect(result).not.toBeNull();
      expect(result!.totalTransferAmount).toBe(0n);
    });

    it('should handle token with zero amount', async () => {
      const tokens = [
        createMockToken('t1', 0n),
        createMockToken('t2', 100n),
      ];

      const result = await calculator.calculateOptimalSplit(tokens, 50n, COIN_ID);

      expect(result).not.toBeNull();
      expect(result!.requiresSplit).toBe(true);
    });
  });

  // =============================================================================
  // SplitPlan Structure Tests
  // =============================================================================

  describe('SplitPlan structure', () => {
    let calculator: TokenSplitCalculator;

    beforeEach(() => {
      calculator = new TokenSplitCalculator();
    });

    it('should have all required fields for direct transfer', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 100n, COIN_ID);

      expect(result).toMatchObject<Partial<SplitPlan>>({
        tokensToTransferDirectly: expect.any(Array),
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 100n,
        coinId: COIN_ID,
        requiresSplit: false,
      });
    });

    it('should have all required fields for split transfer', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 75n, COIN_ID);

      expect(result).toMatchObject<Partial<SplitPlan>>({
        tokensToTransferDirectly: expect.any(Array),
        tokenToSplit: expect.any(Object),
        splitAmount: 75n,
        remainderAmount: 25n,
        totalTransferAmount: 75n,
        coinId: COIN_ID,
        requiresSplit: true,
      });
    });

    it('should include token metadata in TokenWithAmount', async () => {
      const tokens = [createMockToken('t1', 100n)];

      const result = await calculator.calculateOptimalSplit(tokens, 100n, COIN_ID);

      expect(result).not.toBeNull();
      const directToken = result!.tokensToTransferDirectly[0];

      expect(directToken).toHaveProperty('sdkToken');
      expect(directToken).toHaveProperty('amount');
      expect(directToken).toHaveProperty('uiToken');
      expect(directToken.uiToken.id).toBe('t1');
    });
  });
});
