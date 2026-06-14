/**
 * CourierJournalStore adapter (wallet-courier wiring, concern 1).
 *
 * The {@link CourierDeliveryProvider} persists its read pointer, ACK-PENDING and
 * sent-pending journals through a small {@link CourierJournalStore} (`get`/`set`).
 * Tests inject an in-memory store, but the WALLET needs a durable one over the SDK's
 * key-value {@link StorageProvider}. An in-memory journal resets every reload — the
 * sender would forget which deliveries are still unconfirmed and a recipient would
 * re-pull its whole inbox from `since=0`.
 *
 * {@link StorageCourierJournalStore} adapts the StorageProvider, namespacing every
 * key by `network + chainPubkey` (mirroring {@link StorageBaselineStore}) so two
 * owners (HD address switch) or two networks never share a courier journal row.
 */

import { describe, it, expect } from 'vitest';

import {
  StorageCourierJournalStore,
  COURIER_JOURNAL_KEY_PREFIX,
} from '../../../transport/courier/courier-journal-store';
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

describe('StorageCourierJournalStore', () => {
  it('round-trips a value through set → get', async () => {
    const storage = memStorage();
    const store = new StorageCourierJournalStore(storage as unknown as StorageProvider, NETWORK, OWNER_A);

    expect(await store.get('courier_read_pointer:testnet2:' + OWNER_A)).toBeNull();
    await store.set('courier_read_pointer:testnet2:' + OWNER_A, '7');
    expect(await store.get('courier_read_pointer:testnet2:' + OWNER_A)).toBe('7');
  });

  it('namespaces the underlying storage key by network + chainPubkey', async () => {
    const storage = memStorage();
    const store = new StorageCourierJournalStore(storage as unknown as StorageProvider, NETWORK, OWNER_A);

    await store.set('courier_sent_pending:testnet2:' + OWNER_A, '{}');

    // The persisted key is the adapter's namespaced key, NOT the raw logical key.
    const persistedKeys = [...storage.dump().keys()];
    expect(persistedKeys).toHaveLength(1);
    expect(persistedKeys[0]).toContain(COURIER_JOURNAL_KEY_PREFIX);
    expect(persistedKeys[0]).toContain(NETWORK);
    expect(persistedKeys[0]).toContain(OWNER_A);
  });

  it('isolates owners: owner A and owner B never read each other’s journal', async () => {
    const storage = memStorage(); // one shared underlying storage, two owners
    const storeA = new StorageCourierJournalStore(storage as unknown as StorageProvider, NETWORK, OWNER_A);
    const storeB = new StorageCourierJournalStore(storage as unknown as StorageProvider, NETWORK, OWNER_B);

    await storeA.set('k', 'A-journal');
    await storeB.set('k', 'B-journal');

    expect(await storeA.get('k')).toBe('A-journal');
    expect(await storeB.get('k')).toBe('B-journal');
    expect(storage.dump().size).toBe(2); // two distinct underlying rows
  });

  it('isolates networks: same owner on two networks never shares a journal', async () => {
    const storage = memStorage();
    const mainnet = new StorageCourierJournalStore(storage as unknown as StorageProvider, 'mainnet', OWNER_A);
    const testnet = new StorageCourierJournalStore(storage as unknown as StorageProvider, 'testnet2', OWNER_A);

    await mainnet.set('k', 'mainnet-journal');
    await testnet.set('k', 'testnet-journal');

    expect(await mainnet.get('k')).toBe('mainnet-journal');
    expect(await testnet.get('k')).toBe('testnet-journal');
    expect(storage.dump().size).toBe(2);
  });
});
