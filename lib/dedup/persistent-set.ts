/**
 * lib/dedup/persistent-set — bounded persistent dedup set.
 *
 * Consolidates the copy-pasted `processedSplitGroupIds` /
 * `processedCombinedTransferIds` / auto-return dedup / transport-dedup
 * patterns. Each is: a bounded in-memory Set + async persist-to-storage +
 * hydrate-on-load.
 *
 * Usage:
 *   const dedup = new PersistentDedupSet({
 *     storage, key: STORAGE_KEYS.PROCESSED_SPLIT_GROUPS, maxSize: 500
 *   });
 *   await dedup.load();
 *   if (dedup.has(id)) return;
 *   dedup.add(id);
 *   await dedup.save();
 */

import type { StorageProvider } from '../../storage';
import { logger } from '../../core/logger';

export interface PersistentDedupSetOptions {
  storage: StorageProvider;
  key: string;
  /** Bound the set (LRU-drop oldest); default 1024. */
  maxSize?: number;
  /** Log tag for warnings. Default 'Dedup'. */
  logTag?: string;
}

export class PersistentDedupSet {
  private readonly storage: StorageProvider;
  private readonly key: string;
  private readonly maxSize: number;
  private readonly logTag: string;
  private items: Set<string> = new Set();
  private order: string[] = [];
  private loaded = false;

  constructor(opts: PersistentDedupSetOptions) {
    this.storage = opts.storage;
    this.key = opts.key;
    this.maxSize = opts.maxSize ?? 1024;
    this.logTag = opts.logTag ?? 'Dedup';
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await this.storage.get(this.key);
      if (typeof raw === 'string' && raw.length > 0) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const v of parsed) {
            if (typeof v === 'string') {
              this.items.add(v);
              this.order.push(v);
            }
          }
        }
      }
    } catch (err) {
      logger.warn(this.logTag, `Failed to load dedup set ${this.key}:`, err);
    }
    this.loaded = true;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Adds `id`; returns false if already present. */
  add(id: string): boolean {
    if (this.items.has(id)) return false;
    this.items.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const dropped = this.order.shift();
      if (dropped !== undefined) this.items.delete(dropped);
    }
    return true;
  }

  async save(): Promise<void> {
    try {
      await this.storage.set(this.key, JSON.stringify(this.order));
    } catch (err) {
      logger.warn(this.logTag, `Failed to save dedup set ${this.key}:`, err);
    }
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
    this.order = [];
  }
}
