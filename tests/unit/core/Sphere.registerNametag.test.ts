/**
 * registerNametag is Nostr-binding only (D5): registering a nametag publishes the
 * identity binding (name ↔ chainPubkey); there is NO on-chain nametag token mint.
 * Receive is always SignaturePredicate(chainPubkey). The publish first-seen-wins
 * failure path is the uniqueness guard.
 *
 * (Replaces the obsolete Sphere.mint-before-publish suite, whose mint-then-publish
 * ordering no longer exists.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../../core/Sphere';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../../index';
import type { ProviderStatus } from '../../../types';

const TEST_DIR = path.join(__dirname, '.test-register-nametag');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

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

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('Sphere.registerNametag() — Nostr-binding only (D5, no on-chain mint)', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('registers by publishing the Nostr identity binding, with no on-chain mint', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();
    (oracle.submitCommitment as ReturnType<typeof vi.fn>).mockClear();

    await sphere.registerNametag('alice');

    // Published the binding with the nametag…
    expect(transport.publishIdentityBinding).toHaveBeenCalledWith(
      sphere.identity!.chainPubkey,
      sphere.identity!.l1Address,
      expect.any(String),
      'alice',
    );
    // …updated local state…
    expect(sphere.identity!.nametag).toBe('alice');
    // …and performed NO on-chain mint: registration never touches the aggregator.
    expect(oracle.submitCommitment).not.toHaveBeenCalled();

    await sphere.destroy();
  });

  it('throws when the binding is already taken (publish returns false)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    await expect(sphere.registerNametag('taken')).rejects.toThrow('may already be taken');
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });
});
