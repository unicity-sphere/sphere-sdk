/**
 * Browser LocalStorage Provider
 * Implements StorageProvider using browser localStorage
 */

import type { ProviderStatus, FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import { STORAGE_KEYS_ADDRESS, getAddressId } from '../../../constants';

// =============================================================================
// Configuration
// =============================================================================

export interface LocalStorageProviderConfig {
  /** Key prefix (default: 'sphere_') */
  prefix?: string;
  /** Custom storage instance (for testing/SSR) */
  storage?: Storage;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

export class LocalStorageProvider implements StorageProvider {
  readonly id = 'localStorage';
  readonly name = 'Local Storage';
  readonly type = 'local' as const;
  readonly description = 'Browser localStorage for single-device persistence';

  private config: Required<Pick<LocalStorageProviderConfig, 'prefix' | 'debug'>> & {
    storage: Storage;
  };
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
      throw new Error(`LocalStorage not available: ${error}`);
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
    this.log('Identity set:', identity.l1Address);
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

    if (isPerAddressKey && this.identity?.directAddress) {
      // Add address ID prefix for per-address data
      const addressId = getAddressId(this.identity.directAddress);
      return `${this.config.prefix}${addressId}_${key}`;
    }

    // Global key - no address prefix
    return `${this.config.prefix}${key}`;
  }

  private ensureConnected(): void {
    if (this.status !== 'connected') {
      throw new Error('LocalStorageProvider not connected');
    }
  }

  private getStorageSafe(): Storage {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }

    // SSR fallback: in-memory storage
    return createInMemoryStorage();
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[LocalStorageProvider]', ...args);
    }
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
