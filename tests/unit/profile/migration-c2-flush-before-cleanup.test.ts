/**
 * Tests for Audit #333 C2: migration cleanup-before-flush.
 *
 * Background
 * ----------
 * Before the C2 fix, `ProfileMigration` walked:
 *   3. stepPersistToOrbitDb  — save() returns success even with
 *                              cid: 'debounced' (flush still pending).
 *   4. stepSanityCheck       — load() reads pendingData → passes even
 *                              if nothing was pinned.
 *   5. stepCleanup           — deletes legacy KV + unpins legacy CID.
 *
 * A crash (or later flush failure) between (3) and the debounced
 * flush landing lost both the legacy KV state and the unpinned CID
 * (gateway-reclaimable). No `forceFlush`/`awaitNextFlush` existed in
 * migration.ts.
 *
 * Fix
 * ---
 *   - stepPersistToOrbitDb calls `awaitNextFlush(0)` after save() —
 *     driving `flushScheduler.forceFlushSerialized()` and converting
 *     any TIMEOUT / POINTER_MONOTONICITY_VIOLATION into a recoverable
 *     `MIGRATION_FAILED`. Providers without `awaitNextFlush` are
 *     rejected outright (no silent fallback).
 *   - stepSanityCheck rejects `loadResult.source === 'cache'` — a
 *     post-flush `load()` must read from durable bundles
 *     (source: 'remote'), not in-memory pendingData. This is a
 *     belt-and-braces gate over the awaitNextFlush guarantee.
 *
 * These tests assert both halves.
 */

