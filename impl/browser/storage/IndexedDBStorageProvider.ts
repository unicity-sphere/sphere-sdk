/**
 * Browser IndexedDB Storage Provider
 * Implements StorageProvider using IndexedDB for large-capacity browser storage
 */

import type { ProviderStatus, FullIdentity, TrackedAddressEntry } from '../../../types';
import type { StorageProvider } from '../../../storage';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL, getAddressId } from '../../../constants';

// =============================================================================
// Configuration
// =============================================================================

const DB_NAME = 'sphere-storage';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

export interface IndexedDBStorageProviderConfig {
  /** Key prefix (default: 'sphere_') */
  prefix?: string;
  /** Database name (default: 'sphere-storage') */
  dbName?: string;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

export class IndexedDBStorageProvider implements StorageProvider {
  readonly id = 'indexeddb-storage';
  readonly name = 'IndexedDB Storage';
  readonly type = 'local' as const;
  readonly description = 'Browser IndexedDB for large-capacity persistence';

  private prefix: string;
  private dbName: string;
  private debug: boolean;
  private identity: FullIdentity | null = null;
  private status: ProviderStatus = 'disconnected';
  private db: IDBDatabase | null = null;

  constructor(config?: IndexedDBStorageProviderConfig) {
    this.prefix = config?.prefix ?? 'sphere_';
    this.dbName = config?.dbName ?? DB_NAME;
    this.debug = config?.debug ?? false;
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected' && this.db) return;

    this.status = 'connecting';

    try {
      this.db = await Promise.race([
        this.openDatabase(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('IndexedDB open timed out after 5s')), 5000),
        ),
      ]);
      this.status = 'connected';
      this.log('Connected to IndexedDB');
    } catch (error) {
      this.status = 'error';
      throw new Error(`IndexedDB not available: ${error}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.status = 'disconnected';
    this.log('Disconnected from IndexedDB');
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.db !== null;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // StorageProvider Implementation
  // ===========================================================================

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    this.log('Identity set:', identity.l1Address);
  }

  async get(key: string): Promise<string | null> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    const result = await this.idbGet(fullKey);
    return result?.v ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    await this.idbPut({ k: fullKey, v: value });
  }

  async remove(key: string): Promise<void> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    await this.idbDelete(fullKey);
  }

  async has(key: string): Promise<boolean> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    const count = await this.idbCount(fullKey);
    return count > 0;
  }

  async keys(prefix?: string): Promise<string[]> {
    this.ensureConnected();
    const basePrefix = this.getFullKey('');
    const searchPrefix = prefix ? this.getFullKey(prefix) : basePrefix;
    const allEntries = await this.idbGetAll();
    const result: string[] = [];

    for (const entry of allEntries) {
      if (entry.k.startsWith(searchPrefix)) {
        // Return key without the base prefix
        result.push(entry.k.slice(basePrefix.length));
      }
    }

    return result;
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      // Close connection first (no transactions), then deleteDatabase.
      // Do NOT clearStore() before close — lingering transactions keep the
      // connection alive and cause deleteDatabase to fire onblocked.
      if (this.db) {
        this.db.close();
        this.db = null;
      }
      this.status = 'disconnected';

      await new Promise<void>((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(this.dbName);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        } catch {
          resolve();
        }
      });

      this.log('Database deleted:', this.dbName);
      return;
    }

    this.ensureConnected();
    const keysToRemove = await this.keys(prefix);
    for (const key of keysToRemove) {
      await this.remove(key);
    }
  }

  async saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void> {
    await this.set(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES, JSON.stringify({ version: 1, addresses: entries }));
  }

  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    const data = await this.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
    if (!data) return [];
    try {
      const parsed = JSON.parse(data);
      return parsed.addresses ?? [];
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Get JSON data
   */
  async getJSON<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  /**
   * Set JSON data
   */
  async setJSON<T>(key: string, value: T): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  // ===========================================================================
  // Private: Key Scoping
  // ===========================================================================

  private getFullKey(key: string): string {
    // Check if this is a per-address key
    const isPerAddressKey = Object.values(STORAGE_KEYS_ADDRESS).includes(key as typeof STORAGE_KEYS_ADDRESS[keyof typeof STORAGE_KEYS_ADDRESS]);

    if (isPerAddressKey && this.identity?.directAddress) {
      // Add address ID prefix for per-address data
      const addressId = getAddressId(this.identity.directAddress);
      return `${this.prefix}${addressId}_${key}`;
    }

    // Global key - no address prefix
    return `${this.prefix}${key}`;
  }

  private ensureConnected(): void {
    if (this.status !== 'connected' || !this.db) {
      throw new Error('IndexedDBStorageProvider not connected');
    }
  }

  // ===========================================================================
  // Private: IndexedDB Operations
  // ===========================================================================

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => resolve(request.result);

      // onblocked fires when another connection (e.g. other tab) holds
      // the database at a lower version. Log it — onsuccess will follow
      // once the other connection closes.
      request.onblocked = () => {
        console.warn('[IndexedDBStorageProvider] open blocked by another connection');
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'k' });
        }
      };
    });
  }

  private idbGet(key: string): Promise<{ k: string; v: string } | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? undefined);
    });
  }

  private idbPut(entry: { k: string; v: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(entry);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private idbDelete(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private idbCount(key: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  private idbGetAll(): Promise<{ k: string; v: string }[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? []);
    });
  }

  private idbClear(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[IndexedDBStorageProvider]', ...args);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createIndexedDBStorageProvider(
  config?: IndexedDBStorageProviderConfig
): IndexedDBStorageProvider {
  return new IndexedDBStorageProvider(config);
}
