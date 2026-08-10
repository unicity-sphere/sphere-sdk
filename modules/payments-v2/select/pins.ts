// #737: the ledger holds exactly the sources of the intents the §6 backstop still
// calls OPEN — adopting what a dead session left open (that spend may be on-chain)
// and dropping what stopped being open (source spent, or ours again).

import type { ReservationLedger } from './ledger';

export interface IntentPinsDeps {
  readonly ledger: ReservationLedger;
  /** Open intents → source tokenIds, re-derived per call; `complete: false` if any could not be. */
  readonly openIntents: () => Promise<{ open: Map<string, string[]>; complete: boolean }>;
  readonly isActive: (transferId: string) => boolean;
  readonly release: (tokenId: string) => void;
  readonly changed: () => void;
}

export class IntentPins {
  private readonly pinned = new Set<string>();

  constructor(private readonly deps: IntentPinsDeps) {}

  /** The keep-open reservation IS this intent's pin from now on. */
  adopt(transferId: string): void {
    this.pinned.add(transferId);
  }

  async sync(): Promise<void> {
    // A throw leaves the ledger unproven — never an empty held-set (#738).
    const { open, complete } = await this.deps.openIntents();
    let changed = false;
    for (const transferId of [...this.pinned]) {
      if (open.has(transferId) || this.deps.isActive(transferId)) continue;
      this.pinned.delete(transferId);
      for (const tokenId of this.deps.ledger.tokensOf(transferId)) this.deps.release(tokenId);
      this.deps.ledger.cancel(transferId);
      changed = true;
    }
    for (const [transferId, tokenIds] of open) {
      if (this.deps.isActive(transferId)) continue;
      this.pinned.add(transferId);
      changed = this.pin(transferId, tokenIds) || changed;
    }
    this.deps.ledger.setAuthoritative(complete);
    if (changed || complete) this.deps.changed();
  }

  /** Every pass, not just on adoption; the free subset, since a partial pin beats none. */
  private pin(transferId: string, tokenIds: readonly string[]): boolean {
    if (this.deps.ledger.tokensOf(transferId).length > 0) return false;
    const free = tokenIds.filter((tokenId) => this.deps.ledger.holderOf(tokenId) === undefined);
    if (free.length === 0) return false;
    this.deps.ledger.reserve(transferId, free.map((tokenId) => ({ tokenId })));
    return true;
  }
}
