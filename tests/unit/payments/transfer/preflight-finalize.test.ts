/**
 * Tests for `modules/payments/transfer/preflight-finalize.ts` — UXF
 * conservative-mode source-token preflight finalization (T.2.A).
 *
 * Spec references: §2.2 (conservative full-history finalize), §2.3
 * (chain-mode), §6.1 (aggregator-error → DispositionReason mapping).
 *
 * Coverage:
 *  1. Chain depth 0 (no-op fully-finalized source).
 *  2. Chain depth 1 (single pending tx — submit + poll).
 *  3. Chain depth 3 (topological-order walk).
 *  4. Partial finalization — middle tx already has a proof.
 *  5. Idempotency — aggregator already returns proof for new submit's id.
 *  6. Transient retries — recovers within budget.
 *  7. Transient exhausted — `oracle-rejected`.
 *  8. Hard rejection — REQUEST_ID_MISMATCH → `client-error`.
 *  9. Hard rejection — AUTHENTICATOR_VERIFICATION_FAILED → `belief-divergence`.
 * 10. Race-lost — proof.transactionHash mismatches local.
 * 11. Cascade-failure forensics — failing requestId/step preserved.
 * 12. AbortSignal — caller aborts mid-chain.
 * 13. Progress events — emitted once per processed tx.
 * 14. Resolver throw → `client-error`.
 * 15. mapAggregatorRejection unit table.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  preflightFinalize,
  mapAggregatorRejection,
  type PendingTxDescriptor,
  type PreflightProgressEvent,
} from '../../../../extensions/uxf/pipeline/preflight-finalize';
import { SphereError, isSphereError } from '../../../../core/errors';
import type {
  InclusionProof,
  OracleProvider,
  SubmitResult,
  WaitOptions,
} from '../../../../oracle/oracle-provider';
import type { Token } from '../../../../types';
import type { DispositionReason } from '../../../../extensions/uxf/types/disposition';

// =============================================================================
// 1. Tiny test fixtures
// =============================================================================

/**
 * Build a synthetic source `Token`. The preflight does not interpret the
 * token shape (the chain extraction is dependency-injected), so the
 * fixture is a minimal stub covering only the fields the function reads.
 */
function makeToken(id: string): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '100',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Synthetic pending-tx — purely a marker the extractor passes through
 * to the resolver. The preflight never parses this object.
 */
interface FakePendingTx {
  readonly txHash: string;
  readonly commitment?: object;
}

/**
 * Build an InclusionProof shape that exposes its `transactionHash` as a
 * top-level lowercase-hex string, matching what the production
 * `OracleProvider.getProof` adapter returns to consumers.
 */
function makeProof(txHash: string, requestId = 'req-' + txHash): InclusionProof {
  return {
    requestId,
    roundNumber: 1,
    proof: { foo: 'bar' },
    transactionHash: txHash,
    timestamp: 0,
  } as InclusionProof;
}

/**
 * Inline mock OracleProvider with a programmable per-requestId fixture
 * map. Each entry tells the test rig what to return for the matching
 * call sequence: 'not-found', 'transient', 'success', or hard codes.
 *
 * The mock tracks call counts so tests can assert exactly how many
 * submit and poll round-trips happened.
 */
type ProofFixture =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'success'; readonly txHash: string }
  | { readonly kind: 'transient'; readonly message?: string }
  | { readonly kind: 'reject'; readonly message: string };

interface MockAggregator extends OracleProvider {
  readonly _calls: {
    submit: string[];
    getProof: string[];
  };
  _setProofSequence(requestId: string, sequence: ReadonlyArray<ProofFixture>): void;
  _setSubmitSequence(requestId: string, sequence: ReadonlyArray<ProofFixture>): void;
}

