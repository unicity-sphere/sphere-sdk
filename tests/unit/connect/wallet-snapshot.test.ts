/**
 * WalletSnapshot holds NO reference to Sphere, so "nothing is read from a destroyed Sphere
 * while locked" is a property of the types rather than of code review.
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_WALLET_SNAPSHOT,
  buildWalletSnapshot,
} from '../../../connect/host/WalletSnapshot';
import type { SphereInstance } from '../../../connect/host/SphereInstance';

function fakeSphere(overrides: Partial<{ identity: unknown; networkId: number }> = {}) {
  return {
    identity:
      'identity' in overrides
        ? overrides.identity
        : { chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice' },
    networkId: overrides.networkId ?? 4,
  } as unknown as SphereInstance;
}

describe('buildWalletSnapshot', () => {
  it('captures networkId and identity from a bound Sphere', () => {
    const snap = buildWalletSnapshot(fakeSphere());
    expect(snap.networkId).toBe(4);
    expect(snap.identity).toEqual({
      chainPubkey: '02abc123',
      directAddress: 'DIRECT://test',
      nametag: 'alice',
    });
    expect(snap.capturedAt).toBeGreaterThan(0);
  });

  it('returns EMPTY_WALLET_SNAPSHOT for null', () => {
    expect(buildWalletSnapshot(null)).toBe(EMPTY_WALLET_SNAPSHOT);
    expect(EMPTY_WALLET_SNAPSHOT.capturedAt).toBe(0);
    expect(EMPTY_WALLET_SNAPSHOT.identity).toBeUndefined();
    expect(EMPTY_WALLET_SNAPSHOT.networkId).toBeUndefined();
  });

  it('has NO identity when the Sphere has none — never an invented one', () => {
    // sphere_getIdentity while locked must then answer 4009, not undefined-as-success.
    const snap = buildWalletSnapshot(fakeSphere({ identity: null }));
    expect('identity' in snap).toBe(false);
    expect(snap.identity).toBeUndefined();
    expect(snap.networkId).toBe(4);
  });

  it('omits networkId when the Sphere has no numeric one', () => {
    const snap = buildWalletSnapshot({ identity: null, networkId: undefined } as unknown as SphereInstance);
    expect('networkId' in snap).toBe(false);
  });

  it('holds no live reference — mutating the Sphere afterwards changes nothing', () => {
    const sphere = fakeSphere();
    const snap = buildWalletSnapshot(sphere);
    (sphere as unknown as { identity: unknown }).identity = { chainPubkey: '02deadbeef' };
    (sphere as unknown as { networkId: number }).networkId = 99;
    expect(snap.identity?.chainPubkey).toBe('02abc123');
    expect(snap.networkId).toBe(4);
  });

  it('is frozen, so no caller can mutate a captured fact', () => {
    const snap = buildWalletSnapshot(fakeSphere());
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(EMPTY_WALLET_SNAPSHOT)).toBe(true);
  });
});
