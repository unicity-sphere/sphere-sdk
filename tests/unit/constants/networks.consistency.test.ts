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
 * Do NOT weaken these assertions to make a network pass, and do NOT skip them.
 */

import { describe, it, expect } from 'vitest';
import { NETWORKS } from '../../../constants';
import type { NetworkType } from '../../../constants';
import { getEmbeddedTrustBase } from '../../../impl/shared/trustbase-loader';

/** v1 testnet token registry — only testnet itself may legitimately point here. */
/** The v1 testnet registry file. The v1 network is discontinued — nothing may point here. */
const V1_TESTNET_REGISTRY_FILE = 'unicity-ids.testnet.json';

/**
 * Known expected trust-base networkId per network. Must stay in step with
 * EXPECTED_NETWORK_ID in impl/shared/network.ts — that is the runtime guard, this
 * is the CI one. Every network is pinned — an unpinned one would be unchecked at runtime.
 * Since the v1 cutover 'testnet' is an alias of testnet2 (networkId 4).
 */
const EXPECTED_NETWORK_ID: Partial<Record<NetworkType, number>> = {
  mainnet: 1,
  testnet: 4,
  testnet2: 4,
};

/** The consistency checks performed for each network. */
type Check = 'urls' | 'registry' | 'trustbase';

/**
 * (network, check) pairs that are EXPECTED-TO-FAIL until that network is onboarded.
 * EMPTY as of the mainnet onboarding: every network in NETWORKS is fully configured.
 *
 * The mechanism is self-correcting in BOTH directions and that is the point — an
 * entry here uses it.fails(), so the moment its check starts passing the wrapper
 * FAILS and forces the row to be retired deliberately. Add a row only for a network
 * that is genuinely half-configured, never to silence a check.
 *
 * Note this set does not gate the registry check below: nothing may point at the
 * discontinued v1 registry, for any network, ever.
 */
const EXPECTED_FAILURES = new Set<`${NetworkType}:${Check}`>([]);

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
