/**
 * SDK Error Types
 *
 * Structured error codes for programmatic error handling in UI.
 * UI can switch on error.code to show appropriate user-facing messages.
 *
 * Errors thrown by provider code (the `./impl/*` bundles) are a different `SphereError` class
 * copy, so `instanceof SphereError` / `isSphereError()` is false for them: read `code` structurally.
 *
 * @example
 * ```ts
 * import { PartialSendConflictError, isPossiblyCommittedSendOutcome } from '@unicitylabs/sphere-sdk';
 *
 * try {
 *   await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId });
 * } catch (err) {
 *   if (err instanceof PartialSendConflictError) {
 *     // Part of the amount already left the wallet and is final. Only err.remainingAmount is still owed:
 *     // if you pay it, do it as a NEW send of exactly that amount, never the original amount.
 *     // '0' means the rest is still settling under its own transfer (#835): nothing to re-pay.
 *     showToast(`Partly sent: ${err.remainingAmount} base units were not sent`);
 *   } else if (isPossiblyCommittedSendOutcome(err)) {
 *     // The money may already have left the wallet: never call send() again for this payment.
 *     showToast('Waiting for confirmation. Do not pay again.');
 *   } else {
 *     switch ((err as { code?: unknown } | null)?.code) {
 *       case 'SEND_INSUFFICIENT_BALANCE': showToast((err as Error).message); break; // pinned funds, or spending paused
 *       case 'INVALID_RECIPIENT': showToast((err as Error).message); break; // not found, another network, or DIRECT://
 *       case 'TRANSPORT_ERROR': showToast('Network connection issue'); break;
 *       default: showToast(err instanceof Error ? err.message : String(err));
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
  // Not thrown by the SDK: a send short of funds throws SEND_INSUFFICIENT_BALANCE.
  | 'INSUFFICIENT_BALANCE'
  | 'INVALID_RECIPIENT'
  | 'TRANSFER_FAILED'
  // The source state was consumed by a DIFFERENT transaction (lost race, not a
  // resume) — raised as TransferConflictError (token-engine/errors.ts, Part E.2).
  | 'TRANSFER_CONFLICT'
  // The op's certification is INDETERMINATE (submit accepted / proof fetch inconclusive), or
  // certified but not realized (#839) — raised as ProofUnconfirmedError; keep the intent OPEN (#631).
  | 'CERTIFICATION_UNCONFIRMED'
  // Split burn checkpoint (sdk-changes E.4, sphere-sdk#501) — all keep-open (token-engine/errors.ts):
  // burn certified but the checkpoint could not be persisted (no mint submitted);
  | 'CHECKPOINT_PERSIST_FAILED'
  // a certified mint leaf has no reproducing stored bytes, a stored checkpoint fails byte-binding,
  // or a re-encode while rebuilding from it throws (#839; recoverable, no mint submitted);
  | 'SPLIT_CHECKPOINT_LOST'
  // a byte-bound checkpoint proof no longer verifies against the current trust base (validator rotation).
  | 'CHECKPOINT_TRUSTBASE_MISMATCH'
  | 'MINT_REASON_UNVERIFIABLE'
  | 'STORAGE_ERROR'
  // Never re-send. Under err.transferId it committed in part or whole (#665), or is
  // held and sent automatically (#835), or failed and is being cancelled while
  // another device could still run it (#835). It always carries err.transferId (#838).
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
  // #793: this Sphere was initialised with `walletApi: 'none'` — the explicit
  // messaging-only composition. Distinct from NOT_INITIALIZED, which is transient
  // (init in flight, mid address-switch, destroyed): this one never resolves.
  | 'PAYMENTS_NOT_COMPOSED'
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
  /**
   * #441 deferred-paid linkage: the transferId of the possibly-committed send,
   * stamped by the machine/facade (`asPossiblyCommitted`/`stampTransferId`) before
   * the error leaves so a payment-request consumer can durably journal
   * request→transfer and resolve 'paid' only when that transfer actually completes
   * (never optimistically). Present ONLY on possibly-committed outcomes
   * ({@link isPossiblyCommittedSendOutcome}).
   */
  transferId?: string;

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
 * the wallet — but a LATER leg raised `TransferConflictError` (a lost race), and
 * `send()` could NOT COMPLETE the {@link remainingAmount} from the remaining live
 * sources. This is the fallback after the internal remainder re-plan gave up —
 * either insufficient funds OR a transient/transport error during the re-plan
 * (the underlying reason is on `cause`), not necessarily an "out of funds" state.
 * It is also FINAL, with no in-process re-plan, when a settled partial could not be
 * closed after its inventory apply: the durable remainder is surfaced as is (#835).
 *
 * Distinct from `TransferConflictError` on purpose: a bare conflict makes the
 * caller re-send the FULL amount, paying the already-delivered leg a second
 * time. Catching THIS type (or `code === 'SEND_PARTIALLY_COMPLETED'`) tells the
 * caller/UI: the delivered legs are final, and only the REMAINDER
 * ({@link remainingAmount}) may be re-planned — under a NEW transferId, never
 * re-sending the whole amount. A `remainingAmount` of `'0'` means nothing may be
 * re-planned: the rest rides a later attempt that will still be sent, named by
 * `cause.transferId` (#835).
 *
 * NOT a subclass of `TransferConflictError` by design: existing conflict
 * handlers that re-send in full must NOT treat this as an ordinary conflict.
 */
export class PartialSendConflictError extends SphereError {
  /**
   * The FIRST partial attempt's transferId — the §6 handoff anchor (its shortfall
   * row is keyed by it). NOTE: `send()` may re-plan the remainder across
   * SEVERAL internal attempts before giving up, so {@link committedTokenIds} can
   * span MULTIPLE transferIds — they do NOT all map to this single id.
   */
  readonly transferId: string;
  /**
   * Source token ids whose spend already certified on-chain (and whose finished
   * output blob is journaled for delivery). Their value has already been
   * delivered; NEVER re-send these. May accumulate across several internal
   * remainder-re-plan attempts (so not all are journaled under {@link transferId}).
   */
  readonly committedTokenIds: readonly string[];
  /**
   * The still-undelivered portion (base units, decimal string) — `send()` could
   * not COMPLETE it from the remaining live sources (insufficient funds or a
   * transient error; see `cause`). Re-plan ONLY this amount, under a new
   * transferId; the delivered legs converge via the recipient's §6 claim. `'0'`
   * when a later attempt still owns the remainder (#835): never re-plan then.
   */
  readonly remainingAmount: string;

  constructor(
    message: string,
    transferId: string,
    committedTokenIds: readonly string[],
    remainingAmount: string,
    cause?: unknown,
  ) {
    super(message, 'SEND_PARTIALLY_COMPLETED', cause);
    this.name = 'PartialSendConflictError';
    this.transferId = transferId;
    this.committedTokenIds = [...committedTokenIds];
    this.remainingAmount = remainingAmount;
  }
}

/**
 * Error codes for a send outcome where money has (or may have) already left the
 * wallet on-chain, so the send is NOT a clean, re-sendable failure. A consumer
 * that persists a "paid" flag (e.g. a payment request) must keep the request
 * NON-payable on any of these — reverting to a re-payable state would double-pay
 * (#441). Covers the post-commit mirror-sync-pending / keep-open certification
 * states AND the partial-conflict outcome.
 */
const POSSIBLY_COMMITTED_SEND_CODES: ReadonlySet<SphereErrorCode> = new Set([
  'SEND_SYNC_PENDING',
  'CERTIFICATION_UNCONFIRMED',
  'CHECKPOINT_PERSIST_FAILED',
  'SPLIT_CHECKPOINT_LOST',
  'CHECKPOINT_TRUSTBASE_MISMATCH',
  'SEND_PARTIALLY_COMPLETED',
]);

/**
 * #441: true when a send failed with an outcome where the payment has (or may
 * have) irreversibly left the wallet — a post-commit sync-pending / keep-open
 * certification state, or a `PartialSendConflictError`. Such a send completes (or
 * has already partially completed) via resume/claim and MUST NOT be re-sent, so
 * a persisted "paid" state must stay non-payable. A `false` result is proven
 * clean: nothing certified and nothing this device holds can execute it — safe
 * to re-pay.
 */
export function isPossiblyCommittedSendOutcome(err: unknown): boolean {
  return isSphereError(err) && POSSIBLY_COMMITTED_SEND_CODES.has(err.code);
}

/**
 * Internal (not re-exported from the package entries): the possibly-committed code
 * an error carries, read STRUCTURALLY — an error from another bundle's
 * `SphereError` copy fails `instanceof` but must keep its code when wrapped (#835).
 */
export function possiblyCommittedCodeOf(err: unknown): SphereErrorCode | undefined {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && POSSIBLY_COMMITTED_SEND_CODES.has(code as SphereErrorCode)
    ? (code as SphereErrorCode)
    : undefined;
}

/**
 * Type guard to check if an error is a SphereError
 */
export function isSphereError(err: unknown): err is SphereError {
  return err instanceof SphereError;
}
