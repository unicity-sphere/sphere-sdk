/**
 * Transfer Mode shims — UXF Inter-Wallet Transfer (T.1.B.1)
 *
 * This module is the SINGLE PLACE in the SDK that performs runtime narrowing
 * of the public {@link TransferMode} union to the internal
 * {@link InternalTransferMode} union. Every call-site that `tsc --strict`
 * flags during the T.1 widening calls into this module — no other module
 * does the narrow itself, no `as any` casts are introduced anywhere in
 * production code. Tests may still construct a synthetic `'txf' as
 * TransferMode` to verify the shim's negative path.
 *
 * Spec references:
 * - §10.1 (Backward Compatibility — sender side; "Breaking-widening note").
 * - Plan §T.1.B.1 (this task) and §T.1.B.2 (the cleanup task that removes
 *   shims after T.7.C migrates the production call-sites).
 *
 * @internal
 *
 * @remarks
 * Removal schedule (T.1.B.2 — see plan §6.D):
 *  - {@link narrowTransferMode}                — KEEP (residual; T.7.A wires the TXF arm; the shim is the runtime guard against
 *                                                future protocol versions adding modes the SDK has not yet routed).
 *  - {@link defaultTransferMode}               — REMOVE in T.7.E (default flips from "instant over legacy TXF" to "instant over UXF";
 *                                                the constant migrates to the dispatcher).
 *  - {@link assertConservativeOrInstant}       — REMOVE in T.1.B.2 (post-T.7.C call-sites pass `transferMode` explicitly).
 *  - {@link coercePartialTransferRequestMode}  — REMOVE in T.1.B.2 (sphere/agentsphere repos migrate; coercion is no longer needed).
 *
 * The shim file is intentionally TINY and DOC-HEAVY so the next reviewer
 * understands why every line is here and which task removes it.
 */

import { SphereError } from '../../../core/errors';
import type {
  InternalTransferMode,
  TransferMode,
  TransferRequest,
} from '../../../types';

// =============================================================================
// 1. Default mode — single source of truth
// =============================================================================

/**
 * The SDK-wide default `transferMode`. Until T.7.E flips this to UXF, it
 * stays at `'instant'` — the historical SDK default. T.1.B.1 introduces
 * NO behavior change.
 *
 * Exported as a constant (not inlined into every call-site) so the eventual
 * flip is one diff hunk, not a sweep.
 *
 * @internal
 */
export const DEFAULT_TRANSFER_MODE: TransferMode = 'instant';

/**
 * Alias of {@link DEFAULT_TRANSFER_MODE} that future call-sites can import
 * by domain name. Distinct alias to make grep-for-removal easy in T.7.E.
 *
 * @internal
 */
export const defaultTransferMode = (): TransferMode => DEFAULT_TRANSFER_MODE;

// =============================================================================
// 2. The narrow-or-throw shim
// =============================================================================

/**
 * Narrow a public {@link TransferMode} (or `undefined`) to an
 * {@link InternalTransferMode}, applying the SDK default and rejecting any
 * value that is not yet routed.
 *
 * - `undefined`        → {@link DEFAULT_TRANSFER_MODE}.
 * - `'instant'`        → `'instant'`.
 * - `'conservative'`   → `'conservative'`.
 * - `'txf'` (pre-T.7.A, only reachable via `as TransferMode` cast in
 *   tests or untyped JS callers) → throws `SphereError(UNSUPPORTED_TRANSFER_MODE)`.
 * - any other string  → throws `SphereError(UNSUPPORTED_TRANSFER_MODE)`.
 *
 * SHIM: removed in T.1.B.2 once T.7.C migrates call-sites — but this
 * particular function is the residual guard kept post-cleanup (see file
 * header). Most other helpers in this file disappear entirely.
 *
 * @throws SphereError code=`UNSUPPORTED_TRANSFER_MODE` for any value that
 *         narrows to neither `'instant'` nor `'conservative'`.
 */
export function narrowTransferMode(
  mode: TransferMode | undefined,
): InternalTransferMode {
  // Default — historical SDK behavior (`request.transferMode ?? 'instant'`).
  if (mode === undefined) return DEFAULT_TRANSFER_MODE;

  // Public values pass through. `InternalTransferMode` is a strict superset
  // of `TransferMode`, so the assignment is type-sound.
  if (mode === 'instant' || mode === 'conservative') return mode;

  // The two narrow-down rejection branches: `'txf'` (planned, pre-T.7.A)
  // and "anything else" (untyped callers passing a future protocol value).
  // Both surface as one canonical error code so UI / tests can match a
  // single string. The runtime check is paranoid — TypeScript's public
  // type only includes `'instant' | 'conservative'`, but a pure JS caller
  // (or a test using `as TransferMode`) can still smuggle in any string.
  if ((mode as InternalTransferMode) === 'txf') {
    throw new SphereError(
      "TXF transfer mode is not yet implemented; awaits T.7.A. Pass " +
      "{ transferMode: 'instant' } or omit the field to use the default.",
      'UNSUPPORTED_TRANSFER_MODE',
    );
  }

  throw new SphereError(
    `Unsupported transferMode value: ${JSON.stringify(mode)}. ` +
    "Allowed values: 'instant', 'conservative'.",
    'UNSUPPORTED_TRANSFER_MODE',
  );
}

