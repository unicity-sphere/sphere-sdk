import {
  type IMintJustificationVerifier,
  MintJustificationVerifierService,
  type PredicateVerifierService,
  type RootTrustBase,
  TokenIssuanceVerifierService,
  type UnicityCertificateVerifier,
  VerificationContext,
} from './sdk';

export interface VerifierContextBase {
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly unicityCertificateVerifier: UnicityCertificateVerifier;
}

export function contextWithMintVerifiers(
  base: VerifierContextBase,
  verifiers: readonly IMintJustificationVerifier[],
): VerificationContext {
  const registry = new MintJustificationVerifierService();
  for (const verifier of verifiers) registry.register(verifier);
  return new VerificationContext(
    base.trustBase,
    base.predicateVerifier,
    base.unicityCertificateVerifier,
    registry,
    new TokenIssuanceVerifierService(false),
  );
}
