/**
 * createInvoice — v2 engine path (B2, path B).
 *
 * An invoice IS a data token: when a tokenEngine is injected, createInvoice mints
 * it via engine.mintDataToken (one call replacing the hand-rolled v1 mint) and
 * the invoice id is the engine's genesis-stable tokenId (64-char). Clean harness
 * (no SDK vi.mock) so FakeTokenEngine runs unmocked.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { createTestAccountingModule, createTestInvoice } from './accounting-test-helpers.js';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { decodeTokenBlob, encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes, bytesToHex } from '../../../core/crypto';
import { INVOICE_TOKEN_TYPE_HEX } from '../../../constants';
import type { Token } from '../../../types';

function setup() {
  const engine = new FakeTokenEngine();
  const { module, mocks } = createTestAccountingModule({ tokenEngine: engine });
  // addToken is not part of the base mock — add it (mirrors createInvoice.test.ts).
  (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
  return { module, mocks, engine };
}

describe('createInvoice — v2 engine path (B2)', () => {
  it('mints the invoice as a data token and stores the blob (64-char engine id)', async () => {
    const { module, mocks, engine } = setup();

    const result = await module.createInvoice(createTestInvoice());

    expect(result.success).toBe(true);
    expect(result.invoiceId).toMatch(/^[0-9a-f]{64}$/);

    // Stored via payments.addToken with the engine blob as sdkData + INVOICE coinId.
    const added = (mocks.payments as any).addToken.mock.calls.at(-1)[0];
    expect(added.id).toBe(result.invoiceId);
    expect(added.coinId).toBe(INVOICE_TOKEN_TYPE_HEX);

    // sdkData is the engine blob; its genesis-stable tokenId === the invoice id.
    const blob = decodeTokenBlob(hexToBytes(added.sdkData));
    expect(blob.tokenId).toBe(result.invoiceId);

    // mintDataToken was used (not a value mint) — the engine actually produced it.
    const token = await engine.decodeToken(blob);
    expect(engine.readValue(token)).toBeNull();          // value-less ⇒ data token
    expect(engine.readTokenData(token)).not.toBeNull();  // carries the invoice terms
  });

  it('reports the same invoice id it stored', async () => {
    const { module, mocks } = setup();
    const result = await module.createInvoice(createTestInvoice({ memo: 'order #42' }));
    const added = (mocks.payments as any).addToken.mock.calls.at(-1)[0];
    expect(added.id).toBe(result.invoiceId);
    expect(result.token).toBeDefined();
  });
});

describe('importInvoice — v2 engine path (B2)', () => {
  it('round-trips: createInvoice (v2) → importInvoice (v2 blob)', async () => {
    const engine = new FakeTokenEngine();

    // Creator mints a v2 invoice; result.token is the engine blob (hex).
    const creator = createTestAccountingModule({ tokenEngine: engine });
    (creator.mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
    const created = await creator.module.createInvoice(createTestInvoice({ memo: 'round-trip' }));
    expect(created.success).toBe(true);

    // A fresh importer (same engine fixture) decodes + verifies + stores it.
    const importer = createTestAccountingModule({ tokenEngine: engine });
    (importer.mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
    const terms = await importer.module.importInvoice(created.token!);

    expect(terms.memo).toBe('round-trip');
    // Stored under the same genesis-stable id with the blob as sdkData.
    const added = (importer.mocks.payments as any).addToken.mock.calls.at(-1)[0];
    expect(added.id).toBe(created.invoiceId);
    expect(added.coinId).toBe(INVOICE_TOKEN_TYPE_HEX);
  });

  it('rejects a blob whose proof does not verify', async () => {
    const engine = new FakeTokenEngine();
    const creator = createTestAccountingModule({ tokenEngine: engine });
    (creator.mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
    const created = await creator.module.createInvoice(createTestInvoice());

    // An engine whose verify() fails ⇒ INVOICE_INVALID_PROOF on import.
    const badEngine = new FakeTokenEngine();
    (badEngine as any).verify = vi.fn().mockResolvedValue({ ok: false, reason: 'bad' });
    const importer = createTestAccountingModule({ tokenEngine: badEngine });
    (importer.mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    await expect(importer.module.importInvoice(created.token!)).rejects.toThrow(/proof is invalid/i);
  });
});

describe('attribution — v2 engine path (B2)', () => {
  const PAYER = new Uint8Array([0x02, ...new Array<number>(32).fill(3)]); // 33 bytes
  const UCT = '11'.repeat(32); // lowercase-hex coin id (matches invoice target)

  it('attributes a v2 payment (blob memo) to the invoice ledger', async () => {
    const engine = new FakeTokenEngine();
    const { module, mocks } = createTestAccountingModule({ tokenEngine: engine });
    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    // Register an invoice (v2). Its target coin is a symbol (≤20 chars per spec);
    // the payment carries the real hex coin id — the ledger keys by the payment's.
    const created = await module.createInvoice(createTestInvoice());
    const invoiceId = created.invoiceId;

    // Build a v2 payment token that references the invoice in its on-chain memo.
    const valueToken = await engine.mint({ recipientPubkey: PAYER, value: { assets: [{ coinId: UCT, amount: 1000n }] } });
    const memo = new TextEncoder().encode(JSON.stringify({ inv: { id: invoiceId, dir: 'F' } }));
    const paid = await engine.transfer({ token: valueToken, recipientPubkey: PAYER, data: memo });
    const paymentToken: Token = {
      id: 'pay-1', coinId: UCT, symbol: 'UCT', name: 'n', decimals: 0,
      amount: '1000', status: 'confirmed', createdAt: 0, updatedAt: 0,
      sdkData: bytesToHex(encodeTokenBlob(engine.encodeToken(paid))),
    };

    // Scan it (full, startIndex 0) — the engine path shims it into _processTokenTransactions.
    const scanned = await (module as any)._scanTokenForAttribution(paymentToken, 0);
    expect(scanned).toBe(true);

    // The payment is now in the invoice's ledger (keyed pay-1:0::<coin>).
    const ledger = (module as any).invoiceLedger.get(invoiceId);
    expect(ledger).toBeDefined();
    expect(ledger.size).toBeGreaterThanOrEqual(1);
    const ref = [...ledger.values()][0];
    expect(ref.coinId).toBe(UCT);
    expect(ref.amount).toBe('1000');
  });

  it('ignores a v2 token with no memo', async () => {
    const engine = new FakeTokenEngine();
    const { module, mocks } = createTestAccountingModule({ tokenEngine: engine });
    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    // A minted value token has no transfer memo → nothing to attribute.
    const plain = await engine.mint({ recipientPubkey: PAYER, value: { assets: [{ coinId: UCT, amount: 5n }] } });
    const token: Token = {
      id: 'plain-1', coinId: UCT, symbol: 'UCT', name: 'n', decimals: 0,
      amount: '5', status: 'confirmed', createdAt: 0, updatedAt: 0,
      sdkData: bytesToHex(encodeTokenBlob(engine.encodeToken(plain))),
    };

    const scanned = await (module as any)._scanTokenForAttribution(token, 0);
    expect(scanned).toBe(false);
  });
});
