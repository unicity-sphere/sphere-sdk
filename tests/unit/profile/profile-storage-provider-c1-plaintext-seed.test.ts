/**
 * Tests for Audit #333 C1: plaintext-seed window in encrypt() path.
 *
 * Background
 * ----------
 * Before the C1 fix, `ProfileStorageProvider.encrypt()` returned raw
 * UTF-8 bytes whenever `profileEncryptionKey === null`, even when the
 * provider was configured with `encrypt: true`. The audit's described
 * attack:
 *
 *   - `storage.connect()` runs, attaching OrbitDB (dbConnected → true).
 *   - `setIdentity()` has not been called, so `profileEncryptionKey`
 *     is still null.
 *   - Migration writes the wallet seed: `storage.set('mnemonic', ...)`
 *     → `writeEnvelope()` → `encrypt()` returns plaintext bytes → the
 *     mnemonic lands in OrbitDB → replicates to public IPFS gateways.
 *
 * Fix
 * ---
 *   - `encrypt()` and `decrypt()` now throw `PROFILE_NOT_INITIALIZED`
 *     when `encryptionEnabled === true` but the key has not been
 *     derived. This catches the OrbitDB write path (the only path
 *     that can replicate to IPFS).
 *   - The `localCache.set()` path is unchanged — local storage is
 *     not replicated to IPFS, and `Sphere.create()` legitimately
 *     writes the mnemonic to local cache during Phase A (before
 *     OrbitDB attaches), because the mnemonic is the INPUT to identity
 *     derivation, not derivable from it.
 *
 * These tests assert both halves.
 */

import { describe, it, expect } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { FullIdentity, TrackedAddressEntry } from '../../../types';
import { ProfileStorageProvider } from '../../../profile/profile-storage-provider';

