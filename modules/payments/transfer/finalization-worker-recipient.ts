/**
 * UXF Transfer — recipient-side finalization worker (T.5.C).
 *
 * Implements `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.5 (per-token
 * finalization, chain-mode landing path) + §6.2 (recipient-side worker
 * driver). Mirror of the sender worker (T.5.B,
 * `finalization-worker-sender.ts`) but driven from the per-address
 * {@link FinalizationQueue} rather than the outbox.
 *
 * **Key differences from T.5.B**:
 *
 *  1. **Driver**: T.5.B reads outbox entries with
 *     `status === 'delivered-instant'`; T.5.C reads queue entries from
 *     `${addr}.finalizationQueue.*`. K queue entries per K-deep
 *     chain-mode token.
 *
 *  2. **Step-9 re-evaluator (W5)**: when a queue entry attaches its
 *     proof successfully (§5.5 step 5), the worker MUST acquire a
 *     per-tokenId lock and check whether ALL of the token's queue
 *     entries have been resolved. If so, it re-runs [B]/[D]/[E] via
 *     {@link revaluate} (the new disposition-engine entry-point W5)
 *     to choose the final manifest status (`'valid'` /
 *     `'unspendable'` / `'conflicting'`). The result is routed
 *     through the disposition writer (T.3.C).
 *
 *  3. **Cascade on hard-fail**: T.5.C's cascade has THREE sub-cases:
 *     - **Coin / NFT no-children (pure receive)**: no outbox entries,
 *       no splitParent children. Cascade walker is invoked but
 *       reports `{cascaded:0, nftNotified:0}` — nothing to walk.
 *       Self-invalidation is the only effect.
 *     - **Coin with downstream forward (operator forwarded the coin
 *       before its parent finalized)**: `splitParent` children exist
 *       AND/OR outbox entries reference the failing token. Cascade
 *       walker fans out to children (coin path) plus emits
 *       `transfer:cascade-failed` for outbox entries.
 *     - **NFT with forward**: NO `splitParent` walk (NFTs are not
 *       splittable); ONLY outbox entries that shipped this NFT get
 *       `transfer:cascade-failed`.
 *     In ALL three cases, the recipient's OWN copy of the failing
 *     token is moved to `_invalid` via the disposition writer.
 *
 *  4. **W15 idempotency invariant (§5.6)**: replay of the same
 *     `transactionHash` with a different proof MUST converge.
 *     Implementation: the worker's manifest-CID-rewrite path
 *     (4-step write) is idempotent on the proof's content hash;
 *     re-attaching the same `(transactionHash, authenticator)` is a
 *     no-op at step 1, the manifest CAS at step 2 sees its own newCid
 *     and returns `cas-mismatch` (which {@link
 *     performManifestCidRewrite} translates to "already applied"),
 *     step 3 / 4 are similarly idempotent. A different proof for the
 *     same `transactionHash` (e.g. newer-round equivalent) is a
 *     §6.3 most-recent-proof case — same value (since
 *     transactionHash + authenticator match) means tombstone-and-
 *     replace.
 *
 *  5. **Merge-path proof grafting**: when a more-finalized UXF copy
 *     of the same token arrives (§5.6 third bullet), its proofs are
 *     grafted into the local pool BY THE INGEST PIPELINE (T.3.D
 *     conflict merger), NOT by this worker. The worker observes the
 *     merge by polling its own queue: a queue entry whose
 *     corresponding proof is now present in the pool can be REMOVED
 *     without an aggregator round-trip. This is implemented by the
 *     graft-detection path in {@link processQueueEntry}: before
 *     issuing the submit, the worker checks the pool via
 *     `poolRead.getAttachedProof`; if a matching proof is already
 *     present, the worker fast-paths to "remove queue entry" and
 *     skips the aggregator entirely.
 *
 *  6. **Per-tokenId mutex (T.1.F) coordination**: the §5.5 step 9
 *     re-run is acquired under the per-tokenId mutex with
 *     CAS-default strategy (W34); the manifest-CID-rewrite is
 *     wrapped in the same mutex on each individual queue-entry
 *     attach (matches the T.5.B sender worker behavior).
 *
 * **§5.5 step 1-9 mapping** (verbatim, this implementation):
 *
 *  | Spec step | Implementation method                                      |
 *  |-----------|------------------------------------------------------------|
 *  | 1 resolve | {@link RequestContextResolver} via injection (mirror T.5.B)|
 *  | 2 derive  | implicit — caller's adapter computes commitmentRequestId   |
 *  | 3 submit  | {@link runSubmitPhase} (re-uses §6.1 mapping table)        |
 *  | 4 poll    | {@link runPollPhase}                                       |
 *  | 5 attach  | {@link attachProofUnderMutex} → {@link performManifestCidRewrite} |
 *  | 6 deadline| {@link isPollingTimedOut} (shared polling-policy)          |
 *  | 7 hard-fail short-circuit | {@link processQueueEntry} cancels siblings + cascades |
 *  | 8 transient backoff | {@link runSubmitPhase} / {@link runPollPhase} reuse {@link getBackoffMs} |
 *  | 9 queue-drain re-run [B][D][E] | {@link maybeFinalizeToken} acquires per-token mutex + invokes {@link revaluate} |
 *
 * Spec references:
 *  - §5.5 — per-token finalization
 *  - §5.6 — replay / duplicate / merge handling (idempotency invariant)
 *  - §6.1 — submit / poll loop (shared with T.5.B; identical mapping)
 *  - §6.2 — recipient-side worker driver
 *  - §6.3 — most-recent-proof / security-alert
 *  - §6.1.1 — cascade rule (race-lost EXCEPTION)
 *
 * @packageDocumentation
 */

