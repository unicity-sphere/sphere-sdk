/**
 * Tests for registry/TokenRegistry.ts
 * Covers token metadata lookup functionality with StorageProvider caching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenRegistry,
  getTokenDefinition,
  getTokenSymbol,
  getTokenName,
  getTokenDecimals,
  getTokenIconUrl,
  isKnownToken,
  getCoinIdBySymbol,
  getCoinIdByName,
} from '../../../registry';
import type { StorageProvider } from '../../../storage';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';

// =============================================================================
// Test Data Constants
// =============================================================================

const UCT_COIN_ID = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
const USDU_COIN_ID = '8f0f3d7a5e7297be0ee98c63b81bcebb2740f43f616566fc290f9823a54f52d7';
const BTC_COIN_ID = '86bc190fcf7b2d07c6078de93db803578760148b16d4431aa2f42a3241ff0daa';
const SOL_COIN_ID = 'dee5f8ce778562eec90e9c38a91296a023210ccc76ff4c29d527ac3eb64ade93';
const UNICITY_NFT_COIN_ID = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
const UNKNOWN_COIN_ID = '0000000000000000000000000000000000000000000000000000000000000000';

// =============================================================================
// Test Token Definitions (simulates data from remote/cache)
// =============================================================================

const TEST_DEFINITIONS = [
  {
    network: 'unicity:testnet',
    assetKind: 'fungible' as const,
    name: 'unicity',
    symbol: 'UCT',
    decimals: 18,
    description: 'Unicity token',
    icons: [{ url: 'https://example.com/unicity_logo.svg' }, { url: 'https://example.com/unicity_logo.png' }],
    id: UCT_COIN_ID,
  },
  {
    network: 'unicity:testnet',
    assetKind: 'fungible' as const,
    name: 'usdu',
    symbol: 'USDU',
    decimals: 6,
    description: 'USD stablecoin on Unicity',
    id: USDU_COIN_ID,
  },
  {
    network: 'unicity:testnet',
    assetKind: 'fungible' as const,
    name: 'bitcoin',
    symbol: 'BTC',
    decimals: 8,
    description: 'Bitcoin on Unicity',
    icons: [{ url: 'https://example.com/btc.svg' }, { url: 'https://example.com/btc.PNG' }],
    id: BTC_COIN_ID,
  },
  {
    network: 'unicity:testnet',
    assetKind: 'fungible' as const,
    name: 'solana',
    symbol: 'SOL',
    decimals: 9,
    description: 'Solana on Unicity',
    id: SOL_COIN_ID,
  },
  {
    network: 'unicity:testnet',
    assetKind: 'non-fungible' as const,
    name: 'unicity',
    description: 'Unicity NFT',
    id: UNICITY_NFT_COIN_ID,
  },
];

// =============================================================================
// Helpers
// =============================================================================

function createMockStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    remove: vi.fn(async (key: string) => { store.delete(key); }),
    has: vi.fn(async (key: string) => store.has(key)),
    clear: vi.fn(async () => { store.clear(); }),
    setIdentity: vi.fn(),
  } as unknown as StorageProvider;
}

/**
 * Configure TokenRegistry with pre-populated cache (simulates persistent cache)
 * Returns the mock storage for further assertions.
 */
async function configureWithCache(
  definitions = TEST_DEFINITIONS,
  cacheTs = Date.now(),
): Promise<StorageProvider> {
  const storage = createMockStorage();

  // Pre-populate cache
  await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE, JSON.stringify(definitions));
  await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS, String(cacheTs));

  // Configure with cache, no auto-refresh
  TokenRegistry.configure({ storage, autoRefresh: false });

  // Wait for loadFromCache (it's fire-and-forget in configure, give it a tick)
  await new Promise((resolve) => setTimeout(resolve, 0));

  return storage;
}

// =============================================================================
// TokenRegistry Singleton Tests
// =============================================================================

