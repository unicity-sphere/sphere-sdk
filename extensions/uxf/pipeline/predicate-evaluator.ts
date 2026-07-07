/**
 * Predicate evaluator — UXF Inter-Wallet Transfer recipient (T.3.B.1).
 *
 * Pure-function wrapper around the SDK's predicate evaluation that the
 * §5.3 decision-matrix walker (T.3.B.2) calls to answer ONE question:
 * **does the candidate token's current-state predicate bind to OUR public
 * key?** That is, given a hydrated `IPredicate` parsed from a token-state
 * element and our chain pubkey bytes, can we operate the token now?
 *
 * Why a wrapper rather than calling `predicate.isOwner(pk)` inline at the
 * caller:
 *
 *  - **Try/catch is mandatory at SDK boundaries** (§5.3 [A]/[B]). The
 *    SDK's predicate engines are normal TypeScript code; an attacker-
 *    crafted predicate could throw on parse, on `isOwner`, on hash
 *    derivation, on internal CBOR decode. The walker MUST surface that
 *    throw as a STRUCTURAL_INVALID disposition (`reason: 'structural'`),
 *    NOT silently treat it as `bindsToUs: false`. A silent fall-through
 *    would let a hostile sender ship a predicate that throws on every
 *    receiver and look indistinguishable from a recipient who simply
 *    isn't bound — covert channel.
 *
 *  - **The {ok, threw} result discipline** matches the other three
 *    verifiers in this directory (`authenticator-verifier`, `proof-
 *    verifier`); the walker can trust that `result.ok === false` ALWAYS
 *    means structural failure, never a clean "no" answer.
 *
 * Spec references:
 *   - §5.3 [B]   — current-state predicate doesn't bind to us → AUDIT
 *                  with `not-our-state` (only when `ok: true,
 *                  bindsToUs: false`).
 *   - §5.3 [A]   — structural failure → INVALID with `structural` (when
 *                  `ok: false, threw: true`).
 *
 * **What this module does NOT do**: hydrate the `IPredicate` from a
 * pool-element CBOR blob. That hydration belongs to the walker (T.3.B.2)
 * because it has the pool reference and chooses the appropriate
 * predicate engine (default / masked / unmasked / future). This module
 * accepts an already-hydrated `IPredicate` and asks one question of it.
 *
 * @packageDocumentation
 */

import type { IPredicate } from 'stsdk-v1/lib/predicate/IPredicate';

// =============================================================================
// 1. Public types — discriminated outcome
// =============================================================================

/**
 * The two-arm result discipline. Exactly one of:
 *
 *  - `ok: true`  — the SDK call completed successfully; `bindsToUs`
 *                  carries the boolean answer to "does the predicate
 *                  recognize our pubkey as authorized?"
 *  - `ok: false` — the SDK call threw. `error` carries the original
 *                  cause for forensic logging; the walker maps this
 *                  outcome to `DispositionReason: 'structural'`.
 *
 * The discriminator is `ok` (true|false) — guaranteed mutually exclusive
 * by the union shape. Callers MUST narrow on `ok` and never assume
 * `bindsToUs` exists on the failure arm.
 */
export type EvaluatePredicateResult =
  | { readonly ok: true; readonly bindsToUs: boolean }
  | { readonly ok: false; readonly threw: true; readonly error: unknown };

// =============================================================================
// 2. Public API — evaluatePredicateBindsToUs
// =============================================================================

/**
 * Ask `predicate.isOwner(ourPubkey)` with structural-failure isolation.
 *
 * **Pure function** (modulo the SDK call): identical inputs produce
 * identical outputs. No I/O, no global state, no network. Safe to call
 * any number of times on the same predicate — repeated calls share the
 * SDK's internal caches (if any) and do NOT bypass the try/catch wrap.
 *
 * @param predicate    A hydrated `IPredicate` parsed by the walker from
 *                     the candidate token's current `token-state`
 *                     element. The hydration is the walker's job; this
 *                     module never decodes raw CBOR or chooses a
 *                     predicate engine.
 * @param ourPubkey    Our chain pubkey bytes (33-byte compressed
 *                     secp256k1, the same bytes that would be passed to
 *                     `Authenticator.verifyWithPublicKey`). Cleartext —
 *                     `isOwner` does the predicate-specific binding
 *                     comparison (e.g., masked predicates derive a
 *                     hash; unmasked compare directly).
 *
 * @returns A discriminated {@link EvaluatePredicateResult}. `ok: true`
 *          means we got a clean boolean answer; `ok: false, threw:
 *          true` means the SDK call raised — the walker MUST treat
 *          this as structural failure and never as "no, doesn't bind".
 *
 * @remarks
 *
 * **Try/catch contract**. The function catches EVERY error class the
 * SDK might throw — `Error`, `RangeError`, `TypeError`, custom SDK
 * exceptions, even non-Error throw values like `throw 'boom'`. The
 * `error` field is `unknown` to reflect that. Callers logging it should
 * route through `String(err)` or a structured logger that handles
 * unknown shapes; the walker's downstream `_invalid` record schema does
 * not include the raw error object (only the disposition reason).
 *
 * **No silent coercion**. If `predicate.isOwner` returns a non-boolean
 * truthy value (e.g., a Promise that resolves to `1`), we propagate the
 * truthiness as `bindsToUs: Boolean(result)`. This matches the SDK's
 * declared `Promise<boolean>` return type — anything else is an SDK
 * defect, not a recipient concern.
 *
 * **Resolves the Promise inside the try/catch.** A rejected promise
 * (async throw) is caught the same way as a synchronous throw; both
 * surface as `ok: false`.
 */
export async function evaluatePredicateBindsToUs(
  predicate: IPredicate,
  ourPubkey: Uint8Array,
): Promise<EvaluatePredicateResult> {
  try {
    // Defensive: guard against null/undefined inputs slipping past
    // strict-mode types (the walker hydrates these from pool elements
    // that are already verified, but a defect upstream should NOT
    // propagate as a silent "false" answer).
    if (predicate === null || predicate === undefined) {
      return {
        ok: false,
        threw: true,
        error: new TypeError(
          'evaluatePredicateBindsToUs: predicate is null/undefined',
        ),
      };
    }
    if (!(ourPubkey instanceof Uint8Array)) {
      return {
        ok: false,
        threw: true,
        error: new TypeError(
          'evaluatePredicateBindsToUs: ourPubkey must be a Uint8Array',
        ),
      };
    }

    // The SDK's `IPredicate.isOwner(publicKey: Uint8Array)` signature
    // returns Promise<boolean>. We await INSIDE the try so a rejected
    // promise produces the same `ok: false` outcome as a sync throw.
    const result = await predicate.isOwner(ourPubkey);

    // Steelman fix: SDK contract is `Promise<boolean>`. Strict-equality
    // check rather than `Boolean(result)` coercion — a defective or
    // compromised SDK returning truthy non-boolean (1, {}, "false"-string,
    // an unawaited inner Promise) would otherwise silently grant
    // ownership. Anything other than literal `true` or `false` surfaces
    // as a structural defect.
    if (result === true) return { ok: true, bindsToUs: true };
    if (result === false) return { ok: true, bindsToUs: false };
    return {
      ok: false,
      threw: true,
      error: new TypeError(
        `predicate.isOwner returned non-boolean (${typeof result}); SDK contract violation`,
      ),
    };
  } catch (error: unknown) {
    return { ok: false, threw: true, error };
  }
}
