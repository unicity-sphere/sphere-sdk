/**
 * CoinGecko Price Provider
 *
 * Fetches token prices from CoinGecko API with internal caching.
 * Supports both free and pro API tiers.
 * Optionally persists cache to StorageProvider for survival across page reloads.
 */

import { logger } from '../core/logger';
import { SphereError } from '../core/errors';
import { STORAGE_KEYS_GLOBAL } from '../constants';
import type { StorageProvider } from '../storage';
import type { PriceProvider, PricePlatform, TokenPrice, PriceProviderConfig } from './price-provider';

// =============================================================================
// Types
// =============================================================================

interface CacheEntry {
  price: TokenPrice;
  expiresAt: number;
}

/** Serializable format for persistent storage */
interface PersistedPriceCache {
  [tokenName: string]: TokenPrice;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * CoinGecko price provider
 *
 * @example
 * ```ts
 * // Free tier (no API key)
 * const provider = new CoinGeckoPriceProvider();
 *
 * // Pro tier
 * const provider = new CoinGeckoPriceProvider({ apiKey: 'CG-xxx' });
 *
 * // With persistent cache (survives page reloads)
 * const provider = new CoinGeckoPriceProvider({ storage: myStorageProvider });
 *
 * const prices = await provider.getPrices(['bitcoin', 'ethereum']);
 * console.log(prices.get('bitcoin')?.priceUsd);
 * ```
 */
export class CoinGeckoPriceProvider implements PriceProvider {
  readonly platform: PricePlatform = 'coingecko';

  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly apiKey?: string;
  private readonly cacheTtlMs: number;
  private readonly timeout: number;
  private readonly debug: boolean;
  private readonly baseUrl: string;
  private readonly storage: StorageProvider | null;

  /** In-flight fetch promise for deduplication of concurrent getPrices() calls */
  private fetchPromise: Promise<Map<string, TokenPrice>> | null = null;
  /** Token names being fetched in the current in-flight request */
  private fetchNames: Set<string> | null = null;
  /** Whether persistent cache has been loaded into memory */
  private persistentCacheLoaded = false;
  /** Promise for loading persistent cache (deduplication) */
  private loadCachePromise: Promise<void> | null = null;

  constructor(config?: Omit<PriceProviderConfig, 'platform'>) {
    this.apiKey = config?.apiKey;
    this.cacheTtlMs = config?.cacheTtlMs ?? 60_000;
    this.timeout = config?.timeout ?? 10_000;
    this.debug = config?.debug ?? false;
    this.storage = config?.storage ?? null;

    this.baseUrl = config?.baseUrl
      ?? (this.apiKey
        ? 'https://pro-api.coingecko.com/api/v3'
        : 'https://api.coingecko.com/api/v3');
  }

  async getPrices(tokenNames: string[]): Promise<Map<string, TokenPrice>> {
    if (tokenNames.length === 0) {
      return new Map();
    }

    // Load persistent cache on first call (once)
    if (!this.persistentCacheLoaded && this.storage) {
      await this.loadFromStorage();
    }

    const now = Date.now();
    const result = new Map<string, TokenPrice>();
    const uncachedNames: string[] = [];

    // Check cache first
    for (const name of tokenNames) {
      const cached = this.cache.get(name);
      if (cached && cached.expiresAt > now) {
        result.set(name, cached.price);
      } else {
        uncachedNames.push(name);
      }
    }

    // All cached — return immediately
    if (uncachedNames.length === 0) {
      return result;
    }

    // Deduplicate concurrent calls: if an in-flight fetch covers all needed tokens, reuse it
    if (this.fetchPromise && this.fetchNames) {
      const allCovered = uncachedNames.every((n) => this.fetchNames!.has(n));
      if (allCovered) {
        if (this.debug) {
          logger.debug('CoinGecko', 'Deduplicating request, reusing in-flight fetch');
        }
        const fetched = await this.fetchPromise;
        for (const name of uncachedNames) {
          const price = fetched.get(name);
          if (price) {
            result.set(name, price);
          }
        }
        return result;
      }
    }

    // Fetch uncached prices
    const fetchPromise = this.doFetch(uncachedNames);
    this.fetchPromise = fetchPromise;
    this.fetchNames = new Set(uncachedNames);

    try {
      const fetched = await fetchPromise;
      for (const [name, price] of fetched) {
        result.set(name, price);
      }
    } finally {
      // Clear in-flight state only if this is still the current request
      if (this.fetchPromise === fetchPromise) {
        this.fetchPromise = null;
        this.fetchNames = null;
      }
    }

    return result;
  }

  private async doFetch(uncachedNames: string[]): Promise<Map<string, TokenPrice>> {
    const result = new Map<string, TokenPrice>();
    const now = Date.now();

    try {
      const ids = uncachedNames.join(',');
      const url = `${this.baseUrl}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd,eur&include_24hr_change=true`;

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.apiKey) {
        headers['x-cg-pro-api-key'] = this.apiKey;
      }

      if (this.debug) {
        logger.debug('CoinGecko', `Fetching prices for: ${uncachedNames.join(', ')}`);
      }

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        // On rate-limit, extend existing cache entries to avoid hammering the API
        if (response.status === 429) {
          this.extendCacheOnRateLimit(uncachedNames);
        }
        throw new SphereError(`CoinGecko API error: ${response.status} ${response.statusText}`, 'NETWORK_ERROR');
      }

