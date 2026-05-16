/**
 * Direct unit tests for core/hex.ts (steelman³⁵).
 *
 * Pre-F.40 the strict-rejection branches were untested — coverage was
 * incidental via callers feeding only valid input. These tests pin the
 * documented contract so future maintainers cannot loosen the gates.
 */

import { describe, expect, it } from 'vitest';
import { hexToBytes, hexToBytesAllowEmpty, bytesToHex } from '../../../core/hex';

describe('core/hex.ts strict decoders', () => {
  describe('hexToBytes (strict)', () => {
    it('decodes valid lowercase hex', () => {
      expect(Array.from(hexToBytes('00ff'))).toEqual([0x00, 0xff]);
      expect(Array.from(hexToBytes('deadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('decodes valid uppercase hex', () => {
      expect(Array.from(hexToBytes('DEADBEEF'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('decodes mixed-case hex', () => {
      expect(Array.from(hexToBytes('DeAdBeEf'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('rejects empty string', () => {
      expect(() => hexToBytes('')).toThrow(/empty hex string/);
    });

    it('rejects odd-length input', () => {
      expect(() => hexToBytes('abc')).toThrow(/odd-length/);
      expect(() => hexToBytes('a')).toThrow(/odd-length/);
    });

    it('rejects non-hex characters', () => {
      // Each input must be EVEN length so the odd-length check doesn't fire first.
      expect(() => hexToBytes('zz')).toThrow(/non-hex characters/);
      expect(() => hexToBytes('00gg')).toThrow(/non-hex characters/);
      expect(() => hexToBytes('0x00')).toThrow(/non-hex characters/);
      expect(() => hexToBytes('  00')).toThrow(/non-hex characters/);
    });

    it('rejects non-string input', () => {
      // Test the runtime guard since callers MAY come from `unknown`-typed sources.
      expect(() => hexToBytes(undefined as unknown as string)).toThrow(TypeError);
      expect(() => hexToBytes(null as unknown as string)).toThrow(TypeError);
      expect(() => hexToBytes(123 as unknown as string)).toThrow(TypeError);
    });
  });

  describe('hexToBytesAllowEmpty', () => {
    it('decodes valid hex same as strict variant', () => {
      expect(Array.from(hexToBytesAllowEmpty('00ff'))).toEqual([0x00, 0xff]);
    });

    it('returns 0-byte Uint8Array for empty string', () => {
      const out = hexToBytesAllowEmpty('');
      expect(out).toBeInstanceOf(Uint8Array);
      expect(out.length).toBe(0);
    });

    it('rejects odd-length input', () => {
      expect(() => hexToBytesAllowEmpty('abc')).toThrow(/odd-length/);
    });

    it('rejects non-hex characters', () => {
      expect(() => hexToBytesAllowEmpty('zz')).toThrow(/non-hex characters/);
    });

    it('rejects non-string input', () => {
      expect(() => hexToBytesAllowEmpty(null as unknown as string)).toThrow(TypeError);
    });
  });

  describe('bytesToHex', () => {
    it('encodes Uint8Array to lowercase hex', () => {
      expect(bytesToHex(new Uint8Array([0x00, 0xff, 0xab, 0xcd]))).toBe('00ffabcd');
    });

    it('encodes empty Uint8Array to empty string', () => {
      expect(bytesToHex(new Uint8Array(0))).toBe('');
    });

    it('round-trips with hexToBytes', () => {
      const sample = new Uint8Array(32);
      for (let i = 0; i < 32; i++) sample[i] = i * 7 & 0xff;
      const hex = bytesToHex(sample);
      const back = hexToBytes(hex);
      expect(back).toEqual(sample);
    });
  });
});
