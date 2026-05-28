/**
 * Storage Provider Interface
 * Platform-independent storage abstraction
 */

import type { BaseProvider, FullIdentity, TrackedAddressEntry } from '../types';

// =============================================================================
// Storage Provider Interface
// =============================================================================

/**
 * Basic key-value storage provider
 * All operations are async for platform flexibility
 */
export interface StorageProvider extends BaseProvider {
  /**
   * Set identity for scoped storage
   */
  setIdentity(identity: FullIdentity): void;

  /**
   * Get value by key
   */
  get(key: string): Promise<string | null>;

  /**
   * Set value by key
   */
  set(key: string, value: string): Promise<void>;

  /**
   * Optional: set value with an explicit OpLog entry type for W11
   * originated-tag discipline. Callers that know the semantic
   * classification of the write (e.g. `'token_send'` on a transfer,
   * `'cache_index'` on a dedup table write) SHOULD use this to
   * stamp the storage-level envelope so peers replicating the
   * entry see the correct classification after the receiver-
   * authority downgrade.
   *
   * Providers that do not implement an OpLog-envelope storage layer
   * (plain IndexedDB / file KV) omit this method entirely; callers
   * fall back to `set()` and lose the stamp but the operation
   * otherwise behaves identically. See profile/aggregator-pointer/
   * originated-tag.ts for the `OpLogEntryType` union.
   *
   * Only declared here as a loose `string` type to avoid a circular
   * dependency into profile/aggregator-pointer. Implementations
   * validate via `assertOriginTagLocal`.
   */
  setEntry?(key: string, value: string, entryType: string): Promise<void>;

  /**
   * Wave G.6: optional atomic multi-key write.
   *
   * Implementations that support cross-key transactions (IndexedDB,
   * proper-lockfile-guarded file storage) commit all entries
   * atomically — either every key is written or none are. Callers
   * use this for invariants that span multiple keys (e.g. wallet
   * metadata: encrypted mnemonic + base path + derivation mode +
   * source — all four must land together so a partial-write doesn't
   * derive the wrong identity from defaults).
   *
   * If the provider does not implement this, callers fall back to
   * sequential `set()` calls with best-effort rollback on partial
   * failure (see core/Sphere.ts storeMnemonic for the pattern).
   */
  setMany?(entries: ReadonlyArray<readonly [key: string, value: string]>): Promise<void>;

  /**
   * Remove key
   */
  remove(key: string): Promise<void>;

  /**
   * Check if key exists
   */
  has(key: string): Promise<boolean>;

  /**
   * Get all keys with optional prefix filter
   */
  keys(prefix?: string): Promise<string[]>;

  /**
   * Clear all keys with optional prefix filter
   */
  clear(prefix?: string): Promise<void>;

  /**
   * Save tracked addresses (only user state: index, hidden, timestamps)
   */
  saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void>;

  /**
   * Load tracked addresses
   */
  loadTrackedAddresses(): Promise<TrackedAddressEntry[]>;
}

// =============================================================================
// History Record (shared by all token storage providers)
// =============================================================================

export interface HistoryRecord {
  /** Composite dedup key (primary key) — e.g. "RECEIVED_v5split_abc123" */
  dedupKey: string;
  /** UUID for public API consumption */
  id: string;
  type: 'SENT' | 'RECEIVED' | 'SPLIT' | 'MINT';
  amount: string;
  coinId: string;
  symbol: string;
  timestamp: number;
  transferId?: string;
  /** Genesis tokenId this entry relates to (used for dedup) */
  tokenId?: string;
  // Sender info (for RECEIVED)
  senderPubkey?: string;
  senderAddress?: string;
  senderNametag?: string;
  // Recipient info (for SENT)
  recipientPubkey?: string;
  recipientAddress?: string;
  recipientNametag?: string;
  /** Optional memo/message attached to the transfer */
  memo?: string;
  /** All token IDs in a combined transfer (V6 bundle breakdown) */
  tokenIds?: Array<{ id: string; amount: string; source: 'split' | 'direct' }>;
}

