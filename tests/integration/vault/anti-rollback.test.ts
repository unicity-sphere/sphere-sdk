/**
 * Anti-rollback root comparison + rollback event (Task 4.2, finding #11) against
 * the in-process fake server.
 *
 * Baseline: flush N entries, then load() — which persists a wallet-SIGNED baseline
 * `{cursor, root, sig}` under a reserved LOCAL key (an injected in-memory store).
 * The server then surfaces, at the NEXT monotonic cursor, a `?since=` delta with a
 * MUTATED entry whose recomputed root ≠ the signed baseline's expected fold.
 * `load()` must return `LoadResult.success === false` AND emit
 * `storage:error{reason:'rollback'}` — the event member is EXACTLY 'storage:error'
 * (the FROZEN union), with `data.reason === 'rollback'`, NEVER a 'storage:rollback'
 * member. With no server-signed epoch bump, a cursor regression / root mismatch
 * always alarms (the epoch short-circuit re-baseline is Task 8.2).
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { wireKey } from '../../../storage/remote/wire-key';
import { sealVaultEntry } from '../../../vault-aead/entry';
import { deriveVaultKey } from '../../../vault-aead/derive';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { LocalBaselineStore } from '../../../storage/remote/load-delta';
import type { StorageEvent, TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '3c'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

function memStore(): LocalBaselineStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeProvider(server: FakeVaultServer, baseline: LocalBaselineStore): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'https://vault.testnet.unicity.network',
    privateKey: PRIV,
    authClient: server.authClient(),
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    localBaseline: baseline,
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

describe('anti-rollback root comparison', () => {
  it('a mutated /state delta with no epoch bump fails load() and emits storage:error{reason:rollback}', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, store);
    await provider.initialize();

    // Baseline: flush 3 entries, then load() to persist the signed {cursor,root,sig}.
    await provider.sync(txf({ a: { n: 1 }, b: { n: 2 }, c: { n: 3 } }));
    const first = await provider.load();
    expect(first.success).toBe(true);
    const baselineKey = `vault_baseline:${NETWORK}:${PUB}`;
    expect(await store.get(baselineKey)).not.toBeNull(); // the signed baseline persisted

    // Hostile server: mutate entry 'a' at the NEXT monotonic cursor, NO epoch bump.
    const wkA = wireKey(PRIV, NETWORK, 'a');
    server.mutateEntry(PUB, wkA, seal('a', 99, { n: 'tampered' }));

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const res = await provider.load();

    expect(res.success).toBe(false);
    const err = events.find((e) => e.type === 'storage:error');
    expect(err).toBeDefined();
    expect(err!.type).toBe('storage:error'); // the FROZEN union member, exactly
    expect((err!.data as { reason: string }).reason).toBe('rollback');
    // NEVER a 'storage:rollback' member.
    expect(events.some((e) => (e.type as string) === 'storage:rollback')).toBe(false);
  });

  it('a clean re-load (empty delta) does NOT alarm — the gate only fires on injected state', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, store);
    await provider.initialize();
    await provider.sync(txf({ a: { n: 1 }, b: { n: 2 } }));
    await provider.load(); // establishes baseline

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const res = await provider.load(); // empty delta — nothing changed

    expect(res.success).toBe(true);
    expect(events.some((e) => e.type === 'storage:error')).toBe(false);
  });
});
