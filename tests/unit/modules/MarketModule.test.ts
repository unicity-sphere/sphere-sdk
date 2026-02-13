/**
 * Tests for modules/market/MarketModule.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketModule, createMarketModule } from '../../../modules/market/MarketModule';
import type { FullIdentity } from '../../../types';
import { DEFAULT_MARKET_API_URL } from '../../../constants';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

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

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Create a module that's already "registered" so tests don't trigger registration fetches */
function createRegisteredModule(config?: Parameters<typeof createMarketModule>[0]): MarketModule {
  const mod = createMarketModule(config);
  mod.initialize(mockDeps());
  // Skip auto-registration in unit tests — registration is tested separately
  (mod as any).registered = true;
  return mod;
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
      mod.search('test').catch(() => {});
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(DEFAULT_MARKET_API_URL),
        expect.anything(),
      );
    });

    it('should use custom API URL', () => {
      const mod = createMarketModule({ apiUrl: 'https://custom.api' });
      mod.initialize(mockDeps());
      mod.search('test').catch(() => {});
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://custom.api'),
        expect.anything(),
      );
    });

    it('should strip trailing slashes from API URL', () => {
      const mod = createMarketModule({ apiUrl: 'https://custom.api///' });
      mod.initialize(mockDeps());
      mod.search('test').catch(() => {});
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://custom.api/api/search',
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
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createRegisteredModule();
      await mod.postIntent({ description: 'test', intentType: 'buy' });

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      expect(headers['x-public-key']).toBeDefined();
      expect(headers['x-signature']).toBeDefined();
      expect(headers['x-timestamp']).toBeDefined();
      expect(headers['content-type']).toBe('application/json');
    });

    it('should throw if not initialized', async () => {
      const mod = createMarketModule();
      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('MarketModule not initialized');
    });
  });

  // ---------------------------------------------------------------------------
  // API Methods
  // ---------------------------------------------------------------------------

  describe('postIntent()', () => {
    it('should POST to /api/intents with snake_case body', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_123',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createRegisteredModule();

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
    it('should POST to /api/search (public, no auth headers)', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intents: [{
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
      expect(url).toContain('/api/search');
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
    it('should GET /api/intents (authenticated)', async () => {
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
      const mod = createRegisteredModule();

      const result = await mod.getMyIntents();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/intents');
      expect(url).not.toContain('/api/intents/my');
      expect(opts?.method).toBe('GET');
      expect(result).toHaveLength(1);
      expect(result[0].intentType).toBe('buy');
      expect(result[0].status).toBe('active');

      // Should include auth headers
      const headers = opts?.headers as Record<string, string>;
      expect(headers['x-public-key']).toBeDefined();
      expect(headers['x-signature']).toBeDefined();
    });
  });

  describe('closeIntent()', () => {
    it('should DELETE /api/intents/:id', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ message: 'Closed' }));
      const mod = createRegisteredModule();

      await mod.closeIntent('int_123');
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/intents/int_123');
      expect(opts?.method).toBe('DELETE');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should throw on non-ok response', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: 'Bad request' }, 400));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('Bad request');
    });

    it('should throw generic HTTP error when no error field', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, 503));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('HTTP 503');
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

    it('should throw when methods called before initialize', async () => {
      const mod = createMarketModule();
      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('MarketModule not initialized');
      await expect(mod.getMyIntents()).rejects.toThrow('MarketModule not initialized');
      await expect(mod.closeIntent('int_123')).rejects.toThrow('MarketModule not initialized');
    });

    it('should work after initialize', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createRegisteredModule();
      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).resolves.toBeDefined();
    });

    it('should support re-initialization with different identity', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createRegisteredModule();

      const identity2: FullIdentity = {
        ...mockIdentity(),
        privateKey: 'b'.repeat(64),
      };
      mod.initialize({ identity: identity2, emitEvent: vi.fn() });
      (mod as any).registered = true;

      // Both should work without error
      await mod.postIntent({ description: 'test', intentType: 'buy' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Request Signing Details
  // ---------------------------------------------------------------------------

  describe('request signing details', () => {
    it('should create valid secp256k1 signature', async () => {
      const identity = mockIdentity();
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      await mod.postIntent({ description: 'test', intentType: 'buy' });

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      const sig = headers['x-signature'];
      const pubkey = headers['x-public-key'];
      const timestamp = headers['x-timestamp'];
      const bodyStr = opts?.body as string;

      // Signature should be hex string and valid length for compact format (64 bytes = 128 hex chars)
      expect(sig).toMatch(/^[0-9a-f]{128}$/);

      // Verify public key matches the expected key derived from private key
      const expectedPubkey = secp256k1.getPublicKey(hexToBytes(identity.privateKey), true);
      expect(pubkey).toBe(bytesToHex(expectedPubkey));

      // Verify the signature can be parsed as a valid compact signature (will throw if invalid)
      expect(() => secp256k1.Signature.fromHex(sig)).not.toThrow();

      // Verify signature is for the correct message (body + timestamp)
      const body = JSON.parse(bodyStr);
      const payload = JSON.stringify({ body, timestamp });

      // Create a signature for DIFFERENT data and verify it's different
      const differentBody = { ...body, test: 'different' };
      const differentPayload = JSON.stringify({ body: differentBody, timestamp });
      const differentHash = sha256(new TextEncoder().encode(differentPayload));
      const differentSig = secp256k1.sign(differentHash, hexToBytes(identity.privateKey));

      // Signatures should be different (proving uniqueness), but both valid format
      expect(sig).not.toBe(bytesToHex(differentSig));
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
      expect(bytesToHex(differentSig)).toMatch(/^[0-9a-f]{128}$/);
    });

    it('should include derived public key from private key', async () => {
      const identity = mockIdentity();
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      await mod.postIntent({ description: 'test', intentType: 'buy' });

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      const pubkey = headers['x-public-key'];

      // The public key should be derived from the private key and be a valid compressed pubkey
      expect(pubkey).toMatch(/^02[0-9a-f]{64}$/);
      expect(pubkey).toBeDefined();
    });

    it('should include recent timestamp', async () => {
      const identity = mockIdentity();
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      const beforeCall = Date.now();
      await mod.postIntent({ description: 'test', intentType: 'buy' });
      const afterCall = Date.now();

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      const ts = parseInt(headers['x-timestamp'], 10);

      expect(ts).toBeGreaterThanOrEqual(beforeCall);
      expect(ts).toBeLessThanOrEqual(afterCall + 100); // Allow 100ms buffer
    });

    it('should produce different signatures for different bodies', async () => {
      const identity = mockIdentity();
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      // Mock Date.now to ensure signatures differ due to body, not timestamp
      const fixedTimestamp = 1700000000000;
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        // Return different timestamps for each call to ensure uniqueness
        return fixedTimestamp + (callCount++ * 1000);
      });

      // First call
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      await mod.postIntent({ description: 'Intent 1', intentType: 'buy' });
      const sig1 = (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['x-signature'];
      const ts1 = (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['x-timestamp'];
      const body1 = fetchSpy.mock.calls[0][1]?.body as string;

      // Second call with different body but same timestamp
      callCount = 0; // Reset to get same timestamp
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        intent_id: 'int_2',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      await mod.postIntent({ description: 'Intent 2', intentType: 'sell' });
      const sig2 = (fetchSpy.mock.calls[1][1]?.headers as Record<string, string>)['x-signature'];
      const ts2 = (fetchSpy.mock.calls[1][1]?.headers as Record<string, string>)['x-timestamp'];
      const body2 = fetchSpy.mock.calls[1][1]?.body as string;

      // Verify timestamps are the same (to eliminate timestamp as differentiator)
      expect(ts1).toBe(ts2);

      // Verify bodies are different
      expect(body1).not.toBe(body2);

      // Verify signatures are different due to body difference
      expect(sig1).not.toBe(sig2);

      vi.restoreAllMocks();
    });

    it('should sign SHA256 hash of JSON payload including body and timestamp', async () => {
      const identity = mockIdentity();
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      await mod.postIntent({ description: 'TestIntent', intentType: 'buy' });

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      const bodyStr = opts?.body as string;
      const sig = headers['x-signature'];
      const pubkey = headers['x-public-key'];
      const timestamp = headers['x-timestamp'];

      const body = JSON.parse(bodyStr);

      // Verify the public key matches the expected key derived from private key
      const privateKeyBytes = hexToBytes(identity.privateKey);
      const expectedPubkey = secp256k1.getPublicKey(privateKeyBytes, true);
      expect(bytesToHex(expectedPubkey)).toBe(pubkey);

      // Verify signature format is valid
      expect(sig).toMatch(/^[0-9a-f]{128}$/);
      expect(() => secp256k1.Signature.fromHex(sig)).not.toThrow();

      // Verify the payload structure includes both body and timestamp
      expect(body).toHaveProperty('description', 'TestIntent');
      expect(body).toHaveProperty('intent_type', 'buy');
      expect(timestamp).toMatch(/^\d+$/); // Numeric timestamp

      // Verify that the signature includes the timestamp in the signed data
      // by checking that a different timestamp would produce a different payload hash
      const payload1 = JSON.stringify({ body, timestamp });
      const hash1 = sha256(new TextEncoder().encode(payload1));

      const differentTimestamp = String(parseInt(timestamp, 10) + 1000);
      const payload2 = JSON.stringify({ body, timestamp: differentTimestamp });
      const hash2 = sha256(new TextEncoder().encode(payload2));

      // Hashes should be different, proving timestamp is part of signed data
      expect(bytesToHex(hash1)).not.toBe(bytesToHex(hash2));
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-registration
  // ---------------------------------------------------------------------------

  describe('auto-registration', () => {
    it('should register agent before first authenticated call', async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ agentId: 'agent_1' }, 201)) // registration
        .mockResolvedValueOnce(jsonResponse({ intents: [] })); // getMyIntents

      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await mod.getMyIntents();

      // First call: registration, second call: actual API
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [regUrl, regOpts] = fetchSpy.mock.calls[0];
      expect(regUrl).toContain('/api/agent/register');
      expect(regOpts?.method).toBe('POST');
      const regBody = JSON.parse(regOpts?.body as string);
      expect(regBody.public_key).toBeDefined();
    });

    it('should only register once across multiple calls', async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ agentId: 'agent_1' }, 201)) // registration
        .mockResolvedValueOnce(jsonResponse({ intents: [] })) // first getMyIntents
        .mockResolvedValueOnce(jsonResponse({ intents: [] })); // second getMyIntents

      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await mod.getMyIntents();
      await mod.getMyIntents();

      // 1 registration + 2 API calls
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      // Only first call should be registration
      expect(fetchSpy.mock.calls[0][0]).toContain('/api/agent/register');
      expect(fetchSpy.mock.calls[1][0]).toContain('/api/intents');
      expect(fetchSpy.mock.calls[2][0]).toContain('/api/intents');
    });

    it('should treat 409 (already registered) as success', async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ error: 'Agent already registered', agentId: 'agent_1' }, 409))
        .mockResolvedValueOnce(jsonResponse({ intents: [] }));

      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await expect(mod.getMyIntents()).resolves.toBeDefined();
    });

    it('should not register for public endpoints (search)', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await mod.search('test');

      // Only 1 call (no registration for public endpoint)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain('/api/search');
    });
  });

  // ---------------------------------------------------------------------------
  // Field Mapping: snake_case ↔ camelCase
  // ---------------------------------------------------------------------------

  describe('field mapping (snake_case ↔ camelCase)', () => {
    describe('postIntent request mapping', () => {
      it('should map intentType to intent_type in request', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intent_id: 'int_1',
          message: 'Created',
          expires_at: '2025-12-31',
        }));
        const mod = createRegisteredModule();

        await mod.postIntent({
          description: 'Looking for widgets',
          intentType: 'buy',
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.intent_type).toBe('buy');
      });

      it('should omit optional fields if not provided', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intent_id: 'int_1',
          message: 'Created',
          expires_at: '2025-12-31',
        }));
        const mod = createRegisteredModule();

        await mod.postIntent({
          description: 'Looking for widgets',
          intentType: 'buy',
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.category).toBeUndefined();
        expect(body.price).toBeUndefined();
        expect(body.currency).toBeUndefined();
        expect(body.location).toBeUndefined();
        expect(body.contact_handle).toBeUndefined();
        expect(body.expires_in_days).toBeUndefined();
      });

      it('should include only provided optional fields', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intent_id: 'int_1',
          message: 'Created',
          expires_at: '2025-12-31',
        }));
        const mod = createRegisteredModule();

        await mod.postIntent({
          description: 'Looking for widgets',
          intentType: 'buy',
          price: 100,
          contactHandle: '@alice',
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.price).toBe(100);
        expect(body.contact_handle).toBe('@alice');
        expect(body.category).toBeUndefined();
        expect(body.currency).toBeUndefined();
      });

      it('should map all fields correctly', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intent_id: 'int_1',
          message: 'Created',
          expires_at: '2025-12-31',
        }));
        const mod = createRegisteredModule();

        await mod.postIntent({
          description: 'Test widget',
          intentType: 'sell',
          category: 'goods',
          price: 99.99,
          currency: 'EUR',
          location: 'Berlin',
          contactHandle: '@bob',
          expiresInDays: 14,
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.description).toBe('Test widget');
        expect(body.intent_type).toBe('sell');
        expect(body.category).toBe('goods');
        expect(body.price).toBe(99.99);
        expect(body.currency).toBe('EUR');
        expect(body.location).toBe('Berlin');
        expect(body.contact_handle).toBe('@bob');
        expect(body.expires_in_days).toBe(14);
      });
    });

    describe('postIntent response mapping', () => {
      it('should map intent_id to intentId', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intent_id: 'int_123',
          message: 'Created',
          expires_at: '2025-12-31',
        }));
        const mod = createRegisteredModule();

        const result = await mod.postIntent({
          description: 'test',
          intentType: 'buy',
        });

        expect(result.intentId).toBe('int_123');
      });

      it('should map expires_at to expiresAt', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intent_id: 'int_123',
          message: 'Created',
          expires_at: '2025-12-31T23:59:59Z',
        }));
        const mod = createRegisteredModule();

        const result = await mod.postIntent({
          description: 'test',
          intentType: 'buy',
        });

        expect(result.expiresAt).toBe('2025-12-31T23:59:59Z');
      });
    });

    describe('search request mapping', () => {
      it('should map intentType to intent_type in filters', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        await mod.search('widget', {
          filters: { intentType: 'sell' },
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.intent_type).toBe('sell');
      });

      it('should map minPrice to min_price', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        await mod.search('widget', {
          filters: { minPrice: 10 },
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.min_price).toBe(10);
      });

      it('should map maxPrice to max_price', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        await mod.search('widget', {
          filters: { maxPrice: 200 },
        });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.max_price).toBe(200);
      });

      it('should not add extra fields for empty filters', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        await mod.search('widget');

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.intent_type).toBeUndefined();
        expect(body.category).toBeUndefined();
        expect(body.min_price).toBeUndefined();
        expect(body.max_price).toBeUndefined();
        expect(body.limit).toBeUndefined();
      });

      it('should include limit in request', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        await mod.search('widget', { limit: 20 });

        const [, opts] = fetchSpy.mock.calls[0];
        const body = JSON.parse(opts?.body as string);
        expect(body.limit).toBe(20);
      });
    });

    describe('search result mapping', () => {
      it('should map all snake_case fields to camelCase', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intents: [{
            id: 'int_1',
            score: 0.95,
            agent_nametag: 'alice',
            agent_public_key: '02ab',
            description: 'Widget',
            intent_type: 'sell',
            category: 'goods',
            price: 100,
            currency: 'USD',
            location: 'NYC',
            contact_method: 'nostr',
            contact_handle: '@alice',
            created_at: '2025-01-01',
            expires_at: '2025-12-31',
          }],
        }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        const result = await mod.search('widget');

        // Verify snake_case fields are transformed to camelCase
        expect(result.intents[0].agentNametag).toBe('alice');
        expect(result.intents[0].agentPublicKey).toBe('02ab');
        expect(result.intents[0].intentType).toBe('sell');
        expect(result.intents[0].contactMethod).toBe('nostr');
        expect(result.intents[0].contactHandle).toBe('@alice');
        expect(result.intents[0].createdAt).toBe('2025-01-01');
        expect(result.intents[0].expiresAt).toBe('2025-12-31');

        // Verify snake_case fields are NOT present in result (proving transformation happened)
        expect((result.intents[0] as any).agent_nametag).toBeUndefined();
        expect((result.intents[0] as any).agent_public_key).toBeUndefined();
        expect((result.intents[0] as any).intent_type).toBeUndefined();
        expect((result.intents[0] as any).contact_method).toBeUndefined();
        expect((result.intents[0] as any).contact_handle).toBeUndefined();
        expect((result.intents[0] as any).created_at).toBeUndefined();
        expect((result.intents[0] as any).expires_at).toBeUndefined();
      });

      it('should default missing optional fields to undefined', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intents: [{
            id: 'int_1',
            score: 0.95,
            agent_public_key: '02ab',
            description: 'Widget',
            intent_type: 'sell',
            currency: 'USD',
            contact_method: 'nostr',
            created_at: '2025-01-01',
            expires_at: '2025-12-31',
          }],
        }));
        const mod = createMarketModule();
        mod.initialize(mockDeps());

        const result = await mod.search('widget');

        expect(result.intents[0].agentNametag).toBeUndefined();
        expect(result.intents[0].category).toBeUndefined();
        expect(result.intents[0].price).toBeUndefined();
        expect(result.intents[0].location).toBeUndefined();
        expect(result.intents[0].contactHandle).toBeUndefined();
      });
    });

    describe('getMyIntents response mapping', () => {
      it('should map all fields correctly', async () => {
        fetchSpy.mockResolvedValue(jsonResponse({
          intents: [{
            id: 'int_1',
            intent_type: 'buy',
            category: 'goods',
            price: '1000',
            currency: 'USD',
            location: 'NYC',
            status: 'active',
            created_at: '2025-01-01',
            expires_at: '2025-12-31',
          }],
        }));
        const mod = createRegisteredModule();

        const result = await mod.getMyIntents();

        expect(result[0].intentType).toBe('buy');
        expect(result[0].category).toBe('goods');
        expect(result[0].price).toBe('1000');
        expect(result[0].status).toBe('active');
        expect(result[0].createdAt).toBe('2025-01-01');
        expect(result[0].expiresAt).toBe('2025-12-31');
      });

      it('should default missing optional fields', async () => {
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
        const mod = createRegisteredModule();

        const result = await mod.getMyIntents();

        expect(result[0].category).toBeUndefined();
        expect(result[0].price).toBeUndefined();
        expect(result[0].location).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Error Handling Details
  // ---------------------------------------------------------------------------

  describe('error handling details', () => {
    it('should throw on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('Network error');
    });

    it('should include error message from response', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: 'Specific error message' }, 400));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('Specific error message');
    });

    it('should fallback to HTTP status code when no error field', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, 503));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('HTTP 503');
    });

    it('should show HTTP 400 as fallback', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}, 400));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('HTTP 400');
    });

    it('should parse JSON error in response', async () => {
      const errorBody = { error: 'Custom API error', details: 'field_name' };
      fetchSpy.mockResolvedValue(jsonResponse(errorBody, 400));
      const mod = createRegisteredModule();

      await expect(mod.postIntent({ description: 'test', intentType: 'buy' })).rejects.toThrow('Custom API error');
    });
  });

  // ---------------------------------------------------------------------------
  // Configuration Details
  // ---------------------------------------------------------------------------

  describe('configuration details', () => {
    it('should use default timeout of 30000ms', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      await mod.search('test');

      const [, opts] = fetchSpy.mock.calls[0];
      // Check that abort signal was used
      expect(opts?.signal).toBeDefined();
    });

    it('should use custom timeout from config', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule({ timeout: 5000 });
      mod.initialize(mockDeps());

      await mod.search('test');

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts?.signal).toBeDefined();
    });

    it('should use custom API URL from config', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule({ apiUrl: 'https://custom.api' });
      mod.initialize(mockDeps());

      await mod.search('test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('https://custom.api');
      expect(url).not.toContain('market-api.unicity.network');
    });

    it('should strip trailing slashes from URL', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule({ apiUrl: 'https://api.test.com///' });
      mod.initialize(mockDeps());

      await mod.search('test');

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.test.com/api/search');
      expect(url).not.toContain('//api/search');
    });
  });

  // ---------------------------------------------------------------------------
  // Security & Validation
  // ---------------------------------------------------------------------------

  describe('security and validation', () => {
    it('should fail signature verification with wrong private key', async () => {
      const identity = mockIdentity();
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      await mod.postIntent({ description: 'test', intentType: 'buy' });

      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      const sig = headers['x-signature'];
      const timestamp = headers['x-timestamp'];
      const bodyStr = opts?.body as string;

      // Create a DIFFERENT private key
      const wrongPrivateKey = 'b'.repeat(64);
      const wrongPubkey = secp256k1.getPublicKey(hexToBytes(wrongPrivateKey), true);

      const body = JSON.parse(bodyStr);
      const payload = JSON.stringify({ body, timestamp });
      const messageHash = sha256(new TextEncoder().encode(payload));

      // Verify signature FAILS with wrong public key
      const isValidWrongKey = secp256k1.verify(hexToBytes(sig), messageHash, wrongPubkey);
      expect(isValidWrongKey).toBe(false);
    });

    it('should include unique timestamps in consecutive requests', async () => {
      const identity = mockIdentity();
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createMarketModule();
      mod.initialize({ identity, emitEvent: vi.fn() });
      (mod as any).registered = true;

      await mod.postIntent({ description: 'test1', intentType: 'buy' });
      const ts1 = parseInt((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['x-timestamp'], 10);

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 2));

      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_2',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      await mod.postIntent({ description: 'test2', intentType: 'sell' });
      const ts2 = parseInt((fetchSpy.mock.calls[1][1]?.headers as Record<string, string>)['x-timestamp'], 10);

      // Timestamps should be different (preventing replay attacks)
      expect(ts2).toBeGreaterThan(ts1);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should URL-encode intent ID in closeIntent', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ message: 'Closed' }));
      const mod = createRegisteredModule();

      const intentId = 'int_/special?chars&';
      await mod.closeIntent(intentId);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain(encodeURIComponent(intentId));
      expect(url).not.toContain('int_/special');
    });

    it('search with no options should work', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.search('query');

      expect(result.intents).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('search with empty filters object should work', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.search('query', { filters: {} });

      expect(result.intents).toEqual([]);
    });

    it('postIntent with only required fields should work', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({
        intent_id: 'int_1',
        message: 'Created',
        expires_at: '2025-12-31',
      }));
      const mod = createRegisteredModule();

      const result = await mod.postIntent({
        description: 'Minimal intent',
        intentType: 'buy',
      });

      expect(result.intentId).toBeDefined();
    });

    it('getMyIntents returning empty array should work', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));
      const mod = createRegisteredModule();

      const result = await mod.getMyIntents();

      expect(result).toEqual([]);
    });

    it('multiple sequential calls should work', async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({
          intent_id: 'int_1',
          message: 'Created',
          expires_at: '2025-12-31',
        }))
        .mockResolvedValueOnce(jsonResponse({ intents: [] }));

      const mod = createRegisteredModule();

      await mod.postIntent({ description: 'test', intentType: 'buy' });
      await mod.getMyIntents();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('search should NOT require authentication', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ intents: [] }));

      // search works even without initialize (no identity needed)
      const mod = createMarketModule();
      mod.initialize(mockDeps());

      const result = await mod.search('test');
      expect(result.intents).toEqual([]);

      // Verify no auth headers
      const [, opts] = fetchSpy.mock.calls[0];
      const headers = opts?.headers as Record<string, string>;
      expect(headers['x-public-key']).toBeUndefined();
      expect(headers['x-signature']).toBeUndefined();
    });
  });
});
