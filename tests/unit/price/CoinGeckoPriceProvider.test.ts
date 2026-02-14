import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoinGeckoPriceProvider } from '../../../price/CoinGeckoPriceProvider';
import type { StorageProvider } from '../../../storage';
import { STORAGE_KEYS_GLOBAL } from '../../../constants';

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

describe('CoinGeckoPriceProvider', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should set platform to coingecko', () => {
      const provider = new CoinGeckoPriceProvider();
      expect(provider.platform).toBe('coingecko');
    });

    it('should use free API URL when no apiKey', () => {
      const provider = new CoinGeckoPriceProvider();
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('api.coingecko.com'),
        expect.any(Object),
      );
    });

    it('should use pro API URL when apiKey is provided', () => {
      const provider = new CoinGeckoPriceProvider({ apiKey: 'CG-test' });
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('pro-api.coingecko.com'),
        expect.any(Object),
      );
    });

    it('should send API key header for pro tier', () => {
      const provider = new CoinGeckoPriceProvider({ apiKey: 'CG-mykey' });
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-cg-pro-api-key': 'CG-mykey' }),
        }),
      );
    });

    it('should use custom baseUrl when provided (CORS proxy)', () => {
      const provider = new CoinGeckoPriceProvider({ baseUrl: '/coingecko/api/v3' });
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      provider.getPrices(['bitcoin']);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toMatch(/^\/coingecko\/api\/v3\/simple\/price/);
    });
  });

  // ===========================================================================
  // getPrices
  // ===========================================================================

  describe('getPrices', () => {
    it('should return empty map for empty input', async () => {
      const provider = new CoinGeckoPriceProvider();
      const result = await provider.getPrices([]);
      expect(result.size).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should fetch and parse prices correctly', async () => {
      const mockResponse = {
        bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 },
        ethereum: { usd: 3800, eur: 3500, usd_24h_change: -1.2 },
      };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const provider = new CoinGeckoPriceProvider();
      const result = await provider.getPrices(['bitcoin', 'ethereum']);

      expect(result.size).toBe(2);

      const btc = result.get('bitcoin');
      expect(btc).toBeDefined();
      expect(btc!.tokenName).toBe('bitcoin');
      expect(btc!.priceUsd).toBe(97500);
      expect(btc!.priceEur).toBe(90000);
      expect(btc!.change24h).toBe(2.3);
      expect(btc!.timestamp).toBeGreaterThan(0);

      const eth = result.get('ethereum');
      expect(eth).toBeDefined();
      expect(eth!.priceUsd).toBe(3800);
      expect(eth!.change24h).toBe(-1.2);
    });

    it('should build correct URL with token names', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const provider = new CoinGeckoPriceProvider();
      await provider.getPrices(['bitcoin', 'solana']);

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('ids=bitcoin%2Csolana');
      expect(url).toContain('vs_currencies=usd,eur');
      expect(url).toContain('include_24hr_change=true');
    });

    it('should cache prices and return from cache', async () => {
      const mockResponse = {
        bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 },
      };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const provider = new CoinGeckoPriceProvider({ cacheTtlMs: 60000 });

      // First call — fetches from API
      const result1 = await provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result1.get('bitcoin')!.priceUsd).toBe(97500);

      // Second call — returns from cache
      const result2 = await provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // No additional fetch
      expect(result2.get('bitcoin')!.priceUsd).toBe(97500);
    });

    it('should re-fetch after in-memory cache TTL expires', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      const mockResponse2 = { bitcoin: { usd: 98000, eur: 90500, usd_24h_change: 3.0 } };

      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse2), { status: 200 }));

      const provider = new CoinGeckoPriceProvider({ cacheTtlMs: 1 }); // 1ms TTL

      const result1 = await provider.getPrices(['bitcoin']);
      expect(result1.get('bitcoin')!.priceUsd).toBe(97500);

      // Wait for cache to expire
      await new Promise((r) => setTimeout(r, 10));

      // Should fetch fresh data
      const result2 = await provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result2.get('bitcoin')!.priceUsd).toBe(98000);
    });

    it('should fetch only uncached tokens', async () => {
      const mockResponse1 = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      const mockResponse2 = { ethereum: { usd: 3800, eur: 3500, usd_24h_change: -1.0 } };

      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse1), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse2), { status: 200 }));

      const provider = new CoinGeckoPriceProvider({ cacheTtlMs: 60000 });

      await provider.getPrices(['bitcoin']);
      const result = await provider.getPrices(['bitcoin', 'ethereum']);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // Second fetch should only request ethereum
      const url2 = fetchSpy.mock.calls[1][0] as string;
      expect(url2).toContain('ethereum');
      expect(url2).not.toContain('bitcoin');

      // Both should be in result
      expect(result.get('bitcoin')!.priceUsd).toBe(97500);
      expect(result.get('ethereum')!.priceUsd).toBe(3800);
    });

    it('should return stale cache on API error', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }))
        .mockRejectedValueOnce(new Error('Network error'));

      const provider = new CoinGeckoPriceProvider({ cacheTtlMs: 1 }); // 1ms TTL

      // First call succeeds
      await provider.getPrices(['bitcoin']);

      // Wait for cache to expire
      await new Promise((r) => setTimeout(r, 10));

      // Second call fails, but returns stale cache
      const result = await provider.getPrices(['bitcoin']);
      expect(result.get('bitcoin')!.priceUsd).toBe(97500);
    });

    it('should return empty map on API error with no cache', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      const provider = new CoinGeckoPriceProvider();
      const result = await provider.getPrices(['bitcoin']);
      expect(result.size).toBe(0);
    });

    it('should handle non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));
      const provider = new CoinGeckoPriceProvider();
      const result = await provider.getPrices(['bitcoin']);
      expect(result.size).toBe(0);
    });
  });

  // ===========================================================================
  // Request deduplication
  // ===========================================================================

  describe('request deduplication', () => {
    it('should deduplicate concurrent getPrices calls for the same tokens', async () => {
      const mockResponse = {
        bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 },
        ethereum: { usd: 3800, eur: 3500, usd_24h_change: -1.0 },
      };

      let resolveResponse!: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
      fetchSpy.mockReturnValue(fetchPromise);

      const provider = new CoinGeckoPriceProvider();

      // Start two concurrent calls for the same tokens
      const p1 = provider.getPrices(['bitcoin', 'ethereum']);
      const p2 = provider.getPrices(['bitcoin', 'ethereum']);

      // Resolve the single fetch
      resolveResponse(new Response(JSON.stringify(mockResponse), { status: 200 }));

      const [r1, r2] = await Promise.all([p1, p2]);

      // Only one fetch should have been made
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Both calls should have received the prices
      expect(r1.get('bitcoin')!.priceUsd).toBe(97500);
      expect(r2.get('bitcoin')!.priceUsd).toBe(97500);
      expect(r1.get('ethereum')!.priceUsd).toBe(3800);
      expect(r2.get('ethereum')!.priceUsd).toBe(3800);
    });

    it('should deduplicate when second call requests a subset of in-flight tokens', async () => {
      const mockResponse = {
        bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 },
        ethereum: { usd: 3800, eur: 3500, usd_24h_change: -1.0 },
      };

      let resolveResponse!: (value: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => { resolveResponse = resolve; });
      fetchSpy.mockReturnValue(fetchPromise);

      const provider = new CoinGeckoPriceProvider();

      // First call requests both tokens
      const p1 = provider.getPrices(['bitcoin', 'ethereum']);
      // Second call requests just bitcoin (a subset)
      const p2 = provider.getPrices(['bitcoin']);

      resolveResponse(new Response(JSON.stringify(mockResponse), { status: 200 }));

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(r1.get('bitcoin')!.priceUsd).toBe(97500);
      expect(r2.get('bitcoin')!.priceUsd).toBe(97500);
    });

    it('should NOT deduplicate when second call requests tokens not in-flight', async () => {
      const mockResponse1 = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      const mockResponse2 = { solana: { usd: 150, eur: 140, usd_24h_change: 5.0 } };

      let resolveFirst!: (value: Response) => void;
      const firstFetchPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });

      fetchSpy
        .mockReturnValueOnce(firstFetchPromise)
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse2), { status: 200 }));

      const provider = new CoinGeckoPriceProvider();

      const p1 = provider.getPrices(['bitcoin']);
      // Second call has a token NOT covered by in-flight request
      const p2 = provider.getPrices(['solana']);

      resolveFirst(new Response(JSON.stringify(mockResponse1), { status: 200 }));

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(r1.get('bitcoin')!.priceUsd).toBe(97500);
      expect(r2.get('solana')!.priceUsd).toBe(150);
    });
  });

  // ===========================================================================
  // Rate-limit backoff
  // ===========================================================================

  describe('rate-limit backoff', () => {
    it('should extend cache TTL on 429 to avoid immediate retry', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };

      fetchSpy
        // First call succeeds
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }))
        // Second call hits 429
        .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));

      const provider = new CoinGeckoPriceProvider({ cacheTtlMs: 1 }); // 1ms TTL

      // First call populates cache
      await provider.getPrices(['bitcoin']);

      // Wait for cache to expire
      await new Promise((r) => setTimeout(r, 10));

      // Second call hits 429 — should return stale cache and extend TTL
      const result = await provider.getPrices(['bitcoin']);
      expect(result.get('bitcoin')!.priceUsd).toBe(97500);

      // Third call should return from extended cache (no new fetch)
      const result2 = await provider.getPrices(['bitcoin']);
      expect(result2.get('bitcoin')!.priceUsd).toBe(97500);
      expect(fetchSpy).toHaveBeenCalledTimes(2); // no third fetch
    });
  });

  // ===========================================================================
  // Persistent storage cache
  // ===========================================================================

  describe('persistent storage cache', () => {
    it('should save prices to storage after successful fetch', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const storage = createMockStorage();
      const provider = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 60000 });

      await provider.getPrices(['bitcoin']);

      // Wait for fire-and-forget save
      await new Promise((r) => setTimeout(r, 10));

      expect(storage.set).toHaveBeenCalledWith(
        STORAGE_KEYS_GLOBAL.PRICE_CACHE,
        expect.any(String),
      );
      expect(storage.set).toHaveBeenCalledWith(
        STORAGE_KEYS_GLOBAL.PRICE_CACHE_TS,
        expect.any(String),
      );
    });

    it('should load prices from storage on first call (no network fetch)', async () => {
      const storage = createMockStorage();

      // Pre-populate storage with cached prices
      const cachedPrices = {
        bitcoin: { tokenName: 'bitcoin', priceUsd: 95000, priceEur: 88000, change24h: 1.5, timestamp: Date.now() },
      };
      await storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE, JSON.stringify(cachedPrices));
      await storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE_TS, String(Date.now()));

      const provider = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });

      const result = await provider.getPrices(['bitcoin']);

      // Should return from persistent cache, no fetch
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.get('bitcoin')!.priceUsd).toBe(95000);
    });

    it('should skip stale persistent cache', async () => {
      const storage = createMockStorage();

      // Pre-populate with OLD timestamp (past TTL)
      const cachedPrices = {
        bitcoin: { tokenName: 'bitcoin', priceUsd: 95000, priceEur: 88000, change24h: 1.5, timestamp: Date.now() - 400_000 },
      };
      await storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE, JSON.stringify(cachedPrices));
      await storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE_TS, String(Date.now() - 400_000));

      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const provider = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });

      const result = await provider.getPrices(['bitcoin']);

      // Stale cache skipped, should fetch from API
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.get('bitcoin')!.priceUsd).toBe(97500);
    });

    it('should survive page reload simulation (new provider instance reads old storage)', async () => {
      const storage = createMockStorage();
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      // First "session" — fetch and persist
      const provider1 = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });
      await provider1.getPrices(['bitcoin']);
      await new Promise((r) => setTimeout(r, 10)); // let save complete

      // Second "session" — new instance, same storage
      const provider2 = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });
      const result = await provider2.getPrices(['bitcoin']);

      // Should come from persistent cache, no second fetch
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.get('bitcoin')!.priceUsd).toBe(97500);
    });

    it('should persist tokens not found on CoinGecko with zero prices', async () => {
      const storage = createMockStorage();
      // API returns bitcoin but NOT unicity (not listed on CoinGecko)
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      // First "session" — fetch bitcoin + unicity
      const provider1 = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });
      const result1 = await provider1.getPrices(['bitcoin', 'unicity']);
      await new Promise((r) => setTimeout(r, 10)); // let save complete

      // unicity should be in result with zero price
      expect(result1.get('unicity')!.priceUsd).toBe(0);
      expect(result1.get('bitcoin')!.priceUsd).toBe(97500);

      // Second "session" — new instance, same storage, no API calls
      const provider2 = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });
      const result2 = await provider2.getPrices(['bitcoin', 'unicity']);

      expect(fetchSpy).toHaveBeenCalledTimes(1); // no second fetch
      expect(result2.get('bitcoin')!.priceUsd).toBe(97500);
      expect(result2.get('unicity')!.priceUsd).toBe(0);
      expect(result2.get('unicity')!.tokenName).toBe('unicity');
    });

    it('should gracefully handle corrupted storage data', async () => {
      const storage = createMockStorage();

      // Pre-populate with corrupted JSON
      await storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE, '{{not valid json');
      await storage.set(STORAGE_KEYS_GLOBAL.PRICE_CACHE_TS, String(Date.now()));

      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      // Should not throw — falls back to API fetch
      const provider = new CoinGeckoPriceProvider({ storage, cacheTtlMs: 300_000 });
      const result = await provider.getPrices(['bitcoin']);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.get('bitcoin')!.priceUsd).toBe(97500);
    });

    it('should work without storage (backwards compatible)', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const provider = new CoinGeckoPriceProvider();
      const result = await provider.getPrices(['bitcoin']);

      expect(result.get('bitcoin')!.priceUsd).toBe(97500);
    });
  });

  // ===========================================================================
  // getPrice
  // ===========================================================================

  describe('getPrice', () => {
    it('should return price for a single token', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), { status: 200 }),
      );

      const provider = new CoinGeckoPriceProvider();
      const price = await provider.getPrice('bitcoin');

      expect(price).not.toBeNull();
      expect(price!.priceUsd).toBe(97500);
      expect(price!.tokenName).toBe('bitcoin');
    });

    it('should return zero-price entry for token not found on CoinGecko', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const provider = new CoinGeckoPriceProvider();
      const price = await provider.getPrice('unknown_token');
      expect(price).not.toBeNull();
      expect(price!.tokenName).toBe('unknown_token');
      expect(price!.priceUsd).toBe(0);
      expect(price!.priceEur).toBe(0);
      expect(price!.change24h).toBe(0);
    });
  });

  // ===========================================================================
  // clearCache
  // ===========================================================================

  describe('clearCache', () => {
    it('should clear cache and force re-fetch', async () => {
      const mockResponse = { bitcoin: { usd: 97500, eur: 90000, usd_24h_change: 2.3 } };
      fetchSpy
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(mockResponse), { status: 200 }));

      const provider = new CoinGeckoPriceProvider({ cacheTtlMs: 60000 });

      await provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      provider.clearCache();

      await provider.getPrices(['bitcoin']);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
