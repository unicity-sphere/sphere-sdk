/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AccountingModule — BUG-002 Fixes (Fix 3 & Fix 4)
 *
 * Fix 3: Per-send timeout in _executeTerminationReturns()
 *   Each deps.payments.send() call is wrapped in Promise.race with a 60-second
 *   timeout. Before this fix, a hung send would block all subsequent returns and
 *   hold the gate indefinitely.
 *
 * Fix 4: Deferred event emission inside gates
 *   All invoice:closed and invoice:cancelled events emitted inside withInvoiceGate
 *   are wrapped in queueMicrotask() to defer emission until after the gate is
 *   released. This prevents re-entrant handlers from seeing inconsistent state.
 *
 * Test IDs: UT-TERM-TIMEOUT-001 through UT-TERM-TIMEOUT-002,
 *           UT-DEFER-EVENT-001 through UT-DEFER-EVENT-004
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransferRef,
  DEFAULT_TEST_IDENTITY,
  SphereError,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type {
  InvoiceTerms,
  InvoiceTransferRef,
  FrozenInvoiceBalances,
} from '../../../modules/accounting/types.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

// =============================================================================
// Shared helpers
// =============================================================================

function randomHex64(): string {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

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

function getEmitEvent(module: AccountingModule): ReturnType<typeof vi.fn> {
  return (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
}

// =============================================================================
// Fix 3: Per-send timeout in _executeTerminationReturns()
// =============================================================================

describe('BUG-002 Fix 3: _executeTerminationReturns per-send timeout', () => {
  let module: AccountingModule;
  let mocks: TestAccountingModuleMocks;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ module, mocks } = createTestAccountingModule());
    await module.load();
  });

  afterEach(() => {
    module.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // UT-TERM-TIMEOUT-001: Individual send timeout does not block subsequent sends
  // ---------------------------------------------------------------------------
  it('UT-TERM-TIMEOUT-001: times out individual sends without blocking subsequent returns', async () => {
    const invoiceId = randomHex64();
    const sender1 = 'DIRECT://sender_one_alpha111';
    const sender2 = 'DIRECT://sender_two_beta222';
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    // Two senders each paid 10M to a 10M invoice (20M total, 10M surplus split).
    // On cancel with autoReturn, both senders should get their balance back.
    const cancelTerms = buildTerms({
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [{ coin: ['UCT', '5000000'] }],
        },
      ],
    });
    seedInvoice(module, invoiceId, cancelTerms);

    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '8000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender1,
      confirmed: true,
      transferId: 'pay-s1',
    }));
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '7000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender2,
      confirmed: true,
      transferId: 'pay-s2',
    }));

    // First send hangs forever; second send succeeds immediately
    let sendCallCount = 0;
    mocks.payments.send.mockImplementation(() => {
      sendCallCount++;
      if (sendCallCount === 1) {
        // Hang forever — never resolves
        return new Promise<never>(() => {});
      }
      return Promise.resolve({
        id: 'return-transfer-' + sendCallCount,
        status: 'completed',
        tokens: [],
        tokenTransfers: [],
      });
    });

    // Start cancelInvoice with autoReturn — this will call _executeTerminationReturns
    const cancelPromise = module.cancelInvoice(invoiceId, { autoReturn: true });

    // Advance past the 60-second timeout
    await vi.advanceTimersByTimeAsync(60_001);

    // Let the cancel promise settle
    await cancelPromise;

    // Allow microtasks to flush (deferred events)
    await vi.advanceTimersByTimeAsync(0);

    const emitEvent = getEmitEvent(module);

    // Verify auto_return_failed was emitted for the timed-out send
    const failedCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:auto_return_failed',
    );
    expect(failedCalls.length).toBeGreaterThan(0);
    expect(failedCalls[0][1]).toMatchObject({
      invoiceId,
      reason: 'send_failed',
    });

    // Verify that send was called at least twice (not blocked by first timeout)
    expect(mocks.payments.send).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // UT-TERM-TIMEOUT-002: Successful send clears timer (no spurious timeout)
  // ---------------------------------------------------------------------------
  it('UT-TERM-TIMEOUT-002: successful send clears timer without spurious timeout errors', async () => {
    const invoiceId = randomHex64();
    const senderAddress = 'DIRECT://sender_address_def456';
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    // Sender paid 15M on a 10M invoice — 5M surplus
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '15000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress,
      confirmed: true,
      transferId: 'pay-surplus',
    }));

    // send() resolves immediately
    mocks.payments.send.mockResolvedValue({
      id: 'return-transfer-ok',
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    });

    await module.closeInvoice(invoiceId, { autoReturn: true });

    // Advance timer well past the 60s timeout — no spurious TIMEOUT should fire
    await vi.advanceTimersByTimeAsync(120_000);

    const emitEvent = getEmitEvent(module);

    // No auto_return_failed event should have fired
    const failedCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:auto_return_failed',
    );
    expect(failedCalls.length).toBe(0);

    // send() should have been called exactly once
    expect(mocks.payments.send).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Fix 4: Deferred event emission inside gates
// =============================================================================

