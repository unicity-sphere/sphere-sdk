/**
 * Tests for `coerceToUint8Array` — Issue #251 Problem 3.
 *
 * Pre-fix, the function silently produced wrong bytes for two realistic
 * shapes that OrbitDB replication and JSON round-tripping can produce:
 *
 *   • SPARSE OBJECTS — `{0:1, 2:3}` collapsed to `[1, 3]` (length 2
 *     instead of 3). Downstream AES-GCM decrypt then failed with the
 *     opaque "invalid key or tampered data" message, masking the
 *     upstream byte-shape corruption.
 *   • TRAILING NON-NUMERIC KEYS — `{0:1, 1:2, length:2}` (or
 *     `{0:1, 1:2, type:1}`) slipped a phantom trailing byte into the
 *     Uint8Array. Same opaque downstream symptom.
 *
 * The fix enforces a strict dense-byte-map contract. Anything else is
 * rejected with `ProfileError('ORBITDB_READ_FAILED')` naming the
 * offending shape so operators can triage from the log line.
 */

import { describe, it, expect } from 'vitest';
import { __coerceToUint8ArrayForTest as coerce } from '../../../profile/orbitdb-adapter';

describe('coerceToUint8Array — passthrough', () => {
  it('returns Uint8Array unchanged (same instance)', () => {
    const u = new Uint8Array([1, 2, 3, 250]);
    const out = coerce(u);
    expect(out).toBe(u);
    expect(Array.from(out)).toEqual([1, 2, 3, 250]);
  });

  it('wraps ArrayBuffer in a Uint8Array view', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([9, 8, 7, 6]);
    const out = coerce(ab);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([9, 8, 7, 6]);
  });

  it('accepts Node Buffer (instance of Uint8Array) unchanged', () => {
    // Buffer extends Uint8Array in Node.
    const buf = Buffer.from([10, 20, 30]);
    const out = coerce(buf);
    // Same backing — `Uint8Array` instanceof check matches.
    expect(out).toBe(buf as unknown as Uint8Array);
  });
});

describe('coerceToUint8Array — accepts dense numeric-keyed objects', () => {
  it('round-trips a JSON-cloned Uint8Array (the common legitimate case)', () => {
    const original = new Uint8Array([0, 127, 255, 42, 7]);
    // Simulate a JSON serialise/parse round-trip — `JSON.stringify`
    // turns a Uint8Array into `{"0":0,"1":127,"2":255,"3":42,"4":7}`.
    const round = JSON.parse(JSON.stringify(original));
    const out = coerce(round);
    expect(Array.from(out)).toEqual([0, 127, 255, 42, 7]);
    expect(out.length).toBe(5);
  });

  it('accepts numeric-keyed object out of insertion order (V8 sorts integer keys ascending)', () => {
    // Insertion order does NOT match ascending; coerce must walk
    // sorted-by-canonical-index regardless.
    const obj: Record<string, number> = {};
    obj['2'] = 30;
    obj['0'] = 10;
    obj['1'] = 20;
    const out = coerce(obj);
    expect(Array.from(out)).toEqual([10, 20, 30]);
  });

  it('accepts a single-byte map', () => {
    const out = coerce({ 0: 99 });
    expect(Array.from(out)).toEqual([99]);
  });

  it('accepts an empty object as zero-length bytes', () => {
    const out = coerce({});
    expect(out.length).toBe(0);
  });
});

describe('coerceToUint8Array — fail-loud on sparse objects (Issue #251)', () => {
  it('rejects {0:1, 2:3} (missing index 1) with sparse-map error', () => {
    expect(() => coerce({ 0: 1, 2: 3 })).toThrow(/sparse object/);
  });

  it('rejects {0:1, 1:2, 5:99} (gap in the middle)', () => {
    expect(() => coerce({ 0: 1, 1: 2, 5: 99 })).toThrow(/sparse object.*maxIdx=5/);
  });

  it('rejects {1:1, 2:2} (gap at the start — no index 0)', () => {
    expect(() => coerce({ 1: 1, 2: 2 })).toThrow(/sparse object/);
  });

  it('rejects {99:7} (single high-index entry — sparse from 0)', () => {
    expect(() => coerce({ 99: 7 })).toThrow(/sparse object.*maxIdx=99/);
  });
});

describe('coerceToUint8Array — fail-loud on trailing non-canonical keys (Issue #251)', () => {
  it('rejects {0:1, 1:2, length:2} — array-like shape', () => {
    expect(() => coerce({ 0: 1, 1: 2, length: 2 })).toThrow(/non-canonical key "length"/);
  });

  it('rejects Buffer.toJSON() shape {type:"Buffer", data:[...]}', () => {
    expect(() => coerce({ type: 'Buffer', data: [1, 2, 3] })).toThrow(/non-canonical key "type"/);
  });

  it('rejects {0:1, 1:2, foo:99} — arbitrary trailing string key', () => {
    expect(() => coerce({ 0: 1, 1: 2, foo: 99 })).toThrow(/non-canonical key "foo"/);
  });

  it('rejects {_$serialised: true} — tagged-object shape', () => {
    expect(() => coerce({ _$serialised: true, 0: 1 })).toThrow(/non-canonical key "_\$serialised"/);
  });

  it('rejects negative-integer-string keys like "-1"', () => {
    expect(() => coerce({ '-1': 99, 0: 1 })).toThrow(/non-canonical key "-1"/);
  });

  it('rejects "00", "01" (non-canonical zero-prefixed integer strings)', () => {
    expect(() => coerce({ '00': 1, 1: 2 })).toThrow(/non-canonical key "00"/);
  });
});

