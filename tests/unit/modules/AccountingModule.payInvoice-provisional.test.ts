/**
 * Unit tests for BUG-002 Fix 2: Provisional reservation in payInvoice().
 *
 * The fix moves balance computation and send() inside the per-invoice gate
 * (withInvoiceGate) and writes a provisional forward ledger entry after send()
 * succeeds, preventing concurrent payInvoice() calls from double-computing
 * the remaining amount.
 *
 * UT-PAY-PROV-001 – UT-PAY-PROV-007  (7 tests)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  DEFAULT_TEST_IDENTITY,
  DEFAULT_TEST_TRACKED_ADDRESS,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import { getAddressId } from '../../../constants.js';
import type { InvoiceTerms, InvoiceTransferRef } from '../../../modules/accounting/types.js';
import type { Token, TransferResult } from '../../../types/index.js';

// =============================================================================
// Helpers
// =============================================================================

/** Minimal 64-char lowercase hex string used as an invoice ID in tests. */
const INVOICE_ID = 'a'.repeat(64);

/** Wallet's own address (from DEFAULT_TEST_TRACKED_ADDRESS). */
const WALLET_ADDRESS = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;

/**
 * External payee address — must differ from the wallet identity address
 * to avoid the self-payment filter in computeInvoiceStatus when testing
 * balance computation (e.g., concurrent payInvoice double-pay prevention).
 */
const PAYEE_ADDRESS = 'DIRECT://payee_target_address_xyz789';

/** Build a Token shape that load() will parse as an invoice token. */
function makeInvoiceToken(terms: InvoiceTerms, tokenId: string = INVOICE_ID): Token {
  const txf = createTestToken(terms, tokenId);
  return {
    id: tokenId,
    coinId: INVOICE_TOKEN_TYPE_HEX,
    symbol: 'INV',
    name: 'Invoice',
    decimals: 0,
    amount: '0',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

/**
 * Minimal terms for a single-target, single-asset invoice.
 * Default target is PAYEE_ADDRESS (external), override for tests that need
 * the wallet to be a target (e.g., closeInvoice which requires isTarget()).
 */
function makeTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    creator: DEFAULT_TEST_IDENTITY.chainPubkey,
    createdAt: Date.now() - 1000,
    targets: [
      {
        address: PAYEE_ADDRESS,
        assets: [{ coin: ['UCT', '1000'] }],
      },
    ],
    ...overrides,
  };
}

/**
 * Make terms where the wallet is one of the targets.
 * Required for operations like closeInvoice that check isTarget().
 */
function makeTermsWithWalletAsTarget(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    creator: DEFAULT_TEST_IDENTITY.chainPubkey,
    createdAt: Date.now() - 1000,
    targets: [
      {
        address: WALLET_ADDRESS,
        assets: [{ coin: ['UCT', '1000'] }],
      },
    ],
    ...overrides,
  };
}

// =============================================================================
// payInvoice() — Provisional reservation tests
// =============================================================================

