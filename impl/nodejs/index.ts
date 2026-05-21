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

import { logger as sdkLogger } from '../../core/logger';
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
import { createUxfCarPublisher } from '../../modules/payments/transfer/ipfs-publisher';
import type { PublishToIpfsCallback } from '../../modules/payments/transfer/delivery-resolver';
import { DEFAULT_IPFS_GATEWAYS } from '../../constants';
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
  resolveMarketConfig,
  getNetworkConfig,
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

/**
 * Node.js IPFS sync configuration.
 *
 * @deprecated The IPNS-based mutable-pointer flow this config opts into
 * is superseded by the Profile token-storage path (OrbitDB + aggregator
 * pointer + IPFS CAR). See `createNodeProfileProviders` and the
 * `IpfsStorageProvider` JSDoc. This config remains functional for
 * backward compatibility.
 */
export interface NodeIpfsSyncConfig {
  /** Enable IPFS sync (default: false). @deprecated — see {@link NodeIpfsSyncConfig}. */
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
  /** Enable debug logging globally for all providers (default: false). Per-provider debug flags override this. */
  debug?: boolean;
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
  /**
   * UXF bundle-CAR publisher for the `uxf-cid` Nostr delivery branch
   * (Issue #200 Phase 1 wiring). Built from the same IPFS gateway list
   * used by `ipfsTokenStorage` when `tokenSync.ipfs.enabled` is true.
   * Forward to `Sphere.init({...providers})` to enable production
   * CID-by-reference token delivery.
   */
  publishToIpfs?: PublishToIpfsCallback;
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
  // Ensure globalThis.fetch exists — state-transition-sdk calls fetch() as a
  // bare global with no way to inject a custom implementation.  Node 18.0-18.16
  // has fetch behind --experimental-fetch; some VM/worker contexts strip it.
  if (typeof globalThis.fetch !== 'function') {
    try {
      // undici ships with Node 18+ and provides a spec-compliant fetch
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const undici = require('undici');
      globalThis.fetch = undici.fetch;
      globalThis.Headers = undici.Headers;
      globalThis.Request = undici.Request;
      globalThis.Response = undici.Response;
    } catch {
      throw new Error(
        'globalThis.fetch is not available and undici could not be loaded. ' +
        'Upgrade to Node.js >= 18.17 or install undici: npm install undici'
      );
    }
  }

  const network = config?.network ?? 'mainnet';

  // Configure global logger: top-level debug enables all, per-provider overrides are additive
  const globalDebug = config?.debug ?? false;
  sdkLogger.configure({ debug: globalDebug });
  if (config?.transport?.debug) sdkLogger.setTagDebug('Nostr', true);
  if (config?.oracle?.debug) sdkLogger.setTagDebug('Aggregator', true);
  if (config?.price?.debug) sdkLogger.setTagDebug('Price', true);

  // Local-infra override: if SPHERE_NOSTR_RELAYS is set in the
  // environment AND the caller did not explicitly pass relays/
  // additionalRelays, splice the env value into the transport config so
  // the resolver picks it up as a hard override. Use cases:
  //   - Local Docker Nostr relay (tests/e2e/local-infra) without
  //     touching every test's makeProviders call site.
  //   - Operator override on a shared deployment (e.g. running against
  //     a staging relay while keeping the network preset for everything
  //     else: aggregator, IPFS, group-chat).
  //
  // Format: comma-separated WebSocket URLs ("ws://localhost:7777,
  // wss://backup.example.com"). Whitespace + empty entries trimmed.
  // Only applies in Node — the browser factory has its own resolver.
  const transportOverride = (() => {
    const raw = process.env['SPHERE_NOSTR_RELAYS'];
    if (!raw) return config?.transport;
    if (config?.transport?.relays || config?.transport?.additionalRelays) {
      // Caller is in charge — don't second-guess explicit wiring.
      return config.transport;
    }
    const relays = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (relays.length === 0) return config?.transport;
    return { ...config?.transport, relays };
  })();

  // Resolve configurations using shared utilities
  const transportConfig = resolveTransportConfig(network, transportOverride);
  const oracleConfig = resolveOracleConfig(network, config?.oracle);
  const l1Config = resolveL1Config(network, config?.l1);

  const storage = createFileStorageProvider({
    dataDir: config?.dataDir ?? './sphere-data',
    ...(config?.walletFileName ? { fileName: config.walletFileName } : {}),
  });
  const priceConfig = resolvePriceConfig(config?.price, storage);

  // Create IPFS storage provider if enabled
  const ipfsSync = config?.tokenSync?.ipfs;
  const ipfsTokenStorage = ipfsSync?.enabled
    ? createNodeIpfsStorageProvider(ipfsSync.config, storage)
    : undefined;

  // Issue #200 Phase 1 wiring — build the canonical UXF CAR publisher
  // from the same gateway list when IPFS sync is enabled. The Node
  // IpfsStorageConfig only exposes a `gateways` field on the inner
  // `config` block; fall back to DEFAULT_IPFS_GATEWAYS (which already
  // honors the SPHERE_IPFS_GATEWAY env override) when unset.
  const publishToIpfs: PublishToIpfsCallback | undefined = ipfsSync?.enabled
    ? createUxfCarPublisher(
        ipfsSync.config?.gateways ?? [...DEFAULT_IPFS_GATEWAYS],
      )
    : undefined;

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
    publishToIpfs,
  };
}
