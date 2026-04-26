/**
 * Encryption utilities for SDK2
 *
 * Provides AES-256 encryption for sensitive wallet data.
 * Uses crypto-js for cross-platform compatibility.
 */

import CryptoJS from 'crypto-js';
import { SphereError } from './errors';
import { logger } from './logger';

// =============================================================================
// Types
// =============================================================================

/**
 * Authenticated encrypted data envelope.
 *
 * Steelman³⁸ critical: previous version was AES-256-CBC WITHOUT a MAC,
 * leaving ciphertext malleable to bit-flipping attacks on the storage
 * substrate. Now an Encrypt-then-MAC construction: AES-256-CBC for
 * confidentiality + HMAC-SHA256 over (iv || ciphertext) for integrity.
 *
 * Backward compatibility: records WITHOUT a `mac` field are accepted by
 * `decrypt()` for legacy data (with a logged warning), but ALL new
 * writes via `encrypt()` produce the authenticated form.
 */
export interface EncryptedData {
  /** Encrypted ciphertext (base64) */
  ciphertext: string;
  /** Initialization vector (hex) */
  iv: string;
  /** Salt used for key derivation (hex) */
  salt: string;
  /** Algorithm identifier */
  algorithm: 'aes-256-cbc' | 'aes-256-cbc-hmac-sha256';
  /** Key derivation function */
  kdf: 'pbkdf2';
  /** Number of PBKDF2 iterations */
  iterations: number;
  /**
   * HMAC-SHA256 over (iv-bytes || ciphertext-bytes) — hex-encoded.
   * Present iff algorithm === 'aes-256-cbc-hmac-sha256'.
   */
  mac?: string;
}

export interface EncryptionOptions {
  /** Number of PBKDF2 iterations (default: 100000) */
  iterations?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default number of PBKDF2 iterations */
const DEFAULT_ITERATIONS = 100000;

/** AES key size in bits */
const KEY_SIZE = 256;

/** Salt size in bytes */
const SALT_SIZE = 16;

/** IV size in bytes */
const IV_SIZE = 16;

// =============================================================================
// Key Derivation
// =============================================================================

/**
 * Derive encryption key from password using PBKDF2
 * @param password - User password
 * @param salt - Salt as WordArray
 * @param iterations - Number of iterations
 */
function deriveKey(
  password: string,
  salt: CryptoJS.lib.WordArray,
  iterations: number
): CryptoJS.lib.WordArray {
  return CryptoJS.PBKDF2(password, salt, {
    keySize: KEY_SIZE / 32, // WordArray uses 32-bit words
    iterations,
    hasher: CryptoJS.algo.SHA256,
  });
}

/**
 * Steelman³⁸ critical: derive 512-bit material then split into 256-bit
 * encryption key + 256-bit MAC key. Single PBKDF2 call (expensive) → two
 * domain-separated keys. Used by the authenticated encrypt/decrypt path.
 */
function deriveAuthKeys(
  password: string,
  salt: CryptoJS.lib.WordArray,
  iterations: number,
): { encKey: CryptoJS.lib.WordArray; macKey: CryptoJS.lib.WordArray } {
  const fullMaterial = CryptoJS.PBKDF2(password, salt, {
    keySize: 2 * (KEY_SIZE / 32), // 16 32-bit words = 512 bits
    iterations,
    hasher: CryptoJS.algo.SHA256,
  });
  // Split: first 8 words (256 bits) = enc key; last 8 = mac key.
  const words = fullMaterial.words;
  const encKey = CryptoJS.lib.WordArray.create(words.slice(0, 8), 32);
  const macKey = CryptoJS.lib.WordArray.create(words.slice(8, 16), 32);
  return { encKey, macKey };
}

/**
 * Compute HMAC-SHA256 over (iv-bytes || ciphertext-bytes).
 * Returns hex-encoded MAC.
 */
function computeMac(
  macKey: CryptoJS.lib.WordArray,
  iv: CryptoJS.lib.WordArray,
  ciphertext: CryptoJS.lib.WordArray,
): string {
  const concat = iv.clone().concat(ciphertext);
  return CryptoJS.HmacSHA256(concat, macKey).toString(CryptoJS.enc.Hex);
}

/**
 * Constant-time comparison of two hex strings of equal length.
 * For MAC verification — non-constant-time `===` would leak via
 * timing how many bytes matched.
 *
 * Steelman³⁹ note: canonicalizes both sides to lowercase first so
 * stored uppercase hex and computed lowercase hex compare equal.
 * The lowercasing itself is non-constant-time but operates on
 * non-secret data (the MAC, which is verified before any decryption
 * key material is touched), so the timing leak there is acceptable.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  let diff = 0;
  for (let i = 0; i < aLower.length; i++) {
    diff |= aLower.charCodeAt(i) ^ bLower.charCodeAt(i);
  }
  return diff === 0;
}

// =============================================================================
// Encryption Functions
// =============================================================================

/**
 * Encrypt data with AES-256-CBC + HMAC-SHA256 (Encrypt-then-MAC).
 *
 * Steelman³⁸ critical: previously raw AES-CBC without a MAC, which
 * left ciphertext malleable. Now an authenticated construction.
 *
 * @param plaintext - Data to encrypt (string or object)
 * @param password - Encryption password
 * @param options - Encryption options
 */
export function encrypt(
  plaintext: string | object,
  password: string,
  options: EncryptionOptions = {}
): EncryptedData {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;

  // Convert object to JSON string if needed
  const data = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);

