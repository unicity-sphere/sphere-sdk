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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProfileConfig } from './types';
import type { ProfileStorageProvider } from './profile-storage-provider';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider';
import type { OracleProvider } from '../../../oracle';
import type { Sphere } from '../../../core/Sphere';
import { createProfileProviders } from './factory';
import { createFileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { getNetworkConfig } from '../../../impl/shared';
import { DEFAULT_IPFS_GATEWAYS } from '../../../constants';
import {
  ProfileKvAdapter,
  ProfileKvNode,
  LocalBlockCacheNode,
} from './kv';
import type { NetworkType } from '../../../constants';
import { attachIdentityToProfileProviders } from './attach-identity';
import { migrateLegacyToProfile } from './token-storage-migration';
import type {
  MigrateLegacyToProfileFromSphereOptions,
  MigrateLegacyToProfileFromSphereResult,
} from './token-storage-migration';

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
  /**
   * Oracle provider for the aggregator pointer layer. Pass the same
   * `oracle` instance that will be handed to `Sphere.init` / L4 so the
   * embedded `RootTrustBase` is shared (SPEC §8.4.2 H6). Optional during
   * rollout; required once pointer-layer recovery replaces IPNS (T-D6).
   */
  readonly oracle?: OracleProvider;
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
    substrate: config.profileConfig?.substrate,
    orbitDb: {
      privateKey: '', // Set later via setIdentity()
      directory: config.profileConfig?.orbitDb?.directory ?? `${config.dataDir}/orbitdb`,
      // Issue #266 — Node.js wallet/CLI clients default to HTTP-only IPFS:
      // no libp2p DHT/bootstrap/peerDiscovery, memory-only blockstore,
      // operator Kubo gateway via HTTP for persistence. Operator-side
      // bridges that want real peer discovery pass `httpOnlyIpfs: false`
      // and configure `bootstrapPeers` explicitly.
      httpOnlyIpfs: true,
      ...(config.profileConfig?.orbitDb ?? {}),
    },
    encrypt: config.profileConfig?.encrypt ?? true,
    // Wave F.9: thread network through to ProfileConfig so the pointer
    // layer's SPEC §14.1 / §11.12 denylist gate (createMasterPrivateKey
    // network parameter) reaches createMasterPrivateKey via
    // ProfileStorageProvider → buildProfilePointerLayer. Previously
    // the factory dropped this field — production callers couldn't
    // opt into network='test-vectors' through the standard factory.
    network,
    ipfsGateways: config.profileConfig?.ipfsGateways ?? [...networkConfig.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS],
    cacheMaxSizeBytes: config.profileConfig?.cacheMaxSizeBytes,
    consolidationRetentionMs: config.profileConfig?.consolidationRetentionMs,
    consolidationRetentionMinMs: config.profileConfig?.consolidationRetentionMinMs,
    flushDebounceMs: config.profileConfig?.flushDebounceMs,
    profileOrbitDbPeers: config.profileConfig?.profileOrbitDbPeers,
    debug: config.profileConfig?.debug,
  };

  // Phase 4 (uxf-v2) — KV substrate. Pre-build a ProfileKvAdapter
  // and hand it to `createProfileProviders`. The KV backend / block
  // cache directories nest under the same dataDir as OrbitDB used
  // to, so nothing else in the factory chain (dataDir cleanup,
  // `Sphere.clear`, etc.) needs to change.
  const kvBaseDir =
    profileConfig.orbitDb.directory ?? `${config.dataDir}/orbitdb`;

  // Phase 4-Swap guard (steelman finding #2): detect pre-Phase-4-Swap
  // OrbitDB dataDir contents and refuse to open silently.
  //
  // Old wallets carried operational state (OUTBOX/SENT/finalization/
  // disposition) in `${kvBaseDir}/*` under OrbitDB's oplog format. The
  // Phase-4-Swap KV substrate nests its own directories at
  // `${kvBaseDir}/kv-<shortName>/*`. Booting KV against a directory that
  // still holds only OrbitDB files leaves identity intact (kept in
  // wallet.json via FileStorageProvider) while silently dropping every
  // operational entry — the wallet appears to boot fresh with pending
  // sends lost.
  //
  // Detect that state and fail loudly. Operators who *want* to accept the
  // orphaned OrbitDB state (e.g., in dev, or after they've manually
  // migrated) can set SPHERE_KV_ACCEPT_ORPHANED_ORBITDB=1.
  detectOrphanedOrbitDbDataDir(kvBaseDir);

  const substrateOverride = new ProfileKvAdapter({
    backendFactory: (shortName) =>
      new ProfileKvNode({
        directory: `${kvBaseDir}/kv-${shortName}`,
      }),
    blockCacheFactory: (shortName) =>
      new LocalBlockCacheNode({
        directory: `${kvBaseDir}/kv-${shortName}/blocks`,
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
 * Configuration for {@link createNodeProfileProvidersFromSphere}.
 *
 * Mirrors {@link NodeProfileProvidersConfig} but is used with the
 * Sphere-bound factory below.
 */
export interface NodeProfileProvidersFromSphereConfig {
  /** Network preset: mainnet, testnet, or dev */
  readonly network: NetworkType;
  /** Directory for wallet data storage (local cache) */
  readonly dataDir: string;
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
 * Construct Node.js Profile providers WITH identity already attached,
 * using the given Sphere instance's internal private key.
 *
 * Node.js mirror of {@link createBrowserProfileProvidersFromSphere}. See
 * that function's docstring for the architectural invariant and the
 * Issue #292 motivation.
 *
 * @param sphere Live Sphere instance — must be initialized.
 * @param config Node.js profile configuration.
 * @returns Profile-backed storage and token storage providers, fully
 *          initialized with identity attached.
 * @throws {SphereError} `NOT_INITIALIZED` when the Sphere instance has
 *         no identity bound.
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/292
 */
export async function createNodeProfileProvidersFromSphere(
  sphere: Sphere,
  config: NodeProfileProvidersFromSphereConfig,
): Promise<NodeProfileProviders> {
  const providers = createNodeProfileProviders({
    network: config.network,
    dataDir: config.dataDir,
    profileConfig: config.profileConfig,
    oracle: config.oracle,
  });

  await attachIdentityToProfileProviders(sphere, providers);

  return providers;
}

/**
 * Convenience helper: bind the Node.js Profile factory to
 * `migrateLegacyToProfile` so consumers don't have to thread the
 * `profileFactory` parameter through themselves. See
 * `migrateLegacyToProfileBrowser` for the browser equivalent.
 */
export async function migrateLegacyToProfileNode(
  opts: Omit<MigrateLegacyToProfileFromSphereOptions, 'profileFactory'> & {
    /** Node.js-specific: directory for wallet data storage (local cache). */
    readonly dataDir: string;
  },
): Promise<MigrateLegacyToProfileFromSphereResult> {
  const { dataDir, ...rest } = opts;
  return migrateLegacyToProfile({
    ...rest,
    profileFactory: async (sphere, config) =>
      createNodeProfileProvidersFromSphere(sphere, {
        ...config,
        dataDir,
      }),
  });
}

// =============================================================================
// Phase 4-Swap guard: pre-Phase-4-Swap OrbitDB dataDir detection
// =============================================================================

const ORBITDB_ORPHAN_ENV = 'SPHERE_KV_ACCEPT_ORPHANED_ORBITDB';

/**
 * Fail loudly if `kvBaseDir` still contains only OrbitDB-format files from
 * before Phase 4-Swap.
 *
 * The KV substrate creates its own directories under `${kvBaseDir}/kv-<name>/*`.
 * A dataDir that has `${kvBaseDir}/*` (files/dirs) but no `kv-*` children is
 * a legacy OrbitDB wallet whose operational state is invisible to the KV
 * substrate. Booting through it silently zeros out OUTBOX/SENT/finalization
 * / disposition entries (identity survives via wallet.json / FileStorageProvider).
 *
 * Operators who *want* to accept the orphaned state can set
 * `SPHERE_KV_ACCEPT_ORPHANED_ORBITDB=1`.
 */
function detectOrphanedOrbitDbDataDir(kvBaseDir: string): void {
  if (process.env[ORBITDB_ORPHAN_ENV] === '1') return;

  let entries: string[];
  try {
    entries = fs.readdirSync(kvBaseDir);
  } catch (err) {
    // Directory doesn't exist yet — fresh wallet, nothing to detect.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  if (entries.length === 0) return;

  // Any `kv-*` child means the KV substrate has been used here — safe.
  const hasKvChild = entries.some((entry) => entry.startsWith('kv-'));
  if (hasKvChild) return;

  // We have a non-empty dataDir with zero KV children → looks like a
  // pre-Phase-4-Swap OrbitDB wallet.
  const sample = entries.slice(0, 6).map((e) => path.join(kvBaseDir, e));
  throw new Error(
    `[uxf-v2 Phase 4-Swap] Refusing to open KV substrate against a dataDir ` +
      `that appears to hold pre-Phase-4-Swap OrbitDB state.\n` +
      `  Location: ${kvBaseDir}\n` +
      `  Non-KV entries found: ${sample.join(', ')}${
        entries.length > sample.length ? ` (and ${entries.length - sample.length} more)` : ''
      }\n\n` +
      `The Phase 4-Swap KV substrate stores wallet operational state under ` +
      `${kvBaseDir}/kv-<shortName>/*. The entries above are not KV data. ` +
      `Continuing would silently drop OUTBOX/SENT/finalization/disposition ` +
      `entries (identity survives via FileStorageProvider's wallet.json).\n\n` +
      `Choose one:\n` +
      `  (a) Point dataDir at a fresh directory (recommended for new wallets).\n` +
      `  (b) Move ${kvBaseDir} aside if you want the wallet to boot with ` +
      `      no operational state.\n` +
      `  (c) Set ${ORBITDB_ORPHAN_ENV}=1 to bypass this check and accept ` +
      `      that the orphaned OrbitDB data will be inaccessible.`,
  );
}
