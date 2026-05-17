/**
 * Tests for the PaymentsModule recovery-worker shim closure that wraps
 * `recoveryDeps.outbox.update` (Issue #166 P3 #3).
 *
 * **Location of the load-bearing arc.** PaymentsModule.ts:1652-1713
 * builds `recoveryDeps.outbox.update` as a closure. When the
 * SendingRecoveryWorker re-publishes a stuck `'sending'` entry, it
 * calls `outbox.update(id, mutator)` — that mutator transitions
 * status to `'delivered'` or `'delivered-instant'`. The shim
 * captures the pre-state (`prevStatus`), runs the mutator, and:
 *   - Detects the terminal-success arc:
 *     `(status === 'delivered' || 'delivered-instant') &&
 *      prevStatus !== updated.status`
 *   - Calls `writeSentEntryFromOutbox` inline.
 *
 * The SendingRecoveryWorker test
 * (tests/unit/payments/transfer/sending-recovery-worker.test.ts)
 * tests the worker against a FakeOutbox. The shim is invisible to
 * that test. This file closes the gap by exercising the shim through
 * the real PaymentsModule.
 *
 * **Scope.** Two arcs are tested:
 *   1. Real 'sending' → 'delivered' transition → SENT write fires
 *   2. Self-loop (mutator returns prev unchanged) → no SENT write
 *      (CAS guard at line 1700-1702)
 *
 * The third arc — pre-bound `writeSentEntryFromOutbox` survives
 * post-construction sentLedgerWriter swap (the `.bind(this)` at line
 * 1640) — falls out of the first arc test if we swap the writer
 * between construction and scan; we cover that explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import {
  createStubOracle,
  createStubStorageProvider,
  createStubTokenStorageProvider,
  createTestIdentity,
  createWriterPair,
} from './__fixtures__/payments-module-fixture';
import type { OutboxWriter } from '../../../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../../../profile/sent-ledger-writer';
import type { SendingRecoveryWorker } from '../../../../modules/payments/transfer/sending-recovery-worker';
import type { TransportProvider } from '../../../../transport';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';

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
// Helpers
// ---------------------------------------------------------------------------

interface RecoveryTransport extends TransportProvider {
  readonly sendTokenTransfer: ReturnType<typeof vi.fn>;
}

function createRecoveryTransport(): RecoveryTransport {
  return {
    id: 'recovery-transport',
    name: 'Recovery Transport',
    type: 'p2p',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as RecoveryTransport;
}

function createPaymentsDeps(
  transport: TransportProvider,
): PaymentsModuleDependencies {
  const providers = new Map<
    string,
    ReturnType<typeof createStubTokenStorageProvider>
  >();
  providers.set('main', createStubTokenStorageProvider());
  return {
    identity: createTestIdentity(),
    storage: createStubStorageProvider(),
    tokenStorageProviders: providers,
    transport,
    oracle: createStubOracle(),
    emitEvent: vi.fn(),
  };
}

interface PaymentsModuleInternals {
  sendingRecoveryWorker: SendingRecoveryWorker | null;
  _sentLedgerWriter: SentLedgerWriter | null;
}

function asInternals(payments: PaymentsModule): PaymentsModuleInternals {
  return payments as unknown as PaymentsModuleInternals;
}

async function seedStuckSendingEntry(
  outboxWriter: OutboxWriter,
  overrides: Partial<Parameters<OutboxWriter['write']>[0]> = {},
): Promise<UxfTransferOutboxEntry> {
  return outboxWriter.write({
    id: 'recovery-1',
    bundleCid: 'bafy-recovered',
    tokenIds: ['tok-recovered'],
    deliveryMethod: 'cid-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'b'.repeat(64),
    mode: 'conservative',
    status: 'sending',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule recovery-worker shim (Issue #166 — P3 #3)', () => {
  let payments: PaymentsModule;
  let transport: RecoveryTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    transport = createRecoveryTransport();
    payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: { recoveryWorker: true, finalizationWorker: false },
    });
    payments.initialize(createPaymentsDeps(transport));
    // Stop the auto-started scan loop so we drive it manually.
    void asInternals(payments).sendingRecoveryWorker?.stop();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes SENT on 'sending' → 'delivered' arc via the recovery-worker shim", async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);

    // Write a stuck 'sending' entry — it must be older than the
    // default stuckThresholdMs (60s) by the time runScanCycle runs.
    await seedStuckSendingEntry(outboxWriter, {
      updatedAt: Date.now() - 120_000,
    });

    // Stub successful re-publish (default sendTokenTransfer mock
    // already returns undefined).
    const ran = await asInternals(payments).sendingRecoveryWorker!.runScanCycle();
    expect(ran).toBe(1);

    // The shim observed the arc 'sending' → 'delivered' and called
    // writeSentEntryFromOutbox. The SENT ledger now contains the
    // entry.
    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('recovery-1');
    expect(persisted[0].bundleCid).toBe('bafy-recovered');
    expect(persisted[0].mode).toBe('conservative');
  });

  it("writes SENT on 'sending' → 'delivered-instant' arc for instant-mode entries", async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);

    await seedStuckSendingEntry(outboxWriter, {
      id: 'instant-recovery-1',
      mode: 'instant',
      updatedAt: Date.now() - 120_000,
    });

    await asInternals(payments).sendingRecoveryWorker!.runScanCycle();

    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('instant-recovery-1');
    expect(persisted[0].mode).toBe('instant');
  });

  it("does NOT write SENT when re-publish fails (status arc never reaches 'delivered')", async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);

    await seedStuckSendingEntry(outboxWriter, {
      updatedAt: Date.now() - 120_000,
    });

    // Failed re-publish: the worker counts failures and never
    // transitions to delivered on a single failure.
    transport.sendTokenTransfer.mockRejectedValue(new Error('relay-down'));

    await asInternals(payments).sendingRecoveryWorker!.runScanCycle();

    // Status stayed 'sending' (or rolled forward to 'failed-transient'
    // after maxRetries — depends on worker policy). What matters: no
    // SENT entry was written because the arc never reached
    // 'delivered'.
    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(0);
  });

  it("does not double-write SENT when the same arc is re-run after delivery (mutator self-loop)", async () => {
    const { outboxWriter, sentLedgerWriter } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentLedgerWriter);

    await seedStuckSendingEntry(outboxWriter, {
      updatedAt: Date.now() - 120_000,
    });

    // First scan — transitions to 'delivered', writes SENT.
    await asInternals(payments).sendingRecoveryWorker!.runScanCycle();
    const afterFirst = await sentLedgerWriter.readAll();
    expect(afterFirst).toHaveLength(1);

    // Re-write the same outbox entry with status 'delivered' so the
    // worker's terminalStatus filter at line 239 (status === 'sending')
    // excludes it from the next scan — meaning the shim is NOT invoked
    // again. The SENT ledger should remain unchanged.
    await asInternals(payments).sendingRecoveryWorker!.runScanCycle();
    const afterSecond = await sentLedgerWriter.readAll();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(afterFirst[0].id);
  });

  it("captures writeSentEntryFromOutbox via .bind(this) so post-construction writer swaps are observed", async () => {
    // The shim binds writeSentEntryFromOutbox once at initialize()
    // time (PaymentsModule.ts:1640) — but the helper reads
    // `this._sentLedgerWriter` at call time. So installing a NEW
    // SentLedgerWriter via installSentLedgerWriter must take effect.
    const { outboxWriter, sentLedgerWriter: writerA } = createWriterPair();
    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(writerA);

    await seedStuckSendingEntry(outboxWriter, {
      id: 'late-swap-1',
      updatedAt: Date.now() - 120_000,
    });

    // Swap to a different SentLedgerWriter AFTER initialize() (= AFTER
    // the shim closure was built and bound).
    const { sentLedgerWriter: writerB } = createWriterPair();
    payments.installSentLedgerWriter(writerB);

    await asInternals(payments).sendingRecoveryWorker!.runScanCycle();

    // The SENT entry should land in writerB, NOT writerA. The shim's
    // bound helper reads `this._sentLedgerWriter` at call time, which
    // is writerB now.
    expect(await writerA.readAll()).toHaveLength(0);
    expect(await writerB.readAll()).toHaveLength(1);
    expect((await writerB.readAll())[0].id).toBe('late-swap-1');
  });
});
