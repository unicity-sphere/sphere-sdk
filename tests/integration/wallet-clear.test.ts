/**
 * Integration tests for Sphere.clear() - full wallet lifecycle
 *
 * Simulates realistic scenarios:
 * 1. Create wallet with nametag + token data
 * 2. Derive additional address with its own nametag
 * 3. Clear all data
 * 4. Verify everything is wiped
 * 5. Verify new wallet can be created on clean slate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { STORAGE_KEYS_GLOBAL, STORAGE_KEYS_ADDRESS } from '../../constants';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus, FullIdentity } from '../../types';
import type { TxfStorageDataBase } from '../../storage';
import { vi } from 'vitest';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-wallet-clear');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

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
    registerNametag: vi.fn((nametag: string, chainPubkey: string) => {
      const existing = nostrRelayNametags.get(nametag);
      if (existing && existing !== chainPubkey) {
        // Nametag taken by another pubkey
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

function getTokenFiles(tokensDir: string): string[] {
  if (!fs.existsSync(tokensDir)) return [];
  const entries: string[] = [];
  // Check base dir
  for (const item of fs.readdirSync(tokensDir)) {
    const fullPath = path.join(tokensDir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      // Per-address subdirectory
      for (const file of fs.readdirSync(fullPath)) {
        if (file.endsWith('.json')) {
          entries.push(path.join(item, file));
        }
      }
    } else if (item.endsWith('.json')) {
      entries.push(item);
    }
  }
  return entries;
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere.clear() integration', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    clearNostrRelay();
    // Reset Sphere singleton
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    // Reset singleton
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
        tokenStorage,
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

      const nametagsJson = await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
      expect(nametagsJson).not.toBeNull();
      const nametagsData = JSON.parse(nametagsJson!);
      // At least one address has a nametag
      const hasNametag = Object.values(nametagsData).some(
        (addrNametags) => Object.values(addrNametags as Record<string, string>).includes('alice')
      );
      expect(hasNametag).toBe(true);

      await sphere.destroy();
    });

    it('should clear all wallet keys from storage', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'bob',
      });

      // Verify data exists
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).not.toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeTruthy();

      await sphere.destroy();

      // Clear everything
      await Sphere.clear({ storage, tokenStorage });

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
      expect(await storage.get(STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBeNull();
    });

    it('should clear token data from token storage', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      // Manually save token data (simulating minted nametag token + received tokens)
      const identity = sphere.identity!;
      tokenStorage.setIdentity(identity as FullIdentity);
      await tokenStorage.initialize();

      await tokenStorage.save({
        _meta: {
          version: 1,
          address: identity.l1Address!,
          formatVersion: '2.0',
          updatedAt: Date.now(),
        },
        _token1: {
          id: 'token1',
          coinId: 'UCT',
          amount: '1000000',
          status: 'confirmed',
        },
        _nametagToken: {
          id: 'nametagToken',
          coinId: 'NAMETAG',
          amount: '1',
          status: 'confirmed',
          nametag: 'alice',
        },
      } as TxfStorageDataBase);

      // Verify tokens actually exist by reading them back
      const token1 = await tokenStorage.getToken('token1');
      expect(token1).not.toBeNull();
      expect((token1 as Record<string, unknown>).coinId).toBe('UCT');
      expect((token1 as Record<string, unknown>).amount).toBe('1000000');

      const nametagToken = await tokenStorage.getToken('nametagToken');
      expect(nametagToken).not.toBeNull();
      expect((nametagToken as Record<string, unknown>).coinId).toBe('NAMETAG');
      expect((nametagToken as Record<string, unknown>).nametag).toBe('alice');

      // Verify via listTokenIds too
      const tokenIdsBefore = await tokenStorage.listTokenIds();
      expect(tokenIdsBefore).toContain('token1');
      expect(tokenIdsBefore).toContain('nametagToken');

      // Verify actual files on disk
      const tokenFilesBefore = getTokenFiles(TOKENS_DIR);
      expect(tokenFilesBefore.length).toBeGreaterThanOrEqual(2);

      await sphere.destroy();

      // Clear everything
      await Sphere.clear({ storage, tokenStorage });

      // Verify tokens are gone - by reading
      const token1After = await tokenStorage.getToken('token1');
      expect(token1After).toBeNull();

      const nametagTokenAfter = await tokenStorage.getToken('nametagToken');
      expect(nametagTokenAfter).toBeNull();

      // Verify via listTokenIds
      const tokenIdsAfter = await tokenStorage.listTokenIds();
      expect(tokenIdsAfter.length).toBe(0);

      // Verify files on disk are gone
      const tokenFilesAfter = getTokenFiles(TOKENS_DIR);
      expect(tokenFilesAfter.length).toBe(0);
    });

    it('should allow creating a new wallet after clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create first wallet
      const { sphere: sphere1 } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'firstwallet',
      });

      const firstAddress = sphere1.identity!.l1Address;
      await sphere1.destroy();

      // Clear
      await Sphere.clear({ storage, tokenStorage });

      // Wallet should no longer exist
      expect(await Sphere.exists(storage)).toBe(false);

      // Create second wallet (fresh storage)
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      await storage2.connect();

      const { sphere: sphere2, created } = await Sphere.init({
        storage: storage2,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        tokenStorage,
        autoGenerate: true,
        nametag: 'secondwallet',
      });

      expect(created).toBe(true);
      expect(sphere2.identity!.nametag).toBe('secondwallet');
      // Different mnemonic = different address
      expect(sphere2.identity!.l1Address).not.toBe(firstAddress);

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
        tokenStorage,
        autoGenerate: true,
        nametag: 'primary',
      });

      // Derive additional addresses
      const addr0 = sphere.deriveAddress(0);
      const addr1 = sphere.deriveAddress(1);
      const addr2 = sphere.deriveAddress(2);

      expect(addr0.address).toBeDefined();
      expect(addr1.address).toBeDefined();
      expect(addr2.address).toBeDefined();

      // All should be different
      expect(addr0.address).not.toBe(addr1.address);
      expect(addr1.address).not.toBe(addr2.address);

      // Verify nametag is stored
      const nametagsJson = await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
      expect(nametagsJson).not.toBeNull();

      await sphere.destroy();

      // Clear
      await Sphere.clear({ storage, tokenStorage });

      // All data should be gone
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS)).toBeNull();
      expect(await Sphere.exists(storage)).toBe(false);
    });
  });

  describe('clear with token storage containing multiple address subdirs', () => {
    it('should clear tokens for the current address', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      const identity = sphere.identity!;
      tokenStorage.setIdentity(identity as FullIdentity);
      await tokenStorage.initialize();

      // Save tokens for current address
      await tokenStorage.saveToken('nametag-alice', { id: 'nametag-alice', type: 'nametag', nametag: 'alice' });
      await tokenStorage.saveToken('token-uct-001', { id: 'token-uct-001', coinId: 'UCT', amount: '5000000' });
      await tokenStorage.saveToken('token-uct-002', { id: 'token-uct-002', coinId: 'UCT', amount: '3000000' });

      // Verify each token exists by reading back
      const nametag = await tokenStorage.getToken('nametag-alice');
      expect(nametag).not.toBeNull();
      expect((nametag as Record<string, unknown>).nametag).toBe('alice');

      const uct1 = await tokenStorage.getToken('token-uct-001');
      expect(uct1).not.toBeNull();
      expect((uct1 as Record<string, unknown>).amount).toBe('5000000');

      const uct2 = await tokenStorage.getToken('token-uct-002');
      expect(uct2).not.toBeNull();
      expect((uct2 as Record<string, unknown>).amount).toBe('3000000');

      const tokenIds = await tokenStorage.listTokenIds();
      expect(tokenIds).toContain('nametag-alice');
      expect(tokenIds).toContain('token-uct-001');
      expect(tokenIds).toContain('token-uct-002');

      await sphere.destroy();

      // Clear
      await Sphere.clear({ storage, tokenStorage });

      // Verify all tokens are gone
      expect(await tokenStorage.getToken('nametag-alice')).toBeNull();
      expect(await tokenStorage.getToken('token-uct-001')).toBeNull();
      expect(await tokenStorage.getToken('token-uct-002')).toBeNull();

      const tokenIdsAfter = await tokenStorage.listTokenIds();
      expect(tokenIdsAfter.length).toBe(0);
    });
  });

  describe('nametag uniqueness on Nostr after clear', () => {
    it('should preserve nametag on Nostr after local clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create wallet and register nametag
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'unique123',
      });

      const ownerPubkey = sphere.identity!.chainPubkey;

      // Nametag is on Nostr
      expect(nostrRelayNametags.get('unique123')).toBe(ownerPubkey);

      await sphere.destroy();

      // Clear local data — Nostr is NOT affected
      await Sphere.clear({ storage, tokenStorage });

      // Local wallet is gone
      expect(await Sphere.exists(storage)).toBe(false);

      // But nametag still lives on Nostr
      expect(nostrRelayNametags.get('unique123')).toBe(ownerPubkey);
    });

    it('should reject same nametag from a different wallet after clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Wallet 1 registers nametag
      const { sphere: sphere1 } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'taken',
      });

      expect(sphere1.identity!.nametag).toBe('taken');
      await sphere1.destroy();

      // Clear local data
      await Sphere.clear({ storage, tokenStorage });

      // Wallet 2 (different mnemonic = different keys) tries the same nametag
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      await storage2.connect();

      // Sphere.init with nametag calls registerNametag internally.
      // Since the nametag is taken by a different pubkey on Nostr,
      // registration fails and Sphere throws.
      await expect(
        Sphere.init({
          storage: storage2,
          transport: createMockTransport(),
          oracle: createMockOracle(),
          tokenStorage,
          autoGenerate: true,
          nametag: 'taken',
        })
      ).rejects.toThrow('Failed to register nametag');

      // Nametag is still owned by wallet 1's pubkey on Nostr
      expect(nostrRelayNametags.has('taken')).toBe(true);
    });

    it('should allow same nametag when re-importing same mnemonic', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Wallet 1 creates and registers nametag
      const { sphere: sphere1 } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'myname',
      });

      const mnemonic = sphere1.getMnemonic()!;
      const originalPubkey = sphere1.identity!.chainPubkey;
      expect(mnemonic).toBeDefined();

      await sphere1.destroy();

      // Clear local data
      await Sphere.clear({ storage, tokenStorage });

      // Re-import same mnemonic — same keys, same pubkey
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      await storage2.connect();

      const sphere2 = await Sphere.import({
        storage: storage2,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        tokenStorage,
        mnemonic,
        nametag: 'myname',
      });

      // Same mnemonic = same pubkey → re-registration succeeds
      expect(sphere2.identity!.chainPubkey).toBe(originalPubkey);
      expect(sphere2.identity!.nametag).toBe('myname');

      await sphere2.destroy();
    });
  });

  describe('backward compatibility', () => {
    it('should work with legacy Sphere.clear(storage) call', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).not.toBeNull();
      await sphere.destroy();

      // Legacy call (no tokenStorage)
      await Sphere.clear(storage);

      // Wallet keys should be gone
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      expect(await Sphere.exists(storage)).toBe(false);
    });
  });
});
