/**
 * Unit tests for AccountingModule.payInvoice() and returnInvoicePayment().
 *
 * UT-PAY-001 – UT-PAY-014  (14 tests)
 * UT-RETURN-001 – UT-RETURN-007 (7 tests)
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.9, §3.10
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  createTestTransfer,
  DEFAULT_TEST_IDENTITY,
  DEFAULT_TEST_TRACKED_ADDRESS,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import { getAddressId } from '../../../constants.js';
import type { InvoiceTerms, InvoiceTransferRef } from '../../../modules/accounting/types.js';
import type { Token } from '../../../types/index.js';

// =============================================================================
// Helpers
// =============================================================================

/** Minimal 64-char lowercase hex string used as an invoice ID in tests. */
const INVOICE_ID = 'a'.repeat(64);

/** A second sender address distinct from the default identity/target address. */
const SENDER_ADDRESS = 'DIRECT://sender_address_def456';

/** Target address that matches DEFAULT_TEST_TRACKED_ADDRESS.directAddress */
const TARGET_ADDRESS = 'DIRECT://test_target_address_abc123';

/**
 * The AccountingModule derives its storage key prefix via getAddressId():
 *   getAddressStorageKey(getAddressId(identity.directAddress), subKey)
 *     = `DIRECT_test_t_abc123_${subKey}`
 *
 * DEFAULT_TEST_IDENTITY.directAddress = 'DIRECT://test_target_address_abc123'
 */
const STORAGE_PREFIX = getAddressId(DEFAULT_TEST_IDENTITY.directAddress!);

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

/** Minimal terms for a single-target, single-asset invoice (10 UCT). */
function makeTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    creator: DEFAULT_TEST_IDENTITY.chainPubkey,
    createdAt: Date.now() - 1000, // 1 second ago
    targets: [
      {
        address: TARGET_ADDRESS,
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    ...overrides,
  };
}

// =============================================================================
// payInvoice() — 14 tests
// =============================================================================

