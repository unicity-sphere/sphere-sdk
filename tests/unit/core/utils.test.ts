/**
 * Tests for core/utils.ts
 * Covers SDK utility functions
 */

import { describe, it, expect } from 'vitest';
import {
  isValidPrivateKey,
  base58Encode,
  base58Decode,
  findPattern,
  extractFromText,
  randomHex,
  randomUUID,
} from '../../../core/utils';

// =============================================================================
// isValidPrivateKey Tests
// =============================================================================

describe('isValidPrivateKey()', () => {
  it('should accept valid private key', () => {
    // A valid 64-hex-char private key
    const validKey = 'a'.repeat(64);
    expect(isValidPrivateKey(validKey)).toBe(true);
  });

  it('should accept typical private keys', () => {
    expect(isValidPrivateKey('0000000000000000000000000000000000000000000000000000000000000001')).toBe(true);
    expect(isValidPrivateKey('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140')).toBe(true);
  });

  it('should reject zero key', () => {
    const zeroKey = '0'.repeat(64);
    expect(isValidPrivateKey(zeroKey)).toBe(false);
  });

  it('should reject key >= curve order', () => {
    // Curve order is FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    // Key equal to curve order should be invalid
    expect(isValidPrivateKey('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')).toBe(false);
    // Key greater than curve order should also be invalid
    expect(isValidPrivateKey('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364142')).toBe(false);
  });

  it('should reject keys with wrong length', () => {
    expect(isValidPrivateKey('a'.repeat(63))).toBe(false); // Too short
    expect(isValidPrivateKey('a'.repeat(65))).toBe(false); // Too long
    expect(isValidPrivateKey('')).toBe(false); // Empty
  });

  it('should reject non-hex characters', () => {
    expect(isValidPrivateKey('g'.repeat(64))).toBe(false);
    expect(isValidPrivateKey('abcdef' + 'x' + 'a'.repeat(57))).toBe(false);
    expect(isValidPrivateKey('a'.repeat(32) + ' ' + 'a'.repeat(31))).toBe(false);
  });

  it('should accept uppercase and lowercase hex', () => {
    expect(isValidPrivateKey('ABCDEF' + '1'.repeat(58))).toBe(true);
    expect(isValidPrivateKey('abcdef' + '1'.repeat(58))).toBe(true);
    expect(isValidPrivateKey('AbCdEf' + '1'.repeat(58))).toBe(true);
  });
});

// =============================================================================
// base58Encode Tests
// =============================================================================

describe('base58Encode()', () => {
  it('should encode simple hex values', () => {
    // 00 in hex encodes to '1' in base58
    expect(base58Encode('00')).toBe('1');
    // Multiple leading zeros = multiple 1s
    expect(base58Encode('0000')).toBe('11');
  });

  it('should encode known values', () => {
    // Small hex values
    expect(base58Encode('01')).toBe('2');
    expect(base58Encode('39')).toBe('z'); // 57 decimal = 'z' in base58
  });

  it('should handle larger values', () => {
    // 0x100 = 256 = 4*58 + 24 = '4R' or similar
    const result = base58Encode('0100');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/); // Valid base58 chars
  });

  it('should preserve leading zero bytes as 1s', () => {
    const hex = '000001';
    const encoded = base58Encode(hex);
    expect(encoded.startsWith('11')).toBe(true); // Two leading zeros = two 1s
  });
});

// =============================================================================
// base58Decode Tests
// =============================================================================

describe('base58Decode()', () => {
  it('should decode single 1 to zero byte', () => {
    const result = base58Decode('1');
    expect(result).toEqual(new Uint8Array([0]));
  });

  it('should decode multiple 1s to multiple zero bytes', () => {
    const result = base58Decode('111');
    expect(result).toEqual(new Uint8Array([0, 0, 0]));
  });

  it('should decode simple values', () => {
    const result = base58Decode('2');
    expect(result).toEqual(new Uint8Array([1]));
  });

  it('should throw on invalid base58 characters', () => {
    expect(() => base58Decode('0')).toThrow('Invalid base58 character: 0');
    expect(() => base58Decode('O')).toThrow('Invalid base58 character: O');
    expect(() => base58Decode('I')).toThrow('Invalid base58 character: I');
    expect(() => base58Decode('l')).toThrow('Invalid base58 character: l');
    expect(() => base58Decode('+')).toThrow('Invalid base58 character: +');
  });

  it('should round-trip with encode', () => {
    const original = 'deadbeef';
    const encoded = base58Encode(original);
    const decoded = base58Decode(encoded);
    // Convert decoded back to hex
    const decodedHex = Array.from(decoded)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    expect(decodedHex).toBe(original);
  });

  it('should round-trip with leading zeros', () => {
    const original = '0000deadbeef';
    const encoded = base58Encode(original);
    const decoded = base58Decode(encoded);
    const decodedHex = Array.from(decoded)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    expect(decodedHex).toBe(original);
  });
});

