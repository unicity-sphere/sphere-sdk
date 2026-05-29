/**
 * Nostr persistence verification worker (Issue #166 P2 #3).
 *
 * Closes the long-term retention gap left by
 * `NostrTransportProvider.publishWithVerification` — which verifies
 * the publish landed on the relay within a 300-1500ms window, but
 * has no signal for what happens to the event MINUTES or HOURS later
 * (retention policy eviction, relay restart loss, relay-segregation
 * where the event was accepted by one relay but never federated).
 *
 * **What this worker does:**
 *   1. Periodically scans the SENT ledger for entries with a
 *      `nostrEventId` set AND past the `verifyDelayMs` threshold
 *      since `sentAt` (default 5 min — long enough that immediate
 *      relay verification has settled, short enough to catch
 *      short-window retention before recipients give up).
 *   2. For each eligible entry, calls the injected `verify` closure
 *      (which routes to {@link TransportProvider.verifyTokenTransferRetained}
 *      when available, else returns `'unverifiable'`).
 *   3. On `'retained'` → adds the entry to the in-memory verified
 *      set; future cycles skip it.
 *   4. On `'missing'` → emits `transfer:retention-warning` and adds
 *      the entry to the in-memory verified set (we've already
 *      reported; spamming the same warning every cycle adds no
 *      value — operator already sees it).
 *   5. On `'unverifiable'` → leaves the entry untouched; retry next
 *      cycle. NOT counted toward any failure budget — a transient
 *      query failure must not produce false `retention-warning`
 *      events.
 *
 * **What this worker does conditionally (OUTBOX-SEND-FOLLOWUPS item #2):**
 *   - When an `outboxProvider` is wired AND the SENT entry's
 *     companion OUTBOX entry is STILL LIVE at status
 *     `'delivered'`/`'delivered-instant'`, the verifier transitions
 *     that OUTBOX entry back to `'sending'` so the
 *     `SendingRecoveryWorker` picks it up and republishes. The
 *     ORIGINAL SENT entry is untouched (durable historical record).
 *     The recipient's replay-LRU dedupes by `bundleCid` so multiple
 *     publishes are harmless (§6.3 / T.3.A).
 *   - The `delivered → sending` and `delivered-instant → sending`
 *     state-machine arcs were added for exactly this purpose; see
 *     `profile/outbox-state-machine.ts`.
 *   - Emits `transfer:retention-republish-rearmed` on success or
 *     `transfer:retention-republish-skipped` (with a `reason`) when
 *     a re-publish cannot be initiated. The legacy
 *     `transfer:retention-warning` still fires regardless.
 *
 * **What this worker deliberately does NOT do (Phase 1):**
 *   - Does not re-publish for entries whose OUTBOX counterpart is
 *     tombstoned/missing. Conservative-mode wallets tombstone the
 *     OUTBOX on successful SENT-write; the inline CAR bytes are not
 *     retained anywhere. Reconstructing the publish would require the
 *     "bundle retention" architectural work tracked in OUTBOX-SEND-
 *     FOLLOWUPS cross-cutting concerns. For now we emit
 *     `transfer:retention-republish-skipped` with
 *     `reason='entry-tombstoned-or-missing'` so operators see the case.
 *   - Does not re-resolve the recipient pubkey. If the recipient has
 *     rotated keys since the original publish, the re-publish fails
 *     silently at the transport layer. Documented surface concern;
 *     out of scope for this PR.
 *   - Does not touch entries lacking `nostrEventId` (pre-#166 SENT
 *     entries, or paths that haven't wired the dispatcher capture).
 *     Without an event id there is nothing to query.
 *   - Does not delete or modify SENT entries on any outcome. SENT is
 *     a permanent ledger; this worker is observational only.
 *
 * **Idempotency:** repeated invocations on the same state produce
 * identical decisions. The verified set is in-memory only — a
 * process restart re-arms all checks, which is the right behavior
 * (the operator wants to know about transient retention loss across
 * restarts).
 *
 * **Concurrency:** safe to invoke concurrently with sends. The worker
 * only READS from SENT and the transport's verify method; it makes
 * no mutating calls.
 *
 * @module modules/payments/transfer/nostr-persistence-verifier
 *
 * @see transport/transport-provider.ts (`verifyTokenTransferRetained`)
 * @see transport/NostrTransportProvider.ts (the relay-query impl)
 * @see modules/payments/transfer/sending-recovery-worker.ts (structural twin)
 */

