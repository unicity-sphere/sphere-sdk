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
  ProfileRecoveryMarker,
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
   * The most recent UXF bundle CID this provider successfully pinned
   * to IPFS and wrote to the OrbitDB bundle index. Distinct from
   * `lastPinnedCid` (a retry cache cleared after the post-pin OrbitDB
   * write succeeds) — this field survives across flushes for the life
   * of the provider so `LifecycleManager.shutdown()` can HEAD-verify
   * the bundle CAR is actually served by ≥1 IPFS gateway before
   * returning. See issue #239.
   *
   * Null when no successful flush has run yet (cold-start before any
   * save), in which case shutdown skips the bundle-leg verification.
   */
  getLastPinnedBundleCid(): string | null;
  setLastPinnedBundleCid(c: string | null): void;

  /**
   * Issue #239 — most-recent CID pair that successfully passed the
   * per-flush remote-durability gate ({@link verifyFlushDurability}).
   * The shutdown gate ({@link awaitRemoteDurability}) consults these
   * to short-circuit its own verification: if the pin / pointer
   * watermark already matches what shutdown would verify, the gate
   * runs as a fast no-op (saves 15-30s of redundant HEAD + aggregator
   * round-trips per destroy()).
   *
   * Null until the first successful per-flush verification. Cleared
   * implicitly by a fresh flush on different CIDs (the next per-flush
   * gate either succeeds and updates them, or fails and leaves them
   * pointing at the previous verified state — shutdown still runs the
   * legs on the newer CIDs).
   */
  getLastVerifiedBundleCid(): string | null;
  setLastVerifiedBundleCid(c: string | null): void;
  getLastVerifiedSnapshotCid(): string | null;
  setLastVerifiedSnapshotCid(c: string | null): void;

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
   * the field is cleared.
   *
   * Issue #241: while non-null, the at-least-once Nostr gate
   * (`PaymentsModule.handleIncomingTransfer`) is NO LONGER held
   * closed — pin durability is the cross-device recoverability
   * invariant; the aggregator publish is a liveness optimization
   * for cold-import discovery and is retried in background.
   * Operators see the outstanding state via `storage:pending-publish`
   * (and `storage:replica-lag` for the WALKBACK_FLOOR case).
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

  /**
   * Issue #360 Finding #1 (second-order) — record that the local process
   * just authored a bundle ref for `cid`. The provider tracks these in a
   * small time-bounded set (~60s window) so the replication handler can
   * distinguish "a CID newly visible to OrbitDB because WE wrote it" from
   * "a CID newly visible because a peer replicated it". The former needs
   * no aggregator poll or CAR re-fetch — pre-#360 it triggered both,
   * yielding a feedback loop where 1 save → ~B IPFS round-trips.
   *
   * Best-effort, never throws. Bounded internally by the provider to
   * keep memory deterministic across long-running daemon sessions.
   *
   * Optional so test-stub hosts that don't model the dedup path remain
   * compatible (the BundleIndex caller uses optional chaining).
   */
  noteLocallyAuthoredBundleCid?(cid: string): void;

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
    type: 'storage:error' | 'sync:error' | 'storage:pointer-version-skipped-unfetchable',
    err: unknown,
    overrideCode?: string,
  ): StorageEvent;

  // --- Encryption-aware OrbitDB key helpers ---
  writeProfileKey(key: string, value: string): Promise<void>;
  readProfileKey(key: string): Promise<string | null>;
  readProfileKeyJson<T>(key: string): Promise<T | null>;

  /**
   * Persist a {@link ProfileRecoveryMarker} for this Profile.
   *
   * MUST be called AFTER `db.resetCorruptedLog` succeeds. Idempotent —
   * subsequent calls overwrite the marker (intentional: we want the
   * most recent `recoveredAt` / `lostHeadCid` for operator triage).
   *
   * The marker is OBSERVABLE and PERMANENT — the wallet cannot un-mark
   * itself once recovery has happened. The SDK never deletes it; only
   * `Sphere.clear()` (full wallet wipe) removes it. Surface via
   * `getRecoveryStatus()` to display a "Recovered" badge in the UI.
   *
   * Stored under key `_profile_recovered:<addressId>` via the same
   * encrypted-write path used by other Profile metadata.
   */
  writeRecoveryMarker(marker: ProfileRecoveryMarker): Promise<void>;

  /**
   * Read the {@link ProfileRecoveryMarker} for this Profile, or null
   * when no recovery has ever happened on this device for this address.
   * Public surface lives on the facade as `getRecoveryStatus()`.
   */
  readRecoveryMarker(): Promise<ProfileRecoveryMarker | null>;

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
   * Issue #239 — per-flush remote-durability verification.
   *
   * Delegates to `LifecycleManager.verifyFlushDurability` so the
   * FlushScheduler can run the same HEAD-verify + aggregator read-back
   * legs that the shutdown gate uses, but on the CIDs from the
   * just-completed flush. Throws on verification failure so the at-
   * least-once gate (`awaitNextFlush` → caller refuses the Nostr ack)
   * propagates the failure across the pipeline.
   *
   * Called by `FlushScheduler.flushToIpfs` AFTER pin + publish succeed.
   * Returns void on success; throws an error with `code:
   * 'FLUSH_DURABILITY_TIMEOUT'` on any leg exhausting the deadline.
   *
   * @param bundleCid    UXF bundle CID just pinned via flushToIpfs.
   * @param snapshotCid  Snapshot CID just published (null if no
   *                      pointer layer is wired).
   * @param deadlineMs   Wall-clock budget for verification. Tracked
   *                      independently of any caller deadline; the
   *                      flush body picks it up from
   *                      `options.flushVerificationDeadlineMs`.
   */
  verifyFlushDurability(
    bundleCid: string,
    snapshotCid: string | null,
    deadlineMs: number,
  ): Promise<void>;

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

  /**
   * Issue #313 — atomic-write the local snapshot blob (lazy-load cache)
   * with the current in-memory state. Called by `FlushScheduler` after
   * every successful flush + publish, by `LifecycleManager.shutdown()`
   * on graceful exit, and by `LifecycleManager` after a background sync
   * walks the pointer forward.
   *
   * Failures are caught and surfaced via `storage:error` with code
   * `PROFILE_SNAPSHOT_WRITE_FAILED`; they do NOT propagate to the caller
   * because the snapshot is a perf optimisation, not a correctness gate
   * (worst case: next cold boot falls through to the slow path).
   *
   * `trigger` is forwarded into the emitted
   * `profile:snapshot-refreshed` event so operator dashboards can
   * distinguish flush-driven writes from shutdown drains and from
   * background-sync writes.
   *
   * No-ops when:
   *   - `localCache` is null (provider constructed without a local cache);
   *   - identity is not yet bound (cold-start before `setIdentity()`);
   *   - the network identifier is not configured (defensive).
   */
  writeLocalSnapshot(
    trigger: 'flush' | 'shutdown' | 'background-sync',
    options?: {
      readonly previousPointerVersion?: number | null;
      readonly durationMs?: number;
    },
  ): Promise<void>;

  /**
   * Issue #313 — read the local snapshot blob and SEED the in-memory
   * state (`lastLoadedData`, `knownBundleCids`, `lastDiscoveredPointerCid`)
   * from it. Called by `LifecycleManager.initialize()` BEFORE the
   * OrbitDB connect + bundle-index refresh so a cold-boot UI render
   * does not wait on the aggregator pointer recovery.
   *
   * Returns `true` if a valid snapshot was found and applied; `false`
   * otherwise (fresh wallet, corrupt blob, or no local cache). Caller
   * still runs the normal initialize flow — the snapshot just pre-fills
   * the state so the UI has something to render immediately.
   *
   * On corruption, the broken blob is cleaned up and
   * `profile:snapshot-corrupt` is emitted. On a successful seed,
   * `profile:snapshot-loaded` is emitted with timing metadata.
   */
  readLocalSnapshot(): Promise<boolean>;
}
