/**
 * SENT-write reconciliation worker (Issue #166 P2 #4).
 *
 * Closes the gap left by the round-2 steelman fix in PR #97
 * (`fcf1d53`). That fix made `writeSentEntryFromOutbox` return
 * `'failed'` when the SENT-ledger write threw, instructing the
 * conservative / instant dispatchers to LEAVE the OUTBOX entry live at
 * `status='delivered'` / `'delivered-instant'` instead of tombstoning
 * it. Rationale: the delivery is already on the wire (Nostr publish
 * acked); tombstoning would silently discard the only forensic record.
 *
 * Round-2 stopped at "operator triage required." There was no automatic
 * retry, so an intermittent SENT-write failure (OrbitDB hiccup, profile
 * sync stutter, encryption-key swap mid-write) left wallets with an
 * indefinite backlog of "delivered, but unreconciled" OUTBOX entries
 * that an operator had to clear manually.
 *
 * **What this worker does:**
 *   1. Periodically scans OUTBOX for entries with status `'delivered'`
 *      or `'delivered-instant'`.
 *   2. For each, checks the SENT ledger by id (OUTBOX id ≡ SENT id, set
 *      by {@link writeSentEntryFromOutbox}). Direct `readOne(id)` is
 *      O(1) per entry — strictly cheaper than the O(n×m)
 *      `contains(tokenId)` path.
 *   3. If SENT entry exists → entry is fully reconciled; tombstone the
 *      OUTBOX entry (the dispatcher would have done this on the
 *      delivered → tombstone arc if SENT had succeeded the first time).
 *   4. If SENT entry is missing → retry the SENT write via the injected
 *      closure (pre-bound to `PaymentsModule.writeSentEntryFromOutbox`
 *      so it follows the same shape as the original attempt). On
 *      success, tombstone the OUTBOX entry and emit
 *      `transfer:sent-reconciliation-recovered`. On failure, increment
 *      a per-entry consecutive-failure counter; after `maxRetries`
 *      consecutive failures, emit `transfer:sent-reconciliation-failed`
 *      and STOP retrying this entry until the worker is restarted.
 *      (Counter is in-memory only — a process restart re-arms.)
 *
 * **What this worker deliberately does NOT do:**
 *   - Does NOT touch entries in any other status (`'sending'`,
 *     `'failed-transient'`, `'finalizing'`, etc.). Those are owned by
 *     other workers (SendingRecoveryWorker, FinalizationWorkerSender).
 *   - Does NOT delete the OUTBOX entry on retry failure. The whole
 *     point of the round-2 fix is to keep that entry as the forensic
 *     record. Failure transitions only the worker's in-memory counter.
 *   - Does NOT re-publish the Nostr event. The delivery already
 *     happened (that's why the entry is `'delivered'`); only the local
 *     SENT-write got lost.
 *
 * **Idempotency:** repeated invocations on the same state produce
 * identical decisions. The SENT write is itself idempotent
 * ({@link SentLedgerWriter.write} overwrites by id), and the OUTBOX
 * tombstone is idempotent (writing a tombstone over a tombstone is a
 * no-op apart from refreshing `deletedAt`).
 *
 * **Concurrency:** safe to invoke concurrently with sends. Unlike
 * SendingRecoveryWorker (which acts on `'sending'` entries where a
 * dispatcher race could overlap), this worker only touches terminal
 * `'delivered'` / `'delivered-instant'` entries. The dispatcher would
 * have already tombstoned them if the SENT write had succeeded; if the
 * worker tombstones first and the dispatcher's retry-with-success path
 * lands afterwards, the dispatcher's tombstone overwrites the worker's
 * tombstone (same shape, idempotent).
 *
 * @module modules/payments/transfer/sent-reconciliation-worker
 *
 * @see modules/payments/PaymentsModule.ts:writeSentEntryFromOutbox
 * @see modules/payments/transfer/sending-recovery-worker.ts (structural twin)
 */

import type { SphereEventMap, SphereEventType } from '../../../types';
import type { UxfTransferOutboxEntry } from '../../../types/uxf-outbox';
import type { OutboxWriter } from '../../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../../profile/sent-ledger-writer';
import { redactCause } from '../../../core/errors';

