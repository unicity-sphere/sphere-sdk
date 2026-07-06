/**
 * Tombstone garbage-collection worker (OUTBOX-SEND-FOLLOWUPS item #4).
 *
 * Profile writers (`OutboxWriter`, `SentLedgerWriter`) implement
 * `delete(id)` as a tombstone write (`{ tombstoned: true, deletedAt,
 * lamport }`) rather than `db.del(key)`. The tombstone marker is
 * load-bearing for the Issue #166 P1 #2 refuse-write guard — without
 * it, a concurrent replica's pre-sync state could resurrect a
 * completed delivery. But tombstones never go away, so the OrbitDB
 * log grows monotonically across the wallet's lifetime.
 *
 * This worker reclaims storage by periodically sweeping each writer's
 * tombstoned slots. Tombstones older than the configured retention
 * window (default 30 days) are demoted to real `db.del(key)` calls so
 * the slot bytes are freed.
 *
 * **Safety contract.** Sweeping a tombstone that is still within any
 * concurrent replica's pre-sync horizon resurrects the slot. The 30-
 * day default is conservative — operators with longer offline-replica
 * windows MUST raise `retentionMs` accordingly. The writer-level
 * `gcExpiredTombstones()` documents the same contract.
 *
 * **Feature-flag gated.** Auto-installed from `PaymentsModule` when
 * `features.tombstoneGcWorker` is `true`. Default-ON after the
 * OUTBOX-SEND-FOLLOWUPS item #5 soak — set the flag explicitly to
 * `false` to suppress (e.g. timer-sensitive unit tests).
 *
 * @module modules/payments/transfer/tombstone-gc-worker
 */

import type { OutboxWriter } from '../../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../../profile/sent-ledger-writer';
import type { TombstoneGcResult } from '../../../profile/types';
import { redactCause } from '../../../core/errors';

// =============================================================================
// 1. Public types
// =============================================================================

/** Provider returns the currently-installed writer, or `null` when no
 *  writer is wired (legacy wallet, pre-install, post-destroy). */
export type OutboxWriterProvider = () => Pick<
  OutboxWriter,
  'gcExpiredTombstones'
> | null;
export type SentLedgerWriterProvider = () => Pick<
  SentLedgerWriter,
  'gcExpiredTombstones'
> | null;

/** Narrow logger surface, mirrors the other workers. */
export interface TombstoneGcWorkerLogger {
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
  readonly info?: (message: string, context?: Record<string, unknown>) => void;
}

export interface TombstoneGcWorkerDeps {
  /** OUTBOX writer provider — see {@link OutboxWriterProvider}. */
  readonly outboxProvider: OutboxWriterProvider;
  /** SENT writer provider — see {@link SentLedgerWriterProvider}. */
  readonly sentProvider: SentLedgerWriterProvider;
  /** Logger; defaults to no-op when omitted. */
  readonly logger?: TombstoneGcWorkerLogger;
  /** Wall-clock provider. Default `Date.now`. Tests inject a fixed
   *  clock so the retention math is deterministic. */
  readonly now?: () => number;
}

/**
 * Tunable knobs. All have defaults; tests + operators override.
 *
 *  - `intervalMs` (default 24 h): how often the scan loop fires. GC
 *    is low-urgency; cheap to run less often than retention checks.
 *  - `retentionMs` (default 30 days): tombstones whose
 *    `(now - deletedAt) > retentionMs` are eligible for purge. See
 *    the worker module doc for the safety contract.
 */
export interface TombstoneGcWorkerOptions {
  readonly intervalMs?: number;
  readonly retentionMs?: number;
}

/** Default scan interval — 24 h. */
export const DEFAULT_TOMBSTONE_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Default retention window — 30 days. */
export const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Aggregate cycle result. Sums the per-writer GC counts. */
export interface TombstoneGcCycleResult {
  readonly outbox: TombstoneGcResult;
  readonly sent: TombstoneGcResult;
  /** Total scanned across both writers. */
  readonly scanned: number;
  /** Total purged across both writers. */
  readonly purged: number;
  /** Total kept across both writers. */
  readonly kept: number;
}

// =============================================================================
// 2. TombstoneGcWorker
// =============================================================================

/**
 * Periodic tombstone-GC worker. See module doc for full semantics.
 */
export class TombstoneGcWorker {
  private readonly deps: TombstoneGcWorkerDeps;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  /** `true` between `start()` and the first `stop()`. */
  private running = false;
  /** Pending timer handle for the next scheduled cycle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight scan promise; awaited by `stop()` so callers see
   *  graceful drain. */
  private scanInFlight: Promise<void> | null = null;

  constructor(
    deps: TombstoneGcWorkerDeps,
    options?: TombstoneGcWorkerOptions,
  ) {
    this.deps = deps;
    this.intervalMs = options?.intervalMs ?? DEFAULT_TOMBSTONE_GC_INTERVAL_MS;
    this.retentionMs = options?.retentionMs ?? DEFAULT_TOMBSTONE_RETENTION_MS;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Start the periodic scan. Idempotent. First scan fires after one
   * `intervalMs` delay (mirrors the other workers).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the periodic scan and await any in-flight cycle. Idempotent.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.scanInFlight !== null) {
      await this.scanInFlight.catch(() => undefined);
      this.scanInFlight = null;
    }
  }

  /** Diagnostic: is the worker scheduling cycles? */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * One scan pass. Public so tests can trigger a cycle deterministically
   * without waiting for the timer.
   */
  async runScanCycle(): Promise<TombstoneGcCycleResult> {
    const nowMs = this.now();

    const outboxResult = await this.gcWriter(
      'outbox',
      this.deps.outboxProvider(),
      nowMs,
    );
    const sentResult = await this.gcWriter(
      'sent',
      this.deps.sentProvider(),
      nowMs,
    );

    const scanned = outboxResult.scanned + sentResult.scanned;
    const purged = outboxResult.purged + sentResult.purged;
    const kept = outboxResult.kept + sentResult.kept;
    return {
      outbox: outboxResult,
      sent: sentResult,
      scanned,
      purged,
      kept,
    };
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Run gc on one writer; converts an absent writer or a thrown gc
   * call into a `skipped: true` result so the cycle aggregate still
   * makes sense.
   */
  private async gcWriter(
    label: 'outbox' | 'sent',
    writer:
      | Pick<OutboxWriter, 'gcExpiredTombstones'>
      | Pick<SentLedgerWriter, 'gcExpiredTombstones'>
      | null,
    nowMs: number,
  ): Promise<TombstoneGcResult> {
    if (writer === null) {
      return { scanned: 0, purged: 0, kept: 0, skipped: true };
    }
    try {
      return await writer.gcExpiredTombstones({
        retentionMs: this.retentionMs,
        now: nowMs,
      });
    } catch (err) {
      this.warn(`gcExpiredTombstones threw for ${label}; treating as skipped`, {
        writer: label,
        err: errMessage(err),
      });
      return { scanned: 0, purged: 0, kept: 0, skipped: true };
    }
  }

  /**
   * Schedule the next scan via recursive setTimeout. Same IIFE
   * pattern as the other workers: assign `scanInFlight` synchronously
   * so `stop()` cannot observe `null` while a cycle is mid-flight.
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
    this.deps.logger?.warn(`TombstoneGcWorker: ${message}`, context);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(redactCause(err));
  } catch {
    return String(err);
  }
}
