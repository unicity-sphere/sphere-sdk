/**
 * KV-writer helper — W11 originated-tag stamp adapter.
 *
 * Extracted from `PaymentsModule.setStorageEntry` during Phase 5 per
 * uxfv2-phase-5-payments-disposition.md §"Persistence codec". This is
 * the storage-layer originated-tag stamping helper — see SPEC §10.2.3
 * and profile/aggregator-pointer/originated-tag.ts for the tagging
 * classification.
 *
 * Behavior-preserving pure function: the facade retains its private
 * `setStorageEntry(key, value, type)` signature unchanged and delegates
 * here. Callers MUST choose the classification at the call site — the
 * helper does NOT infer. Mis-classification is caught by
 * `assertOriginTagLocal` inside the storage layer and surfaced as
 * SECURITY_ORIGIN_MISMATCH.
 *
 * A dedup Set for the W11 fallback log lives here (was
 * `PaymentsModule._w11FallbackLogged`) so the "provider lacks
 * envelope-storage" note is logged once per provider class, not once
 * per write.
 */

import type { StorageProvider } from '../../../storage';
import { logger } from '../../../core/logger';

/**
 * The three originated-tag classifications the write path stamps. Callers
 * MUST choose the classification at the call site — the helper does NOT
 * infer.
 */
export type EntryTag = 'token_send' | 'token_receive' | 'cache_index';

/**
 * Dedup set for the W11 fallback log below. One entry per provider class
 * — subsequent writes from the same class are silent to avoid log spam.
 */
const w11FallbackLogged: Set<string> = new Set();

/**
 * Stamp an originated-tag on a KV entry when the provider exposes an
 * envelope-storage layer (i.e. a `setEntry(key, value, entryType)`
 * method). Providers without envelope-storage (plain IndexedDB / file
 * KV) fall through to plain `set(key, value)` — semantics are
 * identical, only the peer-replicated classification differs.
 *
 * A missing `setEntry` is logged ONCE per provider class so a silent
 * loss of W11 stamping during a migration is visible in ops, then
 * silent thereafter.
 */
export async function writeKvEntry(
  storage: StorageProvider,
  key: string,
  value: string,
  entryType: EntryTag,
): Promise<void> {
  const setEntryFn = (
    storage as {
      setEntry?: (k: string, v: string, t: string) => Promise<void>;
    }
  ).setEntry;
  if (typeof setEntryFn === 'function') {
    await setEntryFn.call(storage, key, value, entryType);
    return;
  }
  // Fallback: provider has no envelope-storage layer (plain IndexedDB
  // / file KV). Log once per provider-class so a silent loss of W11
  // stamping during a migration is visible in ops. Subsequent calls
  // from the same class are silent to avoid log spam.
  const providerClass = storage.constructor?.name ?? 'UnknownStorage';
  if (!w11FallbackLogged.has(providerClass)) {
    w11FallbackLogged.add(providerClass);
    logger.debug(
      'Payments',
      `[W11] storage.setEntry not available on ${providerClass}; originated tags will not be stamped ` +
        `(this is expected for plain IndexedDB / file storage, unexpected when ProfileStorageProvider is in the chain).`,
    );
  }
  await storage.set(key, value);
}
