/**
 * Tests for the `assertNoDuplicateBundleMembership` helper in
 * PaymentsModule (Issue #166 P2 #2 — duplicate-bundle guard).
 *
 * **Why this file exists.** The guard is the single load-bearing site
 * for the duplicate-bundle check called from THREE dispatcher
 * `selectSources` callbacks (conservative, instant, txf). The
 * dispatcher arms are 1000+ lines each; testing them end-to-end requires
 * thousands of lines of orchestrator scaffolding. Instead, this file
 * pins the helper contract directly so a regression in any of the
 * three call sites is caught by the unchanged contract.
 *
 * The dispatcher-level wiring (call the helper BEFORE marking sources
 * as `'transferring'` so a throw leaves sources in their original
 * status) is structural plumbing on top of this helper — the helper
 * IS the load-bearing arc.
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

describe('assertNoDuplicateBundleMembership (Issue #166 P2 #2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // No-op paths
  // -------------------------------------------------------------------------

  it('is a no-op when allowOverride is true (even if duplicates exist)', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    // Plant a duplicate entry — should be ignored on override.
    await outboxWriter.write({
      ...makeOutboxEntry({ id: 'live', tokenIds: ['tok-A'], status: 'sending' }),
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

  it('is a no-op when SENT writer is uninstalled (legacy-only wallet)', async () => {
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
    // Install ONLY the OUTBOX writer.
    const { outboxWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when candidateTokenIds is empty', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    // Plant something so the OUTBOX read would otherwise find data.
    await outboxWriter.write(makeOutboxEntry({ id: 'live', tokenIds: ['tok-A'] }));

    // An empty candidate list short-circuits BEFORE reading — but even if
    // it did read, an empty set has no intersection.
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

  it('passes silently when no candidate is in OUTBOX or SENT', async () => {
    const { payments, outboxWriter, sentLedgerWriter } = makePaymentsWithWriters();
    // OUTBOX has tok-X, SENT has tok-Y. We're sending tok-A and tok-B.
    await outboxWriter.write(makeOutboxEntry({ id: 'in-flight', tokenIds: ['tok-X'] }));
    await sentLedgerWriter.write({
      id: 'delivered',
      tokenIds: ['tok-Y'],
      bundleCid: 'bafy-Y',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A', 'tok-B'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rejection paths
  // -------------------------------------------------------------------------

  it('throws DUPLICATE_BUNDLE_MEMBERSHIP when a candidate is in a live OUTBOX entry', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    await outboxWriter.write(
      makeOutboxEntry({
        id: 'in-flight',
        tokenIds: ['tok-A', 'tok-B'],
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

  it('throws DUPLICATE_BUNDLE_MEMBERSHIP when a candidate is in SENT', async () => {
    const { payments, sentLedgerWriter } = makePaymentsWithWriters();
    await sentLedgerWriter.write({
      id: 'past-delivery',
      tokenIds: ['tok-A'],
      bundleCid: 'bafy-A',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    let caught: unknown;
    try {
      await asInternals(payments).assertNoDuplicateBundleMembership(
        ['tok-A'],
        { opLabel: 'dispatchUxfInstantSend', allowOverride: false },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isSphereError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('DUPLICATE_BUNDLE_MEMBERSHIP');
    const message = (caught as Error).message;
    expect(message).toContain('tok-A');
    expect(message).toContain('SENT ledger entry');
    expect(message).toContain('past-delivery');
    expect(message).toContain('dispatchUxfInstantSend');
  });

  it('checks OUTBOX before SENT (more diagnostic value for operator triage)', async () => {
    const { payments, outboxWriter, sentLedgerWriter } = makePaymentsWithWriters();
    // The same tokenId is in BOTH writers — guard should report OUTBOX
    // first, not SENT, because "still in flight" is more actionable for
    // operator triage than "already delivered."
    await outboxWriter.write(
      makeOutboxEntry({
        id: 'in-flight',
        tokenIds: ['tok-DUP'],
        status: 'sending',
      }),
    );
    await sentLedgerWriter.write({
      id: 'past-delivery',
      tokenIds: ['tok-DUP'],
      bundleCid: 'bafy-DUP',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    let caught: unknown;
    try {
      await asInternals(payments).assertNoDuplicateBundleMembership(['tok-DUP'], {
        opLabel: 'test',
        allowOverride: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const message = (caught as Error).message;
    // OUTBOX wins the diagnostic — the message mentions OUTBOX, not SENT.
    expect(message).toContain('OUTBOX entry');
    expect(message).not.toContain('SENT ledger entry');
    expect(message).toContain('in-flight');
    expect(message).not.toContain('past-delivery');
  });

  // -------------------------------------------------------------------------
  // Read-failure semantics (best-effort safety contract)
  // -------------------------------------------------------------------------

  it('proceeds without OUTBOX check when readAllNew throws; SENT check still attempted', async () => {
    const { payments, sentLedgerWriter } = makePaymentsWithWriters();
    // Replace the OUTBOX writer with one that throws on read.
    const throwingOutbox = {
      readAllNew: vi.fn().mockRejectedValue(new Error('orbitdb-down')),
    } as unknown as OutboxWriter;
    payments.installOutboxWriter(throwingOutbox);
    // SENT writer is healthy and contains the duplicate.
    await sentLedgerWriter.write({
      id: 'past-delivery',
      tokenIds: ['tok-DUP'],
      bundleCid: 'bafy-DUP',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    // The OUTBOX read throws, so the guard skips that branch and
    // proceeds to SENT — which catches the duplicate.
    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-DUP'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).rejects.toThrow('SENT ledger entry');
    // The throwing OUTBOX may be called more than once because
    // `installOutboxWriter` ALSO triggers a fire-and-forget hydration
    // read on install — both calls return rejection, both logged. The
    // load-bearing assertion is that we reached the SENT check (the
    // rejects.toThrow above) despite the OUTBOX read failure.
    expect(throwingOutbox.readAllNew).toHaveBeenCalled();
  });

  it('proceeds without SENT check when readAll throws; OUTBOX check still authoritative', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    // Replace SENT with a throwing writer.
    const throwingSent = {
      readAll: vi.fn().mockRejectedValue(new Error('orbitdb-down')),
    } as unknown as SentLedgerWriter;
    payments.installSentLedgerWriter(throwingSent);
    // OUTBOX is clean: no duplicate.
    await outboxWriter.write(makeOutboxEntry({ id: 'live', tokenIds: ['tok-X'] }));

    // Guard reads OUTBOX (clean), tries SENT (throws → warn-and-skip),
    // returns without throwing. The candidate may legitimately
    // duplicate a SENT entry we couldn't read — that's the trade-off:
    // a transient read failure should NOT block legitimate sends.
    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
    expect(throwingSent.readAll).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: tombstoned OUTBOX entries are NOT counted (readAllNew skips them)', async () => {
    const { payments, outboxWriter } = makePaymentsWithWriters();
    // Write then delete (tombstone) — `readAllNew` filters these out.
    await outboxWriter.write(makeOutboxEntry({ id: 'gone', tokenIds: ['tok-A'] }));
    await outboxWriter.delete('gone');

    // Candidate tok-A overlaps a TOMBSTONED entry — guard should NOT
    // throw, because the entry is no longer live.
    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-A'], {
        opLabel: 'test',
        allowOverride: false,
      }),
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Override flag interaction with both writers populated
  // -------------------------------------------------------------------------

  it('override bypasses the guard even when duplicates exist in BOTH writers', async () => {
    const { payments, outboxWriter, sentLedgerWriter } = makePaymentsWithWriters();
    await outboxWriter.write(makeOutboxEntry({ id: 'live', tokenIds: ['tok-DUP'] }));
    await sentLedgerWriter.write({
      id: 'past',
      tokenIds: ['tok-DUP'],
      bundleCid: 'bafy',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    await expect(
      asInternals(payments).assertNoDuplicateBundleMembership(['tok-DUP'], {
        opLabel: 'test',
        allowOverride: true,
      }),
    ).resolves.toBeUndefined();
  });
});
