import { describe, expect, it } from 'vitest';

import { NetworkId } from '../../../token-engine/sdk';
import { createTestEngine, freshPubkey } from './test-engine';

const COIN_A = 'a'.repeat(64);
const COIN_B = 'b'.repeat(64);
const COIN_C = 'c'.repeat(64);

// Edge cases hardening the real engine (token-engine territory only).
describe('SphereTokenEngine — hardening / edge cases', () => {
  it('mints a multi-coin token; balanceOf is per-coin', async () => {
    const e = createTestEngine();
    const token = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN_A, amount: 100n }, { coinId: COIN_B, amount: 50n }] },
    });
    expect(e.balanceOf(token, COIN_A)).toBe(100n);
    expect(e.balanceOf(token, COIN_B)).toBe(50n);
    expect(e.balanceOf(token, COIN_C)).toBe(0n);
    expect(e.readValue(token)).toEqual({
      assets: [{ coinId: COIN_A, amount: 100n }, { coinId: COIN_B, amount: 50n }],
    });
  }, 15000);

  it('round-trips a very large amount (no precision loss)', async () => {
    const e = createTestEngine();
    const amount = 2n ** 200n;
    const token = await e.mint({ recipientPubkey: e.getIdentity().chainPubkey, value: { assets: [{ coinId: COIN_A, amount }] } });
    expect(e.balanceOf(token, COIN_A)).toBe(amount);
    const back = await e.decodeToken(e.encodeToken(token));
    expect(e.balanceOf(back, COIN_A)).toBe(amount);
  }, 15000);

  it('refuses to transfer a token the engine does not own (fail fast)', async () => {
    const e = createTestEngine();
    const foreign = await e.mint({ recipientPubkey: freshPubkey(), value: { assets: [{ coinId: COIN_A, amount: 1n }] } });
    await expect(e.transfer({ token: foreign, recipientPubkey: freshPubkey() })).rejects.toThrow(/own/i);
  }, 15000);

  it('rejects a transfer to an invalid recipient public key', async () => {
    const e = createTestEngine();
    const own = await e.mint({ recipientPubkey: e.getIdentity().chainPubkey, value: { assets: [{ coinId: COIN_A, amount: 1n }] } });
    await expect(e.transfer({ token: own, recipientPubkey: new Uint8Array(33).fill(0xb2) })).rejects.toThrow();
  }, 15000);

  it('rejects decoding a token minted on a different network', async () => {
    const local = createTestEngine(); // NetworkId.LOCAL
    const blob = local.encodeToken(
      await local.mint({ recipientPubkey: local.getIdentity().chainPubkey, value: { assets: [{ coinId: COIN_A, amount: 1n }] } }),
    );
    const otherNetwork = createTestEngine({ networkId: NetworkId.TESTNET });
    await expect(otherNetwork.decodeToken(blob)).rejects.toThrow(/network/i);
  }, 15000);

  it('splits into three value-conserving outputs', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const src = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: 100n }] } });
    const { outputs } = await e.split({
      token: src,
      outputs: [
        { recipientPubkey: self, coinId: COIN_A, amount: 30n },
        { recipientPubkey: freshPubkey(), coinId: COIN_A, amount: 30n },
        { recipientPubkey: freshPubkey(), coinId: COIN_A, amount: 40n },
      ],
    });
    expect(outputs).toHaveLength(3);
    expect(outputs.reduce((sum, o) => sum + e.balanceOf(o, COIN_A), 0n)).toBe(100n);
  }, 30000);

  it('split preserves output ORDER despite parallel minting (#684)', async () => {
    // The mint legs are minted in parallel (Promise.allSettled). Distinct amounts make
    // the returned order verifiable per index — a regression guard that parallelizing did
    // not reorder outputs vs. the requested order (index-aligned settled.map).
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const src = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: 100n }] } });
    const requested = [10n, 20n, 30n, 40n];
    const { outputs } = await e.split({
      token: src,
      outputs: requested.map((amount) => ({ recipientPubkey: freshPubkey(), coinId: COIN_A, amount })),
    });
    expect(outputs.map((o) => e.balanceOf(o, COIN_A))).toEqual(requested); // exact order, not just sum
  }, 30000);

  it('rejects minting a negative or malformed value', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    await expect(e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: -1n }] } })).rejects.toThrow();
    await expect(e.mint({ recipientPubkey: self, value: { assets: [{ coinId: 'nothex', amount: 1n }] } })).rejects.toThrow();
  }, 15000);
});
