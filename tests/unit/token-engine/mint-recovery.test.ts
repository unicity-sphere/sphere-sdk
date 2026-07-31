/**
 * #692 F13 — recoverable mint (defect class 9: "did it certify?" must never be
 * inferred from a submit error/status).
 *
 * mint/mintDataToken route through the same idempotent submit-then-always-probe
 * primitive as transfer/split (E.2 four-outcome path): OK-match = mine
 * (interrupted mint recovered), mismatch = typed conflict (never applied),
 * proven clean reject = submit error, inconclusive = ProofUnconfirmedError
 * (keep-open). Runs against the adversarial re-submit fake: the wire status of
 * a re-submit carries NO signal (unknown status, or the live gateway's SUCCESS
 * lie), so recovery here proves the probe — not the status — decided.
 */

import { describe, expect, it } from 'vitest';

import { ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import { deriveRealization } from '../../../token-engine/realization';
import {
  type CertificationData,
  type CertificationResponse,
  HexConverter,
  type IAggregatorClient,
  type InclusionProofResponse,
  SigningService,
} from '../../../token-engine/sdk';
import {
  ADVERSARIAL_UNKNOWN_STATUS,
  AdversarialResubmitClient,
  type ResubmitLie,
} from './support/AdversarialResubmitClient';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine } from './test-engine';

const COIN = 'b'.repeat(64);

/** Submit LANDS (certification exists) but the proof fetch throws — a kill mid-mint (#631 window). */
class ProofFetchThrowsClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    return this.inner.submitCertificationRequest(certificationData);
  }

  public getInclusionProof(): Promise<InclusionProofResponse> {
    return Promise.reject(new Error('proof fetch failed: process killed (simulated)'));
  }
}

describe('mint recovery (#692 F13) — real adapter over the adversarial re-submit aggregator', () => {
  it("unknown-status re-submit: same-transferId re-mint recovers the byte-identical token via the proof probe (salt in the 'mint' HKDF domain, not 'salt' — that domain is split-output-indexed and collides under a shared transferId), never AGGREGATOR_ERROR", async () => {
    const aggregator = TestAggregatorClient.create();
    const adversarial = new AdversarialResubmitClient(aggregator);
    const walletKey = SigningService.generatePrivateKey();
    const e = createTestEngine({ aggregator, privateKey: walletKey, wireClient: adversarial });
    const params = {
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    };
    const transferId = crypto.randomUUID();

    const first = await e.mint(params, { transferId });
    const second = await e.mint(params, { transferId });

    expect(HexConverter.encode(second.blob.token)).toBe(HexConverter.encode(first.blob.token));
    expect(second.blob.tokenId).toBe(first.blob.tokenId);
    expect((await e.verify(second)).ok).toBe(true);
    expect(e.balanceOf(second, COIN)).toBe(100n);

    // The wire answered an UNKNOWN status to the re-submit — recovery came from the probe.
    const resubmit = adversarial.submits.at(-1);
    expect(resubmit?.kind).toBe('resubmit-duplicate');
    expect(resubmit?.wireStatus).toBe(ADVERSARIAL_UNKNOWN_STATUS);

    // Domain-separation pin: the mint salt is HKDF('mint', opIndex), NOT HKDF('salt', 0).
    const salt = first.sdkToken.genesis.salt.toBytes();
    const keyHex = HexConverter.encode(walletKey);
    expect(HexConverter.encode(salt)).toBe(HexConverter.encode(deriveRealization(keyHex, transferId, 0, 'mint')));
    expect(HexConverter.encode(salt)).not.toBe(HexConverter.encode(deriveRealization(keyHex, transferId, 0, 'salt')));
  }, 20000);

  it('kill mid-mint: submit landed but the proof fetch failed → keep-open ProofUnconfirmedError; a re-call with the same transferId recovers the SAME token (proof probe OK-match)', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const dying = createTestEngine({ aggregator, privateKey: walletKey, wireClient: new ProofFetchThrowsClient(aggregator) });
    const resumed = createTestEngine({ aggregator, privateKey: walletKey });
    const params = {
      recipientPubkey: resumed.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 42n }] },
    };
    const transferId = crypto.randomUUID();

    const err = await dying.mint(params, { transferId }).then(
      () => null,
      (caught: unknown) => caught,
    );
    // The certification MAY be on-chain (it is): keep-open, never a clean AGGREGATOR_ERROR abort.
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).code).toBe('CERTIFICATION_UNCONFIRMED');
    expect((err as ProofUnconfirmedError).mayHaveCertified).toBe(true);

    // Resume on a healthy client (default adversarial wire: the re-submit still lies).
    const token = await resumed.mint(params, { transferId });
    expect(resumed.balanceOf(token, COIN)).toBe(42n);
    expect((await resumed.verify(token)).ok).toBe(true);
    expect(await resumed.isSpent(token)).toBe(false);
  }, 20000);

  it.each<ResubmitLie>(['unknown-status', 'success'])(
    'foreign certification at the mint stateId (re-submit lie: %s) → TransferConflictError, never applied',
    async (lie) => {
      const aggregator = TestAggregatorClient.create();
      const adversarial = new AdversarialResubmitClient(aggregator, lie);
      const e = createTestEngine({ aggregator, wireClient: adversarial });
      const self = e.getIdentity().chainPubkey;
      const transferId = crypto.randomUUID();

      // Same transferId ⇒ same HKDF salt ⇒ same tokenId/stateId; a DIFFERENT value ⇒ a
      // different transaction — the certified leaf no longer matches what we rebuild.
      const first = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } }, { transferId });
      const err = await e
        .mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 50n }] } }, { transferId })
        .then(() => null, (caught: unknown) => caught);

      expect(err).toBeInstanceOf(TransferConflictError);
      expect((err as TransferConflictError).code).toBe('TRANSFER_CONFLICT');
      expect(err).not.toBeInstanceOf(ProofUnconfirmedError);
      expect(adversarial.submits.at(-1)?.kind).toBe('resubmit-conflict');
      // Never applied: the first (certified) token is untouched and still unspent.
      expect((await e.verify(first)).ok).toBe(true);
      expect(await e.isSpent(first)).toBe(false);
    },
    20000,
  );

  it('mintDataToken interrupted (proof fetch failed) → re-call with the same explicit salt recovers the token', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const dying = createTestEngine({ aggregator, privateKey: walletKey, wireClient: new ProofFetchThrowsClient(aggregator) });
    const resumed = createTestEngine({ aggregator, privateKey: walletKey });
    const params = {
      recipientPubkey: resumed.getIdentity().chainPubkey,
      data: new Uint8Array([1, 2, 3, 4]),
      tokenType: new Uint8Array(32).fill(1),
      salt: new Uint8Array(32).fill(7),
    };

    const err = await dying.mintDataToken(params).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).mayHaveCertified).toBe(true);

    const token = await resumed.mintDataToken(params);
    expect(resumed.readValue(token)).toBeNull();
    expect(resumed.readTokenData(token)).toEqual(params.data);
    expect(resumed.tokenId(token)).toMatch(/^[0-9a-f]{64}$/);
    expect((await resumed.verify(token)).ok).toBe(true);
  }, 20000);
});
