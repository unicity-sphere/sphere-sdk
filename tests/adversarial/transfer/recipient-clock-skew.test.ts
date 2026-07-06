/**
 * Adversarial test — recipient clock skewed 30 days (§5.5 step 6, §11.4).
 *
 * Threat model: NOT actually adversarial in the malicious sense — but
 * adversarial against the SDK's robustness assumptions. A user's
 * device clock can drift, be deliberately misconfigured (NTP off,
 * BIOS battery dead), or be in the wrong timezone after travel.
 *
 * Spec wording (§11.4):
 *   "Recipient's local clock skewed by 30 days → finalization worker
 *    still runs (no clock-dependent guards)."
 *
 * The polling-policy module's `isPollingTimedOut(startedAt, now,
 * attempts)` is the canonical decision point for "should I stop
 * polling?" — its inputs are the WALL-CLOCK timestamps the worker
 * captured at submit-time and the current invocation. As long as the
 * SAME clock is used for both, an absolute skew (the entire clock
 * being 30 days off) does not affect the elapsed-time calculation.
 *
 * Spec defense: ELAPSED time, not absolute time, drives the polling
 * loop. The worker captures `submittedAt = Date.now()` at first
 * submit, then computes `elapsed = now - submittedAt` on each poll.
 * If the clock is skewed by a constant offset, both reads have the
 * same offset and the difference cancels — the worker still observes
 * the correct 30-min polling window.
 *
 * What this test pins:
 *   1. With the clock 30 days in the FUTURE relative to UNIX epoch,
 *      a 30-min polling-window observation behaves identically to the
 *      no-skew case.
 *   2. With the clock 30 days in the PAST, same.
 *   3. The 2× hard-safety-net deadline also fires correctly under
 *      skew (it's elapsed-based too).
 *   4. The DEFENSIVE clamp (`elapsed < 0` from caller drift) does
 *      not silently break the deadline — a caller passing
 *      `now < startedAt` (negative elapsed) is treated as elapsed=0,
 *      so the worker keeps polling rather than declaring premature
 *      timeout.
 *
 * Spec references: §5.5 step 6, §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  POLLING_WINDOW_MS,
  MIN_POLL_ATTEMPTS,
  isPollingTimedOut,
} from '../../../extensions/uxf/pipeline/polling-policy';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('§11.4 — recipient clock skew (30 days) does NOT break polling-policy', () => {
  it('clock 30 days in the FUTURE: same elapsed-window decisions as no-skew', async () => {
    // Honest scenario: submit at "now"; poll 30 min later. Should
    // declare attempts-met-and-window-exceeded once attempts >= MIN.
    const noSkewStart = Date.now();
    const honestPoll = isPollingTimedOut(
      noSkewStart,
      noSkewStart + POLLING_WINDOW_MS,
      MIN_POLL_ATTEMPTS,
    );

    // Skewed scenario: clock is 30 days in the future.
    const skewedStart = noSkewStart + THIRTY_DAYS_MS;
    const skewedPoll = isPollingTimedOut(
      skewedStart,
      skewedStart + POLLING_WINDOW_MS,
      MIN_POLL_ATTEMPTS,
    );

    // CRITICAL invariant: skew is ABSOLUTE, elapsed is RELATIVE — the
    // outcomes match.
    expect(skewedPoll).toEqual(honestPoll);
    expect(skewedPoll.timedOut).toBe(true);
    expect(skewedPoll.reason).toBe('attempts-met-and-window-exceeded');
  });

  it('clock 30 days in the PAST: same elapsed-window decisions', async () => {
    // Equivalent to a wallet that hasn't booted in a month or has BIOS
    // battery issues — the absolute clock value doesn't matter as
    // long as it ticks consistently.
    const skewedStart = Date.now() - THIRTY_DAYS_MS;
    const skewedPoll = isPollingTimedOut(
      skewedStart,
      skewedStart + POLLING_WINDOW_MS,
      MIN_POLL_ATTEMPTS,
    );

    expect(skewedPoll.timedOut).toBe(true);
    expect(skewedPoll.reason).toBe('attempts-met-and-window-exceeded');
  });

  it('2x hard-safety-net fires correctly under skew', async () => {
    // The 60-min absolute deadline (2 × POLLING_WINDOW_MS) is also
    // elapsed-based. Under skew, the "fire at 60 min elapsed" semantic
    // is preserved.
    const skewedStart = Date.now() + THIRTY_DAYS_MS;
    const result = isPollingTimedOut(
      skewedStart,
      skewedStart + 2 * POLLING_WINDOW_MS,
      0, // attempts irrelevant for safety net
    );
    expect(result.timedOut).toBe(true);
    expect(result.reason).toBe('safety-net-fired');
  });

  it('mid-window poll under skew: still polls (continue)', async () => {
    // 15 minutes into the polling window with attempts < MIN: should
    // return continue regardless of clock skew.
    const skewedStart = Date.now() + THIRTY_DAYS_MS;
    const halfWindow = POLLING_WINDOW_MS / 2;
    const result = isPollingTimedOut(skewedStart, skewedStart + halfWindow, 2);
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBe('continue');
  });

  it('NEGATIVE elapsed (now < startedAt — drift edge case) treated as 0', async () => {
    // An adversarial / accidental case: the system clock JUMPED
    // BACKWARDS between submit and poll (e.g., NTP correction). The
    // policy's defensive clamp treats elapsed < 0 as 0, so the worker
    // does NOT prematurely declare timeout — it keeps polling.
    const startedAt = Date.now();
    const earlierNow = startedAt - 60 * 60 * 1000; // 1 hour earlier
    const result = isPollingTimedOut(startedAt, earlierNow, 100);
    // Even with attempts >> MIN_POLL_ATTEMPTS, negative elapsed
    // means "0 elapsed" → continue. This is the conservative path:
    // we never deny a token its full polling budget due to
    // drift-induced negative elapsed.
    expect(result.timedOut).toBe(false);
    expect(result.reason).toBe('continue');
  });

  it('Number.NEGATIVE_INFINITY / NaN inputs do not crash the policy', async () => {
    // Spec defensive contract: malformed inputs are treated as
    // elapsed=0 / attempts=0 — the worker stays in the polling
    // loop rather than crashing or prematurely declaring timeout.
    expect(isPollingTimedOut(NaN, Date.now(), 5).timedOut).toBe(false);
    expect(
      isPollingTimedOut(Date.now(), Number.NEGATIVE_INFINITY, 5).timedOut,
    ).toBe(false);
    expect(isPollingTimedOut(Date.now(), Date.now(), NaN).timedOut).toBe(false);
  });
});