// =============================================================================
// 1. Public types — dependency surface + options
// =============================================================================

/**
 * Re-issue the SENT-ledger write for a delivered OUTBOX entry. Returns
 * `'success'` when the SENT write completed, `'failed'` on a throw,
 * `'skipped'` if no SENT writer is currently installed (worker shall
 * stop the cycle in that case — there is nothing to reconcile against).
 *
 * The closure SHOULD route through
 * `PaymentsModule.writeSentEntryFromOutbox` (or a structurally
 * identical helper) so the on-disk shape exactly matches what the
 * original dispatcher attempt would have produced.
 */
export type WriteSentEntryFn = (
  entry: UxfTransferOutboxEntry,
  opLabel: string,
) => Promise<'success' | 'failed' | 'skipped'>;

/**
 * Provider of the currently-installed {@link OutboxWriter}. Threaded as
 * a closure (NOT a direct reference) so the worker observes writer
 * hot-swaps and uninstalls (`installOutboxWriter(null)`) without
 * holding a dangling reference past `Sphere.destroy()`.
 */
export type OutboxWriterProvider = () => Pick<
  OutboxWriter,
  'readAllNew' | 'delete'
> | null;

/**
 * Provider of the currently-installed {@link SentLedgerWriter}. Same
 * closure rationale as {@link OutboxWriterProvider}.
 */
export type SentLedgerWriterProvider = () => Pick<
  SentLedgerWriter,
  'readOne'
> | null;

/**
 * Logger surface — narrow on purpose so any caller-supplied logger
 * (Sphere's debug logger, a no-op stub, console) plugs in cleanly.
 * Mirrors {@link SendingRecoveryWorkerLogger}.
 */
export interface SentReconciliationWorkerLogger {
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
  readonly info?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Construction-time dependencies for {@link SentReconciliationWorker}.
 */
export interface SentReconciliationWorkerDeps {
  /** OUTBOX writer provider — see {@link OutboxWriterProvider}. */
  readonly outboxProvider: OutboxWriterProvider;
  /** SENT writer provider — see {@link SentLedgerWriterProvider}. */
  readonly sentProvider: SentLedgerWriterProvider;
  /**
   * Pre-bound SENT-write closure. The PaymentsModule supplies a
   * `this.writeSentEntryFromOutbox.bind(this)` so the worker doesn't
   * need raw writer access AND the SENT-entry shape stays identical
   * across the dispatcher and reconciliation code paths.
   */
  readonly writeSentEntry: WriteSentEntryFn;
  /**
   * Sphere event emitter. Issue #166 P4 #4 — return type widened to
   * `void | Promise<void>` so a future async emitter implementation
   * slots in without becoming an unhandled-rejection source.
   */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void | Promise<void>;
  /** Logger — used for forensic warn/info on retries and give-ups. */
  readonly logger?: SentReconciliationWorkerLogger;
  /** Wall-clock provider. Default `Date.now`. Tests inject a fixed clock. */
  readonly now?: () => number;
}

/**
 * Tunable knobs. All have defaults; tests override.
 *
 *  - `intervalMs` (default 60_000): how often the scan loop fires. The
 *    worker uses recursive `setTimeout` (NOT `setInterval`) so a
 *    long-running scan can't queue overlapping iterations — we wait
 *    for one cycle to finish before scheduling the next.
 *  - `staleThresholdMs` (default 30_000): an OUTBOX entry is eligible
 *    for reconciliation only if `now - updatedAt > staleThresholdMs`.
 *    Gives the dispatcher's natural error / retry path a head start
 *    before this worker steps in. Set to 0 in tests for synchronous
 *    eligibility.
 *  - `maxRetries` (default 3): consecutive SENT-write failures (per
 *    entry id) before the worker emits
 *    `transfer:sent-reconciliation-failed` and stops retrying that id.
 */
export interface SentReconciliationWorkerOptions {
  readonly intervalMs?: number;
  readonly staleThresholdMs?: number;
  readonly maxRetries?: number;
}

/** Default scan interval — 60s. Slower than SendingRecoveryWorker (30s)
 *  because the reconciliation arc is a correctness loop, not a
 *  delivery-blocking loop: the bundle is already on the wire. */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;
/** Default stale threshold — 30s. Mirrors the steelman fix's reasoning
 *  that the dispatcher's own error path SHOULD complete within a few
 *  seconds; if an OUTBOX entry has been in `'delivered'` for >30s with
 *  no SENT companion, the dispatcher gave up and operator (worker)
 *  intervention is correct. */
export const DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS = 30_000;
/** Default max consecutive failures before
 *  `transfer:sent-reconciliation-failed`. Three retries gives ~3 minutes
 *  of grace at the default interval before we declare the entry
 *  operator-managed. */
export const DEFAULT_RECONCILIATION_MAX_RETRIES = 3;

// =============================================================================
// 2. SentReconciliationWorker
// =============================================================================

/**
 * Periodic reconciliation worker for OUTBOX entries that delivered but
 * whose SENT-ledger write failed. See module doc for full semantics.
 */
export class SentReconciliationWorker {
  private readonly deps: SentReconciliationWorkerDeps;
  private readonly intervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;

