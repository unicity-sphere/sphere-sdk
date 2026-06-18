/**
 * AccountingModule — importInvoice() tests (§3.3) — v2 engine path.
 *
 * importInvoice() accepts ONLY a v2 engine blob (hex string). The flow:
 * engine.decodeToken → engine.verify (proof) → engine.tokenId →
 * engine.readTokenData (terms JSON) → business validation of terms →
 * duplicate check → store via payments.addToken → retroactive scan.
 *
 * Legacy v1 TXF invoice objects are rejected with INVOICE_INVALID_DATA —
 * their proof verification required the removed v1 engine. The old v1
 * canonical-hash and SdkToken.verify checks are covered by engine.verify
 * by construction (the proof chain binds terms AND token id on-chain).
 *
 * Uses the FakeTokenEngine harness (no SDK vi.mock): valid import blobs are
 * produced by minting a data token with crafted terms on the SAME engine
 * instance the module is wired with.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestTransfer,
  SphereError,
  INVOICE_TOKEN_TYPE_HEX,
  DEFAULT_TEST_IDENTITY,
} from './accounting-test-helpers.js';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';
import type { Token } from '../../../types/index.js';

// =============================================================================
// Shared setup — module wired with a FakeTokenEngine
// =============================================================================

let module: AccountingModule;
let mocks: TestAccountingModuleMocks;
let engine: FakeTokenEngine;

function setup(overrides?: Parameters<typeof createTestAccountingModule>[0]) {
  engine = new FakeTokenEngine();
  const result = createTestAccountingModule({ tokenEngine: engine, ...overrides });
  module = result.module;
  mocks = result.mocks;
  // addToken is not part of the base payments mock — add it.
  (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
}

afterEach(() => {
  try { module.destroy(); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// =============================================================================
// Helpers: valid invoice terms + v2 blob minting
// =============================================================================

const RECIPIENT_PUBKEY = hexToBytes(DEFAULT_TEST_IDENTITY.chainPubkey);

function validTerms(overrides?: Partial<InvoiceTerms>): InvoiceTerms {
  return {
    createdAt: Date.now() - 60000,
    targets: [
      {
        address: 'DIRECT://target_addr_1',
        assets: [{ coin: ['UCT', '10000000'] as [string, string] }],
      },
    ],
    ...overrides,
  };
}

/** Mint a v2 invoice data token with the given (possibly crafted) terms and return its blob hex. */
async function mintInvoiceBlob(
  eng: FakeTokenEngine,
  terms: unknown,
): Promise<{ blob: string; tokenId: string }> {
  const token = await eng.mintDataToken({
    recipientPubkey: RECIPIENT_PUBKEY,
    data: new TextEncoder().encode(JSON.stringify(terms)),
    tokenType: hexToBytes(INVOICE_TOKEN_TYPE_HEX),
  });
  return {
    blob: bytesToHex(encodeTokenBlob(eng.encodeToken(token))),
    tokenId: eng.tokenId(token),
  };
}

function expectCode(code: string) {
  return (e: unknown) => e instanceof SphereError && (e as SphereError).code === code;
}

// =============================================================================
// UT-IMPORT-001: Valid invoice blob import
// =============================================================================

describe('UT-IMPORT-001: Valid invoice blob import', () => {
  beforeEach(() => setup());

  it('adds terms to cache, stores the blob via payments.addToken(), fires invoice:created', async () => {
    await module.load();

    const terms = validTerms();
    const { blob, tokenId } = await mintInvoiceBlob(engine, terms);

    const result = await module.importInvoice(blob);

    // Terms are returned
    expect(result).toBeDefined();
    expect(result.createdAt).toBe(terms.createdAt);
    expect(result.targets).toEqual(terms.targets);

    // Cache is populated under the engine's genesis-stable token id
    const mod = module as any;
    expect(mod.invoiceTermsCache.has(tokenId)).toBe(true);

    // Stored exactly once, with the blob hex as sdkData + INVOICE coinId
    const addToken = (mocks.payments as any).addToken;
    expect(addToken).toHaveBeenCalledOnce();
    const stored = addToken.mock.calls[0][0];
    expect(stored.id).toBe(tokenId);
    expect(stored.coinId).toBe(INVOICE_TOKEN_TYPE_HEX);
    expect(stored.sdkData).toBe(blob);

    // invoice:created fired (imported invoices are not locally confirmed)
    expect(mod.deps.emitEvent).toHaveBeenCalledWith(
      'invoice:created',
      { invoiceId: tokenId, confirmed: false },
    );
  });
});

