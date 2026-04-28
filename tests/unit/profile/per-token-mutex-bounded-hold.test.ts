/**
 * W35 — explicit test that `MAX_LOCK_HOLD_MS` actually fires under
 * realistic event-loop conditions.
 *
 * Uses real timers (NOT vi.useFakeTimers) to prove the timeout path
 * works in production. The defaults are scaled down (~50–100 ms
 * timeouts) so the test suite remains fast.
 */

import { describe, it, expect } from 'vitest';
import {
  PerTokenMutex,
  MAX_LOCK_HOLD_MS,
} from '../../../profile/per-token-mutex';
import { SphereError } from '../../../core/errors';

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PerTokenMutex bounded-hold W35', () => {
  it('exports MAX_LOCK_HOLD_MS = 5000 (default per spec)', () => {
    expect(MAX_LOCK_HOLD_MS).toBe(5000);
  });

  it('rejects with LOCK_BOUNDED_HOLD_FIRED when fn exceeds timeout', async () => {
    const m = new PerTokenMutex();
    const start = Date.now();

    let caught: unknown;
    try {
      await m.acquire(
        'slow-token',
        async () => {
          // Sleep WAY past the bound (1000 ms) on a 100 ms timeout.
          await sleep(1000);
        },
        { strategy: 'bounded-hold', timeoutMs: 100 },
      );
    } catch (e) {
      caught = e;
    }

    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('LOCK_BOUNDED_HOLD_FIRED');
    // Should fire close to the timeout (100 ms), not after the full 1000.
    // Allow generous slack for slow CI; just assert "much sooner than 1 s".
    expect(elapsed).toBeLessThan(800);
    // And not unreasonably soon — at least the configured timeout.
    expect(elapsed).toBeGreaterThanOrEqual(95);
  });

  it('releases the lock after firing so the next caller can proceed', async () => {
    const m = new PerTokenMutex();

    // First acquire times out.
    const slowPromise = m
      .acquire(
        'token1',
        async () => {
          await sleep(1000);
        },
        { strategy: 'bounded-hold', timeoutMs: 50 },
      )
      .catch((e: unknown) => `rejected:${(e as SphereError).code}`);

    // The first acquire should reject after ~50 ms; then the second
    // acquire (queued behind it via per-tokenId chain) MUST proceed
    // without further delay.
    const firstResult = await slowPromise;
    expect(firstResult).toBe('rejected:LOCK_BOUNDED_HOLD_FIRED');

    const t0 = Date.now();
    const secondResult = await m.acquire(
      'token1',
      async () => 'ok',
      { strategy: 'bounded-hold', timeoutMs: 1000 },
    );
    const elapsed = Date.now() - t0;
    expect(secondResult).toBe('ok');
    // The second acquire ran near-instantly — well under the 1000ms
    // bound it carries.
    expect(elapsed).toBeLessThan(200);
  });

  it('fires exactly once per acquire (no double-throw on fn rejection)', async () => {
    const m = new PerTokenMutex();
    let firedCount = 0;

    const result = await m
      .acquire(
        'token1',
        async () => {
          await sleep(500);
          // fn would reject AFTER timeout fires; bounded-hold should
          // race-win and throw LOCK_BOUNDED_HOLD_FIRED first.
          throw new Error('fn-self-reject');
        },
        { strategy: 'bounded-hold', timeoutMs: 50 },
      )
      .catch((e: unknown) => {
        if (e instanceof SphereError && e.code === 'LOCK_BOUNDED_HOLD_FIRED') {
          firedCount += 1;
          return 'fired';
        }
        return `unexpected:${String(e)}`;
      });

    expect(result).toBe('fired');
    expect(firedCount).toBe(1);

    // Yield real time so the underlying fn would also have a chance to
    // reject if it were going to leak. The acquire's promise has
    // already settled — any extra fn rejection should NOT leak.
    await sleep(600);

    // Ensure the lock did not get stuck after the fired acquire.
    expect(m.isLocked('token1')).toBe(false);
  });

  it('does NOT fire when fn completes within timeout (no false positive)', async () => {
    const m = new PerTokenMutex();
    const result = await m.acquire(
      'token1',
      async () => {
        await sleep(20);
        return 'fast';
      },
      { strategy: 'bounded-hold', timeoutMs: 200 },
    );
    expect(result).toBe('fast');
  });
});
