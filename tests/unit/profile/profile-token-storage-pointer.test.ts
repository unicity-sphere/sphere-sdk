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
  getPointerBuildStatus?: () => 'pending' | 'unavailable' | 'ready';
  /**
   * Item #15 Phase E follow-up — install a snapshot applier on the
   * provider. When omitted, the provider runs without an applier and
   * cold-start recovery becomes a no-op for the pointer-returned CID.
   */
  onApplySnapshot?: (cidString: string) => Promise<{
    joinedAny: boolean;
    addressesSeen: number;
    bundleEntriesSeen: number;
    counters: {
      entriesEvaluated: number;
      liveLanded: number;
      tombstonesLanded: number;
      localWon: number;
      remoteRejectedMalformed: number;
    };
  }>;
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
      // When `getPointerLayer` is wired but the test wants pointer
      // recovery to bail immediately (closure returns null), pair it
      // with a `getPointerBuildStatus` accessor reporting 'unavailable'.
      // Production wires both accessors together (see profile/factory.ts);
      // tests that only wire `getPointerLayer` would otherwise trip the
      // 30s "wait for slow Helia bootstrap" loop in lifecycle-manager.
      getPointerBuildStatus: opts.getPointerBuildStatus,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  if (opts.onApplySnapshot) {
    provider.setApplySnapshotCallback(opts.onApplySnapshot);
  }
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

  it('dispatches the recovered snapshot CID through applySnapshotIfWired (Item #15)', async () => {
    // Item #15 Phase E follow-up: the pointer's CID is a SNAPSHOT
    // CID, not a UXF bundle CID. Cold-start recovery routes it
    // through the host-wired applier (fetch + parse + per-writer
    // JOIN). The legacy `bundleIndex.addBundle(snapshotCid, …)` path
    // is gone — silently writing the snapshot bytes as a bundle ref
    // was the latent bug Phase E follow-up fixed.
    const bundleBytes = new TextEncoder().encode('{"tokens":[]}');
    const cid = cidForBytes(bundleBytes);
    const cidString = cid.toString();
    const recoverLatest = vi.fn(async () => ({ cid: cid.bytes, version: 5 }));
    const pointer = stubPointer({ recoverLatest });

    const applierCalls: string[] = [];
    const onApplySnapshot = vi.fn(async (cidArg: string) => {
      applierCalls.push(cidArg);
      return {
        joinedAny: true,
        addressesSeen: 1,
        bundleEntriesSeen: 0,
        counters: {
          entriesEvaluated: 1,
          liveLanded: 1,
          tombstonesLanded: 0,
          localWon: 0,
          remoteRejectedMalformed: 0,
        },
      };
    });

    const provider = createProvider({
      db,
      getPointerLayer: () => pointer,
      onApplySnapshot,
    });

    await provider.initialize();

    expect(recoverLatest).toHaveBeenCalledOnce();
    // Applier received the snapshot CID — not via direct bundle-index
    // write.
    expect(applierCalls).toContain(cidString);
    // Legacy `addBundle(snapshotCid, …)` path is gone — bundle index
    // not directly written by the lifecycle. (The applier itself may
    // write through BundleIndex.joinSnapshot, but our stub doesn't.)
    const bundleKey = BUNDLE_KEY_PREFIX + cidString;
    expect(db._store.has(bundleKey)).toBe(false);
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
    //
    // Pair `getPointerLayer: () => null` with a build-status accessor
    // reporting 'unavailable' to mirror the production path
    // (factory.ts wires both together). Without the status accessor,
    // lifecycle-manager would poll up to 30s waiting for the closure
    // to flip to non-null — fine in production where 'pending' is
    // distinguishable, but a hard hang in this fixture.
    const provider = createProvider({
      db,
      getPointerLayer: () => null,
      getPointerBuildStatus: () => 'unavailable',
    });

    await expect(provider.initialize()).resolves.toBe(true);
    expect(db._store.size).toBe(0);
  });

  it('surfaces a storage:error event when the pointer fails with TRUST_BASE_STALE (permanent)', async () => {
    const staleError = Object.assign(
      new Error('embedded trust base is older than aggregator epoch'),
      { code: 'AGGREGATOR_POINTER_TRUST_BASE_STALE' },
    );
    const recoverLatest = vi.fn(async () => {
      throw staleError;
    });
    const pointer = stubPointer({ recoverLatest });

    const provider = createProvider({ db, getPointerLayer: () => pointer });

    // Steelman⁴⁰/⁴¹: typed `code` field on the event is the
    // load-bearing API. The legacy substring-match on `evt.error` no
    // longer works — F.45's buildErrorEvent removed the code prefix
    // from the error message. Consumers MUST use the typed `code` field.
    const errorEvents: Array<{ error?: string; code?: string }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error') {
        errorEvents.push({ error: evt.error, code: evt.code });
      }
    });

    // initialize must still succeed (best-effort) — but the error
    // event must fire AND no IPNS fallback should run (bundle set
    // stays empty).
    await expect(provider.initialize()).resolves.toBe(true);
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].code).toBe('AGGREGATOR_POINTER_TRUST_BASE_STALE');
  });

  it('does NOT surface events for transient pointer errors (network / unavailable)', async () => {
    const transientError = Object.assign(
      new Error('aggregator offline'),
      { code: 'AGGREGATOR_POINTER_NETWORK_ERROR' },
    );
    const pointer = stubPointer({
      recoverLatest: vi.fn(async () => {
        throw transientError;
      }),
    });

    const provider = createProvider({ db, getPointerLayer: () => pointer });

    const errorEvents: string[] = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error') errorEvents.push(evt.error ?? '');
    });

    await expect(provider.initialize()).resolves.toBe(true);
    expect(errorEvents).toEqual([]);
  });
});
