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
import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import { createProfileProviders } from './factory';
import {
  ProfileKvAdapter,
  ProfileKvBrowser,
  LocalBlockCacheBrowser,
} from './kv';
import {
  createIndexedDBStorageProvider,
  createIndexedDBTokenStorageProvider,
} from '../../../impl/browser/storage';
import { getNetworkConfig } from '../../../impl/shared';
import { DEFAULT_IPFS_GATEWAYS } from '../../../constants';
import type { NetworkType } from '../../../constants';
import { attachIdentityToProfileProviders } from './attach-identity';
import { migrateLegacyToProfile } from './token-storage-migration';
import { LEGACY_MIGRATED_MARKER } from './migration';
import type {
  MigrateLegacyToProfileFromSphereOptions,
  MigrateLegacyToProfileFromSphereResult,
} from './token-storage-migration';

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
  /**
   * Issue #330 — read-only fallback token storage, present only when
   * the underlying legacy `sphere-storage` IDB carries the migration
   * marker (`migration.migratedAt`). Pass through to `Sphere.init` /
   * `Sphere.load` as `fallbackTokenStorage` so tokens that were
   * durable in the legacy IDB pre-migration are recoverable when the
   * Profile blockstore loses them. Wired automatically by
   * {@link createBrowserProfileProvidersAuto}; absent for sync
   * `createBrowserProfileProviders` callers.
   *
   * Spreading the providers into `Sphere.init({ ...providers })`
   * propagates this transparently since `SphereInitOptions` already
   * has the same field name.
   */
  readonly fallbackTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
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
// Issue #330 — auto-wiring async factory with legacy-fallback detection
// =============================================================================

/**
 * Async variant of {@link createBrowserProfileProviders} that also
 * probes the legacy `sphere-storage` IndexedDB for the migration
 * marker (`migration.migratedAt`) and, when present, constructs a
 * legacy {@link IndexedDBTokenStorageProvider} as a read-only
 * fallback token storage. The result's `fallbackTokenStorage` field
 * is the wired fallback (or `undefined` for fresh, never-migrated
 * wallets).
 *
 * **Recommended for production browser wallets** that may have been
 * migrated from a pre-Profile layout. The sync sister factory is kept
 * for backward compatibility but does NOT detect or wire the fallback.
 *
 * Spreading the result into `Sphere.init` / `Sphere.load` propagates
 * the fallback transparently (the field names match):
 *
 * @example
 * ```ts
 * const providers = await createBrowserProfileProvidersAuto({
 *   network: 'testnet',
 * });
 * const { sphere } = await Sphere.init({
 *   ...providers,           // storage, tokenStorage, fallbackTokenStorage
 *   transport,
 *   oracle,
 * });
 * ```
 *
 * Detection is best-effort: a missing marker, a marker that decodes
 * to an invalid timestamp, or any IDB-side failure during probe all
 * yield no fallback. The primary Profile path remains fully functional;
 * only the post-migration recovery contract is lost in that case.
 *
 * @see LEGACY_MIGRATED_MARKER for the marker key written by
 *      `profile/migration.ts` step 5c.
 */
export async function createBrowserProfileProvidersAuto(
  config: BrowserProfileProvidersConfig,
): Promise<BrowserProfileProviders> {
  // 1. Construct the primary Profile providers via the sync factory.
  const primary = createBrowserProfileProviders(config);

  // 2. Probe the legacy KV for the migration marker. Uses a separate,
  //    temporary `IndexedDBStorageProvider` connection — the marker
  //    write happens against the same DB the local cache reads from,
  //    so the lookup is cheap. Any failure here yields no fallback.
  let fallbackTokenStorage: TokenStorageProvider<TxfStorageDataBase> | undefined;
  try {
    const probe = createIndexedDBStorageProvider();
    if (!probe.isConnected()) {
      await probe.connect();
    }
    const markerValue = await probe.get(LEGACY_MIGRATED_MARKER);
    if (typeof markerValue === 'string' && markerValue.length > 0) {
      // Marker present — the legacy IDB token storage holds
      // pre-migration tokens. Construct a fresh provider over the
      // same per-address DBs and expose it as the fallback.
      fallbackTokenStorage = createIndexedDBTokenStorageProvider();
    }
    // Do NOT close the probe here — `IndexedDBStorageProvider` shares
    // a singleton DB handle; closing it would invalidate the
    // primary's local cache connection. The handle is reused by the
    // Sphere boot path via `localCache` inside the primary providers.
  } catch {
    // Probe failed (no IDB, locked DB, quota exceeded, ...). Continue
    // without a fallback — primary Profile path is unchanged.
    fallbackTokenStorage = undefined;
  }

  return { ...primary, fallbackTokenStorage };
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

/**
 * Convenience helper: bind the browser Profile factory to
 * `migrateLegacyToProfile` so consumers don't have to thread the
 * `profileFactory` parameter through themselves. Pre-wires the platform-
 * specific factory; the rest of the options surface is identical to
 * `MigrateLegacyToProfileFromSphereOptions` minus `profileFactory`.
 *
 * Internally re-exports the same `migrateLegacyToProfile` function from
 * `./token-storage-migration` with `profileFactory` pre-set. Useful for
 * call sites that want a one-liner.
 *
 * @example
 * ```ts
 * import { migrateLegacyToProfileBrowser } from '@unicitylabs/sphere-sdk/profile/browser';
 *
 * const result = await migrateLegacyToProfileBrowser({
 *   sphere,
 *   legacy: legacyProviders.tokenStorage,
 *   network: 'mainnet',
 *   oracle: providers.oracle,
 * });
 * const { storage, tokenStorage } = result.profileProviders;
 * ```
 */
export async function migrateLegacyToProfileBrowser(
  opts: Omit<MigrateLegacyToProfileFromSphereOptions, 'profileFactory'>,
): Promise<MigrateLegacyToProfileFromSphereResult> {
  return migrateLegacyToProfile({
    ...opts,
    profileFactory: createBrowserProfileProvidersFromSphere,
  });
}