function makeMockAggregator(): MockAggregator {
  const proofSeqs = new Map<string, ProofFixture[]>();
  const submitSeqs = new Map<string, ProofFixture[]>();
  const calls = { submit: [] as string[], getProof: [] as string[] };

  const consume = (
    map: Map<string, ProofFixture[]>,
    requestId: string,
  ): ProofFixture => {
    const seq = map.get(requestId);
    if (!seq || seq.length === 0) return { kind: 'not-found' };
    return seq.length === 1 ? seq[0] : seq.shift()!;
  };

  const baseProvider = {
    id: 'mock',
    name: 'Mock',
    type: 'network',
    description: 'inline mock for preflight-finalize',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
  };

  const provider: MockAggregator = {
    ...baseProvider,
    _calls: calls,
    _setProofSequence(requestId, sequence) {
      proofSeqs.set(requestId, [...sequence]);
    },
    _setSubmitSequence(requestId, sequence) {
      submitSeqs.set(requestId, [...sequence]);
    },
    submitCommitment: vi.fn().mockImplementation(async (commitment: unknown) => {
      // The test injects requestId into the commitment object so we can
      // route per-id submit fixtures deterministically.
      const requestId = (commitment as { requestId?: string }).requestId ?? '';
      calls.submit.push(requestId);
      const fx = consume(submitSeqs, requestId);
      const ts = Date.now();
      switch (fx.kind) {
        case 'success':
          return { success: true, requestId, timestamp: ts } satisfies SubmitResult;
        case 'transient':
          return { success: false, error: fx.message ?? 'network error', timestamp: ts } satisfies SubmitResult;
        case 'reject':
          return { success: false, error: fx.message, timestamp: ts } satisfies SubmitResult;
        case 'not-found':
        default:
          return { success: true, requestId, timestamp: ts } satisfies SubmitResult;
      }
    }),
    getProof: vi.fn().mockImplementation(async (requestId: string) => {
      calls.getProof.push(requestId);
      const fx = consume(proofSeqs, requestId);
      switch (fx.kind) {
        case 'success':
          return makeProof(fx.txHash, requestId);
        case 'transient':
          throw new Error(fx.message ?? 'transient network error');
        case 'reject': {
          // Hard rejection on the poll path — surface as a thrown error
          // string the mapper can recognize.
          const e = new Error(fx.message);
          throw e;
        }
        case 'not-found':
        default:
          return null;
      }
    }),
    waitForProof: vi.fn().mockImplementation(async (_requestId: string, _opts?: WaitOptions) => {
      throw new Error('waitForProof not used by preflight');
    }),
  };
  return provider;
}

/**
 * Resolver that maps `(token, FakePendingTx, index) → PendingTxDescriptor`.
 * The descriptor's commitment carries `requestId` so the mock aggregator
 * can route per-id submit fixtures.
 */
function makeResolver(): (token: Token, tx: unknown) => PendingTxDescriptor {
  return (_token, tx) => {
    const fake = tx as FakePendingTx;
    const requestId = `req-${fake.txHash}`;
    return {
      requestId,
      transactionHash: fake.txHash,
      commitment: { requestId, ...(fake.commitment ?? {}) },
    };
  };
}

// =============================================================================
// 2. Acceptance: chain depth 0 — no-op
// =============================================================================

describe('preflightFinalize — chain depth 0 (fully finalized)', () => {
  it('returns immediately with totalAdvanced=0 when no pending txs', async () => {
    const aggregator = makeMockAggregator();
    const events: PreflightProgressEvent[] = [];
    const tokens = [makeToken('tok-A'), makeToken('tok-B')];

    const result = await preflightFinalize(tokens, {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () => [],
      emit: (e) => events.push(e),
    });

    expect(result.totalAdvanced).toBe(0);
    expect(result.finalizedSources).toEqual(tokens);
    expect(events).toHaveLength(0);
    expect(aggregator._calls.submit).toHaveLength(0);
    expect(aggregator._calls.getProof).toHaveLength(0);
  });
});

// =============================================================================
// 3. Acceptance: chain depth 1
// =============================================================================

