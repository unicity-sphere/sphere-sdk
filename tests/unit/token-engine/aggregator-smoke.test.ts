import { describe, expect, it } from 'vitest';

import {
  CertificationData,
  CertificationStatus,
  MintJustificationVerifierService,
  MintTransaction,
  NetworkId,
  PredicateVerifierService,
  SignaturePredicate,
  SigningService,
  StateTransitionClient,
  Token,
  TokenIssuanceVerifierService,
  VerificationContext,
  waitInclusionProof,
} from '../../../token-engine/sdk';
import { TestAggregatorClient } from './support/TestAggregatorClient';

// Proves the vendored in-memory aggregator drives a REAL v2 mint end-to-end:
// build -> certify -> submit -> wait proof -> certified -> Token.mint. This is
// the harness Track A's real engine + the contract suite will run against.
describe('TestAggregatorClient (vendored) — real v2 mint round-trip', () => {
  it('mints a token through the in-memory aggregator', async () => {
    const aggregator = TestAggregatorClient.create();
    const client = new StateTransitionClient(aggregator);
    const trustBase = aggregator.rootTrustBase;
    const predicateVerifier = PredicateVerifierService.create();
    const mintJustificationVerifier = new MintJustificationVerifierService();

    const owner = SigningService.generate();
    const recipient = SignaturePredicate.fromSigningService(owner);

    const mintTx = await MintTransaction.create(NetworkId.LOCAL, recipient);
    const certData = await CertificationData.fromMintTransaction(mintTx);

    const response = await client.submitCertificationRequest(certData);
    expect(response.status).toBe(CertificationStatus.SUCCESS);

    const proof = await waitInclusionProof(client, trustBase, predicateVerifier, mintTx);
    const certified = await mintTx.toCertifiedTransaction(trustBase, predicateVerifier, proof);
    const token = await Token.mint(
      certified,
      new VerificationContext(trustBase, predicateVerifier, mintJustificationVerifier, new TokenIssuanceVerifierService(false)),
    );

    expect(token).toBeInstanceOf(Token);
  }, 15000);
});
