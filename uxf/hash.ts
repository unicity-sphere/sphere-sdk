/**
 * UXF Content Hash Computation (WU-03)
 *
 * Implements deterministic content hashing for UXF elements per
 * SPECIFICATION Section 4 and DOMAIN-CONSTRAINTS Section 2.
 *
 * Hash = SHA-256( dag-cbor( { header, type, content, children } ) )
 *
 * All hex-encoded byte fields are converted to Uint8Array before CBOR
 * encoding so that dag-cbor serializes them as CBOR bstr, not tstr.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { encode } from '@ipld/dag-cbor';
import { bytesToHex } from '../core/crypto.js';
import {
  type ContentHash,
  contentHash,
  type UxfElement,
  type UxfElementType,
  ELEMENT_TYPE_IDS,
} from './types.js';

// ---------------------------------------------------------------------------
// Hex/Bytes helpers
// ---------------------------------------------------------------------------

/**
 * Convert a lowercase hex string to a Uint8Array.
 * Each pair of hex characters becomes one byte.
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Field classification per element type
// ---------------------------------------------------------------------------

/**
 * Fields that are hex-encoded byte data and must be converted to
 * Uint8Array before CBOR encoding (DOMAIN-CONSTRAINTS Section 2.5).
 */
const BYTE_FIELDS: Readonly<Record<UxfElementType, ReadonlySet<string>>> = {
  'token-root': new Set(['tokenId']),
  'genesis': new Set(),
  'genesis-data': new Set([
    'tokenId',
    'tokenType',
    'salt',
    'tokenData',
    'recipientDataHash',
  ]),
  'transaction': new Set(),
  'transaction-data': new Set([
    'salt',
    'recipientDataHash',
  ]),
  'inclusion-proof': new Set(['transactionHash']),
  'authenticator': new Set([
    'publicKey',
    'signature',
    'stateHash',
  ]),
  'unicity-certificate': new Set(['raw']),
  'predicate': new Set(['raw']),
  'token-state': new Set(['data', 'predicate']),
  'token-coin-data': new Set(),
  'smt-path': new Set(['root']),
};

// ---------------------------------------------------------------------------
// Content preparation
// ---------------------------------------------------------------------------

/**
 * Prepare element content for deterministic CBOR hashing.
 *
 * Converts hex-encoded byte fields to Uint8Array so that dag-cbor
 * encodes them as CBOR bstr instead of tstr. Fields that are semantically
 * strings (version, recipient, algorithm, coinData entries, message, kind)
 * are left as-is.
 *
 * Special handling:
 * - SmtPath `segments[].data`: hex -> bytes (or null -> null)
 * - SmtPath `segments[].path`: decimal bigint string -> BigInt
 *   (dag-cbor encodes BigInt natively via CBOR tag 2)
 * - `reason` in GenesisDataContent: already Uint8Array | null, pass through
 * - null values: pass through for CBOR null encoding
 */
export function prepareContentForHashing(
  type: UxfElementType,
  content: Record<string, unknown>,
): Record<string, unknown> {
  const byteFields = BYTE_FIELDS[type];
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(content)) {
    // SmtPath segments require special per-segment handling
    if (type === 'smt-path' && key === 'segments') {
      result[key] = prepareSmtSegments(
        value as ReadonlyArray<{ readonly data: string; readonly path: string }>,
      );
      continue;
    }

    // TransactionData nametagRefs are ContentHash[] -- convert to bytes
    if (type === 'transaction-data' && key === 'nametagRefs') {
      const refs = value as string[];
      result[key] = refs.map((h) => hexToBytes(h));
      continue;
    }

    // null values pass through as CBOR null
    if (value === null) {
      result[key] = null;
      continue;
    }

    // Uint8Array values pass through (e.g., reason in genesis-data)
    if (value instanceof Uint8Array) {
      result[key] = value;
      continue;
    }

    // Hex-encoded byte fields -> Uint8Array
    if (byteFields.has(key) && typeof value === 'string') {
      result[key] = hexToBytes(value);
      continue;
    }

    // Everything else (strings, numbers, arrays of tuples, etc.) stays as-is
    result[key] = value;
  }

  return result;
}

/**
 * Prepare SmtPath segments for CBOR encoding.
 *
 * - `data`: hex string -> Uint8Array, null -> null
 * - `path`: decimal bigint string -> BigInt (CBOR tag 2 bignum)
 */
function prepareSmtSegments(
  segments: ReadonlyArray<{ readonly data: string; readonly path: string }>,
): Array<{ data: Uint8Array | null; path: bigint }> {
  return segments.map((seg) => ({
    data: seg.data === null || seg.data === undefined
      ? null
      : hexToBytes(seg.data as string),
    path: BigInt(seg.path),
  }));
}

// ---------------------------------------------------------------------------
// Children preparation
// ---------------------------------------------------------------------------

/**
 * Convert all ContentHash hex strings in children to Uint8Array so that
 * dag-cbor encodes them as CBOR bstr (raw 32-byte hash values).
 *
 * Handles:
 * - Single ContentHash -> Uint8Array
 * - Array of ContentHash -> Array of Uint8Array
 * - null -> null (CBOR null)
 */
export function prepareChildrenForHashing(
  children: Record<string, ContentHash | ContentHash[] | null>,
): Record<string, Uint8Array | Uint8Array[] | null> {
  const result: Record<string, Uint8Array | Uint8Array[] | null> = {};

  for (const [key, value] of Object.entries(children)) {
    if (value === null) {
      result[key] = null;
    } else if (Array.isArray(value)) {
      result[key] = (value as ContentHash[]).map((h) => hexToBytes(h));
    } else {
      result[key] = hexToBytes(value as string);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Content hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the content hash of a UXF element.
 *
 * Builds the canonical 4-key CBOR map:
 * ```
 * {
 *   header: [representation, semantics, kind, predecessor],
 *   type:   <integer type ID>,
 *   content: <prepared content>,
 *   children: <prepared children>
 * }
 * ```
 *
 * The map is encoded with dag-cbor (deterministic CBOR per RFC 8949
 * Section 4.2.1) and hashed with SHA-256.
 *
 * @param element - The UXF element to hash
 * @returns A branded ContentHash (64-char lowercase hex)
 */
export function computeElementHash(element: UxfElement): ContentHash {
  // Build the canonical header array: [repr, sem, kind, predecessor]
  const header = [
    element.header.representation,
    element.header.semantics,
    element.header.kind,
    element.header.predecessor !== null
      ? hexToBytes(element.header.predecessor)
      : null,
  ];

  // Map string type tag to integer type ID
  const typeId = ELEMENT_TYPE_IDS[element.type];

  // Prepare content: hex byte fields -> Uint8Array
  const preparedContent = prepareContentForHashing(
    element.type,
    element.content as Record<string, unknown>,
  );

  // Prepare children: ContentHash hex -> Uint8Array
  const preparedChildren = prepareChildrenForHashing(
    element.children as Record<string, ContentHash | ContentHash[] | null>,
  );

  // Build the canonical 4-key map
  const canonical = {
    header,
    type: typeId,
    content: preparedContent,
    children: preparedChildren,
  };

  // Deterministic CBOR encode, then SHA-256
  const cborBytes = encode(canonical);
  const hashBytes = sha256(cborBytes);

  return contentHash(bytesToHex(hashBytes));
}