describe('TokenRegistry', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TokenRegistry.destroy();
    vi.restoreAllMocks();
  });

  describe('getInstance()', () => {
    it('should return a TokenRegistry instance', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry).toBeInstanceOf(TokenRegistry);
    });

    it('should return the same instance on multiple calls', () => {
      const instance1 = TokenRegistry.getInstance();
      const instance2 = TokenRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('resetInstance()', () => {
    it('should reset the singleton instance', () => {
      const instance1 = TokenRegistry.getInstance();
      TokenRegistry.resetInstance();
      const instance2 = TokenRegistry.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  // ===========================================================================
  // Empty registry (no cache, no fetch)
  // ===========================================================================

  describe('empty registry (no cache, no remote)', () => {
    it('should return undefined for any coin ID', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getDefinition(UCT_COIN_ID)).toBeUndefined();
    });

    it('should return empty array from getAllDefinitions()', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getAllDefinitions()).toEqual([]);
    });

    it('should return false from isKnown()', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UCT_COIN_ID)).toBe(false);
    });

    it('should return fallback from getSymbol()', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getSymbol(UCT_COIN_ID)).toBe('455AD8');
    });

    it('should return coinId from getName()', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getName(UCT_COIN_ID)).toBe(UCT_COIN_ID);
    });
  });

  // ===========================================================================
  // getDefinition Tests (with cached data)
  // ===========================================================================

  describe('getDefinition()', () => {
    it('should return token definition for known coin ID', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinition(UCT_COIN_ID);

      expect(def).toBeDefined();
      expect(def?.symbol).toBe('UCT');
      expect(def?.name).toBe('unicity');
      expect(def?.decimals).toBe(18);
    });

    it('should return undefined for unknown coin ID', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinition(UNKNOWN_COIN_ID);
      expect(def).toBeUndefined();
    });

    it('should be case-insensitive', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const defLower = registry.getDefinition(UCT_COIN_ID.toLowerCase());
      const defUpper = registry.getDefinition(UCT_COIN_ID.toUpperCase());

      expect(defLower).toBeDefined();
      expect(defUpper).toBeDefined();
      expect(defLower?.symbol).toBe('UCT');
      expect(defUpper?.symbol).toBe('UCT');
      expect(defLower?.id).toBe(defUpper?.id);
    });

    it('should return undefined for empty string', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinition('');
      expect(def).toBeUndefined();
    });
  });

  // ===========================================================================
  // getDefinitionBySymbol Tests
  // ===========================================================================

  describe('getDefinitionBySymbol()', () => {
    it('should return token definition for known symbol', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionBySymbol('UCT');

      expect(def).toBeDefined();
      expect(def?.id).toBe(UCT_COIN_ID);
      expect(def?.decimals).toBe(18);
    });

    it('should be case-insensitive', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const defUpper = registry.getDefinitionBySymbol('UCT');
      const defLower = registry.getDefinitionBySymbol('uct');
      const defMixed = registry.getDefinitionBySymbol('Uct');

      expect(defUpper).toBeDefined();
      expect(defLower).toBeDefined();
      expect(defMixed).toBeDefined();
      expect(defUpper?.id).toBe(defLower?.id);
      expect(defUpper?.id).toBe(defMixed?.id);
    });

    it('should return undefined for unknown symbol', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionBySymbol('UNKNOWN');
      expect(def).toBeUndefined();
    });

    it('should return undefined for empty string', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionBySymbol('');
      expect(def).toBeUndefined();
    });
  });

  // ===========================================================================
  // getDefinitionByName Tests
  // ===========================================================================

  describe('getDefinitionByName()', () => {
    it('should return token definition for known name', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionByName('bitcoin');

      expect(def).toBeDefined();
      expect(def?.symbol).toBe('BTC');
      expect(def?.id).toBe(BTC_COIN_ID);
    });

    it('should be case-insensitive', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const defLower = registry.getDefinitionByName('bitcoin');
      const defUpper = registry.getDefinitionByName('BITCOIN');
      const defMixed = registry.getDefinitionByName('Bitcoin');

      expect(defLower).toBeDefined();
      expect(defUpper).toBeDefined();
      expect(defMixed).toBeDefined();
      expect(defLower?.id).toBe(defUpper?.id);
    });

    it('should return undefined for unknown name', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionByName('unknowntoken');
      expect(def).toBeUndefined();
    });

    it('should return undefined for empty string', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionByName('');
      expect(def).toBeUndefined();
    });
  });

  // ===========================================================================
  // getSymbol Tests
  // ===========================================================================

  describe('getSymbol()', () => {
    it('should return symbol for known token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getSymbol(UCT_COIN_ID)).toBe('UCT');
      expect(registry.getSymbol(USDU_COIN_ID)).toBe('USDU');
      expect(registry.getSymbol(BTC_COIN_ID)).toBe('BTC');
    });

    it('should return truncated ID for unknown token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const symbol = registry.getSymbol(UNKNOWN_COIN_ID);
      expect(symbol).toBe('000000');
    });

    it('should return truncated ID for non-fungible token without symbol', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const symbol = registry.getSymbol(UNICITY_NFT_COIN_ID);
      expect(symbol).toBe('F8AA13');
    });
  });

  // ===========================================================================
  // getName Tests
  // ===========================================================================

  describe('getName()', () => {
    it('should return capitalized name for known token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getName(UCT_COIN_ID)).toBe('Unicity');
      expect(registry.getName(BTC_COIN_ID)).toBe('Bitcoin');
      expect(registry.getName(SOL_COIN_ID)).toBe('Solana');
    });

    it('should return coin ID for unknown token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const name = registry.getName(UNKNOWN_COIN_ID);
      expect(name).toBe(UNKNOWN_COIN_ID);
    });
  });

  // ===========================================================================
  // getDecimals Tests
  // ===========================================================================

  describe('getDecimals()', () => {
    it('should return correct decimals for different tokens', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getDecimals(UCT_COIN_ID)).toBe(18);
      expect(registry.getDecimals(USDU_COIN_ID)).toBe(6);
      expect(registry.getDecimals(BTC_COIN_ID)).toBe(8);
      expect(registry.getDecimals(SOL_COIN_ID)).toBe(9);
    });

    it('should return 0 for unknown token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getDecimals(UNKNOWN_COIN_ID)).toBe(0);
    });

    it('should return 0 for non-fungible token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getDecimals(UNICITY_NFT_COIN_ID)).toBe(0);
    });
  });

  // ===========================================================================
  // getIconUrl Tests
  // ===========================================================================

  describe('getIconUrl()', () => {
    it('should return icon URL for known token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(UCT_COIN_ID);
      expect(iconUrl).toBeDefined();
      expect(iconUrl).toContain('unicity_logo');
    });

    it('should prefer PNG when preferPng is true', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(BTC_COIN_ID, true);
      expect(iconUrl).toBeDefined();
      expect(iconUrl?.toLowerCase()).toContain('.png');
    });

    it('should return SVG when preferPng is false and SVG exists', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(BTC_COIN_ID, false);
      expect(iconUrl).toBeDefined();
      expect(iconUrl?.toLowerCase()).toContain('.svg');
    });

    it('should return null for unknown token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(UNKNOWN_COIN_ID);
      expect(iconUrl).toBeNull();
    });

    it('should return null for token without icons', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(UNICITY_NFT_COIN_ID);
      expect(iconUrl).toBeNull();
    });
  });

  // ===========================================================================
  // isKnown Tests
  // ===========================================================================

  describe('isKnown()', () => {
    it('should return true for known token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UCT_COIN_ID)).toBe(true);
      expect(registry.isKnown(BTC_COIN_ID)).toBe(true);
    });

    it('should return false for unknown token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UNKNOWN_COIN_ID)).toBe(false);
    });

    it('should be case-insensitive', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UCT_COIN_ID.toUpperCase())).toBe(true);
      expect(registry.isKnown(UCT_COIN_ID.toLowerCase())).toBe(true);
    });
  });

  // ===========================================================================
  // getAllDefinitions Tests
  // ===========================================================================

  describe('getAllDefinitions()', () => {
    it('should return all token definitions', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const all = registry.getAllDefinitions();

      expect(all).toBeInstanceOf(Array);
      expect(all.length).toBe(TEST_DEFINITIONS.length);
    });

    it('should include both fungible and non-fungible tokens', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const all = registry.getAllDefinitions();

      const hasFungible = all.some((def) => def.assetKind === 'fungible');
      const hasNonFungible = all.some((def) => def.assetKind === 'non-fungible');

      expect(hasFungible).toBe(true);
      expect(hasNonFungible).toBe(true);
    });
  });

  // ===========================================================================
  // getFungibleTokens Tests
  // ===========================================================================

  describe('getFungibleTokens()', () => {
    it('should return only fungible tokens', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const fungibles = registry.getFungibleTokens();

      const expectedFungible = TEST_DEFINITIONS.filter((d) => d.assetKind === 'fungible').length;
      expect(fungibles.length).toBe(expectedFungible);
      expect(fungibles.every((def) => def.assetKind === 'fungible')).toBe(true);
    });

    it('should include UCT and BTC', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const fungibles = registry.getFungibleTokens();

      const symbols = fungibles.map((def) => def.symbol);
      expect(symbols).toContain('UCT');
      expect(symbols).toContain('BTC');
    });
  });

  // ===========================================================================
  // getNonFungibleTokens Tests
  // ===========================================================================

  describe('getNonFungibleTokens()', () => {
    it('should return only non-fungible tokens', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const nfts = registry.getNonFungibleTokens();

      const expectedNft = TEST_DEFINITIONS.filter((d) => d.assetKind === 'non-fungible').length;
      expect(nfts.length).toBe(expectedNft);
      expect(nfts.every((def) => def.assetKind === 'non-fungible')).toBe(true);
    });

    it('should include unicity NFT token', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      const nfts = registry.getNonFungibleTokens();

      expect(nfts[0]?.id.toLowerCase()).toBe(UNICITY_NFT_COIN_ID.toLowerCase());
    });
  });

  // ===========================================================================
  // getCoinIdBySymbol Tests
  // ===========================================================================

  describe('getCoinIdBySymbol()', () => {
    it('should return coin ID for known symbol', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdBySymbol('UCT')).toBe(UCT_COIN_ID);
      expect(registry.getCoinIdBySymbol('BTC')).toBe(BTC_COIN_ID);
    });

    it('should be case-insensitive', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdBySymbol('uct')).toBe(UCT_COIN_ID);
      expect(registry.getCoinIdBySymbol('Btc')).toBe(BTC_COIN_ID);
    });

    it('should return undefined for unknown symbol', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdBySymbol('UNKNOWN')).toBeUndefined();
    });
  });

  // ===========================================================================
  // getCoinIdByName Tests
  // ===========================================================================

  describe('getCoinIdByName()', () => {
    it('should return coin ID for known name', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdByName('bitcoin')).toBe(BTC_COIN_ID);
      expect(registry.getCoinIdByName('solana')).toBe(SOL_COIN_ID);
    });

    it('should be case-insensitive', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdByName('Bitcoin')).toBe(BTC_COIN_ID);
      expect(registry.getCoinIdByName('SOLANA')).toBe(SOL_COIN_ID);
    });

    it('should return undefined for unknown name', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdByName('unknowntoken')).toBeUndefined();
    });
  });
});

