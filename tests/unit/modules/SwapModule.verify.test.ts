/**
 * SwapModule.verify.test.ts
 *
 * UT-SWAP-VERIFY-001 through UT-SWAP-VERIFY-009
 * Tests for verifyPayout() method.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  SphereError,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_ESCROW_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';

/**
 * Helper: create a concluding SwapRef with payoutInvoiceId and configure
 * accounting mocks to return valid invoice data for successful verification.
 */
function setupVerifiableSwap(
  module: SwapModule,
  mocks: TestSwapModuleMocks,
  overrides?: {
    payoutCoinId?: string;
    payoutAmount?: string;
    payoutAddress?: string;
    invoiceState?: string;
    isCovered?: boolean;
    netCoveredAmount?: string;
    creator?: string;
    noTargets?: boolean;
    noAssets?: boolean;
  },
) {
  const payoutInvoiceId = 'payout-invoice-001';
  const ref = createTestSwapRef({
    progress: 'concluding',
    payoutInvoiceId,
  });
  injectSwapRef(module, ref);

  // Default: party A proposed UCT-for-USDU, so party A expects USDU payout
  const expectedCoinId = overrides?.payoutCoinId ?? ref.manifest.party_b_currency_to_change; // USDU
  const expectedAmount = overrides?.payoutAmount ?? ref.manifest.party_b_value_to_change; // 500000
  const targetAddress = overrides?.payoutAddress ?? DEFAULT_TEST_PARTY_A_ADDRESS;

  // Mock getInvoice to return invoice ref with terms
  mocks.accounting.getInvoice.mockImplementation((invoiceId: string) => {
    if (invoiceId === payoutInvoiceId) {
      if (overrides?.noTargets) {
        return { invoiceId, terms: { creator: overrides?.creator ?? DEFAULT_TEST_ESCROW_PUBKEY, targets: [] } };
      }
      return {
        invoiceId,
        terms: {
          creator: overrides?.creator ?? DEFAULT_TEST_ESCROW_PUBKEY,
          targets: [
            {
              address: targetAddress,
              assets: overrides?.noAssets
                ? []
                : [{ coin: [expectedCoinId, expectedAmount] }],
            },
          ],
        },
      };
    }
    return null;
  });

  // Mock getInvoiceStatus to return status
  mocks.accounting.getInvoiceStatus.mockImplementation((invoiceId: string) => {
    if (invoiceId === payoutInvoiceId) {
      return {
        invoiceId,
        state: overrides?.invoiceState ?? 'COVERED',
        targets: [
          {
            coinAssets: [
              {
                coin: [expectedCoinId, expectedAmount],
                netCoveredAmount: overrides?.netCoveredAmount ?? expectedAmount,
                isCovered: overrides?.isCovered ?? true,
              },
            ],
          },
        ],
        totalForward: {},
        totalBack: {},
        allConfirmed: true,
        lastActivityAt: Date.now(),
      };
    }
    return { invoiceId, state: 'OPEN', targets: [], totalForward: {}, totalBack: {}, allConfirmed: false, lastActivityAt: 0 };
  });

  return ref;
}

describe('SwapModule — verifyPayout', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const ctx = createTestSwapModule();
    module = ctx.module;
    mocks = ctx.mocks;
    await module.load();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-001: verifyPayout checks coverage
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-001: verifyPayout checks invoice status isCovered', async () => {
    const ref = setupVerifiableSwap(module, mocks);

    const result = await module.verifyPayout(ref.swapId);

    expect(result).toBe(true);
    expect(mocks.accounting.getInvoiceStatus).toHaveBeenCalledWith(ref.payoutInvoiceId);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-002: verifyPayout returns false for wrong currency
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-002: verifyPayout returns false when invoice has wrong currency', async () => {
    // Party A proposed UCT->USDU swap, so payout should be USDU.
    // Set up invoice with WRONG_COIN instead — verifyPayout should return false.
    const ref = setupVerifiableSwap(module, mocks, { payoutCoinId: 'WRONG_COIN' });

    const result = await module.verifyPayout(ref.swapId);

    expect(result).toBe(false);
    // swap:failed event should have been emitted with currency mismatch
    const failedEvents = mocks.emitEvent._calls.filter(([type]) => type === 'swap:failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-003: verifyPayout returns false for wrong amount
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-003: verifyPayout returns false when invoice has wrong amount', async () => {
    // Party A expects 500000 USDU (deal.partyBAmount).
    // Set up invoice with 999 instead — verifyPayout should return false.
    const ref = setupVerifiableSwap(module, mocks, { payoutAmount: '999' });

    const result = await module.verifyPayout(ref.swapId);

    expect(result).toBe(false);
    const failedEvents = mocks.emitEvent._calls.filter(([type]) => type === 'swap:failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-004: verifyPayout transitions to 'completed' on success
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-004: verifyPayout transitions to completed on success', async () => {
    const ref = setupVerifiableSwap(module, mocks);

    await module.verifyPayout(ref.swapId);

    const status = await module.getSwapStatus(ref.swapId, { queryEscrow: false });
    expect(status.progress).toBe('completed');
    expect(status.payoutVerified).toBe(true);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-005: verifyPayout emits swap:completed
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-005: verifyPayout emits swap:completed event', async () => {
    const ref = setupVerifiableSwap(module, mocks);

    await module.verifyPayout(ref.swapId);

    const completedEvents = mocks.emitEvent._calls.filter(([type]) => type === 'swap:completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0][1]).toEqual(
      expect.objectContaining({ swapId: ref.swapId, payoutVerified: true }),
    );
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-006: verifyPayout returns false if not yet covered
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-006: verifyPayout returns false if not yet covered', async () => {
    const ref = setupVerifiableSwap(module, mocks, {
      invoiceState: 'OPEN',
      isCovered: false,
      netCoveredAmount: '0',
    });

    const result = await module.verifyPayout(ref.swapId);

    expect(result).toBe(false);
    // Progress should remain concluding (not transitioned)
    const status = await module.getSwapStatus(ref.swapId, { queryEscrow: false });
    expect(status.progress).toBe('concluding');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-007: verifyPayout returns false if wrong currency
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-007: verifyPayout returns false if wrong currency in payout', async () => {
    // Payout has WRONG_COIN instead of expected USDU
    const ref = setupVerifiableSwap(module, mocks, { payoutCoinId: 'WRONG_COIN' });

    const result = await module.verifyPayout(ref.swapId);

    expect(result).toBe(false);
    // swap:failed event should have been emitted
    const failedEvents = mocks.emitEvent._calls.filter(([type]) => type === 'swap:failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-008: verifyPayout returns false if wrong amount
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-008: verifyPayout returns false if wrong amount in payout', async () => {
    // Payout has 999 instead of expected 500000
    const ref = setupVerifiableSwap(module, mocks, { payoutAmount: '999' });

    const result = await module.verifyPayout(ref.swapId);

    expect(result).toBe(false);
    const failedEvents = mocks.emitEvent._calls.filter(([type]) => type === 'swap:failed');
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-VERIFY-009: No payoutInvoiceId throws SWAP_WRONG_STATE
  // --------------------------------------------------------------------------
  it('UT-SWAP-VERIFY-009: verifyPayout with no payoutInvoiceId throws SWAP_WRONG_STATE', async () => {
    const ref = createTestSwapRef({
      progress: 'awaiting_counter',
      // No payoutInvoiceId
    });
    injectSwapRef(module, ref);

    try {
      await module.verifyPayout(ref.swapId);
      expect.fail('Expected SphereError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('SWAP_WRONG_STATE');
    }
  });
});
