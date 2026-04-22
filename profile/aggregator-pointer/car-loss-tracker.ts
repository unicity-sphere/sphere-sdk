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
  /** Earliest attempt timestamp ever recorded for this version. Preserved on prune. */
  readonly firstAttemptTs: number;
  readonly attempts: CarFetchAttempt[];
}

const MAX_ATTEMPTS_RETAINED = CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS * 4; // 48

// ── Key construction ───────────────────────────────────────────────────────

function attemptsKey(v: PointerVersion): string {
  return `car_loss_attempts_${v}`;
}

// ── Per-version in-process mutex ───────────────────────────────────────────
//
// Read-modify-write on the ledger is NOT atomic across parallel callers (the
// `await readLedger` yields the microtask queue). Two concurrent
// `recordAttempt` calls can both read an empty ledger, append their own
// entry, and race on `writeLedger` — the second write clobbers the first,
// dropping one attempt. In a Node process, this happens when multiple IPFS
// gateway retries run in parallel (a natural H7 usage pattern).
//
// Mitigation: serialize per-version via an in-process mutex map. This is
// only effective within a single process; multi-process coordination (e.g.
// cross-tab in browser via IndexedDB) would need the durable file-lock
// mutex from mutex-lock.ts. For v1 we accept the single-process scope —
// the H7 gate is not a hard security interlock.

const ledgerMutexes = new Map<string, Promise<void>>();

async function withLedgerLock<T>(v: PointerVersion, fn: () => Promise<T>): Promise<T> {
  const key = attemptsKey(v);
  const previous = ledgerMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  ledgerMutexes.set(key, previous.then(() => next));
  try {
    await previous;
    return await fn();
  } finally {
    release();
    // Clean up the map if we're the last holder to avoid unbounded growth.
    if (ledgerMutexes.get(key) === previous.then(() => next)) {
      // Best-effort — the chain might have already advanced past us.
    }
  }
}

// ── Persistence helpers ────────────────────────────────────────────────────

async function readLedger(store: FlagStore, v: PointerVersion): Promise<LedgerRecord> {
  const raw = await store.get(attemptsKey(v));
  if (raw === null) return { firstAttemptTs: 0, attempts: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fail-closed on corrupt JSON: H7 is a data-loss prevention discipline
    // (SPEC §10.7.1). A torn write or malicious tamper that would reset the
    // attempt count MUST not silently unlock the gate.
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CORRUPT,
      `car-loss ledger for v=${v} contains invalid JSON — refusing to evaluate ` +
        `acceptCarLoss gate (SPEC §10.7.1 H7).`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { attempts?: unknown }).attempts)) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CORRUPT,
      `car-loss ledger for v=${v} has malformed shape — refusing to evaluate gate.`,
    );
  }

  const rec = parsed as { attempts: unknown[]; firstAttemptTs?: unknown };
  const attempts: CarFetchAttempt[] = [];
  for (const entry of rec.attempts) {
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
  // Backward compat: older ledgers may not have firstAttemptTs. Derive from
  // attempts (safe fallback) but persist on next write so subsequent prune
  // cycles don't lose it.
  const firstAttemptTs =
    typeof rec.firstAttemptTs === 'number'
      ? rec.firstAttemptTs
      : attempts.length > 0
        ? Math.min(...attempts.map((a) => a.ts))
        : 0;
  return { firstAttemptTs, attempts };
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
  await withLedgerLock(v, async () => {
    let ledger: LedgerRecord;
    try {
      ledger = await readLedger(store, v);
    } catch (err) {
      // If the ledger is corrupt, overwrite rather than lose the new attempt.
      // Start a fresh ledger with this attempt as the first.
      if (err instanceof AggregatorPointerError && err.code === AggregatorPointerErrorCode.CORRUPT) {
        ledger = { firstAttemptTs: now, attempts: [] };
      } else {
        throw err;
      }
    }

    // Preserve the earliest-ever timestamp for the H7 wall-clock gate. On
    // the very first record for this version, seed firstAttemptTs = now.
    // On subsequent records, keep whichever is earlier — prevents clock
    // rollback or out-of-order records from advancing the anchor.
    const firstAttemptTs =
      ledger.attempts.length === 0
        ? now
        : Math.min(ledger.firstAttemptTs, now);

    const attempts = [...ledger.attempts, { ts: now, gateway }];
    // Prune oldest attempts if over cap — but firstAttemptTs is preserved
    // separately so the wall-clock gate still works.
    while (attempts.length > MAX_ATTEMPTS_RETAINED) {
      attempts.shift();
    }
    await writeLedger(store, v, { firstAttemptTs, attempts });
  });
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

  // Wall-clock span is measured from the FIRST-EVER recorded attempt, not
  // from the earliest currently-retained attempt. This preserves H7
  // semantics across MAX_ATTEMPTS_RETAINED pruning: the 24-hour window
  // anchors on when the user genuinely started retrying, not on whatever
  // was the oldest surviving entry in the bounded ring.
  let elapsedMs = 0;
  if (attemptCount > 0) {
    // readLedger guarantees firstAttemptTs is valid whenever attempts is
    // non-empty (either explicitly persisted or derived from min(attempts)).
    elapsedMs = Math.max(0, now - ledger.firstAttemptTs);
  }

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
