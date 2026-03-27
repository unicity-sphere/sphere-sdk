/**
 * Tests for uxf/types.ts
 * Covers contentHash branded type, ELEMENT_TYPE_IDS map, and strategy constants.
 */

import { describe, it, expect } from 'vitest';
import {
  contentHash,
  ELEMENT_TYPE_IDS,
  STRATEGY_LATEST,
  STRATEGY_ORIGINAL,
} from '../../../uxf/types';
import { UxfError } from '../../../uxf/errors';

// =============================================================================
// contentHash
// =============================================================================

describe('contentHash', () => {
  it('accepts valid 64-char lowercase hex', () => {
    const result = contentHash('a'.repeat(64));
    expect(result).toBe('a'.repeat(64));
  });

  it('accepts mixed valid hex characters', () => {
    const hex = '0123456789abcdef'.repeat(4);
    const result = contentHash(hex);
    expect(result).toBe(hex);
  });

  it('rejects uppercase hex', () => {
    expect(() => contentHash('A'.repeat(64))).toThrow(UxfError);
    try {
      contentHash('A'.repeat(64));
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects mixed case hex', () => {
    expect(() => contentHash('aA'.repeat(32))).toThrow(UxfError);
    try {
      contentHash('aA'.repeat(32));
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects wrong length (too short)', () => {
    expect(() => contentHash('abcd')).toThrow(UxfError);
    try {
      contentHash('abcd');
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects wrong length (too long)', () => {
    expect(() => contentHash('a'.repeat(65))).toThrow(UxfError);
    try {
      contentHash('a'.repeat(65));
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects empty string', () => {
    expect(() => contentHash('')).toThrow(UxfError);
    try {
      contentHash('');
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects non-hex characters', () => {
    expect(() => contentHash('g'.repeat(64))).toThrow(UxfError);
    try {
      contentHash('g'.repeat(64));
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects string with spaces', () => {
    expect(() => contentHash(' ' + 'a'.repeat(63))).toThrow(UxfError);
    try {
      contentHash(' ' + 'a'.repeat(63));
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });
});

// =============================================================================
// ELEMENT_TYPE_IDS
// =============================================================================

describe('ELEMENT_TYPE_IDS', () => {
  it('has exactly 12 entries', () => {
    expect(Object.keys(ELEMENT_TYPE_IDS)).toHaveLength(12);
  });

  it('maps token-root to 0x01', () => {
    expect(ELEMENT_TYPE_IDS['token-root']).toBe(0x01);
  });

  it('maps genesis to 0x02', () => {
    expect(ELEMENT_TYPE_IDS['genesis']).toBe(0x02);
  });

  it('maps transaction to 0x03', () => {
    expect(ELEMENT_TYPE_IDS['transaction']).toBe(0x03);
  });

  it('maps genesis-data to 0x04', () => {
    expect(ELEMENT_TYPE_IDS['genesis-data']).toBe(0x04);
  });

  it('maps transaction-data to 0x05', () => {
    expect(ELEMENT_TYPE_IDS['transaction-data']).toBe(0x05);
  });

  it('maps token-state to 0x06', () => {
    expect(ELEMENT_TYPE_IDS['token-state']).toBe(0x06);
  });

  it('maps predicate to 0x07', () => {
    expect(ELEMENT_TYPE_IDS['predicate']).toBe(0x07);
  });

  it('maps inclusion-proof to 0x08', () => {
    expect(ELEMENT_TYPE_IDS['inclusion-proof']).toBe(0x08);
  });

  it('maps authenticator to 0x09', () => {
    expect(ELEMENT_TYPE_IDS['authenticator']).toBe(0x09);
  });

  it('maps unicity-certificate to 0x0a', () => {
    expect(ELEMENT_TYPE_IDS['unicity-certificate']).toBe(0x0a);
  });

  it('maps token-coin-data to 0x0c', () => {
    expect(ELEMENT_TYPE_IDS['token-coin-data']).toBe(0x0c);
  });

  it('maps smt-path to 0x0d', () => {
    expect(ELEMENT_TYPE_IDS['smt-path']).toBe(0x0d);
  });

  it('all type IDs are unique', () => {
    const values = Object.values(ELEMENT_TYPE_IDS);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(12);
  });
});

// =============================================================================
// STRATEGY_LATEST / STRATEGY_ORIGINAL
// =============================================================================

describe('STRATEGY_LATEST / STRATEGY_ORIGINAL', () => {
  it('STRATEGY_LATEST has type latest', () => {
    expect(STRATEGY_LATEST).toEqual({ type: 'latest' });
  });

  it('STRATEGY_ORIGINAL has type original', () => {
    expect(STRATEGY_ORIGINAL).toEqual({ type: 'original' });
  });
});
