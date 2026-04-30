/**
 * HistoryStore
 *
 * Owns the transaction-history collection persisted under
 * `${addressId}.transactionHistory`. The history collection is part of
 * the SYNCED operational state surface (replicated across devices via
 * OrbitDB) — distinct from the local-only derived `_history` array that
 * the deriver rebuilds from archived tokens on cold-start.
 *
 * This is a thin per-key store: read-modify-write on a single OrbitDB
 * key, with dedup by `dedupKey`. The store does not own its own state
 * — it routes every read/write through the host's encryption-aware
 * `writeProfileKey` / `readProfileKey` helpers so behaviour stays
 * uniform with the rest of the operational state.
 *
 * Cross-seam reads: none. Cross-seam writes: none. The five public
 * methods correspond byte-for-byte to the facade's history API.
 *
 * @module profile/profile-token-storage/history-store
 */

import type { HistoryRecord } from '../../storage/storage-provider.js';
import type { ProfileTokenStorageHost } from './host.js';

export class HistoryStore {
  constructor(private readonly host: ProfileTokenStorageHost) {}

  async addHistoryEntry(entry: HistoryRecord): Promise<void> {
    const entries = await this.getHistoryEntries();

    // Upsert by dedupKey
    const existingIdx = entries.findIndex((e) => e.dedupKey === entry.dedupKey);
    if (existingIdx >= 0) {
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp - a.timestamp);

    await this.host.writeProfileKey(
      `${this.host.getAddressId()}.transactionHistory`,
      JSON.stringify(entries),
    );
  }

  async getHistoryEntries(): Promise<HistoryRecord[]> {
    const raw = await this.host.readProfileKey(
      `${this.host.getAddressId()}.transactionHistory`,
    );
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async hasHistoryEntry(dedupKey: string): Promise<boolean> {
    const entries = await this.getHistoryEntries();
    return entries.some((e) => e.dedupKey === dedupKey);
  }

  async clearHistory(): Promise<void> {
    try {
      await this.host.db.del(`${this.host.getAddressId()}.transactionHistory`);
    } catch {
      // best-effort
    }
  }

  async importHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    const existing = await this.getHistoryEntries();
    const existingKeys = new Set(existing.map((e) => e.dedupKey));
    let imported = 0;

    for (const entry of entries) {
      if (!existingKeys.has(entry.dedupKey)) {
        existing.push(entry);
        existingKeys.add(entry.dedupKey);
        imported++;
      }
    }

    if (imported > 0) {
      existing.sort((a, b) => b.timestamp - a.timestamp);
      await this.host.writeProfileKey(
        `${this.host.getAddressId()}.transactionHistory`,
        JSON.stringify(existing),
      );
    }

    return imported;
  }
}
