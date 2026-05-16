/**
 * Forced-conservative coercion (T.7.D / W21)
 *
 * Verifies AccountingModule.payInvoice() silently coerces a caller-supplied
 * `allowPendingTokens=true` to `false` whenever the invoice has been marked
 * escrow-bridged (per §2.5 last paragraph). The coercion is surfaced via
 * `TransferResult.overrides = ['allowPendingTokens-coerced-to-false']`.
 *
 * W21 acceptance criterion: "every payInvoice call-site that triggers
 * coercion is enumerated by a test." There is exactly one call-site —
 * `payInvoice()` itself — but the test matrix exercises every flag/state
 * combination that determines whether the coercion triggers, so any future
 * regression at the single site (or any new call-site forwarding to it)
 * will surface here.
 *
 * Test IDs: UT-T7D-COERCE-001 through UT-T7D-COERCE-009.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  DEFAULT_TEST_IDENTITY,
  INVOICE_TOKEN_TYPE_HEX,
} from '../modules/accounting-test-helpers.js';
import { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';
import type { Token, TransferRequest, TransferResult } from '../../../types/index.js';

// =============================================================================
// Fixtures
// =============================================================================

/** Invoice ID used across all tests — 64-char lowercase hex. */
const INVOICE_ID = 'b'.repeat(64);

/** External payee address — distinct from the wallet identity to bypass self-payment filters. */
const PAYEE_ADDRESS = 'DIRECT://escrow_payee_target_xyz';

/** Stable override marker — must match the constant in AccountingModule. */
const OVERRIDE_MARKER = AccountingModule.OVERRIDE_FORCED_CONSERVATIVE;

/** Build minimal invoice terms with the wallet as the creator and an external payee target. */
function makeTerms(): InvoiceTerms {
  return {
    creator: DEFAULT_TEST_IDENTITY.chainPubkey,
    createdAt: Date.now() - 1000,
    targets: [
      {
        address: PAYEE_ADDRESS,
        assets: [{ coin: ['UCT', '1000'] }],
      },
    ],
  };
}

