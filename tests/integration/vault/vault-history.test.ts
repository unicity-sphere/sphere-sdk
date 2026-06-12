/**
 * History single channel (Task 7.4, DESIGN §5.6) against the in-process fake server.
 *
 * `flush()` diffs the `_history` dedupKeys vs a persisted pushed-set and POSTs only
 * NEW records to `/v1/history` (each payload AEAD-sealed `{nonce,ct}` like a vault
 * entry). `load()` GETs `/v1/history` (paginating by seq), decrypts each payload to a
 * `HistoryRecord`, and attaches them as `_history` for the existing import hook
 * (`importHistoryEntries`). `appendHistory` is idempotent: a duplicate dedupKey is
 * counted `accepted` (not an error); a real error rethrows.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { LocalBaselineStore } from '../../../storage/remote/load-delta';
import type { HistoryRecord, TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '8a'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1me', privateKey: PRIV };

function memStore(): LocalBaselineStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeProvider(server: FakeVaultServer, store: LocalBaselineStore): RemoteTokenStorageProvider {
  const p = new RemoteTokenStorageProvider({
    network: NETWORK,
    vaultUrl: 'u',
    privateKey: PRIV,
    authClient: server.authClient(),
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    localBaseline: store,
  });
  p.setIdentity(identity);
  return p;
}

function hist(dedupKey: string, type: HistoryRecord['type'] = 'RECEIVED'): HistoryRecord {
  return { dedupKey, id: `id-${dedupKey}`, type, amount: '1', coinId: 'UCT', symbol: 'UCT', timestamp: 1 };
}

function txf(history: HistoryRecord[]): TxfStorageDataBase {
  return {
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
    _history: history,
  };
}

describe('history single channel', () => {
  it('flush POSTs only NEW history records (pushed-set diff)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server, memStore());
    await provider.initialize();

    await provider.sync(txf([hist('h1'), hist('h2')]));
    expect(server.historyCount(PUB)).toBe(2);
    expect(server.calls.historyAppend).toHaveLength(1);
    expect(server.calls.historyAppend[0].map((r) => r.dedupKey)).toEqual(['h1', 'h2']);

    // A second flush adding only h3 POSTs h3 alone (h1/h2 already pushed).
    await provider.sync(txf([hist('h1'), hist('h2'), hist('h3')]));
    expect(server.historyCount(PUB)).toBe(3);
    expect(server.calls.historyAppend).toHaveLength(2);
    expect(server.calls.historyAppend[1].map((r) => r.dedupKey)).toEqual(['h3']);
  });

  it('the history payload is AEAD-sealed {nonce,ct} (operator-blind)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = makeProvider(server, memStore());
    await provider.initialize();
    await provider.sync(txf([hist('secret-key')]));

    const posted = server.calls.historyAppend[0][0];
    expect(typeof posted.payload.nonce).toBe('string');
    expect(typeof posted.payload.ct).toBe('string');
    // The plaintext dedupKey rides on the wire (it is the dedup index), but the
    // record body is sealed — the ciphertext does not leak the id/coin in clear.
    expect(posted.payload.ct).not.toContain('UCT');
  });

  it('load GETs /v1/history, decrypts, and attaches _history for importHistoryEntries', async () => {
    const server = new FakeVaultServer(NETWORK);
    const writer = makeProvider(server, memStore());
    await writer.initialize();
    await writer.sync(txf([hist('h1', 'SENT'), hist('h2', 'MINT')]));

    // A fresh reader loads and recovers the history records, decrypted.
    const reader = makeProvider(server, memStore());
    const res = await reader.load();
    expect(res.success).toBe(true);
    const recovered = (res.data!._history ?? []).slice().sort((a, b) => a.dedupKey.localeCompare(b.dedupKey));
    expect(recovered.map((r) => r.dedupKey)).toEqual(['h1', 'h2']);
    expect(recovered.find((r) => r.dedupKey === 'h1')!.type).toBe('SENT');
    expect(recovered.find((r) => r.dedupKey === 'h2')!.type).toBe('MINT');

    // The recovered records are also queryable via the contract history ops.
    const entries = await reader.getHistoryEntries();
    expect(entries.map((e) => e.dedupKey).sort()).toEqual(['h1', 'h2']);
    expect(await reader.hasHistoryEntry('h1')).toBe(true);
  });

  it('history paginates by seq across pages until a short page', async () => {
    const server = new FakeVaultServer({ network: NETWORK, pageLimit: 2 });
    const writer = makeProvider(server, memStore());
    await writer.initialize();
    await writer.sync(txf([hist('a'), hist('b'), hist('c'), hist('d'), hist('e')]));

    const reader = makeProvider(server, memStore());
    server.calls.historySince.length = 0;
    const res = await reader.load();
    expect(res.success).toBe(true);
    // 5 rows / pageLimit 2 → since 0,2,4 → a 3rd short page ends the loop.
    expect(server.calls.historySince).toEqual([0, 2, 4]);
    expect((res.data!._history ?? []).map((r) => r.dedupKey).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a duplicate dedupKey is idempotent (accepted, not an error)', async () => {
    const server = new FakeVaultServer(NETWORK);
    const store = memStore();
    const provider = makeProvider(server, store);
    await provider.initialize();
    await provider.sync(txf([hist('dup')]));

    // A foreign writer (same owner) re-posts 'dup' directly — the server idempotently
    // accepts it without inserting a second row.
    const direct = server.clientFor(PUB);
    const resp = await direct.appendHistory([{ dedupKey: 'dup', payload: { nonce: 'bg==', ct: 'Yw==' } }]);
    expect(resp.accepted).toBe(1);
    expect(resp.rejected).toHaveLength(0);
    expect(server.historyCount(PUB)).toBe(1); // still one row
  });
});
