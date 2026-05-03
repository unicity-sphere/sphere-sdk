/**
 * CID fetcher — UXF Inter-Wallet Transfer recipient (T.4.B).
 *
 * Recipient-side path for `kind: 'uxf-cid'` envelopes (§3.3). When the
 * sender ships a CID-by-reference instead of inlining the CAR bytes, the
 * recipient must:
 *
 *   1. Walk a configured list of IPFS gateways IN ORDER.
 *   2. Stream-fetch the CAR via `${gateway}/ipfs/${bundleCid}?format=car`.
 *   3. Maintain a running byte counter and ABORT THE READER MID-STREAM
 *      once the count crosses {@link MAX_FETCHED_CAR_BYTES} (32 MiB) —
 *      the body MUST NOT be buffered to completion before the size check
 *      (DoS defense, §3.3.1 normative).
 *   4. Re-derive the CARv1 root CID from the returned bytes and verify
 *      it matches the requested `bundleCid` (gateway misbehavior /
 *      hostile-gateway defense, §3.3 "verified-CAR pipeline").
 *   5. On per-gateway failure (network error, 5xx, oversize, mismatch):
 *      record the reason and try the next gateway.
 *   6. If every gateway fails: emit `transfer:fetch-failed` and throw a
 *      transient-class error (`BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT`).
 *      Per §9.2 + W13: NO disposition record is written; the worker
 *      pool retries via the transient path.
 *
 * **Streaming abort mechanism (validated by tests).** We obtain a
 * `ReadableStreamDefaultReader<Uint8Array>` from `Response.body.getReader()`
 * and pull chunks one at a time. After every successful `read()` we
 * accumulate the chunk into a small array and tally `byteCounter`. If
 * `byteCounter > maxBytes`, we call `reader.cancel()` AND
 * `controller.abort()` BEFORE concatenating the buffered chunks — the
 * caller never sees a >32 MiB Uint8Array. The reader returns immediately
 * after `cancel()`, so we don't drain the rest of the stream into
 * memory. The unit test confirms early-abort by feeding a 33 MiB stream
 * via a mocked `Response.body.getReader()` and asserting that no more
 * than `maxBytes` bytes were ever buffered.
 *
 * **Order matters.** The gateway list is walked in order. The caller
 * decides the priority (e.g., local Helia gateway first, public
 * gateways second, last-resort gateways last). The fetcher does NOT
 * shuffle, parallelize, or reweight — surfacing a deterministic result
 * is part of the §9.2 retry-budget contract.
 *
 * **CID-mismatch is per-gateway, not fail-stop.** A gateway that
 * returns a CAR with the wrong root CID is buggy or hostile, but the
 * NEXT gateway might serve correctly — the spec mandates we keep
 * walking. Only when every gateway has failed do we surface the
 * transient error.
 *
 * **AbortSignal support.** Callers pass an `AbortSignal` to cancel
 * mid-stream (e.g., the worker pool wants to shut down). We forward
 * the signal to the underlying `fetch()` AND check it after each
 * chunk — both paths cooperate to give a fast cancellation.
 *
 * Spec references:
 *   - §3.3   `kind: 'uxf-cid'` — CID-by-reference envelope.
 *   - §3.3.1 32 MiB recipient cap (`MAX_FETCHED_CAR_BYTES`); streaming
 *            abort, NOT buffer-then-check.
 *   - §3.3.2 Delivery-completion semantics (recipient-side delivered
 *            ONLY after physical CAR fetch).
 *   - §9.2   Recipient gateway can't fetch CID (transient retry path,
 *            no disposition record).
 *   - W13    NO `_invalid` / `_audit` write on gateway-fetch failure;
 *            transient class only.
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors.js';
import type { SphereEventMap } from '../../../types/index.js';
import { extractCarRootCid } from '../../../uxf/transfer-payload.js';

import { MAX_FETCHED_CAR_BYTES, MAX_TOTAL_FETCH_MS } from './limits.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Minimal subset of the platform `fetch` we use. Decoupling the type from
 * `typeof globalThis.fetch` lets test mocks be written without `as any`
 * coercion (TS strict mode forbids structurally-non-equivalent fetch
 * substitutes from satisfying the global type).
 */