describe('BUG-002 Fix 4: Deferred event emission inside gates', () => {
  let module: AccountingModule;
  let mocks: TestAccountingModuleMocks;

  beforeEach(async () => {
    ({ module, mocks } = createTestAccountingModule());
    await module.load();
  });

  afterEach(() => {
    module.destroy();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // UT-DEFER-EVENT-001: closeInvoice event fires after gate released
  // ---------------------------------------------------------------------------
  it('UT-DEFER-EVENT-001: invoice:closed event handler can call getInvoiceStatus without deadlock', async () => {
    const invoiceId = randomHex64();
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const emitEvent = getEmitEvent(module);
    let statusFromHandler: any = null;

    // Replace emitEvent with one that calls getInvoiceStatus on closed event.
    // Because the event is deferred via queueMicrotask, the gate should be
    // released by the time the handler runs, so getInvoiceStatus should not deadlock.
    emitEvent.mockImplementation((event: string, payload: any) => {
      if (event === 'invoice:closed' && payload.invoiceId === invoiceId) {
        // This runs after the gate is released — should not deadlock
        module.getInvoiceStatus(invoiceId).then((status) => {
          statusFromHandler = status;
        });
      }
    });

    await module.closeInvoice(invoiceId);

    // Flush microtask queue — the deferred event fires here
    await new Promise((r) => setTimeout(r, 30));

    // The handler should have been able to call getInvoiceStatus successfully
    expect(statusFromHandler).not.toBeNull();
    expect(statusFromHandler.state).toBe('CLOSED');
  });

  // ---------------------------------------------------------------------------
  // UT-DEFER-EVENT-002: cancelInvoice event fires after gate released
  // ---------------------------------------------------------------------------
  it('UT-DEFER-EVENT-002: invoice:cancelled event handler can call getInvoiceStatus without deadlock', async () => {
    const invoiceId = randomHex64();
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const emitEvent = getEmitEvent(module);
    let statusFromHandler: any = null;

    emitEvent.mockImplementation((event: string, payload: any) => {
      if (event === 'invoice:cancelled' && payload.invoiceId === invoiceId) {
        module.getInvoiceStatus(invoiceId).then((status) => {
          statusFromHandler = status;
        });
      }
    });

    await module.cancelInvoice(invoiceId);

    // Flush microtask queue
    await new Promise((r) => setTimeout(r, 30));

    expect(statusFromHandler).not.toBeNull();
    expect(statusFromHandler.state).toBe('CANCELLED');
  });

  // ---------------------------------------------------------------------------
  // UT-DEFER-EVENT-003: cancelInvoice event is deferred (verify re-entrant access works)
  // ---------------------------------------------------------------------------
  it('UT-DEFER-EVENT-003: cancelInvoice deferred event allows re-entrant getInvoiceStatus from handler', async () => {
    // This test verifies the deferred emission pattern for cancelInvoice by
    // checking that a handler triggered by the deferred event can re-enter the
    // gate without deadlocking — the same property verified for closeInvoice in
    // UT-DEFER-EVENT-001 but exercised through the cancel path.
    const invoiceId = randomHex64();
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    // Add a payment so the status is PARTIAL before cancel
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '3000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: true,
      transferId: 'pay-partial-003',
    }));

    const emitEvent = getEmitEvent(module);
    let statusFromHandler: any = null;
    let closedCallAttemptError: SphereError | null = null;

    emitEvent.mockImplementation((event: string, payload: any) => {
      if (event === 'invoice:cancelled' && payload.invoiceId === invoiceId) {
        // Try getInvoiceStatus — should work (gate released)
        module.getInvoiceStatus(invoiceId).then((status) => {
          statusFromHandler = status;
        });
        // Try closeInvoice — should fail with ALREADY_CANCELLED (not deadlock)
        module.closeInvoice(invoiceId).catch((e: SphereError) => {
          closedCallAttemptError = e;
        });
      }
    });

    await module.cancelInvoice(invoiceId);

    // Flush microtask/setTimeout queue
    await new Promise((r) => setTimeout(r, 50));

    // Handler was able to get status (gate was released)
    expect(statusFromHandler).not.toBeNull();
    expect(statusFromHandler.state).toBe('CANCELLED');

    // Re-entrant closeInvoice got ALREADY_CANCELLED, not a deadlock
    expect(closedCallAttemptError).not.toBeNull();
    expect(closedCallAttemptError!.code).toBe('INVOICE_ALREADY_CANCELLED');
  });

  // ---------------------------------------------------------------------------
  // UT-DEFER-EVENT-004: Re-entrant handler doesn't block on gate
  // ---------------------------------------------------------------------------
  it('UT-DEFER-EVENT-004: re-entrant handler calling payInvoice gets INVOICE_TERMINATED, not deadlock', async () => {
    const invoiceId = randomHex64();
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const emitEvent = getEmitEvent(module);
    let payError: SphereError | null = null;

    // On invoice:closed, try to pay the same invoice. Since the gate is already
    // released (event deferred via queueMicrotask), payInvoice should run and
    // fail with INVOICE_TERMINATED rather than hanging.
    emitEvent.mockImplementation((event: string, payload: any) => {
      if (event === 'invoice:closed' && payload.invoiceId === invoiceId) {
        module.payInvoice(invoiceId, { targetIndex: 0 }).catch((e: SphereError) => {
          payError = e;
        });
      }
    });

    await module.closeInvoice(invoiceId);

    // Flush microtask queue — the deferred event fires, triggers payInvoice
    await new Promise((r) => setTimeout(r, 50));

    // payInvoice should have failed with INVOICE_TERMINATED, not hung
    expect(payError).not.toBeNull();
    expect(payError!.code).toBe('INVOICE_TERMINATED');
  });
});
