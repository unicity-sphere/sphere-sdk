/**
 * Auto-Return Manager
 *
 * Manages the write-first intent deduplication ledger for auto-return transfers.
 * Tracks per-(invoiceId, transferId) intent entries through their lifecycle:
 * pending → completed | failed.
 *
 * Used by AccountingModule.setAutoReturn() and the inbound event handler to ensure
 * each forward payment to a terminated invoice is returned at most once, even under
 * crash recovery or Nostr re-delivery.
 *
 * @see docs/ACCOUNTING-SPEC.md §7.5, §5.9
 */

import type { StorageProvider } from '../../storage/storage-provider.js';
import type { AutoReturnLedger, AutoReturnLedgerEntry } from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Completed entries older than this are pruned from the ledger on load(). */
const PRUNE_TTL_MS = 30 * 86400_000; // 30 days

/** Maximum crash-recovery retry attempts before marking an entry as failed. */
const MAX_RETRY_COUNT = 5;

// =============================================================================
// AutoReturnManager
// =============================================================================

/**
 * Manages the auto-return deduplication ledger.
 *
 * The ledger is a write-first intent log: before any `send()` call the intent
 * is persisted with `status = 'pending'`, preventing duplicate sends on crash
 * recovery. On completion the entry is updated to `status = 'completed'`.
 *
 * ### Key format
 * `{invoiceId}:{transferId}`  — invoiceId is always 64 hex chars (colon-free).
 * transferId CAN contain colons (e.g., `FROZEN:addr:recipient:coinId`).
 * Parsing uses fixed-width split: invoiceId = key.slice(0, 64), transferId = key.slice(65).
 *
 * ### Lifecycle
 * 1. `configure()` — inject storage and addressId
 * 2. `load()` — deserialise ledger, prune stale entries, return pending list for
 *    crash recovery
 * 3. `isDone()` — fast dedup check (O(1) Map lookup)
 * 4. `recordIntent()` — write-first pattern (persist before send)
 * 5. `markCompleted()` / `markFailed()` — update status after send attempt
 * 6. `getPendingEntries()` — retrieve entries needing crash recovery
 */
export class AutoReturnManager {
  // ---------------------------------------------------------------------------
  // In-memory ledger
  // ---------------------------------------------------------------------------

  /** In-memory ledger: key → AutoReturnLedgerEntry */
  private ledger: Map<string, AutoReturnLedgerEntry> = new Map();

  // ---------------------------------------------------------------------------
  // Configuration (set via configure())
  // ---------------------------------------------------------------------------

  private storage: StorageProvider | null = null;
  private storageKey: string = '';

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Inject storage and address-scoped key prefix.
   *
   * Must be called before `load()`.
   *
   * @param storage   - StorageProvider for ledger persistence.
   * @param storageKey - Fully-resolved address-scoped storage key
   *                     (e.g. `DIRECT_abc_xyz_auto_return_ledger`).
   */
  configure(storage: StorageProvider, storageKey: string): void {
    this.storage = storage;
    this.storageKey = storageKey;
  }

  // ===========================================================================
  // Load and recover
  // ===========================================================================

