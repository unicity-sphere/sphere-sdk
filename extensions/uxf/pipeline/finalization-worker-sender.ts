/**
 * UXF Transfer — sender-side finalization worker (T.5.B).
 *
 * Implements `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §6.1 verbatim. Drives an
 * outbox-resident set of `delivered-instant` entries through the submit /
 * poll loop until every `outstandingRequestId` resolves to either:
 *
 *  - **SUCCESS** — the aggregator anchored our commitment with the
 *    `transactionHash` we tracked locally. The 4-step write order
 *    (§5.5 step 5) attaches the proof, rewrites the manifest CID,
 *    tombstones the previous CID, and removes the queue entry. The
 *    outbox transitions `delivered-instant → finalizing → finalized`.
 *
 *  - **HARD-FAIL** — one of the spec's terminal disposition reasons:
 *    `'race-lost'`, `'client-error'`, `'belief-divergence'`,
 *    `'oracle-rejected'`, `'proof-invalid'`. The outbox transitions
 *    `delivered-instant → finalizing → failed-permanent`. For every
 *    reason EXCEPT `'race-lost'`, the worker emits
 *    `transfer:cascade-failed` so the T.5.B.5 walker can fan the
 *    invalidation out to children / downstream recipients.
 *
 * **Phase 8 refactor**: the §6.1 submit / poll / attach cycle was
 * extracted into {@link runFinalizationCycle} (in
 * `finalization-worker-base.ts`) — the sender and recipient workers
 * share a single driver. This file now owns ONLY the sender-side
 * concerns: outbox iteration, two-set CRDT updates, sender-side cascade
 * emission, `transfer:confirmed` emission.
 *
 * **Concurrency caps** (W14):
 *   - Per-aggregator: at most `MAX_CONCURRENT_POLLS_PER_AGGREGATOR` (16)
 *     in-flight aggregator calls across all entries (default 16). The
 *     budget is enforced by an injected semaphore so callers can share
 *     the budget across multiple workers (sender + recipient).
 *   - Per-tokenId: at most `MAX_CONCURRENT_POLLS_PER_TOKEN` (4) in-flight
 *     polls for the same tokenId — protects against deep chain-mode
 *     bursts hammering a single aggregator endpoint.
 *
 * **Polling-window terminal** (§5.5 step 6): each entry's
 * `pollingDeadline` is derived from `submittedAt + POLLING_WINDOW`. A
 * hard-fail with reason `'oracle-rejected'` fires only when (a) the
 * deadline has been exceeded AND (b) the worker has completed at least
 * `MIN_POLL_ATTEMPTS` polls. Transient errors do NOT advance the
 * attempt counter. Hard safety net (W26): regardless of attempts, the
 * worker terminates the entry after `2 × POLLING_WINDOW` wall-clock
 * time.
 *
 * **§6.3 most-recent-proof / security-alert** (W16, C10):
 *   - If a fresh poll returns a proof for an already-attached requestId
 *     AND the new proof has the SAME `(transactionHash, authenticator)`
 *     — i.e. a legitimately newer-round equivalent — the worker
 *     replaces the proof and emits `transfer:proof-superseded`.
 *   - If the new proof has a DIFFERENT `(transactionHash,
 *     authenticator)`, the §6.3 forbidden case has been triggered.
 *     The worker emits `transfer:security-alert` and refuses to merge.
 *
 * **Cascade delegation** (C3): T.5.B does NOT own the cascade walk.
 * On hard-fail (except `'race-lost'`), it emits `transfer:cascade-failed`
 * so T.5.B.5's cascade walker can fan out to children / downstream
 * outbox entries.
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
import { ManifestCas } from '../profile/manifest-cas';
import type { PerTokenMutex } from '../profile/per-token-mutex';
import type { DispositionReason } from '../types/disposition';
import type {
  SphereEventMap,
  SphereEventType,
  TransferResult,
} from '../../../types';
import type {
  UxfTransferOutboxEntry,
  UxfOutboxStatus,
} from '../types/uxf-outbox';
import { SphereError } from '../../../core/errors';
import { sanitizeReasonString, safeErrorMessage } from '../../../core/error-sanitize';
import type { TrustBaseStaleness } from './trustbase-staleness';
import {
  attachProofUnderMutex,
  combineAbortSignals,
  runFinalizationCycle,
  type AnchoredProofDescriptor,
  type CycleResult,
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

// Re-export the shared adapter types so existing callers (tests and
// wiring code) can keep importing them from this module path. These are
// the SAME types used by {@link FinalizationWorkerRecipient}; production
// wiring instantiates the same fakes.
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

// Re-export the {@link CountingSemaphore} class from the shared base —
// it is the canonical default {@link Semaphore} implementation and is
// consumed by the aggregator-semaphores registry + tests via this module
// path.
export { CountingSemaphore } from './finalization-worker-base';

// =============================================================================
// 1. Outbox writer surface — narrow shape over T.6.A's OutboxWriter
// =============================================================================

/**
 * Outbox writer surface — narrow shape over T.6.A's
 * `OutboxWriter.update`. The worker calls `update` to perform the
 * `delivered-instant → finalizing → finalized | failed-permanent`
 * arcs through the §7.0 state-machine validator.
 */
export interface FinalizationOutboxWriter {
  /**
   * Read the latest entry by id. Returns `null` if absent or
   * tombstoned.
   */
  readOne(id: string): Promise<UxfTransferOutboxEntry | null>;
  /**
   * Apply `mutator` to an existing entry, then persist with a
   * Lamport bump. The §7.0 state-machine validator gates the
   * transition.
   */
  update(
    id: string,
    mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
  ): Promise<UxfTransferOutboxEntry>;
  /**
   * Optional: enumerate all outbox entries for the scan loop (#168).
   * Production wires this to {@link OutboxWriter.readAllNew}; tests
   * that drive `processOne()` directly may omit it (the scan loop
   * then becomes a no-op-sleep stub).
   *
   * **Writer contract (Wave 4 steelman, OOM defense)**: implementations
   * MUST return a BOUNDED list — the worker's scan loop materializes
   * the full result before truncating to `maxEntriesPerScan`, so an
   * unbounded writer (e.g. one that ignores tombstones / forgot to
   * cap a paged scan) would OOM the worker on a degenerate dataset.
   *
   * **Hard upper bound (NORMATIVE)**: Production writers MUST NOT
   * return more than `SCAN_LIST_HARD_GUARD * 2` entries from a single
   * `readAllNew()` call. A writer that materializes 100M entries
   * before returning will OOM the worker at MATERIALIZATION TIME,
   * BEFORE the scan loop's defensive truncation can run. The hard
   * upper bound exists so a healthy writer's worst-case spike
   * (immediately before a tombstone-GC pass) still fits in a single
   * post-truncation slice without crashing.
   *
   * **Stream-mode escape hatch (TODO, future-compat)**: For deployments
   * that genuinely need unbounded outbox enumeration (multi-million-
   * entry historical archives), a future protocol revision will add an
   * `AsyncIterable` overload to this method so the scan loop can pull
   * one page at a time without ever holding the full set in memory.
   * Until then, very large outboxes MUST be paged at the writer layer
   * with a server-side filter (e.g. `status === 'delivered-instant'`)
   * that bounds the result.
   *
   * Production writers SHOULD cap at {@link SCAN_LIST_HARD_GUARD}
   * entries per call. The scan loop has a defensive truncation that
   * trims oversize lists and emits an `transfer:operator-alert`
   * (rate-limited via power-of-two backoff per Wave 5 steelman fix)
   * instead of crashing, but writers should not rely on that defense
   * — it logs as a misconfiguration alert.
   */
  readAllNew?(): Promise<ReadonlyArray<UxfTransferOutboxEntry>>;
}

