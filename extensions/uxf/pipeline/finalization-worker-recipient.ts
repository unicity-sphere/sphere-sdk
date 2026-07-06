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
  combineAbortSignals,
  hashAuthenticatorForLog,
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
import type { ContentHash } from '../bundle/types';
import type { DispositionReason } from '../../../types/disposition';
import type {
  IncomingTransfer,
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import { SphereError } from '../../../core/errors';
import { sanitizeReasonString, safeErrorMessage } from '../../../core/error-sanitize';
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
 * Round 3 regression fix: bounded LRU cap for the cascade-tombstone
 * memo set. Pre-Round-3 the set grew unbounded — a long-lived
 * recipient worker accumulated one tombstone per cascade indefinitely.
 * The cap here is a hard guarantee: insertions past the cap evict
 * the oldest tombstone in insertion order.
 *
 * Sizing: 10000 covers ~3 days of sustained cascade activity at the
 * realistic worst-case rate of ~30 cascades/min (one per token in a
 * heavily-attacked address). Cross-restart safety is delivered by
 * the disposition writer's INVALID record on disk; the in-memory set
 * is purely a fast-path memo, so eviction of the oldest entries is
 * always safe — they're the ones whose disposition record has long
 * since been observed by every active poll cycle.
 *
 * @internal
 */
export const CASCADE_TOMBSTONE_HARD_CAP = 10000;

/**
 * Round 3 regression fix: high-water mark for cascade-tombstone
 * accumulation. When the live set crosses this threshold a
 * `transfer:operator-alert` fires (once per accumulation cycle —
 * see {@link FinalizationWorkerRecipient#cascadeTombstoneHighWatermarkAlerted}
 * for the debounce). Sized at 80% of {@link CASCADE_TOMBSTONE_HARD_CAP}
 * so operators have time to investigate before silent eviction begins.
 *
 * @internal
 */
export const CASCADE_TOMBSTONE_HIGH_WATERMARK = 8000;

/**
 * Round 5 fix (HIGH GAP) — minimum interval between consecutive
 * "steady-state eviction" operator alerts. Once the cascade-tombstone
 * set is at the hard cap, every new insert evicts the oldest entry —
 * we emit an alert at most once per this interval so operators see a
 * continuous signal of the saturated state without flooding.
 *
 * Default 1 hour. The high-watermark alert is a one-shot signal
 * fired on initial crossing; this is the steady-state companion.
 *
 * @internal
 */
export const CASCADE_TOMBSTONE_EVICTION_ALERT_INTERVAL_MS = 60 * 60 * 1000;

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
  /**
   * Round 5 fix (HIGH NEW) — explicit lifecycle state field. Pre-fix
   * the lifecycle was tracked by two booleans (`running` +
   * `stopRequested`); a tight `start() → stop() → start()` sequence
   * could have the second `start()` observe `running === true`
   * (because `stop()` had set `stopRequested = true` but had not yet
   * cleared `running`) and silently no-op, leaving the worker
   * permanently dead. The state field makes the four reachable
   * lifecycle states explicit:
   *
   *   - `'idle'`     — never started, or fully stopped.
   *   - `'starting'` — `start()` in flight (rare; field is set
   *                    synchronously, but reserved for future async-
   *                    start refactors).
   *   - `'running'`  — `scanLoop()` is the active task.
   *   - `'stopping'` — `stop()` aborted the controller and is
   *                    awaiting `loopPromise`. A concurrent `start()`
   *                    in this state MUST await the in-flight stop
   *                    and then proceed.
   *
   * @internal
   */
  private lifecycleState: 'idle' | 'starting' | 'running' | 'stopping' =
    'idle';
  /**
   * Round 5 fix (HIGH NEW) — promise resolved when the in-flight
   * `stop()` has fully cleared. Lets a concurrent `start()` await
   * the stop and proceed without busy-wait. Cleared back to `null`
   * once the stop completes.
   *
   * @internal
   */
  private stopInFlight: Promise<void> | null = null;
  /**
   * Round 7 fix (HIGH NEW) — explicit "deferred restart pending" flag.
   *
   * Round 5 introduced the `'starting'` state for the
   * `start() → stop()(A) → start()` case: the second `start()` chains
   * a deferred `inflight.then(restart)` and marks state `'starting'`.
   * Pre-Round-7, the deferred handler used `state === 'starting'` as
   * its "should I actually restart?" signal — but a fourth call,
   * `stop()(B)` arriving while state is `'starting'`, would fall
   * through and OVERWRITE the state to `'stopping'` (since the
   * `'stopping' && stopInFlight !== null` guard saw `'starting'`),
   * silently destroying the third `start()`'s restart intent without
   * any explicit signal of cancellation.
   *
   * This flag makes the cancellation explicit:
   *
   *   - `start()` during `'stopping'` sets `restartPending = true` and
   *     transitions to `'starting'`, then chains a deferred
   *     `inflight.then(restart)`.
   *   - `stop()` ALWAYS clears `restartPending` at the top — any stop
   *     supersedes any pending start intent.
   *   - The deferred `inflight.then(restart)` checks `restartPending`
   *     instead of state. If the flag has been cleared (by an
   *     intervening `stop()`), the handler bails without restarting.
   *
   * The four-step sequence
   * `start() → stop()(A) → start() → stop()(B)` now ends DETERMINISTI-
   * CALLY in `'idle'`, with the third `start()`'s restart consumed
   * by the fourth `stop()`. A subsequent fifth `start()` proceeds
   * cleanly from `'idle'`.
   *
   * @internal
   */
  private restartPending = false;
  /**
   * Steelman fix (CRIT #10): internal AbortController so `stop()` can
   * IMMEDIATELY abort an in-flight cycle (long aggregator hang, sleep
   * loop) without waiting for the natural completion. Pre-fix, `stop()`
   * just set `stopRequested` and awaited `loopPromise` — a poll waiting
   * on a hung aggregator could keep the caller blocked for the full
   * polling-window duration.
   *
   * The signal is plumbed via {@link combineAbortSignals} into every
   * cycle's `signal` field so aggregator.submit / aggregator.poll /
   * sleep see the abort the moment `stop()` runs.
   *
   * Round 3 regression fix: this field is RE-CREATED at each
   * {@link start} invocation. The pre-Round-3 implementation made the
   * field a `readonly` field-initialized AbortController, which meant
   * a second `start()` after `stop()` reused the already-aborted
   * controller — every cycle's combined signal was pre-aborted, so the
   * very first poll/submit hard-failed with `worker aborted before
   * submit`. Re-creating on `start()` restores correct lifecycle
   * semantics for stop-then-start sequences (e.g., test harnesses,
   * operational restarts after a config tweak).
   *
   * @internal
   */
  private internalController: AbortController = new AbortController();
  /** In-flight `processOneToken` invocations, keyed by tokenId. The
   *  scan loop skips tokens already being driven so an external caller
   *  and the loop don't race the same token. Guards the per-tokenId
   *  mutex from holding two budgets concurrently for the same key. */
  private readonly inFlightTokens: Set<string> = new Set();
  /**
   * Steelman fix (CRIT #11): cascade tombstone set. Pre-fix,
   * `applyHardFailCascade` removed sibling queue entries but parallel
   * `processQueueEntry` cycles for those siblings continued running
   * their poll loops. On poll OK, the sibling's `attachProof` closure
   * tried to step1Pool / step4 a proof for an already `_invalid` token
   * — proof leaked into the pool of an invalid token.
   *
   * The fix: when applyHardFailCascade runs (under the per-tokenId
   * mutex), mark the tokenId in this Map. Each `attachProof` closure
   * checks the tombstone BEFORE writing; if set, it aborts cleanly
   * with a `transfer:cascade-skip-stale` operator-alert.
   *
   * In-memory only: cycle-coordinated within a single worker process.
   * Cross-restart safety is delivered by the disposition writer's
   * INVALID record (the recipient sees the existing INVALID disposition
   * on next-pass build-revaluate-input and skips proof attachment via
   * the existing engine logic).
   *
   * Round 3 regression fix: bounded LRU eviction. Pre-Round-3 the set
   * was unbounded — a long-lived worker accumulated one entry per
   * cascade indefinitely (no GC, no eviction). Memory growth is a slow
   * leak that only matters in worker-pool deployments running for
   * weeks, but the bound here is a hard guarantee: at
   * {@link CASCADE_TOMBSTONE_HARD_CAP} entries, the oldest tombstone
   * is evicted on every new insert. At
   * {@link CASCADE_TOMBSTONE_HIGH_WATERMARK} a `transfer:operator-alert`
   * fires (debounced via {@link cascadeTombstoneHighWatermarkAlerted})
   * so operators can investigate before silent eviction begins.
   *
   * Insertion-order is preserved by JavaScript's `Map`; the LRU
   * eviction therefore deletes the oldest (least-recently-inserted)
   * tombstone — which is also the safest to evict because the
   * disposition writer's INVALID record on disk is the durable
   * cross-restart source of truth (this is a fast-path memo, not a
   * canonical record). Re-touching a tombstone (re-insertion of an
   * already-present tokenId) re-ranks it to most-recently-used.
   *
   * @internal
   */
  private readonly cascadeTombstones: Map<string, true> = new Map();
  /**
   * Round 3 regression fix: emit-once flag for the high-watermark
   * alert. Without it, every insert past the watermark would re-fire
   * the alert (one per cascade), drowning operators in noise. Resets
   * when the set drops back below the watermark on eviction.
   *
   * @internal
   */
  private cascadeTombstoneHighWatermarkAlerted = false;
  /**
   * Round 5 fix (HIGH GAP) — last wall-clock time the steady-state
   * eviction alert fired. Once the cascade-tombstone set is at the
   * hard cap and steady-state eviction kicks in, operators get NO
   * signal that proofs may now leak into evicted-tombstone tokens
   * (the high-watermark alert only fires once on initial crossing).
   *
   * We emit a periodic "steady-state eviction" alert at most once
   * per {@link CASCADE_TOMBSTONE_EVICTION_ALERT_INTERVAL_MS} (default
   * 1 hour) so operators see the eviction signal continuously while
   * the set remains saturated, without flooding the channel.
   *
   * `0` means "never emitted" (so the first eviction fires the alert
   * immediately).
   *
   * @internal
   */
  private cascadeTombstoneLastEvictionAlertAt = 0;
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

  /** Start the long-running scan loop. Idempotent.
   *
   * Round 3 regression fix: re-create {@link internalController} so a
   * `start() → stop() → start()` sequence does NOT inherit the stop's
   * already-aborted signal. See sender-side `start()` doc for the full
   * rationale.
   */
  start(): void {
    // Round 5 fix (HIGH NEW) — lifecycle state machine. Pre-fix, a
    // tight `start() → stop() → start()` sequence could have the
    // second `start()` observe `running === true` (because `stop()`
    // had set `stopRequested = true` but had not yet cleared
    // `running`) and silently no-op, leaving the worker dead.
    if (this.lifecycleState === 'running') {
      return; // already started — preserve idempotent semantics
    }
    if (this.lifecycleState === 'starting') {
      // Round 7 fix (HIGH NEW) — re-assert restart intent in case a
      // prior `stop()` cleared `restartPending`. Idempotent for the
      // common case (the flag was already true).
      this.restartPending = true;
      return;
    }
    if (this.lifecycleState === 'stopping') {
      // Concurrent stop in flight — chain a deferred restart that
      // awaits the in-flight stop, then re-enters start(). This
      // preserves the synchronous `start(): void` signature for
      // existing callers while guaranteeing the worker resumes.
      const inflight = this.stopInFlight;
      if (inflight !== null) {
        // Mark as starting so a second concurrent start() coalesces
        // onto the same continuation (no double-start).
        this.lifecycleState = 'starting';
        // Round 7 fix (HIGH NEW) — restartPending is the explicit
        // signal a stop() must clear to cancel us. Using state alone
        // (as Round 5 did) is racy: a `stop()` arriving while state
        // is `'starting'` would overwrite to `'stopping'` (silently
        // dropping the restart). The flag survives state transitions
        // and is only cleared by a subsequent `stop()`.
        this.restartPending = true;
        void inflight.then(() => {
          // Round 7 fix (HIGH NEW) — check the explicit flag, NOT
          // the state field. If a stop() cleared it, bail with no
          // restart. Otherwise, transition to running.
          if (!this.restartPending) {
            // Stop superseded us. The stop's finally block
            // transitions state to 'idle'; nothing for us to do.
            return;
          }
          // Idempotent guard: another start could have observed
          // 'starting' and re-asserted; we still proceed.
          if (this.lifecycleState !== 'starting') return;
          // Reset to idle then re-enter start() for the actual
          // controller rebuild + scanLoop kickoff.
          this.lifecycleState = 'idle';
          this.restartPending = false;
          this.start();
        });
        return;
      }
      // Fallback: stopping flag set but no promise — clear and fall
      // through to the start path.
      this.lifecycleState = 'idle';
    }
    this.lifecycleState = 'running';
    this.restartPending = false;
    this.running = true;
    this.stopRequested = false;
    // Round 3 regression fix: rebuild the internal controller so
    // signal.aborted starts at false on each start.
    this.internalController = new AbortController();
    this.loopPromise = this.scanLoop();
  }

  /**
   * Request stop and await the in-flight iteration. Idempotent.
   *
   * Steelman fix (CRIT #10): aborts the internal AbortController BEFORE
   * awaiting `loopPromise`. The signal is propagated into every active
   * cycle's `signal` slot so an in-flight `aggregator.poll()` /
   * `aggregator.submit()` / sleep returns immediately (or rejects) and
   * `stop()` returns within ~tens of ms instead of waiting for the
   * natural cycle completion.
   *
   * Round 5 fix (HIGH NEW) — concurrent stop() calls coalesce onto
   * the in-flight stop's promise instead of double-stopping. Note:
   * `stop()` ALWAYS aborts the internalController (even from `'idle'`)
   * because callers may invoke `processOneToken()` directly without
   * `start()` — those in-flight calls observe the abort signal via
   * the same internalController and need stop() to interrupt them.
   */
  async stop(): Promise<void> {
    // Round 7 fix (HIGH NEW) — clear restartPending FIRST, before any
    // state inspection. Any pending deferred-restart (from a prior
    // `start()` during `'stopping'`) is now cancelled — when its
    // `inflight.then(...)` fires it will read `restartPending=false`
    // and bail. The semantics are: stop ALWAYS supersedes a pending
    // restart intent.
    this.restartPending = false;
    if (this.lifecycleState === 'stopping' && this.stopInFlight !== null) {
      // Coalesce onto in-flight stop.
      await this.stopInFlight;
      return;
    }
    // Round 7 fix (HIGH NEW) — `stop()` during `'starting'` (a
    // deferred-restart is pending). We've already cleared
    // `restartPending` above, so the deferred handler will bail
    // when it fires. We still need to await the underlying
    // stopInFlight (if any) so callers observe the same "stop has
    // fully drained" semantics. Pre-Round-7 this branch fell
    // through and overwrote the state to 'stopping' (silently
    // discarding the existing inflight + the restart intent).
    if (this.lifecycleState === 'starting' && this.stopInFlight !== null) {
      // Always abort the internalController too (defense-in-depth —
      // if a deferred restart somehow does fire, the rebuild on
      // start() will replace this controller).
      this.stopRequested = true;
      if (!this.internalController.signal.aborted) {
        this.internalController.abort();
      }
      // Transition to 'stopping' so subsequent stops coalesce, and
      // so the underlying inflight's finally block (which guards on
      // `state === 'stopping'`) lands us in 'idle'.
      this.lifecycleState = 'stopping';
      await this.stopInFlight;
      return;
    }
    // Always abort the internalController — even when state is
    // 'idle' there may be in-flight processOneToken() callers
    // observing this signal.
    this.stopRequested = true;
    if (!this.internalController.signal.aborted) {
      this.internalController.abort();
    }
    if (this.lifecycleState === 'idle') {
      // No scan loop; nothing further to await.
      return;
    }
    this.lifecycleState = 'stopping';
    const inflight = (async (): Promise<void> => {
      try {
        if (this.loopPromise !== null) {
          await this.loopPromise.catch(() => undefined);
          this.loopPromise = null;
        }
        this.running = false;
      } finally {
        // Only transition to idle if we're still in stopping —
        // a deferred-restart from start() may have re-entered and
        // moved us to 'running' or 'starting' already.
        if (this.lifecycleState === 'stopping') {
          this.lifecycleState = 'idle';
        }
        this.stopInFlight = null;
      }
    })();
    this.stopInFlight = inflight;
    await inflight;
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

    // Round 3 regression fix (CRIT #2): resolve the W26 cross-restart
    // anchor via the dedicated `pollStartedAt` field — stamp it once
    // on first poll-loop entry; on subsequent passes the persisted
    // value wins so the deadline survives crash/restart.
    //
    // Pre-Round-3 the anchor was `entry.submittedAt > entry.createdAt
    // ? entry.submittedAt : now()` — but no code path ever updated
    // `submittedAt` post-creation, so the `now()` branch fired on
    // EVERY cycle and the W26 safety net was effectively inert.
    let pollStartedAt: number;
    if (
      typeof entry.pollStartedAt === 'number' &&
      Number.isFinite(entry.pollStartedAt)
    ) {
      pollStartedAt = entry.pollStartedAt;
    } else {
      pollStartedAt = this.options.now();
      // Best-effort: persist the stamp. If the queue write fails
      // (storage outage, race with sibling), the next cycle will
      // re-stamp at its `now()` — the worst case is a slightly
      // delayed deadline, never an infinite poll, because every
      // cycle's anchor is at MOST one cycle of skew behind the
      // canonical first-entry time.
      try {
        await this.options.queueStore.setPollStartedAt(
          this.options.addressId,
          entry.entryId,
          pollStartedAt,
        );
      } catch {
        // Stamp failures are recoverable — operator alert is noisy
        // for an inherently transient condition.
      }
    }

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
      // Round 3 regression fix (CRIT #2): W26 anchor sourced from the
      // queue entry's dedicated `pollStartedAt` field (resolved above).
      // Pre-Round-3 the `submittedAt > createdAt` heuristic was inert
      // because nothing ever updated `submittedAt` post-creation; the
      // `now()` branch fired every cycle and the §5.5 step 6 hard
      // safety net (2 × POLLING_WINDOW_MS) restarted on every worker
      // re-entry. The dedicated field is stamped exactly once on the
      // first poll-loop entry and persisted across worker restarts.
      pollStartedAt,
      emit: this.options.emit,
      now: this.options.now,
      sleep: this.options.sleep,
      // Steelman fix (CRIT #10): combine the caller-supplied signal
      // with the worker's internal AbortController signal so `stop()`
      // immediately propagates into the cycle (aggregator calls + sleep).
      signal: combineAbortSignals(
        this.options.signal,
        this.internalController.signal,
      ),
      isStopped: () => this.stopRequested,
      maxSubmitRetries: this.maxSubmitRetries,
      maxProofErrorRetries: this.maxProofErrorRetries,
      aggregatorId: this.aggregatorId,
      trustBaseStaleness: this.trustBaseStaleness,
      attachProof: async (attachArgs) => {
        // Steelman fix (CRIT #11): tombstone short-circuit. If
        // applyHardFailCascade fired for this tokenId BETWEEN the
        // sibling's poll OK and this attach call, skip the pool write
        // — the token is now `_invalid` and the proof must NOT land in
        // its pool entry. Emit a benign cascade-skip-stale alert so
        // the no-op is observable.
        //
        // Round 3 regression fix (CRIT #4): the tombstone check is
        // performed INSIDE the per-token mutex (see
        // `attachProofUnderMutex` `tombstoneCheck` parameter). Pre-
        // Round-3 the check ran HERE — outside the mutex — leaving a
        // race window: a sibling's applyHardFailCascade could mark
        // the tombstone AFTER this outside check observed `false` but
        // BEFORE this closure acquired the mutex, causing the proof
        // to land in the now-invalidated token's pool entry. Inlining
        // the check inside the mutex closes that window.
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
          // Round 3 regression fix: closure observes the cascade
          // tombstone state at the moment the mutex is held — closes
          // the race window described above.
          tombstoneCheck: () =>
            this.cascadeTombstones.has(entry.tokenId),
          onTombstoneSkip: () => {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              tokenId: entry.tokenId,
              message: `transfer:cascade-skip-stale: aborting proof attach for tokenId=${entry.tokenId} requestId=${entry.commitmentRequestId} — token was hard-failed by sibling cascade; pool write skipped`,
            });
          },
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
      //
      // Steelman fix (warning 6d): wrap the queue-removal inside the
      // per-tokenId mutex critical section. Pre-fix the merge-path
      // queue.remove ran outside the mutex, racing the §5.5 step 5
      // 4-step write's "queue-entry removal LAST" step on a sibling
      // queue entry of the SAME token (multi-K chain-mode). Two
      // concurrent removals targeting different entries of the same
      // tokenId from different code paths could observe interleaved
      // queue states; the mutex serializes them.
      await this.options.perTokenMutex.acquire(
        entry.tokenId,
        async () => {
          await this.options.queueStore.remove(
            this.options.addressId,
            entry.entryId,
          );
        },
        { strategy: this.perTokenMutexStrategy },
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
      // W40 / steelman warning: emit hashed (truncated SHA-256)
      // authenticators in event payloads. Raw authenticator hex is
      // still retained in durable manifest-store entries.
      attachedAuthenticator: hashAuthenticatorForLog(attachedProof.authenticator),
      observedAuthenticator: hashAuthenticatorForLog(ctxResolved.authenticator),
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
            message: sanitizeReasonString(
              `dispositionWriter.write failed during §5.5 step 9 re-evaluation: ${safeErrorMessage(err)}`,
            ),
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

  /**
   * Round 3 regression fix: bounded-LRU insertion into
   * {@link cascadeTombstones}. Pre-Round-3 the set was a plain
   * unbounded `Set` — long-lived workers accumulated entries
   * indefinitely. Now:
   *
   *   1. Re-touching an existing tokenId re-ranks it to MRU
   *      (delete + re-insert preserves Map insertion-order semantics).
   *   2. At {@link CASCADE_TOMBSTONE_HIGH_WATERMARK} a single
   *      operator alert fires (debounced via the
   *      {@link cascadeTombstoneHighWatermarkAlerted} flag).
   *   3. At {@link CASCADE_TOMBSTONE_HARD_CAP} the oldest entry is
   *      evicted (Map's first key is the least-recently-inserted).
   *
   * Cross-restart safety: the disposition writer's INVALID record on
   * disk is the durable source of truth. Evicting a tombstone here
   * is always safe — at worst, a sibling cycle that arrives AFTER
   * eviction observes the on-disk INVALID record and the existing
   * engine logic skips the proof attach via the disposition lookup.
   *
   * @internal
   */
  private insertCascadeTombstone(tokenId: string): void {
    // Re-rank existing entries to MRU.
    if (this.cascadeTombstones.has(tokenId)) {
      this.cascadeTombstones.delete(tokenId);
    }
    this.cascadeTombstones.set(tokenId, true);

    // High-watermark alert (debounced).
    if (
      this.cascadeTombstones.size >= CASCADE_TOMBSTONE_HIGH_WATERMARK &&
      !this.cascadeTombstoneHighWatermarkAlerted
    ) {
      this.cascadeTombstoneHighWatermarkAlerted = true;
      this.options.emit('transfer:operator-alert', {
        code: 'structural',
        message:
          `CASCADE_TOMBSTONE_HIGH_WATERMARK: in-memory cascade-tombstone ` +
          `set crossed the high-watermark (${CASCADE_TOMBSTONE_HIGH_WATERMARK} of ` +
          `${CASCADE_TOMBSTONE_HARD_CAP} hard cap). Sustained accumulation ` +
          `usually indicates a cascade storm (many descendants flipped to ` +
          `_invalid in a short window) — investigate before silent eviction ` +
          `begins at the hard cap.`,
      });
    }

    // Hard-cap eviction — drop the oldest (least-recently-inserted) entries
    // until we're back under the cap. In practice only one eviction per
    // insertion is needed once steady-state is reached.
    let evicted = false;
    while (this.cascadeTombstones.size > CASCADE_TOMBSTONE_HARD_CAP) {
      const oldest = this.cascadeTombstones.keys().next();
      if (oldest.done === true || oldest.value === undefined) break;
      this.cascadeTombstones.delete(oldest.value);
      evicted = true;
    }

    // Round 5 fix (HIGH GAP) — periodic steady-state eviction alert.
    // Without this, once the set is saturated the high-watermark
    // alert (fired once on initial crossing) is the only signal —
    // operators get no continuous indication that proofs may now leak
    // into evicted-tombstone tokens. Rate-limited to one alert per
    // {@link CASCADE_TOMBSTONE_EVICTION_ALERT_INTERVAL_MS} (1 hour).
    if (evicted) {
      const now = Date.now();
      if (
        this.cascadeTombstoneLastEvictionAlertAt === 0 ||
        now - this.cascadeTombstoneLastEvictionAlertAt >=
          CASCADE_TOMBSTONE_EVICTION_ALERT_INTERVAL_MS
      ) {
        this.cascadeTombstoneLastEvictionAlertAt = now;
        this.options.emit('transfer:operator-alert', {
          code: 'structural',
          message:
            `CASCADE_TOMBSTONE_STEADY_STATE_EVICTION: in-memory ` +
            `cascade-tombstone set is at the hard cap ` +
            `(${CASCADE_TOMBSTONE_HARD_CAP}); oldest entries are being ` +
            `evicted on every insert. Cross-restart safety is delivered ` +
            `by the on-disk INVALID disposition records, but in-process ` +
            `sibling cycles arriving AFTER eviction may briefly leak a ` +
            `proof into an evicted-tombstone token before the disposition ` +
            `lookup catches it. Investigate cascade source.`,
        });
      }
    }

    // Reset the high-watermark debounce when the set drops back below
    // the threshold (e.g., a future external pruning hook). Note: with
    // hard-cap eviction at 10000 and the watermark at 8000, the set
    // never spontaneously falls below the watermark — the reset is
    // future-proofing for when an explicit pruner is added.
    if (
      this.cascadeTombstoneHighWatermarkAlerted &&
      this.cascadeTombstones.size < CASCADE_TOMBSTONE_HIGH_WATERMARK
    ) {
      this.cascadeTombstoneHighWatermarkAlerted = false;
    }
  }

  private async applyHardFailCascade(args: {
    readonly tokenId: string;
    readonly reason: DispositionReason;
    readonly message: string;
    readonly skipCascade: boolean;
    readonly observedTokenContentHash: ContentHash;
    readonly bundleCid: string;
  }): Promise<boolean> {
    void args.message;
    // Steelman fix (CRIT #11): mark the cascade tombstone BEFORE any
    // queue removals or disposition writes. This signals to any sibling
    // `processQueueEntry` cycle currently in its poll loop that the
    // tokenId has been moved to `_invalid` — the sibling's attachProof
    // closure will see the tombstone and skip the pool write so the
    // proof is NOT leaked into the invalidated token's pool entry. The
    // tombstone is a durable in-memory hint for the lifetime of this
    // worker; cross-restart safety is delivered by the disposition
    // writer's INVALID record (existing engine logic skips reattach
    // when an INVALID disposition is observed on rebuild).
    //
    // Round 3 regression fix: bounded LRU insertion. See
    // {@link insertCascadeTombstone} for the eviction + high-watermark
    // alert policy.
    this.insertCascadeTombstone(args.tokenId);

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
        message: sanitizeReasonString(
          `dispositionWriter.write failed during §5.5 step 7 self-invalidation: ${safeErrorMessage(err)}`,
        ),
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
        message: sanitizeReasonString(
          `cascadeWalker.cascade threw: ${safeErrorMessage(err)}`,
        ),
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
            const msg = safeErrorMessage(err);
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              tokenId,
              message: sanitizeReasonString(
                `FinalizationWorkerRecipient.scanLoop: processOneToken threw for tokenId=${tokenId}: ${msg}`,
              ),
            });
          }
        }
      } catch (err) {
        // Wave 4 steelman: exponential backoff. First failure emits;
        // subsequent failures emit at power-of-two boundaries only.
        // Reset on next success.
        this.scanReadFailureStreak += 1;
        if (isPowerOfTwoRecipient(this.scanReadFailureStreak)) {
          const msg = safeErrorMessage(err);
          this.options.emit('transfer:operator-alert', {
            code: 'structural',
            message: sanitizeReasonString(
              `FinalizationWorkerRecipient.scanLoop: queueStore.list threw ` +
                `(consecutive failures: ${this.scanReadFailureStreak}): ${msg}`,
            ),
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
   * Round 3 regression fix: combine the user-supplied signal with the
   * internal controller's signal so `stop()` immediately wakes up an
   * idle scan-loop sleep. See sender-side `safeSleep` doc for the
   * full rationale.
   *
   * @internal
   */
  private async safeSleep(ms: number): Promise<void> {
    try {
      await this.options.sleep(
        ms,
        combineAbortSignals(
          this.options.signal,
          this.internalController.signal,
        ),
      );
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
