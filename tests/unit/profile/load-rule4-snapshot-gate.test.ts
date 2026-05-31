/**
 * Issue #364 Item #4 — design-correct Rule-4 snapshot-vs-cross-device
 * gate. Asserts that `ProfileTokenStorageProvider.load()` skips the
 * O(N²) pairwise `computeVerifiedProofs` walk when the active bundle
 * set was last populated by an `applySnapshotIfWired()` dispatch, and
 * runs the walk as before when the active set carries cross-device
 * contributions.
 *
 * Companion to `load-rule4-wiring.test.ts` (which pins that the
 * verifier IS invoked on a baseline multi-bundle load). Those tests
 * already cover the cross-device default path; this file specifically
 * covers the breadcrumb-set / breadcrumb-cleared transitions.
 *
 * Coverage:
 *   - Snapshot-sourced multi-bundle load → computeVerifiedProofs is
 *     NOT invoked AND merge() is called WITHOUT verifiedProofs.
 *   - Cross-device multi-bundle load (no apply-snapshot fired) →
 *     computeVerifiedProofs IS invoked (the pre-existing default).
 *   - Cross-device merge AFTER an apply-snapshot disarms the gate →
 *     computeVerifiedProofs IS invoked on the next load.
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

/**
 * Reach into the provider's private `loadSourcedFromSnapshot` field to
 * simulate the breadcrumb being armed by a prior `applySnapshotIfWired`
 * dispatch. Direct injection is more deterministic for this test than
 * synthesizing an end-to-end snapshot-apply (which would require wiring
 * `setApplySnapshotCallback` and a parseable LeanProfileSnapshot CAR).
 *
 * The lifecycle invariant under test is:
 *   - Armed breadcrumb + ≥2 bundles + oracle wired ⇒ skip Rule-4.
 *   - Cleared breadcrumb (default / after replication) ⇒ run Rule-4.
 *
 * The armed/cleared transitions are exercised by direct provider-level
 * unit tests of `_applySnapshotIfWiredImpl`, `addBundle`, and
 * `handleReplication` paths; this file pins the `_loadImpl` consumer.
 */
function armSnapshotBreadcrumb(provider: ProfileTokenStorageProvider): void {
  (provider as unknown as { loadSourcedFromSnapshot: boolean }).loadSourcedFromSnapshot = true;
}

describe('ProfileTokenStorageProvider.load — Issue #364 Item #4 Rule-4 snapshot gate', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('snapshot-sourced multi-bundle load skips Rule-4 pairwise verification', async () => {
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

    // Arm the snapshot-sourced breadcrumb — simulates the state after a
    // successful `applySnapshotIfWired()` dispatch.
    armSnapshotBreadcrumb(provider);

    const result = await provider.load();
    expect(result.success).toBe(true);

    // Gate fires: verifier is NOT invoked.
    expect(computeSpy).not.toHaveBeenCalled();

    // Every merge call MUST have undefined opts (no verifiedProofs).
    const mergeOpts = mergeSpy.mock.calls.map((args) => args[1]);
    expect(mergeOpts.every((o) => o === undefined)).toBe(true);

    await provider.shutdown();
  });

  it('cross-device multi-bundle load (default, no apply-snapshot fired) runs Rule-4 pairwise verification', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>(['stub-proof-hash']));
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

    // Do NOT arm the breadcrumb — default is the cross-device path.
    const result = await provider.load();
    expect(result.success).toBe(true);

    // Gate does NOT fire: verifier IS invoked.
    expect(computeSpy).toHaveBeenCalled();

    // At least one merge call carries verifiedProofs.
    const callWithVerified = mergeSpy.mock.calls.find((args) => {
      const opts = args[1] as { verifiedProofs?: ReadonlySet<string> } | undefined;
      return opts !== undefined && opts.verifiedProofs !== undefined;
    });
    expect(callWithVerified).toBeDefined();

    await provider.shutdown();
  });

  it('clears the snapshot breadcrumb on the next load after disarmament', async () => {
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

    // 1st load: armed → Rule-4 skipped.
    armSnapshotBreadcrumb(provider);
    await provider.load();
    expect(computeSpy).not.toHaveBeenCalled();

    // Simulate cross-device replication disarming the breadcrumb.
    (provider as unknown as { loadSourcedFromSnapshot: boolean }).loadSourcedFromSnapshot = false;

    // 2nd load: disarmed → Rule-4 fires.
    await provider.load();
    expect(computeSpy).toHaveBeenCalled();

    await provider.shutdown();
  });
});
