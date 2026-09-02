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
export type RegistryNetwork = 'testnet' | 'testnet2' | 'mainnet';

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
 *   remoteUrl: 'https://raw.githubusercontent.com/.../unicity-ids.testnet2.json',
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
  /** Bumped on every remoteUrl change; loads started in an older generation are discarded. */
  private generation = 0;
  /** Set by dispose(). A disposed registry starts no work and applies no late result. */
  private disposed = false;

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
    TokenRegistry.getInstance().applyConfig(options);
  }

  /**
   * Create an INDEPENDENT registry, not the process-global singleton.
   *
   * One Sphere owns one of these, so two Spheres on different networks cannot wipe each
   * other's definitions — the singleton's `configure()` reaches into whatever instance
   * exists and repoints it, which is how a mainnet init silently retargeted a live
   * testnet2 wallet's decimals. Dispose it when the owner is destroyed.
   */
  static create(options: TokenRegistryConfig): TokenRegistry {
    const registry = new TokenRegistry();
    registry.applyConfig(options);
    return registry;
  }

  /** The body of configure(), on the instance, so owned registries share it exactly. */
  private applyConfig(options: TokenRegistryConfig): void {
    if (this.disposed) return;

    if (options.remoteUrl !== undefined) {
      // A network switch must not leave the old network's definitions resolvable:
      // applyDefinitions() is the only clear site and runs on a SUCCESSFUL fetch, so a
      // failed load would keep serving foreign coinIds — wrong decimals, silently.
      // lastRefreshAt resets too, else loadFromCache refuses the new network's snapshot
      // as older than the stale timestamp.
      const previous = this.remoteUrl;
      if (previous && previous !== options.remoteUrl) {
        this.applyDefinitions([]);
        this.lastRefreshAt = 0;
        // Abandon any in-flight load: it fetched the OLD url, so its result must neither
        // be applied nor cached, and the next caller must not dedupe onto it.
        this.generation++;
        this.refreshPromise = null;
      }
      this.remoteUrl = options.remoteUrl;
    }
    if (options.storage !== undefined) {
      this.storage = options.storage;
    }
    if (options.refreshIntervalMs !== undefined) {
      this.refreshIntervalMs = options.refreshIntervalMs;
    }

    const autoRefresh = options.autoRefresh ?? true;

    // Perform initial load (cache → remote fallback) and store the promise
    // so consumers can await readiness via TokenRegistry.waitForReady()
    this.initialLoadPromise = this.performInitialLoad(autoRefresh);
  }

  /**
   * Stop this registry for good: no timer, no late apply, no late cache write.
   *
   * Sphere.destroy() calls this on the registry it owns. Without it a discarded Sphere
   * leaves an hourly fetch running forever — nothing in this file calls unref(), so in
   * Node it also keeps the event loop alive.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAutoRefresh();
    // Any in-flight load belongs to a generation that no longer exists.
    this.generation++;
    this.refreshPromise = null;
    this.initialLoadPromise = null;
  }

  /** Whether dispose() has been called. Reads still work; they are simply frozen. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Per-instance readiness — the same contract as the static, for an owned registry. */
  async waitForReady(timeoutMs: number = 10_000): Promise<boolean> {
    if (!this.initialLoadPromise) {
      return this.definitionsById.size > 0;
    }
    if (timeoutMs <= 0) {
      return this.initialLoadPromise;
    }
    // Clear the losing timer: a race leaves it scheduled, and an unreferenced timeout
    // still holds Node's event loop open for its full duration — here up to 10s after
    // the registry has been disposed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.initialLoadPromise,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
    return TokenRegistry.getInstance().waitForReady(timeoutMs);
  }

  // ===========================================================================
  // Initial Load
  // ===========================================================================

  /**
   * Perform initial data load: try cache first, fall back to remote fetch.
   * After initial data is available, start periodic auto-refresh if configured.
   */
  private async performInitialLoad(autoRefresh: boolean): Promise<boolean> {
    if (this.disposed) return false;
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
      // Re-check: dispose() may have run during the await, and the entry guard above no
      // longer holds. Arming here would outlive the owner that asked to be torn down.
      if (this.disposed) return loaded;
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
   * Per-network cache keys. The registry cache MUST be namespaced by remoteUrl:
   * testnet and testnet2 ship DIFFERENT coinIds for the same symbol, so a single
   * global key let a stale testnet snapshot be served for a testnet2 request —
   * wrong/missing icons AND self-mint resolving the wrong-network coinId. Keying
   * by remoteUrl isolates the snapshots so a network can never read another's.
   */
  private cacheKeys(): { data: string; ts: string } {
    const base = STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE;
    const baseTs = STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS;
    // No remoteUrl configured (local-only usage): keep the legacy bare key.
    if (!this.remoteUrl) return { data: base, ts: baseTs };
    // Namespace by remoteUrl so testnet and testnet2 snapshots never collide.
    return { data: `${base}:${this.remoteUrl}`, ts: `${baseTs}:${this.remoteUrl}` };
  }

  /**
   * Load definitions from StorageProvider cache.
   * Only applies if cache exists and is fresh (within refreshIntervalMs).
   */
  private async loadFromCache(): Promise<boolean> {
    if (!this.storage) return false;

    const gen = this.generation;
    try {
      const { data: dataKey, ts: tsKey } = this.cacheKeys();
      const [cached, cachedTs] = await Promise.all([
        this.storage.get(dataKey),
        this.storage.get(tsKey),
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
      // A switch landed while we were reading — this snapshot is the old network's.
      if (gen !== this.generation) return false;

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
      const { data: dataKey, ts: tsKey } = this.cacheKeys();
      await Promise.all([
        this.storage.set(dataKey, JSON.stringify(definitions)),
        this.storage.set(tsKey, String(Date.now())),
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
    if (this.disposed || !this.remoteUrl) {
      return false;
    }

    // Deduplicate concurrent calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Track this attempt locally: configure() may drop the shared field mid-flight and a
    // later caller install its own. Clearing unconditionally here would erase THAT promise
    // and let a second concurrent fetch start for the same network, whose responses could
    // then apply out of order — the older one landing last.
    const attempt = this.doRefresh();
    this.refreshPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (this.refreshPromise === attempt) this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    // Pin the url and generation for this attempt. configure() may swap networks while the
    // fetch is in flight; applying or caching the result afterwards would reinstate the old
    // network's definitions and write them under the NEW url's cache key.
    const url = this.remoteUrl!;
    const gen = this.generation;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, {
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

      if (gen !== this.generation) {
        logger.debug('TokenRegistry', `Discarding stale refresh for ${url} (network changed)`);
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
    // A disposed registry must never hold an interval. The callback would no-op via the
    // disposed guard, but the TIMER ITSELF is the leak — it keeps Node's loop alive.
    if (this.disposed) return;
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
