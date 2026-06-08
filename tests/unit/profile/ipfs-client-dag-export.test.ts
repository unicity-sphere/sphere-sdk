/**
 * Issue #370 — `fetchCarFromIpfs` `/dag/export` fast-path tests.
 *
 * Verifies the selector layer added in issue #370 on the read side:
 *   - Probe-driven fast path: a single `/dag/export` POST replaces the
 *     per-block `/api/v0/block/get` BFS walk, returns CAR bytes that the
 *     selector parses + verifies block-by-block + reassembles.
 *   - Per-block CID verification: a gateway returning a CAR with one
 *     mismatched block triggers fallback to legacy BFS (defense-in-depth
 *     against gateway tampering).
 *   - Missing-root defensive check: a CAR returned by /dag/export that
 *     does not contain the requested root triggers fallback.
 *   - Probe-miss fallback: gateway returning 404 from probe → legacy BFS
 *     walks `/api/v0/block/get`.
 *   - Byte-for-byte equivalence: fast-path output and legacy BFS output
 *     reassemble identical CAR bytes for the same input fixture.
 *
 * @module tests/unit/profile/ipfs-client-dag-export
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';
import { encode as dagCborEncode } from '@ipld/dag-cbor';
import { CarReader } from '@ipld/car';
import {
  fetchCarFromIpfs,
  _resetGatewayCapabilityCache,
} from '../../../profile/ipfs-client';
import { makeFakeUxfCar } from './_helpers/fake-uxf-car.js';

// ---------------------------------------------------------------------------
// Fetch mock builders
// ---------------------------------------------------------------------------

interface ExportMockOptions {
  readonly probeStatus: number;
  /** Bytes to return on /api/v0/dag/export call. */
  readonly exportBytes?: Uint8Array;
  /** Status to return on /api/v0/dag/export call (default 200). */
  readonly exportStatus?: number;
  /** Blocks map for legacy /api/v0/block/get fallback path. */
  readonly blocks?: Map<string, Uint8Array>;
}

interface MockHandle {
  readonly restore: () => void;
  readonly exportCalls: () => number;
  readonly blockGetCalls: () => number;
}

function installMock(opts: ExportMockOptions): MockHandle {
  const original = globalThis.fetch;
  const counts = { exportCalls: 0, blockGetCalls: 0 };

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? String(input);

    // Probe: a POST to /api/v0/dag/import or /api/v0/dag/export with no
    // body. The real fast-path /dag/export has `arg=<cid>` in the query.
    const isProbe =
      (url.endsWith('/api/v0/dag/import') || url.endsWith('/api/v0/dag/export')) &&
      init?.body === undefined;
    if (isProbe) {
      return new Response('', { status: opts.probeStatus });
    }

    if (url.includes('/api/v0/dag/export?')) {
      counts.exportCalls += 1;
      const status = opts.exportStatus ?? 200;
      if (status !== 200) {
        return new Response('forced failure', { status });
      }
      if (opts.exportBytes === undefined) {
        return new Response('no bytes configured', { status: 500 });
      }
      return new Response(opts.exportBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.ipld.car' },
      });
    }

    if (url.includes('/api/v0/block/get?arg=')) {
      counts.blockGetCalls += 1;
      const match = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
      if (!match) return new Response('missing arg', { status: 400 });
      const cid = decodeURIComponent(match[1]!);
      const bytes = opts.blocks?.get(cid);
      if (!bytes) return new Response('miss', { status: 404 });
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }

    if (url.includes('/sidecar/blob') || url.includes('/sidecar/submit')) {
      return new Response('', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    exportCalls: () => counts.exportCalls,
    blockGetCalls: () => counts.blockGetCalls,
  };
}

/** Extract every block from a CAR into a map for the legacy mock. */
async function carToBlockMap(carBytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = await CarReader.fromBytes(carBytes);
  const out = new Map<string, Uint8Array>();
  for await (const block of reader.blocks()) {
    out.set(block.cid.toString(), block.bytes);
  }
  return out;
}

