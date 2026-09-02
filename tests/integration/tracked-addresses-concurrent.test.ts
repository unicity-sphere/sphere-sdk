/**
 * Integration tests for the `tracked_addresses` LOST UPDATE (#766 item 5).
 *
 * Each Sphere loads its own snapshot of the tracked-address registry into
 * `_trackedAddresses`, and every persist used to write that snapshot WHOLESALE.
 * Two Spheres over one storage therefore clobber each other:
 *
 *   A.switchToAddress(1) -> disk [0,1]
 *   B.switchToAddress(2) -> disk [0,2]      <- A's entry erased, while A's
 *                                              getActiveAddresses() still reports it
 *
 * This is a lost update, not a network-scoping problem: it reproduces on ONE
 * network with ONE storage provider. The fix is read-merge-write inside
 * `saveTrackedAddresses`, serialized per provider instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus, TrackedAddressEntry } from '../../types';
import { TEST_NETWORK } from '../test-network';
import { makePv2World } from '../support/pv2-world';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import { mergeTrackedAddresses, parseTrackedAddresses } from '../../storage/tracked-addresses';

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-tracked-addresses-concurrent');
const DATA_DIR = path.join(TEST_DIR, 'data');

// =============================================================================
// Mock providers (same shape as tests/integration/tracked-addresses.test.ts)
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
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolveNametag: vi.fn((nametag: string) => {
      return Promise.resolve(nostrRelayNametags.get(nametag) ?? null);
    }),
    publishIdentityBinding: vi.fn((chainPubkey: string, _directAddress: string, nametag?: string) => {
      if (nametag) {
        const existing = nostrRelayNametags.get(nametag);
        if (existing && existing !== chainPubkey) return Promise.resolve(false);
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

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

async function readPersistedIndices(storage: FileStorageProvider): Promise<number[]> {
  const raw = await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
  expect(raw).not.toBeNull();
  const parsed = JSON.parse(raw!) as { version: number; addresses: TrackedAddressEntry[] };
  return parsed.addresses.map((a) => a.index);
}

// =============================================================================
// Tests
// =============================================================================

describe('Tracked addresses — concurrent Spheres (#766 item 5)', () => {
  let storage: FileStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    nostrRelayNametags.clear();
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
  });

  afterEach(() => {
    cleanTestDir();
    nostrRelayNametags.clear();
  });

  it('does not lose A\'s address when B persists its own stale snapshot', async () => {
    // --- A creates the wallet on this storage ---
    const { sphere: a } = await Sphere.init({
      storage,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      network: TEST_NETWORK,
      walletApi: makePv2World().walletApi,
      autoGenerate: true,
    });

    // --- B loads the SAME wallet over the SAME storage provider ---
    const { sphere: b, created } = await Sphere.init({
      storage,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      network: TEST_NETWORK,
      walletApi: makePv2World().walletApi,
    });
    expect(created).toBeFalsy();

    // Both hold the same snapshot: { 0 }.
    expect(a.getAllTrackedAddresses().map((x) => x.index)).toEqual([0]);
    expect(b.getAllTrackedAddresses().map((x) => x.index)).toEqual([0]);

    // A activates address 1 -> disk should hold [0, 1]
    await a.switchToAddress(1);
    expect(await readPersistedIndices(storage)).toEqual([0, 1]);

    // B — whose snapshot never saw address 1 — activates address 2.
    // A wholesale write erases index 1 here; a merge keeps it.
    await b.switchToAddress(2);

    expect(await readPersistedIndices(storage)).toEqual([0, 1, 2]);

    // A's in-memory view is still truthful about index 1.
    expect(a.getAllTrackedAddresses().map((x) => x.index)).toEqual([0, 1]);

    await a.destroy();
    await b.destroy();

    // --- A fresh load sees all three ---
    const storage2 = new FileStorageProvider({ dataDir: DATA_DIR });
    const { sphere: reloaded } = await Sphere.init({
      storage: storage2,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      network: TEST_NETWORK,
      walletApi: makePv2World().walletApi,
    });

    expect(reloaded.getAllTrackedAddresses().map((x) => x.index)).toEqual([0, 1, 2]);
    for (const addr of reloaded.getAllTrackedAddresses()) {
      expect(addr.directAddress.startsWith('DIRECT://')).toBe(true);
    }

    await reloaded.destroy();
  });

  it('keeps a hidden flag set by the other Sphere (greater updatedAt wins)', async () => {
    const { sphere: a } = await Sphere.init({
      storage,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      network: TEST_NETWORK,
      walletApi: makePv2World().walletApi,
      autoGenerate: true,
    });
    await a.switchToAddress(1);

    const { sphere: b } = await Sphere.init({
      storage,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      network: TEST_NETWORK,
      walletApi: makePv2World().walletApi,
    });
    expect(b.getAllTrackedAddresses().map((x) => x.index)).toEqual([0, 1]);

    // B hides address 1 (bumping its updatedAt); A then writes its own snapshot,
    // which still believes index 1 is visible but carries an OLDER updatedAt.
    // Step off A's millisecond first, so the case is about merge policy and not
    // about clock granularity producing a tie.
    const aUpdatedAt = a.getTrackedAddress(1)!.updatedAt;
    while (Date.now() <= aUpdatedAt) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await b.setAddressHidden(1, true);
    await a.switchToAddress(2);

    const raw = await storage.get(STORAGE_KEYS_GLOBAL.TRACKED_ADDRESSES);
    const entries = (JSON.parse(raw!) as { addresses: TrackedAddressEntry[] }).addresses;
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(entries.find((e) => e.index === 1)!.hidden).toBe(true);

    await a.destroy();
    await b.destroy();
  });

  it('serializes concurrent saveTrackedAddresses calls on one provider', async () => {
    const now = Date.now();
    const mk = (index: number): TrackedAddressEntry => ({
      index,
      hidden: false,
      createdAt: now,
      updatedAt: now,
    });

    // Two writers that each only know about their own index, issued without
    // awaiting each other: the per-instance write chain must not interleave a
    // read of one with the write of the other.
    await Promise.all([
      storage.saveTrackedAddresses([mk(0), mk(1)]),
      storage.saveTrackedAddresses([mk(0), mk(2)]),
    ]);

    expect((await storage.loadTrackedAddresses()).map((e) => e.index)).toEqual([0, 1, 2]);
  });

  describe('merge semantics (deterministic, no clock)', () => {
    it('unions by index, greater updatedAt wins hidden, earlier createdAt is kept', () => {
      const merged = mergeTrackedAddresses(
        [
          { index: 0, hidden: false, createdAt: 100, updatedAt: 100 },
          { index: 2, hidden: true, createdAt: 300, updatedAt: 900 },
          { index: 5, hidden: false, createdAt: 500, updatedAt: 500 },
        ],
        [
          { index: 2, hidden: false, createdAt: 250, updatedAt: 400 }, // stale: hidden loses
          { index: 1, hidden: true, createdAt: 200, updatedAt: 200 }, // only this writer knows it
        ],
      );

      expect(merged.map((e) => e.index)).toEqual([0, 1, 2, 5]);
      // Greater updatedAt supplies hidden...
      expect(merged.find((e) => e.index === 2)).toEqual({
        index: 2,
        hidden: true,
        createdAt: 250, // ...while createdAt keeps the EARLIER value
        updatedAt: 900,
      });
      // The stale writer's own new entry survives, as does the entry it never saw.
      expect(merged.find((e) => e.index === 1)!.hidden).toBe(true);
      expect(merged.find((e) => e.index === 5)).toBeDefined();
    });

    it('lets a fresher incoming entry overwrite hidden', () => {
      const merged = mergeTrackedAddresses(
        [{ index: 1, hidden: false, createdAt: 10, updatedAt: 10 }],
        [{ index: 1, hidden: true, createdAt: 10, updatedAt: 11 }],
      );
      expect(merged).toEqual([{ index: 1, hidden: true, createdAt: 10, updatedAt: 11 }]);
    });

    it('parses tolerantly: junk and a wrong top-level shape read as empty', () => {
      expect(parseTrackedAddresses(null)).toEqual([]);
      expect(parseTrackedAddresses('')).toEqual([]);
      expect(parseTrackedAddresses('not json')).toEqual([]);
      expect(parseTrackedAddresses('{"version":1}')).toEqual([]);
      expect(parseTrackedAddresses('[1,2,3]')).toEqual([]);
    });

    it('repairs an odd row instead of dropping the address it names', () => {
      // Dropping a row would delete one of the user's addresses; only a row with no
      // usable index is unrecoverable. A repaired timestamp is 0, so such an entry
      // loses every conflict rather than winning one on a fabricated time.
      const parsed = parseTrackedAddresses(
        JSON.stringify({
          version: 1,
          addresses: [
            { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
            { index: 1, hidden: 'nope' },
            { hidden: true, createdAt: 1, updatedAt: 1 },
            null,
          ],
        }),
      );

      expect(parsed).toEqual([
        { index: 0, hidden: false, createdAt: 1, updatedAt: 1 },
        { index: 1, hidden: false, createdAt: 0, updatedAt: 0 },
      ]);

      const merged = mergeTrackedAddresses(parsed, [
        { index: 1, hidden: true, createdAt: 5, updatedAt: 5 },
      ]);
      expect(merged.find((e) => e.index === 1)).toEqual({
        index: 1,
        hidden: true,
        createdAt: 0,
        updatedAt: 5,
      });
    });
  });
});
