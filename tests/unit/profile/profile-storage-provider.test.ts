/**
 * Tests for profile/profile-storage-provider.ts
 *
 * Uses a mock ProfileDatabase (in-memory Map) and a mock StorageProvider
 * (in-memory Map) as the local cache layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { FullIdentity, TrackedAddressEntry } from '../../../types';
import { ProfileStorageProvider } from '../../../profile/profile-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptString,
  decryptString,
} from '../../../profile/encryption';

// ---------------------------------------------------------------------------
// Mock ProfileDatabase (in-memory)
// ---------------------------------------------------------------------------

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const listeners: Array<() => void> = [];
  let connected = true; // start connected for most tests

  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {
      connected = true;
    },
    async put(key: string, value: Uint8Array) {
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
    },
    onReplication(cb: () => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    isConnected() {
      return connected;
    },
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

// ---------------------------------------------------------------------------
// Mock StorageProvider (in-memory local cache)
// ---------------------------------------------------------------------------

function createMockCache(): StorageProvider & { _store: Map<string, string>; _trackedAddresses: TrackedAddressEntry[] } {
  const store = new Map<string, string>();
  let trackedAddresses: TrackedAddressEntry[] = [];

  return {
    id: 'mock-cache',
    name: 'Mock Cache',
    type: 'local' as const,
    description: 'In-memory mock cache',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity(_identity: FullIdentity) {},
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    },
    async has(key: string) {
      return store.has(key);
    },
    async keys(prefix?: string) {
      const all = Array.from(store.keys());
      if (!prefix) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) {
        store.clear();
      } else {
        for (const k of store.keys()) {
          if (k.startsWith(prefix)) store.delete(k);
        }
      }
    },
    async saveTrackedAddresses(entries: TrackedAddressEntry[]) {
      trackedAddresses = entries;
    },
    async loadTrackedAddresses() {
      return trackedAddresses;
    },
    _store: store,
    _trackedAddresses: trackedAddresses,
  } as StorageProvider & { _store: Map<string, string>; _trackedAddresses: TrackedAddressEntry[] };
}

// ---------------------------------------------------------------------------
// Test identity
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

// Computed from the directAddress: first 6 = aabbcc, last 6 = ddeeff
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileStorageProvider', () => {
  let db: ReturnType<typeof createMockDb>;
  let cache: ReturnType<typeof createMockCache>;
  let provider: ProfileStorageProvider;

  beforeEach(() => {
    db = createMockDb();
    cache = createMockCache();
    provider = new ProfileStorageProvider(cache, db, {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
      },
      encrypt: true,
    });
    // Set identity so encryption key is derived and addressId is set
    provider.setIdentity(TEST_IDENTITY);
    // Mark as connected for tests (bypass connect flow that requires real OrbitDB)
    (provider as any).dbConnected = true;
    (provider as any).status = 'connected';
  });

  // =========================================================================
  // Key translation
  // =========================================================================

  describe('key translation', () => {
    it("global key 'mnemonic' maps to 'identity.mnemonic'", async () => {
      await provider.set('mnemonic', 'test-mnemonic');
      expect(db._store.has('identity.mnemonic')).toBe(true);
    });

    it("global key 'wallet_exists' maps to 'wallet_exists'", async () => {
      await provider.set('wallet_exists', 'true');
      expect(db._store.has('wallet_exists')).toBe(true);
    });

    it('per-address key with explicit prefix translates correctly', async () => {
      await provider.set(`${EXPECTED_ADDRESS_ID}_pending_transfers`, 'data');
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.pendingTransfers`)).toBe(true);
    });

    it('per-address key without prefix uses current addressId', async () => {
      await provider.set('pending_transfers', 'data');
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.pendingTransfers`)).toBe(true);
    });

    it('dynamic transport key translates', async () => {
      await provider.set('last_wallet_event_ts_abc123', '100');
      expect(db._store.has('transport.lastWalletEventTs.abc123')).toBe(true);
    });

    it('dynamic swap key translates', async () => {
      await provider.set(`${EXPECTED_ADDRESS_ID}_swap:xyz`, 'val');
      expect(db._store.has(`${EXPECTED_ADDRESS_ID}.swap:xyz`)).toBe(true);
    });

    it('IPFS state keys are excluded', async () => {
      await provider.set('ipfs_seq_something', 'val');
      const result = await provider.get('ipfs_seq_something');
      expect(result).toBeNull();
      // Should not be in either db or cache
      expect(db._store.has('ipfs_seq_something')).toBe(false);
    });
  });

  // =========================================================================
  // Cache-only keys
  // =========================================================================

  describe('cache-only keys', () => {
    it("cache-only key 'token_registry_cache' written to cache only", async () => {
      const putSpy = vi.spyOn(db, 'put');
      await provider.set('token_registry_cache', 'data');
      // Should be in cache
      expect(cache._store.has('token_registry_cache')).toBe(true);
      // Should NOT have been written to OrbitDB
      expect(putSpy).not.toHaveBeenCalled();
    });

    it('cache-only key not read from OrbitDB on cache miss', async () => {
      const getSpy = vi.spyOn(db, 'get');
      const result = await provider.get('token_registry_cache');
      expect(result).toBeNull();
      expect(getSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // get/set round-trip
  // =========================================================================

  describe('get/set round-trip', () => {
    it('set then get returns value from cache', async () => {
      await provider.set('mnemonic', 'secret');
      const result = await provider.get('mnemonic');
      expect(result).toBe('secret');
    });

    it('get falls back to OrbitDB on cache miss', async () => {
      // Write encrypted value directly to OrbitDB (bypassing provider)
      const encKey = deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
      const encrypted = await encryptString(encKey, 'from-orbit');
      db._store.set('identity.mnemonic', encrypted);

      // Cache is empty, so get should fall back to OrbitDB
      const result = await provider.get('mnemonic');
      expect(result).toBe('from-orbit');

      // Also should have populated cache
      expect(cache._store.get('mnemonic')).toBe('from-orbit');
    });

    it('get returns null when neither cache nor OrbitDB has the key', async () => {
      const result = await provider.get('mnemonic');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // has() special cases
  // =========================================================================

  describe('has() special cases', () => {
    it("has('wallet_exists') on cold cache checks OrbitDB for identity keys", async () => {
      // Put an identity key in OrbitDB
      const encKey = deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
      const encrypted = await encryptString(encKey, 'some-mnemonic');
      db._store.set('identity.mnemonic', encrypted);

      const result = await provider.has('wallet_exists');
      expect(result).toBe(true);
    });

    it("has('wallet_exists') returns false when profile.cleared is true", async () => {
      const encKey = deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));

      // Set identity keys in OrbitDB
      const encMnemonic = await encryptString(encKey, 'some-mnemonic');
      db._store.set('identity.mnemonic', encMnemonic);

      // Set profile.cleared flag
      const encCleared = await encryptString(encKey, 'true');
      db._store.set('profile.cleared', encCleared);

      const result = await provider.has('wallet_exists');
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // keys()
  // =========================================================================

  describe('keys()', () => {
    it('keys() returns union of cache and OrbitDB keys in legacy format', async () => {
      // Add to cache
      cache._store.set('mnemonic', 'val');

      // Add to OrbitDB (the provider reverse-maps profile keys to legacy keys)
      const encKey = deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
      const enc = await encryptString(encKey, 'val');
      db._store.set('identity.chainCode', enc);

      const keys = await provider.keys();
      expect(keys).toContain('mnemonic');
      expect(keys).toContain('chain_code');
      // Deduplication: mnemonic should appear only once
      expect(keys.filter((k) => k === 'mnemonic').length).toBe(1);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================

  describe('clear()', () => {
    it('clear() writes profile.cleared flag to OrbitDB', async () => {
      await provider.clear();
      expect(db._store.has('profile.cleared')).toBe(true);

      // Verify the value decrypts to 'true'
      const encKey = deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
      const decrypted = await decryptString(encKey, db._store.get('profile.cleared')!);
      expect(decrypted).toBe('true');
    });

    it('clear() delegates to local cache clear', async () => {
      cache._store.set('key1', 'val1');
      cache._store.set('key2', 'val2');
      await provider.clear();
      expect(cache._store.size).toBe(0);
    });
  });

  // =========================================================================
  // saveTrackedAddresses / loadTrackedAddresses
  // =========================================================================

  describe('saveTrackedAddresses / loadTrackedAddresses', () => {
    const testEntries: TrackedAddressEntry[] = [
      { index: 0, hidden: false, createdAt: 1000, updatedAt: 2000 },
      { index: 1, hidden: true, createdAt: 1100, updatedAt: 2100 },
    ];

    it('saveTrackedAddresses writes to both cache and OrbitDB', async () => {
      const cacheSpy = vi.spyOn(cache, 'saveTrackedAddresses');
      const dbPutSpy = vi.spyOn(db, 'put');

      await provider.saveTrackedAddresses(testEntries);

      expect(cacheSpy).toHaveBeenCalledWith(testEntries);
      expect(dbPutSpy).toHaveBeenCalledWith(
        'addresses.tracked',
        expect.any(Uint8Array),
      );
    });

    it('loadTrackedAddresses from cache', async () => {
      // Populate cache directly
      (cache as any)._trackedAddresses = undefined;
      // Save through provider to populate both
      await provider.saveTrackedAddresses(testEntries);

      const result = await provider.loadTrackedAddresses();
      expect(result).toEqual(testEntries);
    });

    it('loadTrackedAddresses falls back to OrbitDB on empty cache', async () => {
      // Write encrypted tracked addresses directly to OrbitDB
      const encKey = deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
      const json = JSON.stringify({ version: 1, addresses: testEntries });
      const encrypted = await encryptString(encKey, json);
      db._store.set('addresses.tracked', encrypted);

      // Cache returns empty
      const result = await provider.loadTrackedAddresses();
      expect(result).toEqual(testEntries);
    });
  });

  // =========================================================================
  // setIdentity
  // =========================================================================

  describe('setIdentity', () => {
    it('setIdentity is synchronous', () => {
      const newProvider = new ProfileStorageProvider(cache, db, {
        config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
        encrypt: true,
      });
      // setIdentity returns void (not a Promise)
      const result = newProvider.setIdentity(TEST_IDENTITY);
      expect(result).toBeUndefined();
    });

    it('setIdentity derives encryption key and forwards to local cache', async () => {
      const newCache = createMockCache();
      const cacheSpy = vi.spyOn(newCache, 'setIdentity');
      const newProvider = new ProfileStorageProvider(newCache, db, {
        config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
        encrypt: true,
      });

      newProvider.setIdentity(TEST_IDENTITY);

      // Verify cache received the identity
      expect(cacheSpy).toHaveBeenCalledWith(TEST_IDENTITY);

      // Verify encryption key was derived (set a value and check it is encrypted in OrbitDB)
      (newProvider as any).dbConnected = true;
      (newProvider as any).status = 'connected';
      await newProvider.set('mnemonic', 'test');
      const stored = db._store.get('identity.mnemonic');
      expect(stored).toBeDefined();
      // The stored value should be encrypted (not raw UTF-8)
      const rawText = new TextDecoder().decode(stored!);
      expect(rawText).not.toBe('test');
    });
  });
});
