/**
 * Courier-envelope seal/open + base64(nonce24‖ct) wire framing (findings #10, #12).
 *
 * The sender derives a courier key from its ECDH-x shared secret with the
 * recipient, seals the transfer with AAD bound to
 * `(network, senderPubkey, recipientPubkey, entryId)`, and frames it as a single
 * `base64(nonce24‖ct)` string — the on-wire `ciphertext`. The recipient
 * re-derives the identical key from its own ECDH side, slices the first 24 bytes
 * back off as the nonce, and rebuilds the SAME AAD; any 1-byte tamper of the
 * entryId (AAD) or of the packed ciphertext fails the Poly1305 tag.
 */

import { randomBytes } from '@noble/hashes/utils.js';
import { seal, open } from './aead';
import { deriveCourierKey, lengthDelim } from './derive';
import { ecdhX } from './ecdh';
import { COURIER_AEAD_DOMAIN } from '../vault/contracts';

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
export function packCourier(nonce: Uint8Array, ct: Uint8Array): string {
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return Buffer.from(out).toString('base64');
}

/** Slice the first 24 bytes back off as nonce, remainder as ct. */
export function unpackCourier(b64: string): PackedCourier {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  return { nonce: bytes.slice(0, 24), ct: bytes.slice(24) };
}

/**
 * Build the AAD that binds a courier envelope. `network` is the FIRST field, so it
 * is what provides cross-network isolation: the courier AEAD KEY deliberately omits
 * network (see `deriveCourierKey`), and the AAD binds it instead — a `testnet2`
 * envelope cannot be opened under a `mainnet` AAD (finding courier-key-omits-network).
 */
function courierAad(p: { network: string; senderPubkey: string; recipientPubkey: string; entryId: string }): Uint8Array {
  return lengthDelim([p.network, p.senderPubkey, p.recipientPubkey, p.entryId]);
}

/**
 * Seal a courier envelope; returns the packed `base64(nonce24‖ct)` string.
 * `nonce` is optional — supply a fixed one for deterministic test vectors;
 * production callers omit it so a fresh random nonce is drawn.
 */
export function sealCourierEnvelope(params: SealCourierParams, nonce?: Uint8Array): string {
  const key = deriveCourierKey(ecdhX(params.senderPriv, params.recipientPubkey), COURIER_AEAD_DOMAIN);
  const n = nonce ?? randomBytes(24);
  const aad = courierAad(params);
  const ct = seal(key, n, params.plaintext, aad);
  return packCourier(n, ct);
}

/** Open a packed courier envelope; returns the plaintext. Throws on any tamper. */
export function openCourierEnvelope(params: OpenCourierParams): Uint8Array {
  const key = deriveCourierKey(ecdhX(params.recipientPriv, params.senderPubkey), COURIER_AEAD_DOMAIN);
  const { nonce, ct } = unpackCourier(params.ciphertext);
  const aad = courierAad(params);
  return open(key, nonce, ct, aad);
}
