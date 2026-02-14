/**
 * Tests for core/bech32.ts
 * Covers BIP-173 Bech32 encoding/decoding
 */

import { describe, it, expect } from 'vitest';
import {
  encodeBech32,
  decodeBech32,
  isValidBech32,
  createAddress,
  getAddressHrp,
  convertBits,
  CHARSET,
} from '../../../core/bech32';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { BECH32_VECTORS } from '../../fixtures/test-vectors';

// =============================================================================
// Bit Conversion Tests
// =============================================================================

describe('convertBits()', () => {
  it('should convert 8-bit to 5-bit with padding', () => {
    const data = [0xff, 0x00]; // [255, 0]
    const result = convertBits(data, 8, 5, true);
    expect(result).not.toBeNull();
    // 11111111 00000000 -> 11111 11100 00000 (with padding)
    expect(result).toEqual([31, 28, 0, 0]);
  });

  it('should convert 5-bit to 8-bit without padding', () => {
    const data = [31, 28, 0, 0];
    const result = convertBits(data, 5, 8, false);
    expect(result).not.toBeNull();
    expect(result).toEqual([0xff, 0x00]);
  });

  it('should return null for invalid input values', () => {
    // Value 256 is out of range for 8-bit
    const result = convertBits([256], 8, 5, true);
    expect(result).toBeNull();
  });

  it('should return null for negative values', () => {
    const result = convertBits([-1], 8, 5, true);
    expect(result).toBeNull();
  });
});

// =============================================================================
// Encode Tests
// =============================================================================

describe('encodeBech32()', () => {
  it('should encode witness program to bech32 address', () => {
    const program = new Uint8Array([
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ]);
    const address = encodeBech32('bc', 0, program);
    expect(address).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  });

  it('should encode with alpha hrp', () => {
    const program = new Uint8Array([
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ]);
    const address = encodeBech32('alpha', 0, program);
    expect(address.startsWith('alpha1q')).toBe(true);
  });

  it('should handle different witness versions', () => {
    const program = new Uint8Array(20).fill(0);
    const v0 = encodeBech32('test', 0, program);
    const v1 = encodeBech32('test', 1, program);
    expect(v0).not.toBe(v1);
    expect(v0.startsWith('test1q')).toBe(true); // v0 starts with 'q'
    expect(v1.startsWith('test1p')).toBe(true); // v1 starts with 'p'
  });

  it('should throw for invalid witness version < 0', () => {
    const program = new Uint8Array(20);
    expect(() => encodeBech32('test', -1, program)).toThrow('Invalid witness version');
  });

  it('should throw for invalid witness version > 16', () => {
    const program = new Uint8Array(20);
    expect(() => encodeBech32('test', 17, program)).toThrow('Invalid witness version');
  });

  it('should handle empty program', () => {
    const program = new Uint8Array(0);
    const address = encodeBech32('test', 0, program);
    expect(address.startsWith('test1q')).toBe(true);
  });
});

// =============================================================================
// Decode Tests
// =============================================================================

