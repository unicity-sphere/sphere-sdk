/**
 * Transaction history: the cache, the dedupKey rules, the §10 client-written
 * server log and the local/legacy-KV read paths. The token map and `save()`
 * stay in PaymentsModule, reached via {@link TransferHistoryHost}.
 */

import type { HistoryRecord, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type {
  PaymentsModuleDependencies,
  PaymentsWalletApiPort,
  TransactionHistoryEntry,
  WalletApiHistoryRecord,
} from '../PaymentsModule';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { logger } from '../../../core/logger';
import { randomUUID } from '../../../core/uuid';
import { encryptField, decryptField } from '../../../core/field-encryption';

/**
 * Compute a dedup key for a history entry.
 * - SENT + transferId → groups multi-token sends into a single entry
 * - type + tokenId → one entry per token per direction
 * - fallback → UUID (no dedup possible)
 */
function computeHistoryDedupKey(type: string, tokenId?: string, transferId?: string, stateHash?: string): string {
  if (type === 'SENT' && transferId) return `${type}_transfer_${transferId}`;
  // A genesis token can be RECEIVED more than once at DIFFERENT states (a self-send or an
  // A→B→A round-trip re-acquires it). Include the received state so each leg is a distinct
  // receipt instead of upserting the same `RECEIVED_v2_<genesisId>` key — otherwise repeated
  // re-acquires undercount received history and stop netting against their SENT records.
  if (tokenId && stateHash) return `${type}_${tokenId}_${stateHash}`;
  if (tokenId) return `${type}_${tokenId}`;
  return `${type}_${randomUUID()}`;
}

/**
 * Cap on the number of newest-first keyset pages pulled when rebuilding history
 * from the server on reload (the wallet-api composition). At the §16 page limit
 * this bounds a single hydration well past any realistic wallet's recent
 * history while staying finite if the server ever mis-reports `more`.
 */
const MAX_HISTORY_HYDRATION_PAGES = 100;

/**
 * Force a FULL history re-pull every N incremental pulls (#642). The
 * incremental stop condition assumes the server's keyset order matches arrival
 * order (append-only log); if a row ever lands "behind" already-pulled pages
 * (backdated ts, cross-device clock skew), the periodic full pull bounds how
 * long it can stay invisible (~N × the 30s poll interval).
 */
const FULL_HISTORY_REPULL_EVERY = 20;

/**
 * The exact PaymentsModule members this feature reaches back for. Deliberately
 * narrow: no token map, no `save()` — history never becomes a second writer of
 * the module's core state.
 */
export interface TransferHistoryHost {
  /** Live dependency handle (identity / storage / emitEvent / walletApi); null before initialize(). */
  readonly deps: PaymentsModuleDependencies | null;
  /** Throws unless the module has dependencies. */
  ensureInitialized(): void;
  /** The first local token storage provider — the durable `history` store in own-storage compositions. */
  getLocalTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null;
  /** S6 field-encryption key for this identity (memo + counterparty-nametag envelopes). */
  getFieldEncryptionKey(): Uint8Array;
  /** Registry lookup for the display symbol of a coin id. */
  getCoinSymbol(coinId: string): string;
}

export class TransferHistory {
  private _historyCache: TransactionHistoryEntry[] = [];

  /**
   * Owner (chainPubkey) whose server history hydration last completed —
   * enables the #642 incremental fast path in {@link hydrateHistoryFromServer}.
   * Reset on re-init (address switch). `serverSeenHistoryKeys` holds only
   * dedupKeys actually PULLED from the server (never locally-POSTed ones), so
   * the incremental stop condition can't be masked by our own fresh POSTs;
   * `incrementalHistoryPulls` forces a periodic full re-pull to bound the
   * staleness window if server keyset order ever diverges from arrival order.
   * `hydrationEpoch` guards a pull racing a same-owner re-init.
   */
  private historyHydratedFor: string | null = null;
  private serverSeenHistoryKeys = new Set<string>();
  private incrementalHistoryPulls = 0;
  private hydrationEpoch = 0;

  constructor(private readonly host: TransferHistoryHost) {}

  // ===========================================================================
  // Lifecycle (driven by PaymentsModule.initialize)
  // ===========================================================================

  /**
   * Reset per-address history state (re-populated by {@link loadHistory}) and
   * bump the hydration epoch so a pull in flight for the previous identity
   * discards its result instead of pinning a stale cache.
   */
  initialize(): void {
    this._historyCache = [];
    this.historyHydratedFor = null;
    this.serverSeenHistoryKeys = new Set();
    this.incrementalHistoryPulls = 0;
    this.hydrationEpoch++;
  }

  // ===========================================================================
  // Public API - Transaction History
  // ===========================================================================

  /**
   * Get the transaction history sorted newest-first.
   *
   * @returns Array of {@link TransactionHistoryEntry} objects in descending timestamp order.
   */
  getHistory(): TransactionHistoryEntry[] {
    return [...this._historyCache].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Append an entry to the transaction history.
   *
   * A unique `id` and `dedupKey` are auto-generated. The entry is persisted to
   * the local token storage provider's `history` store (IndexedDB / file).
   * Duplicate entries with the same `dedupKey` are silently ignored (upsert).
   *
   * @param entry - History entry fields (without `id` and `dedupKey`).
   */
  async addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void> {
    this.host.ensureInitialized();

    const dedupKey = computeHistoryDedupKey(entry.type, entry.tokenId, entry.transferId, entry.stateHash);
    const historyEntry: TransactionHistoryEntry = {
      id: randomUUID(),
      dedupKey,
      ...entry,
    };

    // Persist to the local token storage provider's history store
    const provider = this.host.getLocalTokenStorageProvider();
    if (provider?.addHistoryEntry) {
      await provider.addHistoryEntry(historyEntry);
    }

    // Update in-memory cache (replace if same dedupKey, else append)
    const existingIdx = this._historyCache.findIndex(e => e.dedupKey === dedupKey);
    if (existingIdx >= 0) {
      this._historyCache[existingIdx] = historyEntry;
    } else {
      this._historyCache.push(historyEntry);
    }

    // §10: the server-side history log is CLIENT-written (the server never
    // writes rows), deduped by dedupKey. Memo + counterparty nametag are S6
    // envelopes — the operator never sees plaintext (§8.3). Best-effort: a
    // failed POST never fails the money path; the record stays local.
    const walletApi = this.host.deps!.walletApi;
    // §16 wire shape (strict server-side zod; caught drifting by the phase-2
    // harness — the fake had accepted the module's internal shape):
    //  - `id` (uuid) + `ts` (ISO-8601), never `timestamp`;
    //  - `type` is the §16 enum — anything else stays local-only;
    //  - `tokenId` is the genesis-stable lowercase hex (strip the `v2_` UI prefix);
    //  - `counterpartyPubkey` only when it IS a 33-byte compressed pubkey.
    const postableType = historyEntry.type === 'SENT' || historyEntry.type === 'RECEIVED' || historyEntry.type === 'MINT';
    if (walletApi && postableType) {
      try {
        const fieldKey = this.host.getFieldEncryptionKey();
        const counterpartyNametag = historyEntry.recipientNametag ?? historyEntry.senderNametag;
        const wireTokenId = historyEntry.tokenId?.replace(/^v2_/, '');
        const counterparty = historyEntry.recipientPubkey ?? historyEntry.senderPubkey;
        await walletApi.postHistoryRecords([
          {
            dedupKey: historyEntry.dedupKey,
            id: randomUUID(),
            type: historyEntry.type,
            ts: new Date(historyEntry.timestamp).toISOString(),
            assets: [{ coinId: historyEntry.coinId, amount: historyEntry.amount }],
            ...(historyEntry.transferId !== undefined ? { transferId: historyEntry.transferId } : {}),
            ...(wireTokenId !== undefined && /^(?:[0-9a-f]{2}){1,64}$/.test(wireTokenId)
              ? { tokenId: wireTokenId }
              : {}),
            ...(counterparty !== undefined && /^0[23][0-9a-f]{64}$/.test(counterparty)
              ? { counterpartyPubkey: counterparty }
              : {}),
            ...(historyEntry.memo !== undefined ? { memo: encryptField(fieldKey, historyEntry.memo) } : {}),
            ...(counterpartyNametag !== undefined
              ? { counterpartyNametag: encryptField(fieldKey, counterpartyNametag) }
              : {}),
          },
        ]);
      } catch (err) {
        logger.warn('Payments', 'history POST failed (kept locally; dedupKey makes retry safe):', err);
      }
    }

    // Notify listeners that a history entry was saved
    this.host.deps!.emitEvent('history:updated', historyEntry);
  }

  /**
   * Load history into the in-memory cache.
   *
   * In the wallet-api composition (the `walletApi` client is present) the
   * durable §10 history log lives on the SERVER — the thin storage provider
   * keeps none — so the cache is rebuilt from `walletApi.listHistory()`. The
   * twin of the #521 inventory reload bug: `_historyCache` is process-lifetime,
   * so a reload (tab refresh) must re-pull it or render an empty history.
   * Compositions WITHOUT `walletApi` keep the legacy local path below.
   */
  async loadHistory(): Promise<void> {
    if (this.host.deps!.walletApi?.listHistory) {
      await this.hydrateHistoryFromServer(this.host.deps!.walletApi);
      return;
    }
    const provider = this.host.getLocalTokenStorageProvider();
    if (provider?.getHistoryEntries) {
      this._historyCache = await provider.getHistoryEntries();

      // One-time migration from legacy KV storage
      const legacyData = await this.host.deps!.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
      if (legacyData) {
        try {
          const legacyEntries = JSON.parse(legacyData) as TransactionHistoryEntry[];
          // Ensure legacy entries have dedupKeys for import
          const records = legacyEntries.map(e => ({
            ...e,
            dedupKey: e.dedupKey || computeHistoryDedupKey(e.type, e.tokenId, e.transferId),
          }));
          const imported = await provider.importHistoryEntries?.(records) ?? 0;
          if (imported > 0) {
            this._historyCache = await provider.getHistoryEntries();
            logger.debug('Payments', `Migrated ${imported} history entries from KV to history store`);
          }
          // Delete legacy key after successful migration
          await this.host.deps!.storage.remove(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
        } catch {
          // Ignore corrupt legacy data
        }
      }
    } else {
      // Fallback: load from KV storage (no dedicated provider)
      const historyData = await this.host.deps!.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
      if (historyData) {
        try {
          this._historyCache = JSON.parse(historyData);
        } catch {
          this._historyCache = [];
        }
      }
    }
  }

  /**
   * Rebuild `_historyCache` from the server's §10 history log (the wallet-api
   * composition). Pages newest-first via the keyset cursor until `more:false`
   * or the page cap; dedups by `dedupKey` (a hydrate-then-receive in the same
   * session must not double-list). The S6 `memo` / `counterpartyNametag`
   * envelopes are decrypted with the owner's own field key on the way in.
   *
   * #642 incremental fast path: after one completed hydration for this owner,
   * later pulls stop at the first non-empty page holding nothing new — the
   * §10 log is append-only (newest-first keyset), so everything past a fully
   * known page is already cached. The steady-state 30s inventory resync then
   * costs ONE history page instead of a full re-pagination (which on a wallet
   * whose history overflows the page cap was 100 pages, every tick, forever).
   *
   * Best-effort, like the §10 history POST: history is untrusted DISPLAY data,
   * so a backend outage during hydration must NEVER fail `load()` (the money
   * path) — the in-session cache is left intact and the pull retries next load.
   */
  private async hydrateHistoryFromServer(api: PaymentsWalletApiPort): Promise<void> {
    // #583 defense-in-depth owner guard: capture the owner this hydration ran
    // for and refuse to OVERWRITE `_historyCache` if the module's identity
    // changed under us (a re-init mid-pull). Per-address isolation pins the
    // client per owner so this can't normally happen; the guard ensures a stale
    // pull never replaces the active owner's history with another owner's.
    const owner = this.host.deps!.identity.chainPubkey;
    // Also guard against a SAME-owner re-init racing this pull (the epoch is
    // bumped by initialize()): a truncated incremental prefix written after
    // the re-init cleared the cache would otherwise be pinned as "hydrated".
    const epoch = this.hydrationEpoch;
    // Incremental only against dedupKeys actually PULLED from the server —
    // a locally-POSTed key must not make a page look "fully known" before the
    // pull has ever seen the server's copy. Bounded by the periodic full
    // re-pull (see FULL_HISTORY_REPULL_EVERY).
    const known = this.historyHydratedFor === owner &&
      this.serverSeenHistoryKeys.size > 0 &&
      this.incrementalHistoryPulls < FULL_HISTORY_REPULL_EVERY
      ? this.serverSeenHistoryKeys
      : null;
    const byDedupKey = new Map<string, TransactionHistoryEntry>();
    const pulledKeys = new Set<string>();
    // True when the pull is CONTIGUOUS with what we already hold — it reached
    // the log's end or a fully-known page. Only then may the pulled prefix be
    // merged into the cache; a pull cut off by the page cap must replace it
    // instead (merging would hide the gap between the prefix and the cache).
    let contiguous = false;
    try {
      let before: string | undefined;
      for (let page = 0; page < MAX_HISTORY_HYDRATION_PAGES; page++) {
        const result = await api.listHistory(before !== undefined ? { before } : {});
        let unknown = 0;
        for (const wire of result.records) {
          pulledKeys.add(wire.dedupKey);
          if (known && !known.has(wire.dedupKey)) unknown++;
          if (!byDedupKey.has(wire.dedupKey)) {
            byDedupKey.set(wire.dedupKey, this.historyEntryFromWire(wire));
          }
        }
        if (known && result.records.length > 0 && unknown === 0) {
          contiguous = true;
          break;
        }
        if (!result.more || result.cursor === null) {
          contiguous = true;
          break;
        }
        before = result.cursor;
      }
    } catch (err) {
      logger.warn('Payments', 'history hydration from server failed (kept in-memory; retries next load):', err);
      return;
    }
    if (this.host.deps!.identity.chainPubkey !== owner || this.hydrationEpoch !== epoch) {
      logger.warn('Payments', 'history hydration owner/epoch changed mid-pull — discarding stale result (owner guard)');
      return;
    }
    if (known && contiguous) {
      // Merge: keep cached entries the pull stopped short of (older pages) and
      // local-only entries whose §10 POST hasn't landed server-side yet.
      // Display order is unaffected — getHistory() sorts by timestamp.
      for (const e of this._historyCache) {
        if (!byDedupKey.has(e.dedupKey)) byDedupKey.set(e.dedupKey, e);
      }
      this.incrementalHistoryPulls++;
      for (const k of pulledKeys) this.serverSeenHistoryKeys.add(k);
    } else {
      // Full pull (or an incremental one cut off by the page cap, which
      // degenerates to a replace): the server view IS the pulled set.
      this.incrementalHistoryPulls = 0;
      this.serverSeenHistoryKeys = pulledKeys;
    }
    this._historyCache = [...byDedupKey.values()];
    this.historyHydratedFor = owner;
  }

  /**
   * Map one §16 history wire record onto the display
   * {@link TransactionHistoryEntry}. `counterpartyNametag` lands on the role-
   * appropriate field (sender for RECEIVED, recipient otherwise); the S6 memo +
   * nametag envelopes decrypt under THIS wallet's field key (self-scoped at
   * rest — §8.3), surfaced as absent if they don't decrypt rather than as
   * ciphertext (same rule as mailbox/payment-request memos).
   */
  private historyEntryFromWire(wire: WalletApiHistoryRecord): TransactionHistoryEntry {
    const asset = wire.assets[0];
    const coinId = asset?.coinId ?? '';
    const received = wire.type === 'RECEIVED';
    const memo = this.tryDecryptField(wire.memo);
    const nametag = this.tryDecryptField(wire.counterpartyNametag);
    return {
      id: wire.id,
      dedupKey: wire.dedupKey,
      type: wire.type as TransactionHistoryEntry['type'],
      amount: asset?.amount ?? '0',
      coinId,
      symbol: this.host.getCoinSymbol(coinId),
      timestamp: Date.parse(wire.ts),
      ...(wire.transferId !== undefined ? { transferId: wire.transferId } : {}),
      ...(wire.tokenId !== undefined ? { tokenId: wire.tokenId } : {}),
      ...(wire.counterpartyPubkey !== undefined
        ? received
          ? { senderPubkey: wire.counterpartyPubkey }
          : { recipientPubkey: wire.counterpartyPubkey }
        : {}),
      ...(nametag !== undefined
        ? received
          ? { senderNametag: nametag }
          : { recipientNametag: nametag }
        : {}),
      ...(memo !== undefined ? { memo } : {}),
    };
  }

  /** S6 field decrypt that surfaces an undecryptable envelope as absent (§8.3). */
  private tryDecryptField(envelope?: string): string | undefined {
    if (envelope === undefined) return undefined;
    try {
      return decryptField(this.host.getFieldEncryptionKey(), envelope);
    } catch {
      return undefined;
    }
  }

  /**
   * Import history entries from remote TXF data into local store.
   * Delegates to the local TokenStorageProvider's importHistoryEntries() for
   * persistent storage, with in-memory fallback.
   * Reused by both load() (initial IPFS fetch) and _doSync() (merge result).
   */
  async importRemoteHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    if (entries.length === 0) return 0;

    const provider = this.host.getLocalTokenStorageProvider();
    if (provider?.importHistoryEntries) {
      const imported = await provider.importHistoryEntries(entries);
      if (imported > 0) {
        // Reload cache from provider to stay in sync
        this._historyCache = await provider.getHistoryEntries!();
      }
      return imported;
    }

    // Fallback: merge into in-memory cache by dedupKey
    const existingKeys = new Set(this._historyCache.map(e => e.dedupKey));
    let imported = 0;
    for (const entry of entries) {
      if (!existingKeys.has(entry.dedupKey)) {
        this._historyCache.push(entry);
        existingKeys.add(entry.dedupKey);
        imported++;
      }
    }
    return imported;
  }
}
