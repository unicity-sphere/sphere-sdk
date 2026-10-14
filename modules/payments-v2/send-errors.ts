import {
  isPossiblyCommittedSendOutcome,
  PartialSendConflictError,
  possiblyCommittedCodeOf,
  SphereError,
} from '../../core/errors';

// #835: each possibly-committed message tells the caller the payment is held — never re-send.
export const INTENT_UNCONFIRMED_MESSAGE =
  'The wallet service did not confirm it recorded this payment. It is held and will be sent automatically — do not send it again.';
export const PARTLY_ON_CHAIN_MESSAGE =
  'Part of this payment is already on chain; the rest is still settling under the same transfer — do not send it again.';
export const NOT_FENCED_MESSAGE =
  'This payment could not be cancelled with certainty. It is held and will be retried automatically — do not send it again.';
export const CONVERGE_FAILED_MESSAGE =
  'Part of this payment was sent; the rest is still settling under the same transfer — do not send it again.';
export const MAY_BE_ON_CHAIN_MESSAGE =
  'This payment may already be on chain; it is still settling under the same transfer — do not send it again.';
export const CANCEL_UNCONFIRMED_MESSAGE =
  'This payment failed and is being cancelled, but the wallet service has not confirmed the cancellation yet. Do not send it again: until it does, another device of this wallet could still complete it.';

/** The parts of a send run these shapers read. */
export interface PartialRun {
  readonly amount: string;
  readonly delivered: readonly string[];
  readonly firstPartialId: string | undefined;
}

/** #835: this bundle's possibly-committed error with the transferId; a foreign keep-open code survives the wrap. */
export function asPossiblyCommitted(err: unknown, transferId: string, message = MAY_BE_ON_CHAIN_MESSAGE): SphereError {
  return toPossiblyCommitted(err, transferId, message);
}

function toPossiblyCommitted(err: unknown, transferId: string, message: string): SphereError {
  if (err instanceof SphereError && isPossiblyCommittedSendOutcome(err)) {
    stampTransferId(err, transferId);
    return err;
  }
  const foreign = possiblyCommittedCodeOf(err);
  // Another bundle's possibly-committed error keeps its own code AND its own wording.
  const text = foreign !== undefined && err instanceof Error ? err.message : message;
  const wrapped = new SphereError(text, foreign ?? 'SEND_SYNC_PENDING', err);
  wrapped.transferId = transferId;
  return wrapped;
}

/** Once anything was delivered, the failure is a SHORTFALL: re-plan the remainder, never the total.
 *  A possibly-committed latest attempt owns the remainder (#835): '0', its certified legs listed —
 *  one being cancelled too, until its cancel is confirmed (another device could still complete it). */
export function partialize(err: unknown, run: PartialRun, openAttemptCertified: readonly string[] = []): unknown {
  if (run.delivered.length === 0) return err;
  if (isPossiblyCommittedSendOutcome(err)) {
    return new PartialSendConflictError(
      'Part of your payment was sent and the rest is still settling under its own transfer (see cause.transferId) — do not send any of it again.',
      run.firstPartialId ?? '',
      [...run.delivered, ...openAttemptCertified],
      '0',
      err
    );
  }
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
