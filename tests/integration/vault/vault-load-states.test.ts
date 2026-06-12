/**
 * load() 3-state machine + reserved-address restore (Task 7.2, findings #17/#22,
 * DESIGN §5.5) against the in-process fake server.
 *
 * The load machine distinguishes three outcomes:
 *  - EMPTY (no reserved entry on the server) → success:true with an `isEmpty`
 *    sentinel INSIDE `data` so it can never short-circuit local data (#22); the
 *    gate opens; treated as a brand-new wallet.
 *  - POPULATED (#17) → on flush the provider seals a reserved-address entry from a
 *    REAL engine identity (`deriveDirectAddress(hexToBytes(chainPubkey))`); on
 *    reload it decodes the reserved entry and restores `_meta.address`. The
 *    restored address must BYTE-EQUAL an INDEPENDENT `deriveDirectAddress(...)`
 *    call imported from `token-engine/identity.ts` (not an in-test helper).
 *  - LOAD_FAILED (a reserved-entry decrypt/verify error) → success:false, the gate
 *    stays SHUT, no flush.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { reservedAddressKey } from '../../../storage/remote/reserved-address';
import { deriveDirectAddress } from '../../../token-engine/identity';
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
  it('EMPTY: no reserved entry → success:true with an isEmpty sentinel inside data; gate opens (#22)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    const res = await provider.load();
    expect(res.success).toBe(true);
    expect((res.data as IsEmptyData).isEmpty).toBe(true);
    expect(provider.isInitialLoadDone()).toBe(true);
    // No _meta.address can be restored from an empty vault.
    expect(res.data!._meta.address).toBe('');
  });

  it('POPULATED (#17): a flush seals a reserved-address entry; reload restores _meta.address byte-equal to deriveDirectAddress', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ aaa: { amt: '1' } }));

    // The reserved-address entry was sealed at its well-known wire key.
    const reservedWk = reservedAddressKey(PRIV, NETWORK);
    expect(server.getEntry(PUB, reservedWk)).toBeDefined();

    // A fresh reader restores _meta.address from the reserved entry.
    const reader = makeProvider(server);
    const res = await reader.load();
    expect(res.success).toBe(true);
    expect((res.data as IsEmptyData).isEmpty).toBeUndefined();

    // The INDEPENDENT oracle: deriveDirectAddress from token-engine/identity.ts.
    const expected = await deriveDirectAddress(hexToBytes(PUB));
    expect(res.data!._meta.address).toBe(expected);
  });

  it('LOAD_FAILED: a corrupt reserved entry → success:false, gate stays shut, no flush', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server);
    await writer.initialize();
    await writer.sync(txf({ aaa: { amt: '1' } }));

    // Corrupt the reserved-address entry's ciphertext so its AEAD tag fails.
    const reservedWk = reservedAddressKey(PRIV, NETWORK);
    const row = server.getEntry(PUB, reservedWk)!;
    server.mutateEntry(PUB, reservedWk, { nonce: row.payload.nonce, ct: 'AAAA' + row.payload.ct.slice(4) });

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
