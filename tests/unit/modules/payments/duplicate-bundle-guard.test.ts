/**
 * Tests for the `assertNoDuplicateBundleMembership` helper in
 * PaymentsModule.
 *
 * **History.** Originally Issue #166 P2 #2 (the guard's introduction).
 * Reworked under issue #391 — the guard now compares new source
 * candidates against each OUTBOX entry's `sourceTokenIds` set, NOT its
 * `tokenIds` (recipient mint-output) set. The pre-#391 comparison was a
 * category error: it never caught a real double-spend AND false-
 * positived on legitimate round-trips (alice → bob → alice). The SENT
 * branch was removed for the same reason (`UxfSentLedgerEntry` has no
 * source field).
 *
 * **Why this file exists.** The guard is the single load-bearing site
 * for the duplicate-bundle check called from THREE dispatcher
 * `selectSources` callbacks (conservative, instant, txf). The
 * dispatcher arms are 1000+ lines each; testing them end-to-end requires
 * thousands of lines of orchestrator scaffolding. Instead, this file
 * pins the helper contract directly so a regression in any of the
 * three call sites is caught by the unchanged contract.
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
  makeOutboxEntry,
} from './__fixtures__/payments-module-fixture';
import type { OutboxWriter } from '../../../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../../../profile/sent-ledger-writer';
import { isSphereError } from '../../../../core/errors';

// ---------------------------------------------------------------------------
// SDK mocks (mirrors write-sent-entry-helper.test.ts)
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
  const tokenStorage = createStubTokenStorageProvider();
  const providers = new Map<
    string,
    ReturnType<typeof createStubTokenStorageProvider>
  >();
  providers.set('main', tokenStorage);
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
  assertNoDuplicateBundleMembership(
    candidateTokenIds: ReadonlyArray<string>,
    options: { readonly opLabel: string; readonly allowOverride: boolean },
  ): Promise<void>;
}

function asInternals(payments: PaymentsModule): PaymentsModuleInternals {
  return payments as unknown as PaymentsModuleInternals;
}

function makePaymentsWithWriters(): {
  payments: PaymentsModule;
  outboxWriter: OutboxWriter;
  sentLedgerWriter: SentLedgerWriter;
} {
  const payments = createPaymentsModule({
    debug: false,
    autoSync: false,
    features: {
      recoveryWorker: false,
      finalizationWorker: false,
      sentReconciliationWorker: false,
    },
  });
  payments.initialize(createPaymentsDeps());
  const { outboxWriter, sentLedgerWriter } = createWriterPair();
  payments.installOutboxWriter(outboxWriter);
  payments.installSentLedgerWriter(sentLedgerWriter);
  return { payments, outboxWriter, sentLedgerWriter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assertNoDuplicateBundleMembership (Issue #166 P2 #2, reworked under #391)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // No-op paths
  // -------------------------------------------------------------------------

  it('is a no-op when allowOverride is true (even if a real source duplicate exists)', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write({
      ...makeOutboxEntry({
        id: 'live',
        sourceTokenIds: ['tok-A'],
        status: 'sending',
      }),
    });

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when OUTBOX writer is uninstalled (legacy-only wallet)', async () => {
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        sentReconciliationWorker: false,
      },
    });
    payments.initialize(createPaymentsDeps());
    // Install ONLY the SENT writer, NOT the OUTBOX writer.
    const { sentLedgerWriter } = createWriterPair();
    payments.installSentLedgerWriter(sentLedgerWriter);

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when SENT writer is uninstalled (#391 — SENT is no longer required for the guard)', async () => {
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        recoveryWorker: false,
        finalizationWorker: false,
        sentReconciliationWorker: false,
      },
    });
    payments.initialize(createPaymentsDeps());
    // Install ONLY the OUTBOX writer. Pre-#391 the guard required BOTH
    // writers and silently skipped; post-#391 the OUTBOX writer alone
    // is sufficient AND the guard still fires on a real source dup.
    const { outboxWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);

    await outboxWriter.write(
      makeOutboxEntry({
        id: 'in-flight',
        sourceTokenIds: ['tok-A'],
        status: 'sending',
      }),
    );

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).rejects.toThrow('OUTBOX entry');
  });

  it('is a no-op when candidateTokenIds is empty', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write(
      makeOutboxEntry({ id: 'live', sourceTokenIds: ['tok-A'] }),
    );

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership([], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Clean selection
  // -------------------------------------------------------------------------

  it('passes silently when no candidate is in any OUTBOX entry sourceTokenIds set', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write(
      makeOutboxEntry({ id: 'in-flight', sourceTokenIds: ['tok-X'] }),
    );

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A', 'tok-B'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rejection path — the load-bearing arc (#391 invariant)
  // -------------------------------------------------------------------------

  it('throws DUPLICATE_BUNDLE_MEMBERSHIP when a candidate matches a sourceTokenIds entry in OUTBOX', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write(
      makeOutboxEntry({
        id: 'in-flight',
        sourceTokenIds: ['tok-A', 'tok-B'],
        status: 'sending',
      }),
    );

    let caught: unknown;
    try {
      await asInternals(payments).assertNoDuplicateBundleMembership(
        ['tok-C', 'tok-A'],
        { opLabel: 'dispatchUxfConservativeSend', allowOverride: false },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isSphereError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('DUPLICATE_BUNDLE_MEMBERSHIP');
    const message = (caught as Error).message;
    expect(message).toContain('tok-A');
    expect(message).toContain('OUTBOX entry');
    expect(message).toContain('in-flight');
    expect(message).toContain('sending');
    expect(message).toContain('dispatchUxfConservativeSend');
    expect(message).toContain('allowDuplicateBundleMembership');
  });

  // -------------------------------------------------------------------------
  // Issue #391 — round-trip false-positive avoidance.
  // -------------------------------------------------------------------------

  it('#391 — does NOT throw when candidate matches a past entry tokenIds (recipient) but NOT sourceTokenIds', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    // Scenario from the issue:
    //   - bob's prior 2-UCT send to alice. OUTBOX entry's `tokenIds`
    //     carries the RECIPIENT genesis tokenIds (alice's mint output
    //     'round-trip-A'). `sourceTokenIds` carries bob's burned source
    //     ('bob-original-10').
    //   - Later, alice transfers the same token back to bob (whole-token).
    //     bob now legitimately owns 'round-trip-A' and tries to send it
    //     onward.
    //
    // Pre-#391 the guard compared candidates against `tokenIds` and
    // false-positived ('round-trip-A' matches the past recipient set).
    // Post-#391 it compares against `sourceTokenIds` and lets the legal
    // round-trip through.
    await outboxWriter.write(
      makeOutboxEntry({
        id: 'old-2uct-send',
        tokenIds: ['round-trip-A'],
        sourceTokenIds: ['bob-original-10'],
        status: 'delivered-instant',
      }),
    );

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(
        ['round-trip-A'],
        { opLabel: 'dispatchUxfInstantSend', allowOverride: false },
      ),
    ).resolves.toBeUndefined();
  });

  it('#391 — does NOT throw when a SENT entry carries the candidate id in tokenIds (SENT no longer participates)', async () => {
    const { payments, sentLedgerWriter } = makePaymentsWithWriters();
    // SENT records the recipient mint-output as `tokenIds`. Pre-#391
    // the guard rejected any candidate that matched it. Post-#391 the
    // SENT branch is removed entirely (the schema has no source field).
    await sentLedgerWriter.write({
      id: 'past-delivery',
      tokenIds: ['round-trip-A'],
      bundleCid: 'bafy-A',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['round-trip-A'], {
        opLabel: 'dispatchUxfInstantSend',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Back-compat — pre-H5 entries lack sourceTokenIds and are silently skipped
  // -------------------------------------------------------------------------

  it('treats pre-H5 OUTBOX entries (no sourceTokenIds) as empty source set', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    // Plant a pre-H5-shape entry — explicitly clear sourceTokenIds.
    const entry = makeOutboxEntry({
      id: 'pre-h5',
      tokenIds: ['some-recipient-token'],
      status: 'delivered-instant',
    });
    // Avoid reaching into the type contract — strip the field at the
    // raw shape (some test fixtures never set it; this just makes the
    // intent explicit when reading the test).
    const { sourceTokenIds: _drop, ...preH5 } = {
      ...entry,
      sourceTokenIds: undefined,
    };
    void _drop;
    await outboxWriter.write(preH5 as typeof entry);

    // No source side to compare against — candidate passes through.
    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(
        ['some-recipient-token'],
        { opLabel: 'test', allowOverride: false },
      ),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Read-failure semantics (best-effort safety contract)
  // -------------------------------------------------------------------------

  it('proceeds without throwing when OUTBOX readAllNew throws (best-effort guard)', async () => {
    const { payments } = makePaymentsWithWriters();
    // Replace the OUTBOX writer with one that throws on read.
    const throwingOutbox = {
      readAllNew: vi.fn().mockRejectedValue(new Error('orbitdb-down')),
    } as unknown as OutboxWriter;
    payments.installOutboxWriter(throwingOutbox);

    // The OUTBOX read throws → guard warns + skips. Without OUTBOX the
    // guard cannot check anything (SENT has no source field). Resolves
    // without throwing; the `'transferring'`-status planner filter is
    // the load-bearing defense.
    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
    expect(throwingOutbox.readAllNew).toHaveBeenCalled();
  });

  it('is best-effort: tombstoned OUTBOX entries are NOT counted (readAllNew skips them)', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write(
      makeOutboxEntry({ id: 'gone', sourceTokenIds: ['tok-A'] }),
    );
    await outboxWriter.delete('gone');

    // Candidate tok-A overlaps a TOMBSTONED entry's source set — guard
    // should NOT throw because the entry is no longer live.
    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Override flag interaction
  // -------------------------------------------------------------------------

  it('override bypasses the guard even when a real source duplicate exists', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write(
      makeOutboxEntry({ id: 'live', sourceTokenIds: ['tok-DUP'] }),
    );

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-DUP'], {
        opLabel: 'test',
        allowOverride: true,
      }),
    ).resolves.toBeUndefined();
  });
});
