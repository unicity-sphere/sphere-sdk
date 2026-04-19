/**
 * UXF IPLD/CAR Serialization (WU-12)
 *
 * Implements IPLD block export, CID computation, and CARv1 import/export
 * per ARCHITECTURE Sections 6.3-6.4 and SPECIFICATION Section 6c.
 *
 * Key concepts:
 * - Each UxfElement maps to one IPLD block (dag-cbor encoded, CIDv1)
 * - The CID multihash digest is identical to the UXF content hash (both SHA-256)
 * - Child references use CBOR Tag 42 (CID links) in IPLD form, NOT raw hash bytes
 * - CAR root is the envelope block CID (which contains a CID link to the manifest)
 *
 * @module uxf/ipld
 */

import { encode as dagCborEncode, decode as dagCborDecode } from '@ipld/dag-cbor';
import { CID } from 'multiformats';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car';

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
import {
  computeElementHash,
  prepareContentForHashing,
  prepareChildrenForHashing,
  hexToBytes,
} from './hash.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** dag-cbor multicodec code. */
const DAG_CBOR_CODE = 0x71;

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
// CID utilities
// ---------------------------------------------------------------------------

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
  const digestBytes = hexToBytes(hash as string);
  // Create a multihash digest manually: sha256 code = 0x12, length = 32
  const digest = createSha256Digest(digestBytes);
  return CID.createV1(DAG_CBOR_CODE, digest);
}

/**
 * Extract the SHA-256 digest from a CID and return as a ContentHash.
 *
 * @throws UxfError if the CID does not use sha2-256 hashing.
 */