// =============================================================================
// Convenience Functions Tests
// =============================================================================

describe('Convenience Functions', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TokenRegistry.destroy();
    vi.restoreAllMocks();
  });

  describe('getTokenDefinition()', () => {
    it('should return token definition', async () => {
      await configureWithCache();
      const def = getTokenDefinition(UCT_COIN_ID);
      expect(def).toBeDefined();
      expect(def?.symbol).toBe('UCT');
    });

    it('should return undefined for unknown token', async () => {
      await configureWithCache();
      const def = getTokenDefinition(UNKNOWN_COIN_ID);
      expect(def).toBeUndefined();
    });
  });

  describe('getTokenSymbol()', () => {
    it('should return symbol for known token', async () => {
      await configureWithCache();
      expect(getTokenSymbol(UCT_COIN_ID)).toBe('UCT');
      expect(getTokenSymbol(BTC_COIN_ID)).toBe('BTC');
    });

    it('should return truncated ID for unknown token', async () => {
      await configureWithCache();
      expect(getTokenSymbol(UNKNOWN_COIN_ID)).toBe('000000');
    });
  });

  describe('getTokenName()', () => {
    it('should return capitalized name', async () => {
      await configureWithCache();
      expect(getTokenName(UCT_COIN_ID)).toBe('Unicity');
      expect(getTokenName(BTC_COIN_ID)).toBe('Bitcoin');
    });

    it('should return coin ID for unknown token', async () => {
      await configureWithCache();
      expect(getTokenName(UNKNOWN_COIN_ID)).toBe(UNKNOWN_COIN_ID);
    });
  });

  describe('getTokenDecimals()', () => {
    it('should return decimals for known token', async () => {
      await configureWithCache();
      expect(getTokenDecimals(UCT_COIN_ID)).toBe(18);
      expect(getTokenDecimals(USDU_COIN_ID)).toBe(6);
    });

    it('should return 0 for unknown token', async () => {
      await configureWithCache();
      expect(getTokenDecimals(UNKNOWN_COIN_ID)).toBe(0);
    });
  });

  describe('getTokenIconUrl()', () => {
    it('should return icon URL for known token', async () => {
      await configureWithCache();
      const iconUrl = getTokenIconUrl(UCT_COIN_ID);
      expect(iconUrl).toBeDefined();
      expect(iconUrl).toContain('unicity_logo');
    });

    it('should return null for unknown token', async () => {
      await configureWithCache();
      expect(getTokenIconUrl(UNKNOWN_COIN_ID)).toBeNull();
    });

    it('should prefer PNG by default', async () => {
      await configureWithCache();
      const iconUrl = getTokenIconUrl(BTC_COIN_ID);
      expect(iconUrl?.toLowerCase()).toContain('.png');
    });

    it('should return SVG when preferPng is false', async () => {
      await configureWithCache();
      const iconUrl = getTokenIconUrl(BTC_COIN_ID, false);
      expect(iconUrl?.toLowerCase()).toContain('.svg');
    });
  });

  describe('isKnownToken()', () => {
    it('should return true for known token', async () => {
      await configureWithCache();
      expect(isKnownToken(UCT_COIN_ID)).toBe(true);
    });

    it('should return false for unknown token', async () => {
      await configureWithCache();
      expect(isKnownToken(UNKNOWN_COIN_ID)).toBe(false);
    });
  });

  describe('getCoinIdBySymbol()', () => {
    it('should return coin ID for known symbol', async () => {
      await configureWithCache();
      expect(getCoinIdBySymbol('UCT')).toBe(UCT_COIN_ID);
      expect(getCoinIdBySymbol('BTC')).toBe(BTC_COIN_ID);
    });

    it('should return undefined for unknown symbol', async () => {
      await configureWithCache();
      expect(getCoinIdBySymbol('UNKNOWN')).toBeUndefined();
    });
  });

  describe('getCoinIdByName()', () => {
    it('should return coin ID for known name', async () => {
      await configureWithCache();
      expect(getCoinIdByName('bitcoin')).toBe(BTC_COIN_ID);
    });

    it('should return undefined for unknown name', async () => {
      await configureWithCache();
      expect(getCoinIdByName('unknowntoken')).toBeUndefined();
    });
  });
});

