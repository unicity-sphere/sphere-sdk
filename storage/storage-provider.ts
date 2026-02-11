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
   * Check if data exists
   */
  exists?(identifier?: string): Promise<boolean>;

  /**
   * Clear all data
   */
  clear?(): Promise<boolean>;

  /**
   * Subscribe to storage events
   */
  onEvent?(callback: StorageEventCallback): () => void;

  /**
   * Save individual token (for file-based storage like lottery pattern)
   */
  saveToken?(tokenId: string, tokenData: unknown): Promise<void>;

  /**
   * Get individual token
   */
  getToken?(tokenId: string): Promise<unknown | null>;

  /**
   * List all token IDs
   */
  listTokenIds?(): Promise<string[]>;

  /**
   * Delete individual token
   */
  deleteToken?(tokenId: string): Promise<void>;
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
