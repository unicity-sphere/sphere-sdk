/**
 * Integration tests for tracked addresses feature.
 *
 * Full lifecycle:
 * 1. Create wallet, verify address 0 tracked
 * 2. Switch to addresses 1 and 2, register nametags
 * 3. Read active/all addresses
 * 4. Hide/unhide addresses
 * 5. Destroy and reload — verify persistence
 * 6. Clear wallet — verify cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import { vi } from 'vitest';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-tracked-addresses');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

// =============================================================================
// Mock providers
// =============================================================================

const nostrRelayNametags = new Map<string, string>();

function clearNostrRelay(): void {
  nostrRelayNametags.clear();
}

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

describe('Tracked addresses integration', () => {
  let storage: FileStorageProvider;
  let tokenStorage: FileTokenStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    clearNostrRelay();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
    tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
    clearNostrRelay();
  });

  describe('create wallet, multiple addresses, nametags, hide, clear', () => {
    it('should track address 0 on wallet creation', async () => {
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

      const active = sphere.getActiveAddresses();
      expect(active).toHaveLength(1);
      expect(active[0].index).toBe(0);
      expect(active[0].hidden).toBe(false);
      expect(active[0].l1Address).toBeDefined();
      expect(active[0].directAddress).toBeDefined();
      expect(active[0].chainPubkey).toBeDefined();
      expect(active[0].addressId).toBeDefined();

      await sphere.destroy();
    });

    it('should track address 0 with nametag on creation', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      const active = sphere.getActiveAddresses();
      expect(active).toHaveLength(1);
      expect(active[0].index).toBe(0);
      expect(active[0].nametag).toBe('alice');

      await sphere.destroy();
    });

    it('should track multiple addresses with switchToAddress', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      // Switch to address 1 and register nametag
      await sphere.switchToAddress(1);
      expect(sphere.getCurrentAddressIndex()).toBe(1);
      await sphere.registerNametag('bob');
      expect(sphere.identity!.nametag).toBe('bob');

      // Switch to address 2 — no nametag
      await sphere.switchToAddress(2);
      expect(sphere.getCurrentAddressIndex()).toBe(2);
      expect(sphere.identity!.nametag).toBeUndefined();

      // Check all tracked addresses
      const all = sphere.getAllTrackedAddresses();
      expect(all).toHaveLength(3);
      expect(all[0].index).toBe(0);
      expect(all[1].index).toBe(1);
      expect(all[2].index).toBe(2);

      // Each address has unique addressId, l1Address, directAddress
      const addressIds = all.map(a => a.addressId);
      expect(new Set(addressIds).size).toBe(3);

      const l1Addresses = all.map(a => a.l1Address);
      expect(new Set(l1Addresses).size).toBe(3);

      // Nametag checks
      expect(all[0].nametag).toBe('alice');
      expect(all[1].nametag).toBe('bob');
      expect(all[2].nametag).toBeUndefined();

      await sphere.destroy();
    });

    it('should filter hidden addresses in getActiveAddresses', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      // Create 3 addresses
      await sphere.switchToAddress(1);
      await sphere.registerNametag('bob');
      await sphere.switchToAddress(2);

      // All 3 active
      expect(sphere.getActiveAddresses()).toHaveLength(3);

      // Hide address 1
      await sphere.setAddressHidden(1, true);

      // Active should exclude hidden
      const active = sphere.getActiveAddresses();
      expect(active).toHaveLength(2);
      expect(active.map(a => a.index)).toEqual([0, 2]);

      // All tracked still has 3
      const all = sphere.getAllTrackedAddresses();
      expect(all).toHaveLength(3);
      expect(all[1].hidden).toBe(true);
      expect(all[1].nametag).toBe('bob'); // nametag preserved

      // Unhide address 1
      await sphere.setAddressHidden(1, false);
      const activeAgain = sphere.getActiveAddresses();
      expect(activeAgain).toHaveLength(3);
      expect(activeAgain[1].hidden).toBe(false);

      await sphere.destroy();
    });

    it('should throw when hiding untracked address', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      // Address 5 has never been switched to
      await expect(sphere.setAddressHidden(5, true)).rejects.toThrow(
        'not tracked'
      );

      await sphere.destroy();
    });

    it('should return correct TrackedAddress from getTrackedAddress', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      await sphere.switchToAddress(1);

      const addr0 = sphere.getTrackedAddress(0);
      expect(addr0).toBeDefined();
      expect(addr0!.index).toBe(0);
      expect(addr0!.nametag).toBe('alice');

      const addr1 = sphere.getTrackedAddress(1);
      expect(addr1).toBeDefined();
      expect(addr1!.index).toBe(1);
      expect(addr1!.nametag).toBeUndefined();

      // Untracked index returns undefined
      expect(sphere.getTrackedAddress(99)).toBeUndefined();

      await sphere.destroy();
    });

    it('should persist tracked addresses and reload on wallet load', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // --- Create wallet with multiple addresses ---
      const { sphere, generatedMnemonic } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      await sphere.switchToAddress(1);
      await sphere.registerNametag('bob');
      await sphere.switchToAddress(2);

      // Hide address 2
      await sphere.setAddressHidden(2, true);

      // Capture expected data before destroy
      const allBefore = sphere.getAllTrackedAddresses();
      expect(allBefore).toHaveLength(3);
      expect(allBefore[2].hidden).toBe(true);

      await sphere.destroy();

      // --- Reload wallet from same storage ---
      (Sphere as unknown as { instance: null }).instance = null;
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage2 = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
      const transport2 = createMockTransport();
      const oracle2 = createMockOracle();

      const { sphere: reloaded, created: wasCreated } = await Sphere.init({
        storage: storage2,
        transport: transport2,
        oracle: oracle2,
        tokenStorage: tokenStorage2,
      });

      expect(wasCreated).toBeFalsy();

      // Verify all 3 addresses restored
      const allAfter = reloaded.getAllTrackedAddresses();
      expect(allAfter).toHaveLength(3);

      // Verify indices
      expect(allAfter.map(a => a.index)).toEqual([0, 1, 2]);

      // Verify derived fields are computed
      for (const addr of allAfter) {
        expect(addr.l1Address).toBeDefined();
        expect(addr.l1Address.startsWith('alpha1')).toBe(true);
        expect(addr.directAddress).toBeDefined();
        expect(addr.directAddress.startsWith('DIRECT://')).toBe(true);
        expect(addr.chainPubkey).toBeDefined();
        expect(addr.addressId).toBeDefined();
      }

      // Verify hidden state persisted
      expect(allAfter[2].hidden).toBe(true);

      // Active addresses exclude hidden
      const activeAfter = reloaded.getActiveAddresses();
      expect(activeAfter).toHaveLength(2);
      expect(activeAfter.map(a => a.index)).toEqual([0, 1]);

      // Verify nametags restored from cache
      expect(allAfter[0].nametag).toBe('alice');
      expect(allAfter[1].nametag).toBe('bob');
      expect(allAfter[2].nametag).toBeUndefined();

      // Verify addressIds match between sessions
      for (let i = 0; i < 3; i++) {
        expect(allAfter[i].addressId).toBe(allBefore[i].addressId);
        expect(allAfter[i].l1Address).toBe(allBefore[i].l1Address);
      }

      await reloaded.destroy();
    });

    it('should persist tracked addresses in storage as minimal entries', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      await sphere.switchToAddress(1);

      // Read raw storage
      const raw = await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);

      expect(parsed.version).toBe(1);
      expect(parsed.addresses).toHaveLength(2);

      // Each entry has only minimal fields (no l1Address, directAddress, chainPubkey)
      for (const entry of parsed.addresses) {
        expect(entry).toHaveProperty('index');
        expect(entry).toHaveProperty('hidden');
        expect(entry).toHaveProperty('createdAt');
        expect(entry).toHaveProperty('updatedAt');
        expect(entry).not.toHaveProperty('l1Address');
        expect(entry).not.toHaveProperty('directAddress');
        expect(entry).not.toHaveProperty('chainPubkey');
        expect(entry).not.toHaveProperty('addressId');
        expect(entry).not.toHaveProperty('nametag');
      }

      await sphere.destroy();
    });

    it('should store nametags separately from tracked addresses', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      await sphere.switchToAddress(1);
      await sphere.registerNametag('bob');

      // Nametags stored in ADDRESS_NAMETAGS key
      const nametagsRaw = await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
      expect(nametagsRaw).not.toBeNull();
      const nametags = JSON.parse(nametagsRaw!);

      // Should have 2 address entries with nametags
      const entries = Object.entries(nametags);
      expect(entries).toHaveLength(2);

      // Each entry: { addressId: { "0": "nametag" } }
      const allNametags = Object.values(nametags).flatMap(
        (v) => Object.values(v as Record<string, string>)
      );
      expect(allNametags).toContain('alice');
      expect(allNametags).toContain('bob');

      // Tracked addresses do NOT have nametag fields
      const trackedRaw = await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
      const tracked = JSON.parse(trackedRaw!);
      for (const entry of tracked.addresses) {
        expect(entry).not.toHaveProperty('nametag');
        expect(entry).not.toHaveProperty('nametags');
      }

      await sphere.destroy();
    });

    it('should clear tracked addresses and nametags on Sphere.clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      await sphere.switchToAddress(1);
      await sphere.registerNametag('bob');

      // Verify data exists
      expect(await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES)).not.toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS)).not.toBeNull();

      await sphere.destroy();
      (Sphere as unknown as { instance: null }).instance = null;

      // Clear wallet
      await Sphere.clear({ storage, tokenStorage });

      // All wallet data removed
      expect(await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();

      // Wallet no longer exists
      expect(await Sphere.exists(storage)).toBe(false);
    });

    it('should create fresh wallet after clear', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      // Create first wallet
      const { sphere: first } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      await first.switchToAddress(1);
      await first.registerNametag('bob');
      await first.setAddressHidden(1, true);

      const firstAddresses = first.getAllTrackedAddresses();
      await first.destroy();
      (Sphere as unknown as { instance: null }).instance = null;

      // Clear
      await Sphere.clear({ storage, tokenStorage });

      // Create second wallet on same storage
      const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
      const tokenStorage2 = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });

      const { sphere: second, created } = await Sphere.init({
        storage: storage2,
        transport: createMockTransport(),
        oracle: createMockOracle(),
        tokenStorage: tokenStorage2,
        autoGenerate: true,
      });

      expect(created).toBe(true);

      // Fresh wallet — only address 0, no nametag, no hidden
      const secondAddresses = second.getActiveAddresses();
      expect(secondAddresses).toHaveLength(1);
      expect(secondAddresses[0].index).toBe(0);
      expect(secondAddresses[0].nametag).toBeUndefined();
      expect(secondAddresses[0].hidden).toBe(false);

      // Different identity from first wallet
      expect(secondAddresses[0].l1Address).not.toBe(firstAddresses[0].l1Address);

      await second.destroy();
    });

    it('should support nametag getters from _addressNametags', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
        nametag: 'alice',
      });

      await sphere.switchToAddress(1);
      await sphere.registerNametag('bob');

      // getNametagForAddress — current address
      await sphere.switchToAddress(0);
      expect(sphere.getNametagForAddress()).toBe('alice');

      await sphere.switchToAddress(1);
      expect(sphere.getNametagForAddress()).toBe('bob');

      await sphere.switchToAddress(2);
      expect(sphere.getNametagForAddress()).toBeUndefined();

      // getNametagForAddress — by addressId
      const all = sphere.getAllTrackedAddresses();
      expect(sphere.getNametagForAddress(all[0].addressId)).toBe('alice');
      expect(sphere.getNametagForAddress(all[1].addressId)).toBe('bob');

      // getAllAddressNametags
      const allNametags = sphere.getAllAddressNametags();
      expect(allNametags.size).toBe(2);
      expect(allNametags.get(all[0].addressId)?.get(0)).toBe('alice');
      expect(allNametags.get(all[1].addressId)?.get(0)).toBe('bob');

      await sphere.destroy();
    });

    it('should emit address:activated event on new address tracking', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      const activatedEvents: unknown[] = [];
      sphere.on('address:activated', (data) => {
        activatedEvents.push(data);
      });

      await sphere.switchToAddress(1);

      expect(activatedEvents).toHaveLength(1);
      const event = activatedEvents[0] as { address: { index: number; addressId: string } };
      expect(event.address.index).toBe(1);
      expect(event.address.addressId).toBeDefined();

      // Switching to already tracked address does NOT re-emit
      await sphere.switchToAddress(0);
      expect(activatedEvents).toHaveLength(1);

      await sphere.destroy();
    });

    it('should emit address:hidden and address:unhidden events', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      await sphere.switchToAddress(1);

      const hiddenEvents: unknown[] = [];
      const unhiddenEvents: unknown[] = [];

      sphere.on('address:hidden', (data) => hiddenEvents.push(data));
      sphere.on('address:unhidden', (data) => unhiddenEvents.push(data));

      await sphere.setAddressHidden(1, true);
      expect(hiddenEvents).toHaveLength(1);
      expect((hiddenEvents[0] as { index: number }).index).toBe(1);

      await sphere.setAddressHidden(1, false);
      expect(unhiddenEvents).toHaveLength(1);
      expect((unhiddenEvents[0] as { index: number }).index).toBe(1);

      // No-op when state unchanged
      await sphere.setAddressHidden(1, false);
      expect(unhiddenEvents).toHaveLength(1); // still 1

      await sphere.destroy();
    });

    it('should have createdAt and updatedAt timestamps', async () => {
      const transport = createMockTransport();
      const oracle = createMockOracle();

      const before = Date.now();

      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        tokenStorage,
        autoGenerate: true,
      });

      const after = Date.now();

      const addr0 = sphere.getTrackedAddress(0);
      expect(addr0!.createdAt).toBeGreaterThanOrEqual(before);
      expect(addr0!.createdAt).toBeLessThanOrEqual(after);
      expect(addr0!.updatedAt).toBeGreaterThanOrEqual(before);

      await sphere.destroy();
    });
  });
});
