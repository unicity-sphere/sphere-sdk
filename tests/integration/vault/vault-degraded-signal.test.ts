/**
 * Fund-safety: a gate-shut flush must SIGNAL false durability, never report a
 * silent success (remote-provider-silent-backup-failure-reports-success).
 *
 * When the flush gate is shut (first load failed / never succeeded), the wallet
 * must NOT believe its tokens are durably backed up. So `sync()` / `save()` must
 * return `success:false` with a reason AND emit a degraded event on the FROZEN
 * `StorageEventType` union (`sync:error` with `data.reason`) — while STILL never
 * PATCHing the server (empty-import protection). A genuine successful no-op
 * flush (gate OPEN, nothing to push) stays `success:true` with no degraded event.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { TxfStorageDataBase, StorageEvent } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';
import type { VaultAuthHttpClient, VaultHttpClient } from '../../../storage/remote/types';

const NETWORK = 'testnet2';
const PRIV = '71'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

interface ProviderOpts {
  httpClientFactory?: (ownerId: string) => VaultHttpClient;
  authClient?: VaultAuthHttpClient;
}

function makeProvider(server: FakeVaultServer, opts: ProviderOpts = {}): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'https://vault.testnet.unicity.network',
    privateKey: PRIV,
    authClient: opts.authClient ?? server.authClient(),
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

/** An auth seam whose /challenge always throws (vault server is down → gate stays shut). */
function downAuthClient(): VaultAuthHttpClient {
  return {
    challenge: () => Promise.reject(new Error('ECONNREFUSED: vault server down')),
    verify: () => Promise.resolve(null),
    refresh: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
  };
}

describe('gate-shut flush signals degraded durability (not silent success)', () => {
  it('sync() while gate shut returns success:false with a reason and emits a degraded sync:error event', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server, { authClient: downAuthClient() });
    await provider.initialize(); // gate stays shut (auth down)
    expect(provider.isInitialLoadDone()).toBe(false);

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));

    server.calls.patch.length = 0;
    const res = await provider.sync(txf({ aaa: { amt: '1' } }));

    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(res.added).toBe(0);
    // The degraded signal rides the FROZEN union (sync:error) with a data.reason.
    const degraded = events.find((e) => e.type === 'sync:error');
    expect(degraded).toBeDefined();
    expect((degraded!.data as { reason?: string }).reason).toBeTruthy();
    // Empty-import protection: NO PATCH reached the server.
    expect(server.calls.patch).toHaveLength(0);
  });

  it('save() while gate shut returns success:false (degraded, not a silent backup success)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server, { authClient: downAuthClient() });
    await provider.initialize();

    server.calls.patch.length = 0;
    const res = await provider.save(txf({ aaa: { amt: '1' } }));
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(server.calls.patch).toHaveLength(0);
  });

  it('gate-OPEN empty flush is still a genuine success:true no-op (no false-degrade)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server); // healthy auth + first load opens the gate
    await provider.initialize();
    expect(provider.isInitialLoadDone()).toBe(true);

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));
    server.calls.patch.length = 0;

    // Nothing changed since the (empty) load → a clean no-op flush.
    const res = await provider.sync(txf({}));
    expect(res.success).toBe(true);
    expect(res.added).toBe(0);
    expect(res.removed).toBe(0);
    // A clean no-op flush must NOT emit a degraded signal.
    expect(events.find((e) => e.type === 'sync:error')).toBeUndefined();
    expect(events.find((e) => e.type === 'storage:error')).toBeUndefined();
  });
});
