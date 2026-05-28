/**
 * ProfileTokenStorageProvider
 *
 * Implements `TokenStorageProvider<TxfStorageDataBase>` using the UXF
 * multi-bundle model with OrbitDB as the source of truth and IPFS for
 * content-addressed CAR file storage.
 *
 * This is the bridge between:
 * - **TxfStorageDataBase** (what PaymentsModule reads/writes)
 * - **UXF bundles** (unencrypted CAR files pinned to IPFS, referenced via OrbitDB)
 *
 * CAR payloads are stored unencrypted so that identical token pools produced
 * by different wallets hash to the same CID (cross-user content-addressed
 * dedup). Confidentiality is provided by the OrbitDB KV layer, which encrypts
 * bundle refs and operational state with a per-wallet key.
 *
 * Write-behind buffer: `save()` accepts data immediately and debounces IPFS
 * pin + OrbitDB writes (2 seconds by default). Multiple rapid `save()` calls
 * coalesce into a single flush.
 *
 * Multi-bundle merge on load: all active `tokens.bundle.*` keys from OrbitDB
 * are fetched, deserialized from CAR, and merged into a single UxfPackage
 * before reassembling into TxfStorageDataBase format.
 *
 * **Internal architecture (Phase 8 facade refactor):** the implementation is
 * split into four sub-modules under `profile/profile-token-storage/`:
 *   - `LifecycleManager` — connect / disconnect / initialize / shutdown,
 *     plus cold-start recovery (aggregator pointer + IPNS migration).
 *   - `FlushScheduler` — debounced write-behind buffer + IPFS publish.
 *   - `BundleIndex` — `listBundles`, `addBundle`, `shouldConsolidate`,
 *     `refreshKnownBundles` over the `tokens.bundle.*` namespace.
 *   - `HistoryStore` — the five `*HistoryEntry` / `*History` methods.
 *
 * The class below is a **thin facade** that owns the shared state, holds
 * one instance of each sub-module, and delegates each public method to
 * the appropriate sub-module. The public API (and private field names
 * tests reach into via `as any`, e.g. `initialized`, `encryptionKey`,
 * `_ipfsGateways`) is byte-identical to the pre-refactor version.
 *
 * @see PROFILE-ARCHITECTURE.md Section 2.3 (Multi-Bundle Model)
 * @see PROFILE-ARCHITECTURE.md Section 5.3 (Token Storage Flow)
 * @module profile/profile-token-storage-provider
 */

import { logger } from '../core/logger.js';
import { SphereError } from '../core/errors.js';
import { STORAGE_KEYS_GLOBAL } from '../constants.js';
import type { ProviderStatus, FullIdentity } from '../types/index.js';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  TxfMeta,
  TxfTombstone,
  TxfOutboxEntry,
  TxfSentEntry,
  TxfInvalidEntry,
  TxfAuditEntry,
  TxfFinalizationQueueEntry,
  SaveResult,
  LoadResult,
  SyncResult,
  ShutdownOptions,
  StorageEventCallback,
  StorageEvent,
  HistoryRecord,
  StorageProvider,
} from '../storage/storage-provider.js';
import {
  type ProfileRecoveryMarker,
  type ProfileSnapshotPublishResult,
  type ProfileTokenStorageProviderOptions,
} from './types.js';
import type { ProfileDatabase } from './orbitdb-adapter.js';
import {
  isTokenKey,
  isArchivedKey,
  isForkedKey,
} from '../types/txf.js';
import { buildLocalEntry } from './oplog-entry.js';
import type { OpLogEntryEnvelope } from './oplog-entry.js';
import { deriveOriginForType } from './aggregator-pointer/originated-tag.js';
import {
  encryptProfileValue,
  decryptProfileValue,
} from './encryption.js';
import { fetchCarFromIpfs } from './ipfs-client.js';
import {
  deriveSentFromArchived,
  deriveHistoryFromArchived,
  deriveTombstonesFromArchived,
} from './deriver.js';
import {
  deriveStructuralManifest,
  type TokenManifest,
} from './token-manifest.js';
import {
  BundleIndex,
  BUNDLE_KEY_PREFIX,
  FlushScheduler,
  HistoryStore,
  LifecycleManager,
  type OperationalState,
  type ProfileTokenStorageHost,
} from './profile-token-storage/index.js';
import {
  readSnapshot,
  writeSnapshot,
  clearSnapshot,
  type ProfileSnapshotPointer,
  type SnapshotReadResult,
} from './profile-snapshot-cache.js';

// =============================================================================
// Constants
// =============================================================================

/** Default write-behind debounce interval in milliseconds. */
const DEFAULT_FLUSH_DEBOUNCE_MS = 2000;

// =============================================================================
// ProfileTokenStorageProvider
// =============================================================================

