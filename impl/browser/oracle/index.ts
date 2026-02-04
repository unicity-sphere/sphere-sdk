/**
 * Browser Oracle Exports
 * Re-exports shared oracle with browser-specific TrustBaseLoader
 */

import {
  UnicityAggregatorProvider,
  type UnicityAggregatorProviderConfig,
} from '../../../oracle/UnicityAggregatorProvider';
import type { TrustBaseLoader } from '../../../oracle/oracle-provider';
import { BaseTrustBaseLoader } from '../../shared/trustbase-loader';
import type { NetworkType } from '../../../constants';

// Re-export shared types and classes
export {
  UnicityAggregatorProvider,
  type UnicityAggregatorProviderConfig,
  UnicityOracleProvider,
  type UnicityOracleProviderConfig,
} from '../../../oracle/UnicityAggregatorProvider';

export type { TrustBaseLoader } from '../../../oracle/oracle-provider';

// =============================================================================
// Browser TrustBase Loader
// =============================================================================

/**
 * Browser TrustBase loader - fetches from URL or uses embedded data
 */
export class BrowserTrustBaseLoader extends BaseTrustBaseLoader {
  private url?: string;

  constructor(networkOrUrl: NetworkType | string = 'testnet') {
    if (networkOrUrl.startsWith('/') || networkOrUrl.startsWith('http')) {
      super('testnet');
      this.url = networkOrUrl;
    } else {
      super(networkOrUrl as NetworkType);
    }
  }

  protected async loadFromExternal(): Promise<unknown | null> {
    if (!this.url) return null;

    try {
      const response = await fetch(this.url);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Fall through to embedded
    }
    return null;
  }
}

/**
 * Create browser TrustBase loader
 */
export function createBrowserTrustBaseLoader(networkOrUrl?: NetworkType | string): TrustBaseLoader {
  return new BrowserTrustBaseLoader(networkOrUrl);
}

// =============================================================================
// Browser Factory
// =============================================================================

/**
 * Create UnicityAggregatorProvider with browser TrustBase loader
 */
export function createUnicityAggregatorProvider(
  config: Omit<UnicityAggregatorProviderConfig, 'trustBaseLoader'> & {
    trustBaseUrl?: string;
    network?: NetworkType;
  }
): UnicityAggregatorProvider {
  const { trustBaseUrl, network, ...restConfig } = config;
  return new UnicityAggregatorProvider({
    ...restConfig,
    trustBaseLoader: createBrowserTrustBaseLoader(trustBaseUrl ?? network ?? 'testnet'),
  });
}

/** @deprecated Use createUnicityAggregatorProvider instead */
export const createUnicityOracleProvider = createUnicityAggregatorProvider;
