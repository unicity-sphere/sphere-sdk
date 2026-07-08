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
import type { OracleProvider } from '../../../oracle';
import type { Sphere } from '../../../core/Sphere';
import { createProfileProviders } from './factory';
import {
  ProfileKvAdapter,
  ProfileKvBrowser,
  LocalBlockCacheBrowser,
} from './kv';
import { createIndexedDBStorageProvider } from '../../../impl/browser/storage';
import { getNetworkConfig } from '../../../impl/shared';
import { DEFAULT_IPFS_GATEWAYS } from '../../../constants';
import type { NetworkType } from '../../../constants';
import { attachIdentityToProfileProviders } from './attach-identity';

/**
 * Configuration for the browser Profile factory.
 */
export interface BrowserProfileProvidersConfig {
  /** Network preset: mainnet, testnet, or dev */
  readonly network: NetworkType;
  /** Profile-specific configuration overrides */
  readonly profileConfig?: Partial<ProfileConfig>;
  /**
   * Oracle provider for the aggregator pointer layer. Pass the same
   * `oracle` instance that will be handed to `Sphere.init` / L4 so the
   * embedded `RootTrustBase` is shared (SPEC §8.4.2 H6). Optional during
   * rollout; required once pointer-layer recovery replaces IPNS (T-D6).
   */
  readonly oracle?: OracleProvider;
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
    substrate: config.profileConfig?.substrate,
    orbitDb: {
      privateKey: '', // Set later via setIdentity()
      // Issue #266 — browser wallets default to HTTP-only IPFS:
      // no libp2p DHT/bootstrap/peerDiscovery, memory-only blockstore,
      // operator Kubo gateway via HTTP for persistence. Avoids
      // burning the user's browser tab on libp2p protocol handlers.
      httpOnlyIpfs: true,
      ...(config.profileConfig?.orbitDb ?? {}),
    },
    encrypt: config.profileConfig?.encrypt ?? true,
    // Wave F.9: thread network through (parity with profile/node.ts).
    network,
    ipfsGateways: config.profileConfig?.ipfsGateways ?? [...networkConfig.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS],
    cacheMaxSizeBytes: config.profileConfig?.cacheMaxSizeBytes,
    consolidationRetentionMs: config.profileConfig?.consolidationRetentionMs,
    consolidationRetentionMinMs: config.profileConfig?.consolidationRetentionMinMs,
    flushDebounceMs: config.profileConfig?.flushDebounceMs,
    profileOrbitDbPeers: config.profileConfig?.profileOrbitDbPeers,
    debug: config.profileConfig?.debug,
  };

  // Phase 4 (uxf-v2) — KV substrate. Nests under an IndexedDB name
  // derived from the wallet shortname so multiple wallets on the
  // same origin don't collide.
  const substrateOverride = new ProfileKvAdapter({
    backendFactory: (shortName) =>
      new ProfileKvBrowser({
        dbName: `sphere-profile-kv-${shortName}`,
      }),
    blockCacheFactory: (shortName) =>
      new LocalBlockCacheBrowser({
        dbName: `sphere-profile-kv-blocks-${shortName}`,
      }),
  });

  const { storage, tokenStorage } = createProfileProviders(
    profileConfig,
    localCache,
    config.oracle,
    substrateOverride,
  );

  return { storage, tokenStorage };
}

// =============================================================================
// Sphere-bound factory (Issue #292)
// =============================================================================

/**
 * Configuration for {@link createBrowserProfileProvidersFromSphere}.
 *
 * Mirrors {@link BrowserProfileProvidersConfig} but is used with the
 * Sphere-bound factory below.
 */
export interface BrowserProfileProvidersFromSphereConfig {
  /** Network preset: mainnet, testnet, or dev */
  readonly network: NetworkType;
  /** Profile-specific configuration overrides */
  readonly profileConfig?: Partial<ProfileConfig>;
  /**
   * Oracle provider for the aggregator pointer layer. Pass the same
   * `oracle` instance that the Sphere instance was constructed with so
   * the embedded `RootTrustBase` is shared (SPEC §8.4.2 H6).
   */
  readonly oracle?: OracleProvider;
}

/**
 * Construct Profile providers WITH identity already attached, using the
 * given Sphere instance's internal private key.
 *
 * **Preferred over {@link createBrowserProfileProviders} for any consumer
 * that has a live Sphere** — eliminates the need to pass a synthetic
 * `FullIdentity` (which would require `privateKey: ''` and crash inside
 * `hexToBytes`; see Issue #292). Returned providers are ready to use
 * immediately: no separate `setIdentity` / `tokenStorage.initialize` call
 * is needed at the consumer site.
 *
 * The Sphere's private key NEVER crosses the SDK boundary — the helper
 * routes the identity through an internal accessor that confines the
 * `FullIdentity` reference to the SDK's own scope (see
 * `attach-identity.ts` and `Sphere._withFullIdentityForProfileFactory`).
 *
 * @example Probe path (no migration)
 * ```ts
 * const { storage, tokenStorage } = await createBrowserProfileProvidersFromSphere(
 *   sphere,
 *   { network: 'mainnet' },
 * );
 * const snap = await tokenStorage.load();
 * ```
 *
 * @param sphere Live Sphere instance — must be initialized.
 * @param config Browser profile configuration.
 * @returns Profile-backed storage and token storage providers, fully
 *          initialized with identity attached.
 * @throws {SphereError} `NOT_INITIALIZED` when the Sphere instance has
 *         no identity bound (uninitialized wallet).
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/292
 */
export async function createBrowserProfileProvidersFromSphere(
  sphere: Sphere,
  config: BrowserProfileProvidersFromSphereConfig,
): Promise<BrowserProfileProviders> {
  // Reuse the standard factory body — it constructs the IndexedDB local
  // cache, OrbitDB adapter, and both providers. The Sphere binding is
  // applied as a separate, well-confined step below.
  const providers = createBrowserProfileProviders({
    network: config.network,
    profileConfig: config.profileConfig,
    oracle: config.oracle,
  });

  await attachIdentityToProfileProviders(sphere, providers);

  return providers;
}

