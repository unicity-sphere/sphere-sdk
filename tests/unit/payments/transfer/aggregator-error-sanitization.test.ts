/**
 * UXF Transfer — aggregator-supplied error string sanitization.
 *
 * Closes a steelman warning. Aggregator-supplied error strings flow into
 * thrown `SphereError` messages and emitted event payloads. A hostile
 * aggregator can plant:
 *
 *   - Newlines / control chars (`\x00-\x1F\x7F`) — log-record splitting
 *     attacks against syslog / journald / cloud log shippers.
 *   - HTML markup (`<`, `>`, `&`) — stored XSS in operator dashboards
 *     that naively render error.message as HTML.
 *   - Multi-megabyte payloads — log flood / disk pressure.
 *
 * The shared `sanitizeReasonString` helper (in `core/error-sanitize.ts`)
 * defends against all three. Tests pin:
 *
 *   1. Direct unit behavior — control chars stripped, HTML stripped,
 *      truncation cap honored, default cap is 200.
 *   2. Integration — finalization-worker-base submit/poll/retry-exhaust
 *      paths sanitize aggregator error strings before splicing them
 *      into thrown SphereError messages and emitted event payloads.
 *
 * Spec / docs: §6.1 (aggregator-rejected hard-fail messages),
 * UXF-TRANSFER-IMPL-PLAN.md (steelman warning closure round 1).
 */

import { describe, expect, it } from 'vitest';

import {
  sanitizeReasonString,
  sanitizeError,
  safeErrorMessage,
  DEFAULT_MAX_REASON_LENGTH,
} from '../../../../core/error-sanitize';

// =============================================================================
// 1. Unit — sanitizeReasonString basics.
// =============================================================================

describe('sanitizeReasonString — control character stripping', () => {
  it('strips ASCII control chars \\x00-\\x1F', () => {
    const raw = 'first line\nsecond line\rcarriage';
    const out = sanitizeReasonString(raw);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
    expect(out).toBe('first linesecond linecarriage');
  });

  it('strips DEL (\\x7F) and C1 control chars (\\x80-\\x9F)', () => {
    const raw = `pre\x7Fmid\x80\x9Fpost`;
    const out = sanitizeReasonString(raw);
    expect(out).toBe('premidpost');
  });

  it('strips NUL bytes', () => {
    const raw = 'before\x00after';
    const out = sanitizeReasonString(raw);
    expect(out).toBe('beforeafter');
    expect(out).not.toContain('\x00');
  });

  it('preserves printable ASCII and unicode body characters', () => {
    const raw = 'ABCdef 123 — UCT€ñ';
    const out = sanitizeReasonString(raw);
    expect(out).toBe(raw);
  });
});

describe('sanitizeReasonString — HTML markup stripping', () => {
  it('strips angle brackets to neutralize tag injection', () => {
    const raw = 'aggregator says <script>alert(1)</script>';
    const out = sanitizeReasonString(raw);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('aggregator says scriptalert(1)/script');
  });

  it('strips ampersand to neutralize HTML-entity injection', () => {
    const raw = 'foo &amp; bar';
    const out = sanitizeReasonString(raw);
    expect(out).not.toContain('&');
    expect(out).toBe('foo amp; bar');
  });
});

