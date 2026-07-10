/**
 * Transient NETWORK retry: a dropped/reset connection (e.g. a backend resetting mid-read under load —
 * the swap-wallet inventory-sync ECONNRESET) should be retried for IDEMPOTENT GETs, but NEVER for
 * writes (a lost-response retry could double-apply). Verified by injecting a flaky fetchFn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

type FetchLike = (url: string | URL, init?: { method?: string }) => Promise<Response>;

describe('WalletApiClient — transient NETWORK retry (GET only)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  const identity = testIdentity(51);
  const calls: { method: string; path: string }[] = [];

  const realFetch: FetchLike = (u, init) =>
    (globalThis as unknown as { fetch: FetchLike }).fetch(u, init);

  function makeClient(fetchFn: FetchLike): WalletApiClient {
    const client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-retry',
      storage: new MemoryKeyValueStore(),
      fetchFn: fetchFn as never,
    });
    client.setIdentity(identity);
    return client;
  }

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
    calls.length = 0;
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('retries an idempotent GET on a transient NETWORK failure and succeeds', async () => {
    let failInventory = 1; // drop the connection once, then let it through
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'GET' && path.includes('/v1/inventory') && failInventory-- > 0) {
        return Promise.reject(new TypeError('fetch failed')); // ECONNRESET-style
      }
      return realFetch(u, init);
    });

    const page = await client.listInventory();
    expect(page.items).toEqual([]); // empty inventory, but the call SUCCEEDED after the retry

    const inventoryGets = calls.filter((c) => c.method === 'GET' && c.path.includes('/v1/inventory'));
    expect(inventoryGets).toHaveLength(2); // first dropped → retried → succeeded
  });

  it('gives up after the bounded attempts when the GET keeps failing', async () => {
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'GET' && path.includes('/v1/inventory')) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return realFetch(u, init);
    });

    await expect(client.listInventory()).rejects.toBeInstanceOf(WalletApiError);
    const inventoryGets = calls.filter((c) => c.method === 'GET' && c.path.includes('/v1/inventory'));
    expect(inventoryGets.length).toBeGreaterThan(1); // bounded retries were attempted
    expect(inventoryGets.length).toBeLessThanOrEqual(3);
  });

  it('does NOT retry a NON-idempotent write on a NETWORK failure — a lost-response retry could double-apply', async () => {
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'PUT' && path.includes('/v1/intents/')) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return realFetch(u, init);
    });

    await expect(
      client.putIntent('00000000-0000-0000-0000-000000000001', 'enc1.c2VlZA=='),
    ).rejects.toBeInstanceOf(WalletApiError);

    const intentPuts = calls.filter((c) => c.method === 'PUT' && c.path.includes('/v1/intents/'));
    expect(intentPuts).toHaveLength(1); // attempted exactly once — non-idempotent writes are not retried
  });

  it('DOES retry inventory/apply on a NETWORK failure — idempotent by transferId, safe to replay (#664)', async () => {
    let failApply = 1; // drop the connection once, then let it through
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'POST' && path.includes('/v1/inventory/apply') && failApply-- > 0) {
        return Promise.reject(new TypeError('fetch failed')); // ECONNRESET-style on the write
      }
      return realFetch(u, init);
    });

    // An empty apply is a no-op that still exercises the write path + retry.
    const cursor = await client.applyInventoryDelta({
      transferId: '00000000-0000-0000-0000-000000000664',
      spent: [],
      added: [],
    });
    expect(typeof cursor).toBe('bigint'); // succeeded AFTER the retry

    const applies = calls.filter((c) => c.method === 'POST' && c.path.includes('/v1/inventory/apply'));
    expect(applies).toHaveLength(2); // first dropped → retried → succeeded
  });

  it('gives up on inventory/apply after the bounded attempts when it keeps failing', async () => {
    const client = makeClient((u, init) => {
      const method = init?.method ?? 'GET';
      const path = String(u);
      calls.push({ method, path });
      if (method === 'POST' && path.includes('/v1/inventory/apply')) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return realFetch(u, init);
    });

    await expect(
      client.applyInventoryDelta({ transferId: '00000000-0000-0000-0000-000000000665', spent: [], added: [] }),
    ).rejects.toBeInstanceOf(WalletApiError);
    const applies = calls.filter((c) => c.method === 'POST' && c.path.includes('/v1/inventory/apply'));
    expect(applies.length).toBeGreaterThan(1);
    expect(applies.length).toBeLessThanOrEqual(3); // bounded
  });
});
