/**
 * ProfileTokenStorageProvider
 *
 * Implements `TokenStorageProvider<TxfStorageDataBase>` using the UXF
 * multi-bundle model with OrbitDB as the source of truth and IPFS for
 * content-addressed CAR file storage.
 *
 * This is the bridge between:
 * - **TxfStorageDataBase** (what PaymentsModule reads/writes)
 * - **UXF bundles** (encrypted CAR files pinned to IPFS, referenced via OrbitDB)
 *
 * Write-behind buffer: `save()` accepts data immediately and debounces IPFS
 * pin + OrbitDB writes (2 seconds by default). Multiple rapid `save()` calls
 * coalesce into a single flush.
 *
 * Multi-bundle merge on load: all active `tokens.bundle.*` keys from OrbitDB
 * are fetched, decrypted, deserialized from CAR, and merged into a single
 * UxfPackage before reassembling into TxfStorageDataBase format.
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
  SaveResult,
  LoadResult,
  SyncResult,
  StorageEventCallback,
  StorageEvent,
  HistoryRecord,
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

// =============================================================================
// Constants
// =============================================================================

/** OrbitDB key prefix for UXF bundle references. */
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

/** Default write-behind debounce interval in milliseconds. */
const DEFAULT_FLUSH_DEBOUNCE_MS = 2000;

/** Threshold for logging a consolidation warning. */
const CONSOLIDATION_WARNING_THRESHOLD = 3;

