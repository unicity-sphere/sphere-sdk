import { describe, it, expect } from 'vitest';
import { NETWORKS, SPHERE_NETWORKS } from '../../../constants';
import { SPHERE_NETWORKS as SN_CONNECT } from '../../../connect';
import { checkCompatibility } from '../../../connect/compatibility';
import { SPHERE_CONNECT_VERSION } from '../../../connect/protocol';

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

describe('SPHERE_NETWORKS via the connect entry point', () => {
  it('is re-exported from @unicitylabs/sphere-sdk/connect', () => {
    expect(SN_CONNECT.testnet2.id).toBe(4);
  });

  it('drives the gate: declaring SPHERE_NETWORKS.testnet2 matches a wallet on network 4', () => {
    const r = checkCompatibility({
      clientProtocol: SPHERE_CONNECT_VERSION,
      walletProtocol: SPHERE_CONNECT_VERSION,
      clientNetwork: SN_CONNECT.testnet2,
      walletNetworkId: 4,
    });
    expect(r.ok).toBe(true);
  });
});
