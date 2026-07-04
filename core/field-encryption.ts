/**
 * core/field-encryption.ts — client-side field encryption (sdk-changes S6,
 * ARCHITECTURE §8.3).
 *
 * Fields the backend stores but never needs to read (mailbox `memo`, history
 * `memo` + `counterparty_nametag`, payment-request `memo`, and the intent
 * payload — E.3) are encrypted client-side so any of the owner's devices can
 * decrypt but the operator cannot.
 *
 * - **Key**: `HKDF-SHA256(ikm = walletPrivKey bytes, info = "sphere-fieldenc-v1")`
 *   → 32-byte symmetric key. Deterministic per wallet → multi-device by
 *   construction (mirrors token-engine/realization.ts — same @noble/hashes
 *   HKDF, no salt).
 * - **Cipher/envelope**: XChaCha20-Poly1305 with a random 24-byte nonce; wire
 *   form is EXACTLY `"enc1." + base64(nonce ‖ ciphertext)`.
 * - **One mapping rule everywhere** (ARCHITECTURE §8.3): JSON bodies and
 *   responses carry the `enc1.` string verbatim; the server validates only
 *   prefix + base64 + size cap, stores the exact UTF-8 bytes, and returns them
 *   unchanged. {@link assertFieldEnvelopeShape} is that server-side check.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { SphereError } from './errors';

/** HKDF info label — versioned; the same label appears in sdk-changes S6. */
export const FIELD_ENCRYPTION_HKDF_INFO = 'sphere-fieldenc-v1';

/** Envelope wire prefix. The version lives in the prefix (`enc1`). */
export const FIELD_ENVELOPE_PREFIX = 'enc1.';

/** XChaCha20-Poly1305 nonce length (24 bytes). */
export const FIELD_ENVELOPE_NONCE_BYTES = 24;

/** Poly1305 authentication tag length appended to the ciphertext. */
const POLY1305_TAG_BYTES = 16;

/**
 * Default envelope size cap in bytes (UTF-8 length of the full `enc1.…`
 * string). Matches the intent-payload cap (≤ 4 KiB — ARCHITECTURE §7/§11).
 */
export const FIELD_ENVELOPE_MAX_BYTES = 4096;

// =============================================================================
// base64 (RFC 4648, with padding) — hand-rolled so the codec is identical in
// Node and browsers (no Buffer / btoa dependency) and decode is strict.
// =============================================================================

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET[i]] = i;

