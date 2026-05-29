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

  it('#213: walks UXF element blocks via Uint8Array children (Option C walker)', async () => {
    // Real Option C round-trip: produce a multi-block UXF bundle via
    // `exportToCar` (envelope + manifest + per-element blocks where
    // children are encoded as raw 32-byte Uint8Array, not Tag 42 CID
    // links), plant every block in the gateway, then walk the CAR
    // from the root via `fetchCarFromIpfs`. The walker MUST detect
    // UXF element shape (`isUxfElement`) and convert Uint8Array
    // children into CID references via `contentHashBytesToCid` —
    // otherwise the BFS terminates after the envelope+manifest and
    // misses every element block, returning an incomplete CAR that
    // `UxfPackage.fromCar` rejects with a missing-block error.
    const { exportToCar } = await import('../../../uxf/ipld.js');
    const { ElementPool } = await import('../../../uxf/element-pool.js');
    const { deconstructToken } = await import('../../../uxf/deconstruct.js');

    function hexFill(pattern: string, totalChars: number): string {
      return pattern
        .repeat(Math.ceil(totalChars / pattern.length))
        .slice(0, totalChars);
    }
    function makeValidToken(suffix: string): Record<string, unknown> {
      const tokenId = hexFill(suffix, 64);
      return {
        version: '2.0',
        state: { predicate: 'a0'.repeat(32), data: null },
        genesis: {
          data: {
            tokenId,
            tokenType: '00'.repeat(32),
            coinData: [['UCT', '1000000']],
            tokenData: '',
            salt: hexFill('ab', 64),
            recipient: 'DIRECT://test',
            recipientDataHash: null,
            reason: null,
          },
          inclusionProof: {
            authenticator: {
              algorithm: 'secp256k1',
              publicKey: '02' + 'aa'.repeat(32),
              signature: '30' + 'bb'.repeat(63),
              stateHash: 'cc'.repeat(32),
            },
            merkleTreePath: {
              root: 'dd'.repeat(32),
              steps: [{ data: 'ee'.repeat(32), path: '0' }],
            },
            transactionHash: 'ff'.repeat(32),
            unicityCertificate: '11'.repeat(100),
          },
        },
        transactions: [],
        nametags: [],
      };
    }

    const pool = new ElementPool();
    const rootHash = deconstructToken(pool, makeValidToken('c1'));
    const tokenId = (
      (makeValidToken('c1').genesis as Record<string, unknown>).data as Record<
        string,
        unknown
      >
    ).tokenId as string;
    const pkg = {
      envelope: { version: '1.0.0' as const, createdAt: 1700000000, updatedAt: 1700000001 },
      manifest: { tokens: new Map([[tokenId.toLowerCase(), rootHash]]) },
      pool: pool.toMap() as Map<string, never>,
      instanceChains: new Map(),
      indexes: {
        byTokenType: new Map(),
        byCoinId: new Map(),
        byStateHash: new Map(),
      },
    };
    // Cast through unknown because the local type is a wider structure
    // than `exportToCar`'s parameter — the runtime shape matches.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const carBytes = await exportToCar(pkg as any);

    // Extract every block from the source CAR and plant in the gateway.
    const sourceReader = await CarReader.fromBytes(carBytes);
    const blocks = new Map<string, Uint8Array>();
    let dagCborBlockCount = 0;
    for await (const block of sourceReader.blocks()) {
      blocks.set(block.cid.toString(), block.bytes);
      if (block.cid.code === 0x71) dagCborBlockCount += 1;
    }
    // Sanity: a real bundle has envelope + manifest + at least one
    // element block. If this trips, the bundle builder regressed and
    // the per-block walker test is no longer meaningful.
    expect(dagCborBlockCount).toBeGreaterThanOrEqual(3);

    const roots = await sourceReader.getRoots();
    expect(roots).toHaveLength(1);
    const rootCid = roots[0]!.toString();

    installBlockGateway(blocks);

    // Walk via fetchCarFromIpfs — this is the consumer-side path that
    // exercises `isUxfElement` + `walkUxfElement` + `contentHashBytesToCid`.
    const reassembled = await fetchCarFromIpfs(
      ['https://gateway.test'],
      rootCid,
    );

    // The reassembled CAR must contain every source block — the walker
    // discovered every element block reachable from the root via
    // Uint8Array children (envelope CID-link to manifest, manifest
    // CID-links to roots, roots' Uint8Array children to descendants).
    const reassembledReader = await CarReader.fromBytes(reassembled);
    const reassembledCids = new Set<string>();
    for await (const block of reassembledReader.blocks()) {
      reassembledCids.add(block.cid.toString());
    }
    expect(reassembledCids).toEqual(new Set(blocks.keys()));

    // Final check: the reassembled CAR is itself importable through the
    // UXF receiver, verifying the per-block sha256(bytes) === cid check
    // in `importFromCar` is satisfied for every walked sub-block.
    const { importFromCar } = await import('../../../uxf/ipld.js');
    const restored = await importFromCar(reassembled);
    expect(restored.manifest.tokens.size).toBe(1);
    expect(restored.pool.size).toBe(pkg.pool.size);
  });
});
