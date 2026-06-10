/**
 * token-engine/identity.ts — legacy `DIRECT://` identity address (Path A, A6).
 *
 * Reproduces the wallet's stable L3 identity address EXACTLY as the v1
 * `UnmaskedPredicateReference` → `DirectAddress` path did, but VENDORED (no v1 SDK
 * import) so the v1 dependency can be removed at the final cut-over. Quest XP is
 * keyed on this address, so it MUST stay byte-identical — the multi-vector
 * golden test (identity.test.ts) locks it.
 *
 * The recipe (recovered from v1 `UnmaskedPredicateReference.create` + `DirectAddress.create`):
 *   ref     = SHA-256( CBOR[ bstr([UNMASKED]), bstr(tokenType.toCBOR()),
 *                            tstr("secp256k1"), uint(SHA256), bstr(publicKey) ] )
 *   imprint = 0x0000 ‖ ref                    (SHA-256 DataHash imprint)
 *   address = "DIRECT://" ‖ hex(imprint) ‖ hex( SHA-256(imprint)[0:4] )
 *
 * The CBOR + SHA-256 are standard, so v2's CborSerializer/DataHasher produce
 * byte-identical output; the v1 enum values (UNMASKED=0, HashAlgorithm.SHA256=0)
 * and the SHA-256 imprint prefix (0x0000) are pinned as constants.
 */

import { CborSerializer, DataHasher, HashAlgorithm, HexConverter } from './sdk';

/**
 * Unicity L3 token type used for identity-address derivation (immutable).
 * Also pinned as the fixed token type of self-issued Unicity ID tokens
 * (token-engine/unicity-id.ts) — the same constant the v1 nametag mint used,
 * keeping the mint deterministic per (name, wallet key).
 */
export const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
/** v1 `SigningService.algorithm` for secp256k1. */
const SIGNING_ALGORITHM = 'secp256k1';
/** v1 `EmbeddedPredicateType.UNMASKED`. */
const EMBEDDED_PREDICATE_UNMASKED = 0;
/** v1 `HashAlgorithm.SHA256` (as encoded in the reference CBOR). */
const HASH_ALGORITHM_SHA256 = 0n;
/** v1 SHA-256 `DataHash` imprint algorithm tag (2-byte big-endian). */
const SHA256_IMPRINT_PREFIX = new Uint8Array([0x00, 0x00]);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new DataHasher(HashAlgorithm.SHA256)
    .update(data)
    .digest()
    .then((h) => h.data);
}

/**
 * Derive the legacy `DIRECT://` identity address for a compressed (33-byte)
 * secp256k1 public key. Deterministic; byte-identical to the v1 path (Path A).
 */
export async function deriveDirectAddress(publicKey: Uint8Array): Promise<string> {
  const tokenTypeCbor = CborSerializer.encodeByteString(hexToBytes(UNICITY_TOKEN_TYPE_HEX)); // v1 TokenType.toCBOR()
  const reference = CborSerializer.encodeArray(
    CborSerializer.encodeByteString(new Uint8Array([EMBEDDED_PREDICATE_UNMASKED])),
    CborSerializer.encodeByteString(tokenTypeCbor),
    CborSerializer.encodeTextString(SIGNING_ALGORITHM),
    CborSerializer.encodeUnsignedInteger(HASH_ALGORITHM_SHA256),
    CborSerializer.encodeByteString(publicKey),
  );

  const refHash = await sha256(reference);
  const imprint = new Uint8Array([...SHA256_IMPRINT_PREFIX, ...refHash]);
  const checksum = (await sha256(imprint)).slice(0, 4);

  return `DIRECT://${HexConverter.encode(imprint)}${HexConverter.encode(checksum)}`;
}
