/**
 * UXF Transfer — shared polling policy (§5.5 step 6, T.5.B.0).
 *
 * The sender-side finalization worker (T.5.B) and the recipient-side
 * finalization worker (T.5.C) BOTH poll the aggregator until a
 * commitment is anchored or a terminal status is reached. The protocol
 * mandates IDENTICAL polling semantics for both — same backoff
 * schedule, same window, same hard safety net. This module is the
 * single source of truth so the two workers cannot drift.
 *
 * **Side-effect freedom guarantee.** Importing this module MUST NOT
 * register handlers, open sockets, mutate global state, log to console,
 * read environment variables, or otherwise produce observable behavior.
 * Every export is a pure function or a re-exported `const`. The
 * companion test pins this invariant.
 *
 * Spec references:
 *  - §5.5 step 6 — polling-window terminal, validity rule, 2× safety net.
 *
 * Imports its three knobs from `limits.ts` (the canonical home for
 * cross-module caps). No knob is duplicated here — this file's job is
 * to express the **policy** that operates on those knobs.
 *
 * @packageDocumentation
 */

import {
  POLLING_WINDOW_MS,
  MIN_POLL_ATTEMPTS,
  BACKOFF_SCHEDULE_MS,
} from './limits';

// Re-export the constants so consumers can `import { ... } from
// './polling-policy'` without also importing './limits' — they're the
// "policy surface" expressed as a single module per the impl plan.
export { POLLING_WINDOW_MS, MIN_POLL_ATTEMPTS, BACKOFF_SCHEDULE_MS };

// =============================================================================
// 1. Validity rule
// =============================================================================

/**
 * Result of {@link validatePollingPolicy}. Always returns the computed
 * cumulative backoff so callers can include it in telemetry / startup
 * logs even on the success path.
 */
export interface ValidatePollingPolicyResult {
  /** True iff the cumulative backoff fits inside the polling window. */
  readonly valid: boolean;
  /**
   * Sum of the first `MIN_POLL_ATTEMPTS` entries of `BACKOFF_SCHEDULE_MS`.
   * Always populated, regardless of `valid`.
   */
  readonly cumulativeBackoffMs: number;
  /**
   * Discriminator for the failure case. `undefined` when `valid === true`.
   */
  readonly reason?: 'cumulative-backoff-exceeds-window';
}

/**
 * Validate the polling-policy configuration per §5.5 step 6's
 * configuration-validity rule:
 *
 *   sum(BACKOFF_SCHEDULE_MS[0..MIN_POLL_ATTEMPTS-1]) ≤ POLLING_WINDOW_MS
 *
 * The protocol mandates implementations refuse to start if this rule is
 * violated — otherwise a finalization-worker could be configured to
 * back off so aggressively that the deadline fires before
 * `MIN_POLL_ATTEMPTS` is satisfied, deferring termination to the 2×
 * hard safety net for every queue entry.
 *
 * If the schedule is shorter than `MIN_POLL_ATTEMPTS`, the missing
 * entries are filled by repeating the last schedule entry (matching
 * `getBackoffMs`'s tail-clamp semantics) so the sum reflects the
 * actual backoff the worker would observe.
 *
 * Pure function. Idempotent. No side effects.
 *
 * @returns `{ valid, cumulativeBackoffMs, reason? }`. On the success
 *   path, `reason` is omitted.
 */
export function validatePollingPolicy(): ValidatePollingPolicyResult {
  const lastEntry =
    BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1] ?? 0;

  let cumulativeBackoffMs = 0;
  for (let i = 0; i < MIN_POLL_ATTEMPTS; i++) {
    cumulativeBackoffMs += BACKOFF_SCHEDULE_MS[i] ?? lastEntry;
  }

  if (cumulativeBackoffMs > POLLING_WINDOW_MS) {
    return {
      valid: false,
      cumulativeBackoffMs,
      reason: 'cumulative-backoff-exceeds-window',
    };
  }
  return { valid: true, cumulativeBackoffMs };
}

// =============================================================================
// 2. Backoff lookup
// =============================================================================

/**
 * Backoff for the `attemptIndex`-th poll (0-indexed). Indices beyond
 * the schedule's length cap at the last entry — matches §5.5 step 6's
 * "30s, 60s, 120s, 240s, then every 5 min until deadline" wording.
 *
 * Negative or non-integer inputs are clamped to index 0 (defensive
 * against caller-side off-by-one or float arithmetic). NaN yields the
 * first entry. Fractional inputs are floored before lookup.
 *
 * Pure function. No side effects.
 *
 * @param attemptIndex Zero-based attempt counter.
 * @returns Backoff in ms.
 */
