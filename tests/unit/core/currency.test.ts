/**
 * Tests for core/currency.ts
 * Covers currency conversion utilities
 */

import { describe, it, expect } from 'vitest';
import {
  toSmallestUnit,
  toHumanReadable,
  formatAmount,
  DEFAULT_TOKEN_DECIMALS,
  CurrencyUtils,
} from '../../../core/currency';

// =============================================================================
// toSmallestUnit Tests
// =============================================================================

describe('toSmallestUnit()', () => {
  it('should convert integer amounts', () => {
    expect(toSmallestUnit('1', 18)).toBe(1000000000000000000n);
    expect(toSmallestUnit('100', 18)).toBe(100000000000000000000n);
  });

  it('should convert decimal amounts', () => {
    expect(toSmallestUnit('1.5', 18)).toBe(1500000000000000000n);
    expect(toSmallestUnit('0.1', 18)).toBe(100000000000000000n);
  });

  it('should handle different decimal places', () => {
    expect(toSmallestUnit('1.5', 6)).toBe(1500000n);
    expect(toSmallestUnit('100', 6)).toBe(100000000n);
    expect(toSmallestUnit('1.23', 2)).toBe(123n);
  });

  it('should handle number input', () => {
    expect(toSmallestUnit(1.5, 18)).toBe(1500000000000000000n);
    expect(toSmallestUnit(100, 6)).toBe(100000000n);
  });

  it('should truncate extra decimal places', () => {
    // 1.123456789012345678901 with 18 decimals should truncate to 18
    expect(toSmallestUnit('1.1234567890123456789', 18)).toBe(1123456789012345678n);
  });

  it('should pad short decimal places', () => {
    expect(toSmallestUnit('1.5', 18)).toBe(1500000000000000000n);
    expect(toSmallestUnit('1.05', 18)).toBe(1050000000000000000n);
  });

  it('should return 0n for empty/falsy input', () => {
    expect(toSmallestUnit('', 18)).toBe(0n);
    expect(toSmallestUnit(0, 18)).toBe(0n);
  });

  it('should handle zero amounts', () => {
    expect(toSmallestUnit('0', 18)).toBe(0n);
    expect(toSmallestUnit('0.0', 18)).toBe(0n);
  });

  it('should use default decimals (18)', () => {
    expect(toSmallestUnit('1')).toBe(1000000000000000000n);
  });

  it('should handle very large amounts', () => {
    expect(toSmallestUnit('1000000000', 18)).toBe(1000000000000000000000000000n);
  });

  it('should handle very small amounts', () => {
    expect(toSmallestUnit('0.000000000000000001', 18)).toBe(1n);
  });
});

// =============================================================================
// toHumanReadable Tests
// =============================================================================

describe('toHumanReadable()', () => {
  it('should convert integer values', () => {
    expect(toHumanReadable(1000000000000000000n, 18)).toBe('1');
    expect(toHumanReadable(100000000000000000000n, 18)).toBe('100');
  });

  it('should convert decimal values', () => {
    expect(toHumanReadable(1500000000000000000n, 18)).toBe('1.5');
    expect(toHumanReadable(100000000000000000n, 18)).toBe('0.1');
  });

  it('should handle different decimal places', () => {
    expect(toHumanReadable(1500000n, 6)).toBe('1.5');
    expect(toHumanReadable(100000000n, 6)).toBe('100');
    expect(toHumanReadable(123n, 2)).toBe('1.23');
  });

  it('should handle string input', () => {
    expect(toHumanReadable('1500000000000000000', 18)).toBe('1.5');
  });

  it('should strip trailing zeros in fraction', () => {
    expect(toHumanReadable(1500000000000000000n, 18)).toBe('1.5');
    expect(toHumanReadable(1000000000000000000n, 18)).toBe('1');
    expect(toHumanReadable(1010000000000000000n, 18)).toBe('1.01');
  });

  it('should handle zero', () => {
    expect(toHumanReadable(0n, 18)).toBe('0');
  });

  it('should handle very small amounts', () => {
    expect(toHumanReadable(1n, 18)).toBe('0.000000000000000001');
    expect(toHumanReadable(100n, 18)).toBe('0.0000000000000001');
  });

  it('should use default decimals (18)', () => {
    expect(toHumanReadable(1000000000000000000n)).toBe('1');
  });

  it('should handle amounts smaller than 1 unit', () => {
    expect(toHumanReadable(500000000000000000n, 18)).toBe('0.5');
  });
});

