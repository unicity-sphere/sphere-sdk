/**
 * Reusable ITokenEngine contract suite.
 *
 * The behaviours every ITokenEngine implementation must satisfy, expressed
 * against the port only. The FakeTokenEngine runs it now; the real adapter will
 * run the SAME suite (against a TestAggregatorClient) so both are held to one
 * behavioural spec.
 */

import { describe, expect, it } from 'vitest';

import type { ITokenEngine } from '../../../token-engine';

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
  });
}
