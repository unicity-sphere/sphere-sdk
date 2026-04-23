/**
 * Focused tests for the pointer-layer integration inside
 * ProfileTokenStorageProvider.initialize() — the cold-start recovery
 * path that prefers the aggregator pointer over the legacy IPNS
 * snapshot.
 *
 * These tests construct a provider with a mock `ProfileDatabase` and a
 * stub `ProfilePointerLayer`. The pointer stub only needs
 * `recoverLatest()` because that is the sole method initialize() calls.
 *
 * Scope:
 *   - pointer returns a CID → bundle ref written to OrbitDB, IPNS
 *     fallback skipped
 *   - pointer returns null   → IPNS fallback attempted
 *   - pointer throws         → IPNS fallback attempted
 *   - no pointer closure     → original behaviour preserved
 *
 * The publish-side integration (flushToIpfs) is not exercised here —
 * it requires IPFS mocking that the main provider test file already
 * does. The publish helper itself is trivially thin and falls out of
 * the recover-side tests once the closure wiring is verified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createDigest } from 'multiformats/hashes/digest';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
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
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

function createProvider(opts: {
  db: ProfileDatabase;
  getPointerLayer?: () => ProfilePointerLayer | null;
}): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    opts.db,
    new Uint8Array(32).fill(0x11), // deterministic encryption key
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false, // disable IPNS fallback in these tests
      },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: opts.getPointerLayer,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

/** Minimal pointer stub — only what initialize() touches. */
function stubPointer(overrides: Partial<ProfilePointerLayer>): ProfilePointerLayer {
  return {
    async recoverLatest() {
      return null;
    },
    ...overrides,
  } as unknown as ProfilePointerLayer;
}

describe('ProfileTokenStorageProvider pointer recovery (T-D6 wiring)', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
  });

  it('records the recovered CID as a bundle ref when the pointer has an anchor', async () => {
    const bundleBytes = new TextEncoder().encode('{"tokens":[]}');
    const cid = cidForBytes(bundleBytes);
    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 5 }));
    const pointer = stubPointer({ recoverLatest });

    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
    });

    await provider.initialize();

    expect(recoverLatest).toHaveBeenCalledOnce();

    // Bundle ref was written at the canonical key.
    const bundleKey = BUNDLE_KEY_PREFIX + cid.toString();
    expect(db._store.has(bundleKey)).toBe(true);
  });

  it('falls through to IPNS when the pointer returns null (no anchor yet)', async () => {
    const recoverLatest = vi.fn(async () => null);
    const pointer = stubPointer({ recoverLatest });

    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
    });

    await provider.initialize();

    expect(recoverLatest).toHaveBeenCalledOnce();

    // Pointer returned null, so no bundle was recorded from it.
    // ipnsSnapshot is disabled in the fixture, so IPNS also records
    // nothing — the invariant we assert is just "no bundle written".
    const bundleCount = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    ).length;
    expect(bundleCount).toBe(0);
  });

  it('does not throw when the pointer errors out mid-recover', async () => {
    const recoverLatest = vi.fn(async () => {
      throw new Error('aggregator offline');
    });
    const pointer = stubPointer({ recoverLatest });

    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
    });

    // initialize() must succeed despite the pointer error (best-effort).
    await expect(provider.initialize()).resolves.toBe(true);

    const bundleCount = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    ).length;
    expect(bundleCount).toBe(0);
  });

  it('skips pointer recovery cleanly when no closure is provided', async () => {
    const provider = createProvider({ db });

    await expect(provider.initialize()).resolves.toBe(true);

    // No pointer, no IPNS — empty store.
    expect(db._store.size).toBe(0);
  });

  it('skips pointer recovery when the closure returns null', async () => {
    // Simulates "pointer layer construction was skipped — storage
    // not durable, no oracle, etc." The closure returning null must
    // not trip the recovery path; initialize proceeds cleanly.
    const provider = createProvider({
      db,
      getPointerLayer: () => null,
    });

    await expect(provider.initialize()).resolves.toBe(true);
    expect(db._store.size).toBe(0);
  });
});
