/**
 * Integration tests for nametag normalization and validation.
 *
 * Verifies that:
 * - Uppercase input is normalized to lowercase before registration
 * - @unicity suffix is stripped
 * - Invalid nametags are rejected with proper error messages
 * - switchToAddress normalizes nametags too
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import { vi } from 'vitest';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-nametag-normalization');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Mock providers
// =============================================================================

const nostrRelayNametags = new Map<string, string>();

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
    resolveNametag: vi.fn((nametag: string) => {
      return Promise.resolve(nostrRelayNametags.get(nametag) ?? null);
    }),
    publishIdentityBinding: vi.fn((chainPubkey: string, _l1Address: string, _directAddress: string, nametag?: string) => {
      if (nametag) {
        const existing = nostrRelayNametags.get(nametag);
        if (existing && existing !== chainPubkey) {
          return Promise.resolve(false);
        }
        nostrRelayNametags.set(nametag, chainPubkey);
      }
      return Promise.resolve(true);
    }),
    registerNametag: vi.fn((nametag: string, chainPubkey: string) => {
      const existing = nostrRelayNametags.get(nametag);
      if (existing && existing !== chainPubkey) {
        return Promise.resolve(false);
      }
      nostrRelayNametags.set(nametag, chainPubkey);
      return Promise.resolve(true);
    }),
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
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    mintToken: vi.fn().mockResolvedValue({ success: true, token: { id: 'mock-token' } }),
  } as unknown as OracleProvider;
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

describe('Nametag normalization integration', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    nostrRelayNametags.clear();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
    nostrRelayNametags.clear();
  });

  it('should normalize uppercase nametag to lowercase on registerNametag', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await sphere.registerNametag('Alice');

    // Identity should have the lowercased nametag
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });

  it('should normalize uppercase nametag on Sphere.init with nametag option', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
      nametag: 'BOB',
    });

    expect(sphere.identity!.nametag).toBe('bob');

    await sphere.destroy();
  });

  it('should strip @unicity suffix during registerNametag', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await sphere.registerNametag('carol@unicity');

    expect(sphere.identity!.nametag).toBe('carol');

    await sphere.destroy();
  });

  it('should reject too-short nametag', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await expect(sphere.registerNametag('ab')).rejects.toThrow('Invalid Unicity ID format');

    await sphere.destroy();
  });

  it('should reject nametag with spaces', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await expect(sphere.registerNametag('hello world')).rejects.toThrow('Invalid Unicity ID format');

    await sphere.destroy();
  });

  it('should normalize nametag in switchToAddress', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await sphere.switchToAddress(1, { nametag: 'Dave' });

    expect(sphere.identity!.nametag).toBe('dave');

    await sphere.destroy();
  });

  it('should reject invalid nametag in switchToAddress', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await expect(
      sphere.switchToAddress(1, { nametag: 'x' })
    ).rejects.toThrow('Invalid Unicity ID format');

    await sphere.destroy();
  });
});
