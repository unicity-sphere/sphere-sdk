/**
 * Unit tests for `verifyPayoutTokens` (issue #535).
 *
 * The function replaces `SwapModule.verifyPayout`'s prior wallet-wide
 * `payments.validate()` sweep with three checks scoped to the specific
 * payout tokens: finalization → SdkToken.verify(trustBase) →
 * oracle.isSpent. See `modules/swap/payout-verifier.ts` for the full
 * design rationale.
 *
 * Result discrimination under test
 * --------------------------------
 *   - `ok`        — happy path: all tokens pass all three checks.
 *   - `transient` — caller retries on next verify tick. Reasons covered:
 *                   reverse-index empty, trustBase missing, token absent,
 *                   sdkData missing, not finalized.
 *   - `terminal`  — caller fails the swap. Reasons covered: sdkData
 *                   unparseable, fromJSON throw, verify throw,
 *                   isSuccessful=false, already-spent.
 *
 * SDK isolation
 * -------------
 * `SdkToken.fromJSON` is spied per-test so we never touch real crypto.
 * The state-transition-sdk is exercised end-to-end in integration tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { verifyPayoutTokens } from '../../../../modules/swap/payout-verifier';
import type { Token } from '../../../../types';

const STATE_HASH_HEX = 'stub-state-hash';
const FALLBACK_PUBKEY = '02' + 'f'.repeat(64);

const TRUST_BASE = { __mock: 'trust-base' };

function makeFinalizedSdkData(): string {
  // Minimal shape that satisfies the finalization check (last tx — or
  // genesis when transactions is empty — must have inclusionProof != null).
  return JSON.stringify({
    state: { predicate: 'stub-predicate' },
    genesis: { inclusionProof: { __mock_proof: 1 } },
    transactions: [],
    nametags: [],
  });
}

function makeUnfinalizedSdkData(): string {
  return JSON.stringify({
    state: { predicate: 'stub-predicate' },
    genesis: { inclusionProof: null },
    transactions: [],
    nametags: [],
  });
}

function makeStubToken(id: string, sdkData: string | undefined = makeFinalizedSdkData()): Token {
  return {
    id,
    coinId: 'USDU',
    symbol: 'USDU',
    name: 'USDU',
    decimals: 6,
    amount: '500000',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData,
  };
}

function stubSdkVerifySuccess(): void {
  vi.spyOn(SdkToken, 'fromJSON').mockImplementation(async (_input: unknown) => {
    return {
      verify: async () => ({ isSuccessful: true }),
      state: {
        calculateHash: async () => ({ toJSON: () => STATE_HASH_HEX }),
        predicate: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
}

function stubSdkVerifyFailed(): void {
  vi.spyOn(SdkToken, 'fromJSON').mockImplementation(async (_input: unknown) => {
    return {
      verify: async () => ({ isSuccessful: false }),
      state: {
        calculateHash: async () => ({ toJSON: () => STATE_HASH_HEX }),
        predicate: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
}

function stubSdkFromJsonThrows(): void {
  vi.spyOn(SdkToken, 'fromJSON').mockImplementation(async (_input: unknown) => {
    throw new Error('mock fromJSON failure');
  });
}

function stubSdkVerifyThrows(): void {
  vi.spyOn(SdkToken, 'fromJSON').mockImplementation(async (_input: unknown) => {
    return {
      verify: async () => {
        throw new Error('mock verify failure');
      },
      state: {
        calculateHash: async () => ({ toJSON: () => STATE_HASH_HEX }),
        predicate: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });
}

describe('verifyPayoutTokens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // ok / happy path
  // -------------------------------------------------------------------------

  describe('ok', () => {
    it('returns ok when a single token passes all three checks', async () => {
      stubSdkVerifySuccess();
      const tok = makeStubToken('tok-1');
      const isSpent = vi.fn().mockResolvedValue(false);
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: (id) => (id === 'tok-1' ? tok : undefined),
        trustBase: TRUST_BASE,
        isSpent,
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('ok');
      // isSpent must be called once per token with the predicate pubkey
      // (or fallback when extraction fails on a stub-predicate shape).
      expect(isSpent).toHaveBeenCalledTimes(1);
      const [pk, sh] = isSpent.mock.calls[0]!;
      expect(typeof pk).toBe('string');
      expect(pk.length).toBeGreaterThan(0);
      expect(sh).toBe(STATE_HASH_HEX);
    });

    it('returns ok when every token in a multi-token set passes', async () => {
      stubSdkVerifySuccess();
      const tok1 = makeStubToken('tok-1');
      const tok2 = makeStubToken('tok-2');
      const isSpent = vi.fn().mockResolvedValue(false);
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1', 'tok-2']),
        getToken: (id) => ({ 'tok-1': tok1, 'tok-2': tok2 }[id]),
        trustBase: TRUST_BASE,
        isSpent,
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('ok');
      expect(isSpent).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // transient — caller should returnFalse and retry
  // -------------------------------------------------------------------------

  describe('transient', () => {
    it('returns transient when payoutTokenIds is empty (reverse-index not rebuilt)', async () => {
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(),
        getToken: () => undefined,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('transient');
      expect((result as { reason: string }).reason).toContain('reverse-index-empty');
    });

    it('returns transient when trustBase is null (oracle not initialized)', async () => {
      const tok = makeStubToken('tok-1');
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: null,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('transient');
      expect((result as { reason: string }).reason).toContain('trustbase-not-loaded');
    });

    it('returns transient when getToken returns undefined for a token in the set', async () => {
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['missing-token']),
        getToken: () => undefined,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('transient');
      expect((result as { reason: string }).reason).toContain('token-not-in-wallet');
    });

    it('returns transient when token sdkData is missing', async () => {
      // Construct the Token literal directly — `makeStubToken('tok-1', undefined)`
      // would substitute the default param value, not propagate undefined.
      const tok: Token = {
        id: 'tok-1',
        coinId: 'USDU',
        symbol: 'USDU',
        name: 'USDU',
        decimals: 6,
        amount: '500000',
        status: 'confirmed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // sdkData intentionally omitted (undefined).
      };
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('transient');
      expect((result as { reason: string }).reason).toContain('missing-sdkdata');
    });

    it('returns transient when the last transaction has no inclusion proof (not finalized)', async () => {
      const tok = makeStubToken('tok-1', makeUnfinalizedSdkData());
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('transient');
      expect((result as { reason: string }).reason).toContain('not-finalized');
    });
  });

  // -------------------------------------------------------------------------
  // terminal — caller should failPayout
  // -------------------------------------------------------------------------

  describe('terminal', () => {
    it('returns terminal when sdkData is unparseable JSON', async () => {
      const tok = makeStubToken('tok-1', 'not-valid-json{{{');
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('terminal');
      expect((result as { reason: string }).reason).toContain('SDKDATA_UNPARSEABLE');
    });

    it('returns terminal when SdkToken.fromJSON throws', async () => {
      stubSdkFromJsonThrows();
      const tok = makeStubToken('tok-1');
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('terminal');
      expect((result as { reason: string }).reason).toContain('PARSE_FAILED');
    });

    it('returns terminal when verify() throws', async () => {
      stubSdkVerifyThrows();
      const tok = makeStubToken('tok-1');
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('terminal');
      expect((result as { reason: string }).reason).toContain('VERIFY_THREW');
    });

    it('returns terminal when verify().isSuccessful is false', async () => {
      stubSdkVerifyFailed();
      const tok = makeStubToken('tok-1');
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent: vi.fn(),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('terminal');
      expect((result as { reason: string }).reason).toContain('VERIFY_FAILED');
    });

    it('returns terminal when oracle.isSpent returns true', async () => {
      stubSdkVerifySuccess();
      const tok = makeStubToken('tok-1');
      const isSpent = vi.fn().mockResolvedValue(true);
      const result = await verifyPayoutTokens({
        payoutTokenIds: new Set(['tok-1']),
        getToken: () => tok,
        trustBase: TRUST_BASE,
        isSpent,
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('terminal');
      expect((result as { reason: string }).reason).toContain('ALREADY_SPENT');
    });
  });

  // -------------------------------------------------------------------------
  // Spent-check propagation — OracleProvider.isSpent contract says
  // "MUST NOT fail-open"; RPC failure throws out of the verifier, which
  // the SwapModule caller's auto-verify catch logs and retries.
  // -------------------------------------------------------------------------

  describe('isSpent RPC failure', () => {
    it('propagates oracle.isSpent throw (does NOT silently route to terminal/transient)', async () => {
      stubSdkVerifySuccess();
      const tok = makeStubToken('tok-1');
      const rpcError = new Error('AGGREGATOR_ERROR: timeout');
      await expect(
        verifyPayoutTokens({
          payoutTokenIds: new Set(['tok-1']),
          getToken: () => tok,
          trustBase: TRUST_BASE,
          isSpent: vi.fn().mockRejectedValue(rpcError),
          fallbackPublicKey: FALLBACK_PUBKEY,
        }),
      ).rejects.toThrow('AGGREGATOR_ERROR: timeout');
    });
  });

  // -------------------------------------------------------------------------
  // Short-circuit: terminal-on-first-token must not check subsequent tokens.
  // -------------------------------------------------------------------------

  describe('short-circuit', () => {
    it('stops checking once a terminal failure is found', async () => {
      stubSdkVerifyFailed();
      const tok1 = makeStubToken('tok-1');
      const getToken = vi.fn().mockImplementation((id: string): Token | undefined => {
        if (id === 'tok-1') return tok1;
        // tok-2 would also be defined in a real wallet — but we should never
        // be asked because tok-1's verify fails terminally first.
        return undefined;
      });
      const result = await verifyPayoutTokens({
        // Map iteration order is insertion order — tok-1 first.
        payoutTokenIds: new Set(['tok-1', 'tok-2']),
        getToken,
        trustBase: TRUST_BASE,
        isSpent: vi.fn().mockResolvedValue(false),
        fallbackPublicKey: FALLBACK_PUBKEY,
      });
      expect(result.kind).toBe('terminal');
      // Only one getToken call — tok-2 was not reached.
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledWith('tok-1');
    });
  });
});