/**
 * Wave 4 steelman: hard upper bound on the size of a single
 * `readAllNew()` result the scan loop will accept without alerting.
 *
 * Sized at 16384 — comfortably above any realistic outbox in
 * production (a busy wallet rarely exceeds a few hundred concurrent
 * `delivered-instant` entries; the expected steady-state size is
 * bounded by `MAX_CONCURRENT_POLLS_PER_AGGREGATOR` × token count
 * across all in-flight transfers). Anything larger is symptomatic
 * of a broken writer (no tombstone GC) or a deliberate stress test.
 *
 * The scan loop truncates to this cap and emits a structural alert;
 * progress on the first {@link SCAN_LIST_HARD_GUARD} entries continues.
 *
 * @internal
 */
export const SCAN_LIST_HARD_GUARD = 16384;

/**
 * Power-of-two helper for the exponential alert backoff. Returns
 * true for n in {1, 2, 4, 8, 16, 32, 64, 128, …}. Bit trick:
 * a power of two has exactly one bit set, so `n & (n - 1) === 0`
 * (provided n > 0).
 *
 * @internal
 */
function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

// Wave 6 introduced MIN_RECOVERY_ALERT_STREAK (= 4) to suppress noise from
// single-cycle flaps. Wave 7 retired the constant: at streak=2 an
// `isPowerOfTwo(2)` failure alert fired, but the matching recovery
// transition (`2 → 0`) was suppressed by `2 < 4`, leaving the operator's
// page-on-alert / clear-on-recovery script with a dangling page.
//
// The Wave 7 rule is "emit recovery iff a failure alert was emitted in
// THIS streak". Each counter pairs with a `*EmittedAtStreak` watermark
// that records the streak depth at which the most recent failure alert
// fired (0 ⇒ no failure alert this streak). Recovery emits when streak
// transitions non-zero → zero AND the watermark is non-zero. Watermark
// resets together with the counter.

// =============================================================================
// 2. Worker construction options
// =============================================================================

/**
 * Cap parameters injected at construction. All have default values
 * matching `limits.ts` so production wiring rarely overrides them; the
 * test harness DOES override them to exercise edge cases (e.g.
 * MAX_CONCURRENT_POLLS_PER_TOKEN=1 to force serialized poll order).
 */
