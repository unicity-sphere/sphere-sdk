/**
 * Tests for LifecycleManager.initialize() resilience against a
 * partially-corrupted OrbitDB.
 *
 * Reported live failure mode (sphere.telco "Migrate Legacy → UXF"):
 *
 *   A previous failed migration attempt wrote a marker entry whose IPFS
 *   payload block was never durably pinned anywhere (gateway dropped /
 *   provider crashed mid-flush). When the next attempt's
 *   `attachIdentityToProfileProviders` ran the new factory-side
 *   `await providers.storage.connect()` + `await tokenStorage.initialize()`
 *   chain, `bundleIndex.refreshKnownBundles()` invoked `db.all()` which
 *   tried to load the unreachable OpLog block, threw a
 *   `[PROFILE:ORBITDB_READ_FAILED] Failed to load block for bafy…` error.
 *   The outer catch in `LifecycleManager.initialize` caught the throw and
 *   returned `false` WITHOUT calling `setInitialized(true)`. The provider
 *   was then permanently `initialized=false` for the session, and every
 *   subsequent `target.save(data)` rejected with
 *   `{ success: false, error: 'Provider not initialized' }`.
 *
 *   The migration's `target-save` phase saw the rejection and aborted.
 *   The wallet was unmigrable until the user manually cleared their
 *   Profile IndexedDB.
 *
 * Fix: wrap `refreshKnownBundles()` in its own try/catch inside
 * `initialize()`. Log a warning, reset the known-bundle set to empty,
 * and proceed. The downstream `if (knownBundleCids.size === 0)` cold-
 * start recovery branch then re-imports state from the aggregator
 * pointer layer / legacy IPNS path; the recovery's first successful
 * `addBundle()` write inserts a fresh OpLog entry whose block IS
 * reachable, and future reads of that key no longer need to resolve
 * the corrupt historical entry.
 *
 * What this test pins:
 *
 *   1. `initialize()` returns `true` even when `db.all()` (and therefore
 *      `refreshKnownBundles()`) throws.
 *   2. The provider's `initialized` flag IS set to `true`, so subsequent
 *      `save()` calls reach the flush pipeline instead of returning
 *      `'Provider not initialized'`.
 *   3. `knownBundleCids` is empty after the tolerant fallback (regardless
 *      of whether the partial walk had added anything before throwing).
 *   4. `save()` after a tolerant `initialize()` does NOT short-circuit on
 *      the initialized check.
 *
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/239
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

/**
 * Mock OrbitDB whose `all()` throws a ProfileError-shaped rejection
 * mirroring the user's reported failure mode (an unreachable IPFS
 * payload block referenced by an OpLog entry).
 */
function createCorruptDb(): ProfileDatabase & { allCallCount: number } {
  const store = new Map<string, Uint8Array>();
  let allCallCount = 0;
  const db: ProfileDatabase & { allCallCount: number } = {
    get allCallCount() { return allCallCount; },
    async connect(_config: OrbitDbConfig) {},
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(_prefix?: string) {
      allCallCount += 1;
      const err = new Error(
        '[PROFILE:ORBITDB_READ_FAILED] Failed to read key ' +
          '"tokens.bundle.bafyreid…": Failed to load block for ' +
          'bafyreid2y67vjqubk66rb6fzie2hfyz4t4nitg5corsxfhk2x6jljdzp5a',
      );
      (err as { code?: string }).code = 'ORBITDB_READ_FAILED';
      throw err;
    },
    async close() {},
    onReplication() { return () => {}; },
    isConnected() { return true; },
  } as ProfileDatabase & { allCallCount: number };
  return db;
}

function createProvider(db: ProfileDatabase): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: 'test',
      encrypt: true,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

describe('LifecycleManager.initialize() — tolerant of corrupt OrbitDB OpLog blocks', () => {
  let db: ReturnType<typeof createCorruptDb>;
  let provider: ProfileTokenStorageProvider;

  beforeEach(() => {
    db = createCorruptDb();
    provider = createProvider(db);
  });

  it('initialize() resolves true even when db.all() (refreshKnownBundles) throws ORBITDB_READ_FAILED', async () => {
    const initOk = await provider.initialize();
    expect(initOk).toBe(true);
  });

  it('initialized flag is true after tolerant initialize — save() does NOT short-circuit', async () => {
    await provider.initialize();
    // Access the private field via the unknown cast pattern used by
    // other tests in this directory.
    const initialized = (provider as unknown as { initialized: boolean }).initialized;
    expect(initialized).toBe(true);

    // And save() should now enqueue rather than rejecting with the
    // sentinel error string from the regression.
    const result = await provider.save({
      _meta: {
        version: 1,
        address: 'alpha1testaddress',
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('exercises db.all() at least once during initialize (verifies the throw path was actually entered)', async () => {
    await provider.initialize();
    // The corrupt db.all() is called from refreshKnownBundles. We
    // require at least one invocation so the test proves it WAS the
    // tolerant-fallback path that succeeded, not a code path that
    // skipped the bundle index entirely.
    expect(db.allCallCount).toBeGreaterThanOrEqual(1);
  });

  it('knownBundleCids is empty after tolerant fallback (defensive reset)', async () => {
    await provider.initialize();
    const known = (
      provider as unknown as { knownBundleCids: Set<string> }
    ).knownBundleCids;
    expect(known).toBeInstanceOf(Set);
    expect(known.size).toBe(0);
  });

  it('emits storage:error with code BUNDLE_INDEX_REFRESH_FAILED so operators see the degraded state', async () => {
    // Steelman finding #2 — without an event, the band-aid is invisible
    // to operators. The downstream flush scheduler swallows its own
    // listActiveBundles() throws, so a user-triggered migration could
    // silently publish a bundle pointer reflecting only post-recovery
    // state (orphaning anything the corrupt walk hid). The event MUST
    // fire so consumers can refuse destructive writes when the bundle
    // index baseline is known-stale.
    const events: Array<{ type: string; code?: string }> = [];
    provider.onEvent((ev) => {
      if (ev.type === 'storage:error') {
        events.push({ type: ev.type, code: (ev as { code?: string }).code });
      }
    });

    await provider.initialize();

    const bundleRefreshErrors = events.filter(
      (e) => e.type === 'storage:error' && e.code === 'BUNDLE_INDEX_REFRESH_FAILED',
    );
    expect(bundleRefreshErrors.length).toBe(1);
  });

  it('does NOT emit storage:error when db.all() succeeds (healthy init)', async () => {
    // Counter-test: make sure the event only fires on the broken path.
    const healthyDb = (() => {
      const store = new Map<string, Uint8Array>();
      return {
        async connect(_config: OrbitDbConfig) {},
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
        async close() {},
        onReplication() { return () => {}; },
        isConnected() { return true; },
      } as ProfileDatabase;
    })();

    const healthyProvider = createProvider(healthyDb);
    const events: Array<{ type: string; code?: string }> = [];
    healthyProvider.onEvent((ev) => {
      if (ev.type === 'storage:error') {
        events.push({ type: ev.type, code: (ev as { code?: string }).code });
      }
    });

    await healthyProvider.initialize();

    const bundleRefreshErrors = events.filter(
      (e) => e.code === 'BUNDLE_INDEX_REFRESH_FAILED',
    );
    expect(bundleRefreshErrors.length).toBe(0);
  });
});
