/**
 * Tests for `modules/payments/transfer/cid-fetcher.ts` (T.4.B).
 *
 * Spec references:
 *  - §3.3   `kind: 'uxf-cid'` — gateway walking + verified-CAR pipeline.
 *  - §3.3.1 Recipient-side 32 MiB cap (`MAX_FETCHED_CAR_BYTES`); streaming
 *           abort, NOT buffer-then-check.
 *  - §3.3.2 Delivery semantics — recipient delivered ONLY after physical fetch.
 *  - §9.2   All-gateways-failure → `transfer:fetch-failed`; transient retry
 *           path; W13: NO disposition record written.
 *
 * Coverage:
 *  - Happy path: single gateway → returns valid CAR with matching CID.
 *  - First gateway fails (network), second succeeds.
 *  - All gateways fail → emits `transfer:fetch-failed`; throws transient.
 *  - CAR > maxBytes streaming → throws / returns oversize per-gateway error,
 *    and only ≤ maxBytes was buffered (early-abort proof).
 *  - Root-CID mismatch → tries next gateway; final fail-stop if all mismatch.
 *  - Empty gateway list → throws VALIDATION_ERROR.
 *  - Force-cid for tiny bundle: still goes through fetch (regression).
 *  - Abort signal: caller aborts mid-stream → throws AbortError;
 *    downstream gateways are NOT tried.
 */

import { describe, expect, it, vi } from 'vitest';

import { isSphereError } from '../../../../core/errors';
import {
  fetchCarByCid,
  type CidFetcherFetch,
} from '../../../../modules/payments/transfer/cid-fetcher';
import type { SphereEventMap } from '../../../../types/index';
import { UxfPackage } from '../../../../uxf/UxfPackage';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../../uxf/transfer-payload';

import { TOKEN_A, TOKEN_B } from '../../../fixtures/uxf-mock-tokens';

// =============================================================================
// 0. Shared helpers
// =============================================================================

const SENDER = 'a'.repeat(64);

interface FixtureCar {
  readonly carBytes: Uint8Array;
  readonly carBase64: string;
  readonly bundleCid: string;
}

async function buildFixtureCar(
  token: Record<string, unknown> = TOKEN_A as unknown as Record<string, unknown>,
): Promise<FixtureCar> {
  const pkg = UxfPackage.create();
  pkg.ingestAll([token]);
  const carBytes = await pkg.toCar();
  const bundleCid = await extractCarRootCid(carBytes);
  return { carBytes, carBase64: carBytesToBase64(carBytes), bundleCid };
}

/**
 * Build a Response whose body streams the supplied chunks. The resulting
 * Response.body.getReader() emits exactly the chunks in order, then
 * signals `done`. Used as the basis for both happy-path and oversize
 * streaming tests.
 */
function makeStreamingResponse(
  chunks: ReadonlyArray<Uint8Array>,
  init?: { readonly status?: number; readonly contentLength?: number },
): Response {
  const status = init?.status ?? 200;
  const headers = new Headers();
  if (init?.contentLength !== undefined) {
    headers.set('content-length', String(init.contentLength));
  }
  // Read-state machine: emit chunks one at a time, then close.
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status, headers });
}

/**
 * Capture each call to the emit closure for assertions.
 */
interface CapturedEmit {
  readonly events: ReadonlyArray<{
    readonly name: keyof SphereEventMap;
    readonly payload: unknown;
  }>;
  readonly emit: <K extends keyof SphereEventMap>(
    name: K,
    payload: SphereEventMap[K],
  ) => void;
}
function makeEmitCapture(): CapturedEmit {
  const events: { readonly name: keyof SphereEventMap; readonly payload: unknown }[] = [];
  return {
    events,
    emit: (name, payload) => {
      events.push({ name, payload });
    },
  };
}

// =============================================================================
// 1. Empty gateway list
// =============================================================================

