/**
 * Tests for the IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS routing in
 * `ProfileStorageProvider.set`.
 *
 * Background
 * ----------
 * The pre-fix C1 defense was an `encrypt()` throw in
 * `writeEnvelope`: when `encryptionEnabled === true` but no encryption
 * key has been derived yet (Phase A, pre-setIdentity), the OrbitDB
 * write is rejected. After setIdentity, however, identity keys
 * (`mnemonic`, `master_key`, `chain_code`, `derivation_path`, ...)
 * would be encrypted and written to OrbitDB → replicated to IPFS via
 * the snapshot CAR pin path. Even encrypted, this lowers the threat
 * model from "attacker must compromise the device" to "attacker must
 * brute-force a password against an IPFS-pinned ciphertext", which is
 * a strictly weaker guarantee than what users expect of seed material.
 *
 * Fix
 * ---
 * Add the legacy identity keys to `CACHE_ONLY_KEYS` (via the new
 * `IDENTITY_KEYS` set in `profile/types.ts`). `translateKey()` returns
 * `cacheOnly: true` for them; `set()` short-circuits at the localCache
 * step and never reaches `writeEnvelope`. A defense-in-depth assertion
 * in `set()` fail-closes if any future refactor adds an `identity.*`
 * Profile key without also putting its legacy alias into
 * `CACHE_ONLY_KEYS`.
 */

import { describe, it, expect } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import {
  IDENTITY_KEYS,
  CACHE_ONLY_KEYS,
  PROFILE_KEY_MAPPING,
} from '../../../profile/types';
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
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
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
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity(_id: FullIdentity) {},
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
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(prefix?: string) {
      if (!prefix) {
        store.clear();
        return;
      }
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    async saveTrackedAddresses(entries: TrackedAddressEntry[]) {
      tracked = entries;
    },
    async loadTrackedAddresses() {
      return tracked;
    },
  } as StorageProvider & { _store: Map<string, string> };
}

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

function buildPostIdentityProvider(opts?: { encrypt?: boolean }) {
  const db = createMockDb();
  const cache = createMockCache();
  const provider = new ProfileStorageProvider(cache, db, {
    config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
    encrypt: opts?.encrypt ?? true,
  });
  provider.setIdentity(TEST_IDENTITY);
  // Mark OrbitDB attached — this is the dangerous post-Phase-A state
  // where the older `encrypt()` defense no longer fires.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).dbStatus = 'attached';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).status = 'connected';
  return { provider, db, cache };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS — seed material never reaches OrbitDB', () => {
  it('IDENTITY_KEYS contract: every identity key is also in CACHE_ONLY_KEYS', () => {
    for (const key of IDENTITY_KEYS) {
      expect(CACHE_ONLY_KEYS.has(key)).toBe(true);
    }
  });

  it('IDENTITY_KEYS contract: covers every legacy → Profile `identity.*` mapping', () => {
    // If a new identity-shaped Profile key is added to PROFILE_KEY_MAPPING
    // without updating IDENTITY_KEYS / CACHE_ONLY_KEYS, this test fails
    // immediately — the contract that the seed never leaves the device
    // is enforced at the schema level, not just the runtime.
    const identityLegacyKeys = Object.entries(
      PROFILE_KEY_MAPPING as Record<string, { profileKey: string }>,
    )
      .filter(([, v]) => v.profileKey.startsWith('identity.'))
      .map(([k]) => k);
    for (const k of identityLegacyKeys) {
      expect(
        IDENTITY_KEYS.has(k),
        `Legacy key "${k}" maps to "${
          (PROFILE_KEY_MAPPING as Record<string, { profileKey: string }>)[k].profileKey
        }" (identity.*) but is missing from IDENTITY_KEYS — this would allow seed material to be replicated via OrbitDB. Add it to IDENTITY_KEYS and CACHE_ONLY_KEYS in profile/types.ts.`,
      ).toBe(true);
    }
  });

  it.each([
    'mnemonic',
    'master_key',
    'chain_code',
    'derivation_path',
    'base_path',
    'derivation_mode',
    'wallet_source',
    'current_address_index',
  ])(
    'set("%s", ...) writes to localCache only — OrbitDB stays empty',
    async (legacyKey) => {
      const { provider, db, cache } = buildPostIdentityProvider();
      await provider.set(legacyKey, 'sensitive-seed-material');
      // localCache populated under the legacy key (where the consumer
      // — Sphere.loadIdentityFromStorage — looks for it).
      expect(cache._store.get(legacyKey)).toBe('sensitive-seed-material');
      // OrbitDB completely untouched.
      expect(db._store.size).toBe(0);
      expect([...db._store.keys()].filter((k) => k.startsWith('identity.'))).toEqual(
        [],
      );
    },
  );

  it('round-trip: identity write + read returns the original value via localCache', async () => {
    const { provider, db } = buildPostIdentityProvider();
    await provider.set('master_key', 'encrypted-master-bytes-hex');
    const fetched = await provider.get('master_key');
    expect(fetched).toBe('encrypted-master-bytes-hex');
    // And still no OrbitDB write.
    expect(db._store.size).toBe(0);
  });

  it('defense-in-depth: a synthetic identity.* write rejected with a clear error', async () => {
    // Drive the post-translation assertion by calling set() with a key
    // that has no entry in PROFILE_KEY_MAPPING and translates verbatim
    // to a synthetic `identity.*` profileKey. This simulates a future
    // refactor where someone introduces a new identity field but forgets
    // to update CACHE_ONLY_KEYS.
    const { provider } = buildPostIdentityProvider();
    await expect(provider.set('identity.someNewSecret', 'value')).rejects.toThrow(
      /Refusing to write identity-shaped Profile key/i,
    );
  });

  it('control: non-identity write still flows through writeEnvelope to OrbitDB', async () => {
    const { provider, db } = buildPostIdentityProvider();
    await provider.set('address_nametags', '{"alice":1}');
    // The mapped profile key is `addresses.nametags`. Verify it is
    // present in OrbitDB and that the wire bytes are ciphertext, not
    // the raw UTF-8 payload.
    const wire = db._store.get('addresses.nametags');
    expect(wire).toBeDefined();
    expect(new TextDecoder().decode(wire!)).not.toBe('{"alice":1}');
  });
});
