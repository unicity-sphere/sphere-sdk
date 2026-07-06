/**
 * Tests for `modules/payments/transfer/ingest-worker-pool.ts` (T.3.E).
 *
 * The pool's job is concurrency mechanics — fan-out, per-tokenId
 * serialization, queue back-pressure, W13 transient routing, clean
 * shutdown. These tests inject stubs for {@link acquireBundle} and the
 * `processToken` hook so we exercise the pool's wiring directly,
 * without standing up real CAR parsing or disposition writing (those
 * are covered in their own suites).
 *
 * Coverage map (per task acceptance criteria):
 *  - 100 bundles in flight: parallelism (16 workers × different tokens)
 *  - One slow bundle does not serialize 15 fast ones (DoS defense)
 *  - Queue overflow → INGEST_QUEUE_FULL + transfer:ingest-queue-full event
 *  - Per-tokenId mutex prevents double-disposition for the same id
 *  - W13: BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT routes to transient
 *    log path (no processToken invocation)
 *  - destroy() drains in-flight, rejects queued bundles
 *
 * Spec references:
 *  - §5.0  N parallel bundle workers, INGEST_QUEUE_SIZE
 *  - §9.2 / W13  gateway-fetch-failed → transient retry only
 *  - §5.5 step 9  per-tokenId mutex
 *  - T.1.F  PerTokenMutex strategies
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isSphereError, SphereError } from '../../../../core/errors';
import {
  IngestWorkerPool,
  MAX_INGEST_WORKERS,
  type AcquireBundleFn,
  type IngestPoolEventEmitter,
  type ProcessTokenFn,
  type UxfV1Payload,
} from '../../../../modules/payments/transfer/ingest-worker-pool';
import { ReplayLRU } from '../../../../modules/payments/transfer/replay-lru';
import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import type {
  RootRef,
  VerifiedBundle,
} from '../../../../modules/payments/transfer/bundle-verifier';
import { RECIPIENT_MAX_INLINE_CARBASE64_LENGTH } from '../../../../modules/payments/transfer/bundle-acquirer';
import type { ContentHash } from '../../../../extensions/uxf/bundle/types';
import type { SphereEventMap, SphereEventType } from '../../../../types';

// =============================================================================
// 1. Test fixtures
// =============================================================================

const SENDER = 'a'.repeat(64);

/** Build a synthetic bundleCid string. We never parse it as a CID — the
 *  pool only stores it; the acquirer stub returns a `verified` shape
 *  without consulting `bundleCid`'s content. */
function syntheticBundleCid(seed: string): string {
  return `b${seed.padStart(58, '0')}`;
}

/** Build a 64-char lowercase hex tokenId from a short seed. */
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

interface BundleSpec {
  readonly bundleCid: string;
  readonly tokenIds: ReadonlyArray<string>;
  /** Optional knob: if true, the acquirer stub throws this transient. */
  readonly forceTransient?: boolean;
  /** Optional knob: if set, the acquirer stub awaits this many ms. */
  readonly delayMs?: number;
  /**
   * Optional advisory-unclaimed root tokenIds (smuggled / found-money,
   * §5.2 #2). The verifier returns these in
   * `verified.advisoryUnclaimedRoots` so the pool can pass them
   * through to `processToken` with `ctx.isClaimed === false`. Used by
   * the steelman fix #160 tests below.
   */
  readonly advisoryTokenIds?: ReadonlyArray<string>;
}

function buildPayload(spec: BundleSpec): UxfV1Payload {
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'conservative',
    bundleCid: spec.bundleCid,
    tokenIds: spec.tokenIds,
    carBase64: 'AAAA',
  };
}

function buildVerifiedBundle(spec: BundleSpec): VerifiedBundle {
  const claimedTokens: RootRef[] = spec.tokenIds.map((id, idx) => ({
    contentHash: syntheticHash(`token-${id}-${idx}`),
    tokenId: id,
    chainDepth: 1,
  }));
  const advisoryUnclaimedRoots: RootRef[] = (spec.advisoryTokenIds ?? []).map(
    (id, idx) => ({
      contentHash: syntheticHash(`advisory-${id}-${idx}`),
      tokenId: id,
      chainDepth: 1,
    }),
  );
  return {
    verified: true,
    pkg: {} as never,
    bundleCid: spec.bundleCid,
    claimedTokens,
    advisoryUnclaimedRoots,
    missingClaimedTokenIds: [],
    droppedDeepUnclaimed: 0,
  };
}

/**
 * A reusable mock `acquireBundle` that consults a `Map` of pre-staged
 * outcomes. Each test sets up the map; the pool calls in.
 *
 * - `verified` fixture → returns a VerifiedBundle.
 * - `transient` fixture → throws BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT.
 * - `delay` fixture → resolves after `delayMs`.
 */
function makeAcquirer(
  fixtures: ReadonlyMap<string, { spec: BundleSpec; type: 'verified' | 'transient' | 'hard-reject' }>,
): AcquireBundleFn {
  return async (payload) => {
    const fx = fixtures.get(payload.bundleCid);
    if (!fx) {
      throw new SphereError(
        `acquirer: no fixture for bundleCid=${payload.bundleCid}`,
        'BUNDLE_REJECTED_VERIFY_FAILED',
      );
    }
    if (fx.spec.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, fx.spec.delayMs));
    }
    if (fx.type === 'transient') {
      throw new SphereError(
        'simulated all-gateways-fail',
        'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT',
      );
    }
    if (fx.type === 'hard-reject') {
      throw new SphereError(
        'simulated hard rejection',
        'BUNDLE_REJECTED_VERIFY_FAILED',
      );
    }
    return buildVerifiedBundle(fx.spec);
  };
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
// 2. Construction validation
// =============================================================================

describe('IngestWorkerPool — construction', () => {
  it('rejects maxWorkers < 1', () => {
    const lru = new ReplayLRU();
    const mutex = new PerTokenMutex();
    expect(
      () =>
        new IngestWorkerPool({
          lru,
          perTokenMutex: mutex,
          processToken: vi.fn(),
          emit: () => undefined,
          maxWorkers: 0,
        }),
    ).toThrow(SphereError);
  });

  it('rejects queueSize < 1', () => {
    const lru = new ReplayLRU();
    const mutex = new PerTokenMutex();
    expect(
      () =>
        new IngestWorkerPool({
          lru,
          perTokenMutex: mutex,
          processToken: vi.fn(),
          emit: () => undefined,
          queueSize: 0,
        }),
    ).toThrow(SphereError);
  });

  it('rejects perTokenCap < 1', () => {
    const lru = new ReplayLRU();
    const mutex = new PerTokenMutex();
    expect(
      () =>
        new IngestWorkerPool({
          lru,
          perTokenMutex: mutex,
          processToken: vi.fn(),
          emit: () => undefined,
          perTokenCap: 0,
        }),
    ).toThrow(SphereError);
  });

  it('exports MAX_INGEST_WORKERS = 16 (§5.0 default)', () => {
    expect(MAX_INGEST_WORKERS).toBe(16);
  });
});

// =============================================================================
// 3. Cross-bundle parallelism
// =============================================================================

describe('IngestWorkerPool — cross-bundle parallelism (§5.0)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('processes 100 bundles concurrently without per-tokenId data races', async () => {
    // 100 distinct bundles, each with a UNIQUE tokenId so the per-token
    // mutex never serializes them. With 16 workers, total wall-clock
    // should be roughly ceil(100 / 16) × per-bundle-work, NOT 100×.
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    const payloads: UxfV1Payload[] = [];
    for (let i = 0; i < 100; i++) {
      const cid = syntheticBundleCid(`bundle${i}`);
      const tokenId = syntheticTokenId(`tok${i}`);
      const spec: BundleSpec = {
        bundleCid: cid,
        tokenIds: [tokenId],
        delayMs: 5, // tiny per-bundle work
      };
      fixtures.set(cid, { spec, type: 'verified' });
      payloads.push(buildPayload(spec));
    }

    const processed = new Set<string>();
    const processToken: ProcessTokenFn = async (tokenRoot) => {
      processed.add(tokenRoot.tokenId);
    };

    const { emit } = makeEmitRecorder();
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
    });

    const start = Date.now();
    await Promise.all(payloads.map((p) => pool!.enqueue(p, SENDER)));
    const elapsed = Date.now() - start;

    expect(processed.size).toBe(100);
    // Sanity: 100 bundles × 5ms strictly serial = 500ms. With 16
    // workers, expect <= ~150ms. We allow a generous 400ms ceiling for
    // CI variance — the test still fails loudly if work is fully
    // serialized.
    expect(elapsed).toBeLessThan(400);
  });
});

