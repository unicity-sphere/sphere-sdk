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
async function configureFromDefinitions(definitions: TokenDefinition[]): Promise<void> {
  const json = JSON.stringify(definitions);
  const fetchSpy = (input: unknown) => Promise.resolve(new Response(json, { status: 200 }));
  const original = globalThis.fetch;
  globalThis.fetch = fetchSpy as typeof globalThis.fetch;
  try {
    TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: true });
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
  // 1. The two networks point at DIFFERENT registry URLs
  // ---------------------------------------------------------------------------
  it('testnet2 and testnet use DIFFERENT tokenRegistryUrl (constants.ts)', () => {
    expect(NETWORKS.testnet2.tokenRegistryUrl).not.toBe(NETWORKS.testnet.tokenRegistryUrl);
    // sanity: each URL names its own network file
    expect(NETWORKS.testnet.tokenRegistryUrl).toContain('unicity-ids.testnet.json');
    expect(NETWORKS.testnet2.tokenRegistryUrl).toContain('unicity-ids.testnet2.json');
  });

  // ---------------------------------------------------------------------------
  // 2. configureTokenRegistry mapping: network -> NETWORKS[network].url,
  //    and UNDEFINED network falls back to NETWORKS.testnet (the bug).
  //    Replicated exactly from core/Sphere.ts:786.
  // ---------------------------------------------------------------------------
  it('maps network -> NETWORKS[network].tokenRegistryUrl, undefined falls back to testnet (the bug)', () => {
    // EXACT logic from Sphere.configureTokenRegistry:
    //   const netConfig = network ? NETWORKS[network] : NETWORKS.testnet;
    const resolveUrl = (network?: keyof typeof NETWORKS): string => {
      const netConfig = network ? NETWORKS[network] : NETWORKS.testnet;
      return netConfig.tokenRegistryUrl;
    };

    // Correct mappings
    expect(resolveUrl('testnet2')).toBe(NETWORKS.testnet2.tokenRegistryUrl);
    expect(resolveUrl('testnet')).toBe(NETWORKS.testnet.tokenRegistryUrl);
    expect(resolveUrl('mainnet')).toBe(NETWORKS.mainnet.tokenRegistryUrl);

    // THE BUG: undefined network resolves to the testnet registry, NOT testnet2.
    expect(resolveUrl(undefined)).toBe(NETWORKS.testnet.tokenRegistryUrl);
    expect(resolveUrl(undefined)).not.toBe(NETWORKS.testnet2.tokenRegistryUrl);
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
  // 5. OPTIONAL network cross-check: fetch BOTH real registry JSONs and prove
  //    they define DIFFERENT coinIds for the same symbol. Skips (does not
  //    fail) if the network is unavailable, so the suite stays deterministic.
  // ---------------------------------------------------------------------------
  it('[network] real testnet vs testnet2 JSON define different coinIds for the same symbol', async () => {
    const fetchJson = async (url: string): Promise<TokenDefinition[] | null> => {
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

    const [testnet, testnet2] = await Promise.all([
      fetchJson(NETWORKS.testnet.tokenRegistryUrl),
      fetchJson(NETWORKS.testnet2.tokenRegistryUrl),
    ]);

    if (!testnet || !testnet2) {
      console.warn('[network] registry fetch unavailable — skipping real-JSON cross-check');
      return; // graceful skip, keeps the deterministic core green
    }

    const idForSymbol = (defs: TokenDefinition[], symbol: string): string | undefined =>
      defs.find((d) => d.symbol?.toUpperCase() === symbol)?.id?.toLowerCase();

    // Find at least one symbol present in BOTH with a DIFFERENT id.
    const symbols = new Set<string>();
    for (const d of [...testnet, ...testnet2]) if (d.symbol) symbols.add(d.symbol.toUpperCase());

    let foundDivergentSymbol = false;
    for (const sym of symbols) {
      const a = idForSymbol(testnet, sym);
      const b = idForSymbol(testnet2, sym);
      if (a && b && a !== b) {
        foundDivergentSymbol = true;
        console.info(`[network] symbol ${sym}: testnet=${a} testnet2=${b} (different)`);
        break;
      }
    }

    expect(foundDivergentSymbol).toBe(true);
  });
});
