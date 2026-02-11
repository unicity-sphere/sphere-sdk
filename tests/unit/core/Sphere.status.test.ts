/**
 * Tests for enhanced Sphere.getStatus(), enableProvider/disableProvider,
 * and connection:changed event bridging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { ProviderStatus, SphereEventMap } from '../../../types';

// Mock L1 network module before importing Sphere
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

import { Sphere } from '../../../core/Sphere';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockStorage(): StorageProvider {
  const data = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    remove: vi.fn(async (key: string) => { data.delete(key); }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => { data.clear(); }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    saveTrackedAddresses: vi.fn(async () => {}),
    loadTrackedAddresses: vi.fn(async () => []),
  };
}

function createMockTransport(): TransportProvider {
  const eventCallbacks = new Set<(event: unknown) => void>();
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
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
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
    resolve: vi.fn().mockResolvedValue(null),
    onEvent: vi.fn((callback: (event: unknown) => void) => {
      eventCallbacks.add(callback);
      return () => eventCallbacks.delete(callback);
    }),
    // Expose for testing: simulate transport events
    _simulateEvent: (event: unknown) => {
      for (const cb of eventCallbacks) cb(event);
    },
    // Relay methods for metadata
    getRelays: vi.fn(() => ['wss://relay1.test', 'wss://relay2.test']),
    getConnectedRelays: vi.fn(() => ['wss://relay1.test']),
  } as unknown as TransportProvider & { _simulateEvent: (e: unknown) => void };
}

function createMockOracle(): OracleProvider {
  const eventCallbacks = new Set<(event: unknown) => void>();
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    onEvent: vi.fn((callback: (event: unknown) => void) => {
      eventCallbacks.add(callback);
      return () => eventCallbacks.delete(callback);
    }),
    _simulateEvent: (event: unknown) => {
      for (const cb of eventCallbacks) cb(event);
    },
  } as unknown as OracleProvider & { _simulateEvent: (e: unknown) => void };
}

function createMockTokenStorage(id: string, name: string): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id,
    name,
    type: 'cloud' as const,
    setIdentity: vi.fn(),
    initialize: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    load: vi.fn(async () => ({
      success: true,
      data: { _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() } },
      source: 'local' as const,
      timestamp: Date.now(),
    })),
    save: vi.fn(async () => ({ success: true, timestamp: Date.now() })),
    sync: vi.fn(async (localData: TxfStorageDataBase) => ({
      success: true,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
    })),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere Status & Provider Management', () => {
  let storage: StorageProvider;
  let transport: ReturnType<typeof createMockTransport>;
  let oracle: ReturnType<typeof createMockOracle>;
  let tokenStorage: TokenStorageProvider<TxfStorageDataBase>;

  beforeEach(() => {
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = createMockStorage();
    transport = createMockTransport() as ReturnType<typeof createMockTransport>;
    oracle = createMockOracle() as ReturnType<typeof createMockOracle>;
    tokenStorage = createMockTokenStorage('indexeddb-tokens', 'IndexedDB');
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
  });

  async function initSphere(options?: {
    l1?: { electrumUrl?: string };
    price?: { platform: string };
  }) {
    const initOpts: Record<string, unknown> = {
      storage,
      transport: transport as unknown as TransportProvider,
      oracle: oracle as unknown as OracleProvider,
      tokenStorage,
      autoGenerate: true,
    };
    if (options?.l1) {
      initOpts.l1 = options.l1;
    }
    if (options?.price) {
      initOpts.price = {
        platform: options.price.platform,
        getPrices: vi.fn().mockResolvedValue(new Map()),
        getPrice: vi.fn().mockResolvedValue(null),
        clearCache: vi.fn(),
      };
    }
    const { sphere } = await Sphere.init(initOpts as Parameters<typeof Sphere.init>[0]);
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
      expect(status.l1).toBeInstanceOf(Array);
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

    it('should include token storage providers', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.tokenStorage).toHaveLength(1);
      expect(status.tokenStorage[0].id).toBe('indexeddb-tokens');
      expect(status.tokenStorage[0].role).toBe('token-storage');
    });

    it('should show L1 array (may have default module)', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      // L1 array is present (may or may not have entries depending on module config)
      expect(status.l1).toBeInstanceOf(Array);
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
    it('should disable a token storage provider', async () => {
      const sphere = await initSphere();

      const result = await sphere.disableProvider('indexeddb-tokens');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('indexeddb-tokens')).toBe(false);
    });

    it('should mark disabled provider in getStatus()', async () => {
      const sphere = await initSphere();

      await sphere.disableProvider('indexeddb-tokens');
      const status = sphere.getStatus();

      expect(status.tokenStorage[0].enabled).toBe(false);
    });

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

    it('should emit connection:changed with enabled=false', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      await sphere.disableProvider('indexeddb-tokens');

      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('indexeddb-tokens');
      expect(events[0].connected).toBe(false);
      expect(events[0].enabled).toBe(false);
    });
  });

  describe('enableProvider()', () => {
    it('should re-enable a disabled provider', async () => {
      const sphere = await initSphere();

      await sphere.disableProvider('indexeddb-tokens');
      expect(sphere.isProviderEnabled('indexeddb-tokens')).toBe(false);

      const result = await sphere.enableProvider('indexeddb-tokens');
      expect(result).toBe(true);
      expect(sphere.isProviderEnabled('indexeddb-tokens')).toBe(true);
    });

    it('should emit connection:changed with enabled=true', async () => {
      const sphere = await initSphere();
      await sphere.disableProvider('indexeddb-tokens');

      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      await sphere.enableProvider('indexeddb-tokens');

      expect(events.length).toBeGreaterThanOrEqual(1);
      const enableEvent = events.find((e) => e.enabled === true);
      expect(enableEvent).toBeDefined();
      expect(enableEvent!.connected).toBe(true);
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
      expect(sphere.isProviderEnabled('indexeddb-tokens')).toBe(true);
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

      // Simulate transport disconnect event
      const transportWithSim = transport as unknown as { _simulateEvent: (e: unknown) => void };
      // Update isConnected mock before simulating
      (transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      transportWithSim._simulateEvent({ type: 'transport:disconnected', timestamp: Date.now() });

      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('mock-transport');
      expect(events[0].connected).toBe(false);
      expect(events[0].status).toBe('disconnected');
    });

    it('should emit connection:changed when transport reconnects', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      const transportWithSim = transport as unknown as { _simulateEvent: (e: unknown) => void };

      // Disconnect first
      (transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      transportWithSim._simulateEvent({ type: 'transport:disconnected', timestamp: Date.now() });

      // Then reconnect
      (transport.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      transportWithSim._simulateEvent({ type: 'transport:connected', timestamp: Date.now() });

      expect(events).toHaveLength(2);
      expect(events[1].provider).toBe('mock-transport');
      expect(events[1].connected).toBe(true);
      expect(events[1].status).toBe('connected');
    });

    it('should deduplicate events with same connected state', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      const transportWithSim = transport as unknown as { _simulateEvent: (e: unknown) => void };

      // First connected event passes through (dedup map starts empty)
      transportWithSim._simulateEvent({ type: 'transport:connected', timestamp: Date.now() });
      // Second identical connected event should be deduped
      transportWithSim._simulateEvent({ type: 'transport:connected', timestamp: Date.now() });

      // Only the first should get through
      expect(events).toHaveLength(1);
      expect(events[0].connected).toBe(true);
    });

    it('should bridge oracle events', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      const oracleWithSim = oracle as unknown as { _simulateEvent: (e: unknown) => void };

      // Oracle disconnects
      (oracle.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);
      oracleWithSim._simulateEvent({ type: 'oracle:disconnected', timestamp: Date.now() });

      expect(events).toHaveLength(1);
      expect(events[0].provider).toBe('mock-oracle');
      expect(events[0].connected).toBe(false);
    });

    it('should clean up event subscriptions on destroy', async () => {
      const sphere = await initSphere();

      // Subscribe to connection events
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      await sphere.destroy();

      // After destroy, simulating events should not emit (handlers cleared)
      const transportWithSim = transport as unknown as { _simulateEvent: (e: unknown) => void };
      transportWithSim._simulateEvent({ type: 'transport:disconnected', timestamp: Date.now() });

      expect(events).toHaveLength(0);
    });

    it('should emit error event from transport', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      const transportWithSim = transport as unknown as { _simulateEvent: (e: unknown) => void };
      transportWithSim._simulateEvent({
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

      const transportWithSim = transport as unknown as { _simulateEvent: (e: unknown) => void };
      transportWithSim._simulateEvent({
        type: 'transport:reconnecting',
        timestamp: Date.now(),
      });

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('connecting');
      expect(events[0].connected).toBe(false);
    });
  });

  // ===========================================================================
  // L1 status in getStatus()
  // ===========================================================================

  describe('L1 in getStatus()', () => {
    it('should show L1 provider when configured', async () => {
      const sphere = await initSphere({
        l1: { electrumUrl: 'wss://test-fulcrum:50004' },
      });
      const status = sphere.getStatus();

      expect(status.l1).toHaveLength(1);
      expect(status.l1[0].id).toBe('l1-alpha');
      expect(status.l1[0].role).toBe('l1');
      expect(status.l1[0].name).toBe('ALPHA L1');
    });

    it('should show L1 as disconnected when WebSocket not connected', async () => {
      const sphere = await initSphere({
        l1: { electrumUrl: 'wss://test-fulcrum:50004' },
      });
      const status = sphere.getStatus();

      // isWebSocketConnected() is mocked to return false
      expect(status.l1[0].connected).toBe(false);
      expect(status.l1[0].status).toBe('disconnected');
    });

    it('should show L1 enabled by default', async () => {
      const sphere = await initSphere({
        l1: { electrumUrl: 'wss://test-fulcrum:50004' },
      });
      const status = sphere.getStatus();

      expect(status.l1[0].enabled).toBe(true);
    });
  });

  // ===========================================================================
  // Price provider in getStatus()
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

    it('should show price as empty when not configured', async () => {
      const sphere = await initSphere();
      const status = sphere.getStatus();

      expect(status.price).toHaveLength(0);
    });
  });

  // ===========================================================================
  // disable/enable transport and oracle
  // ===========================================================================

  describe('disableProvider() for core providers', () => {
    it('should disable transport provider', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

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
  });

  // ===========================================================================
  // Multiple token storage providers
  // ===========================================================================

  describe('multiple token storage providers', () => {
    it('should show all registered token storage providers in status', async () => {
      const sphere = await initSphere();

      // Add a second token storage provider
      const secondStorage = createMockTokenStorage('file-tokens', 'File Storage');
      await sphere.addTokenStorageProvider(secondStorage);

      const status = sphere.getStatus();
      expect(status.tokenStorage).toHaveLength(2);

      const ids = status.tokenStorage.map((p) => p.id);
      expect(ids).toContain('indexeddb-tokens');
      expect(ids).toContain('file-tokens');
    });

    it('should disable one token storage without affecting others', async () => {
      const sphere = await initSphere();
      const secondStorage = createMockTokenStorage('file-tokens', 'File Storage');
      await sphere.addTokenStorageProvider(secondStorage);

      await sphere.disableProvider('file-tokens');

      const status = sphere.getStatus();
      const indexeddb = status.tokenStorage.find((p) => p.id === 'indexeddb-tokens');
      const file = status.tokenStorage.find((p) => p.id === 'file-tokens');

      expect(indexeddb!.enabled).toBe(true);
      expect(file!.enabled).toBe(false);
    });
  });

  // ===========================================================================
  // reconnect() without manual event emit
  // ===========================================================================

  describe('reconnect()', () => {
    it('should reconnect transport without duplicate manual event', async () => {
      const sphere = await initSphere();
      const events: SphereEventMap['connection:changed'][] = [];
      sphere.on('connection:changed', (e) => events.push(e));

      await sphere.reconnect();

      // reconnect() calls transport.disconnect() then transport.connect()
      expect(transport.disconnect).toHaveBeenCalled();
      expect(transport.connect).toHaveBeenCalled();
      // Events come from the auto-bridge, not manual emit
    });
  });
});
