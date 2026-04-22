/**
 * CAR-loss tracker (T-C5) — SPEC §10.7, §10.7.1.
 *
 * Persistent-retry ledger that enforces the 24-hour wall-clock discipline
 * required by H7 before `acceptCarLoss()` may advance localVersion past an
 * unfetchable bundle.
 *
 * Scope of this module:
 *   - Persistent ledger: record attempt timestamps per (version, gateway)
 *   - Predicate: `canInvokeAcceptCarLoss(version)` — returns true iff
 *     CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS (=12) attempts have been recorded
 *     across a window ≥ CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS (=24h)
 *   - Clear on success
 *
 * OUT OF SCOPE (delegated to Phase D publish-algorithm):
 *   - Peer-availability poll (gossipsub/Nostr)
 *   - Mandatory republish-before-advance orchestration
 *   - allowOperatorOverrides capability gate
 *   - localVersion advance
 *
 * This module is deliberately small: it owns durable state about retry
 * attempts; higher layers compose it with their own peer-discovery +
 * republish flows to implement the full H7 protocol.
 *
 * Storage layout (per wallet, scoped by FlagStore):
 *   Key = "car_loss_attempts_" + v (decimal)
 *   Value = JSON.stringify({ attempts: Array<{ ts: number, gateway: string }> })
 *
 * Ledger records are bounded: callers MUST not retain more than
 * CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS × 4 entries per version (prunes oldest
 * on write overflow — prevents unbounded storage growth if a caller records
 * attempts more frequently than the 1-hour interval).
 */

import {
  CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS,
  CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import type { FlagStore } from './flag-store.js';
import type { PointerVersion } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CarFetchAttempt {
  /** Wall-clock timestamp (ms since epoch). */
  readonly ts: number;
  /** Gateway that was attempted. Empty string if gateway-agnostic. */
  readonly gateway: string;
}

interface LedgerRecord {
  readonly attempts: CarFetchAttempt[];
}

const MAX_ATTEMPTS_RETAINED = CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS * 4; // 48

// ── Key construction ───────────────────────────────────────────────────────

function attemptsKey(v: PointerVersion): string {
  return `car_loss_attempts_${v}`;
}

// ── Persistence helpers ────────────────────────────────────────────────────

async function readLedger(store: FlagStore, v: PointerVersion): Promise<LedgerRecord> {
  const raw = await store.get(attemptsKey(v));
  if (raw === null) return { attempts: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { attempts?: unknown }).attempts)
    ) {
      const attempts: CarFetchAttempt[] = [];
      for (const entry of (parsed as { attempts: unknown[] }).attempts) {
        if (
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as { ts?: unknown }).ts === 'number' &&
          typeof (entry as { gateway?: unknown }).gateway === 'string'
        ) {
          attempts.push({
            ts: (entry as { ts: number }).ts,
            gateway: (entry as { gateway: string }).gateway,
          });
        }
      }
      return { attempts };
    }
  } catch {
    // Corrupt JSON — treat as empty (non-fatal; CAR loss tracker is best-effort
    // telemetry-like data, not a security interlock).
  }
  return { attempts: [] };
}

