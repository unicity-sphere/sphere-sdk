/**
 * Flush serialization + identity fencing (Task 7.3, DESIGN §5.5).
 *
 * flush / sync / shutdown run through a single `AsyncSerialQueue`, so two
 * overlapping flushes never interleave their CAS writes. `setIdentity` increments
 * an identity-epoch counter and drops pending work; an in-flight flush that awaits
 * ACROSS a `setIdentity` ABORTS on the epoch mismatch — no cross-identity write
 * reaches the server. The epoch is re-checked after EVERY await in the flush path.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { RemoteTokenStorageProvider } from '../../../storage/remote/RemoteTokenStorageProvider';
import { FakeVaultServer } from '../../helpers/fake-vault-server';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';
import type { PatchResponse, StateResponse, VaultHttpClient } from '../../../storage/remote/types';

const NETWORK = 'testnet2';
const PRIV_A = '11'.repeat(32);
const PUB_A = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV_A), true));
const identityA: FullIdentity = { chainPubkey: PUB_A, l1Address: 'alphaA', privateKey: PRIV_A };

function txf(tokens: Record<string, unknown>): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const [id, val] of Object.entries(tokens)) data[`_${id}` as `_${string}`] = val;
  return data;
}

/** A latch that lets a test suspend the next `patchEntries` until released. */
function gatedClient(inner: VaultHttpClient, onPatch: () => Promise<void>): VaultHttpClient {
  return {
    patchEntries: async (ops): Promise<PatchResponse> => {
      await onPatch();
      return inner.patchEntries(ops);
    },
    getState: (since): Promise<StateResponse> => inner.getState(since),
    appendHistory: (records) => inner.appendHistory(records),
    historySince: (since) => inner.historySince(since),
    deleteNonce: () => inner.deleteNonce(),
    deleteAccount: (nonce, sig) => inner.deleteAccount(nonce, sig),
  };
}

describe('flush serialization + identity fencing', () => {
  it('an in-flight flush that awaits across setIdentity aborts on the epoch fence (no stale local commit)', async () => {
    const server = new FakeVaultServer(NETWORK);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let gatedOnce = false;

    const provider = new RemoteTokenStorageProvider({
      network: NETWORK,
      vaultUrl: 'u',
      privateKey: PRIV_A,
      authClient: server.authClient(),
      httpClientFactory: (ownerId) => {
        const inner = server.clientFor(ownerId);
        return gatedClient(inner, async () => {
          if (!gatedOnce) { gatedOnce = true; await gate; } // suspend the FIRST patch
        });
      },
    });
    provider.setIdentity(identityA);
    await provider.initialize();

    // Start a flush as identity A; it suspends inside patchEntries (awaits the gate).
    const flushing = provider.sync(txf({ aaa: { amt: '1' } }));
    await Promise.resolve();

    // Bump the identity epoch mid-flush. The multi-address key guard
    // (remote-provider-multiaddress-key-desync) forbids switching to a DIFFERENT
    // key on the same instance, so the epoch bump uses a SAME-KEY identity variant
    // (only l1Address differs) — exactly what exercises the epoch fence without a
    // cross-key desync. Then release the suspended patch.
    const identityASameKey: FullIdentity = { ...identityA, l1Address: 'alphaA-2' };
    provider.setIdentity(identityASameKey);
    release();
    const res = await flushing;

    // The flush aborted on the epoch mismatch: it threw the IdentityFencedError
    // AFTER the patch await, so the local last-known state / signed baseline were
    // NOT committed under the stale epoch and the result is a fenced failure.
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/identity/i);
    expect(provider.knownCount()).toBe(0); // no stale local commit
  });

  it('overlapping flushes are serialized (no interleave) by the AsyncSerialQueue', async () => {
    const server = new FakeVaultServer(NETWORK);
    const order: string[] = [];
    let firstPatch = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const provider = new RemoteTokenStorageProvider({
      network: NETWORK,
      vaultUrl: 'u',
      privateKey: PRIV_A,
      authClient: server.authClient(),
      httpClientFactory: (ownerId) => gatedClient(server.clientFor(ownerId), async () => {
        if (firstPatch) { firstPatch = false; order.push('first-start'); await gate; order.push('first-end'); }
        else { order.push('second'); }
      }),
    });
    provider.setIdentity(identityA);
    await provider.initialize();

    const f1 = provider.sync(txf({ aaa: { amt: '1' } }));
    const f2 = provider.sync(txf({ aaa: { amt: '1' }, bbb: { amt: '2' } }));
    await Promise.resolve();
    release();
    await Promise.all([f1, f2]);

    // The second flush's patch only runs AFTER the first finished (serialized).
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('shutdown drops pending work and runs through the queue', async () => {
    const server = new FakeVaultServer(NETWORK);
    const provider = new RemoteTokenStorageProvider({
      network: NETWORK,
      vaultUrl: 'u',
      privateKey: PRIV_A,
      authClient: server.authClient(),
      httpClientFactory: (ownerId) => server.clientFor(ownerId),
    });
    provider.setIdentity(identityA);
    await provider.initialize();
    await provider.shutdown();
    expect(provider.getStatus()).toBe('disconnected');
  });
});
