/**
 * CAS delete-resurrect (Task 6.3, finding #16) against the in-process fake server.
 *
 * A server `deleted` row for key 'k' must be RESURRECTED by a create op at
 * `baseVersion:0` (NOT rebased to the deleted row's version). `patchEntries` is
 * called EXACTLY ONCE and resolves `{applied:['k'], rejected:[], cursor:N}`;
 * `op.baseVersion === 0`, `conflicts === 0`, and 'k' is live in the clean
 * snapshot afterward. (The server, mirroring vault-tokens.repo.ts::createOrResurrect,
 * converges baseVersion 0 against a deleted row → version+1, deleted:false.)
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { wireKey } from '../../../storage/remote/wire-key';
import { sealVaultEntry } from '../../../vault-aead/entry';
import { deriveVaultKey } from '../../../vault-aead/derive';
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
    _meta: { version: 1, address: 'DIRECT://x', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const [id, val] of Object.entries(tokens)) data[`_${id}` as `_${string}`] = val;
  return data;
}

/** Seal a payload for key 'k' at a given version (server-side seeding helper). */
function seal(plainKey: string, version: number, value: unknown): { nonce: string; ct: string } {
  return sealVaultEntry({
    network: NETWORK,
    ownerId: PUB,
    key: wireKey(PRIV, NETWORK, plainKey),
    version,
    plaintext: new TextEncoder().encode(JSON.stringify(value)),
    key32: deriveVaultKey(PRIV, NETWORK),
  });
}

describe('CAS delete-resurrect', () => {
  it('resurrects a deleted server row via baseVersion:0 in a single patch call', async () => {
    const server = new FakeVaultServer(NETWORK);
    const wkK = wireKey(PRIV, NETWORK, 'k');

    // Seed a server row for 'k' (create v1), then tombstone it (v2, deleted).
    const direct = server.clientFor(PUB);
    await direct.patchEntries([{ key: wkK, baseVersion: 0, payload: seal('k', 1, { amt: '1' }) }]);
    await direct.patchEntries([{ key: wkK, baseVersion: 1, deleted: true }]);
    expect(server.getEntry(PUB, wkK)?.deleted).toBe(true);

    const provider = makeProvider(server);
    await provider.initialize();
    // load() teaches the provider that 'k' is currently a deleted row.
    await provider.load();

    const patchesBefore = server.calls.patch.length;
    // Local data carries 'k' again → resurrect.
    const res = await provider.sync(txf({ k: { amt: '2' } }));

    // EXACTLY ONE patch call for the resurrect.
    expect(server.calls.patch.length).toBe(patchesBefore + 1);
    const ops = server.calls.patch[server.calls.patch.length - 1];
    // The 'k' resurrect op is present (token ops only — no reserved-address slot).
    const kOp = ops.find((o) => o.key === wkK)!;
    expect(kOp).toBeDefined();
    expect(kOp.baseVersion).toBe(0); // NOT rebased to the deleted row's version

    // Server converged: applied, not rejected; the row is live again at v3.
    expect(res.added).toBe(1);
    expect(res.conflicts).toBe(0);
    const row = server.getEntry(PUB, wkK);
    expect(row?.deleted).toBe(false);
    expect(row?.version).toBe(3); // v1 create -> v2 delete -> v3 resurrect
  });
});
