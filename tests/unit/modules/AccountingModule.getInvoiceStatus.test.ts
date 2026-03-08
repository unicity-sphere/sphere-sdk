/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for AccountingModule.getInvoiceStatus()
 *
 * Tests 19 scenarios covering: OPEN, PARTIAL, COVERED, CLOSED, CANCELLED,
 * EXPIRED states; balance formulas; self-payment exclusion; multi-target and
 * multi-asset coverage; implicit close; per-sender tracking; and state
 * precedence rules.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  createTestToken,
  createTestTransferRef,
  DEFAULT_TEST_IDENTITY,
  DEFAULT_TEST_TRACKED_ADDRESS,
  SphereError,
} from './accounting-test-helpers.js';
import type { InvoiceTerms, InvoiceTransferRef, FrozenInvoiceBalances } from '../../../modules/accounting/types.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';

// ---------------------------------------------------------------------------
// Helpers for direct private-field manipulation
// ---------------------------------------------------------------------------

/** Seed the module's invoiceTermsCache and initialize an empty ledger slot. */
function seedInvoice(
  module: AccountingModule,
  invoiceId: string,
  terms: InvoiceTerms,
): void {
  (module as any).invoiceTermsCache.set(invoiceId, terms);
  if (!(module as any).invoiceLedger.has(invoiceId)) {
    (module as any).invoiceLedger.set(invoiceId, new Map<string, InvoiceTransferRef>());
  }
}

/** Add a transfer ref to the module's per-invoice ledger. */
function addLedgerEntry(
  module: AccountingModule,
  invoiceId: string,
  ref: InvoiceTransferRef,
): void {
  const inner = (module as any).invoiceLedger.get(invoiceId) as Map<string, InvoiceTransferRef>;
  if (!inner) throw new Error(`No ledger slot for invoice ${invoiceId}`);
  const entryKey = `${ref.transferId}::${ref.coinId}`;
  inner.set(entryKey, ref);
  // Invalidate balance cache
  (module as any).balanceCache.delete(invoiceId);
}

/** Mark an invoice as closed (add to closedInvoices set + frozenBalances). */
function markClosed(
  module: AccountingModule,
  invoiceId: string,
  frozen: FrozenInvoiceBalances,
): void {
  (module as any).closedInvoices.add(invoiceId);
  (module as any).frozenBalances.set(invoiceId, frozen);
}

/** Mark an invoice as cancelled (add to cancelledInvoices set + frozenBalances). */
function markCancelled(
  module: AccountingModule,
  invoiceId: string,
  frozen: FrozenInvoiceBalances,
): void {
  (module as any).cancelledInvoices.add(invoiceId);
  (module as any).frozenBalances.set(invoiceId, frozen);
}

/** Build a minimal FrozenInvoiceBalances with the given state. */
function buildFrozen(state: 'CLOSED' | 'CANCELLED', transfers: InvoiceTransferRef[] = []): FrozenInvoiceBalances {
  return {
    state,
    explicitClose: state === 'CLOSED' ? true : undefined,
    frozenAt: Date.now(),
    targets: [],
    irrelevantTransfers: [],
    totalForward: {},
    totalBack: {},
    lastActivityAt: 0,
  };
}

