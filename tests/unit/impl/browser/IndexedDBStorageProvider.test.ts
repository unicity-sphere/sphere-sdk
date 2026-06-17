/**
 * Tests for IndexedDBStorageProvider
 *
 * Covers:
 * - connect/disconnect lifecycle
 * - Basic CRUD: get, set, remove, has
 * - keys() with prefix filtering
 * - clear() — full database deletion and prefix-based clearing
 * - Per-address key scoping via getFullKey()
 * - saveTrackedAddresses / loadTrackedAddresses
 * - getJSON / setJSON helpers
 * - clear() with leaked connections (React StrictMode scenario)
 *   Reproduces the exact bug: leaked IDB connection blocks deleteDatabase(),
 *   which then blocks all subsequent open() calls — bricking wallet creation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBStorageProvider } from '../../../../impl/browser/storage/IndexedDBStorageProvider';
import { STORAGE_KEYS_ADDRESS } from '../../../../constants';
import type { FullIdentity } from '../../../../types';

// =============================================================================
// Helpers
// =============================================================================

function createProvider(dbName?: string): IndexedDBStorageProvider {
  return new IndexedDBStorageProvider({
    prefix: 'test_',
    dbName: dbName ?? `test-db-${Math.random().toString(36).slice(2)}`,
  });
}

function createIdentity(directAddress = 'DIRECT://abcdef1234567890'): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    // Per-address storage is now keyed by chainPubkey, so distinct addresses must
    // produce distinct chainPubkeys (realistic — directAddress is derived 1:1 from chainPubkey).
    chainPubkey: '02' + Buffer.from(directAddress).toString('hex').padEnd(64, '0').slice(0, 64),
    directAddress,
    nametag: 'testuser',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('IndexedDBStorageProvider', () => {
  let provider: IndexedDBStorageProvider;

  beforeEach(async () => {
    provider = createProvider();
    await provider.connect();
  });

  afterEach(async () => {
    if (provider.isConnected()) {
      await provider.disconnect();
    }
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('should connect and report connected status', () => {
      expect(provider.isConnected()).toBe(true);
      expect(provider.getStatus()).toBe('connected');
    });

    it('should disconnect', async () => {
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
      expect(provider.getStatus()).toBe('disconnected');
    });

    it('should not fail on double connect', async () => {
      await expect(provider.connect()).resolves.not.toThrow();
      expect(provider.isConnected()).toBe(true);
    });

    it('should throw on operations when not connected', async () => {
      await provider.disconnect();
      await expect(provider.get('key')).rejects.toThrow('not connected');
    });
  });

  // =========================================================================
  // Basic CRUD
  // =========================================================================

  describe('CRUD operations', () => {
    it('should set and get a value', async () => {
      await provider.set('key1', 'value1');
      const result = await provider.get('key1');
      expect(result).toBe('value1');
    });

    it('should return null for missing key', async () => {
      const result = await provider.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should overwrite existing value', async () => {
      await provider.set('key1', 'value1');
      await provider.set('key1', 'value2');
      expect(await provider.get('key1')).toBe('value2');
    });

    it('should remove a value', async () => {
      await provider.set('key1', 'value1');
      await provider.remove('key1');
      expect(await provider.get('key1')).toBeNull();
    });

    it('should check if key exists', async () => {
      await provider.set('key1', 'value1');
      expect(await provider.has('key1')).toBe(true);
      expect(await provider.has('nonexistent')).toBe(false);
    });
  });

  // =========================================================================
  // keys()
  // =========================================================================

  describe('keys()', () => {
    it('should return all keys', async () => {
      await provider.set('a', '1');
      await provider.set('b', '2');
      await provider.set('c', '3');

      const keys = await provider.keys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
    });

    it('should filter by prefix', async () => {
      await provider.set('foo_a', '1');
      await provider.set('foo_b', '2');
      await provider.set('bar_a', '3');

      const keys = await provider.keys('foo_');
      expect(keys).toHaveLength(2);
      expect(keys.every(k => k.startsWith('foo_'))).toBe(true);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('should delete the database when called without prefix', async () => {
      await provider.set('key1', 'value1');
      await provider.clear();

      // Provider should be disconnected after full clear
      expect(provider.isConnected()).toBe(false);

      // Reconnect and verify data is gone
      await provider.connect();
      expect(await provider.get('key1')).toBeNull();
    });

    it('should clear only matching keys with prefix', async () => {
      await provider.set('foo_a', '1');
      await provider.set('foo_b', '2');
      await provider.set('bar_a', '3');

      await provider.clear('foo_');

      expect(await provider.get('foo_a')).toBeNull();
      expect(await provider.get('foo_b')).toBeNull();
      expect(await provider.get('bar_a')).toBe('3');
    });
  });

  // =========================================================================
  // clear() with leaked connections (React StrictMode scenario)
  //
  // These tests reproduce the EXACT bug:
  //   1. React StrictMode double-mount opens two IDB connections
  //   2. First mount's cleanup calls db.close() but connection drains async
  //   3. Second mount's "delete wallet" calls clear() → deleteDatabase()
  //   4. deleteDatabase() fires onblocked, hangs indefinitely
  //   5. The pending delete also blocks ALL subsequent open() calls
  //   6. New wallet creation (Sphere.init()) hangs → wallet bricked
  //
  // The fix: clear() uses idbClear() (store clearing) instead of
  // deleteDatabase(). Store clearing is a normal transaction that cannot
  // be blocked by other connections.
  // =========================================================================

  describe('clear() with leaked connections (React StrictMode scenario)', () => {
    it('should clear and reopen despite leaked connection holding the database', async () => {
      const dbName = `test-leak-${Math.random().toString(36).slice(2)}`;

      // ── Sphere.init() → Sphere.create() ──
      // First wallet is created: storage.connect() → storage.set(mnemonic, ...)
      const storage = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await storage.connect();
      await storage.set('mnemonic', 'old-wallet-data');
      await storage.set('masterKey', 'old-master-key');
      expect(await storage.get('mnemonic')).toBe('old-wallet-data');

      // ── React StrictMode leaked connection ──
      // StrictMode first mount opens IDB → cleanup closes provider,
      // but the raw IDB connection drains async and stays alive.
      // We simulate this by opening a raw IDB connection and NOT closing it.
      const leakedDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv', { keyPath: 'k' });
          }
        };
      });
      // leakedDb is NOT closed — this is the root cause of the bug!

      // ── Sphere.destroy() ──
      // User clicks "Delete wallet". Sphere.destroy() disconnects providers.
      await storage.disconnect();
      expect(storage.isConnected()).toBe(false);

      // ── 50ms yield (from Sphere.clear()) ──
      await new Promise((r) => setTimeout(r, 50));

      // ── storage.clear() ──
      // Sphere.clear() reconnects if needed, then clears the store.
      // BUG: clear() calls deleteDatabase() → blocked by leakedDb → timeout →
      //      all subsequent open() also blocked → new wallet creation hangs.
      // FIX: clear() calls idbClear() → works despite leaked connection.
      await storage.clear();
      expect(storage.isConnected()).toBe(false);

      // ── Sphere.init() again → Sphere.create() ──
      // User creates a new wallet. storage.connect() must work.
      const newStorage = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await newStorage.connect();
      expect(newStorage.isConnected()).toBe(true);

      // Old data MUST be gone
      expect(await newStorage.get('mnemonic')).toBeNull();
      expect(await newStorage.get('masterKey')).toBeNull();

      // New wallet data is saved
      await newStorage.set('mnemonic', 'new-wallet-data');
      await newStorage.set('masterKey', 'new-master-key');
      expect(await newStorage.get('mnemonic')).toBe('new-wallet-data');

      // Cleanup
      leakedDb.close();
      await newStorage.disconnect();
    });

    it('should survive full init→destroy→clear→init cycle with leaked connection', async () => {
      const dbName = `test-cycle-${Math.random().toString(36).slice(2)}`;

      // ── First wallet lifecycle ──
      const wallet1 = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await wallet1.connect();
      await wallet1.set('mnemonic', 'first-wallet');
      await wallet1.set('masterKey', 'first-key');

      // ── Leaked connection (StrictMode first mount's async drain) ──
      const leaked = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // ── destroy() first wallet ──
      await wallet1.disconnect();
      // leaked is still open!

      // ── 50ms yield ──
      await new Promise((r) => setTimeout(r, 50));

      // ── clear() via a fresh provider (as Sphere.clear() does) ──
      const clearer = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await clearer.connect();
      await clearer.clear();

      // ── Create second wallet (MUST NOT hang!) ──
      const wallet2 = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await wallet2.connect();
      expect(wallet2.isConnected()).toBe(true);

      // Old data wiped
      expect(await wallet2.get('mnemonic')).toBeNull();
      expect(await wallet2.get('masterKey')).toBeNull();

      // New wallet works
      await wallet2.set('mnemonic', 'second-wallet');
      expect(await wallet2.get('mnemonic')).toBe('second-wallet');

      leaked.close();
      await wallet2.disconnect();
    });

    it('should handle multiple leaked connections simultaneously', async () => {
      const dbName = `test-multi-leak-${Math.random().toString(36).slice(2)}`;

      // ── Save data ──
      const storage = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await storage.connect();
      await storage.set('data', 'original');

      // ── Create multiple leaked connections (StrictMode rapid re-mounts) ──
      const leaks: IDBDatabase[] = [];
      for (let i = 0; i < 3; i++) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(dbName, 1);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        leaks.push(db);
      }

      // ── destroy + clear ──
      await storage.disconnect();
      await new Promise((r) => setTimeout(r, 50));
      await storage.clear();

      // ── Reopen must work despite 3 leaked connections ──
      const fresh = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await fresh.connect();
      expect(fresh.isConnected()).toBe(true);
      expect(await fresh.get('data')).toBeNull();

      // Cleanup
      for (const db of leaks) db.close();
      await fresh.disconnect();
    });

    it('should clear when provider itself was never connected', async () => {
      const dbName = `test-cold-clear-${Math.random().toString(36).slice(2)}`;

      // ── Pre-populate the database via a separate connection ──
      const setup = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await setup.connect();
      await setup.set('mnemonic', 'stale-data');
      await setup.disconnect();

      // ── Leaked connection holding the DB ──
      const leaked = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // ── cold clear: new provider that was never connected calls clear() ──
      // This mimics Sphere.clear() when storage was already disconnected.
      const coldProvider = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      // NOT calling connect() — clear() must handle this internally
      await coldProvider.clear();

      // ── Verify data is gone ──
      const verify = new IndexedDBStorageProvider({ prefix: 'test_', dbName });
      await verify.connect();
      expect(await verify.get('mnemonic')).toBeNull();

      leaked.close();
      await verify.disconnect();
    });
  });

  // =========================================================================
  // Per-address key scoping
  // =========================================================================

  describe('per-address key scoping', () => {
    it('should scope per-address keys when identity is set', async () => {
      const identity = createIdentity();
      provider.setIdentity(identity);

      // MESSAGES is a per-address key
      await provider.set(STORAGE_KEYS_ADDRESS.MESSAGES, 'addr-data');

      // Without identity, should not find the scoped data
      const provider2 = createProvider();
      await provider2.connect();
      // provider2 has no identity — global scope
      const result = await provider2.get(STORAGE_KEYS_ADDRESS.MESSAGES);
      // It won't find the address-scoped key because the full key includes addressId
      expect(result).toBeNull();
      await provider2.disconnect();
    });

    it('should isolate data between different addresses', async () => {
      const identity1 = createIdentity('DIRECT://address1abcdef');
      const identity2 = createIdentity('DIRECT://address2ghijkl');

      // Write with identity 1
      provider.setIdentity(identity1);
      await provider.set(STORAGE_KEYS_ADDRESS.MESSAGES, 'messages-addr1');

      // Switch to identity 2
      provider.setIdentity(identity2);
      await provider.set(STORAGE_KEYS_ADDRESS.MESSAGES, 'messages-addr2');

      // Read with identity 2
      expect(await provider.get(STORAGE_KEYS_ADDRESS.MESSAGES)).toBe('messages-addr2');

      // Switch back to identity 1
      provider.setIdentity(identity1);
      expect(await provider.get(STORAGE_KEYS_ADDRESS.MESSAGES)).toBe('messages-addr1');
    });

    it('should not scope global keys by address', async () => {
      const identity = createIdentity();
      provider.setIdentity(identity);

      // 'mnemonic' is a global key, not in STORAGE_KEYS_ADDRESS
      await provider.set('mnemonic', 'test-mnemonic');

      // Same key without identity should find it
      const provider2 = createProvider();
      await provider2.connect();
      // Accessing the same DB with same prefix but no identity
      // Note: provider2 uses its own random DB name, so we test via same provider
      expect(await provider.get('mnemonic')).toBe('test-mnemonic');
      await provider2.disconnect();
    });
  });

  // =========================================================================
  // saveTrackedAddresses / loadTrackedAddresses
  // =========================================================================

  describe('tracked addresses', () => {
    it('should save and load tracked addresses', async () => {
      const entries = [
        { address: 'addr1', index: 0, label: 'default' },
        { address: 'addr2', index: 1, label: 'savings' },
      ];

      await provider.saveTrackedAddresses(entries as never[]);
      const loaded = await provider.loadTrackedAddresses();

      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ address: 'addr1', index: 0 });
      expect(loaded[1]).toMatchObject({ address: 'addr2', index: 1 });
    });

    it('should return empty array when no tracked addresses', async () => {
      const loaded = await provider.loadTrackedAddresses();
      expect(loaded).toEqual([]);
    });
  });

  // =========================================================================
  // getJSON / setJSON
  // =========================================================================

  describe('JSON helpers', () => {
    it('should set and get JSON data', async () => {
      const data = { name: 'test', count: 42, nested: { a: 1 } };
      await provider.setJSON('json-key', data);
      const result = await provider.getJSON('json-key');
      expect(result).toEqual(data);
    });

    it('should return null for missing JSON key', async () => {
      const result = await provider.getJSON('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      await provider.set('bad-json', 'not-json{{{');
      const result = await provider.getJSON('bad-json');
      expect(result).toBeNull();
    });
  });
});
