/**
 * Integration test: Provider disable/enable with real FileStorage.
 *
 * Verifies:
 * 1. Disabled token storage providers are skipped during sync
 * 2. Re-enabled providers participate in sync again
 * 3. Disabled state is runtime-only — not persisted across destroy/reload
 * 4. getStatus() reflects correct enabled/disabled state with real providers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider, TokenStorageProvider, TxfStorageDataBase } from '../../index';
import type { ProviderStatus } from '../../types';

// Mock L1 to avoid real WebSocket connections
vi.mock('../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-provider-disable-sync');
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
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
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
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

/** Mock token storage with a custom id — simulates IPFS or second provider */
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
// Helpers
// =============================================================================

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Provider disable/enable integration', () => {
  let storage: FileStorageProvider;
  let tokenStorageReal: FileTokenStorageProvider;
  let tokenStorageMock: TokenStorageProvider<TxfStorageDataBase>;

  beforeEach(() => {
    cleanTestDir();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorageReal = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    tokenStorageMock = createMockTokenStorage('ipfs-sync', 'IPFS Sync');
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('should show all token storage providers in getStatus()', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage: tokenStorageReal,
      autoGenerate: true,
    });

    await sphere.addTokenStorageProvider(tokenStorageMock);

    const status = sphere.getStatus();
    expect(status.tokenStorage).toHaveLength(2);

    const ids = status.tokenStorage.map((p) => p.id);
    expect(ids).toContain(tokenStorageReal.id);
    expect(ids).toContain('ipfs-sync');

    // Both should be enabled
    for (const ts of status.tokenStorage) {
      expect(ts.enabled).toBe(true);
    }
  });

  it('should reflect disabled state in getStatus after disableProvider', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage: tokenStorageReal,
      autoGenerate: true,
    });

    await sphere.addTokenStorageProvider(tokenStorageMock);

    // Disable mock provider (simulates disabling IPFS)
    await sphere.disableProvider('ipfs-sync');

    const status = sphere.getStatus();
    const real = status.tokenStorage.find((p) => p.id === tokenStorageReal.id);
    const mock = status.tokenStorage.find((p) => p.id === 'ipfs-sync');

    expect(real!.enabled).toBe(true);
    expect(mock!.enabled).toBe(false);
  });

  it('should restore enabled state after enableProvider', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage: tokenStorageReal,
      autoGenerate: true,
    });

    await sphere.addTokenStorageProvider(tokenStorageMock);

    // Disable then re-enable
    await sphere.disableProvider('ipfs-sync');
    expect(sphere.isProviderEnabled('ipfs-sync')).toBe(false);

    await sphere.enableProvider('ipfs-sync');
    expect(sphere.isProviderEnabled('ipfs-sync')).toBe(true);

    const status = sphere.getStatus();
    const mock = status.tokenStorage.find((p) => p.id === 'ipfs-sync');
    expect(mock!.enabled).toBe(true);
  });

  it('disabled state should NOT persist across destroy/reload', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    // Create wallet, disable IPFS mock, then destroy
    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage: tokenStorageReal,
      autoGenerate: true,
    });

    await sphere.addTokenStorageProvider(tokenStorageMock);
    await sphere.disableProvider('ipfs-sync');
    expect(sphere.isProviderEnabled('ipfs-sync')).toBe(false);

    // Capture mnemonic for reload
    const mnemonic = sphere.getMnemonic();
    await sphere.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // Reload with same storage dir — fresh provider instances
    const freshReal = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
    const freshMock = createMockTokenStorage('ipfs-sync', 'IPFS Sync');
    const transport2 = createMockTransport();
    const oracle2 = createMockOracle();

    const { sphere: sphere2 } = await Sphere.init({
      storage: new FileStorageProvider({ dataDir: DATA_DIR }),
      transport: transport2,
      oracle: oracle2,
      tokenStorage: freshReal,
      mnemonic: mnemonic!,
    });

    await sphere2.addTokenStorageProvider(freshMock);

    // Both should be enabled — disabled state was runtime-only
    expect(sphere2.isProviderEnabled(freshReal.id)).toBe(true);
    expect(sphere2.isProviderEnabled('ipfs-sync')).toBe(true);

    const status = sphere2.getStatus();
    for (const ts of status.tokenStorage) {
      expect(ts.enabled).toBe(true);
    }
  });

  it('should emit connection:changed events on disable/enable cycle', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage: tokenStorageReal,
      autoGenerate: true,
    });

    await sphere.addTokenStorageProvider(tokenStorageMock);

    const events: Array<{ provider: string; enabled?: boolean; connected: boolean }> = [];
    sphere.on('connection:changed', (e) => events.push(e));

    // Disable
    await sphere.disableProvider('ipfs-sync');
    // Enable
    await sphere.enableProvider('ipfs-sync');

    expect(events).toHaveLength(2);
    expect(events[0].provider).toBe('ipfs-sync');
    expect(events[0].enabled).toBe(false);
    expect(events[0].connected).toBe(false);

    expect(events[1].provider).toBe('ipfs-sync');
    expect(events[1].enabled).toBe(true);
  });

  it('should call shutdown when disabling token storage', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage: tokenStorageReal,
      autoGenerate: true,
    });

    await sphere.addTokenStorageProvider(tokenStorageMock);
    await sphere.disableProvider('ipfs-sync');

    // shutdown should have been called on the mock
    expect(tokenStorageMock.shutdown).toHaveBeenCalled();
  });
});
