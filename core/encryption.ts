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
 *
 * Steelman⁴⁶: tightened — both sides MUST already be canonical
 * lowercase. `computeMac` always emits lowercase hex; `isEncryptedData`
 * rejects records whose `mac` field is not strict-lowercase. Removing
 * runtime `toLowerCase` eliminates the V8 fast-path timing channel
 * (lowercasing pure-ASCII-lowercase is faster than mixed-case input).
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Steelman⁴⁷: tighten to 64-char fixed length. HMAC-SHA256 output is
// always 32 bytes = 64 hex chars; a shorter or longer mac field is
// always malformed. Previously the regex accepted any non-empty
// lowercase hex, so a `mac: 'a'` would parse cleanly and only fail at
// the constantTimeHexEqual length-mismatch branch — which surfaces as
// "MAC verification failed" instead of "malformed mac field",
// confusing telemetry.
const LOWERCASE_HEX_RE = /^[0-9a-f]{64}$/;

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
 *
 * Steelman⁴⁷ HIGH: the legacy unauthenticated CBC branch is now gated
 * behind the explicit `allowLegacyUnauthenticated` opt-in. By default,
 * `decrypt()` refuses any record with `algorithm === 'aes-256-cbc'` —
 * matching the v2-envelope gate in `decryptSimple` so direct callers
 * (CLI tools, ad-hoc invocations) cannot reach the padding-oracle-
 * exploitable legacy path with arbitrary attacker-supplied input.
 *
 * Internal call sites that legitimately need to read legacy records
 * (read-only on-disk migration) MUST pass `{ allowLegacyUnauthenticated:
 * true }` and gate the surrounding flow on the same authority that
 * guards the legacy data source.
 */
export function decrypt(
  encryptedData: EncryptedData,
  password: string,
  options?: { allowLegacyUnauthenticated?: boolean },
): string {
  // Steelman⁴⁰ note: validate `iterations` BEFORE running PBKDF2.
  // An attacker-controlled record with `iterations: 2^31` or huge
  // values would either hang the call or coerce to something bad.
  // The MAC eventually fails-closed but the DoS happens BEFORE MAC
  // verify (since macKey itself requires PBKDF2). Bound it.
  const ITERATIONS_MIN = 1000;
  const ITERATIONS_MAX = 10_000_000;
  if (
    !Number.isFinite(encryptedData.iterations) ||
    !Number.isInteger(encryptedData.iterations) ||
    encryptedData.iterations < ITERATIONS_MIN ||
    encryptedData.iterations > ITERATIONS_MAX
  ) {
    throw new SphereError(
      `Decryption failed: iterations=${encryptedData.iterations} outside [${ITERATIONS_MIN}, ${ITERATIONS_MAX}] (DoS guard).`,
      'DECRYPTION_ERROR',
    );
  }
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
    // Steelman⁴⁶: enforce canonical lowercase MAC at decrypt time so
    // constantTimeHexEqual can skip runtime lowercasing.
    if (!LOWERCASE_HEX_RE.test(encryptedData.mac)) {
      throw new SphereError(
        'Decryption failed: mac field must be canonical lowercase hex',
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

  // Steelman⁴⁷ HIGH: legacy unauthenticated CBC is opt-in only.
  // External callers (CLI ad-hoc decrypt command) cannot reach this
  // path without explicitly setting allowLegacyUnauthenticated=true.
  if (options?.allowLegacyUnauthenticated !== true) {
    throw new SphereError(
      'Decryption failed: refusing to decrypt unauthenticated legacy record without explicit opt-in. ' +
        'Pass { allowLegacyUnauthenticated: true } if the data source is trusted (read-only on-disk migration).',
      'DECRYPTION_ERROR',
    );
  }
  // Legacy unauthenticated path. Log a one-shot warning so operators
  // can audit how many records still need re-encryption.
  //
  // Steelman⁴⁶: CryptoJS may THROW on certain malformed padding/UTF-8
  // shapes vs RETURN empty on others. Distinguishable error modes
  // give attackers a (weak) padding-oracle distinguisher. Normalize
  // all failure paths to the same SphereError code+message.
  // Steelman⁴⁷: rethrow ONLY DECRYPTION_ERROR-coded SphereErrors;
  // collapse any other SphereError into a generic DECRYPTION_ERROR
  // so internal validation codes don't leak via this oracle path.
  warnLegacyUnauthenticatedOnce();
  try {
    const key = deriveKey(password, salt, encryptedData.iterations);
    const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext });
    const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    if (!result) {
      throw new SphereError(
        'Decryption failed: invalid password or corrupted data',
        'DECRYPTION_ERROR',
      );
    }
    return result;
  } catch (err) {
    if (err instanceof SphereError && err.code === 'DECRYPTION_ERROR') throw err;
    throw new SphereError(
      'Decryption failed: invalid password or corrupted data',
      'DECRYPTION_ERROR',
    );
  }
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
    // Steelman⁴⁶ CRITICAL: the `v2:` prefix is the integrity claim.
    // Refuse to honour a `v2:` envelope whose payload self-declares
    // a non-authenticated algorithm — otherwise an attacker with
    // storage-write access (compromised IndexedDB / hostile extension /
    // malicious StorageProvider) could replace a real authenticated
    // mnemonic envelope with a forged `v2:`-wrapped legacy CBC payload
    // and exploit the unauthenticated path as a padding oracle. The
    // legacy unauthenticated CBC path remains reachable via the
    // prefix-less `U2FsdGVkX1...` form below — but only for strings
    // CryptoJS itself produced before the v2 migration.
    if (env.algorithm !== 'aes-256-cbc-hmac-sha256') {
      throw new SphereError(
        'Decryption failed: v2 envelope must declare authenticated algorithm',
        'DECRYPTION_ERROR',
      );
    }
    return decrypt(env, password);
  }

  // Legacy CryptoJS OpenSSL-format (unauthenticated). Read-only; new
  // writes don't produce this. Steelman⁴⁶: normalize all error modes
  // to a single SphereError so CryptoJS internal throws don't leak a
  // padding-oracle distinguisher to the caller.
  warnLegacyUnauthenticatedOnce();
  try {
    const decrypted = CryptoJS.AES.decrypt(ciphertext, password);
    const result = decrypted.toString(CryptoJS.enc.Utf8);
    if (!result) {
      throw new SphereError(
        'Decryption failed: invalid password or corrupted data',
        'DECRYPTION_ERROR',
      );
    }
    return result;
  } catch (err) {
    if (err instanceof SphereError) throw err;
    throw new SphereError(
      'Decryption failed: invalid password or corrupted data',
      'DECRYPTION_ERROR',
    );
  }
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
  // Authenticated records require a `mac` field in canonical lowercase
  // hex; legacy records must NOT have one. Steelman⁴⁶: lowercase check
  // is a format invariant, not a runtime canonicalization, so the
  // constant-time MAC compare can skip toLowerCase entirely.
  if (obj.algorithm === 'aes-256-cbc-hmac-sha256') {
    if (typeof obj.mac !== 'string' || !LOWERCASE_HEX_RE.test(obj.mac)) {
      return false;
    }
  } else if ('mac' in obj && obj.mac !== undefined) {
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
