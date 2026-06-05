import { describe, it, expect } from 'vitest';

import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { CborError, CborSerializer, PaymentAssetCollection } from '../../../token-engine/sdk';
import type { SphereValue } from '../../../token-engine/types';

// 32-byte asset ids in hex (canonical lowercase) → these are sphere CoinIds.
const COIN_A = 'a'.repeat(64);
const COIN_B = 'b'.repeat(64);

describe('SpherePaymentData', () => {
  it('round-trips a single-coin value through encode/decode', async () => {
    const value: SphereValue = { assets: [{ coinId: COIN_A, amount: 1000n }] };
    const bytes = await SpherePaymentData.fromValue(value).encode();
    expect(SpherePaymentData.fromCBOR(bytes).toValue()).toEqual(value);
  });

  it('round-trips multiple coins incl. zero and very large amounts', async () => {
    const value: SphereValue = {
      assets: [
        { coinId: COIN_A, amount: 0n },
        { coinId: COIN_B, amount: 2n ** 70n },
      ],
    };
    const bytes = await SpherePaymentData.fromValue(value).encode();
    expect(SpherePaymentData.fromCBOR(bytes).toValue()).toEqual(value);
  });

  it('round-trips an empty collection', async () => {
    const value: SphereValue = { assets: [] };
    const bytes = await SpherePaymentData.fromValue(value).encode();
    expect(SpherePaymentData.fromCBOR(bytes).toValue()).toEqual(value);
  });

  it('balanceOf returns the coin amount, or 0n for an absent coin', () => {
    const pd = SpherePaymentData.fromValue({ assets: [{ coinId: COIN_A, amount: 42n }] });
    expect(pd.balanceOf(COIN_A)).toBe(42n);
    expect(pd.balanceOf(COIN_B)).toBe(0n);
  });

  it('encodes deterministically (same value → identical bytes)', async () => {
    const value: SphereValue = { assets: [{ coinId: COIN_A, amount: 7n }] };
    const a = await SpherePaymentData.fromValue(value).encode();
    const b = await SpherePaymentData.fromValue(value).encode();
    expect(a).toEqual(b);
  });

  it('satisfies IPaymentData (assets is a PaymentAssetCollection; encode resolves bytes)', async () => {
    const pd = SpherePaymentData.fromValue({ assets: [{ coinId: COIN_A, amount: 1n }] });
    expect(pd.assets).toBeInstanceOf(PaymentAssetCollection);
    await expect(pd.encode()).resolves.toBeInstanceOf(Uint8Array);
  });

  it('rejects bytes with the wrong CBOR tag', () => {
    const wrong = CborSerializer.encodeTag(
      39999n,
      CborSerializer.encodeArray(CborSerializer.encodeUnsignedInteger(1n), CborSerializer.encodeArray()),
    );
    expect(() => SpherePaymentData.fromCBOR(wrong)).toThrow(CborError);
  });

  it('rejects an unsupported version', () => {
    const future = CborSerializer.encodeTag(
      SpherePaymentData.CBOR_TAG,
      CborSerializer.encodeArray(CborSerializer.encodeUnsignedInteger(999n), CborSerializer.encodeArray()),
    );
    expect(() => SpherePaymentData.fromCBOR(future)).toThrow(CborError);
  });

  it('rejects a negative amount (would silently encode to 0n otherwise)', () => {
    expect(() => SpherePaymentData.fromValue({ assets: [{ coinId: COIN_A, amount: -1n }] })).toThrow(/non-negative/);
  });

  it('rejects a malformed coin id', () => {
    expect(() => SpherePaymentData.fromValue({ assets: [{ coinId: 'XYZ', amount: 1n }] })).toThrow(/coin id/);
    expect(() => SpherePaymentData.fromValue({ assets: [{ coinId: 'abc', amount: 1n }] })).toThrow(/coin id/); // odd length
    expect(() => SpherePaymentData.fromValue({ assets: [{ coinId: COIN_A.toUpperCase(), amount: 1n }] })).toThrow(/coin id/);
  });
});
