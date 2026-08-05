/**
 * Integration tests for Sphere.clear() - full wallet lifecycle
 *
 * Simulates realistic scenarios:
 * 1. Create wallet with nametag
 * 2. Derive additional addresses
 * 3. Clear all data (one KV wipe — includes the pv2 scoped KV)
 * 4. Verify everything is wiped
 * 5. Verify new wallet can be created on clean slate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import { vi } from 'vitest';
import { TEST_NETWORK } from '../test-network';
import { makePv2World } from '../support/pv2-world';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-wallet-clear');
const DATA_DIR = path.join(TEST_DIR, 'data');

// =============================================================================
// Mock providers
// =============================================================================

/**
 * Shared Nostr relay state — persists across transport instances (like a real relay).
 * Maps nametag -> chainPubkey of the owner.
 */
const nostrRelayNametags = new Map<string, string>();

function clearNostrRelay(): void {
  nostrRelayNametags.clear();
}

/**
 * Creates a mock transport that simulates real Nostr nametag uniqueness:
 * - registerNametag succeeds only if the nametag is free or owned by the same pubkey
 * - resolveNametag returns the owner's pubkey if registered
 */
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
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn((nametag: string) => {
      return Promise.resolve(nostrRelayNametags.get(nametag) ?? null);
    }),
    publishIdentityBinding: vi.fn((chainPubkey: string, _directAddress: string, nametag?: string) => {
      if (nametag) {
        const existing = nostrRelayNametags.get(nametag);
        if (existing && existing !== chainPubkey) {
          return Promise.resolve(false);
        }
        nostrRelayNametags.set(nametag, chainPubkey);
      }
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
    getTrustBaseJson: () => TRUSTBASE_TESTNET2,
    getAggregatorUrl: () => 'https://gateway.testnet2.unicity.network',
    getApiKey: () => 'test-key',
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

describe('Sphere.clear() integration', () => {
  let storage: FileStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
    clearNostrRelay();
  });

  describe('create wallet, populate data, then clear', () => {
    it('should create wallet and store keys in storage', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet
      const { sphere, created } = await Sphere.init({
        storage,
        transport,
        oracle,
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'alice',
      });

      expect(created).toBe(true);
      expect(sphere.identity).toBeDefined();
      expect(sphere.identity!.nametag).toBe('alice');

      // Verify storage has wallet keys
      const mnemonic = await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC);
      expect(mnemonic).not.toBeNull();

      const walletExists = await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS);
      expect(walletExists).toBeTruthy();

      const trackedJson = await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
      expect(trackedJson).not.toBeNull();

      // Nametags are stored separately in ADDRESS_NAMETAGS cache
      const nametagsJson = await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
      expect(nametagsJson).not.toBeNull();
      const nametagsData = JSON.parse(nametagsJson!);
      const hasNametag = Object.values(nametagsData).some(
        (nametags: unknown) => typeof nametags === 'object' && nametags !== null && Object.values(nametags as Record<string, string>).includes('alice')
      );
      expect(hasNametag).toBe(true);

      await sphere.destroy();
    });

    it('should clear all wallet keys AND the pv2 scoped KV from storage', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'bob',
      });

      // Verify data exists
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).not.toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeTruthy();

      // Seed a pv2 durable-state row the way the vertical writes them.
      const pv2Key = `pv2:testnet2:${sphere.identity!.chainPubkey}:intents`;
      await storage.set(pv2Key, '[]');
      expect(await storage.get(pv2Key)).not.toBeNull();

      await sphere.destroy();

      // Clear everything
      await Sphere.clear({ storage });

      // Verify all wallet keys are gone
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MASTER_KEY)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.CHAIN_CODE)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.DERIVATION_PATH)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.BASE_PATH)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.DERIVATION_MODE)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_SOURCE)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS)).toBeNull();
      // The pv2 scoped KV (durable payments state) is wiped with the KV store.
      expect(await storage.get(pv2Key)).toBeNull();
    });

    it('should allow creating a new wallet after clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create first wallet
      const { sphere: sphere1 } = await Sphere.init({
        storage,
        transport,
        oracle,
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'firstwallet',
      });

      const firstAddress = sphere1.identity!.chainPubkey;
      await sphere1.destroy();

      // Clear
      await Sphere.clear({ storage });

      // Wallet should no longer exist
      expect(await Sphere.exists(storage)).toBe(false);

      // Create second wallet (fresh storage)
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      await storage2.connect();

      const { sphere: sphere2, created } = await Sphere.init({
        storage: storage2,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'secondwallet',
      });

      expect(created).toBe(true);
      expect(sphere2.identity!.nametag).toBe('secondwallet');
      // Different mnemonic = different identity
      expect(sphere2.identity!.chainPubkey).not.toBe(firstAddress);

      await sphere2.destroy();
    });
  });

  describe('wallet with multiple derived addresses', () => {
    it('should clear data for all addresses', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet with nametag on primary address
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'primary',
      });

      // Derive additional addresses
      const addr0 = sphere.deriveAddress(0);
      const addr1 = sphere.deriveAddress(1);
      const addr2 = sphere.deriveAddress(2);

      expect(addr0.publicKey).toBeDefined();
      expect(addr1.publicKey).toBeDefined();
      expect(addr2.publicKey).toBeDefined();

      // All should be different
      expect(addr0.publicKey).not.toBe(addr1.publicKey);
      expect(addr1.publicKey).not.toBe(addr2.publicKey);

      // Verify tracked addresses are stored
      const trackedJson = await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
      expect(trackedJson).not.toBeNull();

      await sphere.destroy();

      // Clear
      await Sphere.clear({ storage });

      // All data should be gone
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES)).toBeNull();
      expect(await Sphere.exists(storage)).toBe(false);
    });
  });

  describe('nametag uniqueness on Nostr after clear', () => {
    it('should preserve nametag on Nostr after local clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'unique-name',
      });

      const ownerPubkey = sphere.identity!.chainPubkey;
      await sphere.destroy();

      // Local clear does NOT unregister the Nostr binding
      await Sphere.clear({ storage });

      expect(nostrRelayNametags.get('unique-name')).toBe(ownerPubkey);
    });

    it('should reject same nametag from a different wallet after clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere: sphere1 } = await Sphere.init({
        storage,
        transport,
        oracle,
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
        nametag: 'contested',
      });
      await sphere1.destroy();

      await Sphere.clear({ storage });

      // A NEW wallet (different mnemonic) cannot take the name — first-seen-wins.
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      const { sphere: sphere2 } = await Sphere.init({
        storage: storage2,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        network: TEST_NETWORK,
        walletApi: makePv2World().walletApi,
        autoGenerate: true,
      });

      await expect(sphere2.registerNametag('contested')).rejects.toThrow();
      expect(sphere2.identity!.nametag).toBeUndefined();

      await sphere2.destroy();
    });
  });
});
