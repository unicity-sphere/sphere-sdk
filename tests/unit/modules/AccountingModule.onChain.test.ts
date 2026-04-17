/**
 * AccountingModule — On-chain message encoding/decoding tests (UT-ONCHAIN)
 *
 * Tests encodeTransferMessage / decodeTransferMessage round-trip, forward and
 * return payment parsing, invalid JSON handling, missing fields, and forward
 * compatibility (extra fields ignored).
 *
 * @see docs/ACCOUNTING-TEST-SPEC.md §4 (memo encoding)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  encodeTransferMessage,
  decodeTransferMessage,
} from '../../../modules/accounting/memo.js';
import type { TransferMessagePayload } from '../../../modules/accounting/types.js';

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// encodeTransferMessage produces valid JSON bytes
// =============================================================================

describe('encodeTransferMessage: produces valid JSON bytes', () => {
  it('returns non-empty Uint8Array for a valid payload', () => {
    const payload: TransferMessagePayload = {
      inv: { id: 'a'.repeat(64), dir: 'F' },
    };

    const bytes = encodeTransferMessage(payload);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    // Should be valid JSON
    const text = new TextDecoder().decode(bytes);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

// =============================================================================
// decodeTransferMessage: parses forward payment
// =============================================================================

describe('decodeTransferMessage: parses forward payment', () => {
  it('decodes a forward payment payload', () => {
    const payload: TransferMessagePayload = {
      inv: { id: 'a'.repeat(64), dir: 'F' },
    };
    const bytes = encodeTransferMessage(payload);

    const result = decodeTransferMessage(bytes);
    expect(result).not.toBeNull();
    expect(result!.inv).toBeDefined();
    expect(result!.inv!.id).toBe('a'.repeat(64));
    expect(result!.inv!.dir).toBe('F');
  });
});

// =============================================================================
// decodeTransferMessage: parses return payment
// =============================================================================

describe('decodeTransferMessage: parses return payment', () => {
  it('decodes a back (B) payment payload', () => {
    const payload: TransferMessagePayload = {
      inv: { id: 'b'.repeat(64), dir: 'B' },
    };
    const bytes = encodeTransferMessage(payload);

    const result = decodeTransferMessage(bytes);
    expect(result).not.toBeNull();
    expect(result!.inv!.dir).toBe('B');
  });

  it('decodes a return-closed (RC) payment payload', () => {
    const payload: TransferMessagePayload = {
      inv: { id: 'c'.repeat(64), dir: 'RC' },
    };
    const bytes = encodeTransferMessage(payload);

    const result = decodeTransferMessage(bytes);
    expect(result).not.toBeNull();
    expect(result!.inv!.dir).toBe('RC');
  });

  it('decodes a return-cancelled (RX) payment payload', () => {
    const payload: TransferMessagePayload = {
      inv: { id: 'd'.repeat(64), dir: 'RX' },
    };
    const bytes = encodeTransferMessage(payload);

    const result = decodeTransferMessage(bytes);
    expect(result).not.toBeNull();
    expect(result!.inv!.dir).toBe('RX');
  });
});

// =============================================================================
// Round-trip encode → decode preserves payload
// =============================================================================

describe('encodeTransferMessage → decodeTransferMessage round-trip', () => {
  it('preserves forward payment with all fields', () => {
    const payload: TransferMessagePayload = {
      inv: {
        id: 'a'.repeat(64),
        dir: 'F',
        ra: 'DIRECT://refund_address_abc',
        ct: { a: 'DIRECT://contact_address_def', u: 'https://example.com/pay' },
      },
      txt: 'Hello world',
    };

    const bytes = encodeTransferMessage(payload);
    const result = decodeTransferMessage(bytes);

    expect(result).not.toBeNull();
    expect(result!.inv!.id).toBe('a'.repeat(64));
    expect(result!.inv!.dir).toBe('F');
    expect(result!.inv!.ra).toBe('DIRECT://refund_address_abc');
    expect(result!.inv!.ct!.a).toBe('DIRECT://contact_address_def');
    expect(result!.inv!.ct!.u).toBe('https://example.com/pay');
    expect(result!.txt).toBe('Hello world');
  });

  it('preserves payload with only txt field', () => {
    const payload: TransferMessagePayload = {
      txt: 'Just a text message',
    };

    const bytes = encodeTransferMessage(payload);
    const result = decodeTransferMessage(bytes);

    expect(result).not.toBeNull();
    expect(result!.inv).toBeUndefined();
    expect(result!.txt).toBe('Just a text message');
  });
});

// =============================================================================
// Invalid JSON returns null
// =============================================================================

describe('decodeTransferMessage: invalid input returns null', () => {
  it('returns null for null input', () => {
    expect(decodeTransferMessage(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(decodeTransferMessage(undefined)).toBeNull();
  });

  it('returns null for empty Uint8Array', () => {
    expect(decodeTransferMessage(new Uint8Array(0))).toBeNull();
  });

  it('returns null for non-JSON bytes', () => {
    const garbage = new TextEncoder().encode('this is not JSON!!!');
    expect(decodeTransferMessage(garbage)).toBeNull();
  });

  it('returns null for JSON array', () => {
    const arrayBytes = new TextEncoder().encode('[1,2,3]');
    expect(decodeTransferMessage(arrayBytes)).toBeNull();
  });

  it('returns null for JSON string', () => {
    const stringBytes = new TextEncoder().encode('"hello"');
    expect(decodeTransferMessage(stringBytes)).toBeNull();
  });
});

// =============================================================================
// Missing inv field returns null (if no txt either)
// =============================================================================

describe('decodeTransferMessage: missing inv and txt returns null', () => {
  it('returns null when object has no inv or txt field', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ foo: 'bar' }));
    expect(decodeTransferMessage(bytes)).toBeNull();
  });
});

// =============================================================================
// inv with invalid id returns null
// =============================================================================

describe('decodeTransferMessage: invalid inv.id returns null', () => {
  it('returns null when inv.id is not 64 hex chars', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      inv: { id: 'short', dir: 'F' },
    }));
    expect(decodeTransferMessage(bytes)).toBeNull();
  });

  it('returns null when inv.id is not a string', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      inv: { id: 12345, dir: 'F' },
    }));
    expect(decodeTransferMessage(bytes)).toBeNull();
  });
});

// =============================================================================
// Extra fields are ignored (forward compatible)
// =============================================================================

describe('decodeTransferMessage: extra fields are ignored', () => {
  it('ignores unknown top-level fields', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      inv: { id: 'a'.repeat(64), dir: 'F' },
      unknownField: 'should be ignored',
      anotherField: 42,
    }));

    const result = decodeTransferMessage(bytes);
    expect(result).not.toBeNull();
    expect(result!.inv!.id).toBe('a'.repeat(64));
    // Unknown fields should not appear in result
    expect((result as any).unknownField).toBeUndefined();
    expect((result as any).anotherField).toBeUndefined();
  });

  it('ignores unknown fields within inv', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      inv: { id: 'b'.repeat(64), dir: 'B', futureField: true },
    }));

    const result = decodeTransferMessage(bytes);
    expect(result).not.toBeNull();
    expect(result!.inv!.dir).toBe('B');
  });
});
