/**
 * Wire key (§5.2) — operator-blind vault entry keys.
 *
 * The vault server stores entries keyed by an opaque `wireKey`, never by a
 * plaintext token id, so the operator cannot correlate a user's token IDs.
 *
 *   wireKey(walletPriv, network, plainKey)
 *     = HMAC-SHA256(
 *         HKDF-SHA256(walletPriv, info='unicity-vault-wirekey-v1:'+network),
 *         utf8(plainKey)
 *       )                                                    -> 64-hex
 *
 * Baking the network into the HKDF info isolates wire keys across networks
 * (the same plainKey maps to a different wire key per network).
 */

import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '../../core/crypto';
import { WIREKEY_DOMAIN } from '../../vault/contracts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Derive the opaque wire key for a plaintext vault key.
 * Returns 64-hex (HMAC-SHA256 output).
 */
export function wireKey(walletPriv: string, network: string, plainKey: string): string {
  const prk = hkdf(
    sha256,
    hexToBytes(walletPriv),
    undefined,
    utf8(WIREKEY_DOMAIN + network),
    32,
  );
  return bytesToHex(hmac(sha256, prk, utf8(plainKey)));
}
