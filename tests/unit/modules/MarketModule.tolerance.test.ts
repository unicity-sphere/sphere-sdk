/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tolerance tests for MarketModule:
 *  - Retry on transient HTTP failures (502/503/504/408) and network errors.
 *  - Permanent failures (400/401/403/404/422) propagate immediately.
 *  - Circuit breaker opens after N consecutive operation-level failures and
 *    fails fast during the cooldown.
 *  - Existing public error shapes are preserved when retries exhaust.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketModule } from '../../../modules/market/MarketModule';
import {
  CircuitBreaker,
  TransientMarketError,
  backoffDelay,
  isRetryableStatus,
  isTransientNetworkError,
  runWithRetry,
} from '../../../modules/market/retry';
import { SphereError } from '../../../core/errors';
import type { FullIdentity } from '../../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY = 'a'.repeat(64);

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'ab'.repeat(32),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: TEST_PRIVATE_KEY,
  };
}

function mockDeps() {
  return { identity: mockIdentity(), emitEvent: vi.fn() };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

/**
 * Build a MarketModule that's pre-registered (skips the agent/register
 * roundtrip) and uses tight, deterministic retry settings for tests.
 */
function makeModule(opts?: {
  maxAttempts?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  now?: () => number;
}): MarketModule {
  const mod = new MarketModule({
    apiUrl: 'https://market.test',
    timeout: 5000,
    retryConfig: {
      maxAttempts: opts?.maxAttempts ?? 3,
      delaysMs: [1, 1, 1, 1, 1],
      totalBudgetMs: 1000,
      breakerThreshold: opts?.breakerThreshold ?? 5,
      breakerCooldownMs: opts?.breakerCooldownMs ?? 30_000,
      now: opts?.now,
      sleep: () => Promise.resolve(),
      random: () => 0, // zero jitter — deterministic
    },
  } as any);
  mod.initialize(mockDeps());
  // Skip auto-registration in tolerance tests — registration is exercised
  // separately and would otherwise consume the first fetch mock.
  (mod as any).registered = true;
  return mod;
}

// =============================================================================
// Pure helpers (classification + backoff)
// =============================================================================

describe('retry helpers', () => {
  describe('isRetryableStatus', () => {
    it('marks 502/503/504/408 as retryable', () => {
      expect(isRetryableStatus(502)).toBe(true);
      expect(isRetryableStatus(503)).toBe(true);
      expect(isRetryableStatus(504)).toBe(true);
      expect(isRetryableStatus(408)).toBe(true);
    });

    it('does NOT retry 4xx caller-side errors', () => {
      for (const s of [400, 401, 403, 404, 405, 409, 410, 422, 429]) {
        expect(isRetryableStatus(s)).toBe(false);
      }
    });

    it('does NOT retry success codes', () => {
      expect(isRetryableStatus(200)).toBe(false);
      expect(isRetryableStatus(201)).toBe(false);
      expect(isRetryableStatus(204)).toBe(false);
    });
  });

  describe('isTransientNetworkError', () => {
    it('detects AbortError / TimeoutError DOMException', () => {
      const abort = new DOMException('aborted', 'AbortError');
      const timeout = new DOMException('timeout', 'TimeoutError');
      expect(isTransientNetworkError(abort)).toBe(true);
      expect(isTransientNetworkError(timeout)).toBe(true);
    });

    it('detects Node-style ECONNRESET / ETIMEDOUT etc.', () => {
      const codes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];
      for (const code of codes) {
        const err = Object.assign(new Error('net'), { code });
        expect(isTransientNetworkError(err)).toBe(true);
      }
    });

    it('detects undici "fetch failed" TypeError', () => {
      expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
    });

    it('returns false for plain SphereError (already classified)', () => {
      expect(isTransientNetworkError(new SphereError('nope', 'NETWORK_ERROR'))).toBe(false);
    });

    it('returns false for null / non-objects', () => {
      expect(isTransientNetworkError(null)).toBe(false);
      expect(isTransientNetworkError('boom')).toBe(false);
      expect(isTransientNetworkError(undefined)).toBe(false);
    });
  });

  describe('backoffDelay', () => {
    it('respects schedule index, capped at last entry', () => {
      const schedule = [100, 200, 400];
      // random=1 → returns floor(base) − 1 (because Math.floor(1*base) === base, but spec uses [0, base))
      // We use the deterministic random=0 → 0; random=0.99 → just under base
      expect(backoffDelay(0, schedule, () => 0)).toBe(0);
      expect(backoffDelay(1, schedule, () => 0)).toBe(0);
      expect(backoffDelay(0, schedule, () => 0.5)).toBe(50);
      expect(backoffDelay(2, schedule, () => 0.5)).toBe(200);
      // index past the schedule clamps to the last entry
      expect(backoffDelay(99, schedule, () => 0.25)).toBe(100);
    });
  });
});

// =============================================================================
// runWithRetry behavior
// =============================================================================