/** Wrap an InvoiceTerms in a Token shape that load() will recognise as an invoice. */
function makeInvoiceToken(terms: InvoiceTerms): Token {
  const txf = createTestToken(terms, INVOICE_ID);
  return {
    id: INVOICE_ID,
    coinId: INVOICE_TOKEN_TYPE_HEX,
    symbol: 'INV',
    name: 'Invoice',
    decimals: 0,
    amount: '0',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

/**
 * Returns the most recent `TransferRequest` argument forwarded to the mocked
 * `payments.send()`. Throws if `send` was never called.
 */
function lastSendRequest(send: { mock: { calls: unknown[][] } }): TransferRequest {
  const calls = send.mock.calls;
  if (calls.length === 0) {
    throw new Error('payments.send() was not called');
  }
  return calls[calls.length - 1]![0] as TransferRequest;
}

// =============================================================================
// Test suite
// =============================================================================

describe('AccountingModule.payInvoice() — forced-conservative coercion (T.7.D / W21)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Baseline: non-escrow invoice — no coercion, flag passes through.
  // ---------------------------------------------------------------------------

  it('UT-T7D-COERCE-001: non-escrow invoice passes allowPendingTokens=true through verbatim', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(false);

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      allowPendingTokens: true,
    });

    const sendReq = lastSendRequest(mocks.payments.send);
    expect(sendReq.allowPendingTokens).toBe(true);
    expect(result.overrides).toBeUndefined();
  });

  it('UT-T7D-COERCE-002: non-escrow invoice passes allowPendingTokens=false through verbatim', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      allowPendingTokens: false,
    });

    const sendReq = lastSendRequest(mocks.payments.send);
    expect(sendReq.allowPendingTokens).toBe(false);
    expect(result.overrides).toBeUndefined();
  });

  it('UT-T7D-COERCE-003: non-escrow invoice with allowPendingTokens omitted defaults to false', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
    });

    const sendReq = lastSendRequest(mocks.payments.send);
    // Caller did not opt into chain-mode source selection — the request
    // forwards `false` (the requested-default) and no coercion fires.
    expect(sendReq.allowPendingTokens).toBe(false);
    expect(result.overrides).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Escrow-bridged: coerce true → false, surface override marker.
  // ---------------------------------------------------------------------------

  it('UT-T7D-COERCE-004: escrow-bridged invoice silently coerces allowPendingTokens=true to false', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    module.markInvoiceEscrowBridged(INVOICE_ID);
    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(true);

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      allowPendingTokens: true,
    });

    // 1. send() received the coerced flag
    const sendReq = lastSendRequest(mocks.payments.send);
    expect(sendReq.allowPendingTokens).toBe(false);

    // 2. TransferResult carries the override marker
    expect(result.overrides).toBeDefined();
    expect(result.overrides).toContain(OVERRIDE_MARKER);
    expect(result.overrides).toEqual(['allowPendingTokens-coerced-to-false']);
  });

  it('UT-T7D-COERCE-005: escrow-bridged invoice with allowPendingTokens=false does NOT add override marker', async () => {
    // Coercion only fires when the caller actually requested chain-mode.
    // If the caller already passed false, the result is unchanged — there is
    // nothing to coerce, so no override is surfaced.
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    module.markInvoiceEscrowBridged(INVOICE_ID);

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      allowPendingTokens: false,
    });

    const sendReq = lastSendRequest(mocks.payments.send);
    expect(sendReq.allowPendingTokens).toBe(false);
    expect(result.overrides).toBeUndefined();
  });

  it('UT-T7D-COERCE-006: escrow-bridged invoice with allowPendingTokens omitted does NOT add override marker', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    module.markInvoiceEscrowBridged(INVOICE_ID);

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
    });

    const sendReq = lastSendRequest(mocks.payments.send);
    expect(sendReq.allowPendingTokens).toBe(false);
    expect(result.overrides).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Marker lifecycle: register, unregister, idempotent.
  // ---------------------------------------------------------------------------

  it('UT-T7D-COERCE-007: unmarkInvoiceEscrowBridged disables coercion for subsequent calls', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    module.markInvoiceEscrowBridged(INVOICE_ID);

    // Stub send to avoid ledger pollution making the second call complete-by-coverage.
    let sendCallCount = 0;
    mocks.payments.send.mockImplementation((): Promise<TransferResult> => {
      sendCallCount++;
      return Promise.resolve({
        id: `mock-transfer-${sendCallCount}`,
        status: 'completed',
        tokens: [],
        tokenTransfers: [],
      });
    });

    // First call: coerced.
    const r1 = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '100',
      allowPendingTokens: true,
    });
    expect(r1.overrides).toEqual([OVERRIDE_MARKER]);

    // Unmark and re-call.
    module.unmarkInvoiceEscrowBridged(INVOICE_ID);
    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(false);

    const r2 = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '100',
      allowPendingTokens: true,
    });

    const sendReq2 = mocks.payments.send.mock.calls[1]![0] as TransferRequest;
    expect(sendReq2.allowPendingTokens).toBe(true);
    expect(r2.overrides).toBeUndefined();
  });

  it('UT-T7D-COERCE-008: markInvoiceEscrowBridged is idempotent', async () => {
    const { module } = createTestAccountingModule();

    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(false);
    module.markInvoiceEscrowBridged(INVOICE_ID);
    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(true);
    // Re-marking is a no-op.
    module.markInvoiceEscrowBridged(INVOICE_ID);
    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(true);
    // Unmarking an unbridged invoice is a no-op.
    module.unmarkInvoiceEscrowBridged(INVOICE_ID);
    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(false);
    module.unmarkInvoiceEscrowBridged(INVOICE_ID);
    expect(module.isInvoiceEscrowBridged(INVOICE_ID)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Override merging: do not double-append if a downstream layer already added it.
  // ---------------------------------------------------------------------------

  it('UT-T7D-COERCE-009: override marker is appended exactly once even if downstream layer pre-populated it', async () => {
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(makeTerms())];
    await module.load();

    module.markInvoiceEscrowBridged(INVOICE_ID);

    // Simulate a downstream PaymentsModule that performs its own coercion and
    // pre-populates `overrides` on the TransferResult. AccountingModule must
    // be idempotent w.r.t. the marker — it must NOT append a duplicate.
    mocks.payments.send.mockResolvedValue({
      id: 'mock-transfer-pre-coerced',
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
      overrides: [OVERRIDE_MARKER],
    });

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      allowPendingTokens: true,
    });

    expect(result.overrides).toEqual([OVERRIDE_MARKER]);
    expect((result.overrides ?? []).filter((m) => m === OVERRIDE_MARKER).length).toBe(1);
  });
});
