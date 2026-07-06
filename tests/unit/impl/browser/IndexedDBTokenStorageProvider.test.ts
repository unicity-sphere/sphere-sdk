/**
 * Tests for IndexedDBTokenStorageProvider
 *
 * Covers:
 * - Basic save/load lifecycle
 * - Per-address database isolation (tokens don't leak between addresses)
 * - Address switching preserves data (no cleanup of other address databases)
 * - shutdown() properly closes connections (prevents deleteDatabase blocked)
 * - clear() deletes databases
 * - clear() with leaked connections (React StrictMode scenario)
 *   Reproduces the exact bug: leaked IDB connection blocks deleteDatabase(),
 *   which then blocks all subsequent open() calls — bricking wallet creation.
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

/** Count real token keys in TXF data (exclude meta/tombstones/outbox/sent/invalid) */
function countTokens(data: TxfStorageDataBase): number {
  return Object.keys(data).filter(
    k => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid'].includes(k),
  ).length;
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
      expect(countTokens(load.data!)).toBe(0);
    });
  });

  // =========================================================================
  // clear() with leaked connections (React StrictMode scenario)
  //
  // These tests reproduce the EXACT bug for token storage:
  //   1. Wallet is loaded → tokenStorage.initialize() opens per-address DB
  //   2. React StrictMode double-mount creates a second provider to same DB
  //   3. First mount's cleanup never calls shutdown() → leaked connection
  //   4. User deletes wallet → tokenStorage.clear() → deleteDatabase()
  //   5. deleteDatabase() fires onblocked, hangs
  //   6. New wallet creation → tokenStorage.initialize() hangs → bricked
  //
  // The fix: clear() uses clearStore() instead of deleteDatabase() for the
  // CURRENT database. Store clearing is a normal transaction that cannot
  // be blocked by other connections.
  // =========================================================================

  describe('clear() with leaked connections (React StrictMode scenario)', () => {
    it('should clear tokens despite leaked connection to same database', async () => {
      const prefix = `test-leak-${Math.random().toString(36).slice(2)}`;
      const identity = createIdentity('DIRECT://addr_leak_test');

      // ── Sphere.init() → PaymentsModule.load() saves tokens ──
      const providerA = createProvider(prefix);
      providerA.setIdentity(identity);
      await providerA.initialize();
      await providerA.save(createTxfData(['token1', 'token2']));

      // Verify tokens exist
      const loadBefore = await providerA.load();
      expect(loadBefore.data!['_token1' as keyof TxfStorageDataBase]).toBeDefined();
      expect(loadBefore.data!['_token2' as keyof TxfStorageDataBase]).toBeDefined();

      // ── React StrictMode leaked connection ──
      // StrictMode first mount opens tokenStorage → cleanup doesn't call
      // shutdown() → connection stays open. Second mount opens a fresh one.
      const leaked = createProvider(prefix);
      leaked.setIdentity(identity);
      await leaked.initialize();
      // leaked.shutdown() is NOT called — this is the leak!

      // ── Sphere.destroy() ──
      // User clicks "Delete wallet". destroy() shuts down token providers.
      await providerA.shutdown();

      // ── 50ms yield (from Sphere.clear()) ──
      await new Promise((r) => setTimeout(r, 50));

      // ── tokenStorage.clear() ──
      // BUG: deleteDatabase() → blocked by leaked → timeout → all open() blocked
      // FIX: clearStore() → works instantly, no blocking
      await providerA.clear();

      // ── New wallet → tokenStorage.initialize() must work ──
      const providerB = createProvider(prefix);
      providerB.setIdentity(identity);
      await providerB.initialize();
      expect(providerB.isConnected()).toBe(true);

      // Old tokens must be gone
      const load = await providerB.load();
      expect(countTokens(load.data!)).toBe(0);

      // New tokens can be written
      await providerB.save(createTxfData(['newToken']));
      const loadNew = await providerB.load();
      expect(loadNew.data!['_newToken' as keyof TxfStorageDataBase]).toBeDefined();

      // Cleanup
      await leaked.shutdown();
      await providerB.shutdown();
    });

    it('should survive full save→leak→clear→reinit cycle', async () => {
      const prefix = `test-cycle-${Math.random().toString(36).slice(2)}`;
      const identity = createIdentity('DIRECT://addr_cycle_test');

      // ── First wallet saves tokens ──
      const wallet1 = createProvider(prefix);
      wallet1.setIdentity(identity);
      await wallet1.initialize();
      await wallet1.save(createTxfData(['oldToken']));
      await wallet1.shutdown();

      // ── Leaked connection (StrictMode first mount) ──
      const leaked = createProvider(prefix);
      leaked.setIdentity(identity);
      await leaked.initialize();
      // NOT calling shutdown() — simulates the leak

      // ── clear() with leaked connection ──
      // In real Sphere.clear(), a fresh provider is used
      const clearer = createProvider(prefix);
      clearer.setIdentity(identity);
      await clearer.initialize();
      await clearer.clear();

      // ── New wallet must work (MUST NOT hang!) ──
      const wallet2 = createProvider(prefix);
      wallet2.setIdentity(identity);
      await wallet2.initialize();

      const load = await wallet2.load();
      expect(countTokens(load.data!)).toBe(0); // old data wiped

      await wallet2.save(createTxfData(['newToken']));
      const loadNew = await wallet2.load();
      expect(loadNew.data!['_newToken' as keyof TxfStorageDataBase]).toBeDefined();

      await leaked.shutdown();
      await wallet2.shutdown();
    });

    it('should handle clear when provider was already disconnected', async () => {
      const prefix = `test-cold-${Math.random().toString(36).slice(2)}`;
      const identity = createIdentity('DIRECT://addr_cold_test');

      // ── Pre-populate with tokens ──
      const setup = createProvider(prefix);
      setup.setIdentity(identity);
      await setup.initialize();
      await setup.save(createTxfData(['existingToken']));
      await setup.shutdown();

      // ── Leaked connection ──
      const leaked = createProvider(prefix);
      leaked.setIdentity(identity);
      await leaked.initialize();

      // ── Cold clear: provider that was shut down calls clear() ──
      // This mimics what happens when Sphere.clear() calls tokenStorage.clear()
      // after destroy() already shut everything down.
      const coldProvider = createProvider(prefix);
      coldProvider.setIdentity(identity);
      // NOT calling initialize() — clear() must handle connecting internally
      await coldProvider.clear();

      // ── Verify data is gone ──
      const verify = createProvider(prefix);
      verify.setIdentity(identity);
      await verify.initialize();
      const load = await verify.load();
      expect(countTokens(load.data!)).toBe(0);

      await leaked.shutdown();
      await verify.shutdown();
    });

    it('should clear ALL address databases on full wallet clear', async () => {
      const prefix = `test-multi-addr-${Math.random().toString(36).slice(2)}`;
      const identityA = createIdentity('DIRECT://addr_A');
      const identityB = createIdentity('DIRECT://addr_B');

      // ── Save tokens for both addresses ──
      const provA = createProvider(prefix);
      provA.setIdentity(identityA);
      await provA.initialize();
      await provA.save(createTxfData(['tokenA1', 'tokenA2']));
      await provA.shutdown();

      const provB = createProvider(prefix);
      provB.setIdentity(identityB);
      await provB.initialize();
      await provB.save(createTxfData(['tokenB1']));

      // ── Leaked connection to addr_B ──
      const leaked = createProvider(prefix);
      leaked.setIdentity(identityB);
      await leaked.initialize();

      // ── clear() while pointing to addr_B ──
      // clear() wipes CURRENT DB stores and deletes OTHER address DBs
      await provB.clear();

      // ── addr_B should be empty (cleared via store clearing) ──
      const verifyB = createProvider(prefix);
      verifyB.setIdentity(identityB);
      await verifyB.initialize();
      expect(countTokens((await verifyB.load()).data!)).toBe(0);
      await verifyB.shutdown();

      // ── addr_A should also be empty (deleted via deleteDatabase) ──
      // This is the expected behavior: Sphere.clear() deletes ALL wallet data
      const verifyA = createProvider(prefix);
      verifyA.setIdentity(identityA);
      await verifyA.initialize();
      const loadA = await verifyA.load();
      expect(countTokens(loadA.data!)).toBe(0);

      await leaked.shutdown();
      await verifyA.shutdown();
    });
  });
});