// =============================================================================
// 3. Per-call-site narrowing helpers
// =============================================================================

/**
 * Assert that `mode` is one of the two PUBLIC {@link TransferMode} values
 * (i.e., post-narrow result is NOT `'txf'`). Use at sites that today only
 * route `'instant'` or `'conservative'` and would otherwise need a manual
 * exhaustive switch with a default arm.
 *
 * Returns the narrowed value as a tighter type for downstream use.
 *
 * SHIM: removed in T.1.B.2 once T.7.C migrates call-sites and the
 * dispatcher in `PaymentsModule.send()` knows about the `'txf'` arm. Until
 * then, every site that used to switch on `'instant' | 'conservative'`
 * exhaustively can call this to keep that exhaustiveness.
 *
 * @internal
 *
 * @throws SphereError code=`UNSUPPORTED_TRANSFER_MODE` if `mode` is `'txf'`.
 */
export function assertConservativeOrInstant(
  mode: InternalTransferMode,
): TransferMode {
  if (mode === 'instant' || mode === 'conservative') return mode;
  throw new SphereError(
    `TXF transfer mode is not yet implemented; awaits T.7.A. ` +
    `(observed internal mode: ${JSON.stringify(mode)})`,
    'UNSUPPORTED_TRANSFER_MODE',
  );
}

/**
 * One-shot helper for `PaymentsModule.send()` and any other entry point
 * that takes a {@link TransferRequest}: narrows the request's `transferMode`
 * field, returning the {@link InternalTransferMode}. Identical to
 * `narrowTransferMode(request.transferMode)`; exists as a named helper so
 * the call-site reads as `coercePartialTransferRequestMode(request)`
 * rather than projecting the field manually.
 *
 * SHIM: removed in T.1.B.2 once `PaymentsModule.send()` is the only
 * external entry point that consumes `transferMode` and post-T.7.C
 * call-sites set it explicitly.
 *
 * @internal
 */
export function coercePartialTransferRequestMode(
  request: Pick<TransferRequest, 'transferMode'>,
): InternalTransferMode {
  return narrowTransferMode(request.transferMode);
}

// =============================================================================
// 4. Legacy single-coin slot narrow (post-T.1.B.1 widening of `coinId`/`amount`)
// =============================================================================

/**
 * A {@link TransferRequest} whose primary coin slot has been verified
 * present. The legacy single-coin code path in `PaymentsModule.send()`
 * dereferences `coinId` and `amount` ubiquitously; widening them to
 * optional at the public type level (per §10.1) created a sea of strict
 * optional-chain errors. This branded type lets a SINGLE shim call
 * convert the public `TransferRequest` into a request that the legacy
 * routing logic can consume directly.
 *
 * @internal
 */
export type LegacyCoinTransferRequest = TransferRequest & {
  readonly coinId: string;
  readonly amount: string;
};

/**
 * Verify the request carries a complete primary coin slot and return it
 * narrowed. Throws `INVALID_REQUEST` if either field is missing — until
 * T.2.B lands the §4.1 step 1 multi-asset validator, the legacy path is
 * the only routing branch and it cannot run without `(coinId, amount)`.
 *
 * SHIM: removed in T.2.B once the multi-asset target validator becomes
 * the entry routing primitive. Until then, calling this shim at
 * `PaymentsModule.send()` entry replaces a sweep of per-line `as string`
 * casts and `request.coinId!` non-null assertions with a single typed
 * runtime guard.
 *
 * Acceptable T.1.B.1 reject code:
 *  - `'VALIDATION_ERROR'` — the existing generic validation code. The
 *    §4.1 step 1 validator (T.2.B) replaces this with the more specific
 *    `'EMPTY_TRANSFER'` / `'INVALID_REQUEST'` codes once the multi-asset
 *    arm is wired (those codes are added to `SphereErrorCode` by T.2.B).
 *
 * @internal
 *
 * @throws SphereError code=`VALIDATION_ERROR` when `coinId` or `amount`
 *         is missing. The call-site receives the throw before any state
 *         mutation, identical to {@link narrowTransferMode}'s contract.
 */
export function requireLegacyCoinSlot(
  request: TransferRequest,
): LegacyCoinTransferRequest {
  if (typeof request.coinId !== 'string' || request.coinId.length === 0) {
    throw new SphereError(
      "TransferRequest is missing the primary `coinId` slot. " +
      "NFT-only and multi-asset sends are accepted by the type but not " +
      "yet routed (awaits T.2.B); pass an explicit `coinId` for now.",
      'VALIDATION_ERROR',
    );
  }
  if (typeof request.amount !== 'string' || request.amount.length === 0) {
    throw new SphereError(
      "TransferRequest is missing the primary `amount` slot. " +
      "NFT-only and multi-asset sends are accepted by the type but not " +
      "yet routed (awaits T.2.B); pass an explicit `amount` for now.",
      'VALIDATION_ERROR',
    );
  }
  return request as LegacyCoinTransferRequest;
}
