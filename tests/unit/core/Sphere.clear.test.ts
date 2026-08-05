/**
 * Tests for Sphere.clear() — complete wallet data cleanup.
 * Post-flip: clear({ storage }) wipes the whole KV store, which INCLUDES the
 * payments vertical's pv2:{network}:{pubkey}:* scoped KV (refresh token,
 * cursors, journals all live in the plain StorageProvider).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Sphere } from '../../../core/Sphere';
import type { StorageProvider } from '../../../storage';
import type { ProviderStatus } from '../../../types';

// =============================================================================
// Mocks
// =============================================================================

function createMockStorage(): StorageProvider & { _data: Map<string, string> } {
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
    _data: data,
  } as unknown as StorageProvider & { _data: Map<string, string> };
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

  it('should call storage.clear() to remove all data', async () => {
    const storage = createMockStorage();

    await Sphere.clear({ storage });

    expect(storage.clear).toHaveBeenCalled();
  });

  it('should not throw when no instance exists', async () => {
    const storage = createMockStorage();

    await expect(Sphere.clear({ storage })).resolves.not.toThrow();
  });

  it('wipes the pv2 scoped KV (durable payments state) with the KV store', async () => {
    const storage = createMockStorage();
    // Seed pv2 durable-state rows the way the vertical writes them (plain
    // StorageProvider keys, self-prefixed pv2:{network}:{pubkey}:).
    storage._data.set('pv2:testnet2:02abc:intents', '[]');
    storage._data.set('pv2:testnet2:02abc:cursor:mailbox', '{"cursor":1,"syncEpoch":"0"}');
    storage._data.set('unrelated', 'value');

    await Sphere.clear({ storage });

    expect(storage.clear).toHaveBeenCalled();
    expect(storage._data.size).toBe(0);
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

      await Sphere.clear({ storage });

      expect(mockInstance.destroy).toHaveBeenCalled();
      expect(Sphere.getInstance()).toBeNull();
    });

    it('should connect storage if disconnected before clearing', async () => {
      const storage = createMockStorage();
      (storage.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await Sphere.clear({ storage });

      expect(storage.connect).toHaveBeenCalled();
    });
  });
});