export function cidToContentHash(cid: CID): ContentHash {
  if (cid.multihash.code !== 0x12) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Expected sha2-256 (0x12) multihash, got 0x${cid.multihash.code.toString(16)}`,
    );
  }
  return contentHash(bytesToHex(cid.multihash.digest));
}

// ---------------------------------------------------------------------------
// computeCid
// ---------------------------------------------------------------------------

/**
 * Compute the CIDv1 for a UXF element.
 *
 * Uses the same canonical dag-cbor encoding and SHA-256 hash as
 * computeElementHash, so the CID's multihash digest is identical
 * to the UXF content hash (SPEC 6c.1).
 *
 * @param element - The UXF element.
 * @returns CIDv1 with dag-cbor codec and sha2-256 hash.
 */
export function computeCid(element: UxfElement): CID {
  // Build the same canonical form used for hashing
  const canonical = buildCanonicalForm(element);
  const cborBytes = dagCborEncode(canonical);
  const hashBytes = sha256Sync(cborBytes);
  const digest = createSha256Digest(hashBytes);
  return CID.createV1(DAG_CBOR_CODE, digest);
}

// ---------------------------------------------------------------------------
// elementToIpldBlock
// ---------------------------------------------------------------------------

/**
 * Encode a UXF element as an IPLD block.
 *
 * The block data is dag-cbor encoded with CID links (Tag 42) for child
 * references. This differs from the hash canonical form which uses raw
 * 32-byte hash bytes for children.
 *
 * @param element - The UXF element.
 * @returns An object with `cid` (CIDv1) and `bytes` (dag-cbor encoded block).
 */
export function elementToIpldBlock(element: UxfElement): {
  cid: CID;
  bytes: Uint8Array;
} {
  // Build the IPLD form: content prepared the same as for hashing,
  // but children use CID links instead of raw hash bytes.
  const header = buildCanonicalHeader(element);
  const typeId = ELEMENT_TYPE_IDS[element.type];
  const preparedContent = prepareContentForHashing(
    element.type,
    element.content as Record<string, unknown>,
  );

  // Convert children to CID links (dag-cbor encodes CID objects as Tag 42)
  const childrenWithCids = prepareChildrenAsCidLinks(
    element.children as Record<string, ContentHash | ContentHash[] | null>,
  );

  const ipldNode = {
    header,
    type: typeId,
    content: preparedContent,
    children: childrenWithCids,
  };

  const bytes = dagCborEncode(ipldNode);

  // The CID must match the content hash (same canonical encoding + SHA-256).
  // We compute the CID from the hash canonical form, not the IPLD form.
  const cid = computeCid(element);

  return { cid, bytes };
}

// ---------------------------------------------------------------------------
// exportToCar
// ---------------------------------------------------------------------------

/**
 * Export the entire UXF package as a CARv1 byte stream.
 *
 * Root: CID of the package envelope block.
 * Block ordering (SPEC 6c.4):
 * 1. Envelope block (root)
 * 2. Manifest block
 * 3. BFS traversal of each token root's DAG
 * 4. Shared elements appear once at first reference position
 *
 * @param pkg - The UXF package data to export.
 * @returns The complete CAR bytes.
 */
export async function exportToCar(pkg: UxfPackageData): Promise<Uint8Array> {
  // -- Build manifest IPLD block --
  // Manifest: { tokens: { tokenId: CID, ... } }
  const manifestTokens: Record<string, CID> = {};
  for (const [tokenId, rootHash] of pkg.manifest.tokens) {
    manifestTokens[tokenId] = contentHashToCid(rootHash);
  }
  const manifestNode = { tokens: manifestTokens };
  const manifestBytes = dagCborEncode(manifestNode);
  const manifestHashBytes = sha256Sync(manifestBytes);
  const manifestDigest = createSha256Digest(manifestHashBytes);
  const manifestCid = CID.createV1(DAG_CBOR_CODE, manifestDigest);

  // -- Build envelope IPLD block --
  // Envelope: { version, createdAt, updatedAt, creator?, description?, manifest: CID }
  const envelopeNode: Record<string, unknown> = {
    version: pkg.envelope.version,
    createdAt: pkg.envelope.createdAt,
    updatedAt: pkg.envelope.updatedAt,
    manifest: manifestCid,
  };
  if (pkg.envelope.creator !== undefined) {
    envelopeNode.creator = pkg.envelope.creator;
  }
  if (pkg.envelope.description !== undefined) {
    envelopeNode.description = pkg.envelope.description;
  }
  const envelopeBytes = dagCborEncode(envelopeNode);
  const envelopeHashBytes = sha256Sync(envelopeBytes);
  const envelopeDigest = createSha256Digest(envelopeHashBytes);
  const envelopeCid = CID.createV1(DAG_CBOR_CODE, envelopeDigest);

  // -- Create CAR writer with envelope as root --
  const { writer, out } = CarWriter.create([envelopeCid]);

  // Collect output chunks asynchronously
  const chunks: Uint8Array[] = [];
  const collectPromise = (async () => {
    for await (const chunk of out) {
      chunks.push(chunk);
    }
  })();

  // -- Write blocks --

  // 1. Envelope block (root)
  await writer.put({ cid: envelopeCid, bytes: envelopeBytes });

  // 2. Manifest block
  await writer.put({ cid: manifestCid, bytes: manifestBytes });

  // 3. BFS traversal of each token root's DAG
  const written = new Set<string>();
  written.add(envelopeCid.toString());
  written.add(manifestCid.toString());

  for (const rootHash of pkg.manifest.tokens.values()) {
    await writeBfs(pkg, rootHash, writer, written);
  }

  await writer.close();
  await collectPromise;

  // Concatenate chunks
  return concatUint8Arrays(chunks);
}

/**
 * BFS traversal: write element blocks in breadth-first order.
 * Shared elements are written once at first reference position.
 */
async function writeBfs(
  pkg: UxfPackageData,
  startHash: ContentHash,
  writer: { put(block: { cid: CID; bytes: Uint8Array }): Promise<void> },
  written: Set<string>,
): Promise<void> {
  const queue: ContentHash[] = [startHash];

  while (queue.length > 0) {
    const hash = queue.shift()!;
    const cid = contentHashToCid(hash);
    const cidStr = cid.toString();

    if (written.has(cidStr)) {
      continue;
    }
    written.add(cidStr);

    const element = pkg.pool.get(hash);
    if (!element) {
      continue;
    }

    const block = elementToIpldBlock(element);
    await writer.put({ cid: block.cid, bytes: block.bytes });

    // Enqueue children for BFS
    for (const childRef of Object.values(element.children)) {
      if (childRef === null) {
        continue;
      }
      if (Array.isArray(childRef)) {
        for (const childHash of childRef as ContentHash[]) {
          queue.push(childHash);
        }
      } else {
        queue.push(childRef as ContentHash);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// importFromCar
// ---------------------------------------------------------------------------

/**
 * Import a UXF package from a CARv1 byte stream.
 *
 * Reads the root CID (envelope), decodes envelope and manifest,
 * then iterates all remaining blocks as elements.
 * CID links in children are converted back to ContentHash hex strings.
 *
 * @param car - The CAR bytes to import.
 * @returns The reconstructed UxfPackageData.
 * @throws UxfError on invalid CAR structure.
 */
export async function importFromCar(car: Uint8Array): Promise<UxfPackageData> {
  const reader = await CarReader.fromBytes(car);

  const roots = await reader.getRoots();
  if (roots.length === 0) {
    throw new UxfError('INVALID_PACKAGE', 'CAR file has no root CID');
  }

  const envelopeCid = roots[0];

  // Read envelope block
  const envelopeBlock = await reader.get(envelopeCid);
  if (!envelopeBlock) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Envelope block not found in CAR',
    );
  }
  const envelopeNode = dagCborDecode(envelopeBlock.bytes) as Record<
    string,
    unknown
  >;

  // Extract manifest CID from envelope
  const manifestCid = envelopeNode.manifest;
  if (!(manifestCid instanceof CID)) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Envelope does not contain a valid manifest CID link',
    );
  }

  // Build envelope
  const envelope: UxfEnvelope = {
    version: envelopeNode.version as string,
    createdAt: envelopeNode.createdAt as number,
    updatedAt: envelopeNode.updatedAt as number,
    ...(envelopeNode.creator !== undefined
      ? { creator: envelopeNode.creator as string }
      : {}),
    ...(envelopeNode.description !== undefined
      ? { description: envelopeNode.description as string }
      : {}),
  };

  // Read manifest block
  const manifestBlock = await reader.get(manifestCid);
  if (!manifestBlock) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Manifest block not found in CAR',
    );
  }
  const manifestNode = dagCborDecode(manifestBlock.bytes) as {
    tokens: Record<string, CID>;
  };

  // Build manifest: CID values -> ContentHash
  const tokens = new Map<string, ContentHash>();
  for (const [tokenId, cid] of Object.entries(manifestNode.tokens)) {
    tokens.set(tokenId, cidToContentHash(cid as CID));
  }
  const manifest: UxfManifest = { tokens };

  // Track which CIDs are the envelope and manifest (not elements)
  const nonElementCids = new Set<string>();
  nonElementCids.add(envelopeCid.toString());
  nonElementCids.add(manifestCid.toString());

  // Read all blocks and decode elements
  const pool = new Map<ContentHash, UxfElement>();

  for await (const block of reader.blocks()) {
    const cidStr = block.cid.toString();
    if (nonElementCids.has(cidStr)) {
      continue;
    }

    const hash = cidToContentHash(block.cid);
    const node = dagCborDecode(block.bytes) as {
      header: unknown[];
      type: number;
      content: Record<string, unknown>;
      children: Record<string, unknown>;
    };

    const element = decodeIpldElement(node);

    // Verify element hash matches the CID-derived hash
    const recomputed = computeElementHash(element);
    if (recomputed !== hash) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `CAR element hash mismatch: CID implies ${hash}, computed ${recomputed}`,
      );
    }

    pool.set(hash, element);
  }

  // Build instance chains from element predecessors
  const instanceChains = rebuildInstanceChains(pool);

  // Build empty indexes (caller should rebuild if needed)
  const indexes: UxfIndexes = {
    byTokenType: new Map(),
    byCoinId: new Map(),
    byStateHash: new Map(),
  };

  return {
    envelope,
    manifest,
    pool,
    instanceChains,
    indexes,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical form for hashing (same as in hash.ts computeElementHash).
 */
function buildCanonicalForm(element: UxfElement): Record<string, unknown> {
  const header = buildCanonicalHeader(element);
  const typeId = ELEMENT_TYPE_IDS[element.type];
  const preparedContent = prepareContentForHashing(
    element.type,
    element.content as Record<string, unknown>,
  );
  const preparedChildren = prepareChildrenForHashing(
    element.children as Record<string, ContentHash | ContentHash[] | null>,
  );

  return {
    header,
    type: typeId,
    content: preparedContent,
    children: preparedChildren,
  };
}

/**
 * Build the canonical header array: [repr, sem, kind, predecessor].
 */
function buildCanonicalHeader(
  element: UxfElement,
): [number, number, string, Uint8Array | null] {
  return [
    element.header.representation,
    element.header.semantics,
    element.header.kind,
    element.header.predecessor !== null
      ? hexToBytes(element.header.predecessor)
      : null,
  ];
}

/**
 * Convert children to CID links for IPLD encoding.
 * dag-cbor encodes CID objects as CBOR Tag 42.
 */
function prepareChildrenAsCidLinks(
  children: Record<string, ContentHash | ContentHash[] | null>,
): Record<string, CID | CID[] | null> {
  const result: Record<string, CID | CID[] | null> = {};

  for (const [key, value] of Object.entries(children)) {
    if (value === null) {
      result[key] = null;
    } else if (Array.isArray(value)) {
      result[key] = (value as ContentHash[]).map((h) =>
        contentHashToCid(h),
      );
    } else {
      result[key] = contentHashToCid(value as ContentHash);
    }
  }

  return result;
}

/**
 * Decode an IPLD block back to a UxfElement.
 * CID links in children are converted back to ContentHash hex strings.
 */
function decodeIpldElement(node: {
  header: unknown[];
  type: number;
  content: Record<string, unknown>;
  children: Record<string, unknown>;
}): UxfElement {
  // Decode header: [repr, sem, kind, predecessor]
  const hdrArray = node.header;
  if (!Array.isArray(hdrArray) || hdrArray.length < 4) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      'Invalid IPLD element header format',
    );
  }

  const predecessor = hdrArray[3];
  const predecessorHash: ContentHash | null =
    predecessor instanceof Uint8Array
      ? contentHash(bytesToHex(predecessor))
      : null;

  // Type ID -> string tag
  const typeTag = TYPE_ID_TO_TAG.get(node.type);
  if (typeTag === undefined) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Unknown element type ID in IPLD block: ${node.type}`,
    );
  }

  // Decode content: convert Uint8Array back to hex strings where applicable.
  // The in-memory model uses hex strings for byte fields.
  const content = decodeIpldContent(typeTag, node.content);

  // Decode children: CID links -> ContentHash hex strings
  const children = decodeIpldChildren(node.children);

  return {
    header: {
      representation: hdrArray[0] as number,
      semantics: hdrArray[1] as number,
      kind: hdrArray[2] as string as UxfInstanceKind,
      predecessor: predecessorHash,
    },
    type: typeTag,
    content,
    children,
  };
}

