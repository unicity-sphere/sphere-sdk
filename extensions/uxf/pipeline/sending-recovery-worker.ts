/**
 * UXF Inter-Wallet Transfer — sending-recovery worker (Phase 8 steelman post-cutover).
 *
 * Closes the gap flagged by the Phase 7 steelman state-machine reviewer:
 * the conservative-sender's pre-publish-persistence comments (lines 212,
 * 886, 903) PROMISE that a "stuck-in-`'sending'`" recovery worker exists
 * to re-publish entries left dangling by a crash between OrbitDB commit
 * and Nostr publish ack — but no such worker existed. Without it,
 * idempotency at the recipient (replay-LRU per T.3.A / §6.3) is dead
 * weight: nothing in the system ever re-publishes.
 *
 * **What this worker does**:
 *   1. Periodically scans the outbox for entries with
 *      `status === 'sending'` whose `updatedAt` is older than
 *      `stuckThresholdMs`.
 *   2. For each stuck entry, invokes the injected `republish` callback
 *      (the orchestrator owns payload reconstruction — see
 *      §6.3 / T.3.A note on idempotency by content-addressed `bundleCid`).
 *   3. On successful re-publish: transitions the entry to `'delivered'`
 *      (conservative mode) or `'delivered-instant'` (instant mode),
 *      driven by `entry.mode`.
 *   4. On repeated failure: tracks per-entry failure count in-memory.
 *      After `maxRetries` consecutive failures, transitions the entry
 *      to `'failed-transient'`. (`failed-transient → failed-permanent`
 *      is reserved for downstream policy paths — this worker stops at
 *      `failed-transient` so an operator-driven retry can re-arm via
 *      the `failed-transient → sending` arc per §7.0.)
 *
 * **Idempotency contract (T.3.A / §6.3)**: re-publishing the same
 * `bundleCid` is safe — the recipient's replay-LRU short-circuits
 * duplicates. Callers MUST preserve `bundleCid` across the re-publish
 * call (the worker does — it never mutates `bundleCid`).
 *
 * **Default-OFF feature flag**: the worker is gated on
 * `features.recoveryWorker` in `PaymentsModule`. Default `false`. Existing
 * tests are unaffected; integration / soak environments flip the flag to
 * exercise the recovery path.
 *
 * **Holds NO module-level state**: every dependency (outbox, transport-
 * adjacent `republish`, emit, logger, clock) is injected. Multiple
 * workers in the same process are independent.
 *
 * @module modules/payments/transfer/sending-recovery-worker
 *
 * @see modules/payments/transfer/conservative-sender.ts (lines ~212, 886, 903)
 * @see profile/outbox-state-machine.ts                  (§7.0 transitions)
 * @see profile/outbox-writer.ts                         (`update` writer API)
 */

