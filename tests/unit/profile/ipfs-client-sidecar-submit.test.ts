/**
 * Tests for the instant-pin sidecar submit hook in `profile/ipfs-client.ts`.
 *
 * Issue #255 Problem B / ipfs-storage#7: after every successful pin via
 * `/api/v0/dag/put`, `pinToIpfs` (and `pinSingleBlock` via `pinCarBlocksToIpfs`)
 * fire-and-forget POST the same bytes to the gateway's `/sidecar/submit`
 * endpoint. This populates the sidecar's instant-pin cache so cross-device
 * readers can fetch the CID immediately, before Kubo's bitswap registration
 * window closes.
 *
 * The hook is BEST-EFFORT:
 *   - Errors never propagate to the caller.
 *   - Sidecar absence (gateway 404s the POST) is silently dropped.
 *   - The primary pin's success contract is invariant under sidecar failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

import { pinToIpfs, pinCarBlocksToIpfs, fetchFromIpfs } from '../../../extensions/uxf/profile/ipfs-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cidForBytes(bytes: Uint8Array): string {
  return CID.createV1(raw.code, createDigest(0x12, sha256(bytes))).toString();
}

interface RecordedFetch {
  readonly url: string;
  readonly method: string;
  readonly body: Uint8Array | null;
  readonly headers: Record<string, string>;
}

/**
 * Install a fetch mock that records every call and routes by URL pattern:
 *   - `/api/v0/dag/put`         → returns 200 + JSON CID envelope (primary pin succeeds)
 *   - `/api/v0/block/get`       → routes to `blockGetHandler` if supplied
 *   - `/sidecar/submit?cid=...` → routes to `sidecarSubmitHandler`
 *   - `/sidecar/blob?cid=...`   → routes to `sidecarBlobHandler` if supplied
 *
 * Returns the recording array (populated as fetches happen) plus a restore
 * function.
 */
