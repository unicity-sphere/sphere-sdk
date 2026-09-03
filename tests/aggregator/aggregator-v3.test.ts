/**
 * The real engine against a REAL aggregator-go v3, started by Testcontainers.
 *
 * Every other suite that exercises the chain runs on `TestAggregatorClient`,
 * which orchestrates the SDK's own SMT, CertificationData and verification rule.
 * That proves this client is self-consistent. It cannot prove the client and the
 * SERVICE agree, because both sides were built from the same written spec and a
 * spec can be read two ways. The 3.x cutover is a flag day with no straddle
 * window, so that is the one disagreement there is no cheap recovery from.
 *
 * What this pins that a fake cannot: `verify()` passing means the leaf value this
 * client computes — H(transactionHash, referenceTime) in 3.x, where 2.x used the
 * bare transaction hash — reproduces the leaf the Go service actually inserted,
 * and that the BFT certificate chains to the trust base the service generated.
 *
 *   npm run test:aggregator      # needs Docker; pulls pinned images, no local build
 *
 * The compose and its harness are shared with state-transition-sdk-js and the
 * Java SDK, so all three exercise one service build.
 */

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSphereTokenEngine, type ITokenEngine } from '../../token-engine';
import {
  HexConverter,
  InclusionProofVerificationStatus,
  RootTrustBase,
  SigningService,
  VerificationStatus,
} from '../../token-engine/sdk';
import { startAggregatorStack, type AggregatorStack } from './support/aggregatorStack';
import { flattenTrace, verificationContextFor, withWrongRootKeys } from './support/trustBase';

const COIN = 'aa'.repeat(32);

let stack: AggregatorStack;
let trustBaseJson: unknown;

beforeAll(async () => {
  stack = await startAggregatorStack();
  trustBaseJson = JSON.parse(readFileSync(stack.trustBasePath, 'utf8'));
}, 300_000);

afterAll(async () => {
  await stack?.stop();
}, 120_000);

/** @param trustBase Defaults to the stack's real trust base; the vacuity guard passes a doctored one. */
function newEngine(trustBase: unknown = trustBaseJson): Promise<ITokenEngine> {
  return createSphereTokenEngine({
    aggregatorUrl: stack.url,
    trustBaseJson: trustBase,
    privateKey: SigningService.generatePrivateKey(),
    proofTimeoutMs: 30_000,
    proofPollIntervalMs: 500,
  });
}

const uuid = (): string => crypto.randomUUID();

describe('engine ↔ real aggregator-go v3', () => {
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
    // The assertion no fake can make: our leaf reproduces the service's.
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
    // A separate engine with its own verification context — the receive path's gate.
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
    // Split outputs carry a mint justification the service never decodes, so
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

  // The guard against every `{ ok: true }` above being vacuous. A verify() that
  // never consulted the trust base would pass all four; only a NO it can be made
  // to say proves it looked. The token is genuinely certified by the running
  // service — the sole defect is the key the seal's signatures are checked against.
  it('refuses that same certified token when the trust base carries a WRONG root key', async () => {
    const engine = await newEngine();
    const token = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 5n }] },
    });
    // Both directions in one run: a suite that only ever showed a failure would
    // stay green if verification rejected everything.
    expect(await engine.verify(token)).toEqual({ ok: true });

    const wrongJson = withWrongRootKeys(trustBaseJson);
    const real = RootTrustBase.fromJSON(trustBaseJson);
    const wrong = RootTrustBase.fromJSON(wrongJson);
    // Well-formed, and identical everywhere the certificate verifier looks before
    // it reaches a signature — so nothing but the key can explain the refusal.
    expect(wrong.networkId.id).toBe(real.networkId.id);
    expect(wrong.quorumThreshold).toBe(real.quorumThreshold);
    expect([...wrong.rootNodes.keys()]).toEqual([...real.rootNodes.keys()]);
    for (const [nodeId, node] of wrong.rootNodes) {
      expect(SigningService.isPublicKeyValid(node.signingKey)).toBe(true);
      expect(HexConverter.encode(node.signingKey)).not.toBe(
        HexConverter.encode(real.rootNodes.get(nodeId)!.signingKey),
      );
    }

    // 1. The gate the money path actually calls (receive/Receive.ts screens on it).
    //    It reports only the aggregated status, so this proves refusal, not cause.
    const wrongEngine = await newEngine(wrongJson);
    expect(await wrongEngine.verify(token)).toEqual({ ok: false, reason: VerificationStatus.FAIL });

    // 2. The cause, from the trace the port collapses. Running the CORRECT trust
    //    base through the same reconstructed context first is what makes the
    //    reconstruction trustworthy: a miswired context would fail here too.
    const okTrace = flattenTrace(await token.sdkToken.verify(verificationContextFor(trustBaseJson)));
    expect(okTrace[0].status).toBe(VerificationStatus.OK);
    expect(okTrace.map((entry) => entry.status)).not.toContain(InclusionProofVerificationStatus.INVALID_TRUSTBASE);

    const failTrace = flattenTrace(await token.sdkToken.verify(verificationContextFor(wrongJson)));
    expect(failTrace[0].status).toBe(VerificationStatus.FAIL);
    expect(failTrace.map((entry) => entry.status)).toContain(InclusionProofVerificationStatus.INVALID_TRUSTBASE);
    // Failed ON THE KEY: the node was found and its signature rejected. A lookup
    // miss ('No root node defined') would reach INVALID_TRUSTBASE too, while
    // proving only that an unknown node id is unknown.
    expect(
      failTrace.some(
        (entry) =>
          entry.rule.startsWith('SignatureVerificationRule[') &&
          entry.status === VerificationStatus.FAIL &&
          entry.message === 'Signature verification failed',
      ),
    ).toBe(true);
    expect(failTrace.map((entry) => entry.message)).not.toContain('No root node defined');
  }, 120_000);
});
