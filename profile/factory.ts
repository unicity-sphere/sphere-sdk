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
import type {
  ProfileConfig,
  ProfileSnapshotPublishResult,
  ProfileTokenStorageProviderOptions,
} from './types';
import { OrbitDbAdapter } from './orbitdb-adapter';
import { ProfileStorageProvider } from './profile-storage-provider';
import { ProfileTokenStorageProvider } from './profile-token-storage-provider';
import { DEFAULT_IPFS_GATEWAYS } from '../constants';
import {
  buildLeanProfileSnapshot,
  type BuildLeanProfileSnapshotResult,
} from './profile-lean-snapshot';
import { pinToIpfs } from './ipfs-client';
import type { ProfilePointerLayer } from './aggregator-pointer';

// Re-export so existing callers that imported `ProfileSnapshotPublishResult`
// from `profile/factory` still resolve (the canonical declaration moved
// to `profile/types.ts` to avoid a circular import via
// `ProfileTokenStorageProviderOptions.onProfileDirtyFlush`).
export type { ProfileSnapshotPublishResult } from './types';

/**
 * Item #15 Phase C.3 (extended by D.1a) — dependencies for the
 * dirty-flush closure.
 *
 * Extracted so the closure body can be unit-tested in isolation. All
 * accessors are evaluated lazily inside `runProfileDirtyFlush`: the
 * closure may fire BEFORE identity is bound, BEFORE the pointer layer
 * has been built, or BEFORE network has been threaded — in any of
 * those cases the closure must safely no-op.
 *
 * The injectable `pin`, `buildSnapshot`, and `publishCid` slots let
 * tests stub the I/O surfaces without spinning up real IPFS / OrbitDB
 * or the LifecycleManager.
 *
 * **Phase D.1a delta**: `getPointerLayer` (readiness probe) is kept
 * because it lets the closure bail BEFORE doing the build+pin work
 * when no pointer is wired. The actual publish is delegated to
 * `publishCid`, which the factory wires to
 * `tokenStorage.publishLeanSnapshotCid(cid)` →
 * `lifecycle.publishAggregatorPointerBestEffort(cid)`. This routes
 * snapshot CID publishes through the same retry / error-classification
 * machinery as the legacy bundle-CID publish path.
 */
export interface ProfileDirtyFlushDeps {
  /** Resolves the live `chainPubkey`, or `null` pre-`setIdentity`. */
  readonly getChainPubkey: () => string | null;
  /** Returns the active network identifier, or `null` if unconfigured. */
  readonly getNetwork: () => string | null;
  /** Returns the constructed pointer layer, or `null` when unavailable. */
  readonly getPointerLayer: () => ProfilePointerLayer | null;
  /** Build the lean profile snapshot CAR. */
  readonly buildSnapshot: (
    chainPubkey: string,
    network: string,
  ) => Promise<BuildLeanProfileSnapshotResult>;
  /** Pin a CAR to IPFS. Returns the CID string (ignored by the closure). */
  readonly pin: (carBytes: Uint8Array) => Promise<string>;
  /**
   * Phase D.1a — publish a snapshot CID via
   * `LifecycleManager.publishAggregatorPointerBestEffort`. The wired
   * implementation handles retry-marker persistence, permanent-vs-
   * transient classification, and `storage:error` emission on
   * permanent failure. The closure throws when the publish came back
   * with a TRANSIENT failure so the upstream debouncer surfaces the
   * cause via `storage:error` (code `PROFILE_DIRTY_FLUSH_FAILED`).
   */
  readonly publishCid: (cidString: string) => Promise<ProfileSnapshotPublishResult>;
}

/**
 * Item #15 Phase C.3 (extended by D.1a) — body of the
 * `onProfileDirtyFlush` closure wired into
 * `ProfileTokenStorageProvider`. The provider's debouncer (Phase C.2)
 * invokes this after any writer-side mutation settles.
 *
 * Sequence:
 *   1. Read `chainPubkey` and `network`. Bail if either is missing
 *      (cold-start before `setIdentity()`, or unconfigured `network`).
 *   2. Read the pointer layer (readiness probe). Bail if not yet
 *      ready — the pointer-poll path will retry once it attaches.
 *   3. Build a lean profile snapshot CAR via the injected builder.
 *   4. Pin the CAR via the injected pinner (multi-gateway IPFS).
 *   5. Publish the snapshot's root CID via `publishCid` (which routes
 *      through `LifecycleManager.publishAggregatorPointerBestEffort`).
 *      On TRANSIENT publish failure THROW so the upstream debouncer
 *      surfaces the cause via `storage:error`. PERMANENT failures are
 *      reported by the lifecycle layer (it emits its own
 *      `storage:error`) and are returned as `{ ok: false, transient:
 *      false }` — we silently swallow them here because retrying would
 *      not help and the operator-visible alert has already fired.
 *
 * Returns `ProfileSnapshotPublishResult` so synchronous callers
 * (Phase D.1b's flush-scheduler integration) can inspect the outcome.
 * The auto-fire debounce path discards the result.
 */
