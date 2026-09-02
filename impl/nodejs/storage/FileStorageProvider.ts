/**
 * File Storage Provider for Node.js
 * Stores wallet data in JSON files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, ProviderStatus, TrackedAddressEntry } from '../../../types';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL, isNetworkScopedAddressKey, type NetworkType } from '../../../constants';
import {
  mergeTrackedAddresses,
  parseTrackedAddresses,
  type TrackedAddressesFile,
} from '../../../storage/tracked-addresses';

export interface FileStorageProviderConfig {
  /** Directory to store wallet data */
  dataDir: string;
  /** File name for key-value data (default: 'wallet.json') */
  fileName?: string;
  /**
   * When set, token/payment per-address keys are network-scoped; chat/identity
   * per-address keys and global/seed keys stay shared.
   */
  network?: NetworkType;
}

export class FileStorageProvider implements StorageProvider {
  readonly id = 'file-storage';
  readonly name = 'File Storage';
  readonly type = 'local' as const;
  /** The resolved wallet file — two providers over one path share erasure (#766). */
  readonly backingStoreId: string;

  private dataDir: string;
  private filePath: string;
  private isTxtMode: boolean;
  private network?: NetworkType;
  private data: Record<string, string> = {};
  private status: ProviderStatus = 'disconnected';
  private _identity: FullIdentity | null = null;

  constructor(config: FileStorageProviderConfig | string) {
    // Resolved once, at construction: a later process.chdir() would otherwise make this
    // provider read and write a DIFFERENT file while still reporting the backingStoreId
    // computed from the old cwd — so clear() would empty one store and destroy the
    // liveness bucket of another.
    if (typeof config === 'string') {
      this.dataDir = path.resolve(config);
      this.filePath = path.join(this.dataDir, 'wallet.json');
    } else {
      this.dataDir = path.resolve(config.dataDir);
      this.filePath = path.join(this.dataDir, config.fileName ?? 'wallet.json');
      this.network = config.network;
    }
    this.isTxtMode = this.filePath.endsWith('.txt');
    this.backingStoreId = `file:${this.filePath}`;
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

    // Load existing data. If the file is corrupt (partial write from a crash),
    // try the .tmp backup (which is the pre-rename version from the last
    // successful atomic write).
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8').trim();
        if (this.isTxtMode) {
          if (content) {
            this.data = { [STORAGE_KEYS_GLOBAL.MNEMONIC]: content };
          }
        } else {
          this.data = JSON.parse(content);
        }
      } catch (mainErr) {
        // Main file exists but is corrupt. Try .tmp fallback before failing.
        const tmpPath = this.filePath + '.tmp';
        if (fs.existsSync(tmpPath)) {
          try {
            const tmpContent = fs.readFileSync(tmpPath, 'utf-8').trim();
            this.data = this.isTxtMode
              ? (tmpContent ? { [STORAGE_KEYS_GLOBAL.MNEMONIC]: tmpContent } : {})
              : JSON.parse(tmpContent);
            // Preserve the corrupt file for forensic inspection
            const corruptPath = this.filePath + '.corrupt';
            try { fs.renameSync(this.filePath, corruptPath); } catch { /* best-effort */ }
            // Restore from .tmp
            fs.renameSync(tmpPath, this.filePath);
          } catch {
            // Both files corrupt — this is a hard failure, NOT a silent reset.
            // Silently falling back to {} would cause Sphere.exists() to return
            // false, leading to accidental identity replacement.
            throw new Error(
              `Wallet file "${this.filePath}" is corrupt and no valid backup exists. ` +
              `Manual recovery required. Check "${this.filePath}.corrupt" for the damaged file.`
            );
          }
        } else {
          // Main file corrupt, no .tmp fallback — hard failure.
          throw new Error(
            `Wallet file "${this.filePath}" is corrupt (${mainErr instanceof Error ? mainErr.message : 'parse error'}). ` +
            `No backup (.tmp) file found. Manual recovery required.`
          );
        }
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

  /** Serializes the read-merge-write below, per provider instance. */
  private trackedWrites: Promise<unknown> = Promise.resolve();

  /**
   * Persist the tracked-address registry by MERGING, never replacing.
   *
   * Every Sphere over this storage holds its own snapshot and writes it in
   * full, so a wholesale write drops the addresses this writer never saw
   * (#766 item 5 — a lost update, reproducible on one network). Concurrent
   * calls are serialized on `trackedWrites` so a read can never interleave
   * with another call's write.
   */
  async saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void> {
    const run = this.trackedWrites.then(async () => {
      const onDisk = parseTrackedAddresses(await this.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES));
      const file: TrackedAddressesFile = {
        version: 1,
        addresses: mergeTrackedAddresses(onDisk, entries),
      };
      await this.set(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES, JSON.stringify(file));
    });
    // The chain tail swallows the rejection so one failed write cannot brick
    // every later one; the caller still sees the error by awaiting `run`.
    this.trackedWrites = run.then(() => undefined, () => undefined);
    await run;
  }

  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    return parseTrackedAddresses(await this.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES));
  }

  /**
   * Get full storage key with address prefix for per-address keys
   */
  private getFullKey(key: string): string {
    // Check if this is a per-address key
    const isPerAddressKey = Object.values(STORAGE_KEYS_ADDRESS).includes(
      key as (typeof STORAGE_KEYS_ADDRESS)[keyof typeof STORAGE_KEYS_ADDRESS]
    );
    // Token/payment keys (incl. module composites like `{addressId}_auto_return_ledger`,
    // `{addressId}_swap:{id}`) are ALSO per-network; chat/identity per-address keys are NOT.
    const net = this.network && isNetworkScopedAddressKey(key) ? `${this.network}_` : '';

    if (isPerAddressKey && this._identity?.chainPubkey) {
      // Add address ID prefix for per-address data
      const id = this._identity.chainPubkey;
      return `${net}${id}_${key}`;
    }

    // Global key OR a module-built composite (already addressId-prefixed). Add the network
    // segment only for per-network token/payment keys; seed/identity/chat stay unprefixed.
    return `${net}${key}`;
  }

  private async save(): Promise<void> {
    // Ensure directory exists before writing
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    let content: string;
    if (this.isTxtMode) {
      content = this.data[STORAGE_KEYS_GLOBAL.MNEMONIC] ?? '';
    } else {
      content = JSON.stringify(this.data);
    }

    // Atomic write: write to temp file, fsync, then rename.
    // This prevents wallet.json corruption on kill/crash — the rename
    // is atomic on POSIX filesystems, so the file is either fully old
    // or fully new, never partially written.
    const tmpPath = this.filePath + '.tmp';
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);
  }
}

export function createFileStorageProvider(config: FileStorageProviderConfig | string): FileStorageProvider {
  return new FileStorageProvider(config);
}
