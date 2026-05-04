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
 * Create a swap in 'announced' state with a depositInvoiceId, and seed the
 * mock accounting module with a corresponding 2-asset deposit invoice.
 *
 * Real escrows construct the deposit invoice with assets in
 * `[party_a_currency, party_b_currency]` order, but the SDK's
 * `canonicalSerialize()` then re-orders them by coinId for hash-determinism.
 * The seeded invoice mirrors that post-canonical state: assets are sorted by
 * coinId. SwapModule.deposit() must select the right asset by *currency*,
 * not by position.
 *
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

  // Seed the deposit invoice in the mock accounting store. Assets ordered
  // canonically (sort by coinId ascending) — same shape the real
  // canonicalSerialize() produces.
  const m = ref.manifest;
  const sortedAssets = [
    { coin: [m.party_a_currency_to_change, m.party_a_value_to_change] as [string, string] },
    { coin: [m.party_b_currency_to_change, m.party_b_value_to_change] as [string, string] },
  ].sort((a, b) =>
    a.coin[0] < b.coin[0] ? -1 : a.coin[0] > b.coin[0] ? 1 : 0,
  );
  mocks.accounting._invoices.set(DEPOSIT_INVOICE_ID, {
    invoiceId: DEPOSIT_INVOICE_ID,
    terms: {
      creator: ref.escrowPubkey,
      createdAt: Date.now(),
      targets: [
        {
          address: DEFAULT_TEST_ESCROW_ADDRESS,
          assets: sortedAssets,
        },
      ],
    },
    isCreator: false,
    cancelled: false,
    closed: false,
  });

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

  // ---------------------------------------------------------------------------
  // UT-SWAP-DEP-009 — Regression: party-currency vs. asset-position skew
  //
  // BUG: Before this fix, SwapModule.deposit() chose `assetIndex` by *party
  // role* (assetIndex=0 for party A, =1 for party B). That assumption broke
  // because `canonicalSerialize()` sorts each target's assets by coinId for
  // hash-determinism. When party A's currency hashes *after* party B's, the
  // sort flips them — and the positional `assetIndex=0` then points at party
  // B's slot, causing party A to deposit the wrong currency.
  //
  // FIX: deposit() now looks up the slot whose coinId matches the party's
  // expected currency from the manifest, ignoring position.
  //
  // This test forces the reverse-sorting case: party A's currency ('ZUSD')
  // sorts AFTER party B's currency ('AUSD'). With the bug, the test would
  // fail because party A would pay slot 0 = AUSD (party B's currency).
  // ---------------------------------------------------------------------------
  it('UT-SWAP-DEP-009: picks asset by currency match when canonical sort flips party-A↔B order', async () => {
    // Party A = 'ZUSD', Party B = 'AUSD'. Sort order: AUSD < ZUSD.
    // After canonical sort, assets[0] = AUSD (party B's), assets[1] = ZUSD (party A's).
    const deal = createTestSwapDeal({
      partyACurrency: 'ZUSD',
      partyBCurrency: 'AUSD',
      partyAAmount: '1000',
      partyBAmount: '2000',
    });
    // Default identity is party A — should look up its expected currency
    // ('ZUSD') in the post-sort assets and find it at index 1, NOT 0.
    const ref = setupAnnouncedSwap({ deal });

    await module.deposit(ref.swapId);

    expect(mocks.accounting.payInvoice).toHaveBeenCalledTimes(1);
    const [invoiceId, params] = mocks.accounting.payInvoice.mock.calls[0];
    expect(invoiceId).toBe(DEPOSIT_INVOICE_ID);
    expect(params.targetIndex).toBe(0);
    // The fix: party A pays the ZUSD slot, which after canonical sort is
    // index 1 (NOT 0 as positional party-A logic would have chosen).
    expect(params.assetIndex).toBe(1);
  });

  it('UT-SWAP-DEP-010: party B with reverse-sorting currencies picks the partner slot', async () => {
    // Same scenario as UT-SWAP-DEP-009 but local identity is party B.
    // Party B's expected currency is 'AUSD' which sorts FIRST → slot 0.
    // With the old bug, party B would have used assetIndex=1 → pay ZUSD (wrong).
    const deal = createTestSwapDeal({
      partyA: DEFAULT_TEST_PARTY_B_ADDRESS, // swap so local identity = party B
      partyB: DEFAULT_TEST_PARTY_A_ADDRESS,
      partyACurrency: 'ZUSD',
      partyBCurrency: 'AUSD',
      partyAAmount: '1000',
      partyBAmount: '2000',
    });
    const ref = setupAnnouncedSwap({ deal });

    await module.deposit(ref.swapId);

    expect(mocks.accounting.payInvoice).toHaveBeenCalledTimes(1);
    const [, params] = mocks.accounting.payInvoice.mock.calls[0];
    // Party B's currency 'AUSD' sorts before 'ZUSD' → slot 0.
    expect(params.assetIndex).toBe(0);
  });

  it('UT-SWAP-DEP-011: throws SWAP_DEPOSIT_FAILED when expected currency missing from invoice', async () => {
    // Manifest declares party A pays 'XYZ' but the seeded invoice contains
    // only the default UCT/USDU pair — the lookup must fail loudly rather
    // than silently picking the wrong slot.
    const ref = setupAnnouncedSwap();
    // Mutate the on-the-fly manifest so the expected currency no longer
    // matches any seeded invoice asset.
    (ref as any).manifest = {
      ...ref.manifest,
      party_a_currency_to_change: 'XYZ',
    };
    (module as any).swaps.set(ref.swapId, ref);

    await expect(module.deposit(ref.swapId)).rejects.toMatchObject({
      code: 'SWAP_DEPOSIT_FAILED',
      message: expect.stringContaining('XYZ'),
    });
  });
});
