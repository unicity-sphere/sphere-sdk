/**
 * Integration tests for nametag overwrite guard.
 *
 * Verifies that syncIdentityWithTransport() does NOT overwrite an existing
 * identity binding on the relay when the local wallet has lost its nametag.
 *
 * Scenarios:
 * 1. New wallet (no binding on relay) → publishes binding
 * 2. Existing binding on relay WITH nametag, local has nametag → skips publish
 * 3. Existing binding on relay WITH nametag, local lost nametag → recovers + skips publish
 * 4. resolve() throws → skips publish (safe default)
 * 5. Reload after recovery → nametag persists
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../index';
import type { PeerInfo } from '../../transport/transport-provider';
import type { ProviderStatus } from '../../types';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-nametag-overwrite-guard');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Simulated relay state
// =============================================================================

/** Simulates Nostr relay: stores identity bindings keyed by directAddress */
const relayBindings = new Map<string, PeerInfo>();
/** Simulates Nostr relay: stores nametag → chainPubkey mappings */
const relayNametags = new Map<string, string>();

function clearRelay(): void {
  relayBindings.clear();
  relayNametags.clear();
}

// =============================================================================
// Mock providers
// =============================================================================

interface MockTransport extends TransportProvider {
  publishIdentityBinding: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
  recoverNametag: ReturnType<typeof vi.fn>;
}

function createMockTransport(options: {
  resolveThrows?: boolean;
} = {}): MockTransport {
  const transport: MockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport for overwrite guard tests',

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
      return Promise.resolve(relayNametags.get(nametag) ?? null);
    }),

    resolve: options.resolveThrows
      ? vi.fn().mockRejectedValue(new Error('Relay connection lost'))
      : vi.fn((identifier: string) => {
          // Look up by directAddress
          const binding = relayBindings.get(identifier);
          if (binding) return Promise.resolve(binding);
          // Look up by chainPubkey, l1Address, or x-only pubkey (chainPubkey without 02/03 prefix)
          for (const b of relayBindings.values()) {
            if (b.chainPubkey === identifier || b.l1Address === identifier || b.chainPubkey.slice(2) === identifier) {
              return Promise.resolve(b);
            }
          }
          return Promise.resolve(null);
        }),

    publishIdentityBinding: vi.fn((chainPubkey: string, l1Address: string, directAddress: string, nametag?: string) => {
      // Store on relay (simulates what the real relay does)
      relayBindings.set(directAddress, {
        chainPubkey,
        l1Address,
        directAddress,
        transportPubkey: 'transport-' + chainPubkey.slice(0, 8),
        nametag: nametag || undefined,
        timestamp: Date.now(),
      });
      if (nametag) {
        const existing = relayNametags.get(nametag);
        if (existing && existing !== chainPubkey) {
          return Promise.resolve(false);
        }
        relayNametags.set(nametag, chainPubkey);
      }
      return Promise.resolve(true);
    }),

    registerNametag: vi.fn((nametag: string, chainPubkey: string) => {
      const existing = relayNametags.get(nametag);
      if (existing && existing !== chainPubkey) {
        return Promise.resolve(false);
      }
      relayNametags.set(nametag, chainPubkey);
      return Promise.resolve(true);
    }),

    recoverNametag: vi.fn().mockResolvedValue(null),
  } as MockTransport;

  return transport;
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