describe('preflightFinalize — chain depth 1 (single pending tx)', () => {
  it('submits commitment + polls proof + persists + emits', async () => {
    const aggregator = makeMockAggregator();
    const events: PreflightProgressEvent[] = [];
    const persisted: string[] = [];

    aggregator._setProofSequence('req-tx1', [
      { kind: 'not-found' },        // pre-submit probe
      { kind: 'success', txHash: 'tx1' }, // post-submit poll
    ]);
    aggregator._setSubmitSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);

    const token = makeToken('tok-1');
    const result = await preflightFinalize([token], {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
      emit: (e) => events.push(e),
      persistProof: ({ token: t, descriptor }) => {
        persisted.push(`${t.id}:${descriptor.requestId}`);
      },
      transientRetryDelayMs: 0,
    });

    expect(result.totalAdvanced).toBe(1);
    expect(persisted).toEqual(['tok-1:req-tx1']);
    expect(events).toEqual([
      { tokenId: 'tok-1', chainDepth: 1, currentStep: 1, requestId: 'req-tx1' },
    ]);
    expect(aggregator._calls.submit).toEqual(['req-tx1']);
  });
});

// =============================================================================
// 4. Acceptance: chain depth 3 — topological order
// =============================================================================

describe('preflightFinalize — chain depth 3 (topological-order walk)', () => {
  it('processes all 3 txs in oldest-first order', async () => {
    const aggregator = makeMockAggregator();
    const events: PreflightProgressEvent[] = [];

    for (const tx of ['tx1', 'tx2', 'tx3']) {
      aggregator._setProofSequence(`req-${tx}`, [
        { kind: 'not-found' },
        { kind: 'success', txHash: tx },
      ]);
      aggregator._setSubmitSequence(`req-${tx}`, [{ kind: 'success', txHash: tx }]);
    }

    const token = makeToken('tok-deep');
    const result = await preflightFinalize([token], {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () =>
        [{ txHash: 'tx1' }, { txHash: 'tx2' }, { txHash: 'tx3' }] as FakePendingTx[],
      emit: (e) => events.push(e),
      transientRetryDelayMs: 0,
    });

    expect(result.totalAdvanced).toBe(3);
    expect(events.map((e) => e.requestId)).toEqual(['req-tx1', 'req-tx2', 'req-tx3']);
    expect(events.map((e) => e.currentStep)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.chainDepth === 3)).toBe(true);
    expect(aggregator._calls.submit).toEqual(['req-tx1', 'req-tx2', 'req-tx3']);
  });
});

// =============================================================================
// 5. Partial finalization — middle tx already has proof
// =============================================================================

describe('preflightFinalize — partial finalization', () => {
  it('skips submit for txs whose proof already exists', async () => {
    const aggregator = makeMockAggregator();
    const events: PreflightProgressEvent[] = [];

    // tx1: no proof yet → submit
    aggregator._setProofSequence('req-tx1', [
      { kind: 'not-found' },
      { kind: 'success', txHash: 'tx1' },
    ]);
    aggregator._setSubmitSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);
    // tx2: proof already anchored — pre-submit probe returns it.
    aggregator._setProofSequence('req-tx2', [{ kind: 'success', txHash: 'tx2' }]);
    // tx3: no proof yet → submit
    aggregator._setProofSequence('req-tx3', [
      { kind: 'not-found' },
      { kind: 'success', txHash: 'tx3' },
    ]);
    aggregator._setSubmitSequence('req-tx3', [{ kind: 'success', txHash: 'tx3' }]);

    const result = await preflightFinalize([makeToken('tok-mid')], {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () =>
        [{ txHash: 'tx1' }, { txHash: 'tx2' }, { txHash: 'tx3' }] as FakePendingTx[],
      emit: (e) => events.push(e),
      transientRetryDelayMs: 0,
    });

    expect(result.totalAdvanced).toBe(3);
    // Only tx1 and tx3 should have hit submit; tx2 was attach-only.
    expect(aggregator._calls.submit).toEqual(['req-tx1', 'req-tx3']);
    expect(events.map((e) => e.requestId)).toEqual(['req-tx1', 'req-tx2', 'req-tx3']);
  });
});

