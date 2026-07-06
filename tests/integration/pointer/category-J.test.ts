/**
 * Category-J integration tests for CAR-integrity fetch paths (SPEC §8.5, §10.7).
 *
 * These tests wire the real `buildCarFetcher` from profile/pointer-wiring.ts
 * against `fetchCarFromGateway` (profile/aggregator-pointer/ipfs-car-fetch.ts)
 * through a mocked `globalThis.fetch`. The boundary under test is the
 * CAR-integrity contract:
 *
 *   - Bytes on the wire MUST hash to the caller-supplied CID (via CarReader
 *     root-CID extraction — CARs are DAG containers, not raw blobs, so
 *     `sha256(body) == cidMultihash` does NOT apply; SPEC §8.2 step 3).
 *   - Content-mismatch is a SEMANTICALLY_INVALID signal per SPEC, and the
 *     fetcher MUST NOT retry other gateways on this outcome (hostile-cache /
 *     attacker signal).
 *   - Malformed CARs, zero-roots CARs → `car_parse_failed`.
 *   - HTTP Range resume splices partial bytes correctly across a mid-stream
 *     stall; if a Range request is sent but the server returns 200 (ignored),
 *     the previously-accumulated prefix MUST be discarded to avoid
 *     duplicate-prefix corruption (D6 streaming byte-cap).
 *   - Content-Encoding on a CAR fetch is a protocol violation (§8.5 D6) and
 *     MUST be mapped to `car_parse_failed` without retrying other gateways.
 *   - `CAR_FETCH_TOTAL_BUDGET_MS` (60s) bounds the aggregate time across all
 *     configured gateways so a misconfigured operator with N stalling
 *     endpoints cannot block the hot path for N × per-gateway timeout.
 *
 * Coverage (J1–J8):
 *
 *   J1  CAR header root CID matches requested cidBytes → ok
 *   J2  CAR header root CID does NOT match → content_mismatch, NO retry to
 *       subsequent gateways (attacker-signal discipline)
 *   J3  Malformed CAR bytes (not a valid CAR container) → car_parse_failed
 *   J4  CAR has zero roots → car_parse_failed
 *   J5  HTTP Range resume splices correctly on mid-stream stall (D6 streaming
 *       byte-cap honoured across splice)
 *   J6  Range-not-supported server returns 200 instead of 206 → discard
 *       partial prefix and use full body (no duplicate-prefix corruption)
 *   J7  Content-Encoding header rejected (§8.5 D6), mapped to car_parse_failed
 *       and NO retry to other gateways (deterministic protocol violation)
 *   J8  Total budget (CAR_FETCH_TOTAL_BUDGET_MS = 60s) exceeded →
 *       transient_unavailable without hanging
 *
 * Fixtures are hand-crafted CARs built with `@ipld/car` so we can control
 * root-CID identity. Responses are `Response` + `ReadableStream` so we can
 * simulate chunked streams, stalls, and Range-aware servers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createDigest } from 'multiformats/hashes/digest';
import { CarWriter } from '@ipld/car/writer';

import { __internal } from '../../../extensions/uxf/profile/pointer-wiring.js';

// ─── Fixture helpers ───────────────────────────────────────────────────────

/** Build a CIDv1(raw, sha2-256) from arbitrary bytes. */
function buildCid(bytes: Uint8Array): CID {
  const hash = sha256(bytes);
  return CID.createV1(raw.code, createDigest(0x12, hash));
}

/**
 * Hand-craft a minimal valid CARv1 with a given root CID and one block whose
 * CID matches the root. The block bytes are the raw-codec payload.
 */
async function buildValidCar(rootPayload: Uint8Array): Promise<{ bytes: Uint8Array; rootCid: CID }> {
  const rootCid = buildCid(rootPayload);
  const { writer, out } = CarWriter.create([rootCid]);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  await writer.put({ cid: rootCid, bytes: rootPayload });
  await writer.close();
  await collect;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const concat = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    concat.set(c, off);
    off += c.byteLength;
  }
  return { bytes: concat, rootCid };
}

/**
 * Hand-craft a CARv1 with zero roots. The CAR header encodes `{ version: 1,
 * roots: [] }`. We build it manually (CarWriter rejects empty-roots input)
 * using the dag-cbor/varint prefix format.
 *
 * Format (CARv1 §2):
 *   [varint header-length] [dag-cbor { roots: [], version: 1 }]
 *   [varint block-length]  [cid-bytes | block-bytes]...
 *
 * For zero-roots we only need the header — no blocks.
 */
