/**
 * SDK Error Types
 *
 * Structured error codes for programmatic error handling in UI.
 * UI can switch on error.code to show appropriate user-facing messages.
 *
 * @example
 * ```ts
 * import { SphereError } from '@unicitylabs/sphere-sdk';
 *
 * try {
 *   await sphere.payments.send({ ... });
 * } catch (err) {
 *   if (err instanceof SphereError) {
 *     switch (err.code) {
 *       case 'INSUFFICIENT_BALANCE': showToast('Not enough funds'); break;
 *       case 'INVALID_RECIPIENT': showToast('Recipient not found'); break;
 *       case 'TRANSPORT_ERROR': showToast('Network connection issue'); break;
 *       case 'TIMEOUT': showToast('Request timed out, try again'); break;
 *       default: showToast(err.message);
 *     }
 *   }
 * }
 * ```
 */

export type SphereErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'INVALID_CONFIG'
  | 'INVALID_IDENTITY'
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_RECIPIENT'
  | 'TRANSFER_FAILED'
  // The source state was consumed by a DIFFERENT transaction (lost race, not a
  // resume) — raised as TransferConflictError (token-engine/errors.ts, Part E.2).
  | 'TRANSFER_CONFLICT'
  // The op's certification is INDETERMINATE (submit accepted / proof fetch
  // inconclusive) — raised as ProofUnconfirmedError; keep the intent OPEN (#631).
  | 'CERTIFICATION_UNCONFIRMED'
  // Split burn checkpoint (sdk-changes E.4, sphere-sdk#501) — all keep-open (token-engine/errors.ts):
  // burn certified but the checkpoint could not be persisted (no mint submitted);
  | 'CHECKPOINT_PERSIST_FAILED'
  // a certified mint leaf has no reproducing stored bytes, or a stored checkpoint fails byte-binding;
  | 'SPLIT_CHECKPOINT_LOST'
  // a byte-bound checkpoint proof no longer verifies against the current trust base (validator rotation).
  | 'CHECKPOINT_TRUSTBASE_MISMATCH'
  | 'STORAGE_ERROR'
  // #665: the on-chain spend committed but the post-commit wallet-api mirror
  // sync (inventory apply / blob upload / save) failed. NOT a lost payment —
  // the intent is kept open and resume converges the mirror (idempotent apply,
  // #664). Surfaced distinctly so a UI can reassure ("sent — wallet catching
  // up") instead of showing a hard send failure.
  | 'SEND_SYNC_PENDING'
  // #677: a multi-leg send lost a source to a concurrent transfer AFTER ≥1
  // earlier leg had already certified on-chain AND been journaled/delivered.
  // The delivered value has irreversibly left the wallet, so this is NOT a
  // plain, re-sendable failure: surfacing a bare TransferConflictError makes
  // the caller re-send the FULL amount and pay the delivered leg twice. Raised
  // as PartialSendConflictError; the caller MUST re-plan ONLY the remainder
  // under a NEW transferId, never the whole amount.
  | 'SEND_PARTIALLY_COMPLETED'
  | 'TRANSPORT_ERROR'
  | 'AGGREGATOR_ERROR'
  | 'VALIDATION_ERROR'
  | 'INVALID_AMOUNT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'DECRYPTION_ERROR'
  | 'MODULE_NOT_AVAILABLE'
  | 'SIGNING_ERROR'
  // Token Spend Queue error codes
  | 'SEND_QUEUE_TIMEOUT'
  | 'SEND_INSUFFICIENT_BALANCE'
  | 'SEND_RESERVATION_CANCELLED'
  | 'SEND_QUEUE_FULL'
  | 'MODULE_DESTROYED'
  | 'REENTRANT_GATE'
  // Invoice / Accounting error codes
  | 'INVOICE_NO_TARGETS'
  | 'INVOICE_INVALID_ADDRESS'
  | 'INVOICE_NO_ASSETS'
  | 'INVOICE_INVALID_ASSET'
  | 'INVOICE_INVALID_AMOUNT'
  | 'INVOICE_INVALID_COIN'
  | 'INVOICE_INVALID_NFT'
  | 'INVOICE_PAST_DUE_DATE'
  | 'INVOICE_DUPLICATE_ADDRESS'
  | 'INVOICE_DUPLICATE_COIN'
  | 'INVOICE_DUPLICATE_NFT'
  | 'INVOICE_MINT_FAILED'
  | 'INVOICE_INVALID_PROOF'
  | 'INVOICE_WRONG_TOKEN_TYPE'
  | 'INVOICE_INVALID_DATA'
  | 'INVOICE_ALREADY_EXISTS'
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_NOT_TARGET'
  | 'INVOICE_ALREADY_CLOSED'
  | 'INVOICE_ALREADY_CANCELLED'
  | 'INVOICE_ORACLE_REQUIRED'
  | 'INVOICE_TERMINATED'
  | 'INVOICE_INVALID_TARGET'
  | 'INVOICE_INVALID_ASSET_INDEX'
  | 'INVOICE_RETURN_EXCEEDS_BALANCE'
  | 'INVOICE_INVALID_DELIVERY_METHOD'
  | 'INVOICE_INVALID_REFUND_ADDRESS'
  | 'INVOICE_INVALID_CONTACT'
  | 'INVOICE_INVALID_ID'
  | 'INVOICE_TOO_MANY_TARGETS'
  | 'INVOICE_TOO_MANY_ASSETS'
  | 'INVOICE_MEMO_TOO_LONG'
  | 'INVOICE_TERMS_TOO_LARGE'
  | 'INVOICE_NOT_TERMINATED'
  | 'INVOICE_NOT_CANCELLED'
  | 'INVOICE_STORAGE_FAILED'
  | 'RATE_LIMITED'
  | 'COMMUNICATIONS_UNAVAILABLE'
  // Swap error codes
  | 'SWAP_INVALID_DEAL'
  | 'SWAP_INVALID_MANIFEST'
  | 'SWAP_NOT_FOUND'
  | 'SWAP_WRONG_STATE'
  | 'SWAP_RESOLVE_FAILED'
  | 'SWAP_DM_SEND_FAILED'
  | 'SWAP_ESCROW_REJECTED'
  | 'SWAP_DEPOSIT_FAILED'
  | 'SWAP_PAYOUT_VERIFICATION_FAILED'
  | 'SWAP_ALREADY_EXISTS'
  | 'SWAP_ALREADY_COMPLETED'
  | 'SWAP_ALREADY_CANCELLED'
  | 'SWAP_TIMEOUT'
  | 'SWAP_LIMIT_EXCEEDED'
  | 'SWAP_ALREADY_INITIALIZED'
  | 'SWAP_MODULE_DESTROYED'
  | 'SWAP_NOT_INITIALIZED';

