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
// Storage write order: frozen balances first, terminal set second (C12 crash safety)
// =============================================================================

describe('UT-STORAGE: write order — frozen balances before terminal set (C12)', () => {
  beforeEach(() => setup());

  it('closeInvoice persists frozen balances before closed set', async () => {
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
      if (key.includes(STORAGE_KEYS_ADDRESS.CLOSED_INVOICES)) {
        callOrder.push('CLOSED_SET');
      }
      if (key.includes(STORAGE_KEYS_ADDRESS.FROZEN_BALANCES)) {
        callOrder.push('FROZEN_BALANCES');
      }
      return (originalSet as any)(key, value);
    });

    await module.closeInvoice(invoiceId);

    // C12 fix: Frozen balances should be persisted BEFORE closed set.
    // The terminal set write is the commit point — crash between writes
    // means the invoice is NOT terminal on recovery (safe to re-close).
    const closedIdx = callOrder.indexOf('CLOSED_SET');
    const frozenIdx = callOrder.indexOf('FROZEN_BALANCES');
    expect(frozenIdx).toBeLessThan(closedIdx);
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

// =============================================================================
// Unknown invoice ID cap prevents unbounded growth (W5 fix)
// =============================================================================

describe('UT-STORAGE: unknown invoice ID cap (W5 fix)', () => {
  beforeEach(() => setup());

  it('UT-PROACTIVE-CAP-001: unknown invoice ID cap prevents unbounded growth', async () => {
    await module.load();

    const mod = module as any;

    // Populate invoiceLedger with 500 unknown invoice IDs
    // (not in invoiceTermsCache → "unknown")
    const MAX_UNKNOWN = 500;
    for (let i = 0; i < MAX_UNKNOWN; i++) {
      const fakeInvoiceId = i.toString(16).padStart(64, '0');
      mod.invoiceLedger.set(fakeInvoiceId, new Map());
    }
    // W11 fix: Set the counter-based tracking field to match
    mod.unknownLedgerCount = MAX_UNKNOWN;

    // Verify we have 500 unknown IDs
    expect(mod.unknownLedgerCount).toBe(MAX_UNKNOWN);

    // Create a transfer token referencing a NEW unknown invoice (ID #501)
    const newUnknownId = 'f'.repeat(64);
    const { createTestTransfer } = await import('./accounting-test-helpers.js');
    const txf = createTestTransfer(newUnknownId, 'F', '1000000', 'UCT');

    // Call _processTokenTransactions — should NOT add the new unknown invoice (cap reached)
    mod._processTokenTransactions(txf.genesis.data.tokenId, txf, 0);

    expect(mod.invoiceLedger.has(newUnknownId)).toBe(false);

    // Now make one of the 500 IDs "known" by adding it to invoiceTermsCache
    const knownId = (0).toString(16).padStart(64, '0');
    mod.invoiceTermsCache.set(knownId, {
      createdAt: Date.now(),
      targets: [{ address: 'DIRECT://test_target_address_abc123', assets: [{ coin: ['UCT', '100'] }] }],
    });
    // Simulate the counter decrement that importInvoice() would do (W11 fix)
    mod.unknownLedgerCount = Math.max(0, mod.unknownLedgerCount - 1);

    // Now unknown count = 499 (under cap). The new unknown should be accepted.
    // Use a fresh tokenId to avoid watermark dedup.
    const txf2 = createTestTransfer(newUnknownId, 'F', '1000000', 'UCT');
    mod._processTokenTransactions(txf2.genesis.data.tokenId, txf2, 0);

    expect(mod.invoiceLedger.has(newUnknownId)).toBe(true);
  });
});
