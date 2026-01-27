/**
 * Browser Oracle Exports
 * Re-exports shared oracle with browser-specific TrustBaseLoader
 */

import {
  UnicityAggregatorProvider,
  type UnicityAggregatorProviderConfig,
} from '../../../oracle/UnicityAggregatorProvider';
import type { TrustBaseLoader } from '../../../oracle/oracle-provider';

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
 * Browser TrustBase loader using fetch
 */
export class BrowserTrustBaseLoader implements TrustBaseLoader {
  private url: string;

  constructor(url: string = '/trustbase-testnet.json') {
    this.url = url;
  }

  async load(): Promise<unknown | null> {
    try {
      const response = await fetch(this.url);
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Ignore fetch errors
    }
    return null;
  }
}

/**
 * Create browser TrustBase loader
 */
export function createBrowserTrustBaseLoader(url?: string): TrustBaseLoader {
  return new BrowserTrustBaseLoader(url);
}

// =============================================================================
// Browser Factory
// =============================================================================

/**
 * Create UnicityAggregatorProvider with browser TrustBase loader
 * Convenience factory that injects browser-specific loader
 */
export function createUnicityAggregatorProvider(
  config: Omit<UnicityAggregatorProviderConfig, 'trustBaseLoader'> & {
    trustBaseUrl?: string;
  }
): UnicityAggregatorProvider {
  const { trustBaseUrl, ...restConfig } = config;
  return new UnicityAggregatorProvider({
    ...restConfig,
    trustBaseLoader: createBrowserTrustBaseLoader(trustBaseUrl),
  });
}

/** @deprecated Use createUnicityAggregatorProvider instead */
export const createUnicityOracleProvider = createUnicityAggregatorProvider;