export interface FinalizationWorkerCaps {
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
 * Construction options for {@link FinalizationWorkerSender}.
 *
 * Every external dependency is injected so unit tests can drive the
 * worker against deterministic fakes without spinning up an aggregator
 * or OrbitDB store.
 */
export interface FinalizationWorkerSenderOptions {
  /** Address id this worker scopes to. */
  readonly addressId: string;
  /** Outbox writer surface — gates §7.0 transitions. */
  readonly outbox: FinalizationOutboxWriter;
  /** Aggregator client — submit + poll. */
  readonly aggregator: FinalizationAggregatorClient;
  /** Per-requestId context resolver. */
  readonly resolver: RequestContextResolver;
  /** Pool write adapter (§5.5 step 5 step 1). */
  readonly pool: PoolWriteAdapter;
  /** Pool read adapter (§6.3 most-recent / security-alert). */
  readonly poolRead: PoolReadAdapter;
  /** Manifest CAS helper (§5.5 step 5 step 2). */
  readonly manifestCas: ManifestCas;
  /** Tombstone adapter (§5.5 step 5 step 3). */
  readonly tombstones: TombstoneWriteAdapter;
  /** Finalization queue adapter (§5.5 step 5 step 4). */
  readonly queue: FinalizationQueueAdapter;
  /**
   * Per-aggregator semaphore (W14, default 16). Optional — when omitted,
   * the worker falls back to the process-global registry in
   * {@link getAggregatorSemaphore} keyed on `aggregatorId`. Tests
   * inject explicit semaphores for deterministic isolation; production
   * MUST omit this field so the cap is enforced process-globally
   * (otherwise a multi-Sphere-instance client trivially bypasses W14
   * — see steelman post-cutover note in
   * `aggregator-semaphores.ts`).
   */
  readonly perAggregatorSemaphore?: Semaphore;
  /**
   * Factory for per-tokenId semaphores. Worker calls
   * `getPerTokenSemaphore(tokenId)` and uses the returned semaphore
   * to bound parallel polling within a single chain. Tests inject
   * fakes; production wires a per-tokenId-keyed map.
   */
  readonly getPerTokenSemaphore: (tokenId: string) => Semaphore;
  /**
   * Per-tokenId mutex from T.1.F. Used for the §5.5 step 9
   * "queue-drain → status transition" lock when the worker is about
   * to flip the outbox entry to `finalized`. Strategy is configurable
   * — defaults to `'cas'` (the preferred path).
   */
  readonly perTokenMutex: PerTokenMutex;
  /** Strategy passed to `perTokenMutex.acquire`. Default `'cas'`. */
  readonly perTokenMutexStrategy?: 'cas' | 'rpc-release' | 'bounded-hold';
  /** Event emitter — same surface used by Sphere. */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /**
   * Wall-clock provider — injected so tests can advance time
   * deterministically (vi.setSystemTime).
   */
  readonly now: () => number;
  /**
   * Sleep primitive — invoked between attempts. Tests inject a
   * deterministic version that resolves immediately.
   */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Audit #333 H5 — recover source tokens on `failed-permanent`.
   *
   * Pre-fix the worker transitioned to `failed-permanent` and never
   * touched the source tokens that the instant-sender had marked
   * `'transferring'` (or `'pending'`) at submit time. With orphan
   * auto-recovery default-OFF, a failed instant send permanently
   * locked the source balance as unspendable.
   *
   * When wired, this hook fires once per `failed-permanent` transition
   * with the entry's `sourceTokenIds`. Production should flip each
   * tokenId's status from `transferring`/`pending` back to a
   * spendable state (typically `confirmed`) — but only when safe
   * (e.g., no other live outbox entry holds the same source).
   *
   * Errors thrown by the hook are caught and logged; they MUST NOT
   * block the `failed-permanent` transition itself, which is the
   * pre-existing terminal-state contract.
   *
   * Reads `sourceTokenIds` from the outbox entry (added to
   * `UxfTransferOutboxEntry` as an optional field for back-compat).
   * Entries written before H5 lacked this field — for those the hook
   * is invoked with an empty array (preserves pre-fix behaviour while
   * still firing the hook for observability).
   */
  readonly recoverFailedPermanentSources?: (
    sourceTokenIds: ReadonlyArray<string>,
    outboxId: string,
  ) => Promise<void>;
  /** Optional override of the §6.1 caps. */
  readonly caps?: FinalizationWorkerCaps;
  /**
   * Scan-loop tick interval (ms). On every iteration the worker:
   *  1. Reads all outbox entries via `outbox.readAllNew()` (skipped
   *     when the writer doesn't expose it).
   *  2. Filters those at `'delivered-instant'` / `'finalizing'`.
   *  3. Calls {@link processOne} for each, isolated by per-entry
   *     try/catch.
   *  4. If at least one entry was processed, immediately re-scans
   *     (no sleep) — drains backlogs without latency.
   *  5. Otherwise, sleeps `scanIntervalMs` before the next pass.
   *
   * Default: 30_000 (30 seconds). Tests typically override down to
   * a small value (e.g. 1ms) to exercise the loop deterministically.
   */
  readonly scanIntervalMs?: number;
  /**
   * Cap on entries processed per scan cycle before yielding for a
   * sleep. Defaults to 100 — protects against CPU pegging when the
   * outbox holds an enormous backlog. After the cap is hit the loop
   * sleeps `scanIntervalMs` before re-entering.
   */
  readonly maxEntriesPerScan?: number;
  /**
   * Opt-out: when `true`, `start()` activates a stub scan loop (sleep-
   * only, identical to the pre-#168 behavior). Useful for tests that
   * probe `isRunning()` without driving real work. Default `false` —
   * production wires the real scan loop.
   */
  readonly manualScan?: boolean;
  /**
   * Optional cancellation signal. The worker honors `signal.aborted`
   * between aggregator calls and aborts in-flight aggregator calls
   * via the same signal.
   */
  readonly signal?: AbortSignal;
  /**
   * Aggregator endpoint identifier — used as the per-aggregator
   * semaphore key. Defaults to `'default'`. Multi-aggregator
   * deployments override.
   */
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
   * If omitted, the worker preserves T.5.B's original behavior:
   * `NOT_AUTHENTICATED` retries up to `maxProofErrorRetries` then
   * hard-fails with `reason: 'proof-invalid'` (no security-alert).
   */
  readonly trustBaseStaleness?: TrustBaseStaleness;
}

// =============================================================================
// 3. Per-entry processing result
// =============================================================================

/**
 * Result of one full `processOne(entry)` pass. Aggregates the
 * per-requestId outcomes — if every requestId resolved success, the
 * worker transitions the entry to `finalized`; if any hard-failed,
 * the worker transitions to `failed-permanent` (using the FIRST
 * hard-fail reason for the outbox payload).
 *
 * The worker does NOT short-circuit on the first hard-fail of a
 * single requestId — it continues processing remaining requestIds in
 * the same entry under the per-aggregator budget. The §5.5 step 7
 * "short-circuit the chain" rule applies at the §5.3-receiver path
 * (T.5.C), NOT at the sender's outbox path (per §6.1's "for each
 * pending requestId" loop, which iterates over a SET, not a chain).
 */
export interface ProcessOneResult {
  readonly outboxId: string;
  readonly tokenIds: ReadonlyArray<string>;
  readonly successCount: number;
  readonly hardFailCount: number;
  readonly firstHardFailReason?: DispositionReason;
  readonly firstHardFailMessage?: string;
  readonly cascadeFailedEmitted: boolean;
  readonly terminal: 'finalized' | 'failed-permanent' | 'in-progress';
}

// =============================================================================
// 4. FinalizationWorkerSender
// =============================================================================

/**
 * Sender-side finalization worker. Use {@link processOne} to drive a
 * single outbox entry through its `outstandingRequestIds`; use
 * {@link start} / {@link stop} to run a long-lived loop that scans
 * all `delivered-instant` entries.
 *
 * The class holds NO module-level state; per-instance state is the
 * scan-loop guard + the injected dependencies. Multiple workers in
 * the same process are independent (callers MUST NOT share a single
 * `FinalizationWorkerSender` between addresses — instantiate per
 * address-scoped store).
 */
export class FinalizationWorkerSender {
  private readonly options: FinalizationWorkerSenderOptions;
  private readonly perAggregatorSemaphore: Semaphore;
  private readonly perAggregator: number;
  private readonly perToken: number;
  private readonly maxSubmitRetries: number;
  private readonly maxProofErrorRetries: number;
  private readonly pollingWindowMs: number;
  private readonly perTokenMutexStrategy: 'cas' | 'rpc-release' | 'bounded-hold';
  private readonly aggregatorId: string;
  private readonly trustBaseStaleness: TrustBaseStaleness | undefined;
  private readonly scanIntervalMs: number;
  private readonly maxEntriesPerScan: number;
  private readonly manualScan: boolean;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  /**
   * Round 5 fix (HIGH NEW) — explicit lifecycle state field. See
   * recipient-side {@link FinalizationWorkerRecipient#lifecycleState}
   * for full rationale. The four reachable states are
   * `'idle' | 'starting' | 'running' | 'stopping'`. Pre-fix a tight
   * `start() → stop() → start()` sequence could silently no-op the
   * second `start()` because `running` was true and `stopRequested`
   * was set but not yet cleared.
   *
   * @internal
   */
  private lifecycleState: 'idle' | 'starting' | 'running' | 'stopping' =
    'idle';
  /**
   * Round 5 fix (HIGH NEW) — promise resolved when the in-flight
   * `stop()` has fully cleared. Lets a concurrent `start()` await
   * the stop and proceed without busy-wait.
   *
   * @internal
   */
  private stopInFlight: Promise<void> | null = null;
  /**
   * Round 7 fix (HIGH NEW) — explicit "deferred restart pending" flag.
   * See recipient-side {@link FinalizationWorkerRecipient#restartPending}
   * for the full rationale. Mirror of the recipient logic — same
   * four-step race
   * (`start() → stop()(A) → start() → stop()(B)`) applies symmetrically
   * to the sender's lifecycle.
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
  /** In-flight `processOne` invocations, keyed by outbox id. The scan
   *  loop skips entries already being driven so an external caller
   *  (e.g. PaymentsModule's synchronous send path at line ~7556) and
   *  the loop don't race the same entry through `processOne`. */
  private readonly inFlight: Set<string> = new Set();
  /**
   * Wave 4 steelman: consecutive `readAllNew()` failure counter for
   * exponential alert backoff. A permanent backend failure would
   * otherwise emit `transfer:operator-alert` every scan iteration —
   * 60+ alerts/min on a 1s scan interval, drowning the operator.
   *
   * Strategy: emit on every power-of-two boundary (1, 2, 4, 8, 16,
   * 32, 64, 128, …) so the alert rate decays geometrically. On the
   * first successful read after failures, emit an info alert with
   * the recovery count and reset the counter.
   */
  private scanReadFailureStreak = 0;
  /**
   * Wave 7: streak depth at which the most recent failure alert fired
   * for the read-failure counter (0 ⇒ no failure alert in the current
   * streak). Used by the recovery transition to decide "emit-if-
   * emitted" — a recovery alert fires only if a failure alert was
   * actually delivered, so paged operators always see resolution.
   */
  private scanReadFailureEmittedAtStreak = 0;
  /**
   * Wave 5 steelman: consecutive over-size truncation counter for
   * exponential alert backoff. A persistently-misconfigured writer
   * (no tombstone GC, runaway slot recovery) would otherwise fire a
   * `transfer:operator-alert` on EVERY scan iteration — same alert
   * flood failure mode as the read-failure streak. Truncation alerts
   * are now emitted only at power-of-two boundaries (1, 2, 4, 8, …);
   * on the first under-cap read we emit a recovery info alert and
   * reset the counter.
   */
  private scanOversizeStreak = 0;
  /**
   * Wave 7: streak depth at which the most recent failure alert fired
   * for the over-size counter (0 ⇒ no failure alert in the current
   * streak). Pairs with `scanOversizeStreak` for the emit-if-emitted
   * recovery rule (see {@link scanReadFailureEmittedAtStreak} doc).
   */
  private scanOversizeEmittedAtStreak = 0;

