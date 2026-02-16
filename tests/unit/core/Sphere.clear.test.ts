/**
 * Tests for Sphere.clear() - complete wallet data cleanup
 * Verifies that clear() removes all SDK-owned data from both
 * StorageProvider and TokenStorageProvider
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sphere } from '../../../core/Sphere';
import type { StorageProvider } from '../../../storage';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { ProviderStatus } from '../../../types';

// =============================================================================
// Mocks
// =============================================================================

function createMockStorage(): StorageProvider {
  const data = new Map<string, string>();

  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    remove: vi.fn(async (key: string) => { data.delete(key); }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => { data.clear(); }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    saveTrackedAddresses: vi.fn(async () => {}),
    loadTrackedAddresses: vi.fn(async () => []),
  };
}

function createMockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> & { clear: ReturnType<typeof vi.fn> } {
  return {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local' as const,
    setIdentity: vi.fn(),
    initialize: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    load: vi.fn(async () => ({
      success: true,
      data: { _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() } },
      source: 'local' as const,
      timestamp: Date.now(),
    })),
    save: vi.fn(async () => ({ success: true, timestamp: Date.now() })),
    sync: vi.fn(async (localData: TxfStorageDataBase) => ({
      success: true,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
    })),
    clear: vi.fn(async () => true),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere.clear()', () => {
  beforeEach(() => {
    // Reset Sphere singleton
    if (Sphere.getInstance()) {
      // Force reset without calling destroy (which needs providers)
      (Sphere as unknown as { instance: null }).instance = null;
    }
  });

  describe('with StorageProvider only (backward compatible)', () => {
    it('should call storage.clear() to remove all data', async () => {
      const storage = createMockStorage();

      await Sphere.clear(storage);

      expect(storage.clear).toHaveBeenCalled();
    });

    it('should not throw when no instance exists', async () => {
      const storage = createMockStorage();

      await expect(Sphere.clear(storage)).resolves.not.toThrow();
    });
  });

  describe('with options object (new API)', () => {
    it('should clear token storage when provided', async () => {
      const storage = createMockStorage();
      const tokenStorage = createMockTokenStorage();

      await Sphere.clear({ storage, tokenStorage });

      expect(tokenStorage.clear).toHaveBeenCalled();
    });

    it('should clear storage AND token storage', async () => {
      const storage = createMockStorage();
      const tokenStorage = createMockTokenStorage();

      await Sphere.clear({ storage, tokenStorage });

      expect(storage.clear).toHaveBeenCalled();
      expect(tokenStorage.clear).toHaveBeenCalled();
    });

    it('should work without tokenStorage in options', async () => {
      const storage = createMockStorage();

      await Sphere.clear({ storage });

      expect(storage.clear).toHaveBeenCalled();
    });

    it('should handle tokenStorage without clear() method', async () => {
      const storage = createMockStorage();
      const tokenStorage = createMockTokenStorage();
      // Remove clear method to simulate a provider that doesn't support it
      delete (tokenStorage as Partial<typeof tokenStorage>).clear;

      await expect(Sphere.clear({ storage, tokenStorage })).resolves.not.toThrow();
      expect(storage.clear).toHaveBeenCalled();
    });
  });

  describe('backward compatibility', () => {
    it('should accept StorageProvider directly (legacy API)', async () => {
      const storage = createMockStorage();

      // Old-style call: Sphere.clear(storage)
      await Sphere.clear(storage);

      expect(storage.clear).toHaveBeenCalled();
    });

    it('should accept options object (new API)', async () => {
      const storage = createMockStorage();

      // New-style call: Sphere.clear({ storage })
      await Sphere.clear({ storage });

      expect(storage.clear).toHaveBeenCalled();
    });
  });

  describe('instance lifecycle', () => {
    it('should destroy existing Sphere instance before clearing', async () => {
      const storage = createMockStorage();

      // Simulate an existing instance whose destroy() resets the singleton
      const mockInstance = {
        destroy: vi.fn(async () => {
          (Sphere as unknown as { instance: null }).instance = null;
        }),
      };
      (Sphere as unknown as { instance: typeof mockInstance }).instance = mockInstance;

      await Sphere.clear(storage);

      expect(mockInstance.destroy).toHaveBeenCalled();
      expect(Sphere.getInstance()).toBeNull();
    });

    it('should connect storage if disconnected before clearing', async () => {
      const storage = createMockStorage();
      (storage.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await Sphere.clear(storage);

      expect(storage.connect).toHaveBeenCalled();
    });
  });
});