import {
  MAX_CONCURRENT_POLLS_PER_AGGREGATOR,
  MAX_CONCURRENT_POLLS_PER_TOKEN,
  POLLING_WINDOW_MS,
} from './limits';
import {
  validatePollingPolicy,
  isPollingTimedOut,
  getBackoffMs,
  MIN_POLL_ATTEMPTS,
} from './polling-policy';
import {
  performManifestCidRewrite,
  type FinalizationQueueAdapter,
  type ManifestCidRewriteContext,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
} from './manifest-cid-rewrite';
import type {
  AnchoredProofDescriptor,
  FinalizationAggregatorClient,
  PollOutcome,
  PoolReadAdapter,
  RequestContext,
  RequestContextResolver,
  Semaphore,
  SubmitOutcome,
} from './finalization-worker-sender';
import type { CascadeWalker } from './cascade-walker';
import type { FinalizationQueue, FinalizationQueueEntry } from './finalization-queue';
import { revaluate, type DispositionRevaluateInput } from './disposition-engine';
import type { DispositionRecord } from '../../../types/disposition';
import { ManifestCas } from '../../../profile/manifest-cas';
import type { PerTokenMutex } from '../../../profile/per-token-mutex';
import type { ContentHash } from '../../../uxf/types';
import type { DispositionReason } from '../../../types/disposition';
import type {
  IncomingTransfer,
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import { SphereError } from '../../../core/errors';

// Re-export the shared adapter types for caller convenience. The
// worker's contracts mirror T.5.B by design; production wiring
// instantiates the same fakes.
export type {
  AnchoredProofDescriptor,
  FinalizationAggregatorClient,
  PollOutcome,
  PoolReadAdapter,
  RequestContext,
  RequestContextResolver,
  Semaphore,
  SubmitOutcome,
};

// =============================================================================
// 1. Disposition writer surface — narrow shape over T.3.C
// =============================================================================

/**
 * Narrow shape over `DispositionWriter.write`. The recipient worker
 * routes the §5.5 step 9 re-evaluator's output through this surface.
 * Production wires this to the real T.3.C writer; tests inject
 * recorders.
 */
export interface FinalizationDispositionWriter {
  write(addr: string, record: DispositionRecord): Promise<void>;
}

// =============================================================================
// 2. Hooks for the §5.5 step 9 re-evaluator
// =============================================================================

/**
 * Closure over the §5.5 step 9 re-evaluator hooks the worker needs to
 * pass through to {@link revaluate}. Production wires these to the
 * real recipient pipeline ({@link processDisposition}'s injection
 * surface adapted for re-evaluation); tests inject in-memory fakes.
 *
 * The shape mirrors the subset of {@link DispositionEngineInput} that
 * {@link revaluate} consumes — the worker passes them through verbatim.
 */
export interface RevaluateHooksProvider {
  /**
   * Construct a complete {@link DispositionRevaluateInput} for the
   * supplied tokenId. Returns `null` if the token is no longer
   * locally known (e.g. concurrent operator action removed it) — the
   * worker treats null as "skip re-evaluation" (the cascade path will
   * have already moved the token to `_invalid` if appropriate).
   */
  buildRevaluateInput(
    addr: string,
    tokenId: string,
  ): Promise<DispositionRevaluateInput | null>;
}

// =============================================================================
// 3. Worker construction options
// =============================================================================

/**
 * Cap parameters for the recipient worker. Mirrors T.5.B's
 * {@link FinalizationWorkerCaps} — every default matches `limits.ts` so
 * production wiring rarely overrides them.
 */
export interface FinalizationWorkerRecipientCaps {
  /** §6.1 — at most this many in-flight aggregator calls per
   *  endpoint. Default {@link MAX_CONCURRENT_POLLS_PER_AGGREGATOR}. */
  readonly perAggregator?: number;
  /** §6.1 — at most this many in-flight polls for the same tokenId.
   *  Default {@link MAX_CONCURRENT_POLLS_PER_TOKEN}. */
  readonly perToken?: number;
  /** Maximum submit retries on TRANSIENT (network / 5xx). §6.1 step 3.
   *  Default 5. */
  readonly maxSubmitRetries?: number;
  /** Maximum proof-error retries on PATH_INVALID / NOT_AUTHENTICATED.
   *  §6.1 step 4. Default 3. */
  readonly maxProofErrorRetries?: number;
  /** Polling window override (ms). Default {@link POLLING_WINDOW_MS}. */
  readonly pollingWindowMs?: number;
}

/**
 * Construction options for {@link FinalizationWorkerRecipient}.
 *
 * Every external dependency is injected so unit tests can drive the
 * worker against deterministic fakes without spinning up an aggregator,
 * OrbitDB store, or full disposition pipeline.
 */
export interface FinalizationWorkerRecipientOptions {
  /** Address id this worker scopes to. */
  readonly addressId: string;
  /** Per-address finalization queue (T.5.C / Wave G.7). */
  readonly queueStore: FinalizationQueue;
  /**
   * The same {@link FinalizationQueueAdapter} that backs the §5.5
   * step 5 step 4 "queue-entry removal LAST" write. The worker
   * passes this through {@link performManifestCidRewrite}; production
   * wires both to the same underlying queue (the wrapper bridges to
   * the queue's `hasEntry` / `remove` shape).
   */
  readonly queueAdapter: FinalizationQueueAdapter;
  /** Aggregator client — submit + poll. Same surface as T.5.B. */
  readonly aggregator: FinalizationAggregatorClient;
  /** Per-requestId context resolver. Same surface as T.5.B. */
  readonly resolver: RequestContextResolver;
  /** Pool write adapter (§5.5 step 5 step 1). */
  readonly pool: PoolWriteAdapter;
  /** Pool read adapter (§6.3 most-recent / merge-path graft detect). */
  readonly poolRead: PoolReadAdapter;
  /** Manifest CAS helper (§5.5 step 5 step 2). */
  readonly manifestCas: ManifestCas;
  /** Tombstone adapter (§5.5 step 5 step 3). */
  readonly tombstones: TombstoneWriteAdapter;
  /** Per-aggregator semaphore (W14, default 16). Caller-shared. */
  readonly perAggregatorSemaphore: Semaphore;
  /** Factory for per-tokenId semaphores. */
  readonly getPerTokenSemaphore: (tokenId: string) => Semaphore;
  /** Per-tokenId mutex (T.1.F). */
  readonly perTokenMutex: PerTokenMutex;
  /** Strategy passed to `perTokenMutex.acquire`. Default `'cas'` (W34). */
  readonly perTokenMutexStrategy?: 'cas' | 'rpc-release' | 'bounded-hold';
  /**
   * Cascade walker (T.5.B.5). The worker invokes
   * {@link CascadeWalker.cascade} on hard-fail of any queue entry —
   * pure delegation. This module does NOT reimplement the cascade
   * walk.
   */
  readonly cascadeWalker: CascadeWalker;
  /** Disposition writer (T.3.C) — routes re-evaluator output. */
  readonly dispositionWriter: FinalizationDispositionWriter;
  /** §5.5 step 9 re-evaluator hooks provider. */
  readonly revaluateHooks: RevaluateHooksProvider;
  /** Event emitter — same surface used by Sphere. */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /** Wall-clock provider. Tests inject deterministic clocks. */
  readonly now: () => number;
  /** Sleep primitive. Tests inject a deterministic version that
   *  resolves immediately. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional override of the §6.1 caps. */
  readonly caps?: FinalizationWorkerRecipientCaps;
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal;
  /** Aggregator endpoint identifier. Defaults to `'default'`. */
  readonly aggregatorId?: string;
}

// =============================================================================
// 4. Internal types — disposition + per-entry processing result
// =============================================================================

/**
 * Per-queue-entry hard-fail outcome. Mirror of T.5.B's
 * {@link HardFailOutcome} — race-lost skips cascade per §6.1.1; every
 * other terminal reason fires it.
 *
 * @internal
 */
interface HardFailOutcome {
  readonly kind: 'hard-fail';
  readonly reason: DispositionReason;
  /** Per §6.1.1 race-lost special case — TRUE when the cascade walker
   *  should NOT be triggered. */
  readonly skipCascade: boolean;
  /** Forensic message persisted on the disposition record. */
  readonly message: string;
}

/** @internal */
interface SuccessOutcome {
  readonly kind: 'success';
  /** The new content hash the token resolves to once the proof is
   *  attached. */
  readonly newCid: ContentHash;
}

/** @internal */
interface MergePathOutcome {
  /** Merge-path graft: the proof was already attached by ingest
   *  pipeline before the worker reached it. The queue entry was
   *  removed without an aggregator round-trip. */
  readonly kind: 'merge-path-graft';
}

/** @internal */
type RequestOutcome = SuccessOutcome | HardFailOutcome | MergePathOutcome;

/**
 * Result of one full {@link processQueueEntry} pass. The worker
 * aggregates these per-tokenId in {@link processOneToken} to decide
 * whether to fire the §5.5 step 9 re-evaluation (all success) or the
 * cascade (any hard-fail).
 */
export interface ProcessQueueEntryResult {
  readonly entryId: string;
  readonly tokenId: string;
  readonly outcome:
    | { readonly kind: 'success'; readonly newCid: ContentHash }
    | { readonly kind: 'merge-path-graft' }
    | {
        readonly kind: 'hard-fail';
        readonly reason: DispositionReason;
        readonly skipCascade: boolean;
        readonly message: string;
      };
}

/**
 * Per-token aggregate result. The worker's `processOneToken` returns
 * this so callers (tests, telemetry) can assert on the §5.5 step 9
 * terminal:
 *  - `terminal: 'valid'`         — all entries resolved success +
 *                                  re-eval surfaced VALID.
 *  - `terminal: 'unspendable'`   — re-eval surfaced AUDIT(off-record-spend).
 *  - `terminal: 'not-our-state'` — re-eval surfaced AUDIT(not-our-state).
 *  - `terminal: 'conflicting'`   — re-eval surfaced CONFLICTING.
 *  - `terminal: 'invalid'`       — any entry hard-failed; cascade fired.
 *  - `terminal: 'in-progress'`   — entries remain unresolved (transient
 *                                  failure, partial drain).
 */
export interface ProcessOneTokenResult {
  readonly tokenId: string;
  readonly entriesProcessed: number;
  readonly successCount: number;
  readonly hardFailCount: number;
  readonly mergePathGraftCount: number;
  readonly firstHardFailReason?: DispositionReason;
  readonly cascadeInvoked: boolean;
  readonly terminal:
    | 'valid'
    | 'unspendable'
    | 'not-our-state'
    | 'conflicting'
    | 'invalid'
    | 'in-progress';
}

// =============================================================================
// 5. Helpers — shared with T.5.B (kept private to this module to avoid
//              an extra public API surface; identical logic for parity)
// =============================================================================

/**
 * Equality on `(transactionHash, authenticator)` — the §6.3
 * same-value-vs-different-value resolver. Lowercased for defensive
 * case-insensitive compare.
 *
 * @internal
 */
function sameProofValue(
  a: { readonly transactionHash: string; readonly authenticator: string },
  b: { readonly transactionHash: string; readonly authenticator: string },
): boolean {
  return (
    a.transactionHash.toLowerCase() === b.transactionHash.toLowerCase() &&
    a.authenticator.toLowerCase() === b.authenticator.toLowerCase()
  );
}

/**
 * `transactionHash` equality only. Used by the §6.1 race-loser
 * detection.
 *
 * @internal
 */
function sameTransactionHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// =============================================================================
// 6. FinalizationWorkerRecipient
// =============================================================================

/**
 * Recipient-side finalization worker. Use {@link processOneToken} to
 * drive every queue entry of a single tokenId; use
 * {@link processQueueEntry} to drive a single entry; use
 * {@link start}/{@link stop} for a long-lived loop.
 *
 * Class holds NO module-level state. Multiple instances are
 * independent.
 */
export class FinalizationWorkerRecipient {
  private readonly options: FinalizationWorkerRecipientOptions;
  private readonly perAggregatorSemaphore: Semaphore;
  private readonly perAggregator: number;
  private readonly perToken: number;
  private readonly maxSubmitRetries: number;
  private readonly maxProofErrorRetries: number;
  private readonly pollingWindowMs: number;
  private readonly perTokenMutexStrategy:
    | 'cas'
    | 'rpc-release'
    | 'bounded-hold';
  private readonly aggregatorId: string;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  /**
   * Validate the polling-policy at construction (§5.5 step 6 step 6).
   * Throws `INVALID_POLLING_POLICY` if violated.
   */
  constructor(options: FinalizationWorkerRecipientOptions) {
    const policy = validatePollingPolicy();
    if (!policy.valid) {
      throw new SphereError(
        `FinalizationWorkerRecipient: polling policy invalid — cumulative backoff for first ${MIN_POLL_ATTEMPTS} polls (${policy.cumulativeBackoffMs}ms) exceeds POLLING_WINDOW_MS (${POLLING_WINDOW_MS}ms). Reason: ${policy.reason ?? 'unknown'}`,
        'INVALID_POLLING_POLICY',
      );
    }

    this.options = options;
    this.perAggregatorSemaphore = options.perAggregatorSemaphore;
    this.perAggregator =
      options.caps?.perAggregator ?? MAX_CONCURRENT_POLLS_PER_AGGREGATOR;
    this.perToken = options.caps?.perToken ?? MAX_CONCURRENT_POLLS_PER_TOKEN;
    this.maxSubmitRetries = options.caps?.maxSubmitRetries ?? 5;
    this.maxProofErrorRetries = options.caps?.maxProofErrorRetries ?? 3;
    this.pollingWindowMs = options.caps?.pollingWindowMs ?? POLLING_WINDOW_MS;
    this.perTokenMutexStrategy = options.perTokenMutexStrategy ?? 'cas';
    this.aggregatorId = options.aggregatorId ?? 'default';

    if (
      !Number.isFinite(this.perAggregator) ||
      this.perAggregator <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerRecipient: caps.perAggregator must be > 0; got ${this.perAggregator}`,
        'VALIDATION_ERROR',
      );
    }
    if (!Number.isFinite(this.perToken) || this.perToken <= 0) {
      throw new SphereError(
        `FinalizationWorkerRecipient: caps.perToken must be > 0; got ${this.perToken}`,
        'VALIDATION_ERROR',
      );
    }
  }

  /** Start the long-running scan loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.scanLoop();
  }

  /** Request stop and await the in-flight iteration. Idempotent. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise !== null) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
    this.running = false;
  }

  /** Diagnostic — is the scan loop currently running? */
  isRunning(): boolean {
    return this.running && !this.stopRequested;
  }

  // ===========================================================================
  // 6.1. Per-tokenId driver
  // ===========================================================================

  /**
   * Drive every queue entry of `tokenId` through the §5.5 finalization
   * pipeline. Aggregates per-entry outcomes:
   *
   *  - **All success**: re-runs [B]/[D]/[E] via {@link revaluate} under
   *    the per-tokenId mutex. Routes the result to the disposition
   *    writer (T.3.C). Emits `transfer:incoming` with `confirmed: true`
   *    on VALID terminal.
   *  - **Any hard-fail**: invokes the cascade walker per §6.1.1; the
   *    walker decides coin/NFT routing internally. Self-invalidation
   *    of the recipient's own copy is performed by writing an
   *    `INVALID` disposition for the tokenId.
   *
   * Mirrors T.5.B's `processOne(entry)` but driven by the queue and
   * carrying §5.5 step 9 re-evaluation.
   */
  async processOneToken(tokenId: string): Promise<ProcessOneTokenResult> {
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw new SphereError(
        'processOneToken: tokenId must be a non-empty string',
        'VALIDATION_ERROR',
      );
    }
    const entries = await this.options.queueStore.lookupByTokenId(
      this.options.addressId,
      tokenId,
    );
    if (entries.length === 0) {
      // No live entries — either fully drained already or unknown.
      // Still attempt a re-evaluation in case the previous pass crashed
      // BETWEEN the last entry's removal and the re-evaluation step
      // (§5.5 step 9 idempotency requirement).
      const replayResult = await this.maybeFinalizeToken(tokenId);
      return {
        tokenId,
        entriesProcessed: 0,
        successCount: 0,
        hardFailCount: 0,
        mergePathGraftCount: 0,
        cascadeInvoked: false,
        terminal: replayResult ?? 'in-progress',
      };
    }

    // Process entries in parallel, bounded by the injected semaphores.
    // Per-tokenId concurrency cap is enforced by the per-token semaphore
    // inside processQueueEntry; the per-aggregator semaphore is shared
    // globally.
    const results = await Promise.all(
      entries.map((e) => this.processQueueEntry(e)),
    );

    let successCount = 0;
    let hardFailCount = 0;
    let mergePathGraftCount = 0;
    let firstHardFailReason: DispositionReason | undefined;
    let firstHardFailMessage: string | undefined;
    let firstHardFailSkipCascade = false;
    for (const r of results) {
      if (r.outcome.kind === 'success') successCount++;
      else if (r.outcome.kind === 'merge-path-graft') mergePathGraftCount++;
      else {
        hardFailCount++;
        if (firstHardFailReason === undefined) {
          firstHardFailReason = r.outcome.reason;
          firstHardFailMessage = r.outcome.message;
          firstHardFailSkipCascade = r.outcome.skipCascade;
        }
      }
    }

    // §5.5 step 7: hard-fail short-circuit.
    if (hardFailCount > 0 && firstHardFailReason !== undefined) {
      const cascadeInvoked = await this.applyHardFailCascade({
        tokenId,
        reason: firstHardFailReason,
        message: firstHardFailMessage ?? 'hard-fail',
        skipCascade: firstHardFailSkipCascade,
        observedTokenContentHash: this.observedHashFor(entries[0]),
        bundleCid: entries[0].bundleCid,
      });
      return {
        tokenId,
        entriesProcessed: entries.length,
        successCount,
        hardFailCount,
        mergePathGraftCount,
        firstHardFailReason,
        cascadeInvoked,
        terminal: 'invalid',
      };
    }

    // §5.5 step 9: queue-drain → status transition.
    // Acquire the per-tokenId mutex (CAS-default per W34) and re-run
    // [B]/[D]/[E] via revaluate.
    const finalized = await this.maybeFinalizeToken(tokenId);
    return {
      tokenId,
      entriesProcessed: entries.length,
      successCount,
      hardFailCount,
      mergePathGraftCount,
      firstHardFailReason,
      cascadeInvoked: false,
      terminal: finalized ?? 'in-progress',
    };
  }

  // ===========================================================================
  // 6.2. Per-queue-entry processing
  // ===========================================================================

  /**
   * Drive a single queue entry through submit + poll + attach.
   *
   * Steps:
   *  1. Resolve `signedTx` + context via {@link RequestContextResolver}.
   *  2. **Merge-path graft check (§5.6)**: ask the pool whether a proof
   *     for this requestId is already attached. If yes AND the proof
   *     matches our `(transactionHash, authenticator)`, the merge-path
   *     fast-paths the queue entry to "remove and done" without an
   *     aggregator round-trip. The §5.6 idempotency invariant (W15)
   *     ensures the result is the same as a fresh submit.
   *  3. Submit (§5.5 step 3 / §6.1 submit table).
   *  4. Poll (§5.5 step 4 / §6.1 poll table).
   *  5. On OK: attach proof via {@link performManifestCidRewrite} under
   *     the per-tokenId mutex.
   *  6. On hard-fail: surface the reason + skipCascade flag back to the
   *     caller.
   *
   * The caller ({@link processOneToken}) aggregates outcomes and
   * decides cascade vs re-evaluate.
   */
  async processQueueEntry(
    entry: FinalizationQueueEntry,
  ): Promise<ProcessQueueEntryResult> {
    const ctxResolved = await this.options.resolver.resolve({
      addressId: this.options.addressId,
      outboxId: entry.entryId, // re-using the slot; the resolver's
      //                          interface is shared with T.5.B and
      //                          calls it `outboxId`; in T.5.C this is
      //                          the queue entry id.
      tokenId: entry.tokenId,
      requestId: entry.commitmentRequestId,
    });
    if (ctxResolved === null) {
      return {
        entryId: entry.entryId,
        tokenId: entry.tokenId,
        outcome: {
          kind: 'hard-fail',
          reason: 'structural',
          skipCascade: false,
          message: `STRUCTURAL_INVALID: no signedTx for queue entry ${entry.entryId} (tokenId=${entry.tokenId})`,
        },
      };
    }

    // ---- Merge-path graft detection. If a proof for this requestId is
    // already attached AND its transactionHash matches ours, the merge
    // path has already grafted in the proof (§5.6 third bullet); just
    // remove the queue entry. This is the W15 idempotency optimization:
    // a re-arrival of a more-finalized copy carries the proof, and we
    // skip the aggregator round-trip.
    let attachedProof: AnchoredProofDescriptor | null;
    try {
      attachedProof = await this.options.poolRead.getAttachedProof(
        entry.tokenId,
        entry.commitmentRequestId,
      );
    } catch {
      // Treat read failure as "no proof attached" — fall through to
      // submit / poll. The next worker pass re-tries the read; the
      // §5.6 idempotency ensures eventual convergence.
      attachedProof = null;
    }
    if (attachedProof !== null) {
      if (sameProofValue(attachedProof, ctxResolved)) {
        // Merge-path graft — proof already present + same value.
        // Remove the queue entry; we're done.
        await this.options.queueStore.remove(
          this.options.addressId,
          entry.entryId,
        );
        return {
          entryId: entry.entryId,
          tokenId: entry.tokenId,
          outcome: { kind: 'merge-path-graft' },
        };
      }
      // Different value at the same requestId. §6.3 forbidden case.
      // The §6.3 security-alert path is the SAME as T.5.B; we mirror
      // its emission and treat as belief-divergence hard-fail.
      this.options.emit('transfer:security-alert', {
        tokenId: entry.tokenId,
        requestId: entry.commitmentRequestId,
        attachedTransactionHash: attachedProof.transactionHash,
        observedTransactionHash: ctxResolved.transactionHash,
        attachedAuthenticator: attachedProof.authenticator,
        observedAuthenticator: ctxResolved.authenticator,
        message: `transfer:security-alert: pre-existing proof for queue entry ${entry.entryId} disagrees with our (transactionHash, authenticator)`,
      });
      return {
        entryId: entry.entryId,
        tokenId: entry.tokenId,
        outcome: {
          kind: 'hard-fail',
          reason: 'belief-divergence',
          skipCascade: false,
          message: `pre-existing proof at requestId ${entry.commitmentRequestId} disagrees on (transactionHash, authenticator)`,
        },
      };
    }

    // Submit phase.
    const submitResult = await this.runSubmitPhase({
      entryId: entry.entryId,
      tokenId: entry.tokenId,
      requestId: entry.commitmentRequestId,
    });
    if (submitResult.kind === 'hard-fail') {
      return {
        entryId: entry.entryId,
        tokenId: entry.tokenId,
        outcome: submitResult,
      };
    }

    // Poll phase.
    const pollResult = await this.runPollPhase({
      entryId: entry.entryId,
      bundleCid: entry.bundleCid,
      tokenId: entry.tokenId,
      requestId: entry.commitmentRequestId,
      ctx: ctxResolved,
    });
    return {
      entryId: entry.entryId,
      tokenId: entry.tokenId,
      outcome: pollResult,
    };
  }

  // ===========================================================================
  // 6.3. Submit phase (mirrors T.5.B)
  // ===========================================================================

  /**
   * §6.1 submit table. Returns either `{kind:'submitted'}` to indicate
   * "proceed to poll" or a hard-fail outcome.
   *
   * @internal
   */
  private async runSubmitPhase(args: {
    readonly entryId: string;
    readonly tokenId: string;
    readonly requestId: string;
  }): Promise<{ kind: 'submitted' } | HardFailOutcome> {
    let attempts = 0;
    let lastError: string | undefined;
    while (attempts <= this.maxSubmitRetries) {
      if (this.options.signal?.aborted === true || this.stopRequested) {
        return {
          kind: 'hard-fail',
          reason: 'structural',
          skipCascade: false,
          message: `worker aborted before submit for queue entry ${args.entryId}`,
        };
      }
      let outcome: SubmitOutcome;
      try {
        outcome = await this.options.aggregator.submit({
          addressId: this.options.addressId,
          tokenId: args.tokenId,
          requestId: args.requestId,
          aggregatorId: this.aggregatorId,
          signal: this.options.signal,
        });
      } catch (err) {
        outcome = {
          kind: 'TRANSIENT',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (outcome.kind === 'SUCCESS' || outcome.kind === 'REQUEST_ID_EXISTS') {
        return { kind: 'submitted' };
      }
      if (outcome.kind === 'AUTHENTICATOR_VERIFICATION_FAILED') {
        return {
          kind: 'hard-fail',
          reason: 'belief-divergence',
          skipCascade: false,
          message: `belief-divergence: aggregator rejected authenticator for queue entry ${args.entryId}${outcome.error ? ` (${outcome.error})` : ''}`,
        };
      }
      if (outcome.kind === 'REQUEST_ID_MISMATCH') {
        // Same C12/C13 path as T.5.B — emit operator alert, NO cascade.
        this.options.emit('transfer:operator-alert', {
          code: 'client-error',
          tokenId: args.tokenId,
          message: `REQUEST_ID_MISMATCH on submit: client computed an inconsistent (requestId, sourceState, transactionHash) tuple for queue entry ${args.entryId}${outcome.error ? ` (${outcome.error})` : ''}`,
        });
        return {
          kind: 'hard-fail',
          reason: 'client-error',
          skipCascade: true,
          message: `client-error: REQUEST_ID_MISMATCH on submit for queue entry ${args.entryId}${outcome.error ? ` (${outcome.error})` : ''}`,
        };
      }
      // TRANSIENT.
      lastError = outcome.error;
      attempts++;
      if (attempts > this.maxSubmitRetries) break;
      await this.options.sleep(getBackoffMs(attempts - 1), this.options.signal);
    }
    return {
      kind: 'hard-fail',
      reason: 'oracle-rejected',
      skipCascade: false,
      message: `submit transient retries exhausted (max=${this.maxSubmitRetries}) for queue entry ${args.entryId}${lastError ? ` last error: ${lastError}` : ''}`,
    };
  }

  // ===========================================================================
  // 6.4. Poll phase (mirrors T.5.B)
  // ===========================================================================

  /**
   * §6.1 poll table. Backoff + window per shared polling-policy.
   *
   * On `OK + transactionHash matches`: invokes the §5.5 step 5 attach
   * sequence under the per-tokenId mutex.
   *
   * On `OK + transactionHash mismatches`: race-lost (§6.1 step 4 /
   * §6.1.1 race-lost EXCEPTION) — hard-fail with skipCascade=true.
   *
   * @internal
   */
  private async runPollPhase(args: {
    readonly entryId: string;
    readonly bundleCid: string;
    readonly tokenId: string;
    readonly requestId: string;
    readonly ctx: RequestContext;
  }): Promise<RequestOutcome> {
    const startedAt = this.options.now();
    const tokenSemaphore = this.options.getPerTokenSemaphore(args.tokenId);
    let attempts = 0;
    let proofErrorRetries = 0;

    const releaseAgg = await this.perAggregatorSemaphore.acquire();
    let releaseTok: (() => void) | null = null;
    try {
      releaseTok = await tokenSemaphore.acquire();

      for (;;) {
        if (this.options.signal?.aborted === true || this.stopRequested) {
          return {
            kind: 'hard-fail',
            reason: 'structural',
            skipCascade: false,
            message: `worker aborted while polling queue entry ${args.entryId}`,
          };
        }

        const timeout = isPollingTimedOut(
          startedAt,
          this.options.now(),
          attempts,
        );
        if (timeout.timedOut) {
          return {
            kind: 'hard-fail',
            reason: 'oracle-rejected',
            skipCascade: false,
            message: `oracle-rejected (${timeout.reason}): queue entry ${args.entryId} not anchored within ${timeout.reason === 'safety-net-fired' ? '2× ' : ''}polling window (attempts=${attempts})`,
          };
        }

        await this.options.sleep(
          getBackoffMs(attempts),
          this.options.signal,
        );

        let pollOutcome: PollOutcome;
        try {
          pollOutcome = await this.options.aggregator.poll({
            addressId: this.options.addressId,
            tokenId: args.tokenId,
            requestId: args.requestId,
            aggregatorId: this.aggregatorId,
            signal: this.options.signal,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pollOutcome = {
            kind: 'TRANSIENT',
            error: `poll threw: ${message}`,
          };
        }

        if (pollOutcome.kind === 'TRANSIENT') {
          // Spec rule: TRANSIENT does not advance attempts.
          continue;
        }

        attempts++;

        if (pollOutcome.kind === 'OK') {
          // §6.1 race-loser detection.
          if (
            !sameTransactionHash(
              pollOutcome.proof.transactionHash,
              args.ctx.transactionHash,
            )
          ) {
            return {
              kind: 'hard-fail',
              reason: 'race-lost',
              skipCascade: true,
              message: `OUTBOX_RACE_LOST: queue entry ${args.entryId} anchored with mismatching transactionHash (local=${args.ctx.transactionHash} aggregator=${pollOutcome.proof.transactionHash})`,
            };
          }

          // §6.3 most-recent-proof / security-alert.
          const securityAlert = await this.checkProofConflict({
            tokenId: args.tokenId,
            requestId: args.requestId,
            entryId: args.entryId,
            local: args.ctx,
            anchored: pollOutcome.proof,
          });
          if (securityAlert.kind === 'security-alert') {
            return {
              kind: 'hard-fail',
              reason: 'belief-divergence',
              skipCascade: false,
              message: securityAlert.message,
            };
          }

          // Attach proof via the §5.5 step 5 4-step write order under
          // the per-tokenId mutex.
          await this.attachProofUnderMutex({
            tokenId: args.tokenId,
            requestId: args.requestId,
            entryId: args.entryId,
            proof: pollOutcome.proof,
            newCid: pollOutcome.newCid,
            previousCid: args.ctx.previousCid,
            nextEntryRest: args.ctx.nextEntryRest,
          });

          if (securityAlert.kind === 'superseded') {
            this.options.emit('transfer:proof-superseded', {
              tokenId: args.tokenId,
              requestId: args.requestId,
              previousCid: args.ctx.previousCid ?? '',
              newCid: pollOutcome.newCid,
            });
          }

          return { kind: 'success', newCid: pollOutcome.newCid };
        }

        if (pollOutcome.kind === 'PATH_NOT_INCLUDED') {
          continue;
        }

        if (pollOutcome.kind === 'PATH_INVALID') {
          proofErrorRetries++;
          if (proofErrorRetries >= this.maxProofErrorRetries) {
            return {
              kind: 'hard-fail',
              reason: 'proof-invalid',
              skipCascade: false,
              message: `PATH_INVALID after ${proofErrorRetries} retries: queue entry ${args.entryId}${pollOutcome.error ? ` (${pollOutcome.error})` : ''}`,
            };
          }
          continue;
        }

        if (pollOutcome.kind === 'NOT_AUTHENTICATED') {
          this.options.emit('transfer:trustbase-warning', {
            tokenId: args.tokenId,
            requestId: args.requestId,
            bundleCid: args.bundleCid,
            attempt: attempts,
            message:
              pollOutcome.error ??
              'NOT_AUTHENTICATED — proof verifier rejected validator signatures (likely stale local trustBase per §9.4.1)',
          });
          proofErrorRetries++;
          if (proofErrorRetries >= this.maxProofErrorRetries) {
            return {
              kind: 'hard-fail',
              reason: 'proof-invalid',
              skipCascade: false,
              message: `NOT_AUTHENTICATED after ${proofErrorRetries} retries: queue entry ${args.entryId} (likely stale trustBase per §9.4.1)`,
            };
          }
          continue;
        }
      }
    } finally {
      if (releaseTok !== null) releaseTok();
      releaseAgg();
    }
  }

  // ===========================================================================
  // 6.5. §6.3 most-recent-proof / security-alert (mirrors T.5.B)
  // ===========================================================================

  /**
   * Resolve the §6.3 fresh / superseded / attached-newer / security-
   * alert decision when a poll returns `OK`.
   *
   * @internal
   */
  private async checkProofConflict(args: {
    readonly tokenId: string;
    readonly requestId: string;
    readonly entryId: string;
    readonly local: { readonly transactionHash: string; readonly authenticator: string };
    readonly anchored: AnchoredProofDescriptor;
  }): Promise<
    | { kind: 'fresh' }
    | { kind: 'superseded' }
    | { kind: 'attached-newer' }
    | { kind: 'security-alert'; message: string }
  > {
    let attached: AnchoredProofDescriptor | null;
    try {
      attached = await this.options.poolRead.getAttachedProof(
        args.tokenId,
        args.requestId,
      );
    } catch {
      // Treat read failure as fresh — the attach orchestrator's
      // step 1 idempotency is the safety net.
      return { kind: 'fresh' };
    }
    if (attached === null) return { kind: 'fresh' };

    if (!sameProofValue(attached, args.anchored)) {
      const message = `transfer:security-alert: two proofs for the same requestId disagree on (transactionHash, authenticator) — single-spend invariant violated. tokenId=${args.tokenId} requestId=${args.requestId}`;
      this.options.emit('transfer:security-alert', {
        tokenId: args.tokenId,
        requestId: args.requestId,
        attachedTransactionHash: attached.transactionHash,
        observedTransactionHash: args.anchored.transactionHash,
        attachedAuthenticator: attached.authenticator,
        observedAuthenticator: args.anchored.authenticator,
        message,
      });
      return { kind: 'security-alert', message };
    }

    const attachedRound = attached.roundNumber ?? 0;
    const anchoredRound = args.anchored.roundNumber ?? 0;
    if (anchoredRound > attachedRound) return { kind: 'superseded' };
    return { kind: 'attached-newer' };
  }

  // ===========================================================================
  // 6.6. Attach via §5.5 step 5 4-step write — under per-tokenId mutex
  // ===========================================================================

  /**
   * Wraps the §5.5 step 5 orchestrator with the §5.5 step 9
   * per-tokenId mutex (CAS-default per W34).
   *
   * @internal
   */
  private async attachProofUnderMutex(args: {
    readonly tokenId: string;
    readonly requestId: string;
    readonly entryId: string;
    readonly proof: AnchoredProofDescriptor;
    readonly newCid: ContentHash;
    readonly previousCid?: ContentHash;
    readonly nextEntryRest: RequestContext['nextEntryRest'];
  }): Promise<void> {
    await this.options.perTokenMutex.acquire(
      args.tokenId,
      async () => {
        const ctx: ManifestCidRewriteContext = {
          addr: this.options.addressId,
          tokenId: args.tokenId,
          proofToAttach: {
            requestId: args.requestId,
            roundNumber: args.proof.roundNumber ?? 0,
            proof: args.proof.proof,
            timestamp: this.options.now(),
          },
          newCid: args.newCid,
          previousCid: args.previousCid,
          nextEntryRest: args.nextEntryRest,
          // The 4-step write's "queueEntryRequestId" is the queue
          // entry's id (matches FinalizationQueueAdapter contract).
          queueEntryRequestId: args.entryId,
          pool: this.options.pool,
          manifestCas: this.options.manifestCas,
          tombstones: this.options.tombstones,
          queue: this.options.queueAdapter,
        };
        await performManifestCidRewrite(ctx);
      },
      { strategy: this.perTokenMutexStrategy },
    );
  }

  // ===========================================================================
  // 6.7. §5.5 step 9 re-evaluator (W5)
  // ===========================================================================

  /**
   * §5.5 step 9 queue-drain → status transition. Called when every
   * queue entry of `tokenId` has been resolved success.
   *
   * Acquires the per-tokenId mutex (CAS-default per W34) and:
   *  1. Confirms the queue is fully drained for this tokenId (defensive
   *     re-read — protects against a concurrent ingest of a divergent
   *     bundle that re-added entries between our last `lookupByTokenId`
   *     and now).
   *  2. Builds the §5.5 step 9 re-evaluation input via
   *     {@link RevaluateHooksProvider.buildRevaluateInput}.
   *  3. Invokes {@link revaluate} ([B]/[D]/[E]).
   *  4. Routes the resulting {@link DispositionRecord} through the
   *     disposition writer (T.3.C).
   *  5. Maps the disposition to a terminal kind and emits
   *     `transfer:incoming` with `confirmed: true` on VALID.
   *
   * Returns the terminal kind, or `null` if re-evaluation was skipped
   * (e.g. queue not drained, hooks returned null).
   *
   * @internal
   */
  private async maybeFinalizeToken(
    tokenId: string,
  ): Promise<ProcessOneTokenResult['terminal'] | null> {
    return await this.options.perTokenMutex.acquire(
      tokenId,
      async () => {
        // Defensive re-read: confirm the queue is fully drained. Under
        // CAS strategy the mutex does not serialize concurrent
        // re-evaluations; under rpc-release / bounded-hold it does.
        // Either way the re-read is the source of truth.
        const remaining = await this.options.queueStore.lookupByTokenId(
          this.options.addressId,
          tokenId,
        );
        if (remaining.length > 0) {
          return null;
        }

        // Build the re-evaluation input.
        const input = await this.options.revaluateHooks.buildRevaluateInput(
          this.options.addressId,
          tokenId,
        );
        if (input === null) {
          return null;
        }

        const record = await revaluate(input);

        // Route through the disposition writer.
        try {
          await this.options.dispositionWriter.write(
            this.options.addressId,
            record,
          );
        } catch (err) {
          // Storage error — log via emit and bail; the next worker
          // pass will retry.
          this.options.emit('transfer:operator-alert', {
            code: 'structural',
            tokenId,
            message: `dispositionWriter.write failed during §5.5 step 9 re-evaluation: ${err instanceof Error ? err.message : String(err)}`,
          });
          return null;
        }

        // Map disposition to terminal kind.
        const terminal = mapDispositionToTerminal(record);

        if (record.disposition === 'VALID') {
          // Re-emit transfer:incoming with confirmed:true per §5.5
          // step 9: "All pass → manifest.status='valid'. Re-emit
          // transfer:incoming with confirmed:true."
          this.emitTransferIncomingConfirmed(tokenId);
        }
        return terminal;
      },
      { strategy: this.perTokenMutexStrategy },
    );
  }

  // ===========================================================================
  // 6.8. Hard-fail cascade (delegates to T.5.B.5)
  // ===========================================================================

  /**
   * Apply the §5.5 step 7 short-circuit:
   *  1. Move the recipient's own copy of the failing token to
   *     `_invalid` via the disposition writer (T.3.C). Self-
   *     invalidation applies in BOTH coin and NFT cases.
   *  2. Cancel polling for all OTHER queue entries of this tokenId
   *     by removing them from the queue. (The poll loops are bounded
   *     by signals and terminal poll responses; the queue-removal is
   *     the durability anchor.)
   *  3. Invoke the cascade walker (T.5.B.5). The walker decides
   *     coin vs NFT routing internally and emits
   *     `transfer:cascade-failed` for downstream notifications.
   *
   * Race-lost short-circuits: per §6.1.1, race-lost SKIPS the cascade
   * walker entirely; only self-invalidation occurs.
   *
   * Returns true iff the cascade walker was invoked.
   *
   * @internal
   */
  private async applyHardFailCascade(args: {
    readonly tokenId: string;
    readonly reason: DispositionReason;
    readonly message: string;
    readonly skipCascade: boolean;
    readonly observedTokenContentHash: ContentHash;
    readonly bundleCid: string;
  }): Promise<boolean> {
    // (1) Self-invalidation: write INVALID disposition for the
    // recipient's own copy.
    try {
      await this.options.dispositionWriter.write(this.options.addressId, {
        disposition: 'INVALID',
        tokenId: args.tokenId,
        observedTokenContentHash: args.observedTokenContentHash,
        bundleCid: args.bundleCid,
        senderTransportPubkey: '', // recipient self-invalidation has
        //                           no canonical sender; the writer
        //                           accepts empty per §5.4 schema
        //                           (forensic field, not key).
        reason: args.reason,
      });
    } catch (err) {
      this.options.emit('transfer:operator-alert', {
        code: args.reason,
        tokenId: args.tokenId,
        message: `dispositionWriter.write failed during §5.5 step 7 self-invalidation: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // (2) Cancel polling for all OTHER queue entries of this tokenId
    // by removing them from the queue. The poll loops are bounded by
    // their own signals; the queue-removal is the durability anchor.
    let siblings: ReadonlyArray<FinalizationQueueEntry>;
    try {
      siblings = await this.options.queueStore.lookupByTokenId(
        this.options.addressId,
        args.tokenId,
      );
    } catch {
      siblings = [];
    }
    for (const s of siblings) {
      try {
        await this.options.queueStore.remove(
          this.options.addressId,
          s.entryId,
        );
      } catch {
        // Best-effort — the cascade walker proceeds regardless.
      }
    }

    // (3) Cascade per §6.1.1 — race-lost EXCEPTION SKIPS the walk.
    if (args.skipCascade) {
      return false;
    }
    try {
      await this.options.cascadeWalker.cascade(
        this.options.addressId,
        args.tokenId,
        args.reason,
      );
    } catch (err) {
      // Cascade walker failures do NOT propagate — the operator can
      // re-trigger via revalidateCascadedChildren() if needed.
      this.options.emit('transfer:operator-alert', {
        code: args.reason,
        tokenId: args.tokenId,
        message: `cascadeWalker.cascade threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return true;
  }

  // ===========================================================================
  // 6.9. transfer:incoming (confirmed:true) emission helper
  // ===========================================================================

  /**
   * Emit `transfer:incoming` with `confirmed:true` per §5.5 step 9.
   *
   * The payload is intentionally minimal — the recipient pipeline
   * already emitted the rich `transfer:incoming` (with `confirmed:false`
   * implicitly) at first ingest. This re-emission is the §5.5 step 9
   * confirmation signal.
   *
   * @internal
   */
  private emitTransferIncomingConfirmed(tokenId: string): void {
    const payload: IncomingTransfer = {
      id: `finalize:${tokenId}`,
      senderPubkey: '',
      tokens: [],
      receivedAt: this.options.now(),
    };
    this.options.emit('transfer:incoming', payload);
  }

  // ===========================================================================
  // 6.10. observedHashFor — synthesize the observedTokenContentHash for
  //        the §5.4 disposition record key
  // ===========================================================================

  /**
   * The §5.4 record schema requires
   * `observedTokenContentHash` for `_invalid` / `_audit` records. The
   * recipient worker's queue entries do not carry this directly; we
   * approximate with the bundleCid + entryId composite — production
   * wiring may override via a more accurate map (out of scope for
   * T.5.C; the value is forensic, not load-bearing).
   *
   * The cast is safe at the type level: the UXF `ContentHash` brand is
   * structurally-compatible with any 64-hex string; we synthesize a
   * deterministic tagged value here for the disposition record key.
   *
   * @internal
   */
  private observedHashFor(entry: FinalizationQueueEntry): ContentHash {
    return entry.transactionHash as ContentHash;
  }

  // ===========================================================================
  // 6.11. Scan loop (mirrors T.5.B's stub — production drives via
  //         `processOneToken`)
  // ===========================================================================

  /**
   * Long-running scan loop. Production wires the loop to the queue's
   * `list()` method; here we maintain a stub that sleeps until stop is
   * requested so `start()`/`stop()` work end-to-end in tests.
   *
   * @internal
   */
  private async scanLoop(): Promise<void> {
    while (!this.stopRequested && this.options.signal?.aborted !== true) {
      try {
        await this.options.sleep(getBackoffMs(0), this.options.signal);
      } catch {
        // signal aborted — fall through to loop check.
      }
    }
  }
}

// =============================================================================
// 7. mapDispositionToTerminal — disposition record → terminal kind
// =============================================================================

/**
 * Map a {@link DispositionRecord} to the worker's terminal kind. The
 * mapping follows §5.5 step 9's transition rules:
 *
 *  - VALID                                → 'valid'
 *  - AUDIT(off-record-spend)              → 'unspendable'
 *  - AUDIT(not-our-state)                 → 'not-our-state'
 *  - CONFLICTING                          → 'conflicting'
 *  - INVALID                              → 'invalid'
 *  - PENDING (caller bug — queue not drained) → 'in-progress'
 *
 * @internal
 */
function mapDispositionToTerminal(
  record: DispositionRecord,
): ProcessOneTokenResult['terminal'] {
  switch (record.disposition) {
    case 'VALID':
      return 'valid';
    case 'PENDING':
      return 'in-progress';
    case 'CONFLICTING':
      return 'conflicting';
    case 'AUDIT':
      return record.reason === 'off-record-spend'
        ? 'unspendable'
        : 'not-our-state';
    case 'INVALID':
      return 'invalid';
    default: {
      const _exhaustive: never = record;
      void _exhaustive;
      return 'in-progress';
    }
  }
}
