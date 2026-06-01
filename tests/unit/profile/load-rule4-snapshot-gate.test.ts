/**
 * Issue #367 — per-bundle provenance gate for Rule-4 pairwise verification.
 *
 * The provider's `_loadImpl` skips the O(N²) `computeVerifiedProofs`
 * pairwise loop when every active bundle was placed into the local
 * OrbitDB store by the snapshot dispatcher's `writeRemote` path AND they
 * all trace to the same source snapshot. Snapshot-sourced means the
 * `UxfBundleRef.sourcedFromSnapshotPointerCid` field is set on every
 * loaded bundle to the same non-null value. Any non-snapshot bundle in
 * the active set, or a mix of source snapshots, leaves Rule-4 enabled.
 *
 * This file pins the gate at the `load()` layer using planted refs.
 * The crypto/persistence paths are exercised in the existing
 * `load-rule4-wiring.test.ts`; here we only assert the gate's decision
 * matrix.
 *
 * Cases:
 *   - All bundles share one snapshot CID → skip (computeVerifiedProofs NOT called).
 *   - All bundles are local (field absent) → no skip.
 *   - Mixed bundles (some snapshot, some local) → no skip.
 *   - Bundles span two different snapshot CIDs → no skip.
 *   - Single-bundle snapshot-sourced load → no skip path is irrelevant
 *     (the `>= 2` guard in the gate prevents the pairwise loop anyway).
 *
 * Strategy mirrors `load-rule4-wiring.test.ts`:
 *   - In-memory MockProfileDb with planted encrypted bundle refs.
 *   - Spy on `UxfPackage.prototype.computeVerifiedProofs` and
 *     `UxfPackage.prototype.merge` to observe Rule-4 invocation.
 *   - Stub the CAR fetch so the actual bundle bytes are irrelevant —
 *     we only care about the gate's decision.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
  UxfBundleRef,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type { OracleProvider } from '../../../oracle';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../profile/encryption';
import { UxfPackage } from '../../../uxf/UxfPackage';

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

const SNAPSHOT_CID_A = 'bafyreigh2akiscaildc6zdrgwqjevvw2tbifg6vkv7gh2akiscaildc6zda';
const SNAPSHOT_CID_B = 'bafyreigh2akiscaildc6zdrgwqjevvw2tbifg6vkv7gh2akiscaildc6zdb';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function getEncryptionKey(): Uint8Array {
  return deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
}

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
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
  } as MockProfileDb;
}

async function plantBundleInOrbit(
  db: MockProfileDb,
  cid: string,
  ref: UxfBundleRef,
): Promise<void> {
  const encKey = getEncryptionKey();
  db._store.set(
    `${BUNDLE_KEY_PREFIX}${cid}`,
    await encryptProfileValue(
      encKey,
      new TextEncoder().encode(JSON.stringify(ref)),
    ),
  );
}

async function buildEmptyBundle(seed: string): Promise<{ cid: string; carBytes: Uint8Array }> {
  const pkg = UxfPackage.create({ description: seed });
  const carBytes = await pkg.toCar();
  const { CID } = await import('multiformats/cid');
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const raw = await import('multiformats/codecs/raw');
  const { create: createDigest } = await import('multiformats/hashes/digest');
  const cid = CID.createV1(raw.code, createDigest(0x12, sha256(carBytes))).toString();
  return { cid, carBytes };
}

const originalFetch = globalThis.fetch;
function installCarFetchMock(carBytesByCid: Map<string, Uint8Array>): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const ipfsMatch = url.match(/\/ipfs\/([^/?]+)/);
    const blockMatch = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    const cid = ipfsMatch
      ? ipfsMatch[1]
      : blockMatch
        ? decodeURIComponent(blockMatch[1]!)
        : null;
    if (cid && carBytesByCid.has(cid)) {
      return new Response(carBytesByCid.get(cid), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

function createProvider(
  db: MockProfileDb,
  oracle?: OracleProvider,
): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      oracle,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

function stubOracle(verify: ReturnType<typeof vi.fn>): OracleProvider {
  return {
    verifyInclusionProof: verify,
  } as unknown as OracleProvider;
}

describe('ProfileTokenStorageProvider.load — Issue #367 Rule-4 snapshot gate', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('skips Rule-4 when all loaded bundles share the same snapshot pointer CID', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());
    const mergeSpy = vi.spyOn(UxfPackage.prototype, 'merge');

    const verifier = vi.fn(async () => true);
    const provider = createProvider(db, stubOracle(verifier));
    await provider.initialize();

    const bundleA = await buildEmptyBundle('A');
    const bundleB = await buildEmptyBundle('B');
    await plantBundleInOrbit(db, bundleA.cid, {
      cid: bundleA.cid,
      status: 'active',
      createdAt: 1000,
      sourcedFromSnapshotPointerCid: SNAPSHOT_CID_A,
    });
    await plantBundleInOrbit(db, bundleB.cid, {
      cid: bundleB.cid,
      status: 'active',
      createdAt: 1001,
      sourcedFromSnapshotPointerCid: SNAPSHOT_CID_A,
    });

    installCarFetchMock(
      new Map<string, Uint8Array>([
        [bundleA.cid, bundleA.carBytes],
        [bundleB.cid, bundleB.carBytes],
      ]),
    );

    const result = await provider.load();
    expect(result.success).toBe(true);

    // Gate fired → pairwise loop skipped.
    expect(computeSpy).not.toHaveBeenCalled();
    // Merge calls SHOULD NOT carry verifiedProofs in this branch
    // (the catch arm that also skips Rule-4 enriches with an empty
    // set; the gate skip path leaves verifiedProofs undefined).
    const callWithVerified = mergeSpy.mock.calls.find((args) => {
      const opts = args[1] as { verifiedProofs?: ReadonlySet<string> } | undefined;
      return opts !== undefined && opts.verifiedProofs !== undefined;
    });
    expect(callWithVerified).toBeUndefined();

    await provider.shutdown();
  });

  it('does NOT skip Rule-4 when bundles have no provenance (locally-published)', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());
    vi.spyOn(UxfPackage.prototype, 'merge');

    const verifier = vi.fn(async () => true);
    const provider = createProvider(db, stubOracle(verifier));
    await provider.initialize();

    const bundleA = await buildEmptyBundle('A');
    const bundleB = await buildEmptyBundle('B');
    // No sourcedFromSnapshotPointerCid → locally-published bundles.
    await plantBundleInOrbit(db, bundleA.cid, {
      cid: bundleA.cid,
      status: 'active',
      createdAt: 1000,
    });
    await plantBundleInOrbit(db, bundleB.cid, {
      cid: bundleB.cid,
      status: 'active',
      createdAt: 1001,
    });

    installCarFetchMock(
      new Map<string, Uint8Array>([
        [bundleA.cid, bundleA.carBytes],
        [bundleB.cid, bundleB.carBytes],
      ]),
    );

    const result = await provider.load();
    expect(result.success).toBe(true);
    // Gate did NOT fire → pairwise loop ran.
    expect(computeSpy).toHaveBeenCalled();

    await provider.shutdown();
  });

  it('does NOT skip Rule-4 on a mix of snapshot-sourced and local bundles', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());

    const verifier = vi.fn(async () => true);
    const provider = createProvider(db, stubOracle(verifier));
    await provider.initialize();

    const bundleA = await buildEmptyBundle('A');
    const bundleB = await buildEmptyBundle('B');
    // A is snapshot-sourced.
    await plantBundleInOrbit(db, bundleA.cid, {
      cid: bundleA.cid,
      status: 'active',
      createdAt: 1000,
      sourcedFromSnapshotPointerCid: SNAPSHOT_CID_A,
    });
    // B is locally-published (no annotation).
    await plantBundleInOrbit(db, bundleB.cid, {
      cid: bundleB.cid,
      status: 'active',
      createdAt: 1001,
    });

    installCarFetchMock(
      new Map<string, Uint8Array>([
        [bundleA.cid, bundleA.carBytes],
        [bundleB.cid, bundleB.carBytes],
      ]),
    );

    const result = await provider.load();
    expect(result.success).toBe(true);
    // Mixed provenance → conservative gate keeps Rule-4 on.
    expect(computeSpy).toHaveBeenCalled();

    await provider.shutdown();
  });

  it('does NOT skip Rule-4 when bundles span two different snapshot CIDs', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());

    const verifier = vi.fn(async () => true);
    const provider = createProvider(db, stubOracle(verifier));
    await provider.initialize();

    const bundleA = await buildEmptyBundle('A');
    const bundleB = await buildEmptyBundle('B');
    await plantBundleInOrbit(db, bundleA.cid, {
      cid: bundleA.cid,
      status: 'active',
      createdAt: 1000,
      sourcedFromSnapshotPointerCid: SNAPSHOT_CID_A,
    });
    await plantBundleInOrbit(db, bundleB.cid, {
      cid: bundleB.cid,
      status: 'active',
      createdAt: 1001,
      sourcedFromSnapshotPointerCid: SNAPSHOT_CID_B,
    });

    installCarFetchMock(
      new Map<string, Uint8Array>([
        [bundleA.cid, bundleA.carBytes],
        [bundleB.cid, bundleB.carBytes],
      ]),
    );

    const result = await provider.load();
    expect(result.success).toBe(true);
    // Two distinct snapshots → JOIN across them is exactly when
    // Rule-4 is needed. Gate must NOT fire.
    expect(computeSpy).toHaveBeenCalled();

    await provider.shutdown();
  });

  it('single-bundle snapshot-sourced load — pairwise loop is structurally skipped (gate is moot)', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());

    const verifier = vi.fn(async () => true);
    const provider = createProvider(db, stubOracle(verifier));
    await provider.initialize();

    const bundle = await buildEmptyBundle('only');
    await plantBundleInOrbit(db, bundle.cid, {
      cid: bundle.cid,
      status: 'active',
      createdAt: 1000,
      sourcedFromSnapshotPointerCid: SNAPSHOT_CID_A,
    });

    installCarFetchMock(new Map<string, Uint8Array>([[bundle.cid, bundle.carBytes]]));

    const result = await provider.load();
    expect(result.success).toBe(true);
    // Single-bundle: the `loadedBundles.length >= 2` guard short-
    // circuits the pairwise loop independently of the gate.
    expect(computeSpy).not.toHaveBeenCalled();

    await provider.shutdown();
  });
});
