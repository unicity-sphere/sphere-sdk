/**
 * Tests for `Sphere._withFullIdentityForProfileFactory` (Issue #292)
 *
 * The accessor is the SDK-private bridge through which the Sphere-bound
 * Profile factories obtain the live `FullIdentity` to attach to their
 * providers. Critical contract:
 *
 *   1. NOT_INITIALIZED when no identity is bound — clear error, NOT
 *      a `hexToBytes: empty hex string` RangeError.
 *   2. Snapshots the identity into a local const so a concurrent mutation
 *      cannot corrupt the callback's view.
 *   3. Scrubs the snapshot's privateKey reference after the callback to
 *      reduce GC retention of the secret.
 *   4. Does NOT return the identity — the only escape route is via the
 *      callback, which the helper layer confines to `setIdentity` calls.
 *
 * The method is `@internal` but accessible as a regular property since
 * TypeScript's underscore convention does not enforce runtime privacy.
 * Tests exercise it via type-erased access on a partial Sphere harness.
 */

import { describe, it, expect, vi } from 'vitest';
import { Sphere } from '../../../core/Sphere';
import type { FullIdentity } from '../../../types';

const REAL_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://test',
  privateKey: '00' + '11'.repeat(31),
};

interface SphereInternalAccess {
  _identity: FullIdentity | null;
  _withFullIdentityForProfileFactory(cb: (id: FullIdentity) => void): void;
}

function makeBareSphere(identity: FullIdentity | null): SphereInternalAccess {
  const inst = Object.create(Sphere.prototype) as SphereInternalAccess;
  inst._identity = identity;
  return inst;
}

describe('Sphere._withFullIdentityForProfileFactory', () => {
  it('invokes callback with FullIdentity including privateKey', () => {
    const sphere = makeBareSphere(REAL_IDENTITY);
    const cb = vi.fn();

    sphere._withFullIdentityForProfileFactory(cb);

    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toMatchObject({
      chainPubkey: REAL_IDENTITY.chainPubkey,
      l1Address: REAL_IDENTITY.l1Address,
      directAddress: REAL_IDENTITY.directAddress,
      privateKey: REAL_IDENTITY.privateKey,
    });
  });

  it('throws NOT_INITIALIZED when no identity is set', () => {
    const sphere = makeBareSphere(null);
    expect(() =>
      sphere._withFullIdentityForProfileFactory(() => undefined),
    ).toThrow(/Wallet not initialized/);
  });

  it('throws NOT_INITIALIZED when identity is set but privateKey is empty string', () => {
    const sphere = makeBareSphere({
      ...REAL_IDENTITY,
      privateKey: '',
    });
    expect(() =>
      sphere._withFullIdentityForProfileFactory(() => undefined),
    ).toThrow(/Wallet not initialized/);
  });

  it('NOT a `hexToBytes` RangeError when privateKey is empty (Issue #292 regression guard)', () => {
    const sphere = makeBareSphere({
      ...REAL_IDENTITY,
      privateKey: '',
    });
    expect(() =>
      sphere._withFullIdentityForProfileFactory(() => undefined),
    ).not.toThrow(/hexToBytes/);
  });

  it('snapshots identity so a concurrent mutation does not corrupt the callback', () => {
    const sphere = makeBareSphere(REAL_IDENTITY);
    let observedPrivateKey: string | undefined;
    sphere._withFullIdentityForProfileFactory((id) => {
      // Simulate a concurrent identity rotation that swaps _identity
      // mid-callback. The callback's `id` parameter is a snapshot, so
      // it should still see the original privateKey.
      sphere._identity = { ...REAL_IDENTITY, privateKey: 'DEADBEEF' };
      observedPrivateKey = id.privateKey;
    });
    expect(observedPrivateKey).toBe(REAL_IDENTITY.privateKey);
  });

  it('snapshot is a fresh object distinct from Sphere._identity', () => {
    const sphere = makeBareSphere(REAL_IDENTITY);
    let snapshot: FullIdentity | undefined;
    sphere._withFullIdentityForProfileFactory((id) => {
      snapshot = id;
    });
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toBe(sphere._identity);
    // Same field values, different object identity — mutating the
    // snapshot does not affect Sphere's authoritative copy (except
    // where the provider intentionally retains the reference, which
    // is its own contract).
    expect(snapshot?.privateKey).toBe(REAL_IDENTITY.privateKey);
  });

  it('returns void (no escape route for the identity outside the callback)', () => {
    const sphere = makeBareSphere(REAL_IDENTITY);
    const result = sphere._withFullIdentityForProfileFactory(() => undefined);
    expect(result).toBeUndefined();
  });

  it('callback throw propagates', () => {
    const sphere = makeBareSphere(REAL_IDENTITY);
    expect(() =>
      sphere._withFullIdentityForProfileFactory(() => {
        throw new Error('downstream error');
      }),
    ).toThrow(/downstream error/);
  });
});
