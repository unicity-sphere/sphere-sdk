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

    it('should compute dedupKey from type + transferId + coinId for SENT', async () => {
      // #149 multi-coin follow-up — SENT dedupKey includes coinId so
      // multi-coin sends don't collide on the same transferId.
      await module.addToHistory({
        type: 'SENT',
        amount: '500',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: Date.now(),
        transferId: 'transfer-456',
      });

      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.dedupKey).toBe('SENT_transfer_transfer-456_UCT');
    });

    it('should fall back to legacy SENT dedupKey when coinId is missing', async () => {
      // Backward compat for legacy callers that don't set coinId. The
      // HistoryRecord type requires coinId, but defensive code at the
      // helper level should still produce a stable key.
      await module.addToHistory({
        type: 'SENT',
        amount: '500',
        coinId: '',
        symbol: '',
        timestamp: Date.now(),
        transferId: 'transfer-789',
      });

      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.dedupKey).toBe('SENT_transfer_transfer-789');
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

  describe('recordUxfBundleSentHistory — multi-coin (#149 follow-up)', () => {
    // The helper pivots `TransferResult.tokenTransfers` by source coinId
    // and emits one SENT history row per coin in the bundle (primary +
    // each additionalAssets coin). NFT additionals are deliberately
    // skipped — they have no fungible "amount" slot.

    /**
     * Build a minimal Token mock for the source-tokens array. Only the
     * fields the helper reads are populated.
     */
    function srcToken(id: string, coinId: string, amount: string): Token {
      return {
        id,
        coinId,
        symbol: coinId,
        name: coinId,
        decimals: 6,
        amount,
        status: 'confirmed',
        createdAt: 0,
        updatedAt: 0,
        sdkData: '{}',
      };
    }

    it('emits one SENT row per coin with distinct dedupKeys + per-coin tokenIds', async () => {
      // Sources: 2 UCT tokens + 1 USDU token. Primary slot = UCT(200);
      // additional = USDU(100). The helper should pivot per coin.
      const result = {
        id: 'transfer-multi-1',
        status: 'completed' as const,
        tokens: [
          srcToken('uct-1', 'UCT_HEX', '120'),
          srcToken('uct-2', 'UCT_HEX', '80'),
          srcToken('usdu-1', 'USDU_HEX', '100'),
        ],
        tokenTransfers: [
          { sourceTokenId: 'uct-1', method: 'direct' as const, requestIdHex: 'r1' },
          { sourceTokenId: 'uct-2', method: 'split' as const, splitGroupId: 'g1' },
          { sourceTokenId: 'usdu-1', method: 'direct' as const, requestIdHex: 'r3' },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (module as any).recordUxfBundleSentHistory({
        originalRequest: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '200',
          additionalAssets: [{ kind: 'coin', coinId: 'USDU_HEX', amount: '100' }],
        },
        request: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '200',
        },
        result,
        peerInfo: { directAddress: 'DIRECT://bob', nametag: 'bob' },
        recipientPubkey: 'bob-pk',
        recipientAddress: { toString: () => 'DIRECT://bob' },
        diagLabel: 'test',
      });

      // Two entries — one per coin
      expect(historyStore.addHistoryEntry).toHaveBeenCalledTimes(2);
      const calls = historyStore.addHistoryEntry.mock.calls.map((c) => c[0]);

      const uctEntry = calls.find((e) => e.coinId === 'UCT_HEX');
      const usduEntry = calls.find((e) => e.coinId === 'USDU_HEX');
      expect(uctEntry).toBeDefined();
      expect(usduEntry).toBeDefined();

      // Primary row — UCT, amount 200, two tokenIds breakdown
      expect(uctEntry!.type).toBe('SENT');
      expect(uctEntry!.amount).toBe('200');
      expect(uctEntry!.transferId).toBe('transfer-multi-1');
      expect(uctEntry!.dedupKey).toBe('SENT_transfer_transfer-multi-1_UCT_HEX');
      expect(uctEntry!.tokenIds).toEqual([
        { id: 'uct-1', amount: '120', source: 'direct' },
        { id: 'uct-2', amount: '80', source: 'split' },
      ]);
      expect(uctEntry!.tokenId).toBe('uct-1');
      expect(uctEntry!.recipientNametag).toBe('bob');
      expect(uctEntry!.recipientAddress).toBe('DIRECT://bob');

      // Additional row — USDU, amount 100, one tokenId
      expect(usduEntry!.amount).toBe('100');
      expect(usduEntry!.dedupKey).toBe('SENT_transfer_transfer-multi-1_USDU_HEX');
      expect(usduEntry!.tokenIds).toEqual([
        { id: 'usdu-1', amount: '100', source: 'direct' },
      ]);
      expect(usduEntry!.tokenId).toBe('usdu-1');
    });

    it('emits only the primary entry when there are no additional coin assets', async () => {
      const result = {
        id: 'transfer-single-1',
        status: 'completed' as const,
        tokens: [srcToken('uct-1', 'UCT_HEX', '200')],
        tokenTransfers: [
          { sourceTokenId: 'uct-1', method: 'direct' as const, requestIdHex: 'r1' },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (module as any).recordUxfBundleSentHistory({
        originalRequest: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '200',
        },
        request: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '200',
        },
        result,
        peerInfo: { directAddress: 'DIRECT://bob' },
        recipientPubkey: 'bob-pk',
        recipientAddress: { toString: () => 'DIRECT://bob' },
        diagLabel: 'test',
      });

      expect(historyStore.addHistoryEntry).toHaveBeenCalledTimes(1);
      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.dedupKey).toBe('SENT_transfer_transfer-single-1_UCT_HEX');
    });

    it('skips NFT additionals — only coin entries get history rows', async () => {
      const result = {
        id: 'transfer-mixed-1',
        status: 'completed' as const,
        tokens: [
          srcToken('uct-1', 'UCT_HEX', '200'),
          srcToken('nft-1', 'NFT_HEX', '1'),
        ],
        tokenTransfers: [
          { sourceTokenId: 'uct-1', method: 'split' as const, splitGroupId: 'g1' },
          { sourceTokenId: 'nft-1', method: 'direct' as const, requestIdHex: 'r-nft' },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (module as any).recordUxfBundleSentHistory({
        originalRequest: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '200',
          additionalAssets: [{ kind: 'nft', tokenId: 'nft-1' }],
        },
        request: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '200',
        },
        result,
        peerInfo: null,
        recipientPubkey: 'bob-pk',
        recipientAddress: { toString: () => 'DIRECT://bob' },
        diagLabel: 'test',
      });

      // Only the primary coin's row — NFT additional is skipped.
      expect(historyStore.addHistoryEntry).toHaveBeenCalledTimes(1);
      const arg = historyStore.addHistoryEntry.mock.calls[0][0];
      expect(arg.coinId).toBe('UCT_HEX');
    });

    it('swallows per-entry storage errors and continues to the next coin', async () => {
      // Force the first addHistoryEntry call to throw. Subsequent calls
      // for other coins must still be attempted — a history I/O hiccup
      // on one coin must not drop sibling entries.
      historyStore.addHistoryEntry
        .mockImplementationOnce(async () => {
          throw new Error('disk full');
        })
        .mockImplementationOnce(async (entry) => {
          historyStore._entries.set(entry.dedupKey as string, entry);
        });

      const result = {
        id: 'transfer-err-1',
        status: 'completed' as const,
        tokens: [
          srcToken('uct-1', 'UCT_HEX', '100'),
          srcToken('usdu-1', 'USDU_HEX', '50'),
        ],
        tokenTransfers: [
          { sourceTokenId: 'uct-1', method: 'direct' as const, requestIdHex: 'r1' },
          { sourceTokenId: 'usdu-1', method: 'direct' as const, requestIdHex: 'r2' },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((module as any).recordUxfBundleSentHistory({
        originalRequest: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '100',
          additionalAssets: [{ kind: 'coin', coinId: 'USDU_HEX', amount: '50' }],
        },
        request: {
          recipient: '@bob',
          coinId: 'UCT_HEX',
          amount: '100',
        },
        result,
        peerInfo: null,
        recipientPubkey: 'bob-pk',
        recipientAddress: { toString: () => 'DIRECT://bob' },
        diagLabel: 'test',
      })).resolves.toBeUndefined();

      // Both attempts made; the second succeeded.
      expect(historyStore.addHistoryEntry).toHaveBeenCalledTimes(2);
      expect(historyStore._entries.size).toBe(1);
      expect(
        historyStore._entries.has('SENT_transfer_transfer-err-1_USDU_HEX'),
      ).toBe(true);
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
