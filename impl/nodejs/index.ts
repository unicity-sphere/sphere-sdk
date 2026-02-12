/**
 * Node.js Implementation
 * Providers for CLI/Node.js usage
 */

// Storage
export * from './storage';

// Transport
export * from './transport';

// Oracle
export * from './oracle';

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

import { createFileStorageProvider, createFileTokenStorageProvider } from './storage';
import { createNostrTransportProvider } from './transport';
import { createUnicityAggregatorProvider } from './oracle';
import { createNodeIpfsStorageProvider } from './ipfs';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../storage';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { PriceProvider } from '../../price';
import { createPriceProvider } from '../../price';
import { TokenRegistry } from '../../registry';
import type { NetworkType } from '../../constants';
import type { GroupChatModuleConfig } from '../../modules/groupchat';
import type { MarketModuleConfig } from '../../modules/market';
import type { IpfsStorageConfig } from '../shared/ipfs';
import {
  type BaseTransportConfig,
  type BaseOracleConfig,
  type BasePriceConfig,
  type BaseMarketConfig,
  type L1Config,
  type NodeOracleExtensions,
  resolveTransportConfig,
  resolveOracleConfig,
  resolveL1Config,
  resolvePriceConfig,
  resolveGroupChatConfig,
  getNetworkConfig,
  resolveMarketConfig,
} from '../shared';

// =============================================================================
// Node.js-Specific Configuration Extensions
// =============================================================================

/**
 * Node.js transport configuration
 * Same as base (no Node.js-specific extensions)
 */
export type NodeTransportConfig = BaseTransportConfig;

/**
 * Node.js oracle configuration
 * Extends base with trustBasePath for file-based trust base
 */
export type NodeOracleConfig = BaseOracleConfig & NodeOracleExtensions;

/**
 * Node.js L1 configuration
 * Same as base
 */
export type NodeL1Config = L1Config;

// =============================================================================
// Node.js Providers Configuration
// =============================================================================

/** Node.js IPFS sync configuration */
export interface NodeIpfsSyncConfig {
  /** Enable IPFS sync (default: false) */
  enabled?: boolean;
  /** IPFS storage provider configuration */
  config?: IpfsStorageConfig;
}

/** Node.js token sync configuration */
export interface NodeTokenSyncConfig {
  /** IPFS sync backend */
  ipfs?: NodeIpfsSyncConfig;
}

export interface NodeProvidersConfig {
  /** Network preset: mainnet, testnet, or dev */
  network?: NetworkType;
  /** Directory for wallet data storage */
  dataDir?: string;
  /** Wallet file name (default: 'wallet.json') */
  walletFileName?: string;
  /** Directory for token files */
  tokensDir?: string;
  /** Transport (Nostr) configuration */
  transport?: NodeTransportConfig;
  /** Oracle (Aggregator) configuration */
  oracle?: NodeOracleConfig;
  /** L1 (ALPHA blockchain) configuration */
  l1?: NodeL1Config;
  /** Price provider configuration (optional — enables fiat value display) */
  price?: BasePriceConfig;
  /** Token sync backends configuration */
  tokenSync?: NodeTokenSyncConfig;
  /** Group chat (NIP-29) configuration. true = enable with defaults, object = custom config */
  groupChat?: { enabled?: boolean; relays?: string[] } | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config */
  market?: BaseMarketConfig | boolean;
}

export interface NodeProviders {
  storage: StorageProvider;
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  transport: TransportProvider;
  oracle: OracleProvider;
  /** L1 configuration (for passing to Sphere.init) */
  l1?: L1Config;
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
  /** IPFS token storage provider (when tokenSync.ipfs.enabled is true) */
  ipfsTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Group chat config (resolved, for passing to Sphere.init) */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module config (resolved, for passing to Sphere.init) */
  market?: MarketModuleConfig | boolean;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create all Node.js providers with default configuration
 *
 * @example
 * ```ts
 * // Simple - testnet with defaults
 * const providers = createNodeProviders({
 *   network: 'testnet',
 *   tokensDir: './tokens',
 * });
 *
 * // Full configuration
 * const providers = createNodeProviders({
 *   network: 'testnet',
 *   dataDir: './wallet-data',
 *   tokensDir: './tokens',
 *   transport: {
 *     additionalRelays: ['wss://my-relay.com'],
 *     debug: true,
 *   },
 *   oracle: {
 *     apiKey: 'my-api-key',
 *     trustBasePath: './trustbase.json',
 *   },
 *   l1: {
 *     enableVesting: true,
 *   },
 * });
 *
 * // Use with Sphere.init
 * const { sphere } = await Sphere.init({
 *   ...providers,
 *   autoGenerate: true,
 * });
 * ```
 */
export function createNodeProviders(config?: NodeProvidersConfig): NodeProviders {
  const network = config?.network ?? 'mainnet';

  // Resolve configurations using shared utilities
  const transportConfig = resolveTransportConfig(network, config?.transport);
  const oracleConfig = resolveOracleConfig(network, config?.oracle);
  const l1Config = resolveL1Config(network, config?.l1);
  const priceConfig = resolvePriceConfig(config?.price);

  const storage = createFileStorageProvider({
    dataDir: config?.dataDir ?? './sphere-data',
    ...(config?.walletFileName ? { fileName: config.walletFileName } : {}),
  });

  // Create IPFS storage provider if enabled
  const ipfsSync = config?.tokenSync?.ipfs;
  const ipfsTokenStorage = ipfsSync?.enabled
    ? createNodeIpfsStorageProvider(ipfsSync.config, storage)
    : undefined;

  // Resolve group chat config
  const groupChat = resolveGroupChatConfig(network, config?.groupChat);

  // Configure token registry remote refresh with persistent cache
  const networkConfig = getNetworkConfig(network);
  TokenRegistry.configure({ remoteUrl: networkConfig.tokenRegistryUrl, storage });

  // Resolve market config
  const market = resolveMarketConfig(config?.market);

  return {
    storage,
    groupChat,
    market,
    tokenStorage: createFileTokenStorageProvider({
      tokensDir: config?.tokensDir ?? './sphere-tokens',
    }),
    transport: createNostrTransportProvider({
      relays: transportConfig.relays,
      timeout: transportConfig.timeout,
      autoReconnect: transportConfig.autoReconnect,
      debug: transportConfig.debug,
      storage,
    }),
    oracle: createUnicityAggregatorProvider({
      url: oracleConfig.url,
      apiKey: oracleConfig.apiKey,
      timeout: oracleConfig.timeout,
      trustBasePath: oracleConfig.trustBasePath,
      skipVerification: oracleConfig.skipVerification,
      debug: oracleConfig.debug,
      network,
    }),
    l1: l1Config,
    price: priceConfig ? createPriceProvider(priceConfig) : undefined,
    ipfsTokenStorage,
  };
}
