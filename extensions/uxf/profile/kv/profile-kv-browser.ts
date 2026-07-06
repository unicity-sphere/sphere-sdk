/**
 * ProfileKvBrowser — IndexedDB-backed durable KV backend for the profile
 * substrate in browsers.
 *
 * Replaces the OrbitDB `keyvalue` database that used to sit under
 * `ProfileDatabase`. Same semantics as the Node variant, backed by a
 * single IndexedDB object store per profile DB. Prefix scan uses an
 * IDB key-range cursor for O(matched) rather than O(N) iteration.
 *
 * Zero dependency on `helia`, `@orbitdb/core`, `libp2p`.
 *
 * @module extensions/uxf/profile/kv/profile-kv-browser
 */

import { logger } from '../../../../core/logger.js';
import { incr, observeMs } from '../../../../core/perf-counters.js';
import { ProfileError } from '../errors.js';
import type { ProfileKvBackend } from './profile-kv-node.js';

const STORE_NAME = 'kv';
const IDB_VERSION = 1;

export interface ProfileKvBrowserOptions {
  /** IndexedDB database name (e.g. `sphere-profile-kv-<16-hex>`). */
  readonly dbName: string;
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_NAME, mode);
    const store = t.objectStore(STORE_NAME);
    let result: T;
    let inner: Promise<T>;
    try {
      inner = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    inner
      .then((r) => {
        result = r;
      })
      .catch((err) => reject(err));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('IDB transaction aborted'));
  });
}

/**
 * IndexedDB-backed KV. See module doc.
 */
export class ProfileKvBrowser implements ProfileKvBackend {
  private readonly dbName: string;
  private db: IDBDatabase | null = null;

  constructor(opts: ProfileKvBrowserOptions) {
    if (!opts.dbName) {
      throw new ProfileError(
        'PROFILE_KV_INIT_FAILED',
        'ProfileKvBrowser requires a non-empty `dbName` option',
      );
    }
    this.dbName = opts.dbName;
  }

  async open(): Promise<void> {
    if (this.db) return;
    if (typeof indexedDB === 'undefined') {
      throw new ProfileError(
        'PROFILE_KV_INIT_FAILED',
        'ProfileKvBrowser: indexedDB is not available in this runtime',
      );
    }
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(this.dbName, IDB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () =>
        reject(
          new ProfileError(
            'PROFILE_KV_CONNECTION_FAILED',
            `ProfileKvBrowser: open blocked for ${this.dbName}`,
          ),
        );
    });
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  private ensureOpen(): IDBDatabase {
    if (!this.db) {
      throw new ProfileError(
        'PROFILE_KV_NOT_OPEN',
        'ProfileKvBrowser: operation before open()',
      );
    }
    return this.db;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const db = this.ensureOpen();
    const t0 = performance.now();
    try {
      await tx(db, 'readwrite', async (store) => {
        await req(store.put(value, key));
        return null;
      });
      incr('profile-kv.put');
    } catch (err) {
      incr('profile-kv.put.error');
      throw new ProfileError(
        'PROFILE_KV_WRITE_FAILED',
        `Failed to write key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      observeMs('profile-kv.put.totalMs', performance.now() - t0);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = this.ensureOpen();
    const t0 = performance.now();
    try {
      const value = await tx(db, 'readonly', async (store) => {
        return req(store.get(key));
      });
      if (value === undefined || value === null) {
        observeMs('profile-kv.get.missMs', performance.now() - t0);
        return null;
      }
      observeMs('profile-kv.get.hitMs', performance.now() - t0);
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (Array.isArray(value)) return new Uint8Array(value);
      logger.warn(
        'ProfileKvBrowser',
        `get(): unexpected stored value shape for key="${key}"`,
      );
      return null;
    } catch (err) {
      incr('profile-kv.get.error');
      throw new ProfileError(
        'PROFILE_KV_READ_FAILED',
        `Failed to read key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async del(key: string): Promise<void> {
    const db = this.ensureOpen();
    const t0 = performance.now();
    try {
      await tx(db, 'readwrite', async (store) => {
        await req(store.delete(key));
        return null;
      });
      incr('profile-kv.del');
    } catch (err) {
      incr('profile-kv.del.error');
      throw new ProfileError(
        'PROFILE_KV_WRITE_FAILED',
        `Failed to delete key "${key}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      observeMs('profile-kv.del.totalMs', performance.now() - t0);
    }
  }

  async all(
    prefix?: string,
    opts?: { readonly maxResults?: number },
  ): Promise<Map<string, Uint8Array>> {
    const db = this.ensureOpen();
    const t0 = performance.now();
    const cap =
      opts?.maxResults !== undefined &&
      Number.isFinite(opts.maxResults) &&
      opts.maxResults >= 0
        ? Math.floor(opts.maxResults)
        : undefined;
    const result = new Map<string, Uint8Array>();
    try {
      await tx(db, 'readonly', async (store) => {
        // Use a key range for prefix scans. The upper bound is the next
        // string after the prefix in lexicographic order (append a high
        // unicode code point).
        let range: IDBKeyRange | undefined;
        if (prefix && prefix.length > 0) {
          const upper = prefix + '￿';
          range = IDBKeyRange.bound(prefix, upper, false, true);
        }
        return new Promise<void>((resolve, reject) => {
          const cursorReq = store.openCursor(range);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
              resolve();
              return;
            }
            const key = String(cursor.key);
            const value = cursor.value;
            if (cap !== undefined && result.size >= cap) {
              resolve();
              return;
            }
            let coerced: Uint8Array | null = null;
            if (value instanceof Uint8Array) coerced = value;
            else if (value instanceof ArrayBuffer) coerced = new Uint8Array(value);
            else if (Array.isArray(value)) coerced = new Uint8Array(value);
            if (coerced !== null) {
              result.set(key, coerced);
            } else {
              logger.warn(
                'ProfileKvBrowser',
                `all(): skipping unexpected value shape at key="${key}"`,
              );
            }
            cursor.continue();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
      });
      incr('profile-kv.all.calls');
      observeMs('profile-kv.all.totalMs', performance.now() - t0);
      return result;
    } catch (err) {
      incr('profile-kv.all.error');
      throw new ProfileError(
        'PROFILE_KV_READ_FAILED',
        `Failed to scan${prefix ? ` prefix "${prefix}"` : ''}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    const db = this.ensureOpen();
    const out: string[] = [];
    await tx(db, 'readonly', async (store) => {
      let range: IDBKeyRange | undefined;
      if (prefix && prefix.length > 0) {
        const upper = prefix + '￿';
        range = IDBKeyRange.bound(prefix, upper, false, true);
      }
      return new Promise<void>((resolve, reject) => {
        const cursorReq = store.openKeyCursor(range);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            resolve();
            return;
          }
          out.push(String(cursor.key));
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    });
    return out;
  }

  async reset(): Promise<void> {
    await this.close();
    if (typeof indexedDB === 'undefined') return;
    await new Promise<void>((resolve, reject) => {
      const del = indexedDB.deleteDatabase(this.dbName);
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => resolve(); // best-effort
    });
  }
}
