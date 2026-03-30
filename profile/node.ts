/**
 * Profile Node.js Factory
 *
 * Standalone factory function for creating Profile-backed providers in Node.js
 * environments. Uses FileStorageProvider as the local cache layer.
 *
 * This module does NOT modify `impl/nodejs/index.ts`. It is a standalone
 * entry point that consumers opt into explicitly.
 *
 * @example
 * ```ts
 * import { createNodeProfileProviders } from '@unicitylabs/sphere-sdk/profile/node';
 *
 * const { storage, tokenStorage } = createNodeProfileProviders({
 *   network: 'testnet',
 *   dataDir: './wallet-data',
 *   profileConfig: {
 *     orbitDb: { privateKey: '...', directory: './orbitdb-data' },
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
 * @module profile/node
 */

import type { ProfileConfig } from './types';
import type { ProfileStorageProvider } from './profile-storage-provider';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider';
import { createProfileProviders } from './factory';
import { createFileStorageProvider } from '../impl/nodejs/storage/FileStorageProvider';
import { getNetworkConfig } from '../impl/shared';
import { DEFAULT_IPFS_GATEWAYS } from '../constants';
import type { NetworkType } from '../constants';

/**
 * Configuration for the Node.js Profile factory.
 */
export interface NodeProfileProvidersConfig {
  /** Network preset: mainnet, testnet, or dev */
  readonly network: NetworkType;
  /** Directory for wallet data storage (local cache) */
  readonly dataDir: string;
  /** Profile-specific configuration overrides */
  readonly profileConfig?: Partial<ProfileConfig>;
}

/**
 * Result of creating Node.js Profile providers.
 */
export interface NodeProfileProviders {
  /** Profile-backed storage provider (drop-in for FileStorageProvider) */
  readonly storage: ProfileStorageProvider;
  /** Profile-backed token storage provider (drop-in for FileTokenStorageProvider) */
  readonly tokenStorage: ProfileTokenStorageProvider;
}

/**
 * Create Profile-backed storage providers for Node.js environments.
 *
 * Constructs a FileStorageProvider as the local cache, wraps it with
 * ProfileStorageProvider (OrbitDB-backed), and creates a
 * ProfileTokenStorageProvider for token operations.
 *
 * The returned providers are drop-in replacements for the standard Node.js
 * providers. When using Profile providers, IpfsStorageProvider is NOT needed --
 * OrbitDB replication replaces IPNS-based sync.
 *
 * @param config - Node.js profile configuration
 * @returns Profile-backed storage and token storage providers
 */
export function createNodeProfileProviders(
  config: NodeProfileProvidersConfig,
): NodeProfileProviders {
  const network = config.network;
  const networkConfig = getNetworkConfig(network);

  // Create FileStorageProvider as the local cache
  const localCache = createFileStorageProvider({
    dataDir: config.dataDir,
  });

  // Build the full ProfileConfig from network defaults + overrides
  const profileConfig: ProfileConfig = {
    orbitDb: {
      privateKey: '', // Set later via setIdentity()
      directory: config.profileConfig?.orbitDb?.directory ?? `${config.dataDir}/orbitdb`,
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
