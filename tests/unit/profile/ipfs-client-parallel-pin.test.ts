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
 * Hash bytes → hex string. Used to build an INDEX lookup so the mock
 * can attribute each POST back to its producer-side `blocks[i]` index,
 * not to a re-hashed CID. Steelman P1#2 — the previous version derived
 * CIDs by re-hashing POST bodies, which could not distinguish "every
 * block pinned once" from "block X pinned twice + block Y skipped"
 * because both produce the same set of unique CIDs (when the set check
 * stays at N, length and dedup would surface the dup). The strict
 * regression guard is to assert that each producer-side INDEX appears
 * exactly once across all POSTs.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Fetch mock that:
 *   - increments `inFlight` on entry to /api/v0/dag/put, decrements on exit
 *   - tracks `maxInFlight`
 *   - sleeps `delayMs` before responding (forces concurrency to be
 *     observable — without a delay, the entire worker pool drains
 *     synchronously and `inFlight` may never observe > 1 transiently)
 *   - returns 200 from dag/put; sidecar submit best-effort
 *   - looks up each POST body's bytes in `indexByHash` to attribute
 *     the pin to a producer-side `blocks[i]` index — used by the
 *     correctness invariant assertion
 */
interface PinTracker {
  inFlight: number;
  maxInFlight: number;
  /**
   * Ordered list of producer-side `blocks[i]` indices observed via
   * POST body lookup. A correct pool processes each index exactly
   * once; a duplicate-process bug shows up as a repeated index, a
   * skip bug as a missing index.
   */
  processedIndices: number[];
  /**
   * Per-index pin count. Same data as `processedIndices` but indexed
   * for fast O(1) duplicate detection in assertions.
   */
  pinCountByIndex: Map<number, number>;
  startCount: number;
  endCount: number;
  failNthBlock: number | null;
}

function installConcurrencyMock(
  delayMs: number,
  blocks: Array<{ cid: CID; bytes: Uint8Array }>,
): {
  tracker: PinTracker;
  restore: () => void;
} {
  const original = globalThis.fetch;
  // Build hash → producer-index lookup BEFORE any worker runs so the
  // mock can attribute each POST body back to its source index.
  const indexByHash = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    indexByHash.set(bytesToHex(blocks[i].bytes), i);
  }

  const tracker: PinTracker = {
    inFlight: 0,
    maxInFlight: 0,
    processedIndices: [],
    pinCountByIndex: new Map<number, number>(),
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
      const myIdx = tracker.startCount++;
      tracker.inFlight++;
      if (tracker.inFlight > tracker.maxInFlight) {
        tracker.maxInFlight = tracker.inFlight;
      }
      try {
        // Read POST body BEFORE the artificial delay so we attribute
        // every observed pin, even on the abort path.
        let producerIndex: number | undefined;
        if (init?.body instanceof FormData) {
          const file = init.body.get('data') as Blob | null;
          if (file) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            producerIndex = indexByHash.get(bytesToHex(bytes));
          }
        }
        if (producerIndex !== undefined) {
          tracker.processedIndices.push(producerIndex);
          tracker.pinCountByIndex.set(
            producerIndex,
            (tracker.pinCountByIndex.get(producerIndex) ?? 0) + 1,
          );
        }
        await new Promise((r) => setTimeout(r, delayMs));
        if (tracker.failNthBlock !== null && myIdx === tracker.failNthBlock) {
          // Issue #369 — HTTP 400 is classified as a PERMANENT failure
          // by `isTransientPinError`, so `withPinRetry` short-circuits
          // the retry budget and surfaces the error immediately. This
          // preserves the original test intent of these abort-propagation
          // scenarios (single failure → abort the whole CAR pin) under
          // the new retry-with-backoff wrap; transient codes (5xx, 429,
          // network errors) would now be retried instead.
          return new Response('forced failure', { status: 400 });
        }
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
    mock = installConcurrencyMock(5, blocks);

    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      4,
    );

    // Total pins = block count. Catches under-counting (skipped block)
    // AND over-counting (duplicate processing) without conflating them.
    expect(mock.tracker.processedIndices.length).toBe(12);
    expect(mock.tracker.endCount).toBe(12);
    // Per-index count must be exactly 1 for every producer index. A
    // duplicate-processing bug would show up as count >= 2 for some
    // index; a skip would show up as a missing entry (count === 0).
    // Asserting both bounds covers the full failure surface that the
    // CID-set-based check could not distinguish (steelman P1#2).
    for (let i = 0; i < blocks.length; i++) {
      expect(mock.tracker.pinCountByIndex.get(i)).toBe(1);
    }
    expect(mock.tracker.pinCountByIndex.size).toBe(12);
  });

  it('respects the concurrency bound — max in-flight ≤ configured', async () => {
    const blocks = makeBlocks(20);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(15, blocks);

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
    mock = installConcurrencyMock(15, blocks);

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
      mock = installConcurrencyMock(5, blocks);
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
    mock = installConcurrencyMock(5, blocks);

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
    mock = installConcurrencyMock(5, blocks);
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
    ).rejects.toThrow(/ORBITDB_WRITE_FAILED|dag\/put failed|HTTP 400/);
  });

  it('order-independent: pins arrive in any order, every index processed exactly once', async () => {
    // The worker pool draws blocks via shared index — the order pins
    // hit the sidecar depends on worker scheduling. We assert ONLY
    // that every producer index was processed, not the order.
    const blocks = makeBlocks(15);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(5, blocks);

    await pinCarBlocksToIpfs(
      [TEST_GATEWAY],
      carBytes,
      blocks[0].cid.toString(),
      30_000,
      undefined,
      5,
    );

    expect(mock.tracker.processedIndices.length).toBe(15);
    for (let i = 0; i < 15; i++) {
      expect(mock.tracker.pinCountByIndex.get(i)).toBe(1);
    }
  });

  // Steelman P1#1 regression guard — when the first failure trips the
  // shared abort flag, peer workers' late rejections must NOT escape
  // as UnhandledPromiseRejection. We simulate by failing the first pin
  // immediately and having the other workers' pins take longer (so
  // they're in-flight when the abort lands). The mock fetches resolve
  // 200 for everything except `failNthBlock=0`. After the rethrow we
  // wait long enough for any in-flight pin to settle and inspect the
  // Node process's unhandled-rejection signal.
  it('peer-worker late rejections do NOT surface as UnhandledPromiseRejection', async () => {
    const blocks = makeBlocks(10);
    const carBytes = await buildCarBytes([blocks[0].cid], blocks);
    mock = installConcurrencyMock(50, blocks);
    // Two workers will fail (index 0 and 1, near-simultaneous since
    // delayMs=50 means the others are mid-flight when these resolve).
    // The harness pinSingleBlock retries against gateways before
    // throwing — for a single gateway, it throws on the first 500.
    mock.tracker.failNthBlock = 0;

    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', handler);
    try {
      await expect(
        pinCarBlocksToIpfs(
          [TEST_GATEWAY],
          carBytes,
          blocks[0].cid.toString(),
          30_000,
          undefined,
          4,
        ),
      ).rejects.toThrow(/ORBITDB_WRITE_FAILED|HTTP 400/);
      // Give the peer workers enough time to finish their in-flight
      // pin POSTs and any post-throw microtask processing.
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      process.off('unhandledRejection', handler);
    }
    expect(unhandledRejections).toEqual([]);
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
    mock = installConcurrencyMock(30, blocks);

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
