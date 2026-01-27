/**
 * SDK Utility Functions
 * Pure utility functions for the wallet SDK
 */

// =============================================================================
// Constants
// =============================================================================

/** secp256k1 curve order */
const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

/** Base58 alphabet */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// =============================================================================
// Private Key Validation
// =============================================================================

/**
 * Validate if a hex string is a valid secp256k1 private key
 * Must be 0 < key < n (curve order)
 */
export function isValidPrivateKey(hex: string): boolean {
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      return false;
    }
    const key = BigInt('0x' + hex);
    return key > 0n && key < SECP256K1_ORDER;
  } catch {
    return false;
  }
}

// =============================================================================
// Base58 Encoding/Decoding
// =============================================================================

/**
 * Base58 encode hex string
 *
 * @example
 * ```ts
 * base58Encode('00f54a5851e9372b87810a8e60cdd2e7cfd80b6e31')
 * // '1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs'
 * ```
 */
export function base58Encode(hex: string): string {
  let num = BigInt('0x' + hex);
  let encoded = '';

  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }

  // Add leading 1s for leading 0s in hex
  for (let i = 0; i < hex.length && hex.substring(i, i + 2) === '00'; i += 2) {
    encoded = '1' + encoded;
  }

  return encoded;
}

/**
 * Base58 decode string to Uint8Array
 *
 * @example
 * ```ts
 * base58Decode('1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs')
 * // Uint8Array [0, 245, 74, ...]
 * ```
 */
export function base58Decode(str: string): Uint8Array {
  const ALPHABET_MAP: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    ALPHABET_MAP[BASE58_ALPHABET[i]] = i;
  }

  // Count leading zeros (represented as '1' in base58)
  let zeros = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    zeros++;
  }

  // Decode from base58 to number
  let num = BigInt(0);
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (!(char in ALPHABET_MAP)) {
      throw new Error('Invalid base58 character: ' + char);
    }
    num = num * BigInt(58) + BigInt(ALPHABET_MAP[char]);
  }

  // Convert to bytes
  const bytes: number[] = [];
  while (num > 0) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }

  // Add leading zeros
  for (let i = 0; i < zeros; i++) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

// =============================================================================
// Binary Pattern Search
// =============================================================================

/**
 * Find pattern in Uint8Array
 *
 * @param data - Data to search in
 * @param pattern - Pattern to find
 * @param startIndex - Start index for search
 * @returns Index of pattern or -1 if not found
 */
export function findPattern(
  data: Uint8Array,
  pattern: Uint8Array,
  startIndex: number = 0
): number {
  for (let i = startIndex; i <= data.length - pattern.length; i++) {
    let found = true;
    for (let j = 0; j < pattern.length; j++) {
      if (data[i + j] !== pattern[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

// =============================================================================
// Text Parsing
// =============================================================================

/**
 * Extract value from text using regex pattern
 *
 * @param text - Text to search
 * @param pattern - Regex pattern with capture group
 * @returns Captured value or null
 */
export function extractFromText(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

// =============================================================================
// Delay/Sleep
// =============================================================================

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Random
// =============================================================================

/**
 * Generate random hex string of specified byte length
 */
export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis.crypto !== 'undefined') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback for Node.js without global crypto
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto');
    const buf = nodeCrypto.randomBytes(byteLength);
    bytes.set(buf);
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate random UUID v4
 */
export function randomUUID(): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return nodeCrypto.randomUUID();
}
