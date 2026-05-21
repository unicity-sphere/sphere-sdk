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
  parseLeanProfileSnapshotFromRootBlock,
  type BuildLeanProfileSnapshotResult,
  type LeanProfileSnapshot,
} from './profile-lean-snapshot';
import { fetchFromIpfs, pinCarBlocksToIpfs } from './ipfs-client';
import type { ProfilePointerLayer } from './aggregator-pointer';
import {
  runProfileSnapshotJoin,
  type ApplySnapshotResult,
  type SnapshotJoinWriterEntry,
} from './profile-snapshot-dispatcher';
import {
  finalizationContextPrefix,
  requestContextPrefix,
} from './finalization-queue-storage-adapter';
import {
  dispositionAuditOrphanPrefix,
  dispositionAuditPrefix,
  dispositionInvalidOrphanPrefix,
  dispositionInvalidPrefix,
} from './disposition-storage-adapters';
import { logger } from '../core/logger';

// Re-export so existing callers that imported `ProfileSnapshotPublishResult`
// from `profile/factory` still resolve (the canonical declaration moved
// to `profile/types.ts` to avoid a circular import via
// `ProfileTokenStorageProviderOptions.onProfileDirtyFlush`).
export type { ProfileSnapshotPublishResult } from './types';

/**
 * Item #15 Phase F — default tombstone retention window (30 days).
 *
 * Mirrors the value used by the standalone
 * `modules/payments/transfer/tombstone-gc-worker.ts` rollout — kept as
 * a profile-local constant so the profile layer does not import from
 * the higher-level payments layer.
 *
 * Safety contract: must exceed the longest realistic concurrent-replica
 * pre-sync window. 30 days is conservative; a fortnight-long offline
 * replica still converges before its tombstones are reclaimed.
 *
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #4 + Item #15 Phase F.
 */
export const DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Item #15 Phase F — match keys produced by `getAddressId()` to extract
 * the per-address prefix. Mirrors the regex used by the pull-side
 * dispatcher (`profile/profile-snapshot-dispatcher.ts`). Requires a
 * trailing `.` so we do not match an unrelated key that happens to
 * start with the pattern.
 */
const ADDRESS_ID_KEY_RE = /^(DIRECT_[0-9a-f]{6}_[0-9a-f]{6})\./;

/**
 * Item #15 Phase F — dependencies for `runProfileTombstoneGc`.
 *
 * Extracted so the closure body can be unit-tested with stub writer
 * builders rather than a live OrbitDB. All slots are evaluated lazily
 * each call so tombstone GC reflects the live wallet state at the
 * snapshot-build moment, not the factory-call moment.
 */
export interface ProfileTombstoneGcDeps {
  /**
   * Returns every wallet-scoped key currently visible to the storage
   * provider. The closure extracts unique addressIds via the
   * `DIRECT_xxxxxx_xxxxxx` prefix regex. Failures are treated as "no
   * addresses" and the GC pass becomes a no-op.
   */
  readonly listKeys: () => Promise<ReadonlyArray<string>>;
  /**
   * Build an OUTBOX writer for the given addressId. Returns `null`
   * when encryption is not yet wired (setIdentity pending) — the
   * closure treats `null` as "skip this address for this cycle".
   */
  readonly buildOutboxWriter: (
    addressId: string,
  ) => { gcExpiredTombstones: (opts: { readonly retentionMs: number }) => Promise<unknown> } | null;
  /**
   * Build a SENT writer for the given addressId. Same null semantics
   * as `buildOutboxWriter`.
   */
  readonly buildSentLedgerWriter: (
    addressId: string,
  ) => { gcExpiredTombstones: (opts: { readonly retentionMs: number }) => Promise<unknown> } | null;
  /** Retention window in ms (tombstones older than this are eligible). */
  readonly retentionMs: number;
}

