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
// 0. Wave 3 steelman fix — clock-skew defense
// =============================================================================

/**
 * Hard ceiling on the number of poll attempts a single queue entry
 * may accumulate, regardless of wall-clock readings. Acts as a
 * **secondary safety net** alongside the W26 2× wall-clock ceiling so
 * that a backwards-stepping or stalled wall-clock cannot prevent
 * termination. Both safety nets must fail simultaneously for polling
 * to continue indefinitely.
 *
 * Sizing rationale: with the spec defaults (BACKOFF tail-clamps at
 * 300s after 5 entries) reaching 60 minutes (W26's safety net) takes
 * ~12-14 honest attempts. We pick **200** to give a comfortable
 * 14× margin over the natural attempt count — far enough that a
 * legitimate slow aggregator never trips it, but small enough that a
 * pathological clock-skew loop terminates within minutes of CPU work.
 *
 * The constant is exported so production wiring and tests can both
 * reference the canonical value. See {@link isPollingTimedOut}.
 */
export const MAX_POLL_ATTEMPTS_HARD_CEILING = 200;

/**
 * Monotonic-clock helper. Returns `performance.now()` (a high-
 * resolution monotonic clock unaffected by wall-clock adjustments such
 * as NTP backwards-steps, host suspend/resume, or container clock
 * drift) when available, falling back to `Date.now()` only on
 * environments that lack `performance` (very old runtimes / non-
 * standard sandboxes).
 *
 * **Why callers SHOULD use this**: `Date.now()` deltas are unsafe for
 * timeout enforcement under any scenario where the OS clock can move
 * backwards or pause:
 *   - NTP correction stepping backwards by minutes;
 *   - Host suspend/resume losing wall-clock progress;
 *   - Containers booted from a snapshotted image where the clock
 *     hasn't yet been re-synced.
 * Each of these can make `now - startedAt` negative, freezing the
 * elapsed counter at 0 (per the defensive coercion in
 * {@link isPollingTimedOut}) and letting the worker poll past the W26
 * hard safety net indefinitely. `performance.now()` is monotonic by
 * specification — it never moves backwards.
 *
 * Pure read; no side effects.
 *
 * @returns A monotonic-millisecond timestamp suitable for elapsed-time
 *          subtraction. Compare ONLY against values from the same
 *          source (do not mix `getMonotonicNowMs()` and `Date.now()`
 *          in the same calculation — their epochs are incomparable).
 */
export function getMonotonicNowMs(): number {
  // Defensive `typeof` check — Node 16+ and all modern browsers
  // provide `performance` globally, but we MUST NOT crash if a
  // non-standard sandbox lacks it. Falling back to `Date.now()`
  // restores the previous (skew-vulnerable) behavior gracefully; the
  // attempt-count secondary safety net still bounds termination.
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

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
 * **Steelman fix (warning 6b)**: applies ±15% multiplicative jitter
 * via `floor(base * (0.85 + Math.random() * 0.30))`. Pre-fix the
 * backoff was deterministic — N concurrent finalization workers all
 * waking on the SAME 30s/60s/120s schedule synchronously hammer the
 * aggregator with periodic poll bursts. Jitter de-syncs the wake
 * times across workers, smoothing aggregator load and cutting tail
 * latency under contention. The ±15% bound preserves the "feel" of
 * the schedule (still close to 30s/60s/etc.) while delivering
 * meaningful spread.
 *
 * Pure function modulo `Math.random()`. No other side effects. Tests
 * that need deterministic timing should stub `Math.random` (e.g.
 * `vi.spyOn(Math, 'random').mockReturnValue(0.5)`).
 *
 * @param attemptIndex Zero-based attempt counter.
 * @returns Jittered backoff in ms.
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
  let base: number;
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) {
    base = BACKOFF_SCHEDULE_MS[0];
  } else {
    const i = Math.floor(attemptIndex);
    base = i >= len ? BACKOFF_SCHEDULE_MS[len - 1] : BACKOFF_SCHEDULE_MS[i];
  }
  // Apply ±15% jitter to de-sync concurrent workers.
  return Math.floor(base * (0.85 + Math.random() * 0.30));
}

// =============================================================================
// 2.1. Submit-retry backoff (separate fast schedule)
// =============================================================================

/**
 * Submit-retry backoff schedule (ms). Distinct from the polling-loop
 * schedule — submit retries should be FAST (transient network blips
 * resolve quickly), not slow like a polling-deadline schedule.
 *
 * Schedule: 500ms / 1s / 2s / 4s / 8s, tail-clamped at 8s. With the
 * default `MAX_SUBMIT_RETRIES=5` budget the worker spends at most
 * 500ms+1s+2s+4s = 7.5s on retries (the 5th attempt has no follow-up
 * sleep). Pre-fix submit retries reused `getBackoffMs` (the polling
 * schedule starting at 30s) — exhausting MAX_SUBMIT_RETRIES took
 * ~30+60+120+240 ≈ 7.5 minutes, way too slow for a transient submit
 * failure.
 *
 * @internal
 */
export const SUBMIT_RETRY_BACKOFF_MS: ReadonlyArray<number> = [
  500, 1_000, 2_000, 4_000, 8_000,
];

/**
 * Submit-retry backoff for the `attemptIndex`-th retry (0-indexed).
 * See {@link SUBMIT_RETRY_BACKOFF_MS} for the schedule.
 *
 * Applies the same ±15% jitter as {@link getBackoffMs}.
 *
 * Steelman fix (warning 6c): pre-fix the submit-retry path reused
 * {@link getBackoffMs} (the 30s+ polling schedule). Submit retries
 * are network-blip recovery, NOT polling — they should be sub-10s.
 *
 * @internal
 */
