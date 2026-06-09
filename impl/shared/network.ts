/**
 * Centralized network-config resolution + a startup consistency assertion.
 *
 * Principle: resolve a network's full configuration in ONE place, and refuse to
 * run a network whose configuration is provably broken (e.g. a null or mismatched
 * trust base would silently accept unverified tokens — a funds risk).
 */

import { NETWORKS, type NetworkType, type NetworkConfig } from '../../constants';
import { getEmbeddedTrustBase } from './trustbase-loader';
import { SphereError } from '../../core/errors';

/**
 * Known trust-base networkId per network. The embedded trust base for a network
 * MUST carry this id; a mismatch means the wrong trust base is wired to a network
 * (e.g. the testnet trust base under testnet2), which would verify tokens against
 * the wrong chain. mainnet/dev have no pinned id yet (mainnet is not onboarded).
 */
const EXPECTED_NETWORK_ID: Partial<Record<NetworkType, number>> = {
  testnet: 3,
  testnet2: 4,
};

export interface ResolvedNetworkConfig {
  readonly network: NetworkType;
  readonly config: NetworkConfig;
  readonly trustBase: unknown | null;
  readonly networkId: number | undefined;
}

/** Resolve a network's full config + embedded trust base in one place. */
export function resolveNetworkConfig(network: NetworkType): ResolvedNetworkConfig {
  const config = NETWORKS[network];
  const trustBase = getEmbeddedTrustBase(network);
  const networkId = (trustBase as { networkId?: number } | null)?.networkId;
  return { network, config, trustBase, networkId };
}

/**
 * Fail loud if a network is unsafe to run. Conservative on purpose: it rejects
 * only provably-broken configs, so currently-valid networks (testnet/testnet2/dev)
 * keep working while mainnet — which has no embedded trust base — is blocked until
 * onboarded (otherwise it would silently accept unverified tokens). The stricter
 * hygiene checks (e.g. no cross-network registry reuse) live in the per-network CI
 * test, not at runtime, so they can't break a valid deployment.
 */
export function assertNetworkConsistency(network: NetworkType): void {
  const { trustBase, networkId } = resolveNetworkConfig(network);
  if (trustBase == null) {
    throw new SphereError(
      `Network "${network}" has no embedded trust base — refusing to run (tokens would be unverified).`,
      'INVALID_CONFIG',
    );
  }
  const expected = EXPECTED_NETWORK_ID[network];
  if (expected !== undefined && networkId !== expected) {
    throw new SphereError(
      `Network "${network}" trust base networkId ${networkId} does not match expected ${expected} (wrong trust base wired to this network).`,
      'INVALID_CONFIG',
    );
  }
}