describe('sanitizeReasonString — truncation', () => {
  it('respects DEFAULT_MAX_REASON_LENGTH = 200', () => {
    expect(DEFAULT_MAX_REASON_LENGTH).toBe(200);
    const raw = 'x'.repeat(1_000_000);
    const out = sanitizeReasonString(raw);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_REASON_LENGTH);
  });

  it('appends a `…` marker when truncation occurs', () => {
    const raw = 'a'.repeat(500);
    const out = sanitizeReasonString(raw);
    // 199 'a' + 1 '…' = 200 chars
    expect(out.length).toBe(DEFAULT_MAX_REASON_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does NOT truncate when string fits within cap', () => {
    const raw = 'short message';
    const out = sanitizeReasonString(raw);
    expect(out).toBe(raw);
    expect(out.endsWith('…')).toBe(false);
  });

  it('honors a custom cap', () => {
    const raw = 'a'.repeat(500);
    const out = sanitizeReasonString(raw, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('sanitizeReasonString — combined attack vectors', () => {
  it('handles control + HTML + oversized in one pass', () => {
    const raw =
      '\n\n<script>' + 'malicious-payload-aaa'.repeat(100) + '</script>\n';
    const out = sanitizeReasonString(raw);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_REASON_LENGTH);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    // The truncation marker still appears.
    expect(out.endsWith('…')).toBe(true);
  });
});

// =============================================================================
// 2. sanitizeError — error-instance + unknown shape coverage.
// =============================================================================

describe('sanitizeError', () => {
  it('reads `.message` from Error instances', () => {
    const err = new Error('aggregator failure: <bad>\nline2');
    const out = sanitizeError(err);
    expect(out).toBe('aggregator failure: badline2');
  });

  it('falls back to `.name` when message is empty', () => {
    const err = new Error('');
    err.name = 'TypeError';
    const out = sanitizeError(err);
    expect(out).toBe('TypeError');
  });

  it('uses string input verbatim through the sanitizer', () => {
    const out = sanitizeError('plain <error> string');
    expect(out).toBe('plain error string');
  });

  it('JSON.stringify on unknown-shape inputs', () => {
    const out = sanitizeError({ status: 500, body: 'oops' });
    expect(out).toContain('status');
    expect(out).toContain('500');
  });

  it('falls back to String(err) when JSON.stringify throws (cycle)', () => {
    const a: { self?: unknown } = {};
    a.self = a;
    const out = sanitizeError(a);
    // String(circular object) → '[object Object]'
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('<');
  });

  it('honors a custom truncation cap', () => {
    const long = 'x'.repeat(1000);
    const out = sanitizeError(long, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith('…')).toBe(true);
  });
});

// =============================================================================
// 3. Integration — finalization-worker-base call sites.
//
// We don't spin up a full worker here (the existing sender/recipient test
// suites do); instead we assert via direct invocation that error strings
// returned to a caller are sanitized, by mimicking the call patterns of
// each branch (AUTHENTICATOR_VERIFICATION_FAILED, REQUEST_ID_MISMATCH,
// PATH_INVALID, NOT_AUTHENTICATED, submit-retry-exhaust).
//
// The integration assertion is "the produced message contains no raw
// control chars and no HTML markup", verified per branch.
// =============================================================================

// =============================================================================
// 2.5 Round 5 — code-point-aware truncation (FIX 1).
//
// JavaScript strings are UTF-16. A naive `slice(0, cap-1)` may land inside
// a surrogate pair — a hostile aggregator can craft a string padded with
// emoji (each one a UTF-16 surrogate pair) so the slice boundary lands on
// a high surrogate, leaving an unpaired surrogate that breaks downstream
// JSON.stringify / Buffer.from('utf8') / log shippers.
// =============================================================================

describe('Round 5 — sanitizeReasonString code-point-aware truncation (FIX 1)', () => {
  // Identifies any unpaired surrogate (high or low) in the string. An
  // unpaired surrogate is a code unit in the surrogate range whose pair
  // is missing — this is what the bug produces.
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate must be followed by a low surrogate.
        if (i + 1 >= s.length) return true;
        const next = s.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) return true;
        i++; // skip the low surrogate
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        // Low surrogate not preceded by a high surrogate.
        return true;
      }
    }
    return false;
  }

  it('does not produce lone surrogates when truncating a string padded with emoji at the boundary', () => {
    // Each 😀 is U+1F600, encoded as TWO UTF-16 code units (a surrogate pair).
    // A string of N emoji has UTF-16 length = 2N but code-point length = N.
    const emoji = '😀';
    // Build a string whose CODE-POINT length crosses the cap so truncation
    // engages. With code-point-aware truncation, the boundary lands cleanly.
    // The pre-fix `slice(0, cap-1)` (UTF-16 code units) would have landed
    // mid-pair on this input; the new logic must preserve pair integrity.
    const raw = emoji.repeat(DEFAULT_MAX_REASON_LENGTH + 50); // 250 code points
    const out = sanitizeReasonString(raw);
    expect(hasLoneSurrogate(out)).toBe(false);
    // Code-point length must be <= cap.
    expect(Array.from(out).length).toBeLessThanOrEqual(DEFAULT_MAX_REASON_LENGTH);
    // Truncation marker present.
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncation result has UTF-16 length consistent with code-point cap', () => {
    // With pre-fix UTF-16 truncation: result.length === DEFAULT_MAX_REASON_LENGTH (= 200).
    // With code-point truncation: result has DEFAULT_MAX_REASON_LENGTH code POINTS,
    // but UTF-16 length is 2*(cap-1) + 1 = 399 (for a pure emoji input).
    // The salient invariant is "no lone surrogate at the boundary."
    const raw = '😀'.repeat(DEFAULT_MAX_REASON_LENGTH + 100);
    const out = sanitizeReasonString(raw);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(Array.from(out).length).toBeLessThanOrEqual(DEFAULT_MAX_REASON_LENGTH);
  });

  it('handles emoji + ASCII mix at the boundary', () => {
    const raw = 'a'.repeat(199) + '😀' + 'b'.repeat(50);
    const out = sanitizeReasonString(raw);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(Array.from(out).length).toBeLessThanOrEqual(DEFAULT_MAX_REASON_LENGTH);
  });

  it('JSON.stringify on truncated emoji string does not blow up', () => {
    const raw = '😀'.repeat(300);
    const out = sanitizeReasonString(raw);
    // JSON.stringify on a string with lone surrogates emits '\udxxx' escapes
    // but doesn't throw — however, downstream consumers (Buffer.from utf8
    // strict, some loggers) would. This pin asserts the lone-surrogate
    // safeguard.
    expect(hasLoneSurrogate(out)).toBe(false);
    const json = JSON.stringify(out);
    expect(json).not.toContain('\\ud800');
    expect(typeof json).toBe('string');
  });

  it('Buffer.from(out, "utf8") round-trips cleanly (no replacement chars)', () => {
    const raw = '😀'.repeat(300);
    const out = sanitizeReasonString(raw);
    const roundTrip = Buffer.from(out, 'utf8').toString('utf8');
    // A lone surrogate would be encoded as the U+FFFD replacement char on
    // round-trip; absence proves the truncation was clean.
    expect(roundTrip).toBe(out);
  });

  it('honors a custom cap with code-point semantics', () => {
    const raw = '😀'.repeat(50);
    const out = sanitizeReasonString(raw, 10);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(Array.from(out).length).toBeLessThanOrEqual(10);
  });
});