/**
 * Decode IPLD content back to the in-memory UxfElement content format.
 * Uint8Array values from dag-cbor decoding are converted back to hex strings
 * for fields that are hex-encoded in the in-memory model.
 */
function decodeIpldContent(
  type: UxfElementType,
  content: Record<string, unknown>,
): UxfElementContent {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(content)) {
    if (value instanceof Uint8Array) {
      // Special case: genesis-data reason stays as Uint8Array
      if (type === 'genesis-data' && key === 'reason') {
        result[key] = value;
      } else {
        result[key] = bytesToHex(value);
      }
    } else if (Array.isArray(value)) {
      result[key] = decodeIpldContentArray(type, key, value);
    } else if (typeof value === 'bigint') {
      // BigInt from dag-cbor (e.g., smt-path segment path) -> decimal string
      result[key] = value.toString();
    } else if (value === null) {
      result[key] = null;
    } else {
      result[key] = value;
    }
  }

  return result as UxfElementContent;
}

/**
 * Decode array values in IPLD content.
 */
function decodeIpldContentArray(
  type: UxfElementType,
  key: string,
  value: unknown[],
): unknown[] {
  // smt-path segments: array of { data: Uint8Array|null, path: BigInt }
  if (type === 'smt-path' && key === 'segments') {
    return value.map((seg) => {
      const s = seg as { data: Uint8Array | null; path: bigint };
      return {
        data: s.data instanceof Uint8Array ? bytesToHex(s.data) : s.data,
        path: typeof s.path === 'bigint' ? s.path.toString() : String(s.path),
      };
    });
  }

  // transaction-data nametagRefs: array of Uint8Array -> array of hex strings
  if (type === 'transaction-data' && key === 'nametagRefs') {
    return value.map((item) =>
      item instanceof Uint8Array ? bytesToHex(item) : item,
    );
  }

  // genesis-data coinData: array of [string, string] tuples -- pass through
  // Other arrays: convert Uint8Array items to hex
  return value.map((item) => {
    if (item instanceof Uint8Array) {
      return bytesToHex(item);
    }
    if (Array.isArray(item)) {
      return item.map((sub) =>
        sub instanceof Uint8Array ? bytesToHex(sub) : sub,
      );
    }
    return item;
  });
}

