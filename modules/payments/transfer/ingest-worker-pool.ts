/**
 * Ingest Worker Pool — UXF Inter-Wallet Transfer §5.0 (T.3.E).
 *
 * The dispatcher between the transport layer and the recipient-side
 * disposition pipeline. Buffers incoming bundles on a bounded queue
 * (default {@link INGEST_QUEUE_SIZE} = 256) and fans them out across
 * `MAX_INGEST_WORKERS` (default 16) parallel workers. Each worker walks
 * §5.1 → §5.2 → §5.3 → §5.4 for its assigned bundle, coordinating with
 * peers via the {@link PerTokenMutex} (T.1.F) on overlapping `tokenId`s.
 *
 * **Why a worker pool exists at all** (§5.0 verbatim):
 *   "a single rogue incoming bundle (e.g., one with a chain-mode token
 *   requiring K=64 unfinalized-tx finalization queue, or a `uxf-cid`
 *   bundle whose IPFS fetch is slow) would otherwise serialize behind
 *   every other legitimate bundle. With N workers, slow bundles consume
 *   a single worker each; the other N-1 continue serving fresh
 *   arrivals. This is a DoS defense against an attacker who deliberately
 *   crafts long-running bundles."
 *
 * **Architecture**:
 *
 *   transport.onIncomingTransfer →
 *     pool.enqueue(payload, senderPubkey)
 *       │
 *       ├─ queue length < INGEST_QUEUE_SIZE        →  push, signal a worker
 *       ├─ any claimed tokenId saturates the
 *       │  per-token cap (W7)                     →  reject INGEST_QUEUE_FULL_PER_TOKEN
 *       └─ queue full                              →  reject INGEST_QUEUE_FULL
 *
 *   worker (×16) loop:
 *     while running:
 *       entry ← await dequeue()
 *       try {
 *         verified ← acquire(entry)                 // T.3.A bundle-acquirer
 *         if (replay) skip
 *         for each tokenRoot in verified:           // SEQUENTIAL (W23)
 *           perTokenMutex.acquire(tokenId, async () => {
 *             record ← processToken(tokenRoot, verified, ...)
 *             dispositionWriter.write(addr, record)
 *           })
 *       } catch (BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT) {
 *         // W13: transient retry only — NO disposition record
 *       } catch (...) {
 *         // hard rejection — emit transfer:rejected (logger),
 *         // no disposition write at the bundle level
 *       } finally {
 *         decrementPerTokenCounters(entry.claimedTokenIds)
 *       }
 *
 * **Concurrency model** (W23 + N5):
 *  - Cross-bundle: 16 workers process different bundles in parallel.
 *  - Within one bundle: token-roots are processed SEQUENTIALLY (no inner
 *    parallelism). Per §5.0: "within one bundle, all token-roots are
 *    processed by the SAME worker sequentially (no inner parallelism).
 *    This keeps per-bundle ordering consistent for §5.6 idempotency
 *    invariants."
 *  - Per-tokenId: when two different bundles target the same `tokenId`,
 *    {@link PerTokenMutex} serializes the disposition path. Different
 *    tokenIds never block each other.
 *
 * **W13 routing — transient vs hard failures**:
 *  Per §9.2 / W13, `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` MUST NOT
 *  produce a `_invalid` / `_audit` disposition record. The pool catches
 *  this code at the bundle-level and routes it through the transient
 *  retry path (logger + telemetry only). The recipient does not
 *  acknowledge the sender; the sender's outbox times out and may
 *  attempt CAR-embed re-delivery. EVERY OTHER acquirer error is
 *  treated as a hard bundle rejection and logged as such — but still
 *  no disposition record is written at the bundle level (per-token
 *  records are written by the disposition path inside `processToken`).
 *
 * **Bounded shutdown**:
 *  `destroy()` flips a `running` flag and resolves all idle worker
 *  promises immediately. In-flight bundles complete; queued bundles
 *  drain (each worker dequeues until the queue is empty or `running`
 *  flips to `false`). Callers awaiting `destroy()`'s returned promise
 *  see all worker promises settle.
 *
 * **No module-level state**:
 *  All queues / counters / mutex slots live on the instance. A single
 *  `Sphere` constructs exactly one pool; tests construct ad-hoc pools
 *  freely and `destroy()` them in `afterEach`.
 *
 * Spec references:
 *  - §5.0   N parallel bundle workers, INGEST_QUEUE_SIZE,
 *           INGEST_QUEUE_PER_TOKEN_CAP (W7), bundle-internal
 *           sequential token processing (W23).
 *  - §5.5 step 9 — per-tokenId mutex coordination (T.1.F).
 *  - §9.2 / W13 — gateway-fetch-failed routes through transient retry
 *           only; NO disposition record written.
 *  - T.3.A bundle-acquirer.ts (§5.1 / §5.2 verifier).
 *  - T.3.B.2 disposition-engine.ts (§5.3 walker).
 *  - T.3.C profile/disposition-writer.ts (§5.4 router).
 *  - T.3.D conflict-merger.ts (§5.3 [D] merge).
 *  - T.1.F profile/per-token-mutex.ts (per-tokenId mutex).
 *
 * @packageDocumentation
 */