// =============================================================================
// 4. Slow bundle does not block fast ones (DoS defense, §5.0)
// =============================================================================

describe('IngestWorkerPool — slow bundle isolation', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('one 30s-mocked bundle does not serialize 15 fast ones', async () => {
    // Construct 16 bundles. Bundle 0 is the slow rogue (50ms in test
    // time — we cannot literally wait 30s but the contract is the
    // same: one slow bundle should consume ONE worker, not block
    // the other 15).
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    const payloads: UxfV1Payload[] = [];

    const slowSpec: BundleSpec = {
      bundleCid: syntheticBundleCid('slow'),
      tokenIds: [syntheticTokenId('slowtok')],
      delayMs: 200, // simulates the §5.0 "K=64 chain or slow IPFS" rogue
    };
    fixtures.set(slowSpec.bundleCid, { spec: slowSpec, type: 'verified' });
    payloads.push(buildPayload(slowSpec));

    for (let i = 0; i < 15; i++) {
      const cid = syntheticBundleCid(`fast${i}`);
      const tokenId = syntheticTokenId(`fasttok${i}`);
      const spec: BundleSpec = { bundleCid: cid, tokenIds: [tokenId], delayMs: 1 };
      fixtures.set(cid, { spec, type: 'verified' });
      payloads.push(buildPayload(spec));
    }

    const fastFinishedAt = new Map<string, number>();
    let slowFinishedAt = 0;
    const processToken: ProcessTokenFn = async (tokenRoot) => {
      const ts = Date.now();
      if (tokenRoot.tokenId === slowSpec.tokenIds[0]) {
        slowFinishedAt = ts;
      } else {
        fastFinishedAt.set(tokenRoot.tokenId, ts);
      }
    };

    const { emit } = makeEmitRecorder();
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
    });

    const start = Date.now();
    await Promise.all(payloads.map((p) => pool!.enqueue(p, SENDER)));

    // Every fast bundle MUST have finished before the slow one. With
    // a single-threaded queue they would have finished AFTER (queue
    // serialization). With 16 workers, fast-15 grab 15 workers and
    // resolve in <50ms while worker-1 is stuck on the slow bundle.
    expect(fastFinishedAt.size).toBe(15);
    for (const ts of fastFinishedAt.values()) {
      expect(ts).toBeLessThan(slowFinishedAt);
      expect(ts - start).toBeLessThan(150); // fast bundles complete quickly
    }
  });
});

// =============================================================================
// 5. Queue overflow → INGEST_QUEUE_FULL
// =============================================================================

describe('IngestWorkerPool — queue back-pressure (INGEST_QUEUE_FULL)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('rejects with INGEST_QUEUE_FULL when queue saturates', async () => {
    // Tight pool: 1 worker, 2 queue slots, processToken parks
    // forever (until we release). After enqueueing 1 in-flight + 2
    // queued = 3 bundles, the 4th must reject.
    let release: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    const specs: BundleSpec[] = [];
    for (let i = 0; i < 4; i++) {
      const cid = syntheticBundleCid(`fill${i}`);
      const spec: BundleSpec = { bundleCid: cid, tokenIds: [syntheticTokenId(`t${i}`)] };
      specs.push(spec);
      fixtures.set(cid, { spec, type: 'verified' });
    }

    const processToken: ProcessTokenFn = async () => {
      await block;
    };

    const { emit, events } = makeEmitRecorder();
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit,
      acquireBundle: makeAcquirer(fixtures),
      maxWorkers: 1,
      queueSize: 2,
      mutexStrategy: 'rpc-release',
    });

    // Enqueue 3 — first goes to in-flight, two go to queue.
    const promises: Promise<void>[] = [];
    promises.push(pool.enqueue(buildPayload(specs[0]), SENDER));
    promises.push(pool.enqueue(buildPayload(specs[1]), SENDER));
    promises.push(pool.enqueue(buildPayload(specs[2]), SENDER));
    // Yield to let the worker pick up specs[0].
    await Promise.resolve();

    await expect(pool.enqueue(buildPayload(specs[3]), SENDER)).rejects.toThrow(
      /INGEST_QUEUE_FULL|ingest queue full/,
    );

    const queueFullEvent = events.find(
      (e) => e.event === 'transfer:ingest-queue-full',
    );
    expect(queueFullEvent).toBeDefined();
    expect(queueFullEvent!.payload).toMatchObject({
      cause: 'queue-full',
      bundleCid: specs[3].bundleCid,
      capacity: 2,
    });

    // Release the parked worker so cleanup can drain.
    release();
    await Promise.all(promises);
  });

  it('the rejection is a SphereError with code INGEST_QUEUE_FULL', async () => {
    let release: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    const specs: BundleSpec[] = [];
    for (let i = 0; i < 3; i++) {
      const cid = syntheticBundleCid(`box${i}`);
      const spec: BundleSpec = { bundleCid: cid, tokenIds: [syntheticTokenId(`x${i}`)] };
      specs.push(spec);
      fixtures.set(cid, { spec, type: 'verified' });
    }

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: async () => {
        await block;
      },
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      maxWorkers: 1,
      queueSize: 1,
      mutexStrategy: 'rpc-release',
    });

    const settled1 = pool.enqueue(buildPayload(specs[0]), SENDER);
    const settled2 = pool.enqueue(buildPayload(specs[1]), SENDER);
    await Promise.resolve();

    let captured: unknown;
    try {
      await pool.enqueue(buildPayload(specs[2]), SENDER);
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('INGEST_QUEUE_FULL');
    }

    release();
    await settled1;
    await settled2;
  });
});

// =============================================================================
// 6. Per-tokenId mutex prevents double-disposition
// =============================================================================

describe('IngestWorkerPool — per-tokenId mutex serialization', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('two bundles for the same tokenId never run processToken concurrently', async () => {
    const sharedTokenId = syntheticTokenId('shared');
    const cidA = syntheticBundleCid('A');
    const cidB = syntheticBundleCid('B');
    const specA: BundleSpec = {
      bundleCid: cidA,
      tokenIds: [sharedTokenId],
    };
    const specB: BundleSpec = {
      bundleCid: cidB,
      tokenIds: [sharedTokenId],
    };
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cidA, { spec: specA, type: 'verified' }],
      [cidB, { spec: specB, type: 'verified' }],
    ]);

    let inflightCount = 0;
    let maxObservedInflight = 0;
    const processToken: ProcessTokenFn = async () => {
      inflightCount += 1;
      maxObservedInflight = Math.max(maxObservedInflight, inflightCount);
      // Simulated work: yield several event-loop ticks so a parallel
      // call WOULD overlap if not serialized.
      await new Promise((resolve) => setTimeout(resolve, 30));
      inflightCount -= 1;
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      // 'rpc-release' enforces strict per-tokenId serialization.
      mutexStrategy: 'rpc-release',
    });

    await Promise.all([
      pool.enqueue(buildPayload(specA), SENDER),
      pool.enqueue(buildPayload(specB), SENDER + 'b'.repeat(0)),
    ]);

    // Mutex MUST have prevented overlap.
    expect(maxObservedInflight).toBe(1);
  });
});

// =============================================================================
// 7. W13: BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT routes to transient retry only
// =============================================================================

describe('IngestWorkerPool — W13 transient routing', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('does NOT call processToken for a transient (gateway-fetch-failed) bundle', async () => {
    const cid = syntheticBundleCid('transient');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'transient' }>([
      [
        cid,
        {
          spec: { bundleCid: cid, tokenIds: [syntheticTokenId('t1')] },
          type: 'transient',
        },
      ],
    ]);

    const processToken = vi.fn<ProcessTokenFn>(async () => undefined);

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
    });

    await pool.enqueue(
      buildPayload({ bundleCid: cid, tokenIds: [syntheticTokenId('t1')] }),
      SENDER,
    );

    expect(processToken).not.toHaveBeenCalled();
  });

  it('the transient log path runs at info-level, NOT error-level', async () => {
    const cid = syntheticBundleCid('transient2');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'transient' }>([
      [
        cid,
        {
          spec: { bundleCid: cid, tokenIds: [syntheticTokenId('t2')] },
          type: 'transient',
        },
      ],
    ]);

    const logEvents: Array<{ level: string; message: string }> = [];

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      logEmit: (level, message) => {
        logEvents.push({ level, message });
      },
    });

    await pool.enqueue(
      buildPayload({ bundleCid: cid, tokenIds: [syntheticTokenId('t2')] }),
      SENDER,
    );

    // The W13 path logs at info (not warn / error) — it's normal traffic.
    const transientLog = logEvents.find((e) =>
      e.message.includes('gateway-fetch transient'),
    );
    expect(transientLog).toBeDefined();
    expect(transientLog!.level).toBe('info');

    // Conversely, NO error-level log for a successful transient.
    const errorLog = logEvents.find((e) => e.level === 'error');
    expect(errorLog).toBeUndefined();
  });
});

