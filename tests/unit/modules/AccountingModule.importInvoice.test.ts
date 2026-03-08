/**
 * AccountingModule — importInvoice() tests (§3.3)
 *
 * Validates the import flow: token type check, tokenData parsing,
 * terms business validation, duplicate detection, proof verification bypass,
 * storage, and retroactive payment indexing.
 *
 * importInvoice() internally calls Token.fromJSON() + token.verify() which
 * WILL FAIL with synthetic test data. We mock the SDK Token import at the
 * module level to bypass proof verification.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.3
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  createTestTransfer,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';

// =============================================================================
// Mock SDK Token — bypass proof verification for importInvoice()
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      verify: vi.fn().mockResolvedValue(true),
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      verify: vi.fn().mockResolvedValue(true),
    }),
  },
}));

// Mock txfToToken for the storage path
vi.mock('../../../serialization/txf-serializer.js', () => ({
  txfToToken: vi.fn().mockImplementation((tokenId: string, _txf: unknown) => ({
    id: tokenId,
    coinId: 'INVOICE',
    symbol: 'INVOICE',
    name: 'Invoice',
    decimals: 0,
    amount: '0',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(_txf),
  })),
}));

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
// Helper: create valid invoice terms
// =============================================================================

function validTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    createdAt: Date.now() - 60000,
    targets: [
      {
        address: 'DIRECT://target_addr_1',
        assets: [{ coin: ['UCT', '10000000'] as [string, string] }],
      },
    ],
    ...overrides,
  };
}

// =============================================================================
// UT-IMPORT-001: Valid invoice token import
// =============================================================================

describe('UT-IMPORT-001: Valid invoice token import', () => {
  beforeEach(() => setup());

  it('adds terms to cache and stores token via payments.addToken()', async () => {
    await module.load();

    const terms = validTerms();
    const token = createTestToken(terms);
    const tokenId = token.genesis.data.tokenId;

    // Mock addToken on payments
    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    const result = await module.importInvoice(token);

    // Terms are returned
    expect(result).toBeDefined();
    expect(result.createdAt).toBe(terms.createdAt);
    expect(result.targets).toEqual(terms.targets);

    // Cache is populated
    const mod = module as any;
    expect(mod.invoiceTermsCache.has(tokenId)).toBe(true);

    // addToken was called
    expect((mocks.payments as any).addToken).toHaveBeenCalled();
  });
});

// =============================================================================
// UT-IMPORT-002: Duplicate import returns INVOICE_ALREADY_EXISTS
// =============================================================================

describe('UT-IMPORT-002: Duplicate import throws INVOICE_ALREADY_EXISTS', () => {
  beforeEach(() => setup());

  it('throws INVOICE_ALREADY_EXISTS when importing same token twice', async () => {
    await module.load();

    const terms = validTerms();
    const token = createTestToken(terms);

    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    await module.importInvoice(token);

    // Second import should throw
    await expect(module.importInvoice(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_ALREADY_EXISTS',
    );
  });
});

// =============================================================================
// UT-IMPORT-003: Wrong token type throws INVOICE_WRONG_TOKEN_TYPE
// =============================================================================

describe('UT-IMPORT-003: Wrong token type throws INVOICE_WRONG_TOKEN_TYPE', () => {
  beforeEach(() => setup());

  it('rejects token with non-invoice tokenType', async () => {
    await module.load();

    const terms = validTerms();
    const token = createTestToken(terms);
    // Override tokenType to a non-invoice value
    token.genesis.data.tokenType = 'deadbeef'.repeat(8);

    await expect(module.importInvoice(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_WRONG_TOKEN_TYPE',
    );
  });
});

// =============================================================================
// UT-IMPORT-004: Unparseable tokenData throws INVOICE_INVALID_DATA
// =============================================================================

describe('UT-IMPORT-004: Unparseable tokenData throws INVOICE_INVALID_DATA', () => {
  beforeEach(() => setup());

  it('rejects token with corrupt JSON in tokenData', async () => {
    await module.load();

    const terms = validTerms();
    const token = createTestToken(terms);
    token.genesis.data.tokenData = '{not valid json!!!';

    await expect(module.importInvoice(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DATA',
    );
  });
});

// =============================================================================
// UT-IMPORT-005: Missing genesis data throws INVOICE_INVALID_DATA
// =============================================================================

describe('UT-IMPORT-005: Missing tokenData throws INVOICE_INVALID_DATA', () => {
  beforeEach(() => setup());

  it('rejects token with empty tokenData', async () => {
    await module.load();

    const terms = validTerms();
    const token = createTestToken(terms);
    token.genesis.data.tokenData = '';

    await expect(module.importInvoice(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DATA',
    );
  });
});

// =============================================================================
// UT-IMPORT-006: Invalid token structure (empty targets) throws INVOICE_INVALID_DATA
// =============================================================================

describe('UT-IMPORT-006: Invalid token structure throws INVOICE_INVALID_DATA', () => {
  beforeEach(() => setup());

  it('rejects token with empty targets array in terms', async () => {
    await module.load();

    const terms = { createdAt: Date.now() - 1000, targets: [] };
    const token = createTestToken(terms as any);

    await expect(module.importInvoice(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DATA',
    );
  });
});

// =============================================================================
// UT-IMPORT-007: Multi-target terms parsed correctly
// =============================================================================

describe('UT-IMPORT-007: Multi-target terms parsed correctly', () => {
  beforeEach(() => setup());

  it('imports token with multiple targets and assets', async () => {
    await module.load();

    const terms = validTerms({
      targets: [
        {
          address: 'DIRECT://target_1',
          assets: [
            { coin: ['UCT', '1000'] as [string, string] },
            { coin: ['USDU', '2000'] as [string, string] },
          ],
        },
        {
          address: 'DIRECT://target_2',
          assets: [{ coin: ['ALPHA', '500'] as [string, string] }],
        },
      ],
    });
    const token = createTestToken(terms);

    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    const result = await module.importInvoice(token);

    expect(result.targets).toHaveLength(2);
    expect(result.targets[0].assets).toHaveLength(2);
    expect(result.targets[1].assets).toHaveLength(1);
  });
});

// =============================================================================
// UT-IMPORT-008: Import with empty targets array throws
// =============================================================================

describe('UT-IMPORT-008: Import with empty targets throws', () => {
  beforeEach(() => setup());

  it('rejects token whose terms have an empty targets array', async () => {
    await module.load();

    const terms = { createdAt: Date.now() - 1000, targets: [] };
    const token = createTestToken(terms as any);

    await expect(module.importInvoice(token)).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_DATA',
    );
  });
});

// =============================================================================
// UT-IMPORT-009: Token stored via payments.addToken()
// =============================================================================

describe('UT-IMPORT-009: Import stores invoice token via payments', () => {
  beforeEach(() => setup());

  it('calls payments.addToken during import', async () => {
    await module.load();

    const terms = validTerms();
    const token = createTestToken(terms);

    const addToken = vi.fn().mockResolvedValue(undefined);
    (mocks.payments as any).addToken = addToken;

    await module.importInvoice(token);

    expect(addToken).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// UT-IMPORT-010: Expired dueDate still succeeds on import
// =============================================================================

describe('UT-IMPORT-010: Import with expired dueDate still succeeds', () => {
  beforeEach(() => setup());

  it('does not reject expired dueDate on import (expiry is informational)', async () => {
    await module.load();

    const terms = validTerms({
      dueDate: Date.now() - 86400000, // 1 day in the past
    });
    const token = createTestToken(terms);

    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    const result = await module.importInvoice(token);
    expect(result.dueDate).toBe(terms.dueDate);
  });
});

// =============================================================================
// UT-IMPORT-011: Proactive indexing — pre-indexed entries available on import
// =============================================================================

describe('UT-IMPORT-011: Proactive indexing picks up pre-indexed entries', () => {
  beforeEach(() => setup());

  it('entries indexed before import are available in the ledger after import', async () => {
    await module.load();
    const mod = module as any;

    const terms = validTerms();
    const invoiceToken = createTestToken(terms);
    const invoiceId = invoiceToken.genesis.data.tokenId;

    // Simulate a pre-existing payment token referencing this invoice BEFORE import.
    // The transfer was already scanned during load() or a prior event.
    const paymentTransfer = createTestTransfer(invoiceId, 'F', '5000000', 'UCT', 'DIRECT://some_sender', 'DIRECT://target_addr_1');

    // Build a UI token with sdkData containing the transfer
    const paymentTokenId = 'payment_' + 'f'.repeat(56);
    const paymentUiToken = {
      id: paymentTokenId,
      coinId: 'UCT',
      symbol: 'UCT',
      name: 'UCT',
      decimals: 0,
      amount: '5000000',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(paymentTransfer),
    };

    // Make getTokens return this payment token (simulates pre-existing inventory)
    mocks.payments.getTokens.mockReturnValue([paymentUiToken]);

    // Force scan of payment token (simulates what happens during load or event handling)
    mod._processTokenTransactions(paymentTokenId, paymentTransfer, 0);
    await mod._flushDirtyLedgerEntries();

    // At this point, invoiceTermsCache does NOT have invoiceId, but the ledger does
    // (proactive indexing)
    expect(mod.invoiceTermsCache.has(invoiceId)).toBe(false);
    const preLedger = mod.invoiceLedger.get(invoiceId);
    expect(preLedger).toBeDefined();
    expect(preLedger.size).toBeGreaterThan(0);

    // Now import the invoice
    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
    const result = await module.importInvoice(invoiceToken);
    expect(result).toBeDefined();

    // Ledger entries from proactive indexing should still be present
    const postLedger = mod.invoiceLedger.get(invoiceId);
    expect(postLedger).toBeDefined();
    expect(postLedger.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// UT-IMPORT-012: Token observer indexes transactions at add time
// =============================================================================

describe('UT-IMPORT-012: Token observer indexes transactions inline', () => {
  beforeEach(() => setup());

  it('token change callback indexes invoice transactions immediately', async () => {
    await module.load();
    const mod = module as any;

    // Verify onTokenChange was registered during load
    expect(mocks.payments.onTokenChange).toHaveBeenCalledOnce();

    const terms = validTerms();
    const invoiceToken = createTestToken(terms);
    const invoiceId = invoiceToken.genesis.data.tokenId;

    // Create a payment token referencing this invoice
    const paymentTransfer = createTestTransfer(invoiceId, 'F', '5000000', 'UCT', 'DIRECT://some_sender', 'DIRECT://target_addr_1');

    // The observer receives the genesis tokenId (from TXF) and the sdkData JSON
    const txfTokenId = paymentTransfer.genesis.data.tokenId;

    // Simulate PaymentsModule notifying about a new token via the observer
    const sdkData = JSON.stringify(paymentTransfer);
    mocks.payments._notifyTokenChange(txfTokenId, sdkData);

    // The ledger should now have entries for this invoice (indexed inline)
    const ledger = mod.invoiceLedger.get(invoiceId);
    expect(ledger).toBeDefined();
    expect(ledger.size).toBeGreaterThan(0);

    // Watermark should be advanced
    expect(mod.tokenScanState.get(txfTokenId)).toBe(1);
  });
});
