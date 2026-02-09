/**
 * Tests for validation/token-validator.ts
 *
 * Covers:
 * 1. Wallet pubkey usage for spent detection (critical bug fix)
 * 2. Inclusion proof validation logic
 * 3. Spent state cache behavior (TTL, permanence)
 * 4. Error handling (missing aggregator, invalid TXF, network errors)
 * 5. Batch processing in checkSpentTokens()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenValidator, type AggregatorClient } from '../../../validation/token-validator';
import type { Token } from '../../../types';

// =============================================================================
// Mock SDK dynamic imports
// =============================================================================

const mockRequestIdCreate = vi.fn();
const mockRequestIdToBitString = vi.fn();
const mockDataHashFromJSON = vi.fn();
const mockSdkTokenFromJSON = vi.fn();

vi.mock('@unicitylabs/state-transition-sdk/lib/api/RequestId', () => ({
  RequestId: {
    create: (...args: unknown[]) => mockRequestIdCreate(...args),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/DataHash', () => ({
  DataHash: {
    fromJSON: (...args: unknown[]) => mockDataHashFromJSON(...args),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: (...args: unknown[]) => mockSdkTokenFromJSON(...args),
  },
}));

// Mock tokenToTxf to return controlled TXF data
vi.mock('../../../serialization/txf-serializer', () => ({
  tokenToTxf: vi.fn((token: Token) => {
    if (!token.sdkData) return null;
    try {
      return JSON.parse(token.sdkData);
    } catch {
      return null;
    }
  }),
}));

// =============================================================================
// Test Helpers
// =============================================================================

const WALLET_PUBKEY = 'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd11';
const SENDER_PUBKEY = 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff';
const TOKEN_ID_A = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_A = 'bbbb000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_B = 'cccc000000000000000000000000000000000000000000000000000000000002';

function createMockToken(opts: {
  tokenId?: string;
  stateHash?: string;
  id?: string;
  noSdkData?: boolean;
}): Token {
  const tokenId = opts.tokenId ?? TOKEN_ID_A;
  const stateHash = opts.stateHash ?? STATE_HASH_A;

  const sdkData = opts.noSdkData ? undefined : JSON.stringify({
    version: '2.0',
    genesis: {
      data: { tokenId, tokenType: '00', coinData: [['UCT_HEX', '1000000']], tokenData: '', salt: '00', recipient: 'DIRECT://test', recipientDataHash: null, reason: null },
      inclusionProof: { authenticator: { algorithm: 'secp256k1', publicKey: SENDER_PUBKEY, signature: 'sig', stateHash }, merkleTreePath: { root: '00', steps: [] }, transactionHash: '00', unicityCertificate: '00' },
    },
    state: { data: 'statedata', predicate: 'predicate' },
    transactions: [],
  });

  return {
    id: opts.id ?? `local-${tokenId.slice(0, 8)}`,
    sdkData,
    coinId: 'UCT_HEX',
    amount: '1000000',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function createMockAggregatorClient(overrides?: Partial<AggregatorClient>): AggregatorClient {
  return {
    getInclusionProof: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/** Create a mock inclusion proof response that indicates SPENT */
function spentProofResponse() {
  return {
    inclusionProof: {
      authenticator: { stateHash: STATE_HASH_A },
      merkleTreePath: {
        verify: vi.fn().mockResolvedValue({ isPathValid: true, isPathIncluded: true }),
      },
    },
  };
}

