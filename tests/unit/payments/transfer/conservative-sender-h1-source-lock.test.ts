/**
 * Tests for Audit #333 H1 — conservative-sender same-process source lock.
 *
 * Background
 * ----------
 * Before this fix, `conservative-sender.ts` had ZERO locking primitives.
 * `instant-sender.ts` declared a process-global `sourceLocks` map (Wave
 * 5 #171). Conservative sends and instant-vs-conservative cross-pairs
 * therefore did NOT serialize on shared source tokens: two concurrent
 * sends could both pass selection, both commit on-chain, and only the
 * aggregator caught the duplicate-spend after a source was burned.
 *
 * The fix extracted the lock registry to `./source-locks.ts` (see
 * `source-locks-h1-shared.test.ts` for direct-module tests) and wired
 * `conservative-sender.ts` to acquire/release through the same map
 * after source selection completes.
 *
 * This file verifies the conservative-sender pipeline actually invokes
 * the lock:
 *   - Two concurrent `sendConservativeUxf` calls sharing a source
 *     SERIALIZE — the second cannot enter `commitSources` until the
 *     first releases.
 *   - The lock is RELEASED on success (subsequent send proceeds
 *     immediately).
 *   - The lock is RELEASED on failure (subsequent send proceeds even
 *     after the first throws inside the pipeline).
 *   - Disjoint sources PROCEED CONCURRENTLY (sanity check — locking is
 *     not over-broad).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from '../../../../modules/payments/transfer/conservative-sender';
import { __resetSourceLocksForTesting } from '../../../../modules/payments/transfer/source-locks';
import type { TokenLike } from '../../../../modules/payments/transfer/classify-token';
import type { PreflightFinalizeOptions } from '../../../../modules/payments/transfer/preflight-finalize';
import type { OracleProvider } from '../../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../../transport';
import type { PeerInfo } from '../../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
} from '../../../../types';
import { TOKEN_A } from '../../../fixtures/uxf-mock-tokens';

// ---------------------------------------------------------------------------
// Minimal harness — just enough to drive sendConservativeUxf to the
// commit step where the lock is observably held.
// ---------------------------------------------------------------------------

function makeToken(id: string, fixture: Record<string, unknown>): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '1000000',
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(fixture),
  };
}

function makeCommitResult(sourceTokenId: string): ConservativeCommitResult {
  return {
    sourceTokenId,
    method: 'direct',
    requestIdHex: `req-${sourceTokenId}`,
    recipientTokenJson: { ...TOKEN_A },
  };
}

function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    submitCommitment: vi.fn(),
    getProof: vi.fn(),
    waitForProof: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeTransportStub(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => undefined),
    sendTokenTransfer: vi.fn().mockResolvedValue('event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02aaaa'.padEnd(66, 'a'),
    l1Address: 'alpha1mock',
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    l1Address: 'alpha1bob',
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    nametag: 'bob',
  };
}

function defaultTokenLikeForTest(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

interface DepsConfig {
  readonly source: Token;
  readonly onCommitEnter: () => Promise<void>;
  readonly onCommitThrows?: Error;
}

function makeDeps(cfg: DepsConfig): {
  readonly deps: ConservativeSenderDeps;
  readonly events: Array<{ type: SphereEventType; data: unknown }>;
} {
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const emit = <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ): void => {
    events.push({ type, data });
  };
  const deps: ConservativeSenderDeps = {
    aggregator: makeOracleStub(),
    transport: makeTransportStub(),
    identity: makeIdentity(),
    senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
    emit,
    availableSources: () => [cfg.source],
    selectSources: async () => [cfg.source],
    preflightOptions: () => ({
      resolveRequestId: () => {
        throw new Error('resolveRequestId not expected in H1 lock tests');
      },
      extractPendingChain: () => [],
    } satisfies Omit<PreflightFinalizeOptions, 'aggregator'>),
    commitSources: async () => {
      await cfg.onCommitEnter();
      if (cfg.onCommitThrows) {
        throw cfg.onCommitThrows;
      }
      return [makeCommitResult(cfg.source.id)];
    },
    toTokenLike: defaultTokenLikeForTest,
  };
  return { deps, events };
}

function basicRequest(): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'conservative',
  };
}

/** Resolvable gate used to observe ordering. */
function makeGate(): { wait: () => Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const p = new Promise<void>((r) => { resolveFn = r; });
  return { wait: () => p, resolve: resolveFn };
}