// =============================================================================
// 6. Idempotency — pre-submit probe wins
// =============================================================================

describe('preflightFinalize — idempotent re-run (pre-submit probe)', () => {
  it('attaches existing proof without re-submitting', async () => {
    const aggregator = makeMockAggregator();
    aggregator._setProofSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);

    const result = await preflightFinalize([makeToken('tok-ok')], {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
      transientRetryDelayMs: 0,
    });

    expect(result.totalAdvanced).toBe(1);
    expect(aggregator._calls.submit).toHaveLength(0);
    expect(aggregator._calls.getProof).toEqual(['req-tx1']);
  });
});

// =============================================================================
// 7. Transient retries — recovers within budget
// =============================================================================

describe('preflightFinalize — transient retry then success', () => {
  it('retries getProof up to budget and succeeds', async () => {
    const aggregator = makeMockAggregator();

    // Pre-probe: not-found.
    // Then submit succeeds, but post-poll: 2 transient throws then success.
    aggregator._setProofSequence('req-tx1', [
      { kind: 'not-found' },          // pre-submit probe
      { kind: 'transient' },          // post-submit poll attempt 1
      { kind: 'transient' },          // poll attempt 2
      { kind: 'success', txHash: 'tx1' }, // poll attempt 3
    ]);
    aggregator._setSubmitSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);

    const result = await preflightFinalize([makeToken('tok-r')], {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
      transientRetryCount: 3,
      transientRetryDelayMs: 0,
    });

    expect(result.totalAdvanced).toBe(1);
    expect(aggregator._calls.getProof.length).toBeGreaterThanOrEqual(3);
  });
});

