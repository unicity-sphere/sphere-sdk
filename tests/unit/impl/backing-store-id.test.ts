/**
 * #766 — `StorageProvider.backingStoreId` identifies the STORE, not the object and not
 * the class.
 *
 * `Sphere.clear()` tears down the live Spheres of every provider that reports the same
 * value, so the value has to be exactly as coarse as the data: equal whenever two
 * providers would read and erase each other's keys, different whenever they would not.
 * A class constant (`id`) collides every wallet in the process; the object's own identity
 * (the default fallback) never collides at all and misses the case this exists for.
 */

import { describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { IndexedDBStorageProvider } from '../../../impl/browser/storage/IndexedDBStorageProvider';
import { LocalStorageProvider } from '../../../impl/browser/storage/LocalStorageProvider';

function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => { data.delete(k); },
    setItem: (k: string, v: string) => { data.set(k, v); },
  } as Storage;
}

describe('FileStorageProvider.backingStoreId', () => {
  const dataDir = path.join(os.tmpdir(), 'sphere-backing-store-id');

  it('is equal for two providers over one wallet file, however the path was written', () => {
    const a = new FileStorageProvider({ dataDir });
    // Same file, spelled relative to the cwd: unresolved, the two strings differ and the
    // providers look unrelated while writing the same wallet.json.
    const b = new FileStorageProvider({ dataDir: path.relative(process.cwd(), dataDir) });
    const c = new FileStorageProvider(dataDir);

    expect(a).not.toBe(b);
    expect(a.backingStoreId).toBe(b.backingStoreId);
    expect(a.backingStoreId, 'the string-config constructor addresses the same file').toBe(
      c.backingStoreId,
    );
  });

  it('differs for a different directory or a different file in one directory', () => {
    const a = new FileStorageProvider({ dataDir });
    const elsewhere = new FileStorageProvider({ dataDir: `${dataDir}-other` });
    const otherFile = new FileStorageProvider({ dataDir, fileName: 'second.json' });

    expect(a.backingStoreId).not.toBe(elsewhere.backingStoreId);
    expect(a.backingStoreId).not.toBe(otherFile.backingStoreId);
  });

  it('is not the class constant `id`', () => {
    const a = new FileStorageProvider({ dataDir });
    expect(a.backingStoreId).not.toBe(a.id);
  });
});

describe('IndexedDBStorageProvider.backingStoreId', () => {
  it('is equal for two providers over one database + prefix', () => {
    const a = new IndexedDBStorageProvider();
    const b = new IndexedDBStorageProvider({ dbName: 'sphere-storage', prefix: 'sphere_' });

    expect(a).not.toBe(b);
    expect(a.backingStoreId, 'those ARE the defaults').toBe(b.backingStoreId);
  });

  it('differs on the database name and on the key prefix independently', () => {
    const base = new IndexedDBStorageProvider({ dbName: 'db-a', prefix: 'p_' });
    const otherDb = new IndexedDBStorageProvider({ dbName: 'db-b', prefix: 'p_' });
    const otherPrefix = new IndexedDBStorageProvider({ dbName: 'db-a', prefix: 'q_' });

    expect(base.backingStoreId).not.toBe(otherDb.backingStoreId);
    expect(base.backingStoreId).not.toBe(otherPrefix.backingStoreId);
  });

  it('cannot be forged across the dbName/prefix boundary', () => {
    // Unencoded concatenation would make ('a:b','c') and ('a','b:c') one store.
    const left = new IndexedDBStorageProvider({ dbName: 'a:b', prefix: 'c' });
    const right = new IndexedDBStorageProvider({ dbName: 'a', prefix: 'b:c' });
    expect(left.backingStoreId).not.toBe(right.backingStoreId);
  });
});

