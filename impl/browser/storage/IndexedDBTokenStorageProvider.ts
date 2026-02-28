/**
 * IndexedDB Token Storage Provider for Browser
 * Stores tokens in IndexedDB for persistent browser storage
 * Each address gets its own database for multi-address support
 */

import { logger } from '../../../core/logger';
import type { TokenStorageProvider, TxfStorageDataBase, SyncResult, SaveResult, LoadResult, HistoryRecord } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';
import { getAddressId } from '../../../constants';

// Re-export HistoryRecord for backwards compat
export type { HistoryRecord } from '../../../storage';

// =============================================================================
// Configuration
// =============================================================================

const DB_NAME = 'sphere-token-storage';
const DB_VERSION = 2;
const STORE_TOKENS = 'tokens';
const STORE_META = 'meta';
const STORE_HISTORY = 'history';

export interface IndexedDBTokenStorageConfig {
  /** Database name prefix (default: 'sphere-token-storage') */
  dbNamePrefix?: string;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/** Global connection counter for diagnostic tracing */
let connectionSeq = 0;

export class IndexedDBTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'indexeddb-token-storage';
  readonly name = 'IndexedDB Token Storage';
  readonly type = 'local' as const;

  private dbNamePrefix: string;
  private dbName: string;
  private debug: boolean;
  private db: IDBDatabase | null = null;
  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;
  /** Monotonic connection ID for tracing open/close pairs */
  private connId = 0;

  constructor(config?: IndexedDBTokenStorageConfig) {
    this.dbNamePrefix = config?.dbNamePrefix ?? DB_NAME;
    this.dbName = this.dbNamePrefix;
    this.debug = config?.debug ?? false;
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    // Scope database to address using consistent addressId format
    if (identity.directAddress) {
      const addressId = getAddressId(identity.directAddress);
      this.dbName = `${this.dbNamePrefix}-${addressId}`;
    }
    logger.debug('IndexedDBToken', `setIdentity: db=${this.dbName}`);
  }

  async initialize(): Promise<boolean> {
    const prevConnId = this.connId;
    const t0 = Date.now();
    try {
      // Close any existing connection before opening a new one
      // (e.g. when switching addresses — prevents leaked IDB connections)
      if (this.db) {
        logger.debug('IndexedDBToken', `initialize: closing existing connId=${prevConnId} before re-open (db=${this.dbName})`);
        this.db.close();
        this.db = null;
      }

      logger.debug('IndexedDBToken', `initialize: opening db=${this.dbName}`);
      this.db = await this.openDatabase();
      this.status = 'connected';
      logger.debug('IndexedDBToken', `initialize: connected db=${this.dbName} connId=${this.connId} (${Date.now() - t0}ms)`);
      return true;
    } catch (error) {
      logger.error('IndexedDBToken', `initialize: failed db=${this.dbName} (${Date.now() - t0}ms):`, error);
      this.status = 'error';
      return false;
    }
  }

