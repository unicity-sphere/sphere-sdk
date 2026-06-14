/**
 * LocalBaselineStore adapter (vault wallet wiring, concern 1).
 *
 * The wallet needs a DURABLE anti-rollback baseline `{cursor,root,sig,epoch}` so the
 * signed-root gate survives a reload — an in-memory store resets every reload and
 * silently disables the rollback gate. {@link StorageBaselineStore} adapts the SDK's
 * key-value {@link StorageProvider} into the {@link LocalBaselineStore} the tracker
 * expects, namespaced by `network + chainPubkey` so two owners (or two networks)
 * never share a baseline row.
 */

import { describe, it, expect } from 'vitest';

import { StorageBaselineStore, VAULT_BASELINE_KEY_PREFIX } from '../../../storage/remote/local-baseline-store';
import type { StorageProvider } from '../../../storage/storage-provider';

const NETWORK = 'testnet2';
const OWNER_A = '02' + 'aa'.repeat(32);
const OWNER_B = '02' + 'bb'.repeat(32);

/** Minimal in-memory KV satisfying the slice of StorageProvider the adapter reads. */
function memStorage(): Pick<StorageProvider, 'get' | 'set'> & { dump(): Map<string, string> } {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => Promise.resolve(void m.set(k, v)),
    dump: () => m,
  };
}

describe('StorageBaselineStore', () => {
  it('round-trips a value through set → get', async () => {
    const storage = memStorage();
    const store = new StorageBaselineStore(storage as unknown as StorageProvider, NETWORK, OWNER_A);

    expect(await store.get('vault_baseline:testnet2:' + OWNER_A)).toBeNull();
    await store.set('vault_baseline:testnet2:' + OWNER_A, '{"cursor":5}');
    expect(await store.get('vault_baseline:testnet2:' + OWNER_A)).toBe('{"cursor":5}');
  });

  it('namespaces the underlying storage key by network + chainPubkey', async () => {
    const storage = memStorage();
    const store = new StorageBaselineStore(storage as unknown as StorageProvider, NETWORK, OWNER_A);

    await store.set('vault_baseline:testnet2:' + OWNER_A, 'v');

    // The persisted key is the adapter's namespaced key, NOT the raw logical key.
    const persistedKeys = [...storage.dump().keys()];
    expect(persistedKeys).toHaveLength(1);
    expect(persistedKeys[0]).toContain(VAULT_BASELINE_KEY_PREFIX);
    expect(persistedKeys[0]).toContain(NETWORK);
    expect(persistedKeys[0]).toContain(OWNER_A);
  });

  it('isolates owners: owner A and owner B never read each other’s baseline', async () => {
    const storage = memStorage(); // one shared underlying storage, two owners
    const storeA = new StorageBaselineStore(storage as unknown as StorageProvider, NETWORK, OWNER_A);
    const storeB = new StorageBaselineStore(storage as unknown as StorageProvider, NETWORK, OWNER_B);

    await storeA.set('k', 'A-baseline');
    await storeB.set('k', 'B-baseline');

    expect(await storeA.get('k')).toBe('A-baseline');
    expect(await storeB.get('k')).toBe('B-baseline');
    expect(storage.dump().size).toBe(2); // two distinct underlying rows
  });

  it('isolates networks: same owner on two networks never shares a baseline', async () => {
    const storage = memStorage();
    const mainnet = new StorageBaselineStore(storage as unknown as StorageProvider, 'mainnet', OWNER_A);
    const testnet = new StorageBaselineStore(storage as unknown as StorageProvider, 'testnet2', OWNER_A);

    await mainnet.set('k', 'mainnet-baseline');
    await testnet.set('k', 'testnet-baseline');

    expect(await mainnet.get('k')).toBe('mainnet-baseline');
    expect(await testnet.get('k')).toBe('testnet-baseline');
    expect(storage.dump().size).toBe(2);
  });
});
