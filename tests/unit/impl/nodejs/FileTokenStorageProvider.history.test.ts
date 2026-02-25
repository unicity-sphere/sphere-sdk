/**
 * Tests for FileTokenStorageProvider history store.
 *
 * Uses real filesystem (tmp directory) to test file-based history CRUD:
 * - addHistoryEntry (upsert by dedupKey)
 * - getHistoryEntries (sorted by timestamp desc)
 * - hasHistoryEntry
 * - clearHistory
 * - importHistoryEntries (skip existing dedupKeys)
 * - _history.json file structure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileTokenStorageProvider } from '../../../../impl/nodejs/storage/FileTokenStorageProvider';
import type { FullIdentity } from '../../../../types';
import type { HistoryRecord } from '../../../../storage';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

function createProvider(): FileTokenStorageProvider {
  return new FileTokenStorageProvider({ tokensDir: tmpDir });
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

describe('FileTokenStorageProvider — history store', () => {
  let provider: FileTokenStorageProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-history-test-'));
    provider = createProvider();
    provider.setIdentity(createIdentity());
    await provider.initialize(); // creates the per-identity subdirectory
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // addHistoryEntry + getHistoryEntries
  // ---------------------------------------------------------------------------

  describe('addHistoryEntry', () => {
    it('should store and retrieve a single entry', async () => {
      const entry = makeEntry({ dedupKey: 'RECEIVED_token-1' });
      await provider.addHistoryEntry!(entry);

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(1);
      expect(entries[0].dedupKey).toBe('RECEIVED_token-1');
      expect(entries[0].amount).toBe('1000');
    });

    it('should upsert (overwrite) on same dedupKey', async () => {
      const entry1 = makeEntry({ dedupKey: 'RECEIVED_dup', amount: '100', timestamp: 1000 });
      const entry2 = makeEntry({ dedupKey: 'RECEIVED_dup', amount: '200', timestamp: 2000 });

      await provider.addHistoryEntry!(entry1);
      await provider.addHistoryEntry!(entry2);

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe('200');
    });

    it('should create _history.json file in per-identity tokensDir', async () => {
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'file-check' }));

      // FileTokenStorageProvider stores under {baseDir}/{addressId}/
      const addressSubdir = fs.readdirSync(tmpDir).find(f =>
        fs.statSync(path.join(tmpDir, f)).isDirectory(),
      )!;
      const historyPath = path.join(tmpDir, addressSubdir, '_history.json');
      expect(fs.existsSync(historyPath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      expect(raw['file-check']).toBeDefined();
      expect(raw['file-check'].dedupKey).toBe('file-check');
    });

    it('should store entries with different dedupKeys separately', async () => {
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
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'a', timestamp: 1000 }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'b', timestamp: 3000 }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'c', timestamp: 2000 }));

      const entries = await provider.getHistoryEntries!();
      expect(entries.map(e => e.timestamp)).toEqual([3000, 2000, 1000]);
    });

    it('should return empty array when no history file exists', async () => {
      const entries = await provider.getHistoryEntries!();
      expect(entries).toEqual([]);
    });

    it('should return empty array for corrupt history file', async () => {
      // Write corrupt file in the per-identity subdir
      const addressSubdir = fs.readdirSync(tmpDir).find(f =>
        fs.statSync(path.join(tmpDir, f)).isDirectory(),
      )!;
      fs.writeFileSync(path.join(tmpDir, addressSubdir, '_history.json'), 'not json!!!');

      const entries = await provider.getHistoryEntries!();
      expect(entries).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // hasHistoryEntry
  // ---------------------------------------------------------------------------

  describe('hasHistoryEntry', () => {
    it('should return true for existing dedupKey', async () => {
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'exists' }));
      expect(await provider.hasHistoryEntry!('exists')).toBe(true);
    });

    it('should return false for non-existing dedupKey', async () => {
      expect(await provider.hasHistoryEntry!('nope')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // clearHistory
  // ---------------------------------------------------------------------------

  describe('clearHistory', () => {
    it('should remove the history file', async () => {
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'x' }));
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'y' }));

      await provider.clearHistory!();

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(0);
    });

    it('should not throw when no history file exists', async () => {
      await expect(provider.clearHistory!()).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // importHistoryEntries
  // ---------------------------------------------------------------------------

  describe('importHistoryEntries', () => {
    it('should import new entries and skip existing dedupKeys', async () => {
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'existing', amount: '100' }));

      const imported = await provider.importHistoryEntries!([
        makeEntry({ dedupKey: 'existing', amount: '999' }),  // should be skipped
        makeEntry({ dedupKey: 'new-1', amount: '200' }),
        makeEntry({ dedupKey: 'new-2', amount: '300' }),
      ]);

      expect(imported).toBe(2);

      const entries = await provider.getHistoryEntries!();
      expect(entries).toHaveLength(3);

      // Original entry preserved (first-write-wins)
      const existing = entries.find(e => e.dedupKey === 'existing');
      expect(existing!.amount).toBe('100');
    });

    it('should return 0 when all entries already exist', async () => {
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'a' }));

      const imported = await provider.importHistoryEntries!([
        makeEntry({ dedupKey: 'a' }),
      ]);
      expect(imported).toBe(0);
    });

    it('should return 0 for empty input', async () => {
      const imported = await provider.importHistoryEntries!([]);
      expect(imported).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // _history.json excluded from token load
  // ---------------------------------------------------------------------------

  describe('history file isolation', () => {
    it('should NOT treat _history.json as a token file during load', async () => {
      // Add some history
      await provider.addHistoryEntry!(makeEntry({ dedupKey: 'history-entry' }));

      // Load tokens — should not include history data
      const result = await provider.load();
      if (result.success && result.data) {
        const tokenKeys = Object.keys(result.data).filter(
          k => !['_meta', '_tombstones', '_outbox', '_sent', '_invalid'].includes(k),
        );
        // No token keys should come from history
        expect(tokenKeys).toHaveLength(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Full record round-trip
  // ---------------------------------------------------------------------------

  describe('full record round-trip', () => {
    it('should preserve all HistoryRecord fields through file I/O', async () => {
      const entry: HistoryRecord = {
        id: 'uuid-789',
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

      // Read back with a fresh provider to verify file persistence
      const provider2 = createProvider();
      provider2.setIdentity(createIdentity());
      await provider2.initialize();
      const [loaded] = await provider2.getHistoryEntries!();

      expect(loaded).toEqual(entry);
    });

    it('should preserve sender fields on RECEIVED entries', async () => {
      const entry: HistoryRecord = {
        id: 'uuid-abc',
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
