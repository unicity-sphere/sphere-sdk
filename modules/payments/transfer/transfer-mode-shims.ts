/**
 * Transfer Mode shims — UXF Inter-Wallet Transfer (T.1.B.2 residue).
 *
 * Post T.1.B.2 cleanup the file holds ONLY internal-only narrowings that
 * can never be supplanted by call-site discipline. Every shim that was
 * removable once T.7.C migrated production call-sites to pass an explicit
 * `transferMode` has been deleted; what remains is documented below with
 * an explicit `reason: "..."` marker so a future reviewer can see at a
 * glance why the symbol is still here.
 *
 * Spec references:
 * - §10.1 (Backward Compatibility — sender side; "Breaking-widening note").
 * - Plan §T.1.B.1 (initial widening) and §T.1.B.2 (this audit/cleanup).
 *
 * @internal
 *
 * @remarks
 * Residual schedule (post T.1.B.2):
 *  - {@link narrowTransferMode}          — KEEP. reason: "TXF arm + UNKNOWN-mode
 *                                          guard; the public TransferMode union
 *                                          intentionally excludes 'txf', the
 *                                          internal union includes it. The shim
 *                                          is the single point of runtime
 *                                          conversion. T.7.E may inline this
 *                                          into the dispatcher when the default
 *                                          flips to UXF, but only after every
 *                                          surface that consumes
 *                                          InternalTransferMode is gone."
 *  - {@link requireLegacyCoinSlot}       — KEEP. reason: "INTERNAL-only
 *                                          coin-slot narrowing; the public
 *                                          TransferRequest widened coinId/amount
 *                                          to optional in T.1.B.1 but the
 *                                          legacy single-coin path still
 *                                          dereferences both fields. T.2.B is
 *                                          the future task that retires this
 *                                          shim once the multi-asset validator
 *                                          becomes the routing primitive."
 *  - {@link LegacyCoinTransferRequest}   — KEEP. reason: "Brand for the
 *                                          requireLegacyCoinSlot output;
 *                                          retired by T.2.B together with the
 *                                          shim itself."
 *
 * Removed by T.1.B.2 (this commit):
 *  - DEFAULT_TRANSFER_MODE export    → demoted to module-private const
 *                                       referenced by narrowTransferMode only.
 *  - defaultTransferMode             → unused outside the shim's own tests.
 *  - assertConservativeOrInstant     → unused in production after T.7.C wired
 *                                       the dispatcher's exhaustive switch.
 *  - coercePartialTransferRequestMode→ replaced by direct
 *                                       `narrowTransferMode(req.transferMode)`
 *                                       at the single PaymentsModule.send()
 *                                       entry point.
 */

import { SphereError } from '../../../core/errors';
import type {
  InternalTransferMode,
  TransferMode,
  TransferRequest,
} from '../../../types';

// =============================================================================
// Module-private default — not exported. Post T.7.E (the "default-mode flip"),
// the SDK default is `'instant'` over UXF, NOT `'instant'` over legacy TXF.
// The string value is unchanged — `'instant'` — but the **semantic meaning**
// is now: route through the UXF instant-sender (`instant-sender.ts`) when
// `features.senderUxf === true` (which becomes the default in T.8.D's
// production cutover). When `features.senderUxf === false` (the staged-
// rollout state), the value still narrows to `'instant'` and the legacy
// single-token TXF path runs — this is the temporary back-compat fall-
// through removed by T.8.D.
//
// Spec ref: §2.5 ("Default: `transferMode: 'instant'` over UXF").
// =============================================================================

const DEFAULT_TRANSFER_MODE: TransferMode = 'instant';

// =============================================================================
// Residual shim 1: narrow-or-throw (TXF arm + UNKNOWN-mode guard)
// reason: "Public TransferMode excludes 'txf' but InternalTransferMode
//          includes it; the shim is the single runtime narrow used by the
//          dispatcher in PaymentsModule.send(). Also rejects unknown
//          strings smuggled in by pure-JS callers with the typed
//          UNSUPPORTED_TRANSFER_MODE error."
// =============================================================================

