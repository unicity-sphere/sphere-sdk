/**
 * UXF JSON Serialization (WU-11)
 *
 * Implements JSON serialization per ARCHITECTURE Section 6.2
 * and SPECIFICATION Sections 5.8, 6b.
 *
 * - packageToJson: serialize UxfPackageData to a JSON string
 * - packageFromJson: deserialize a JSON string back to UxfPackageData
 *
 * Conventions (SPEC 6b.1):
 * - Binary fields: lowercase hex strings
 * - Content hashes: 64-char lowercase hex
 * - Element type in JSON: integer type ID, NOT string tag
 * - Null values: JSON null
 * - Empty arrays: []
 * - Field names: camelCase
 * - Map types (ReadonlyMap) serialized as plain objects
 * - Set types (ReadonlySet) serialized as arrays
 *
 * @module uxf/json
 */

import type {
  ContentHash,
  UxfElement,
  UxfElementContent,
  UxfElementType,
  UxfPackageData,
  UxfManifest,
  UxfEnvelope,
  UxfIndexes,
  InstanceChainEntry,
  InstanceChainIndex,
  UxfInstanceKind,
} from './types.js';
import { contentHash, ELEMENT_TYPE_IDS } from './types.js';
import { UxfError } from './errors.js';
import { computeElementHash } from './hash.js';

// ---------------------------------------------------------------------------
// Type ID <-> String Tag mapping
// ---------------------------------------------------------------------------

/** Reverse map: integer type ID -> string tag. */
const TYPE_ID_TO_TAG: ReadonlyMap<number, UxfElementType> = new Map(
  (Object.entries(ELEMENT_TYPE_IDS) as Array<[UxfElementType, number]>).map(
    ([tag, id]) => [id, tag],
  ),
);

// ---------------------------------------------------------------------------
// JSON wire types
// ---------------------------------------------------------------------------

/** Element as it appears in JSON. */
interface JsonElement {
  header: {
    representation: number;
    semantics: number;
    kind: string;
    predecessor: string | null;
  };
  type: number;
  content: Record<string, unknown>;
  children: Record<string, string | string[] | null>;
}

/** Top-level JSON structure per SPEC 5.8. */
interface JsonPackage {
  uxf: string;
  metadata: {
    version: string;
    createdAt: number;
    updatedAt: number;
    creator?: string;
    description?: string;
    elementCount: number;
    tokenCount: number;
  };
  manifest: Record<string, string>;
  instanceChainIndex: Record<
    string,
    {
      head: string;
      chain: Array<{ hash: string; kind: string }>;
    }
  >;
  indexes: {
    byTokenType: Record<string, string[]>;
    byCoinId: Record<string, string[]>;
    byStateHash: Record<string, string>;
  };
  elements: Record<string, JsonElement>;
}

// ---------------------------------------------------------------------------
// Content serialization helpers
// ---------------------------------------------------------------------------

/**
 * Convert element content for JSON output.
 * Uint8Array values are converted to hex strings.
 * All other values pass through.
 */
