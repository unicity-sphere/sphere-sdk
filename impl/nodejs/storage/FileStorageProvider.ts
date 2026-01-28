/**
 * File Storage Provider for Node.js
 * Stores wallet data in JSON files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, ProviderStatus } from '../../../types';

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
    return this.data[key] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data[key] = value;
    await this.save();
  }

  async remove(key: string): Promise<void> {
    delete this.data[key];
    await this.save();
  }

  async has(key: string): Promise<boolean> {
    return key in this.data;
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
