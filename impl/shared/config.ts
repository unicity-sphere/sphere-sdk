/**
 * Shared Configuration Interfaces
 * Base types extended by platform-specific implementations
 */

import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../storage';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { PriceProvider, PricePlatform } from '../../price';
import type { NetworkType } from '../../constants';

// =============================================================================
// Transport Configuration
// =============================================================================

/**
 * Base transport (Nostr) configuration
 * Supports extend/override pattern for relays
 */
export interface BaseTransportConfig {
  /** Replace default relays entirely */
  relays?: string[];
  /** Add relays to network defaults (use with network preset) */
  additionalRelays?: string[];
  /** Connection timeout (ms) */
  timeout?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Browser-specific transport extensions
 */
export interface BrowserTransportExtensions {
  /** Reconnect delay (ms) */
  reconnectDelay?: number;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
}

// =============================================================================
// Oracle Configuration
// =============================================================================

/**
 * Base oracle (Aggregator) configuration
 */
export interface BaseOracleConfig {
  /** Replace default aggregator URL (if not set, uses network default) */
  url?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Request timeout (ms) */
  timeout?: number;
  /** Skip trust base verification (dev only) */
  skipVerification?: boolean;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Node.js-specific oracle extensions
 */
export interface NodeOracleExtensions {
  /** Path to trust base JSON file */
  trustBasePath?: string;
}

// =============================================================================
// L1 Configuration
// =============================================================================

/**
 * L1 (ALPHA blockchain) configuration
 * Same for all platforms
 */
export interface L1Config {
  /** Fulcrum WebSocket URL (if not set, uses network default) */
  electrumUrl?: string;
  /** Default fee rate in sat/byte */
  defaultFeeRate?: number;
  /** Enable vesting classification */
  enableVesting?: boolean;
}

// =============================================================================
// Price Configuration
// =============================================================================

/**
 * Base price provider configuration
 */
export interface BasePriceConfig {
  /** Which price platform to use (default: 'coingecko') */
  platform?: PricePlatform;
  /** API key for the price platform (optional for free tiers) */
  apiKey?: string;
  /** Custom base URL (e.g., for CORS proxy in browser environments) */
  baseUrl?: string;
  /** Cache TTL in milliseconds (default: 60000) */
  cacheTtlMs?: number;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// Market Configuration
// =============================================================================

/**
 * Base market module configuration
 */
export interface BaseMarketConfig {
  /** Market API base URL (default: https://market-api.unicity.network) */
  apiUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

// =============================================================================
// Provider Configuration
// =============================================================================

/**
 * Base providers configuration
 * Extended by platform-specific configs
 */
export interface BaseProvidersConfig {
  /** Network preset: mainnet, testnet, or dev. Sets default URLs for all services */
  network?: NetworkType;
  /** Transport (Nostr) configuration - supports extend/override pattern */
  transport?: BaseTransportConfig;
  /** Oracle (Aggregator) configuration - supports extend/override pattern */
  oracle?: BaseOracleConfig;
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1Config;
  /** Price provider configuration (optional — enables fiat value display) */
  price?: BasePriceConfig;
}

// =============================================================================
// Providers Result
// =============================================================================

/**
 * Base providers result
 * Common structure for all platforms
 */
export interface BaseProviders {
  storage: StorageProvider;
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  transport: TransportProvider;
  oracle: OracleProvider;
  /** L1 configuration (for passing to Sphere.init) */
  l1?: L1Config;
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
}

// =============================================================================
// Resolved Configuration Types
// =============================================================================

/**
 * Resolved transport configuration (after extend/override processing)
 */
export interface ResolvedTransportConfig {
  relays: string[];
  timeout?: number;
  autoReconnect?: boolean;
  debug?: boolean;
  // Browser-specific
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

/**
 * Resolved oracle configuration
 */
export interface ResolvedOracleConfig {
  url: string;
  apiKey?: string;
  timeout?: number;
  skipVerification?: boolean;
  debug?: boolean;
  // Node.js-specific
  trustBasePath?: string;
}
