/**
 * UXF Transfer — recipient-side finalization worker (T.5.C).
 *
 * Implements `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.5 (per-token
 * finalization, chain-mode landing path) + §6.2 (recipient-side worker
 * driver). Mirror of the sender worker (T.5.B,
 * `finalization-worker-sender.ts`) but driven from the per-address
 * {@link FinalizationQueue} rather than the outbox.
 *
 * **Phase 8 refactor**: the §6.1 submit / poll / attach cycle was
 * extracted into {@link runFinalizationCycle} (in
 * `finalization-worker-base.ts`) — the sender and recipient workers
 * share a single driver. This file now owns ONLY the recipient-side
 * concerns: queue iteration, the §5.6 merge-path graft check (recipient
 * only), §5.5 step 9 re-evaluation, recipient-side cascade emission.
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
 *     step 3 / 4 are similarly idempotent.
 *
 *  5. **Merge-path proof grafting**: when a more-finalized UXF copy
 *     of the same token arrives (§5.6 third bullet), its proofs are
 *     grafted into the local pool BY THE INGEST PIPELINE (T.3.D
 *     conflict merger), NOT by this worker. The worker observes the
 *     merge by polling its own queue: a queue entry whose
 *     corresponding proof is now present in the pool can be REMOVED
 *     without an aggregator round-trip. This is implemented BEFORE
 *     calling the shared cycle driver via {@link checkMergePathGraft}.
 *
 *  6. **Per-tokenId mutex (T.1.F) coordination**: the §5.5 step 9
 *     re-run is acquired under the per-tokenId mutex with
 *     CAS-default strategy (W34); the manifest-CID-rewrite is
 *     wrapped in the same mutex on each individual queue-entry
 *     attach (matches the T.5.B sender worker behavior).
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
  MIN_POLL_ATTEMPTS,
} from './polling-policy';
import { getAggregatorSemaphore } from './aggregator-semaphores';
import {
  type FinalizationQueueAdapter,
  type PoolWriteAdapter,
  type TombstoneWriteAdapter,
} from './manifest-cid-rewrite';
import {
  attachProofUnderMutex,
  runFinalizationCycle,
  sameProofValue,
  type AnchoredProofDescriptor,
  type FinalizationAggregatorClient,
  type HardFailOutcome,
  type PollOutcome,
  type PoolReadAdapter,
  type RequestContext,
  type RequestContextResolver,
  type Semaphore,
  type SubmitOutcome,
  type SubmitOutcomeKind,
  type PollOutcomeKind,
} from './finalization-worker-base';
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
import type { TrustBaseStaleness } from './trustbase-staleness';

// Re-export the shared adapter types for caller convenience. The
// worker's contracts mirror T.5.B by design; production wiring
// instantiates the same fakes.
export type {
  AnchoredProofDescriptor,
  FinalizationAggregatorClient,
  PollOutcome,
  PollOutcomeKind,
  PoolReadAdapter,
  RequestContext,
  RequestContextResolver,
  Semaphore,
  SubmitOutcome,
  SubmitOutcomeKind,
};

/**
 * Wave 4 steelman: hard upper bound on the size of a single
 * `queueStore.list()` result the recipient scan loop will accept
 * without alerting. Same rationale as
 * {@link SCAN_LIST_HARD_GUARD} in `finalization-worker-sender.ts`.
 *
 * Sized at 16384. The finalization queue holds at most one entry
 * per (tokenId, txIndex) tuple; a healthy address rarely exceeds
 * a few hundred entries even under heavy chain-mode load.
 *
 * The scan loop truncates to this cap and emits a structural alert;
 * progress on the first {@link RECIPIENT_SCAN_LIST_HARD_GUARD}
 * entries continues.
 *
 * @internal
 */
export const RECIPIENT_SCAN_LIST_HARD_GUARD = 16384;

/**
 * Power-of-two helper for the exponential alert backoff.
 * @internal
 */
