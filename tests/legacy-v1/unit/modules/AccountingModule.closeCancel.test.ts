/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for AccountingModule.closeInvoice() and cancelInvoice()
 *
 * 16 tests total:
 *   UT-CLOSE-001 through UT-CLOSE-010 (10 close tests)
 *   UT-CANCEL-001 through UT-CANCEL-006 (6 cancel tests)
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.7, §3.8
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransferRef,
  DEFAULT_TEST_IDENTITY,
  DEFAULT_TEST_TRACKED_ADDRESS,
  SphereError,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type {
  InvoiceTerms,
  InvoiceTransferRef,
  FrozenInvoiceBalances,
} from '../../../modules/accounting/types.js';
import { getAddressId } from '../../../constants.js';

// ---------------------------------------------------------------------------
// Private-field helpers
// ---------------------------------------------------------------------------

function seedInvoice(
  module: AccountingModule,
  invoiceId: string,
  terms: InvoiceTerms,
): void {
  (module as any).invoiceTermsCache.set(invoiceId, terms);
  if (!(module as any).invoiceLedger.has(invoiceId)) {
    (module as any).invoiceLedger.set(invoiceId, new Map<string, InvoiceTransferRef>());
  }
}

function addLedgerEntry(
  module: AccountingModule,
  invoiceId: string,
  ref: InvoiceTransferRef,
): void {
  const inner = (module as any).invoiceLedger.get(invoiceId) as Map<string, InvoiceTransferRef>;
  if (!inner) throw new Error(`No ledger slot for invoice ${invoiceId}`);
  const entryKey = `${ref.transferId}::${ref.coinId}`;
  inner.set(entryKey, ref);
  (module as any).balanceCache.delete(invoiceId);
}

function markClosed(
  module: AccountingModule,
  invoiceId: string,
  frozen: FrozenInvoiceBalances,
): void {
  (module as any).closedInvoices.add(invoiceId);
  (module as any).frozenBalances.set(invoiceId, frozen);
}

function markCancelled(
  module: AccountingModule,
  invoiceId: string,
  frozen: FrozenInvoiceBalances,
): void {
  (module as any).cancelledInvoices.add(invoiceId);
  (module as any).frozenBalances.set(invoiceId, frozen);
}

function buildMinimalFrozen(state: 'CLOSED' | 'CANCELLED'): FrozenInvoiceBalances {
  return {
    state,
    explicitClose: state === 'CLOSED' ? true : undefined,
    frozenAt: Date.now(),
    targets: [],
    irrelevantTransfers: [],
    totalForward: {},
    totalBack: {},
    lastActivityAt: 0,
  };
}

/** Build a FrozenInvoiceBalances with one sender having a positive netBalance. */
function buildFrozenWithSender(
  state: 'CLOSED' | 'CANCELLED',
  senderAddress: string,
  coinId: string,
  coinEntry: [string, string],
  netBalance: string,
  targetAddress: string,
): FrozenInvoiceBalances {
  return {
    state,
    explicitClose: state === 'CLOSED' ? true : undefined,
    frozenAt: Date.now(),
    targets: [
      {
        address: targetAddress,
        isCovered: true,
        confirmed: true,
        coinAssets: [
          {
            coin: coinEntry,
            coveredAmount: netBalance,
            returnedAmount: '0',
            netCoveredAmount: netBalance,
            isCovered: true,
            surplusAmount: '0',
            confirmed: true,
            transfers: [],
            frozenSenderBalances: [
              {
                senderAddress,
                netBalance,
                contacts: [],
              },
            ],
          },
        ],
        nftAssets: [],
      },
    ],
    irrelevantTransfers: [],
    totalForward: { [coinId]: netBalance },
    totalBack: {},
    lastActivityAt: Date.now() - 500,
  };
}

/** Build a FrozenInvoiceBalances with surplus (netBalance > required). */
function buildFrozenWithSurplus(
  senderAddress: string,
  targetAddress: string,
  required: string,
  received: string,
): FrozenInvoiceBalances {
  const surplus = String(BigInt(received) - BigInt(required));
  return {
    state: 'CLOSED',
    explicitClose: true,
    frozenAt: Date.now(),
    targets: [
      {
        address: targetAddress,
        isCovered: true,
        confirmed: true,
        coinAssets: [
          {
            coin: ['UCT', required],
            coveredAmount: received,
            returnedAmount: '0',
            netCoveredAmount: received,
            isCovered: true,
            surplusAmount: surplus,
            confirmed: true,
            transfers: [],
            frozenSenderBalances: [
              {
                senderAddress,
                netBalance: surplus, // Latest sender gets only the surplus in CLOSED
                contacts: [],
              },
            ],
            latestSenderAddress: senderAddress,
          },
        ],
        nftAssets: [],
      },
    ],
    irrelevantTransfers: [],
    totalForward: { UCT: received },
    totalBack: {},
    lastActivityAt: Date.now() - 500,
  };
}

