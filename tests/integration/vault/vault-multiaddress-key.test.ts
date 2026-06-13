/**
 * Fund-safety: multi-address key desync (remote-provider-multiaddress-key-desync).
 *
 * The provider derives its AEAD vault key, wireKeys and the auth signature from a
 * CONSTRUCTION-TIME `config.privateKey`, while `ownerId`/identity comes from
 * `setIdentity()`. On an HD address switch the provider instance is reused (it has
 * no `createForAddress`), so `setIdentity(identityB)` would leave the crypto keyed
 * to address A — the new owner's blobs would be sealed under the WRONG key and the
 * auth signature would 401. The provider must FAIL LOUD on that mismatch so a
 * cross-identity write can never reach the server under the wrong key.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import { wireKey } from '../../../storage/remote/wire-key';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV_A = '11'.repeat(32);
const PUB_A = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV_A), true));
const PRIV_B = '22'.repeat(32);
const PUB_B = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV_B), true));
const identityA: FullIdentity = { chainPubkey: PUB_A, l1Address: 'alphaA', privateKey: PRIV_A };
const identityB: FullIdentity = { chainPubkey: PUB_B, l1Address: 'alphaB', privateKey: PRIV_B };

function makeProvider(server: FakeVaultServer): RemoteTokenStorageProvider {
  return new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'u',
    privateKey: PRIV_A,
    authClient: server.authClient(),
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
  });
}

function txf(tokens: Record<string, unknown>): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const [id, val] of Object.entries(tokens)) data[`_${id}` as `_${string}`] = val;
  return data;
}

describe('multi-address key desync guard', () => {
  it('setIdentity with a pubkey != getPublicKey(config.privateKey) throws (no silent desync)', () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server); // config.privateKey = PRIV_A

    expect(() => provider.setIdentity(identityB)).toThrowError(/identity|key|address|mismatch/i);
  });

  it('a cross-identity write can never reach the server under the wrong key', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);

    provider.setIdentity(identityA); // matches config.privateKey → fine
    await provider.initialize();

    // Attempting to repoint at B must fail loud — the provider stays on A's key.
    expect(() => provider.setIdentity(identityB)).toThrow();

    // No B-keyed blob can ever have reached the server (the switch was rejected).
    const wkB = wireKey(PRIV_B, NETWORK, 'aaa');
    expect(server.getEntry(PUB_B, wkB)).toBeUndefined();
  });

  it('a matching identity works as before (no regression)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);

    provider.setIdentity(identityA); // PUB_A === getPublicKey(PRIV_A)
    await provider.initialize();
    const res = await provider.sync(txf({ aaa: { amt: '1' } }));
    expect(res.success).toBe(true);
    expect(res.added).toBe(1);
    const wkA = wireKey(PRIV_A, NETWORK, 'aaa');
    expect(server.getEntry(PUB_A, wkA)?.version).toBe(1);
  });
});
