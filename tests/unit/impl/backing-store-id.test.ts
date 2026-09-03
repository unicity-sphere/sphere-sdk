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
import * as fs from 'fs';
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

  it('differs on the database name', () => {
    const base = new IndexedDBStorageProvider({ dbName: 'db-a', prefix: 'p_' });
    const otherDb = new IndexedDBStorageProvider({ dbName: 'db-b', prefix: 'p_' });

    expect(base.backingStoreId).not.toBe(otherDb.backingStoreId);
  });

  it('IGNORES the key prefix — clear() erases the whole database', () => {
    // This used to assert the opposite, and that was the bug: clear() with no
    // prefix calls idbClear(), which empties the entire `kv` object store. Two
    // prefixed wallets in one database therefore share an ERASURE fate, and
    // backingStoreId names the unit of erasure. Split them into separate
    // liveness buckets and clearing either wipes the other's data while leaving
    // its Sphere isReady over an emptied store — #766, one dimension over.
    const p = new IndexedDBStorageProvider({ dbName: 'db-a', prefix: 'p_' });
    const q = new IndexedDBStorageProvider({ dbName: 'db-a', prefix: 'q_' });

    expect(p.backingStoreId).toBe(q.backingStoreId);
  });

  it('still encodes the database name rather than concatenating it raw', () => {
    // Narrower than before (there is one field now), but a dbName carrying the
    // scheme delimiter must not be able to impersonate another store.
    const odd = new IndexedDBStorageProvider({ dbName: 'a:b' });
    const plain = new IndexedDBStorageProvider({ dbName: 'a' });
    expect(odd.backingStoreId).not.toBe(plain.backingStoreId);
    expect(odd.backingStoreId).not.toContain('a:b');
  });
});

describe('FileStorageProvider.backingStoreId — aliases of one file', () => {
  it('is equal through a symlinked directory and the real one', () => {
    // path.resolve is LEXICAL: it leaves a symlink alias and the real path as
    // different strings for ONE wallet.json. Split, Sphere.clear() through one
    // alias misses the Sphere registered through the other — wiping its file
    // and leaving it isReady over the remains.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsid-'));
    const real = path.join(root, 'real');
    const link = path.join(root, 'link');
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch {
      return; // no symlink privilege (Windows CI) — nothing to assert
    }

    const viaReal = new FileStorageProvider({ dataDir: real });
    const viaLink = new FileStorageProvider({ dataDir: link });

    expect(viaReal.backingStoreId).toBe(viaLink.backingStoreId);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('SEPARATES two paths differing only in a final-component symlink', () => {
    // A directory symlink is a true alias; the FILE NAME is not. save() writes
    // `${filePath}.tmp` and renames it OVER filePath, which replaces a
    // final-component symlink rather than writing through it — so the two paths
    // diverge on the first save and must not share a lifecycle bucket. Clearing
    // through the link would otherwise destroy the target's Sphere while the
    // target file stayed intact.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsid-'));
    fs.writeFileSync(path.join(root, 'real.json'), '{}');
    try {
      fs.symlinkSync(path.join(root, 'real.json'), path.join(root, 'link.json'));
    } catch {
      return; // no symlink privilege
    }

    const viaReal = new FileStorageProvider({ dataDir: root, fileName: 'real.json' });
    const viaLink = new FileStorageProvider({ dataDir: root, fileName: 'link.json' });

    expect(viaReal.backingStoreId).not.toBe(viaLink.backingStoreId);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still separates genuinely different directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsid-'));
    const a = new FileStorageProvider({ dataDir: path.join(root, 'a') });
    const b = new FileStorageProvider({ dataDir: path.join(root, 'b') });

    expect(a.backingStoreId).not.toBe(b.backingStoreId);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('agrees before the directory exists and after it is created', () => {
    // The canonicalisation walks up to the deepest EXISTING ancestor, so a
    // provider built against a not-yet-created dataDir must not disagree with
    // one built after connect() made it.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bsid-')));
    const dir = path.join(root, 'not-yet');
    const before = new FileStorageProvider({ dataDir: dir });
    fs.mkdirSync(dir);
    const after = new FileStorageProvider({ dataDir: dir });

    expect(before.backingStoreId).toBe(after.backingStoreId);
    fs.rmSync(root, { recursive: true, force: true });
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
