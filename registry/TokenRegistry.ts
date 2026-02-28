/**
 * Token Registry
 *
 * Provides token definitions (metadata) for known tokens on the Unicity network.
 * Fetches from a remote URL, caches in StorageProvider, and refreshes periodically.
 */

import { logger } from '../core/logger';
import { TOKEN_REGISTRY_REFRESH_INTERVAL, STORAGE_KEYS_GLOBAL } from '../constants';
import type { StorageProvider } from '../storage';

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

/**
 * Configuration options for remote registry refresh
 */
export interface TokenRegistryConfig {
  /** Remote URL to fetch token definitions from */
  remoteUrl?: string;
  /** StorageProvider for persistent caching */
  storage?: StorageProvider;
  /** Refresh interval in ms (default: 1 hour) */
  refreshIntervalMs?: number;
  /** Start auto-refresh immediately (default: true) */
  autoRefresh?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const FETCH_TIMEOUT_MS = 10_000;

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Token Registry service
 *
 * Provides lookup functionality for token definitions by coin ID.
 * Uses singleton pattern for efficient memory usage.
 *
 * Data flow:
 * 1. On `configure()`: load cached definitions from StorageProvider (if fresh)
 * 2. Fetch from remote URL in background
 * 3. On successful fetch: update in-memory maps + persist to StorageProvider
 * 4. Repeat every `refreshIntervalMs` (default 1 hour)
 *
 * If no cache and no network — registry is empty (lookup methods return fallbacks).
 *
 * @example
 * ```ts
 * import { TokenRegistry } from '@unicitylabs/sphere-sdk';
 *
 * // Usually called automatically by createBrowserProviders / createNodeProviders
 * TokenRegistry.configure({
 *   remoteUrl: 'https://raw.githubusercontent.com/.../unicity-ids.testnet.json',
 *   storage: myStorageProvider,
 * });
 *
 * const registry = TokenRegistry.getInstance();
 * const def = registry.getDefinition('455ad87...');
 * console.log(def?.symbol); // 'UCT'
 * ```
 */
export class TokenRegistry {
  private static instance: TokenRegistry | null = null;

  private readonly definitionsById: Map<string, TokenDefinition>;
  private readonly definitionsBySymbol: Map<string, TokenDefinition>;
  private readonly definitionsByName: Map<string, TokenDefinition>;

  // Remote refresh state
  private remoteUrl: string | null = null;
  private storage: StorageProvider | null = null;
  private refreshIntervalMs: number = TOKEN_REGISTRY_REFRESH_INTERVAL;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt: number = 0;
  private refreshPromise: Promise<boolean> | null = null;
  private initialLoadPromise: Promise<boolean> | null = null;

