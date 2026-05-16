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
 * **Code-point-aware truncation (Round 5 fix).** JavaScript strings are
 * UTF-16. A naive `slice(0, cap-1)` may land inside a surrogate pair —
 * a hostile aggregator can craft a string padded with emoji (each one
 * a UTF-16 surrogate pair) so the slice boundary lands on a high
 * surrogate, leaving an unpaired surrogate that breaks downstream
 * `JSON.stringify` / `Buffer.from('utf8')` / log shippers. We use
 * `Array.from(str)` which iterates by Unicode code point, so the cap
 * is enforced on code points (not UTF-16 code units) and the boundary
 * never lands mid-pair.
 *
 * @param raw   The untrusted input string.
 * @param cap   Optional truncation cap (in CODE POINTS); defaults to
 *              {@link DEFAULT_MAX_REASON_LENGTH}.
 * @returns     The sanitized + (possibly) truncated string.
 */
export function sanitizeReasonString(
  raw: string,
  cap: number = DEFAULT_MAX_REASON_LENGTH,
): string {
  // Round 7 fix (MED NEW): pre-truncate hostile oversized input BEFORE
  // running `replace` + `Array.from`. A 10MB hostile string would
  // otherwise allocate an O(input.length) intermediate (the
  // `replace`-stripped copy AND the code-point array) before the
  // final cap is applied. Pre-truncating to `cap * 8` UTF-16 code
  // units bounds memory while still leaving headroom for the
  // surrogate-pair-padded worst case (up to ~2 code units per code
  // point) plus a safety margin so the post-strip code-point count
  // can still saturate the cap.
  let bounded = raw;
  if (bounded.length > cap * 8) {
    bounded = bounded.slice(0, cap * 8);
  }
  // Drop control characters and HTML markup characters in a single pass.
  // We use literal-range replacement (rather than Unicode property escapes)
  // so the regex stays portable across Node 18+ and the browser runtimes
  // we support.
  let stripped = bounded.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1F\x7F-\x9F<>&]/g,
    '',
  );
  // Round 7 fix (LOW NEW — defense-in-depth): strip LONE surrogate
  // code units (a high surrogate not followed by a low surrogate, or
  // a low surrogate not preceded by a high surrogate). Valid surrogate
  // PAIRS — which encode astral code points like emoji — are
  // preserved. After the UTF-16 pre-truncation above, the boundary
  // may have severed a pair, leaving an unpaired surrogate that
  // breaks downstream `JSON.stringify` / `Buffer.from('utf8')` / log
  // shippers (which reject or replace unpaired surrogates
  // inconsistently). The naive `[\uD800-\uDFFF]` class would also
  // destroy valid emoji, so we use lookbehind/lookahead to match only
  // the orphans. Two passes — high-surrogate-not-followed-by-low,
  // then low-surrogate-not-preceded-by-high.
  stripped = stripped.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '');
  stripped = stripped.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  // Iterate by Unicode code point (not UTF-16 code unit) so the cap
  // boundary never lands inside a surrogate pair. `Array.from(str)`
  // uses the string iterator, which yields one element per code point.
  const codePoints = Array.from(stripped);
  if (codePoints.length <= cap) return stripped;
  // Reserve 1 code point for the truncation marker `…`.
  return `${codePoints.slice(0, cap - 1).join('')}…`;
}

/**
 * Sentinel emitted when a hostile Error subclass exposes a throwing
 * getter for `.message` / `.name`. Returned in lieu of letting the throw
 * propagate out of the sanitizer (which would crash callers that
 * already caught a child error and only meant to log it).
 */
const REDACTED_GETTER_THREW = '[REDACTED: getter-threw]';

/**
 * Read `err.message` defensively. Round 5 fix: a hostile `Error`
 * subclass — or a `Proxy` impersonating an Error — can install a
 * throwing getter on `.message` (or `.name`) so any naïve catch handler
 * that calls `err.message` re-throws AGAIN, propagating out of the
 * caller's catch and bypassing sanitization. We wrap the read in
 * try/catch and substitute a sentinel on throw.
 *
 * Centralized helper so every catch site uses the SAME defensive
 * pattern. Replaces the bare `err instanceof Error ? err.message :
 * String(err)` idiom across the codebase.
 *
 * Note: this returns the RAW (unsanitized) message string. Callers that
 * splice the result into a thrown `SphereError` message or an emitted
 * event payload SHOULD additionally pipe through
 * {@link sanitizeReasonString} so control chars / HTML / oversize
 * payloads are scrubbed. {@link sanitizeError} below does both in one
 * call when a sanitized result is needed.
 */
export function safeErrorMessage(err: unknown): string {
  // Round 7 fix (MED GAP): wrap the `instanceof Error` check itself in
  // try/catch. A hostile `Proxy` whose `getPrototypeOf` trap throws
  // makes `err instanceof Error` re-throw out of this helper —
  // bypassing every downstream sanitizer. core/errors.ts:697-703
  // already wraps this idiom; this site was inconsistent. On throw,
  // treat the value as non-Error and fall through to the
  // String-conversion branch.
  let isError = false;
  try {
    isError = err instanceof Error;
  } catch {
    isError = false;
  }
  if (isError) {
    const errAsErr = err as Error;
    let message: unknown;
    try {
      message = errAsErr.message;
    } catch {
      return REDACTED_GETTER_THREW;
    }
    if (typeof message === 'string' && message.length > 0) return message;
    let name: unknown;
    try {
      name = errAsErr.name;
    } catch {
      return REDACTED_GETTER_THREW;
    }
    if (typeof name === 'string' && name.length > 0) return name;
    return REDACTED_GETTER_THREW;
  }
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return REDACTED_GETTER_THREW;
  }
}

/**
 * Render any error-like value into a sanitized reason string suitable
 * for logging or surfacing into an event payload.
 *
 * Behavior:
 *   - `Error` instances → use `err.message` (or `err.name` if message
 *     is falsy), via the {@link safeErrorMessage} helper which guards
 *     against throwing getters. The Error itself is NOT walked through
 *     W40 redaction here; callers that need redaction should pass the
 *     Error through {@link import('./errors').redactCause} first.
 *   - Strings → used verbatim.
 *   - Anything else → `JSON.stringify` (with a `String(err)` fallback
 *     if stringify throws — e.g. a circular structure).
 *
 * The result is always sanitized via {@link sanitizeReasonString}.
 */
export function sanitizeError(err: unknown, cap?: number): string {
  let raw: string;
  // Round 7 fix (MED GAP): same Proxy-getPrototypeOf-throws defense as
  // safeErrorMessage above. Wrap the `instanceof Error` check so a
  // hostile Proxy cannot throw OUT of the sanitizer. On throw, fall
  // through into safeErrorMessage's defended path (which itself
  // tries instanceof, then degrades).
  let isError = false;
  try {
    isError = err instanceof Error;
  } catch {
    isError = false;
  }
  if (isError) {
    raw = safeErrorMessage(err);
  } else if (typeof err === 'string') {
    raw = err;
  } else {
    try {
      raw = JSON.stringify(err);
    } catch {
      try {
        raw = String(err);
      } catch {
        raw = REDACTED_GETTER_THREW;
      }
    }
  }
  return sanitizeReasonString(raw, cap);
}
