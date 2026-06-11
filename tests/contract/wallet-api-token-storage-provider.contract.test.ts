/**
 * S7: WalletApiTokenStorageProvider passes the shared storage-provider
 * contract against the in-process fake wallet-api, plus the remote-only S2
 * semantics the local whole-blob provider has no journal for:
 * tombstoned deltas (§5.1), paginated pulls (PAGE_LIMIT/`more` — §16),
 * `syncEpoch` resync + intent re-PUT (§5.4/E.3), write-behind with
 * empty-import protection (§5.1 client guards), and `recoverRemoved()`
 * (§5.3 recovery).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { WalletApiClient } from '../../wallet-api';
import { WalletApiTokenStorageProvider } from '../../impl/shared/wallet-api/WalletApiTokenStorageProvider';
import { deriveFieldEncryptionKey, encryptField } from '../../core/field-encryption';
import type { FullIdentity } from '../../types';
import { FakeWalletApi } from '../support/fake-wallet-api';
import {
  buildTxfData,
  makeTestToken,
  MemoryKeyValueStore,
  testIdentity,
  type TestToken,
} from '../support/wallet-api-test-helpers';
import { describeStorageProviderContract } from './storage-provider.contract';

function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function makeDevice(
  fake: FakeWalletApi,
  baseUrl: string,
  identityIndex: number,
  deviceId: string
): { client: WalletApiClient; provider: WalletApiTokenStorageProvider; pubkey: string } {
  const identity = testIdentity(identityIndex);
  const client = new WalletApiClient({
    baseUrl,
    network: fake.network,
    deviceId,
    storage: new MemoryKeyValueStore(),
  });
  const provider = new WalletApiTokenStorageProvider({
    client,
    stateStore: new MemoryKeyValueStore(),
  });
  provider.setIdentity({
    privateKey: identity.privateKey,
    chainPubkey: identity.chainPubkey,
    l1Address: 'alpha1wallettest',
  } as FullIdentity);
  return { client, provider, pubkey: identity.chainPubkey };
}

async function seedVia(provider: WalletApiTokenStorageProvider, tokens: TestToken[]): Promise<void> {
  const result = await provider.save(buildTxfData(tokens));
  if (!result.success) throw new Error(`seed failed: ${result.error}`);
}

// ── the shared S7 contract ─────────────────────────────────────────────────────

describeStorageProviderContract('WalletApiTokenStorageProvider (fake wallet-api)', async () => {
  const fake = new FakeWalletApi();
  const baseUrl = await fake.start();
  const device = makeDevice(fake, baseUrl, 10, 'contract-device');
  await device.provider.initialize();

  return {
    provider: device.provider,
    seed: (tokens) => seedVia(device.provider, tokens),
    cleanup: () => fake.stop(),
  };
});

// ── remote-only S2 semantics ───────────────────────────────────────────────────

describe('WalletApiTokenStorageProvider — S2 remote semantics', () => {
  let fake: FakeWalletApi;
  let baseUrl: string;

  beforeEach(async () => {
    fake = new FakeWalletApi({ pageLimit: 2 }); // small PAGE_LIMIT to force `more` loops (§16)
    baseUrl = await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it('converges a paginated full pull (PAGE_LIMIT pages + closing delta — §5.1/§16)', async () => {
    const { provider, pubkey } = makeDevice(fake, baseUrl, 20, 'dev-a');
    fake.seedInventory(
      pubkey,
      Array.from({ length: 5 }, (_, i) => {
        const t = makeTestToken({ amount: BigInt(100 + i) });
        return { tokenId: t.tokenId, assets: [{ coinId: t.coinId, amount: t.amount }], blob: t.bytes };
      })
    );

    const view = await provider.listInventory();
    expect(view.items).toHaveLength(5);
    expect(view.more).toBe(false);
  });

  it('a tombstoned delta converges a stale device (§5.1)', async () => {
    const deviceA = makeDevice(fake, baseUrl, 21, 'dev-a');
    const deviceB = makeDevice(fake, baseUrl, 21, 'dev-b'); // same owner, second device
    const t1 = makeTestToken();
    const t2 = makeTestToken();
    await seedVia(deviceA.provider, [t1, t2]);

    // Device B syncs, then goes stale.
    const before = await deviceB.provider.listInventory();
    expect(before.items).toHaveLength(2);

    // Device A spends t1 (unevidenced removal is still accepted — §5.3).
    await deviceA.provider.applyDelta('55555555-5555-4555-8555-555555555555', [t1.tokenId], []);

    // The delta page B pulls carries the tombstone — the only way a stale
    // device learns about the spend (§5.1).
    const delta = await deviceB.provider.listInventory(before.cursor);
    const tombstone = delta.items.find((i) => i.tokenId === t1.tokenId);
    expect(tombstone?.status).toBe('removed');

    // And B's converged active view drops it.
    const after = await deviceB.provider.listInventory();
    expect(after.items.map((i) => i.tokenId)).toEqual([t2.tokenId]);
  });

  it('syncEpoch change → discard cursors, full pull, re-PUT open intents (§5.4/E.3)', async () => {
    const { client, provider, pubkey } = makeDevice(fake, baseUrl, 22, 'dev-a');
    const t = makeTestToken();
    await seedVia(provider, [t]);

    // An open intent, dual-persisted (E.3): server + the client-local copy.
    const key = deriveFieldEncryptionKey(testIdentity(22).privateKey);
    const payload = encryptField(key, JSON.stringify({ sources: [t.tokenId] }));
    const transferId = '66666666-6666-4666-8666-666666666666';
    await client.putIntent(transferId, payload);
    expect(fake.getIntent(pubkey, transferId)?.status).toBe('open');

    // A server restore: epoch bumps and the intents table is lost — the one
    // table not re-derivable from blobs (§5.4).
    fake.bumpSyncEpoch({ dropIntents: true });
    expect(fake.getIntent(pubkey, transferId)).toBeNull();

    // Next sync sees the epoch change → full pull → re-PUT of locally-known
    // open intents (idempotent) before anything resumes.
    const view = await provider.listInventory();
    expect(view.items.map((i) => i.tokenId)).toEqual([t.tokenId]);
    expect(fake.getIntent(pubkey, transferId)).toEqual({ payload, status: 'open' });
  });

  it('empty-import protection: a failed load never pushes removals (§5.1)', async () => {
    const deviceA = makeDevice(fake, baseUrl, 23, 'dev-a');
    const t = makeTestToken();
    await seedVia(deviceA.provider, [t]);

    // A fresh device whose load fails must not be able to "empty" the wallet,
    // even when its local data claims a tombstone.
    const deviceB = makeDevice(fake, baseUrl, 23, 'dev-b');
    fake.setInventoryFailure(true);
    const data = buildTxfData([]);
    data._tombstones = [{ tokenId: t.tokenId, stateHash: '', timestamp: Date.now() }];
    const result = await deviceB.provider.save(data);
    expect(result.success).toBe(false);
    fake.setInventoryFailure(false);

    expect(fake.getRow(deviceA.pubkey, t.tokenId)?.status).toBe('active');
  });

  it('a merely-absent token is never removed by write-behind (§5.1)', async () => {
    const { provider, pubkey } = makeDevice(fake, baseUrl, 24, 'dev-a');
    const t = makeTestToken();
    await seedVia(provider, [t]);

    // A snapshot that simply lacks the token (no tombstone = no confirmed
    // spend) must not push a removal.
    const result = await provider.save(buildTxfData([]));
    expect(result.success).toBe(true);
    expect(fake.getRow(pubkey, t.tokenId)?.status).toBe('active');
  });

  it('a confirmed-spend tombstone IS pushed after a successful load', async () => {
    const { provider, pubkey } = makeDevice(fake, baseUrl, 25, 'dev-a');
    const t = makeTestToken();
    await seedVia(provider, [t]);

    const data = buildTxfData([]);
    data._tombstones = [{ tokenId: t.tokenId, stateHash: '', timestamp: Date.now() }];
    const result = await provider.save(data);
    expect(result.success).toBe(true);
    expect(fake.getRow(pubkey, t.tokenId)?.status).toBe('removed');

    const view = await provider.listInventory();
    expect(view.items).toEqual([]);
  });

  it('recoverRemoved() restores a wiped-but-unspent token (§5.3 recovery)', async () => {
    const { provider, pubkey } = makeDevice(fake, baseUrl, 26, 'dev-a');
    const t1 = makeTestToken();
    const t2 = makeTestToken();
    await seedVia(provider, [t1, t2]);

    // A stolen JWT (another "device" of the same owner) wipes the view: an
    // unevidenced removal — accepted, but the blob is retained (§5.3).
    const thief = makeDevice(fake, baseUrl, 26, 'stolen-jwt');
    await thief.client.applyInventoryDelta({
      transferId: '77777777-7777-4777-8777-777777777777',
      spent: [t1.tokenId],
      added: [],
    });
    expect(fake.getRow(pubkey, t1.tokenId)).toEqual({ status: 'removed', removal: 'unevidenced' });

    // The victim's view converges to the wipe…
    const wiped = await provider.listInventory();
    expect(wiped.items.map((i) => i.tokenId)).toEqual([t2.tokenId]);

    // …and recoverRemoved() re-fetches the tombstoned blob (blob-urls works
    // for own tombstoned rows), re-verifies it locally, and re-adds
    // (reactivation).
    const result = await provider.recoverRemoved();
    expect(result.recovered).toEqual([t1.tokenId]);
    expect(result.spent).toEqual([]);
    expect(fake.getRow(pubkey, t1.tokenId)?.status).toBe('active');

    const restored = await provider.listInventory();
    expect(restored.items.map((i) => i.tokenId).sort()).toEqual([t1.tokenId, t2.tokenId].sort());
  });

  it('recoverRemoved() keeps an evidenced tombstone — server 409 = actually spent (§5.3)', async () => {
    const deviceA = makeDevice(fake, baseUrl, 27, 'dev-a');
    const t = makeTestToken();
    const change = makeTestToken();
    await seedVia(deviceA.provider, [t]);

    // The owner's other device spends t with a change output — the validated
    // change blob is the §5.3 evidence, so the tombstone is EVIDENCED.
    const deviceB = makeDevice(fake, baseUrl, 27, 'dev-b');
    const urls = await deviceB.client.getUploadUrls([
      { sha256: sha256Hex(change.bytes), size: change.bytes.length },
    ]);
    await deviceB.client.uploadBlob(urls[0].putUrl, change.bytes);
    await deviceB.client.applyInventoryDelta({
      transferId: '88888888-8888-4888-8888-888888888888',
      spent: [t.tokenId],
      added: [{ tokenId: change.tokenId, key: urls[0].key }],
    });
    expect(fake.getRow(deviceA.pubkey, t.tokenId)).toEqual({ status: 'removed', removal: 'evidenced' });

    // Device A cannot match the spend (it wasn't its own) — recovery attempts
    // the re-add, the server 409s (evidenced tombstones never reactivate at
    // equal state), and the client keeps the tombstone as "actually spent".
    const result = await deviceA.provider.recoverRemoved();
    expect(result.recovered).toEqual([]);
    expect(result.spent).toEqual([t.tokenId]);
    expect(fake.getRow(deviceA.pubkey, t.tokenId)?.status).toBe('removed');

    const view = await deviceA.provider.listInventory();
    expect(view.items.map((i) => i.tokenId)).toEqual([change.tokenId]);
  });

  it('recoverRemoved() skips the provider’s own known spends', async () => {
    const { provider, pubkey } = makeDevice(fake, baseUrl, 28, 'dev-a');
    const t1 = makeTestToken();
    const t2 = makeTestToken();
    await seedVia(provider, [t1, t2]);

    await provider.applyDelta('99999999-9999-4999-8999-999999999999', [t1.tokenId], []);

    const result = await provider.recoverRemoved();
    expect(result.recovered).toEqual([]);
    expect(result.spent).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(fake.getRow(pubkey, t1.tokenId)?.status).toBe('removed');
  });
});

