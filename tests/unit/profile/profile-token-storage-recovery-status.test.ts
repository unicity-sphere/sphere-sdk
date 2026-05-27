/**
 * Tests for `ProfileTokenStorageProvider.getRecoveryStatus` /
 * `writeRecoveryMarker` / `readRecoveryMarker` (Item #157).
 *
 * Round-trips the persistent recovery marker through a mock OrbitDB
 * adapter and verifies the schema / permanence guarantees.
 *
 * @see profile/profile-token-storage-provider.ts (writeRecoveryMarker,
 *      readRecoveryMarker, getRecoveryStatus)
 * @see profile/types.ts (ProfileRecoveryMarker)
 */

import { describe, expect, it } from 'vitest';
import {
  ProfileTokenStorageProvider,
} from '../../../profile/profile-token-storage-provider.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
  ProfileRecoveryMarker,
} from '../../../profile/types.js';

function createMockDb(): ProfileDatabase {
  const store = new Map<string, Uint8Array>();
  return {
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
  } as ProfileDatabase;
}

function buildProvider(): ProfileTokenStorageProvider {
  return new ProfileTokenStorageProvider(
    createMockDb(),
    new Uint8Array(32),
    [],
    {
      config: {
        ipfsApiUrl: 'http://localhost:5001',
        ipnsKeyName: 'recovery-status-test',
        flushDebounceMs: 1000,
      },
      addressId: 'DIRECT_aabbcc_ddeeff',
    },
  );
}

describe('ProfileTokenStorageProvider — Recovery Status (Item #157)', () => {
  it('getRecoveryStatus() returns null when no marker has been written', async () => {
    const provider = buildProvider();
    expect(await provider.getRecoveryStatus()).toBeNull();
  });

  it('round-trips a marker via writeRecoveryMarker + getRecoveryStatus', async () => {
    const provider = buildProvider();
    const before = Date.now();
    const marker: ProfileRecoveryMarker = {
      version: 1,
      recoveredAt: before,
      lostHeadCid: 'bafyreid2y67vjqubk66rb6fzie2hfyz4t4nitg5corsxfhk2x6jljdzp5a',
      context: 'flush-scheduler.bundle-write',
      walkBackClosed: true,
      note: 'unit test',
    };
    await provider.writeRecoveryMarker(marker);
    const read = await provider.getRecoveryStatus();
    expect(read).not.toBeNull();
    expect(read).toEqual(marker);
  });

  it('marker schema: version=1, walkBackClosed=true, timestamps survive round-trip', async () => {
    const provider = buildProvider();
    const ts = 1717000000000;
    const marker: ProfileRecoveryMarker = {
      version: 1,
      recoveredAt: ts,
      lostHeadCid: null,
      context: 'test',
      walkBackClosed: true,
      note: 'schema check',
    };
    await provider.writeRecoveryMarker(marker);
    const read = await provider.getRecoveryStatus();
    expect(read?.version).toBe(1);
    expect(read?.walkBackClosed).toBe(true);
    expect(read?.recoveredAt).toBe(ts);
    expect(read?.lostHeadCid).toBeNull();
  });

  it('rejects malformed marker (wrong version) and returns null', async () => {
    const provider = buildProvider();
    // Force-write through writeProfileKey directly with a bad version.
    // The facade exposes writeRecoveryMarker which goes through the
    // canonical path; here we simulate a stale-schema marker by
    // round-tripping through the same private path but with version=0.
    const bogus = {
      version: 0,
      recoveredAt: Date.now(),
      lostHeadCid: 'bafytest',
      context: 'broken',
      walkBackClosed: true,
      note: '',
    } as unknown as ProfileRecoveryMarker;
    await provider.writeRecoveryMarker(bogus);
    const read = await provider.getRecoveryStatus();
    // Defensive shape check rejects version != 1.
    expect(read).toBeNull();
  });

  it('overwrite is idempotent — second write replaces first', async () => {
    const provider = buildProvider();
    const m1: ProfileRecoveryMarker = {
      version: 1,
      recoveredAt: 1000,
      lostHeadCid: 'bafy1',
      context: 'a',
      walkBackClosed: true,
      note: 'first',
    };
    const m2: ProfileRecoveryMarker = {
      version: 1,
      recoveredAt: 2000,
      lostHeadCid: 'bafy2',
      context: 'b',
      walkBackClosed: true,
      note: 'second',
    };
    await provider.writeRecoveryMarker(m1);
    await provider.writeRecoveryMarker(m2);
    const read = await provider.getRecoveryStatus();
    expect(read?.lostHeadCid).toBe('bafy2');
    expect(read?.recoveredAt).toBe(2000);
    expect(read?.note).toBe('second');
  });

  it('marker key is address-scoped (different addressIds have isolated markers)', async () => {
    const dbShared = createMockDb();

    const providerA = new ProfileTokenStorageProvider(
      dbShared,
      new Uint8Array(32),
      [],
      {
        config: {
          ipfsApiUrl: 'http://localhost:5001',
          ipnsKeyName: 'k',
          flushDebounceMs: 1000,
        },
        addressId: 'DIRECT_aaa_bbb',
      },
    );
    const providerB = new ProfileTokenStorageProvider(
      dbShared,
      new Uint8Array(32),
      [],
      {
        config: {
          ipfsApiUrl: 'http://localhost:5001',
          ipnsKeyName: 'k',
          flushDebounceMs: 1000,
        },
        addressId: 'DIRECT_ccc_ddd',
      },
    );

    const m: ProfileRecoveryMarker = {
      version: 1,
      recoveredAt: Date.now(),
      lostHeadCid: 'bafyA',
      context: 'a-only',
      walkBackClosed: true,
      note: 'scoped',
    };
    await providerA.writeRecoveryMarker(m);

    expect(await providerA.getRecoveryStatus()).not.toBeNull();
    // B has no marker for its own addressId — different key.
    expect(await providerB.getRecoveryStatus()).toBeNull();
  });
});