describe('Nametag overwrite guard (syncIdentityWithTransport)', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    clearRelay();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
    clearRelay();
  });

  it('should publish binding for a brand new wallet (no binding on relay)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere, created } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    expect(created).toBe(true);

    // resolve() was called and returned null → publishIdentityBinding was called
    expect(transport.resolve).toHaveBeenCalled();
    expect(transport.publishIdentityBinding).toHaveBeenCalledTimes(1);

    // Binding now exists on relay without nametag
    const directAddr = sphere.identity!.directAddress!;
    const binding = relayBindings.get(directAddr);
    expect(binding).toBeDefined();
    expect(binding!.nametag).toBeUndefined();

    await sphere.destroy();
  });

  it('should skip publish when binding already exists on relay (with nametag)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    // 1. Create wallet with nametag
    const { sphere: sphere1, created } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
      nametag: 'alice',
    });
    expect(created).toBe(true);

    const directAddr = sphere1.identity!.directAddress!;
    const chainPubkey = sphere1.identity!.chainPubkey;

    // Verify binding on relay has nametag
    const binding = relayBindings.get(directAddr);
    expect(binding).toBeDefined();
    expect(binding!.nametag).toBe('alice');

    await sphere1.destroy();
    (Sphere as unknown as { instance: null }).instance = null;
    transport.publishIdentityBinding.mockClear();
    transport.resolve.mockClear();

    // 2. Reload wallet — should NOT re-publish (binding already exists)
    const sphere2 = await Sphere.load({
      storage,
      transport,
      oracle,
      tokenStorage,
    });

    expect(sphere2.identity!.directAddress).toBe(directAddr);
    expect(sphere2.identity!.chainPubkey).toBe(chainPubkey);

    // Guard: resolve found existing binding → publishIdentityBinding NOT called
    expect(transport.resolve).toHaveBeenCalled();
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Binding on relay still has nametag (not overwritten)
    const bindingAfter = relayBindings.get(directAddr);
    expect(bindingAfter!.nametag).toBe('alice');

    await sphere2.destroy();
  });

  it('should recover nametag from relay when local state lost it', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    // 1. Create wallet with nametag
    const { sphere: sphere1 } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
      nametag: 'bob',
    });

    const directAddr = sphere1.identity!.directAddress!;
    expect(sphere1.identity!.nametag).toBe('bob');

    await sphere1.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // 2. Simulate nametag loss: remove nametag from storage but keep binding on relay
    // Clear nametag from addressNametags in storage
    const keys = await storage.keys('');
    for (const key of keys ?? []) {
      const value = await storage.get(key);
      if (value && value.includes('"bob"') && key.includes('nametag')) {
        await storage.remove(key);
      }
    }

    // Also clear the nametag from identity stored data
    const identityKey = 'sphere_identity';
    const identityJson = await storage.get(identityKey);
    if (identityJson) {
      const identityData = JSON.parse(identityJson);
      delete identityData.nametag;
      await storage.set(identityKey, JSON.stringify(identityData));
    }

    transport.publishIdentityBinding.mockClear();
    transport.resolve.mockClear();

    // 3. Collect events
    const recoveredEvents: Array<{ nametag: string }> = [];

    // 4. Reload wallet — should recover nametag from relay, NOT overwrite
    const sphere2 = await Sphere.load({
      storage,
      transport,
      oracle,
      tokenStorage,
    });

    sphere2.on('nametag:recovered', (data) => {
      recoveredEvents.push(data as { nametag: string });
    });

    // Guard should have:
    // 1. Called resolve(directAddress)
    // 2. Found existing binding with nametag 'bob'
    // 3. Recovered nametag to local state
    // 4. Skipped publishIdentityBinding

    expect(transport.resolve).toHaveBeenCalled();
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    // Nametag recovered to local identity
    expect(sphere2.identity!.nametag).toBe('bob');

    // Binding on relay still intact
    const binding = relayBindings.get(directAddr);
    expect(binding!.nametag).toBe('bob');

    await sphere2.destroy();
  });

  it('should NOT publish when resolve() throws (safe default)', async () => {
    const oracle = createMockOracle();

    // 1. Create wallet first (with working transport)
    const transport1 = createMockTransport();
    const { sphere: sphere1 } = await Sphere.init({
      storage,
      transport: transport1,
      oracle,
      tokenStorage,
      autoGenerate: true,
      nametag: 'carol',
    });

    const directAddr = sphere1.identity!.directAddress!;
    expect(relayBindings.get(directAddr)!.nametag).toBe('carol');

    await sphere1.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // 2. Reload with broken transport (resolve throws)
    const transport2 = createMockTransport({ resolveThrows: true });

    const sphere2 = await Sphere.load({
      storage,
      transport: transport2,
      oracle,
      tokenStorage,
    });

    // resolve() threw → should NOT have called publishIdentityBinding
    expect(transport2.resolve).toHaveBeenCalled();
    expect(transport2.publishIdentityBinding).not.toHaveBeenCalled();

    // Binding on relay untouched (still has 'carol')
    const binding = relayBindings.get(directAddr);
    expect(binding!.nametag).toBe('carol');

    await sphere2.destroy();
  });

  it('should persist recovered nametag across reloads', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    // 1. Create wallet with nametag
    const { sphere: sphere1 } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
      nametag: 'dave',
    });

    expect(sphere1.identity!.nametag).toBe('dave');
    const _directAddr = sphere1.identity!.directAddress!;

    await sphere1.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // 2. Simulate nametag loss in local storage
    const identityKey = 'sphere_identity';
    const identityJson = await storage.get(identityKey);
    if (identityJson) {
      const identityData = JSON.parse(identityJson);
      delete identityData.nametag;
      await storage.set(identityKey, JSON.stringify(identityData));
    }
    // Also clear address nametags
    const keys = await storage.keys('');
    for (const key of keys ?? []) {
      if (key.includes('nametag')) {
        await storage.remove(key);
      }
    }

    // 3. First reload — recovers nametag from relay
    const sphere2 = await Sphere.load({
      storage,
      transport,
      oracle,
      tokenStorage,
    });

    expect(sphere2.identity!.nametag).toBe('dave');

    await sphere2.destroy();
    (Sphere as unknown as { instance: null }).instance = null;
    transport.publishIdentityBinding.mockClear();

    // 4. Second reload — nametag should be in local storage now, no need to recover
    const sphere3 = await Sphere.load({
      storage,
      transport,
      oracle,
      tokenStorage,
    });

    expect(sphere3.identity!.nametag).toBe('dave');
    // Still should not re-publish (binding exists on relay)
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    await sphere3.destroy();
  });

  it('should recover nametag from legacy event format (no content.nametag, only encrypted_nametag)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    // 1. Create wallet with nametag
    const { sphere: sphere1 } = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
      nametag: 'legacy_user',
    });

    expect(sphere1.identity!.nametag).toBe('legacy_user');
    const chainPubkey = sphere1.identity!.chainPubkey;
    const directAddr = sphere1.identity!.directAddress!;

    await sphere1.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // 2. Simulate legacy event format on relay:
    //    - binding exists (found by chainPubkey.slice(2))
    //    - but content.nametag is MISSING (old format only had nametag_hash + encrypted_nametag)
    const legacyBinding = relayBindings.get(directAddr)!;
    relayBindings.set(directAddr, {
      ...legacyBinding,
      nametag: undefined, // old format didn't have plaintext nametag
    });

    // recoverNametag() simulates decrypting encrypted_nametag from the old event
    transport.recoverNametag.mockResolvedValue('legacy_user');

    // 3. Simulate nametag loss in local storage
    const identityKey = 'sphere_identity';
    const identityJson = await storage.get(identityKey);
    if (identityJson) {
      const identityData = JSON.parse(identityJson);
      delete identityData.nametag;
      await storage.set(identityKey, JSON.stringify(identityData));
    }
    const keys = await storage.keys('');
    for (const key of keys ?? []) {
      if (key.includes('nametag')) {
        await storage.remove(key);
      }
    }

    transport.publishIdentityBinding.mockClear();

    // 4. Reload — should find legacy event, recover nametag, and migrate to new format
    const sphere2 = await Sphere.load({
      storage,
      transport,
      oracle,
      tokenStorage,
    });

    // Nametag recovered
    expect(sphere2.identity!.nametag).toBe('legacy_user');

    // recoverNametag was called (fallback for legacy events without content.nametag)
    expect(transport.recoverNametag).toHaveBeenCalled();

    // Re-published in new format (migration)
    expect(transport.publishIdentityBinding).toHaveBeenCalledWith(
      chainPubkey,
      expect.any(String),
      directAddr,
      'legacy_user',
    );

    // Relay binding now has nametag in new format
    const migrated = relayBindings.get(directAddr);
    expect(migrated!.nametag).toBe('legacy_user');

    await sphere2.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // 5. Second reload — should find new-format event, no migration needed
    transport.publishIdentityBinding.mockClear();
    transport.recoverNametag.mockClear();

    const sphere3 = await Sphere.load({
      storage,
      transport,
      oracle,
      tokenStorage,
    });

    expect(sphere3.identity!.nametag).toBe('legacy_user');
    // No re-publish needed (binding already in new format with nametag)
    expect(transport.publishIdentityBinding).not.toHaveBeenCalled();

    await sphere3.destroy();
  });
});
