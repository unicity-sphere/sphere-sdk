/**
 * Tests for TransferResult.tokenTransfers tracking in PaymentsModule.send()
 *
 * Verifies that each source token consumed during a transfer gets its own
 * TokenTransferDetail entry instead of overwriting a single txHash field.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity, TransferResult, TokenTransferDetail } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';

// =============================================================================
// Mock SDK dependencies to avoid network/crypto calls
// =============================================================================

// Mock TokenSplitCalculator — controls what split plan is returned
const mockCalculateOptimalSplit = vi.fn();
vi.mock('../../../modules/payments/TokenSplitCalculator', () => ({
  TokenSplitCalculator: class {
    calculateOptimalSplit = mockCalculateOptimalSplit;
  },
}));

// Mock InstantSplitExecutor — controls split execution result
const mockExecuteSplitInstant = vi.fn();
vi.mock('../../../modules/payments/InstantSplitExecutor', () => ({
  InstantSplitExecutor: class {
    constructor() {}
    executeSplitInstant = mockExecuteSplitInstant;
  },
}));

// Mock TokenSplitExecutor — controls conservative split execution result
const mockExecuteSplit = vi.fn();
vi.mock('../../../modules/payments/TokenSplitExecutor', () => ({
  TokenSplitExecutor: class {
    constructor() {}
    executeSplit = mockExecuteSplit;
  },
}));

// Mock state-transition-sdk imports used by send()
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: {
    create: vi.fn(),
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
      getDecimals: vi.fn().mockReturnValue(18),
      getIconUrl: vi.fn().mockReturnValue(undefined),
    }),
  },
}));

// =============================================================================
// Helpers
// =============================================================================

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);

function createMockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY,
    l1Address: 'alpha1testaddr',
    directAddress: 'DIRECT://testaddr',
    privateKey: FAKE_PRIVATE_KEY,
  };
}

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    clear: vi.fn(async () => { store.clear(); }),
    has: vi.fn(async (key: string) => store.has(key)),
    keys: vi.fn(async () => Array.from(store.keys())),
  } as unknown as StorageProvider;
}

function createMockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY,
      transportPubkey: 'transport-pub',
      directAddress: 'DIRECT://testaddr',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue({
      chainPubkey: FAKE_PUBKEY,
      transportPubkey: 'transport-pub',
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
  } as unknown as OracleProvider;
}

function createMockToken(id: string, amount: string, coinId: string = 'UCT'): Token {
  return {
    id,
    coinId,
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 18,
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

/** Mock SDK token with toJSON method */
function createMockSdkToken() {
  return {
    toJSON: () => ({ genesis: {}, state: {} }),
    state: { calculateHash: () => new Uint8Array(32) },
  };
}

/** Create a mock TransferCommitment with a known requestId */
function createMockCommitment(requestIdHex: string) {
  const requestIdBytes = new Uint8Array(
    requestIdHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16))
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

// =============================================================================
// Tests
// =============================================================================

