/**
 * H10 progress-rate CAR fetcher (T-C6) — SPEC §8.5, §10.7.
 *
 * Fetches a CAR bundle from an IPFS gateway with three-tier timeout budget:
 *
 *   initialResponse — max time to receive response headers
 *     (MAX_CAR_FETCH_INITIAL_RESPONSE_MS, default 10s)
 *   stall           — max interval between received bytes
 *     (MAX_CAR_FETCH_STALL_MS, default 30s)
 *   total           — absolute wall-clock cap including any resumes
 *     (MAX_CAR_FETCH_TOTAL_MS, default 300s)
 *
 * Additional guards:
 *   - `Content-Encoding` header rejected — we require the raw CAR bytes so
 *     content-address verification works; any transparent-compression would
 *     break `sha256(body) == cidMultihash`. This closes D7.
 *   - D6 byte cap: stream reading aborts if the accumulated byte count
 *     exceeds `MAX_CAR_BYTES` (100 MiB). The `Content-Length` pre-check is
 *     a cheap fail-fast; the streaming guard is the authority.
 *   - Range resume: on stall or partial read, the fetcher issues an HTTP
 *     Range request for the unread tail and splices the result. Only
 *     applied when the server advertises `Accept-Ranges: bytes`.
 *
 * Does NOT perform content-address verification — that stays in the caller
 * (use `verifyCidMatchesBytes` from `profile/ipfs-client.ts`). Keeping the
 * two concerns separate lets the caller handle content-mismatch distinctly
 * from transient network failure.
 */

import {
  MAX_CAR_BYTES,
  MAX_CAR_FETCH_INITIAL_RESPONSE_MS,
  MAX_CAR_FETCH_STALL_MS,
  MAX_CAR_FETCH_TOTAL_MS,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CarFetchOptions {
  /** Max time to receive response headers. Default MAX_CAR_FETCH_INITIAL_RESPONSE_MS. */
  readonly initialResponseMs?: number;
  /** Max interval between received body bytes. Default MAX_CAR_FETCH_STALL_MS. */
  readonly stallMs?: number;
  /** Total wall-clock cap including resumes. Default MAX_CAR_FETCH_TOTAL_MS. */
  readonly totalMs?: number;
  /** Max accepted body size. Default MAX_CAR_BYTES. */
  readonly maxBytes?: number;
  /** Whether to attempt HTTP Range resume on stall. Default true. */
  readonly allowRangeResume?: boolean;
}

export type CarFetchFailure =
  | 'initial_response_timeout'
  | 'stall_timeout'
  | 'total_timeout'
  | 'byte_cap_exceeded'
  | 'content_encoding_rejected'
  | 'http_error'
  | 'network_error';

export type CarFetchOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly kind: CarFetchFailure; readonly detail: string };

// ── Helpers ────────────────────────────────────────────────────────────────

