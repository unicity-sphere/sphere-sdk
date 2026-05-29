/**
 * Tests for `PaymentsModule.load()` coalesce guard (Issue #166 P3 #6).
 *
 * The coalesce guard at lines 2716-2719 (added in the round-1 steelman
 * fix `cbf97d2`) prevents concurrent `load()` calls from producing
 * duplicate post-load side-effects:
 *
 *   ```
 *   if (this.loadedPromise !== null && !this.loaded) {
 *     await this.loadedPromise;
 *     return;
 *   }
 *   ```
 *
 * The load-bearing arc: a fire-and-forget
 * `detectOrphanSpendingTokens()` runs at the tail of `load()` only
 * when both writers are installed. Without the coalesce, two
 * concurrent calls would fire the sweep twice, producing duplicate
 * `transfer:orphan-spending-detected` events for the same orphans.
 *
 * The legitimate refresh contract (sequential calls re-run the load)
 * is also asserted so a future "always coalesce" regression doesn't
 * break in-place state refreshes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import {
  createStubOracle,
  createStubStorageProvider,
  createStubTransport,
  createTestIdentity,
  createWriterPair,
  makeToken,
} from './__fixtures__/payments-module-fixture';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../../storage';
import type { Token } from '../../../../types';

// ---------------------------------------------------------------------------
// SDK mocks
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi
      .fn()
      .mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class {
    toJSON(): string {
      return 'UCT_HEX';
    }
  },
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
vi.mock(
  '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate',
  () => ({ UnmaskedPredicate: class {} }),
);
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
}));
vi.mock('../../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Counting TokenStorageProvider — observable signal for coalesce
// ---------------------------------------------------------------------------

interface CountingTokenStorage extends TokenStorageProvider<TxfStorageDataBase> {
  readonly loadCallCount: () => number;
  /** Resolver to delay the first load() — lets us assert that the
   *  second load() call awaits the first promise. */
  resolveFirstLoad?: () => void;
}

function createCountingTokenStorage(
  options: { delayFirstLoad?: boolean } = {},
): CountingTokenStorage {
  let calls = 0;
  let resolveFirst: (() => void) | null = null;
  const firstLoadGate = new Promise<void>((res) => {
    resolveFirst = res;
  });

  const provider: CountingTokenStorage = {
    id: 'counting-token-storage',
    name: 'Counting Token Storage',
    type: 'local',
    setIdentity: () => undefined,
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    async load() {
      calls += 1;
      if (options.delayFirstLoad && calls === 1) {
        await firstLoadGate;
      }
      return {
        success: true,
        data: undefined,
        source: 'local' as const,
        timestamp: Date.now(),
      };
    },
    async save() {
      return { success: true, timestamp: Date.now() };
    },
    async sync(localData: TxfStorageDataBase) {
      return {
        success: true,
        merged: localData,
        added: 0,
        removed: 0,
        conflicts: 0,
      };
    },
    loadCallCount: () => calls,
    resolveFirstLoad: () => resolveFirst?.(),
  } as unknown as CountingTokenStorage;

  return provider;
}

function createPaymentsDeps(
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>,
  storage: StorageProvider = createStubStorageProvider(),
): PaymentsModuleDependencies {
  const providers = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  providers.set('main', tokenStorage);
  return {
    identity: createTestIdentity(),
    storage,
    tokenStorageProviders: providers,
    transport: createStubTransport(),
    oracle: createStubOracle(),
    emitEvent: vi.fn(),
  };
}

interface PaymentsModuleInternals {
  tokens: Map<string, Token>;
}

function asInternals(payments: PaymentsModule): PaymentsModuleInternals {
  return payments as unknown as PaymentsModuleInternals;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule.load() coalesce guard (Issue #166 — P3 #6)', () => {
  let payments: PaymentsModule;

  beforeEach(() => {
    vi.clearAllMocks();
    payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: { recoveryWorker: false, finalizationWorker: false },
    });
  });

  it('coalesces two concurrent load() calls into a single doLoad invocation', async () => {
    const tokenStorage = createCountingTokenStorage({ delayFirstLoad: true });
    payments.initialize(createPaymentsDeps(tokenStorage));

    // Launch two concurrent loads — the first will gate on
    // firstLoadGate; the second must observe `loadedPromise !== null
    // && !loaded` and await the first.
    const p1 = payments.load();
    const p2 = payments.load();

    // Let the second call register itself on the in-flight promise.
    await new Promise((r) => setImmediate(r));

    // Sanity: both calls are pending; provider.load called exactly
    // once so far (delayed-first-load is the only inflight call).
    expect(tokenStorage.loadCallCount()).toBe(1);

    // Resolve the first load, then await both.
    tokenStorage.resolveFirstLoad?.();
    await Promise.all([p1, p2]);

    // After both calls resolve, provider.load() was called ONCE — the
    // second invocation coalesced onto the first promise.
    expect(tokenStorage.loadCallCount()).toBe(1);
  });

  it('coalesces three concurrent load() calls into one doLoad invocation', async () => {
    const tokenStorage = createCountingTokenStorage({ delayFirstLoad: true });
    payments.initialize(createPaymentsDeps(tokenStorage));

    const calls = [payments.load(), payments.load(), payments.load()];
    await new Promise((r) => setImmediate(r));
    expect(tokenStorage.loadCallCount()).toBe(1);

    tokenStorage.resolveFirstLoad?.();
    await Promise.all(calls);
    expect(tokenStorage.loadCallCount()).toBe(1);
  });

  it('does NOT coalesce sequential load() calls (refresh contract preserved)', async () => {
    const tokenStorage = createCountingTokenStorage();
    payments.initialize(createPaymentsDeps(tokenStorage));

    // First call completes fully.
    await payments.load();
    expect(tokenStorage.loadCallCount()).toBe(1);

    // Second sequential call should re-run doLoad — the guard at
    // lines 2716-2719 only triggers when `loadedPromise !== null &&
    // !loaded`. After the first call, loaded=true so subsequent
    // calls fall through.
    await payments.load();
    expect(tokenStorage.loadCallCount()).toBe(2);
  });

  it('coalesces the post-load orphan sweep emission to ONE event for concurrent loads', async () => {
    // The load-bearing reason for the coalesce: prevent duplicate
    // `transfer:orphan-spending-detected` events from the
    // fire-and-forget sweep at PaymentsModule.ts:2901-2929.
    const tokenStorage = createCountingTokenStorage({ delayFirstLoad: true });
    const deps = createPaymentsDeps(tokenStorage);
    const emitSpy = vi.fn();
    deps.emitEvent = emitSpy;
    payments.initialize(deps);

    // Install writers so the sweep is NOT skipped at the writer-null
    // check. Then seed a transferring token that is NOT covered by
    // OUTBOX or SENT — it'll be flagged as an orphan on every sweep.
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    asInternals(payments).tokens.set('orphan-1', makeToken('orphan-1', 'transferring'));

    // Two concurrent loads.
    const p1 = payments.load();
    const p2 = payments.load();
    await new Promise((r) => setImmediate(r));
    tokenStorage.resolveFirstLoad?.();
    await Promise.all([p1, p2]);

    // The sweep is fire-and-forget; await one extra tick so the
    // post-load .then() runs.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const orphanEvents = emitSpy.mock.calls.filter(
      (call) => call[0] === 'transfer:orphan-spending-detected',
    );
    // Exactly one event for the single orphan, fired by the single
    // post-load sweep — NOT two events from duplicate sweeps.
    expect(orphanEvents).toHaveLength(1);
    expect((orphanEvents[0][1] as { tokenId: string }).tokenId).toBe('orphan-1');
  });
});
