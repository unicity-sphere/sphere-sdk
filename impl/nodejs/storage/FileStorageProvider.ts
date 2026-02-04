/**
 * File Storage Provider for Node.js
 * Stores wallet data in JSON files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';
import { STORAGE_KEYS_ADDRESS, getAddressId } from '../../../constants';

export interface FileStorageProviderConfig {
  /** Directory to store wallet data */
  dataDir: string;
  /** File name for key-value data (default: 'wallet.json') */
  fileName?: string;
}

export class FileStorageProvider implements StorageProvider {
  readonly id = 'file-storage';
  readonly name = 'File Storage';
  readonly type = 'local' as const;

  private dataDir: string;
  private filePath: string;
  private data: Record<string, string> = {};
  private status: ProviderStatus = 'disconnected';
  private _identity: FullIdentity | null = null;

  constructor(config: FileStorageProviderConfig | string) {
    if (typeof config === 'string') {
      this.dataDir = config;
      this.filePath = path.join(config, 'wallet.json');
    } else {
      this.dataDir = config.dataDir;
      this.filePath = path.join(config.dataDir, config.fileName ?? 'wallet.json');
    }
  }

  setIdentity(identity: FullIdentity): void {
    this._identity = identity;
  }

  getIdentity(): FullIdentity | null {
    return this._identity;
  }

  async connect(): Promise<void> {
    // Already connected - skip reconnection
    if (this.status === 'connected') {
      return;
    }

    // Ensure directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Load existing data
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(content);
      } catch {
        this.data = {};
      }
    }

    this.status = 'connected';
  }

  async disconnect(): Promise<void> {
    await this.save();
    this.status = 'disconnected';
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  async get(key: string): Promise<string | null> {
    const fullKey = this.getFullKey(key);
    return this.data[fullKey] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    this.data[fullKey] = value;
    await this.save();
  }

  async remove(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    delete this.data[fullKey];
    await this.save();
  }

  async has(key: string): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    return fullKey in this.data;
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = Object.keys(this.data);
    if (prefix) {
      return allKeys.filter((k) => k.startsWith(prefix));
    }
    return allKeys;
  }

  async clear(prefix?: string): Promise<void> {
    if (prefix) {
      const keysToDelete = Object.keys(this.data).filter((k) => k.startsWith(prefix));
      for (const key of keysToDelete) {
        delete this.data[key];
      }
    } else {
      this.data = {};
    }
    await this.save();
  }

  /**
   * Get full storage key with address prefix for per-address keys
   */
  private getFullKey(key: string): string {
    // Check if this is a per-address key
    const isPerAddressKey = Object.values(STORAGE_KEYS_ADDRESS).includes(
      key as (typeof STORAGE_KEYS_ADDRESS)[keyof typeof STORAGE_KEYS_ADDRESS]
    );

    if (isPerAddressKey && this._identity?.directAddress) {
      // Add address ID prefix for per-address data
      const addressId = getAddressId(this._identity.directAddress);
      return `${addressId}_${key}`;
    }

    // Global key - no address prefix
    return key;
  }

  private async save(): Promise<void> {
    // Ensure directory exists before writing
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }
}

export function createFileStorageProvider(config: FileStorageProviderConfig | string): FileStorageProvider {
  return new FileStorageProvider(config);
}
