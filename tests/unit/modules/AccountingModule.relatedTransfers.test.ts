/**
 * AccountingModule — getRelatedTransfers() tests (UT-RELATED)
 *
 * Validates getRelatedTransfers(): empty array for unknown invoice,
 * all transfers for known invoice, direction filtering (forward/back),
 * both directions, and timestamp ordering.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.8
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransferRef,
  SphereError,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';
import type { InvoiceTransferRef } from '../../../modules/accounting/types.js';

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
// Returns empty array for unknown invoice
// =============================================================================

describe('getRelatedTransfers: unknown invoice throws INVOICE_NOT_FOUND', () => {
  beforeEach(() => setup());

  it('throws INVOICE_NOT_FOUND for non-existent invoice', async () => {
    await module.load();

    expect(() => module.getRelatedTransfers(randomHex64())).toThrow(
      expect.objectContaining({ code: 'INVOICE_NOT_FOUND' }),
    );
  });
});

// =============================================================================
// Returns all transfers for known invoice
// =============================================================================

describe('getRelatedTransfers: returns indexed transfers for known invoice', () => {
  beforeEach(() => setup());

  it('returns all ledger entries for a known invoice', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;

    // Inject invoice terms
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }],
    });

    // Inject ledger entries
    const innerMap = new Map<string, InvoiceTransferRef>();
    const ref1 = createTestTransferRef(invoiceId, 'forward', '100', 'UCT', {
      timestamp: 1000,
      transferId: 'txf-1',
    });
    const ref2 = createTestTransferRef(invoiceId, 'forward', '200', 'UCT', {
      timestamp: 2000,
      transferId: 'txf-2',
    });
    innerMap.set(`${ref1.transferId}::UCT`, ref1);
    innerMap.set(`${ref2.transferId}::UCT`, ref2);
    mod.invoiceLedger.set(invoiceId, innerMap);

    const result = module.getRelatedTransfers(invoiceId);
    expect(result).toHaveLength(2);
  });
});

// =============================================================================
// Includes both forward and return transfers
// =============================================================================

describe('getRelatedTransfers: includes both forward and return transfers', () => {
  beforeEach(() => setup());

  it('returns forward and back payment transfers', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;

    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }],
    });

    const innerMap = new Map<string, InvoiceTransferRef>();
    const forward = createTestTransferRef(invoiceId, 'forward', '100', 'UCT', {
      timestamp: 1000,
      transferId: 'fwd-1',
    });
    const back = createTestTransferRef(invoiceId, 'back', '50', 'UCT', {
      timestamp: 2000,
      transferId: 'back-1',
    });
    innerMap.set(`${forward.transferId}::UCT`, forward);
    innerMap.set(`${back.transferId}::UCT`, back);
    mod.invoiceLedger.set(invoiceId, innerMap);

    const result = module.getRelatedTransfers(invoiceId);
    expect(result).toHaveLength(2);

    const directions = result.map((r: any) => r.paymentDirection);
    expect(directions).toContain('forward');
    expect(directions).toContain('back');
  });
});

// =============================================================================
// Returns transfers ordered by timestamp
// =============================================================================

describe('getRelatedTransfers: returns transfers ordered by timestamp', () => {
  beforeEach(() => setup());

  it('entries are sorted by timestamp ascending', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;

    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }],
    });

    const innerMap = new Map<string, InvoiceTransferRef>();
    const ref1 = createTestTransferRef(invoiceId, 'forward', '100', 'UCT', {
      timestamp: 3000,
      transferId: 'txf-3',
    });
    const ref2 = createTestTransferRef(invoiceId, 'forward', '200', 'UCT', {
      timestamp: 1000,
      transferId: 'txf-1',
    });
    const ref3 = createTestTransferRef(invoiceId, 'back', '50', 'UCT', {
      timestamp: 2000,
      transferId: 'txf-2',
    });
    // Deliberately insert out of order
    innerMap.set(`${ref1.transferId}::UCT`, ref1);
    innerMap.set(`${ref2.transferId}::UCT`, ref2);
    innerMap.set(`${ref3.transferId}::UCT`, ref3);
    mod.invoiceLedger.set(invoiceId, innerMap);

    const result = module.getRelatedTransfers(invoiceId);
    expect(result).toHaveLength(3);

    // Should be sorted by timestamp ascending
    expect(result[0].timestamp).toBeLessThanOrEqual(result[1].timestamp);
    expect(result[1].timestamp).toBeLessThanOrEqual(result[2].timestamp);
  });
});

// =============================================================================
// Empty ledger returns empty array
// =============================================================================

describe('getRelatedTransfers: empty ledger returns empty array', () => {
  beforeEach(() => setup());

  it('returns empty array when no transfers exist for invoice', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;

    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());

    const result = module.getRelatedTransfers(invoiceId);
    expect(result).toEqual([]);
  });
});
