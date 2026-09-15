import { describe, expect, it } from 'vitest';

import { runEngineContract } from './engine-contract';
import type { NftMedia } from '../../../token-engine';
import { CborSerializer, HexConverter, SigningService } from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { decodeFakeTokenAssets, FakeTokenEngine, readFakeTokenKeys } from './FakeTokenEngine';

// A real key: the contract's NFT cases need the fake to sign as its own identity.
const CONTRACT_KEY = new Uint8Array(32).fill(0x42);
const NFT_MEDIA: NftMedia = { kind: 'media', media_type: 'text/plain', bytes: new TextEncoder().encode('hi') };

// The fake must satisfy the shared port contract.
runEngineContract('FakeTokenEngine', () => new FakeTokenEngine({ privateKey: CONTRACT_KEY }));

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

  it('takes its identity from privateKey and refuses a chainPubkey that is not that key', () => {
    const expected = new SigningService(CONTRACT_KEY).publicKey;
    expect(new FakeTokenEngine({ privateKey: CONTRACT_KEY }).getIdentity().chainPubkey).toEqual(expected);
    expect(new FakeTokenEngine({ privateKey: CONTRACT_KEY, chainPubkey: expected }).getIdentity().chainPubkey).toEqual(expected);
    expect(() => new FakeTokenEngine({ privateKey: CONTRACT_KEY, chainPubkey: PK })).toThrow(/not the public key/);
  });

  it('without a privateKey, plans an unsigned NFT but refuses to sign one', async () => {
    const e = new FakeTokenEngine({ chainPubkey: PK });
    const request = { recipientPubkey: PK, content: NFT_MEDIA, tokenType: new Uint8Array(32).fill(1) };
    const unsigned = await e.buildNftMint({ ...request, sign: false });
    const t = await e.mintDataToken({ recipientPubkey: PK, data: unsigned.data, tokenType: unsigned.tokenType, salt: unsigned.salt });
    expect(await e.readNft(t)).toEqual({ content: NFT_MEDIA, creator: null, signature: 'unsigned' });
    // A curve-point recipient, so the refusal can only be the missing key (the digest checks the recipient first).
    const recipientPubkey = new SigningService(CONTRACT_KEY).publicKey;
    await expect(e.buildNftMint({ ...request, recipientPubkey, sign: true })).rejects.toThrow(/privateKey/);
  });

  it('reads a signed NFT whose first owner is not a curve point as invalid, never as a throw', async () => {
    const e = new FakeTokenEngine({ privateKey: CONTRACT_KEY });
    const me = e.getIdentity().chainPubkey;
    const plan = await e.buildNftMint({ recipientPubkey: me, content: NFT_MEDIA, sign: true, tokenType: new Uint8Array(32).fill(1) });
    const t = await e.mintDataToken({ recipientPubkey: PK, data: plan.data, tokenType: plan.tokenType, salt: plan.salt });
    expect(await e.readNft(t)).toEqual({ content: NFT_MEDIA, creator: HexConverter.encode(me), signature: 'invalid' });
  });

  it('readFakeTokenKeys names the token id and the CURRENT owner, and throws on other bytes', async () => {
    const e = new FakeTokenEngine();
    const t = await e.mint({ recipientPubkey: PK, value: { assets: [{ coinId: COIN, amount: 1n }] } });
    const moved = await e.transfer({ token: t, recipientPubkey: new Uint8Array(33).fill(0x08) });
    expect(readFakeTokenKeys(moved.blob.token)).toEqual({ tokenId: t.blob.tokenId, owner: '08'.repeat(33) });
    expect(() => readFakeTokenKeys(new Uint8Array([1, 2, 3]))).toThrow();
  });
});


describe('decodeFakeTokenAssets — the fake must not soften the classifier (#778)', () => {
  /** The fake blob shape `decodeFakeState` reads: [tokenId, stateId, owner, genesis, memo, genesisOwner, tokenType]. */
  const fakeState = (genesis: Uint8Array): Uint8Array =>
    CborSerializer.encodeArray(
      CborSerializer.encodeByteString(new Uint8Array(32).fill(1)),
      CborSerializer.encodeByteString(new Uint8Array(32).fill(2)),
      CborSerializer.encodeByteString(new Uint8Array(33).fill(2)),
      CborSerializer.encodeByteString(genesis),
      CborSerializer.encodeNull(),
      CborSerializer.encodeByteString(new Uint8Array(33).fill(2)),
      CborSerializer.encodeByteString(new Uint8Array(8).fill(1)),
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
