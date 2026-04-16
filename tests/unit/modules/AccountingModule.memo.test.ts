/**
 * Unit tests for pure memo utility functions in modules/accounting/memo.ts.
 *
 * UT-MEMO-001 – UT-MEMO-011 (11 tests)
 *
 * All functions under test are pure (no side effects, no module state).
 * Tests do NOT require a module instance.
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §3.12
 */

import { describe, it, expect } from 'vitest';
import {
  parseInvoiceMemo,
  buildInvoiceMemo,
  decodeTransferMessage,
  encodeTransferMessage,
  hashInvoiceId,
} from '../../../modules/accounting/memo.js';
import { SphereError } from '../../../core/errors.js';
import type { TransferMessagePayload } from '../../../modules/accounting/types.js';

// =============================================================================
// Fixtures
// =============================================================================

/** A valid 64-char lowercase hex invoice ID used across all tests. */
const VALID_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

// =============================================================================
// Tests
// =============================================================================

describe('AccountingModule Memo Utilities', () => {
  // UT-MEMO-001
  it('UT-MEMO-001: parseInvoiceMemo parses valid forward (F) direction with freeText', () => {
    const result = parseInvoiceMemo(`INV:${VALID_ID}:F Payment for consulting`);

    expect(result).not.toBeNull();
    expect(result!.invoiceId).toBe(VALID_ID);
    expect(result!.paymentDirection).toBe('forward');
    expect(result!.freeText).toBe('Payment for consulting');
  });

  // UT-MEMO-002
  it('UT-MEMO-002: parseInvoiceMemo parses valid back (B) direction', () => {
    const result = parseInvoiceMemo(`INV:${VALID_ID}:B`);

    expect(result).not.toBeNull();
    expect(result!.invoiceId).toBe(VALID_ID);
    expect(result!.paymentDirection).toBe('back');
    expect(result!.freeText).toBeUndefined();
  });

  // UT-MEMO-003
  it('UT-MEMO-003: parseInvoiceMemo parses valid return_closed (RC) direction', () => {
    const result = parseInvoiceMemo(`INV:${VALID_ID}:RC`);

    expect(result).not.toBeNull();
    expect(result!.invoiceId).toBe(VALID_ID);
    expect(result!.paymentDirection).toBe('return_closed');
  });

  // UT-MEMO-004
  it('UT-MEMO-004: parseInvoiceMemo parses valid return_cancelled (RX) direction', () => {
    const result = parseInvoiceMemo(`INV:${VALID_ID}:RX`);

    expect(result).not.toBeNull();
    expect(result!.invoiceId).toBe(VALID_ID);
    expect(result!.paymentDirection).toBe('return_cancelled');
  });

  // UT-MEMO-005
  it('UT-MEMO-005: parseInvoiceMemo captures freeText after the direction code', () => {
    const result = parseInvoiceMemo(`INV:${VALID_ID}:F order #1234`);

    expect(result).not.toBeNull();
    expect(result!.freeText).toBe('order #1234');
  });

  // UT-MEMO-006
  it('UT-MEMO-006: parseInvoiceMemo with missing direction code defaults to forward', () => {
    // Direction code is optional per spec §4.5 — absent → 'forward'
    // The regex requires a colon after the ID to match, so 'INV:<id>' without
    // direction may return null depending on the regex. Either result is
    // acceptable as long as when it does match, paymentDirection === 'forward'.
    const result = parseInvoiceMemo(`INV:${VALID_ID}`);

    // Direction group is optional in the regex — omitted direction defaults to 'forward'
    expect(result).not.toBeNull();
    expect(result!.invoiceId).toBe(VALID_ID.toLowerCase());
    expect(result!.paymentDirection).toBe('forward');
  });

  // UT-MEMO-007
  it('UT-MEMO-007: parseInvoiceMemo returns null for non-INV memo prefix', () => {
    const result = parseInvoiceMemo('Regular transfer memo — not an invoice reference');

    expect(result).toBeNull();
  });

  // UT-MEMO-008: buildInvoiceMemo now uses SHA-256 hash for privacy
  it('UT-MEMO-008: buildInvoiceMemo embeds hashed invoice ID (not raw)', () => {
    const memo = buildInvoiceMemo(VALID_ID, 'F');
    const expectedHash = hashInvoiceId(VALID_ID);

    expect(memo).toBe(`INV:${expectedHash}:F`);
    expect(memo).not.toContain(VALID_ID);
  });

  it('hashInvoiceId produces 64-char lowercase hex', () => {
    const hash = hashInvoiceId(VALID_ID);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashInvoiceId is deterministic', () => {
    expect(hashInvoiceId(VALID_ID)).toBe(hashInvoiceId(VALID_ID));
  });

  it('hashInvoiceId normalizes case before hashing', () => {
    const upper = VALID_ID.toUpperCase();
    expect(hashInvoiceId(upper)).toBe(hashInvoiceId(VALID_ID));
  });

  it('hashInvoiceId produces different hashes for different IDs', () => {
    const other = 'b'.repeat(64);
    expect(hashInvoiceId(VALID_ID)).not.toBe(hashInvoiceId(other));
  });

  it('buildInvoiceMemo output is parseable by parseInvoiceMemo', () => {
    const memo = buildInvoiceMemo(VALID_ID, 'B', 'some text');
    const parsed = parseInvoiceMemo(memo);

    expect(parsed).not.toBeNull();
    expect(parsed!.invoiceId).toBe(hashInvoiceId(VALID_ID));
    expect(parsed!.paymentDirection).toBe('back');
    expect(parsed!.freeText).toBe('some text');
  });

  // UT-MEMO-009
  it('UT-MEMO-009: buildInvoiceMemo throws INVOICE_INVALID_ID for invalid invoice ID', () => {
    expect(() => buildInvoiceMemo('short', 'F')).toThrow(SphereError);
    expect(() => buildInvoiceMemo('short', 'F')).toThrow(
      expect.objectContaining({ code: 'INVOICE_INVALID_ID' }),
    );

    // Also verify with empty string
    expect(() => buildInvoiceMemo('', 'F')).toThrow(
      expect.objectContaining({ code: 'INVOICE_INVALID_ID' }),
    );
  });

  // UT-MEMO-010
  it('UT-MEMO-010: decodeTransferMessage decodes a valid TransferMessagePayload', () => {
    const payload: TransferMessagePayload = {
      inv: { id: VALID_ID, dir: 'F' },
    };
    const bytes = encodeTransferMessage(payload);
    const result = decodeTransferMessage(bytes);

    expect(result).not.toBeNull();
    expect(result!.inv).toBeDefined();
    expect(result!.inv!.id).toBe(VALID_ID);
    expect(result!.inv!.dir).toBe('F');
  });

  // UT-MEMO-011
  it('UT-MEMO-011: decodeTransferMessage returns null for malformed JSON bytes', () => {
    const malformedBytes = new TextEncoder().encode('{not : valid json{{{{');
    const result = decodeTransferMessage(malformedBytes);

    expect(result).toBeNull();
  });
});
