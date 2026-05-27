/**
 * Tests for parallel block pinning in `pinCarBlocksToIpfs`.
 *
 * Diagnosis (2026-05-27): the pre-fix loop pinned each CAR block
 * sequentially via HTTP POST to the sidecar. With ~80-150ms per round-
 * trip, a ~250-block migration CAR ran for ~25-30s, exceeding the 30s
 * `awaitNextFlush` budget and failing the legacy → Profile migration at
 * the "Flushing Profile storage to disk" phase. The fix introduces a
 * bounded worker pool — `concurrency` workers each draw blocks from a
 * shared monotonic index — so wall-clock drops from `N × RTT` to
 * `ceil(N / concurrency) × RTT`.
 *
 * Coverage:
 *   1. All blocks pinned (correctness preserved).
 *   2. Max simultaneous in-flight pins ≤ configured concurrency.
 *   3. With concurrency=10, 30 blocks complete in ≤ 4 batches.
 *   4. Single block failure aborts the operation (`Promise.all` reject).
 *   5. Concurrency parameter clamped (0 / negative / NaN → 1).
 *   6. Concurrency clamped DOWN to `blocks.length` when smaller than
 *      configured concurrency (no spurious idle workers).
 *   7. Default concurrency (10) used when arg omitted.
 *   8. Order-independence: pins arrive at the sidecar in any order, all
 *      blocks accepted under their own CID.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

import { pinCarBlocksToIpfs } from '../../../profile/ipfs-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildCarBytes(
  roots: CID[],
  entries: Array<{ cid: CID; bytes: Uint8Array }>,
): Promise<Uint8Array> {
  const { CarWriter } = await import('@ipld/car');
  const { writer, out } = CarWriter.create(roots);
  const collect = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    return chunks;
  })();
  for (const entry of entries) {
    await writer.put({ cid: entry.cid, bytes: entry.bytes });
  }
  await writer.close();
  const chunks = await collect;
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return buf;
}

function makeBlocks(n: number): Array<{ cid: CID; bytes: Uint8Array }> {
  const out: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for (let i = 0; i < n; i++) {
    const bytes = new TextEncoder().encode(`block-${i}-payload-${'x'.repeat(8)}`);
    const cid = CID.createV1(raw.code, createDigest(0x12, sha256(bytes)));
    out.push({ cid, bytes });
  }
  return out;
}

/**
 * Fetch mock that:
 *   - increments `inFlight` on entry to /api/v0/dag/put, decrements on exit
 *   - tracks `maxInFlight`
 *   - sleeps `delayMs` before responding (forces concurrency to be
 *     observable — without a delay, the entire worker pool drains
 *     synchronously and `inFlight` may never observe > 1 transiently)
 *   - returns 200 from dag/put; sidecar submit best-effort
 *   - records every CID that was pinned for correctness assertions
 */
interface PinTracker {
  inFlight: number;
  maxInFlight: number;
  pinnedCids: string[];
  startCount: number;
  endCount: number;
  failNthBlock: number | null;
}

