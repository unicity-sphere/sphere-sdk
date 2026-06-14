/**
 * StorageBaselineStore — a DURABLE {@link LocalBaselineStore} over the SDK's
 * key-value {@link StorageProvider} (vault wallet wiring, concern 1).
 *
 * The anti-rollback gate (`load-delta.ts`) persists a wallet-signed baseline
 * `{cursor,root,sig,epoch}` after every clean flush/load. Tests inject an in-memory
 * store, but the WALLET needs a durable one: an in-memory baseline resets each page
 * reload, which silently turns the root gate into a no-op (the first load after every
 * reload trusts the server). This adapter persists the baseline into the same
 * `StorageProvider` (IndexedDB in the browser, file on Node) the wallet already owns.
 *
 * NAMESPACING (fund-safety): the SDK `StorageProvider` only auto-scopes a fixed set
 * of registered per-address keys; an arbitrary key like the baseline is stored
 * GLOBALLY. So this adapter prefixes EVERY key with `network + chainPubkey` itself —
 * otherwise two owners (HD address switch) or two networks would clobber a shared
 * baseline row and a rollback could go undetected. The tracker also passes a
 * pre-namespaced logical key (`vault_baseline:<net>:<owner>`); this adapter's own
 * `network + chainPubkey` prefix is defense-in-depth so the storage row is bound to
 * the owner regardless of what logical key the tracker hands us.
 */

import type { StorageProvider } from '../storage-provider';
import type { LocalBaselineStore } from './load-delta';

/** Stable prefix for every vault baseline row in the underlying StorageProvider. */
export const VAULT_BASELINE_KEY_PREFIX = 'sphere_vault_baseline';

/**
 * Adapts a {@link StorageProvider} into a {@link LocalBaselineStore}, namespacing
 * every key by `network + chainPubkey` so owners/networks never share a baseline.
 */
export class StorageBaselineStore implements LocalBaselineStore {
  private readonly storage: Pick<StorageProvider, 'get' | 'set'>;
  /** The `network:chainPubkey` segment prepended to every logical key. */
  private readonly scope: string;

  constructor(storage: Pick<StorageProvider, 'get' | 'set'>, network: string, chainPubkey: string) {
    this.storage = storage;
    this.scope = `${VAULT_BASELINE_KEY_PREFIX}:${network}:${chainPubkey}`;
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