/** Build a minimal InvoiceTerms with a target pointing to the test wallet address. */
function buildTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    createdAt: Date.now() - 1000,
    targets: [
      {
        address: DEFAULT_TEST_IDENTITY.directAddress!,
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccountingModule.getInvoiceStatus()', () => {
  let module: AccountingModule;

  beforeEach(() => {
    vi.restoreAllMocks();
    ({ module } = createTestAccountingModule());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    module.destroy();
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-001: OPEN state — no payments received
  // -------------------------------------------------------------------------
  it('UT-STATUS-001: returns OPEN when no payments have been received', async () => {
    const invoiceId = 'a'.repeat(64);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.invoiceId).toBe(invoiceId);
    expect(status.state).toBe('OPEN');
    expect(status.targets.every((t) => !t.isCovered)).toBe(true);
    // All coin assets should show zero netCovered
    for (const target of status.targets) {
      for (const asset of target.coinAssets ?? []) {
        expect(asset.netCoveredAmount).toBe('0');
      }
    }
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-002: PARTIAL state — some coverage
  // -------------------------------------------------------------------------
  it('UT-STATUS-002: returns PARTIAL when only some assets are covered', async () => {
    const invoiceId = 'b'.repeat(64);
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 1000,
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [
            { coin: ['UCT', '10000000'] },
            { coin: ['USDU', '5000000'] },
          ],
        },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    // Only UCT is covered
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('PARTIAL');
    const uctAsset = status.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'UCT');
    const usduAsset = status.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'USDU');
    expect(uctAsset).toBeDefined();
    expect(usduAsset).toBeDefined();
    // UCT should show covered; USDU should show nothing
    expect(BigInt(uctAsset!.netCoveredAmount) >= BigInt('10000000')).toBe(true);
    expect(usduAsset!.netCoveredAmount).toBe('0');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-003: COVERED state — all targets covered, transfer unconfirmed
  // -------------------------------------------------------------------------
  it('UT-STATUS-003: returns COVERED with allConfirmed=false when all assets covered but unconfirmed', async () => {
    const invoiceId = 'c'.repeat(64);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: false, // Unconfirmed
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('COVERED');
    expect(status.allConfirmed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-004: CLOSED state — returns frozen balances (idempotent)
  // -------------------------------------------------------------------------
  it('UT-STATUS-004: returns CLOSED with frozen balances without recomputing, idempotent', async () => {
    const invoiceId = 'd'.repeat(64);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);
    const frozen = buildFrozen('CLOSED');
    markClosed(module, invoiceId, frozen);

    const status1 = await module.getInvoiceStatus(invoiceId);
    const status2 = await module.getInvoiceStatus(invoiceId);

    expect(status1.state).toBe('CLOSED');
    expect(status2.state).toBe('CLOSED');
    // Both calls return the same frozen state
    expect(status1.state).toBe(status2.state);
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-005: CANCELLED state — returns frozen balances
  // -------------------------------------------------------------------------
  it('UT-STATUS-005: returns CANCELLED with frozen balances for a cancelled invoice', async () => {
    const invoiceId = 'e'.repeat(64);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);
    const frozen = buildFrozen('CANCELLED');
    markCancelled(module, invoiceId, frozen);

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('CANCELLED');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-006: INVOICE_NOT_FOUND for unknown invoiceId
  // -------------------------------------------------------------------------
  it('UT-STATUS-006: throws INVOICE_NOT_FOUND for an unknown invoiceId', async () => {
    await expect(
      module.getInvoiceStatus('f'.repeat(64)),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-007: Balance formula: netCovered = max(0, covered - returned)
  // -------------------------------------------------------------------------
  it('UT-STATUS-007: computes net balance as forward minus back (max 0)', async () => {
    const invoiceId = 'a1'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const sender = 'DIRECT://sender_address_def456';

    // 10 UCT forward
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender,
      transferId: 'fwd-001',
    }));

    // 3 UCT back (returned)
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'back', '3000000', 'UCT', {
      destinationAddress: sender,
      senderAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      transferId: 'back-001',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    // Net UCT = 10 - 3 = 7
    const uctAsset = status.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'UCT');
    expect(uctAsset).toBeDefined();
    expect(uctAsset!.netCoveredAmount).toBe('7000000');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-008: Self-payment excluded from coverage
  // -------------------------------------------------------------------------
  it('UT-STATUS-008: excludes self-payments from coverage computation', async () => {
    const invoiceId = 'b2'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    // Self-payment: sender and destination are BOTH the wallet address
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: DEFAULT_TEST_IDENTITY.directAddress!, // same as wallet
      transferId: 'self-001',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    // Self-payment should not contribute to coverage → still OPEN
    expect(status.state).toBe('OPEN');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-009: Multi-target: one covered, one not → PARTIAL
  // -------------------------------------------------------------------------
  it('UT-STATUS-009: returns PARTIAL when one of two targets is covered and the other is not', async () => {
    const invoiceId = 'c3'.repeat(32);
    const target1 = DEFAULT_TEST_IDENTITY.directAddress!;
    const target2 = 'DIRECT://second_target_address_xyz';
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 1000,
      targets: [
        { address: target1, assets: [{ coin: ['UCT', '5000000'] }] },
        { address: target2, assets: [{ coin: ['UCT', '5000000'] }] },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    // Only target1 receives payment
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '5000000', 'UCT', {
      destinationAddress: target1,
      senderAddress: 'DIRECT://sender_address_def456',
      transferId: 'pay-t1',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('PARTIAL');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-010: Multi-asset per target: all must be covered
  // -------------------------------------------------------------------------
  it('UT-STATUS-010: requires all assets on a target to be covered before target is covered', async () => {
    const invoiceId = 'd4'.repeat(32);
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 1000,
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [
            { coin: ['UCT', '10000000'] },
            { coin: ['USDU', '5000000'] },
          ],
        },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    // Only pay UCT; USDU not paid
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      transferId: 'pay-uct',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('PARTIAL');
    // The target should not be fully covered since USDU is missing
    expect(status.targets[0].isCovered).toBe(false);
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-011: Return decreases net coverage
  // -------------------------------------------------------------------------
  it('UT-STATUS-011: a back-payment decreases net covered amount', async () => {
    const invoiceId = 'e5'.repeat(32);
    const terms = buildTerms(); // Requires 10 UCT
    seedInvoice(module, invoiceId, terms);

    const sender = 'DIRECT://sender_address_def456';

    // Pay 10 UCT unconfirmed → COVERED but no implicit close (allConfirmed=false)
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender,
      confirmed: false, // Unconfirmed prevents implicit close
      transferId: 'pay-001',
    }));

    const beforeReturn = await module.getInvoiceStatus(invoiceId);
    expect(beforeReturn.state).toBe('COVERED');
    expect(beforeReturn.allConfirmed).toBe(false);

    // Return 4 UCT → 6 net, still below 10 required
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'back', '4000000', 'UCT', {
      destinationAddress: sender,
      senderAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      confirmed: false,
      transferId: 'ret-001',
    }));

    const afterReturn = await module.getInvoiceStatus(invoiceId);
    const uctAsset = afterReturn.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'UCT');
    expect(uctAsset).toBeDefined();
    expect(uctAsset!.netCoveredAmount).toBe('6000000');
    expect(afterReturn.state).toBe('PARTIAL');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-012: Implicit close when COVERED + allConfirmed
  // -------------------------------------------------------------------------
  it('UT-STATUS-012: triggers implicit close and returns CLOSED when COVERED and all confirmed', async () => {
    const invoiceId = 'f6'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: true, // Confirmed — triggers implicit close
      transferId: 'pay-confirmed',
    }));

    const { mocks } = createTestAccountingModule();
    // Use the module we already seeded above
    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('CLOSED');
    // Implicit close fires invoice:closed event with explicit=false
    const emitCalls = ((module as any).deps?.emitEvent as ReturnType<typeof vi.fn>).mock.calls;
    const closedCall = emitCalls.find(
      (call: any[]) => call[0] === 'invoice:closed' && call[1]?.explicit === false,
    );
    expect(closedCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-013: EXPIRED when dueDate passed (informational overlay)
  // -------------------------------------------------------------------------
  it('UT-STATUS-013: returns EXPIRED when dueDate has passed and invoice is not covered', async () => {
    const invoiceId = 'a7'.repeat(32);
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 10000,
      dueDate: Date.now() - 1000, // Past due
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [{ coin: ['UCT', '10000000'] }],
        },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('EXPIRED');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-014: EXPIRED does not prevent explicit close
  // -------------------------------------------------------------------------
  it('UT-STATUS-014: an EXPIRED invoice can still be explicitly closed', async () => {
    const invoiceId = 'b8'.repeat(32);
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 10000,
      dueDate: Date.now() - 1000, // Past due
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [{ coin: ['UCT', '10000000'] }],
        },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    // Should not throw — expired invoices can still be closed
    await expect(module.closeInvoice(invoiceId)).resolves.not.toThrow();

    const status = await module.getInvoiceStatus(invoiceId);
    expect(status.state).toBe('CLOSED');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-015: allConfirmed dynamically computed from transfers, not frozen
  // -------------------------------------------------------------------------
  it('UT-STATUS-015: allConfirmed is dynamically derived from transfer entries, not from frozen data', async () => {
    const invoiceId = 'c9'.repeat(32);
    const terms = buildTerms();
    seedInvoice(module, invoiceId, terms);

    const unconfirmedRef = createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: false, // Unconfirmed
      transferId: 'pay-unconf',
    });
    addLedgerEntry(module, invoiceId, unconfirmedRef);

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('COVERED');
    expect(status.allConfirmed).toBe(false); // Dynamic — not frozen
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-016: Surplus calculated correctly
  // -------------------------------------------------------------------------
  it('UT-STATUS-016: computes surplus correctly when more than required amount is received', async () => {
    const invoiceId = 'aa'.repeat(32);
    const terms = buildTerms(); // Requires 10 UCT
    seedInvoice(module, invoiceId, terms);

    // Pay 15 UCT unconfirmed → COVERED but no implicit close
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '15000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: false, // Unconfirmed: prevents implicit close so we can inspect live status
      transferId: 'pay-surplus',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('COVERED');
    const uctAsset = status.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'UCT');
    expect(uctAsset).toBeDefined();
    // netCoveredAmount = 15000000 (15 UCT received)
    expect(uctAsset!.netCoveredAmount).toBe('15000000');
    // surplusAmount = 15000000 - 10000000 = 5000000
    expect(uctAsset!.surplusAmount).toBe('5000000');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-017: Per-sender balance tracking
  // -------------------------------------------------------------------------
  it('UT-STATUS-017: tracks balances per-sender correctly', async () => {
    const invoiceId = 'bb'.repeat(32);
    const terms = buildTerms(); // Requires 10 UCT
    seedInvoice(module, invoiceId, terms);

    const sender1 = 'DIRECT://sender_one_aaa111';
    const sender2 = 'DIRECT://sender_two_bbb222';

    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '6000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender1,
      confirmed: false, // Unconfirmed: prevents implicit close so we can inspect live per-sender data
      transferId: 'pay-s1',
    }));
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '4000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: sender2,
      confirmed: false,
      transferId: 'pay-s2',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    expect(status.state).toBe('COVERED');
    const uctAsset = status.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'UCT');
    expect(uctAsset).toBeDefined();
    expect(uctAsset!.senderBalances).toBeDefined();

    const s1Balance = uctAsset!.senderBalances.find((sb: any) => sb.senderAddress === sender1);
    const s2Balance = uctAsset!.senderBalances.find((sb: any) => sb.senderAddress === sender2);
    expect(s1Balance).toBeDefined();
    expect(s2Balance).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-018: Zero-amount coins skipped
  // -------------------------------------------------------------------------
  it('UT-STATUS-018: skips zero-amount coin entries in transfer refs', async () => {
    const invoiceId = 'cc'.repeat(32);
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 1000,
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [
            { coin: ['UCT', '10000000'] },
            { coin: ['USDU', '5000000'] },
          ],
        },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    // Add entry with amount '0' for USDU — should be a no-op for coverage
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '0', 'USDU', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      transferId: 'zero-usdu',
    }));

    // Add valid payment for UCT
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      transferId: 'pay-uct',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    // USDU zero-entry should not contribute → PARTIAL (USDU still 0)
    expect(status.state).toBe('PARTIAL');
    const usduAsset = status.targets[0].coinAssets?.find((a: any) => a.coin[0] === 'USDU');
    expect(usduAsset).toBeDefined();
    expect(usduAsset!.netCoveredAmount).toBe('0');
  });

  // -------------------------------------------------------------------------
  // UT-STATUS-019: COVERED takes precedence over EXPIRED
  // -------------------------------------------------------------------------
  it('UT-STATUS-019: COVERED takes precedence over EXPIRED when all targets are covered', async () => {
    const invoiceId = 'dd'.repeat(32);
    const terms: InvoiceTerms = {
      createdAt: Date.now() - 10000,
      dueDate: Date.now() - 1000, // Past due
      targets: [
        {
          address: DEFAULT_TEST_IDENTITY.directAddress!,
          assets: [{ coin: ['UCT', '10000000'] }],
        },
      ],
    };
    seedInvoice(module, invoiceId, terms);

    // Full payment received — should be COVERED (or CLOSED), NOT EXPIRED
    addLedgerEntry(module, invoiceId, createTestTransferRef(invoiceId, 'forward', '10000000', 'UCT', {
      destinationAddress: DEFAULT_TEST_IDENTITY.directAddress!,
      senderAddress: 'DIRECT://sender_address_def456',
      confirmed: false, // Unconfirmed so no implicit close
      transferId: 'pay-covered',
    }));

    const status = await module.getInvoiceStatus(invoiceId);

    // COVERED must win over EXPIRED per spec §5.7
    expect(status.state).toBe('COVERED');
    expect(status.state).not.toBe('EXPIRED');
  });
});
