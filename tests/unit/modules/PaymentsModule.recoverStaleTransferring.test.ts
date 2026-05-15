/**
 * Tests for PaymentsModule.recoverStaleTransferring()
 *
 * PR #147 follow-up (W5) — init-time recovery probe for stale
 * `status='transferring'` source tokens left over from a hard crash
 * between burn-on-wire and dispatcher cleanup. See the docstring on
 * `recoverStaleTransferring` for the full invariant.
 *
 * Coverage:
 *   1. No stale tokens                          → no-op
 *   2. Stale + isSpent=false                    → reverted to 'confirmed'
 *   3. Stale + isSpent=true                     → removeToken + SENT history
 *   4. isSpent throws (aggregator unreachable)  → left as 'transferring'
 *   5. Empty stateHash                          → skipped
 *   6. Mixed batch (spent + owned + unknown)    → correct per-outcome counts
 *   7. Idempotent re-runs                       → no double-tombstone
 *   8. Per-token re-check                       → stale removed mid-loop is skipped
 *   9. Wired into load()                        → probe runs after load completes
 *  10. SENT history payload shape               → recipient='[unknown]', synth transferId
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
      getSymbol: () => 'UCT',
      getName: () => 'Unicity Token',
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Test Constants
// =============================================================================

const TOKEN_ID_A = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ID_B = 'bbbb000000000000000000000000000000000000000000000000000000000002';
const TOKEN_ID_C = 'cccc000000000000000000000000000000000000000000000000000000000003';
const STATE_HASH_1 = '1111000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_2 = '2222000000000000000000000000000000000000000000000000000000000002';
const STATE_HASH_3 = '3333000000000000000000000000000000000000000000000000000000000003';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockToken(opts: {
  tokenId: string;
  stateHash: string;
  id?: string;
  status?: Token['status'];
  amount?: string;
}): Token {
  return {
    id: opts.id ?? `local-${opts.tokenId.slice(0, 8)}-${opts.stateHash.slice(0, 8)}`,
    coinId: 'UCT_HEX',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: opts.amount ?? '1000000',
    status: opts.status ?? 'confirmed',
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

function createMockDeps(overrides?: Partial<PaymentsModuleDependencies>): PaymentsModuleDependencies {
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
    addHistoryEntry: vi.fn().mockResolvedValue(undefined),
    getHistoryEntries: vi.fn().mockResolvedValue([]),
  };

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
    getTokenState: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;

  const mockIdentity: FullIdentity = {
    chainPubkey: 'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd11',
    l1Address: 'alpha1testaddress',
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
    ...overrides,
  };
}

// Inject a token directly into the module's tokens map, bypassing
// addToken's validation. Used to seed `status='transferring'` tokens
// (which addToken would not produce via the normal incoming-message path).
function seedToken(module: ReturnType<typeof createPaymentsModule>, token: Token): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokens = (module as any).tokens as Map<string, Token>;
  tokens.set(token.id, token);
}

// Invoke the private probe for unit testing.
function invokeRecoverStaleTransferring(
  module: ReturnType<typeof createPaymentsModule>,
): Promise<{ spent: number; owned: number; unknown: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (module as any).recoverStaleTransferring();
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule.recoverStaleTransferring (W5 init-time probe)', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let deps: PaymentsModuleDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    module = createPaymentsModule({ debug: false });
    deps = createMockDeps();
    module.initialize(deps);
  });

  // ---------------------------------------------------------------------------
  // 1. No-op cases
  // ---------------------------------------------------------------------------

  describe('no-op cases', () => {
    it('returns zero counters when there are no transferring tokens', async () => {
      const counters = await invokeRecoverStaleTransferring(module);
      expect(counters).toEqual({ spent: 0, owned: 0, unknown: 0 });
      expect(deps.oracle.isSpent).not.toHaveBeenCalled();
    });

    it('ignores tokens whose status is not transferring', async () => {
      seedToken(module, createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'confirmed' }));
      seedToken(module, createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, status: 'pending' }));

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters).toEqual({ spent: 0, owned: 0, unknown: 0 });
      expect(deps.oracle.isSpent).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Owned outcome (isSpent → false)
  // ---------------------------------------------------------------------------

  describe('owned outcome (burn never landed)', () => {
    it('reverts a stale transferring token to confirmed when aggregator says unspent', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      const isSpent = vi.mocked(deps.oracle.isSpent);
      isSpent.mockResolvedValueOnce(false);

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters).toEqual({ spent: 0, owned: 1, unknown: 0 });
      expect(isSpent).toHaveBeenCalledWith(STATE_HASH_1);

      // Token now reports confirmed, still in active map.
      const tokens = module.getTokens();
      const reverted = tokens.find((t) => t.id === stale.id);
      expect(reverted).toBeDefined();
      expect(reverted!.status).toBe('confirmed');
    });

    it('updates updatedAt when reverting', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      stale.updatedAt = 1; // ancient
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(false);
      const before = Date.now();
      await invokeRecoverStaleTransferring(module);
      const after = Date.now();

      const reverted = module.getTokens().find((t) => t.id === stale.id);
      expect(reverted!.updatedAt).toBeGreaterThanOrEqual(before);
      expect(reverted!.updatedAt).toBeLessThanOrEqual(after);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Spent outcome (isSpent → true)
  // ---------------------------------------------------------------------------

  describe('spent outcome (burn landed during the crashed session)', () => {
    it('removes the token and adds a SENT history entry when aggregator says spent', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
        amount: '5000000',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(true);

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters).toEqual({ spent: 1, owned: 0, unknown: 0 });

      // Token gone from active map.
      const tokens = module.getTokens();
      expect(tokens.find((t) => t.id === stale.id)).toBeUndefined();

      // Tombstone written.
      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_1)).toBe(true);

      // SENT history added.
      const history = module.getHistory();
      const sent = history.find((h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A);
      expect(sent).toBeDefined();
      expect(sent!.amount).toBe('5000000');
      expect(sent!.coinId).toBe('UCT_HEX');
      expect(sent!.symbol).toBe('UCT');
      expect(sent!.recipientAddress).toBe('[unknown]');
      // Steelman W2: recipientPubkey uses '[recovered]' sentinel, not ''
      // — UI consumers should switch on this prefix instead of a falsy
      // empty string.
      expect(sent!.recipientPubkey).toBe('[recovered]');
      expect(sent!.transferId).toMatch(/^recovered-/);
      expect(sent!.memo).toContain('Recovered');
    });

    it('emits distinct transferIds for distinct (tokenId, stateHash) pairs', async () => {
      const a = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      const b = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, status: 'transferring' });
      seedToken(module, a);
      seedToken(module, b);

      vi.mocked(deps.oracle.isSpent).mockResolvedValue(true);

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters.spent).toBe(2);
      const history = module.getHistory().filter((h) => h.type === 'SENT');
      expect(history).toHaveLength(2);
      const transferIds = new Set(history.map((h) => h.transferId));
      expect(transferIds.size).toBe(2); // distinct
    });

    it('emits a DETERMINISTIC transferId per (tokenId, stateHash) for replay safety (Steelman C1/C3)', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValue(true);

      await invokeRecoverStaleTransferring(module);

      const sent = module.getHistory().find((h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A);
      expect(sent).toBeDefined();
      // Format: recovered-${historicalTokenId}-${stateHashShort}
      expect(sent!.transferId).toBe(`recovered-${TOKEN_ID_A}-${STATE_HASH_1.slice(0, 16)}`);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Unknown outcome (isSpent throws)
  // ---------------------------------------------------------------------------

  describe('unknown outcome (aggregator unreachable)', () => {
    it('leaves the token as transferring and increments the unknown counter', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockRejectedValueOnce(new Error('aggregator down'));

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters).toEqual({ spent: 0, owned: 0, unknown: 1 });

      // Token still present, still transferring.
      const tokens = module.getTokens();
      const survived = tokens.find((t) => t.id === stale.id);
      expect(survived).toBeDefined();
      expect(survived!.status).toBe('transferring');

      // No tombstone, no history.
      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_1)).toBe(false);
      expect(module.getHistory()).toHaveLength(0);
    });

    it('continues processing remaining tokens after one failure', async () => {
      const failing = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      const succeeding = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, status: 'transferring' });
      seedToken(module, failing);
      seedToken(module, succeeding);

      const isSpent = vi.mocked(deps.oracle.isSpent);
      isSpent.mockImplementation((stateHash: string) => {
        if (stateHash === STATE_HASH_1) return Promise.reject(new Error('boom'));
        if (stateHash === STATE_HASH_2) return Promise.resolve(false);
        return Promise.resolve(false);
      });

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters.unknown).toBe(1);
      expect(counters.owned).toBe(1);

      const tokens = module.getTokens();
      expect(tokens.find((t) => t.id === failing.id)!.status).toBe('transferring');
      expect(tokens.find((t) => t.id === succeeding.id)!.status).toBe('confirmed');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Edge cases — empty state hash
  // ---------------------------------------------------------------------------

  describe('empty stateHash', () => {
    it('skips tokens whose sdkData has no extractable stateHash', async () => {
      const stale: Token = {
        id: 'no-state-hash',
        coinId: 'UCT_HEX',
        symbol: 'UCT',
        name: 'UCT',
        decimals: 8,
        amount: '1',
        status: 'transferring',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // sdkData with no genesis/state info → extractStateHashFromSdkData returns ''
        sdkData: '{}',
      };
      seedToken(module, stale);

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters).toEqual({ spent: 0, owned: 0, unknown: 0 });
      expect(deps.oracle.isSpent).not.toHaveBeenCalled();
      // Token left untouched.
      const survived = module.getTokens().find((t) => t.id === stale.id);
      expect(survived).toBeDefined();
      expect(survived!.status).toBe('transferring');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Mixed batch
  // ---------------------------------------------------------------------------

  describe('mixed batch', () => {
    it('correctly classifies a mix of spent / owned / unknown in one pass', async () => {
      const spentTok = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      const ownedTok = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, status: 'transferring' });
      const unknownTok = createMockToken({ tokenId: TOKEN_ID_C, stateHash: STATE_HASH_3, status: 'transferring' });
      seedToken(module, spentTok);
      seedToken(module, ownedTok);
      seedToken(module, unknownTok);

      vi.mocked(deps.oracle.isSpent).mockImplementation((stateHash: string) => {
        if (stateHash === STATE_HASH_1) return Promise.resolve(true);
        if (stateHash === STATE_HASH_2) return Promise.resolve(false);
        if (stateHash === STATE_HASH_3) return Promise.reject(new Error('timeout'));
        return Promise.resolve(false);
      });

      const counters = await invokeRecoverStaleTransferring(module);

      expect(counters).toEqual({ spent: 1, owned: 1, unknown: 1 });

      // Outcomes verified individually:
      expect(module.getTokens().find((t) => t.id === spentTok.id)).toBeUndefined();
      expect(module.getTokens().find((t) => t.id === ownedTok.id)!.status).toBe('confirmed');
      expect(module.getTokens().find((t) => t.id === unknownTok.id)!.status).toBe('transferring');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Idempotency
  // ---------------------------------------------------------------------------

  describe('idempotent re-runs', () => {
    it('does not double-tombstone or double-add SENT history when called twice', async () => {
      const stale = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValue(true);

      const first = await invokeRecoverStaleTransferring(module);
      expect(first.spent).toBe(1);

      // Second probe — token has already been removed; nothing to do.
      const second = await invokeRecoverStaleTransferring(module);
      expect(second).toEqual({ spent: 0, owned: 0, unknown: 0 });

      // Tombstone count unchanged (still exactly one for this state).
      const tombstones = module.getTombstones().filter(
        (t) => t.tokenId === TOKEN_ID_A && t.stateHash === STATE_HASH_1,
      );
      expect(tombstones).toHaveLength(1);

      // SENT history count unchanged (still exactly one entry for this token).
      const sentEntries = module.getHistory().filter(
        (h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A,
      );
      expect(sentEntries).toHaveLength(1);
    });

    it('safely re-runs after a successful revert (token now confirmed, no longer eligible)', async () => {
      const stale = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValue(false);

      const first = await invokeRecoverStaleTransferring(module);
      expect(first.owned).toBe(1);

      vi.mocked(deps.oracle.isSpent).mockClear();
      const second = await invokeRecoverStaleTransferring(module);
      expect(second).toEqual({ spent: 0, owned: 0, unknown: 0 });
      expect(deps.oracle.isSpent).not.toHaveBeenCalled(); // not in stale snapshot
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Per-token re-check (defensive idempotency mid-loop)
  // ---------------------------------------------------------------------------

  describe('per-token re-check', () => {
    it('skips a token whose status changed out-of-band after snapshot but before per-token isSpent', async () => {
      const a = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      const b = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, status: 'transferring' });
      seedToken(module, a);
      seedToken(module, b);

      // When the probe queries isSpent for a (the first one), we mutate b's
      // status out-of-band to simulate concurrent dispatch finishing. The
      // per-token re-check at the top of the loop should then skip b.
      let callCount = 0;
      vi.mocked(deps.oracle.isSpent).mockImplementation(async (stateHash: string) => {
        callCount++;
        if (callCount === 1) {
          // While probing the first token, mutate b's status as if a
          // concurrent code path resolved it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tokens = (module as any).tokens as Map<string, Token>;
          const live = tokens.get(b.id);
          if (live) live.status = 'confirmed';
        }
        return stateHash === STATE_HASH_1; // a is spent, b would be owned
      });

      const counters = await invokeRecoverStaleTransferring(module);

      // a was spent → tombstoned; b was skipped (no isSpent call for it).
      expect(counters.spent).toBe(1);
      expect(counters.owned).toBe(0); // b skipped via re-check, not classified
      expect(deps.oracle.isSpent).toHaveBeenCalledTimes(1); // only a probed
      // b status unchanged from the out-of-band update.
      expect(module.getTokens().find((t) => t.id === b.id)!.status).toBe('confirmed');
    });
  });

  // ---------------------------------------------------------------------------
  // 9a. Steelman C1 — single-flight guard
  // ---------------------------------------------------------------------------

  describe('single-flight guard (Steelman C1)', () => {
    it('returns the in-flight promise when invoked twice concurrently — no double processing', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      // Block isSpent so the first probe stays in-flight while we kick
      // off a second one.
      let resolveIsSpent!: (v: boolean) => void;
      const isSpentPromise = new Promise<boolean>((resolve) => {
        resolveIsSpent = resolve;
      });
      vi.mocked(deps.oracle.isSpent).mockReturnValueOnce(isSpentPromise);

      const first = invokeRecoverStaleTransferring(module);
      const second = invokeRecoverStaleTransferring(module);

      // Both promises must resolve to the SAME counters (literal object
      // identity is the cleanest assertion of the single-flight contract).
      resolveIsSpent(true);
      const [r1, r2] = await Promise.all([first, second]);
      expect(r1).toBe(r2);

      // Only ONE isSpent call — the second invocation reused the in-flight result.
      expect(deps.oracle.isSpent).toHaveBeenCalledTimes(1);

      // Exactly ONE SENT history entry.
      const sentEntries = module.getHistory().filter(
        (h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A,
      );
      expect(sentEntries).toHaveLength(1);
    });

    it('clears the in-flight guard so a future probe can run again', async () => {
      const a = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, status: 'transferring' });
      seedToken(module, a);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(false);
      await invokeRecoverStaleTransferring(module);

      // After completion, a new stale token + fresh probe must be processed.
      const b = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, status: 'transferring' });
      seedToken(module, b);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(false);
      const result = await invokeRecoverStaleTransferring(module);

      expect(result.owned).toBe(1); // b was processed
    });
  });

  // ---------------------------------------------------------------------------
  // 9b. Steelman C3 — history-first ordering
  // ---------------------------------------------------------------------------

  describe('history-first ordering (Steelman C3)', () => {
    it('writes SENT history BEFORE removeToken, so a removeToken throw still leaves a recoverable record', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(true);

      // Force removeToken to throw directly (PaymentsModule.save()
      // swallows provider errors by design, so we can't simulate a
      // removeToken failure via the storage mock alone).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const removeSpy = vi.spyOn(module as any, 'removeToken').mockRejectedValueOnce(
        new Error('removeToken boom'),
      );

      const counters = await invokeRecoverStaleTransferring(module);

      // History was written first — assert the SENT entry exists with the
      // deterministic transferId, despite removeToken throwing.
      const sent = module.getHistory().find((h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A);
      expect(sent).toBeDefined();
      expect(sent!.transferId).toBe(`recovered-${TOKEN_ID_A}-${STATE_HASH_1.slice(0, 16)}`);

      // The removeToken failure is reported as 'unknown'.
      expect(counters.unknown).toBe(1);
      expect(counters.spent).toBe(0);

      // History-first ordering: addToHistory must have been called BEFORE
      // removeToken. We can verify by checking removeToken WAS called
      // (proving we got past the history step) and that history exists.
      expect(removeSpy).toHaveBeenCalledWith(stale.id);
    });

    it('on history-write failure, leaves the token as transferring (no destructive action taken)', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(true);

      // Force history append to throw.
      const tokenStorage = deps.tokenStorageProviders.get('mock')!;
      vi.mocked(tokenStorage.addHistoryEntry!).mockRejectedValueOnce(new Error('history quota exceeded'));

      const counters = await invokeRecoverStaleTransferring(module);

      // No destruction: token still in active map at transferring.
      const survived = module.getTokens().find((t) => t.id === stale.id);
      expect(survived).toBeDefined();
      expect(survived!.status).toBe('transferring');
      // No tombstone written.
      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_1)).toBe(false);
      // Reported as unknown.
      expect(counters.unknown).toBeGreaterThanOrEqual(1);
      expect(counters.spent).toBe(0);
    });

    it('replay after a removeToken failure REPLACES the SENT entry instead of duplicating', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValue(true);

      // First probe: history write succeeds, removeToken throws.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const removeSpy = vi.spyOn(module as any, 'removeToken').mockRejectedValueOnce(
        new Error('boom'),
      );
      await invokeRecoverStaleTransferring(module);

      // History is in place even though removeToken failed.
      let sentEntries = module.getHistory().filter(
        (h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A,
      );
      expect(sentEntries).toHaveLength(1);

      // Second probe: removeToken now restored to real impl (mockRejectedValueOnce expired).
      removeSpy.mockRestore();
      await invokeRecoverStaleTransferring(module);

      // Still exactly ONE SENT entry — the deterministic transferId
      // dedup-replaces the prior one.
      sentEntries = module.getHistory().filter(
        (h) => h.type === 'SENT' && h.tokenId === TOKEN_ID_A,
      );
      expect(sentEntries).toHaveLength(1);

      // Token is now gone from active map (second probe completed cleanup).
      expect(module.getTokens().find((t) => t.id === stale.id)).toBeUndefined();
      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_1)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 9c. Steelman W1 — save-failure rollback
  // ---------------------------------------------------------------------------

  describe('save-failure rollback (Steelman W1)', () => {
    it('rolls back in-memory revert when save() fails after reverting owned tokens', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      const originalUpdatedAt = stale.updatedAt;
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValueOnce(false); // owned

      // PaymentsModule.save() is best-effort and swallows
      // provider-level errors, so we must spy on the private save()
      // method directly to simulate a propagated failure.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(module as any, 'save').mockRejectedValueOnce(new Error('save boom'));

      const counters = await invokeRecoverStaleTransferring(module);

      // In-memory state rolled back: still transferring, original updatedAt restored.
      const live = module.getTokens().find((t) => t.id === stale.id);
      expect(live).toBeDefined();
      expect(live!.status).toBe('transferring');
      expect(live!.updatedAt).toBe(originalUpdatedAt);

      // Counters reflect rollback: the owned revert became unknown.
      expect(counters.owned).toBe(0);
      expect(counters.unknown).toBe(1);
    });
  });
  // ---------------------------------------------------------------------------
  // 9. Wired into load()
  // ---------------------------------------------------------------------------

  describe('integration: load() invokes the probe', () => {
    it('fires recoverStaleTransferring as fire-and-forget after load() completes', async () => {
      // We can't easily assert "called" via spy on a private method, but we
      // can verify the indirect effect: a stale token preserved through
      // load gets reclassified after load completes.
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockResolvedValue(false); // owned

      await module.load();
      // The probe is fire-and-forget; await microtasks to let it complete.
      // It calls oracle.isSpent then potentially save() — both async. A
      // small explicit await of all pending microtasks is sufficient here.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // load() preserves transferring tokens; the probe then reverts them.
      const tokens = module.getTokens();
      const seen = tokens.find((t) => t.id === stale.id);
      expect(seen).toBeDefined();
      expect(seen!.status).toBe('confirmed');
      expect(deps.oracle.isSpent).toHaveBeenCalledWith(STATE_HASH_1);
    });

    it('does not block load() when aggregator throws', async () => {
      const stale = createMockToken({
        tokenId: TOKEN_ID_A,
        stateHash: STATE_HASH_1,
        status: 'transferring',
      });
      seedToken(module, stale);

      vi.mocked(deps.oracle.isSpent).mockRejectedValue(new Error('network down'));

      // load() must resolve even though the probe will throw per-token.
      await expect(module.load()).resolves.toBeUndefined();

      // Allow the fire-and-forget probe to settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Token still preserved as transferring.
      const seen = module.getTokens().find((t) => t.id === stale.id);
      expect(seen).toBeDefined();
      expect(seen!.status).toBe('transferring');
    });
  });
});