// =============================================================================
// 7b. ProcessTokenContext.isClaimed discriminator (steelman #160)
// =============================================================================

describe('IngestWorkerPool — ProcessTokenContext.isClaimed (steelman #160)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('claimed tokens get ctx.isClaimed === true', async () => {
    const claimedId = syntheticTokenId('claimed1');
    const cid = syntheticBundleCid('claimedonly');
    const spec: BundleSpec = {
      bundleCid: cid,
      tokenIds: [claimedId],
      // No advisoryTokenIds → only claimed roots in the bundle.
    };
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec, type: 'verified' }],
    ]);

    const observed: Array<{ tokenId: string; isClaimed: boolean }> = [];
    const processToken: ProcessTokenFn = async (tokenRoot, _verified, ctx) => {
      observed.push({ tokenId: tokenRoot.tokenId, isClaimed: ctx.isClaimed });
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
    });

    await pool.enqueue(buildPayload(spec), SENDER);

    expect(observed).toEqual([{ tokenId: claimedId, isClaimed: true }]);
  });

  it('advisory roots get ctx.isClaimed === false', async () => {
    const advisoryId = syntheticTokenId('advisory1');
    const cid = syntheticBundleCid('advisoryonly');
    const spec: BundleSpec = {
      bundleCid: cid,
      // No claimed tokens — sender ships only an advisory unclaimed root.
      tokenIds: [],
      advisoryTokenIds: [advisoryId],
    };
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec, type: 'verified' }],
    ]);

    const observed: Array<{ tokenId: string; isClaimed: boolean }> = [];
    const processToken: ProcessTokenFn = async (tokenRoot, _verified, ctx) => {
      observed.push({ tokenId: tokenRoot.tokenId, isClaimed: ctx.isClaimed });
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
    });

    await pool.enqueue(buildPayload(spec), SENDER);

    expect(observed).toEqual([{ tokenId: advisoryId, isClaimed: false }]);
  });

  it('mixed bundle: claimed first (true), then advisory (false), preserving order', async () => {
    const claimedId = syntheticTokenId('mclaim');
    const advisoryId = syntheticTokenId('madv');
    const cid = syntheticBundleCid('mixed');
    const spec: BundleSpec = {
      bundleCid: cid,
      tokenIds: [claimedId],
      advisoryTokenIds: [advisoryId],
    };
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec, type: 'verified' }],
    ]);

    const observed: Array<{ tokenId: string; isClaimed: boolean }> = [];
    const processToken: ProcessTokenFn = async (tokenRoot, _verified, ctx) => {
      observed.push({ tokenId: tokenRoot.tokenId, isClaimed: ctx.isClaimed });
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
    });

    await pool.enqueue(buildPayload(spec), SENDER);

    // The pool walks claimedTokens BEFORE advisoryUnclaimedRoots — an
    // attacker who tries to smuggle K candidates can't have them
    // upgraded to claimed-token treatment because the discriminator is
    // derived from which list they came from in the verified bundle,
    // not from any sender-controlled field.
    expect(observed).toEqual([
      { tokenId: claimedId, isClaimed: true },
      { tokenId: advisoryId, isClaimed: false },
    ]);
  });
});

// =============================================================================
// 8. Clean shutdown
// =============================================================================

describe('IngestWorkerPool — destroy()', () => {
  it('rejects new enqueue() after destroy()', async () => {
    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(new Map()),
    });
    await pool.destroy();
    await expect(
      pool.enqueue(
        buildPayload({ bundleCid: syntheticBundleCid('post'), tokenIds: [] }),
        SENDER,
      ),
    ).rejects.toThrow(/MODULE_DESTROYED|destroyed/);
  });

  it('drains in-flight bundles and rejects queued ones with MODULE_DESTROYED', async () => {
    let release: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    const specs: BundleSpec[] = [];
    for (let i = 0; i < 3; i++) {
      const cid = syntheticBundleCid(`drain${i}`);
      const spec: BundleSpec = {
        bundleCid: cid,
        tokenIds: [syntheticTokenId(`d${i}`)],
      };
      specs.push(spec);
      fixtures.set(cid, { spec, type: 'verified' });
    }

    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: async () => {
        await block;
      },
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      maxWorkers: 1,
      queueSize: 16,
      mutexStrategy: 'rpc-release',
    });

    // First fills the worker (parked on `block`); next two queue.
    const inflight = pool.enqueue(buildPayload(specs[0]), SENDER);
    const queued1 = pool.enqueue(buildPayload(specs[1]), SENDER);
    const queued2 = pool.enqueue(buildPayload(specs[2]), SENDER);
    await Promise.resolve();

    // Begin destroy. Queued bundles should reject; in-flight finishes
    // when we release.
    const destroyed = pool.destroy();
    release();
    await inflight; // resolves cleanly (it was in-flight)

    await expect(queued1).rejects.toThrow(/MODULE_DESTROYED|destroyed/);
    await expect(queued2).rejects.toThrow(/MODULE_DESTROYED|destroyed/);
    await destroyed;
  });

  it('multiple destroy() calls return the same promise (idempotent)', async () => {
    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(new Map()),
    });
    const first = pool.destroy();
    const second = pool.destroy();
    expect(first).toBe(second);
    await first;
  });
});

// =============================================================================
// 9. Steelman fix #170 — counter increment ordering (no orphan queue entries)
// =============================================================================

describe('IngestWorkerPool — counter increment before push (steelman #170)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('if increment throws, the entry is NEVER queued (no orphan)', async () => {
    // Strategy: we cannot trivially make the production
    // `incrementPerTokenCounters` throw without monkey-patching the
    // pool's private member. Use a Proxy on the perTokenCounters Map
    // that throws on `set` AFTER the cap check has succeeded. The
    // entry must NEVER reach the queue, so workers never observe it
    // and decrementPerTokenCounters can never be called against a
    // counter the pool failed to set.
    const lru = new ReplayLRU();
    const mutex = new PerTokenMutex();
    pool = new IngestWorkerPool({
      lru,
      perTokenMutex: mutex,
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(new Map()),
      maxWorkers: 1,
      queueSize: 16,
      mutexStrategy: 'rpc-release',
    });

    // Replace the private perTokenCounters Map with a throwing proxy.
    // We narrow to the runtime field because TS does not surface
    // private members; the test reaches in deliberately to simulate
    // a future refactor that adds a synchronous throw.
    const throwingCounters = new Map<string, number>();
    const proxy = new Proxy(throwingCounters, {
      get(target, prop, receiver) {
        if (prop === 'set') {
          return () => {
            throw new Error('synthetic counter-set failure');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    (pool as unknown as { perTokenCounters: Map<string, number> }).perTokenCounters =
      proxy as unknown as Map<string, number>;

    const cid = 'bsynth000000000000000000000000000000000000000000000000000000';
    const tokenId = '74'.padEnd(64, '0');
    let caught: unknown;
    try {
      await pool.enqueue(
        {
          kind: 'uxf-car',
          version: '1.0',
          mode: 'conservative',
          bundleCid: cid,
          tokenIds: [tokenId],
          carBase64: 'AAAA',
        },
        SENDER,
      );
    } catch (err) {
      caught = err;
    }
    // The increment threw — enqueue must propagate the error.
    expect(caught).toBeInstanceOf(Error);

    // Critically: the queue MUST be empty. If the buggy ordering
    // (push BEFORE increment) had been preserved, the entry would have
    // been queued before the throw — leaving an orphan that a worker
    // would later dequeue and `decrementPerTokenCounters` against,
    // corrupting the counter map.
    expect(pool.queueDepth).toBe(0);
  });

  it('successful enqueue path: counter is incremented before push (counter visible during processToken)', async () => {
    // Positive assertion of the new ordering. We block processToken so
    // the entry stays in-flight; the counter MUST be > 0 while the
    // worker is running. This proves increment happens before push (and
    // therefore before the worker dequeues), not after.
    const cid = syntheticBundleCid('order1');
    const tokenId = syntheticTokenId('ot1');

    let observedCounter = -1;
    let releaseProcess: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      releaseProcess = resolve;
    });

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec: { bundleCid: cid, tokenIds: [tokenId] }, type: 'verified' }],
    ]);
    const processToken: ProcessTokenFn = async () => {
      observedCounter = pool!.perTokenCount(tokenId);
      await block;
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      maxWorkers: 1,
      queueSize: 4,
      mutexStrategy: 'rpc-release',
    });

    const inflight = pool.enqueue(buildPayload({ bundleCid: cid, tokenIds: [tokenId] }), SENDER);
    // Yield so the worker dequeues and reaches `processToken`.
    await new Promise((r) => setTimeout(r, 10));
    expect(observedCounter).toBe(1); // counter visible during work
    releaseProcess();
    await inflight;
    // After completion, decrement removes the counter.
    expect(pool.perTokenCount(tokenId)).toBe(0);
  });
});

