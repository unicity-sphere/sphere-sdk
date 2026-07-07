/**
 * AccountingModule — sendInvoiceReceipts() + sendCancellationNotices()
 *
 * Combined receipt and cancellation notice tests.
 * Corresponds to §3.22 (UT-RECEIPTS-001 through UT-RECEIPTS-016) and
 * §3.23 (UT-NOTICES-001 through UT-NOTICES-014) of ACCOUNTING-TEST-SPEC.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  SphereError,
} from './accounting-test-helpers.js';
import type {
  InvoiceTerms,
  FrozenInvoiceBalances,
  FrozenTargetBalances,
  FrozenCoinAssetBalances,
  FrozenSenderBalance,
} from '../../../modules/accounting/types.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTerms(
  targetAddress = 'DIRECT://test_target_address_abc123',
  overrides?: Partial<InvoiceTerms>,
): InvoiceTerms {
  return {
    createdAt: Date.now() - 1000,
    dueDate: Date.now() + 86400000,
    targets: [
      {
        address: targetAddress,
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    ...overrides,
  };
}

/**
 * Injects invoice terms directly into the module's internal cache, bypassing
 * the crypto proof verification in importInvoice(). createTestToken() generates
 * synthetic proofs that fail real SdkToken.verify() — use direct injection for tests.
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

/**
 * Builds a FrozenSenderBalance with sensible defaults.
 */
function makeFrozenSender(
  senderAddress: string,
  netBalance: string,
  contacts: Array<{ address: string }> = [],
): FrozenSenderBalance {
  return {
    senderAddress,
    contacts,
    netBalance,
  };
}

/**
 * Injects FrozenInvoiceBalances directly into the module's internal frozenBalances map.
 * Simulates the state after closeInvoice() / cancelInvoice() with pre-existing payments.
 */
function injectFrozenBalances(
  module: AccountingModule,
  invoiceId: string,
  frozen: FrozenInvoiceBalances,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (module as any).frozenBalances.set(invoiceId, frozen);
  if (frozen.state === 'CLOSED') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).closedInvoices.add(invoiceId);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).cancelledInvoices.add(invoiceId);
  }
}

/**
 * Builds a minimal FrozenInvoiceBalances snapshot with one target and one sender.
 */
function buildFrozen(
  targetAddress: string,
  state: 'CLOSED' | 'CANCELLED',
  senders: FrozenSenderBalance[],
): FrozenInvoiceBalances {
  const coinAsset: FrozenCoinAssetBalances = {
    coin: ['UCT', '10000000'],
    coveredAmount: '10000000',
    returnedAmount: '0',
    netCoveredAmount: '10000000',
    isCovered: true,
    surplusAmount: '0',
    confirmed: false,
    transfers: [],
    frozenSenderBalances: senders,
  };
  const target: FrozenTargetBalances = {
    address: targetAddress,
    coinAssets: [coinAsset],
    nftAssets: [],
    isCovered: true,
    confirmed: false,
  };
  return {
    state,
    frozenAt: Date.now(),
    targets: [target],
    irrelevantTransfers: [],
    totalForward: { UCT: '10000000' },
    totalBack: {},
    lastActivityAt: Date.now() - 100,
  };
}

// ---------------------------------------------------------------------------
// sendInvoiceReceipts tests
// ---------------------------------------------------------------------------

