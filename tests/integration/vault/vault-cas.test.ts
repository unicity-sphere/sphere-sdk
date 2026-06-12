/**
 * CAS flush → SyncResult mapping (Task 6.2, DESIGN §5.4, finding #29) against the
 * in-process fake server.
 *
 * Asserts the provider diffs TxfStorageData vs its INTERNAL last-known server
 * state, PATCHes CAS ops keyed by the opaque wireKey, and maps the server
 * `{applied, rejected, cursor}` onto `SyncResult` — `conflicts` derived from
 * `rejected[].reason === 'conflict'`. A partial-batch rejection emits
 * `sync:conflict` and keeps the rejected op OUT of the clean snapshot (retried
 * next flush); a per-op oversize op is rejected ALONE while the rest apply.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { wireKey } from '../../../storage/remote/wire-key';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { StorageEvent } from '../../../storage/storage-provider';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '4d'.repeat(32);
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
  for (const [id, val] of Object.entries(tokens)) {
    data[`_${id}` as `_${string}`] = val;
  }
  return data;
}

describe('CAS flush → SyncResult', () => {
  it('flushes new token entries as CAS creates keyed by wireKey', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    const res = await provider.sync(txf({ aaa: { amt: '1' }, bbb: { amt: '2' } }));
    expect(res.success).toBe(true);
    expect(res.added).toBe(2);
    expect(res.conflicts).toBe(0);

    // Keyed by the opaque wireKey, NEVER the plaintext token id.
    const wkA = wireKey(PRIV, NETWORK, 'aaa');
    expect(server.getEntry(PUB, wkA)?.version).toBe(1);
    expect(server.getEntry(PUB, 'aaa')).toBeUndefined();

    // A create op carries baseVersion 0.
    expect(server.calls.patch).toHaveLength(1);
    expect(server.calls.patch[0].every((op) => op.baseVersion === 0)).toBe(true);
  });

  it('partial-batch rejection → conflicts>0, sync:conflict event, rejected kept out of the clean snapshot', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    // Seed 'aaa' at v1 via a foreign writer so the provider's next create against
    // it (baseVersion 0) collides with a LIVE non-deleted row → 'conflict'.
    const wkA = wireKey(PRIV, NETWORK, 'aaa');
    await server.clientFor(PUB).patchEntries([
      { key: wkA, baseVersion: 0, payload: { nonce: 'bm9uY2U=', ct: 'Y3Q=' } },
    ]);

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));

    const res = await provider.sync(txf({ aaa: { amt: '1' }, bbb: { amt: '2' } }));
    expect(res.success).toBe(true);
    expect(res.added).toBe(1); // only 'bbb' applied
    expect(res.conflicts).toBe(1); // 'aaa' rejected as conflict
    expect(events.some((e) => e.type === 'sync:conflict')).toBe(true);
    const conflictEvent = events.find((e) => e.type === 'sync:conflict')!;
    expect((conflictEvent.data as { rejected: unknown[] }).rejected).toHaveLength(1);

    // The rejected key is NOT in the clean snapshot — a re-flush retries it.
    server.clientFor(PUB); // no-op, readability
    const res2 = await provider.sync(txf({ aaa: { amt: '1' }, bbb: { amt: '2' } }));
    // 'bbb' already applied last flush → no-op; 'aaa' retried → still conflict.
    expect(res2.conflicts).toBe(1);
    expect(res2.added).toBe(0);
  });

  it('per-op oversize op is rejected ALONE; the rest apply', async () => {
    const server = new FakeVaultServer(NETWORK);
    server.setMaxEntryBytes(200); // small cap: a 500-char blob exceeds it, a tiny token does not
    const provider = makeProvider(server);
    await provider.initialize();

    // 'big' seals to a payload over the cap; 'small' stays under it.
    const big = { blob: 'x'.repeat(500) };
    const res = await provider.sync(txf({ big, small: { amt: '1' } }));
    expect(res.added).toBe(1); // only 'small'
    expect(res.conflicts).toBe(0); // oversize is NOT a conflict
    const wkSmall = wireKey(PRIV, NETWORK, 'small');
    expect(server.getEntry(PUB, wkSmall)?.version).toBe(1);
    const wkBig = wireKey(PRIV, NETWORK, 'big');
    expect(server.getEntry(PUB, wkBig)).toBeUndefined();
  });

  it('an unchanged second flush is a no-op (last-known state suppresses re-writes)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();
    const data = txf({ aaa: { amt: '1' } });
    await provider.sync(data);
    const res2 = await provider.sync(data);
    expect(res2.added).toBe(0);
    expect(res2.removed).toBe(0);
    // No second PATCH when there is nothing to flush.
    expect(server.calls.patch).toHaveLength(1);
  });
});
