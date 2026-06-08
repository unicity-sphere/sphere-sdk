/**
 * Shared CID helpers used by both the content-hash canonical form
 * (`uxf/hash.ts`) and the IPLD block encoder/decoder (`uxf/ipld.ts`).
 *
 * Lives in its own module to avoid a circular import between hash.ts
 * (which builds the canonical form that contains Tag 42 CIDs) and
 * ipld.ts (which encodes/decodes that form). Both files import the
 * helpers from here.
 *
 * Issue #435 — child references and `header[3]` predecessor refs are
 * emitted as dag-cbor Tag 42 CID-links so Kubo's recursive pin and
 * `/dag/export` walk the whole DAG natively. The hash canonical form
 * and the IPLD canonical form remain bit-identical (single canonical
 * form), so `sha256(elementBytes) === cid.multihash.digest` continues
 * to hold for every element block.
 *
 * @module uxf/cid-utils
 */

import { CID } from 'multiformats';
import type { ContentHash } from './types.js';
import { contentHash } from './types.js';
import { UxfError } from './errors.js';

/** dag-cbor multicodec code. */
export const DAG_CBOR_CODE = 0x71;

/** sha2-256 multihash code. */
export const SHA256_CODE = 0x12;

/**
 * Strict hex → bytes conversion. Throws on odd-length input or any
 * non-hex character. Inlined here (rather than imported from hash.ts)
 * to keep this module a leaf dependency of the encoding graph.
 */
function hexToBytesStrict(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new UxfError('INVALID_HASH', `Hex string has odd length: ${hex.length}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new UxfError('INVALID_HASH', 'Hex string contains invalid characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Create a SHA-256 MultihashDigest for use with `CID.createV1()`.
 * Built by hand to avoid the async multiformats sha256 helper.
 */
export function createSha256Digest(
  hash: Uint8Array,
): { code: 0x12; size: number; digest: Uint8Array; bytes: Uint8Array } {
  const size = hash.length;
  const bytes = new Uint8Array(2 + size);
  bytes[0] = SHA256_CODE;
  bytes[1] = size;
  bytes.set(hash, 2);
  return { code: SHA256_CODE, size, digest: hash, bytes };
}

/**
 * Convert a ContentHash hex string to a CIDv1 (dag-cbor, sha2-256).
 *
 * The CID encodes:
 * - version: 1
 * - codec: dag-cbor (0x71)
 * - hash function: sha2-256 (0x12)
 * - digest: the 32-byte hash from the ContentHash
 */
export function contentHashToCid(hash: ContentHash): CID {
  const digestBytes = hexToBytesStrict(hash as string);
  const digest = createSha256Digest(digestBytes);
  return CID.createV1(DAG_CBOR_CODE, digest);
}

/**
 * Extract the SHA-256 digest from a CID and return as a ContentHash.
 *
 * Validates three dimensions at the parse boundary so a hostile or
 * corrupt CID can't sneak past with a partially-correct shape:
 *
 *   1. **Multicodec** — `cid.code === 0x71` (dag-cbor). UXF CIDs are
 *      always dag-cbor; accepting a raw-codec (0x55) CID with a
 *      matching sha2-256 digest would let an adversary bind a
 *      manifest entry to a raw-bytes block instead of an element
 *      block.
 *   2. **Multihash code** — `cid.multihash.code === 0x12` (sha2-256).
 *      Other hash algorithms are out of spec.
 *   3. **Digest length** — exactly 32 bytes. The deleted
 *      `decodeChildBytes` helper enforced this; restoring the check
 *      here preserves the fail-fast diagnostic ('must be 32 bytes,
 *      got N') instead of producing a malformed ContentHash that
 *      later trips the `contentHash()` brand validator with a less
 *      informative 'Invalid content hash' error.
 *
 * @throws UxfError(SERIALIZATION_ERROR) on any of the above.
 */
export function cidToContentHash(cid: CID): ContentHash {
  if (cid.code !== DAG_CBOR_CODE) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Expected dag-cbor (0x71) multicodec, got 0x${cid.code.toString(16)}`,
    );
  }
  if (cid.multihash.code !== SHA256_CODE) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Expected sha2-256 (0x12) multihash, got 0x${cid.multihash.code.toString(16)}`,
    );
  }
  if (cid.multihash.digest.length !== 32) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Expected sha2-256 digest of 32 bytes, got ${cid.multihash.digest.length}`,
    );
  }
  return contentHash(bytesToHex(cid.multihash.digest));
}

/** Convert Uint8Array to lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
