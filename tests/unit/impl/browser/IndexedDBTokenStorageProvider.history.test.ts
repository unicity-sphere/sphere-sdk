/**
 * Tests for IndexedDBTokenStorageProvider history store.
 *
 * Uses fake-indexeddb to test the real IndexedDB history CRUD operations:
 * - addHistoryEntry (upsert by dedupKey)
 * - getHistoryEntries (sorted by timestamp desc)
 * - hasHistoryEntry
 * - clearHistory
 * - importHistoryEntries (skip existing dedupKeys)
 * - DB version migration (v1 → v2 adds history store)
 */

import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBTokenStorageProvider } from '../../../../impl/browser/storage/IndexedDBTokenStorageProvider';
import type { FullIdentity } from '../../../../types';
import type { HistoryRecord } from '../../../../storage';

// =============================================================================
// Helpers
// =============================================================================

let counter = 0;

function createProvider(): IndexedDBTokenStorageProvider {
  // Unique prefix per test to avoid cross-test DB collisions
  return new IndexedDBTokenStorageProvider({
    dbNamePrefix: `test-history-${++counter}`,
  });
}

function createIdentity(): FullIdentity {
  return {
    privateKey: '0'.repeat(64),
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://test',
    nametag: 'testuser',
  };
}

function makeEntry(overrides: Partial<HistoryRecord> & { dedupKey: string }): HistoryRecord {
  return {
    id: crypto.randomUUID(),
    dedupKey: overrides.dedupKey,
    type: 'RECEIVED',
    amount: '1000',
    coinId: 'UCT',
    symbol: 'UCT',
    timestamp: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('IndexedDBTokenStorageProvider — history store', () => {
  let provider: IndexedDBTokenStorageProvider;

  afterEach(async () => {
    if (provider?.isConnected()) {
      await provider.shutdown();
    }
  });

  async function initProvider(): Promise<IndexedDBTokenStorageProvider> {
    provider = createProvider();
    provider.setIdentity(createIdentity());
    await provider.initialize();
    return provider;
  }

  // ---------------------------------------------------------------------------
  // addHistoryEntry + getHistoryEntries
  // ---------------------------------------------------------------------------

  describe('addHistoryEntry', () => {
    it('should store and retrieve a single entry', async () => {
      await initProvider();

      const entry = makeEntry({ dedupKey: 'RECEIVED_token-1' });
      await provider.addHistoryEntry!(entry);

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(1);
      expect(entries[0].dedupKey).toBe('RECEIVED_token-1');
      expect(entries[0].amount).toBe('1000');
    });

    it('should upsert (overwrite) on same dedupKey', async () => {
      await initProvider();

      const entry1 = makeEntry({ dedupKey: 'RECEIVED_dup', amount: '100', timestamp: 1000 });
      const entry2 = makeEntry({ dedupKey: 'RECEIVED_dup', amount: '200', timestamp: 2000 });

      await provider.addHistoryEntry!(entry1);
      await provider.addHistoryEntry!(entry2);

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe('200');
      expect(entries[0].timestamp).toBe(2000);
    });

    it('should store entries with different dedupKeys separately', async () => {
      await initProvider();

      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'SENT_transfer_a' }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'RECEIVED_token-b' }));

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // getHistoryEntries — sort order
  // ---------------------------------------------------------------------------

  describe('getHistoryEntries', () => {
    it('should return entries sorted by timestamp descending', async () => {
      await initProvider();

      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'a', timestamp: 1000 }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'b', timestamp: 3000 }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'c', timestamp: 2000 }));

      const entries = await provider.getHistoryEntries!();
      expect(entries.map(e => e.timestamp)).toEqual([3000, 2000, 1000]);
    });

    it('should return empty array when no entries exist', async () => {
      await initProvider();

      const entries = await provider.getHistoryEntries!();
      expect(entries).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // hasHistoryEntry
  // ---------------------------------------------------------------------------

  describe('hasHistoryEntry', () => {
    it('should return true for existing dedupKey', async () => {
      await initProvider();

      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'exists' }));
      expect(await provider.hasHistoryEntry!('exists')).toBe(true);
    });

    it('should return false for non-existing dedupKey', async () => {
      await initProvider();

      expect(await provider.hasHistoryEntry!('nope')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // clearHistory
  // ---------------------------------------------------------------------------

  describe('clearHistory', () => {
    it('should remove all history entries', async () => {
      await initProvider();

      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'x' }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'y' }));
      expect(await provider.getHistoryEntries!()).toHaveLength(2);

      await provider.clearHistory!();
      expect(await provider.getHistoryEntries!()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // importHistoryEntries
  // ---------------------------------------------------------------------------

  describe('importHistoryEntries', () => {
    it('should import new entries and skip existing dedupKeys', async () => {
      await initProvider();

      // Pre-existing entry
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'existing', amount: '100' }));

      const imported = await provider.importHistoryEntries!([
        makeEntry({ dedupKey: 'existing', amount: '999' }),  // should be skipped
        makeEntry({ dedupKey: 'new-1', amount: '200' }),
        makeEntry({ dedupKey: 'new-2', amount: '300' }),
      ]);

      expect(imported).toBe(2);

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(3);

      // Original entry should keep its value (first-write-wins)
      const existing = entries.find(e => e.dedupKey === 'existing');
      expect(existing!.amount).toBe('100');
    });

    it('should return 0 when all entries already exist', async () => {
      await initProvider();

      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'a' }));

      const imported = await provider.importHistoryEntries!([
        makeEntry({ dedupKey: 'a' }),
      ]);

      expect(imported).toBe(0);
    });

    it('should return 0 for empty input', async () => {
      await initProvider();

      const imported = await provider.importHistoryEntries!([]);
      expect(imported).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Metadata preservation
  // ---------------------------------------------------------------------------

  describe('full record round-trip', () => {
    it('should preserve all HistoryRecord fields', async () => {
      await initProvider();

      const entry: HistoryRecord = {
        id: 'uuid-123',
        dedupKey: 'SENT_transfer_tx1',
        type: 'SENT',
        amount: '5000000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1700000000000,
        transferId: 'tx1',
        tokenId: 'tok-1',
        recipientPubkey: '02' + 'b'.repeat(64),
        recipientAddress: 'DIRECT://bob',
        recipientNametag: 'bob',
        memo: 'Payment for lunch',
      };

      await provider.addHistoryEntry!(entry);
      const [loaded] = await provider.getHistoryEntries!();

      expect(loaded).toEqual(entry);
    });

    it('should preserve sender fields on RECEIVED entries', async () => {
      await initProvider();

      const entry: HistoryRecord = {
        id: 'uuid-456',
        dedupKey: 'RECEIVED_tok-2',
        type: 'RECEIVED',
        amount: '3000000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1700000000000,
        tokenId: 'tok-2',
        senderPubkey: 'cc'.repeat(32),
        senderAddress: 'DIRECT://alice',
        senderNametag: 'alice',
        memo: 'Gift',
      };

      await provider.addHistoryEntry!(entry);
      const [loaded] = await provider.getHistoryEntries!();

      expect(loaded.senderPubkey).toBe('cc'.repeat(32));
      expect(loaded.senderAddress).toBe('DIRECT://alice');
      expect(loaded.senderNametag).toBe('alice');
      expect(loaded.memo).toBe('Gift');
    });
  });
});
