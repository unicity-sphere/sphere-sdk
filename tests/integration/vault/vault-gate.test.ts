/**
 * initialize() self-load opens the flush gate (Task 7.1, DESIGN §5.5).
 *
 * `PaymentsModule.load()` stops at the FIRST successful provider, so the vault
 * box may never receive a `load()` call. The provider therefore performs the
 * first `getState()`/`load()` ITSELF inside `initialize()` and only THEN opens
 * the flush gate (`initialLoadDone`). Empty-import protection is preserved: a
 * `sync()` before a successful first load is a NO-OP (no PATCH reaches the
 * server), so a transient load failure can never wipe the server with empty
 * local data.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import { wireKey } from '../../../storage/remote/wire-key';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';
import type { StateResponse, VaultHttpClient } from '../../../storage/remote/types';

const NETWORK = 'testnet2';
const PRIV = '71'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

interface ProviderOpts {
  httpClientFactory?: (ownerId: string) => VaultHttpClient;
}

function makeProvider(server: FakeVaultServer, opts: ProviderOpts = {}): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'https://vault.testnet.unicity.network',
    privateKey: PRIV,
    authClient: server.authClient(),
    httpClientFactory: opts.httpClientFactory ?? ((ownerId) => server.clientFor(ownerId)),
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

describe('initialize() opens the flush gate', () => {
  it('performs the first /state load itself even without a load() call', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    server.calls.state.length = 0;

    await provider.initialize();

    // initialize() ran the first /state load on its own (no caller load()).
    expect(server.calls.state.length).toBeGreaterThanOrEqual(1);
    expect(provider.isInitialLoadDone()).toBe(true);
  });

  it('opens the flush gate only after the first load — a flush then reaches the server', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server);
    await provider.initialize();

    const res = await provider.sync(txf({ aaa: { amt: '1' } }));
    expect(res.success).toBe(true);
    expect(res.added).toBe(1);
    const wk = wireKey(PRIV, NETWORK, 'aaa');
    expect(server.getEntry(PUB, wk)?.version).toBe(1);
  });

  it('a failed first load keeps the gate SHUT — a flush performs NO PATCH but SIGNALS degraded (empty-import protection)', async () => {
    const server = new FakeVaultServer(NETWORK);
    // Wrap the data client so the FIRST /state (run by initialize) rejects.
    const wrap = (ownerId: string): VaultHttpClient => {
      const inner = server.clientFor(ownerId);
      let calls = 0;
      return {
        patchEntries: (ops) => inner.patchEntries(ops),
        getState: (since): Promise<StateResponse> => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('transient /state failure'));
          return inner.getState(since);
        },
        appendHistory: (records) => inner.appendHistory(records),
        historySince: (since) => inner.historySince(since),
        deleteNonce: () => inner.deleteNonce(),
        deleteAccount: (nonce, sig) => inner.deleteAccount(nonce, sig),
      };
    };
    const provider = makeProvider(server, { httpClientFactory: wrap });

    // initialize() must NOT throw on a transient load failure; the gate stays shut.
    await provider.initialize();
    expect(provider.isInitialLoadDone()).toBe(false);

    // A flush before a successful load performs NO PATCH (empty local data can
    // never wipe the server) BUT it must SIGNAL the degraded state, not report a
    // silent success (remote-provider-silent-backup-failure-reports-success).
    const res = await provider.sync(txf({ aaa: { amt: '1' } }));
    expect(res.success).toBe(false); // degraded — the backup did NOT happen
    expect(res.error).toBeTruthy();
    expect(res.added).toBe(0);
    expect(server.calls.patch).toHaveLength(0);
    const wk = wireKey(PRIV, NETWORK, 'aaa');
    expect(server.getEntry(PUB, wk)).toBeUndefined();
  });
});
