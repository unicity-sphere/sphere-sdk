/**
 * E2E tests: IndexedDB wallet lifecycle with leaked connections
 *
 * Simulates the EXACT flow from SphereProvider.tsx in the browser app:
 *   - React StrictMode double-mount → leaked IDB connections
 *   - deleteWallet() → destroy → disconnect → Sphere.clear() → reinitialize
 *   - createWallet() → Sphere.init(autoGenerate) → use wallet
 *
 * These tests reproduce the bug where deleteDatabase() hangs due to leaked
 * connections and validate the fix: IDBObjectStore.clear() instead of
 * deleteDatabase(). Post-flip additions: the KV wipe covers the payments
 * vertical's pv2:{network}:{pubkey}:* scoped KV, and Sphere.clear sweeps
 * orphaned pre-flip `sphere-token-storage-*` databases.
 *
 * Uses fake-indexeddb to simulate the browser IDB environment in Node.js.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBStorageProvider } from '../../impl/browser/storage/IndexedDBStorageProvider';
import { Sphere } from '../../core/Sphere';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import type { FullIdentity } from '../../types';

// =============================================================================
// Helpers — simulate the app's provider creation
// =============================================================================

/** Unique prefix per test to avoid cross-contamination */
let testId = 0;
function nextPrefix(): string {
  return `e2e-${++testId}-${Math.random().toString(36).slice(2, 6)}`;
}

function createStorage(dbName: string): IndexedDBStorageProvider {
  return new IndexedDBStorageProvider({ prefix: 'sphere_', dbName });
}

function createIdentity(index: number, seed: string): FullIdentity {
  const hex = (s: string) => Buffer.from(s).toString('hex').padEnd(64, '0').slice(0, 64);
  return {
    privateKey: hex(`priv-${seed}-${index}`),
    chainPubkey: '02' + hex(`pub-${seed}-${index}`),
    directAddress: `DIRECT://${seed}_addr_${index}`,
    nametag: index === 0 ? `user-${seed}` : undefined,
  };
}

/**
 * Simulates SphereProvider.initialize() + createWallet(): connect the KV
 * store, save wallet keys, and seed the pv2 scoped-KV rows the payments
 * vertical writes (they live in the SAME plain KV store).
 */
async function simulateCreateWallet(
  storage: IndexedDBStorageProvider,
  identity: FullIdentity,
): Promise<void> {
  await storage.connect();
  await storage.set(STORAGE_KEYS_GLOBAL.MNEMONIC, 'test mnemonic for ' + identity.chainPubkey);
  await storage.set(STORAGE_KEYS_GLOBAL.WALLET_EXISTS, 'true');
  await storage.set(STORAGE_KEYS_GLOBAL.MASTER_KEY, 'master-key-' + identity.chainPubkey);
  await storage.set(`pv2:testnet2:${identity.chainPubkey}:intents`, '[]');
  await storage.set(`pv2:testnet2:${identity.chainPubkey}:cursor:mailbox`, '{"cursor":0,"syncEpoch":"0"}');
}

/**
 * Simulates SphereProvider.deleteWallet() — the EXACT sequence from the app:
 * disconnect, then the Sphere.clear() internals (yield + reconnect + clear).
 */
async function simulateDeleteWallet(storage: IndexedDBStorageProvider): Promise<void> {
  await Promise.allSettled([storage.disconnect()]);

  await new Promise((r) => setTimeout(r, 50));
  if (!storage.isConnected()) {
    await storage.connect();
  }
  await storage.clear();
  // The provider wipes via a fresh connection and can end up closed; reads
  // after a delete go through a (re)connected handle, like the app's fresh
  // provider after re-initialize.
  if (!storage.isConnected()) {
    await storage.connect();
  }
}

/**
 * Simulates React StrictMode leaked connection:
 * First mount opens IDB → cleanup doesn't fully close → leaked handle.
 */
function simulateStrictModeLeakedConnection(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
    };
  });
}

/** Open (and leave behind) a pre-flip orphaned token database. */
function createOrphanTokenDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      db.createObjectStore('tokens');
    };
  });
}

async function listDatabaseNames(): Promise<string[]> {
  const dbs = await indexedDB.databases();
  return dbs.map((d) => d.name ?? '');
}

// =============================================================================
// Tests
// =============================================================================