import type { SphereEventMap, SphereEventType } from '../../../types';
import type { UxfSentLedgerEntry } from '../../../types/uxf-sent';
import type { SentLedgerWriter } from '../../../profile/sent-ledger-writer';
import type { OutboxWriter } from '../../../profile/outbox-writer';
import type { UxfTransferOutboxEntry } from '../../../types/uxf-outbox';
import { redactCause, SphereError } from '../../../core/errors';

// =============================================================================
// 1. Public types — dependency surface + options
// =============================================================================

/**
 * Verify outcome — mirrors
 * {@link TransportProvider.verifyTokenTransferRetained} so the worker
 * can route through the transport directly.
 *  - `'retained'`     — event still present on the relay.
 *  - `'missing'`      — event verified absent (retention drop).
 *  - `'unverifiable'` — query failed; cannot determine.
 */
export type VerifyOutcome = 'retained' | 'missing' | 'unverifiable';

/**
 * Closure that performs the actual verification for a single SENT
 * entry. The PaymentsModule supplies a default that routes to
 * `transport.verifyTokenTransferRetained?(entry.nostrEventId)` when
 * available; tests inject deterministic outcomes.
 *
 * The closure receives the WHOLE entry (not just the event id) so
 * future verify strategies can use bundleCid / recipientTransportPubkey
 * as fallback identifiers without changing the worker's signature.
 */
export type VerifySentEntryFn = (entry: UxfSentLedgerEntry) => Promise<VerifyOutcome>;

/**
 * Provider of the currently-installed {@link SentLedgerWriter}. Threaded
 * as a closure (NOT a direct reference) so the worker observes
 * hot-swaps and uninstalls (`installSentLedgerWriter(null)`) without
 * holding a dangling reference past `Sphere.destroy()`.
 */
export type SentLedgerWriterProvider = () => Pick<
  SentLedgerWriter,
  'readAll'
> | null;

/**
 * OUTBOX-SEND-FOLLOWUPS item #2 — provider of the currently-installed
 * {@link OutboxWriter}. Optional: when omitted, the verifier preserves
 * its Phase-1 detect-only contract (warning event only, no re-publish
 * attempt). When wired, the verifier transitions live OUTBOX entries
 * back to `'sending'` on `'missing'` outcomes.
 *
 * Threaded as a closure (same rationale as
 * {@link SentLedgerWriterProvider}).
 */
export type OutboxWriterProvider = () => Pick<
  OutboxWriter,
  'update'
> | null;

/**
 * Logger surface — narrow on purpose so any caller-supplied logger
 * plugs in cleanly. Mirrors the other workers' Logger types.
 */
export interface NostrPersistenceVerifierLogger {
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
  readonly info?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Construction-time dependencies for {@link NostrPersistenceVerifier}.
 */
export interface NostrPersistenceVerifierDeps {
  /** SENT writer provider — see {@link SentLedgerWriterProvider}. */
  readonly sentProvider: SentLedgerWriterProvider;
  /**
   * OUTBOX-SEND-FOLLOWUPS item #2 — OUTBOX writer provider. Optional;
   * when undefined the verifier reverts to detect-only behaviour and
   * emits `transfer:retention-republish-skipped` with
   * `reason='no-outbox-writer'` for every `'missing'` outcome.
   */
  readonly outboxProvider?: OutboxWriterProvider;
  /** Verify closure — see {@link VerifySentEntryFn}. */
  readonly verify: VerifySentEntryFn;
  /**
   * Sphere event emitter. Forward-compatible with async emitters
   * (mirrors Issue #166 P4 #4): `void | Promise<void>` return.
   */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void | Promise<void>;
  /** Logger — forensic warn/info on retention drops and query
   *  failures. */
  readonly logger?: NostrPersistenceVerifierLogger;
  /** Wall-clock provider. Default `Date.now`. Tests inject a fixed
   *  clock. */
  readonly now?: () => number;
}

/**
 * Tunable knobs. All have defaults; tests override.
 *
 *  - `intervalMs` (default 5 min): how often the scan loop fires.
 *    Slower than SendingRecoveryWorker (30s) because retention checks
 *    are passive observations, not delivery-blocking work.
 *  - `verifyDelayMs` (default 5 min): an SENT entry is eligible only
 *    if `now - sentAt > verifyDelayMs`. Lets the immediate
 *    `publishWithVerification` window (300-1500ms + 3 retries)
 *    complete naturally before this worker steps in.
 *  - `maxScanPerCycle` (default 50): caps relay query load per
 *    cycle. Wallets with thousands of SENT entries do NOT pay an
 *    O(n) relay-query cost per cycle; they process the oldest
 *    unchecked 50 per cycle and converge over many cycles.
 */
export interface NostrPersistenceVerifierOptions {
  readonly intervalMs?: number;
  readonly verifyDelayMs?: number;
  readonly maxScanPerCycle?: number;
}

/** Default scan interval — 5 min. */
export const DEFAULT_VERIFIER_INTERVAL_MS = 5 * 60 * 1000;
/** Default verify delay — 5 min. */
export const DEFAULT_VERIFIER_DELAY_MS = 5 * 60 * 1000;
/** Default max entries verified per cycle. */
export const DEFAULT_VERIFIER_MAX_SCAN_PER_CYCLE = 50;

// =============================================================================
// 2. NostrPersistenceVerifier
// =============================================================================

/**
 * Periodic worker for long-term Nostr persistence verification. See
 * module doc for full semantics.
 */
export class NostrPersistenceVerifier {
  private readonly deps: NostrPersistenceVerifierDeps;
  private readonly intervalMs: number;
  private readonly verifyDelayMs: number;
  private readonly maxScanPerCycle: number;
  private readonly now: () => number;

