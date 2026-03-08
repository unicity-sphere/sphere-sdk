/**
 * AccountingModule — autoTerminateOnReturn
 *
 * Tests for the autoTerminateOnReturn config option.
 * Corresponds to §3.18 of ACCOUNTING-TEST-SPEC.md.
 *
 * Test IDs: UT-AUTOTERM-001 through UT-AUTOTERM-005
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransfer,
} from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';
import type { IncomingTransfer } from '../../../types/index.js';

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
 * the crypto proof verification in importInvoice().
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

/**
 * Builds a minimal IncomingTransfer carrying an invoice memo with the given direction.
 * The sender address comes from a target address (for :RC/:RX, the target sends back).
 */
function makeIncomingTransferWithDirection(
  invoiceId: string,
  direction: 'F' | 'B' | 'RC' | 'RX',
  amount = '5000000',
  coinId = 'UCT',
  senderAddress = 'DIRECT://test_target_address_abc123',
  destinationAddress = 'DIRECT://sender_address_def456',
): IncomingTransfer {
  const txfToken = createTestTransfer(
    invoiceId,
    direction,
    amount,
    coinId,
    senderAddress,
    destinationAddress,
  );
  return {
    id: 'transfer-' + Math.random().toString(36).slice(2),
    senderPubkey: '02' + 'b'.repeat(64),
    memo: `INV:${invoiceId}:${direction}`,
    tokens: [
      {
        id: txfToken.genesis.data.tokenId,
        coinId,
        amount,
        sdkData: JSON.stringify(txfToken),
        confirmed: false,
      } as any,
    ],
    receivedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AccountingModule — autoTerminateOnReturn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // UT-AUTOTERM-001: :RC with autoTerminateOnReturn:true → invoice auto-closed
  // -------------------------------------------------------------------------
  it('UT-AUTOTERM-001: receiving :RC with autoTerminateOnReturn:true closes the invoice', async () => {
    const { module, mocks } = createTestAccountingModule({
      config: { autoTerminateOnReturn: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    // Simulate an :RC transfer arriving — must appear as self-sent so senderAddress
    // resolves to identity.directAddress (a target). Use identity.chainPubkey as senderPubkey.
    const rcTransfer = makeIncomingTransferWithDirection(invoiceId, 'RC');
    rcTransfer.senderPubkey = '02' + 'a'.repeat(64); // matches DEFAULT_TEST_IDENTITY.chainPubkey

    mocks.payments._emit('transfer:incoming', rcTransfer);

    // Give the async pipeline time to settle
    await new Promise((r) => setTimeout(r, 50));

    // The invoice should be marked as closed — assert unconditionally
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closedInvoices = (module as any).closedInvoices as Set<string>;
    const closedCalls = emitEvent.mock.calls.filter(([evt]: [string]) => evt === 'invoice:closed');
    expect(closedCalls.length).toBeGreaterThan(0);
    expect(closedCalls[0][1]).toMatchObject({ invoiceId, explicit: false });
    expect(closedInvoices.has(invoiceId)).toBe(true);

    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-AUTOTERM-002: :RX with autoTerminateOnReturn:true → invoice auto-cancelled
  // -------------------------------------------------------------------------
  it('UT-AUTOTERM-002: receiving :RX with autoTerminateOnReturn:true cancels the invoice', async () => {
    const { module, mocks } = createTestAccountingModule({
      config: { autoTerminateOnReturn: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    // Simulate an :RX transfer — must appear as self-sent so senderAddress
    // resolves to identity.directAddress (a target). Use identity.chainPubkey as senderPubkey.
    const rxTransfer = makeIncomingTransferWithDirection(invoiceId, 'RX');
    rxTransfer.senderPubkey = '02' + 'a'.repeat(64); // matches DEFAULT_TEST_IDENTITY.chainPubkey

    mocks.payments._emit('transfer:incoming', rxTransfer);
    await new Promise((r) => setTimeout(r, 50));

    // The invoice should be marked as cancelled — assert unconditionally
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelledInvoices = (module as any).cancelledInvoices as Set<string>;
    const cancelledCalls = emitEvent.mock.calls.filter(([evt]: [string]) => evt === 'invoice:cancelled');
    expect(cancelledCalls.length).toBeGreaterThan(0);
    expect(cancelledCalls[0][1]).toMatchObject({ invoiceId });
    expect(cancelledInvoices.has(invoiceId)).toBe(true);

    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-AUTOTERM-003: autoTerminateOnReturn:false → no auto-termination
  // -------------------------------------------------------------------------
  it('UT-AUTOTERM-003: no auto-termination when autoTerminateOnReturn is false (default)', async () => {
    // Default config — autoTerminateOnReturn defaults to false
    const { module, mocks } = createTestAccountingModule({
      config: { autoTerminateOnReturn: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    // Receive :RC and :RX
    mocks.payments._emit('transfer:incoming', makeIncomingTransferWithDirection(invoiceId, 'RC'));
    mocks.payments._emit('transfer:incoming', makeIncomingTransferWithDirection(invoiceId, 'RX'));
    await new Promise((r) => setTimeout(r, 50));

    // Invoice should remain non-terminated
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closedInvoices = (module as any).closedInvoices as Set<string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelledInvoices = (module as any).cancelledInvoices as Set<string>;

    expect(closedInvoices.has(invoiceId)).toBe(false);
    expect(cancelledInvoices.has(invoiceId)).toBe(false);

    const closedCalls = emitEvent.mock.calls.filter(([evt]: [string]) => evt === 'invoice:closed');
    const cancelledCalls = emitEvent.mock.calls.filter(([evt]: [string]) => evt === 'invoice:cancelled');
    expect(closedCalls.length).toBe(0);
    expect(cancelledCalls.length).toBe(0);

    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-AUTOTERM-004: No deadlock on concurrent operation
  // -------------------------------------------------------------------------
  it('UT-AUTOTERM-004: no deadlock when :RC arrives while another gate operation runs', async () => {
    const { module, mocks } = createTestAccountingModule({
      config: { autoTerminateOnReturn: true },
    });
    await module.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    // Start a concurrent getInvoiceStatus (which acquires no gate) alongside the RC transfer
    const rcTransfer = makeIncomingTransferWithDirection(invoiceId, 'RC');

    // Fire RC + status check concurrently — neither should deadlock
    const results = await Promise.allSettled([
      new Promise<void>((resolve) => {
        mocks.payments._emit('transfer:incoming', rcTransfer);
        resolve();
      }),
      module.getInvoiceStatus(invoiceId),
    ]);

    // Give async pipeline time to complete
    await new Promise((r) => setTimeout(r, 100));

    // Both should resolve or at most one rejects (never hang)
    for (const result of results) {
      if (result.status === 'rejected') {
        // An error is acceptable; a hang/timeout is not
        expect(result.reason).toBeInstanceOf(Error);
      }
    }

    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-AUTOTERM-005: Spoofed :RC from non-target — no auto-termination
  // -------------------------------------------------------------------------
  it('UT-AUTOTERM-005: :RC from non-target sender does not trigger auto-termination', async () => {
    const { module, mocks } = createTestAccountingModule({
      config: { autoTerminateOnReturn: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();

    const terms = makeTerms();
    const invoiceId = await injectInvoice(module, terms);

    // :RC arriving from a non-target address C (not in invoice targets)
    // The direction is RC but the sender is NOT a target
    const spoofedRcTransfer = makeIncomingTransferWithDirection(
      invoiceId,
      'RC',
      '5000000',
      'UCT',
      'DIRECT://non_target_sender_address',  // NOT a target
      'DIRECT://test_target_address_abc123',
    );

    mocks.payments._emit('transfer:incoming', spoofedRcTransfer);
    await new Promise((r) => setTimeout(r, 50));

    // The module should process the transfer but the :RC from a non-target is
    // treated as irrelevant/unauthorized; invoice should NOT be closed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closedInvoices = (module as any).closedInvoices as Set<string>;

    // The unauthorized :RC from a non-target must NOT close the invoice.
    // Assert unconditionally: invoice stays open, unauthorized event fired.
    expect(closedInvoices.has(invoiceId)).toBe(false);
    const unauthorizedCalls = emitEvent.mock.calls.filter(
      ([evt, p]: [string, any]) =>
        evt === 'invoice:irrelevant' && p.reason === 'unauthorized_return',
    );
    expect(unauthorizedCalls.length).toBeGreaterThan(0);

    module.destroy();
  });
});
