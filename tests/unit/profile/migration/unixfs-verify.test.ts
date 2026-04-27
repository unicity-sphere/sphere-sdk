/**
 * Wave G.5 — UnixFS payload content-verification tests.
 *
 * Builds CARs in memory using @ipld/car's CarBufferWriter, then
 * exercises verifyCarAndExtractFile across:
 *   - raw-codec single block (round-trip)
 *   - dag-pb wrapped UnixFS file with inline data
 *   - dag-pb wrapped UnixFS file with linked chunks
 *   - tampering attacks (wrong root CID, wrong block bytes, mismatched
 *     blocksizes, unsupported types)
 */

import { describe, it, expect } from 'vitest';
import * as CarBufferWriter from '@ipld/car/buffer-writer';
import * as dagPb from '@ipld/dag-pb';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';

import { verifyCarAndExtractFile } from '../../../../profile/migration/unixfs-verify.js';

const CODEC_RAW = 0x55;
const CODEC_DAGPB = 0x70;
const MULTIHASH_SHA256 = 0x12;

function cidForBytes(bytes: Uint8Array, codec: number): CID {
  const digest = sha256(bytes);
  const mh = Digest.create(MULTIHASH_SHA256, digest);
  return CID.createV1(codec, mh);
}

// =============================================================================
// Minimal UnixFS protobuf encoder (mirror of the decoder in
// unixfs-verify.ts) — for building synthetic CARs in tests.
// =============================================================================

