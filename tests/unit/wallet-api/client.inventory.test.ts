/**
 * S1 typed REST: §16 inventory/blob/apply endpoints with decimal-string
 * amounts → bigint (§11), PAGE_LIMIT paging, intent write-once/abort/complete
 * semantics, the E.3 local intent copy, and the syncEpoch re-PUT (§5.4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { WalletApiClient, WalletApiError } from '../../../wallet-api';
import { deriveFieldEncryptionKey, encryptField } from '../../../core/field-encryption';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { makeTestToken, MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';

function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('WalletApiClient — inventory & blobs (§16)', () => {
  let fake: FakeWalletApi;
  let client: WalletApiClient;
  const identity = testIdentity(50);

  beforeEach(async () => {
    fake = new FakeWalletApi({ pageLimit: 2 });
    const baseUrl = await fake.start();
    client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-1',
      storage: new MemoryKeyValueStore(),
    });
    client.setIdentity(identity);
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('an amount > 2^53 survives the round-trip exactly (§11 decimal strings → bigint)', async () => {
    const big = 2n ** 60n + 7n; // not representable as a JS number
    const t = makeTestToken({ amount: big });
    fake.seedInventory(identity.chainPubkey, [
      { tokenId: t.tokenId, assets: [{ coinId: t.coinId, amount: big }] },
    ]);

    const page = await client.listInventory();
    expect(page.items[0].assets).toEqual([{ coinId: t.coinId, amount: big }]);

    const balances = await client.getBalances();
    expect(balances).toEqual([{ coinId: t.coinId, total: big, tokenCount: 1 }]);
  });

  it('pages with more:true until the cursor catches up (PAGE_LIMIT — §16)', async () => {
    const tokens = Array.from({ length: 5 }, () => makeTestToken());
    fake.seedInventory(
      identity.chainPubkey,
      tokens.map((t) => ({ tokenId: t.tokenId, assets: [{ coinId: t.coinId, amount: t.amount }] }))
    );

    let page = await client.listInventory();
    expect(page.more).toBe(true);
    expect(page.items).toHaveLength(2);
    const seen = [...page.items];
    while (page.more) {
      page = await client.listInventory(page.cursor);
      seen.push(...page.items);
    }
    expect(seen.map((i) => i.tokenId).sort()).toEqual(tokens.map((t) => t.tokenId).sort());
  });

  it('uploads a blob via upload-urls and treats 412 (already present) as success (§5.2)', async () => {
    const t = makeTestToken();
    const req = { sha256: sha256Hex(t.bytes), size: t.bytes.length };

    const [url1] = await client.getUploadUrls([req]);
    expect(url1.key).toBe(`${fake.network}/t/${req.sha256}`); // content-addressed key (§5.2)
    await client.uploadBlob(url1.putUrl, t.bytes);

    // Second upload of the identical bytes: the store answers 412 — the
    // client treats the upload as already done.
    const [url2] = await client.getUploadUrls([req]);
    await expect(client.uploadBlob(url2.putUrl, t.bytes)).resolves.toBeUndefined();
  });

  it('rejects an upload whose bytes do not match the presigned checksum (§5.2)', async () => {
    const t = makeTestToken();
    const other = makeTestToken();
    const [url] = await client.getUploadUrls([{ sha256: sha256Hex(t.bytes), size: other.bytes.length }]);
    await expect(client.uploadBlob(url.putUrl, other.bytes)).rejects.toThrowError(WalletApiError);
  });

  it('applies a delta and surfaces typed errors (spent ∩ added = 422 — §5.3)', async () => {
    const t = makeTestToken();
    fake.seedInventory(identity.chainPubkey, [
      { tokenId: t.tokenId, assets: [{ coinId: t.coinId, amount: t.amount }], blob: t.bytes },
    ]);

    await expect(
      client.applyInventoryDelta({
        transferId: 'aaaaaaaa-0000-4000-8000-000000000001',
        spent: [t.tokenId],
        added: [{ tokenId: t.tokenId, key: 'x' }],
      })
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    const cursor = await client.applyInventoryDelta({
      transferId: 'aaaaaaaa-0000-4000-8000-000000000002',
      spent: [t.tokenId],
      added: [],
    });
    expect(typeof cursor).toBe('bigint');
    expect(fake.getRow(identity.chainPubkey, t.tokenId)?.status).toBe('removed');
  });

  it('externalDelivery:true records the removal as external (§5.3)', async () => {
    const t = makeTestToken();
    fake.seedInventory(identity.chainPubkey, [
      { tokenId: t.tokenId, assets: [{ coinId: t.coinId, amount: t.amount }], blob: t.bytes },
    ]);
    await client.applyInventoryDelta({
      transferId: 'aaaaaaaa-0000-4000-8000-000000000003',
      spent: [t.tokenId],
      added: [],
      externalDelivery: true,
    });
    expect(fake.getRow(identity.chainPubkey, t.tokenId)).toEqual({ status: 'removed', removal: 'external' });
  });

  it('fetches blob bytes through a signed GET URL (blob-urls — §16)', async () => {
    const t = makeTestToken();
    fake.seedInventory(identity.chainPubkey, [
      { tokenId: t.tokenId, assets: [{ coinId: t.coinId, amount: t.amount }], blob: t.bytes },
    ]);
    const [entry] = await client.getBlobUrls([t.tokenId]);
    expect(entry.tokenId).toBe(t.tokenId);
    const bytes = await client.fetchBlob(entry.getUrl);
    expect(Array.from(bytes)).toEqual(Array.from(t.bytes));
  });
});

describe('WalletApiClient — intents (E.3, §16)', () => {
  let fake: FakeWalletApi;
  let client: WalletApiClient;
  const identity = testIdentity(51);
  const fieldKey = deriveFieldEncryptionKey(identity.privateKey);
  const tid = 'bbbbbbbb-0000-4000-8000-000000000001';

  function envelope(content: string): string {
    return encryptField(fieldKey, content);
  }

  beforeEach(async () => {
    fake = new FakeWalletApi();
    const baseUrl = await fake.start();
    client = new WalletApiClient({
      baseUrl,
      network: fake.network,
      deviceId: 'dev-1',
      storage: new MemoryKeyValueStore(),
    });
    client.setIdentity(identity);
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('putIntent persists the local copy and awaits the server ack', async () => {
    const payload = envelope('{"sources":["a"]}');
    await client.putIntent(tid, payload);
    expect(fake.getIntent(identity.chainPubkey, tid)).toEqual({ payload, status: 'open' });
    expect(await client.listLocalOpenIntents()).toMatchObject([{ transferId: tid, payload }]);
    expect((await client.listIntents('open')).map((i) => i.transferId)).toEqual([tid]);
  });

  it('the local copy survives a failed server PUT (the E.3 restore backstop)', async () => {
    const payload = envelope('{"sources":["b"]}');
    fake.setIntentFailure(true);
    await expect(client.putIntent(tid, payload)).rejects.toThrowError(WalletApiError);
    // Local first: the copy exists even though the server never saw it.
    expect(await client.listLocalOpenIntents()).toMatchObject([{ transferId: tid, payload }]);
    expect(fake.getIntent(identity.chainPubkey, tid)).toBeNull();

    fake.setIntentFailure(false);
    await client.resyncOpenIntents();
    expect(fake.getIntent(identity.chainPubkey, tid)).toEqual({ payload, status: 'open' });
  });

  it('the server rejects a non-envelope or oversize intent payload (§8.3)', async () => {
    await expect(client.putIntent(tid, 'plaintext — not an envelope')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const oversize = envelope('x'.repeat(5000)); // > 4 KiB cap (§7)
    await expect(client.putIntent('bbbbbbbb-0000-4000-8000-000000000099', oversize)).rejects.toMatchObject(
      { code: 'VALIDATION' }
    );
  });

  it('PUT is write-once while open: a different payload is a no-op (§16)', async () => {
    const p1 = envelope('one');
    const p2 = envelope('two');
    await client.putIntent(tid, p1);
    await client.putIntent(tid, p2); // 204, but nothing changes
    expect(fake.getIntent(identity.chainPubkey, tid)?.payload).toBe(p1);
    expect((await client.listLocalOpenIntents())[0].payload).toBe(p1);
  });

  it('abort is soft; re-PUT with the equal payload re-opens; a different payload 409s (§16)', async () => {
    const p1 = envelope('seed');
    await client.putIntent(tid, p1);
    await client.abortIntent(tid);
    expect(fake.getIntent(identity.chainPubkey, tid)?.status).toBe('aborted');
    expect((await client.listIntents('aborted')).map((i) => i.transferId)).toEqual([tid]);

    await client.putIntent(tid, p1); // equal payload → reopened
    expect(fake.getIntent(identity.chainPubkey, tid)?.status).toBe('open');

    await client.abortIntent(tid);
    await expect(client.putIntent(tid, envelope('different'))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('completion wins and never reverts (§16)', async () => {
    await client.putIntent(tid, envelope('seed'));
    await client.completeIntent(tid);
    await client.abortIntent(tid); // aborting a completed intent changes nothing
    expect(fake.getIntent(identity.chainPubkey, tid)?.status).toBe('completed');
    expect(await client.listLocalOpenIntents()).toEqual([]);
  });

  it('inventory/apply completes the intent server-side and in the local copy (§16)', async () => {
    await client.putIntent(tid, envelope('apply-close'));
    await client.applyInventoryDelta({ transferId: tid, spent: [], added: [] });
    expect(fake.getIntent(identity.chainPubkey, tid)?.status).toBe('completed');
    expect(await client.listLocalOpenIntents()).toEqual([]);
  });

  it('a syncEpoch change re-PUTs locally-known open intents (§5.4/E.3)', async () => {
    const payload = envelope('restore-me');
    await client.putIntent(tid, payload);
    await client.listInventory(); // records the current epoch

    // Server restore: epoch bump, intents lost (not re-derivable from blobs).
    fake.bumpSyncEpoch({ dropIntents: true });
    expect(fake.getIntent(identity.chainPubkey, tid)).toBeNull();

    // The next cursor-bearing response reveals the epoch change → the client
    // re-PUTs its locally-known open intents (idempotent).
    await client.listInventory();
    expect(fake.getIntent(identity.chainPubkey, tid)).toEqual({ payload, status: 'open' });
  });
});
