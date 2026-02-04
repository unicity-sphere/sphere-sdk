/**
 * Token Registry
 *
 * Provides token definitions (metadata) for known tokens on the Unicity network.
 * Uses bundled static data for offline access and consistency.
 */

import testnetRegistry from './token-registry.testnet.json';

// =============================================================================
// Types
// =============================================================================

/**
 * Icon entry for token
 */
export interface TokenIcon {
  url: string;
}

/**
 * Token definition with full metadata
 */
export interface TokenDefinition {
  /** Network identifier (e.g., "unicity:testnet") */
  network: string;
  /** Asset kind - fungible or non-fungible */
  assetKind: 'fungible' | 'non-fungible';
  /** Token name (e.g., "bitcoin", "ethereum") */
  name: string;
  /** Token symbol (e.g., "BTC", "ETH") - only for fungible tokens */
  symbol?: string;
  /** Decimal places for display - only for fungible tokens */
  decimals?: number;
  /** Human-readable description */
  description: string;
  /** Icon URLs array */
  icons?: TokenIcon[];
  /** Hex-encoded coin ID (64 characters) */
  id: string;
}

/**
 * Network type for registry lookup
 */
export type RegistryNetwork = 'testnet' | 'mainnet' | 'dev';

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Token Registry service
 *
 * Provides lookup functionality for token definitions by coin ID.
 * Uses singleton pattern for efficient memory usage.
 *
 * @example
 * ```ts
 * import { TokenRegistry } from '@unicitylabs/sphere-sdk';
 *
 * const registry = TokenRegistry.getInstance();
 * const def = registry.getDefinition('455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89');
 * console.log(def?.symbol); // 'UCT'
 * ```
 */
export class TokenRegistry {
  private static instance: TokenRegistry | null = null;

  private readonly definitionsById: Map<string, TokenDefinition>;
  private readonly definitionsBySymbol: Map<string, TokenDefinition>;
  private readonly definitionsByName: Map<string, TokenDefinition>;

  private constructor() {
    this.definitionsById = new Map();
    this.definitionsBySymbol = new Map();
    this.definitionsByName = new Map();
    this.loadRegistry();
  }

  /**
   * Get singleton instance of TokenRegistry
   */
  static getInstance(): TokenRegistry {
    if (!TokenRegistry.instance) {
      TokenRegistry.instance = new TokenRegistry();
    }
    return TokenRegistry.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    TokenRegistry.instance = null;
  }

  /**
   * Load registry data from bundled JSON
   */
  private loadRegistry(): void {
    const definitions = testnetRegistry as TokenDefinition[];

    for (const def of definitions) {
      const idLower = def.id.toLowerCase();
      this.definitionsById.set(idLower, def);

      if (def.symbol) {
        this.definitionsBySymbol.set(def.symbol.toUpperCase(), def);
      }

      this.definitionsByName.set(def.name.toLowerCase(), def);
    }
  }

  // ===========================================================================
  // Lookup Methods
  // ===========================================================================

  /**
   * Get token definition by hex coin ID
   * @param coinId - 64-character hex string
   * @returns Token definition or undefined if not found
   */
  getDefinition(coinId: string): TokenDefinition | undefined {
    if (!coinId) return undefined;
    return this.definitionsById.get(coinId.toLowerCase());
  }

  /**
   * Get token definition by symbol (e.g., "UCT", "BTC")
   * @param symbol - Token symbol (case-insensitive)
   * @returns Token definition or undefined if not found
   */
  getDefinitionBySymbol(symbol: string): TokenDefinition | undefined {
    if (!symbol) return undefined;
    return this.definitionsBySymbol.get(symbol.toUpperCase());
  }

  /**
   * Get token definition by name (e.g., "bitcoin", "ethereum")
   * @param name - Token name (case-insensitive)
   * @returns Token definition or undefined if not found
   */
  getDefinitionByName(name: string): TokenDefinition | undefined {
    if (!name) return undefined;
    return this.definitionsByName.get(name.toLowerCase());
  }

  /**
   * Get token symbol for a coin ID
   * @param coinId - 64-character hex string
   * @returns Symbol (e.g., "UCT") or truncated ID if not found
   */
  getSymbol(coinId: string): string {
    const def = this.getDefinition(coinId);
    if (def?.symbol) {
      return def.symbol;
    }
    // Fallback: return first 6 chars of ID uppercased
    return coinId.slice(0, 6).toUpperCase();
  }

  /**
   * Get token name for a coin ID
   * @param coinId - 64-character hex string
   * @returns Name (e.g., "Bitcoin") or coin ID if not found
   */
  getName(coinId: string): string {
    const def = this.getDefinition(coinId);
    if (def?.name) {
      // Capitalize first letter
      return def.name.charAt(0).toUpperCase() + def.name.slice(1);
    }
    return coinId;
  }

