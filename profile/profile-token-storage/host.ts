/**
 * ProfileTokenStorageHost
 *
 * Internal "host" interface that the facade `ProfileTokenStorageProvider`
 * exposes to its sub-modules (`LifecycleManager`, `FlushScheduler`,
 * `BundleIndex`, `HistoryStore`). The sub-modules read shared state and
 * common helpers via this interface rather than holding direct references
 * to facade fields.
 *
 * The facade keeps the source of truth for cross-seam state:
 *   - `status`, `initialized`, `isShuttingDown`, `identity`,
 *     `encryptionKey` — lifecycle bits read by every sub-module.
 *   - `addressId`, `replicationUnsub` — owned by lifecycle but read by
 *     bundle/history paths to scope keys.
 *   - `pendingData`, `flushTimer`, `flushPromise`, `lastPinnedCid` — owned
 *     by flush scheduler but observed by `load()` (to await an in-flight
 *     flush) and `shutdown()` (to cancel + drain).
 *   - `knownBundleCids` — owned by bundle index but read by replication
 *     handler and `clear()`.
 *
 * The facade preserves byte-identical PUBLIC API (no signature changes,
 * no field renames). Tests reach into `provider.initialized` and
 * `provider.encryptionKey` via `as any`; those names live on the facade
 * unchanged.
 *
 * @module profile/profile-token-storage/host
 */

import type { FullIdentity, ProviderStatus } from '../../types/index.js';
import type {
  StorageEvent,
  StorageEventCallback,
  StorageProvider,
  TxfStorageDataBase,
  HistoryRecord,
  TxfTombstone,
  TxfSentEntry,
} from '../../storage/storage-provider.js';
import type {
  ProfileSnapshotPublishResult,
  ProfileTokenStorageProviderOptions,
} from '../types.js';
import type { ProfileDatabase } from '../orbitdb-adapter.js';
import type { TokenManifest } from '../token-manifest.js';
import type { ApplySnapshotResult } from '../profile-snapshot-dispatcher.js';

/**
 * Operational state extracted from `TxfStorageDataBase`. Mirrored from
 * the facade's private alias so sub-modules can speak in the same
 * vocabulary without a circular import on the facade's class file.
 */
export interface OperationalState {
  tombstones: TxfTombstone[];
  outbox: import('../../storage/storage-provider.js').TxfOutboxEntry[];
  sent: TxfSentEntry[];
  invalid: import('../../storage/storage-provider.js').TxfInvalidEntry[];
  history: HistoryRecord[];
  mintOutbox: unknown[];
  invalidatedNametags: unknown[];
  audit: import('../../storage/storage-provider.js').TxfAuditEntry[];
  finalizationQueue: import('../../storage/storage-provider.js').TxfFinalizationQueueEntry[];
}

/**
 * Cross-seam shared-state contract exposed by the facade to its
 * sub-modules. All getters/setters mutate state on the facade itself —
 * the sub-modules are stateless logic bags.
 */
export interface ProfileTokenStorageHost {
  // --- Read-only deps ---
  readonly db: ProfileDatabase;
  readonly ipfsGateways: string[];
  readonly options: ProfileTokenStorageProviderOptions | undefined;
  readonly localCache: StorageProvider | null;
  readonly flushDebounceMs: number;
  readonly eventCallbacks: Set<StorageEventCallback>;

  /**
   * Issue #236 — accessor for the local Helia node so the flush and load
   * paths can use the local on-disk blockstore as the primary CAR store.
   *
   * Resolved lazily on each call so a `connect()` that lands after the
   * host is wired (or a `close()` that nulls it out before shutdown) is
   * observed by the next pin/fetch operation. Returns `null` when the
   * underlying `ProfileDatabase` is disconnected, when the adapter
   * predates issue #236 (no `getHelia` method), or when the adapter does
   * not run a local Helia (test stubs).
   *
   * Callers cast the returned value to a structural `{ blockstore: ... }`
   * shape and treat `null` as "no local fast-path; HTTP gateways only".
   */
  getHelia(): unknown | null;

  // --- Lifecycle state ---
  getStatus(): ProviderStatus;
  setStatus(s: ProviderStatus): void;
  getInitialized(): boolean;
  setInitialized(b: boolean): void;
  getIsShuttingDown(): boolean;
  setIsShuttingDown(b: boolean): void;
  getIdentity(): FullIdentity | null;
  setIdentityState(id: FullIdentity | null): void;
  getEncryptionKey(): Uint8Array | null;
  setEncryptionKey(k: Uint8Array | null): void;
  getComputedAddressId(): string | null;
  setComputedAddressId(id: string | null): void;
  getReplicationUnsub(): (() => void) | null;
  setReplicationUnsub(fn: (() => void) | null): void;

