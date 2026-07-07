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
  stateHash: string;  // "genesis" stateHash; for transacted tokens see `transactions`
  coinId?: string;
  amount?: string;
  /**
   * Optional transactions array. When non-empty, `getCurrentStateHash`
   * returns `lastTx.newStateHash` instead of the genesis's stateHash —
   * which is the correct "current state" identity for dedup.
   */
  transactions?: Array<{
    previousStateHash?: string;
    newStateHash?: string;
    predicate?: string;
  }>;
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
    transactions: (opts.transactions ?? []) as TxfToken['transactions'],
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
      // Granular code: previous-spend, not just an opaque "skipped".
      expect(result.skipped[0].code).toBe('tombstoned');
    });

    it('reports duplicate skip code for an exact (tokenId, stateHash) match', async () => {
      const tokenUi = buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      await module.addToken(tokenUi);

      const dupTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      const result = await module.importTokens([dupTxf]);

      expect(result.added).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].code).toBe('duplicate');
    });

    it('reports genesis-exists skip code in strict mode for a different state', async () => {
      const tokenUi = buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      await module.addToken(tokenUi);

      const sameGenesisTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_2 });
      const result = await module.importTokens([sameGenesisTxf], {
        skipExistingGenesis: true,
      });

      expect(result.added).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].code).toBe('genesis-exists');
    });

    it('lenient mode: same-genesis import marks added entry as state-replaced', async () => {
      const tokenUi = buildToken({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      await module.addToken(tokenUi);

      const newStateTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_2 });
      const result = await module.importTokens([newStateTxf]);

      expect(result.added).toHaveLength(1);
      expect(result.added[0].code).toBe('state-replaced');
      // Discriminated union narrowing — note is required on state-replaced.
      if (result.added[0].code === 'state-replaced') {
        expect(result.added[0].note).toMatch(/Replaced/);
      }
    });

    it('transacted tokens dedup on CURRENT state (lastTx.newStateHash), not genesis', async () => {
      // Regression for steelman finding: `effectiveDedupKey` must
      // use `getCurrentStateHash` (which prefers lastTx.newStateHash)
      // rather than reading only the genesis hash. Without this fix,
      // two different live states of the same token — same genesis,
      // different lastTx — collide as "duplicate" and valid state
      // updates get silently dropped on re-import.
      const stateAfterTx1 = 'ee' + '11'.repeat(31);
      const stateAfterTx2 = 'ff' + '22'.repeat(31);

      // Wallet owns TOKEN_A at state-after-tx1.
      const tokenAtState1 = buildToken({
        tokenId: TOKEN_A_ID,
        stateHash: STATE_HASH_1,  // genesis hash (never changes)
      });
      // Manually stamp the current-state marker into sdkData so
      // getCurrentStateHash returns stateAfterTx1 (not the genesis).
      tokenAtState1.sdkData = JSON.stringify(
        buildTxf({
          tokenId: TOKEN_A_ID,
          stateHash: STATE_HASH_1,
          transactions: [
            {
              previousStateHash: STATE_HASH_1,
              newStateHash: stateAfterTx1,
              predicate: 'tx1-predicate',
            },
          ],
        }),
      );
      await module.addToken(tokenAtState1);

      // Now import the SAME token at a DIFFERENT later state.
      const importAtState2 = buildTxf({
        tokenId: TOKEN_A_ID,
        stateHash: STATE_HASH_1,  // same genesis
        transactions: [
          { previousStateHash: STATE_HASH_1, newStateHash: stateAfterTx1, predicate: 'tx1' },
          { previousStateHash: stateAfterTx1, newStateHash: stateAfterTx2, predicate: 'tx2' },
        ],
      });

      // In lenient mode, it must be recognised as a different state —
      // NOT as a duplicate of the current record.
      const result = await module.importTokens([importAtState2]);
      expect(result.skipped).toHaveLength(0);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].code).toBe('state-replaced');
    });

    it('pending-mint tokens deduplicate correctly via genesis fallback key', async () => {
      // Regression for steelman finding: a token without a finalized
      // stateHash (pending mint, mid-aggregator) used to fall through
      // the exact-duplicate check because `incomingStateHash && ...`
      // short-circuited on ''. Two imports of the same pending mint
      // then churned through addToken's CASE 3 (archive + replace by
      // local UUID), producing misleading 'state-replaced' entries.
      //
      // Fix: `effectiveDedupKey` falls back to a content-hash of the
      // genesis data when stateHash is empty. Two imports of the same
      // pending genesis now collide as 'duplicate'.
      const pendingTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: '' });

      const first = await module.importTokens([pendingTxf]);
      expect(first.added).toHaveLength(1);
      expect(first.added[0].code).toBe('added');

      const second = await module.importTokens([pendingTxf]);
      expect(second.added).toHaveLength(0);
      expect(second.skipped).toHaveLength(1);
      expect(second.skipped[0].code).toBe('duplicate');
    });

    it('strict mode allows pending→finalized upgrade (pending existing, finalized incoming)', async () => {
      // Regression for steelman LOW finding: strict mode was refusing
      // genuine upgrades. If the wallet has a pending-mint record and
      // we import the SAME token now that it is finalized, the
      // finalized state carries strictly more information and should
      // replace the pending record — even in strict mode. Without
      // this exception, users would be stuck with pending records
      // they can't spend and can't resolve via re-migration.
      const pendingTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: '' });
      await module.importTokens([pendingTxf]);

      const finalizedTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      const result = await module.importTokens([finalizedTxf], {
        skipExistingGenesis: true,
      });
      expect(result.skipped).toHaveLength(0);
      expect(result.added).toHaveLength(1);
      expect(result.added[0].code).toBe('state-replaced');
    });

    it('strict mode still refuses finalized→pending downgrades and finalized↔finalized conflicts', async () => {
      // Negative of the previous test: the strict upgrade is one-way.
      // A finalized existing + pending incoming is NOT an upgrade —
      // strict mode correctly refuses to regress.
      const finalizedTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      await module.importTokens([finalizedTxf]);

      const pendingTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: '' });
      const result = await module.importTokens([pendingTxf], {
        skipExistingGenesis: true,
      });
      expect(result.added).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].code).toBe('genesis-exists');
    });

    it('pending + finalized with the same genesis are NOT duplicates (different states)', async () => {
      // Sanity: the fallback key must never collide with a real
      // stateHash. A pending-mint and its finalized counterpart live
      // at different dedup keys — second one goes through the
      // genesis-match branch (state-replaced in lenient mode).
      const pendingTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: '' });
      await module.importTokens([pendingTxf]);

      const finalizedTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_1 });
      const result = await module.importTokens([finalizedTxf]);
      expect(result.skipped).toHaveLength(0);
      // Added, but flagged as state-replaced (prior pending record exists)
      expect(result.added).toHaveLength(1);
      expect(result.added[0].code).toBe('state-replaced');
    });

    it('lenient mode: replacing a SPENT token record is labelled stale-record-replaced, not state-replaced', async () => {
      // Regression for steelman finding: addToken's CASE 1 fires on a
      // spent/invalid pre-existing entry and returns true via the same
      // code path. We must distinguish this from replacing a live state.
      const tokenUi = buildToken({
        tokenId: TOKEN_A_ID,
        stateHash: STATE_HASH_1,
        status: 'spent',
      });
      await module.addToken(tokenUi);

      const freshTxf = buildTxf({ tokenId: TOKEN_A_ID, stateHash: STATE_HASH_2 });
      const result = await module.importTokens([freshTxf]);

      expect(result.added).toHaveLength(1);
      expect(result.added[0].code).toBe('stale-record-replaced');
      if (result.added[0].code === 'stale-record-replaced') {
        expect(result.added[0].note).toMatch(/stale spent\/invalid/);
      }
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
