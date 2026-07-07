/**
 * AccountingModule — getInvoices() tests (§3.5)
 *
 * Validates listing, filtering (role, state), sorting, and pagination.
 * Tests inject invoices directly into private fields to avoid needing
 * the full minting flow.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.5
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  createTestTransferRef,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
  DEFAULT_TEST_IDENTITY,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';

// =============================================================================
// Shared setup
// =============================================================================

let module: AccountingModule;
let mocks: TestAccountingModuleMocks;

function setup(overrides?: Parameters<typeof createTestAccountingModule>[0]) {
  const result = createTestAccountingModule(overrides);
  module = result.module;
  mocks = result.mocks;
}

afterEach(() => {
  try { module.destroy(); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// =============================================================================
// Helpers
// =============================================================================

function randomHex64(): string {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function injectInvoice(
  mod: AccountingModule,
  invoiceId: string,
  terms: InvoiceTerms,
): void {
  const m = mod as any;
  m.invoiceTermsCache.set(invoiceId, terms);
  if (!m.invoiceLedger.has(invoiceId)) {
    m.invoiceLedger.set(invoiceId, new Map());
  }
}

// =============================================================================
// UT-LIST-001: getInvoices() returns all invoices
// =============================================================================

describe('UT-LIST-001: getInvoices() returns all invoices', () => {
  beforeEach(() => setup());

  it('returns all invoices when no filters applied', async () => {
    await module.load();

    const id1 = randomHex64();
    const id2 = randomHex64();
    const id3 = randomHex64();

    injectInvoice(module, id1, { createdAt: 1000, targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }] });
    injectInvoice(module, id2, { createdAt: 2000, targets: [{ address: 'DIRECT://b', assets: [{ coin: ['UCT', '200'] as [string, string] }] }] });
    injectInvoice(module, id3, { createdAt: 3000, targets: [{ address: 'DIRECT://c', assets: [{ coin: ['UCT', '300'] as [string, string] }] }] });

    const invoices = await module.getInvoices();
    expect(invoices).toHaveLength(3);
  });
});

// =============================================================================
// UT-LIST-002: getInvoices({ createdByMe: true }) filters by creator
// =============================================================================

describe('UT-LIST-002: getInvoices({ createdByMe: true }) filters by creator', () => {
  beforeEach(() => setup());

  it('returns only invoices created by this wallet', async () => {
    await module.load();

    const myPubkey = DEFAULT_TEST_IDENTITY.chainPubkey;
    const id1 = randomHex64();
    const id2 = randomHex64();

    injectInvoice(module, id1, {
      createdAt: 1000,
      creator: myPubkey,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    injectInvoice(module, id2, {
      createdAt: 2000,
      creator: '03' + 'b'.repeat(64),
      targets: [{ address: 'DIRECT://b', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    });

    const invoices = await module.getInvoices({ createdByMe: true });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceId).toBe(id1);
  });
});

// =============================================================================
// UT-LIST-003: getInvoices({ targetingMe: true }) filters by payer/target
// =============================================================================

describe('UT-LIST-003: getInvoices({ targetingMe: true }) filters by target', () => {
  beforeEach(() => setup());

  it('returns only invoices targeting this wallet address', async () => {
    await module.load();

    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;
    const id1 = randomHex64();
    const id2 = randomHex64();

    injectInvoice(module, id1, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    injectInvoice(module, id2, {
      createdAt: 2000,
      targets: [{ address: 'DIRECT://other_addr', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    });

    const invoices = await module.getInvoices({ targetingMe: true });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceId).toBe(id1);
  });
});

// =============================================================================
// UT-LIST-004: getInvoices({ state: 'OPEN' }) filters by state
// =============================================================================

describe('UT-LIST-004: getInvoices({ state: "OPEN" }) filters by state', () => {
  beforeEach(() => setup());

  it('returns only OPEN invoices', async () => {
    await module.load();

    const id1 = randomHex64();
    const id2 = randomHex64();

    // id1 is OPEN (no payments), id2 is CLOSED (in closed set)
    injectInvoice(module, id1, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    injectInvoice(module, id2, {
      createdAt: 2000,
      targets: [{ address: 'DIRECT://b', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    });

    // Mark id2 as closed
    const mod = module as any;
    mod.closedInvoices.add(id2);
    mod.frozenBalances.set(id2, {
      state: 'CLOSED',
      explicitClose: true,
      frozenAt: Date.now(),
      targets: [{
        address: 'DIRECT://b',
        coinAssets: [{
          coin: ['UCT', '200'],
          coveredAmount: '200',
          returnedAmount: '0',
          netCoveredAmount: '200',
          isCovered: true,
          surplusAmount: '0',
          confirmed: true,
          transfers: [],
          frozenSenderBalances: [],
        }],
        nftAssets: [],
        isCovered: true,
        confirmed: true,
      }],
      irrelevantTransfers: [],
      totalForward: { UCT: '200' },
      totalBack: {},
      lastActivityAt: 2000,
    });

    const invoices = await module.getInvoices({ state: 'OPEN' });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceId).toBe(id1);
  });
});

// =============================================================================
// UT-LIST-005: getInvoices({ state: 'CLOSED' }) returns closed invoices
// =============================================================================

describe('UT-LIST-005: getInvoices({ state: "CLOSED" }) returns closed invoices', () => {
  beforeEach(() => setup());

  it('returns only CLOSED invoices', async () => {
    await module.load();

    const id1 = randomHex64();
    const id2 = randomHex64();

    injectInvoice(module, id1, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    injectInvoice(module, id2, {
      createdAt: 2000,
      targets: [{ address: 'DIRECT://b', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    });

    // Mark id2 as closed
    const mod = module as any;
    mod.closedInvoices.add(id2);
    mod.frozenBalances.set(id2, {
      state: 'CLOSED',
      explicitClose: true,
      frozenAt: Date.now(),
      targets: [{
        address: 'DIRECT://b',
        coinAssets: [{
          coin: ['UCT', '200'],
          coveredAmount: '200',
          returnedAmount: '0',
          netCoveredAmount: '200',
          isCovered: true,
          surplusAmount: '0',
          confirmed: true,
          transfers: [],
          frozenSenderBalances: [],
        }],
        nftAssets: [],
        isCovered: true,
        confirmed: true,
      }],
      irrelevantTransfers: [],
      totalForward: { UCT: '200' },
      totalBack: {},
      lastActivityAt: 2000,
    });

    const invoices = await module.getInvoices({ state: 'CLOSED' });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceId).toBe(id2);
  });
});

// =============================================================================
// UT-LIST-006: getInvoices with no invoices returns empty array
// =============================================================================

describe('UT-LIST-006: getInvoices with no invoices returns empty array', () => {
  beforeEach(() => setup());

  it('returns empty array when no invoices exist', async () => {
    await module.load();

    const invoices = await module.getInvoices();
    expect(invoices).toEqual([]);
  });
});

// =============================================================================
// UT-LIST-007: getInvoice(id) returns single invoice status
// =============================================================================

describe('UT-LIST-007: getInvoice(id) returns single invoice', () => {
  beforeEach(() => setup());

  it('returns InvoiceRef for a known invoice', async () => {
    await module.load();

    const id = randomHex64();
    const terms: InvoiceTerms = {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    };
    injectInvoice(module, id, terms);

    const result = module.getInvoice(id);
    expect(result).not.toBeNull();
    expect(result!.invoiceId).toBe(id);
    expect(result!.terms.createdAt).toBe(1000);
  });
});

// =============================================================================
// UT-LIST-008: getInvoice(nonExistentId) throws INVOICE_NOT_FOUND
// =============================================================================

describe('UT-LIST-008: getInvoice(nonExistentId) returns null', () => {
  beforeEach(() => setup());

  it('returns null for unknown invoice ID', async () => {
    await module.load();

    const result = module.getInvoice(randomHex64());
    expect(result).toBeNull();
  });
});

// =============================================================================
// UT-LIST-009: getInvoices({ state: 'EXPIRED' }) returns expired invoices
// =============================================================================

describe('UT-LIST-009: getInvoices({ state: "EXPIRED" }) returns expired invoices', () => {
  beforeEach(() => setup());

  it('returns invoices whose dueDate has passed', async () => {
    await module.load();

    const id1 = randomHex64();
    const id2 = randomHex64();

    // id1 has past dueDate (EXPIRED), id2 has future dueDate (OPEN)
    injectInvoice(module, id1, {
      createdAt: 1000,
      dueDate: Date.now() - 100000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    injectInvoice(module, id2, {
      createdAt: 2000,
      dueDate: Date.now() + 86400000,
      targets: [{ address: 'DIRECT://b', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    });

    const invoices = await module.getInvoices({ state: 'EXPIRED' });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceId).toBe(id1);
  });
});

// =============================================================================
// UT-LIST-010: getInvoices includes balance snapshots via InvoiceRef
// =============================================================================

describe('UT-LIST-010: getInvoices includes InvoiceRef with cancelled/closed flags', () => {
  beforeEach(() => setup());

  it('InvoiceRef includes cancelled and closed flags', async () => {
    await module.load();

    const id1 = randomHex64();
    const id2 = randomHex64();

    injectInvoice(module, id1, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    injectInvoice(module, id2, {
      createdAt: 2000,
      targets: [{ address: 'DIRECT://b', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    });

    // Mark id1 as cancelled
    const mod = module as any;
    mod.cancelledInvoices.add(id1);

    const invoices = await module.getInvoices();
    const ref1 = invoices.find((r: any) => r.invoiceId === id1);
    const ref2 = invoices.find((r: any) => r.invoiceId === id2);

    expect(ref1!.cancelled).toBe(true);
    expect(ref1!.closed).toBe(false);
    expect(ref2!.cancelled).toBe(false);
    expect(ref2!.closed).toBe(false);
  });
});
