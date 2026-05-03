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
import type { ContentHash } from '../../../../uxf/types';
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