      const data = await response.json() as Record<string, Record<string, number>>;

      // Parse and cache response
      for (const [name, values] of Object.entries(data)) {
        if (values && typeof values === 'object') {
          const price: TokenPrice = {
            tokenName: name,
            priceUsd: values.usd ?? 0,
            priceEur: values.eur,
            change24h: values.usd_24h_change,
            timestamp: now,
          };
          this.cache.set(name, { price, expiresAt: now + this.cacheTtlMs });
          result.set(name, price);
        }
      }

      // Tokens not found on CoinGecko: cache with zero prices to avoid re-requesting
      // and to persist in storage (so page reloads don't trigger unnecessary API calls)
      for (const name of uncachedNames) {
        if (!result.has(name)) {
          const zeroPrice: TokenPrice = {
            tokenName: name,
            priceUsd: 0,
            priceEur: 0,
            change24h: 0,
            timestamp: now,
          };
          this.cache.set(name, { price: zeroPrice, expiresAt: now + this.cacheTtlMs });
          result.set(name, zeroPrice);
        }
      }

      if (this.debug) {
        logger.debug('CoinGecko', `Fetched ${result.size} prices`);
      }

      // Persist to storage (fire-and-forget)
      this.saveToStorage();
    } catch (error) {
      if (this.debug) {
        logger.warn('CoinGecko', 'Fetch failed, using stale cache:', error);
      }

      // On error, return stale cached data if available
      for (const name of uncachedNames) {
        const stale = this.cache.get(name);
        if (stale) {
          result.set(name, stale.price);
        }
      }
    }

    return result;
  }

  // ===========================================================================
  // Persistent Storage
  // ===========================================================================

  /**
   * Load cached prices from StorageProvider into in-memory cache.
   * Only loads entries that are still within cacheTtlMs.
   */
  private async loadFromStorage(): Promise<void> {
    // Deduplicate concurrent loads
    if (this.loadCachePromise) {
      return this.loadCachePromise;
    }
    this.loadCachePromise = this.doLoadFromStorage();
    try {
      await this.loadCachePromise;
    } finally {
      this.loadCachePromise = null;
    }
  }

  private async doLoadFromStorage(): Promise<void> {
    this.persistentCacheLoaded = true;
    if (!this.storage) return;

    try {
      const [cached, cachedTs] = await Promise.all([
        this.storage.get(STORAGE_KEYS_GLOBAL.PRICE_CACHE),
        this.storage.get(STORAGE_KEYS_GLOBAL.PRICE_CACHE_TS),
      ]);

      if (!cached || !cachedTs) return;

      const ts = parseInt(cachedTs, 10);
      if (isNaN(ts)) return;

      // Only use if within TTL
      const age = Date.now() - ts;
      if (age > this.cacheTtlMs) return;

      const data: PersistedPriceCache = JSON.parse(cached);
      const expiresAt = ts + this.cacheTtlMs;

      for (const [name, price] of Object.entries(data)) {
        // Only populate if not already in memory (in-memory is always fresher)
        if (!this.cache.has(name)) {
          this.cache.set(name, { price, expiresAt });
        }
      }

      if (this.debug) {
        logger.debug('CoinGecko', `Loaded ${Object.keys(data).length} prices from persistent cache`);
      }
    } catch {
      // Cache load failure is non-critical
    }
  }

  /**
   * Save current prices to StorageProvider (fire-and-forget).
   */
  private saveToStorage(): void {
    if (!this.storage) return;

    const data: PersistedPriceCache = {};
    for (const [name, entry] of this.cache) {
      data[name] = entry.price;
    }

    // Fire-and-forget
    Promise.all([
      this.storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE, JSON.stringify(data)),
      this.storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE_TS, String(Date.now())),
    ]).catch(() => {
      // Cache save failure is non-critical
    });
  }

  // ===========================================================================
  // Rate-limit handling
  // ===========================================================================

  /**
   * On 429 rate-limit, extend stale cache entries so subsequent calls
   * don't immediately retry and hammer the API.
   */
  private extendCacheOnRateLimit(names: string[]): void {
    const backoffMs = 60_000; // 1 minute backoff on rate-limit
    const extendedExpiry = Date.now() + backoffMs;

    for (const name of names) {
      const existing = this.cache.get(name);
      if (existing) {
        existing.expiresAt = Math.max(existing.expiresAt, extendedExpiry);
      }
    }

    if (this.debug) {
      logger.warn('CoinGecko', `Rate-limited (429), extended cache TTL by ${backoffMs / 1000}s`);
    }
  }

  async getPrice(tokenName: string): Promise<TokenPrice | null> {
    const prices = await this.getPrices([tokenName]);
    return prices.get(tokenName) ?? null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
