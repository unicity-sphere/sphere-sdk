/**
 * Tests for sync() pre-flush V5-finalization drain (PR #127 follow-up).
 *
 * Background. tokenToTxf() returns null for any token whose sdkData carries
 * `_pendingFinalization` (no `genesis` / `state`). buildTxfStorageData()
 * silently drops nulls from the published CAR. Without these guards, a
 * sync() running while ANY incoming v5 token is still pending publishes a
 * partial CAR — a remote device's recoverLatest() walks to the higher
 * pointer and observes a partial inventory.
 *
 * The architectural fix: sync() drains pending V5 finalizations before
 * the flush. These tests pin the contract:
 *
 *  - Default-on drain runs the resolveUnconfirmed poll loop.
 *  - When drain succeeds, flush proceeds normally.
 *  - When drain times out, flush is SKIPPED by default — no partial CAR.
 *  - `forceFlushOnDrainTimeout: true` restores legacy behavior with a
 *    populated `pendingAtFlush` so callers can detect partial-CAR risk.
 *  - `drainPending: false` skips the drain entirely (legacy semantics).
 *  - No-oracle short-circuit: drain skipped (helper would otherwise hang
 *    for the full timeout, since resolveUnconfirmed early-exits).
 *  - No-pending fast path: drain skipped (zero overhead).
 *  - No-providers branch: drain not attempted (no flush to protect; the
 *    kv StorageProvider preserves _pendingFinalization shape).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// SDK static-import mocks (kept minimal — drain logic doesn't touch the SDK)
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
// Test harness
// =============================================================================

interface SyncMocks {
  oracle: {
    getStateTransitionClient?: ReturnType<typeof vi.fn>;
    getTrustBase?: ReturnType<typeof vi.fn>;
  };
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  syncSpy: ReturnType<typeof vi.fn>;
}

function createMockDeps(opts: {
  withOracle: boolean;
  withProvider: boolean;
}): { deps: PaymentsModuleDependencies; mocks: SyncMocks } {
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

  const syncSpy = vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 });

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
    sync: syncSpy,
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  if (opts.withProvider) tokenStorageProviders.set('mock', mockTokenStorage);

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    setIdentity: vi.fn(),
    sendMessage: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;

  // Oracle: when withOracle=false, drop both getStateTransitionClient and
  // getTrustBase so drainPendingFinalizations() short-circuits.
  const oracleStubs: SyncMocks['oracle'] = opts.withOracle
    ? {
        getStateTransitionClient: vi.fn().mockReturnValue({ /* truthy */ }),
        getTrustBase: vi.fn().mockReturnValue({ /* truthy */ }),
      }
    : {};

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
    ...oracleStubs,
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
    mocks: { oracle: oracleStubs, tokenStorage: mockTokenStorage, syncSpy },
  };
}

