/**
 * Authenticator verifier — UXF Inter-Wallet Transfer recipient (T.3.B.1).
 *
 * Pure-function wrapper around the SDK's `Authenticator.verify(transactionHash)`
 * that the §5.3 [C](1) decision-matrix walker calls **per transaction**
 * for every claimed token's chain. The verifier asks ONE question:
 * **does the embedded ECDSA signature in this authenticator verify
 * over its claimed `transactionHash` preimage with the embedded public
 * key?**
 *
 * Why per-tx, not just per-token (W37 / Note N7):
 *
 *   The chain attached to a `token-root` may have K committed
 *   transactions, each with its own `(authenticator, transactionHash,
 *   inclusionProof)` tuple. A hostile sender could splice a forged
 *   authenticator onto, say, tx[1] of a 3-tx chain — the genesis tx[0]
 *   verifies (sender's own keys), the splice point tx[1] is forged,
 *   and tx[2] re-uses the same sender's keys to look authentic. If we
 *   only verified the latest authenticator (tx[2]), the splice would
 *   slip past every cryptographic check and the receiver would accept
 *   a token whose middle state was never cryptographically authorized.
 *
 *   The protocol therefore mandates verifying ALL K authenticators in
 *   the chain, not just the head. This module verifies ONE; the
 *   walker iterates K times. The `forged-authenticator-mid-chain`
 *   adversarial test confirms catch.
 *
 * What this module wraps:
 *
 *   - SDK `Authenticator.verify(transactionHash: DataHash):
 *     Promise<boolean>` — the authoritative ECDSA primitive. The
 *     authenticator's internal `signature.bytes` is verified against
 *     the supplied `transactionHash` using the authenticator's
 *     internal `publicKey`. The "canonical preimage" the spec refers
 *     to is `transactionHash` itself (the SDK applies its own
 *     algorithm-prefix handling internally — implementations MUST NOT
 *     re-derive the preimage from raw fields lest they desync from
 *     the SDK's actual signing convention).
 *
 *   - Same `{ok: true, valid} | {ok: false, threw: true, error}`
 *     discipline as `predicate-evaluator.ts`, so the walker can trust
 *     that any thrown error is structural, never silent "invalid".
 *
 * Spec references:
 *   - §5.3 [C](1)  — ECDSA authenticator verify failure → INVALID
 *                    (`auth-invalid`).
 *   - §5.3 [A]     — verifier throw → INVALID (`structural`).
 *   - W37 / Note N7 — per-tx verify is mandatory; head-only verify is
 *                    insufficient.
 *
 * **What this module does NOT do**: parse the authenticator from CBOR
 * pool bytes (that's the walker's job, going through `Authenticator
 * .fromCBOR` or `Authenticator.fromJSON`); reconstruct the
 * `transactionHash` (the walker passes it from the inclusion-proof or
 * the transaction element); cache verification results (the SDK's own
 * cache, if any, is sufficient at the per-bundle scale we expect).
 *
 * @packageDocumentation
 */

