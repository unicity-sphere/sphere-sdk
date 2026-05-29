/**
 * Wave G.5 — content-address verification for UnixFS-wrapped CIDs.
 *
 * Legacy Profile snapshots were published via Kubo's `/api/v0/add`,
 * which produces a UnixFS-wrapped tree under a dag-pb root. The
 * resulting CID hashes the dag-pb root block, NOT the file bytes,
 * so a naive `sha256(fetchedBody) === cid.digest` check fails for
 * such CIDs — the IPNS reader pre-G.5 fell back to "trust the
 * gateway" with only the IPNS Ed25519 signature as authentication.
 *
 * This module fetches the content as a CAR, walks every block,
 * verifies each block's bytes hash to its declared CID, decodes the
 * UnixFS structure, and reconstructs the file bytes. The returned
 * bytes are guaranteed to be the bytes that hash (via UnixFS
 * tree-of-blocks) to the requested root CID — closing the
 * "single-hostile-gateway-lies-about-bytes" residual gap.
 *
 * Supported codecs:
 *   - 0x55 (raw)    — single block, body == file bytes (trivially
 *                     verified by `sha256(bytes) == cid.digest`).
 *   - 0x70 (dag-pb) — UnixFS-wrapped. Root block's `Data` field
 *                     decoded as a UnixFS protobuf with Type ∈ {
 *                     Raw, File }. If `Data.Data` carries inline
 *                     bytes (small file), use them; if `Data.block
 *                     sizes` is present, walk `Links` and recurse
 *                     into each chunk block.
 *
 * Unsupported (rejected):
 *   - Other UnixFS types (Directory, Symlink, HAMTShard, Metadata)
 *     — we only verify file payloads here.
 *   - Other codecs — caller's job to pre-filter.
 *
 * No new external dependencies: uses `@ipld/car` + `@ipld/dag-pb` +
 * `multiformats` + `@noble/hashes`, all already in the project.
 */

import { CarReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';

// =============================================================================
// Minimal UnixFS protobuf decoder
// =============================================================================

/**
 * Subset of the UnixFS Data message we care about. We only handle
 * file payloads (Type ∈ { Raw, File }); other types throw.
 *
 * Wire format (protobuf):
 *   field 1 (Type, varint, required) — enum
 *   field 2 (Data, length-delimited bytes, optional)
 *   field 3 (filesize, varint, optional)
 *   field 4 (blocksizes, repeated varint, optional)
 *   ...remaining fields are ignored
 */
interface UnixFsData {
  /** Type enum: 0=Raw, 1=Directory, 2=File, 3=Metadata, 4=Symlink, 5=HAMTShard */
  type: number;
  /** Inline data bytes (small files / single-block leaves). */
  data?: Uint8Array;
  /** Total file size when blocksizes is present (multi-block files). */
  filesize?: bigint;
  /** Per-link byte sizes for multi-block files; parallel to PBNode.Links. */
  blocksizes: bigint[];
}

const UNIXFS_TYPE_RAW = 0;
const UNIXFS_TYPE_FILE = 2;

/**
 * Read a varint from `buf` starting at `offset`. Returns `[value, newOffset]`.
 * Throws on overflow (>10 bytes — ULP for uint64) or truncation.
 */
function readVarint(buf: Uint8Array, offset: number): readonly [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    if (i - offset >= 10) {
      throw new Error('UnixFS varint overflow (>10 bytes)');
    }
    const b = buf[i] ?? 0;
    result |= BigInt(b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) {
      return [result, i];
    }
    shift += 7n;
  }
  throw new Error('UnixFS varint truncated');
}

/**
 * Decode a UnixFS Data message from the dag-pb root's Data field.
 *
 * Defensive: rejects unknown/unsupported types, oversized varints,
 * truncated input. We do NOT throw on unknown protobuf field
 * numbers — those are skipped per protobuf forward-compatibility
 * rules — but we DO throw on unrecognized wire types within known
 * fields (a malformed encoder).
 */
