/**
 * Part E — recoverable engine (sdk-changes E.1/E.2/E.3, ARCHITECTURE §8.1).
 *
 * Runs the REAL SphereTokenEngine over the vendored in-memory
 * TestAggregatorClient, whose first-write-wins duplicate submit + proof
 * re-fetch is the target aggregator contract for E.2.
 *
 * Split legs note: per-output salts/tokenIds AND the burn mask are fully
 * deterministic (st-sdk#125 burnStateMask + EngineOpOptions.opIndex), so a
 * MID-split resume — re-running after the burn certified but before the mint
 * legs landed — completes. A FULL re-run after the mint legs certified is the
 * KNOWN GAP sphere-sdk#501: the aggregator rebuilds inclusion proofs from the
 * live tree per request (st-sdk#126, owner analysis), so rebuilt mint
 * transactions embed a byte-different burn proof and their hashes mismatch
 * the certified leaves → TransferConflictError. Both behaviors are pinned
 * below.
 */

import { describe, expect, it } from 'vitest';

import { TransferConflictError } from '../../../token-engine/errors';
import { deriveRealization } from '../../../token-engine/realization';
import {
  type CertificationData,
  type CertificationResponse,
  HexConverter,
  type IAggregatorClient,
  InclusionProofVerificationStatus,
  type InclusionProofResponse,
  PredicateVerifierService,
  SignaturePredicate,
  SigningService,
  type StateId,
  StateTransitionClient,
  TransferTransaction,
  waitInclusionProof,
} from '../../../token-engine/sdk';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine, freshPubkey } from './test-engine';

const COIN = 'a'.repeat(64);

/** Forwards the submit, then throws — the "response-parse failure" shape of E.2
 * (e.g. the live gateway's transitional STATE_ID_EXISTS, which this SDK's
 * CertificationResponse.fromJSON cannot parse). The certification EXISTS. */
class SubmitForwardsThenThrowsClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public async submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    await this.inner.submitCertificationRequest(certificationData);
    throw new Error('CertificationResponse.fromJSON: unknown certification status STATE_ID_EXISTS');
  }
}

/** Forwards the FIRST submit (the burn), then crashes — a wallet dying
 * mid-split after the burn certified but before any mint leg reached the
 * aggregator. The resume-side of sphere-sdk#501's working case. */
class CrashAfterBurnClient implements IAggregatorClient {
  private submits = 0;

  public constructor(private readonly inner: TestAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public submitCertificationRequest(certificationData: CertificationData): Promise<CertificationResponse> {
    if (this.submits++ > 0) {
      return Promise.reject(new Error('wallet crashed mid-split (simulated)'));
    }
    return this.inner.submitCertificationRequest(certificationData);
  }
}

/** Submit never reaches the aggregator — a genuine submit failure (no proof will exist). */
class SubmitUnreachableClient implements IAggregatorClient {
  public constructor(private readonly inner: TestAggregatorClient) {}

