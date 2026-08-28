/**
 * The real engine against a REAL aggregator-go v3 service.
 *
 * Every other suite that exercises v3 runs against `TestAggregatorClient`, which
 * is faithful to the *SDK* — it orchestrates the SDK's own SMT, CertificationData
 * and verification rule. That proves this client is self-consistent. It cannot
 * prove the client and the SERVICE agree, because both sides were built to the
 * same written spec and a spec can be read two ways. The 3.x cutover is a flag
 * day with no straddle window, so that is the one disagreement there is no cheap
 * recovery from.
 *
 * What this pins that a fake cannot: `verify()` passing means the leaf value this
 * client computes — H(transactionHash, referenceTime) in 3.x, where 2.x used the
 * bare transaction hash — reproduces the leaf the Go service actually inserted,
 * and that the BFT certificate chains to the trust base the service generated.
 *
 * Run it:
 *   cd ../aggregator-go && make docker-run-clean     # brings up root + aggregator on :3000
 *   AGGREGATOR_URL=http://localhost:3000 \
 *   AGGREGATOR_TRUSTBASE=../aggregator-go/data/genesis/trust-base.json \
 *     npm run test:aggregator
 *
 * Skipped when those are unset, so it never blocks `npm run test:run`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createSphereTokenEngine, type ITokenEngine } from '../../token-engine';
import { SigningService } from '../../token-engine/sdk';

const AGGREGATOR_URL = process.env.AGGREGATOR_URL;
const TRUSTBASE_PATH = process.env.AGGREGATOR_TRUSTBASE;
const RUN = Boolean(AGGREGATOR_URL && TRUSTBASE_PATH);

const COIN = 'aa'.repeat(32);

function newEngine(): Promise<ITokenEngine> {
  return createSphereTokenEngine({
    aggregatorUrl: AGGREGATOR_URL!,
    trustBaseJson: JSON.parse(readFileSync(TRUSTBASE_PATH!, 'utf8')),
    privateKey: SigningService.generatePrivateKey(),
    proofTimeoutMs: 30_000,
    proofPollIntervalMs: 500,
    ...(process.env.AGGREGATOR_API_KEY ? { apiKey: process.env.AGGREGATOR_API_KEY } : {}),
  });
}

const uuid = (): string => crypto.randomUUID();

describe.runIf(RUN)('engine ↔ real aggregator-go v3', () => {
  it('mints, and the service-assigned reference time verifies against the real trust base', async () => {
    const engine = await newEngine();
    const minted = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });

    expect(engine.balanceOf(minted, COIN)).toBe(100n);
    // The policy, confirmed against a service that assigns its own deadline.
    expect(minted.sdkToken.genesis.expiresAt).toBeNull();
    // 3.x: the leaf binds this, and the service is the only party that can state it.
    expect(minted.sdkToken.genesis.referenceTime).toBeGreaterThan(0n);
    // The assertion that a fake cannot make: our leaf reproduces the service's.
    expect(await engine.verify(minted)).toEqual({ ok: true });
    expect(await engine.isSpent(minted)).toBe(false);
  }, 120_000);

  it('transfers, and the RECIPIENT independently verifies what the sender produced', async () => {
    const sender = await newEngine();
    const recipient = await newEngine();
    const src = await sender.mint({
      recipientPubkey: sender.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });

    const moved = await sender.transfer({ token: src, recipientPubkey: recipient.getIdentity().chainPubkey });

    expect(recipient.balanceOf(moved, COIN)).toBe(100n);
    // A separate engine, its own verification context — the receive path's gate.
    expect(await recipient.verify(moved)).toEqual({ ok: true });
    expect(await sender.isSpent(src)).toBe(true);
  }, 120_000);

  it('splits with value conserved, and both outputs verify', async () => {
    const engine = await newEngine();
    const other = await newEngine();
    const src = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 90n }] },
    });

    const { outputs } = await engine.split(
      {
        token: src,
        outputs: [
          { recipientPubkey: other.getIdentity().chainPubkey, coinId: COIN, amount: 40n },
          { recipientPubkey: engine.getIdentity().chainPubkey, coinId: COIN, amount: 50n },
        ],
      },
      { transferId: uuid() },
    );

    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([40n, 50n]);
    expect(await engine.isSpent(src)).toBe(true);
    // Split outputs carry a mint justification the service never sees decoded —
    // verifying them exercises the whole burn-and-justify chain end to end.
    expect(await Promise.all(outputs.map((o) => engine.verify(o)))).toEqual([{ ok: true }, { ok: true }]);
  }, 180_000);

  it('recovers the SAME transfer on a re-call under one transferId, never a second spend', async () => {
    // E.1 determinism against a real service. This is what the no-deadline policy
    // protects: a clock-derived expiresAt would rebuild a DIFFERENT transaction,
    // hit the same leaf with a different hash, and be reported as a foreign spend.
    const engine = await newEngine();
    const recipient = await newEngine();
    const src = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 7n }] },
    });
    const transferId = uuid();
    const to = recipient.getIdentity().chainPubkey;

    const first = await engine.transfer({ token: src, recipientPubkey: to }, { transferId });
    const resumed = await engine.transfer({ token: src, recipientPubkey: to }, { transferId });

    expect(Buffer.from(resumed.blob.token).equals(Buffer.from(first.blob.token))).toBe(true);
    expect(await recipient.verify(resumed)).toEqual({ ok: true });
  }, 180_000);
});