function decodeUnixFsData(buf: Uint8Array): UnixFsData {
  let type: number | undefined;
  let data: Uint8Array | undefined;
  let filesize: bigint | undefined;
  const blocksizes: bigint[] = [];
  let i = 0;
  while (i < buf.length) {
    const [tagBig, after] = readVarint(buf, i);
    i = after;
    const tag = Number(tagBig);
    if (!Number.isSafeInteger(tag) || tag < 0) {
      throw new Error('UnixFS: unsafe protobuf tag value');
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 1 && wireType === 0) {
      const [v, next] = readVarint(buf, i);
      i = next;
      // Wave I.10: bound the Type enum to known UnixFS values before
      // BigInt → Number downcast loses precision. Known types are
      // 0..5; anything outside that range is malformed input. The
      // explicit check before downcast also closes the lossy
      // conversion footgun (a 10-byte varint downcasting to a non-
      // safe-integer that happens to compare equal to UNIXFS_TYPE_FILE
      // via JS coercion edge cases).
      if (v > 0xffffn) {
        throw new Error(`UnixFS: Type field value ${v} out of range`);
      }
      type = Number(v);
    } else if (fieldNum === 2 && wireType === 2) {
      const [lenBig, next] = readVarint(buf, i);
      const len = Number(lenBig);
      if (!Number.isSafeInteger(len) || len < 0 || next + len > buf.length) {
        throw new Error('UnixFS: malformed Data field length');
      }
      data = buf.slice(next, next + len);
      i = next + len;
    } else if (fieldNum === 3 && wireType === 0) {
      const [v, next] = readVarint(buf, i);
      i = next;
      filesize = v;
    } else if (fieldNum === 4 && wireType === 0) {
      const [v, next] = readVarint(buf, i);
      i = next;
      blocksizes.push(v);
    } else if (wireType === 0) {
      // Unknown varint field — skip the value.
      const [, next] = readVarint(buf, i);
      i = next;
    } else if (wireType === 2) {
      // Unknown length-delimited field — skip.
      const [lenBig, next] = readVarint(buf, i);
      const len = Number(lenBig);
      if (!Number.isSafeInteger(len) || len < 0 || next + len > buf.length) {
        throw new Error('UnixFS: malformed unknown-field length');
      }
      i = next + len;
    } else if (wireType === 1) {
      // Fixed64 — skip 8 bytes.
      i += 8;
      if (i > buf.length) throw new Error('UnixFS: truncated fixed64');
    } else if (wireType === 5) {
      // Fixed32 — skip 4 bytes.
      i += 4;
      if (i > buf.length) throw new Error('UnixFS: truncated fixed32');
    } else {
      throw new Error(`UnixFS: unsupported wire type ${wireType}`);
    }
  }
  if (type === undefined) {
    throw new Error('UnixFS: missing required Type field');
  }
  return { type, data, filesize, blocksizes };
}

// =============================================================================
// CAR walk + verification
// =============================================================================

const CODEC_RAW = 0x55;
const CODEC_DAGPB = 0x70;
const MULTIHASH_SHA256 = 0x12;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Verify a single block's bytes hash to its declared CID. Only
 * SHA-256 multihashes are supported; other algorithms throw (and
 * the caller treats the gateway response as suspect).
 */
function verifyBlock(cid: CID, bytes: Uint8Array): void {
  const mh = cid.multihash;
  if (mh.code !== MULTIHASH_SHA256) {
    throw new Error(
      `unixfs-verify: unsupported multihash ${mh.code} on block ${cid.toString()}; only SHA-256 supported`,
    );
  }
  const computed = sha256(bytes);
  if (!bytesEqual(computed, mh.digest)) {
    throw new Error(
      `unixfs-verify: block ${cid.toString()} bytes do not hash to declared digest`,
    );
  }
}

/**
 * Wave I.1: canonical Map key for a CID. CIDv0 (base58btc `Qm...`) and
 * CIDv1 (base32 `bafy...`) of the same digest are CRYPTOGRAPHICALLY
 * equivalent (cid.equals() returns true) but render to different
 * .toString() values. The blocks Map and the walkFile lookup MUST
 * agree on a single canonical form, or a CAR carrying CIDv0 blocks
 * would miss when looked up via a CIDv1-supplied expected CID.
 *
 * Canonical form: always v1 lowercase base32 string. v0 CIDs are
 * implicitly converted via toV1() which preserves the digest.
 */
function canonicalCidKey(cid: CID): string {
  // toV1() is a no-op on already-v1 CIDs; for v0 it wraps the digest
  // into a CIDv1 with codec=dag-pb and the same multihash.
  return cid.toV1().toString();
}

/**
 * Recursively reconstruct the file bytes anchored at `rootCid`,
 * pulling block bytes from the CAR's pre-loaded `blocks` map. Each
 * visited block has already been hash-verified against its CID by
 * the caller, so this function only deals with structural decoding.
 *
 * Bounded depth + bounded total bytes prevent malicious DAGs from
 * consuming unbounded resources (CAR-bomb defense).
 */
