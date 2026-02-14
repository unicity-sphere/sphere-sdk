/**
 * Integration tests for MarketModule within Sphere.
 *
 * Tests:
 * 1. Sphere.init() with market config creates/omits market module
 * 2. Market config resolution (true, custom URL)
 * 3. Provider factory integration (browser and Node.js)
 * 4. Module lifecycle (initialize, load, destroy)
 * 5. Address switching with market module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import { createBrowserProviders } from '../../impl/browser';
import { createNodeProviders } from '../../impl/nodejs';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import { DEFAULT_MARKET_API_URL } from '../../constants';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-market-module');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Mock providers
// =============================================================================

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    registerNametag: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    validate: vi.fn().mockResolvedValue({ valid: [], invalid: [] }),
  } as OracleProvider;
}

// =============================================================================
// Fixtures & Cleanup
// =============================================================================

function cleanupTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function ensureTestDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

// =============================================================================
// Tests
// =============================================================================

describe('MarketModule integration with Sphere', () => {
  beforeEach(() => {
    cleanupTestDir();
    ensureTestDirs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Basic Sphere Integration
  // ---------------------------------------------------------------------------

  describe('Sphere.init() with market config', () => {
    it('should create market module when market: true', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      expect(sphere.market).toBeDefined();
      expect(sphere.market).not.toBeNull();

      await sphere.destroy();
    });

    it('should not create market module when market not specified', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        autoGenerate: true,
      });

      expect(sphere.market).toBeNull();

      await sphere.destroy();
    });

    it('should not create market module when market: false (if supported)', async () => {
      // market: false should be treated as falsy
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: false,
        autoGenerate: true,
      });

      expect(sphere.market).toBeNull();

      await sphere.destroy();
    });

    it('should use custom API URL in market config', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: { apiUrl: 'https://custom-market.api' },
        autoGenerate: true,
      });

      expect(sphere.market).toBeDefined();
      expect(sphere.market).not.toBeNull();

      // Verify by calling a method and checking the URL
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ intents: [] }), { status: 200 })
      );

      await sphere.market!.search('test');
      const fetchCalls = (globalThis.fetch as any).mock.calls;
      const lastCall = fetchCalls[fetchCalls.length - 1];
      expect(lastCall[0]).toContain('https://custom-market.api');

      await sphere.destroy();
    });

    it('should use custom timeout in market config', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: { timeout: 5000 },
        autoGenerate: true,
      });

      expect(sphere.market).toBeDefined();

      await sphere.destroy();
    });

    it('should allow both apiUrl and timeout in market config', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: {
          apiUrl: 'https://market.custom',
          timeout: 10000,
        },
        autoGenerate: true,
      });

      expect(sphere.market).toBeDefined();

      await sphere.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Sphere.load() with market config
  // ---------------------------------------------------------------------------

  describe('Sphere.load() with market config', () => {
    it('should load market module when market: true', async () => {
      // First create wallet
      const { sphere: initial } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        autoGenerate: true,
      });
      await initial.destroy();

      // Then load with market enabled
      const sphere = await Sphere.load({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
      });

      expect(sphere.market).not.toBeNull();

      await sphere.destroy();
    });

    it('should not load market module when not specified', async () => {
      // First create wallet
      const { sphere: initial } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        autoGenerate: true,
      });
      await initial.destroy();

      // Then load without market
      const sphere = await Sphere.load({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
      });

      expect(sphere.market).toBeNull();

      await sphere.destroy();
    });

    it('should respect custom market config on load', async () => {
      // First create wallet
      const { sphere: initial } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        autoGenerate: true,
      });
      await initial.destroy();

      // Then load with custom market config
      const sphere = await Sphere.load({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: { apiUrl: 'https://market.load.test' },
      });

      expect(sphere.market).not.toBeNull();

      await sphere.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Sphere.import() with market config
  // ---------------------------------------------------------------------------

  describe('Sphere.import() with market config', () => {
    it('should create market module when market: true', async () => {
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

      const sphere = await Sphere.import({
        mnemonic,
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
      });

      expect(sphere.market).not.toBeNull();

      await sphere.destroy();
    });

    it('should use custom market config on import', async () => {
      const mnemonic =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

      const sphere = await Sphere.import({
        mnemonic,
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: { apiUrl: 'https://custom-import.api', timeout: 20000 },
      });

      expect(sphere.market).not.toBeNull();

      await sphere.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Market module access and nullability
  // ---------------------------------------------------------------------------

  describe('market module access and nullability', () => {
    it('sphere.market getter should be nullable', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        autoGenerate: true,
      });

      // Should safely return null without throwing
      expect(() => {
        const market = sphere.market;
        expect(market).toBeNull();
      }).not.toThrow();

      await sphere.destroy();
    });

    it('should allow safe optional chaining on market', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        autoGenerate: true,
      });

      // Should not throw with optional chaining
      expect(() => {
        // This is valid TypeScript: (sphere.market as any)?.getProfile()
        if (sphere.market) {
          throw new Error('Should be null');
        }
      }).not.toThrow();

      await sphere.destroy();
    });

    it('should access market methods when module exists', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ intents: [], count: 0 }), { status: 200 })
      );

      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      expect(sphere.market).not.toBeNull();
      const result = await sphere.market!.search('test query');
      expect(result.intents).toEqual([]);

      await sphere.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Address switching with market module
  // ---------------------------------------------------------------------------

  describe('market module with address switching', () => {
    it('should maintain market module on address switch', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      const market1 = sphere.market;

      // Switch to address 1
      await sphere.switchToAddress(1);

      // Market module should still exist
      expect(sphere.market).not.toBeNull();

      await sphere.destroy();
    });

    it('should reinitialize market module with new identity on address switch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ intents: [] }), { status: 200 })
      );

      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      const identity1 = sphere.identity;

      // Call an authenticated market method to capture the public key used
      fetchSpy.mockClear();
      await sphere.market!.getMyIntents();
      const pubkey1 = (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['x-public-key'];

      // Switch to address 1
      await sphere.switchToAddress(1);

      const identity2 = sphere.identity;

      // Identities should be different
      expect(identity1?.chainPubkey).not.toBe(identity2?.chainPubkey);

      // Market module should exist
      expect(sphere.market).not.toBeNull();

      // Call market method again and verify it uses the NEW identity
      fetchSpy.mockClear();
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ intents: [] }), { status: 200 })
      );
      await sphere.market!.getMyIntents();
      const pubkey2 = (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)['x-public-key'];

      // Verify different public keys were used (proving module was reinitialized)
      expect(pubkey1).not.toBe(pubkey2);
      expect(pubkey2).toBe(identity2?.chainPubkey);

      await sphere.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Market module lifecycle within Sphere
  // ---------------------------------------------------------------------------

  describe('market module lifecycle', () => {
    it('should initialize market module on Sphere creation', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      expect(sphere.market).not.toBeNull();

      // Market should be ready to use
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ intents: [] }), { status: 200 })
      );

      const result = await sphere.market!.search('test');
      expect(result.intents).toEqual([]);

      await sphere.destroy();
    });

    it('should destroy market module on Sphere.destroy()', async () => {
      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      expect(sphere.market).not.toBeNull();

      // Destroy should not throw
      await expect(sphere.destroy()).resolves.not.toThrow();
    });

    it('should work after loading wallet with market enabled', async () => {
      // Create and destroy first wallet
      let { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });
      await sphere.destroy();

      // Reload with market enabled
      sphere = await Sphere.load({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
      });

      expect(sphere.market).not.toBeNull();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ intents: [] }), { status: 200 })
      );

      await sphere.market!.search('test');

      await sphere.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Provider factory integration
  // ---------------------------------------------------------------------------

  describe('createBrowserProviders with market config', () => {
    it('should include market config when market: true', () => {
      const providers = createBrowserProviders({ network: 'testnet', market: true });

      expect(providers.market).toBeDefined();
      expect(providers.market).not.toBeNull();
      expect(providers.market?.apiUrl).toBe(DEFAULT_MARKET_API_URL);
    });

    it('should not include market config when not specified', () => {
      const providers = createBrowserProviders({ network: 'testnet' });

      expect(providers.market).toBeUndefined();
    });

    it('should use custom market URL from config', () => {
      const providers = createBrowserProviders({
        network: 'testnet',
        market: { apiUrl: 'https://custom.market.api' },
      });

      expect(providers.market).toBeDefined();
      expect(providers.market?.apiUrl).toBe('https://custom.market.api');
    });

    it('should resolve market: true to default config', () => {
      const providers = createBrowserProviders({
        network: 'testnet',
        market: true,
      });

      expect(providers.market).toBeDefined();
      expect(providers.market?.apiUrl).toBe(DEFAULT_MARKET_API_URL);
    });
  });

  describe('createNodeProviders with market config', () => {
    it('should include market config when market: true', () => {
      const providers = createNodeProviders({
        network: 'testnet',
        market: true,
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
      });

      expect(providers.market).toBeDefined();
      expect(providers.market).not.toBeNull();
      expect(providers.market?.apiUrl).toBe(DEFAULT_MARKET_API_URL);
    });

    it('should not include market config when not specified', () => {
      const providers = createNodeProviders({
        network: 'testnet',
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
      });

      expect(providers.market).toBeUndefined();
    });

    it('should use custom market URL from config', () => {
      const providers = createNodeProviders({
        network: 'testnet',
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
        market: { apiUrl: 'https://node-custom.market.api' },
      });

      expect(providers.market).toBeDefined();
      expect(providers.market?.apiUrl).toBe('https://node-custom.market.api');
    });

    it('should resolve market: true to default config', () => {
      const providers = createNodeProviders({
        network: 'testnet',
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
        market: true,
      });

      expect(providers.market).toBeDefined();
      expect(providers.market?.apiUrl).toBe(DEFAULT_MARKET_API_URL);
    });

    it('should support custom timeout in provider factory', () => {
      const providers = createNodeProviders({
        network: 'testnet',
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
        market: { timeout: 60000 },
      });

      expect(providers.market).toBeDefined();
      expect(providers.market?.timeout).toBe(60000);
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end flow
  // ---------------------------------------------------------------------------

  describe('end-to-end flow', () => {
    it('should create wallet and use market module together', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ intents: [] }), { status: 200 })
      );

      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: { apiUrl: 'https://test.market' },
        autoGenerate: true,
      });

      // Verify identity
      expect(sphere.identity).toBeDefined();
      expect(sphere.identity?.chainPubkey).toBeDefined();

      // Verify market
      expect(sphere.market).not.toBeNull();

      // Use market module (search is public, no auth needed)
      const result = await sphere.market!.search('goods');
      expect(result.intents).toEqual([]);

      // Verify it was called with correct URL
      const fetchCalls = (globalThis.fetch as any).mock.calls;
      expect(fetchCalls[0][0]).toContain('https://test.market/api/search');

      await sphere.destroy();
    });

    it('should work with browser providers', () => {
      const providers = createBrowserProviders({
        network: 'testnet',
        market: true,
      });

      // All providers should be defined
      expect(providers.storage).toBeDefined();
      expect(providers.transport).toBeDefined();
      expect(providers.oracle).toBeDefined();
      expect(providers.market).toBeDefined();

      // Market should have correct URL
      expect(providers.market?.apiUrl).toBe(DEFAULT_MARKET_API_URL);
    });

    it('should work with node providers', () => {
      const providers = createNodeProviders({
        network: 'testnet',
        dataDir: DATA_DIR,
        tokensDir: TOKENS_DIR,
        market: { apiUrl: 'https://test-node-market.api' },
      });

      // All providers should be defined
      expect(providers.storage).toBeDefined();
      expect(providers.transport).toBeDefined();
      expect(providers.oracle).toBeDefined();
      expect(providers.market).toBeDefined();

      // Market should have custom URL
      expect(providers.market?.apiUrl).toBe('https://test-node-market.api');
    });
  });

  // ---------------------------------------------------------------------------
  // All intent types through Sphere
  // ---------------------------------------------------------------------------

  describe('posting and searching all intent types', () => {
    const ALL_TYPES = ['buy', 'sell', 'service', 'announcement', 'other'] as const;

    for (const intentType of ALL_TYPES) {
      it(`should post a "${intentType}" intent via sphere.market`, async () => {
        // Use URL-based routing so Sphere.init internal calls don't consume market mocks
        const capturedBodies: Record<string, unknown>[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('/api/agent/register')) {
            return new Response(JSON.stringify({ agentId: 1 }), { status: 201 });
          }
          if (url.includes('/api/intents')) {
            if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
            return new Response(JSON.stringify({
              intent_id: `int_${intentType}`,
              message: 'Created',
              expires_at: '2025-12-31',
            }), { status: 201 });
          }
          return new Response(JSON.stringify({}), { status: 200 });
        });

        const { sphere } = await Sphere.init({
          storage: new FileStorageProvider({ dataDir: DATA_DIR }),
          tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
          transport: createMockTransport(),
          oracle: createMockOracle(),
          market: true,
          autoGenerate: true,
        });

        const result = await sphere.market!.postIntent({
          description: `Test ${intentType} intent`,
          intentType,
          category: 'test',
        });

        expect(result.intentId).toBe(`int_${intentType}`);
        expect(capturedBodies.length).toBeGreaterThan(0);
        expect(capturedBodies[0].intent_type).toBe(intentType);

        await sphere.destroy();
      });
    }

    for (const intentType of ALL_TYPES) {
      it(`should search with type filter "${intentType}" via sphere.market`, async () => {
        const capturedBodies: Record<string, unknown>[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url.includes('/api/search')) {
            if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
            return new Response(JSON.stringify({
              intents: [{
                id: 'res_1',
                score: 0.88,
                agent_public_key: '02ab',
                description: `A ${intentType} listing`,
                intent_type: intentType,
                currency: 'UCT',
                contact_method: 'nostr',
                created_at: '2025-01-01',
                expires_at: '2025-12-31',
              }],
            }), { status: 200 });
          }
          return new Response(JSON.stringify({}), { status: 200 });
        });

        const { sphere } = await Sphere.init({
          storage: new FileStorageProvider({ dataDir: DATA_DIR }),
          tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
          transport: createMockTransport(),
          oracle: createMockOracle(),
          market: true,
          autoGenerate: true,
        });

        const result = await sphere.market!.search('test', {
          filters: { intentType },
        });

        expect(result.intents).toHaveLength(1);
        expect(result.intents[0].intentType).toBe(intentType);
        expect(capturedBodies[0].intent_type).toBe(intentType);

        await sphere.destroy();
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Feed methods through Sphere
  // ---------------------------------------------------------------------------

  describe('feed methods through Sphere', () => {
    it('should fetch recent listings via sphere.market.getRecentListings()', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/api/feed/recent')) {
          return new Response(JSON.stringify({
            listings: [
              {
                id: 'lst_1',
                title: 'Test listing',
                description_preview: 'Full description here',
                agent_name: '@seller',
                agent_id: 1,
                type: 'sell',
                created_at: '2026-01-01T00:00:00.000Z',
              },
              {
                id: 'lst_2',
                title: 'Service listing',
                description_preview: 'Service description',
                agent_name: '@provider',
                agent_id: 2,
                type: 'service',
                created_at: '2026-01-01T01:00:00.000Z',
              },
            ],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const { sphere } = await Sphere.init({
        storage: new FileStorageProvider({ dataDir: DATA_DIR }),
        tokenStorage: new FileTokenStorageProvider({ tokensDir: TOKENS_DIR }),
        transport: createMockTransport(),
        oracle: createMockOracle(),
        market: true,
        autoGenerate: true,
      });

      const listings = await sphere.market!.getRecentListings();

      expect(listings).toHaveLength(2);
      expect(listings[0].type).toBe('sell');
      expect(listings[0].descriptionPreview).toBe('Full description here');
      expect(listings[1].type).toBe('service');

      await sphere.destroy();
    });
  });
});
