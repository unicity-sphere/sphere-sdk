/**
 * SwapModule Invoice Event Subscription Tests
 *
 * UT-SWAP-INV-001 through UT-SWAP-INV-006
 *
 * Tests the setupInvoiceEventSubscriptions private method by triggering
 * invoice events via _emit() on the mock AccountingModule. The invoice
 * event handlers are registered during load().
 *
 * @see docs/SWAP-TEST-SPEC.md section 3.9
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SwapModule } from '../../../modules/swap/index.js';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_PUBKEY,
  DEFAULT_TEST_ESCROW_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';

describe('SwapModule.invoiceEvents', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
  });

  afterEach(async () => {
    await module.destroy();
  });

  // (vi.waitFor used directly in each test for reliable async event processing)

  // =========================================================================
  // UT-SWAP-INV-001: invoice:payment on deposit invoice emits
  //                  swap:deposit_confirmed
  // =========================================================================

  it('UT-SWAP-INV-001: invoice:payment on deposit invoice emits swap:deposit_confirmed', async () => {
    const depositInvoiceId = 'inv-deposit-001';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'depositing',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    // Trigger invoice:payment event matching the deposit invoice
    mocks.accounting._emit('invoice:payment', {
      invoiceId: depositInvoiceId,
      transfer: {
        id: 'transfer-001',
        coinId: ref.manifest.party_a_currency_to_change,
        amount: ref.manifest.party_a_value_to_change,
      },
      paymentDirection: 'forward',
      confirmed: true,
    });

    // Verify swap:deposit_confirmed was emitted
    await vi.waitFor(() => {
      const depositEvent = mocks.emitEvent._calls.find(
        ([type]) => type === 'swap:deposit_confirmed',
      );
      expect(depositEvent).toBeDefined();
      expect(depositEvent![1]).toMatchObject({
        swapId: ref.swapId,
        party: 'A',
        coinId: ref.manifest.party_a_currency_to_change,
      });
    });
  });

  // =========================================================================
  // UT-SWAP-INV-002: invoice:covered on deposit invoice emits
  //                  swap:deposits_covered
  // =========================================================================

  it('UT-SWAP-INV-002: invoice:covered on deposit invoice emits swap:deposits_covered', async () => {
    const depositInvoiceId = 'inv-deposit-002';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'awaiting_counter',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    // Trigger invoice:covered event
    mocks.accounting._emit('invoice:covered', {
      invoiceId: depositInvoiceId,
      confirmed: true,
    });

    // Verify swap:deposits_covered was emitted
    await vi.waitFor(() => {
      const coveredEvent = mocks.emitEvent._calls.find(
        ([type]) => type === 'swap:deposits_covered',
      );
      expect(coveredEvent).toBeDefined();
      expect(coveredEvent![1]).toMatchObject({
        swapId: ref.swapId,
      });
    });
  });

  // =========================================================================
  // UT-SWAP-INV-003: invoice:covered transitions to concluding
  // =========================================================================

  it('UT-SWAP-INV-003: invoice:covered on deposit transitions to concluding', async () => {
    const depositInvoiceId = 'inv-deposit-003';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'awaiting_counter',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    // Trigger invoice:covered
    mocks.accounting._emit('invoice:covered', {
      invoiceId: depositInvoiceId,
      confirmed: true,
    });

    // Verify progress is now 'concluding'
    await vi.waitFor(async () => {
      const status = await module.getSwapStatus(ref.swapId);
      expect(status.progress).toBe('concluding');
    });
  });

  // =========================================================================
  // UT-SWAP-INV-004: invoice:return_received emits swap:deposit_returned
  // =========================================================================

  it('UT-SWAP-INV-004: invoice:return_received emits swap:deposit_returned', async () => {
    const depositInvoiceId = 'inv-deposit-004';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    // Trigger invoice:return_received
    const returnTransfer = {
      id: 'return-transfer-001',
      coinId: 'UCT',
      amount: '1000000',
    };
    mocks.accounting._emit('invoice:return_received', {
      invoiceId: depositInvoiceId,
      transfer: returnTransfer,
      returnReason: 'timeout',
    });

    // Verify swap:deposit_returned was emitted
    await vi.waitFor(() => {
      const returnEvent = mocks.emitEvent._calls.find(
        ([type]) => type === 'swap:deposit_returned',
      );
      expect(returnEvent).toBeDefined();
      expect(returnEvent![1]).toMatchObject({
        swapId: ref.swapId,
        returnReason: 'timeout',
      });
    });
  });

  // =========================================================================
  // UT-SWAP-INV-005: invoice:return_received transitions to cancelled
  // =========================================================================

  it('UT-SWAP-INV-005: invoice:return_received transitions to cancelled', async () => {
    const depositInvoiceId = 'inv-deposit-005';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    // Trigger invoice:return_received
    mocks.accounting._emit('invoice:return_received', {
      invoiceId: depositInvoiceId,
      transfer: { id: 'return-002', coinId: 'UCT', amount: '1000000' },
      returnReason: 'timeout',
    });

    // Verify progress is 'cancelled'
    await vi.waitFor(async () => {
      const status = await module.getSwapStatus(ref.swapId);
      expect(status.progress).toBe('cancelled');
    });

    // Verify swap:cancelled event emitted with depositsReturned=true
    const cancelEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:cancelled',
    );
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent![1]).toMatchObject({
      swapId: ref.swapId,
      depositsReturned: true,
    });
  });

  // =========================================================================
  // UT-SWAP-INV-006: Invoice event for non-swap invoice ignored
  // =========================================================================

  it('UT-SWAP-INV-006: invoice event for non-swap invoice ignored', async () => {
    // Inject a swap with a specific depositInvoiceId
    const depositInvoiceId = 'inv-deposit-006';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'depositing',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    const emitCallsBefore = mocks.emitEvent._calls.length;

    // Trigger invoice:payment with a DIFFERENT invoiceId (not linked to any swap)
    mocks.accounting._emit('invoice:payment', {
      invoiceId: 'unrelated-invoice-xyz',
      transfer: {
        id: 'transfer-unrelated',
        coinId: 'UCT',
        amount: '500000',
      },
      paymentDirection: 'forward',
      confirmed: true,
    });

    // Allow microtask queue to drain
    await new Promise(r => setTimeout(r, 50));

    // No swap events should have been emitted
    const swapEvents = mocks.emitEvent._calls
      .slice(emitCallsBefore)
      .filter(([type]) => (type as string).startsWith('swap:'));
    expect(swapEvents.length).toBe(0);

    // Swap progress unchanged
    const status = await module.getSwapStatus(ref.swapId);
    expect(status.progress).toBe('depositing');
  });
});
