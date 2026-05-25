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

  /**
   * Issue #264 — enables the `pointer-win` Nostr broadcast publisher
   * (in `LifecycleManager.publishAggregatorPointerBestEffort` after a
   * successful publish) AND the per-wallet subscriber (in
   * `Sphere.maybeInstallPointerWinSubscription`).
   *
   * OFF BY DEFAULT post-#264: broadcasts were originally introduced
   * (PR #257, RFC-251 Approach D) as an optimization to short-circuit
   * the aggregator's 30-60s read-replica lag for sibling devices that
   * share an HD identity. Issue #264 reframes them as an OPTIONAL
   * convergence-speed optimization, not a correctness requirement —
   * convergence is now guaranteed by:
   *   1. The aggregator pointer versions alone (the load-bearing
   *      cross-device source of truth); AND
   *   2. The flush-scheduler's monotonicity-violation auto-merge,
   *      which reconstructs the missing state in-place rather than
   *      throwing.
   *
   * With auto-merge in place, broadcasts add no correctness signal —
   * a wrong/stale broadcast at best speeds convergence and at worst
   * triggers an extra wasted publish cycle. We turn them off so the
   * system's convergence properties can be tested without the
   * optimization layer obscuring them.
   *
   * When `enablePointerWinBroadcasts !== true`:
   *   - `LifecycleManager.publishAggregatorPointerBestEffort` skips
   *     signing the broadcast payload and emitting the
   *     `storage:pointer-published` event (publisher side OFF).
   *   - `Sphere.maybeInstallPointerWinSubscription` returns early —
   *     the per-wallet Nostr subscription is never installed
   *     (subscriber side OFF).
   *
   * Strictly `=== true` to enable — defends against accidental
   * truthy-but-not-boolean values (`'true'`, `1`) being interpreted
   * as enabled.
   *
   * Flip to `true` to re-enable the optimization layer once auto-merge
   * convergence is proven without it.
   */
  readonly enablePointerWinBroadcasts?: boolean;
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
    // T-E26 production-build guard. Operator overrides are
    // defense-in-depth capability gates; permitting them in a
    // production-released wallet is a configuration error that must
    // fail loudly rather than silently expose the dangerous APIs.
    // Dev builds and staging can opt in explicitly via the env var
    // below; a genuine operator-override deployment would set
    // NODE_ENV to something other than 'production' (e.g. 'staging'
    // or leave it unset for a dev-tools build).
    //
    // Normalize to lowercase so accidental `PRODUCTION` / `Production`
    // from a misconfigured CI still fails closed. Node ecosystem
    // convention is lowercase-only but we do not rely on the caller
    // getting that right — the guard must hold regardless of case.
    const nodeEnvRaw =
      typeof process !== 'undefined' && typeof process.env === 'object' && process.env !== null
        ? process.env[NODE_ENV_KEY]
        : undefined;
    const nodeEnv = typeof nodeEnvRaw === 'string' ? nodeEnvRaw.toLowerCase() : nodeEnvRaw;
    if (nodeEnv === 'production') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAPABILITY_DENIED,
        `PointerLayerConfig.allowOperatorOverrides is forbidden in production builds ` +
          `(NODE_ENV=${String(nodeEnvRaw)}). Remove the flag or rebuild with a non-production ` +
          `NODE_ENV. SPEC §13 / T-E26 production-build guard.`,
        { allowOperatorOverrides: true, nodeEnv: String(nodeEnvRaw) },
      );
    }

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
