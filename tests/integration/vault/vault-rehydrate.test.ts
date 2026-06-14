/**
 * load() REHYDRATES the wallet's token entries on a fresh device (Phase 7.2 gap
 * closed). Before this, `materialize()` restored only `_meta.address` + `_history`
 * and set the internal `known` view — but it never decoded the sealed token
 * entries, so a fresh-device reload returned a TXF snapshot with NO `_<tokenId>`
 * keys and PaymentsModule import restored zero tokens (balances lost).
 *
 * The fix seals `{ k: plainKey, v: value }` as the entry plaintext (AAD unchanged:
 * network‖ownerId‖wireKey‖version). On load, every non-deleted entry is opened and
 * `data['_' + k] = v` is reconstructed, rebuilding the FULL TxfStorageData the
 * engine re-imports — byte-identical to what was flushed.
 *
 * MONEY-PATH SAFETY: the reload must reconstruct the token entries byte-for-byte
 * (round-trip equality), and a decrypt failure on a token entry is LOAD_FAILED
 * (never a silent fund drop).
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { wireKey } from '../../../storage/remote/wire-key';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '6b'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

function makeProvider(server: FakeVaultServer): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'https://vault.testnet.unicity.network',
    privateKey: PRIV,
    authClient: server.authClient(),
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
  });
  p.setIdentity(identity);
  return p;
}

function txf(tokens: Record<string, unknown>): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: { version: 1, address: 'DIRECT://x', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const [id, val] of Object.entries(tokens)) data[`_${id}` as `_${string}`] = val;
  return data;
}

describe('load() rehydrates token entries (Phase 7.2)', () => {
  it('a fresh device restores every flushed _<tokenId> entry byte-identical', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();

    // Two token entries with non-trivial values (the UI token records the engine re-imports).
    const tokenA = { id: 'aaa', sdkData: 'deadbeef', status: 'confirmed', value: '1000' };
    const tokenB = { id: 'bbb', sdkData: 'cafebabe', status: 'confirmed', value: '250', nested: { coin: 'UCT' } };
    await writer.sync(txf({ aaa: tokenA, bbb: tokenB }));

    // FRESH device: a new provider with cold internal state loads purely from the server.
    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(true);

    const data = res.data as TxfStorageDataBase;
    // The token entries are REHYDRATED under their `_<tokenId>` keys, byte-identical.
    expect(data['_aaa' as `_${string}`]).toEqual(tokenA);
    expect(data['_bbb' as `_${string}`]).toEqual(tokenB);
  });

  it('rehydrated entries do NOT leak _meta/_history into token keys', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ ccc: { id: 'ccc', sdkData: 'aa', status: 'confirmed' } }));

    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(true);
    const data = res.data as TxfStorageDataBase;

    // Exactly one token entry; the meta slots never surface as a `_<...>` token key.
    const tokenKeys = Object.keys(data).filter(
      (k) => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid', '_history'].includes(k),
    );
    expect(tokenKeys).toEqual(['_ccc']);
  });

  it('a deleted token entry is NOT rehydrated after reload', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ ddd: { id: 'ddd', sdkData: 'aa' }, eee: { id: 'eee', sdkData: 'bb' } }));
    // Drop 'ddd' → orphan delete (tombstone on the server).
    await writer.sync(txf({ eee: { id: 'eee', sdkData: 'bb' } }));

    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(true);
    const data = res.data as TxfStorageDataBase;
    expect(data['_ddd' as `_${string}`]).toBeUndefined(); // tombstoned → not restored
    expect(data['_eee' as `_${string}`]).toEqual({ id: 'eee', sdkData: 'bb' });
  });

  it('a SECOND load() (delta-only, cursor advanced) still returns the FULL token set', async () => {
    // The provider self-loads in initialize() (advancing the cursor) and the caller
    // (PaymentsModule.load) then calls load() AGAIN. The second pass paginates from
    // the watermark → an EMPTY delta. The full token snapshot must still come back
    // (the rehydration map persists across loads), else the restored balance is lost.
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    const tokenG = { id: 'ggg', sdkData: 'aa', status: 'confirmed', value: '500' };
    await writer.sync(txf({ ggg: tokenG }));

    const reader = makeProvider(server);
    await reader.initialize(); // FIRST load (advances the cursor)
    const second = await reader.load(); // SECOND load — delta is empty
    expect(second.success).toBe(true);
    expect((second.data as TxfStorageDataBase)['_ggg' as `_${string}`]).toEqual(tokenG);
  });

  it('a token deleted in a LATER load delta is dropped from the rehydrated snapshot', async () => {
    // First load sees the live token; a later flush tombstones it; a subsequent load
    // delta carries only the tombstone — the rehydration map must drop it.
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ hhh: { id: 'hhh', sdkData: 'aa' } }));

    const reader = makeProvider(server);
    await reader.initialize(); // first load: hhh live
    const first = await reader.load();
    expect((first.data as TxfStorageDataBase)['_hhh' as `_${string}`]).toEqual({ id: 'hhh', sdkData: 'aa' });

    // Tombstone hhh via the writer, then reader picks up the delete-only delta.
    await writer.sync(txf({}));
    const afterDelete = await reader.load();
    expect((afterDelete.data as TxfStorageDataBase)['_hhh' as `_${string}`]).toBeUndefined();
  });

  it('LOAD_FAILED: a corrupt TOKEN entry → success:false, gate stays shut (no silent fund drop)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ fff: { id: 'fff', sdkData: 'aa' } }));

    // Corrupt the token entry's ciphertext so its AEAD tag fails on open.
    const wk = wireKey(PRIV, NETWORK, 'fff');
    const row = server.getEntry(PUB, wk)!;
    server.mutateEntry(PUB, wk, { nonce: row.payload.nonce, ct: 'AAAA' + row.payload.ct.slice(4) });

    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(false);
    expect(reader.isInitialLoadDone()).toBe(false);
  });
});