describe('decodeBech32()', () => {
  it('should decode valid bech32 address', () => {
    const result = decodeBech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(result).not.toBeNull();
    expect(result!.hrp).toBe('bc');
    expect(result!.witnessVersion).toBe(0);
    expect(result!.data).toEqual(
      new Uint8Array([
        0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
        0x23, 0xf1, 0x43, 0x3b, 0xd6,
      ])
    );
  });

  it('should decode alpha address', () => {
    // First encode an address
    const program = new Uint8Array([
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ]);
    const address = encodeBech32('alpha', 0, program);
    const result = decodeBech32(address);
    expect(result).not.toBeNull();
    expect(result!.hrp).toBe('alpha');
    expect(result!.witnessVersion).toBe(0);
    expect(result!.data).toEqual(program);
  });

  it('should handle case-insensitive decode', () => {
    const upper = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4';
    const lower = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    const mixed = 'Bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

    const resultUpper = decodeBech32(upper);
    const resultLower = decodeBech32(lower);
    const resultMixed = decodeBech32(mixed);

    expect(resultUpper!.hrp).toBe('bc');
    expect(resultLower!.hrp).toBe('bc');
    expect(resultMixed!.hrp).toBe('bc');
  });

  it('should return null for missing separator', () => {
    const result = decodeBech32('bcqw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    expect(result).toBeNull();
  });

  it('should return null for invalid checksum', () => {
    // Changed last character
    const result = decodeBech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5');
    expect(result).toBeNull();
  });

  it('should return null for invalid characters', () => {
    // 'b' is not in bech32 charset
    const result = decodeBech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3tb');
    expect(result).toBeNull();
  });

  it('should return null for empty HRP', () => {
    const result = decodeBech32('1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
    expect(result).toBeNull();
  });
});

// =============================================================================
// Round-trip Tests
// =============================================================================

describe('Encode/Decode Round-trip', () => {
  it('should round-trip for various programs', () => {
    const testCases = [
      { hrp: 'alpha', version: 0, program: new Uint8Array(20).fill(0) },
      { hrp: 'alpha', version: 0, program: new Uint8Array(20).fill(0xff) },
      { hrp: 'bc', version: 1, program: new Uint8Array(32).fill(0xab) },
      { hrp: 'test', version: 0, program: new Uint8Array(20).map((_, i) => i) },
    ];

    for (const tc of testCases) {
      const encoded = encodeBech32(tc.hrp, tc.version, tc.program);
      const decoded = decodeBech32(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.hrp).toBe(tc.hrp);
      expect(decoded!.witnessVersion).toBe(tc.version);
      expect(decoded!.data).toEqual(tc.program);
    }
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe('isValidBech32()', () => {
  it('should return true for valid addresses', () => {
    expect(isValidBech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
  });

  it('should return false for invalid addresses', () => {
    expect(isValidBech32('')).toBe(false);
    expect(isValidBech32('notabech32address')).toBe(false);
    expect(isValidBech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBe(false); // bad checksum
  });

  it('should validate alpha addresses', () => {
    const program = new Uint8Array(20).fill(0xab);
    const address = encodeBech32('alpha', 0, program);
    expect(isValidBech32(address)).toBe(true);
  });
});

// =============================================================================
// createAddress Tests
// =============================================================================

describe('createAddress()', () => {
  it('should create address from Uint8Array', () => {
    const hash = new Uint8Array(20).fill(0xab);
    const address = createAddress('alpha', hash);
    expect(address.startsWith('alpha1p')).toBe(true); // witness version 1
    expect(isValidBech32(address)).toBe(true);
  });

  it('should create address from hex string', () => {
    const hash = 'abababababababababababababababababababab';
    const address = createAddress('alpha', hash);
    expect(address.startsWith('alpha1p')).toBe(true);
    expect(isValidBech32(address)).toBe(true);
  });

  it('should create identical addresses from Uint8Array and hex string', () => {
    const hashHex = '751e76e8199196d454941c45d1b3a323f1433bd6';
    const hashBytes = new Uint8Array([
      0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3,
      0x23, 0xf1, 0x43, 0x3b, 0xd6,
    ]);

    const addressFromHex = createAddress('alpha', hashHex);
    const addressFromBytes = createAddress('alpha', hashBytes);
    expect(addressFromHex).toBe(addressFromBytes);
  });
});

// =============================================================================
// getAddressHrp Tests
// =============================================================================

describe('getAddressHrp()', () => {
  it('should extract HRP from valid address', () => {
    expect(getAddressHrp('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe('bc');
    expect(getAddressHrp('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7')).toBe(
      'tb'
    );
  });

  it('should return null for invalid address', () => {
    expect(getAddressHrp('invalid')).toBeNull();
  });

  it('should extract HRP from alpha address', () => {
    const program = new Uint8Array(20).fill(0xab);
    const address = encodeBech32('alpha', 0, program);
    expect(getAddressHrp(address)).toBe('alpha');
  });
});

// =============================================================================
// Charset Tests
// =============================================================================

describe('CHARSET', () => {
  it('should contain 32 characters', () => {
    expect(CHARSET).toHaveLength(32);
  });

  // Note: Bech32 charset is different from Base58 - it DOES contain 0
  // The excluded characters are: 1, b, i, o (to avoid confusion)
  it('should not contain confusing characters (1, b, i, o uppercase)', () => {
    expect(CHARSET).not.toContain('1');
    expect(CHARSET).not.toContain('b');
    expect(CHARSET).not.toContain('i');
    expect(CHARSET).not.toContain('o');
    expect(CHARSET).not.toContain('O');
    expect(CHARSET).not.toContain('I');
  });

  it('should be all lowercase', () => {
    expect(CHARSET).toBe(CHARSET.toLowerCase());
  });
});