describe('AccountingModule — sendInvoiceReceipts()', () => {
  let module: ReturnType<typeof createTestAccountingModule>['module'];
  let mocks: ReturnType<typeof createTestAccountingModule>['mocks'];
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const built = createTestAccountingModule();
    module = built.module;
    mocks = built.mocks;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();
  });

  afterEach(() => {
    module.destroy();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-001: Happy path — send receipts for CLOSED invoice
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-001: sends receipts for CLOSED invoice; returns {sent,failed}', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '3000000', [{ address: 'DIRECT://senderB' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [senderA, senderB],
    ));

    const result = await module.sendInvoiceReceipts(invoiceId);

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(mocks.communications.sendDM).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-002: Happy path — send receipts for CANCELLED invoice
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-002: sends receipts for CANCELLED invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [sender],
    ));

    const result = await module.sendInvoiceReceipts(invoiceId);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-003: Receipt DM content starts with 'invoice_receipt:' prefix
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-003: DM content starts with "invoice_receipt:" prefix', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [sender],
    ));

    await module.sendInvoiceReceipts(invoiceId);

    const [, content] = mocks.communications.sendDM.mock.calls[0];
    expect(content).toMatch(/^invoice_receipt:/);
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-004: Custom memo included in receipt DM
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-004: custom memo is included in receipt payload', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [sender],
    ));

    await module.sendInvoiceReceipts(invoiceId, { memo: 'Thank you!' });

    const [, content] = mocks.communications.sendDM.mock.calls[0];
    const payload = JSON.parse(content.slice('invoice_receipt:'.length));
    expect(payload.memo).toBe('Thank you!');
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-005: includeZeroBalance sends to zero-balance senders
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-005: includeZeroBalance:true sends to zero-balance senders', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '0', [{ address: 'DIRECT://senderB' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [senderA, senderB],
    ));

    const result = await module.sendInvoiceReceipts(invoiceId, { includeZeroBalance: true });

    expect(result.sent).toBe(2);
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-006: Without includeZeroBalance, zero-balance senders skipped
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-006: zero-balance senders skipped without includeZeroBalance', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '0', [{ address: 'DIRECT://senderB' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [senderA, senderB],
    ));

    const result = await module.sendInvoiceReceipts(invoiceId);

    expect(result.sent).toBe(1);
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-007: Contact resolution priority
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-007: DM sent to contacts[0].address when available', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderWithContact = makeFrozenSender('DIRECT://senderA', '5000000', [
      { address: 'DIRECT://contactAddress' },
    ]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [senderWithContact],
    ));

    await module.sendInvoiceReceipts(invoiceId);

    const [recipient] = mocks.communications.sendDM.mock.calls[0];
    expect(recipient).toBe('DIRECT://contactAddress');
  });

  it('UT-RECEIPTS-007b: DM falls back to senderAddress when no contacts', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderNoContact = makeFrozenSender('DIRECT://senderB', '5000000', []);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [senderNoContact],
    ));

    await module.sendInvoiceReceipts(invoiceId);

    const [recipient] = mocks.communications.sendDM.mock.calls[0];
    expect(recipient).toBe('DIRECT://senderB');
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-008: Partial DM failure — some succeed, some fail
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-008: partial DM failure returns best-effort result without throwing', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '2000000', [{ address: 'DIRECT://senderB' }]);
    const senderC = makeFrozenSender('DIRECT://senderC', '1000000', [{ address: 'DIRECT://senderC' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [senderA, senderB, senderC],
    ));

    // Make senderB's DM fail
    mocks.communications.sendDM.mockImplementation(
      async (recipient: string, content: string) => {
        if (recipient === 'DIRECT://senderB') {
          throw new Error('DM delivery failed');
        }
        return {
          id: 'mock-dm-' + Math.random(),
          senderPubkey: '02' + 'a'.repeat(64),
          recipientPubkey: '02' + 'b'.repeat(64),
          content,
          timestamp: Date.now(),
          isRead: false,
        };
      },
    );

    const result = await module.sendInvoiceReceipts(invoiceId);

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failedReceipts[0]).toMatchObject({
      senderAddress: 'DIRECT://senderB',
      reason: 'dm_failed',
    });
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-009: INVOICE_NOT_FOUND
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-009: throws INVOICE_NOT_FOUND for nonexistent invoice', async () => {
    await expect(module.sendInvoiceReceipts('nonexistent_id')).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_FOUND' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-010: INVOICE_NOT_TARGET — caller is not a target
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-010: throws INVOICE_NOT_TARGET when caller is not a target', async () => {
    // Invoice targets a DIFFERENT address not in the wallet's tracked addresses
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 1000,
      dueDate: Date.now() + 86400000,
      targets: [
        {
          address: 'DIRECT://some_other_wallet_address_xyz',
          assets: [{ coin: ['UCT', '1000000'] }],
        },
      ],
    };
    const invoiceId = await injectInvoice(module, terms);

    // Mark as closed to pass the terminal check
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).closedInvoices.add(invoiceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).frozenBalances.set(invoiceId, {
      state: 'CLOSED',
      frozenAt: Date.now(),
      targets: [],
      irrelevantTransfers: [],
      totalForward: {},
      totalBack: {},
      lastActivityAt: Date.now(),
    });

    await expect(module.sendInvoiceReceipts(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_TARGET' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-011: INVOICE_MEMO_TOO_LONG
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-011: throws INVOICE_MEMO_TOO_LONG when memo exceeds 4096 chars', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    await module.closeInvoice(invoiceId);

    await expect(
      module.sendInvoiceReceipts(invoiceId, { memo: 'x'.repeat(4097) }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVOICE_MEMO_TOO_LONG' }));
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-012: INVOICE_NOT_TERMINATED — invoice is COVERED
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-012: throws INVOICE_NOT_TERMINATED for COVERED invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    // Invoice exists but is NOT in closedInvoices or cancelledInvoices → NOT_TERMINATED

    await expect(module.sendInvoiceReceipts(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_TERMINATED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-013: INVOICE_NOT_TERMINATED — invoice is OPEN
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-013: throws INVOICE_NOT_TERMINATED for OPEN invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    await expect(module.sendInvoiceReceipts(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_TERMINATED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-014: COMMUNICATIONS_UNAVAILABLE
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-014: throws COMMUNICATIONS_UNAVAILABLE when no CommunicationsModule', async () => {
    // Build module WITHOUT CommunicationsModule.
    // Note: createTestAccountingModule uses ?? so undefined falls through to the default mock.
    // We override deps.communications directly after initialization.
    const { module: noCommunicationsModule } = createTestAccountingModule();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (noCommunicationsModule as any).deps.communications = null;
    await noCommunicationsModule.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(noCommunicationsModule, terms);
    await noCommunicationsModule.closeInvoice(invoiceId);

    await expect(noCommunicationsModule.sendInvoiceReceipts(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'COMMUNICATIONS_UNAVAILABLE' }),
    );

    noCommunicationsModule.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-015: INVOICE_NOT_TERMINATED — invoice is PARTIAL
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-015: throws INVOICE_NOT_TERMINATED for PARTIAL invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    // No terminal state set → NOT_TERMINATED

    await expect(module.sendInvoiceReceipts(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_TERMINATED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS-016: INVOICE_NOT_TERMINATED — invoice is EXPIRED
  // -------------------------------------------------------------------------
  it('UT-RECEIPTS-016: throws INVOICE_NOT_TERMINATED for EXPIRED (not terminal) invoice', async () => {
    const past = Date.now() - 1000;
    const terms = makeTerms(undefined, { dueDate: past, createdAt: past - 86400000 });
    const invoiceId = await injectInvoice(module, terms);
    // Due date passed but not closed/cancelled → NOT_TERMINATED

    await expect(module.sendInvoiceReceipts(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_TERMINATED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-RECEIPTS: invoice:receipt_sent event fires
  // -------------------------------------------------------------------------
  it('fires invoice:receipt_sent event with correct counts', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CLOSED',
      [sender],
    ));

    await module.sendInvoiceReceipts(invoiceId);

    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:receipt_sent',
      expect.objectContaining({ invoiceId, sent: 1, failed: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// sendCancellationNotices tests
// ---------------------------------------------------------------------------

describe('AccountingModule — sendCancellationNotices()', () => {
  let module: ReturnType<typeof createTestAccountingModule>['module'];
  let mocks: ReturnType<typeof createTestAccountingModule>['mocks'];
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const built = createTestAccountingModule();
    module = built.module;
    mocks = built.mocks;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();
  });

  afterEach(() => {
    module.destroy();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-001: Happy path — send notices for CANCELLED invoice
  // -------------------------------------------------------------------------
  it('UT-NOTICES-001: sends notices for CANCELLED invoice; returns {sent,failed}', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '3000000', [{ address: 'DIRECT://senderB' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [senderA, senderB],
    ));

    const result = await module.sendCancellationNotices(invoiceId);

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-002: INVOICE_NOT_CANCELLED — invoice is CLOSED
  // -------------------------------------------------------------------------
  it('UT-NOTICES-002: throws INVOICE_NOT_CANCELLED for CLOSED invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    await module.closeInvoice(invoiceId);

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_CANCELLED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-003: Custom reason and dealDescription included
  // -------------------------------------------------------------------------
  it('UT-NOTICES-003: reason and dealDescription included in cancellation payload', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [sender],
    ));

    await module.sendCancellationNotices(invoiceId, {
      reason: 'Out of stock',
      dealDescription: 'Order #1234',
    });

    const [, content] = mocks.communications.sendDM.mock.calls[0];
    const payload = JSON.parse(content.slice('invoice_cancellation:'.length));
    expect(payload.reason).toBe('Out of stock');
    expect(payload.dealDescription).toBe('Order #1234');
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-004: INVOICE_MEMO_TOO_LONG for reason
  // -------------------------------------------------------------------------
  it('UT-NOTICES-004: throws INVOICE_MEMO_TOO_LONG when reason exceeds 4096 chars', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    await module.cancelInvoice(invoiceId);

    await expect(
      module.sendCancellationNotices(invoiceId, { reason: 'x'.repeat(4097) }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVOICE_MEMO_TOO_LONG' }));
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-005: INVOICE_MEMO_TOO_LONG for dealDescription
  // -------------------------------------------------------------------------
  it('UT-NOTICES-005: throws INVOICE_MEMO_TOO_LONG when dealDescription exceeds 4096 chars', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    await module.cancelInvoice(invoiceId);

    await expect(
      module.sendCancellationNotices(invoiceId, { dealDescription: 'x'.repeat(4097) }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVOICE_MEMO_TOO_LONG' }));
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-006: INVOICE_NOT_TARGET
  // -------------------------------------------------------------------------
  it('UT-NOTICES-006: throws INVOICE_NOT_TARGET when caller is not a target', async () => {
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 1000,
      dueDate: Date.now() + 86400000,
      targets: [
        {
          address: 'DIRECT://some_other_wallet_not_ours',
          assets: [{ coin: ['UCT', '1000000'] }],
        },
      ],
    };
    const invoiceId = await injectInvoice(module, terms);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).cancelledInvoices.add(invoiceId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).frozenBalances.set(invoiceId, {
      state: 'CANCELLED',
      frozenAt: Date.now(),
      targets: [],
      irrelevantTransfers: [],
      totalForward: {},
      totalBack: {},
      lastActivityAt: Date.now(),
    });

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_TARGET' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-007: COMMUNICATIONS_UNAVAILABLE
  // -------------------------------------------------------------------------
  it('UT-NOTICES-007: throws COMMUNICATIONS_UNAVAILABLE when no CommunicationsModule', async () => {
    // Override deps.communications to null after initialization (createTestAccountingModule
    // uses ?? which converts undefined to the default mock).
    const { module: noCommunicationsModule } = createTestAccountingModule();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (noCommunicationsModule as any).deps.communications = null;
    await noCommunicationsModule.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(noCommunicationsModule, terms);
    await noCommunicationsModule.cancelInvoice(invoiceId);

    await expect(noCommunicationsModule.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'COMMUNICATIONS_UNAVAILABLE' }),
    );

    noCommunicationsModule.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-008: Partial DM failure — best-effort result
  // -------------------------------------------------------------------------
  it('UT-NOTICES-008: partial DM failure returns best-effort result without throwing', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '3000000', [{ address: 'DIRECT://senderB' }]);
    const senderC = makeFrozenSender('DIRECT://senderC', '2000000', [{ address: 'DIRECT://senderC' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [senderA, senderB, senderC],
    ));

    mocks.communications.sendDM.mockImplementation(
      async (recipient: string, content: string) => {
        if (recipient === 'DIRECT://senderB') {
          throw new Error('DM delivery failed');
        }
        return {
          id: 'dm-' + Math.random(),
          senderPubkey: '02' + 'a'.repeat(64),
          recipientPubkey: '02' + 'b'.repeat(64),
          content,
          timestamp: Date.now(),
          isRead: false,
        };
      },
    );

    const result = await module.sendCancellationNotices(invoiceId);

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failedNotices[0]).toMatchObject({
      senderAddress: 'DIRECT://senderB',
      reason: 'dm_failed',
    });
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-009: INVOICE_NOT_FOUND
  // -------------------------------------------------------------------------
  it('UT-NOTICES-009: throws INVOICE_NOT_FOUND for nonexistent invoice', async () => {
    await expect(module.sendCancellationNotices('nonexistent_id')).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_FOUND' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-010: INVOICE_NOT_CANCELLED — invoice is OPEN
  // -------------------------------------------------------------------------
  it('UT-NOTICES-010: throws INVOICE_NOT_CANCELLED for OPEN invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_CANCELLED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-011: INVOICE_NOT_CANCELLED — invoice is PARTIAL
  // -------------------------------------------------------------------------
  it('UT-NOTICES-011: throws INVOICE_NOT_CANCELLED for PARTIAL invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    // Not in cancelled set → NOT_CANCELLED

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_CANCELLED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-012: INVOICE_NOT_CANCELLED — invoice is COVERED
  // -------------------------------------------------------------------------
  it('UT-NOTICES-012: throws INVOICE_NOT_CANCELLED for COVERED (non-terminal) invoice', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_CANCELLED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-013: INVOICE_NOT_CANCELLED — invoice is EXPIRED
  // -------------------------------------------------------------------------
  it('UT-NOTICES-013: throws INVOICE_NOT_CANCELLED for EXPIRED invoice', async () => {
    const past = Date.now() - 1000;
    const terms = makeTerms(undefined, { dueDate: past, createdAt: past - 86400000 });
    const invoiceId = await injectInvoice(module, terms);
    // expired but not cancelled

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_CANCELLED' }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES-014: includeZeroBalance includes zero-balance senders
  // -------------------------------------------------------------------------
  it('UT-NOTICES-014: includeZeroBalance:true sends to zero-balance senders', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const senderA = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    const senderB = makeFrozenSender('DIRECT://senderB', '0', [{ address: 'DIRECT://senderB' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [senderA, senderB],
    ));

    const result = await module.sendCancellationNotices(invoiceId, { includeZeroBalance: true });

    expect(result.sent).toBe(2);
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES: DM content starts with 'invoice_cancellation:' prefix
  // -------------------------------------------------------------------------
  it('cancellation DM content starts with "invoice_cancellation:" prefix', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [sender],
    ));

    await module.sendCancellationNotices(invoiceId);

    const [, content] = mocks.communications.sendDM.mock.calls[0];
    expect(content).toMatch(/^invoice_cancellation:/);
  });

  // -------------------------------------------------------------------------
  // UT-NOTICES: invoice:cancellation_sent event fires
  // -------------------------------------------------------------------------
  it('fires invoice:cancellation_sent event with correct counts', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    const sender = makeFrozenSender('DIRECT://senderA', '5000000', [{ address: 'DIRECT://senderA' }]);
    injectFrozenBalances(module, invoiceId, buildFrozen(
      'DIRECT://test_target_address_abc123',
      'CANCELLED',
      [sender],
    ));

    await module.sendCancellationNotices(invoiceId);

    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:cancellation_sent',
      expect.objectContaining({ invoiceId, sent: 1, failed: 0 }),
    );
  });

  // -------------------------------------------------------------------------
  // Only CANCELLED invoices accepted — CLOSED is rejected
  // -------------------------------------------------------------------------
  it('only CANCELLED state accepted; CLOSED throws INVOICE_NOT_CANCELLED', async () => {
    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);
    await module.closeInvoice(invoiceId);

    await expect(module.sendCancellationNotices(invoiceId)).rejects.toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_CANCELLED' }),
    );
  });
});