export class ProfileTokenStorageProvider
  implements TokenStorageProvider<TxfStorageDataBase>
{
  // --- BaseProvider metadata ---
  readonly id = 'profile-token';
  readonly name = 'Profile Token Storage';
  readonly type = 'p2p' as const;

  // --- State ---
  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;
  private encryptionKey: Uint8Array | null = null;
  private initialized = false;
  private isShuttingDown = false;

  // --- Write-behind buffer ---
  private pendingData: TxfStorageDataBase | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly flushDebounceMs: number;

  // --- Item #15 Phase C.2 — dirty-signal debounce ---
  /**
   * Debounce timer armed by `notifyProfileDirty()`. Separate from
   * `flushTimer` because the lean-snapshot publish path is independent
   * of the token-bundle pin path (each can fire without the other).
   * Phase E will collapse the two when the bundle-only publish is
   * removed.
   */
  private dirtyFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * In-flight dirty-flush promise. Held to serialize concurrent
   * dispatches (a second notifyProfileDirty() that arrives mid-flush
   * gets coalesced into the next debounce window).
   */
  private dirtyFlushPromise: Promise<void> | null = null;
  /**
   * Latch — set when `notifyProfileDirty()` is called during an
   * in-flight flush. Re-arms the debounce after the current flush
   * settles so we don't lose the signal.
   */
  private dirtyFlushPending = false;
  /**
   * Sticky latch — true once {@link shutdown} has completed at least
   * once. Distinct from `isShuttingDown` (which is reset to `false`
   * at the end of shutdown so re-arming-shutdown-on-restart works)
   * and from `status === 'disconnected'` (which is also the
   * pre-connect default). Used by `notifyProfileDirty` to ignore
   * late-arriving signals from writers that outlive the provider.
   */
  private hasShutdown = false;
  private readonly dirtyFlushDebounceMs: number;

  // --- Cold-start sync dedup (steelman) ---
  // When two sync() calls race during cold-start, both observe
  // `lastLoadedData === null && knownBundleCids.size > 0` and both fall
  // through to load(). load() is idempotent for a single CAR but not
  // for the surrounding event emissions (sync:completed fires twice;
  // history-import counts may double-count). Dedupe by latching the
  // first cold-start sync's promise and have parallel callers await
  // the same result.
  private coldStartSyncPromise: Promise<SyncResult<TxfStorageDataBase>> | null = null;

  // --- Event system ---
  private readonly eventCallbacks: Set<StorageEventCallback> = new Set();

  // --- Bundle tracking (local cache of known bundles) ---
  private knownBundleCids: Set<string> = new Set();

  // --- Replication listener cleanup ---
  private replicationUnsub: (() => void) | null = null;

  // --- Last loaded data (for sync diffing) ---
  private lastLoadedData: TxfStorageDataBase | null = null;

  // --- Last derived structural token manifest ---
  // Structural-only: status ∈ {valid, conflicting}. Oracle enrichment
  // (pending, invalid, spent) is a future layer. See
  // profile/token-manifest.ts.
  private lastTokenManifest: TokenManifest | null = null;

  // --- Computed short address ID ---
  private addressId: string | null = null;

  // --- Last pinned CID for flush retry (Fix 8) ---
  private lastPinnedCid: string | null = null;

  /**
   * Issue #239 — most-recent UXF bundle CID successfully pinned + written
   * to OrbitDB. Survives across flushes (unlike `lastPinnedCid`, the
   * pin-retry cache) so `LifecycleManager.shutdown()` can HEAD-verify
   * the bundle CAR is served by ≥1 IPFS gateway before exiting.
   * Null until the first successful flush.
   */
  private lastPinnedBundleCid: string | null = null;

  /**
   * Issue #239 — verified-watermark CIDs. Set by
   * `verifyFlushDurability` after each successful per-flush
   * verification. Shutdown gate consults these to skip its own
   * verification when the just-flushed CIDs are already verified
   * (eliminates ~15-30s of redundant HEAD + aggregator round-trips
   * per destroy() in the common case where every save was per-flush
   * verified). Null until the first successful verification.
   */
  private lastVerifiedBundleCid: string | null = null;
  private lastVerifiedSnapshotCid: string | null = null;

  // --- Last CID observed via aggregator pointer (Fix 2 of cross-device sync) ---
  // Set by LifecycleManager on cold-start recoverLatest and on every
  // periodic poll iteration that returns a CID. Read by FlushScheduler
  // to short-circuit gratuitous re-publishes when the merged-state CAR
  // already matches the authoritative pointer (e.g., remote originator
  // already anchored the state we just merged from their bundle).
  private lastDiscoveredPointerCid: string | null = null;

  /**
   * CID whose CAR is durably pinned + OrbitDB bundle ref written but
   * whose aggregator pointer publish is outstanding due to a transient
   * failure. The next `flushToIpfs` and the periodic pointer poll
   * retry the publish at start.
   *
   * Issue #241: while non-null, `awaitNextFlush` (and therefore the
   * at-least-once Nostr gate) NO LONGER rejects on transient publish
   * failure — pin durability is the cross-device recoverability
   * invariant, and the aggregator publish is a liveness optimization
   * for cold-import discovery. A `storage:pending-publish` event is
   * emitted so operators can monitor the outstanding state without
   * conflating it with the terminal `storage:error` class.
   *
   * Persisted to `localCache` under
   * `<STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID>_<addressId>`
   * so a process restart resumes the retry. Loaded lazily on
   * `initialize()`; written via `setPendingPublishCidPersisted`.
   */
  private pendingPublishCid: string | null = null;

  // --- Bundle CIDs merged into lastLoadedData (pointer monotonicity) ---
  // Snapshot of the active OrbitDB bundle index at the moment load()
  // produced lastLoadedData. Used by FlushScheduler's runtime monotonicity
  // assertion: if a flush would publish a pointer V_n while OrbitDB has
  // bundles NOT in this set, the flush's source state is stale and
  // would silently drop tokens from V_n's CAR. The assertion fires
  // before pin + publish.
  //
  // Null when no successful load() has run yet (no V_n-1 baseline → the
  // assertion has nothing to compare against and trivially passes).
  private lastLoadedFromBundleCids: Set<string> | null = null;

  // --- Config storage for createForAddress ---
  private readonly _db: ProfileDatabase;
  private readonly _encryptionKeyRaw: Uint8Array | null;
  private readonly _ipfsGateways: string[];
  private readonly _options: ProfileTokenStorageProviderOptions | undefined;

  // --- Local-only derived cache (per-device, never replicated) ---
  // Holds tombstones, sent, history. See profile/deriver.ts and
  // PROFILE-ARCHITECTURE.md Q1 decision (Section 10).
  private readonly localCache: StorageProvider | null;

  // --- Deduplication guard for concurrent rebuild attempts ---
  // When two load() calls both see an empty cache and both invoke
  // rebuildDerivedCache(), the second awaits the first's Promise
  // rather than starting a parallel rebuild that could interleave
  // writes. See rebuildDerivedCache().
  private rebuildPromise: Promise<{
    tombstones: TxfTombstone[];
    sent: TxfSentEntry[];
    history: HistoryRecord[];
  }> | null = null;

  // --- One-time legacy-key cleanup flag ---
  // After a successful atomic `deriver.{addr}.all` write, we best-effort
  // delete the three legacy per-key entries so future reads cannot be
  // confused by stale data on cache-key downgrade. Guard with a flag
  // so we don't attempt the delete on every save.
  private legacyKeysCleaned = false;

  // --- Sub-modules (Phase 8 facade refactor) ---
  private readonly bundleIndex: BundleIndex;
  private readonly historyStore: HistoryStore;
  private readonly lifecycleManager: LifecycleManager;
  private readonly flushScheduler: FlushScheduler;

  constructor(
    private readonly db: ProfileDatabase,
    encryptionKey: Uint8Array | null,
    ipfsGateways: string[],
    private readonly options?: ProfileTokenStorageProviderOptions,
    localCache?: StorageProvider | null,
  ) {
    this._db = db;
    this._encryptionKeyRaw = encryptionKey;
    this._ipfsGateways = ipfsGateways;
    this._options = options;
    this.localCache = localCache ?? null;
    this.flushDebounceMs =
      options?.flushDebounceMs ?? options?.config?.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
    // Item #15 Phase C.2 — dirty-signal debounce. Default matches the
    // bundle-flush debounce; tunable via options for tests.
    this.dirtyFlushDebounceMs =
      options?.dirtyFlushDebounceMs ?? this.flushDebounceMs;

    if (encryptionKey) {
      this.encryptionKey = encryptionKey;
    }

    // Wire sub-modules. The host adapter exposes the facade's mutable
    // state through getter/setter methods so each seam can read /
    // write the source of truth without an `as any` escape hatch.
    const host = this.makeHost();
    this.bundleIndex = new BundleIndex(host);
    this.historyStore = new HistoryStore(host);
    this.lifecycleManager = new LifecycleManager(host, this.bundleIndex);
    this.flushScheduler = new FlushScheduler(host, this.bundleIndex);
  }

  // ---------------------------------------------------------------------------
  // Host adapter — exposes facade-private state to the sub-modules.
  //
  // Every getter/setter mutates a field on `this` so the facade remains
  // the single source of truth. Tests reach into `(provider as any).
  // initialized` / `(provider as any).encryptionKey` directly; those
  // field names live here unchanged.
  // ---------------------------------------------------------------------------

  private makeHost(): ProfileTokenStorageHost {
    // Arrow functions capture the enclosing `this`, so all delegations
    // route back to the facade without a `bind()` per call.  The
    // `readonly` slots on the interface are immutable-by-construction
    // (db / ipfsGateways / options / localCache / flushDebounceMs /
    // eventCallbacks never change after construction), so we read them
    // once here and snapshot — no need for live getters.
    return {
      db: this.db,
      ipfsGateways: this._ipfsGateways,
      options: this.options,
      localCache: this.localCache,
      flushDebounceMs: this.flushDebounceMs,
      eventCallbacks: this.eventCallbacks,
      // Issue #236 — local Helia accessor, resolved lazily on each call
      // so connect()/close() lifecycle transitions are observed by the
      // next pin/fetch operation. Returns `null` for adapters predating
      // issue #236 (no getHelia method on ProfileDatabase).
      getHelia: () => this.db.getHelia?.() ?? null,
      // Lifecycle state
      getStatus: () => this.status,
      setStatus: (s) => {
        this.status = s;
      },
      getInitialized: () => this.initialized,
      setInitialized: (b) => {
        this.initialized = b;
      },
      getIsShuttingDown: () => this.isShuttingDown,
      setIsShuttingDown: (b) => {
        this.isShuttingDown = b;
      },
      getIdentity: () => this.identity,
      setIdentityState: (id) => {
        this.identity = id;
      },
      getEncryptionKey: () => this.encryptionKey,
      setEncryptionKey: (k) => {
        this.encryptionKey = k;
      },
      getComputedAddressId: () => this.addressId,
      setComputedAddressId: (id) => {
        this.addressId = id;
      },
      getReplicationUnsub: () => this.replicationUnsub,
      setReplicationUnsub: (fn) => {
        this.replicationUnsub = fn;
      },
      // Flush state
      getPendingData: () => this.pendingData,
      setPendingData: (d) => {
        this.pendingData = d;
      },
      getFlushTimer: () => this.flushTimer,
      setFlushTimer: (t) => {
        this.flushTimer = t;
      },
      getFlushPromise: () => this.flushPromise,
      setFlushPromise: (p) => {
        this.flushPromise = p;
      },
      getLastPinnedCid: () => this.lastPinnedCid,
      setLastPinnedCid: (c) => {
        this.lastPinnedCid = c;
      },
      getLastPinnedBundleCid: () => this.lastPinnedBundleCid,
      setLastPinnedBundleCid: (c) => {
        this.lastPinnedBundleCid = c;
      },
      getLastVerifiedBundleCid: () => this.lastVerifiedBundleCid,
      setLastVerifiedBundleCid: (c) => {
        this.lastVerifiedBundleCid = c;
      },
      getLastVerifiedSnapshotCid: () => this.lastVerifiedSnapshotCid,
      setLastVerifiedSnapshotCid: (c) => {
        this.lastVerifiedSnapshotCid = c;
      },
      getLastDiscoveredPointerCid: () => this.lastDiscoveredPointerCid,
      setLastDiscoveredPointerCid: (c) => {
        this.lastDiscoveredPointerCid = c;
      },
      getPendingPublishCid: () => this.pendingPublishCid,
      setPendingPublishCid: (c) => {
        this.pendingPublishCid = c;
        // Fire-and-forget persistence — failures are logged but don't
        // block the caller. On crash, an unwritten retry marker means
        // the next process boot won't re-attempt; this is acceptable
        // because a subsequent save-driven flush still re-derives the
        // need to publish (lastDiscoveredPointerCid stays stale).
        this.persistPendingPublishCid(c).catch((err) => {
          this.log(
            `persistPendingPublishCid failed (best-effort): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      },
      // Bundle index state
      getKnownBundleCids: () => this.knownBundleCids,
      setKnownBundleCids: (s) => {
        this.knownBundleCids = s;
      },
      // Last-loaded snapshot
      getLastLoadedData: () => this.lastLoadedData,
      setLastLoadedData: (d) => {
        this.lastLoadedData = d;
      },
      getLastLoadedFromBundleCids: () => this.lastLoadedFromBundleCids,
      setLastLoadedFromBundleCids: (s) => {
        this.lastLoadedFromBundleCids = s;
      },
      getLastTokenManifest: () => this.lastTokenManifest,
      setLastTokenManifest: (m) => {
        this.lastTokenManifest = m;
      },
      // Address-scoped key prefix
      getAddressId: () => this.getAddressId(),
      // Logging / events
      log: (msg) => this.log(msg),
      emitEvent: (e) => this.emitEvent(e),
      buildErrorEvent: (type, err, code) => this.buildErrorEvent(type, err, code),
      // OrbitDB key helpers
      writeProfileKey: (key, value) => this.writeProfileKey(key, value),
      readProfileKey: (key) => this.readProfileKey(key),
      readProfileKeyJson: (key) => this.readProfileKeyJson(key),
      // Profile recovery marker (OpLog auto-reset — Item #157)
      writeRecoveryMarker: (marker) => this.writeRecoveryMarker(marker),
      readRecoveryMarker: () => this.readRecoveryMarker(),
      // Flush coordination
      flushToIpfs: () => this.flushScheduler.flushToIpfs(),
      refreshBaselineForMonotonicity: () => this.refreshBaselineForMonotonicity(),
      // TXF adapter helpers
      extractTokensFromTxfData: (data) => this.extractTokensFromTxfData(data),
      extractOperationalState: (data) => this.extractOperationalState(data),
      // Operational state persistence
      writeOrbitOperationalState: (opState) => this.writeOrbitOperationalState(opState),
      writeLocalDerivedCache: (opState) => this.writeLocalDerivedCache(opState),
      // Item #15 Phase C — dirty-signal entry point. The bundle index and
      // (future) lean-snapshot debounce wiring call this on any local
      // mutation. Today the implementation is a no-op stub: Phase C.2
      // wires a debounced FlushScheduler trigger here behind the
      // `features.fullProfileSnapshotSync` flag.
      notifyProfileDirty: () => this.notifyProfileDirty(),
      // Item #15 Phase D.1b — synchronous lean-snapshot publish for
      // FlushScheduler. Returns `null` when no `onProfileDirtyFlush`
      // callback is wired (legacy tests fall back to the bundle-CID
      // publish). Coordinates with the dirty-flush debouncer so we
      // don't double-publish.
      publishSnapshotIfWired: () => this.publishSnapshotIfWired(),
      // Item #15 Phase E follow-up — pull-side counterpart for the
      // periodic-poll and cold-start recovery paths in
      // LifecycleManager. Returns null when no factory closure is wired
      // (legacy tests); else fetches the CAR, parses as lean snapshot,
      // and dispatches per-writer JOIN through the host's applier.
      applySnapshotIfWired: (cid) => this.applySnapshotIfWired(cid),
      // Issue #239 — per-flush remote-durability verification entry
      // point for FlushScheduler. Delegates to LifecycleManager which
      // runs HEAD-verify + aggregator read-back legs in parallel and
      // throws on deadline. See ProfileTokenStorageHost.verifyFlushDurability.
      verifyFlushDurability: (bundleCid, snapshotCid, deadlineMs) =>
        this.verifyFlushDurability(bundleCid, snapshotCid, deadlineMs),
      // Issue #313 — lazy-load snapshot cache. Write hooks fire after
      // flush completion and on shutdown; read hook runs at the head of
      // LifecycleManager.initialize() to seed the in-memory state before
      // any OrbitDB / aggregator round-trip.
      writeLocalSnapshot: (trigger, options) =>
        this.writeLocalSnapshot(trigger, options),
      readLocalSnapshot: () => this.readLocalSnapshot(),
    };
  }

  /**
   * Item #15 Phase C — central handler for "some profile state changed"
   * signals from per-writer mutations and JOIN-applied remote changes.
   *
   * Arms (or re-arms) a debounce timer. When the timer fires, the
   * host-injected `onProfileDirtyFlush` callback runs. Sphere wires
   * that callback to build a lean profile snapshot, pin it to IPFS,
   * and publish the CID via the aggregator pointer layer.
   *
   * Coalescing semantics:
   *   - Multiple notifyProfileDirty() calls within `dirtyFlushDebounceMs`
   *     coalesce into a single fire (last-one-wins on the timer reset).
   *   - A signal that arrives DURING an in-flight flush sets
   *     `dirtyFlushPending = true`. When the flush settles, the next
   *     debounce window is armed automatically so we don't lose the
   *     signal.
   *   - When `onProfileDirtyFlush` is absent (default during Phase C
   *     rollout), the timer still arms but the fire body is a no-op
   *     beyond the latch handling. This lets tests assert the wiring
   *     end-to-end without needing the full Sphere closure.
   *
   * Cancelled on shutdown — see {@link cancelDirtyFlushTimer} (invoked
   * by the lifecycle manager's shutdown path).
   *
   * Wired into:
   *   - BundleIndex.addBundle / joinSnapshot (this provider's bundle ref)
   *   - OutboxWriter / SentLedgerWriter / PrefixSyncWriter (via their own
   *     notifyProfileDirty callbacks plumbed by ProfileStorageProvider)
   *   - OrbitDb{Finalization,RecipientContext}StorageAdapter writeKey /
   *     deleteKey paths
   *
   * Public so the factory's bridge from
   * `ProfileStorageProvider.setProfileDirtyNotifier` can delegate
   * here. The host's `notifyProfileDirty` (used by internal sub-modules
   * like BundleIndex) routes through the same body via the host
   * interface.
   */
  notifyProfileDirty(): void {
    if (this.isShuttingDown || this.hasShutdown) return;

    // If a flush is in flight, record that another arrived and let
    // the in-flight one settle. The post-flush hook re-arms the timer.
    if (this.dirtyFlushPromise !== null) {
      this.dirtyFlushPending = true;
      return;
    }

    // Clear any existing timer — this is a debounce reset.
    if (this.dirtyFlushTimer !== null) {
      clearTimeout(this.dirtyFlushTimer);
    }

    this.dirtyFlushTimer = setTimeout(() => {
      this.dirtyFlushTimer = null;
      this.dispatchDirtyFlush();
    }, this.dirtyFlushDebounceMs);
  }

  /**
   * Item #15 Phase C.2 — invoke the host-injected
   * `onProfileDirtyFlush` callback (if wired). Errors are caught and
   * surfaced via `storage:error` with a typed code; they never
   * propagate into the caller's path because the dirty signal is
   * best-effort by design.
   *
   * If another `notifyProfileDirty()` arrived while this flush was
   * running, re-arm the debounce so the next signal isn't lost.
   */
  private dispatchDirtyFlush(): void {
    if (this.isShuttingDown) return;
    const callback = this.options?.onProfileDirtyFlush;
    if (typeof callback !== 'function') {
      // No-op fire path. This is the default during Phase C rollout —
      // Phase D wires the actual lean-snapshot build + publish.
      this.consumePendingDirtyFlag();
      return;
    }

    const flush = (async () => {
      try {
        await callback();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`onProfileDirtyFlush failed: ${msg}`);
        this.emitEvent(
          this.buildErrorEvent(
            'storage:error',
            err,
            'PROFILE_DIRTY_FLUSH_FAILED',
          ),
        );
      }
    })().finally(() => {
      // Identity-check — only clear if we are the most recent flush.
      // A concurrent flush dispatched mid-await would have replaced
      // `dirtyFlushPromise`; clearing wholesale would clobber it.
      if (this.dirtyFlushPromise === flush) {
        this.dirtyFlushPromise = null;
      }
      this.consumePendingDirtyFlag();
    });
    this.dirtyFlushPromise = flush;
  }

  /**
   * Item #15 Phase C.2 — if a notifyProfileDirty() call arrived
   * during the just-completed flush, re-arm the debounce so we don't
   * lose the signal. Called from the dispatch path's `.finally`.
   */
  private consumePendingDirtyFlag(): void {
    if (!this.dirtyFlushPending) return;
    this.dirtyFlushPending = false;
    // Re-arm — guarded against shutdown.
    if (this.isShuttingDown) return;
    this.notifyProfileDirty();
  }

  /**
   * Cancel any armed dirty-flush debounce timer. Called by the
   * lifecycle manager during shutdown to prevent late-firing
   * callbacks after the provider has been torn down.
   *
   * Does NOT abort an in-flight `dirtyFlushPromise` — the lifecycle
   * manager awaits that separately via the host.
   */
  cancelDirtyFlushTimer(): void {
    if (this.dirtyFlushTimer !== null) {
      clearTimeout(this.dirtyFlushTimer);
      this.dirtyFlushTimer = null;
    }
    // Clear any pending latch — the shutdown path won't re-arm.
    this.dirtyFlushPending = false;
  }

  /**
   * Item #15 Phase C.2 — await the most recent dirty-flush dispatch
   * if one is in flight. Returns immediately when no flush is active.
   * Used by `shutdown()` and tests.
   */
  awaitDirtyFlushSettled(): Promise<void> {
    return this.dirtyFlushPromise ?? Promise.resolve();
  }

  /**
   * Item #15 Phase D.1b — synchronously invoke the wired
   * `onProfileDirtyFlush` callback (lean-snapshot build + pin +
   * publish) for the FlushScheduler. Replaces the legacy bundle-CID
   * publish at the end of `flushToIpfs()` when a snapshot publisher
   * is wired.
   *
   * Semantics:
   *   - Returns `null` when no `onProfileDirtyFlush` callback is
   *     configured (legacy tests / providers without the Phase C.3
   *     closure). Caller (FlushScheduler) falls back to legacy
   *     bundle-CID publish via `LifecycleManager.publishAggregator
   *     PointerBestEffort()`.
   *   - Cancels any armed dirty-flush debounce timer so the
   *     debouncer doesn't separately fire a redundant publish for
   *     the same writer-side mutations that triggered this flush.
   *   - Awaits any in-flight `dirtyFlushPromise` so concurrent
   *     dispatches serialize. The `dirtyFlushPending` latch is
   *     cleared after our run so a follow-up `notifyProfileDirty()`
   *     (arriving during this synchronous fire) re-arms cleanly.
   *   - Tracks our own run as `dirtyFlushPromise` so a concurrent
   *     `notifyProfileDirty()` observes us as in-flight and latches
   *     `dirtyFlushPending` instead of starting a parallel fire.
   *   - On success: returns the publisher's structured
   *     `ProfileSnapshotPublishResult`. A `void` return from the
   *     callback (legacy `() => Promise<void>` shape) is normalised
   *     to `{ ok: true, transient: false }`.
   *   - On throw (programmer error, snapshot-build failure, etc.):
   *     emits `storage:error` with code `PROFILE_DIRTY_FLUSH_FAILED`
   *     (matching the debouncer's surfacing contract) and re-throws
   *     so FlushScheduler can propagate to `forceFlushSerialized`'s
   *     rejection arm. Issue #241: transient publish failures
   *     (e.g., aggregator replica lag) are NOT surfaced as throws —
   *     `publishAggregatorPointerBestEffort` returns a structured
   *     `{ ok: false, transient: true }` result. FlushScheduler emits
   *     `storage:pending-publish` and lets the flush succeed. Only
   *     non-publish exceptions (e.g., snapshot construction errors)
   *     reach this catch arm.
   *
   * The shutdown gate (`isShuttingDown` / `hasShutdown`) returns
   * `null` so a flush mid-shutdown skips the snapshot publish
   * entirely (the lifecycle's shutdown sequence drains the existing
   * dirty-flush promise separately).
   */
  async publishSnapshotIfWired(): Promise<ProfileSnapshotPublishResult | null> {
    if (this.isShuttingDown || this.hasShutdown) return null;
    const callback = this.options?.onProfileDirtyFlush;
    if (typeof callback !== 'function') return null;

    // Cancel any armed debounce — we're firing now, so the debouncer's
    // follow-up fire would be redundant for the same writer mutations.
    if (this.dirtyFlushTimer !== null) {
      clearTimeout(this.dirtyFlushTimer);
      this.dirtyFlushTimer = null;
    }

    // Drain any in-flight dispatch so we serialize. Bounded by one
    // hop — the in-flight callback either settles or throws; we
    // observe whichever and proceed.
    if (this.dirtyFlushPromise !== null) {
      try {
        await this.dirtyFlushPromise;
      } catch {
        // Prior dispatch surfaced its error via storage:error in its
        // own catch arm; we don't propagate it here.
      }
    }

    // Clear the pending latch — our synchronous fire covers any
    // signal that arrived before this call. A signal arriving DURING
    // our fire will re-set the latch via notifyProfileDirty()'s
    // `if (dirtyFlushPromise !== null)` branch (because we publish
    // our own tracked promise below).
    this.dirtyFlushPending = false;

    const flushBody = (async () => {
      const result = await callback();
      return result ?? ({ ok: true, transient: false } as const);
    })();

    // Track our run so a concurrent `notifyProfileDirty()` observes
    // us as in-flight and latches `dirtyFlushPending` rather than
    // starting a parallel fire.
    const tracked: Promise<void> = flushBody.then(
      () => undefined,
      () => undefined,
    );
    this.dirtyFlushPromise = tracked;

    try {
      return await flushBody;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`publishSnapshotIfWired (synchronous fire) failed: ${msg}`);
      this.emitEvent(
        this.buildErrorEvent(
          'storage:error',
          err,
          'PROFILE_DIRTY_FLUSH_FAILED',
        ),
      );
      throw err;
    } finally {
      // Identity-check so a follow-up `notifyProfileDirty()` that
      // replaced our tracked promise (extremely unlikely under
      // serialization, but defensive) is not clobbered.
      if (this.dirtyFlushPromise === tracked) {
        this.dirtyFlushPromise = null;
      }
      // If a notification arrived during our fire, re-arm the debounce
      // so the next signal isn't lost. Mirrors `consumePendingDirtyFlag`.
      if (this.dirtyFlushPending && !this.isShuttingDown && !this.hasShutdown) {
        this.dirtyFlushPending = false;
        this.notifyProfileDirty();
      }
    }
  }

  /**
   * Item #15 Phase E follow-up — late-bound pull-side snapshot applier.
   * Falls back to `options.onApplySnapshot` (construction-time) if
   * never set; otherwise the most recent registration wins. Set by
   * the factory after `tokenStorage` has been constructed so the
   * closure can reference `tokenStorage.getBundleIndex()` (which would
   * otherwise be a forward reference at construction time).
   */
  private applySnapshotCallback:
    | ((cidString: string)
        => Promise<import('./profile-snapshot-dispatcher.js').ApplySnapshotResult>)
    | null = null;

  /**
   * Item #15 Phase E follow-up — install / replace the pull-side
   * snapshot applier. Idempotent: callers MAY re-register; pass `null`
   * to disable.
   *
   * Used by `profile/factory.ts:createProfileProviders` to install the
   * closure that backs `applySnapshotIfWired()` — the closure
   * references `tokenStorage.getBundleIndex()` so it must be set AFTER
   * the provider is constructed (forward-reference at construction
   * time).
   */
  setApplySnapshotCallback(
    callback:
      | ((cidString: string)
          => Promise<import('./profile-snapshot-dispatcher.js').ApplySnapshotResult>)
      | null,
  ): void {
    this.applySnapshotCallback = callback;
  }

  /**
   * Item #15 Phase E follow-up — pull-side counterpart to
   * {@link publishSnapshotIfWired}. Invokes the host-injected applier
   * (if wired) for the given snapshot CID.
   *
   * Returns `null` when no factory closure is wired (legacy tests /
   * providers without the Phase E follow-up factory closure). On a
   * wired path the callback fetches the CAR, parses it as a lean
   * snapshot, and dispatches per-writer JOIN through the same
   * `runProfileSnapshotApply` closure that backs the pointer-wiring
   * layer's reconcile path. Errors propagate to the caller so the
   * periodic-poll / recovery wrapper can log + skip the re-arm.
   *
   * The shutdown gate returns `null` so a poll iteration mid-shutdown
   * skips the apply entirely. The lifecycle's shutdown sequence runs
   * its own teardown ordering; this method only declines to do new
   * work after the gate has closed.
   */
  async applySnapshotIfWired(
    cidString: string,
  ): Promise<import('./profile-snapshot-dispatcher.js').ApplySnapshotResult | null> {
    if (this.isShuttingDown || this.hasShutdown) return null;
    // Late-bound setter wins; falls back to construction-time option
    // for callers that prefer the static-config style.
    const callback =
      this.applySnapshotCallback ?? this.options?.onApplySnapshot ?? null;
    if (typeof callback !== 'function') return null;
    return callback(cidString);
  }

  // ---------------------------------------------------------------------------
  // BaseProvider
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.initialize();
  }

  async disconnect(): Promise<void> {
    await this.shutdown();
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  setIdentity(identity: FullIdentity): void {
    this.lifecycleManager.setIdentity(identity);
  }

  /**
   * Item #15 Phase C.3 — public read accessor for the bound identity.
   * Returns `null` until {@link setIdentity} has been called.
   *
   * Exposed for host wiring (factory's `onProfileDirtyFlush` closure)
   * that needs the wallet's `chainPubkey` to build a lean profile
   * snapshot. The closure must tolerate `null` (snapshot build is
   * skipped pre-identity).
   */
  getIdentity(): FullIdentity | null {
    return this.identity;
  }

  /**
   * Item #15 Phase D.1a — public delegate for publishing a lean
   * snapshot CID via the aggregator pointer layer. Routes through
   * `LifecycleManager.publishAggregatorPointerBestEffort` so the
   * publish picks up:
   *   - pending-publish-marker persistence on transient failure;
   *   - permanent-vs-transient error classification;
   *   - `storage:error` emission on permanent failure;
   *   - automatic retry on the next `flushToIpfs` / pointer-poll cycle.
   *
   * Exposed for the factory's `onProfileDirtyFlush` closure (Phase D.1a)
   * and the flush-scheduler's snapshot-publish call site (Phase D.1b).
   * Direct callers should treat the result as authoritative — the
   * publish has either landed, deferred for retry, or surfaced an
   * operator alert. The `ProfileSnapshotPublishResult` shape matches
   * the underlying lifecycle method 1:1.
   */
  publishLeanSnapshotCid(
    cidString: string,
  ): Promise<ProfileSnapshotPublishResult> {
    return this.lifecycleManager.publishAggregatorPointerBestEffort(cidString);
  }

  /**
   * Issue #239 — host-surface entry point for the per-flush remote-
   * durability verification gate. Delegates to
   * `LifecycleManager.verifyFlushDurability`. Exposed via the
   * `ProfileTokenStorageHost` interface so FlushScheduler can call it
   * AFTER pin + publish complete; throws on verification failure so
   * `forceFlushSerialized`'s rejection arm propagates the failure to
   * `awaitNextFlush` and the at-least-once gate refuses the Nostr ack.
   * See `ProfileTokenStorageHost.verifyFlushDurability` for the
   * contract.
   */
  verifyFlushDurability(
    bundleCid: string,
    snapshotCid: string | null,
    deadlineMs: number,
  ): Promise<void> {
    return this.lifecycleManager.verifyFlushDurability(
      bundleCid,
      snapshotCid,
      deadlineMs,
    );
  }

  /**
   * Item #15 Phase D.2 — public accessor for the wallet-global
   * {@link BundleIndex}. Exposed so the factory's pull-side dispatcher
   * (`runProfileSnapshotJoin`) can dispatch JOIN over the
   * `tokens.bundle.*` slice of a remote lean snapshot. BundleIndex
   * implements {@link ProfileSyncWriter} and owns the
   * encrypted-envelope read/write contract for bundle refs.
   *
   * The handle remains owned by the provider — callers MUST NOT cache
   * it across `shutdown()`/`destroy()` cycles. Returns `null` only if
   * the provider has been torn down (today the field is non-null after
   * construction).
   */
  getBundleIndex(): BundleIndex | null {
    return this.bundleIndex ?? null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<boolean> {
    // Restore any persisted pending-publish marker from a prior
    // process run BEFORE lifecycle wires up — this lets the very
    // first periodic poll / save-driven flush retry the publish.
    await this.restorePendingPublishCidFromCache();
    return this.lifecycleManager.initialize(
      () => this.handleReplication(),
      () => this.onPollDiscoveredNewCid(),
    );
  }

  async shutdown(options?: ShutdownOptions): Promise<void> {
    // Item #15 Phase C.2 — cancel the dirty-flush debounce BEFORE the
    // lifecycle's shutdown so the lifecycle's `setIsShuttingDown(true)`
    // doesn't race a late-firing timer that would re-enter the dispatch
    // path. Then await any in-flight dirty-flush callback so we don't
    // leave a Sphere-injected flush dangling past provider teardown.
    this.cancelDirtyFlushTimer();
    try {
      await this.awaitDirtyFlushSettled();
    } catch {
      // Best-effort — the dispatch path already surfaces errors via
      // storage:error; shutdown shouldn't fail on a flush error.
    }
    // Issue #239 — pass shutdown options through to LifecycleManager
    // so it can run (or skip, on `force: true`) the remote-durability
    // gate before the provider tears down.
    await this.lifecycleManager.shutdown(options);
    // Latch the sticky shutdown flag AFTER the lifecycle finishes so
    // any late-arriving signal from a writer that outlives the
    // provider becomes a definite no-op.
    this.hasShutdown = true;
  }

  /**
   * TokenStorageProvider.awaitNextFlush — force pending writes to durably
   * persist (IPFS pin + OrbitDB ref + aggregator pointer) and wait for
   * completion. Used by PaymentsModule.handleIncomingTransfer to gate
   * the Nostr `since`-filter advancement on real IPFS durability.
   *
   * Pattern mirrors `LifecycleManager.shutdown`'s flush sequence
   * (cancel debounce → await in-flight → flush remaining pending),
   * but as a re-callable method that does NOT teardown the provider.
   *
   * Loops to handle the case where a concurrent save() lands during
   * an in-flight flush: that save's data sits in pendingData; we run
   * another flush to capture it. Bounded by `timeoutMs`.
   *
   * Rejects via SphereError('TIMEOUT') if pending writes can't drain
   * within the budget — caller treats this as "NOT durable" → don't
   * advance Nostr `since` → re-replay on next reconnect (idempotent
   * via addToken stateHash dedup).
   *
   * @param timeoutMs Max wall-clock time. Default 30s. Pass 0 (or any
   *   non-finite / non-positive value, including `Number.POSITIVE_INFINITY`
   *   and `Number.NaN`) to disable the wall-clock deadline entirely —
   *   appropriate for one-shot bulk operations like `migrateTokenStorage()`
   *   whose duration legitimately scales with input size. The 4-iteration
   *   runaway guard still applies regardless, so a genuinely stuck save-
   *   flush feedback loop cannot run forever.
   *
   *   Note: this differs from `pinCarBlocksToIpfs(..., concurrency)`,
   *   which treats `+Infinity` / `NaN` as "fall back to default
   *   concurrency=10" rather than "no cap". The two parameters have
   *   different shapes (time budget vs in-flight pool size); the shared
   *   non-finite handling here is "disable", there is "use default".
   */
  async awaitNextFlush(timeoutMs = 30_000): Promise<void> {
    if (!this.initialized || !this.encryptionKey) return;

    // Treat 0, negative, NaN, and ±Infinity as "no deadline". The flush
    // chain still propagates errors and the 4-iteration cap below catches
    // runaway save→flush races, but we don't impose an arbitrary wall-
    // clock ceiling on operations whose work scales with input.
    const noDeadline = !Number.isFinite(timeoutMs) || timeoutMs <= 0;

    // Issue #274 — perf instrumentation. Entry log + duration mark on each
    // iteration so operators can distinguish "first flush slow" from
    // "runaway 4-iteration" pathologies. The body keeps its original
    // structure (multiple returns + throws); the corresponding "exit" log
    // is in the wrapping `awaitAllProvidersDurable` span's per-provider
    // mark, which records the duration of this whole call.
    logger.debug(
      'profile:flush',
      'awaitNextFlush enter',
      { timeoutMs, noDeadline },
    );

    const deadline = noDeadline ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    const remainingMs = (): number =>
      noDeadline ? 0 : Math.max(0, deadline - Date.now());

    // Gap 4 (POINTER_MONOTONICITY_VIOLATION recovery): once per
    // `awaitNextFlush` invocation we permit a single in-loop baseline
    // refresh + flush retry. The check fires when OrbitDB has bundle
    // CIDs that aren't in `lastLoadedFromBundleCids` — typically a
    // stale baseline produced by a concurrent peer write that
    // replicated mid-flush. Refreshing via `load()` re-seeds the
    // baseline; the next flush iteration then passes the check.
    // Without this recovery, the at-least-once gate would refuse the
    // Nostr ack on every replay (the bundle is already in OrbitDB so
    // addToken is a no-op; awaitNextFlush sees nothing to flush and
    // returns true — masking the persistent violation). The one-shot
    // budget prevents an infinite recovery loop when the violation
    // is genuinely permanent.
    let monotonicityRetried = false;

    // Iterate: there might be saves landing during in-flight flush.
    // Bound iterations to 4 — each iteration runs one full flush, so
    // > 4 means save() is faster than flush, which is a runaway
    // scenario better surfaced as TIMEOUT.
    //
    // Uses `flushScheduler.forceFlushSerialized()` (NOT `flushToIpfs()`
    // directly) so we compose into the host's shared `flushPromise`
    // chain. Concurrent callers (multiple receives racing to ack their
    // events) thus get serialized through one chain — preventing the
    // BUNDLE-SET-CHECK race where parallel `flushToIpfs()` invocations
    // each pass the monotonicity check, then THE SECOND one sees the
    // FIRST's just-pinned CID as "unknown" because the first hadn't
    // yet updated `lastLoadedFromBundleCids`.
    for (let iteration = 0; iteration < 4; iteration++) {
      // Cancel pending debounce timer — we don't want to wait its full
      // window; we'll drive a flush right now via the serialized path.
      const timer = this.flushTimer;
      if (timer !== null) {
        clearTimeout(timer);
        this.flushTimer = null;
      }

      // If pendingData is null AND no flush is in flight, nothing to
      // do — every prior save() must have already settled.
      if (this.pendingData === null && this.flushPromise === null) return;

      // Force a serialized flush — composes into the host flushPromise
      // chain. If a flush is already in flight, this one runs AFTER it
      // (via the chain's `previous.then(flushToIpfs)` step). If we're
      // the first caller after a save(), this drives the first flush.
      // Errors from the chain (POINTER_MONOTONICITY_VIOLATION, etc.)
      // propagate as a rejection — caller decides ack behavior.
      const chained = this.flushScheduler.forceFlushSerialized();
      // Issue #272 — explicitly hold the timeout handle so we can
      // clearTimeout in finally. Without this, when `chained` settles
      // first, the setTimeout fires later (after the original deadline)
      // with an unhandled rejection from `Promise.race` (already-
      // settled, but the timer callback still allocates the
      // SphereError). Over a replay storm of N iterations × M parallel
      // awaitNextFlush callers, these timer handles accumulate.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        if (noDeadline) {
          // Skip Promise.race entirely — no timer to allocate, no spurious
          // late-fire on settled chains. The 4-iteration cap and the
          // chain's own error propagation remain the only termination
          // conditions.
          await chained;
        } else {
          await Promise.race([
            chained,
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () =>
                  reject(
                    new SphereError(
                      'awaitNextFlush: timeout awaiting serialized flush',
                      'TIMEOUT',
                    ),
                  ),
                remainingMs(),
              );
            }),
          ]);
        }
      } catch (err) {
        if (err instanceof SphereError && err.code === 'TIMEOUT') throw err;

        // Gap 4: monotonicity-violation recovery (one shot per call).
        // Refresh the baseline via load() and retry the flush. If the
        // refresh itself fails or the SECOND attempt also violates,
        // surface the original rejection so the at-least-once gate
        // refuses the Nostr ack — replay on next reconnect is the
        // safe fallback.
        const code = (err as { code?: unknown }).code;
        if (code === 'POINTER_MONOTONICITY_VIOLATION' && !monotonicityRetried) {
          monotonicityRetried = true;
          this.log(
            `awaitNextFlush: POINTER_MONOTONICITY_VIOLATION — ` +
              `refreshing baseline and retrying flush once`,
          );
          const refreshed = await this.refreshBaselineForMonotonicity();
          if (!refreshed) {
            this.log(
              `awaitNextFlush: baseline refresh failed — propagating violation`,
            );
            throw err;
          }
          // Retry the same flush iteration. The continue() restarts
          // the loop body which will re-call forceFlushSerialized
          // with the refreshed `lastLoadedFromBundleCids`.
          continue;
        }

        // Surface flush errors so caller (handleIncomingTransfer)
        // refuses to advance the Nostr ack — event re-replays on
        // next reconnect; addToken stateHash dedup is idempotent.
        throw err;
      } finally {
        // Issue #272 — always clear the race timeout, whether `chained`
        // settled first (timer would fire late) or the timer fired
        // first (already cleared by the throw path, but harmless).
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }

      // After the flush, pendingData was cleared inside flushToIpfs
      // unless a concurrent save() landed mid-flush (Steelman⁴³
      // identity check). Loop to handle that case.
      if (this.pendingData === null) return;
    }

    throw new SphereError(
      'awaitNextFlush: pendingData kept regenerating across 4 flush iterations',
      'TIMEOUT',
    );
  }

  // ---------------------------------------------------------------------------
  // save() -- Write-behind buffer
  // ---------------------------------------------------------------------------

  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    const timestamp = Date.now();

    if (!this.initialized || !this.encryptionKey) {
      return { success: false, error: 'Provider not initialized', timestamp };
    }

    // Steelman⁴¹ note: a save() concurrent with shutdown() sets
    // pendingData but scheduleFlush below will skip arming a timer
    // (it gates on isShuttingDown). The shutdown path then flushes
    // pendingData via the direct flushToIpfs() call. So late saves
    // ARE persisted — the gate lives in scheduleFlush, not here. This
    // explicit comment documents the design so a future contributor
    // doesn't add a reactive `if (isShuttingDown) return` here that
    // would silently drop legitimate concurrent writes.

    this.emitEvent({ type: 'storage:saving', timestamp });

    // Track lastLoadedData here on the facade so subsequent load()
    // calls return the in-flight data without an OrbitDB round-trip.
    this.lastLoadedData = data;
    this.flushScheduler.enqueueSave(data);

    this.emitEvent({ type: 'storage:saved', timestamp, data: { debounced: true } });

    return { success: true, timestamp };
  }

  // ---------------------------------------------------------------------------
  // load() -- Multi-bundle merge
  // ---------------------------------------------------------------------------

  async load(_identifier?: string): Promise<LoadResult<TxfStorageDataBase>> {
    const timestamp = Date.now();

    if (!this.initialized || !this.encryptionKey) {
      return {
        success: false,
        error: 'Provider not initialized',
        source: 'local',
        timestamp,
      };
    }

    // If there is pending data not yet flushed, return it directly
    if (this.pendingData) {
      return {
        success: true,
        data: this.pendingData,
        source: 'cache',
        timestamp,
      };
    }

    // If a flush is in flight, await it before reading OrbitDB. Without
    // this the read window between "pendingData cleared" and "OrbitDB
    // bundle ref written" returns a stale snapshot that omits the
    // in-flight bundle.
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch {
        // Flush failures are already surfaced via storage:error events
        // by scheduleFlush; we proceed to read whatever state exists.
      }
    }

    this.emitEvent({ type: 'storage:loading', timestamp });

    try {
      // 1. List all active bundles from OrbitDB
      const activeBundles = await this.bundleIndex.listActiveBundles();

      if (activeBundles.size === 0) {
        // Issue #313 — if `lastLoadedData` is non-null AND non-empty
        // (i.e., the lazy-load snapshot path seeded state from a local
        // blob) AND OrbitDB has nothing locally, return the seeded
        // state rather than wiping the view to empty. This covers:
        //   - Helia GC ran since the last save (blocks gone, level
        //     state intact but no bundles enumerable from OpLog walk).
        //   - Fresh device just imported wallet, snapshot blob is the
        //     baseline until aggregator recovery completes.
        //   - Aggregator unreachable — snapshot is the only source.
        //
        // We do NOT touch `lastLoadedFromBundleCids` here so the
        // monotonicity assertion's baseline stays at the seeded value
        // — any subsequent flush will publish against the seeded
        // bundle set, which is correct.
        //
        // Boundary: a wallet legitimately drained to empty (every
        // token sent away) ALSO has activeBundles.size === 0 but
        // `lastLoadedData` from a snapshot would still report the
        // pre-drain tokens. The next save-driven flush (from
        // `PaymentsModule.handleIncomingTransfer` or any user-driven
        // mutation) overwrites `lastLoadedData` with the actual empty
        // state and updates the snapshot accordingly. The window
        // during which a fully-drained wallet incorrectly displays
        // stale tokens is bounded by the next mutation; for the cold-
        // boot offline render contract this is the right trade-off.
        const seedHasTokens =
          this.lastLoadedData !== null &&
          Object.keys(this.lastLoadedData).some((k) => isTokenKey(k));
        if (seedHasTokens) {
          this.emitEvent({ type: 'storage:loaded', timestamp: Date.now() });
          return {
            success: true,
            data: this.lastLoadedData!,
            source: 'cache',
            timestamp: Date.now(),
          };
        }

        // No bundles -- return empty data
        const emptyData = this.buildEmptyTxfData();
        this.lastLoadedData = emptyData;
        // Snapshot the merged-bundle set for the monotonicity assertion.
        this.lastLoadedFromBundleCids = new Set();
        this.emitEvent({ type: 'storage:loaded', timestamp: Date.now() });
        return {
          success: true,
          data: emptyData,
          source: 'remote',
          timestamp: Date.now(),
        };
      }

      // 2. Dynamically import UxfPackage
      const { UxfPackage } = await import('../uxf/UxfPackage.js');
      // Local type alias for the imported class instance — UxfPackage's
      // constructor is private, so `InstanceType<typeof UxfPackage>`
      // fails. Snapshotting via ReturnType<create> sidesteps the
      // visibility check.
      type UxfPackageInstance = ReturnType<typeof UxfPackage.create>;
      const mergedPkg = UxfPackage.create();

      // 3. JOIN across all active bundles (PROFILE-ARCHITECTURE §10.4).
      //
      //    Semantics: for each tokenId appearing in any bundle, the merged
      //    package must contain the longest valid chain. When chains diverge
      //    (two bundles show incompatible transitions from the same state),
      //    both siblings are preserved so that downstream consumers can
      //    resolve the conflict.
      //
      //    The structural work is delegated to `UxfPackage.merge()` which
      //    invokes the per-token resolver (`resolveTokenRoot`) at
      //    `uxf/token-join.ts`. Rules 3 + 4 of §10.4 (longest-valid chain
      //    + proof enrichment) are implemented there. Rule 4 enrichment
      //    activates only when the caller supplies a `verifiedProofs` set
      //    — we compute it below across all loaded bundles when an oracle
      //    is wired AND there's more than one bundle (a single-bundle
      //    load has no candidate collisions, so verification would be
      //    pure overhead).
      //
      //    CARs on IPFS are unencrypted; confidentiality comes from the
      //    OrbitDB KV layer that holds the bundle refs. Unencrypted CARs
      //    enable cross-user content-addressed dedup (see §10.2).

      // Gap 3 wiring: first pass — fetch every bundle CAR into memory so
      // we can pre-compute verifiedProofs across the full set before
      // running the resolver. Per-bundle fetch failures are non-fatal
      // (partial load is better than failure).
      const loadedBundles: Array<{ cid: string; pkg: UxfPackageInstance }> = [];
      for (const [cid] of activeBundles) {
        try {
          // Issue #200 Phase 2: bundle CIDs are now dag-cbor envelope
          // CIDs (per-block pinned), not raw-CIDs over the CAR bytes.
          // `fetchCarFromIpfs` walks the dag-cbor link graph and
          // reassembles a synthetic CAR so `UxfPackage.fromCar` stays
          // unchanged. Legacy raw-CIDs (pre-#200) still resolve via the
          // backward-compat branch inside `fetchCarFromIpfs`.
          //
          // Issue #236 — pass the local Helia handle so the BFS block
          // walk satisfies each per-block fetch from our on-disk
          // blockstore first when available. Cross-process recovery on
          // the same `dataDir` becomes deterministic: blocks pinned by
          // the prior process are read locally, independent of HTTP
          // gateway propagation (~15s on testnet). Cross-device
          // recovery (where the local blockstore is empty) falls back
          // to the gateway loop as before.
          const carBytes = await fetchCarFromIpfs(
            this._ipfsGateways,
            cid,
            undefined,
            undefined,
            this.db.getHelia?.(),
          );
          const pkg = await UxfPackage.fromCar(carBytes);
          loadedBundles.push({ cid, pkg });
        } catch (err) {
          this.log(`Failed to load bundle ${cid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Pre-compute verifiedProofs when Rule 4 enrichment is applicable.
      // Skip the verifier walk entirely on single-bundle loads — the
      // resolver only fires on per-token collisions which require ≥2
      // candidate roots; a single-bundle load has none.
      let verifiedProofs: ReadonlySet<string> | undefined = undefined;
      const verifyInclusionProof = this.options?.oracle?.verifyInclusionProof;
      if (verifyInclusionProof && loadedBundles.length >= 2) {
        try {
          // Pairwise accumulation via the existing helper. `computeVerifiedProofs`
          // walks BOTH packages' pools dedup-by-content-hash, so for N
          // bundles we accumulate the union by walking the previously
          // merged set against each new bundle. The verifier itself is
          // deterministic (same input → same output) so cross-device
          // agreement holds. Each proof is verified at most once because
          // the helper dedupes by ContentHash inside.
          const accum = new Set<string>();
          for (let i = 0; i < loadedBundles.length; i++) {
            for (let j = i + 1; j < loadedBundles.length; j++) {
              const pairwise = await loadedBundles[i].pkg.computeVerifiedProofs(
                loadedBundles[j].pkg,
                (input: {
                  proofJson: unknown;
                  transactionHash: string;
                  proofHash?: string;
                }) => verifyInclusionProof.call(this.options!.oracle!, input),
              );
              for (const h of pairwise) accum.add(h);
            }
          }
          verifiedProofs = accum;
          this.log(
            `JOIN: computed verifiedProofs across ${loadedBundles.length} bundles ` +
              `(${accum.size} proof element(s) verified)`,
          );
        } catch (err) {
          // Verifier failure must not abort the load — fall back to the
          // conservative (no-enrichment) resolution. The structural JOIN
          // still runs and Rule 3 (longest-valid prefix) still applies;
          // only Rule 4 enrichment is skipped.
          this.log(
            `JOIN: computeVerifiedProofs failed (Rule 4 enrichment skipped): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Second pass: structural merge. Rule 4 enrichment fires when
      // `verifiedProofs` is non-empty AND the resolver finds a same-core-
      // different-proof transaction pair.
      for (const { cid, pkg } of loadedBundles) {
        try {
          mergedPkg.merge(pkg, verifiedProofs ? { verifiedProofs } : undefined);
        } catch (err) {
          this.log(`Failed to merge bundle ${cid}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 4. Derive the structural token manifest from the joined package
      //    (conflicts detected, oracle status deferred to future layer)
      //    and cache for getTokenManifest(). See profile/token-manifest.ts.
      //    Wrapped because the derivation touches UxfPackage internals;
      //    a deriver failure must not fail the load itself.
      try {
        this.lastTokenManifest = deriveStructuralManifest(mergedPkg);
      } catch (err) {
        this.log(`Token manifest derivation failed: ${err instanceof Error ? err.message : String(err)}`);
        this.lastTokenManifest = new Map();
      }

      // 5. Assemble all tokens from merged package
      const assembledTokens = mergedPkg.assembleAll();

      // 5. Read operational state:
      //    - synced portion from OrbitDB (outbox, mintOutbox, etc.)
      //    - derived portion from local cache (tombstones, sent, history)
      const opState = await this.readOperationalState();

      // 6. Build TxfStorageDataBase — uses whatever we have so far
      const txfData = this.buildTxfStorageData(assembledTokens, opState);

      // 7. If the local derived cache is empty, rebuild from the token
      //    pool and patch the result. This covers fresh-device onboarding
      //    and local-cache corruption. The derived caches are then
      //    persisted locally for next load.
      const cacheIsEmpty =
        opState.tombstones.length === 0 &&
        opState.sent.length === 0 &&
        opState.history.length === 0;
      if (cacheIsEmpty && assembledTokens.size > 0) {
        const rebuilt = await this.rebuildDerivedCache(txfData);
        if (rebuilt.tombstones.length > 0) txfData._tombstones = rebuilt.tombstones;
        if (rebuilt.sent.length > 0) txfData._sent = rebuilt.sent;
        if (rebuilt.history.length > 0) txfData._history = rebuilt.history;
      }

      this.lastLoadedData = txfData;
      // Snapshot the merged-bundle set for the runtime monotonicity
      // assertion. activeBundles enumerated above is the V_n-1 bundle
      // union; any future flush whose source state was captured before
      // an additional bundle replicates in is detectably stale.
      this.lastLoadedFromBundleCids = new Set(activeBundles.keys());

      this.emitEvent({ type: 'storage:loaded', timestamp: Date.now() });

      return {
        success: true,
        data: txfData,
        source: 'remote',
        timestamp: Date.now(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent(this.buildErrorEvent('storage:error', err));
      return {
        success: false,
        error: errorMsg,
        source: 'remote',
        timestamp: Date.now(),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // sync()
  // ---------------------------------------------------------------------------

  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    if (!this.initialized || !this.encryptionKey) {
      return { success: false, added: 0, removed: 0, conflicts: 0, error: 'Provider not initialized' };
    }

    this.emitEvent({ type: 'sync:started', timestamp: Date.now() });

    try {
      // Snapshot the pre-sync bundle set BEFORE triggering the
      // aggregator poll so any CID the poll discovers counts as a
      // "new" bundle in the diff below. Capturing AFTER the poll
      // would hide poll-discovered CIDs from the newCids computation
      // (the very state-change that should drive cold-start load).
      const previousCids = new Set(this.knownBundleCids);

      // Cross-device sync: trigger an immediate aggregator pointer
      // poll BEFORE refreshing OrbitDB. The periodic [30s, 90s)
      // poll is the safety net for cross-device discovery, but a
      // caller that explicitly invokes `sync()` is signalling "I
      // want the freshest state NOW" — waiting up to 90s for the
      // next periodic tick (or for libp2p replication that may
      // never connect through restrictive NATs) leaves cross-device
      // sync e2e tests timing out at PROPAGATION_TIMEOUT_MS. The
      // poll's onPollDiscoveredNewCid handler runs `addBundle` which
      // updates `knownBundleCids` in-place — that mutation is what
      // newCids picks up after the refresh below.
      //
      // The poll is best-effort: failures (transient aggregator
      // unreachability, WALKBACK_FLOOR retries exhausted) are
      // logged and ignored. The downstream OrbitDB refresh and
      // bundle-set comparison still run.
      try {
        await this.lifecycleManager.triggerPointerPollNow();
      } catch (err) {
        this.log(
          `sync: aggregator pointer poll failed (best-effort): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Refresh bundle list from OrbitDB (picks up libp2p-replicated
      // bundles AND poll-added bundles from the trigger above).
      await this.bundleIndex.refreshKnownBundles();

      // Determine new and removed bundles
      const newCids: string[] = [];
      for (const cid of this.knownBundleCids) {
        if (!previousCids.has(cid)) {
          newCids.push(cid);
        }
      }
      const removedCids: string[] = [];
      for (const cid of previousCids) {
        if (!this.knownBundleCids.has(cid)) {
          removedCids.push(cid);
        }
      }

      // Cold-start: pointer-layer recovery in `initialize()` may have
      // populated `knownBundleCids` (and the OrbitDB bundle ref) before
      // any token state was loaded. In that case `previousCids` and the
      // refreshed list are identical, so newCids/removedCids are empty,
      // BUT we have never actually fetched the CAR for those bundles and
      // assembled tokens. Force a full load when bundles exist but
      // `lastLoadedData` is still null — the very first sync after
      // cold-start MUST hydrate the token pool.
      const coldStartLoadNeeded =
        this.lastLoadedData === null && this.knownBundleCids.size > 0;

      // Steelman dedup: if a cold-start load is already in flight,
      // attach to it instead of starting a parallel fetch. load() is
      // idempotent on the bytes but its surrounding event emissions
      // (sync:completed, history-import) are not. Returning the same
      // promise to all racing callers avoids double-emit / double-import.
      if (coldStartLoadNeeded && this.coldStartSyncPromise !== null) {
        return await this.coldStartSyncPromise;
      }

      if (newCids.length === 0 && removedCids.length === 0 && !coldStartLoadNeeded) {
        // No changes -- return local data as-is
        this.emitEvent({ type: 'sync:completed', timestamp: Date.now() });
        return {
          success: true,
          merged: localData,
          added: 0,
          removed: 0,
          conflicts: 0,
        };
      }

      // Full reload to get merged result. For cold-start path, latch the
      // promise so concurrent racing sync()s share a single load + a
      // single set of post-load events.
      const computeResult = async (): Promise<SyncResult<TxfStorageDataBase>> => {
        const loadResult = await this.load();
        if (!loadResult.success || !loadResult.data) {
          return {
            success: false,
            added: newCids.length,
            removed: removedCids.length,
            conflicts: 0,
            error: loadResult.error ?? 'Failed to load merged data',
          };
        }

        // Count tokens added/removed by comparing
        const localTokenIds = new Set(this.extractTokenIds(localData));
        const remoteTokenIds = new Set(this.extractTokenIds(loadResult.data));

        let added = 0;
        let removed = 0;
        for (const id of remoteTokenIds) {
          if (!localTokenIds.has(id)) added++;
        }
        for (const id of localTokenIds) {
          if (!remoteTokenIds.has(id)) removed++;
        }

        this.emitEvent({
          type: 'sync:completed',
          timestamp: Date.now(),
          data: { added, removed, newBundles: newCids.length },
        });

        return {
          success: true,
          merged: loadResult.data,
          added,
          removed,
          conflicts: 0,
        };
      };

      if (coldStartLoadNeeded) {
        const inflight = computeResult();
        this.coldStartSyncPromise = inflight;
        try {
          return await inflight;
        } finally {
          // Clear only if THIS promise is still latched (a peer reset
          // the field e.g. via clear() may have replaced it already).
          if (this.coldStartSyncPromise === inflight) {
            this.coldStartSyncPromise = null;
          }
        }
      }

      return await computeResult();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emitEvent(this.buildErrorEvent('sync:error', err));
      return { success: false, added: 0, removed: 0, conflicts: 0, error: errorMsg };
    }
  }

  // ---------------------------------------------------------------------------
  // Optional TokenStorageProvider methods
  // ---------------------------------------------------------------------------

  async exists(_identifier?: string): Promise<boolean> {
    if (!this.initialized || !this.db.isConnected()) return false;
    try {
      const bundles = await this.db.all(BUNDLE_KEY_PREFIX);
      return bundles.size > 0;
    } catch {
      return false;
    }
  }

  async clear(): Promise<boolean> {
    if (!this.initialized) return false;

    try {
      // Remove all bundle refs from OrbitDB
      const allBundles = await this.db.all(BUNDLE_KEY_PREFIX);
      for (const key of allBundles.keys()) {
        await this.db.del(key);
      }

      // Clear operational state
      const addr = this.getAddressId();
      const opKeys = [
        `${addr}.tombstones`,
        `${addr}.outbox`,
        `${addr}.sent`,
        `${addr}.invalid`,
        `${addr}.history`,
        `${addr}.transactionHistory`,
        `${addr}.mintOutbox`,
        `${addr}.invalidatedNametags`,
      ];
      for (const key of opKeys) {
        try {
          await this.db.del(key);
        } catch {
          // best-effort
        }
      }

      this.knownBundleCids.clear();
      this.pendingData = null;
      this.lastLoadedData = null;
      this.lastLoadedFromBundleCids = null;

      return true;
    } catch (err) {
      this.log(`clear() failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Return the latest **structural** token manifest derived during
   * load(). Returns null if no load has completed yet.
   *
   * Structural-only: entries carry `status ∈ {'valid', 'conflicting'}`.
   * Oracle-based status (spent, pending, invalid) is produced by a
   * future higher-layer enrichment pass. See PROFILE-ARCHITECTURE.md
   * §10.2.2 and §10.6, and profile/token-manifest.ts for details.
   */
  getTokenManifest(): TokenManifest | null {
    return this.lastTokenManifest;
  }

  createForAddress(addressId?: string): ProfileTokenStorageProvider {
    const resolvedAddressId = addressId ?? this.getAddressId();
    const options: ProfileTokenStorageProviderOptions | undefined = this._options
      ? { ...this._options, addressId: resolvedAddressId }
      : undefined;
    return new ProfileTokenStorageProvider(
      this._db,
      this._encryptionKeyRaw,
      this._ipfsGateways,
      options,
      this.localCache,
    );
  }

  // ---------------------------------------------------------------------------
  // Event system
  // ---------------------------------------------------------------------------

  onEvent(callback: StorageEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------
  // History operations — delegated to HistoryStore
  // ---------------------------------------------------------------------------

  async addHistoryEntry(entry: HistoryRecord): Promise<void> {
    return this.historyStore.addHistoryEntry(entry);
  }

  async getHistoryEntries(): Promise<HistoryRecord[]> {
    return this.historyStore.getHistoryEntries();
  }

  async hasHistoryEntry(dedupKey: string): Promise<boolean> {
    return this.historyStore.hasHistoryEntry(dedupKey);
  }

  async clearHistory(): Promise<void> {
    return this.historyStore.clearHistory();
  }

  async importHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    return this.historyStore.importHistoryEntries(entries);
  }

  // ===========================================================================
  // Private: BundleIndex back-channels (preserved for tests that reach into
  // the facade via `(provider as unknown as { addBundle: ... }).addBundle`).
  //
  // These shims preserve the pre-refactor private surface byte-for-byte —
  // the facade keeps the same private method names, with the implementation
  // delegated to `BundleIndex`. SDK consumers MUST go through the public
  // API; these are documented as test-only back-channels.
  // ===========================================================================

  private async addBundle(
    cid: string,
    ref: import('./types.js').UxfBundleRef,
  ): Promise<void> {
    return this.bundleIndex.addBundle(cid, ref);
  }

  private async listBundles(): Promise<Map<string, import('./types.js').UxfBundleRef>> {
    return this.bundleIndex.listBundles();
  }

  private async listActiveBundles(): Promise<
    Map<string, import('./types.js').UxfBundleRef>
  > {
    return this.bundleIndex.listActiveBundles();
  }

  private async refreshKnownBundles(): Promise<void> {
    return this.bundleIndex.refreshKnownBundles();
  }

  private async shouldConsolidate(): Promise<boolean> {
    return this.bundleIndex.shouldConsolidate();
  }

  // ===========================================================================
  // Private: TXF adapter (extract / build)
  // ===========================================================================

  /**
   * Extract token entries from TxfStorageDataBase.
   * Token keys include:
   * - Keys starting with `_` (standard tokens, excluding operational keys)
   * - Keys starting with `archived-` (archived tokens)
   * - Keys starting with `_forked_` (forked tokens — also caught by `_` prefix)
   */
  private extractTokensFromTxfData(
    data: TxfStorageDataBase,
  ): Map<string, unknown> {
    const tokens = new Map<string, unknown>();

    // Use canonical token-key predicates from `types/txf.ts` rather than a
    // local ad-hoc operational-key allowlist. The local list previously
    // missed `_nametags`, `_nametag`, and `_integrity` — when those keys
    // were present in storage data, they were misclassified as token
    // entries and passed to `pkg.ingestAll`, which threw
    // `[UXF:INVALID_PACKAGE] Token must have a genesis field` because
    // arrays of NametagData / IntegrityRecord don't have a `genesis`
    // field. The flush silently re-queued forever, the pointer never
    // published, and recovery was systematically broken on real infra.
    // Routing through `RESERVED_KEYS` (the single source of truth) keeps
    // the two callsites in sync and prevents future drift.
    for (const key of Object.keys(data)) {
      if (!isTokenKey(key) && !isArchivedKey(key) && !isForkedKey(key)) continue;
      const value = (data as unknown as Record<string, unknown>)[key];
      // Defense-in-depth: skip anything that isn't a non-array object
      // (TxfToken is shaped { genesis, state, transactions, ... }).
      // An array would be an operational entry that snuck past the key
      // filter; a primitive is an unrecognized payload.
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      // Defense-in-depth: validate the TxfToken shape before adding to the
      // ingest set. UxfPackage.ingestAll requires `genesis`. If a future
      // storage entry slips through the key filter without a `genesis`
      // field, log + skip rather than DOS the entire flush by throwing.
      const candidate = value as { genesis?: unknown };
      if (!candidate.genesis || typeof candidate.genesis !== 'object') {
        logger.warn('Profile', `extractTokensFromTxfData: skipping malformed token at key="${key}" (no genesis field)`);
        continue;
      }
      tokens.set(key, value);
    }

    return tokens;
  }

  /**
   * Extract operational state from TxfStorageDataBase.
   */
  private extractOperationalState(data: TxfStorageDataBase): OperationalState {
    return {
      tombstones: data._tombstones ?? [],
      outbox: data._outbox ?? [],
      sent: data._sent ?? [],
      invalid: data._invalid ?? [],
      history: data._history ?? [],
      mintOutbox: ((data as unknown as Record<string, unknown>)._mintOutbox as unknown[]) ?? [],
      invalidatedNametags:
        ((data as unknown as Record<string, unknown>)._invalidatedNametags as unknown[]) ?? [],
      audit: data._audit ?? [],
      finalizationQueue: data._finalizationQueue ?? [],
    };
  }

  /**
   * Build a TxfStorageDataBase from assembled tokens and operational state.
   */
  private buildTxfStorageData(
    tokens: Map<string, unknown>,
    opState: OperationalState,
  ): TxfStorageDataBase {
    const meta: TxfMeta = {
      version: 1,
      address: this.getAddressId(),
      formatVersion: '1.0.0',
      updatedAt: Date.now(),
    };

    const result: TxfStorageDataBase = {
      _meta: meta,
    };

    // Add operational state
    if (opState.tombstones.length > 0) result._tombstones = opState.tombstones;
    if (opState.outbox.length > 0) result._outbox = opState.outbox;
    if (opState.sent.length > 0) result._sent = opState.sent;
    if (opState.invalid.length > 0) result._invalid = opState.invalid;
    if (opState.history.length > 0) result._history = opState.history;
    if (opState.mintOutbox.length > 0) {
      (result as unknown as Record<string, unknown>)._mintOutbox = opState.mintOutbox;
    }
    if (opState.invalidatedNametags.length > 0) {
      (result as unknown as Record<string, unknown>)._invalidatedNametags = opState.invalidatedNametags;
    }
    if (opState.audit.length > 0) result._audit = opState.audit;
    if (opState.finalizationQueue.length > 0) {
      result._finalizationQueue = opState.finalizationQueue;
    }

    // Add token entries
    for (const [tokenId, tokenData] of tokens) {
      // Ensure the key starts with _ for TxfStorageDataBase index signature
      const key = tokenId.startsWith('_') ? tokenId : `_${tokenId}`;
      (result as unknown as Record<string, unknown>)[key] = tokenData;
    }

    return result;
  }

  /**
   * Build an empty TxfStorageDataBase with just _meta.
   */
  private buildEmptyTxfData(): TxfStorageDataBase {
    return {
      _meta: {
        version: 1,
        address: this.getAddressId(),
        formatVersion: '1.0.0',
        updatedAt: Date.now(),
      },
    };
  }

  // ===========================================================================
  // Private: Operational state persistence
  // ===========================================================================

  /**
   * Write the SYNCED portion of operational state to OrbitDB.
   *
   * Keys written: outbox, invalid, mintOutbox, invalidatedNametags.
   * These are authoritative across all Sphere instances sharing the
   * wallet identity.
   *
   * `tombstones`, `sent`, and `history` are NOT written here — they go
   * to the local-only cache via `writeLocalDerivedCache()`. See
   * PROFILE-ARCHITECTURE.md §10 (Q1 decision) for rationale.
   */
  private async writeOrbitOperationalState(opState: OperationalState): Promise<void> {
    // Wave G.7: per-entry-key write path. Stages each entry under
    // its own key (`${addr}.outbox.${id}`) and writes a tombstone
    // for entries that were removed since the last flush. This
    // gains native CRDT semantics — two devices adding different
    // entries never conflict; a delete and an add on the same
    // entry resolve via OrbitDB's OpLog ordering (last writer wins).
    //
    // The legacy single-blob path below stays as a one-shot
    // migration: if the legacy blob exists, we delete it after the
    // per-entry writes succeed so future reads see only the
    // per-entry layout.
    const addr = this.getAddressId();
    return this.writeOrbitOperationalStatePerEntry(opState, addr);
  }

  /**
   * Wave G.7: per-entry-key write path. See readOrbitOperationalState
   * for layout description. Diffs the in-memory `opState` against
   * the on-disk per-entry view and writes only the deltas:
   *   - new/modified entries → put `${prefix}.${id}` = JSON(entry)
   *   - removed entries → put `${prefix}.${id}` = JSON({ tombstoned: true, deletedAt })
   *
   * Tombstones are retained for `TOMBSTONE_RETENTION_MS` (30 days)
   * and then GC'd. This is best-effort — a long-offline device
   * coming back after >30 days could re-replicate a tombstoned
   * entry as if it were live; the hazard is bounded by the wallet's
   * tombstone retention policy and is acceptable given typical
   * online cadence.
   */
  private async writeOrbitOperationalStatePerEntry(
    opState: OperationalState,
    addr: string,
  ): Promise<void> {
    const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Compute set of live primary keys for each list.
    const liveOutbox = new Map<string, TxfOutboxEntry>();
    for (const e of opState.outbox) {
      const id = (e as unknown as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) liveOutbox.set(id, e);
    }
    const liveInvalid = new Map<string, TxfInvalidEntry>();
    for (const e of opState.invalid) {
      const id = (e as unknown as Record<string, unknown>).tokenId;
      if (typeof id === 'string' && id.length > 0) liveInvalid.set(id, e);
    }
    const liveMint = new Map<string, unknown>();
    for (const e of opState.mintOutbox) {
      const id = (e as Record<string, unknown>).tokenId;
      if (typeof id === 'string' && id.length > 0) liveMint.set(id, e);
    }
    // T.0.G7-fill-gaps: audit + finalizationQueue collections. Each
    // entry is keyed by its opaque `id` field — the writer treats the
    // value as a string and does not parse internal structure, so a
    // future composite id form (T.1.E: `${tokenId}.${contentHash}`)
    // works without any further plumbing.
    const liveAudit = new Map<string, TxfAuditEntry>();
    for (const e of opState.audit) {
      const id = (e as unknown as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) liveAudit.set(id, e);
    }
    const liveFinalization = new Map<string, TxfFinalizationQueueEntry>();
    for (const e of opState.finalizationQueue) {
      const id = (e as unknown as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) liveFinalization.set(id, e);
    }

    // Read existing per-entry keys to compute the diff.
    // Wave I.8: a listing failure makes the diff impossible to
    // compute correctly — without the existing-keys snapshot we
    // cannot know which entries were removed since the last flush
    // and would skip writing tombstones for them. Surface the
    // failure as a typed storage:error and bail; the next save will
    // retry with a fresh listing.
    let existingOutboxKeys: Map<string, string>;
    let existingInvalidKeys: Map<string, string>;
    let existingMintKeys: Map<string, string>;
    let existingAuditKeys: Map<string, string>;
    let existingFinalizationKeys: Map<string, string>;
    try {
      [
        existingOutboxKeys,
        existingInvalidKeys,
        existingMintKeys,
        existingAuditKeys,
        existingFinalizationKeys,
      ] = await Promise.all([
        this.listExistingPerEntryKeys(`${addr}.outbox.`),
        this.listExistingPerEntryKeys(`${addr}.invalid.`),
        this.listExistingPerEntryKeys(`${addr}.mintOutbox.`),
        this.listExistingPerEntryKeys(`${addr}.audit.`),
        this.listExistingPerEntryKeys(`${addr}.finalizationQueue.`),
      ]);
    } catch (err) {
      this.log(
        `writeOrbitOperationalStatePerEntry: existing-keys listing failed; ` +
          `aborting flush to avoid lossy convergence: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.emitEvent(this.buildErrorEvent('storage:error', err));
      return;
    }

    // Apply per-entry writes for each list.
    //
    // T.6.A: the outbox prefix is shared between legacy `TxfOutboxEntry`
    // (this writer's slot) and new `UxfTransferOutboxEntry` (owned by
    // `OutboxWriter` from `profile/outbox-writer.ts`). The legacy
    // writer's diff MUST NOT tombstone new-shape entries — they are
    // never in the legacy `liveOutbox` map. Pass `skipForeignSchema:
    // true` so the diff probes each candidate-for-tombstone and skips
    // any value carrying `_schemaVersion: 'uxf-1'`.
    await this.applyPerEntryDiff(
      `${addr}.outbox.`,
      liveOutbox,
      existingOutboxKeys,
      now,
      TOMBSTONE_RETENTION_MS,
      /* skipForeignSchema */ true,
    );
    await this.applyPerEntryDiff(
      `${addr}.invalid.`,
      liveInvalid,
      existingInvalidKeys,
      now,
      TOMBSTONE_RETENTION_MS,
      // G2 — DispositionWriter owns `_invalid` records under the same
      // prefix and stamps `_schemaVersion: 'uxf-1'` on every write. The
      // legacy `data._invalid` is a `TxfInvalidEntry[]` (no
      // `_schemaVersion`) while the DispositionWriter records carry the
      // discriminator. Without this flag, every legacy save() flush
      // tombstones the DispositionWriter records (forensic data loss).
      /* skipForeignSchema */ true,
    );
    await this.applyPerEntryDiff(
      `${addr}.mintOutbox.`,
      liveMint,
      existingMintKeys,
      now,
      TOMBSTONE_RETENTION_MS,
    );
    await this.applyPerEntryDiff(
      `${addr}.audit.`,
      liveAudit,
      existingAuditKeys,
      now,
      TOMBSTONE_RETENTION_MS,
      // G1 — DispositionWriter owns `_audit` records under the same
      // prefix. See the `${addr}.invalid.` call above for full
      // rationale.
      /* skipForeignSchema */ true,
    );
    await this.applyPerEntryDiff(
      `${addr}.finalizationQueue.`,
      liveFinalization,
      existingFinalizationKeys,
      now,
      TOMBSTONE_RETENTION_MS,
      // G3 — recipient FinalizationQueue records (when persisted via
      // the OrbitDb-backed adapter) carry `_schemaVersion: 'uxf-1'`.
      // The legacy `data._finalizationQueue` is a
      // `TxfFinalizationQueueEntry[]` (no discriminator). Without this
      // flag every save() flush tombstones in-flight finalization
      // entries (cross-restart safety net erased).
      /* skipForeignSchema */ true,
    );

    // invalidatedNametags stays as a single key (small Set<string>).
    try {
      await this.writeProfileKey(
        `${addr}.invalidatedNametags`,
        JSON.stringify(opState.invalidatedNametags),
      );
    } catch (err) {
      this.log(`Failed to write invalidatedNametags: ${err instanceof Error ? err.message : String(err)}`);
      this.emitEvent(this.buildErrorEvent('storage:error', err));
    }

    // G4 — also persist tombstones to OrbitDB at `${addr}.tombstones`.
    // Pre-fix: tombstones lived ONLY in the per-device local cache
    // (`deriver.${addr}.all`). A cold-start (cache wiped by browser
    // storage purge / re-import / new device) returned empty tombstones,
    // so a Nostr re-delivery of an archived-token bundle would be
    // re-ingested as if live — security boundary violation. Writing to
    // OrbitDB carries the boundary across replication AND survives
    // cold-start as long as the Profile is recoverable from IPFS.
    //
    // Single-blob layout matches `invalidatedNametags` and `history`
    // (small bounded set per address). Empty arrays are still written
    // — peers MUST observe an authoritative empty state to converge.
    try {
      await this.writeProfileKey(
        `${addr}.tombstones`,
        JSON.stringify(opState.tombstones),
      );
    } catch (err) {
      this.log(
        `Failed to write tombstones: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.emitEvent(this.buildErrorEvent('storage:error', err));
    }

    // Migration: if a legacy single-blob exists for any of the lists,
    // delete it now that per-entry data is written. Best-effort.
    // Includes the new audit + finalizationQueue prefixes so a future
    // pre-per-entry layout (should one ever land in the wild) gets
    // cleaned up automatically.
    for (const k of [
      `${addr}.outbox`,
      `${addr}.invalid`,
      `${addr}.mintOutbox`,
      `${addr}.audit`,
      `${addr}.finalizationQueue`,
    ]) {
      try {
        const legacy = await this.db.get(k);
        if (legacy) await this.db.del(k);
      } catch {
        /* best-effort migration cleanup */
      }
    }
  }

  /**
   * Wave G.7: list the on-disk per-entry keys with the given prefix.
   * Returns a Map<key, entryId> where entryId is the suffix after
   * the prefix. Used by the diff step to detect removals.
   */
  private async listExistingPerEntryKeys(prefix: string): Promise<Map<string, string>> {
    // Wave I.8: propagate the error rather than silently returning
    // empty. A swallowed listing failure caused `applyPerEntryDiff`
    // to skip tombstone writes for all removed entries — peers
    // resurrect deleted data on next replication. Throwing here lets
    // the caller in `writeOrbitOperationalStatePerEntry` emit a
    // typed `storage:error` and surface incomplete convergence
    // rather than silently regress to pre-G.7 behavior.
    const result = new Map<string, string>();
    const all = await this.db.all(prefix);
    for (const key of all.keys()) {
      if (!key.startsWith(prefix)) continue;
      const entryId = key.slice(prefix.length);
      if (entryId.length > 0) result.set(key, entryId);
    }
    return result;
  }

  /**
   * Wave G.7: apply the per-entry diff for one list:
   *   - For each live entry, write its key (idempotent: same content
   *     produces same OrbitDB OpLog hash, no spurious oplog growth).
   *   - For each on-disk entryId not in the live set, write a
   *     tombstone (or delete the entry+tombstone if its tombstone
   *     is older than retention).
   *
   * T.6.A: when `skipForeignSchema` is `true`, an existing value
   * carrying `_schemaVersion: 'uxf-1'` is NOT tombstoned by this writer
   * — it is owned by `OutboxWriter` and shares the same prefix. Used by
   * the outbox slot only; other slots pass `false` (the default).
   */
  private async applyPerEntryDiff<T>(
    prefix: string,
    liveById: Map<string, T>,
    existingKeys: Map<string, string>,
    now: number,
    retentionMs: number,
    skipForeignSchema: boolean = false,
  ): Promise<void> {
    // Live entries: write each.
    for (const [id, entry] of liveById) {
      const key = `${prefix}${id}`;
      try {
        await this.writeProfileKey(key, JSON.stringify(entry));
      } catch (err) {
        this.log(`per-entry write ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.emitEvent(this.buildErrorEvent('storage:error', err));
      }
    }
    // Removed entries: tombstone or GC.
    for (const [key, entryId] of existingKeys) {
      if (liveById.has(entryId)) continue;
      // Read existing value to check whether it's already a tombstone
      // and old enough to GC. If it's a live entry that was removed,
      // tombstone it.
      let existingRaw: string | null = null;
      try {
        existingRaw = await this.readProfileKey(key);
      } catch {
        existingRaw = null;
      }
      let isTombstone = false;
      let deletedAt = 0;
      let isForeignSchema = false;
      if (existingRaw !== null) {
        try {
          const parsed = JSON.parse(existingRaw) as unknown;
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'tombstoned' in parsed &&
            (parsed as { tombstoned: unknown }).tombstoned === true
          ) {
            isTombstone = true;
            const da = (parsed as { deletedAt?: unknown }).deletedAt;
            deletedAt = typeof da === 'number' ? da : 0;
          } else if (
            skipForeignSchema &&
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)._schemaVersion === 'uxf-1'
          ) {
            isForeignSchema = true;
          }
        } catch {
          /* corrupt — overwrite with fresh tombstone */
        }
      }
      if (isForeignSchema) {
        // T.6.A: foreign-schema entry (UXF outbox writer's slot) at
        // the same prefix. Do NOT tombstone — it's owned by
        // `OutboxWriter`. Skip silently.
        continue;
      }
      if (isTombstone) {
        // GC if old enough.
        if (deletedAt > 0 && now - deletedAt > retentionMs) {
          try {
            await this.db.del(key);
          } catch {
            /* best-effort GC */
          }
        }
        continue;
      }
      // Live → tombstone transition.
      try {
        await this.writeProfileKey(
          key,
          JSON.stringify({ tombstoned: true, deletedAt: now }),
        );
      } catch (err) {
        this.log(`per-entry tombstone ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.emitEvent(this.buildErrorEvent('storage:error', err));
      }
    }
  }

  /**
   * Wave G.7 — legacy single-blob writer (preserved for reference;
   * unused after the per-entry migration).
   *
   * @deprecated kept only to allow reverting the per-entry path if
   * we hit unforeseen production issues. Not on any active code path.
   */
  private async writeOrbitOperationalStateSingleBlob(opState: OperationalState): Promise<void> {
    const addr = this.getAddressId();
    const MAX_RMW_RETRIES = 3;
    const RMW_WALL_CLOCK_BUDGET_MS = 10_000;
    const rmwStart = Date.now();
    const localOutboxIds = new Set(opState.outbox.map((e) => (e as unknown as Record<string, unknown>).id).filter((v) => v !== undefined));
    const localInvalidIds = new Set(opState.invalid.map((e) => (e as unknown as Record<string, unknown>).tokenId).filter((v) => v !== undefined));
    const localMintIds = new Set(opState.mintOutbox.map((e) => (e as unknown as Record<string, unknown>).tokenId).filter((v) => v !== undefined));
    const localTags = new Set(opState.invalidatedNametags as string[]);

    let attempt = 0;
    while (attempt <= MAX_RMW_RETRIES) {
      if (Date.now() - rmwStart > RMW_WALL_CLOCK_BUDGET_MS) {
        this.log(
          `writeOrbitOperationalState: wall-clock budget ${RMW_WALL_CLOCK_BUDGET_MS}ms exceeded ` +
            `after ${attempt} retries; surfacing storage:error and returning lossy.`,
        );
        this.emitEvent(
          this.buildErrorEvent(
            'storage:error',
            new Error('writeOrbitOperationalState: convergence budget exhausted; entries may be lost until next flush'),
          ),
        );
        return;
      }
      const remainingBudget = (): number =>
        Math.max(0, RMW_WALL_CLOCK_BUDGET_MS - (Date.now() - rmwStart));
      const raceWithBudget = async <T>(p: Promise<T>, label: string): Promise<T> => {
        const remaining = remainingBudget();
        if (remaining === 0) {
          throw new Error(`writeOrbitOperationalState: ${label} aborted; budget exhausted`);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`writeOrbitOperationalState: ${label} timed out (budget ${remaining}ms)`)),
            remaining,
          );
          if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            (timer as { unref: () => void }).unref();
          }
        });
        try {
          return await Promise.race([p, timeout]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          p.then(
            () => undefined,
            () => undefined,
          );
        }
      };
      let remote: OperationalState;
      try {
        remote = await raceWithBudget(this.readOperationalState(), 'readOperationalState');
      } catch (err) {
        this.emitEvent(this.buildErrorEvent('storage:error', err));
        return;
      }
      const merged: OperationalState = {
        tombstones: opState.tombstones,
        sent: opState.sent,
        history: opState.history,
        outbox: mergeByPrimaryKey(remote.outbox, opState.outbox, 'id'),
        invalid: mergeByPrimaryKey(remote.invalid, opState.invalid, 'tokenId'),
        mintOutbox: mergeByPrimaryKey(remote.mintOutbox, opState.mintOutbox, 'tokenId'),
        invalidatedNametags: Array.from(
          new Set([
            ...(remote.invalidatedNametags as string[]),
            ...(opState.invalidatedNametags as string[]),
          ]),
        ),
        audit: mergeByPrimaryKey(remote.audit, opState.audit, 'id'),
        finalizationQueue: mergeByPrimaryKey(
          remote.finalizationQueue,
          opState.finalizationQueue,
          'id',
        ),
      };

      const writes: Array<[string, unknown]> = [
        [`${addr}.outbox`, merged.outbox],
        [`${addr}.invalid`, merged.invalid],
        [`${addr}.mintOutbox`, merged.mintOutbox],
        [`${addr}.invalidatedNametags`, merged.invalidatedNametags],
      ];

      let writeFailed = false;
      for (const [key, value] of writes) {
        try {
          await raceWithBudget(this.writeProfileKey(key, JSON.stringify(value)), `writeProfileKey(${key})`);
        } catch (err) {
          writeFailed = true;
          this.log(`Failed to write operational state key "${key}": ${err instanceof Error ? err.message : String(err)}`);
          this.emitEvent(this.buildErrorEvent('storage:error', err));
          break;
        }
      }
      if (writeFailed) return;

      let verify: OperationalState;
      try {
        verify = await raceWithBudget(this.readOperationalState(), 'verifyReadOperationalState');
      } catch (err) {
        this.emitEvent(this.buildErrorEvent('storage:error', err));
        return;
      }
      const verifyOutboxIds = new Set(verify.outbox.map((e) => (e as unknown as Record<string, unknown>).id));
      const verifyInvalidIds = new Set(verify.invalid.map((e) => (e as unknown as Record<string, unknown>).tokenId));
      const verifyMintIds = new Set(verify.mintOutbox.map((e) => (e as unknown as Record<string, unknown>).tokenId));
      const verifyTags = new Set(verify.invalidatedNametags as string[]);
      const allPresent =
        Array.from(localOutboxIds).every((id) => verifyOutboxIds.has(id)) &&
        Array.from(localInvalidIds).every((id) => verifyInvalidIds.has(id)) &&
        Array.from(localMintIds).every((id) => verifyMintIds.has(id)) &&
        Array.from(localTags).every((tag) => verifyTags.has(tag));
      if (allPresent) return;

      attempt++;
      if (attempt > MAX_RMW_RETRIES) {
        this.log(
          `writeOrbitOperationalState: divergence persisted after ${MAX_RMW_RETRIES} retries; ` +
            `surfacing storage:error — sibling-clobbered entries are lost until next flush.`,
        );
        this.emitEvent(
          this.buildErrorEvent(
            'storage:error',
            new Error('writeOrbitOperationalState: convergence retries exhausted; entries may be lost until next flush'),
          ),
        );
        return;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 50 + Math.floor(Math.random() * 100)),
      );
    }
  }

  /**
   * Write the LOCAL-ONLY derived cache (tombstones, sent, history) to
   * the injected StorageProvider. These views are per-device and MUST
   * NOT be replicated — a corrupt or malicious remote instance would
   * otherwise poison them everywhere simultaneously.
   *
   * **Atomicity**: all three fields are serialized into a single key
   * `deriver.{addressId}.all`. A crash or disk-full error between two
   * individual writes would otherwise leave the cache in an inconsistent
   * state that subsequent empty-checks would silently trust (since one
   * field being non-empty bypasses the rebuild).
   *
   * **Error surfacing**: a write failure emits a `storage:error` event
   * AND returns false, so callers can react (retry, degrade, alert).
   * Previously the failure was only logged — hiding corruption.
   *
   * If no local cache was injected, this is a no-op and the deriver
   * will rebuild from the token pool on next load.
   */
  private async writeLocalDerivedCache(
    opState: Pick<OperationalState, 'tombstones' | 'sent' | 'history'>,
  ): Promise<boolean> {
    if (!this.localCache) return true;
    const addr = this.getAddressId();
    const key = `deriver.${addr}.all`;
    const payload = {
      tombstones: opState.tombstones,
      sent: opState.sent,
      history: opState.history,
    };
    try {
      await this.localCache.set(key, JSON.stringify(payload));
      // One-time cleanup of pre-atomic legacy per-key layout. Leaving
      // them around risks stale reads if the atomic key is ever lost
      // (downgrade / test rollback). Best-effort — cleanup errors are
      // logged but do not fail the write.
      if (!this.legacyKeysCleaned) {
        this.legacyKeysCleaned = true;
        for (const legacy of [
          `deriver.${addr}.tombstones`,
          `deriver.${addr}.sent`,
          `deriver.${addr}.history`,
        ]) {
          this.localCache.remove(legacy).catch((err) => {
            this.log(`Legacy cache cleanup failed for "${legacy}": ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to write local derived cache "${key}": ${msg}`);
      // Steelman⁴⁰ warning: route through buildErrorEvent.
      this.emitEvent(this.buildErrorEvent('storage:error', err));
      return false;
    }
  }

  /**
   * Read SYNCED operational state from OrbitDB.
   */
  private async readOrbitOperationalState(): Promise<Omit<OperationalState, 'tombstones' | 'sent' | 'history'>> {
    const addr = this.getAddressId();

    const [
      outbox,
      invalid,
      mintOutbox,
      invalidatedNametagsLegacy,
      audit,
      finalizationQueue,
    ] = await Promise.all([
      this.readPerEntryArrayLegacyOnly<TxfOutboxEntry>(
        `${addr}.outbox.`,
        `${addr}.outbox`,
      ),
      this.readPerEntryArrayWithLegacyFallback<TxfInvalidEntry>(
        `${addr}.invalid.`,
        `${addr}.invalid`,
      ),
      this.readPerEntryArrayWithLegacyFallback<unknown>(
        `${addr}.mintOutbox.`,
        `${addr}.mintOutbox`,
      ),
      this.readProfileKeyJson<unknown[]>(`${addr}.invalidatedNametags`),
      this.readPerEntryArrayWithLegacyFallback<TxfAuditEntry>(
        `${addr}.audit.`,
        `${addr}.audit`,
      ),
      this.readPerEntryArrayWithLegacyFallback<TxfFinalizationQueueEntry>(
        `${addr}.finalizationQueue.`,
        `${addr}.finalizationQueue`,
      ),
    ]);

    return {
      outbox,
      invalid,
      mintOutbox,
      invalidatedNametags: invalidatedNametagsLegacy ?? [],
      audit,
      finalizationQueue,
    };
  }

  /**
   * Wave G.7: per-entry-key reader with single-blob fallback.
   *
   * Iterates all OrbitDB keys with `prefix`, decodes each as a
   * tombstone or live entry, returns the live entries in
   * insertion-order-stable form. If no per-entry keys are found,
   * falls back to reading the single-blob `legacyBlobKey` for
   * backward compatibility with pre-G.7 wallets — the next write
   * will migrate the data forward.
   */
  private async readPerEntryArrayWithLegacyFallback<T>(
    prefix: string,
    legacyBlobKey: string,
  ): Promise<T[]> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(prefix);
    } catch (err) {
      this.log(`per-entry read failed for prefix "${prefix}": ${err instanceof Error ? err.message : String(err)}`);
      // Fall back to legacy on any read error.
      const legacy = await this.readProfileKeyJson<T[]>(legacyBlobKey);
      return legacy ?? [];
    }
    if (entries.size === 0) {
      // No per-entry data — try legacy blob.
      const legacy = await this.readProfileKeyJson<T[]>(legacyBlobKey);
      return legacy ?? [];
    }
    const out: T[] = [];
    // Stable order across devices: sort by full key.
    const sortedKeys = [...entries.keys()].sort();
    for (const key of sortedKeys) {
      const decoded = await this.decodePerEntryValue<T>(key);
      if (decoded === null) continue; // tombstone or corrupt — skip
      out.push(decoded);
    }
    return out;
  }

  /**
   * T.6.A: shape-aware variant of {@link readPerEntryArrayWithLegacyFallback}
   * for the outbox prefix. The outbox per-entry-key namespace carries TWO
   * distinct on-disk shapes during the migration window:
   *
   *   - **legacy** `TxfOutboxEntry` (pre-T.6.A, no `_schemaVersion`)
   *   - **new** `UxfTransferOutboxEntry` (T.6.A, `_schemaVersion: 'uxf-1'`)
   *
   * The legacy-only reader filters out new-shape entries so the
   * {@link OperationalState.outbox} slot continues to carry exactly the
   * shape its consumers expect. New-shape entries are read via
   * `OutboxWriter.readAll()` (`profile/outbox-writer.ts`) on a separate
   * code path.
   *
   * The discriminator is presence of the literal `_schemaVersion: 'uxf-1'`.
   * Any other value (missing field, unrelated string) is treated as
   * legacy-shape — preserves backward compatibility for partial /
   * pre-migration entries.
   */
  private async readPerEntryArrayLegacyOnly<T>(
    prefix: string,
    legacyBlobKey: string,
  ): Promise<T[]> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = await this.db.all(prefix);
    } catch (err) {
      this.log(`per-entry read failed for prefix "${prefix}": ${err instanceof Error ? err.message : String(err)}`);
      const legacy = await this.readProfileKeyJson<T[]>(legacyBlobKey);
      return legacy ?? [];
    }
    if (entries.size === 0) {
      const legacy = await this.readProfileKeyJson<T[]>(legacyBlobKey);
      return legacy ?? [];
    }
    const out: T[] = [];
    const sortedKeys = [...entries.keys()].sort();
    for (const key of sortedKeys) {
      const decoded = await this.decodePerEntryValue<unknown>(key);
      if (decoded === null) continue; // tombstone or corrupt
      // Skip new-shape (`uxf-1`) entries — they are owned by the
      // T.6.A `OutboxWriter` and read separately.
      if (
        decoded !== null &&
        typeof decoded === 'object' &&
        (decoded as Record<string, unknown>)._schemaVersion === 'uxf-1'
      ) {
        continue;
      }
      out.push(decoded as T);
    }
    return out;
  }

  /**
   * Wave G.7: decode a single per-entry value. Returns the entry
   * payload or `null` for a tombstoned / corrupt entry.
   *
   * Tombstone format: `{ tombstoned: true, deletedAt: number }`.
   * Live format: the entry value as JSON (same shape the legacy
   * single-blob array carried).
   */
  private async decodePerEntryValue<T>(key: string): Promise<T | null> {
    const raw = await this.readProfileKey(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'tombstoned' in parsed &&
        (parsed as { tombstoned: unknown }).tombstoned === true
      ) {
        return null; // tombstone — caller filters
      }
      return parsed as T;
    } catch {
      return null;
    }
  }

  /**
   * Read LOCAL-ONLY derived cache. Returns empty arrays if no cache
   * exists or no StorageProvider was injected. Callers that need a
   * populated cache should invoke `rebuildDerivedCache()` afterwards.
   *
   * Falls back to reading the pre-atomic legacy per-key layout on miss
   * so that caches written before the atomic migration continue to work
   * until their next rewrite.
   *
   * **Error rate-limiting**: at most one `storage:error` event is
   * emitted per call, even when multiple underlying reads fail.
   * Subscribers should not see an event flood when the cache is
   * globally corrupted.
   */
  private async readLocalDerivedCache(): Promise<{
    tombstones: TxfTombstone[];
    sent: TxfSentEntry[];
    history: HistoryRecord[];
  }> {
    if (!this.localCache) {
      return { tombstones: [], sent: [], history: [] };
    }
    const addr = this.getAddressId();

    // Rate-limit: swallow events during this call; emit at most one
    // aggregate event at the end if any read failed.
    const failedKeys: string[] = [];
    const readSilent = async <T>(key: string): Promise<T | null> => {
      try {
        const raw = await this.localCache!.get(key);
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch (err) {
        this.log(`Failed to read local cache "${key}": ${err instanceof Error ? err.message : String(err)}`);
        failedKeys.push(key);
        return null;
      }
    };

    let result: {
      tombstones: TxfTombstone[];
      sent: TxfSentEntry[];
      history: HistoryRecord[];
    };

    // Prefer the atomic single-key layout.
    const combined = await readSilent<{
      tombstones?: TxfTombstone[];
      sent?: TxfSentEntry[];
      history?: HistoryRecord[];
    }>(`deriver.${addr}.all`);
    if (combined) {
      result = {
        tombstones: combined.tombstones ?? [],
        sent: combined.sent ?? [],
        history: combined.history ?? [],
      };
    } else {
      // Legacy per-key layout — read all three and heal on next write.
      const [tombRaw, sentRaw, histRaw] = await Promise.all([
        readSilent<TxfTombstone[]>(`deriver.${addr}.tombstones`),
        readSilent<TxfSentEntry[]>(`deriver.${addr}.sent`),
        readSilent<HistoryRecord[]>(`deriver.${addr}.history`),
      ]);
      result = {
        tombstones: tombRaw ?? [],
        sent: sentRaw ?? [],
        history: histRaw ?? [],
      };
    }

    if (failedKeys.length > 0) {
      this.emitEvent({
        type: 'storage:error',
        timestamp: Date.now(),
        error: `Local derived cache read failures: ${failedKeys.join(', ')}`,
        code: 'LOCAL_CACHE_READ_FAILED',
        data: { failedKeys },
      });
    }

    return result;
  }

  /**
   * Read a JSON value from the local cache, returning null on miss or
   * parse failure. A parse failure is surfaced via `storage:error` so
   * it is not silently swallowed — corrupted cache data should be
   * visible to callers, not masked as "fresh device".
   *
   * This helper is used by non-derived-cache read paths that want the
   * per-call event semantics. The derived-cache read path in
   * `readLocalDerivedCache` uses its own rate-limited reader instead.
   */
  private async readLocalJson<T>(key: string): Promise<T | null> {
    if (!this.localCache) return null;
    try {
      const raw = await this.localCache.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Failed to read local cache "${key}": ${msg}`);
      this.emitEvent(this.buildErrorEvent('storage:error', err, 'LOCAL_CACHE_READ_FAILED'));
      return null;
    }
  }

  /**
   * Compose the per-address storage key for the pending-publish CID
   * marker. Per-address scoping is required because two derived
   * addresses on the same wallet have independent token pools and
   * independent pointer chains; sharing a single marker would let one
   * address's transient failure pollute another's retry state.
   */
  private getPendingPublishCidKey(): string | null {
    // Use the same resolver as every other per-address key: derive from
    // direct address when identity is set; otherwise fall back to the
    // explicit `options.addressId` or the literal 'default'. This
    // matches `getAddressId()` so the marker is scoped consistently
    // with the rest of the provider's persistence.
    const addr = this.getAddressId();
    return `${STORAGE_KEYS_GLOBAL.PROFILE_PENDING_PUBLISH_CID}_${addr}`;
  }

  /**
   * Persist the pending-publish CID marker to local cache. Called on
   * every mutation via `host.setPendingPublishCid`. Best-effort: a
   * failure leaves the in-memory state correct and the next mutation
   * retries. Crash-safety degrades to "best-effort"; an unwritten
   * marker means a process restart won't auto-retry, but the next
   * save-driven flush will re-derive the need to publish via the
   * baseline-staleness check.
   */
  private async persistPendingPublishCid(cid: string | null): Promise<void> {
    if (!this.localCache) return;
    const key = this.getPendingPublishCidKey();
    if (!key) return;
    if (cid === null) {
      await this.localCache.remove(key);
    } else {
      await this.localCache.set(key, cid);
    }
  }

  /**
   * Load any previously-persisted pending-publish CID marker into the
   * in-memory field on initialize. Called by lifecycle-manager during
   * `initialize()` so the next flush / poll can re-attempt the
   * pending publish without waiting for a fresh save.
   */
  private async restorePendingPublishCidFromCache(): Promise<void> {
    if (!this.localCache) return;
    const key = this.getPendingPublishCidKey();
    if (!key) return;
    try {
      const raw = await this.localCache.get(key);
      if (raw && raw.length > 0) {
        this.pendingPublishCid = raw;
        this.log(`Restored pending publish CID from cache: ${raw}`);
      }
    } catch (err) {
      this.log(
        `restorePendingPublishCidFromCache failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #313 — local snapshot cache (lazy-load)
  // ---------------------------------------------------------------------------

  /**
   * Issue #313 — atomic-write the lazy-load snapshot blob.
   *
   * Reads the live in-memory state (identity, pendingData ∪
   * lastLoadedData, knownBundleCids, lastDiscoveredPointerCid) and
   * persists it via {@link writeSnapshot} (temp-key + swap with
   * `setMany`). Best-effort: any failure is caught and surfaced via
   * `storage:error` (`PROFILE_SNAPSHOT_WRITE_FAILED`) without
   * propagating; the snapshot is a perf optimisation, not a correctness
   * gate.
   *
   * No-ops when:
   *   - no `localCache` is wired (provider constructed without cache);
   *   - identity is not yet bound (cold-start);
   *   - no in-memory state to snapshot (fresh wallet);
   *   - the network identifier is not configured (defensive).
   */
  private async writeLocalSnapshot(
    trigger: 'flush' | 'shutdown' | 'background-sync',
    options?: {
      readonly previousPointerVersion?: number | null;
      readonly durationMs?: number;
    },
  ): Promise<void> {
    if (!this.localCache) return;
    if (!this.identity) return;
    const addressId = this.getAddressId();
    if (!addressId || addressId === 'default') {
      // Defensive: pre-`setIdentity` writes route to the literal
      // 'default' addressId. A snapshot written under that ID would be
      // ambiguous across wallets; skip rather than poison the cache.
      return;
    }

    // Prefer the most recent buffered save (pendingData) over the last
    // loaded snapshot. If neither is set there's nothing meaningful to
    // persist.
    const data = this.pendingData ?? this.lastLoadedData;
    if (!data) return;

    const network = this.options?.config?.network ?? null;
    if (!network) return;

    // Pointer field: prefer the last-discovered aggregator pointer CID.
    // The aggregator pointer layer doesn't expose its on-chain version
    // directly to the token storage provider, so we pass null for
    // version in the basic case. The `previousPointerVersion` option
    // lets `background-sync` callers thread the prior version through
    // the refreshed event payload.
    const pointer: ProfileSnapshotPointer | null = this.lastDiscoveredPointerCid
      ? {
          version: 0,
          cid: this.lastDiscoveredPointerCid,
          ts: Date.now(),
        }
      : null;

    try {
      const ts = await writeSnapshot(this.localCache, {
        walletId: this.identity.chainPubkey,
        addressId,
        network,
        epoch: null, // OpLog epoch wiring is owned by issue #310's reset primitive
        pointer,
        bundleCids: Array.from(this.knownBundleCids),
        data,
      });
      this.emitEvent({
        type: 'profile:snapshot-refreshed',
        timestamp: ts,
        data: {
          trigger,
          from: options?.previousPointerVersion ?? null,
          to: pointer?.version ?? null,
          durationMs: options?.durationMs,
        },
      });
    } catch (err) {
      this.log(
        `writeLocalSnapshot (${trigger}) failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.emitEvent(
        this.buildErrorEvent(
          'storage:error',
          err,
          'PROFILE_SNAPSHOT_WRITE_FAILED',
        ),
      );
    }
  }

  /**
   * Issue #313 — read the lazy-load snapshot blob and SEED the
   * in-memory state from it.
   *
   * Called by `LifecycleManager.initialize()` BEFORE the OrbitDB
   * connect + bundle-index refresh. On a successful seed the wallet
   * has renderable state (`lastLoadedData`, `knownBundleCids`,
   * `lastDiscoveredPointerCid`) and `profile:snapshot-loaded` is
   * emitted; the lifecycle still runs the full initialize flow which
   * acts as a background sync (replication subscription, aggregator
   * pointer recovery, periodic-poll arming).
   *
   * On corruption the blob is removed and `profile:snapshot-corrupt`
   * is emitted; boot continues via the slow path.
   *
   * Returns true if a valid snapshot was applied; false otherwise.
   */
  private async readLocalSnapshot(): Promise<boolean> {
    if (!this.localCache) return false;
    if (!this.identity) return false;
    const addressId = this.getAddressId();
    if (!addressId || addressId === 'default') return false;

    let result: SnapshotReadResult;
    try {
      result = await readSnapshot(
        this.localCache,
        addressId,
        this.identity.chainPubkey,
      );
    } catch (err) {
      this.log(
        `readLocalSnapshot failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }

    switch (result.kind) {
      case 'absent':
        return false;
      case 'corrupt':
        this.log(
          `Local snapshot corrupt (${result.reason}); cleaning + falling through to OpLog walk`,
        );
        await clearSnapshot(this.localCache, addressId);
        this.emitEvent({
          type: 'profile:snapshot-corrupt',
          timestamp: Date.now(),
          data: {
            reason: result.reason,
            walletId: result.walletId,
          },
        });
        return false;
      case 'ok': {
        // Seed the in-memory state. We treat the snapshot as a
        // BASELINE — subsequent OrbitDB enumeration / aggregator
        // pointer recovery will overwrite these as newer state lands.
        this.lastLoadedData = result.blob.data;
        // Snapshot the seeded bundle-set so the runtime monotonicity
        // assertion has a non-null baseline. Treated as authoritative
        // until the post-init `refreshKnownBundles` either confirms or
        // replaces it.
        this.lastLoadedFromBundleCids = new Set(result.blob.bundleCids);
        // Prime knownBundleCids so cold-start recovery (`if
        // knownBundleCids.size === 0`) does not run when the snapshot
        // already had bundle refs — that recovery is precisely the
        // remote round-trip we want to defer to background.
        this.knownBundleCids = new Set(result.blob.bundleCids);
        if (result.blob.pointer) {
          this.lastDiscoveredPointerCid = result.blob.pointer.cid;
        }

        // Review fix — use the canonical `isTokenKey()` predicate
        // instead of the `_`-prefix-without-`__` filter. Pre-fix counted
        // every operational key (`_meta`, `_tombstones`, `_outbox`,
        // `_sent`, `_invalid`, `_history`, `_audit`, …) — inflating the
        // observed `tokenCount` by ~7-10 on a wallet with no real
        // tokens. The canonical helper excludes the reserved-keys list
        // and is already imported in this file (see line 75).
        const tokenCount = Object.keys(result.blob.data).filter(isTokenKey).length;

        this.emitEvent({
          type: 'profile:snapshot-loaded',
          timestamp: Date.now(),
          data: {
            ageMs: result.ageMs,
            tokenCount,
            bundleCount: result.blob.bundleCids.length,
            pointerVersion: result.blob.pointer?.version ?? null,
          },
        });
        this.log(
          `Loaded local snapshot: tokens=${tokenCount} bundles=${result.blob.bundleCids.length} ageMs=${result.ageMs}`,
        );
        return true;
      }
    }
  }

  /**
   * Refresh the merged-bundle baseline (`lastLoadedFromBundleCids`)
   * and the cached `lastLoadedData` by running a fresh `load()`.
   * Called by FlushScheduler when the runtime
   * `POINTER_MONOTONICITY_VIOLATION` check fires — repairing a stale
   * baseline so the next flush attempt passes the check.
   *
   * Returns true on success; false on internal load failure. The
   * caller (FlushScheduler / awaitNextFlush retry path) decides
   * whether to retry the flush or surface the original violation.
   *
   * IMPORTANT: this MUST NOT be called from inside `flushToIpfs`
   * directly because `load()` awaits the in-flight `flushPromise`,
   * which would deadlock. FlushScheduler invokes this via a
   * fire-and-forget pattern from the catch arm (which fires AFTER
   * the flush has already resolved/rejected), or the at-least-once
   * gate calls it explicitly between iterations.
   */
  private async refreshBaselineForMonotonicity(): Promise<boolean> {
    // Direct OrbitDB read — bypass `this.load()` because that method
    // has an early-return when `pendingData` is non-null. The
    // monotonicity violation re-queues `pendingData` in its catch
    // arm BEFORE this fire-and-forget refresh microtask fires, so a
    // naive `load()` call would observe non-null pendingData and
    // return the cached value WITHOUT touching OrbitDB — leaving
    // `lastLoadedFromBundleCids` stale and the next flush would hit
    // the same violation indefinitely.
    //
    // We don't need the full load() flow here — for the baseline
    // refresh we only need to update `lastLoadedFromBundleCids` so
    // the bundle-set check passes on the next flush. The token-set
    // check is satisfied by the in-memory token map being a superset
    // of whatever was previously loaded (NEVER-WIPE invariant
    // guarantees this).
    if (!this.initialized || !this.encryptionKey) return false;
    try {
      // Await any in-flight flush so the bundle-set we read includes
      // any concurrent addBundle writes. flushPromise observation is
      // safe here — we are NOT inside the flush body (this is a
      // microtask scheduled from the violation arm, which fires
      // AFTER the flush has rejected and the chain has settled).
      if (this.flushPromise) {
        try {
          await this.flushPromise;
        } catch {
          // Flush failures don't block the refresh — we still need
          // the current OrbitDB view.
        }
      }
      const activeBundles = await this.bundleIndex.listActiveBundles();
      this.lastLoadedFromBundleCids = new Set(activeBundles.keys());
      this.log(
        `refreshBaselineForMonotonicity: baseline updated to ${this.lastLoadedFromBundleCids.size} bundle(s)`,
      );
      return true;
    } catch (err) {
      this.log(
        `refreshBaselineForMonotonicity: listActiveBundles failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Rebuild the local derived cache from the token pool. Used when the
   * cache is empty on a fresh device or after corruption. Oracle-based
   * tombstone validation is deferred — this best-effort rebuild uses
   * archived tokens as the sole source.
   *
   * **Race guard**: concurrent load() calls are deduplicated — if a
   * rebuild is in flight, the second caller awaits the same Promise
   * rather than starting a second rebuild that could interleave writes.
   */
  private async rebuildDerivedCache(
    data: TxfStorageDataBase,
  ): Promise<{
    tombstones: TxfTombstone[];
    sent: TxfSentEntry[];
    history: HistoryRecord[];
  }> {
    if (!this.rebuildPromise) {
      this.rebuildPromise = this.rebuildDerivedCacheInner(data).finally(() => {
        this.rebuildPromise = null;
      });
    }
    // Clone per-awaiter so that a downstream consumer mutating its
    // arrays (e.g. PaymentsModule pushing a new tombstone) cannot
    // affect the arrays observed by a concurrent load().
    const shared = await this.rebuildPromise;
    return {
      tombstones: [...shared.tombstones],
      sent: [...shared.sent],
      history: [...shared.history],
    };
  }

  private async rebuildDerivedCacheInner(
    data: TxfStorageDataBase,
  ): Promise<{
    tombstones: TxfTombstone[];
    sent: TxfSentEntry[];
    history: HistoryRecord[];
  }> {
    const tombstones = deriveTombstonesFromArchived(data);
    const sent = deriveSentFromArchived(data);
    const history = deriveHistoryFromArchived(data, this.getAddressId());

    // Persist atomically for next load.
    if (this.localCache) {
      await this.writeLocalDerivedCache({ tombstones, sent, history });
    }

    return { tombstones, sent, history };
  }

  /**
   * Read the full operational state (synced + local-cached) for use
   * when building a TxfStorageDataBase on load.
   *
   * G4 — `tombstones` are read from BOTH the OrbitDB blob
   * (`${addr}.tombstones`, replicated, survives cold-start) AND the
   * local cache (`deriver.${addr}.all`, per-device). Both sources are
   * merged via union by primary-key (`tokenId`+`stateHash`) so a device
   * that has never written to OrbitDB yet still surfaces locally-known
   * tombstones, while a freshly-imported wallet pulls the boundary from
   * the synced source. Writes to OrbitDB happen in
   * `writeOrbitOperationalStatePerEntry`.
   */
  private async readOperationalState(): Promise<OperationalState> {
    const addr = this.getAddressId();
    const [orbit, local, orbitTombstones] = await Promise.all([
      this.readOrbitOperationalState(),
      this.readLocalDerivedCache(),
      this.readProfileKeyJson<TxfTombstone[]>(`${addr}.tombstones`),
    ]);

    // Merge OrbitDB-replicated tombstones with the local cache. Dedup
    // by composite key `${tokenId}:${stateHash}` so a single physical
    // tombstone observed from both sources does not double-count.
    const tombstoneMap = new Map<string, TxfTombstone>();
    for (const t of local.tombstones) {
      tombstoneMap.set(`${t.tokenId}:${t.stateHash}`, t);
    }
    if (orbitTombstones !== null) {
      for (const t of orbitTombstones) {
        const k = `${t.tokenId}:${t.stateHash}`;
        // Prefer the EARLIEST observed timestamp on a tie so cross-
        // replica merges converge — every replica has a deterministic
        // pick when the same tombstone is recorded with different
        // wall-clock timestamps.
        const prior = tombstoneMap.get(k);
        if (prior === undefined || t.timestamp < prior.timestamp) {
          tombstoneMap.set(k, t);
        }
      }
    }
    const mergedTombstones = Array.from(tombstoneMap.values());

    return {
      ...orbit,
      tombstones: mergedTombstones,
      sent: local.sent,
      history: local.history,
    };
  }

  // ===========================================================================
  // Private: OrbitDB key read/write helpers
  // ===========================================================================

  /**
   * Cached envelope-support probe. Lazy-initialised by `supportsEnvelopes()`.
   * Both `putEntry` and `getEntry` must exist together — same invariant as
   * ProfileStorageProvider. See that class's `supportsEnvelopes` for the
   * asymmetry-rejection rationale.
   */
  private _envelopesSupported: boolean | null = null;

  private supportsEnvelopes(): boolean {
    if (this._envelopesSupported !== null) return this._envelopesSupported;
    const hasPut = typeof this.db.putEntry === 'function';
    const hasGet = typeof this.db.getEntry === 'function';
    if (hasPut !== hasGet) {
      throw new Error(
        `ProfileDatabase adapter has asymmetric envelope support: putEntry=${hasPut}, ` +
          `getEntry=${hasGet}. Adapter must implement BOTH methods or NEITHER.`,
      );
    }
    this._envelopesSupported = hasPut;
    return this._envelopesSupported;
  }

  /**
   * Write a string value to an OrbitDB key, encrypting if enabled.
   *
   * **Routes through the OpLog envelope path** (`db.putEntry`) — same
   * format ProfileStorageProvider uses for `set()`. Both providers share
   * a single OrbitDB instance via the factory; if either side wrote raw
   * bytes via `db.put` while the other side read via `db.getEntry`, the
   * decode would fail with bogus errors like `tag not supported (21)` —
   * the dag-cbor decoder choking on encrypted-ciphertext bytes that
   * happen to start with byte values that look like CBOR tags. By
   * routing both providers through the envelope path, the OrbitDB key
   * is byte-compatible across consumers.
   */
  private async writeProfileKey(key: string, value: string): Promise<void> {
    const encoded = new TextEncoder().encode(value);
    const ciphertext = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, encoded)
      : encoded;
    if (this.supportsEnvelopes()) {
      // `cache_index` is in SYSTEM_ACTION_TYPES — must carry
      // `originated='system'` per assertOriginTagLocal (SPEC §10.2.3).
      // Route through the canonical helper rather than hardcoding the tag
      // so future entry-type additions stay in sync automatically.
      const envelope = buildLocalEntry({
        type: 'cache_index',
        originated: deriveOriginForType('cache_index'),
        payload: ciphertext,
      });
      await this.db.putEntry!(key, envelope);
    } else {
      await this.db.put(key, ciphertext);
    }
  }

  /**
   * Read a string value from an OrbitDB key, decrypting if needed.
   *
   * Symmetric with `writeProfileKey`: reads via the OpLog envelope path
   * (`db.getEntry`) so the same OrbitDB key is byte-compatible regardless
   * of which provider wrote it. See `writeProfileKey` for the cross-
   * provider decoding-collision rationale.
   *
   * Wave G.1 — deferred follow-up: emit a typed `storage:error` event
   * with `code: 'PROFILE_KEY_DECRYPT_FAILED'` so callers can route on
   * decrypt failures (likely indicates: encryption key changed,
   * key was rotated, or an attacker tampered with the ciphertext)
   * instead of treating them indistinguishably from "key not present".
   * The function still returns `null` to preserve the existing
   * caller contract (a missing-or-corrupt key triggers rebuild from
   * derived sources), but observability now distinguishes the two.
   */
  private async readProfileKey(key: string): Promise<string | null> {
    let ciphertext: Uint8Array | null = null;
    try {
      if (this.supportsEnvelopes()) {
        const envelope = (await this.db.getEntry!(key, {
          trustLocalClaim: true,
        })) as OpLogEntryEnvelope | null;
        ciphertext = envelope ? envelope.payload : null;
      } else {
        ciphertext = (await this.db.get(key)) as Uint8Array | null;
      }
    } catch (err) {
      this.log(`Failed to read OpLog entry at "${key}": ${err instanceof Error ? err.message : String(err)}`);
      // Surface decode failures explicitly — silent null on tag-21 / wrong-encoding
      // would have hidden the cross-provider write/read asymmetry that motivated this fix.
      this.emitEvent({
        ...this.buildErrorEvent('storage:error', err),
        code: 'PROFILE_KEY_READ_FAILED',
      });
      return null;
    }
    if (!ciphertext) return null;
    try {
      const decrypted = this.encryptionKey
        ? await decryptProfileValue(this.encryptionKey, ciphertext)
        : ciphertext;
      return new TextDecoder().decode(decrypted);
    } catch (err) {
      this.log(`Failed to decrypt key "${key}": ${err instanceof Error ? err.message : String(err)}`);
      const evt = this.buildErrorEvent('storage:error', err);
      this.emitEvent({ ...evt, code: 'PROFILE_KEY_DECRYPT_FAILED' });
      return null;
    }
  }

  /**
   * Read and parse a JSON value from an OrbitDB key.
   */
  private async readProfileKeyJson<T>(key: string): Promise<T | null> {
    const raw = await this.readProfileKey(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Profile recovery marker (OpLog auto-reset — Item #157)
  // ===========================================================================

  /**
   * Build the address-scoped OrbitDB key for the recovery marker. Kept
   * private so a future addressId rename / migration only changes one
   * call site.
   */
  private recoveryMarkerKey(): string {
    return `_profile_recovered:${this.getAddressId()}`;
  }

  /**
   * Persist a {@link ProfileRecoveryMarker} for this Profile.
   *
   * Idempotent. Writes through the same encrypted-OrbitDB path as other
   * profile metadata. Returns successfully if the write completes; on
   * failure the underlying error is surfaced to the caller — the
   * FlushScheduler treats marker-write failures as best-effort (the
   * in-memory recovery still applies for this session).
   *
   * Implements `ProfileTokenStorageHost.writeRecoveryMarker`.
   */
  async writeRecoveryMarker(marker: ProfileRecoveryMarker): Promise<void> {
    await this.writeProfileKey(
      this.recoveryMarkerKey(),
      JSON.stringify(marker),
    );
  }

  /**
   * Read the {@link ProfileRecoveryMarker} for this Profile, or null
   * when no recovery has ever happened on this device for this address.
   *
   * Implements `ProfileTokenStorageHost.readRecoveryMarker`.
   */
  async readRecoveryMarker(): Promise<ProfileRecoveryMarker | null> {
    const parsed = await this.readProfileKeyJson<ProfileRecoveryMarker>(
      this.recoveryMarkerKey(),
    );
    if (!parsed) return null;
    // Defensive shape check — JSON.parse of an unknown blob may yield
    // anything. We accept v=1 markers with walkBackClosed=true; anything
    // else is treated as absent so a caller's downstream "is the Profile
    // Recovered?" decision is not driven by a malformed marker.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.version !== 1 ||
      parsed.walkBackClosed !== true ||
      typeof parsed.recoveredAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  }

  /**
   * Public surface for "is this Profile Recovered?". Returns null when
   * no OpLog auto-reset has happened on this device. Non-null marker
   * indicates walk-back past `recoveredAt` is permanently impossible —
   * UI should show a persistent "Recovered" badge. Surface
   * `lostHeadCid` and `recoveredAt` in diagnostics.
   */
  async getRecoveryStatus(): Promise<ProfileRecoveryMarker | null> {
    return this.readRecoveryMarker();
  }

  // ===========================================================================
  // Private: Replication handler
  // ===========================================================================

  /**
   * Handle OrbitDB replication events.
   * Checks for new `tokens.bundle.*` keys and emits `storage:remote-updated`.
   *
   * Cross-device sync resilience (Fix 2): when new bundle CIDs appear,
   * schedule a no-data flush so we anchor our OWN aggregator pointer
   * to the merged state. Without this, if Device A originated a bundle
   * and goes offline before Device B re-flushes, a future Device C
   * joining via the aggregator pointer would only see A's CID — which
   * is fine if A's bundle covered the full state, but loses anything
   * B contributed via Nostr DMs (or any source the originator hadn't
   * captured). The flush body short-circuits if the merged-state CAR
   * matches a known anchor (idempotent).
   *
   * # Pointer monotonicity invariant (CRITICAL)
   *
   * The published pointer V_n MUST reference a CAR that contains every
   * token reachable from V_n-1's CARs. Concretely: the CAR pinned by a
   * no-data flush MUST cover the union of every active bundle in OrbitDB
   * — otherwise Device C, joining via the aggregator pointer alone, would
   * see only V_n's CAR and miss tokens that lived in V_n-1's bundles.
   *
   * That invariant relies on `lastLoadedData` reflecting the current
   * bundle union when the flush body runs. Two events fire on every
   * replication tick:
   *   - `scheduleFlushNoData()` here (debounced ~ flushDebounceMs).
   *   - `storage:remote-updated` event → PaymentsModule.sync → load()
   *     (debounced 500ms, then load() awaits the in-flight flush).
   *
   * If the flush timer fires BEFORE load() refreshes `lastLoadedData`,
   * the flush body builds its CAR from STALE merged state — silently
   * dropping the newly-discovered remote bundle's tokens from V_n.
   *
   * Mode A fix #2: AWAIT a fresh `load()` here before scheduling the
   * no-data flush. load() reads the active bundle index, fetches all
   * CARs, merges, and writes the union into `lastLoadedData` — which is
   * exactly the superset the flush body needs. With this in place the
   * flush body's `lastLoadedData` snapshot is by-construction a superset
   * of V_n-1's bundle union, eliminating the race at the source.
   *
   * Why fix #2 over fix #1 (defer-with-retry): the retry approach is
   * brittle (the load could complete just as the flush fires; cap
   * exhaustion drops the publish silently) and adds an unobservable
   * timing dependency. Awaiting load() here is structurally clean,
   * synchronously verifiable, and uses load()'s existing dedup machinery
   * (it awaits an in-flight flush; the flush awaits the in-flight load
   * via its debounce timer). No new state, no retry counters.
   */
  /**
   * Called by `LifecycleManager.runPointerPollOnce` after the periodic
   * aggregator-pointer poll discovers a NEW CID (one not in
   * `knownBundleCids`) and adds it via `bundleIndex.addBundle`.
   *
   * Distinct from `handleReplication` in two ways:
   *   1. The poll already confirmed novelty via the `knownBundleCids`
   *      check — no diff against `previousCids` is needed (and any
   *      diff would be a no-op since `addBundle` updated
   *      `knownBundleCids` BEFORE this callback fires).
   *   2. No recursive aggregator-poll trigger — we're already inside
   *      the poll loop.
   *
   * Responsibilities:
   *   - `load()` to merge the new CID's content into `lastLoadedData`
   *     (this updates `lastLoadedFromBundleCids` as a side effect,
   *     restoring the pointer-monotonicity invariant).
   *   - Schedule a no-data flush to re-anchor our pointer at the
   *     merged state. The flush body short-circuits if the projected
   *     CID equals the just-discovered pointer CID (no duplicate
   *     pin / aggregator submit cost on the receiver side).
   *
   * Failures here are best-effort — load failures are surfaced via
   * `storage:error` events independently; we proceed to schedule the
   * flush so the next save-driven flush gets a fresh baseline check.
   */
  private async onPollDiscoveredNewCid(): Promise<void> {
    // Issue #234/#239 follow-up — symmetric with `handleReplication`,
    // emit `storage:remote-updated` so the upstream PaymentsModule's
    // `subscribeToStorageEvents` listener wakes up and re-syncs its
    // in-memory token cache. Without this, the pointer-poll path
    // (the cross-device eventual-consistency fallback that fires when
    // OrbitDB gossipsub didn't deliver the replication event in real
    // time) refreshes the Profile's internal `lastLoadedData` but
    // PaymentsModule never learns about the new tokens — and so
    // AccountingModule never re-scans for new invoice tokens. Cross-
    // device invoice / self-state propagation depends on this fix.
    //
    // We await load() here (not fire-and-forget) so the event we emit
    // below carries an in-memory state that already reflects the
    // discovered bundles. `handleReplication` makes the same trade-
    // off for the same reason (pointer-monotonicity invariant, plus
    // PaymentsModule's debounced sync would otherwise race a stale
    // baseline).
    try {
      await this.load();
    } catch (err) {
      this.log(
        `onPollDiscoveredNewCid: load failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.emitEvent({
      type: 'storage:remote-updated',
      timestamp: Date.now(),
      data: { source: 'pointer-poll' },
    });
    this.flushScheduler.scheduleFlushNoData();
  }

  private async handleReplication(): Promise<void> {
    // Snapshot the bundle set BEFORE triggering the aggregator poll
    // and refreshing from OrbitDB. The poll may addBundle (which
    // mutates `knownBundleCids` synchronously); without taking the
    // snapshot first, the diff check at the bottom would falsely
    // report "no new bundles" and skip the load+flush — causing
    // POINTER_MONOTONICITY_VIOLATION on the next save-driven flush
    // when its BUNDLE-SET-CHECK sees the poll-added CID as unknown
    // (because we never loaded it).
    const previousCids = new Set(this.knownBundleCids);

    // Pubsub wake-up signal. The OrbitDB CRDT delivered a replication
    // event from a peer, but pubsub between devices is unreliable (NAT,
    // firewall, peer-discovery failures) — and the OrbitDB ref itself
    // is NOT the source of truth for the latest pointer version.
    //
    // Per the at-least-once design: the aggregator is the authoritative
    // source for the latest pointer version. Treat pubsub as a hint to
    // poll the aggregator NOW rather than waiting for the next periodic
    // [30s, 90s) cycle. This collapses the worst-case cross-device sync
    // latency from ~90s to the aggregator round-trip time (~1–2s on
    // healthy infra).
    //
    // Failure of the aggregator poll is non-fatal: the periodic poll
    // (worst case 90s) is still running as the safety net. We then
    // fall through to the OrbitDB-direct refresh below for the
    // opportunistic case where the aggregator poll hasn't caught up
    // yet (e.g. between the publisher's IPFS pin and aggregator
    // submit) but the OrbitDB ref already replicated.
    try {
      await this.lifecycleManager.triggerPointerPollNow();
    } catch (err) {
      this.log(
        `handleReplication: aggregator pointer poll failed (best-effort): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await this.bundleIndex.refreshKnownBundles();

      // Check if any new bundle CIDs appeared
      let hasNew = false;
      for (const cid of this.knownBundleCids) {
        if (!previousCids.has(cid)) {
          hasNew = true;
          break;
        }
      }

      if (hasNew) {
        this.emitEvent({
          type: 'storage:remote-updated',
          timestamp: Date.now(),
          data: { source: 'replication' },
        });

        // Mode A fix #2: refresh `lastLoadedData` BEFORE scheduling the
        // no-data flush. Without this await, the flush body could build
        // its CAR from stale merged state and publish a pointer V_n
        // whose CAR is NOT a superset of V_n-1's bundle union — silent
        // token loss across cross-device sync.
        //
        // load() is idempotent and best-effort: a failure here is logged
        // (the load() event surface emits storage:error on its own) and
        // we still proceed to scheduleFlushNoData() so that — even if the
        // load failed — the runtime invariant assertion in flushToIpfs()
        // catches a stale snapshot before the publish goes through.
        try {
          await this.load();
        } catch (err) {
          this.log(
            `handleReplication: pre-flush load failed (best-effort, ` +
              `runtime assertion will guard): ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Anchor our own pointer at the merged state. The flush body
        // computes the projected CID locally and short-circuits if it
        // already matches a known anchor (lastDiscoveredPointerCid or
        // an active OrbitDB bundle ref) — so a single-originator topology
        // (Device A publishes, Device B silently merges) pays no extra
        // IPFS pin or aggregator submit cost on the receiver side.
        this.flushScheduler.scheduleFlushNoData();
      }
    } catch (err) {
      this.log(`Replication check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ===========================================================================
  // Private: Utilities
  // ===========================================================================

  /**
   * Get the address ID for per-address key scoping.
   * Returns the computed short address ID (DIRECT_xxxxxx_yyyyyy format),
   * falling back to the options addressId or 'default'.
   */
  private getAddressId(): string {
    return this.addressId ?? this.options?.addressId ?? 'default';
  }

  /**
   * Extract token IDs from a TxfStorageDataBase for diffing.
   * Includes standard tokens (`_`-prefixed), archived (`archived-`), and forked (`_forked_`).
   */
  private extractTokenIds(data: TxfStorageDataBase): string[] {
    const ids: string[] = [];
    const operationalKeys = new Set([
      '_meta', '_tombstones', '_outbox', '_sent',
      '_invalid', '_history', '_mintOutbox', '_invalidatedNametags',
    ]);

    for (const key of Object.keys(data)) {
      if (key.startsWith('_') && !operationalKeys.has(key)) {
        ids.push(key);
      } else if (key.startsWith('archived-')) {
        ids.push(key);
      }
    }
    return ids;
  }

  private emitEvent(event: StorageEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch {
        // Don't let event handler errors break the provider
      }
    }
  }

  /**
   * Issue #311 — narrow public emit hook for events sourced OUTSIDE
   * the token-storage provider's own write/read paths. Used by the
   * factory to route `profile:storage-persistence` and
   * `profile:critical-block-evicted` events (sourced from the
   * OrbitDbAdapter / ProfileStorageProvider boundary) into the
   * provider's `onEvent` surface so consumers have a single
   * subscription point.
   *
   * Restricted to the two `profile:*` event types added by issue #311
   * to prevent misuse — every other event class has a canonical
   * emitter site inside this provider. Unknown types are silently
   * dropped (defense in depth).
   */
  emitExternalProfileEvent(event: StorageEvent): void {
    if (
      event.type !== 'profile:storage-persistence' &&
      event.type !== 'profile:critical-block-evicted'
    ) {
      return;
    }
    this.emitEvent(event);
  }

  /**
   * Steelman³⁸ warning: build an event payload that preserves typed
   * error codes (AggregatorPointerError.code, ProfileError.code,
   * UxfError.code, SphereError.code) instead of flattening to a string.
   * Consumers can switch on `event.code` to drive UI state.
   */
  private buildErrorEvent(
    type: 'storage:error' | 'sync:error' | 'storage:pointer-version-skipped-unfetchable',
    err: unknown,
    overrideCode?: string,
  ): StorageEvent {
    const error = err instanceof Error ? err.message : String(err);
    let code = overrideCode;
    if (!code && typeof err === 'object' && err !== null) {
      const codeField = (err as { code?: unknown }).code;
      if (typeof codeField === 'string') code = codeField;
    }
    return {
      type,
      timestamp: Date.now(),
      error,
      code,
      cause: err,
    };
  }

  private log(message: string): void {
    logger.debug('Profile-TokenStorage', message);
  }
}

// =============================================================================
// Utility
// =============================================================================

/**
 * Steelman⁴³ critical helper: merge two arrays of records by a primary
 * key field (idempotent union — local entries override remote on
 * conflict). Used for OrbitDB op-state writes to prevent cross-process
 * LWW data loss when two instances flush concurrently.
 */
function mergeByPrimaryKey<T>(remote: T[], local: T[], keyField: string): T[] {
  const byKey = new Map<unknown, T>();
  for (const item of remote) {
    if (typeof item === 'object' && item !== null) {
      const key = (item as Record<string, unknown>)[keyField];
      if (key !== undefined) byKey.set(key, item);
    }
  }
  // Local entries override on conflict (this instance's view is more
  // recent for a key it touched in the same flush).
  for (const item of local) {
    if (typeof item === 'object' && item !== null) {
      const key = (item as Record<string, unknown>)[keyField];
      if (key !== undefined) byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}
