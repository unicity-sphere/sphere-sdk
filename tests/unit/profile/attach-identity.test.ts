/**
 * Tests for profile/attach-identity.ts (Issue #292)
 *
 * Verifies the SDK-private helper that wires a Sphere's internal
 * FullIdentity into a pair of Profile providers WITHOUT exposing the
 * private key to the caller.
 *
 * Coverage:
 *   - attachIdentityToProfileProviders calls setIdentity on both providers
 *     with the FullIdentity (including privateKey) from Sphere.
 *   - tokenStorage.initialize() is awaited after setIdentity.
 *   - The Sphere identity reference does NOT leak out of the helper.
 *   - Uninitialized Sphere → throws SphereError(NOT_INITIALIZED), NOT
 *     the obscure `hexToBytes: empty hex string` RangeError.
 *   - Sphere._withFullIdentityForProfileFactory snapshots identity safely
 *     and scrubs the snapshot's privateKey reference after the callback.
 */

import { describe, it, expect, vi } from 'vitest';
import { attachIdentityToProfileProviders } from '../../../profile/attach-identity';
import type { Sphere } from '../../../core/Sphere';
import type { FullIdentity } from '../../../types';
import type { ProfileStorageProvider } from '../../../profile/profile-storage-provider';
import type { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';

// ---------------------------------------------------------------------------
// Fixtures — minimal Sphere + provider stubs that exercise the helper's
// public contract without spinning up real OrbitDB / IPFS infrastructure.
// ---------------------------------------------------------------------------

const REAL_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1test',
  directAddress: 'DIRECT://test',
  privateKey: '00' + '11'.repeat(31),
};

/**
 * Build a Sphere stub whose `_withFullIdentityForProfileFactory` mirrors
 * the real implementation: invokes the callback with a fresh FullIdentity
 * snapshot. Throws when `identity` is null (uninitialized wallet).
 *
 * The real implementation does NOT scrub the snapshot post-callback
 * (providers retain the reference for their lifetime; scrubbing would
 * null out the authoritative source mid-flight). This stub matches.
 */
function buildSphereStub(identity: FullIdentity | null): Sphere {
  const stub = {
    _withFullIdentityForProfileFactory: vi.fn(
      (cb: (id: FullIdentity) => void): void => {
        if (!identity?.privateKey) {
          const err = new Error(
            'Wallet not initialized — call Sphere.init/create/load before constructing Sphere-bound Profile providers',
          );
          (err as unknown as { code: string }).code = 'NOT_INITIALIZED';
          throw err;
        }
        const snapshot: FullIdentity = {
          chainPubkey: identity.chainPubkey,
          l1Address: identity.l1Address,
          directAddress: identity.directAddress,
          ipnsName: identity.ipnsName,
          nametag: identity.nametag,
          privateKey: identity.privateKey,
        };
        cb(snapshot);
      },
    ),
  };
  return stub as unknown as Sphere;
}

