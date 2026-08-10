// §5.4 Reservations — whole-token set semantics, fully synchronous. The queue
// reserves whole tokens only (doc §5.4), so a token is either free or held by
// exactly one reservation; partial-amount arithmetic was dead surface (#727).

export interface ReservationRequest {
  readonly tokenId: string;
}

export class ReservationLedger {
  private readonly reservations = new Map<string, ReadonlySet<string>>();
  private readonly tokenHolder = new Map<string, string>();
  // #738: the held-set is RECONSTRUCTED from the open intents, so until
  // IntentPins proves every one of them "no holder" means unknown, not free.
  private authoritative = false;

  /** Sole writer: IntentPins.sync(), true only if it reconstructed every open intent. */
  setAuthoritative(value: boolean): void {
    this.authoritative = value;
  }

  /** Non-null while the held-set is unproven: nothing plans, nothing reads free. */
  unprovenReason(): string | null {
    return this.authoritative
      ? null
      : 'Cannot yet verify which tokens are held by transfers still converging — spending is paused until that check succeeds';
  }

  // All-or-nothing: every entry is validated before any state mutates.
  reserve(reservationId: string, entries: readonly ReservationRequest[]): void {
    if (entries.length === 0) throw new Error('EMPTY_RESERVATION');
    if (this.reservations.has(reservationId)) throw new Error('DUPLICATE_RESERVATION_ID');
    const tokenIds = new Set(entries.map((e) => e.tokenId));
    for (const tokenId of tokenIds) {
      if (this.tokenHolder.has(tokenId)) throw new Error('INSUFFICIENT_FREE_AMOUNT');
    }
    this.reservations.set(reservationId, tokenIds);
    for (const tokenId of tokenIds) this.tokenHolder.set(tokenId, reservationId);
  }

  commit(reservationId: string): void {
    this.release(reservationId);
  }

  cancel(reservationId: string): void {
    this.release(reservationId);
  }

  cancelForToken(tokenId: string, excludeReservationId?: string): string[] {
    const holder = this.tokenHolder.get(tokenId);
    if (holder === undefined || holder === excludeReservationId) return [];
    this.release(holder);
    return [holder];
  }

  getFreeAmount(tokenId: string, tokenAmount: bigint): bigint {
    return this.tokenHolder.has(tokenId) ? 0n : tokenAmount;
  }

  /** #737: who pins this token — the reporting side reads it so a held token is never called spendable. */
  holderOf(tokenId: string): string | undefined {
    return this.tokenHolder.get(tokenId);
  }

  tokensOf(reservationId: string): readonly string[] {
    return [...(this.reservations.get(reservationId) ?? [])];
  }

  clear(): void {
    this.reservations.clear();
    this.tokenHolder.clear();
  }

  private release(reservationId: string): void {
    const tokenIds = this.reservations.get(reservationId);
    if (!tokenIds) return;
    this.reservations.delete(reservationId);
    for (const tokenId of tokenIds) this.tokenHolder.delete(tokenId);
  }
}
