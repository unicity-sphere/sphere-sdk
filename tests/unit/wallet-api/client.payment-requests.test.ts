/**
 * S4 payment requests over the §16 endpoints (backend M4), against the fake:
 * create → the payer's gap-free ?since=<seq> stream (bigint cursor) → respond,
 * the outgoing ?before= keyset backfill (opaque string cursor, null when
 * drained), respond semantics (403 addressee-only / 409 open-only / 422
 * shape), the §5.5 per-payer open cap (429 QUOTA_EXCEEDED), server-owned
 * expiry, decimal-string amounts > 2^53, and the S6 memo envelope
 * round-tripping across two clients of the same wallet key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import { signMessage } from '../../../core/crypto';
import { deriveFieldEncryptionKey, decryptField, encryptField } from '../../../core/field-encryption';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

const REQUESTER = testIdentity(60);
const PAYER = testIdentity(61);
const STRANGER = testIdentity(62);
const COIN = 'c0'.repeat(32);

let fake: FakeWalletApi;
let baseUrl = '';

function makeClient(identity: { privateKey: string; chainPubkey: string }, deviceId: string): WalletApiClient {
  const client = new WalletApiClient({
    baseUrl,
    network: fake.network,
    deviceId,
    storage: new MemoryKeyValueStore(),
  });
  client.setIdentity(identity);
  return client;
}

/** Raw challenge→sign→verify (for asserting the fake's HTTP contract directly). */
async function rawJwt(identity: { privateKey: string; chainPubkey: string }): Promise<string> {
  const challengeRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey: identity.chainPubkey }),
  });
  const { nonce, challenge } = (await challengeRes.json()) as { nonce: string; challenge: string };
  const verifyRes = await fetch(`${baseUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, signature: signMessage(identity.privateKey, challenge), deviceId: 'raw-dev' }),
  });
  return ((await verifyRes.json()) as { jwt: string }).jwt;
}

afterEach(async () => {
  await fake.stop();
});

describe('WalletApiClient — payment requests (§10/§16, paging + amounts)', () => {
  beforeEach(async () => {
    fake = new FakeWalletApi({ pageLimit: 2 });
    baseUrl = await fake.start();
  });

  it('create → the payer tails ?since= gap-free; an amount > 2^53 survives exactly (§11)', async () => {
    const requester = makeClient(REQUESTER, 'dev-r');
    const payer = makeClient(PAYER, 'dev-p');
    const big = 2n ** 60n + 7n; // not representable as a JS number
    const expiresAt = Date.now() + 3_600_000;

    const created = await requester.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: big }],
      expiresAt,
    });
    expect(created.seq).toBe(1n);
    expect(created.status).toBe('open');
    expect(created.fromPubkey).toBe(REQUESTER.chainPubkey);
    expect(created.toPubkey).toBe(PAYER.chainPubkey);
    expect(created.transferId).toBeNull();
    expect(created.assets).toEqual([{ coinId: COIN, amount: big }]);
    expect(created.expiresAt).toBe(new Date(expiresAt).getTime());

    for (let i = 0; i < 2; i++) {
      await requester.createPaymentRequest({
        toPubkey: PAYER.chainPubkey,
        assets: [{ coinId: COIN, amount: 5n }],
      });
    }

    // PAGE_LIMIT 2: the first page truncates with cursor = last returned seq…
    let page = await payer.listPaymentRequests({ role: 'incoming', since: 0n });
    expect(page.role).toBe('incoming');
    expect(page.more).toBe(true);
    expect(page.requests.map((r) => r.seq)).toEqual([1n, 2n]);
    expect(page.cursor).toBe(2n);
    expect(page.requests[0].assets[0].amount).toBe(big); // exact round-trip

    // …and the tail drains gap-free to the seq counter.
    page = await payer.listPaymentRequests({ role: 'incoming', since: page.cursor });
    expect(page.more).toBe(false);
    expect(page.requests.map((r) => r.seq)).toEqual([3n]);
    expect(page.cursor).toBe(3n);

    // Role views are isolated: the payer sent nothing, the requester received nothing.
    expect((await requester.listPaymentRequests({ role: 'incoming' })).requests).toEqual([]);
    expect((await payer.listPaymentRequests({ role: 'outgoing' })).requests).toEqual([]);
  });

  it('outgoing is a newest-first ?before= keyset backfill — opaque cursor, null when drained (§16)', async () => {
    const requester = makeClient(REQUESTER, 'dev-r');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        (
          await requester.createPaymentRequest({
            toPubkey: PAYER.chainPubkey,
            assets: [{ coinId: COIN, amount: BigInt(i + 1) }],
          })
        ).id
      );
    }

    const first = await requester.listPaymentRequests({ role: 'outgoing' });
    expect(first.role).toBe('outgoing');
    expect(first.more).toBe(true);
    expect(first.requests).toHaveLength(2);
    expect(typeof first.cursor).toBe('string');

    const second = await requester.listPaymentRequests({ role: 'outgoing', before: first.cursor! });
    expect(second.more).toBe(false);
    expect(second.cursor).toBeNull();
    const seen = [...first.requests, ...second.requests].map((r) => r.id);
    expect(seen.sort()).toEqual([...ids].sort());
    // Newest-first: every page-1 row was created at-or-after every page-2 row.
    expect(first.requests[0].createdAt).toBeGreaterThanOrEqual(second.requests[0].createdAt);
  });
});

describe('WalletApiClient — respond semantics (§10/§16)', () => {
  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
  });

  it('addressee-only (403), unknown id (404), open-only (409); paid links the transferId', async () => {
    const requester = makeClient(REQUESTER, 'dev-r');
    const payer = makeClient(PAYER, 'dev-p');
    const stranger = makeClient(STRANGER, 'dev-s');
    const { id } = await requester.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: 5n }],
    });
    const transferId = crypto.randomUUID();

    // §10: neither a stranger nor the requester may respond.
    await expect(stranger.respondPaymentRequest(id, { action: 'paid', transferId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(requester.respondPaymentRequest(id, { action: 'paid', transferId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      payer.respondPaymentRequest(crypto.randomUUID(), { action: 'declined' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(fake.getPaymentRequest(id)?.status).toBe('open'); // none of the above touched it

    const paid = await payer.respondPaymentRequest(id, { action: 'paid', transferId });
    expect(paid.status).toBe('paid');
    expect(paid.transferId).toBe(transferId);
    expect(fake.getPaymentRequest(id)).toMatchObject({ status: 'paid', transferId });

    // Respond is open-only — paid is terminal.
    await expect(payer.respondPaymentRequest(id, { action: 'declined' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });

    // Declined path + status filter on the incoming stream.
    const second = await requester.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: 5n }],
    });
    const declined = await payer.respondPaymentRequest(second.id, { action: 'declined' });
    expect(declined.status).toBe('declined');
    expect(declined.transferId).toBeNull();
    const filtered = await payer.listPaymentRequests({ role: 'incoming', status: 'declined', since: 0n });
    expect(filtered.requests.map((r) => r.id)).toEqual([second.id]);
  });

  it('the wire-level 422 contract: transferId pairing and role × cursor mixing are rejected (§16)', async () => {
    const requester = makeClient(REQUESTER, 'dev-r');
    const { id } = await requester.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: 5n }],
    });

    // The typed client makes these unrepresentable — assert the FAKE mirrors
    // the real backend (payments.test.ts M4.2) at the HTTP layer.
    const jwt = await rawJwt(PAYER);
    const post = async (path: string, body: unknown): Promise<{ status: number; code: string }> => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
        body: JSON.stringify(body),
      });
      const parsed = (await res.json()) as { error: { code: string } };
      return { status: res.status, code: parsed.error.code };
    };
    const get = async (query: string): Promise<{ status: number; code: string }> => {
      const res = await fetch(`${baseUrl}/v1/payment-requests?${query}`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      const parsed = (await res.json()) as { error: { code: string } };
      return { status: res.status, code: parsed.error.code };
    };

    // paid requires a transferId; declined forbids one (§16) — checked before the lookup.
    expect(await post(`/v1/payment-requests/${id}/respond`, { action: 'paid' })).toEqual({
      status: 422,
      code: 'VALIDATION_FAILED',
    });
    expect(
      await post(`/v1/payment-requests/${id}/respond`, { action: 'declined', transferId: crypto.randomUUID() })
    ).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    // The role × cursor families never mix, and role is mandatory.
    expect(await get('role=outgoing&since=1')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await get('role=incoming&before=abc')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(await get('since=0')).toEqual({ status: 422, code: 'VALIDATION_FAILED' });
    expect(fake.getPaymentRequest(id)?.status).toBe('open'); // nothing above touched it
  });

  it('server-owned expiry (§10): the sweep flips overdue requests; respond on expired → 409', async () => {
    const requester = makeClient(REQUESTER, 'dev-r');
    const payer = makeClient(PAYER, 'dev-p');
    const overdue = await requester.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: 5n }],
      expiresAt: Date.now() - 1000, // already past — LEGAL; the sweep owns the flip
    });
    const everlasting = await requester.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: 5n }],
    });
    expect(fake.getPaymentRequest(overdue.id)?.status).toBe('open'); // not client-inferred

    expect(fake.expireDuePaymentRequests()).toBe(1);
    expect(fake.getPaymentRequest(overdue.id)?.status).toBe('expired');
    expect(fake.getPaymentRequest(everlasting.id)?.status).toBe('open');

    // The payer's seq stream reflects the server-owned status change.
    const incoming = await payer.listPaymentRequests({ role: 'incoming', since: 0n });
    expect(incoming.requests.find((r) => r.id === overdue.id)?.status).toBe('expired');

    await expect(
      payer.respondPaymentRequest(overdue.id, { action: 'paid', transferId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });
});

describe('WalletApiClient — §5.5 per-payer open cap', () => {
  beforeEach(async () => {
    fake = new FakeWalletApi({ maxPayerOpenRequests: 2 });
    baseUrl = await fake.start();
  });

  it('the cap binds across requesters → 429 QUOTA_EXCEEDED; responding frees capacity; seq stays gap-free', async () => {
    const r1 = makeClient(REQUESTER, 'dev-r1');
    const r2 = makeClient(STRANGER, 'dev-r2');
    const payer = makeClient(PAYER, 'dev-p');
    const mk = (client: WalletApiClient, toPubkey: string) =>
      client.createPaymentRequest({ toPubkey, assets: [{ coinId: COIN, amount: 5n }] });

    const first = await mk(r1, PAYER.chainPubkey);
    await mk(r1, PAYER.chainPubkey);
    // The cap is per PAYER: a different requester is bounded by the same bucket…
    let capErr: WalletApiError | null = null;
    await mk(r2, PAYER.chainPubkey).catch((err: WalletApiError) => {
      capErr = err;
    });
    expect(capErr).toBeInstanceOf(WalletApiError);
    expect(capErr!).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(capErr!.message).toContain('QUOTA_EXCEEDED');
    // …and other payers are unaffected.
    await expect(mk(r2, REQUESTER.chainPubkey)).resolves.toMatchObject({ status: 'open' });

    // A response frees capacity — only OPEN requests count toward the cap (§10).
    await payer.respondPaymentRequest(first.id, { action: 'declined' });
    await expect(mk(r2, PAYER.chainPubkey)).resolves.toMatchObject({ status: 'open' });

    // §16 upsert + gap-free through the cap bounce: the 429 burned no seq; the declined
    // `first` re-surfaces at a fresh seq above its creation slot (1 → 3); the freed create → 4.
    const incoming = await payer.listPaymentRequests({ role: 'incoming', since: 0n });
    expect(incoming.requests.map((r) => ({ seq: r.seq, status: r.status }))).toEqual([
      { seq: 2n, status: 'open' },
      { seq: 3n, status: 'declined' },
      { seq: 4n, status: 'open' },
    ]);
    expect(incoming.requests.find((r) => r.id === first.id)).toMatchObject({ seq: 3n, status: 'declined' });
  });
});

describe('WalletApiClient — S6 memo envelope (§8.3)', () => {
  beforeEach(async () => {
    fake = new FakeWalletApi();
    baseUrl = await fake.start();
  });

  it('round-trips across two clients of the same wallet key; stored verbatim, opaque to the payer', async () => {
    const deviceA = makeClient(REQUESTER, 'dev-a');
    const plaintext = 'lunch money — table 7';
    const envelope = encryptField(deriveFieldEncryptionKey(REQUESTER.privateKey), plaintext);

    const { id } = await deviceA.createPaymentRequest({
      toPubkey: PAYER.chainPubkey,
      assets: [{ coinId: COIN, amount: 25n }],
      memo: envelope,
    });

    // The server stores the exact envelope bytes — never plaintext (§8.3).
    const stored = fake.getPaymentRequest(id)?.memo;
    expect(stored).toBe(envelope);
    expect(stored).not.toContain('lunch');

    // A SECOND device of the same wallet derives the same key and decrypts.
    const deviceB = makeClient(REQUESTER, 'dev-b');
    const outgoing = await deviceB.listPaymentRequests({ role: 'outgoing' });
    expect(outgoing.requests[0].memo).toBe(envelope);
    expect(decryptField(deriveFieldEncryptionKey(REQUESTER.privateKey), outgoing.requests[0].memo!)).toBe(
      plaintext
    );

    // The payer sees the verbatim envelope but CANNOT decrypt it (wallet-scoped key).
    const payer = makeClient(PAYER, 'dev-p');
    const incoming = await payer.listPaymentRequests({ role: 'incoming', since: 0n });
    expect(incoming.requests[0].memo).toBe(envelope);
    expect(() => decryptField(deriveFieldEncryptionKey(PAYER.privateKey), incoming.requests[0].memo!)).toThrow();

    // An envelope over the 4096-byte cap is rejected server-side (§8.3).
    await expect(
      deviceA.createPaymentRequest({
        toPubkey: PAYER.chainPubkey,
        assets: [{ coinId: COIN, amount: 1n }],
        memo: encryptField(deriveFieldEncryptionKey(REQUESTER.privateKey), 'x'.repeat(5000)),
      })
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
  });
});
