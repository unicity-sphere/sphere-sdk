/**
 * Error / reason string sanitization for log + event payloads.
 *
 * Steelman warning closure (FIX 3): aggregator-supplied error strings flow
 * into thrown `SphereError` messages and emitted event payloads. A hostile
 * aggregator can plant:
 *
 *   - Newlines / control chars (`\x00-\x1F\x7F`) — log-record splitting
 *     attacks against syslog / journald / cloud log shippers.
 *   - HTML markup (`<`, `>`, `&`) — stored XSS in operator dashboards
 *     that naively render error.message as HTML.
 *   - Multi-megabyte payloads — log flood / disk pressure.
 *
 * `sanitizeReasonString` defends against all three by:
 *
 *   1. Stripping control chars (`\x00-\x1F\x7F-\x9F`) so a hostile reason
 *      cannot inject newlines or NUL bytes into a log record.
 *   2. Stripping HTML markup characters (`<`, `>`, `&`) so a naive
 *      HTML-rendering dashboard cannot interpret the payload as markup.
 *   3. Truncating to a configurable cap (default 200 chars) with a `…`
 *      marker so failureReasons / event payloads stay log-friendly.
 *
 * **Diagnostic strings, NOT HTML-safe.** Even after sanitization the
 * resulting strings are PLAIN TEXT — consumers MUST still escape via the
 * host dashboard's standard HTML-escape pipeline before rendering. This
 * module is defense-in-depth (catching naive renderers), not a license
 * to skip standard escaping.
 *
 * Hoisted from `modules/payments/transfer/cid-fetcher.ts` so all
 * aggregator-facing code paths share a single sanitizer.
 *
 * @packageDocumentation
 */

/**
 * Default truncation cap. Most aggregator error strings are well under
 * 200 chars; a hostile counter-party can plant a multi-MB body that we
 * MUST trim before logging.
 */
export const DEFAULT_MAX_REASON_LENGTH = 200;

/**
 * Sanitize an aggregator- or remote-supplied reason string for safe
 * inclusion in a log record, a thrown `SphereError` message, or an
 * emitted event payload.
 *
 * @param raw   The untrusted input string.
 * @param cap   Optional truncation cap; defaults to
 *              {@link DEFAULT_MAX_REASON_LENGTH}.
 * @returns     The sanitized + (possibly) truncated string.
 */
export function sanitizeReasonString(
  raw: string,
  cap: number = DEFAULT_MAX_REASON_LENGTH,
): string {
  // Drop control characters and HTML markup characters in a single pass.
  // We use literal-range replacement (rather than Unicode property escapes)
  // so the regex stays portable across Node 18+ and the browser runtimes
  // we support.
  const stripped = raw.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1F\x7F-\x9F<>&]/g,
    '',
  );
  if (stripped.length <= cap) return stripped;
  // Reserve 1 char for the truncation marker `…`.
  return `${stripped.slice(0, cap - 1)}…`;
}

/**
 * Render any error-like value into a sanitized reason string suitable
 * for logging or surfacing into an event payload.
 *
 * Behavior:
 *   - `Error` instances → use `err.message` (or `err.name` if message
 *     is falsy). The Error itself is NOT walked through W40 redaction
 *     here; callers that need redaction should pass the Error through
 *     {@link import('./errors').redactCause} first.
 *   - Strings → used verbatim.
 *   - Anything else → `JSON.stringify` (with a `String(err)` fallback
 *     if stringify throws — e.g. a circular structure).
 *
 * The result is always sanitized via {@link sanitizeReasonString}.
 */
export function sanitizeError(err: unknown, cap?: number): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message || err.name;
  } else if (typeof err === 'string') {
    raw = err;
  } else {
    try {
      raw = JSON.stringify(err);
    } catch {
      raw = String(err);
    }
  }
  return sanitizeReasonString(raw, cap);
}