function buildProviderPair(): {
  storage: ProfileStorageProvider;
  tokenStorage: ProfileTokenStorageProvider;
  storageSetId: ReturnType<typeof vi.fn>;
  tokenStorageSetId: ReturnType<typeof vi.fn>;
  tokenStorageInit: ReturnType<typeof vi.fn>;
} {
  const storageSetId = vi.fn();
  const tokenStorageSetId = vi.fn();
  const tokenStorageInit = vi.fn(async () => true);
  const storage = { setIdentity: storageSetId } as unknown as ProfileStorageProvider;
  const tokenStorage = {
    setIdentity: tokenStorageSetId,
    initialize: tokenStorageInit,
  } as unknown as ProfileTokenStorageProvider;
  return { storage, tokenStorage, storageSetId, tokenStorageSetId, tokenStorageInit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attachIdentityToProfileProviders', () => {
  it('calls setIdentity on both providers with the FullIdentity (incl. privateKey)', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const { storage, tokenStorage, storageSetId, tokenStorageSetId } = buildProviderPair();

    await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    expect(storageSetId).toHaveBeenCalledOnce();
    expect(tokenStorageSetId).toHaveBeenCalledOnce();
    expect(storageSetId.mock.calls[0][0]).toMatchObject({
      chainPubkey: REAL_IDENTITY.chainPubkey,
      l1Address: REAL_IDENTITY.l1Address,
      directAddress: REAL_IDENTITY.directAddress,
      privateKey: REAL_IDENTITY.privateKey,
    });
    expect(tokenStorageSetId.mock.calls[0][0]).toMatchObject({
      privateKey: REAL_IDENTITY.privateKey,
    });
  });

  it('storage.setIdentity is called BEFORE tokenStorage.setIdentity (encryption-key ordering)', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const callOrder: string[] = [];
    const storage = {
      setIdentity: vi.fn(() => callOrder.push('storage')),
    } as unknown as ProfileStorageProvider;
    const tokenStorage = {
      setIdentity: vi.fn(() => callOrder.push('tokenStorage')),
      initialize: vi.fn(async () => true),
    } as unknown as ProfileTokenStorageProvider;

    await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    expect(callOrder).toEqual(['storage', 'tokenStorage']);
  });

  it('awaits tokenStorage.initialize() after both setIdentity calls', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const { storage, tokenStorage, storageSetId, tokenStorageSetId, tokenStorageInit } =
      buildProviderPair();

    await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    expect(tokenStorageInit).toHaveBeenCalledOnce();
    // initialize() must observe both setIdentity calls already completed.
    const initOrder = tokenStorageInit.mock.invocationCallOrder[0];
    const storageOrder = storageSetId.mock.invocationCallOrder[0];
    const tsOrder = tokenStorageSetId.mock.invocationCallOrder[0];
    expect(initOrder).toBeGreaterThan(storageOrder);
    expect(initOrder).toBeGreaterThan(tsOrder);
  });

  it('throws clear NOT_INITIALIZED error when Sphere has no identity (NOT hexToBytes crash)', async () => {
    const sphere = buildSphereStub(null);
    const { storage, tokenStorage } = buildProviderPair();

    await expect(
      attachIdentityToProfileProviders(sphere, { storage, tokenStorage }),
    ).rejects.toThrow(/Wallet not initialized/);
    // Critically: NOT a RangeError from hexToBytes — the consumer-facing
    // bug in Issue #292 was the cryptic hexToBytes empty-hex crash.
    await expect(
      attachIdentityToProfileProviders(buildSphereStub(null), { storage, tokenStorage }),
    ).rejects.not.toThrow(/hexToBytes/);
  });

  it('NOT_INITIALIZED short-circuit: providers are NEVER touched', async () => {
    const sphere = buildSphereStub(null);
    const { storage, tokenStorage, storageSetId, tokenStorageSetId, tokenStorageInit } =
      buildProviderPair();

    await expect(
      attachIdentityToProfileProviders(sphere, { storage, tokenStorage }),
    ).rejects.toThrow();

    expect(storageSetId).not.toHaveBeenCalled();
    expect(tokenStorageSetId).not.toHaveBeenCalled();
    expect(tokenStorageInit).not.toHaveBeenCalled();
  });

  it('does NOT return the identity (privateKey stays inside helper scope)', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const { storage, tokenStorage } = buildProviderPair();

    const result = await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    expect(result).toBeUndefined();
  });

  it('Sphere._withFullIdentityForProfileFactory is invoked exactly once per attach', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const { storage, tokenStorage } = buildProviderPair();

    await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    expect(
      (sphere._withFullIdentityForProfileFactory as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it('provider errors propagate verbatim', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const storage = {
      setIdentity: vi.fn(() => {
        throw new Error('provider blew up');
      }),
    } as unknown as ProfileStorageProvider;
    const tokenStorage = {
      setIdentity: vi.fn(),
      initialize: vi.fn(async () => true),
    } as unknown as ProfileTokenStorageProvider;

    await expect(
      attachIdentityToProfileProviders(sphere, { storage, tokenStorage }),
    ).rejects.toThrow(/provider blew up/);
  });
});
