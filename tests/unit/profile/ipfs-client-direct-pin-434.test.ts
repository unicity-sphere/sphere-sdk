/**
 * Issue #434 regression — `pinCarBlocksToIpfs` direct-pins every CAR
 * block after the fast-path `/dag/import` succeeds.
 *
 * # Why this test exists
 *
 * Kubo's `/api/v0/dag/import?pin-roots=true` (used by PR #370's fast
 * path since May 31, 2026) recursively pins the CAR roots and follows
 * dag-cbor Tag 42 CID-links. For UXF bundle CARs, children are encoded
 * as raw 32-byte Uint8Array (PR #213 Option C) — NOT as Tag 42. Kubo's
 * recursive pin doesn't recognize raw-byte refs as CID-links and so
 * the children remain UNPINNED in the gateway blockstore, vulnerable
 * to GC / LRU eviction.
 *
 * The receiver later walks the bundle DAG with the UXF-aware walker
 * (`walkUxfElement` in `ipfs-client.ts`) and issues `block/get` per
 * child. If any child has been evicted, the fetch fails and the
 * cross-device recovery surfaces as `BUNDLE_NOT_FOUND` → 0 tokens
 * recovered. This is the exact regression issue #434 documents.
 *
 * The fix issues `/api/v0/pin/add?arg=<cid>&recursive=false` per non-
 * root block immediately after `/dag/import` returns success. The
 * direct pin retains every block at the gateway regardless of
 * whether the parent's recursive walk reaches it.
 *
 * # What this test asserts
 *
 *  1. A `/dag/import?pin-roots=true` is issued exactly once.
 *  2. For every non-root block in the CAR, an `/api/v0/pin/add` with
 *     `recursive=false` is issued.
 *  3. The root CID is NOT direct-pinned (already pinned recursively).
 *  4. A 4xx/5xx on `/pin/add` does NOT abort the pin — the function
 *     still returns success because the `/dag/import` already landed
 *     the bytes.
 *  5. Failures on `/pin/add` are logged but never thrown.
 *
 * # Verification protocol
 *
 * The "FIX (post-#434)" assertions MUST fail if the direct-pin loop
 * is removed from `pinCarBlocksToIpfs`. Specifically, the
 * `expectedDirectPinCidSet` size assertion and the recursive=false
 * query-param check are the load-bearing signals.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CarWriter } from '@ipld/car/writer';
import { encode as dagCborEncode } from '@ipld/dag-cbor';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create as createDigest } from 'multiformats/hashes/digest';

import {
  pinCarBlocksToIpfs,
  _setGatewayCapabilityForTest,
  _resetGatewayCapabilityCache,
} from '../../../profile/ipfs-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAG_CBOR_CODE = 0x71;
const TEST_GATEWAY = 'https://ipfs.test';

interface RecordedFetch {
  readonly url: string;
  readonly method: string;
}

/** Install a fetch mock that handles every URL the fast path touches. */
function installFetchMock(opts: {
  /** Optional override — returns the Response for `/api/v0/pin/add`. */
  pinAddHandler?: (req: RecordedFetch) => Response;
  /** The expected root CID — used to synthesize a valid /dag/import NDJSON response. */
  expectedRootCid: string;
}): { recorded: RecordedFetch[]; restore: () => void } {
  const recorded: RecordedFetch[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? String(input);
    const method = init?.method ?? 'GET';
    recorded.push({ url, method });

    // /dag/import — primary fast-path endpoint. Kubo returns NDJSON
    // with one JSON object per imported root; `pinCarViaImport` parses
    // it looking for the expected root in `node.Root.Cid`.
    if (url.includes('/api/v0/dag/import')) {
      const ndjson =
        JSON.stringify({ Root: { Cid: { '/': opts.expectedRootCid } } }) + '\n';
      return new Response(ndjson, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // /pin/add — the issue #434 direct-pin loop.
    if (url.includes('/api/v0/pin/add')) {
      if (opts.pinAddHandler) return opts.pinAddHandler({ url, method });
      return new Response(JSON.stringify({ Pins: [url] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // /sidecar/submit — fire-and-forget.
    if (url.includes('/sidecar/submit')) {
      return new Response('', { status: 200 });
    }

    // /sidecar/blob — read fast-path (not exercised by pin path).
    if (url.includes('/sidecar/blob')) {
      return new Response('', { status: 404 });
    }

    throw new Error(`fetch mock got unexpected URL: ${url}`);
  }) as typeof globalThis.fetch;

  return { recorded, restore: () => { globalThis.fetch = originalFetch; } };
}

/** Build a CAR with `numBlocks` dag-cbor blocks rooted at the first. */
async function buildTestCar(numBlocks: number): Promise<{
  carBytes: Uint8Array;
  rootCid: string;
  childCids: string[];
}> {
  // Build N dag-cbor blocks; the first is the "root". Children have
  // arbitrary payloads — what matters is that the CID is dag-cbor so
  // the fast-path's `parseCarForFastPathPin` accepts the CAR and the
  // post-import direct-pin loop iterates all blocks.
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for (let i = 0; i < numBlocks; i++) {
    const bytes = dagCborEncode({ index: i, payload: `block-${i}` });
    const digest = createDigest(0x12, nobleSha256(bytes));
    const cid = CID.createV1(DAG_CBOR_CODE, digest);
    blocks.push({ cid, bytes });
  }
  const rootCid = blocks[0].cid;

  // Stream the CAR via CarWriter.
  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const block of blocks) {
    await writer.put(block);
  }
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
    childCids: blocks.slice(1).map((b) => b.cid.toString()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #434 — pinCarBlocksToIpfs direct-pins children after /dag/import', () => {
  beforeEach(() => {
    _resetGatewayCapabilityCache();
    // Force the fast path: probe says /dag/import is available.
    _setGatewayCapabilityForTest(TEST_GATEWAY, {
      dagImport: true,
      dagExport: true,
    });
  });

  afterEach(() => {
    _resetGatewayCapabilityCache();
  });

  it('FIX (post-#434): issues /pin/add?recursive=false for every non-root block', async () => {
    const { carBytes, rootCid, childCids } = await buildTestCar(4);
    expect(childCids.length).toBe(3);

    const { recorded, restore } = installFetchMock({ expectedRootCid: rootCid });
    try {
      const result = await pinCarBlocksToIpfs(
        [TEST_GATEWAY],
        carBytes,
        rootCid,
      );
      expect(result).toBe(rootCid);
    } finally {
      restore();
    }

    // Exactly one /dag/import call.
    const importCalls = recorded.filter((r) =>
      r.url.includes('/api/v0/dag/import'),
    );
    expect(importCalls.length).toBe(1);

    // One /pin/add per CHILD block, with recursive=false. Root is NOT
    // direct-pinned (already pinned recursively by /dag/import).
    const pinAddCalls = recorded.filter((r) =>
      r.url.includes('/api/v0/pin/add'),
    );
    const directPinnedCids = new Set<string>();
    for (const call of pinAddCalls) {
      expect(call.url).toContain('recursive=false');
      const argMatch = /[?&]arg=([^&]+)/.exec(call.url);
      expect(argMatch).not.toBeNull();
      directPinnedCids.add(decodeURIComponent(argMatch![1]));
    }
    expect(directPinnedCids.size).toBe(childCids.length);
    // Every child CID must have been direct-pinned.
    for (const childCid of childCids) {
      expect(directPinnedCids.has(childCid)).toBe(true);
    }
    // Root MUST NOT be direct-pinned (already covered by /dag/import).
    expect(directPinnedCids.has(rootCid)).toBe(false);
  });

  it('FIX (post-#434): single-block CAR issues NO /pin/add calls (root only, already pinned by /dag/import)', async () => {
    // Single-block CAR — the root has no children. /pin/add loop skips
    // the root (already pinned recursively) and there are no other
    // blocks to pin. Net result: zero /pin/add HTTP calls.
    const { carBytes, rootCid, childCids } = await buildTestCar(1);
    expect(childCids.length).toBe(0);

    const { recorded, restore } = installFetchMock({ expectedRootCid: rootCid });
    try {
      await pinCarBlocksToIpfs([TEST_GATEWAY], carBytes, rootCid);
    } finally {
      restore();
    }

    const pinAddCalls = recorded.filter((r) =>
      r.url.includes('/api/v0/pin/add'),
    );
    expect(pinAddCalls.length).toBe(0);
  });

  it('FIX (post-#434): /pin/add failure does NOT abort the overall pin (best-effort)', async () => {
    const { carBytes, rootCid, childCids } = await buildTestCar(3);
    expect(childCids.length).toBe(2);

    const { recorded, restore } = installFetchMock({
      expectedRootCid: rootCid,
      pinAddHandler: () =>
        new Response('temporary unavailable', { status: 503 }),
    });
    try {
      // Must NOT throw — the /dag/import has already succeeded so the
      // CAR is materially on the gateway. A /pin/add failure on a
      // single child is logged + swallowed.
      const result = await pinCarBlocksToIpfs(
        [TEST_GATEWAY],
        carBytes,
        rootCid,
      );
      expect(result).toBe(rootCid);
    } finally {
      restore();
    }

    // Both children were attempted (the helper does NOT short-circuit
    // on a single failure — best-effort means every block gets a try).
    const pinAddCalls = recorded.filter((r) =>
      r.url.includes('/api/v0/pin/add'),
    );
    expect(pinAddCalls.length).toBe(childCids.length);
  });

  it('FIX (post-#434): /pin/add network error does NOT abort the overall pin', async () => {
    const { carBytes, rootCid, childCids } = await buildTestCar(2);
    expect(childCids.length).toBe(1);

    const { restore } = installFetchMock({
      expectedRootCid: rootCid,
      pinAddHandler: () => {
        throw new Error('ECONNRESET — simulated network blip');
      },
    });
    try {
      const result = await pinCarBlocksToIpfs(
        [TEST_GATEWAY],
        carBytes,
        rootCid,
      );
      expect(result).toBe(rootCid);
    } finally {
      restore();
    }
  });

  it('preserves /dag/import call before /pin/add (import must succeed first)', async () => {
    const { carBytes, rootCid } = await buildTestCar(3);

    const { recorded, restore } = installFetchMock({ expectedRootCid: rootCid });
    try {
      await pinCarBlocksToIpfs([TEST_GATEWAY], carBytes, rootCid);
    } finally {
      restore();
    }

    // /dag/import must come BEFORE the first /pin/add — the direct-pin
    // loop relies on the import having landed the bytes in the gateway
    // blockstore.
    const importIdx = recorded.findIndex((r) =>
      r.url.includes('/api/v0/dag/import'),
    );
    const firstPinAddIdx = recorded.findIndex((r) =>
      r.url.includes('/api/v0/pin/add'),
    );
    expect(importIdx).toBeGreaterThanOrEqual(0);
    expect(firstPinAddIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeLessThan(firstPinAddIdx);
  });
});
