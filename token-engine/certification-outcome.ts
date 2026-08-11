import { InclusionProofVerificationStatus } from './sdk';
import { ProofUnconfirmedError, TransferConflictError } from './errors';

/** What a failed certification means: lost race, proven-clean reject, or indeterminate. */
export function certificationFailure(
  err: unknown,
  failLabel: string,
  submitError: unknown,
  submitRejectedCleanly: boolean,
): unknown {
  // The SDK reports a match-verify mismatch as a generic Error carrying the
  // status in its message; that fragile string is mapped HERE and nowhere else.
  if (
    err instanceof Error &&
    err.message === `Invalid inclusion proof status: ${InclusionProofVerificationStatus.TRANSACTION_HASH_MISMATCH}`
  ) {
    return new TransferConflictError(
      `${failLabel}: the source state was already consumed by a different transaction ` +
        '(lost race — abort this intent and re-plan under a new transferId)',
      err,
    );
  }
  if (submitRejectedCleanly) return submitError;
  return new ProofUnconfirmedError(
    `${failLabel}: certification unconfirmed — the source spend may be on-chain; ` +
      'keep the intent open and resume under the same transferId',
    submitError ?? err,
  );
}