describe('AccountingModule.payInvoice() — provisional reservation (BUG-002 Fix 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // UT-PAY-PROV-001
  it('UT-PAY-PROV-001: payInvoice writes provisional forward entry after send succeeds', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
    });

    // Inspect the in-memory ledger for a provisional entry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = (module as any).invoiceLedger.get(INVOICE_ID) as Map<string, InvoiceTransferRef>;
    expect(ledger).toBeDefined();

    const provisionalEntries = Array.from(ledger.entries()).filter(
      ([key]) => key.startsWith('provisional:'),
    );
    expect(provisionalEntries.length).toBeGreaterThanOrEqual(1);

    const [entryKey, ref] = provisionalEntries[0]!;
    expect(entryKey).toBe(`provisional:${result.id}::UCT`);
    expect(ref.direction).toBe('outbound');
    expect(ref.paymentDirection).toBe('forward');
    expect(ref.coinId).toBe('UCT');
    expect(ref.amount).toBe('1000');
    expect(ref.confirmed).toBe(false);
    expect(ref.destinationAddress).toBe(PAYEE_ADDRESS);
  });

  // UT-PAY-PROV-002
  it('UT-PAY-PROV-002: concurrent payInvoice calls do NOT double-pay', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Make send() resolve after a 50ms delay to simulate network latency
    let sendCallCount = 0;
    mocks.payments.send.mockImplementation((): Promise<TransferResult> => {
      sendCallCount++;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            id: `mock-transfer-${sendCallCount}`,
            status: 'completed',
            tokens: [],
            tokenTransfers: [],
          });
        }, 50);
      });
    });

    // Call payInvoice() twice concurrently (both without explicit amount — auto-compute remaining)
    const [result1, result2] = await Promise.allSettled([
      module.payInvoice(INVOICE_ID, { targetIndex: 0 }),
      module.payInvoice(INVOICE_ID, { targetIndex: 0 }),
    ]);

    // First call should succeed (sends remaining=1000)
    const fulfilled = [result1, result2].filter((r) => r.status === 'fulfilled');
    const rejected = [result1, result2].filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The second call should throw INVOICE_INVALID_AMOUNT (already fully covered)
    const err = (rejected[0] as PromiseRejectedResult).reason as SphereError;
    expect(err.code).toBe('INVOICE_INVALID_AMOUNT');

    // send() should only have been called once
    expect(sendCallCount).toBe(1);
  });

  // UT-PAY-PROV-003
  it('UT-PAY-PROV-003: payInvoice with explicit amount bypasses remaining computation', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '500',
    });

    // Verify send() was called with the explicit amount
    expect(mocks.payments.send).toHaveBeenCalledOnce();
    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendCall.amount).toBe('500');

    // Verify provisional entry has amount='500'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = (module as any).invoiceLedger.get(INVOICE_ID) as Map<string, InvoiceTransferRef>;
    const provisionalEntries = Array.from(ledger.entries()).filter(
      ([key]) => key.startsWith('provisional:'),
    );
    expect(provisionalEntries.length).toBeGreaterThanOrEqual(1);
    expect(provisionalEntries[0]![1].amount).toBe('500');
  });

  // UT-PAY-PROV-004
  it('UT-PAY-PROV-004: payInvoice timeout after 60 seconds', async () => {
    vi.useFakeTimers();

    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Mock send() to never resolve but allow the promise to be tracked
    // so we can suppress unhandled rejection warnings.
    let rejectSend: ((reason: unknown) => void) | undefined;
    mocks.payments.send.mockImplementation((): Promise<TransferResult> => {
      return new Promise((_resolve, reject) => {
        rejectSend = reject;
      });
    });

    const payPromise = module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '500',
    });

    // Attach a no-op catch to prevent unhandled rejection from the gate's
    // internal promise chain propagating after timer advancement.
    payPromise.catch(() => { /* expected timeout rejection */ });

    // Advance timer past the 60-second timeout
    await vi.advanceTimersByTimeAsync(60_001);

    await expect(payPromise).rejects.toMatchObject({ code: 'TIMEOUT' });

    // Clean up the dangling send promise to avoid unhandled rejection
    if (rejectSend) rejectSend(new Error('test cleanup'));

    // Restore real timers immediately to prevent stale timer leaks
    vi.useRealTimers();
  });

  // UT-PAY-PROV-005
  it('UT-PAY-PROV-005: payInvoice holds gate — concurrent operations are serialized', async () => {
    // Use wallet address as target so closeInvoice's isTarget() check passes
    const terms = makeTermsWithWalletAsTarget();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    const executionOrder: string[] = [];

    // Make send() resolve after a 50ms delay to hold the gate open
    mocks.payments.send.mockImplementation((): Promise<TransferResult> => {
      return new Promise((resolve) => {
        setTimeout(() => {
          executionOrder.push('send_complete');
          resolve({
            id: 'mock-transfer-gate',
            status: 'completed',
            tokens: [],
            tokenTransfers: [],
          });
        }, 50);
      });
    });

    // Call payInvoice() and immediately try to close the invoice concurrently
    const payPromise = module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '500',
    }).then(() => {
      executionOrder.push('pay_resolved');
    });

    const closePromise = module.closeInvoice(INVOICE_ID).then(() => {
      executionOrder.push('close_resolved');
    });

    await Promise.allSettled([payPromise, closePromise]);

    // payInvoice should complete before closeInvoice starts (serialized by gate)
    const sendIdx = executionOrder.indexOf('send_complete');
    const payIdx = executionOrder.indexOf('pay_resolved');
    const closeIdx = executionOrder.indexOf('close_resolved');

    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(payIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThanOrEqual(0);

    expect(sendIdx).toBeLessThan(closeIdx);
    expect(payIdx).toBeLessThan(closeIdx);
  });

  // UT-PAY-PROV-006
  it('UT-PAY-PROV-006: payInvoice terminal check inside gate catches concurrent close', async () => {
    // Use wallet address as target so closeInvoice's isTarget() check passes
    const terms = makeTermsWithWalletAsTarget();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Close the invoice first
    await module.closeInvoice(INVOICE_ID);

    // Now payInvoice should fail with INVOICE_TERMINATED (checked inside the gate)
    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 0, assetIndex: 0, amount: '500' }),
    ).rejects.toMatchObject({ code: 'INVOICE_TERMINATED' });

    // send() should NOT have been called
    expect(mocks.payments.send).not.toHaveBeenCalled();
  });

  // UT-PAY-PROV-007
  it('UT-PAY-PROV-007: provisional entry invalidates balance cache', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Pre-populate balanceCache for the invoice to simulate a cached state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = module as any;
    mod.balanceCache.set(INVOICE_ID, {
      aggregate: new Map([
        [`${PAYEE_ADDRESS}::UCT`, { covered: 0n, returned: 0n }],
      ]),
    });

    // Verify cache is populated
    expect(mod.balanceCache.has(INVOICE_ID)).toBe(true);

    await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '500',
    });

    // After payInvoice, balanceCache for this invoice should be invalidated
    expect(mod.balanceCache.has(INVOICE_ID)).toBe(false);
  });

  // UT-PAY-PROV-008
  // Durability test: the provisional ledger entry must reach disk BEFORE
  // payInvoice returns. Without this guarantee, a crash between `send()`
  // returning to the caller and the next deferred-flush trigger would lose
  // the provisional entry, allowing a recovery-time recompute to re-issue
  // the same payment as a distinct second on-chain transferId — producing
  // over-coverage on the receiver. Regression coverage for the audit's #1
  // hypothesis on Carol's payout-invoice over-coverage in the multi-trader
  // e2e (escrow-service crash-recovery audit, May 2026).
  it('UT-PAY-PROV-008: provisional entry is flushed to storage before payInvoice returns', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Snapshot storage.set call count before payInvoice — load() may have
    // written some bookkeeping entries during initialization.
    const setCallsBefore = mocks.storage.set.mock.calls.length;

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
    });

    // Storage MUST have been written to during the payInvoice call — specifically,
    // the inv_ledger:{invoiceId} entry containing the provisional forward ref.
    const setCallsDuring = mocks.storage.set.mock.calls.slice(setCallsBefore);
    const ledgerWrites = setCallsDuring.filter(([key]) =>
      typeof key === 'string' && key.includes(`inv_ledger:${INVOICE_ID}`),
    );
    expect(ledgerWrites.length).toBeGreaterThanOrEqual(1);

    // The persisted entry must contain the provisional reference. Read the
    // most recent ledger write and confirm the provisional entry is present.
    const lastLedgerWrite = ledgerWrites[ledgerWrites.length - 1]!;
    const persistedJson = lastLedgerWrite[1] as string;
    const persistedEntries = JSON.parse(persistedJson) as Record<string, InvoiceTransferRef>;
    const provisionalKey = `provisional:${result.id}::UCT`;
    expect(persistedEntries[provisionalKey]).toBeDefined();
    expect(persistedEntries[provisionalKey]!.amount).toBe('1000');
    expect(persistedEntries[provisionalKey]!.paymentDirection).toBe('forward');

    // After payInvoice returns, _drainFlushPromise must be a no-op — the chain
    // is already empty because the flush completed inline before return.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = module as any;
    expect(mod._flushPromise).toBeNull();
    // dirtyLedgerEntries should be empty (cleared by the flush)
    expect(mod.dirtyLedgerEntries.size).toBe(0);
  });

  // UT-PAY-PROV-009
  // Durability error-propagation test: if the inline flush's `storage.set`
  // rejects (disk full, EIO, locked DB), `payInvoice` MUST reject — not return
  // success while `dirtyLedgerEntries` stays populated. Earlier review feedback
  // flagged a bug where the flush's `.catch(...log...)` silently swallowed the
  // storage rejection: `payInvoice` returned success, but the on-disk durability
  // claim was a lie. The exact crash window the durability fix aims to close
  // would have been reopened the moment a storage error coincided with an OS
  // crash. This test pins the corrected behavior.
  it('UT-PAY-PROV-009: payInvoice REJECTS when inline flush storage write fails', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Reject the FIRST `inv_ledger:` storage write that occurs during payInvoice.
    // We must let earlier load()-time writes (and any pre-payInvoice setup writes)
    // pass through — only fail the per-invoice ledger persistence.
    const realSet = mocks.storage.set.getMockImplementation();
    let rejected = false;
    mocks.storage.set.mockImplementation((key: string, value: string): Promise<void> => {
      if (!rejected && key.includes(`inv_ledger:${INVOICE_ID}`)) {
        rejected = true;
        return Promise.reject(new Error('mock storage failure: disk full'));
      }
      // Delegate to the real backing-map implementation for everything else
      return realSet ? realSet(key, value) : Promise.resolve();
    });

    // payInvoice MUST reject — not silently return success. The rejection may
    // surface either as the original storage error OR as the SDK's
    // STORAGE_ERROR post-flush detection, depending on whether
    // `_flushDirtyLedgerEntries` propagated or swallowed the rejection.
    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 0, assetIndex: 0 }),
    ).rejects.toThrow(/disk full|storage failure|STORAGE_ERROR|failed to persist/i);

    // After rejection, the in-memory provisional is still marked dirty so a
    // subsequent payInvoice or process restart can retry the flush. No silent loss.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = module as any;
    expect(mod.dirtyLedgerEntries.has(INVOICE_ID)).toBe(true);
  });
});