// =============================================================================
// formatAmount Tests
// =============================================================================

describe('formatAmount()', () => {
  it('should format without symbol', () => {
    expect(formatAmount(1500000000000000000n, { decimals: 18 })).toBe('1.5');
  });

  it('should format with symbol', () => {
    expect(formatAmount(1500000000000000000n, { decimals: 18, symbol: 'TOKEN' })).toBe('1.5 TOKEN');
  });

  it('should limit fraction digits', () => {
    expect(formatAmount(1123456789012345678n, {
      decimals: 18,
      maxFractionDigits: 4,
    })).toBe('1.1234');
  });

  it('should handle maxFractionDigits = 0', () => {
    expect(formatAmount(1500000000000000000n, {
      decimals: 18,
      maxFractionDigits: 0,
    })).toBe('1');
  });

  it('should not truncate if fraction is shorter than max', () => {
    expect(formatAmount(1500000000000000000n, {
      decimals: 18,
      maxFractionDigits: 10,
    })).toBe('1.5');
  });

  it('should use default decimals', () => {
    expect(formatAmount(1000000000000000000n)).toBe('1');
  });

  it('should combine symbol and maxFractionDigits', () => {
    expect(formatAmount(1123456789012345678n, {
      decimals: 18,
      symbol: 'TOKEN',
      maxFractionDigits: 2,
    })).toBe('1.12 TOKEN');
  });

  it('should handle zero with symbol', () => {
    expect(formatAmount(0n, { decimals: 18, symbol: 'TOKEN' })).toBe('0 TOKEN');
  });

  it('should handle string input', () => {
    expect(formatAmount('1500000000000000000', { decimals: 18, symbol: 'X' })).toBe('1.5 X');
  });
});

// =============================================================================
// CurrencyUtils namespace Tests
// =============================================================================

describe('CurrencyUtils namespace', () => {
  it('should export toSmallestUnit', () => {
    expect(CurrencyUtils.toSmallestUnit('1', 18)).toBe(1000000000000000000n);
  });

  it('should export toHumanReadable', () => {
    expect(CurrencyUtils.toHumanReadable(1000000000000000000n, 18)).toBe('1');
  });

  it('should export format (alias for formatAmount)', () => {
    expect(CurrencyUtils.format(1500000000000000000n, { symbol: 'TEST' })).toBe('1.5 TEST');
  });
});

// =============================================================================
// DEFAULT_TOKEN_DECIMALS Tests
// =============================================================================

describe('DEFAULT_TOKEN_DECIMALS', () => {
  it('should be 18', () => {
    expect(DEFAULT_TOKEN_DECIMALS).toBe(18);
  });
});

// =============================================================================
// Round-trip Tests
// =============================================================================

describe('Round-trip conversions', () => {
  it('should round-trip integer amounts', () => {
    const original = '123';
    const smallest = toSmallestUnit(original, 18);
    const back = toHumanReadable(smallest, 18);
    expect(back).toBe(original);
  });

  it('should round-trip decimal amounts', () => {
    const original = '1.5';
    const smallest = toSmallestUnit(original, 18);
    const back = toHumanReadable(smallest, 18);
    expect(back).toBe(original);
  });

  it('should round-trip with different decimals', () => {
    const original = '123.456';
    const smallest = toSmallestUnit(original, 6);
    const back = toHumanReadable(smallest, 6);
    expect(back).toBe(original);
  });

  it('should round-trip zero', () => {
    const original = '0';
    const smallest = toSmallestUnit(original, 18);
    const back = toHumanReadable(smallest, 18);
    expect(back).toBe(original);
  });
});
