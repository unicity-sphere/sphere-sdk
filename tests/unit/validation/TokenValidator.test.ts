/**
 * TokenValidator — engine-based (B5).
 *
 * The validator is a thin wrapper over ITokenEngine: structural validity via
 * engine.verify, spent-status via engine.isSpent (with a per-state TTL cache).
 * It operates on SphereToken; the v1 TXF/RequestId/aggregator path is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenValidator, createTokenValidator } from '../../../validation/token-validator';
import { createMockTokenEngine } from '../support/mock-token-engine';
import type { SphereToken } from '../../../token-engine';

/** A SphereToken with a distinct CBOR body so its per-state cache id is distinct. */
function tok(id: number): SphereToken {
  return {
    sdkToken: {} as SphereToken['sdkToken'],
    blob: { v: 1, network: 2, tokenId: id.toString(16).padStart(64, '0'), token: new Uint8Array([id]) },
    value: { assets: [] },
  };
}

describe('TokenValidator (engine-based)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('validateToken / validateAllTokens', () => {
    it('valid when engine.verify is ok', async () => {
      const v = createTokenValidator(createMockTokenEngine({ verify: vi.fn(async () => ({ ok: true })) }));
      expect(await v.validateToken(tok(1))).toEqual({ isValid: true });
    });

    it('invalid (with reason) when engine.verify is not ok', async () => {
      const v = createTokenValidator(createMockTokenEngine({ verify: vi.fn(async () => ({ ok: false, reason: 'bad sig' })) }));
      expect(await v.validateToken(tok(1))).toEqual({ isValid: false, reason: 'bad sig' });
    });

    it('partitions valid/invalid across a batch and reports progress', async () => {
      const verify = vi.fn(async (t: SphereToken) => ({ ok: t.blob.token[0] % 2 === 1, reason: 'nope' }));
      const v = createTokenValidator(createMockTokenEngine({ verify }));
      const progress: number[] = [];
      const r = await v.validateAllTokens([tok(1), tok(2), tok(3)], {
        batchSize: 2,
        onProgress: (completed) => progress.push(completed),
      });
      expect(r.validTokens).toHaveLength(2);
      expect(r.issues).toHaveLength(1);
      expect(progress[progress.length - 1]).toBe(3);
    });
  });

  describe('isSpent + cache', () => {
    it('routes to engine.isSpent', async () => {
      const v = createTokenValidator(createMockTokenEngine({ isSpent: vi.fn(async () => true) }));
      expect(await v.isSpent(tok(1))).toBe(true);
    });

    it('caches SPENT permanently (engine queried once)', async () => {
      const isSpent = vi.fn(async () => true);
      const v = createTokenValidator(createMockTokenEngine({ isSpent }));
      await v.isSpent(tok(1));
      await v.isSpent(tok(1));
      expect(isSpent).toHaveBeenCalledTimes(1);
    });

    it('caches UNSPENT with a TTL and re-queries after expiry', async () => {
      vi.useFakeTimers();
      const isSpent = vi.fn(async () => false);
      const v = createTokenValidator(createMockTokenEngine({ isSpent }));
      await v.isSpent(tok(1));
      await v.isSpent(tok(1));
      expect(isSpent).toHaveBeenCalledTimes(1); // within TTL → cached
      vi.advanceTimersByTime(6 * 60 * 1000); // past the 5-min TTL
      await v.isSpent(tok(1));
      expect(isSpent).toHaveBeenCalledTimes(2); // re-queried
      vi.useRealTimers();
    });

    it('uses distinct cache keys for distinct token states', async () => {
      const isSpent = vi.fn(async () => true);
      const v = createTokenValidator(createMockTokenEngine({ isSpent }));
      await v.isSpent(tok(1));
      await v.isSpent(tok(2));
      expect(isSpent).toHaveBeenCalledTimes(2);
    });

    it('clearSpentStateCache forces a re-query', async () => {
      const isSpent = vi.fn(async () => true);
      const v = createTokenValidator(createMockTokenEngine({ isSpent }));
      await v.isSpent(tok(1));
      v.clearSpentStateCache();
      await v.isSpent(tok(1));
      expect(isSpent).toHaveBeenCalledTimes(2);
    });

    it('treats an engine error as unspent (graceful)', async () => {
      const v = createTokenValidator(createMockTokenEngine({ isSpent: vi.fn(async () => { throw new Error('net'); }) }));
      expect(await v.isSpent(tok(1))).toBe(false);
    });
  });

  describe('checkSpentTokens', () => {
    it('returns the spent tokens (by per-state id)', async () => {
      const isSpent = vi.fn(async (t: SphereToken) => t.blob.token[0] === 2);
      const v = createTokenValidator(createMockTokenEngine({ isSpent }));
      const r = await v.checkSpentTokens([tok(1), tok(2), tok(3)]);
      expect(r.spentTokens).toHaveLength(1);
      expect(r.errors).toHaveLength(0);
      expect(r.spentTokens[0].stateId).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('createTokenValidator returns a TokenValidator', () => {
    expect(createTokenValidator(createMockTokenEngine())).toBeInstanceOf(TokenValidator);
  });
});