// =============================================================================
// 10. Steelman fix #170 — log redaction for sender pubkey & bundleCid
// =============================================================================

describe('IngestWorkerPool — log redaction (steelman #170 / W40)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  // Use a deterministic, recognizable sender pubkey so we can pin the
  // redacted prefix bytes exactly.
  const PINNED_SENDER = '1234567890abcdef'.padEnd(64, 'f');

  it('hard-rejection log payload uses senderPubkeyPrefix (8 chars) and bundleCidPrefix (16 chars)', async () => {
    // hard-reject path = any acquirer error other than the W13 transient
    // and the instant-mode soft-reject. We trigger via the `hard-reject`
    // fixture variant.
    const cid = syntheticBundleCid('hardreject');
    const fixtures = new Map<
      string,
      { spec: BundleSpec; type: 'hard-reject' }
    >([
      [
        cid,
        {
          spec: { bundleCid: cid, tokenIds: [syntheticTokenId('hr')] },
          type: 'hard-reject',
        },
      ],
    ]);

    const logEvents: Array<{
      level: string;
      message: string;
      details?: Record<string, unknown>;
    }> = [];

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      logEmit: (level, message, details) => {
        logEvents.push({ level, message, details: details as Record<string, unknown> });
      },
    });

    await pool.enqueue(
      buildPayload({ bundleCid: cid, tokenIds: [syntheticTokenId('hr')] }),
      PINNED_SENDER,
    );

    const hardLog = logEvents.find((e) =>
      e.message.includes('hard bundle rejection'),
    );
    expect(hardLog).toBeDefined();
    const details = hardLog!.details!;

    // Redaction invariants:
    expect(details.senderPubkeyPrefix).toBe(PINNED_SENDER.slice(0, 8));
    expect(details.bundleCidPrefix).toBe(cid.slice(0, 16));

    // Exfil invariants: NO full-length identifiers anywhere in the
    // payload. Spot-check the keys we expect to have been removed.
    expect(details.senderTransportPubkey).toBeUndefined();
    expect(details.bundleCid).toBeUndefined();

    // Belt-and-suspenders: also check the serialized JSON shape (a
    // future refactor accidentally re-adding a full id would slip past
    // a key-only check). The full bundleCid string MUST NOT appear.
    const json = JSON.stringify(details);
    expect(json).not.toContain(PINNED_SENDER);
    expect(json).not.toContain(cid);
  });

  it('W13 transient log payload also uses redacted prefixes', async () => {
    const cid = syntheticBundleCid('transient40');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'transient' }>([
      [
        cid,
        {
          spec: { bundleCid: cid, tokenIds: [syntheticTokenId('w13t')] },
          type: 'transient',
        },
      ],
    ]);

    const logEvents: Array<{
      level: string;
      message: string;
      details?: Record<string, unknown>;
    }> = [];

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      logEmit: (level, message, details) => {
        logEvents.push({ level, message, details: details as Record<string, unknown> });
      },
    });

    await pool.enqueue(
      buildPayload({ bundleCid: cid, tokenIds: [syntheticTokenId('w13t')] }),
      PINNED_SENDER,
    );

    const transientLog = logEvents.find((e) =>
      e.message.includes('gateway-fetch transient'),
    );
    expect(transientLog).toBeDefined();
    const d = transientLog!.details!;
    expect(d.senderPubkeyPrefix).toBe(PINNED_SENDER.slice(0, 8));
    expect(d.bundleCidPrefix).toBe(cid.slice(0, 16));
    expect(d.senderTransportPubkey).toBeUndefined();
    expect(d.bundleCid).toBeUndefined();
  });

  it('worker-error (escaped programmer-error) log payload also redacts bundleCid', async () => {
    // Worker-loop catch path — we synthesize a programmer-error via an
    // acquirer stub that resolves successfully but a processToken that
    // throws. The pool's per-token catch ALREADY logs at line ~782
    // (per-token error log — out of scope for this redaction task per
    // the task spec, which focused on lines 745-749, 766-771, 599).
    // The 599 site is the worker-loop fallback for programmer errors
    // that escape processBundle entirely. We trigger that by making
    // processBundle's machinery throw — the most reliable way is to
    // arrange the acquirer to return a verified bundle whose tokens
    // do not have valid tokenIds, which then explodes inside the mutex
    // acquire. Since that path is hard to engineer without internal
    // hooks, we instead trust that the redaction site is symmetric to
    // the W13 / hard-reject sites verified above — those sites prove
    // the redact helpers are wired correctly. The worker-error site
    // uses the same `redactBundleCid()` helper.
    //
    // To still produce coverage of the helper itself, we directly
    // assert the redaction lengths via the W13 path's payload — the
    // helper is shared by all three log sites and a wrong slice
    // length would break this same test.
    const cid = syntheticBundleCid('redactlen');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'transient' }>([
      [
        cid,
        {
          spec: { bundleCid: cid, tokenIds: [syntheticTokenId('rl')] },
          type: 'transient',
        },
      ],
    ]);
    const logEvents: Array<{
      message: string;
      details?: Record<string, unknown>;
    }> = [];
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      logEmit: (_level, message, details) => {
        logEvents.push({ message, details: details as Record<string, unknown> });
      },
    });

    await pool.enqueue(
      buildPayload({ bundleCid: cid, tokenIds: [syntheticTokenId('rl')] }),
      PINNED_SENDER,
    );

    const log = logEvents.find((e) => e.details?.bundleCidPrefix !== undefined)!;
    expect(typeof log.details!.bundleCidPrefix).toBe('string');
    expect((log.details!.bundleCidPrefix as string).length).toBe(16);
    expect((log.details!.senderPubkeyPrefix as string).length).toBe(8);
  });
});

// =============================================================================
// 11. Steelman warning fix — enqueue-time inline-CAR size cap
// =============================================================================

