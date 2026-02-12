/**
 * IndexedDB Token Storage Provider for Browser
 * Stores tokens in IndexedDB for persistent browser storage
 * Each address gets its own database for multi-address support
 */

import type { TokenStorageProvider, TxfStorageDataBase, SyncResult, SaveResult, LoadResult } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';
import { getAddressId } from '../../../constants';

const DB_NAME = 'sphere-token-storage';
const DB_VERSION = 1;
const STORE_TOKENS = 'tokens';
const STORE_META = 'meta';

export interface IndexedDBTokenStorageConfig {
  /** Database name prefix (default: 'sphere-token-storage') */
  dbNamePrefix?: string;
}

export class IndexedDBTokenStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'indexeddb-token-storage';
  readonly name = 'IndexedDB Token Storage';
  readonly type = 'local' as const;

  private dbNamePrefix: string;
  private dbName: string;
  private db: IDBDatabase | null = null;
  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;

  constructor(config?: IndexedDBTokenStorageConfig) {
    this.dbNamePrefix = config?.dbNamePrefix ?? DB_NAME;
    this.dbName = this.dbNamePrefix;
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    // Scope database to address using consistent addressId format
    if (identity.directAddress) {
      const addressId = getAddressId(identity.directAddress);
      this.dbName = `${this.dbNamePrefix}-${addressId}`;
    }
  }

  async initialize(): Promise<boolean> {
    try {
      this.db = await this.openDatabase();
      this.status = 'connected';
      return true;
    } catch (error) {
      console.error('[IndexedDBTokenStorage] Failed to initialize:', error);
      this.status = 'error';
      return false;
    }
  }

  async shutdown(): Promise<void> {
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

      return {
        success: true,
        data,
        source: 'local',
        timestamp: Date.now(),
      };
    } catch (error) {
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
      return {
        success: false,
        error: 'Database not initialized',
        timestamp: Date.now(),
      };
    }

    try {
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
    // Close the open connection so deleteDatabase isn't blocked
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.status = 'disconnected';

    const CLEAR_TIMEOUT = 1500;

    const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
        ),
      ]);

    const deleteDb = (name: string) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

    try {
      // Delete all databases matching our prefix (covers all addresses)
      if (typeof indexedDB.databases === 'function') {
        const dbs = await withTimeout(
          indexedDB.databases(),
          CLEAR_TIMEOUT,
          'indexedDB.databases()',
        );
        await Promise.all(
          dbs
            .filter(db => db.name?.startsWith(this.dbNamePrefix))
            .map(db => deleteDb(db.name!)),
        );
      } else {
        // Fallback: delete only the current database
        await deleteDb(this.dbName);
      }
      return true;
    } catch (err) {
      console.warn('[IndexedDBTokenStorage] clear() failed:', err);
      return false;
    }
  }

  // =========================================================================
  // Private IndexedDB helpers
  // =========================================================================

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => {
        reject(request.error);
      };

      request.onsuccess = () => {
        resolve(request.result);
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

      // For meta store, use put with explicit key
      // For tokens store, value contains the key (keyPath: 'id')
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

  private clearStore(storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }

      const transaction = this.db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

export function createIndexedDBTokenStorageProvider(
  config?: IndexedDBTokenStorageConfig
): IndexedDBTokenStorageProvider {
  return new IndexedDBTokenStorageProvider(config);
}
