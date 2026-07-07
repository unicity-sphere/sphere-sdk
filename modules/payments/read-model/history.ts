/**
 * Read-model — Transaction history submodule.
 *
 * Extracted from PaymentsModule.ts during Phase 5 per docs/uxf/uxfv2-phase-5-
 * payments-disposition.md. Behavior-preserving pure functions + host-shim
 * accessors. The facade `PaymentsModule` retains public method signatures
 * (`getHistory`, `addToHistory`, `loadHistory`, plus the private
 * `resolveSenderInfo` and `importRemoteHistoryEntries`) as one-line
 * delegations to the free functions here.
 *
 * State ownership: the `_historyCache: TransactionHistoryEntry[]` array
 * remains a facade-owned field. Mutating helpers accept the array (or a
 * cache accessor for helpers that must replace it) as an explicit
 * argument so the extraction stays decoupled from `PaymentsModule`
 * internals.
 */

import type {
  HistoryRecord,
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TransportProvider } from '../../../transport';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { logger } from '../../../core/logger';
import {
  resolveSenderInfoViaBinding,
  type ReresolvedNametagSource,
} from '../../../extensions/uxf/pipeline/nametag-reresolver';

/**
 * Public history entry type — same shape as {@link HistoryRecord} in the
 * storage layer. `PaymentsModule` re-exports this alias so external
 * consumers keep working unchanged (`import { TransactionHistoryEntry }
 * from '@unicitylabs/sphere-sdk'`).
 */
export type TransactionHistoryEntry = HistoryRecord;

/** Maximum number of history entries to include in IPFS-synced TXF data. */
export const MAX_SYNCED_HISTORY_ENTRIES = 5000;

/**
 * Compute a dedup key for a history entry.
 *
 * - `SENT` + `transferId` + `coinId` → one entry per coin per transfer
 *   (#149 multi-coin follow-up).
 * - `SENT` + `transferId` → one entry per transfer (legacy / single-coin /
 *   coinId unknown).
 * - `type` + `tokenId` → one entry per token per direction.
 * - fallback → UUID (no dedup possible).
 *
 * The coinId discriminator was added so multi-coin UXF sends produce one
 * SENT row per coin instead of clobbering all but the primary. Existing
 * single-coin entries in storage keep their legacy dedupKey; new entries
 * (post-fix) include the coinId suffix. The two formats are orthogonal —
 * they never collide for the same logical transfer because the
 * transferId is a fresh UUID per send.
 */
export function computeHistoryDedupKey(
  type: string,
  tokenId?: string,
  transferId?: string,
  coinId?: string,
): string {
  if (type === 'SENT' && transferId) {
    return coinId
      ? `${type}_transfer_${transferId}_${coinId}`
      : `${type}_transfer_${transferId}`;
  }
  if (tokenId) return `${type}_${tokenId}`;
  return `${type}_${crypto.randomUUID()}`;
}

/**
 * Return the history cache sorted newest-first. Defensive copy — never
 * mutates the input.
 */
