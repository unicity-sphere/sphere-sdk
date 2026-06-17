import { describe, it, expect } from 'vitest';
import { NETWORKS, SPHERE_NETWORKS } from '../../../constants';

describe('SPHERE_NETWORKS registry', () => {
  it('exposes testnet2 with the trust-base networkId (4)', () => {
    expect(SPHERE_NETWORKS.testnet2).toEqual({ id: 4, name: 'testnet2' });
  });

  it('is single-sourced from NETWORKS (no drift)', () => {
    expect(SPHERE_NETWORKS.testnet2.id).toBe(NETWORKS.testnet2.networkId);
  });

  it('marks the live v2 networks with networkId 4 (testnet is an alias of testnet2)', () => {
    expect(NETWORKS.testnet2.networkId).toBe(4);
    expect(NETWORKS.testnet.networkId).toBe(4);
  });

  it('does not expose the legacy testnet alias in the dApp-facing registry', () => {
    expect('testnet' in SPHERE_NETWORKS).toBe(false);
  });
});