const MAX_RECURSION_DEPTH = 16;
const MAX_TOTAL_OUTPUT_BYTES = 64 * 1024 * 1024; // 64 MiB hard cap
/**
 * Wave I.9: per-DAG fanout cap. A malicious dag-pb root with N=10000
 * Links all pointing to the same 1KB raw block (or to deep subtrees)
 * inflates output by re-emitting child bytes per visit. The total-
 * output cap eventually fires but only after substantial work. A
 * fanout cap catches malformed-by-design DAGs cheaply at the link
 * iteration boundary.
 */
const MAX_LINKS_PER_NODE = 4096;
/**
 * Wave L: per-walk visit cap. The output-bytes cap and depth cap
 * together don't bound CPU time when leaves carry zero content
 * (empty raw blocks, or dag-pb leaves with `Data` absent / empty).
 * A balanced tree with shared leaves can branch up to fanout^depth
 * = 4096^16 ≈ 10^57 visits, each performing a dag-pb decode. Each
 * visit is fast individually but the multiplicative cost is
 * unbounded by the existing caps because no bytes accumulate.
 *
 * 100K visits is generous for legitimate use (a 64 MiB file at
 * 256 KiB chunks is ~250 leaves; with one level of intermediate
 * dag-pb wrappers, ~250 + 1 visits) and catches adversarial trees
 * before they consume measurable CPU.
 */
const MAX_TOTAL_NODE_VISITS = 100_000;

function walkFile(
  rootCid: CID,
  blocks: Map<string, Uint8Array>,
  depth: number,
  outBuf: Uint8Array[],
  outBytesSoFar: { total: number },
  /** Wave I.9: per-path visited set — detects cycles. */
  pathVisited: Set<string>,
  /** Wave L: total-visit counter, shared across the entire DAG walk. */
  visitCounter: { count: number },
): void {
  // Wave L: visit-count cap before any other work. Catches the
  // empty-leaf-amplification CPU-DoS (a balanced fanout tree where
  // every leaf is empty bytes, so the output-bytes cap never fires
  // but visit count blows up to fanout^depth).
  visitCounter.count += 1;
  if (visitCounter.count > MAX_TOTAL_NODE_VISITS) {
    throw new Error(
      `unixfs-verify: total visits exceeded ${MAX_TOTAL_NODE_VISITS}; refusing CPU-amplification DAG`,
    );
  }
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`unixfs-verify: recursion depth exceeded ${MAX_RECURSION_DEPTH}`);
  }
  // Wave I.1: canonical lookup tolerates v0/v1 representation mismatch.
  const cidKey = canonicalCidKey(rootCid);
  const blockBytes = blocks.get(cidKey);
  if (!blockBytes) {
    throw new Error(`unixfs-verify: block ${rootCid.toString()} missing from CAR`);
  }
  // Wave I.9: cycle detection via per-path visited set. A self-cycle
  // or any DAG loop on the traversal path throws immediately rather
  // than walking 16-deep before hitting the depth cap.
  if (pathVisited.has(cidKey)) {
    throw new Error(
      `unixfs-verify: cycle detected at block ${rootCid.toString()}`,
    );
  }
  pathVisited.add(cidKey);
  // Wave I.1.b CRITICAL: ensure pathVisited is cleaned up on EVERY
  // exit path (early returns from leaf branches, throws, normal
  // recursion completion). Without this, two SIBLING subtrees that
  // legitimately share a deduplicated leaf block fire a false cycle
  // detection — diamond-DAG legitimate sharing was broken in I.9.
  // try/finally cleanup runs on every path while preserving error
  // propagation.
  try {
    walkFileInner(rootCid, blocks, depth, outBuf, outBytesSoFar, pathVisited, blockBytes, visitCounter);
  } finally {
    pathVisited.delete(cidKey);
  }
}

