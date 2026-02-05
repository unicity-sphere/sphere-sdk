/**
 * Tests for Sphere.clear() - complete wallet data cleanup
 * Verifies that clear() removes all SDK-owned data from both
 * StorageProvider and TokenStorageProvider
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sphere } from '../../../core/Sphere';
import { STORAGE_KEYS_GLOBAL, STORAGE_KEYS_ADDRESS } from '../../../constants';
import type { StorageProvider } from '../../../storage';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { ProviderStatus } from '../../../types';

// =============================================================================
// Mocks
// =============================================================================

function createMockStorage(): StorageProvider & { removedKeys: string[] } {
  const data = new Map<string, string>();
  const removedKeys: string[] = [];

  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    removedKeys,
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    remove: vi.fn(async (key: string) => { data.delete(key); removedKeys.push(key); }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => { data.clear(); }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
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
    it('should remove all global wallet keys', async () => {
      const storage = createMockStorage();

      await Sphere.clear(storage);

      const expectedKeys = [
        STORAGE_KEYS_GLOBAL.MNEMONIC,
        STORAGE_KEYS_GLOBAL.MASTER_KEY,
        STORAGE_KEYS_GLOBAL.CHAIN_CODE,
        STORAGE_KEYS_GLOBAL.DERIVATION_PATH,
        STORAGE_KEYS_GLOBAL.BASE_PATH,
        STORAGE_KEYS_GLOBAL.DERIVATION_MODE,
        STORAGE_KEYS_GLOBAL.WALLET_SOURCE,
        STORAGE_KEYS_GLOBAL.WALLET_EXISTS,
        STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS,
      ];

      for (const key of expectedKeys) {
        expect(storage.remove).toHaveBeenCalledWith(key);
      }
    });

    it('should remove per-address data', async () => {
      const storage = createMockStorage();

      await Sphere.clear(storage);

      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS);
      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_ADDRESS.OUTBOX);
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

    it('should clear wallet keys AND token storage', async () => {
      const storage = createMockStorage();
      const tokenStorage = createMockTokenStorage();

      await Sphere.clear({ storage, tokenStorage });

      // Wallet keys cleared
      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.MNEMONIC);
      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.MASTER_KEY);

      // Token storage cleared
      expect(tokenStorage.clear).toHaveBeenCalled();
    });

    it('should work without tokenStorage in options', async () => {
      const storage = createMockStorage();

      await Sphere.clear({ storage });

      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.MNEMONIC);
    });

    it('should handle tokenStorage without clear() method', async () => {
      const storage = createMockStorage();
      const tokenStorage = createMockTokenStorage();
      // Remove clear method to simulate a provider that doesn't support it
      delete (tokenStorage as Partial<typeof tokenStorage>).clear;

      await expect(Sphere.clear({ storage, tokenStorage })).resolves.not.toThrow();
      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.MNEMONIC);
    });
  });

  describe('backward compatibility', () => {
    it('should accept StorageProvider directly (legacy API)', async () => {
      const storage = createMockStorage();

      // Old-style call: Sphere.clear(storage)
      await Sphere.clear(storage);

      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.MNEMONIC);
      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.WALLET_EXISTS);
    });

    it('should accept options object (new API)', async () => {
      const storage = createMockStorage();

      // New-style call: Sphere.clear({ storage })
      await Sphere.clear({ storage });

      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.MNEMONIC);
      expect(storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.WALLET_EXISTS);
    });
  });
});
