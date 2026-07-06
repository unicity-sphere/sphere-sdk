/**
 * Orphan-spending-tx sweeper (Issue #97 step 6).
 *
 * Detects tokens that have an in-flight spending transaction (local
 * status `'transferring'`) but are NOT referenced by any live OUTBOX
 * entry AND NOT recorded in the SENT ledger. This state means a
 * crash occurred between Step 1 (append spending tx + sync to IPFS)
 * and Step 2 (persist outbox entry) of the canonical send flow — the
 * spending commitment is on-chain (or at least submitted), but the
 * delivery never made it past the in-memory `transferring` marker.
 *
 * **What this module does NOT do (Phase 1):**
 * - Does not auto-recover by re-packaging the orphan into a new UXF
 *   bundle. Auto-recovery requires reconstructing the recipient from
 *   the spending tx's predicate target, building + pinning a fresh
 *   CAR file, and writing a synthetic OUTBOX entry. That work is
 *   gated to a follow-up wave (Phase 2) because the surface area for
 *   silent miss-routing is too large to ship without extensive
 *   testing — operator triage on detection is the safer first step.
 *
 * **What this module DOES (Phase 1):**
 * - Scans every loaded token; finds those in `'transferring'` status
 *   that are absent from both OUTBOX and SENT.
 * - Emits a `transfer:orphan-spending-detected` event per orphan so
 *   operators (and downstream tooling) get notified.
 * - Logs at ERROR with enough context for manual recovery: tokenId,
 *   coinId, amount, last-known updatedAt timestamp.
 * - Returns the list of detected orphans so callers can drive their
 *   own remediation paths.
 *
 * @module modules/payments/transfer/orphan-spending-sweeper
 */

import type { Token, SphereEventMap, SphereEventType } from '../../../types';
import type { OutboxWriter } from '../profile/outbox-writer';
import type { SentLedgerWriter } from '../profile/sent-ledger-writer';
import { logger } from '../../../core/logger';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * One orphan finding returned by {@link sweepOrphanSpendingTokens}.
 */
export interface OrphanSpendingFinding {
  /** The orphan token id. */
  readonly tokenId: string;
  /** Coin id (for operator triage). */
  readonly coinId: string;
  /** Token amount in smallest units (for operator triage). */
  readonly amount: string;
  /** Token's last in-memory updatedAt timestamp. */
  readonly lastUpdatedAt: number;
  /** Wall-clock ms timestamp when the orphan was detected. */
  readonly detectedAt: number;
}

/**
 * Result of a sweeper run.
 */
export interface OrphanSweepResult {
  /** Tokens detected as orphans. Empty array on clean wallets. */
  readonly orphans: ReadonlyArray<OrphanSpendingFinding>;
  /** Total `'transferring'` tokens scanned (for diagnostics). */
  readonly scannedTransferringCount: number;
  /** Outbox+SENT membership cache size (for diagnostics). */
  readonly knownTokenIdsCount: number;
  /** Whether the sweep ran. Sweep is skipped when both writers are null
   *  (no profile-resident persistence). */
  readonly skipped: boolean;
  /**
   * Issue #166 P2 #1 — count of orphans the recovery hook reclaimed
   * (status restored, `transfer:orphan-recovered` emitted). Zero when
   * no `attemptRecovery` hook was supplied — that preserves the
   * Phase-1 detect-only contract.
   */
  readonly recoveredCount: number;
  /**
   * Issue #166 P2 #1 — count of orphans left to operator triage
   * (`transfer:orphan-spending-detected` emitted as in Phase 1).
   * Equals `orphans.length - recoveredCount`.
   */
  readonly manualCount: number;
}

/**
 * Issue #166 P2 #1 — Recovery-attempt callback. Supplied by the
 * orchestrator (PaymentsModule) when `features.orphanAutoRecovery` is
 * ON. Invoked once per detected orphan BEFORE the legacy
 * `transfer:orphan-spending-detected` event would fire.
 *
 * Return semantics:
 *  - `'recovered'` — the callback reclaimed the orphan (e.g. restored
 *    its in-memory status to `'confirmed'` and persisted). The sweeper
 *    emits `transfer:orphan-recovered` instead of the detected event
 *    and counts the entry under `recoveredCount`.
 *  - `'manual'`    — the callback could not safely recover (e.g. the
 *    orphan's spending commit may already be on-chain). The sweeper
 *    falls back to Phase-1 behavior: emits `transfer:orphan-spending-detected`
 *    and counts the entry under `manualCount`.
 *
 * Implementations MUST NOT throw — convert internal errors to
 * `'manual'`. A throw is treated as `'manual'` defensively (and
 * `warn`-logged) so the sweeper never silently drops an orphan due
 * to a callback bug.
 */
export type AttemptRecoveryFn = (
  finding: OrphanSpendingFinding,
) => Promise<'recovered' | 'manual'>;

/**
 * Dependencies bundle for {@link sweepOrphanSpendingTokens}.
 */
