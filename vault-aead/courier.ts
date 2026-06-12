/**
 * Courier-envelope seal/open + base64(nonce24‖ct) wire framing.
 * The on-wire courier `ciphertext` is the single packed base64 string.
 * Filled in Task 1.5.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

export interface SealCourierParams {
  network: string;
  senderPriv: string;
  senderPubkey: string;
  recipientPubkey: string;
  entryId: string;
  plaintext: Uint8Array;
}

export interface OpenCourierParams {
  network: string;
  recipientPriv: string;
  senderPubkey: string;
  recipientPubkey: string;
  entryId: string;
  ciphertext: string;
}

export interface PackedCourier {
  nonce: Uint8Array;
  ct: Uint8Array;
}

/** Pack a 24-byte nonce and ciphertext into a single base64 string. */
export function packCourier(_nonce: Uint8Array, _ct: Uint8Array): string {
  throw new Error('not implemented');
}

/** Slice the first 24 bytes back off as nonce, remainder as ct. */
export function unpackCourier(_b64: string): PackedCourier {
  throw new Error('not implemented');
}

/** Seal a courier envelope; returns the packed base64 ciphertext string. */
export function sealCourierEnvelope(_params: SealCourierParams): string {
  throw new Error('not implemented');
}

/** Open a packed courier envelope; returns the plaintext. */
export function openCourierEnvelope(_params: OpenCourierParams): Uint8Array {
  throw new Error('not implemented');
}
