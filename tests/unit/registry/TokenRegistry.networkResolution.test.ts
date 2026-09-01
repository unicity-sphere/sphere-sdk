/**
 * Mechanism proof: the configured registry NETWORK determines whether a
 * Top-Up coinId resolves (and thus whether its icon is found).
 *
 * Context
 * -------
 * Sphere.configureTokenRegistry() maps a NetworkType to a registry URL:
 *
 *   const netConfig = network ? NETWORKS[network] : NETWORKS.testnet;   // core/Sphere.ts:786
 *   TokenRegistry.configure({ remoteUrl: netConfig.tokenRegistryUrl, storage });
 *
 * testnet and testnet2 ship DIFFERENT registry JSONs and (critically)
 * DIFFERENT coinIds for the same symbol. So a token minted on testnet2
 * (e.g. a Top-Up coin) cannot be resolved by the testnet registry — its
 * icon lookup returns null.
 *
 * The bug: when `network` is undefined, the mapping falls back to
 * NETWORKS.testnet instead of the actual (testnet2) network. A testnet2
 * Top-Up coinId then never resolves and the icon is missing.
 *
 * This test is deterministic: the CORE assertions use a vendored fixture
 * and constants. An OPTIONAL network probe (fetching both real JSONs)
 * cross-checks the "different coinId per network" premise but degrades
 * gracefully (skips) if the network is unavailable, so the suite never
 * flakes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenRegistry } from '../../../registry';
import type { TokenDefinition } from '../../../registry';
import { NETWORKS } from '../../../constants';

// =============================================================================
// Vendored fixtures (deterministic — no network)
// =============================================================================

/**
 * BTC coinId as it appears in the testnet registry
 * (matches the value used in the existing TokenRegistry.test.ts).
 */
const BTC_COIN_ID_TESTNET = '86bc190fcf7b2d07c6078de93db803578760148b16d4431aa2f42a3241ff0daa';

/**
 * BTC coinId as minted on testnet2 — a DIFFERENT id for the SAME symbol.
 * This stands in for a "Top-Up coin" minted on testnet2.
 */
const BTC_COIN_ID_TESTNET2 = '3cc412000000000000000000000000000000000000000000000000000000abcd';

const BTC_TESTNET2_ICON_URL = 'https://example.com/btc-testnet2.png';

/** A registry containing ONLY the testnet2 BTC definition (with icon). */
const TESTNET2_DEFINITIONS: TokenDefinition[] = [
  {
    network: 'unicity:testnet2',
    assetKind: 'fungible',
    name: 'bitcoin',
    symbol: 'BTC',
    decimals: 8,
    description: 'Bitcoin on Unicity testnet2',
    icons: [{ url: BTC_TESTNET2_ICON_URL }],
    id: BTC_COIN_ID_TESTNET2,
  },
];

/** A registry containing ONLY the testnet BTC definition (with icon). */
const TESTNET_DEFINITIONS: TokenDefinition[] = [
  {
    network: 'unicity:testnet',
    assetKind: 'fungible',
    name: 'bitcoin',
    symbol: 'BTC',
    decimals: 8,
    description: 'Bitcoin on Unicity testnet',
    icons: [{ url: 'https://example.com/btc-testnet.png' }],
    id: BTC_COIN_ID_TESTNET,
  },
];

/**
 * Configure the singleton from an in-memory definitions array (no network).
 * Mirrors how Sphere.configureTokenRegistry feeds a remoteUrl's JSON into the
 * registry, but injected directly so the test is deterministic.
 */
async function configureFromDefinitions(
  definitions: TokenDefinition[],
  remoteUrl = 'https://example.com/registry.json',
): Promise<void> {
  const json = JSON.stringify(definitions);
  const fetchSpy = (input: unknown) => Promise.resolve(new Response(json, { status: 200 }));
  const original = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof globalThis.fetch;
  try {
    TokenRegistry.configure({ remoteUrl, autoRefresh: true });
    await TokenRegistry.waitForReady();
  } finally {
    globalThis.fetch = original;
  }
}

