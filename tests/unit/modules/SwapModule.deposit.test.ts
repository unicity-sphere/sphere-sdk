/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for SwapModule.deposit()
 *
 * 8 tests total:
 *   UT-SWAP-DEP-001 through UT-SWAP-DEP-008
 *
 * @see docs/SWAP-TEST-SPEC.md §3.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  createTestSwapDeal,
  injectSwapRef,
  DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  SphereError,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import type { SwapRef } from '../../../modules/swap/types.js';
import type { TransferResult } from '../../../types/index.js';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let module: SwapModule;
let mocks: TestSwapModuleMocks;

const DEPOSIT_INVOICE_ID = 'mock-deposit-invoice-abc123';

/**
 * Create a swap in 'announced' state with a depositInvoiceId.
 * By default the local identity matches party A.
 */
function setupAnnouncedSwap(overrides?: Partial<SwapRef>): SwapRef {
  const ref = createTestSwapRef({
    role: 'acceptor',
    progress: 'announced',
    counterpartyPubkey: DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
    escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
    escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    depositInvoiceId: DEPOSIT_INVOICE_ID,
    ...overrides,
  });
  injectSwapRef(module, ref);
  return ref;
}

// ---------------------------------------------------------------------------
// deposit()
// ---------------------------------------------------------------------------

describe('SwapModule.deposit()', () => {
  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
  });

  it('UT-SWAP-DEP-001: party A deposit uses assetIndex=0', async () => {
    // Default identity is party A (DEFAULT_TEST_PARTY_A_ADDRESS)
    const ref = setupAnnouncedSwap();

    await module.deposit(ref.swapId);

    expect(mocks.accounting.payInvoice).toHaveBeenCalledTimes(1);
    const [invoiceId, params] = mocks.accounting.payInvoice.mock.calls[0];
    expect(invoiceId).toBe(DEPOSIT_INVOICE_ID);
    expect(params.assetIndex).toBe(0); // party A = index 0
    expect(params.targetIndex).toBe(0);
  });

  it('UT-SWAP-DEP-002: party B deposit uses assetIndex=1', async () => {
    // Create a deal where party B is the local identity address
    const deal = createTestSwapDeal({
      partyA: DEFAULT_TEST_PARTY_B_ADDRESS, // swap parties so local matches B
      partyB: DEFAULT_TEST_PARTY_A_ADDRESS,
    });
    const ref = setupAnnouncedSwap({ deal });

    await module.deposit(ref.swapId);

    expect(mocks.accounting.payInvoice).toHaveBeenCalledTimes(1);
    const [invoiceId, params] = mocks.accounting.payInvoice.mock.calls[0];
    expect(invoiceId).toBe(DEPOSIT_INVOICE_ID);
    expect(params.assetIndex).toBe(1); // party B = index 1
  });

  it('UT-SWAP-DEP-003: transitions to depositing', async () => {
    const ref = setupAnnouncedSwap();

    await module.deposit(ref.swapId);

    const updatedSwap = (module as any).swaps.get(ref.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('depositing');
  });

  it('UT-SWAP-DEP-004: emits swap:deposit_sent with TransferResult', async () => {
    const expectedTransferResult: TransferResult = {
      id: 'mock-pay-transfer-id',
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    };
    mocks.accounting._payResult = expectedTransferResult;

    const ref = setupAnnouncedSwap();

    await module.deposit(ref.swapId);

    const depositEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:deposit_sent',
    );
    expect(depositEvent).toBeDefined();
    expect(depositEvent![1]).toEqual(
      expect.objectContaining({
        swapId: ref.swapId,
        transferResult: expect.objectContaining({ id: 'mock-pay-transfer-id' }),
      }),
    );
  });

  it('UT-SWAP-DEP-005: wrong state throws SWAP_WRONG_STATE', async () => {
    const ref = createTestSwapRef({
      role: 'acceptor',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
      depositInvoiceId: DEPOSIT_INVOICE_ID,
    });
    injectSwapRef(module, ref);

    await expect(module.deposit(ref.swapId)).rejects.toMatchObject({ code: 'SWAP_WRONG_STATE' });
  });

  it('UT-SWAP-DEP-006: payInvoice failure throws SWAP_DEPOSIT_FAILED', async () => {
    const ref = setupAnnouncedSwap();

    const payError = new Error('Insufficient balance');
    mocks.accounting.payInvoice.mockRejectedValueOnce(payError);

    await expect(module.deposit(ref.swapId)).rejects.toMatchObject({ code: 'SWAP_DEPOSIT_FAILED' });
  });

  it('UT-SWAP-DEP-007: no depositInvoiceId throws SWAP_WRONG_STATE', async () => {
    const ref = createTestSwapRef({
      role: 'acceptor',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      // No depositInvoiceId
    });
    // Ensure depositInvoiceId is undefined
    delete (ref as any).depositInvoiceId;
    injectSwapRef(module, ref);

    await expect(module.deposit(ref.swapId)).rejects.toMatchObject({ code: 'SWAP_WRONG_STATE' });
  });

  it('UT-SWAP-DEP-008: stores localDepositTransferId on success', async () => {
    const customResult: TransferResult = {
      id: 'tx-123',
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    };
    mocks.accounting._payResult = customResult;

    const ref = setupAnnouncedSwap();

    await module.deposit(ref.swapId);

    const updatedSwap = (module as any).swaps.get(ref.swapId) as SwapRef;
    expect(updatedSwap.localDepositTransferId).toBe('tx-123');
  });
});