describe('LocalStorageProvider.backingStoreId', () => {
  it('is equal for two providers over one Storage object and prefix', () => {
    const storage = fakeStorage();
    const a = new LocalStorageProvider({ storage });
    const b = new LocalStorageProvider({ storage, prefix: 'sphere_' });

    expect(a).not.toBe(b);
    expect(a.backingStoreId).toBe(b.backingStoreId);
  });

  it('differs when the Storage object differs, prefix held equal', () => {
    // The SSR fallback mints a private in-memory Storage per provider, so the prefix
    // alone would call two unrelated stores one — and erasure would follow.
    const a = new LocalStorageProvider({ storage: fakeStorage(), prefix: 'sphere_' });
    const b = new LocalStorageProvider({ storage: fakeStorage(), prefix: 'sphere_' });

    expect(a.backingStoreId).not.toBe(b.backingStoreId);
  });

  it('differs when the prefix differs, Storage object held equal', () => {
    const storage = fakeStorage();
    const a = new LocalStorageProvider({ storage, prefix: 'one_' });
    const b = new LocalStorageProvider({ storage, prefix: 'two_' });

    expect(a.backingStoreId).not.toBe(b.backingStoreId);
  });
});

/**
 * The tag that separates two `Storage` objects is minted by a counter, and a counter is
 * per-MODULE. tsup ships each subpath export as its own bundle (`splitting: false`), and
 * ESM/CJS duplicate them again, so two copies of this file each hand THEIR first unrelated
 * `Storage` the tag `1` — two unrelated stores reporting one `backingStoreId`, which is
 * what `Sphere.clear()` uses to decide whose wallet it may destroy. `vi.resetModules()`
 * plus two dynamic imports is a real second module instance over one globalThis: the
 * two-bundle case exactly. It is NOT a second realm (an iframe or worker has its own
 * globalThis and cannot be joined at all), and nothing below claims to cover one.
 */
describe('LocalStorageProvider tags are process-wide, not per-module-copy', () => {
  async function freshCopy(): Promise<typeof import('../../../impl/browser/storage/LocalStorageProvider')> {
    vi.resetModules();
    return import('../../../impl/browser/storage/LocalStorageProvider');
  }

  it('never gives two UNRELATED Storage objects one id across two module copies', async () => {
    const copyA = await freshCopy();
    const copyB = await freshCopy();
    expect(copyA.LocalStorageProvider, 'two genuinely separate module instances').not.toBe(
      copyB.LocalStorageProvider,
    );

    const a = new copyA.LocalStorageProvider({ storage: fakeStorage(), prefix: 'sphere_' });
    const b = new copyB.LocalStorageProvider({ storage: fakeStorage(), prefix: 'sphere_' });

    expect(a.backingStoreId, 'a collision here is one wallet clearing another').not.toBe(
      b.backingStoreId,
    );
  });

  it('gives ONE Storage object the same id from either copy', async () => {
    const copyA = await freshCopy();
    const copyB = await freshCopy();
    // A head start for one copy, so two independent counters cannot agree by accident.
    new copyA.LocalStorageProvider({ storage: fakeStorage(), prefix: 'unrelated_' });
    const storage = fakeStorage();

    const a = new copyA.LocalStorageProvider({ storage, prefix: 'sphere_' });
    const b = new copyB.LocalStorageProvider({ storage, prefix: 'sphere_' });

    expect(b.backingStoreId, 'one store, so one id — that is what erasure follows').toBe(
      a.backingStoreId,
    );
  });
});

describe('the three provider kinds never collide', () => {
  it('gives every implementation its own namespace', () => {
    const ids = [
      new FileStorageProvider({ dataDir: 'sphere_' }).backingStoreId,
      new IndexedDBStorageProvider({ dbName: 'sphere_', prefix: 'sphere_' }).backingStoreId,
      new LocalStorageProvider({ storage: fakeStorage(), prefix: 'sphere_' }).backingStoreId,
    ];
    expect(new Set(ids).size, 'unrelated stores must not share one id').toBe(ids.length);
  });
});
