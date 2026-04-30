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
import type { OutboxWriter } from '../../../profile/outbox-writer';

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
   */
  private async recoverOne(entry: UxfTransferOutboxEntry): Promise<void> {
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
   * `'sending'`, the transition is skipped silently.
   */
  private async transitionToDelivered(
    entry: UxfTransferOutboxEntry,
  ): Promise<void> {
    const targetStatus =
      entry.mode === 'instant' ? 'delivered-instant' : 'delivered';
    try {
      await this.deps.outbox.update(entry.id, (prev) => {
        if (prev.status !== 'sending') return prev;
        return { ...prev, status: targetStatus };
      });
      this.emitRepublished(entry, targetStatus);
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
    try {
      await this.deps.outbox.update(entry.id, (prev) => {
        if (prev.status !== 'sending') return prev;
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
    } catch (err) {
      this.warn('failed-transient transition failed', {
        outboxId: entry.id,
        err: errMessage(err),
      });
    }
  }

  /** Schedule the next scan via recursive setTimeout. */
  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const cycle = this.runScanCycle().catch((err) => {
        this.warn('unexpected scan-cycle throw', { err: errMessage(err) });
      });
      // Adapt to Promise<void> — runScanCycle returns Promise<number>
      // but the in-flight tracker only needs completion semantics.
      this.scanInFlight = cycle.then(() => undefined);
      // Re-arm only after the cycle settles; this is what guarantees
      // no overlapping iterations even if a single scan runs longer
      // than `intervalMs` (rare but possible under outbox contention).
      void cycle.finally(() => {
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
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
