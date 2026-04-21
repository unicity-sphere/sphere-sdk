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

  it('zeroize() overwrites the internal buffer', () => {
    const key = new SecretKey(new Uint8Array(magic), 'test');
    key.zeroize();
    expect(Array.from(key.reveal())).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
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
});