function isPowerOfTwoRecipient(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

// Wave 6 introduced MIN_RECOVERY_ALERT_STREAK (= 4) on the recipient
// side as a mirror of the sender fix. Wave 7 retired the constant: at
// streak=2 an `isPowerOfTwoRecipient(2)` failure alert fired, but the
// matching recovery transition (`2 → 0`) was suppressed by `2 < 4`,
// leaving the operator's page-on-alert / clear-on-recovery script with
// a dangling page.
//
// The Wave 7 rule is "emit recovery iff a failure alert was emitted in
// THIS streak". Each counter pairs with a `*EmittedAtStreak` watermark
// that records the streak depth at which the most recent failure alert
// fired (0 ⇒ no failure alert this streak). Recovery emits when streak
// transitions non-zero → zero AND the watermark is non-zero. Watermark
// resets together with the counter.

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
  /**
   * Per-aggregator semaphore (W14, default 16). Optional — when omitted,
   * the worker falls back to the process-global registry in
   * {@link getAggregatorSemaphore} keyed on `aggregatorId`. Tests
   * inject explicit semaphores for deterministic isolation; production
   * MUST omit this field so the cap is enforced process-globally.
   */
  readonly perAggregatorSemaphore?: Semaphore;
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
  /**
   * Scan-loop tick interval (ms). On every iteration the worker:
   *  1. Reads all queue entries via `queueStore.list(addressId)`.
   *  2. Groups them by tokenId and calls {@link processOneToken} for
   *     each group, isolated by per-token try/catch.
   *  3. If at least one token was processed, immediately re-scans
   *     (no sleep) — drains backlogs without latency.
   *  4. Otherwise, sleeps `scanIntervalMs` before the next pass.
   *
   * Default: 30_000 (30 seconds). Tests typically override down to
   * a small value (e.g. 1ms) to exercise the loop deterministically.
   */
  readonly scanIntervalMs?: number;
  /**
   * Cap on tokens processed per scan cycle. Defaults to 100 — guards
   * against CPU pegging when the queue holds an enormous backlog.
   */
  readonly maxTokensPerScan?: number;
  /**
   * Opt-out: when `true`, `start()` activates a stub scan loop (sleep-
   * only). Useful for tests that probe `isRunning()` without driving
   * real work. Default `false` — production wires the real scan loop.
   */
  readonly manualScan?: boolean;
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal;
  /** Aggregator endpoint identifier. Defaults to `'default'`. */
  readonly aggregatorId?: string;
  /**
   * Optional trustBase staleness ledger (T.5.F / W41). When supplied,
   * the worker invokes {@link TrustBaseStaleness.refreshTrustBase} on
   * the FIRST `NOT_AUTHENTICATED` observation and retries the poll
   * within the same window. A SECOND `NOT_AUTHENTICATED` after a
   * successful refresh escalates: the worker emits
   * `transfer:security-alert` and hard-fails with
   * `reason: 'proof-invalid'` immediately (per §9.4.1 two-strike).
   *
   * If omitted, the worker preserves T.5.C's original behavior:
   * `NOT_AUTHENTICATED` retries up to `maxProofErrorRetries` then
   * hard-fails with `reason: 'proof-invalid'` (no security-alert).
   */
  readonly trustBaseStaleness?: TrustBaseStaleness;
}

// =============================================================================
// 4. Internal types — disposition + per-entry processing result
// =============================================================================

/** Merge-path graft outcome — recipient-only, distinct from the
 *  shared cycle outcomes. */
