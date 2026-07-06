/**
 * §5.0 / W7 — per-tokenId queue cap (INGEST_QUEUE_FULL_PER_TOKEN).
 *
 * Per `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.0:
 *
 *   "Per-tokenId fairness cap inside the ingest queue. A single hot
 *    tokenId (e.g., target of a bundle-flood attack) cannot fill more
 *    than this many slots; further arrivals on the same id are
 *    rejected with INGEST_QUEUE_FULL_PER_TOKEN."
 *
 * Default cap is `INGEST_QUEUE_PER_TOKEN_CAP = 16`.
 *
 * This file pins the W7 invariant:
 *   - Bundles with novel `tokenIds` enqueue normally even when one id
 *     is over-cap.
 *   - The (cap+1)-th bundle for the same id rejects with
 *     `INGEST_QUEUE_FULL_PER_TOKEN`.
 *   - The rejection emits `transfer:ingest-queue-full` with cause
 *     `'queue-full-per-token'` and the offending tokenId(s) in the
 *     payload's `tokenIds` field.
 *   - Decrement on dequeue: once a queued bundle for the hot id has
 *     been processed, a fresh arrival can enqueue again.
 *   - Bundles with multiple claimed token-ids are gated by ANY
 *     over-cap id (one strike kills the bundle).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isSphereError } from '../../../../core/errors';
import {
  IngestWorkerPool,
  type AcquireBundleFn,
  type IngestPoolEventEmitter,
  type ProcessTokenFn,
  type UxfV1Payload,
} from '../../../../extensions/uxf/pipeline/ingest-worker-pool';
import { ReplayLRU } from '../../../../extensions/uxf/pipeline/replay-lru';
import { PerTokenMutex } from '../../../../extensions/uxf/profile/per-token-mutex';
import type {
  RootRef,
  VerifiedBundle,
} from '../../../../extensions/uxf/pipeline/bundle-verifier';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';
import type { SphereEventMap, SphereEventType } from '../../../../types';

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

function buildPayload(
  bundleCid: string,
  tokenIds: ReadonlyArray<string>,
): UxfV1Payload {
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'conservative',
    bundleCid,
    tokenIds,
    carBase64: 'AAAA',
  };
}

function buildVerified(
  bundleCid: string,
  tokenIds: ReadonlyArray<string>,
): VerifiedBundle {
  const claimed: RootRef[] = tokenIds.map((id, idx) => ({
    contentHash: syntheticHash(`${bundleCid}-${id}-${idx}`),
    tokenId: id,
    chainDepth: 1,
  }));
  return {
    verified: true,
    pkg: {} as never,
    bundleCid,
    claimedTokens: claimed,
    advisoryUnclaimedRoots: [],
    missingClaimedTokenIds: [],
    droppedDeepUnclaimed: 0,
  };
}

function makeAcquirer(): AcquireBundleFn {
  return async (payload) => buildVerified(payload.bundleCid, payload.tokenIds);
}

interface RecordedEmit<T extends SphereEventType = SphereEventType> {
  readonly event: T;
  readonly payload: SphereEventMap[T];
}

function makeEmitRecorder(): {
  emit: IngestPoolEventEmitter;
  events: RecordedEmit[];
} {
  const events: RecordedEmit[] = [];
  const emit: IngestPoolEventEmitter = (event, payload) => {
    events.push({ event, payload } as RecordedEmit);
  };
  return { emit, events };
}

// =============================================================================
// 2. W7 — basic per-tokenId cap fires at cap+1
// =============================================================================

describe('§5.0 W7 — INGEST_QUEUE_FULL_PER_TOKEN', () => {
  let pool: IngestWorkerPool | null = null;
  let releaseBlock = (): void => undefined;
  let block: Promise<void>;

  beforeBlockFresh();

  function beforeBlockFresh(): void {
    block = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
  }

  afterEach(async () => {
    releaseBlock();
    if (pool) {
      await pool.destroy();
      pool = null;
    }
    beforeBlockFresh();
  });

  it('cap=4: enqueueing 5th bundle for same tokenId rejects', async () => {
    const hotId = syntheticTokenId('hot');
    const slowProcess: ProcessTokenFn = async () => {
      await block;
    };

    const { emit, events } = makeEmitRecorder();
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: slowProcess,
      emit,
      acquireBundle: makeAcquirer(),
      // Workers parked on `block`, so all enqueues stay in the queue.
      maxWorkers: 1,
      queueSize: 64,
      perTokenCap: 4,
      mutexStrategy: 'rpc-release',
    });

    // 4 enqueues against the hot id all succeed.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      promises.push(pool.enqueue(buildPayload(`bunhot-${i}`, [hotId]), SENDER));
    }

    // Yield to let worker pick up bundle 0 → counter for hot
    // dropped from 4 → 3 → enqueued+1 → back to 4. Actually no:
    // worker is parked on `block` while running processToken. The
    // counter decrement happens AFTER processBundle returns
    // (in the finally), so all 4 are still counted.
    await Promise.resolve();

    // 5th must reject.
    let captured: unknown;
    try {
      await pool.enqueue(buildPayload('bunhot-5', [hotId]), SENDER);
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('INGEST_QUEUE_FULL_PER_TOKEN');
    }

    const emitted = events.find(
      (e) => e.event === 'transfer:ingest-queue-full',
    );
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toMatchObject({
      cause: 'queue-full-per-token',
      bundleCid: 'bunhot-5',
      tokenIds: [hotId],
    });

    releaseBlock();
    await Promise.allSettled(promises);
  });

  it('different tokenId still enqueues even when another id is at cap', async () => {
    const hotId = syntheticTokenId('hot2');
    const coldId = syntheticTokenId('cold');
    const slowProcess: ProcessTokenFn = async () => {
      await block;
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: slowProcess,
      emit: () => undefined,
      acquireBundle: makeAcquirer(),
      maxWorkers: 1,
      queueSize: 64,
      perTokenCap: 3,
      mutexStrategy: 'rpc-release',
    });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 3; i++) {
      promises.push(pool.enqueue(buildPayload(`hot${i}`, [hotId]), SENDER));
    }
    await Promise.resolve();

    // Cold id still has plenty of room.
    promises.push(
      pool.enqueue(buildPayload('cold-bun', [coldId]), SENDER),
    );

    // Hot is over-cap → rejects.
    let captured: unknown;
    try {
      await pool.enqueue(buildPayload('hot-extra', [hotId]), SENDER);
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('INGEST_QUEUE_FULL_PER_TOKEN');
    }

    releaseBlock();
    await Promise.allSettled(promises);
  });

  it('multi-token bundle gated by ANY over-cap id', async () => {
    const hotId = syntheticTokenId('multi-hot');
    const otherId = syntheticTokenId('multi-other');
    const slowProcess: ProcessTokenFn = async () => {
      await block;
    };

    const { emit, events } = makeEmitRecorder();
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: slowProcess,
      emit,
      acquireBundle: makeAcquirer(),
      maxWorkers: 1,
      queueSize: 64,
      perTokenCap: 2,
      mutexStrategy: 'rpc-release',
    });

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 2; i++) {
      promises.push(pool.enqueue(buildPayload(`hot${i}`, [hotId]), SENDER));
    }
    await Promise.resolve();

    // Now a multi-token bundle that includes the hot id — should
    // reject even though the other id is brand-new.
    let captured: unknown;
    try {
      await pool.enqueue(
        buildPayload('multi', [otherId, hotId]),
        SENDER,
      );
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('INGEST_QUEUE_FULL_PER_TOKEN');
    }

    const emitted = events.find(
      (e) => e.event === 'transfer:ingest-queue-full',
    );
    // The offending id list MUST include the hot id (and only the
    // hot id — the other id was nowhere near cap).
    expect(emitted).toBeDefined();
    expect(emitted!.payload).toMatchObject({
      cause: 'queue-full-per-token',
    });
    const eventPayload =
      emitted!.payload as SphereEventMap['transfer:ingest-queue-full'];
    expect(eventPayload.tokenIds).toEqual([hotId]);

    releaseBlock();
    await Promise.allSettled(promises);
  });

  it('counter decrements on bundle completion → fresh arrival enqueues again', async () => {
    const hotId = syntheticTokenId('decrement-hot');
    const releases: Array<() => void> = [];
    const processToken: ProcessTokenFn = async () => {
      // Each invocation creates its own gate so we can release them
      // one at a time.
      await new Promise<void>((resolve) => releases.push(resolve));
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(),
      maxWorkers: 2,
      queueSize: 64,
      perTokenCap: 2,
      // 'cas' lets bundles for the same tokenId run in parallel —
      // the W7 cap is enforced at ENQUEUE time (against the queue),
      // independent of per-token mutex strategy. Tests should not
      // conflate the two layers.
      mutexStrategy: 'cas',
    });

    const p1 = pool.enqueue(buildPayload('a', [hotId]), SENDER);
    const p2 = pool.enqueue(buildPayload('b', [hotId]), SENDER);

    // Sanity: a 3rd MUST reject — we're already at cap=2.
    let captured: unknown;
    try {
      await pool.enqueue(buildPayload('c', [hotId]), SENDER);
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('INGEST_QUEUE_FULL_PER_TOKEN');
    }

    // Wait for both enqueues to start processing so we can release
    // them. With maxWorkers=2 + cas strategy, both run in parallel.
    while (releases.length < 2) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Release one inflight; counter goes 2 → 1.
    releases[0]();
    await p1;

    // Now the cap is open — fresh enqueue must succeed.
    const p3 = pool.enqueue(buildPayload('c-retry', [hotId]), SENDER);

    while (releases.length < 3) {
      await new Promise((r) => setTimeout(r, 5));
    }
    releases[1]();
    releases[2]();
    await p2;
    await p3;
    expect(pool.perTokenCount(hotId)).toBe(0);
  });
});
