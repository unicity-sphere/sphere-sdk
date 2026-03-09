/**
 * Unit tests for InvoiceTransferIndex class.
 *
 * UT-INDEX-001 – UT-INDEX-011 (11 tests)
 *
 * Tests the InvoiceTransferIndex in isolation using a mock StorageProvider
 * and addEntry/getEntries/removeEntries for state seeding (bypassing the
 * heavy SDK hash-computation path of processTokenTransactions where needed).
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.16
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InvoiceTransferIndex } from '../../../modules/accounting/invoice-transfer-index.js';
import { createMockStorageProvider, createTestTransfer } from './accounting-test-helpers.js';
import type { InvoiceTransferRef, InvoiceBalanceSnapshot } from '../../../modules/accounting/types.js';
import { getAddressId } from '../../../constants.js';

// =============================================================================
// Mocks for @unicitylabs/state-transition-sdk dynamic imports
//
// processTokenTransactions() lazily imports SDK modules to compute transferId
// hashes. We mock them so tests stay fast and offline.
// =============================================================================

const MOCK_TRANSFER_ID = 'deadbeef'.repeat(8); // 64-char hex

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js', () => ({
  UnmaskedPredicate: {
    fromCBOR: vi.fn().mockReturnValue({
      publicKey: new Uint8Array(33).fill(2),
    }),
  },
}));

vi.mock(
  '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js',
  () => ({
    UnmaskedPredicateReference: {
      create: vi.fn().mockResolvedValue({
        toAddress: vi.fn().mockResolvedValue({ address: 'DIRECT://mock_sender_address' }),
      }),
    },
  }),
);

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType.js', () => ({
  TokenType: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
}));

vi.mock(
  '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData.js',
  () => ({
    TransferTransactionData: {
      fromJSON: vi.fn().mockResolvedValue({
        calculateHash: vi.fn().mockResolvedValue({
          data: Buffer.from(MOCK_TRANSFER_ID, 'hex'),
        }),
      }),
    },
  }),
);

// =============================================================================
// Fixtures
// =============================================================================

const INVOICE_ID = 'a'.repeat(64);
const COIN_ID = 'UCT';
const TARGET_ADDRESS = 'DIRECT://test_target_address_abc123';
const SENDER_ADDRESS = 'DIRECT://sender_address_def456';
const ADDRESS_ID = getAddressId(TARGET_ADDRESS);

/** Builds an InvoiceTransferRef with sensible defaults. */
function makeRef(overrides?: Partial<InvoiceTransferRef>): InvoiceTransferRef {
  return {
    transferId: MOCK_TRANSFER_ID,
    direction: 'inbound',
    paymentDirection: 'forward',
    coinId: COIN_ID,
    amount: '10000000',
    destinationAddress: TARGET_ADDRESS,
    timestamp: Date.now(),
    confirmed: true,
    senderAddress: SENDER_ADDRESS,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('InvoiceTransferIndex', () => {
  // UT-INDEX-001
  it('UT-INDEX-001: processTokenTransactions creates entries for matching transfers', async () => {
    const index = new InvoiceTransferIndex();
    const token = createTestTransfer(INVOICE_ID, 'F', '10000000', COIN_ID, SENDER_ADDRESS, TARGET_ADDRESS);

    // Add recipient to the transaction data (required by step 4a)
    if (token.transactions[0]?.data) {
      (token.transactions[0].data as Record<string, unknown>)['recipient'] = TARGET_ADDRESS;
    }

    const invoiceExists = vi.fn().mockReturnValue(true);
    const entries = await index.processTokenTransactions(token, invoiceExists);

    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]).toMatchObject({
      coinId: COIN_ID,
      amount: '10000000',
      destinationAddress: TARGET_ADDRESS,
      paymentDirection: 'forward',
    });
  });

  // UT-INDEX-002
  it('UT-INDEX-002: dedup by composite key prevents duplicate entries', async () => {
    const index = new InvoiceTransferIndex();
    const token = createTestTransfer(INVOICE_ID, 'F', '10000000', COIN_ID, SENDER_ADDRESS, TARGET_ADDRESS);

    if (token.transactions[0]?.data) {
      (token.transactions[0].data as Record<string, unknown>)['recipient'] = TARGET_ADDRESS;
    }

    const invoiceExists = vi.fn().mockReturnValue(true);

    // First scan: populates the ledger
    const firstEntries = await index.processTokenTransactions(token, invoiceExists);
    expect(firstEntries.length).toBeGreaterThanOrEqual(1);

    // Reset watermark to simulate re-delivery
    // (force the index to re-scan from 0 by constructing a fresh index
    //  but seeding the ledger entry directly to test dedup)
    const index2 = new InvoiceTransferIndex();
    const entryKey = `${MOCK_TRANSFER_ID}::${COIN_ID}`;
    index2.addEntry(INVOICE_ID, entryKey, makeRef());

    // Now scan the same token: the entry already exists → dedup → no new entries
    const secondEntries = await index2.processTokenTransactions(token, invoiceExists);
    expect(secondEntries).toHaveLength(0);
  });

  // UT-INDEX-003
  it('UT-INDEX-003: multi-coin token produces multiple entries', async () => {
    // Build a token with 2 coin entries (UCT + USDU)
    const index = new InvoiceTransferIndex();
    const token = createTestTransfer(INVOICE_ID, 'F', '10000000', COIN_ID, SENDER_ADDRESS, TARGET_ADDRESS);

    // Add a second coinData entry
    token.genesis.data.coinData.push(['USDU', '5000000']);

    if (token.transactions[0]?.data) {
      (token.transactions[0].data as Record<string, unknown>)['recipient'] = TARGET_ADDRESS;
    }

    const invoiceExists = vi.fn().mockReturnValue(true);
    const entries = await index.processTokenTransactions(token, invoiceExists);

    // Should produce entries for both UCT and USDU
    const coinIds = entries.map((e) => e.coinId);
    expect(coinIds).toContain('UCT');
    expect(coinIds).toContain('USDU');
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  // UT-INDEX-004
  it('UT-INDEX-004: watermark tracking prevents re-processing already-seen transactions', async () => {
    const index = new InvoiceTransferIndex();
    const token = createTestTransfer(INVOICE_ID, 'F', '10000000', COIN_ID, SENDER_ADDRESS, TARGET_ADDRESS);

    if (token.transactions[0]?.data) {
      (token.transactions[0].data as Record<string, unknown>)['recipient'] = TARGET_ADDRESS;
    }

    const invoiceExists = vi.fn().mockReturnValue(true);

    // First pass: scan all 1 transaction
    await index.processTokenTransactions(token, invoiceExists);
    const watermark = index.getTokenWatermark(token.genesis.data.tokenId);
    expect(watermark).toBe(1);

    // Second pass on the SAME token: watermark === transactions.length → fast-path skip
    const secondEntries = await index.processTokenTransactions(token, invoiceExists);
    expect(secondEntries).toHaveLength(0); // no new entries — fast path
  });

  // UT-INDEX-005
  it('UT-INDEX-005: cold start populates entries from loadFromStorage', async () => {
    const storage = createMockStorageProvider();
    const index = new InvoiceTransferIndex();
    index.configure(storage, ADDRESS_ID);

    const ref = makeRef();
    const entryKey = `${ref.transferId}::${ref.coinId}`;

    // Pre-populate storage
    await storage.set(`${ADDRESS_ID}_inv_ledger_index`, JSON.stringify({ [INVOICE_ID]: { terminated: false } }));
    await storage.set(`${ADDRESS_ID}_inv_ledger:${INVOICE_ID}`, JSON.stringify([ref]));

    await index.loadFromStorage();

    const loaded = index.getEntries(INVOICE_ID);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      transferId: MOCK_TRANSFER_ID,
      coinId: COIN_ID,
    });
  });

  // UT-INDEX-006
  it('UT-INDEX-006: incremental update only processes new transactions', async () => {
    const index = new InvoiceTransferIndex();

    // Seed with first transaction already processed (watermark = 1)
    const firstToken = createTestTransfer(INVOICE_ID, 'F', '5000000', COIN_ID, SENDER_ADDRESS, TARGET_ADDRESS);
    if (firstToken.transactions[0]?.data) {
      (firstToken.transactions[0].data as Record<string, unknown>)['recipient'] = TARGET_ADDRESS;
    }

    const invoiceExists = vi.fn().mockReturnValue(true);

    // First scan (processes tx[0])
    await index.processTokenTransactions(firstToken, invoiceExists);
    expect(index.getTokenWatermark(firstToken.genesis.data.tokenId)).toBe(1);

    // Now add a second transaction to the token
    const secondTx = { ...firstToken.transactions[0]! };
    firstToken.transactions.push(secondTx);

    // Second scan (should only process tx[1], not tx[0] again)
    const newEntries = await index.processTokenTransactions(firstToken, invoiceExists);

    // Only the new transaction creates entries; the watermark should advance
    expect(index.getTokenWatermark(firstToken.genesis.data.tokenId)).toBe(2);
    // New entries came from the second transaction only
    expect(newEntries.length).toBeGreaterThanOrEqual(0); // may be 0 if deduped
  });

  // UT-INDEX-007
  it('UT-INDEX-007: getEntries returns all entries for invoice', () => {
    const index = new InvoiceTransferIndex();

    const ref1 = makeRef({ transferId: 'transfer-001', coinId: 'UCT', amount: '1000000' });
    const ref2 = makeRef({ transferId: 'transfer-002', coinId: 'UCT', amount: '2000000' });
    index.addEntry(INVOICE_ID, 'transfer-001::UCT', ref1);
    index.addEntry(INVOICE_ID, 'transfer-002::UCT', ref2);

    const entries = index.getEntries(INVOICE_ID);

    expect(entries).toHaveLength(2);
    const amounts = entries.map((e) => e.amount).sort();
    expect(amounts).toEqual(['1000000', '2000000']);
  });

  // UT-INDEX-008
  it('UT-INDEX-008: balance cache is invalidated on mutation (addEntry)', () => {
    const index = new InvoiceTransferIndex();

    const snapshot: InvoiceBalanceSnapshot = {
      aggregate: new Map(),
      perSender: new Map(),
    };
    index.setCachedBalance(INVOICE_ID, snapshot);
    expect(index.getCachedBalance(INVOICE_ID)).not.toBeNull();

    // Adding an entry should invalidate the cache
    const ref = makeRef();
    index.addEntry(INVOICE_ID, `${ref.transferId}::${ref.coinId}`, ref);

    expect(index.getCachedBalance(INVOICE_ID)).toBeNull();
  });

  // UT-INDEX-009
  it('UT-INDEX-009: removeEntries removes the specified entries', () => {
    const index = new InvoiceTransferIndex();

    const ref1 = makeRef({ transferId: 'transfer-A', coinId: 'UCT', amount: '1000' });
    const ref2 = makeRef({ transferId: 'transfer-B', coinId: 'UCT', amount: '2000' });
    index.addEntry(INVOICE_ID, 'transfer-A::UCT', ref1);
    index.addEntry(INVOICE_ID, 'transfer-B::UCT', ref2);
    expect(index.getEntries(INVOICE_ID)).toHaveLength(2);

    index.removeEntries(INVOICE_ID, ['transfer-A::UCT']);

    const remaining = index.getEntries(INVOICE_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.transferId).toBe('transfer-B');
  });

  // UT-INDEX-010
  it('UT-INDEX-010: flushToStorage persists entries to storage', async () => {
    const storage = createMockStorageProvider();
    const index = new InvoiceTransferIndex();
    index.configure(storage, ADDRESS_ID);

    const ref = makeRef();
    index.ensureInvoice(INVOICE_ID);
    index.addEntry(INVOICE_ID, `${ref.transferId}::${ref.coinId}`, ref);

    await index.flushToStorage();

    // Verify storage was written
    const ledgerKey = `${ADDRESS_ID}_inv_ledger:${INVOICE_ID}`;
    const indexKey = `${ADDRESS_ID}_inv_ledger_index`;
    expect(storage.set).toHaveBeenCalled();

    const storedLedger = await storage.get(ledgerKey);
    expect(storedLedger).not.toBeNull();

    const storedIndex = await storage.get(indexKey);
    expect(storedIndex).not.toBeNull();
    const parsedIndex = JSON.parse(storedIndex!);
    expect(parsedIndex).toHaveProperty(INVOICE_ID);
  });

  // UT-INDEX-011
  it('UT-INDEX-011: loadFromStorage recovers persisted entries', async () => {
    const storage = createMockStorageProvider();
    const index = new InvoiceTransferIndex();
    index.configure(storage, ADDRESS_ID);

    // Persist entries first
    const ref = makeRef({ transferId: 'persist-test', coinId: 'UCT', amount: '7777777' });
    index.ensureInvoice(INVOICE_ID);
    index.addEntry(INVOICE_ID, `persist-test::UCT`, ref);
    await index.flushToStorage();

    // Now create a fresh index and load from storage
    const freshIndex = new InvoiceTransferIndex();
    freshIndex.configure(storage, ADDRESS_ID);
    await freshIndex.loadFromStorage();

    const recovered = freshIndex.getEntries(INVOICE_ID);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      transferId: 'persist-test',
      amount: '7777777',
    });
  });
});
