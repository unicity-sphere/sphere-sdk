/**
 * AccountingModule — Concurrency gate tests (UT-CONCURRENCY)
 *
 * Tests for per-invoice async mutex (§5.9): serialization of concurrent
 * operations on same invoice, parallel operations on different invoices,
 * gate release on error, and close+pay race condition handling.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §6 (cross-cutting: concurrency)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  SphereError,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

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
// Concurrent operations on same invoice are serialized
// =============================================================================

describe('UT-CONCURRENCY: same invoice operations are serialized', () => {
  beforeEach(() => setup());

  it('serializes concurrent close attempts on same invoice', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;

    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());

    // First close should succeed
    const close1 = module.closeInvoice(invoiceId);
    // Second close should fail with ALREADY_CLOSED (serialized after first completes)
    const close2 = module.closeInvoice(invoiceId);

    const results = await Promise.allSettled([close1, close2]);

    // One should succeed, one should fail
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SphereError);
    expect(((rejected[0] as PromiseRejectedResult).reason as SphereError).code).toBe('INVOICE_ALREADY_CLOSED');
  });
});

// =============================================================================
// Concurrent operations on different invoices run in parallel
// =============================================================================

describe('UT-CONCURRENCY: different invoice operations run in parallel', () => {
  beforeEach(() => setup());

  it('allows simultaneous operations on different invoices', async () => {
    await module.load();

    const id1 = randomHex64();
    const id2 = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;

    mod.invoiceTermsCache.set(id1, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(id1, new Map());

    mod.invoiceTermsCache.set(id2, {
      createdAt: 2000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '200'] }] }],
    });
    mod.invoiceLedger.set(id2, new Map());

    // Both should succeed independently
    const [result1, result2] = await Promise.allSettled([
      module.closeInvoice(id1),
      module.closeInvoice(id2),
    ]);

    expect(result1.status).toBe('fulfilled');
    expect(result2.status).toBe('fulfilled');
  });
});

// =============================================================================
// Gate releases on error (doesn't deadlock)
// =============================================================================

describe('UT-CONCURRENCY: gate releases on error', () => {
  beforeEach(() => setup());

  it('subsequent operations succeed after a failed gated operation', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;

    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());

    // First close succeeds
    await module.closeInvoice(invoiceId);

    // Second close should throw ALREADY_CLOSED, not deadlock
    await expect(module.closeInvoice(invoiceId)).rejects.toMatchObject({ code: 'INVOICE_ALREADY_CLOSED' });

    // Third attempt should also get the error (gate was released)
    await expect(module.closeInvoice(invoiceId)).rejects.toMatchObject({ code: 'INVOICE_ALREADY_CLOSED' });
  });
});

// =============================================================================
// Close + pay race condition handled correctly
// =============================================================================

describe('UT-CONCURRENCY: close + pay race condition', () => {
  beforeEach(() => setup());

  it('pay after close throws INVOICE_TERMINATED', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;

    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());

    // Close the invoice
    await module.closeInvoice(invoiceId);

    // Pay should now fail with INVOICE_TERMINATED
    await expect(
      module.payInvoice(invoiceId, { targetIndex: 0 }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof SphereError && (e as SphereError).code === 'INVOICE_TERMINATED',
    );
  });
});