function walkFileInner(
  rootCid: CID,
  blocks: Map<string, Uint8Array>,
  depth: number,
  outBuf: Uint8Array[],
  outBytesSoFar: { total: number },
  pathVisited: Set<string>,
  blockBytes: Uint8Array,
  visitCounter: { count: number },
): void {
  if (rootCid.code === CODEC_RAW) {
    outBytesSoFar.total += blockBytes.length;
    if (outBytesSoFar.total > MAX_TOTAL_OUTPUT_BYTES) {
      throw new Error(
        `unixfs-verify: reconstructed file exceeds ${MAX_TOTAL_OUTPUT_BYTES} bytes`,
      );
    }
    outBuf.push(blockBytes);
    return;
  }
  if (rootCid.code !== CODEC_DAGPB) {
    throw new Error(
      `unixfs-verify: unsupported codec ${rootCid.code} at CID ${rootCid.toString()}`,
    );
  }
  const node = dagPb.decode(blockBytes);
  if (!node.Data) {
    throw new Error(`unixfs-verify: dag-pb block ${rootCid.toString()} missing Data field`);
  }
  const fs = decodeUnixFsData(node.Data);
  if (fs.type !== UNIXFS_TYPE_FILE && fs.type !== UNIXFS_TYPE_RAW) {
    throw new Error(
      `unixfs-verify: only File / Raw types supported (got Type=${fs.type})`,
    );
  }
  // Inline data — leaf or single-block file.
  if (node.Links.length === 0) {
    const leaf = fs.data ?? new Uint8Array(0);
    outBytesSoFar.total += leaf.length;
    if (outBytesSoFar.total > MAX_TOTAL_OUTPUT_BYTES) {
      throw new Error(
        `unixfs-verify: reconstructed file exceeds ${MAX_TOTAL_OUTPUT_BYTES} bytes`,
      );
    }
    outBuf.push(leaf);
    return;
  }
  // Multi-block file — walk each link in order.
  if (fs.blocksizes.length !== node.Links.length) {
    throw new Error(
      `unixfs-verify: blocksizes length (${fs.blocksizes.length}) ` +
        `disagrees with PBNode.Links length (${node.Links.length}) at ${rootCid.toString()}`,
    );
  }
  // Wave I.9: fanout cap.
  if (node.Links.length > MAX_LINKS_PER_NODE) {
    throw new Error(
      `unixfs-verify: block ${rootCid.toString()} has ${node.Links.length} ` +
        `links (cap ${MAX_LINKS_PER_NODE}); refusing to walk fanout-bomb`,
    );
  }
  for (const link of node.Links) {
    if (!link.Hash) {
      throw new Error(
        `unixfs-verify: link without Hash in block ${rootCid.toString()}`,
      );
    }
    walkFile(link.Hash, blocks, depth + 1, outBuf, outBytesSoFar, pathVisited, visitCounter);
  }
  // Pop happens in walkFile's finally — sibling subtrees can share
  // a leaf block under different paths without false cycle detection.
}

// =============================================================================
// Public entry
// =============================================================================

/**
 * Verify a CAR's bytes contain the file rooted at `expectedCid`,
 * and return the reconstructed file content.
 *
 * Throws on:
 *   - Malformed CAR
 *   - Root CID mismatch (CAR roots[0] != expectedCid)
 *   - Any block whose declared CID doesn't match its bytes' SHA-256
 *   - Unsupported codec / multihash / UnixFS type
 *   - DAG depth or output-size cap exceeded
 *   - Missing block referenced by a link
 */
export async function verifyCarAndExtractFile(
  carBytes: Uint8Array,
  expectedCid: CID,
): Promise<Uint8Array> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  const root0 = roots[0];
  if (!root0) {
    throw new Error('unixfs-verify: CAR has no roots');
  }
  // We require the FIRST root to be the requested CID — the CAR
  // produced by Kubo for `?format=car&dag-scope=entity` carries
  // exactly one root. Allowing other shapes would expose a multi-
  // root smuggling attack.
  const expectedRoot = root0;
  // CID.equals across different generic parameterizations needs a
  // cast — both sides are runtime CIDs; the parameterization
  // mismatch is a TS-only artifact.
  if (!expectedRoot.equals(expectedCid as unknown as typeof expectedRoot)) {
    throw new Error(
      `unixfs-verify: CAR root ${String(expectedRoot)} != expected ${String(expectedCid)}`,
    );
  }

  // Pre-load + verify every block. Build a CID-string → bytes map
  // for cheap recursive lookups during reconstruction. Map keys are
  // string-form CIDs because CID objects don't hash structurally.
  const blocks = new Map<string, Uint8Array>();
  let totalBlockBytes = 0;
  const MAX_CAR_BYTES = 128 * 1024 * 1024; // 128 MiB
  for await (const block of reader.blocks()) {
    verifyBlock(block.cid, block.bytes);
    totalBlockBytes += block.bytes.length;
    if (totalBlockBytes > MAX_CAR_BYTES) {
      throw new Error(
        `unixfs-verify: CAR total blocks exceed ${MAX_CAR_BYTES} bytes`,
      );
    }
    blocks.set(canonicalCidKey(block.cid), block.bytes);
  }

  // Walk the dag and reconstruct.
  const out: Uint8Array[] = [];
  const tracker = { total: 0 };
  const visitCounter = { count: 0 };
  walkFile(expectedCid, blocks, 0, out, tracker, new Set<string>(), visitCounter);

  // Concatenate.
  const result = new Uint8Array(tracker.total);
  let offset = 0;
  for (const chunk of out) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
