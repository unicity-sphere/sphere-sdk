/**
 * Tests for the `writeSentEntryFromOutbox` helper in PaymentsModule
 * (Issue #166 P3 #1, #2, and the recovery-worker shim contract).
 *
 * **Why this file exists.** The helper is the single load-bearing site
 * for SENT-ledger writes. It is invoked from THREE call sites:
 *   1. `dispatchUxfConservativeSend`'s `transition('delivered')` hook
 *   2. `dispatchUxfInstantSend`'s `write('delivered-instant')` hook
 *   3. SendingRecoveryWorker shim in `initialize()`'s `recoveryDeps.outbox.update`
 *
 * Each call site depends on the helper's return-value contract
 * (`'success'` / `'failed'` / `'skipped'`) to decide whether to
 * tombstone the OUTBOX entry. Wiring the dispatcher end-to-end requires
 * thousands of lines of orchestrator scaffolding. Instead, this file
 * pins the helper contract directly so a regression in any of the
 * three call sites is caught by the unchanged contract.
 *
 * The dispatcher's branching logic (`sentResult === 'failed'` → leave
 * OUTBOX live at `status='delivered'`; otherwise tombstone) is plumbing
 * on top of this helper — the helper IS the load-bearing arc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import {
  createMockProfileDb,
  createStubOracle,
  createStubStorageProvider,
  createStubTokenStorageProvider,
  createStubTransport,
  createTestIdentity,
  createWriterPair,
  makeOutboxEntry,
  TEST_ADDRESS_ID,
} from './__fixtures__/payments-module-fixture';
import { Lamport } from '../../../../profile/lamport';
import { SentLedgerWriter } from '../../../../profile/sent-ledger-writer';
import type { UxfSentLedgerEntry } from '../../../../types/uxf-sent';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';

// ---------------------------------------------------------------------------
// SDK mocks (same shape as PaymentsModule.dual-mode.test.ts)
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
  writeSentEntryFromOutbox(
    entry: UxfTransferOutboxEntry,
    opLabel: string,
  ): Promise<'success' | 'failed' | 'skipped'>;
}

function asInternals(payments: PaymentsModule): PaymentsModuleInternals {
  return payments as unknown as PaymentsModuleInternals;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeSentEntryFromOutbox (Issue #166 — P3 #1, #2, #3 helper contract)', () => {
  let payments: PaymentsModule;

  beforeEach(() => {
    vi.clearAllMocks();
    payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: {
        // Disable the auto-installed sending recovery worker so the
        // helper-contract tests don't race against scan loops.
        recoveryWorker: false,
        // Same for the finalization worker — instant-mode polling
        // touches timers we don't want.
        finalizationWorker: false,
      },
    });
    payments.initialize(createPaymentsDeps());
  });

  it("returns 'skipped' when no SentLedgerWriter is installed (legacy mode)", async () => {
    // No installSentLedgerWriter — _sentLedgerWriter is null.
    const result = await asInternals(payments).writeSentEntryFromOutbox(
      makeOutboxEntry(),
      'unit-test',
    );
    expect(result).toBe('skipped');
  });

  it("returns 'success' when the writer is installed and write completes", async () => {
    const { sentLedgerWriter } = createWriterPair();
    payments.installSentLedgerWriter(sentLedgerWriter);

    const result = await asInternals(payments).writeSentEntryFromOutbox(
      makeOutboxEntry(),
      'unit-test',
    );

    expect(result).toBe('success');
    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
  });

  it("returns 'failed' when the writer's write() throws (operator-triage signal)", async () => {
    const throwingWriter = {
      write: vi.fn().mockRejectedValue(new Error('orbitdb-down')),
    } as unknown as SentLedgerWriter;
    payments.installSentLedgerWriter(throwingWriter);

    const result = await asInternals(payments).writeSentEntryFromOutbox(
      makeOutboxEntry(),
      'unit-test',
    );

    expect(result).toBe('failed');
    expect(throwingWriter.write).toHaveBeenCalledTimes(1);
  });

  it('persists the canonical SENT entry shape derived from the outbox entry', async () => {
    const db = createMockProfileDb();
    const sentLedgerWriter = new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId: TEST_ADDRESS_ID,
      lamport: new Lamport(),
    });
    payments.installSentLedgerWriter(sentLedgerWriter);

    const entry = makeOutboxEntry({
      id: 'transfer-42',
      bundleCid: 'bafy-42',
      tokenIds: ['tok-a', 'tok-b'],
      recipient: '@charlie',
      recipientTransportPubkey: 'b'.repeat(64),
      recipientNametag: 'charlie',
      deliveryMethod: 'cid-over-nostr',
      mode: 'conservative',
    });
    const before = Date.now();
    const result = await asInternals(payments).writeSentEntryFromOutbox(
      entry,
      'dispatchUxfConservativeSend',
    );
    const after = Date.now();
    expect(result).toBe('success');

    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
    const sent = persisted[0] as UxfSentLedgerEntry;
    expect(sent.id).toBe('transfer-42');
    expect(sent.bundleCid).toBe('bafy-42');
    expect(sent.tokenIds).toEqual(['tok-a', 'tok-b']);
    expect(sent.recipient).toBe('@charlie');
    expect(sent.recipientTransportPubkey).toBe('b'.repeat(64));
    expect(sent.recipientNametag).toBe('charlie');
    expect(sent.deliveryMethod).toBe('cid-over-nostr');
    expect(sent.mode).toBe('conservative');
    expect(sent.sentAt).toBeGreaterThanOrEqual(before);
    expect(sent.sentAt).toBeLessThanOrEqual(after);
    expect(sent._schemaVersion).toBe('uxf-1');
    expect(sent.lamport).toBeGreaterThan(0);
  });

  it('omits recipientNametag from the SENT entry when the outbox entry lacks it (no string fallback)', async () => {
    const { sentLedgerWriter } = createWriterPair();
    payments.installSentLedgerWriter(sentLedgerWriter);

    const entry = makeOutboxEntry();
    // makeOutboxEntry's default does NOT include recipientNametag.
    expect(entry.recipientNametag).toBeUndefined();
    await asInternals(payments).writeSentEntryFromOutbox(entry, 'unit-test');

    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].recipientNametag).toBeUndefined();
  });

  it('records the synthetic shape used by the instant dispatcher (lamport: 0, _schemaVersion stamp)', async () => {
    // P3 #2 — `dispatchUxfInstantSend` synthesises a
    // UxfTransferOutboxEntry from OutboxCreateInput with lamport: 0
    // and _schemaVersion: 'uxf-1'. The helper must accept that shape.
    const { sentLedgerWriter } = createWriterPair();
    payments.installSentLedgerWriter(sentLedgerWriter);

    const syntheticInstant = makeOutboxEntry({
      id: 'instant-1',
      status: 'delivered-instant',
      mode: 'instant',
      lamport: 0,
    });
    const result = await asInternals(payments).writeSentEntryFromOutbox(
      syntheticInstant,
      'dispatchUxfInstantSend',
    );

    expect(result).toBe('success');
    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].mode).toBe('instant');
    expect(persisted[0].id).toBe('instant-1');
  });

  it('idempotently overwrites on repeated writes for the same outbox id (recovery-worker replay safety)', async () => {
    // P3 #3 — the recovery worker re-enters terminal-success on
    // re-publish. SentLedgerWriter.write is second-write-wins per its
    // module docs; the helper passes the input through unchanged.
    const { sentLedgerWriter } = createWriterPair();
    payments.installSentLedgerWriter(sentLedgerWriter);

    const entry = makeOutboxEntry({ id: 'recovered-1' });
    const first = await asInternals(payments).writeSentEntryFromOutbox(
      entry,
      'first-write',
    );
    const second = await asInternals(payments).writeSentEntryFromOutbox(
      entry,
      'second-write',
    );
    expect(first).toBe('success');
    expect(second).toBe('success');

    const persisted = await sentLedgerWriter.readAll();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('recovered-1');
  });
});
