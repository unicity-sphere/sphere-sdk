/**
 * Integration tests for L3 transaction history deduplication.
 *
 * Verifies that each logical operation (send, receive) produces exactly ONE
 * history entry — even though tokens pass through multiple internal methods
 * (addToken, removeToken, finalize, resolveV5Token) that historically created
 * duplicates.
 *
 * Covers:
 * 1. send() with direct tokens → 1 SENT entry (removeToken creates none)
 * 2. send() with instant split → 1 SENT entry
 * 3. send() preserves memo and recipient metadata in history
 * 4. V5 instant split receive → 1 RECEIVED entry (resolveV5Token creates none)
 * 5. V5 receive populates sender info via resolveSenderInfo
 * 6. V5 receive passes memo into history
 * 7. V5 duplicate bundle → still 1 entry (dedup by splitGroupId)
 * 8. Commitment-only receive → 1 RECEIVED entry (finalizeReceivedToken creates none)
 * 9. finalizeReceivedToken() does NOT add to history
 * 10. resolveSenderInfo() — transport resolution and error handling
 */

import { describe, it, expect, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';

// =============================================================================
// Mock SDK dependencies (same as tokenTransfers test)
// =============================================================================

const mockCalculateOptimalSplit = vi.fn();
vi.mock('../../../modules/payments/TokenSplitCalculator', () => ({
  TokenSplitCalculator: class {
    calculateOptimalSplit = mockCalculateOptimalSplit;
  },
}));

const mockExecuteSplitInstant = vi.fn();
const mockBuildSplitBundle = vi.fn();
vi.mock('../../../modules/payments/InstantSplitExecutor', () => ({
  InstantSplitExecutor: class {
    constructor() {}
    executeSplitInstant = mockExecuteSplitInstant;
    buildSplitBundle = mockBuildSplitBundle;
  },
}));

const mockExecuteSplit = vi.fn();
vi.mock('../../../modules/payments/TokenSplitExecutor', () => ({
  TokenSplitExecutor: class {
    constructor() {}
    executeSplit = mockExecuteSplit;
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      id: { toString: () => 'mock-id', toJSON: () => 'mock-id' },
      coins: null,
      state: {},
      toJSON: () => ({ genesis: {}, state: {} }),
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: {
    create: vi.fn(),
    fromJSON: vi.fn().mockResolvedValue({
      requestId: new Uint8Array([0xaa, 0xbb, 0xcc]),
      toJSON: () => ({ requestId: 'aabbcc' }),
      toTransaction: () => ({
        toJSON: () => ({ requestId: 'aabbcc', proof: 'mock' }),
        data: { requestId: new Uint8Array([0xaa, 0xbb, 0xcc]) },
      }),
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: {
    fromKeyPair: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: { create: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class { constructor() {} },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType', () => ({
  TokenType: class { constructor() {} },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment', () => ({
  MintCommitment: { create: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: { createFromNametag: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({ proof: 'mock-proof' }),
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof', () => ({
  InclusionProof: {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class {
    constructor() {}
    static fromHex() { return new this(); }
    toJSON() { return 'UCT_HEX'; }
  },
}));

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../serialization/txf-serializer', () => ({
  tokenToTxf: vi.fn(),
  getCurrentStateHash: vi.fn(),
  buildTxfStorageData: vi.fn().mockResolvedValue({}),
  parseTxfStorageData: vi.fn().mockReturnValue({ tokens: [], tombstones: [], sent: [] }),
}));

vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: vi.fn().mockReturnValue({
      getToken: vi.fn(),
      getAllTokens: vi.fn().mockReturnValue([]),
      getSymbol: vi.fn().mockReturnValue('UCT'),
      getName: vi.fn().mockReturnValue('Unicity Token'),
      getDecimals: vi.fn().mockReturnValue(8),
      getIconUrl: vi.fn().mockReturnValue(undefined),
      getDefinition: vi.fn().mockReturnValue(null),
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Constants
// =============================================================================

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);

// =============================================================================
// Helpers
// =============================================================================

function createMockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    privateKey: FAKE_PRIVATE_KEY,
    transportPubkey: 'dd'.repeat(32),
  };
}

/** In-memory history store that mimics IndexedDB / File history store */
function createMockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (entry: HistoryRecord) => {
      entries.set(entry.dedupKey, entry);
    }),
    getHistoryEntries: vi.fn(async () =>
      [...entries.values()].sort((a, b) => b.timestamp - a.timestamp),
    ),
    hasHistoryEntry: vi.fn(async (key: string) => entries.has(key)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async (importEntries: HistoryRecord[]) => {
      let count = 0;
      for (const e of importEntries) {
        if (!entries.has(e.dedupKey)) { entries.set(e.dedupKey, e); count++; }
      }
      return count;
    }),
    _entries: entries,
  };
}

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    remove: vi.fn(async (key: string) => { store.delete(key); }),
    has: vi.fn(async (key: string) => store.has(key)),
    keys: vi.fn(async () => Array.from(store.keys())),
    clear: vi.fn(async () => { store.clear(); }),
  } as unknown as StorageProvider;
}

function createMockTransport(senderNametag?: string): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY,
      transportPubkey: 'transport-pub',
      directAddress: 'DIRECT://recipient',
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY,
      transportPubkey: 'transport-pub',
    }),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY,
      transportPubkey: SENDER_TRANSPORT_PUBKEY,
      directAddress: 'DIRECT://sender',
      nametag: senderNametag ?? 'alice',
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue({
      submitTransferCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    }),
    getTrustBase: vi.fn().mockReturnValue({}),
    isDevMode: vi.fn().mockReturnValue(false),
    waitForProofSdk: vi.fn().mockResolvedValue({ proof: 'mock' }),
  } as unknown as OracleProvider;
}

