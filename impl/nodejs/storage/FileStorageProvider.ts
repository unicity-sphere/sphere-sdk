/**
 * File Storage Provider for Node.js
 * Stores wallet data in JSON files
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity, ProviderStatus, TrackedAddressEntry } from '../../../types';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL, getAddressId } from '../../../constants';
import { DURABLE_STORAGE } from '../../../profile/aggregator-pointer';

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

  /**
   * Durability marker consumed by the aggregator-pointer FlagStore
   * (SPEC §7.1.3). Writes go through `fs.fsyncSync()` on a temp file
   * followed by an atomic rename, which is a POSIX-durable write. Any
   * re-ordering by the OS page cache is flushed by fsync before the
   * rename commits the new inode — readers observe either the prior
   * or new state, never a torn write.
   */
  readonly [DURABLE_STORAGE] = true as const;

  private dataDir: string;
  private filePath: string;
  private isTxtMode: boolean;
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
    this.isTxtMode = this.filePath.endsWith('.txt');
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
    // Steelman⁴³: track which keys this process actually mutated, so
    // save()'s merge step doesn't clobber unrelated keys written by
    // another process.
    this.mutatedKeys.add(fullKey);
    this.removedKeys.delete(fullKey);
    await this.save();
  }

  async remove(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    delete this.data[fullKey];
    this.removedKeys.add(fullKey);
    this.mutatedKeys.delete(fullKey);
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
        // Steelman⁴³: track removals so save() merges them against the
        // re-read disk snapshot. Without this, save's merge would
        // re-introduce keys that were on disk but cleared from memory.
        this.removedKeys.add(key);
        this.mutatedKeys.delete(key);
      }
    } else {
      // Full clear: also fold the on-disk keys into removedKeys.
      try {
        if (fs.existsSync(this.filePath)) {
          const onDisk = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
          for (const k of Object.keys(onDisk)) this.removedKeys.add(k);
        }
      } catch { /* best-effort */ }
      for (const k of Object.keys(this.data)) this.removedKeys.add(k);
      this.mutatedKeys.clear();
      this.data = {};
    }
    await this.save();
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

  /**
   * Steelman⁴³ critical: track which keys this process has mutated
   * since connect(), so save() can merge them ON TOP of the current
   * on-disk snapshot. Without this, two processes each holding their
   * own private snapshot would mutually overwrite the other's writes
   * (last-save-wins, intermediate keys lost).
   */
  private mutatedKeys: Set<string> = new Set();
  private removedKeys: Set<string> = new Set();
  private saveInFlight: Promise<void> | null = null;

  private async save(): Promise<void> {
    // Serialize concurrent saves WITHIN this process: queue them so
    // each one re-reads the latest on-disk snapshot before writing.
    if (this.saveInFlight) {
      await this.saveInFlight;
    }
    this.saveInFlight = this.saveInner().finally(() => {
      this.saveInFlight = null;
    });
    return this.saveInFlight;
  }

  private async saveInner(): Promise<void> {
    // Ensure directory exists before writing
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Steelman⁴⁴ critical: cross-process file lock around the
    // read-merge-write critical section. Without this, two processes'
    // saveInner runs can interleave: A reads disk → B reads disk →
    // A renames → B renames clobbering A's write. proper-lockfile
    // gives us cross-process mutual exclusion via O_EXCL on a sibling
    // .lock directory; stale=10s reaps locks from crashed writers.
    let releaseFileLock: (() => Promise<void>) | null = null;
    try {
      const lockfile = await import('proper-lockfile');
      // The file may not exist yet (first save); proper-lockfile needs
      // the target to exist. Touch it first if absent.
      if (!fs.existsSync(this.filePath)) {
        try { fs.writeFileSync(this.filePath, this.isTxtMode ? '' : '{}', { flag: 'a' }); }
        catch { /* best-effort */ }
      }
      releaseFileLock = await lockfile.lock(this.filePath, {
        stale: 10_000,
        retries: { retries: 50, minTimeout: 50, maxTimeout: 500 },
        realpath: false,
      });
    } catch (err) {
      // If proper-lockfile isn't available or fails, log and proceed
      // (best-effort — we have in-process serialization via saveInFlight).
      // Don't reject the save — the user expects their data to land.
      // eslint-disable-next-line no-console
      console.warn('[FileStorageProvider] file-lock unavailable; saving without cross-process lock:', err instanceof Error ? err.message : String(err));
    }

    try {
      // Steelman⁴³/⁴⁴: re-read on-disk snapshot UNDER THE LOCK and merge
      // our mutations on top. Other processes' writes since our last
      // save survive; our writes overwrite only the keys we actually
      // touched. With the file lock, the read-merge-write section is
      // truly atomic across processes.
      if (!this.isTxtMode && fs.existsSync(this.filePath)) {
        try {
          const raw = fs.readFileSync(this.filePath, 'utf8');
          if (raw.length > 0) {
            const onDisk = JSON.parse(raw) as Record<string, string>;
            const merged: Record<string, string> = { ...onDisk };
            for (const key of this.mutatedKeys) {
              if (key in this.data) merged[key] = this.data[key];
            }
            for (const key of this.removedKeys) {
              delete merged[key];
            }
            this.data = merged;
          }
        } catch {
          // Disk read or JSON parse failed — proceed with in-memory
          // data only.  (Existing behavior; the corruption-rename
          // path at L96 handles fatal cases.)
        }
      }
      // Reset mutation tracking after merge.
      this.mutatedKeys = new Set();
      this.removedKeys = new Set();

    let content: string;
    if (this.isTxtMode) {
      content = this.data[STORAGE_KEYS_GLOBAL.MNEMONIC] ?? '';
    } else {
      content = JSON.stringify(this.data);
    }

    // Atomic write: write to temp file, fsync, rename, then fsync
    // the parent directory. This prevents wallet.json corruption on
    // kill/crash — the rename is atomic on POSIX filesystems, so the
    // file is either fully old or fully new, never partially written.
    // The parent-dir fsync ensures the rename itself is durable; on
    // ext4/xfs a power-loss after rename but before dir flush can
    // lose the new inode, leaving only the stale (now unreachable)
    // file. Required by the DURABLE_STORAGE contract (SPEC §7.1.3).
    const tmpPath = this.filePath + '.tmp';
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.filePath);

    // Parent-directory fsync. Best-effort in environments where
    // openSync on a directory is not supported (Windows) — we
    // swallow the error there. On POSIX this is the load-bearing
    // step for rename durability.
    try {
      const dirFd = fs.openSync(this.dataDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Non-POSIX fallback — rename-durability on these filesystems
      // is a platform concern, not a correctness regression.
    }
    } finally {
      // Steelman⁴⁴ critical: always release the file lock, even on
      // error paths. proper-lockfile is robust against process exit
      // (it tracks PIDs), but explicit release minimizes the stale-
      // lock window for the next save.
      if (releaseFileLock !== null) {
        try { await releaseFileLock(); } catch { /* best-effort */ }
      }
    }
  }
}

export function createFileStorageProvider(config: FileStorageProviderConfig | string): FileStorageProvider {
  return new FileStorageProvider(config);
}