// =============================================================================
// Token Definition Structure Tests
// =============================================================================

describe('Token Definition Structure', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TokenRegistry.destroy();
    vi.restoreAllMocks();
  });

  it('should have required fields for fungible tokens', async () => {
    await configureWithCache();
    const def = getTokenDefinition(UCT_COIN_ID);

    expect(def).toBeDefined();
    expect(def?.network).toBeDefined();
    expect(def?.assetKind).toBe('fungible');
    expect(def?.name).toBeDefined();
    expect(def?.symbol).toBeDefined();
    expect(def?.decimals).toBeDefined();
    expect(def?.description).toBeDefined();
    expect(def?.id).toBeDefined();
  });

  it('should have required fields for non-fungible tokens', async () => {
    await configureWithCache();
    const def = getTokenDefinition(UNICITY_NFT_COIN_ID);

    expect(def).toBeDefined();
    expect(def?.network).toBeDefined();
    expect(def?.assetKind).toBe('non-fungible');
    expect(def?.name).toBeDefined();
    expect(def?.description).toBeDefined();
    expect(def?.id).toBeDefined();
    expect(def?.symbol).toBeUndefined();
    expect(def?.decimals).toBeUndefined();
  });

  it('should have valid coin IDs (64 hex characters)', async () => {
    await configureWithCache();
    const registry = TokenRegistry.getInstance();
    const all = registry.getAllDefinitions();

    for (const def of all) {
      expect(def.id).toMatch(/^[0-9a-f]{64}$/i);
    }
  });

  it('should have valid network identifier', async () => {
    await configureWithCache();
    const registry = TokenRegistry.getInstance();
    const all = registry.getAllDefinitions();

    for (const def of all) {
      expect(def.network).toMatch(/^unicity:/);
    }
  });
});