import { describe, it, expect } from 'vitest';
import type { StorageProvider } from '../../../storage/storage-provider';
import type {
  TxfStorageDataBase,
  TokenStorageProvider,
} from '../../../types';
import type { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import { ProfileMigration } from '../../../profile/migration';

// ---------------------------------------------------------------------------
// Minimal mocks (kept self-contained — independent of the broader
// migration test fixtures so future test refactors do not affect this
// regression surface).
// ---------------------------------------------------------------------------

function createMockLegacyStorage(initial: Record<string, string> = {}): StorageProvider {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    id: 'mock-legacy',
    name: 'Mock Legacy',
    type: 'local' as const,
    description: '',
    setIdentity() {},
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async remove(k: string) { store.delete(k); },
    async has(k: string) { return store.has(k); },
    async keys(prefix?: string) {
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(prefix?: string) {
      if (!prefix) { store.clear(); return; }
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() { return []; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _store: store as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockLegacyTokenStorage(
  txfData: TxfStorageDataBase | null,
): TokenStorageProvider<TxfStorageDataBase> {
  return {
    setIdentity() {},
    async initialize() { return true; },
    async shutdown() {},
    async save() { return { success: true, timestamp: Date.now() }; },
    async load() {
      return {
        success: txfData !== null,
        data: txfData ?? undefined,
        source: 'local' as const,
        timestamp: Date.now(),
      };
    },
    async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
    async clear() { return true; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-legacy-token',
    name: 'Mock Legacy Token Storage',
    type: 'local' as const,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockProfileStorage(): StorageProvider & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    id: 'mock-profile',
    name: 'Mock Profile',
    type: 'p2p' as const,
    description: '',
    setIdentity() {},
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    async get(k: string) { return store.get(k) ?? null; },
    async set(k: string, v: string) { store.set(k, v); },
    async remove(k: string) { store.delete(k); },
    async has(k: string) { return store.has(k); },
    async keys(prefix?: string) {
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(prefix?: string) {
      if (!prefix) { store.clear(); return; }
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() { return []; },
    _store: store,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Spec-shaped mock of ProfileTokenStorageProvider.
 *
 * Optional behaviours let individual tests simulate:
 *   - missing awaitNextFlush (legacy provider)
 *   - awaitNextFlush that throws (TIMEOUT / monotonicity violation)
 *   - load() that returns source='cache' even post-flush (buggy
 *     provider that ignores the durability contract)
 */
function createMockProfileTokenStorage(opts?: {
  txfData?: TxfStorageDataBase | null;
  omitAwaitNextFlush?: boolean;
  awaitNextFlushThrows?: Error;
  loadSourceStaysCache?: boolean;
}): ProfileTokenStorageProvider & {
  _savedData: TxfStorageDataBase | null;
  _awaitNextFlushCalls: number;
} {
  let savedData: TxfStorageDataBase | null = null;
  let flushed = false;
  let awaitNextFlushCalls = 0;

  const base: Record<string, unknown> = {
    setIdentity() {},
    async initialize() { return true; },
    async shutdown() {},
    async save(data: TxfStorageDataBase) {
      savedData = data;
      flushed = false;
      return { success: true, timestamp: Date.now() };
    },
    async load() {
      const data = opts?.txfData !== undefined ? opts.txfData : savedData;
      return {
        success: data !== null,
        data: data ?? undefined,
        source: (opts?.loadSourceStaysCache || !flushed
          ? 'cache'
          : 'remote') as const,
        timestamp: Date.now(),
      };
    },
    async sync() { return { success: true, added: 0, removed: 0, conflicts: 0 }; },
    async clear() { return true; },
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected' as const; },
    id: 'mock-c2-token',
    name: 'Mock C2 Token Storage',
    type: 'p2p' as const,
    async getHistoryEntries() { return []; },
  };

  if (!opts?.omitAwaitNextFlush) {
    base.awaitNextFlush = async (_timeoutMs?: number): Promise<void> => {
      awaitNextFlushCalls++;
      if (opts?.awaitNextFlushThrows) throw opts.awaitNextFlushThrows;
      flushed = true;
    };
  }

  Object.defineProperty(base, '_savedData', { get: () => savedData });
  Object.defineProperty(base, '_awaitNextFlushCalls', { get: () => awaitNextFlushCalls });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return base as any;
}

const SAMPLE_TXF: TxfStorageDataBase = {
  _meta: {
    version: 1,
    address: 'DIRECT_aabbcc_ddeeff',
    formatVersion: '1.0.0',
    updatedAt: 1000,
  },
  _token1: { id: 'token1', amount: '100' },
  _token2: { id: 'token2', amount: '200' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const SAMPLE_LEGACY = {
  wallet_exists: 'true',
  mnemonic: 'test mnemonic phrase',
  master_key: 'abc123',
  chain_code: 'def456',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 C2 — migration cleanup-before-flush', () => {
  describe('stepPersistToOrbitDb forces flush', () => {
    it('calls awaitNextFlush() exactly once after save()', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage();

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(true);
      expect(profileTokenStorage._awaitNextFlushCalls).toBe(1);
    });

    it('passes timeoutMs=0 (no wall-clock deadline) so large migrations are not artificially capped', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();

      let capturedTimeout: number | undefined;
      const profileTokenStorage = createMockProfileTokenStorage();
      const origAwait = profileTokenStorage.awaitNextFlush!.bind(profileTokenStorage);
      profileTokenStorage.awaitNextFlush = async (timeoutMs?: number) => {
        capturedTimeout = timeoutMs;
        return origAwait(timeoutMs);
      };

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(true);
      expect(capturedTimeout).toBe(0);
    });

    it('converts awaitNextFlush TIMEOUT into MIGRATION_FAILED before any cleanup', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage({
        awaitNextFlushThrows: Object.assign(
          new Error('awaitNextFlush: timeout awaiting serialized flush'),
          { code: 'TIMEOUT' },
        ),
      });

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Forced flush of token data failed/);

      // CRUCIAL: legacy keys MUST still be present — cleanup did not run.
      // Recovery (retry the migration after fixing the flush issue) is
      // possible because the legacy backing is intact.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      expect(legacyStore.get('mnemonic')).toBe('test mnemonic phrase');
      expect(legacyStore.get('master_key')).toBe('abc123');
      expect(legacyStore.get('chain_code')).toBe('def456');
    });

    it('converts awaitNextFlush POINTER_MONOTONICITY_VIOLATION into MIGRATION_FAILED', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage({
        awaitNextFlushThrows: Object.assign(
          new Error('pointer monotonicity violation'),
          { code: 'POINTER_MONOTONICITY_VIOLATION' },
        ),
      });

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Forced flush of token data failed/);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      expect(legacyStore.get('mnemonic')).toBe('test mnemonic phrase');
    });

    it('refuses providers that omit awaitNextFlush', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage({ omitAwaitNextFlush: true });

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/lacks awaitNextFlush/);
      // Cleanup did not run — legacy state intact.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      expect(legacyStore.has('mnemonic')).toBe(true);
    });

    it('skips the flush step when txfData is null (no tokens to migrate)', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(null);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage();

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(true);
      // No save → no flush required → awaitNextFlush MUST NOT be called
      // (otherwise we'd be forcing flushes on a provider with nothing
      // pending, polluting telemetry and wasting a forceFlushSerialized
      // round).
      expect(profileTokenStorage._awaitNextFlushCalls).toBe(0);
    });
  });

  describe('stepSanityCheck rejects in-memory reads (belt-and-braces)', () => {
    it('aborts when load() returns source="cache" after persist', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      // Buggy provider: awaitNextFlush returns OK but load() reports
      // source='cache' anyway — the audit's exact concern. Sanity
      // check must surface this.
      const profileTokenStorage = createMockProfileTokenStorage({
        loadSourceStaysCache: true,
      });

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/source='cache'|durable yet|Audit #333 C2/);
      // Cleanup did not run.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      expect(legacyStore.has('mnemonic')).toBe(true);
    });
  });

  describe('end-to-end durability invariant', () => {
    it('happy path: persist → flush → sanity (source=remote) → cleanup', async () => {
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage();

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(true);
      expect(profileTokenStorage._awaitNextFlushCalls).toBe(1);

      // Cleanup ran — legacy keys are gone (except migration tracking).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      for (const key of legacyStore.keys()) {
        expect(key).toMatch(/^migration\./);
      }

      // Profile side has the token data + identity keys.
      expect(profileStorage._store.has('identity.mnemonic')).toBe(true);
      expect(profileTokenStorage._savedData).toEqual(SAMPLE_TXF);
    });

    it('failure-path invariant: any flush/sanity error leaves legacy untouched and unpinned-CID reclaimable', async () => {
      // Simulate the exact crash-window the audit described:
      //   save() returned 'debounced'; we attempt awaitNextFlush;
      //   it fails. PRE-FIX the cleanup ran anyway, losing both the
      //   legacy KV and the unpinned CID. POST-FIX cleanup is gated.
      const legacyStorage = createMockLegacyStorage(SAMPLE_LEGACY);
      const legacyTokenStorage = createMockLegacyTokenStorage(SAMPLE_TXF);
      const profileStorage = createMockProfileStorage();
      const profileTokenStorage = createMockProfileTokenStorage({
        awaitNextFlushThrows: new Error('IPFS pinning service unreachable'),
      });

      const migration = new ProfileMigration();
      const result = await migration.migrate(
        legacyStorage,
        legacyTokenStorage,
        profileStorage as unknown as StorageProvider,
        profileTokenStorage,
      );

      expect(result.success).toBe(false);

      // Legacy state intact — operator can re-run migration after
      // fixing the IPFS connectivity. Pre-fix this would have been
      // permanent loss.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyStore = (legacyStorage as any)._store as Map<string, string>;
      expect(legacyStore.get('mnemonic')).toBe('test mnemonic phrase');
      expect(legacyStore.get('master_key')).toBe('abc123');
      expect(legacyStore.get('chain_code')).toBe('def456');
      expect(legacyStore.get('wallet_exists')).toBe('true');
    });
  });
});