export interface OrphanSweeperDeps {
  /** Iterable of all loaded tokens (typically `paymentsModule.tokens.values()`). */
  readonly tokens: Iterable<Token>;
  /** Profile-resident outbox writer. When `null`, the sweep is skipped
   *  because OUTBOX membership cannot be determined and false
   *  positives would be catastrophic (would re-publish everything). */
  readonly outboxWriter: OutboxWriter | null;
  /** Profile-resident SENT ledger writer. When `null`, the sweep is
   *  skipped for the same reason as `outboxWriter`. */
  readonly sentLedgerWriter: SentLedgerWriter | null;
  /** Event emitter — invoked once per detected orphan with
   *  `'transfer:orphan-spending-detected'`.
   *
   *  Issue #166 P4 #4 — return type widened to `void | Promise<void>`
   *  so a future async emitter implementation slots in without
   *  becoming an unhandled-rejection source. The sweeper's try/catch
   *  awaits the return value (no-op when sync; safe when async). */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void | Promise<void>;
  /**
   * Steelman item 2 — count of send dispatchers currently in flight.
   * When `> 0`, the sweep self-skips: a token is legitimately in
   * `'transferring'` status WITHOUT yet appearing in OUTBOX during
   * the window between `selectSources` marking it and the
   * orchestrator's `outbox.create` call (which only fires after
   * `commitSources` returns — that can take seconds).
   *
   * Defaults to `0` (no in-flight gate, original Phase 1 behavior).
   * The PaymentsModule wrapper threads its
   * `_dispatcherInFlightCount` field here so the public
   * `detectOrphanSpendingTokens()` API is race-safe against
   * concurrent sends.
   */
  readonly dispatcherInFlightCount?: number;
  /**
   * Issue #166 P2 #1 — optional recovery callback. When provided, the
   * sweeper attempts auto-recovery for each detected orphan via this
   * hook BEFORE emitting the legacy
   * `transfer:orphan-spending-detected` event.
   *
   * The PaymentsModule wires this from `features.orphanAutoRecovery`.
   * When the flag is OFF, this field is undefined and the sweeper
   * preserves Phase-1 detection-only behavior.
   *
   * Contract: see {@link AttemptRecoveryFn}.
   */
  readonly attemptRecovery?: AttemptRecoveryFn;
}

// =============================================================================
// 2. Sweeper
// =============================================================================

/**
 * Run the orphan-spending-tx sweep once and return findings.
 *
 * **Algorithm:**
 *   1. Skip if either writer is `null` — false positives would be
 *      catastrophic (the legacy KV outbox is invisible here, so a
 *      naive scan against legacy-only wallets would re-flag every
 *      in-flight send).
 *   2. Build the union set of tokenIds known to OUTBOX + SENT.
 *   3. For each token with `status === 'transferring'`, check the
 *      union set. Absent → orphan. Emit + log.
 *
 * **Idempotency:** repeated invocations on the same state produce
 * identical findings. The function does NOT mutate any persistent
 * state — it only detects and emits.
 *
 * **Concurrency:** safe to invoke concurrently with sends ONLY when
 * the caller supplies a correct `dispatcherInFlightCount`. The sweep
 * self-skips when that count is non-zero (steelman item 2). Without
 * the gate, the sweep would race against in-flight sends and emit
 * false-positive orphan events for tokens that are legitimately
 * `'transferring'` but have not yet reached the orchestrator's
 * `outbox.create` write.
 *
 * @param deps  See {@link OrphanSweeperDeps}.
 * @returns A {@link OrphanSweepResult} summary.
 */
