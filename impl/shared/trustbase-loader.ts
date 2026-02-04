/**
 * Shared TrustBase Loader Logic
 * Common embedded trustbase data and base loader
 */

import { TRUSTBASE_TESTNET, TRUSTBASE_MAINNET, TRUSTBASE_DEV } from '../../assets/trustbase';
import type { NetworkType } from '../../constants';

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
    case 'testnet':
      return TRUSTBASE_TESTNET;
    case 'dev':
      return TRUSTBASE_DEV;
    default:
      return TRUSTBASE_TESTNET;
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