/** Build an InvoiceTerms with the test wallet's address as target. */
function buildTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    createdAt: Date.now() - 1000,
    targets: [
      {
        address: DEFAULT_TEST_IDENTITY.directAddress!,
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    ...overrides,
  };
}

/** Build an InvoiceTerms where the test wallet is NOT a target. */
function buildNonTargetTerms(): InvoiceTerms {
  return {
    createdAt: Date.now() - 1000,
    targets: [
      {
        address: 'DIRECT://some_other_address_zzz999',
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
  };
}

/** Get the emitEvent mock fn from a module's injected deps. */
function getEmitEvent(module: AccountingModule): ReturnType<typeof vi.fn> {
  return (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
}

/** Compute storage key as the module does internally (uses condensed addressId). */
function storageKey(storageKeyName: string): string {
  return `${getAddressId(DEFAULT_TEST_IDENTITY.directAddress!)}_${storageKeyName}`;
}

// ---------------------------------------------------------------------------
// closeInvoice() tests
// ---------------------------------------------------------------------------

describe('AccountingModule.closeInvoice()', () => {
  let module: AccountingModule;
  let mocks: ReturnType<typeof createTestAccountingModule>['mocks'];

  beforeEach(() => {
    vi.restoreAllMocks();
    ({ module, mocks } = createTestAccountingModule());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-001: Successful close
  // -------------------------------------------------------------------------
  it('UT-CLOSE-001: closes an OPEN invoice, freezes balances, and fires invoice:closed (explicit=true)', async () => {
    const invoiceId = '01'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    await module.closeInvoice(invoiceId);

    // Closed set is populated
    expect((module as any).closedInvoices.has(invoiceId)).toBe(true);
    // Frozen balances are set
    expect((module as any).frozenBalances.has(invoiceId)).toBe(true);
    const frozen = (module as any).frozenBalances.get(invoiceId) as FrozenInvoiceBalances;
    expect(frozen.state).toBe('CLOSED');

    // Event fired with explicit=true
    const emitCalls = getEmitEvent(module).mock.calls;
    const closedCall = emitCalls.find(
      (call: any[]) => call[0] === 'invoice:closed' && call[1]?.invoiceId === invoiceId,
    );
    expect(closedCall).toBeDefined();
    expect(closedCall![1].explicit).toBe(true);
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-002: Not a target → INVOICE_NOT_TARGET
  // -------------------------------------------------------------------------
  it('UT-CLOSE-002: throws INVOICE_NOT_TARGET when caller is not a target of the invoice', async () => {
    const invoiceId = '02'.repeat(32);
    const terms = buildNonTargetTerms();
    seedInvoice(module, invoiceId, terms);

    await expect(module.closeInvoice(invoiceId)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_TARGET',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-003: Already closed → INVOICE_ALREADY_CLOSED
  // -------------------------------------------------------------------------
  it('UT-CLOSE-003: throws INVOICE_ALREADY_CLOSED when invoice is already closed', async () => {
    const invoiceId = '03'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);
    markClosed(module, invoiceId, buildMinimalFrozen('CLOSED'));

    await expect(module.closeInvoice(invoiceId)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_ALREADY_CLOSED',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-004: Already cancelled → INVOICE_ALREADY_CANCELLED
  // -------------------------------------------------------------------------
  it('UT-CLOSE-004: throws INVOICE_ALREADY_CANCELLED when invoice is already cancelled', async () => {
    const invoiceId = '04'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);
    markCancelled(module, invoiceId, buildMinimalFrozen('CANCELLED'));

    await expect(module.closeInvoice(invoiceId)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_ALREADY_CANCELLED',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-005: Close freezes balances
  // -------------------------------------------------------------------------
  it('UT-CLOSE-005: persists frozen balances to storage after close', async () => {
    const invoiceId = '05'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: true,
      transferId: 'pay-close-001',
    }));

    await module.closeInvoice(invoiceId);

    // Frozen balances persisted in storage
    const frozenKey = storageKey('frozen_balances');
    expect(mocks.storage._data.has(frozenKey)).toBe(true);
    const storedFrozen = JSON.parse(mocks.storage._data.get(frozenKey)!);
    expect(storedFrozen[invoiceId]).toBeDefined();
    expect(storedFrozen[invoiceId].state).toBe('CLOSED');

    // CLOSED_INVOICES set also persisted
    const closedKey = storageKey('closed_invoices');
    expect(mocks.storage._data.has(closedKey)).toBe(true);
    const storedClosed = JSON.parse(mocks.storage._data.get(closedKey)!);
    expect(storedClosed).toContain(invoiceId);
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-006: Close with auto-return returns surplus
  // -------------------------------------------------------------------------
  it('UT-CLOSE-006: with autoReturn=true, sends the surplus back to the latest sender', async () => {
    const invoiceId = '06'.repeat(32);
    const senderAddress = 'DIRECT://sender_address_def456';
    const terms = buildTerms(); // Requires 10 UCT

    // Inject a pre-built frozen state simulating 15 UCT received (5 surplus)
    // We achieve this by seeding the invoice with a payment of 15 UCT
    seedInvoice(module, invoiceId, terms);
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '15000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress,
      confirmed: true,
      transferId: 'pay-surplus',
    }));

    await module.closeInvoice(invoiceId, { autoReturn: true });

    // payments.send should have been called with the surplus (5 UCT) going back
    // We verify send was called at least once (auto-return triggered)
    const sendCalls = mocks.payments.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const returnCall = sendCalls[0];
    expect(returnCall[0].recipient).toBe(senderAddress);
    // Amount should be the surplus = 15000000 - 10000000 = 5000000
    expect(returnCall[0].amount).toBe('5000000');
    expect(returnCall[0].coinId).toBe('UCT');
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-007: INVOICE_NOT_FOUND for unknown invoice
  // -------------------------------------------------------------------------
  it('UT-CLOSE-007: throws INVOICE_NOT_FOUND for a nonexistent invoice', async () => {
    await expect(module.closeInvoice('07'.repeat(32))).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-008: Per-sender reset on close (balances go to 0 for non-latest senders)
  // -------------------------------------------------------------------------
  it('UT-CLOSE-008: for CLOSED invoices, non-latest senders have netBalance 0 in frozen snapshot', async () => {
    const invoiceId = '08'.repeat(32);
    const sender1 = 'DIRECT://sender_one_alpha111';
    const sender2 = 'DIRECT://sender_two_beta222'; // latest sender
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    // sender1 pays 5 UCT first, then sender2 pays the final 5 UCT (latest)
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '5000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender1,
      confirmed: true,
      transferId: 'pay-s1',
    }));
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '5000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender2,
      confirmed: true,
      transferId: 'pay-s2',
    }));

    await module.closeInvoice(invoiceId);

    const frozen = (module as any).frozenBalances.get(invoiceId) as FrozenInvoiceBalances;
    expect(frozen).toBeDefined();
    const uctAsset = frozen.targets[0]?.coinAssets.find(
      (ca: any) => ca.coin[0] === 'UCT',
    );
    expect(uctAsset).toBeDefined();

    // Non-latest sender (sender1) should have netBalance 0
    const s1Frozen = uctAsset!.frozenSenderBalances.find(
      (fsb: any) => fsb.senderAddress === sender1,
    );
    expect(s1Frozen).toBeDefined();
    expect(s1Frozen!.netBalance).toBe('0');
    // Latest sender (sender2) should have the surplus (0 in this case: 10 - 10 = 0)
    // but should still appear as the latest sender
    expect(uctAsset!.latestSenderAddress).toBe(sender2);
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-009: Close fires invoice:closed event with explicit=true
  // -------------------------------------------------------------------------
  it('UT-CLOSE-009: fires the invoice:closed event with explicit=true on explicit close', async () => {
    const invoiceId = '09'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    await module.closeInvoice(invoiceId);

    const emitCalls = getEmitEvent(module).mock.calls;
    const closedEvents = emitCalls.filter(
      (call: any[]) => call[0] === 'invoice:closed' && call[1]?.invoiceId === invoiceId,
    );
    expect(closedEvents.length).toBeGreaterThan(0);
    expect(closedEvents[0][1].explicit).toBe(true);
  });

  // -------------------------------------------------------------------------
  // UT-CLOSE-010: Close from PARTIAL state (doesn't need full coverage)
  // -------------------------------------------------------------------------
  it('UT-CLOSE-010: allows close from PARTIAL state — partial balances are frozen', async () => {
    const invoiceId = '10'.repeat(32);
    const terms = buildTerms(); // Requires 10 UCT
    seedInvoice(module, invoiceId, terms);

    // Only 3 UCT paid — PARTIAL state
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '3000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: true,
      transferId: 'pay-partial',
    }));

    // Should not throw
    await expect(module.closeInvoice(invoiceId)).resolves.not.toThrow();

    const status = await module.getInvoiceStatus(invoiceId);
    expect(status.state).toBe('CLOSED');

    // Frozen balance should reflect partial payment
    const frozen = (module as any).frozenBalances.get(invoiceId) as FrozenInvoiceBalances;
    expect(frozen.state).toBe('CLOSED');
    expect(frozen.explicitClose).toBe(true);

    // Event fired with explicit=true
    const emitCalls = getEmitEvent(module).mock.calls;
    const closedCall = emitCalls.find(
      (call: any[]) => call[0] === 'invoice:closed' && call[1]?.explicit === true,
    );
    expect(closedCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// cancelInvoice() tests
// ---------------------------------------------------------------------------

describe('AccountingModule.cancelInvoice()', () => {
  let module: AccountingModule;
  let mocks: ReturnType<typeof createTestAccountingModule>['mocks'];

  beforeEach(() => {
    vi.restoreAllMocks();
    ({ module, mocks } = createTestAccountingModule());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-CANCEL-001: Successful cancel
  // -------------------------------------------------------------------------
  it('UT-CANCEL-001: cancels an OPEN invoice, freezes balances, and fires invoice:cancelled', async () => {
    const invoiceId = 'c1'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    await module.cancelInvoice(invoiceId);

    // Cancelled set is populated
    expect((module as any).cancelledInvoices.has(invoiceId)).toBe(true);
    // Frozen balances are set with state CANCELLED
    expect((module as any).frozenBalances.has(invoiceId)).toBe(true);
    const frozen = (module as any).frozenBalances.get(invoiceId) as FrozenInvoiceBalances;
    expect(frozen.state).toBe('CANCELLED');

    // Event fired
    const emitCalls = getEmitEvent(module).mock.calls;
    const cancelledCall = emitCalls.find(
      (call: any[]) => call[0] === 'invoice:cancelled' && call[1]?.invoiceId === invoiceId,
    );
    expect(cancelledCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // UT-CANCEL-002: Not a target → INVOICE_NOT_TARGET
  // -------------------------------------------------------------------------
  it('UT-CANCEL-002: throws INVOICE_NOT_TARGET when caller is not a target', async () => {
    const invoiceId = 'c2'.repeat(32);
    const terms = buildNonTargetTerms();
    seedInvoice(module, invoiceId, terms);

    await expect(module.cancelInvoice(invoiceId)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_TARGET',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CANCEL-003: Already closed → INVOICE_ALREADY_CLOSED
  // -------------------------------------------------------------------------
  it('UT-CANCEL-003: throws INVOICE_ALREADY_CLOSED when invoice is already closed', async () => {
    const invoiceId = 'c3'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);
    markClosed(module, invoiceId, buildMinimalFrozen('CLOSED'));

    await expect(module.cancelInvoice(invoiceId)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_ALREADY_CLOSED',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CANCEL-004: Already cancelled → INVOICE_ALREADY_CANCELLED
  // -------------------------------------------------------------------------
  it('UT-CANCEL-004: throws INVOICE_ALREADY_CANCELLED when invoice is already cancelled', async () => {
    const invoiceId = 'c4'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);
    markCancelled(module, invoiceId, buildMinimalFrozen('CANCELLED'));

    await expect(module.cancelInvoice(invoiceId)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_ALREADY_CANCELLED',
    );
  });

  // -------------------------------------------------------------------------
  // UT-CANCEL-005: Cancel preserves per-sender balances
  // -------------------------------------------------------------------------
  it('UT-CANCEL-005: CANCELLED frozen snapshot preserves each sender full pre-cancellation balance', async () => {
    const invoiceId = 'c5'.repeat(32);
    const sender1 = 'DIRECT://sender_alpha_aaa111';
    const sender2 = 'DIRECT://sender_beta_bbb222';
    const terms = buildTerms(); // Requires 10 UCT
    seedInvoice(module, invoiceId, terms);

    // sender1 pays 6 UCT, sender2 pays 4 UCT
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '6000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender1,
      confirmed: true,
      transferId: 'pay-s1-c5',
    }));
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '4000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender2,
      confirmed: true,
      transferId: 'pay-s2-c5',
    }));

    await module.cancelInvoice(invoiceId);

    const frozen = (module as any).frozenBalances.get(invoiceId) as FrozenInvoiceBalances;
    expect(frozen.state).toBe('CANCELLED');

    const uctAsset = frozen.targets[0]?.coinAssets.find(
      (ca: any) => ca.coin[0] === 'UCT',
    );
    expect(uctAsset).toBeDefined();

    // For CANCELLED: both senders should have their full balance preserved
    const s1Frozen = uctAsset!.frozenSenderBalances.find(
      (fsb: any) => fsb.senderAddress === sender1,
    );
    const s2Frozen = uctAsset!.frozenSenderBalances.find(
      (fsb: any) => fsb.senderAddress === sender2,
    );
    expect(s1Frozen).toBeDefined();
    expect(s2Frozen).toBeDefined();
    expect(s1Frozen!.netBalance).toBe('6000000');
    expect(s2Frozen!.netBalance).toBe('4000000');

    // Storage also updated
    const cancelledKey = storageKey('cancelled_invoices');
    expect(mocks.storage._data.has(cancelledKey)).toBe(true);
    const storedCancelled = JSON.parse(mocks.storage._data.get(cancelledKey)!);
    expect(storedCancelled).toContain(invoiceId);
  });

  // -------------------------------------------------------------------------
  // UT-CANCEL-006: Cancel with auto-return returns everything
  // -------------------------------------------------------------------------
  it('UT-CANCEL-006: with autoReturn=true, sends entire balance back to each sender', async () => {
    const invoiceId = 'c6'.repeat(32);
    const senderAddress = 'DIRECT://sender_address_def456';
    const terms = buildTerms(); // Requires 10 UCT
    seedInvoice(module, invoiceId, terms);

    // 15 UCT received — on cancel with autoReturn, ALL 15 should be returned
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '15000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress,
      confirmed: true,
      transferId: 'pay-cancel-autoret',
    }));

    await module.cancelInvoice(invoiceId, { autoReturn: true });

    // payments.send should have been called with the full 15 UCT
    const sendCalls = mocks.payments.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);
    const returnCall = sendCalls[0];
    expect(returnCall[0].recipient).toBe(senderAddress);
    expect(returnCall[0].coinId).toBe('UCT');
    // For CANCELLED, return is the entire sender balance (not just surplus)
    // The frozen sender balance should be 15000000 (full amount for CANCELLED)
    expect(returnCall[0].amount).toBe('15000000');
  });
});

// ---------------------------------------------------------------------------
// Storage ordering test (terminal set BEFORE frozen balances)
// ---------------------------------------------------------------------------

describe('AccountingModule close/cancel: storage write ordering', () => {
  it('frozen balances are persisted before terminal set on closeInvoice() (C12 crash safety)', async () => {
    const { module, mocks } = createTestAccountingModule();
    const invoiceId = 'ord01'.repeat(12) + '0000';
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    // Track storage.set call order
    const setOrder: string[] = [];
    const originalSet = mocks.storage.set.getMockImplementation();
    mocks.storage.set.mockImplementation(async (key: string, value: string) => {
      setOrder.push(key);
      if (originalSet) {
        return originalSet(key, value);
      }
      mocks.storage._data.set(key, value);
    });

    await module.closeInvoice(invoiceId);

    // C12 fix: frozen_balances should appear BEFORE closed_invoices.
    // The terminal set write is the commit point — crash between writes means
    // the invoice is NOT terminal on recovery (safe to re-close).
    const closedIdx = setOrder.findIndex((k) => k.endsWith('closed_invoices'));
    const frozenIdx = setOrder.findIndex((k) => k.endsWith('frozen_balances'));
    expect(closedIdx).toBeGreaterThanOrEqual(0);
    expect(frozenIdx).toBeGreaterThanOrEqual(0);
    expect(frozenIdx).toBeLessThan(closedIdx);

    module.destroy();
  });

  it('frozen balances are persisted before terminal set on cancelInvoice() (C12 crash safety)', async () => {
    const { module, mocks } = createTestAccountingModule();
    const invoiceId = 'ord02'.repeat(12) + '0000';
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const setOrder: string[] = [];
    const originalSet = mocks.storage.set.getMockImplementation();
    mocks.storage.set.mockImplementation(async (key: string, value: string) => {
      setOrder.push(key);
      if (originalSet) {
        return originalSet(key, value);
      }
      mocks.storage._data.set(key, value);
    });

    await module.cancelInvoice(invoiceId);

    // C12 fix: frozen_balances should appear BEFORE cancelled_invoices.
    const cancelledIdx = setOrder.findIndex((k) => k.endsWith('cancelled_invoices'));
    const frozenIdx = setOrder.findIndex((k) => k.endsWith('frozen_balances'));
    expect(cancelledIdx).toBeGreaterThanOrEqual(0);
    expect(frozenIdx).toBeGreaterThanOrEqual(0);
    expect(frozenIdx).toBeLessThan(cancelledIdx);

    module.destroy();
  });
});

