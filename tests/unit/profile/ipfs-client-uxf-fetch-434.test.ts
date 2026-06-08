/**
 * Issue #434 receiver-side regression — `fetchCarFromIpfs` skips
 * `/dag/export` when the root has the UXF element shape.
 *
 * # Why this test exists
 *
 * Kubo's `/api/v0/dag/export` walks the DAG via codec-aware IPLD link
 * extraction. For dag-cbor, that means Tag 42 CBOR tags only. UXF
 * bundle CAR roots (per PR #213 Option C) encode `children` and
 * `header[3]` as raw 32-byte Uint8Array — NOT as Tag 42. Kubo's IPLD
 * walker doesn't recognize raw-byte refs as links → `/dag/export`
 * returns a CAR containing ONLY the root.
 *
 * The receiver then can't reassemble the bundle. `UxfPackage.fromCar`
 * sees a single-block CAR, finds no children, and silently produces
 * an empty package. Recovery returns 0 tokens — the exact failure
 * mode tracked in issue #434.
 *
 * The fix peeks the root block via `/api/v0/block/get` BEFORE
 * committing to `/dag/export`. If `isUxfElement(decoded)` matches,
 * we force the UXF-aware legacy BFS walker (`walkUxfElement`) which
 * correctly traverses raw-byte refs.
 *
 * # What this test asserts
 *
 *  1. A dag-cbor root with the canonical UXF shape (`{ header, type,
 *     content, children }`) routes through legacy BFS — `/dag/export`
 *     is NEVER called.
 *  2. A dag-cbor root WITHOUT the UXF shape (e.g., a Profile lean
 *     snapshot root with `{ entryGroups, bundles, ... }`) still uses
 *     the `/dag/export` fast path after the peek confirms it's safe.
 *  3. The peek block/get call always happens — it's the safety
 *     check that drives the routing decision.
 *
 * # Verification protocol
 *
 * The "FIX (post-#434)" assertion that `dagExportCalls === 0` for a
 * UXF root MUST fail if the safety check is removed. Specifically,
 * removing the `if (rootIsUxf) { return fetchCarFromIpfsLegacy(...) }`
 * branch would let the test see a `/dag/export` call and the
 * assertion would flip red.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';
import { encode as dagCborEncode } from '@ipld/dag-cbor';
import { CarReader } from '@ipld/car';
import { CarWriter } from '@ipld/car/writer';

import {
  fetchCarFromIpfs,
  _resetGatewayCapabilityCache,
} from '../../../profile/ipfs-client';

const DAG_CBOR_CODE = 0x71;

// ---------------------------------------------------------------------------
// Mock builder
// ---------------------------------------------------------------------------

interface FetchCounts {
  blockGetCalls: number;
  dagExportCalls: number;
  pinAddCalls: number;
  dagImportCalls: number;
}

function installFetchMock(opts: {
  /** Map of CID → bytes for /api/v0/block/get responses. */
  readonly blocks: Map<string, Uint8Array>;
  /**
   * If supplied, /api/v0/dag/export?arg=<cid> returns these bytes
   * with status 200. If absent, returns 404 so the caller's fallback
   * to legacy BFS still works.
   */
  readonly exportBytes?: Uint8Array;
  /**
   * /api/v0/dag/import|export probe response (sent with no body).
   * Use status 200 to advertise the endpoint as available, 404 to
   * advertise unavailable. Default 200 so the fast path is reachable.
   */
  readonly probeStatus?: number;
}): { counts: FetchCounts; restore: () => void } {
  const original = globalThis.fetch;
  const counts: FetchCounts = {
    blockGetCalls: 0,
    dagExportCalls: 0,
    pinAddCalls: 0,
    dagImportCalls: 0,
  };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? String(input);

    const isProbe =
      (url.endsWith('/api/v0/dag/import') || url.endsWith('/api/v0/dag/export')) &&
      init?.body === undefined;
    if (isProbe) {
      return new Response('', { status: opts.probeStatus ?? 200 });
    }

    if (url.includes('/api/v0/dag/export?')) {
      counts.dagExportCalls += 1;
      if (opts.exportBytes === undefined) {
        return new Response('not configured', { status: 404 });
      }
      return new Response(opts.exportBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.ipld.car' },
      });
    }

    if (url.includes('/api/v0/block/get?arg=')) {
      counts.blockGetCalls += 1;
      const m = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
      if (!m) return new Response('missing arg', { status: 400 });
      const cid = decodeURIComponent(m[1]!);
      const bytes = opts.blocks.get(cid);
      if (!bytes) return new Response('miss', { status: 404 });
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }

    if (url.includes('/api/v0/dag/import')) {
      counts.dagImportCalls += 1;
      return new Response('', { status: 200 });
    }

    if (url.includes('/api/v0/pin/add')) {
      counts.pinAddCalls += 1;
      return new Response('', { status: 200 });
    }

    if (url.includes('/sidecar/blob') || url.includes('/sidecar/submit')) {
      return new Response('', { status: 404 });
    }

    return new Response('unhandled', { status: 404 });
  }) as typeof globalThis.fetch;

  return { counts, restore: () => { globalThis.fetch = original; } };
}