/** Hand-build a CAR whose root is dag-cbor with a single block. */
async function makeMinimalDagCborCar(): Promise<Uint8Array> {
  const { CarWriter } = await import('@ipld/car');
  const payload = { issue: 370, kind: 'minimal-dag-cbor' };
  const bytes = dagCborEncode(payload);
  const cid = CID.createV1(0x71, createDigest(0x12, sha256(bytes)));
  const { writer, out } = CarWriter.create([cid]);
  const collect = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const c of out) chunks.push(c);
    return chunks;
  })();
  await writer.put({ cid, bytes });
  await writer.close();
  const chunks = await collect;
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #370 — fetchCarFromIpfs /dag/export fast path', () => {
  let mock: MockHandle | null = null;

  beforeEach(() => {
    _resetGatewayCapabilityCache();
  });

  afterEach(() => {
    if (mock !== null) {
      mock.restore();
      mock = null;
    }
  });

  it('happy path: single /dag/export call replaces per-block BFS', async () => {
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'fast-1' }, { id: 'fast-2' }] });
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootCid = roots[0]!.toString();
    // Issue #434 — fetchCarFromIpfs now peeks the root block via
    // /block/get BEFORE deciding whether /dag/export is safe (Kubo's
    // server-side IPLD walk only follows Tag 42 CID-links; UXF roots
    // with raw 32-byte child refs would return an incomplete CAR via
    // /dag/export, silently losing children — see issue #434). The
    // peek needs the root bytes to decode and check `isUxfElement`,
    // so the mock must serve the root block on /block/get even on
    // the fast-path test.
    const blocks = await carToBlockMap(carBytes);

    mock = installMock({ probeStatus: 400, exportBytes: carBytes, blocks });
    const out = await fetchCarFromIpfs(['https://gw-fast.test'], rootCid);

    // Issue #434 — exactly one /block/get (the root peek) plus the
    // /dag/export call. The peek replaces the "zero per-block
    // fetches" claim of the original test: we now pay one extra
    // round-trip for the UXF safety check. For non-UXF roots (this
    // fixture's `makeFakeUxfCar` payload is `{ payload: ... }`,
    // which doesn't match the UXF element shape) the fast path
    // proceeds normally after the peek.
    expect(mock.exportCalls()).toBe(1);
    expect(mock.blockGetCalls()).toBe(1);

    // Output is a valid CAR with the same root.
    const outReader = await CarReader.fromBytes(out);
    const outRoots = await outReader.getRoots();
    expect(outRoots[0]!.toString()).toBe(rootCid);

    // Every source block is present.
    const sourceCids = new Set<string>();
    const r2 = await CarReader.fromBytes(carBytes);
    for await (const b of r2.blocks()) sourceCids.add(b.cid.toString());
    const outCids = new Set<string>();
    const r3 = await CarReader.fromBytes(out);
    for await (const b of r3.blocks()) outCids.add(b.cid.toString());
    expect(outCids).toEqual(sourceCids);
  });

  it('falls back to legacy BFS when probe returns 404', async () => {
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'legacy' }] });
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootCid = roots[0]!.toString();
    const blocks = await carToBlockMap(carBytes);

    mock = installMock({ probeStatus: 404, blocks });
    const out = await fetchCarFromIpfs(['https://gw-no-export.test'], rootCid);

    expect(mock.exportCalls()).toBe(0);
    expect(mock.blockGetCalls()).toBeGreaterThan(0);

    const outReader = await CarReader.fromBytes(out);
    const outRoots = await outReader.getRoots();
    expect(outRoots[0]!.toString()).toBe(rootCid);
  });

  it('falls back to legacy BFS when fast-path /dag/export returns 500', async () => {
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'mid-failure' }] });
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootCid = roots[0]!.toString();
    const blocks = await carToBlockMap(carBytes);

    mock = installMock({ probeStatus: 400, exportStatus: 500, blocks });
    const out = await fetchCarFromIpfs(['https://gw-export-500.test'], rootCid);

    expect(mock.exportCalls()).toBe(1);
    expect(mock.blockGetCalls()).toBeGreaterThan(0);
    const outReader = await CarReader.fromBytes(out);
    const outRoots = await outReader.getRoots();
    expect(outRoots[0]!.toString()).toBe(rootCid);
  });

  it('falls back to legacy BFS when /dag/export response omits the requested root', async () => {
    const truthful = await makeFakeUxfCar({ tokens: [{ id: 'truthful' }] });
    const truthfulReader = await CarReader.fromBytes(truthful);
    const truthfulRoots = await truthfulReader.getRoots();
    const truthfulRoot = truthfulRoots[0]!.toString();
    const truthfulBlocks = await carToBlockMap(truthful);

    // Build a different CAR that claims a different root — the gateway
    // returns this in response to a request for the truthful root.
    const phantom = await makeMinimalDagCborCar();

    mock = installMock({ probeStatus: 400, exportBytes: phantom, blocks: truthfulBlocks });
    const out = await fetchCarFromIpfs(
      ['https://gw-wrong-root.test'],
      truthfulRoot,
    );

    expect(mock.exportCalls()).toBe(1);
    expect(mock.blockGetCalls()).toBeGreaterThan(0);
    const outReader = await CarReader.fromBytes(out);
    const outRoots = await outReader.getRoots();
    expect(outRoots[0]!.toString()).toBe(truthfulRoot);
  });

  it('falls back to legacy BFS when /dag/export response contains a CID-binding-violating block', async () => {
    // Use the legitimate CAR's root and structure, but corrupt one block's
    // bytes in the served stream so per-block sha256 check fails. The
    // legacy BFS will then succeed (because its mock serves honest bytes).
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'corrupted' }] });
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootCid = roots[0]!.toString();
    const blocks = await carToBlockMap(carBytes);

    // Build a corrupt CAR by reassembling with one block's bytes mutated.
    const { CarWriter } = await import('@ipld/car');
    const allBlocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
    for await (const b of (await CarReader.fromBytes(carBytes)).blocks()) {
      allBlocks.push({ cid: b.cid, bytes: b.bytes });
    }
    // Corrupt a non-root block. Mutate the last byte of the last block.
    const target = allBlocks[allBlocks.length - 1]!;
    const corrupted = new Uint8Array(target.bytes);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    allBlocks[allBlocks.length - 1] = { cid: target.cid, bytes: corrupted };

    const { writer, out } = CarWriter.create([roots[0]!]);
    const collect = (async () => {
      const chunks: Uint8Array[] = [];
      for await (const c of out) chunks.push(c);
      return chunks;
    })();
    for (const b of allBlocks) await writer.put(b);
    await writer.close();
    const chunks = await collect;
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const corruptCar = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      corruptCar.set(c, offset);
      offset += c.length;
    }

    mock = installMock({ probeStatus: 400, exportBytes: corruptCar, blocks });
    const reassembled = await fetchCarFromIpfs(
      ['https://gw-corrupt.test'],
      rootCid,
    );
    // Fast path attempted then failed CID-binding → fell through to legacy BFS.
    expect(mock.exportCalls()).toBe(1);
    expect(mock.blockGetCalls()).toBeGreaterThan(0);
    const r = await CarReader.fromBytes(reassembled);
    const r2 = await r.getRoots();
    expect(r2[0]!.toString()).toBe(rootCid);
  });

  it('byte-for-byte equivalence: fast-path output and legacy BFS produce identical CAR block sets', async () => {
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'eq-1' }, { id: 'eq-2' }] });
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootCid = roots[0]!.toString();
    const blocks = await carToBlockMap(carBytes);

    // Run 1: fast path.
    mock = installMock({ probeStatus: 400, exportBytes: carBytes, blocks });
    const fastOut = await fetchCarFromIpfs(['https://gw-eq-fast.test'], rootCid);
    mock.restore();
    mock = null;
    _resetGatewayCapabilityCache();

    // Run 2: legacy path (probe miss).
    mock = installMock({ probeStatus: 404, blocks });
    const legacyOut = await fetchCarFromIpfs(['https://gw-eq-legacy.test'], rootCid);

    // Equivalence: same root + same block set. The two paths reassemble
    // the CAR independently (fast-path uses verifyAndReassembleExportedCar,
    // legacy uses the BFS reassembly); CAR-wire bytes may differ in block
    // ordering, but root and block-set MUST match.
    const fastReader = await CarReader.fromBytes(fastOut);
    const legacyReader = await CarReader.fromBytes(legacyOut);
    const fastRoots = await fastReader.getRoots();
    const legacyRoots = await legacyReader.getRoots();
    expect(fastRoots[0]!.toString()).toBe(rootCid);
    expect(legacyRoots[0]!.toString()).toBe(rootCid);

    const fastCids = new Set<string>();
    for await (const b of fastReader.blocks()) fastCids.add(b.cid.toString());
    const legacyCids = new Set<string>();
    for await (const b of legacyReader.blocks()) legacyCids.add(b.cid.toString());
    expect(fastCids).toEqual(legacyCids);
    expect(fastCids.size).toBe(blocks.size);
  });

  it('probe cache: same gateway probed exactly once across multiple fetches', async () => {
    const carBytes = await makeFakeUxfCar({ tokens: [{ id: 'cache' }] });
    const reader = await CarReader.fromBytes(carBytes);
    const roots = await reader.getRoots();
    const rootCid = roots[0]!.toString();

    let probeHits = 0;
    const original = globalThis.fetch;
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
        probeHits += 1;
        return new Response('', { status: 400 });
      }
      if (url.includes('/api/v0/dag/export?')) {
        return new Response(carBytes, {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.ipld.car' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      for (let i = 0; i < 3; i++) {
        await fetchCarFromIpfs(['https://gw-fetch-cache.test'], rootCid);
      }
      // Two endpoints probed (import + export), each exactly once across
      // the three fetches.
      expect(probeHits).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
