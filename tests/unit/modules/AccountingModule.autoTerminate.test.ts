/**
 * AccountingModule — autoTerminateOnReturn
 *
 * Tests for the autoTerminateOnReturn config option.
 * Corresponds to §3.18 of ACCOUNTING-TEST-SPEC.md.
 *
 * Production scenario: autoTerminate fires when the wallet (acting as a target)
 * observes its OWN outgoing :RC/:RX return transfer. The Nostr transport echoes
 * self-sent transfers as `transfer:incoming` events, so `senderPubkey` equals
 * `identity.chainPubkey` (isSelfSender = true), resolving `senderAddress` to
 * `identity.directAddress` — which IS a target address on the target's local
 * invoice copy. This is the designed autoTerminate trigger path.
 *
 * Test IDs: UT-AUTOTERM-001 through UT-AUTOTERM-005
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransfer,
  DEFAULT_TEST_IDENTITY,
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
 *
 * By default uses identity.chainPubkey as senderPubkey (self-sender), which is
 * the production scenario for autoTerminate — the wallet observes its own return.
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
    senderPubkey: DEFAULT_TEST_IDENTITY.chainPubkey, // self-sender: identity observes own return
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

    // Simulate target wallet observing its own :RC return (self-sender echo).
    // senderPubkey = identity.chainPubkey → isSelfSender = true →
    // senderAddress = identity.directAddress (a target) → autoTerminate fires.
    const rcTransfer = makeIncomingTransferWithDirection(invoiceId, 'RC');

    mocks.payments._emit('transfer:incoming', rcTransfer);

    // Give the async pipeline time to settle
    await new Promise((r) => setTimeout(r, 50));

    // The invoice should be marked as closed
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

    // Simulate target wallet observing its own :RX return (self-sender echo).
    const rxTransfer = makeIncomingTransferWithDirection(invoiceId, 'RX');

    mocks.payments._emit('transfer:incoming', rxTransfer);
    await new Promise((r) => setTimeout(r, 50));

    // The invoice should be marked as cancelled
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

    // Use self-sender pubkey so senderAddress resolves to a target address.
    // This ensures the config flag (not sender resolution failure) is what
    // prevents termination.
    const rcTransfer = makeIncomingTransferWithDirection(invoiceId, 'RC');
    const rxTransfer = makeIncomingTransferWithDirection(invoiceId, 'RX');

    mocks.payments._emit('transfer:incoming', rcTransfer);
    mocks.payments._emit('transfer:incoming', rxTransfer);
    await new Promise((r) => setTimeout(r, 50));

    // Invoice should remain non-terminated despite valid sender — config is false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closedInvoices = (module as any).closedInvoices as Set<string>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cancelledInvoices = (module as any).cancelledInvoices as Set<string>;

    expect(closedInvoices.has(invoiceId)).toBe(false);
    expect(cancelledInvoices.has(invoiceId)).toBe(false);

    // invoice:return_received SHOULD fire (sender is valid), but no close/cancel
    const returnCalls = emitEvent.mock.calls.filter(([evt]: [string]) => evt === 'invoice:return_received');
    expect(returnCalls.length).toBeGreaterThan(0);
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

    // Use self-sender pubkey so the transfer actually acquires the invoice gate
    // (non-self sender resolves to null → invoice:irrelevant before gate)
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

    // Create invoice with a DIFFERENT target that does NOT match identity.directAddress.
    // This way, when the self-sender resolves senderAddress = identity.directAddress,
    // it won't be in the target set → senderIsTarget = false → unauthorized_return.
    const terms = makeTerms('DIRECT://completely_different_target_addr');
    const invoiceId = await injectInvoice(module, terms);

    // Self-sender :RC — senderAddress resolves to identity.directAddress which is
    // NOT 'DIRECT://completely_different_target_addr', so senderIsTarget = false.
    const spoofedRcTransfer = makeIncomingTransferWithDirection(invoiceId, 'RC');

    mocks.payments._emit('transfer:incoming', spoofedRcTransfer);
    await new Promise((r) => setTimeout(r, 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closedInvoices = (module as any).closedInvoices as Set<string>;

    // The sender (identity.directAddress) is NOT a target, so unauthorized_return fires
    expect(closedInvoices.has(invoiceId)).toBe(false);
    const unauthorizedCalls = emitEvent.mock.calls.filter(
      ([evt, p]: [string, any]) =>
        evt === 'invoice:irrelevant' && p.reason === 'unauthorized_return',
    );
    expect(unauthorizedCalls.length).toBeGreaterThan(0);

    module.destroy();
  });
});
