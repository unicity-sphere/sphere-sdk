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
import { ENRICHED_SYNTHETIC_KIND } from './token-join.js';
import { UxfError } from './errors.js';
import { computeElementHash } from './hash.js';
import { hexToBytesAllowEmpty } from '../core/hex.js';
import { assertHeaderKindField, assertHeaderVersionField } from './header-validation.js';
import {
  ELEMENTS_MAX_SIZE,
  MANIFEST_MAX_SIZE,
  MAX_CREATOR_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from './limits.js';

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
  // Steelman² remediation: refuse to serialize a package whose
  // manifest head is a Rule 4 ENRICHED_SYNTHETIC_KIND token-root.
  // Synthetic roots are ephemeral merge artifacts; persisting them
  // via JSON (storage-adapters, network exchange) lets downstream
  // peers ingest forged-looking signed roots — same threat model as
  // exportToCar's guard. Both paths now share the same gate.
  for (const [tokenId, rootHash] of pkg.manifest.tokens) {
    const rootEl = pkg.pool.get(rootHash);
    // Steelman⁴⁸ NOTE: dangling manifest entry — manifest references
    // a rootHash whose element is missing from the pool. Soft-fail
    // (continue) used to mask serialization of broken packages until
    // a downstream verify() ran. Now fail at the parse boundary.
    if (!rootEl) {
      throw new UxfError(
        'MISSING_ELEMENT',
        `Refusing to serialize package: manifest entry for token ${tokenId} ` +
          `references rootHash ${rootHash} but no such element exists in pool.`,
      );
    }
    if (rootEl.header.kind === ENRICHED_SYNTHETIC_KIND) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Refusing to serialize package with synthetic (Rule 4 enriched) manifest head ` +
          `for token ${tokenId} (rootHash=${rootHash}). Finalize the merge first: ` +
          `resolve the synthetic to a signed root or remove the token from the manifest.`,
      );
    }
  }

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

  // Steelman remediation (FIX 8): strict equality on the version
  // literal — accepting any string here lets a hostile peer ride
  // unknown-version semantics under our 1.0.0 parser. The on-the-wire
  // wrapper version is explicitly pinned by SPEC §5.8.
  if (raw.uxf !== '1.0.0') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Unsupported uxf version: ${typeof raw.uxf === 'string' ? `"${raw.uxf}"` : String(raw.uxf)}`,
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
  // Steelman³ remediation (FIX 3, Round 3): meta.creator / meta.description
  // were forwarded with NO type validation — ipld.ts had explicit string
  // guards (lines 448-462) but the JSON path silently accepted any type.
  // Apply optional-string guards here so a hostile JSON payload with
  // `creator: 42` or `description: { __proto__: ... }` cannot smuggle
  // garbage through.
  // Steelman³ remediation (FIX 4, Round 3): also enforce length caps so
  // a 100 MiB creator/description string cannot be persisted via the
  // JSON path even if its `typeof` matches.
  const creator = requireOptionalString(meta, 'creator', 'metadata');
  if (creator !== undefined && creator.length > MAX_CREATOR_LENGTH) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `metadata.creator exceeds MAX_CREATOR_LENGTH=${MAX_CREATOR_LENGTH}: ${creator.length}`,
    );
  }
  const description = requireOptionalString(meta, 'description', 'metadata');
  if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `metadata.description exceeds MAX_DESCRIPTION_LENGTH=${MAX_DESCRIPTION_LENGTH}: ${description.length}`,
    );
  }
  const envelope: UxfEnvelope = {
    version: requireString(meta, 'version', 'metadata'),
    // Steelman remediation (FIX 7): timestamps are non-negative
    // integers (unix-seconds). Reject NaN/Infinity/-0/fractional/
    // negative values explicitly.
    createdAt: requireTimestamp(meta, 'createdAt', 'metadata'),
    updatedAt: requireTimestamp(meta, 'updatedAt', 'metadata'),
    ...(creator !== undefined ? { creator } : {}),
    ...(description !== undefined ? { description } : {}),
  };

  // -- manifest --
  if (typeof raw.manifest !== 'object' || raw.manifest === null) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Missing or invalid "manifest" field',
    );
  }
  const manifestEntries = Object.entries(raw.manifest);
  // Steelman remediation (FIX 9): cap manifest size BEFORE iterating —
  // a hostile package with millions of token entries would otherwise
  // burn parse time and memory before the per-element-count cap fires
  // (the element-count cap targets pool elements, not manifest keys).
  if (manifestEntries.length > MANIFEST_MAX_SIZE) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `Manifest entry count exceeds MANIFEST_MAX_SIZE=${MANIFEST_MAX_SIZE}: ${manifestEntries.length}`,
    );
  }
  const tokens = new Map<string, ContentHash>();
  for (const [tokenId, rootHash] of manifestEntries) {
    // Steelman remediation (FIX 6): validate tokenId against the
    // canonical /^[0-9a-f]{64}$/ regex (matching deconstruct.ts:213
    // ingest gate). The regex naturally rejects `__proto__`,
    // `constructor`, `prototype`, empty strings, non-hex unicode,
    // wrong-length keys.
    // #226: accept 64-char (coin tokens) and 68-char (invoice tokens —
    // imprint form). Mirrors deconstruct.ts:226 and ipld.ts manifest
    // reader. Lowercase-hex preserved.
    if (!/^[0-9a-f]{64,68}$/.test(tokenId)) {
      throw new UxfError(
        'SERIALIZATION_ERROR',
        `Invalid manifest tokenId: ${tokenId.slice(0, 32)}…`,
      );
    }
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
  // Steelman³ remediation (FIX 1, Round 3): cap elements pool size at the
  // parse boundary — otherwise a hostile JSON payload with 10M elements
  // forces 10M `Object.entries` iterations + 10M `contentHash` /
  // `computeElementHash` evaluations BEFORE `WRAP_POOL_MAX_SIZE = 1M`
  // (UxfPackage.ts wrapPool) finally fires. The CAR path correctly caps
  // via `CAR_IMPORT_MAX_BLOCK_COUNT = 10_000` BEFORE pool insertion;
  // mirror that defense here for the JSON path.
  const elementEntries = Object.entries(raw.elements);
  if (elementEntries.length > ELEMENTS_MAX_SIZE) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `Elements pool size exceeds ELEMENTS_MAX_SIZE=${ELEMENTS_MAX_SIZE}: ${elementEntries.length}`,
    );
  }
  for (const [hashStr, jsonElem] of elementEntries) {
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

  // Steelman³ remediation: symmetric synthetic-root guard. The serialize
  // side (packageToJson + exportToCar) refuses to write packages whose
  // manifest head is an ENRICHED_SYNTHETIC_KIND token-root. The receiver
  // must mirror that gate — a hostile peer could otherwise bypass the
  // serialize check by hand-crafting a JSON package directly. Pool the
  // elements first (so the hash-recompute check above runs on every
  // element, validating the kind didn't change post-encoding), then
  // verify no manifest root carries the synthetic kind.
  for (const [tokenId, rootHash] of manifest.tokens) {
    const rootEl = pool.get(rootHash);
    if (rootEl && rootEl.header.kind === ENRICHED_SYNTHETIC_KIND) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Refusing to import package with synthetic (Rule 4 enriched) manifest head ` +
          `for token ${tokenId} (rootHash=${rootHash}). Synthetic roots are ephemeral ` +
          `merge artifacts that must NOT cross peer boundaries.`,
      );
    }
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
  // Steelman²⁰/²¹: validate representation/semantics/kind at the parse
  // boundary via shared helpers (uxf/header-validation). Without this,
  // a malformed header (string, null, NaN, fractional) sits in the pool
  // and surfaces as INVALID_INSTANCE_CHAIN much later, far from the
  // root cause.
  assertHeaderVersionField(hdr.representation, 'Element header.representation');
  assertHeaderVersionField(hdr.semantics, 'Element header.semantics');
  assertHeaderKindField(hdr.kind, 'Element header.kind');

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

// Steelman³⁶: consolidated to core/hex.ts:hexToBytesAllowEmpty (top-of-
// file import). The wire round-trip permits empty byte-field encoding,
// so the AllowEmpty variant is the right choice here.
const hexStringToUint8Array = hexToBytesAllowEmpty;

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

/**
 * Require an OPTIONAL string field on an object: returns the value when
 * `typeof === 'string'`, returns `undefined` when the field is absent
 * (or explicitly `undefined`), throws SERIALIZATION_ERROR for any other
 * type.
 *
 * Steelman³ remediation (FIX 3, Round 3): meta.creator / meta.description
 * were silently accepted at any type. Mirror the `ipld.ts` runtime guards
 * exactly via this helper.
 */
function requireOptionalString(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): string | undefined {
  const value = obj[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Invalid "${field}" in ${context}: expected string or undefined, got ${typeof value}`,
    );
  }
  return value;
}

/** Require a number field on an object, throw SERIALIZATION_ERROR if missing.
 *
 * Steelman remediation (FIX 7): NaN, +Infinity, -Infinity are valid
 * `typeof === 'number'` but never valid wire-form values. Reject them
 * explicitly via Number.isFinite to prevent downstream surprise
 * (NaN propagates through arithmetic; Infinity breaks comparisons).
 */
function requireNumber(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Missing or invalid "${field}" in ${context}: expected finite number`,
    );
  }
  return value;
}

/**
 * Require a timestamp field — a non-negative integer (unix-seconds).
 *
 * Steelman remediation (FIX 7): `createdAt` / `updatedAt` are wire
 * timestamps with strict semantics. Fractional / negative / Infinity
 * values are all malformed; flagging them at the parse boundary
 * keeps downstream code simple.
 */
function requireTimestamp(
  obj: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = obj[field];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Missing or invalid "${field}" in ${context}: expected non-negative integer (got ${typeof value === 'number' ? value : typeof value})`,
    );
  }
  return value;
}
