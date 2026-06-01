/**
 * Issue #369 — retry-with-backoff for transient IPFS pin failures.
 *
 * The SDK's pin path (`pinToIpfs`, `pinSingleBlock`) historically did
 * a single `fetch()` per gateway with NO retry on transient errors
 * (network blip, brief TLS slowdown, rate-limit 429). The observed
 * surface error was `IPFS dag/put failed on all gateways for <CID>:
 * fetch failed`, not reproducible on demand because the gateway worked
 * ~99% of the time when tested directly. A single 1% per-block error
 * rate cascades to ~92% chance of at-least-one-failure across a
 * 250-block migration CAR.
 *
 * This test file covers:
 *
 *   - `isTransientPinError` classifier across the failure-mode matrix
 *     the pin path actually produces (HTTP-status strings, fetch
 *     throws, AbortError).
 *   - `withPinRetry` retry / backoff / counter semantics.
 *   - End-to-end: `pinToIpfs` succeeds on the third attempt when the
 *     first two transient-fail (proves the wrap is in the right
 *     place).
 *   - Permanent failures (HTTP 4xx other than 429) short-circuit the
 *     retry budget.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTransientPinError, withPinRetry, pinToIpfs } from '../../../profile/ipfs-client';
import {
  __setPerfEnabledForTest,
  __stopAutoDumpForTest,
  dumpAndReset,
  snapshot,
} from '../../../core/perf-counters.js';

describe('Issue #369 — isTransientPinError classifier', () => {
  it('classifies HTTP 5xx as transient', () => {
    expect(isTransientPinError(new Error('HTTP 500 Internal Server Error from https://gw.test'))).toBe(true);
    expect(isTransientPinError(new Error('HTTP 502 Bad Gateway from https://gw.test'))).toBe(true);
    expect(isTransientPinError(new Error('HTTP 503 Service Unavailable from https://gw.test'))).toBe(true);
  });

  it('classifies HTTP 429 (rate limit) as transient', () => {
    expect(isTransientPinError(new Error('HTTP 429 Too Many Requests from https://gw.test'))).toBe(true);
  });

  it('classifies other HTTP 4xx as permanent', () => {
    expect(isTransientPinError(new Error('HTTP 400 Bad Request from https://gw.test'))).toBe(false);
    expect(isTransientPinError(new Error('HTTP 401 Unauthorized from https://gw.test'))).toBe(false);
    expect(isTransientPinError(new Error('HTTP 403 Forbidden from https://gw.test'))).toBe(false);
    expect(isTransientPinError(new Error('HTTP 404 Not Found from https://gw.test'))).toBe(false);
    expect(isTransientPinError(new Error('HTTP 413 Payload Too Large from https://gw.test'))).toBe(false);
  });

  it('classifies fetch network errors as transient', () => {
    expect(isTransientPinError(new Error('fetch failed'))).toBe(true);
    expect(isTransientPinError(new Error('Network request failed'))).toBe(true);
    expect(isTransientPinError(new Error('connect ECONNRESET 1.2.3.4:443'))).toBe(true);
    expect(isTransientPinError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(true);
    expect(isTransientPinError(new Error('connect ECONNREFUSED 1.2.3.4:443'))).toBe(true);
    expect(isTransientPinError(new Error('getaddrinfo EAI_AGAIN gw.test'))).toBe(true);
  });

  it('classifies AbortError / TimeoutError by Error.name', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(isTransientPinError(abort)).toBe(true);

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isTransientPinError(timeout)).toBe(true);
  });

  it('classifies non-Error throws and unrecognised shapes as transient (lenient default)', () => {
    expect(isTransientPinError('a bare string')).toBe(true);
    expect(isTransientPinError({ shape: 'weird' })).toBe(true);
    expect(isTransientPinError(new Error('something else entirely'))).toBe(true);
  });
});

describe('Issue #369 — withPinRetry', () => {
  beforeEach(() => {
    __stopAutoDumpForTest();
    __setPerfEnabledForTest(true);
    dumpAndReset();
  });

  afterEach(() => {
    __setPerfEnabledForTest(false);
    __stopAutoDumpForTest();
  });

  it('returns the value on the first successful attempt — no retries paid', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withPinRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count ?? 0).toBe(0);
    expect(counters['ipfs.pin.retry.exhausted']?.count ?? 0).toBe(0);
  });

  it('retries on transient failure until success, bumps retry counter per retry', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('fetch failed');
      return 'recovered';
    });

    const result = await withPinRetry(fn, isTransientPinError, [1, 1, 1]);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count).toBe(2);
    expect(counters['ipfs.pin.retry.exhausted']?.count ?? 0).toBe(0);
    expect(counters['ipfs.pin.retry.permanent']?.count ?? 0).toBe(0);
  });

  it('throws after the retry budget runs out — bumps exhausted counter', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    await expect(
      withPinRetry(fn, isTransientPinError, [1, 1, 1]),
    ).rejects.toThrow(/fetch failed/);
    expect(fn).toHaveBeenCalledTimes(4); // 1 + 3 retries

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count).toBe(3);
    expect(counters['ipfs.pin.retry.exhausted']?.count).toBe(1);
  });

  it('short-circuits on a permanent error — does NOT consume further retries', async () => {
    const fn = vi.fn(async () => {
      throw new Error('HTTP 400 Bad Request from https://gw.test');
    });

    await expect(
      withPinRetry(fn, isTransientPinError, [1, 1, 1]),
    ).rejects.toThrow(/HTTP 400/);
    expect(fn).toHaveBeenCalledTimes(1);

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count ?? 0).toBe(0);
    expect(counters['ipfs.pin.retry.permanent']?.count).toBe(1);
    expect(counters['ipfs.pin.retry.exhausted']?.count ?? 0).toBe(0);
  });

  it('uses the default backoff schedule when no explicit one is passed', async () => {
    // Default is [100, 500, 2000] — too slow to run as a real timing
    // test, so spy on setTimeout to observe the requested delays
    // without actually waiting.
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((cb: TimerHandler) => {
        if (typeof cb === 'function') cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const fn = vi.fn(async () => {
      throw new Error('fetch failed');
    });

    await expect(withPinRetry(fn)).rejects.toThrow();
    // 3 retry backoffs in the default schedule.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toEqual([100, 500, 2000]);

    setTimeoutSpy.mockRestore();
  });
});

describe('Issue #369 — pinToIpfs end-to-end retry', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __stopAutoDumpForTest();
    __setPerfEnabledForTest(true);
    dumpAndReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setPerfEnabledForTest(false);
    __stopAutoDumpForTest();
    vi.restoreAllMocks();
  });

  it('succeeds on the third attempt when the first two fail transient', async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      if (calls < 3) {
        throw new Error('fetch failed');
      }
      // Kubo's `/api/v0/dag/put` returns `{"Cid":{"/":"bafkrei…"}}`.
      // The returned CID is intentionally ignored by pinToIpfs (it
      // computes its own from the bytes). Any plausible string works.
      return new Response(JSON.stringify({ Cid: { '/': 'bafkreiignored' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    // Use tiny backoffs via vi.useFakeTimers? Simpler — spy on setTimeout
    // to fire immediately.
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((cb: TimerHandler) => {
        if (typeof cb === 'function') cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const data = new TextEncoder().encode('hello pin retry');
    const result = await pinToIpfs(['https://gw1.test'], data);
    expect(result).toMatch(/^baf/);
    // 2 transient-failing pins + 1 successful pin + 1 sidecar
    // fire-and-forget submit on success = 4 fetch calls. The sidecar
    // submit is unconditional after a successful pin (see
    // `submitToSidecarBestEffort`); it never fires on a failure.
    expect(calls).toBe(4);

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count).toBe(2);
    expect(counters['ipfs.pin.retry.exhausted']?.count ?? 0).toBe(0);

    setTimeoutSpy.mockRestore();
  });

  it('throws after 4 attempts all-transient on the configured gateways', async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      throw new Error('fetch failed');
    }) as typeof fetch;

    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((cb: TimerHandler) => {
        if (typeof cb === 'function') cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const data = new TextEncoder().encode('hello pin exhaust');
    await expect(pinToIpfs(['https://gw1.test'], data)).rejects.toThrow(/IPFS pin failed/);
    // 1 attempt × 1 gateway + 3 retries × 1 gateway = 4 fetch calls.
    expect(calls).toBe(4);

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count).toBe(3);
    expect(counters['ipfs.pin.retry.exhausted']?.count).toBe(1);

    setTimeoutSpy.mockRestore();
  });

  it('permanent failure (HTTP 400) does NOT consume retries', async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      return new Response('bad', { status: 400, statusText: 'Bad Request' });
    }) as typeof fetch;

    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((cb: TimerHandler) => {
        if (typeof cb === 'function') cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    const data = new TextEncoder().encode('hello pin perm');
    await expect(pinToIpfs(['https://gw1.test'], data)).rejects.toThrow(/HTTP 400/);
    // 1 attempt only — permanent failure short-circuits.
    expect(calls).toBe(1);

    const counters = snapshot();
    expect(counters['ipfs.pin.retry.attempt']?.count ?? 0).toBe(0);
    expect(counters['ipfs.pin.retry.permanent']?.count).toBe(1);
    expect(counters['ipfs.pin.retry.exhausted']?.count ?? 0).toBe(0);

    setTimeoutSpy.mockRestore();
  });
});
