/**
 * Profile-specific helpers for E2E tests.
 *
 * Mirrors the legacy `helpers.ts` flow (makeTempDirs, ensureTrustbase,
 * createNoopTransport, faucet, waitFor*, sync*) but wires the Sphere
 * storage + tokenStorage to the Profile (OrbitDB-backed) providers
 * instead of the legacy file-based ones.
 *
 * These tests exercise the REAL infrastructure:
 *   - Helia IPFS node running in-process (libp2p + gossipsub)
 *   - OrbitDB keyvalue database with IPFS-backed OpLog
 *   - CAR pin/fetch via the live Unicity IPFS gateways
 *   - Nostr transport (for token transfer coverage)
 *
 * Run with: `npm run test:e2e`.
 */

import type { NodeProviders } from '../../impl/nodejs';
import { createNodeProviders } from '../../impl/nodejs';
import { createNodeProfileProviders } from '../../extensions/uxf/profile/node';
import type { ProfileStorageProvider } from '../../extensions/uxf/profile/profile-storage-provider';
import type { ProfileTokenStorageProvider } from '../../extensions/uxf/profile/profile-token-storage-provider';
import { DEFAULT_IPFS_BOOTSTRAP_PEERS } from '../../constants';
import { join } from 'node:path';
import { NETWORK } from './helpers';

// Re-export everything from the shared helpers so test files can import
// from a single module without caring which is which.
export * from './helpers';

/**
 * Options for `makeProfileProviders`.
 *
 * `flushDebounceMs` defaults to the SDK's own default (2s). Issue #199
 * was fixed at the SDK layer (`profile/ipfs-client.ts:pinCarBlocksToIpfs`
 * pins each CAR block under its canonical CID instead of pinning the
 * whole CAR as a single raw block), so the auto-debounced publish path
 * no longer races aggregator-gateway propagation. Tests that want
 * deterministic single-shot publishes can pass `flushDebounceMs:
 * 300_000` and call `tokenStorage.awaitNextFlush()` explicitly — see
 * profile-sync.test.ts / profile-token-persistence.test.ts /
 * profile-multi-device-sync.test.ts for examples.
 */
export interface MakeProfileProvidersOptions {
  /** Profile token-storage flush debounce. Defaults to the SDK default (2 s). */
  readonly flushDebounceMs?: number;
}

/**
 * Build Profile-backed providers for a Sphere.init() call.
 *
 * Composes:
 *   - Profile's `storage` + `tokenStorage` (OrbitDB + IPFS CAR)
 *   - Legacy Node providers' `transport` + `oracle` + `price` + `l1`
 *     (we only need the non-storage bits from the legacy factory).
 *
 * The Profile OrbitDB adapter is given the Unicity IPFS bootstrap peers
 * so two instances using the same wallet key can discover each other
 * via libp2p pubsub and replicate the KV log. CAR bundles are pinned
 * to the Unicity IPFS HTTP gateway via the same gateway list the
 * legacy `IpfsStorageProvider` uses.
 */
export function makeProfileProviders(
  dirs: {
    dataDir: string;
    tokensDir: string;
  },
  options: MakeProfileProvidersOptions = {},
): NodeProviders {
  // Build the legacy factory FIRST so we can reuse its oracle for the
  // Profile pointer-layer wiring. Without an oracle the pointer layer
  // never gets constructed and cold-start recovery silently fails.
  const legacyForNonStorage = createNodeProviders({
    network: NETWORK,
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    tokenSync: { ipfs: { enabled: false } },
    market: true,
    groupChat: true,
  });

  const profile = createNodeProfileProviders({
    network: NETWORK,
    dataDir: dirs.dataDir,
    oracle: legacyForNonStorage.oracle,
    profileConfig: {
      orbitDb: {
        privateKey: '', // set later via setIdentity()
        directory: join(dirs.dataDir, 'orbitdb'),
        bootstrapPeers: [...DEFAULT_IPFS_BOOTSTRAP_PEERS],
      },
      encrypt: true,
      // Only override the SDK's default when the caller explicitly asks
      // for a different debounce. Tests that need deterministic publish
      // (e.g. multi-coin reception followed by an explicit
      // `awaitNextFlush()`) pass a long debounce; default leaves the SDK
      // free to auto-flush on the standard cadence.
      ...(options.flushDebounceMs !== undefined
        ? { flushDebounceMs: options.flushDebounceMs }
        : {}),
      debug: process.env['E2E_PROFILE_DEBUG'] === '1',
    },
  });

  return {
    ...legacyForNonStorage,
    storage: profile.storage,
    tokenStorage: profile.tokenStorage,
    ipfsTokenStorage: undefined,
  } as NodeProviders;
}

/**
 * Extract the underlying Profile-specific provider instances from a
 * `NodeProviders` object. Type-narrowed accessors for tests that need
 * to inspect Profile internals (e.g. OrbitDB connection state).
 */
export function unwrapProfileProviders(providers: NodeProviders): {
  storage: ProfileStorageProvider;
  tokenStorage: ProfileTokenStorageProvider;
} {
  return {
    storage: providers.storage as unknown as ProfileStorageProvider,
    tokenStorage: providers.tokenStorage as unknown as ProfileTokenStorageProvider,
  };
}
