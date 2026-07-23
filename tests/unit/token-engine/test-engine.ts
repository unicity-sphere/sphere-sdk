/**
 * Shared test harness: build a real SphereTokenEngine over the in-memory
 * TestAggregatorClient (with the split-justification verifier registered).
 * Used by SphereTokenEngine.test.ts + the hardening tests.
 */

import {
  type IAggregatorClient,
  MintJustificationVerifierService,
  NetworkId,
  PredicateVerifierService,
  SigningService,
  SplitMintJustificationVerifier,
  StateTransitionClient,
  TokenIssuanceVerifierService,
  VerificationContext,
} from '../../../token-engine/sdk';
import { decodeSpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { type EngineDeps, SphereTokenEngine } from '../../../token-engine/SphereTokenEngine';
import { TestAggregatorClient } from './support/TestAggregatorClient';

export interface TestEngineOptions {
  /** Override to exercise cross-network guards. */
  networkId?: NetworkId;
  /**
   * Reuse a specific in-memory aggregator (trust base + SMT). Lets two engines
   * share one chain (conflict tests) or two chains share one trust base
   * (determinism-across-devices tests via TestAggregatorClient.create(sameKey)).
   */
  aggregator?: TestAggregatorClient;
  /** Wallet private key (defaults to a fresh random key). */
  privateKey?: Uint8Array;
  /**
   * Optional wire-client wrapper around the aggregator for fault injection
   * (e.g. a submit that throws). Trust base still comes from `aggregator`.
   */
  wireClient?: IAggregatorClient;
}

/** Build a real engine backed by an in-memory aggregator (fresh by default). */
export function createTestEngine(opts: TestEngineOptions = {}): SphereTokenEngine {
  const aggregator = opts.aggregator ?? TestAggregatorClient.create();
  const trustBase = aggregator.rootTrustBase;
  const predicateVerifier = PredicateVerifierService.create();
  const mintJustificationVerifier = new MintJustificationVerifierService();
  mintJustificationVerifier.register(
      new SplitMintJustificationVerifier(decodeSpherePaymentData),
  );
  const privateKey = opts.privateKey ?? SigningService.generatePrivateKey();
  const deps: EngineDeps = {
    client: new StateTransitionClient(opts.wireClient ?? aggregator),
    trustBase,
    predicateVerifier,
    mintJustificationVerifier,
    verificationContext: new VerificationContext(
      trustBase,
      predicateVerifier,
      mintJustificationVerifier,
      new TokenIssuanceVerifierService(false),
    ),
    signingService: new SigningService(privateKey),
    privateKey,
    networkId: opts.networkId ?? NetworkId.LOCAL,
  };
  return new SphereTokenEngine(deps);
}

/** A fresh, valid compressed secp256k1 public key the engine does NOT own. */
export function freshPubkey(): Uint8Array {
  return new SigningService(SigningService.generatePrivateKey()).publicKey;
}