// =============================================================================
// Token Storage Provider Interface
// =============================================================================

/**
 * Storage result types
 */
export interface SaveResult {
  success: boolean;
  cid?: string;
  error?: string;
  timestamp: number;
}

export interface LoadResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  source: 'local' | 'remote' | 'cache';
  timestamp: number;
}

export interface SyncResult<T = unknown> {
  success: boolean;
  merged?: T;
  added: number;
  removed: number;
  conflicts: number;
  error?: string;
}

/**
 * Token-specific storage provider
 * Handles token persistence with sync capabilities
 */
export interface TokenStorageProvider<TData = unknown> extends BaseProvider {
  /**
   * Set identity for storage scope
   */
  setIdentity(identity: FullIdentity): void;

  /**
   * Initialize provider (called once after identity is set)
   */
  initialize(): Promise<boolean>;

  /**
   * Shutdown provider.
   *
   * Issue #239 — `options.force` selects between the normal-mode
   * shutdown contract (must verify remote durability before returning;
   * see {@link ShutdownOptions}) and the fast-exit contract for tests /
   * ungraceful-crash simulation. Providers without a remote-durability
   * boundary (file/IndexedDB) silently ignore the options.
   */
  shutdown(options?: ShutdownOptions): Promise<void>;

  /**
   * Save token data
   */
  save(data: TData): Promise<SaveResult>;

  /**
   * Load token data
   */
  load(identifier?: string): Promise<LoadResult<TData>>;

  /**
   * Sync local data with remote
   */
  sync(localData: TData): Promise<SyncResult<TData>>;

  /**
   * Force any pending/debounced flush to complete and await durability.
   *
   * Optional — providers without write-behind buffers (filesystem,
   * synchronous IndexedDB) can omit it; callers MUST treat absence as
   * "already durable on save() return" (i.e., no-op).
   *
   * Used to enforce the at-least-once invariant for inbound Nostr-
   * delivered tokens: `payments.handleIncomingTransfer` calls this on
   * every provider after `save()` so the Nostr `since` filter is only
   * advanced when the token has been persisted to a durable store. If
   * the provider's flush fails (rejects), the caller treats the inbound
   * event as NOT durable and does NOT advance the `since` filter, so
   * the event is re-replayed on next reconnect (idempotent because
   * `addToken` already dedupes by `(tokenId, stateHash)`).
   *
   * Implementations MUST:
   *  - Cancel any armed debounce timer (do not wait its full window).
   *  - If a flush is already in-flight, await it.
   *  - If `pendingData` is non-null after that, fire a fresh flush and
   *    await it. Loop until `pendingData` is null OR timeout elapses.
   *  - Throw a `SphereError('TIMEOUT')` if `timeoutMs` elapses with
   *    pendingData still non-null.
   *  - Surface any flush failure (POINTER_MONOTONICITY_VIOLATION etc.)
   *    by rejecting — caller decides whether to retry or skip ack.
   *
   * @param timeoutMs Max wall-clock time before rejecting. Default 30s.
   */
  awaitNextFlush?(timeoutMs?: number): Promise<void>;

  /**
   * Check if data exists
   */
  exists?(identifier?: string): Promise<boolean>;

  /**
   * Clear all data
   */
  clear?(): Promise<boolean>;

  /**
   * Create a new independent instance of this provider for a different address.
   * Used by per-address module architecture — each address gets its own
   * TokenStorageProvider instance to avoid cross-address data contamination.
   * If not implemented, the provider cannot be used in multi-address mode.
   */
  createForAddress?(): TokenStorageProvider<TData>;

  /**
   * Subscribe to storage events
   */
  onEvent?(callback: StorageEventCallback): () => void;

  // --- History operations (optional — not supported by all providers, e.g. IPFS) ---

  /** Store a history entry (upsert by dedupKey) */
  addHistoryEntry?(entry: HistoryRecord): Promise<void>;

  /** Get all history entries sorted by timestamp descending */
  getHistoryEntries?(): Promise<HistoryRecord[]>;

