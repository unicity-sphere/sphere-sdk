/**
 * Shared TrustBase Loader Logic
 * Common embedded trustbase data and base loader
 */

import { TRUSTBASE_TESTNET2, TRUSTBASE_MAINNET } from '../../assets/trustbase';
import type { NetworkType } from '../../constants';
import { SphereError } from '../../core/errors';

export interface TrustBaseLoader {
  load(): Promise<unknown | null>;
}

/**
 * Get embedded trustbase data by network
 */
export function getEmbeddedTrustBase(network: NetworkType): unknown | null {
  switch (network) {
    case 'mainnet':
      return TRUSTBASE_MAINNET;
    // v1 cutover: 'testnet' is now an alias of testnet2 (NETWORKS.testnet points
    // at the testnet2 gateway), so it MUST resolve the testnet2 trust base —
    // a mismatched trust base would make the engine reject every proof.
    case 'testnet':
    case 'testnet2':
      return TRUSTBASE_TESTNET2;
    default:
      // Fail loud: an unknown network must not silently resolve to the testnet trust base.
      throw new SphereError(`getEmbeddedTrustBase: unknown network "${network}"`, 'INVALID_CONFIG');
  }
}

/**
 * Base TrustBase loader with embedded fallback
 */
export abstract class BaseTrustBaseLoader implements TrustBaseLoader {
  protected network: NetworkType;

  constructor(network: NetworkType = 'testnet') {
    this.network = network;
  }

  /**
   * Try to load from external source (file, URL, etc.)
   * Override in subclass
   */
  protected abstract loadFromExternal(): Promise<unknown | null>;

  async load(): Promise<unknown | null> {
    // Try external source first
    const external = await this.loadFromExternal();
    if (external) {
      return external;
    }

    // Fallback to embedded data
    return getEmbeddedTrustBase(this.network);
  }
}
