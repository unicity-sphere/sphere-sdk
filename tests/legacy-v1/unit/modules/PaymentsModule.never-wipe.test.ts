/**
 * NEVER-WIPE invariant tests (2026-05-16).
 *
 * `PaymentsModule.load()` re-reads tokens from TokenStorageProviders
 * and rebuilds the in-memory `this.tokens` map. Pre-fix, the rebuild
 * was destructive: a wholesale `this.tokens.clear()` followed by
 * "load entries from parsed storage data" silently dropped every
 * in-memory token whose flush hadn't durably completed. This is the
 * failure mode that lost 4 of 7 faucet drops on profile-multi-device-
 * sync when transient AGGREGATOR_POINTER_WALKBACK_FLOOR errors held
 * the publish gate closed — every received token landed in memory via
 * addToken but never reached storage, and a follow-up `receive()` →
 * `load()` wiped them.
 *
 * The invariant under test: `load()` MUST NOT drop any in-memory
 * token. Storage data wins for tokens whose (tokenId, stateHash)
 * identity is already present in storage. Every other in-memory
 * token is restored after the storage load completes. Tombstoned
 * (tokenId, stateHash) pairs are dropped — consistent with the
 * storage-side filter.
 *
 * Coverage:
 *   - Token added in-memory but NOT in storage → restored after load
 *   - Token in BOTH memory and storage with same state → storage wins
 *   - Token tombstoned in storage → dropped from memory snapshot
 *   - 'transferring' status preserved (existing guard, regression-tested)
 *   - Empty storage → all in-memory tokens preserved (extreme case)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// SDK mocks (mirrors PaymentsModule.tombstone.test.ts setup)
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
      getSymbol: () => 'UCT',
      getName: () => 'Unicity Token',
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Fixtures
// =============================================================================

const TOKEN_ID_A = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ID_B = 'bbbb000000000000000000000000000000000000000000000000000000000002';
const TOKEN_ID_C = 'cccc000000000000000000000000000000000000000000000000000000000003';
const STATE_HASH_1 = '1111000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_2 = '2222000000000000000000000000000000000000000000000000000000000002';

function createMockToken(opts: {
  tokenId: string;
  stateHash: string;
  id?: string;
  status?: Token['status'];
}): Token {
  return {
    id: opts.id ?? `local-${opts.tokenId.slice(0, 8)}-${opts.stateHash.slice(0, 8)}`,
    coinId: 'UCT_HEX',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: '1000000',
    status: opts.status ?? 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify({
      version: '2.0',
      genesis: {
        data: {
          tokenId: opts.tokenId,
          tokenType: '00',
          coinData: [['UCT_HEX', '1000000']],
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
    load: vi.fn().mockResolvedValue({ success: false, source: 'local' as const, timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
  };
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('mock', mockTokenStorage);
  const mockTransport = {
    id: 'mock-transport', name: 'Mock Transport', type: 'p2p' as const,
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
    id: 'mock-oracle', name: 'Mock Oracle', type: 'network' as const,
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
    getTokenState: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;
  const mockIdentity: FullIdentity = {
    chainPubkey: 'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd11',
    directAddress: 'DIRECT://test',
    privateKey: '0011223344556677889900aabbccddeeff0011223344556677889900aabbccddee',
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

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule.load() — NEVER-WIPE invariant', () => {
  let deps: PaymentsModuleDependencies;
  let module: ReturnType<typeof createPaymentsModule>;

  beforeEach(async () => {
    deps = createMockDeps();
    module = createPaymentsModule({ debug: false });
    await module.initialize(deps);
    // Bypass the predicate-match check that would otherwise archive
    // every storage-loaded token (the mock tokens carry placeholder
    // predicates that don't match the wallet identity). We're testing
    // NEVER-WIPE semantics around the memory↔storage merge, not the
    // balance-model invariant — those are orthogonal.
    vi.spyOn(
      module as unknown as { latestStatePredicateMatchesWallet: () => boolean },
      'latestStatePredicateMatchesWallet',
    ).mockReturnValue(true);
  });

  it('restores in-memory tokens that storage does not contain after load()', async () => {
    // Add three tokens to memory (each addToken triggers save() but the
    // mocked provider just resolves — nothing is actually persisted).
    const tokenA = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
    const tokenB = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_1 });
    const tokenC = createMockToken({ tokenId: TOKEN_ID_C, stateHash: STATE_HASH_1 });
    await module.addToken(tokenA);
    await module.addToken(tokenB);
    await module.addToken(tokenC);
    expect(module.getTokens().length).toBe(3);

    // Simulate a stale load: storage returns success with EMPTY token set
    // and the wallet's metadata. Pre-fix, this would wipe all 3 tokens.
    const staleSnapshot: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: 'alpha1testaddress',
        formatVersion: '1.0',
        updatedAt: Date.now() - 60_000,
      },
    };
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: staleSnapshot,
      timestamp: Date.now(),
    });

    await module.load();

    // NEVER-WIPE: all three tokens must survive.
    const survivors = module.getTokens();
    const survivorIds = new Set(survivors.map((t) => t.id));
    expect(survivorIds.has(tokenA.id)).toBe(true);
    expect(survivorIds.has(tokenB.id)).toBe(true);
    expect(survivorIds.has(tokenC.id)).toBe(true);
    expect(survivors.length).toBe(3);
  });

  it('does NOT restore tokens whose (tokenId, stateHash) is in the tombstone set', async () => {
    const tokenA = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
    const tokenB = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_1 });
    await module.addToken(tokenA);
    await module.addToken(tokenB);

    // Tombstone A locally (via remove). B stays active.
    await module.removeToken(tokenA.id);
    expect(module.getTokens().length).toBe(1);

    // Storage returns an empty snapshot — but A is tombstoned locally so
    // the NEVER-WIPE restore must NOT bring A back. B stays restored.
    const staleSnapshot: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: 'alpha1testaddress',
        formatVersion: '1.0',
        updatedAt: Date.now() - 60_000,
      },
      _tombstones: [],
    };
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: staleSnapshot,
      timestamp: Date.now(),
    });

    await module.load();

    const survivors = module.getTokens();
    const survivorIds = new Set(survivors.map((t) => t.id));
    expect(survivorIds.has(tokenA.id)).toBe(false); // tombstoned — dropped
    expect(survivorIds.has(tokenB.id)).toBe(true); // restored
    expect(survivors.length).toBe(1);
  });

  it('storage version wins when same (tokenId, stateHash) exists in both', async () => {
    // Memory and storage both have tokenA with same state. Storage's
    // record wins (it's the canonical loaded version).
    const tokenAInMemory = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_1,
      id: 'memory-id-for-A',
    });
    await module.addToken(tokenAInMemory);

    // Storage entry: TxfToken under `token-<id>` key. The parser
    // reads `genesis.data.tokenId` etc. directly from the value, so
    // we splat the same SDK-data shape that addToken produced.
    const storageId = 'storage-id-for-A';
    const txfToken = JSON.parse(tokenAInMemory.sdkData);
    const snapshot: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: 'alpha1testaddress',
        formatVersion: '1.0',
        updatedAt: Date.now(),
      },
      [`_${storageId}`]: txfToken,
    } as unknown as TxfStorageDataBase;
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: snapshot,
      timestamp: Date.now(),
    });

    await module.load();

    // Storage's id (derived from `token-${id}` key) is in `this.tokens`.
    // The in-memory id is NOT — same (tokenId, stateHash) so the storage
    // entry wins per the NEVER-WIPE policy ("storage canonical for matching state").
    const survivors = module.getTokens();
    const survivorIds = new Set(survivors.map((t) => t.id));
    expect(survivorIds.has(storageId)).toBe(true);
    expect(survivorIds.has(tokenAInMemory.id)).toBe(false);
    expect(survivors.length).toBe(1);
  });

  it('preserves transferring status (regression check on the pre-existing guard)', async () => {
    // In-flight 'transferring' tokens must survive load() regardless
    // of whether storage has the same id. The NEVER-WIPE restore path
    // handles this; the pre-existing transferring guard inside the
    // load loop ALSO contributes by skipping storage overwrites.
    const transferring = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_1,
      status: 'transferring',
    });
    await module.addToken(transferring);

    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: {
        _meta: {
          version: 1,
          address: 'alpha1testaddress',
          formatVersion: '1.0',
          updatedAt: Date.now(),
        },
      },
      timestamp: Date.now(),
    });

    await module.load();

    const survivors = module.getTokens();
    expect(survivors.length).toBe(1);
    expect(survivors[0]!.id).toBe(transferring.id);
    expect(survivors[0]!.status).toBe('transferring');
  });

  it('preserves a token whose stateHash differs from a storage entry for the same tokenId', async () => {
    // In-memory has tokenA at STATE_HASH_2 (NEWER state); storage has
    // tokenA at STATE_HASH_1 (OLDER state). Both must survive — the
    // downstream manifest/fork-detection layer decides which is
    // canonical. Dropping either side at load time would lose state.
    const memoryNewer = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_2,
      id: 'memory-newer',
    });
    await module.addToken(memoryNewer);

    const storageOlder = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_1,
      id: 'storage-older',
    });
    const txfOlder = JSON.parse(storageOlder.sdkData);
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: {
        _meta: {
          version: 1,
          address: 'alpha1testaddress',
          formatVersion: '1.0',
          updatedAt: Date.now(),
        },
        [`_${storageOlder.id}`]: txfOlder,
      } as unknown as TxfStorageDataBase,
      timestamp: Date.now(),
    });

    await module.load();

    const survivorIds = new Set(module.getTokens().map((t) => t.id));
    expect(survivorIds.has(memoryNewer.id)).toBe(true);
    expect(survivorIds.has(storageOlder.id)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // OUTBOX-SEND-FOLLOWUPS Item #14 Phase 2 work item 5 — JOIN-divergent
  // loser detection. When a preserved-from-memory 'transferring' token
  // shares a genesisTokenId with a winner-state storage token (different
  // stateHash), the L3 aggregator has already arbitrated against the
  // local in-flight send. The loser is dropped (not restored) and the
  // `transfer:double-spend-detected` event is emitted.
  // ---------------------------------------------------------------------------

  it('drops a `transferring` snapshot when storage has a divergent state for the same tokenId (JOIN-divergent loser)', async () => {
    // In-memory has tokenA at STATE_HASH_2 at status='transferring'
    // (the local in-flight send the loser device attempted). Storage
    // returns tokenA at STATE_HASH_1 (the winning chain). The loser
    // must be dropped from the active pool.
    const loserInFlight = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_2,
      id: 'loser-in-flight',
      status: 'transferring',
    });
    await module.addToken(loserInFlight);

    const winnerOnChain = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_1,
      id: 'winner-on-chain',
    });
    const txfWinner = JSON.parse(winnerOnChain.sdkData);
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: {
        _meta: {
          version: 1,
          address: 'alpha1testaddress',
          formatVersion: '1.0',
          updatedAt: Date.now(),
        },
        [`_${winnerOnChain.id}`]: txfWinner,
      } as unknown as TxfStorageDataBase,
      timestamp: Date.now(),
    });

    const emitEvent = deps.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();

    await module.load();

    // Loser dropped, winner survives.
    const survivors = module.getTokens();
    const survivorIds = new Set(survivors.map((t) => t.id));
    expect(survivorIds.has(loserInFlight.id)).toBe(false); // dropped
    expect(survivorIds.has(winnerOnChain.id)).toBe(true);

    // Steelman H1 (PR #182 review): the dropped loser must leave a
    // durable tombstone so (a) a process restart preserves the
    // audit trail, and (b) a stale remote storage source cannot
    // re-sync the dead state back into the active pool on a
    // future load.
    const tombstones = module.getTombstones();
    const loserTombstone = tombstones.find(
      (t) => t.tokenId === TOKEN_ID_A && t.stateHash === STATE_HASH_2,
    );
    expect(loserTombstone).toBeDefined();

    // Event emitted with the loser's tokenId + stateHash.
    const doubleSpendEvents = emitEvent.mock.calls.filter(
      (call) => call[0] === 'transfer:double-spend-detected',
    );
    expect(doubleSpendEvents.length).toBe(1);
    const payload = doubleSpendEvents[0]![1] as {
      tokenId: string;
      sourceStateHash: string;
      ourIntendedRecipient: string;
      detectedAt: number;
    };
    expect(payload.tokenId).toBe(TOKEN_ID_A);
    expect(payload.sourceStateHash).toBe(STATE_HASH_2);
    // JOIN-time detection doesn't have access to the original send's
    // intended recipient (the OUTBOX entry was either never persisted
    // or has been GC'd by the time the merge runs). The reactive
    // submit-time path carries the recipient; this path leaves it empty.
    expect(payload.ourIntendedRecipient).toBe('');
    expect(typeof payload.detectedAt).toBe('number');
  });

  it('preserves a `confirmed` snapshot with divergent state (legacy dual-state behavior; spent-state rescan handles it)', async () => {
    // Same fixture as the JOIN-divergent loser test BUT the in-memory
    // token is at status='confirmed', NOT 'transferring'. This is the
    // "stale belief" case (sibling-device spend that hasn't yet flowed
    // through profile sync). The spent-state-rescan worker (Item #16,
    // default-ON) catches it on its next 5-min `oracle.isSpent` probe;
    // load() preserves the dual state.
    const staleBelief = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_2,
      id: 'stale-belief',
      status: 'confirmed',
    });
    await module.addToken(staleBelief);

    const winnerOnChain = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_1,
      id: 'winner-on-chain',
      status: 'confirmed',
    });
    const txfWinner = JSON.parse(winnerOnChain.sdkData);
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: {
        _meta: {
          version: 1,
          address: 'alpha1testaddress',
          formatVersion: '1.0',
          updatedAt: Date.now(),
        },
        [`_${winnerOnChain.id}`]: txfWinner,
      } as unknown as TxfStorageDataBase,
      timestamp: Date.now(),
    });

    const emitEvent = deps.emitEvent as ReturnType<typeof vi.fn>;
    emitEvent.mockClear();

    await module.load();

    // Both survive (legacy dual-state).
    const survivorIds = new Set(module.getTokens().map((t) => t.id));
    expect(survivorIds.has(staleBelief.id)).toBe(true);
    expect(survivorIds.has(winnerOnChain.id)).toBe(true);

    // No double-spend event fired (this path is owned by the
    // spent-state-rescan worker, not by loadFromStorageData).
    const doubleSpendEvents = emitEvent.mock.calls.filter(
      (call) => call[0] === 'transfer:double-spend-detected',
    );
    expect(doubleSpendEvents.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // OUTBOX-SEND-FOLLOWUPS Item #14 Phase 2 work item 8 — `getAssets`/balance
  // regression test for the JOIN-divergent loser path. After PR #182's drop,
  // the loser token must be absent from BOTH `confirmedAmount` and
  // `unconfirmedAmount` (and from every count) so the loser device's UI
  // numbers converge to the truth after reconciliation.
  //
  // Pre-PR #182 the loser inflated `unconfirmedAmount` indefinitely because
  // `aggregateTokens` includes `'transferring'` tokens in the unconfirmed
  // bucket. PR #182 removes the loser from `this.tokens` entirely; this test
  // pins that contract end-to-end through `getAssets()`.
  // ---------------------------------------------------------------------------
  it('drops the JOIN-divergent loser from every getAssets() balance bucket (Phase 2 work item 8)', async () => {
    // Loser device's in-flight send at status='transferring' for tokenA.
    // The amount is the default '1000000' from createMockToken — large
    // enough that an inflation regression would be visible.
    const loserInFlight = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_2,
      id: 'loser-in-flight',
      status: 'transferring',
    });
    await module.addToken(loserInFlight);

    // Winner state of the SAME tokenId at a DIFFERENT stateHash — the
    // L3 aggregator's anchored choice.
    const winnerOnChain = createMockToken({
      tokenId: TOKEN_ID_A,
      stateHash: STATE_HASH_1,
      id: 'winner-on-chain',
    });
    const txfWinner = JSON.parse(winnerOnChain.sdkData);
    const tokenStorage = deps.tokenStorageProviders.get('mock');
    (tokenStorage!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      source: 'local' as const,
      data: {
        _meta: {
          version: 1,
          address: 'alpha1testaddress',
          formatVersion: '1.0',
          updatedAt: Date.now(),
        },
        [`_${winnerOnChain.id}`]: txfWinner,
      } as unknown as TxfStorageDataBase,
      timestamp: Date.now(),
    });

    await module.load();

    // Sanity: loser dropped, winner survives (mirrors PR #182's test).
    const survivors = module.getTokens();
    const survivorIds = new Set(survivors.map((t) => t.id));
    expect(survivorIds.has(loserInFlight.id)).toBe(false);
    expect(survivorIds.has(winnerOnChain.id)).toBe(true);

    // ── Phase 2 work item 8 contract ──────────────────────────────────────
    // The dropped loser's amount ('1000000') must NOT appear in any
    // balance bucket for the UCT_HEX coin. Only the winner's '1000000'
    // contributes — the post-drop totals are exactly one token's worth.
    const assets = await module.getAssets('UCT_HEX');
    expect(assets).toHaveLength(1);

    const uct = assets[0]!;
    expect(uct.coinId).toBe('UCT_HEX');

    // `confirmedAmount` excludes the dropped loser AND only counts the
    // winner (a single 'confirmed' token at '1000000').
    expect(uct.confirmedAmount).toBe('1000000');
    expect(uct.confirmedTokenCount).toBe(1);

    // `unconfirmedAmount` is zero. Pre-PR #182, this would have been
    // '1000000' (the 'transferring' loser inflated this bucket); the
    // bug fix removes the loser from `this.tokens` entirely so the
    // unconfirmed bucket converges to the truth.
    expect(uct.unconfirmedAmount).toBe('0');
    expect(uct.unconfirmedTokenCount).toBe(0);

    // `totalAmount = confirmedAmount + unconfirmedAmount`, so the
    // dropped loser is excluded here too.
    expect(uct.totalAmount).toBe('1000000');
    expect(uct.tokenCount).toBe(1);

    // No `'transferring'` tokens remain — the loser was the only one.
    expect(uct.transferringTokenCount).toBe(0);
  });
});
