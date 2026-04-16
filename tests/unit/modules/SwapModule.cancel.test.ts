/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for SwapModule.cancelSwap()
 *
 * 7 tests total:
 *   UT-SWAP-CANCEL-001 through UT-SWAP-CANCEL-007
 *
 * @see docs/SWAP-TEST-SPEC.md §3.7
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  createMockSwapCancelledDM,
  injectSwapRef,
  DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
  DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  SphereError,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import type { SwapRef } from '../../../modules/swap/types.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let module: SwapModule;
let mocks: TestSwapModuleMocks;

const DEPOSIT_INVOICE_ID = 'mock-deposit-invoice-cancel';

// ---------------------------------------------------------------------------
// cancelSwap()
// ---------------------------------------------------------------------------

describe('SwapModule.cancelSwap()', () => {
  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
  });

  it('UT-SWAP-CANCEL-001: pre-announcement cancel marks cancelled locally', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, ref);

    await module.cancelSwap(ref.swapId);

    const updatedSwap = (module as any).swaps.get(ref.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('cancelled');

    // No DM should be sent to escrow (pre-announcement — escrow not involved yet)
    const escrowDMs = mocks.communications._sentDMs.filter(
      (dm) => dm.recipient === DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
    );
    expect(escrowDMs.length).toBe(0);
  });

  it('UT-SWAP-CANCEL-002: emits swap:cancelled with reason=explicit', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, ref);

    await module.cancelSwap(ref.swapId);

    const cancelledEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:cancelled',
    );
    expect(cancelledEvent).toBeDefined();
    expect(cancelledEvent![1]).toEqual(
      expect.objectContaining({
        swapId: ref.swapId,
        reason: 'explicit',
      }),
    );
  });

  it('UT-SWAP-CANCEL-003: already completed throws SWAP_ALREADY_COMPLETED', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'completed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, ref);

    await expect(module.cancelSwap(ref.swapId)).rejects.toMatchObject({ code: 'SWAP_ALREADY_COMPLETED' });
  });

  it('UT-SWAP-CANCEL-004: already cancelled throws SWAP_ALREADY_CANCELLED', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'cancelled',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, ref);

    await expect(module.cancelSwap(ref.swapId)).rejects.toMatchObject({ code: 'SWAP_ALREADY_CANCELLED' });
  });

  it('UT-SWAP-CANCEL-005: escrow swap_cancelled DM updates local state', async () => {
    // Inject a swap in 'awaiting_counter' state so escrow cancellation is relevant
    const ref = createTestSwapRef({
      role: 'acceptor',
      progress: 'awaiting_counter',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId: DEPOSIT_INVOICE_ID,
    });
    injectSwapRef(module, ref);

    // Simulate escrow swap_cancelled DM
    const cancelledDMContent = createMockSwapCancelledDM(ref.swapId, 'timeout', true);
    mocks.communications._simulateIncomingDM(
      cancelledDMContent,
      DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      'escrow',
    );

    // Allow async handler to process
    await vi.waitFor(() => {
      const updatedSwap = (module as any).swaps.get(ref.swapId) as SwapRef;
      expect(updatedSwap.progress).toBe('cancelled');
    });
  });

  it('UT-SWAP-CANCEL-006: cancellation clears local timer', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    injectSwapRef(module, ref);

    // Set up a timer to verify it gets cleared
    const timerMap = (module as any).localTimers as Map<string, ReturnType<typeof setTimeout>> | undefined;
    if (timerMap) {
      const timer = setTimeout(() => {}, 60000);
      timerMap.set(ref.swapId, timer);
    }

    await module.cancelSwap(ref.swapId);

    // Timer should be cleared
    if (timerMap) {
      expect(timerMap.has(ref.swapId)).toBe(false);
    }

    // Verify swap is cancelled
    const updatedSwap = (module as any).swaps.get(ref.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('cancelled');
  });

  it('UT-SWAP-CANCEL-007: deposit return tracked after cancellation', async () => {
    // Inject a cancelled swap with deposit invoice
    const ref = createTestSwapRef({
      role: 'acceptor',
      progress: 'awaiting_counter',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId: DEPOSIT_INVOICE_ID,
    });
    injectSwapRef(module, ref);

    // Simulate invoice:return_received event from accounting module
    // (this fires when escrow returns deposits after cancellation)
    mocks.accounting._emit('invoice:return_received', {
      invoiceId: DEPOSIT_INVOICE_ID,
      transfer: {
        transferId: 'return-transfer-001',
        invoiceId: DEPOSIT_INVOICE_ID,
        coinId: 'UCT',
        amount: '1000000',
        direction: 'back',
        senderPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
        confirmed: true,
        timestamp: Date.now(),
      },
      returnReason: 'cancellation',
    });

    // Allow async handler to process
    await vi.waitFor(() => {
      const returnEvent = mocks.emitEvent._calls.find(
        ([type]) => type === 'swap:deposit_returned',
      );
      expect(returnEvent).toBeDefined();
    });

    // The swap should have transitioned to cancelled (from return handler)
    const updatedSwap = (module as any).swaps.get(ref.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('cancelled');
  });
});