describe('runWithRetry', () => {
  it('retries TransientMarketError up to maxAttempts and eventually succeeds', async () => {
    const breaker = new CircuitBreaker();
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 3) {
        throw new TransientMarketError(new SphereError('HTTP 502', 'NETWORK_ERROR'), 502);
      }
      return 'ok';
    };
    const result = await runWithRetry(op, breaker, {
      maxAttempts: 5,
      delaysMs: [0, 0, 0, 0, 0],
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('throws the original SphereError when retries are exhausted', async () => {
    const breaker = new CircuitBreaker();
    const finalErr = new SphereError(
      'Market API error: HTTP 502 — unexpected response (not JSON)',
      'NETWORK_ERROR',
    );
    const op = async () => {
      throw new TransientMarketError(finalErr, 502);
    };

    await expect(
      runWithRetry(op, breaker, {
        maxAttempts: 3,
        delaysMs: [0, 0],
        sleep: () => Promise.resolve(),
        random: () => 0,
      }),
    ).rejects.toThrow(finalErr.message);
  });

  it('does not retry when op throws a non-transient error', async () => {
    const breaker = new CircuitBreaker();
    let calls = 0;
    const op = async () => {
      calls++;
      throw new SphereError('HTTP 400', 'NETWORK_ERROR');
    };
    await expect(runWithRetry(op, breaker, { maxAttempts: 5, delaysMs: [0, 0] })).rejects.toThrow(
      'HTTP 400',
    );
    expect(calls).toBe(1);
    // Permanent errors must not affect the breaker.
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('aborts the loop once the total time budget is exhausted', async () => {
    const breaker = new CircuitBreaker();
    let calls = 0;
    let virtualNow = 0;
    const sleep = (ms: number) => {
      virtualNow += ms;
      return Promise.resolve();
    };
    const op = async () => {
      calls++;
      throw new TransientMarketError(new SphereError('HTTP 503', 'NETWORK_ERROR'), 503);
    };
    await expect(
      runWithRetry(op, breaker, {
        maxAttempts: 100,
        delaysMs: [50, 50, 50, 50, 50],
        totalBudgetMs: 100,
        sleep,
        now: () => virtualNow,
        random: () => 1, // pick max base each time
      }),
    ).rejects.toThrow('HTTP 503');
    // We should stop well before 100 attempts.
    expect(calls).toBeLessThan(10);
  });
});

// =============================================================================
// Circuit breaker
// =============================================================================

describe('CircuitBreaker', () => {
  it('stays closed on successes', () => {
    const breaker = new CircuitBreaker({ threshold: 3 });
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after N consecutive failures', () => {
    const breaker = new CircuitBreaker({ threshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
  });

  it('resets the failure counter on success', () => {
    const breaker = new CircuitBreaker({ threshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getConsecutiveFailures()).toBe(0);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
  });

  it('fails fast while open', () => {
    const now = 1000;
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => now });
    breaker.recordFailure(); // opens
    expect(breaker.getState()).toBe('open');
    expect(() => breaker.assertCanProceed()).toThrow(/circuit breaker open/i);
  });

  it('moves to half-open after cooldown, closes on success', () => {
    let now = 1000;
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => now });
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    now += 6000;
    expect(() => breaker.assertCanProceed()).not.toThrow();
    expect(breaker.getState()).toBe('half-open');
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opens immediately if the half-open trial fails', () => {
    let now = 1000;
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 5000, now: () => now });
    breaker.recordFailure();
    now += 6000;
    breaker.assertCanProceed(); // → half-open
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    // Still inside the new cooldown window.
    expect(() => breaker.assertCanProceed()).toThrow(/circuit breaker open/i);
  });
});

// =============================================================================
// MarketModule wired with retry + breaker
// =============================================================================

describe('MarketModule transient-failure tolerance', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ---------- Retry on transient HTTP -------------------------------------

  it('retries 502 (HTML body) and eventually succeeds', async () => {
    const mod = makeModule({ maxAttempts: 3 });
    fetchSpy
      .mockResolvedValueOnce(htmlResponse('<html>502 Bad Gateway</html>', 502))
      .mockResolvedValueOnce(htmlResponse('<html>502 Bad Gateway</html>', 502))
      .mockResolvedValueOnce(jsonResponse({ intents: [], count: 0 }));

    const result = await mod.search('widgets');
    expect(result.intents).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries 503 JSON-shaped error and eventually succeeds', async () => {
    const mod = makeModule({ maxAttempts: 3 });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ intents: [], count: 0 }));

    const result = await mod.search('widgets');
    expect(result.intents).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries 504 / 408 too', async () => {
    const mod = makeModule({ maxAttempts: 3 });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'gateway timeout' }, 504))
      .mockResolvedValueOnce(jsonResponse({ error: 'request timeout' }, 408))
      .mockResolvedValueOnce(jsonResponse({ intents: [], count: 0 }));

    await expect(mod.search('q')).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries on network-level errors (ECONNRESET)', async () => {
    const mod = makeModule({ maxAttempts: 3 });
    const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    fetchSpy
      .mockRejectedValueOnce(netErr)
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(jsonResponse({ intents: [] }));

    await expect(mod.search('q')).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('retries on AbortSignal.timeout DOMException', async () => {
    const mod = makeModule({ maxAttempts: 2 });
    fetchSpy
      .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
      .mockResolvedValueOnce(jsonResponse({ intents: [] }));

    await expect(mod.search('q')).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ---------- Permanent errors ------------------------------------------

  it('does NOT retry on HTTP 400 — fails immediately', async () => {
    const mod = makeModule({ maxAttempts: 5 });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, 400));

    await expect(mod.search('q')).rejects.toThrow('bad request');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401/403/404/422', async () => {
    for (const status of [401, 403, 404, 422]) {
      fetchSpy.mockReset();
      const mod = makeModule({ maxAttempts: 5 });
      fetchSpy.mockResolvedValueOnce(jsonResponse({ error: `e${status}` }, status));
      await expect(mod.search('q')).rejects.toThrow(`e${status}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it('does NOT retry on a non-network programming error', async () => {
    const mod = makeModule({ maxAttempts: 5 });
    fetchSpy.mockRejectedValueOnce(new RangeError('not a network problem'));
    await expect(mod.search('q')).rejects.toThrow('not a network problem');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ---------- Retries exhausted: error shape preserved -----------------

  it('preserves the original SphereError message after retries exhaust', async () => {
    const mod = makeModule({ maxAttempts: 3 });
    fetchSpy.mockImplementation(async () => htmlResponse('<html>502</html>', 502));

    let caught: unknown;
    try {
      await mod.search('q');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('NETWORK_ERROR');
    expect((caught as SphereError).message).toBe(
      'Market API error: HTTP 502 — unexpected response (not JSON)',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('preserves the API-provided error message after JSON 503 exhausts', async () => {
    const mod = makeModule({ maxAttempts: 2 });
    // Fresh Response per call — Response bodies are single-shot.
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ error: 'service unavailable' }, 503),
    );

    await expect(mod.search('q')).rejects.toThrow('service unavailable');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // ---------- Circuit breaker ------------------------------------------

  it('opens the circuit after N consecutive failed operations and fails fast during cooldown', async () => {
    let virtualNow = 0;
    const mod = makeModule({
      maxAttempts: 1, // single attempt per op so each failure counts cleanly
      breakerThreshold: 3,
      breakerCooldownMs: 30_000,
      now: () => virtualNow,
    });
    fetchSpy.mockImplementation(async () => jsonResponse({ error: 'down' }, 503));

    // Three failed ops → breaker opens.
    for (let i = 0; i < 3; i++) {
      await expect(mod.search('q')).rejects.toThrow();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Next call must fail fast WITHOUT a network roundtrip.
    fetchSpy.mockClear();
    await expect(mod.search('q')).rejects.toThrow(/circuit breaker open/i);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance past cooldown — the breaker enters half-open and lets one through.
    virtualNow += 31_000;
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ intents: [], count: 0 }));
    const ok = await mod.search('q');
    expect(ok.intents).toEqual([]);
  });

  it('resumes normal operation after a successful half-open trial', async () => {
    let virtualNow = 0;
    const mod = makeModule({
      maxAttempts: 1,
      breakerThreshold: 2,
      breakerCooldownMs: 1000,
      now: () => virtualNow,
    });
    fetchSpy.mockImplementation(async () => jsonResponse({ error: 'down' }, 503));

    await expect(mod.search('q')).rejects.toThrow();
    await expect(mod.search('q')).rejects.toThrow();
    // Breaker is now open.
    fetchSpy.mockClear();
    await expect(mod.search('q')).rejects.toThrow(/circuit breaker open/i);

    // Advance past cooldown, succeed once → breaker closes.
    virtualNow += 2000;
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ intents: [], count: 0 }));
    await expect(mod.search('q')).resolves.toBeDefined();

    // Subsequent calls flow through normally.
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ intents: [], count: 0 }));
    await expect(mod.search('q')).resolves.toBeDefined();
  });

  it('does not count permanent (non-retryable) failures toward the breaker', async () => {
    const mod = makeModule({
      maxAttempts: 1,
      breakerThreshold: 2,
    });
    fetchSpy.mockImplementation(async () => jsonResponse({ error: 'bad' }, 400));

    // Many permanent failures should NEVER trip the breaker.
    for (let i = 0; i < 5; i++) {
      await expect(mod.search('q')).rejects.toThrow('bad');
    }
    // Now a success should flow through cleanly.
    fetchSpy.mockImplementationOnce(async () => jsonResponse({ intents: [] }));
    await expect(mod.search('q')).resolves.toBeDefined();
  });
});
