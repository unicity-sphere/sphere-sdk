/**
 * Encryption utilities for SDK2
 *
 * Provides AES-256 encryption for sensitive wallet data.
 * Uses crypto-js for cross-platform compatibility.
 */

import CryptoJS from 'crypto-js';

// =============================================================================
// Types
// =============================================================================

export interface EncryptedData {
  /** Encrypted ciphertext (base64) */
  ciphertext: string;
  /** Initialization vector (hex) */
  iv: string;
  /** Salt used for key derivation (hex) */
  salt: string;
  /** Algorithm identifier */
  algorithm: 'aes-256-cbc';
  /** Key derivation function */
  kdf: 'pbkdf2';
  /** Number of PBKDF2 iterations */
  iterations: number;
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

// =============================================================================
// Encryption Functions
// =============================================================================

/**
 * Encrypt data with AES-256-CBC
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

  // Derive key from password
  const key = deriveKey(password, salt, iterations);

  // Encrypt with AES-256-CBC
  const encrypted = CryptoJS.AES.encrypt(data, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  return {
    ciphertext: encrypted.ciphertext.toString(CryptoJS.enc.Base64),
    iv: iv.toString(CryptoJS.enc.Hex),
    salt: salt.toString(CryptoJS.enc.Hex),
    algorithm: 'aes-256-cbc',
    kdf: 'pbkdf2',
    iterations,
  };
}

/**
 * Decrypt AES-256-CBC encrypted data
 * @param encryptedData - Encrypted data object
 * @param password - Decryption password
 */
export function decrypt(encryptedData: EncryptedData, password: string): string {
  // Parse salt and IV
  const salt = CryptoJS.enc.Hex.parse(encryptedData.salt);
  const iv = CryptoJS.enc.Hex.parse(encryptedData.iv);

  // Derive key from password
  const key = deriveKey(password, salt, encryptedData.iterations);

  // Parse ciphertext
  const ciphertext = CryptoJS.enc.Base64.parse(encryptedData.ciphertext);

  // Create cipher params
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext,
  });

  // Decrypt
  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  const result = decrypted.toString(CryptoJS.enc.Utf8);

  if (!result) {
    throw new Error('Decryption failed: invalid password or corrupted data');
  }

  return result;
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
    throw new Error('Decryption failed: invalid JSON data');
  }
}

// =============================================================================
// Simple Encryption (Password-based, for localStorage)
// =============================================================================

/**
 * Simple encryption using CryptoJS built-in password-based encryption
 * Suitable for localStorage where we don't need full EncryptedData metadata
 * @param plaintext - Data to encrypt
 * @param password - Encryption password
 */
export function encryptSimple(plaintext: string, password: string): string {
  return CryptoJS.AES.encrypt(plaintext, password).toString();
}

/**
 * Simple decryption
 * @param ciphertext - Encrypted string
 * @param password - Decryption password
 */
export function decryptSimple(ciphertext: string, password: string): string {
  const decrypted = CryptoJS.AES.decrypt(ciphertext, password);
  const result = decrypted.toString(CryptoJS.enc.Utf8);

  if (!result) {
    throw new Error('Decryption failed: invalid password or corrupted data');
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
  } catch {
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
  return (
    typeof obj.ciphertext === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.salt === 'string' &&
    obj.algorithm === 'aes-256-cbc' &&
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
    throw new Error('Invalid encrypted data format');
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
