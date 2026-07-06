/**
 * HEALTH_CHECK_REQUEST_ID (T-A6c, SPEC §13 W12).
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  deriveHealthCheckRequestId,
  bytesToHex,
} from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';

describe('deriveHealthCheckRequestId (T-A6c)', () => {
  it('output is 32 bytes', () => {
    const signingPubKey = new Uint8Array(33).fill(0x02);
    const rid = deriveHealthCheckRequestId(signingPubKey);
    expect(rid.length).toBe(32);
  });

  it('deterministic: same input → same output', () => {
    const signingPubKey = new Uint8Array(33).fill(0x03);
    const r1 = deriveHealthCheckRequestId(signingPubKey);
    const r2 = deriveHealthCheckRequestId(signingPubKey);
    expect(bytesToHex(r1)).toBe(bytesToHex(r2));
  });

  it('different signingPubKey → different requestId', () => {
    const a = new Uint8Array(33).fill(0x02);
    const b = new Uint8Array(33).fill(0x03);
    expect(bytesToHex(deriveHealthCheckRequestId(a))).not.toBe(
      bytesToHex(deriveHealthCheckRequestId(b)),
    );
  });

  it('rejects wrong-length signingPubKey', () => {
    expect(() => deriveHealthCheckRequestId(new Uint8Array(32))).toThrow();
    expect(() => deriveHealthCheckRequestId(new Uint8Array(34))).toThrow();
  });

  it('matches the SPEC §13 W12 formula: SHA-256("profile-pointer-health-check" || signingPubKey)', () => {
    const pk = new Uint8Array(33);
    for (let i = 0; i < 33; i++) pk[i] = i;
    const prefix = new TextEncoder().encode('profile-pointer-health-check');
    const preimage = new Uint8Array(prefix.length + 33);
    preimage.set(prefix, 0);
    preimage.set(pk, prefix.length);
    const expected = sha256(preimage);
    expect(bytesToHex(deriveHealthCheckRequestId(pk))).toBe(bytesToHex(expected));
  });
});