  /** Check if a history entry exists by dedupKey */
  hasHistoryEntry?(dedupKey: string): Promise<boolean>;

  /** Clear all history entries */
  clearHistory?(): Promise<void>;

  /** Bulk import history entries (skip existing dedupKeys). Returns count of newly imported. */
  importHistoryEntries?(entries: HistoryRecord[]): Promise<number>;
}

// =============================================================================
// Storage Events
// =============================================================================

export type StorageEventType =
  | 'storage:saving'
  | 'storage:saved'
  | 'storage:loading'
  | 'storage:loaded'
  | 'storage:error'
  | 'storage:remote-updated'
  | 'sync:started'
  | 'sync:completed'
  | 'sync:conflict'
  | 'sync:error'
  /**
   * Issue #239 — emitted by `LifecycleManager.shutdown` when the
   * remote-durability verification gate exhausts its deadline on at
   * least one leg. `data` carries `{ leg, cidsInQuestion, lastError?,
   * reason? }` so operators see which path stalled (`pin-verify` /
   * `pointer-read-back` / `pending-publish-retry`) and which CIDs are
   * affected. Shutdown continues to tear down regardless; the event is
   * informational so operators can investigate cross-process recovery
   * gaps. Skipped when `Sphere.destroy({ force: true })` is used.
   */
  | 'shutdown:verification-timeout'
  /**
   * Issue #241 — emitted when the aggregator pointer publish path
   * returns a TRANSIENT failure for a just-flushed bundle. The flush
   * itself succeeded (CAR pinned + bundle ref written + pin verified
   * fetchable), but the aggregator publish stamped `pendingPublishCid`
   * for retry. `data` carries `{ cid, code? }` — `cid` is the bundle
   * CID and `code` is the pointer-layer error code when classifiable
   * (e.g., `AGGREGATOR_POINTER_WALKBACK_FLOOR`, `NETWORK_ERROR`).
   *
   * Distinct from `storage:error` (which is a fatal-class signal). A
   * pending-publish event tells the operator that the local state is
   * durable AND cross-device readers via OrbitDB sync will see the new
   * state, but COLD-IMPORT discovery (a fresh device with only the
   * master key) will read the previous pointer version until the
   * retry succeeds. The retry happens automatically on the next flush
   * or pointer poll.
   */
  | 'storage:pending-publish'
  /**
   * Issue #241 — emitted when discovery / publish observes the
   * aggregator's read replica lagging behind a version the wallet has
   * already locally confirmed. Concretely: Phase 3 walkback returns
   * `AGGREGATOR_POINTER_WALKBACK_FLOOR` after the
   * `WALKBACK_FLOOR_RETRY_BUDGET` exponential-backoff window
   * (~15s) without the replica catching up. `data` carries
   * `{ localVersion, cid? }` so operators can correlate with
   * aggregator-side replication metrics.
   *
   * Informational only — the publish path's `pendingPublishCid`
   * marker is already stamped (treated as transient), and the
   * next flush / pointer poll continues to retry. This event lets
   * operators distinguish "publish stuck on replica lag" from
   * other transient classes (network errors, etc.).
   */
  | 'storage:replica-lag'
  /**
   * Issue #247 — emitted when the WALKBACK_FLOOR catch arm
   * successfully reconciled the wallet's local pointer version
   * DOWNWARD to match the aggregator's currently-visible (same-
   * author) version. Indicates a same-identity cross-device race
   * was resolved: two devices sharing one wallet identity each
   * published pointers ahead of one another, and this device
   * adopted the lower visible value (authored by this wallet's
   * own signing key per the W7 author check) as its baseline so
   * the next publish operates from a non-conflicting floor.
   *
   * `data` carries `{ cid, fromVersion, toVersion }`:
   *   - `cid`         the bundle CID the publish was attempting
   *   - `fromVersion` the wallet's local version before reconcile
   *   - `toVersion`   the version the wallet adopted (lower; same
   *                   author per XOR-decode authentication)
   *
   * Informational only — the publish path's `pendingPublishCid`
   * marker remains stamped so the next flush / pointer poll
   * re-attempts the publish from the reconciled baseline. The
   * 60s WALKBACK_FLOOR throttle is INTENTIONALLY NOT armed in
   * this case (reconciliation removed the floor; the retry has
   * a fresh chance to land).
   */
  | 'storage:replica-lag-reconciled'
  /**
   * RFC-251 Approach D / issue #255 Problem B — emitted by the
   * lifecycle manager IMMEDIATELY after a pointer commit succeeds at
   * the aggregator. The wiring layer (typically `Sphere`) subscribes
   * to this event and emits an authenticated `pointer-win` broadcast
   * over Nostr so sibling same-identity devices can adopt V=N without
   * waiting for the aggregator's 30-60 s read-replica lag.
   *
   * `data` carries `{ cid, version, attemptsUsed }`. The subscriber
   * MUST build the signed payload via
   * `signWinBroadcastPayload(pointer.getSignerForWinBroadcast().signer, ...)`
   * and publish via the wallet's transport with the
   * `pointer-win:<signingPubKeyHex>` tag.
   *
   * Informational only. No-op when the wiring layer doesn't
   * subscribe — pointer publishes still succeed and siblings still
   * converge via the existing WALKBACK_FLOOR + reconcile path
   * (just slower, ~60-90 s vs ~1 s).
   */
  | 'storage:pointer-published'
  /**
   * Issue #264 — emitted by the flush scheduler when it auto-merges
   * a detected monotonicity gap in place (previously this fired
   * POINTER_MONOTONICITY_VIOLATION on `storage:error` and aborted
   * the flush). Distinct from `storage:error` so operators see
   * auto-merges as routine convergence work, not alarms.
   *
   * `data` payload (see flush-scheduler.ts for the canonical shape):
   *   - `recoveredTokenIds: string[]`   token ids re-merged from
   *     `previousData` to satisfy the token-set invariant.
   *   - `recoveredTokenCount: number`
   *   - `mergedUnknownBundleCids: string[]`   foreign bundle CIDs
   *     inline-fetched and merged into the in-flight UXF package.
   *   - `mergedUnknownBundleCount: number`
   *   - `residualUnknownBundleCids: string[]`   foreign bundle CIDs
   *     that could not be fetched (network down, malformed CAR,
   *     etc.) — the flush continued without them; downstream
   *     convergence retries on the next flush.
   *   - `residualUnknownBundleCount: number`
   *   - `residualTokenMissingIds: string[]`   token ids the token-set
   *     check flagged but `previousData` could not provide (only
   *     possible when `previousData === null`).
   *   - `residualTokenMissingCount: number`
   *   - `recoveredOutboxIdsDroppedAsSent: string[]`   outbox-entry
   *     ids that the SENT-wins dedup removed during the
   *     `OperationalState` union — surfaced for operator audit.
   *   - `recoveredOutboxIdsDroppedAsSentCount: number`
   *   - `truncated: boolean`   true when any of the listed arrays
   *     were capped at 100 entries for log-volume control.
   *
   * Informational only. The flush continues to publish the
   * best-effort superset CAR regardless; residuals are addressed by
   * subsequent cross-device syncs detecting the same gap and
   * re-attempting the inline merge.
   */
  | 'storage:monotonicity-recovered'
  /**
   * Issue #272 — emitted when the per-flush remote-durability
   * HEAD-verify leg (`verifyFlushDurability`), now run as a background
   * task detached from the synchronous flush completion path, fails
   * for a just-pinned bundle CID and/or snapshot CID.
   *
   * Local-durability is unaffected: the bundle CAR pin POST returned
   * 200, the OrbitDB bundle ref is written, and (when wired) the
   * snapshot publish call returned ok. What this event signals is that
   * the operator's IPFS gateway has not yet served the just-pinned
   * CID back via HEAD within the configured deadline (default 30s).
   * This is a gateway propagation property — not a receiver crash-
   * safety property — and does NOT close the at-least-once Nostr ack
   * gate. Distinct from `storage:error` (terminal fatal class).
   *
   * `data` carries `{ cid, snapshotCid?, code?, details? }`:
   *   - `cid`         the bundle CID whose HEAD-verify failed
   *   - `snapshotCid` the snapshot CID (when also verified)
   *   - `code`        the structured error code (e.g.,
   *                   `FLUSH_DURABILITY_TIMEOUT`)
   *   - `details`     the failed-leg detail array from
   *                   `verifyFlushDurability`
   *
   * Operator action: investigate operator Kubo gateway propagation
   * lag if this fires repeatedly for distinct CIDs. Single-shot fires
   * (a CID that eventually does propagate) are expected under normal
   * testnet contention and require no action.
   *
   * Before #272: this same failure threw inline and forced the
   * at-least-once gate's `awaitNextFlush` to reject, causing the
   * Nostr `since` cursor to refuse to advance and the inbound
   * TOKEN_TRANSFER event to replay on every reconnect. Each replay
   * triggered another flush, each flush re-hit the same HEAD-verify
   * timeout, producing a sustained busy-spin (134 replays for 14
   * unique event IDs in the §C.2 soak failure observed at
   * `integration/all-fixes` HEAD `6102d59`).
   */
  | 'storage:durability-deferred'
  /**
   * PR #302 (issue #???): emitted by the pointer-layer lifecycle when
   * Phase 3 walkback skipped past one or more `CAR_TRANSIENT` versions
   * (slot EXISTS on-chain — proof verified + CID decoded — but no IPFS
   * gateway could serve the CAR bytes).
   *
   * Fired on both the recover path (cold-start / periodic poll
   * `recoverLatest()`) and the publish path (conflict-driven rediscovery
   * in `reconcileAndPublish()`). Also fired when ALL known anchor versions
   * are CAR_TRANSIENT and no VALID predecessor was found (the
   * `RecoverAllUnfetchableResult` case).
   *
   * `data` carries:
   *   - `skippedVersions: number[]`   versions walked past
   *   - `recoveredVersion?: number`   the VALID predecessor found
   *                                   (absent when all anchors unfetchable)
   *   - `path: 'recover' | 'publish'` the code path that fired the event
   *
   * Not a fatal alarm (`storage:error`). Operators should investigate
   * IPFS gateway health for the wallet's IPNS CIDs and consider
   * re-pinning the missing CARs from a backup or invoking
   * `acceptCarLoss(version)` to permanently acknowledge the data loss.
   */
  | 'storage:pointer-version-skipped-unfetchable'
  /**
   * Item #157 (OpLog auto-reset) — emitted by the FlushScheduler when an
   * unreachable OpLog head block is detected and the adapter auto-resets
   * the corrupted log to recover writability.
   *
   * `data` carries:
   *   - `lostHeadCid: string | null`     CID captured from the Helia
   *                                       "Failed to load block for <CID>"
   *                                       pattern (null if regex missed).
   *   - `recoveredAt: number`             UNIX ms timestamp.
   *   - `context: string`                 trigger site, e.g.
   *                                       `"flush-scheduler.bundle-write"`.
   *   - `retrySucceeded: boolean`         true when the post-reset retry
   *                                       of the failing write completed.
   *   - `resetFailed?: boolean`           true when `resetCorruptedLog`
   *                                       itself threw — `retrySucceeded`
   *                                       is then `false` and the
   *                                       original write error
   *                                       propagates.
   *
   * Walk-back past `recoveredAt` is permanently impossible. The
   * persistent {@link ProfileRecoveryMarker} (queryable via
   * `ProfileTokenStorageProvider.getRecoveryStatus()`) records this for
   * downstream UI surfaces.
   *
   * Distinct from `storage:error`: a recovered event indicates writes
   * have resumed for the session; an error event indicates a fatal
   * class. UI may surface a persistent "Recovered" badge based on the
   * marker, not on this event alone.
   */
  | 'profile:recovered'
  /**
   * Item #157 (OpLog auto-reset) — emitted IMMEDIATELY BEFORE the
   * adapter's `resetCorruptedLog` call so operators see the trigger
   * even if the reset itself fails (in which case `profile:recovered`
   * fires with `resetFailed: true`).
   *
   * `data` carries `{ lostHeadCid, context }`. Companion to
   * `profile:recovered`; both are emitted on every auto-reset attempt
   * (one before, one after).
   */
  | 'profile:oplog-auto-resetting'
  /**
   * Issue #311 — emitted once during browser profile factory boot to
   * report the outcome of `navigator.storage.persist()`. Operators (and
   * the wallet UI) use this to detect when persistence was DENIED so
   * they can warn the user that the wallet may need to re-sync from
   * remote storage after a browser-driven eviction.
   *
   * `data` carries `{ granted, supported }`:
   *   - `supported: false` — the runtime has no `navigator.storage.persist`
   *     (Node, SSR, legacy Safari, embedded WebViews). `granted` is also
   *     false in this case.
   *   - `supported: true, granted: false` — the platform supports the
   *     API but the request was denied (user policy, permissions
   *     policy, or the promise was rejected).
   *   - `supported: true, granted: true` — the wallet's origin storage
   *     is marked persistent and is NOT eligible for the browser's
   *     opportunistic eviction sweep.
   *
   * Informational only — the wallet continues to operate regardless;
   * `false` simply signals reduced durability guarantees.
   */
  | 'profile:storage-persistence'
  /**
   * Issue #311 — emitted when the Profile read path observed a
   * "Failed to load block for <CID>" signature. This indicates that
   * a block reachable from the live OpLog head (or a referenced
   * snapshot) was evicted from the local Helia blockstore and the
   * read could not be served. The companion `profile:oplog-auto-resetting`
   * event will typically follow on the flush path; this event fires
   * EARLIER and from the read path so operators see the eviction the
   * moment it manifests, not after a write-side trigger.
   *
   * `data` carries `{ cid, key, attemptedAt }`:
   *   - `cid` — the missing block CID extracted from the Helia error
   *     message (matches the `bafy[a-z0-9]+` pattern via
   *     {@link extractLostHeadCid}; null when the error carried no
   *     identifiable CID).
   *   - `key` — the profile key whose read triggered the error (e.g.
   *     `outbox.<addr>.<entryId>`). May be redacted in logs.
   *   - `attemptedAt` — UNIX ms timestamp of the failed read.
   *
   * Dedup: the provider tracks a bounded set of (cid, key) pairs and
   * fires the event at most once per pair per provider instance so a
   * persistent missing block does not spam the event surface on every
   * subsequent read attempt.
   */
  | 'profile:critical-block-evicted'
  /**
   * Issue #311 — emitted when the adapter's best-effort
   * `helia.pins.add(cid)` call fails for a freshly written OpLog
   * entry. Distinct from `storage:error` (terminal): a pin failure is
   * additive — the underlying write still succeeded and the block was
   * stored — but the durability invariant ("every OpLog block reachable
   * from the live head is pinned") was weakened for this one CID.
   * `data` carries `{ cid, errorMessage }`.
   */
  | 'profile:oplog-pin-failed'
  /**
   * Issue #313 — emitted by `LifecycleManager.initialize()` when a
   * valid cached snapshot blob has been read and used to seed the
   * in-memory state. Fires BEFORE OrbitDB connect + bundle-index
   * refresh; UI consumers can render the wallet from cached state
   * immediately (no aggregator / remote IPFS round trips).
   *
   * `data` carries:
   *   - `ageMs: number`           how stale the snapshot is (now - ts)
   *   - `tokenCount: number`      number of tokens reconstituted from snapshot
   *   - `bundleCount: number`     number of bundle CIDs primed
   *   - `pointerVersion?: number` the cached pointer version (if any)
   *
   * Distinct from `storage:loaded` (which fires after a full OpLog walk).
   * When no snapshot is present (fresh wallet, post-clear, or corrupt
   * blob) this event is NOT emitted and boot falls through to the
   * standard OpLog walk path.
   */
  | 'profile:snapshot-loaded'
  /**
   * Issue #313 — emitted after the snapshot blob has been atomically
   * written (after a successful flush, after a background remote sync,
   * or during graceful shutdown). Lets UI surfaces show a
   * "last-saved" indicator without polling storage directly.
   *
   * `data` carries:
   *   - `from?: number`     previous pointer version (if cached)
   *   - `to?: number`       new pointer version (if any)
   *   - `durationMs?: number` wall-clock time spent on sync (for refreshes)
   *   - `trigger: 'flush' | 'shutdown' | 'background-sync'`
   */
  | 'profile:snapshot-refreshed'
  /**
   * Issue #313 — emitted when the cold-boot snapshot read detected a
   * corrupt or schema-incompatible blob and fell through to the OpLog
   * walk path. The corrupt blob has been removed; the wallet still
   * boots normally (degraded performance only). Operator-visible
   * signal that a previous shutdown left a partial-write or the
   * schema version changed (post-upgrade first boot).
   *
   * `data` carries `{ reason: string, walletId?: string }`.
   */
  | 'profile:snapshot-corrupt'
  /**
   * Issue #319 — emitted by the pointer-poll worker when it observed a
   * successful `recoverLatest()` round-trip against the aggregator AND
   * the wallet was in a BLOCKED state with a transient-connectivity
   * reason (`retry_exhausted`, `network_timeout`, `dns_failure`,
   * `tls_failure`). The flag has been cleared automatically; subsequent
   * publish attempts will proceed without the operator having to call
   * `recoverLatest()` from a console.
   *
   * Persistent BLOCKED reasons (`aggregator_rejected`, `protocol_error`,
   * `marker_corrupt`, `rejected`) are NEVER auto-cleared and never
   * trigger this event — those still require an explicit operator
   * decision per SPEC §10.2.4.
   *
   * `data` carries:
   *   - `reason: BlockedReason`   the transient reason that was cleared
   *   - `clearedAt: number`       UNIX ms timestamp
   *
   * Informational only. UIs may use this to dismiss a previously-shown
   * "wallet blocked" banner.
   */
  | 'storage:blocked-auto-cleared';