export function getHistoryDescending(
  cache: readonly TransactionHistoryEntry[],
): TransactionHistoryEntry[] {
  return [...cache].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Thin wrapper over {@link resolveSenderInfoViaBinding}. Kept as a
 * distinct symbol so the facade's public shape (`resolveSenderInfo`) can
 * delegate to a single well-named entry point rather than importing the
 * extension-layer helper directly from PaymentsModule.
 *
 * See UXF transfer protocol §3.1 / §5.6 / §9.3 for the re-resolution
 * policy — payload-supplied nametags MUST NOT be trusted; the AUTHENTICATED
 * Nostr signing pubkey is the lookup key.
 */
export async function resolveSenderInfo(
  senderTransportPubkey: string,
  payloadSenderNametag: string | undefined,
  transport: TransportProvider | undefined,
): Promise<{
  senderAddress?: string;
  senderNametag?: string;
  senderNametagSource: ReresolvedNametagSource;
}> {
  return resolveSenderInfoViaBinding(
    senderTransportPubkey,
    payloadSenderNametag,
    transport,
  );
}

/**
 * Host shim for {@link addHistoryEntry}. Provides the mutable state
 * seams that the facade owns.
 */
export interface AddHistoryEntryHost {
  ensureInitialized(): void;
  getLocalTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null;
  emitHistoryUpdated(entry: TransactionHistoryEntry): void;
}

/**
 * Append a history entry to the local cache and persist via the local
 * token-storage provider's `addHistoryEntry` seam.
 *
 * Preserves the facade's original semantics:
 *   - `id` + `dedupKey` are auto-generated.
 *   - Existing entry with the same `dedupKey` is replaced in place;
 *     otherwise appended.
 *   - Persistence is best-effort — if the provider does not expose
 *     `addHistoryEntry`, the cache is still updated in memory.
 *   - Emits `history:updated` after in-memory + persisted state converge.
 */
export async function addHistoryEntry(
  host: AddHistoryEntryHost,
  cache: TransactionHistoryEntry[],
  entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>,
): Promise<void> {
  host.ensureInitialized();

  const dedupKey = computeHistoryDedupKey(
    entry.type,
    entry.tokenId,
    entry.transferId,
    entry.coinId,
  );
  const historyEntry: TransactionHistoryEntry = {
    id: crypto.randomUUID(),
    dedupKey,
    ...entry,
  };

  const provider = host.getLocalTokenStorageProvider();
  if (provider?.addHistoryEntry) {
    await provider.addHistoryEntry(historyEntry);
  }

  const existingIdx = cache.findIndex((e) => e.dedupKey === dedupKey);
  if (existingIdx >= 0) {
    cache[existingIdx] = historyEntry;
  } else {
    cache.push(historyEntry);
  }

  host.emitHistoryUpdated(historyEntry);
}

/**
 * Host shim for {@link loadHistoryEntries}.
 */
export interface LoadHistoryHost {
  getLocalTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null;
  readonly storage: StorageProvider;
}

/**
 * Load the transaction history from the local token-storage provider,
 * performing a one-time migration from legacy KV storage on the first
 * call after upgrade.
 *
 * Returns the final cache — the caller is expected to assign it to its
 * `_historyCache` field. This shape matches the facade's original
 * pre-split behavior (`this._historyCache = await loadHistory(...)`).
 */
export async function loadHistoryEntries(
  host: LoadHistoryHost,
): Promise<TransactionHistoryEntry[]> {
  const provider = host.getLocalTokenStorageProvider();
  if (provider?.getHistoryEntries) {
    let cache = await provider.getHistoryEntries();

    // One-time migration from legacy KV storage
    const legacyData = await host.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
    if (legacyData) {
      try {
        const legacyEntries = JSON.parse(legacyData) as TransactionHistoryEntry[];
        // Ensure legacy entries have dedupKeys for import
        const records = legacyEntries.map((e) => ({
          ...e,
          dedupKey:
            e.dedupKey ||
            computeHistoryDedupKey(e.type, e.tokenId, e.transferId, e.coinId),
        }));
        const imported = (await provider.importHistoryEntries?.(records)) ?? 0;
        if (imported > 0) {
          cache = await provider.getHistoryEntries();
          logger.debug(
            'Payments',
            `Migrated ${imported} history entries from KV to history store`,
          );
        }
        // Delete legacy key after successful migration
        await host.storage.remove(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
      } catch {
        // Ignore corrupt legacy data
      }
    }
    return cache;
  }

  // Fallback: load from KV storage (no dedicated provider)
  const historyData = await host.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
  if (historyData) {
    try {
      return JSON.parse(historyData) as TransactionHistoryEntry[];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Host shim for {@link importRemoteHistoryEntriesInto}.
 */
export interface ImportRemoteHistoryEntriesHost {
  getLocalTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null;
}

/**
 * Result of a remote history import.
 *
 * - `imported` — the number of new entries admitted (same semantics as
 *   the facade's original return value).
 * - `newCache` — present only when the provider path fully replaced the
 *   cache. When absent, the caller's `cache` array was mutated in place
 *   via the in-memory fallback merge.
 */
export interface ImportRemoteHistoryEntriesResult {
  readonly imported: number;
  readonly newCache?: TransactionHistoryEntry[];
}

/**
 * Import history entries fetched from remote TXF data.
 *
 * Prefers the local TokenStorageProvider's `importHistoryEntries` seam;
 * falls back to an in-memory `dedupKey`-set merge when the provider does
 * not implement the seam.
 *
 * Reused by both `load()` (initial IPFS fetch) and `_doSync()` (merge
 * result). The `cache` array is treated as mutable for the fallback path;
 * the provider path returns a fresh array via {@link
 * ImportRemoteHistoryEntriesResult.newCache}, and the caller is expected
 * to replace its cache reference when present.
 */
export async function importRemoteHistoryEntriesInto(
  host: ImportRemoteHistoryEntriesHost,
  cache: TransactionHistoryEntry[],
  entries: HistoryRecord[],
): Promise<ImportRemoteHistoryEntriesResult> {
  if (entries.length === 0) return { imported: 0 };

  const provider = host.getLocalTokenStorageProvider();
  if (provider?.importHistoryEntries) {
    const imported = await provider.importHistoryEntries(entries);
    if (imported > 0) {
      // Reload cache from provider to stay in sync
      const newCache = await provider.getHistoryEntries!();
      return { imported, newCache };
    }
    return { imported };
  }

  // Fallback: merge into in-memory cache by dedupKey
  const existingKeys = new Set(cache.map((e) => e.dedupKey));
  let imported = 0;
  for (const entry of entries) {
    if (!existingKeys.has(entry.dedupKey)) {
      cache.push(entry);
      existingKeys.add(entry.dedupKey);
      imported++;
    }
  }
  return { imported };
}
