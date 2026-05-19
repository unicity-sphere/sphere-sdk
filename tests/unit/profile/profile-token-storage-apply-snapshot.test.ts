/**
 * Item #15 Phase E follow-up — unit tests for the new
 * `ProfileTokenStorageProvider.applySnapshotIfWired(cid)` method and
 * the symmetric `setApplySnapshotCallback(callback)` setter.
 *
 * The method is the pull-side counterpart to
 * `publishSnapshotIfWired()`: it fetches the snapshot CAR for a given
 * CID, parses it as a lean profile snapshot, and dispatches per-writer
 * JOIN through the factory-wired closure. The closure itself lives in
 * `profile/factory.ts:createProfileProviders`; here we exercise the
 * provider's wrapper behaviour (null when no callback wired, delegate
 * when wired, shutdown gate, error propagation, late-binding wins).
 */

import { describe, it, expect, vi } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ApplySnapshotResult } from '../../../profile/profile-snapshot-dispatcher';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1test',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

function createMockDb(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  return {
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
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as ProfileDatabase;
}

function makeApplyResult(joinedAny = false): ApplySnapshotResult {
  return {
    joinedAny,
    addressesSeen: joinedAny ? 1 : 0,
    bundleEntriesSeen: 0,
    counters: {
      entriesEvaluated: joinedAny ? 1 : 0,
      liveLanded: joinedAny ? 1 : 0,
      tombstonesLanded: 0,
      localWon: 0,
      remoteRejectedMalformed: 0,
    },
  };
}

function createProvider(): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    createMockDb(),
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

describe('ProfileTokenStorageProvider.applySnapshotIfWired (Item #15 Phase E follow-up)', () => {
  it('returns null when no applier callback is wired', async () => {
    const provider = createProvider();
    const result = await provider.applySnapshotIfWired('bafy-snapshot-cid');
    expect(result).toBeNull();
  });

  it('returns null when callback is set then cleared via setApplySnapshotCallback(null)', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    provider.setApplySnapshotCallback(null);
    const result = await provider.applySnapshotIfWired('bafy-snapshot-cid');
    expect(result).toBeNull();
    expect(applier).not.toHaveBeenCalled();
  });

  it('delegates to the wired callback with the provided CID', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);

    const result = await provider.applySnapshotIfWired('bafy-snapshot-cid');
    expect(applier).toHaveBeenCalledTimes(1);
    expect(applier).toHaveBeenCalledWith('bafy-snapshot-cid');
    expect(result).toMatchObject({ joinedAny: true, addressesSeen: 1 });
  });

  it('re-registration replaces the previous callback (last-one-wins)', async () => {
    const provider = createProvider();
    const first = vi.fn(async () => makeApplyResult(false));
    const second = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(first);
    provider.setApplySnapshotCallback(second);

    const result = await provider.applySnapshotIfWired('bafy-cid');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(result?.joinedAny).toBe(true);
  });

  it('propagates errors thrown by the wired callback', async () => {
    const provider = createProvider();
    const boom = new Error('dispatcher exploded');
    provider.setApplySnapshotCallback(async () => {
      throw boom;
    });
    await expect(provider.applySnapshotIfWired('bafy-cid')).rejects.toBe(boom);
  });

  it('returns null after shutdown (gate closes)', async () => {
    const provider = createProvider();
    const applier = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(applier);
    await provider.initialize();
    await provider.shutdown();

    const result = await provider.applySnapshotIfWired('bafy-cid');
    expect(result).toBeNull();
    expect(applier).not.toHaveBeenCalled();
  });

  it('falls back to construction-time onApplySnapshot when no setter override is installed', async () => {
    const applier = vi.fn(async () => makeApplyResult(true));
    const provider = new ProfileTokenStorageProvider(
      createMockDb(),
      new Uint8Array(32).fill(0x11),
      ['https://mock-ipfs.test'],
      {
        config: {
          orbitDb: { privateKey: TEST_PRIVATE_KEY },
          ipnsSnapshot: false,
        },
        addressId: 'test',
        encrypt: true,
        onApplySnapshot: applier,
      },
    );
    provider.setIdentity(TEST_IDENTITY);

    const result = await provider.applySnapshotIfWired('bafy-cid');
    expect(applier).toHaveBeenCalledTimes(1);
    expect(applier).toHaveBeenCalledWith('bafy-cid');
    expect(result?.joinedAny).toBe(true);
  });

  it('setApplySnapshotCallback overrides construction-time onApplySnapshot', async () => {
    const constructionTime = vi.fn(async () => makeApplyResult(false));
    const provider = new ProfileTokenStorageProvider(
      createMockDb(),
      new Uint8Array(32).fill(0x11),
      ['https://mock-ipfs.test'],
      {
        config: {
          orbitDb: { privateKey: TEST_PRIVATE_KEY },
          ipnsSnapshot: false,
        },
        addressId: 'test',
        encrypt: true,
        onApplySnapshot: constructionTime,
      },
    );
    provider.setIdentity(TEST_IDENTITY);

    const lateBound = vi.fn(async () => makeApplyResult(true));
    provider.setApplySnapshotCallback(lateBound);

    const result = await provider.applySnapshotIfWired('bafy-cid');
    expect(constructionTime).not.toHaveBeenCalled();
    expect(lateBound).toHaveBeenCalledTimes(1);
    expect(result?.joinedAny).toBe(true);
  });
});
