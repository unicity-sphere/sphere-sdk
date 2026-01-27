/**
 * Token Split Calculator
 * Calculates optimal token splits for partial transfers
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Token } from '../../types';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';

// =============================================================================
// Types
// =============================================================================

export interface TokenWithAmount {
  sdkToken: SdkToken<any>;
  amount: bigint;
  uiToken: Token;
}

export interface SplitPlan {
  /** Tokens that can be transferred directly (exact match or combination) */
  tokensToTransferDirectly: TokenWithAmount[];
  /** Token that needs to be split (if requiresSplit is true) */
  tokenToSplit: TokenWithAmount | null;
  /** Amount to send to recipient from split token */
  splitAmount: bigint | null;
  /** Amount to keep as change from split token */
  remainderAmount: bigint | null;
  /** Total amount being transferred */
  totalTransferAmount: bigint;
  /** Coin type being transferred */
  coinId: string;
  /** Whether a split operation is required */
  requiresSplit: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

export class TokenSplitCalculator {
  /**
   * Calculate optimal split plan for transferring a specific amount
   *
   * Strategy:
   * 1. Try to find exact match (single token = amount)
   * 2. Try to find combination of tokens that sum to exact amount
   * 3. If no exact match, determine which token to split
   */
  async calculateOptimalSplit(
    availableTokens: Token[],
    targetAmount: bigint,
    targetCoinIdHex: string
  ): Promise<SplitPlan | null> {
    console.log(
      `[SplitCalculator] Calculating split for ${targetAmount} of ${targetCoinIdHex}`
    );

    const candidates: TokenWithAmount[] = [];

    // Build candidate list from available tokens
    for (const t of availableTokens) {
      if (t.coinId !== targetCoinIdHex) continue;
      if (t.status !== 'confirmed') continue;
      if (!t.sdkData) continue;

      try {
        const parsed = JSON.parse(t.sdkData);
        const sdkToken = await SdkToken.fromJSON(parsed);
        const realAmount = this.getAmountFromSdkToken(sdkToken);

        if (realAmount <= 0n) {
          console.warn(`[SplitCalculator] Token ${t.id} has 0 balance`);
          continue;
        }

        candidates.push({
          sdkToken,
          amount: realAmount,
          uiToken: t,
        });
      } catch (e) {
        console.warn('[SplitCalculator] Failed to parse token', t.id, e);
      }
    }

    // Sort by amount (ascending) for greedy algorithm
    candidates.sort((a, b) => (a.amount < b.amount ? -1 : 1));

    // Check total available
    const totalAvailable = candidates.reduce((sum, t) => sum + t.amount, 0n);
    if (totalAvailable < targetAmount) {
      console.error(
        `[SplitCalculator] Insufficient funds. Available: ${totalAvailable}, Required: ${targetAmount}`
      );
      return null;
    }

    // Strategy 1: Find exact match
    const exactMatch = candidates.find((t) => t.amount === targetAmount);
    if (exactMatch) {
      console.log('[SplitCalculator] Found exact match token');
      return this.createDirectPlan([exactMatch], targetAmount, targetCoinIdHex);
    }

    // Strategy 2: Try to find combination of tokens (up to 5)
    const maxCombinationSize = Math.min(5, candidates.length);
    for (let size = 2; size <= maxCombinationSize; size++) {
      const combo = this.findCombinationOfSize(candidates, targetAmount, size);
      if (combo) {
        console.log(`[SplitCalculator] Found exact combination of ${size} tokens`);
        return this.createDirectPlan(combo, targetAmount, targetCoinIdHex);
      }
    }

    // Strategy 3: Greedy selection with split
    const toTransfer: TokenWithAmount[] = [];
    let currentSum = 0n;

    for (const candidate of candidates) {
      const newSum = currentSum + candidate.amount;

      if (newSum === targetAmount) {
        // Perfect match found during greedy
        toTransfer.push(candidate);
        return this.createDirectPlan(toTransfer, targetAmount, targetCoinIdHex);
      } else if (newSum < targetAmount) {
        // Add to transfer set
        toTransfer.push(candidate);
        currentSum = newSum;
      } else {
        // Need to split this token
        const neededFromThisToken = targetAmount - currentSum;
        const remainderForSender = candidate.amount - neededFromThisToken;

        console.log(
          `[SplitCalculator] Split required. Sending: ${neededFromThisToken}, Remainder: ${remainderForSender}`
        );

        return {
          tokensToTransferDirectly: toTransfer,
          tokenToSplit: candidate,
          splitAmount: neededFromThisToken,
          remainderAmount: remainderForSender,
          totalTransferAmount: targetAmount,
          coinId: targetCoinIdHex,
          requiresSplit: true,
        };
      }
    }

    // Should not reach here if totalAvailable >= targetAmount
    return null;
  }

  /**
   * Extract real amount from SDK token structure
   */
  private getAmountFromSdkToken(sdkToken: SdkToken<any>): bigint {
    try {
      const coinsOpt = sdkToken.coins;
      const coinData = coinsOpt;

      if (coinData && coinData.coins) {
        const rawCoins = coinData.coins;
        let val: any = null;

        const firstItem = rawCoins[0];
        if (Array.isArray(firstItem) && firstItem.length === 2) {
          val = firstItem[1];
        }

        if (Array.isArray(val)) {
          return BigInt(val[1]?.toString() || '0');
        } else if (val) {
          return BigInt(val.toString());
        }
      }
    } catch (e) {
      console.error('[SplitCalculator] Error extracting amount from SDK token', e);
    }
    return 0n;
  }

  /**
   * Create a plan for direct transfer (no split needed)
   */
  private createDirectPlan(
    tokens: TokenWithAmount[],
    total: bigint,
    coinId: string
  ): SplitPlan {
    return {
      tokensToTransferDirectly: tokens,
      tokenToSplit: null,
      splitAmount: null,
      remainderAmount: null,
      totalTransferAmount: total,
      coinId,
      requiresSplit: false,
    };
  }

  /**
   * Find a combination of exactly `size` tokens that sum to targetAmount
   */
  private findCombinationOfSize(
    tokens: TokenWithAmount[],
    targetAmount: bigint,
    size: number
  ): TokenWithAmount[] | null {
    const generator = this.generateCombinations(tokens, size);

    for (const combo of generator) {
      const sum = combo.reduce((acc, t) => acc + t.amount, 0n);
      if (sum === targetAmount) {
        return combo;
      }
    }
    return null;
  }

  /**
   * Generator for k-combinations of tokens
   */
  private *generateCombinations(
    tokens: TokenWithAmount[],
    k: number,
    start: number = 0,
    current: TokenWithAmount[] = []
  ): Generator<TokenWithAmount[]> {
    if (k === 0) {
      yield current;
      return;
    }

    for (let i = start; i < tokens.length; i++) {
      yield* this.generateCombinations(tokens, k - 1, i + 1, [
        ...current,
        tokens[i],
      ]);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createTokenSplitCalculator(): TokenSplitCalculator {
  return new TokenSplitCalculator();
}