export function getSubmitRetryBackoffMs(attemptIndex: number): number {
  const len = SUBMIT_RETRY_BACKOFF_MS.length;
  if (len === 0) return 0;
  let base: number;
  if (!Number.isFinite(attemptIndex) || attemptIndex < 0) {
    base = SUBMIT_RETRY_BACKOFF_MS[0];
  } else {
    const i = Math.floor(attemptIndex);
    base = i >= len ? SUBMIT_RETRY_BACKOFF_MS[len - 1] : SUBMIT_RETRY_BACKOFF_MS[i];
  }
  return Math.floor(base * (0.85 + Math.random() * 0.30));
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
 *  - `'attempt-ceiling-fired'`         — Wave 3 steelman secondary
 *      safety net: `attempts >= MAX_POLL_ATTEMPTS_HARD_CEILING`,
 *      regardless of wall-clock. Defends against backwards-step /
 *      stalled wall-clock scenarios (NTP correction, host suspend/
 *      resume, container clock drift) where the elapsed coercion to 0
 *      would otherwise let polling run indefinitely.
 *  - `'window-exceeded'`               — RESERVED for future variants
 *      where the deadline alone (without attempts) terminates. Not
 *      currently emitted by this implementation; declared so the union
 *      remains stable when alternative termination policies are added.
 */
export type PollingTimedOutReason =
  | 'continue'
  | 'attempts-met-and-window-exceeded'
  | 'safety-net-fired'
  | 'attempt-ceiling-fired'
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
 * Three termination conditions, evaluated in priority order:
 *
 *  1. **Attempt-count ceiling (Wave 3 steelman secondary safety net)**
 *     — if `attempts >= MAX_POLL_ATTEMPTS_HARD_CEILING`, terminate
 *     regardless of wall-clock. This safety net is independent of the
 *     clock entirely, so a wall-clock that's been NTP-corrected
 *     backwards, paused by suspend/resume, or otherwise stalled cannot
 *     prevent termination. Both this AND the W26 wall-clock safety net
 *     would have to fail simultaneously (i.e., the worker polls fewer
 *     than `MAX_POLL_ATTEMPTS_HARD_CEILING` times AND the wall-clock
 *     reads less than 2× the window) to allow indefinite polling.
 *     Evaluated FIRST so it short-circuits any clock-derived path.
 *
 *  2. **Hard wall-clock safety net (W26)** — if `(now - startedAt) >=
 *     2 * POLLING_WINDOW_MS`, terminate regardless of attempts. The
 *     protocol mandates: *"As a hard safety net regardless of
 *     configuration, the worker SHALL also stop after 2 ×
 *     POLLING_WINDOW wall-clock time, declaring `oracle-rejected` even
 *     if MIN_POLL_ATTEMPTS was not reached — termination is
 *     guaranteed."* Default firing time: **60 minutes**.
 *
 *  3. **Normal termination** — `attempts >= MIN_POLL_ATTEMPTS` AND
 *     `(now - startedAt) >= POLLING_WINDOW_MS`. Both conditions are
 *     necessary; either alone keeps polling.
 *
 * Pure function. No side effects. The clock is dependency-injected via
 * the `now` parameter so callers can run deterministic-clock fault
 * injection in tests. Callers SHOULD pass a monotonic-clock value via
 * {@link getMonotonicNowMs} to defeat wall-clock skew at the source —
 * the attempt-count ceiling is a backstop, not a substitute.
 *
 * **Edge cases**:
 *  - `now < startedAt` (negative elapsed) — treated as `elapsed = 0`;
 *    the wall-clock branches never declare timeout. The attempt-count
 *    ceiling will eventually terminate the poll loop independently.
 *  - `attempts < 0` — coerced to `0` for the comparison; no early
 *    termination.
 *  - `attempts === MIN_POLL_ATTEMPTS` exactly AND elapsed exactly
 *    equals `POLLING_WINDOW_MS` — terminates (`>=` semantics).
 *  - `attempts === MAX_POLL_ATTEMPTS_HARD_CEILING` exactly — terminates
 *    via the attempt-count ceiling (`>=` semantics).
 *
 * @param startedAt Timestamp (preferably monotonic — see
 *                  {@link getMonotonicNowMs}) of the most-recent
 *                  successful submit (NOT the queue-entry `createdAt`
 *                  — see §5.5 step 6 rationale).
 * @param now       Current timestamp. Caller-supplied so unit tests
 *                  can advance time deterministically. SHOULD come
 *                  from the same clock source as `startedAt`.
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

  // (1) Wave 3 steelman secondary safety net — fires from attempt
  // count alone, independent of any clock reading. Evaluated first so
  // a backwards-stepping or stalled wall-clock cannot defer this
  // termination. Termination is guaranteed if EITHER this OR the wall-
  // clock safety net fires; both must remain unfired indefinitely for
  // the poll loop to run forever.
  if (attemptsClamped >= MAX_POLL_ATTEMPTS_HARD_CEILING) {
    return { timedOut: true, reason: 'attempt-ceiling-fired' };
  }

  // (2) Hard wall-clock safety net — fires regardless of attempts.
  if (elapsed >= safetyNetMs) {
    return { timedOut: true, reason: 'safety-net-fired' };
  }

  // (3) Normal termination — both conditions required.
  if (attemptsClamped >= MIN_POLL_ATTEMPTS && elapsed >= windowMs) {
    return { timedOut: true, reason: 'attempts-met-and-window-exceeded' };
  }

  return { timedOut: false, reason: 'continue' };
}
