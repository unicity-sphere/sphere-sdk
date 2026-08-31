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
 * the wrong chain. `dev` has no pinned id yet (it aliases the old v1 testnet base, networkId 3).
 */
const EXPECTED_NETWORK_ID: Partial<Record<NetworkType, number>> = {
  // Pinned so that pasting the WRONG trust base into a network's slot is refused rather than
  // silently accepted — without a row here the check below is skipped entirely for that network.
  mainnet: 1,
  // v1 cutover: 'testnet' is an alias of testnet2 (the v2 gateway network),
  // so both expect the testnet2 trust base (networkId 4).
  testnet: 4,
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
 * only provably-broken configs: a null trust base (tokens would go unverified) or one
 * whose networkId contradicts EXPECTED_NETWORK_ID (the wrong chain's trust base wired
 * to this network). Every network with an embedded base — mainnet included since the
 * mainnet onboarding — passes. The stricter hygiene checks (e.g. no cross-network
 * registry reuse) live in the per-network CI test, not at runtime, so they can't
 * break a valid deployment.
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