describe('coerceToUint8Array — value-shape validation (preserved)', () => {
  it('rejects non-integer values', () => {
    expect(() => coerce({ 0: 1.5, 1: 2 })).toThrow(/Invalid byte value/);
  });

  it('rejects out-of-range values (negative)', () => {
    expect(() => coerce({ 0: -1, 1: 2 })).toThrow(/Invalid byte value/);
  });

  it('rejects out-of-range values (> 255)', () => {
    expect(() => coerce({ 0: 256, 1: 2 })).toThrow(/Invalid byte value/);
  });

  it('rejects string values', () => {
    expect(() => coerce({ 0: '1' as unknown as number, 1: 2 })).toThrow(/Invalid byte value at index 0/);
  });
});

describe('coerceToUint8Array — primitive fallback', () => {
  it('returns empty bytes for null', () => {
    const out = coerce(null);
    expect(out.length).toBe(0);
  });

  it('returns empty bytes for undefined', () => {
    const out = coerce(undefined);
    expect(out.length).toBe(0);
  });

  it('returns empty bytes for a string (unexpected primitive)', () => {
    const out = coerce('not-bytes');
    expect(out.length).toBe(0);
  });

  it('returns empty bytes for a number', () => {
    const out = coerce(42);
    expect(out.length).toBe(0);
  });
});

describe('coerceToUint8Array — accessor-descriptor rejection (PR #253 review)', () => {
  // The byte-fetch loop uses plain property access `obj[String(i)]`
  // which fires getters. Without the descriptor check an
  // attacker-controlled object can run arbitrary code at read time
  // while passing the byte-range check by returning a number in
  // [0, 255]. Contract is "plain byte map" — accessor descriptors
  // (get/set) are rejected.

  it('rejects an object with a getter on a canonical numeric key', () => {
    const obj = {};
    let getterFired = false;
    Object.defineProperty(obj, '0', {
      get() {
        getterFired = true;
        return 1;
      },
      enumerable: true,
    });
    Object.defineProperty(obj, '1', {
      value: 2,
      enumerable: true,
      writable: true,
    });
    // Throw before byte-fetch loop runs — the getter MUST NOT fire.
    expect(() => coerce(obj)).toThrow(/accessor descriptor/);
    expect(getterFired).toBe(false);
  });

  it('rejects an object with a setter (write-only accessor)', () => {
    const obj = {};
    Object.defineProperty(obj, '0', {
      set() { /* writes ignored */ },
      enumerable: true,
    });
    expect(() => coerce(obj)).toThrow(/accessor descriptor/);
  });

  it('accepts plain data descriptors via Object.defineProperty', () => {
    // Sanity: an object built via defineProperty with `value` and
    // `enumerable: true` is structurally identical to a literal — the
    // descriptor check must not reject this legitimate case.
    const obj = {};
    Object.defineProperty(obj, '0', { value: 1, enumerable: true });
    Object.defineProperty(obj, '1', { value: 2, enumerable: true });
    const out = coerce(obj);
    expect(Array.from(out)).toEqual([1, 2]);
  });
});

describe('coerceToUint8Array — additional rejection coverage (PR #253 review)', () => {
  it('rejects an object with ONLY a non-canonical key (single-key bad shape)', () => {
    expect(() => coerce({ type: 'x' })).toThrow(/non-canonical key "type"/);
  });

  it('rejects {0:1, 1:Infinity} — non-finite value', () => {
    expect(() => coerce({ 0: 1, 1: Infinity })).toThrow(/Invalid byte value/);
  });

  it('rejects {0:1, 1:NaN} — non-finite value', () => {
    expect(() => coerce({ 0: 1, 1: NaN })).toThrow(/Invalid byte value/);
  });

  it('ignores symbol keys (for..in does not visit symbols)', () => {
    const sym = Symbol('extra');
    const obj: Record<string | symbol, unknown> = { 0: 1, 1: 2 };
    obj[sym] = 99;
    const out = coerce(obj);
    expect(Array.from(out)).toEqual([1, 2]);
  });

  it('does NOT include inherited enumerable properties', () => {
    // hasOwnProperty filters inherited keys — the contract is own-data
    // bytes only.
    const proto = { '0': 99 };
    const obj = Object.create(proto);
    Object.defineProperty(obj, '0', { value: 1, enumerable: true });
    Object.defineProperty(obj, '1', { value: 2, enumerable: true });
    const out = coerce(obj);
    expect(Array.from(out)).toEqual([1, 2]);
  });

  it('accepts a frozen dense object', () => {
    const out = coerce(Object.freeze({ 0: 1, 1: 2, 2: 3 }));
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('round-trips a 256-byte map correctly', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const round = JSON.parse(JSON.stringify(original));
    const out = coerce(round);
    expect(out.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(out[i]).toBe(i);
  });
});