/** Inject a fake token directly into PaymentsModule's internal map. */
function seedToken(module: ReturnType<typeof createPaymentsModule>, status: Token['status']): Token {
  const token: Token = {
    id: `tok-${status}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'unicity-coin',
    coinId: 'UCT',
    symbol: 'UCT',
    amount: '1000',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify({ _pendingFinalization: { type: 'v5_bundle', stage: 'RECEIVED', attemptCount: 0 } }),
  };
  const tokens = (module as unknown as { tokens: Map<string, Token> }).tokens;
  tokens.set(token.id, token);
  return token;
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule.sync() — pre-flush V5-finalization drain', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let mocks: SyncMocks;

  beforeEach(() => {
    module = createPaymentsModule();
  });

  describe('drainPendingFinalizations short-circuits', () => {
    it('skips drain when no tokens are pending', async () => {
      const setup = createMockDeps({ withOracle: true, withProvider: true });
      module.initialize(setup.deps);
      mocks = setup.mocks;

      const resolveSpy = vi.spyOn(module, 'resolveUnconfirmed');

      const result = await module.sync();

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(result.drainTimedOut).toBeUndefined();
      expect(result.pendingAtFlush).toBeUndefined();
      expect(mocks.syncSpy).toHaveBeenCalled();
    });

    it('skips drain when oracle has no stClient/trustBase, even with pending tokens', async () => {
      const setup = createMockDeps({ withOracle: false, withProvider: true });
      module.initialize(setup.deps);
      mocks = setup.mocks;

      seedToken(module, 'submitted');

      const resolveSpy = vi.spyOn(module, 'resolveUnconfirmed');

      const result = await module.sync();

      // No-oracle short-circuit: helper returns immediately; resolveUnconfirmed
      // is never called by the loop. Flush proceeds (we can't drain — best
      // effort), and pendingAtFlush surfaces the residual count.
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(mocks.syncSpy).toHaveBeenCalled();
      expect(result.pendingAtFlush).toBe(1);
      expect(result.drainTimedOut).toBeUndefined();
    });

    it('skips drain when no token-storage providers are configured', async () => {
      const setup = createMockDeps({ withOracle: true, withProvider: false });
      module.initialize(setup.deps);

      seedToken(module, 'submitted');

      const resolveSpy = vi.spyOn(module, 'resolveUnconfirmed');

      const result = await module.sync();

      // No providers → no flush to protect → no drain.
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  describe('drain succeeds before flush', () => {
    it('polls resolveUnconfirmed until pending tokens clear, then flushes', async () => {
      const setup = createMockDeps({ withOracle: true, withProvider: true });
      module.initialize(setup.deps);
      mocks = setup.mocks;

      const tok = seedToken(module, 'submitted');
      const tokens = (module as unknown as { tokens: Map<string, Token> }).tokens;

      // Spy: first poll leaves the token pending, second flips it to confirmed.
      const resolveSpy = vi.spyOn(module, 'resolveUnconfirmed').mockImplementation(async () => {
        const t = tokens.get(tok.id)!;
        if (t.status === 'submitted') {
          // Mid-poll: still pending. Caller will sleep + load + retry.
          return { resolved: 0, stillPending: 1, failed: 0, details: [] };
        }
        return { resolved: 1, stillPending: 0, failed: 0, details: [] };
      });

      // Force the second poll to flip it: stub load() to mutate status.
      const loadSpy = vi.spyOn(module, 'load').mockImplementation(async () => {
        const t = tokens.get(tok.id);
        if (t) t.status = 'confirmed';
      });

      const result = await module.sync({ drainPollIntervalMs: 1, drainTimeoutMs: 5_000 });

      expect(resolveSpy).toHaveBeenCalledTimes(2);
      expect(loadSpy).toHaveBeenCalled();
      expect(mocks.syncSpy).toHaveBeenCalled();
      expect(result.drainTimedOut).toBeUndefined();
      expect(result.pendingAtFlush).toBeUndefined();
    });
  });

  describe('drain times out', () => {
    it('skips flush by default when pending tokens remain (no partial CAR)', async () => {
      const setup = createMockDeps({ withOracle: true, withProvider: true });
      module.initialize(setup.deps);
      mocks = setup.mocks;

      seedToken(module, 'submitted');

      // resolveUnconfirmed never resolves anything; status stays submitted.
      vi.spyOn(module, 'resolveUnconfirmed').mockResolvedValue({
        resolved: 0,
        stillPending: 1,
        failed: 0,
        details: [],
      });
      vi.spyOn(module, 'load').mockResolvedValue();

      const result = await module.sync({
        drainPollIntervalMs: 1,
        drainTimeoutMs: 25, // tight budget — drain will time out
      });

      expect(mocks.syncSpy).not.toHaveBeenCalled();   // flush skipped
      expect(result.drainTimedOut).toBe(true);
      expect(result.pendingAtFlush).toBe(1);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('flushes anyway when forceFlushOnDrainTimeout=true (legacy escape hatch)', async () => {
      const setup = createMockDeps({ withOracle: true, withProvider: true });
      module.initialize(setup.deps);
      mocks = setup.mocks;

      seedToken(module, 'submitted');

      vi.spyOn(module, 'resolveUnconfirmed').mockResolvedValue({
        resolved: 0,
        stillPending: 1,
        failed: 0,
        details: [],
      });
      vi.spyOn(module, 'load').mockResolvedValue();

      const result = await module.sync({
        drainPollIntervalMs: 1,
        drainTimeoutMs: 25,
        forceFlushOnDrainTimeout: true,
      });

      expect(mocks.syncSpy).toHaveBeenCalled();      // flush proceeded
      expect(result.drainTimedOut).toBeUndefined();  // not set when force flushing
      expect(result.pendingAtFlush).toBe(1);         // partial-CAR risk surfaced
    });
  });

  describe('drainPending: false', () => {
    it('skips drain entirely (legacy semantics) and flushes immediately', async () => {
      const setup = createMockDeps({ withOracle: true, withProvider: true });
      module.initialize(setup.deps);
      mocks = setup.mocks;

      seedToken(module, 'submitted');

      const resolveSpy = vi.spyOn(module, 'resolveUnconfirmed');

      const result = await module.sync({ drainPending: false });

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(mocks.syncSpy).toHaveBeenCalled();
      expect(result.pendingAtFlush).toBe(1);
      expect(result.drainTimedOut).toBeUndefined();
    });
  });
});