// =============================================================================
// UT-IMPORT-002: Duplicate import returns INVOICE_ALREADY_EXISTS
// =============================================================================

describe('UT-IMPORT-002: Duplicate import throws INVOICE_ALREADY_EXISTS', () => {
  beforeEach(() => setup());

  it('throws INVOICE_ALREADY_EXISTS when importing the same blob twice', async () => {
    await module.load();

    const { blob } = await mintInvoiceBlob(engine, validTerms());

    await module.importInvoice(blob);

    await expect(module.importInvoice(blob)).rejects.toSatisfy(
      expectCode('INVOICE_ALREADY_EXISTS'),
    );
  });
});

// =============================================================================
// UT-IMPORT-003: Legacy v1 TXF object rejected with INVOICE_INVALID_DATA
// =============================================================================

describe('UT-IMPORT-003: Legacy (v1 TXF) invoice object is rejected', () => {
  beforeEach(() => setup());

  it('throws INVOICE_INVALID_DATA with a "Legacy" message for a non-string token', async () => {
    await module.load();

    // A v1-era TXF-shaped object (any non-string) — verification of these
    // required the removed v1 engine, so import refuses them outright.
    const legacyTxfObject = {
      version: '2.0',
      genesis: {
        data: {
          tokenId: 'a'.repeat(64),
          tokenType: INVOICE_TOKEN_TYPE_HEX,
          coinData: [],
          tokenData: JSON.stringify(validTerms()),
        },
      },
      state: { data: '', predicate: '' },
      transactions: [],
    };

    const err = await module.importInvoice(legacyTxfObject as any).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_DATA');
    expect(err.message).toContain('Legacy (v1 TXF) invoice tokens are no longer supported');

    // Nothing was stored
    expect((mocks.payments as any).addToken).not.toHaveBeenCalled();
  });
});

// =============================================================================
// UT-IMPORT-004: No token engine throws INVOICE_ORACLE_REQUIRED
// =============================================================================

describe('UT-IMPORT-004: Missing token engine throws INVOICE_ORACLE_REQUIRED', () => {
  it('rejects a blob string when the module has no engine', async () => {
    // Mint a perfectly valid blob on a standalone engine…
    const minter = new FakeTokenEngine();
    const { blob } = await mintInvoiceBlob(minter, validTerms());

    // …but wire the module WITHOUT an engine.
    setup({ tokenEngine: undefined });
    await module.load();

    await expect(module.importInvoice(blob)).rejects.toSatisfy(
      expectCode('INVOICE_ORACLE_REQUIRED'),
    );
  });
});

// =============================================================================
// UT-IMPORT-005: Proof verification failure throws INVOICE_INVALID_PROOF
// =============================================================================

describe('UT-IMPORT-005: Verification failure rejects import', () => {
  beforeEach(() => setup());

  it('throws INVOICE_INVALID_PROOF when engine.verify reports ok: false', async () => {
    await module.load();

    const { blob } = await mintInvoiceBlob(engine, validTerms());

    vi.spyOn(engine, 'verify').mockResolvedValue({ ok: false, reason: 'bad proof' });

    await expect(module.importInvoice(blob)).rejects.toSatisfy(
      expectCode('INVOICE_INVALID_PROOF'),
    );
    expect((mocks.payments as any).addToken).not.toHaveBeenCalled();
  });
});

// =============================================================================
// UT-IMPORT-006: Missing tokenData throws INVOICE_INVALID_DATA
// =============================================================================

describe('UT-IMPORT-006: Missing tokenData throws INVOICE_INVALID_DATA', () => {
  beforeEach(() => setup());

  it('rejects a token that carries no data payload (engine.readTokenData → null)', async () => {
    await module.load();

    // A value-less plain mint has no genesis data — readTokenData returns null.
    const dataless = await engine.mint({ recipientPubkey: RECIPIENT_PUBKEY });
    const blob = bytesToHex(encodeTokenBlob(engine.encodeToken(dataless)));

    await expect(module.importInvoice(blob)).rejects.toSatisfy(
      expectCode('INVOICE_INVALID_DATA'),
    );
  });
});

// =============================================================================
// UT-IMPORT-007: Unparseable tokenData throws INVOICE_INVALID_DATA
// =============================================================================

describe('UT-IMPORT-007: Unparseable tokenData throws INVOICE_INVALID_DATA', () => {
  beforeEach(() => setup());

  it('rejects a data token whose payload is not valid JSON', async () => {
    await module.load();

    const token = await engine.mintDataToken({
      recipientPubkey: RECIPIENT_PUBKEY,
      data: new TextEncoder().encode('{not valid json!!!'),
      tokenType: hexToBytes(INVOICE_TOKEN_TYPE_HEX),
    });
    const blob = bytesToHex(encodeTokenBlob(engine.encodeToken(token)));

    await expect(module.importInvoice(blob)).rejects.toSatisfy(
      expectCode('INVOICE_INVALID_DATA'),
    );
  });
});

