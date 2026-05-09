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
  StorageEventCallback,
  StorageEvent,
  HistoryRecord,
  StorageProvider,
} from '../storage/storage-provider.js';
import {
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
import { fetchFromIpfs } from './ipfs-client.js';
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
    this.flushScheduler = new FlushScheduler(host, this.bundleIndex, this.lifecycleManager);
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
      // Flush coordination
      flushToIpfs: () => this.flushScheduler.flushToIpfs(),
      // TXF adapter helpers
      extractTokensFromTxfData: (data) => this.extractTokensFromTxfData(data),
      extractOperationalState: (data) => this.extractOperationalState(data),
      // Operational state persistence
      writeOrbitOperationalState: (opState) => this.writeOrbitOperationalState(opState),
      writeLocalDerivedCache: (opState) => this.writeLocalDerivedCache(opState),
    };
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

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<boolean> {
    return this.lifecycleManager.initialize(() => this.handleReplication());
  }

  async shutdown(): Promise<void> {
    await this.lifecycleManager.shutdown();
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
        // No bundles -- return empty data
        const emptyData = this.buildEmptyTxfData();
        this.lastLoadedData = emptyData;
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
      //    internally calls `mergeInstanceChains()` — that function already
      //    implements the "longest-chain or sibling-preservation" rules
      //    (see uxf/instance-chain.ts Decision 6).
      //
      //    Oracle-based conflict resolution — turning a structural
      //    divergence into {valid, conflicting, invalid} status — is
      //    handled by token-manifest derivation (task #27). This JOIN is
      //    the structural prerequisite.
      //
      //    CARs on IPFS are unencrypted; confidentiality comes from the
      //    OrbitDB KV layer that holds the bundle refs. Unencrypted CARs
      //    enable cross-user content-addressed dedup (see §10.2).
      for (const [cid] of activeBundles) {
        try {
          const carBytes = await fetchFromIpfs(this._ipfsGateways, cid);
          const pkg = await UxfPackage.fromCar(carBytes);
          mergedPkg.merge(pkg);
        } catch (err) {
          this.log(`Failed to load bundle ${cid}: ${err instanceof Error ? err.message : String(err)}`);
          // Continue with remaining bundles -- partial load is better than failure
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
      // Refresh bundle list from OrbitDB
      const previousCids = new Set(this.knownBundleCids);
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
  // Private: Replication handler
  // ===========================================================================

  /**
   * Handle OrbitDB replication events.
   * Checks for new `tokens.bundle.*` keys and emits `storage:remote-updated`.
   */
  private async handleReplication(): Promise<void> {
    try {
      const previousCids = new Set(this.knownBundleCids);
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
   * Steelman³⁸ warning: build an event payload that preserves typed
   * error codes (AggregatorPointerError.code, ProfileError.code,
   * UxfError.code, SphereError.code) instead of flattening to a string.
   * Consumers can switch on `event.code` to drive UI state.
   */
  private buildErrorEvent(
    type: 'storage:error' | 'sync:error',
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