async function buildZeroRootsCar(): Promise<Uint8Array> {
  const { encode: dagCborEncode } = await import('@ipld/dag-cbor');
  const header = dagCborEncode({ roots: [], version: 1 });
  // varint for header length
  const varint = encodeVarint(header.byteLength);
  const bytes = new Uint8Array(varint.byteLength + header.byteLength);
  bytes.set(varint, 0);
  bytes.set(header, varint.byteLength);
  return bytes;
}

/** Encode an unsigned varint (LEB128). */
function encodeVarint(n: number): Uint8Array {
  const out: number[] = [];
  let x = n;
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x & 0x7f);
  return new Uint8Array(out);
}

// ─── Response builders ─────────────────────────────────────────────────────

/**
 * A one-shot streaming Response that enqueues all chunks then closes.
 * Useful for happy-path CAR delivery.
 */
function makeFullResponse(
  bytes: Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

/**
 * A streaming Response that emits `prefix` bytes, then STALLS until the
 * caller's AbortSignal fires (at which point we error the stream, which
 * is how a real fetch body reacts when fetch() is aborted mid-stream).
 *
 * `fetchCarFromGateway` passes its AbortController.signal to `fetch()`,
 * but since we MOCK fetch, the signal never propagates to the body stream
 * automatically — we must wire it up by hand. When the stall-timer inside
 * fetchCarFromGateway fires, it calls `controller.abort()` on its own
 * AbortController; we listen to that signal and, when it fires, cancel
 * our body stream with a synthetic error. That error surfaces to the
 * fetcher's `reader.read()` as a thrown rejection, and the `catch` branch
 * there checks `abortState.reason === 'stall'` (true, because the timer
 * was what flipped the signal) — so the fetcher enters the Range-resume
 * branch.
 *
 * The returned response advertises `Accept-Ranges: bytes` by default so
 * the fetcher attempts a Range-based splice on stall.
 */
function makeStallingResponse(
  prefix: Uint8Array,
  signal: AbortSignal,
  headers: Record<string, string> = { 'Accept-Ranges': 'bytes' },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      // Mirror fetch()'s native behavior: when signal fires, the body
      // stream errors with an AbortError so the reader sees a thrown
      // rejection on its pending `read()` promise.
      const onAbort = (): void => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    },
  });
  return new Response(stream, { status: 200, headers });
}

