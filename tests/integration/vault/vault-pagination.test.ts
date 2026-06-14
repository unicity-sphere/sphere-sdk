/**
 * Paginated state load + cursor monotonicity (Task 6.4, DESIGN §5.4) against the
 * in-process fake server.
 *
 * `load()` loops `GET /state?since=` on `more` until `!more`, accumulating every
 * page; the server `cursor` is asserted non-decreasing across pages. A page whose
 * cursor REGRESSES (with no sanctioned epoch bump) trips the rollback gate
 * (links to Task 4.2) — `success:false` + `storage:error{reason:'rollback'}`.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { StorageEvent, TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';
import type { StateResponse, VaultHttpClient } from '../../../storage/remote/types';

const NETWORK = 'testnet2';
const PRIV = '6a'.repeat(32);
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

describe('paginated state load', () => {
  it('loops GET /state?since= on `more`, accumulating every page; cursor is monotonic', async () => {
    const server = new FakeVaultServer({ network: NETWORK, pageLimit: 2 });
    const seed = makeProvider(server);
    await seed.initialize();
    await seed.sync(txf({ a: { n: 1 }, b: { n: 2 }, c: { n: 3 }, d: { n: 4 }, e: { n: 5 } }));

    // A fresh provider loads from scratch (serverCursor 0) and must paginate. Under
    // Task 7.1 the first load is performed by initialize() itself, so count its pages.
    const reader = makeProvider(server);
    server.calls.state.length = 0; // count only the reader's pages
    await reader.initialize();

    // 5 token rows / pageLimit 2 → since 0,2,4 → 3 pages (no reserved-address slot).
    expect(server.calls.state).toEqual([0, 2, 4]);
    // The reader adopted all 5 token rows (no reserved-address slot — v2 identity).
    expect(reader.knownCount()).toBe(5);
    expect(reader.isInitialLoadDone()).toBe(true);
  });

  it('a regressing page cursor (no sanctioned epoch) trips the rollback gate', async () => {
    const server = new FakeVaultServer({ network: NETWORK, pageLimit: 2 });
    const seed = makeProvider(server);
    await seed.initialize();
    await seed.sync(txf({ a: { n: 1 }, b: { n: 2 }, c: { n: 3 } }));

    // Wrap the data client so the SECOND /state page reports a cursor BELOW its
    // `since` — a hostile regression with no server-signed epoch.
    const wrap = (ownerId: string): VaultHttpClient => {
      const inner = server.clientFor(ownerId);
      let calls = 0;
      return {
        patchEntries: (ops) => inner.patchEntries(ops),
        getState: async (since): Promise<StateResponse> => {
          const page = await inner.getState(since);
          calls += 1;
          return calls === 2 ? { ...page, cursor: since - 1, more: false } : page;
        },
        appendHistory: (records) => inner.appendHistory(records),
        historySince: (since) => inner.historySince(since),
        deleteNonce: () => inner.deleteNonce(),
        deleteAccount: (nonce, sig) => inner.deleteAccount(nonce, sig),
      };
    };

    const reader = makeProvider(server, { httpClientFactory: wrap });
    await reader.initialize();
    const events: StorageEvent[] = [];
    reader.onEvent((e) => events.push(e));
    const res = await reader.load();

    expect(res.success).toBe(false);
    const err = events.find((e) => e.type === 'storage:error');
    expect(err).toBeDefined();
    expect((err!.data as { reason: string }).reason).toBe('rollback');
    // The FROZEN union has no 'storage:rollback' member.
    expect(events.some((e) => (e.type as string) === 'storage:rollback')).toBe(false);
  });
});