function serializeContent(
  content: UxfElementContent,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (value instanceof Uint8Array) {
      result[key] = uint8ArrayToHex(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item instanceof Uint8Array ? uint8ArrayToHex(item) : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Convert Uint8Array to lowercase hex string. */
function uint8ArrayToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// packageToJson
// ---------------------------------------------------------------------------

/**
 * Serialize the complete UXF package to a JSON string.
 *
 * JSON structure (SPEC 5.8):
 * ```json
 * {
 *   "uxf": "1.0.0",
 *   "metadata": { ... },
 *   "manifest": { "<tokenId>": "<rootHash>", ... },
 *   "instanceChainIndex": { "<hash>": { "head", "chain" }, ... },
 *   "indexes": { "byTokenType", "byCoinId", "byStateHash" },
 *   "elements": { "<hash>": { "header", "type", "content", "children" }, ... }
 * }
 * ```
 *
 * @param pkg - The UXF package data to serialize.
 * @returns A JSON string representation.
 */
export function packageToJson(pkg: UxfPackageData): string {
  const envelope = pkg.envelope;

  // -- metadata --
  const metadata: JsonPackage['metadata'] = {
    version: envelope.version,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    elementCount: pkg.pool.size,
    tokenCount: pkg.manifest.tokens.size,
  };
  if (envelope.creator !== undefined) {
    metadata.creator = envelope.creator;
  }
  if (envelope.description !== undefined) {
    metadata.description = envelope.description;
  }

  // -- manifest --
  const manifest: Record<string, string> = {};
  for (const [tokenId, rootHash] of pkg.manifest.tokens) {
    manifest[tokenId] = rootHash;
  }

  // -- instance chain index --
  const instanceChainIndex: JsonPackage['instanceChainIndex'] = {};
  const seenChains = new Set<string>();
  for (const [hash, entry] of pkg.instanceChains) {
    // Each chain entry is shared by all hashes in the chain.
    // Serialize once per unique head to avoid duplicates, keyed by
    // the first hash we encounter (which is fine since packageFromJson
    // re-indexes all chain members).
    const headKey = entry.head as string;
    if (seenChains.has(headKey)) {
      continue;
    }
    seenChains.add(headKey);
    instanceChainIndex[hash as string] = {
      head: entry.head as string,
      chain: entry.chain.map((link) => ({
        hash: link.hash as string,
        kind: link.kind,
      })),
    };
  }

  // -- indexes --
  const indexes: JsonPackage['indexes'] = {
    byTokenType: mapOfSetsToObject(pkg.indexes.byTokenType),
    byCoinId: mapOfSetsToObject(pkg.indexes.byCoinId),
    byStateHash: mapToObject(pkg.indexes.byStateHash),
  };

  // -- elements --
  const elements: Record<string, JsonElement> = {};
  for (const [hash, element] of pkg.pool) {
    elements[hash as string] = serializeElement(element);
  }

  const jsonPkg: JsonPackage = {
    uxf: '1.0.0',
    metadata,
    manifest,
    instanceChainIndex,
    indexes,
    elements,
  };

  return JSON.stringify(jsonPkg);
}

/** Serialize a single element for JSON output. */
function serializeElement(element: UxfElement): JsonElement {
  const typeId = ELEMENT_TYPE_IDS[element.type];

  return {
    header: {
      representation: element.header.representation,
      semantics: element.header.semantics,
      kind: element.header.kind,
      predecessor: element.header.predecessor as string | null,
    },
    type: typeId,
    content: serializeContent(element.content),
    children: serializeChildren(element.children),
  };
}

/** Serialize children (ContentHash values are already hex strings). */
function serializeChildren(
  children: Readonly<Record<string, ContentHash | ContentHash[] | null>>,
): Record<string, string | string[] | null> {
  const result: Record<string, string | string[] | null> = {};
  for (const [key, value] of Object.entries(children)) {
    if (value === null) {
      result[key] = null;
    } else if (Array.isArray(value)) {
      result[key] = value.map((h) => h as string);
    } else {
      result[key] = value as string;
    }
  }
  return result;
}

/** Convert Map<string, Set<string>> to Record<string, string[]>. */
function mapOfSetsToObject(
  map: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string[]> {
  const obj: Record<string, string[]> = {};
  for (const [key, set] of map) {
    obj[key] = [...set];
  }
  return obj;
}

/** Convert Map<string, string> to Record<string, string>. */
function mapToObject(
  map: ReadonlyMap<string, string>,
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const [key, value] of map) {
    obj[key] = value;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// packageFromJson
// ---------------------------------------------------------------------------

/**
 * Deserialize a UXF package from a JSON string.
 *
 * Validates structure and throws SERIALIZATION_ERROR on malformed input.
 * Content hash strings are validated via the branded contentHash() constructor.
 *
 * @param json - The JSON string to parse.
 * @returns The reconstructed UxfPackageData.
 * @throws UxfError with code SERIALIZATION_ERROR on malformed input.
 */
export function packageFromJson(json: string): UxfPackageData {
  let raw: JsonPackage;
  try {
    raw = JSON.parse(json) as JsonPackage;
  } catch (e) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Validate top-level structure
  if (typeof raw !== 'object' || raw === null) {
    throw new UxfError('SERIALIZATION_ERROR', 'JSON root must be an object');
  }

  if (typeof raw.uxf !== 'string') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Missing or invalid "uxf" version field',
    );
  }

  // -- envelope --
  const meta = raw.metadata;
  if (typeof meta !== 'object' || meta === null) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Missing or invalid "metadata" field',
    );
  }
  const envelope: UxfEnvelope = {
    version: requireString(meta, 'version', 'metadata'),
    createdAt: requireNumber(meta, 'createdAt', 'metadata'),
    updatedAt: requireNumber(meta, 'updatedAt', 'metadata'),
    ...(meta.creator !== undefined ? { creator: meta.creator } : {}),
    ...(meta.description !== undefined
      ? { description: meta.description }
      : {}),
  };

  // -- manifest --
  if (typeof raw.manifest !== 'object' || raw.manifest === null) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Missing or invalid "manifest" field',
    );
  }
  const tokens = new Map<string, ContentHash>();
  for (const [tokenId, rootHash] of Object.entries(raw.manifest)) {
    tokens.set(tokenId, contentHash(rootHash));
  }
  const manifest: UxfManifest = { tokens };

  // -- elements (pool) --
  if (typeof raw.elements !== 'object' || raw.elements === null) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Missing or invalid "elements" field',
    );
  }
  const pool = new Map<ContentHash, UxfElement>();
  for (const [hashStr, jsonElem] of Object.entries(raw.elements)) {
    const hash = contentHash(hashStr);
    const element = deserializeElement(jsonElem);
    // Verify element hash matches the claimed key (catches hex case mismatches, etc.)
    const recomputed = computeElementHash(element);
    if (recomputed !== hash) {
      throw new UxfError(
        'SERIALIZATION_ERROR',
        `Element hash mismatch: key ${hash}, computed ${recomputed}`,
      );
    }
    pool.set(hash, element);
  }

  // -- instance chain index --
  const instanceChains: Map<ContentHash, InstanceChainEntry> = new Map();
  if (
    raw.instanceChainIndex &&
    typeof raw.instanceChainIndex === 'object'
  ) {
    for (const [, entryJson] of Object.entries(raw.instanceChainIndex)) {
      const entry: InstanceChainEntry = {
        head: contentHash(entryJson.head),
        chain: entryJson.chain.map(
          (link: { hash: string; kind: string }) => ({
            hash: contentHash(link.hash),
            kind: link.kind as UxfInstanceKind,
          }),
        ),
      };
      // Index every hash in the chain to the same entry
      for (const link of entry.chain) {
        instanceChains.set(link.hash, entry);
      }
    }
  }

  // -- indexes --
  let indexes: UxfIndexes;
  if (raw.indexes && typeof raw.indexes === 'object') {
    indexes = deserializeIndexes(raw.indexes);
  } else {
    // Absent indexes: reconstruct empty
    indexes = {
      byTokenType: new Map(),
      byCoinId: new Map(),
      byStateHash: new Map(),
    };
  }

  return {
    envelope,
    manifest,
    pool,
    instanceChains,
    indexes,
  };
}