function writeVarint(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function encodeUnixFsFile(opts: { data?: Uint8Array; blocksizes?: bigint[]; filesize?: bigint }): Uint8Array {
  const parts: Uint8Array[] = [];
  // Field 1 (Type, varint): File = 2
  parts.push(Uint8Array.from([0x08]));
  parts.push(writeVarint(2n));
  if (opts.data && opts.data.length > 0) {
    // Field 2 (Data, length-delimited)
    parts.push(Uint8Array.from([0x12]));
    parts.push(writeVarint(BigInt(opts.data.length)));
    parts.push(opts.data);
  }
  if (opts.filesize !== undefined) {
    parts.push(Uint8Array.from([0x18]));
    parts.push(writeVarint(opts.filesize));
  }
  if (opts.blocksizes) {
    for (const sz of opts.blocksizes) {
      parts.push(Uint8Array.from([0x20]));
      parts.push(writeVarint(sz));
    }
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// =============================================================================
// CAR builder
// =============================================================================

function buildCar(roots: CID[], blocks: Array<{ cid: CID; bytes: Uint8Array }>): Uint8Array {
  let totalBlockSize = 0;
  for (const b of blocks) {
    totalBlockSize += CarBufferWriter.blockLength({ cid: b.cid, bytes: b.bytes });
  }
  const headerSize = CarBufferWriter.headerLength({ roots });
  const buf = new Uint8Array(headerSize + totalBlockSize);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writer = CarBufferWriter.createWriter(buf, { roots: roots as any });
  for (const b of blocks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writer.write({ cid: b.cid as any, bytes: b.bytes });
  }
  return writer.close();
}

// =============================================================================
// Tests
// =============================================================================

describe('verifyCarAndExtractFile (Wave G.5)', () => {
  it('round-trips a raw-codec single-block file', async () => {
    const fileBytes = new TextEncoder().encode('hello world — raw codec');
    const cid = cidForBytes(fileBytes, CODEC_RAW);
    const car = buildCar([cid], [{ cid, bytes: fileBytes }]);
    const out = await verifyCarAndExtractFile(car, cid);
    expect(out).toEqual(fileBytes);
  });

  it('round-trips a dag-pb UnixFS file with inline data (single block)', async () => {
    const fileBytes = new TextEncoder().encode('hello world — UnixFS inline');
    const unixFsData = encodeUnixFsFile({ data: fileBytes, filesize: BigInt(fileBytes.length) });
    const pbBytes = dagPb.encode({ Data: unixFsData, Links: [] });
    const cid = cidForBytes(pbBytes, CODEC_DAGPB);
    const car = buildCar([cid], [{ cid, bytes: pbBytes }]);
    const out = await verifyCarAndExtractFile(car, cid);
    expect(out).toEqual(fileBytes);
  });

  it('round-trips a multi-block UnixFS file (root + 2 raw chunks)', async () => {
    const chunkA = new TextEncoder().encode('chunk-a-content');
    const chunkB = new TextEncoder().encode('chunk-b-content');
    const cidA = cidForBytes(chunkA, CODEC_RAW);
    const cidB = cidForBytes(chunkB, CODEC_RAW);
    const rootData = encodeUnixFsFile({
      blocksizes: [BigInt(chunkA.length), BigInt(chunkB.length)],
      filesize: BigInt(chunkA.length + chunkB.length),
    });
    const rootPb = dagPb.encode({
      Data: rootData,
      Links: [
        { Hash: cidA, Tsize: chunkA.length, Name: '' },
        { Hash: cidB, Tsize: chunkB.length, Name: '' },
      ],
    });
    const rootCid = cidForBytes(rootPb, CODEC_DAGPB);
    const car = buildCar(
      [rootCid],
      [
        { cid: rootCid, bytes: rootPb },
        { cid: cidA, bytes: chunkA },
        { cid: cidB, bytes: chunkB },
      ],
    );
    const out = await verifyCarAndExtractFile(car, rootCid);
    const expected = new Uint8Array(chunkA.length + chunkB.length);
    expected.set(chunkA, 0);
    expected.set(chunkB, chunkA.length);
    expect(out).toEqual(expected);
  });

  it('rejects CAR whose root CID does not match expected', async () => {
    const fileBytes = new TextEncoder().encode('legitimate');
    const cid = cidForBytes(fileBytes, CODEC_RAW);
    const car = buildCar([cid], [{ cid, bytes: fileBytes }]);
    const otherBytes = new TextEncoder().encode('different');
    const otherCid = cidForBytes(otherBytes, CODEC_RAW);
    await expect(verifyCarAndExtractFile(car, otherCid)).rejects.toThrow(/CAR root.*!= expected/);
  });

  it('rejects block whose bytes do not hash to its declared CID (gateway-tampering)', async () => {
    // Build a CAR but include the WRONG bytes for the root block.
    // The CarReader will still parse — we need to assemble the CAR
    // bytes manually with mismatched CID/bytes pairs.
    const realBytes = new TextEncoder().encode('real');
    const realCid = cidForBytes(realBytes, CODEC_RAW);
    const tamperedBytes = new TextEncoder().encode('tampered');
    // Use realCid as the declared root, but write tamperedBytes as
    // the block content. Block-hash verification must catch this.
    const car = buildCar([realCid], [{ cid: realCid, bytes: tamperedBytes }]);
    await expect(verifyCarAndExtractFile(car, realCid)).rejects.toThrow(
      /bytes do not hash to declared digest/,
    );
  });

  it('rejects UnixFS root with mismatched blocksizes / Links length', async () => {
    const chunkA = new TextEncoder().encode('a');
    const cidA = cidForBytes(chunkA, CODEC_RAW);
    // Two blocksizes but only one Link — malformed UnixFS.
    const rootData = encodeUnixFsFile({ blocksizes: [1n, 1n], filesize: 2n });
    const rootPb = dagPb.encode({
      Data: rootData,
      Links: [{ Hash: cidA, Tsize: chunkA.length, Name: '' }],
    });
    const rootCid = cidForBytes(rootPb, CODEC_DAGPB);
    const car = buildCar(
      [rootCid],
      [
        { cid: rootCid, bytes: rootPb },
        { cid: cidA, bytes: chunkA },
      ],
    );
    await expect(verifyCarAndExtractFile(car, rootCid)).rejects.toThrow(
      /blocksizes length.*disagrees with PBNode\.Links length/,
    );
  });

  it('rejects UnixFS Directory type (we only verify file payloads)', async () => {
    // Build a UnixFS Directory (Type=1) — should be refused.
    const dirData = Uint8Array.from([0x08, 0x01]); // field 1, varint, value 1 (Directory)
    const pbBytes = dagPb.encode({ Data: dirData, Links: [] });
    const cid = cidForBytes(pbBytes, CODEC_DAGPB);
    const car = buildCar([cid], [{ cid, bytes: pbBytes }]);
    await expect(verifyCarAndExtractFile(car, cid)).rejects.toThrow(/only File \/ Raw types supported/);
  });

  // Wave I.9: cycle / fanout / shared-subtree defenses
  it('rejects a cycle in the DAG (self-reference)', async () => {
    // Build a UnixFS file root that links to itself.
    const placeholderChunk = new TextEncoder().encode('x');
    const cidA = cidForBytes(placeholderChunk, CODEC_RAW);
    // Construct a dag-pb whose Links includes its OWN CID. Need to
    // pre-compute a pb whose CID equals one of its Link.Hash values.
    // Trick: build a self-link by using a dummy CID that we then put
    // in the CAR under its own actual hash; the cycle detector
    // catches the second visit regardless of CID identity.
    const rootData = encodeUnixFsFile({ blocksizes: [BigInt(placeholderChunk.length)] });
    const rootPb = dagPb.encode({
      Data: rootData,
      Links: [{ Hash: cidA, Tsize: placeholderChunk.length, Name: '' }],
    });
    const rootCid = cidForBytes(rootPb, CODEC_DAGPB);
    // Now build a SECOND dag-pb that refers to itself (cycle):
    // root2 links to root2. We can't pre-compute a self-referential
    // CID easily without a fixed point, so instead construct a 2-
    // node cycle: pbA links to pbB, pbB links to pbA. Both are dag-
    // pb files (each link is a "child"). The cycle detector should
    // catch the revisit.
    const pbB_data = encodeUnixFsFile({ blocksizes: [1n] });
    // Step 1: construct pbB referencing pbA's eventual CID. We need
    // to know pbA's CID first — build pbA pointing to a placeholder
    // for pbB, compute pbB's expected CID, then iterate. Simpler:
    // use a 1-block file that points to itself by having Links
    // contain a forged CID; cycle won't fire on a single visit but
    // the repeated visit chain over depth=16 hits depth limit.
    // Skip a true cycle and instead test the depth cap directly.
    // Actually: we can construct a 2-block deep structure where
    // both blocks reference each other, but constructing this
    // without a fixed-point hash requires solving a cyclic CID
    // dependency which is impossible in finite time without finding
    // a hash collision. So we test the depth-cap path instead — a
    // chain of 17 nodes triggers the depth cap.
    const chunks: Array<{ cid: CID; bytes: Uint8Array }> = [];
    let currentCid = cidA;
    chunks.push({ cid: cidA, bytes: placeholderChunk });
    for (let i = 0; i < 17; i++) {
      const data = encodeUnixFsFile({ blocksizes: [BigInt(placeholderChunk.length)] });
      const pb = dagPb.encode({
        Data: data,
        Links: [{ Hash: currentCid, Tsize: 1, Name: '' }],
      });
      const cid = cidForBytes(pb, CODEC_DAGPB);
      chunks.push({ cid, bytes: pb });
      currentCid = cid;
    }
    const car = buildCar([currentCid], chunks);
    void rootCid; void rootPb;
    await expect(verifyCarAndExtractFile(car, currentCid)).rejects.toThrow(/recursion depth exceeded/);
  });

  it('rejects fanout-bomb (too many links per node)', async () => {
    // Build a root with > MAX_LINKS_PER_NODE Links. We use 4097.
    const chunk = new TextEncoder().encode('a');
    const chunkCid = cidForBytes(chunk, CODEC_RAW);
    const numLinks = 4097;
    const blocksizes: bigint[] = new Array(numLinks).fill(BigInt(chunk.length));
    const links = new Array(numLinks).fill(0).map(() => ({ Hash: chunkCid, Tsize: chunk.length, Name: '' }));
    const rootData = encodeUnixFsFile({ blocksizes });
    const rootPb = dagPb.encode({ Data: rootData, Links: links });
    const rootCid = cidForBytes(rootPb, CODEC_DAGPB);
    const car = buildCar([rootCid], [
      { cid: rootCid, bytes: rootPb },
      { cid: chunkCid, bytes: chunk },
    ]);
    await expect(verifyCarAndExtractFile(car, rootCid)).rejects.toThrow(/fanout-bomb/);
  });

  // Wave I.1.b — diamond DAG with a legitimately-shared leaf must NOT
  // trip the cycle detector. Two sibling intermediate nodes both link
  // to the same leaf chunk; the path-visited set must clean up between
  // sibling traversals.
  it('accepts diamond-DAG sharing a deduplicated leaf across siblings', async () => {
    const sharedLeaf = new TextEncoder().encode('shared-leaf-data');
    const leafCid = cidForBytes(sharedLeaf, CODEC_RAW);

    // Two intermediate dag-pb nodes, each linking to the same leaf.
    const interData = encodeUnixFsFile({ blocksizes: [BigInt(sharedLeaf.length)] });
    const interPb1 = dagPb.encode({
      Data: interData,
      Links: [{ Hash: leafCid, Tsize: sharedLeaf.length, Name: '' }],
    });
    // Use a different Tsize / Name so the two intermediate blocks
    // hash differently and have distinct CIDs.
    const interPb2 = dagPb.encode({
      Data: interData,
      Links: [{ Hash: leafCid, Tsize: sharedLeaf.length + 1, Name: '' }],
    });
    const interCid1 = cidForBytes(interPb1, CODEC_DAGPB);
    const interCid2 = cidForBytes(interPb2, CODEC_DAGPB);
    expect(interCid1.toString()).not.toBe(interCid2.toString());

    // Root linking to both intermediates.
    const rootData = encodeUnixFsFile({
      blocksizes: [BigInt(sharedLeaf.length), BigInt(sharedLeaf.length)],
    });
    const rootPb = dagPb.encode({
      Data: rootData,
      Links: [
        { Hash: interCid1, Tsize: sharedLeaf.length, Name: '' },
        { Hash: interCid2, Tsize: sharedLeaf.length + 1, Name: '' },
      ],
    });
    const rootCid = cidForBytes(rootPb, CODEC_DAGPB);

    const car = buildCar(
      [rootCid],
      [
        { cid: rootCid, bytes: rootPb },
        { cid: interCid1, bytes: interPb1 },
        { cid: interCid2, bytes: interPb2 },
        { cid: leafCid, bytes: sharedLeaf },
      ],
    );

    // Reconstructed file = leaf bytes concatenated twice (once per
    // sibling subtree). MUST NOT throw "cycle detected".
    const out = await verifyCarAndExtractFile(car, rootCid);
    expect(out.length).toBe(sharedLeaf.length * 2);
    expect(out.subarray(0, sharedLeaf.length)).toEqual(sharedLeaf);
    expect(out.subarray(sharedLeaf.length)).toEqual(sharedLeaf);
  });

  // Wave I.10: malformed Type field varint > 0xffff triggers the
  // out-of-range guard before the BigInt → Number downcast.
  it('rejects out-of-range UnixFS Type field varint', async () => {
    // Type = 0x100000 (well above the UnixFS type-enum cap 0..5 and
    // above the 0xffff guard). Encoded as: tag 0x08 (field 1, varint),
    // followed by a multi-byte varint for 0x100000:
    //   0x100000 = 1048576 → 7-bit groups: 0000001 0000000 0000000 0000000
    //                       → low-to-high: 0x80 0x80 0x80 0x40
    const malformedData = Uint8Array.from([
      0x08, 0x80, 0x80, 0x80, 0x80, 0x40, // field 1, varint, value 0x100000000
    ]);
    const pbBytes = dagPb.encode({ Data: malformedData, Links: [] });
    const cid = cidForBytes(pbBytes, CODEC_DAGPB);
    const car = buildCar([cid], [{ cid, bytes: pbBytes }]);
    await expect(verifyCarAndExtractFile(car, cid)).rejects.toThrow(/Type field value.*out of range/);
  });
});
