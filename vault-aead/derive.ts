/**
 * AAD framing (lengthDelim, u32be, u64be) + HKDF key derivations for vault-aead.
 *
 * `lengthDelim` prefixes every part with its u32-be length so that distinct
 * field tuples can never collide under concatenation (the AAD must bind each
 * field unambiguously). HKDF-SHA256 matches the repo's existing IPNS pattern
 * (`.js` suffixes, `sha2.js` subpath — mandatory for `@noble/hashes` ^2).
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '../core/crypto';
import { VAULT_AEAD_DOMAIN } from '../vault/contracts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 4-byte big-endian encoding of an unsigned 32-bit integer. */
export function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

/** 8-byte big-endian encoding of an unsigned 64-bit integer. */
export function u64be(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

/**
 * Length-delimited concatenation: each part is encoded as `u32be(len)‖bytes`.
 * The length prefix makes the framing injective — `['a','bc']` and `['ab','c']`
 * yield different outputs, so an AAD built from a field tuple binds each field.
 */
export function lengthDelim(parts: (string | Uint8Array)[]): Uint8Array {
  const encoded = parts.map((p) => (typeof p === 'string' ? utf8(p) : p));
  const total = encoded.reduce((acc, b) => acc + 4 + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of encoded) {
    out.set(u32be(b.length), offset);
    offset += 4;
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

/**
 * Derive the per-network vault AEAD key from the wallet private key:
 * `HKDF-SHA256(walletPriv, info='unicity-vault-aead-v1:'+network, 32)`.
 * Baking the network into the info isolates keys across networks.
 */
export function deriveVaultKey(walletPriv: string, network: string): Uint8Array {
  return hkdf(
    sha256,
    hexToBytes(walletPriv),
    undefined,
    utf8(VAULT_AEAD_DOMAIN + network),
    32,
  );
}

/**
 * Derive a courier key from an ECDH shared-secret x-coordinate:
 * `HKDF-SHA256(ecdhX, info, 32)`.
 */
export function deriveCourierKey(ecdhX: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ecdhX, undefined, utf8(info), 32);
}