export async function runProfileDirtyFlush(
  deps: ProfileDirtyFlushDeps,
): Promise<ProfileSnapshotPublishResult> {
  const chainPubkey = deps.getChainPubkey();
  if (!chainPubkey) {
    return { ok: false, transient: false, code: 'NOT_READY_IDENTITY' };
  }

  const network = deps.getNetwork();
  if (!network) {
    return { ok: false, transient: false, code: 'NOT_READY_NETWORK' };
  }

  const pointer = deps.getPointerLayer();
  if (!pointer) {
    return { ok: false, transient: false, code: 'NOT_READY_POINTER' };
  }

  const snapshot = await deps.buildSnapshot(chainPubkey, network);
  await deps.pin(snapshot.carBytes);

  const result = await deps.publishCid(snapshot.rootCid);
  if (!result.ok && result.transient) {
    // Surface transient publish failures to the upstream debouncer so
    // `storage:error` fires with PROFILE_DIRTY_FLUSH_FAILED. The
    // pending-publish marker is already stamped by the lifecycle layer
    // — subsequent flushes / pointer-polls will retry.
    throw new Error(
      `dirty-flush publish transient failure (cid=${snapshot.rootCid})` +
        (result.code ? `; code=${result.code}` : ''),
    );
  }
  return result;
}

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

  // Item #15 Phase C.3 — late-bound holder for the token storage so the
  // `onProfileDirtyFlush` closure (constructed BEFORE the provider) can
  // reach back into the running provider at fire time. `null` until the
  // provider is constructed below; the closure no-ops while null.
  const tokenStorageHolder: { current: ProfileTokenStorageProvider | null } = {
    current: null,
  };

  // Item #15 Phase C.3 — dirty-flush closure. Wired into
  // `ProfileTokenStorageProvider` via `onProfileDirtyFlush`; the
  // provider's debounced dispatcher (Phase C.2) invokes this after
  // any writer-side mutation (OUTBOX/SENT/finalization/recipient
  // context/bundle index) settles. The closure body lives in
  // `runProfileDirtyFlush` so it can be unit-tested in isolation
  // against stub I/O surfaces. See the function-level comment for
  // sequencing and skip semantics.
  const onProfileDirtyFlush = (): Promise<ProfileSnapshotPublishResult> =>
    runProfileDirtyFlush({
      getChainPubkey: () =>
        tokenStorageHolder.current?.getIdentity()?.chainPubkey ?? null,
      getNetwork: () => resolvedConfig.network ?? null,
      getPointerLayer: () => storage.getPointerLayer(),
      buildSnapshot: async (chainPubkey, network) => {
        const tokenStorage = tokenStorageHolder.current;
        if (!tokenStorage) {
          // Defensive — `runProfileDirtyFlush` checks identity (which
          // requires the holder anyway) before reaching us, so this is
          // an unreachable branch in practice.
          throw new Error(
            'onProfileDirtyFlush: tokenStorage holder unexpectedly null',
          );
        }
        return buildLeanProfileSnapshot({
          storage,
          tokenStorage,
          chainPubkey,
          network,
        });
      },
      pin: (carBytes) => pinToIpfs(ipfsGateways, carBytes),
      // Phase D.1a — route the snapshot CID publish through the
      // provider's LifecycleManager so it picks up retry / error-
      // classification / pending-publish-marker machinery. The legacy
      // bundle-CID publish path (flush-scheduler) uses the same
      // entrypoint via lifecycle.publishAggregatorPointerBestEffort,
      // so both publishes share the same retry semantics. (Phase D.1b
      // will collapse the two paths so only the snapshot publish
      // runs — see Item #15 Phase E.)
      publishCid: async (cidString) => {
        const tokenStorage = tokenStorageHolder.current;
        if (!tokenStorage) {
          // Unreachable — runProfileDirtyFlush has already checked the
          // pointer layer (which requires the holder) before calling
          // publishCid. Defensive return: classified as permanent
          // because retrying without a holder cannot succeed.
          return { ok: false, transient: false, code: 'NOT_READY_HOLDER' };
        }
        return tokenStorage.publishLeanSnapshotCid(cidString);
      },
    });

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
    // Item #15 Phase C.3 — wire the lean-snapshot dirty-flush path.
    onProfileDirtyFlush,
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
  tokenStorageHolder.current = tokenStorage;

  // Item #15 Phase C.3 — bridge writer-side dirty signals to the
  // token-storage debouncer. `setProfileDirtyNotifier(cb)` propagates
  // the callback into every per-writer instance produced by the
  // storage's `build*` factories (OutboxWriter, SentLedgerWriter,
  // PrefixSyncWriter, OrbitDb{Finalization,RecipientContext}Adapter,
  // BundleIndex). Without this hop, writer mutations would never
  // reach the debouncer — Phase C.1 only landed the producer side.
  storage.setProfileDirtyNotifier(() => tokenStorage.notifyProfileDirty());

  return { storage, tokenStorage };
}
