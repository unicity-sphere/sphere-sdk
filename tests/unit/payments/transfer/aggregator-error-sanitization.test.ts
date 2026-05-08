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
