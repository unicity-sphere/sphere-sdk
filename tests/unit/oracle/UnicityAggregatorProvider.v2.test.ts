/**
 * UnicityAggregatorProvider — Phase 6 v2 slim wrapper coverage.
 *
 * Wave 6-P2-4a shrank the aggregator provider to a JSON-RPC facade over the
 * v2 `AggregatorClient` + `StateTransitionClient`. This suite covers the
 * public surface that the wave-6-P2-5 quarantine left with zero coverage:
 *
 *   - Construction + `initialize({ trustBase })`  → wires up SDK clients.
 *   - Connection lifecycle (`connect`/`disconnect`/`getStatus`).
 *   - `getTrustBase()` / `getRootTrustBase()` / `getAggregatorClient()` /
 *     `getStateTransitionClient()` accessor shapes.
 *   - `getCurrentRound()` — happy path + defensive throw when uninitialized.
 *   - `isSpent()` — RPC probe with canonical + legacy proof shapes; throws on
 *     RPC failure (fail-closed for double-spend safety).
 *   - `validateToken()` — accepts a plain object or JSON string, surfaces
 *     `valid` / `spent` / `stateHash`, catches errors into a result object.
 *   - `getProof()` — shape-validates the aggregator response; rejects
 *     malformed proofs by returning `null`.
 *   - `mint()` — captures fetch failures into a result object.
 *
 * Network access is mocked at the module boundary — `fetch` is stubbed and
 * the SDK `AggregatorClient` / `StateTransitionClient` are replaced with
 * minimal shells sufficient to satisfy the wave-6-P2-4a call sites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// SDK module mock — token-engine/sdk.ts is the only sanctioned SDK import
// site. UnicityAggregatorProvider constructs an `AggregatorClient` and a
// `StateTransitionClient` from it in `initialize()`, and reads
// `getLatestBlockNumber()` off the aggregator client in `getCurrentRound`.
vi.mock('../../../token-engine/sdk', () => {
  class AggregatorClient {
    getLatestBlockNumber = vi.fn().mockResolvedValue(42n);
  }
  class StateTransitionClient {
    constructor(public readonly aggregator: unknown) {}
  }
  class RootTrustBase {
    static fromJSON(json: unknown): RootTrustBase {
      return new RootTrustBase(json);
    }
    constructor(public readonly source: unknown) {}
  }
  return { AggregatorClient, StateTransitionClient, RootTrustBase };
});

import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';

// ---------------------------------------------------------------------------
// Fetch stub helpers
// ---------------------------------------------------------------------------

type RpcHandler = (method: string, params: unknown) => unknown;

function mockRpc(handler: RpcHandler): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const result = handler(body.method, body.params);
      if (result instanceof Error) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ jsonrpc: '2.0', id: body.id, error: { message: result.message } }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
      };
    }),
  );
}

function mockRpcHttpError(status = 500, statusText = 'Internal Server Error'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status,
      statusText,
      json: async () => ({}),
    })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnicityAggregatorProvider (v2 slim)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('construction + accessors', () => {
    it('accepts a minimal config and exposes stable metadata', () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      expect(p.id).toBe('unicity-aggregator');
      expect(p.name).toBe('Unicity Aggregator');
      expect(p.type).toBe('network');
      expect(typeof p.description).toBe('string');
      expect(p.getStatus()).toBe('disconnected');
      expect(p.isConnected()).toBe(false);
      // Nothing is wired up until initialize() runs.
      expect(p.getAggregatorClient()).toBeNull();
      expect(p.getStateTransitionClient()).toBeNull();
      expect(p.getTrustBase()).toBeNull();
      expect(p.getRootTrustBase()).toBeNull();
    });
  });

  describe('initialize()', () => {
    it('wires up aggregator + state transition clients and marks connected', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({ some: 'trust-base' });
      expect(p.getAggregatorClient()).not.toBeNull();
      expect(p.getStateTransitionClient()).not.toBeNull();
      expect(p.getTrustBase()).not.toBeNull();
      // getRootTrustBase() is a canonical alias.
      expect(p.getRootTrustBase()).toBe(p.getTrustBase());
      expect(p.isConnected()).toBe(true);
      expect(p.getStatus()).toBe('connected');
    });

    it('emits oracle:connected event on connect', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      const events: string[] = [];
      p.onEvent((e) => events.push(e.type));
      await p.initialize({});
      expect(events).toContain('oracle:connected');
    });

    it('skipVerification=true + no trust base still connects', async () => {
      const p = new UnicityAggregatorProvider({
        url: 'https://aggregator.example',
        skipVerification: true,
      });
      await p.initialize();
      expect(p.isConnected()).toBe(true);
      expect(p.getTrustBase()).toBeNull();
    });

    it('propagates trust-base loader errors as SphereError (fail-loud)', async () => {
      const p = new UnicityAggregatorProvider({
        url: 'https://aggregator.example',
        trustBaseLoader: {
          load: vi.fn().mockRejectedValue(new Error('load blew up')),
        },
      });
      await expect(p.initialize()).rejects.toThrow(/load blew up|Failed to load trust base/);
    });
  });

  describe('getCurrentRound()', () => {
    it('returns the aggregator client latest block number as a number', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      const round = await p.getCurrentRound();
      expect(round).toBe(42);
    });

    it('throws when called before initialize() so pingers classify wallet as down', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await expect(p.getCurrentRound()).rejects.toThrow(/not initialized/);
    });
  });

  describe('isSpent()', () => {
    it('returns true when the aggregator returns a canonical inclusionProof with transactionHash', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      mockRpc(() => ({ inclusionProof: { transactionHash: '0xabc' } }));
      const spent = await p.isSpent('02' + 'a'.repeat(64), '0000' + 'b'.repeat(64));
      expect(spent).toBe(true);
    });

    it('returns true when the aggregator returns a legacy proof shape', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      mockRpc(() => ({ proof: { transactionHash: 'deadbeef' } }));
      const spent = await p.isSpent('02' + 'a'.repeat(64), '0000' + 'b'.repeat(64));
      expect(spent).toBe(true);
    });

    it('returns false when the aggregator returns no proof', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      mockRpc(() => ({}));
      const spent = await p.isSpent('02' + 'a'.repeat(64), '0000' + 'b'.repeat(64));
      expect(spent).toBe(false);
    });

    it('throws SphereError(AGGREGATOR_ERROR) on HTTP failure — refuses fail-open', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      mockRpcHttpError();
      await expect(
        p.isSpent('02' + 'a'.repeat(64), '0000' + 'b'.repeat(64)),
      ).rejects.toThrow(/aggregator RPC failed|AGGREGATOR_ERROR|HTTP/);
    });

    it('caches spent==true probes keyed on (pubkey, stateHash)', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      let calls = 0;
      mockRpc(() => {
        calls++;
        return { inclusionProof: { transactionHash: 'aa' } };
      });
      const pk = '02' + 'a'.repeat(64);
      const sh = '0000' + 'b'.repeat(64);
      expect(await p.isSpent(pk, sh)).toBe(true);
      expect(await p.isSpent(pk, sh)).toBe(true);
      expect(calls).toBe(1);
    });
  });

  describe('validateToken()', () => {
    let p: UnicityAggregatorProvider;
    beforeEach(async () => {
      p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
    });

    it('accepts parsed object token data and surfaces {valid, spent}', async () => {
      mockRpc(() => ({ valid: true, spent: false, stateHash: 'abcd' }));
      const result = await p.validateToken({ id: 'token-1' });
      expect(result.valid).toBe(true);
      expect(result.spent).toBe(false);
      expect(result.stateHash).toBe('abcd');
    });

    it('accepts a JSON string as tokenData (v1 sdkData path)', async () => {
      mockRpc(() => ({ valid: true, spent: false }));
      const result = await p.validateToken(JSON.stringify({ id: 'token-1' }));
      expect(result.valid).toBe(true);
    });

    it('flags invalid tokens (valid=false) without throwing', async () => {
      mockRpc(() => ({ valid: false, error: 'bad predicate' }));
      const result = await p.validateToken({ id: 'token-2' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('bad predicate');
    });

    it('captures fetch failures into ValidationResult (does not throw)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
      const result = await p.validateToken({ id: 'token-3' });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/offline/);
    });
  });

  describe('getProof() shape validation', () => {
    let p: UnicityAggregatorProvider;
    beforeEach(async () => {
      p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
    });

    it('returns null when the aggregator omits every canonical proof field', async () => {
      mockRpc(() => ({ inclusionProof: { transactionHash: '0xabc' } }));
      // Missing authenticator/merkleTreePath/unicityCertificate.
      const result = await p.getProof('req-1');
      expect(result).toBeNull();
    });

    it('returns a well-formed InclusionProof when all canonical fields are present', async () => {
      mockRpc(() => ({
        inclusionProof: {
          authenticator: { sig: 'x' },
          merkleTreePath: { steps: [] },
          transactionHash: '0xabc',
          unicityCertificate: { cert: 'y' },
        },
        roundNumber: 7,
      }));
      const result = await p.getProof('req-2');
      expect(result).not.toBeNull();
      expect(result!.requestId).toBe('req-2');
      expect(result!.roundNumber).toBe(7);
    });

    it('returns null when aggregator returns an array in place of proof', async () => {
      mockRpc(() => ({ inclusionProof: ['not', 'an', 'object'] }));
      const result = await p.getProof('req-3');
      expect(result).toBeNull();
    });
  });

  describe('mint() error surface', () => {
    it('captures fetch failures into {success:false, error} rather than throwing', async () => {
      const p = new UnicityAggregatorProvider({ url: 'https://aggregator.example' });
      await p.initialize({});
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('rpc-down')));
      const result = await p.mint({
        coinId: 'UCT',
        amount: '1',
        recipientAddress: 'DIRECT://a',
        recipientPubkey: '02aa',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/rpc-down/);
    });
  });
});
