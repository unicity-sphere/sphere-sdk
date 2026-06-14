/**
 * StorageCourierJournalStore — a DURABLE {@link CourierJournalStore} over the SDK's
 * key-value {@link StorageProvider} (wallet-courier wiring, concern 1).
 *
 * The {@link CourierDeliveryProvider} persists three things through this small
 * get/set seam: the recipient read pointer, the ACK-PENDING journal, and the
 * sender-side sent-pending journal + watermark. Tests inject an in-memory store,
 * but the WALLET needs a durable one — an in-memory journal resets every reload,
 * which silently re-pulls the whole inbox from `since=0` and forgets which sends
 * are still unconfirmed (so `PENDING_V2_DELIVERIES` could never be GC'd).
 *
 * NAMESPACING (fund-safety, mirrors {@link StorageBaselineStore}): the SDK
 * `StorageProvider` only auto-scopes a fixed set of registered per-address keys; an
 * arbitrary courier-journal key is stored GLOBALLY. So this adapter prefixes EVERY
 * key with `network + chainPubkey` itself — otherwise two owners (HD address switch)
 * or two networks would clobber a shared journal row and a delivery could be lost or
 * a foreign inbox re-pulled. The provider also passes a pre-namespaced logical key
 * (`courier_*:<net>:<owner>`); this adapter's own prefix is defense-in-depth so the
 * storage row is bound to the owner regardless of the logical key handed in.
 */

import type { StorageProvider } from '../../storage/storage-provider';
import type { CourierJournalStore } from './CourierDeliveryProvider';

/** Stable prefix for every courier-journal row in the underlying StorageProvider. */
export const COURIER_JOURNAL_KEY_PREFIX = 'sphere_courier_journal';

/**
 * Adapts a {@link StorageProvider} into a {@link CourierJournalStore}, namespacing
 * every key by `network + chainPubkey` so owners/networks never share a journal.
 */
export class StorageCourierJournalStore implements CourierJournalStore {
  private readonly storage: Pick<StorageProvider, 'get' | 'set'>;
  /** The `network:chainPubkey` segment prepended to every logical key. */
  private readonly scope: string;

  constructor(storage: Pick<StorageProvider, 'get' | 'set'>, network: string, chainPubkey: string) {
    this.storage = storage;
    this.scope = `${COURIER_JOURNAL_KEY_PREFIX}:${network}:${chainPubkey}`;
  }

  get(key: string): Promise<string | null> {
    return this.storage.get(this.scopedKey(key));
  }

  set(key: string, value: string): Promise<void> {
    return this.storage.set(this.scopedKey(key), value);
  }

  /** Bind a logical key to this owner/network so storage rows can never collide. */
  private scopedKey(key: string): string {
    return `${this.scope}:${key}`;
  }
}