describe('AccountingModule.payInvoice()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // UT-PAY-001
  it('UT-PAY-001: sends transfer with forward direction for valid payment', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    const result = await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 0,
      amount: '10000000',
    });

    expect(result).toBeDefined();
    expect(mocks.payments.send).toHaveBeenCalledOnce();
    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendCall.recipient).toBe(TARGET_ADDRESS);
    expect(sendCall.amount).toBe('10000000');
    expect(sendCall.coinId).toBe('UCT');
    // Memo must contain forward reference: INV:<id>:F
    expect(typeof sendCall.memo).toBe('string');
    expect((sendCall.memo as string).startsWith(`INV:${INVOICE_ID}:F`)).toBe(true);
  });

  // UT-PAY-002
  it('UT-PAY-002: default amount equals remaining when omitted', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // No amount → should default to 10000000 (full requested amount, 0 already paid)
    await module.payInvoice(INVOICE_ID, { targetIndex: 0 });

    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    // Remaining = requested (10000000) - netCovered (0) = 10000000
    expect(sendCall.amount).toBe('10000000');
  });

  // UT-PAY-003
  it('UT-PAY-003: throws INVOICE_TERMINATED for closed invoice', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];

    // Pre-populate storage so load() finds it in the closed set
    await mocks.storage.set(
      `${STORAGE_PREFIX}_closed_invoices`,
      JSON.stringify([INVOICE_ID]),
    );
    // Also provide frozen balances to pass forward-reconciliation
    await mocks.storage.set(
      `${STORAGE_PREFIX}_frozen_balances`,
      JSON.stringify({
        [INVOICE_ID]: {
          state: 'CLOSED',
          explicitClose: true,
          targets: [],
        },
      }),
    );
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 0, assetIndex: 0, amount: '1000' }),
    ).rejects.toThrow(SphereError);

    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 0, assetIndex: 0, amount: '1000' }),
    ).rejects.toMatchObject({ code: 'INVOICE_TERMINATED' });
  });

  // UT-PAY-004
  it('UT-PAY-004: throws INVOICE_TERMINATED for cancelled invoice', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];

    await mocks.storage.set(
      `${STORAGE_PREFIX}_cancelled_invoices`,
      JSON.stringify([INVOICE_ID]),
    );
    await mocks.storage.set(
      `${STORAGE_PREFIX}_frozen_balances`,
      JSON.stringify({
        [INVOICE_ID]: {
          state: 'CANCELLED',
          explicitClose: false,
          targets: [],
        },
      }),
    );
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 0, assetIndex: 0, amount: '1000' }),
    ).rejects.toMatchObject({ code: 'INVOICE_TERMINATED' });
  });

  // UT-PAY-005
  it('UT-PAY-005: throws INVOICE_INVALID_TARGET for out-of-range targetIndex', async () => {
    const terms = makeTerms(); // 1 target → indices [0] only
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 5, assetIndex: 0, amount: '1000' }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_TARGET' });
  });

  // UT-PAY-006
  it('UT-PAY-006: throws INVOICE_INVALID_ASSET_INDEX for out-of-range assetIndex', async () => {
    const terms = makeTerms(); // 1 asset → indices [0] only
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, { targetIndex: 0, assetIndex: 5, amount: '1000' }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_ASSET_INDEX' });
  });

  // UT-PAY-007
  it('UT-PAY-007: throws INVOICE_INVALID_REFUND_ADDRESS for invalid refund address', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, {
        targetIndex: 0,
        assetIndex: 0,
        amount: '1000',
        refundAddress: 'invalid-not-direct',
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_REFUND_ADDRESS' });
  });

  // UT-PAY-008
  it('UT-PAY-008: throws INVOICE_NOT_FOUND for unknown invoiceId', async () => {
    const { module } = createTestAccountingModule();
    await module.load();

    await expect(
      module.payInvoice('nonexistent' + 'a'.repeat(53), { targetIndex: 0, amount: '1000' }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  // UT-PAY-009
  it('UT-PAY-009: memo starts with INV:<invoiceId>:F', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await module.payInvoice(INVOICE_ID, { targetIndex: 0, amount: '5000000' });

    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    const memo = sendCall.memo as string;
    expect(memo).toMatch(/^INV:[0-9a-f]{64}:F/);
    expect(memo).toContain(INVOICE_ID);
  });

  // UT-PAY-010
  it('UT-PAY-010: contact auto-populated from identity.directAddress', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // No contact param provided → should auto-populate from identity
    await module.payInvoice(INVOICE_ID, { targetIndex: 0, amount: '5000000' });

    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    const contact = sendCall.invoiceContact as { address: string } | undefined;
    expect(contact).toBeDefined();
    // Auto-populated from DEFAULT_TEST_IDENTITY.directAddress
    expect(contact!.address).toBe(DEFAULT_TEST_IDENTITY.directAddress);
  });

  // UT-PAY-011
  it('UT-PAY-011: throws INVOICE_INVALID_CONTACT for missing DIRECT:// in contact address', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, {
        targetIndex: 0,
        amount: '1000',
        contact: { address: 'not-a-direct-address' },
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_CONTACT' });
  });

  // UT-PAY-012
  it('UT-PAY-012: throws INVOICE_INVALID_CONTACT for contact URL not https:// or wss://', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await expect(
      module.payInvoice(INVOICE_ID, {
        targetIndex: 0,
        amount: '1000',
        contact: {
          address: 'DIRECT://valid_contact_addr_xyz',
          url: 'http://unsafe.example.com',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_INVALID_CONTACT' });
  });

  // UT-PAY-013
  it('UT-PAY-013: freeText is included in the memo', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      amount: '1000000',
      freeText: 'Payment for consulting',
    });

    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    const memo = sendCall.memo as string;
    expect(memo).toContain('Payment for consulting');
  });

  // UT-PAY-014
  it('UT-PAY-014: multi-asset selection via assetIndex', async () => {
    const terms = makeTerms({
      targets: [
        {
          address: TARGET_ADDRESS,
          assets: [
            { coin: ['UCT', '10000000'] },
            { coin: ['USDU', '5000000'] },
          ],
        },
      ],
    });
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    // Pay asset at index 1 (USDU)
    await module.payInvoice(INVOICE_ID, {
      targetIndex: 0,
      assetIndex: 1,
      amount: '2000000',
    });

    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendCall.coinId).toBe('USDU');
  });
});

