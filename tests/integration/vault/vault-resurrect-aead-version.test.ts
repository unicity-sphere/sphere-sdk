/**
 * Resurrect AEAD version binding (finding vault-aead-resurrect-version-mismatch).
 *
 * The vault entry AAD binds `(network, ownerId, key, version)`. In the
 * delete-resurrect path a locally-recreated token is sent with CAS `baseVersion:0`
 * against a server `deleted` row, but the SERVER converges the row to
 * `deletedRow.version + 1` (monotonic), NOT to version 1. Before the fix the
 * client sealed the payload AAD at version `baseVersion + 1 = 1`, so the AAD
 * version (1) disagreed with the server-stored version (deletedRow.version + 1) —
 * a fresh `load()` would then rebuild the AAD at the server version and decryption
 * would FAIL, making the resurrected token permanently unreadable.
 *
 * Fix: a resurrect seals the AAD at `known[wireKey].version + 1` (the version the
 * server will assign), while still sending CAS `baseVersion:0`.
 *
 * This test exercises the full provider lifecycle (create v1 → delete v2 →
 * resurrect v3) against the in-process fake server, then reads back the server's
 * STORED ciphertext and opens it at the SERVER-REPORTED version. The open must
 * succeed and round-trip to the resurrected plaintext (it threw before the fix),
 * and the AAD version sealed must equal the version the server stored.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { wireKey } from '../../../storage/remote/wire-key';
import { openVaultEntry } from '../../../vault-aead/entry';
import { deriveVaultKey } from '../../../vault-aead/derive';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '7c'.repeat(32);
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

/** Decrypt a stored entry's ciphertext at the SERVER-reported version (the load-time AAD). */
function openStored(server: FakeVaultServer, plainKey: string): unknown {
  const wk = wireKey(PRIV, NETWORK, plainKey);
  const row = server.getEntry(PUB, wk)!;
  const pt = openVaultEntry({
    network: NETWORK,
    ownerId: PUB,
    key: wk,
    version: row.version, // the AAD version a fresh load() would rebuild from /state
    payload: row.payload,
    key32: deriveVaultKey(PRIV, NETWORK),
  });
  return JSON.parse(new TextDecoder().decode(pt));
}

describe('resurrect AEAD version binding', () => {
  it('the resurrected entry decrypts at the server-stored version and round-trips', async () => {
    const server = new FakeVaultServer(NETWORK);
    const wk = wireKey(PRIV, NETWORK, 'k');
    const provider = makeProvider(server);
    await provider.initialize();

    // create v1
    await provider.sync(txf({ k: { amt: '1' } }));
    expect(server.getEntry(PUB, wk)?.version).toBe(1);

    // delete -> server tombstones at v2
    await provider.sync(txf({})); // 'k' absent → orphan delete
    expect(server.getEntry(PUB, wk)?.deleted).toBe(true);
    expect(server.getEntry(PUB, wk)?.version).toBe(2);

    // recreate the same token locally → resurrect; server stores at v3 (baseVersion:0)
    const resurrected = { amt: '2' };
    await provider.sync(txf({ k: resurrected }));
    const row = server.getEntry(PUB, wk)!;
    expect(row.deleted).toBe(false);
    expect(row.version).toBe(3); // v1 create -> v2 delete -> v3 resurrect

    // PROOF: the ciphertext stored at v3 must DECRYPT when the AAD is rebuilt at the
    // server version (3) — exactly what a fresh load() does. Before the fix the AAD
    // was sealed at version 1, so this threw (a permanently-unreadable token).
    const decoded = openStored(server, 'k');
    expect(decoded).toEqual(resurrected);

    // A fresh provider loads the resurrected row and round-trips the plaintext too.
    const reader = makeProvider(server);
    await reader.initialize();
    expect(openStored(server, 'k')).toEqual(resurrected);
  });

  it('a normal create/update still seals the AAD at the server-stored version', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    // create v1 then update v2 (no delete in between)
    await provider.sync(txf({ k: { n: 1 } }));
    await provider.sync(txf({ k: { n: 2 } }));
    const row = server.getEntry(PUB, wireKey(PRIV, NETWORK, 'k'))!;
    expect(row.version).toBe(2);
    // The update ciphertext decrypts at v2 (regression guard for the non-resurrect path).
    expect(openStored(server, 'k')).toEqual({ n: 2 });
  });
});