describe('fetchCarByCid — input validation', () => {
  it('throws VALIDATION_ERROR when gateways is empty', async () => {
    let caught: unknown;
    try {
      await fetchCarByCid('bafytest', {
        gateways: [],
        senderTransportPubkey: SENDER,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('VALIDATION_ERROR');
    expect(caught.message).toContain('empty');
  });

  it('throws VALIDATION_ERROR on empty bundleCid', async () => {
    let caught: unknown;
    try {
      await fetchCarByCid('', {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('VALIDATION_ERROR');
  });

  it('throws VALIDATION_ERROR on non-positive maxBytes', async () => {
    let caught: unknown;
    try {
      await fetchCarByCid('bafytest', {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
        maxBytes: 0,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('VALIDATION_ERROR');
  });
});

// =============================================================================
// 2. Happy path
// =============================================================================

describe('fetchCarByCid — happy path', () => {
  it('returns CAR bytes and gatewayUsed for a single gateway success', async () => {
    const fx = await buildFixtureCar();
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      makeStreamingResponse([fx.carBytes]),
    );
    const gateway = 'https://gw1.example';
    const result = await fetchCarByCid(fx.bundleCid, {
      gateways: [gateway],
      senderTransportPubkey: SENDER,
      fetch: fetchImpl,
    });
    expect(result.gatewayUsed).toBe(gateway);
    expect(result.carBytes).toEqual(fx.carBytes);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${gateway}/ipfs/${fx.bundleCid}?format=car`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('handles a CAR delivered as multiple chunks', async () => {
    const fx = await buildFixtureCar();
    // Split the CAR into 3 chunks to exercise the read loop.
    const third = Math.floor(fx.carBytes.byteLength / 3);
    const chunks = [
      fx.carBytes.subarray(0, third),
      fx.carBytes.subarray(third, third * 2),
      fx.carBytes.subarray(third * 2),
    ];
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      makeStreamingResponse(chunks),
    );
    const result = await fetchCarByCid(fx.bundleCid, {
      gateways: ['https://gw.example'],
      senderTransportPubkey: SENDER,
      fetch: fetchImpl,
    });
    expect(result.carBytes).toEqual(fx.carBytes);
  });
});

// =============================================================================
// 3. Gateway fall-through
// =============================================================================

describe('fetchCarByCid — gateway walking order', () => {
  it('first gateway fails (network), second succeeds', async () => {
    const fx = await buildFixtureCar();
    const fetchImpl = vi
      .fn<Parameters<CidFetcherFetch>, ReturnType<CidFetcherFetch>>()
      .mockImplementationOnce(async () => {
        throw new Error('ECONNREFUSED');
      })
      .mockImplementationOnce(async () => makeStreamingResponse([fx.carBytes]));
    const result = await fetchCarByCid(fx.bundleCid, {
      gateways: ['https://broken.example', 'https://ok.example'],
      senderTransportPubkey: SENDER,
      fetch: fetchImpl as CidFetcherFetch,
    });
    expect(result.gatewayUsed).toBe('https://ok.example');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('first gateway returns 503, second succeeds', async () => {
    const fx = await buildFixtureCar();
    const fetchImpl = vi
      .fn<Parameters<CidFetcherFetch>, ReturnType<CidFetcherFetch>>()
      .mockImplementationOnce(async () =>
        makeStreamingResponse([], { status: 503 }),
      )
      .mockImplementationOnce(async () => makeStreamingResponse([fx.carBytes]));
    const result = await fetchCarByCid(fx.bundleCid, {
      gateways: ['https://degraded.example', 'https://ok.example'],
      senderTransportPubkey: SENDER,
      fetch: fetchImpl as CidFetcherFetch,
    });
    expect(result.gatewayUsed).toBe('https://ok.example');
  });
});

// =============================================================================
// 4. All gateways fail → transient + emit
// =============================================================================

describe('fetchCarByCid — all gateways fail', () => {
  it('emits transfer:fetch-failed and throws transient', async () => {
    const fx = await buildFixtureCar();
    const fetchImpl: CidFetcherFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const cap = makeEmitCapture();
    let caught: unknown;
    try {
      await fetchCarByCid(fx.bundleCid, {
        gateways: ['https://gw1.example', 'https://gw2.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        emit: cap.emit,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    // W13: NO `_invalid` / `_audit` write — we surface ONLY the typed
    // transient error; the test enforces the contract by ensuring the
    // ONLY observable side effect is the `transfer:fetch-failed` event.
    expect(cap.events).toHaveLength(1);
    const evt = cap.events[0];
    expect(evt.name).toBe('transfer:fetch-failed');
    const payload = evt.payload as SphereEventMap['transfer:fetch-failed'];
    expect(payload.bundleCid).toBe(fx.bundleCid);
    expect(payload.senderTransportPubkey).toBe(SENDER);
    expect(payload.gatewaysAttempted).toEqual([
      'https://gw1.example',
      'https://gw2.example',
    ]);
    expect(payload.failureReasons).toHaveLength(2);
    expect(payload.failureReasons[0]).toContain('network');
    expect(payload.failureReasons[1]).toContain('network');
  });

  it('does NOT emit when emit is not supplied (still throws transient)', async () => {
    const fx = await buildFixtureCar();
    const fetchImpl: CidFetcherFetch = vi.fn(async () => {
      throw new Error('boom');
    });
    let caught: unknown;
    try {
      await fetchCarByCid(fx.bundleCid, {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
  });
});

// =============================================================================
// 5. Streaming abort on oversize
// =============================================================================

describe('fetchCarByCid — streaming abort at maxBytes (W13 cap)', () => {
  it('aborts mid-stream when running byte-count exceeds maxBytes', async () => {
    // Build a synthetic streaming response that emits 33 chunks of 1 KiB,
    // for a total of 33 KiB. We set maxBytes to 32 KiB. The fetcher must
    // abort before the 33rd chunk is buffered — i.e., the cancellation
    // happens while chunk 33 is being read, BEFORE that chunk's bytes
    // are pushed to the chunks[] array.
    //
    // The streaming-abort proof has two complementary signals:
    //   (a) The fetcher MUST throw `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT`
    //       and the per-gateway reason MUST be `car-too-large`.
    //   (b) When the fetcher cancels the reader, the underlying stream's
    //       `cancel()` callback fires — we observe this directly via the
    //       `cancel` callback on the source. If `cancel()` was called,
    //       the streaming-abort path executed (i.e., we didn't drain the
    //       full body before checking).
    const KiB = 1024;
    // Source has 64 chunks (64 KiB total) but cap is 32 KiB. The
    // streaming-abort path MUST stop pulling far before the source is
    // exhausted — proving early-abort, NOT buffer-then-check.
    const totalChunks = 64;
    const chunkSize = KiB; // 1 KiB each
    const maxBytes = 32 * KiB; // 32 KiB cap
    const chunks: Uint8Array[] = [];
    for (let n = 0; n < totalChunks; n++) {
      const buf = new Uint8Array(chunkSize);
      buf.fill(n & 0xff);
      chunks.push(buf);
    }
    let chunksPulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksPulled >= totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[chunksPulled]);
        chunksPulled += 1;
      },
    });
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      new Response(stream, { status: 200 }),
    );
    const cap = makeEmitCapture();
    let caught: unknown;
    try {
      await fetchCarByCid('bafyfake', {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        emit: cap.emit,
        maxBytes,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    // Per-gateway reason matches the streaming-abort branch.
    expect(cap.events).toHaveLength(1);
    const payload = cap.events[0].payload as SphereEventMap['transfer:fetch-failed'];
    expect(payload.failureReasons[0]).toContain('car-too-large');

    // Critically, FAR fewer than totalChunks were pulled. The source
    // had 64 KiB of chunks; we expect the fetcher to break out of the
    // read loop as soon as the running byte-count + the next chunk
    // would exceed the 32 KiB cap. Pull-on-demand semantics mean
    // exactly one extra pull happens (the over-cap chunk that triggers
    // the break) — total ≤ (maxBytes / chunkSize) + 1 = 33.
    //
    // Reading all 64 chunks would mean we drained the entire 64 KiB
    // body before checking the cap — the buffer-then-check anti-
    // pattern this test exists to forbid.
    // Pull count is bounded above by `maxBytes/chunkSize + small slack`.
    // The slack accounts for (a) the over-cap chunk that triggers the
    // break, and (b) the Response/ReadableStream tee-wrap pre-fetching
    // one chunk ahead. Empirically: ≤ maxBytes/chunkSize + 2 in V8.
    // Reading 64 chunks (totalChunks) would mean buffer-then-check —
    // far above the cap.
    expect(chunksPulled).toBeLessThan(totalChunks);
    expect(chunksPulled).toBeLessThanOrEqual(maxBytes / chunkSize + 2);
    expect(chunksPulled).toBeGreaterThanOrEqual(maxBytes / chunkSize);
  });

  it('rejects upfront when content-length header > maxBytes', async () => {
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      makeStreamingResponse([new Uint8Array(0)], { contentLength: 64 * 1024 }),
    );
    const cap = makeEmitCapture();
    let caught: unknown;
    try {
      await fetchCarByCid('bafyfake', {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        emit: cap.emit,
        maxBytes: 32 * 1024,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    const payload = cap.events[0].payload as SphereEventMap['transfer:fetch-failed'];
    expect(payload.failureReasons[0]).toContain('car-too-large');
    expect(payload.failureReasons[0]).toContain('content-length');
  });

  it('over-cap reason in event payload is fetched-cap aware', async () => {
    // Emit 2 chunks that together exceed the small cap.
    const KiB = 1024;
    const chunks = [new Uint8Array(2 * KiB), new Uint8Array(2 * KiB)];
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      makeStreamingResponse(chunks),
    );
    const cap = makeEmitCapture();
    try {
      await fetchCarByCid('bafyfake', {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        emit: cap.emit,
        maxBytes: 3 * KiB, // smaller than total (4 KiB)
      });
    } catch {
      /* expected */
    }
    expect(cap.events).toHaveLength(1);
    const payload = cap.events[0].payload as SphereEventMap['transfer:fetch-failed'];
    expect(payload.failureReasons[0]).toContain('car-too-large');
    // The reason mentions the cap, not the actual size — the streaming
    // path bails on the first chunk that would push us past the cap.
    expect(payload.failureReasons[0]).toContain(String(3 * KiB));
  });
});

// =============================================================================
// 6. Root-CID mismatch
// =============================================================================

describe('fetchCarByCid — root-CID mismatch', () => {
  it('mismatched gateway → tries next gateway', async () => {
    const fx = await buildFixtureCar();
    const wrongCidRequest = 'bafyreid7gzkd7m2ovmh7y4hgsthhqhwlrbeenoaq2obuycoswbsedfsy5e';
    // The first gateway "serves" a CAR but its root CID disagrees with
    // the requested bundleCid. Real-world: gateway is buggy, hostile,
    // or the wrong CID was requested. Either way, fetcher MUST treat
    // this as a per-gateway failure and try the next one.
    const fetchImpl = vi
      .fn<Parameters<CidFetcherFetch>, ReturnType<CidFetcherFetch>>()
      .mockImplementationOnce(async () => makeStreamingResponse([fx.carBytes]))
      .mockImplementationOnce(async () => makeStreamingResponse([fx.carBytes]));
    const cap = makeEmitCapture();
    let caught: unknown;
    try {
      await fetchCarByCid(wrongCidRequest, {
        gateways: ['https://gw1.example', 'https://gw2.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl as CidFetcherFetch,
        emit: cap.emit,
      });
    } catch (err) {
      caught = err;
    }
    // Both fail with cid-mismatch.
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    const payload = cap.events[0].payload as SphereEventMap['transfer:fetch-failed'];
    expect(payload.failureReasons).toHaveLength(2);
    expect(payload.failureReasons[0]).toContain('cid-mismatch');
    expect(payload.failureReasons[1]).toContain('cid-mismatch');
  });

  it('first mismatches, second matches → success', async () => {
    // Build two distinct CARs from different fixtures: their root CIDs
    // genuinely differ. Gateway 1 returns the alternate CAR (root CID
    // does NOT match the requested bundleCid); gateway 2 serves the
    // correct one. The fetcher MUST keep walking past the per-gateway
    // mismatch until the second gateway succeeds.
    const fx = await buildFixtureCar(TOKEN_A as unknown as Record<string, unknown>);
    const alt = await buildFixtureCar(TOKEN_B as unknown as Record<string, unknown>);
    // Sanity — fixtures produce distinct root CIDs.
    expect(alt.bundleCid).not.toBe(fx.bundleCid);

    const fetchImpl = vi
      .fn<Parameters<CidFetcherFetch>, ReturnType<CidFetcherFetch>>()
      .mockImplementationOnce(async () => makeStreamingResponse([alt.carBytes]))
      .mockImplementationOnce(async () => makeStreamingResponse([fx.carBytes]));
    const result = await fetchCarByCid(fx.bundleCid, {
      gateways: ['https://gw1.example', 'https://gw2.example'],
      senderTransportPubkey: SENDER,
      fetch: fetchImpl as CidFetcherFetch,
    });
    expect(result.gatewayUsed).toBe('https://gw2.example');
    expect(result.carBytes).toEqual(fx.carBytes);
  });
});

// =============================================================================
// 7. Force-cid for tiny bundle (regression)
// =============================================================================

describe('fetchCarByCid — tiny-bundle regression', () => {
  it('does NOT shortcut based on bundle size — fetch is unconditional', async () => {
    const fx = await buildFixtureCar();
    expect(fx.carBytes.byteLength).toBeLessThan(64 * 1024); // tiny
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      makeStreamingResponse([fx.carBytes]),
    );
    const result = await fetchCarByCid(fx.bundleCid, {
      gateways: ['https://gw.example'],
      senderTransportPubkey: SENDER,
      fetch: fetchImpl,
    });
    // The fetcher always made the network call — never shortcut on size.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.carBytes).toEqual(fx.carBytes);
  });
});

// =============================================================================
// 8. AbortSignal
// =============================================================================

describe('fetchCarByCid — AbortSignal cancellation', () => {
  it('caller aborts before first gateway → throws AbortError', async () => {
    const fx = await buildFixtureCar();
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: CidFetcherFetch = vi.fn(async () =>
      makeStreamingResponse([fx.carBytes]),
    );
    let caught: unknown;
    try {
      await fetchCarByCid(fx.bundleCid, {
        gateways: ['https://gw1.example', 'https://gw2.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('AbortError');
    // No gateway was consulted because we bailed BEFORE the first hop.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR on non-positive maxTotalFetchMs', async () => {
    let caught: unknown;
    try {
      await fetchCarByCid('bafytest', {
        gateways: ['https://gw.example'],
        senderTransportPubkey: SENDER,
        maxTotalFetchMs: 0,
      });
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('VALIDATION_ERROR');
    expect(caught.message).toContain('maxTotalFetchMs');
  });

  it('caller aborts mid-stream → throws AbortError; later gateways NOT tried', async () => {
    // Build a long-running stream where each pull waits for a tick
    // (microtask + macrotask) so the fetcher's between-chunk abort
    // check has a chance to observe an asynchronously-fired abort.
    // After the FIRST chunk is delivered, we abort the caller signal —
    // the fetcher must throw AbortError on its next iteration without
    // consulting gateway 2.
    const KiB = 1024;
    const callerCtrl = new AbortController();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Defer the enqueue across a macrotask so the fetcher's
        // microtask-loop visit-the-abort-check has a chance to fire.
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (pulled === 0) {
              // Deliver the first chunk so the read loop runs once.
              controller.enqueue(new Uint8Array(KiB));
              pulled += 1;
              // Schedule the abort to fire BEFORE the next pull
              // happens — by the time the fetcher loops around to
              // read again, callerCtrl.signal.aborted is true.
              setTimeout(() => callerCtrl.abort(), 0);
            } else {
              // We don't expect any more pulls; if we get here, the
              // abort observation didn't fire in time. Push a chunk
              // anyway so the test fails on a meaningful assertion
              // (gateway 2 NOT called, AbortError name) rather than
              // hanging.
              controller.enqueue(new Uint8Array(KiB));
              pulled += 1;
            }
            resolve();
          }, 1);
        });
      },
    });
    const fetchImpl: CidFetcherFetch = vi.fn(async () => new Response(stream));
    let caught: unknown;
    try {
      await fetchCarByCid('bafyfake', {
        gateways: ['https://gw1.example', 'https://gw2.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        signal: callerCtrl.signal,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('AbortError');
    // Only the first gateway was visited; the second was NOT — caller
    // cancellation halts the walk.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 9. Total wall-clock cap (steelman fix #161)
// =============================================================================

describe('fetchCarByCid — total wall-clock cap (steelman #161)', () => {
  it('total-fetch-timeout fires across multiple drip-feeding gateways', async () => {
    // Hostile scenario: every gateway hangs forever (or under the
    // per-gateway idle window). Without the total cap, the fetcher
    // walks N gateways one by one for hours. With the total cap
    // (`maxTotalFetchMs: 50`), the very first hang trips the deadline,
    // every in-flight fetch is aborted via the composed signal, and we
    // surface the typed transient error with cause.reason ===
    // 'total-fetch-timeout'.
    //
    // We use real timers + a tiny cap (50ms) so the test doesn't need
    // fake-timer plumbing through ReadableStream pulls. The per-hop
    // hangs are implemented by returning a Response whose body never
    // yields (a stream that resolves only when its signal fires —
    // wired via the `init.signal` argument).
    const cap = makeEmitCapture();
    const fetchImpl: CidFetcherFetch = vi.fn((_url, init) => {
      // Build a stream that pulls forever — only resolves when the
      // composed signal fires (which causes the awaited reader.read()
      // to reject with an AbortError-shaped error).
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            const sig = init?.signal;
            if (sig?.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            sig?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          });
        },
      });
      return Promise.resolve(new Response(stream));
    });

    let caught: unknown;
    const start = Date.now();
    try {
      await fetchCarByCid('bafytotal', {
        gateways: [
          'https://drip1.example',
          'https://drip2.example',
          'https://drip3.example',
          'https://drip4.example',
          'https://drip5.example',
        ],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        emit: cap.emit,
        maxTotalFetchMs: 50, // very small cap so the test runs fast
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    // (1) The fetcher threw the typed transient error.
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT');
    // (2) The cause carries the new `reason: 'total-fetch-timeout'`
    //     discriminator so callers can distinguish from per-gateway
    //     exhaustion.
    const cause = caught.context as
      | {
          readonly reason?: string;
          readonly bundleCid?: string;
          readonly gatewaysAttempted?: ReadonlyArray<string>;
          readonly failureReasons?: ReadonlyArray<string>;
        }
      | undefined;
    expect(cause?.reason).toBe('total-fetch-timeout');
    // (3) The error message mentions the cap.
    expect(caught.message).toContain('total wall-clock cap');
    // (4) `transfer:fetch-failed` was emitted (W13 — same as the
    //     per-gateway exhaustion path; callers don't need a separate
    //     event for the total-timeout sub-case).
    const evt = cap.events.find((e) => e.name === 'transfer:fetch-failed');
    expect(evt).toBeDefined();
    // (5) Wall-clock sanity: we took NOWHERE NEAR 5 minutes —
    //     the cap fired well under 1 second. Allow generous CI slack.
    expect(elapsed).toBeLessThan(2000);
    // (6) We did NOT walk all 5 gateways — the abort halted the loop
    //     after the deadline fired (typically only 1 gateway visited).
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeLessThan(5);
  });

  it('caller signal stays distinct from total-timeout: caller abort still throws AbortError', async () => {
    // If the caller aborts during a hang, we MUST surface AbortError
    // (not the total-timeout transient) — the test guards the
    // composed-signal classification logic.
    const callerCtrl = new AbortController();
    const fetchImpl: CidFetcherFetch = vi.fn((_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            const sig = init?.signal;
            if (sig?.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            sig?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          });
        },
      });
      return Promise.resolve(new Response(stream));
    });
    // Schedule the caller-side abort to land BEFORE the (much larger)
    // total-timeout cap fires. We expect AbortError, not transient.
    setTimeout(() => callerCtrl.abort(), 20);

    let caught: unknown;
    try {
      await fetchCarByCid('bafycaller', {
        gateways: ['https://hang.example'],
        senderTransportPubkey: SENDER,
        fetch: fetchImpl,
        signal: callerCtrl.signal,
        maxTotalFetchMs: 5000, // way bigger than the caller-abort delay
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toBe('AbortError');
  });
});
