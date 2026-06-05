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
    const PK_A = new Uint8Array(33).fill(0xa1);
    const PK_B = new Uint8Array(33).fill(0xb2);
    const COIN = 'c'.repeat(64);

    const mintTo = (e: ITokenEngine, pubkey: Uint8Array, amount: bigint) =>
      e.mint({ recipientPubkey: pubkey, value: { assets: [{ coinId: COIN, amount }] } });

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
      const src = await mintTo(e, PK_A, 500n);
      const recv = await e.transfer({ token: src, recipientPubkey: PK_B });
      expect(e.balanceOf(recv, COIN)).toBe(500n);
      expect(await e.isSpent(src)).toBe(true);
      expect(await e.isSpent(recv)).toBe(false);
    });

    it('split conserves value and spends the source', async () => {
      const e = makeEngine();
      const src = await mintTo(e, PK_A, 500n);
      const { outputs } = await e.split({
        token: src,
        outputs: [
          { recipientPubkey: PK_B, coinId: COIN, amount: 200n },
          { recipientPubkey: PK_A, coinId: COIN, amount: 300n },
        ],
      });
      expect(outputs.map((o) => e.balanceOf(o, COIN))).toEqual([200n, 300n]);
      expect(await e.isSpent(src)).toBe(true);
    });

    it('rejects a non-conserving split', async () => {
      const e = makeEngine();
      const src = await mintTo(e, PK_A, 500n);
      await expect(
        e.split({ token: src, outputs: [{ recipientPubkey: PK_B, coinId: COIN, amount: 200n }] }),
      ).rejects.toThrow();
    });

    it('encodeToken → decodeToken round-trips the value', async () => {
      const e = makeEngine();
      const t = await mintTo(e, PK_A, 7n);
      const back = await e.decodeToken(e.encodeToken(t));
      expect(e.readValue(back)).toEqual({ assets: [{ coinId: COIN, amount: 7n }] });
    });

    it('verify is ok for a fresh token and not-ok after it is spent', async () => {
      const e = makeEngine();
      const t = await mintTo(e, PK_A, 1n);
      expect((await e.verify(t)).ok).toBe(true);
      await e.transfer({ token: t, recipientPubkey: PK_B });
      expect((await e.verify(t)).ok).toBe(false);
    });
  });
}
