/**
 * Live cross-check of the PUBLISHED token registries, one per network.
 *
 * This lives in tests/e2e — NOT in the unit suite — on purpose. The registries are
 * mutable data in another repo (unicity-network/unicity-ids), edited independently of
 * this one: coins get added, renamed and retired whenever the operator wants. A CI-gating
 * test that asserts on their live contents makes a registry edit in that repo turn this
 * repo's CI red, which is exactly what happened when unicity-ids.mainnet.json was first
 * published. vitest.config.ts excludes tests/e2e/**, so nothing here gates a PR.
 *
 * The SDK behaviour this backs up — that a registry loaded for one network cannot resolve
 * another network's coinId, so the icon/decimals silently go missing — is proved
 * deterministically from synthetic definitions in
 * tests/unit/registry/TokenRegistry.networkResolution.test.ts. Nothing here is needed for
 * that; this only confirms the real published data still honours the one property the
 * registry design guarantees.
 *
 * Run: npm run test:e2e
 */

import { describe, expect, it } from 'vitest';

import { NETWORKS } from '../../constants';
import type { TokenDefinition } from '../../registry';

const fetchRegistry = async (url: string): Promise<TokenDefinition[] | null> => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as TokenDefinition[];
  } catch {
    return null;
  }
};

const idsOf = (defs: TokenDefinition[]): Set<string> =>
  new Set(defs.map((d) => d.id?.toLowerCase()).filter((id): id is string => !!id));

describe('published token registries — live', () => {
  it('mainnet and testnet2 define DISJOINT coinId spaces', async () => {
    const [mainnet, testnet2] = await Promise.all([
      fetchRegistry(NETWORKS.mainnet.tokenRegistryUrl),
      fetchRegistry(NETWORKS.testnet2.tokenRegistryUrl),
    ]);

    if (!mainnet || !testnet2) {
      console.warn('[e2e] registry fetch unavailable — skipping live cross-check');
      return;
    }

    // The one property that must hold however the registries evolve: an id minted on one
    // network can never resolve against the other's registry. This can only fail by an
    // actual violation (an id copied across networks) — never by adding or renaming coins,
    // which is why it is safe to assert on data someone else owns.
    const testnet2Ids = idsOf(testnet2);
    const shared = [...idsOf(mainnet)].filter((id) => testnet2Ids.has(id));
    expect(shared).toEqual([]);

    console.info(
      `[e2e] mainnet defines ${idsOf(mainnet).size} id(s), testnet2 ${testnet2Ids.size}, overlap 0`,
    );
  });

  it('every definition is tagged with the network it belongs to', async () => {
    for (const [network, expectedTag] of [
      ['mainnet', 'unicity:mainnet'],
      ['testnet2', 'unicity:testnet2'],
    ] as const) {
      const defs = await fetchRegistry(NETWORKS[network].tokenRegistryUrl);
      if (!defs) {
        console.warn(`[e2e] ${network} registry unavailable — skipping`);
        continue;
      }
      // A definition carrying another network's tag is the shape a copy-paste between
      // registry files would take, and nothing downstream would notice it.
      expect(defs.map((d) => (d as { network?: string }).network)).toEqual(
        defs.map(() => expectedTag),
      );
    }
  });
});
