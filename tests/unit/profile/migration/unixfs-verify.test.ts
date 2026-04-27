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
});