  /**
   * Load the dedup ledger from storage, prune completed entries older than
   * 30 days, and persist the pruned ledger if anything was removed.
   *
   * After `load()`:
   * - `isDone()` is accurate for all surviving entries.
   * - `getPendingEntries()` returns entries needing crash recovery.
   */
  async load(): Promise<void> {
    if (!this.storage) return;

    let raw: string | null = null;
    try {
      raw = await this.storage.get(this.storageKey);
    } catch {
      // Storage read failure — start with empty ledger
    }

    let ledgerData: AutoReturnLedger = { entries: {} };
    if (raw) {
      try {
        ledgerData = JSON.parse(raw) as AutoReturnLedger;
      } catch {
        // Corrupt storage — start empty, will be overwritten on next save
        ledgerData = { entries: {} };
      }
    }

    // Populate in-memory ledger
    this.ledger.clear();
    for (const [key, entry] of Object.entries(ledgerData.entries)) {
      this.ledger.set(key, entry);
    }

    // Prune completed entries older than 30 days (§7.5)
    const cutoff = Date.now() - PRUNE_TTL_MS;
    let pruned = false;
    for (const [key, entry] of this.ledger.entries()) {
      // W6 fix: also prune failed entries older than PRUNE_TTL_MS to prevent unbounded growth
      const isOldCompleted = entry.status === 'completed' && entry.completedAt !== undefined && entry.completedAt < cutoff;
      const failedAge = entry.lastRetryAt ?? entry.intentAt;
      const isOldFailed = entry.status === 'failed' && failedAge < cutoff;
      if (isOldCompleted || isOldFailed) {
        this.ledger.delete(key);
        pruned = true;
      }
    }

    if (pruned) {
      await this.save();
    }
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Persist the current in-memory ledger to storage.
   *
   * When `critical` is true (default false), storage write failures are
   * propagated to the caller. This is used by `recordIntent()` to ensure
   * the write-first pattern actually persists before the send proceeds.
   * For non-critical saves (markCompleted, markFailed), failures are
   * silently swallowed — the in-memory state remains authoritative.
   */
  async save(critical = false): Promise<void> {
    if (!this.storage) return;
    const entries: Record<string, AutoReturnLedgerEntry> = {};
    for (const [key, entry] of this.ledger.entries()) {
      entries[key] = entry;
    }
    try {
      await this.storage.set(this.storageKey, JSON.stringify({ entries }));
    } catch (err) {
      if (critical) throw err;
      // Non-critical: storage write failure — in-memory ledger is still authoritative
    }
  }

  // ===========================================================================
  // Dedup check
  // ===========================================================================

  /**
   * Return `true` if a completed return already exists for this
   * (invoiceId, transferId) pair.
   *
   * Note: `'failed'` entries are NOT treated as done — they are retried when
   * `setAutoReturn()` explicitly resets them to `'pending'`.
   */
  isDone(invoiceId: string, transferId: string): boolean {
    const key = this.buildKey(invoiceId, transferId);
    const entry = this.ledger.get(key);
    return entry?.status === 'completed';
  }

  /**
   * Return `true` if any entry exists (pending, completed, or failed) for this
   * (invoiceId, transferId) pair.
   */
  hasEntry(invoiceId: string, transferId: string): boolean {
    return this.ledger.has(this.buildKey(invoiceId, transferId));
  }

  /**
   * Return the current entry for a (invoiceId, transferId) pair, or `undefined`.
   */
  getEntry(invoiceId: string, transferId: string): AutoReturnLedgerEntry | undefined {
    return this.ledger.get(this.buildKey(invoiceId, transferId));
  }

  // ===========================================================================
  // Write-first intent log
  // ===========================================================================

  /**
   * Record intent to auto-return — write-first pattern (§7.5 step 3a).
   *
   * Persists a `'pending'` entry BEFORE the `send()` call. On crash, the
   * pending entry is found by `load()` → `getPendingEntries()` and retried.
   *
   * @param invoiceId  - Invoice token ID.
   * @param transferId - Original forward transfer ID being auto-returned.
   * @param fields     - All fields except `intentAt` and `status` (set here).
   */
  async recordIntent(
    invoiceId: string,
    transferId: string,
    fields: Omit<AutoReturnLedgerEntry, 'intentAt' | 'status'>,
  ): Promise<void> {
    const key = this.buildKey(invoiceId, transferId);
    const entry: AutoReturnLedgerEntry = {
      ...fields,
      intentAt: Date.now(),
      status: 'pending',
    };
    // W4-R18 fix: Rollback in-memory entry if save fails — prevents stale pending
    // entry from causing hasEntry()/isDone() to return incorrect results.
    const previous = this.ledger.get(key);
    this.ledger.set(key, entry);
    try {
      // W4 fix: Use critical=true so storage write failures propagate.
      // The write-first pattern only provides crash safety if the write succeeds.
      await this.save(true);
    } catch (err) {
      // Rollback: restore previous entry or delete if none existed
      if (previous) {
        this.ledger.set(key, previous);
      } else {
        this.ledger.delete(key);
      }
      throw err;
    }
  }

  /**
   * Mark an entry as completed after a successful `send()` call (§7.5 step 4).
   *
   * @param invoiceId        - Invoice token ID.
   * @param transferId       - Original forward transfer ID.
   * @param returnTransferId - The transfer ID returned by `send()`.
   */
  async markCompleted(
    invoiceId: string,
    transferId: string,
    returnTransferId: string,
  ): Promise<void> {
    const key = this.buildKey(invoiceId, transferId);
    const existing = this.ledger.get(key);
    const updated: AutoReturnLedgerEntry = {
      ...(existing ?? {
        intentAt: Date.now(),
        recipient: '',
        amount: '',
        coinId: '',
        memo: '',
      }),
      status: 'completed',
      returnTransferId,
      completedAt: Date.now(),
    };
    this.ledger.set(key, updated);
    await this.save();
  }

  /**
   * Mark an entry as failed (max retries exceeded or unrecoverable error).
   *
   * Failed entries are skipped during ongoing auto-return but can be reset to
   * `'pending'` by a subsequent `setAutoReturn()` call to force a retry.
   *
   * @param invoiceId  - Invoice token ID.
   * @param transferId - Original forward transfer ID.
   */
  async markFailed(invoiceId: string, transferId: string): Promise<void> {
    const key = this.buildKey(invoiceId, transferId);
    const existing = this.ledger.get(key);
    if (!existing) return;
    const updated: AutoReturnLedgerEntry = {
      ...existing,
      status: 'failed',
    };
    this.ledger.set(key, updated);
    await this.save();
  }

  /**
   * Increment the retry count and update the lastRetryAt timestamp.
   * Used during crash recovery to track repeated attempts.
   *
   * @param invoiceId  - Invoice token ID.
   * @param transferId - Original forward transfer ID.
   * @returns Updated retry count, or 1 if no prior entry.
   */
  async incrementRetry(invoiceId: string, transferId: string): Promise<number> {
    const key = this.buildKey(invoiceId, transferId);
    const existing = this.ledger.get(key);
    if (!existing) return 1;
    // CR-M4 fix: Guard against mutating completed/failed entries
    if (existing.status !== 'pending') return existing.retryCount ?? 0;
    const retryCount = (existing.retryCount ?? 0) + 1;
    const updated: AutoReturnLedgerEntry = {
      ...existing,
      retryCount,
      lastRetryAt: Date.now(),
    };
    // CR-M4 fix: Rollback in-memory entry if save fails (matches recordIntent pattern)
    this.ledger.set(key, updated);
    try {
      await this.save();
    } catch (err) {
      this.ledger.set(key, existing);
      throw err;
    }
    return retryCount;
  }

  /**
   * Reset a `'failed'` entry back to `'pending'` to enable retry.
   * Called by `setAutoReturn()` before re-triggering auto-return.
   *
   * @param invoiceId  - Invoice token ID.
   * @param transferId - Original forward transfer ID.
   */
  async resetToPending(invoiceId: string, transferId: string): Promise<void> {
    const key = this.buildKey(invoiceId, transferId);
    const existing = this.ledger.get(key);
    if (!existing || existing.status !== 'failed') return;
    // W5-R18 fix: Rollback to 'failed' if save fails
    this.ledger.set(key, { ...existing, status: 'pending' });
    try {
      await this.save(true);
    } catch (err) {
      this.ledger.set(key, existing);
      throw err;
    }
  }

  // ===========================================================================
  // Crash recovery
  // ===========================================================================

  /**
   * Return all entries currently in `'pending'` state.
   * Used by crash recovery in `load()` to retry incomplete sends.
   *
   * @returns Array of `{ key, entry }` pairs with `status === 'pending'`.
   */
  getPendingEntries(): Array<{ key: string; entry: AutoReturnLedgerEntry }> {
    const pending: Array<{ key: string; entry: AutoReturnLedgerEntry }> = [];
    for (const [key, entry] of this.ledger.entries()) {
      if (entry.status === 'pending') {
        pending.push({ key, entry });
      }
    }
    return pending;
  }

  /**
   * Return all entries in `'failed'` state for a specific invoice.
   * Used by `setAutoReturn()` to find entries that need reset + retry.
   *
   * @param invoiceId - Invoice token ID.
   * @returns Array of transferIds whose entries are `'failed'`.
   */
  getFailedTransferIds(invoiceId: string): string[] {
    const prefix = `${invoiceId}:`;
    const result: string[] = [];
    for (const [key, entry] of this.ledger.entries()) {
      // W3-R18 fix: Use prefix.length instead of hardcoded 65 to support any invoiceId length
      if (key.startsWith(prefix) && key.length > prefix.length && entry.status === 'failed') {
        const transferId = key.slice(prefix.length);
        result.push(transferId);
      }
    }
    return result;
  }

  // ===========================================================================
  // Maintenance
  // ===========================================================================

  /**
   * Remove all completed entries older than 30 days and persist.
   *
   * Called from `load()` automatically. May also be called manually if needed.
   */
  async prune(): Promise<void> {
    const cutoff = Date.now() - PRUNE_TTL_MS;
    let pruned = false;
    for (const [key, entry] of this.ledger.entries()) {
      // W6 fix: also prune failed entries older than PRUNE_TTL_MS to prevent unbounded growth
      const isOldCompleted = entry.status === 'completed' && entry.completedAt !== undefined && entry.completedAt < cutoff;
      const failedAge = entry.lastRetryAt ?? entry.intentAt;
      const isOldFailed = entry.status === 'failed' && failedAge < cutoff;
      if (isOldCompleted || isOldFailed) {
        this.ledger.delete(key);
        pruned = true;
      }
    }
    if (pruned) {
      await this.save(true);
    }
  }

  /**
   * Clear the in-memory ledger without touching storage.
   * Used during module destruction.
   */
  clear(): void {
    this.ledger.clear();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Maximum crash-recovery retry count before an entry is abandoned as failed.
   */
  static get MAX_RETRY_COUNT(): number {
    return MAX_RETRY_COUNT;
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  /**
   * Build the ledger key for a (invoiceId, transferId) pair.
   * Format: `{invoiceId}:{transferId}`
   */
  private buildKey(invoiceId: string, transferId: string): string {
    return `${invoiceId}:${transferId}`;
  }
}