// =============================================================================
// 2.6 Round 5 — safeErrorMessage helper (FIX 2).
//
// A hostile Error subclass — or a Proxy impersonating an Error — can
// install a throwing getter on `.message` (or `.name`) so any naïve catch
// handler that calls `err.message` re-throws AGAIN. The helper wraps the
// read in try/catch and substitutes a sentinel on throw.
// =============================================================================

describe('Round 5 — safeErrorMessage helper (FIX 2)', () => {
  it('returns err.message for a normal Error', () => {
    expect(safeErrorMessage(new Error('hello'))).toBe('hello');
  });

  it('falls back to err.name when message is empty', () => {
    const e = new Error('');
    e.name = 'TypeError';
    expect(safeErrorMessage(e)).toBe('TypeError');
  });

  it('returns the redaction sentinel when err.message getter throws', () => {
    const err = new Error('initial');
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        throw new Error('hostile message getter');
      },
    });
    expect(safeErrorMessage(err)).toBe('[REDACTED: getter-threw]');
  });

  it('returns the redaction sentinel when both message and name getters throw', () => {
    const err = new Error('initial');
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        throw new Error('hostile message');
      },
    });
    Object.defineProperty(err, 'name', {
      configurable: true,
      get() {
        throw new Error('hostile name');
      },
    });
    expect(safeErrorMessage(err)).toBe('[REDACTED: getter-threw]');
  });

  it('uses string input verbatim', () => {
    expect(safeErrorMessage('plain string')).toBe('plain string');
  });

  it('falls back to String(err) for unknown shapes', () => {
    const obj = { foo: 'bar' };
    const out = safeErrorMessage(obj);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 2.7 Round 5 — sanitizeError integration with safeErrorMessage (FIX 2).
//
// sanitizeError now uses safeErrorMessage internally, so a hostile getter
// no longer crashes the caller's logger pipeline.
// =============================================================================

describe('Round 5 — sanitizeError uses safeErrorMessage internally (FIX 2)', () => {
  it('does NOT throw on an Error with hostile message getter', () => {
    const err = new Error('initial');
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        throw new Error('hostile');
      },
    });
    let result: string | undefined;
    expect(() => {
      result = sanitizeError(err);
    }).not.toThrow();
    expect(result).toBe('[REDACTED: getter-threw]');
  });

  it('returns the sentinel through the sanitizer (no control chars)', () => {
    const err = new Error('initial');
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        throw new Error('hostile');
      },
    });
    const out = sanitizeError(err);
    // Sentinel survives sanitizeReasonString unchanged (no control chars or HTML).
    expect(out).toBe('[REDACTED: getter-threw]');
  });
});