function createMockToken(id: string, amount: string, coinId: string = 'UCT'): Token {
  return {
    id,
    coinId,
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount,
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify({
      genesis: { data: { tokenId: id, coinData: { [coinId]: amount } } },
      state: {},
    }),
  };
}

function createMockSdkToken() {
  return {
    toJSON: () => ({
      genesis: { data: { tokenId: 'sdk-token-id', coinData: { UCT: '1000000' } } },
      state: {},
    }),
    state: { calculateHash: () => new Uint8Array(32) },
  };
}

function createMockCommitment(requestIdHex: string) {
  const requestIdBytes = new Uint8Array(
    requestIdHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)),
  );
  return {
    requestId: requestIdBytes,
    toJSON: () => ({ requestId: requestIdHex }),
    toTransaction: () => ({
      toJSON: () => ({ requestId: requestIdHex, proof: 'mock' }),
      data: { requestId: requestIdBytes },
    }),
  };
}

interface TestContext {
  module: ReturnType<typeof createPaymentsModule>;
  deps: PaymentsModuleDependencies;
  historyStore: ReturnType<typeof createMockHistoryStore>;
  transport: TransportProvider;
}

function setupModule(senderNametag?: string): TestContext {
  const historyStore = createMockHistoryStore();
  const transport = createMockTransport(senderNametag);

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
  tokenStorageProviders.set('local', mockTokenStorage);

  const deps: PaymentsModuleDependencies = {
    identity: createMockIdentity(),
    storage: createMockStorage(),
    tokenStorageProviders,
    transport,
    oracle: createMockOracle(),
    emitEvent: vi.fn(),
  };

  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);

  return { module, deps, historyStore, transport };
}

/** Prepare module for send(): mock heavy private methods but keep addToHistory real */
function prepareSendMocks(ctx: TestContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = ctx.module as any;
  mod.resolveRecipient = vi.fn().mockResolvedValue(FAKE_PUBKEY);
  mod.resolveRecipientAddress = vi.fn().mockResolvedValue({ scheme: 0 });
  mod.createSigningService = vi.fn().mockResolvedValue({});
  mod.save = vi.fn().mockResolvedValue(undefined);
  mod.saveToOutbox = vi.fn().mockResolvedValue(undefined);
  mod.removeFromOutbox = vi.fn().mockResolvedValue(undefined);
  // removeToken: mock to just delete from map (no heavy storage ops)
  mod.removeToken = vi.fn(async (tokenId: string) => {
    mod.tokens.delete(tokenId);
  });
  // addToken: mock to just set in map
  mod.addToken = vi.fn(async (token: Token) => {
    mod.tokens.set(token.id, token);
    return true;
  });
  // Do NOT mock addToHistory — that's what we're testing
  return mod;
}

