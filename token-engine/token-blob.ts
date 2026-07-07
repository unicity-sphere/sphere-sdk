// SHA-pinned from unicity-sphere/sphere-sdk main@ce758f6b — do not modify without a re-sync note.
/**
 * token-engine/token-blob.ts — storage/transport codec for a wallet token.
 *
 * A {@link TokenBlob} is `{ v, network, tokenId, token }` where `token` is the v2
 * `Token.toCBOR()` bytes and `tokenId` is the genesis-stable id (stored so dedup /
 * listing / tombstone keys need no engine call). This codec wraps it in a
 * sphere-private CBOR envelope so the wallet's own storage format can version
 * independently of the SDK's token CBOR. The decoded value is re-derivable from
 * `token`, so it is NOT stored here.
 */

import { CborDeserializer, CborError, CborSerializer } from './sdk';
import type { TokenBlob } from './types';

/** Sphere-private CBOR tag (distinct from SpherePaymentData's 39050). */
const TOKEN_BLOB_TAG = 39051n;
/** Current blob envelope version. */
export const TOKEN_BLOB_VERSION = 1;

/** Encode a blob as `tag(39051)[ v, network, tokenId, token ]`. */
export function encodeTokenBlob(blob: TokenBlob): Uint8Array {
  return CborSerializer.encodeTag(
    TOKEN_BLOB_TAG,
    CborSerializer.encodeArray(
      CborSerializer.encodeUnsignedInteger(BigInt(blob.v)),
      CborSerializer.encodeUnsignedInteger(BigInt(blob.network)),
      CborSerializer.encodeTextString(blob.tokenId),
      CborSerializer.encodeByteString(blob.token),
    ),
  );
}

/** Decode a blob produced by {@link encodeTokenBlob}. */
export function decodeTokenBlob(bytes: Uint8Array): TokenBlob {
  const tag = CborDeserializer.decodeTag(bytes);
  if (tag.tag !== TOKEN_BLOB_TAG) {
    throw new CborError(`Invalid TokenBlob tag: ${tag.tag}`);
  }
  const fields = CborDeserializer.decodeArray(tag.data, 4);
  const v = Number(CborDeserializer.decodeUnsignedInteger(fields[0]));
  if (v !== TOKEN_BLOB_VERSION) {
    throw new CborError(`Unsupported TokenBlob version: ${v}`);
  }
  return {
    v,
    network: Number(CborDeserializer.decodeUnsignedInteger(fields[1])),
    tokenId: CborDeserializer.decodeTextString(fields[2]),
    token: CborDeserializer.decodeByteString(fields[3]),
  };
}

/**
 * The wallet-api WIRE bytes for a blob (ARCHITECTURE §5.2/§8.2): the backend
 * stores, content-addresses and validates the INNER `token` bytes (the v2
 * `Token.toCBOR()` form — `Token.fromCBOR` at §8.2 step 3). The sphere-private
 * 39051 envelope never crosses the §16 API. Tolerant on input: envelope bytes
 * unwrap to their inner `token` bytes; anything else is already wire format
 * and passes through. (The phase-2 harness caught the envelope leaking onto
 * the wire — the real backend 422s it at §8.2 step 3 with "Invalid CBOR tag
 * for Token: 39051"; only the test fake's matching wrongness had masked it.)
 */
export function unwrapTokenBlobBytes(bytes: Uint8Array): Uint8Array {
  try {
    return decodeTokenBlob(bytes).token;
  } catch {
    return bytes;
  }
}
