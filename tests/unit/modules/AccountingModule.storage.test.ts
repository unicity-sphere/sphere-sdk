/**
 * AccountingModule — Storage persistence tests (UT-STORAGE)
 *
 * Tests for persisted data: cancelled/closed sets, frozen balances,
 * auto-return settings, ledger index, crash recovery, and storage
 * write order.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §6
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createMockStorageProvider,
  SphereError,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';
import { STORAGE_KEYS_ADDRESS, getAddressId } from '../../../constants.js';

// Mock SDK Token to prevent cross-file mock contamination when run alongside
// other test files (e.g., importInvoice, validation, errors) that mock this module.
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { mint: vi.fn(), fromJSON: vi.fn().mockResolvedValue({ verify: vi.fn().mockResolvedValue(true) }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: { mint: vi.fn(), fromJSON: vi.fn().mockResolvedValue({ verify: vi.fn().mockResolvedValue(true) }) },
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
// Storage persistence of cancelled/closed sets
// =============================================================================

describe('UT-STORAGE: cancelled/closed set persistence', () => {
  beforeEach(() => setup());

  it('load() restores cancelled set from storage', async () => {
    const directAddress = mocks.identity.directAddress!;
    const cancelledKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES}`;
    const frozenKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.FROZEN_BALANCES}`;

    const cancelledId = 'a'.repeat(64);
    mocks.storage._data.set(cancelledKey, JSON.stringify([cancelledId]));
    mocks.storage._data.set(frozenKey, JSON.stringify({
      [cancelledId]: {
        state: 'CANCELLED',
        targets: [],
        frozenAt: Date.now(),
        irrelevantTransfers: [],
        totalForward: {},
        totalBack: {},
        lastActivityAt: 0,
      },
    }));

    await module.load();

    const mod = module as any;
    expect(mod.cancelledInvoices.has(cancelledId)).toBe(true);
  });

  it('load() restores closed set from storage', async () => {
    const directAddress = mocks.identity.directAddress!;
    const closedKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.CLOSED_INVOICES}`;
    const frozenKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.FROZEN_BALANCES}`;

    const closedId = 'b'.repeat(64);
    mocks.storage._data.set(closedKey, JSON.stringify([closedId]));
    mocks.storage._data.set(frozenKey, JSON.stringify({
      [closedId]: {
        state: 'CLOSED',
        explicitClose: true,
        targets: [],
        frozenAt: Date.now(),
        irrelevantTransfers: [],
        totalForward: {},
        totalBack: {},
        lastActivityAt: 0,
      },
    }));

    await module.load();

    const mod = module as any;
    expect(mod.closedInvoices.has(closedId)).toBe(true);
  });
});

// =============================================================================
// Storage persistence of frozen balances
// =============================================================================

describe('UT-STORAGE: frozen balances persistence', () => {
  beforeEach(() => setup());

  it('load() restores frozen balances from storage', async () => {
    const directAddress = mocks.identity.directAddress!;
    const frozenKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.FROZEN_BALANCES}`;
    const closedKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.CLOSED_INVOICES}`;

    const closedId = 'c'.repeat(64);
    const frozenData = {
      state: 'CLOSED',
      explicitClose: true,
      frozenAt: 1234567890,
      targets: [],
      irrelevantTransfers: [],
      totalForward: { UCT: '100' },
      totalBack: {},
      lastActivityAt: 1000,
    };

    mocks.storage._data.set(closedKey, JSON.stringify([closedId]));
    mocks.storage._data.set(frozenKey, JSON.stringify({ [closedId]: frozenData }));

    await module.load();

    const mod = module as any;
    expect(mod.frozenBalances.has(closedId)).toBe(true);
    expect(mod.frozenBalances.get(closedId).state).toBe('CLOSED');
  });
});

// =============================================================================
// Storage persistence of auto-return settings
// =============================================================================

describe('UT-STORAGE: auto-return settings persistence', () => {
  beforeEach(() => setup());

  it('load() restores auto-return settings from storage', async () => {
    const directAddress = mocks.identity.directAddress!;
    const autoReturnKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.AUTO_RETURN}`;
    const invoiceId = 'd'.repeat(64);

    mocks.storage._data.set(autoReturnKey, JSON.stringify({
      global: true,
      perInvoice: { [invoiceId]: false },
    }));

    await module.load();

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(true);
    expect(settings.perInvoice[invoiceId]).toBe(false);
  });
});

// =============================================================================
// Crash recovery: load restores terminal sets before frozen balances
// =============================================================================

describe('UT-STORAGE: crash recovery — terminal sets loaded before frozen balances', () => {
  beforeEach(() => setup());

  it('forward reconciliation: frozen balance without terminal entry gets auto-added', async () => {
    const directAddress = mocks.identity.directAddress!;
    const frozenKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.FROZEN_BALANCES}`;
    // Do NOT set cancelled/closed keys — simulate crash after frozen save but before terminal set save

    const invoiceId = 'e'.repeat(64);
    mocks.storage._data.set(frozenKey, JSON.stringify({
      [invoiceId]: {
        state: 'CANCELLED',
        targets: [],
        frozenAt: Date.now(),
        irrelevantTransfers: [],
        totalForward: {},
        totalBack: {},
        lastActivityAt: 0,
      },
    }));

    await module.load();

    // Forward reconciliation should have added it to cancelledInvoices
    const mod = module as any;
    expect(mod.cancelledInvoices.has(invoiceId)).toBe(true);
  });
});

// =============================================================================
// Storage write order: terminal set first, frozen balances second
// =============================================================================

describe('UT-STORAGE: write order — terminal set before frozen balances', () => {
  beforeEach(() => setup());

  it('closeInvoice persists closed set before frozen balances', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;

    // Inject an invoice targeting our address
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());

    const callOrder: string[] = [];
    const originalSet = mocks.storage.set;
    mocks.storage.set = vi.fn().mockImplementation(async (key: string, value: string) => {
      const directAddress = mocks.identity.directAddress!;
      if (key.includes(STORAGE_KEYS_ADDRESS.CLOSED_INVOICES)) {
        callOrder.push('CLOSED_SET');
      }
      if (key.includes(STORAGE_KEYS_ADDRESS.FROZEN_BALANCES)) {
        callOrder.push('FROZEN_BALANCES');
      }
      return (originalSet as any)(key, value);
    });

    await module.closeInvoice(invoiceId);

    // Closed set should be persisted before frozen balances
    const closedIdx = callOrder.indexOf('CLOSED_SET');
    const frozenIdx = callOrder.indexOf('FROZEN_BALANCES');
    expect(closedIdx).toBeLessThan(frozenIdx);
  });
});

// =============================================================================
// Corrupted storage data handled gracefully
// =============================================================================

describe('UT-STORAGE: corrupted storage data handled gracefully', () => {
  beforeEach(() => setup());

  it('load() handles corrupted cancelled set JSON gracefully', async () => {
    const directAddress = mocks.identity.directAddress!;
    const cancelledKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES}`;

    mocks.storage._data.set(cancelledKey, 'NOT VALID JSON {{{');

    // Should not throw
    await module.load();

    const mod = module as any;
    expect(mod.cancelledInvoices.size).toBe(0);
  });

  it('load() handles corrupted frozen balances JSON gracefully', async () => {
    const directAddress = mocks.identity.directAddress!;
    const frozenKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.FROZEN_BALANCES}`;

    mocks.storage._data.set(frozenKey, '<<CORRUPT>>');

    await module.load();

    const mod = module as any;
    expect(mod.frozenBalances.size).toBe(0);
  });

  it('load() handles corrupted auto-return settings gracefully', async () => {
    const directAddress = mocks.identity.directAddress!;
    const autoReturnKey = `${getAddressId(directAddress)}_${STORAGE_KEYS_ADDRESS.AUTO_RETURN}`;

    mocks.storage._data.set(autoReturnKey, '!!!');

    await module.load();

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(false);
  });
});
