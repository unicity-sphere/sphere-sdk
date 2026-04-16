/**
 * AccountingModule — setAutoReturn() / getAutoReturnSettings()
 *
 * Tests for the auto-return settings management (§3.11 of ACCOUNTING-TEST-SPEC.md).
 *
 * Test IDs: UT-AUTORET-001 through UT-AUTORET-009
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  advanceTime,
  SphereError,
} from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    createdAt: Date.now() - 1000,
    dueDate: Date.now() + 86400000,
    targets: [
      {
        address: 'DIRECT://test_target_address_abc123',
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    ...overrides,
  };
}

/**
 * Injects invoice terms directly into the module's internal cache, bypassing
 * the crypto proof verification in importInvoice(). This is necessary because
 * createTestToken() generates synthetic proofs that fail real verification.
 */
function injectInvoice(
  module: AccountingModule,
  terms: InvoiceTerms,
  tokenId?: string,
): string {
  const id = tokenId ?? Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (module as any).invoiceTermsCache.set(id, terms);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(module as any).invoiceLedger.has(id)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).invoiceLedger.set(id, new Map());
  }
  return id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AccountingModule — setAutoReturn / getAutoReturnSettings', () => {
  let module: ReturnType<typeof createTestAccountingModule>['module'];
  let mocks: ReturnType<typeof createTestAccountingModule>['mocks'];

  beforeEach(async () => {
    ({ module, mocks } = createTestAccountingModule());
    await module.load();
  });

  afterEach(() => {
    module.destroy();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-009: Initial state before any setAutoReturn()
  // -------------------------------------------------------------------------
  it('UT-AUTORET-009: getAutoReturnSettings() returns default {global:false, perInvoice:{}} before any calls', () => {
    const settings = module.getAutoReturnSettings();

    expect(settings.global).toBe(false);
    expect(settings.perInvoice).toEqual({});
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-001: Set auto-return globally
  // -------------------------------------------------------------------------
  it('UT-AUTORET-001: setAutoReturn("*", true) enables global auto-return', async () => {
    await module.setAutoReturn('*', true);

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(true);
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-002: Disable global auto-return
  // -------------------------------------------------------------------------
  it('UT-AUTORET-002: setAutoReturn("*", false) disables global auto-return', async () => {
    await module.setAutoReturn('*', true);

    // Advance past the 5-second cooldown
    advanceTime(6000);
    await module.setAutoReturn('*', false);

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-003: Set auto-return for specific invoice
  // -------------------------------------------------------------------------
  it('UT-AUTORET-003: setAutoReturn(invoiceId, true) enables only the specified invoice', async () => {
    const terms1 = makeTerms();
    const terms2 = makeTerms({ memo: 'Invoice 2' });
    const invoiceId1 = await injectInvoice(module, terms1);
    const invoiceId2 = await injectInvoice(module, terms2);

    await module.setAutoReturn(invoiceId1, true);

    const settings = module.getAutoReturnSettings();
    expect(settings.perInvoice[invoiceId1]).toBe(true);
    expect(settings.perInvoice[invoiceId2]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-004: Global cooldown — 5-second window
  // -------------------------------------------------------------------------
  it('UT-AUTORET-004: second setAutoReturn("*") within 5s throws RATE_LIMITED', async () => {
    const baseTime = Date.now();
    // First call at baseTime — no cooldown issue (autoReturnLastGlobalSet starts at 0)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await module.setAutoReturn('*', true);

    // Within the 5-second window (baseTime + 2s)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 2000);

    await expect(module.setAutoReturn('*', false)).rejects.toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
  });

  it('UT-AUTORET-004b: setAutoReturn("*") succeeds after 5s cooldown expires', async () => {
    const baseTime = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await module.setAutoReturn('*', true);

    // Past the 5-second cooldown (baseTime + 6s)
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 6000);
    await expect(module.setAutoReturn('*', false)).resolves.not.toThrow();

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-005: Per-invoice setAutoReturn not rate-limited
  // -------------------------------------------------------------------------
  it('UT-AUTORET-005: per-invoice setAutoReturn calls are not rate-limited', async () => {
    const invoiceId1 = await injectInvoice(module, makeTerms());
    const invoiceId2 = await injectInvoice(module, makeTerms({ memo: 'second' }));

    // Rapid sequential calls for different invoices should not throw
    await expect(module.setAutoReturn(invoiceId1, true)).resolves.not.toThrow();
    await expect(module.setAutoReturn(invoiceId2, true)).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-006: getAutoReturnSettings() is synchronous
  // -------------------------------------------------------------------------
  it('UT-AUTORET-006: getAutoReturnSettings() returns AutoReturnSettings synchronously', async () => {
    await module.setAutoReturn('*', true);

    // Must be synchronous — no await needed
    const settings = module.getAutoReturnSettings();

    expect(typeof settings.global).toBe('boolean');
    expect(typeof settings.perInvoice).toBe('object');
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-007: Get per-invoice settings
  // -------------------------------------------------------------------------
  it('UT-AUTORET-007: getAutoReturnSettings() shows per-invoice override map', async () => {
    const invoiceId1 = await injectInvoice(module, makeTerms());
    const invoiceId2 = await injectInvoice(module, makeTerms({ memo: 'inv2' }));

    await module.setAutoReturn(invoiceId1, true);
    await module.setAutoReturn(invoiceId2, false);

    const settings = module.getAutoReturnSettings();
    expect(settings.perInvoice[invoiceId1]).toBe(true);
    expect(settings.perInvoice[invoiceId2]).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-008: INVOICE_NOT_FOUND for unknown invoiceId
  // -------------------------------------------------------------------------
  it('UT-AUTORET-008: setAutoReturn(unknownId) throws INVOICE_NOT_FOUND', async () => {
    await expect(module.setAutoReturn('nonexistent_id_not_64_hex', true)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_FOUND' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-AUTORET-009 (duplicate check for initial state already tested above)
  // Additional: setAutoReturn('*', true) processes terminated invoices
  // -------------------------------------------------------------------------
  it('UT-AUTORET-009b: setAutoReturn("*", true) processes terminated invoices', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    await module.closeInvoice(invoiceId);

    // The send mock returns success
    mocks.payments.send.mockResolvedValue({
      id: 'auto-return-id',
      status: 'completed',
      tokens: [],
      tokenTransfers: [],
    });

    // Should not throw when processing terminated invoices
    await expect(module.setAutoReturn('*', true)).resolves.not.toThrow();

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(true);
  });
});
