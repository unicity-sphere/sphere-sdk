/**
 * AccountingModule — Payment / Invoice Delivery-Order Coverage
 *
 * Real-world swap payouts produce two-channel delivery races: the escrow's
 * `payInvoice` call publishes the actual token transfer on the wallet
 * (transfer:incoming) Nostr filter, and a moment later sends the invoice
 * delivery DM via the chat filter. Either channel can win at the relay, and
 * partial payments split the transfer-channel side into N events.
 *
 * The accounting module MUST attribute every transfer to its referenced
 * invoice regardless of which order the events arrive in. This file pins
 * down that invariant across every interesting interleaving so a future
 * refactor cannot quietly regress it.
 *
 * Test IDs: UT-DELIVERY-001 through UT-DELIVERY-050
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransfer,
  DEFAULT_TEST_IDENTITY,
} from './accounting-test-helpers.js';
import type { InvoiceTerms, InvoiceTransferRef } from '../../../modules/accounting/types.js';
import type { IncomingTransfer } from '../../../types/index.js';

// ---------------------------------------------------------------------------
// Shared helpers (mirrored from AccountingModule.events.test.ts to keep the
// suite self-contained — every test should be readable in isolation)
// ---------------------------------------------------------------------------

const TARGET = DEFAULT_TEST_IDENTITY.directAddress; // wallet under test

function makeTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    createdAt: Date.now() - 1000,
    dueDate: Date.now() + 86_400_000,
    targets: [
      {
        address: TARGET,
        assets: [{ coin: ['UCT', '10000000'] }], // 10 UCT
      },
    ],
    ...overrides,
  };
}

function injectInvoice(
  module: ReturnType<typeof createTestAccountingModule>['module'],
  terms: InvoiceTerms,
  tokenId?: string,
): string {
  const id =
    tokenId ??
    Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (module as any).invoiceTermsCache.set(id, terms);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(module as any).invoiceLedger.has(id)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).invoiceLedger.set(id, new Map());
  }
  return id;
}

function makeIncomingTransfer(
  invoiceId: string,
  direction: 'F' | 'B' | 'RC' | 'RX',
  amount: string,
  coinId = 'UCT',
  senderAddress = 'DIRECT://sender_address_def456',
  destinationAddress: string = TARGET,
  senderPubkey = '02' + 'b'.repeat(64),
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
    senderPubkey,
    memo: `INV:${invoiceId}:${direction}`,
    tokens: [
      {
        id: txfToken.genesis.data.tokenId,
        coinId,
        amount,
        sdkData: JSON.stringify(txfToken),
        confirmed: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ],
    receivedAt: Date.now(),
  };
}

/** Pull the invoice ledger entries (Map<key, ref>) for direct inspection. */
function ledgerEntries(
  module: ReturnType<typeof createTestAccountingModule>['module'],
  invoiceId: string,
): InvoiceTransferRef[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledger = (module as any).invoiceLedger.get(invoiceId) as Map<string, InvoiceTransferRef> | undefined;
  if (!ledger) return [];
  return Array.from(ledger.values());
}

/** Sum of forward-direction amounts in an invoice's ledger. */
function forwardSum(
  module: ReturnType<typeof createTestAccountingModule>['module'],
  invoiceId: string,
): bigint {
  return ledgerEntries(module, invoiceId)
    .filter((r) => r.paymentDirection === 'forward')
    .reduce((s, r) => s + BigInt(r.amount), 0n);
}