function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/** Strict decode: throws on non-alphabet chars, bad length, or bad padding. */
function base64Decode(s: string): Uint8Array {
  if (s.length % 4 !== 0) {
    throw new SphereError('Invalid field envelope: base64 length not a multiple of 4', 'DECRYPTION_ERROR');
  }
  let padding = 0;
  if (s.endsWith('==')) padding = 2;
  else if (s.endsWith('=')) padding = 1;
  const body = s.slice(0, s.length - padding);
  if (body.includes('=')) {
    throw new SphereError('Invalid field envelope: misplaced base64 padding', 'DECRYPTION_ERROR');
  }
  const out = new Uint8Array((s.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < body.length; i += 4) {
    const n0 = B64_LOOKUP[body[i]];
    const n1 = B64_LOOKUP[body[i + 1]];
    const n2 = body[i + 2] !== undefined ? B64_LOOKUP[body[i + 2]] : 0;
    const n3 = body[i + 3] !== undefined ? B64_LOOKUP[body[i + 3]] : 0;
    if (n0 === undefined || n1 === undefined || n2 === undefined || n3 === undefined) {
      throw new SphereError('Invalid field envelope: non-base64 character', 'DECRYPTION_ERROR');
    }
    const triple = (n0 << 18) | (n1 << 12) | (n2 << 6) | n3;
    if (o < out.length) out[o++] = (triple >> 16) & 0xff;
    if (o < out.length) out[o++] = (triple >> 8) & 0xff;
    if (o < out.length) out[o++] = triple & 0xff;
  }
  return out;
}

// =============================================================================
// Key derivation
// =============================================================================

function hexToBytesStrict(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new SphereError('Invalid private key hex for field-encryption key derivation', 'INVALID_CONFIG');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Derive the wallet's 32-byte field-encryption key (sdk-changes S6):
 * `HKDF-SHA256(ikm = wallet privkey bytes, info = "sphere-fieldenc-v1")`.
 *
 * Deterministic per wallet key — every device holding the seed derives the
 * same key, so envelopes round-trip across devices with no key exchange.
 *
 * @param privKeyHex - wallet secp256k1 private key, hex (the HKDF ikm is its raw bytes)
 */
export function deriveFieldEncryptionKey(privKeyHex: string): Uint8Array {
  const ikm = hexToBytesStrict(privKeyHex);
  const info = new TextEncoder().encode(FIELD_ENCRYPTION_HKDF_INFO);
  return hkdf(sha256, ikm, undefined, info, 32);
}

// =============================================================================
// Envelope encrypt / decrypt
// =============================================================================

/**
 * Encrypt BINARY plaintext into the S6 wire envelope, optionally bound to associated data (AAD):
 * `"enc1." + base64(nonce ‖ ciphertext)` (XChaCha20-Poly1305, random 24-byte nonce). The AAD is
 * authenticated but NOT stored in the envelope — the reader re-derives it from context, so a
 * record decrypted against a different AAD fails the poly1305 tag (E.4: AAD = `transferId:opIndex`
 * binds a checkpoint to its slot, defeating a mis-served / cross-intent replay at the crypto layer).
 */
export function encryptFieldBytes(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): string {
  const nonce = randomBytes(FIELD_ENVELOPE_NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  const packed = new Uint8Array(nonce.length + ciphertext.length);
  packed.set(nonce, 0);
  packed.set(ciphertext, nonce.length);
  return FIELD_ENVELOPE_PREFIX + base64Encode(packed);
}

/**
 * Decrypt an S6 wire envelope to BINARY bytes, requiring the same `aad` used at encrypt time.
 * Any tampering, wrong key, OR wrong AAD throws `SphereError('DECRYPTION_ERROR')`.
 */
export function decryptFieldBytes(key: Uint8Array, envelope: string, aad?: Uint8Array): Uint8Array {
  if (typeof envelope !== 'string' || !envelope.startsWith(FIELD_ENVELOPE_PREFIX)) {
    throw new SphereError('Invalid field envelope: missing "enc1." prefix', 'DECRYPTION_ERROR');
  }
  const packed = base64Decode(envelope.slice(FIELD_ENVELOPE_PREFIX.length));
  if (packed.length < FIELD_ENVELOPE_NONCE_BYTES + POLY1305_TAG_BYTES) {
    throw new SphereError('Invalid field envelope: too short for nonce + tag', 'DECRYPTION_ERROR');
  }
  const nonce = packed.slice(0, FIELD_ENVELOPE_NONCE_BYTES);
  const ciphertext = packed.slice(FIELD_ENVELOPE_NONCE_BYTES);
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch (err) {
    throw new SphereError('Field envelope authentication failed (tampered, wrong key, or wrong AAD)', 'DECRYPTION_ERROR', err);
  }
}

/**
 * Encrypt a UTF-8 string field into the S6 wire envelope (AAD-less). Thin wrapper over
 * {@link encryptFieldBytes} — the memo/nametag/intent-payload path.
 */
export function encryptField(key: Uint8Array, plaintext: string): string {
  return encryptFieldBytes(key, new TextEncoder().encode(plaintext));
}

/**
 * Decrypt an AAD-less S6 wire envelope to a UTF-8 string (memo/nametag/intent payload). Any
 * tampering throws `SphereError('DECRYPTION_ERROR')`.
 */
export function decryptField(key: Uint8Array, envelope: string): string {
  return new TextDecoder().decode(decryptFieldBytes(key, envelope));
}

/**
 * The server-side shape check (ARCHITECTURE §8.3): the value must be a string,
 * carry the `enc1.` prefix, decode as base64, be long enough to hold a nonce +
 * tag, and fit the size cap. The server never sees plaintext — this is the
 * ONLY validation it performs before storing the exact UTF-8 bytes verbatim.
 *
 * Throws `SphereError('VALIDATION_ERROR')` on any violation.
 */
export function assertFieldEnvelopeShape(value: unknown, maxBytes: number = FIELD_ENVELOPE_MAX_BYTES): void {
  if (typeof value !== 'string') {
    throw new SphereError('Field envelope must be a string', 'VALIDATION_ERROR');
  }
  if (!value.startsWith(FIELD_ENVELOPE_PREFIX)) {
    throw new SphereError('Field envelope must start with "enc1."', 'VALIDATION_ERROR');
  }
  if (new TextEncoder().encode(value).length > maxBytes) {
    throw new SphereError(`Field envelope exceeds size cap of ${maxBytes} bytes`, 'VALIDATION_ERROR');
  }
  let packed: Uint8Array;
  try {
    packed = base64Decode(value.slice(FIELD_ENVELOPE_PREFIX.length));
  } catch (err) {
    throw new SphereError('Field envelope payload is not valid base64', 'VALIDATION_ERROR', err);
  }
  if (packed.length < FIELD_ENVELOPE_NONCE_BYTES + POLY1305_TAG_BYTES) {
    throw new SphereError('Field envelope payload too short for nonce + tag', 'VALIDATION_ERROR');
  }
}