  /**
   * Validate the polling-policy at construction (§5.5 step 6 step 6
   * "Configuration validity rule (normative) — Implementations MUST
   * validate this at startup and refuse to start if violated.").
   *
   * Throws `INVALID_POLLING_POLICY` if `cumulativeBackoff(MIN_POLL_ATTEMPTS)
   * > POLLING_WINDOW_MS`.
   */
  constructor(options: FinalizationWorkerSenderOptions) {
    const policy = validatePollingPolicy();
    if (!policy.valid) {
      throw new SphereError(
        `FinalizationWorkerSender: polling policy invalid — cumulative backoff for first ${MIN_POLL_ATTEMPTS} polls (${policy.cumulativeBackoffMs}ms) exceeds POLLING_WINDOW_MS (${POLLING_WINDOW_MS}ms). Reason: ${policy.reason ?? 'unknown'}`,
        'INVALID_POLLING_POLICY',
      );
    }

    this.options = options;
    this.aggregatorId = options.aggregatorId ?? 'default';
    // W14 steelman post-cutover: if the caller didn't inject a
    // semaphore, consume from the process-global registry keyed on
    // `aggregatorId`. Per-Sphere-instance semaphores trivially bypass
    // the cap when a client spins up multiple Sphere objects against
    // the same aggregator.
    this.perAggregatorSemaphore =
      options.perAggregatorSemaphore ??
      getAggregatorSemaphore(this.aggregatorId);
    this.perAggregator =
      options.caps?.perAggregator ?? MAX_CONCURRENT_POLLS_PER_AGGREGATOR;
    this.perToken =
      options.caps?.perToken ?? MAX_CONCURRENT_POLLS_PER_TOKEN;
    this.maxSubmitRetries = options.caps?.maxSubmitRetries ?? 5;
    this.maxProofErrorRetries = options.caps?.maxProofErrorRetries ?? 3;
    this.pollingWindowMs =
      options.caps?.pollingWindowMs ?? POLLING_WINDOW_MS;
    // Wave 4 steelman: default to 'rpc-release' for consistency with
    // import-inclusion-proof (Wave 1 #153 flip) and ingest-worker-pool.
    // The 'cas' default required callers to wire a CAS-based ManifestCas
    // for serialization to actually engage; users who omitted that
    // detail silently lost per-token mutual exclusion. 'rpc-release'
    // is the always-correct default — no extra wiring required.
    this.perTokenMutexStrategy =
      options.perTokenMutexStrategy ?? 'rpc-release';
    this.trustBaseStaleness = options.trustBaseStaleness;
    this.scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.maxEntriesPerScan = options.maxEntriesPerScan ?? 100;
    this.manualScan = options.manualScan ?? false;
    if (
      !Number.isFinite(this.scanIntervalMs) ||
      this.scanIntervalMs <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerSender: scanIntervalMs must be > 0; got ${this.scanIntervalMs}`,
        'VALIDATION_ERROR',
      );
    }
    if (
      !Number.isFinite(this.maxEntriesPerScan) ||
      this.maxEntriesPerScan <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerSender: maxEntriesPerScan must be > 0; got ${this.maxEntriesPerScan}`,
        'VALIDATION_ERROR',
      );
    }

    if (
      !Number.isFinite(this.perAggregator) ||
      this.perAggregator <= 0
    ) {
      throw new SphereError(
        `FinalizationWorkerSender: caps.perAggregator must be > 0; got ${this.perAggregator}`,
        'VALIDATION_ERROR',
      );
    }
    if (!Number.isFinite(this.perToken) || this.perToken <= 0) {
      throw new SphereError(
        `FinalizationWorkerSender: caps.perToken must be > 0; got ${this.perToken}`,
        'VALIDATION_ERROR',
      );
    }
  }

  /** Start the long-running scan loop. Idempotent.
   *
   * Round 3 regression fix: re-create {@link internalController} so a
   * `start() → stop() → start()` sequence does NOT inherit the stop's
   * already-aborted signal. The pre-Round-3 implementation made the
   * controller a field-initialized `readonly` member; subsequent
   * starts ran with a pre-aborted signal and every cycle hard-failed
   * with `worker aborted before submit` on the first iteration.
   */
  start(): void {
    // Round 5 fix (HIGH NEW) — lifecycle state machine. Mirror of
    // recipient-worker logic. A tight `start() → stop() → start()`
    // sequence pre-fix could have the second `start()` observe
    // `running === true` (because `stop()` had set `stopRequested`
    // but not yet cleared `running`) and silently no-op.
    if (this.lifecycleState === 'running') {
      return;
    }
    if (this.lifecycleState === 'starting') {
      // Round 7 fix (HIGH NEW) — re-assert restart intent in case a
      // prior `stop()` cleared `restartPending`.
      this.restartPending = true;
      return;
    }
    if (this.lifecycleState === 'stopping') {
      const inflight = this.stopInFlight;
      if (inflight !== null) {
        this.lifecycleState = 'starting';
        // Round 7 fix (HIGH NEW) — explicit restart-pending flag,
        // independent of state, so a subsequent `stop()` can cancel
        // the restart deterministically. See recipient-side worker
        // for full rationale.
        this.restartPending = true;
        void inflight.then(() => {
          if (!this.restartPending) {
            // Stop superseded us. The stop's finally lands the
            // worker in 'idle'.
            return;
          }
          if (this.lifecycleState !== 'starting') return;
          this.lifecycleState = 'idle';
          this.restartPending = false;
          this.start();
        });
        return;
      }
      this.lifecycleState = 'idle';
    }
    this.lifecycleState = 'running';
    this.restartPending = false;
    this.running = true;
    this.stopRequested = false;
    // Round 3 regression fix: rebuild the internal controller so
    // signal.aborted starts at false on each start. Field initializer
    // only fires at construction; subsequent starts must rebuild.
    this.internalController = new AbortController();
    this.loopPromise = this.scanLoop();
  }

