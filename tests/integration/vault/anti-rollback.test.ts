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

/**
 * First-load baseline persistence (finding remote-anti-rollback-no-baseline-on-fresh-load).
 *
 * RESIDUAL (fundamental): the root gate cannot detect a TRUNCATED/withheld first
 * load — there is no prior signed reference to fold against, so a genuinely fresh
 * device trusts its first sync exactly like any first sync of an untrusted server.
 * That part is unavoidable.
 *
 * What IS guaranteed and asserted here: the FIRST successful load PERSISTS a signed
 * baseline (no sync needed), so EVERY subsequent load is gated against it. A fresh
 * provider with no prior local baseline that loads then sees a server-injected
 * delta on its NEXT load is alarmed.
 */
describe('anti-rollback first-load baseline', () => {
  const baselineKey = `vault_baseline:${NETWORK}:${PUB}`;

  it('the FIRST successful load persists a signed baseline even with no sync', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, store);

    // No baseline before the first load (genuinely fresh / wiped-KV device).
    expect(await store.get(baselineKey)).toBeNull();

    // initialize() runs the provider's own FIRST load. The gate is a no-op on this
    // load (no prior baseline — the unavoidable residual), but it MUST persist one.
    const ok = await provider.initialize();
    expect(ok).toBe(true);
    expect(await store.get(baselineKey)).not.toBeNull(); // baseline now durable
  });

  it('the SECOND load IS gated: a server-injected delta after the first load alarms', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, store);

    // First load on a fresh provider, with ONE real flushed entry so there is a
    // concrete row the hostile server can mutate at the next cursor.
    await provider.initialize();
    await provider.sync(txf({ a: { n: 1 } }));
    const first = await provider.load();
    expect(first.success).toBe(true);
    expect(await store.get(baselineKey)).not.toBeNull();

    // Hostile server mutates the entry at the next monotonic cursor, no epoch bump.
    const wkA = wireKey(PRIV, NETWORK, 'a');
    server.mutateEntry(PUB, wkA, seal('a', 99, { n: 'tampered' }));

    const events: StorageEvent[] = [];
    provider.onEvent((e) => events.push(e));
    const res = await provider.load(); // the SECOND load is gated against the baseline

    expect(res.success).toBe(false);
    const err = events.find((e) => e.type === 'storage:error');
    expect(err).toBeDefined();
    expect((err!.data as { reason: string }).reason).toBe('rollback');
  });
});
