/**
 * Sphere getStatus() + provider enable/disable + connection:changed bridging.
 * Post-flip: token custody is server-side — status.tokenStorage is always [].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sphere, type SphereInitOptions } from '../../../core/Sphere';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { SphereEventMap } from '../../../types';
import type { PricePlatform, TokenPrice } from '../../../price';
import { makeMockProviders, type MockProviders } from './support/mock-providers';

// #728 single-network invariant: must equal the mock walletApi's network (testnet2).
const TEST_NETWORK = 'testnet2' as const;

describe('Sphere Status & Provider Management', () => {
  let providers: MockProviders;

  beforeEach(() => {
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    providers = makeMockProviders();
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
  });

  async function initSphere(options?: { price?: { platform: PricePlatform } }) {
    const initOpts: SphereInitOptions = {
      storage: providers.storage,
      transport: providers.transport as unknown as TransportProvider,
      oracle: providers.oracle as unknown as OracleProvider,
      walletApi: providers.walletApi,
      network: TEST_NETWORK,
      autoGenerate: true,
    };
    if (options?.price) {
      initOpts.price = {
        platform: options.price.platform,
        getPrices: vi.fn(async (): Promise<Map<string, TokenPrice>> => new Map()),
        getPrice: vi.fn(async (): Promise<TokenPrice | null> => null),
        clearCache: vi.fn(),
      };
    }
    const { sphere } = await Sphere.init(initOpts);
    return sphere;
  }

  // ===========================================================================
  // getStatus()
  // ===========================================================================

  describe('getStatus()', () => {
    it('should return grouped status for all provider roles', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.storage).toBeInstanceOf(Array);
      expect(status.tokenStorage).toBeInstanceOf(Array);
      expect(status.transport).toBeInstanceOf(Array);
      expect(status.oracle).toBeInstanceOf(Array);
      expect(status.price).toBeInstanceOf(Array);
    });

    it('should include storage provider info', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.storage).toHaveLength(1);
      expect(status.storage[0].id).toBe('mock-storage');
      expect(status.storage[0].role).toBe('storage');
      expect(status.storage[0].connected).toBe(true);
      expect(status.storage[0].enabled).toBe(true);
    });

    it('should include transport with relay metadata', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.transport).toHaveLength(1);
      expect(status.transport[0].id).toBe('mock-transport');
      expect(status.transport[0].role).toBe('transport');
      expect(status.transport[0].connected).toBe(true);
      expect(status.transport[0].metadata?.relays).toEqual({ total: 2, connected: 1 });
    });

    it('should include oracle provider info', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.oracle).toHaveLength(1);
      expect(status.oracle[0].id).toBe('mock-oracle');
      expect(status.oracle[0].role).toBe('oracle');
      expect(status.oracle[0].connected).toBe(true);
    });

    it('tokenStorage is always empty — token custody is server-side (wallet-api)', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.tokenStorage).toEqual([]);
    });

    it('should show price as empty when not configured', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.price).toHaveLength(0);
    });

    it('should show status field matching ProviderStatus', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(['connected', 'disconnected', 'connecting', 'error']).toContain(
        status.transport[0].status,
      );
    });
  });

  // ===========================================================================
  // enableProvider / disableProvider
  // ===========================================================================

  describe('disableProvider()', () => {
    it('should throw when trying to disable main storage', async () => {
      const sphere = await initSphere();

      await expect(sphere.disableProvider('mock-storage')).rejects.toThrow(
        'Cannot disable the main storage provider',
      );
    });

    it('should return false for unknown provider', async () => {
      const sphere = await initSphere();

      const result = await sphere.disableProvider('nonexistent');
      expect(result).toBe(false);
    });

    it('should disable transport provider', async () => {
      const sphere = await initSphere();

      const result = await sphere.disableProvider('mock-transport');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('mock-transport')).toBe(false);

      const status = sphere.getStatus();
      expect(status.transport[0].enabled).toBe(false);
    });

    it('should disable oracle provider', async () => {
      const sphere = await initSphere();

      const result = await sphere.disableProvider('mock-oracle');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('mock-oracle')).toBe(false);

      const status = sphere.getStatus();
      expect(status.oracle[0].enabled).toBe(false);
    });
  });

  describe('enableProvider()', () => {
    it('should re-enable transport after disable', async () => {
      const sphere = await initSphere();

      await sphere.disableProvider('mock-transport');
      expect(sphere.isProviderEnabled('mock-transport')).toBe(false);

      const result = await sphere.enableProvider('mock-transport');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('mock-transport')).toBe(true);
    });

    it('should re-enable oracle after disable', async () => {
      const sphere = await initSphere();

      await sphere.disableProvider('mock-oracle');
      const result = await sphere.enableProvider('mock-oracle');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('mock-oracle')).toBe(true);
    });

    it('should return false for unknown provider', async () => {
      const sphere = await initSphere();

      const result = await sphere.enableProvider('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('isProviderEnabled()', () => {
    it('should return true for all providers by default', async () => {
      const sphere = await initSphere();

      expect(sphere.isProviderEnabled('mock-storage')).toBe(true);
      expect(sphere.isProviderEnabled('mock-transport')).toBe(true);
      expect(sphere.isProviderEnabled('mock-oracle')).toBe(true);
    });
  });

  // ===========================================================================
  // connection:changed event bridging
  // ===========================================================================

  describe('connection:changed event bridging', () => {
    it('should emit connection:changed when transport disconnects', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      (providers.transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      providers.transport._simulateEvent({ type: 'transport:disconnected', timestamp: Date.now() });

      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('mock-transport');
      expect(events[0].connected).toBe(false);
      expect(events[0].status).toBe('disconnected');
    });

    it('should emit connection:changed when transport reconnects', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      (providers.transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      providers.transport._simulateEvent({ type: 'transport:disconnected', timestamp: Date.now() });

      (providers.transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      providers.transport._simulateEvent({ type: 'transport:connected', timestamp: Date.now() });

      expect(events).toHaveLength(2);
      expect(events[1].provider).toBe('mock-transport');
      expect(events[1].connected).toBe(true);
      expect(events[1].status).toBe('connected');
    });

    it('should deduplicate events with same connected state', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      providers.transport._simulateEvent({ type: 'transport:connected', timestamp: Date.now() });
      providers.transport._simulateEvent({ type: 'transport:connected', timestamp: Date.now() });

      expect(events).toHaveLength(1);
      expect(events[0].connected).toBe(true);
    });

    it('should bridge oracle events', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      (providers.oracle.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      providers.oracle._simulateEvent({ type: 'oracle:disconnected', timestamp: Date.now() });

      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('mock-oracle');
      expect(events[0].connected).toBe(false);
    });

    it('should clean up event subscriptions on destroy', async () => {
      const sphere = await initSphere();

      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      await sphere.destroy();

      providers.transport._simulateEvent({ type: 'transport:disconnected', timestamp: Date.now() });

      expect(events).toHaveLength(0);
    });

    it('should emit error event from transport', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      providers.transport._simulateEvent({
        type: 'transport:error',
        timestamp: Date.now(),
        error: 'Connection reset',
      });

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('error');
      expect(events[0].error).toBe('Connection reset');
    });

    it('should emit connecting status on reconnecting event', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      providers.transport._simulateEvent({
        type: 'transport:reconnecting',
        timestamp: Date.now(),
      });

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('connecting');
      expect(events[0].connected).toBe(false);
    });
  });

  // ===========================================================================
  // Price provider
  // ===========================================================================

  describe('Price in getStatus()', () => {
    it('should show price provider when configured', async () => {
      const sphere = await initSphere({ price: { platform: 'coingecko' } });
      const status = sphere.getStatus();

      expect(status.price).toHaveLength(1);
      expect(status.price[0].role).toBe('price');
      expect(status.price[0].name).toBe('coingecko');
      expect(status.price[0].connected).toBe(true);
    });
  });

  describe('Price disable/enable', () => {
    it('should disable price provider', async () => {
      const sphere = await initSphere({ price: { platform: 'coingecko' } });
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      const result = await sphere.disableProvider('price');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('price')).toBe(false);

      const status = sphere.getStatus();
      expect(status.price[0].enabled).toBe(false);

      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('price');
      expect(events[0].enabled).toBe(false);
    });

    it('should re-enable price provider', async () => {
      const sphere = await initSphere({ price: { platform: 'coingecko' } });

      await sphere.disableProvider('price');
      const result = await sphere.enableProvider('price');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('price')).toBe(true);

      const status = sphere.getStatus();
      expect(status.price[0].enabled).toBe(true);
    });
  });
});
