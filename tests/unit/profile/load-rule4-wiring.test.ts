/**
 * Gap 3 wiring test — `ProfileTokenStorageProvider.load()` passes
 * `verifiedProofs` to `UxfPackage.merge()` when an oracle with a
 * `verifyInclusionProof` callback is wired AND multiple bundles need
 * to be JOINed.
 *
 * The per-token JOIN resolver (`uxf/token-join.ts:resolveTokenRoot`)
 * and Rule 4 enrichment paths are already feature-complete and
 * exhaustively unit-tested (see `tests/unit/uxf/token-join.test.ts`).
 * The piece that was missing — and that this test pins — is the
 * actual invocation: without `verifiedProofs` being threaded through
 * `load()`, Rule 4 enrichment was inactive at the cross-bundle JOIN
 * layer and the conservative `divergent` outcome was the only
 * behaviour ever surfaced to consumers.
 *
 * Strategy: spy on `UxfPackage.prototype.computeVerifiedProofs` and
 * `UxfPackage.prototype.merge` to assert the wiring lights up the
 * right code paths. We don't need a real CAR with verified proofs —
 * the JOIN resolver itself is tested elsewhere. The contract this
 * test pins is "load() pre-computes verifiedProofs and passes them
 * to merge() when conditions are met".
 *
 * Coverage:
 *   - Multi-bundle load with oracle.verifyInclusionProof wired →
 *     computeVerifiedProofs is invoked at least once AND merge() is
 *     called with `{verifiedProofs}`.
 *   - Single-bundle load → computeVerifiedProofs is NOT invoked
 *     AND merge() is called without verifiedProofs.
 *   - No-oracle load → computeVerifiedProofs is NOT invoked.
 *   - computeVerifiedProofs throws → load() still succeeds, falls
 *     back to non-enriched merge.
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

/**
 * Build a CID + CAR for an empty package. Used as a stand-in so the
 * load() path has fetchable bundles. The actual contents are
 * uninteresting here — we're spying on the merge/verifier wiring,
 * not asserting JOIN outcomes.
 */
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

describe('ProfileTokenStorageProvider.load — Gap 3 verifiedProofs wiring', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('pre-computes verifiedProofs and forwards them to merge() on multi-bundle load', async () => {
    // Spy on the prototype so all UxfPackage instances created during
    // load() are observed. The spy returns an empty set — we're not
    // testing the verifier itself, only that the wiring fires.
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

    const result = await provider.load();
    expect(result.success).toBe(true);

    // Verification pass: computeVerifiedProofs called at least once
    // across the bundles (pairwise loop walks each pair).
    expect(computeSpy).toHaveBeenCalled();

    // The merge calls AFTER the pre-compute pass must receive
    // `{ verifiedProofs }` as the second arg. mergeSpy may have been
    // called multiple times in the load body — verify at least one
    // call carried the verifiedProofs option.
    const callWithVerified = mergeSpy.mock.calls.find((args) => {
      const opts = args[1] as { verifiedProofs?: ReadonlySet<string> } | undefined;
      return opts !== undefined && opts.verifiedProofs !== undefined;
    });
    expect(callWithVerified).toBeDefined();

    await provider.shutdown();
  });

  it('does NOT pre-compute verifiedProofs on single-bundle load (no JOIN collisions possible)', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());
    const mergeSpy = vi.spyOn(UxfPackage.prototype, 'merge');

    const verifier = vi.fn(async () => true);
    const provider = createProvider(db, stubOracle(verifier));
    await provider.initialize();

    const bundle = await buildEmptyBundle('only');
    await plantBundleInOrbit(db, bundle.cid, {
      cid: bundle.cid,
      status: 'active',
      createdAt: 1000,
    });
    installCarFetchMock(new Map<string, Uint8Array>([[bundle.cid, bundle.carBytes]]));

    const result = await provider.load();
    expect(result.success).toBe(true);
    expect(computeSpy).not.toHaveBeenCalled();

    // Every merge call MUST have undefined opts (no verifiedProofs).
    const mergeOpts = mergeSpy.mock.calls.map((args) => args[1]);
    expect(mergeOpts.every((o) => o === undefined)).toBe(true);

    await provider.shutdown();
  });

  it('does NOT pre-compute verifiedProofs when no oracle is wired', async () => {
    const computeSpy = vi
      .spyOn(UxfPackage.prototype, 'computeVerifiedProofs')
      .mockResolvedValue(new Set<string>());

    const provider = createProvider(db /* no oracle */);
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

    const result = await provider.load();
    expect(result.success).toBe(true);
    expect(computeSpy).not.toHaveBeenCalled();

    await provider.shutdown();
  });

  it('survives computeVerifiedProofs throwing — load() succeeds and merges proceed without enrichment', async () => {
    vi.spyOn(UxfPackage.prototype, 'computeVerifiedProofs').mockRejectedValue(
      new Error('simulated verifier failure'),
    );
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

    // load() MUST NOT throw — verifier failure is caught inside load
    // and falls back to non-enriched merge.
    const result = await provider.load();
    expect(result.success).toBe(true);

    // No merge call carries verifiedProofs (the pre-compute failed,
    // so verifiedProofs stays undefined and merge() runs without it).
    const callsWithVerified = mergeSpy.mock.calls.filter((args) => {
      const opts = args[1] as { verifiedProofs?: ReadonlySet<string> } | undefined;
      return opts !== undefined && opts.verifiedProofs !== undefined;
    });
    expect(callsWithVerified.length).toBe(0);

    await provider.shutdown();
  });
});
