/**
 * Tests for profile integration — end-to-end tests using mock providers.
 * Exercises the full provider stack: factory wiring, lifecycle, save/load,
 * multi-device simulation, and migration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the orbitdb-adapter to avoid transitive @noble/curves resolution issues
vi.mock('../../../profile/orbitdb-adapter', () => {
  class OrbitDbAdapter {
    async connect() {}
    async put() {}
    async get() { return null; }
    async del() {}
    async all() { return new Map(); }
    async close() {}
    onReplication() { return () => {}; }
    isConnected() { return false; }
  }
  return { OrbitDbAdapter, ProfileError: Error };
});

import { ProfileMigration } from '../../../profile/migration';
import { createProfileProviders } from '../../../profile/factory';
import { ProfileStorageProvider } from '../../../profile/profile-storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfileDatabase } from '../../../profile/types';
import type { ProfileConfig } from '../../../profile/types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage/storage-provider';
import type { FullIdentity } from '../../../types/index';

// =============================================================================
// Mock ProfileDatabase (in-memory Map)
// =============================================================================

function createMockProfileDatabase(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  const replicationCallbacks: Array<() => void> = [];
  let connected = false;

  return {
    async connect() { connected = true; },
    async put(key: string, value: Uint8Array) {
      if (!connected) throw new Error('Not connected');
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(prefix?: string) {
      const result = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v);
        }
      }
      return result;
    },
    async close() {
      connected = false;
      replicationCallbacks.length = 0;
    },
    onReplication(callback: () => void) {
      replicationCallbacks.push(callback);
      return () => {
        const idx = replicationCallbacks.indexOf(callback);
        if (idx >= 0) replicationCallbacks.splice(idx, 1);
      };
    },
    isConnected() { return connected; },
    // Expose internals for testing
    _store: store,
    _triggerReplication() {
      for (const cb of replicationCallbacks) cb();
    },
  } as any;
}

// =============================================================================
// Mock StorageProvider (local cache)
// =============================================================================

function createMockCacheStorage(): StorageProvider {
  const store = new Map<string, string>();
  let trackedAddresses: any[] = [];
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async set(key: string, value: string) { store.set(key, value); },
    async remove(key: string) { store.delete(key); },
    async has(key: string) { return store.has(key); },
    async keys(prefix?: string) {
      return [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) store.clear();
      else for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    setIdentity() {},
    async saveTrackedAddresses(entries: any[]) { trackedAddresses = entries; },
    async loadTrackedAddresses() { return trackedAddresses; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-cache',
    name: 'Mock Cache Storage',
    type: 'local' as const,
    _store: store,
  } as any;
}

// =============================================================================
// Mock Legacy Providers
// =============================================================================

function createMockLegacyStorage(data: Record<string, string>): StorageProvider {
  const store = new Map(Object.entries(data));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async set(key: string, value: string) { store.set(key, value); },
    async remove(key: string) { store.delete(key); },
    async has(key: string) { return store.has(key); },
    async keys(prefix?: string) {
      return [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) store.clear();
      else for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    setIdentity() {},
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() { return []; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-legacy',
    name: 'Mock Legacy Storage',
    type: 'local' as const,
    _store: store,
  } as any;
}

function createMockLegacyTokenStorage(
  txfData: TxfStorageDataBase | null,
): TokenStorageProvider<TxfStorageDataBase> {
  return {
    setIdentity() {},
    async initialize() { return true; },
    async shutdown() {},
    async save() { return { success: true, timestamp: Date.now() }; },
    async load() {
      return {
        success: txfData !== null,
        data: txfData ?? undefined,
        source: 'local' as const,
        timestamp: Date.now(),
      };
    },
    async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
    async clear() { return true; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-legacy-token',
    name: 'Mock Legacy Token Storage',
    type: 'local' as const,
  } as any;
}

// =============================================================================
// Test Identity
// =============================================================================

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'ab'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCC112233DDEEFF445566',
  privateKey: 'ff'.repeat(32),
};

// =============================================================================
// Test Suite
// =============================================================================

describe('Profile Integration', () => {
  // ---------------------------------------------------------------------------
  // Full lifecycle
  // ---------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('create providers, setIdentity, save tokens, load tokens, verify round-trip', async () => {
      const mockDb = createMockProfileDatabase();
      const cacheStorage = createMockCacheStorage();

      // Create ProfileStorageProvider directly with the mock DB
      const storage = new ProfileStorageProvider(cacheStorage, mockDb, {
        config: { orbitDb: { privateKey: TEST_IDENTITY.privateKey } },
        encrypt: false,
        debug: false,
      });

      storage.setIdentity(TEST_IDENTITY);
      await mockDb.connect({} as any);

      // Save some keys
      await storage.set('mnemonic', 'test phrase');
      await storage.set('wallet_exists', 'true');

      // Read back
      const mnemonic = await storage.get('mnemonic');
      expect(mnemonic).toBe('test phrase');
      const exists = await storage.get('wallet_exists');
      expect(exists).toBe('true');
    });

    it('setIdentity derives encryption key, subsequent save/load decrypts correctly', async () => {
      const mockDb = createMockProfileDatabase();

      // Provider A writes
      const cacheA = createMockCacheStorage();
      const storageA = new ProfileStorageProvider(cacheA, mockDb, {
        config: { orbitDb: { privateKey: TEST_IDENTITY.privateKey } },
        encrypt: true,
      });
      storageA.setIdentity(TEST_IDENTITY);
      await mockDb.connect({} as any);

      // Access internal connection state
      (storageA as any).dbConnected = true;
      await storageA.set('mnemonic', 'encrypt me');

      // Provider B reads from the same OrbitDB with fresh cache
      const cacheB = createMockCacheStorage();
      const storageB = new ProfileStorageProvider(cacheB, mockDb, {
        config: { orbitDb: { privateKey: TEST_IDENTITY.privateKey } },
        encrypt: true,
      });
      storageB.setIdentity(TEST_IDENTITY);
      (storageB as any).dbConnected = true;

      // Clear cache so it falls through to OrbitDB
      const value = await storageB.get('mnemonic');
      expect(value).toBe('encrypt me');
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-device simulation
  // ---------------------------------------------------------------------------

  describe('multi-device simulation', () => {
    it('two providers sharing OrbitDB see data from both', async () => {
      const sharedDb = createMockProfileDatabase();
      await sharedDb.connect({} as any);

      // Provider A
      const cacheA = createMockCacheStorage();
      const storageA = new ProfileStorageProvider(cacheA, sharedDb, {
        config: { orbitDb: { privateKey: TEST_IDENTITY.privateKey } },
        encrypt: false,
      });
      storageA.setIdentity(TEST_IDENTITY);
      (storageA as any).dbConnected = true;
      await storageA.set('mnemonic', 'shared secret');

      // Provider B
      const cacheB = createMockCacheStorage();
      const storageB = new ProfileStorageProvider(cacheB, sharedDb, {
        config: { orbitDb: { privateKey: TEST_IDENTITY.privateKey } },
        encrypt: false,
      });
      storageB.setIdentity(TEST_IDENTITY);
      (storageB as any).dbConnected = true;

      // B should see A's data via OrbitDB fallback
      const value = await storageB.get('mnemonic');
      expect(value).toBe('shared secret');
    });
  });

  // ---------------------------------------------------------------------------
  // Migration flow
  // ---------------------------------------------------------------------------

  describe('migration flow', () => {
    it('legacy data migrates to Profile and verifies correctly', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'abandon abandon abandon',
        master_key: 'deadbeef',
        chain_code: 'cafebabe',
      });

      const txfData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _token1: { id: 'token1', amount: '100' },
        _token2: { id: 'token2', amount: '200' },
      } as any;

      const legacyTokenStorage = createMockLegacyTokenStorage(txfData);

      // Use mock profile providers that accept and return data
      const profileStore = new Map<string, string>();
      const profileStorage = {
        async get(key: string) { return profileStore.get(key) ?? null; },
        async set(key: string, value: string) { profileStore.set(key, value); },
        async remove(key: string) { profileStore.delete(key); },
        async has(key: string) { return profileStore.has(key); },
        async keys() { return [...profileStore.keys()]; },
        async clear() { profileStore.clear(); },
        setIdentity() {},
        async saveTrackedAddresses() {},
        async loadTrackedAddresses() { return []; },
        async connect() {},
        async disconnect() {},
        isConnected() { return true; },
        getStatus() { return 'connected'; },
      } as any;

      let savedData: TxfStorageDataBase | null = null;
      const historyEntries: any[] = [];
      const profileTokenStorage = {
        setIdentity() {},
        async initialize() { return true; },
        async shutdown() {},
        async save(data: TxfStorageDataBase) {
          savedData = data;
          return { success: true, timestamp: Date.now() };
        },
        async load() {
          return {
            success: savedData !== null,
            data: savedData,
            source: 'cache',
            timestamp: Date.now(),
          };
        },
        async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
        async clear() { return true; },
        async connect() {},
        async disconnect() {},
        isConnected() { return true; },
        getStatus() { return 'connected'; },
        async getHistoryEntries() { return historyEntries; },
        async addHistoryEntry(e: any) { historyEntries.push(e); },
      } as any;

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage,
        profileTokenStorage,
      );

      expect(result.success).toBe(true);
      expect(result.tokensMigrated).toBe(2);
      expect(result.keysMigrated).toBeGreaterThan(0);

      // Verify profile has identity keys
      expect(profileStore.has('identity.mnemonic')).toBe(true);
      expect(profileStore.get('identity.mnemonic')).toBe('abandon abandon abandon');
    });

    it('post-migration cleanup removes legacy data', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
        master_key: 'abc',
        some_custom_key: 'value',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);

      const profileStore = new Map<string, string>();
      const profileStorage = {
        async get(key: string) { return profileStore.get(key) ?? null; },
        async set(key: string, value: string) { profileStore.set(key, value); },
        async remove(key: string) { profileStore.delete(key); },
        async has(key: string) { return profileStore.has(key); },
        async keys() { return [...profileStore.keys()]; },
        async clear() { profileStore.clear(); },
        setIdentity() {},
        async saveTrackedAddresses() {},
        async loadTrackedAddresses() { return []; },
        async connect() {},
        async disconnect() {},
        isConnected() { return true; },
        getStatus() { return 'connected'; },
      } as any;

      const profileTokenStorage = {
        setIdentity() {},
        async initialize() { return true; },
        async shutdown() {},
        async save() { return { success: true, timestamp: Date.now() }; },
        async load() { return { success: true, data: undefined, source: 'cache', timestamp: Date.now() }; },
        async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
        async connect() {},
        async disconnect() {},
        isConnected() { return true; },
        getStatus() { return 'connected'; },
        async getHistoryEntries() { return []; },
      } as any;

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage,
        profileTokenStorage,
      );

      expect(result.success).toBe(true);

      // Legacy storage should be empty except migration tracking
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      const remainingKeys = [...legacyStore.keys()];
      // Only migration.phase and migration.startedAt should remain
      for (const key of remainingKeys) {
        expect(key).toMatch(/^migration\./);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Factory function
  // ---------------------------------------------------------------------------

  describe('factory function', () => {
    it('createProfileProviders returns valid storage and tokenStorage', () => {
      const cacheStorage = createMockCacheStorage();
      const config: ProfileConfig = {
        orbitDb: { privateKey: 'ff'.repeat(32) },
      };

      const providers = createProfileProviders(config, cacheStorage);

      expect(providers.storage).toBeInstanceOf(ProfileStorageProvider);
      expect(providers.tokenStorage).toBeInstanceOf(ProfileTokenStorageProvider);
    });

    it('bootstrap peers merge from profileOrbitDbPeers alias', () => {
      const cacheStorage = createMockCacheStorage();
      const config: ProfileConfig = {
        orbitDb: {
          privateKey: 'ff'.repeat(32),
          bootstrapPeers: ['peer0'],
        },
        profileOrbitDbPeers: ['peer1'],
      };

      const providers = createProfileProviders(config, cacheStorage);

      // Access the internal config to verify merge
      // The resolved config is used to create the OrbitDbAdapter, but we can
      // verify it through the options passed to ProfileStorageProvider
      const storageOpts = (providers.storage as any).options;
      expect(storageOpts.config.orbitDb.bootstrapPeers).toContain('peer0');
      expect(storageOpts.config.orbitDb.bootstrapPeers).toContain('peer1');
    });

    it('default IPFS gateways used when none specified', () => {
      const cacheStorage = createMockCacheStorage();
      const config: ProfileConfig = {
        orbitDb: { privateKey: 'ff'.repeat(32) },
        // ipfsGateways not specified
      };

      const providers = createProfileProviders(config, cacheStorage);

      // The tokenStorage should have default gateways from constants.ts
      const gateways = (providers.tokenStorage as any)._ipfsGateways;
      expect(gateways).toBeDefined();
      expect(gateways.length).toBeGreaterThan(0);
      // Default gateway includes 'unicity'
      expect(gateways[0]).toMatch(/unicity/);
    });

    it('encryption disabled when encrypt: false', () => {
      const cacheStorage = createMockCacheStorage();
      const config: ProfileConfig = {
        orbitDb: { privateKey: 'ff'.repeat(32) },
        encrypt: false,
      };

      const providers = createProfileProviders(config, cacheStorage);

      // Verify the storage provider has encryption disabled
      const encEnabled = (providers.storage as any).encryptionEnabled;
      expect(encEnabled).toBe(false);
    });
  });
});