export async function sweepOrphanSpendingTokens(
  deps: OrphanSweeperDeps,
): Promise<OrphanSweepResult> {
  const { tokens, outboxWriter, sentLedgerWriter, emit } = deps;
  const dispatcherInFlightCount = deps.dispatcherInFlightCount ?? 0;

  // Steelman item 2 — skip when ANY send dispatcher is in flight.
  // Between `selectSources` (which marks tokens `'transferring'`) and
  // the orchestrator's `outbox.create` hook (which only fires after
  // `commitSources` returns — that can take seconds in conservative
  // mode), the token legitimately exists in `'transferring'` status
  // WITHOUT yet appearing in OUTBOX. Sweeping in that window emits
  // false-positive `transfer:orphan-spending-detected` events.
  if (dispatcherInFlightCount > 0) {
    return {
      orphans: [],
      scannedTransferringCount: 0,
      knownTokenIdsCount: 0,
      skipped: true,
      recoveredCount: 0,
      manualCount: 0,
    };
  }

  // Skip when either writer is missing. The "skip silently" choice is
  // deliberate: legacy-only wallets (no profile persistence) cannot
  // distinguish committed-but-not-outboxed from successfully-sent,
  // and a noisy "skip with warning" would alarm every legacy load().
  if (outboxWriter === null || sentLedgerWriter === null) {
    return {
      orphans: [],
      scannedTransferringCount: 0,
      knownTokenIdsCount: 0,
      skipped: true,
      recoveredCount: 0,
      manualCount: 0,
    };
  }

  // Build the union set of tokenIds that are accounted for. Reading
  // from the writers (not the in-memory mirror) ensures the sweeper
  // sees the durable state — the mirror might still be hydrating
  // post-restart.
  const knownTokenIds = new Set<string>();
  try {
    const outboxEntries = await outboxWriter.readAllNew();
    for (const entry of outboxEntries) {
      for (const tid of entry.tokenIds) knownTokenIds.add(tid);
    }
  } catch (err) {
    logger.warn(
      'Payments',
      `sweepOrphanSpendingTokens: failed to read outbox — aborting sweep (false positives would be catastrophic): ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      orphans: [],
      scannedTransferringCount: 0,
      knownTokenIdsCount: 0,
      skipped: true,
      recoveredCount: 0,
      manualCount: 0,
    };
  }
  try {
    const sentEntries = await sentLedgerWriter.readAll();
    for (const entry of sentEntries) {
      for (const tid of entry.tokenIds) knownTokenIds.add(tid);
    }
  } catch (err) {
    logger.warn(
      'Payments',
      `sweepOrphanSpendingTokens: failed to read SENT ledger — aborting sweep (false positives would be catastrophic): ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      orphans: [],
      scannedTransferringCount: 0,
      knownTokenIdsCount: knownTokenIds.size,
      skipped: true,
      recoveredCount: 0,
      manualCount: 0,
    };
  }

  const orphans: OrphanSpendingFinding[] = [];
  let scannedTransferringCount = 0;
  let recoveredCount = 0;
  let manualCount = 0;
  const detectedAt = Date.now();
  const attemptRecovery = deps.attemptRecovery;

  for (const token of tokens) {
    if (token.status !== 'transferring') continue;
    scannedTransferringCount += 1;
    if (knownTokenIds.has(token.id)) continue;

    const finding: OrphanSpendingFinding = {
      tokenId: token.id,
      coinId: token.coinId,
      amount: token.amount,
      lastUpdatedAt: token.updatedAt,
      detectedAt,
    };
    orphans.push(finding);

    // Issue #166 P2 #1 — auto-recovery attempt (when hook supplied).
    // The hook's return value gates which event we emit:
    //  - 'recovered' → `transfer:orphan-recovered`
    //  - 'manual'    → `transfer:orphan-spending-detected` (Phase-1)
    //  - throw       → treated as 'manual' (defense-in-depth);
    //                  the warn-log preserves the failure context.
    let recoveryOutcome: 'recovered' | 'manual' = 'manual';
    if (attemptRecovery !== undefined) {
      try {
        recoveryOutcome = await attemptRecovery(finding);
      } catch (recErr) {
        logger.warn(
          'Payments',
          `sweepOrphanSpendingTokens: attemptRecovery threw for token ${token.id} (treating as manual): ${recErr instanceof Error ? recErr.message : String(recErr)}`,
        );
        recoveryOutcome = 'manual';
      }
    }

    if (recoveryOutcome === 'recovered') {
      recoveredCount += 1;
      logger.debug(
        'Payments',
        `Orphan spending tx auto-recovered: token ${token.id} (coin=${token.coinId} amount=${token.amount}) — status restored by orphanAutoRecovery hook. lastUpdatedAt=${token.updatedAt}.`,
      );
      try {
        await emit('transfer:orphan-recovered', {
          tokenId: token.id,
          coinId: token.coinId,
          amount: token.amount,
          fromStatus: 'transferring',
          toStatus: 'confirmed',
          strategy: 'restore-to-confirmed',
          recoveredAt: detectedAt,
        });
      } catch (emitErr) {
        logger.debug(
          'Payments',
          `sweepOrphanSpendingTokens: emit transfer:orphan-recovered failed for token ${token.id}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        );
      }
      continue;
    }

    // recoveryOutcome === 'manual' (either no hook supplied, hook
    // returned 'manual', or hook threw). Emit the Phase-1 detected
    // event for operator triage.
    manualCount += 1;
    logger.error(
      'Payments',
      `Orphan spending tx detected: token ${token.id} (coin=${token.coinId} amount=${token.amount}) ` +
        `has status='transferring' but is not in OUTBOX or SENT. Crash between commit and outbox-persist. ` +
        `Manual recovery required (auto-recovery hook ${attemptRecovery === undefined ? 'not wired' : "returned 'manual'"}). ` +
        `lastUpdatedAt=${token.updatedAt}.`,
    );

    try {
      // Issue #166 P4 #4 — await the emit return value so future
      // async emitter implementations (returning Promise<void>) don't
      // surface as unhandled-rejection warnings. Sync emitters return
      // `void` which `await` no-ops on. The catch covers both sync
      // throws and async rejections.
      await emit('transfer:orphan-spending-detected', {
        tokenId: token.id,
        detectedAt,
        coinId: token.coinId,
        amount: token.amount,
      });
    } catch (emitErr) {
      // Emit failures must not crash the sweep — the log line above
      // is the load-bearing operator signal.
      logger.debug(
        'Payments',
        `sweepOrphanSpendingTokens: emit failed for token ${token.id}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
      );
    }
  }

  return {
    orphans,
    scannedTransferringCount,
    knownTokenIdsCount: knownTokenIds.size,
    skipped: false,
    recoveredCount,
    manualCount,
  };
}
