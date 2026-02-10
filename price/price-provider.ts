/**
 * Price Provider Interface
 *
 * Platform-independent abstraction for fetching token market prices.
 * Does not extend BaseProvider — stateless HTTP client with internal caching.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Supported price provider platforms
 */
export type PricePlatform = 'coingecko';

/**
 * Price data for a single token
 */
export interface TokenPrice {
  /** Token name used by the price platform (e.g., "bitcoin") */
  readonly tokenName: string;
  /** Price in USD */
  readonly priceUsd: number;
  /** Price in EUR (if available) */
  readonly priceEur?: number;
  /** 24h price change percentage (if available) */
  readonly change24h?: number;
  /** Timestamp when this price was fetched */
  readonly timestamp: number;
}

/**
 * Price provider configuration
 */
export interface PriceProviderConfig {
  /** Which price platform to use */
  platform: PricePlatform;
  /** API key for the platform (optional for free tiers) */
  apiKey?: string;
  /** Custom base URL (e.g., for CORS proxy in browser environments) */
  baseUrl?: string;
  /** Cache TTL in milliseconds (default: 60000 = 1 minute) */
  cacheTtlMs?: number;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

// =============================================================================
// PriceProvider Interface
// =============================================================================

/**
 * Price data provider
 *
 * Fetches current market prices for tokens. Implementations handle
 * caching internally to avoid excessive API calls.
 *
 * @example
 * ```ts
 * const provider = new CoinGeckoPriceProvider({ apiKey: 'CG-xxx' });
 * const prices = await provider.getPrices(['bitcoin', 'ethereum']);
 * console.log(prices.get('bitcoin')?.priceUsd); // 97500
 * ```
 */
export interface PriceProvider {
  /** Platform identifier (e.g., 'coingecko') */
  readonly platform: PricePlatform;

  /**
   * Get prices for multiple tokens by their platform-compatible names
   * @param tokenNames - Array of token names (e.g., ['bitcoin', 'ethereum'])
   * @returns Map of token name to price data
   */
  getPrices(tokenNames: string[]): Promise<Map<string, TokenPrice>>;

  /**
   * Get price for a single token
   * @param tokenName - Token name (e.g., 'bitcoin')
   * @returns Token price or null if not available
   */
  getPrice(tokenName: string): Promise<TokenPrice | null>;

  /**
   * Clear cached prices
   */
  clearCache(): void;
}
