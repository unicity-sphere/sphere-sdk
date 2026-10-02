import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  NETWORKS,
  SPHERE_NETWORKS,
  resolveSphereNetwork,
  type NetworkInfo,
  type SphereNetworkName,
  type SphereNetworkEntry,
} from '../../../constants';
import {
  SPHERE_NETWORKS as SN_CONNECT,
  resolveSphereNetwork as resolveViaConnect,
  type SphereNetworkEntry as ConnectSphereNetworkEntry,
} from '../../../connect';
import type * as Root from '../../../index';
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

  it('round-trips every SPHERE_NETWORKS entry, which also proves the ids are unique', () => {
    for (const entry of Object.values(SPHERE_NETWORKS)) {
      const resolved = resolveSphereNetwork(entry.id);
      expect(resolved).toEqual(entry);
      expect(Object.keys(NETWORKS)).toContain(resolved?.name);
    }
  });

  it('answers with a copy, so enriching the result cannot rewrite SPHERE_NETWORKS', () => {
    const net = resolveSphereNetwork(4)!;
    Object.assign(net, { name: 'renamed', icon: 'x.png' });   // type-checks even on a readonly target
    expect(net).not.toBe(SPHERE_NETWORKS.testnet2);
    expect(SPHERE_NETWORKS.testnet2).toEqual({ id: 4, name: 'testnet2' });
    expect(resolveSphereNetwork(4)).toEqual({ id: 4, name: 'testnet2' });
  });

  it('types the resolved name as a network key, so a switcher needs no cast', () => {
    const net = resolveSphereNetwork(4);
    // Compile-time guard (typecheck:tests): indexing NETWORKS with `net.name` stops
    // compiling if the name is ever widened back to `string | undefined`.
    expect(net && NETWORKS[net.name].networkId).toBe(4);
  });

  it('is reachable from the connect entry point too', () => {
    expect(resolveViaConnect(4)).toEqual({ id: 4, name: 'testnet2' });
  });

  // Compile-time only: `import type` is erased, so the root (which pulls in the whole
  // token-engine) is never loaded at runtime; typecheck:tests is what checks this.
  it('is reachable from the package root too, beside the table it is built from', () => {
    expectTypeOf<typeof Root.resolveSphereNetwork>().toEqualTypeOf<typeof resolveSphereNetwork>();
    expectTypeOf<typeof Root.SPHERE_NETWORKS>().toEqualTypeOf<typeof SPHERE_NETWORKS>();
    expectTypeOf<Root.NetworkInfo>().toEqualTypeOf<NetworkInfo>();
    expectTypeOf<Root.SphereNetworkName>().toEqualTypeOf<SphereNetworkName>();
    expectTypeOf<Root.SphereNetworkEntry>().toEqualTypeOf<SphereNetworkEntry>();
  });

  // Compile-time only, like the block above: the name a consumer types a switcher argument with
  // is the very type the function returns, from every entry that exports it.
  it('names its own return type, from the root, /connect and constants alike', () => {
    expectTypeOf(resolveSphereNetwork).returns.toEqualTypeOf<SphereNetworkEntry | undefined>();
    expectTypeOf<ConnectSphereNetworkEntry>().toEqualTypeOf<SphereNetworkEntry>();
    expectTypeOf<SphereNetworkEntry['name']>().toEqualTypeOf<'mainnet' | 'testnet2'>();
  });
});
