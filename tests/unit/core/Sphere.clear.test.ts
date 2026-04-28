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

  // ---------------------------------------------------------------------------
  // T.1.E — per-entry-key collections coverage (W46)
  //
  // Verifies that Sphere.clear() reaches per-entry-key collections (audit,
  // invalid, finalizationQueue) via parent storage clear (a full-prefix
  // wipe), NOT via the PROFILE_KEY_MAPPING table. The contract is:
  // `Sphere.clear()` → `StorageProvider.clear()` → wipes ALL keys including
  // composite per-entry-key forms (`${addr}.<collection>.${id}` and
  // multi-rep `${addr}.<collection>.${tokenId}.${contentHash}`).
  // ---------------------------------------------------------------------------

  describe('T.1.E per-entry-key collection coverage (W46)', () => {
    it("clears all '{addr}.audit.<id>' per-entry records", async () => {
      const storage = createMockStorage();
      const addr = 'DIRECT_aabbcc_ddeeff';
      // Pre-populate composite per-entry-key audit records of the
      // multi-rep form `${tokenId}.${observedTokenContentHash}`.
      await storage.set(`${addr}.audit.token1.cidA`, '{"id":"token1.cidA"}');
      await storage.set(`${addr}.audit.token2.cidB`, '{"id":"token2.cidB"}');
      // Sanity: keys exist before clear.
      expect(await storage.has(`${addr}.audit.token1.cidA`)).toBe(true);

      await Sphere.clear(storage);

      // After clear, ALL audit per-entry-key records are gone.
      expect(storage.clear).toHaveBeenCalled();
      const remaining = (await storage.keys()).filter((k) =>
        k.startsWith(`${addr}.audit.`),
      );
      expect(remaining).toHaveLength(0);
    });

    it("clears all '{addr}.invalid.<id>' per-entry records (multi-rep)", async () => {
      const storage = createMockStorage();
      const addr = 'DIRECT_aabbcc_ddeeff';
      // Multi-rep composite ids: `${tokenId}.${observedTokenContentHash}`.
      await storage.set(
        `${addr}.invalid.token1.cidA`,
        '{"id":"token1.cidA"}',
      );
      await storage.set(
        `${addr}.invalid.token2.legacy-token2`, // synthetic legacy id
        '{"id":"token2.legacy-token2"}',
      );
      expect(await storage.has(`${addr}.invalid.token1.cidA`)).toBe(true);

      await Sphere.clear(storage);

      const remaining = (await storage.keys()).filter((k) =>
        k.startsWith(`${addr}.invalid.`),
      );
      expect(remaining).toHaveLength(0);
    });

    it("clears all '{addr}.finalizationQueue.<id>' per-entry records", async () => {
      const storage = createMockStorage();
      const addr = 'DIRECT_aabbcc_ddeeff';
      await storage.set(`${addr}.finalizationQueue.req1`, '{"id":"req1"}');
      await storage.set(`${addr}.finalizationQueue.req2`, '{"id":"req2"}');
      expect(await storage.has(`${addr}.finalizationQueue.req1`)).toBe(true);

      await Sphere.clear(storage);

      const remaining = (await storage.keys()).filter((k) =>
        k.startsWith(`${addr}.finalizationQueue.`),
      );
      expect(remaining).toHaveLength(0);
    });

    it('clears mixed entries across all 3 new prefixes in one call', async () => {
      const storage = createMockStorage();
      const addr = 'DIRECT_aabbcc_ddeeff';

      // Populate the 3 prefixes simultaneously (the realistic case).
      await storage.set(`${addr}.audit.t1.h1`, 'a1');
      await storage.set(`${addr}.audit.t2.h2`, 'a2');
      await storage.set(`${addr}.invalid.t3.h3`, 'i1');
      await storage.set(`${addr}.invalid.t4.legacy-t4`, 'i2');
      await storage.set(`${addr}.finalizationQueue.r1`, 'f1');
      await storage.set(`${addr}.finalizationQueue.r2`, 'f2');

      // Add a non-target key to ensure clear() does its full wipe (the
      // mock storage.clear() wipes everything, matching real behaviour).
      await storage.set('mnemonic', 'unrelated-key');

      const beforeKeys = await storage.keys();
      // 6 per-entry + 1 unrelated = 7
      expect(beforeKeys).toHaveLength(7);

      await Sphere.clear(storage);

      const afterKeys = await storage.keys();
      expect(afterKeys).toHaveLength(0);
    });

    it('does NOT depend on PROFILE_KEY_MAPPING — pure prefix wipe', async () => {
      // The contract: Sphere.clear() doesn't look up entries in the
      // mapping table. It calls StorageProvider.clear() which is a full
      // wipe regardless of schema. Verify by populating a key shape
      // that has NO mapping table entry — it MUST still be wiped.
      const storage = createMockStorage();
      const addr = 'DIRECT_aabbcc_ddeeff';
      // A hypothetical future per-entry-key collection not yet in the
      // mapping table — the clear path MUST still reach it.
      await storage.set(`${addr}.futureCollection.id1`, 'data1');
      await storage.set(`${addr}.futureCollection.id2`, 'data2');

      await Sphere.clear(storage);

      const remaining = (await storage.keys()).filter((k) =>
        k.startsWith(`${addr}.futureCollection.`),
      );
      expect(remaining).toHaveLength(0);
    });
  });
});
