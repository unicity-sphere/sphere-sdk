/**
 * Profile Encryption Module
 *
 * Provides encryption/decryption for Profile values stored in OrbitDB and
 * UXF CAR files pinned to IPFS. All encryption uses AES-256-GCM with random
 * IVs via the Web Crypto API (available in browsers and Node.js 18+).
 *
 * Key derivation uses HKDF-SHA256 from `@noble/hashes` (already a project
 * dependency) to deterministically derive a 32-byte profile encryption key
 * from the wallet master key. All devices sharing the same mnemonic derive
 * the same encryption key.
 *
 * Wire format for encrypted values:
 *   IV (12 bytes) || ciphertext || AES-GCM auth tag (16 bytes)
 *
 * @see PROFILE-ARCHITECTURE.md Section 9.1 (Encryption Model)
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ProfileError } from './errors';

// =============================================================================
// Constants
// =============================================================================

/** HKDF info string for deriving the profile encryption key from the master key. */
export const PROFILE_HKDF_INFO = 'uxf-profile-encryption';

/** AES-GCM initialization vector length in bytes. */
const IV_LENGTH = 12;

/** AES-256 key length in bytes. */
const KEY_LENGTH = 32;

// =============================================================================
// Key Derivation
// =============================================================================

/**
 * Derive a 32-byte AES-256-GCM encryption key from the wallet master key
 * using HKDF-SHA256.
 *
 * The derivation is deterministic: the same master key always produces the
 * same encryption key, allowing all devices that share a mnemonic to decrypt
 * each other's data.
 *
 * @param masterKey - Raw master key bytes (typically 32 bytes from BIP32)
 * @returns 32-byte derived encryption key
 */
export function deriveProfileEncryptionKey(masterKey: Uint8Array): Uint8Array {
  const info = new TextEncoder().encode(PROFILE_HKDF_INFO);
  return hkdf(sha256, masterKey, undefined, info, KEY_LENGTH);
}

// =============================================================================
// AES-256-GCM Encrypt / Decrypt (Web Crypto)
// =============================================================================

/**
 * Import a raw AES-256-GCM key into the Web Crypto API.
 */
async function importKey(key: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt arbitrary binary data with AES-256-GCM using a random 12-byte IV.
 *
 * The returned buffer is laid out as:
 *   `IV (12 bytes) || ciphertext || auth tag (16 bytes)`
 *
 * The auth tag is appended automatically by the Web Crypto API when using
 * AES-GCM — it is included in the ArrayBuffer returned by `encrypt()`.
 *
 * @param key       - 32-byte AES-256 encryption key
 * @param plaintext - Data to encrypt
 * @returns Encrypted bytes in the format described above
 * @throws {ProfileError} code `ENCRYPTION_FAILED` on any failure
 */
export async function encryptProfileValue(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  try {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const cryptoKey = await importKey(key);

    const ciphertextWithTag = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      plaintext,
    );

    // Concatenate: IV || ciphertext+tag
    const result = new Uint8Array(IV_LENGTH + ciphertextWithTag.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertextWithTag), IV_LENGTH);
    return result;
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw new ProfileError(
      'ENCRYPTION_FAILED',
      'AES-256-GCM encryption failed',
      err,
    );
  }
}

/**
 * Decrypt data previously encrypted by {@link encryptProfileValue}.
 *
 * Expects the input format: `IV (12 bytes) || ciphertext || auth tag (16 bytes)`.
 *
 * @param key       - 32-byte AES-256 encryption key (must match the key used to encrypt)
 * @param encrypted - Encrypted bytes produced by {@link encryptProfileValue}
 * @returns Decrypted plaintext bytes
 * @throws {ProfileError} code `DECRYPTION_FAILED` on invalid key, tampered data,
 *         or malformed input
 */
export async function decryptProfileValue(
  key: Uint8Array,
  encrypted: Uint8Array,
): Promise<Uint8Array> {
  if (encrypted.length < IV_LENGTH + 1) {
    throw new ProfileError(
      'DECRYPTION_FAILED',
      `Encrypted data too short: expected at least ${IV_LENGTH + 1} bytes, got ${encrypted.length}`,
    );
  }

  try {
    const iv = encrypted.slice(0, IV_LENGTH);
    const ciphertextWithTag = encrypted.slice(IV_LENGTH);

    const cryptoKey = await importKey(key);

    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      ciphertextWithTag,
    );

    return new Uint8Array(plaintext);
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw new ProfileError(
      'DECRYPTION_FAILED',
      'AES-256-GCM decryption failed: invalid key or tampered data',
      err,
    );
  }
}

// =============================================================================
// String Convenience Wrappers
// =============================================================================

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 *
 * Convenience wrapper around {@link encryptProfileValue} that handles
 * UTF-8 encoding.
 *
 * @param key   - 32-byte AES-256 encryption key
 * @param value - String to encrypt
 * @returns Encrypted bytes (same format as {@link encryptProfileValue})
 */
export async function encryptString(
  key: Uint8Array,
  value: string,
): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return encryptProfileValue(key, encoded);
}

/**
 * Decrypt bytes produced by {@link encryptString} back to a UTF-8 string.
 *
 * @param key       - 32-byte AES-256 encryption key
 * @param encrypted - Encrypted bytes produced by {@link encryptString}
 * @returns Decrypted UTF-8 string
 * @throws {ProfileError} code `DECRYPTION_FAILED` on failure
 */
export async function decryptString(
  key: Uint8Array,
  encrypted: Uint8Array,
): Promise<string> {
  const plaintext = await decryptProfileValue(key, encrypted);
  return new TextDecoder().decode(plaintext);
}
