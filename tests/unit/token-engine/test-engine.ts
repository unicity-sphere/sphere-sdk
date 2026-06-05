/**
 * Shared test harness: build a real SphereTokenEngine over the in-memory
 * TestAggregatorClient (with the split-justification verifier registered).
 * Used by SphereTokenEngine.test.ts + the hardening tests.
 */

import {
  MintJustificationVerifierService,
  NetworkId,
  PredicateVerifierService,
  SigningService,
  SplitMintJustificationVerifier,
  StateTransitionClient,
} from '../../../token-engine/sdk';
import { decodeSpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { type EngineDeps, SphereTokenEngine } from '../../../token-engine/SphereTokenEngine';
import { TestAggregatorClient } from './support/TestAggregatorClient';

/**
 * Build a real engine backed by a fresh in-memory aggregator.
 * `networkId` can be overridden to exercise cross-network guards.
 */
export function createTestEngine(opts: { networkId?: NetworkId } = {}): SphereTokenEngine {
  const aggregator = TestAggregatorClient.create();
  const trustBase = aggregator.rootTrustBase;
  const predicateVerifier = PredicateVerifierService.create();
  const mintJustificationVerifier = new MintJustificationVerifierService();
  mintJustificationVerifier.register(
    new SplitMintJustificationVerifier(trustBase, predicateVerifier, decodeSpherePaymentData),
  );
  const deps: EngineDeps = {
    client: new StateTransitionClient(aggregator),
    trustBase,
    predicateVerifier,
    mintJustificationVerifier,
    signingService: new SigningService(SigningService.generatePrivateKey()),
    networkId: opts.networkId ?? NetworkId.LOCAL,
  };
  return new SphereTokenEngine(deps);
}

/** A fresh, valid compressed secp256k1 public key the engine does NOT own. */
export function freshPubkey(): Uint8Array {
  return new SigningService(SigningService.generatePrivateKey()).publicKey;
}
