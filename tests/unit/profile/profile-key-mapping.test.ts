/**
 * Tests for profile/types.ts PROFILE_KEY_MAPPING.
 *
 * Covers T.1.E acceptance:
 *   - PROFILE_KEY_MAPPING exports `audit`, `invalid` (multi-rep), and
 *     `finalizationQueue`.
 *   - Each is declared as a per-address dynamic entry with profile-key
 *     form `{addr}.<name>`.
 *   - The legacy `invalidTokens` entry is retained for one-way migration
 *     (back-compat).
 *   - Round-trip translation works for the new entries via the matcher
 *     in profile-storage-provider.ts.
 *
 * @see docs/uxf/UXF-TRANSFER-IMPL-PLAN.md §T.1.E
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PROFILE_KEY_MAPPING } from '../../../extensions/uxf/profile/types';
import type { ProfileDatabase, OrbitDbConfig } from '../../../extensions/uxf/profile/types';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { FullIdentity, TrackedAddressEntry } from '../../../types';
import { ProfileStorageProvider } from '../../../extensions/uxf/profile/profile-storage-provider';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const ADDR = 'DIRECT_aabbcc_ddeeff';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

function createMockCache(): StorageProvider & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  let trackedAddresses: TrackedAddressEntry[] = [];
  return {
    id: 'mock-cache',
    name: 'Mock Cache',
    type: 'local' as const,
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity() {},
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
    },
    async remove(k: string) {
      store.delete(k);
    },
    async has(k: string) {
      return store.has(k);
    },
    async keys(prefix?: string) {
      const all = Array.from(store.keys());
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
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
  } as StorageProvider & { _store: Map<string, string> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PROFILE_KEY_MAPPING — T.1.E entries', () => {
  // -------------------------------------------------------------------------
  // Schema declarations
  // -------------------------------------------------------------------------

  describe('schema declarations', () => {
    it('declares `audit` as per-address dynamic with profile-key {addr}.audit', () => {
      expect(PROFILE_KEY_MAPPING['audit']).toBeDefined();
      expect(PROFILE_KEY_MAPPING['audit']).toEqual({
        profileKey: '{addr}.audit',
        dynamic: true,
      });
    });

    it('declares `invalid` (multi-rep) as per-address dynamic with profile-key {addr}.invalid', () => {
      expect(PROFILE_KEY_MAPPING['invalid']).toBeDefined();
      expect(PROFILE_KEY_MAPPING['invalid']).toEqual({
        profileKey: '{addr}.invalid',
        dynamic: true,
      });
    });

    it('declares `finalizationQueue` as per-address dynamic with profile-key {addr}.finalizationQueue', () => {
      expect(PROFILE_KEY_MAPPING['finalizationQueue']).toBeDefined();
      expect(PROFILE_KEY_MAPPING['finalizationQueue']).toEqual({
        profileKey: '{addr}.finalizationQueue',
        dynamic: true,
      });
    });

    it('retains legacy `invalidTokens` for one-way migration window', () => {
      // The legacy entry MUST coexist with the new `invalid` entry until
      // T.8.D removes the migration path entirely.
      expect(PROFILE_KEY_MAPPING['invalidTokens']).toBeDefined();
      expect(PROFILE_KEY_MAPPING['invalidTokens']).toEqual({
        profileKey: '{addr}.invalidTokens',
        dynamic: true,
      });
    });

    it('coexistence: `invalid` and `invalidTokens` are distinct entries', () => {
      expect(PROFILE_KEY_MAPPING['invalid']).not.toEqual(
        PROFILE_KEY_MAPPING['invalidTokens'],
      );
      expect(PROFILE_KEY_MAPPING['invalid'].profileKey).not.toBe(
        PROFILE_KEY_MAPPING['invalidTokens'].profileKey,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip translation through ProfileStorageProvider
  // -------------------------------------------------------------------------

  describe('round-trip translation', () => {
    let db: ReturnType<typeof createMockDb>;
    let cache: ReturnType<typeof createMockCache>;
    let provider: ProfileStorageProvider;

    beforeEach(() => {
      db = createMockDb();
      cache = createMockCache();
      provider = new ProfileStorageProvider(cache, db, {
        config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
        encrypt: false, // simplify tests; bypass crypto
      });
      provider.setIdentity(TEST_IDENTITY);
      // Mark connected (avoid full Phase B path which needs real OrbitDB)
      (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
      (provider as unknown as { status: string }).status = 'connected';
    });

    it("legacy 'audit' (without prefix) translates to '{addr}.audit'", async () => {
      await provider.set('audit', 'test-value');
      expect(db._store.has(`${ADDR}.audit`)).toBe(true);
    });

    it("legacy 'invalid' (without prefix) translates to '{addr}.invalid'", async () => {
      await provider.set('invalid', 'test-value');
      expect(db._store.has(`${ADDR}.invalid`)).toBe(true);
    });

    it("legacy 'finalizationQueue' (without prefix) translates to '{addr}.finalizationQueue'", async () => {
      await provider.set('finalizationQueue', 'test-value');
      expect(db._store.has(`${ADDR}.finalizationQueue`)).toBe(true);
    });

    it('explicit-prefix audit key translates correctly', async () => {
      await provider.set(`${ADDR}_audit`, 'test-value');
      expect(db._store.has(`${ADDR}.audit`)).toBe(true);
    });

    it('explicit-prefix invalid key translates correctly', async () => {
      await provider.set(`${ADDR}_invalid`, 'test-value');
      expect(db._store.has(`${ADDR}.invalid`)).toBe(true);
    });

    it('explicit-prefix finalizationQueue key translates correctly', async () => {
      await provider.set(`${ADDR}_finalizationQueue`, 'test-value');
      expect(db._store.has(`${ADDR}.finalizationQueue`)).toBe(true);
    });

    it('legacy invalidTokens still translates (back-compat)', async () => {
      await provider.set(`${ADDR}_invalidTokens`, 'legacy-blob');
      expect(db._store.has(`${ADDR}.invalidTokens`)).toBe(true);
    });

    it('audit value can be read back via get()', async () => {
      await provider.set('audit', 'round-trip-value');
      const result = await provider.get('audit');
      expect(result).toBe('round-trip-value');
    });

    it('invalid value can be read back via get()', async () => {
      await provider.set('invalid', 'round-trip-value');
      const result = await provider.get('invalid');
      expect(result).toBe('round-trip-value');
    });

    it('finalizationQueue value can be read back via get()', async () => {
      await provider.set('finalizationQueue', 'round-trip-value');
      const result = await provider.get('finalizationQueue');
      expect(result).toBe('round-trip-value');
    });

    it('keys() returns the new entries in legacy form (reverse-mapping)', async () => {
      await provider.set('audit', 'a');
      await provider.set('invalid', 'i');
      await provider.set('finalizationQueue', 'f');
      const allKeys = await provider.keys();
      // Reverse-mapping uses underscore-form for per-address keys.
      expect(allKeys).toContain(`${ADDR}_audit`);
      expect(allKeys).toContain(`${ADDR}_invalid`);
      expect(allKeys).toContain(`${ADDR}_finalizationQueue`);
    });
  });
});
