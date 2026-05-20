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
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
      },
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

// ===========================================================================
// Issue #166 P2 #1 — orphanAutoRecovery feature flag + default closure
// ===========================================================================

describe('PaymentsModule.detectOrphanSpendingTokens — orphanAutoRecovery (Issue #166 P2 #1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explicit OFF: features.orphanAutoRecovery=false → no attemptRecovery wired (Phase-1 behavior preserved)', async () => {
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      // OUTBOX-SEND-FOLLOWUPS item #5 flipped this flag default-ON
      // (PR #N, branch `feat/orphan-auto-recovery-default-on`). To
      // exercise the legacy Phase-1 detect-only behavior, explicit
      // `false` is now required. The test name was updated from
      // "default-OFF" to "explicit OFF" to reflect the post-flip
      // semantics.
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        orphanAutoRecovery: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
      },
    });
    payments.initialize({ ...createPaymentsDeps(), emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    asInternals(payments).tokens.set(
      'orphan-A',
      makeToken('orphan-A', 'transferring'),
    );

    const result = await payments.detectOrphanSpendingTokens();

    expect(result.orphans).toHaveLength(1);
    expect(result.recoveredCount).toBe(0);
    expect(result.manualCount).toBe(1);
    // Token status unchanged — Phase-1 behavior is detect-only.
    expect(asInternals(payments).tokens.get('orphan-A')?.status).toBe(
      'transferring',
    );
    // Phase-1 detected event fired; recovered event did NOT.
    const types = emit.mock.calls.map((c) => c[0]);
    expect(types).toContain('transfer:orphan-spending-detected');
    expect(types).not.toContain('transfer:orphan-recovered');
  });

  it('flag ON + orphan present → restores status to "confirmed", fires orphan-recovered event', async () => {
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    payments.initialize({ ...createPaymentsDeps(), emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    asInternals(payments).tokens.set(
      'orphan-B',
      makeToken('orphan-B', 'transferring', {
        coinId: 'UCT',
        amount: '500',
        // OUTBOX-SEND-FOLLOWUPS item #1: defaultOrphanRecovery now
        // extracts a state hash from sdkData and cross-checks the
        // aggregator before restoring. The stub oracle defaults to
        // isSpent=false (see createStubOracle), so providing any
        // parseable stateHash is sufficient to reach the restore path.
        sdkData: JSON.stringify({ stateHash: 'abcd1234' }),
      }),
    );

    const result = await payments.detectOrphanSpendingTokens();

    expect(result.orphans).toHaveLength(1);
    expect(result.recoveredCount).toBe(1);
    expect(result.manualCount).toBe(0);
    expect(asInternals(payments).tokens.get('orphan-B')?.status).toBe(
      'confirmed',
    );

    const recoveredEmits = emit.mock.calls.filter(
      (c) => c[0] === 'transfer:orphan-recovered',
    );
    expect(recoveredEmits).toHaveLength(1);
    const payload = recoveredEmits[0][1] as {
      tokenId: string;
      coinId: string;
      amount: string;
      fromStatus: string;
      toStatus: string;
      strategy: string;
    };
    expect(payload.tokenId).toBe('orphan-B');
    expect(payload.coinId).toBe('UCT');
    expect(payload.amount).toBe('500');
    expect(payload.fromStatus).toBe('transferring');
    expect(payload.toStatus).toBe('confirmed');
    expect(payload.strategy).toBe('restore-to-confirmed');

    // The Phase-1 detected event must NOT also fire for the same orphan.
    const detectedEmits = emit.mock.calls.filter(
      (c) => c[0] === 'transfer:orphan-spending-detected',
    );
    expect(detectedEmits).toHaveLength(0);
  });

  it("flag ON but token removed from this.tokens between detection and recovery → 'manual'", async () => {
    // Race scenario: detection finds the orphan, then before the
    // recovery closure runs, the token is removed (e.g. by a
    // concurrent split-removal path). The closure must NOT throw
    // and must fall back to Phase-1 behavior.
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    payments.initialize({ ...createPaymentsDeps(), emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);

    // No token in this.tokens, but call the closure directly to
    // simulate the race. We can't easily race "between detection and
    // recovery" in a synchronous unit test, so test the defensive
    // 'manual' path directly via the internal closure.
    const internals = payments as unknown as {
      defaultOrphanRecovery: (finding: {
        tokenId: string;
        coinId: string;
        amount: string;
        lastUpdatedAt: number;
        detectedAt: number;
      }) => Promise<'recovered' | 'manual'>;
    };
    const outcome = await internals.defaultOrphanRecovery({
      tokenId: 'ghost',
      coinId: 'UCT',
      amount: '100',
      lastUpdatedAt: 0,
      detectedAt: 0,
    });
    expect(outcome).toBe('manual');
  });

  it("flag ON + token already in non-'transferring' status → 'manual' (defense against race)", async () => {
    // Race scenario: by the time the recovery closure runs, the
    // dispatcher's Loop1-S9 has already restored the token to
    // 'confirmed'. The closure must NOT double-restore (idempotent)
    // and must NOT emit recovered (the dispatcher already did the work).
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    payments.initialize({ ...createPaymentsDeps(), emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    // Token exists but is already 'confirmed' (not 'transferring').
    asInternals(payments).tokens.set(
      'orphan-already-restored',
      makeToken('orphan-already-restored', 'confirmed'),
    );

    const internals = payments as unknown as {
      defaultOrphanRecovery: (finding: {
        tokenId: string;
        coinId: string;
        amount: string;
        lastUpdatedAt: number;
        detectedAt: number;
      }) => Promise<'recovered' | 'manual'>;
    };
    const outcome = await internals.defaultOrphanRecovery({
      tokenId: 'orphan-already-restored',
      coinId: 'UCT',
      amount: '100',
      lastUpdatedAt: 0,
      detectedAt: 0,
    });
    expect(outcome).toBe('manual');
    // Status unchanged — the dispatcher's restore wins.
    expect(
      asInternals(payments).tokens.get('orphan-already-restored')?.status,
    ).toBe('confirmed');
  });
});

// ===========================================================================
// OUTBOX-SEND-FOLLOWUPS item #1 — aggregator cross-check before restore
// ===========================================================================
//
// Before flipping a transferring token's status to 'confirmed',
// defaultOrphanRecovery must verify with the aggregator that the
// spending commit never landed. The cross-check has four branches:
//
//   1. aggregator.isSpent(stateHash) === false → safe to restore.
//      Covered by the "flag ON + orphan present" happy-path test above
//      (which now provides sdkData with a stateHash and relies on the
//      stub oracle's default isSpent=false).
//   2. aggregator.isSpent(stateHash) === true → unsafe; the commit
//      landed and a local restore would diverge from the aggregator.
//      Escalate to 'manual'.
//   3. oracle.isSpent throws → fail-closed; we cannot rule out the
//      spent case. Escalate to 'manual'.
//   4. token has no parseable stateHash on sdkData → fail-closed; we
//      cannot perform the cross-check at all. Escalate to 'manual'.
//
// All four manual paths must NOT mutate the token's status and must
// NOT call this.save(). The happy-path test verifies the positive
// branch; the three below cover (2), (3), and (4).

interface DefaultOrphanRecoveryInternals {
  defaultOrphanRecovery: (finding: {
    tokenId: string;
    coinId: string;
    amount: string;
    lastUpdatedAt: number;
    detectedAt: number;
  }) => Promise<'recovered' | 'manual'>;
  save: () => Promise<void>;
  deps: { oracle: { isSpent: ReturnType<typeof vi.fn> } };
}

describe('defaultOrphanRecovery — aggregator cross-check (OUTBOX-SEND-FOLLOWUPS item #1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregator reports source state spent → 'manual', token left in 'transferring', save() NOT called", async () => {
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    const deps = createPaymentsDeps();
    // Override the oracle's isSpent to report SPENT — simulates the
    // unsafe race where the spending commit landed but the OUTBOX
    // write crashed after.
    (deps.oracle as unknown as { isSpent: ReturnType<typeof vi.fn> }).isSpent =
      vi.fn().mockResolvedValue(true);
    payments.initialize({ ...deps, emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    asInternals(payments).tokens.set(
      'orphan-spent-on-agg',
      makeToken('orphan-spent-on-agg', 'transferring', {
        sdkData: JSON.stringify({ stateHash: 'aabbccdd' }),
      }),
    );

    // Spy save so we can assert it was not called on the manual path.
    const internals = payments as unknown as DefaultOrphanRecoveryInternals;
    const saveSpy = vi.spyOn(internals, 'save').mockResolvedValue();

    const outcome = await internals.defaultOrphanRecovery({
      tokenId: 'orphan-spent-on-agg',
      coinId: 'UCT',
      amount: '100',
      lastUpdatedAt: 0,
      detectedAt: 0,
    });

    expect(outcome).toBe('manual');
    expect(internals.deps.oracle.isSpent).toHaveBeenCalledWith('aabbccdd');
    expect(saveSpy).not.toHaveBeenCalled();
    // Token status untouched.
    expect(
      asInternals(payments).tokens.get('orphan-spent-on-agg')?.status,
    ).toBe('transferring');
  });

  it("oracle.isSpent throws → 'manual' (fail-closed), token left in 'transferring', save() NOT called", async () => {
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    const deps = createPaymentsDeps();
    (deps.oracle as unknown as { isSpent: ReturnType<typeof vi.fn> }).isSpent =
      vi.fn().mockRejectedValue(new Error('aggregator RPC unreachable'));
    payments.initialize({ ...deps, emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    asInternals(payments).tokens.set(
      'orphan-rpc-error',
      makeToken('orphan-rpc-error', 'transferring', {
        sdkData: JSON.stringify({ stateHash: '99887766' }),
      }),
    );

    const internals = payments as unknown as DefaultOrphanRecoveryInternals;
    const saveSpy = vi.spyOn(internals, 'save').mockResolvedValue();

    const outcome = await internals.defaultOrphanRecovery({
      tokenId: 'orphan-rpc-error',
      coinId: 'UCT',
      amount: '100',
      lastUpdatedAt: 0,
      detectedAt: 0,
    });

    expect(outcome).toBe('manual');
    expect(internals.deps.oracle.isSpent).toHaveBeenCalledWith('99887766');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(asInternals(payments).tokens.get('orphan-rpc-error')?.status).toBe(
      'transferring',
    );
  });

  it("token has no parseable stateHash → 'manual' (cannot cross-check), save() and oracle NOT called", async () => {
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    const deps = createPaymentsDeps();
    payments.initialize({ ...deps, emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    // Token has no sdkData → extractStateHashFromSdkData returns ''.
    asInternals(payments).tokens.set(
      'orphan-no-state-hash',
      makeToken('orphan-no-state-hash', 'transferring'),
    );

    const internals = payments as unknown as DefaultOrphanRecoveryInternals;
    const saveSpy = vi.spyOn(internals, 'save').mockResolvedValue();

    const outcome = await internals.defaultOrphanRecovery({
      tokenId: 'orphan-no-state-hash',
      coinId: 'UCT',
      amount: '100',
      lastUpdatedAt: 0,
      detectedAt: 0,
    });

    expect(outcome).toBe('manual');
    // Cross-check is skipped entirely — never reaches the aggregator.
    expect(internals.deps.oracle.isSpent).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(
      asInternals(payments).tokens.get('orphan-no-state-hash')?.status,
    ).toBe('transferring');
  });

  it("aggregator reports unspent + stateHash present → 'recovered', save() called once", async () => {
    // Mirror of the happy-path test in the wrapper describe block, but
    // calling defaultOrphanRecovery directly so we can assert the
    // oracle and save call sites precisely.
    const emit = vi.fn();
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        nostrPersistenceVerifier: false,
        tombstoneGcWorker: false,
        orphanAutoRecovery: true,
      },
    });
    const deps = createPaymentsDeps();
    // Stub default is isSpent → false; make it explicit here so the
    // assertion below has a stable call-arg expectation.
    (deps.oracle as unknown as { isSpent: ReturnType<typeof vi.fn> }).isSpent =
      vi.fn().mockResolvedValue(false);
    payments.initialize({ ...deps, emitEvent: emit });
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);
    asInternals(payments).tokens.set(
      'orphan-safe',
      makeToken('orphan-safe', 'transferring', {
        sdkData: JSON.stringify({ stateHash: '11223344' }),
      }),
    );

    const internals = payments as unknown as DefaultOrphanRecoveryInternals;
    const saveSpy = vi.spyOn(internals, 'save').mockResolvedValue();

    const outcome = await internals.defaultOrphanRecovery({
      tokenId: 'orphan-safe',
      coinId: 'UCT',
      amount: '100',
      lastUpdatedAt: 0,
      detectedAt: 0,
    });

    expect(outcome).toBe('recovered');
    expect(internals.deps.oracle.isSpent).toHaveBeenCalledWith('11223344');
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(asInternals(payments).tokens.get('orphan-safe')?.status).toBe(
      'confirmed',
    );
  });
});
