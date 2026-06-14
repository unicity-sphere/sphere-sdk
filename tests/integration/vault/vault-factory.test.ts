/**
 * createVaultTokenStorage factory (vault wallet wiring, concern 2).
 *
 * The wallet cannot construct a RemoteTokenStorageProvider itself — it has only the
 * PUBLIC identity, but the provider needs the raw spend key at construction. This
 * factory is the SDK-internal seam that builds the provider from a FullIdentity (key
 * in scope), resolving the vault URL + server key from NETWORKS, wiring the real http
 * clients over ONE shared auth session, and persisting the anti-rollback baseline
 * durably via StorageBaselineStore.
 *
 * Driven end-to-end over a REAL node:http socket fronting the in-memory fakes so the
 * full handshake + data path runs through real fetch (no mongo).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { createVaultTokenStorage } from '../../../storage/remote/factory';
import { VAULT_BASELINE_KEY_PREFIX } from '../../../storage/remote/local-baseline-store';
import { startRealVaultSocket, type RealVaultSocket } from '../../helpers/real-vault-socket';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types';

const NETWORK = 'testnet2';
const PRIV = '9d'.repeat(32);
const PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(PRIV), true));
const identity: FullIdentity = { chainPubkey: PUB, l1Address: 'alpha1factory', privateKey: PRIV };

/** A minimal in-memory StorageProvider slice (the factory only needs get/set). */
function memStorage(): Pick<StorageProvider, 'get' | 'set'> & { dump(): Map<string, string> } {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => Promise.resolve(void m.set(k, v)),
    dump: () => m,
  };
}

function txf(tokens: Record<string, unknown>): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() },
  };
  for (const [id, val] of Object.entries(tokens)) data[`_${id}` as `_${string}`] = val;
  return data;
}

let socket: RealVaultSocket;
beforeEach(async () => {
  socket = await startRealVaultSocket(NETWORK);
});
afterEach(async () => {
  await socket.close();
});

describe('createVaultTokenStorage', () => {
  it('builds a provider that authenticates + flushes over real fetch (one shared session)', async () => {
    const storage = memStorage();
    const provider = createVaultTokenStorage({
      identity,
      network: NETWORK,
      storage: storage as unknown as StorageProvider,
      vaultUrl: socket.baseUrl, // override the NETWORKS url for the test socket
    });

    provider.setIdentity(identity);
    expect(await provider.initialize()).toBe(true); // auth + first load via real http

    const res = await provider.sync(txf({ aaa: { amt: '7' } }));
    expect(res.success).toBe(true);
    expect(res.added).toBe(1);
    // The data client shared the provider's JWT session: the entry reached the server.
    expect(socket.vault.entryCount(PUB)).toBeGreaterThanOrEqual(1);
  });

  it('persists the anti-rollback baseline durably into the injected StorageProvider', async () => {
    const storage = memStorage();
    const provider = createVaultTokenStorage({
      identity,
      network: NETWORK,
      storage: storage as unknown as StorageProvider,
      vaultUrl: socket.baseUrl,
    });
    provider.setIdentity(identity);
    await provider.initialize();
    await provider.sync(txf({ aaa: { amt: '7' } })); // a clean flush re-signs the baseline

    const baselineRows = [...storage.dump().keys()].filter((k) => k.includes(VAULT_BASELINE_KEY_PREFIX));
    expect(baselineRows.length).toBeGreaterThanOrEqual(1);
    expect(baselineRows[0]).toContain(PUB); // namespaced by owner
  });

  it('resolves vaultUrl + vaultServerKey from NETWORKS when not overridden', () => {
    const storage = memStorage();
    // No vaultUrl override → the provider is built against NETWORKS[network].vaultUrl.
    // It still accepts the matching identity (the construction-time key matches).
    const provider = createVaultTokenStorage({
      identity,
      network: NETWORK,
      storage: storage as unknown as StorageProvider,
    });
    expect(() => provider.setIdentity(identity)).not.toThrow();
  });

  it('builds a provider keyed to the identity it was given (mismatch fails loud)', () => {
    const storage = memStorage();
    const otherPriv = '4e'.repeat(32);
    const otherPub = bytesToHex(secp256k1.getPublicKey(hexToBytes(otherPriv), true));
    const provider = createVaultTokenStorage({
      identity, // built for PRIV/PUB
      network: NETWORK,
      storage: storage as unknown as StorageProvider,
      vaultUrl: socket.baseUrl,
    });

    // Pointing it at a DIFFERENT address must throw (the construction-time key is PRIV).
    const mismatched: FullIdentity = { chainPubkey: otherPub, l1Address: 'x', privateKey: otherPriv };
    expect(() => provider.setIdentity(mismatched)).toThrow(/identity|key|address/i);
  });
});