  private constructor() {
    this.definitionsById = new Map();
    this.definitionsBySymbol = new Map();
    this.definitionsByName = new Map();
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
   * Configure remote registry refresh with persistent caching.
   *
   * On first call:
   * 1. Loads cached data from StorageProvider (if available and fresh)
   * 2. Starts periodic remote fetch (if autoRefresh is true, which is default)
   *
   * @param options - Configuration options
   * @param options.remoteUrl - Remote URL to fetch definitions from
   * @param options.storage - StorageProvider for persistent caching
   * @param options.refreshIntervalMs - Refresh interval in ms (default: 1 hour)
   * @param options.autoRefresh - Start auto-refresh immediately (default: true)
   */
  static configure(options: TokenRegistryConfig): void {
    const instance = TokenRegistry.getInstance();

    if (options.remoteUrl !== undefined) {
      instance.remoteUrl = options.remoteUrl;
    }
    if (options.storage !== undefined) {
      instance.storage = options.storage;
    }
    if (options.refreshIntervalMs !== undefined) {
      instance.refreshIntervalMs = options.refreshIntervalMs;
    }

    const autoRefresh = options.autoRefresh ?? true;

    // Perform initial load (cache → remote fallback) and store the promise
    // so consumers can await readiness via TokenRegistry.waitForReady()
    instance.initialLoadPromise = instance.performInitialLoad(autoRefresh);
  }

  /**
   * Reset the singleton instance (useful for testing).
   * Stops auto-refresh if running.
   */
  static resetInstance(): void {
    if (TokenRegistry.instance) {
      TokenRegistry.instance.stopAutoRefresh();
    }
    TokenRegistry.instance = null;
  }

  /**
   * Destroy the singleton: stop auto-refresh and reset.
   */
  static destroy(): void {
    TokenRegistry.resetInstance();
  }

  /**
   * Wait for the initial data load (cache or remote) to complete.
   * Returns true if data was loaded, false if not (timeout or no data source).
   *
   * @param timeoutMs - Maximum wait time in ms (default: 10s). Set to 0 for no timeout.
   */
  static async waitForReady(timeoutMs: number = 10_000): Promise<boolean> {
    const instance = TokenRegistry.getInstance();
    if (!instance.initialLoadPromise) {
      return instance.definitionsById.size > 0;
    }
    if (timeoutMs <= 0) {
      return instance.initialLoadPromise;
    }
    return Promise.race([
      instance.initialLoadPromise,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  // ===========================================================================
  // Initial Load
  // ===========================================================================

  /**
   * Perform initial data load: try cache first, fall back to remote fetch.
   * After initial data is available, start periodic auto-refresh if configured.
   */
  private async performInitialLoad(autoRefresh: boolean): Promise<boolean> {
    // Step 1: Try loading from cache
    let loaded = false;
    if (this.storage) {
      loaded = await this.loadFromCache();
    }

    if (loaded) {
      // Cache hit — start auto-refresh in background (includes immediate remote fetch)
      if (autoRefresh && this.remoteUrl) {
        this.startAutoRefresh();
      }
      return true;
    }

    // Step 2: Cache miss — wait for first remote fetch (only when auto-refresh is enabled)
    if (autoRefresh && this.remoteUrl) {
      loaded = await this.refreshFromRemote();
      // Start periodic refresh (skip immediate since we just fetched)
      this.stopAutoRefresh();
      this.refreshTimer = setInterval(() => {
        this.refreshFromRemote();
      }, this.refreshIntervalMs);
      return loaded;
    }

    return false;
  }

  // ===========================================================================
  // Cache (StorageProvider)
  // ===========================================================================

  /**
   * Load definitions from StorageProvider cache.
   * Only applies if cache exists and is fresh (within refreshIntervalMs).
   */
  private async loadFromCache(): Promise<boolean> {
    if (!this.storage) return false;

    try {
      const [cached, cachedTs] = await Promise.all([
        this.storage.get(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE),
        this.storage.get(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS),
      ]);

      if (!cached || !cachedTs) return false;

      const ts = parseInt(cachedTs, 10);
      if (isNaN(ts)) return false;

      // Check freshness
      const age = Date.now() - ts;
      if (age > this.refreshIntervalMs) return false;

      // Don't overwrite data from a more recent remote fetch
      if (this.lastRefreshAt > ts) return false;

      const data: unknown = JSON.parse(cached);
      if (!this.isValidDefinitionsArray(data)) return false;

      this.applyDefinitions(data as TokenDefinition[]);
      this.lastRefreshAt = ts;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save definitions to StorageProvider cache.
   */
  private async saveToCache(definitions: TokenDefinition[]): Promise<void> {
    if (!this.storage) return;

    try {
      await Promise.all([
        this.storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE, JSON.stringify(definitions)),
        this.storage.set(STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS, String(Date.now())),
      ]);
    } catch {
      // Cache save failure is non-critical
    }
  }

  // ===========================================================================
  // Remote Refresh
  // ===========================================================================

  /**
   * Apply an array of token definitions to the internal maps.
   * Clears existing data before applying.
   */
  private applyDefinitions(definitions: TokenDefinition[]): void {
    this.definitionsById.clear();
    this.definitionsBySymbol.clear();
    this.definitionsByName.clear();

    for (const def of definitions) {
      const idLower = def.id.toLowerCase();
      this.definitionsById.set(idLower, def);

      if (def.symbol) {
        this.definitionsBySymbol.set(def.symbol.toUpperCase(), def);
      }

      this.definitionsByName.set(def.name.toLowerCase(), def);
    }
  }

  /**
   * Validate that data is an array of objects with 'id' field
   */
  private isValidDefinitionsArray(data: unknown): boolean {
    return Array.isArray(data) && data.every((item) => item && typeof item === 'object' && 'id' in item);
  }

  /**
   * Fetch token definitions from the remote URL and update the registry.
   * On success, also persists to StorageProvider cache.
   * Returns true on success, false on failure. On failure, existing data is preserved.
   * Concurrent calls are deduplicated — only one fetch runs at a time.
   */
  async refreshFromRemote(): Promise<boolean> {
    if (!this.remoteUrl) {
      return false;
    }

    // Deduplicate concurrent calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(this.remoteUrl!, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        logger.warn('TokenRegistry', `Remote fetch failed: HTTP ${response.status} ${response.statusText}`);
        return false;
      }

      const data: unknown = await response.json();

      if (!this.isValidDefinitionsArray(data)) {
        logger.warn('TokenRegistry', 'Remote data is not a valid token definitions array');
        return false;
      }

      const definitions = data as TokenDefinition[];
      this.applyDefinitions(definitions);
      this.lastRefreshAt = Date.now();

      // Persist to cache (fire-and-forget)
      this.saveToCache(definitions);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('TokenRegistry', `Remote refresh failed: ${message}`);
      return false;
    }
  }

  /**
   * Start periodic auto-refresh from the remote URL.
   * Does an immediate fetch, then repeats at the configured interval.
   */
  startAutoRefresh(intervalMs?: number): void {
    this.stopAutoRefresh();

    if (intervalMs !== undefined) {
      this.refreshIntervalMs = intervalMs;
    }

    // Immediate first fetch (fire-and-forget)
    this.refreshFromRemote();

    this.refreshTimer = setInterval(() => {
      this.refreshFromRemote();
    }, this.refreshIntervalMs);
  }

  /**
   * Stop periodic auto-refresh
   */
  stopAutoRefresh(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Timestamp of the last successful remote refresh (0 if never refreshed)
   */
  getLastRefreshAt(): number {
    return this.lastRefreshAt;
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
