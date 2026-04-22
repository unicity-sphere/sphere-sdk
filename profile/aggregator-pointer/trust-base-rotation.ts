/**
 * Trust-base rotation detection (T-C4) — SPEC §8.4.1 (H5).
 *
 * The RootTrustBase is statically bundled in the SDK (SPEC §8.4); runtime
 * refresh is deferred to v2.  Rotation is detected by comparing the epoch
 * field embedded in returned inclusion proofs against the bundled trust base.
 *
 *   - cert.epoch > trustBase.epoch → LEGITIMATE ROTATION (validator set churned
 *     faster than SDK release cadence). Remediation: ship a new SDK build
 *     whose bundled RootTrustBase carries the new epoch. Raise
 *     TRUST_BASE_STALE so operators can drive the release.
 *
 *   - cert.epoch < trustBase.epoch → REPLAY / FORGERY. A peer that replays an
 *     older certificate from a prior epoch MUST be rejected. Raise
 *     UNTRUSTED_PROOF.
 *
 *   - cert.epoch == trustBase.epoch → NO ROTATION. If InclusionProof.verify
 *     still returned NOT_AUTHENTICATED, it is adversarial forgery (signatures
 *     don't reach quorum). Raise UNTRUSTED_PROOF.
 *
 * Note: raising TRUST_BASE_STALE is distinct from UNTRUSTED_PROOF so the
 * wallet can surface a "please update the SDK" message rather than a generic
 * "something is wrong" alarm.
 */

import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

/**
 * Result of comparing a proof's certificate epoch against the bundled trust
 * base's epoch.
 */
export interface TrustBaseRotationResult {
  /** True iff the certificate's epoch is strictly greater than the trust base's. */
  readonly isRotation: boolean;
  /** Epoch stored in the bundled RootTrustBase. */
  readonly localEpoch: bigint;
  /** Epoch stored in the certificate's UnicitySeal. */
  readonly certEpoch: bigint;
}

/**
 * Pure classifier — compares a proof's certificate epoch against the trust
 * base's epoch. Does NOT throw; caller decides remediation.
 */
export function classifyTrustBaseRotation(
  trustBase: RootTrustBase,
  proof: InclusionProof,
): TrustBaseRotationResult {
  const localEpoch = trustBase.epoch;
  const certEpoch = proof.unicityCertificate.unicitySeal.epoch;
  return {
    isRotation: certEpoch > localEpoch,
    localEpoch,
    certEpoch,
  };
}

/**
 * Raise the correct error based on proof's epoch vs trust base's epoch.
 *
 * Called by the probe/submit path when `InclusionProof.verify` returns
 * `NOT_AUTHENTICATED` — we need to decide whether the signature failure is
 * a legitimate epoch rotation (SDK update required) or an adversarial forgery.
 *
 * Also called defensively when ANY verification failure is observed — the
 * rotation-vs-forgery decision tree is the same.
 *
 * @throws AggregatorPointerError(TRUST_BASE_STALE) on cert.epoch > local.
 * @throws AggregatorPointerError(UNTRUSTED_PROOF) on cert.epoch <= local.
 */
export function raiseForTrustBaseMismatch(
  trustBase: RootTrustBase,
  proof: InclusionProof,
  context: string,
): never {
  const { isRotation, localEpoch, certEpoch } = classifyTrustBaseRotation(trustBase, proof);

  if (isRotation) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.TRUST_BASE_STALE,
      `${context}: aggregator returned a proof signed under epoch ${certEpoch.toString()}, ` +
        `but the bundled RootTrustBase is pinned at epoch ${localEpoch.toString()}. ` +
        `The BFT validator set has rotated faster than the SDK release cadence; ` +
        `update the SDK to a build whose bundled trust base carries the new epoch ` +
        `(SPEC §8.4.1, H5).`,
      { localEpoch: localEpoch.toString(), certEpoch: certEpoch.toString() },
    );
  }

  // Non-rotation verification failure: either replay of an older epoch or
  // forgery at the current epoch. Either way — reject.
  throw new AggregatorPointerError(
    AggregatorPointerErrorCode.UNTRUSTED_PROOF,
    `${context}: proof failed trustless verification and is NOT a legitimate rotation ` +
      `(cert epoch ${certEpoch.toString()} <= bundled epoch ${localEpoch.toString()}); ` +
      `rejecting as possible replay or forgery (SPEC §8.4.1).`,
    { localEpoch: localEpoch.toString(), certEpoch: certEpoch.toString() },
  );
}