// =============================================================================
// findPattern Tests
// =============================================================================

describe('findPattern()', () => {
  it('should find pattern at beginning', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const pattern = new Uint8Array([1, 2]);
    expect(findPattern(data, pattern)).toBe(0);
  });

  it('should find pattern in middle', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const pattern = new Uint8Array([3, 4]);
    expect(findPattern(data, pattern)).toBe(2);
  });

  it('should find pattern at end', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const pattern = new Uint8Array([4, 5]);
    expect(findPattern(data, pattern)).toBe(3);
  });

  it('should return -1 when pattern not found', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const pattern = new Uint8Array([6, 7]);
    expect(findPattern(data, pattern)).toBe(-1);
  });

  it('should respect startIndex', () => {
    const data = new Uint8Array([1, 2, 1, 2, 3]);
    const pattern = new Uint8Array([1, 2]);
    expect(findPattern(data, pattern, 0)).toBe(0);
    expect(findPattern(data, pattern, 1)).toBe(2);
  });

  it('should find single-byte pattern', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const pattern = new Uint8Array([3]);
    expect(findPattern(data, pattern)).toBe(2);
  });

  it('should handle pattern equal to data', () => {
    const data = new Uint8Array([1, 2, 3]);
    const pattern = new Uint8Array([1, 2, 3]);
    expect(findPattern(data, pattern)).toBe(0);
  });

  it('should return -1 if pattern longer than data', () => {
    const data = new Uint8Array([1, 2]);
    const pattern = new Uint8Array([1, 2, 3, 4]);
    expect(findPattern(data, pattern)).toBe(-1);
  });

  it('should handle empty data', () => {
    const data = new Uint8Array(0);
    const pattern = new Uint8Array([1]);
    expect(findPattern(data, pattern)).toBe(-1);
  });

  it('should handle empty pattern', () => {
    const data = new Uint8Array([1, 2, 3]);
    const pattern = new Uint8Array(0);
    expect(findPattern(data, pattern)).toBe(0); // Empty pattern found immediately
  });
});

// =============================================================================
// extractFromText Tests
// =============================================================================

describe('extractFromText()', () => {
  it('should extract value with capture group', () => {
    const text = 'Name: John Doe';
    const pattern = /Name:\s*(.+)/;
    expect(extractFromText(text, pattern)).toBe('John Doe');
  });

  it('should return null when pattern does not match', () => {
    const text = 'No match here';
    const pattern = /Name:\s*(.+)/;
    expect(extractFromText(text, pattern)).toBeNull();
  });

  it('should trim whitespace from captured value', () => {
    const text = 'Value:   test   ';
    const pattern = /Value:\s*(.+)/;
    expect(extractFromText(text, pattern)).toBe('test');
  });

  it('should work with complex patterns', () => {
    const text = 'Private Key: abc123def456';
    const pattern = /Private Key:\s*([a-f0-9]+)/;
    expect(extractFromText(text, pattern)).toBe('abc123def456');
  });

  it('should return null if no capture group', () => {
    const text = 'test value';
    const pattern = /test/; // No capture group
    expect(extractFromText(text, pattern)).toBeNull();
  });

  it('should return first capture group only', () => {
    const text = 'a: 1, b: 2';
    const pattern = /a:\s*(\d+).*b:\s*(\d+)/;
    expect(extractFromText(text, pattern)).toBe('1'); // First group only
  });
});

// =============================================================================
// randomHex Tests
// =============================================================================

describe('randomHex()', () => {
  it('should generate hex of correct length', () => {
    const hex16 = randomHex(16);
    expect(hex16.length).toBe(32); // 16 bytes = 32 hex chars

    const hex32 = randomHex(32);
    expect(hex32.length).toBe(64); // 32 bytes = 64 hex chars
  });

  it('should generate valid hex characters only', () => {
    const hex = randomHex(32);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('should generate different values each time', () => {
    const hex1 = randomHex(32);
    const hex2 = randomHex(32);
    expect(hex1).not.toBe(hex2); // Very unlikely to be equal
  });

  it('should handle small byte lengths', () => {
    const hex1 = randomHex(1);
    expect(hex1.length).toBe(2);
  });
});

// =============================================================================
// randomUUID Tests
// =============================================================================

describe('randomUUID()', () => {
  it('should generate valid UUID v4 format', () => {
    const uuid = randomUUID();
    // UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should generate different UUIDs each time', () => {
    const uuid1 = randomUUID();
    const uuid2 = randomUUID();
    expect(uuid1).not.toBe(uuid2);
  });

  it('should have correct length (36 characters with hyphens)', () => {
    const uuid = randomUUID();
    expect(uuid.length).toBe(36);
  });
});
