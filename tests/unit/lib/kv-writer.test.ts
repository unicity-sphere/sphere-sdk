import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeKvEntry, _resetKvWriterFallbackLog } from '../../../lib/storage/kv-writer';
import type { StorageProvider } from '../../../storage';

describe('lib/storage/kv-writer', () => {
  beforeEach(() => {
    _resetKvWriterFallbackLog();
  });

  it('routes through storage.setEntry when available', async () => {
    const setEntry = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockResolvedValue(undefined);
    const storage = { setEntry, set } as unknown as StorageProvider;
    await writeKvEntry(storage, 'k', 'v', 'token_send');
    expect(setEntry).toHaveBeenCalledWith('k', 'v', 'token_send');
    expect(set).not.toHaveBeenCalled();
  });

  it('falls back to storage.set when setEntry missing', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const storage = { set } as unknown as StorageProvider;
    await writeKvEntry(storage, 'k', 'v', 'cache_index');
    expect(set).toHaveBeenCalledWith('k', 'v');
  });

  it('logs fallback once per provider class', async () => {
    class FirstStorage {
      async set(_k: string, _v: string): Promise<void> {}
    }
    class SecondStorage {
      async set(_k: string, _v: string): Promise<void> {}
    }
    const first = new FirstStorage() as unknown as StorageProvider;
    const second = new SecondStorage() as unknown as StorageProvider;
    // No throw expected; internal dedup means only the first call per class
    // emits the debug log.
    await writeKvEntry(first, 'k1', 'v', 'cache_index');
    await writeKvEntry(first, 'k2', 'v', 'cache_index');
    await writeKvEntry(second, 'k3', 'v', 'cache_index');
  });
});
