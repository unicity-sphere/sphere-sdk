/**
 * SwapModule DM Processing Tests
 *
 * UT-SWAP-DM-001 through UT-SWAP-DM-012
 *
 * Tests the handleIncomingDM private method indirectly via
 * _simulateIncomingDM() on the mock CommunicationsModule.
 * The DM handler is registered during load().
 *
 * @see docs/SWAP-TEST-SPEC.md section 3.8
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SwapModule } from '../../../modules/swap/index.js';
import {
  createTestSwapModule,
  createTestSwapRef,
  createTestSwapDeal,
  createTestManifest,
  createMockProposalDM,
  createMockAcceptanceDM,
  createMockRejectionDM,
  createMockAnnounceResultDM,
  createMockInvoiceDeliveryDM,
  createMockPaymentConfirmationDM,
  createMockSwapCancelledDM,
  createMockBounceNotificationDM,
  injectSwapRef,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';

describe('SwapModule.dmProcessing', () => {
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

  // (vi.waitFor used directly in each test for reliable async DM processing)

  // =========================================================================
  // UT-SWAP-DM-001: swap_proposal DM creates SwapRef with role='acceptor'
  // =========================================================================

  it('UT-SWAP-DM-001: swap_proposal DM creates SwapRef with role=acceptor', async () => {
    // Build a deal where partyB is our address (so we are the acceptor)
    const deal = createTestSwapDeal({
      partyA: DEFAULT_TEST_PARTY_B_ADDRESS, // proposer
      partyB: DEFAULT_TEST_PARTY_A_ADDRESS, // us (acceptor)
    });
    const manifest = createTestManifest(deal);
    const proposalDM = createMockProposalDM(manifest);

    // Simulate incoming DM from party B (the proposer)
    mocks.communications._simulateIncomingDM(
      proposalDM,
      DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      'bob',
    );

    // Verify SwapRef was created
    await vi.waitFor(() => {
      const swaps = module.getSwaps();
      expect(swaps.length).toBe(1);
      expect(swaps[0].role).toBe('acceptor');
      expect(swaps[0].progress).toBe('proposed');
      expect(swaps[0].swapId).toBe(manifest.swap_id);
    });
  });

  // =========================================================================
  // UT-SWAP-DM-002: swap_proposal DM emits swap:proposal_received
  // =========================================================================

  it('UT-SWAP-DM-002: swap_proposal DM emits swap:proposal_received', async () => {
    const deal = createTestSwapDeal({
      partyA: DEFAULT_TEST_PARTY_B_ADDRESS,
      partyB: DEFAULT_TEST_PARTY_A_ADDRESS,
    });
    const manifest = createTestManifest(deal);
    const proposalDM = createMockProposalDM(manifest);

    mocks.communications._simulateIncomingDM(
      proposalDM,
      DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      'bob',
    );

    // Check emitEvent was called with swap:proposal_received
    await vi.waitFor(() => {
      const proposalEvent = mocks.emitEvent._calls.find(
        ([type]) => type === 'swap:proposal_received',
      );
      expect(proposalEvent).toBeDefined();
      expect(proposalEvent![1]).toMatchObject({
        swapId: manifest.swap_id,
        senderPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      });
      // Verify deal is included in the event payload
      const payload = proposalEvent![1] as { deal: unknown };
      expect(payload.deal).toBeDefined();
    });
  });

  // =========================================================================
  // UT-SWAP-DM-003: swap_acceptance DM triggers escrow announcement (for proposer)
  // =========================================================================

  it('UT-SWAP-DM-003: swap_acceptance DM triggers escrow announcement', async () => {
    // Inject a swap as proposer in 'proposed' state
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    injectSwapRef(module, ref);

    // Simulate acceptance DM from counterparty
    const acceptanceDM = createMockAcceptanceDM(ref.swapId);
    mocks.communications._simulateIncomingDM(
      acceptanceDM,
      DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      'bob',
    );

    // Verify that sendDM was called with the escrow pubkey (announce)
    await vi.waitFor(() => {
      const sentToEscrow = mocks.communications._sentDMs.find(
        (dm) => dm.recipient === DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      );
      expect(sentToEscrow).toBeDefined();
    });

    // Verify swap:accepted event was emitted
    const acceptedEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:accepted',
    );
    expect(acceptedEvent).toBeDefined();
  });

  // =========================================================================
  // UT-SWAP-DM-004: swap_rejection DM marks swap as cancelled
  // =========================================================================

  it('UT-SWAP-DM-004: swap_rejection DM marks swap as cancelled', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, ref);

    const rejectionDM = createMockRejectionDM(ref.swapId, 'Not interested');
    mocks.communications._simulateIncomingDM(
      rejectionDM,
      DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      'bob',
    );

    // Verify progress is cancelled
    await vi.waitFor(async () => {
      const status = await module.getSwapStatus(ref.swapId);
      expect(status.progress).toBe('cancelled');
    });

    // Verify both swap:rejected and swap:cancelled were emitted
    const rejectedEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:rejected',
    );
    expect(rejectedEvent).toBeDefined();

    const cancelledEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:cancelled',
    );
    expect(cancelledEvent).toBeDefined();
  });

  // =========================================================================
  // UT-SWAP-DM-005: announce_result DM stores deposit_invoice_id
  // =========================================================================

  it('UT-SWAP-DM-005: announce_result DM stores deposit_invoice_id', async () => {
    const depositInvoiceId = 'test-deposit-invoice-001';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'accepted',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    injectSwapRef(module, ref);

    const announceResultDM = createMockAnnounceResultDM(ref.swapId, depositInvoiceId);
    mocks.communications._simulateIncomingDM(
      announceResultDM,
      DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      'escrow',
    );

    // Verify depositInvoiceId is stored
    await vi.waitFor(async () => {
      const status = await module.getSwapStatus(ref.swapId);
      expect(status.depositInvoiceId).toBe(depositInvoiceId);
    });
  });

  // =========================================================================
  // UT-SWAP-DM-006: invoice_delivery DM imports invoice via accounting
  // =========================================================================

  it('UT-SWAP-DM-006: invoice_delivery DM imports invoice via AccountingModule', async () => {
    const depositInvoiceId = 'test-deposit-invoice-002';
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'accepted',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId,
    });
    injectSwapRef(module, ref);

    // Mock getInvoice to return a valid invoice with correct terms
    mocks.accounting.getInvoice.mockReturnValue({
      invoiceId: depositInvoiceId,
      terms: {
        targets: [{
          address: DEFAULT_TEST_ESCROW_ADDRESS,
          assets: [
            { coin: [ref.manifest.party_a_currency_to_change, ref.manifest.party_a_value_to_change] },
            { coin: [ref.manifest.party_b_currency_to_change, ref.manifest.party_b_value_to_change] },
          ],
        }],
      },
    });

    const invoiceDeliveryDM = createMockInvoiceDeliveryDM(ref.swapId, 'deposit', depositInvoiceId);
    mocks.communications._simulateIncomingDM(
      invoiceDeliveryDM,
      DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      'escrow',
    );

    // Verify importInvoice was called
    await vi.waitFor(() => {
      expect(mocks.accounting.importInvoice).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // UT-SWAP-DM-007: payment_confirmation DM updates progress to concluding
  // =========================================================================

  it('UT-SWAP-DM-007: payment_confirmation DM updates progress to concluding', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'awaiting_counter',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId: 'test-deposit-invoice-003',
    });
    injectSwapRef(module, ref);

    const paymentConfDM = createMockPaymentConfirmationDM(ref.swapId, 'B');
    mocks.communications._simulateIncomingDM(
      paymentConfDM,
      DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      'escrow',
    );

    await vi.waitFor(async () => {
      const status = await module.getSwapStatus(ref.swapId);
      expect(status.progress).toBe('concluding');
    });
  });

  // =========================================================================
  // UT-SWAP-DM-008: swap_cancelled DM updates to cancelled
  // =========================================================================

  it('UT-SWAP-DM-008: swap_cancelled DM updates to cancelled', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    injectSwapRef(module, ref);

    const cancelledDM = createMockSwapCancelledDM(ref.swapId, 'timeout', true);
    mocks.communications._simulateIncomingDM(
      cancelledDM,
      DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      'escrow',
    );

    await vi.waitFor(async () => {
      const status = await module.getSwapStatus(ref.swapId);
      expect(status.progress).toBe('cancelled');
    });

    // Verify swap:cancelled event
    const cancelEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:cancelled',
    );
    expect(cancelEvent).toBeDefined();
  });

  // =========================================================================
  // UT-SWAP-DM-009: bounce_notification DM emits swap:bounce_received
  // =========================================================================

  it('UT-SWAP-DM-009: bounce_notification DM emits swap:bounce_received', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'awaiting_counter',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId: 'test-deposit-invoice-004',
    });
    injectSwapRef(module, ref);

    const bounceDM = createMockBounceNotificationDM(
      ref.swapId, 'WRONG_CURRENCY', '1000000', 'UCT',
    );
    mocks.communications._simulateIncomingDM(
      bounceDM,
      DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      'escrow',
    );

    // Verify swap:bounce_received was emitted
    await vi.waitFor(() => {
      const bounceEvent = mocks.emitEvent._calls.find(
        ([type]) => type === 'swap:bounce_received',
      );
      expect(bounceEvent).toBeDefined();
      expect(bounceEvent![1]).toMatchObject({
        swapId: ref.swapId,
        reason: 'WRONG_CURRENCY',
        returnedAmount: '1000000',
        returnedCurrency: 'UCT',
      });
    });
  });

  // =========================================================================
  // UT-SWAP-DM-010: Malformed DM silently ignored
  // =========================================================================

  it('UT-SWAP-DM-010: malformed DM silently ignored', async () => {
    const swapsBefore = module.getSwaps();
    const emitCallsBefore = mocks.emitEvent._calls.length;

    // Send non-JSON content
    mocks.communications._simulateIncomingDM(
      'this is not JSON or a swap message',
      DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    );

    // Allow microtask queue to drain
    await new Promise(r => setTimeout(r, 50));

    // No new swaps created
    expect(module.getSwaps().length).toBe(swapsBefore.length);
    // No swap events emitted (the emitEvent calls after should be same count)
    const swapEmitCalls = mocks.emitEvent._calls
      .slice(emitCallsBefore)
      .filter(([type]) => (type as string).startsWith('swap:'));
    expect(swapEmitCalls.length).toBe(0);
  });

  // =========================================================================
  // UT-SWAP-DM-011: DM from unknown sender ignored (sender doesn't match
  // escrow pubkey)
  // =========================================================================

  it('UT-SWAP-DM-011: DM from unknown sender ignored', async () => {
    // Inject a swap that is in 'proposed' state as proposer
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, ref);

    // Send acceptance DM from an unknown party C (not the counterparty)
    const unknownPubkey = 'c'.repeat(64);
    const acceptanceDM = createMockAcceptanceDM(ref.swapId);
    mocks.communications._simulateIncomingDM(
      acceptanceDM,
      unknownPubkey,
      'charlie',
    );

    // Allow microtask queue to drain
    await new Promise(r => setTimeout(r, 50));

    // Swap should still be in 'proposed' (not accepted)
    const status = await module.getSwapStatus(ref.swapId);
    expect(status.progress).toBe('proposed');
  });

  // =========================================================================
  // UT-SWAP-DM-012: DM for unknown swap_id handled gracefully
  // =========================================================================

  it('UT-SWAP-DM-012: DM for unknown swap_id handled gracefully', async () => {
    const unknownSwapId = 'a'.repeat(64);
    const emitCallsBefore = mocks.emitEvent._calls.length;

    // Send acceptance DM for a swap that does not exist
    const acceptanceDM = createMockAcceptanceDM(unknownSwapId);
    mocks.communications._simulateIncomingDM(
      acceptanceDM,
      DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    );

    // Allow microtask queue to drain
    await new Promise(r => setTimeout(r, 50));

    // No new swaps created (acceptance does not create swaps)
    const swaps = module.getSwaps();
    const match = swaps.find(s => s.swapId === unknownSwapId);
    expect(match).toBeUndefined();

    // No swap events emitted for the unknown swap
    const swapEmitCalls = mocks.emitEvent._calls
      .slice(emitCallsBefore)
      .filter(([type]) => (type as string).startsWith('swap:'));
    expect(swapEmitCalls.length).toBe(0);
  });
});
