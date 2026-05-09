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
  ProfileTokenStorageProviderOptions,
} from '../types.js';
import type { ProfileDatabase } from '../orbitdb-adapter.js';
import type { TokenManifest } from '../token-manifest.js';

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
}
