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
import { WalletApiClient, WalletApiError } from '../../wallet-api';
import { WalletApiTokenStorageProvider } from '../../impl/shared/wallet-api/WalletApiTokenStorageProvider';
import { deriveFieldEncryptionKey, encryptField } from '../../core/field-encryption';
import type { FullIdentity } from '../../types';
import type { TokenBlob } from '../../token-engine/types';
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
  deviceId: string,
  /**
   * The on-chain spent oracle recoverRemoved fail-closes on (mirrors the engine's
   * `isSpent`, wired at composition in prod / the harness). A test supplies a set of
   * tokenIds it considers spent-on-chain; recoverRemoved reactivates only tokens NOT in it.
   * When omitted, recoverRemoved is a safe no-op (never reactivates) — the unwired default.
   */
  spentOnChain?: ReadonlySet<string>
): {
  client: WalletApiClient;
  provider: WalletApiTokenStorageProvider;
  pubkey: string;
  stateStore: MemoryKeyValueStore;
} {
  const identity = testIdentity(identityIndex);
  const client = new WalletApiClient({
    baseUrl,
    network: fake.network,
    deviceId,
    storage: new MemoryKeyValueStore(),
  });
  const stateStore = new MemoryKeyValueStore();
  const provider = new WalletApiTokenStorageProvider({
    client,
    stateStore,
    ...(spentOnChain
      ? { isSpent: (blob: TokenBlob): Promise<boolean> => Promise.resolve(spentOnChain.has(blob.tokenId)) }
      : {}),
  });
  provider.setIdentity({
    privateKey: identity.privateKey,
    chainPubkey: identity.chainPubkey,
  } as FullIdentity);
  return { client, provider, pubkey: identity.chainPubkey, stateStore };
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

  it('a write-behind lineage CONFLICT is a benign no-op — save() converges and reports success (#663)', async () => {
    const { client, provider } = makeDevice(fake, baseUrl, 22, 'dev-conflict');
    await provider.initialize();

    // Force the write-behind apply into a §5.3 lineage conflict (server holds
    // an equal/newer or evidenced-tombstoned state). This is a routine
    // concurrency outcome — the on-chain send already happened; the mirror is
    // simply stale — so save() must treat it as success, not a degraded failure.
    let applyCalls = 0;
    client.applyInventoryDelta = async () => {
      applyCalls += 1;
      throw new WalletApiError(
        'POST /v1/inventory/apply: CONFLICT lineage conflict for token [hex]',
        'CONFLICT'
      );
    };

    const result = await provider.save(buildTxfData([makeTestToken()]));
    expect(result.success).toBe(true);
    expect(applyCalls).toBeGreaterThan(0); // the push really attempted the apply
  });

  it('a genuine (non-CONFLICT) apply error still fails the save', async () => {
    const { client, provider } = makeDevice(fake, baseUrl, 23, 'dev-neterr');
    await provider.initialize();
    client.applyInventoryDelta = async () => {
      throw new WalletApiError('inventory/apply request failed', 'NETWORK');
    };
    const result = await provider.save(buildTxfData([makeTestToken()]));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/apply request failed/);
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

  // #679 SPHERE-4: the durable suspected-spent overlay is authoritative on the
  // DELTA path too, not just the full snapshot (snapshotView). Before the fix a
  // delta page (`listInventory(cursor)`) was applied to the view and returned
  // RAW, so a demoted source could be served as spendable and a delta tombstone
  // never pruned the overlay key.
  const overlayKey = (identityIndex: number): string =>
    `wallet-api-storage:suspectedSpent:${fake.network}:${testIdentity(identityIndex).chainPubkey}`;

  it('a demoted token served on a DELTA page is stamped suspectedSpent, not spendable (#679)', async () => {
    const deviceA = makeDevice(fake, baseUrl, 40, 'dev-a');
    const deviceB = makeDevice(fake, baseUrl, 40, 'dev-b'); // same owner, second device
    const t1 = makeTestToken();
    await seedVia(deviceA.provider, [t1]);

    // Device B converges — t1 is active and NOT demoted yet.
    const before = await deviceB.provider.listInventory();
    expect(before.items.find((i) => i.tokenId === t1.tokenId)?.suspectedSpent).toBeUndefined();

    // A #625 client-side demotion on device B (a TransferConflictError proved
    // the source spent on-chain): recorded on the durable per-device overlay.
    await deviceB.provider.markSuspectedSpent(t1.tokenId);

    // A consumer replaying a delta that re-carries t1 as an ACTIVE row (a
    // lagging device draining from an older cursor) must see it STAMPED — the
    // overlay is authoritative on the delta path, exactly like the snapshot.
    const delta = await deviceB.provider.listInventory(0n);
    const row = delta.items.find((i) => i.tokenId === t1.tokenId);
    expect(row?.status).toBe('active');
    expect(row?.suspectedSpent).toBe(true); // raw delta row before the fix → undefined
  });

  it('a tombstone arriving on the DELTA path prunes the overlay — a later re-add is NOT shadowed (#679)', async () => {
    const deviceA = makeDevice(fake, baseUrl, 41, 'dev-a');
    // t1's removal here is an unevidenced (reactivatable) flip, not a genuine on-chain
    // spend — so isSpent reports it UNSPENT and recoverRemoved may re-add it.
    const deviceB = makeDevice(fake, baseUrl, 41, 'dev-b', new Set()); // same owner, second device
    const t1 = makeTestToken();
    await seedVia(deviceA.provider, [t1]);

    // Device B converges and demotes t1 client-side (durable overlay).
    const before = await deviceB.provider.listInventory();
    await deviceB.provider.markSuspectedSpent(t1.tokenId);
    expect(await deviceB.stateStore.get(overlayKey(41))).toBe(JSON.stringify([t1.tokenId]));

    // Device A legitimately spends t1 (its other device) → a real tombstone.
    // Device B learns it ONLY via a delta page — the overlay must be pruned
    // there (t1 left the active view), or it would shadow a later re-add.
    await deviceA.provider.applyDelta('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [t1.tokenId], []);
    const delta = await deviceB.provider.listInventory(before.cursor);
    expect(delta.items.find((i) => i.tokenId === t1.tokenId)?.status).toBe('removed');
    expect(await deviceB.stateStore.get(overlayKey(41))).toBeNull(); // overlay kept t1 before the fix

    // t1 is later legitimately re-added (recovery/reactivation). With the
    // overlay pruned it returns SPENDABLE — the stale demotion no longer
    // shadows it. Before the fix the un-pruned overlay re-stamps it on the next
    // full snapshot, re-hiding a healthy token forever.
    const recovered = await deviceB.provider.recoverRemoved();
    expect(recovered.recovered).toContain(t1.tokenId);
    const restored = await deviceB.provider.listInventory();
    const row = restored.items.find((i) => i.tokenId === t1.tokenId);
    expect(row?.status).toBe('active');
    expect(row?.suspectedSpent).toBeFalsy();
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

  it('a confirmed-spend tombstone IS pushed after a successful load (evidence-race desync repair)', async () => {
    const { provider, pubkey, client } = makeDevice(fake, baseUrl, 25, 'dev-a');
    const t = makeTestToken();
    await seedVia(provider, [t]);

    // The row's current protocol state — the value pushRemovals matches the spend against.
    const rowStateHash = (await provider.listInventory()).items.find((i) => i.tokenId === t.tokenId)!.stateHash!;
    expect(rowStateHash).toBeTruthy();

    // Record an AUTHORITATIVE (composite) spend for t at that exact state, WITHOUT removing
    // the server row: the client apply is a no-op, simulating the evidence-race desync where
    // the spend's server removal did not stick and the row is left ACTIVE.
    const realApply = client.applyInventoryDelta.bind(client);
    client.applyInventoryDelta = (async () => 0n) as typeof client.applyInventoryDelta;
    await provider.applyDelta('55555555-5555-4555-8555-555555555555', [t.tokenId], [], {
      spentStates: [{ tokenId: t.tokenId, stateHash: rowStateHash }],
    });
    client.applyInventoryDelta = realApply;
    expect(fake.getRow(pubkey, t.tokenId)?.status).toBe('active'); // the desync: still active

    // A save with the local tombstone repairs it: pushRemovals PROVES the spend (the composite
    // knownSpend matches the active row's state) and pushes the removal — a token-id-only or
    // unproven tombstone would be skipped (fail-closed).
    const data = buildTxfData([]);
    data._tombstones = [{ tokenId: t.tokenId, stateHash: '', timestamp: Date.now() }];
    const result = await provider.save(data);
    expect(result.success).toBe(true);
    expect(fake.getRow(pubkey, t.tokenId)?.status).toBe('removed');

    const view = await provider.listInventory();
    expect(view.items).toEqual([]);
  });

  it('recoverRemoved() restores a wiped-but-unspent token (§5.3 recovery)', async () => {
    // isSpent (wired at composition in prod) reports t1 UNSPENT → recoverRemoved reactivates.
    const { provider, pubkey } = makeDevice(fake, baseUrl, 26, 'dev-a', new Set());
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
    // t is genuinely spent below → isSpent reports it spent → recoverRemoved keeps it as spent.
    const spentOnChain27 = new Set<string>();
    const deviceA = makeDevice(fake, baseUrl, 27, 'dev-a', spentOnChain27);
    const t = makeTestToken();
    spentOnChain27.add(t.tokenId);
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

  it('recoverRemoved() never resurrects the provider’s own on-chain spends', async () => {
    // The provider spends t1 itself; the fail-closed isSpent gate confirms it consumed
    // on-chain and records it as spent — never reactivating it (I4).
    const spentOnChain28 = new Set<string>();
    const { provider, pubkey } = makeDevice(fake, baseUrl, 28, 'dev-a', spentOnChain28);
    const t1 = makeTestToken();
    spentOnChain28.add(t1.tokenId);
    const t2 = makeTestToken();
    await seedVia(provider, [t1, t2]);

    await provider.applyDelta('99999999-9999-4999-8999-999999999999', [t1.tokenId], []);

    const result = await provider.recoverRemoved();
    expect(result.recovered).toEqual([]);
    expect(result.spent).toEqual([t1.tokenId]);
    expect(result.skipped).toEqual([]);
    expect(fake.getRow(pubkey, t1.tokenId)?.status).toBe('removed');
  });
});