/**
 * Build a CAR whose dag-cbor root has the canonical UXF element shape
 * (`isUxfElement` returns `true`). Includes a child block whose CID
 * is referenced from `children.foo` as a RAW 32-byte digest (PR #213
 * Option C encoding). Production UXF roots are produced by
 * `uxf/ipld.ts:elementToIpldBlock`; this helper mirrors the salient
 * structural requirements for the test.
 */
async function buildUxfCar(): Promise<{
  carBytes: Uint8Array;
  rootCid: string;
  childCid: string;
}> {
  // Child block — opaque dag-cbor payload. The CID is what we embed
  // in the root's `children.foo` as a 32-byte digest.
  const childBytes = dagCborEncode({ payload: 'uxf-child' });
  const childDigest = createDigest(0x12, nobleSha256(childBytes));
  const childCid = CID.createV1(DAG_CBOR_CODE, childDigest);

  // Root block — canonical UXF element shape:
  //   { header: [...], type: number, content: {...}, children: {...} }
  // The `children.foo` value is the child's raw 32-byte digest, not a
  // Tag 42 CID. This is exactly the shape Kubo's IPLD walker fails to
  // follow, which is what triggers the issue #434 regression.
  const rootDoc = {
    header: [1, 'test-uxf-root', 0, null],
    type: 1,
    content: { kind: 'uxf-test' },
    children: { foo: childDigest.digest },
  };
  const rootBytes = dagCborEncode(rootDoc);
  const rootDigest = createDigest(0x12, nobleSha256(rootBytes));
  const rootCid = CID.createV1(DAG_CBOR_CODE, rootDigest);

  // Stream the CAR — root first (matches production CAR ordering).
  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await writer.put({ cid: rootCid, bytes: rootBytes });
  await writer.put({ cid: childCid, bytes: childBytes });
  await writer.close();
  await collect;

  let total = 0;
  for (const c of chunks) total += c.length;
  const carBytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    carBytes.set(c, offset);
    offset += c.length;
  }

  return {
    carBytes,
    rootCid: rootCid.toString(),
    childCid: childCid.toString(),
  };
}

/**
 * Build a CAR whose root is dag-cbor but does NOT match the UXF
 * element shape — mirrors a Profile lean snapshot root or any other
 * generic dag-cbor block. `isUxfElement` returns `false` for this
 * shape, so `fetchCarFromIpfs` is free to use the /dag/export fast
 * path after the peek confirms it's safe.
 */
