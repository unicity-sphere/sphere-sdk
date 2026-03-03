/**
 * Tests for mint-before-publish ordering in registerNametag.
 *
 * Verifies that:
 * 1. Minting happens BEFORE publishing to Nostr
 * 2. If minting fails, nothing is published (no unbacked nametag claims)
 * 3. If minting succeeds but publishing fails, the error is surfaced
 * 4. If minting succeeds and publishing succeeds, local state is updated
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../../core/Sphere';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../../index';
import type { ProviderStatus } from '../../../types';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-mint-before-publish');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Call order tracker
// =============================================================================

const callOrder: string[] = [];

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
    publishIdentityBinding: vi.fn().mockImplementation(() => {
      callOrder.push('publish');
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

describe('Sphere.registerNametag() mint-before-publish ordering', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;
  let mintSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cleanTestDir();
    callOrder.length = 0;
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    mintSpy?.mockRestore();
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('should mint on-chain BEFORE publishing to Nostr', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    mintSpy = vi.spyOn(
      Sphere.prototype as unknown as { mintNametag: () => Promise<unknown> },
      'mintNametag',
    ).mockImplementation(() => {
      callOrder.push('mint');
      return Promise.resolve({ success: true, token: null, nametagData: null });
    });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // Reset call order after init (init publishes identity binding without nametag)
    callOrder.length = 0;

    await sphere.registerNametag('alice');

    // Verify ordering: mint must come before publish
    expect(callOrder).toEqual(['mint', 'publish']);

    await sphere.destroy();
  });

  it('should NOT publish to Nostr when minting fails', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    mintSpy = vi.spyOn(
      Sphere.prototype as unknown as { mintNametag: () => Promise<unknown> },
      'mintNametag',
    ).mockImplementation(() => {
      callOrder.push('mint');
      return Promise.resolve({ success: false, error: 'Aggregator rejected' });
    });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // Reset after init
    callOrder.length = 0;
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();

    await expect(sphere.registerNametag('alice')).rejects.toThrow('Failed to mint nametag token');

    // Mint was called, but publish was NOT
    expect(callOrder).toEqual(['mint']);
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Local state should NOT have the nametag
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('should throw when publishing to Nostr fails (nametag taken)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    mintSpy = vi.spyOn(
      Sphere.prototype as unknown as { mintNametag: () => Promise<unknown> },
      'mintNametag',
    ).mockResolvedValue({ success: true, token: null, nametagData: null });

    // publishIdentityBinding returns false (nametag taken by another pubkey)
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await expect(sphere.registerNametag('taken')).rejects.toThrow('may already be taken');

    // Local state should NOT have the nametag
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('should update local state only after both mint and publish succeed', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    mintSpy = vi.spyOn(
      Sphere.prototype as unknown as { mintNametag: () => Promise<unknown> },
      'mintNametag',
    ).mockResolvedValue({ success: true, token: null, nametagData: null });

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.registerNametag('alice');

    // Now local state should have the nametag
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });
});
