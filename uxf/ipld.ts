/**
 * UXF IPLD/CAR Serialization (WU-12)
 *
 * Implements IPLD block export, CID computation, and CARv1 import/export
 * per ARCHITECTURE Sections 6.3-6.4 and SPECIFICATION Section 6c.
 *
 * Key concepts:
 * - Each UxfElement maps to one IPLD block (dag-cbor encoded, CIDv1)
 * - The CID multihash digest is identical to the UXF content hash (both SHA-256)
 * - Issue #435 — child references and `header[3]` predecessor refs are
 *   emitted as dag-cbor **Tag 42 CID-links**. The hash canonical form
 *   and the IPLD canonical form remain a SINGLE bit-identical form, so
 *   `sha256(elementBytes) === ContentHash digest === CID.multihash.digest`
 *   continues to hold for every element block. Tag 42 framing is what
 *   Kubo's recursive pin (`/dag/import?pin-roots=true`) and recursive
 *   walk (`/dag/export?arg=<root>`) natively follow — so the whole DAG
 *   is pinned by Kubo and exported by Kubo without any client-side
 *   UXF-aware walker or per-block pin loop. Wire format changes
 *   relative to PR #213 Option C; pre-existing tokens are abandoned
 *   (no backward compatibility — testnet posture, see issue #435).
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
  UxfInstanceKind,
} from './types.js';
import { ELEMENT_TYPE_IDS, ELEMENT_TYPE_TOKEN_ROOT } from './types.js';
import { ENRICHED_SYNTHETIC_KIND } from './token-join.js';
import { UxfError } from './errors.js';
import { assertHeaderKindField, assertHeaderVersionField } from './header-validation.js';
import {
  computeElementHash,
  prepareContentForHashing,
  prepareChildrenForHashing,
} from './hash.js';
import {
  contentHashToCid,
  cidToContentHash,
  createSha256Digest,
  DAG_CBOR_CODE,
  SHA256_CODE,
} from './cid-utils.js';
import {
  CAR_IMPORT_MAX_BLOCK_COUNT,
  CAR_IMPORT_MAX_BLOCK_BYTES,
  CAR_IMPORT_MAX_TOTAL_BYTES,
  MANIFEST_MAX_SIZE,
  MAX_CREATOR_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from './limits.js';

// Re-export the CID helpers so existing consumers that import from
// `uxf/ipld.js` keep working without churn.
export { contentHashToCid, cidToContentHash };

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
 * Issue #435: IPLD canonical form === hash canonical form. Child
 * references and `header[3]` predecessor refs are emitted as
 * dag-cbor **Tag 42 CID-links** (CIDv1, dag-cbor codec, sha2-256).
 * `sha256(bytes) === cid.multihash.digest` still holds for every
 * element block because both the hashing and IPLD encoding paths
 * share a single canonical form (`buildCanonicalForm`).
 *
 * Kubo's recursive walker — used by both `/api/v0/dag/import?pin-roots=true`
 * (publisher side) and `/api/v0/dag/export?arg=<root>` (receiver
 * side) — natively follows Tag 42 CID-links across dag-cbor blocks.
 * That makes the publisher contract a single `/dag/import` POST and
 * the receiver contract a single `/dag/export` POST, with all pin
 * bookkeeping and DAG traversal performed by Kubo. No client-side
 * per-block pin loop, no client-side UXF-aware walker.
 *
 * @param element - The UXF element.
 * @returns An object with `cid` (CIDv1) and `bytes` (dag-cbor encoded block).
 */
