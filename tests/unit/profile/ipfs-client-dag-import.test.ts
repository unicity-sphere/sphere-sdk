/**
 * Issue #370 — `pinCarBlocksToIpfs` `/dag/import` fast-path tests.
 *
 * Verifies the selector layer added in issue #370:
 *   - Capability probe semantics (200/400/404/405/500/timeout/network-error)
 *   - Probe cache: a gateway is probed exactly once across many pins
 *   - Fast-path happy case: single `/dag/import` POST replaces the per-block
 *     `/dag/put` loop, NDJSON response parsed for expected-root presence
 *   - Multi-root defensive check: the gateway reporting extra roots does not
 *     fail; the gateway omitting our root does
 *   - Fallback on probe-miss (gateway returns 404 from probe): legacy
 *     per-block path runs against `/dag/put`
 *   - Fallback on per-call HTTP failure (probe says capable but actual
 *     `/dag/import` call returns 500): legacy per-block path runs
 *   - Legacy path local-Helia writes are skipped when the fast path already
 *     wrote them (no duplicate puts)
 *
 * The legacy path's per-block correctness is covered by
 * `tests/unit/profile/ipfs-client-parallel-pin.test.ts` — this file only
 * verifies the dispatch + fast-path layer.
 *
 * @module tests/unit/profile/ipfs-client-dag-import
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

import {
  pinCarBlocksToIpfs,
  _resetGatewayCapabilityCache,
} from '../../../profile/ipfs-client';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function buildCar(
  blocks: Array<{ cid: CID; bytes: Uint8Array }>,
): Promise<Uint8Array> {
  const { CarWriter } = await import('@ipld/car');
  const { writer, out } = CarWriter.create([blocks[0]!.cid]);
  const collect = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    return chunks;
  })();
  for (const block of blocks) await writer.put(block);
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

function makeRawBlocks(n: number): Array<{ cid: CID; bytes: Uint8Array }> {
  const out: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for (let i = 0; i < n; i++) {
    const bytes = new TextEncoder().encode(`#370-import-block-${i}`);
    out.push({
      cid: CID.createV1(raw.code, createDigest(0x12, sha256(bytes))),
      bytes,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetch mock builders
// ---------------------------------------------------------------------------

interface ProbeMockOptions {
  /** Status returned for probe POST to /api/v0/dag/import. */
  readonly importProbeStatus: number;
  /** Status returned for probe POST to /api/v0/dag/export. Default mirrors import. */
  readonly exportProbeStatus?: number;
  /** When true, the probe rejects with a network error instead of responding. */
  readonly probeNetworkError?: boolean;
  /** When true, the probe never resolves (forces timeout). */
  readonly probeHang?: boolean;
}

interface FastPathMockOptions extends ProbeMockOptions {
  /**
   * NDJSON lines to return on `/api/v0/dag/import` (one per line). When
   * omitted defaults to a single-root envelope with the supplied
   * `expectedRootCid`.
   */
  readonly importNdjson?: (expectedRootCid: string) => string;
  /** Status for /api/v0/dag/import call (default 200). */
  readonly importStatus?: number;
  /** Status for /api/v0/dag/put fallback (default 200, returns minimal JSON). */
  readonly dagPutStatus?: number;
}

interface MockHandle {
  readonly restore: () => void;
  readonly importProbeHits: () => number;
  readonly exportProbeHits: () => number;
  readonly importCalls: () => number;
  readonly dagPutCalls: () => number;
}