export interface StorageEvent {
  type: StorageEventType;
  timestamp: number;
  data?: unknown;
  error?: string;
  /**
   * Steelman³⁸ warning: typed error code preserved across the layer
   * boundary so consumers can route on it (e.g., `CID_REF_CORRUPT`,
   * `AGGREGATOR_POINTER_TRUST_BASE_STALE`). Without this, the typed
   * pointer-layer / profile-layer error taxonomy was flattened to a
   * `error: string` at this boundary.
   */
  code?: string;
  /** The original error object for cause-chain debugging. */
  cause?: unknown;
}

export type StorageEventCallback = (event: StorageEvent) => void;

/**
 * Issue #239 — options for `TokenStorageProvider.shutdown` and
 * `Sphere.destroy`. Providers with a remote-durability boundary
 * (Profile/OrbitDB+IPFS) interpret these to gate exit on cross-process
 * recoverability; simpler providers (file/IndexedDB) ignore them.
 */
export interface ShutdownOptions {
  /**
   * Skip the remote-durability verification gate and tear down
   * immediately. The provider stamps a `pendingPublishCid` marker for
   * any unconfirmed publish so the next process boot retries via the
   * cold-start recovery path. Used by E2E tests to simulate ungraceful
   * crash and by operators who need a fast forced exit. Default `false`
   * — production callers MUST omit this so the normal-mode contract
   * applies.
   */
  readonly force?: boolean;
  /**
   * Optional free-form reason recorded in `shutdown:verification-timeout`
   * payloads. Useful for operator triage when the wallet is being
   * destroyed in response to a specific event (sign-out, error, etc.).
   */
  readonly reason?: string;
  /**
   * Override the total verification deadline in ms. Default 30 000.
   * Applies only when `force !== true`.
   */
  readonly verificationDeadlineMs?: number;
}

