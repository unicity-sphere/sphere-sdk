/**
 * Tests for modules/market/MarketModule.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketModule, createMarketModule } from '../../../modules/market/MarketModule';
import type { FullIdentity } from '../../../types';
import { DEFAULT_MARKET_API_URL } from '../../../constants';

// =============================================================================
// Test Helpers
// =============================================================================

const TEST_PRIVATE_KEY = 'a'.repeat(64);

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'ab'.repeat(32),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: TEST_PRIVATE_KEY,
  };
}

function mockDeps() {
  return {
    identity: mockIdentity(),
    emitEvent: vi.fn(),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('MarketModule', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Construction & Config
  // ---------------------------------------------------------------------------

  describe('construction', () => {
    it('should use default API URL when no config provided', () => {
      const mod = createMarketModule();
      mod.initialize(mockDeps());
      // Verify by calling a public endpoint and checking the URL
      mod.getCategories().catch(() => {});
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(DEFAULT_MARKET_API_URL),
        expect.anything(),
      );
    });

    it('should use custom API URL', () => {
      const mod = createMarketModule({ apiUrl: 'https://custom.api' });
      mod.initialize(mockDeps());
      mod.getCategories().catch(() => {});
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://custom.api'),
        expect.anything(),
      );
    });

    it('should strip trailing slashes from API URL', () => {
      const mod = createMarketModule({ apiUrl: 'https://custom.api///' });
      mod.initialize(mockDeps());
      mod.getCategories().catch(() => {});
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://custom.api/api/categories',
        expect.anything(),
      );
    });

    it('factory should return a MarketModule instance', () => {
      const mod = createMarketModule();
      expect(mod).toBeInstanceOf(MarketModule);
    });
  });

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------

  describe('signing', () => {
    it('should include x-public-key, x-signature, x-timestamp headers', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ agent: { id: 1, public_key: '02ab', registered_at: '2025-01-01' } }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());
      await mod.register();

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      expect(headers['x-public-key']).toBeDefined();
      expect(headers['x-signature']).toBeDefined();
      expect(headers['x-timestamp']).toBeDefined();
      expect(headers['content-type']).toBe('application/json');
    });

    it('should throw if not initialized', async () => {
      const mod = createMarketModule();
      await expect(mod.register()).rejects.toThrow('MarketModule not initialized');
    });
  });

  // ---------------------------------------------------------------------------
  // API Methods
  // ---------------------------------------------------------------------------

  describe('register()', () => {
    it('should POST to /api/agents/register', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ agent: { id: 1, public_key: '02ab', registered_at: '2025-01-01' } }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.register({ name: 'Test Agent' });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/agents/register');
      expect(opts?.method).toBe('POST');
      const body = JSON.parse(opts?.body as string);
      expect(body.public_key).toBeDefined();
      expect(body.name).toBe('Test Agent');
      expect(result.id).toBe(1);
    });
  });

  describe('getProfile()', () => {
    it('should GET /api/agents/me', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ agent: { id: 1, public_key: '02ab', registered_at: '2025-01-01' } }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.getProfile();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/agents/me');
      expect(opts?.method).toBe('GET');
      expect(result.id).toBe(1);
    });
  });

  describe('postIntent()', () => {
    it('should POST to /api/intents with snake_case body', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_123',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.postIntent({
        description: 'Looking for widgets',
        intentType: 'buy',
        category: 'goods',
        price: 100,
        currency: 'USD',
        location: 'NYC',
        contactHandle: '@alice',
        expiresInDays: 30,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/intents');
      expect(opts?.method).toBe('POST');
      const body = JSON.parse(opts?.body as string);
      expect(body.description).toBe('Looking for widgets');
      expect(body.intent_type).toBe('buy');
      expect(body.category).toBe('goods');
      expect(body.price).toBe(100);
      expect(body.contact_handle).toBe('@alice');
      expect(body.expires_in_days).toBe(30);
      // camelCase result mapping
      expect(result.intentId).toBe('int_123');
      expect(result.expiresAt).toBe('2025-12-31');
    });
  });

  describe('search()', () => {
    it('should POST to /api/intents/search (public, no auth headers)', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        results: [{
          id: 'int_1',
          score: 0.95,
          agent_public_key: '02ab',
          agent_nametag: 'alice',
          description: 'Widget',
          intent_type: 'sell',
          currency: 'USD',
          contact_method: 'nostr',
          contact_handle: '@alice',
          created_at: '2025-01-01',
          expires_at: '2025-12-31',
        }],
      }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.search('widget', {
        filters: { intentType: 'sell', minPrice: 10, maxPrice: 200 },
        limit: 5,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/intents/search');
      expect(opts?.method).toBe('POST');
      const body = JSON.parse(opts?.body as string);
      expect(body.query).toBe('widget');
      expect(body.intent_type).toBe('sell');
      expect(body.min_price).toBe(10);
      expect(body.max_price).toBe(200);
      expect(body.limit).toBe(5);
      // No auth headers on public endpoint
      const headers = opts?.headers as Record<string, string>;
      expect(headers['x-public-key']).toBeUndefined();

      // camelCase result mapping
      expect(result.intents).toHaveLength(1);
      expect(result.intents[0].agentNametag).toBe('alice');
      expect(result.intents[0].agentPublicKey).toBe('02ab');
      expect(result.intents[0].intentType).toBe('sell');
      expect(result.intents[0].contactMethod).toBe('nostr');
      expect(result.intents[0].contactHandle).toBe('@alice');
    });
  });

  describe('getMyIntents()', () => {
    it('should GET /api/intents/my', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intents: [{
          id: 'int_1',
          intent_type: 'buy',
          currency: 'USD',
          status: 'active',
          created_at: '2025-01-01',
          expires_at: '2025-12-31',
        }],
      }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.getMyIntents();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/intents/my');
      expect(opts?.method).toBe('GET');
      expect(result).toHaveLength(1);
      expect(result[0].intentType).toBe('buy');
      expect(result[0].status).toBe('active');
    });
  });

  describe('closeIntent()', () => {
    it('should DELETE /api/intents/:id', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ message: 'Closed' }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await mod.closeIntent('int_123');
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/intents/int_123');
      expect(opts?.method).toBe('DELETE');
    });
  });

  describe('getCategories()', () => {
    it('should GET /api/categories (public)', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ categories: ['goods', 'services', 'other'] }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.getCategories();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/categories');
      expect(opts?.method).toBe('GET');
      expect(result).toEqual(['goods', 'services', 'other']);
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-register
  // ---------------------------------------------------------------------------

  describe('auto-register on 401', () => {
    it('should auto-register and retry when getting "Agent not registered"', async () => {
      const registerResponse = jsonResponse({ agent: { id: 1, public_key: '02ab', registered_at: '2025-01-01' } });
      const profileResponse = jsonResponse({ agent: { id: 1, public_key: '02ab', registered_at: '2025-01-01' } });

      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ error: 'Agent not registered' }, 401)) // first getProfile fails
        .mockResolvedValueOnce(registerResponse) // auto-register
        .mockResolvedValueOnce(profileResponse); // retry getProfile

      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.getProfile();
      expect(result.id).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('should not retry on other errors', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: 'Internal server error' }, 500));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await expect(mod.getProfile()).rejects.toThrow('Internal server error');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should throw on non-ok response', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: 'Bad request' }, 400));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await expect(mod.register()).rejects.toThrow('Bad request');
    });

    it('should throw generic HTTP error when no error field', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, 503));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await expect(mod.register()).rejects.toThrow('HTTP 503');
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('load() should be a no-op', async () => {
      const mod = createMarketModule();
      await expect(mod.load()).resolves.toBeUndefined();
    });

    it('destroy() should be a no-op', () => {
      const mod = createMarketModule();
      expect(() => mod.destroy()).not.toThrow();
    });
  });
});