import { isSphereError, SphereError } from '../../../core/errors.js';
import type { SphereEventMap, SphereEventType } from '../../../types/index.js';
import type {
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../types/uxf-transfer.js';
import type { PerTokenMutex, PerTokenMutexStrategy } from '../../../profile/per-token-mutex.js';

/**
 * Local alias: the UXF v1.0 payload subset accepted by the pool.
 *
 * Legacy `LegacyTokenTransferPayload` shapes (V6 COMBINED_TRANSFER,
 * V5/V4 INSTANT_SPLIT, Sphere TXF, SDK `{token, proof}`) are NOT handled
 * here — they have no `bundleCid` and the recipient routes them through
 * the legacy adapter pipeline instead. The caller (PaymentsModule) is
 * responsible for routing only v1.0-shaped payloads into the pool.
 */
export type UxfV1Payload = UxfTransferPayloadCar | UxfTransferPayloadCid;

import {
  acquireBundle as acquireBundleDefault,
  isReplayOutcome,
  RECIPIENT_MAX_INLINE_CARBASE64_LENGTH,
  type AcquireBundleCidOptions,
  type AcquireBundleResult,
} from './bundle-acquirer.js';
import type { VerifiedBundle, RootRef } from './bundle-verifier.js';
import type { ReplayLRU } from './replay-lru.js';

/**
 * Acquirer signature: identical to the production
 * {@link acquireBundleDefault} export. Exposed as an injection seam so
 * unit tests can drive the pool without standing up a real CAR
 * verification path.
 */
export type AcquireBundleFn = (
  payload: UxfV1Payload,
  senderPubkey: string,
  lru: ReplayLRU,
  cidOptions?: AcquireBundleCidOptions,
) => Promise<AcquireBundleResult>;
import { INGEST_QUEUE_PER_TOKEN_CAP, INGEST_QUEUE_SIZE } from './limits.js';

// =============================================================================
// 1. Constants
// =============================================================================

/**
 * Default worker fan-out per pool. Per §5.0: "Incoming bundles are
 * processed by a pool of parallel workers (default
 * MAX_INGEST_WORKERS = 16, configurable)."
 *
 * The cap is shared with `MAX_CONCURRENT_ORBITDB_WRITES = 8` (50%
 * headroom) — see `limits.ts` and ADR-005.
 */
export const MAX_INGEST_WORKERS = 16;

// =============================================================================
// 2. Public types — caller-supplied per-bundle / per-token hooks
// =============================================================================

/**
 * Lightweight event-emit shim. The production wiring routes to the
 * Sphere event bus; tests inject a recorder so assertions can verify
 * `transfer:ingest-queue-full` was emitted with the right payload
 * without standing up the full bus.
 *
 * Type-narrowed to the events {@link IngestWorkerPool} actually emits.
 */
export type IngestPoolEventEmitter = <T extends SphereEventType>(
  event: T,
  payload: SphereEventMap[T],
) => void;

/**
 * Per-token disposition hook. Invoked by the worker for each token-root
 * in the verified bundle (sequentially, within the per-tokenId mutex).
 *
 * **Contract**: this hook is responsible for everything the §5.3 matrix
 * does for a single token — hydrate, walk [A]–[F], conflict-merge if
 * needed, and write the resulting `DispositionRecord` to the
 * appropriate collection via the disposition-writer.
 *
 * The pool deliberately does NOT call into the disposition-engine
 * directly. That coupling would force the pool to know about every
 * verifier hook the engine consumes (predicate evaluator, oracle, trust
 * base, ...), which is the wrong layer of abstraction. Instead the
 * caller (PaymentsModule) builds the engine + writer wiring once and
 * passes a closure here.
 *
 * **Errors**: this hook MAY throw. Throwing aborts the per-token
 * processing for THIS token only — other tokens in the same bundle are
 * still processed. The pool logs the error via `logEmit` and does NOT
 * write a bundle-level disposition record (per-token records are the
 * hook's responsibility).
 *
 * **Side effects on `audit_promoted_from`-style cross-replica metadata**:
 * the hook itself owns the [B'] re-run and the §5.4 metadata merge —
 * the pool only enforces serialization.
 */
export type ProcessTokenFn = (
  tokenRoot: RootRef,
  verified: VerifiedBundle,
  context: ProcessTokenContext,
) => Promise<void>;

/** Context passed to {@link ProcessTokenFn} alongside the per-token ref. */
export interface ProcessTokenContext {
  /** The original payload (mode, kind, sender claims). */
  readonly payload: UxfV1Payload;
  /** The AUTHENTICATED Nostr signing pubkey of the event author. */
  readonly senderTransportPubkey: string;
  /** The bundleCid the acquirer extracted (and confirmed). */
  readonly bundleCid: string;
  /**
   * Discriminator: which list did this `tokenRoot` come from?
   *
   *  - `true`  → the root was enumerated in `payload.tokenIds` (the
   *              sender's claimed-targets list); recipient runs the
   *              full claimed-token write path (assemble → oracle →
   *              addToken → emit `transfer:incoming` → cascade).
   *  - `false` → the root was discovered as an "advisory unclaimed"
   *              root (in the CAR but absent from `payload.tokenIds`,
   *              §5.2 #2). The recipient processes it ONLY for the
   *              ownership-binding/credit path: it MUST NOT trigger
   *              sender-attribution events (`transfer:incoming` /
   *              history `RECEIVED`), MUST NOT be eligible for
   *              cascade source-side write-back, and MUST NOT be
   *              counted toward the sender's delivery acknowledgement
   *              ledger. (Without this discriminator, a hostile sender
   *              could ship `tokenIds: ['T1']` plus K smuggled root
   *              candidates under MAX_UNCLAIMED_ROOTS=16 and have all
   *              K+1 processed identically — the §5.2 #2 advisory-vs-
   *              claimed distinction would be lost.)
   *
   * Default `processToken` implementations MUST gate the claimed-only
   * write path on `isClaimed === true`. Consumer-installed pools that
   * deliberately want to inspect advisory roots (telemetry, §5.4 / §B'
   * replica-merge, found-money credit) read this flag to decide.
   */
  readonly isClaimed: boolean;
}

/**
 * Optional logger / telemetry sink. Production wiring routes to the
 * SDK's `logger` module; tests inject a recorder. Receives ALL pool
 * lifecycle events (enqueue, accept, reject, worker-error, drain).
 *
 * Distinct from {@link IngestPoolEventEmitter} which is the typed
 * event bus — this is for diagnostic logs that are NOT part of the
 * application-visible event stream.
 */
export type IngestPoolLogEmit = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  details?: Readonly<Record<string, unknown>>,
) => void;