// =============================================================================
// Token Storage Data Format (TXF)
// =============================================================================

export interface TxfStorageDataBase {
  _meta: TxfMeta;
  _tombstones?: TxfTombstone[];
  _outbox?: TxfOutboxEntry[];
  _sent?: TxfSentEntry[];
  _invalid?: TxfInvalidEntry[];
  _history?: HistoryRecord[];
  /**
   * Audit collection for structurally-valid-but-unspendable tokens
   * (NOT_OUR_CURRENT_STATE / UNSPENDABLE_BY_US dispositions). Each
   * entry is persisted to its own OrbitDB key under the prefix
   * `${addr}.audit.` per PROFILE-ARCHITECTURE.md §10.10. The
   * per-entry-key writer treats `id` as opaque, so T.1.E can widen
   * it to a composite `${tokenId}.${observedTokenContentHash}`
   * without further plumbing.
   */
  _audit?: TxfAuditEntry[];
  /**
   * Finalization queue for pending chain-mode transactions, keyed by
   * `id`. Persisted per UXF-TRANSFER-PROTOCOL §5.5 so a process
   * restart preserves in-flight finalizations.
   */
  _finalizationQueue?: TxfFinalizationQueueEntry[];
  // Dynamic token entries: _<tokenId>
  [key: `_${string}`]: unknown;
}

