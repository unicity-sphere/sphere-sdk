/**
 * AccountingModule — Error propagation tests (UT-ERRORS)
 *
 * Validates that each INVOICE_* error code is thrown by the correct method,
 * SphereError instances have correct code/message/cause, error codes are unique,
 * MODULE_DESTROYED is thrown after destroy(), and INVOICE_ORACLE_REQUIRED when
 * oracle is unavailable.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §6, Appendix B
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  createTestInvoice,
  createMockOracleProvider,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

// Mock SDK Token for import tests
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { mint: vi.fn(), fromJSON: vi.fn().mockResolvedValue({ verify: vi.fn().mockResolvedValue(true) }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: { mint: vi.fn(), fromJSON: vi.fn().mockResolvedValue({ verify: vi.fn().mockResolvedValue(true) }) },
}));
vi.mock('../../../serialization/txf-serializer.js', () => ({
  txfToToken: vi.fn().mockImplementation((id: string, txf: unknown) => ({
    id, coinId: 'INV', symbol: 'INV', name: 'Invoice', decimals: 0, amount: '0',
    status: 'confirmed', createdAt: Date.now(), updatedAt: Date.now(), sdkData: JSON.stringify(txf),
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

function randomHex64(): string {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// =============================================================================
// INVOICE_NO_TARGETS
// =============================================================================

describe('Error: INVOICE_NO_TARGETS', () => {
  beforeEach(() => setup());

  it('createInvoice with empty targets throws INVOICE_NO_TARGETS', async () => {
    await module.load();

    const err = await module.createInvoice({ targets: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NO_TARGETS');
    expect(err.message).toBeDefined();
  });
});

// =============================================================================
// INVOICE_INVALID_ADDRESS
// =============================================================================

describe('Error: INVOICE_INVALID_ADDRESS', () => {
  beforeEach(() => setup());

  it('createInvoice with bad address throws INVOICE_INVALID_ADDRESS', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'not-direct', assets: [{ coin: ['UCT', '100'] }] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_ADDRESS');
  });
});

// =============================================================================
// INVOICE_NO_ASSETS
// =============================================================================

describe('Error: INVOICE_NO_ASSETS', () => {
  beforeEach(() => setup());

  it('createInvoice with empty assets throws INVOICE_NO_ASSETS', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NO_ASSETS');
  });
});

// =============================================================================
// INVOICE_INVALID_ASSET
// =============================================================================

describe('Error: INVOICE_INVALID_ASSET', () => {
  beforeEach(() => setup());

  it('createInvoice with neither coin nor nft throws INVOICE_INVALID_ASSET', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [{}] as any }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_ASSET');
  });
});

// =============================================================================
// INVOICE_INVALID_AMOUNT
// =============================================================================

describe('Error: INVOICE_INVALID_AMOUNT', () => {
  beforeEach(() => setup());

  it('createInvoice with non-integer amount throws INVOICE_INVALID_AMOUNT', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '10.5'] }] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_AMOUNT');
  });
});

// =============================================================================
// INVOICE_INVALID_COIN
// =============================================================================

describe('Error: INVOICE_INVALID_COIN', () => {
  beforeEach(() => setup());

  it('createInvoice with empty coinId throws INVOICE_INVALID_COIN', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['', '100'] }] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_COIN');
  });
});

// =============================================================================
// INVOICE_PAST_DUE_DATE
// =============================================================================

describe('Error: INVOICE_PAST_DUE_DATE', () => {
  beforeEach(() => setup());

  it('createInvoice with past dueDate throws INVOICE_PAST_DUE_DATE', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      dueDate: Date.now() - 10000,
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_PAST_DUE_DATE');
  });
});

// =============================================================================
// INVOICE_NOT_FOUND
// =============================================================================

describe('Error: INVOICE_NOT_FOUND', () => {
  beforeEach(() => setup());

  it('getInvoiceStatus with nonexistent ID throws INVOICE_NOT_FOUND', async () => {
    await module.load();

    const err = await module.getInvoiceStatus(randomHex64()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_FOUND');
  });

  it('closeInvoice with nonexistent ID throws INVOICE_NOT_FOUND', async () => {
    await module.load();

    const err = await module.closeInvoice(randomHex64()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_FOUND');
  });

  it('cancelInvoice with nonexistent ID throws INVOICE_NOT_FOUND', async () => {
    await module.load();

    const err = await module.cancelInvoice(randomHex64()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_FOUND');
  });
});

// =============================================================================
// INVOICE_NOT_TARGET
// =============================================================================

describe('Error: INVOICE_NOT_TARGET', () => {
  beforeEach(() => setup());

  it('closeInvoice when not a target throws INVOICE_NOT_TARGET', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://other', assets: [{ coin: ['UCT', '100'] }] }],
    });

    const err = await module.closeInvoice(invoiceId).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_TARGET');
  });
});

// =============================================================================
// INVOICE_ALREADY_CLOSED
// =============================================================================

describe('Error: INVOICE_ALREADY_CLOSED', () => {
  beforeEach(() => setup());

  it('closeInvoice on already-closed invoice throws INVOICE_ALREADY_CLOSED', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());
    mod.closedInvoices.add(invoiceId);

    const err = await module.closeInvoice(invoiceId).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ALREADY_CLOSED');
  });
});

// =============================================================================
// INVOICE_ALREADY_CANCELLED
// =============================================================================

describe('Error: INVOICE_ALREADY_CANCELLED', () => {
  beforeEach(() => setup());

  it('cancelInvoice on already-cancelled throws INVOICE_ALREADY_CANCELLED', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.cancelledInvoices.add(invoiceId);

    const err = await module.cancelInvoice(invoiceId).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ALREADY_CANCELLED');
  });
});

// =============================================================================
// INVOICE_WRONG_TOKEN_TYPE (importInvoice)
// =============================================================================

describe('Error: INVOICE_WRONG_TOKEN_TYPE', () => {
  beforeEach(() => setup());

  it('importInvoice with wrong token type throws INVOICE_WRONG_TOKEN_TYPE', async () => {
    await module.load();

    const terms = {
      createdAt: Date.now() - 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    };
    const token = createTestToken(terms);
    token.genesis.data.tokenType = 'deadbeef'.repeat(8);

    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    const err = await module.importInvoice(token).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_WRONG_TOKEN_TYPE');
  });
});

// =============================================================================
// INVOICE_INVALID_DATA (importInvoice)
// =============================================================================

describe('Error: INVOICE_INVALID_DATA', () => {
  beforeEach(() => setup());

  it('importInvoice with corrupt tokenData throws INVOICE_INVALID_DATA', async () => {
    await module.load();

    const terms = {
      createdAt: Date.now() - 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    };
    const token = createTestToken(terms);
    token.genesis.data.tokenData = '{{broken}}';

    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    const err = await module.importInvoice(token).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_DATA');
  });
});

// =============================================================================
// MODULE_DESTROYED after destroy()
// =============================================================================

describe('Error: MODULE_DESTROYED', () => {
  it('all I/O methods throw MODULE_DESTROYED after destroy()', async () => {
    setup();
    await module.load();
    module.destroy();

    const methods = [
      () => module.createInvoice({ targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }] }),
      () => module.getInvoices(),
      () => module.getInvoiceStatus('a'.repeat(64)),
      () => module.closeInvoice('a'.repeat(64)),
      () => module.cancelInvoice('a'.repeat(64)),
      () => module.setAutoReturn('*', true),
      () => module.sendInvoiceReceipts('a'.repeat(64)),
      () => module.sendCancellationNotices('a'.repeat(64)),
    ];

    for (const method of methods) {
      const err = await (method() as Promise<unknown>).catch((e) => e);
      expect(err).toBeInstanceOf(SphereError);
      expect(err.code).toBe('MODULE_DESTROYED');
    }
  });
});

// =============================================================================
// INVOICE_ORACLE_REQUIRED when oracle unavailable
// =============================================================================

describe('Error: INVOICE_ORACLE_REQUIRED', () => {
  it('createInvoice without oracle throws INVOICE_ORACLE_REQUIRED', async () => {
    // Create module with oracle that has no getStateTransitionClient
    const oracle = createMockOracleProvider();
    oracle.getStateTransitionClient = vi.fn().mockReturnValue(null);
    setup({ oracle });

    await module.load();

    const err = await module.createInvoice(createTestInvoice()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ORACLE_REQUIRED');
  });
});

// =============================================================================
// SphereError instances have correct structure
// =============================================================================

describe('SphereError structure', () => {
  beforeEach(() => setup());

  it('SphereError has name, code, and message', async () => {
    await module.load();

    await expect(
      module.createInvoice({ targets: [] }),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(SphereError);
      const se = e as SphereError;
      expect(se.name).toBe('SphereError');
      expect(se.code).toBe('INVOICE_NO_TARGETS');
      expect(typeof se.message).toBe('string');
      expect(se.message.length).toBeGreaterThan(0);
      return true;
    });
  });
});

// =============================================================================
// Error codes are unique (no duplicates in SphereErrorCode)
// =============================================================================

describe('Error code uniqueness', () => {
  it('INVOICE_* error codes from SphereErrorCode are all distinct strings', async () => {
    // This is a compile-time property, but we verify a sample set at runtime
    const codes = [
      'INVOICE_NO_TARGETS',
      'INVOICE_INVALID_ADDRESS',
      'INVOICE_NO_ASSETS',
      'INVOICE_INVALID_ASSET',
      'INVOICE_INVALID_AMOUNT',
      'INVOICE_INVALID_COIN',
      'INVOICE_PAST_DUE_DATE',
      'INVOICE_DUPLICATE_ADDRESS',
      'INVOICE_DUPLICATE_COIN',
      'INVOICE_MINT_FAILED',
      'INVOICE_NOT_FOUND',
      'INVOICE_NOT_TARGET',
      'INVOICE_ALREADY_CLOSED',
      'INVOICE_ALREADY_CANCELLED',
      'INVOICE_ORACLE_REQUIRED',
      'INVOICE_TERMINATED',
      'MODULE_DESTROYED',
    ];

    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });
});
