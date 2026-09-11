import { isPossiblyCommittedSendOutcome, PartialSendConflictError, SphereError } from '../../core/errors';

/** The parts of a send run these shapers read. */
export interface PartialRun {
  readonly amount: string;
  readonly delivered: readonly string[];
  readonly firstPartialId: string | undefined;
}

/** Once anything was delivered, the failure is a SHORTFALL: re-plan the remainder, never the total. */
export function partialize(err: unknown, run: PartialRun): unknown {
  if (run.delivered.length === 0) return err;
  return new PartialSendConflictError(
    'Part of your payment was sent; the remaining amount could not be completed (see cause). The delivered portion is final — re-plan only the shortfall, never the full amount.',
    run.firstPartialId ?? '',
    [...run.delivered],
    run.amount,
    err
  );
}

/** #441: possibly-committed errors must carry the transferId for the settling journal. */
export function stampTransferId(err: unknown, transferId: string): void {
  if (
    err instanceof SphereError &&
    isPossiblyCommittedSendOutcome(err) &&
    err.transferId === undefined
  ) {
    err.transferId = transferId;
  }
}