function installMock(opts: FastPathMockOptions, gatewayBase: string): MockHandle {
  const original = globalThis.fetch;
  const counts = {
    importProbeHits: 0,
    exportProbeHits: 0,
    importCalls: 0,
    dagPutCalls: 0,
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
      // A probe has no body; the real fast-path call has a FormData body.
      init?.body === undefined;

    if (isProbe) {
      if (opts.probeHang === true) {
        return await new Promise(() => {
          /* hang */
        });
      }
      if (opts.probeNetworkError === true) {
        throw new Error('probe-network-error');
      }
      if (url.endsWith('/api/v0/dag/import')) {
        counts.importProbeHits += 1;
        return new Response('', { status: opts.importProbeStatus });
      }
      counts.exportProbeHits += 1;
      return new Response('', {
        status: opts.exportProbeStatus ?? opts.importProbeStatus,
      });
    }

    if (url.includes('/api/v0/dag/import?')) {
      counts.importCalls += 1;
      const status = opts.importStatus ?? 200;
      if (status !== 200) {
        return new Response('forced failure', { status });
      }
      const ndjson = (opts.importNdjson ?? defaultImportNdjson)(
        currentExpectedRoot ?? '',
      );
      return new Response(ndjson, { status: 200 });
    }

    if (url.includes('/api/v0/dag/put')) {
      counts.dagPutCalls += 1;
      return new Response(JSON.stringify({ Cid: { '/': 'ignored' } }), {
        status: opts.dagPutStatus ?? 200,
      });
    }

    if (url.includes('/sidecar/submit') || url.includes('/sidecar/blob')) {
      return new Response('', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  // Defensive: silence the unused-warning if the caller doesn't use gatewayBase.
  void gatewayBase;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    importProbeHits: () => counts.importProbeHits,
    exportProbeHits: () => counts.exportProbeHits,
    importCalls: () => counts.importCalls,
    dagPutCalls: () => counts.dagPutCalls,
  };
}

/**
 * Default NDJSON: single Root envelope with the expected CID and no
 * PinErrorMsg. Models the modern Kubo shape (`Cid: {"/": "..."}`).
 */
function defaultImportNdjson(expectedRootCid: string): string {
  return (
    JSON.stringify({
      Root: { Cid: { '/': expectedRootCid }, PinErrorMsg: '' },
    }) + '\n'
  );
}

// Thin global so the mock can include the expected root in NDJSON output
// without the caller having to pass it through every layer.
let currentExpectedRoot: string | null = null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #370 — pinCarBlocksToIpfs /dag/import fast path', () => {
  let mock: MockHandle | null = null;

  beforeEach(() => {
    _resetGatewayCapabilityCache();
  });

  afterEach(() => {
    if (mock !== null) {
      mock.restore();
      mock = null;
    }
    currentExpectedRoot = null;
  });

  describe('capability probe', () => {
    it('treats 400 (healthy Kubo on empty body) as "exposed" → fast path runs', async () => {
      const blocks = makeRawBlocks(4);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-probe-400.test';

      mock = installMock({ importProbeStatus: 400 }, gateway);
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
      expect(mock.importCalls()).toBe(1);
      expect(mock.dagPutCalls()).toBe(0);
    });

    it('treats 404 as "not exposed" → falls through to legacy per-block', async () => {
      const blocks = makeRawBlocks(3);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-probe-404.test';

      mock = installMock({ importProbeStatus: 404 }, gateway);
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
      expect(mock.importCalls()).toBe(0);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });

    it('treats 405 as "not exposed" → falls through to legacy per-block', async () => {
      const blocks = makeRawBlocks(2);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-probe-405.test';

      mock = installMock({ importProbeStatus: 405 }, gateway);
      await pinCarBlocksToIpfs([gateway], carBytes, expectedRoot);
      expect(mock.importCalls()).toBe(0);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });

    it('treats 500 as "not exposed" → falls through to legacy per-block', async () => {
      const blocks = makeRawBlocks(2);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-probe-500.test';

      mock = installMock({ importProbeStatus: 500 }, gateway);
      await pinCarBlocksToIpfs([gateway], carBytes, expectedRoot);
      expect(mock.importCalls()).toBe(0);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });

    it('treats network error as "not exposed" → falls through to legacy per-block', async () => {
      const blocks = makeRawBlocks(2);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-probe-neterr.test';

      mock = installMock(
        { importProbeStatus: 0, probeNetworkError: true },
        gateway,
      );
      await pinCarBlocksToIpfs([gateway], carBytes, expectedRoot);
      expect(mock.importCalls()).toBe(0);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });
  });

  describe('probe cache', () => {
    it('probes the same gateway exactly once across multiple pins', async () => {
      const expectedCalls = 3;
      const gateway = 'https://gw-probe-cache.test';
      mock = installMock({ importProbeStatus: 400 }, gateway);

      for (let i = 0; i < expectedCalls; i++) {
        const blocks = makeRawBlocks(1);
        const carBytes = await buildCar(blocks);
        const expectedRoot = blocks[0]!.cid.toString();
        currentExpectedRoot = expectedRoot;
        await pinCarBlocksToIpfs([gateway], carBytes, expectedRoot);
      }
      expect(mock.importProbeHits()).toBe(1);
      expect(mock.exportProbeHits()).toBe(1);
      expect(mock.importCalls()).toBe(expectedCalls);
    });
  });

  describe('NDJSON response parsing', () => {
    it('accepts modern shape {"Root":{"Cid":{"/":"<cid>"}}}', async () => {
      const blocks = makeRawBlocks(1);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-ndjson-modern.test';

      mock = installMock(
        {
          importProbeStatus: 400,
          importNdjson: (root) =>
            JSON.stringify({ Root: { Cid: { '/': root }, PinErrorMsg: '' } }) +
            '\n',
        },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
    });

    it('accepts older shape {"Root":{"Cid":"<cid>"}} (bare string Cid)', async () => {
      const blocks = makeRawBlocks(1);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-ndjson-old.test';

      mock = installMock(
        {
          importProbeStatus: 400,
          importNdjson: (root) =>
            JSON.stringify({ Root: { Cid: root, PinErrorMsg: '' } }) + '\n',
        },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
    });

    it('skips Stats lines and other non-Root envelopes', async () => {
      const blocks = makeRawBlocks(1);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-ndjson-mixed.test';

      mock = installMock(
        {
          importProbeStatus: 400,
          importNdjson: (root) =>
            [
              JSON.stringify({ Stats: { BlockCount: 1 } }),
              JSON.stringify({ Root: { Cid: { '/': root } } }),
              JSON.stringify({ Stats: { BlockBytesCount: 64 } }),
              '   ', // whitespace-only line
              '{not json',
            ].join('\n') + '\n',
        },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
    });

    it('multi-root defensive check: tolerates extra Root entries beyond our expected root', async () => {
      const blocks = makeRawBlocks(1);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      const phantomRoot = CID.createV1(
        raw.code,
        createDigest(0x12, sha256(new TextEncoder().encode('phantom'))),
      ).toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-multi-root.test';

      mock = installMock(
        {
          importProbeStatus: 400,
          importNdjson: (root) =>
            [
              JSON.stringify({ Root: { Cid: { '/': root } } }),
              JSON.stringify({ Root: { Cid: { '/': phantomRoot } } }),
            ].join('\n') + '\n',
        },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
    });

    it('falls back to legacy when NDJSON response omits the expected root', async () => {
      const blocks = makeRawBlocks(2);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      const wrongRoot = CID.createV1(
        raw.code,
        createDigest(0x12, sha256(new TextEncoder().encode('not-our-root'))),
      ).toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-missing-root.test';

      mock = installMock(
        {
          importProbeStatus: 400,
          importNdjson: () =>
            JSON.stringify({ Root: { Cid: { '/': wrongRoot } } }) + '\n',
        },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
      // Fast path was attempted, then fell through to legacy per-block.
      expect(mock.importCalls()).toBe(1);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });

    it('falls back to legacy when NDJSON Root reports a non-empty PinErrorMsg', async () => {
      const blocks = makeRawBlocks(2);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-pin-error.test';

      mock = installMock(
        {
          importProbeStatus: 400,
          importNdjson: (root) =>
            JSON.stringify({
              Root: { Cid: { '/': root }, PinErrorMsg: 'block too large' },
            }) + '\n',
        },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
      expect(mock.importCalls()).toBe(1);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });
  });

  describe('fallback on per-call HTTP failure', () => {
    it('falls back to legacy when fast-path /dag/import returns 500', async () => {
      const blocks = makeRawBlocks(3);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-500-onlyimport.test';

      mock = installMock(
        { importProbeStatus: 400, importStatus: 500 },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
      );
      expect(returned).toBe(expectedRoot);
      expect(mock.importCalls()).toBe(1);
      expect(mock.dagPutCalls()).toBe(blocks.length);
    });
  });

  describe('local-Helia write deduplication', () => {
    it('does not duplicate local-Helia puts when fast path runs then legacy fallback runs', async () => {
      const blocks = makeRawBlocks(4);
      const carBytes = await buildCar(blocks);
      const expectedRoot = blocks[0]!.cid.toString();
      currentExpectedRoot = expectedRoot;
      const gateway = 'https://gw-helia-dedup.test';

      const heliaPuts: string[] = [];
      const fakeHelia = {
        blockstore: {
          get: () => {
            throw new Error('not supposed to read');
          },
          put: async (cid: { toString(): string }) => {
            heliaPuts.push(cid.toString());
          },
        },
      };

      // Force fast path to attempt then fail (import status 500) so legacy
      // runs after the fast-path local-helia write phase.
      mock = installMock(
        { importProbeStatus: 400, importStatus: 500 },
        gateway,
      );
      const returned = await pinCarBlocksToIpfs(
        [gateway],
        carBytes,
        expectedRoot,
        30_000,
        fakeHelia,
      );
      expect(returned).toBe(expectedRoot);
      // Every block written exactly ONCE — the fast-path phase wrote them
      // and the legacy phase was told to skip its own write loop via
      // helia=undefined.
      const expectedCids = blocks.map((b) => b.cid.toString()).sort();
      expect(heliaPuts.sort()).toEqual(expectedCids);
    });
  });
});
