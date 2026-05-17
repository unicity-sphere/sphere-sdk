/**
 * Tests for `PaymentsModule.detectOrphanSpendingTokens()` — the
 * wrapper that threads `_dispatcherInFlightCount` into the pure
 * `sweepOrphanSpendingTokens` function (Issue #166 P3 #8).
 *
 * **What this file covers (vs. what's already covered)**:
 *   - `tests/unit/modules/payments/orphan-spending-sweeper.test.ts`
 *     tests the PURE FUNCTION `sweepOrphanSpendingTokens` directly,
 *     including the `dispatcherInFlightCount` parameter on the deps
 *     bag.
 *   - THIS file tests that the PaymentsModule WRAPPER correctly
 *     threads `this._dispatcherInFlightCount` (the live counter
 *     incremented by the three `dispatch*` methods around lines
 *     3996/4017/4036) into the deps bag. A regression in the wrapper
 *     would expose stale or zero counts to the sweeper, defeating
 *     the steelman item 2 guard.
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
  createStubTokenStorageProvider,
  createStubTransport,
  createTestIdentity,
  createWriterPair,
  makeToken,
} from './__fixtures__/payments-module-fixture';
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
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPaymentsDeps(): PaymentsModuleDependencies {
  const providers = new Map<
    string,
    ReturnType<typeof createStubTokenStorageProvider>
  >();
  providers.set('main', createStubTokenStorageProvider());
  return {
    identity: createTestIdentity(),
    storage: createStubStorageProvider(),
    tokenStorageProviders: providers,
    transport: createStubTransport(),
    oracle: createStubOracle(),
    emitEvent: vi.fn(),
  };
}

interface PaymentsModuleInternals {
  tokens: Map<string, Token>;
  _dispatcherInFlightCount: number;
}

function asInternals(payments: PaymentsModule): PaymentsModuleInternals {
  return payments as unknown as PaymentsModuleInternals;
}

function seedOrphanToken(payments: PaymentsModule, id: string): void {
  // The sweeper iterates `this.tokens.values()` — inject directly into
  // the Map so we don't trigger save/sync side-effects of addToken().
  asInternals(payments).tokens.set(id, makeToken(id, 'transferring'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule.detectOrphanSpendingTokens (Issue #166 — P3 #8)', () => {
  let payments: PaymentsModule;

  beforeEach(() => {
    vi.clearAllMocks();
    payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: { recoveryWorker: false, finalizationWorker: false },
    });
    payments.initialize(createPaymentsDeps());
  });

  it('skips when either writer is null (delegates to sweeper, no PaymentsModule-specific guard)', async () => {
    // No installOutboxWriter / installSentLedgerWriter — both null.
    seedOrphanToken(payments, 'orphan-1');
    const result = await payments.detectOrphanSpendingTokens();
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
  });

  it('detects orphans when both writers are installed and inflight count is 0', async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    seedOrphanToken(payments, 'orphan-1');

    const result = await payments.detectOrphanSpendingTokens();

    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(1);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].tokenId).toBe('orphan-1');
  });

  it('threads _dispatcherInFlightCount > 0 into the sweeper (self-skip gate active)', async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    seedOrphanToken(payments, 'orphan-during-send');

    // Simulate a dispatcher in flight by bumping the counter directly.
    // In production, the three `dispatch*` methods increment this at
    // entry and decrement in `finally` (PaymentsModule.ts:3996/4017/4036).
    asInternals(payments)._dispatcherInFlightCount = 1;

    const result = await payments.detectOrphanSpendingTokens();

    // The sweep self-skips with count > 0 — no false-positive orphan
    // events while a legitimate send is mid-flight.
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
    // scannedTransferringCount must be 0 — the sweeper returns early
    // BEFORE counting any 'transferring' tokens.
    expect(result.scannedTransferringCount).toBe(0);
  });

  it('threads multi-dispatcher count correctly (count > 1 also skips)', async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    seedOrphanToken(payments, 'orphan-during-multi-send');

    asInternals(payments)._dispatcherInFlightCount = 5;

    const result = await payments.detectOrphanSpendingTokens();
    expect(result.skipped).toBe(true);
  });

  it('resumes detection after _dispatcherInFlightCount returns to 0 (live count, not snapshot)', async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    seedOrphanToken(payments, 'orphan-resumed');

    // First call with count > 0 → skip.
    asInternals(payments)._dispatcherInFlightCount = 1;
    const skipped = await payments.detectOrphanSpendingTokens();
    expect(skipped.skipped).toBe(true);

    // Simulate dispatch completion: counter decremented.
    asInternals(payments)._dispatcherInFlightCount = 0;
    const detected = await payments.detectOrphanSpendingTokens();
    expect(detected.skipped).toBe(false);
    expect(detected.orphans).toHaveLength(1);
    expect(detected.orphans[0].tokenId).toBe('orphan-resumed');
  });

  it('passes this.tokens.values() — wrapper does not snapshot tokens up-front', async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);

    // Empty tokens → no orphans detected.
    const empty = await payments.detectOrphanSpendingTokens();
    expect(empty.scannedTransferringCount).toBe(0);

    // Add a transferring token AFTER the first call. The wrapper reads
    // this.tokens.values() at call time, not at PaymentsModule
    // construction — so the next call must see the new token.
    seedOrphanToken(payments, 'late-orphan');
    const detected = await payments.detectOrphanSpendingTokens();
    expect(detected.scannedTransferringCount).toBe(1);
    expect(detected.orphans[0].tokenId).toBe('late-orphan');
  });
});