  /** Per-entry consecutive failure counter (reset on success; cleared
   *  when the entry is dropped from the post-give-up set). */
  private readonly failureCounts: Map<string, number> = new Map();
  /** Entry ids that have hit `maxRetries`. The worker skips them on
   *  subsequent cycles until process restart. Process-local so the next
   *  startup re-arms — a restart is the operator's signal of "I've
   *  triaged this." */
  private readonly suspendedIds: Set<string> = new Set();

  /** `true` between `start()` and the first `stop()`. */
  private running = false;
  /** Pending timer handle for the next scheduled cycle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight scan promise; awaited by `stop()` so callers see graceful drain. */
  private scanInFlight: Promise<void> | null = null;

  constructor(
    deps: SentReconciliationWorkerDeps,
    options?: SentReconciliationWorkerOptions,
  ) {
    this.deps = deps;
    this.intervalMs =
      options?.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.staleThresholdMs =
      options?.staleThresholdMs ?? DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_RECONCILIATION_MAX_RETRIES;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Start the periodic scan. Idempotent. The first scan fires after one
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
   * @returns Number of entries reconciled (SENT write retried) this
   *          cycle. Excludes tombstone-only sweeps where the SENT entry
   *          was already present (those are "already-converged" and
   *          counted separately via the return shape below).
   */
  async runScanCycle(): Promise<ReconciliationCycleResult> {
    const outbox = this.deps.outboxProvider();
    const sent = this.deps.sentProvider();

    // If either writer is missing, the sweep is a no-op. The
    // bootstrap layer (Sphere) installs both writers atomically, so
    // the only legitimate "missing" state is "before install" or
    // "after uninstall on destroy." In both, the right behavior is
    // to fast-return without alarming logs.
    if (outbox === null || sent === null) {
      return makeEmptyResult({ skipped: true });
    }

    let entries: ReadonlyArray<UxfTransferOutboxEntry>;
    try {
      entries = await outbox.readAllNew();
    } catch (err) {
      this.warn('readAllNew failed; skipping cycle', { err: errMessage(err) });
      return makeEmptyResult({ skipped: true });
    }

    const nowMs = this.now();
    const eligible = entries.filter(
      (e) =>
        (e.status === 'delivered' || e.status === 'delivered-instant') &&
        nowMs - e.updatedAt > this.staleThresholdMs &&
        !this.suspendedIds.has(e.id),
    );

    let attempted = 0;
    let recovered = 0;
    let alreadyConverged = 0;
    let suspended = 0;
    for (const entry of eligible) {
      attempted += 1;
      const outcome = await this.reconcileOne(entry, outbox, sent);
      switch (outcome) {
        case 'recovered':
          recovered += 1;
          break;
        case 'already-converged':
          alreadyConverged += 1;
          break;
        case 'suspended':
          suspended += 1;
          break;
        case 'retrying':
          // No counter — just a transient failure that will be retried
          // on the next cycle.
          break;
      }
    }
    return {
      attempted,
      recovered,
      alreadyConverged,
      suspended,
      skipped: false,
    };
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Reconcile one entry. Returns the cycle-result classification.
   *
   * Best-effort: any throw from `readOne` or the SENT-write closure is
   * logged and counted toward `maxRetries`; the loop continues.
   */
  private async reconcileOne(
    entry: UxfTransferOutboxEntry,
    outbox: Pick<OutboxWriter, 'readAllNew' | 'delete'>,
    sent: Pick<SentLedgerWriter, 'readOne'>,
  ): Promise<'recovered' | 'already-converged' | 'retrying' | 'suspended'> {
    // Step 1: cheap O(1) existence check on the SENT ledger by id.
    let sentEntry: Awaited<ReturnType<typeof sent.readOne>>;
    try {
      sentEntry = await sent.readOne(entry.id);
    } catch (err) {
      // Treat a SENT-read error the same as a SENT-write failure: count
      // it, log it, retry next cycle. We deliberately do NOT tombstone
      // on read-error — that would defeat the round-2 forensic-record
      // contract.
      const count = (this.failureCounts.get(entry.id) ?? 0) + 1;
      this.failureCounts.set(entry.id, count);
      this.warn('SENT readOne failed', {
        outboxId: entry.id,
        consecutiveFailures: count,
        err: errMessage(err),
      });
      if (count >= this.maxRetries) {
        await this.markSuspended(entry, err);
        return 'suspended';
      }
      return 'retrying';
    }

    // Step 2: already-converged path — SENT exists; the dispatcher's
    // retry / a previous reconciliation cycle finished the write. The
    // OUTBOX entry is no longer needed; tombstone it. (Failures here
    // are warned-only; the SENT entry is permanent, so a missed
    // tombstone just means the entry shows up again next cycle and we
    // try the tombstone again.)
    if (sentEntry !== null) {
      this.failureCounts.delete(entry.id);
      try {
        await outbox.delete(entry.id);
      } catch (err) {
        this.warn('post-converged OUTBOX delete failed (will retry)', {
          outboxId: entry.id,
          err: errMessage(err),
        });
      }
      return 'already-converged';
    }

    // Step 3: missing-SENT path — retry the SENT write.
    let result: 'success' | 'failed' | 'skipped';
    try {
      result = await this.deps.writeSentEntry(entry, 'sentReconciliationWorker');
    } catch (err) {
      // writeSentEntry is supposed to swallow throws and return
      // 'failed', but defense-in-depth: a throw here counts as a
      // failure too.
      const count = (this.failureCounts.get(entry.id) ?? 0) + 1;
      this.failureCounts.set(entry.id, count);
      this.warn('writeSentEntry threw', {
        outboxId: entry.id,
        consecutiveFailures: count,
        err: errMessage(err),
      });
      if (count >= this.maxRetries) {
        await this.markSuspended(entry, err);
        return 'suspended';
      }
      return 'retrying';
    }

    if (result === 'skipped') {
      // SENT writer disappeared between the cycle's provider lookup and
      // the write. Treat the same as the writer-null fast-return:
      // silent skip, do not count as failure.
      return 'retrying';
    }
    if (result === 'failed') {
      const count = (this.failureCounts.get(entry.id) ?? 0) + 1;
      this.failureCounts.set(entry.id, count);
      this.warn('SENT-write retry failed', {
        outboxId: entry.id,
        consecutiveFailures: count,
      });
      if (count >= this.maxRetries) {
        await this.markSuspended(entry, new Error('SENT write returned failed'));
        return 'suspended';
      }
      return 'retrying';
    }

    // Success: tombstone the OUTBOX entry and emit recovery.
    this.failureCounts.delete(entry.id);
    try {
      await outbox.delete(entry.id);
    } catch (err) {
      // Tombstone failed after a successful SENT write — the SENT
      // entry is the durable record, so this is non-fatal. We just
      // come back next cycle and try the tombstone again (the SENT
      // check will short-circuit to the already-converged path).
      this.warn('post-recovery OUTBOX delete failed (will retry on already-converged path)', {
        outboxId: entry.id,
        err: errMessage(err),
      });
    }
    await this.emitRecovered(entry);
    return 'recovered';
  }

  /**
   * Move an entry into the suspended set: emit the failure event and
   * stop further retries for this process lifetime. The in-memory
   * failure counter is cleared because suspension is the terminal
   * state for this worker's tracking.
   */
  private async markSuspended(
    entry: UxfTransferOutboxEntry,
    cause: unknown,
  ): Promise<void> {
    const lastError = errMessage(cause);
    this.suspendedIds.add(entry.id);
    this.failureCounts.delete(entry.id);
    this.warn('suspending entry after maxRetries', {
      outboxId: entry.id,
      consecutiveFailures: this.maxRetries,
      lastError,
    });
    try {
      await this.deps.emit('transfer:sent-reconciliation-failed', {
        outboxId: entry.id,
        consecutiveFailures: this.maxRetries,
        lastError,
        failedAt: this.now(),
      });
    } catch (emitErr) {
      this.warn('emit transfer:sent-reconciliation-failed failed', {
        outboxId: entry.id,
        err: errMessage(emitErr),
      });
    }
  }

  private async emitRecovered(entry: UxfTransferOutboxEntry): Promise<void> {
    try {
      await this.deps.emit('transfer:sent-reconciliation-recovered', {
        outboxId: entry.id,
        tokenIds: entry.tokenIds,
        mode: entry.mode,
        recoveredAt: this.now(),
      });
    } catch (emitErr) {
      this.warn('emit transfer:sent-reconciliation-recovered failed', {
        outboxId: entry.id,
        err: errMessage(emitErr),
      });
    }
  }

  /**
   * Schedule the next scan via recursive setTimeout.
   *
   * The IIFE pattern mirrors {@link SendingRecoveryWorker.scheduleNext}'s
   * Wave 3 steelman fix: assign `this.scanInFlight` synchronously,
   * inside the same statement that creates the promise, so `stop()`
   * cannot observe `null` while a cycle is mid-flight.
   */
  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scanInFlight = (async (): Promise<void> => {
        try {
          await this.runScanCycle();
        } catch (err) {
          this.warn('unexpected scan-cycle throw', { err: errMessage(err) });
        }
      })();
      void this.scanInFlight.finally(() => {
        this.scanInFlight = null;
        this.scheduleNext();
      });
    }, this.intervalMs);
  }