// ---------------------------------------------------------------------------
// Deserialization helpers
// ---------------------------------------------------------------------------

/** Deserialize a single JSON element back to UxfElement. */
function deserializeElement(json: JsonElement): UxfElement {
  if (typeof json !== 'object' || json === null) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Element must be an object',
    );
  }

  // header
  const hdr = json.header;
  if (typeof hdr !== 'object' || hdr === null) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Element header must be an object',
    );
  }

  // type: integer -> string tag
  const typeId = json.type;
  if (typeof typeId !== 'number') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Element type must be an integer, got ${typeof typeId}`,
    );
  }
  const typeTag = TYPE_ID_TO_TAG.get(typeId);
  if (typeTag === undefined) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Unknown element type ID: ${typeId}`,
    );
  }

  // children: string values -> ContentHash
  const children: Record<string, ContentHash | ContentHash[] | null> = {};
  if (json.children && typeof json.children === 'object') {
    for (const [key, value] of Object.entries(json.children)) {
      if (value === null) {
        children[key] = null;
      } else if (Array.isArray(value)) {
        children[key] = (value as string[]).map((h) => contentHash(h));
      } else {
        children[key] = contentHash(value as string);
      }
    }
  }

  // Deserialize content with type-aware fixups:
  // - genesis-data: convert reason hex string back to Uint8Array
  // - all types: normalize hex-like string values to lowercase
  const rawContent = (json.content ?? {}) as Record<string, unknown>;
  const content = deserializeContent(typeTag, rawContent);

  return {
    header: {
      representation: hdr.representation,
      semantics: hdr.semantics,
      kind: hdr.kind as UxfInstanceKind,
      predecessor:
        hdr.predecessor !== null ? contentHash(hdr.predecessor) : null,
    },
    type: typeTag,
    content: content as UxfElementContent,
    children,
  };
}

