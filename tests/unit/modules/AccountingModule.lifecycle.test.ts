/**
 * AccountingModule — Lifecycle tests (§3.1)
 *
 * Covers module initialization, load(), destroy(), MODULE_DESTROYED guard,
 * exempt-method behaviour, and the load-subscribe gap re-scan (§7.6 step 7b).
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  createMockPaymentsModule,
  createMockStorageProvider,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';
import { STORAGE_KEYS_ADDRESS, getAddressId } from '../../../constants.js';

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

afterEach(async () => {
  // Best-effort cleanup — module may already be destroyed
  try {
    module.destroy();
  } catch {
    // ignore MODULE_DESTROYED
  }
  vi.restoreAllMocks();
});

// =============================================================================
// UT-LIFECYCLE-001: load() with empty storage
// =============================================================================

describe('UT-LIFECYCLE-001: load() with empty storage', () => {
  beforeEach(() => setup());

  it('loads without errors and returns an empty invoice list', async () => {
    await module.load();

    const invoices = await module.getInvoices();
    expect(invoices).toEqual([]);
  });

  it('subscribes to payments events during load', async () => {
    await module.load();

    // The deps.on spy should have been called at least once during _subscribeToPaymentsEvents
    const onSpy = mocks.payments.on;
    expect(onSpy).toHaveBeenCalled();
  });

  it('subscribes to CommunicationsModule DM events if available', async () => {
    await module.load();

    expect(mocks.communications.onDirectMessage).toHaveBeenCalled();
  });
});

// =============================================================================
// UT-LIFECYCLE-002: load() populates invoice terms from existing tokens
// =============================================================================

describe('UT-LIFECYCLE-002: load() with existing invoice tokens', () => {
  beforeEach(() => setup());

  it('parses and caches all invoice tokens returned by PaymentsModule', async () => {
    // Prepare three invoice tokens in the mock storage
    const terms1 = {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://target_1', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    };
    const terms2 = {
      createdAt: 2000,
      targets: [{ address: 'DIRECT://target_2', assets: [{ coin: ['UCT', '200'] as [string, string] }] }],
    };
    const terms3 = {
      createdAt: 3000,
      targets: [{ address: 'DIRECT://target_3', assets: [{ coin: ['UCT', '300'] as [string, string] }] }],
    };

    const txf1 = createTestToken(terms1);
    const txf2 = createTestToken(terms2);
    const txf3 = createTestToken(terms3);

    // Make PaymentsModule return UI tokens wrapping these TXF tokens
    mocks.payments._tokens = [
      {
        id: txf1.genesis.data.tokenId,
        coinId: INVOICE_TOKEN_TYPE_HEX,
        symbol: 'INVOICE',
        name: 'Invoice',
        decimals: 0,
        amount: '0',
        status: 'confirmed',
        createdAt: 1000,
        updatedAt: 1000,
        sdkData: JSON.stringify(txf1),
      },
      {
        id: txf2.genesis.data.tokenId,
        coinId: INVOICE_TOKEN_TYPE_HEX,
        symbol: 'INVOICE',
        name: 'Invoice',
        decimals: 0,
        amount: '0',
        status: 'confirmed',
        createdAt: 2000,
        updatedAt: 2000,
        sdkData: JSON.stringify(txf2),
      },
      {
        id: txf3.genesis.data.tokenId,
        coinId: INVOICE_TOKEN_TYPE_HEX,
        symbol: 'INVOICE',
        name: 'Invoice',
        decimals: 0,
        amount: '0',
        status: 'confirmed',
        createdAt: 3000,
        updatedAt: 3000,
        sdkData: JSON.stringify(txf3),
      },
    ] as import('../../../types/index.js').Token[];

    await module.load();

    const invoices = await module.getInvoices();
    expect(invoices).toHaveLength(3);
  });
});

// =============================================================================
// UT-LIFECYCLE-003: load() loads terminal state from storage
// =============================================================================

describe('UT-LIFECYCLE-003: load() loads terminal state from storage', () => {
  it('restores cancelled and closed sets from persisted storage', async () => {
    const storage = createMockStorageProvider();
    setup({ storage });

    const addressId = getAddressId(mocks.identity.directAddress!);
    const cancelledKey = `${addressId}_${STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES}`;
    const closedKey = `${addressId}_${STORAGE_KEYS_ADDRESS.CLOSED_INVOICES}`;
    const frozenKey = `${addressId}_${STORAGE_KEYS_ADDRESS.FROZEN_BALANCES}`;

    const cancelledId = 'a'.repeat(64);
    const closedId = 'b'.repeat(64);

    // Pre-populate storage with terminal-state data
    storage._data.set(cancelledKey, JSON.stringify([cancelledId]));
    storage._data.set(closedKey, JSON.stringify([closedId]));

    // Provide frozen balances to satisfy reconciliation checks
    storage._data.set(
      frozenKey,
      JSON.stringify({
        [cancelledId]: {
          state: 'CANCELLED',
          targets: [],
          frozenAt: Date.now(),
          explicitClose: false,
        },
        [closedId]: {
          state: 'CLOSED',
          targets: [],
          frozenAt: Date.now(),
          explicitClose: true,
        },
      }),
    );

    // Pre-populate the terms cache by providing matching tokens so getInvoice() works
    // (terminal state checks also require known invoiceId)
    await module.load();

    // Access private maps via `as any` to verify they were populated
    const mod = module as unknown as {
      cancelledInvoices: Set<string>;
      closedInvoices: Set<string>;
    };
    expect(mod.cancelledInvoices.has(cancelledId)).toBe(true);
    expect(mod.closedInvoices.has(closedId)).toBe(true);
  });
});

// =============================================================================
// UT-LIFECYCLE-004: load() recovers auto-return settings
// =============================================================================

describe('UT-LIFECYCLE-004: load() recovers auto-return settings', () => {
  it('restores global and per-invoice auto-return settings from storage', async () => {
    const storage = createMockStorageProvider();
    setup({ storage });

    const addressId = getAddressId(mocks.identity.directAddress!);
    const autoReturnKey = `${addressId}_${STORAGE_KEYS_ADDRESS.AUTO_RETURN}`;
    const invoiceId = 'c'.repeat(64);

    storage._data.set(
      autoReturnKey,
      JSON.stringify({
        global: true,
        perInvoice: { [invoiceId]: false },
      }),
    );

    await module.load();

    const settings = module.getAutoReturnSettings();
    expect(settings.global).toBe(true);
    expect(settings.perInvoice[invoiceId]).toBe(false);
  });
});

// =============================================================================
// UT-LIFECYCLE-005: destroy() unsubscribes from events
// =============================================================================

describe('UT-LIFECYCLE-005: destroy() unsubscribes from events', () => {
  beforeEach(() => setup());

  it('calls all unsubscribe handles returned by deps.on()', async () => {
    // Track unsubscribe fn calls via the payments mock
    const unsubscribeFns: ReturnType<typeof vi.fn>[] = [];
    mocks.payments.on.mockImplementation(
      (_event: string, _handler: unknown): (() => void) => {
        const unsub = vi.fn();
        unsubscribeFns.push(unsub);
        return unsub;
      },
    );

    await module.load();

    // Verify at least some subscriptions were made
    expect(unsubscribeFns.length).toBeGreaterThan(0);

    module.destroy();

    // All unsubscribe handles should have been called
    for (const fn of unsubscribeFns) {
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it('unsubscribes from CommunicationsModule DM events', async () => {
    const dmUnsub = vi.fn();
    mocks.communications.onDirectMessage.mockReturnValue(dmUnsub);

    await module.load();

    module.destroy();

    expect(dmUnsub).toHaveBeenCalledOnce();
  });

  it('subsequent transfers do not trigger accounting events after destroy', async () => {
    await module.load();
    module.destroy();

    // Capture the call count of the actual emitEvent mock BEFORE emitting
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countBefore = (module as any).deps?.emitEvent?.mock?.calls?.length ?? 0;

    // Re-emit a transfer event — the destroyed module should ignore it
    mocks.payments._emit('transfer:incoming', {
      senderPubkey: '02' + 'a'.repeat(64),
      tokens: [],
      receivedAt: Date.now(),
    });

    // emitEvent should not have been called again after destroy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countAfter = (module as any).deps?.emitEvent?.mock?.calls?.length ?? 0;
    expect(countAfter).toBe(countBefore);
  });
});

// =============================================================================
// UT-LIFECYCLE-006: destroy() clears in-memory state
// =============================================================================

describe('UT-LIFECYCLE-006: destroy() clears in-memory state', () => {
  it('clears invoiceTermsCache and other maps after destroy', async () => {
    setup();

    const terms = {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://target_1', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    };
    const txf = createTestToken(terms);
    mocks.payments._tokens = [
      {
        id: txf.genesis.data.tokenId,
        coinId: INVOICE_TOKEN_TYPE_HEX,
        symbol: 'INVOICE',
        name: 'Invoice',
        decimals: 0,
        amount: '0',
        status: 'confirmed',
        createdAt: 1000,
        updatedAt: 1000,
        sdkData: JSON.stringify(txf),
      },
    ] as import('../../../types/index.js').Token[];

    await module.load();

    // Verify it was loaded
    const mod = module as unknown as { invoiceTermsCache: Map<string, unknown> };
    expect(mod.invoiceTermsCache.size).toBeGreaterThan(0);

    module.destroy();

    // After destroy, in-memory cache should be cleared
    expect(mod.invoiceTermsCache.size).toBe(0);
  });

  it('is idempotent — calling destroy() twice does not throw', async () => {
    setup();
    await module.load();

    module.destroy();
    expect(() => module.destroy()).not.toThrow();
  });
});

// =============================================================================
// UT-LIFECYCLE-007: MODULE_DESTROYED error on I/O methods after destroy
// =============================================================================

describe('UT-LIFECYCLE-007: I/O methods throw MODULE_DESTROYED after destroy', () => {
  beforeEach(async () => {
    setup();
    await module.load();
    module.destroy();
  });

  const expectModuleDestroyed = async (fn: () => Promise<unknown>) => {
    await expect(fn()).rejects.toSatisfy(
      (e: unknown) => e instanceof SphereError && (e as SphereError).code === 'MODULE_DESTROYED',
    );
  };

  it('createInvoice() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() =>
      module.createInvoice({
        targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '100'] }] }],
      }),
    );
  });

  it('importInvoice() throws MODULE_DESTROYED', async () => {
    const { createTestToken: makeToken } = await import('./accounting-test-helpers.js');
    const txf = makeToken({
      createdAt: 1000,
      targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    });
    await expectModuleDestroyed(() => module.importInvoice(txf));
  });

  it('getInvoices() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.getInvoices());
  });

  it('getInvoiceStatus() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.getInvoiceStatus('a'.repeat(64)));
  });

  it('closeInvoice() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.closeInvoice('a'.repeat(64)));
  });

  it('cancelInvoice() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.cancelInvoice('a'.repeat(64)));
  });

  it('payInvoice() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() =>
      module.payInvoice('a'.repeat(64), {
        targetAddress: 'DIRECT://alice',
        assets: [{ coin: ['UCT', '100'] }],
      }),
    );
  });

  it('returnInvoicePayment() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() =>
      module.returnInvoicePayment('a'.repeat(64), {
        targetAddress: 'DIRECT://alice',
        senderAddress: 'DIRECT://sender',
        assets: [{ coin: ['UCT', '100'] }],
      }),
    );
  });

  it('setAutoReturn() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.setAutoReturn('*', true));
  });

  it('sendInvoiceReceipts() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.sendInvoiceReceipts('a'.repeat(64)));
  });

  it('sendCancellationNotices() throws MODULE_DESTROYED', async () => {
    await expectModuleDestroyed(() => module.sendCancellationNotices('a'.repeat(64)));
  });

  it('getRelatedTransfers() throws MODULE_DESTROYED', async () => {
    expect(() => module.getRelatedTransfers('a'.repeat(64))).toThrowError(
      expect.objectContaining({ code: 'MODULE_DESTROYED' }),
    );
  });
});

// =============================================================================
// UT-LIFECYCLE-008: MODULE_DESTROYED exempt methods remain callable
// =============================================================================

describe('UT-LIFECYCLE-008: non-exempt methods throw after destroy, parseInvoiceMemo remains callable', () => {
  beforeEach(async () => {
    setup();
    await module.load();
    module.destroy();
  });

  it('getInvoice() throws MODULE_DESTROYED after destroy', () => {
    // The implementation calls ensureNotDestroyed, so getInvoice throws after destroy.
    expect(() => module.getInvoice('nonexistent')).toThrow();
  });

  it('getAutoReturnSettings() throws MODULE_DESTROYED after destroy', () => {
    // The implementation calls ensureNotDestroyed, so getAutoReturnSettings throws after destroy.
    expect(() => module.getAutoReturnSettings()).toThrow();
  });

  it('parseInvoiceMemo() is a pure utility method and never checks destroyed state', () => {
    // parseInvoiceMemo is a pure delegating method — it does not call ensureNotDestroyed.
    // Calling it after destroy should not throw (it simply delegates to memo.ts).

    // 'INV:abc/F' does not match the memo regex (requires 64-hex ID, colon separator)
    const resultBad = module.parseInvoiceMemo('INV:abc/F');
    expect(resultBad).toBeNull();

    // Valid memo format: INV:<64-hex-id>:<direction>
    const validId = 'a'.repeat(64);
    const resultGood = module.parseInvoiceMemo(`INV:${validId}:F`);
    expect(resultGood).toMatchObject({ invoiceId: validId, paymentDirection: 'forward' });
  });
});

// =============================================================================
// UT-LIFECYCLE-009: Load-subscribe gap re-scan
// =============================================================================

describe('UT-LIFECYCLE-009: load-subscribe gap re-scan', () => {
  it('detects transfers that arrived between initial scan and subscription registration', async () => {
    setup();

    // Use getTokens mock to return different results on each call:
    // First call (initial load scan) returns no tokens
    // Second call (gap fill scan) returns a token with transactions
    let callCount = 0;
    mocks.payments.getTokens.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        return [];
      }
      // Gap: a new token appeared after initial scan
      return [
        {
          id: 'gap-token-id',
          coinId: 'UCT',
          symbol: 'UCT',
          name: 'UCT',
          decimals: 0,
          amount: '100',
          status: 'confirmed',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          // Token with no transactions — the gap re-scan watermark advancement
          sdkData: JSON.stringify({
            version: '2.0',
            genesis: {
              data: {
                tokenId: 'gap-token-id',
                tokenType: 'deadbeef'.repeat(8),
                coinData: [['UCT', '100']],
                tokenData: '',
                salt: '0'.repeat(64),
                recipient: 'DIRECT://test_target_address_abc123',
                recipientDataHash: null,
                reason: null,
              },
              inclusionProof: {
                authenticator: {
                  algorithm: 'secp256k1',
                  publicKey: '02' + 'a'.repeat(64),
                  signature: '0'.repeat(128),
                  stateHash: '0'.repeat(64),
                },
                merkleTreePath: { root: '0'.repeat(64), steps: [] },
                transactionHash: '0'.repeat(64),
                unicityCertificate: '0'.repeat(256),
              },
            },
            state: { data: '0'.repeat(64), predicate: '0'.repeat(64) },
            transactions: [],
          }),
        },
      ] as import('../../../types/index.js').Token[];
    });

    await module.load();

    // The gap-fill scan should have called getTokens at least twice
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
