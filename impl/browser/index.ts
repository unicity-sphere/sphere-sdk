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
export * from './download';

// Re-export shared types for convenience
export type {
  BaseTransportConfig,
  BaseOracleConfig,
  L1Config,
  BaseProviders,
} from '../shared';

// =============================================================================
// Convenience Factory
// =============================================================================

import { createLocalStorageProvider, type LocalStorageProviderConfig, createIndexedDBTokenStorageProvider } from './storage';
import { createNostrTransportProvider } from './transport';
import { createUnicityAggregatorProvider } from './oracle';
import { createBrowserIpfsStorageProvider } from './ipfs';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../storage';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { NetworkType } from '../../constants';
import type { GroupChatModuleConfig } from '../../modules/groupchat';
import type { PriceProvider } from '../../price';
import { createPriceProvider } from '../../price';
import { TokenRegistry } from '../../registry';
import {
  type BaseTransportConfig,
  type BaseOracleConfig,
  type BasePriceConfig,
  type L1Config,
  type BrowserTransportExtensions,
  resolveTransportConfig,
  resolveOracleConfig,
  resolveL1Config,
  resolvePriceConfig,
  resolveArrayConfig,
  getNetworkConfig,
  resolveGroupChatConfig,
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

/**
 * IPFS sync backend configuration
 */
export interface IpfsSyncConfig {
  /** Enable IPFS sync (default: false) */
  enabled?: boolean;
  /** Replace default gateways entirely */
  gateways?: string[];
  /** Add gateways to network defaults */
  additionalGateways?: string[];
  /** Replace default bootstrap peers */
  bootstrapPeers?: string[];
  /** Add bootstrap peers to defaults */
  additionalBootstrapPeers?: string[];
  /** Use browser DHT (Helia) vs HTTP-only mode */
  useDht?: boolean;
}

/**
 * File sync backend configuration (future)
 */
export interface FileSyncConfig {
  /** Enable file sync (default: false) */
  enabled?: boolean;
  /** Directory path for token files */
  directory?: string;
  /** File format: 'json' | 'txf' */
  format?: 'json' | 'txf';
}

/**
 * Cloud sync backend configuration (future)
 */
export interface CloudSyncConfig {
  /** Enable cloud sync (default: false) */
  enabled?: boolean;
  /** Cloud provider */
  provider?: 'aws' | 'gcp' | 'azure' | 'custom';
  /** Bucket/container name */
  bucket?: string;
  /** API endpoint (for custom provider) */
  endpoint?: string;
  /** API key or credentials */
  apiKey?: string;
}

/**
 * MongoDB sync backend configuration
 */
export interface MongoDbSyncConfig {
  /** Enable MongoDB sync (default: false) */
  enabled?: boolean;
  /** MongoDB connection URI */
  uri?: string;
  /** Database name */
  database?: string;
  /** Collection name (default: 'tokens') */
  collection?: string;
  /** Enable authentication */
  authEnabled?: boolean;
  /** Username (if authEnabled) */
  username?: string;
  /** Password (if authEnabled) */
  password?: string;
}

/**
 * Token sync configuration - supports multiple backends
 */
export interface TokenSyncConfig {
  /** IPFS sync backend */
  ipfs?: IpfsSyncConfig;
  /** File sync backend (future) */
  file?: FileSyncConfig;
  /** Cloud sync backend (future) */
  cloud?: CloudSyncConfig;
  /** MongoDB sync backend */
  mongodb?: MongoDbSyncConfig;
}

// =============================================================================
// Browser Providers Configuration
// =============================================================================

export interface BrowserProvidersConfig {
  /** Network preset: mainnet, testnet, or dev. Sets default URLs for all services */
  network?: NetworkType;
  /** Storage configuration (localStorage) */
  storage?: LocalStorageProviderConfig;
  /** Transport (Nostr) configuration - supports extend/override pattern */
  transport?: TransportConfig;
  /** Oracle (Aggregator) configuration - supports extend/override pattern */
  oracle?: OracleConfig;
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1Config;
  /**
   * Token sync backends configuration
   * Supports multiple backends: IPFS, file, cloud (future)
   * Each backend can be enabled/disabled independently
   */
  tokenSync?: TokenSyncConfig;
  /** Price provider configuration (optional — enables fiat value display) */
  price?: BasePriceConfig;
  /** Group chat (NIP-29) configuration. true = enable with defaults, object = custom config */
  groupChat?: { enabled?: boolean; relays?: string[] } | boolean;
}

export interface BrowserProviders {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
  /** Token storage provider for local persistence (IndexedDB) */
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  /** L1 configuration (for passing to Sphere.init) */
  l1?: L1Config;
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
  /** IPFS token storage provider (when tokenSync.ipfs.enabled is true) */
  ipfsTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Group chat config (resolved, for passing to Sphere.init) */
  groupChat?: GroupChatModuleConfig | boolean;
  /**
   * Token sync configuration (resolved from tokenSync options)
   * For advanced use cases when additional sync backends are needed
   * @deprecated Use tokenStorage provider instead. For custom sync backends,
   * use Sphere.addTokenStorageProvider() after initialization.
   */
  tokenSyncConfig?: {
    ipfs?: {
      enabled: boolean;
      gateways: string[];
      bootstrapPeers?: string[];
      useDht?: boolean;
    };
    file?: {
      enabled: boolean;
      directory?: string;
      format?: 'json' | 'txf';
    };
    cloud?: {
      enabled: boolean;
      provider?: string;
      bucket?: string;
      endpoint?: string;
      apiKey?: string;
    };
    mongodb?: {
      enabled: boolean;
      uri?: string;
      database?: string;
      collection?: string;
    };
  };
}

// =============================================================================
// Token Sync Resolution
// =============================================================================

/**
 * Resolve IPFS sync configuration with extend/override pattern
 */
function resolveIpfsSyncConfig(
  network: NetworkType,
  config?: IpfsSyncConfig
): NonNullable<BrowserProviders['tokenSyncConfig']>['ipfs'] | undefined {
  if (!config) return undefined;

  const networkConfig = getNetworkConfig(network);
  const gateways = resolveArrayConfig(
    networkConfig.ipfsGateways,
    config.gateways,
    config.additionalGateways
  );

  return {
    enabled: config.enabled ?? false,
    gateways,
    bootstrapPeers: config.bootstrapPeers ?? config.additionalBootstrapPeers,
    useDht: config.useDht,
  };
}

/**
 * Resolve all token sync backends
 */
function resolveTokenSyncConfig(
  network: NetworkType,
  config?: TokenSyncConfig
): BrowserProviders['tokenSyncConfig'] {
  if (!config) return undefined;

  const result: BrowserProviders['tokenSyncConfig'] = {};

  // IPFS backend
  const ipfs = resolveIpfsSyncConfig(network, config.ipfs);
  if (ipfs) result.ipfs = ipfs;

  // File backend
  if (config.file) {
    result.file = {
      enabled: config.file.enabled ?? false,
      directory: config.file.directory,
      format: config.file.format,
    };
  }

  // Cloud backend
  if (config.cloud) {
    result.cloud = {
      enabled: config.cloud.enabled ?? false,
      provider: config.cloud.provider,
      bucket: config.cloud.bucket,
      endpoint: config.cloud.endpoint,
      apiKey: config.cloud.apiKey,
    };
  }

  // MongoDB backend
  if (config.mongodb) {
    result.mongodb = {
      enabled: config.mongodb.enabled ?? false,
      uri: config.mongodb.uri,
      database: config.mongodb.database,
      collection: config.mongodb.collection,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

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
 * // Use with Sphere.init (tokenStorage is automatically included)
 * const { sphere } = await Sphere.init({
 *   ...providers,
 *   autoGenerate: true,
 * });
 *
 * // Add additional sync backends dynamically after init
 * // await sphere.addTokenStorageProvider(myMongoDbProvider);
 * ```
 */
export function createBrowserProviders(config?: BrowserProvidersConfig): BrowserProviders {
  const network = config?.network ?? 'mainnet';

  // Resolve configurations using shared utilities
  const transportConfig = resolveTransportConfig(network, config?.transport);
  const oracleConfig = resolveOracleConfig(network, config?.oracle);
  const l1Config = resolveL1Config(network, config?.l1);
  const tokenSyncConfig = resolveTokenSyncConfig(network, config?.tokenSync);
  const priceConfig = resolvePriceConfig(config?.price);

  const storage = createLocalStorageProvider(config?.storage);

  // Create IPFS storage provider if enabled
  const ipfsConfig = tokenSyncConfig?.ipfs;
  const ipfsTokenStorage = ipfsConfig?.enabled
    ? createBrowserIpfsStorageProvider({
        gateways: ipfsConfig.gateways,
        debug: config?.tokenSync?.ipfs?.useDht, // reuse debug-like flag
      })
    : undefined;

  // Resolve group chat config
  const groupChat = resolveGroupChatConfig(network, config?.groupChat);

  // Configure token registry remote refresh with persistent cache
  const networkConfig = getNetworkConfig(network);
  TokenRegistry.configure({ remoteUrl: networkConfig.tokenRegistryUrl, storage });

  return {
    storage,
    groupChat,
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
    tokenStorage: createIndexedDBTokenStorageProvider(),
    l1: l1Config,
    price: priceConfig ? createPriceProvider(priceConfig) : undefined,
    ipfsTokenStorage,
    tokenSyncConfig,
  };
}
