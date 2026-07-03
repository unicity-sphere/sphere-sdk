/**
 * wallet-api client retry policy (#630): beyond the transient-GET retry, the
 * §16 REST path now
 *  - retries a `429` on ANY method (a 429 is rejected before the handler runs —
 *    the write never executed — so re-issuing is safe), honoring `Retry-After`;
 *  - retries a `503` on GETs only (a write may have started);
 *  - is fully tunable via the `retry` config (`false` disables it).
 * Driven by a flaky fetchFn that returns synthetic 429/503 responses (with a
 * `Retry-After` header) once, then delegates to the real in-process backend.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import type { WalletApiRetryConfig } from '../../../wallet-api';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

type FetchLike = (url: string | URL, init?: { method?: string }) => Promise<Response>;

/** A synthetic non-2xx response satisfying FetchResponseLike (incl. the optional headers accessor). */
function statusResp(status: number, retryAfter?: string): Response {
  return {
    status,
    ok: false,
    headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    text: async () => JSON.stringify({ error: { code: status === 429 ? 'RATE_LIMITED' : 'SERVER', message: `status ${status}` } }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/** A synthetic 204 No Content (a successful write) — avoids exercising backend payload validation. */
function noContent(): Response {
  return {
    status: 204,
    ok: true,
    headers: { get: () => null },
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe('WalletApiClient — 429/503 Retry-After + retry config (#630)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  const identity = testIdentity(52);
  const calls: { method: string; path: string }[] = [];

  const realFetch: FetchLike = (u, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(u, init);

  function makeClient(fetchFn: FetchLike, retry?: WalletApiRetryConfig | false): WalletApiClient {
    const client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-retry-after',
      storage: new MemoryKeyValueStore(),
      fetchFn: fetchFn as never,
      ...(retry !== undefined ? { retry } : {}),
    });
    client.setIdentity(identity);
    return client;
  }

  const countOf = (method: string, needle: string): number =>
    calls.filter((c) => c.method === method && c.path.includes(needle)).length;

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
    calls.length = 0;
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('retries a 429 on a GET, honoring (capped) Retry-After, and succeeds', async () => {
    let retryAfterReads = 0;
    let fail = 1;
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'GET' && path.includes('/v1/inventory') && fail-- > 0) {
        return Promise.resolve({
          status: 429,
          ok: false,
          headers: {
            get: (n: string) => {
              if (n.toLowerCase() !== 'retry-after') return null;
              retryAfterReads += 1;
              return '1'; // 1 s; capped to maxRetryAfterMs below so the test stays fast
            },
          },
          text: async () => JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response);
      }
      return realFetch(u, init);
    }, { baseMs: 1, capMs: 1, jitter: 'none', maxRetryAfterMs: 5 });

    const page = await client.listInventory();
    expect(page.items).toEqual([]); // succeeded after the 429 retry
    expect(countOf('GET', '/v1/inventory')).toBe(2);
    expect(retryAfterReads).toBeGreaterThan(0); // the client READ Retry-After (the honored path)
  });

  it('retries a 429 on a WRITE — a 429 is rejected before execution, so re-issuing is safe', async () => {
    let putAttempts = 0;
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'PUT' && path.includes('/v1/intents/')) {
        putAttempts += 1;
        return Promise.resolve(putAttempts === 1 ? statusResp(429, '1') : noContent()); // 429 → retried → 204
      }
      return realFetch(u, init); // auth (challenge/verify) goes to the real backend
    }, { baseMs: 1, jitter: 'none', maxRetryAfterMs: 5 });

    await client.putIntent('00000000-0000-0000-0000-000000000030', 'enc1.c2VlZA==');
    expect(countOf('PUT', '/v1/intents/')).toBe(2); // the write WAS retried on the 429
  });

  it('retries a 503 on a GET but NOT on a write', async () => {
    let getFail = 1;
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'GET' && path.includes('/v1/balances') && getFail-- > 0) return Promise.resolve(statusResp(503));
      if (method === 'PUT' && path.includes('/v1/intents/')) return Promise.resolve(statusResp(503));
      return realFetch(u, init);
    }, { baseMs: 1, jitter: 'none' });

    await client.getBalances();
    expect(countOf('GET', '/v1/balances')).toBe(2); // GET 503 retried

    await expect(
      client.putIntent('00000000-0000-0000-0000-000000000031', 'enc1.c2VlZA=='),
    ).rejects.toBeInstanceOf(WalletApiError);
    expect(countOf('PUT', '/v1/intents/')).toBe(1); // write 503 NOT retried
  });

  it('sanitizes a malformed retry config — a NaN maxAttempts stays bounded, never unbounded', async () => {
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'GET' && path.includes('/v1/inventory')) return Promise.reject(new TypeError('fetch failed'));
      return realFetch(u, init);
    }, { maxAttempts: Number.NaN, baseMs: -1, capMs: -1 } as WalletApiRetryConfig);

    await expect(client.listInventory()).rejects.toBeInstanceOf(WalletApiError);
    const gets = countOf('GET', '/v1/inventory');
    expect(gets).toBeGreaterThanOrEqual(1);
    expect(gets).toBeLessThanOrEqual(3); // NaN → sanitized to the default bound (never an infinite loop)
  });

  it('retry:false disables retry — a transient NETWORK GET is attempted exactly once', async () => {
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'GET' && path.includes('/v1/inventory')) return Promise.reject(new TypeError('fetch failed'));
      return realFetch(u, init);
    }, false);

    await expect(client.listInventory()).rejects.toBeInstanceOf(WalletApiError);
    expect(countOf('GET', '/v1/inventory')).toBe(1);
  });
});