function concat(parts: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

interface FetchAttemptResult {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly acceptRanges: boolean;
  readonly contentLength: number | null;
  readonly complete: boolean;
  readonly stalled: boolean;
}

/**
 * Perform a single fetch attempt with the three-tier timeout and streaming
 * byte-cap. Returns partial bytes if a stall occurs mid-stream (caller can
 * splice on Range resume) or the complete body on success.
 */
async function fetchAttempt(
  url: string,
  rangeStart: number,
  maxBytes: number,
  initialResponseMs: number,
  stallMs: number,
  remainingTotalMs: number,
): Promise<FetchAttemptResult> {
  // Compose AbortControllers:
  //   initial-response: aborts if headers don't arrive in initialResponseMs
  //   stall:            re-armed after each chunk; aborts if no chunk in stallMs
  //   total:            aborts if total elapsed exceeds remainingTotalMs
  const controller = new AbortController();
  type AbortReason = 'initial' | 'stall' | 'total' | 'ok';
  const abortState: { reason: AbortReason } = { reason: 'ok' };

  const initialTimer = setTimeout(() => {
    abortState.reason = 'initial';
    controller.abort();
  }, initialResponseMs);
  const totalTimer = setTimeout(() => {
    abortState.reason = 'total';
    controller.abort();
  }, remainingTotalMs);

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortState.reason = 'stall';
      controller.abort();
    }, stallMs);
  };

  const headers: Record<string, string> = {};
  if (rangeStart > 0) {
    headers['Range'] = `bytes=${rangeStart}-`;
  }

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(initialTimer);
    clearTimeout(totalTimer);
    if (abortState.reason === 'initial') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_FETCH_TIMEOUT,
        `CAR fetch initial-response timeout after ${initialResponseMs}ms (${url})`,
      );
    }
    if (abortState.reason === 'total') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_FETCH_TIMEOUT,
        `CAR fetch total timeout after ${remainingTotalMs}ms (${url})`,
      );
    }
    // Treat as underlying transport failure (re-throw as pointer error).
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.NETWORK_ERROR,
      `CAR fetch transport failure: ${String(err)}`,
      undefined,
      { cause: err },
    );
  }
  clearTimeout(initialTimer);

  // Content-Encoding rejection (D7) — any transparent-compression corrupts
  // the content-address relationship between bytes and CID.
  const contentEncoding = response.headers.get('content-encoding');
  if (contentEncoding !== null && contentEncoding.trim() !== '' && contentEncoding.toLowerCase() !== 'identity') {
    clearTimeout(totalTimer);
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CAR_UNEXPECTED_ENCODING,
      `CAR fetch from ${url} returned Content-Encoding="${contentEncoding}"; require raw/identity bytes.`,
    );
  }

  // Content-Length pre-check (optional) — fail fast on huge responses.
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader !== null ? Number.parseInt(contentLengthHeader, 10) : null;
  if (contentLength !== null && Number.isFinite(contentLength) && rangeStart + contentLength > maxBytes) {
    clearTimeout(totalTimer);
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CAR_TOO_LARGE,
      `CAR fetch from ${url} advertises ${contentLength} bytes; combined with offset ${rangeStart} exceeds cap ${maxBytes}.`,
    );
  }

  const acceptRanges = (response.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes');

  if (!response.ok) {
    clearTimeout(totalTimer);
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CAR_UNAVAILABLE,
      `CAR fetch from ${url} returned HTTP ${response.status}: ${response.statusText}`,
      { status: response.status },
    );
  }

  if (response.body === null) {
    clearTimeout(totalTimer);
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.NETWORK_ERROR,
      `CAR fetch from ${url} returned no body.`,
    );
  }

  // Stream body with byte cap and stall timer.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let stalled = false;
  let complete = false;
  armStallTimer();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (value !== undefined) {
        bytesRead += value.byteLength;
        if (rangeStart + bytesRead > maxBytes) {
          throw new AggregatorPointerError(
            AggregatorPointerErrorCode.CAR_TOO_LARGE,
            `CAR fetch from ${url} body exceeded cap ${maxBytes} at ${rangeStart + bytesRead} bytes.`,
          );
        }
        chunks.push(value);
        armStallTimer(); // re-arm after each chunk
      }
    }
  } catch (err) {
    if (abortState.reason === 'stall') {
      stalled = true;
      // Fall through — return partial bytes if any so the caller may retry via Range.
    } else if (abortState.reason === 'total') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_FETCH_TIMEOUT,
        `CAR fetch total timeout after ${remainingTotalMs}ms (${url}, read ${bytesRead} bytes)`,
      );
    } else if (err instanceof AggregatorPointerError) {
      throw err;
    } else {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.NETWORK_ERROR,
        `CAR fetch stream error: ${String(err)}`,
        undefined,
        { cause: err },
      );
    }
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    clearTimeout(totalTimer);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  return {
    status: response.status,
    bytes: concat(chunks, bytesRead),
    acceptRanges,
    contentLength,
    complete,
    stalled,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch a CAR bundle from a single gateway URL with H10 progress-rate budget.
 *
 * On stall, if the server advertises `Accept-Ranges: bytes`, the fetcher
 * issues an HTTP Range request for the unread tail and splices. Up to one
 * resume is attempted per fetch call (keeps logic simple; callers retry the
 * whole function for persistent failures).
 */
export async function fetchCarFromGateway(
  url: string,
  opts: CarFetchOptions = {},
): Promise<CarFetchOutcome> {
  const initialResponseMs = opts.initialResponseMs ?? MAX_CAR_FETCH_INITIAL_RESPONSE_MS;
  const stallMs = opts.stallMs ?? MAX_CAR_FETCH_STALL_MS;
  const totalMs = opts.totalMs ?? MAX_CAR_FETCH_TOTAL_MS;
  const maxBytes = opts.maxBytes ?? MAX_CAR_BYTES;
  const allowRangeResume = opts.allowRangeResume ?? true;

  const startTime = Date.now();
  const remaining = (): number => Math.max(0, totalMs - (Date.now() - startTime));

  let accumulated: Uint8Array[] = [];
  let rangeOffset = 0;
  let attemptedResume = false;

  for (;;) {
    let attempt: FetchAttemptResult;
    try {
      attempt = await fetchAttempt(url, rangeOffset, maxBytes, initialResponseMs, stallMs, remaining());
    } catch (err: unknown) {
      if (err instanceof AggregatorPointerError) {
        switch (err.code) {
          case AggregatorPointerErrorCode.CAR_FETCH_TIMEOUT:
            // Total timeout (or initial-response if first attempt) — report.
            return { ok: false, kind: 'total_timeout', detail: err.message };
          case AggregatorPointerErrorCode.CAR_UNEXPECTED_ENCODING:
            return { ok: false, kind: 'content_encoding_rejected', detail: err.message };
          case AggregatorPointerErrorCode.CAR_TOO_LARGE:
            return { ok: false, kind: 'byte_cap_exceeded', detail: err.message };
          case AggregatorPointerErrorCode.CAR_UNAVAILABLE:
            return { ok: false, kind: 'http_error', detail: err.message };
          case AggregatorPointerErrorCode.NETWORK_ERROR:
            return { ok: false, kind: 'network_error', detail: err.message };
          default:
            return { ok: false, kind: 'network_error', detail: err.message };
        }
      }
      return { ok: false, kind: 'network_error', detail: String(err) };
    }

    if (attempt.complete) {
      if (accumulated.length === 0) {
        // No previous partials — return directly.
        return { ok: true, bytes: attempt.bytes };
      }
      accumulated.push(attempt.bytes);
      const total = accumulated.reduce((s, c) => s + c.byteLength, 0);
      return { ok: true, bytes: concat(accumulated, total) };
    }

    if (attempt.stalled && allowRangeResume && attempt.acceptRanges && !attemptedResume) {
      // Splice: keep what we got, request the tail via Range.
      accumulated.push(attempt.bytes);
      rangeOffset += attempt.bytes.byteLength;
      attemptedResume = true;
      if (remaining() <= 0) {
        return { ok: false, kind: 'total_timeout', detail: `CAR fetch exhausted total budget ${totalMs}ms` };
      }
      continue;
    }

    // Stall without resume possibility, or second stall.
    return { ok: false, kind: 'stall_timeout', detail: `CAR fetch stalled after ${stallMs}ms; url=${url}` };
  }
}