import type { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator';
import type { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash';

// =============================================================================
// 1. Public types — discriminated outcome
// =============================================================================

/**
 * The two-arm result discipline. Exactly one of:
 *
 *  - `ok: true`  — the SDK's verify completed; `valid` is the boolean
 *                  answer to "does the signature verify against the
 *                  tx hash?"
 *  - `ok: false` — the SDK call threw. `error` carries the original
 *                  cause for forensic logging; the walker maps this
 *                  outcome to `DispositionReason: 'structural'`.
 *
 * The discriminator is `ok` (true|false), guaranteed mutually
 * exclusive. Callers MUST narrow on `ok` and never assume `valid`
 * exists on the failure arm.
 */
export type VerifyAuthenticatorResult =
  | { readonly ok: true; readonly valid: boolean }
  | { readonly ok: false; readonly threw: true; readonly error: unknown };

// =============================================================================
// 2. Public API — verifyAuthenticator
// =============================================================================

/**
 * Verify ONE transaction's authenticator. The walker calls this once
 * per transaction in the chain (W37). For a K-tx chain, the walker
 * MUST call this K times — short-circuit on the first `valid: false`
 * is fine, but skipping any tx in the chain breaks the §5.3 [C](1)
 * contract.
 *
 * **Pure function** (modulo the SDK call): identical inputs produce
 * identical outputs. No I/O, no global state, no mutation of either
 * argument. The SDK's `Authenticator.verify` does not mutate its
 * receiver.
 *
 * @param authenticator   The hydrated SDK `Authenticator` for this
 *                        transaction (parsed by the walker from the
 *                        pool element's CBOR/JSON).
 * @param transactionHash The DataHash this authenticator is supposed
 *                        to attest. The walker reads this from the
 *                        transaction's `inclusion-proof.content
 *                        .transactionHash` field (or, equivalently,
 *                        derives it via the SDK from the transaction
 *                        element). It is the canonical preimage per
 *                        §5.3 [C](1).
 *
 * @returns A discriminated {@link VerifyAuthenticatorResult}. On
 *          `ok: true, valid: false` the walker writes
 *          `DispositionReason: 'auth-invalid'`. On `ok: false, threw:
 *          true` the walker writes `DispositionReason: 'structural'`.
 *
 * @remarks
 *
 * **Try/catch contract**. The function catches EVERY error class the
 * SDK might throw — malformed signature bytes can raise `RangeError`
 * inside the secp256k1 primitive; an unsupported algorithm can raise
 * a custom error; a non-finite hash byte can throw inside the SDK's
 * own validation. All of these collapse into `ok: false, threw: true`.
 *
 * **No silent coercion**. The SDK declares `verify` returns
 * `Promise<boolean>`. We coerce defensively via `Boolean(result)` to
 * preserve the discrimination property even if a defective SDK build
 * returns truthy non-boolean values.
 *
 * **Async-throw is caught**. Awaiting INSIDE the try ensures a
 * rejected promise produces the same `ok: false` outcome as a sync
 * throw — uniform handling at the boundary.
 *
 * **Argument validation is also wrapped**. Passing `null` or a non-
 * Authenticator object surfaces as `ok: false, threw: true` with the
 * defensive TypeError as cause. The walker should never reach this
 * branch under correct hydration, but leaving the boundary
 * unmistakable closes a class of latent bugs.
 */
export async function verifyAuthenticator(
  authenticator: Authenticator,
  transactionHash: DataHash,
): Promise<VerifyAuthenticatorResult> {
  try {
    if (authenticator === null || authenticator === undefined) {
      return {
        ok: false,
        threw: true,
        error: new TypeError(
          'verifyAuthenticator: authenticator is null/undefined',
        ),
      };
    }
    if (transactionHash === null || transactionHash === undefined) {
      return {
        ok: false,
        threw: true,
        error: new TypeError(
          'verifyAuthenticator: transactionHash is null/undefined',
        ),
      };
    }
    if (typeof authenticator.verify !== 'function') {
      return {
        ok: false,
        threw: true,
        error: new TypeError(
          'verifyAuthenticator: authenticator.verify is not a function',
        ),
      };
    }

    // SDK call: the authoritative ECDSA verify. `Authenticator.verify`
    // implements the canonical preimage convention by hashing
    // `transactionHash` with the algorithm specified in the
    // authenticator's `algorithm` field, then running secp256k1
    // verification against the embedded `publicKey` and `signature
    // .bytes`. We MUST NOT re-derive the preimage from raw fields
    // lest we desync from the SDK's signing convention.
    const result = await authenticator.verify(transactionHash);
    // Steelman fix: SDK contract is `Promise<boolean>`. Strict-equality
    // check rather than `Boolean(result)` — a defective SDK returning
    // truthy non-boolean would otherwise silently accept forged
    // signatures. Anything other than literal `true`/`false` surfaces
    // as a structural defect upstream.
    if (result === true) return { ok: true, valid: true };
    if (result === false) return { ok: true, valid: false };
    return {
      ok: false,
      threw: true,
      error: new TypeError(
        `authenticator.verify returned non-boolean (${typeof result}); SDK contract violation`,
      ),
    };
  } catch (error: unknown) {
    return { ok: false, threw: true, error };
  }
}