import type {
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import type {
  UxfTransferOutboxEntry,
} from '../../../types/uxf-outbox';
import type { OutboxWriter } from '../profile/outbox-writer';
import { redactCause } from '../../../core/errors';

// =============================================================================
// 1. Public types — dependency surface + options
// =============================================================================

/**
 * Re-publish hook — invoked by the worker for every stuck entry. The
 * orchestrator (PaymentsModule) supplies a closure that knows how to
 * reconstruct the wire payload from the outbox entry's persisted fields
 * (`bundleCid`, `tokenIds`, `recipient*`, `mode`, `memo`).
 *
 * **Idempotency contract (§6.3 / T.3.A)**: the callback MUST preserve
 * the entry's `bundleCid` (and other content-addressed fields) so the
 * recipient's replay-LRU can deduplicate. Implementations typically
 * route through the same `transport.sendTokenTransfer(...)` path as
 * the original send — the recipient short-circuits on duplicate
 * `bundleCid`.
 *
 * Throws on failure; the worker counts a throw as one consecutive
 * failure for the entry.
 */
export type RepublishFn = (
  entry: UxfTransferOutboxEntry,
) => Promise<void>;

/**
 * Logger surface — narrow on purpose so any caller-supplied logger
 * (Sphere's debug logger, a no-op stub, console) plugs in cleanly.
 */
export interface SendingRecoveryWorkerLogger {
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
  readonly info?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Construction-time dependencies for {@link SendingRecoveryWorker}.
 */
export interface SendingRecoveryWorkerDeps {
  /** Outbox writer — `readAllNew()` to scan, `update()` for transitions. */
  readonly outbox: Pick<OutboxWriter, 'readAllNew' | 'update'>;
  /** Re-publish callback — see {@link RepublishFn}. */
  readonly republish: RepublishFn;
  /** Sphere event emitter (same surface used everywhere else). */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /** Logger — used for forensic warn/info on transitions and failures. */
  readonly logger?: SendingRecoveryWorkerLogger;
  /**
   * Wall-clock provider. Default `Date.now`. Tests inject a fixed
   * clock to deterministically classify entries as stuck.
   */
  readonly now?: () => number;
}

/**
 * Tunable knobs. All have defaults; tests override.
 *
 *  - `intervalMs` (default 30_000): how often the scan loop fires. The
 *    worker uses recursive `setTimeout` (NOT `setInterval`) so a
 *    long-running scan can't queue overlapping iterations — we wait
 *    for one cycle to finish before scheduling the next.
 *  - `stuckThresholdMs` (default 60_000): an entry is considered stuck
 *    if `now - updatedAt > stuckThresholdMs`. The default tracks the
 *    Phase 7 steelman acceptance bar ("60 seconds"). Set higher in
 *    soak environments where Nostr publish ack latency may legitimately
 *    push past 60s under network stress.
 *  - `maxRetries` (default 3): consecutive scan-cycle failures before
 *    the worker transitions the entry to `failed-transient`.
 */
export interface SendingRecoveryWorkerOptions {
  readonly intervalMs?: number;
  readonly stuckThresholdMs?: number;
  readonly maxRetries?: number;
}

/** Default scan interval — 30s. Cache-warm-friendly, polls fast enough to
 *  catch a stuck entry within ~2× the stuckThreshold under normal load. */
export const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
/** Default stuck threshold — 60s. Matches the Phase 7 steelman
 *  acceptance bar; entries older than this are assumed not to be making
 *  forward progress under their owning send's natural retry. */
export const DEFAULT_STUCK_THRESHOLD_MS = 60_000;
/** Default max consecutive failures before `failed-transient`. Three
 *  retries gives ~3× the publish-ack window before giving up. */
export const DEFAULT_MAX_RETRIES = 3;

// =============================================================================
// 2. SendingRecoveryWorker
// =============================================================================

/**
 * Periodic recovery worker for crashes that leave outbox entries in
 * `'sending'`. See module doc for full semantics.
 */
export class SendingRecoveryWorker {
  private readonly deps: SendingRecoveryWorkerDeps;
  private readonly intervalMs: number;
  private readonly stuckThresholdMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;

  /** Per-entry consecutive failure counter (reset on success). */
  private readonly failureCounts: Map<string, number> = new Map();

  /** `true` between `start()` and the first `stop()`. */
  private running = false;
  /** Pending timer handle for the next scheduled cycle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight scan promise; awaited by `stop()` so callers see graceful drain. */
  private scanInFlight: Promise<void> | null = null;

  constructor(
    deps: SendingRecoveryWorkerDeps,
    options?: SendingRecoveryWorkerOptions,
  ) {
    this.deps = deps;
    this.intervalMs = options?.intervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
    this.stuckThresholdMs =
      options?.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Start the periodic scan. Idempotent — calling `start()` twice is
   * a no-op after the first call. The first scan fires after one
   * `intervalMs` delay (NOT immediately) so the worker doesn't race
   * with whatever just instantiated it.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the periodic scan and await any in-flight cycle. Idempotent.
   * Safe to call from a non-worker context.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.scanInFlight !== null) {
      // Swallow scan errors during stop — they've already been logged
      // by `runScanCycle`. Stop must never throw on graceful shutdown.
      await this.scanInFlight.catch(() => undefined);
      this.scanInFlight = null;
    }
  }

  /**
   * Diagnostic: is the worker scheduling cycles?
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One scan pass. Public so tests (and the cutover playbook) can
   * trigger a single cycle deterministically without waiting for the
   * timer.
   *
   * @returns Number of entries the cycle attempted to recover.
   */
  async runScanCycle(): Promise<number> {
    let entries: ReadonlyArray<UxfTransferOutboxEntry>;
    try {
      entries = await this.deps.outbox.readAllNew();
    } catch (err) {
      this.warn('readAllNew failed; skipping cycle', { err: errMessage(err) });
      return 0;
    }

    const nowMs = this.now();
    const stuck = entries.filter(
      (e) => e.status === 'sending' && nowMs - e.updatedAt > this.stuckThresholdMs,
    );

    let attempted = 0;
    for (const entry of stuck) {
      attempted += 1;
      await this.recoverOne(entry);
    }
    return attempted;
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Attempt to recover a single stuck entry. Best-effort: any throw is
   * logged and counted toward `maxRetries`; the loop continues.
   *
   * **Wave 3 steelman fix — concurrency race**: a concurrent process
   * (e.g. another sending path, a manual transition, the merger) MAY
   * advance the entry past `'sending'` between the scan-cycle's
   * `readAllNew()` snapshot and this method's invocation. Without a
   * pre-republish status check, the worker would:
   *   1. Re-publish a payload that was already delivered (duplicate
   *      Nostr publish — wasteful but recipient-side LRU saves us);
   *   2. CAS-fail in `transitionToDelivered` (the mutator returns
   *      `prev` unchanged because `prev.status !== 'sending'`);
   *   3. STILL fire `emitRepublished` — falsely claiming a recovery
   *      that never happened.
   *
   * Fix: pre-check status against the live outbox BEFORE calling
   * `republish`. If the entry has advanced, skip silently — there is
   * nothing to recover. The post-republish CAS in
   * `transitionToDelivered` then reports back whether the write
   * actually transitioned, gating the event emission.
   */
  private async recoverOne(entry: UxfTransferOutboxEntry): Promise<void> {
    // FIX 5 (steelman warning): no per-entry `readAllNew()` — the
    // caller's snapshot taken in `runScanCycle` is authoritative for
    // status@scan-time. The race between snapshot and republish is
    // handled by the CAS guard inside `transitionToDelivered`'s
    // `update()` closure (the mutator returns `prev` unchanged if
    // `prev.status !== 'sending'`, and `didTransition` stays false so
    // no false-success emit fires). One wasted Nostr publish in the
    // racing window is harmless — the recipient's replay-LRU
    // short-circuits duplicates by `bundleCid` (§6.3 / T.3.A).
    try {
      await this.deps.republish(entry);
    } catch (err) {
      const count = (this.failureCounts.get(entry.id) ?? 0) + 1;
      this.failureCounts.set(entry.id, count);
      this.warn('republish failed', {
        outboxId: entry.id,
        bundleCid: entry.bundleCid,
        consecutiveFailures: count,
        err: errMessage(err),
      });
      if (count >= this.maxRetries) {
        await this.transitionToFailedTransient(entry, err);
      }
      return;
    }

    // Success path — transition to delivered / delivered-instant.
    this.failureCounts.delete(entry.id);
    await this.transitionToDelivered(entry);
  }

  /**
   * Apply the post-republish `sending → delivered{,-instant}` arc and
   * emit the recovery event. Guards against the entry having already
   * advanced (e.g. a concurrent call): if the entry is no longer in
   * `'sending'`, the transition is skipped silently AND the emit is
   * suppressed — see Wave 3 steelman fix below.
   *
   * **Wave 3 steelman fix — false-success emit**: the previous
   * implementation called `emitRepublished` unconditionally after the
   * `update()` call. If the mutator's CAS detected `prev.status !==
   * 'sending'` and returned `prev` unchanged, the emit still fired —
   * falsely reporting a recovery that did nothing. The emit MUST be
   * gated on the actual write transitioning status. We track the
   * "did-transition" flag in a closure variable inside the mutator so
   * it reflects the value at the moment of the CAS, not whatever the
   * scan snapshot saw.
   */
  private async transitionToDelivered(
    entry: UxfTransferOutboxEntry,
  ): Promise<void> {
    const targetStatus =
      entry.mode === 'instant' ? 'delivered-instant' : 'delivered';
    let didTransition = false;
    try {
      await this.deps.outbox.update(entry.id, (prev) => {
        if (prev.status !== 'sending') {
          // CAS guard — concurrent advance; do not transition, do not
          // emit. The write becomes a no-op self-loop and the writer's
          // status-validator skips the transition table check.
          return prev;
        }
        didTransition = true;
        return { ...prev, status: targetStatus };
      });
      // Emit ONLY if the CAS actually applied the transition. Suppresses
      // the false-success signal previously fired on concurrent races.
      if (didTransition) {
        this.emitRepublished(entry, targetStatus);
      }
    } catch (err) {
      // Transition rejected (state-machine validator) or write error —
      // forensic only. The wire publish already succeeded; the merger /
      // retention path repairs lingering 'sending' entries on next read,
      // mirroring conservative-sender.ts's post-ack best-effort comment.
      this.warn('post-republish transition failed', {
        outboxId: entry.id,
        targetStatus,
        err: errMessage(err),
      });
    }
  }

  /**
   * Apply the `sending → failed-transient` arc when consecutive
   * failures exceed `maxRetries`. The forensic `error` field carries
   * the last failure's message for triage. Failure counter reset on
   * transition so a subsequent operator-driven `failed-transient →
   * sending` retry starts fresh.
   */
  private async transitionToFailedTransient(
    entry: UxfTransferOutboxEntry,
    cause: unknown,
  ): Promise<void> {
    const message = errMessage(cause);
    let didTransition = false;
    try {
      await this.deps.outbox.update(entry.id, (prev) => {
        if (prev.status !== 'sending') return prev;
        didTransition = true;
        return {
          ...prev,
          status: 'failed-transient',
          error: `sending-recovery-worker: ${message}`,
        };
      });
      this.failureCounts.delete(entry.id);
      this.warn('transitioned to failed-transient', {
        outboxId: entry.id,
        bundleCid: entry.bundleCid,
        lastError: message,
      });
      // Issue #401 — emit a terminal-failure signal so subscribers
      // (AccountingModule re-emits `'invoice:deliver-failed' { reason:
      // 'non-durable' }`) can surface the failure to operators. Gate
      // on the CAS to avoid firing on concurrent-advance no-ops, same
      // pattern as `transitionToDelivered`'s `didTransition` guard.
      if (didTransition) {
        this.deps.emit('transfer:recovery-republish-exhausted', {
          outboxId: entry.id,
          bundleCid: entry.bundleCid,
          tokenIds: entry.tokenIds,
          mode: entry.mode,
          recipient: entry.recipient,
          lastError: message,
          exhaustedAt: this.now(),
        });
      }
    } catch (err) {
      this.warn('failed-transient transition failed', {
        outboxId: entry.id,
        err: errMessage(err),
      });
    }
  }

  /**
   * Schedule the next scan via recursive setTimeout.
   *
   * **Wave 3 steelman fix — microtask drain race**: the previous
   * implementation invoked `runScanCycle()` and THEN assigned
   * `this.scanInFlight = cycle.then(...)`. Between those two statements
   * a microtask boundary exists (the promise constructor returns
   * synchronously, but `.then(...)` chains scheduling is microtask-
   * driven). If `stop()` is called inside that microtask window — or
   * if the test harness flushes microtasks between the invocation and
   * the assignment — `stop()` observes `scanInFlight === null` and
   * returns immediately while a cycle is mid-flight. Late writes from
   * the in-flight cycle then arrive AFTER the caller believed the
   * worker had drained.
   *
   * Fix: assign `this.scanInFlight` SYNCHRONOUSLY, in the same
   * statement that creates the promise, BEFORE any microtask boundary
   * exists. We use an IIFE so the assignment captures the same Promise
   * reference that the cycle's `.finally()` continuation observes —
   * `stop()` cannot ever observe `null` while a cycle is running.
   */
  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // SYNCHRONOUS assignment — no microtask boundary between cycle
      // creation and the in-flight tracker being populated. The IIFE
      // captures the cycle's full lifecycle (run + reschedule) into a
      // single Promise<void> reference so `stop()` always observes a
      // non-null `scanInFlight` for the duration of the cycle.
      this.scanInFlight = (async (): Promise<void> => {
        try {
          await this.runScanCycle();
        } catch (err) {
          this.warn('unexpected scan-cycle throw', { err: errMessage(err) });
        }
      })();
      // Re-arm only after the cycle settles; this is what guarantees
      // no overlapping iterations even if a single scan runs longer
      // than `intervalMs` (rare but possible under outbox contention).
      void this.scanInFlight.finally(() => {
        this.scanInFlight = null;
        this.scheduleNext();
      });
    }, this.intervalMs);
  }

  private emitRepublished(
    entry: UxfTransferOutboxEntry,
    targetStatus: 'delivered' | 'delivered-instant',
  ): void {
    this.deps.emit('transfer:recovery-republished', {
      outboxId: entry.id,
      bundleCid: entry.bundleCid,
      tokenIds: entry.tokenIds,
      mode: entry.mode,
      targetStatus,
      recoveredAt: this.now(),
    });
  }

  private warn(message: string, context?: Record<string, unknown>): void {
    this.deps.logger?.warn(`SendingRecoveryWorker: ${message}`, context);
  }
}

// =============================================================================
// 3. Helpers
// =============================================================================

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  // FIX 4 (steelman warning): walk unknown-shape inputs through W40
  // redactCause before JSON.stringify so any sensitive own-properties
  // (e.g., signedTransferTxBytes attached to a non-Error throw) are
  // scrubbed before reaching the log line.
  try {
    return JSON.stringify(redactCause(err));
  } catch {
    return String(err);
  }
}
