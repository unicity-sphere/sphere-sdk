/**
 * AccountingModule — Validation edge cases and security tests (UT-VALIDATION)
 *
 * Tests for input validation: invalid invoice ID format, zero/negative amounts,
 * duplicate targets/coins, too many targets/assets, memo length limits,
 * payInvoice to non-target, returnInvoicePayment exceeding balance, and
 * MODULE_DESTROYED guard.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §6 (cross-cutting concerns)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  SphereError,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

// =============================================================================
// Mock SDK imports to allow createInvoice validation tests (short-circuit before mint)
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { mint: vi.fn(), fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: { mint: vi.fn(), fromJSON: vi.fn() },
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
// createInvoice with zero-amount asset throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with zero-amount asset', () => {
  beforeEach(() => setup());

  it('throws INVOICE_INVALID_AMOUNT for zero amount', async () => {
    await module.load();

    await expect(
      module.createInvoice(createTestInvoice({
        targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '0'] }] }],
      })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// createInvoice with negative amount throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with negative amount', () => {
  beforeEach(() => setup());

  it('throws INVOICE_INVALID_AMOUNT for negative amount', async () => {
    await module.load();

    await expect(
      module.createInvoice(createTestInvoice({
        targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '-100'] }] }],
      })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// createInvoice with duplicate targets throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with duplicate targets', () => {
  beforeEach(() => setup());

  it('throws INVOICE_DUPLICATE_ADDRESS for duplicate target addresses', async () => {
    await module.load();

    await expect(
      module.createInvoice(createTestInvoice({
        targets: [
          { address: 'DIRECT://alice', assets: [{ coin: ['UCT', '100'] }] },
          { address: 'DIRECT://alice', assets: [{ coin: ['USDU', '200'] }] },
        ],
      })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_DUPLICATE_ADDRESS',
    );
  });
});

// =============================================================================
// createInvoice with duplicate coin in same target throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with duplicate coin in same target', () => {
  beforeEach(() => setup());

  it('throws INVOICE_DUPLICATE_COIN for duplicate coinIds in a target', async () => {
    await module.load();

    await expect(
      module.createInvoice(createTestInvoice({
        targets: [{
          address: 'DIRECT://alice',
          assets: [
            { coin: ['UCT', '100'] },
            { coin: ['UCT', '200'] },
          ],
        }],
      })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_DUPLICATE_COIN',
    );
  });
});

// =============================================================================
// createInvoice with too many targets throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with too many targets', () => {
  beforeEach(() => setup());

  it('throws INVOICE_TOO_MANY_TARGETS for >100 targets', async () => {
    await module.load();

    const targets = Array.from({ length: 101 }, (_, i) => ({
      address: `DIRECT://target_${i}`,
      assets: [{ coin: ['UCT', '100'] as [string, string] }],
    }));

    await expect(
      module.createInvoice(createTestInvoice({ targets })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_TOO_MANY_TARGETS',
    );
  });
});

// =============================================================================
// createInvoice with too many assets throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with too many assets', () => {
  beforeEach(() => setup());

  it('throws INVOICE_TOO_MANY_ASSETS for >50 assets per target', async () => {
    await module.load();

    const assets = Array.from({ length: 51 }, (_, i) => ({
      coin: [`COIN${i}`, '100'] as [string, string],
    }));

    await expect(
      module.createInvoice(createTestInvoice({
        targets: [{ address: 'DIRECT://alice', assets }],
      })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_TOO_MANY_ASSETS',
    );
  });
});

// =============================================================================
// createInvoice with memo exceeding max length throws
// =============================================================================

describe('UT-VALIDATION: createInvoice with memo exceeding max length', () => {
  beforeEach(() => setup());

  it('throws INVOICE_MEMO_TOO_LONG for memo > 4096 chars', async () => {
    await module.load();

    await expect(
      module.createInvoice(createTestInvoice({ memo: 'x'.repeat(4097) })),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_MEMO_TOO_LONG',
    );
  });
});

// =============================================================================
// payInvoice to non-existent invoice throws
// =============================================================================

describe('UT-VALIDATION: payInvoice on non-existent invoice', () => {
  beforeEach(() => setup());

  it('throws INVOICE_NOT_FOUND for unknown invoice', async () => {
    await module.load();

    await expect(
      module.payInvoice(randomHex64(), {
        targetIndex: 0,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_FOUND',
    );
  });
});

// =============================================================================
// returnInvoicePayment on non-target throws
// =============================================================================

describe('UT-VALIDATION: returnInvoicePayment when not a target', () => {
  beforeEach(() => setup());

  it('throws INVOICE_NOT_TARGET when wallet is not an invoice target', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://someone_else', assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());

    await expect(
      module.returnInvoicePayment(invoiceId, {
        recipient: 'DIRECT://sender',
        coinId: 'UCT',
        amount: '50',
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'INVOICE_NOT_TARGET',
    );
  });
});

// =============================================================================
// Operations on destroyed module throw MODULE_DESTROYED
// =============================================================================

describe('UT-VALIDATION: MODULE_DESTROYED after destroy()', () => {
  beforeEach(async () => {
    setup();
    await module.load();
    module.destroy();
  });

  it('createInvoice throws MODULE_DESTROYED', async () => {
    await expect(
      module.createInvoice(createTestInvoice()),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'MODULE_DESTROYED',
    );
  });

  it('getInvoices throws MODULE_DESTROYED', async () => {
    await expect(
      module.getInvoices(),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'MODULE_DESTROYED',
    );
  });

  it('setAutoReturn throws MODULE_DESTROYED', async () => {
    await expect(
      module.setAutoReturn('*', true),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'MODULE_DESTROYED',
    );
  });

  it('closeInvoice throws MODULE_DESTROYED', async () => {
    await expect(
      module.closeInvoice('a'.repeat(64)),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'MODULE_DESTROYED',
    );
  });

  it('cancelInvoice throws MODULE_DESTROYED', async () => {
    await expect(
      module.cancelInvoice('a'.repeat(64)),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'MODULE_DESTROYED',
    );
  });
});
