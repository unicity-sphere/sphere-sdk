/**
 * Tests for profile/encryption.ts
 * Covers HKDF key derivation, AES-256-GCM encrypt/decrypt, string wrappers,
 * and tamper detection.
 */

import { describe, it, expect } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  deriveProfileEncryptionKey,
  PROFILE_HKDF_INFO,
  encryptProfileValue,
  decryptProfileValue,
  encryptString,
  decryptString,
} from '../../../profile/encryption';
import { ProfileError } from '../../../profile/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic 32-byte key from a seed number. */
function makeKey(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    key[i] = (seed + i) & 0xff;
  }
  return key;
}

// ---------------------------------------------------------------------------
// deriveProfileEncryptionKey
// ---------------------------------------------------------------------------

describe('deriveProfileEncryptionKey', () => {
  it('deterministic derivation -- same input produces same key', () => {
    const master = makeKey(42);
    const a = deriveProfileEncryptionKey(master);
    const b = deriveProfileEncryptionKey(master);
    expect(a).toEqual(b);
  });

  it('produces a 32-byte key', () => {
    const key = deriveProfileEncryptionKey(makeKey(1));
    expect(key.length).toBe(32);
    expect(key).toBeInstanceOf(Uint8Array);
  });

  it('different master keys produce different encryption keys', () => {
    const a = deriveProfileEncryptionKey(makeKey(1));
    const b = deriveProfileEncryptionKey(makeKey(2));
    expect(a).not.toEqual(b);
  });

  it('uses domain-specific HKDF salt -- changing salt produces different key', () => {
    const master = makeKey(99);

    // Derive with the real function (uses salt "sphere-profile-v1")
    const realKey = deriveProfileEncryptionKey(master);

    // Derive manually with a different salt
    const differentSalt = new TextEncoder().encode('different-salt');
    const info = new TextEncoder().encode(PROFILE_HKDF_INFO);
    const altKey = hkdf(sha256, master, differentSalt, info, 32);

    expect(realKey).not.toEqual(altKey);
  });
});

// ---------------------------------------------------------------------------
// encryptProfileValue / decryptProfileValue
// ---------------------------------------------------------------------------

describe('encryptProfileValue / decryptProfileValue', () => {
  const key = deriveProfileEncryptionKey(makeKey(10));

  it('encrypt/decrypt round-trip', async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encrypted = await encryptProfileValue(key, plaintext);
    const decrypted = await decryptProfileValue(key, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it('random IV -- encrypting same plaintext twice produces different ciphertext', async () => {
    const plaintext = new Uint8Array([10, 20, 30]);
    const enc1 = await encryptProfileValue(key, plaintext);
    const enc2 = await encryptProfileValue(key, plaintext);

    // The first 12 bytes (IV) should differ
    const iv1 = enc1.slice(0, 12);
    const iv2 = enc2.slice(0, 12);
    expect(iv1).not.toEqual(iv2);

    // Full ciphertext differs
    expect(enc1).not.toEqual(enc2);
  });

  it('output format is IV(12) || ciphertext || tag -- length at least 12+1', async () => {
    const plaintext = new Uint8Array([0xff]);
    const encrypted = await encryptProfileValue(key, plaintext);
    // Must be at least 12 (IV) + 1 (ciphertext) bytes; in practice also includes 16-byte tag
    expect(encrypted.length).toBeGreaterThanOrEqual(13);
    // With AES-GCM, 1 byte plaintext -> 12 IV + 1 ciphertext + 16 tag = 29
    expect(encrypted.length).toBe(29);
  });

  it('tampered ciphertext causes DECRYPTION_FAILED', async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const encrypted = await encryptProfileValue(key, plaintext);

    // Flip a byte in the ciphertext portion (after the 12-byte IV)
    const tampered = new Uint8Array(encrypted);
    tampered[14] ^= 0xff;

    await expect(decryptProfileValue(key, tampered)).rejects.toThrow(ProfileError);
    await expect(decryptProfileValue(key, tampered)).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
    });
  });

  it('wrong key causes DECRYPTION_FAILED', async () => {
    const plaintext = new Uint8Array([5, 6, 7]);
    const encrypted = await encryptProfileValue(key, plaintext);

    const wrongKey = deriveProfileEncryptionKey(makeKey(99));
    await expect(decryptProfileValue(wrongKey, encrypted)).rejects.toThrow(ProfileError);
    await expect(decryptProfileValue(wrongKey, encrypted)).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
    });
  });

  it('too-short input causes DECRYPTION_FAILED', async () => {
    const tooShort = new Uint8Array(10); // less than 13
    await expect(decryptProfileValue(key, tooShort)).rejects.toThrow(ProfileError);

    try {
      await decryptProfileValue(key, tooShort);
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileError);
      const pe = err as ProfileError;
      expect(pe.code).toBe('DECRYPTION_FAILED');
      expect(pe.message).toContain('13');
      expect(pe.message).toContain('10');
    }
  });
});

// ---------------------------------------------------------------------------
// encryptString / decryptString
// ---------------------------------------------------------------------------

describe('encryptString / decryptString', () => {
  const key = deriveProfileEncryptionKey(makeKey(20));

  it('string encrypt/decrypt round-trip', async () => {
    const encrypted = await encryptString(key, 'hello world');
    const decrypted = await decryptString(key, encrypted);
    expect(decrypted).toBe('hello world');
  });

  it('empty string round-trip', async () => {
    const encrypted = await encryptString(key, '');
    const decrypted = await decryptString(key, encrypted);
    expect(decrypted).toBe('');
  });
});
