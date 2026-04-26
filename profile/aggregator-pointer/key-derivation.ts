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

// Steelman¹⁹: cache Uint8Array.prototype.fill at module load. Defends
// against late prototype-pollution turning every secret-wipe into a
// no-op or a leak. All wipes in this module must use safeWipe().
//
// Steelman²⁰ critical #2: safeWipe() itself MUST NOT throw or the
// catch-path cleanup chain breaks. Wrap the inner fill in try/catch so
// a hostile prototype mutation (or a Proxy on `buf`) cannot abort the
// cleanup loop and leak SecretKey wrappers downstream.
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
function safeWipe(buf: Uint8Array | null | undefined): void {
  if (!buf) return;
  try {
    TYPED_ARRAY_FILL.call(buf, 0);
  } catch { /* best-effort wipe; never throw out of cleanup */ }
}

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

  // masterKey.bytes returns a DEFENSIVE COPY. Wipe it post-HKDF to narrow
  // heap residue window.
  const walletPrivateKey = masterKey.bytes;
  // Declare intermediates outside the try so the catch block can zero them on
  // any partial-derivation error path.
  let pointerSecretBytes: Uint8Array | null = null;
  let signingSeedBytes: Uint8Array | null = null;
  let xorSeedBytes: Uint8Array | null = null;
  let padSeedBytes: Uint8Array | null = null;
  // Steelman¹⁹ warning #5: track each SecretKey wrapper as it's built so
  // a constructor failure mid-sequence can zeroize the partially-built
  // ones (each holds a defensive copy of the bare bytes).
  const builtKeys: SecretKey[] = [];

  // Steelman²⁰ critical #1: success flag + try/finally (NOT try/catch+finally)
  // unifies all cleanup. Previous structure had separate success-path and
  // catch-path wipes; if any safeWipe in the catch threw, subsequent wipes
  // and the SecretKey-wrapper zeroization loop were skipped, leaking four
  // 32-byte derived secrets. With try/finally, every wipe and the
  // wrapper-cleanup loop ALWAYS run; safeWipe is now also throw-proof
  // (see TYPED_ARRAY_FILL definition).  An index-based wrapper loop
  // avoids dependency on `Array.prototype[Symbol.iterator]` which could
  // be polluted by attacker code.
  let success = false;
  try {
    pointerSecretBytes = hkdf(sha256, walletPrivateKey, new Uint8Array(0), PROFILE_POINTER_HKDF_INFO, 32);
    signingSeedBytes = expand(sha256, pointerSecretBytes, SIGNING_SEED_INFO, 32);
    xorSeedBytes = expand(sha256, pointerSecretBytes, XOR_SEED_INFO, 32);
    padSeedBytes = expand(sha256, pointerSecretBytes, PAD_SEED_INFO, 32);

    // Build SecretKey wrappers SEQUENTIALLY (not via object-literal
    // evaluation order which could short-circuit on partial throw). Each
    // wrapper copies the bytes via SecretKey(bytes) → new Uint8Array(bytes).
    // SAFETY: wipes of the bare buffers (in finally) MUST NOT happen before
    // these constructors run, because expand()/hkdf() consume their inputs
    // synchronously and SecretKey's ctor deep-copies — but the BARE buffers
    // remain populated until the finally block.
    const pointerSecret = new SecretKey(pointerSecretBytes, 'pointerSecret');
    builtKeys.push(pointerSecret);
    const signingSeed = new SecretKey(signingSeedBytes, 'signingSeed');
    builtKeys.push(signingSeed);
    const xorSeed = new SecretKey(xorSeedBytes, 'xorSeed');
    builtKeys.push(xorSeed);
    const padSeed = new SecretKey(padSeedBytes, 'padSeed');
    builtKeys.push(padSeed);

    success = true;
    return { pointerSecret, signingSeed, xorSeed, padSeed };
  } finally {
    // Always wipe the bare buffers — on success they're redundant copies of
    // derived secrets; on failure they hold partial derivation residue.
    safeWipe(pointerSecretBytes);
    safeWipe(signingSeedBytes);
    safeWipe(xorSeedBytes);
    safeWipe(padSeedBytes);
    // ON FAILURE only, zero the partially-built SecretKey wrappers (each
    // holds a deep copy that the caller will never see, so it must not
    // linger). Index-based loop avoids iterator-protocol pollution.
    if (!success) {
      for (let i = 0; i < builtKeys.length; i++) {
        try { builtKeys[i].zeroize(); } catch { /* best effort */ }
      }
    }
    safeWipe(walletPrivateKey);
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
    safeWipe(seed);
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
    safeWipe(seed);
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
    safeWipe(seed);
  }
}