/**
 * Decode IPLD children: CID links -> ContentHash hex strings.
 */
function decodeIpldChildren(
  children: Record<string, unknown>,
): Record<string, ContentHash | ContentHash[] | null> {
  const result: Record<string, ContentHash | ContentHash[] | null> = {};

  for (const [key, value] of Object.entries(children)) {
    if (value === null) {
      result[key] = null;
    } else if (value instanceof CID) {
      result[key] = cidToContentHash(value);
    } else if (Array.isArray(value)) {
      result[key] = (value as CID[]).map((cid) => cidToContentHash(cid));
    } else {
      throw new UxfError(
        'SERIALIZATION_ERROR',
        `Unexpected child value type for key "${key}"`,
      );
    }
  }

  return result;
}

/**
 * Rebuild instance chains from element predecessor links.
 * Scans all elements in the pool and groups them by predecessor chains.
 */
function rebuildInstanceChains(
  pool: ReadonlyMap<ContentHash, UxfElement>,
): Map<ContentHash, InstanceChainEntry> {
  const chains = new Map<ContentHash, InstanceChainEntry>();

  // Build a map of predecessor -> successor(s) for chain traversal.
  // Use an array of successors to handle branching chains where two
  // instances share the same predecessor.
  const successorsOf = new Map<ContentHash, ContentHash[]>();
  const hasPredecessor = new Set<ContentHash>();

  for (const [hash, element] of pool) {
    if (element.header.predecessor !== null) {
      const existing = successorsOf.get(element.header.predecessor);
      if (existing) {
        existing.push(hash);
      } else {
        successorsOf.set(element.header.predecessor, [hash]);
      }
      hasPredecessor.add(hash);
    }
  }

  // Find chain heads: elements that have predecessors but are not
  // themselves predecessors of anything (i.e., the newest in the chain).
  // With branching, there can be multiple heads per chain.
  const heads = new Set<ContentHash>();
  for (const [hash, element] of pool) {
    // A head is an element that is not a predecessor of any other element
    if (!successorsOf.has(hash) && element.header.predecessor !== null) {
      heads.add(hash);
    }
  }
  // Also find heads that are successors of something but not predecessors
  for (const succs of successorsOf.values()) {
    for (const successorHash of succs) {
      if (!successorsOf.has(successorHash)) {
        const element = pool.get(successorHash);
        if (element && element.header.predecessor !== null) {
          heads.add(successorHash);
        }
      }
    }
  }

  // For each head, walk the predecessor chain
  for (const head of heads) {
    const chain: Array<{ hash: ContentHash; kind: UxfInstanceKind }> = [];
    let current: ContentHash | null = head;

    while (current !== null) {
      const element = pool.get(current);
      if (!element) break;
      chain.push({ hash: current, kind: element.header.kind });
      current = element.header.predecessor;
    }

    if (chain.length > 1) {
      const entry: InstanceChainEntry = { head, chain };
      for (const link of chain) {
        chains.set(link.hash, entry);
      }
    }
  }

  return chains;
}

/**
 * Create a SHA-256 MultihashDigest for use with CID.createV1().
 * Uses the multiformats digest format.
 */
function createSha256Digest(
  hash: Uint8Array,
): { code: 0x12; size: number; digest: Uint8Array; bytes: Uint8Array } {
  // Multihash format: [code, size, ...digest]
  const code = 0x12;
  const size = hash.length;
  const bytes = new Uint8Array(2 + size);
  bytes[0] = code;
  bytes[1] = size;
  bytes.set(hash, 2);
  return { code, size, digest: hash, bytes };
}

/**
 * Synchronous SHA-256 hash using @noble/hashes (same as in hash.ts).
 * We import from @noble/hashes to avoid the async multiformats sha256.
 */
function sha256Sync(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** Convert Uint8Array to lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** Concatenate an array of Uint8Arrays into a single Uint8Array. */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