  async shutdown(): Promise<void> {
    const cid = this.connId;
    logger.debug('IndexedDBToken', `shutdown: db=${this.dbName} connId=${cid} wasConnected=${!!this.db}`);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.status = 'disconnected';
  }

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.db !== null;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async load(): Promise<LoadResult<TxfStorageDataBase>> {
    if (!this.db) {
      logger.warn('IndexedDBToken', `load: db not initialized (db=${this.dbName})`);
      return {
        success: false,
        error: 'Database not initialized',
        source: 'local',
        timestamp: Date.now(),
      };
    }

    try {
      const data: TxfStorageDataBase = {
        _meta: {
          version: 1,
          address: this.identity?.l1Address ?? '',
          formatVersion: '2.0',
          updatedAt: Date.now(),
        },
      };

      // Load meta
      const meta = await this.getFromStore<TxfStorageDataBase['_meta']>(STORE_META, 'meta');
      if (meta) {
        data._meta = meta;
      }

      // Load all tokens from store
      const tokens = await this.getAllFromStore<{ id: string; data: unknown }>(STORE_TOKENS);
      for (const token of tokens) {
        // Skip file-format entries (token-, nametag-) - they are loaded via loadTokensFromFileStorage
        if (token.id.startsWith('token-') || token.id.startsWith('nametag-')) {
          continue;
        }

        if (token.id.startsWith('archived-')) {
          // Archived tokens: keep as-is (archived-tokenId key)
          data[token.id as keyof TxfStorageDataBase] = token.data;
        } else {
          // Other entries: add _ prefix for TXF format
          const key = `_${token.id}` as `_${string}`;
          data[key] = token.data;
        }
      }

      // Load tombstones
      const tombstones = await this.getFromStore<TxfStorageDataBase['_tombstones']>(STORE_META, 'tombstones');
      if (tombstones) {
        data._tombstones = tombstones;
      }

      // Load outbox
      const outbox = await this.getFromStore<TxfStorageDataBase['_outbox']>(STORE_META, 'outbox');
      if (outbox) {
        data._outbox = outbox;
      }

      // Load sent
      const sent = await this.getFromStore<TxfStorageDataBase['_sent']>(STORE_META, 'sent');
      if (sent) {
        data._sent = sent;
      }

      // Load invalid
      const invalid = await this.getFromStore<TxfStorageDataBase['_invalid']>(STORE_META, 'invalid');
      if (invalid) {
        data._invalid = invalid;
      }

      const tokenKeys = Object.keys(data).filter(k => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid'].includes(k));
      logger.debug('IndexedDBToken', `load: db=${this.dbName}, tokens=${tokenKeys.length}`);

      return {
        success: true,
        data,
        source: 'local',
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('IndexedDBToken', `load failed: db=${this.dbName}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        source: 'local',
        timestamp: Date.now(),
      };
    }
  }

  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    if (!this.db) {
      logger.warn('IndexedDBToken', `save: db not initialized (db=${this.dbName})`);
      return {
        success: false,
        error: 'Database not initialized',
        timestamp: Date.now(),
      };
    }

    try {
      const tokenKeys = Object.keys(data).filter(k => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid'].includes(k));
      const archivedKeys = Object.keys(data).filter(k => k.startsWith('archived-'));
      logger.debug('IndexedDBToken', `save: db=${this.dbName}, tokens=${tokenKeys.length}, archived=${archivedKeys.length}, tombstones=${data._tombstones?.length ?? 0}`);

      // Save meta
      await this.putToStore(STORE_META, 'meta', data._meta);

      // Save special arrays
      if (data._tombstones) {
        await this.putToStore(STORE_META, 'tombstones', data._tombstones);
      }
      if (data._outbox) {
        await this.putToStore(STORE_META, 'outbox', data._outbox);
      }
      if (data._sent) {
        await this.putToStore(STORE_META, 'sent', data._sent);
      }
      if (data._invalid) {
        await this.putToStore(STORE_META, 'invalid', data._invalid);
      }

      // Save each token (active tokens start with _, archived with archived-)
      const reservedKeys = ['_meta', '_tombstones', '_outbox', '_sent', '_invalid'];
      for (const [key, value] of Object.entries(data)) {
        if (reservedKeys.includes(key)) continue;

        if (key.startsWith('_')) {
          // Active token: _tokenId -> tokenId
          const tokenId = key.slice(1);
          await this.putToStore(STORE_TOKENS, tokenId, { id: tokenId, data: value });
        } else if (key.startsWith('archived-')) {
          // Archived token: archived-tokenId -> archived-tokenId (keep prefix)
          await this.putToStore(STORE_TOKENS, key, { id: key, data: value });
        }
      }

      // Handle tombstones - delete tokens
      if (data._tombstones) {
        for (const tombstone of data._tombstones) {
          await this.deleteFromStore(STORE_TOKENS, tombstone.tokenId);
        }
      }

      return {
        success: true,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  }

  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    // For local IndexedDB storage, just save and return
    const saveResult = await this.save(localData);
    return {
      success: saveResult.success,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
      error: saveResult.error,
    };
  }

  async exists(): Promise<boolean> {
    if (!this.db) return false;
    const meta = await this.getFromStore(STORE_META, 'meta');
    return meta !== null;
  }

  async clear(): Promise<boolean> {
    // Uses IDBObjectStore.clear() instead of deleteDatabase().
    // deleteDatabase() is a schema operation that gets blocked by leaked IDB
    // connections (React StrictMode, multiple tabs) and leaves a pending delete
    // that blocks ALL subsequent open() calls, bricking the wallet.
    // store.clear() is a normal readwrite transaction — cannot be blocked.
    const t0 = Date.now();
    try {
      // 1. Close own connection
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      this.status = 'disconnected';

      // 2. Collect all databases with our prefix (current + other addresses)
      const dbNames = new Set<string>([this.dbName]);
      for (const name of await this.findPrefixedDatabases()) {
        dbNames.add(name);
      }

      // 3. Clear stores in each database in parallel
      logger.debug('IndexedDBToken', `clear: clearing ${dbNames.size} database(s) (${[...dbNames].join(', ')})`);
      const results = await Promise.allSettled(
        [...dbNames].map((name) => this.clearDatabaseStores(name)),
      );

      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        logger.warn('IndexedDBToken', `clear: ${failed.length}/${dbNames.size} failed (${Date.now() - t0}ms)`,
          failed.map((r) => (r as PromiseRejectedResult).reason));
      }

      logger.debug('IndexedDBToken', `clear: done ${dbNames.size} database(s) (${Date.now() - t0}ms)`);
      return failed.length === 0;
    } catch (err) {
      logger.warn('IndexedDBToken', `clear: failed (${Date.now() - t0}ms)`, err);
      return false;
    }
  }

  // =========================================================================
  // Private IndexedDB helpers
  // =========================================================================

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        const db = request.result;
        const cid = ++connectionSeq;
        this.connId = cid;

        // Auto-close when another context requests version change or deletion.
        // Prevents leaked connections (e.g. React StrictMode double-mount)
        // from blocking deleteDatabase() or version upgrades.
        db.onversionchange = () => {
          logger.debug('IndexedDBToken', `onversionchange: auto-closing db=${this.dbName} connId=${cid}`);
          db.close();
          if (this.db === db) {
            this.db = null;
            this.status = 'disconnected';
          }
        };
        resolve(db);
      };

      // onblocked fires when another connection holds the database.
      // Log it — onsuccess will follow once the other connection closes.
      request.onblocked = () => {
        logger.warn('IndexedDBToken', `open blocked by another connection, db=${this.dbName}`);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create tokens store
        if (!db.objectStoreNames.contains(STORE_TOKENS)) {
          db.createObjectStore(STORE_TOKENS, { keyPath: 'id' });
        }

        // Create meta store
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }

        // Create history store (v2)
        if (!db.objectStoreNames.contains(STORE_HISTORY)) {
          db.createObjectStore(STORE_HISTORY, { keyPath: 'dedupKey' });
        }
      };
    });
  }

  private getFromStore<T>(storeName: string, key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve(null);
        return;
      }

      const transaction = this.db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }

  private getAllFromStore<T>(storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve([]);
        return;
      }

      const transaction = this.db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? []);
    });
  }

  private putToStore(storeName: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const transaction = this.db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);

      // Meta store: no keyPath, use explicit key
      // Tokens store: keyPath 'id'
      // History store: keyPath 'dedupKey'
      const request = storeName === STORE_META
        ? store.put(value, key)
        : store.put(value);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private deleteFromStore(storeName: string, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }

      const transaction = this.db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Find all IndexedDB databases with our prefix.
   * Returns empty array if indexedDB.databases() is unavailable (older browsers).
   */
  private async findPrefixedDatabases(): Promise<string[]> {
    if (typeof indexedDB.databases !== 'function') return [];
    try {
      const allDbs = await Promise.race([
        indexedDB.databases(),
        new Promise<IDBDatabaseInfo[]>((_, reject) =>
          setTimeout(() => reject(new Error('databases() timed out')), 1500),
        ),
      ]);
      return allDbs
        .map((info) => info.name)
        .filter((name): name is string => !!name && name.startsWith(this.dbNamePrefix));
    } catch {
      return [];
    }
  }

  // =========================================================================
  // Public: History operations
  // =========================================================================

  /**
   * Add a history entry. Uses `put` (upsert by dedupKey) so duplicate
   * calls with the same dedupKey simply overwrite — no duplicates.
   */
  async addHistoryEntry(entry: HistoryRecord): Promise<void> {
    await this.putToStore(STORE_HISTORY, entry.dedupKey, entry);
  }

  /**
   * Get all history entries sorted by timestamp descending.
   */
  async getHistoryEntries(): Promise<HistoryRecord[]> {
    const entries = await this.getAllFromStore<HistoryRecord>(STORE_HISTORY);
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Check if a history entry with the given dedupKey exists.
   */
  async hasHistoryEntry(dedupKey: string): Promise<boolean> {
    const entry = await this.getFromStore<HistoryRecord>(STORE_HISTORY, dedupKey);
    return entry !== null;
  }

  /**
   * Clear all history entries.
   */
  async clearHistory(): Promise<void> {
    if (!this.db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE_HISTORY, 'readwrite');
      const req = tx.objectStore(STORE_HISTORY).clear();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  /**
   * Bulk import history entries. Entries with existing dedupKeys are
   * skipped (first-write-wins). Returns the number of newly imported entries.
   */
  async importHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    if (!this.db || entries.length === 0) return 0;
    let imported = 0;
    for (const entry of entries) {
      const exists = await this.hasHistoryEntry(entry.dedupKey);
      if (!exists) {
        await this.addHistoryEntry(entry);
        imported++;
      }
    }
    return imported;
  }

  // =========================================================================
  // Private IndexedDB helpers (clear)
  // =========================================================================

  /**
   * Clear all object stores in a single database.
   * Opens a temporary connection, clears STORE_TOKENS and STORE_META, then closes.
   * Uses IDBObjectStore.clear() which is a normal readwrite transaction — cannot
   * be blocked by other connections (unlike deleteDatabase()).
   */
  private async clearDatabaseStores(dbName: string): Promise<void> {
    const db = await Promise.race([
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); };
          resolve(db);
        };
        req.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_TOKENS)) {
            db.createObjectStore(STORE_TOKENS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.createObjectStore(STORE_META);
          }
          if (!db.objectStoreNames.contains(STORE_HISTORY)) {
            db.createObjectStore(STORE_HISTORY, { keyPath: 'dedupKey' });
          }
        };
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`open timed out: ${dbName}`)), 3000),
      ),
    ]);

    try {
      for (const storeName of [STORE_TOKENS, STORE_META, STORE_HISTORY]) {
        if (db.objectStoreNames.contains(storeName)) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const req = tx.objectStore(storeName).clear();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve();
          });
        }
      }
    } finally {
      db.close();
    }
  }
}

export function createIndexedDBTokenStorageProvider(
  config?: IndexedDBTokenStorageConfig
): IndexedDBTokenStorageProvider {
  return new IndexedDBTokenStorageProvider(config);
}