  // --- Flush state ---
  getPendingData(): TxfStorageDataBase | null;
  setPendingData(d: TxfStorageDataBase | null): void;
  getFlushTimer(): ReturnType<typeof setTimeout> | null;
  setFlushTimer(t: ReturnType<typeof setTimeout> | null): void;
  getFlushPromise(): Promise<void> | null;
  setFlushPromise(p: Promise<void> | null): void;
  getLastPinnedCid(): string | null;
  setLastPinnedCid(c: string | null): void;

  /**
   * The most recent CID observed via the aggregator pointer layer
   * (cold-start `recoverLatest()` or the periodic poll). Tracked so
   * `flushToIpfs()` can short-circuit a no-data republish when the
   * about-to-publish CAR already matches the authoritative pointer
   * (i.e., another device already anchored the same merged state).
   */
  getLastDiscoveredPointerCid(): string | null;
  setLastDiscoveredPointerCid(c: string | null): void;

  /**
   * A CID whose CAR is pinned to IPFS and whose OrbitDB bundle ref is
   * written, but whose pointer publish (aggregator anchor) is still
   * outstanding due to a transient failure. The next flush AND the
   * periodic pointer-poll re-attempt the publish at start; on success
   * the field is cleared. While non-null, the at-least-once gate in
   * `PaymentsModule.handleIncomingTransfer` is held closed because the
   * cross-device recovery path cannot reach this bundle yet.
   *
   * Persisted to `localCache` under the key
   * `STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID_PREFIX + addressId`
   * for crash-safety so a process restart resumes the retry rather
   * than abandoning the publish silently.
   */
  getPendingPublishCid(): string | null;
  setPendingPublishCid(c: string | null): void;

  // --- Bundle index state ---
  getKnownBundleCids(): Set<string>;
  setKnownBundleCids(s: Set<string>): void;

  // --- Last-loaded snapshot (read by load() / shutdown()) ---
  getLastLoadedData(): TxfStorageDataBase | null;
  setLastLoadedData(d: TxfStorageDataBase | null): void;

  /**
   * Set of bundle CIDs that load() merged into the most recent
   * `lastLoadedData`. Read by FlushScheduler's runtime monotonicity
   * assertion to detect a stale baseline (OrbitDB has bundles not
   * represented in lastLoadedData → flush would silently drop tokens
   * from the published pointer V_n's CAR).
   *
   * Null when no successful load() has run yet (assertion has nothing
   * to compare against and skips).
   */
  getLastLoadedFromBundleCids(): Set<string> | null;
  setLastLoadedFromBundleCids(s: Set<string> | null): void;

  getLastTokenManifest(): TokenManifest | null;
  setLastTokenManifest(m: TokenManifest | null): void;

  // --- Address-scoped key prefix ---
  getAddressId(): string;

  // --- Logging / events ---
  log(message: string): void;
  emitEvent(event: StorageEvent): void;
  buildErrorEvent(
    type: 'storage:error' | 'sync:error',
    err: unknown,
    overrideCode?: string,
  ): StorageEvent;

  // --- Encryption-aware OrbitDB key helpers ---
  writeProfileKey(key: string, value: string): Promise<void>;
  readProfileKey(key: string): Promise<string | null>;
  readProfileKeyJson<T>(key: string): Promise<T | null>;

  // --- Flush coordination (FlushScheduler entry point) ---
  /** Snapshot pendingData and run a single IPFS pin + OrbitDB write. */
  flushToIpfs(): Promise<void>;

  /**
   * Refresh `lastLoadedFromBundleCids` (and `lastLoadedData`) by
   * running a fresh `load()` against the current OrbitDB bundle
   * index. Called by FlushScheduler on a `POINTER_MONOTONICITY_VIOLATION`
   * to repair a stale baseline before the next flush attempt.
   *
   * MUST be a no-op when a flush is already in flight (load() awaits
   * `flushPromise`, so calling from inside flushToIpfs would deadlock).
   * The facade implementation handles this by skipping the refresh
   * when invoked synchronously from within the current flush body.
   *
   * Returns true on successful refresh; false on internal load failure
   * (caller proceeds to the next strategy — typically throw the
   * original violation so the at-least-once gate refuses the ack).
   */
  refreshBaselineForMonotonicity(): Promise<boolean>;

