/**
 * testnet-reset vs hostile-rollback (Task 8.2, finding #14, DESIGN §8.2) against
 * the in-process fake server.
 *
 * A reset is distinguishable from a hostile rollback by ONE thing only: a
 * server-signed epoch bump (signed under the deployment key whose pubkey ==
 * `NETWORKS[net].vaultServerKey`, over `epochCanon(net, bumpedEpoch)`).
 *
 *  - COMBINED RESET (positive): the server returns `getState{cursor:0, entries:[]}`
 *    AND a bumped, validly-signed `epochSig`. `load()` SHORT-CIRCUITS the
 *    cursor-regression / root gate: it DROPS local vault state, RE-BASELINES the
 *    signed root at the new epoch/cursor, returns `success:true`, and does NOT emit
 *    `storage:error{reason:'rollback'}`.
 *  - NEGATIVE: the SAME `cursor:0` regression with an INVALID or ABSENT epoch sig
 *    fires the rollback gate (Task 4.2): `success:false` + `storage:error{reason:'rollback'}`.
 *
 * The rollback event member is EXACTLY `'storage:error'` with `data.reason ===
 * 'rollback'` — NEVER a `'storage:rollback'` member (the FROZEN union).
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import { NETWORKS } from '../../../constants';
import type { LocalBaselineStore } from '../../../storage/remote/load-delta';
import type { StorageEvent, TxfStorageDataBase } from '../../../storage/storage-provider';
import type { StateResponse, VaultHttpClient } from '../../../storage/remote/types';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '4f'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

function memStore(): LocalBaselineStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

interface ProviderOpts {
  baseline?: LocalBaselineStore;
  httpClientFactory?: (ownerId: string) => VaultHttpClient;
}

function makeProvider(server: FakeVaultServer, opts: ProviderOpts = {}): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'https://vault.testnet.unicity.network',
    privateKey: PRIV,
    authClient: server.authClient(),
    httpClientFactory: opts.httpClientFactory ?? ((ownerId) => server.clientFor(ownerId)),
    localBaseline: opts.baseline,
    vaultServerKey: NETWORKS[NETWORK].vaultServerKey, // enables the epoch gate
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

describe('epoch-gated testnet reset', () => {
  it('combined reset (positive): a server-signed epoch bump drops local state, re-baselines, success:true, NO rollback', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, { baseline: store });
    await provider.initialize();

    // Populate + load: establish a SIGNED baseline at epoch 1 with a non-empty root.
    await provider.sync(txf({ a: { n: 1 }, b: { n: 2 }, c: { n: 3 } }));
    const first = await provider.load();
    expect(first.success).toBe(true);
    expect(provider.knownCount()).toBeGreaterThan(0); // local vault state is populated
    const baselineKey = `vault_baseline:${NETWORK}:${PUB}`;
    const beforeRaw = await store.get(baselineKey);
    expect(beforeRaw).not.toBeNull();
    const beforeEpoch = (JSON.parse(beforeRaw!) as { epoch: number }).epoch;

    // The server is RESET: entries wiped, seq reset, epoch bumped + freshly signed.
    server.resetOwner(PUB);
    expect(server.entryCount(PUB)).toBe(0);

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const res = await provider.load();

    // SANCTIONED reset, not an alarm.
    expect(res.success).toBe(true);
    expect(events.some((e) => e.type === 'storage:error')).toBe(false);
    expect(events.some((e) => (e.type as string) === 'storage:rollback')).toBe(false);

    // Local vault state was DROPPED (re-based on the empty reset state).
    expect(provider.knownCount()).toBe(0);
    // The signed root was RE-BASELINED at the NEW (strictly-increased) epoch.
    const afterRaw = await store.get(baselineKey);
    expect(afterRaw).not.toBeNull();
    const after = JSON.parse(afterRaw!) as { epoch: number; cursor: number; root: string };
    expect(after.epoch).toBeGreaterThan(beforeEpoch);
    expect(after.cursor).toBe(0); // re-baselined at the reset cursor
  });

  it('negative: the same regression with an INVALID epoch sig fires the rollback gate (success:false + storage:error{rollback})', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, { baseline: store });
    await provider.initialize();
    await provider.sync(txf({ a: { n: 1 }, b: { n: 2 }, c: { n: 3 } }));
    await provider.load(); // baseline at epoch 1

    // A hostile server: mutate an entry (root divergence) AND bump the epoch, but
    // sign the epoch with a WRONG key — the bump does NOT verify under vaultServerKey.
    const wrap = (ownerId: string): VaultHttpClient => {
      const inner = server.clientFor(ownerId);
      return {
        patchEntries: (ops) => inner.patchEntries(ops),
        getState: async (since): Promise<StateResponse> => {
          const page = await inner.getState(since);
          // Forge a bumped epoch with an INVALID signature (not the server key).
          return { ...page, syncEpoch: page.syncEpoch + 5, epochSig: 'ff'.repeat(65) };
        },
        appendHistory: (records) => inner.appendHistory(records),
        historySince: (since) => inner.historySince(since),
        deleteNonce: () => inner.deleteNonce(),
        deleteAccount: (nonce, sig) => inner.deleteAccount(nonce, sig),
      };
    };
    const reader = makeProvider(server, { baseline: store, httpClientFactory: wrap });
    // Mutate a stored entry's ciphertext at the next monotonic seq to force a root
    // divergence — the wrap forges an INVALID epoch bump over it.
    const someKey = firstEntryKey(server);
    server.mutateEntry(PUB, someKey, { nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ct: 'BBBB' });

    const events: StorageEvent[] = [];
    reader.onEvent((e) => events.push(e));
    const res = await reader.load();

    expect(res.success).toBe(false);
    const err = events.find((e) => e.type === 'storage:error');
    expect(err).toBeDefined();
    expect(err!.type).toBe('storage:error'); // FROZEN union member, exactly
    expect((err!.data as { reason: string }).reason).toBe('rollback');
    expect(events.some((e) => (e.type as string) === 'storage:rollback')).toBe(false);
  });

  it('negative: the same regression with an ABSENT epoch sig also fires the rollback gate', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, { baseline: store });
    await provider.initialize();
    await provider.sync(txf({ a: { n: 1 }, b: { n: 2 } }));
    await provider.load();

    // Mutate an entry at the next monotonic seq, NO epoch bump at all (sig empty).
    const someKey = firstEntryKey(server);
    const wrap = (ownerId: string): VaultHttpClient => {
      const inner = server.clientFor(ownerId);
      return {
        patchEntries: (ops) => inner.patchEntries(ops),
        getState: async (since): Promise<StateResponse> => {
          const page = await inner.getState(since);
          return { ...page, epochSig: '' }; // absent epoch sig
        },
        appendHistory: (records) => inner.appendHistory(records),
        historySince: (since) => inner.historySince(since),
        deleteNonce: () => inner.deleteNonce(),
        deleteAccount: (nonce, sig) => inner.deleteAccount(nonce, sig),
      };
    };
    const reader = makeProvider(server, { baseline: store, httpClientFactory: wrap });
    server.mutateEntry(PUB, someKey, { nonce: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', ct: 'DDDD' });

    const events: StorageEvent[] = [];
    reader.onEvent((e) => events.push(e));
    const res = await reader.load();

    expect(res.success).toBe(false);
    const err = events.find((e) => e.type === 'storage:error');
    expect(err).toBeDefined();
    expect((err!.data as { reason: string }).reason).toBe('rollback');
    expect(events.some((e) => (e.type as string) === 'storage:rollback')).toBe(false);
  });
});

/** The first stored vault wire key for the owner (a token test entry). */
function firstEntryKey(server: FakeVaultServer): string {
  // The fake stores entries privately; read one via the public getEntry probe by
  // scanning the keys we flushed. We flushed token keys only (no reserved slot);
  // any present key forces a root divergence when mutated.
  const rows = (server as unknown as { entries: { ownerId: string; key: string; deleted: boolean }[] }).entries;
  const row = rows.find((e) => e.ownerId === PUB && !e.deleted);
  if (!row) throw new Error('firstEntryKey: no entry to mutate');
  return row.key;
}
