/**
 * Tests for PaymentsModule history sync via IPFS
 *
 * Covers:
 * 1. createStorageData() includes _history capped at MAX_SYNCED_HISTORY_ENTRIES
 * 2. load() imports history from IPFS TXF data
 * 3. _doSync() imports merged history from IPFS sync result
 * 4. importRemoteHistoryEntries() delegates to provider and deduplicates
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// Mock SDK static imports used by PaymentsModule
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId { toJSON() { return 'UCT_HEX'; } },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class MockTransferTransaction {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class MockSigningService {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class MockAddressScheme {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class MockUnmaskedPredicate {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class MockTokenState {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
}));

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Test Helpers
// =============================================================================

function makeHistoryEntry(overrides: Partial<HistoryRecord> & { dedupKey: string }): HistoryRecord {
  return {
    id: crypto.randomUUID(),
    type: 'RECEIVED',
    amount: '1000000',
    coinId: 'UCT',
    symbol: 'UCT',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** In-memory history store that mimics IndexedDB history store */
function createMockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (entry: HistoryRecord) => {
      entries.set(entry.dedupKey, entry);
    }),
    getHistoryEntries: vi.fn(async () => {
      return [...entries.values()].sort((a, b) => b.timestamp - a.timestamp);
    }),
    hasHistoryEntry: vi.fn(async (dedupKey: string) => entries.has(dedupKey)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async (importEntries: HistoryRecord[]) => {
      let count = 0;
      for (const entry of importEntries) {
        if (!entries.has(entry.dedupKey)) {
          entries.set(entry.dedupKey, entry);
          count++;
        }
      }
      return count;
    }),
    _entries: entries,
  };
}