function installFetchMock(opts: {
  pinHandler?: (req: RecordedFetch) => Promise<Response> | Response;
  sidecarHandler: (req: RecordedFetch) => Promise<Response> | Response;
  blockGetHandler?: (req: RecordedFetch) => Promise<Response> | Response;
  sidecarBlobHandler?: (req: RecordedFetch) => Promise<Response> | Response;
}): {
  recorded: RecordedFetch[];
  restore: () => void;
} {
  const recorded: RecordedFetch[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string }).url ?? String(input);
    let body: Uint8Array | null = null;
    if (init?.body instanceof Uint8Array) {
      body = init.body;
    } else if (init?.body instanceof Blob) {
      body = new Uint8Array(await init.body.arrayBuffer());
    } else if (init?.body instanceof FormData) {
      // Crude: pull out the first field as Uint8Array. The pin path uses
      // FormData with a single 'data' field that wraps Blob(Uint8Array).
      const file = init.body.get('data') as Blob | null;
      body = file ? new Uint8Array(await file.arrayBuffer()) : null;
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }
    const req: RecordedFetch = {
      url,
      method: init?.method ?? 'GET',
      body,
      headers,
    };
    recorded.push(req);

    if (url.includes('/sidecar/submit')) {
      return opts.sidecarHandler(req);
    }
    if (url.includes('/sidecar/blob')) {
      if (opts.sidecarBlobHandler) return opts.sidecarBlobHandler(req);
      return new Response('not in sidecar cache', { status: 404 });
    }
    if (url.includes('/api/v0/dag/put')) {
      if (opts.pinHandler) return opts.pinHandler(req);
      // Default: succeed with a JSON envelope.
      return new Response(JSON.stringify({ Cid: { '/': 'ignored-by-caller' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/v0/block/get')) {
      if (opts.blockGetHandler) return opts.blockGetHandler(req);
      return new Response('not found', { status: 404 });
    }
    throw new Error(`fetch mock got unexpected URL: ${url}`);
  }) as typeof globalThis.fetch;

  return { recorded, restore: () => { globalThis.fetch = originalFetch; } };
}

// Wait for next tick so detached fire-and-forget promises have a chance
// to register their handlers (the test thread can otherwise race ahead
// of the `void fetch(...).then(...).catch(...)` chain).
async function waitForDetachedFetch(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const TEST_GATEWAY = 'https://ipfs.test';
const SAMPLE_BYTES = new TextEncoder().encode('hello sidecar — test payload');

// ---------------------------------------------------------------------------
// pinToIpfs sidecar submit
// ---------------------------------------------------------------------------

describe('pinToIpfs → /sidecar/submit fire-and-forget', () => {
  let mock: ReturnType<typeof installFetchMock>;

  afterEach(() => {
    if (mock) mock.restore();
  });

  it('POSTs the same bytes to /sidecar/submit after a successful pin', async () => {
    mock = installFetchMock({
      sidecarHandler: () => new Response(
        JSON.stringify({ ok: true, outcome: 'accepted' }),
        { status: 200 },
      ),
    });

    const cid = await pinToIpfs([TEST_GATEWAY], SAMPLE_BYTES);
    expect(cid).toBe(cidForBytes(SAMPLE_BYTES));

    await waitForDetachedFetch();

    const sidecarCalls = mock.recorded.filter((r) => r.url.includes('/sidecar/submit'));
    expect(sidecarCalls).toHaveLength(1);
    const submit = sidecarCalls[0];
    expect(submit.method).toBe('POST');
    expect(submit.url).toBe(`${TEST_GATEWAY}/sidecar/submit?cid=${encodeURIComponent(cid)}`);
    expect(submit.headers['content-type']).toBe('application/octet-stream');
    expect(submit.body).not.toBeNull();
    expect(Array.from(submit.body!)).toEqual(Array.from(SAMPLE_BYTES));
  });

  it('does NOT block pinToIpfs on a slow / failed sidecar response', async () => {
    let sidecarCalled = false;
    mock = installFetchMock({
      sidecarHandler: () => {
        sidecarCalled = true;
        // Simulate a 5xx — the hook must swallow without rethrowing.
        return new Response('sidecar is down', { status: 500 });
      },
    });

    const cid = await pinToIpfs([TEST_GATEWAY], SAMPLE_BYTES);
    expect(cid).toBe(cidForBytes(SAMPLE_BYTES));

    await waitForDetachedFetch();
    expect(sidecarCalled).toBe(true);
  });

  it('does NOT block pinToIpfs when sidecar fetch throws (gateway without sidecar)', async () => {
    let sidecarCalled = false;
    mock = installFetchMock({
      sidecarHandler: () => {
        sidecarCalled = true;
        // Simulate a network-level error — the hook's `.catch` MUST absorb it.
        throw new TypeError('Failed to fetch: ENOTFOUND');
      },
    });

    // pinToIpfs MUST resolve normally; no unhandled rejection should escape.
    const cid = await pinToIpfs([TEST_GATEWAY], SAMPLE_BYTES);
    expect(cid).toBe(cidForBytes(SAMPLE_BYTES));

    await waitForDetachedFetch();
    expect(sidecarCalled).toBe(true);
  });

  it('skips sidecar submit on empty data (defense-in-depth — pin would also reject)', async () => {
    let sidecarCalled = false;
    // Pin handler still has to respond, but the test asserts on whether
    // SIDECAR was called.
    mock = installFetchMock({
      pinHandler: () => new Response(
        JSON.stringify({ Cid: { '/': 'ignored' } }),
        { status: 200 },
      ),
      sidecarHandler: () => {
        sidecarCalled = true;
        return new Response('', { status: 200 });
      },
    });

    await pinToIpfs([TEST_GATEWAY], new Uint8Array(0));
    await waitForDetachedFetch();
    expect(sidecarCalled).toBe(false);
  });

  it('skips sidecar submit on > 32 MiB body', async () => {
    let sidecarCalled = false;
    const oversize = new Uint8Array(33 * 1024 * 1024);  // 33 MiB
    mock = installFetchMock({
      sidecarHandler: () => {
        sidecarCalled = true;
        return new Response('', { status: 200 });
      },
    });

    const cid = await pinToIpfs([TEST_GATEWAY], oversize);
    expect(cid).toBe(cidForBytes(oversize));
    await waitForDetachedFetch();
    expect(sidecarCalled).toBe(false);
  });

  it('uses the SAME gateway that won the pin race (not the first in the list)', async () => {
    // First gateway 5xx on pin, second succeeds. Sidecar must hit the second.
    const gw1 = 'https://gw1.test';
    const gw2 = 'https://gw2.test';
    mock = installFetchMock({
      pinHandler: (req) => {
        if (req.url.startsWith(gw1)) {
          return new Response('boom', { status: 503 });
        }
        return new Response(
          JSON.stringify({ Cid: { '/': 'ignored' } }),
          { status: 200 },
        );
      },
      sidecarHandler: () => new Response('', { status: 200 }),
    });

    await pinToIpfs([gw1, gw2], SAMPLE_BYTES);
    await waitForDetachedFetch();

    const sidecarCalls = mock.recorded.filter((r) => r.url.includes('/sidecar/submit'));
    expect(sidecarCalls).toHaveLength(1);
    expect(sidecarCalls[0].url.startsWith(gw2)).toBe(true);
    expect(sidecarCalls[0].url.startsWith(gw1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pinCarBlocksToIpfs → pinSingleBlock sidecar submit (per-block fan-out)
// ---------------------------------------------------------------------------

describe('pinCarBlocksToIpfs → /sidecar/submit fan-out (per block)', () => {
  let mock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    // Reset between tests.
  });

  afterEach(() => {
    if (mock) mock.restore();
  });

  /**
   * @ipld/car's `CarWriter.create()` returns a `{ writer, out }` pair where
   * `out` is an async iterator that MUST be consumed concurrently with
   * the writes (the iterator's internal buffer blocks `writer.put()` once
   * full). Serial put-then-iterate deadlocks. This helper does the
   * standard concurrent pattern.
   */
  async function buildCarBytes(
    roots: CID[],
    entries: Array<{ cid: CID; bytes: Uint8Array }>,
  ): Promise<Uint8Array> {
    const { CarWriter } = await import('@ipld/car');
    const { writer, out } = CarWriter.create(roots);
    // Start the consumer BEFORE the writes so the iterator drains as
    // they happen.
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
    const out2 = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out2.set(c, offset); offset += c.length; }
    return out2;
  }

  it('submits each block to the sidecar after pinning, preserving the (cid, bytes) pair', async () => {
    const bytesA = new TextEncoder().encode('block-A payload');
    const bytesB = new TextEncoder().encode('block-B payload — distinct');
    const cidA = CID.createV1(raw.code, createDigest(0x12, sha256(bytesA)));
    const cidB = CID.createV1(raw.code, createDigest(0x12, sha256(bytesB)));

    const carBytes = await buildCarBytes(
      [cidA],
      [{ cid: cidA, bytes: bytesA }, { cid: cidB, bytes: bytesB }],
    );

    mock = installFetchMock({
      sidecarHandler: () => new Response(
        JSON.stringify({ ok: true, outcome: 'accepted' }),
        { status: 200 },
      ),
    });

    await pinCarBlocksToIpfs([TEST_GATEWAY], carBytes, cidA.toString());
    await waitForDetachedFetch();

    const sidecarCalls = mock.recorded.filter((r) => r.url.includes('/sidecar/submit'));
    // One submit per block (2 blocks in our CAR).
    expect(sidecarCalls.length).toBe(2);

    // Verify each submit's CID + body alignment.
    const submitForCid = (cidStr: string) =>
      sidecarCalls.find((c) => c.url.includes(encodeURIComponent(cidStr)));
    const submitA = submitForCid(cidA.toString());
    const submitB = submitForCid(cidB.toString());
    expect(submitA).toBeDefined();
    expect(submitB).toBeDefined();
    expect(Array.from(submitA!.body!)).toEqual(Array.from(bytesA));
    expect(Array.from(submitB!.body!)).toEqual(Array.from(bytesB));
  });

  it('does NOT fail the pin when sidecar throws on every block', async () => {
    const bytes = new TextEncoder().encode('block-X');
    const cid = CID.createV1(raw.code, createDigest(0x12, sha256(bytes)));
    const carBytes = await buildCarBytes([cid], [{ cid, bytes }]);

    mock = installFetchMock({
      sidecarHandler: () => { throw new TypeError('ENOTFOUND'); },
    });

    // Must resolve cleanly even though every sidecar submit blows up.
    await expect(
      pinCarBlocksToIpfs([TEST_GATEWAY], carBytes, cid.toString()),
    ).resolves.toBe(cid.toString());
  });
});

// ---------------------------------------------------------------------------
// fetchFromIpfs read fast-path via /sidecar/blob
// ---------------------------------------------------------------------------

describe('fetchFromIpfs → /sidecar/blob read fast-path', () => {
  let mock: ReturnType<typeof installFetchMock>;

  afterEach(() => {
    if (mock) mock.restore();
  });

  it('returns sidecar bytes on a 200 hit and SKIPS the /api/v0/block/get call', async () => {
    const bytes = new TextEncoder().encode('fresh-from-sibling');
    const cid = cidForBytes(bytes);
    let blockGetCalled = false;

    mock = installFetchMock({
      sidecarHandler: () => new Response('', { status: 200 }),
      sidecarBlobHandler: () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
      blockGetHandler: () => {
        blockGetCalled = true;
        return new Response('should not be called', { status: 200 });
      },
    });

    const result = await fetchFromIpfs([TEST_GATEWAY], cid, 1000);
    expect(Array.from(result)).toEqual(Array.from(bytes));
    expect(blockGetCalled).toBe(false);

    // Confirm the sidecar blob was queried.
    const blobCalls = mock.recorded.filter((r) => r.url.includes('/sidecar/blob'));
    expect(blobCalls.length).toBe(1);
    expect(blobCalls[0].url).toBe(`${TEST_GATEWAY}/sidecar/blob?cid=${encodeURIComponent(cid)}`);
  });

  it('falls through to /api/v0/block/get on sidecar 404 (cache miss)', async () => {
    const bytes = new TextEncoder().encode('fallback-path');
    const cid = cidForBytes(bytes);

    mock = installFetchMock({
      sidecarHandler: () => new Response('', { status: 200 }),
      sidecarBlobHandler: () => new Response('not in cache', { status: 404 }),
      blockGetHandler: () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    });

    const result = await fetchFromIpfs([TEST_GATEWAY], cid, 1000);
    expect(Array.from(result)).toEqual(Array.from(bytes));

    // BOTH paths exercised: sidecar tried first, fallback ran.
    expect(mock.recorded.some((r) => r.url.includes('/sidecar/blob'))).toBe(true);
    expect(mock.recorded.some((r) => r.url.includes('/api/v0/block/get'))).toBe(true);
  });

  it('falls through to /api/v0/block/get when sidecar throws (gateway without sidecar)', async () => {
    const bytes = new TextEncoder().encode('throw-fallback');
    const cid = cidForBytes(bytes);

    mock = installFetchMock({
      sidecarHandler: () => new Response('', { status: 200 }),
      sidecarBlobHandler: () => { throw new TypeError('ENOTFOUND'); },
      blockGetHandler: () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    });

    const result = await fetchFromIpfs([TEST_GATEWAY], cid, 1000);
    expect(Array.from(result)).toEqual(Array.from(bytes));
  });

  it('falls through on CID-mismatch from sidecar (defends against rogue cache serving wrong bytes)', async () => {
    const goodBytes = new TextEncoder().encode('legit-bytes');
    const cid = cidForBytes(goodBytes);
    const evilBytes = new TextEncoder().encode('evil-bytes-from-sidecar');

    mock = installFetchMock({
      sidecarHandler: () => new Response('', { status: 200 }),
      sidecarBlobHandler: () => new Response(evilBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
      blockGetHandler: () => new Response(goodBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    });

    // Sidecar served wrong bytes → CID verify fails on sidecar path
    // → fall through to /api/v0/block/get → succeed with correct bytes.
    const result = await fetchFromIpfs([TEST_GATEWAY], cid, 1000);
    expect(Array.from(result)).toEqual(Array.from(goodBytes));
  });

  it('falls through when sidecar returns HTML (no-sidecar gateway catch-all)', async () => {
    const bytes = new TextEncoder().encode('catch-all-fallback');
    const cid = cidForBytes(bytes);

    mock = installFetchMock({
      sidecarHandler: () => new Response('', { status: 200 }),
      // Gateway has no sidecar; returns a 200 HTML "endpoint not found"
      // page from a catch-all. Caller MUST treat this as a miss, not
      // as bytes-with-wrong-CID.
      sidecarBlobHandler: () => new Response('<html>nope</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
      blockGetHandler: () => new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    });

    const result = await fetchFromIpfs([TEST_GATEWAY], cid, 1000);
    expect(Array.from(result)).toEqual(Array.from(bytes));
  });
});
