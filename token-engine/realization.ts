// SHA-pinned from unicity-sphere/sphere-sdk main@ce758f6b — do not modify without a re-sync note.
/**
 * token-engine/realization.ts — deterministic realization values (Part E.1).
 *
 * Every "random" value a transfer/split binds to (stateMask, per-output salt,
 * tokenType where not fixed, the split burn mask) is derived from the wallet
 * key + a pre-persisted transferId instead of `crypto.getRandomValues`, so the
 * exact transaction can be rebuilt later — on any device holding the seed.
 * That is what makes an interrupted transfer resumable (sdk-changes Part E,
 * ARCHITECTURE §8.1): re-running with the same transferId reproduces the
 * byte-identical transaction, and the aggregator's existing proof applies.
 *
 * Derivation (mirrors impl/shared/ipfs/ipns-key-derivation.ts — same
 * @noble/hashes HKDF, no salt):
 *
 *   HKDF-SHA256(ikm = privKey, info = "sphere-realization-v1:" + transferId
 *               + ":" + field + ":" + index)[0..32)
 *
 * `field` is the domain separator between the values of one transfer;
 * `index` separates per-output values (split salts). The output is
 * per-transfer unique and unpredictable to outsiders (derived from the secret
 * key — no privacy/unlinkability regression), yet reproducible by the owner.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { HexConverter } from './sdk';

/** HKDF info prefix — versioned; the same formula appears in ARCHITECTURE §8.1. */
export const REALIZATION_HKDF_INFO_PREFIX = 'sphere-realization-v1';

/** Domain separator between the realization values of one transfer. */
export type RealizationField = 'stateMask' | 'salt' | 'tokenType' | 'burn';

/**
 * Derive one 32-byte realization value.
 *
 * @param privKeyHex - wallet secp256k1 private key, hex (the HKDF ikm is its raw bytes)
 * @param transferId - client-generated UUIDv4 in canonical lowercase string form
 *                     (validated by the engine before any derivation)
 * @param index - per-output index within the transfer (0 for single-value fields)
 * @param field - which value of the transfer is being derived
 * @returns 32 deterministic bytes
 */
export function deriveRealization(
  privKeyHex: string,
  transferId: string,
  index: number,
  field: RealizationField,
): Uint8Array {
  const ikm = HexConverter.decode(privKeyHex);
  const info = new TextEncoder().encode(`${REALIZATION_HKDF_INFO_PREFIX}:${transferId}:${field}:${index}`);
  return hkdf(sha256, ikm, undefined, info, 32);
}
