import { describe, it, expect, beforeEach } from 'vitest';
import { PersistentDedupSet } from '../../../lib/dedup/persistent-set';
import type { StorageProvider } from '../../../storage';

class InMemoryStorage {
  private data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async clear(): Promise<void> {
    this.data.clear();
  }
  async getAll(): Promise<Record<string, string>> {
    return Object.fromEntries(this.data);
  }
  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }
}

describe('lib/dedup/persistent-set', () => {
  let storage: StorageProvider;
  beforeEach(() => {
    storage = new InMemoryStorage() as unknown as StorageProvider;
  });

  it('add + has + save + reload roundtrip', async () => {
    const dedup = new PersistentDedupSet({ storage, key: 'dedup-test' });
    await dedup.load();
    expect(dedup.add('id1')).toBe(true);
    expect(dedup.add('id1')).toBe(false);
    expect(dedup.has('id1')).toBe(true);
    await dedup.save();

    const dedup2 = new PersistentDedupSet({ storage, key: 'dedup-test' });
    await dedup2.load();
    expect(dedup2.has('id1')).toBe(true);
  });

  it('bounds the set with LRU eviction of oldest', async () => {
    const dedup = new PersistentDedupSet({ storage, key: 'k', maxSize: 3 });
    await dedup.load();
    dedup.add('a');
    dedup.add('b');
    dedup.add('c');
    dedup.add('d');
    expect(dedup.has('a')).toBe(false);
    expect(dedup.has('d')).toBe(true);
    expect(dedup.size()).toBe(3);
  });

  it('tolerates corrupted storage payload', async () => {
    await storage.set('bad', '{{{');
    const dedup = new PersistentDedupSet({ storage, key: 'bad' });
    await dedup.load();
    expect(dedup.size()).toBe(0);
  });
});
