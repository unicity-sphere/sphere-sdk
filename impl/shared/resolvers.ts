/**
 * Configuration Resolvers
 * Utility functions for resolving provider configurations with extend/override pattern
 */

import { NETWORKS, DEFAULT_AGGREGATOR_API_KEY, type NetworkType, type NetworkConfig } from '../../constants';
import type {
  BaseTransportConfig,
  BaseOracleConfig,
  L1Config,
  ResolvedTransportConfig,
  ResolvedOracleConfig,
} from './config';

// =============================================================================
// Network Resolution
// =============================================================================

/**
 * Get network configuration by type
 */
export function getNetworkConfig(network: NetworkType = 'mainnet'): NetworkConfig {
  return NETWORKS[network];
}

// =============================================================================
// Transport Resolution
// =============================================================================

/**
 * Resolve transport configuration with extend/override pattern
 *
 * Priority:
 * 1. `relays` - replaces defaults entirely
 * 2. `additionalRelays` - extends network defaults
 * 3. Network defaults
 *
 * @example
 * ```ts
 * // Use network defaults
 * resolveTransportConfig('testnet', undefined);
 *
 * // Replace relays entirely
 * resolveTransportConfig('testnet', { relays: ['wss://custom.relay'] });
 *
 * // Extend defaults
 * resolveTransportConfig('testnet', { additionalRelays: ['wss://extra.relay'] });
 * ```
 */
export function resolveTransportConfig(
  network: NetworkType,
  config?: BaseTransportConfig & { reconnectDelay?: number; maxReconnectAttempts?: number }
): ResolvedTransportConfig {
  const networkConfig = getNetworkConfig(network);

  // Resolve relays with extend/override pattern
  let relays: string[];
  if (config?.relays) {
    // Explicit relays - replace entirely
    relays = config.relays;
  } else {
    // Start with network defaults
    relays = [...networkConfig.nostrRelays] as string[];
    // Add additional relays if specified
    if (config?.additionalRelays) {
      relays = [...relays, ...config.additionalRelays];
    }
  }

  return {
    relays,
    timeout: config?.timeout,
    autoReconnect: config?.autoReconnect,
    debug: config?.debug,
    // Browser-specific
    reconnectDelay: config?.reconnectDelay,
    maxReconnectAttempts: config?.maxReconnectAttempts,
  };
}

// =============================================================================
// Oracle Resolution
// =============================================================================

/**
 * Resolve oracle configuration with override pattern
 *
 * Uses network default URL if not explicitly provided
 *
 * @example
 * ```ts
 * // Use network default
 * resolveOracleConfig('testnet', undefined);
 *
 * // Override URL
 * resolveOracleConfig('testnet', { url: 'https://custom.aggregator' });
 * ```
 */
export function resolveOracleConfig(
  network: NetworkType,
  config?: BaseOracleConfig & { trustBasePath?: string }
): ResolvedOracleConfig {
  const networkConfig = getNetworkConfig(network);

  return {
    url: config?.url ?? networkConfig.aggregatorUrl,
    apiKey: config?.apiKey ?? DEFAULT_AGGREGATOR_API_KEY,
    timeout: config?.timeout,
    skipVerification: config?.skipVerification,
    debug: config?.debug,
    // Node.js-specific
    trustBasePath: config?.trustBasePath,
  };
}

// =============================================================================
// L1 Resolution
// =============================================================================

/**
 * Resolve L1 configuration with override pattern
 *
 * Only returns config if l1 is explicitly provided (L1 is optional)
 *
 * @example
 * ```ts
 * // No L1 config - returns undefined
 * resolveL1Config('testnet', undefined);
 *
 * // Enable L1 with defaults
 * resolveL1Config('testnet', {});
 *
 * // Override electrum URL
 * resolveL1Config('testnet', { electrumUrl: 'wss://custom.fulcrum:50004' });
 * ```
 */
export function resolveL1Config(
  network: NetworkType,
  config?: L1Config
): L1Config | undefined {
  if (config === undefined) {
    return undefined;
  }

  const networkConfig = getNetworkConfig(network);

  return {
    electrumUrl: config.electrumUrl ?? networkConfig.electrumUrl,
    defaultFeeRate: config.defaultFeeRate,
    enableVesting: config.enableVesting,
  };
}

// =============================================================================
// Array Extension Helper
// =============================================================================

/**
 * Resolve array with extend/override pattern
 *
 * @param defaults - Default values from network config
 * @param replace - Values that replace defaults entirely
 * @param additional - Values to add to defaults
 * @returns Resolved array
 *
 * @example
 * ```ts
 * // Use defaults
 * resolveArrayConfig(['a', 'b'], undefined, undefined); // ['a', 'b']
 *
 * // Replace
 * resolveArrayConfig(['a', 'b'], ['x'], undefined); // ['x']
 *
 * // Extend
 * resolveArrayConfig(['a', 'b'], undefined, ['c']); // ['a', 'b', 'c']
 * ```
 */
export function resolveArrayConfig<T>(
  defaults: readonly T[],
  replace?: T[],
  additional?: T[]
): T[] {
  if (replace) {
    return replace;
  }

  const result = [...defaults];
  if (additional) {
    return [...result, ...additional];
  }

  return result;
}
