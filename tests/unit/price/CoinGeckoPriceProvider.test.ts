import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoinGeckoPriceProvider } from '../../../price/CoinGeckoPriceProvider';

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

    it('should return null for unknown token', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const provider = new CoinGeckoPriceProvider();
      const price = await provider.getPrice('unknown_token');
      expect(price).toBeNull();
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