/** Create a V5 instant split bundle */
function createV5Bundle(overrides?: Record<string, unknown>) {
  return {
    version: '5.0',
    type: 'INSTANT_SPLIT',
    splitGroupId: 'split-group-123',
    coinId: 'UCT',
    amount: '500000',
    tokenTypeHex: '00',
    burnTransaction: JSON.stringify({ data: 'burn-tx-data' }),
    recipientMintData: JSON.stringify({ data: 'mint-data' }),
    transferCommitment: JSON.stringify({ requestId: 'aabbcc' }),
    senderPubkey: FAKE_PUBKEY,
    recipientSaltHex: 'aa',
    transferSaltHex: 'bb',
    mintedTokenStateJson: JSON.stringify({ data: 'state' }),
    finalRecipientStateJson: JSON.stringify({ data: 'final-state' }),
    recipientAddressJson: JSON.stringify({ scheme: 0 }),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('History deduplication — integration flows', () => {

  // ===========================================================================
  // send() flow
  // ===========================================================================

  describe('send() → single SENT history entry', () => {
    it('should create exactly 1 SENT entry for 2 direct tokens', async () => {
      const ctx = setupModule();
      const mod = prepareSendMocks(ctx);

      const token1 = createMockToken('token-aaa', '1000000');
      const token2 = createMockToken('token-bbb', '2000000');
      mod.tokens.set(token1.id, token1);
      mod.tokens.set(token2.id, token2);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000000n, uiToken: token1 },
          { sdkToken: createMockSdkToken(), amount: 2000000n, uiToken: token2 },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      const commitment = createMockCommitment('aa'.repeat(16));
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      await ctx.module.send({
        recipient: '@bob',
        amount: '3000000',
        coinId: 'UCT',
      });

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('SENT');
      expect(history[0].amount).toBe('3000000');
      expect(history[0].coinId).toBe('UCT');
    });

    it('should create exactly 1 SENT entry for instant split', async () => {
      const ctx = setupModule();
      const mod = prepareSendMocks(ctx);

      const token = createMockToken('token-big', '10000000');
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [],
        tokenToSplit: { sdkToken: createMockSdkToken(), amount: 10000000n, uiToken: token },
        splitAmount: 3000000n,
        remainderAmount: 7000000n,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockBuildSplitBundle.mockResolvedValue({
        bundle: { version: '5.0', type: 'INSTANT_SPLIT', splitGroupId: 'sg-1' },
        splitGroupId: 'sg-1',
        startBackground: vi.fn().mockResolvedValue(undefined),
      });

      await ctx.module.send({
        recipient: '@bob',
        amount: '3000000',
        coinId: 'UCT',
      });

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('SENT');
      expect(history[0].amount).toBe('3000000');
    });

    it('should preserve memo in SENT history entry', async () => {
      const ctx = setupModule();
      const mod = prepareSendMocks(ctx);

      const token = createMockToken('token-memo', '5000000');
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 5000000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 5000000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      const commitment = createMockCommitment('dd'.repeat(16));
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      await ctx.module.send({
        recipient: '@bob',
        amount: '5000000',
        coinId: 'UCT',
        memo: 'Payment for coffee',
      });

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].memo).toBe('Payment for coffee');
    });

    it('should populate recipient metadata from peerInfo', async () => {
      const ctx = setupModule();
      const mod = prepareSendMocks(ctx);

      const token = createMockToken('token-meta', '1000000');
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      const commitment = createMockCommitment('ee'.repeat(16));
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      await ctx.module.send({
        recipient: '@bob',
        amount: '1000000',
        coinId: 'UCT',
      });

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].recipientNametag).toBe('bob');
      expect(history[0].recipientAddress).toBe('DIRECT://recipient');
    });

    it('should NOT create history entries from removeToken during send', async () => {
      const ctx = setupModule();
      const mod = prepareSendMocks(ctx);
      const addToHistorySpy = vi.spyOn(ctx.module, 'addToHistory');

      const token = createMockToken('token-rm', '1000000');
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      const commitment = createMockCommitment('ff'.repeat(16));
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      await ctx.module.send({
        recipient: '@bob',
        amount: '1000000',
        coinId: 'UCT',
      });

      // addToHistory called exactly once — from the send() success path, not from removeToken
      expect(addToHistorySpy).toHaveBeenCalledTimes(1);
      expect(addToHistorySpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SENT' }),
      );
    });
  });

  // ===========================================================================
  // V5 instant split receive flow
  // ===========================================================================

  describe('V5 instant split receive → single RECEIVED entry', () => {
    it('should create exactly 1 RECEIVED entry', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      mod.addToken = vi.fn(async (token: Token) => {
        mod.tokens.set(token.id, token);
        return true;
      });
      mod.resolveUnconfirmed = vi.fn().mockResolvedValue(undefined);

      const bundle = createV5Bundle();
      await mod.processInstantSplitBundle(bundle, SENDER_TRANSPORT_PUBKEY, 'hello');

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('RECEIVED');
      expect(history[0].amount).toBe('500000');
      expect(history[0].coinId).toBe('UCT');
    });

    it('should populate sender info via resolveSenderInfo', async () => {
      const ctx = setupModule('alice');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      mod.addToken = vi.fn(async (token: Token) => {
        mod.tokens.set(token.id, token);
        return true;
      });
      mod.resolveUnconfirmed = vi.fn().mockResolvedValue(undefined);

      const bundle = createV5Bundle();
      await mod.processInstantSplitBundle(bundle, SENDER_TRANSPORT_PUBKEY);

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].senderPubkey).toBe(SENDER_TRANSPORT_PUBKEY);
      expect(history[0].senderNametag).toBe('alice');
      expect(history[0].senderAddress).toBe('DIRECT://sender');
    });

    it('should preserve memo in RECEIVED entry', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      mod.addToken = vi.fn(async (token: Token) => {
        mod.tokens.set(token.id, token);
        return true;
      });
      mod.resolveUnconfirmed = vi.fn().mockResolvedValue(undefined);

      const bundle = createV5Bundle();
      await mod.processInstantSplitBundle(bundle, SENDER_TRANSPORT_PUBKEY, 'Thanks!');

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].memo).toBe('Thanks!');
    });

    it('should not create a second entry for duplicate V5 bundle', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      mod.addToken = vi.fn(async (token: Token) => {
        mod.tokens.set(token.id, token);
        return true;
      });
      mod.resolveUnconfirmed = vi.fn().mockResolvedValue(undefined);

      const bundle = createV5Bundle();
      await mod.processInstantSplitBundle(bundle, SENDER_TRANSPORT_PUBKEY);
      // Send the same bundle again (Nostr re-delivery)
      await mod.processInstantSplitBundle(bundle, SENDER_TRANSPORT_PUBKEY);

      const history = ctx.module.getHistory();
      // Dedup: deterministic ID v5split_{splitGroupId} blocks the second call
      expect(history).toHaveLength(1);
    });

    it('should emit transfer:incoming with senderNametag and memo', async () => {
      const ctx = setupModule('alice');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      mod.addToken = vi.fn(async (token: Token) => {
        mod.tokens.set(token.id, token);
        return true;
      });
      mod.resolveUnconfirmed = vi.fn().mockResolvedValue(undefined);

      const bundle = createV5Bundle();
      await mod.processInstantSplitBundle(bundle, SENDER_TRANSPORT_PUBKEY, 'test memo');

      expect(ctx.deps.emitEvent).toHaveBeenCalledWith(
        'transfer:incoming',
        expect.objectContaining({
          senderNametag: 'alice',
          memo: 'test memo',
        }),
      );
    });
  });

  // ===========================================================================
  // Commitment-only receive flow
  // ===========================================================================

  describe('commitment-only receive → single RECEIVED entry', () => {
    it('should create exactly 1 RECEIVED entry from handleCommitmentOnlyTransfer', async () => {
      const ctx = setupModule('alice');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      mod.addProofPollingJob = vi.fn();

      const transfer = {
        id: 'transfer-nostr-1',
        senderTransportPubkey: SENDER_TRANSPORT_PUBKEY,
        payload: {},
        timestamp: Date.now(),
      };

      // sourceToken with TXF-style genesis data so extractTokenIdFromSdkData returns a value
      const sourceToken = {
        genesis: {
          data: {
            tokenId: 'token-conly-1',
            tokenType: '00',
            coinData: [['UCT_HEX', '750000']],
            tokenData: '',
            salt: '00',
            recipient: 'DIRECT://test',
            recipientDataHash: null,
            reason: null,
          },
          inclusionProof: {
            authenticator: { algorithm: 'secp256k1', publicKey: 'pk', signature: 'sig', stateHash: 'sh' },
            merkleTreePath: { root: '00', steps: [] },
            transactionHash: '00',
            unicityCertificate: '00',
          },
        },
        state: { data: 'statedata', predicate: 'predicate' },
        transactions: [],
      };

      const payload = {
        sourceToken: JSON.stringify(sourceToken),
        commitmentData: JSON.stringify({ requestId: 'aabbcc' }),
        memo: 'commitment memo',
      };

      await mod.handleCommitmentOnlyTransfer(transfer, payload);

      const history = ctx.module.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe('RECEIVED');
      expect(history[0].senderPubkey).toBe(SENDER_TRANSPORT_PUBKEY);
      expect(history[0].senderNametag).toBe('alice');
      expect(history[0].memo).toBe('commitment memo');
    });
  });

  // ===========================================================================
  // finalizeReceivedToken does NOT create history
  // ===========================================================================

  describe('finalizeReceivedToken → no history entry', () => {
    it('should NOT call addToHistory during finalization', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;
      mod.save = vi.fn().mockResolvedValue(undefined);
      const addToHistorySpy = vi.spyOn(ctx.module, 'addToHistory');

      // Pre-populate a submitted token (simulates what handleCommitmentOnlyTransfer creates)
      const token: Token = {
        id: 'token-to-finalize',
        coinId: 'UCT',
        symbol: 'UCT',
        name: 'Unicity Token',
        decimals: 8,
        amount: '1000000',
        status: 'submitted',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sdkData: JSON.stringify({
          genesis: { data: { tokenId: 'token-to-finalize' } },
          state: {},
        }),
      };
      mod.tokens.set(token.id, token);

      // Mock the finalization helpers
      mod.finalizeTransferToken = vi.fn().mockResolvedValue({
        toJSON: () => ({
          genesis: { data: { tokenId: 'token-to-finalize' } },
          state: { finalized: true },
        }),
      });

      const sourceTokenInput = { genesis: {}, state: {} };
      const commitmentInput = { requestId: 'aabbcc' };

      await mod.finalizeReceivedToken(token.id, sourceTokenInput, commitmentInput);

      // The token should be confirmed now
      expect(mod.tokens.get(token.id).status).toBe('confirmed');
      // But NO new history entry was created
      expect(addToHistorySpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // resolveSenderInfo
  // ===========================================================================

  describe('resolveSenderInfo', () => {
    it('should resolve nametag and address from transport', async () => {
      const ctx = setupModule('alice');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info.senderNametag).toBe('alice');
      expect(info.senderAddress).toBe('DIRECT://sender');
    });

    it('should return empty object when transport throws', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.transport as any).resolveTransportPubkeyInfo = vi.fn().mockRejectedValue(new Error('network error'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info).toEqual({});
    });

    it('should return empty object when transport lacks resolveTransportPubkeyInfo', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (ctx.transport as any).resolveTransportPubkeyInfo;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info).toEqual({});
    });

    it('should return empty object when resolveTransportPubkeyInfo returns null', async () => {
      const ctx = setupModule();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.transport as any).resolveTransportPubkeyInfo = vi.fn().mockResolvedValue(null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = ctx.module as any;

      const info = await mod.resolveSenderInfo(SENDER_TRANSPORT_PUBKEY);
      expect(info).toEqual({});
    });
  });

  // ===========================================================================
  // history:updated event
  // ===========================================================================

  describe('history:updated event', () => {
    it('should emit history:updated when addToHistory is called', async () => {
      const ctx = setupModule();

      await ctx.module.addToHistory({
        type: 'RECEIVED',
        amount: '100',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: Date.now(),
        tokenId: 'evt-token',
      });

      expect(ctx.deps.emitEvent).toHaveBeenCalledWith(
        'history:updated',
        expect.objectContaining({
          type: 'RECEIVED',
          amount: '100',
          dedupKey: 'RECEIVED_evt-token',
        }),
      );
    });
  });
});
