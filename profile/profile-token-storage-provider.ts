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
 * @see PROFILE-ARCHITECTURE.md Section 2.3 (Multi-Bundle Model)
 * @see PROFILE-ARCHITECTURE.md Section 5.3 (Token Storage Flow)
 * @module profile/profile-token-storage-provider
 */

import { logger } from '../core/logger.js';
import { hexToBytes } from '../core/hex.js';
import type { ProviderStatus, FullIdentity } from '../types/index.js';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  TxfMeta,
  TxfTombstone,
  TxfOutboxEntry,
  TxfSentEntry,
  TxfInvalidEntry,
  SaveResult,
  LoadResult,
  SyncResult,
  StorageEventCallback,
  StorageEvent,
  HistoryRecord,
  StorageProvider,
} from '../storage/storage-provider.js';
import {
  type UxfBundleRef,
  type ProfileTokenStorageProviderOptions,
  computeAddressId,
} from './types.js';
import type { ProfileDatabase } from './orbitdb-adapter.js';
import { ProfileError } from './errors.js';
import {
  encryptProfileValue,
  decryptProfileValue,
  deriveProfileEncryptionKey,
} from './encryption.js';
import { pinToIpfs, fetchFromIpfs } from './ipfs-client.js';
import {
  deriveSentFromArchived,
  deriveHistoryFromArchived,
  deriveTombstonesFromArchived,
} from './deriver.js';
import {
  deriveStructuralManifest,
  type TokenManifest,
} from './token-manifest.js';
import { buildLocalEntry, decodeEntry } from './oplog-entry.js';
import { CID } from 'multiformats/cid';

/**
 * Pointer-layer error codes that indicate a permanent integrity /
 * configuration problem. These MUST be surfaced to the user rather
 * than silently swallowed — either the wallet is poisoned (marker
 * corrupt, streak of corrupt versions), the aggregator rotated its
 * trust base (SDK upgrade needed), the wallet was rejected (v-burn
 * that will never succeed again), or we hit an integrity-class
 * failure (untrusted proof, security origin mismatch).
 *
 * Unknown / missing codes default to TRANSIENT (see
 * `isPermanentPointerError`) — "keep running and retry" is safer
 * than "break the wallet" when classification is ambiguous.
 */
const PERMANENT_POINTER_ERROR_CODES: ReadonlySet<string> = new Set([
  'AGGREGATOR_POINTER_UNREACHABLE_RECOVERY_BLOCKED',
  'AGGREGATOR_POINTER_REJECTED',
  'AGGREGATOR_POINTER_UNTRUSTED_PROOF',
  'AGGREGATOR_POINTER_TRUST_BASE_STALE',
  'AGGREGATOR_POINTER_MARKER_CORRUPT',
  'AGGREGATOR_POINTER_CORRUPT_STREAK',
  'AGGREGATOR_POINTER_AGGREGATOR_REJECTED',
  'SECURITY_ORIGIN_MISMATCH',
  'AGGREGATOR_POINTER_CAPABILITY_DENIED',
  'AGGREGATOR_POINTER_UNSUPPORTED_RUNTIME',
  'AGGREGATOR_POINTER_PROTOCOL_ERROR',
]);

// =============================================================================
// Constants
// =============================================================================

/** OrbitDB key prefix for UXF bundle references. */
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

/** Default write-behind debounce interval in milliseconds. */
const DEFAULT_FLUSH_DEBOUNCE_MS = 2000;

/** Threshold for logging a consolidation warning. */
const CONSOLIDATION_WARNING_THRESHOLD = 3;

// =============================================================================
// Operational State Shape
// =============================================================================

/**
 * Operational state extracted from TxfStorageDataBase.
 * These fields are stored as separate OrbitDB keys rather than
 * inside the UXF bundle.
 */
