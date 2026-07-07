/**
 * Unit tests asserting that UnicityAggregatorProvider.getProof() and
 * submitCommitment() (non-SDK fallback path) send the correct JSON-RPC
 * method names to the aggregator transport.
 *
 * Regression test for the bug where camelCase method names were used
 * instead of the snake_case names the testnet aggregator requires:
 *   - 'getInclusionProof' → 'get_inclusion_proof'
 *   - 'submitCommitment'  → 'submit_commitment'  (non-SDK fallback only)
 *
 * The canonical method names are defined in:
 *   @unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';

// ─── Mock fetch globally ──────────────────────────────────────────────────────

type FetchCall = { method: string; params: unknown };

function makeMockFetch(responseBody: unknown = { result: {} }) {
  const calls: FetchCall[] = [];
  const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { method: string; params: unknown };
    calls.push({ method: body.method, params: body.params });
    return {
      ok: true,
      json: async () => responseBody,
    };
  });
  return { mockFetch, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UnicityAggregatorProvider — JSON-RPC wire method names', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('getProof()', () => {
    it('sends method "get_inclusion_proof" (snake_case, NOT "getInclusionProof")', async () => {
      const { mockFetch, calls } = makeMockFetch({ result: {} });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      await provider.getProof('test-request-id');

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('get_inclusion_proof');
      // Must NOT be the camelCase name that the aggregator rejects with -32601.
      expect(calls[0].method).not.toBe('getInclusionProof');
    });

    it('includes requestId in params', async () => {
      const { mockFetch, calls } = makeMockFetch({ result: {} });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const testId = 'abc123-request-id';
      await provider.getProof(testId);

      expect(calls).toHaveLength(1);
      expect((calls[0].params as { requestId: string }).requestId).toBe(testId);
    });

    it('returns null when aggregator returns empty result (proof not yet available)', async () => {
      const { mockFetch } = makeMockFetch({ result: {} });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('no-proof-yet');
      expect(result).toBeNull();
    });

    it('returns null (not throw) when aggregator returns JSON-RPC error', async () => {
      // Simulates the old 'getInclusionProof' behaviour: -32601 Method not found.
      const { mockFetch } = makeMockFetch({
        result: null,
        error: { code: -32601, message: 'Method not found' },
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('any-id');
      // getProof swallows errors and returns null so the caller can retry.
      expect(result).toBeNull();
    });
  });

  describe('getProof() — shape validation (steelman #157)', () => {
    // The aggregator can return arbitrary JSON — without shape validation
    // the historical caller treats {inclusionProof: true},
    // {inclusionProof: {}}, {inclusionProof: "string"} as "got a proof".
    // Now: each must be rejected (returns null, logs WARN).
    it('rejects boolean inclusionProof', async () => {
      const { mockFetch } = makeMockFetch({
        result: { inclusionProof: true },
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('any-id');
      expect(result).toBeNull();
    });

    it('rejects string inclusionProof', async () => {
      const { mockFetch } = makeMockFetch({
        result: { inclusionProof: 'cheese' },
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('any-id');
      expect(result).toBeNull();
    });

    it('rejects array inclusionProof', async () => {
      const { mockFetch } = makeMockFetch({
        result: { inclusionProof: [1, 2, 3] },
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('any-id');
      expect(result).toBeNull();
    });

    it('rejects object inclusionProof missing required fields', async () => {
      // Object but lacks authenticator/merkleTreePath/transactionHash/unicityCertificate.
      const { mockFetch } = makeMockFetch({
        result: { inclusionProof: { foo: 'bar' } },
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('any-id');
      expect(result).toBeNull();
    });

    it('rejects object inclusionProof that the SDK fromJSON refuses to parse', async () => {
      // Has all four required keys but the values are nonsense.
      // SdkInclusionProof.fromJSON should throw, getProof should
      // return null (not throw — null lets callers retry).
      const { mockFetch } = makeMockFetch({
        result: {
          inclusionProof: {
            authenticator: null,
            merkleTreePath: 'not a path',
            transactionHash: null,
            unicityCertificate: 'not a cert',
          },
        },
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      const result = await provider.getProof('any-id');
      expect(result).toBeNull();
    });
  });

  describe('submitCommitment() — non-SDK fallback path', () => {
    it('sends method "submit_commitment" (snake_case, NOT "submitCommitment")', async () => {
      const { mockFetch, calls } = makeMockFetch({ result: { requestId: 'rpc-req-1' } });
      global.fetch = mockFetch as unknown as typeof fetch;

      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      (provider as unknown as { status: string }).status = 'connected';

      // Pass a plain (non-SDK) commitment object to force the RPC fallback.
      // isSdkTransferCommitment() returns false when requestId.toString is absent.
      const plainCommitment = {
        sourceToken: 'tok',
        recipient: 'rec',
        salt: new Uint8Array([1, 2, 3]),
        data: null,
      };

      await provider.submitCommitment(plainCommitment as Parameters<typeof provider.submitCommitment>[0]);

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('submit_commitment');
      expect(calls[0].method).not.toBe('submitCommitment');
    });
  });

  describe('getCurrentRound()', () => {
    // Before this fix `getCurrentRound()` returned `0` when
    // `aggregatorClient` was null (the pre-`initialize()` stub path).
    // The AggregatorPinger was using `round > 0` to discriminate that
    // stub case from a real aggregator response — but the stub
    // sentinel collided with legitimate `0` round numbers from fresh
    // shards / between-batch states, producing false-negative
    // "Aggregator service unavailable" banners. The fix throws on
    // the uninitialized path so the pinger routes it to `'down'` and
    // can treat any finite numeric round (including 0) as alive.
    it('throws when aggregator client is not initialized (no initialize() call)', async () => {
      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      // NOTE: deliberately NOT calling initialize() — aggregatorClient is null.
      await expect(provider.getCurrentRound()).rejects.toThrow(/not initialized/);
    });

    it('returns the live block height (as a number) when the aggregator client is wired', async () => {
      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      // Stub `aggregatorClient` directly to avoid the real SDK init path
      // (which would require fetching a trust base from the network).
      const fakeClient = {
        getBlockHeight: vi.fn(async () => 42n),
      };
      (provider as unknown as { aggregatorClient: typeof fakeClient }).aggregatorClient = fakeClient;

      const round = await provider.getCurrentRound();
      expect(round).toBe(42);
      expect(fakeClient.getBlockHeight).toHaveBeenCalledTimes(1);
    });

    it('returns 0 (numeric) when the aggregator reports block height 0 — does NOT swallow the response', async () => {
      // Regression: a fresh shard or between-batch state can return 0
      // from `get_block_height`. The pinger must see this as a real
      // numeric value (and treat it as alive), not as the stub sentinel.
      const provider = new UnicityAggregatorProvider({
        url: 'https://test.example/',
        timeout: 1000,
        skipVerification: true,
      });
      const fakeClient = {
        getBlockHeight: vi.fn(async () => 0n),
      };
      (provider as unknown as { aggregatorClient: typeof fakeClient }).aggregatorClient = fakeClient;

      const round = await provider.getCurrentRound();
      expect(round).toBe(0);
      expect(Number.isFinite(round)).toBe(true);
    });
  });
});
