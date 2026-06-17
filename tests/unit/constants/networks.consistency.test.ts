/**
 * Per-network completeness + consistency gate.
 *
 * For EVERY network in NETWORKS this asserts the config is complete and
 * self-consistent. This is the CI gate that blocks a broken/half-baked network
 * (especially mainnet) from shipping silently on testnet data — e.g. a mainnet
 * that still points at the testnet (v1) token registry, or has no embedded
 * trust base.
 *
 * Currently-incomplete networks (mainnet, dev — not yet onboarded, see plan
 * Phase 4) are wrapped, per failing check, in vitest's it.fails(): those checks
 * are EXPECTED to fail today. The moment someone makes such a check pass (by
 * onboarding the network for real), its it.fails starts failing — because the
 * body now PASSES — forcing them to flip that row to a real it(). This keeps the
 * gap visible AND self-correcting instead of silently green.
 *
 * Note: it.fails() requires the body to actually throw, so the it/it.fails
 * choice is made PER (network, check) — a network may have some checks already
 * passing (real it) and others still failing (it.fails). See EXPECTED_FAILURES.
 *
 * Do NOT weaken these assertions to make mainnet/dev pass, and do NOT skip them.
 */

import { describe, it, expect } from 'vitest';
import { NETWORKS } from '../../../constants';
import type { NetworkType } from '../../../constants';
import { getEmbeddedTrustBase } from '../../../impl/shared/trustbase-loader';

/** v1 testnet token registry — only testnet itself may legitimately point here. */
const V1_TESTNET_REGISTRY_FILE = 'unicity-ids.testnet.json';

/**
 * Known expected trust-base networkId per network. mainnet's real id is unknown
 * until it exists; dev currently aliases the old testnet, so neither is pinned
 * here. Since the v1 cutover 'testnet' is an alias of testnet2 (networkId 4).
 */
const EXPECTED_NETWORK_ID: Partial<Record<NetworkType, number>> = {
  testnet: 4,
  testnet2: 4,
};

/** The consistency checks performed for each network. */
type Check = 'urls' | 'registry' | 'trustbase';

/**
 * (network, check) pairs that are EXPECTED-TO-FAIL until that network is
 * onboarded (plan Phase 4); flip the entry to a real it() — i.e. remove it from
 * this set — when its registry + trustbase are real.
 *
 * Verified against constants.ts / assets/trustbase.ts as of this writing:
 *  - mainnet.tokenRegistryUrl === TOKEN_REGISTRY_URL (the v1 testnet.json)  → 'registry' fails
 *  - TRUSTBASE_MAINNET === null                                            → 'trustbase' fails
 *    (mainnet 'urls' already passes: all URL fields are truthy today.)
 *  - dev.tokenRegistryUrl === TOKEN_REGISTRY_URL (the v1 testnet.json)      → 'registry' fails
 *    (dev 'urls' and 'trustbase' already pass: TRUSTBASE_DEV aliases testnet,
 *     and dev has no pinned expected networkId.)
 */
const EXPECTED_FAILURES = new Set<`${NetworkType}:${Check}`>([
  'mainnet:registry',
  'mainnet:trustbase',
  'dev:registry',
]);

describe.each(Object.keys(NETWORKS) as NetworkType[])('network "%s" config', (net) => {
  const config = NETWORKS[net];
  // Pick it() vs it.fails() per check, so each known gap stays tracked and
  // self-correcting without masking the checks that already pass.
  const test = (check: Check) =>
    EXPECTED_FAILURES.has(`${net}:${check}`) ? it.fails : it;

  test('urls')('has all required URL fields present and truthy', () => {
    expect(config.tokenRegistryUrl).toBeTruthy();
    expect(config.aggregatorUrl).toBeTruthy();
    expect(config.nostrRelays.length).toBeGreaterThan(0);
    expect(config.groupRelays.length).toBeGreaterThan(0);
  });

  test('registry')(
    'registry URL names this network (no cross-network reuse of v1 testnet registry)',
    () => {
      // v1 cutover: 'testnet' is an alias of testnet2 and must use the testnet2
      // registry — NO network may point at the v1 testnet registry anymore.
      expect(config.tokenRegistryUrl).not.toContain(V1_TESTNET_REGISTRY_FILE);
    },
  );

  test('trustbase')('has a non-null embedded trust base with matching networkId', () => {
    const trustBase = getEmbeddedTrustBase(net);
    expect(trustBase).not.toBeNull();

    const expectedId = EXPECTED_NETWORK_ID[net];
    if (expectedId !== undefined) {
      expect((trustBase as { networkId: number }).networkId).toBe(expectedId);
    }
  });
});
