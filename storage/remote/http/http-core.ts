/**
 * Shared fetch core for the REAL token-api HTTP clients (Task 8.3, DESIGN §4/§5/§6).
 *
 * Three concerns live here so the per-endpoint clients stay tiny:
 *  - {@link VaultHttpError} — the typed non-2xx error the data/courier clients throw
 *    for anything that is NOT a sanctioned status (so callers never see a raw
 *    `Response`). 401 and 507 are NOT errors at this layer (see below).
 *  - {@link VaultTokenSource} — the seam onto {@link VaultApiClient}: the Bearer JWT
 *    plus the serialized refresh. The real clients attach the CURRENT token per
 *    request and, on a 401, drive exactly ONE refresh and retry (DESIGN §4.3).
 *  - {@link postJson} / {@link getJson} / {@link authedJson} — the fetch wrappers.
 *    `authedJson` runs the attach → 401? → refresh → retry-once cycle; a treat-as-ok
 *    predicate lets the PATCH path accept 507 as a valid {@link PatchResponse} body.
 */

/** A non-2xx (non-sanctioned) response from the vault — carries the status + body text. */
export class VaultHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodyText: string,
  ) {
    super(`vault http ${status} on ${path}: ${bodyText.slice(0, 200)}`);
    this.name = 'VaultHttpError';
  }
}

/**
 * The auth seam the authenticated clients read: the live JWT plus the serialized
 * refresh. {@link VaultApiClient} satisfies this structurally (its `token` getter
 * and `refresh()`), so the real client never re-implements refresh bookkeeping.
 */
export interface VaultTokenSource {
  /** The current JWT, or `null` until `authenticate()` has run. */
  readonly token: string | null;
  /** Rotate the JWT (serialized; concurrent callers share one in-flight promise). */
  refresh(): Promise<string>;
}

/** The `fetch` implementation — injectable so tests can pass a custom one if needed. */
export type FetchLike = typeof fetch;

/**
 * Default per-request deadline (ms). Without a client-side timeout a stalled or
 * half-open server (accepts the socket, never writes a response) would hang the
 * wallet's flush/auth forever; this bounds every vault/courier round trip.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Synthetic status for an error that never reached an HTTP response (timeout/refused). */
const TRANSPORT_ERROR_STATUS = 0;

/**
 * Wrap a `fetch` so every request is bounded by `timeoutMs` (an `AbortController`
 * deadline) AND any transport failure is surfaced as a typed {@link VaultHttpError}
 * — so a stalled server, a connection-refused, or a DNS/socket error REJECTS with a
 * catchable error (status `0`) instead of hanging or leaking a raw `TypeError`.
 * `0`/negative `timeoutMs` disables the deadline (no AbortController).
 */
export function withTimeout(fetchImpl: FetchLike, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(input, controller ? { ...init, signal: controller.signal } : init);
    } catch (err) {
      throw transportError(input, err, controller?.signal.aborted ?? false, timeoutMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** Map an aborted/refused/socket fetch rejection to a typed VaultHttpError. */
function transportError(input: RequestInfo | URL, err: unknown, aborted: boolean, timeoutMs: number): VaultHttpError {
  const path = String(input);
  if (aborted) return new VaultHttpError(TRANSPORT_ERROR_STATUS, path, `request timed out after ${timeoutMs}ms`);
  const reason = err instanceof Error ? err.message : String(err);
  return new VaultHttpError(TRANSPORT_ERROR_STATUS, path, `transport error: ${reason}`);
}

/** Build `{vaultUrl}{path}` with the base's trailing slash collapsed. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** Bearer header for a token (empty when unauthenticated — the server then 401s). */
function bearer(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Parse a JSON body, throwing a typed error if it is not valid JSON. */
async function parseJson<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new VaultHttpError(res.status, path, `non-JSON body: ${text.slice(0, 120)}`);
  }
}

/** UNAUTHENTICATED `POST {base}{path}` with a JSON body; 2xx → parsed JSON. */
export async function postJson<T>(
  fetchImpl: FetchLike,
  base: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetchImpl(joinUrl(base, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new VaultHttpError(res.status, path, await res.text());
  return parseJson<T>(res, path);
}

/** Options for one authenticated request (after the Bearer + refresh cycle). */
export interface AuthedRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /** JSON body for write methods; omitted for GET. */
  body?: unknown;
  /**
   * Status codes whose BODY is still a valid response to parse (never thrown). The
   * PATCH path passes `[507]` so a storage-watermark 507 returns its PatchResponse.
   */
  okStatuses?: number[];
}

/** True when a status is 2xx or in the caller's treat-as-ok set (e.g. 507 for PATCH). */
function isOk(status: number, okStatuses?: number[]): boolean {
  return (status >= 200 && status < 300) || (okStatuses?.includes(status) ?? false);
}

/**
 * One authenticated round trip with the 401→refresh→retry-once cycle (DESIGN §4.3).
 * Attaches the current Bearer JWT; on a 401 it drives ONE serialized refresh and
 * retries; any other non-ok status throws {@link VaultHttpError}. A status in
 * `okStatuses` (e.g. 507) is parsed as a normal body, never thrown.
 */
export async function authedJson<T>(
  fetchImpl: FetchLike,
  base: string,
  auth: VaultTokenSource,
  req: AuthedRequest,
): Promise<T> {
  const first = await sendAuthed(fetchImpl, base, auth.token, req);
  if (first.status !== 401) return finishAuthed<T>(first, req);
  // 401 → rotate the JWT exactly once and retry with the fresh token.
  await auth.refresh();
  const retry = await sendAuthed(fetchImpl, base, auth.token, req);
  return finishAuthed<T>(retry, req);
}

/** Issue one authenticated fetch with the given token attached. */
function sendAuthed(
  fetchImpl: FetchLike,
  base: string,
  token: string | null,
  req: AuthedRequest,
): Promise<Response> {
  const headers: Record<string, string> = { ...bearer(token) };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  return fetchImpl(joinUrl(base, req.path), {
    method: req.method,
    headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
}

/** Map a settled response to parsed JSON, throwing on a non-ok (non-sanctioned) status. */
async function finishAuthed<T>(res: Response, req: AuthedRequest): Promise<T> {
  if (!isOk(res.status, req.okStatuses)) {
    throw new VaultHttpError(res.status, req.path, await res.text());
  }
  return parseJson<T>(res, req.path);
}
