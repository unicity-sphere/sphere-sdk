/**
 * Tests for profile/migration.ts
 * Covers ProfileMigration: needsMigration, 6-step flow, sanity checks,
 * phase tracking, crash recovery, cleanup, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileMigration } from '../../../profile/migration';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage/storage-provider';
import type { ProfileStorageProvider } from '../../../profile/profile-storage-provider';
import type { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockLegacyStorage(data: Record<string, string>): StorageProvider {
  const store = new Map(Object.entries(data));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async set(key: string, value: string) { store.set(key, value); },
    async remove(key: string) { store.delete(key); },
    async has(key: string) { return store.has(key); },
    async keys(prefix?: string) {
      return [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) store.clear();
      else for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    setIdentity() {},
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() { return []; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-legacy',
    name: 'Mock Legacy Storage',
    type: 'local' as const,
    // Expose the internal store for test assertions
    _store: store,
  } as any;
}

function createMockLegacyTokenStorage(
  txfData: TxfStorageDataBase | null,
): TokenStorageProvider<TxfStorageDataBase> {
  return {
    setIdentity() {},
    async initialize() { return true; },
    async shutdown() {},
    async save() { return { success: true, timestamp: Date.now() }; },
    async load() {
      return {
        success: txfData !== null,
        data: txfData ?? undefined,
        source: 'local' as const,
        timestamp: Date.now(),
      };
    },
    async sync(_localData: TxfStorageDataBase) {
      return { success: true, added: 0, removed: 0, conflicts: 0 };
    },
    async clear() { return true; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-legacy-token',
    name: 'Mock Legacy Token Storage',
    type: 'local' as const,
  } as any;
}

function createMockProfileStorage(): ProfileStorageProvider & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async set(key: string, value: string) { store.set(key, value); },
    async remove(key: string) { store.delete(key); },
    async has(key: string) { return store.has(key); },
    async keys(prefix?: string) {
      return [...store.keys()].filter(k => !prefix || k.startsWith(prefix));
    },
    async clear() { store.clear(); },
    setIdentity() {},
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() { return []; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-profile',
    name: 'Mock Profile Storage',
    type: 'p2p' as const,
    _store: store,
  } as any;
}

function createMockProfileTokenStorage(
  loadData?: TxfStorageDataBase | null,
  linkedProfileStorage?: { _store: Map<string, string> },
): ProfileTokenStorageProvider & { _savedData: TxfStorageDataBase | null; _historyEntries: any[] } {
  let savedData: TxfStorageDataBase | null = null;
  const historyEntries: any[] = [];
  return {
    setIdentity() {},
    async initialize() { return true; },
    async shutdown() {},
    async save(data: TxfStorageDataBase) {
      savedData = data;
      return { success: true, timestamp: Date.now() };
    },
    async load() {
      // loadData override takes priority (for sanity check simulation);
      // otherwise return saved data
      const data = loadData ?? savedData ?? null;
      return {
        success: data !== null,
        data: data ?? undefined,
        source: 'cache' as const,
        timestamp: Date.now(),
      };
    },
    async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
    async clear() { return true; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-profile-token',
    name: 'Mock Profile Token Storage',
    type: 'p2p' as const,
    async getHistoryEntries() {
      // If linked to a profile storage, read transactionHistory from it
      // This simulates the shared OrbitDB in production
      if (linkedProfileStorage) {
        for (const [key, value] of linkedProfileStorage._store) {
          if (key.endsWith('.transactionHistory')) {
            try { return JSON.parse(value); } catch { /* ignore */ }
          }
        }
      }
      return historyEntries;
    },
    async addHistoryEntry(entry: any) { historyEntries.push(entry); },
    get _savedData() { return savedData; },
    _historyEntries: historyEntries,
  } as any;
}

// =============================================================================
// Test Suite
// =============================================================================