describe('preflightFinalize — transient retries exhausted', () => {
  it('raises SOURCE_CHAIN_HARD_FAIL with reason=oracle-rejected', async () => {
    const aggregator = makeMockAggregator();
    // Fill the proof sequence with enough transients to exhaust budget.
    aggregator._setProofSequence('req-tx1', [
      { kind: 'not-found' },
      { kind: 'transient' },
      { kind: 'transient' },
      { kind: 'transient' },
      { kind: 'transient' },
      { kind: 'transient' },
      { kind: 'transient' },
    ]);
    aggregator._setSubmitSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);

    let captured: unknown = null;
    try {
      await preflightFinalize([makeToken('tok-exh')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
        transientRetryCount: 2,
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      captured = e;
    }
    expect(isSphereError(captured)).toBe(true);
    const err = captured as SphereError;
    expect(err.code).toBe('SOURCE_CHAIN_HARD_FAIL');
    const cause = (err as { cause?: { reason?: DispositionReason } }).cause;
    expect(cause?.reason).toBe('oracle-rejected');
  });
});

// =============================================================================
// 8/9. Hard rejections from the aggregator
// =============================================================================

describe('preflightFinalize — hard rejection: REQUEST_ID_MISMATCH', () => {
  it('maps to client-error', async () => {
    const aggregator = makeMockAggregator();
    aggregator._setProofSequence('req-tx1', [{ kind: 'not-found' }]);
    aggregator._setSubmitSequence('req-tx1', [
      { kind: 'reject', message: 'submitCommitment failed: REQUEST_ID_MISMATCH' },
    ]);

    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('tok-bug')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('SOURCE_CHAIN_HARD_FAIL');
    const cause = (err as unknown as { cause: { reason: DispositionReason; requestId: string } }).cause;
    expect(cause.reason).toBe('client-error');
    expect(cause.requestId).toBe('req-tx1');
  });
});

describe('preflightFinalize — hard rejection: AUTHENTICATOR_VERIFICATION_FAILED', () => {
  it('maps to belief-divergence', async () => {
    const aggregator = makeMockAggregator();
    aggregator._setProofSequence('req-tx1', [{ kind: 'not-found' }]);
    aggregator._setSubmitSequence('req-tx1', [
      { kind: 'reject', message: 'AUTHENTICATOR_VERIFICATION_FAILED' },
    ]);

    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('tok-bd')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('SOURCE_CHAIN_HARD_FAIL');
    const cause = (err as unknown as { cause: { reason: DispositionReason } }).cause;
    expect(cause.reason).toBe('belief-divergence');
  });
});

// =============================================================================
// 10. Race-lost — proof.transactionHash mismatch
// =============================================================================

describe('preflightFinalize — race-lost', () => {
  it('detects mismatch under OK proof and maps to race-lost', async () => {
    const aggregator = makeMockAggregator();
    // Pre-submit probe: aggregator already has a proof but it attests
    // a DIFFERENT tx hash than our local belief. (race-winner submitted
    // a different transition over the same source state.)
    aggregator._setProofSequence('req-tx1', [
      { kind: 'success', txHash: 'OTHER-WINNER-TX' },
    ]);

    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('tok-race')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('SOURCE_CHAIN_HARD_FAIL');
    const cause = (err as unknown as { cause: { reason: DispositionReason } }).cause;
    expect(cause.reason).toBe('race-lost');
  });
});

// =============================================================================
// 11. Cascade-failure forensics — failing requestId/step preserved
// =============================================================================

describe('preflightFinalize — cascade forensics at depth 3 step 2', () => {
  it('failing tx surfaces requestId, currentStep, chainDepth in cause', async () => {
    const aggregator = makeMockAggregator();
    // tx1 succeeds, tx2 hard-rejects, tx3 never reached.
    aggregator._setProofSequence('req-tx1', [
      { kind: 'not-found' },
      { kind: 'success', txHash: 'tx1' },
    ]);
    aggregator._setSubmitSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);
    aggregator._setProofSequence('req-tx2', [{ kind: 'not-found' }]);
    aggregator._setSubmitSequence('req-tx2', [
      { kind: 'reject', message: 'REQUEST_ID_MISMATCH' },
    ]);

    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('tok-cascade')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () =>
          [{ txHash: 'tx1' }, { txHash: 'tx2' }, { txHash: 'tx3' }] as FakePendingTx[],
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('SOURCE_CHAIN_HARD_FAIL');
    const cause = (err as unknown as {
      cause: {
        readonly tokenId: string;
        readonly requestId: string;
        readonly reason: DispositionReason;
        readonly currentStep: number;
        readonly chainDepth: number;
      };
    }).cause;
    expect(cause.tokenId).toBe('tok-cascade');
    expect(cause.requestId).toBe('req-tx2');
    expect(cause.reason).toBe('client-error');
    expect(cause.currentStep).toBe(2);
    expect(cause.chainDepth).toBe(3);
    // tx3 should NOT have been touched.
    expect(aggregator._calls.submit).toEqual(['req-tx1', 'req-tx2']);
  });
});

// =============================================================================
// 12. AbortSignal — caller aborts mid-chain
// =============================================================================