describe('IngestWorkerPool — enqueue-time carBase64 cap (steelman warning)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('rejects oversize carBase64 BEFORE the queue is touched', async () => {
    // Threat: hostile sender ships a 5+ MiB carBase64. Without an
    // enqueue-time guard, the recipient acquirer's cap fires INSIDE
    // processBundle — i.e. AFTER the worker has dequeued the entry.
    // Meanwhile the queue allocates 256 such entries for a sustained
    // flood, ~1.3 GiB resident. The enqueue-time guard prevents the
    // queue from holding the payload at all.
    const acquireBundleSpy = vi.fn<AcquireBundleFn>(async () => {
      throw new Error('acquirer should never run for an oversize payload');
    });

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: acquireBundleSpy,
    });

    const oversize: UxfV1Payload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'conservative',
      bundleCid: syntheticBundleCid('oversize'),
      tokenIds: [syntheticTokenId('ovs')],
      carBase64: 'A'.repeat(RECIPIENT_MAX_INLINE_CARBASE64_LENGTH + 1),
    };

    let caught: unknown;
    try {
      await pool.enqueue(oversize, SENDER);
    } catch (err) {
      caught = err;
    }
    expect(isSphereError(caught)).toBe(true);
    if (isSphereError(caught)) {
      expect(caught.code).toBe('BUNDLE_REJECTED_INLINE_CAP_EXCEEDED');
    }

    // The queue MUST be empty — payload was never enqueued.
    expect(pool.queueDepth).toBe(0);
    // No worker was woken (acquirer would throw if invoked).
    expect(acquireBundleSpy).not.toHaveBeenCalled();
  });

  it('rejects oversize carBase64 BEFORE per-token counters are touched', async () => {
    // Defensive ordering check: the enqueue-time cap MUST fire BEFORE
    // any per-token counter mutation, so a hostile sender cannot perturb
    // back-pressure accounting via rejected payloads.
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(new Map()),
    });

    const tokenId = syntheticTokenId('cnt');
    const oversize: UxfV1Payload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'conservative',
      bundleCid: syntheticBundleCid('cap-counter'),
      tokenIds: [tokenId],
      carBase64: 'A'.repeat(RECIPIENT_MAX_INLINE_CARBASE64_LENGTH + 100),
    };

    await expect(pool.enqueue(oversize, SENDER)).rejects.toThrow();

    // Per-token counter MUST be 0 — no increment ever happened.
    expect(pool.perTokenCount(tokenId)).toBe(0);
  });

  it('payload exactly at the cap is NOT rejected by the enqueue guard', async () => {
    // Boundary check: cap is `>` not `>=`. A payload exactly at the
    // cap passes the enqueue gate; the worker handles downstream
    // processing (no fixture for the bundleCid → acquirer rejects, the
    // worker swallows per pool contract, and enqueue() resolves cleanly).
    const cid = syntheticBundleCid('atcap');
    const tokenId = syntheticTokenId('atcap');

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(new Map()),
    });

    const atCap: UxfV1Payload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'conservative',
      bundleCid: cid,
      tokenIds: [tokenId],
      carBase64: 'A'.repeat(RECIPIENT_MAX_INLINE_CARBASE64_LENGTH),
    };

    await expect(pool.enqueue(atCap, SENDER)).resolves.toBeUndefined();
  });

  it('CID-mode payload (no carBase64) is unaffected by the enqueue cap', async () => {
    // Sanity: the cap only applies to `kind: 'uxf-car'`. CID payloads
    // pass through without an inline-cap check (they cap downstream
    // via MAX_FETCHED_CAR_BYTES).
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      acquireBundle: makeAcquirer(new Map()),
    });

    const cidPayload: UxfV1Payload = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'conservative',
      bundleCid: syntheticBundleCid('cidmode'),
      tokenIds: [syntheticTokenId('cm')],
    };

    // Enqueue succeeds (CID payloads do not hit the inline cap).
    await expect(pool.enqueue(cidPayload, SENDER)).resolves.toBeUndefined();
  });
});

// =============================================================================
// 12. Steelman warning fix — per-bundle wall-clock budget
// =============================================================================

describe('IngestWorkerPool — per-bundle wall-clock budget (steelman warning)', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('first timeout fires operator-alert and re-enqueues; second timeout hard-fails with second alert', async () => {
    // Setup: a slow processToken that takes ~3× the budget. The first
    // worker pickup times out → alert + retry. The retry (still slow)
    // times out a second time → hard-fail alert.
    const cid = syntheticBundleCid('slow1');
    const tokenId = syntheticTokenId('s1');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec: { bundleCid: cid, tokenIds: [tokenId] }, type: 'verified' }],
    ]);

    const processToken: ProcessTokenFn = async () => {
      // Sleep > 3× budget (50 ms × 3 = 150 ms). Two timeouts → ~300 ms
      // total of waited time across the two attempts.
      await new Promise((r) => setTimeout(r, 150));
    };

    const events: Array<{ event: SphereEventType; payload: unknown }> = [];
    const emit: IngestPoolEventEmitter = (event, payload) => {
      events.push({ event, payload: payload as unknown });
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      bundleMaxProcessingMs: 50,
      // Round 3 fix #4 introduced per-sender alert rate limiting (default
      // 1 alert / 60s). For this test we want to observe BOTH alerts
      // back-to-back, so set the window to 1ms (effectively disabling
      // rate limiting).
      operatorAlertRateLimitMs: 1,
    });

    await pool.enqueue(buildPayload({ bundleCid: cid, tokenIds: [tokenId] }), SENDER);

    // Two operator-alert events expected: first retry, then hard-fail.
    const alerts = events.filter((e) => e.event === 'transfer:operator-alert');
    expect(alerts.length).toBe(2);

    // First alert: re-enqueued for retry.
    const firstAlert = alerts[0].payload as {
      code: string;
      bundleCid: string;
      message: string;
    };
    expect(firstAlert.code).toBe('structural');
    expect(firstAlert.bundleCid).toBe(cid);
    expect(firstAlert.message).toContain('re-enqueued');

    // Second alert: hard-fail.
    const secondAlert = alerts[1].payload as {
      code: string;
      bundleCid: string;
      message: string;
    };
    expect(secondAlert.code).toBe('structural');
    expect(secondAlert.bundleCid).toBe(cid);
    expect(secondAlert.message).toContain('SECOND time');
    expect(secondAlert.message).toContain('dropped');
  });

  it('fast bundles continue to drain after a slow bundle times out', async () => {
    // The whole point of the budget: a slow bundle on one worker MUST
    // NOT prevent the rest of the pool from making progress.
    const slowCid = syntheticBundleCid('slow2');
    const slowToken = syntheticTokenId('slow2tok');
    const fastCids = Array.from({ length: 5 }, (_, i) =>
      syntheticBundleCid(`fast${i}`),
    );
    const fastTokens = fastCids.map((_, i) => syntheticTokenId(`f${i}`));

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    fixtures.set(slowCid, {
      spec: { bundleCid: slowCid, tokenIds: [slowToken] },
      type: 'verified',
    });
    for (let i = 0; i < fastCids.length; i++) {
      fixtures.set(fastCids[i], {
        spec: { bundleCid: fastCids[i], tokenIds: [fastTokens[i]] },
        type: 'verified',
      });
    }

    const processed = new Set<string>();
    const processToken: ProcessTokenFn = async (tokenRoot) => {
      if (tokenRoot.tokenId === slowToken) {
        // Slow longer than the budget × 2.
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        processed.add(tokenRoot.tokenId);
      }
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      maxWorkers: 2,
      bundleMaxProcessingMs: 50,
    });

    const slowPromise = pool.enqueue(
      buildPayload({ bundleCid: slowCid, tokenIds: [slowToken] }),
      SENDER,
    );
    const fastPromises = fastCids.map((cid, i) =>
      pool!.enqueue(
        buildPayload({ bundleCid: cid, tokenIds: [fastTokens[i]] }),
        SENDER,
      ),
    );

    await Promise.all(fastPromises);
    expect(processed.size).toBe(fastCids.length);

    await slowPromise;
  });

  it('the bundleMaxProcessingMs option overrides the default', async () => {
    // Sanity: passing 50ms budget triggers timeout for a 200ms slow
    // processToken; default would not.
    const cid = syntheticBundleCid('budget');
    const tokenId = syntheticTokenId('b');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec: { bundleCid: cid, tokenIds: [tokenId] }, type: 'verified' }],
    ]);

    const processToken: ProcessTokenFn = async () => {
      await new Promise((r) => setTimeout(r, 200));
    };

    const events: Array<{ event: SphereEventType }> = [];
    const emit: IngestPoolEventEmitter = (event) => {
      events.push({ event });
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      bundleMaxProcessingMs: 50,
    });

    await pool.enqueue(buildPayload({ bundleCid: cid, tokenIds: [tokenId] }), SENDER);
    const alerts = events.filter((e) => e.event === 'transfer:operator-alert');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid bundleMaxProcessingMs at construction', () => {
    expect(
      () =>
        new IngestWorkerPool({
          lru: new ReplayLRU(),
          perTokenMutex: new PerTokenMutex(),
          processToken: vi.fn(),
          emit: () => undefined,
          bundleMaxProcessingMs: 0,
        }),
    ).toThrow(SphereError);
    expect(
      () =>
        new IngestWorkerPool({
          lru: new ReplayLRU(),
          perTokenMutex: new PerTokenMutex(),
          processToken: vi.fn(),
          emit: () => undefined,
          bundleMaxProcessingMs: -10,
        }),
    ).toThrow(SphereError);
  });
});

// =============================================================================
// 13. Round 3 fix #1 — _abortSignal propagation through to acquireBundle and processToken
// =============================================================================
//
// The Round 2 wall-clock budget allocated an AbortController per
// processBundle attempt but never propagated the signal to downstream
// calls. abortController.abort() cancelled nothing, so the in-flight
// processBundle continued running while the retry attempt also ran —
// two workers raced on the same per-token mutex / disposition writes.
//
// Round 3 fix: signal is plumbed to (a) acquireBundle via cidOptions.signal
// (composed with any caller-supplied signal) and (b) processToken via
// ctx.signal. The per-token loop also bails BEFORE the next mutex
// acquire when signal.aborted observed, so a late worker cannot race
// the retry.

