/**
 * L3 Predicate Address Derivation
 *
 * Standalone module so backends can import the derivation primitive without
 * pulling in the full Sphere wallet (and its heavy module graph).
 */
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference';

/** Token type for Unicity network (used for L3 predicate address derivation) */
const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

/** Compressed secp256k1 pubkey shape: 33 bytes hex (66 chars), leading 02 or 03. */
export const COMPRESSED_PUBKEY_RE = /^(02|03)[0-9a-fA-F]{64}$/;

/**
 * Compute the Unicity L3 DIRECT:// address that corresponds to a given
 * compressed secp256k1 public key.
 *
 * Deterministic — the underlying primitive `UnmaskedPredicateReference.create`
 * only uses the public key, so the private key is never needed. This lets
 * a backend trust only one thing from the client (the chain pubkey, whose
 * ownership the client proves via signature) and derive everything else
 * locally. Closes the entire class of "client claims an identifier the
 * server can't verify" bugs at the API level.
 *
 * @param chainPubkey 33-byte compressed secp256k1 pubkey, hex-encoded
 *                    (66 chars, leading 02 or 03).
 * @throws if chainPubkey doesn't match the compressed-secp256k1 format.
 */
export async function computeDirectAddressFromChainPubkey(chainPubkey: string): Promise<string> {
  if (typeof chainPubkey !== 'string' || !COMPRESSED_PUBKEY_RE.test(chainPubkey)) {
    throw new Error(
      `computeDirectAddressFromChainPubkey: chainPubkey must be 66-char hex with 02/03 prefix, got "${String(chainPubkey).slice(0, 12)}..."`,
    );
  }

  const tokenTypeBytes = Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex');
  const tokenType = new TokenType(tokenTypeBytes);
  const publicKeyBytes = Buffer.from(chainPubkey, 'hex');

  const predicateRef = await UnmaskedPredicateReference.create(
    tokenType,
    'secp256k1',
    publicKeyBytes,
    HashAlgorithm.SHA256,
  );

  return (await predicateRef.toAddress()).toString();
}
