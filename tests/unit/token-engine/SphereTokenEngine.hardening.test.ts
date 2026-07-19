import { afterEach, describe, expect, it, vi } from 'vitest';

import { SphereError } from '../../../core/errors';
import { NetworkId } from '../../../token-engine/sdk';
import { ProofUnconfirmedError, SplitCheckpointLostError } from '../../../token-engine/errors';
import { createTestEngine, freshPubkey } from './test-engine';

const COIN_A = 'a'.repeat(64);
const COIN_B = 'b'.repeat(64);
const COIN_C = 'c'.repeat(64);

// Edge cases hardening the real engine (token-engine territory only).
describe('SphereTokenEngine — hardening / edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
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

  it('split preserves output ORDER across bounded-concurrency batches (#684)', async () => {
    // The mint legs are minted in parallel with a concurrency cap (MAX_MINT_CONCURRENCY=8),
    // so >8 outputs span MULTIPLE batches. Distinct amounts make the returned order
    // verifiable per index — a regression guard that the batched, index-aligned settled.map
    // preserves the requested order (not just the value sum) across the batch boundary.
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const requested = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]; // 10 outputs (> the cap of 8) = 2 batches
    const total = requested.reduce((s, a) => s + a, 0n);
    const src = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: total }] } });
    const { outputs } = await e.split({
      token: src,
      outputs: requested.map((amount) => ({ recipientPubkey: freshPubkey(), coinId: COIN_A, amount })),
    });
    expect(outputs).toHaveLength(requested.length);
    expect(outputs.map((o) => e.balanceOf(o, COIN_A))).toEqual(requested); // exact order across batches
  }, 30000);

  // --- #684 parallel-mint error aggregation (Codex P1) ------------------------------------
  // The mint legs of a split now fan out in parallel, so — UNLIKE the old sequential loop —
  // a lower-index leg can fail while a higher-index leg was ALSO submitted and may be certified.
  // Surfacing the lowest-index CLEAN error there would let PaymentsModule abort the intent and
  // orphan the certified sibling (no checkpoint recovery). The aggregation must bias to keep-open.
  // These spy on the private per-leg mint so we control each leg's outcome; the map invokes the
  // legs of one batch synchronously in index order, so call #1 = leg 0, call #2 = leg 1.
  const twoOutputs = (self: Uint8Array) => [
    { recipientPubkey: freshPubkey(), coinId: COIN_A, amount: 40n },
    { recipientPubkey: self, coinId: COIN_A, amount: 60n },
  ];

  it('parallel split: a CLEAN leg failure alongside a CERTIFIED sibling surfaces keep-open, not the abortable clean error (#684)', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const src = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: 100n }] } });
    const proto = Object.getPrototypeOf(e);
    const orig = proto.mintSplitOutput;
    let call = 0;
    vi.spyOn(proto, 'mintSplitOutput').mockImplementation(function (this: unknown, ...args: unknown[]) {
      call += 1;
      // Leg 0 fails CLEAN (definitively not committed); leg 1 mints for real (certifies on-chain).
      if (call === 1) return Promise.reject(new SphereError('leg-0 gateway blip', 'AGGREGATOR_ERROR'));
      return orig.apply(e, args);
    });
    // Lowest-index rejection is CLEAN, but a sibling certified → MUST surface keep-open
    // (CERTIFICATION_UNCONFIRMED) so the intent stays open and resume recovers leg 1 idempotently.
    // If this reverts to 'throw the lowest-index rejection', it throws AGGREGATOR_ERROR and fails.
    await expect(e.split({ token: src, outputs: twoOutputs(self) })).rejects.toBeInstanceOf(ProofUnconfirmedError);
  }, 30000);

  it('parallel split: a CLEAN leg failure alongside a KEEP-OPEN sibling surfaces the keep-open error verbatim (#684)', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const src = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: 100n }] } });
    const proto = Object.getPrototypeOf(e);
    let call = 0;
    vi.spyOn(proto, 'mintSplitOutput').mockImplementation(function (this: unknown) {
      call += 1;
      // Leg 0 clean, leg 1 keep-open (higher index). The keep-open sibling must win.
      if (call === 1) return Promise.reject(new SphereError('leg-0 gateway blip', 'AGGREGATOR_ERROR'));
      return Promise.reject(new SplitCheckpointLostError('leg-1 checkpoint stale'));
    });
    // Reverting to lowest-index would throw AGGREGATOR_ERROR (abortable); the fix surfaces the
    // keep-open SplitCheckpointLostError so PaymentsModule keeps the intent open.
    await expect(e.split({ token: src, outputs: twoOutputs(self) })).rejects.toBeInstanceOf(SplitCheckpointLostError);
  }, 30000);

  it('parallel split: when EVERY mint leg fails cleanly after the burn CERTIFIED, keep the intent OPEN — aborting would strand the burnt source (audit#1)', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const src = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: 100n }] } });
    const proto = Object.getPrototypeOf(e);
    let call = 0;
    vi.spyOn(proto, 'mintSplitOutput').mockImplementation(function (this: unknown) {
      call += 1;
      // Both mint legs clean-reject; NOTHING mints. But the burn already certified (below).
      return Promise.reject(new SphereError(`leg-${call - 1} failed`, call === 1 ? 'AGGREGATOR_ERROR' : 'TRANSPORT_ERROR'));
    });
    // The burn commits on-chain BEFORE the mint fan-out (resolveBurntToken). Previously this case
    // surfaced the abortable clean error on the theory "no leg committed → the split failed" — but
    // that ignores the BURN: the source is already spent. Surfacing an abortable error lets
    // PaymentsModule abort the intent and STRAND the entire source (the burn cannot be undone, an
    // aborted intent never re-runs). Every post-burn failure must be keep-open so resume re-runs the
    // mints from the burn checkpoint — funds recoverable, not lost.
    await expect(e.split({ token: src, outputs: twoOutputs(self) })).rejects.toBeInstanceOf(ProofUnconfirmedError);
    // Proof the burn really committed (this is exactly why an abort here would strand the funds):
    // the source is now spent on-chain even though no mint certified.
    expect(await e.isSpent(src)).toBe(true);
  }, 30000);

  it('rejects minting a negative or malformed value', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    await expect(e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN_A, amount: -1n }] } })).rejects.toThrow();
    await expect(e.mint({ recipientPubkey: self, value: { assets: [{ coinId: 'nothex', amount: 1n }] } })).rejects.toThrow();
  }, 15000);
});