// =============================================================================
// returnInvoicePayment() — 7 tests
// =============================================================================

describe('AccountingModule.returnInvoicePayment()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Sets up a module with a single-target invoice and pre-populates the
   * invoice-transfer ledger with a forward payment so that the balance check
   * in returnInvoicePayment() can pass.
   *
   * Returns the module, mocks, and the injected sender entries for reference.
   */
  async function setupReturnScenario(forwardAmount: string = '10000000') {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];

    // Pre-seed the invoice-transfer ledger via storage so the module has a
    // forward payment entry from SENDER_ADDRESS → TARGET_ADDRESS when load() runs.
    //
    // AccountingModule._loadInvoiceTransferIndex() reads:
    //   key: getAddressStorageKey(getAddressId(identity.directAddress), 'inv_ledger:{invoiceId}')
    //      = `${STORAGE_PREFIX}_inv_ledger:${INVOICE_ID}`
    //   format: Record<string, InvoiceTransferRef>  (keyed by composite entryKey)
    const entryKey = `mock-transfer-001::UCT`;
    const entry: InvoiceTransferRef = {
      transferId: 'mock-transfer-001',
      direction: 'inbound',
      paymentDirection: 'forward',
      coinId: 'UCT',
      amount: forwardAmount,
      destinationAddress: TARGET_ADDRESS,
      timestamp: Date.now() - 5000,
      confirmed: true,
      senderAddress: SENDER_ADDRESS,
    };
    // Write ledger entries as Record<entryKey, ref>
    await mocks.storage.set(
      `${STORAGE_PREFIX}_inv_ledger:${INVOICE_ID}`,
      JSON.stringify({ [entryKey]: entry }),
    );
    // Write inv_ledger_index so the outer map is populated
    await mocks.storage.set(
      `${STORAGE_PREFIX}_inv_ledger_index`,
      JSON.stringify({ [INVOICE_ID]: { terminated: false } }),
    );

    await module.load();

    return { module, mocks, entry };
  }

  // UT-RETURN-001
  it('UT-RETURN-001: returns tokens with :B direction in memo', async () => {
    const { module, mocks } = await setupReturnScenario('10000000');

    const result = await module.returnInvoicePayment(INVOICE_ID, {
      recipient: SENDER_ADDRESS,
      amount: '5000000',
      coinId: 'UCT',
    });

    expect(result).toBeDefined();
    expect(mocks.payments.send).toHaveBeenCalledOnce();
    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendCall.recipient).toBe(SENDER_ADDRESS);
    expect(sendCall.amount).toBe('5000000');
    expect(sendCall.coinId).toBe('UCT');
  });

  // UT-RETURN-002
  it('UT-RETURN-002: memo uses :B direction code', async () => {
    const { module, mocks } = await setupReturnScenario('10000000');

    await module.returnInvoicePayment(INVOICE_ID, {
      recipient: SENDER_ADDRESS,
      amount: '3000000',
      coinId: 'UCT',
    });

    const sendCall = mocks.payments.send.mock.calls[0]![0] as Record<string, unknown>;
    const memo = sendCall.memo as string;
    expect(memo).toMatch(/^INV:[0-9a-f]{64}:B/);
    expect(memo).toContain(INVOICE_ID);
  });

  // UT-RETURN-003
  it('UT-RETURN-003: throws INVOICE_RETURN_EXCEEDS_BALANCE when amount > net balance', async () => {
    const { module } = await setupReturnScenario('5000000'); // only 5 UCT net balance

    await expect(
      module.returnInvoicePayment(INVOICE_ID, {
        recipient: SENDER_ADDRESS,
        amount: '10000000', // exceeds 5 UCT
        coinId: 'UCT',
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_RETURN_EXCEEDS_BALANCE' });
  });

  // UT-RETURN-004
  it('UT-RETURN-004: throws INVOICE_NOT_TARGET when caller is not an invoice target', async () => {
    const terms = makeTerms({
      targets: [
        {
          address: 'DIRECT://some_other_target_xyz_789', // different from wallet address
          assets: [{ coin: ['UCT', '10000000'] }],
        },
      ],
    });

    // Use a different tracked address that is NOT the target
    const { module, mocks } = createTestAccountingModule({
      trackedAddresses: [DEFAULT_TEST_TRACKED_ADDRESS], // wallet address != target above
    });
    mocks.payments._tokens = [makeInvoiceToken(terms)];
    await module.load();

    await expect(
      module.returnInvoicePayment(INVOICE_ID, {
        recipient: SENDER_ADDRESS,
        amount: '1000',
        coinId: 'UCT',
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_TARGET' });
  });

  // UT-RETURN-005
  it('UT-RETURN-005: throws INVOICE_NOT_FOUND for unknown invoiceId', async () => {
    const { module } = createTestAccountingModule();
    await module.load();

    await expect(
      module.returnInvoicePayment('unknown' + 'b'.repeat(57), {
        recipient: SENDER_ADDRESS,
        amount: '1000',
        coinId: 'UCT',
      }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  // UT-RETURN-006
  it('UT-RETURN-006: returns from terminal (CLOSED) invoice are allowed', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];

    // Add forward transfer entry to ledger
    const closedEntryKey = `mock-transfer-closed::UCT`;
    const closedEntry: InvoiceTransferRef = {
      transferId: 'mock-transfer-closed',
      direction: 'inbound',
      paymentDirection: 'forward',
      coinId: 'UCT',
      amount: '5000000',
      destinationAddress: TARGET_ADDRESS,
      timestamp: Date.now() - 10000,
      confirmed: true,
      senderAddress: SENDER_ADDRESS,
    };
    await mocks.storage.set(
      `${STORAGE_PREFIX}_inv_ledger:${INVOICE_ID}`,
      JSON.stringify({ [closedEntryKey]: closedEntry }),
    );
    await mocks.storage.set(
      `${STORAGE_PREFIX}_inv_ledger_index`,
      JSON.stringify({ [INVOICE_ID]: { terminated: true } }),
    );

    // Mark as CLOSED with frozen balances that include this sender
    await mocks.storage.set(
      `${STORAGE_PREFIX}_closed_invoices`,
      JSON.stringify([INVOICE_ID]),
    );
    await mocks.storage.set(
      `${STORAGE_PREFIX}_frozen_balances`,
      JSON.stringify({
        [INVOICE_ID]: {
          state: 'CLOSED',
          explicitClose: true,
          targets: [
            {
              address: TARGET_ADDRESS,
              coinAssets: [
                {
                  coin: ['UCT', '5000000'],
                  netCoveredAmount: '5000000',
                  transfers: [closedEntry],
                  senderBalances: [],
                  frozenSenderBalances: [
                    {
                      senderAddress: SENDER_ADDRESS,
                      netBalance: '5000000',
                      forwardTotal: '5000000',
                      returnedTotal: '0',
                      transfers: [closedEntry],
                    },
                  ],
                },
              ],
              nftAssets: [],
            },
          ],
        },
      }),
    );

    await module.load();

    // Return should be allowed from CLOSED invoice
    const result = await module.returnInvoicePayment(INVOICE_ID, {
      recipient: SENDER_ADDRESS,
      amount: '3000000',
      coinId: 'UCT',
    });
    expect(result).toBeDefined();
    expect(mocks.payments.send).toHaveBeenCalledOnce();
  });

  // UT-RETURN-007
  it('UT-RETURN-007: returns from terminal (CANCELLED) invoice are allowed', async () => {
    const terms = makeTerms();
    const { module, mocks } = createTestAccountingModule();
    mocks.payments._tokens = [makeInvoiceToken(terms)];

    const cancelledEntryKey = `mock-transfer-cancelled::UCT`;
    const cancelledEntry: InvoiceTransferRef = {
      transferId: 'mock-transfer-cancelled',
      direction: 'inbound',
      paymentDirection: 'forward',
      coinId: 'UCT',
      amount: '6000000',
      destinationAddress: TARGET_ADDRESS,
      timestamp: Date.now() - 10000,
      confirmed: true,
      senderAddress: SENDER_ADDRESS,
    };
    await mocks.storage.set(
      `${STORAGE_PREFIX}_inv_ledger:${INVOICE_ID}`,
      JSON.stringify({ [cancelledEntryKey]: cancelledEntry }),
    );
    await mocks.storage.set(
      `${STORAGE_PREFIX}_inv_ledger_index`,
      JSON.stringify({ [INVOICE_ID]: { terminated: true } }),
    );

    await mocks.storage.set(
      `${STORAGE_PREFIX}_cancelled_invoices`,
      JSON.stringify([INVOICE_ID]),
    );
    await mocks.storage.set(
      `${STORAGE_PREFIX}_frozen_balances`,
      JSON.stringify({
        [INVOICE_ID]: {
          state: 'CANCELLED',
          explicitClose: false,
          targets: [
            {
              address: TARGET_ADDRESS,
              coinAssets: [
                {
                  coin: ['UCT', '6000000'],
                  netCoveredAmount: '6000000',
                  transfers: [cancelledEntry],
                  senderBalances: [],
                  frozenSenderBalances: [
                    {
                      senderAddress: SENDER_ADDRESS,
                      netBalance: '6000000',
                      forwardTotal: '6000000',
                      returnedTotal: '0',
                      transfers: [cancelledEntry],
                    },
                  ],
                },
              ],
              nftAssets: [],
            },
          ],
        },
      }),
    );

    await module.load();

    // Return should be allowed from CANCELLED invoice
    const result = await module.returnInvoicePayment(INVOICE_ID, {
      recipient: SENDER_ADDRESS,
      amount: '6000000',
      coinId: 'UCT',
    });
    expect(result).toBeDefined();
  });

  // =========================================================================
  // Provisional entry lifecycle — UT-PAY-RET-PROV-001 through UT-PAY-RET-PROV-003
  // =========================================================================

  // UT-PAY-RET-PROV-001
  it('UT-PAY-RET-PROV-001: provisional entry created after returnInvoicePayment', async () => {
    const { module, mocks } = await setupReturnScenario('10000000');

    await module.returnInvoicePayment(INVOICE_ID, {
      recipient: SENDER_ADDRESS,
      amount: '5000000',
      coinId: 'UCT',
    });

    // Inspect the in-memory ledger for a provisional entry
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = (module as any).invoiceLedger.get(INVOICE_ID) as Map<string, InvoiceTransferRef>;
    expect(ledger).toBeDefined();

    const provisionalEntries = Array.from(ledger.entries()).filter(
      ([key]) => key.startsWith('provisional:'),
    );
    expect(provisionalEntries.length).toBeGreaterThanOrEqual(1);

    const [, ref] = provisionalEntries[0]!;
    expect(ref.direction).toBe('outbound');
    expect(ref.paymentDirection).toBe('back');
    expect(ref.coinId).toBe('UCT');
    expect(ref.amount).toBe('5000000');
  });

  // UT-PAY-RET-PROV-002
  it('UT-PAY-RET-PROV-002: provisional entry superseded by on-chain entry', async () => {
    const { module, mocks } = await setupReturnScenario('10000000');

    await module.returnInvoicePayment(INVOICE_ID, {
      recipient: SENDER_ADDRESS,
      amount: '5000000',
      coinId: 'UCT',
    });

    // Verify provisional exists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = module as any;
    const ledgerBefore = mod.invoiceLedger.get(INVOICE_ID) as Map<string, InvoiceTransferRef>;
    const provisionalsBefore = Array.from(ledgerBefore.keys()).filter((k: string) => k.startsWith('provisional:'));
    expect(provisionalsBefore.length).toBeGreaterThanOrEqual(1);

    // Simulate on-chain scan: call _processTokenTransactions with a token
    // containing a matching return (back) transaction for the same invoice.
    const txf = createTestTransfer(INVOICE_ID, 'B', '5000000', 'UCT', TARGET_ADDRESS, SENDER_ADDRESS);

    mod._processTokenTransactions(txf.genesis.data.tokenId, txf, 0);

    // Provisional should be removed and replaced by the real entry
    const ledgerAfter = mod.invoiceLedger.get(INVOICE_ID) as Map<string, InvoiceTransferRef>;
    const provisionalsAfter = Array.from(ledgerAfter.keys()).filter((k: string) => k.startsWith('provisional:'));
    expect(provisionalsAfter.length).toBe(0);

    // Real positional entry should exist
    const realEntries = Array.from(ledgerAfter.keys()).filter(
      (k: string) => !k.startsWith('provisional:') && k !== provisionalsBefore[0],
    );
    expect(realEntries.length).toBeGreaterThanOrEqual(1);
  });

  // UT-PAY-RET-PROV-003
  it('UT-PAY-RET-PROV-003: stale provisional entries cleaned up on load', async () => {
    const terms = makeTerms();
    const { module: module1, mocks: mocks1 } = createTestAccountingModule();
    mocks1.payments._tokens = [makeInvoiceToken(terms)];

    // Pre-seed ledger with forward entry and a stale provisional
    const entryKey = `mock-transfer-001::UCT`;
    const forwardEntry: InvoiceTransferRef = {
      transferId: 'mock-transfer-001',
      direction: 'inbound',
      paymentDirection: 'forward',
      coinId: 'UCT',
      amount: '10000000',
      destinationAddress: TARGET_ADDRESS,
      timestamp: Date.now() - 5000,
      confirmed: true,
      senderAddress: SENDER_ADDRESS,
    };
    // Stale provisional: timestamp older than 10 minutes
    const staleProvisionalKey = `provisional:stale-uuid-123::UCT`;
    const staleProvisional: InvoiceTransferRef = {
      transferId: 'provisional:stale-uuid-123',
      direction: 'outbound',
      paymentDirection: 'back',
      coinId: 'UCT',
      amount: '3000000',
      destinationAddress: SENDER_ADDRESS,
      timestamp: Date.now() - 15 * 60 * 1000, // 15 minutes ago (stale)
      confirmed: false,
      senderAddress: TARGET_ADDRESS,
    };

    await mocks1.storage.set(
      `${STORAGE_PREFIX}_inv_ledger:${INVOICE_ID}`,
      JSON.stringify({ [entryKey]: forwardEntry, [staleProvisionalKey]: staleProvisional }),
    );
    await mocks1.storage.set(
      `${STORAGE_PREFIX}_inv_ledger_index`,
      JSON.stringify({ [INVOICE_ID]: { terminated: false } }),
    );

    await module1.load();

    // Verify the stale provisional was dropped during load
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = (module1 as any).invoiceLedger.get(INVOICE_ID) as Map<string, InvoiceTransferRef>;
    expect(ledger).toBeDefined();

    const provisionals = Array.from(ledger.keys()).filter((k: string) => k.startsWith('provisional:'));
    expect(provisionals.length).toBe(0);

    // The forward entry should still be present
    expect(ledger.has(entryKey)).toBe(true);
  });
});