export class SphereError extends Error {
  readonly code: SphereErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: SphereErrorCode, cause?: unknown) {
    super(message);
    this.name = 'SphereError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * #677: a send that PARTIALLY completed before losing a source to a concurrent
 * transfer. At least one earlier leg certified on-chain and was journaled for
 * delivery (its {@link committedTokenIds}) — that value has irreversibly left
 * the wallet — but a LATER leg raised `TransferConflictError` (a lost race).
 *
 * Distinct from `TransferConflictError` on purpose: a bare conflict makes the
 * caller re-send the FULL amount, paying the already-delivered leg a second
 * time. Catching THIS type (or `code === 'SEND_PARTIALLY_COMPLETED'`) tells the
 * caller/UI: the delivered legs are final, the conflicted intent has been
 * soft-aborted, and only the REMAINDER may be re-planned — under a NEW
 * transferId, never re-sending the whole amount.
 *
 * NOT a subclass of `TransferConflictError` by design: existing conflict
 * handlers that re-send in full must NOT treat this as an ordinary conflict.
 */
export class PartialSendConflictError extends SphereError {
  /** The send's transferId — its intent was soft-aborted; the delivered legs are journaled under it. */
  readonly transferId: string;
  /**
   * Source token ids whose spend already certified on-chain (and whose finished
   * output blob is journaled for delivery). The remainder = the requested amount
   * minus the value of these legs; re-plan only that, under a new transferId.
   */
  readonly committedTokenIds: readonly string[];

  constructor(message: string, transferId: string, committedTokenIds: readonly string[], cause?: unknown) {
    super(message, 'SEND_PARTIALLY_COMPLETED', cause);
    this.name = 'PartialSendConflictError';
    this.transferId = transferId;
    this.committedTokenIds = [...committedTokenIds];
  }
}

/**
 * Type guard to check if an error is a SphereError
 */
export function isSphereError(err: unknown): err is SphereError {
  return err instanceof SphereError;
}