/** Create a mock exclusion proof response that indicates UNSPENT */
function unspentProofResponse() {
  return {
    inclusionProof: {
      authenticator: { stateHash: STATE_HASH_A },
      merkleTreePath: {
        verify: vi.fn().mockResolvedValue({ isPathValid: true, isPathIncluded: false }),
      },
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('TokenValidator', () => {
  let validator: TokenValidator;
  let mockAggregator: AggregatorClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockAggregator = createMockAggregatorClient();
    validator = new TokenValidator({ aggregatorClient: mockAggregator });

    // Default SDK mock implementations
    const mockStateHash = { toJSON: () => STATE_HASH_A };
    mockSdkTokenFromJSON.mockResolvedValue({
      state: { calculateHash: vi.fn().mockResolvedValue(mockStateHash) },
    });

    mockDataHashFromJSON.mockReturnValue({ _hash: STATE_HASH_A });

    const mockBitString = { toBigInt: () => BigInt(12345) };
    mockRequestIdCreate.mockResolvedValue({
      toBitString: () => mockBitString,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // 1. Wallet pubkey usage (Edge Case 1 - the critical bug)
  // ===========================================================================

  describe('checkSpentTokens() - wallet pubkey usage', () => {
    it('should call RequestId.create with wallet pubkey buffer, NOT source state key', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      const token = createMockToken({});
      await validator.checkSpentTokens([token], WALLET_PUBKEY);

      expect(mockRequestIdCreate).toHaveBeenCalledTimes(1);
      const [pubKeyArg] = mockRequestIdCreate.mock.calls[0];

      // Must be wallet pubkey, not the sender's pubkey from the token
      expect(Buffer.isBuffer(pubKeyArg)).toBe(true);
      expect(pubKeyArg.toString('hex')).toBe(WALLET_PUBKEY);
    });

    it('should use SDK-calculated state hash from sdkToken.state.calculateHash()', async () => {
      const calculatedHash = 'dddd000000000000000000000000000000000000000000000000000000000099';
      const mockCalcStateHash = { toJSON: () => calculatedHash };
      mockSdkTokenFromJSON.mockResolvedValue({
        state: { calculateHash: vi.fn().mockResolvedValue(mockCalcStateHash) },
      });

      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      const token = createMockToken({});
      await validator.checkSpentTokens([token], WALLET_PUBKEY);

      // DataHash.fromJSON should be called with the SDK-calculated hash, not the stored one
      expect(mockDataHashFromJSON).toHaveBeenCalledWith(calculatedHash);
    });

    it('should detect token as UNSPENT when exclusion proof (received token, checked with wallet pubkey)', async () => {
      // Simulates: token received from sender, wallet pubkey has no commitment → exclusion proof
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      const token = createMockToken({});
      const result = await validator.checkSpentTokens([token], WALLET_PUBKEY);

      expect(result.spentTokens).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect token as SPENT when inclusion proof (wallet already committed this state)', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(spentProofResponse());

      const token = createMockToken({});
      const result = await validator.checkSpentTokens([token], WALLET_PUBKEY);

      expect(result.spentTokens).toHaveLength(1);
      expect(result.spentTokens[0].tokenId).toBe(TOKEN_ID_A);
    });
  });

  // ===========================================================================
  // 2. Inclusion proof validation
  // ===========================================================================

  describe('isTokenStateSpent() - inclusion proof validation', () => {
    it('should return false when no inclusionProof in response', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(false);
    });

    it('should return false when authenticator is null', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue({
        inclusionProof: {
          authenticator: null,
          merkleTreePath: {
            verify: vi.fn().mockResolvedValue({ isPathValid: true, isPathIncluded: true }),
          },
        },
      });

      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(false);
    });

    it('should return false when isPathValid is false', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue({
        inclusionProof: {
          authenticator: { stateHash: STATE_HASH_A },
          merkleTreePath: {
            verify: vi.fn().mockResolvedValue({ isPathValid: false, isPathIncluded: true }),
          },
        },
      });

      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(false);
    });

    it('should return false when isPathIncluded is false', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(false);
    });

    it('should return true when all three conditions are met', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(spentProofResponse());

      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(true);
    });
  });

  // ===========================================================================
  // 3. Cache behavior
  // ===========================================================================

  describe('spent state cache', () => {
    it('should cache SPENT permanently (aggregator called once)', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(spentProofResponse());

      // First call - hits aggregator
      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(1);

      // Advance time well past TTL
      vi.advanceTimersByTime(30 * 60 * 1000);

      // Second call - should use cache (SPENT is permanent)
      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(true);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(1); // No additional call
    });

    it('should cache UNSPENT with 5min TTL (expires, re-queries)', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      // First call
      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(1);

      // Within TTL - should use cache
      vi.advanceTimersByTime(4 * 60 * 1000);
      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(1);

      // Past TTL - should re-query
      vi.advanceTimersByTime(2 * 60 * 1000); // total 6min
      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(2);
    });

    it('should use different cache keys for different pubkeys', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, SENDER_PUBKEY);

      // Two different pubkeys → two separate cache entries → two aggregator calls
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(2);
    });

    it('should clear cache with clearSpentStateCache()', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(1);

      validator.clearSpentStateCache();

      await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(mockAggregator.getInclusionProof).toHaveBeenCalledTimes(2);
    });

    it('should use cache in checkSpentTokens() as well', async () => {
      // Pre-populate cache via isTokenStateSpent
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(spentProofResponse());

      const token = createMockToken({});
      // First call fills cache
      await validator.checkSpentTokens([token], WALLET_PUBKEY);

      // Reset call count
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockClear();

      // Second call should use cache
      const result = await validator.checkSpentTokens([token], WALLET_PUBKEY);
      expect(result.spentTokens).toHaveLength(1);
      expect(mockAggregator.getInclusionProof).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 4. Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should return error when no aggregator client', async () => {
      const noAggValidator = new TokenValidator();
      const token = createMockToken({});

      const result = await noAggValidator.checkSpentTokens([token], WALLET_PUBKEY);
      expect(result.spentTokens).toHaveLength(0);
      expect(result.errors).toContain('Aggregator client not available');
    });

    it('should return false from isTokenStateSpent() when no aggregator', async () => {
      const noAggValidator = new TokenValidator();
      const result = await noAggValidator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(false);
    });

    it('should report error for token with no sdkData (invalid TXF)', async () => {
      const token = createMockToken({ noSdkData: true });
      const result = await validator.checkSpentTokens([token], WALLET_PUBKEY);

      expect(result.spentTokens).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Invalid TXF');
    });

    it('should treat token as unspent on aggregator network error', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network timeout'));

      const result = await validator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result).toBe(false);
    });

    it('should report error when SdkToken.fromJSON fails', async () => {
      mockSdkTokenFromJSON.mockRejectedValue(new Error('Invalid token format'));

      const token = createMockToken({});
      const result = await validator.checkSpentTokens([token], WALLET_PUBKEY);

      expect(result.spentTokens).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Invalid token format');
    });
  });

  // ===========================================================================
  // 5. Batch processing
  // ===========================================================================

  describe('batch processing', () => {
    it('should call progress callback correctly', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      const tokens = [
        createMockToken({ tokenId: TOKEN_ID_A, id: 'token-1' }),
        createMockToken({ tokenId: TOKEN_ID_A.replace('0001', '0002'), stateHash: STATE_HASH_B, id: 'token-2' }),
      ];

      // Each token gets a unique calculated hash so they don't share cache
      let callCount = 0;
      mockSdkTokenFromJSON.mockImplementation(async () => ({
        state: {
          calculateHash: vi.fn().mockResolvedValue({
            toJSON: () => `hash_${++callCount}`,
          }),
        },
      }));

      const progressCalls: [number, number][] = [];
      await validator.checkSpentTokens(tokens, WALLET_PUBKEY, {
        onProgress: (completed, total) => progressCalls.push([completed, total]),
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      // Last progress call should show all completed
      const lastCall = progressCalls[progressCalls.length - 1];
      expect(lastCall[0]).toBe(tokens.length);
      expect(lastCall[1]).toBe(tokens.length);
    });

    it('should honor custom batchSize', async () => {
      (mockAggregator.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(unspentProofResponse());

      // Create 5 tokens
      const tokens = Array.from({ length: 5 }, (_, i) => {
        const tid = TOKEN_ID_A.slice(0, -4) + String(i).padStart(4, '0');
        return createMockToken({ tokenId: tid, stateHash: `hash${i}`.padEnd(64, '0'), id: `token-${i}` });
      });

      let callIdx = 0;
      mockSdkTokenFromJSON.mockImplementation(async () => ({
        state: {
          calculateHash: vi.fn().mockResolvedValue({
            toJSON: () => `unique_hash_${++callIdx}`,
          }),
        },
      }));

      const progressCalls: [number, number][] = [];
      await validator.checkSpentTokens(tokens, WALLET_PUBKEY, {
        batchSize: 2,
        onProgress: (completed, total) => progressCalls.push([completed, total]),
      });

      // With batchSize=2 and 5 tokens, we should get 3 batches (2+2+1)
      // Progress is called once per batch
      expect(progressCalls.length).toBe(3);
      expect(progressCalls[0]).toEqual([2, 5]);
      expect(progressCalls[1]).toEqual([4, 5]);
      expect(progressCalls[2]).toEqual([5, 5]);
    });
  });

  // ===========================================================================
  // 6. validateToken() tests
  // ===========================================================================

  describe('validateToken()', () => {
    it('should reject token with no sdkData', async () => {
      const token = createMockToken({ noSdkData: true });
      const result = await validator.validateToken(token);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('no SDK data');
    });

    it('should reject token with invalid JSON in sdkData', async () => {
      const token = { ...createMockToken({}), sdkData: 'not-json' };
      const result = await validator.validateToken(token);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('parse');
    });

    it('should reject token missing genesis or state fields', async () => {
      const token = { ...createMockToken({}), sdkData: JSON.stringify({ foo: 'bar' }) };
      const result = await validator.validateToken(token);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('TXF fields');
    });

    it('should accept valid token with proper TXF structure', async () => {
      const token = createMockToken({});
      const result = await validator.validateToken(token);
      expect(result.isValid).toBe(true);
    });

    it('should reject token with uncommitted transactions', async () => {
      const sdkData = JSON.parse(createMockToken({}).sdkData!);
      sdkData.transactions = [{ previousStateHash: '00', predicate: '00', inclusionProof: null }];
      const token = { ...createMockToken({}), sdkData: JSON.stringify(sdkData) };

      const result = await validator.validateToken(token);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('uncommitted');
    });
  });

  // ===========================================================================
  // 7. setAggregatorClient / setTrustBase
  // ===========================================================================

  describe('setAggregatorClient / setTrustBase', () => {
    it('should allow setting aggregator client after construction', async () => {
      const noAggValidator = new TokenValidator();

      // Initially no aggregator
      const result1 = await noAggValidator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result1).toBe(false);

      // Set aggregator
      const agg = createMockAggregatorClient();
      (agg.getInclusionProof as ReturnType<typeof vi.fn>).mockResolvedValue(spentProofResponse());
      noAggValidator.setAggregatorClient(agg);

      const result2 = await noAggValidator.isTokenStateSpent(TOKEN_ID_A, STATE_HASH_A, WALLET_PUBKEY);
      expect(result2).toBe(true);
    });
  });
});
