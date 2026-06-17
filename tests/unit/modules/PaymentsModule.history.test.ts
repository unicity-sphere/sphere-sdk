/**
 * Tests for PaymentsModule transaction history (v2 engine harness).
 *
 * Covers:
 * 1. addToHistory() stores entries and prevents duplicates via dedupKey
 * 2. getHistory() returns sorted entries
 * 3. addToken() creates NO history entries (v2 blob tokens)
 * 4. removeToken() creates NO history entries
 * 5. Deduplication via dedupKey (same tokenId + type = single entry)
 * 6. loadHistory() migrates legacy KV history into the history store
 *
 * Clean harness (no SDK vi.mock): tokens are generated via the FakeTokenEngine
 * and stored as v2 engine blobs (hex of CBOR(TokenBlob)) in Token.sdkData.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// Test Constants
// =============================================================================

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex

// =============================================================================
// Test Helpers
// =============================================================================

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY,
    directAddress: 'DIRECT://testaddress',
    privateKey: FAKE_PRIVATE_KEY,
    transportPubkey: 'c'.repeat(64),
  };
}

function mockStorage(): StorageProvider {
  const s = new Map<string, string>();
  return {
    id: 'mock-storage', name: 'Mock Storage', type: 'local',
    connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
}

/** In-memory history store that mimics the IndexedDB history store */
function createMockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (entry: HistoryRecord) => {
      entries.set(entry.dedupKey, entry);
    }),
    getHistoryEntries: vi.fn(async () =>
      [...entries.values()].sort((a, b) => b.timestamp - a.timestamp),
    ),
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

function mockTokenStorage(historyStore: ReturnType<typeof createMockHistoryStore>): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id: 'mock-token-storage', name: 'Mock Token Storage', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local', timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...historyStore,
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getTrustBaseJson: vi.fn().mockReturnValue(null),
    getAggregatorUrl: vi.fn().mockReturnValue(null),
    getApiKey: vi.fn().mockReturnValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected',
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

function createMockDeps(engine: FakeTokenEngine): {
  deps: PaymentsModuleDependencies;
  historyStore: ReturnType<typeof createMockHistoryStore>;
} {
  const historyStore = createMockHistoryStore();
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('local', mockTokenStorage(historyStore));

  return {
    deps: {
      identity: mockIdentity(),
      storage: mockStorage(),
      tokenStorageProviders,
      transport: mockTransport(),
      oracle: mockOracle(),
      tokenEngine: engine,
      emitEvent: vi.fn(),
    },
    historyStore,
  };
}

/** Mint a v2 engine token and wrap it as a wallet Token (blob sdkData). */
async function createBlobToken(engine: FakeTokenEngine, amount = 1000000n): Promise<Token> {
  const minted = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const sdkData = bytesToHex(encodeTokenBlob(engine.encodeToken(minted)));
  return {
    id: `v2_${engine.tokenId(minted)}`,
    coinId: UCT,
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: String(amount),
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule Transaction History', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let engine: FakeTokenEngine;
  let historyStore: ReturnType<typeof createMockHistoryStore>;

  beforeEach(() => {
    module = createPaymentsModule({ debug: false });
    engine = new FakeTokenEngine();
    const mocks = createMockDeps(engine);
    historyStore = mocks.historyStore;
    module.initialize(mocks.deps);
  });

  describe('addToHistory', () => {
    it('should store an entry via the history store', async () => {
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '1000000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: Date.now(),
        tokenId: 'test-token-123',
      });

      expect(historyStore.addHistoryEntry).toHaveBeenCalledTimes(1);
      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.type).toBe('RECEIVED');
      expect(arg.amount).toBe('1000000');
      expect(arg.dedupKey).toBe('RECEIVED_test-token-123');
      expect(arg.id).toBeDefined();
    });

    it('should compute dedupKey from type + tokenId', async () => {
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '500',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: Date.now(),
        tokenId: 'my-token',
      });

      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.dedupKey).toBe('RECEIVED_my-token');
    });

    it('should compute dedupKey from type + transferId for SENT', async () => {
      await module.addToHistory({
        type: 'SENT',
        amount: '500',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: Date.now(),
        transferId: 'transfer-456',
      });

      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.dedupKey).toBe('SENT_transfer_transfer-456');
    });

    it('should deduplicate entries with the same dedupKey', async () => {
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 100,
        tokenId: 'dup-token',
      });

      await module.addToHistory({
        type: 'RECEIVED',
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 200,
        tokenId: 'dup-token',
      });

      // addHistoryEntry called twice (upsert), but store only has 1 entry
      expect(historyStore._entries.size).toBe(1);
      // In-memory cache should also have 1 entry
      expect(module.getHistory()).toHaveLength(1);
    });
  });

  describe('getHistory', () => {
    it('should return entries sorted by timestamp descending', async () => {
      await module.addToHistory({
        type: 'RECEIVED',
        amount: '100',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1000,
        tokenId: 'token-1',
      });

      await module.addToHistory({
        type: 'SENT',
        amount: '200',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 3000,
        transferId: 'tx-1',
      });

      await module.addToHistory({
        type: 'RECEIVED',
        amount: '300',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 2000,
        tokenId: 'token-2',
      });

      const history = module.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].timestamp).toBe(3000);
      expect(history[1].timestamp).toBe(2000);
      expect(history[2].timestamp).toBe(1000);
    });

    it('should return empty array when no history', () => {
      expect(module.getHistory()).toHaveLength(0);
    });
  });

  describe('addToken creates NO history', () => {
    it('should not call addHistoryEntry when adding a token', async () => {
      const token = await createBlobToken(engine);

      await module.addToken(token);

      expect(historyStore.addHistoryEntry).not.toHaveBeenCalled();
      expect(module.getHistory()).toHaveLength(0);
    });
  });

  describe('removeToken creates NO history', () => {
    it('should not call addHistoryEntry when removing a token', async () => {
      const token = await createBlobToken(engine);

      await module.addToken(token);
      historyStore.addHistoryEntry.mockClear();

      await module.removeToken(token.id);

      expect(historyStore.addHistoryEntry).not.toHaveBeenCalled();
      expect(module.getHistory()).toHaveLength(0);
    });
  });

  describe('loadHistory migration', () => {
    it('should migrate legacy KV history to new store on load', async () => {
      const mocks = createMockDeps(engine);
      const mod = createPaymentsModule({ debug: false });

      // Set up legacy KV data
      const legacyEntries = [
        { id: 'old-1', type: 'RECEIVED', amount: '100', coinId: 'UCT', symbol: 'UCT', timestamp: 1000 },
        { id: 'old-2', type: 'SENT', amount: '200', coinId: 'UCT', symbol: 'UCT', timestamp: 2000 },
      ];
      await mocks.deps.storage.set(
        STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY,
        JSON.stringify(legacyEntries),
      );

      mod.initialize(mocks.deps);
      await mod.load();

      // importHistoryEntries should have been called with the legacy entries
      expect(mocks.historyStore.importHistoryEntries).toHaveBeenCalledTimes(1);
      // Legacy entries are now in the history store / cache
      expect(mod.getHistory()).toHaveLength(2);
      // Legacy KV key should have been deleted
      expect(mocks.deps.storage.remove).toHaveBeenCalledWith(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
    });
  });
});