export interface TxfMeta {
  version: number;
  address: string;
  ipnsName?: string;
  formatVersion: string;
  updatedAt: number;
}

export interface TxfTombstone {
  tokenId: string;
  stateHash: string;
  timestamp: number;
}

export interface TxfOutboxEntry {
  id: string;
  status: string;
  tokenId: string;
  recipient: string;
  createdAt: number;
  data: unknown;
}

export interface TxfSentEntry {
  tokenId: string;
  recipient: string;
  txHash: string;
  sentAt: number;
}

export interface TxfInvalidEntry {
  tokenId: string;
  reason: string;
  detectedAt: number;
}

/**
 * Audit collection entry — a structurally valid token that the local
 * wallet cannot currently spend (NOT_OUR_CURRENT_STATE /
 * UNSPENDABLE_BY_US dispositions). Persisted under
 * `${addr}.audit.${id}` keys via the per-entry-key writer.
 *
 * `id` is the primary key for the per-entry-key layout. It MUST be
 * unique within the collection. T.1.E will populate it with the
 * composite `${tokenId}.${observedTokenContentHash}` shape declared
 * in PROFILE-ARCHITECTURE.md §10.10; this base interface keeps the
 * field opaque so writers/readers do not need to be updated when the
 * composite form lands.
 */
