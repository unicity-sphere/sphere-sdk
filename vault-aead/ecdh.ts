/**
 * On-curve recipient-pubkey validation + ECDH-x shared secret (finding #21).
 *
 * `assertOnCurve` rejects a recipient pubkey that is not a valid curve point
 * (so we never derive a key against attacker-chosen garbage). `ecdhX` returns
 * the 32-byte x-coordinate of the ECDH shared point.
 *
 * @noble/curves v2 gotcha: `getPublicKey`/`getSharedSecret` take Uint8Array,
 * NOT hex strings (a hex string throws) — so we `hexToBytes` first.
 * `getSharedSecret` returns a 33-byte COMPRESSED point (byte 0 = 0x02/0x03
 * parity prefix); the x-coordinate is bytes `[1, 33)` — `.slice(0, 32)` is
 * wrong (it keeps the prefix and drops the last x byte).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '../core/crypto';

/**
 * Throw if `pubHex` is not a valid secp256k1 point. Uses `Point.fromHex`, which
 * rejects bad parity prefixes and off-curve x-coordinates.
 */
export function assertOnCurve(pubHex: string): void {
  // Throws on a malformed / off-curve point.
  secp256k1.Point.fromHex(pubHex);
}

/**
 * ECDH x-coordinate: the 32-byte x of the shared point between `privHex` and
 * `pubHex`. Validates `pubHex` is on-curve first.
 */
export function ecdhX(privHex: string, pubHex: string): Uint8Array {
  assertOnCurve(pubHex);
  const shared = secp256k1.getSharedSecret(hexToBytes(privHex), hexToBytes(pubHex));
  // shared is a 33-byte compressed point: [parityPrefix, x0..x31]. Drop the
  // prefix to get the 32-byte x-coordinate.
  return shared.slice(1, 33);
}
