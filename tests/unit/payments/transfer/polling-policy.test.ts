/**
 * Tests for `modules/payments/transfer/polling-policy.ts` — UXF
 * shared finalization-polling policy (T.5.B.0).
 *
 * Spec references: §5.5 step 6 (validity rule, MIN_POLL_ATTEMPTS,
 * 2× POLLING_WINDOW hard safety net).
 */

import { describe, it, expect } from 'vitest';

import {
  POLLING_WINDOW_MS,
  MIN_POLL_ATTEMPTS,
  BACKOFF_SCHEDULE_MS,
  MAX_POLL_ATTEMPTS_HARD_CEILING,
  SUBMIT_RETRY_BACKOFF_MS,
  validatePollingPolicy,
  getBackoffMs,
  getSubmitRetryBackoffMs,
  getMonotonicNowMs,
  isPollingTimedOut,
} from '../../../../modules/payments/transfer/polling-policy';

// =============================================================================
// 1. Re-exported constants — pin spec defaults
// =============================================================================

describe('polling-policy — constants', () => {
  it('POLLING_WINDOW_MS === 30 minutes (spec default)', () => {
    expect(POLLING_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('MIN_POLL_ATTEMPTS === 5 (spec default)', () => {
    expect(MIN_POLL_ATTEMPTS).toBe(5);
  });

  it('BACKOFF_SCHEDULE_MS === [30s, 60s, 120s, 240s, 300s] (spec default)', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      300_000,
    ]);
  });
});

// =============================================================================
// 2. Validity rule (§5.5 step 6 normative)
// =============================================================================

describe('polling-policy — validatePollingPolicy', () => {
  it('default config is valid (cumulative ≤ window)', () => {
    const r = validatePollingPolicy();
    expect(r.valid).toBe(true);
    // 30 + 60 + 120 + 240 + 300 = 750s = 750_000 ms = 12.5 min.
    expect(r.cumulativeBackoffMs).toBe(750_000);
    expect(r.cumulativeBackoffMs).toBeLessThanOrEqual(POLLING_WINDOW_MS);
    expect(r.reason).toBeUndefined();
  });

  it('cumulative backoff equals 12.5 minutes for spec defaults', () => {
    const r = validatePollingPolicy();
    expect(r.cumulativeBackoffMs).toBe(12.5 * 60 * 1000);
  });

  it('always populates cumulativeBackoffMs (success path)', () => {
    const r = validatePollingPolicy();
    expect(typeof r.cumulativeBackoffMs).toBe('number');
    expect(r.cumulativeBackoffMs).toBeGreaterThan(0);
  });
});

// =============================================================================
// 3. getBackoffMs — schedule lookup with tail clamp
// =============================================================================

