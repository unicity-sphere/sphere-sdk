/**
 * Profile Browser Factory
 *
 * Standalone factory function for creating Profile-backed providers in browser
 * environments. Uses IndexedDB as the local cache layer.
 *
 * This module does NOT modify `impl/browser/index.ts`. It is a standalone
 * entry point that consumers opt into explicitly.
 *
 * @example
 * ```ts
 * import { createBrowserProfileProviders } from '@unicitylabs/sphere-sdk/profile/browser';
 *
 * const { storage, tokenStorage } = createBrowserProfileProviders({
 *   network: 'testnet',
 *   profileConfig: {
 *     orbitDb: { privateKey: '...' },
 *   },
 * });
 *
 * const { sphere } = await Sphere.init({
 *   storage,
 *   tokenStorage,
 *   transport: ...,
 *   oracle: ...,
 * });
 * ```
 *
 * @module profile/browser
 */

import type { ProfileConfig } from './types';
import type { ProfileStorageProvider } from './profile-storage-provider';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider';
import { createProfileProviders } from './factory';
import { createIndexedDBStorageProvider } from '../impl/browser/storage/IndexedDBStorageProvider';
import { getNetworkConfig } from '../impl/shared';
import { DEFAULT_IPFS_GATEWAYS } from '../constants';
import type { NetworkType } from '../constants';

/**
 * Configuration for the browser Profile factory.
 */
export interface BrowserProfileProvidersConfig {
  /** Network preset: mainnet, testnet, or dev */
  readonly network: NetworkType;
  /** Profile-specific configuration overrides */
  readonly profileConfig?: Partial<ProfileConfig>;
}

/**
 * Result of creating browser Profile providers.
 */
export interface BrowserProfileProviders {
  /** Profile-backed storage provider (drop-in for IndexedDBStorageProvider) */
  readonly storage: ProfileStorageProvider;
  /** Profile-backed token storage provider (drop-in for IndexedDBTokenStorageProvider) */
  readonly tokenStorage: ProfileTokenStorageProvider;
}

/**
 * Create Profile-backed storage providers for browser environments.
 *
 * Constructs an IndexedDBStorageProvider as the local cache, wraps it with
 * ProfileStorageProvider (OrbitDB-backed), and creates a
 * ProfileTokenStorageProvider for token operations.
 *
 * The returned providers are drop-in replacements for the standard browser
 * providers. When using Profile providers, IpfsStorageProvider is NOT needed --
 * OrbitDB replication replaces IPNS-based sync.
 *
 * @param config - Browser profile configuration
 * @returns Profile-backed storage and token storage providers
 */
export function createBrowserProfileProviders(
  config: BrowserProfileProvidersConfig,
): BrowserProfileProviders {
  const network = config.network;
  const networkConfig = getNetworkConfig(network);

  // Create IndexedDB provider as the local cache
  const localCache = createIndexedDBStorageProvider();

  // Build the full ProfileConfig from network defaults + overrides
  const profileConfig: ProfileConfig = {
    orbitDb: {
      privateKey: '', // Set later via setIdentity()
      ...(config.profileConfig?.orbitDb ?? {}),
    },
    encrypt: config.profileConfig?.encrypt ?? true,
    ipfsGateways: config.profileConfig?.ipfsGateways ?? [...networkConfig.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS],
    cacheMaxSizeBytes: config.profileConfig?.cacheMaxSizeBytes,
    consolidationRetentionMs: config.profileConfig?.consolidationRetentionMs,
    consolidationRetentionMinMs: config.profileConfig?.consolidationRetentionMinMs,
    flushDebounceMs: config.profileConfig?.flushDebounceMs,
    profileOrbitDbPeers: config.profileConfig?.profileOrbitDbPeers,
    debug: config.profileConfig?.debug,
  };

  const { storage, tokenStorage } = createProfileProviders(profileConfig, localCache);

  return { storage, tokenStorage };
}
