/**
 * TokenReservationLedger
 *
 * Tracks which portions of which tokens have been logically claimed by
 * in-flight send() operations. All operations are SYNCHRONOUS -- this is
 * a hard requirement for the spend queue's TOCTOU-safe critical section.
 *
 * Invariants:
 *   I-RL-1: getFreeAmount >= 0n always
 *   I-RL-2: getFreeAmount + getTotalReserved === tokenAmount for any tracked token
 *   I-RL-3: ALL operations synchronous (no async/await)
 *   I-RL-4: Status transitions one-directional: active -> committed, active -> cancelled
 *   I-RL-5: tokenIndex consistent with reservations at all times
 *   I-RL-6: Each reservationId unique
 */

import { logger } from '../../core/logger';

const TAG = 'ReservationLedger';

export type ReservationStatus = 'active' | 'committed' | 'cancelled';

export interface ReservationEntry {
  readonly reservationId: string;
  readonly amounts: Map<string, bigint>; // tokenId -> reserved amount
  readonly coinId: string;
  readonly createdAt: number;
  status: ReservationStatus;
}

export class TokenReservationLedger {
  /** Primary index: reservationId -> ReservationEntry */
  private readonly reservations = new Map<string, ReservationEntry>();

  /** Secondary index (acceleration): tokenId -> Set<reservationId> */
  private readonly tokenIndex = new Map<string, Set<string>>();

  /**
   * Creates a new reservation. All-or-nothing: validates every entry
   * before writing any state.
   *
   * The caller MUST provide tokenAmount for each entry so the ledger can
   * verify that sufficient free capacity exists. The ledger does not hold
   * token references itself.
   *
   * @param reservationId - Unique identifier for this reservation
   * @param entries - Token amounts to reserve (tokenId, amount to reserve, total token amount)
   * @param coinId - Coin identifier for the reserved tokens
   * @throws Error('EMPTY_RESERVATION') if entries is empty
   * @throws Error('DUPLICATE_RESERVATION_ID') if reservationId already exists
   * @throws Error('INVALID_RESERVATION_AMOUNT') if any amount <= 0n
   * @throws Error('INSUFFICIENT_FREE_AMOUNT') if any token lacks free capacity
   */
  reserve(
    reservationId: string,
    entries: Array<{ tokenId: string; amount: bigint; tokenAmount: bigint }>,
    coinId: string,
  ): void {
    // Validate preconditions -- ALL checks before ANY mutation
    if (entries.length === 0) {
      throw new Error('EMPTY_RESERVATION');
    }

    if (this.reservations.has(reservationId)) {
      throw new Error('DUPLICATE_RESERVATION_ID');
    }

    for (const entry of entries) {
      if (entry.amount <= 0n) {
        throw new Error('INVALID_RESERVATION_AMOUNT');
      }
    }

    // Accumulate per-tokenId amounts and tokenAmounts for the new reservation
    // to correctly handle duplicate tokenIds in entries
    const pendingAmounts = new Map<string, bigint>();
    const tokenAmounts = new Map<string, bigint>();
    for (const entry of entries) {
      const current = pendingAmounts.get(entry.tokenId) ?? 0n;
      pendingAmounts.set(entry.tokenId, current + entry.amount);
      // Use the largest tokenAmount seen for a given tokenId (should be consistent)
      const existingTokenAmount = tokenAmounts.get(entry.tokenId);
      if (existingTokenAmount === undefined || entry.tokenAmount > existingTokenAmount) {
        tokenAmounts.set(entry.tokenId, entry.tokenAmount);
      }
    }

    // Check that free amount is sufficient for each token
    for (const [tokenId, newAmount] of pendingAmounts) {
      const tokenAmount = tokenAmounts.get(tokenId)!;
      const freeAmount = this.getFreeAmount(tokenId, tokenAmount);
      if (freeAmount < newAmount) {
        throw new Error('INSUFFICIENT_FREE_AMOUNT');
      }
    }

    // All checks passed -- mutate state
    const amounts = new Map<string, bigint>(pendingAmounts);

    const reservation: ReservationEntry = {
      reservationId,
      amounts,
      coinId,
      createdAt: Date.now(),
      status: 'active',
    };

    this.reservations.set(reservationId, reservation);

    // Update secondary index
    for (const tokenId of amounts.keys()) {
      let set = this.tokenIndex.get(tokenId);
      if (!set) {
        set = new Set();
        this.tokenIndex.set(tokenId, set);
      }
      set.add(reservationId);
    }
  }

  /**
   * Marks a reservation as committed and removes it from all indexes.
   * Idempotent. Committed tokens are about to be removed from the wallet,
   * so the reservation is no longer needed for capacity tracking.
   */
  commit(reservationId: string): void {
    const entry = this.reservations.get(reservationId);
    if (!entry) return;

    if (entry.status === 'committed') return;

    if (entry.status === 'cancelled') {
      logger.warn(TAG, `Attempted to commit cancelled reservation ${reservationId}`);
      return;
    }

    entry.status = 'committed';
    // Remove from indexes — tokens are being transferred, no capacity to track
    this.removeFromTokenIndex(entry);
    this.reservations.delete(reservationId);
  }

