/**
 * Browser-specific implementations
 * All platform-dependent code lives here
 */

// Polyfill Buffer for browser environment
// Many crypto libraries depend on Node.js Buffer API
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}

export * from './storage';
export * from './transport';
export * from './oracle';
// Wallet-api storage provider (platform-neutral, sdk-changes S2)
export * from '../shared/wallet-api';

export * from './download';

// Re-export shared types for convenience
export type {
  BaseTransportConfig,
  BaseOracleConfig,
  BaseProviders,
} from '../shared';

// =============================================================================
// Convenience Factory
// =============================================================================

import { logger as sdkLogger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { assertNetworkConsistency } from '../shared/network';
import { createIndexedDBStorageProvider, type IndexedDBStorageProviderConfig } from './storage';
import { createNostrTransportProvider } from './transport';
import { createUnicityAggregatorProvider } from './oracle';
import type { StorageProvider } from '../../storage';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { NetworkType } from '../../constants';
import type { GroupChatModuleConfig } from '../../modules/groupchat';
import type { MarketModuleConfig } from '../../modules/market';
import type { PriceProvider } from '../../price';
import { createPriceProvider } from '../../price';
import { TokenRegistry } from '../../registry';
import {
  type BaseTransportConfig,
  type BaseOracleConfig,
  type BasePriceConfig,
  type BaseMarketConfig,
  type BrowserTransportExtensions,
  resolveTransportConfig,
  resolveOracleConfig,
  resolvePriceConfig,
  getNetworkConfig,
  resolveGroupChatConfig,
  resolveMarketConfig,
} from '../shared';

// =============================================================================
// Browser-Specific Configuration Extensions
// =============================================================================

/**
 * Browser transport configuration
 * Extends base with browser-specific options
 */
export type TransportConfig = BaseTransportConfig & BrowserTransportExtensions;

/**
 * Browser oracle configuration
 * Same as base (no browser-specific extensions)
 */
export type OracleConfig = BaseOracleConfig;

// =============================================================================
// Token Sync Backend Configurations
// =============================================================================

// =============================================================================
// Browser Providers Configuration
// =============================================================================

export interface BrowserProvidersConfig {
  /** Network preset: mainnet, testnet, or dev. Sets default URLs for all services */
  network?: NetworkType;
  /** Enable debug logging globally for all providers (default: false). Per-provider debug flags override this. */
  debug?: boolean;
  /** Storage configuration (IndexedDB) */
  storage?: IndexedDBStorageProviderConfig;
  /** Transport (Nostr) configuration - supports extend/override pattern */
  transport?: TransportConfig;
  /** Oracle (Aggregator) configuration - supports extend/override pattern */
  oracle?: OracleConfig;
  /**
   * Token sync backends configuration
   * Supports multiple backends: IPFS, file, cloud (future)
   * Each backend can be enabled/disabled independently
   */
  /** Price provider configuration (optional — enables fiat value display) */
  price?: BasePriceConfig;
  /** Group chat (NIP-29) configuration. true = enable with defaults, object = custom config */
  groupChat?: { enabled?: boolean; relays?: string[] } | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config */
  market?: BaseMarketConfig | boolean;
}

export interface BrowserProviders {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
  /** Group chat config (resolved, for passing to Sphere.init) */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module config (resolved, for passing to Sphere.init) */
  market?: MarketModuleConfig | boolean;
}

// =============================================================================
// Token Sync Resolution
// =============================================================================

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create all browser providers with default configuration
 *
 * Supports extend/override pattern for flexible configuration:
 * - Use `network` preset for quick setup (mainnet/testnet/dev)
 * - Override specific values (e.g., `oracle.url` replaces default)
 * - Extend arrays with `additional*` (e.g., `additionalRelays` adds to defaults)
 *
 * @example
 * ```ts
 * // Simple - uses mainnet defaults
 * const providers = createBrowserProviders();
 *
 * // Testnet - all services use testnet URLs
 * const providers = createBrowserProviders({ network: 'testnet' });
 *
 * // Add extra relays to testnet defaults
 * const providers = createBrowserProviders({
 *   network: 'testnet',
 *   transport: {
 *     additionalRelays: ['wss://my-relay.com', 'wss://backup-relay.com'],
 *   },
 * });
 *
 * // Replace relays entirely (ignores network defaults)
 * const providers = createBrowserProviders({
 *   network: 'testnet',
 *   transport: {
 *     relays: ['wss://only-this-relay.com'],
 *   },
 * });
 *
 * // Use with Sphere.init (add the wallet-api transport config)
 * const { sphere } = await Sphere.init({
 *   ...createWalletApiProviders(providers, { baseUrl, network: 'testnet' }),
 *   autoGenerate: true,
 * });
 * ```
 */
export function createBrowserProviders(config?: BrowserProvidersConfig): BrowserProviders {
  // Fail loud: a missing network would silently load the wrong-network providers.
  if (!config?.network) {
    throw new SphereError('createBrowserProviders: config.network is required.', 'INVALID_CONFIG');
  }
  const network = config.network;
  // Refuse provably-broken networks (e.g. a null/mismatched trust base would
  // silently accept unverified tokens) before building any provider.
  assertNetworkConsistency(network);

  // Configure global logger: top-level debug enables all, per-provider overrides are additive.
  // Only override global debug flag when explicitly provided — don't reset a previously-configured value.
  if (config?.debug !== undefined) {
    sdkLogger.configure({ debug: config.debug });
  }
  if (config?.transport?.debug) sdkLogger.setTagDebug('Nostr', true);
  if (config?.oracle?.debug) sdkLogger.setTagDebug('Aggregator', true);
  if (config?.price?.debug) sdkLogger.setTagDebug('Price', true);

  // Resolve configurations using shared utilities
  const transportConfig = resolveTransportConfig(network, config?.transport);
  const oracleConfig = resolveOracleConfig(network, config?.oracle);

  const storage = createIndexedDBStorageProvider({ ...config?.storage, network });
  const priceConfig = resolvePriceConfig(config?.price, storage);

  // Resolve group chat config
  const groupChat = resolveGroupChatConfig(network, config?.groupChat);

  // Resolve market config
  const market = resolveMarketConfig(config?.market);

  // Configure token registry remote refresh with persistent cache
  const networkConfig = getNetworkConfig(network);
  TokenRegistry.configure({ remoteUrl: networkConfig.tokenRegistryUrl, storage });

  return {
    storage,
    groupChat,
    market,
    transport: createNostrTransportProvider({
      relays: transportConfig.relays,
      timeout: transportConfig.timeout,
      autoReconnect: transportConfig.autoReconnect,
      reconnectDelay: transportConfig.reconnectDelay,
      maxReconnectAttempts: transportConfig.maxReconnectAttempts,
      debug: transportConfig.debug,
      storage,
    }),
    oracle: createUnicityAggregatorProvider({
      url: oracleConfig.url,
      apiKey: oracleConfig.apiKey,
      timeout: oracleConfig.timeout,
      skipVerification: oracleConfig.skipVerification,
      debug: oracleConfig.debug,
      network,
    }),
    price: priceConfig ? createPriceProvider(priceConfig) : undefined,
  };
}
