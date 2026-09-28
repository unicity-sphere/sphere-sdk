import type { BurnResult } from './api';
import type { InventoryView } from './inventory/InventoryView';
import type { ListStore } from './machine/journal';
import { messageOf } from './machine/payload';
import type { ReservationLedger } from './select/ledger';
import type { IntentPins } from './select/pins';
import type { SpendQueue } from './select/queue';
import { isLiveBurn, type BurnJournalEntry } from './stores';

export interface BurnHoldDeps {
  readonly queue: Pick<SpendQueue, 'planWhole' | 'notifyChange'>;
  readonly ledger: Pick<ReservationLedger, 'commit' | 'cancel'>;
  readonly view: Pick<InventoryView, 'markInFlightMany' | 'releaseMany' | 'delta'>;
  readonly pins: Pick<IntentPins, 'adopt'>;
  readonly burnJournal: Pick<ListStore<BurnJournalEntry>, 'getByKey'>;
  readonly track: (op: Promise<unknown>) => void;
}

/** A burn's token is reserved like a whole send's source, and stays pinned while its journal entry is live. */
export class BurnHold {
  constructor(private readonly deps: BurnHoldDeps) {}

  async run(burnId: string, tokenId: string, burn: () => Promise<BurnResult>): Promise<BurnResult> {
    try {
      this.deps.queue.planWhole(burnId, tokenId);
    } catch (err) {
      return { success: false, burnId, tokenId, error: messageOf(err) };
    }
    this.deps.view.markInFlightMany([tokenId]);
    let burned = false;
    try {
      const result = await burn();
      burned = result.success;
      return result;
    } finally {
      await this.settle(burnId, tokenId, burned);
    }
  }

  private async settle(burnId: string, tokenId: string, burned: boolean): Promise<void> {
    if (burned) {
      this.deps.ledger.commit(burnId);
      this.deps.track(this.refreshThenRelease(tokenId));
      return;
    }
    const entry = await this.deps.burnJournal.getByKey(burnId).catch(() => null);
    if (entry === undefined || (entry !== null && !isLiveBurn(entry))) {
      this.deps.ledger.cancel(burnId);
      this.deps.view.releaseMany([tokenId]);
      this.deps.queue.notifyChange('');
      return;
    }
    this.deps.pins.adopt(burnId);
  }

  private async refreshThenRelease(tokenId: string): Promise<void> {
    try {
      await this.deps.view.delta();
      this.deps.view.releaseMany([tokenId]);
    } finally {
      this.deps.queue.notifyChange('');
    }
  }
}
