/**
 * AEAD seal/open over XChaCha20-Poly1305 (24-byte nonce, AAD).
 * Filled in Task 1.1.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

export function seal(
  _key: Uint8Array,
  _nonce: Uint8Array,
  _plaintext: Uint8Array,
  _aad: Uint8Array,
): Uint8Array {
  throw new Error('not implemented');
}

export function open(
  _key: Uint8Array,
  _nonce: Uint8Array,
  _ciphertext: Uint8Array,
  _aad: Uint8Array,
): Uint8Array {
  throw new Error('not implemented');
}