/**
 * Item #15 Phase F — pre-snapshot tombstone GC pass.
 *
 * Iterates every active addressId visible to `listKeys()`, instantiates
 * the OUTBOX + SENT writers via the injected builders, and invokes
 * `gcExpiredTombstones({ retentionMs })` on each. Per-writer errors are
 * caught and logged; one misbehaving writer must not block GC on the
 * others or block the subsequent snapshot build.
 *
 * Best-effort by design: if `listKeys()` itself fails, the closure
 * returns silently — the GC pass becomes a no-op and the snapshot
 * builds with whatever tombstones remain. Operators relying on the
 * standalone `tombstone-gc-worker` (feature-flag gated, separate scan
 * cadence) cover the same surface independently.
 *
 * This closure is wired into the lean-snapshot builder via the new
 * `gcExpiredTombstones` hook on `BuildLeanProfileSnapshotOptions`. The
 * builder invokes the hook before its `storage.keys()` scan, so the
 * subsequent snapshot read naturally excludes any keys this pass
 * `db.del()`'d.
 *
 * @see profile/profile-lean-snapshot.ts — hook invocation point.
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase F.
 */
export async function runProfileTombstoneGc(
  deps: ProfileTombstoneGcDeps,
): Promise<void> {
  let keys: ReadonlyArray<string>;
  try {
    keys = await deps.listKeys();
  } catch (err) {
    logger.warn(
      'ProfileTombstoneGc',
      `listKeys() threw — skipping tombstone GC pass: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const addressIds = new Set<string>();
  for (const k of keys) {
    const m = ADDRESS_ID_KEY_RE.exec(k);
    if (m !== null) addressIds.add(m[1]);
  }
  if (addressIds.size === 0) return;

  for (const addressId of addressIds) {
    const outbox = deps.buildOutboxWriter(addressId);
    if (outbox !== null) {
      try {
        await outbox.gcExpiredTombstones({ retentionMs: deps.retentionMs });
      } catch (err) {
        logger.warn(
          'ProfileTombstoneGc',
          `OUTBOX gcExpiredTombstones threw for ${addressId} — continuing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const sent = deps.buildSentLedgerWriter(addressId);
    if (sent !== null) {
      try {
        await sent.gcExpiredTombstones({ retentionMs: deps.retentionMs });
      } catch (err) {
        logger.warn(
          'ProfileTombstoneGc',
          `SENT gcExpiredTombstones threw for ${addressId} — continuing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

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
  /**
   * Import the snapshot CAR to IPFS via Kubo `dag/import`. Each
   * contained block (root + any future sub-blocks) lands under its
   * canonical CID, so the published `rootCid` is retrievable via a
   * subsequent `block/get(rootCid)`. Returns the trusted rootCid on
   * success.
   */
  readonly pin: (
    carBytes: Uint8Array,
    expectedRootCid: string,
  ) => Promise<string>;
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
  // Import the CAR via Kubo `dag/import` so each contained block
  // (currently just the root; future hierarchical snapshots will add
  // per-writer / per-bundle sub-blocks) is stored under its canonical
  // CID. This makes `snapshot.rootCid` retrievable via `block/get`,
  // which `pinToIpfs`-style raw pinning did NOT — that wrote the entire
  // CAR as a single raw block under a different (raw-codec) CID, leaving
  // the published dag-cbor rootCid unaddressable on the gateway.
  await deps.pin(snapshot.carBytes, snapshot.rootCid);

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
 * Item #15 Phase D.2 — dependencies for the snapshot-apply closure.
 *
 * Extracted so the closure body can be unit-tested in isolation
 * without spinning up real OrbitDB / IPFS. The closure may fire BEFORE
 * encryption is set up (cold attach), BEFORE identity is bound, or
 * during shutdown — the `writersFor` and `getBundleIndex` accessors
 * are lazy and tolerate missing preconditions by returning empty
 * arrays / null.
 */
export interface ProfileSnapshotApplyDeps {
  /**
   * Build the per-address sync writers for an `addressId` observed in
   * the remote snapshot. Production wiring returns the union of:
   *   - storage.buildOutboxWriter(addressId)        @ `${addressId}.outbox.`
   *   - storage.buildSentLedgerWriter(addressId)   @ `${addressId}.sent.`
   *   - finalizationStorage.syncWriterFor(addressId) @ `${addressId}.finalizationQueue.`
   *   - recipientContextStorage.syncWritersFor(addressId).requestContext
   *     @ `${addressId}.recipientContext.request.`
   *   - recipientContextStorage.syncWritersFor(addressId).finalizationContext
   *     @ `${addressId}.recipientContext.finalization.`
   *
   * Returns an empty array when encryption / identity preconditions
   * are not yet satisfied (writer-builders return null and the
   * closure filters them out).
   */
  readonly writersFor: (addressId: string) => ReadonlyArray<SnapshotJoinWriterEntry>;
  /**
   * Wallet-global BundleIndex writer accessor. Returns `null` when
   * the token storage layer is not yet attached or has been torn
   * down. The dispatcher logs and skips the bundle-JOIN step on
   * `null`.
   */
  readonly getBundleIndex: () => import('./profile-snapshot-merge').ProfileSyncWriter | null;
  /** Optional debug logger; falls back to the SDK logger. */
  readonly log?: (msg: string) => void;
}

/**
 * Item #15 Phase D.2 — body of the snapshot-apply closure wired into
 * `ProfileStorageProvider.setSnapshotApplier`. The pointer-wiring
 * layer's `fetchAndJoin` callback parses the remote CAR as a
 * {@link LeanProfileSnapshot} and dispatches into this closure.
 *
 * Extracted as an exported function so it can be unit-tested in
 * isolation against stub `writersFor` / `getBundleIndex` accessors.
 *
 * The pure dispatcher in `profile/profile-snapshot-dispatcher.ts` does
 * the actual per-writer JOIN; this wrapper exists to wire the lazy
 * accessor pattern (the closure may fire across attach cycles where
 * the underlying writers come and go).
 */
export function runProfileSnapshotApply(
  snapshot: LeanProfileSnapshot,
  deps: ProfileSnapshotApplyDeps,
): Promise<ApplySnapshotResult> {
  return runProfileSnapshotJoin(snapshot, {
    writersFor: deps.writersFor,
    bundleIndex: deps.getBundleIndex(),
    log: deps.log,
  });
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
        // Item #15 Phase F — tombstone GC at snapshot-build time.
        // Resolved per call so a `setIdentity` that lands between the
        // factory construction and the next dirty-flush is observed
        // by the next GC pass. Retention overrideable via
        // `ProfileConfig.tombstoneRetentionMs` (defaults to 30 days).
        const retentionMs =
          resolvedConfig.tombstoneRetentionMs ?? DEFAULT_PROFILE_TOMBSTONE_RETENTION_MS;
        return buildLeanProfileSnapshot({
          storage,
          tokenStorage,
          chainPubkey,
          network,
          gcExpiredTombstones: () =>
            runProfileTombstoneGc({
              listKeys: () => storage.keys(),
              buildOutboxWriter: (addressId) =>
                storage.buildOutboxWriter(addressId),
              buildSentLedgerWriter: (addressId) =>
                storage.buildSentLedgerWriter(addressId),
              retentionMs,
            }),
        });
      },
      pin: (carBytes, expectedRootCid) =>
        pinCarBlocksToIpfs(ipfsGateways, carBytes, expectedRootCid),
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

  // Item #15 Phase D.2 — wire the pull-side snapshot applier. When
  // the pointer-wiring layer's `fetchAndJoin` fetches a remote CAR,
  // it parses it as a lean profile snapshot and dispatches into this
  // closure. The closure builds per-address sync writers lazily so a
  // remote snapshot referencing an HD address the receiver has not
  // yet activated still converges (the JOIN persists the entries
  // under the new address prefix; subsequent loads pick them up via
  // the storage layer's prefix scans).
  //
  // The Finalization + RecipientContext adapters are factory-built per
  // apply call so we capture the most recent encryption key — they
  // would otherwise be constructed once during this factory call,
  // before the wallet's `setIdentity` derives the encryption key, and
  // hand back null. Calling the build* methods on each apply costs a
  // few object allocations but the result is durable across writer
  // instances (the adapter is a thin handle over `db` + key).
  const dispatchParsedSnapshot = (
    snapshot: LeanProfileSnapshot,
  ): Promise<ApplySnapshotResult> =>
    runProfileSnapshotApply(snapshot, {
      writersFor: (addressId) => {
        const writers: SnapshotJoinWriterEntry[] = [];
        const outbox = storage.buildOutboxWriter(addressId);
        if (outbox !== null) {
          writers.push({ keyPrefix: `${addressId}.outbox.`, writer: outbox });
        }
        const sent = storage.buildSentLedgerWriter(addressId);
        if (sent !== null) {
          writers.push({ keyPrefix: `${addressId}.sent.`, writer: sent });
        }
        const finalizationAdapter = storage.buildFinalizationQueueStorageAdapter();
        if (finalizationAdapter !== null) {
          writers.push({
            keyPrefix: `${addressId}.finalizationQueue.`,
            writer: finalizationAdapter.syncWriterFor(addressId),
          });
        }
        const recipientContextAdapter = storage.buildRecipientContextStorageAdapter();
        if (recipientContextAdapter !== null) {
          const pair = recipientContextAdapter.syncWritersFor(addressId);
          writers.push({
            keyPrefix: requestContextPrefix(addressId),
            writer: pair.requestContext,
          });
          writers.push({
            keyPrefix: finalizationContextPrefix(addressId),
            writer: pair.finalizationContext,
          });
        }
        // Item #15 Phase B.4 — disposition sync writers (`_invalid`,
        // `_invalid-orphan`, `_audit`, `_audit-orphan`). The manifest
        // surface (`${addr}.manifest.`) is intentionally NOT included
        // here: its production storage today is in-memory only and the
        // per-field merge in `mergeManifestEntry` is incompatible with
        // a byte-verbatim PrefixSyncWriter JOIN. Tracked as a deferred
        // follow-up — see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md item #15
        // "Deferred — B.4 manifest".
        const dispositionAdapter = storage.buildDispositionStorageAdapter();
        if (dispositionAdapter !== null) {
          const dispoQuad = dispositionAdapter.syncWritersFor(addressId);
          writers.push({
            keyPrefix: dispositionInvalidPrefix(addressId),
            writer: dispoQuad.invalid,
          });
          writers.push({
            keyPrefix: dispositionInvalidOrphanPrefix(addressId),
            writer: dispoQuad.invalidOrphan,
          });
          writers.push({
            keyPrefix: dispositionAuditPrefix(addressId),
            writer: dispoQuad.audit,
          });
          writers.push({
            keyPrefix: dispositionAuditOrphanPrefix(addressId),
            writer: dispoQuad.auditOrphan,
          });
        }
        return writers;
      },
      getBundleIndex: () => tokenStorage.getBundleIndex(),
    });

  storage.setSnapshotApplier((snapshot) => dispatchParsedSnapshot(snapshot));

  // Item #15 Phase E follow-up — install the pull-side dispatcher for
  // the periodic-poll / cold-start recovery paths. Symmetric to
  // `onProfileDirtyFlush` (which publishes a snapshot CID). This
  // closure consumes a snapshot CID: fetch the CAR from IPFS,
  // content-address verified by the fetcher, parse as lean snapshot,
  // and dispatch through the SAME per-writer JOIN closure used by the
  // reconcile-loop's `fetchAndJoin`. Avoiding duplication keeps the
  // two pull paths byte-equivalent at the dispatch layer.
  //
  // Cursor advancement is NOT this closure's responsibility — the
  // pointer's local-version cursor is owned by the reconcile loop's
  // `fetchAndJoin` callback. The periodic-poll and cold-start
  // recovery paths originate outside the reconcile loop; they consume
  // `recoverLatest()` which the pointer layer has already classified.
  //
  // We install via `setApplySnapshotCallback` rather than the
  // construction-time `onApplySnapshot` option because
  // `dispatchParsedSnapshot` captures the `tokenStorage` reference
  // (for `getBundleIndex()`), which doesn't exist when the options
  // object is built. The provider's late-binding setter resolves this
  // ordering cleanly.
  tokenStorage.setApplySnapshotCallback(async (cidString) => {
    // `dag/put` (used by `pinCarBlocksToIpfs`) stored each CAR block
    // under its canonical CID, so `block/get(rootCid)` returns the
    // dag-cbor encoded root block bytes (NOT a CAR envelope).
    // `fetchFromIpfs` already verifies sha256(bytes) ==
    // cidString.multihash, so the dag-cbor decode below operates on
    // authenticated bytes.
    //
    // Phase 4 (issue #200) — v3 hierarchical snapshots carry their KV
    // entries in per-group sub-blocks linked from the root by CID. We
    // pass a fetcher closure so the parser can pull each sub-block
    // from IPFS lazily; v2 single-block snapshots ignore the fetcher.
    const rootBlockBytes = await fetchFromIpfs(ipfsGateways, cidString);
    const snapshot = await parseLeanProfileSnapshotFromRootBlock(
      rootBlockBytes,
      (subBlockCid) => fetchFromIpfs(ipfsGateways, subBlockCid),
    );
    return dispatchParsedSnapshot(snapshot);
  });

  return { storage, tokenStorage };
}