  /**
   * Get decimal places for a coin ID
   * @param coinId - 64-character hex string
   * @returns Decimals or 0 if not found
   */
  getDecimals(coinId: string): number {
    const def = this.getDefinition(coinId);
    return def?.decimals ?? 0;
  }

  /**
   * Get icon URL for a coin ID
   * @param coinId - 64-character hex string
   * @param preferPng - Prefer PNG format over SVG
   * @returns Icon URL or null if not found
   */
  getIconUrl(coinId: string, preferPng = true): string | null {
    const def = this.getDefinition(coinId);
    if (!def?.icons || def.icons.length === 0) {
      return null;
    }

    if (preferPng) {
      const pngIcon = def.icons.find((i) => i.url.toLowerCase().includes('.png'));
      if (pngIcon) return pngIcon.url;
    }

    return def.icons[0].url;
  }

  /**
   * Check if a coin ID is known in the registry
   * @param coinId - 64-character hex string
   * @returns true if the coin is in the registry
   */
  isKnown(coinId: string): boolean {
    return this.definitionsById.has(coinId.toLowerCase());
  }

  /**
   * Get all token definitions
   * @returns Array of all token definitions
   */
  getAllDefinitions(): TokenDefinition[] {
    return Array.from(this.definitionsById.values());
  }

  /**
   * Get all fungible token definitions
   * @returns Array of fungible token definitions
   */
  getFungibleTokens(): TokenDefinition[] {
    return this.getAllDefinitions().filter((def) => def.assetKind === 'fungible');
  }

  /**
   * Get all non-fungible token definitions
   * @returns Array of non-fungible token definitions
   */
  getNonFungibleTokens(): TokenDefinition[] {
    return this.getAllDefinitions().filter((def) => def.assetKind === 'non-fungible');
  }

  /**
   * Get coin ID by symbol
   * @param symbol - Token symbol (e.g., "UCT")
   * @returns Coin ID hex string or undefined if not found
   */
  getCoinIdBySymbol(symbol: string): string | undefined {
    const def = this.getDefinitionBySymbol(symbol);
    return def?.id;
  }

  /**
   * Get coin ID by name
   * @param name - Token name (e.g., "bitcoin")
   * @returns Coin ID hex string or undefined if not found
   */
  getCoinIdByName(name: string): string | undefined {
    const def = this.getDefinitionByName(name);
    return def?.id;
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Get token definition by coin ID
 * @param coinId - 64-character hex string
 * @returns Token definition or undefined
 */
export function getTokenDefinition(coinId: string): TokenDefinition | undefined {
  return TokenRegistry.getInstance().getDefinition(coinId);
}

/**
 * Get token symbol by coin ID
 * @param coinId - 64-character hex string
 * @returns Symbol or truncated ID
 */
export function getTokenSymbol(coinId: string): string {
  return TokenRegistry.getInstance().getSymbol(coinId);
}

/**
 * Get token name by coin ID
 * @param coinId - 64-character hex string
 * @returns Name or coin ID
 */
export function getTokenName(coinId: string): string {
  return TokenRegistry.getInstance().getName(coinId);
}

/**
 * Get token decimals by coin ID
 * @param coinId - 64-character hex string
 * @returns Decimals or 0
 */
export function getTokenDecimals(coinId: string): number {
  return TokenRegistry.getInstance().getDecimals(coinId);
}

/**
 * Get token icon URL by coin ID
 * @param coinId - 64-character hex string
 * @param preferPng - Prefer PNG over SVG
 * @returns Icon URL or null
 */
export function getTokenIconUrl(coinId: string, preferPng = true): string | null {
  return TokenRegistry.getInstance().getIconUrl(coinId, preferPng);
}

/**
 * Check if coin ID is in registry
 * @param coinId - 64-character hex string
 * @returns true if known
 */
export function isKnownToken(coinId: string): boolean {
  return TokenRegistry.getInstance().isKnown(coinId);
}

/**
 * Get coin ID by symbol
 * @param symbol - Token symbol (e.g., "UCT")
 * @returns Coin ID or undefined
 */
export function getCoinIdBySymbol(symbol: string): string | undefined {
  return TokenRegistry.getInstance().getCoinIdBySymbol(symbol);
}

/**
 * Get coin ID by name
 * @param name - Token name (e.g., "bitcoin")
 * @returns Coin ID or undefined
 */
export function getCoinIdByName(name: string): string | undefined {
  return TokenRegistry.getInstance().getCoinIdByName(name);
}
