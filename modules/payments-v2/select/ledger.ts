// §5.4 Reservations — ported TokenReservationLedger, fully synchronous.

export interface ReservationRequest {
  readonly tokenId: string;
  readonly amount: bigint;
  readonly tokenAmount: bigint;
}

export class ReservationLedger {
  private readonly reservations = new Map<string, Map<string, bigint>>();
  private readonly tokenIndex = new Map<string, Set<string>>();

  // All-or-nothing: every entry is validated before any state mutates.
  reserve(reservationId: string, entries: readonly ReservationRequest[]): void {
    if (entries.length === 0) throw new Error('EMPTY_RESERVATION');
    if (this.reservations.has(reservationId)) throw new Error('DUPLICATE_RESERVATION_ID');

    const amounts = new Map<string, bigint>();
    const tokenAmounts = new Map<string, bigint>();
    for (const entry of entries) {
      if (entry.amount <= 0n) throw new Error('INVALID_RESERVATION_AMOUNT');
      amounts.set(entry.tokenId, (amounts.get(entry.tokenId) ?? 0n) + entry.amount);
      const known = tokenAmounts.get(entry.tokenId);
      if (known === undefined || entry.tokenAmount > known) {
        tokenAmounts.set(entry.tokenId, entry.tokenAmount);
      }
    }
    for (const [tokenId, amount] of amounts) {
      if (this.getFreeAmount(tokenId, tokenAmounts.get(tokenId)!) < amount) {
        throw new Error('INSUFFICIENT_FREE_AMOUNT');
      }
    }

    this.reservations.set(reservationId, amounts);
    for (const tokenId of amounts.keys()) {
      let ids = this.tokenIndex.get(tokenId);
      if (!ids) {
        ids = new Set();
        this.tokenIndex.set(tokenId, ids);
      }
      ids.add(reservationId);
    }
  }

  commit(reservationId: string): void {
    this.release(reservationId);
  }

  cancel(reservationId: string): void {
    this.release(reservationId);
  }

  cancelForToken(tokenId: string, excludeReservationId?: string): string[] {
    const ids = this.tokenIndex.get(tokenId);
    if (!ids) return [];
    const cancelled: string[] = [];
    for (const reservationId of [...ids]) {
      if (reservationId === excludeReservationId) continue;
      this.release(reservationId);
      cancelled.push(reservationId);
    }
    return cancelled;
  }

  getFreeAmount(tokenId: string, tokenAmount: bigint): bigint {
    let reserved = 0n;
    const ids = this.tokenIndex.get(tokenId);
    if (ids) {
      for (const reservationId of ids) {
        reserved += this.reservations.get(reservationId)?.get(tokenId) ?? 0n;
      }
    }
    const free = tokenAmount - reserved;
    return free > 0n ? free : 0n;
  }

  clear(): void {
    this.reservations.clear();
    this.tokenIndex.clear();
  }

  private release(reservationId: string): void {
    const amounts = this.reservations.get(reservationId);
    if (!amounts) return;
    this.reservations.delete(reservationId);
    for (const tokenId of amounts.keys()) {
      const ids = this.tokenIndex.get(tokenId);
      if (!ids) continue;
      ids.delete(reservationId);
      if (ids.size === 0) this.tokenIndex.delete(tokenId);
    }
  }
}
