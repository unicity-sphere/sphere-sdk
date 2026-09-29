import { describe, it, expect } from 'vitest';
import { NETWORKS, SPHERE_NETWORKS, resolveSphereNetwork } from '../../../constants';
import { SPHERE_NETWORKS as SN_CONNECT, resolveSphereNetwork as resolveViaConnect } from '../../../connect';
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

describe('resolveSphereNetwork', () => {
  it('maps the two live network ids', () => {
    expect(resolveSphereNetwork(1)).toEqual({ id: 1, name: 'mainnet' });
    expect(resolveSphereNetwork(4)).toEqual({ id: 4, name: 'testnet2' });
  });

  it('returns undefined for an id no live network holds', () => {
    expect(resolveSphereNetwork(0)).toBeUndefined();
    expect(resolveSphereNetwork(7)).toBeUndefined();
    expect(resolveSphereNetwork(-1)).toBeUndefined();     // the host's "I do not know" sentinel
  });

  // NEGATIVE CONTROL. This is the whole reason the helper exists: a reverse lookup built from
  // NETWORKS is ambiguous for id 4 and, because `testnet` is declared first, answers with the
  // legacy alias — which no consumer can act on.
  it('never answers with the legacy testnet alias, which a NETWORKS-based lookup would', () => {
    expect(NETWORKS.testnet.networkId).toBe(NETWORKS.testnet2.networkId);
    expect(Object.entries(NETWORKS).find(([, c]) => c.networkId === 4)?.[0]).toBe('testnet');
    expect(resolveSphereNetwork(4)?.name).toBe('testnet2');
  });

  it('every SPHERE_NETWORKS name is a key of NETWORKS, so a resolved name can be used as one', () => {
    for (const entry of Object.values(SPHERE_NETWORKS)) {
      expect(Object.keys(NETWORKS)).toContain(entry.name);
    }
  });

  it('is reachable from the connect entry point too', () => {
    expect(resolveViaConnect(4)).toEqual({ id: 4, name: 'testnet2' });
  });
});