// ─── Test suite ────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Pointer Category-J integration — CAR-integrity + D6 streaming byte-cap', () => {
  // ── J1 ───────────────────────────────────────────────────────────────────
  describe('J1 — CAR root CID matches requested cidBytes', () => {
    it('returns { ok: true } when the CAR root CID byte-equals cidBytes', async () => {
      const payload = new TextEncoder().encode('J1-payload');
      const { bytes: carBytes, rootCid } = await buildValidCar(payload);

      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        // Guard against hitting the network if URL construction drifts.
        expect(String(url)).toContain(rootCid.toString());
        return makeFullResponse(carBytes, {
          headers: { 'Content-Length': String(carBytes.byteLength) },
        });
      }) as never;

      const fetcher = __internal.buildCarFetcher(['https://gw1.example']);
      const result = await fetcher(rootCid.bytes);
      expect(result.ok).toBe(true);
    });
  });

  // ── J2 ───────────────────────────────────────────────────────────────────
  describe('J2 — CAR root CID does NOT match → content_mismatch, no retry', () => {
    it('returns content_mismatch and does NOT attempt subsequent gateways', async () => {
      // Two distinct CIDs: the one we ASK for (never actually in any CAR),
      // and the root CID the (hostile) gateway happens to serve.
      const askedPayload = new TextEncoder().encode('J2-requested');
      const servedPayload = new TextEncoder().encode('J2-served-wrong');
      const { bytes: servedCarBytes } = await buildValidCar(servedPayload);
      const askedCid = buildCid(askedPayload);

      const fetchSpy = vi.fn(async () =>
        makeFullResponse(servedCarBytes, {
          headers: { 'Content-Length': String(servedCarBytes.byteLength) },
        }),
      );
      globalThis.fetch = fetchSpy as never;

      const fetcher = __internal.buildCarFetcher([
        'https://gw1.example',
        'https://gw2.example',
        'https://gw3.example',
      ]);
      const result = await fetcher(askedCid.bytes);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('content_mismatch');
      }
      // CRITICAL invariant: only ONE gateway was consulted. A
      // content-mismatch on a CID-addressed resource is authoritative — the
      // second gateway cannot "fix" it because the CID IS the identity.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── J3 ───────────────────────────────────────────────────────────────────
  describe('J3 — Malformed CAR bytes → car_parse_failed', () => {
    it('returns car_parse_failed when the body is not a valid CAR container', async () => {
      // Purely random bytes — no varint prefix, no dag-cbor header.
      const garbage = new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xca, 0xfe, 0xba, 0xbe,
        0x00, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef,
      ]);
      // We still need SOMETHING for cidBytes — use a real CID (the
      // requested CID is irrelevant once CAR parsing fails).
      const cid = buildCid(new TextEncoder().encode('J3'));

      const fetchSpy = vi.fn(async () =>
        makeFullResponse(garbage, {
          headers: { 'Content-Length': String(garbage.byteLength) },
        }),
      );
      globalThis.fetch = fetchSpy as never;

      const fetcher = __internal.buildCarFetcher([
        'https://gw1.example',
        'https://gw2.example',
      ]);
      const result = await fetcher(cid.bytes);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('car_parse_failed');
      }
      // Parse-failed is ALSO authoritative — the bytes arrived, they just
      // aren't a CAR. No point asking another gateway for the same CID.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── J4 ───────────────────────────────────────────────────────────────────
  describe('J4 — CAR has zero roots → car_parse_failed', () => {
    it('returns car_parse_failed when the CAR header has an empty roots array', async () => {
      const carBytes = await buildZeroRootsCar();
      const cid = buildCid(new TextEncoder().encode('J4'));

      const fetchSpy = vi.fn(async () =>
        makeFullResponse(carBytes, {
          headers: { 'Content-Length': String(carBytes.byteLength) },
        }),
      );
      globalThis.fetch = fetchSpy as never;

      const fetcher = __internal.buildCarFetcher([
        'https://gw1.example',
        'https://gw2.example',
      ]);
      const result = await fetcher(cid.bytes);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('car_parse_failed');
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── J5 ───────────────────────────────────────────────────────────────────
  describe('J5 — HTTP Range resume splices correctly on mid-stream stall', () => {
    it('splits a valid CAR across two attempts, splices via Range, verifies root CID', async () => {
      const payload = new TextEncoder().encode('J5-payload-abc-123');
      const { bytes: carBytes, rootCid } = await buildValidCar(payload);

      // Split the CAR at ~40% of its length so both halves contain
      // non-trivial material. The splice must produce bytes IDENTICAL
      // to the original CAR — otherwise CarReader.getRoots will fail
      // or return the wrong root.
      const splitAt = Math.floor(carBytes.byteLength * 0.4);
      expect(splitAt).toBeGreaterThan(0);
      expect(splitAt).toBeLessThan(carBytes.byteLength);
      const firstHalf = carBytes.slice(0, splitAt);
      const secondHalf = carBytes.slice(splitAt);

      // Use fake timers so the 30s stall timer advances deterministically
      // without blocking the test on real wall-clock time.
      vi.useFakeTimers({ shouldAdvanceTime: false });

      let callCount = 0;
      globalThis.fetch = vi.fn(async (_url, init) => {
        callCount += 1;
        const reqInit = init as RequestInit | undefined;
        const headers = (reqInit?.headers ?? {}) as Record<string, string>;
        const rangeHeader = headers['Range'];
        const signal = reqInit?.signal;

        if (callCount === 1) {
          // First call: no Range header; serve the first half, then stall
          // until our caller's AbortController signals abort.
          expect(rangeHeader).toBeUndefined();
          expect(signal).toBeDefined();
          return makeStallingResponse(firstHalf, signal as AbortSignal, {
            'Accept-Ranges': 'bytes',
          });
        }
        // Second call: MUST carry Range: bytes=<splitAt>-. Serve the
        // remaining half with 206 Partial Content.
        expect(rangeHeader).toBe(`bytes=${splitAt}-`);
        return makeFullResponse(secondHalf, {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(secondHalf.byteLength),
            'Content-Range': `bytes ${splitAt}-${
              carBytes.byteLength - 1
            }/${carBytes.byteLength}`,
          },
        });
      }) as never;

      const fetcher = __internal.buildCarFetcher(['https://gw1.example']);
      const promise = fetcher(rootCid.bytes);

      // Let async microtasks settle so the initial fetch() resolves and
      // the reader begins draining. A small real-time yield is sufficient
      // — vitest's fake timers do not pause microtask processing.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Advance past the stall timer (default MAX_CAR_FETCH_STALL_MS = 30s).
      // The timer callback fires, aborts the controller, which we wired
      // into our stream via makeStallingResponse — the reader.read() then
      // rejects, and fetchCarFromGateway enters the Range-resume branch.
      await vi.advanceTimersByTimeAsync(31_000);

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(callCount).toBe(2);
    }, 20_000);
  });

  // ── J6 ───────────────────────────────────────────────────────────────────
  describe('J6 — Range-not-supported server returns 200 instead of 206', () => {
    it('discards partial prefix and uses the full body when server ignores Range', async () => {
      const payload = new TextEncoder().encode('J6-payload-full-xyz');
      const { bytes: carBytes, rootCid } = await buildValidCar(payload);

      const splitAt = Math.floor(carBytes.byteLength * 0.3);
      const firstHalf = carBytes.slice(0, splitAt);

      vi.useFakeTimers({ shouldAdvanceTime: false });

      let callCount = 0;
      globalThis.fetch = vi.fn(async (_url, init) => {
        callCount += 1;
        const reqInit = init as RequestInit | undefined;
        const headers = (reqInit?.headers ?? {}) as Record<string, string>;
        const rangeHeader = headers['Range'];
        const signal = reqInit?.signal;

        if (callCount === 1) {
          // Serve partial prefix then stall until signal aborts.
          expect(rangeHeader).toBeUndefined();
          return makeStallingResponse(firstHalf, signal as AbortSignal, {
            'Accept-Ranges': 'bytes',
          });
        }
        // Second call: carries Range header, but we ignore it and return
        // the full body with status 200 (as a broken gateway would).
        expect(rangeHeader).toBe(`bytes=${splitAt}-`);
        // Content-Range absent; status 200 signals "Range ignored".
        return makeFullResponse(carBytes, {
          status: 200,
          headers: {
            'Content-Length': String(carBytes.byteLength),
          },
        });
      }) as never;

      const fetcher = __internal.buildCarFetcher(['https://gw1.example']);
      const promise = fetcher(rootCid.bytes);

      // Settle microtasks, then fire the stall timer.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31_000);

      const result = await promise;

      // If partial prefix weren't discarded, we'd concat firstHalf +
      // full-body and CAR parsing would fail (→ car_parse_failed) OR
      // the root-CID check would mismatch (→ content_mismatch). The
      // fact that we reach ok: true proves the rangeIgnored branch in
      // fetchCarFromGateway is firing.
      expect(result.ok).toBe(true);
      expect(callCount).toBe(2);
    }, 20_000);
  });

  // ── J7 ───────────────────────────────────────────────────────────────────
  describe('J7 — Content-Encoding rejected (§8.5 D6)', () => {
    it('maps Content-Encoding: gzip to car_parse_failed and does NOT retry', async () => {
      // The fetchCarFromGateway layer returns `content_encoding_rejected`;
      // buildCarFetcher re-maps that to `car_parse_failed` per §8.5 D6 and
      // does NOT retry the next gateway.
      const bogusPayload = new TextEncoder().encode('J7');
      const { bytes: carBytes } = await buildValidCar(bogusPayload);
      const cid = buildCid(bogusPayload);

      const fetchSpy = vi.fn(async () =>
        makeFullResponse(carBytes, {
          headers: {
            'Content-Encoding': 'gzip',
            'Content-Length': String(carBytes.byteLength),
          },
        }),
      );
      globalThis.fetch = fetchSpy as never;

      const fetcher = __internal.buildCarFetcher([
        'https://gw1.example',
        'https://gw2.example',
        'https://gw3.example',
      ]);
      const result = await fetcher(cid.bytes);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('car_parse_failed');
      }
      // Protocol violation is deterministic — per §8.5 D6 we do NOT fall
      // through to the next gateway (the encoding error is identical
      // regardless of gateway; retrying wastes time and leaks attack
      // surface).
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('accepts Content-Encoding: identity (raw bytes)', async () => {
      const payload = new TextEncoder().encode('J7-identity');
      const { bytes: carBytes, rootCid } = await buildValidCar(payload);

      globalThis.fetch = vi.fn(async () =>
        makeFullResponse(carBytes, {
          headers: {
            'Content-Encoding': 'identity',
            'Content-Length': String(carBytes.byteLength),
          },
        }),
      ) as never;

      const fetcher = __internal.buildCarFetcher(['https://gw1.example']);
      const result = await fetcher(rootCid.bytes);
      expect(result.ok).toBe(true);
    });
  });

  // ── J8 ───────────────────────────────────────────────────────────────────
  describe('J8 — Total budget exceeded → transient_unavailable, no hang', () => {
    it(
      'returns transient_unavailable without hanging when gateways exhaust CAR_FETCH_TOTAL_BUDGET_MS',
      async () => {
        // Strategy: every gateway errors immediately with a network failure
        // that maps to `network_error` (a transient class). buildCarFetcher
        // accumulates these in `lastTransient` and advances to the next
        // gateway; when the outer CAR_FETCH_TOTAL_BUDGET_MS (60s) elapses
        // the loop's `budgetRemaining() === 0` short-circuit fires and we
        // return transient_unavailable. We simulate budget exhaustion by
        // mocking Date.now() to leap forward between gateway calls.
        //
        // Why not use fake timers + real setTimeout? fetchCarFromGateway's
        // internal AbortController uses setTimeout; we want the error path
        // (not the timeout path). Mocking Date.now lets us advance the
        // wall-clock budget deterministically without actually sleeping.
        const realDateNow = Date.now.bind(Date);
        const fakeClock = { t: realDateNow() };
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeClock.t);

        // Throw a synthetic "network down" every call, and advance the
        // clock by 25s per gateway call — 3 calls = 75s > 60s budget.
        const fetchSpy = vi.fn(async () => {
          fakeClock.t += 25_000;
          throw new Error('ECONNRESET');
        });
        globalThis.fetch = fetchSpy as never;

        const gateways = [
          'https://gw1.example',
          'https://gw2.example',
          'https://gw3.example',
          'https://gw4.example',
        ];
        const cid = buildCid(new TextEncoder().encode('J8'));

        const fetcher = __internal.buildCarFetcher(gateways);

        const startWall = realDateNow();
        const result = await fetcher(cid.bytes);
        const elapsedWall = realDateNow() - startWall;

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe('transient_unavailable');
        }

        // The fetcher MUST NOT actually sleep for the full simulated
        // 60s+. Real wall-clock elapsed should be <<1s — the budget
        // check uses Date.now() which we've advanced via spy. This is
        // the "no hang" half of the invariant: a misconfigured operator
        // cannot block the hot path in real time.
        expect(elapsedWall).toBeLessThan(5_000);

        // The fetcher short-circuits once the budget is exhausted — it
        // MUST NOT call fetch for every gateway in the list. With the
        // 25s-per-call advance, gw1 + gw2 consume 50s, gw3 tips over 60s;
        // gw4 never gets a call because budgetRemaining() === 0 at the
        // top of the loop iteration.
        expect(fetchSpy.mock.calls.length).toBeLessThan(gateways.length);

        nowSpy.mockRestore();
      },
      15_000,
    );

    it(
      'short-circuits immediately when zero gateways are configured',
      async () => {
        const cid = buildCid(new TextEncoder().encode('J8-empty'));
        const fetcher = __internal.buildCarFetcher([]);
        const result = await fetcher(cid.bytes);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe('transient_unavailable');
        }
      },
    );

    it(
      'rejects invalid cidBytes before any gateway call',
      async () => {
        // Pre-flight: CID.decode fails on 64-zero-bytes. The fetcher must
        // surface car_parse_failed without touching fetch.
        const fetchSpy = vi.fn(async () =>
          makeFullResponse(new Uint8Array(0)),
        );
        globalThis.fetch = fetchSpy as never;

        const fetcher = __internal.buildCarFetcher(['https://gw1.example']);
        const result = await fetcher(new Uint8Array(64));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe('car_parse_failed');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );
  });
});
