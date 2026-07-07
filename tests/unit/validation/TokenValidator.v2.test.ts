/**
 * TokenValidator — Phase 6 v2 facade coverage.
 *
 * Wave 6-P2-4b replaced the v1 TokenValidator (which reached into
 * `state-transition-sdk` internals — RequestId, Token.fromJSON, TXF sdkData
 * shapes, DataHasher aggregator checks) with a thin, non-throwing facade.
 * v2 makes token verification a first-class engine capability
 * (`ITokenEngine.verify` + `ITokenEngine.isSpent`); this facade preserves
 * only the API-shape contract so pre-migration consumers keep compiling.
 *
 * The behaviour lock-in for the facade is small but important:
 *
 *   - `validateToken` — structural checks only, accepts any Token with a
 *     defined id; rejects those without one. NEVER hits the aggregator.
 *   - `validateAllTokens` — conservative accept of every input; returns
 *     empty issues; still fires the progress callback so consumer UIs
 *     don't stall.
 *   - `isTokenStateSpent` — always false (conservative default; real
 *     check lives on ITokenEngine.isSpent).
 *   - `checkSpentTokens` — returns empty spent/error arrays.
 *   - Aggregator + trust base setters are no-op accessors that don't
 *     trigger any RPC.
 *
 * Wave-6-P2-5 quarantined the v1 TokenValidator test suite. This file
 * locks in the facade's shape so a future v2-native re-implementation
 * doesn't silently change the public surface without an update here.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  TokenValidator,
  createTokenValidator,
  type AggregatorClient,
} from '../../../validation/token-validator';
import type { Token } from '../../../types';

function fakeToken(overrides: Partial<Token> = {}): Token {
  const now = Date.now();
  return {
    id: 'token-1',
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '1000',
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TokenValidator (v2 facade)', () => {
  describe('validateToken()', () => {
    it('accepts a Token with a defined id (structural OK)', async () => {
      const v = createTokenValidator();
      const result = await v.validateToken(fakeToken());
      expect(result.isValid).toBe(true);
    });

    it('rejects a Token missing an id', async () => {
      const v = createTokenValidator();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await v.validateToken({ id: '' } as any);
      expect(result.isValid).toBe(false);
      expect(result.reason).toMatch(/missing id/i);
    });

    it('rejects a null/undefined token', async () => {
      const v = createTokenValidator();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await v.validateToken(null as any);
      expect(result.isValid).toBe(false);
    });
  });

  describe('validateAllTokens()', () => {
    it('accepts every input token and returns an empty issues list', async () => {
      const v = createTokenValidator();
      const tokens = [fakeToken({ id: 't1' }), fakeToken({ id: 't2' }), fakeToken({ id: 't3' })];
      const { validTokens, issues } = await v.validateAllTokens(tokens);
      expect(validTokens).toHaveLength(3);
      expect(issues).toEqual([]);
    });

    it('invokes the onProgress callback once per token', async () => {
      const v = createTokenValidator();
      const onProgress = vi.fn();
      const tokens = [fakeToken({ id: 't1' }), fakeToken({ id: 't2' })];
      await v.validateAllTokens(tokens, { onProgress });
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2);
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2);
    });

    it('handles an empty token list without invoking onProgress', async () => {
      const v = createTokenValidator();
      const onProgress = vi.fn();
      const result = await v.validateAllTokens([], { onProgress });
      expect(result.validTokens).toEqual([]);
      expect(onProgress).not.toHaveBeenCalled();
    });
  });

  describe('isTokenStateSpent() — conservative default', () => {
    it('returns false without touching the aggregator (v2 delegates to ITokenEngine.isSpent)', async () => {
      const agg: AggregatorClient = {
        getInclusionProof: vi.fn(),
      };
      const v = createTokenValidator({ aggregatorClient: agg });
      const result = await v.isTokenStateSpent('token-1', 'state-hash', '02aa');
      expect(result).toBe(false);
      expect(agg.getInclusionProof).not.toHaveBeenCalled();
    });
  });

  describe('checkSpentTokens() — empty result set', () => {
    it('returns empty spent/error arrays without touching the aggregator', async () => {
      const agg: AggregatorClient = {
        getInclusionProof: vi.fn(),
      };
      const v = createTokenValidator({ aggregatorClient: agg });
      const { spentTokens, errors } = await v.checkSpentTokens(
        [fakeToken({ id: 't1' })],
        '02aa',
      );
      expect(spentTokens).toEqual([]);
      expect(errors).toEqual([]);
      expect(agg.getInclusionProof).not.toHaveBeenCalled();
    });
  });

  describe('setter methods (API-shape preservation)', () => {
    it('setAggregatorClient / setTrustBase are chainable no-ops (do not throw)', () => {
      const v = new TokenValidator();
      const agg: AggregatorClient = { getInclusionProof: vi.fn() };
      expect(() => v.setAggregatorClient(agg)).not.toThrow();
      expect(() => v.setTrustBase({ trust: 'stub' })).not.toThrow();
    });
  });
});