// ---------------------------------------------------------------------------
// Mocks (self-contained — independent of the broader test file so any
// future re-shuffle does not affect this regression surface).
// ---------------------------------------------------------------------------

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  let connected = true;
  return {
    _store: store,
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
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

function createMockCache(): StorageProvider & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  let tracked: TrackedAddressEntry[] = [];
  return {
    id: 'mock-cache',
    name: 'Mock Cache',
    type: 'local' as const,
    description: 'In-memory mock cache',
    _store: store,
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    setIdentity(_id: FullIdentity) {},
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async remove(k: string) { store.delete(k); },
    async has(k: string) { return store.has(k); },
    async keys(prefix?: string) {
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(prefix?: string) {
      if (!prefix) { store.clear(); return; }
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    async saveTrackedAddresses(entries: TrackedAddressEntry[]) { tracked = entries; },
    async loadTrackedAddresses() { return tracked; },
  } as StorageProvider & { _store: Map<string, string> };
}

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

/**
 * Build a provider, mark OrbitDB attached, but do NOT call setIdentity.
 * This is the audit's described dangerous window — the OrbitDB write
 * path is reachable but no encryption key exists.
 */
function buildDangerWindowProvider(opts?: { encrypt?: boolean }): {
  provider: ProfileStorageProvider;
  db: ReturnType<typeof createMockDb>;
  cache: ReturnType<typeof createMockCache>;
} {
  const db = createMockDb();
  const cache = createMockCache();
  const provider = new ProfileStorageProvider(cache, db, {
    config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
    encrypt: opts?.encrypt ?? true,
  });
  // Mirror the live state: OrbitDB attached, identity not yet wired.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).dbStatus = 'attached';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).status = 'connected';
  return { provider, db, cache };
}

/**
 * Build a provider in Phase A state: localCache attached, OrbitDB NOT
 * attached because identity has not been derived yet. This is the
 * exact state `Sphere.create()` exercises between `storage.connect()`
 * and `setIdentity()` — where the mnemonic must be writable to local
 * cache as the input to identity derivation.
 */
function buildPhaseAProvider(opts?: { encrypt?: boolean }): {
  provider: ProfileStorageProvider;
  db: ReturnType<typeof createMockDb>;
  cache: ReturnType<typeof createMockCache>;
} {
  const db = createMockDb();
  const cache = createMockCache();
  const provider = new ProfileStorageProvider(cache, db, {
    config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
    encrypt: opts?.encrypt ?? true,
  });
  // No dbStatus override — provider starts at pre-attach (`disconnected`
  // / `connecting`). The internal `dbConnected` getter returns false.
  return { provider, db, cache };
}

describe('Audit #333 C1 — plaintext-seed window', () => {
  // -------------------------------------------------------------------------
  // Phase A — legitimate Sphere.create flow (mnemonic is the INPUT to
  // identity derivation; it MUST be writable before setIdentity)
  // -------------------------------------------------------------------------

  describe('Phase A — set(mnemonic) before setIdentity, OrbitDB not yet attached', () => {
    it('writes the mnemonic to local cache only (no OrbitDB replication path)', async () => {
      const { provider, db, cache } = buildPhaseAProvider();
      await provider.set('mnemonic', 'twelve word phrase');
      // localCache received the mnemonic — this is the legacy /
      // production behaviour; the wallet has always persisted the
      // seed locally as the input to identity derivation.
      expect(cache._store.get('mnemonic')).toBe('twelve word phrase');
      // OrbitDB is NOT attached → no replication-to-IPFS path was
      // exercised. The mnemonic never enters the path that the audit
      // is concerned about.
      expect(db._store.size).toBe(0);
    });

    it('subsequent setIdentity + writes work normally (full Sphere.create end-to-end)', async () => {
      const { provider, db, cache } = buildPhaseAProvider();
      // Phase A: write mnemonic (the input).
      await provider.set('mnemonic', 'twelve word phrase');
      // Derive identity from mnemonic, attach the encryption key.
      provider.setIdentity(TEST_IDENTITY);
      // Mark OrbitDB attached (simulating Phase B's connect re-entry).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).dbStatus = 'attached';
      // Subsequent writes now hit the OrbitDB-encrypted path normally.
      await provider.set('wallet_exists', 'true');
      const stored = db._store.get('wallet_exists');
      expect(stored).toBeDefined();
      // Encrypted — wire bytes do not match the UTF-8 plaintext.
      expect(new TextDecoder().decode(stored!)).not.toBe('true');
    });
  });

  // -------------------------------------------------------------------------
  // The encrypt()/decrypt() backstop — the actual C1 defense.
  // -------------------------------------------------------------------------

  describe('encrypt()/decrypt() backstop closes the audit\'s described attack window', () => {
    it('encrypt() throws when OrbitDB is attached AND profileEncryptionKey is null', async () => {
      const { provider, cache } = buildDangerWindowProvider();
      // Drive the OrbitDB write path via a non-identity, non-cache-only
      // key. `wallet_exists` routes through writeEnvelope → encrypt.
      await expect(provider.set('wallet_exists', 'true'))
        .rejects.toMatchObject({ code: 'PROFILE_NOT_INITIALIZED' });
      // The localCache write happens BEFORE encrypt() is called — that
      // is acceptable per the Phase A rationale (local storage is not
      // a replication surface). What matters is that nothing reached
      // OrbitDB.
      expect(cache._store.get('wallet_exists')).toBe('true');
    });

    it('identity-class writes in the danger window never reach OrbitDB (cache-only short-circuit precedes encrypt())', async () => {
      // Post IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS: identity writes resolve
      // to localCache only, so `encrypt()` is never invoked and `set()`
      // does not throw. The OrbitDB store stays empty regardless.
      const { provider, db, cache } = buildDangerWindowProvider();
      await provider.set('mnemonic', 'plaintext-seed-bytes');
      expect(cache._store.get('mnemonic')).toBe('plaintext-seed-bytes');
      expect(db._store.size).toBe(0);
    });

    it('encrypt() does NOT throw when encryption is explicitly disabled (test mode)', async () => {
      const { provider, db } = buildDangerWindowProvider({ encrypt: false });
      // With encryption disabled, raw UTF-8 is written. (No
      // setIdentity — encrypt: false short-circuits the key
      // requirement.)
      await provider.set('wallet_exists', 'true');
      expect(db._store.get('wallet_exists')).toBeDefined();
    });

    it('decrypt() throws when encryptionEnabled and profileEncryptionKey is null', async () => {
      const { provider, db } = buildDangerWindowProvider();
      // Plant a ciphertext-shaped entry directly in OrbitDB so a get()
      // attempt has to call decrypt().
      db._store.set('wallet_exists', new Uint8Array([0xaa, 0xbb, 0xcc]));
      await expect(provider.get('wallet_exists'))
        .rejects.toMatchObject({ code: 'PROFILE_NOT_INITIALIZED' });
    });

    it('after setIdentity, identity-class writes STILL never reach OrbitDB (cache-only)', async () => {
      // Post-IDENTITY_KEYS-cache-only fix: even with a valid encryption
      // key, `mnemonic` / `master_key` / etc. are cache-only by the
      // `CACHE_ONLY_KEYS` set in profile/types.ts. The set() short-
      // circuits at the localCache step. This closes the seed-leak
      // window completely — encrypt()-throw was only a Phase-A defense.
      const { provider, db, cache } = buildDangerWindowProvider();
      provider.setIdentity(TEST_IDENTITY);
      await provider.set('mnemonic', 'abandon abandon abandon');
      expect(cache._store.get('mnemonic')).toBe('abandon abandon abandon');
      // No OrbitDB entry at any identity.* key.
      expect(db._store.get('identity.mnemonic')).toBeUndefined();
      expect([...db._store.keys()].filter((k) => k.startsWith('identity.'))).toEqual([]);
    });

    it('after setIdentity, non-identity writes still land ENCRYPTED in OrbitDB (control)', async () => {
      // Sanity: the cache-only routing is scoped to IDENTITY_KEYS, not
      // a side effect of any other refactor. A non-identity key like
      // `address_nametags` still flows through writeEnvelope→encrypt.
      const { provider, db } = buildDangerWindowProvider();
      provider.setIdentity(TEST_IDENTITY);
      await provider.set('address_nametags', '{"a":1}');
      const stored = db._store.get('addresses.nametags');
      expect(stored).toBeDefined();
      expect(new TextDecoder().decode(stored!)).not.toBe('{"a":1}');
    });
  });

  // -------------------------------------------------------------------------
  // Boot-order regression — the actual leak the audit found is closed
  // -------------------------------------------------------------------------

  describe('boot-order regression — IPFS replication leak is closed', () => {
    it('the audit\'s scenario (OrbitDB attached + no setIdentity + set mnemonic) is blocked by the cache-only routing; post-setIdentity it is STILL blocked', async () => {
      // Pre-fix the encrypt() fallback returned raw UTF-8 bytes and the
      // mnemonic landed in OrbitDB. The C1 fix made encrypt() throw in
      // the danger window; this present fix (IDENTITY_KEYS ⊂
      // CACHE_ONLY_KEYS) makes the cache-only routing skip OrbitDB
      // *entirely* — both before and after a valid encryption key is
      // attached.
      const { provider, db } = buildDangerWindowProvider();
      await provider.set('mnemonic', 'twelve word phrase');
      expect([...db._store.keys()]).not.toContain('identity.mnemonic');
      expect(db._store.size).toBe(0);

      // Post-setIdentity: the seed STILL never lands in OrbitDB.
      provider.setIdentity(TEST_IDENTITY);
      await provider.set('mnemonic', 'twelve word phrase v2');
      expect(db._store.get('identity.mnemonic')).toBeUndefined();
      expect([...db._store.keys()].filter((k) => k.startsWith('identity.'))).toEqual([]);
    });

    it('the legitimate Sphere.create flow (Phase A → setIdentity → Phase B) WORKS end-to-end', async () => {
      // Pre-fix-fix the over-strict set() gate broke this flow. The
      // mnemonic is the INPUT to identity derivation — it MUST be
      // writable to local cache before setIdentity.
      const { provider, db, cache } = buildPhaseAProvider();

      // Phase A — provider connected, identity not yet derived.
      // The wallet stores the mnemonic locally so identity derivation
      // can read it on the next boot.
      await provider.set('mnemonic', 'abandon abandon abandon');
      expect(cache._store.get('mnemonic')).toBe('abandon abandon abandon');

      // Identity derived from the mnemonic — Phase B can now proceed.
      provider.setIdentity(TEST_IDENTITY);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).dbStatus = 'attached';

      // Subsequent writes hit OrbitDB encrypted.
      await provider.set('wallet_exists', 'true');
      const walletExists = db._store.get('wallet_exists');
      expect(walletExists).toBeDefined();
      expect(new TextDecoder().decode(walletExists!)).not.toBe('true');
    });
  });
});
