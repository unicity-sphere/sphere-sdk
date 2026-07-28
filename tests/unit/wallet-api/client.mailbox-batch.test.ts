/**
 * `WalletApiClient.depositMailboxBatch` (§6/§16, #111): one request deposits a
 * whole send's blobs to one recipient — all-or-nothing on the server, results
 * in request order, idempotent by the entries' content-derived entry_ids (so
 * NETWORK/503 retry is safe — pinned here like inventory/apply's, #664). A
 * pre-#111 deployment answers 404 NOT_FOUND, the callers' fallback signal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { WalletApiClient, WalletApiError, type MailboxDepositRequest } from '../../../wallet-api';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, makeTestToken, testIdentity, type TestToken } from '../../support/wallet-api-test-helpers';

type FetchLike = (url: string | URL, init?: { method?: string }) => Promise<Response>;

function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

const TRANSFER_ID = '00000000-0000-0000-0000-000000000699';

describe('WalletApiClient — depositMailboxBatch (§16 #111)', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;
  const sender = testIdentity(61);
  const recipient = testIdentity(62);
  const calls: { method: string; path: string }[] = [];
  let flaky: ((method: string, path: string) => Response | 'drop' | null) | null = null;

  const realFetch: FetchLike = (u, init) =>
    (globalThis as unknown as { fetch: FetchLike }).fetch(u, init);

  let client: WalletApiClient;

  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
    calls.length = 0;
    flaky = null;
    client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-batch',
      storage: new MemoryKeyValueStore(),
      fetchFn: ((u: string | URL, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        const path = String(u);
        calls.push({ method, path });
        const intercepted = flaky?.(method, path);
        if (intercepted === 'drop') return Promise.reject(new TypeError('fetch failed'));
        if (intercepted) return Promise.resolve(intercepted);
        return realFetch(u, init as never);
      }) as never,
    });
    client.setIdentity(sender);
  });
  afterEach(async () => {
    await fake.stop();
  });

  /** Upload a token's WIRE (inner) bytes and build its batch entry. */
  async function uploadedEntry(token: TestToken): Promise<MailboxDepositRequest> {
    const wire = token.blob.token;
    const [url] = await client.getUploadUrls([{ sha256: sha256Hex(wire), size: wire.length }]);
    await client.uploadBlob(url.putUrl, wire);
    return {
      recipientPubkey: recipient.chainPubkey,
      key: url.key,
      transferId: TRANSFER_ID,
      stateHash: sha256Hex(wire),
      tokenId: token.tokenId,
    };
  }

  it('serializes entries verbatim (memo omitted when absent) and parses request-ordered results', async () => {
    const entries = [await uploadedEntry(makeTestToken()), await uploadedEntry(makeTestToken())];

    const results = await client.depositMailboxBatch(entries);
    expect(results).toHaveLength(2);
    // request order, content-derived ids, seq parsed to bigint
    results.forEach((r, i) => {
      const expectedId = sha256Hex(
        Uint8Array.from([
          ...Buffer.from(entries[i].tokenId, 'hex'),
          ...Buffer.from(entries[i].stateHash, 'hex'),
        ]),
      );
      expect(r.entryId).toBe(expectedId);
      expect(r.seq).toBe(BigInt(i + 1));
    });

    const batchPosts = calls.filter((c) => c.method === 'POST' && c.path.includes('/v1/mailbox/batch'));
    expect(batchPosts).toHaveLength(1);
  });

  it('a full replay returns the identical results — idempotent by entry_id, no seq consumed', async () => {
    const entries = [await uploadedEntry(makeTestToken()), await uploadedEntry(makeTestToken())];
    const first = await client.depositMailboxBatch(entries);
    const replay = await client.depositMailboxBatch(entries);
    expect(replay).toEqual(first);
  });

  it('DOES retry on a transient NETWORK failure — idempotent by content-derived entry_ids', async () => {
    const entries = [await uploadedEntry(makeTestToken())];
    let drops = 1;
    flaky = (method, path) =>
      method === 'POST' && path.includes('/v1/mailbox/batch') && drops-- > 0 ? 'drop' : null;

    const results = await client.depositMailboxBatch(entries);
    expect(results).toHaveLength(1); // succeeded AFTER the retry

    const batchPosts = calls.filter((c) => c.method === 'POST' && c.path.includes('/v1/mailbox/batch'));
    expect(batchPosts).toHaveLength(2); // first dropped → retried → succeeded
  });

  it('DOES retry on a 503, honoring the idempotent-write policy', async () => {
    const entries = [await uploadedEntry(makeTestToken())];
    let unavailable = 1;
    flaky = (method, path) =>
      method === 'POST' && path.includes('/v1/mailbox/batch') && unavailable-- > 0
        ? new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'restarting' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        : null;

    const results = await client.depositMailboxBatch(entries);
    expect(results).toHaveLength(1);
    const batchPosts = calls.filter((c) => c.method === 'POST' && c.path.includes('/v1/mailbox/batch'));
    expect(batchPosts).toHaveLength(2);
  });

  it('surfaces a pre-#111 deployment as NOT_FOUND — the callers’ per-entry fallback signal', async () => {
    fake.setMailboxBatchRoute(false);
    const entries = [await uploadedEntry(makeTestToken())];
    const err = await client.depositMailboxBatch(entries).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WalletApiError);
    expect((err as WalletApiError).code).toBe('NOT_FOUND');
  });

  it('a malformed response (missing entryId) is a PROTOCOL error', async () => {
    const entries = [await uploadedEntry(makeTestToken())];
    flaky = (method, path) =>
      method === 'POST' && path.includes('/v1/mailbox/batch')
        ? new Response(JSON.stringify({ entries: [{ seq: '1' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : null;

    const err = await client.depositMailboxBatch(entries).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WalletApiError);
    expect((err as WalletApiError).code).toBe('PROTOCOL');
  });
});
