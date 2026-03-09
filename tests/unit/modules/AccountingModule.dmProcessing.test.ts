/**
 * AccountingModule — Payer-Side DM Processing
 *
 * Tests that incoming DMs are correctly parsed and dispatched as events.
 * Corresponds to §3.17 of ACCOUNTING-TEST-SPEC.md.
 *
 * Test IDs: UT-DM-001 through UT-DM-010
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
} from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';
import type { DirectMessage } from '../../../types/index.js';

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
 * the crypto proof verification in importInvoice(). createTestToken() generates
 * synthetic proofs that fail real SdkToken.verify() — use direct injection for tests.
 */
function injectInvoice(
  module: ReturnType<typeof createTestAccountingModule>['module'],
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

function makeDM(content: string, overrides?: Partial<DirectMessage>): DirectMessage {
  return {
    id: 'dm-' + Math.random().toString(36).slice(2),
    senderPubkey: '02' + 'b'.repeat(64),
    recipientPubkey: '02' + 'a'.repeat(64),
    content,
    timestamp: Date.now(),
    isRead: false,
    ...overrides,
  };
}

function makeReceiptPayload(invoiceId: string, overrides?: Record<string, unknown>) {
  return {
    type: 'invoice_receipt',
    version: 1,
    invoiceId,
    targetAddress: 'DIRECT://test_target_address_abc123',
    terminalState: 'CLOSED',
    senderContribution: {
      senderAddress: 'DIRECT://sender_address_def456',
      assets: [
        {
          coinId: 'UCT',
          forwardedAmount: '5000000',
          returnedAmount: '0',
          netAmount: '5000000',
          requestedAmount: '10000000',
        },
      ],
    },
    issuedAt: Date.now(),
    ...overrides,
  };
}

function makeCancellationPayload(invoiceId: string, overrides?: Record<string, unknown>) {
  return {
    type: 'invoice_cancellation',
    version: 1,
    invoiceId,
    targetAddress: 'DIRECT://test_target_address_abc123',
    terminalState: 'CANCELLED',
    senderContribution: {
      senderAddress: 'DIRECT://sender_address_def456',
      assets: [],
    },
    reason: 'Test cancellation',
    issuedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AccountingModule — Payer-Side DM Processing', () => {
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
  // UT-DM-001: Receipt DM detected and fires invoice:receipt_received
  // -------------------------------------------------------------------------
  it('UT-DM-001: receipt DM with invoice_receipt: prefix fires invoice:receipt_received', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = makeReceiptPayload(invoiceId);

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:receipt_received',
      expect.objectContaining({ invoiceId }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-DM-002: Cancellation DM detected and fires invoice:cancellation_received
  // -------------------------------------------------------------------------
  it('UT-DM-002: cancellation DM fires invoice:cancellation_received', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = makeCancellationPayload(invoiceId);

    const dm = makeDM('invoice_cancellation:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:cancellation_received',
      expect.objectContaining({ invoiceId }),
    );
  });

  // -------------------------------------------------------------------------
  // UT-DM-003: Non-invoice DM ignored silently
  // -------------------------------------------------------------------------
  it('UT-DM-003: non-invoice DM is ignored silently', async () => {
    const dm = makeDM('Hello there, this is a regular DM');
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
    expect(emitEvent).not.toHaveBeenCalledWith('invoice:cancellation_received', expect.anything());
  });

  // -------------------------------------------------------------------------
  // UT-DM-003b: Malformed JSON after prefix treated as regular DM
  // -------------------------------------------------------------------------
  it('UT-DM-003b: malformed JSON after invoice_receipt: prefix ignored silently', async () => {
    const dm = makeDM('invoice_receipt: {invalid json!!!}');
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
  });

  // -------------------------------------------------------------------------
  // UT-DM-004: version > 1 silently ignored
  // -------------------------------------------------------------------------
  it('UT-DM-004: DM with version > 1 is silently ignored (forward compatibility)', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = makeReceiptPayload(invoiceId, { version: 2 });

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
  });

  // -------------------------------------------------------------------------
  // UT-DM-005: version < 1 or non-integer version — validation failure (silent)
  // -------------------------------------------------------------------------
  it('UT-DM-005a: DM with version 0 is silently ignored', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = makeReceiptPayload(invoiceId, { version: 0 });

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
  });

  it('UT-DM-005b: DM with string version is silently ignored', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = makeReceiptPayload(invoiceId, { version: '1' });

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
  });

  // -------------------------------------------------------------------------
  // UT-DM-006: Unknown invoiceId silently dropped
  // -------------------------------------------------------------------------
  it('UT-DM-006: DM with unknown invoiceId is silently dropped', async () => {
    // Use a valid 64-hex invoiceId that is NOT registered in the module
    const unknownId = 'b'.repeat(64);
    const payload = makeReceiptPayload(unknownId);

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
  });

  // -------------------------------------------------------------------------
  // UT-DM-007: Content > 64 KB skipped before JSON.parse
  // -------------------------------------------------------------------------
  it('UT-DM-007: DM content exceeding 64 KB is skipped before JSON.parse', async () => {
    // Content: prefix + 65 KB of data
    const oversizedContent = 'invoice_receipt:' + 'x'.repeat(65 * 1024 + 1);
    const dm = makeDM(oversizedContent);

    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    // No parse attempt should happen and no event should fire
    expect(emitEvent).not.toHaveBeenCalledWith('invoice:receipt_received', expect.anything());
  });

  // -------------------------------------------------------------------------
  // UT-DM-008: DM subscription torn down on destroy()
  // -------------------------------------------------------------------------
  it('UT-DM-008: DM subscription is torn down after destroy()', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());

    module.destroy();

    const payload = makeReceiptPayload(invoiceId);
    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));

    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    // After destroy(), no new events should be emitted
    const receiptCalls = emitEvent.mock.calls.filter(([evt]) => evt === 'invoice:receipt_received');
    expect(receiptCalls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // UT-DM-009: senderNametag falls back to payload.targetNametag
  // -------------------------------------------------------------------------
  it('UT-DM-009: senderNametag falls back to payload.targetNametag when DM has no nametag', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = {
      ...makeReceiptPayload(invoiceId),
      targetNametag: 'alice',
    };

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    // DM has no senderNametag
    delete (dm as any).senderNametag;

    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    const receiptCalls = emitEvent.mock.calls.filter(([evt]) => evt === 'invoice:receipt_received');
    expect(receiptCalls.length).toBeGreaterThan(0);
    const receipt = receiptCalls[0][1];
    // senderNametag should fall back to targetNametag from payload
    // Event shape: { invoiceId, receipt: IncomingInvoiceReceipt }
    // IncomingInvoiceReceipt.senderNametag = dm.senderNametag ?? receipt.targetNametag
    expect(receipt.receipt.senderNametag).toBe('alice');
  });

  // -------------------------------------------------------------------------
  // UT-DM-010: Self-asserted receipt amounts fire event without validation
  // -------------------------------------------------------------------------
  it('UT-DM-010: receipt DM with fabricated amounts fires event without cross-validation', async () => {
    const invoiceId = await injectInvoice(module, makeTerms());
    const payload = makeReceiptPayload(invoiceId, {
      senderContribution: {
        senderAddress: 'DIRECT://sender_address_def456',
        assets: [
          {
            coinId: 'UCT',
            forwardedAmount: '999999',
            returnedAmount: '0',
            netAmount: '999999',
            requestedAmount: '10000000',
          },
        ],
      },
    });

    const dm = makeDM('invoice_receipt:' + JSON.stringify(payload));
    mocks.communications._emit('message:dm', dm);
    await new Promise((r) => setTimeout(r, 20));

    // Event fires regardless of whether the amounts match frozen balances
    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:receipt_received',
      expect.objectContaining({ invoiceId }),
    );
  });
});
