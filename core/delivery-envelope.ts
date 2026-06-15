/**
 * core/delivery-envelope.ts — recipient-addressed delivery envelopes
 * (sdk-changes S6; ARCHITECTURE §8.3).
 *
 * The mailbox `memo` is the one S6 field that is NOT self-scoped: it is written
 * by the SENDER but must be readable by the RECIPIENT (a different wallet). The
 * wallet-scoped field key ({@link deriveFieldEncryptionKey}) is wrong for it —
 * a memo encrypted with the sender's key can never be opened by the recipient.
 *
 * So delivery envelopes key off an **ECDH-to-recipient** shared secret instead:
 *
 *   key = HKDF-SHA256(ikm = secp256k1.getSharedSecret(senderPriv, recipientPub),
 *                     info = "sphere-deliveryenc-v1")          [0..32)
 *
 * ECDH is symmetric, so the recipient re-derives the identical key from
 * `(recipientPriv, senderPub)` — `entry.senderPubkey` on the wire. A self-send
 * (sender == recipient) is just `ECDH(priv, ownPub)` on both sides and still
 * round-trips.
 *
 * Crucially, the **wire bytes stay the SAME `enc1.` envelope** the self-scoped
 * field encryption uses (XChaCha20-Poly1305, random 24-byte nonce — reused
 * verbatim from {@link encryptField}/{@link decryptField}). The backend cannot
 * tell a delivery envelope from a self-scoped one and stores both opaquely:
 * operator-blind, and NO backend change (the wire prefix and size cap are
 * unchanged).
 *
 * The plaintext is a compact JSON bundle — `{ n?: senderNametag, t?: memo }`
 * (absent fields omitted) — mirroring the Nostr `{ senderNametag, text }`
 * structure so both rails carry the same two facts.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { encryptField, decryptField } from './field-encryption';
import { SphereError } from './errors';

/** HKDF info label for the ECDH-derived delivery key — versioned, distinct from S6's. */
export const DELIVERY_ENCRYPTION_HKDF_INFO = 'sphere-deliveryenc-v1';

/** The decrypted delivery bundle (sender nametag + memo; either may be absent). */
export interface DeliveryBundle {
  /** The sender's own nametag (without a leading `@`). */
  senderNametag?: string;
  /** The human memo attached to the transfer. */
  memo?: string;
}

function hexToBytesStrict(hex: string, what: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new SphereError(`Invalid ${what} hex for delivery-envelope key derivation`, 'INVALID_CONFIG');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Derive the 32-byte symmetric key for a delivery envelope between `privKeyHex`
 * and `peerPubkeyHex` (a 33-byte compressed secp256k1 pubkey, hex):
 *
 *   HKDF-SHA256(ikm = secp256k1.getSharedSecret(priv, peerPub), info = "sphere-deliveryenc-v1")
 *
 * Symmetric in (priv, peerPub) by ECDH, so sender and recipient derive the same
 * key; reused for a self-send (peerPub == own pubkey).
 */
export function deriveDeliveryEncryptionKey(privKeyHex: string, peerPubkeyHex: string): Uint8Array {
  const priv = hexToBytesStrict(privKeyHex, 'private key');
  const peerPub = hexToBytesStrict(peerPubkeyHex, 'peer public key');
  // getSharedSecret returns the 33-byte compressed shared point (incl. its
  // 02/03 prefix). HKDF the whole thing — the prefix is deterministic for a
  // fixed pair and folds into the derived key identically on both sides.
  const shared = secp256k1.getSharedSecret(priv, peerPub);
  const info = new TextEncoder().encode(DELIVERY_ENCRYPTION_HKDF_INFO);
  return hkdf(sha256, shared, undefined, info, 32);
}

/**
 * Encrypt a delivery bundle into the S6 `enc1.` wire envelope under the
 * ECDH-derived key. Returns `undefined` when there is nothing to carry (no
 * nametag and no memo) — callers then omit the field entirely.
 */
export function encryptDeliveryBundle(key: Uint8Array, bundle: DeliveryBundle): string | undefined {
  const compact: { n?: string; t?: string } = {};
  if (bundle.senderNametag !== undefined && bundle.senderNametag !== '') compact.n = bundle.senderNametag;
  if (bundle.memo !== undefined && bundle.memo !== '') compact.t = bundle.memo;
  if (compact.n === undefined && compact.t === undefined) return undefined;
  return encryptField(key, JSON.stringify(compact));
}

/**
 * Decrypt + parse a delivery envelope under the ECDH-derived key. Throws a
 * `SphereError('DECRYPTION_ERROR')` on a wrong key, tamper, or non-JSON
 * plaintext — the receive loop treats that as "not for me / unreadable" and
 * drops it, never as a fatal error.
 */
export function decryptDeliveryBundle(key: Uint8Array, envelope: string): DeliveryBundle {
  const plaintext = decryptField(key, envelope);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new SphereError('Delivery envelope payload is not valid JSON', 'DECRYPTION_ERROR', err);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SphereError('Delivery envelope payload is not an object', 'DECRYPTION_ERROR');
  }
  const obj = parsed as { n?: unknown; t?: unknown };
  const bundle: DeliveryBundle = {};
  if (typeof obj.n === 'string') bundle.senderNametag = obj.n;
  if (typeof obj.t === 'string') bundle.memo = obj.t;
  return bundle;
}
