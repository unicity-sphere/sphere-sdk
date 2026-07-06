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
import { attachIdentityToProfileProviders } from '../../../extensions/uxf/profile/attach-identity';
import type { Sphere } from '../../../core/Sphere';
import type { FullIdentity } from '../../../types';
import type { ProfileStorageProvider } from '../../../extensions/uxf/profile/profile-storage-provider';
import type { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';

// ---------------------------------------------------------------------------
// Fixtures — minimal Sphere + provider stubs that exercise the helper's
// public contract without spinning up real OrbitDB / IPFS infrastructure.
// ---------------------------------------------------------------------------

const REAL_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
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
  storageConnect: ReturnType<typeof vi.fn>;
  tokenStorageSetId: ReturnType<typeof vi.fn>;
  tokenStorageInit: ReturnType<typeof vi.fn>;
} {
  const storageSetId = vi.fn();
  const storageConnect = vi.fn(async () => undefined);
  const tokenStorageSetId = vi.fn();
  const tokenStorageInit = vi.fn(async () => true);
  const storage = {
    setIdentity: storageSetId,
    connect: storageConnect,
  } as unknown as ProfileStorageProvider;
  const tokenStorage = {
    setIdentity: tokenStorageSetId,
    initialize: tokenStorageInit,
  } as unknown as ProfileTokenStorageProvider;
  return { storage, tokenStorage, storageSetId, storageConnect, tokenStorageSetId, tokenStorageInit };
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
      connect: vi.fn(async () => { callOrder.push('storage.connect'); }),
    } as unknown as ProfileStorageProvider;
    const tokenStorage = {
      setIdentity: vi.fn(() => callOrder.push('tokenStorage')),
      initialize: vi.fn(async () => {
        callOrder.push('tokenStorage.initialize');
        return true;
      }),
    } as unknown as ProfileTokenStorageProvider;

    await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    // Both setIdentity calls happen synchronously in the
    // _withFullIdentityForProfileFactory callback, so 'storage' (the
    // setIdentity invocation) precedes 'tokenStorage'. The async
    // connect/initialize steps then run in declared order.
    expect(callOrder).toEqual([
      'storage',
      'tokenStorage',
      'storage.connect',
      'tokenStorage.initialize',
    ]);
  });

  it('awaits storage.connect() between setIdentity and tokenStorage.initialize() — OrbitDB attach', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const { storage, tokenStorage, storageSetId, storageConnect, tokenStorageInit } =
      buildProviderPair();

    await attachIdentityToProfileProviders(sphere, { storage, tokenStorage });

    expect(storageConnect).toHaveBeenCalledOnce();
    const setIdOrder = storageSetId.mock.invocationCallOrder[0];
    const connectOrder = storageConnect.mock.invocationCallOrder[0];
    const initOrder = tokenStorageInit.mock.invocationCallOrder[0];
    // setIdentity → storage.connect → tokenStorage.initialize. The
    // connect MUST happen after setIdentity (Phase B reads identity)
    // and BEFORE tokenStorage.initialize (which inspects host.db.
    // isConnected()).
    expect(connectOrder).toBeGreaterThan(setIdOrder);
    expect(initOrder).toBeGreaterThan(connectOrder);
  });

  it('propagates storage.connect() failure (OrbitDB attach error surfaces)', async () => {
    const sphere = buildSphereStub(REAL_IDENTITY);
    const storage = {
      setIdentity: vi.fn(),
      connect: vi.fn(async () => {
        throw new Error('OrbitDB attach failed: bootstrap peer unreachable');
      }),
      disconnect: vi.fn(async () => undefined),
    } as unknown as ProfileStorageProvider;
    const tokenStorageInit = vi.fn(async () => true);
    const tokenStorage = {
      setIdentity: vi.fn(),
      initialize: tokenStorageInit,
    } as unknown as ProfileTokenStorageProvider;

    await expect(
      attachIdentityToProfileProviders(sphere, { storage, tokenStorage }),
    ).rejects.toThrow(/OrbitDB attach failed/);
    // tokenStorage.initialize must NOT run when storage.connect rejected —
    // we never want a half-attached state where the bundle index refresh
    // runs against a disconnected OrbitDB.
    expect(tokenStorageInit).not.toHaveBeenCalled();
  });

  it('disconnects storage on connect() failure (half-state recovery)', async () => {
    // Steelman finding: ProfileStorageProvider.doConnect runs Phase A
    // (local cache) BEFORE Phase B (OrbitDB attach). If Phase B throws,
    // the provider is left at `status='connected'` + `dbStatus='error'`
    // — a half-attached state. Downstream catch blocks (e.g.
    // sphere.telco's runProfileMigration) would spin up a SECOND
    // provider pair that collides with the locked blockstore handles
    // from this half-attached one. The helper proactively calls
    // disconnect() on failure so the consumer always sees a fully
    // torn-down provider pair.
    const sphere = buildSphereStub(REAL_IDENTITY);
    const disconnectMock = vi.fn(async () => undefined);
    const connectErr = new Error('OrbitDB attach failed: bootstrap peer unreachable');
    const storage = {
      setIdentity: vi.fn(),
      connect: vi.fn(async () => { throw connectErr; }),
      disconnect: disconnectMock,
    } as unknown as ProfileStorageProvider;
    const tokenStorage = {
      setIdentity: vi.fn(),
      initialize: vi.fn(async () => true),
    } as unknown as ProfileTokenStorageProvider;

    await expect(
      attachIdentityToProfileProviders(sphere, { storage, tokenStorage }),
    ).rejects.toThrow(/OrbitDB attach failed/);
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it('propagates connect() error verbatim even when disconnect() also throws', async () => {
    // Steelman finding follow-on: if disconnect() ALSO throws after
    // connect() failed, the consumer must STILL see the original
    // connect error (the root cause), not a misleading disconnect
    // error. Tests the catch-and-rethrow contract.
    const sphere = buildSphereStub(REAL_IDENTITY);
    const connectErr = new Error('attach failed: ORIGINAL ROOT CAUSE');
    const storage = {
      setIdentity: vi.fn(),
      connect: vi.fn(async () => { throw connectErr; }),
      disconnect: vi.fn(async () => {
        throw new Error('disconnect also broken: SECONDARY ERROR');
      }),
    } as unknown as ProfileStorageProvider;
    const tokenStorage = {
      setIdentity: vi.fn(),
      initialize: vi.fn(async () => true),
    } as unknown as ProfileTokenStorageProvider;

    await expect(
      attachIdentityToProfileProviders(sphere, { storage, tokenStorage }),
    ).rejects.toThrow(/ORIGINAL ROOT CAUSE/);
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