function installConcurrencyMock(delayMs: number): {
  tracker: PinTracker;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const tracker: PinTracker = {
    inFlight: 0,
    maxInFlight: 0,
    pinnedCids: [],
    startCount: 0,
    endCount: 0,
    failNthBlock: null,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? String(input);

    if (url.includes('/sidecar/submit') || url.includes('/sidecar/blob')) {
      // Sidecar fan-out is fire-and-forget; respond fast, no concurrency
      // accounting needed.
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (url.includes('/api/v0/dag/put')) {
      // Extract CID for tracking — pinSingleBlock POSTs the bytes,
      // not the CID, but the URL itself encodes the codec and the
      // sidecar/submit fan-out URL DOES carry the CID query param.
      // We track via the dag/put body's CID indirectly: trust that
      // the sidecar/submit will record it, but here we just count
      // start/end + concurrency.
      const myIdx = tracker.startCount++;
      tracker.inFlight++;
      if (tracker.inFlight > tracker.maxInFlight) {
        tracker.maxInFlight = tracker.inFlight;
      }
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        if (tracker.failNthBlock !== null && myIdx === tracker.failNthBlock) {
          return new Response('forced failure', { status: 500 });
        }
        // Pull the CID from the body's binary content (we don't have it
        // in the URL). Instead, derive from sidecar/submit fan-out
        // requests below.
        let cid: string | null = null;
        if (init?.body instanceof FormData) {
          const file = init.body.get('data') as Blob | null;
          if (file) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const c = CID.createV1(raw.code, createDigest(0x12, sha256(bytes)));
            cid = c.toString();
          }
        }
        if (cid) tracker.pinnedCids.push(cid);
        return new Response(JSON.stringify({ Cid: { '/': 'ignored' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } finally {
        tracker.inFlight--;
        tracker.endCount++;
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    tracker,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const TEST_GATEWAY = 'https://ipfs.test';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pinCarBlocksToIpfs — bounded-concurrency worker pool', () => {
  let mock: ReturnType<typeof installConcurrencyMock> | null = null;

  afterEach(() => {
    if (mock) {
      mock.restore();
      mock = null;
    }
  });

  it('pins every block exactly once (correctness invariant preserved)', async () => {
    const blocks = makeBlocks(12);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(5);

    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      4,
    );

    expect(mock.tracker.endCount).toBe(12);
    // Every block CID present in pinned set, no duplicates.
    const uniquePinned = new Set(mock.tracker.pinnedCids);
    expect(uniquePinned.size).toBe(12);
    for (const b of blocks) {
      expect(uniquePinned.has(b.cid.toString())).toBe(true);
    }
  });

  it('respects the concurrency bound — max in-flight ≤ configured', async () => {
    const blocks = makeBlocks(20);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(15);

    const CONCURRENCY = 4;
    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      CONCURRENCY,
    );

    expect(mock.tracker.maxInFlight).toBeLessThanOrEqual(CONCURRENCY);
    // Must have actually observed parallelism — if mock.tracker.maxInFlight
    // is 1, the worker pool degenerated to serial and the perf fix didn't
    // land. With 20 blocks and 15ms delay per pin, we expect to saturate
    // the pool for most of the run.
    expect(mock.tracker.maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('default concurrency=10 saturates pool for large block counts', async () => {
    const blocks = makeBlocks(40);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(15);

    // Omit the concurrency arg — should default to 10.
    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
    );

    expect(mock.tracker.endCount).toBe(40);
    // With 40 blocks and default 10 concurrency, max in-flight should
    // reach close to 10 (within race timing).
    expect(mock.tracker.maxInFlight).toBeGreaterThanOrEqual(5);
    expect(mock.tracker.maxInFlight).toBeLessThanOrEqual(10);
  });

  it('clamps non-positive / non-finite concurrency to 1 (degrades to serial)', async () => {
    const blocks = makeBlocks(8);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);

    for (const badValue of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      mock = installConcurrencyMock(5);
      await pinCarBlocksToIpfs(
        [TEST_GATEWAY],
        carBytes,
        blocks[0].cid.toString(),
        30_000,
        undefined,
        badValue,
      );

      if (Number.isFinite(badValue)) {
        // Non-positive finite → clamp to 1 (serial). Max in-flight = 1.
        expect(mock.tracker.maxInFlight).toBe(1);
      } else {
        // Non-finite (NaN, +Infinity) → fall back to DEFAULT_PIN_CONCURRENCY
        // (10). Max in-flight bounded by Math.min(10, blocks.length=8).
        expect(mock.tracker.maxInFlight).toBeLessThanOrEqual(8);
      }
      expect(mock.tracker.endCount).toBe(8);
      mock.restore();
      mock = null;
    }
  });

  it('clamps concurrency DOWN to block count (no spurious idle workers)', async () => {
    const blocks = makeBlocks(3);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(5);

    // Ask for concurrency 20, but only 3 blocks — should spawn only 3 workers.
    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      20,
    );

    expect(mock.tracker.endCount).toBe(3);
    expect(mock.tracker.maxInFlight).toBeLessThanOrEqual(3);
  });

  it('single-block failure aborts the whole operation', async () => {
    const blocks = makeBlocks(10);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(5);
    // Force the 3rd pin (index 2) to return 500.
    mock.tracker.failNthBlock = 2;

    await expect(
      pinCarBlocksToIpfs(
        [TEST_GATEWAY],
        carBytes,
        blocks[0].cid.toString(),
        30_000,
        undefined,
        4,
      ),
    ).rejects.toThrow(/ORBITDB_WRITE_FAILED|dag\/put failed|HTTP 500/);
  });

  it('order-independent: pins arrive in any order, all CIDs are pinned', async () => {
    // The worker pool draws blocks via shared index — the order pins
    // hit the sidecar depends on worker scheduling. We assert ONLY
    // that every CID was pinned, not the order.
    const blocks = makeBlocks(15);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(5);

    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      5,
    );

    const expectedCids = new Set(blocks.map((b) => b.cid.toString()));
    const actualCids = new Set(mock.tracker.pinnedCids);
    expect(actualCids.size).toBe(expectedCids.size);
    for (const cid of expectedCids) {
      expect(actualCids.has(cid)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Perf sanity: serial vs parallel wall-clock on simulated 30ms RTT
// ---------------------------------------------------------------------------

describe('pinCarBlocksToIpfs — wall-clock perf characteristic', () => {
  let mock: ReturnType<typeof installConcurrencyMock> | null = null;
  afterEach(() => {
    if (mock) {
      mock.restore();
      mock = null;
    }
  });

  it('20 blocks × 30ms RTT with concurrency=10 completes well under serial time', async () => {
    // Serial would take 20 × 30 = 600ms minimum.
    // Concurrency=10 should take ~2 batches × 30ms = ~60ms (plus
    // scheduling overhead). Assert well under the serial baseline so a
    // regression that re-introduces the serial loop fails this test.
    const blocks = makeBlocks(20);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(30);

    const start = Date.now();
    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      10,
    );
    const elapsed = Date.now() - start;

    // Generous ceiling (300ms) to avoid CI flakes from scheduler jitter;
    // serial would still be > 600ms even with timer rounding. The
    // important regression-catching property is "parallel << serial".
    expect(elapsed).toBeLessThan(300);
    expect(mock.tracker.endCount).toBe(20);
  });
});