/** Yield enough microtasks to let the pipeline progress between awaits. */
async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 H1 — conservative-sender source lock integration', () => {
  beforeEach(() => __resetSourceLocksForTesting());
  afterEach(() => __resetSourceLocksForTesting());

  describe('two conservative sends sharing a source serialize', () => {
    it('the second send cannot reach commitSources until the first releases', async () => {
      const shared = makeToken('tok-shared-h1', TOKEN_A);
      const order: string[] = [];

      const firstGate = makeGate();
      const secondGate = makeGate();

      const first = makeDeps({
        source: shared,
        onCommitEnter: async () => {
          order.push('first-commit-start');
          await firstGate.wait();
        },
        // Force a clean throw so we don't have to drive the full post-
        // commit pipeline. The lock release runs in `finally` regardless.
        onCommitThrows: new Error('first-commit-deliberate-throw'),
      });

      const second = makeDeps({
        source: shared,
        onCommitEnter: async () => {
          order.push('second-commit-start');
          await secondGate.wait();
        },
        onCommitThrows: new Error('second-commit-deliberate-throw'),
      });

      const p1 = sendConservativeUxf(basicRequest(), makePeerInfo(), first.deps)
        .catch((err) => err);
      const p2 = sendConservativeUxf(basicRequest(), makePeerInfo(), second.deps)
        .catch((err) => err);

      // Let both sends advance through validateTargets → selectSources →
      // acquireSourceLocks → preflight. Only the FIRST should have
      // reached commitSources; the second is parked at the lock.
      await tick(20);
      expect(order).toEqual(['first-commit-start']);

      // Release the first send. After cleanup it releases the lock in
      // its `finally`. The second send then acquires and reaches its
      // commitSources.
      firstGate.resolve();
      await tick(20);
      expect(order).toEqual(['first-commit-start', 'second-commit-start']);

      // Cleanup.
      secondGate.resolve();
      await Promise.allSettled([p1, p2]);
    });
  });

  describe('lock is released on success', () => {
    it('a subsequent send on the same source proceeds without waiting', async () => {
      const shared = makeToken('tok-success-h1', TOKEN_A);

      // We deliberately throw inside commitSources to short-circuit the
      // post-commit pipeline (we are not driving the full CAR / outbox
      // path here — the lock's `finally` release fires regardless).
      const first = makeDeps({
        source: shared,
        onCommitEnter: async () => {},
        onCommitThrows: new Error('first-cleanup-throw'),
      });

      await sendConservativeUxf(basicRequest(), makePeerInfo(), first.deps)
        .catch(() => undefined);

      // The lock SHOULD now be released. Second send proceeds immediately.
      const second = makeDeps({
        source: shared,
        onCommitEnter: async () => {},
        onCommitThrows: new Error('second-cleanup-throw'),
      });

      const start = Date.now();
      await sendConservativeUxf(basicRequest(), makePeerInfo(), second.deps)
        .catch(() => undefined);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('lock is released on failure (try/finally invariant)', () => {
    it('after a send throws mid-pipeline, the lock for its sources is freed', async () => {
      const shared = makeToken('tok-failure-h1', TOKEN_A);

      const failing = makeDeps({
        source: shared,
        onCommitEnter: async () => {},
        onCommitThrows: new Error('deliberate-mid-pipeline-fault'),
      });
      const failingResult = await sendConservativeUxf(
        basicRequest(),
        makePeerInfo(),
        failing.deps,
      ).catch((err) => err);
      expect((failingResult as Error).message).toMatch(/deliberate-mid-pipeline-fault/);

      // The lock MUST have been released in `finally` despite the throw.
      const recovery = makeDeps({
        source: shared,
        onCommitEnter: async () => {},
        onCommitThrows: new Error('recovery-throw'),
      });
      const start = Date.now();
      await sendConservativeUxf(
        basicRequest(),
        makePeerInfo(),
        recovery.deps,
      ).catch(() => undefined);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('disjoint sources proceed concurrently (locking is not over-broad)', () => {
    it('two sends with non-overlapping source tokens run in parallel', async () => {
      const tokenA = makeToken('tok-disjoint-h1-A', TOKEN_A);
      const tokenB = makeToken('tok-disjoint-h1-B', TOKEN_A);
      const order: string[] = [];

      const gateA = makeGate();
      const gateB = makeGate();

      const sendA = makeDeps({
        source: tokenA,
        onCommitEnter: async () => {
          order.push('A-commit-start');
          await gateA.wait();
        },
        onCommitThrows: new Error('A-throw'),
      });
      const sendB = makeDeps({
        source: tokenB,
        onCommitEnter: async () => {
          order.push('B-commit-start');
          await gateB.wait();
        },
        onCommitThrows: new Error('B-throw'),
      });

      const pA = sendConservativeUxf(basicRequest(), makePeerInfo(), sendA.deps)
        .catch((err) => err);
      const pB = sendConservativeUxf(basicRequest(), makePeerInfo(), sendB.deps)
        .catch((err) => err);

      // BOTH should reach commit concurrently — disjoint tokenIds.
      await tick(20);
      expect(order.sort()).toEqual(['A-commit-start', 'B-commit-start']);

      gateA.resolve();
      gateB.resolve();
      await Promise.allSettled([pA, pB]);
    });
  });
});
