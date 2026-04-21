/**
 * SecretKey wrapper (T-A7) — serialization discipline.
 */

import { describe, it, expect } from 'vitest';
import { SecretKey } from '../../../../profile/aggregator-pointer/index.js';
import { inspect } from 'node:util';

describe('SecretKey (T-A7)', () => {
  const magic = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]);

  it('reveal() returns a COPY (mutating it does not affect the wrapper)', () => {
    const key = new SecretKey(magic, 'test');
    const out = key.reveal();
    out.fill(0);
    expect(Array.from(key.reveal())).toEqual(Array.from(magic));
  });

  it('toString redacts bytes', () => {
    const key = new SecretKey(magic, 'my-key');
    const s = key.toString();
    expect(s).toContain('REDACTED');
    expect(s).toContain('my-key');
    // Magic bytes 0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe
    // should never appear as hex substrings in the output.
    expect(s).not.toContain('deadbeef');
    expect(s).not.toContain('cafebabe');
    expect(s).not.toContain('de ad be ef');
  });

  it('toJSON redacts bytes', () => {
    const key = new SecretKey(magic, 'test-label');
    const s = JSON.stringify({ secret: key });
    expect(s).toContain('REDACTED');
    expect(s).not.toContain('deadbeef');
  });

  it('util.inspect redacts bytes', () => {
    const key = new SecretKey(magic, 'test-label');
    const s = inspect({ secret: key }, { depth: 3 });
    expect(s).toContain('REDACTED');
    expect(s).not.toMatch(/deadbeef|cafebabe/);
  });

  it('zeroize() marks the wrapper as zeroized', () => {
    const key = new SecretKey(new Uint8Array(magic), 'test');
    expect(key.isZeroized()).toBe(false);
    key.zeroize();
    expect(key.isZeroized()).toBe(true);
  });

  it('constructor rejects empty bytes', () => {
    expect(() => new SecretKey(new Uint8Array(0), 'empty')).toThrow();
  });

  it('length and label accessors work', () => {
    const key = new SecretKey(magic, 'my-label');
    expect(key.length).toBe(magic.length);
    expect(key.label).toBe('my-label');
  });

  it('constructor takes a DEFENSIVE COPY of input', () => {
    const input = new Uint8Array(magic);
    const key = new SecretKey(input, 'copy');
    input[0] = 0x00;
    expect(key.reveal()[0]).toBe(magic[0]);
  });

  it('Object.keys does not expose the bytes field', () => {
    const key = new SecretKey(magic, 'leak-test');
    expect(Object.keys(key)).toEqual([]);
    expect(Object.getOwnPropertyNames(key)).not.toContain('bytes');
    expect(Object.getOwnPropertyNames(key)).not.toContain('_bytes');
  });

  it('object spread does not leak the bytes field', () => {
    const key = new SecretKey(magic, 'leak-test');
    const spread = { ...key };
    const json = JSON.stringify(spread);
    expect(json).not.toContain('deadbeef');
    expect(json).not.toContain('cafebabe');
  });

  it('Object.entries does not leak the bytes field', () => {
    const key = new SecretKey(magic, 'leak-test');
    const entries = Object.entries(key);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('cafebabe');
  });

  it('Object.assign does not leak the bytes field', () => {
    const key = new SecretKey(magic, 'leak-test');
    const clone: Record<string, unknown> = {};
    Object.assign(clone, key);
    const serialized = JSON.stringify(clone);
    expect(serialized).not.toContain('deadbeef');
  });

  it('structuredClone does not leak the bytes field', () => {
    const key = new SecretKey(magic, 'leak-test');
    // structuredClone drops unrecognized own properties; private fields
    // are not copied. Result must not contain the secret bytes.
    let serialized: string;
    try {
      const cloned = structuredClone(key);
      serialized = JSON.stringify(cloned);
    } catch {
      // Acceptable: DataCloneError on private-field class — also not leaky.
      serialized = '';
    }
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('cafebabe');
  });

  it('template-literal coercion redacts (Symbol.toPrimitive)', () => {
    const key = new SecretKey(magic, 'my-key');
    const s = `secret is ${key}`;
    expect(s).toContain('REDACTED');
    expect(s).not.toContain('deadbeef');
    expect(s).not.toContain('cafebabe');
  });

  it('reveal() after zeroize() throws', () => {
    const key = new SecretKey(new Uint8Array(magic), 'zeroize-test');
    key.zeroize();
    expect(() => key.reveal()).toThrow(/zeroized/);
    expect(key.isZeroized()).toBe(true);
  });
});