// =============================================================================
// 3. Construction options
// =============================================================================

/**
 * Construction options for {@link IngestWorkerPool}.
 *
 * **Required dependencies**: `lru`, `perTokenMutex`, `processToken`,
 * `emit`. Everything else has a sensible default.
 */
export interface IngestWorkerPoolOptions {
  // ---- Required dependencies ----
  /**
   * Replay LRU shared across the worker pool. The acquirer marks the
   * LRU on successful verification only; replay re-arrivals
   * short-circuit at acquire time.
   */
  readonly lru: ReplayLRU;
  /**
   * Per-tokenId mutex (T.1.F). Shared across the worker pool so two
   * workers handling different bundles for the same `tokenId` serialize.
   */
  readonly perTokenMutex: PerTokenMutex;
  /**
   * Per-token disposition hook. See {@link ProcessTokenFn} for the
   * contract.
   */
  readonly processToken: ProcessTokenFn;
  /**
   * Event bus emitter (typed). Used to surface
   * `transfer:ingest-queue-full` and `transfer:fetch-failed` (the
   * latter is forwarded from the acquirer's CID-fetch path).
   */
  readonly emit: IngestPoolEventEmitter;

  // ---- Optional config ----
  /** Worker fan-out. Default {@link MAX_INGEST_WORKERS} = 16. */
  readonly maxWorkers?: number;
  /** Total queue capacity. Default {@link INGEST_QUEUE_SIZE} = 256. */
  readonly queueSize?: number;
  /** Per-tokenId queue cap. Default {@link INGEST_QUEUE_PER_TOKEN_CAP} = 16. */
  readonly perTokenCap?: number;
  /**
   * Mutex strategy. Defaults to `'cas'` (preferred — non-blocking;
   * {@link ManifestCas} inside `processToken` enforces exclusion).
   * Tests override to `'rpc-release'` to exercise the per-tokenId
   * serialization invariant directly.
   */
  readonly mutexStrategy?: PerTokenMutexStrategy;
  /**
   * Optional T.4.B CID-fetch wiring forwarded to {@link acquireBundle}.
   * Required for `kind: 'uxf-cid'` bundles; if omitted those bundles
   * are rejected with `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`
   * (legacy compat — see acquirer doc).
   */
  readonly cidOptions?: AcquireBundleCidOptions;
  /** Diagnostic log sink. Default no-op. */
  readonly logEmit?: IngestPoolLogEmit;
  /**
   * Optional acquirer override (test seam). Defaults to the module-level
   * {@link acquireBundleDefault} export. Tests inject a stub that
   * returns a synthetic {@link VerifiedBundle} without parsing real CAR
   * bytes — keeps concurrency-mechanics tests fast and deterministic.
   */
  readonly acquireBundle?: AcquireBundleFn;
}

// =============================================================================
// 4. Internal — queue entry shape
// =============================================================================

interface QueueEntry {
  readonly payload: UxfV1Payload;
  readonly senderTransportPubkey: string;
  /** Token-ids this entry contributes to the per-token counter. */
  readonly claimedTokenIds: ReadonlyArray<string>;
  /** Resolves when the entry has been processed (success or failure). */
  readonly settled: Promise<void>;
  /** Marks `settled` resolved. */
  readonly resolveSettled: () => void;
  /** Marks `settled` rejected (only on programmer-error paths). */
  readonly rejectSettled: (err: unknown) => void;
}