export function elementToIpldBlock(element: UxfElement): {
  cid: CID;
  bytes: Uint8Array;
} {
  // IPLD form === hash canonical form. Encode the exact same shape
  // `computeElementHash` hashes; the resulting CID digest equals
  // `sha256(bytes)` by construction.
  const canonical = buildCanonicalForm(element);
  const bytes = dagCborEncode(canonical);
  const hashBytes = sha256Sync(bytes);
  const digest = createSha256Digest(hashBytes);
  const cid = CID.createV1(DAG_CBOR_CODE, digest);

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
  // Steelman remediation: refuse to export a package whose manifest
  // head is a Rule 4 ENRICHED_SYNTHETIC_KIND token-root. Synthetic
  // roots are ephemeral merge artifacts — they carry a synthesized
  // signature-free tx chain that downstream peers would otherwise
  // ingest as canonical. Callers must "finalize" before export
  // (replace the synthetic head with a real signed root, or drop
  // the affected token). See uxf/token-join.ts `ENRICHED_SYNTHETIC_KIND`.
  for (const [tokenId, rootHash] of pkg.manifest.tokens) {
    const rootEl = pkg.pool.get(rootHash);
    // Steelman⁴⁸ NOTE: also fail on dangling manifest (mirrors
    // packageToJson). Previously the guard short-circuited on missing
    // elements, allowing CAR export of broken packages.
    if (!rootEl) {
      throw new UxfError(
        'MISSING_ELEMENT',
        `Refusing to export package: manifest entry for token ${tokenId} ` +
          `references rootHash ${rootHash} but no such element exists in pool.`,
      );
    }
    // Steelman² remediation: import the constant rather than hardcode
    // the string literal. A future rename would otherwise silently
    // break the guard.
    if (rootEl.header.kind === ENRICHED_SYNTHETIC_KIND) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Refusing to export package with synthetic (Rule 4 enriched) manifest head ` +
          `for token ${tokenId} (rootHash=${rootHash}). Finalize the merge first: ` +
          `resolve the synthetic to a signed root or remove the token from the manifest.`,
      );
    }
  }

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

    // Steelman remediation: also enqueue the predecessor link (instance
    // chain). `rebuildInstanceChains` (importFromCar) walks
    // `element.header.predecessor` to materialise instance chains;
    // without enqueuing it here, the predecessor block can be missing
    // from the CAR and the chain breaks on the receiver. The `written`
    // set keeps shared elements (and chain prefixes) deduped.
    if (element.header.predecessor !== null) {
      queue.push(element.header.predecessor);
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
  // Steelman remediation: pre-parse byte cap. `CarReader.fromBytes(car)`
  // parses the entire CAR up-front (allocates an internal block index
  // over `car.byteLength` bytes) BEFORE the per-block cap loop fires.
  // A multi-GiB hostile CAR would otherwise burn memory + CPU on the
  // initial parse pass even if every individual block were tiny.
  if (car.byteLength > CAR_IMPORT_MAX_TOTAL_BYTES) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `CAR exceeds max bytes: ${car.byteLength} > ${CAR_IMPORT_MAX_TOTAL_BYTES}`,
    );
  }

  const reader = await CarReader.fromBytes(car);

  const roots = await reader.getRoots();
  if (roots.length === 0) {
    throw new UxfError('INVALID_PACKAGE', 'CAR file has no root CID');
  }
  // Steelman remediation: per SPEC §5.2 #1, multi-root CARs MUST be
  // rejected at every entry point. The previous implementation
  // silently kept `roots[0]` and discarded the rest, allowing a
  // hostile sender to smuggle extra DAGs alongside the manifest root.
  if (roots.length !== 1) {
    throw new UxfError(
      'INVALID_PACKAGE',
      `Multi-root CAR rejected (received ${roots.length} roots)`,
    );
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
  // Steelman remediation: verify the envelope block bytes hash to the
  // digest claimed by the envelope CID. CarReader.get returns blocks
  // keyed by CID without re-hashing — a hostile CAR can place arbitrary
  // bytes under a chosen CID. Pool elements ARE re-hashed below; the
  // envelope and manifest blocks were the gap.
  assertBlockHashMatchesCid(envelopeBlock.bytes, envelopeCid, 'Envelope');
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

  // Steelman remediation: explicit runtime type guards on envelope
  // fields. The `as string` / `as number` casts are compile-time only
  // and silently lie when CBOR-decoded bytes are anything other than
  // their nominal type (e.g. `version: 42`, `createdAt: "abc"`).
  const envVersion = envelopeNode.version;
  if (typeof envVersion !== 'string') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Envelope.version must be a string, got ${typeof envVersion}`,
    );
  }
  // Steelman³ remediation (FIX 2, Round 3): symmetric envelope.version
  // pinning. The JSON outer-wrapper gate (json.ts:348) strictly requires
  // `raw.uxf === '1.0.0'`, but the CAR side previously accepted ANY
  // string. A hostile peer could ship `version: "999.0.0-malicious"` and
  // ride unknown-version semantics under our 1.0.0 parser. Mirror the
  // JSON whitelist here so both deserializers reject the same shape.
  if (envVersion !== '1.0.0') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Unsupported uxf version: "${envVersion}"`,
    );
  }
  const envCreatedAt = envelopeNode.createdAt;
  if (typeof envCreatedAt !== 'number' || !Number.isFinite(envCreatedAt)) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Envelope.createdAt must be a finite number, got ${typeof envCreatedAt}`,
    );
  }
  const envUpdatedAt = envelopeNode.updatedAt;
  if (typeof envUpdatedAt !== 'number' || !Number.isFinite(envUpdatedAt)) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Envelope.updatedAt must be a finite number, got ${typeof envUpdatedAt}`,
    );
  }
  if (envelopeNode.creator !== undefined && typeof envelopeNode.creator !== 'string') {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Envelope.creator must be a string or undefined, got ${typeof envelopeNode.creator}`,
    );
  }
  // Steelman³ remediation (FIX 4, Round 3): length caps on
  // creator/description. Without them, a 100 MiB string smuggled in
  // either field passes the typeof guard above and lives for the
  // import's lifetime. Cap at the parse boundary (mirrors json.ts
  // post-FIX 4 cap so both deserializers reject the same shape).
  if (
    typeof envelopeNode.creator === 'string' &&
    envelopeNode.creator.length > MAX_CREATOR_LENGTH
  ) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `Envelope.creator exceeds MAX_CREATOR_LENGTH=${MAX_CREATOR_LENGTH}: ${envelopeNode.creator.length}`,
    );
  }
  if (
    envelopeNode.description !== undefined &&
    typeof envelopeNode.description !== 'string'
  ) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `Envelope.description must be a string or undefined, got ${typeof envelopeNode.description}`,
    );
  }
  if (
    typeof envelopeNode.description === 'string' &&
    envelopeNode.description.length > MAX_DESCRIPTION_LENGTH
  ) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `Envelope.description exceeds MAX_DESCRIPTION_LENGTH=${MAX_DESCRIPTION_LENGTH}: ${envelopeNode.description.length}`,
    );
  }

  // Build envelope
  const envelope: UxfEnvelope = {
    version: envVersion,
    createdAt: envCreatedAt,
    updatedAt: envUpdatedAt,
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
  // Steelman remediation: verify manifest block bytes match the
  // claimed CID digest (same threat model as envelope above).
  assertBlockHashMatchesCid(manifestBlock.bytes, manifestCid, 'Manifest');
  const manifestNode = dagCborDecode(manifestBlock.bytes) as {
    tokens: Record<string, CID>;
  };

  // Build manifest: CID values -> ContentHash. Validate each tokenId
  // against the canonical 64-char-hex regex BEFORE inserting; reject
  // hostile keys (`__proto__`, empty, non-hex unicode, wrong length).
  // The deconstruct.ts ingest path (line 213) already enforces this
  // shape; deserializers must mirror that gate.
  const manifestEntries = Object.entries(manifestNode.tokens);
  if (manifestEntries.length > MANIFEST_MAX_SIZE) {
    throw new UxfError(
      'LIMIT_EXCEEDED',
      `Manifest entry count exceeds MANIFEST_MAX_SIZE=${MANIFEST_MAX_SIZE}: ${manifestEntries.length}`,
    );
  }
  const tokens = new Map<string, ContentHash>();
  for (const [tokenId, cid] of manifestEntries) {
    // #226: accept 64-char (coin tokens) and 68-char (invoice tokens —
    // imprint form). Mirrors deconstruct.ts:226 and json.ts manifest
    // reader.
    if (!/^[0-9a-f]{64,68}$/.test(tokenId)) {
      throw new UxfError(
        'SERIALIZATION_ERROR',
        `Invalid manifest tokenId: ${tokenId.slice(0, 32)}…`,
      );
    }
    if (!(cid instanceof CID)) {
      throw new UxfError(
        'SERIALIZATION_ERROR',
        `Manifest value for tokenId ${tokenId} is not a CID`,
      );
    }
    tokens.set(tokenId, cidToContentHash(cid));
  }
  const manifest: UxfManifest = { tokens };

  // Track which CIDs are the envelope and manifest (not elements)
  const nonElementCids = new Set<string>();
  nonElementCids.add(envelopeCid.toString());
  nonElementCids.add(manifestCid.toString());

  // Read all blocks and decode elements.
  //
  // Steelman Wave 3 — fail-closed per-block caps (count + bytes).
  //
  // `WRAP_POOL_MAX_SIZE` (UxfPackage.ts) only fires AFTER the entire
  // CAR has been streamed into `pool`. A 32 MiB CAR with ~800k tiny
  // dag-cbor blocks bypasses every existing cap until the post-import
  // wrap. Cap two dimensions at the source-of-bloat:
  //
  //   1. Per-block COUNT (`CAR_IMPORT_MAX_BLOCK_COUNT`): rejects
  //      tiny-block-flooding attacks well before they materialise as
  //      Map insertions.
  //   2. Per-block BYTES (`CAR_IMPORT_MAX_BLOCK_BYTES`): rejects
  //      single-large-block attacks (a 100 MiB block whose decode
  //      blows the heap before reaching pool).
  //
  // Counts ALL blocks (including envelope + manifest) so a hostile
  // CAR can't sneak past by burning the count budget on non-element
  // blocks.
  const pool = new Map<ContentHash, UxfElement>();
  let blockCount = 0;

  for await (const block of reader.blocks()) {
    blockCount += 1;
    if (blockCount > CAR_IMPORT_MAX_BLOCK_COUNT) {
      // Free partial pool before throwing — V8 will GC eventually but
      // the explicit clear keeps memory pressure low for the catching
      // caller (e.g. a relay handling many concurrent imports).
      pool.clear();
      throw new UxfError(
        'INVALID_PACKAGE',
        `CAR block count exceeds CAR_IMPORT_MAX_BLOCK_COUNT=${CAR_IMPORT_MAX_BLOCK_COUNT} ` +
          `(bloat-DoS protection: hostile CARs may flood with tiny blocks under the ` +
          `per-element-count pool cap).`,
      );
    }
    if (block.bytes.byteLength > CAR_IMPORT_MAX_BLOCK_BYTES) {
      pool.clear();
      throw new UxfError(
        'INVALID_PACKAGE',
        `CAR block ${block.cid.toString()} size ${block.bytes.byteLength} bytes ` +
          `exceeds CAR_IMPORT_MAX_BLOCK_BYTES=${CAR_IMPORT_MAX_BLOCK_BYTES} ` +
          `(per-block bloat-DoS protection).`,
      );
    }

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

  // Steelman³ remediation: symmetric synthetic-root guard. The serialize
  // side (exportToCar + packageToJson) refuses to write packages whose
  // manifest head is an ENRICHED_SYNTHETIC_KIND token-root. Receivers
  // must mirror that gate — a hostile peer could otherwise bypass the
  // serialize check by hand-crafting a CAR directly. Pool is fully
  // populated and hash-verified above; now check no manifest root
  // carries the synthetic kind.
  for (const [tokenId, rootHash] of manifest.tokens) {
    const rootEl = pool.get(rootHash);
    if (rootEl && rootEl.header.kind === ENRICHED_SYNTHETIC_KIND) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Refusing to import CAR with synthetic (Rule 4 enriched) manifest head ` +
          `for token ${tokenId} (rootHash=${rootHash}). Synthetic roots are ephemeral ` +
          `merge artifacts that must NOT cross peer boundaries.`,
      );
    }

    // Audit #333 H2 — manifest tokenId binding.
    //
    // Pre-fix the manifest key was only regex-shape-checked at parse
    // (line ~555) and never asserted against the actual genesis
    // tokenId encoded in the referenced root. A hostile sender could
    // craft `{ "<tokenId-A>": <cid-of-root-that-mints-tokenId-B> }`,
    // pass every element-hash check, and supply downstream consumers
    // with a corrupt mapping that mis-identifies the token.
    //
    // verify.ts also catches this — belt-and-braces for consumers that
    // bypass verify (e.g., direct `fromCar` use without a downstream
    // bundle-verifier round). Failing fast at the import boundary
    // also prevents the corrupt mapping from ever materialising in
    // the in-memory UxfPackageData.
    if (rootEl) {
      if (rootEl.type !== ELEMENT_TYPE_TOKEN_ROOT) {
        throw new UxfError(
          'VERIFICATION_FAILED',
          `Manifest entry for tokenId=${tokenId} points to a non-root element ` +
            `(type='${rootEl.type}'); expected '${ELEMENT_TYPE_TOKEN_ROOT}' ` +
            `(Audit #333 H2).`,
        );
      }
      const rootContentTokenId = (rootEl.content as { tokenId?: unknown })
        .tokenId;
      if (
        typeof rootContentTokenId !== 'string' ||
        rootContentTokenId !== tokenId
      ) {
        throw new UxfError(
          'VERIFICATION_FAILED',
          `Manifest key tokenId=${tokenId} does not match token-root ` +
            `content.tokenId=${
              typeof rootContentTokenId === 'string'
                ? rootContentTokenId
                : '(missing/non-string)'
            } (Audit #333 H2 — identity-confusion primitive).`,
        );
      }
    }
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
 *
 * Issue #435 — predecessor is a Tag 42 CID-link (or null) so the
 * instance-chain edge is part of the dag-cbor DAG that Kubo walks
 * for recursive pin and `/dag/export`. Predecessors land in the CAR
 * via the BFS in `exportToCar.writeBfs` (which already enqueues
 * `element.header.predecessor`) and are now reachable by Kubo's
 * codec-aware walker without any client-side fork.
 */
function buildCanonicalHeader(
  element: UxfElement,
): [number, number, string, CID | null] {
  return [
    element.header.representation,
    element.header.semantics,
    element.header.kind,
    element.header.predecessor !== null
      ? contentHashToCid(element.header.predecessor)
      : null,
  ];
}

/**
 * Decode an IPLD block back to a UxfElement.
 *
 * Issue #435 — children and `header[3]` predecessor are decoded as
 * Tag 42 CID-links (CID instances) only. The PR #213 Option C
 * `Uint8Array` form is no longer accepted (testnet wallets re-mint /
 * re-receive tokens to migrate). Converted to `ContentHash` hex
 * strings for pool indexing.
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
  // Steelman²⁰/²¹: validate representation/semantics/kind at the parse
  // boundary via shared helpers (uxf/header-validation). CBOR-decoded
  // values can be anything (string, BigInt, array, null) — the `as number`
  // / `as string` casts are compile-time only and silently lie.
  assertHeaderVersionField(hdrArray[0], 'IPLD element header[0] (representation)');
  assertHeaderVersionField(hdrArray[1], 'IPLD element header[1] (semantics)');
  assertHeaderKindField(hdrArray[2], 'IPLD element header[2] (kind)');

  // Issue #435 — predecessor is a Tag 42 CID-link (sha2-256, dag-cbor)
  // or `null`. The producer (`buildCanonicalHeader`) emits a `CID`
  // instance; nothing else is accepted. `cidToContentHash` enforces
  // the multihash code is 0x12 (sha2-256) and surfaces a clear
  // serialization error otherwise.
  const predecessor = hdrArray[3];
  let predecessorHash: ContentHash | null = null;
  if (predecessor instanceof CID) {
    predecessorHash = cidToContentHash(predecessor);
  } else if (predecessor !== null && predecessor !== undefined) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `IPLD element header[3] (predecessor) must be a Tag 42 CID-link or null, ` +
        `got ${typeof predecessor}`,
    );
  }

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
      // BigInt from dag-cbor (kept for forward-compat, not produced by current encoder)
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
  // Issue #295 (rewrite #2): the previous `smt-path` segments special
  // case is gone. SmtPath is now a single opaque STS-canonical CBOR
  // bstr — the generic byte-field path (decodeIpldContent) handles it
  // verbatim. UXF does NOT decode the path bytes.

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
 * Decode IPLD children to ContentHash hex strings.
 *
 * Issue #435 — children are dag-cbor Tag 42 CID-links only. CID
 * instances are converted to `ContentHash` hex via `cidToContentHash`
 * (which enforces sha2-256 multihash). `null` is preserved for
 * nullable child slots. Anything else is rejected at the parse
 * boundary — the PR #213 Option C `Uint8Array` form is no longer
 * accepted.
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
      result[key] = value.map((item, index) => {
        if (item instanceof CID) {
          return cidToContentHash(item);
        }
        throw new UxfError(
          'SERIALIZATION_ERROR',
          `Child reference at "${key}[${index}]" must be a Tag 42 CID-link`,
        );
      });
    } else {
      throw new UxfError(
        'SERIALIZATION_ERROR',
        `Child reference at "${key}" must be a Tag 42 CID-link, an array of links, or null`,
      );
    }
  }

  return result;
}

/**
 * Rebuild instance chains from element predecessor links.
 * Scans all elements in the pool and groups them by predecessor chains.
 *
 * Exported for testing the FIX 5 cycle-detection guard. SHA-256 fixed
 * points make a CAR-level cycle computationally infeasible to forge,
 * so the cycle guard is exercised via direct in-memory pool
 * construction (e.g. token-join / merge regression tests).
 */
export function rebuildInstanceChains(
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
  // Steelman³ remediation (FIX 5, Round 3): cycle detection. A hostile
  // CAR can construct two elements pointing at each other via
  // `header.predecessor`, sending the `while (current !== null)` walk
  // into an infinite loop (chain.push grows the array unbounded; the
  // process eventually OOMs). Track visited hashes per-walk and throw
  // if the same hash reappears.
  for (const head of heads) {
    const chain: Array<{ hash: ContentHash; kind: UxfInstanceKind }> = [];
    const seen = new Set<string>();
    let current: ContentHash | null = head;

    while (current !== null) {
      if (seen.has(current as string)) {
        throw new UxfError(
          'INVALID_INSTANCE_CHAIN',
          `predecessor cycle detected at element ${current}`,
        );
      }
      seen.add(current as string);
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
 * Synchronous SHA-256 hash using @noble/hashes (same as in hash.ts).
 * We import from @noble/hashes to avoid the async multiformats sha256.
 */
function sha256Sync(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/**
 * Verify that the SHA-256 of `bytes` equals the digest claimed by `cid`.
 *
 * Steelman remediation: CarReader stores blocks keyed by CID but does
 * NOT re-hash on read. A hostile CAR can place arbitrary bytes under
 * any chosen CID — without re-hash verification, the envelope and
 * manifest blocks are trusted blindly while every pool element IS
 * re-hashed (importFromCar:482).
 *
 * Throws `VERIFICATION_FAILED` on mismatch.
 */
function assertBlockHashMatchesCid(
  bytes: Uint8Array,
  cid: CID,
  label: string,
): void {
  // Steelman³ remediation (FIX 7, Round 3): explicit guard for non-sha2-256
  // multihashes. Without this, a CID built with a different hash algorithm
  // (e.g. sha2-512 = 0x13) hits the generic length-mismatch branch below
  // and emits a confusing message ("length mismatch: 32 vs 64") that hides
  // the root cause (wrong multihash code). The CID-builder side
  // (`cidToContentHash`) already enforces 0x12 — mirror that gate here so
  // the verification path has a clear, dedicated error for the algorithm
  // mismatch.
  if (cid.multihash.code !== SHA256_CODE) {
    throw new UxfError(
      'VERIFICATION_FAILED',
      `${label} CID must use sha2-256 (0x12); got 0x${cid.multihash.code.toString(16)}`,
    );
  }
  const computed = sha256Sync(bytes);
  const claimed = cid.multihash.digest;
  if (computed.length !== claimed.length) {
    throw new UxfError(
      'VERIFICATION_FAILED',
      `${label} block hash does not match its CID (length mismatch: ${computed.length} vs ${claimed.length})`,
    );
  }
  for (let i = 0; i < computed.length; i++) {
    if (computed[i] !== claimed[i]) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `${label} block hash does not match its CID`,
      );
    }
  }
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