function createMockDeps() {
  const historyStore = createMockHistoryStore();

  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };

  const mockTokenStorage = {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local' as const, timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...historyStore,
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('mock', mockTokenStorage);

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;

  const mockOracle = {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ success: true }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({}),
    validateToken: vi.fn().mockResolvedValue({ isValid: true }),
    isSpent: vi.fn().mockResolvedValue(false),
  } as unknown as OracleProvider;

  const mockIdentity: FullIdentity = {
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1testaddress',
    directAddress: 'DIRECT://testaddress',
    privateKey: '0x' + 'b'.repeat(64),
  };

  return {
    deps: {
      identity: mockIdentity,
      storage: mockStorage,
      tokenStorageProviders,
      transport: mockTransport,
      oracle: mockOracle,
      emitEvent: vi.fn(),
    } as PaymentsModuleDependencies,
    historyStore,
    mockTokenStorage,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule History Sync', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let historyStore: ReturnType<typeof createMockHistoryStore>;
  let mockTokenStorage: unknown;

  beforeEach(() => {
    module = createPaymentsModule();
    const mocks = createMockDeps();
    historyStore = mocks.historyStore;
    mockTokenStorage = mocks.mockTokenStorage;
    module.initialize(mocks.deps);
  });

  describe('createStorageData() — history inclusion', () => {
    it('should include _history in TXF storage data', async () => {
      // Add some history entries
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1000,
        tokenId: 'token1',
      });
      await module.addToHistory({
        type: 'SENT',
        amount: '500',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 2000,
        transferId: 'tx1',
      });

      // Access createStorageData via save — check that _history is in the saved data
      const saveCall = (mockTokenStorage as { save: ReturnType<typeof vi.fn> }).save;
      await (module as unknown as { save(): Promise<void> }).save();

      expect(saveCall).toHaveBeenCalled();
      const savedData = saveCall.mock.calls[0][0] as TxfStorageDataBase;
      expect(savedData._history).toBeDefined();
      expect(savedData._history).toHaveLength(2);
    });

    it('should sort history by timestamp descending', async () => {
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1000,
        tokenId: 'old-token',
      });
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '2000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 3000,
        tokenId: 'new-token',
      });

      const saveCall = (mockTokenStorage as { save: ReturnType<typeof vi.fn> }).save;
      await (module as unknown as { save(): Promise<void> }).save();

      const savedData = saveCall.mock.calls[0][0] as TxfStorageDataBase;
      const history = savedData._history as HistoryRecord[];
      expect(history[0].timestamp).toBeGreaterThan(history[1].timestamp);
    });
  });

  describe('load() — import history from IPFS', () => {
    it('should import _history entries from loaded TXF data', async () => {
      const remoteHistory: HistoryRecord[] = [
        makeHistoryEntry({ dedupKey: 'RECEIVED_token1', timestamp: 1000 }),
        makeHistoryEntry({ dedupKey: 'SENT_transfer_tx1', timestamp: 2000 }),
      ];

      // Configure provider.load() to return TXF data with _history
      const loadFn = (mockTokenStorage as { load: ReturnType<typeof vi.fn> }).load;
      loadFn.mockResolvedValue({
        success: true,
        data: {
          _meta: { version: 1, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
          _history: remoteHistory,
        },
        source: 'remote',
        timestamp: Date.now(),
      });

      await module.load();

      // History should be imported into local store
      expect(historyStore.importHistoryEntries).toHaveBeenCalledWith(remoteHistory);
      // And available via getHistory()
      const history = module.getHistory();
      expect(history).toHaveLength(2);
    });

    it('should not call importRemoteHistoryEntries when _history is absent', async () => {
      const loadFn = (mockTokenStorage as { load: ReturnType<typeof vi.fn> }).load;
      loadFn.mockResolvedValue({
        success: true,
        data: {
          _meta: { version: 1, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
        },
        source: 'remote',
        timestamp: Date.now(),
      });

      await module.load();

      expect(historyStore.importHistoryEntries).not.toHaveBeenCalled();
    });
  });

  describe('sync() — import merged history', () => {
    it('should import history from merged TXF data after sync', async () => {
      const mergedHistory: HistoryRecord[] = [
        makeHistoryEntry({ dedupKey: 'RECEIVED_token1', timestamp: 1000 }),
        makeHistoryEntry({ dedupKey: 'RECEIVED_token2', timestamp: 2000 }),
        makeHistoryEntry({ dedupKey: 'SENT_transfer_tx1', timestamp: 3000 }),
      ];

      // Configure sync to return merged data with _history
      const syncFn = (mockTokenStorage as { sync: ReturnType<typeof vi.fn> }).sync;
      syncFn.mockResolvedValue({
        success: true,
        merged: {
          _meta: { version: 2, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
          _history: mergedHistory,
        },
        added: 1,
        removed: 0,
        conflicts: 0,
      });

      await module.sync();

      expect(historyStore.importHistoryEntries).toHaveBeenCalledWith(mergedHistory);
    });

    it('should not duplicate existing history entries after sync', async () => {
      // Pre-populate local history
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1000,
        tokenId: 'token1',
      });

      const existingKey = 'RECEIVED_token1';
      const mergedHistory: HistoryRecord[] = [
        makeHistoryEntry({ dedupKey: existingKey, timestamp: 1000 }),
        makeHistoryEntry({ dedupKey: 'RECEIVED_token2', timestamp: 2000 }),
      ];

      const syncFn = (mockTokenStorage as { sync: ReturnType<typeof vi.fn> }).sync;
      syncFn.mockResolvedValue({
        success: true,
        merged: {
          _meta: { version: 2, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
          _history: mergedHistory,
        },
        added: 1,
        removed: 0,
        conflicts: 0,
      });

      await module.sync();

      // importHistoryEntries skips existing dedupKeys — only token2 should be new
      const allEntries = await historyStore.getHistoryEntries();
      const dedupKeys = allEntries.map(e => e.dedupKey);
      // Each key should appear exactly once
      expect(dedupKeys.filter(k => k === existingKey)).toHaveLength(1);
      expect(dedupKeys).toContain('RECEIVED_token2');
    });

    it('should handle sync with no _history in merged data', async () => {
      const syncFn = (mockTokenStorage as { sync: ReturnType<typeof vi.fn> }).sync;
      syncFn.mockResolvedValue({
        success: true,
        merged: {
          _meta: { version: 2, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
        },
        added: 0,
        removed: 0,
        conflicts: 0,
      });

      await module.sync();

      // No history import should happen
      expect(historyStore.importHistoryEntries).not.toHaveBeenCalled();
    });
  });

  describe('importRemoteHistoryEntries() — provider delegation', () => {
    it('should delegate to provider.importHistoryEntries()', async () => {
      const entries: HistoryRecord[] = [
        makeHistoryEntry({ dedupKey: 'RECEIVED_token1' }),
        makeHistoryEntry({ dedupKey: 'RECEIVED_token2' }),
      ];

      // Access the private method via load() which calls it
      const loadFn = (mockTokenStorage as { load: ReturnType<typeof vi.fn> }).load;
      loadFn.mockResolvedValue({
        success: true,
        data: {
          _meta: { version: 1, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
          _history: entries,
        },
        source: 'remote',
        timestamp: Date.now(),
      });

      await module.load();

      expect(historyStore.importHistoryEntries).toHaveBeenCalledWith(entries);
      expect(historyStore.getHistoryEntries).toHaveBeenCalled();
    });

    it('should reload cache from provider after import', async () => {
      const entries: HistoryRecord[] = [
        makeHistoryEntry({ dedupKey: 'RECEIVED_token1', timestamp: 5000 }),
      ];

      const loadFn = (mockTokenStorage as { load: ReturnType<typeof vi.fn> }).load;
      loadFn.mockResolvedValue({
        success: true,
        data: {
          _meta: { version: 1, address: 'alpha1test', ipnsName: '', formatVersion: '2.0' },
          _history: entries,
        },
        source: 'remote',
        timestamp: Date.now(),
      });

      await module.load();

      // After import, getHistory() should reflect the imported entries
      const history = module.getHistory();
      expect(history.some(e => e.dedupKey === 'RECEIVED_token1')).toBe(true);
    });
  });
});
