/**
 * Tests for registry/TokenRegistry.ts
 * Covers token metadata lookup functionality
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
// TokenRegistry Singleton Tests
// =============================================================================

describe('TokenRegistry', () => {
  beforeEach(() => {
    // Reset singleton before each test to ensure clean state
    TokenRegistry.resetInstance();
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
  // getDefinition Tests
  // ===========================================================================

  describe('getDefinition()', () => {
    it('should return token definition for known coin ID', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinition(UCT_COIN_ID);

      expect(def).toBeDefined();
      expect(def?.symbol).toBe('UCT');
      expect(def?.name).toBe('unicity');
      expect(def?.decimals).toBe(18);
    });

    it('should return undefined for unknown coin ID', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinition(UNKNOWN_COIN_ID);
      expect(def).toBeUndefined();
    });

    it('should be case-insensitive', () => {
      const registry = TokenRegistry.getInstance();
      const defLower = registry.getDefinition(UCT_COIN_ID.toLowerCase());
      const defUpper = registry.getDefinition(UCT_COIN_ID.toUpperCase());

      expect(defLower).toBeDefined();
      expect(defUpper).toBeDefined();
      // Verify both return the correct token
      expect(defLower?.symbol).toBe('UCT');
      expect(defUpper?.symbol).toBe('UCT');
      expect(defLower?.id).toBe(defUpper?.id);
    });

    it('should return undefined for empty string', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinition('');
      expect(def).toBeUndefined();
    });
  });

  // ===========================================================================
  // getDefinitionBySymbol Tests
  // ===========================================================================

  describe('getDefinitionBySymbol()', () => {
    it('should return token definition for known symbol', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionBySymbol('UCT');

      expect(def).toBeDefined();
      expect(def?.id).toBe(UCT_COIN_ID);
      expect(def?.decimals).toBe(18);
    });

    it('should be case-insensitive', () => {
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

    it('should return undefined for unknown symbol', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionBySymbol('UNKNOWN');
      expect(def).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionBySymbol('');
      expect(def).toBeUndefined();
    });
  });

  // ===========================================================================
  // getDefinitionByName Tests
  // ===========================================================================

  describe('getDefinitionByName()', () => {
    it('should return token definition for known name', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionByName('bitcoin');

      expect(def).toBeDefined();
      expect(def?.symbol).toBe('BTC');
      expect(def?.id).toBe(BTC_COIN_ID);
    });

    it('should be case-insensitive', () => {
      const registry = TokenRegistry.getInstance();
      const defLower = registry.getDefinitionByName('bitcoin');
      const defUpper = registry.getDefinitionByName('BITCOIN');
      const defMixed = registry.getDefinitionByName('Bitcoin');

      expect(defLower).toBeDefined();
      expect(defUpper).toBeDefined();
      expect(defMixed).toBeDefined();
      expect(defLower?.id).toBe(defUpper?.id);
    });

    it('should return undefined for unknown name', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionByName('unknowntoken');
      expect(def).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      const registry = TokenRegistry.getInstance();
      const def = registry.getDefinitionByName('');
      expect(def).toBeUndefined();
    });
  });

  // ===========================================================================
  // getSymbol Tests
  // ===========================================================================

  describe('getSymbol()', () => {
    it('should return symbol for known token', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getSymbol(UCT_COIN_ID)).toBe('UCT');
      expect(registry.getSymbol(USDU_COIN_ID)).toBe('USDU');
      expect(registry.getSymbol(BTC_COIN_ID)).toBe('BTC');
    });

    it('should return truncated ID for unknown token', () => {
      const registry = TokenRegistry.getInstance();
      const symbol = registry.getSymbol(UNKNOWN_COIN_ID);
      expect(symbol).toBe('000000'); // First 6 chars uppercased
    });

    it('should return truncated ID for non-fungible token without symbol', () => {
      const registry = TokenRegistry.getInstance();
      const symbol = registry.getSymbol(UNICITY_NFT_COIN_ID);
      // NFT doesn't have symbol, so should return first 6 chars
      expect(symbol).toBe('F8AA13');
    });
  });

  // ===========================================================================
  // getName Tests
  // ===========================================================================

  describe('getName()', () => {
    it('should return capitalized name for known token', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getName(UCT_COIN_ID)).toBe('Unicity');
      expect(registry.getName(BTC_COIN_ID)).toBe('Bitcoin');
      expect(registry.getName(SOL_COIN_ID)).toBe('Solana');
    });

    it('should return coin ID for unknown token', () => {
      const registry = TokenRegistry.getInstance();
      const name = registry.getName(UNKNOWN_COIN_ID);
      expect(name).toBe(UNKNOWN_COIN_ID);
    });
  });

  // ===========================================================================
  // getDecimals Tests
  // ===========================================================================

  describe('getDecimals()', () => {
    it('should return correct decimals for different tokens', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getDecimals(UCT_COIN_ID)).toBe(18); // UCT has 18 decimals
      expect(registry.getDecimals(USDU_COIN_ID)).toBe(6); // USDU has 6 decimals
      expect(registry.getDecimals(BTC_COIN_ID)).toBe(8); // BTC has 8 decimals
      expect(registry.getDecimals(SOL_COIN_ID)).toBe(9); // SOL has 9 decimals
    });

    it('should return 0 for unknown token', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getDecimals(UNKNOWN_COIN_ID)).toBe(0);
    });

    it('should return 0 for non-fungible token', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getDecimals(UNICITY_NFT_COIN_ID)).toBe(0);
    });
  });

  // ===========================================================================
  // getIconUrl Tests
  // ===========================================================================

  describe('getIconUrl()', () => {
    it('should return icon URL for known token', () => {
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(UCT_COIN_ID);
      expect(iconUrl).toBeDefined();
      expect(iconUrl).toContain('unicity_logo');
    });

    it('should prefer PNG when preferPng is true', () => {
      const registry = TokenRegistry.getInstance();
      // BTC has both SVG and PNG icons
      const iconUrl = registry.getIconUrl(BTC_COIN_ID, true);
      expect(iconUrl).toBeDefined();
      expect(iconUrl?.toLowerCase()).toContain('.png');
    });

    it('should return SVG when preferPng is false and SVG exists', () => {
      const registry = TokenRegistry.getInstance();
      // BTC has SVG as first icon
      const iconUrl = registry.getIconUrl(BTC_COIN_ID, false);
      expect(iconUrl).toBeDefined();
      expect(iconUrl?.toLowerCase()).toContain('.svg');
    });

    it('should return null for unknown token', () => {
      const registry = TokenRegistry.getInstance();
      const iconUrl = registry.getIconUrl(UNKNOWN_COIN_ID);
      expect(iconUrl).toBeNull();
    });

    it('should return null for token without icons', () => {
      const registry = TokenRegistry.getInstance();
      // NFT token has no icons
      const iconUrl = registry.getIconUrl(UNICITY_NFT_COIN_ID);
      expect(iconUrl).toBeNull();
    });
  });

  // ===========================================================================
  // isKnown Tests
  // ===========================================================================

  describe('isKnown()', () => {
    it('should return true for known token', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UCT_COIN_ID)).toBe(true);
      expect(registry.isKnown(BTC_COIN_ID)).toBe(true);
    });

    it('should return false for unknown token', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UNKNOWN_COIN_ID)).toBe(false);
    });

    it('should be case-insensitive', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.isKnown(UCT_COIN_ID.toUpperCase())).toBe(true);
      expect(registry.isKnown(UCT_COIN_ID.toLowerCase())).toBe(true);
    });
  });

  // ===========================================================================
  // getAllDefinitions Tests
  // ===========================================================================

  describe('getAllDefinitions()', () => {
    it('should return all token definitions', () => {
      const registry = TokenRegistry.getInstance();
      const all = registry.getAllDefinitions();

      expect(all).toBeInstanceOf(Array);
      // Registry has 10 tokens (9 fungible + 1 NFT)
      expect(all.length).toBe(10);
    });

    it('should include both fungible and non-fungible tokens', () => {
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
    it('should return only fungible tokens', () => {
      const registry = TokenRegistry.getInstance();
      const fungibles = registry.getFungibleTokens();

      // Registry has 9 fungible tokens
      expect(fungibles.length).toBe(9);
      expect(fungibles.every((def) => def.assetKind === 'fungible')).toBe(true);
    });

    it('should include UCT and BTC', () => {
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
    it('should return only non-fungible tokens', () => {
      const registry = TokenRegistry.getInstance();
      const nfts = registry.getNonFungibleTokens();

      // Registry has 1 NFT
      expect(nfts.length).toBe(1);
      expect(nfts.every((def) => def.assetKind === 'non-fungible')).toBe(true);
    });

    it('should include unicity NFT token', () => {
      const registry = TokenRegistry.getInstance();
      const nfts = registry.getNonFungibleTokens();

      expect(nfts[0]?.id.toLowerCase()).toBe(UNICITY_NFT_COIN_ID.toLowerCase());
      expect(nfts[0]?.name).toBe('unicity');
    });
  });

  // ===========================================================================
  // getCoinIdBySymbol Tests
  // ===========================================================================

  describe('getCoinIdBySymbol()', () => {
    it('should return coin ID for known symbol', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdBySymbol('UCT')).toBe(UCT_COIN_ID);
      expect(registry.getCoinIdBySymbol('BTC')).toBe(BTC_COIN_ID);
    });

    it('should be case-insensitive', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdBySymbol('uct')).toBe(UCT_COIN_ID);
      expect(registry.getCoinIdBySymbol('Btc')).toBe(BTC_COIN_ID);
    });

    it('should return undefined for unknown symbol', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdBySymbol('UNKNOWN')).toBeUndefined();
    });
  });

  // ===========================================================================
  // getCoinIdByName Tests
  // ===========================================================================

  describe('getCoinIdByName()', () => {
    it('should return coin ID for known name', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdByName('bitcoin')).toBe(BTC_COIN_ID);
      expect(registry.getCoinIdByName('solana')).toBe(SOL_COIN_ID);
    });

    it('should be case-insensitive', () => {
      const registry = TokenRegistry.getInstance();
      expect(registry.getCoinIdByName('Bitcoin')).toBe(BTC_COIN_ID);
      expect(registry.getCoinIdByName('SOLANA')).toBe(SOL_COIN_ID);
    });

    it('should return undefined for unknown name', () => {
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
  });

  describe('getTokenDefinition()', () => {
    it('should return token definition', () => {
      const def = getTokenDefinition(UCT_COIN_ID);
      expect(def).toBeDefined();
      expect(def?.symbol).toBe('UCT');
    });

    it('should return undefined for unknown token', () => {
      const def = getTokenDefinition(UNKNOWN_COIN_ID);
      expect(def).toBeUndefined();
    });
  });

  describe('getTokenSymbol()', () => {
    it('should return symbol for known token', () => {
      expect(getTokenSymbol(UCT_COIN_ID)).toBe('UCT');
      expect(getTokenSymbol(BTC_COIN_ID)).toBe('BTC');
    });

    it('should return truncated ID for unknown token', () => {
      expect(getTokenSymbol(UNKNOWN_COIN_ID)).toBe('000000');
    });
  });

  describe('getTokenName()', () => {
    it('should return capitalized name', () => {
      expect(getTokenName(UCT_COIN_ID)).toBe('Unicity');
      expect(getTokenName(BTC_COIN_ID)).toBe('Bitcoin');
    });

    it('should return coin ID for unknown token', () => {
      expect(getTokenName(UNKNOWN_COIN_ID)).toBe(UNKNOWN_COIN_ID);
    });
  });

  describe('getTokenDecimals()', () => {
    it('should return decimals for known token', () => {
      expect(getTokenDecimals(UCT_COIN_ID)).toBe(18);
      expect(getTokenDecimals(USDU_COIN_ID)).toBe(6);
    });

    it('should return 0 for unknown token', () => {
      expect(getTokenDecimals(UNKNOWN_COIN_ID)).toBe(0);
    });
  });

  describe('getTokenIconUrl()', () => {
    it('should return icon URL for known token', () => {
      const iconUrl = getTokenIconUrl(UCT_COIN_ID);
      expect(iconUrl).toBeDefined();
      expect(iconUrl).toContain('unicity_logo');
    });

    it('should return null for unknown token', () => {
      expect(getTokenIconUrl(UNKNOWN_COIN_ID)).toBeNull();
    });

    it('should prefer PNG by default', () => {
      const iconUrl = getTokenIconUrl(BTC_COIN_ID);
      expect(iconUrl?.toLowerCase()).toContain('.png');
    });

    it('should return SVG when preferPng is false', () => {
      const iconUrl = getTokenIconUrl(BTC_COIN_ID, false);
      expect(iconUrl?.toLowerCase()).toContain('.svg');
    });
  });

  describe('isKnownToken()', () => {
    it('should return true for known token', () => {
      expect(isKnownToken(UCT_COIN_ID)).toBe(true);
    });

    it('should return false for unknown token', () => {
      expect(isKnownToken(UNKNOWN_COIN_ID)).toBe(false);
    });
  });

  describe('getCoinIdBySymbol()', () => {
    it('should return coin ID for known symbol', () => {
      expect(getCoinIdBySymbol('UCT')).toBe(UCT_COIN_ID);
      expect(getCoinIdBySymbol('BTC')).toBe(BTC_COIN_ID);
    });

    it('should return undefined for unknown symbol', () => {
      expect(getCoinIdBySymbol('UNKNOWN')).toBeUndefined();
    });
  });

  describe('getCoinIdByName()', () => {
    it('should return coin ID for known name', () => {
      expect(getCoinIdByName('bitcoin')).toBe(BTC_COIN_ID);
    });

    it('should return undefined for unknown name', () => {
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
  });

  it('should have required fields for fungible tokens', () => {
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

  it('should have required fields for non-fungible tokens', () => {
    const def = getTokenDefinition(UNICITY_NFT_COIN_ID);

    expect(def).toBeDefined();
    expect(def?.network).toBeDefined();
    expect(def?.assetKind).toBe('non-fungible');
    expect(def?.name).toBeDefined();
    expect(def?.description).toBeDefined();
    expect(def?.id).toBeDefined();
    // Symbol and decimals are optional for NFTs
    expect(def?.symbol).toBeUndefined();
    expect(def?.decimals).toBeUndefined();
  });

  it('should have valid coin IDs (64 hex characters)', () => {
    const registry = TokenRegistry.getInstance();
    const all = registry.getAllDefinitions();

    for (const def of all) {
      expect(def.id).toMatch(/^[0-9a-f]{64}$/i);
    }
  });

  it('should have valid network identifier', () => {
    const registry = TokenRegistry.getInstance();
    const all = registry.getAllDefinitions();

    for (const def of all) {
      expect(def.network).toMatch(/^unicity:/);
    }
  });
});