export type CidFetcherFetch = (
  input: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<Response>;

/**
 * Discriminated emit signature so the fetcher does not depend on the full
 * Sphere event-bus machinery. The bundle-acquirer (T.4.B integration) wires
 * a closure that calls into the Sphere event emitter.
 */
export type CidFetcherEmit = <K extends keyof SphereEventMap>(
  event: K,
  payload: SphereEventMap[K],
) => void;

/**
 * Construction options for {@link fetchCarByCid}. All fields except
 * `gateways` are optional with sensible defaults.
 */
export interface CidFetcherOptions {
  /**
   * Gateway URL list, walked IN ORDER. Each URL MUST NOT include a
   * trailing slash (the fetcher constructs `${gateway}/ipfs/${cid}` and
   * a trailing slash would collapse to a double-slash; we don't strip it
   * defensively because the §9.2 retry semantics require deterministic
   * URL construction). Empty list → throws `VALIDATION_ERROR` upfront.
   */
  readonly gateways: ReadonlyArray<string>;
  /**
   * Authenticated sender pubkey (64-hex Nostr signing pubkey, NOT the
   * unauthenticated `sender.transportPubkey` claim from the payload).
   * Forwarded into the `transfer:fetch-failed` event payload for
   * forensic peer attribution.
   */
  readonly senderTransportPubkey: string;
  /**
   * Optional `fetch` override for tests. Defaults to `globalThis.fetch`
   * — Node 18+ ships native fetch, browsers always have it. We bind to
   * `globalThis` at call time (not module load time) so tests that
   * monkey-patch `global.fetch` interact correctly with this default.
   */
  readonly fetch?: CidFetcherFetch;
  /**
   * Optional event emit closure. When present, called with
   * `'transfer:fetch-failed'` after every gateway has failed (§9.2). When
   * omitted, the fetcher silently throws — the bundle-acquirer wires the
   * emitter on its side.
   */
  readonly emit?: CidFetcherEmit;
  /**
   * Caller-supplied abort signal. When triggered mid-stream, the
   * fetcher throws an `AbortError`-shaped error WITHOUT trying further
   * gateways (the user wants out NOW; trying more gateways would be
   * disrespectful of the cancellation).
   */
  readonly signal?: AbortSignal;
  /**
   * Recipient-side cap on fetched CAR bytes. Defaults to
   * {@link MAX_FETCHED_CAR_BYTES} (32 MiB). Tests pass smaller values
   * to exercise the streaming-abort path with feasible mock data.
   */
  readonly maxBytes?: number;
  /**
   * Total wall-clock cap on the entire `fetchCarByCid` call, in
   * milliseconds. When this fires, every in-flight gateway fetch is
   * aborted via the composed AbortController, the gateway-walking loop
   * exits, and the fetcher throws a transient-class error with
   * `cause.reason === 'total-fetch-timeout'`.
   *
   * Defaults to {@link MAX_TOTAL_FETCH_MS} (5 minutes). DoS defense
   * against a hostile peer drip-feeding N gateways under each one's
   * idle-timeout window: without this cap, the worker can hang for
   * hours per bundle. Tests pass small values (e.g., 50 ms) with fake
   * timers to exercise the abort path deterministically.
   *
   * MUST be a positive finite number. Inputs that are non-finite,
   * zero, or negative are rejected with `VALIDATION_ERROR` upfront.
   */
  readonly maxTotalFetchMs?: number;
}

/**
 * Successful return shape: the validated CAR bytes and the gateway that
 * served them (for telemetry / metrics).
 */
export interface CidFetcherResult {
  /**
   * The CAR bytes whose root CID we have already verified equals the
   * requested `bundleCid`. Caller hands these to `UxfPackage.fromCar()`.
   */
  readonly carBytes: Uint8Array;
  /** The gateway URL that successfully served the bytes. */
  readonly gatewayUsed: string;
}

// =============================================================================
// 2. Public API — fetchCarByCid
// =============================================================================

/**
 * Walk `options.gateways` in order, stream-fetch the CAR for `bundleCid`,
 * verify the root CID matches, and return the bytes.
 *
 * @param bundleCid The requested CIDv1 base32 (`b...`) string.
 * @param options   See {@link CidFetcherOptions} for per-field semantics.
 *
 * @throws {SphereError} `VALIDATION_ERROR` if `gateways` is empty.
 * @throws {SphereError} `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` if every
 *         gateway fails OR the total wall-clock cap fires. The error's
 *         `cause` is `{ bundleCid, gatewaysAttempted, failureReasons,
 *         reason }`. The `reason` field is `'all-gateways-failed'` for
 *         the per-gateway exhaustion path or `'total-fetch-timeout'`
 *         when {@link CidFetcherOptions.maxTotalFetchMs} fires. Per
 *         §9.2 + W13 the caller MUST treat both as TRANSIENT — no
 *         disposition record.
 * @throws The original `AbortError` (whose name === 'AbortError') if
 *         `options.signal` aborts mid-flight. Subsequent gateways are
 *         NOT attempted.
 */
export async function fetchCarByCid(
  bundleCid: string,
  options: CidFetcherOptions,
): Promise<CidFetcherResult> {
  // ---- Validate inputs ----
  if (options.gateways.length === 0) {
    throw new SphereError(
      'fetchCarByCid: gateways list is empty',
      'VALIDATION_ERROR',
    );
  }
  if (typeof bundleCid !== 'string' || bundleCid.length === 0) {
    throw new SphereError(
      'fetchCarByCid: bundleCid must be a non-empty string',
      'VALIDATION_ERROR',
    );
  }
  const maxBytes = options.maxBytes ?? MAX_FETCHED_CAR_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new SphereError(
      `fetchCarByCid: maxBytes must be a positive finite number (got ${String(maxBytes)})`,
      'VALIDATION_ERROR',
    );
  }
  const maxTotalFetchMs = options.maxTotalFetchMs ?? MAX_TOTAL_FETCH_MS;
  if (!Number.isFinite(maxTotalFetchMs) || maxTotalFetchMs <= 0) {
    throw new SphereError(
      `fetchCarByCid: maxTotalFetchMs must be a positive finite number (got ${String(maxTotalFetchMs)})`,
      'VALIDATION_ERROR',
    );
  }
  // Resolve fetch lazily so tests that monkey-patch `globalThis.fetch`
  // BETWEEN module-load and call-site see the patched value. Static-
  // binding at module load would freeze the original in place.
  const doFetch: CidFetcherFetch =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, init));

  // ---- Compose the call-level signal ----
  // Steelman fix #161: even with a 60s per-gateway IDLE timeout, a
  // hostile peer can chain N gateways at idle-window boundaries and
  // drip-feed the recipient for hours. The `totalTimeoutController`
  // bounds the entire call to `maxTotalFetchMs` (default 5 minutes),
  // and we expose its signal — composed with the caller-supplied
  // `options.signal` — to every gateway hop. When EITHER the caller
  // aborts OR the total timeout fires, every in-flight network read
  // is cancelled.
  const totalTimeoutController = new AbortController();
  const totalTimer = setTimeout(() => {
    totalTimeoutController.abort();
  }, maxTotalFetchMs);
  const composedSignal = composeAbortSignals(
    options.signal,
    totalTimeoutController.signal,
  );

  // ---- Walk gateways ----
  const failureReasons: string[] = [];
  let totalTimedOut = false;
  try {
    for (const gateway of options.gateways) {
      // Total-timeout check between gateways. If the deadline expired
      // during the previous hop, exit cleanly with the timeout reason
      // instead of starting a fresh one.
      if (totalTimeoutController.signal.aborted) {
        totalTimedOut = true;
        failureReasons.push('total-fetch-timeout');
        break;
      }
      // Cooperative caller cancellation between gateways — if the
      // caller aborted during the previous gateway's hop, surface
      // immediately rather than trying the next gateway.
      if (options.signal?.aborted) {
        throw makeAbortError(
          'fetchCarByCid: aborted by caller before next gateway',
        );
      }

      const url = buildGatewayUrl(gateway, bundleCid);
      let outcome: GatewayOutcome;
      try {
        outcome = await fetchOneGateway({
          url,
          bundleCid,
          maxBytes,
          fetchImpl: doFetch,
          signal: composedSignal,
        });
      } catch (cause) {
        // If the total timeout fired during this hop, the abort error
        // came from OUR timeout controller (not the caller). Treat
        // that as the timeout outcome, NOT as a caller cancellation.
        if (totalTimeoutController.signal.aborted && !options.signal?.aborted) {
          totalTimedOut = true;
          failureReasons.push('total-fetch-timeout');
          break;
        }
        // Re-throw genuine caller cancellations verbatim.
        if (isAbortError(cause) && options.signal?.aborted) {
          throw cause;
        }
        // Anything else is a per-gateway failure — record reason and
        // continue.
        outcome = {
          ok: false,
          reason: `network: ${stringifyError(cause)}`,
        };
      }

      if (outcome.ok) {
        return { carBytes: outcome.carBytes, gatewayUsed: gateway };
      }
      failureReasons.push(outcome.reason);

      // Defensive re-check: a per-gateway hop that swallowed the abort
      // (e.g., classified it as `oversize`/`http 5xx`) should not let
      // the loop walk to the next gateway after the deadline.
      if (totalTimeoutController.signal.aborted) {
        totalTimedOut = true;
        if (failureReasons[failureReasons.length - 1] !== 'total-fetch-timeout') {
          failureReasons.push('total-fetch-timeout');
        }
        break;
      }
    }
  } finally {
    clearTimeout(totalTimer);
  }

  // ---- All gateways failed (or total deadline hit) → emit + throw transient ----
  const reason: 'total-fetch-timeout' | 'all-gateways-failed' = totalTimedOut
    ? 'total-fetch-timeout'
    : 'all-gateways-failed';
  options.emit?.('transfer:fetch-failed', {
    bundleCid,
    senderTransportPubkey: options.senderTransportPubkey,
    gatewaysAttempted: [...options.gateways],
    failureReasons: [...failureReasons],
  });
  const message = totalTimedOut
    ? `fetchCarByCid: total wall-clock cap (${maxTotalFetchMs}ms) exceeded for ${bundleCid}`
    : `fetchCarByCid: all ${options.gateways.length} gateway(s) failed for ${bundleCid}`;
  throw new SphereError(
    message,
    'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT',
    {
      bundleCid,
      gatewaysAttempted: [...options.gateways],
      failureReasons: [...failureReasons],
      reason,
    },
  );
}