  /**
   * Request the worker to stop and await the in-flight loop iteration.
   * Idempotent. Safe to call from a non-worker context.
   *
   * Steelman fix (CRIT #10): aborts the internal AbortController BEFORE
   * awaiting `loopPromise`. The signal is propagated into every active
   * cycle's `signal` slot so an in-flight `aggregator.poll()` /
   * `aggregator.submit()` / sleep returns immediately (or rejects) and
   * `stop()` returns within ~tens of ms instead of waiting for the
   * natural cycle completion (which could be the full polling window
   * for a hung aggregator).
   *
   * Round 5 fix (HIGH NEW) — concurrent stop() calls coalesce onto
   * the in-flight stop's promise instead of double-stopping. Note:
   * `stop()` ALWAYS aborts the internalController (even from `'idle'`)
   * because callers may invoke `processOne()` directly without
   * `start()` — those in-flight calls observe the abort signal via
   * the same internalController and need stop() to interrupt them.
   */
  async stop(): Promise<void> {
    // Round 7 fix (HIGH NEW) — clear restartPending FIRST. Any pending
    // deferred-restart from a prior `start()` during `'stopping'` is
    // now cancelled. Mirror of recipient-side semantics.
    this.restartPending = false;
    if (this.lifecycleState === 'stopping' && this.stopInFlight !== null) {
      await this.stopInFlight;
      return;
    }
    // Round 7 fix (HIGH NEW) — `stop()` during `'starting'`. The
    // previous start() chained a deferred-restart onto a still-
    // running stopInFlight. We've cleared `restartPending`, so the
    // deferred handler will bail when it fires. Coalesce onto the
    // existing inflight (NOT replace it).
    if (this.lifecycleState === 'starting' && this.stopInFlight !== null) {
      this.stopRequested = true;
      if (!this.internalController.signal.aborted) {
        this.internalController.abort();
      }
      this.lifecycleState = 'stopping';
      await this.stopInFlight;
      return;
    }
    // Always abort the internalController — even when state is
    // 'idle' there may be in-flight processOne() callers observing
    // this signal.
    this.stopRequested = true;
    if (!this.internalController.signal.aborted) {
      this.internalController.abort();
    }
    if (this.lifecycleState === 'idle') {
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
        if (this.lifecycleState === 'stopping') {
          this.lifecycleState = 'idle';
        }
        this.stopInFlight = null;
      }
    })();
    this.stopInFlight = inflight;
    await inflight;
  }

  /**
   * Diagnostic: is the worker's scan loop currently running?
   */
  isRunning(): boolean {
    return this.running && !this.stopRequested;
  }

  /**
   * Drive one outbox entry through its `outstandingRequestIds`. Returns
   * the per-entry summary so callers (tests, telemetry) can assert on
   * the terminal disposition.
   *
   * **Mode of operation**:
   *  1. Transition `delivered-instant → finalizing` (idempotent — if
   *     the entry is already at `finalizing`, the writer's self-loop
   *     guard skips the write).
   *  2. For each `outstandingRequestId`, run the §6.1 submit/poll
   *     loop under the per-aggregator + per-token semaphores. The
   *     per-token mutex (T.1.F) is acquired around the §5.5 step 5
   *     write order.
   *  3. Aggregate per-requestId outcomes:
   *     - All `success` → transition to `finalized` + emit
   *       `transfer:confirmed`.
   *     - Any hard-fail → transition to `failed-permanent`. For each
   *       hard-fail except `'race-lost'`, emit
   *       `transfer:cascade-failed` per (tokenId × outboxId).
   */
  async processOne(
    entry: UxfTransferOutboxEntry,
  ): Promise<ProcessOneResult> {
    // De-dup against the scan loop. If another caller (loop OR
    // external) is mid-flight on this id, return a "in-progress"
    // sentinel so we don't double-process. The peer-mutate guard
    // inside the per-id flow (status check + writer self-loop) is
    // resilient to interleaving but spending two semaphore-budgets
    // on the same outbox id wastes headroom.
    if (this.inFlight.has(entry.id)) {
      return {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        successCount: 0,
        hardFailCount: 0,
        cascadeFailedEmitted: false,
        terminal: 'in-progress',
      };
    }
    this.inFlight.add(entry.id);
    try {
      return await this.processOneLocked(entry);
    } finally {
      this.inFlight.delete(entry.id);
    }
  }

  /** Internal worker for {@link processOne}. The wrapper guards against
   *  double-processing via {@link inFlight}; this method assumes the
   *  caller has already taken that slot. */
  private async processOneLocked(
    entry: UxfTransferOutboxEntry,
  ): Promise<ProcessOneResult> {
    // Refresh the entry from the writer to read the canonical lamport.
    const fresh = await this.options.outbox.readOne(entry.id);
    if (fresh === null) {
      // Entry has been tombstoned or removed concurrently. Nothing to do.
      return {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        successCount: 0,
        hardFailCount: 0,
        cascadeFailedEmitted: false,
        terminal: 'in-progress',
      };
    }
    if (fresh.status !== 'delivered-instant' && fresh.status !== 'finalizing') {
      // Already moved past our concern. Idempotent: do nothing.
      const term: ProcessOneResult['terminal'] =
        fresh.status === 'finalized'
          ? 'finalized'
          : fresh.status === 'failed-permanent'
            ? 'failed-permanent'
            : 'in-progress';
      return {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        successCount: 0,
        hardFailCount: 0,
        cascadeFailedEmitted: false,
        terminal: term,
      };
    }

    // Step 1: arc into 'finalizing' (idempotent).
    let working = fresh;
    if (working.status === 'delivered-instant') {
      working = await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        status: 'finalizing' as UxfOutboxStatus,
        updatedAt: this.options.now(),
      }));
    }

    // W26 cross-restart persistence (steelman post-cutover fix). The
    // poll-loop deadline anchor MUST survive crash/restart — otherwise
    // the worker re-enters with `startedAt = now()` on every restart,
    // resetting the 60-min hard safety net. A token stuck PENDING
    // across many restarts would poll indefinitely, voiding §5.5
    // step 6's W26 termination guarantee.
    //
    // Stamp `pollStartedAt` ONCE on first poll-loop entry. Subsequent
    // passes (including post-restart) read the persisted value and
    // pass it to {@link isPollingTimedOut} as the deadline anchor.
    // Mutator runs under the outbox writer's self-loop guard
    // (status unchanged → state-machine validator skipped), so the
    // write is safe at any `finalizing` lamport.
    if (working.pollStartedAt === undefined) {
      working = await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        pollStartedAt: prev.pollStartedAt ?? this.options.now(),
        updatedAt: this.options.now(),
      }));
    }
    // Type-narrow for the per-requestId loop. `pollStartedAt` is
    // guaranteed by the stamp above.
    const persistedPollStartedAt =
      working.pollStartedAt ?? this.options.now();

    // Step 2: process each outstanding requestId. The §6.1 spec
    // permits per-token parallelism bounded by
    // `MAX_CONCURRENT_POLLS_PER_TOKEN`; the per-aggregator semaphore
    // enforces a separate cap. We launch all unfinished requestIds in
    // parallel and let the injected semaphores throttle them
    // — sequential vs parallel emerges from the cap configuration.
    const outstanding = working.outstandingRequestIds ?? [];
    const completed = new Set(working.completedRequestIds ?? []);

    // Determine the per-token cap by tokenId. For the sender outbox, a
    // single entry's outstanding set typically maps to the SAME tokenId
    // (the source) plus any inherited chain-mode predecessors that
    // refer to the same chain — we use the FIRST tokenId from the
    // entry's `tokenIds` as the per-token cap key. Multi-tokenId
    // entries (multi-asset bundles) would technically warrant per-
    // requestId tokenId mapping, but the worker only needs the cap as
    // a DoS-defense, not a correctness primitive — using the first id
    // is a conservative under-approximation.
    //
    // FIXME (Wave 3 #7 — deferred): for multi-asset bundles the
    // per-token semaphore is keyed only on `tokenIds[0]`, so tokens
    // 2..N bypass the cap entirely. The fix is to acquire a separate
    // permit for EVERY tokenId in `entry.tokenIds`, releasing all
    // when done — taken in deterministic (lex-sorted) order to
    // prevent deadlock between two concurrent multi-asset entries
    // that share at least two tokens. Deferred to keep this Wave 3
    // change set narrowly scoped to base + queue per the parallel-
    // agent claim boundary (sender owned by another stream).
    const primaryTokenId = working.tokenIds[0] ?? working.id;

    const pending = outstanding.filter((r) => !completed.has(r));
    // Steelman fix: Promise.allSettled (was Promise.all). With Promise.all,
    // a single processRequestId throw aborts the parent fold while the
    // other in-flight promises continue running orphaned — they hold
    // semaphores, mutate state, but their results are discarded. allSettled
    // lets every requestId's processing reach a structured outcome we can
    // inspect (success vs hard-fail vs unhandled throw), so the worker can
    // release semaphores and emit the right per-id event for each.
    const settledRaw = await Promise.allSettled(
      pending.map((requestId) =>
        this.processRequestId({
          outboxId: working.id,
          bundleCid: working.bundleCid,
          recipientTransportPubkey: working.recipientTransportPubkey,
          tokenId: primaryTokenId,
          requestId,
          pollStartedAt: persistedPollStartedAt,
        }).then((outcome) => ({ requestId, outcome })),
      ),
    );
    const settled = settledRaw.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // An unhandled throw in processRequestId — should be impossible
      // (every code path returns a typed outcome) but defensively map
      // to a hard-fail so the worker doesn't drop the requestId.
      // Steelman recursion fix: 'oracle-rejected' is the closest existing
      // DispositionReason match — the actual aggregator may have already
      // rejected upstream and this throw is the symptom, OR this is an
      // internal worker bug (e.g. resolver throw). Capture the FULL
      // stack via err.stack so postmortem analysis can distinguish the
      // two cases. Operators MUST grep `transfer:cascade-failed` /
      // worker logs for "WORKER-INTERNAL:" to spot mis-attributed
      // internal bugs vs genuine oracle rejections.
      const requestId = pending[i]!;
      const errMsg =
        r.reason instanceof Error
          ? `WORKER-INTERNAL: ${r.reason.stack ?? r.reason.message}`
          : `WORKER-INTERNAL: ${String(r.reason)}`;
      const outcome: HardFailOutcome = {
        kind: 'hard-fail',
        reason: 'oracle-rejected',
        skipCascade: false,
        message: errMsg,
      };
      return { requestId, outcome };
    });

    const successes: string[] = [];
    const failures: Array<{ requestId: string; outcome: HardFailOutcome }> = [];
    for (const { requestId, outcome } of settled) {
      if (outcome.kind === 'success') {
        successes.push(requestId);
      } else {
        failures.push({ requestId, outcome });
      }
    }

    // Step 3: terminal transition.
    const totalSuccess = successes.length;
    const totalFailure = failures.length;
    let terminal: ProcessOneResult['terminal'] = 'in-progress';
    let cascadeFailedEmitted = false;

    if (totalFailure > 0) {
      // ANY hard-fail → outbox transitions to failed-permanent.
      const first = failures[0]!.outcome;
      await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        status: 'failed-permanent' as UxfOutboxStatus,
        error: first.message,
        updatedAt: this.options.now(),
      }));
      terminal = 'failed-permanent';
      cascadeFailedEmitted = this.maybeEmitCascadeFailed(working, failures);

      // Audit #333 H5 — unlock source tokens on failed-permanent.
      //
      // Pre-fix the worker left the source tokens that the instant-
      // sender had marked `transferring`/`pending` in their locked
      // state. With orphan auto-recovery default-OFF, the spender-side
      // balance was permanently stuck. The hook fires once with the
      // entry's recorded `sourceTokenIds`; production wiring flips
      // each source back to a spendable state (typically `confirmed`)
      // gated on a same-source-no-other-live-outbox check.
      //
      // Wrap in try/catch — the failed-permanent transition above has
      // ALREADY committed; a hook failure must not block the terminal
      // state or it would re-introduce the locked-pending bug it
      // exists to fix. Errors log via the event surface for triage.
      if (this.options.recoverFailedPermanentSources !== undefined) {
        const sources = working.sourceTokenIds ?? [];
        try {
          await this.options.recoverFailedPermanentSources(sources, working.id);
        } catch (err) {
          // Best-effort observability — emit via the standard event
          // surface so operators see the unlock failure even though
          // the failed-permanent transition succeeded.
          this.options.emit('transfer:failed', {
            id: working.id,
            status: 'failed',
            tokens: [],
            tokenTransfers: [],
            error:
              'failed-permanent transition succeeded, but source-unlock ' +
              'recovery threw: ' +
              (err instanceof Error ? err.message : String(err)),
          });
        }
      }
    } else if (
      totalSuccess === outstanding.filter((r) => !completed.has(r)).length &&
      totalSuccess > 0
    ) {
      // All outstanding (excluding pre-completed) resolved → finalized.
      await this.options.outbox.update(working.id, (prev) => ({
        ...prev,
        status: 'finalized' as UxfOutboxStatus,
        completedRequestIds: [
          ...(prev.completedRequestIds ?? []),
          ...successes,
        ],
        outstandingRequestIds: [],
        updatedAt: this.options.now(),
      }));
      terminal = 'finalized';
      this.emitTransferConfirmed(working);
    } else if (totalSuccess > 0) {
      // Partial progress — record completed but stay in finalizing.
      // (No status transition; just persist the new completedRequestIds
      //  via a non-status mutation.)
      await this.options.outbox.update(working.id, (prev) => {
        const newCompleted = [
          ...(prev.completedRequestIds ?? []),
          ...successes,
        ];
        const newOutstanding = (prev.outstandingRequestIds ?? []).filter(
          (r) => !successes.includes(r),
        );
        return {
          ...prev,
          completedRequestIds: newCompleted,
          outstandingRequestIds: newOutstanding,
          updatedAt: this.options.now(),
        };
      });
    }

    return {
      outboxId: working.id,
      tokenIds: working.tokenIds,
      successCount: totalSuccess,
      hardFailCount: totalFailure,
      firstHardFailReason: failures[0]?.outcome.reason,
      firstHardFailMessage: failures[0]?.outcome.message,
      cascadeFailedEmitted,
      terminal,
    };
  }

  // ===========================================================================
  // 4.1. Per-requestId processing — delegates to runFinalizationCycle
  // ===========================================================================

  /**
   * Drive one requestId through the §6.1 cycle by composing a
   * {@link FinalizationCycleContext} that targets the sender-side
   * persistence (manifest-CID-rewrite + outbox queue-entry removal).
   *
   * @internal
   */
  private async processRequestId(args: {
    readonly outboxId: string;
    readonly bundleCid: string;
    readonly recipientTransportPubkey: string;
    readonly tokenId: string;
    readonly requestId: string;
    /**
     * Persisted poll-loop deadline anchor (W26 cross-restart fix).
     * Caller stamps this on the entry's first poll iteration via
     * `outbox.update()`; subsequent calls (including post-restart)
     * pass the persisted value so the W26 hard safety net is a
     * SURVIVING wall-clock deadline, not a fresh-from-now() one.
     */
    readonly pollStartedAt: number;
  }): Promise<CycleResult> {
    void args.recipientTransportPubkey; // forensic only; not consumed by cycle
    const { outboxId, tokenId, requestId, bundleCid } = args;
    const perTokenSemaphore = this.options.getPerTokenSemaphore(tokenId);

    return await runFinalizationCycle({
      addressId: this.options.addressId,
      tokenId,
      requestId,
      outboxId,
      bundleCid,
      // Sender uses `requestId X` / `requestId=X` formatting.
      subjectPhrase: `requestId ${requestId}`,
      subjectEqPhrase: `requestId=${requestId}`,
      structuralInvalidMessage: `STRUCTURAL_INVALID: no signedTx for requestId ${requestId} (outbox=${outboxId})`,
      resolver: this.options.resolver,
      aggregator: this.options.aggregator,
      poolRead: this.options.poolRead,
      perAggregatorSemaphore: this.perAggregatorSemaphore,
      perTokenSemaphore,
      pollStartedAt: args.pollStartedAt,
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
        await attachProofUnderMutex({
          addressId: this.options.addressId,
          tokenId,
          requestId,
          proof: attachArgs.proof,
          newCid: attachArgs.newCid,
          previousCid: attachArgs.previousCid,
          nextEntryRest: attachArgs.nextEntryRest,
          // Sender: queueEntryRequestId IS the requestId. The 4-step
          // write's queue removal targets the requestId-keyed entry.
          queueEntryRequestId: requestId,
          pool: this.options.pool,
          manifestCas: this.options.manifestCas,
          tombstones: this.options.tombstones,
          queue: this.options.queue,
          perTokenMutex: this.options.perTokenMutex,
          perTokenMutexStrategy: this.perTokenMutexStrategy,
          now: this.options.now,
        });
      },
    });
  }

  // ===========================================================================
  // 4.2. Hard-fail handling — cascade-failed event + transfer:confirmed
  // ===========================================================================

  /**
   * Emit `transfer:cascade-failed` for each tokenId in the entry,
   * skipping the `'race-lost'` reason per §6.1.1. Returns true iff at
   * least one event was emitted.
   *
   * @internal
   */
  private maybeEmitCascadeFailed(
    entry: UxfTransferOutboxEntry,
    failures: ReadonlyArray<{
      readonly requestId: string;
      readonly outcome: HardFailOutcome;
    }>,
  ): boolean {
    let emitted = false;
    for (const f of failures) {
      if (f.outcome.skipCascade) continue;
      // One event per (tokenId, outcome) pair — multi-token entries
      // get one per tokenId.
      for (const tokenId of entry.tokenIds) {
        this.options.emit('transfer:cascade-failed', {
          outboxId: entry.id,
          tokenId,
          bundleCid: entry.bundleCid,
          recipientTransportPubkey: entry.recipientTransportPubkey,
          reason: f.outcome.reason,
        });
        emitted = true;
      }
    }
    return emitted;
  }

  /**
   * Emit `transfer:confirmed` on `delivered-instant → finalized`
   * transition. Builds a minimal {@link TransferResult} payload from
   * the outbox entry — the wire shape is unchanged from T.5.A's
   * `'transfer:submitted'`.
   *
   * @internal
   */
  private emitTransferConfirmed(entry: UxfTransferOutboxEntry): void {
    void entry;
    const result: TransferResult = {
      id: entry.id,
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    };
    this.options.emit('transfer:confirmed', result);
  }

  // ===========================================================================
  // 4.3. Scan loop
  // ===========================================================================

  /**
   * Long-running scan loop (#168 production scheduler). Each iteration:
   *  1. Reads all outbox entries via the writer's `readAllNew()`. If
   *     the writer doesn't expose it (narrow test surface), the loop
   *     degrades to a sleep-only stub so `start()`/`stop()` lifecycle
   *     tests still pass.
   *  2. Filters entries with `status === 'delivered-instant'` (or
   *     `'finalizing'` from a previously interrupted iteration) AND
   *     not currently in {@link inFlight}.
   *  3. For each entry up to `maxEntriesPerScan`, calls
   *     {@link processOne} with per-entry try/catch — one bad entry
   *     can't poison the whole worker.
   *  4. If at least one entry was processed, immediately re-scans
   *     (no sleep) — drains backlogs without latency.
   *  5. Otherwise sleeps `scanIntervalMs` before the next pass.
   *
   * **Wave 4 steelman fixes**:
   *
   *  - **OOM defense / writer contract** — `readAllNew()` is contractually
   *    obligated to return a BOUNDED enumeration (see
   *    {@link FinalizationOutboxWriter.readAllNew} JSDoc). The default
   *    profile-backed writer caps at ~1024 entries per OrbitDB partition;
   *    a misconfigured writer returning an unbounded list would OOM the
   *    worker before reaching the truncation check at step 2. We add a
   *    defensive `entries.length > SCAN_LIST_HARD_GUARD` check that
   *    truncates and emits a forensic alert — the worker keeps running
   *    on the first {@link maxEntriesPerScan} entries so progress is
   *    not entirely blocked, but the operator gets a loud signal.
   *
   *  - **Alert flood backoff** — a permanent `readAllNew()` failure (e.g.
   *    a corrupted underlying OrbitDB store) would otherwise emit
   *    `transfer:operator-alert` every iteration. We now track a
   *    consecutive-failure counter and emit alerts only at power-of-two
   *    boundaries (1, 2, 4, 8, 16, 32, …) so the rate decays
   *    geometrically. On recovery we emit one final info alert with
   *    the recovery count and reset the counter.
   *
   * Loop terminates when {@link stop} is called or the construction-
   * supplied `signal` aborts.
   *
   * @internal
   */
  private async scanLoop(): Promise<void> {
    while (!this.stopRequested && this.options.signal?.aborted !== true) {
      // Manual-scan opt-out OR writer doesn't expose readAllNew →
      // fall back to the pre-#168 sleep-only stub so
      // `start()`/`stop()`/`isRunning()` lifecycle tests keep working.
      const readAllNew = this.options.outbox.readAllNew;
      if (this.manualScan || typeof readAllNew !== 'function') {
        await this.safeSleep(this.scanIntervalMs);
        continue;
      }

      let processed = 0;
      try {
        const all = await readAllNew.call(this.options.outbox);
        // Wave 4 steelman: defensive size guard. The writer contract
        // (see FinalizationOutboxWriter.readAllNew JSDoc) requires a
        // bounded list; if a misconfigured writer returns more than
        // SCAN_LIST_HARD_GUARD entries, alert + truncate so the worker
        // can keep making progress without OOM.
        //
        // Wave 5 steelman fix #2: alert flood backoff. A permanent
        // overrun (broken tombstone GC) was firing the alert on EVERY
        // cycle — drowning the operator under the same failure mode
        // we already fixed for the read-throws path. Track a
        // consecutive-overrun counter and emit only at power-of-two
        // boundaries; emit a single recovery alert on first
        // under-cap read.
        let workingList: ReadonlyArray<UxfTransferOutboxEntry> = all;
        if (all.length > SCAN_LIST_HARD_GUARD) {
          this.scanOversizeStreak += 1;
          if (isPowerOfTwo(this.scanOversizeStreak)) {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message:
                `FinalizationWorkerSender.scanLoop: readAllNew returned ${all.length} ` +
                `entries (writer contract: <= ${SCAN_LIST_HARD_GUARD}); truncating to ` +
                `first ${SCAN_LIST_HARD_GUARD} to avoid OOM (consecutive overruns: ` +
                `${this.scanOversizeStreak}). Inspect the outbox writer for unbounded ` +
                `growth (missing tombstone GC?).`,
            });
            // Wave 7 emit-if-emitted: record that a failure alert
            // fired at this streak depth so the recovery transition
            // can decide whether to emit resolution.
            this.scanOversizeEmittedAtStreak = this.scanOversizeStreak;
          }
          workingList = all.slice(0, SCAN_LIST_HARD_GUARD);
        } else if (this.scanOversizeStreak > 0) {
          // Recovery: writer is now within budget.
          //
          // Wave 7 steelman fix: emit-if-emitted. Wave 6's
          // `MIN_RECOVERY_ALERT_STREAK = 4` left a gap at streak=2-3
          // where `isPowerOfTwo(2)` fired a failure alert but the
          // recovery transition was suppressed (`2 < 4`), leaving
          // pager scripts with a dangling page. The new rule emits
          // recovery iff a failure alert was actually emitted in
          // THIS streak (`scanOversizeEmittedAtStreak > 0`).
          // Sub-alert blips (streak < 1 boundary impossible; streak=1
          // always alerts so any non-zero streak transition emitted
          // at least one alert) — wait, streak=1 ALWAYS alerts due
          // to `isPowerOfTwo(1)`, so single-cycle flaps DO get a
          // recovery now. That's correct behaviour: if we paged on
          // streak=1, we must clear on recovery.
          if (this.scanOversizeEmittedAtStreak > 0) {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message:
                `FinalizationWorkerSender.scanLoop: readAllNew under SCAN_LIST_HARD_GUARD ` +
                `again after ${this.scanOversizeStreak} consecutive over-size cycle(s).`,
            });
          }
          this.scanOversizeStreak = 0;
          this.scanOversizeEmittedAtStreak = 0;
        }

        // Successful read — emit recovery info if we were in a streak.
        // Wave 7 steelman fix: emit-if-emitted gating (see oversize
        // path above). Recovery emits iff a failure alert fired in
        // this streak.
        if (this.scanReadFailureStreak > 0) {
          if (this.scanReadFailureEmittedAtStreak > 0) {
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message:
                `FinalizationWorkerSender.scanLoop: readAllNew recovered after ` +
                `${this.scanReadFailureStreak} consecutive failure(s).`,
            });
          }
          this.scanReadFailureStreak = 0;
          this.scanReadFailureEmittedAtStreak = 0;
        }

        // Filter to entries the worker should drive. `delivered-instant`
        // is the default arrival state for instant-mode sends;
        // `finalizing` is the in-progress state we recover after a
        // crash mid-`processOne`.
        const candidates: UxfTransferOutboxEntry[] = [];
        for (const e of workingList) {
          if (e.status !== 'delivered-instant' && e.status !== 'finalizing') {
            continue;
          }
          if (this.inFlight.has(e.id)) continue;
          candidates.push(e);
          if (candidates.length >= this.maxEntriesPerScan) break;
        }

        for (const entry of candidates) {
          if (this.stopRequested) break;
          if (this.options.signal?.aborted) break;
          try {
            await this.processOne(entry);
            processed += 1;
          } catch (err) {
            // processOne's surface is total-by-design (Promise.allSettled
            // inside). A throw here is genuinely unexpected; emit a
            // forensic alert and continue with the next entry — the
            // loop is the safety net for crashes, not a perpetuator.
            const msg = safeErrorMessage(err);
            this.options.emit('transfer:operator-alert', {
              code: 'structural',
              message: sanitizeReasonString(
                `FinalizationWorkerSender.scanLoop: processOne threw for outbox=${entry.id}: ${msg}`,
              ),
            });
          }
        }
      } catch (err) {
        // Wave 4 steelman: exponential backoff on consecutive failures.
        // The first failure always emits; subsequent failures emit only
        // at power-of-two boundaries. Reset on next success.
        this.scanReadFailureStreak += 1;
        if (isPowerOfTwo(this.scanReadFailureStreak)) {
          const msg = safeErrorMessage(err);
          this.options.emit('transfer:operator-alert', {
            code: 'structural',
            message: sanitizeReasonString(
              `FinalizationWorkerSender.scanLoop: readAllNew threw ` +
                `(consecutive failures: ${this.scanReadFailureStreak}): ${msg}`,
            ),
          });
          // Wave 7 emit-if-emitted watermark.
          this.scanReadFailureEmittedAtStreak = this.scanReadFailureStreak;
        }
      }

      if (processed === 0) {
        // No work this cycle → sleep the full interval. Backlog drains
        // (processed > 0) re-enter immediately.
        await this.safeSleep(this.scanIntervalMs);
      } else {
        // Cooperative yield so other tasks get a turn even when the
        // backlog never empties. Keeps the loop fair without adding
        // throughput latency.
        await this.safeSleep(0);
      }
    }
  }

  /**
   * Wrap `options.sleep` so abort exceptions don't escape the loop.
   * The worker's signal contract is "abort terminates pending sleep
   * via reject"; the loop's outer `while` checks `signal.aborted` to
   * exit cleanly.
   *
   * Round 3 regression fix: combine the user-supplied signal with the
   * internal controller's signal so `stop()` immediately wakes up an
   * idle scan-loop sleep. Pre-fix, an idle worker that called
   * `stop()` waited the full `scanIntervalMs` (default 30s) before the
   * loop iteration completed because only the user-supplied signal
   * was passed in. The internal controller is the abort surface that
   * `stop()` triggers, so it MUST also be observed by the scan-loop
   * sleep for prompt shutdown.
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
      // Sleep aborted via signal — fall through; loop condition
      // re-evaluates and exits.
    }
  }
}