// =============================================================================
// StorageProvider Cache Tests
// =============================================================================

describe('StorageProvider Cache', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TokenRegistry.destroy();
    vi.restoreAllMocks();
  });

  it('should load from fresh cache on configure()', async () => {
    const storage = await configureWithCache(TEST_DEFINITIONS, Date.now());
    const registry = TokenRegistry.getInstance();

    // Data should be loaded from cache
    expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();
    expect(registry.getDefinition(UCT_COIN_ID)?.symbol).toBe('UCT');
    expect(storage.get).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE);
    expect(storage.get).toHaveBeenCalledWith(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS);
  });

  it('should skip stale cache (age > refreshIntervalMs)', async () => {
    const storage = createMockStorage();
    const staleTs = Date.now() - 2 * 3_600_000; // 2 hours ago

    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE, JSON.stringify(TEST_DEFINITIONS));
    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS, String(staleTs));

    TokenRegistry.configure({ storage, autoRefresh: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const registry = TokenRegistry.getInstance();
    // Stale cache should not be loaded
    expect(registry.getDefinition(UCT_COIN_ID)).toBeUndefined();
    expect(registry.getAllDefinitions()).toEqual([]);
  });

  it('should skip cache with missing timestamp', async () => {
    const storage = createMockStorage();
    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE, JSON.stringify(TEST_DEFINITIONS));
    // No timestamp set

    TokenRegistry.configure({ storage, autoRefresh: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const registry = TokenRegistry.getInstance();
    expect(registry.getAllDefinitions()).toEqual([]);
  });

  it('should skip cache with invalid JSON', async () => {
    const storage = createMockStorage();
    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE, 'not valid json');
    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS, String(Date.now()));

    TokenRegistry.configure({ storage, autoRefresh: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const registry = TokenRegistry.getInstance();
    expect(registry.getAllDefinitions()).toEqual([]);
  });

  it('should save to cache after successful remote fetch', async () => {
    const storage = createMockStorage();
    const json = JSON.stringify(TEST_DEFINITIONS);

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );

    TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', storage, autoRefresh: false });
    const registry = TokenRegistry.getInstance();

    await registry.refreshFromRemote();

    // Should have called storage.set for cache and timestamp
    expect(storage.set).toHaveBeenCalledWith(
      STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE,
      expect.any(String),
    );
    expect(storage.set).toHaveBeenCalledWith(
      STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS,
      expect.any(String),
    );
  });

  it('should not save to cache on fetch failure', async () => {
    const storage = createMockStorage();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', storage, autoRefresh: false });
    const registry = TokenRegistry.getInstance();

    await registry.refreshFromRemote();

    // storage.set should NOT have been called with cache keys
    const setCalls = (storage.set as ReturnType<typeof vi.fn>).mock.calls;
    const cacheSetCalls = setCalls.filter(
      ([key]: [string]) => key === STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE,
    );
    expect(cacheSetCalls).toHaveLength(0);
  });

  it('should not overwrite newer remote data with stale cache', async () => {
    const storage = createMockStorage();
    const json = JSON.stringify(REMOTE_TEST_DATA);

    // Pre-populate storage with old cache data
    const oldCacheTs = Date.now() - 10_000; // 10 seconds ago
    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE, JSON.stringify(TEST_DEFINITIONS));
    await storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS, String(oldCacheTs));

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(new Response(json, { status: 200 })),
    );

    // First do a remote refresh to get newer data
    TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', storage, autoRefresh: false });
    const registry = TokenRegistry.getInstance();
    await registry.refreshFromRemote();

    // Verify remote data is loaded
    expect(registry.getDefinitionBySymbol('NEW')).toBeDefined();
    expect(registry.getAllDefinitions().length).toBe(REMOTE_TEST_DATA.length);

    // Now simulate a late cache load (by calling loadFromCache via a second configure)
    // The cache has older timestamp, so it should NOT overwrite
    TokenRegistry.configure({ storage, autoRefresh: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Remote data should still be there (cache didn't overwrite)
    expect(registry.getDefinitionBySymbol('NEW')).toBeDefined();
    expect(registry.getAllDefinitions().length).toBe(REMOTE_TEST_DATA.length);
  });

  it('should handle storage.set throwing during saveToCache', async () => {
    const storage = createMockStorage();
    const json = JSON.stringify(TEST_DEFINITIONS);

    // Make storage.set throw after initial setup
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => Promise.resolve(new Response(json, { status: 200 })),
    );

    TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', storage, autoRefresh: false });

    // Override storage.set to throw
    (storage.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Storage full'));

    const registry = TokenRegistry.getInstance();
    const result = await registry.refreshFromRemote();

    // Fetch should still succeed even though cache save failed
    expect(result).toBe(true);
    expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();
  });
});

