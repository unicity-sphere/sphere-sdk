/**
 * Per-request timeout (#642): a stalled REST request must abort instead of
 * hanging until the browser/OS gives up (during the swap-wallet request storm
 * the starved background-save requests hung indefinitely). The abort surfaces
 * as the transient `NETWORK` error class, so the existing retry policy applies
 * unchanged: idempotent GETs retry, writes fail fast.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

type FetchLike = (
  url: string | URL,
  init?: { method?: string; signal?: AbortSignal }
) => Promise<Response>;

describe('WalletApiClient — per-request timeout (#642)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  const identity = testIdentity(61);

  const realFetch: FetchLike = (u, init) =>
    (globalThis as unknown as { fetch: FetchLike }).fetch(u, init);

  /** A fetch that never answers on `stallPath` but honors the abort signal —
   *  exactly how native fetch behaves on a stalled socket. */
  function stallingFetch(stallPath: string, seen: { signal?: AbortSignal }[]): FetchLike {
    return (u, init) => {
      if (String(u).includes(stallPath)) {
        seen.push({ signal: init?.signal });
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      }
      return realFetch(u, init);
    };
  }

  function makeClient(fetchFn: FetchLike, requestTimeoutMs?: number): WalletApiClient {
    const client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-timeout',
      storage: new MemoryKeyValueStore(),
      fetchFn: fetchFn as never,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      retry: false, // isolate the timeout behavior from the retry policy
    });
    client.setIdentity(identity);
    return client;
  }

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('aborts a stalled GET after the configured timeout and surfaces NETWORK', async () => {
    const seen: { signal?: AbortSignal }[] = [];
    const client = makeClient(stallingFetch('/v1/inventory', seen), 100);

    const started = Date.now();
    await expect(client.listInventory()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(Date.now() - started).toBeLessThan(5_000); // aborted, not hung
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a timed-out GET like any transient NETWORK failure', async () => {
    let stalls = 1; // stall the first attempt, answer the second
    const seen: { signal?: AbortSignal }[] = [];
    const stalling = stallingFetch('/v1/inventory', seen);
    const fetchFn: FetchLike = (u, init) => {
      if (String(u).includes('/v1/inventory') && stalls-- > 0) return stalling(u, init);
      return realFetch(u, init);
    };
    const client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-timeout-retry',
      storage: new MemoryKeyValueStore(),
      fetchFn: fetchFn as never,
      requestTimeoutMs: 100,
      retry: { maxAttempts: 2, baseMs: 1, capMs: 1 },
    });
    client.setIdentity(identity);

    const page = await client.listInventory();
    expect(page.items).toEqual([]); // recovered on the retry
  });

  it('passes no signal when the timeout is disabled (0)', async () => {
    const seen: { signal?: AbortSignal }[] = [];
    let answered = false;
    const fetchFn: FetchLike = (u, init) => {
      if (String(u).includes('/v1/inventory') && !answered) {
        answered = true;
        seen.push({ signal: init?.signal });
      }
      return realFetch(u, init);
    };
    const client = makeClient(fetchFn, 0);

    await client.listInventory();
    expect(seen[0]?.signal).toBeUndefined();
  });

  it('still aborts on runtimes without AbortSignal.timeout (the #617 older-WebView guard)', async () => {
    // iOS 15 / older Android WebViews lack AbortSignal.timeout — the client
    // must fall back to timeoutSignal's AbortController path, not crash.
    const original = AbortSignal.timeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).timeout = undefined;
    try {
      const seen: { signal?: AbortSignal }[] = [];
      const client = makeClient(stallingFetch('/v1/inventory', seen), 100);
      await expect(client.listInventory()).rejects.toMatchObject({ code: 'NETWORK' });
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal); // fallback signal supplied
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it('sanitizes a nonsensical timeout back to the default instead of hanging or throwing', async () => {
    // NaN must not silently disable the timeout (NaN > 0 is false — it would).
    const seen: { signal?: AbortSignal }[] = [];
    const fetchFn: FetchLike = (u, init) => {
      if (String(u).includes('/v1/inventory') && seen.length === 0) {
        seen.push({ signal: init?.signal });
      }
      return realFetch(u, init);
    };
    const client = makeClient(fetchFn, Number.NaN);

    await client.listInventory();
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal); // default applied
  });
});
