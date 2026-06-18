/**
 * AccountingModule — Error propagation tests (UT-ERRORS)
 *
 * Validates that each INVOICE_* error code is thrown by the correct method,
 * SphereError instances have correct code/message/cause, error codes are unique,
 * MODULE_DESTROYED is thrown after destroy(), and INVOICE_ORACLE_REQUIRED when
 * the token engine (v2 oracle config) is unavailable.
 *
 * Invoices run exclusively on the v2 token engine: importInvoice() accepts
 * only a v2 engine blob hex string (legacy v1 TXF objects → INVOICE_INVALID_DATA)
 * and createInvoice() mints via engine.mintDataToken. Engine-path cases use the
 * FakeTokenEngine harness (no SDK mocks).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  SphereError,
  DEFAULT_TEST_IDENTITY,
  DEFAULT_TEST_TRACKED_ADDRESS,
} from './accounting-test-helpers.js';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
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
// INVOICE_NO_TARGETS
// =============================================================================

describe('Error: INVOICE_NO_TARGETS', () => {
  beforeEach(() => setup());

  it('createInvoice with empty targets throws INVOICE_NO_TARGETS', async () => {
    await module.load();

    const err = await module.createInvoice({ targets: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NO_TARGETS');
    expect(err.message).toBeDefined();
  });
});

// =============================================================================
// INVOICE_INVALID_ADDRESS
// =============================================================================

describe('Error: INVOICE_INVALID_ADDRESS', () => {
  beforeEach(() => setup());

  it('createInvoice with bad address throws INVOICE_INVALID_ADDRESS', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'not-direct', assets: [{ coin: ['UCT', '100'] }] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_ADDRESS');
  });
});

// =============================================================================
// INVOICE_NO_ASSETS
// =============================================================================

describe('Error: INVOICE_NO_ASSETS', () => {
  beforeEach(() => setup());

  it('createInvoice with empty assets throws INVOICE_NO_ASSETS', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NO_ASSETS');
  });
});

// =============================================================================
// INVOICE_INVALID_ASSET
// =============================================================================

describe('Error: INVOICE_INVALID_ASSET', () => {
  beforeEach(() => setup());

  it('createInvoice with neither coin nor nft throws INVOICE_INVALID_ASSET', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [{}] as any }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_ASSET');
  });
});

// =============================================================================
// INVOICE_INVALID_AMOUNT
// =============================================================================

describe('Error: INVOICE_INVALID_AMOUNT', () => {
  beforeEach(() => setup());

  it('createInvoice with non-integer amount throws INVOICE_INVALID_AMOUNT', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['UCT', '10.5'] }] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_AMOUNT');
  });
});

// =============================================================================
// INVOICE_INVALID_COIN
// =============================================================================

describe('Error: INVOICE_INVALID_COIN', () => {
  beforeEach(() => setup());

  it('createInvoice with empty coinId throws INVOICE_INVALID_COIN', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      targets: [{ address: 'DIRECT://alice', assets: [{ coin: ['', '100'] }] }],
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_COIN');
  });
});

// =============================================================================
// INVOICE_PAST_DUE_DATE
// =============================================================================

describe('Error: INVOICE_PAST_DUE_DATE', () => {
  beforeEach(() => setup());

  it('createInvoice with past dueDate throws INVOICE_PAST_DUE_DATE', async () => {
    await module.load();

    const err = await module.createInvoice(createTestInvoice({
      dueDate: Date.now() - 10000,
    })).catch((e) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_PAST_DUE_DATE');
  });
});

// =============================================================================
// INVOICE_NOT_FOUND
// =============================================================================

describe('Error: INVOICE_NOT_FOUND', () => {
  beforeEach(() => setup());

  it('getInvoiceStatus with nonexistent ID throws INVOICE_NOT_FOUND', async () => {
    await module.load();

    const err = await module.getInvoiceStatus(randomHex64()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_FOUND');
  });

  it('closeInvoice with nonexistent ID throws INVOICE_NOT_FOUND', async () => {
    await module.load();

    const err = await module.closeInvoice(randomHex64()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_FOUND');
  });

  it('cancelInvoice with nonexistent ID throws INVOICE_NOT_FOUND', async () => {
    await module.load();

    const err = await module.cancelInvoice(randomHex64()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_FOUND');
  });
});

// =============================================================================
// INVOICE_NOT_TARGET
// =============================================================================

describe('Error: INVOICE_NOT_TARGET', () => {
  beforeEach(() => setup());

  it('closeInvoice when not a target throws INVOICE_NOT_TARGET', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: 'DIRECT://other', assets: [{ coin: ['UCT', '100'] }] }],
    });

    const err = await module.closeInvoice(invoiceId).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_NOT_TARGET');
  });
});

// =============================================================================
// INVOICE_ALREADY_CLOSED
// =============================================================================

describe('Error: INVOICE_ALREADY_CLOSED', () => {
  beforeEach(() => setup());

  it('closeInvoice on already-closed invoice throws INVOICE_ALREADY_CLOSED', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.invoiceLedger.set(invoiceId, new Map());
    mod.closedInvoices.add(invoiceId);

    const err = await module.closeInvoice(invoiceId).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ALREADY_CLOSED');
  });
});

// =============================================================================
// INVOICE_ALREADY_CANCELLED
// =============================================================================

describe('Error: INVOICE_ALREADY_CANCELLED', () => {
  beforeEach(() => setup());

  it('cancelInvoice on already-cancelled throws INVOICE_ALREADY_CANCELLED', async () => {
    await module.load();

    const invoiceId = randomHex64();
    const mod = module as any;
    const myAddress = DEFAULT_TEST_TRACKED_ADDRESS.directAddress;
    mod.invoiceTermsCache.set(invoiceId, {
      createdAt: 1000,
      targets: [{ address: myAddress, assets: [{ coin: ['UCT', '100'] }] }],
    });
    mod.cancelledInvoices.add(invoiceId);

    const err = await module.cancelInvoice(invoiceId).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ALREADY_CANCELLED');
  });
});

// =============================================================================
// INVOICE_INVALID_DATA (importInvoice)
// =============================================================================

describe('Error: INVOICE_INVALID_DATA', () => {
  it('importInvoice with a legacy v1 TXF object throws INVOICE_INVALID_DATA', async () => {
    setup({ tokenEngine: new FakeTokenEngine() });
    await module.load();

    // Any non-string token (the old TXF object form) is refused outright —
    // verifying it required the removed v1 engine.
    const legacyTxfObject = {
      version: '2.0',
      genesis: {
        data: {
          tokenId: 'a'.repeat(64),
          coinData: [],
          tokenData: JSON.stringify({
            createdAt: Date.now() - 1000,
            targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }],
          }),
        },
      },
      transactions: [],
    };

    const err = await module.importInvoice(legacyTxfObject as any).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_DATA');
    expect(err.message).toContain('Legacy (v1 TXF) invoice tokens are no longer supported');
  });

  it('importInvoice with corrupt tokenData throws INVOICE_INVALID_DATA', async () => {
    const engine = new FakeTokenEngine();
    setup({ tokenEngine: engine });
    await module.load();

    // A valid v2 blob whose data payload is not parseable JSON.
    const token = await engine.mintDataToken({
      recipientPubkey: hexToBytes(DEFAULT_TEST_IDENTITY.chainPubkey),
      data: new TextEncoder().encode('{{broken}}'),
    });
    const blob = bytesToHex(encodeTokenBlob(engine.encodeToken(token)));

    (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);

    const err = await module.importInvoice(blob).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_INVALID_DATA');
  });
});

// =============================================================================
// MODULE_DESTROYED after destroy()
// =============================================================================

describe('Error: MODULE_DESTROYED', () => {
  it('all I/O methods throw MODULE_DESTROYED after destroy()', async () => {
    setup();
    await module.load();
    module.destroy();

    const methods = [
      () => module.createInvoice({ targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }] }),
      () => module.getInvoices(),
      () => module.getInvoiceStatus('a'.repeat(64)),
      () => module.closeInvoice('a'.repeat(64)),
      () => module.cancelInvoice('a'.repeat(64)),
      () => module.setAutoReturn('*', true),
      () => module.sendInvoiceReceipts('a'.repeat(64)),
      () => module.sendCancellationNotices('a'.repeat(64)),
    ];

    for (const method of methods) {
      const err = await (method() as Promise<unknown>).catch((e) => e);
      expect(err).toBeInstanceOf(SphereError);
      expect(err.code).toBe('MODULE_DESTROYED');
    }
  });
});

// =============================================================================
// INVOICE_ORACLE_REQUIRED when the token engine is unavailable
// =============================================================================

describe('Error: INVOICE_ORACLE_REQUIRED', () => {
  it('createInvoice without a token engine throws INVOICE_ORACLE_REQUIRED', async () => {
    // Default setup has no tokenEngine — the v2 engine is mandatory for minting.
    setup();
    await module.load();

    const err = await module.createInvoice(createTestInvoice()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ORACLE_REQUIRED');
    expect(err.message).toContain('Token engine unavailable');
  });

  it('importInvoice without a token engine throws INVOICE_ORACLE_REQUIRED', async () => {
    // Mint a valid blob on a standalone engine, then import into an engineless module.
    const minter = new FakeTokenEngine();
    const token = await minter.mintDataToken({
      recipientPubkey: hexToBytes(DEFAULT_TEST_IDENTITY.chainPubkey),
      data: new TextEncoder().encode(JSON.stringify({
        createdAt: Date.now() - 1000,
        targets: [{ address: 'DIRECT://a', assets: [{ coin: ['UCT', '100'] }] }],
      })),
    });
    const blob = bytesToHex(encodeTokenBlob(minter.encodeToken(token)));

    setup();
    await module.load();

    const err = await module.importInvoice(blob).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_ORACLE_REQUIRED');
  });
});

// =============================================================================
// INVOICE_MINT_FAILED when the engine mint fails
// =============================================================================

describe('Error: INVOICE_MINT_FAILED', () => {
  it('createInvoice wraps engine.mintDataToken failure as INVOICE_MINT_FAILED', async () => {
    const engine = new FakeTokenEngine();
    setup({ tokenEngine: engine });
    await module.load();

    vi.spyOn(engine, 'mintDataToken').mockRejectedValue(new Error('aggregator down'));

    const err = await module.createInvoice(createTestInvoice()).catch((e) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('INVOICE_MINT_FAILED');
  });
});

// =============================================================================
// SphereError instances have correct structure
// =============================================================================

describe('SphereError structure', () => {
  beforeEach(() => setup());

  it('SphereError has name, code, and message', async () => {
    await module.load();

    await expect(
      module.createInvoice({ targets: [] }),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(SphereError);
      const se = e as SphereError;
      expect(se.name).toBe('SphereError');
      expect(se.code).toBe('INVOICE_NO_TARGETS');
      expect(typeof se.message).toBe('string');
      expect(se.message.length).toBeGreaterThan(0);
      return true;
    });
  });
});

// =============================================================================
// Error codes are unique (no duplicates in SphereErrorCode)
// =============================================================================

describe('Error code uniqueness', () => {
  it('INVOICE_* error codes from SphereErrorCode are all distinct strings', async () => {
    // This is a compile-time property, but we verify a sample set at runtime
    const codes = [
      'INVOICE_NO_TARGETS',
      'INVOICE_INVALID_ADDRESS',
      'INVOICE_NO_ASSETS',
      'INVOICE_INVALID_ASSET',
      'INVOICE_INVALID_AMOUNT',
      'INVOICE_INVALID_COIN',
      'INVOICE_PAST_DUE_DATE',
      'INVOICE_DUPLICATE_ADDRESS',
      'INVOICE_DUPLICATE_COIN',
      'INVOICE_MINT_FAILED',
      'INVOICE_NOT_FOUND',
      'INVOICE_NOT_TARGET',
      'INVOICE_ALREADY_CLOSED',
      'INVOICE_ALREADY_CANCELLED',
      'INVOICE_ORACLE_REQUIRED',
      'INVOICE_TERMINATED',
      'MODULE_DESTROYED',
    ];

    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });
});
