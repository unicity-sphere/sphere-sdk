import type { MintReasonRegistry } from './mint-reasons';
import {
  type PredicateVerifierService,
  type RootTrustBase,
  TokenIssuanceVerifierService,
  type UnicityCertificateVerifier,
  VerificationContext,
} from './sdk';
import type { MintDataTokenParams } from './types';
import { assertMintableData } from './value-envelope';

export interface MintContextDeps {
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly unicityCertificateVerifier: UnicityCertificateVerifier;
  readonly mintJustificationVerifier: MintReasonRegistry;
  readonly verificationContext: VerificationContext;
}

/** The context a data-token mint verifies under; throws before anything is submitted when a replay could not verify it. */
export function mintContext(
  deps: MintContextDeps,
  params: Pick<MintDataTokenParams, 'data' | 'justification' | 'mintJustificationVerifiers'>,
): VerificationContext {
  assertMintableData(params.data);
  if (params.justification !== undefined) deps.mintJustificationVerifier.assertVerifiable(params.justification);
  const verifiers = params.mintJustificationVerifiers;
  if (verifiers === undefined) return deps.verificationContext;
  return new VerificationContext(
    deps.trustBase,
    deps.predicateVerifier,
    deps.unicityCertificateVerifier,
    deps.mintJustificationVerifier.overlaid(verifiers),
    new TokenIssuanceVerifierService(false),
  );
}