/**
 * Narrow a public {@link TransferMode} (or `undefined`) to an
 * {@link InternalTransferMode}, applying the SDK default and rejecting any
 * value that is not yet routed.
 *
 * - `undefined`        → `'instant'` — post T.7.E this means "instant over
 *   UXF" per §2.5 (semantic flip; literal value unchanged). Routing is
 *   chosen by the dispatcher in
 *   {@link import('../PaymentsModule').PaymentsModule.send}: when
 *   `features.senderUxf === true`, the value lands in
 *   {@link import('./instant-sender').sendInstantUxf}. When the flag is
 *   `false` (staged-rollout state, removed by T.8.D), the value still
 *   narrows to `'instant'` and the legacy single-token TXF path runs.
 * - `'instant'`        → `'instant'`.
 * - `'conservative'`   → `'conservative'`.
 * - `'txf'` (only reachable via `as TransferMode` cast — the public type
 *   intentionally omits it) → `'txf'`. The dispatcher routes the value to
 *   the legacy TXF orchestrator (`txf-sender.ts`).
 * - any other string  → throws `SphereError(UNSUPPORTED_TRANSFER_MODE)`.
 *
 * SHIM (residual, post T.1.B.2). reason: "TXF arm narrowing + UNKNOWN-mode
 * guard; the only conversion between the public TransferMode union and the
 * internal one. T.7.E preserves this shim — only the SEMANTIC meaning of
 * the default changes (legacy-TXF instant → UXF instant). T.8.D moves the
 * narrowing into the dispatcher once the legacy single-token path is
 * removed entirely."
 *
 * @internal
 *
 * @throws SphereError code=`UNSUPPORTED_TRANSFER_MODE` for any value that
 *         is not one of the three known {@link InternalTransferMode} arms.
 */
export function narrowTransferMode(
  mode: TransferMode | undefined,
): InternalTransferMode {
  // Default — post T.7.E "instant over UXF" per §2.5. The literal value is
  // unchanged (`'instant'`); the semantic flip is owned by the dispatcher
  // in `PaymentsModule.send()`: with `features.senderUxf === true` the
  // value routes to `sendInstantUxf`. The narrowing shim cannot itself
  // pick the wire format — that is `senderUxf`'s job — so the contract
  // remains: `undefined` → `'instant'`. Callers that need the legacy
  // wire-shape MUST pass `transferMode: 'txf'` explicitly (and flip
  // `features.senderUxf` ON for the TXF orchestrator to be reachable per
  // T.7.A's typed reject).
  if (mode === undefined) return DEFAULT_TRANSFER_MODE;

  // Public values pass through. `InternalTransferMode` is a strict superset
  // of `TransferMode`, so the assignment is type-sound.
  if (mode === 'instant' || mode === 'conservative') return mode;

  // T.7.A — the legacy `'txf'` arm is wired. The dispatcher in
  // PaymentsModule routes it to `txf-sender.sendTxfUxf` based on the
  // request's `txfFinalization` field (default 'conservative'). The
  // shim itself is value-pass-through; the runtime check is paranoid
  // because TypeScript's public type still excludes `'txf'` (a pure JS
  // caller or a test using `as TransferMode` can smuggle in any string).
  if ((mode as InternalTransferMode) === 'txf') {
    return 'txf';
  }

  throw new SphereError(
    `Unsupported transferMode value: ${JSON.stringify(mode)}. ` +
    "Allowed values: 'instant', 'conservative', 'txf'.",
    'UNSUPPORTED_TRANSFER_MODE',
  );
}

// =============================================================================
// Residual shim 2: legacy single-coin slot narrow (post T.1.B.1 widening)
// reason: "INTERNAL-only coin-slot narrowing; the public TransferRequest
//          widened coinId/amount to optional but the legacy single-coin
//          path still dereferences both fields. T.2.B retires this when
//          the multi-asset validator becomes the routing primitive."
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
 * SHIM (residual, post T.1.B.2). reason: "Brand for the
 * {@link requireLegacyCoinSlot} output; retired by T.2.B together with
 * the shim itself once the multi-asset validator becomes the routing
 * primitive."
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
 * SHIM (residual, post T.1.B.2). reason: "INTERNAL-only coin-slot
 * narrowing; the public TransferRequest widened coinId/amount to
 * optional in T.1.B.1 but the legacy single-coin path still dereferences
 * both fields. T.2.B retires this once the §4.1 step 1 multi-asset
 * validator becomes the routing primitive."
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