  public getInclusionProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  public submitCertificationRequest(): Promise<CertificationResponse> {
    return Promise.reject(new Error('aggregator unreachable (simulated)'));
  }
}

describe('recoverable engine (Part E) — real adapter over in-memory aggregator', () => {
  // AC-E1 (transfer leg) + the AC-E2 mock-resume shape: the duplicate submit is
  // absorbed first-write-wins, the existing proof match-verifies, and the
  // re-run returns the byte-identical finished token — no funds lost.
  it('AC-E1/AC-E2: re-running a transfer with the same transferId returns byte-identical results', async () => {
    const e = createTestEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    const recipientPubkey = freshPubkey();
    const transferId = crypto.randomUUID();

    const first = await e.transfer({ token: src, recipientPubkey }, { transferId });
    // Same transferId + same inputs, against the same aggregator: this is the
    // resume path (an interrupted attempt whose certification already landed).
    const second = await e.transfer({ token: src, recipientPubkey }, { transferId });

    expect(second.blob.tokenId).toBe(first.blob.tokenId);
    expect(HexConverter.encode(second.blob.token)).toBe(HexConverter.encode(first.blob.token));
    expect((await e.verify(second)).ok).toBe(true);
  }, 20000);

  // AC-E4: the same source consumed under DIFFERENT transferIds is a lost race,
  // not a resume — the proof kept by the aggregator (first leaf wins) does not
  // match the second rebuilt transaction.
  it('AC-E4: a second transfer of the same source under a different transferId throws TransferConflictError', async () => {
    const e = createTestEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    await e.transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });

    const err = await e
      .transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(err).toBeInstanceOf(TransferConflictError);
    expect((err as TransferConflictError).code).toBe('TRANSFER_CONFLICT');

    // The race is lost for that source only: a re-plan under a new transferId
    // succeeds for the remaining sources.
    const other = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 5n }] },
    });
    const replanned = await e.transfer({ token: other, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });
    expect((await e.verify(replanned)).ok).toBe(true);
  }, 25000);

  // AC-E3: deterministic realization is invisible downstream — the transferred
  // token and every split output still fully verify.
  it('AC-E3: deterministically-realized transfer and split outputs pass engine.verify', async () => {
    const e = createTestEngine();
    const self = e.getIdentity().chainPubkey;
    const transferId = crypto.randomUUID();

    const srcA = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 10n }] } });
    const transferred = await e.transfer({ token: srcA, recipientPubkey: freshPubkey() }, { transferId });
    expect((await e.verify(transferred)).ok).toBe(true);

    const srcB = await e.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const { outputs } = await e.split(
      {
        token: srcB,
        outputs: [
          { recipientPubkey: freshPubkey(), coinId: COIN, amount: 60n },
          { recipientPubkey: self, coinId: COIN, amount: 40n },
        ],
      },
      { transferId: crypto.randomUUID() },
    );
    expect(outputs).toHaveLength(2);
    for (const o of outputs) {
      expect((await e.verify(o)).ok).toBe(true);
    }
  }, 30000);

  // Split determinism (burn excluded — #492): the same wallet key + transferId
  // reproduce the same per-output salts and (salt-derived) tokenIds on a second
  // device/chain. Two aggregators sharing one trust-base key stand in for
  // "another device rebuilding the same split".
  it('split: same transferId reproduces identical per-output salts and tokenIds', async () => {
    const aggregatorKey = SigningService.generatePrivateKey();
    const walletKey = SigningService.generatePrivateKey();
    const engineA = createTestEngine({ aggregator: TestAggregatorClient.create(aggregatorKey), privateKey: walletKey });
    const engineB = createTestEngine({ aggregator: TestAggregatorClient.create(aggregatorKey), privateKey: walletKey });

    const self = engineA.getIdentity().chainPubkey;
    const payee = freshPubkey();
    const srcA = await engineA.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const srcB = await engineB.decodeToken(engineA.encodeToken(srcA));

    const transferId = crypto.randomUUID();
    const outputs = [
      { recipientPubkey: payee, coinId: COIN, amount: 70n },
      { recipientPubkey: self, coinId: COIN, amount: 30n },
    ];
    const runA = await engineA.split({ token: srcA, outputs }, { transferId });
    const runB = await engineB.split({ token: srcB, outputs }, { transferId });

    expect(runA.outputs.map((o) => engineA.tokenId(o))).toEqual(runB.outputs.map((o) => engineB.tokenId(o)));
    for (let i = 0; i < runA.outputs.length; i++) {
      const saltA = runA.outputs[i].sdkToken.genesis.salt.toBytes();
      const saltB = runB.outputs[i].sdkToken.genesis.salt.toBytes();
      // Identical across runs AND equal to the spec derivation for index i.
      expect(HexConverter.encode(saltA)).toBe(HexConverter.encode(saltB));
      expect(HexConverter.encode(saltA)).toBe(
        HexConverter.encode(deriveRealization(HexConverter.encode(walletKey), transferId, i, 'salt')),
      );
    }
    // Distinct outputs of one split must not share a salt (index domain separation).
    expect(HexConverter.encode(runA.outputs[0].sdkToken.genesis.salt.toBytes())).not.toBe(
      HexConverter.encode(runA.outputs[1].sdkToken.genesis.salt.toBytes()),
    );

  }, 40000);

  // The WORKING split resume (sdk-changes E.2): the wallet dies after the
  // burn certified but before any mint leg landed. Re-running with the same
  // {transferId} rebuilds the byte-identical burn (deterministic
  // burnStateMask — duplicate submit absorbed first-write-wins, the
  // refetched proof match-verifies because the certified transactionHash is
  // stable), then submits the mint legs fresh: the split completes and every
  // output verifies. This is ALSO the burn-determinism proof — a random burn
  // mask would rebuild a different burn transaction and the resume would
  // throw TransferConflictError instead of completing.
  it('split resume: a crash after burn certification completes on re-run with the same transferId', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const crashing = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new CrashAfterBurnClient(aggregator),
    });
    const plain = createTestEngine({ aggregator, privateKey: walletKey });

    const self = plain.getIdentity().chainPubkey;
    const src = await plain.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = [
      { recipientPubkey: freshPubkey(), coinId: COIN, amount: 60n },
      { recipientPubkey: self, coinId: COIN, amount: 40n },
    ];

    await expect(
      // Short proof-poll budget: the crashed mint submits leave no proof to find.
      crashing.split({ token: src, outputs }, { transferId, signal: AbortSignal.timeout(2000) }),
    ).rejects.toThrow('wallet crashed mid-split (simulated)');

    const resumed = await plain.split({ token: src, outputs }, { transferId });
    expect(resumed.outputs).toHaveLength(2);
    expect(resumed.outputs.map((o) => plain.balanceOf(o, COIN))).toEqual([60n, 40n]);
    for (const o of resumed.outputs) {
      expect((await plain.verify(o)).ok).toBe(true);
    }
  }, 40000);

  // KNOWN GAP sphere-sdk#501, pinned: a FULL re-run after the mint legs
  // certified cannot recover. The aggregator rebuilds inclusion proofs from
  // the live tree per request (st-sdk#126 — only CertificationData is
  // stable), so the rebuilt mint transactions embed a byte-different burn
  // proof; their transactionHashes mismatch the certified leaves and E.2's
  // match-verify throws TransferConflictError. FLIP this test to assert
  // recovery once the #501 persistence design (durable burn-certified split
  // progress) lands.
  it('split full re-run after certified mints throws TransferConflictError (#501 known gap)', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator });
    const self = engine.getIdentity().chainPubkey;
    const src = await engine.mint({ recipientPubkey: self, value: { assets: [{ coinId: COIN, amount: 100n }] } });
    const transferId = crypto.randomUUID();
    const outputs = [
      { recipientPubkey: freshPubkey(), coinId: COIN, amount: 70n },
      { recipientPubkey: self, coinId: COIN, amount: 30n },
    ];

    const first = await engine.split({ token: src, outputs }, { transferId });
    expect(first.outputs).toHaveLength(2);

    const err = await engine.split({ token: src, outputs }, { transferId }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(TransferConflictError);
    expect((err as TransferConflictError).code).toBe('TRANSFER_CONFLICT');
  }, 40000);

  // E.2 status-agnostic submit: a submit that THROWS (response-parse failure)
  // after the certification landed is absorbed — the proof is fetched,
  // match-verified and applied. Resume never keys off a submit status.
  it('E.2: a throwing submit whose certification exists still completes via proof fetch + match-verify', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const flaky = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new SubmitForwardsThenThrowsClient(aggregator),
    });

    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 42n }] },
    });
    const finished = await flaky.transfer(
      { token: src, recipientPubkey: freshPubkey() },
      { transferId: crypto.randomUUID() },
    );
    expect(plain.balanceOf(finished, COIN)).toBe(42n);
    expect((await plain.verify(finished)).ok).toBe(true);
  }, 20000);

  // E.2 third arm: no certification ever landed AND the submit failed — the
  // ORIGINAL submit error surfaces (a genuine failure, not a resume case).
  it('E.2: a failed submit with no existing proof rethrows the original submit error', async () => {
    const aggregator = TestAggregatorClient.create();
    const walletKey = SigningService.generatePrivateKey();
    const plain = createTestEngine({ aggregator, privateKey: walletKey });
    const dead = createTestEngine({
      aggregator,
      privateKey: walletKey,
      wireClient: new SubmitUnreachableClient(aggregator),
    });

    const src = await plain.mint({
      recipientPubkey: plain.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 1n }] },
    });
    await expect(
      dead.transfer(
        { token: src, recipientPubkey: freshPubkey() },
        // Short proof-poll budget: with no certification the probe can only time out.
        { transferId: crypto.randomUUID(), signal: AbortSignal.timeout(500) },
      ),
    ).rejects.toThrow('aggregator unreachable (simulated)');
  }, 20000);

  // Pins the EXACT SDK error surface the engine maps to TransferConflictError:
  // waitInclusionProof rejects a mismatching proof with a generic Error whose
  // message embeds the verification status. If upstream changes this string,
  // this test fails loudly — update the mapping in SphereTokenEngine alongside.
  it('pins the SDK conflict surface: waitInclusionProof throws the TRANSACTION_HASH_MISMATCH message', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({ aggregator });
    const src = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 9n }] },
    });
    await engine.transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });

    // A DIFFERENT transaction for the already-consumed source state.
    const foreignTx = await TransferTransaction.create(
      src.sdkToken,
      SignaturePredicate.create(freshPubkey()),
      new Uint8Array(32).fill(7),
      null,
    );
    const err = await waitInclusionProof(
      new StateTransitionClient(aggregator),
      aggregator.rootTrustBase,
      PredicateVerifierService.create(),
      foreignTx,
      AbortSignal.timeout(2000),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `Invalid inclusion proof status: ${InclusionProofVerificationStatus.TRANSACTION_HASH_MISMATCH}`,
    );
  }, 20000);

  it('rejects a non-canonical transferId before any network work', async () => {
    const e = createTestEngine();
    const src = await e.mint({
      recipientPubkey: e.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 1n }] },
    });
    for (const bad of ['not-a-uuid', '123E4567-E89B-42D3-A456-426614174000', 'a:b:c']) {
      await expect(e.transfer({ token: src, recipientPubkey: freshPubkey() }, { transferId: bad })).rejects.toThrow(
        /canonical lowercase UUID/,
      );
    }
  }, 15000);
});
