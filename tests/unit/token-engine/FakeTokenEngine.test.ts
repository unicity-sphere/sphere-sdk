import { describe, expect, it } from 'vitest';

import { runEngineContract } from './engine-contract';
import { CborSerializer } from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { decodeFakeTokenAssets, FakeTokenEngine } from './FakeTokenEngine';

// The fake must satisfy the shared port contract.
runEngineContract('FakeTokenEngine', () => new FakeTokenEngine({ chainPubkey: new Uint8Array(33).fill(0x02) }));

// Fake-specific guarantees beyond the shared contract.
describe('FakeTokenEngine specifics', () => {
  const COIN = 'd'.repeat(64);
  const PK = new Uint8Array(33).fill(0x07);

  it('double-spend of the same source throws', async () => {
    const e = new FakeTokenEngine();
    const t = await e.mint({ recipientPubkey: PK, value: { assets: [{ coinId: COIN, amount: 10n }] } });
    await e.transfer({ token: t, recipientPubkey: PK });
    await expect(e.transfer({ token: t, recipientPubkey: PK })).rejects.toThrow(/already spent/);
  });

  it('getIdentity reflects the configured pubkey and is copied (not aliased)', () => {
    const pubkey = new Uint8Array(33).fill(0x09);
    const e = new FakeTokenEngine({ chainPubkey: pubkey });
    const got = e.getIdentity().chainPubkey;
    expect(got).toEqual(pubkey);
    got[0] = 0xff; // mutating the returned copy must not affect the engine
    expect(e.getIdentity().chainPubkey[0]).toBe(0x09);
  });

  it('mints a value-less token when no value is given (value === null, like the real engine)', async () => {
    const e = new FakeTokenEngine();
    const t = await e.mint({ recipientPubkey: PK });
    expect(e.readValue(t)).toBeNull();
    expect(e.balanceOf(t, COIN)).toBe(0n);
  });
});


describe('decodeFakeTokenAssets — the fake must not soften the classifier (#778)', () => {
  /** The fake blob shape `decodeFakeState` reads: [tokenId, stateId, owner, genesis, memo]. */
  const fakeState = (genesis: Uint8Array): Uint8Array =>
    CborSerializer.encodeArray(
      CborSerializer.encodeByteString(new Uint8Array(32).fill(1)),
      CborSerializer.encodeByteString(new Uint8Array(32).fill(2)),
      CborSerializer.encodeByteString(new Uint8Array(33).fill(2)),
      CborSerializer.encodeByteString(genesis),
      CborSerializer.encodeNull()
    );

  it('PROPAGATES a corrupt-envelope throw instead of indexing it as coinless', async () => {
    // The fake is FakeWalletApi's §8.2 step-6 stand-in. The real backend 422s a
    // corrupt envelope, so returning null would model the pre-#778 silent zero and
    // every payments-v2 test would keep asserting against a fixed bug.
    const valid = await SpherePaymentData.fromValue({
      assets: [{ coinId: 'aa'.repeat(32), amount: 5n }],
    }).encode();
    const trailing = new Uint8Array(valid.length + 1);
    trailing.set(valid);
    trailing[valid.length] = 0xf6;

    expect(() => decodeFakeTokenAssets(fakeState(trailing))).toThrow(/payment data/i);
  });

  it('reads a VALID envelope as its assets', async () => {
    const valid = await SpherePaymentData.fromValue({
      assets: [{ coinId: 'aa'.repeat(32), amount: 5n }],
    }).encode();
    expect(decodeFakeTokenAssets(fakeState(valid))).toEqual([
      { coinId: 'aa'.repeat(32), amount: 5n },
    ]);
  });

  it('reads a genuinely coinless payload as null, with no error', () => {
    expect(decodeFakeTokenAssets(fakeState(CborSerializer.encodeTextString('kitty')))).toBeNull();
  });

  it('still returns null for bytes that are not a fake blob at all', () => {
    expect(decodeFakeTokenAssets(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