export function getBackoffMs(attemptIndex: number): number {
  const len = BACKOFF_SCHEDULE_MS.length;
  if (len === 0) {
    // Defensive: schedule should never be empty, but if it ever is,
    // return 0 rather than throwing — the caller's loop will simply
    // poll without backoff (and `validatePollingPolicy` already caught
    // a misconfiguration upstream).
    return 0;
  }
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) {
    return BACKOFF_SCHEDULE_MS[0];
  }
  const i = Math.floor(attemptIndex);
  if (i >= len) {
    return BACKOFF_SCHEDULE_MS[len - 1];
  }
  return BACKOFF_SCHEDULE_MS[i];
}

// =============================================================================
// 3. Polling-window termination check
// =============================================================================

/**
 * Discriminator for {@link IsPollingTimedOutResult.reason}.
 *
 *  - `'continue'`                      — keep polling.
 *  - `'attempts-met-and-window-exceeded'` — §5.5 step 6's normal
 *      termination: `MIN_POLL_ATTEMPTS` satisfied AND
 *      `now - startedAt >= POLLING_WINDOW_MS`.
 *  - `'safety-net-fired'`              — §5.5 step 6's hard safety net:
 *      `now - startedAt >= 2 * POLLING_WINDOW_MS`, regardless of
 *      attempts — guarantees termination.
 *  - `'window-exceeded'`               — RESERVED for future variants
 *      where the deadline alone (without attempts) terminates. Not
 *      currently emitted by this implementation; declared so the union
 *      remains stable when alternative termination policies are added.
 */
export type PollingTimedOutReason =
  | 'continue'
  | 'attempts-met-and-window-exceeded'
  | 'safety-net-fired'
  | 'window-exceeded';

/** Result of {@link isPollingTimedOut}. */
export interface IsPollingTimedOutResult {
  /** True iff polling SHOULD stop now. */
  readonly timedOut: boolean;
  /** Why polling should (or shouldn't) stop. See {@link PollingTimedOutReason}. */
  readonly reason: PollingTimedOutReason;
}

/**
 * Decide whether a polling loop should terminate per §5.5 step 6.
 *
 * Two termination conditions, evaluated in priority order:
 *
 *  1. **Hard safety net (W26)** — if `(now - startedAt) >=
 *     2 * POLLING_WINDOW_MS`, terminate regardless of attempts. The
 *     protocol mandates: *"As a hard safety net regardless of
 *     configuration, the worker SHALL also stop after 2 ×
 *     POLLING_WINDOW wall-clock time, declaring `oracle-rejected` even
 *     if MIN_POLL_ATTEMPTS was not reached — termination is
 *     guaranteed."* Default firing time: **60 minutes**.
 *
 *  2. **Normal termination** — `attempts >= MIN_POLL_ATTEMPTS` AND
 *     `(now - startedAt) >= POLLING_WINDOW_MS`. Both conditions are
 *     necessary; either alone keeps polling.
 *
 * Pure function. No side effects. The clock is dependency-injected via
 * the `now` parameter so callers can run deterministic-clock fault
 * injection in tests.
 *
 * **Edge cases**:
 *  - `now < startedAt` (negative elapsed) — treated as `elapsed = 0`;
 *    never timed out. Defensive against caller clock drift; does not
 *    swallow a genuine zero-duration poll budget (callers using a
 *    finite POLLING_WINDOW_MS will eventually exit normally).
 *  - `attempts < 0` — coerced to `0` for the comparison; no early
 *    termination.
 *  - `attempts === MIN_POLL_ATTEMPTS` exactly AND elapsed exactly
 *    equals `POLLING_WINDOW_MS` — terminates (`>=` semantics).
 *
 * @param startedAt Wall-clock ms timestamp of the most-recent successful
 *                  submit (NOT the queue-entry `createdAt` — see §5.5
 *                  step 6 rationale).
 * @param now       Current wall-clock ms timestamp. Caller-supplied so
 *                  unit tests can advance time deterministically.
 * @param attempts  Count of polls that returned a verifiable
 *                  proof-status. Transient errors do NOT count.
 * @returns `{ timedOut, reason }`.
 */
export function isPollingTimedOut(
  startedAt: number,
  now: number,
  attempts: number,
): IsPollingTimedOutResult {
  const windowMs = POLLING_WINDOW_MS;
  const safetyNetMs = 2 * windowMs;

  // Defensive: coerce non-finite or negative elapsed to 0 so we never
  // declare timeout based on garbage inputs.
  const elapsedRaw = now - startedAt;
  const elapsed = Number.isFinite(elapsedRaw) && elapsedRaw > 0 ? elapsedRaw : 0;
  const attemptsClamped =
    Number.isFinite(attempts) && attempts > 0 ? attempts : 0;

  // (1) Hard safety net — fires regardless of attempts.
  if (elapsed >= safetyNetMs) {
    return { timedOut: true, reason: 'safety-net-fired' };
  }

  // (2) Normal termination — both conditions required.
  if (attemptsClamped >= MIN_POLL_ATTEMPTS && elapsed >= windowMs) {
    return { timedOut: true, reason: 'attempts-met-and-window-exceeded' };
  }

  return { timedOut: false, reason: 'continue' };
}