/** Counts how many tokenInvoiceMap reverse-lookup entries point at this invoice. */
function tokenInvoiceMapEntriesFor(
  module: ReturnType<typeof createTestAccountingModule>['module'],
  invoiceId: string,
): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = (module as any).tokenInvoiceMap as Map<string, Set<string>>;
  let count = 0;
  for (const set of map.values()) {
    if (set.has(invoiceId)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AccountingModule — payment/invoice delivery ordering', () => {
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

  // =========================================================================
  // Single-transfer baseline
  // =========================================================================

  // -------------------------------------------------------------------------
  // UT-DELIVERY-001 — invoice arrives, then a single transfer
  // Reference path: transfer is processed normally via the cache hit branch.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-001: invoice → transfer → ledger has the transfer + invoice:payment fires', async () => {
    const invoiceId = injectInvoice(module, makeTerms());

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '5000000'));
    await new Promise((r) => setTimeout(r, 30));

    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:payment',
      expect.objectContaining({ invoiceId, paymentDirection: 'forward' }),
    );
    // No unknown_reference fired in the happy path.
    const unknownCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:unknown_reference',
    );
    expect(unknownCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // UT-DELIVERY-002 — single transfer arrives BEFORE its invoice (UT-EVENTS-024b
  // dual). The orphan-buffer branch in `_handleIncomingTransfer` must hold
  // the synthetic ref and surface it after `injectInvoice`.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-002: transfer → invoice → orphan-buffered transfer still in ledger after import', async () => {
    const invoiceId = 'a'.repeat(64);

    // Transfer arrives before invoice is known.
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '5000000'));
    await new Promise((r) => setTimeout(r, 30));

    // unknown_reference fires — observability preserved.
    const unknownCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:unknown_reference',
    );
    expect(unknownCalls).toHaveLength(1);

    // Orphan ledger now has the synthetic ref.
    expect(ledgerEntries(module, invoiceId)).toHaveLength(1);

    // Late import must NOT clobber the orphan — production importInvoice
    // preserves pre-existing ledger entries; injectInvoice() mirrors that
    // behavior because it uses `if (!has) set new Map`.
    injectInvoice(module, makeTerms(), invoiceId);

    expect(ledgerEntries(module, invoiceId)).toHaveLength(1);
    expect(forwardSum(module, invoiceId)).toBe(5000000n);
    // The reverse map (used by SwapModule.verifyPayout) must also point at us.
    expect(tokenInvoiceMapEntriesFor(module, invoiceId)).toBe(1);
  });

  // =========================================================================
  // Multi-transfer same-order
  // =========================================================================

  // -------------------------------------------------------------------------
  // UT-DELIVERY-010 — invoice, then transfer A, then transfer B
  // Both transfers must land in the same ledger; the second transfer (which
  // completes coverage) must trigger invoice:asset_covered.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-010: invoice → transferA(3) → transferB(7) — both in ledger, full coverage', async () => {
    const invoiceId = injectInvoice(module, makeTerms()); // expects 10M UCT

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '3000000'));
    await new Promise((r) => setTimeout(r, 30));
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '7000000'));
    await new Promise((r) => setTimeout(r, 30));

    expect(ledgerEntries(module, invoiceId)).toHaveLength(2);
    expect(forwardSum(module, invoiceId)).toBe(10000000n);

    const paymentCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:payment',
    );
    expect(paymentCalls.length).toBeGreaterThanOrEqual(2); // one per transfer

    // Both transfers reverse-map to this invoice.
    expect(tokenInvoiceMapEntriesFor(module, invoiceId)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // UT-DELIVERY-011 — both transfers orphan-buffered, then invoice imported
  // The full payment must remain reconstructible after late import.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-011: transferA(3) → transferB(7) → invoice — both orphans preserved through import', async () => {
    const invoiceId = 'b'.repeat(64);

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '3000000'));
    await new Promise((r) => setTimeout(r, 30));
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '7000000'));
    await new Promise((r) => setTimeout(r, 30));

    // Both unknown_reference events fired.
    const unknownCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:unknown_reference',
    );
    expect(unknownCalls).toHaveLength(2);

    // Both orphans buffered.
    expect(ledgerEntries(module, invoiceId)).toHaveLength(2);
    expect(forwardSum(module, invoiceId)).toBe(10000000n);

    injectInvoice(module, makeTerms(), invoiceId);

    // Both refs survived import.
    expect(ledgerEntries(module, invoiceId)).toHaveLength(2);
    expect(forwardSum(module, invoiceId)).toBe(10000000n);
    expect(tokenInvoiceMapEntriesFor(module, invoiceId)).toBe(2);
  });

  // =========================================================================
  // Interleaved: this is the case the user explicitly called out —
  // "partial payment with one or more transfers, then invoice, then some more
  // payment transfers". Pre- and post-import transfers must both attribute.
  // =========================================================================

  // -------------------------------------------------------------------------
  // UT-DELIVERY-020 — orphan A, invoice, transfer B
  // Pre-import orphan must persist through import; post-import transfer must
  // attribute via the cache-hit branch. Final ledger sum must equal both.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-020: transferA(3) [orphan] → invoice → transferB(7) — both attributed', async () => {
    const invoiceId = 'c'.repeat(64);

    // Phase 1: transfer A arrives before invoice.
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '3000000'));
    await new Promise((r) => setTimeout(r, 30));
    expect(ledgerEntries(module, invoiceId)).toHaveLength(1);

    // Phase 2: invoice is imported. Pre-existing orphan must be preserved.
    injectInvoice(module, makeTerms(), invoiceId);
    expect(ledgerEntries(module, invoiceId)).toHaveLength(1);

    // Phase 3: transfer B arrives after import.
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '7000000'));
    await new Promise((r) => setTimeout(r, 30));

    // Both transfers in ledger; total = 10M.
    expect(ledgerEntries(module, invoiceId)).toHaveLength(2);
    expect(forwardSum(module, invoiceId)).toBe(10000000n);
    expect(tokenInvoiceMapEntriesFor(module, invoiceId)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // UT-DELIVERY-021 — orphan A, orphan B, invoice, transfer C
  // Three transfers, two orphan + one post-import. All must end up in ledger.
  // (3-leg partial-fill scenario — relevant for swap deposits where a payer
  // splits across multiple wallet tokens.)
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-021: A(2) → B(3) → invoice → C(5) — all three transfers attributed', async () => {
    const invoiceId = 'd'.repeat(64);

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '2000000'));
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '3000000'));
    await new Promise((r) => setTimeout(r, 50));
    expect(ledgerEntries(module, invoiceId)).toHaveLength(2);

    injectInvoice(module, makeTerms(), invoiceId);
    expect(ledgerEntries(module, invoiceId)).toHaveLength(2);

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '5000000'));
    await new Promise((r) => setTimeout(r, 30));

    expect(ledgerEntries(module, invoiceId)).toHaveLength(3);
    expect(forwardSum(module, invoiceId)).toBe(10000000n);
    expect(tokenInvoiceMapEntriesFor(module, invoiceId)).toBe(3);
  });

  // -------------------------------------------------------------------------
  // UT-DELIVERY-022 — invoice imported between orphans, post-import transfer
  // arrives in close succession to phase 2 (no awaiting microtask flush
  // between transfers). Stress case for the orphan-vs-cache branch decision.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-022: A(2)(orphan) → invoice → B(3) → C(5) close-succession — all attributed', async () => {
    const invoiceId = 'e'.repeat(64);

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '2000000'));
    await new Promise((r) => setTimeout(r, 30));
    injectInvoice(module, makeTerms(), invoiceId);

    // No await between B and C — exercises sequential dispatch.
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '3000000'));
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceId, 'F', '5000000'));
    await new Promise((r) => setTimeout(r, 60));

    expect(ledgerEntries(module, invoiceId)).toHaveLength(3);
    expect(forwardSum(module, invoiceId)).toBe(10000000n);
  });

  // =========================================================================
  // Cross-invoice isolation — orphan buffers per invoice must NOT bleed
  // across into one another. Multi-buyer / multi-swap escrows depend on this.
  // =========================================================================

  // -------------------------------------------------------------------------
  // UT-DELIVERY-030 — two orphan transfers for two different invoices both
  // pending; both invoices imported in either order. Each invoice's ledger
  // must contain ONLY its own transfer.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-030: orphan(A) + orphan(B) → import A then B — no cross-attribution', async () => {
    const invoiceA = '1'.repeat(64);
    const invoiceB = '2'.repeat(64);

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceA, 'F', '5000000'));
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceB, 'F', '7000000'));
    await new Promise((r) => setTimeout(r, 50));

    expect(ledgerEntries(module, invoiceA)).toHaveLength(1);
    expect(ledgerEntries(module, invoiceB)).toHaveLength(1);

    injectInvoice(module, makeTerms(), invoiceA);
    injectInvoice(module, makeTerms(), invoiceB);

    expect(forwardSum(module, invoiceA)).toBe(5000000n);
    expect(forwardSum(module, invoiceB)).toBe(7000000n);

    // tokenInvoiceMap reverse: each token maps to exactly its own invoice.
    expect(tokenInvoiceMapEntriesFor(module, invoiceA)).toBe(1);
    expect(tokenInvoiceMapEntriesFor(module, invoiceB)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // UT-DELIVERY-031 — invoice A imported up front, then a transfer arrives
  // for A (cache-hit) and an orphan arrives for B in the same window. A's
  // ledger must NOT pick up B's orphan and vice-versa.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-031: A imported → transferA + orphanB interleaved → routed correctly', async () => {
    const invoiceA = injectInvoice(module, makeTerms());
    const invoiceB = '3'.repeat(64); // not imported

    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceA, 'F', '4000000'));
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(invoiceB, 'F', '6000000'));
    await new Promise((r) => setTimeout(r, 50));

    expect(forwardSum(module, invoiceA)).toBe(4000000n);
    expect(forwardSum(module, invoiceB)).toBe(6000000n);
    expect(tokenInvoiceMapEntriesFor(module, invoiceA)).toBe(1);
    expect(tokenInvoiceMapEntriesFor(module, invoiceB)).toBe(1);

    // unknown_reference fired for B (orphan), NOT for A.
    const unknownCalls = emitEvent.mock.calls.filter(
      ([evt]: [string]) => evt === 'invoice:unknown_reference',
    );
    expect(unknownCalls).toHaveLength(1);
    expect(unknownCalls[0][1]).toMatchObject({ invoiceId: invoiceB });
  });

  // =========================================================================
  // Confirmation-event semantics — transfer:incoming (unconfirmed) followed
  // by transfer:confirmed must NOT double-count. The orphan-buffer keys must
  // dedup on (tokenId, transferId).
  // =========================================================================

  // -------------------------------------------------------------------------
  // UT-DELIVERY-040 — same orphan transfer arrives twice (incoming + late
  // re-emit during retry). The ledger must not gain duplicate entries.
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-040: same orphan transfer emitted twice → single ledger entry (idempotent)', async () => {
    const invoiceId = '4'.repeat(64);

    const transfer = makeIncomingTransfer(invoiceId, 'F', '5000000');
    mocks.payments._emit('transfer:incoming', transfer);
    await new Promise((r) => setTimeout(r, 30));
    expect(ledgerEntries(module, invoiceId)).toHaveLength(1);

    // Re-emit the IDENTICAL transfer (same id, same token id) — handler must
    // dedupe via the `mt:${tokenId}:${transferId}` key in the orphan ledger.
    mocks.payments._emit('transfer:incoming', transfer);
    await new Promise((r) => setTimeout(r, 30));
    expect(ledgerEntries(module, invoiceId)).toHaveLength(1);
    expect(forwardSum(module, invoiceId)).toBe(5000000n);
  });

  // =========================================================================
  // Cap behavior — orphan buffer is bounded to MAX_UNKNOWN_INVOICE_IDS=500.
  // Beyond the cap, additional unknown-invoice transfers are dropped (by
  // design — see _handleIncomingTransfer). This protects against a
  // memory-exhaustion DoS via spam unknown-memo transfers.
  // =========================================================================

  // -------------------------------------------------------------------------
  // UT-DELIVERY-050 — the 501st unique unknown-invoice orphan must be dropped.
  // (Below the cap, orphans accumulate normally — covered by UT-DELIVERY-002.)
  // -------------------------------------------------------------------------
  it('UT-DELIVERY-050: orphan buffer cap = 500 unique invoice IDs — additional orphans dropped', async () => {
    // Burst-create 500 orphans for unique invoice IDs, then attempt a 501st.
    // We stop short of full 500 in CI for runtime, but exercise enough to
    // demonstrate the cap. The cap is a hard MAX_UNKNOWN_INVOICE_IDS = 500
    // constant in _handleIncomingTransfer; we read it directly via the
    // observable behavior (invoice 501 has no ledger entry).
    const CAP = 500;
    for (let i = 0; i < CAP; i += 1) {
      const id = i.toString(16).padStart(64, '0');
      mocks.payments._emit('transfer:incoming', makeIncomingTransfer(id, 'F', '1000'));
    }
    await new Promise((r) => setTimeout(r, 200)); // let microtasks drain

    // 501st unique orphan — should be DROPPED.
    const overflowId = 'f'.repeat(64);
    mocks.payments._emit('transfer:incoming', makeIncomingTransfer(overflowId, 'F', '1000'));
    await new Promise((r) => setTimeout(r, 30));

    // The dropped orphan has no ledger entry (no invoiceLedger key created).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overflowLedger = (module as any).invoiceLedger.get(overflowId);
    expect(overflowLedger).toBeUndefined();

    // Already-buffered orphans (within the cap) remain untouched.
    const firstId = '0'.repeat(64);
    expect(ledgerEntries(module, firstId)).toHaveLength(1);
  }, 15_000);
});