describe('E2E: IndexedDB wallet lifecycle with leaked connections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('full wallet lifecycle (create → delete → recreate)', () => {
    it('should complete full cycle without leaked connections, wiping the pv2 KV', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      const storage = createStorage(kvDbName);
      const identity = createIdentity(0, prefix);

      // === Create wallet ===
      await simulateCreateWallet(storage, identity);

      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).not.toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');
      expect(await storage.get(`pv2:testnet2:${identity.chainPubkey}:intents`)).toBe('[]');

      // === Delete wallet ===
      await simulateDeleteWallet(storage);

      // === Recreate wallet ===
      const storage2 = createStorage(kvDbName);
      const identity2 = createIdentity(0, `${prefix}-new`);

      await simulateCreateWallet(storage2, identity2);

      // Old data gone — including the previous owner's pv2 scoped KV.
      expect(await storage2.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe(
        'test mnemonic for ' + identity2.chainPubkey,
      );
      expect(await storage2.get(`pv2:testnet2:${identity.chainPubkey}:intents`)).toBeNull();
      expect(await storage2.get(`pv2:testnet2:${identity2.chainPubkey}:intents`)).toBe('[]');

      await storage2.disconnect();
    });

    it('should complete full cycle WITH React StrictMode leaked KV connection', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      const storage = createStorage(kvDbName);
      const identity = createIdentity(0, prefix);

      await simulateCreateWallet(storage, identity);

      // === React StrictMode leaks a KV storage connection (NOT closed) ===
      await simulateStrictModeLeakedConnection(kvDbName);

      // === Delete wallet (MUST NOT hang on the leaked handle) ===
      await simulateDeleteWallet(storage);

      // === Recreate wallet ===
      const storage2 = createStorage(kvDbName);
      const identity2 = createIdentity(0, `${prefix}-v2`);

      await simulateCreateWallet(storage2, identity2);

      expect(await storage2.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');
      expect(await storage2.get(`pv2:testnet2:${identity.chainPubkey}:intents`)).toBeNull();

      await storage2.disconnect();
    });
  });

  describe('Sphere.clear() end-to-end against the real providers', () => {
    it('wipes the KV (incl. pv2 rows) and sweeps orphaned sphere-token-storage-* databases', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const orphanName = `sphere-token-storage-${prefix}`;

      const storage = createStorage(kvDbName);
      const identity = createIdentity(0, prefix);
      await simulateCreateWallet(storage, identity);
      await createOrphanTokenDb(orphanName);
      expect(await listDatabaseNames()).toContain(orphanName);

      await Sphere.clear({ storage });
      if (!storage.isConnected()) await storage.connect();

      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      expect(await storage.get(`pv2:testnet2:${identity.chainPubkey}:intents`)).toBeNull();
      // The orphaned pre-flip token database was deleted by the raw sweep.
      await vi.waitFor(async () => {
        expect(await listDatabaseNames()).not.toContain(orphanName);
      });

      await storage.disconnect();
    });
  });

  describe('rapid delete-create cycles', () => {
    it('should survive 5 consecutive delete-create cycles', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      for (let cycle = 0; cycle < 5; cycle++) {
        const storage = createStorage(kvDbName);
        const identity = createIdentity(0, `${prefix}-c${cycle}`);

        await simulateCreateWallet(storage, identity);
        expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');

        await simulateDeleteWallet(storage);
        expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();
        await storage.disconnect();
      }
    });

    it('should survive rapid cycles with leaked connections each time', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      for (let cycle = 0; cycle < 3; cycle++) {
        const storage = createStorage(kvDbName);
        const identity = createIdentity(0, `${prefix}-leak${cycle}`);

        await simulateCreateWallet(storage, identity);
        await simulateStrictModeLeakedConnection(kvDbName);
        await simulateDeleteWallet(storage);
        expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();
        await storage.disconnect();
      }
    });
  });

  describe('multi-tab simulation', () => {
    it('should clear data even when another tab has active connections', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      const tabA = createStorage(kvDbName);
      const identity = createIdentity(0, prefix);
      await simulateCreateWallet(tabA, identity);

      // Tab B holds its own live connection to the same database.
      const tabB = createStorage(kvDbName);
      await tabB.connect();
      expect(await tabB.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');

      // Tab A deletes the wallet — must not hang on tab B's connection.
      await simulateDeleteWallet(tabA);

      expect(await tabA.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();

      await tabA.disconnect();
      await tabB.disconnect();
    });
  });

  describe('error recovery', () => {
    it('should handle createWallet failure → clear partial data → retry', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      const storage = createStorage(kvDbName);
      await storage.connect();
      // Partial create: keys written but WALLET_EXISTS never set (simulated crash).
      await storage.set(STORAGE_KEYS_GLOBAL.MNEMONIC, 'partial mnemonic');

      // Recovery path: clear partial data, then retry the full create.
      await simulateDeleteWallet(storage);
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();

      const identity = createIdentity(0, `${prefix}-retry`);
      await simulateCreateWallet(storage, identity);
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');

      await storage.disconnect();
    });
  });
});