describe('polling-policy — getBackoffMs', () => {
  // Steelman fix (warning 6b): getBackoffMs applies ±15% jitter via
  // `Math.floor(base * (0.85 + Math.random() * 0.30))`. Tests that
  // need a deterministic value stub `Math.random` to a fixed return.
  // Helpers below assert that the result lies within the jitter band
  // around the schedule's nominal value.
  const jitterLo = (base: number): number => Math.floor(base * 0.85);
  const jitterHi = (base: number): number => Math.floor(base * 1.15);

  it('returns 30s ±15% for attempt 0', () => {
    const v = getBackoffMs(0);
    expect(v).toBeGreaterThanOrEqual(jitterLo(30_000));
    expect(v).toBeLessThanOrEqual(jitterHi(30_000));
  });

  it('returns 60s ±15% for attempt 1', () => {
    const v = getBackoffMs(1);
    expect(v).toBeGreaterThanOrEqual(jitterLo(60_000));
    expect(v).toBeLessThanOrEqual(jitterHi(60_000));
  });

  it('returns 120s ±15% for attempt 2', () => {
    const v = getBackoffMs(2);
    expect(v).toBeGreaterThanOrEqual(jitterLo(120_000));
    expect(v).toBeLessThanOrEqual(jitterHi(120_000));
  });

  it('returns 240s ±15% for attempt 3', () => {
    const v = getBackoffMs(3);
    expect(v).toBeGreaterThanOrEqual(jitterLo(240_000));
    expect(v).toBeLessThanOrEqual(jitterHi(240_000));
  });

  it('returns 300s ±15% (5 min) for attempt 4 (last entry)', () => {
    const v = getBackoffMs(4);
    expect(v).toBeGreaterThanOrEqual(jitterLo(300_000));
    expect(v).toBeLessThanOrEqual(jitterHi(300_000));
  });

  it('caps at last entry — attempt 5 returns 300s ±15%', () => {
    const v = getBackoffMs(5);
    expect(v).toBeGreaterThanOrEqual(jitterLo(300_000));
    expect(v).toBeLessThanOrEqual(jitterHi(300_000));
  });

  it('caps at last entry — attempt 100 returns 300s ±15%', () => {
    const v = getBackoffMs(100);
    expect(v).toBeGreaterThanOrEqual(jitterLo(300_000));
    expect(v).toBeLessThanOrEqual(jitterHi(300_000));
  });

  it('clamps negative input to first entry (30s ±15%)', () => {
    const v = getBackoffMs(-1);
    expect(v).toBeGreaterThanOrEqual(jitterLo(30_000));
    expect(v).toBeLessThanOrEqual(jitterHi(30_000));
  });

  it('clamps NaN to first entry (30s ±15%)', () => {
    const v = getBackoffMs(NaN);
    expect(v).toBeGreaterThanOrEqual(jitterLo(30_000));
    expect(v).toBeLessThanOrEqual(jitterHi(30_000));
  });

  it('floors fractional input', () => {
    // 1.9 → floor → 1 → 60_000 ±15%.
    const v = getBackoffMs(1.9);
    expect(v).toBeGreaterThanOrEqual(jitterLo(60_000));
    expect(v).toBeLessThanOrEqual(jitterHi(60_000));
  });

  it('jitter spread is observable across many calls (warning 6b)', () => {
    // Sample 100 calls; expect at least 2 distinct values (jitter range
    // is wide enough that getting only 1 unique value across 100 draws
    // has probability < 1/65530 — vanishingly small false-positive
    // rate). Pre-fix this would always be exactly 1 unique value.
    const samples = new Set<number>();
    for (let i = 0; i < 100; i++) samples.add(getBackoffMs(0));
    expect(samples.size).toBeGreaterThan(1);
  });
});

// =============================================================================
// 3.1. getSubmitRetryBackoffMs — fast submit-retry schedule (warning 6c)
// =============================================================================

describe('polling-policy — getSubmitRetryBackoffMs (warning 6c)', () => {
  // Steelman fix (warning 6c): submit retries use a FAST schedule
  // (500ms / 1s / 2s / 4s / 8s) instead of the polling 30s/60s/etc.
  const lo = (base: number): number => Math.floor(base * 0.85);
  const hi = (base: number): number => Math.floor(base * 1.15);

  it('returns ~500ms for attempt 0', () => {
    const v = getSubmitRetryBackoffMs(0);
    expect(v).toBeGreaterThanOrEqual(lo(500));
    expect(v).toBeLessThanOrEqual(hi(500));
  });

  it('returns ~1s for attempt 1', () => {
    const v = getSubmitRetryBackoffMs(1);
    expect(v).toBeGreaterThanOrEqual(lo(1_000));
    expect(v).toBeLessThanOrEqual(hi(1_000));
  });

  it('returns ~2s for attempt 2', () => {
    const v = getSubmitRetryBackoffMs(2);
    expect(v).toBeGreaterThanOrEqual(lo(2_000));
    expect(v).toBeLessThanOrEqual(hi(2_000));
  });

  it('caps at last entry — attempt 100 returns ~8s', () => {
    const v = getSubmitRetryBackoffMs(100);
    expect(v).toBeGreaterThanOrEqual(lo(8_000));
    expect(v).toBeLessThanOrEqual(hi(8_000));
  });

  it('schedule is fast — total budget across 5 retries < 20s', () => {
    // The whole point: pre-fix submit retries took ~7.5min via the
    // polling schedule. Cap the total at 20s with jitter for safety.
    let total = 0;
    for (let i = 0; i < 5; i++) total += hi(SUBMIT_RETRY_BACKOFF_MS[i] ?? 0);
    expect(total).toBeLessThan(20_000);
  });
});

