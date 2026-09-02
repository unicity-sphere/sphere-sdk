/**
 * The saveTrackedAddresses merge contract, run against ALL THREE StorageProvider
 * implementations. Each carries its own copy of the read-merge-write, so a suite
 * bound to one of them leaves the other two free to regress to a wholesale write —
 * the lost update that erases a live Sphere's address (#766 item 5).
 */
import 'fake-indexeddb/auto';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

import type { StorageProvider } from '../../../storage';
import { IndexedDBStorageProvider } from '../../../impl/browser/storage/IndexedDBStorageProvider';
import { LocalStorageProvider } from '../../../impl/browser/storage/LocalStorageProvider';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { describeTrackedAddressesContract } from './contracts/tracked-addresses.contract';

let seq = 0;

/** Enough of the Web Storage surface for LocalStorageProvider (get/set/remove + keys()). */
function memoryWebStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number { return map.size; },
    clear: (): void => { map.clear(); },
    getItem: (key: string): string | null => map.get(key) ?? null,
    key: (i: number): string | null => Array.from(map.keys())[i] ?? null,
    removeItem: (key: string): void => { map.delete(key); },
    setItem: (key: string, value: string): void => { map.set(key, value); },
  } as Storage;
}

/** The one-shot failure most providers offer: the underlying `set` rejects once. */
function failNextSet(provider: StorageProvider): (message: string) => void {
  return (message) => {
    vi.spyOn(provider, 'set').mockRejectedValueOnce(new Error(message));
  };
}

describeTrackedAddressesContract('FileStorageProvider', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-tracked-'));
  const provider = new FileStorageProvider({ dataDir });
  await provider.connect();
  return {
    provider,
    failNextWrite: failNextSet(provider),
    cleanup: async () => {
      await provider.disconnect();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}, {
  crossObject: {
    // Not an oversight and not fixable here: FileStorageProvider caches the WHOLE key-value
    // store in memory and rewrites the entire file on every set(), so a sibling object rolls
    // the registry back on any unrelated write — a strictly larger lost update than this
    // contract, tracked as #771. Serializing the tracked-address write alone would make the
    // case pass while leaving the provider unsafe.
    unsupported: 'whole-file rewrite from a per-object cache — #771',
  },
});

describeTrackedAddressesContract('IndexedDBStorageProvider', async () => {
  const dbName = `tracked-db-${seq++}`;
  const open = async (): Promise<IndexedDBStorageProvider> => {
    const created = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
    await created.connect();
    return created;
  };
  const provider = await open();
  const siblings: IndexedDBStorageProvider[] = [];
  return {
    provider,
    sibling: async () => {
      const created = await open();
      siblings.push(created);
      return created;
    },
    // A refused transaction is how IndexedDB fails a write; the read-merge-write takes
    // one, so this breaks exactly the next persist and nothing after it.
    failNextWrite: (message) => {
      const { db } = provider as unknown as { db: IDBDatabase };
      vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
        throw new Error(message);
      });
    },
    cleanup: async () => {
      for (const each of [provider, ...siblings]) await each.disconnect();
    },
  };
}, { crossObject: true });

describeTrackedAddressesContract('LocalStorageProvider', async () => {
  const storage = memoryWebStorage();
  const open = async (): Promise<LocalStorageProvider> => {
    const created = new LocalStorageProvider({ prefix: 'test_', storage });
    await created.connect();
    return created;
  };
  const provider = await open();
  const siblings: LocalStorageProvider[] = [];
  return {
    provider,
    sibling: async () => {
      const created = await open();
      siblings.push(created);
      return created;
    },
    failNextWrite: failNextSet(provider),
    cleanup: async () => {
      for (const each of [provider, ...siblings]) await each.disconnect();
    },
  };
}, { crossObject: true });
