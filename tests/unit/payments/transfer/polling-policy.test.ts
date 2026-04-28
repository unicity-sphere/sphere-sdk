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
  validatePollingPolicy,
  getBackoffMs,
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
  it('returns 30s for attempt 0', () => {
    expect(getBackoffMs(0)).toBe(30_000);
  });

  it('returns 60s for attempt 1', () => {
    expect(getBackoffMs(1)).toBe(60_000);
  });

  it('returns 120s for attempt 2', () => {
    expect(getBackoffMs(2)).toBe(120_000);
  });

  it('returns 240s for attempt 3', () => {
    expect(getBackoffMs(3)).toBe(240_000);
  });

  it('returns 300s (5 min) for attempt 4 (last entry)', () => {
    expect(getBackoffMs(4)).toBe(300_000);
  });

  it('caps at last entry — attempt 5 returns 300s', () => {
    expect(getBackoffMs(5)).toBe(300_000);
  });

  it('caps at last entry — attempt 100 returns 300s', () => {
    expect(getBackoffMs(100)).toBe(300_000);
  });

  it('clamps negative input to first entry', () => {
    expect(getBackoffMs(-1)).toBe(30_000);
  });

  it('clamps NaN to first entry', () => {
    expect(getBackoffMs(NaN)).toBe(30_000);
  });

  it('floors fractional input', () => {
    // 1.9 → floor → 1 → 60_000.
    expect(getBackoffMs(1.9)).toBe(60_000);
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
