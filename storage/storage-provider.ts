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
   * Shutdown provider
   */
  shutdown(): Promise<void>;

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
  | 'sync:error';

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