/** Default IPFS gateway for CAR upload/fetch (used when none provided). */
const DEFAULT_IPFS_API_URL = 'https://ipfs.unicity.network';

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

  // --- Computed short address ID ---
  private addressId: string | null = null;

  // --- Last pinned CID for flush retry (Fix 8) ---
  private lastPinnedCid: string | null = null;

  // --- Config storage for createForAddress ---
  private readonly _db: ProfileDatabase;
  private readonly _encryptionKeyRaw: Uint8Array | null;
  private readonly _ipfsGateways: string[];
  private readonly _options: ProfileTokenStorageProviderOptions | undefined;

  constructor(
    private readonly db: ProfileDatabase,
    encryptionKey: Uint8Array | null,
    ipfsGateways: string[],
    private readonly options?: ProfileTokenStorageProviderOptions,
  ) {
    this._db = db;
    this._encryptionKeyRaw = encryptionKey;
    this._ipfsGateways = ipfsGateways;
    this._options = options;
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

    // Flush any pending writes
    if (this.pendingData) {
      try {
        await this.flushToIpfs();
      } catch (err) {
        this.log(`Shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Wait for in-flight flush to complete
    if (this.flushPromise) {
      try {
        await this.flushPromise;
      } catch {
        // best-effort
      }
    }

    // Unsubscribe from replication
    if (this.replicationUnsub) {
      this.replicationUnsub();
      this.replicationUnsub = null;
    }

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

    this.emitEvent({ type: 'storage:saving', timestamp });

    // Accept into local state immediately
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

      // 3. For each active bundle: fetch, decrypt, deserialize, merge
      for (const [cid] of activeBundles) {
        try {
          const carBytes = await this.fetchCar(cid);
          if (!this.encryptionKey) {
            throw new ProfileError(
              'PROFILE_NOT_INITIALIZED',
              'Encryption key not derived — call setIdentity() first',
            );
          }
          const decryptedCar = await decryptProfileValue(this.encryptionKey, carBytes);
          const pkg = await UxfPackage.fromCar(decryptedCar);
          mergedPkg.merge(pkg);
        } catch (err) {
          this.log(`Failed to load bundle ${cid}: ${err instanceof Error ? err.message : String(err)}`);
          // Continue with remaining bundles -- partial load is better than failure
        }
      }

      // 4. Assemble all tokens from merged package
      const assembledTokens = mergedPkg.assembleAll();

      // 5. Read operational state from OrbitDB
      const opState = await this.readOperationalState();

      // 6. Build TxfStorageDataBase
      const txfData = this.buildTxfStorageData(assembledTokens, opState);
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
      this.emitEvent({ type: 'storage:error', timestamp: Date.now(), error: errorMsg });
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
      this.emitEvent({ type: 'sync:error', timestamp: Date.now(), error: errorMsg });
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
      this.flushPromise = this.flushToIpfs()
        .catch((err) => {
          this.log(`Flush failed: ${err instanceof Error ? err.message : String(err)}`);
          this.emitEvent({
            type: 'storage:error',
            timestamp: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.flushPromise = null;
        });
    }, this.flushDebounceMs);
  }

  private async flushToIpfs(): Promise<void> {
    const data = this.pendingData;
    if (!data || !this.encryptionKey) return;

    // Snapshot and clear pending to avoid re-flushing the same data
    this.pendingData = null;

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

      // 3. Export to CAR
      const carBytes = await pkg.toCar();

      // 4. Encrypt
      if (!this.encryptionKey) {
        throw new ProfileError(
          'PROFILE_NOT_INITIALIZED',
          'Encryption key not derived — call setIdentity() first',
        );
      }
      const encryptedCar = await encryptProfileValue(this.encryptionKey, carBytes);

      // 5. Pin to IPFS (reuse last pinned CID on retry to avoid duplicate pins)
      let cid: string;
      if (this.lastPinnedCid) {
        cid = this.lastPinnedCid;
      } else {
        cid = await this.pinCar(encryptedCar);
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

      // 7. Write operational state to OrbitDB
      await this.writeOperationalState(opState);

      // Clear the pinned CID tracker after successful OrbitDB write
      this.lastPinnedCid = null;

      // 8. Check consolidation
      if (await this.shouldConsolidate()) {
        this.log(
          `Bundle count exceeds ${CONSOLIDATION_WARNING_THRESHOLD}. ` +
          'Consolidation deferred to Phase 2.',
        );
      }

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
   */
  private async listBundles(): Promise<Map<string, UxfBundleRef>> {
    const rawEntries = await this.db.all(BUNDLE_KEY_PREFIX);
    const result = new Map<string, UxfBundleRef>();

    for (const [key, value] of rawEntries) {
      const cid = key.slice(BUNDLE_KEY_PREFIX.length);
      try {
        const decrypted = this.encryptionKey
          ? await decryptProfileValue(this.encryptionKey, value)
          : value;
        const ref = JSON.parse(new TextDecoder().decode(decrypted)) as UxfBundleRef;
        result.set(cid, ref);
      } catch (err) {
        this.log(`Failed to deserialize bundle ref for ${cid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  /**
   * Write a bundle ref to OrbitDB.
   */
  private async addBundle(cid: string, ref: UxfBundleRef): Promise<void> {
    const serialized = new TextEncoder().encode(JSON.stringify(ref));
    const encrypted = this.encryptionKey
      ? await encryptProfileValue(this.encryptionKey, serialized)
      : serialized;
    await this.db.put(BUNDLE_KEY_PREFIX + cid, encrypted);
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
   * Write operational state fields as separate OrbitDB keys.
   */
  private async writeOperationalState(opState: OperationalState): Promise<void> {
    const addr = this.getAddressId();
    const writes: Array<[string, unknown]> = [
      [`${addr}.tombstones`, opState.tombstones],
      [`${addr}.outbox`, opState.outbox],
      [`${addr}.sent`, opState.sent],
      [`${addr}.invalid`, opState.invalid],
      [`${addr}.mintOutbox`, opState.mintOutbox],
      [`${addr}.invalidatedNametags`, opState.invalidatedNametags],
    ];

    // History is written via transactionHistory key
    if (opState.history.length > 0) {
      writes.push([`${addr}.transactionHistory`, opState.history]);
    }

    for (const [key, value] of writes) {
      try {
        await this.writeProfileKey(key, JSON.stringify(value));
      } catch (err) {
        this.log(`Failed to write operational state key "${key}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Read all operational state from OrbitDB.
   */
  private async readOperationalState(): Promise<OperationalState> {
    const addr = this.getAddressId();

    const [tombstones, outbox, sent, invalid, history, mintOutbox, invalidatedNametags] =
      await Promise.all([
        this.readProfileKeyJson<TxfTombstone[]>(`${addr}.tombstones`),
        this.readProfileKeyJson<TxfOutboxEntry[]>(`${addr}.outbox`),
        this.readProfileKeyJson<TxfSentEntry[]>(`${addr}.sent`),
        this.readProfileKeyJson<TxfInvalidEntry[]>(`${addr}.invalid`),
        this.readProfileKeyJson<HistoryRecord[]>(`${addr}.transactionHistory`),
        this.readProfileKeyJson<unknown[]>(`${addr}.mintOutbox`),
        this.readProfileKeyJson<unknown[]>(`${addr}.invalidatedNametags`),
      ]);

    return {
      tombstones: tombstones ?? [],
      outbox: outbox ?? [],
      sent: sent ?? [],
      invalid: invalid ?? [],
      history: history ?? [],
      mintOutbox: mintOutbox ?? [],
      invalidatedNametags: invalidatedNametags ?? [],
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
  // Private: IPFS CAR operations (WU-P09 inlined)
  // ===========================================================================

  /**
   * Pin an encrypted CAR file to IPFS and return the CID.
   */
  private async pinCar(encryptedCarBytes: Uint8Array): Promise<string> {
    const gatewayUrl = this._ipfsGateways[0] ?? DEFAULT_IPFS_API_URL;
    const url = `${gatewayUrl.replace(/\/$/, '')}/api/v0/dag/put`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: encryptedCarBytes,
    });

    if (!response.ok) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        `IPFS pin failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as { Cid?: { '/': string }; Hash?: string };
    const cid = result.Cid?.['/'] ?? result.Hash;
    if (!cid) {
      throw new ProfileError(
        'ORBITDB_WRITE_FAILED',
        'IPFS pin response did not contain a CID',
      );
    }

    return cid;
  }

  /**
   * Fetch an encrypted CAR file from IPFS by CID.
   * Tries each configured gateway in order until one succeeds.
   */
  private async fetchCar(cid: string): Promise<Uint8Array> {
    const gateways =
      this._ipfsGateways.length > 0 ? this._ipfsGateways : [DEFAULT_IPFS_API_URL];

    let lastError: Error | null = null;

    for (const gateway of gateways) {
      try {
        const url = `${gateway.replace(/\/$/, '')}/ipfs/${cid}`;
        const response = await fetch(url, {
          headers: { Accept: 'application/octet-stream' },
        });

        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status} from ${gateway}`);
          continue;
        }

        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new ProfileError(
      'BUNDLE_NOT_FOUND',
      `Failed to fetch CAR ${cid} from all gateways: ${lastError?.message ?? 'unknown error'}`,
    );
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

  private log(message: string): void {
    logger.debug('Profile-TokenStorage', message);
  }
}

// =============================================================================
// Utility
// =============================================================================

/**
 * Convert a hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
