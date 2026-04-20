/**
 * E2E Test: Profile (OrbitDB) Sync against real Unicity infrastructure.
 *
 * Mirrors `ipfs-sync.test.ts` but exercises the Profile stack:
 *   - `ProfileStorageProvider` (local file cache + OrbitDB via Helia)
 *   - `ProfileTokenStorageProvider` (CAR pin/fetch via live IPFS gateway)
 *
 * Requires network access:
 *   - `https://unicity-ipfs1.dyndns.org` (CAR pin/fetch HTTP API)
 *   - `DEFAULT_IPFS_BOOTSTRAP_PEERS` (libp2p gossipsub for OrbitDB replication)
 *
 * Each test uses a throwaway random keypair so there is no cross-run state.
 *
 * Run with: `npm run test:e2e`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { ProfileStorageProvider } from '../../profile/profile-storage-provider';
import { ProfileTokenStorageProvider } from '../../profile/profile-token-storage-provider';
import { OrbitDbAdapter } from '../../profile/orbitdb-adapter';
import { DEFAULT_IPFS_GATEWAYS, DEFAULT_IPFS_BOOTSTRAP_PEERS } from '../../constants';
import type { FullIdentity } from '../../types';
import type { TxfStorageDataBase } from '../../storage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeThrowawayIdentity(): FullIdentity {
  const tag = randomHex(10);
  return {
    privateKey: randomHex(32),
    chainPubkey: '03' + randomHex(32),
    l1Address: 'alpha1profile' + tag,
    directAddress: 'DIRECT://' + randomHex(20),
  };
}

function makeTempBase(label: string): string {
  const base = join(tmpdir(), `sphere-e2e-profile-${label}-${Date.now()}-${randomHex(4)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

/**
 * Build a fresh Profile provider pair (storage + tokenStorage) sharing
 * a single Helia/OrbitDB node. Returns the providers plus a cleanup
 * function that shuts everything down and removes the temp directory.
 */
async function makeProfilePair(label: string) {
  const base = makeTempBase(label);
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });

  const cache = createFileStorageProvider({ dataDir });
  const db = new OrbitDbAdapter();

  const storage = new ProfileStorageProvider(cache, db, {
    config: {
      orbitDb: {
        privateKey: '', // populated via setIdentity()
        directory: join(dataDir, 'orbitdb'),
        bootstrapPeers: [...DEFAULT_IPFS_BOOTSTRAP_PEERS],
      },
      encrypt: true,
    },
  });

  const tokenStorage = new ProfileTokenStorageProvider(
    db,
    null, // encryption key derived on setIdentity()
    [...DEFAULT_IPFS_GATEWAYS],
    {
      config: {
        orbitDb: {
          privateKey: '',
          directory: join(dataDir, 'orbitdb'),
          bootstrapPeers: [...DEFAULT_IPFS_BOOTSTRAP_PEERS],
        },
        encrypt: true,
      },
      addressId: 'default',
      encrypt: true,
    },
    cache,
  );

  const cleanup = async () => {
    try { await tokenStorage.shutdown(); } catch { /* best-effort */ }
    try { await storage.disconnect(); } catch { /* best-effort */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  return { storage, tokenStorage, db, base, cleanup };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Profile (OrbitDB + IPFS) Sync E2E', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const c of cleanups) {
      try { await c(); } catch { /* best-effort */ }
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: ProfileStorageProvider — connect → set/get KV round-trip
  // -------------------------------------------------------------------------

  it('ProfileStorageProvider connects to real Helia/OrbitDB and round-trips a KV write', async () => {
    const identity = makeThrowawayIdentity();
    const pair = await makeProfilePair('sync-basic');
    cleanups.push(pair.cleanup);

    // Phase A: pre-identity connect
    await pair.storage.connect();
    expect(pair.storage.isConnected()).toBe(false); // orbitDb configured but not attached

    // setIdentity + Phase B attach
    pair.storage.setIdentity(identity);
    await pair.storage.connect();
    expect(pair.storage.isConnected()).toBe(true);

    // Write → read round-trip through OrbitDB
    const uniqueValue = 'profile-e2e-' + randomHex(6);
    await pair.storage.set('mnemonic', uniqueValue);
    const read = await pair.storage.get('mnemonic');
    expect(read).toBe(uniqueValue);
  }, 180_000);

  // -------------------------------------------------------------------------
  // Test 2: ProfileTokenStorageProvider — CAR pin + fetch via live IPFS
  // -------------------------------------------------------------------------

  it('ProfileTokenStorageProvider pins a CAR bundle to Unicity IPFS and reloads it', async () => {
    const identity = makeThrowawayIdentity();
    const pair = await makeProfilePair('sync-car');
    cleanups.push(pair.cleanup);

    pair.storage.setIdentity(identity);
    await pair.storage.connect();
    expect(pair.storage.isConnected()).toBe(true);

    pair.tokenStorage.setIdentity(identity);
    const initialized = await pair.tokenStorage.initialize();
    expect(initialized).toBe(true);

    // Build a minimal TxfStorageDataBase with synthetic tokens.
    // The Profile token storage extracts `archived-*` keys into the
    // CAR bundle; `_meta` is retained in the OrbitDB operational state.
    const inventory: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: identity.directAddress!,
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ['archived-alpha']: { id: 'alpha', coinId: 'UCT', amount: '1000' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ['archived-bravo']: { id: 'bravo', coinId: 'UCT', amount: '2500' } as any,
    };

    const saveResult = await pair.tokenStorage.save(inventory);
    expect(saveResult.success).toBe(true);

    // save() is debounced — drain the flush so the CAR is actually pinned.
    await pair.tokenStorage.shutdown();

    // Fresh tokenStorage on the same db/cache reloads the bundle via
    // OrbitDB → CAR CID → IPFS fetch → assemble.
    pair.tokenStorage.setIdentity(identity);
    expect(await pair.tokenStorage.initialize()).toBe(true);

    const loadResult = await pair.tokenStorage.load();
    expect(loadResult.success).toBe(true);
    expect(loadResult.data).toBeTruthy();
  }, 300_000);

  // Note on cross-instance replication coverage: this is deliberately
  // tested at the higher Sphere.init() level in
  // `profile-token-persistence.test.ts` and
  // `profile-multi-device-sync.test.ts`, where real wallet identities
  // bind to the Unicity testnet and exercise the full Profile flow
  // (CAR pin → OrbitDB op → libp2p pubsub). Two fresh ephemeral Helia
  // nodes with only IPFS gateways as bootstrap peers cannot reliably
  // discover each other without a DHT/rendezvous service, so a pure
  // cross-instance OrbitDB test at this layer is not meaningful.
});