interface MergePathOutcome {
  /** Merge-path graft: the proof was already attached by ingest
   *  pipeline before the worker reached it. The queue entry was
   *  removed without an aggregator round-trip. */
  readonly kind: 'merge-path-graft';
}

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
// 5. FinalizationWorkerRecipient
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
  private readonly trustBaseStaleness: TrustBaseStaleness | undefined;
  private readonly scanIntervalMs: number;
  private readonly maxTokensPerScan: number;
  private readonly manualScan: boolean;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  /** In-flight `processOneToken` invocations, keyed by tokenId. The
   *  scan loop skips tokens already being driven so an external caller
   *  and the loop don't race the same token. Guards the per-tokenId
   *  mutex from holding two budgets concurrently for the same key. */
  private readonly inFlightTokens: Set<string> = new Set();
  /**
   * Wave 4 steelman: consecutive `queueStore.list()` failure counter
   * for exponential alert backoff. Same rationale as the sender
   * worker's {@link FinalizationWorkerSender#scanReadFailureStreak}.
   *
   * @internal
   */
  private scanReadFailureStreak = 0;
  /**
   * Wave 7: emit-if-emitted watermark for the read-failure counter.
   * See sender-side {@link
   * FinalizationWorkerSender#scanReadFailureEmittedAtStreak} for the
   * rationale. 0 ⇒ no failure alert in the current streak.
   * @internal
   */
  private scanReadFailureEmittedAtStreak = 0;
  /**
   * Wave 5 steelman: consecutive over-size truncation counter for
   * exponential alert backoff. Same rationale as the sender worker's
   * `scanOversizeStreak` — a persistently-misconfigured queue store
   * (no tombstone GC) was firing the alert on every cycle. Power-of-
   * two boundaries only; recovery info on first under-cap read.
   *
   * @internal
   */
  private scanOversizeStreak = 0;
  /**
   * Wave 7: emit-if-emitted watermark for the over-size counter.
   * See {@link scanReadFailureEmittedAtStreak} doc.
   * @internal
   */
  private scanOversizeEmittedAtStreak = 0;

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
    this.aggregatorId = options.aggregatorId ?? 'default';
    // W14 steelman post-cutover: fall back to the process-global
    // per-aggregator semaphore registry when the caller doesn't inject
    // one. See `aggregator-semaphores.ts` for the rationale.
    this.perAggregatorSemaphore =
      options.perAggregatorSemaphore ??
      getAggregatorSemaphore(this.aggregatorId);
    this.perAggregator =
      options.caps?.perAggregator ?? MAX_CONCURRENT_POLLS_PER_AGGREGATOR;
    this.perToken = options.caps?.perToken ?? MAX_CONCURRENT_POLLS_PER_TOKEN;
    this.maxSubmitRetries = options.caps?.maxSubmitRetries ?? 5;
    this.maxProofErrorRetries = options.caps?.maxProofErrorRetries ?? 3;
    this.pollingWindowMs = options.caps?.pollingWindowMs ?? POLLING_WINDOW_MS;
    // Wave 4 steelman: default to 'rpc-release' for consistency with
    // import-inclusion-proof and ingest-worker-pool. The 'cas' default
    // silently lost serialization for callers that didn't wire a
    // CAS-based ManifestCas; 'rpc-release' is correct without extra
    // wiring.
    this.perTokenMutexStrategy = options.perTokenMutexStrategy ?? 'rpc-release';
    this.trustBaseStaleness = options.trustBaseStaleness;
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.maxTokensPerScan = options.maxTokensPerScan ?? 100;
    this.manualScan = options.manualScan ?? false;
    if (
      !Number.isFinite(this.scanIntervalMs) ||
      this.scanIntervalMs <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerRecipient: scanIntervalMs must be > 0; got ${this.scanIntervalMs}`,
        'VALIDATION_ERROR',
      );
    }
    if (
      !Number.isFinite(this.maxTokensPerScan) ||
      this.maxTokensPerScan <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerRecipient: maxTokensPerScan must be > 0; got ${this.maxTokensPerScan}`,
        'VALIDATION_ERROR',
      );
    }

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
  // 5.1. Per-tokenId driver
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
    // De-dup: if the scan loop (or a prior external caller) is already
    // driving this token, skip — return an in-progress sentinel.
    if (this.inFlightTokens.has(tokenId)) {
      return {
        tokenId,
        entriesProcessed: 0,
        successCount: 0,
        hardFailCount: 0,
        mergePathGraftCount: 0,
        cascadeInvoked: false,
        terminal: 'in-progress',
      };
    }
    this.inFlightTokens.add(tokenId);
    try {
      return await this.processOneTokenLocked(tokenId);
    } finally {
      this.inFlightTokens.delete(tokenId);
    }
  }

  /** Internal worker for {@link processOneToken}. The wrapper guards
   *  against double-processing via {@link inFlightTokens}; this method
   *  assumes the caller has already taken that slot. */
  private async processOneTokenLocked(
    tokenId: string,
  ): Promise<ProcessOneTokenResult> {
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
    // Steelman fix: Promise.allSettled (was Promise.all). With Promise.all,
    // a single processQueueEntry throw aborts the parent fold while the
    // other in-flight calls continue running orphaned, holding semaphores
    // and mutating state with their results discarded. allSettled lets
    // every entry reach a structured outcome.
    const settled = await Promise.allSettled(
      entries.map((e) => this.processQueueEntry(e)),
    );
    const results = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const entry = entries[i]!;
      // Steelman recursion fix: capture FULL stack via err.stack so
      // postmortem analysis can distinguish a genuine oracle rejection
      // from an internal worker bug. Prefix with "WORKER-INTERNAL:" so
      // operators grep'ing logs can spot the mis-attribution.
      const errMsg =
        r.reason instanceof Error
          ? `WORKER-INTERNAL: ${r.reason.stack ?? r.reason.message}`
          : `WORKER-INTERNAL: ${String(r.reason)}`;
      return {
        entry,
        outcome: {
          kind: 'hard-fail' as const,
          reason: 'oracle-rejected' as DispositionReason,
          skipCascade: false,
          message: errMsg,
        },
      };
    });

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
  // 5.2. Per-queue-entry processing
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
    const graft = await this.checkMergePathGraft(entry, ctxResolved);
    if (graft !== null) {
      return {
        entryId: entry.entryId,
        tokenId: entry.tokenId,
        outcome: graft,
      };
    }

    // Run the §6.1 cycle via the shared driver. The cycle handles
    // submit + poll + race-loser detection + §6.3 conflict + attach
    // (the side-specific attach closure performs the manifest-CID-
    // rewrite under the per-tokenId mutex with `entryId` as the queue-
    // removal key).
    const perTokenSemaphore = this.options.getPerTokenSemaphore(entry.tokenId);
    const cycle = await runFinalizationCycle({
      addressId: this.options.addressId,
      tokenId: entry.tokenId,
      requestId: entry.commitmentRequestId,
      bundleCid: entry.bundleCid,
      // Recipient: NO outboxId — the recipient queue entries are not
      // outbox-resident. Events emitted from the cycle omit the
      // optional `outboxId` field accordingly.
      // Recipient uses `queue entry X` formatting (no `=` separator
      // even in the EqPhrase slot — this matches the pre-refactor
      // recipient messages byte-for-byte).
      subjectPhrase: `queue entry ${entry.entryId}`,
      subjectEqPhrase: `queue entry ${entry.entryId}`,
      structuralInvalidMessage: `STRUCTURAL_INVALID: no signedTx for queue entry ${entry.entryId} (tokenId=${entry.tokenId})`,
      resolver: this.options.resolver,
      aggregator: this.options.aggregator,
      poolRead: this.options.poolRead,
      perAggregatorSemaphore: this.perAggregatorSemaphore,
      perTokenSemaphore,
      // W26 cross-restart fix: use the queue entry's PERSISTED
      // `submittedAt` as the deadline anchor, NOT a fresh `now()`.
      // Otherwise the §5.5 step 6 hard safety net (2 ×
      // POLLING_WINDOW_MS) restarts on every worker re-entry, letting
      // a token poll indefinitely across crash/restart cycles.
      //
      // Steelman fix (CRIT #8): the queue's writer contract initializes
      // `submittedAt = createdAt` and updates it on the FIRST successful
      // submit; until that update lands, the field carries the queue's
      // creation timestamp. If a queue entry is enqueued and then sits
      // for ≥ 2 × POLLING_WINDOW_MS before pickup (e.g. a worker that
      // restarts after a long outage, or a queue that accumulates entries
      // before the worker starts), using `entry.submittedAt` as the
      // deadline anchor would hard-fail oracle-rejected on the first
      // poll attempt — BEFORE we've even submitted. The fix:
      // `submittedAt === createdAt` is the sentinel "no submit yet" — in
      // that case anchor the deadline at `now()` (this cycle's start)
      // so the polling window measures from when the worker actually
      // begins polling. Once a submit succeeds the queue writer should
      // CAS-update submittedAt; on subsequent passes the persisted value
      // wins and W26 cross-restart termination is preserved.
      pollStartedAt:
        entry.submittedAt > entry.createdAt
          ? entry.submittedAt
          : this.options.now(),
      emit: this.options.emit,
      now: this.options.now,
      sleep: this.options.sleep,
      signal: this.options.signal,
      isStopped: () => this.stopRequested,
      maxSubmitRetries: this.maxSubmitRetries,
      maxProofErrorRetries: this.maxProofErrorRetries,
      aggregatorId: this.aggregatorId,
      trustBaseStaleness: this.trustBaseStaleness,
      attachProof: async (attachArgs) => {
        await attachProofUnderMutex({
          addressId: this.options.addressId,
          tokenId: entry.tokenId,
          requestId: entry.commitmentRequestId,
          proof: attachArgs.proof,
          newCid: attachArgs.newCid,
          previousCid: attachArgs.previousCid,
          nextEntryRest: attachArgs.nextEntryRest,
          // Recipient: queueEntryRequestId IS the queue entry's id.
          // The 4-step write's queue removal targets the entry-keyed
          // slot.
          queueEntryRequestId: entry.entryId,
          pool: this.options.pool,
          manifestCas: this.options.manifestCas,
          tombstones: this.options.tombstones,
          queue: this.options.queueAdapter,
          perTokenMutex: this.options.perTokenMutex,
          perTokenMutexStrategy: this.perTokenMutexStrategy,
          now: this.options.now,
        });
      },
    });

    return {
      entryId: entry.entryId,
      tokenId: entry.tokenId,
      outcome: cycle,
    };
  }

  // ===========================================================================
  // 5.3. Merge-path graft check (recipient-only)
  // ===========================================================================

  /**
   * §5.6 merge-path graft detection. Performed BEFORE submit so we can
   * fast-path queue removals when the ingest pipeline already grafted
   * in the proof.
   *
   * Returns:
   *  - `null` — no graft applies, caller proceeds to the shared cycle.
   *  - `{kind: 'merge-path-graft'}` — proof present + matching value;
   *    queue entry removed.
   *  - `HardFailOutcome` — proof present + DIFFERENT value
   *    (`belief-divergence`). The §6.3 security-alert is emitted from
   *    here.
   *
   * @internal
   */
  private async checkMergePathGraft(
    entry: FinalizationQueueEntry,
    ctxResolved: RequestContext,
  ): Promise<MergePathOutcome | HardFailOutcome | null> {
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
      return null;
    }
    if (attachedProof === null) return null;

    if (sameProofValue(attachedProof, ctxResolved)) {
      // Merge-path graft — proof already present + same value.
      // Remove the queue entry; we're done.
      await this.options.queueStore.remove(
        this.options.addressId,
        entry.entryId,
      );
      return { kind: 'merge-path-graft' };
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
      kind: 'hard-fail',
      reason: 'belief-divergence',
      skipCascade: false,
      message: `pre-existing proof at requestId ${entry.commitmentRequestId} disagrees on (transactionHash, authenticator)`,
    };
  }

  // ===========================================================================
  // 5.4. §5.5 step 9 re-evaluator (W5)
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
  // 5.5. Hard-fail cascade (delegates to T.5.B.5)
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
    void args.message;
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
  // 5.6. transfer:incoming (confirmed:true) emission helper
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
  // 5.7. observedHashFor — synthesize the observedTokenContentHash for
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
  // 5.8. Scan loop (mirrors T.5.B's stub — production drives via
  //         `processOneToken`)
  // ===========================================================================

  /**
   * Long-running scan loop (#168 production scheduler). Each iteration:
   *  1. Reads all queue entries via `queueStore.list(addressId)`.
   *  2. Groups them by tokenId; for each unique tokenId not currently
   *     in {@link inFlightTokens}, calls {@link processOneToken} with
   *     per-token try/catch.
   *  3. If at least one token was processed, immediately re-scans
   *     (no sleep) — drains backlogs without latency.
   *  4. Otherwise sleeps `scanIntervalMs` before the next pass.
   *
   * Loop terminates when {@link stop} is called or the construction-
   * supplied `signal` aborts.
   *
   * @internal
   */
  private async scanLoop(): Promise<void> {
    while (!this.stopRequested && this.options.signal?.aborted !== true) {
      // Manual-scan opt-out → fall back to a sleep-only stub so
      // `start()`/`stop()`/`isRunning()` lifecycle tests keep working.
      if (this.manualScan) {
        await this.safeSleep(this.scanIntervalMs);
        continue;
      }

      let processed = 0;
      try {
        const all = await this.options.queueStore.list(this.options.addressId);
        // Wave 4 steelman: defensive size guard. The queueStore
        // contract (FinalizationQueue.list, see finalization-queue.ts
        // §3) returns the full per-address list; a misconfigured
        // backend (no tombstone GC, runaway corrupt-slot recovery)
        // could OOM the worker on a degenerate dataset. Truncate +
        // alert if the list exceeds RECIPIENT_SCAN_LIST_HARD_GUARD;
        // forward progress on the first cap entries continues.
        //
        // Wave 5 steelman fix #2: alert flood backoff (mirrors the
        // sender). A permanent overrun was firing the alert every
        // cycle; rate-limit via power-of-two boundaries with a
        // recovery info on first under-cap read.
        let workingList: ReadonlyArray<typeof all[number]> = all;
        if (all.length > RECIPIENT_SCAN_LIST_HARD_GUARD) {
          this.scanOversizeStreak += 1;
          if (isPowerOfTwoRecipient(this.scanOversizeStreak)) {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message:
                `FinalizationWorkerRecipient.scanLoop: queueStore.list returned ` +
                `${all.length} entries (queue contract: <= ` +
                `${RECIPIENT_SCAN_LIST_HARD_GUARD}); truncating to first ` +
                `${RECIPIENT_SCAN_LIST_HARD_GUARD} to avoid OOM (consecutive ` +
                `overruns: ${this.scanOversizeStreak}). Inspect the ` +
                `finalization queue for unbounded growth (missing tombstone GC?).`,
            });
            // Wave 7 emit-if-emitted watermark.
            this.scanOversizeEmittedAtStreak = this.scanOversizeStreak;
          }
          workingList = all.slice(0, RECIPIENT_SCAN_LIST_HARD_GUARD);
        } else if (this.scanOversizeStreak > 0) {
          // Recovery: queueStore is now within budget.
          //
          // Wave 7 steelman fix: emit-if-emitted (mirror of sender-side
          // fix). Wave 6's `MIN_RECOVERY_ALERT_STREAK = 4` left a gap
          // at streak=2-3 where a failure alert fired but recovery was
          // suppressed, leaving pager scripts with a dangling page.
          // Recovery now emits iff a failure alert was emitted in this
          // streak.
          if (this.scanOversizeEmittedAtStreak > 0) {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message:
                `FinalizationWorkerRecipient.scanLoop: queueStore.list under ` +
                `RECIPIENT_SCAN_LIST_HARD_GUARD again after ` +
                `${this.scanOversizeStreak} consecutive over-size cycle(s).`,
            });
          }
          this.scanOversizeStreak = 0;
          this.scanOversizeEmittedAtStreak = 0;
        }

        // Successful read — emit recovery info if we were in a streak.
        // Wave 7 steelman fix: emit-if-emitted gating (see oversize
        // path above).
        if (this.scanReadFailureStreak > 0) {
          if (this.scanReadFailureEmittedAtStreak > 0) {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message:
                `FinalizationWorkerRecipient.scanLoop: queueStore.list ` +
                `recovered after ${this.scanReadFailureStreak} consecutive failure(s).`,
            });
          }
          this.scanReadFailureStreak = 0;
          this.scanReadFailureEmittedAtStreak = 0;
        }

        // Group by tokenId. The queue can hold K entries per K-deep
        // chain-mode token; one `processOneToken` call drives all
        // entries for that token.
        const tokenIds: string[] = [];
        const seen = new Set<string>();
        for (const e of workingList) {
          if (seen.has(e.tokenId)) continue;
          if (this.inFlightTokens.has(e.tokenId)) continue;
          seen.add(e.tokenId);
          tokenIds.push(e.tokenId);
          if (tokenIds.length >= this.maxTokensPerScan) break;
        }

        for (const tokenId of tokenIds) {
          if (this.stopRequested) break;
          if (this.options.signal?.aborted) break;
          try {
            await this.processOneToken(tokenId);
            processed += 1;
          } catch (err) {
            // processOneToken should be total (allSettled inside) but
            // a throw here is forensic-only; emit and continue.
            const msg = err instanceof Error ? err.message : String(err);
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              tokenId,
              message: `FinalizationWorkerRecipient.scanLoop: processOneToken threw for tokenId=${tokenId}: ${msg}`,
            });
          }
        }
      } catch (err) {
        // Wave 4 steelman: exponential backoff. First failure emits;
        // subsequent failures emit at power-of-two boundaries only.
        // Reset on next success.
        this.scanReadFailureStreak += 1;
        if (isPowerOfTwoRecipient(this.scanReadFailureStreak)) {
          const msg = err instanceof Error ? err.message : String(err);
          this.options.emit('transfer:operator-alert', {
            code: 'structural',
            message:
              `FinalizationWorkerRecipient.scanLoop: queueStore.list threw ` +
              `(consecutive failures: ${this.scanReadFailureStreak}): ${msg}`,
          });
          // Wave 7 emit-if-emitted watermark.
          this.scanReadFailureEmittedAtStreak = this.scanReadFailureStreak;
        }
      }

      if (processed === 0) {
        await this.safeSleep(this.scanIntervalMs);
      } else {
        // Cooperative yield while draining a backlog.
        await this.safeSleep(0);
      }
    }
  }

  /**
   * Wrap `options.sleep` so abort exceptions don't escape the loop.
   *
   * @internal
   */
  private async safeSleep(ms: number): Promise<void> {
    try {
      await this.options.sleep(ms, this.options.signal);
    } catch {
      // Sleep aborted via signal — fall through.
    }
  }
}

// =============================================================================
// 6. mapDispositionToTerminal — disposition record → terminal kind
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
