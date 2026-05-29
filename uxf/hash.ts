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
import { UxfError } from './errors.js';

// ---------------------------------------------------------------------------
// Hex/Bytes helpers
// ---------------------------------------------------------------------------

/**
 * Convert a lowercase hex string to a Uint8Array.
 * Each pair of hex characters becomes one byte.
 */
export function hexToBytes(hex: string): Uint8Array {
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
  // Issue #295 (rewrite #2): SmtPath is stored as a single opaque
  // STS-canonical CBOR blob. UXF does NOT decompose the path into
  // {root, segments}; the binary representation is owned by STS.
  'smt-path': new Set(['cbor']),
  // #202 — Same byte-fields as `authenticator`. The element type tag is
  // different (pending vs. proven) but the wire content is identical.
  'pending-authenticator': new Set([
    'publicKey',
    'signature',
    'stateHash',
  ]),
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
 * - SmtPath `cbor`: opaque STS-canonical CBOR bytes (or hex string at
 *   the JSON-deserialize boundary, converted to bytes here via the
 *   generic byte-field path). UXF does NOT touch the bytes.
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
    // IPLD Data Model does not support `undefined`. Absent keys and
    // `null` keys are distinct in CBOR; an `undefined` field is an
    // upstream producer bug (e.g. wrong wrapper level in commitment JSON).
    // Strip it here rather than forwarding a value that @ipld/dag-cbor
    // will reject at encode time. The defensive layer guards against
    // future regressions regardless of which producer is at fault.
    if (value === undefined) {
      continue;
    }
    // TransactionData nametagRefs are ContentHash[] -- convert to bytes.
    // Wave I.11: empty-string entries (which would round-trip as
    // bstr(0), inconsistent with the Wave H byte-field rule) are
    // rejected. ContentHash refs are always 64-char hex by spec; an
    // empty entry is malformed input from the deconstruct boundary.
    if (type === 'transaction-data' && key === 'nametagRefs') {
      const refs = value as string[];
      result[key] = refs.map((h) => {
        if (h === '') {
          throw new UxfError('INVALID_HASH', 'nametagRefs entry must be non-empty ContentHash hex');
        }
        return hexToBytes(h);
      });
      continue;
    }

    // null values pass through as CBOR null
    if (value === null) {
      result[key] = null;
      continue;
    }

    // Wave H — null hash canonicalization.
    //
    // Empty byte values have multiple equivalent representations in the
    // input — null, '' (empty-string hex), and Uint8Array(0) — but
    // would otherwise hash to DIFFERENT bytes:
    //   - null            → CBOR null (0xf6)
    //   - ''              → bstr(0)   (0x40)  — via hexToBytes('')
    //   - Uint8Array(0)   → bstr(0)   (0x40)
    // Two compliant SDKs picking different "no value" representations
    // for the same logical byte-field (e.g. an absent recipientDataHash)
    // would compute different content hashes, JOIN would see phantom
    // forks, and cross-device convergence would break.
    //
    // Canonical form: ALL "no value" representations of a byte-field
    // map to CBOR null at hash time. This unifies on the smaller, more
    // semantically-correct encoding ("absent") and matches how the SDK
    // already treats InclusionProof.transactionHash = null. Wire
    // serialization (json.ts, ipld.ts) is UNCHANGED — `tokenData: ''`
    // still round-trips through CAR/JSON as `''`. Only the hash
    // function's pre-CBOR normalization layer changes.
    //
    // NOTE: this is a wire-format spec change relative to pre-Wave-H
    // behavior. Tokens whose content hashes were computed under the
    // old (`bstr(0)` for '') scheme will hash differently after this
    // change. The pre-mainnet posture treats this as the right time
    // to lock in the canonical form before tokens are widely live.
    if (byteFields.has(key)) {
      if (typeof value === 'string') {
        if (value.length === 0) {
          result[key] = null;
          continue;
        }
        const decoded = hexToBytes(value);
        result[key] = decoded.length === 0 ? null : decoded;
        continue;
      }
    }

    // Uint8Array values: empty bytes also normalize to null for byte-
    // fields; non-empty pass through as CBOR bstr.
    if (value instanceof Uint8Array) {
      if (byteFields.has(key) && value.length === 0) {
        result[key] = null;
        continue;
      }
      result[key] = value;
      continue;
    }

    // Everything else (strings, numbers, arrays of tuples, etc.) stays as-is
    result[key] = value;
  }

  return result;
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

  // Map string type tag to integer type ID.
  //
  // Steelman Wave 3 — domain-separation safety. Hash domain separation
  // between element types relies on `typeId` being a known integer in
  // `ELEMENT_TYPE_IDS`. If a future schema change adds a new element
  // type without updating the map (or a hostile producer fabricates an
  // unknown `element.type`), `typeId === undefined` would be encoded
  // by dag-cbor as CBOR `undefined` — collapsing every unrecognized
  // type into the same hash bucket and creating a collision class
  // across all unrecognized types. Fail-closed at the boundary.
  const typeId = ELEMENT_TYPE_IDS[element.type];
  if (typeId === undefined) {
    throw new UxfError(
      'INVALID_HASH',
      `Unknown element type: ${String(element.type)}`,
    );
  }

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
