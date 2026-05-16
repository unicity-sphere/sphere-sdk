/**
 * Wave 3 / steelman regression: `UnicityAggregatorProvider.isSpent` must
 * NOT fail-open on RPC failure.
 *
 * The previous implementation logged a warning and returned `false`
 * ("assuming unspent") when the JSON-RPC call to the aggregator failed.
 * That opened a double-spend window: a network-partitioned aggregator
 * or a relay-MitM dropping the `isSpent` request would cause the
 * recipient to treat an unverifiable state as confirmed-unspent, accept
 * the proof, and credit the (potentially already-spent) token.
 *
 * The fixed contract:
 *   - `isSpent` returns `true`  IFF the aggregator confirmed spent.
 *   - `isSpent` returns `false` IFF the aggregator confirmed unspent.
 *   - `isSpent` THROWS a `SphereError` (`AGGREGATOR_ERROR`) on any
 *     RPC / network failure. It NEVER returns `false` on failure.
 *
 * Callers in the disposition-engine wrap the call in try/catch and
 * route throws to STRUCTURAL_INVALID per §5.3 [A], so the retry loop
 * remains intact; only the silent fail-open is removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';
import { SphereError } from '../../../core/errors';

function makeOkFetch(spent: boolean): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ result: { spent } }),
  })) as unknown as typeof fetch;
}

function makeRpcErrorFetch(): typeof fetch {
  // Aggregator responds 200 OK but the JSON-RPC envelope carries an error.
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: null,
      error: { code: -32603, message: 'internal error' },
    }),
  })) as unknown as typeof fetch;
}

function makeNetworkErrorFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
}

function makeProvider(): UnicityAggregatorProvider {
  const provider = new UnicityAggregatorProvider({
    url: 'https://test.example/',
    timeout: 1000,
    skipVerification: true,
  });
  // Skip the connect handshake; we're testing isSpent in isolation.
  (provider as unknown as { status: string }).status = 'connected';
  return provider;
}

describe('UnicityAggregatorProvider.isSpent — Wave 3 fail-CLOSED contract', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns true when aggregator confirms spent', async () => {
    global.fetch = makeOkFetch(true);
    const provider = makeProvider();
    await expect(provider.isSpent('state-hash-spent')).resolves.toBe(true);
  });

  it('returns false when aggregator confirms unspent', async () => {
    global.fetch = makeOkFetch(false);
    const provider = makeProvider();
    await expect(provider.isSpent('state-hash-unspent')).resolves.toBe(false);
  });

  it('throws (NOT returns false) on JSON-RPC error envelope', async () => {
    // Regression: previously the rpcCall layer threw, the catch block
    // swallowed the throw, and isSpent returned false ("assuming
    // unspent"). The fix propagates the throw.
    global.fetch = makeRpcErrorFetch();
    const provider = makeProvider();

    await expect(provider.isSpent('state-hash-rpc-err')).rejects.toThrow(
      /isSpent.*RPC failed/i,
    );
  });

  it('throws (NOT returns false) on network-layer failure', async () => {
    global.fetch = makeNetworkErrorFetch();
    const provider = makeProvider();

    await expect(provider.isSpent('state-hash-net-err')).rejects.toThrow(
      /isSpent.*RPC failed/i,
    );
  });

  it('throws a SphereError with code AGGREGATOR_ERROR on failure', async () => {
    global.fetch = makeNetworkErrorFetch();
    const provider = makeProvider();

    let caught: unknown;
    try {
      await provider.isSpent('state-hash');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('AGGREGATOR_ERROR');
  });

  it('does NOT cache the failure — next call retries the RPC', async () => {
    // First call fails, second call succeeds: isSpent must NOT have
    // memoized the failure as "unspent" (which would silently
    // swallow recovery).
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        json: async () => ({ result: { spent: true } }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(provider.isSpent('state-hash-recovers')).rejects.toThrow();
    // Recovery: the cache did NOT pin the prior failure.
    await expect(provider.isSpent('state-hash-recovers')).resolves.toBe(true);
  });

  it('still caches confirmed-spent results (immutable answer)', async () => {
    // Caching contract is unchanged for the success path.
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ result: { spent: true } }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(provider.isSpent('state-hash-cached')).resolves.toBe(true);
    await expect(provider.isSpent('state-hash-cached')).resolves.toBe(true);
    expect(callCount).toBe(1); // second call hit the cache
  });

  it('does NOT cache confirmed-unspent (caller can verify next call hits RPC)', async () => {
    // Unspent answer is mutable (the owner can spend at any moment),
    // so the caller MUST be able to re-verify on the next call.
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ result: { spent: false } }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(provider.isSpent('state-hash-unspent')).resolves.toBe(false);
    await expect(provider.isSpent('state-hash-unspent')).resolves.toBe(false);
    expect(callCount).toBe(2); // both calls hit RPC
  });
});
