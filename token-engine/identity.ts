/**
 * token-engine/identity.ts — legacy `DIRECT://` identity address (Path A, A6).
 *
 * Reproduces the wallet's stable L3 identity address EXACTLY as the existing
 * core/Sphere.deriveL3PredicateAddress does, but as ONE shared, pubkey-based
 * helper. Quest XP is keyed on this address, so it MUST stay byte-identical
 * across the migration — the golden-vector test locks it.
 *
 * It reuses the SAME v1 primitive the wallet has always used
 * (`UnmaskedPredicateReference`) — not a reimplementation. v1 is the only thing
 * here outside the v2 engine boundary; at the final v1 removal this single call
 * is swapped for a vendored, byte-exact recipe (still golden-locked). The
 * address is a pure function of the compressed secp256k1 public key (plus the
 * fixed Unicity token type, the `secp256k1` algorithm and SHA-256).
 */

import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';

/** Unicity L3 token type used for identity-address derivation (immutable). */
const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
/** Value of v1 `SigningService.algorithm` for secp256k1 (verified against the SDK). */
const SIGNING_ALGORITHM = 'secp256k1';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derive the legacy `DIRECT://` identity address for a compressed (33-byte)
 * secp256k1 public key. Deterministic; stable across the migration (Path A).
 */
export async function deriveDirectAddress(publicKey: Uint8Array): Promise<string> {
  const tokenType = new TokenType(hexToBytes(UNICITY_TOKEN_TYPE_HEX));
  const reference = await UnmaskedPredicateReference.create(
    tokenType,
    SIGNING_ALGORITHM,
    publicKey,
    HashAlgorithm.SHA256,
  );
  return (await reference.toAddress()).toString();
}