  // Generate random salt and IV
  const salt = CryptoJS.lib.WordArray.random(SALT_SIZE);
  const iv = CryptoJS.lib.WordArray.random(IV_SIZE);

  // Derive enc + MAC keys from password (single PBKDF2, split output)
  const { encKey, macKey } = deriveAuthKeys(password, salt, iterations);

  // Encrypt with AES-256-CBC
  const encrypted = CryptoJS.AES.encrypt(data, encKey, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // Compute MAC over (iv || ciphertext) — Encrypt-then-MAC.
  const mac = computeMac(macKey, iv, encrypted.ciphertext);

  return {
    ciphertext: encrypted.ciphertext.toString(CryptoJS.enc.Base64),
    iv: iv.toString(CryptoJS.enc.Hex),
    salt: salt.toString(CryptoJS.enc.Hex),
    algorithm: 'aes-256-cbc-hmac-sha256',
    kdf: 'pbkdf2',
    iterations,
    mac,
  };
}

/**
 * Decrypt AES-256-CBC[+HMAC] encrypted data.
 *
 * Steelman³⁸ critical: routes by `algorithm`:
 *   - 'aes-256-cbc-hmac-sha256': verify HMAC FIRST (constant-time),
 *     then decrypt. Fail-closed on MAC mismatch.
 *   - 'aes-256-cbc' (legacy): decrypt without authentication, log
 *     a one-shot warning, return result. New writes don't produce
 *     this format — but existing on-disk records remain readable.
 */
export function decrypt(encryptedData: EncryptedData, password: string): string {
  // Parse salt and IV
  const salt = CryptoJS.enc.Hex.parse(encryptedData.salt);
  const iv = CryptoJS.enc.Hex.parse(encryptedData.iv);
  const ciphertext = CryptoJS.enc.Base64.parse(encryptedData.ciphertext);

  if (encryptedData.algorithm === 'aes-256-cbc-hmac-sha256') {
    // Authenticated path: verify MAC, then decrypt.
    if (typeof encryptedData.mac !== 'string') {
      throw new SphereError(
        'Decryption failed: authenticated record missing mac field',
        'DECRYPTION_ERROR',
      );
    }
    const { encKey, macKey } = deriveAuthKeys(password, salt, encryptedData.iterations);
    const expectedMac = computeMac(macKey, iv, ciphertext);
    if (!constantTimeHexEqual(expectedMac, encryptedData.mac)) {
      throw new SphereError(
        'Decryption failed: MAC verification failed (wrong password or tampered ciphertext)',
        'DECRYPTION_ERROR',
      );
    }
    const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext });
    const decrypted = CryptoJS.AES.decrypt(cipherParams, encKey, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    if (!result) {
      throw new SphereError(
        'Decryption failed: padding error after MAC pass (corrupted record)',
        'DECRYPTION_ERROR',
      );
    }
    return result;
  }

  // Legacy unauthenticated path. Log a one-shot warning so operators
  // can audit how many records still need re-encryption.
  warnLegacyUnauthenticatedOnce();
  const key = deriveKey(password, salt, encryptedData.iterations);
  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext });
  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const result = decrypted.toString(CryptoJS.enc.Utf8);
  if (!result) {
    throw new SphereError('Decryption failed: invalid password or corrupted data', 'DECRYPTION_ERROR');
  }
  return result;
}

let _warnedLegacyUnauth = false;
function warnLegacyUnauthenticatedOnce(): void {
  if (_warnedLegacyUnauth) return;
  _warnedLegacyUnauth = true;
  logger.warn(
    'Encryption',
    'Decrypting legacy unauthenticated AES-CBC record. Re-encrypt at next ' +
      'write opportunity — current ciphertext is malleable to bit-flipping ' +
      'attacks (steelman³⁸).',
  );
}

/**
 * Decrypt and parse JSON data
 * @param encryptedData - Encrypted data object
 * @param password - Decryption password
 */
export function decryptJson<T = unknown>(encryptedData: EncryptedData, password: string): T {
  const decrypted = decrypt(encryptedData, password);
  try {
    return JSON.parse(decrypted) as T;
  } catch {
    throw new SphereError('Decryption failed: invalid JSON data', 'DECRYPTION_ERROR');
  }
}

// =============================================================================
// Simple Encryption (Password-based, for localStorage)
// =============================================================================

/**
 * Steelman³⁸ critical: tagged-string format for authenticated simple
 * encryption. Used by mnemonic + master-key persistence (Sphere.ts).
 * Format: `v2:<base64-of-JSON-EncryptedData>` — the `v2:` prefix
 * disambiguates from legacy CryptoJS OpenSSL-format strings (which
 * always start with `U2FsdGVkX1` = base64 of "Salted__").
 */
