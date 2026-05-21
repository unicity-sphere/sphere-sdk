/**
 * Issue #200 Phase 2 regression: `fetchCarFromIpfs` symmetry with
 * `pinCarBlocksToIpfs`.
 *
 * The consumer-side helper must reassemble a CAR that's byte-shape-
 * compatible with `UxfPackage.fromCar` after the producer has pinned
 * each block individually via `pinCarBlocksToIpfs`. Backwards-compat
 * with legacy raw-pinned bundles (codec = raw) routes through a single
 * `block/get` and returns the bytes verbatim.
 *
 * Tested invariants:
 *   1. Per-block pin + walk round-trip recovers the same `roots[]` and
 *      the same total block set (CIDs match).
 *   2. The returned CAR parses cleanly through `CarReader.fromBytes`.
 *   3. Raw-codec roots take the backcompat branch and return the
 *      single pinned blob verbatim.
 *   4. Unsupported codecs (e.g. dag-pb) are rejected.
 *
 * @module tests/unit/profile/fetchCarFromIpfs
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { encode as dagCborEncode } from '@ipld/dag-cbor';
import { CarReader } from '@ipld/car';
import { fetchCarFromIpfs } from '../../../profile/ipfs-client';
import { makeFakeUxfCar } from './_helpers/fake-uxf-car.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Install a fetch mock that backs `block/get?arg=<cid>` with an in-memory
 * blocks map (the canonical Kubo wire shape produced after a successful
 * `pinCarBlocksToIpfs`). Returns the blocks map so the test can plant
 * extra blocks or measure fetches.
 */
function installBlockGateway(blocks: Map<string, Uint8Array>): Map<string, number> {
  const fetchedCounts = new Map<string, number>();
  globalThis.fetch = async (input, _init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const m = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    if (!m) {
      return new Response('not-found', { status: 404 });
    }
    const cid = decodeURIComponent(m[1]!);
    fetchedCounts.set(cid, (fetchedCounts.get(cid) ?? 0) + 1);
    const bytes = blocks.get(cid);
    if (!bytes) return new Response('missing', { status: 404 });
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };
  return fetchedCounts;
}

describe('fetchCarFromIpfs (Issue #200 Phase 2)', () => {
  it('round-trips a fake hierarchical CAR via per-block fetches', async () => {
    const payload = { tokens: [{ id: 't1' }, { id: 't2' }] };
    const carBytes = await makeFakeUxfCar(payload);

    // Extract every block from the source CAR and plant in the gateway.
    const reader = await CarReader.fromBytes(carBytes);
    const blocks = new Map<string, Uint8Array>();
    for await (const block of reader.blocks()) {
      blocks.set(block.cid.toString(), block.bytes);
    }
    const roots = await reader.getRoots();
    expect(roots).toHaveLength(1);
    const rootCid = roots[0]!.toString();
    expect(blocks.has(rootCid)).toBe(true);

    installBlockGateway(blocks);

    const reassembled = await fetchCarFromIpfs(
      ['https://gateway.test'],
      rootCid,
    );

    // CAR-shape invariant: parses cleanly and reports the same root.
    const reassembledReader = await CarReader.fromBytes(reassembled);
    const reassembledRoots = await reassembledReader.getRoots();
    expect(reassembledRoots).toHaveLength(1);
    expect(reassembledRoots[0]!.toString()).toBe(rootCid);

    // Block-set invariant: every source block is present, no extras.
    const reassembledCids = new Set<string>();
    for await (const block of reassembledReader.blocks()) {
      reassembledCids.add(block.cid.toString());
    }
    expect(reassembledCids).toEqual(new Set(blocks.keys()));
  });

  it('falls back to single block/get for raw-codec roots (legacy backcompat)', async () => {
    // Simulate a legacy bundle: the entire CAR pinned as one raw block.
    // Root CID = CID.createV1(raw, sha256(carBytes)).
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'legacy' }] });
    const rawCidStr = CID.createV1(
      raw.code,
      createMultihash(0x12, sha256(carBytes)),
    ).toString();
    expect(rawCidStr.startsWith('bafkrei')).toBe(true);

    const blocks = new Map<string, Uint8Array>([[rawCidStr, carBytes]]);
    const fetchedCounts = installBlockGateway(blocks);

    const out = await fetchCarFromIpfs(['https://gateway.test'], rawCidStr);

    // Backcompat: bytes returned verbatim, no per-block walk attempted.
    expect(out).toEqual(carBytes);
    expect(fetchedCounts.size).toBe(1);
    expect(fetchedCounts.get(rawCidStr)).toBe(1);
  });

  it('rejects unsupported codec roots (defense-in-depth)', async () => {
    // Construct a dag-pb-coded CID (codec 0x70, not raw or dag-cbor).
    const dummyBytes = new Uint8Array([1, 2, 3]);
    const dagPbCid = CID.createV1(
      0x70,
      createMultihash(0x12, sha256(dummyBytes)),
    ).toString();

    installBlockGateway(new Map());

    await expect(
      fetchCarFromIpfs(['https://gateway.test'], dagPbCid),
    ).rejects.toThrow(/unsupported root codec/);
  });

  it('rejects an unparseable root CID before any network round-trip', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchSpy;

    await expect(
      fetchCarFromIpfs(['https://gateway.test'], 'NOT_A_CID'),
    ).rejects.toThrow(/cannot parse root CID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dedupes shared sub-blocks across BFS — same CID is fetched once', async () => {
    // Hand-build a tiny DAG where two parents reference the same child
    // CID so the walk encounters the same sub-CID twice in its queue.
    // The leaf has empty content; the parents reference it via Tag 42.
    const leafBytes = dagCborEncode({ leaf: true });
    const leafCid = CID.createV1(
      0x71,
      createMultihash(0x12, sha256(leafBytes)),
    );

    const parentA = dagCborEncode({ ref: leafCid });
    const parentACid = CID.createV1(
      0x71,
      createMultihash(0x12, sha256(parentA)),
    );

    const parentB = dagCborEncode({ ref: leafCid });
    const parentBCid = CID.createV1(
      0x71,
      createMultihash(0x12, sha256(parentB)),
    );
    // parentA bytes ≠ parentB bytes only if the encoded representations
    // differ — we ensure they do by injecting distinguishing tags.
    const parentBV2 = dagCborEncode({ ref: leafCid, tag: 'B' });
    const parentBV2Cid = CID.createV1(
      0x71,
      createMultihash(0x12, sha256(parentBV2)),
    );

    const root = dagCborEncode({ children: [parentACid, parentBV2Cid] });
    const rootCid = CID.createV1(0x71, createMultihash(0x12, sha256(root)));

    const blocks = new Map<string, Uint8Array>([
      [rootCid.toString(), root],
      [parentACid.toString(), parentA],
      [parentBV2Cid.toString(), parentBV2],
      [leafCid.toString(), leafBytes],
    ]);
    // Suppress unused — keep for parity with parentB calculation.
    void parentBCid;
    const fetchedCounts = installBlockGateway(blocks);

    const out = await fetchCarFromIpfs(
      ['https://gateway.test'],
      rootCid.toString(),
    );

    // Leaf must be fetched exactly once even though both parents link
    // to it — `visited` set deduplicates.
    expect(fetchedCounts.get(leafCid.toString())).toBe(1);

    const reader = await CarReader.fromBytes(out);
    const cids = new Set<string>();
    for await (const b of reader.blocks()) cids.add(b.cid.toString());
    expect(cids.size).toBe(4);
  });
});
