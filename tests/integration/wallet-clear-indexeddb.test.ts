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
 * deleteDatabase().
 *
 * Uses fake-indexeddb to simulate the browser IDB environment in Node.js.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBStorageProvider } from '../../impl/browser/storage/IndexedDBStorageProvider';
import { IndexedDBTokenStorageProvider } from '../../impl/browser/storage/IndexedDBTokenStorageProvider';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import type { FullIdentity } from '../../types';
import type { TxfStorageDataBase } from '../../storage';

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

function createTokenStorage(prefix: string): IndexedDBTokenStorageProvider {
  return new IndexedDBTokenStorageProvider({ dbNamePrefix: prefix });
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

function createTxfData(address: string, tokenIds: string[]): TxfStorageDataBase {
  const data: TxfStorageDataBase = {
    _meta: {
      version: 1,
      address,
      formatVersion: '2.0',
      updatedAt: Date.now(),
    },
  };
  for (const id of tokenIds) {
    (data as Record<string, unknown>)[`_${id}`] = {
      version: '2.0',
      state: { tokenId: id, coinId: 'UCT', amount: '1000000' },
      transactions: [],
    };
  }
  return data;
}

function countTokens(data: TxfStorageDataBase): number {
  return Object.keys(data).filter(
    (k) => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid'].includes(k),
  ).length;
}

// =============================================================================
// Lifecycle simulators — mirror SphereProvider.tsx behavior
// =============================================================================

/**
 * Simulates SphereProvider.initialize() + createWallet():
 * 1. storage.connect()
 * 2. tokenStorage.setIdentity() + initialize()
 * 3. Save wallet keys to storage
 * 4. Save tokens to tokenStorage
 */
async function simulateCreateWallet(
  storage: IndexedDBStorageProvider,
  tokenStorage: IndexedDBTokenStorageProvider,
  identity: FullIdentity,
  tokens: string[],
): Promise<void> {
  await storage.connect();
  await storage.set(STORAGE_KEYS_GLOBAL.MNEMONIC, 'test mnemonic for ' + identity.chainPubkey);
  await storage.set(STORAGE_KEYS_GLOBAL.WALLET_EXISTS, 'true');
  await storage.set(STORAGE_KEYS_GLOBAL.MASTER_KEY, 'master-key-' + identity.chainPubkey);

  tokenStorage.setIdentity(identity);
  await tokenStorage.initialize();
  if (tokens.length > 0) {
    await tokenStorage.save(createTxfData(identity.chainPubkey, tokens));
  }
}

/**
 * Simulates SphereProvider.deleteWallet() — the EXACT sequence from the app:
 * 1. sphere.destroy() → shuts down providers
 * 2. Promise.allSettled([storage.disconnect(), tokenStorage.disconnect()])
 * 3. Sphere.clear({ storage, tokenStorage }) with timeout
 * 4. reinitialize with fresh providers
 */
async function simulateDeleteWallet(
  storage: IndexedDBStorageProvider,
  tokenStorage: IndexedDBTokenStorageProvider,
): Promise<void> {
  // Step 1: destroy() — shuts down providers
  if (tokenStorage.isConnected()) {
    await tokenStorage.shutdown();
  }

  // Step 2: disconnect providers (as SphereProvider does)
  await Promise.allSettled([
    storage.disconnect(),
    tokenStorage.disconnect(),
  ]);

  // Step 3: Sphere.clear() internals — yield + clear
  await new Promise((r) => setTimeout(r, 50));
  await tokenStorage.clear();
  // For KV storage: reconnect if needed, then clear
  if (!storage.isConnected()) {
    await storage.connect();
  }
  await storage.clear();
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

// =============================================================================
// Tests
// =============================================================================

describe('E2E: IndexedDB wallet lifecycle with leaked connections', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Full SphereProvider lifecycle: create → use → delete → create
  // =========================================================================

  describe('full wallet lifecycle (create → delete → recreate)', () => {
    it('should complete full cycle without leaked connections', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      const storage = createStorage(kvDbName);
      const tokenStorage = createTokenStorage(`${prefix}-tokens`);
      const identity = createIdentity(0, prefix);

      // === Create wallet ===
      await simulateCreateWallet(storage, tokenStorage, identity, ['token1', 'token2', 'token3']);

      // Verify data exists
      expect(await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).not.toBeNull();
      expect(await storage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');
      const load1 = await tokenStorage.load();
      expect(countTokens(load1.data!)).toBe(3);

      // === Delete wallet ===
      await simulateDeleteWallet(storage, tokenStorage);

      // === Recreate wallet ===
      const storage2 = createStorage(kvDbName);
      const tokenStorage2 = createTokenStorage(`${prefix}-tokens`);
      const identity2 = createIdentity(0, `${prefix}-new`);

      await simulateCreateWallet(storage2, tokenStorage2, identity2, ['newToken1']);

      // Old data gone
      expect(await storage2.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBe(
        'test mnemonic for ' + identity2.chainPubkey,
      );
      const load2 = await tokenStorage2.load();
      expect(countTokens(load2.data!)).toBe(1);
      expect(load2.data!['_newToken1' as keyof TxfStorageDataBase]).toBeDefined();
      expect(load2.data!['_token1' as keyof TxfStorageDataBase]).toBeUndefined();

      // Cleanup
      await storage2.disconnect();
      await tokenStorage2.shutdown();
    });

    it('should complete full cycle WITH React StrictMode leaked KV connection', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;

      const storage = createStorage(kvDbName);
      const tokenStorage = createTokenStorage(`${prefix}-tokens`);
      const identity = createIdentity(0, prefix);

      // === Create wallet ===
      await simulateCreateWallet(storage, tokenStorage, identity, ['token1', 'token2']);

      // === React StrictMode leaks a KV storage connection ===
      const leakedKv = await simulateStrictModeLeakedConnection(kvDbName);
      // NOT closed — this is the leak!

      // === Delete wallet ===
      await simulateDeleteWallet(storage, tokenStorage);

      // === Recreate wallet (MUST NOT hang!) ===
      const storage2 = createStorage(kvDbName);
      const tokenStorage2 = createTokenStorage(`${prefix}-tokens`);
      const identity2 = createIdentity(0, `${prefix}-v2`);

      await simulateCreateWallet(storage2, tokenStorage2, identity2, ['freshToken']);

      expect(await storage2.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');
      const load = await tokenStorage2.load();
      expect(countTokens(load.data!)).toBe(1);
      expect(load.data!['_freshToken' as keyof TxfStorageDataBase]).toBeDefined();
      // Old tokens must be gone
      expect(load.data!['_token1' as keyof TxfStorageDataBase]).toBeUndefined();

      // Cleanup
      leakedKv.close();
      await storage2.disconnect();
      await tokenStorage2.shutdown();
    });

    it('should complete full cycle WITH leaked token storage connection', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const tokenPrefix = `${prefix}-tokens`;

      const storage = createStorage(kvDbName);
      const tokenStorage = createTokenStorage(tokenPrefix);
      const identity = createIdentity(0, prefix);

      // === Create wallet with tokens ===
      await simulateCreateWallet(storage, tokenStorage, identity, ['uct001', 'uct002']);

      // === React StrictMode leaks a token storage connection ===
      // Simulate: first mount opens token DB, cleanup doesn't call shutdown()
      const leakedTokenDb = createTokenStorage(tokenPrefix);
      leakedTokenDb.setIdentity(identity);
      await leakedTokenDb.initialize();
      // NOT calling shutdown() — leaked!

      // === Delete wallet ===
      await simulateDeleteWallet(storage, tokenStorage);

      // === Recreate (MUST NOT hang!) ===
      const storage2 = createStorage(kvDbName);
      const tokenStorage2 = createTokenStorage(tokenPrefix);
      const identity2 = createIdentity(0, `${prefix}-v2`);

      await simulateCreateWallet(storage2, tokenStorage2, identity2, ['newUct']);

      expect(await storage2.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');
      const load = await tokenStorage2.load();
      expect(countTokens(load.data!)).toBe(1);
      expect(load.data!['_uct001' as keyof TxfStorageDataBase]).toBeUndefined();

      // Cleanup
      await leakedTokenDb.shutdown();
      await storage2.disconnect();
      await tokenStorage2.shutdown();
    });
  });

  // =========================================================================
  // 2. Multi-address wallet lifecycle
  // =========================================================================

  describe('multi-address wallet lifecycle', () => {
    it('should clear tokens across all derived addresses', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const tokenPrefix = `${prefix}-tokens`;

      const storage = createStorage(kvDbName);
      await storage.connect();
      await storage.set(STORAGE_KEYS_GLOBAL.WALLET_EXISTS, 'true');

      // === Address 0: save tokens ===
      const identity0 = createIdentity(0, prefix);
      const ts0 = createTokenStorage(tokenPrefix);
      ts0.setIdentity(identity0);
      await ts0.initialize();
      await ts0.save(createTxfData(identity0.chainPubkey, ['addr0_token1', 'addr0_token2']));
      await ts0.shutdown();

      // === Address 1: save tokens ===
      const identity1 = createIdentity(1, prefix);
      const ts1 = createTokenStorage(tokenPrefix);
      ts1.setIdentity(identity1);
      await ts1.initialize();
      await ts1.save(createTxfData(identity1.chainPubkey, ['addr1_token1']));

      // === Leaked connection to address 1 (StrictMode) ===
      const leaked = createTokenStorage(tokenPrefix);
      leaked.setIdentity(identity1);
      await leaked.initialize();
      // NOT calling shutdown!

      // === Delete wallet: clear from address 1's perspective ===
      await ts1.shutdown();
      await storage.disconnect();
      await new Promise((r) => setTimeout(r, 50));
      await ts1.clear(); // Should clear ALL address databases

      // === Verify: address 0 tokens are gone ===
      const verify0 = createTokenStorage(tokenPrefix);
      verify0.setIdentity(identity0);
      await verify0.initialize();
      expect(countTokens((await verify0.load()).data!)).toBe(0);
      await verify0.shutdown();

      // === Verify: address 1 tokens are gone ===
      const verify1 = createTokenStorage(tokenPrefix);
      verify1.setIdentity(identity1);
      await verify1.initialize();
      expect(countTokens((await verify1.load()).data!)).toBe(0);
      await verify1.shutdown();

      // === New wallet on same addresses works ===
      const newTs0 = createTokenStorage(tokenPrefix);
      newTs0.setIdentity(identity0);
      await newTs0.initialize();
      await newTs0.save(createTxfData(identity0.chainPubkey, ['new_token']));
      const newLoad = await newTs0.load();
      expect(countTokens(newLoad.data!)).toBe(1);

      // Cleanup
      await leaked.shutdown();
      await newTs0.shutdown();
    });
  });

  // =========================================================================
  // 3. Rapid delete-create cycles (user spam-clicking)
  // =========================================================================

  describe('rapid delete-create cycles', () => {
    it('should survive 5 consecutive delete-create cycles', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const tokenPrefix = `${prefix}-tokens`;

      for (let cycle = 0; cycle < 5; cycle++) {
        const storage = createStorage(kvDbName);
        const tokenStorage = createTokenStorage(tokenPrefix);
        const identity = createIdentity(0, `${prefix}-cycle${cycle}`);

        // Create
        await simulateCreateWallet(storage, tokenStorage, identity, [`cycle${cycle}_token`]);

        // Verify
        const load = await tokenStorage.load();
        expect(countTokens(load.data!)).toBe(1);
        expect(load.data![`_cycle${cycle}_token` as keyof TxfStorageDataBase]).toBeDefined();

        // Delete
        await simulateDeleteWallet(storage, tokenStorage);
      }

      // Final verification: wallet data is clean
      const finalStorage = createStorage(kvDbName);
      await finalStorage.connect();
      expect(await finalStorage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBeNull();
      expect(await finalStorage.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toBeNull();
      await finalStorage.disconnect();
    });

    it('should survive rapid cycles with leaked connections each time', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const tokenPrefix = `${prefix}-tokens`;
      const leaks: { shutdown: () => Promise<void> }[] = [];

      for (let cycle = 0; cycle < 3; cycle++) {
        const storage = createStorage(kvDbName);
        const tokenStorage = createTokenStorage(tokenPrefix);
        const identity = createIdentity(0, `${prefix}-c${cycle}`);

        // Create wallet
        await simulateCreateWallet(storage, tokenStorage, identity, [`c${cycle}_tok`]);

        // Leak a token storage connection (StrictMode)
        const leaked = createTokenStorage(tokenPrefix);
        leaked.setIdentity(identity);
        await leaked.initialize();
        leaks.push(leaked);
        // NOT closing!

        // Delete wallet
        await simulateDeleteWallet(storage, tokenStorage);
      }

      // After 3 cycles with 3 leaked connections, create final wallet
      const finalStorage = createStorage(kvDbName);
      const finalTokenStorage = createTokenStorage(tokenPrefix);
      const finalIdentity = createIdentity(0, `${prefix}-final`);

      await simulateCreateWallet(finalStorage, finalTokenStorage, finalIdentity, ['final_token']);

      expect(await finalStorage.get(STORAGE_KEYS_GLOBAL.WALLET_EXISTS)).toBe('true');
      const load = await finalTokenStorage.load();
      expect(countTokens(load.data!)).toBe(1);
      expect(load.data!['_final_token' as keyof TxfStorageDataBase]).toBeDefined();

      // No stale tokens from previous cycles
      expect(load.data!['_c0_tok' as keyof TxfStorageDataBase]).toBeUndefined();
      expect(load.data!['_c1_tok' as keyof TxfStorageDataBase]).toBeUndefined();
      expect(load.data!['_c2_tok' as keyof TxfStorageDataBase]).toBeUndefined();

      // Cleanup
      for (const l of leaks) await l.shutdown();
      await finalStorage.disconnect();
      await finalTokenStorage.shutdown();
    });
  });

  // =========================================================================
  // 4. Multi-tab simulation
  // =========================================================================

  describe('multi-tab simulation', () => {
    it('should clear data even when another tab has active connections', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const tokenPrefix = `${prefix}-tokens`;
      const identity = createIdentity(0, prefix);

      // === Tab A: create and use wallet ===
      const tabA_storage = createStorage(kvDbName);
      const tabA_tokens = createTokenStorage(tokenPrefix);
      await simulateCreateWallet(tabA_storage, tabA_tokens, identity, ['tabA_token1', 'tabA_token2']);

      // === Tab B: opens same wallet (read-only browsing) ===
      const tabB_storage = createStorage(kvDbName);
      await tabB_storage.connect();
      const tabB_tokens = createTokenStorage(tokenPrefix);
      tabB_tokens.setIdentity(identity);
      await tabB_tokens.initialize();

      // Tab B reads tokens
      const tabB_load = await tabB_tokens.load();
      expect(countTokens(tabB_load.data!)).toBe(2);

      // === Tab A: user deletes wallet ===
      // Tab B connections are still open!
      await simulateDeleteWallet(tabA_storage, tabA_tokens);

      // === Tab A: creates new wallet ===
      const tabA_storage2 = createStorage(kvDbName);
      const tabA_tokens2 = createTokenStorage(tokenPrefix);
      const newIdentity = createIdentity(0, `${prefix}-new`);
      await simulateCreateWallet(tabA_storage2, tabA_tokens2, newIdentity, ['new_token']);

      // Tab A sees new data
      expect(await tabA_storage2.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toContain(newIdentity.chainPubkey);
      const newLoad = await tabA_tokens2.load();
      expect(countTokens(newLoad.data!)).toBe(1);

      // Tab B: if it re-reads, old tokens are gone
      // (Tab B's connection is still open, but the stores were cleared and
      //  new wallet may have written to the same or different DB)
      const tabB_reload = await tabB_tokens.load();
      expect(tabB_reload.data!['_tabA_token1' as keyof TxfStorageDataBase]).toBeUndefined();
      expect(tabB_reload.data!['_tabA_token2' as keyof TxfStorageDataBase]).toBeUndefined();

      // Cleanup
      await tabB_storage.disconnect();
      await tabB_tokens.shutdown();
      await tabA_storage2.disconnect();
      await tabA_tokens2.shutdown();
    });
  });

  // =========================================================================
  // 5. Error recovery
  // =========================================================================

  describe('error recovery', () => {
    it('should handle createWallet failure → clear partial data → retry', async () => {
      const prefix = nextPrefix();
      const kvDbName = `${prefix}-kv`;
      const tokenPrefix = `${prefix}-tokens`;

      // === Attempt 1: create wallet, simulate nametag failure mid-way ===
      const storage1 = createStorage(kvDbName);
      await storage1.connect();
      // Partial data written (mnemonic saved but wallet creation throws)
      await storage1.set(STORAGE_KEYS_GLOBAL.MNEMONIC, 'partial-mnemonic');
      await storage1.set(STORAGE_KEYS_GLOBAL.WALLET_EXISTS, 'true');

      const tokenStorage1 = createTokenStorage(tokenPrefix);
      const identity1 = createIdentity(0, prefix);
      tokenStorage1.setIdentity(identity1);
      await tokenStorage1.initialize();
      // Partial token data
      await tokenStorage1.save(createTxfData(identity1.chainPubkey, ['partial_token']));

      // Error cleanup (as SphereProvider.createWallet does on failure):
      // Sphere.clear() with 3s timeout
      await tokenStorage1.shutdown();
      await storage1.disconnect();
      await new Promise((r) => setTimeout(r, 50));
      await tokenStorage1.clear();
      if (!storage1.isConnected()) await storage1.connect();
      await storage1.clear();

      // === Attempt 2: retry create wallet ===
      const storage2 = createStorage(kvDbName);
      const tokenStorage2 = createTokenStorage(tokenPrefix);
      const identity2 = createIdentity(0, `${prefix}-retry`);

      await simulateCreateWallet(storage2, tokenStorage2, identity2, ['success_token']);

      // No partial data leaked
      expect(await storage2.get(STORAGE_KEYS_GLOBAL.MNEMONIC)).toContain(identity2.chainPubkey);
      const load = await tokenStorage2.load();
      expect(countTokens(load.data!)).toBe(1);
      expect(load.data!['_partial_token' as keyof TxfStorageDataBase]).toBeUndefined();
      expect(load.data!['_success_token' as keyof TxfStorageDataBase]).toBeDefined();

      await storage2.disconnect();
      await tokenStorage2.shutdown();
    });
  });
});
