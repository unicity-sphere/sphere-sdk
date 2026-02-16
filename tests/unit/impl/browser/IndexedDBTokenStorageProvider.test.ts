/**
 * Tests for IndexedDBTokenStorageProvider
 *
 * Covers:
 * - Basic save/load lifecycle
 * - Per-address database isolation (tokens don't leak between addresses)
 * - Address switching preserves data (no cleanup of other address databases)
 * - shutdown() properly closes connections (prevents deleteDatabase blocked)
 * - clear() deletes databases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBTokenStorageProvider } from '../../../../impl/browser/storage/IndexedDBTokenStorageProvider';
import type { TxfStorageDataBase } from '../../../../storage';
import type { FullIdentity } from '../../../../types';

// =============================================================================
// Helpers
// =============================================================================

function createProvider(prefix?: string): IndexedDBTokenStorageProvider {
  return new IndexedDBTokenStorageProvider({
    dbNamePrefix: prefix ?? 'test-token-storage',
  });
}

function createIdentity(directAddress: string): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1testaddr',
    directAddress,
    nametag: 'testuser',
  };
}

function createTxfData(tokenIds: string[]): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: {
      version: 1,
      address: 'alpha1test',
      formatVersion: '2.0',
      updatedAt: Date.now(),
    },
  };
  for (const id of tokenIds) {
    (data as Record<string, unknown>)[`_${id}`] = {
      version: '2.0',
      state: { tokenId: id },
      transactions: [],
    };
  }
  return data;
}

// =============================================================================
// Tests
// =============================================================================

describe('IndexedDBTokenStorageProvider', () => {
  let provider: IndexedDBTokenStorageProvider;

  afterEach(async () => {
    if (provider?.isConnected()) {
      await provider.shutdown();
    }
  });

  describe('basic lifecycle', () => {
    beforeEach(async () => {
      provider = createProvider();
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
    });

    it('should save and load tokens', async () => {
      const data = createTxfData(['token1', 'token2']);
      const saveResult = await provider.save(data);
      expect(saveResult.success).toBe(true);

      const loadResult = await provider.load();
      expect(loadResult.success).toBe(true);
      expect(loadResult.data).toBeDefined();
      expect(loadResult.data!['_token1' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadResult.data!['_token2' as keyof TxfStorageDataBase]).toBeDefined();
    });

    it('should report connected after initialize', () => {
      expect(provider.isConnected()).toBe(true);
      expect(provider.getStatus()).toBe('connected');
    });

    it('should report disconnected after shutdown', async () => {
      await provider.shutdown();
      expect(provider.isConnected()).toBe(false);
      expect(provider.getStatus()).toBe('disconnected');
    });
  });

  describe('per-address isolation', () => {
    it('should keep tokens separate per address', async () => {
      provider = createProvider();

      // Save tokens to address A
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      await provider.save(createTxfData(['tokenA1', 'tokenA2']));
      await provider.shutdown();

      // Save tokens to address B
      provider.setIdentity(createIdentity('DIRECT://addr_B'));
      await provider.initialize();
      await provider.save(createTxfData(['tokenB1']));

      // Load from address B — should only have B's tokens
      const loadB = await provider.load();
      expect(loadB.success).toBe(true);
      expect(loadB.data!['_tokenB1' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadB.data!['_tokenA1' as keyof TxfStorageDataBase]).toBeUndefined();
      await provider.shutdown();

      // Switch back to address A — should still have A's tokens
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      const loadA = await provider.load();
      expect(loadA.success).toBe(true);
      expect(loadA.data!['_tokenA1' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadA.data!['_tokenA2' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadA.data!['_tokenB1' as keyof TxfStorageDataBase]).toBeUndefined();
    });
  });

  describe('address switching preserves data', () => {
    it('should NOT delete other address databases on initialize', async () => {
      provider = createProvider();

      // Save tokens to address A
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      await provider.save(createTxfData(['tokenA1', 'tokenA2', 'tokenA3']));
      await provider.shutdown();

      // Switch to address B (simulates switchToAddress flow)
      provider.setIdentity(createIdentity('DIRECT://addr_B'));
      await provider.initialize();
      await provider.save(createTxfData(['tokenB1']));
      await provider.shutdown();

      // Switch to address C
      provider.setIdentity(createIdentity('DIRECT://addr_C'));
      await provider.initialize();
      // Don't save anything — just opening the DB should not destroy others
      await provider.shutdown();

      // Verify address A still has all tokens
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      const loadA = await provider.load();
      expect(loadA.success).toBe(true);
      expect(loadA.data!['_tokenA1' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadA.data!['_tokenA2' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadA.data!['_tokenA3' as keyof TxfStorageDataBase]).toBeDefined();
      await provider.shutdown();

      // Verify address B still has its tokens
      provider.setIdentity(createIdentity('DIRECT://addr_B'));
      await provider.initialize();
      const loadB = await provider.load();
      expect(loadB.success).toBe(true);
      expect(loadB.data!['_tokenB1' as keyof TxfStorageDataBase]).toBeDefined();
    });

    it('should close old connection when initialize is called again', async () => {
      provider = createProvider();

      // Open address A
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      expect(provider.isConnected()).toBe(true);

      // Switch to address B without explicit shutdown (as switchToAddress does)
      provider.setIdentity(createIdentity('DIRECT://addr_B'));
      await provider.initialize();
      expect(provider.isConnected()).toBe(true);

      // Should be able to save/load on the new address without issues
      await provider.save(createTxfData(['tokenB1']));
      const load = await provider.load();
      expect(load.success).toBe(true);
      expect(load.data!['_tokenB1' as keyof TxfStorageDataBase]).toBeDefined();
    });
  });

  describe('clear()', () => {
    it('should delete the current database', async () => {
      provider = createProvider();
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      await provider.save(createTxfData(['token1']));

      await provider.clear();

      // Re-initialize and check — should be empty
      provider.setIdentity(createIdentity('DIRECT://addr_A'));
      await provider.initialize();
      const load = await provider.load();
      expect(load.success).toBe(true);
      // After clear + re-init, no tokens should exist
      const tokenKeys = Object.keys(load.data!).filter(k => k.startsWith('_') && k !== '_meta' && k !== '_tombstones' && k !== '_outbox' && k !== '_sent' && k !== '_invalid');
      expect(tokenKeys).toHaveLength(0);
    });
  });
});
