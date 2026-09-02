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

describeTrackedAddressesContract('FileStorageProvider', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-tracked-'));
  const provider = new FileStorageProvider({ dataDir });
  await provider.connect();
  return {
    provider,
    cleanup: async () => {
      await provider.disconnect();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
});

describeTrackedAddressesContract('IndexedDBStorageProvider', async () => {
  const provider = new IndexedDBStorageProvider({ prefix: 'test_', dbName: `tracked-db-${seq++}` });
  await provider.connect();
  return { provider, cleanup: () => provider.disconnect() };
});

describeTrackedAddressesContract('LocalStorageProvider', async () => {
  const provider = new LocalStorageProvider({ prefix: 'test_', storage: memoryWebStorage() });
  await provider.connect();
  return { provider, cleanup: () => provider.disconnect() };
});