  /**
   * Releases a reservation. Idempotent.
   * Removes from tokenIndex for all referenced tokens.
   */
  cancel(reservationId: string): void {
    const entry = this.reservations.get(reservationId);
    if (!entry) return;

    if (entry.status === 'cancelled') return;

    if (entry.status === 'committed') {
      logger.warn(TAG, `Attempted to cancel committed reservation ${reservationId}`);
      return;
    }

    entry.status = 'cancelled';
    this.removeFromTokenIndex(entry);
    this.reservations.delete(reservationId);
  }

  /**
   * Cancels ALL active reservations referencing tokenId.
   * @param excludeReservationId - If provided, skip this reservation (used by send()
   *   to prevent removeToken() from cancelling its own in-flight reservation).
   * @returns Array of cancelled reservationIds.
   */
  cancelForToken(tokenId: string, excludeReservationId?: string): string[] {
    const set = this.tokenIndex.get(tokenId);
    if (!set) return [];

    const cancelled: string[] = [];
    // Collect reservation IDs first to avoid mutation during iteration
    const reservationIds = [...set];

    for (const resId of reservationIds) {
      if (resId === excludeReservationId) continue;
      const entry = this.reservations.get(resId);
      if (!entry) continue;

      if (entry.status === 'active') {
        entry.status = 'cancelled';
        cancelled.push(resId);
        this.removeFromTokenIndex(entry);
        this.reservations.delete(resId);
      }
    }

    // Clean tokenId from index only if no reservations remain
    const remaining = this.tokenIndex.get(tokenId);
    if (remaining && remaining.size === 0) {
      this.tokenIndex.delete(tokenId);
    }

    return cancelled;
  }

  /**
   * Returns tokenAmount minus sum of amounts from active+committed reservations.
   * Returns 0n if result would be negative (defensive, satisfies I-RL-1).
   *
   * @param tokenId - The token to check
   * @param tokenAmount - The total amount of the token (ledger does not store this)
   */
  getFreeAmount(tokenId: string, tokenAmount: bigint): bigint {
    const reserved = this.getTotalReserved(tokenId);
    const free = tokenAmount - reserved;
    return free > 0n ? free : 0n;
  }

  /**
   * Sum of active+committed reservation amounts for tokenId.
   */
  getTotalReserved(tokenId: string): bigint {
    const set = this.tokenIndex.get(tokenId);
    if (!set) return 0n;

    let total = 0n;
    for (const resId of set) {
      const entry = this.reservations.get(resId);
      if (!entry) continue;
      if (entry.status === 'active' || entry.status === 'committed') {
        const amount = entry.amounts.get(tokenId);
        if (amount) {
          total += amount;
        }
      }
    }
    return total;
  }

  /**
   * Removes reservations older than maxAgeMs.
   * Active ones get cancelled first, then removed from indexes.
   * Committed and cancelled ones are removed directly.
   *
   * @returns List of reservationIds that were active and got cancelled.
   */
  cleanup(maxAgeMs: number): string[] {
    const now = Date.now();
    const cancelled: string[] = [];
    const toRemove: string[] = [];

    for (const [resId, entry] of this.reservations) {
      if (now - entry.createdAt > maxAgeMs) {
        if (entry.status === 'active') {
          entry.status = 'cancelled';
          this.removeFromTokenIndex(entry);
          cancelled.push(resId);
        }
        toRemove.push(resId);
      }
    }

    for (const resId of toRemove) {
      this.reservations.delete(resId);
    }

    return cancelled;
  }

  /**
   * Read-only lookup of a reservation by ID.
   */
  getReservation(reservationId: string): ReservationEntry | undefined {
    return this.reservations.get(reservationId);
  }

  /**
   * Returns true if any active reservation exists for this token.
   */
  hasActiveReservation(tokenId: string): boolean {
    const set = this.tokenIndex.get(tokenId);
    if (!set) return false;

    for (const resId of set) {
      const entry = this.reservations.get(resId);
      if (entry && entry.status === 'active') {
        return true;
      }
    }
    return false;
  }

  /**
   * Total number of reservations (all statuses).
   */
  getSize(): number {
    return this.reservations.size;
  }

  /**
   * Remove all reservations and clear all indexes.
   */
  clear(): void {
    this.reservations.clear();
    this.tokenIndex.clear();
  }

  /**
   * Remove a reservation entry from the tokenIndex for all its referenced tokens.
   * Does NOT remove the reservation from the primary index.
   */
  private removeFromTokenIndex(entry: ReservationEntry): void {
    for (const tokenId of entry.amounts.keys()) {
      const set = this.tokenIndex.get(tokenId);
      if (set) {
        set.delete(entry.reservationId);
        if (set.size === 0) {
          this.tokenIndex.delete(tokenId);
        }
      }
    }
  }
}
