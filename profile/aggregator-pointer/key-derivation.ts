/**
 * Key-derivation chain (T-A4, T-A5, T-A6) — SPEC §4.
 *
 *   walletPrivateKey (via MasterPrivateKey) → HKDF-Extract + Expand
 *     → pointerSecret (32 bytes)
 *   pointerSecret → HKDF-Expand with distinct info strings
 *     → signingSeed, xorSeed, padSeed (32 bytes each, pairwise distinct; H12).
 *
 * Per-version per-side material (stateHashDigest, xorKey) and
 * per-version paddingBytes are produced from xorSeed/padSeed and v.
 */

import { hkdf, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  PAD_SEED_INFO,
  PROFILE_POINTER_HKDF_INFO,
  SIGNING_SEED_INFO,
  XOR_SEED_INFO,
  CID_MAX_BYTES,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import { type MasterPrivateKey, assertAuthorizedMasterKey } from './master-key.js';
import { SecretKey } from './secret-key.js';
import type { Side, PointerVersion } from './types.js';

export interface PointerKeyMaterial {
  readonly pointerSecret: SecretKey;
  readonly signingSeed: SecretKey;
  readonly xorSeed: SecretKey;
  readonly padSeed: SecretKey;
}

/**
 * Derive pointerSecret and the three subkeys from the wallet master key.
 * Every return value is a SecretKey wrapper; callers must .reveal()
 * only when passing to crypto primitives.
 *
 * Requires the caller to construct the MasterPrivateKey via
 * createMasterPrivateKey() (T-A5b registry) — raw cast bytes are
 * rejected with PROTOCOL_ERROR.
 */
export function derivePointerKeyMaterial(masterKey: MasterPrivateKey): PointerKeyMaterial {
  assertAuthorizedMasterKey(masterKey);

  // masterKey.bytes now returns a DEFENSIVE COPY (steelman remediation).
  // Wipe it post-HKDF to narrow heap residue window.
  const walletPrivateKey = masterKey.bytes;
  try {
    const pointerSecretBytes = hkdf(sha256, walletPrivateKey, new Uint8Array(0), PROFILE_POINTER_HKDF_INFO, 32);

    const signingSeedBytes = expand(sha256, pointerSecretBytes, SIGNING_SEED_INFO, 32);
    const xorSeedBytes = expand(sha256, pointerSecretBytes, XOR_SEED_INFO, 32);
    const padSeedBytes = expand(sha256, pointerSecretBytes, PAD_SEED_INFO, 32);

    return {
      pointerSecret: new SecretKey(pointerSecretBytes, 'pointerSecret'),
      signingSeed: new SecretKey(signingSeedBytes, 'signingSeed'),
      xorSeed: new SecretKey(xorSeedBytes, 'xorSeed'),
      padSeed: new SecretKey(padSeedBytes, 'padSeed'),
    };
  } finally {
    walletPrivateKey.fill(0);
  }
}

/** big-endian 4-byte encoding of v (§4.4, §4.5). */
export function be32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xff_ff_ff_ff) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE,
      `be32 input out of range: ${n}`,
    );
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * stateHashDigest_{side, v} = SHA256(xorSeed || [side] || be32(v) || "state")
 * per SPEC §4.4. 42-byte preimage, 32-byte output.
 */
export function deriveStateHashDigest(xorSeed: SecretKey, side: Side, v: PointerVersion): Uint8Array {
  const seed = xorSeed.reveal();
  try {
    return sha256(concat(seed, new Uint8Array([side]), be32(v), utf8('state')));
  } finally {
    seed.fill(0);
  }
}

/**
 * xorKey_{side, v} = SHA256(xorSeed || [side] || be32(v) || "xor")
 * per SPEC §4.5. 40-byte preimage (32 + 1 + 4 + 3), 32-byte output.
 */
export function deriveXorKey(xorSeed: SecretKey, side: Side, v: PointerVersion): Uint8Array {
  const seed = xorSeed.reveal();
  try {
    return sha256(concat(seed, new Uint8Array([side]), be32(v), utf8('xor')));
  } finally {
    seed.fill(0);
  }
}

/**
 * paddingBytes_v = HKDF-Expand(padSeed, be32(v) || "pad", 63 - cidLen)
 * per SPEC §4.6. Length = CID_MAX_BYTES - cidLen bytes.
 *
 * Deterministic across retries of the same v.
 */
export function derivePaddingBytes(padSeed: SecretKey, v: PointerVersion, cidLen: number): Uint8Array {
  if (cidLen < 0 || cidLen > CID_MAX_BYTES) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CID_TOO_LARGE,
      `cidLen out of range: ${cidLen} (max ${CID_MAX_BYTES})`,
    );
  }
  const padLength = CID_MAX_BYTES - cidLen;
  if (padLength === 0) {
    return new Uint8Array(0);
  }
  const seed = padSeed.reveal();
  try {
    return expand(sha256, seed, concat(be32(v), utf8('pad')), padLength);
  } finally {
    seed.fill(0);
  }
}
