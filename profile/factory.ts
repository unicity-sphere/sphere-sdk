/**
 * Profile Factory — Shared Logic
 *
 * Contains the common wiring logic used by both `createBrowserProfileProviders()`
 * and `createNodeProfileProviders()`. Creates the OrbitDB adapter, configures
 * encryption, and assembles the Profile storage and token storage providers.
 *
 * This module is internal to the profile package. Platform-specific factories
 * (browser.ts, node.ts) call `createProfileProviders()` after constructing
 * the appropriate local cache provider.
 *
 * @module profile/factory
 */

import type { StorageProvider } from '../storage/storage-provider';
import type { OracleProvider } from '../oracle';
import type { ProfileConfig, ProfileTokenStorageProviderOptions } from './types';
import { OrbitDbAdapter } from './orbitdb-adapter';
import { ProfileStorageProvider } from './profile-storage-provider';
import { ProfileTokenStorageProvider } from './profile-token-storage-provider';
import { DEFAULT_IPFS_GATEWAYS } from '../constants';

/**
 * Result of creating Profile-backed providers.
 */
export interface ProfileProviders {
  /** Drop-in replacement for IndexedDBStorageProvider / FileStorageProvider */
  readonly storage: ProfileStorageProvider;
  /** Drop-in replacement for IndexedDBTokenStorageProvider / FileTokenStorageProvider */
  readonly tokenStorage: ProfileTokenStorageProvider;
}

/**
 * Create Profile-backed storage and token storage providers.
 *
 * This is the shared factory core. It:
 * 1. Creates an OrbitDbAdapter instance (connection is deferred to connect())
 * 2. Wraps the provided local cache with ProfileStorageProvider
 * 3. Creates a ProfileTokenStorageProvider for token operations
 *
 * The returned providers are drop-in replacements for the existing
 * IndexedDB / file-based providers. When Profile providers are used,
 * IpfsStorageProvider is NOT needed — OrbitDB replication replaces IPNS sync.
 *
 * @param config - Profile configuration (OrbitDB settings, encryption, gateways)
 * @param cacheStorage - Local cache provider (IndexedDB or file-based)
 * @param oracle - Oracle provider used by the aggregator pointer layer (optional
 *   during rollout; required once T-D6 replaces IPNS recovery). Must be the
 *   same instance passed to L4 / `PaymentsModule` so the embedded
 *   `RootTrustBase` is shared (SPEC §8.4.2 H6).
 * @returns Profile-backed storage and token storage providers
 */
export function createProfileProviders(
  config: ProfileConfig,
  cacheStorage: StorageProvider,
  oracle?: OracleProvider,
): ProfileProviders {
  // Merge custom bootstrap peers from the convenience alias
  const resolvedConfig: ProfileConfig = config.profileOrbitDbPeers
    ? {
        ...config,
        orbitDb: {
          ...config.orbitDb,
          bootstrapPeers: [
            ...(config.orbitDb.bootstrapPeers ?? []),
            ...config.profileOrbitDbPeers,
          ],
        },
      }
    : config;

  // Create OrbitDB adapter (connection deferred to connect())
  const db = new OrbitDbAdapter();

  // Create ProfileStorageProvider wrapping the local cache and OrbitDB
  const storage = new ProfileStorageProvider(cacheStorage, db, {
    config: resolvedConfig,
    encrypt: resolvedConfig.encrypt !== false,
    oracle,
    debug: resolvedConfig.debug,
  });

  // Resolve IPFS gateways for CAR pinning/fetching
  const ipfsGateways = resolvedConfig.ipfsGateways ?? [...DEFAULT_IPFS_GATEWAYS];

  // Create ProfileTokenStorageProvider
  // The encryption key is null at construction time — it will be derived
  // when setIdentity() is called on the storage provider.
  // Note: addressId is intentionally omitted here. It will be computed
  // automatically when setIdentity() is called on the provider.
  const tokenStorageOptions: ProfileTokenStorageProviderOptions = {
    config: resolvedConfig,
    addressId: 'default',
    encrypt: resolvedConfig.encrypt !== false,
    flushDebounceMs: resolvedConfig.flushDebounceMs,
    oracle,
    // Lazy accessor: the pointer layer is built inside
    // `storage.doConnect()` after OrbitDB attach, long after the
    // token-storage constructor runs. A closure defers the read
    // until it is actually needed (inside initialize() / flushToIpfs).
    getPointerLayer: () => storage.getPointerLayer(),
    getPointerBuildStatus: () => storage.getPointerBuildStatus(),
    debug: resolvedConfig.debug,
  };

  // The cacheStorage is also used as the per-device local cache for
  // derived operational state (tombstones, sent, history) — these are
  // never replicated via OrbitDB. See profile/deriver.ts.
  const tokenStorage = new ProfileTokenStorageProvider(
    db,
    null, // encryption key derived later via setIdentity()
    ipfsGateways,
    tokenStorageOptions,
    cacheStorage,
  );

  return { storage, tokenStorage };
}
