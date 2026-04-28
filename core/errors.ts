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
  // UXF Transfer / Delivery resolver (T.2.C) — §3.3.1 inline-cap & relay-safe ceiling.
  // The resolver maps `(DeliveryStrategy, carBytes)` to a concrete delivery decision
  // (inline base64 vs CID-by-reference) and surfaces TWO distinct failure modes:
  //   - `INLINE_CAR_TOO_LARGE` — the resulting Nostr event would exceed the
  //     relay-safe ceiling (RELAY_SAFE_CAP_BYTES = 96 KiB). Surfaces in two paths:
  //     (a) `delivery: { kind: 'force-inline' }` with `carBytes.length > 96 KiB`
  //         — the caller chose force-inline explicitly and must handle this branch.
  //     (b) (future) §3.3 publish-time relay rejection in force-inline path
  //         — out of scope for T.2.C; surfaced by the sender orchestrator.
  //     `auto` mode never throws this code: it falls back to `uxf-cid` instead.
  //   - `INVALID_INLINE_CAP` — `delivery: { kind: 'auto', inlineCapBytes: N }` with
  //     `N < 1` (zero, negative, NaN, or non-finite). Per §3.3.1 normative paragraph,
  //     implementations MAY reject undersized caps deterministically — we choose
  //     reject (W12). Note that OVERSIZED caps (`N > 96 KiB`) are SILENTLY CLAMPED,
  //     not rejected, because the spec mandates `auto` never publishes inline above
  //     the relay-safe ceiling regardless of user override; clamp is the deterministic
  //     no-surprise behavior.
  | 'INLINE_CAR_TOO_LARGE'
  | 'INVALID_INLINE_CAP'
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
  | 'LOCK_BOUNDED_HOLD_FIRED';

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
