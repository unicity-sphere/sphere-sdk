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
  | 'UNSUPPORTED_TRANSFER_MODE'
  | 'STORAGE_ERROR'
  | 'STORAGE_CORRUPTED'
  | 'TRANSPORT_ERROR'
  | 'AGGREGATOR_ERROR'
  | 'VALIDATION_ERROR'
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
  | 'SWAP_NOT_INITIALIZED'
  // UXF transfer protocol error codes (T.1.D — bundle envelope decode failures).
  // The protocol surfaces three structurally-distinct failure modes that callers
  // and the receive worker must distinguish:
  //   - `BUNDLE_REJECTED_MALFORMED_ENVELOPE` — the outer Nostr-content JSON
  //     could not be parsed, was not a plain object, lacked required fields,
  //     carried a wrong version literal, or otherwise failed structural
  //     validation against `isUxfTransferPayload` (§3.1, §5.0).
  //   - `BUNDLE_REJECTED_MULTI_ROOT` — `extractCarRootCid` saw a CAR with more
  //     than one root, which the verifier rejects per Wave G.5 / §5.2 #1.
  //   - `BUNDLE_REJECTED_INVALID_CAR` — `extractCarRootCid` failed to parse the
  //     CAR bytes (truncated, corrupt header, unknown framing). Distinct from
  //     `MULTI_ROOT` because the latter is a parseable-but-policy-rejected CAR.
  //
  // Cryptographic verification (signatures, proofs, root-CID-vs-bundleCid match)
  // is delegated to `pkg.verify()` (T.3.A) and surfaces other codes; T.1.D's
  // helpers are envelope-level only.
  | 'BUNDLE_REJECTED_MALFORMED_ENVELOPE'
  | 'BUNDLE_REJECTED_MULTI_ROOT'
  | 'BUNDLE_REJECTED_INVALID_CAR'
  // UXF Transfer / CRDT primitives (T.1.F) — §5.5 step 9, §7.1 Lamport invariants
  /** Observed remote Lamport > 2 × max(localKnownLamports). Defends against
   *  a malicious/buggy replica publishing an absurdly large Lamport (e.g.
   *  near `2^53`) to force everyone past JS safe-integer range. The bound
   *  is generous enough that legitimate divergence (e.g. one replica that
   *  has been offline) never trips, but rejects clearly-runaway values
   *  (W39). See profile/lamport.ts and §7.1 invariants. */
  | 'LAMPORT_BOUND_VIOLATION'
  /** `PerTokenMutex` strategy `'bounded-hold'` exceeded its `MAX_LOCK_HOLD_MS`
   *  (default 5000ms) and aborted the current acquire to prevent the lock
   *  from being held indefinitely under aggregator stalls (W35). The lock
   *  is released as part of throwing this error so the next caller may
   *  proceed. See profile/per-token-mutex.ts and §5.5 step 9. */
  | 'LOCK_BOUNDED_HOLD_FIRED'
  // UXF Transfer / outbox CRDT (T.6.A) — §7 bundle-grained outbox writer.
  /** `OutboxWriter.update(id, ...)` called with an `id` that has no live
   *  UXF outbox entry — either the key never existed, or the prior value
   *  is a tombstone, or the entry is in the legacy shape (which the
   *  writer does not mutate). Callers that need to upsert should call
   *  `OutboxWriter.write(...)` instead of update. See profile/outbox-writer.ts
   *  and UXF-TRANSFER-PROTOCOL §7. */
  | 'OUTBOX_ENTRY_NOT_FOUND'
  /**
   * UXF Inter-Wallet Transfer T.2.A — preflight-finalize hard-failure.
   *
   * Thrown by `modules/payments/transfer/preflight-finalize.ts` when the
   * sender attempts to walk a source token's pending-transaction history
   * (conservative-mode preflight, §2.2 / §13 Wave T.2) and the aggregator
   * surfaces a non-transient rejection on any tx in that chain. The
   * `cause` carries `{ tokenId, requestId, reason }` where `reason` is one
   * of the canonical 14 `DispositionReason` strings (§6.1 mapping):
   *  - `'belief-divergence'`  ← `AUTHENTICATOR_VERIFICATION_FAILED` at submit
   *  - `'client-error'`       ← `REQUEST_ID_MISMATCH` at submit
   *  - `'oracle-rejected'`    ← sustained `PATH_NOT_INCLUDED` past polling window
   *  - `'proof-invalid'`      ← exhausted `PATH_INVALID` / `NOT_AUTHENTICATED`
   *  - `'race-lost'`          ← proof's transactionHash mismatches local
   *
   * T.2.D.1 (conservative-sender orchestrator) catches this and re-throws
   * `INSUFFICIENT_BALANCE` with `reason='source-cascade-failed'` per the
   * §13 Wave T.2 acceptance — preflight itself stays purely descriptive so
   * the typed cause is forensically preserved up the stack.
   */
  | 'SOURCE_CHAIN_HARD_FAIL'
  // UXF Transfer / Multi-asset target validation (T.2.B) — §4.1 step 1 + 2,
  // §11.2 validation rejection cases. The validator at
  // `modules/payments/transfer/target-validator.ts` is the SINGLE source of
  // truth; every error below surfaces at validation time as a `SphereError`.
  /** `validateTargets()` was called with no primary `(coinId, amount)` slot
   *  AND no `additionalAssets` entries (W22). The request carries nothing to
   *  send. See §4.1 step 1 "If `targetList.length === 0` → EMPTY_TRANSFER".
   */
  | 'EMPTY_TRANSFER'
  /** Structural rejection of the request shape: duplicate `coinId` across
   *  primary + `additionalAssets`, duplicate NFT `tokenId`, partial primary
   *  slot (only one of `coinId`/`amount` set), or otherwise malformed
   *  request. Distinct from `INVALID_AMOUNT` (numeric) and `EMPTY_TRANSFER`
   *  (no targets). See §4.1 step 1 prose and §11.2 validation rejections. */
  | 'INVALID_REQUEST'
  /** A coin-target's `amount` is not a positive integer string (`<= 0`,
   *  fractional, non-numeric, or negative). See §4.1 step 1 "Each `kind:
   *  'coin'` entry's `amount` MUST be > 0". */
  | 'INVALID_AMOUNT'
  /** An `additionalAssets` entry's `kind` discriminator is neither `'coin'`
   *  nor `'nft'`. Forward-compat reject rule per §4.1 step 1
   *  "Discriminator forward-compat" / §10.4. */
  | 'UNKNOWN_ASSET_KIND'
  /** A `kind: 'nft'` target's source token has unfinalized predecessor txs
   *  (status pending) AND `confirmNftPending: false` (default). NFT cascade
   *  asymmetry per §4.1 step 2 "NFT cascade asymmetry warning" — NFT
   *  cascades are irrecoverable, so callers MUST acknowledge with
   *  `confirmNftPending: true` to proceed (W11). */
  | 'NFT_PENDING_REQUIRES_CONFIRMATION';

export class SphereError extends Error {
  readonly code: SphereErrorCode;

  constructor(message: string, code: SphereErrorCode, cause?: unknown) {
    // Steelman³⁸ note: forward `cause` to the native Error constructor
    // so `err.cause` walks (Sentry, util.inspect, pino-pretty) see the
    // chain. Previously a redeclared `readonly cause?: unknown` field
    // shadowed the native getter, breaking standard tooling.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SphereError';
    this.code = code;
  }
}

/**
 * Type guard to check if an error is a SphereError
 */
export function isSphereError(err: unknown): err is SphereError {
  return err instanceof SphereError;
}