// =============================================================================
// 5. IngestWorkerPool
// =============================================================================

/**
 * Bounded worker-pool dispatcher for incoming UXF bundles (§5.0).
 *
 * One instance per `Sphere`. Holds NO module-level state — everything
 * lives on the instance. The pool is stateful between `enqueue()` and
 * `destroy()` (it owns the queue, the worker promises, the per-token
 * counters); destroy is safe to call multiple times.
 *
 * @see {@link IngestWorkerPoolOptions} for construction parameters.
 */
export class IngestWorkerPool {
  private readonly lru: ReplayLRU;
  private readonly perTokenMutex: PerTokenMutex;
  private readonly mutexStrategy: PerTokenMutexStrategy;
  private readonly processToken: ProcessTokenFn;
  private readonly emit: IngestPoolEventEmitter;
  private readonly cidOptions: AcquireBundleCidOptions | undefined;
  private readonly logEmit: IngestPoolLogEmit;
  private readonly acquireBundleFn: AcquireBundleFn;

  private readonly maxWorkers: number;
  private readonly queueCapacity: number;
  private readonly perTokenCap: number;

  /** FIFO queue. Workers `shift()`; `enqueue()` `push()`es. */
  private readonly queue: QueueEntry[] = [];
  /** Per-tokenId queue-occupancy counter (W7). */
  private readonly perTokenCounters = new Map<string, number>();
  /**
   * One waker per worker that is currently parked on an empty queue.
   * `enqueue` pops the first waker (if any) and resolves it to wake
   * exactly one worker — strict 1:1 to avoid thundering-herd on a
   * single new entry.
   */
  private readonly wakers: Array<() => void> = [];
  /** Promises returned by each `runWorker()` invocation. */
  private readonly workerPromises: Promise<void>[] = [];

  private running = true;
  private destroyPromise: Promise<void> | null = null;

  constructor(options: IngestWorkerPoolOptions) {
    this.lru = options.lru;
    this.perTokenMutex = options.perTokenMutex;
    // Wave 4 steelman: default to 'rpc-release' for consistency with
    // import-inclusion-proof, finalization-worker-sender, and
    // finalization-worker-recipient. The 'cas' default required a
    // CAS-based ManifestCas to be wired for serialization to engage;
    // 'rpc-release' is correct without extra wiring.
    this.mutexStrategy = options.mutexStrategy ?? 'rpc-release';
    this.processToken = options.processToken;
    this.emit = options.emit;
    this.cidOptions = options.cidOptions;
    this.logEmit = options.logEmit ?? noopLogEmit;
    this.acquireBundleFn = options.acquireBundle ?? acquireBundleDefault;

    const maxWorkers = options.maxWorkers ?? MAX_INGEST_WORKERS;
    const queueSize = options.queueSize ?? INGEST_QUEUE_SIZE;
    const perTokenCap = options.perTokenCap ?? INGEST_QUEUE_PER_TOKEN_CAP;
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
      throw new SphereError(
        `IngestWorkerPool: maxWorkers must be a positive integer, got ${String(maxWorkers)}`,
        'VALIDATION_ERROR',
      );
    }
    if (!Number.isInteger(queueSize) || queueSize < 1) {
      throw new SphereError(
        `IngestWorkerPool: queueSize must be a positive integer, got ${String(queueSize)}`,
        'VALIDATION_ERROR',
      );
    }
    if (!Number.isInteger(perTokenCap) || perTokenCap < 1) {
      throw new SphereError(
        `IngestWorkerPool: perTokenCap must be a positive integer, got ${String(perTokenCap)}`,
        'VALIDATION_ERROR',
      );
    }
    this.maxWorkers = maxWorkers;
    this.queueCapacity = queueSize;
    this.perTokenCap = perTokenCap;

