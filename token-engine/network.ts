// SHA-pinned from unicity-sphere/sphere-sdk main@ce758f6b — do not modify without a re-sync note.
/**
 * token-engine/network.ts — sphere-domain ↔ SDK network mapping.
 *
 * The only sphere→SDK network conversion the engine needs. Aggregator URL and
 * trust base per network are reused from the existing `constants.NETWORKS` +
 * the `impl/<env>/oracle` trust-base loaders by the real factory; this file just
 * maps the network selector to the SDK NetworkId.
 */

import { NetworkId } from './sdk';
import type { SphereNetwork } from './types';

/** Map the sphere network selector to the SDK NetworkId (MAINNET=1/TESTNET=2/LOCAL=3). */
export function toNetworkId(network: SphereNetwork): NetworkId {
  switch (network) {
    case 'mainnet':
      return NetworkId.MAINNET;
    case 'testnet':
      return NetworkId.TESTNET;
    case 'local':
      return NetworkId.LOCAL;
  }
}