  /** Set of SENT entry ids already classified (retained OR missing).
   *  In-memory only — restart re-arms the checks. */
  private readonly checkedIds: Set<string> = new Set();

  /** `true` between `start()` and the first `stop()`. */
  private running = false;
  /** Pending timer handle for the next scheduled cycle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight scan promise; awaited by `stop()` so callers see
   *  graceful drain. */
  private scanInFlight: Promise<void> | null = null;

  constructor(
    deps: NostrPersistenceVerifierDeps,
    options?: NostrPersistenceVerifierOptions,
  ) {
    this.deps = deps;
    this.intervalMs = options?.intervalMs ?? DEFAULT_VERIFIER_INTERVAL_MS;
    this.verifyDelayMs = options?.verifyDelayMs ?? DEFAULT_VERIFIER_DELAY_MS;
    this.maxScanPerCycle =
      options?.maxScanPerCycle ?? DEFAULT_VERIFIER_MAX_SCAN_PER_CYCLE;
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Start the periodic scan. Idempotent. The first scan fires after
   * one `intervalMs` delay so the worker doesn't race with whatever
   * just instantiated it.
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
   * One scan pass. Public so tests can trigger a cycle deterministically
   * without waiting for the timer.
   *
   * @returns The result classification counts for this cycle.
   */
  async runScanCycle(): Promise<VerifierCycleResult> {
    const sent = this.deps.sentProvider();
    if (sent === null) {
      return emptyResult({ skipped: true });
    }

    let entries: ReadonlyArray<UxfSentLedgerEntry>;
    try {
      entries = await sent.readAll();
    } catch (err) {
      this.warn('readAll failed; skipping cycle', { err: errMessage(err) });
      return emptyResult({ skipped: true });
    }

    const nowMs = this.now();
    // Eligibility: has event id, past verify delay, not already
    // classified, and the id has reasonable shape (defense-in-depth,
    // the type guard already validates this on read).
    const eligible = entries.filter(
      (e) =>
        typeof e.nostrEventId === 'string' &&
        e.nostrEventId.length > 0 &&
        nowMs - e.sentAt > this.verifyDelayMs &&
        !this.checkedIds.has(e.id),
    );

    // Process oldest-first so retention warnings appear in send-time
    // order even when the cycle has more eligible entries than the
    // per-cycle cap.
    eligible.sort((a, b) => a.sentAt - b.sentAt);

    const slice = eligible.slice(0, this.maxScanPerCycle);

    let retained = 0;
    let missing = 0;
    let unverifiable = 0;
    for (const entry of slice) {
      const outcome = await this.verifyOne(entry);
      switch (outcome) {
        case 'retained':
          retained += 1;
          break;
        case 'missing':
          missing += 1;
          break;
        case 'unverifiable':
          unverifiable += 1;
          break;
      }
    }
    return {
      attempted: slice.length,
      eligibleTotal: eligible.length,
      retained,
      missing,
      unverifiable,
      skipped: false,
    };
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Verify one entry. Returns the outcome classification for the cycle
   * counters; the side-effects (event emission, set update) are
   * applied here.
   */
  private async verifyOne(entry: UxfSentLedgerEntry): Promise<VerifyOutcome> {
    let outcome: VerifyOutcome;
    try {
      outcome = await this.deps.verify(entry);
    } catch (err) {
      // verify is supposed to swallow throws and return 'unverifiable'.
      // Defense-in-depth: a throw is treated as unverifiable so the
      // worker does not false-positive a retention warning.
      this.warn('verify threw (treating as unverifiable)', {
        sentId: entry.id,
        err: errMessage(err),
      });
      return 'unverifiable';
    }

    if (outcome === 'retained') {
      this.checkedIds.add(entry.id);
      return 'retained';
    }
    if (outcome === 'missing') {
      this.checkedIds.add(entry.id);
      await this.emitRetentionWarning(entry);
      // OUTBOX-SEND-FOLLOWUPS item #2 — opportunistic re-publish.
      // Fires regardless of whether the warning emit raised (the
      // warning's catch absorbed it). The re-publish attempt is best-
      // effort: it emits its own `rearmed` / `skipped` event for
      // operator visibility and never throws.
      await this.attemptRetentionRepublish(entry);
      return 'missing';
    }
    // unverifiable — do NOT add to checkedIds (retry next cycle).
    return 'unverifiable';
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS item #2 — opportunistic retention re-publish.
   *
   * Tries to flip the OUTBOX entry at `entry.id` from `'delivered'` or
   * `'delivered-instant'` back to `'sending'` so the
   * SendingRecoveryWorker republishes via its existing scan-and-
   * publish loop. The original SENT entry is left untouched (durable
   * historical record); the recipient's replay-LRU dedupes by
   * `bundleCid` so racing/duplicate publishes are harmless (§6.3 /
   * T.3.A).
   *
   * Never throws. Each failure / skip path emits
   * `transfer:retention-republish-skipped` with a structured reason
   * for operator visibility; success emits
   * `transfer:retention-republish-rearmed`. Catches any emit failure
   * defensively — the warn-log preserves the forensic context.
   */
  private async attemptRetentionRepublish(
    entry: UxfSentLedgerEntry,
  ): Promise<void> {
    if (typeof entry.nostrEventId !== 'string') return;

    if (this.deps.outboxProvider === undefined) {
      await this.emitRepublishSkipped(entry, 'no-outbox-writer');
      return;
    }
    const writer = this.deps.outboxProvider();
    if (writer === null) {
      await this.emitRepublishSkipped(entry, 'no-outbox-writer');
      return;
    }

    // The OUTBOX writer's `update()` reads the live entry, applies a
    // mutator, and writes with state-machine validation. If the slot
    // has been tombstoned (conservative-mode successful send) OR was
    // never present (corrupted SENT id), `update()` throws
    // `OUTBOX_ENTRY_NOT_FOUND`. If the entry exists but holds a non-
    // `delivered{,-instant}` status (already advanced to `'finalizing'`,
    // `'expired'`, etc.), the state-machine validator throws
    // `INVALID_OUTBOX_TRANSITION` — we treat that as `'wrong-status'`.
    let observedStatus: UxfTransferOutboxEntry['status'] | null = null;
    let updated: UxfTransferOutboxEntry | null = null;
    try {
      updated = await writer.update(entry.id, (prev) => {
        observedStatus = prev.status;
        if (prev.status !== 'delivered' && prev.status !== 'delivered-instant') {
          // Signal the wrong-status case to the catch via a tagged
          // error; we don't issue a self-loop write because the
          // validator would reject the no-op anyway.
          throw new SphereError(
            `NostrPersistenceVerifier: cannot re-arm retention re-publish — ` +
              `outbox entry "${entry.id}" is at status="${prev.status}", expected ` +
              `"delivered" or "delivered-instant"`,
            'VALIDATION_ERROR',
          );
        }
        return { ...prev, status: 'sending' };
      });
    } catch (err) {
      const message = errMessage(err);
      // Distinguish the three skip reasons by SphereError code when
      // possible. Order matters: check OUTBOX_ENTRY_NOT_FOUND /
      // OUTBOX_ENTRY_TOMBSTONED before the wrong-status branch.
      const code =
        err instanceof SphereError ? err.code : undefined;
      if (
        code === 'OUTBOX_ENTRY_NOT_FOUND' ||
        code === 'OUTBOX_ENTRY_TOMBSTONED'
      ) {
        await this.emitRepublishSkipped(
          entry,
          'entry-tombstoned-or-missing',
          { errorMessage: message },
        );
        return;
      }
      if (observedStatus !== null) {
        await this.emitRepublishSkipped(entry, 'wrong-status', {
          observedStatus: String(observedStatus),
          errorMessage: message,
        });
        return;
      }
      await this.emitRepublishSkipped(entry, 'transition-failed', {
        errorMessage: message,
      });
      return;
    }

    // Updated entry now at 'sending'. Pull the original status from
    // the closure variable observed inside the mutator — that reflects
    // the pre-transition state, not the just-written one.
    const fromStatus: 'delivered' | 'delivered-instant' =
      observedStatus === 'delivered-instant'
        ? 'delivered-instant'
        : 'delivered';
    try {
      await this.deps.emit('transfer:retention-republish-rearmed', {
        sentId: entry.id,
        nostrEventId: entry.nostrEventId,
        bundleCid: entry.bundleCid,
        tokenIds: entry.tokenIds,
        recipientTransportPubkey: entry.recipientTransportPubkey,
        fromStatus,
        toStatus: 'sending',
        rearmedAt: this.now(),
      });
    } catch (emitErr) {
      this.warn('emit transfer:retention-republish-rearmed failed', {
        sentId: entry.id,
        err: errMessage(emitErr),
      });
    }
    // Touch the updated reference so TypeScript doesn't strip it.
    if (updated !== null) {
      this.warn('retention re-publish armed', {
        sentId: entry.id,
        bundleCid: entry.bundleCid,
        fromStatus,
        newLamport: updated.lamport,
      });
    }
  }

  private async emitRepublishSkipped(
    entry: UxfSentLedgerEntry,
    reason:
      | 'no-outbox-writer'
      | 'entry-tombstoned-or-missing'
      | 'wrong-status'
      | 'transition-failed',
    extras: { readonly observedStatus?: string; readonly errorMessage?: string } = {},
  ): Promise<void> {
    if (typeof entry.nostrEventId !== 'string') return;
    try {
      await this.deps.emit('transfer:retention-republish-skipped', {
        sentId: entry.id,
        nostrEventId: entry.nostrEventId,
        bundleCid: entry.bundleCid,
        reason,
        ...(extras.observedStatus !== undefined
          ? { observedStatus: extras.observedStatus }
          : {}),
        ...(extras.errorMessage !== undefined
          ? { errorMessage: extras.errorMessage }
          : {}),
        detectedAt: this.now(),
      });
    } catch (emitErr) {
      this.warn('emit transfer:retention-republish-skipped failed', {
        sentId: entry.id,
        reason,
        err: errMessage(emitErr),
      });
    }
  }

  private async emitRetentionWarning(entry: UxfSentLedgerEntry): Promise<void> {
    // Type-guard already requires nostrEventId non-empty when present;
    // this re-check is purely for TypeScript narrowing.
    if (typeof entry.nostrEventId !== 'string') return;
    try {
      await this.deps.emit('transfer:retention-warning', {
        sentId: entry.id,
        nostrEventId: entry.nostrEventId,
        bundleCid: entry.bundleCid,
        tokenIds: entry.tokenIds,
        recipientTransportPubkey: entry.recipientTransportPubkey,
        detectedAt: this.now(),
      });
    } catch (emitErr) {
      this.warn('emit transfer:retention-warning failed', {
        sentId: entry.id,
        err: errMessage(emitErr),
      });
    }
  }

  /**
   * Schedule the next scan via recursive setTimeout. IIFE pattern
   * mirrors SendingRecoveryWorker's Wave 3 steelman fix: assign
   * `this.scanInFlight` synchronously so `stop()` cannot observe
   * `null` while a cycle is mid-flight.
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
    this.deps.logger?.warn(`NostrPersistenceVerifier: ${message}`, context);
  }
}

// =============================================================================
// 3. Result types + helpers
// =============================================================================

/**
 * One scan cycle's outcome. `skipped: true` means the cycle did not
 * run a meaningful sweep (no SENT writer installed, OR `readAll`
 * failed) — counters in that case are all zero.
 */
export interface VerifierCycleResult {
  /** Entries that reached `verifyOne` this cycle (≤ maxScanPerCycle). */
  readonly attempted: number;
  /** Total eligible entries identified by the filter (may exceed
   *  `attempted` when the per-cycle cap throttles processing). */
  readonly eligibleTotal: number;
  /** Entries verified retained this cycle. */
  readonly retained: number;
  /** Entries verified missing this cycle (warning emitted). */
  readonly missing: number;
  /** Entries the verify closure returned `'unverifiable'` for. */
  readonly unverifiable: number;
  /** `true` when the cycle was a no-op (writer missing or readAll
   *  failed). */
  readonly skipped: boolean;
}

function emptyResult(
  partial: Partial<VerifierCycleResult> = {},
): VerifierCycleResult {
  return {
    attempted: 0,
    eligibleTotal: 0,
    retained: 0,
    missing: 0,
    unverifiable: 0,
    skipped: false,
    ...partial,
  };
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