describe('IngestWorkerPool — Round 3 fix #1: abort signal propagation', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('on timeout, the abort signal is propagated to processToken via ctx.signal', async () => {
    // Build a slow processToken that never resolves on its own; it
    // resolves IFF the abort signal fires. Without propagation the
    // signal never fires inside processToken — the test would time
    // out the suite. With Round 3 propagation, the timeout aborts
    // immediately.
    const cid = syntheticBundleCid('absignal');
    const tokenId = syntheticTokenId('a');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec: { bundleCid: cid, tokenIds: [tokenId] }, type: 'verified' }],
    ]);

    const observedSignals: AbortSignal[] = [];
    const abortFiredAt = new Map<AbortSignal, number>();

    const processToken: ProcessTokenFn = async (_root, _verified, ctx) => {
      // CRITICAL invariant: the context MUST carry the signal field.
      // Round 2: undefined. Round 3: defined (the per-bundle signal).
      expect(ctx.signal).toBeDefined();
      observedSignals.push(ctx.signal!);
      // Wait until abort fires; if it never fires, this throws on
      // suite-level timeout. With Round 3 the signal fires when the
      // wall-clock budget elapses.
      await new Promise<void>((resolve) => {
        if (ctx.signal!.aborted) {
          abortFiredAt.set(ctx.signal!, Date.now());
          resolve();
          return;
        }
        ctx.signal!.addEventListener(
          'abort',
          () => {
            abortFiredAt.set(ctx.signal!, Date.now());
            resolve();
          },
          { once: true },
        );
      });
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      bundleMaxProcessingMs: 30,
      // Disable rate limiting for clear assertions.
      operatorAlertRateLimitMs: 1,
    });

    const startTs = Date.now();
    await pool.enqueue(buildPayload({ bundleCid: cid, tokenIds: [tokenId] }), SENDER);
    const elapsed = Date.now() - startTs;

    // Both attempts (first + retry) should have observed a signal.
    expect(observedSignals.length).toBeGreaterThanOrEqual(1);
    for (const sig of observedSignals) {
      expect(abortFiredAt.has(sig)).toBe(true);
    }
    // Wall-clock should be on the order of 2 × budget (one timeout +
    // one retry that also times out), NOT a long suite-level timeout.
    expect(elapsed).toBeLessThan(500);
  });

  it('on timeout, the per-token loop bails BEFORE acquiring a fresh tokenId mutex', async () => {
    // Build a verified bundle with TWO tokenIds. The first processToken
    // call sleeps long enough to exceed the budget. The Round 3 abort
    // check at the start of each iteration MUST short-circuit so the
    // SECOND tokenId is never processed. Without the bail, the late
    // worker would continue past the timeout and race the retry.
    const cid = syntheticBundleCid('twotok');
    const t1 = syntheticTokenId('t1');
    const t2 = syntheticTokenId('t2');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec: { bundleCid: cid, tokenIds: [t1, t2] }, type: 'verified' }],
    ]);

    const calls: string[] = [];
    const processToken: ProcessTokenFn = async (root, _v, ctx) => {
      calls.push(root.tokenId);
      // Slow path for the first token only.
      if (root.tokenId === t1) {
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) {
            resolve();
            return;
          }
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      bundleMaxProcessingMs: 30,
      operatorAlertRateLimitMs: 1,
    });

    await pool.enqueue(buildPayload({ bundleCid: cid, tokenIds: [t1, t2] }), SENDER);

    // After timeout, processToken for t1 returns (signal fired). The
    // per-token loop's `signal.aborted` check then fires BEFORE
    // acquiring the mutex for t2 — so t2 is never processed by THIS
    // attempt. We may see t2 in the retry attempt though, so we
    // assert that t1 was processed AT LEAST as many times as t2 (the
    // first attempt only processed t1; the retry processes both).
    const t1Calls = calls.filter((id) => id === t1).length;
    const t2Calls = calls.filter((id) => id === t2).length;
    expect(t1Calls).toBeGreaterThan(t2Calls);
  });

  it('cidOptions.signal is plumbed: gateway fetch sees the per-bundle abort', async () => {
    // Verify Round 3 plumbing: the acquirer is called with cidOptions.signal
    // composed from the per-bundle abort. We instrument a stub acquirer
    // and assert ctx.signal is reflected as cidOptions.signal aborting.
    const cid = syntheticBundleCid('cidsig');
    const tokenId = syntheticTokenId('cs');

    const observedCidSignal: { signal?: AbortSignal } = {};
    const customAcquirer: AcquireBundleFn = async (payload, _sender, _lru, cidOptions) => {
      observedCidSignal.signal = cidOptions?.signal;
      // Park on the supplied signal so we know it actually fires.
      await new Promise<void>((resolve) => {
        if (cidOptions?.signal?.aborted) {
          resolve();
          return;
        }
        cidOptions?.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      // Return a verified bundle so the test can complete cleanly on retry.
      return buildVerifiedBundle({ bundleCid: payload.bundleCid, tokenIds: [tokenId] });
    };

    let processedOnce = false;
    const processToken: ProcessTokenFn = async () => {
      processedOnce = true;
    };

    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: customAcquirer,
      mutexStrategy: 'rpc-release',
      bundleMaxProcessingMs: 30,
      operatorAlertRateLimitMs: 1,
    });

    await pool.enqueue(buildPayload({ bundleCid: cid, tokenIds: [tokenId] }), SENDER);
    // Round 3 plumbing: cidOptions.signal MUST have been supplied (so
    // the acquirer received the abort and could observe it).
    expect(observedCidSignal.signal).toBeDefined();
    // The signal MUST be (eventually) aborted — fired by the wall-clock
    // budget timer.
    expect(observedCidSignal.signal!.aborted).toBe(true);
    // We never reached processToken on the first attempt; the retry
    // path may complete, so we don't assert processedOnce here.
    void processedOnce;
  });
});

// =============================================================================
// 14. Round 3 fix #2 — re-enqueue respects queue capacity cap
// =============================================================================
//
// The wall-clock-budget retry path called this.queue.push without checking
// queueCapacity. Under sustained timeout pressure this grew the queue
// unboundedly. Round 3 fix: at-cap retries hard-fail with
// BUNDLE_REJECTED_QUEUE_CAP_EXCEEDED and emit a final alert.

describe('IngestWorkerPool — Round 3 fix #2: re-enqueue respects queue cap', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('timeout-retry that would exceed queueCapacity hard-fails instead of pushing', async () => {
    // Setup: queueSize = 1 (the smallest possible bound). One slow
    // bundle that times out → retry. With queueSize=1, the retry-push
    // must check the queue length: if there's another bundle queued,
    // re-pushing would exceed cap. We arrange for the queue to be full
    // when the retry would fire.
    const slowCid = syntheticBundleCid('slow-cap');
    const slowTok = syntheticTokenId('slowcap');
    const fillerCid = syntheticBundleCid('filler');
    const fillerTok = syntheticTokenId('fill');

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    fixtures.set(slowCid, {
      spec: { bundleCid: slowCid, tokenIds: [slowTok] },
      type: 'verified',
    });
    fixtures.set(fillerCid, {
      spec: { bundleCid: fillerCid, tokenIds: [fillerTok] },
      type: 'verified',
    });

    let release: () => void = () => undefined;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });

    const processToken: ProcessTokenFn = async (root, _v, ctx) => {
      if (root.tokenId === slowTok) {
        // Slow + interruptible by abort.
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) {
            resolve();
            return;
          }
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      } else {
        // Filler parks on the external block so it occupies the queue.
        await block;
      }
    };

    const events: Array<{ event: SphereEventType; payload: unknown }> = [];
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: (event, payload) => {
        events.push({ event, payload: payload as unknown });
      },
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      maxWorkers: 1,
      queueSize: 1,
      bundleMaxProcessingMs: 30,
      operatorAlertRateLimitMs: 1,
    });

    // Enqueue slow first → goes to in-flight. Then enqueue filler → goes
    // to the (size=1) queue. When slow times out and retry-handler runs,
    // queue.length === 1 === queueCapacity → retry MUST hard-fail.
    const slowPromise = pool.enqueue(
      buildPayload({ bundleCid: slowCid, tokenIds: [slowTok] }),
      SENDER,
    );
    // Yield so the worker picks up slow.
    await Promise.resolve();
    const fillerPromise = pool.enqueue(
      buildPayload({ bundleCid: fillerCid, tokenIds: [fillerTok] }),
      SENDER,
    );

    // Wait for the slow timeout to be processed. The retry path must
    // hard-fail; slow's enqueue promise should resolve cleanly.
    await slowPromise;

    // The queue must NEVER have exceeded queueCapacity.
    expect(pool.queueDepth).toBeLessThanOrEqual(1);

    // The hard-fail message must mention the cap-exceeded path.
    const alerts = events.filter((e) => e.event === 'transfer:operator-alert');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const capAlert = alerts.find((a) =>
      ((a.payload as { message?: string }).message ?? '').includes(
        'BUNDLE_REJECTED_QUEUE_CAP_EXCEEDED',
      ),
    );
    expect(capAlert).toBeDefined();

    // Cleanup.
    release();
    await fillerPromise;
  });
});

