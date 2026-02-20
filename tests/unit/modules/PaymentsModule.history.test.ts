/**
 * Tests for PaymentsModule transaction history
 *
 * Covers:
 * 1. addToHistory() stores entries and prevents duplicates via dedupKey
 * 2. getHistory() returns sorted entries
 * 3. addToken() creates NO history entries
 * 4. removeToken() creates NO history entries
 * 5. Deduplication via dedupKey (same tokenId + type = single entry)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
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
// Test Constants
// =============================================================================

const TOKEN_ID_A = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_1 = '1111000000000000000000000000000000000000000000000000000000000001';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockToken(opts: {
  tokenId: string;
  stateHash: string;
  id?: string;
  amount?: string;
  coinId?: string;
}): Token {
  return {
    id: opts.id ?? `local-${opts.tokenId.slice(0, 8)}`,
    coinId: opts.coinId ?? 'UCT',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: opts.amount ?? '1000000',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify({
      version: '2.0',
      genesis: {
        data: {
          tokenId: opts.tokenId,
          tokenType: '00',
          coinData: [['UCT_HEX', opts.amount ?? '1000000']],
          tokenData: '',
          salt: '00',
          recipient: 'DIRECT://test',
          recipientDataHash: null,
          reason: null,
        },
        inclusionProof: {
          authenticator: { algorithm: 'secp256k1', publicKey: 'pubkey', signature: 'sig', stateHash: opts.stateHash },
          merkleTreePath: { root: '00', steps: [] },
          transactionHash: '00',
          unicityCertificate: '00',
        },
      },
      state: { data: 'statedata', predicate: 'predicate' },
      transactions: [],
    }),
  };
}

/** In-memory history store that mimics IndexedDB history store */
function createMockHistoryStore() {
  const entries = new Map<string, Record<string, unknown>>();
  return {
    addHistoryEntry: vi.fn(async (entry: Record<string, unknown>) => {
      entries.set(entry.dedupKey as string, entry);
    }),
    getHistoryEntries: vi.fn(async () => {
      return [...entries.values()].sort(
        (a, b) => (b.timestamp as number) - (a.timestamp as number)
      );
    }),
    hasHistoryEntry: vi.fn(async (dedupKey: string) => entries.has(dedupKey)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async (importEntries: Record<string, unknown>[]) => {
      let count = 0;
      for (const entry of importEntries) {
        if (!entries.has(entry.dedupKey as string)) {
          entries.set(entry.dedupKey as string, entry);
          count++;
        }
      }
      return count;
    }),
    _entries: entries,
  };
}

function createMockDeps(): { deps: PaymentsModuleDependencies; historyStore: ReturnType<typeof createMockHistoryStore> } {
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
  };

  // Token storage provider with history methods (mimics IndexedDBTokenStorageProvider)
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
    // History store methods
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
    transportPubkey: 'c'.repeat(64),
  };

  return {
    deps: {
      identity: mockIdentity,
      storage: mockStorage,
      tokenStorageProviders,
      transport: mockTransport,
      oracle: mockOracle,
      emitEvent: vi.fn(),
    },
    historyStore,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule Transaction History', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let historyStore: ReturnType<typeof createMockHistoryStore>;

  beforeEach(() => {
    module = createPaymentsModule();
    const mocks = createMockDeps();
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
      const token = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
      });

      await module.addToken(token);

      expect(historyStore.addHistoryEntry).not.toHaveBeenCalled();
      expect(module.getHistory()).toHaveLength(0);
    });
  });

  describe('removeToken creates NO history', () => {
    it('should not call addHistoryEntry when removing a token', async () => {
      const token = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
      });

      await module.addToken(token);
      historyStore.addHistoryEntry.mockClear();

      await module.removeToken(token.id);

      expect(historyStore.addHistoryEntry).not.toHaveBeenCalled();
      expect(module.getHistory()).toHaveLength(0);
    });
  });

  describe('loadHistory migration', () => {
    it('should migrate legacy KV history to new store on load', async () => {
      const mocks = createMockDeps();
      const mod = createPaymentsModule();

      // Set up legacy KV data
      const legacyEntries = [
        { id: 'old-1', type: 'RECEIVED', amount: '100', coinId: 'UCT', symbol: 'UCT', timestamp: 1000 },
        { id: 'old-2', type: 'SENT', amount: '200', coinId: 'UCT', symbol: 'UCT', timestamp: 2000 },
      ];
      (mocks.deps.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify(legacyEntries)
      );

      mod.initialize(mocks.deps);
      await mod.load();

      // importHistoryEntries should have been called with the legacy entries
      expect(mocks.historyStore.importHistoryEntries).toHaveBeenCalledTimes(1);
      // Legacy KV key should have been deleted
      expect(mocks.deps.storage.remove).toHaveBeenCalled();
    });
  });
});
