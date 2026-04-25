/**
 * MasterPrivateKey registry (T-A5b).
 */

import { describe, it, expect } from 'vitest';
import {
  createMasterPrivateKey,
  isAuthorizedMasterKey,
  assertAuthorizedMasterKey,
  derivePointerKeyMaterial,
  type MasterPrivateKey,
} from '../../../../profile/aggregator-pointer/index.js';

describe('MasterPrivateKey (T-A5b)', () => {
  const bytes = new Uint8Array(32).fill(0x01);

  it('createMasterPrivateKey produces an authorized instance', () => {
    const master = createMasterPrivateKey(bytes, 'test-vectors');
    expect(isAuthorizedMasterKey(master)).toBe(true);
    expect(master.bytes).toEqual(bytes);
  });

  it('rejects bytes of wrong length with RangeError', () => {
    // Wave F.9 fix: 'test-vectors' belongs as the SECOND arg to
    // createMasterPrivateKey, not inside the Uint8Array constructor
    // (which silently ignores it). Length-check still fires first
    // regardless of network parameter.
    expect(() => createMasterPrivateKey(new Uint8Array(16), 'test-vectors')).toThrow(RangeError);
    expect(() => createMasterPrivateKey(new Uint8Array(33), 'test-vectors')).toThrow(/must be exactly 32 bytes/);
  });

  it('isAuthorizedMasterKey returns false for cast raw objects', () => {
    const fake = { bytes } as unknown as MasterPrivateKey;
    expect(isAuthorizedMasterKey(fake)).toBe(false);
  });

  it('assertAuthorizedMasterKey throws PROTOCOL_ERROR for cast raw objects', () => {
    const fake = { bytes } as unknown as MasterPrivateKey;
    expect(() => assertAuthorizedMasterKey(fake)).toThrow(
      /not produced by createMasterPrivateKey/,
    );
  });

  it('derivePointerKeyMaterial refuses cast raw objects', () => {
    const fake = { bytes } as unknown as MasterPrivateKey;
    expect(() => derivePointerKeyMaterial(fake)).toThrow(
      /not produced by createMasterPrivateKey/,
    );
  });

  it('derivePointerKeyMaterial accepts authorized instances', () => {
    const master = createMasterPrivateKey(bytes, 'test-vectors');
    expect(() => derivePointerKeyMaterial(master)).not.toThrow();
  });

  it('inline-constructed shape (same fields) is rejected', () => {
    // A caller crafting a lookalike without going through createMasterPrivateKey
    // must not pass the registry check.
    const fake = {
      bytes: new Uint8Array(bytes),
      _brand: 'MasterPrivateKey',
    } as unknown as MasterPrivateKey;
    expect(isAuthorizedMasterKey(fake)).toBe(false);
    expect(() => derivePointerKeyMaterial(fake)).toThrow();
  });

  it('frozen instance: bytes cannot be mutated', () => {
    const master = createMasterPrivateKey(bytes, 'test-vectors');
    // Can still mutate the underlying TypedArray, but not replace the property.
    // This is a defense-in-depth check that the top-level object is frozen.
    expect(Object.isFrozen(master)).toBe(true);
  });

  it('copy discipline: mutating the input does not affect the stored key', () => {
    const input = new Uint8Array(32).fill(0x42);
    const master = createMasterPrivateKey(input, 'test-vectors');
    input[0] = 0xff;
    expect(master.bytes[0]).toBe(0x42);
  });
});