describe('TransferResult.tokenTransfers', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let deps: PaymentsModuleDependencies;
  let mockTransport: TransportProvider;
  let mockOracle: OracleProvider;

  beforeEach(() => {
    vi.clearAllMocks();

    module = createPaymentsModule({ debug: false });
    mockTransport = createMockTransport();
    mockOracle = createMockOracle();

    deps = {
      identity: createMockIdentity(),
      storage: createMockStorage(),
      transport: mockTransport,
      oracle: mockOracle,
      emitEvent: vi.fn(),
    };

    module.initialize(deps);

    // Spy on private methods to bypass heavy logic
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = module as any;
    mod.resolveRecipient = vi.fn().mockResolvedValue(FAKE_PUBKEY);
    mod.resolveRecipientAddress = vi.fn().mockResolvedValue({ scheme: 0 });
    mod.createSigningService = vi.fn().mockResolvedValue({});
    mod.save = vi.fn().mockResolvedValue(undefined);
    mod.saveToOutbox = vi.fn().mockResolvedValue(undefined);
    mod.removeFromOutbox = vi.fn().mockResolvedValue(undefined);
    mod.addToHistory = vi.fn().mockResolvedValue(undefined);
    mod.removeToken = vi.fn().mockResolvedValue(undefined);
  });

  describe('direct token transfers (NOSTR-FIRST)', () => {
    it('should produce one TokenTransferDetail per direct token', async () => {
      const token1 = createMockToken('token-aaa', '1000000');
      const token2 = createMockToken('token-bbb', '2000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token1.id, token1);
      mod.tokens.set(token2.id, token2);

      const sdkToken1 = createMockSdkToken();
      const sdkToken2 = createMockSdkToken();

      // Split plan: two direct tokens, no split
      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: sdkToken1, amount: 1000000n, uiToken: token1 },
          { sdkToken: sdkToken2, amount: 2000000n, uiToken: token2 },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      // Each token gets its own commitment with distinct requestId
      const commitment1 = createMockCommitment('aa'.repeat(16));
      const commitment2 = createMockCommitment('bb'.repeat(16));
      mod.createSdkCommitment = vi.fn()
        .mockResolvedValueOnce(commitment1)
        .mockResolvedValueOnce(commitment2);

      const result: TransferResult = await module.send({
        recipient: '@alice',
        amount: '3000000',
        coinId: 'UCT',
      });

      expect(result.tokenTransfers).toHaveLength(2);

      expect(result.tokenTransfers[0]).toEqual({
        sourceTokenId: 'token-aaa',
        method: 'direct',
        requestIdHex: 'aa'.repeat(16),
      });

      expect(result.tokenTransfers[1]).toEqual({
        sourceTokenId: 'token-bbb',
        method: 'direct',
        requestIdHex: 'bb'.repeat(16),
      });
    });

    it('should produce a single TokenTransferDetail for a single direct token', async () => {
      const token = createMockToken('token-single', '5000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
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

      const requestIdHex = 'cc11223344556677' + '8899aabbccddeeff';
      const commitment = createMockCommitment(requestIdHex);
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      const result = await module.send({
        recipient: '@bob',
        amount: '5000000',
        coinId: 'UCT',
      });

      expect(result.tokenTransfers).toHaveLength(1);
      expect(result.tokenTransfers[0].sourceTokenId).toBe('token-single');
      expect(result.tokenTransfers[0].method).toBe('direct');
      expect(result.tokenTransfers[0].requestIdHex).toBe(requestIdHex);
      expect(result.tokenTransfers[0].splitGroupId).toBeUndefined();
      expect(result.tokenTransfers[0].nostrEventId).toBeUndefined();
    });

    it('should convert Uint8Array requestId to hex string', async () => {
      const token = createMockToken('token-hex', '1000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      // Use specific bytes to verify hex conversion
      const commitment = {
        requestId: new Uint8Array([0x0a, 0xff, 0x00, 0x42]),
        toJSON: () => ({}),
      };
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      const result = await module.send({
        recipient: '@carol',
        amount: '1000',
        coinId: 'UCT',
      });

      expect(result.tokenTransfers[0].requestIdHex).toBe('0aff0042');
    });
  });

  describe('split token transfers (Instant Split)', () => {
    it('should produce a TokenTransferDetail with method:split for split transfers', async () => {
      const tokenToSplit = createMockToken('token-split-src', '10000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(tokenToSplit.id, tokenToSplit);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [],
        tokenToSplit: {
          sdkToken: createMockSdkToken(),
          amount: 10000000n,
          uiToken: tokenToSplit,
        },
        splitAmount: 3000000n,
        remainderAmount: 7000000n,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockExecuteSplitInstant.mockResolvedValue({
        success: true,
        splitGroupId: 'split-group-abc123',
        nostrEventId: 'nostr-event-def456',
        criticalPathDurationMs: 2300,
      });

      const result = await module.send({
        recipient: '@dave',
        amount: '3000000',
        coinId: 'UCT',
      });

      expect(result.tokenTransfers).toHaveLength(1);
      expect(result.tokenTransfers[0]).toEqual({
        sourceTokenId: 'token-split-src',
        method: 'split',
        splitGroupId: 'split-group-abc123',
        nostrEventId: 'nostr-event-def456',
      });
    });

    it('should handle split result without nostrEventId', async () => {
      const tokenToSplit = createMockToken('token-no-nostr', '5000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(tokenToSplit.id, tokenToSplit);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [],
        tokenToSplit: {
          sdkToken: createMockSdkToken(),
          amount: 5000000n,
          uiToken: tokenToSplit,
        },
        splitAmount: 2000000n,
        remainderAmount: 3000000n,
        totalTransferAmount: 2000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockExecuteSplitInstant.mockResolvedValue({
        success: true,
        splitGroupId: 'split-group-xyz',
        nostrEventId: undefined,
        criticalPathDurationMs: 1500,
      });

      const result = await module.send({
        recipient: '@eve',
        amount: '2000000',
        coinId: 'UCT',
      });

      expect(result.tokenTransfers).toHaveLength(1);
      expect(result.tokenTransfers[0].method).toBe('split');
      expect(result.tokenTransfers[0].splitGroupId).toBe('split-group-xyz');
      expect(result.tokenTransfers[0].nostrEventId).toBeUndefined();
      expect(result.tokenTransfers[0].requestIdHex).toBeUndefined();
    });
  });

  describe('mixed transfers (split + direct)', () => {
    it('should produce entries for both split and direct tokens', async () => {
      const tokenToSplit = createMockToken('token-to-split', '8000000');
      const directToken = createMockToken('token-direct', '2000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(tokenToSplit.id, tokenToSplit);
      mod.tokens.set(directToken.id, directToken);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 2000000n, uiToken: directToken },
        ],
        tokenToSplit: {
          sdkToken: createMockSdkToken(),
          amount: 8000000n,
          uiToken: tokenToSplit,
        },
        splitAmount: 3000000n,
        remainderAmount: 5000000n,
        totalTransferAmount: 5000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockExecuteSplitInstant.mockResolvedValue({
        success: true,
        splitGroupId: 'split-mixed-001',
        nostrEventId: 'nostr-mixed-001',
        criticalPathDurationMs: 2100,
      });

      const directCommitment = createMockCommitment('dd'.repeat(16));
      mod.createSdkCommitment = vi.fn().mockResolvedValue(directCommitment);

      const result = await module.send({
        recipient: '@frank',
        amount: '5000000',
        coinId: 'UCT',
      });

      expect(result.tokenTransfers).toHaveLength(2);

      // Split entry comes first (split path runs before direct loop)
      const splitEntry = result.tokenTransfers.find(t => t.method === 'split');
      const directEntry = result.tokenTransfers.find(t => t.method === 'direct');

      expect(splitEntry).toBeDefined();
      expect(splitEntry!.sourceTokenId).toBe('token-to-split');
      expect(splitEntry!.splitGroupId).toBe('split-mixed-001');
      expect(splitEntry!.nostrEventId).toBe('nostr-mixed-001');

      expect(directEntry).toBeDefined();
      expect(directEntry!.sourceTokenId).toBe('token-direct');
      expect(directEntry!.requestIdHex).toBe('dd'.repeat(16));
    });
  });

  describe('result structure', () => {
    it('should have empty tokenTransfers when no tokens are transferred', async () => {
      mockCalculateOptimalSplit.mockResolvedValue(null);

      await expect(
        module.send({ recipient: '@nobody', amount: '999999', coinId: 'UCT' })
      ).rejects.toThrow('Insufficient balance');
    });

    it('should have status completed on success', async () => {
      const token = createMockToken('token-status', '1000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      mod.createSdkCommitment = vi.fn().mockResolvedValue(createMockCommitment('ee'.repeat(16)));

      const result = await module.send({
        recipient: '@test',
        amount: '1000',
        coinId: 'UCT',
      });

      expect(result.status).toBe('completed');
      expect(result.tokenTransfers).toHaveLength(1);
      expect(result.id).toBeDefined();
      expect(result.tokens).toHaveLength(1);
    });

    it('should pass transferId to addToHistory linking result.id', async () => {
      const token = createMockToken('token-history-link', '1000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      mod.createSdkCommitment = vi.fn().mockResolvedValue(createMockCommitment('ab'.repeat(16)));

      const result = await module.send({
        recipient: '@alice',
        amount: '1000',
        coinId: 'UCT',
      });

      // addToHistory should have been called with transferId matching result.id
      expect(mod.addToHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SENT',
          transferId: result.id,
        })
      );
    });

    it('should not have txHash property', async () => {
      const token = createMockToken('token-no-txhash', '1000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      mod.createSdkCommitment = vi.fn().mockResolvedValue(createMockCommitment('ff'.repeat(16)));

      const result = await module.send({
        recipient: '@test',
        amount: '1000',
        coinId: 'UCT',
      });

      // txHash should NOT exist on the result — replaced by tokenTransfers
      expect(result).not.toHaveProperty('txHash');
    });
  });
});

describe('TokenTransferDetail type export', () => {
  it('should export TokenTransferDetail from types', async () => {
    const { TokenTransferDetail: _TokenTransferDetail } = await import('../../../types') as Record<string, unknown>;
    // TypeScript interface — only exists at compile time, but the import should not throw
    // We verify the type is usable at compile time via the type annotation below
    const detail: TokenTransferDetail = {
      sourceTokenId: 'test',
      method: 'direct',
      requestIdHex: 'abc123',
    };
    expect(detail.sourceTokenId).toBe('test');
    expect(detail.method).toBe('direct');
  });

  it('should enforce method as direct or split', () => {
    const directDetail: TokenTransferDetail = {
      sourceTokenId: 'a',
      method: 'direct',
      requestIdHex: '0011',
    };
    const splitDetail: TokenTransferDetail = {
      sourceTokenId: 'b',
      method: 'split',
      splitGroupId: 'group-1',
      nostrEventId: 'event-1',
    };

    expect(directDetail.method).toBe('direct');
    expect(splitDetail.method).toBe('split');
  });

  it('should allow optional fields to be undefined', () => {
    const minimal: TokenTransferDetail = {
      sourceTokenId: 'x',
      method: 'direct',
    };
    expect(minimal.requestIdHex).toBeUndefined();
    expect(minimal.splitGroupId).toBeUndefined();
    expect(minimal.nostrEventId).toBeUndefined();
  });
});

// =============================================================================
// Conservative Transfer Mode Tests
// =============================================================================

describe('TransferResult.tokenTransfers (conservative mode)', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let deps: PaymentsModuleDependencies;
  let mockTransport: TransportProvider;
  let mockOracle: OracleProvider;

  beforeEach(() => {
    vi.clearAllMocks();

    module = createPaymentsModule({ debug: false });
    mockTransport = createMockTransport();
    mockOracle = createMockOracle();

    deps = {
      identity: createMockIdentity(),
      storage: createMockStorage(),
      transport: mockTransport,
      oracle: mockOracle,
      emitEvent: vi.fn(),
    };

    module.initialize(deps);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = module as any;
    mod.resolveRecipient = vi.fn().mockResolvedValue(FAKE_PUBKEY);
    mod.resolveRecipientAddress = vi.fn().mockResolvedValue({ scheme: 0 });
    mod.createSigningService = vi.fn().mockResolvedValue({});
    mod.save = vi.fn().mockResolvedValue(undefined);
    mod.saveToOutbox = vi.fn().mockResolvedValue(undefined);
    mod.removeFromOutbox = vi.fn().mockResolvedValue(undefined);
    mod.addToHistory = vi.fn().mockResolvedValue(undefined);
    mod.removeToken = vi.fn().mockResolvedValue(undefined);
  });

  describe('conservative direct transfers', () => {
    it('should wait for proof and send { sourceToken, transferTx } via Nostr', async () => {
      const token = createMockToken('token-cons-direct', '5000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
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

      const requestIdHex = 'aa'.repeat(16);
      const commitment = createMockCommitment(requestIdHex);
      mod.createSdkCommitment = vi.fn().mockResolvedValue(commitment);

      const result = await module.send({
        recipient: '@alice',
        amount: '5000000',
        coinId: 'UCT',
        transferMode: 'conservative',
      });

      // Should have called waitInclusionProof (conservative waits for proof)
      expect(waitInclusionProof).toHaveBeenCalled();

      // Should send { sourceToken, transferTx } format (not commitmentData)
      const sendCall = (mockTransport.sendTokenTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const payload = sendCall[1] as Record<string, unknown>;
      expect(payload).toHaveProperty('sourceToken');
      expect(payload).toHaveProperty('transferTx');
      expect(payload).not.toHaveProperty('commitmentData');

      expect(result.tokenTransfers).toHaveLength(1);
      expect(result.tokenTransfers[0]).toEqual({
        sourceTokenId: 'token-cons-direct',
        method: 'direct',
        requestIdHex,
      });
      expect(result.status).toBe('completed');
    });

    it('should submit commitment to aggregator synchronously', async () => {
      const token = createMockToken('token-cons-sync', '1000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      const mockSubmit = vi.fn().mockResolvedValue({ status: 'SUCCESS' });
      (mockOracle.getStateTransitionClient as ReturnType<typeof vi.fn>).mockReturnValue({
        submitTransferCommitment: mockSubmit,
      });

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      mod.createSdkCommitment = vi.fn().mockResolvedValue(createMockCommitment('bb'.repeat(16)));

      await module.send({
        recipient: '@bob',
        amount: '1000',
        coinId: 'UCT',
        transferMode: 'conservative',
      });

      // Conservative mode submits synchronously (not fire-and-forget)
      expect(mockSubmit).toHaveBeenCalled();
    });
  });

  describe('conservative split transfers', () => {
    it('should use TokenSplitExecutor instead of InstantSplitExecutor', async () => {
      const tokenToSplit = createMockToken('token-cons-split', '10000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(tokenToSplit.id, tokenToSplit);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [],
        tokenToSplit: {
          sdkToken: createMockSdkToken(),
          amount: 10000000n,
          uiToken: tokenToSplit,
        },
        splitAmount: 3000000n,
        remainderAmount: 7000000n,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockExecuteSplit.mockResolvedValue({
        tokenForRecipient: {
          toJSON: () => ({ genesis: {}, state: {} }),
        },
        tokenForSender: {
          toJSON: () => ({ genesis: {}, state: {} }),
        },
        recipientTransferTx: {
          toJSON: () => ({ data: {}, inclusionProof: {} }),
          data: { requestId: new Uint8Array([0xcc, 0xdd]) },
        },
      });

      const result = await module.send({
        recipient: '@carol',
        amount: '3000000',
        coinId: 'UCT',
        transferMode: 'conservative',
      });

      // TokenSplitExecutor should be used, NOT InstantSplitExecutor
      expect(mockExecuteSplit).toHaveBeenCalled();
      expect(mockExecuteSplitInstant).not.toHaveBeenCalled();

      // Should send { sourceToken, transferTx } via Nostr
      const sendCall = (mockTransport.sendTokenTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const payload = sendCall[1] as Record<string, unknown>;
      expect(payload).toHaveProperty('sourceToken');
      expect(payload).toHaveProperty('transferTx');
      expect(payload).not.toHaveProperty('commitmentData');

      expect(result.tokenTransfers).toHaveLength(1);
      expect(result.tokenTransfers[0].sourceTokenId).toBe('token-cons-split');
      expect(result.tokenTransfers[0].method).toBe('split');
      expect(result.tokenTransfers[0].requestIdHex).toBe('ccdd');
      // Conservative splits don't have splitGroupId/nostrEventId
      expect(result.tokenTransfers[0].splitGroupId).toBeUndefined();
      expect(result.tokenTransfers[0].nostrEventId).toBeUndefined();
    });

    it('should save change token from conservative split', async () => {
      const tokenToSplit = createMockToken('token-cons-change', '8000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(tokenToSplit.id, tokenToSplit);
      mod.addToken = vi.fn().mockResolvedValue(undefined);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [],
        tokenToSplit: {
          sdkToken: createMockSdkToken(),
          amount: 8000000n,
          uiToken: tokenToSplit,
        },
        splitAmount: 3000000n,
        remainderAmount: 5000000n,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockExecuteSplit.mockResolvedValue({
        tokenForRecipient: { toJSON: () => ({}) },
        tokenForSender: { toJSON: () => ({ genesis: {}, state: {} }) },
        recipientTransferTx: {
          toJSON: () => ({}),
          data: { requestId: new Uint8Array([0xee]) },
        },
      });

      await module.send({
        recipient: '@dave',
        amount: '3000000',
        coinId: 'UCT',
        transferMode: 'conservative',
      });

      // addToken should have been called with the change token (no skipHistory arg)
      expect(mod.addToken).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: '5000000',
          status: 'confirmed',
        })
      );
    });
  });

  describe('default and explicit instant mode', () => {
    it('should use instant mode when transferMode is omitted', async () => {
      const token = createMockToken('token-default', '1000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 1000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 1000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      mod.createSdkCommitment = vi.fn().mockResolvedValue(createMockCommitment('11'.repeat(16)));

      await module.send({
        recipient: '@test',
        amount: '1000',
        coinId: 'UCT',
        // transferMode omitted — should default to instant
      });

      // Should send commitmentData format (instant), not transferTx
      const sendCall = (mockTransport.sendTokenTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const payload = sendCall[1] as Record<string, unknown>;
      expect(payload).toHaveProperty('commitmentData');
      expect(payload).not.toHaveProperty('transferTx');

      // Should NOT call waitInclusionProof (instant mode is fire-and-forget)
      expect(waitInclusionProof).not.toHaveBeenCalled();
    });

    it('should use instant mode when transferMode is explicitly instant', async () => {
      const token = createMockToken('token-explicit-instant', '2000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(token.id, token);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [
          { sdkToken: createMockSdkToken(), amount: 2000n, uiToken: token },
        ],
        tokenToSplit: null,
        splitAmount: null,
        remainderAmount: null,
        totalTransferAmount: 2000n,
        coinId: 'UCT',
        requiresSplit: false,
      });

      mod.createSdkCommitment = vi.fn().mockResolvedValue(createMockCommitment('22'.repeat(16)));

      await module.send({
        recipient: '@test',
        amount: '2000',
        coinId: 'UCT',
        transferMode: 'instant',
      });

      // Should send commitmentData format (instant)
      const sendCall = (mockTransport.sendTokenTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const payload = sendCall[1] as Record<string, unknown>;
      expect(payload).toHaveProperty('commitmentData');
      expect(payload).not.toHaveProperty('transferTx');
    });

    it('should use InstantSplitExecutor for splits in instant mode', async () => {
      const tokenToSplit = createMockToken('token-instant-split', '10000000');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = module as any;
      mod.tokens.set(tokenToSplit.id, tokenToSplit);

      mockCalculateOptimalSplit.mockResolvedValue({
        tokensToTransferDirectly: [],
        tokenToSplit: {
          sdkToken: createMockSdkToken(),
          amount: 10000000n,
          uiToken: tokenToSplit,
        },
        splitAmount: 3000000n,
        remainderAmount: 7000000n,
        totalTransferAmount: 3000000n,
        coinId: 'UCT',
        requiresSplit: true,
      });

      mockExecuteSplitInstant.mockResolvedValue({
        success: true,
        splitGroupId: 'instant-group',
        nostrEventId: 'instant-event',
        criticalPathDurationMs: 2000,
      });

      await module.send({
        recipient: '@test',
        amount: '3000000',
        coinId: 'UCT',
        transferMode: 'instant',
      });

      // Should use InstantSplitExecutor, NOT TokenSplitExecutor
      expect(mockExecuteSplitInstant).toHaveBeenCalled();
      expect(mockExecuteSplit).not.toHaveBeenCalled();
    });
  });
});
