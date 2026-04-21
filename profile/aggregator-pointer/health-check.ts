/**
 * HEALTH_CHECK_REQUEST_ID derivation (T-A6c, SPEC §13 W12).
 *
 *   healthCheckRequestId = SHA-256(bytes_of("profile-pointer-health-check") || signingPubKey)
 *
 * Used by isReachable() to probe the aggregator without touching any
 * wallet-specific requestId space. Output is 32 bytes.
 */

import { sha256 } from '@noble/hashes/sha2.js';

const HEALTH_CHECK_INFO = new TextEncoder().encode('profile-pointer-health-check'); // 28 bytes

/**
 * Compute HEALTH_CHECK_REQUEST_ID for the given signing pubkey.
 * Deterministic: same signingPubKey → same requestId.
 */
export function deriveHealthCheckRequestId(signingPubKey: Uint8Array): Uint8Array {
  if (signingPubKey.length !== 33) {
    throw new Error(`signingPubKey must be 33-byte compressed secp256k1, got ${signingPubKey.length}`);
  }
  const preimage = new Uint8Array(HEALTH_CHECK_INFO.length + signingPubKey.length);
  preimage.set(HEALTH_CHECK_INFO, 0);
  preimage.set(signingPubKey, HEALTH_CHECK_INFO.length);
  return sha256(preimage);
}