// =============================================================================
// UT-IMPORT-008: Terms business validation (createdAt skew, dueDate, targets)
// =============================================================================

describe('UT-IMPORT-008: Terms business validation rejects invalid terms', () => {
  beforeEach(() => setup());

  async function importTerms(terms: unknown): Promise<unknown> {
    const { blob } = await mintInvoiceBlob(engine, terms);
    return module.importInvoice(blob).catch((e) => e);
  }

  it('rejects createdAt beyond the allowed 1-day clock skew', async () => {
    await module.load();

    const err = await importTerms(validTerms({ createdAt: Date.now() + 2 * 86400000 }));
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
    expect((err as SphereError).message).toMatch(/createdAt/);
  });

  it('rejects missing createdAt', async () => {
    await module.load();

    const terms: any = validTerms();
    delete terms.createdAt;
    const err = await importTerms(terms);
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
  });

  it('rejects a dueDate that is not a positive integer', async () => {
    await module.load();

    const err = await importTerms(validTerms({ dueDate: -1 }));
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
    expect((err as SphereError).message).toMatch(/dueDate/);
  });

  it('rejects an empty targets array', async () => {
    await module.load();

    const err = await importTerms({ createdAt: Date.now() - 1000, targets: [] });
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
    expect((err as SphereError).message).toMatch(/targets/);
  });

  it('rejects a target address that is not DIRECT://', async () => {
    await module.load();

    const err = await importTerms(validTerms({
      targets: [{ address: 'not-direct', assets: [{ coin: ['UCT', '100'] as [string, string] }] }],
    }));
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
  });

  it('rejects a target with no assets', async () => {
    await module.load();

    const err = await importTerms(validTerms({
      targets: [{ address: 'DIRECT://target_addr_1', assets: [] }],
    }));
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
  });

  it('rejects a non-integer coin amount', async () => {
    await module.load();

    const err = await importTerms(validTerms({
      targets: [{ address: 'DIRECT://target_addr_1', assets: [{ coin: ['UCT', '10.5'] as [string, string] }] }],
    }));
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('INVOICE_INVALID_DATA');
  });
});

// =============================================================================
// UT-IMPORT-009: Multi-target terms parsed correctly
// =============================================================================

describe('UT-IMPORT-009: Multi-target terms parsed correctly', () => {
  beforeEach(() => setup());

  it('imports a blob with multiple targets and assets', async () => {
    await module.load();

    const terms = validTerms({
      targets: [
        {
          address: 'DIRECT://target_1',
          assets: [
            { coin: ['UCT', '1000'] as [string, string] },
            { coin: ['USDU', '2000'] as [string, string] },
          ],
        },
        {
          address: 'DIRECT://target_2',
          assets: [{ coin: ['TUSD', '500'] as [string, string] }],
        },
      ],
    });
    const { blob } = await mintInvoiceBlob(engine, terms);

    const result = await module.importInvoice(blob);

    expect(result.targets).toHaveLength(2);
    expect(result.targets[0].assets).toHaveLength(2);
    expect(result.targets[1].assets).toHaveLength(1);
  });
});

// =============================================================================
// UT-IMPORT-010: Expired dueDate still succeeds on import
// =============================================================================

describe('UT-IMPORT-010: Import with expired dueDate still succeeds', () => {
  beforeEach(() => setup());

  it('does not reject expired dueDate on import (expiry is informational)', async () => {
    await module.load();

    const terms = validTerms({
      dueDate: Date.now() - 86400000, // 1 day in the past
    });
    const { blob } = await mintInvoiceBlob(engine, terms);

    const result = await module.importInvoice(blob);
    expect(result.dueDate).toBe(terms.dueDate);
  });
});

// =============================================================================
// UT-IMPORT-011: Storage failure throws INVOICE_STORAGE_FAILED
// =============================================================================

describe('UT-IMPORT-011: Storage failure throws INVOICE_STORAGE_FAILED', () => {
  beforeEach(() => setup());

  it('wraps payments.addToken rejection and does not register the invoice', async () => {
    await module.load();

    (mocks.payments as any).addToken = vi.fn().mockRejectedValue(new Error('disk full'));

    const { blob, tokenId } = await mintInvoiceBlob(engine, validTerms());

    const err = await module.importInvoice(blob).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_STORAGE_FAILED');

    // The invoice must NOT be registered when persistence failed
    expect((module as any).invoiceTermsCache.has(tokenId)).toBe(false);
  });
});