describe('preflightFinalize — AbortSignal', () => {
  it('throws AbortError and stops touching downstream txs', async () => {
    const aggregator = makeMockAggregator();
    aggregator._setProofSequence('req-tx1', [
      { kind: 'not-found' },
      { kind: 'success', txHash: 'tx1' },
    ]);
    aggregator._setSubmitSequence('req-tx1', [{ kind: 'success', txHash: 'tx1' }]);

    const ac = new AbortController();
    let processed = 0;

    let thrown: unknown = null;
    try {
      await preflightFinalize([makeToken('tok-abort')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () =>
          [{ txHash: 'tx1' }, { txHash: 'tx2' }, { txHash: 'tx3' }] as FakePendingTx[],
        emit: () => {
          processed++;
          if (processed === 1) ac.abort();
        },
        signal: ac.signal,
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    // Either an AbortError DOMException or a thrown reason — accept both.
    const isAbort =
      (thrown instanceof Error && thrown.name === 'AbortError') ||
      (thrown instanceof DOMException && thrown.name === 'AbortError');
    expect(isAbort).toBe(true);
    // Only tx1 should have been touched.
    expect(aggregator._calls.submit).toEqual(['req-tx1']);
    expect(processed).toBe(1);
  });

  it('aborts at the start of the very first iteration when pre-aborted', async () => {
    const aggregator = makeMockAggregator();
    const ac = new AbortController();
    ac.abort();
    let thrown: unknown = null;
    try {
      await preflightFinalize([makeToken('pre')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'tx1' }] as FakePendingTx[],
        signal: ac.signal,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(aggregator._calls.submit).toHaveLength(0);
    expect(aggregator._calls.getProof).toHaveLength(0);
  });
});

// =============================================================================
// 13. Progress events — once per processed tx
// =============================================================================

describe('preflightFinalize — progress events', () => {
  it('emits exactly N events for chain depth N', async () => {
    const aggregator = makeMockAggregator();
    for (const tx of ['a', 'b', 'c', 'd']) {
      aggregator._setProofSequence(`req-${tx}`, [
        { kind: 'not-found' },
        { kind: 'success', txHash: tx },
      ]);
      aggregator._setSubmitSequence(`req-${tx}`, [{ kind: 'success', txHash: tx }]);
    }
    const events: PreflightProgressEvent[] = [];
    await preflightFinalize([makeToken('tok-events')], {
      aggregator,
      resolveRequestId: makeResolver(),
      extractPendingChain: () =>
        [{ txHash: 'a' }, { txHash: 'b' }, { txHash: 'c' }, { txHash: 'd' }] as FakePendingTx[],
      emit: (e) => events.push(e),
      transientRetryDelayMs: 0,
    });
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.currentStep)).toEqual([1, 2, 3, 4]);
  });
});

// =============================================================================
// 14. Resolver throw → client-error
// =============================================================================

describe('preflightFinalize — resolver throws', () => {
  it('maps to client-error hard-fail', async () => {
    const aggregator = makeMockAggregator();
    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('tok-resolver')], {
        aggregator,
        resolveRequestId: () => {
          throw new Error('cannot derive requestId');
        },
        extractPendingChain: () => [{ txHash: 'x' }] as FakePendingTx[],
        transientRetryDelayMs: 0,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('SOURCE_CHAIN_HARD_FAIL');
    const cause = (err as unknown as { cause: { reason: DispositionReason } }).cause;
    expect(cause.reason).toBe('client-error');
  });
});

// =============================================================================
// 15. mapAggregatorRejection unit table
// =============================================================================

describe('mapAggregatorRejection', () => {
  const cases: ReadonlyArray<readonly [string | undefined, DispositionReason | null]> = [
    ['AUTHENTICATOR_VERIFICATION_FAILED', 'belief-divergence'],
    ['some prefix REQUEST_ID_MISMATCH suffix', 'client-error'],
    ['PATH_INVALID', 'proof-invalid'],
    ['NOT_AUTHENTICATED', 'proof-invalid'],
    ['network timeout', null],
    ['', null],
    [undefined, null],
    ['authenticator_verification_failed', 'belief-divergence'], // case-insensitive
  ];
  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(mapAggregatorRejection(input)).toBe(expected);
    });
  }
});

// =============================================================================
// 16. Validation: bad knobs reject early
// =============================================================================

describe('preflightFinalize — option validation', () => {
  it('rejects negative transientRetryCount', async () => {
    const aggregator = makeMockAggregator();
    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('x')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'x' }] as FakePendingTx[],
        transientRetryCount: -1,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('INVALID_CONFIG');
  });

  it('rejects NaN transientRetryDelayMs', async () => {
    const aggregator = makeMockAggregator();
    let err: SphereError | null = null;
    try {
      await preflightFinalize([makeToken('y')], {
        aggregator,
        resolveRequestId: makeResolver(),
        extractPendingChain: () => [{ txHash: 'y' }] as FakePendingTx[],
        transientRetryDelayMs: Number.NaN,
      });
    } catch (e) {
      err = e as SphereError;
    }
    expect(err?.code).toBe('INVALID_CONFIG');
  });
});