async function buildNonUxfCar(): Promise<{
  carBytes: Uint8Array;
  rootCid: string;
}> {
  const rootBytes = dagCborEncode({
    version: 3,
    chainPubkey: 'test',
    entryGroups: [],
    bundles: [],
  });
  const rootDigest = createDigest(0x12, nobleSha256(rootBytes));
  const rootCid = CID.createV1(DAG_CBOR_CODE, rootDigest);

  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await writer.put({ cid: rootCid, bytes: rootBytes });
  await writer.close();
  await collect;

  let total = 0;
  for (const c of chunks) total += c.length;
  const carBytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    carBytes.set(c, offset);
    offset += c.length;
  }

  return {
    carBytes,
    rootCid: rootCid.toString(),
  };
}

async function carToBlocks(carBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = await CarReader.fromBytes(carBytes);
  const out = new Map<string, Uint8Array>();
  for await (const block of reader.blocks()) {
    out.set(block.cid.toString(), block.bytes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #434 — fetchCarFromIpfs skips /dag/export for UXF roots', () => {
  beforeEach(() => {
    _resetGatewayCapabilityCache();
  });

  afterEach(() => {
    _resetGatewayCapabilityCache();
  });

  it('FIX (post-#434): UXF root forces legacy BFS — no /dag/export call', async () => {
    const { carBytes, rootCid } = await buildUxfCar();
    const blocks = await carToBlocks(carBytes);

    const { counts, restore } = installFetchMock({
      blocks,
      // Configure exportBytes too, so if the fast path WERE taken
      // we'd see a non-zero count — the failure mode is "we used
      // the fast path when we shouldn't have", not "we couldn't
      // export". This makes the assertion crisp.
      exportBytes: carBytes,
    });
    try {
      const out = await fetchCarFromIpfs(['https://gw-uxf.test'], rootCid);

      // FIX-load-bearing assertions:
      // 1. /dag/export was NOT called — the UXF safety check
      //    routed us to legacy BFS.
      expect(counts.dagExportCalls).toBe(0);
      // 2. /block/get was called at least once: the peek + legacy
      //    BFS walk's per-block fetches.
      expect(counts.blockGetCalls).toBeGreaterThan(0);

      // Output is a valid CAR with the same root.
      const outReader = await CarReader.fromBytes(out);
      const outRoots = await outReader.getRoots();
      expect(outRoots[0]!.toString()).toBe(rootCid);
    } finally {
      restore();
    }
  });

  it('non-UXF root continues to use /dag/export fast path after the peek', async () => {
    const { carBytes, rootCid } = await buildNonUxfCar();
    const blocks = await carToBlocks(carBytes);

    const { counts, restore } = installFetchMock({
      blocks,
      exportBytes: carBytes,
    });
    try {
      await fetchCarFromIpfs(['https://gw-non-uxf.test'], rootCid);
      // Fast path taken: exactly one /dag/export call.
      expect(counts.dagExportCalls).toBe(1);
      // And the peek call: one /block/get for the root.
      expect(counts.blockGetCalls).toBe(1);
    } finally {
      restore();
    }
  });

  it('UXF detection: peek failure (root block 404) does NOT mis-classify', async () => {
    // Simulate the root block being unreachable on /block/get. The
    // peek catches the throw and proceeds without classifying the
    // root. Behaviour: fall through to the /dag/export fast path
    // (defensive default — no worse than pre-#434).
    const { carBytes, rootCid } = await buildNonUxfCar();
    const blocks = new Map<string, Uint8Array>(); // empty — every block/get 404s

    const { counts, restore } = installFetchMock({
      blocks,
      exportBytes: carBytes,
    });
    try {
      await fetchCarFromIpfs(['https://gw-no-peek.test'], rootCid);
      // Peek block/get attempt counted as a failed call.
      expect(counts.blockGetCalls).toBeGreaterThan(0);
      // Fall-through proceeds to fast path (since rootIsUxf stays
      // false on peek failure).
      expect(counts.dagExportCalls).toBe(1);
    } finally {
      restore();
    }
  });
});
