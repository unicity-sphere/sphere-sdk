/**
 * Tests for PaymentsModule.exportTokens() / importTokens()
 *
 * Verifies the file-level token import/export helpers — used by the CLI
 * `tokens-export` and `tokens-import` commands and by any consumer
 * that wants offline token transfer without going through Nostr.
 *
 * Coverage:
 *  - Round-trip: export → importTokens on a fresh wallet preserves
 *    every TXF wire-format field.
 *  - Filtering by `ids` and `coinId`.
 *  - Unconfirmed-token gating.
 *  - Idempotence: importing the same token twice yields `skipped`.
 *  - Tombstone rejection: importing a token whose (tokenId, stateHash)
 *    was previously spent yields `skipped`.
 *  - Rejection reporting for malformed inputs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { TxfToken } from '../../../types/txf';

// ---------------------------------------------------------------------------
// Mock SDK imports used by PaymentsModule (identical to the pattern in
// PaymentsModule.tombstone.test.ts — we don't exercise send/receive here)
// ---------------------------------------------------------------------------

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
  TransferTransaction: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class {},
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
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_A_ID = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const TOKEN_B_ID = 'bbbb000000000000000000000000000000000000000000000000000000000002';
const STATE_HASH_1 = '1111000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_2 = '2222000000000000000000000000000000000000000000000000000000000002';

function buildTxf(opts: {
  tokenId: string;
  stateHash: string;
  coinId?: string;
  amount?: string;
}): TxfToken {
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: opts.tokenId,
        tokenType: '00',
        coinData: [[opts.coinId ?? 'UCT_HEX', opts.amount ?? '1000000']],
        tokenData: '',
        salt: '00',
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: 'pubkey',
          signature: 'sig',
          stateHash: opts.stateHash,
        },
        merkleTreePath: { root: '00', steps: [] },
        transactionHash: '00',
        unicityCertificate: '00',
      },
    },
    state: { data: 'statedata', predicate: 'predicate' },
    transactions: [],
  };
}

function buildToken(opts: {
  tokenId: string;
  stateHash: string;
  coinId?: string;
  amount?: string;
  status?: Token['status'];
  id?: string;
}): Token {
  const txf = buildTxf(opts);
  return {
    id: opts.id ?? `local-${opts.tokenId.slice(0, 8)}-${opts.stateHash.slice(0, 8)}`,
    coinId: opts.coinId ?? 'UCT_HEX',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: opts.amount ?? '1000000',
    status: opts.status ?? 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

function createMockDeps(): PaymentsModuleDependencies {
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

  const mockTokenStorage: TokenStorageProvider<TxfStorageDataBase> = {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local', timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
  };

  const tokenStorageProviders = new Map();
  tokenStorageProviders.set('mock', mockTokenStorage);

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
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
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as OracleProvider;

  const mockIdentity: FullIdentity = {
    chainPubkey: '02' + 'aa'.repeat(32),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: '00' + '11'.repeat(31),
  };

  return {
    identity: mockIdentity,
    storage: mockStorage,
    tokenStorageProviders,
    transport: mockTransport,
    oracle: mockOracle,
    emitEvent: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule.exportTokens / importTokens', () => {
  let module: ReturnType<typeof createPaymentsModule>;

  beforeEach(() => {
    vi.clearAllMocks();
    module = createPaymentsModule({ debug: false });
    module.initialize(createMockDeps());
  });

  // -------------------------------------------------------------------------
  // exportTokens
  // -------------------------------------------------------------------------

  describe('exportTokens', () => {
    it('returns empty array when wallet has no tokens', () => {
      expect(module.exportTokens()).toEqual([]);
    });

    it('exports all confirmed tokens by default', async () => {
      await module.addToken(buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 }));
      await module.addToken(buildToken({ tokenId: TOKEN_B_ID, stateHash: STATE_HASH_2 }));

      const exported = module.exportTokens();
      expect(exported).toHaveLength(2);
      const ids = exported.map((e) => e.genesisTokenId).sort();
      expect(ids).toEqual([TOKEN_A_ID, TOKEN_B_ID].sort());
    });

    it('filters by coinId', async () => {
      await module.addToken(
        buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1, coinId: 'UCT_HEX' }),
      );
      await module.addToken(
        buildToken({ tokenId: TOKEN_B_ID, stateHash: STATE_HASH_2, coinId: 'OTHER_HEX' }),
      );

      const uctOnly = module.exportTokens({ coinId: 'UCT_HEX' });
      expect(uctOnly).toHaveLength(1);
      expect(uctOnly[0].genesisTokenId).toBe(TOKEN_A_ID);
    });

    it('filters by local ids', async () => {
      const tokenA = buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1, id: 'uuid-a' });
      const tokenB = buildToken({ tokenId: TOKEN_B_ID, stateHash: STATE_HASH_2, id: 'uuid-b' });
      await module.addToken(tokenA);
      await module.addToken(tokenB);

      const picked = module.exportTokens({ ids: ['uuid-a'] });
      expect(picked).toHaveLength(1);
      expect(picked[0].localId).toBe('uuid-a');
    });

    it('skips unconfirmed tokens unless includeUnconfirmed is set', async () => {
      await module.addToken(
        buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1, status: 'confirmed' }),
      );
      await module.addToken(
        buildToken({ tokenId: TOKEN_B_ID, stateHash: STATE_HASH_2, status: 'submitted' }),
      );

      expect(module.exportTokens()).toHaveLength(1);
      expect(module.exportTokens({ includeUnconfirmed: true })).toHaveLength(2);
    });

    it('preserves every TXF wire-format field', async () => {
      const original = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      const uiToken = buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      await module.addToken(uiToken);

      const exported = module.exportTokens();
      expect(exported).toHaveLength(1);
      const txf = exported[0].txf;

      expect(txf.version).toBe(original.version);
      expect(txf.genesis.data.tokenId).toBe(original.genesis.data.tokenId);
      expect(txf.genesis.data.tokenType).toBe(original.genesis.data.tokenType);
      expect(txf.genesis.data.coinData).toEqual(original.genesis.data.coinData);
      expect(txf.genesis.inclusionProof).toEqual(original.genesis.inclusionProof);
      expect(txf.state.predicate).toBe(original.state.predicate);
    });
  });

  // -------------------------------------------------------------------------
  // importTokens
  // -------------------------------------------------------------------------

  describe('importTokens', () => {
    it('adds all tokens when none are present', async () => {
      const txfs = [
        buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 }),
        buildTxf({ tokenId: TOKEN_B_ID, stateHash: STATE_HASH_2 }),
      ];
      const result = await module.importTokens(txfs);
      expect(result.added).toHaveLength(2);
      expect(result.skipped).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
      // The tokens are now owned
      expect(module.getTokens()).toHaveLength(2);
    });

    it('is idempotent: re-importing the same token is skipped', async () => {
      const txf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      const first = await module.importTokens([txf]);
      expect(first.added).toHaveLength(1);

      const second = await module.importTokens([txf]);
      expect(second.added).toHaveLength(0);
      expect(second.skipped).toHaveLength(1);
      expect(second.skipped[0].genesisTokenId).toBe(TOKEN_A_ID);
    });

    it('rejects a token whose (tokenId, stateHash) was previously spent (tombstoned)', async () => {
      // Add → remove to create a tombstone
      const tokenUi = buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      await module.addToken(tokenUi);
      await module.removeToken(tokenUi.id);

      const txf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      const result = await module.importTokens([txf]);

      expect(result.added).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].genesisTokenId).toBe(TOKEN_A_ID);
    });

    it('reports rejection reason for malformed TxfToken (no tokenId)', async () => {
      const bogus = {
        version: '2.0',
        genesis: { data: {} },
        state: { predicate: 'x' },
        transactions: [],
      } as unknown as TxfToken;

      const result = await module.importTokens([bogus]);
      expect(result.added).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toMatch(/tokenId/);
    });

    it('reports rejection for missing state section', async () => {
      const bogus = {
        version: '2.0',
        genesis: { data: { tokenId: TOKEN_A_ID } },
        // state: undefined,
        transactions: [],
      } as unknown as TxfToken;

      const result = await module.importTokens([bogus]);
      expect(result.added).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
    });

    it('export → import round-trips on a fresh wallet (both token sets identical)', async () => {
      // Populate wallet A
      await module.addToken(buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 }));
      await module.addToken(buildToken({ tokenId: TOKEN_B_ID, stateHash: STATE_HASH_2 }));

      // Export
      const exported = module.exportTokens();
      expect(exported).toHaveLength(2);

      // Create a fresh wallet B and import
      const moduleB = createPaymentsModule({ debug: false });
      moduleB.initialize(createMockDeps());

      const result = await moduleB.importTokens(exported.map((e) => e.txf));
      expect(result.added).toHaveLength(2);
      expect(result.rejected).toHaveLength(0);

      // Wallet B now owns the same tokens (identified by genesis tokenId)
      const ownedB = moduleB
        .exportTokens()
        .map((e) => e.genesisTokenId)
        .sort();
      expect(ownedB).toEqual([TOKEN_A_ID, TOKEN_B_ID].sort());
    });
  });
});
