// §5.1 http plumbing: fetch wrapper, https rule, typed error envelope.

export interface HttpResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface HttpRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

export class WalletApiHttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Milliseconds, parsed from a Retry-After header when present. */
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = 'WalletApiHttpError';
    this.status = status;
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** Asking again may work; escalating will not. 0 is fetchRaw's NETWORK wrapper. */
const RETRYABLE_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(err: unknown): boolean {
  return err instanceof WalletApiHttpError && RETRYABLE_STATUSES.has(err.status);
}

export function isWalletApiHttpError(err: unknown, status?: number): err is WalletApiHttpError {
  return err instanceof WalletApiHttpError && (status === undefined || err.status === status);
}

export interface WalletApiHttpConfig {
  baseUrl: string;
  fetchFn: FetchLike;
  /** Bearer source; `null` sends the request unauthenticated. */
  getToken: () => string | null;
}

export interface RequestOptions {
  /** Default true; auth endpoints opt out so a stale bearer is never attached. */
  auth?: boolean;
}

export interface WalletApiHttp {
  readonly baseUrl: string;
  request(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<unknown>;
  /** Direct fetch for presigned S3 URLs — no base URL, no bearer. */
  fetchRaw(url: string, init: HttpRequestInit): Promise<HttpResponseLike>;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/** ARCHITECTURE §4 transport rule: non-loopback MUST be https. Returns the URL without a trailing slash. */
export function assertSecureBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid wallet-api base URL: ${baseUrl}`);
  }
  const httpLoopback = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !httpLoopback) {
    throw new Error('wallet-api base URL must be https (plain http is allowed only on loopback)');
  }
  return url.toString().replace(/\/$/, '');
}

function parseRetryAfter(res: HttpResponseLike): number | undefined {
  const raw = res.headers?.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

async function readBodyText(res: HttpResponseLike): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Parse the `{ error: { code, message } }` envelope into the typed error. */
async function toHttpError(res: HttpResponseLike, what: string): Promise<WalletApiHttpError> {
  let code = `HTTP_${res.status}`;
  let message = `${what} failed with status ${res.status}`;
  const text = await readBodyText(res);
  if (text !== '') {
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed?.error?.code) code = parsed.error.code;
      if (parsed?.error?.message) message = `${what}: ${parsed.error.message}`;
    } catch {
      // non-JSON error body — keep the generic message
    }
  }
  return new WalletApiHttpError(res.status, code, message, parseRetryAfter(res));
}

function parseJsonBody(text: string, what: string, status: number): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiHttpError(status, 'PROTOCOL', `${what}: response is not JSON`);
  }
}

export function createWalletApiHttp(config: WalletApiHttpConfig): WalletApiHttp {
  const baseUrl = assertSecureBaseUrl(config.baseUrl);
  const { fetchFn, getToken } = config;

  const fetchRaw = async (url: string, init: HttpRequestInit): Promise<HttpResponseLike> => {
    try {
      return await fetchFn(url, init);
    } catch (err) {
      throw new WalletApiHttpError(
        0,
        'NETWORK',
        `wallet-api request failed: ${init.method} ${url}: ${String(err)}`
      );
    }
  };

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions
  ): Promise<unknown> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts?.auth !== false) {
      const token = getToken();
      if (token !== null) headers['authorization'] = `Bearer ${token}`;
    }
    const res = await fetchRaw(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const what = `${method} ${path}`;
    if (res.status === 204) return null;
    if (!res.ok) throw await toHttpError(res, what);
    return parseJsonBody(await readBodyText(res), what, res.status);
  };

  return { baseUrl, request, fetchRaw };
}