// =============================================================================
// UT-IMPORT-012: Proactive indexing — pre-indexed entries available on import
// =============================================================================

describe('UT-IMPORT-012: Proactive indexing picks up pre-indexed entries', () => {
  beforeEach(() => setup());

  const PAYER = new Uint8Array([0x02, ...new Array<number>(32).fill(3)]); // 33 bytes
  const UCT_HEX = '11'.repeat(32); // lowercase-hex coin id

  it('entries indexed before import are available in the ledger after import', async () => {
    await module.load();
    const mod = module as any;

    // The invoice exists out there (minted on the same engine fixture) but is
    // NOT imported yet.
    const terms = validTerms();
    const { blob, tokenId: invoiceId } = await mintInvoiceBlob(engine, terms);

    // A v2 payment token referencing this invoice in its on-chain transfer memo
    // arrives BEFORE the invoice is imported.
    const valueToken = await engine.mint({
      recipientPubkey: PAYER,
      value: { assets: [{ coinId: UCT_HEX, amount: 5000000n }] },
    });
    const memo = new TextEncoder().encode(JSON.stringify({ inv: { id: invoiceId, dir: 'F' } }));
    const paid = await engine.transfer({ token: valueToken, recipientPubkey: PAYER, data: memo });
    const paymentToken: Token = {
      id: 'pay-1', coinId: UCT_HEX, symbol: 'UCT', name: 'UCT', decimals: 0,
      amount: '5000000', status: 'confirmed', createdAt: Date.now(), updatedAt: Date.now(),
      sdkData: bytesToHex(encodeTokenBlob(engine.encodeToken(paid))),
    };

    // Make getTokens return this payment token (simulates pre-existing inventory)
    mocks.payments.getTokens.mockReturnValue([paymentToken]);

    // Scan it (simulates what happens during load or event handling)
    expect(await mod._scanTokenForAttribution(paymentToken, 0)).toBe(true);
    await mod._flushDirtyLedgerEntries();

    // At this point, invoiceTermsCache does NOT have invoiceId, but the ledger
    // does (proactive indexing)
    expect(mod.invoiceTermsCache.has(invoiceId)).toBe(false);
    const preLedger = mod.invoiceLedger.get(invoiceId);
    expect(preLedger).toBeDefined();
    expect(preLedger.size).toBeGreaterThan(0);

    // Now import the invoice
    const result = await module.importInvoice(blob);
    expect(result).toBeDefined();

    // Ledger entries from proactive indexing should still be present
    const postLedger = mod.invoiceLedger.get(invoiceId);
    expect(postLedger).toBeDefined();
    expect(postLedger.size).toBeGreaterThan(0);
    const ref = [...postLedger.values()][0];
    expect(ref.coinId).toBe(UCT_HEX);
    expect(ref.amount).toBe('5000000');
  });
});

// =============================================================================
// UT-IMPORT-013: Token observer indexes transactions at add time
// =============================================================================

describe('UT-IMPORT-013: Token observer indexes transactions inline', () => {
  beforeEach(() => setup());

  it('token change callback indexes invoice transactions immediately', async () => {
    await module.load();
    const mod = module as any;

    // Verify onTokenChange was registered during load
    expect(mocks.payments.onTokenChange).toHaveBeenCalledOnce();

    // The invoice the payment refers to (only its id matters here)
    const { tokenId: invoiceId } = await mintInvoiceBlob(engine, validTerms());

    // Create a payment token referencing this invoice (TXF-format payment
    // history is still scanned for attribution)
    const paymentTransfer = createTestTransfer(invoiceId, 'F', '5000000', 'UCT', 'DIRECT://some_sender', 'DIRECT://target_addr_1');

    // The observer receives the genesis tokenId (from TXF) and the sdkData JSON
    const txfTokenId = paymentTransfer.genesis.data.tokenId;

    // Simulate PaymentsModule notifying about a new token via the observer
    const sdkData = JSON.stringify(paymentTransfer);
    mocks.payments._notifyTokenChange(txfTokenId, sdkData);

    // The ledger should now have entries for this invoice (indexed inline)
    const ledger = mod.invoiceLedger.get(invoiceId);
    expect(ledger).toBeDefined();
    expect(ledger.size).toBeGreaterThan(0);

    // Watermark should be advanced
    expect(mod.tokenScanState.get(txfTokenId)).toBe(1);
  });
});
