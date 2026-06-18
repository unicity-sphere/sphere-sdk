/**
 * AccountingModule — Minting flow tests (§3.2 minting subset)
 *
 * v2 engine-mint mechanics inside createInvoice(): the engine.mintDataToken
 * call shape (recipient pubkey, INVOICE token type, canonical terms payload,
 * deterministic 32-byte salt), terms-deterministic token ids, and the stored
 * engine-blob shape (readTokenData round-trips the canonical serialized terms).
 *
 * Uses the FakeTokenEngine harness (no SDK vi.mock). Engine *failure* mapping
 * (INVOICE_MINT_FAILED / SphereError passthrough) is covered in
 * AccountingModule.createInvoice.test.ts; blob storage + import round-trips in
 * AccountingModule.v2-createInvoice.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestInvoice,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { decodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes, bytesToHex } from '../../../core/crypto';
import { canonicalSerialize } from '../../../modules/accounting/serialization.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type { TestAccountingModuleMocks } from './accounting-test-helpers.js';

// =============================================================================
// Shared setup
// =============================================================================

let module: AccountingModule;
let mocks: TestAccountingModuleMocks;
let engine: FakeTokenEngine;

function setup() {
  engine = new FakeTokenEngine();
  const result = createTestAccountingModule({ tokenEngine: engine });
  module = result.module;
  mocks = result.mocks;
  // Add addToken stub
  (mocks.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
}

/** A fresh, independent module+engine pair (for cross-instance determinism checks). */
function makeHarness() {
  const e = new FakeTokenEngine();
  const { module: m, mocks: mk } = createTestAccountingModule({ tokenEngine: e });
  (mk.payments as any).addToken = vi.fn().mockResolvedValue(undefined);
  return { module: m, engine: e };
}

afterEach(() => {
  try { module.destroy(); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

// =============================================================================
// UT-MINT-001: createInvoice mints via engine.mintDataToken
// =============================================================================

describe('UT-MINT-001: createInvoice mints via engine.mintDataToken', () => {
  beforeEach(() => setup());

  it('passes the creator pubkey, INVOICE token type, canonical terms bytes, and a 32-byte salt', async () => {
    await module.load();
    const mintSpy = vi.spyOn(engine, 'mintDataToken');

    const result = await module.createInvoice(createTestInvoice());

    expect(mintSpy).toHaveBeenCalledTimes(1);
    const params = mintSpy.mock.calls[0][0];

    // Recipient = this wallet's chain pubkey.
    expect(bytesToHex(params.recipientPubkey)).toBe(mocks.identity.chainPubkey);

    // Token type = the INVOICE token type (UT-MINT-007 folded in here).
    expect(params.tokenType).toBeDefined();
    expect(bytesToHex(params.tokenType!)).toBe(INVOICE_TOKEN_TYPE_HEX);

    // Mint payload = the canonical serialization of the returned terms.
    expect(new TextDecoder().decode(params.data)).toBe(canonicalSerialize(result.terms));

    // Deterministic salt: 32 bytes (SHA-256 over signing key || serialized terms).
    expect(params.salt).toBeInstanceOf(Uint8Array);
    expect(params.salt!.length).toBe(32);
  });
});

// =============================================================================
// UT-MINT-004/006: Salt and token ID are deterministic from key + terms
// =============================================================================

describe('UT-MINT-004/006: salt and token id are deterministic from signing key + terms', () => {
  beforeEach(() => setup());

  it('identical terms on an independent module/engine produce the same salt and invoiceId', async () => {
    // Freeze the clock so createdAt (part of the terms) is identical across calls.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const request = createTestInvoice({ dueDate: 2_000_000 });

    await module.load();
    const spyA = vi.spyOn(engine, 'mintDataToken');
    const resultA = await module.createInvoice(request);

    const b = makeHarness();
    await b.module.load();
    const spyB = vi.spyOn(b.engine, 'mintDataToken');
    const resultB = await b.module.createInvoice(request);
    b.module.destroy();

    expect(resultA.invoiceId).toMatch(/^[0-9a-f]{64}$/);
    expect(resultB.invoiceId).toBe(resultA.invoiceId);
    expect(bytesToHex(spyB.mock.calls[0][0].salt!)).toBe(bytesToHex(spyA.mock.calls[0][0].salt!));
  });

  it('different terms produce a different salt and invoiceId', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await module.load();
    const mintSpy = vi.spyOn(engine, 'mintDataToken');

    const resultA = await module.createInvoice(createTestInvoice({ dueDate: 2_000_000, memo: 'invoice A' }));
    const resultB = await module.createInvoice(createTestInvoice({ dueDate: 2_000_000, memo: 'invoice B' }));

    expect(resultB.invoiceId).not.toBe(resultA.invoiceId);
    expect(bytesToHex(mintSpy.mock.calls[1][0].salt!)).not.toBe(bytesToHex(mintSpy.mock.calls[0][0].salt!));
  });
});

// =============================================================================
// UT-MINT-008: Stored engine blob carries the canonical serialized terms
// =============================================================================

describe('UT-MINT-008: stored engine blob carries the canonical serialized terms', () => {
  beforeEach(() => setup());

  it('readTokenData on the decoded blob returns exactly the canonical terms bytes', async () => {
    await module.load();

    const request = createTestInvoice({ memo: 'test memo' });
    const result = await module.createInvoice(request);

    // Returned terms reflect the request.
    expect(result.terms.memo).toBe('test memo');
    expect(result.terms.targets).toEqual(request.targets);

    // Decode the stored blob via the SAME engine instance and read the data back.
    const added = (mocks.payments as any).addToken.mock.calls.at(-1)[0];
    const token = await engine.decodeToken(decodeTokenBlob(hexToBytes(added.sdkData)));
    const dataBytes = engine.readTokenData(token);
    expect(dataBytes).not.toBeNull();
    expect(new TextDecoder().decode(dataBytes!)).toBe(canonicalSerialize(result.terms));
  });

  it('result.token is the transmittable engine-blob hex matching the stored sdkData', async () => {
    await module.load();

    const result = await module.createInvoice(createTestInvoice());

    // v2: result.token is the engine blob as a hex string (not a TXF JSON object).
    expect(typeof result.token).toBe('string');
    const added = (mocks.payments as any).addToken.mock.calls.at(-1)[0];
    expect(added.sdkData).toBe(result.token as unknown as string);
    expect(decodeTokenBlob(hexToBytes(result.token as unknown as string)).tokenId).toBe(result.invoiceId);
  });
});