// =============================================================================
// Remote Refresh Tests
// =============================================================================

const REMOTE_TEST_DATA = [
  {
    network: 'unicity:testnet',
    assetKind: 'fungible' as const,
    name: 'newtoken',
    symbol: 'NEW',
    decimals: 12,
    description: 'A new test token',
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  {
    network: 'unicity:testnet',
    assetKind: 'fungible' as const,
    name: 'anothertoken',
    symbol: 'ANT',
    decimals: 8,
    description: 'Another test token',
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
];

describe('Remote Refresh', () => {
  beforeEach(() => {
    TokenRegistry.resetInstance();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    TokenRegistry.destroy();
    vi.restoreAllMocks();
  });

  describe('refreshFromRemote()', () => {
    it('should return false when no remote URL is configured', async () => {
      const registry = TokenRegistry.getInstance();
      const result = await registry.refreshFromRemote();
      expect(result).toBe(false);
    });

    it('should fetch and update definitions on success', async () => {
      const json = JSON.stringify(REMOTE_TEST_DATA);
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } })),
      );

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      const result = await registry.refreshFromRemote();
      expect(result).toBe(true);

      // New tokens should be available
      const newDef = registry.getDefinition(REMOTE_TEST_DATA[0].id);
      expect(newDef).toBeDefined();
      expect(newDef?.symbol).toBe('NEW');
      expect(newDef?.decimals).toBe(12);

      const antDef = registry.getDefinitionBySymbol('ANT');
      expect(antDef).toBeDefined();
      expect(antDef?.name).toBe('anothertoken');

      expect(registry.getAllDefinitions().length).toBe(2);
    });

    it('should preserve existing data on fetch failure (HTTP error)', async () => {
      // First populate with cache
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Set remoteUrl on existing instance
      TokenRegistry.configure({
        remoteUrl: 'https://example.com/registry.json',
        autoRefresh: false,
      });

      const result = await registry.refreshFromRemote();
      expect(result).toBe(false);

      // Cached data should still be there
      expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();
      expect(registry.getAllDefinitions().length).toBe(TEST_DEFINITIONS.length);
    });

    it('should preserve existing data on network error', async () => {
      await configureWithCache();
      const registry = TokenRegistry.getInstance();

      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      TokenRegistry.configure({
        remoteUrl: 'https://example.com/registry.json',
        autoRefresh: false,
      });

      const result = await registry.refreshFromRemote();
      expect(result).toBe(false);

      expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();
    });

    it('should reject invalid response data (not an array)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ tokens: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      const result = await registry.refreshFromRemote();
      expect(result).toBe(false);
    });

    it('should reject invalid response data (array of items without id)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify([{ name: 'bad' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      const result = await registry.refreshFromRemote();
      expect(result).toBe(false);
    });

    it('should update lastRefreshAt on success', async () => {
      const json = JSON.stringify(REMOTE_TEST_DATA);
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } })),
      );

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      expect(registry.getLastRefreshAt()).toBe(0);

      const before = Date.now();
      await registry.refreshFromRemote();
      const after = Date.now();

      expect(registry.getLastRefreshAt()).toBeGreaterThanOrEqual(before);
      expect(registry.getLastRefreshAt()).toBeLessThanOrEqual(after);
    });

    it('should handle empty array from remote (valid but no tokens)', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
      );

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      const result = await registry.refreshFromRemote();
      expect(result).toBe(true);
      expect(registry.getAllDefinitions()).toEqual([]);
    });

    it('should replace old data with new data on successful refresh', async () => {
      // First load cache
      await configureWithCache();
      const registry = TokenRegistry.getInstance();
      expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();
      expect(registry.getDefinitionBySymbol('NEW')).toBeUndefined();

      // Now fetch remote data that replaces cache
      const json = JSON.stringify(REMOTE_TEST_DATA);
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(json, { status: 200 })),
      );

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      await registry.refreshFromRemote();

      // Old cache data should be gone, new remote data should be present
      expect(registry.getDefinition(UCT_COIN_ID)).toBeUndefined();
      expect(registry.getDefinitionBySymbol('NEW')).toBeDefined();
      expect(registry.getAllDefinitions().length).toBe(REMOTE_TEST_DATA.length);
    });

    it('should deduplicate concurrent refresh calls', async () => {
      let resolvePromise: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(fetchPromise);

      TokenRegistry.configure({ remoteUrl: 'https://example.com/registry.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      const p1 = registry.refreshFromRemote();
      const p2 = registry.refreshFromRemote();

      resolvePromise!(
        new Response(JSON.stringify(REMOTE_TEST_DATA), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('configure()', () => {
    it('should set remote URL without starting auto-refresh when autoRefresh is false', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(JSON.stringify(REMOTE_TEST_DATA), { status: 200 })),
      );

      TokenRegistry.configure({
        remoteUrl: 'https://example.com/registry.json',
        autoRefresh: false,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should allow reconfiguring with new remoteUrl', async () => {
      const json1 = JSON.stringify(REMOTE_TEST_DATA);
      const json2 = JSON.stringify(TEST_DEFINITIONS);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => Promise.resolve(new Response(json1, { status: 200 })))
        .mockImplementationOnce(() => Promise.resolve(new Response(json2, { status: 200 })));

      TokenRegistry.configure({ remoteUrl: 'https://example.com/v1.json', autoRefresh: false });
      const registry = TokenRegistry.getInstance();

      await registry.refreshFromRemote();
      expect(registry.getDefinitionBySymbol('NEW')).toBeDefined();

      // Reconfigure with a different URL
      TokenRegistry.configure({ remoteUrl: 'https://example.com/v2.json', autoRefresh: false });
      await registry.refreshFromRemote();
      expect(registry.getDefinition(UCT_COIN_ID)).toBeDefined();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/v1.json');
      expect(fetchSpy.mock.calls[1][0]).toBe('https://example.com/v2.json');
    });

    it('should start auto-refresh by default when remoteUrl is provided', () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(JSON.stringify(REMOTE_TEST_DATA), { status: 200 })),
      );

      TokenRegistry.configure({
        remoteUrl: 'https://example.com/registry.json',
        refreshIntervalMs: 60000,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('startAutoRefresh() / stopAutoRefresh()', () => {
    it('should start and stop auto-refresh timer', async () => {
      vi.useFakeTimers();
      const json = JSON.stringify(REMOTE_TEST_DATA);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(json, { status: 200 })),
      );

      TokenRegistry.configure({
        remoteUrl: 'https://example.com/registry.json',
        refreshIntervalMs: 5000,
        autoRefresh: false,
      });
      const registry = TokenRegistry.getInstance();

      registry.startAutoRefresh(5000);

      // Immediate fetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance by one interval (async to flush microtasks)
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Advance by another interval
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Stop and advance — no more calls
      registry.stopAutoRefresh();
      await vi.advanceTimersByTimeAsync(15000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });
  });

  describe('destroy()', () => {
    it('should stop auto-refresh and reset singleton', () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(JSON.stringify(REMOTE_TEST_DATA), { status: 200 })),
      );

      TokenRegistry.configure({
        remoteUrl: 'https://example.com/registry.json',
        autoRefresh: false,
      });

      const instance1 = TokenRegistry.getInstance();
      TokenRegistry.destroy();
      const instance2 = TokenRegistry.getInstance();

      expect(instance1).not.toBe(instance2);
      // New instance should be empty (no cache, no bundled data)
      expect(instance2.getAllDefinitions()).toEqual([]);
    });
  });
});