// =============================================================================
// 3. Internal — single-gateway streaming fetch
// =============================================================================

/**
 * Discriminated outcome of a single gateway hop. We avoid exceptions
 * for the "try next gateway" failure modes to keep the gateway-walking
 * loop linear and readable; only AbortError escapes via throw.
 *
 * @internal
 */
type GatewayOutcome =
  | { readonly ok: true; readonly carBytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

interface FetchOneGatewayArgs {
  readonly url: string;
  readonly bundleCid: string;
  readonly maxBytes: number;
  readonly fetchImpl: CidFetcherFetch;
  readonly signal?: AbortSignal;
}

/**
 * Fetch and validate from one gateway. Returns a structured outcome — a
 * thrown AbortError reflects ONLY caller cancellation; gateway-side
 * problems (network, 5xx, oversize, mismatch) collapse to
 * `{ok: false, reason}` so the outer loop walks linearly.
 *
 * **Streaming-abort proof.** We pull chunks one by one and accumulate
 * the running `byteCounter`. The moment `byteCounter > maxBytes`, we
 * call `reader.cancel()` and `controller.abort()` BEFORE pushing the
 * latest chunk to `chunks[]`. The caller never sees more than `maxBytes`
 * bytes assembled. Tests assert this by feeding a 33 MiB synthetic
 * stream and observing that the post-abort `Uint8Array` is `<= maxBytes`
 * in length.
 *
 * @internal
 */
/**
 * Steelman fix: per-gateway IDLE timeout. Without this, a hostile
 * gateway can drip-feed bytes at any rate beneath the streaming cap
 * and stall a worker for hours (the worker's outer `signal` is the
 * long-lived destroy signal, not a per-fetch deadline).
 *
 * Steelman recursion fix: this is an IDLE timeout, refreshed on every
 * chunk read — a slow-but-honest gateway streaming at 100 KB/s over a
 * mobile link to fetch a 32 MiB CAR (5+ minutes total wall-clock) will
 * keep refreshing the timer with each chunk, while a true drip-feed
 * (no progress for >60s) still trips it. Earlier (wall-clock-from-
 * fetch-start) variant would have killed legitimate slow fetches near
 * the cap; idle-timer is the correct shape per the steelman feedback.
 */
const DEFAULT_PER_GATEWAY_IDLE_TIMEOUT_MS = 60_000;

async function fetchOneGateway(args: FetchOneGatewayArgs): Promise<GatewayOutcome> {
  const { url, bundleCid, maxBytes, fetchImpl, signal: callerSignal } = args;

  // Compose the abort controller: we want to abort the network when
  // EITHER the caller cancels OR our own size cap fires OR our
  // per-gateway wall-clock timeout fires. Forwarding all three signals
  // to the same `controller.abort()` keeps the underlying `fetch()`
  // honest (cancels in-flight TCP read).
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort();
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }
  // Per-gateway IDLE timeout — see DEFAULT_PER_GATEWAY_IDLE_TIMEOUT_MS.
  // Refreshed in the streaming-read loop on every chunk read; trips
  // only when the gateway has produced no progress for the idle window.
  let perGatewayTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    controller.abort();
  }, DEFAULT_PER_GATEWAY_IDLE_TIMEOUT_MS);
  const refreshIdleTimer = (): void => {
    clearTimeout(perGatewayTimer);
    perGatewayTimer = setTimeout(() => {
      controller.abort();
    }, DEFAULT_PER_GATEWAY_IDLE_TIMEOUT_MS);
  };

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (cause) {
    callerSignal?.removeEventListener('abort', onCallerAbort);
    clearTimeout(perGatewayTimer);
    if (callerSignal?.aborted) {
      throw makeAbortError('fetchCarByCid: aborted by caller during fetch');
    }
    return { ok: false, reason: `network: ${stringifyError(cause)}` };
  }

  // 4xx / 5xx / 3xx-no-redirect — gateway said no.
  if (!response.ok) {
    callerSignal?.removeEventListener('abort', onCallerAbort);
    clearTimeout(perGatewayTimer);
    // Drain the body off the wire (best-effort; defensive against
    // some server impls that hold the connection open). Cancel
    // explicitly so we don't leak the reader.
    try {
      await response.body?.cancel();
    } catch {
      /* swallow — diagnostic side-effect only */
    }
    return { ok: false, reason: `http ${response.status}` };
  }

  // The Content-Length header is OPTIONAL and ATTACKER-CONTROLLED.
  // We trust it ONLY for an early bail-out when it claims a value
  // strictly greater than `maxBytes` — a legitimate sender wouldn't
  // serve a CAR larger than the cap, and rejecting early avoids one
  // round-trip's worth of bytes. We do NOT trust it as a substitute
  // for the streaming counter — a hostile gateway might lie low and
  // serve a bigger body anyway. The streaming counter is the
  // authoritative cap.
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const parsed = Number(contentLengthHeader);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      clearTimeout(perGatewayTimer);
      controller.abort();
      try {
        await response.body?.cancel();
      } catch {
        /* swallow */
      }
      return {
        ok: false,
        reason: `car-too-large: content-length ${parsed} > ${maxBytes}`,
      };
    }
  }

  // Drain the body via streaming reader, with running-byte cap.
  const body = response.body;
  if (!body) {
    callerSignal?.removeEventListener('abort', onCallerAbort);
    clearTimeout(perGatewayTimer);
    return { ok: false, reason: 'no response body' };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCounter = 0;
  let oversize = false;
  try {
    for (;;) {
      // Cooperative cancellation between chunks.
      if (callerSignal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          /* swallow */
        }
        controller.abort();
        throw makeAbortError(
          'fetchCarByCid: aborted by caller during streaming read',
        );
      }
      const { value, done } = await reader.read();
      // Refresh the idle timer on every read (chunk OR done signal).
      // A slow-but-honest gateway making any forward progress keeps
      // resetting the deadline; a drip-feed that stalls for >60s
      // trips the timer via controller.abort().
      refreshIdleTimer();
      if (done) break;
      if (!value) continue;
      const chunkBytes = value.byteLength;
      if (byteCounter + chunkBytes > maxBytes) {
        // Streaming abort — DO NOT push this chunk; cancel the reader,
        // close the controller, mark oversize, exit the loop. The
        // `chunks[]` array's accumulated length stays at `byteCounter`,
        // which is `<= maxBytes` by loop invariant.
        oversize = true;
        try {
          await reader.cancel();
        } catch {
          /* swallow */
        }
        controller.abort();
        break;
      }
      chunks.push(value);
      byteCounter += chunkBytes;
    }
  } finally {
    callerSignal?.removeEventListener('abort', onCallerAbort);
    clearTimeout(perGatewayTimer);
  }

  if (oversize) {
    return {
      ok: false,
      reason: `car-too-large: streaming exceeded ${maxBytes} bytes`,
    };
  }

  const carBytes = concatChunks(chunks, byteCounter);

  // Re-derive root CID and verify against the requested bundleCid.
  let extractedCid: string;
  try {
    extractedCid = await extractCarRootCid(carBytes);
  } catch (cause) {
    return {
      ok: false,
      reason: `invalid-car: ${stringifyError(cause)}`,
    };
  }
  if (extractedCid !== bundleCid) {
    return {
      ok: false,
      reason: `cid-mismatch: gateway served ${extractedCid}, requested ${bundleCid}`,
    };
  }
  return { ok: true, carBytes };
}

