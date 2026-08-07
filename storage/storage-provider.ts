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
// History Record (the payments-v2 history wire/store shape)
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
  /** RECEIVED only: the received state (local hash) — makes the dedup key per-state, so a
   *  genesis token re-acquired at multiple states records each receipt instead of colliding. */
  stateHash?: string;
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
// Provider Factory Type
// =============================================================================

export type StorageProviderFactory<TConfig, TProvider extends StorageProvider> = (
  config?: TConfig
) => TProvider;
