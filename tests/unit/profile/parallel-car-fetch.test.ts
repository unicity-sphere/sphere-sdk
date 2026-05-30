/**
 * Issue #360 Finding #5 — parallelize CAR fetching across bundles and
 * within the BFS DAG walk.
 *
 * Coverage:
 *   1. `runWithConcurrency` — output order matches input order.
 *   2. `runWithConcurrency` — concurrency cap respected (cap=2, 10
 *      items → max in-flight = 2).
 *   3. `runWithConcurrency` — 5 parallel items finish well below 5×
 *      unit latency.
 *   4. `fetchCarFromIpfs` BFS — a layered DAG resolves in O(depth) fetch
 *      waves rather than O(total-blocks) sequential awaits, and the
 *      visited-set dedup still fires across the parallel frontier.
 *
 * @module tests/unit/profile/parallel-car-fetch
 */

import { describe, it, expect, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create as createMultihash } from 'multiformats/hashes/digest';
import { encode as dagCborEncode } from '@ipld/dag-cbor';
import { CarReader } from '@ipld/car';

import { runWithConcurrency } from '../../../profile/internal/concurrency.js';
import { fetchCarFromIpfs } from '../../../profile/ipfs-client.js';

const DAG_CBOR_CODE = 0x71;
const SHA256_CODE = 0x12;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function cidFor(bytes: Uint8Array): CID {
  return CID.createV1(DAG_CBOR_CODE, createMultihash(SHA256_CODE, sha256(bytes)));
}

// ---------------------------------------------------------------------------
// Part A — runWithConcurrency unit tests
// ---------------------------------------------------------------------------

describe('runWithConcurrency', () => {
  it('preserves input-index order even when later items finish first', async () => {
    const result = await runWithConcurrency([300, 50, 150], 3, async (delayMs) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return delayMs;
    });
    expect(result).toEqual([300, 50, 150]);
  });

  it('respects the concurrency cap (cap=2, 10 items → max in-flight = 2)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await runWithConcurrency(items, 2, async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    // Cap respected AND exercised — a single-worker run is a regression.
    expect(maxInFlight).toBe(2);
  });

  it('5 parallel items (cap≥5) finish well below 5× unit latency', async () => {
    const unitMs = 50;
    const start = Date.now();
    await runWithConcurrency([0, 1, 2, 3, 4], 8, async () => {
      await new Promise((r) => setTimeout(r, unitMs));
    });
    const elapsed = Date.now() - start;
    // Serial = 5 × 50 = 250 ms; parallel should be ~one unit. 3× headroom
    // keeps this stable on loaded CI.
    expect(elapsed).toBeLessThan(unitMs * 3);
  });
});

// ---------------------------------------------------------------------------
// Part B — fetchCarFromIpfs BFS frontier parallelism
// ---------------------------------------------------------------------------

interface FetchEvent {
  cid: string;
  startedAt: number;
}

/**
 * Install a fetch mock backing Kubo `/api/v0/block/get?arg=<cid>`.
 * Sleeps `unitMs` per request and records (cid, startedAt) so the
 * test can assert layer-parallel wave structure.
 */
function installTimingGateway(
  blocks: Map<string, Uint8Array>,
  unitMs: number,
): FetchEvent[] {
  const events: FetchEvent[] = [];
  const t0 = Date.now();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const m = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    if (!m) return new Response('not-found', { status: 404 });
    const cidStr = decodeURIComponent(m[1]!);
    events.push({ cid: cidStr, startedAt: Date.now() - t0 });
    await new Promise((r) => setTimeout(r, unitMs));
    const bytes = blocks.get(cidStr);
    if (!bytes) return new Response('missing', { status: 404 });
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };
  return events;
}

/**
 * Build a 3-layer DAG: 1 root → 5 parents → 1 shared leaf.
 * With a sequential walk: 7 distinct start times spaced ~unitMs apart.
 * With frontier-parallel walk (cap ≥ 5): 3 waves of 1 + 5 + 1 starts
 * each clustered within the same unit.
 */
function buildLayeredDag(): {
  rootCid: string;
  blocks: Map<string, Uint8Array>;
} {
  const leafBytes = dagCborEncode({ leaf: 'shared' });
  const leafCid = cidFor(leafBytes);

  const parentBlocks: Array<{ bytes: Uint8Array; cid: CID }> = [];
  for (let i = 0; i < 5; i++) {
    const bytes = dagCborEncode({ tag: `parent-${i}`, child: leafCid });
    parentBlocks.push({ bytes, cid: cidFor(bytes) });
  }

  const rootBytes = dagCborEncode({
    children: parentBlocks.map((p) => p.cid),
  });
  const rootCid = cidFor(rootBytes);

  const blocks = new Map<string, Uint8Array>();
  blocks.set(rootCid.toString(), rootBytes);
  for (const p of parentBlocks) blocks.set(p.cid.toString(), p.bytes);
  blocks.set(leafCid.toString(), leafBytes);

  return { rootCid: rootCid.toString(), blocks };
}

describe('fetchCarFromIpfs — BFS frontier parallelism (Issue #360 Finding #5)', () => {
  it('resolves a 3-layer DAG in 3 fetch waves AND dedupes shared sub-blocks', async () => {
    const { rootCid, blocks } = buildLayeredDag();
    const unitMs = 60;
    const events = installTimingGateway(blocks, unitMs);

    const t0 = Date.now();
    const out = await fetchCarFromIpfs(['https://gateway.test'], rootCid);
    const elapsed = Date.now() - t0;

    // Correctness — every source block is present, no extras.
    const reader = await CarReader.fromBytes(out);
    const got = new Set<string>();
    for await (const b of reader.blocks()) got.add(b.cid.toString());
    expect(got).toEqual(new Set(blocks.keys()));

    // Dedup — shared leaf fetched exactly once.
    expect(events).toHaveLength(7);
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.cid, (counts.get(e.cid) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);

    // Wave structure — starts cluster into 3 distinct groups.
    const starts = events.map((e) => e.startedAt).sort((a, b) => a - b);
    const waves: number[][] = [[starts[0]!]];
    for (let i = 1; i < starts.length; i++) {
      if (starts[i]! - starts[i - 1]! > unitMs / 2) waves.push([]);
      waves[waves.length - 1]!.push(starts[i]!);
    }
    expect(waves.length).toBe(3);
    expect(waves[0]).toHaveLength(1);  // root
    expect(waves[1]).toHaveLength(5);  // parents
    expect(waves[2]).toHaveLength(1);  // shared leaf

    // Wall-clock — 3 sequential waves ≪ 7-wave serial walk.
    expect(elapsed).toBeLessThan(unitMs * 5);
    expect(elapsed).toBeGreaterThan(unitMs * 2);
  });
});