    // Spin up the worker fan-out eagerly. Workers park on `nextEntry()`
    // until the queue has work; they exit when `running` flips false
    // and the queue is drained.
    for (let i = 0; i < this.maxWorkers; i++) {
      this.workerPromises.push(this.runWorker(i));
    }
  }

  // ===========================================================================
  // 5.1 Public API — enqueue
  // ===========================================================================

  /**
   * Enqueue an incoming bundle for asynchronous processing.
   *
   * Returns a promise that resolves when the bundle has been processed
   * (success OR hard failure — there is no "processed with errors"
   * branch from the caller's perspective; per-token errors land in
   * `_invalid` / `_audit`). The promise REJECTS only on the two
   * back-pressure paths:
   *
   *   - {@link SphereErrorCode} `INGEST_QUEUE_FULL` — queue saturated.
   *   - {@link SphereErrorCode} `INGEST_QUEUE_FULL_PER_TOKEN` — at least
   *     one claimed tokenId is at the per-token cap.
   *
   * Both rejection paths emit `transfer:ingest-queue-full` BEFORE
   * throwing (so operators see the back-pressure signal even if the
   * caller swallows the exception). The recipient does NOT acknowledge
   * the sender; per §5.0 the sender's outbox times out.
   *
   * **Post-destroy behavior**: enqueueing after `destroy()` rejects
   * with `MODULE_DESTROYED`. The pool MUST NOT accept new work after
   * shutdown begins.
   *
   * @param payload The decoded outer envelope (from
   *                `decodeTransferPayload` in T.1.D).
   * @param senderTransportPubkey The AUTHENTICATED Nostr signing pubkey
   *                of the event author (NOT the unauthenticated
   *                `payload.sender.transportPubkey` claim).
   * @returns A promise that resolves when the bundle has finished
   *          processing.
   */
  async enqueue(
    payload: UxfV1Payload,
    senderTransportPubkey: string,
  ): Promise<void> {
    if (!this.running) {
      throw new SphereError(
        'IngestWorkerPool.enqueue: pool destroyed; cannot accept new work',
        'MODULE_DESTROYED',
      );
    }

    // ---- Step 0: enqueue-time inline-CAR size cap ----
    //
    // **Steelman warning fix:** the recipient cap
    // {@link RECIPIENT_MAX_INLINE_CARBASE64_LENGTH} previously fired
    // INSIDE bundle-acquirer.ts after enqueue. A hostile sender could
    // fill the 256-entry queue with 5 MiB payloads ≈ 1.3 GiB resident
    // before any of them reached the acquirer. We now reject oversize
    // inline payloads at enqueue time so the queue never holds them.
    //
    // The check is intentionally synchronous and BEFORE any per-token
    // cap accounting / wakers (so a hostile sender cannot perturb pool
    // counters with rejected payloads). We do NOT validate base64
    // alphabet / structural well-formedness here — those are the
    // acquirer's job. We only bound MEMORY ALLOCATED IN THE QUEUE.
    if (
      payload.kind === 'uxf-car' &&
      payload.carBase64.length > RECIPIENT_MAX_INLINE_CARBASE64_LENGTH
    ) {
      throw new SphereError(
        `IngestWorkerPool.enqueue: carBase64 length ${payload.carBase64.length} ` +
          `exceeds recipient inline cap ${RECIPIENT_MAX_INLINE_CARBASE64_LENGTH}; ` +
          `bundle bundleCid=${payload.bundleCid} dropped at enqueue (queue not allocated)`,
        'BUNDLE_REJECTED_INLINE_CAP_EXCEEDED',
      );
    }

    // ---- Step 1: total queue cap ----
    if (this.queue.length >= this.queueCapacity) {
      this.emitQueueFull('queue-full', payload, senderTransportPubkey);
      throw new SphereError(
        `IngestWorkerPool: ingest queue full (capacity=${this.queueCapacity}); ` +
          `bundle bundleCid=${payload.bundleCid} dropped`,
        'INGEST_QUEUE_FULL',
      );
    }

    // ---- Step 2: per-token cap (W7) ----
    // The acquirer hasn't run yet, so we count against the SENDER's
    // claimed tokenIds (advisory per §5.2 #2). This is the right policy
    // for back-pressure: if a sender claims to target a hot tokenId,
    // count them against that id even if the bundle's actual pool
    // diverges. Smuggled-root counting at receive time is §5.2 #4's
    // job, not ours.
    const claimedTokenIds = payload.tokenIds;
    const overCap = this.findOverCappedTokenIds(claimedTokenIds);
    if (overCap.length > 0) {
      this.emitQueueFull(
        'queue-full-per-token',
        payload,
        senderTransportPubkey,
        overCap,
      );
      throw new SphereError(
        `IngestWorkerPool: per-tokenId queue cap exceeded (cap=${this.perTokenCap}, ` +
          `tokenIds=${overCap.join(',')}); bundle bundleCid=${payload.bundleCid} dropped`,
        'INGEST_QUEUE_FULL_PER_TOKEN',
      );
    }

    // ---- Step 3: enqueue ----
    let resolveSettled!: () => void;
    let rejectSettled!: (err: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    const entry: QueueEntry = {
      payload,
      senderTransportPubkey,
      claimedTokenIds: [...claimedTokenIds],
      settled,
      resolveSettled,
      rejectSettled,
    };

    // Steelman fix #170 — increment per-token counters BEFORE pushing to
    // the queue. If the increment throws (today's implementation only
    // does `Map.set` and `Map.get`, neither throws under normal use, but
    // a future refactor adding async/CAS/persistence COULD throw), an
    // ordering of (push -> increment) would leave an orphan queue entry:
    // a worker would later dequeue it, run, hit `decrementPerTokenCounters`
    // in its `finally`, and corrupt the counter map by decrementing a
    // counter that was never incremented. The (increment -> push) order
    // is safe in both directions: if increment throws, the entry is never
    // queued; if increment succeeds, decrement is guaranteed to balance.
    //
    // **Critical invariant**: NO `await` may be inserted between the cap
    // check (Step 2) and this increment, NOR between this increment and
    // the queue push. JS run-to-completion guarantees synchronous
    // execution between the cap-read and the counter-write — adding an
    // await opens a yield window where another caller could pass the cap
    // check on stale data. If you find yourself wanting to add an
    // `await` here, hoist it out to a separate phase or guard with a
    // lock.
    this.incrementPerTokenCounters(claimedTokenIds);
    this.queue.push(entry);

    this.logEmit('debug', 'IngestWorkerPool: enqueued bundle', {
      bundleCid: payload.bundleCid,
      queueLength: this.queue.length,
      claimedTokenIds,
    });

    // Wake one waker (FIFO).
    const waker = this.wakers.shift();
    if (waker !== undefined) waker();

    return settled;
  }

  // ===========================================================================
  // 5.2 Public API — destroy
  // ===========================================================================

  /**
   * Stop accepting new work and drain in-flight bundles.
   *
   * Multiple `destroy()` calls return the same promise — idempotent.
   *
   * **Drain semantics**: workers complete their current bundle then
   * exit. Queued-but-not-started bundles are NOT processed; their
   * `settled` promise rejects with `MODULE_DESTROYED` (so callers
   * awaiting `enqueue()` see a clean rejection rather than a hang).
   */
  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.running = false;
    this.destroyPromise = (async () => {
      // Drop every waker so parked workers wake up and observe
      // `running === false`, then exit.
      const wakers = this.wakers.splice(0, this.wakers.length);
      for (const w of wakers) w();
      // Reject queued entries that haven't started yet — preserves
      // caller's enqueue-promise contract.
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        this.decrementPerTokenCounters(entry.claimedTokenIds);
        entry.rejectSettled(
          new SphereError(
            'IngestWorkerPool: pool destroyed before bundle was processed',
            'MODULE_DESTROYED',
          ),
        );
      }
      // Wait for in-flight workers to settle. Errors thrown inside a
      // worker are not the destroyer's concern — they were logged by
      // the worker itself.
      await Promise.allSettled(this.workerPromises);
    })();
    return this.destroyPromise;
  }

  // ===========================================================================
  // 5.3 Diagnostic / test-only accessors
  // ===========================================================================

  /** Current queue depth (test-only). NOT a synchronization primitive. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Per-tokenId counter snapshot (test-only). */
  perTokenCount(tokenId: string): number {
    return this.perTokenCounters.get(tokenId) ?? 0;
  }

  /** True iff the pool is still accepting new work. */
  get isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // 5.4 Internal — worker loop
  // ===========================================================================

  /**
   * One worker's main loop. Sleeps on `nextEntry()`; on wake, processes
   * exactly one bundle then loops. Exits when the pool is destroyed
   * AND the queue is empty.
   */
  private async runWorker(workerIndex: number): Promise<void> {
    while (this.running || this.queue.length > 0) {
      const entry = await this.nextEntry();
      if (!entry) {
        // nextEntry resolved with undefined → pool is shutting down
        // and the queue is empty. Exit cleanly.
        return;
      }
      try {
        await this.processBundle(entry, workerIndex);
        entry.resolveSettled();
      } catch (err) {
        // processBundle is expected to swallow per-bundle errors via
        // its own routing (W13 transient vs hard reject). If an error
        // escapes, log it loudly — it's a programmer-error path.
        // Steelman fix #170 — W40 alignment: redact bundleCid to first
        // 16 hex chars in public log payloads.
        this.logEmit('error', 'IngestWorkerPool: worker caught unexpected error', {
          workerIndex,
          bundleCidPrefix: redactBundleCid(entry.payload.bundleCid),
          err: errorToShape(err),
        });
        // Resolve the caller's enqueue promise — the pool's contract
        // is "we tried, the bundle was either processed or rejected
        // for a known reason"; bubbling exceptions here would surprise
        // callers who rely on enqueue() to never throw post-accept.
        entry.resolveSettled();
      } finally {
        this.decrementPerTokenCounters(entry.claimedTokenIds);
      }
    }
  }

  /**
   * Park until a queue entry is available OR the pool is shut down.
   * Returns the next entry, or `undefined` if shutting down with an
   * empty queue.
   */
  private nextEntry(): Promise<QueueEntry | undefined> {
    return new Promise<QueueEntry | undefined>((resolve) => {
      const tryDequeue = (): void => {
        if (this.queue.length > 0) {
          resolve(this.queue.shift());
          return;
        }
        if (!this.running) {
          resolve(undefined);
          return;
        }
        // No work, still running — park as a waker. The next
        // enqueue() will resolve us.
        this.wakers.push(tryDequeue);
      };
      tryDequeue();
    });
  }

  // ===========================================================================
  // 5.5 Internal — per-bundle processing
  // ===========================================================================

  /**
   * Process one bundle end-to-end: §5.1 acquire → §5.3 walk per token
   * (sequentially, under per-tokenId mutex) → §5.4 routing inside the
   * `processToken` hook.
   *
   * **W13 routing**: catches `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT`
   * at the bundle level and DOES NOT write a disposition record. All
   * other thrown SphereErrors are logged as hard bundle rejections.
   * Per-token errors raised by the `processToken` hook are caught
   * per-token and logged; they DO NOT abort processing of the
   * remaining tokens in the same bundle.
   */
  private async processBundle(entry: QueueEntry, workerIndex: number): Promise<void> {
    let verified: VerifiedBundle | null = null;
    try {
      const acquired = await this.acquireBundleFn(
        entry.payload,
        entry.senderTransportPubkey,
        this.lru,
        this.cidOptions,
      );
      if (isReplayOutcome(acquired)) {
        // §5.1 / §5.6 — replay re-arrival is a no-op.
        this.logEmit('debug', 'IngestWorkerPool: replay short-circuit', {
          workerIndex,
          bundleCid: acquired.bundleCid,
        });
        return;
      }
      verified = acquired;
    } catch (err) {
      this.classifyAcquireError(err, entry, workerIndex);
      return;
    }

    // Bundle verified. Walk every token-root (claimed + advisory)
    // SEQUENTIALLY (W23). Per-tokenId mutex serializes against any
    // OTHER bundle's worker that touches the same id.
    //
    // Each entry carries an `isClaimed` discriminator that records
    // whether the root came from `verified.claimedTokens` (the sender's
    // enumerated targets in `payload.tokenIds`) or
    // `verified.advisoryUnclaimedRoots` (smuggled / advisory roots,
    // §5.2 #2). The flag MUST be propagated to `processToken` so the
    // default closure (and any consumer override) can apply the
    // claimed-vs-advisory policy split — without it, a hostile sender
    // who ships `tokenIds: ['T1']` plus K smuggled root candidates
    // (under MAX_UNCLAIMED_ROOTS=16) could have all K+1 processed
    // identically as if they were all claimed.
    const allTokens: ReadonlyArray<{
      readonly root: RootRef;
      readonly isClaimed: boolean;
    }> = [
      ...verified.claimedTokens.map((root) => ({ root, isClaimed: true })),
      ...verified.advisoryUnclaimedRoots.map((root) => ({
        root,
        isClaimed: false,
      })),
    ];

    for (const { root: tokenRoot, isClaimed } of allTokens) {
      try {
        await this.perTokenMutex.acquire(
          tokenRoot.tokenId,
          () =>
            this.processToken(tokenRoot, verified!, {
              payload: entry.payload,
              senderTransportPubkey: entry.senderTransportPubkey,
              bundleCid: verified!.bundleCid,
              isClaimed,
            }),
          { strategy: this.mutexStrategy },
        );
      } catch (err) {
        // Per-token error: log + continue. The disposition-engine
        // surfaces matrix outcomes via the returned record, NOT via
        // throws (except instant-mode-not-supported, which IS
        // bundle-fatal — see classifyTokenError).
        if (this.isInstantModeSoftReject(err)) {
          // Instant-mode soft-reject is bundle-fatal: the engine
          // refused to walk the token because the recipient capability
          // gate hasn't lifted yet (T.5.C deferred). No disposition
          // record was written; we abort the rest of the bundle to
          // mirror the §T.3 deferred-handling note. Sender's outbox
          // times out and may re-deliver as conservative-mode.
          this.logEmit('warn', 'IngestWorkerPool: instant-mode soft-reject', {
            workerIndex,
            bundleCid: verified.bundleCid,
            tokenId: tokenRoot.tokenId,
          });
          return;
        }
        this.logEmit('error', 'IngestWorkerPool: per-token error', {
          workerIndex,
          bundleCid: verified.bundleCid,
          tokenId: tokenRoot.tokenId,
          err: errorToShape(err),
        });
        // Continue with the next token. The hook is expected to have
        // attempted its own disposition write before throwing; if it
        // failed mid-write, the bundle's other tokens still deserve
        // processing.
      }
    }
  }

  /**
   * Route an acquirer error to the correct logging / event path.
   *
   * **W13** — `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` is the canonical
   * transient class: NO disposition record, only the
   * `transfer:fetch-failed` event already emitted by the cid-fetcher.
   * The caller logs at `info` (not `error`) — transient is normal
   * traffic.
   */
  private classifyAcquireError(
    err: unknown,
    entry: QueueEntry,
    workerIndex: number,
  ): void {
    if (isSphereError(err) && err.code === 'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT') {
      // W13: NO disposition record. The cid-fetcher already emitted
      // `transfer:fetch-failed`; we just log here for traceability.
      // Steelman fix #170 — W40 alignment: redact senderTransportPubkey
      // to first 8 hex chars and bundleCid to first 16 chars at WARN/INFO
      // log sites so public log shipping does not correlate sender
      // identities or whole content addresses.
      this.logEmit('info', 'IngestWorkerPool: gateway-fetch transient (W13)', {
        workerIndex,
        bundleCidPrefix: redactBundleCid(entry.payload.bundleCid),
        senderPubkeyPrefix: redactSenderPubkey(entry.senderTransportPubkey),
      });
      return;
    }
    if (
      isSphereError(err) &&
      err.code === 'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED'
    ) {
      this.logEmit('warn', 'IngestWorkerPool: instant-mode soft-reject (acquire)', {
        workerIndex,
        bundleCidPrefix: redactBundleCid(entry.payload.bundleCid),
      });
      return;
    }
    // Every other error is a hard bundle rejection. No disposition
    // record at the bundle level — the bundle was either malformed
    // (no token-root we could disposition) or the acquirer threw
    // before any token was identified.
    // Steelman fix #170 — W40 alignment: redact public-log sender
    // pubkey/bundleCid identifiers to non-correlatable prefixes.
    this.logEmit('warn', 'IngestWorkerPool: hard bundle rejection', {
      workerIndex,
      bundleCidPrefix: redactBundleCid(entry.payload.bundleCid),
      senderPubkeyPrefix: redactSenderPubkey(entry.senderTransportPubkey),
      err: errorToShape(err),
    });
  }

  /** True iff `err` is the engine's instant-mode soft-reject sentinel. */
  private isInstantModeSoftReject(err: unknown): boolean {
    return (
      isSphereError(err) &&
      err.code === 'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED'
    );
  }

  // ===========================================================================
  // 5.6 Internal — per-tokenId queue counters (W7)
  // ===========================================================================

  /**
   * Identify any tokenIds in `claimedTokenIds` whose current counter is
   * already at or above the per-token cap. Returns the over-cap ids
   * for inclusion in the rejection payload — empty array means OK.
   *
   * Counts the *incremental* contribution this enqueue would make:
   * since duplicates within `claimedTokenIds` are unlikely (sender's
   * claim is supposed to be deduped), we count each id once. Defensive
   * dedup via Set guards against malformed senders.
   */
  private findOverCappedTokenIds(
    claimedTokenIds: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    const seen = new Set<string>();
    const offenders: string[] = [];
    for (const id of claimedTokenIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const cur = this.perTokenCounters.get(id) ?? 0;
      if (cur + 1 > this.perTokenCap) {
        offenders.push(id);
      }
    }
    return offenders;
  }

  private incrementPerTokenCounters(claimedTokenIds: ReadonlyArray<string>): void {
    const seen = new Set<string>();
    for (const id of claimedTokenIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      this.perTokenCounters.set(
        id,
        (this.perTokenCounters.get(id) ?? 0) + 1,
      );
    }
  }

  private decrementPerTokenCounters(claimedTokenIds: ReadonlyArray<string>): void {
    const seen = new Set<string>();
    for (const id of claimedTokenIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const cur = this.perTokenCounters.get(id) ?? 0;
      if (cur <= 1) {
        this.perTokenCounters.delete(id);
      } else {
        this.perTokenCounters.set(id, cur - 1);
      }
    }
  }

  // ===========================================================================
  // 5.7 Internal — emit helper
  // ===========================================================================

  private emitQueueFull(
    cause: 'queue-full' | 'queue-full-per-token',
    payload: UxfV1Payload,
    senderTransportPubkey: string,
    tokenIds?: ReadonlyArray<string>,
  ): void {
    this.emit('transfer:ingest-queue-full', {
      cause,
      senderTransportPubkey,
      bundleCid: payload.bundleCid,
      queueSize: this.queue.length,
      capacity: this.queueCapacity,
      ...(tokenIds !== undefined && { tokenIds }),
    });
  }
}