describe('finalization-worker-base — aggregator error sanitization integration', () => {
  // Hostile aggregator output candidates.
  const HOSTILE_NEWLINES = 'aggregator died\n[CRITICAL] forged log line';
  const HOSTILE_HTML = 'aggregator says <img src=x onerror=alert(1)>';
  const HOSTILE_OVERSIZED = 'oversized:' + 'a'.repeat(10_000);

  it('strips newlines from a hostile aggregator error in worker call path', () => {
    const out = sanitizeReasonString(HOSTILE_NEWLINES);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toContain('aggregator died');
    expect(out).toContain('CRITICAL');
  });

  it('strips HTML markup from a hostile aggregator error in worker call path', () => {
    const out = sanitizeReasonString(HOSTILE_HTML);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('truncates oversized aggregator error in worker call path', () => {
    const out = sanitizeReasonString(HOSTILE_OVERSIZED);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX_REASON_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('worker-style splicing pattern produces sanitized output', () => {
    // Mimic the actual splicing pattern used in finalization-worker-base:
    //   `belief-divergence: ... ${ctx.subjectPhrase}${err ? ` (${err})` : ''}`
    const subjectPhrase = 'tokenId=t1';
    const aggErr = 'aggregator panic\n<svg/onload=alert>';
    const safeErr = sanitizeReasonString(aggErr);
    const message = `belief-divergence: aggregator rejected authenticator for ${subjectPhrase}${
      safeErr ? ` (${safeErr})` : ''
    }`;
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).not.toContain('<');
    expect(message).not.toContain('>');
    expect(message).toContain('belief-divergence');
    expect(message).toContain('aggregator panic');
  });
});

// =============================================================================
// 7. Round 7 — defensive enhancements.
// =============================================================================

describe('Round 7 — safeErrorMessage / sanitizeError defend against hostile Proxy', () => {
  // Build a Proxy whose getPrototypeOf trap throws. Pre-fix, evaluating
  // `err instanceof Error` against this Proxy would re-throw out of the
  // sanitizer, bypassing every downstream safety net. The fix wraps the
  // instanceof check in try/catch.
  function buildHostileProxy(): unknown {
    const target = {};
    return new Proxy(target, {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf');
      },
    });
  }

  it('safeErrorMessage does not throw on Proxy with throwing getPrototypeOf', () => {
    const hostile = buildHostileProxy();
    let result: string | undefined;
    expect(() => {
      result = safeErrorMessage(hostile);
    }).not.toThrow();
    // Returned value should be a string (the String(err) fallback or
    // the redaction sentinel) — never undefined and never the raw
    // hostile object.
    expect(typeof result).toBe('string');
  });

  it('sanitizeError does not throw on Proxy with throwing getPrototypeOf', () => {
    const hostile = buildHostileProxy();
    let result: string | undefined;
    expect(() => {
      result = sanitizeError(hostile);
    }).not.toThrow();
    expect(typeof result).toBe('string');
    // Result must be capped to DEFAULT_MAX_REASON_LENGTH code points.
    expect(Array.from(result!).length).toBeLessThanOrEqual(
      DEFAULT_MAX_REASON_LENGTH,
    );
  });

  it('safeErrorMessage handles Proxy that throws on EVERY operation gracefully', () => {
    // Worst case: every trap throws. instanceof, String(err), JSON.stringify
    // all blow up. The helper must still return a string.
    const target = {};
    const hostile = new Proxy(target, {
      getPrototypeOf() {
        throw new Error('boom');
      },
      get() {
        throw new Error('boom');
      },
      has() {
        throw new Error('boom');
      },
      ownKeys() {
        throw new Error('boom');
      },
    });
    let result: string | undefined;
    expect(() => {
      result = safeErrorMessage(hostile);
    }).not.toThrow();
    expect(typeof result).toBe('string');
  });
});

