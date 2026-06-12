/**
 * Courier entryId derivation (§6.2) — HMAC over the ECDH shared secret.
 *
 *   K_entry = HKDF-SHA256(ecdhX(senderPriv, recipientPub), 'unicity-courier-entryid-v1')
 *   entryId = HMAC-SHA256(K_entry, tokenId ‖ stateHash)                       -> 64-hex
 *
 * `stateHash` is derived EXACTLY as `PaymentsModule.tryParseBlobKeys` does
 * (`sha256(bytesToHex(blob.token), 'hex')`) so the sender and recipient agree on
 * the per-state binding without a new engine method. The operator lacks the ECDH
 * secret → it cannot correlate an entryId with an on-chain token (privacy), and an
 * attacker cannot pre-compute an entryId to squat the deposit slot.
 *
 * `.js` suffixes on `@noble/*` subpaths are mandatory for `@noble/hashes` ^2.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { sha256, bytesToHex, hexToBytes } from '../../core/crypto';
import { decodeTokenBlob } from '../../token-engine/token-blob';
import { ecdhX } from '../../vault-aead/ecdh';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** HKDF info for the courier entryId key. */
const ENTRYID_INFO = 'unicity-courier-entryid-v1';

/**
 * The per-state hash bound into the entryId — IDENTICAL to the value
 * `PaymentsModule.tryParseBlobKeys` computes: `sha256(bytesToHex(blob.token))`.
 *
 * @param tokenBlobHex - hex of CBOR(TokenBlob), the V2_TRANSFER payload blob.
 */
export function courierStateHash(tokenBlobHex: string): string {
  const blob = decodeTokenBlob(hexToBytes(tokenBlobHex));
  return sha256(bytesToHex(blob.token), 'hex');
}

/**
 * Compute the courier entryId for a deposit.
 *
 * @param senderPriv    - sender spend private key (64-hex).
 * @param recipientPub  - recipient compressed chain pubkey (66-hex).
 * @param tokenBlobHex  - hex of CBOR(TokenBlob), the V2_TRANSFER payload blob.
 * @returns 64-hex entryId.
 */
export function courierEntryId(senderPriv: string, recipientPub: string, tokenBlobHex: string): string {
  const blob = decodeTokenBlob(hexToBytes(tokenBlobHex));
  const stateHash = sha256(bytesToHex(blob.token), 'hex');
  const kEntry = hkdf(nobleSha256, ecdhX(senderPriv, recipientPub), undefined, utf8(ENTRYID_INFO), 32);
  // tokenId ‖ stateHash, both as their utf8 hex-string bytes (the values the
  // sender and recipient both hold as strings — see tryParseBlobKeys).
  const msg = utf8(blob.tokenId + stateHash);
  return bytesToHex(hmac(nobleSha256, kEntry, msg));
}
