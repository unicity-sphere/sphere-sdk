/**
 * load() 3-state machine (Task 7.2, findings #17/#22, DESIGN §5.5) against the
 * in-process fake server.
 *
 * v2 identity is the chainPubkey — the vault stores NO DIRECT:// address. On every
 * load `_meta.address` is restored to the wallet's OWN chainPubkey (locally known
 * from the key, no server entry). The three load outcomes:
 *  - EMPTY (no token entries on the server) → success:true with an `isEmpty`
 *    sentinel INSIDE `data` so it can never short-circuit local data (#22); the
 *    gate opens; `_meta.address` is the chainPubkey; treated as a brand-new wallet.
 *  - POPULATED → every non-deleted token entry is REHYDRATED under its `_<tokenId>`
 *    key (so PaymentsModule import restores the tokens/balance) and `_meta.address`
 *    is the chainPubkey.
 *  - LOAD_FAILED (a token-entry decrypt/verify error) → success:false, the gate
 *    stays SHUT, no flush.
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
const PRIV = '5e'.repeat(32);
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
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const [id, val] of Object.entries(tokens)) data[`_${id}` as `_${string}`] = val;
  return data;
}

interface IsEmptyData extends TxfStorageDataBase {
  isEmpty?: boolean;
}

describe('load() 3-state machine', () => {
  it('EMPTY: no token entries → success:true with an isEmpty sentinel inside data; gate opens; address is the chainPubkey (#22)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    const res = await provider.load();
    expect(res.success).toBe(true);
    expect((res.data as IsEmptyData).isEmpty).toBe(true);
    expect(provider.isInitialLoadDone()).toBe(true);
    // v2 identity is the chainPubkey — restored locally even from an empty vault.
    expect(res.data!._meta.address).toBe(PUB);
  });

  it('POPULATED: a flush stores token entries; reload rehydrates them and restores _meta.address to the chainPubkey', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    const token = { id: 'aaa', amt: '1' };
    await writer.sync(txf({ aaa: token }));

    // The token entry was stored at its opaque wire key — NO DIRECT reserved slot.
    const tokenWk = wireKey(PRIV, NETWORK, 'aaa');
    expect(server.getEntry(PUB, tokenWk)).toBeDefined();

    // A fresh reader rehydrates the token and restores _meta.address to the chainPubkey.
    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(true);
    expect((res.data as IsEmptyData).isEmpty).toBeUndefined();
    expect(res.data!._meta.address).toBe(PUB); // v2 identity — NOT a DIRECT address
    // The token entry is rehydrated under its `_<tokenId>` key, byte-identical.
    expect((res.data as TxfStorageDataBase)['_aaa' as `_${string}`]).toEqual(token);
  });

  it('LOAD_FAILED: a corrupt token entry → success:false, gate stays shut, no flush', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ aaa: { amt: '1' } }));

    // Corrupt the token entry's ciphertext so its AEAD tag fails on open.
    const tokenWk = wireKey(PRIV, NETWORK, 'aaa');
    const row = server.getEntry(PUB, tokenWk)!;
    server.mutateEntry(PUB, tokenWk, { nonce: row.payload.nonce, ct: 'AAAA' + row.payload.ct.slice(4) });

    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(false);
    expect(reader.isInitialLoadDone()).toBe(false);

    // Gate stays shut: a flush before a successful load is a no-op.
    server.calls.patch.length = 0;
    const flush = await reader.sync(txf({ bbb: { amt: '2' } }));
    expect(flush.added).toBe(0);
    expect(server.calls.patch).toHaveLength(0);
  });
});
