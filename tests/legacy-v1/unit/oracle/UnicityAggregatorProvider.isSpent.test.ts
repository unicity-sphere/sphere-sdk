/**
 * `UnicityAggregatorProvider.isSpent` contract (Issue #243 + Wave 3).
 *
 * The canonical aggregator (`aggregator-go`) has no `isSpent` JSON-RPC
 * method. It indexes commitments by `requestId = SHA256(publicKey ||
 * stateHash)` and exposes only `submit_commitment`,
 * `get_inclusion_proof`, `get_no_deletion_proof`, `get_block_height`.
 *
 * The historical implementation hand-rolled a `{method: 'isSpent',
 * params: {stateHash}}` JSON-RPC request which the server rejected with
 * HTTP 400 at request-validation time ("must include either requestId
 * or shardId"). The `SpentStateRescanWorker` saw every probe throw,
 * bumped per-token throw counters, and produced log spam that blocked
 * `manual-test-full-recovery.sh` at §C.2 (Issue #243).
 *
 * The fixed contract:
 *   - Signature is `isSpent(publicKey, stateHash)` — both hex strings.
 *   - Implementation derives `requestId` from those two inputs and
 *     calls `get_inclusion_proof(requestId)`.
 *   - Returns `true`  IFF the proof has `transactionHash !== null`
 *     (path-included → a commit for this requestId landed → spent).
 *   - Returns `false` IFF the proof has `transactionHash === null`
 *     (path-non-inclusion proof → no commit exists → unspent).
 *   - THROWS a `SphereError` (`AGGREGATOR_ERROR`) on any RPC / network
 *     failure. NEVER returns `false` on failure — that would re-open
 *     the Wave 3 double-spend window (a network-partitioned aggregator
 *     or relay-MitM dropping the request would let the recipient
 *     accept an already-spent state as confirmed-unspent).
 *
 * Callers in the disposition-engine wrap the call in try/catch and
 * route throws to STRUCTURAL_INVALID per §5.3 [A], so the retry loop
 * remains intact; only the silent fail-open is removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';
import { SphereError } from '../../../core/errors';

// Valid hex inputs for the new (publicKey, stateHash) signature. The
// pubkey is a 33-byte compressed secp256k1 key (66 hex chars). The
// stateHash is a 34-byte imprint — algorithm prefix (2 bytes) plus
// the 32-byte digest — encoded as 68 hex chars, matching the SDK's
// `DataHash.fromJSON` expectation.
const TEST_PUBKEY = '02' + 'a'.repeat(64);
const TEST_STATEHASH_A = '0000' + 'a'.repeat(64);
const TEST_STATEHASH_B = '0000' + 'b'.repeat(64);

function makeProofFetch(spent: boolean): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        inclusionProof: {
          transactionHash: spent ? 'aa'.repeat(32) : null,
          authenticator: {},
          merkleTreePath: { root: '', steps: [] },
          unicityCertificate: '',
        },
        roundNumber: 1,
      },
    }),
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

function makeHttp400Fetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => ({
      error: 'JSON-RPC requests must include either requestId or shardId',
    }),
  })) as unknown as typeof fetch;
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

describe('UnicityAggregatorProvider.isSpent — Issue #243 + Wave 3 fail-CLOSED contract', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns true when inclusion proof carries a non-null transactionHash', async () => {
    global.fetch = makeProofFetch(true);
    const provider = makeProvider();
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(true);
  });

  it('returns false when inclusion proof carries transactionHash:null (path-non-inclusion)', async () => {
    global.fetch = makeProofFetch(false);
    const provider = makeProvider();
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(false);
  });

  it('throws (NOT returns false) on JSON-RPC error envelope', async () => {
    // Regression: previously the rpcCall layer threw, the catch block
    // swallowed the throw, and isSpent returned false ("assuming
    // unspent"). The fix propagates the throw.
    global.fetch = makeRpcErrorFetch();
    const provider = makeProvider();

    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).rejects.toThrow(/isSpent.*RPC failed/i);
  });

  it('throws (NOT returns false) on network-layer failure', async () => {
    global.fetch = makeNetworkErrorFetch();
    const provider = makeProvider();

    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).rejects.toThrow(/isSpent.*RPC failed/i);
  });

  it('throws (NOT returns false) on HTTP 400 — the Issue #243 baseline failure mode', async () => {
    // The exact failure mode that motivated this fix: the canonical
    // aggregator rejects unknown methods / missing requestId with an
    // HTTP 400 at the request-validation layer. The new
    // implementation no longer triggers this (it sends a valid
    // requestId), but a misbehaving custom aggregator could still
    // return 400 — we MUST throw, never silently return false.
    global.fetch = makeHttp400Fetch();
    const provider = makeProvider();

    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).rejects.toThrow(/isSpent.*RPC failed/i);
  });

  it('throws a SphereError with code AGGREGATOR_ERROR on RPC failure', async () => {
    global.fetch = makeNetworkErrorFetch();
    const provider = makeProvider();

    let caught: unknown;
    try {
      await provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('AGGREGATOR_ERROR');
  });

  it('throws AGGREGATOR_ERROR when publicKey is malformed (caller-bug surface)', async () => {
    // Bad-hex pubkey can never produce a valid requestId. Surface
    // structurally so the disposition-engine's catch routes it
    // through the same fail-closed path.
    global.fetch = makeProofFetch(false);
    const provider = makeProvider();

    let caught: unknown;
    try {
      await provider.isSpent('not-hex!', TEST_STATEHASH_A);
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
        json: async () => ({
          result: {
            inclusionProof: {
              transactionHash: 'aa'.repeat(32),
              authenticator: {},
              merkleTreePath: { root: '', steps: [] },
              unicityCertificate: '',
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).rejects.toThrow();
    // Recovery: the cache did NOT pin the prior failure.
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(true);
  });

  it('still caches confirmed-spent results (immutable answer)', async () => {
    // Caching contract is unchanged for the success path.
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          result: {
            inclusionProof: {
              transactionHash: 'aa'.repeat(32),
              authenticator: {},
              merkleTreePath: { root: '', steps: [] },
              unicityCertificate: '',
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(true);
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(true);
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
        json: async () => ({
          result: {
            inclusionProof: {
              transactionHash: null,
              authenticator: {},
              merkleTreePath: { root: '', steps: [] },
              unicityCertificate: '',
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(false);
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(false);
    expect(callCount).toBe(2); // both calls hit RPC
  });

  it('cache key binds (publicKey, stateHash) — different pubkeys do not collide', async () => {
    // Multi-address wallets may probe the same stateHash under
    // different pubkeys. A naive cache keyed only on stateHash
    // would cross-pollinate results (a "spent" answer for one
    // pubkey would silently apply to another, hiding genuine
    // unspent state). Verify the new cache key prevents this.
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          result: {
            inclusionProof: {
              transactionHash: 'aa'.repeat(32),
              authenticator: {},
              merkleTreePath: { root: '', steps: [] },
              unicityCertificate: '',
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    const otherPubkey = '03' + 'c'.repeat(64);
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(true);
    await expect(
      provider.isSpent(otherPubkey, TEST_STATEHASH_A),
    ).resolves.toBe(true);
    expect(callCount).toBe(2); // separate cache keys, both hit RPC
  });

  it('returns false when the aggregator response omits both inclusionProof and proof', async () => {
    // Defense in depth: an ambiguous response (no proof field at all)
    // is treated as "no proof yet" / unspent rather than throwing.
    // This matches the legacy isSpent's tolerant default but
    // preserves the fail-closed throw contract for transport errors.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: {} }),
    })) as unknown as typeof fetch;

    const provider = makeProvider();
    await expect(
      provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_A),
    ).resolves.toBe(false);
  });

  it('uses the canonical get_inclusion_proof method, not the broken isSpent RPC', async () => {
    // Issue #243 regression: ensure the wire request targets
    // `get_inclusion_proof` with a `requestId` param, not the
    // non-existent `isSpent` method with a bare `stateHash`.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          inclusionProof: {
            transactionHash: null,
            authenticator: {},
            merkleTreePath: { root: '', steps: [] },
            unicityCertificate: '',
          },
        },
      }),
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    const provider = makeProvider();
    await provider.isSpent(TEST_PUBKEY, TEST_STATEHASH_B);

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: { requestId?: string; stateHash?: string };
    };
    expect(body.method).toBe('get_inclusion_proof');
    expect(body.params.requestId).toBeDefined();
    expect(body.params.stateHash).toBeUndefined();
    // Sanity: the requestId is a hex string (typically 68 chars for sha2-256).
    expect(body.params.requestId).toMatch(/^[0-9a-f]+$/);
  });
});
