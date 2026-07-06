/**
 * MasterPrivateKey zeroize regression tests (SPEC §11.11, R-11).
 *
 * Asserts the lifetime-narrowing contract:
 *   - zeroize() wipes the underlying buffer in place
 *   - zeroize() evicts the instance from the authorized registry
 *   - isAuthorizedMasterKey returns false post-zeroize
 *   - assertAuthorizedMasterKey throws PROTOCOL_ERROR post-zeroize
 *   - derivePointerKeyMaterial throws PROTOCOL_ERROR post-zeroize
 *   - zeroize is idempotent (safe to call repeatedly)
 *   - per-instance scoping (zeroizing one instance does not affect another)
 */

import { describe, it, expect } from 'vitest';
import {
  createMasterPrivateKey,
  isAuthorizedMasterKey,
  assertAuthorizedMasterKey,
  derivePointerKeyMaterial,
  AggregatorPointerErrorCode,
} from '../../../../extensions/uxf/profile/aggregator-pointer';

const SEED = new Uint8Array(32).fill(0x77);
const ALT_SEED = new Uint8Array(32).fill(0x33);

describe('MasterPrivateKey.zeroize — SPEC §11.11 R-11', () => {
  it('wipes the internal buffer in place', () => {
    const mk = createMasterPrivateKey(SEED);
    // Verify bytes are live pre-zeroize.
    expect(mk.bytes[0]).toBe(0x77);
    expect(mk.bytes.every((b) => b === 0x77)).toBe(true);

    mk.zeroize();

    // `bytes` still points at the same buffer; every byte is zeroed.
    expect(mk.bytes.length).toBe(32);
    expect(mk.bytes.every((b) => b === 0)).toBe(true);
  });

  it('evicts from the registry so isAuthorizedMasterKey returns false', () => {
    const mk = createMasterPrivateKey(SEED);
    expect(isAuthorizedMasterKey(mk)).toBe(true);
    mk.zeroize();
    expect(isAuthorizedMasterKey(mk)).toBe(false);
  });

  it('assertAuthorizedMasterKey throws PROTOCOL_ERROR post-zeroize', () => {
    const mk = createMasterPrivateKey(SEED);
    mk.zeroize();
    expect(() => assertAuthorizedMasterKey(mk)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
    );
  });

  it('derivePointerKeyMaterial throws PROTOCOL_ERROR post-zeroize', () => {
    const mk = createMasterPrivateKey(SEED);
    mk.zeroize();
    expect(() => derivePointerKeyMaterial(mk)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
    );
  });

  it('zeroize is idempotent (second call is a no-op)', () => {
    const mk = createMasterPrivateKey(SEED);
    mk.zeroize();
    // Second call must not throw.
    expect(() => mk.zeroize()).not.toThrow();
    // Still zeroed, still not authorized.
    expect(mk.bytes.every((b) => b === 0)).toBe(true);
    expect(isAuthorizedMasterKey(mk)).toBe(false);
  });

  it('per-instance scoping — zeroizing one does not disturb another', () => {
    const a = createMasterPrivateKey(SEED);
    const b = createMasterPrivateKey(ALT_SEED);
    a.zeroize();
    expect(isAuthorizedMasterKey(a)).toBe(false);
    expect(isAuthorizedMasterKey(b)).toBe(true);
    // b's bytes intact, derivation still works.
    expect(b.bytes.every((byte) => byte === 0x33)).toBe(true);
    expect(() => derivePointerKeyMaterial(b)).not.toThrow();
  });
});
