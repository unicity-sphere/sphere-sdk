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
import { describe, expect, it, vi } from 'vitest';

import type { StorageProvider } from '../../../storage';
import type { TrackedAddressEntry } from '../../../types';
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

/**
 * The cross-object merge one level further out: the two providers come from two SEPARATE
 * MODULE COPIES. tsup gives every subpath export its own bundle (`splitting: false`) and
 * ESM/CJS duplicate them again, so a chain map held in module scope orders each copy's
 * writes against itself and nothing else — both copies read the same empty registry and
 * the later write erases the earlier one's address (#766 item 5, across the entry points).
 * `vi.resetModules()` + two dynamic imports is a real second instance over one globalThis.
 */
describe('saveTrackedAddresses serializes across module copies', () => {
  const AT = 1_000;
  const entry = (index: number): TrackedAddressEntry =>
    ({ index, hidden: false, createdAt: AT, updatedAt: AT });

  it('merges concurrent writes from providers built by two different copies', async () => {
    vi.resetModules();
    const copyA = await import('../../../impl/browser/storage/LocalStorageProvider');
    vi.resetModules();
    const copyB = await import('../../../impl/browser/storage/LocalStorageProvider');
    expect(copyA.LocalStorageProvider, 'two genuinely separate module instances').not.toBe(
      copyB.LocalStorageProvider,
    );

    const storage = memoryWebStorage();
    const a = new copyA.LocalStorageProvider({ prefix: 'crossbundle_', storage });
    const b = new copyB.LocalStorageProvider({ prefix: 'crossbundle_', storage });
    await a.connect();
    await b.connect();

    // Disjoint snapshots, no await between them: unserialized, both read the empty
    // registry and whichever lands last is the only one that survives.
    await Promise.all([
      a.saveTrackedAddresses([entry(0), entry(1)]),
      b.saveTrackedAddresses([entry(0), entry(2)]),
    ]);

    const stored = (await b.loadTrackedAddresses()).map((each) => each.index).sort((x, y) => x - y);
    expect(stored, 'neither writer may lose its address to the other').toEqual([0, 1, 2]);

    await a.disconnect();
    await b.disconnect();
  });
});

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
