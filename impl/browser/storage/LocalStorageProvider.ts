/**
 * Browser LocalStorage Provider
 * Implements StorageProvider using browser localStorage
 */

import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import type { ProviderStatus, FullIdentity, TrackedAddressEntry } from '../../../types';
import type { StorageProvider } from '../../../storage';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL, isNetworkScopedAddressKey, type NetworkType } from '../../../constants';
import {
  mergeTrackedAddresses,
  parseTrackedAddresses,
  type TrackedAddressesFile,
} from '../../../storage/tracked-addresses';

// =============================================================================
// Configuration
// =============================================================================

export interface LocalStorageProviderConfig {
  /** Key prefix (default: 'sphere_') */
  prefix?: string;
  /** Custom storage instance (for testing/SSR) */
  storage?: Storage;
  /**
   * When set, token/payment per-address keys are network-scoped; chat/identity
   * per-address keys and global/seed keys stay shared.
   */
  network?: NetworkType;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Per-`Storage` tags for `backingStoreId`. The prefix alone does not identify the
 * store: an SSR fallback mints a private in-memory `Storage` per provider, so two
 * providers with the same prefix over different objects hold unrelated data. Weak,
 * lazily assigned, and process-local — it is only ever compared with itself.
 */
const storageObjectTags = new WeakMap<Storage, string>();
let storageObjectSeq = 0;

function storageObjectTag(storage: Storage): string {
  let tag = storageObjectTags.get(storage);
  if (!tag) {
    tag = String(++storageObjectSeq);
    storageObjectTags.set(storage, tag);
  }
  return tag;
}

/**
 * One write chain per BACKING STORE, not per provider object: `backingStoreId` exists
 * because two providers may address the same localStorage + prefix, and two per-instance
 * chains both read the old registry before either writes — the lost update again, one
 * level up. This coordinates a single JS realm only; a SECOND TAB writing the same store
 * is genuinely not covered, and no in-process lock can cover it.
 */
const trackedWriteChains = new Map<string, Promise<unknown>>();

function serializeTrackedWrite(storeId: string, task: () => Promise<void>): Promise<void> {
  const previous = trackedWriteChains.get(storeId) ?? Promise.resolve();
  const run = previous.then(task);
  // Carried forward, one transient error would reject every later write without running it.
  const tail = run.then(() => undefined, () => undefined);
  trackedWriteChains.set(storeId, tail);
  // Drop the entry once nothing is queued behind it, so a per-request SSR storage does
  // not leave a chain behind forever.
  void tail.then(() => {
    if (trackedWriteChains.get(storeId) === tail) trackedWriteChains.delete(storeId);
  });
  return run;
}

export class LocalStorageProvider implements StorageProvider {
  readonly id = 'localStorage';
  readonly name = 'Local Storage';
  readonly type = 'local' as const;
  readonly description = 'Browser localStorage for single-device persistence';
  /** The `Storage` object + prefix — two providers over one pair share erasure (#766). */
  readonly backingStoreId: string;

  private config: Required<Pick<LocalStorageProviderConfig, 'prefix' | 'debug'>> & {
    storage: Storage;
  };
  private network?: NetworkType;
  private identity: FullIdentity | null = null;
  private status: ProviderStatus = 'disconnected';

  constructor(config?: LocalStorageProviderConfig) {
    // SSR fallback: use in-memory storage if localStorage unavailable
    const storage = config?.storage ?? this.getStorageSafe();

    this.config = {
      prefix: config?.prefix ?? 'sphere_',
      storage,
      debug: config?.debug ?? false,
    };
    this.network = config?.network;
    this.backingStoreId =
      `localstorage:${storageObjectTag(storage)}:${encodeURIComponent(this.config.prefix)}`;
  }

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    try {
      // Test storage availability
      const testKey = `${this.config.prefix}_test`;
      this.config.storage.setItem(testKey, 'test');
      this.config.storage.removeItem(testKey);

      this.status = 'connected';
      this.log('Connected to localStorage');
    } catch (error) {
      this.status = 'error';
      throw new SphereError(`LocalStorage not available: ${error}`, 'STORAGE_ERROR');
    }
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
    this.log('Disconnected from localStorage');
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // StorageProvider Implementation
  // ===========================================================================

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
    this.log('Identity set:', identity.chainPubkey);
  }

