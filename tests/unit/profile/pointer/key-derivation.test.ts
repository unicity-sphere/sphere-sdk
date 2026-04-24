/**
 * Key-derivation chain (T-A4, T-A5, T-A6) — invariants + H12 domain separation.
 */

import { describe, it, expect } from 'vitest';
import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  deriveStateHashDigest,
  deriveXorKey,
  derivePaddingBytes,
  be32,
  bytesToHex,
  SIDE_A_NUM,
  SIDE_B_NUM,
  CID_MAX_BYTES,
} from '../../../../profile/aggregator-pointer/index.js';

describe('derivePointerKeyMaterial (T-A4 / T-A5 / T-A6)', () => {
  const bytes = new Uint8Array(32).fill(0x01);
  const master = createMasterPrivateKey(bytes);

  it('outputs are 32 bytes each', () => {
    const km = derivePointerKeyMaterial(master);
    expect(km.pointerSecret.length).toBe(32);
    expect(km.signingSeed.length).toBe(32);
    expect(km.xorSeed.length).toBe(32);
    expect(km.padSeed.length).toBe(32);
  });

  it('is deterministic: same master → same derived keys', () => {
    const km1 = derivePointerKeyMaterial(master);
    const km2 = derivePointerKeyMaterial(master);
    expect(bytesToHex(km1.pointerSecret.reveal())).toBe(bytesToHex(km2.pointerSecret.reveal()));
    expect(bytesToHex(km1.signingSeed.reveal())).toBe(bytesToHex(km2.signingSeed.reveal()));
    expect(bytesToHex(km1.xorSeed.reveal())).toBe(bytesToHex(km2.xorSeed.reveal()));
    expect(bytesToHex(km1.padSeed.reveal())).toBe(bytesToHex(km2.padSeed.reveal()));
  });

  it('H12 domain separation: signingSeed / xorSeed / padSeed / pointerSecret all distinct', () => {
    const km = derivePointerKeyMaterial(master);
    const seeds = new Set([
      bytesToHex(km.pointerSecret.reveal()),
      bytesToHex(km.signingSeed.reveal()),
      bytesToHex(km.xorSeed.reveal()),
      bytesToHex(km.padSeed.reveal()),
    ]);
    expect(seeds.size).toBe(4);
  });

  it('different wallet keys → different derivations', () => {
    const bytes2 = new Uint8Array(32).fill(0x02);
    const master2 = createMasterPrivateKey(bytes2);
    const km1 = derivePointerKeyMaterial(master);
    const km2 = derivePointerKeyMaterial(master2);
    expect(bytesToHex(km1.pointerSecret.reveal())).not.toBe(bytesToHex(km2.pointerSecret.reveal()));
  });

  it('1000 wallets: all subkeys pairwise distinct across derivations', () => {
    const seen = new Set<string>();
    // Start at i=1 so b is not all-zero (SPEC §14.1 denylist).
    for (let i = 1; i <= 100; i++) {
      const b = new Uint8Array(32);
      b[0] = i;
      const m = createMasterPrivateKey(b);
      const km = derivePointerKeyMaterial(m);
      const all = [
        bytesToHex(km.pointerSecret.reveal()),
        bytesToHex(km.signingSeed.reveal()),
        bytesToHex(km.xorSeed.reveal()),
        bytesToHex(km.padSeed.reveal()),
      ];
      for (const key of all) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(400);
  });
});

describe('per-version / per-side derivations', () => {
  const bytes = new Uint8Array(32).fill(0x01);
  const master = createMasterPrivateKey(bytes);
  const km = derivePointerKeyMaterial(master);

  it('stateHashDigest is side-dependent', () => {
    const a = deriveStateHashDigest(km.xorSeed, SIDE_A_NUM, 1);
    const b = deriveStateHashDigest(km.xorSeed, SIDE_B_NUM, 1);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it('xorKey is side- and version-dependent', () => {
    const k_a1 = deriveXorKey(km.xorSeed, SIDE_A_NUM, 1);
    const k_b1 = deriveXorKey(km.xorSeed, SIDE_B_NUM, 1);
    const k_a2 = deriveXorKey(km.xorSeed, SIDE_A_NUM, 2);
    expect(bytesToHex(k_a1)).not.toBe(bytesToHex(k_b1));
    expect(bytesToHex(k_a1)).not.toBe(bytesToHex(k_a2));
  });

  it('paddingBytes length = CID_MAX_BYTES - cidLen', () => {
    expect(derivePaddingBytes(km.padSeed, 1, 0).length).toBe(CID_MAX_BYTES);
    expect(derivePaddingBytes(km.padSeed, 1, 36).length).toBe(CID_MAX_BYTES - 36);
    expect(derivePaddingBytes(km.padSeed, 1, CID_MAX_BYTES).length).toBe(0);
  });

  it('paddingBytes deterministic for same (v, cidLen)', () => {
    const p1 = derivePaddingBytes(km.padSeed, 7, 20);
    const p2 = derivePaddingBytes(km.padSeed, 7, 20);
    expect(bytesToHex(p1)).toBe(bytesToHex(p2));
  });

  it('paddingBytes version-dependent', () => {
    const p1 = derivePaddingBytes(km.padSeed, 7, 20);
    const p2 = derivePaddingBytes(km.padSeed, 8, 20);
    expect(bytesToHex(p1)).not.toBe(bytesToHex(p2));
  });

  it('derivePaddingBytes rejects cidLen > CID_MAX_BYTES', () => {
    expect(() => derivePaddingBytes(km.padSeed, 1, 64)).toThrow();
  });

  it('derivePaddingBytes rejects negative cidLen', () => {
    expect(() => derivePaddingBytes(km.padSeed, 1, -1)).toThrow();
  });

  it('stateHashDigest differs between A@v and A@v+1', () => {
    const a1 = deriveStateHashDigest(km.xorSeed, SIDE_A_NUM, 1);
    const a2 = deriveStateHashDigest(km.xorSeed, SIDE_A_NUM, 2);
    expect(bytesToHex(a1)).not.toBe(bytesToHex(a2));
  });
});

describe('be32', () => {
  it('encodes 0 as 0x00000000', () => {
    expect(Array.from(be32(0))).toEqual([0, 0, 0, 0]);
  });

  it('encodes 1 as 0x00000001', () => {
    expect(Array.from(be32(1))).toEqual([0, 0, 0, 1]);
  });

  it('encodes 0xdeadbeef big-endian', () => {
    expect(Array.from(be32(0xdeadbeef))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('rejects non-integer', () => {
    expect(() => be32(1.5)).toThrow();
  });

  it('rejects negative', () => {
    expect(() => be32(-1)).toThrow();
  });

  it('rejects > 0xffffffff', () => {
    expect(() => be32(0x1_0000_0000)).toThrow();
  });

  it('encodes VERSION_MAX (2^31 - 1) correctly', async () => {
    const { VERSION_MAX } = await import('../../../../profile/aggregator-pointer/index.js');
    const out = be32(VERSION_MAX);
    expect(Array.from(out)).toEqual([0x7f, 0xff, 0xff, 0xff]);
  });
});