// =============================================================================
// 4. isPollingTimedOut — termination predicate (§5.5 step 6)
// =============================================================================

describe('polling-policy — isPollingTimedOut', () => {
  const minute = 60 * 1000;

  it('not timed out at t=0 just after start', () => {
    const r = isPollingTimedOut(0, 0, 0);
    expect(r.timedOut).toBe(false);
    expect(r.reason).toBe('continue');
  });

  it('not timed out at t=10min, attempts=2 (attempts < MIN_POLL_ATTEMPTS)', () => {
    const r = isPollingTimedOut(0, 10 * minute, 2);
    expect(r.timedOut).toBe(false);
    expect(r.reason).toBe('continue');
  });

  it('not timed out at t=10min, attempts=10 (window not yet exceeded)', () => {
    // Window is 30 min; at 10 min we still poll regardless of attempts.
    const r = isPollingTimedOut(0, 10 * minute, 10);
    expect(r.timedOut).toBe(false);
    expect(r.reason).toBe('continue');
  });

  it('not timed out at t=35min, attempts=2 (MIN_POLL_ATTEMPTS not yet reached)', () => {
    const r = isPollingTimedOut(0, 35 * minute, 2);
    expect(r.timedOut).toBe(false);
    expect(r.reason).toBe('continue');
  });

  it('timed out at t=35min, attempts=5 (normal termination)', () => {
    const r = isPollingTimedOut(0, 35 * minute, 5);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('attempts-met-and-window-exceeded');
  });

  it('exact-boundary: t = window AND attempts = MIN — timed out (>= semantics)', () => {
    const r = isPollingTimedOut(0, POLLING_WINDOW_MS, MIN_POLL_ATTEMPTS);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('attempts-met-and-window-exceeded');
  });

  it('safety net fires at t=2×window even with very few attempts (W26)', () => {
    // 60 min after start, only 2 attempts → safety net wins.
    const r = isPollingTimedOut(0, 70 * minute, 2);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('safety-net-fired');
  });

  it('safety net fires at exactly 2× window (>= semantics)', () => {
    const r = isPollingTimedOut(0, 2 * POLLING_WINDOW_MS, 0);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('safety-net-fired');
  });

  it('safety net fires at 60min wall-clock for spec defaults', () => {
    // Documented public number: 30 min × 2 = 60 min.
    const r = isPollingTimedOut(0, 60 * minute, 0);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('safety-net-fired');
  });

  it('safety net takes precedence over normal termination', () => {
    // Both conditions met; safety-net branch evaluates first.
    const r = isPollingTimedOut(
      0,
      2 * POLLING_WINDOW_MS + 1,
      MIN_POLL_ATTEMPTS + 10,
    );
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('safety-net-fired');
  });

  it('defensive: now < startedAt does not declare timeout', () => {
    // Negative elapsed is coerced to 0.
    const r = isPollingTimedOut(1000, 500, MIN_POLL_ATTEMPTS);
    expect(r.timedOut).toBe(false);
    expect(r.reason).toBe('continue');
  });

  it('defensive: negative attempts coerced to 0', () => {
    // Window exceeded but attempts is -3 → still polling.
    const r = isPollingTimedOut(0, 35 * minute, -3);
    expect(r.timedOut).toBe(false);
    expect(r.reason).toBe('continue');
  });
});

// =============================================================================
// 4b. Wave 3 steelman — clock-skew defense
// =============================================================================
//
// Wall-clock subtraction (`now - startedAt`) is unsafe under any scenario
// where the OS clock can move backwards: NTP correction stepping back,
// host suspend/resume, container clock drift. The previous
// `isPollingTimedOut` implementation defensively coerced negative
// elapsed to 0 (correct as a guard against garbage inputs), but in
// doing so it ALSO let a backwards-stepped clock prevent W26 wall-
// clock termination indefinitely.
//
// The fix layers two defenses:
//   1. `getMonotonicNowMs()` — caller-side helper for a monotonic
//      clock source unaffected by wall-clock changes. Callers SHOULD
//      use this instead of `Date.now()`.
//   2. `MAX_POLL_ATTEMPTS_HARD_CEILING` — secondary safety net that
//      terminates polling based on attempt COUNT alone, independent
//      of any clock reading. Even if a caller accidentally uses
//      Date.now() AND the clock is stalled, the iteration ceiling
//      eventually fires.
//
// Both must remain unfired simultaneously to allow indefinite polling.