  async get(key: string): Promise<string | null> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    return this.config.storage.getItem(fullKey);
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    this.config.storage.setItem(fullKey, value);
  }

  async remove(key: string): Promise<void> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    this.config.storage.removeItem(fullKey);
  }

  async has(key: string): Promise<boolean> {
    this.ensureConnected();
    const fullKey = this.getFullKey(key);
    return this.config.storage.getItem(fullKey) !== null;
  }

  async keys(prefix?: string): Promise<string[]> {
    this.ensureConnected();
    const basePrefix = this.getFullKey('');
    const searchPrefix = prefix ? this.getFullKey(prefix) : basePrefix;
    const result: string[] = [];

    for (let i = 0; i < this.config.storage.length; i++) {
      const key = this.config.storage.key(i);
      if (key?.startsWith(searchPrefix)) {
        // Return key without the base prefix
        result.push(key.slice(basePrefix.length));
      }
    }

    return result;
  }

  async clear(prefix?: string): Promise<void> {
    this.ensureConnected();
    const keysToRemove = await this.keys(prefix);
    for (const key of keysToRemove) {
      await this.remove(key);
    }
  }

  /**
   * Persist the tracked-address registry by MERGING, never replacing.
   *
   * Every Sphere over this storage holds its own snapshot and writes it in
   * full, so a wholesale write drops the addresses this writer never saw
   * (#766 item 5 — a lost update, reproducible on one network). localStorage
   * offers no transaction, so the read-merge-write is serialized by BACKING
   * STORE — see `serializeTrackedWrite`, and the realm limit stated there.
   */
  async saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void> {
    await serializeTrackedWrite(this.backingStoreId, async () => {
      const onDisk = parseTrackedAddresses(await this.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES));
      const file: TrackedAddressesFile = {
        version: 1,
        addresses: mergeTrackedAddresses(onDisk, entries),
      };
      await this.set(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES, JSON.stringify(file));
    });
  }

  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    return parseTrackedAddresses(await this.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES));
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
  // Private Methods
  // ===========================================================================

  private getFullKey(key: string): string {
    // Check if this is a per-address key
    const isPerAddressKey = Object.values(STORAGE_KEYS_ADDRESS).includes(key as typeof STORAGE_KEYS_ADDRESS[keyof typeof STORAGE_KEYS_ADDRESS]);
    // Token/payment keys (incl. module composites like `{addressId}_auto_return_ledger`,
    // `{addressId}_swap:{id}`) are ALSO per-network; chat/identity per-address keys are NOT.
    const net = this.network && isNetworkScopedAddressKey(key) ? `${this.network}_` : '';

    if (isPerAddressKey && this.identity?.chainPubkey) {
      // Add address ID prefix for per-address data
      const id = this.identity.chainPubkey;
      return `${this.config.prefix}${net}${id}_${key}`;
    }

    // Global key OR a module-built composite (already addressId-prefixed). Add the network
    // segment only for per-network token/payment keys; seed/identity/chat stay unprefixed.
    return `${this.config.prefix}${net}${key}`;
  }

  private ensureConnected(): void {
    if (this.status !== 'connected') {
      throw new SphereError('LocalStorageProvider not connected', 'STORAGE_ERROR');
    }
  }

  private getStorageSafe(): Storage {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }

    // SSR fallback: in-memory storage
    return createInMemoryStorage();
  }

  private log(message: string, ...args: unknown[]): void {
    logger.debug('LocalStorage', message, ...args);
  }
}

// =============================================================================
// In-Memory Storage (SSR Fallback)
// =============================================================================

function createInMemoryStorage(): Storage {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
  };
}

// =============================================================================
// Factory Function
// =============================================================================

export function createLocalStorageProvider(
  config?: LocalStorageProviderConfig
): LocalStorageProvider {
  return new LocalStorageProvider(config);
}