interface OperationalState {
  tombstones: TxfTombstone[];
  outbox: TxfOutboxEntry[];
  sent: TxfSentEntry[];
  invalid: TxfInvalidEntry[];
  history: HistoryRecord[];
  mintOutbox: unknown[];
  invalidatedNametags: unknown[];
}

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
    this.identity = identity;

    // Derive encryption key from the private key if not already provided
    if (!this.encryptionKey) {
      try {
        const privKeyBytes = hexToBytes(identity.privateKey);
        this.encryptionKey = deriveProfileEncryptionKey(privKeyBytes);
      } catch (err) {
        this.log(`Failed to derive encryption key: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Compute the short address ID for per-address key scoping
    if (identity.directAddress) {
      this.addressId = computeAddressId(identity.directAddress);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    if (!this.identity) {
      this.log('Cannot initialize: no identity set');
      return false;
    }

    this.status = 'connecting';

    try {
      // Ensure OrbitDB is connected
      if (!this.db.isConnected()) {
        this.log('OrbitDB not connected; skipping bundle load until connected');
        this.status = 'connected';
        this.initialized = true;
        return true;
      }

      // Load known bundle CIDs from OrbitDB
      await this.refreshKnownBundles();

      // COLD-START RECOVERY: if OrbitDB has no bundles locally, this
      // is likely a fresh device (wallet re-imported from mnemonic
      // after a wipe). Rebuild the active bundle set without waiting
      // for a live peer.
      //
      // Priority (T-D6 / T-D6b):
      //   (1) aggregator pointer layer — authoritative source of
      //       truth. On a successful recoverLatest the CID is
      //       trust-verified via inclusion proof + CAR content-
      //       address verify. Lands as a new bundle ref that the
      //       next JOIN pass assembles.
      //   (2) one-shot legacy IPNS → pointer migration. Only fires
      //       if the local cache carries a legacy `profile.ipns.
      //       sequence` key and no `profile.pointer.migration.done`
      //       marker. Reads the legacy IPNS snapshot ONE TIME,
      //       hydrates the bundle set into OrbitDB, and stamps the
      //       marker so subsequent loads go straight to the pointer
      //       path. New wallets (no IPNS history) skip this entirely.
      if (this.knownBundleCids.size === 0) {
        const pointerRecovered = await this.recoverFromAggregatorPointerBestEffort();
        if (!pointerRecovered) {
          await this.runLegacyIpnsMigrationBestEffort();
        }
      }

      // Subscribe to OrbitDB replication events for real-time sync
      this.replicationUnsub = this.db.onReplication(() => {
        this.handleReplication().catch((err) => {
          this.log(`Replication handler error: ${err instanceof Error ? err.message : String(err)}`);
        });
      });

      this.status = 'connected';
      this.initialized = true;
      this.log(`Initialized with ${this.knownBundleCids.size} known bundle(s)`);
      return true;
    } catch (err) {
      this.status = 'error';
      this.log(`Initialization failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    // Cancel debounce timer
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Steelman³⁸ warning: AWAIT any in-flight flush BEFORE issuing a
    // direct flushToIpfs(). The previous order spawned two concurrent
    // flushes; lastPinnedCid interleaved across them and the retry-cache
    // invariant ("pinned CID matches currently flushed bytes") was
    // violated.
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch {
        // best-effort
      }
    }

    // Flush any pending writes (after the in-flight flush settled)
    if (this.pendingData) {
      try {
        await this.flushToIpfs();
      } catch (err) {
        this.log(`Shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Steelman³⁸ warning: unsubscribe from replication BEFORE we null
    // out the cache, so any in-flight onReplication handler that was
    // about to read this.lastLoadedData / lastTokenManifest sees its
    // pre-shutdown value rather than null mid-method.
    if (this.replicationUnsub) {
      this.replicationUnsub();
      this.replicationUnsub = null;
    }

    // Steelman³⁸ warning: drop in-memory snapshots so a consumer that
    // retains a reference to this provider doesn't pin the entire
    // token graph forever.  Mirrors what `clear()` does (line 700).
    this.lastLoadedData = null;
    this.lastTokenManifest = null;

    this.initialized = false;
    this.status = 'disconnected';
    this.isShuttingDown = false;
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

    // Any new save() invalidates the lastPinnedCid retry cache
    // unconditionally. A reference-identity check is insufficient: a
    // caller that mutates the same object in place and re-calls save()
    // would otherwise leave a stale CID pinned. The only safe policy
    // is "fresh save → re-pin from scratch". The tiny cost (one extra
    // pin on legitimate retries with identical content) is worth the
    // correctness guarantee that the pinned CID always matches the
    // currently flushed bytes.
    this.lastPinnedCid = null;
    this.pendingData = data;
    this.lastLoadedData = data;

    // Schedule debounced flush
    this.scheduleFlush();

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
      const activeBundles = await this.listActiveBundles();

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
      await this.refreshKnownBundles();

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

      if (newCids.length === 0 && removedCids.length === 0) {
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

      // Full reload to get merged result
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
  // History operations
  // ---------------------------------------------------------------------------

  async addHistoryEntry(entry: HistoryRecord): Promise<void> {
    const entries = await this.getHistoryEntries();

    // Upsert by dedupKey
    const existingIdx = entries.findIndex((e) => e.dedupKey === entry.dedupKey);
    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp - a.timestamp);

    await this.writeProfileKey(
      `${this.getAddressId()}.transactionHistory`,
      JSON.stringify(entries),
    );
  }

  async getHistoryEntries(): Promise<HistoryRecord[]> {
    const raw = await this.readProfileKey(`${this.getAddressId()}.transactionHistory`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async hasHistoryEntry(dedupKey: string): Promise<boolean> {
    const entries = await this.getHistoryEntries();
    return entries.some((e) => e.dedupKey === dedupKey);
  }

  async clearHistory(): Promise<void> {
    try {
      await this.db.del(`${this.getAddressId()}.transactionHistory`);
    } catch {
      // best-effort
    }
  }

  async importHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    const existing = await this.getHistoryEntries();
    const existingKeys = new Set(existing.map((e) => e.dedupKey));
    let imported = 0;

    for (const entry of entries) {
      if (!existingKeys.has(entry.dedupKey)) {
        existing.push(entry);
        existingKeys.add(entry.dedupKey);
        imported++;
      }
    }

    if (imported > 0) {
      existing.sort((a, b) => b.timestamp - a.timestamp);
      await this.writeProfileKey(
        `${this.getAddressId()}.transactionHistory`,
        JSON.stringify(existing),
      );
    }

    return imported;
  }

  // ===========================================================================
  // Private: Write-behind buffer
  // ===========================================================================

  private scheduleFlush(): void {
    if (this.isShuttingDown) return;

    // Clear any existing timer
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }

    // Set new debounced timer
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Steelman³⁸ warning: identity-check the finally clear so an older
      // flush settling AFTER a newer one was scheduled doesn't clobber
      // the in-flight `flushPromise`. Without the identity check, a
      // subsequent load() reading `if (this.flushPromise)` would see
      // null while the new flush is still running, and read a stale
      // snapshot.
      const myFlush: Promise<void> = this.flushToIpfs()
        .catch((err) => {
          this.log(`Flush failed: ${err instanceof Error ? err.message : String(err)}`);
          this.emitEvent(this.buildErrorEvent('storage:error', err));
        })
        .finally(() => {
          if (this.flushPromise === myFlush) {
            this.flushPromise = null;
          }
        });
      this.flushPromise = myFlush;
    }, this.flushDebounceMs);
  }

  private async flushToIpfs(): Promise<void> {
    const data = this.pendingData;
    if (!data || !this.encryptionKey) return;

    // Snapshot and clear pending to avoid re-flushing the same data.
    //
    // Steelman⁴³ critical: identity-check before clearing. A concurrent
    // save() between the capture above and this clear would set
    // this.pendingData to NEWER data; an unconditional `= null` would
    // clobber the new save and permanently lose its content. With the
    // identity check, the new pendingData stays for the next flush.
    if (this.pendingData === data) {
      this.pendingData = null;
    }

    try {
      // 1. Extract tokens and operational state
      const tokens = this.extractTokensFromTxfData(data);
      const opState = this.extractOperationalState(data);

      // 2. Build UXF package
      const { UxfPackage } = await import('../uxf/UxfPackage.js');
      const pkg = UxfPackage.create();

      // Ingest all token objects
      const tokenValues = [...tokens.values()];
      if (tokenValues.length > 0) {
        pkg.ingestAll(tokenValues);
      }

      // 3. Export to CAR (unencrypted — see class doc)
      const carBytes = await pkg.toCar();

      // 4. Pin to IPFS (reuse last pinned CID on retry to avoid duplicate pins)
      let cid: string;
      if (this.lastPinnedCid) {
        cid = this.lastPinnedCid;
      } else {
        cid = await pinToIpfs(this._ipfsGateways, carBytes);
        this.lastPinnedCid = cid;
      }

      // 6. Write bundle ref to OrbitDB
      const bundleRef: UxfBundleRef = {
        cid,
        status: 'active',
        createdAt: Math.floor(Date.now() / 1000),
        tokenCount: tokens.size,
      };
      await this.addBundle(cid, bundleRef);

      // 7. Write operational state:
      //    - synced portion to OrbitDB (outbox, mintOutbox, etc.)
      //    - derived portion to local cache (tombstones, sent, history)
      // The derived-cache write is best-effort. A failure is surfaced
      // via storage:error AND via the boolean return; we log here so
      // flush telemetry records it alongside the CID.
      await this.writeOrbitOperationalState(opState);
      const derivedOk = await this.writeLocalDerivedCache(opState);
      if (!derivedOk) {
        this.log(`Derived-cache write failed; next load will rebuild from pool`);
      }

      // Clear the pinned CID tracker after successful OrbitDB write
      this.lastPinnedCid = null;

      // 8. Check consolidation
      // Steelman³⁸ warning: actually invoke the consolidation engine
      // (it already exists at profile/consolidation.ts) instead of
      // logging "deferred to Phase 2" forever. Bundle count grew
      // unboundedly across daemon lifetime with the previous warn-only
      // behavior; load latency degraded O(1)→O(N).
      //
      // Best-effort: failures are caught and logged but do not block
      // the flush. The consolidation engine has its own concurrent-
      // guard (consolidation.pending key) so multi-device races are
      // safe.
      //
      // Steelman⁴⁰ warning: SKIP consolidation when shutdown is in
      // progress. Consolidation does multiple unbounded IPFS round-trips
      // (fetch + pin) which would block shutdown for minutes per N
      // bundles. Without this gate, F.43's shutdown-await-flushPromise
      // could hold up to (N × per-gateway timeout) before completing.
      if (this.isShuttingDown) {
        this.log('Consolidation skipped: shutdown in progress');
      } else if (await this.shouldConsolidate()) {
        try {
          const { ConsolidationEngine } = await import('./consolidation.js');
          const engine = new ConsolidationEngine(
            this.db,
            this.encryptionKey!,
            this._ipfsGateways,
          );
          if (!(await engine.isConsolidationInProgress())) {
            const result = await engine.consolidate();
            if (result.consolidated) {
              this.log(
                `Consolidation: merged ${result.sourceBundleCount} bundles → ${result.consolidatedCid ?? 'n/a'}`,
              );
            } else {
              this.log('Consolidation skipped (engine no-op)');
            }
          } else {
            this.log('Consolidation skipped: another device is in progress');
          }
        } catch (err) {
          // Best-effort: do not fail the flush on consolidation error.
          this.log(
            `Consolidation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 9. Publish to the pointer layer for cold-start recovery.
      //    Best-effort: the CAR is already pinned and the OrbitDB
      //    bundle ref is already written, so a failed publish only
      //    delays cold-start recovery for this flush — subsequent
      //    flushes retry. IPNS is no longer published (T-D6c) —
      //    the one-shot migration reader is the only remaining
      //    legacy touchpoint and it's read-only.
      await this.publishAggregatorPointerBestEffort(cid);

      this.emitEvent({
        type: 'storage:saved',
        timestamp: Date.now(),
        data: { cid, tokenCount: tokens.size },
      });
    } catch (err) {
      // On failure, re-queue the data so it is not lost
      if (!this.pendingData) {
        this.pendingData = data;
      }
      throw err;
    }
  }

  // ===========================================================================
  // Private: Bundle management (WU-P07 inlined)
  // ===========================================================================

  /**
   * List all bundle refs from OrbitDB, filtered to active status.
   */
  private async listActiveBundles(): Promise<Map<string, UxfBundleRef>> {
    const allBundles = await this.listBundles();
    const active = new Map<string, UxfBundleRef>();
    for (const [cid, ref] of allBundles) {
      if (ref.status === 'active') {
        active.set(cid, ref);
      }
    }
    return active;
  }

  /**
   * List all bundle refs from OrbitDB (all statuses).
   *
   * Bundle refs are written as system-stamped envelopes by
   * `addBundle` (T-D11). Legacy wallets may have raw-bytes entries
   * (pre-envelope writes) — we detect those by attempting the
   * structured decode first, falling back to treating the stored
   * bytes as the encrypted payload directly. On the fallback path
   * the entry acts as a `v=0` legacy entry under the oplog-schema
   * contract (synthetic `originated='system'` at read time via the
   * adapter's legacy-wrapping).
   */
  private async listBundles(): Promise<Map<string, UxfBundleRef>> {
    const rawEntries = await this.db.all(BUNDLE_KEY_PREFIX);
    const result = new Map<string, UxfBundleRef>();

    // Steelman⁴⁰ warning: aggregate corrupt-bundle events into a single
    // emit so wholesale corruption (key drift after restore-from-backup,
    // etc.) doesn't flood the consumer with N events for N bundles.
    const corruptCids: string[] = [];
    let firstCorruptError: unknown = null;

    for (const [key, value] of rawEntries) {
      const cid = key.slice(BUNDLE_KEY_PREFIX.length);
      try {
        // Extract the encrypted payload from either a stamped
        // envelope (new path, T-D11) or the raw bytes (legacy). A
        // successful envelope decode whose `v===1` wins; anything
        // else — decode throws, or `v===0` legacy sentinel — falls
        // through to treating `value` as the raw encrypted payload.
        let encryptedPayload: Uint8Array = value;
        try {
          const envelope = decodeEntry(value);
          if (envelope.v === 1) {
            encryptedPayload = envelope.payload;
          }
        } catch {
          // Not an envelope — raw-bytes legacy write. Use `value`
          // directly.
        }

        const decrypted = this.encryptionKey
          ? await decryptProfileValue(this.encryptionKey, encryptedPayload)
          : encryptedPayload;
        const ref = JSON.parse(new TextDecoder().decode(decrypted)) as UxfBundleRef;
        result.set(cid, ref);
      } catch (err) {
        // Steelman³⁸/⁴⁰: log per-bundle but AGGREGATE the events into a
        // single emit at the end of the loop so wholesale corruption
        // doesn't flood the UI with N banners for N bundles.
        this.log(`Failed to deserialize bundle ref for ${cid}: ${err instanceof Error ? err.message : String(err)}`);
        corruptCids.push(cid);
        if (firstCorruptError === null) firstCorruptError = err;
      }
    }

    if (corruptCids.length > 0) {
      const ev = this.buildErrorEvent('storage:error', firstCorruptError, 'CID_REF_CORRUPT');
      // Steelman⁴¹ note: cap the inline-listed CIDs at 100 entries.
      // For wholesale corruption (1000+ bundles) the unbounded list
      // could bloat downstream loggers and JSON serialization. The
      // `count` field is always exact; `truncated` flags when the
      // list was clipped.
      const CORRUPT_CIDS_PREVIEW_CAP = 100;
      const truncated = corruptCids.length > CORRUPT_CIDS_PREVIEW_CAP;
      this.emitEvent({
        ...ev,
        data: {
          corruptCids: truncated ? corruptCids.slice(0, CORRUPT_CIDS_PREVIEW_CAP) : corruptCids,
          truncated,
          count: corruptCids.length,
        },
      });
    }

    return result;
  }

  /**
   * Write a bundle ref to OrbitDB under a system-stamped envelope
   * (T-D11 W11). Bundle events are system-generated cache-index
   * writes; they are NOT user-actions (they reflect a token-pool
   * flush produced by the wallet itself, not a user intent to
   * commit tokens). Stamping `originated='system'` means peers
   * replicating the ref see it as a replicated system event after
   * the orbitdb-adapter's read-time downgrade, not a forged user
   * action.
   *
   * If the underlying adapter lacks `putEntry` (very old code paths
   * or test stubs), fall back to `db.put` of raw encrypted bytes —
   * readers auto-wrap raw writes as legacy entries (`v=0`, synthetic
   * `type='cache_index'`, `originated='system'`), so the semantic
   * outcome is identical and replication remains safe.
   */
  private async addBundle(cid: string, ref: UxfBundleRef): Promise<void> {
    const serialized = new TextEncoder().encode(JSON.stringify(ref));
    const encryptedPayload = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, serialized)
      : serialized;

    const key = BUNDLE_KEY_PREFIX + cid;
    if (typeof this.db.putEntry === 'function') {
      const envelope = buildLocalEntry({
        type: 'cache_index',
        originated: 'system',
        payload: encryptedPayload,
      });
      await this.db.putEntry(key, envelope);
    } else {
      await this.db.put(key, encryptedPayload);
      // Mark locally-authored on the fallback path too, so any
      // downstream `getEntry` consumer that consults
      // `localAuthoredKeys` sees this write as local rather than
      // force-downgrading it to 'replicated'. Mirrors the
      // convention in profile/profile-storage-provider.ts:writeEnvelope.
      const markHook = (this.db as { markLocallyAuthored?: (k: string) => void }).markLocallyAuthored;
      if (typeof markHook === 'function') {
        markHook.call(this.db, key);
      }
    }
    this.knownBundleCids.add(cid);
  }

  /**
   * Check if the number of active bundles exceeds the consolidation threshold.
   * Logs a warning but does NOT perform consolidation (deferred to Phase 2).
   */
  private async shouldConsolidate(): Promise<boolean> {
    const active = await this.listActiveBundles();
    return active.size > CONSOLIDATION_WARNING_THRESHOLD;
  }

  /**
   * Refresh the local set of known bundle CIDs from OrbitDB.
   */
  private async refreshKnownBundles(): Promise<void> {
    const bundles = await this.listActiveBundles();
    this.knownBundleCids = new Set(bundles.keys());
  }

  // ===========================================================================
  // Private: aggregator pointer layer (cold-start recovery — primary channel)
  // ===========================================================================

  /**
   * Classify a pointer-layer error as TRANSIENT (retry on next flush
   * / cold-start, no user action needed) or PERMANENT (user / operator
   * must intervene — wallet state is poisoned or aggregator rotation
   * requires SDK update). Used to decide whether to silently swallow
   * the error or surface it via a `storage:error` event.
   *
   * Non-exhaustive — unknown codes default to TRANSIENT on the premise
   * that "keep running and retry" is safer than "break the wallet".
   * Add to PERMANENT_POINTER_ERROR_CODES below when a new permanent
   * failure mode is introduced.
   */
  private isPermanentPointerError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string') return false;
    return PERMANENT_POINTER_ERROR_CODES.has(code);
  }

  /**
   * Publish the just-flushed CID to the aggregator pointer layer.
   *
   * TRANSIENT failures (NETWORK_ERROR, CAR_UNAVAILABLE, PUBLISH_BUSY,
   * CONFLICT, RETRY_EXHAUSTED, CAR_*_TIMEOUT, CAR_TOO_LARGE,
   * CAR_UNEXPECTED_ENCODING) are silently logged — the CAR is already
   * pinned and the OrbitDB bundle ref is already written, so the
   * next flush can retry the publish.
   *
   * PERMANENT failures (UNREACHABLE_RECOVERY_BLOCKED, REJECTED,
   * UNTRUSTED_PROOF, TRUST_BASE_STALE, MARKER_CORRUPT, CORRUPT_STREAK,
   * SECURITY_ORIGIN_MISMATCH, CAPABILITY_DENIED, UNSUPPORTED_RUNTIME,
   * PROTOCOL_ERROR, AGGREGATOR_REJECTED) are surfaced via a
   * `storage:error` event with the error code in the payload. The UI
   * can then prompt the user (upgrade SDK on TRUST_BASE_STALE, enter
   * recovery on UNREACHABLE_RECOVERY_BLOCKED, etc.). Without this
   * surface, permanent failures are retried forever on every flush —
   * accumulating CAR pins (cost) and OrbitDB refs (bloat) with no
   * anchor.
   *
   * Semantic note: `cidProducer` returns the SAME CID on retry — we
   * are anchoring THIS flush's bundle. If a publish-conflict triggers
   * `fetchAndJoin`, the remote bundle is merged as a separate ref and
   * our CID still anchors our local contribution at the next version.
   */
  private async publishAggregatorPointerBestEffort(cidString: string): Promise<void> {
    const pointer = this._options?.getPointerLayer?.() ?? null;
    if (!pointer) return;

    try {
      const cidBytes = CID.parse(cidString).bytes;
      const result = await pointer.publish(async () => cidBytes);
      this.log(
        `Pointer publish ok: cid=${cidString} version=${result.version} attempts=${result.attemptsUsed}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isPermanentPointerError(err)) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        this.log(`Pointer publish PERMANENT failure (${code}): ${msg}`);
        // Steelman⁴⁰ warning: route through buildErrorEvent so the
        // typed `code` is preserved as a structured event field, not
        // just interpolated into the string message.
        this.emitEvent(this.buildErrorEvent('storage:error', err));
      } else {
        this.log(`Pointer publish failed (transient, best-effort): ${msg}`);
      }
    }
  }

  /**
   * Try to rebuild the local bundle set from the aggregator pointer
   * layer's last valid CID. Returns `true` iff a bundle ref was
   * recorded (caller should skip the IPNS fallback). Returns `false`
   * when the pointer has no anchor yet or transiently failed — the
   * caller falls through to IPNS.
   *
   * PERMANENT failures (TRUST_BASE_STALE, UNTRUSTED_PROOF,
   * SECURITY_ORIGIN_MISMATCH, PROTOCOL_ERROR, UNSUPPORTED_RUNTIME,
   * UNREACHABLE_RECOVERY_BLOCKED) indicate integrity problems — a
   * silent fallthrough to IPNS would be a downgrade attack surface.
   * These are surfaced via `storage:error` AND return `true` so the
   * IPNS fallback does NOT fire. The bundle set may be empty; the
   * next flush can seed fresh anchors once the operator has fixed
   * the underlying problem.
   *
   * Content-address verify: `recoverLatest()` internally goes through
   * discovery → classifyVersion (which fetches + verifies the CAR
   * hash) → resolveRemoteCid. By the time we have the CID bytes here
   * they have been trust-verified end-to-end.
   */
  private async recoverFromAggregatorPointerBestEffort(): Promise<boolean> {
    const pointer = this._options?.getPointerLayer?.() ?? null;
    if (!pointer) return false;

    let recovered: { readonly cid: Uint8Array; readonly version: number } | null;
    try {
      recovered = await pointer.recoverLatest();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.isPermanentPointerError(err)) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        this.log(`Pointer recover PERMANENT failure (${code}): ${msg}`);
        // Steelman⁴⁰ warning: route through buildErrorEvent.
        this.emitEvent(this.buildErrorEvent('storage:error', err));
        // Do NOT fall through to IPNS on permanent integrity
        // failures — return true so the IPNS path is skipped.
        return true;
      }
      this.log(`Pointer recover failed (transient, best-effort): ${msg}`);
      return false;
    }

    if (!recovered) {
      this.log('Pointer recover: no anchor published yet');
      return false;
    }

    try {
      const cidString = CID.decode(recovered.cid).toString();
      // Idempotent: if the bundle already exists locally, this is a
      // no-op. Token count is unknown from the pointer alone — the
      // next flush re-counts.
      await this.addBundle(cidString, {
        cid: cidString,
        status: 'active',
        createdAt: Math.floor(Date.now() / 1000),
      });
      this.log(
        `Pointer recover ok: cid=${cidString} version=${recovered.version}`,
      );
      // recoverLatest() succeeded and we certified the pointer
      // anchor. Even if addBundle failed transiently (handled via
      // the throw path below), the pointer layer has successfully
      // identified this wallet's state — IPNS fallback would only
      // add noise. Return true on success; throw on addBundle error.
      return true;
    } catch (err) {
      // A post-recoverLatest error (most likely addBundle / OrbitDB
      // write failure). Treat as transient — the next flush /
      // reconnect will retry and the pointer anchor is already known
      // to be VALID. Fall back to IPNS? No: pointer already certified
      // the anchor; IPNS can only return something less trusted.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Pointer recover: addBundle failed post-recover: ${msg}`);
      return true;
    }
  }

  // ===========================================================================
  // Private: one-shot IPNS → pointer migration (T-D6b)
  // ===========================================================================

  /**
   * Run the legacy IPNS → pointer migration if the wallet pre-dates
   * the pointer layer. No-op for fresh wallets or wallets that have
   * already migrated. Never throws — any failure logs and returns,
   * leaving subsequent flushes to seed the anchor via the pointer
   * layer directly.
   *
   * See profile/migration/ipns-reader.ts for the legacy detection
   * heuristic and the one-shot orchestrator. This wrapper binds the
   * migration's `onBundle` callback to `this.addBundle` so the
   * imported refs respect the provider's encryption conventions.
   */
  private async runLegacyIpnsMigrationBestEffort(): Promise<void> {
    if (!this.identity || this._ipfsGateways.length === 0) return;
    if (!this.localCache) return;

    try {
      const { runIpnsToPointerMigration } = await import(
        './migration/ipns-reader.js'
      );
      const result = await runIpnsToPointerMigration({
        localCache: {
          get: (k) => this.localCache!.get(k),
          set: (k, v) => this.localCache!.set(k, v),
        },
        privateKeyHex: this.identity.privateKey,
        gateways: this._ipfsGateways,
        onBundle: async (cid, ref) => this.addBundle(cid, ref),
        log: (msg) => this.log(msg),
      });
      if (result.migrated) {
        this.log(
          `Legacy IPNS → pointer migration: imported ${result.bundlesImported} bundles`,
        );
      } else if (result.skipped === 'not-legacy') {
        // Fresh install post-pointer — expected silent no-op.
      } else {
        this.log(
          `Legacy migration skipped: ${result.skipped ?? 'transient-failure'}`,
        );
      }
    } catch (err) {
      this.log(
        `Legacy IPNS migration threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ===========================================================================
  // Private: TXF adapter (WU-P08 inlined)
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
    const operationalKeys = new Set([
      '_meta',
      '_tombstones',
      '_outbox',
      '_sent',
      '_invalid',
      '_history',
      '_mintOutbox',
      '_invalidatedNametags',
    ]);

    for (const key of Object.keys(data)) {
      // Standard token keys start with `_` (includes `_forked_` tokens)
      if (key.startsWith('_') && !operationalKeys.has(key)) {
        const value = (data as unknown as Record<string, unknown>)[key];
        if (value && typeof value === 'object') {
          tokens.set(key, value);
        }
        continue;
      }

      // Archived tokens start with `archived-`
      if (key.startsWith('archived-')) {
        const value = (data as unknown as Record<string, unknown>)[key];
        if (value && typeof value === 'object') {
          tokens.set(key, value);
        }
      }
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
    const addr = this.getAddressId();
    const writes: Array<[string, unknown]> = [
      [`${addr}.outbox`, opState.outbox],
      [`${addr}.invalid`, opState.invalid],
      [`${addr}.mintOutbox`, opState.mintOutbox],
      [`${addr}.invalidatedNametags`, opState.invalidatedNametags],
    ];

    for (const [key, value] of writes) {
      try {
        await this.writeProfileKey(key, JSON.stringify(value));
      } catch (err) {
        this.log(`Failed to write operational state key "${key}": ${err instanceof Error ? err.message : String(err)}`);
      }
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

    const [outbox, invalid, mintOutbox, invalidatedNametags] = await Promise.all([
      this.readProfileKeyJson<TxfOutboxEntry[]>(`${addr}.outbox`),
      this.readProfileKeyJson<TxfInvalidEntry[]>(`${addr}.invalid`),
      this.readProfileKeyJson<unknown[]>(`${addr}.mintOutbox`),
      this.readProfileKeyJson<unknown[]>(`${addr}.invalidatedNametags`),
    ]);

    return {
      outbox: outbox ?? [],
      invalid: invalid ?? [],
      mintOutbox: mintOutbox ?? [],
      invalidatedNametags: invalidatedNametags ?? [],
    };
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
      // Steelman⁴⁰ warning: aggregate event (already done; document the
      // pattern). Single event with `code: 'LOCAL_CACHE_READ_FAILED'`
      // and the failed keys in `data`.
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
      // Steelman⁴⁰ warning: route through buildErrorEvent for typed code.
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
   */
  private async readOperationalState(): Promise<OperationalState> {
    const [orbit, local] = await Promise.all([
      this.readOrbitOperationalState(),
      this.readLocalDerivedCache(),
    ]);

    return {
      ...orbit,
      tombstones: local.tombstones,
      sent: local.sent,
      history: local.history,
    };
  }

  // ===========================================================================
  // Private: OrbitDB key read/write helpers
  // ===========================================================================

  /**
   * Write a string value to an OrbitDB key, encrypting if enabled.
   */
  private async writeProfileKey(key: string, value: string): Promise<void> {
    const encoded = new TextEncoder().encode(value);
    const toWrite = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, encoded)
      : encoded;
    await this.db.put(key, toWrite);
  }

  /**
   * Read a string value from an OrbitDB key, decrypting if needed.
   */
  private async readProfileKey(key: string): Promise<string | null> {
    const raw = await this.db.get(key);
    if (!raw) return null;
    try {
      const decrypted = this.encryptionKey
        ? await decryptProfileValue(this.encryptionKey, raw)
        : raw;
      return new TextDecoder().decode(decrypted);
    } catch (err) {
      this.log(`Failed to read/decrypt key "${key}": ${err instanceof Error ? err.message : String(err)}`);
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
  // Private: Replication handler (WU-P12 inlined)
  // ===========================================================================

  /**
   * Handle OrbitDB replication events.
   * Checks for new `tokens.bundle.*` keys and emits `storage:remote-updated`.
   */
  private async handleReplication(): Promise<void> {
    try {
      const previousCids = new Set(this.knownBundleCids);
      await this.refreshKnownBundles();

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

// Steelman³⁵: hexToBytes consolidated to core/hex.ts (top-of-file import).