const SIMPLE_V2_PREFIX = 'v2:';

/**
 * Authenticated password-based encryption for compact string storage.
 * Replaces the previous CryptoJS.AES.encrypt(plaintext, password) which
 * produced an unauthenticated CBC ciphertext susceptible to bit-flipping.
 *
 * @param plaintext - Data to encrypt
 * @param password - Encryption password
 */
export function encryptSimple(plaintext: string, password: string): string {
  const env = encrypt(plaintext, password);
  // Prefix tells decryptSimple which path to take.  base64 of compact
  // JSON keeps the storage small while preserving the typed envelope.
  return SIMPLE_V2_PREFIX + btoa(JSON.stringify(env));
}

/**
 * Decrypt a string produced by `encryptSimple`.
 *
 * Steelman³⁸: routes by prefix.
 *   - `v2:` → authenticated decrypt (MAC verified)
 *   - legacy (no prefix) → CryptoJS OpenSSL-compatible decrypt with a
 *     one-shot warning. New writes don't produce legacy.
 *
 * @param ciphertext - Encrypted string
 * @param password - Decryption password
 */
export function decryptSimple(ciphertext: string, password: string): string {
  if (ciphertext.startsWith(SIMPLE_V2_PREFIX)) {
    let env: EncryptedData;
    try {
      env = JSON.parse(atob(ciphertext.slice(SIMPLE_V2_PREFIX.length))) as EncryptedData;
    } catch {
      throw new SphereError('Decryption failed: malformed v2 envelope', 'DECRYPTION_ERROR');
    }
    if (!isEncryptedData(env)) {
      throw new SphereError('Decryption failed: invalid v2 envelope shape', 'DECRYPTION_ERROR');
    }
    return decrypt(env, password);
  }

  // Legacy CryptoJS OpenSSL-format (unauthenticated). Read-only; new
  // writes don't produce this.
  warnLegacyUnauthenticatedOnce();
  const decrypted = CryptoJS.AES.decrypt(ciphertext, password);
  const result = decrypted.toString(CryptoJS.enc.Utf8);
  if (!result) {
    throw new SphereError('Decryption failed: invalid password or corrupted data', 'DECRYPTION_ERROR');
  }
  return result;
}

/**
 * Decrypt data encrypted with PBKDF2-derived key (legacy JSON wallet format).
 * Compatible with webwallet's encryptWithPassword/decryptWithPassword.
 */
export function decryptWithSalt(ciphertext: string, password: string, salt: string): string | null {
  try {
    const key = CryptoJS.PBKDF2(password, salt, {
      keySize: 256 / 32,
      iterations: 100000,
      hasher: CryptoJS.algo.SHA256,
    }).toString();
    const decrypted = CryptoJS.AES.decrypt(ciphertext, key);
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    return result || null;
  } catch (err) {
    logger.debug('Encryption', 'decryptWithSalt failed', err);
    return null;
  }
}

// =============================================================================
// Mnemonic Encryption (Compatible with existing wallet format)
// =============================================================================

/**
 * Encrypt mnemonic phrase for storage
 * Uses simple AES encryption compatible with existing wallet format
 * @param mnemonic - BIP39 mnemonic phrase
 * @param password - Encryption password
 */
export function encryptMnemonic(mnemonic: string, password: string): string {
  return encryptSimple(mnemonic, password);
}

/**
 * Decrypt mnemonic phrase from storage
 * @param encryptedMnemonic - Encrypted mnemonic string
 * @param password - Decryption password
 */
export function decryptMnemonic(encryptedMnemonic: string, password: string): string {
  return decryptSimple(encryptedMnemonic, password);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if data looks like an EncryptedData object
 */
export function isEncryptedData(data: unknown): data is EncryptedData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  const algorithmOk =
    obj.algorithm === 'aes-256-cbc' ||
    obj.algorithm === 'aes-256-cbc-hmac-sha256';
  // Authenticated records require a `mac` field; legacy records must NOT.
  if (obj.algorithm === 'aes-256-cbc-hmac-sha256' && typeof obj.mac !== 'string') {
    return false;
  }
  return (
    typeof obj.ciphertext === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.salt === 'string' &&
    algorithmOk &&
    obj.kdf === 'pbkdf2' &&
    typeof obj.iterations === 'number'
  );
}

/**
 * Serialize EncryptedData to string for storage
 */
export function serializeEncrypted(data: EncryptedData): string {
  return JSON.stringify(data);
}

/**
 * Deserialize EncryptedData from string
 */
export function deserializeEncrypted(serialized: string): EncryptedData {
  const parsed = JSON.parse(serialized);
  if (!isEncryptedData(parsed)) {
    throw new SphereError('Invalid encrypted data format', 'VALIDATION_ERROR');
  }
  return parsed;
}

/**
 * Generate a random password/key as hex string
 * @param bytes - Number of random bytes (default: 32)
 */
export function generateRandomKey(bytes: number = 32): string {
  return CryptoJS.lib.WordArray.random(bytes).toString(CryptoJS.enc.Hex);
}
