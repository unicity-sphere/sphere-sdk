import { describe, it, expect, vi, afterEach } from 'vitest';
import { mergeTxfData } from '../../../../../impl/shared/ipfs/txf-merge';
import type {
  TxfStorageDataBase,
  TxfTombstone,
  TxfOutboxEntry,
  TxfSentEntry,
  TxfInvalidEntry,
} from '../../../../../storage';

// =============================================================================
// Helpers
// =============================================================================

/** 64-hex-char token ID (looks like a real SHA-256 hash). */
function tokenId(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/** Prefixed token key as it appears in TxfStorageDataBase. */
function tokenKey(index: number): `_${string}` {
  return `_${tokenId(index)}` as `_${string}`;
}

/** Minimal valid TxfMeta for tests. */
function makeMeta(
  overrides: Partial<{ version: number; address: string; formatVersion: string; updatedAt: number }> = {},
) {
  return {
    version: 1,
    address: 'DIRECT_test',
    formatVersion: '1.0',
    updatedAt: 1000,
    ...overrides,
  };
}

/** Create a bare TxfStorageDataBase with only _meta. */
function emptyData(metaOverrides?: Parameters<typeof makeMeta>[0]): TxfStorageDataBase {
  return { _meta: makeMeta(metaOverrides) };
}

/** Convenience tombstone factory. */
function tombstone(index: number, stateHash: string, timestamp = 100): TxfTombstone {
  return { tokenId: tokenId(index), stateHash, timestamp };
}

/** Convenience outbox entry factory. */
function outboxEntry(overrides: Partial<TxfOutboxEntry> & { id: string }): TxfOutboxEntry {
  return {
    status: 'pending',
    tokenId: tokenId(1),
    recipient: '@alice',
    createdAt: 1000,
    data: null,
    ...overrides,
  };
}

/** Convenience sent entry factory. */
function sentEntry(overrides: Partial<TxfSentEntry> & { tokenId: string }): TxfSentEntry {
  return {
    recipient: '@bob',
    txHash: 'abc123',
    sentAt: 2000,
    ...overrides,
  };
}

/** Convenience invalid entry factory. */
function invalidEntry(overrides: Partial<TxfInvalidEntry> & { tokenId: string }): TxfInvalidEntry {
  return {
    reason: 'spent',
    detectedAt: 3000,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('mergeTxfData', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Local-only tokens are preserved
  // ---------------------------------------------------------------------------
  describe('local-only tokens', () => {
    it('should preserve tokens that exist only in local', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'local-1' },
        [tokenKey(2)]: { value: 'local-2' },
      };
      const remote: TxfStorageDataBase = emptyData();

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toEqual({ value: 'local-1' });
      expect(merged[tokenKey(2)]).toEqual({ value: 'local-2' });
      expect(added).toBe(0);
      expect(removed).toBe(0);
      expect(conflicts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Remote-only tokens are added (added count)
  // ---------------------------------------------------------------------------
  describe('remote-only tokens', () => {
    it('should add tokens that exist only in remote and increment added', () => {
      const local: TxfStorageDataBase = emptyData();
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'remote-1' },
        [tokenKey(2)]: { value: 'remote-2' },
        [tokenKey(3)]: { value: 'remote-3' },
      };

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toEqual({ value: 'remote-1' });
      expect(merged[tokenKey(2)]).toEqual({ value: 'remote-2' });
      expect(merged[tokenKey(3)]).toEqual({ value: 'remote-3' });
      expect(added).toBe(3);
      expect(removed).toBe(0);
      expect(conflicts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Same token in both -> local wins (conflicts count)
  // ---------------------------------------------------------------------------
  describe('conflict resolution (local wins)', () => {
    it('should keep local version and count conflicts when token exists in both', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'local-version', amount: 100 },
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'remote-version', amount: 200 },
      };

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toEqual({ value: 'local-version', amount: 100 });
      expect(added).toBe(0);
      expect(removed).toBe(0);
      expect(conflicts).toBe(1);
    });

    it('should count each conflicting token separately', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { v: 'L1' },
        [tokenKey(2)]: { v: 'L2' },
        [tokenKey(3)]: { v: 'L3' },
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { v: 'R1' },
        [tokenKey(2)]: { v: 'R2' },
        [tokenKey(3)]: { v: 'R3' },
      };

      const { conflicts } = mergeTxfData(local, remote);

      expect(conflicts).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Meta version merging
  // ---------------------------------------------------------------------------
  describe('meta version handling', () => {
    it('should use remote version + 1 when remote version is higher', () => {
      const local: TxfStorageDataBase = emptyData({ version: 3 });
      const remote: TxfStorageDataBase = emptyData({ version: 7 });

      const { merged } = mergeTxfData(local, remote);

      expect(merged._meta.version).toBe(8); // max(3, 7) + 1
    });

    it('should use local version + 1 when local version is higher', () => {
      const local: TxfStorageDataBase = emptyData({ version: 10 });
      const remote: TxfStorageDataBase = emptyData({ version: 4 });

      const { merged } = mergeTxfData(local, remote);

      expect(merged._meta.version).toBe(11); // max(10, 4) + 1
    });

    it('should use version + 1 when both have the same version', () => {
      const local: TxfStorageDataBase = emptyData({ version: 5 });
      const remote: TxfStorageDataBase = emptyData({ version: 5 });

      const { merged } = mergeTxfData(local, remote);

      expect(merged._meta.version).toBe(6); // max(5, 5) + 1
    });

    it('should use meta fields from the higher-versioned source', () => {
      const local: TxfStorageDataBase = emptyData({ version: 2, address: 'local-addr' });
      const remote: TxfStorageDataBase = emptyData({ version: 5, address: 'remote-addr' });

      const { merged } = mergeTxfData(local, remote);

      expect(merged._meta.address).toBe('remote-addr');
    });

    it('should use local meta fields when local version is higher or equal', () => {
      const local: TxfStorageDataBase = emptyData({ version: 5, address: 'local-addr' });
      const remote: TxfStorageDataBase = emptyData({ version: 5, address: 'remote-addr' });

      const { merged } = mergeTxfData(local, remote);

      // local version >= remote version -> local meta used as base
      expect(merged._meta.address).toBe('local-addr');
    });

    it('should update the updatedAt timestamp', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const local: TxfStorageDataBase = emptyData({ updatedAt: 1000 });
      const remote: TxfStorageDataBase = emptyData({ updatedAt: 2000 });

      const { merged } = mergeTxfData(local, remote);

      expect(merged._meta.updatedAt).toBe(now);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Tombstone union and newer timestamp wins
  // ---------------------------------------------------------------------------
  describe('tombstone merging', () => {
    it('should union tombstones from both local and remote', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(2, 'hashB', 200)],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._tombstones).toHaveLength(2);
      const ids = merged._tombstones!.map((t) => t.tokenId);
      expect(ids).toContain(tokenId(1));
      expect(ids).toContain(tokenId(2));
    });

    it('should keep newer timestamp on duplicate tombstone keys', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 500)],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._tombstones).toHaveLength(1);
      expect(merged._tombstones![0].timestamp).toBe(500);
    });

    it('should keep local tombstone when it has a newer timestamp', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 999)],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._tombstones).toHaveLength(1);
      expect(merged._tombstones![0].timestamp).toBe(999);
    });

    it('should distinguish tombstones with same tokenId but different stateHash', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashB', 200)],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._tombstones).toHaveLength(2);
      const hashes = merged._tombstones!.map((t) => t.stateHash);
      expect(hashes).toContain('hashA');
      expect(hashes).toContain('hashB');
    });

    it('should omit _tombstones key when there are no tombstones', () => {
      const local: TxfStorageDataBase = emptyData();
      const remote: TxfStorageDataBase = emptyData();

      const { merged } = mergeTxfData(local, remote);

      expect(merged._tombstones).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Tokens matching tombstones are excluded (removed count)
  // ---------------------------------------------------------------------------
  describe('tombstone filtering of tokens', () => {
    it('should exclude local tokens that match a tombstone and count as removed', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
        [tokenKey(1)]: { value: 'should-be-removed' },
        [tokenKey(2)]: { value: 'should-stay' },
      };
      const remote: TxfStorageDataBase = emptyData();

      const { merged, removed } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toBeUndefined();
      expect(merged[tokenKey(2)]).toEqual({ value: 'should-stay' });
      expect(removed).toBe(1);
    });

    it('should exclude remote tokens that match a tombstone', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'remote-tombstoned' },
      };

      const { merged, added } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toBeUndefined();
      // Remote token was tombstoned, should not count as added
      expect(added).toBe(0);
    });

    it('should exclude tokens matching tombstones from remote side', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'local-token' },
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashX', 100)],
      };

      const { merged, removed } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toBeUndefined();
      expect(removed).toBe(1);
    });

    it('should not exclude tokens whose tokenId does not match any tombstone', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(99, 'hashZ', 100)],
        [tokenKey(1)]: { value: 'safe-token' },
      };
      const remote: TxfStorageDataBase = emptyData();

      const { merged, removed } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toEqual({ value: 'safe-token' });
      expect(removed).toBe(0);
    });

    it('should count removed correctly when both local and remote have the same tombstoned token', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
        [tokenKey(1)]: { value: 'local-copy' },
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        [tokenKey(1)]: { value: 'remote-copy' },
      };

      const { merged, removed } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toBeUndefined();
      // The token existed in local, so removed should be 1
      expect(removed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Outbox dedup by id
  // ---------------------------------------------------------------------------
  describe('outbox merging', () => {
    it('should union outbox entries from local and remote', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _outbox: [outboxEntry({ id: 'ob-1' })],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _outbox: [outboxEntry({ id: 'ob-2' })],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._outbox).toHaveLength(2);
      const ids = merged._outbox!.map((e) => e.id);
      expect(ids).toContain('ob-1');
      expect(ids).toContain('ob-2');
    });

    it('should dedup outbox entries by id, keeping local version', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _outbox: [outboxEntry({ id: 'ob-1', status: 'submitted' })],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _outbox: [outboxEntry({ id: 'ob-1', status: 'pending' })],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._outbox).toHaveLength(1);
      expect(merged._outbox![0].status).toBe('submitted'); // local wins
    });

    it('should omit _outbox key when there are no outbox entries', () => {
      const local: TxfStorageDataBase = emptyData();
      const remote: TxfStorageDataBase = emptyData();

      const { merged } = mergeTxfData(local, remote);

      expect(merged._outbox).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Sent dedup by tokenId
  // ---------------------------------------------------------------------------
  describe('sent merging', () => {
    it('should union sent entries from local and remote', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _sent: [sentEntry({ tokenId: tokenId(1) })],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _sent: [sentEntry({ tokenId: tokenId(2) })],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._sent).toHaveLength(2);
      const ids = merged._sent!.map((e) => e.tokenId);
      expect(ids).toContain(tokenId(1));
      expect(ids).toContain(tokenId(2));
    });

    it('should dedup sent entries by tokenId, keeping local version', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _sent: [sentEntry({ tokenId: tokenId(1), recipient: '@alice', txHash: 'local-hash' })],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _sent: [sentEntry({ tokenId: tokenId(1), recipient: '@bob', txHash: 'remote-hash' })],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._sent).toHaveLength(1);
      expect(merged._sent![0].recipient).toBe('@alice'); // local wins
      expect(merged._sent![0].txHash).toBe('local-hash');
    });

    it('should omit _sent key when there are no sent entries', () => {
      const local: TxfStorageDataBase = emptyData();
      const remote: TxfStorageDataBase = emptyData();

      const { merged } = mergeTxfData(local, remote);

      expect(merged._sent).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Empty local/remote edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle both local and remote being empty (no tokens)', () => {
      const local: TxfStorageDataBase = emptyData({ version: 1 });
      const remote: TxfStorageDataBase = emptyData({ version: 1 });

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged._meta.version).toBe(2);
      expect(added).toBe(0);
      expect(removed).toBe(0);
      expect(conflicts).toBe(0);
    });

    it('should handle empty local with populated remote', () => {
      const local: TxfStorageDataBase = emptyData({ version: 1 });
      const remote: TxfStorageDataBase = {
        _meta: makeMeta({ version: 3 }),
        _tombstones: [tombstone(99, 'hashZ', 50)],
        _outbox: [outboxEntry({ id: 'ob-1' })],
        _sent: [sentEntry({ tokenId: tokenId(10) })],
        [tokenKey(1)]: { value: 'r1' },
        [tokenKey(2)]: { value: 'r2' },
      };

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged._meta.version).toBe(4); // max(1,3) + 1
      expect(merged[tokenKey(1)]).toEqual({ value: 'r1' });
      expect(merged[tokenKey(2)]).toEqual({ value: 'r2' });
      expect(merged._tombstones).toHaveLength(1);
      expect(merged._outbox).toHaveLength(1);
      expect(merged._sent).toHaveLength(1);
      expect(added).toBe(2);
      expect(removed).toBe(0);
      expect(conflicts).toBe(0);
    });

    it('should handle populated local with empty remote', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta({ version: 5 }),
        _tombstones: [tombstone(88, 'hashY', 75)],
        [tokenKey(1)]: { value: 'l1' },
      };
      const remote: TxfStorageDataBase = emptyData({ version: 2 });

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged._meta.version).toBe(6); // max(5,2) + 1
      expect(merged[tokenKey(1)]).toEqual({ value: 'l1' });
      expect(merged._tombstones).toHaveLength(1);
      expect(added).toBe(0);
      expect(removed).toBe(0);
      expect(conflicts).toBe(0);
    });

    it('should handle undefined optional arrays gracefully', () => {
      const local: TxfStorageDataBase = { _meta: makeMeta() };
      const remote: TxfStorageDataBase = { _meta: makeMeta() };

      // Should not throw
      const { merged } = mergeTxfData(local, remote);

      expect(merged._tombstones).toBeUndefined();
      expect(merged._outbox).toBeUndefined();
      expect(merged._sent).toBeUndefined();
      expect(merged._invalid).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Meta version incremented correctly
  // ---------------------------------------------------------------------------
  describe('version increment invariant', () => {
    it('should always produce version = max(local, remote) + 1', () => {
      const testCases = [
        { localV: 0, remoteV: 0, expected: 1 },
        { localV: 1, remoteV: 0, expected: 2 },
        { localV: 0, remoteV: 1, expected: 2 },
        { localV: 5, remoteV: 5, expected: 6 },
        { localV: 100, remoteV: 50, expected: 101 },
        { localV: 42, remoteV: 99, expected: 100 },
      ];

      for (const { localV, remoteV, expected } of testCases) {
        const local: TxfStorageDataBase = emptyData({ version: localV });
        const remote: TxfStorageDataBase = emptyData({ version: remoteV });

        const { merged } = mergeTxfData(local, remote);

        expect(merged._meta.version).toBe(expected);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid entries merging
  // ---------------------------------------------------------------------------
  describe('invalid entries merging', () => {
    it('should union invalid entries from local and remote', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _invalid: [invalidEntry({ tokenId: tokenId(1), reason: 'spent' })],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _invalid: [invalidEntry({ tokenId: tokenId(2), reason: 'corrupted' })],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._invalid).toHaveLength(2);
    });

    it('should dedup invalid entries by tokenId, keeping local version', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta(),
        _invalid: [invalidEntry({ tokenId: tokenId(1), reason: 'local-reason' })],
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _invalid: [invalidEntry({ tokenId: tokenId(1), reason: 'remote-reason' })],
      };

      const { merged } = mergeTxfData(local, remote);

      expect(merged._invalid).toHaveLength(1);
      expect(merged._invalid![0].reason).toBe('local-reason');
    });

    it('should omit _invalid key when there are no invalid entries', () => {
      const local: TxfStorageDataBase = emptyData();
      const remote: TxfStorageDataBase = emptyData();

      const { merged } = mergeTxfData(local, remote);

      expect(merged._invalid).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed scenario: all features combined
  // ---------------------------------------------------------------------------
  describe('combined scenario', () => {
    it('should correctly merge a complex dataset with all features', () => {
      const now = 9999;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const local: TxfStorageDataBase = {
        _meta: makeMeta({ version: 3, address: 'local-addr' }),
        _tombstones: [
          tombstone(10, 'hashDead', 300), // token 10 is dead
          tombstone(20, 'hashShared', 100), // shared tombstone, older timestamp
        ],
        _outbox: [
          outboxEntry({ id: 'ob-1', status: 'submitted' }),
          outboxEntry({ id: 'ob-3', status: 'pending' }),
        ],
        _sent: [
          sentEntry({ tokenId: tokenId(50), txHash: 'local-tx-50' }),
        ],
        _invalid: [
          invalidEntry({ tokenId: tokenId(60), reason: 'spent-local' }),
        ],
        [tokenKey(1)]: { v: 'local-only' },      // local-only token -> keep
        [tokenKey(2)]: { v: 'local-conflict' },   // conflict -> local wins
        [tokenKey(10)]: { v: 'tombstoned-local' }, // tombstoned -> removed
      };

      const remote: TxfStorageDataBase = {
        _meta: makeMeta({ version: 5, address: 'remote-addr' }),
        _tombstones: [
          tombstone(20, 'hashShared', 500), // same tombstone, newer timestamp
          tombstone(30, 'hashNew', 400),    // new tombstone from remote
        ],
        _outbox: [
          outboxEntry({ id: 'ob-1', status: 'failed' }),  // dup -> local wins
          outboxEntry({ id: 'ob-2', status: 'pending' }), // new from remote
        ],
        _sent: [
          sentEntry({ tokenId: tokenId(50), txHash: 'remote-tx-50' }), // dup -> local wins
          sentEntry({ tokenId: tokenId(51), txHash: 'remote-tx-51' }), // new from remote
        ],
        _invalid: [
          invalidEntry({ tokenId: tokenId(60), reason: 'spent-remote' }), // dup -> local wins
          invalidEntry({ tokenId: tokenId(61), reason: 'corrupted' }),    // new from remote
        ],
        [tokenKey(2)]: { v: 'remote-conflict' }, // conflict -> local wins
        [tokenKey(3)]: { v: 'remote-only' },     // remote-only -> added
        [tokenKey(4)]: { v: 'remote-only-2' },   // remote-only -> added
      };

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      // Meta: remote version (5) is higher, so remote meta as base, version = 6
      expect(merged._meta.version).toBe(6);
      expect(merged._meta.address).toBe('remote-addr');
      expect(merged._meta.updatedAt).toBe(now);

      // Tombstones: union of 3 unique composite keys
      expect(merged._tombstones).toHaveLength(3);
      const tsMap = new Map(merged._tombstones!.map((t) => [`${t.tokenId}:${t.stateHash}`, t]));
      expect(tsMap.get(`${tokenId(10)}:hashDead`)!.timestamp).toBe(300);
      expect(tsMap.get(`${tokenId(20)}:hashShared`)!.timestamp).toBe(500); // newer wins
      expect(tsMap.get(`${tokenId(30)}:hashNew`)!.timestamp).toBe(400);

      // Tokens
      expect(merged[tokenKey(1)]).toEqual({ v: 'local-only' });       // local-only: kept
      expect(merged[tokenKey(2)]).toEqual({ v: 'local-conflict' });   // conflict: local wins
      expect(merged[tokenKey(3)]).toEqual({ v: 'remote-only' });      // remote-only: added
      expect(merged[tokenKey(4)]).toEqual({ v: 'remote-only-2' });    // remote-only: added
      expect(merged[tokenKey(10)]).toBeUndefined();                    // tombstoned: removed

      // Outbox: 3 unique entries (ob-1 deduped, local wins)
      expect(merged._outbox).toHaveLength(3);
      const obMap = new Map(merged._outbox!.map((e) => [e.id, e]));
      expect(obMap.get('ob-1')!.status).toBe('submitted'); // local wins
      expect(obMap.has('ob-2')).toBe(true);
      expect(obMap.has('ob-3')).toBe(true);

      // Sent: 2 unique entries (tokenId(50) deduped, local wins)
      expect(merged._sent).toHaveLength(2);
      const sentMap = new Map(merged._sent!.map((e) => [e.tokenId, e]));
      expect(sentMap.get(tokenId(50))!.txHash).toBe('local-tx-50'); // local wins
      expect(sentMap.has(tokenId(51))).toBe(true);

      // Invalid: 2 unique entries (tokenId(60) deduped, local wins)
      expect(merged._invalid).toHaveLength(2);
      const invMap = new Map(merged._invalid!.map((e) => [e.tokenId, e]));
      expect(invMap.get(tokenId(60))!.reason).toBe('spent-local'); // local wins
      expect(invMap.has(tokenId(61))).toBe(true);

      // Counters
      expect(added).toBe(2);     // tokenKey(3) and tokenKey(4) from remote
      expect(removed).toBe(1);   // tokenKey(10) was in local and tombstoned
      expect(conflicts).toBe(1); // tokenKey(2) existed in both
    });
  });

  // ---------------------------------------------------------------------------
  // Tombstone from remote filters remote-only tokens too
  // ---------------------------------------------------------------------------
  describe('tombstone from remote filters remote-only tokens', () => {
    it('should not add remote-only token if tombstoned by remote tombstone', () => {
      const local: TxfStorageDataBase = emptyData();
      const remote: TxfStorageDataBase = {
        _meta: makeMeta(),
        _tombstones: [tombstone(1, 'hashA', 100)],
        [tokenKey(1)]: { value: 'contradicts-own-tombstone' },
      };

      const { merged, added } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toBeUndefined();
      expect(added).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple tokens: mixed local-only, remote-only, conflict, tombstoned
  // ---------------------------------------------------------------------------
  describe('mixed token categories', () => {
    it('should correctly categorize and count a mix of token outcomes', () => {
      const local: TxfStorageDataBase = {
        _meta: makeMeta({ version: 1 }),
        _tombstones: [tombstone(5, 'hashDead', 100)],
        [tokenKey(1)]: { v: 'L' },  // local-only
        [tokenKey(3)]: { v: 'L' },  // conflict
        [tokenKey(5)]: { v: 'L' },  // tombstoned (in local)
      };
      const remote: TxfStorageDataBase = {
        _meta: makeMeta({ version: 1 }),
        [tokenKey(2)]: { v: 'R' },  // remote-only -> added
        [tokenKey(3)]: { v: 'R' },  // conflict -> local wins
        [tokenKey(4)]: { v: 'R' },  // remote-only -> added
      };

      const { merged, added, removed, conflicts } = mergeTxfData(local, remote);

      expect(merged[tokenKey(1)]).toEqual({ v: 'L' });
      expect(merged[tokenKey(2)]).toEqual({ v: 'R' });
      expect(merged[tokenKey(3)]).toEqual({ v: 'L' });
      expect(merged[tokenKey(4)]).toEqual({ v: 'R' });
      expect(merged[tokenKey(5)]).toBeUndefined();

      expect(added).toBe(2);
      expect(removed).toBe(1);
      expect(conflicts).toBe(1);
    });
  });
});
