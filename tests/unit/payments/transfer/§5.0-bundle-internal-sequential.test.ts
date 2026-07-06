/**
 * §5.0 / W23 — bundle-internal sequential token processing.
 *
 * Per `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.0 (verbatim):
 *
 *   "Bundle-internal token parallelism: within one bundle, all
 *    token-roots are processed by the SAME worker sequentially (no
 *    inner parallelism). This keeps per-bundle ordering consistent for
 *    §5.6 idempotency invariants. Cross-bundle parallelism is the
 *    protection against rogue inputs."
 *
 * This file pins exactly that contract: a single bundle carrying N
 * token-roots invokes `processToken` N times, never overlapping. The
 * tests below run the test in two flavours — single-worker pool
 * (trivial sequential) and multi-worker pool (where overlap COULD
 * happen if the pool incorrectly fanned out within a bundle).
 *
 * Acceptance (W23):
 *  - For one bundle with 8 token-roots, the maximum observed
 *    inflight-count inside `processToken` is exactly 1.
 *  - The processToken invocation order matches the order the
 *    bundle-verifier surfaced (claimed first, advisory second).
 *  - The cross-bundle parallelism invariant is preserved: two
 *    bundles each with 4 tokens overlap inflight-count up to 2 at a
 *    time (one per bundle).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  IngestWorkerPool,
  type AcquireBundleFn,
  type ProcessTokenFn,
  type UxfV1Payload,
} from '../../../../extensions/uxf/pipeline/ingest-worker-pool';
import { ReplayLRU } from '../../../../extensions/uxf/pipeline/replay-lru';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import type {
  RootRef,
  VerifiedBundle,
} from '../../../../extensions/uxf/pipeline/bundle-verifier';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';

// =============================================================================
// 1. Fixtures
// =============================================================================

const SENDER = 'a'.repeat(64);

function syntheticTokenId(seed: string): string {
  let out = '';
  for (const ch of seed) {
    out += ch.charCodeAt(0).toString(16).padStart(2, '0');
  }
  return (out + '0'.repeat(64)).slice(0, 64);
}

function syntheticHash(seed: string): ContentHash {
  let out = '';
  for (const ch of seed) {
    out += ch.charCodeAt(0).toString(16).padStart(2, '0');
  }
  return (out + '0'.repeat(64)).slice(0, 64) as ContentHash;
}

function buildBundle(
  bundleCid: string,
  claimedTokenIds: ReadonlyArray<string>,
  advisoryTokenIds: ReadonlyArray<string> = [],
): { payload: UxfV1Payload; verified: VerifiedBundle } {
  const payload: UxfV1Payload = {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'conservative',
    bundleCid,
    tokenIds: claimedTokenIds,
    carBase64: 'AAAA',
  };
  const claimedRoots: RootRef[] = claimedTokenIds.map((id, idx) => ({
    contentHash: syntheticHash(`claimed-${id}-${idx}`),
    tokenId: id,
    chainDepth: 1,
  }));
  const advisoryRoots: RootRef[] = advisoryTokenIds.map((id, idx) => ({
    contentHash: syntheticHash(`advisory-${id}-${idx}`),
    tokenId: id,
    chainDepth: 1,
  }));
  const verified: VerifiedBundle = {
    verified: true,
    pkg: {} as never,
    bundleCid,
    claimedTokens: claimedRoots,
    advisoryUnclaimedRoots: advisoryRoots,
    missingClaimedTokenIds: [],
    droppedDeepUnclaimed: 0,
  };
  return { payload, verified };
}

function makeStubAcquirer(
  fixtures: ReadonlyMap<string, VerifiedBundle>,
): AcquireBundleFn {
  return async (payload) => {
    const v = fixtures.get(payload.bundleCid);
    if (!v) {
      throw new Error(`acquirer stub: no fixture for ${payload.bundleCid}`);
    }
    return v;
  };
}

// =============================================================================
// 2. W23 — single bundle, multiple token-roots, observe inflight=1
// =============================================================================

describe('§5.0 W23 — bundle-internal sequential token processing', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('processes 8 token-roots in one bundle strictly sequentially', async () => {
    const tokenIds = Array.from({ length: 8 }, (_, i) =>
      syntheticTokenId(`tok${i}`),
    );
    const bundleCid = 'bbundle-w23-single';
    const { payload, verified } = buildBundle(bundleCid, tokenIds);

    let inflight = 0;
    let maxObserved = 0;
    const order: string[] = [];

    const processToken: ProcessTokenFn = async (tokenRoot) => {
      inflight += 1;
      maxObserved = Math.max(maxObserved, inflight);
      order.push(tokenRoot.tokenId);
      // Yield several event-loop ticks. If the pool fanned out
      // tokens within a bundle, parallel calls would land here and
      // bump `inflight > 1`.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight -= 1;
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeStubAcquirer(new Map([[bundleCid, verified]])),
      // Strategy is intentionally `'cas'` (no per-tokenId
      // serialization) — the W23 invariant comes from the WORKER's
      // for-loop, NOT from the mutex. Tests would be misleading if
      // they conflated the two.
      mutexStrategy: 'cas',
    });

    await pool.enqueue(payload, SENDER);

    expect(maxObserved).toBe(1);
    expect(order).toEqual(tokenIds);
  });

  it('order respects claimed-then-advisory iteration (per-bundle determinism)', async () => {
    const claimed = [syntheticTokenId('c1'), syntheticTokenId('c2')];
    const advisory = [syntheticTokenId('a1'), syntheticTokenId('a2')];
    const bundleCid = 'bbundle-w23-order';
    const { payload, verified } = buildBundle(bundleCid, claimed, advisory);

    const order: string[] = [];
    const processToken: ProcessTokenFn = async (tokenRoot) => {
      order.push(tokenRoot.tokenId);
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeStubAcquirer(new Map([[bundleCid, verified]])),
      mutexStrategy: 'cas',
    });

    await pool.enqueue(payload, SENDER);
    expect(order).toEqual([...claimed, ...advisory]);
  });

  it('cross-bundle parallelism preserved: two bundles overlap inflight up to 2', async () => {
    // Each bundle carries 4 distinct tokenIds (no per-tokenId mutex
    // serialization between the bundles). With 2 workers, the WITHIN-
    // bundle invariant holds (inflight per worker = 1) but ACROSS
    // workers we can observe 2 simultaneously.
    const cidA = 'bbundle-A';
    const cidB = 'bbundle-B';
    const tokensA = [0, 1, 2, 3].map((i) => syntheticTokenId(`a${i}`));
    const tokensB = [0, 1, 2, 3].map((i) => syntheticTokenId(`b${i}`));
    const fxA = buildBundle(cidA, tokensA);
    const fxB = buildBundle(cidB, tokensB);

    let inflight = 0;
    let maxObserved = 0;
    const processToken: ProcessTokenFn = async () => {
      inflight += 1;
      maxObserved = Math.max(maxObserved, inflight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inflight -= 1;
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeStubAcquirer(
        new Map([
          [cidA, fxA.verified],
          [cidB, fxB.verified],
        ]),
      ),
      maxWorkers: 2,
      mutexStrategy: 'cas',
    });

    await Promise.all([
      pool.enqueue(fxA.payload, SENDER),
      pool.enqueue(fxB.payload, SENDER),
    ]);

    // With 2 workers each processing one bundle's 4 tokens
    // sequentially, max-observed should be exactly 2.
    expect(maxObserved).toBe(2);
  });
});
