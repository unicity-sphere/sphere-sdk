/**
 * Reusable ITokenEngine contract suite.
 *
 * The behaviours every ITokenEngine implementation must satisfy, expressed
 * against the port only. The FakeTokenEngine runs it now; the real adapter will
 * run the SAME suite (against a TestAggregatorClient) so both are held to one
 * behavioural spec.
 */

import { describe, expect, it } from 'vitest';

import type { ITokenEngine, NftMetadata, NftMintPlan } from '../../../token-engine';

export function runEngineContract(name: string, makeEngine: () => ITokenEngine): void {
  describe(`ITokenEngine contract — ${name}`, () => {
    // Valid compressed secp256k1 public keys (generator G and k=2) — the real
    // engine rejects malformed points, so the contract uses on-curve keys.
    const hex = (h: string): Uint8Array => {
      const bytes = new Uint8Array(h.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      return bytes;
    };
    const PK_A = hex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    const PK_B = hex('02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
    const COIN = 'c'.repeat(64);

    const mintTo = (e: ITokenEngine, pubkey: Uint8Array, amount: bigint) =>
      e.mint({ recipientPubkey: pubkey, value: { assets: [{ coinId: COIN, amount }] } });
    // Spend sources must be owned by the engine (the real adapter enforces ownership).
    const mintSelf = (e: ITokenEngine, amount: bigint) => mintTo(e, e.getIdentity().chainPubkey, amount);

    it('getIdentity returns a 33-byte chain pubkey', () => {
      const id = makeEngine().getIdentity();
      expect(id.chainPubkey).toBeInstanceOf(Uint8Array);
      expect(id.chainPubkey.length).toBe(33);
    });

    it('deriveIdentityAddress is a pure function of the pubkey', async () => {
      const e = makeEngine();
      expect(await e.deriveIdentityAddress(PK_A)).toBe(await e.deriveIdentityAddress(PK_A));
      expect(await e.deriveIdentityAddress(PK_A)).not.toBe(await e.deriveIdentityAddress(PK_B));
    });

    it('mint yields a token whose value and balance reflect the mint', async () => {
      const e = makeEngine();
      const t = await mintTo(e, PK_A, 500n);
      expect(e.balanceOf(t, COIN)).toBe(500n);
      expect(e.readValue(t)).toEqual({ assets: [{ coinId: COIN, amount: 500n }] });
    });

    it('transfer hands the value to the recipient and spends the source', async () => {
      const e = makeEngine();
      const src = await mintSelf(e, 500n);
      const recv = await e.transfer({ token: src, recipientPubkey: PK_B });
      expect(e.balanceOf(recv, COIN)).toBe(500n);
      expect(await e.isSpent(src)).toBe(true);
      expect(await e.isSpent(recv)).toBe(false);
    });

    it('burn spends the source, leaves a token nobody owns, and carries the reason as its memo', async () => {
      const e = makeEngine();
      const me = e.getIdentity().chainPubkey;
      const token = await e.mint({ recipientPubkey: me, value: { assets: [{ coinId: COIN, amount: 7n }] } });
      const reason = new Uint8Array([0xd9, 0x98, 0x88, 0x81, 0x01]);
      const burned = await e.burn({ token, reasonBytes: reason });
      expect(e.tokenId(burned)).toBe(e.tokenId(token));
      expect(e.isOwnedBy(burned, me)).toBe(false);
      expect(e.readMemo(burned)).toEqual(reason);
      expect(e.balanceOf(burned, COIN)).toBe(7n);
      await expect(e.isSpent(token)).resolves.toBe(true);
      await expect(e.burn({ token, reasonBytes: reason })).rejects.toThrow();
    });

    it('split conserves value and spends the source', async () => {
      const e = makeEngine();
      const src = await mintSelf(e, 500n);
      const { outputs } = await e.split({
        token: src,
        outputs: [
          { recipientPubkey: PK_B, coinId: COIN, amount: 200n },
          { recipientPubkey: e.getIdentity().chainPubkey, coinId: COIN, amount: 300n },
        ],
      });
      expect(outputs).toHaveLength(2);
      // Order-independent: total value is conserved across outputs.
      expect(outputs.reduce((sum, o) => sum + e.balanceOf(o, COIN), 0n)).toBe(500n);
      expect(await e.isSpent(src)).toBe(true);
    });

    it('rejects a non-conserving split', async () => {
      const e = makeEngine();
      const src = await mintSelf(e, 500n);
      await expect(
        e.split({ token: src, outputs: [{ recipientPubkey: PK_B, coinId: COIN, amount: 200n }] }),
      ).rejects.toThrow();
    });

    it('encodeToken → decodeToken round-trips the value', async () => {
      const e = makeEngine();
      const t = await mintSelf(e, 7n);
      const back = await e.decodeToken(e.encodeToken(t));
      expect(e.readValue(back)).toEqual({ assets: [{ coinId: COIN, amount: 7n }] });
    });

    it('verify reports structural validity, independent of spent-status', async () => {
      const e = makeEngine();
      const t = await mintSelf(e, 1n);
      expect((await e.verify(t)).ok).toBe(true);
      await e.transfer({ token: t, recipientPubkey: PK_B });
      // Still structurally valid (a spent token is not malformed)…
      expect((await e.verify(t)).ok).toBe(true);
      // …but now spent.
      expect(await e.isSpent(t)).toBe(true);
    });

    it('exposes a 64-char hex tokenId that is stable across a transfer', async () => {
      const e = makeEngine();
      const src = await mintSelf(e, 5n);
      const id = e.tokenId(src);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      const recv = await e.transfer({ token: src, recipientPubkey: PK_B });
      expect(e.tokenId(recv)).toBe(id); // same token (genesis), new state
    });

    it('mints a data token (value === null) with readable data and a salt-derived tokenId', async () => {
      const e = makeEngine();
      const data = new Uint8Array([1, 2, 3, 4]);
      const tokenType = new Uint8Array(32).fill(1);
      const salt = new Uint8Array(32).fill(7);
      const t = await e.mintDataToken({ recipientPubkey: PK_A, data, tokenType, salt });
      expect(e.readValue(t)).toBeNull();
      expect(e.readTokenData(t)).toEqual(data);
      expect(e.readTokenJustification(t)).toBeNull();
      expect(e.tokenId(t)).toMatch(/^[0-9a-f]{64}$/);
      // tokenId is derived from (networkId, salt): the same terms-derived salt re-mints
      // to the identical, stable tokenId (the invoice-id use case).
      const again = await e.mintDataToken({ recipientPubkey: PK_A, data, tokenType, salt });
      expect(e.tokenId(again)).toBe(e.tokenId(t));
    });

    it('isOwnedBy matches the current state owner and follows transfers', async () => {
      const e = makeEngine();
      const mine = e.getIdentity().chainPubkey;
      const src = await mintSelf(e, 5n);
      expect(e.isOwnedBy(src, mine)).toBe(true);
      expect(e.isOwnedBy(src, PK_B)).toBe(false);
      const recv = await e.transfer({ token: src, recipientPubkey: PK_B });
      expect(e.isOwnedBy(recv, PK_B)).toBe(true);
      expect(e.isOwnedBy(recv, mine)).toBe(false);
    });

    it('carries an opaque on-chain memo on a whole-token transfer (readMemo)', async () => {
      const e = makeEngine();
      const src = await mintSelf(e, 1n);
      const memo = new Uint8Array([9, 8, 7]);
      const recv = await e.transfer({ token: src, recipientPubkey: PK_B, data: memo });
      expect(e.readMemo(recv)).toEqual(memo);
    });

    it('carries an opaque on-chain memo on a split output (readMemo)', async () => {
      const e = makeEngine();
      const src = await mintSelf(e, 10n);
      const memo = new Uint8Array([4, 2]);
      const { outputs } = await e.split({
        token: src,
        outputs: [
          { recipientPubkey: PK_B, coinId: COIN, amount: 6n, data: memo },
          { recipientPubkey: e.getIdentity().chainPubkey, coinId: COIN, amount: 4n },
        ],
      });
      // Outputs are index-aligned with the requested outputs (positional contract).
      expect(e.balanceOf(outputs[0], COIN)).toBe(6n);
      expect(e.balanceOf(outputs[1], COIN)).toBe(4n);
      expect(e.readMemo(outputs[0])).toEqual(memo);
      expect(e.readMemo(outputs[1])).toBeNull();
    });

    // ── NFT metadata (#785): a signature binds the network, GENESIS recipient, token id and token type ──
    const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const NFT_TYPE = new Uint8Array(32).fill(0x4e);
    const NFT: NftMetadata = {
      kind: 'metadata',
      name: 'Contract Cat',
      description: null,
      image: { kind: 'media', media_type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      animation_url: null,
      external_url: null,
      attributes: [{ trait_type: 'Lives', value: 9 }],
      collection: 'Contract Cats',
      collection_id: toHex(NFT_TYPE),
    };
    const planNft = (e: ITokenEngine, sign = true) =>
      e.buildNftMint({ recipientPubkey: e.getIdentity().chainPubkey, content: NFT, sign, tokenType: NFT_TYPE });
    const mintPlan = (e: ITokenEngine, plan: NftMintPlan, recipientPubkey = e.getIdentity().chainPubkey, salt = plan.salt) =>
      e.mintDataToken({ recipientPubkey, data: plan.data, tokenType: plan.tokenType, salt });
    const signedBy = (e: ITokenEngine, signature: 'valid' | 'invalid') =>
      ({ content: NFT, creator: toHex(e.getIdentity().chainPubkey), signature });

    it('buildNftMint plans a signed NFT whose token id the mint reproduces, and readNft verifies it', async () => {
      const e = makeEngine();
      const plan = await planNft(e);
      expect(plan.tokenId).toMatch(/^[0-9a-f]{64}$/);
      expect(plan.salt).toHaveLength(32);
      expect(plan.tokenType).toEqual(NFT_TYPE);
      const t = await mintPlan(e, plan);
      expect(e.tokenId(t)).toBe(plan.tokenId);
      expect(e.readTokenData(t)).toEqual(plan.data);
      expect(await e.readNft(t)).toEqual(signedBy(e, 'valid'));
      expect(await e.readNft(await e.decodeToken(e.encodeToken(t)))).toEqual(signedBy(e, 'valid'));
    });

    it('buildNftMint draws a fresh salt, so every plan names a new token', async () => {
      const e = makeEngine();
      const [a, b] = [await planNft(e), await planNft(e)];
      expect(a.salt).not.toEqual(b.salt);
      expect(a.tokenId).not.toBe(b.tokenId);
    });

    it('an unsigned NFT reads as unsigned, with no creator', async () => {
      const e = makeEngine();
      const t = await mintPlan(e, await planNft(e, false));
      expect(await e.readNft(t)).toEqual({ content: NFT, creator: null, signature: 'unsigned' });
    });

    it('readNft stays valid after the NFT is transferred away from its first owner', async () => {
      const e = makeEngine();
      const recv = await e.transfer({ token: await mintPlan(e, await planNft(e)), recipientPubkey: PK_B });
      expect(e.isOwnedBy(recv, PK_B)).toBe(true);
      expect(await e.readNft(recv)).toEqual(signedBy(e, 'valid'));
      expect(await e.readNft(await e.decodeToken(e.encodeToken(recv)))).toEqual(signedBy(e, 'valid'));
    });

    it('a signed payload minted under another token id reads invalid', async () => {
      const e = makeEngine();
      const plan = await planNft(e);
      const t = await mintPlan(e, plan, e.getIdentity().chainPubkey, new Uint8Array(32).fill(0x5a));
      expect(e.tokenId(t)).not.toBe(plan.tokenId);
      expect(await e.readNft(t)).toEqual(signedBy(e, 'invalid'));
    });

    it('a signed payload minted under another token type reads invalid, though the salt gives the same token id', async () => {
      const e = makeEngine();
      const plan = await planNft(e);
      const t = await e.mintDataToken({
        recipientPubkey: e.getIdentity().chainPubkey,
        data: plan.data,
        tokenType: new Uint8Array(32).fill(0x4f),
        salt: plan.salt,
      });
      expect(e.tokenId(t)).toBe(plan.tokenId);
      expect(await e.readNft(t)).toEqual(signedBy(e, 'invalid'));
    });

    it('a signed payload minted to another first owner reads invalid (a front-run mint)', async () => {
      const e = makeEngine();
      const plan = await planNft(e);
      const t = await mintPlan(e, plan, PK_B);
      expect(e.tokenId(t)).toBe(plan.tokenId);
      expect(await e.readNft(t)).toEqual(signedBy(e, 'invalid'));
    });

    it('buildNftMint refuses invalid content with VALIDATION_ERROR', async () => {
      const e = makeEngine();
      const request = { recipientPubkey: e.getIdentity().chainPubkey, sign: true, tokenType: NFT_TYPE };
      await expect(e.buildNftMint({ ...request, content: { ...NFT, name: '' } })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('readNft is null for a coin token, a value-less token and a non-NFT data token', async () => {
      const e = makeEngine();
      const data = new Uint8Array([1, 2, 3, 4]);
      const dataToken = await e.mintDataToken({ recipientPubkey: PK_A, data, tokenType: NFT_TYPE, salt: new Uint8Array(32).fill(3) });
      expect(await e.readNft(await mintSelf(e, 5n))).toBeNull();
      expect(await e.readNft(await e.mint({ recipientPubkey: PK_A }))).toBeNull();
      expect(await e.readNft(dataToken)).toBeNull();
    });
  });
}
