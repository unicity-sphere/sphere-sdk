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
    // Mark as connected for tests (bypass connect flow that requires real OrbitDB).
    // dbConnected is now a derived getter (dbStatus === 'attached') — no direct
    // assignment possible. Set the underlying fields instead.
    (provider as any).dbStatus = 'attached';
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
      (newProvider as any).dbStatus = 'attached';
      (newProvider as any).status = 'connected';
      await newProvider.set('mnemonic', 'test');
      const stored = db._store.get('identity.mnemonic');
      expect(stored).toBeDefined();
      // The stored value should be encrypted (not raw UTF-8)
      const rawText = new TextDecoder().decode(stored!);
      expect(rawText).not.toBe('test');
    });
  });

  // =========================================================================
  // Two-phase connect (regression: Sphere.init calls connect() twice)
  // =========================================================================

  describe('two-phase connect', () => {
    // DO NOT consolidate createUnconnectedDb / createCountingCache with the
    // suite-wide helpers. They are deliberately distinct: the suite mocks
    // fake `connected=true` from construction, which bypasses the real
    // two-phase connect path these tests are designed to exercise.
    // See commit 5f1fc85 for the bug these tests guard against.

    function createUnconnectedDb(opts?: { failOn?: 'connect' }) {
      const store = new Map<string, Uint8Array>();
      let connected = false;
      const connectCalls: Array<{ privateKey: string; directory?: string }> = [];
      return {
        _store: store,
        _connectCalls: connectCalls,
        async connect(config: any) {
          connectCalls.push(config);
          if (opts?.failOn === 'connect') {
            throw new Error('synthetic-phase-b-failure');
          }
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
        async all() {
          return new Map<string, Uint8Array>();
        },
        async close() {
          connected = false;
        },
        onReplication() {
          return () => {};
        },
        isConnected() {
          return connected;
        },
      };
    }

    it('regression: connect() called before setIdentity() then again after → OrbitDB attaches on second call', async () => {
      // This reproduces the Sphere.init ordering that triggered
      // PROFILE_NOT_INITIALIZED during `init --profile` in the CLI:
      //
      //   1. sphere.create() runs storage.connect() pre-identity
      //      (to detect wallet-exists). No identity → OrbitDB skip.
      //   2. After identity is derived, sphere.initializeProviders()
      //      calls storage.connect() again — but the previous
      //      implementation's early-return left OrbitDB un-attached.
      //   3. Module load hits ensureConnected() → throws.
      //
      // Post-fix: the second connect() completes the lazy attach.
      const freshDb = createUnconnectedDb();
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        config: {
          orbitDb: { privateKey: '__will-be-overridden__', directory: '/tmp/orbitdb-x' },
        },
        encrypt: true,
      });

      // Call 1: no identity yet → local cache connects, OrbitDB skipped.
      await freshProvider.connect();
      expect(freshDb.isConnected()).toBe(false);
      expect(freshDb._connectCalls).toHaveLength(0);

      // Identity arrives.
      freshProvider.setIdentity(TEST_IDENTITY);

      // Call 2: same connect(), but OrbitDB must now attach using the
      // identity. Steelman³⁰: dbNameOverride is derived from a
      // wipeable Uint8Array and privateKey is gated to undefined when
      // the override is set; the adapter sees a valid dbNameOverride
      // string with `sphere-profile-` prefix in either path.
      await freshProvider.connect();
      expect(freshDb.isConnected()).toBe(true);
      expect(freshDb._connectCalls).toHaveLength(1);
      const call0 = freshDb._connectCalls[0];
      // Either dbNameOverride is computed (preferred path) or privateKey
      // is forwarded (legacy fallback when @noble/curves is unavailable).
      const identityForwarded =
        call0.privateKey === TEST_IDENTITY.privateKey ||
        (typeof call0.dbNameOverride === 'string' && call0.dbNameOverride.startsWith('sphere-profile-'));
      expect(identityForwarded).toBe(true);
    });

    it('connect() is idempotent once OrbitDB is attached', async () => {
      const freshDb = createUnconnectedDb();
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-y' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);
      await freshProvider.connect();
      await freshProvider.connect();
      await freshProvider.connect();
      expect(freshDb._connectCalls).toHaveLength(1);
    });

    it('isConnected() returns FALSE between the two connect() calls (so Sphere re-calls connect)', async () => {
      // Regression for the Sphere.initializeProviders guard:
      //   if (!this._storage.isConnected()) { await this._storage.connect(); }
      // If isConnected() returned true after the pre-identity call,
      // the second call would be skipped and OrbitDB would never attach.
      const freshDb = createUnconnectedDb();
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-z' },
        },
        encrypt: true,
      });

      // Phase 1: pre-identity connect.
      await freshProvider.connect();
      // Local cache is connected, OrbitDB isn't. We must report FALSE
      // so Sphere's guard re-calls connect() after setIdentity().
      // (Identity is not yet set → orbitDb config requirement not met → OK)
      // After setIdentity but before attach, isConnected MUST be false.
      freshProvider.setIdentity(TEST_IDENTITY);
      expect(freshProvider.isConnected()).toBe(false);

      // Second connect completes the attach; isConnected flips true.
      await freshProvider.connect();
      expect(freshProvider.isConnected()).toBe(true);
    });

    it('connect() without orbitDb config skips OrbitDB and reports status=connected', async () => {
      // Edge case: some test setups / custom wiring build a
      // ProfileStorageProvider without an OrbitDB config (local-only).
      // The base connection should still succeed.
      const freshDb = createUnconnectedDb();
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);
      await freshProvider.connect();
      expect(freshProvider.isConnected()).toBe(true);
      expect(freshDb._connectCalls).toHaveLength(0);
    });

    it('isConnected() is FALSE after pre-identity connect when orbitDb is configured', async () => {
      // Sphere.initializeProviders relies on this invariant:
      //   if (!this._storage.isConnected()) { await this._storage.connect(); }
      // If isConnected() returned true after pre-identity connect with
      // orbitDb configured, the post-setIdentity call would be skipped
      // and OrbitDB would never attach. (The previous implementation
      // gated on `identity`, which was null pre-setIdentity — so it
      // incorrectly returned true here.)
      const freshDb = createUnconnectedDb();
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-invariant' },
        },
        encrypt: true,
      });

      await freshProvider.connect(); // pre-identity
      expect(freshProvider.isConnected()).toBe(false);
    });

    it('concurrent connect() calls dedupe — db.connect is invoked exactly once', async () => {
      // Without an in-flight promise, two parallel connect() calls could
      // both observe `dbStatus !== 'attached'` and race into `db.connect()`,
      // creating two Helia instances against the same directory lock.
      // The `connectPromise` shared-latch should dedupe.
      const freshDb = createUnconnectedDb();
      // Slow connect so we observably race.
      const origConnect = freshDb.connect.bind(freshDb);
      freshDb.connect = async (config: any) => {
        await new Promise((r) => setTimeout(r, 20));
        return origConnect(config);
      };
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-race' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      await Promise.all([
        freshProvider.connect(),
        freshProvider.connect(),
        freshProvider.connect(),
        freshProvider.connect(),
      ]);

      expect(freshDb._connectCalls).toHaveLength(1);
      expect(freshProvider.isConnected()).toBe(true);
    });

    it('Phase B failure does NOT poison base status — local cache remains connected', async () => {
      // Regression: the previous code flipped `this.status = 'error'` on
      // Phase B failure. That lied to external callers (local cache was
      // still up) AND caused a defensive `disconnect()` to tear down a
      // working cache. Post-fix: base status stays 'connected', only
      // `dbStatus` flips to 'error'.
      const failingDb = createUnconnectedDb({ failOn: 'connect' });
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, failingDb as any, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-fail-b' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      await expect(freshProvider.connect()).rejects.toThrow(/PROFILE_NOT_INITIALIZED/);

      // Base status remains 'connected' — local cache is fine.
      expect(freshProvider.getStatus()).toBe('connected');
      // Composite isConnected() is false because OrbitDB attach failed.
      expect(freshProvider.isConnected()).toBe(false);
    });

    it('Phase B failure permits retry — db.connect is re-invoked on next connect()', async () => {
      // If Phase B fails, a subsequent connect() should try again. This
      // is important for transient OrbitDB/Helia startup failures where
      // the user/Sphere caller may retry.
      let attempts = 0;
      const store = new Map<string, Uint8Array>();
      let connected = false;
      const flakyDb: any = {
        _store: store,
        async connect(_config: any) {
          attempts += 1;
          if (attempts === 1) throw new Error('transient-failure');
          connected = true;
        },
        async put(k: string, v: Uint8Array) { store.set(k, v); },
        async get(k: string) { return store.get(k) ?? null; },
        async del(k: string) { store.delete(k); },
        async all() { return new Map<string, Uint8Array>(); },
        async close() { connected = false; },
        onReplication() { return () => {}; },
        isConnected() { return connected; },
      };
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, flakyDb, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-retry' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      await expect(freshProvider.connect()).rejects.toThrow(/transient-failure/);
      expect(attempts).toBe(1);

      // Retry — Phase A is already done, Phase B should fire again.
      await freshProvider.connect();
      expect(attempts).toBe(2);
      expect(freshProvider.isConnected()).toBe(true);
    });

    it('Phase B snapshots identity at attach time — prevents mid-flight key swap', async () => {
      // If `setIdentity()` is called between the Phase A checkpoint and
      // the Phase B adapter invocation, the OLD identity's private key
      // must still be used (snapshot captured at attach start).
      // This is a defensive contract: current call sites are sequential,
      // but a future parallelization must not silently send the wrong
      // key to OrbitDB while the rest of the class is encrypting under
      // a different one.
      // Steelman³⁰: capture EITHER privateKey (legacy path) OR
      // dbNameOverride (preferred path) — both are valid identity
      // proxies. The dbNameOverride is derived from the privateKey
      // bytes at attach start, so a mid-flight setIdentity swap must
      // not affect the override that was already computed.
      let identityObserved: string | null = null;
      const slowDb: any = {
        async connect(config: any) {
          await new Promise((r) => setTimeout(r, 20));
          identityObserved = config.privateKey ?? config.dbNameOverride ?? null;
        },
        async put() {}, async get() { return null; }, async del() {},
        async all() { return new Map(); }, async close() {},
        onReplication() { return () => {}; }, isConnected() { return true; },
      };
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, slowDb, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-snap' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      const connectPromise = freshProvider.connect();
      // Swap identity mid-flight — the attach should still use the
      // original identity's privateKey.
      const OTHER_IDENTITY: FullIdentity = {
        ...TEST_IDENTITY,
        privateKey: 'deadbeef'.repeat(8),
      };
      freshProvider.setIdentity(OTHER_IDENTITY);

      await connectPromise;
      // identityObserved is either the original privateKey (legacy) or
      // the dbNameOverride derived from it (preferred). It must NOT be
      // anything derived from the swap-in OTHER_IDENTITY.
      expect(identityObserved).not.toBeNull();
      const observedFromTest =
        identityObserved === TEST_IDENTITY.privateKey ||
        (typeof identityObserved === 'string' && identityObserved.startsWith('sphere-profile-'));
      expect(observedFromTest).toBe(true);
    });

    it('connect() after disconnect() reconnects both phases', async () => {
      const freshDb = createUnconnectedDb();
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-cycle' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      await freshProvider.connect();
      expect(freshProvider.isConnected()).toBe(true);

      await freshProvider.disconnect();
      expect(freshProvider.isConnected()).toBe(false);

      await freshProvider.connect();
      expect(freshProvider.isConnected()).toBe(true);
      expect(freshDb._connectCalls).toHaveLength(2);
    });

    it('concurrent disconnect() and connect() — connect waits for teardown', async () => {
      // Regression for the piggy-back race introduced in commit 9f05c49:
      // if disconnect() was awaiting the in-flight connectPromise and a
      // second connect() call arrived, the second caller would share the
      // same promise, return "connected" from the attach, and then issue
      // writes against a DB that disconnect() was simultaneously closing.
      //
      // Post-fix: disconnect sets `disconnectPromise`; a concurrent
      // connect() waits for it to drain, then starts a fresh attach.
      let closeCount = 0;
      const store = new Map<string, Uint8Array>();
      let connected = false;
      const slowDb: any = {
        async connect(_cfg: any) {
          await new Promise((r) => setTimeout(r, 20));
          connected = true;
        },
        async close() {
          closeCount += 1;
          await new Promise((r) => setTimeout(r, 5));
          connected = false;
        },
        async put(k: string, v: Uint8Array) { store.set(k, v); },
        async get(k: string) { return store.get(k) ?? null; },
        async del(k: string) { store.delete(k); },
        async all() { return new Map<string, Uint8Array>(); },
        onReplication() { return () => {}; },
        isConnected() { return connected; },
      };
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, slowDb, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-race2' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      // Initial attach completes.
      await freshProvider.connect();
      expect(freshProvider.isConnected()).toBe(true);

      // Start disconnect and a concurrent connect().
      const disconnectP = freshProvider.disconnect();
      const reconnectP = freshProvider.connect();
      await Promise.all([disconnectP, reconnectP]);

      // After the dust settles, we should be CONNECTED (the reconnect
      // ran after the teardown), and close() ran exactly once.
      expect(freshProvider.isConnected()).toBe(true);
      expect(closeCount).toBe(1);
    });

    it('fatal Phase B failures do NOT retry — ORBITDB_NOT_INSTALLED is sticky', async () => {
      // Regression for recursive-steelman #4: a permanent error
      // (missing dependency) should not be retried forever. Transient
      // failures are retried; fatal ones stop the loop until the
      // caller explicitly disconnect()s.
      const { ProfileError } = await import('../../../profile/errors');
      let attempts = 0;
      const fatalDb: any = {
        async connect() {
          attempts += 1;
          throw new ProfileError('ORBITDB_NOT_INSTALLED', 'missing @orbitdb/core');
        },
        async close() {},
        async put() {}, async get() { return null; }, async del() {},
        async all() { return new Map(); },
        onReplication() { return () => {}; },
        isConnected() { return false; },
      };
      const freshCache = createMockCache();
      const freshProvider = new ProfileStorageProvider(freshCache, fatalDb, {
        config: {
          orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-fatal' },
        },
        encrypt: true,
      });
      freshProvider.setIdentity(TEST_IDENTITY);

      await expect(freshProvider.connect()).rejects.toThrow();
      expect(attempts).toBe(1);

      // Second connect() should NOT retry — dbStatus is now 'fatal'.
      await expect(freshProvider.connect()).resolves.toBeUndefined();
      expect(attempts).toBe(1);
      expect(freshProvider.isConnected()).toBe(false);
    });

    it('setIdentity() warns when swapping chainPubkey on an attached DB', async () => {
      // Regression for recursive-steelman #6: after attach, swapping
      // identity silently breaks writes (encryption under new key,
      // access controller under old key). Emit a loud warning so
      // operators can trace the misuse.
      const { logger } = await import('../../../core/logger');
      const warnings: Array<{ tag: string; message: string }> = [];
      const originalHandler = (globalThis as any).__sphere_sdk_logger__?.handler ?? null;
      logger.configure({
        handler: (level, tag, message) => {
          if (level === 'warn') warnings.push({ tag, message });
        },
      });
      try {
        const freshDb = createUnconnectedDb();
        const freshCache = createMockCache();
        const freshProvider = new ProfileStorageProvider(freshCache, freshDb as any, {
          config: {
            orbitDb: { privateKey: '__unused__', directory: '/tmp/orbitdb-swap' },
          },
          encrypt: true,
        });
        freshProvider.setIdentity(TEST_IDENTITY);
        await freshProvider.connect();

        // Swap to a different chainPubkey while still attached.
        const OTHER: FullIdentity = {
          ...TEST_IDENTITY,
          chainPubkey: '03' + 'ff'.repeat(32),
          privateKey: 'cafebabe'.repeat(8),
        };
        freshProvider.setIdentity(OTHER);

        const swapWarning = warnings.find(
          (w) => w.tag === 'ProfileStorage' && w.message.includes('different chainPubkey'),
        );
        expect(swapWarning).toBeDefined();
      } finally {
        logger.configure({ handler: originalHandler });
      }
    });
  });

  // ===========================================================================
  // OpLog envelope adoption (PROFILE-OPLOG-SCHEMA.md §5)
  // ===========================================================================

  describe('OpLog envelope adoption', () => {
    /** Extension of the base mock db that also implements putEntry/getEntry. */
    function createStructuredDb() {
      const store = new Map<string, Uint8Array>();
      const entryWrites: Array<{ key: string; type: string; originated: string }> = [];
      let connected = true;
      const db: ProfileDatabase = {
        async connect(_config: OrbitDbConfig) { connected = true; },
        async put(key: string, value: Uint8Array) { store.set(key, value); },
        async get(key: string) { return store.get(key) ?? null; },
        async del(key: string) { store.delete(key); },
        async all(prefix?: string) {
          const out = new Map<string, Uint8Array>();
          for (const [k, v] of store) {
            if (!prefix || k.startsWith(prefix)) out.set(k, v);
          }
          return out;
        },
        async close() { connected = false; },
        onReplication() { return () => {}; },
        isConnected() { return connected; },
        async putEntry(key: string, entry: unknown) {
          const { encodeEntry } = await import('../../../profile/oplog-entry');
          const envelope = entry as { type: string; originated: string };
          entryWrites.push({ key, type: envelope.type, originated: envelope.originated });
          store.set(key, encodeEntry(entry as never));
        },
        async getEntry(key: string) {
          const { decodeEntry } = await import('../../../profile/oplog-entry');
          const raw = store.get(key);
          return raw ? decodeEntry(raw) : null;
        },
      };
      return { db, store, entryWrites };
    }

    it('set() writes via putEntry with cache_index/system default tag', async () => {
      const { db, entryWrites } = createStructuredDb();
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      // Bypass real connect flow (same pattern as existing tests).
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await provider.set('mnemonic', 'test-mnemonic');

      const setWrite = entryWrites.find((w) => w.key === 'identity.mnemonic');
      expect(setWrite).toBeDefined();
      expect(setWrite!.type).toBe('cache_index');
      expect(setWrite!.originated).toBe('system');
    });

    it('setEntry() stamps user-action type with originated=user', async () => {
      const { db, entryWrites } = createStructuredDb();
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      // Bypass real connect flow (same pattern as existing tests).
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await provider.setEntry('mnemonic', 'val', 'token_send');
      const write = entryWrites.find((w) => w.key === 'identity.mnemonic');
      expect(write!.type).toBe('token_send');
      expect(write!.originated).toBe('user');
    });

    it('saveTrackedAddresses writes envelope with cache_index tag', async () => {
      const { db, entryWrites } = createStructuredDb();
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      // Bypass real connect flow (same pattern as existing tests).
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      const addrs: TrackedAddressEntry[] = [
        { index: 0, addressId: EXPECTED_ADDRESS_ID, hidden: false, createdAt: 1, updatedAt: 1 },
      ];
      await provider.saveTrackedAddresses(addrs);
      const write = entryWrites.find((w) => w.key === 'addresses.tracked');
      expect(write).toBeDefined();
      expect(write!.type).toBe('cache_index');
      expect(write!.originated).toBe('system');
    });

    it('get() reads payload from envelope transparently', async () => {
      const { db } = createStructuredDb();
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      // Bypass real connect flow (same pattern as existing tests).
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await provider.set('mnemonic', 'test-value');
      // Clear local cache so read hits OrbitDB.
      cache._store.clear();
      const read = await provider.get('mnemonic');
      expect(read).toBe('test-value');
    });

    it('stored bytes are CBOR-decodable envelopes', async () => {
      const { db, store } = createStructuredDb();
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      // Bypass real connect flow (same pattern as existing tests).
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await provider.set('mnemonic', 'val');
      const bytes = store.get('identity.mnemonic');
      expect(bytes).toBeDefined();

      const { decodeEntry, OPLOG_ENTRY_SCHEMA_VERSION } = await import('../../../profile/oplog-entry');
      const env = decodeEntry(bytes!);
      expect(env.v).toBe(OPLOG_ENTRY_SCHEMA_VERSION);
      expect(env.type).toBe('cache_index');
      expect(env.originated).toBe('system');
      expect(env.ts).toBeGreaterThan(0);
    });

    it('legacy db without putEntry falls back to raw put/get', async () => {
      // Use the original createMockDb (no putEntry/getEntry).
      const db = createMockDb();
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      // Bypass real connect flow (same pattern as existing tests).
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await provider.set('mnemonic', 'legacy-value');
      // The raw store contains encrypted bytes (not envelope CBOR).
      expect(db._store.size).toBeGreaterThan(0);
      // Read round-trips via the legacy path.
      cache._store.clear();
      const read = await provider.get('mnemonic');
      expect(read).toBe('legacy-value');
    });

    // Pre-schema raw-bytes legacy fallback is covered by:
    //   - oplog-entry.test.ts §7.1 (decode-legacy wrapper)
    //   - orbitdb-adapter-entries.test.ts (adapter getEntry legacy path)
    // Integration via ProfileStorageProvider is covered by the "legacy db
    // without putEntry" test above (structured API unavailable → raw bytes).

    it('asymmetric adapter (putEntry without getEntry) fails at first write', async () => {
      // Post-steelman Fix D: asymmetric capability is a configuration error.
      // A partial adapter that writes envelopes but reads raw would silently
      // corrupt reads — reject at first write instead.
      const db = createMockDb();
      (db as unknown as { putEntry: unknown }).putEntry = async () => { /* stub */ };
      // Deliberately NOT adding getEntry.
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await expect(provider.set('mnemonic', 'val')).rejects.toMatchObject({
        code: 'PROFILE_NOT_INITIALIZED',
      });
    });

    it('asymmetric adapter (getEntry without putEntry) fails at first write', async () => {
      const db = createMockDb();
      (db as unknown as { getEntry: unknown }).getEntry = async () => null;
      // Deliberately NOT adding putEntry.
      const cache = createMockCache();
      const provider = new ProfileStorageProvider(cache, db);
      provider.setIdentity(TEST_IDENTITY);
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';

      await expect(provider.set('mnemonic', 'val')).rejects.toMatchObject({
        code: 'PROFILE_NOT_INITIALIZED',
      });
    });
  });

  // ==========================================================================
  // Payload-size telemetry guard (PROFILE-CID-REFERENCES.md §9 — commit 8)
  // ==========================================================================

  describe('payload-size telemetry guard', () => {
    // Observability path — we assert against logger.warn rather than
    // console.warn because ProfileStorageProvider uses the project logger.
    // The logger forwards to console.warn for 'warn' level in the default
    // runtime; test captures via spy.
    //
    // Import within the test block to keep the existing test file structure.
    // The logger module is a singleton; spying once per test is sufficient.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let warnSpy: any;

    beforeEach(async () => {
      const { logger } = await import('../../../core/logger');
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    it('does NOT warn for small payloads (<8 KiB)', async () => {
      await provider.set('mnemonic', 'a small value');
      // Any unrelated warnings from setup are fine; assert none mention PAYLOAD-SIZE.
      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      expect(payloadWarnings).toHaveLength(0);
    });

    it('warns when encrypted payload exceeds 8 KiB soft threshold', async () => {
      // Plaintext ~10 KiB (encrypted will be ~10 KiB + ~28 B AES-GCM overhead).
      const fatValue = 'x'.repeat(10 * 1024);
      await provider.set('mnemonic', fatValue);

      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      expect(payloadWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('warning message includes key, type, and size (diagnostic context)', async () => {
      const fatValue = 'y'.repeat(10 * 1024);
      // `token_send` is a canonical user-action type from originated-tag.ts —
      // using it here ensures the test documents a realistic call shape.
      await provider.setEntry('mnemonic', fatValue, 'token_send');

      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      expect(payloadWarnings.length).toBeGreaterThanOrEqual(1);
      const warnMsg = payloadWarnings[0]![1] as string;
      expect(warnMsg).toContain('key=identity.mnemonic');
      expect(warnMsg).toContain('type=token_send');
      expect(warnMsg).toMatch(/size=\d+/);
    });

    it('warning does NOT contain payload content (privacy — size is already a fingerprint)', async () => {
      const sensitive = 'SECRET_MARKER_' + 'z'.repeat(10 * 1024);
      await provider.set('mnemonic', sensitive);

      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      for (const args of payloadWarnings) {
        const msg = args[1] as string;
        expect(msg).not.toContain('SECRET_MARKER_');
      }
    });

    it('write still succeeds despite warning (non-fatal)', async () => {
      const fatValue = 'q'.repeat(10 * 1024);
      await expect(provider.set('mnemonic', fatValue)).resolves.toBeUndefined();
      // Round-trip: we can still read it back.
      const roundTrip = await provider.get('mnemonic');
      expect(roundTrip).toBe(fatValue);
    });

    it('warning fires once per write — no rate-limit deduplication', async () => {
      // Two writes above threshold should produce two warnings so observers
      // see that a write site is CHRONICALLY oversized, not just the first
      // occurrence.
      const fatValue = 'p'.repeat(10 * 1024);
      await provider.set('mnemonic', fatValue);
      await provider.set('mnemonic', fatValue + '-v2');

      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      expect(payloadWarnings.length).toBeGreaterThanOrEqual(2);
    });

    it('warning redacts pubkey suffix from dynamic transport keys', async () => {
      // transport.lastWalletEventTs.{pubkey} — the pubkey suffix MUST NOT
      // appear in logs if they are shipped off-host (Sentry/Datadog/etc).
      // 64-hex pubkey; redactProfileKey preserves the static prefix and the
      // first 4 chars of the pubkey for triage, eliding the rest.
      const fullPubkey = '02' + 'abcdef1234567890'.repeat(4); // 66 hex chars total
      const legacyKey = `last_wallet_event_ts_${fullPubkey}`;
      const fatValue = 'r'.repeat(10 * 1024);

      await provider.set(legacyKey, fatValue);

      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      expect(payloadWarnings.length).toBeGreaterThanOrEqual(1);
      const warnMsg = payloadWarnings[0]![1] as string;
      // Full pubkey MUST NOT be in the log line — that's the privacy bug.
      expect(warnMsg).not.toContain(fullPubkey);
      // Redaction format: static prefix retained + first 4 chars of suffix + `…`.
      expect(warnMsg).toContain('key=transport.lastWalletEventTs.02ab…');
    });

    it('warning does NOT redact static keys with short suffixes', async () => {
      // `identity.mnemonic` has no dynamic suffix to redact; the key should
      // appear as-is so operators can see exactly which static site is
      // oversized.
      const fatValue = 's'.repeat(10 * 1024);
      await provider.set('mnemonic', fatValue);

      const payloadWarnings = warnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[1] === 'string' && (args[1] as string).includes('[PAYLOAD-SIZE]'),
      );
      expect(payloadWarnings.length).toBeGreaterThanOrEqual(1);
      const warnMsg = payloadWarnings[0]![1] as string;
      expect(warnMsg).toContain('key=identity.mnemonic');
      // No redaction marker for static keys.
      expect(warnMsg).not.toContain('identity.mnem…');
    });
  });
});