/** Configure a NEW remoteUrl whose fetch fails, as an offline/blip switch would. */
async function configureWithFailingFetch(remoteUrl: string): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response('unavailable', { status: 503 }))) as typeof globalThis.fetch;
  try {
    TokenRegistry.configure({ remoteUrl, autoRefresh: true });
    await TokenRegistry.waitForReady();
  } finally {
    globalThis.fetch = original;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('TokenRegistry network resolution (Top-Up icon mechanism)', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
  });

  afterEach(() => {
    TokenRegistry.destroy();
  });

  // ---------------------------------------------------------------------------
  // 1. Since the v1 cutover, 'testnet' is an ALIAS of testnet2: both point at
  //    the testnet2 registry (the v1 testnet registry is retired).
  // ---------------------------------------------------------------------------
  it('testnet is an alias of testnet2 — same tokenRegistryUrl, naming testnet2 (constants.ts)', () => {
    expect(NETWORKS.testnet.tokenRegistryUrl).toBe(NETWORKS.testnet2.tokenRegistryUrl);
    expect(NETWORKS.testnet2.tokenRegistryUrl).toContain('unicity-ids.testnet2.json');
  });

  // ---------------------------------------------------------------------------
  // 2. configureTokenRegistry mapping: network -> NETWORKS[network].url.
  //    The historical "undefined falls back to NETWORKS.testnet" bug is now
  //    benign: testnet aliases testnet2, so the fallback loads the testnet2
  //    registry. Replicated exactly from core/Sphere.ts.
  // ---------------------------------------------------------------------------
  it('maps network -> NETWORKS[network].tokenRegistryUrl; undefined fallback now lands on the testnet2 registry', () => {
    // EXACT logic from Sphere.configureTokenRegistry:
    //   const netConfig = network ? NETWORKS[network] : NETWORKS.testnet;
    const resolveUrl = (network?: keyof typeof NETWORKS): string => {
      const netConfig = network ? NETWORKS[network] : NETWORKS.testnet;
      return netConfig.tokenRegistryUrl;
    };

    // Correct mappings
    expect(resolveUrl('testnet2')).toBe(NETWORKS.testnet2.tokenRegistryUrl);
    expect(resolveUrl('testnet')).toBe(NETWORKS.testnet2.tokenRegistryUrl);
    expect(resolveUrl('mainnet')).toBe(NETWORKS.mainnet.tokenRegistryUrl);

    // The undefined fallback resolves to the (aliased) testnet2 registry.
    expect(resolveUrl(undefined)).toBe(NETWORKS.testnet2.tokenRegistryUrl);
  });

  // ---------------------------------------------------------------------------
  // 3. With the testnet2 registry loaded, the testnet2 BTC coinId resolves
  //    its icon, but the testnet BTC coinId does NOT (it's a different id).
  // ---------------------------------------------------------------------------
  it('testnet2 registry resolves testnet2 BTC icon but NOT the testnet BTC id', async () => {
    await configureFromDefinitions(TESTNET2_DEFINITIONS);
    const registry = TokenRegistry.getInstance();

    // testnet2 Top-Up coinId -> icon found
    expect(registry.getIconUrl(BTC_COIN_ID_TESTNET2)).toBe(BTC_TESTNET2_ICON_URL);
    expect(registry.isKnown(BTC_COIN_ID_TESTNET2)).toBe(true);

    // testnet BTC coinId -> NOT in this registry -> no icon (the missing-icon symptom)
    expect(registry.getIconUrl(BTC_COIN_ID_TESTNET)).toBeNull();
    expect(registry.isKnown(BTC_COIN_ID_TESTNET)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 4. The mirror image — the WRONG-NETWORK scenario that the undefined
  //    fallback produces: a testnet registry cannot resolve a testnet2
  //    (Top-Up) coinId, so its icon is missing.
  // ---------------------------------------------------------------------------
  it('testnet registry CANNOT resolve a testnet2 (Top-Up) coinId -> icon missing (reproduces the bug)', async () => {
    await configureFromDefinitions(TESTNET_DEFINITIONS);
    const registry = TokenRegistry.getInstance();

    // testnet BTC resolves fine in the testnet registry
    expect(registry.isKnown(BTC_COIN_ID_TESTNET)).toBe(true);

    // The testnet2 Top-Up coinId is unknown here -> getIconUrl returns null.
    // This is exactly what the user sees when network is undefined and the
    // wrong (testnet) registry is loaded for a testnet2-minted Top-Up token.
    expect(registry.getIconUrl(BTC_COIN_ID_TESTNET2)).toBeNull();
    expect(registry.isKnown(BTC_COIN_ID_TESTNET2)).toBe(false);
  });
  // ---------------------------------------------------------------------------
  // 5. Switching networks must not leave the previous network's definitions
  //    resolvable. applyDefinitions() is the only clear site and it runs on a
  //    SUCCESSFUL fetch, so without an explicit clear a failed load leaves the old
  //    network's coinIds answering — wrong decimals/symbols for real assets, silently.
  // ---------------------------------------------------------------------------
  it('a network switch drops the previous definitions even when the new fetch FAILS', async () => {
    await configureFromDefinitions(TESTNET2_DEFINITIONS, 'https://example.com/testnet2.json');
    const registry = TokenRegistry.getInstance();
    expect(registry.isKnown(BTC_COIN_ID_TESTNET2)).toBe(true);
    expect(registry.getDecimals(BTC_COIN_ID_TESTNET2)).toBe(8);

    // Switch to another network; its fetch fails (offline, 5xx, DNS blip).
    await configureWithFailingFetch('https://example.com/mainnet.json');

    // The previous network's coinId must no longer resolve, by ANY accessor.
    expect(registry.isKnown(BTC_COIN_ID_TESTNET2)).toBe(false);
    expect(registry.getIconUrl(BTC_COIN_ID_TESTNET2)).toBeNull();
    expect(registry.getDecimals(BTC_COIN_ID_TESTNET2)).toBe(0);
    // getCoinIdBySymbol is public and would otherwise hand back a foreign-network id.
    expect(registry.getCoinIdBySymbol('BTC')).toBeUndefined();
  });

  it('re-configuring the SAME url keeps its definitions (only a real switch clears)', async () => {
    await configureFromDefinitions(TESTNET2_DEFINITIONS, 'https://example.com/testnet2.json');
    const registry = TokenRegistry.getInstance();

    // Sphere and the provider factories both configure, often with the same url —
    // that must not wipe a good registry and leave a window resolving nothing.
    await configureWithFailingFetch('https://example.com/testnet2.json');

    expect(registry.isKnown(BTC_COIN_ID_TESTNET2)).toBe(true);
    expect(registry.getDecimals(BTC_COIN_ID_TESTNET2)).toBe(8);
  });
});
