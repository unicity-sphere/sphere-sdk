/**
 * S6 field encryption (ARCHITECTURE §8.3): wallet-key-derived key, XChaCha20-
 * Poly1305 envelope `"enc1." + base64(nonce ‖ ciphertext)`, server-shape check.
 */

import { describe, it, expect } from 'vitest';
import {
  assertFieldEnvelopeShape,
  decryptField,
  decryptFieldBytes,
  deriveFieldEncryptionKey,
  encryptField,
  encryptFieldBytes,
  FIELD_ENVELOPE_MAX_BYTES,
  FIELD_ENVELOPE_PREFIX,
} from '../../../core/field-encryption';
import { SphereError } from '../../../core/errors';

const PRIV_A = '11'.repeat(32);
const PRIV_B = '22'.repeat(32);

describe('field-encryption (S6)', () => {
  it('round-trips a plaintext field', () => {
    const key = deriveFieldEncryptionKey(PRIV_A);
    const plaintext = 'memo with unicode — ✓ €1 000 000 and emoji 🜚';
    const envelope = encryptField(key, plaintext);
    expect(decryptField(key, envelope)).toBe(plaintext);
  });

  it('produces the exact wire form "enc1." + base64(nonce ‖ ciphertext)', () => {
    const key = deriveFieldEncryptionKey(PRIV_A);
    const envelope = encryptField(key, 'hello');
    expect(envelope.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
    const b64 = envelope.slice(FIELD_ENVELOPE_PREFIX.length);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // nonce (24) + ciphertext (≥ plaintext + 16-byte tag)
    const decodedLen = Math.floor((b64.length / 4) * 3) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    expect(decodedLen).toBe(24 + 'hello'.length + 16);
  });

  it('the stored bytes are not plaintext, and nonces are random per call', () => {
    const key = deriveFieldEncryptionKey(PRIV_A);
    const e1 = encryptField(key, 'same plaintext');
    const e2 = encryptField(key, 'same plaintext');
    expect(e1).not.toContain('same plaintext');
    expect(e1).not.toBe(e2); // random 24-byte nonce per envelope
  });

  it('two key derivations from the same privkey decrypt each other (multi-device)', () => {
    // Deterministic per wallet (HKDF, info "sphere-fieldenc-v1") — any of the
    // owner's devices derives the same key from the seed.
    const deviceA = deriveFieldEncryptionKey(PRIV_A);
    const deviceB = deriveFieldEncryptionKey(PRIV_A);
    expect(Array.from(deviceA)).toEqual(Array.from(deviceB));
    expect(deviceA).toHaveLength(32);
    expect(decryptField(deviceB, encryptField(deviceA, 'cross-device'))).toBe('cross-device');
  });

  it('a different wallet key cannot decrypt', () => {
    const envelope = encryptField(deriveFieldEncryptionKey(PRIV_A), 'secret');
    expect(() => decryptField(deriveFieldEncryptionKey(PRIV_B), envelope)).toThrowError(SphereError);
  });

  it('tampering with the envelope throws (Poly1305 authentication)', () => {
    const key = deriveFieldEncryptionKey(PRIV_A);
    const envelope = encryptField(key, 'authenticated');
    // Flip one base64 character in the middle (stays valid base64 → the AEAD
    // tag check, not the codec, must catch it).
    const mid = FIELD_ENVELOPE_PREFIX.length + 20;
    const flipped = envelope[mid] === 'A' ? 'B' : 'A';
    const tampered = envelope.slice(0, mid) + flipped + envelope.slice(mid + 1);
    expect(() => decryptField(key, tampered)).toThrowError(/authentication failed/);
  });

  it('decrypt validates prefix and shape', () => {
    const key = deriveFieldEncryptionKey(PRIV_A);
    expect(() => decryptField(key, 'enc2.AAAA')).toThrowError(/prefix/);
    expect(() => decryptField(key, 'enc1.@@@@')).toThrowError(SphereError);
    expect(() => decryptField(key, 'enc1.AAAA')).toThrowError(/too short/);
  });

  describe('assertFieldEnvelopeShape — the server-side check (§8.3)', () => {
    const key = deriveFieldEncryptionKey(PRIV_A);

    it('accepts a well-formed envelope', () => {
      expect(() => assertFieldEnvelopeShape(encryptField(key, 'ok'))).not.toThrow();
    });

    it('rejects non-strings', () => {
      expect(() => assertFieldEnvelopeShape(42)).toThrowError(/string/);
    });

    it('rejects a missing prefix', () => {
      expect(() => assertFieldEnvelopeShape('AAAA')).toThrowError(/enc1\./);
    });

    it('rejects invalid base64', () => {
      expect(() => assertFieldEnvelopeShape('enc1.no$base64!!')).toThrowError(/base64/);
    });

    it('rejects payloads too short for nonce + tag', () => {
      expect(() => assertFieldEnvelopeShape('enc1.AAAA')).toThrowError(/too short/);
    });

    it('enforces the size cap', () => {
      const big = encryptField(key, 'x'.repeat(FIELD_ENVELOPE_MAX_BYTES));
      expect(() => assertFieldEnvelopeShape(big)).toThrowError(/size cap/);
      expect(() => assertFieldEnvelopeShape(big, big.length)).not.toThrow();
    });
  });

  describe('binary + AAD (E.4 checkpoint envelope)', () => {
    const AAD_A = new TextEncoder().encode('transfer-a:0');
    const AAD_B = new TextEncoder().encode('transfer-b:0');

    it('round-trips arbitrary (non-UTF-8) binary bytes under matching AAD', () => {
      const key = deriveFieldEncryptionKey(PRIV_A);
      // 0xff 0xfe … is not valid UTF-8 — a string codec would corrupt it.
      const plaintext = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x13, 0x37, 0xc0]);
      const envelope = encryptFieldBytes(key, plaintext, AAD_A);
      expect(Array.from(decryptFieldBytes(key, envelope, AAD_A))).toEqual(Array.from(plaintext));
    });

    it('a wrong AAD fails the tag at decrypt (cross-slot replay is rejected)', () => {
      const key = deriveFieldEncryptionKey(PRIV_A);
      const envelope = encryptFieldBytes(key, new Uint8Array([1, 2, 3]), AAD_A);
      // The SAME key + envelope, but a different slot's AAD — must not decrypt.
      expect(() => decryptFieldBytes(key, envelope, AAD_B)).toThrowError(SphereError);
      expect(() => decryptFieldBytes(key, envelope, AAD_B)).toThrowError(/authentication failed/);
      // …and the correct AAD still opens it.
      expect(Array.from(decryptFieldBytes(key, envelope, AAD_A))).toEqual([1, 2, 3]);
    });

    it('AAD is authenticated but NOT stored — omitting it entirely is a different context', () => {
      const key = deriveFieldEncryptionKey(PRIV_A);
      const withAad = encryptFieldBytes(key, new Uint8Array([9]), AAD_A);
      expect(() => decryptFieldBytes(key, withAad)).toThrowError(/authentication failed/); // no AAD ≠ AAD_A
      const noAad = encryptFieldBytes(key, new Uint8Array([9]));
      expect(Array.from(decryptFieldBytes(key, noAad))).toEqual([9]); // AAD-less round-trips
    });

    it('the string wrappers are the AAD-less binary path (interop with encryptFieldBytes)', () => {
      const key = deriveFieldEncryptionKey(PRIV_A);
      const viaString = encryptField(key, 'hello');
      expect(new TextDecoder().decode(decryptFieldBytes(key, viaString))).toBe('hello');
      const viaBytes = encryptFieldBytes(key, new TextEncoder().encode('hello'));
      expect(decryptField(key, viaBytes)).toBe('hello');
    });
  });
});
