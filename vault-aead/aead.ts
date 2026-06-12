/**
 * AEAD seal/open over XChaCha20-Poly1305 (24-byte nonce, AAD).
 *
 * XChaCha (extended nonce) is used — NOT ChaCha20-Poly1305, which takes a
 * 12-byte nonce. The 24-byte nonce lets us draw nonces at random without a
 * birthday-bound concern. `seal` returns ciphertext‖tag; `open` verifies the
 * Poly1305 tag and the AAD, throwing on any mismatch.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

/**
 * Authenticated-encrypt `plaintext` under `key` (32 bytes) and `nonce`
 * (24 bytes), binding `aad`. Returns `ciphertext‖tag`.
 */
export function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/**
 * Verify + decrypt `ciphertext` under `key`/`nonce`/`aad`. Throws if the tag or
 * AAD does not match.
 */
export function open(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}
