/**
 * Account delete (Task 7.5, DESIGN §7.4 / §11) against the in-process fake server.
 *
 * `deleteAccount()` fetches a fresh single-use delete-nonce
 * (`POST /v1/account/delete-nonce`), signs the REAL `delete:v1` template with the
 * old wallet key, and sends `DELETE /v1/account {nonce, signature}`. The signing
 * template is `unicity:vault:delete:v1\n${network}\n${ownerId}\n${nonce}` — the
 * REAL Part A `deleteCanon`, NOT the `account-delete:v1` scheme fixture. A stale /
 * missing signature is rejected CLIENT-side before the request leaves.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, verifySignedMessage } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { deleteCanon } from '../../../vault-aead/canon';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '9c'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

function makeProvider(server: FakeVaultServer): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'u',
    privateKey: PRIV,
    authClient: server.authClient(),
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
  });
  p.setIdentity(identity);
  return p;
}

describe('account delete', () => {
  it('signs the REAL delete:v1 template with a fresh nonce and deletes', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    const ok = await provider.deleteAccount();
    expect(ok).toBe(true);
    expect(server.isDeleted(PUB)).toBe(true);

    // Exactly one nonce fetch + one delete; the signed message is the REAL delete:v1.
    expect(server.calls.deleteNonce).toHaveLength(1);
    expect(server.calls.deleteAccount).toHaveLength(1);
    const sent = server.calls.deleteAccount[0];
    const expectedMsg = deleteCanon(NETWORK, PUB, sent.nonce);
    expect(verifySignedMessage(expectedMsg, sent.signature, PUB)).toBe(true);
    // It is NOT the account-delete:v1 scheme fixture.
    expect(verifySignedMessage(`unicity:vault:account-delete:v1\n${NETWORK}\n${PUB}\n${sent.nonce}`, sent.signature, PUB)).toBe(false);
  });

  it('each delete uses a FRESH single-use nonce (a replayed nonce is rejected)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    await provider.deleteAccount();
    const usedNonce = server.calls.deleteAccount[0].nonce;
    const msg = deleteCanon(NETWORK, PUB, usedNonce);
    const sig = (await import('../../../core/crypto')).signMessage(PRIV, msg);

    // Replaying the same (now-consumed) nonce is rejected by the single-use server.
    const direct = server.clientFor(PUB);
    const replay = await direct.deleteAccount(usedNonce, sig);
    expect(replay.ok).toBe(false);
  });

  it('the server rejects a forged signature (wrong key) with 401', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    const { nonce } = await server.clientFor(PUB).deleteNonce();
    // Sign with a DIFFERENT key — the recovered signer ≠ ownerId → rejected.
    const wrongPriv = '7b'.repeat(32);
    const forged = (await import('../../../core/crypto')).signMessage(wrongPriv, deleteCanon(NETWORK, PUB, nonce));
    const res = await server.clientFor(PUB).deleteAccount(nonce, forged);
    expect(res.ok).toBe(false);
    expect(server.isDeleted(PUB)).toBe(false);
  });
});
