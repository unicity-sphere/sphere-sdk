/**
 * lib/storage/kv-writer — W11-originated-tag KV write helper.
 *
 * Consolidates the ~30-line `setStorageEntry` pattern that today lives
 * in-line in 4 modules (PaymentsModule.ts:16797, AccountingModule.ts:7695,
 * SwapModule.ts:608, CommunicationsModule.ts:1066).
 *
 * Callers pass a W11 `entryType` classification. If the storage provider
 * exposes `setEntry(key, value, entryType)`, we route through it so the
 * OpLog envelope carries an explicit `originated` tag. Providers without
 * envelope-storage (plain IndexedDB / file KV) fall through to plain
 * `set()`; on the first fallback per provider class we log once so a
 * silent loss of W11 stamping during migration is visible in ops.
 *
 * The W11 tag classes (`token_send`, `token_receive`, `cache_index`,
 * `invoice_pay`, `dm_send`, `swap_deposit`, …) are defined by callers.
 * See profile/aggregator-pointer/originated-tag.ts for the authoritative
 * class list.
 */

import type { StorageProvider } from '../../storage';
import { logger } from '../../core/logger';

type OriginatedTag = string;

interface EnvelopeStorage {
  setEntry?: (key: string, value: string, entryType: OriginatedTag) => Promise<void>;
}

const fallbackLoggedProviders: Set<string> = new Set();

/**
 * Write a KV entry with a W11 originated-tag classification.
 *
 * If `storage.setEntry` exists, route through it. Otherwise fall through to
 * plain `storage.set(key, value)` — the write happens either way, only the
 * OpLog stamping differs.
 *
 * @param storage      storage provider (may or may not expose setEntry)
 * @param key          KV key
 * @param value        JSON-serialized value
 * @param entryType    W11 originated-tag class (caller-chosen — do not infer)
 * @param logTag       optional log tag for the fallback-debug line
 */
export async function writeKvEntry(
  storage: StorageProvider,
  key: string,
  value: string,
  entryType: OriginatedTag,
  logTag = 'KV',
): Promise<void> {
  const setEntryFn = (storage as unknown as EnvelopeStorage).setEntry;
  if (typeof setEntryFn === 'function') {
    await setEntryFn.call(storage, key, value, entryType);
    return;
  }
  const providerClass = storage.constructor?.name ?? 'UnknownStorage';
  if (!fallbackLoggedProviders.has(providerClass)) {
    fallbackLoggedProviders.add(providerClass);
    logger.debug(
      logTag,
      `[W11] storage.setEntry not available on ${providerClass}; originated tags will not be stamped ` +
        `(this is expected for plain IndexedDB / file storage, unexpected when ProfileStorageProvider is in the chain).`,
    );
  }
  await storage.set(key, value);
}

/**
 * Test hook — clear the per-class dedup set for the W11 fallback log so
 * unit tests can observe the log line firing.
 */
export function _resetKvWriterFallbackLog(): void {
  fallbackLoggedProviders.clear();
}
