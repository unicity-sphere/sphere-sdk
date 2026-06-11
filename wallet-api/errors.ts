/**
 * wallet-api/errors.ts — the client's typed error surface (S1).
 *
 * HTTP error mapping follows ARCHITECTURE §16: `{ error: { code, message } }`
 * with 401 auth · 403 ownership/addressee · 404 unknown · 409 conflict
 * (lineage/ownership) · 413 too large · 422 validation · 429 rate-limit/quota.
 */

export type WalletApiErrorCode =
  /** Construction/config problems (bad base URL, missing identity). */
  | 'CONFIG'
  /** The server challenge failed template verification — never signed. */
  | 'CHALLENGE_TEMPLATE'
  /** 401 — session invalid and re-auth also failed. */
  | 'UNAUTHORIZED'
  /** 403 — ownership/addressee check failed. */
  | 'FORBIDDEN'
  /** 404 — unknown resource. */
  | 'NOT_FOUND'
  /** 409 — lineage/ownership conflict (e.g. evidenced-tombstone re-add — §5.3). */
  | 'CONFLICT'
  /** 413 — blob too large. */
  | 'TOO_LARGE'
  /** 422 — validation failure (malformed body, failed §8.2 pipeline). */
  | 'VALIDATION'
  /** 429 — rate limit / quota. */
  | 'RATE_LIMITED'
  /** Transport-level failure (fetch threw, connection refused, …). */
  | 'NETWORK'
  /** The response did not match the §16 contract (parse/shape failure). */
  | 'PROTOCOL'
  /** Any other non-2xx status. */
  | 'SERVER';

const STATUS_TO_CODE: Record<number, WalletApiErrorCode> = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'TOO_LARGE',
  422: 'VALIDATION',
  429: 'RATE_LIMITED',
};

export class WalletApiError extends Error {
  readonly code: WalletApiErrorCode;
  /** HTTP status when the error came from a response. */
  readonly status?: number;

  constructor(message: string, code: WalletApiErrorCode, status?: number, cause?: unknown) {
    super(message);
    this.name = 'WalletApiError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }

  static fromStatus(status: number, message: string): WalletApiError {
    return new WalletApiError(message, STATUS_TO_CODE[status] ?? 'SERVER', status);
  }
}

/**
 * The auth challenge failed template verification (S1): wrong domain prefix,
 * foreign pubkey, or implausible timestamps. The spend key never signs
 * server-chosen text that fails this check.
 */
export class ChallengeTemplateError extends WalletApiError {
  constructor(message: string) {
    super(message, 'CHALLENGE_TEMPLATE');
    this.name = 'ChallengeTemplateError';
  }
}
