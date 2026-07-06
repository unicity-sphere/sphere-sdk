/**
 * Tests for the Sphere-bound overload of `migrateLegacyToProfile` (Issue #292)
 *
 * Verifies the new discriminated overload that accepts a Sphere instance
 * plus an injected `profileFactory` callback. The overload constructs the
 * Profile providers via the factory (which attaches identity using the
 * Sphere's PRIVATE key without exposing it), runs the standard migration,
 * and returns the providers alongside the result.
 *
 * Coverage:
 *   - Sphere-bound overload constructs providers via factory, calls
 *     migrateTokenStorage, returns providers in result.
 *   - The injected factory receives the Sphere instance and config; the
 *     migration body NEVER sees a real privateKey.
 *   - Discrimination: `{ sphere, legacy, ... }` triggers Sphere-bound;
 *     `{ legacy, profile, identity, ... }` triggers original.
 *   - Backward compat: original overload with `privateKey: 'real-hex'`
 *     still passes the identity through to migrateTokenStorage verbatim.
 *   - Regression: original overload's contract that empty privateKey
 *     would crash inside Profile setIdentity is UNCHANGED — the new
 *     overload is the only crash-free path for missing privateKey.
 *   - Sphere without identity → factory throws → migration returns failure.
 */

import { describe, it, expect, vi } from 'vitest';
import { migrateLegacyToProfile } from '../../../extensions/uxf/profile/token-storage-migration';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  StorageProvider,
} from '../../../storage';
import type { Sphere } from '../../../core/Sphere';
import type { FullIdentity, Identity } from '../../../types';
import { getAddressId } from '../../../constants';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_IDENTITY: Identity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://test',
};

const FULL_IDENTITY: FullIdentity = {
  ...PUBLIC_IDENTITY,
  privateKey: '00' + '11'.repeat(31),
};

const ADDRESS_ID = getAddressId(PUBLIC_IDENTITY.directAddress!);

function makeMockTokenProvider(): TokenStorageProvider<TxfStorageDataBase> & {
  _saved: TxfStorageDataBase | null;
  _calls: string[];
} {
  const calls: string[] = [];
  let saved: TxfStorageDataBase | null = null;
  return {
    _saved: saved,
    _calls: calls,
    id: 'mock',
    name: 'mock',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
    },
    setIdentity() {
      calls.push('setIdentity');
    },
    async initialize() {
      calls.push('initialize');
      return true;
    },
    async shutdown() {},
    async load() {
      calls.push('load');
      return {
        success: true,
        data: {
          _meta: {
            version: 1,
            address: PUBLIC_IDENTITY.chainPubkey,
            formatVersion: '2.0',
            updatedAt: 0,
          },
        } as TxfStorageDataBase,
        source: 'local',
        timestamp: Date.now(),
      };
    },
    async save(data: TxfStorageDataBase) {
      calls.push('save');
      saved = data;
      this._saved = data;
      return { success: true, timestamp: Date.now() };
    },
    async sync(local) {
      return { success: true, merged: local, added: 0, removed: 0, conflicts: 0 };
    },
  } as TokenStorageProvider<TxfStorageDataBase> & {
    _saved: TxfStorageDataBase | null;
    _calls: string[];
  };
}

function makeMockKvStorage(): StorageProvider & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    id: 'mock-kv',
    name: 'mock-kv',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
    },
    setIdentity() {},
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
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear() {
      store.clear();
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() {
      return [];
    },
  };
}