/** Hex pattern: 64+ chars of hex (content hashes, keys, signatures, etc.). */
const HEX_PATTERN = /^[0-9a-fA-F]{64,}$/;

/**
 * Deserialize element content with type-aware fixups.
 *
 * - genesis-data `reason`: hex string -> Uint8Array (inverse of serializeContent)
 * - All string values matching hex pattern: normalized to lowercase
 */
function deserializeContent(
  type: UxfElementType,
  content: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    // genesis-data reason: hex string -> Uint8Array
    if (type === 'genesis-data' && key === 'reason') {
      if (typeof value === 'string') {
        result[key] = hexStringToUint8Array(value);
      } else {
        result[key] = value; // null passthrough
      }
      continue;
    }

    // Normalize hex-like strings to lowercase for consistent hashing
    if (typeof value === 'string' && HEX_PATTERN.test(value)) {
      result[key] = value.toLowerCase();
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'string' && HEX_PATTERN.test(item)
          ? item.toLowerCase()
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Convert a hex string to Uint8Array. */
function hexStringToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Deserialize indexes from JSON. */
function deserializeIndexes(json: JsonPackage['indexes']): UxfIndexes {
  const byTokenType = new Map<string, Set<string>>();
  if (json.byTokenType && typeof json.byTokenType === 'object') {
    for (const [key, arr] of Object.entries(json.byTokenType)) {
      byTokenType.set(key, new Set(arr));
    }
  }

  const byCoinId = new Map<string, Set<string>>();
  if (json.byCoinId && typeof json.byCoinId === 'object') {
    for (const [key, arr] of Object.entries(json.byCoinId)) {
      byCoinId.set(key, new Set(arr));
    }
  }

  const byStateHash = new Map<string, string>();
  if (json.byStateHash && typeof json.byStateHash === 'object') {
    for (const [key, value] of Object.entries(json.byStateHash)) {
      byStateHash.set(key, value);
    }
  }

  return { byTokenType, byCoinId, byStateHash };
}

/** Require a string field on an object, throw SERIALIZATION_ERROR if missing. */
function requireString(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = obj[field];
  if (typeof value !== 'string') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Missing or invalid "${field}" in ${context}: expected string`,
    );
  }
  return value;
}

/** Require a number field on an object, throw SERIALIZATION_ERROR if missing. */
function requireNumber(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = obj[field];
  if (typeof value !== 'number') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Missing or invalid "${field}" in ${context}: expected number`,
    );
  }
  return value;
}