// =============================================================================
// 4. Internal — small utilities
// =============================================================================

/**
 * Build the gateway-relative path-style URL. Per spec §3.3, the
 * recipient walks "its own configured gateway list"; the format is the
 * IPFS HTTP gateway path-style with `?format=car` to request CARv1
 * bytes (Trustless Gateway spec, supported by kubo, helia, public
 * gateways). We do NOT use subdomain-style (`<cid>.ipfs.gw.tld`)
 * because path-style is universally supported and the protocol
 * mandates a deterministic URL shape.
 *
 * @internal
 */
function buildGatewayUrl(gateway: string, cid: string): string {
  return `${gateway}/ipfs/${cid}?format=car`;
}

/**
 * Concatenate `chunks` into a single Uint8Array of length `totalLen`.
 * `totalLen` is the caller-tracked running byte count — passing it in
 * avoids re-summing `chunks[].byteLength` in a hot path.
 *
 * @internal
 */
function concatChunks(chunks: ReadonlyArray<Uint8Array>, totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Compose two AbortSignals into one that aborts when EITHER source
 * aborts. We don't rely on `AbortSignal.any([...])` because (a) it's
 * Node 20+ only and we keep node>=18 as the minimum-supported, and
 * (b) the caller-supplied signal is `undefined`-allowed — falling back
 * to a manually-wired `AbortController` is simpler than threading
 * `AbortSignal.any` through both branches.
 *
 * Usage contract: pass the caller's `signal` (may be `undefined`) and
 * the total-timeout controller's `signal`. Returns a single
 * `AbortSignal` that is aborted iff at least one of the inputs is
 * aborted.
 *
 * @internal
 */
function composeAbortSignals(
  callerSignal: AbortSignal | undefined,
  totalTimeoutSignal: AbortSignal,
): AbortSignal {
  // If the caller supplied no signal, the total-timeout signal IS the
  // composed signal — no wiring needed.
  if (!callerSignal) return totalTimeoutSignal;
  // Either signal already aborted? Return a pre-aborted controller's
  // signal. Constructing an AbortController and aborting it in the same
  // tick is the cross-platform equivalent of `AbortSignal.abort()`
  // (which is also Node 17.3+ but we stay defensive).
  if (callerSignal.aborted || totalTimeoutSignal.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const composed = new AbortController();
  const onCallerAbort = (): void => {
    composed.abort();
    cleanup();
  };
  const onTimeoutAbort = (): void => {
    composed.abort();
    cleanup();
  };
  const cleanup = (): void => {
    callerSignal.removeEventListener('abort', onCallerAbort);
    totalTimeoutSignal.removeEventListener('abort', onTimeoutAbort);
  };
  callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  totalTimeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });
  return composed.signal;
}

/**
 * Construct an `AbortError`-shaped Error so call sites can detect it
 * via `err.name === 'AbortError'`. We don't subclass `DOMException`
 * because Node lacks it consistently across versions; the `name`
 * convention is enough for our purposes.
 *
 * @internal
 */
function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Detect the AbortError convention. Both DOM-level and our own
 * `makeAbortError` set `name === 'AbortError'`.
 *
 * @internal
 */
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Render an unknown thrown value as a one-line string for the
 * `failureReasons` log. Avoids stringifying full stacks (those are
 * preserved in the SphereError's `cause` chain for debug consumers).
 *
 * @internal
 */
function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