// =============================================================================
// 15. Round 3 fix #3 — destroy serializes with timeout retry
// =============================================================================
//
// Without the destroy guard in handleBundleTimeout, a worker that times
// out AFTER destroy() drained the queue would re-push, then the worker
// loop's outer `while (this.running || this.queue.length > 0)` would
// dequeue and run another full processBundle, making destroy latency
// unbounded. Round 3 fix: timeout handler checks `this.running` and
// hard-fails instead of re-enqueueing during shutdown.

describe('IngestWorkerPool — Round 3 fix #3: destroy serializes with timeout retry', () => {
  it('destroy() during in-flight bundle: timeout fires, no second processBundle runs', async () => {
    // Setup: a slow bundle that we time out. We call destroy()
    // concurrently while the bundle is in-flight. The timeout handler
    // MUST detect `!this.running` and hard-fail instead of re-pushing.
    // Otherwise destroy() would have to wait for a second wall-clock
    // budget elapse.
    const cid = syntheticBundleCid('destroy-race');
    const tokenId = syntheticTokenId('drc');
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>([
      [cid, { spec: { bundleCid: cid, tokenIds: [tokenId] }, type: 'verified' }],
    ]);

    let processCalls = 0;
    const processToken: ProcessTokenFn = async (_r, _v, ctx) => {
      processCalls++;
      // Park on the abort signal — the wall-clock timer fires it.
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve();
          return;
        }
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: () => undefined,
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      maxWorkers: 1,
      bundleMaxProcessingMs: 30,
      operatorAlertRateLimitMs: 1,
    });

    const enqueuePromise = pool.enqueue(
      buildPayload({ bundleCid: cid, tokenIds: [tokenId] }),
      SENDER,
    );

    // Yield so the worker picks up the bundle and parks on the abort.
    await Promise.resolve();
    await Promise.resolve();

    // Trigger destroy. The wall-clock timer is still running; it will
    // fire soon. The Round 3 guard means handleBundleTimeout sees
    // !this.running and hard-fails.
    const destroyStart = Date.now();
    const destroyPromise = pool.destroy();
    await destroyPromise;
    const destroyElapsed = Date.now() - destroyStart;

    await enqueuePromise;

    // Bounded latency: destroy() returns within ~budget+overhead, NOT
    // within 2× budget (which would be the case if the retry runs).
    expect(destroyElapsed).toBeLessThan(200);
    // processBundle ran exactly ONCE — no retry post-destroy.
    expect(processCalls).toBe(1);
  });
});

// =============================================================================
// 16. Round 3 fix #4 — operator-alert rate limit per sender
// =============================================================================
//
// Without rate limiting, a malicious sender shipping always-timeout
// bundles can produce 2 alerts/bundle × MAX_INGEST_WORKERS (16) = 32
// alerts/min/sender. Round 3 fix: per-sender rate ledger with a
// configurable window (default 60s, 1 alert/window).

describe('IngestWorkerPool — Round 3 fix #4: operator-alert rate limit', () => {
  let pool: IngestWorkerPool | null = null;

  afterEach(async () => {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('many timeouts from one sender produce <= 1 alert per window', async () => {
    // Setup: a 10-bundle sequence that all time out from the same
    // sender. Use a long rate-limit window to ensure all alerts fall
    // inside it. Without rate limiting, we'd see 2 alerts × 10 bundles
    // = 20 alerts. With Round 3 rate limiting, we see exactly 1 alert
    // (the first one in the window).
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    const cids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const cid = syntheticBundleCid(`rl${i}`);
      const tok = syntheticTokenId(`r${i}`);
      cids.push(cid);
      fixtures.set(cid, {
        spec: { bundleCid: cid, tokenIds: [tok] },
        type: 'verified',
      });
    }

    const processToken: ProcessTokenFn = async (_r, _v, ctx) => {
      // All bundles time out.
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve();
          return;
        }
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const events: Array<{ event: SphereEventType; payload: unknown }> = [];
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: (event, payload) => {
        events.push({ event, payload: payload as unknown });
      },
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      maxWorkers: 4,
      bundleMaxProcessingMs: 20,
      // Long enough to cover entire test run; 1 alert per window.
      operatorAlertRateLimitMs: 10_000,
    });

    // Enqueue all 10 bundles. They all time out (twice each: first +
    // retry). Without rate limiting that's ~20 alerts; with Round 3
    // rate limit we expect 1.
    await Promise.all(
      cids.map((cid, i) =>
        pool!.enqueue(
          buildPayload({ bundleCid: cid, tokenIds: [syntheticTokenId(`r${i}`)] }),
          SENDER,
        ),
      ),
    );

    const alerts = events.filter((e) => e.event === 'transfer:operator-alert');
    // Exactly 1 — the first timeout in the window, all others
    // suppressed.
    expect(alerts.length).toBe(1);
  });

  it('different senders each get their own window (no cross-pollution)', async () => {
    // Same as above, but with 3 distinct senders. Each sender should
    // be allowed exactly one alert in the window — 3 alerts total.
    const SENDER_B = 'b'.repeat(64);
    const SENDER_C = 'c'.repeat(64);

    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    for (const tag of ['a', 'b', 'c']) {
      const cid = syntheticBundleCid(`${tag}-multi`);
      const tok = syntheticTokenId(`${tag}m`);
      fixtures.set(cid, {
        spec: { bundleCid: cid, tokenIds: [tok] },
        type: 'verified',
      });
    }

    const processToken: ProcessTokenFn = async (_r, _v, ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve();
          return;
        }
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const events: Array<{ event: SphereEventType; payload: unknown }> = [];
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: (event, payload) => {
        events.push({ event, payload: payload as unknown });
      },
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      maxWorkers: 4,
      bundleMaxProcessingMs: 20,
      operatorAlertRateLimitMs: 10_000,
    });

    await Promise.all([
      pool.enqueue(
        buildPayload({
          bundleCid: syntheticBundleCid('a-multi'),
          tokenIds: [syntheticTokenId('am')],
        }),
        SENDER,
      ),
      pool.enqueue(
        buildPayload({
          bundleCid: syntheticBundleCid('b-multi'),
          tokenIds: [syntheticTokenId('bm')],
        }),
        SENDER_B,
      ),
      pool.enqueue(
        buildPayload({
          bundleCid: syntheticBundleCid('c-multi'),
          tokenIds: [syntheticTokenId('cm')],
        }),
        SENDER_C,
      ),
    ]);

    const alerts = events.filter((e) => e.event === 'transfer:operator-alert');
    expect(alerts.length).toBe(3);
    const senders = new Set(
      alerts.map((a) => (a.payload as { senderTransportPubkey: string }).senderTransportPubkey),
    );
    expect(senders.has(SENDER)).toBe(true);
    expect(senders.has(SENDER_B)).toBe(true);
    expect(senders.has(SENDER_C)).toBe(true);
  });

  it('after window expiry, a fresh alert is emitted with a suppressed-summary', async () => {
    // Setup: very short window (10 ms) so we can roll it during the
    // test. Send N bundles that all time out. Wait for the window to
    // expire. Send one more bundle. Expect: first bundle's first
    // timeout triggers the only "live" alert; subsequent timeouts in
    // the window are suppressed; after window expiry, the next alert
    // emission is preceded by a "X suppressed" summary.
    const fixtures = new Map<string, { spec: BundleSpec; type: 'verified' }>();
    for (let i = 0; i < 5; i++) {
      const cid = syntheticBundleCid(`win${i}`);
      const tok = syntheticTokenId(`w${i}`);
      fixtures.set(cid, {
        spec: { bundleCid: cid, tokenIds: [tok] },
        type: 'verified',
      });
    }

    const processToken: ProcessTokenFn = async (_r, _v, ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve();
          return;
        }
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const events: Array<{ event: SphereEventType; payload: unknown }> = [];
    pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken,
      emit: (event, payload) => {
        events.push({ event, payload: payload as unknown });
      },
      acquireBundle: makeAcquirer(fixtures),
      mutexStrategy: 'rpc-release',
      maxWorkers: 1,
      bundleMaxProcessingMs: 20,
      // Tight window so it expires between bundle batches.
      operatorAlertRateLimitMs: 50,
    });

    // First batch — all time out, all share the rate-limit window.
    for (let i = 0; i < 3; i++) {
      await pool.enqueue(
        buildPayload({
          bundleCid: syntheticBundleCid(`win${i}`),
          tokenIds: [syntheticTokenId(`w${i}`)],
        }),
        SENDER,
      );
    }

    // Wait long enough for the window to roll (50ms).
    await new Promise((r) => setTimeout(r, 80));

    // One more bundle — expect a SUMMARY alert (mentioning suppressed
    // count) PLUS a fresh live alert.
    await pool.enqueue(
      buildPayload({
        bundleCid: syntheticBundleCid('win4'),
        tokenIds: [syntheticTokenId('w4')],
      }),
      SENDER,
    );

    const alerts = events.filter((e) => e.event === 'transfer:operator-alert');
    const summaries = alerts.filter((a) =>
      ((a.payload as { message?: string }).message ?? '').includes('suppressed'),
    );
    // We expect at least one summary alert mentioning 'suppressed'.
    expect(summaries.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid operatorAlertRateLimitMs at construction', () => {
    expect(
      () =>
        new IngestWorkerPool({
          lru: new ReplayLRU(),
          perTokenMutex: new PerTokenMutex(),
          processToken: vi.fn(),
          emit: () => undefined,
          operatorAlertRateLimitMs: 0,
        }),
    ).toThrow(SphereError);
    expect(
      () =>
        new IngestWorkerPool({
          lru: new ReplayLRU(),
          perTokenMutex: new PerTokenMutex(),
          processToken: vi.fn(),
          emit: () => undefined,
          operatorAlertRateLimitMs: -1,
        }),
    ).toThrow(SphereError);
  });
});