async function writeLedger(
  store: FlagStore,
  v: PointerVersion,
  record: LedgerRecord,
): Promise<void> {
  await store.set(attemptsKey(v), JSON.stringify(record));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a failed CAR-fetch attempt for the given version.
 *
 * Attempts are persisted across process restarts — the H7 wall-clock
 * discipline requires durable counting. The ledger is bounded to
 * `MAX_ATTEMPTS_RETAINED` entries per version (oldest pruned first).
 */
export async function recordAttempt(
  store: FlagStore,
  v: PointerVersion,
  gateway: string,
  now: number = Date.now(),
): Promise<void> {
  const ledger = await readLedger(store, v);
  const attempts = [...ledger.attempts, { ts: now, gateway }];
  // Prune oldest if over cap.
  while (attempts.length > MAX_ATTEMPTS_RETAINED) {
    attempts.shift();
  }
  await writeLedger(store, v, { attempts });
}

/**
 * Read all recorded attempts for the given version.
 */
export async function getAttempts(
  store: FlagStore,
  v: PointerVersion,
): Promise<CarFetchAttempt[]> {
  const ledger = await readLedger(store, v);
  return [...ledger.attempts];
}

/**
 * Clear all CAR-loss attempts for the given version.
 *
 * Call this after a successful fetch, OR after acceptCarLoss completes
 * (republish + advance). Leaving stale entries causes the next version to
 * inherit attempt counts, which would prematurely satisfy the H7 gate.
 */
export async function clearAttempts(store: FlagStore, v: PointerVersion): Promise<void> {
  await store.remove(attemptsKey(v));
}

/** Result of the H7 gate check. Carries diagnostic context for UI / telemetry. */
export interface AcceptCarLossGate {
  /** True iff enough attempts + wall-clock have elapsed to invoke acceptCarLoss. */
  readonly eligible: boolean;
  /** How many attempts have been recorded so far. */
  readonly attemptCount: number;
  /** Wall-clock ms elapsed between the earliest and latest attempt. */
  readonly elapsedMs: number;
  /** How many more attempts are required (0 if eligible). */
  readonly attemptsRemaining: number;
  /** How much more wall-clock is required (0 if eligible). */
  readonly msRemaining: number;
}

/**
 * Return whether the H7 persistent-retry gate is satisfied for this version.
 *
 * Requires BOTH:
 *   - `attemptCount >= CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS` (12)
 *   - `maxTs - minTs >= CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS` (24h)
 *
 * An attacker with control of the local clock can falsify wall-clock
 * elapsed, so this gate is NOT a security interlock — it is a conservative
 * UX throttle ensuring that naïve users can't accidentally accept CAR loss
 * during a brief gateway outage.
 */
export async function canInvokeAcceptCarLoss(
  store: FlagStore,
  v: PointerVersion,
  now: number = Date.now(),
): Promise<AcceptCarLossGate> {
  const ledger = await readLedger(store, v);
  const attempts = ledger.attempts;
  const attemptCount = attempts.length;

  let minTs = now;
  let maxTs = now;
  if (attemptCount > 0) {
    minTs = attempts[0]!.ts;
    maxTs = attempts[0]!.ts;
    for (const { ts } of attempts) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    // Include `now` in the span check — the caller may be checking before
    // recording the final attempt. Using max(now, maxTs) errs on eligibility.
    if (now > maxTs) maxTs = now;
  }
  const elapsedMs = attemptCount === 0 ? 0 : maxTs - minTs;

  const attemptsRemaining = Math.max(0, CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS - attemptCount);
  const msRemaining = Math.max(0, CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS - elapsedMs);
  const eligible = attemptsRemaining === 0 && msRemaining === 0;

  return { eligible, attemptCount, elapsedMs, attemptsRemaining, msRemaining };
}

/**
 * Assert-eligible helper: throws UNREACHABLE_RECOVERY_BLOCKED when the gate
 * is not yet satisfied. Convenient shorthand for callers implementing the
 * full H7 protocol.
 *
 * @throws AggregatorPointerError(UNREACHABLE_RECOVERY_BLOCKED) if ineligible.
 */
export async function assertAcceptCarLossEligible(
  store: FlagStore,
  v: PointerVersion,
  now: number = Date.now(),
): Promise<void> {
  const gate = await canInvokeAcceptCarLoss(store, v, now);
  if (!gate.eligible) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.UNREACHABLE_RECOVERY_BLOCKED,
      `acceptCarLoss(v=${v}) gate not yet satisfied: ${gate.attemptsRemaining} more ` +
        `attempt(s) needed and ${gate.msRemaining}ms more wall-clock required ` +
        `(SPEC §10.7.1 H7).`,
      {
        v,
        attemptCount: gate.attemptCount,
        elapsedMs: gate.elapsedMs,
        attemptsRemaining: gate.attemptsRemaining,
        msRemaining: gate.msRemaining,
      },
    );
  }
}
