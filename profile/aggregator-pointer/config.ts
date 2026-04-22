/**
 * Pointer-layer configuration + capability gates (T-D5, T-E26).
 *
 * SPEC §13.4 — capability protocol.
 *
 * The pointer layer offers two operator-override surfaces:
 *
 *   allowOperatorOverrides (SPEC §10.2.4, §10.7.1) — gates clearBlocked(),
 *     acceptCarLoss(), clearPendingMarker(), acceptCorruptStreak(). These
 *     APIs are dangerous — they can dismiss data-loss safety interlocks.
 *     Enabling this flag is a user-consent signal.
 *
 *   allowUnverifiedOverride (SPEC §13, W6) — legacy dev-only flag that
 *     suppresses trust-base verification. Currently NOT supported outside
 *     explicit NODE_ENV=development. T-E26 production guard: init throws
 *     CAPABILITY_DENIED when this flag is set in any non-dev environment.
 */

import {
  NODE_ENV_KEY,
  SPHERE_ALLOW_OVERRIDES_KEY,
  SPHERE_ALLOW_OVERRIDES_VALUE,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PointerLayerConfig {
  /**
   * Enables operator-override APIs (clearBlocked, acceptCarLoss,
   * clearPendingMarker, acceptCorruptStreak). Off by default. Enabling
   * is a user-consent signal for data-loss-adjacent operations.
   *
   * Must ALSO match the SPHERE_ALLOW_OVERRIDES environment variable when
   * set (prevents silent enablement from library defaults).
   */
  readonly allowOperatorOverrides?: boolean;

  /**
   * DEV-ONLY: suppress trust-base verification on probe / recover.
   * PRODUCTION USE IS DISALLOWED — init throws CAPABILITY_DENIED when set
   * outside NODE_ENV=development. See SPEC §13 W6.
   */
  readonly allowUnverifiedOverride?: boolean;
}

// ── Capability gate ───────────────────────────────────────────────────────

/**
 * Validate the config at pointer-layer init. Throws CAPABILITY_DENIED for
 * any forbidden combination.
 *
 * Production-build guard (T-E26): allowUnverifiedOverride is permitted ONLY
 * when NODE_ENV === 'development'. This prevents a misconfigured release
 * build from silently accepting forged proofs.
 *
 * @throws AggregatorPointerError(CAPABILITY_DENIED)
 */
export function assertConfigCapabilities(config: PointerLayerConfig): void {
  if (config.allowUnverifiedOverride === true) {
    // Read NODE_ENV defensively — in browsers, process may not exist.
    const nodeEnv =
      typeof process !== 'undefined' && typeof process.env === 'object' && process.env !== null
        ? process.env[NODE_ENV_KEY]
        : undefined;
    if (nodeEnv !== 'development') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAPABILITY_DENIED,
        `PointerLayerConfig.allowUnverifiedOverride is dev-only; current NODE_ENV=${String(nodeEnv)}.`,
        { allowUnverifiedOverride: true, nodeEnv: String(nodeEnv) },
      );
    }
  }

  if (config.allowOperatorOverrides === true) {
    // Check that SPHERE_ALLOW_OVERRIDES env var matches — prevents a library
    // default enabling overrides without explicit operator signal.
    const envValue =
      typeof process !== 'undefined' && typeof process.env === 'object' && process.env !== null
        ? process.env[SPHERE_ALLOW_OVERRIDES_KEY]
        : undefined;
    if (envValue !== SPHERE_ALLOW_OVERRIDES_VALUE) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAPABILITY_DENIED,
        `PointerLayerConfig.allowOperatorOverrides requires env ${SPHERE_ALLOW_OVERRIDES_KEY}=` +
          `${SPHERE_ALLOW_OVERRIDES_VALUE} for defense-in-depth; got ${String(envValue)}.`,
        { allowOperatorOverrides: true, envValue: String(envValue) },
      );
    }
  }
}

/**
 * Check whether the caller may invoke an operator-override API.
 * Non-throwing predicate version of assertOperatorOverridesAllowed.
 */
export function operatorOverridesAllowed(config: PointerLayerConfig): boolean {
  return config.allowOperatorOverrides === true;
}

/**
 * Throwing guard for operator-override API entry points.
 * Use this at the start of clearBlocked, acceptCarLoss, etc.
 */
export function assertOperatorOverridesAllowed(
  config: PointerLayerConfig,
  apiName: string,
): void {
  if (config.allowOperatorOverrides !== true) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CAPABILITY_DENIED,
      `${apiName}() requires Sphere.init({ allowOperatorOverrides: true }). ` +
        `This flag is a user-consent signal for data-loss-adjacent operations ` +
        `(SPEC §10.2.4, §10.7.1).`,
      { apiName },
    );
  }
}