export interface TxfAuditEntry {
  /** Opaque primary key. T.1.E uses `${tokenId}.${observedTokenContentHash}`. */
  id: string;
  tokenId: string;
  /** Disposition tag — e.g. 'NOT_OUR_CURRENT_STATE', 'UNSPENDABLE_BY_US'. */
  disposition: string;
  detectedAt: number;
  /** Optional content hash recorded at detection time. */
  observedTokenContentHash?: string;
  /** Optional human-readable note from the validator. */
  note?: string;
}

/**
 * Finalization queue entry — a pending chain-mode finalization that
 * survives process restarts per UXF-TRANSFER-PROTOCOL §5.5.
 * Persisted under `${addr}.finalizationQueue.${id}` keys.
 *
 * `id` is the request id (e.g. transfer/request id) and is the
 * primary key for the per-entry-key layout.
 */
export interface TxfFinalizationQueueEntry {
  /** Opaque request id. */
  id: string;
  /** Lifecycle status of the finalization request. */
  status: string;
  enqueuedAt: number;
  /** Caller-supplied payload — kept opaque at the storage layer. */
  payload?: unknown;
}

// =============================================================================
// Provider Factory Type
// =============================================================================

export type StorageProviderFactory<TConfig, TProvider extends StorageProvider> = (
  config?: TConfig
) => TProvider;

export type TokenStorageProviderFactory<
  TConfig,
  TData,
  TProvider extends TokenStorageProvider<TData>
> = (config: TConfig) => TProvider;
