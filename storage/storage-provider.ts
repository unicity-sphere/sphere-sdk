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
   * Save tracked addresses (only user state: index, hidden, timestamps).
   *
   * MUST MERGE, NEVER REPLACE (#766 item 5). `entries` is ONE writer's snapshot,
   * not the whole truth: every Sphere sharing this storage keeps its own copy of
   * the registry and persists all of it, so writing the argument verbatim is a
   * lost update — A activates index 1, B (whose snapshot predates that) activates
   * index 2, and B's write erases index 1 while A still reports it. This happens
   * on a single network with a single provider; do NOT "fix" it by renaming or
   * network-scoping the key.
   *
   * The contract, implemented by `storage/tracked-addresses.ts` — reuse those
   * helpers rather than re-deriving this:
   *  - read the stored registry, union it with `entries` BY `index`;
   *  - on a conflicting index, the entry with the greater `updatedAt` supplies
   *    `hidden`, and `createdAt` keeps the earlier value;
   *  - serialize concurrent calls on the provider instance, so one call's read
   *    cannot interleave with another's write;
   *  - a failed write must not brick later writes, and must still reject to its
   *    own caller.
   *
   * A stored `index` must be a NON-NEGATIVE INTEGER. `deriveKeyAtPath` parseInt()s
   * that path segment, so `1.5` derives index 1's keys and the row aliases a real
   * address; such rows are dropped on read rather than repaired.
   *
   * A union is safe because there is no delete path: entries are only ever added,
   * and wiping the wallet removes the key itself (`Sphere.clear()`). Adding a
   * per-entry delete would require revisiting this contract.
   */
  saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void>;

  /**
   * Load tracked addresses. Tolerant: unusable/corrupt storage reads as `[]`
   * (see `parseTrackedAddresses` in `storage/tracked-addresses.ts`).
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