  // --- TXF adapter helpers (stay on the facade for now) ---
  extractTokensFromTxfData(data: TxfStorageDataBase): Map<string, unknown>;
  extractOperationalState(data: TxfStorageDataBase): OperationalState;

  // --- Operational state persistence ---
  writeOrbitOperationalState(opState: OperationalState): Promise<void>;
  writeLocalDerivedCache(opState: {
    tombstones: TxfTombstone[];
    sent: TxfSentEntry[];
    history: HistoryRecord[];
  }): Promise<boolean>;

  /**
   * Item #15 Phase C — signal the host that some local profile state
   * has changed and should be included in the next lean-snapshot
   * publish. Called by per-writer mutations (OutboxWriter,
   * SentLedgerWriter, BundleIndex, etc.) and by JOIN-applied remote
   * changes. The host's implementation debounces these signals via the
   * FlushScheduler (Phase C.2/D wires the actual snapshot build).
   *
   * MUST be non-throwing — writers invoke this inside guarded
   * try/catch so a misbehaving host cannot break a mutation path.
   */
  notifyProfileDirty(): void;

  /**
   * Item #15 Phase D.1b — synchronously invoke the wired
   * `onProfileDirtyFlush` callback (lean-snapshot build + pin +
   * publish) coordinated with the dispatch debounce so we don't
   * double-publish. Used by `FlushScheduler.flushToIpfs()` to publish
   * a SNAPSHOT CID via the aggregator pointer layer instead of the
   * legacy BUNDLE CID.
   *
   * Semantics:
   *   - Returns `null` when no `onProfileDirtyFlush` callback is wired
   *     (legacy tests / providers without the Phase C.3 closure).
   *     Caller falls back to the legacy bundle-CID publish.
   *   - Coordinates with the dirty-flush debouncer: cancels any armed
   *     timer, awaits any in-flight dispatch, clears the pending latch
   *     before running so a follow-up `notifyProfileDirty()` re-arms
   *     for the next signal.
   *   - On success, returns the publisher's structured result.
   *   - On an unexpected throw from the callback (programmer error or
   *     transient publish failure surfaced as `runProfileDirtyFlush`'s
   *     internal throw), emits `storage:error`
   *     (`PROFILE_DIRTY_FLUSH_FAILED`) and re-throws so the caller
   *     can decide ack semantics (e.g. flush-scheduler propagates to
   *     `forceFlushSerialized`'s rejection arm to hold the at-least-
   *     once gate closed).
   *
   * Distinct from `notifyProfileDirty()` (which schedules a debounced
   * fire) — this entry point fires NOW and returns the result.
   */
  publishSnapshotIfWired(): Promise<ProfileSnapshotPublishResult | null>;

  /**
   * Item #15 Phase E follow-up — pull-side symmetric counterpart to
   * {@link publishSnapshotIfWired}. Fetches the snapshot CAR for the
   * given CID, parses it as a {@link LeanProfileSnapshot}, and
   * dispatches per-writer JOIN through the factory-wired snapshot
   * applier. Used by `LifecycleManager.runPointerPollOnce` and
   * `recoverFromAggregatorPointerBestEffort` so the periodic-poll and
   * cold-start recovery paths consume the pointer's CID as a snapshot
   * (Item #15) rather than as a UXF bundle CID (the pre-Item-#15
   * legacy that wrote the snapshot bytes into the bundle index and
   * blew up on the next load()).
   *
   * Semantics:
   *   - Returns `null` when no `onApplySnapshot` callback is wired
   *     (legacy tests / providers without the factory closure). Caller
   *     logs and skips — no legacy bundle-CID fallback per Phase E.
   *   - On success: returns the dispatcher's
   *     {@link ApplySnapshotResult} (counters, joinedAny, etc.).
   *   - On hard failure (CAR fetch, parse, or dispatcher throw):
   *     re-throws so the caller's outer try/catch can log + skip the
   *     re-arm round. The pointer cursor is NOT advanced by this path
   *     (cursor advancement only happens through `fetchAndJoin` on the
   *     reconcile-loop path); a transient failure on the periodic
   *     poll is best-effort.
   *
   * IMPORTANT: this method does NOT touch the pointer's local-version
   * cursor — both the poll and recovery paths originate outside the
   * cursor-advancement protocol (they consume `recoverLatest()` which
   * the pointer layer already classified). The cursor advance is owned
   * by the reconcile loop's `fetchAndJoin` callback exclusively.
   */
  applySnapshotIfWired(cidString: string): Promise<ApplySnapshotResult | null>;
}
