/**
 * Storage Provider Interface
 * Platform-independent storage abstraction
 */

import type { BaseProvider, FullIdentity, TrackedAddressEntry } from '../types';
import type { TokenBlob } from '../token-engine/types';

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
// Lazy inventory view (sdk-changes S2, ARCHITECTURE §5.1/§16)
// =============================================================================

/** One fungible position of an inventory item. Amounts are `bigint` in types
 * (decimal strings on the wallet-api wire — they exceed 2^53). */
export interface InventoryAsset {
  coinId: string;
  amount: bigint;
}

/**
 * One row of the inventory view — value metadata only, **no blobs**.
 * `status: 'removed'` is a tombstone: the token left this inventory (spent, or
 * handed off at claim) — the only way a stale device learns about removals
 * (ARCHITECTURE §5.1).
 */
export interface InventoryItem {
  /** Genesis-stable 64-hex token id. */
  tokenId: string;
  status: 'active' | 'removed';
  /** Decoded value; absent when unknown (e.g. a tombstone). */
  assets?: InventoryAsset[];
  /** Owner change-cursor value at this row's last change (`?since=` deltas). */
  seq: bigint;
}

/** Result of {@link TokenStorageProvider.listInventory}. */
export interface InventoryView {
  /** Cursor to resume deltas from (`listInventory(cursor)`). */
  cursor: bigint;
  /**
   * Server sync epoch (ARCHITECTURE §5.4/§9): changes ONLY when a server
   * restore invalidated cursor continuity. On a change, clients discard all
   * persisted cursors, do a full pull, and re-PUT locally-known open intents.
   * Local providers (no server) report a constant `0n`.
   */
  syncEpoch: bigint;
  /** Truncated page (PAGE_LIMIT) — loop with `since = cursor` until false. */
  more: boolean;
  items: InventoryItem[];
}

/** An `added` entry of {@link TokenStorageProvider.applyDelta}: the token id
 * plus the content-addressed blob-store key of its already-uploaded bytes. */
export interface ApplyDeltaAdded {
  tokenId: string;
  /** Content-addressed blob key — `<network>/t/<hex(sha256(blob))>` (ARCHITECTURE §5.2). */
  key: string;
}

export interface ApplyDeltaOptions {
  /**
   * The wallet-api-storage + other-transport composition (ARCHITECTURE §5.3):
   * removals cannot be evidence-checked against a mailbox deposit, so the
   * server records them as `external` (never-collected blob retention).
   */
  externalDelivery?: boolean;
}

/** Result of an explicit `recoverRemoved()` maintenance run (sdk-changes S2). */
export interface RecoverRemovedResult {
  /** Tombstoned tokens re-verified and re-added (reactivation — ARCHITECTURE §5.3). */
  recovered: string[];
  /** Tokens the server 409'd as evidenced spends — "actually spent", tombstone kept. */
  spent: string[];
  /** Tombstones skipped (matched to a known local spend, or failed local verification). */
  skipped: string[];
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
   * Fail-closed composition invariant (sdk-changes S7, #515): set `true` on
   * providers whose token custody lives behind the wallet-api backend (the S2
   * thin provider). Composing such a provider as the ACTIVE token storage
   * without the wallet-api client (`walletApi`) is an accidentally-degraded,
   * ILLEGAL composition — `PaymentsModule.initialize` throws `INVALID_CONFIG`
   * instead of silently running local-custody semantics. Local/whole-blob
   * providers omit it.
   */
  readonly requiresWalletApi?: boolean;

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

  // --- Lazy inventory port (sdk-changes S2; ARCHITECTURE §5/§16) -------------
  // The whole-blob load()/sync() surface above remains for whole-blob
  // providers, but the wallet's hot path is this view: balances and
  // coin-selection read listInventory() (no blob download); a spend fetches
  // only the selected blobs via getToken(). Whole-blob providers conform via
  // the shared default adapter (storage/whole-blob-inventory-adapter.ts),
  // which derives these from load() — swappability is preserved, not broken,
  // by this extension.

  /**
   * The inventory view — value metadata only, never blobs.
   *
   * Without `since`: the current active rows. With `since`: every row changed
   * after that cursor **including tombstones** (`status:'removed'`) — callers
   * MUST apply tombstones (drop local entries) and loop while `more` is true.
   * On a `syncEpoch` change the provider discards persisted cursors and
   * resyncs from scratch (ARCHITECTURE §5.4).
   *
   * Whole-blob providers (no change journal) compute the view from the loaded
   * set: all rows `'active'`, synthetic `seq`/`cursor`, `more: false`.
   */
  listInventory(since?: bigint): Promise<InventoryView>;

  /**
   * Fetch + decode one token blob on demand (a signed GET for remote
   * providers; the loaded set for whole-blob providers). Throws when the
   * token is unknown or carries no v2 blob.
   */
  getToken(tokenId: string): Promise<TokenBlob>;

  /**
   * Record a spend result: tombstone `spent` tokens, add `added` outputs.
   * Idempotent by `transferId`. For wallet-api delivery this MUST be called
   * **after** the mailbox deposit of the same `transferId` — the backend
   * evidence-checks removals against it (ARCHITECTURE §5.3).
   */
  applyDelta(
    transferId: string,
    spent: string[],
    added: ApplyDeltaAdded[],
    opts?: ApplyDeltaOptions
  ): Promise<void>;

  /**
   * Optional maintenance call (sdk-changes S2): re-fetch tombstoned tokens the
   * client cannot match to a known spend, verify them locally, and re-add
   * (reactivation). A server 409 means "actually spent" — keep the tombstone.
   * Only meaningful for providers with server-side tombstones.
   */
  recoverRemoved?(): Promise<RecoverRemovedResult>;

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
   *
   * Omitting `createForAddress` is safe ONLY for **stateless or identity-keyed**
   * providers — ones that re-scope correctly when `Sphere.buildAddressTokenProviders`
   * falls back to reusing the single instance and re-binding it via `setIdentity`
   * (e.g. a local provider that namespaces every read/write by the active
   * identity). A provider that holds **per-address mutable state** (cursors,
   * caches, an embedded `WalletApiClient`, etc.) and does NOT implement
   * `createForAddress` is UNSAFE in multi-address mode: the fallback hands every
   * address the same instance and a stale-address poll/sync can bleed into the
   * newly bound address. Such providers MUST implement `createForAddress`.
   *
   * `sharedClient` (#583): an optional, provider-specific per-address context —
   * for wallet-api-backed providers it is the address's already-built
   * `WalletApiClient`, so all of an address's wallet-api artifacts share ONE
   * client + one refresh-token lineage (separate sibling clients of the same
   * owner+deviceId would trip the server's rotation-reuse revocation). Typed as
   * `unknown` to keep this generic storage contract decoupled from the
   * wallet-api layer; providers that don't need it ignore the argument.
   */
  createForAddress?(sharedClient?: unknown): TokenStorageProvider<TData>;

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