describe('ProfileMigration', () => {
  let migration: ProfileMigration;

  beforeEach(() => {
    migration = new ProfileMigration();
  });

  // ---------------------------------------------------------------------------
  // needsMigration
  // ---------------------------------------------------------------------------

  describe('needsMigration', () => {
    it('returns true when legacy data exists and migration not complete', async () => {
      const legacyStorage = createMockLegacyStorage({ wallet_exists: 'true' });
      expect(await migration.needsMigration(legacyStorage)).toBe(true);
    });

    it('returns false when migration is already complete', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        'migration.phase': 'complete',
      });
      expect(await migration.needsMigration(legacyStorage)).toBe(false);
    });

    it('returns false when no legacy data exists', async () => {
      const legacyStorage = createMockLegacyStorage({});
      expect(await migration.needsMigration(legacyStorage)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 6-step flow
  // ---------------------------------------------------------------------------

  describe('full migration flow', () => {
    it('full migration succeeds with mock providers', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test mnemonic phrase',
        master_key: 'abc123',
        chain_code: 'def456',
      });

      const txfData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _token1: { id: 'token1', amount: '100' },
        _token2: { id: 'token2', amount: '200' },
        _token3: { id: 'token3', amount: '300' },
      } as any;

      const legacyTokenStorage = createMockLegacyTokenStorage(txfData);

      // Profile storage that accepts writes and reads them back
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(txfData);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(true);
      expect(result.keysMigrated).toBeGreaterThan(0);
      expect(result.tokensMigrated).toBe(3);
    });

    it('_sent entries merged into transactionHistory', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      const txfData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _history: [
          { dedupKey: 'RECV_x', id: 'x', type: 'RECEIVED', amount: '100', coinId: 'UCT', symbol: 'UCT', timestamp: 1000 },
        ],
        _sent: [
          { tokenId: 'tok1', txHash: 'hash1', sentAt: 2000, recipient: '@bob' },
          { tokenId: 'tok2', txHash: 'hash2', sentAt: 3000, recipient: '@alice' },
        ],
        _tokenA: { id: 'A' },
      } as any;

      const legacyTokenStorage = createMockLegacyTokenStorage(txfData);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(txfData, profileStorage);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(true);

      // Check that transactionHistory was written to profile storage
      const historyKey = 'DIRECT_aabbcc_ddeeff.transactionHistory';
      const historyVal = profileStorage._store.get(historyKey);
      expect(historyVal).toBeDefined();
      const parsed = JSON.parse(historyVal!);
      // Should have 3 entries: 1 existing + 2 from _sent
      expect(parsed).toHaveLength(3);
      // Check _sent entries are converted with proper dedupKey
      const sentKeys = parsed.filter((e: any) => e.type === 'SENT');
      expect(sentKeys).toHaveLength(2);
      expect(sentKeys[0].dedupKey).toMatch(/^SENT_tok/);
    });

    it('nametag tokens extracted from _nametag and _nametags', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      const txfData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _nametag: { token: { id: 'nt1', amount: '1' } },
        _nametags: [{ token: { id: 'nt2' } }, null],
      } as any;

      const legacyTokenStorage = createMockLegacyTokenStorage(txfData);
      const profileStorage = createMockProfileStorage();
      // The loaded data from profile should contain all extracted token keys.
      // The migration extracts:
      //   - _nametag (starts with _, not operational)
      //   - _nametags (starts with _, not operational — the array entry itself)
      //   - _nametags_0 (from extractNametagTokens)
      const loadReturnData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _nametag: { token: { id: 'nt1', amount: '1' } },
        _nametags: [{ token: { id: 'nt2' } }, null],
        _nametags_0: { token: { id: 'nt2' } },
      } as any;
      const profileTokenStorage = createMockProfileTokenStorage(loadReturnData, profileStorage);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(true);
      // _nametag, _nametags, and _nametags_0 are all counted as token IDs
      // _nametags_1 is NOT (it is null)
      expect(result.tokensMigrated).toBe(3);
    });

    it('forked tokens extracted from _forked_* keys', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      const txfData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _forked_abc123: { id: 'forked1', amount: '50' },
        _tokenX: { id: 'X' },
      } as any;

      const legacyTokenStorage = createMockLegacyTokenStorage(txfData);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(txfData);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(true);
      // Both _forked_abc123 and _tokenX should be counted
      expect(result.tokensMigrated).toBe(2);
    });

    it('IPFS state keys not migrated', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
        ipfs_seq_xyz: '42',
        ipfs_cid_abc: 'bafyabc',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(true);
      // IPFS keys should not appear in profile storage
      const allKeys = [...profileStorage._store.keys()];
      expect(allKeys.some(k => k.includes('ipfs_seq'))).toBe(false);
      expect(allKeys.some(k => k.includes('ipfs_cid'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Sanity check
  // ---------------------------------------------------------------------------

  describe('sanity check', () => {
    it('catches missing profile key', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'secret',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);

      // Profile storage where set() works but get() returns null for
      // a specific key during sanity check (simulates data loss in OrbitDB).
      const store = new Map<string, string>();
      let verifyingPhase = false;
      const profileStorage = {
        async get(key: string) {
          // During verifying phase, pretend 'identity.mnemonic' is missing
          if (verifyingPhase && key === 'identity.mnemonic') return null;
          return store.get(key) ?? null;
        },
        async set(key: string, value: string) {
          store.set(key, value);
          // Track when we hit the verifying phase
          // (setPhase writes to legacyStorage, not here, so we detect via key count)
        },
        async remove(key: string) { store.delete(key); },
        async has(key: string) { return store.has(key); },
        async keys() { return [...store.keys()]; },
        async clear() { store.clear(); },
        setIdentity() {},
        async saveTrackedAddresses() {},
        async loadTrackedAddresses() { return []; },
        async connect() {},
        async disconnect() {},
        isConnected() { return true; },
        getStatus() { return 'connected'; },
      } as any;

      const profileTokenStorage = createMockProfileTokenStorage(null);

      // Hook into legacyStorage.set to detect verifying phase
      const origLegacySet = legacyStorage.set.bind(legacyStorage);
      (legacyStorage as any).set = async (key: string, value: string) => {
        await origLegacySet(key, value);
        if (key === 'migration.phase' && value === 'verifying') {
          verifyingPhase = true;
        }
      };

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(false);
      expect(result.failedAtPhase).toBe('verifying');
    });

    it('catches token count mismatch', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      // Legacy has 3 tokens
      const txfData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _token1: { id: '1' },
        _token2: { id: '2' },
        _token3: { id: '3' },
      } as any;

      const legacyTokenStorage = createMockLegacyTokenStorage(txfData);
      const profileStorage = createMockProfileStorage();

      // Profile token storage that always returns only 1 token on load,
      // ignoring what save() stored — simulates data loss during pin/write
      const lessData: TxfStorageDataBase = {
        _meta: { version: 1, address: 'DIRECT_aabbcc_ddeeff', formatVersion: '1.0.0', updatedAt: Date.now() },
        _token1: { id: '1' },
      } as any;

      const profileTokenStorage = {
        setIdentity() {},
        async initialize() { return true; },
        async shutdown() {},
        async save() { return { success: true, timestamp: Date.now() }; },
        async load() {
          // Always return the incomplete data (simulates data loss)
          return { success: true, data: lessData, source: 'cache' as const, timestamp: Date.now() };
        },
        async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
        async clear() { return true; },
        async connect() {},
        async disconnect() {},
        isConnected() { return true; },
        getStatus() { return 'connected' as const; },
        id: 'mock-profile-token',
        name: 'Mock',
        type: 'p2p' as const,
        async getHistoryEntries() { return []; },
      } as any;

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/count mismatch|not found/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase tracking and crash recovery
  // ---------------------------------------------------------------------------

  describe('phase tracking', () => {
    it('phase is tracked in legacy storage for crash recovery', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      const setSpy = vi.spyOn(legacyStorage, 'set');

      await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      // Verify phase tracking calls
      const phaseCalls = setSpy.mock.calls
        .filter(([key]) => key === 'migration.phase')
        .map(([, value]) => value);

      expect(phaseCalls).toContain('syncing');
      expect(phaseCalls).toContain('transforming');
      expect(phaseCalls).toContain('persisting');
      expect(phaseCalls).toContain('verifying');
      expect(phaseCalls).toContain('cleaning');
      expect(phaseCalls).toContain('complete');
    });

    it('migration resumes from last completed phase', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
        'migration.phase': 'transforming',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      const setSpy = vi.spyOn(legacyStorage, 'set');

      await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      // The syncing phase should be written because transform always re-runs,
      // but the key point is that it doesn't call sync on IPFS
      // (step 1 is skipped when resumeFromIndex > 0).
      // The phase tracking should show that we went through transforming onward.
      const phaseCalls = setSpy.mock.calls
        .filter(([key]) => key === 'migration.phase')
        .map(([, value]) => value);

      // Should NOT include 'syncing' since resumeFromIndex = 2 (after 'transforming')
      // Actually, looking at code: resumeFromIndex = indexOf('transforming') + 1 = 2
      // Step 1 runs if resumeFromIndex <= 0, so step 1 is skipped
      // Step 2 always runs
      expect(phaseCalls[0]).toBe('transforming');
      expect(phaseCalls).toContain('complete');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('wallets with no IPFS keys skip step 1', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const syncSpy = vi.spyOn(legacyTokenStorage, 'sync');

      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      // sync should NOT be called when no ipfs_seq_* keys exist
      expect(syncSpy).not.toHaveBeenCalled();
    });

    it('step 1 IPFS sync failure is non-fatal', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
        ipfs_seq_mykey: '5',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      // Make load succeed (returns data) but sync throws
      (legacyTokenStorage as any).load = async () => ({
        success: true,
        data: {
          _meta: { version: 1, address: 'test', formatVersion: '1.0.0', updatedAt: Date.now() },
        },
        source: 'local',
        timestamp: Date.now(),
      });
      (legacyTokenStorage as any).sync = async () => {
        throw new Error('IPNS resolution failed');
      };

      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      // Migration should still succeed despite IPFS sync failure
      expect(result.success).toBe(true);
    });

    it('cleanup preserves migration phase keys', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
        some_other_key: 'val',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      expect(result.success).toBe(true);

      // migration.phase should still be in legacy storage
      const store = (legacyStorage as any)._store as Map<string, string>;
      expect(store.has('migration.phase')).toBe(true);
      expect(store.get('migration.phase')).toBe('complete');

      // Other keys should have been removed
      expect(store.has('wallet_exists')).toBe(false);
      expect(store.has('mnemonic')).toBe(false);
      expect(store.has('some_other_key')).toBe(false);
    });

    it('SphereVestingCacheV5 not deleted (cleanup only touches StorageProvider KV store)', async () => {
      const legacyStorage = createMockLegacyStorage({
        wallet_exists: 'true',
        mnemonic: 'test',
      });

      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage(null);

      // Track what gets called on legacy storage and token storage
      const removeSpy = vi.spyOn(legacyStorage, 'remove');
      const clearSpy = vi.spyOn(legacyTokenStorage, 'clear' as any);

      await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as any,
        profileTokenStorage as any,
      );

      // Cleanup should only call legacyStorage.remove() (KV store)
      // and legacyTokenStorage.clear() -- neither of which touches
      // SphereVestingCacheV5 (a separate IndexedDB database)
      expect(removeSpy).toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();

      // Verify no call references VestingClassifier or its DB
      for (const call of removeSpy.mock.calls) {
        expect(call[0]).not.toMatch(/vesting/i);
      }
    });
  });
});