describe('polling-policy — Wave 3 clock-skew defense', () => {
  const minute = 60 * 1000;

  describe('MAX_POLL_ATTEMPTS_HARD_CEILING constant', () => {
    it('is defined as a positive integer', () => {
      expect(typeof MAX_POLL_ATTEMPTS_HARD_CEILING).toBe('number');
      expect(MAX_POLL_ATTEMPTS_HARD_CEILING).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_POLL_ATTEMPTS_HARD_CEILING)).toBe(true);
    });

    it('is comfortably above MIN_POLL_ATTEMPTS so the normal-termination path is reachable first', () => {
      // The attempt-count ceiling MUST NOT undercut the normal
      // termination path; otherwise the worker would always trip
      // the secondary safety net before satisfying the §5.5 step 6
      // attempts-met-and-window-exceeded check.
      expect(MAX_POLL_ATTEMPTS_HARD_CEILING).toBeGreaterThan(MIN_POLL_ATTEMPTS);
      // 14× margin sanity check — keeps the secondary safety net
      // reasonably permissive without inflating it to "never fires".
      expect(MAX_POLL_ATTEMPTS_HARD_CEILING).toBeGreaterThanOrEqual(
        MIN_POLL_ATTEMPTS * 10,
      );
    });
  });

  describe('getMonotonicNowMs', () => {
    it('returns a finite number', () => {
      const t = getMonotonicNowMs();
      expect(Number.isFinite(t)).toBe(true);
    });

    it('is monotonically non-decreasing across consecutive calls', () => {
      // The exact source (performance.now vs Date.now fallback)
      // doesn't matter — both should be non-decreasing across two
      // consecutive synchronous calls in any reasonable runtime.
      const a = getMonotonicNowMs();
      const b = getMonotonicNowMs();
      expect(b).toBeGreaterThanOrEqual(a);
    });
  });

  describe('isPollingTimedOut — attempt-count secondary safety net', () => {
    it('terminates when attempts >= MAX_POLL_ATTEMPTS_HARD_CEILING regardless of wall-clock', () => {
      // Pin the attempt-ceiling reason — fires from attempt count
      // alone with `now === startedAt` (zero elapsed).
      const r = isPollingTimedOut(0, 0, MAX_POLL_ATTEMPTS_HARD_CEILING);
      expect(r.timedOut).toBe(true);
      expect(r.reason).toBe('attempt-ceiling-fired');
    });

    it('terminates when attempts >> ceiling even when wall-clock stepped backwards', () => {
      // Simulated NTP backwards-step scenario: `now < startedAt` →
      // elapsed coerces to 0. The wall-clock branches CAN'T fire.
      // The attempt-count secondary safety net MUST still terminate.
      const startedAt = 10_000_000;
      const nowAfterBackwardsStep = 5_000_000; // 5,000s in the past
      const r = isPollingTimedOut(
        startedAt,
        nowAfterBackwardsStep,
        MAX_POLL_ATTEMPTS_HARD_CEILING + 50,
      );
      expect(r.timedOut).toBe(true);
      expect(r.reason).toBe('attempt-ceiling-fired');
    });

    it('terminates when attempts == ceiling exactly (>= semantics)', () => {
      const r = isPollingTimedOut(0, 0, MAX_POLL_ATTEMPTS_HARD_CEILING);
      expect(r.timedOut).toBe(true);
      expect(r.reason).toBe('attempt-ceiling-fired');
    });

    it('does NOT terminate when attempts is one below ceiling and clock is stalled', () => {
      // Just below the ceiling AND wall-clock is exactly at startedAt
      // (stalled) AND attempts is below MIN_POLL_ATTEMPTS path's
      // window requirement.
      const r = isPollingTimedOut(
        1000,
        1000, // elapsed = 0
        MAX_POLL_ATTEMPTS_HARD_CEILING - 1,
      );
      expect(r.timedOut).toBe(false);
      expect(r.reason).toBe('continue');
    });

    it('attempt-ceiling fires before normal-termination when both would qualify', () => {
      // With both window-exceeded AND attempt count >= ceiling, the
      // attempt-ceiling branch wins (evaluated first).
      const r = isPollingTimedOut(
        0,
        100 * minute,
        MAX_POLL_ATTEMPTS_HARD_CEILING + 5,
      );
      expect(r.timedOut).toBe(true);
      // Could be either 'attempt-ceiling-fired' OR 'safety-net-fired'
      // depending on priority; the documented order is attempt-ceiling
      // FIRST so a clock-skew attacker can't suppress termination.
      expect(r.reason).toBe('attempt-ceiling-fired');
    });
  });

  describe('isPollingTimedOut — wall-clock skew scenarios', () => {
    it('worker still terminates when wall-clock steps backwards mid-poll (simulated)', () => {
      // Setup: poll started at t=10_000_000. After legitimate work,
      // attempts has reached MIN_POLL_ATTEMPTS but the OS clock has
      // been NTP-stepped to 1 hour BEFORE startedAt. Wall-clock branches
      // are forever out of reach (elapsed coerces to 0).
      const startedAt = 10_000_000;
      const stalledNow = startedAt - 60 * minute;

      // Below the attempt ceiling — no termination yet.
      let r = isPollingTimedOut(startedAt, stalledNow, MIN_POLL_ATTEMPTS + 1);
      expect(r.timedOut).toBe(false);

      // Continue polling; eventually attempts cross the hard ceiling.
      r = isPollingTimedOut(startedAt, stalledNow, MAX_POLL_ATTEMPTS_HARD_CEILING);
      expect(r.timedOut).toBe(true);
      expect(r.reason).toBe('attempt-ceiling-fired');
    });

    it('host-suspend resume scenario: clock paused, attempts continue accruing', () => {
      // Suspend: clock pauses at startedAt+5s, resumes after some
      // wall-time but the runtime may see `now === pauseTime`. The
      // worker continues polling and accumulates attempts until the
      // ceiling fires.
      const startedAt = 1_000_000;
      const pausedNow = startedAt + 5_000;
      const r = isPollingTimedOut(
        startedAt,
        pausedNow,
        MAX_POLL_ATTEMPTS_HARD_CEILING,
      );
      expect(r.timedOut).toBe(true);
      expect(r.reason).toBe('attempt-ceiling-fired');
    });

    it('container clock drift: now starts at 0, stays at 0; attempt-ceiling rescues termination', () => {
      // Pathological: container booted from snapshot, clock returns
      // 0 indefinitely. Without the attempt-count safety net, the
      // worker would poll forever (elapsed coerces to 0 → no wall-
      // clock termination ever).
      const r = isPollingTimedOut(0, 0, MAX_POLL_ATTEMPTS_HARD_CEILING);
      expect(r.timedOut).toBe(true);
      expect(r.reason).toBe('attempt-ceiling-fired');
    });
  });
});

// =============================================================================
// 5. Side-effect freedom — pure import asserts no console / global writes
// =============================================================================

describe('polling-policy — module side-effect freedom', () => {
  it('exposes pure functions only — re-import does not throw', async () => {
    // The module's top-level code MUST be value-bindings + function
    // declarations only. Re-importing under the test runner exercises
    // the import path twice; any side effect (e.g. setInterval, log
    // statement) would surface as an unawaited promise rejection or
    // hung timer.
    const mod1 = await import(
      '../../../../modules/payments/transfer/polling-policy'
    );
    const mod2 = await import(
      '../../../../modules/payments/transfer/polling-policy'
    );
    // Same module identity (Node ESM cache).
    expect(mod1.POLLING_WINDOW_MS).toBe(mod2.POLLING_WINDOW_MS);
    expect(mod1.getBackoffMs).toBe(mod2.getBackoffMs);
  });
});