// =============================================================================
// 6. Internal helpers
// =============================================================================

const noopLogEmit: IngestPoolLogEmit = () => undefined;

/**
 * Best-effort serialization of an unknown error for log payloads. Avoids
 * leaking arbitrary object graphs into logs (nice for grep) while
 * preserving the typed code on `SphereError`.
 */
function errorToShape(err: unknown): Readonly<Record<string, unknown>> {
  if (isSphereError(err)) {
    return { name: err.name, code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { value: String(err) };
}

/**
 * Steelman fix #170 — W40 log redaction.
 *
 * Public log shipping (operators tail JSON logs into observability
 * pipelines that may be readable by parties without need-to-know) MUST
 * NOT correlate full sender transport pubkeys nor full bundleCids.
 * Redact at the emission site so even an in-process logger that defaults
 * to `JSON.stringify` cannot leak the full identifier.
 *
 * `redactSenderPubkey` returns the first 8 hex chars (32 bits of entropy
 * — enough to grep / correlate during incident response, not enough to
 * trivially link two log lines back to the same Nostr identity).
 *
 * `redactBundleCid` returns the first 16 chars of the CIDv1 base32
 * string, which keeps the multibase prefix and a few discriminating bits
 * for grep without revealing the whole content address.
 *
 * Both helpers are tolerant of inputs shorter than the requested prefix
 * length (returns the whole string in that case) and handle non-string
 * inputs defensively (returns `'<missing>'`) so a broken caller cannot
 * crash the log pipeline. Tests pin the exact prefix lengths.
 */
function redactSenderPubkey(senderPubkey: unknown): string {
  if (typeof senderPubkey !== 'string' || senderPubkey.length === 0) {
    return '<missing>';
  }
  return senderPubkey.slice(0, 8);
}

function redactBundleCid(bundleCid: unknown): string {
  if (typeof bundleCid !== 'string' || bundleCid.length === 0) {
    return '<missing>';
  }
  return bundleCid.slice(0, 16);
}
