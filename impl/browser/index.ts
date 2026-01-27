/**
 * Browser-specific implementations
 * All platform-dependent code lives here
 */

export * from './storage';
export * from './transport';
export * from './oracle';
export * from './download';

// =============================================================================
// Convenience Factory
// =============================================================================

import { createLocalStorageProvider, type LocalStorageProviderConfig } from './storage';
import { createNostrTransportProvider, type NostrTransportProviderConfig } from './transport';
import { createUnicityAggregatorProvider, type UnicityAggregatorProviderConfig } from './oracle';
import type { StorageProvider } from '../../storage';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';

export interface BrowserProvidersConfig {
  storage?: LocalStorageProviderConfig;
  transport?: NostrTransportProviderConfig;
  oracle?: UnicityAggregatorProviderConfig;
}

export interface BrowserProviders {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
}

/**
 * Create all browser providers with default configuration
 *
 * @example
 * ```ts
 * const providers = createBrowserProviders();
 * await sphere.initialize(providers);
 *
 * // Or with custom config:
 * const providers = createBrowserProviders({
 *   oracle: { url: 'https://custom-aggregator.example.com' },
 *   transport: { relays: ['wss://custom-relay.example.com'] },
 * });
 * ```
 */
export function createBrowserProviders(config?: BrowserProvidersConfig): BrowserProviders {
  return {
    storage: createLocalStorageProvider(config?.storage),
    transport: createNostrTransportProvider(config?.transport),
    oracle: createUnicityAggregatorProvider(config?.oracle ?? { url: '/rpc' }),
  };
}