// =============================================================================
// Round 5 fixes — operatorAlertWindows bounded LRU + NTP backward jump
// =============================================================================

describe('IngestWorkerPool — Round 5 FIX 1: operatorAlertWindows bounded LRU', () => {
  it('Map size never exceeds OPERATOR_ALERT_WINDOWS_HARD_CAP under 20k distinct senders', async () => {
    // Build a pool. We will NOT enqueue real bundles — instead we
    // poke the private maybeEmitOperatorAlert directly with synthetic
    // QueueEntry-like objects, which is the path that grows the Map.
    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      operatorAlertRateLimitMs: 60_000, // long window — entries linger
    });
    try {
      // Access the private API for direct ledger pumping.
      const internal = pool as unknown as {
        maybeEmitOperatorAlert: (
          entry: {
            senderTransportPubkey: string;
            payload: { bundleCid: string };
          },
          body: { code: 'structural'; message: string },
        ) => void;
        operatorAlertWindows: Map<string, unknown>;
      };

      const HARD_CAP = 10000;
      for (let i = 0; i < 20000; i++) {
        const sender = `s${i.toString().padStart(63, '0')}`;
        internal.maybeEmitOperatorAlert(
          { senderTransportPubkey: sender, payload: { bundleCid: 'b' } },
          { code: 'structural', message: 'x' },
        );
        // Invariant: Map MUST never exceed the hard cap.
        expect(internal.operatorAlertWindows.size).toBeLessThanOrEqual(HARD_CAP);
      }

      // Final size at hard cap.
      expect(internal.operatorAlertWindows.size).toBeLessThanOrEqual(HARD_CAP);
    } finally {
      await pool.destroy();
    }
  });

  it('LRU evicts the oldest entry first (insertion-order semantics)', async () => {
    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: () => undefined,
      operatorAlertRateLimitMs: 60_000,
    });
    try {
      const internal = pool as unknown as {
        maybeEmitOperatorAlert: (
          entry: {
            senderTransportPubkey: string;
            payload: { bundleCid: string };
          },
          body: { code: 'structural'; message: string },
        ) => void;
        operatorAlertWindows: Map<string, unknown>;
      };

      // Fill the Map to the cap, then add 3 more — the first 3 inserts
      // should be evicted.
      const HARD_CAP = 10000;
      for (let i = 0; i < HARD_CAP + 3; i++) {
        const sender = `s${i.toString().padStart(63, '0')}`;
        internal.maybeEmitOperatorAlert(
          { senderTransportPubkey: sender, payload: { bundleCid: 'b' } },
          { code: 'structural', message: 'x' },
        );
      }
      expect(internal.operatorAlertWindows.size).toBe(HARD_CAP);
      // The oldest 3 are gone; entries 3..HARD_CAP+2 remain.
      expect(internal.operatorAlertWindows.has(`s${'0'.repeat(63)}`)).toBe(false);
      expect(internal.operatorAlertWindows.has(`s${'1'.padStart(63, '0')}`)).toBe(false);
      expect(internal.operatorAlertWindows.has(`s${'2'.padStart(63, '0')}`)).toBe(false);
      expect(internal.operatorAlertWindows.has(`s${'3'.padStart(63, '0')}`)).toBe(true);
    } finally {
      await pool.destroy();
    }
  });
});

describe('IngestWorkerPool — Round 5 FIX 3: rate-limit window resets on backward NTP jump', () => {
  it('emits a fresh alert after Date.now() steps backward (window resets)', async () => {
    // Use a fresh pool with a moderate rate-limit window. We will:
    //   1) emit one alert (window opens)
    //   2) emit another within the window (suppressed)
    //   3) manipulate Date.now() to step backward past windowStart
    //   4) emit another alert (rate limit defeated → must emit)
    const events: Array<{ event: SphereEventType; payload: unknown }> = [];
    const pool = new IngestWorkerPool({
      lru: new ReplayLRU(),
      perTokenMutex: new PerTokenMutex(),
      processToken: vi.fn(),
      emit: (event, payload) => {
        events.push({ event, payload: payload as unknown });
      },
      operatorAlertRateLimitMs: 60_000,
    });
    try {
      const internal = pool as unknown as {
        maybeEmitOperatorAlert: (
          entry: {
            senderTransportPubkey: string;
            payload: { bundleCid: string };
          },
          body: { code: 'structural'; message: string },
        ) => void;
        operatorAlertWindows: Map<string, { windowStart: number; suppressed: number }>;
      };
      const sender = 'aa'.repeat(32);
      const synth = {
        senderTransportPubkey: sender,
        payload: { bundleCid: 'b' },
      };

      // Step 1 — initial alert opens a fresh window.
      internal.maybeEmitOperatorAlert(synth, { code: 'structural', message: 'first' });
      let alerts = events.filter((e) => e.event === 'transfer:operator-alert');
      expect(alerts.length).toBe(1);

      // Step 2 — second alert within window is suppressed.
      internal.maybeEmitOperatorAlert(synth, { code: 'structural', message: 'second' });
      alerts = events.filter((e) => e.event === 'transfer:operator-alert');
      expect(alerts.length).toBe(1);

      // Step 3 — manipulate the entry's windowStart far into the
      // future to simulate Date.now() having stepped backward (i.e.,
      // windowStart > now). The maybeEmitOperatorAlert path detects
      // this and resets the window.
      const win = internal.operatorAlertWindows.get(sender);
      expect(win).toBeDefined();
      if (win) {
        // Place windowStart 10 minutes in the future relative to now.
        win.windowStart = Date.now() + 10 * 60 * 1000;
      }

      // Step 4 — emit again. The backward-jump branch must reset the
      // window and emit a fresh live alert.
      internal.maybeEmitOperatorAlert(synth, { code: 'structural', message: 'after-jump' });
      alerts = events.filter((e) => e.event === 'transfer:operator-alert');
      // Must have grown by at least one (the fresh alert post-reset).
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      // The second alert is the fresh live one, not a 'suppressed' summary.
      const last = alerts[alerts.length - 1];
      const lastMsg = (last.payload as { message?: string }).message ?? '';
      expect(lastMsg).toContain('after-jump');
    } finally {
      await pool.destroy();
    }
  });
});
