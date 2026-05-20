/**
 * Issue #191 — lossy error stringification.
 *
 * The inline pattern `err instanceof Error ? err.message : String(err)`
 * collapses object-shaped errors to `'[object Object]'`, masking aggregator
 * response payloads. `errMessage` (in `core/errors.ts`) is the documented
 * replacement — it preserves field-level forensics by JSON-stringifying
 * unknown shapes through the W40 redaction layer.
 *
 * This test pins the contract callers depend on:
 *  1. Error instances surface `.message` verbatim.
 *  2. String throws surface unchanged.
 *  3. Plain-object throws become JSON, NOT `'[object Object]'`.
 *  4. Sensitive fields are still redacted (no W40 bypass).
 *  5. Unstringifiable values fall back to `String(err)` without throwing.
 */
import { describe, expect, it } from 'vitest';

import { errMessage } from '../../../core/errors';

describe('errMessage()', () => {
  it('returns Error.message for Error instances', () => {
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('preserves custom Error subclass messages', () => {
    class CustomError extends Error {}
    expect(errMessage(new CustomError('custom-boom'))).toBe('custom-boom');
  });

  it('returns the value unchanged for string throws', () => {
    expect(errMessage('plain-string')).toBe('plain-string');
  });

  it('JSON-stringifies plain objects instead of "[object Object]"', () => {
    // The bug fix's headline test — issue #191's reproducer.
    const out = errMessage({ status: 'BAD_REQUEST', reason: 'rate-limit' });
    expect(out).not.toBe('[object Object]');
    expect(out).toBe('{"status":"BAD_REQUEST","reason":"rate-limit"}');
  });

  it('serializes the aggregator-style structured payload', () => {
    // The shape NametagMinter sees back from a rejected submit_commitment —
    // matches the issue #191 expected output illustration.
    const payload = {
      status: 'BAD_REQUEST',
      details: { code: 'rate-limit-exceeded', retryAfterMs: 5000 },
    };
    const out = errMessage(payload);
    expect(out).toContain('"status":"BAD_REQUEST"');
    expect(out).toContain('"retryAfterMs":5000');
  });

  it('routes through redactCause so sensitive fields never leak via errMessage', () => {
    const out = errMessage({
      tokenId: 't1',
      signedTransferTxBytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(out).toContain('"tokenId":"t1"');
    expect(out).toContain('[REDACTED: signedTransferTxBytes(4-bytes)]');
    // Raw bytes never appear in the surfaced string.
    expect(out).not.toMatch(/\[1,2,3,4\]/);
  });

  it('handles array throws by serializing each element', () => {
    expect(errMessage([1, 'two', { k: 'v' }])).toBe('[1,"two",{"k":"v"}]');
  });

  it('handles null and undefined without throwing', () => {
    // JSON.stringify(null) === 'null'; redactCause(undefined) === undefined
    // and JSON.stringify(undefined) === undefined; the catch-fallback
    // surfaces 'undefined' via String(err). The exact string is less
    // important than the no-throw guarantee.
    expect(errMessage(null)).toBe('null');
    expect(() => errMessage(undefined)).not.toThrow();
  });

  it('falls back to String(err) for unstringifiable shapes (BigInt)', () => {
    // BigInt throws on JSON.stringify — we MUST NOT propagate that throw.
    const out = errMessage({ amount: 10n });
    // Either path is acceptable: a redactCause walk that emits 'null' for
    // BigInt, or the catch-fallback's `String(err)`. The contract is no
    // throw and a non-empty string.
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('handles self-referential causes without throwing (cycle-safe)', () => {
    const cyclic: Record<string, unknown> = { name: 'parent' };
    cyclic.self = cyclic;
    // `redactCause` is cycle-safe (WeakMap visited set), but the redacted
    // clone preserves the cycle structurally so `JSON.stringify` still
    // throws. The catch-fallback to `String(err)` returns
    // '[object Object]' — strictly worse than non-cyclic shapes, but
    // acceptable: the headline bug (non-cyclic objects masked as
    // '[object Object]') is already prevented by the earlier tests.
    // The contract here is no-throw + non-empty string.
    const out = errMessage(cyclic);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