  private warn(message: string, context?: Record<string, unknown>): void {
    this.deps.logger?.warn(`SentReconciliationWorker: ${message}`, context);
  }
}

// =============================================================================
// 3. Result types + helpers
// =============================================================================

/**
 * One scan cycle's outcome. All counts are non-negative integers.
 * `skipped: true` means the cycle did not run a meaningful sweep (no
 * writers installed, OR `readAllNew` failed) — counters in that case
 * are all zero.
 */
export interface ReconciliationCycleResult {
  /** OUTBOX entries that matched the eligibility filter and reached
   *  reconcileOne (excludes those filtered for status / staleness /
   *  suspended). */
  readonly attempted: number;
  /** Entries whose SENT write was successfully retried this cycle. */
  readonly recovered: number;
  /** Entries that already had a SENT companion — only the OUTBOX
   *  tombstone was applied. */
  readonly alreadyConverged: number;
  /** Entries that exceeded `maxRetries` THIS CYCLE and were added to
   *  the suspended set. (Previously-suspended entries are filtered out
   *  before `attempted` is counted, so they do NOT inflate this number
   *  on repeated cycles.) */
  readonly suspended: number;
  /** `true` when the cycle was a no-op (writers missing or
   *  `readAllNew` failed). */
  readonly skipped: boolean;
}

function makeEmptyResult(
  partial: Partial<ReconciliationCycleResult> = {},
): ReconciliationCycleResult {
  return {
    attempted: 0,
    recovered: 0,
    alreadyConverged: 0,
    suspended: 0,
    skipped: false,
    ...partial,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  // Walk unknown-shape inputs through W40 redactCause before
  // JSON.stringify so any sensitive own-properties are scrubbed before
  // reaching the log line. Mirrors the same defense in
  // sending-recovery-worker.ts.
  try {
    return JSON.stringify(redactCause(err));
  } catch {
    return String(err);
  }
}