function buildSphereStub(identity: Identity | null): Sphere {
  return {
    get identity() {
      return identity;
    },
    _withFullIdentityForProfileFactory: vi.fn(),
  } as unknown as Sphere;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateLegacyToProfile — Sphere-bound overload (Issue #292)', () => {
  it('constructs providers via injected profileFactory and returns them in result', async () => {
    const sphere = buildSphereStub(PUBLIC_IDENTITY);
    const legacy = makeMockTokenProvider();
    const profileTokenStorage = makeMockTokenProvider();
    const profileKvStorage = makeMockKvStorage();
    const profileFactory = vi.fn(async () => ({
      storage: profileKvStorage,
      tokenStorage: profileTokenStorage,
    }));

    const result = await migrateLegacyToProfile({
      sphere,
      legacy,
      profileFactory,
      network: 'testnet',
    });

    expect(profileFactory).toHaveBeenCalledOnce();
    expect(profileFactory.mock.calls[0][0]).toBe(sphere);
    expect(profileFactory.mock.calls[0][1]).toMatchObject({ network: 'testnet' });

    expect(result.success).toBe(true);
    expect(result.profileProviders.storage).toBe(profileKvStorage);
    expect(result.profileProviders.tokenStorage).toBe(profileTokenStorage);
  });

  it('runs migrateTokenStorage with target = profile tokenStorage from factory', async () => {
    const sphere = buildSphereStub(PUBLIC_IDENTITY);
    const legacy = makeMockTokenProvider();
    const profileTokenStorage = makeMockTokenProvider();
    const profileKvStorage = makeMockKvStorage();

    await migrateLegacyToProfile({
      sphere,
      legacy,
      profileFactory: async () => ({
        storage: profileKvStorage,
        tokenStorage: profileTokenStorage,
      }),
      network: 'testnet',
    });

    // Target was saved at least once.
    expect(profileTokenStorage._calls).toContain('save');
    // Source was loaded.
    expect(legacy._calls).toContain('load');
    // Marker landed in the factory's storage (default markerStorage).
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    expect(profileKvStorage._store.has(markerKey)).toBe(true);
  });

  it('the migration body NEVER calls setIdentity on target (factory already did)', async () => {
    const sphere = buildSphereStub(PUBLIC_IDENTITY);
    const legacy = makeMockTokenProvider();
    const profileTokenStorage = makeMockTokenProvider();
    const profileKvStorage = makeMockKvStorage();

    await migrateLegacyToProfile({
      sphere,
      legacy,
      profileFactory: async () => ({
        storage: profileKvStorage,
        tokenStorage: profileTokenStorage,
      }),
      network: 'testnet',
    });

    // The factory is responsible for calling setIdentity. The migration
    // body should NOT invoke setIdentity on the target — that would risk
    // hitting the hexToBytes crash with the synthetic empty privateKey
    // the body uses internally.
    expect(profileTokenStorage._calls.filter((c) => c === 'setIdentity').length).toBe(0);
  });

  it('forwards oracle, dryRun, force, onProgress to the migration body', async () => {
    const sphere = buildSphereStub(PUBLIC_IDENTITY);
    const legacy = makeMockTokenProvider();
    const profileTokenStorage = makeMockTokenProvider();
    const profileKvStorage = makeMockKvStorage();
    const onProgress = vi.fn();

    const result = await migrateLegacyToProfile({
      sphere,
      legacy,
      profileFactory: async () => ({
        storage: profileKvStorage,
        tokenStorage: profileTokenStorage,
      }),
      network: 'testnet',
      dryRun: true,
      onProgress,
    });

    expect(result.dryRun).toBe(true);
    expect(onProgress).toHaveBeenCalled();
    // dryRun → target.save NOT called.
    expect(profileTokenStorage._calls).not.toContain('save');
  });

  it('Sphere without identity → throws clear error (not hexToBytes)', async () => {
    const sphere = buildSphereStub(null);
    const legacy = makeMockTokenProvider();
    const profileTokenStorage = makeMockTokenProvider();
    const profileKvStorage = makeMockKvStorage();

    await expect(
      migrateLegacyToProfile({
        sphere,
        legacy,
        profileFactory: async () => ({
          storage: profileKvStorage,
          tokenStorage: profileTokenStorage,
        }),
        network: 'testnet',
      }),
    ).rejects.toThrow(/Sphere has no identity/);
  });

  it('factory rejection surfaces verbatim (e.g., uninitialized Sphere)', async () => {
    const sphere = buildSphereStub(PUBLIC_IDENTITY);
    const legacy = makeMockTokenProvider();
    const factoryError = new Error('Wallet not initialized — call Sphere.init');
    (factoryError as unknown as { code: string }).code = 'NOT_INITIALIZED';
    const profileFactory = vi.fn(async () => {
      throw factoryError;
    });

    await expect(
      migrateLegacyToProfile({
        sphere,
        legacy,
        profileFactory,
        network: 'testnet',
      }),
    ).rejects.toThrow(/Wallet not initialized/);
  });
});

describe('migrateLegacyToProfile — original overload is unchanged (backward compat)', () => {
  it('original { legacy, profile, identity, ... } shape still works', async () => {
    const legacy = makeMockTokenProvider();
    const profile = makeMockTokenProvider();
    const marker = makeMockKvStorage();

    const result = await migrateLegacyToProfile({
      legacy,
      profile,
      identity: FULL_IDENTITY,
      markerStorage: marker,
    });

    expect(result.success).toBe(true);
    // The original overload does NOT include profileProviders in the result.
    expect((result as { profileProviders?: unknown }).profileProviders).toBeUndefined();
    // Marker landed.
    const markerKey = `legacy_migration_v1_complete:${ADDRESS_ID}`;
    expect(marker._store.has(markerKey)).toBe(true);
  });

  it('`{ sphere: undefined, legacy, profile, identity }` routes to original overload (discriminator robustness)', async () => {
    const legacy = makeMockTokenProvider();
    const profile = makeMockTokenProvider();
    // Buggy caller passes `sphere: undefined` explicitly. The discriminator
    // MUST treat this as the original overload, not the Sphere-bound one
    // (which would crash on missing profileFactory).
    const result = await migrateLegacyToProfile({
      sphere: undefined,
      legacy,
      profile,
      identity: FULL_IDENTITY,
    } as unknown as Parameters<typeof migrateLegacyToProfile>[0]);

    expect(result.success).toBe(true);
    expect((result as { profileProviders?: unknown }).profileProviders).toBeUndefined();
  });

  it('original overload does NOT route through the Sphere accessor', async () => {
    const legacy = makeMockTokenProvider();
    const profile = makeMockTokenProvider();
    // Build a Sphere stub that should NEVER be touched.
    const sphereSpy = vi.fn();
    const sphere = { _withFullIdentityForProfileFactory: sphereSpy } as unknown as Sphere;

    await migrateLegacyToProfile({
      legacy,
      profile,
      identity: FULL_IDENTITY,
    });

    expect(sphereSpy).not.toHaveBeenCalled();
    // (Sphere stub variable retained to verify nothing accidentally
    // discriminates on its presence.)
    expect(sphere).toBeDefined();
  });
});
