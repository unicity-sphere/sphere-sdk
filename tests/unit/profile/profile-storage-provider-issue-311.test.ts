/**
 * Tests for the issue #311 critical-block-evicted alarm wired into
 * `ProfileStorageProvider.readEnvelopePayload`.
 *
 * Covers:
 *   - The notifier fires with the right `(cid, key, attemptedAt)` shape
 *     when a `db.get` / `db.getEntry` throws Helia's "Failed to load
 *     block for <CID>" pattern.
 *   - Dedup: the same `(cid, key)` pair fires the notifier at most once.
 *   - Notifier exception does NOT break the read path.
 *   - Clean reads do NOT fire the notifier.
 */

import { describe, it, expect } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import type { StorageProvider } from '../../../storage/storage-provider';
import type { FullIdentity, TrackedAddressEntry } from '../../../types';
import { ProfileStorageProvider } from '../../../profile/profile-storage-provider';

// ---------------------------------------------------------------------------
// Mock ProfileDatabase whose `get` throws a controlled "Failed to load
// block" error so the notifier path is exercised.
// ---------------------------------------------------------------------------

function createMockDbThatFailsToLoadBlock(opts: {
  readonly cid: string;
  /** Optional: throw via deep .cause chain so we exercise extractLostHeadCid. */
  readonly wrapDepth?: number;
}): ProfileDatabase & {
  _store: Map<string, Uint8Array>;
  _getThrows: boolean;
} {
  const store = new Map<string, Uint8Array>();
  const listeners: Array<() => void> = [];
  let getThrows = true;

  function buildError(): Error {
    const inner = new Error(`Failed to load block for ${opts.cid}`);
    let current: unknown = inner;
    const depth = opts.wrapDepth ?? 0;
    for (let i = 0; i < depth; i++) {
      const outer = new Error(`wrapper ${i}`) as Error & { cause?: unknown };
      outer.cause = current;
      current = outer;
    }
    return current as Error;
  }

  return {
    _store: store,
    get _getThrows() {
      return getThrows;
    },
    set _getThrows(v: boolean) {
      getThrows = v;
    },
    async connect(_config: OrbitDbConfig) {},
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async get(key: string) {
      if (getThrows) {
        throw buildError();
      }
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(prefix?: string) {
      const result = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v);
        }
      }
      return result;
    },
    async close() {},
    onReplication(cb: () => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    isConnected() {
      return true;
    },
  } as ProfileDatabase & {
    _store: Map<string, Uint8Array>;
    _getThrows: boolean;
  };
}

// ---------------------------------------------------------------------------
// Mock StorageProvider (in-memory local cache)
// ---------------------------------------------------------------------------

function createMockCache(): StorageProvider {
  const store = new Map<string, string>();
  let trackedAddresses: TrackedAddressEntry[] = [];

  return {
    id: 'mock-cache',
    name: 'Mock Cache',
    type: 'local' as const,
    description: 'In-memory mock cache',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected' as const;
    },
    setIdentity(_identity: FullIdentity) {},
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    },
    async has(key: string) {
      return store.has(key);
    },
    async keys(prefix?: string) {
      const all = Array.from(store.keys());
      if (!prefix) return all;
      return all.filter((k) => k.startsWith(prefix));
    },
    async clear(prefix?: string) {
      if (!prefix) {
        store.clear();
      } else {
        for (const k of store.keys()) {
          if (k.startsWith(prefix)) store.delete(k);
        }
      }
    },
    async saveTrackedAddresses(entries: TrackedAddressEntry[]) {
      trackedAddresses = entries;
    },
    async loadTrackedAddresses() {
      return trackedAddresses;
    },
  } as StorageProvider;
}

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';

const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};

const MISSING_CID = 'bafyreihx3oaTESTblockmissingsignaturepattern';

function buildProvider(opts?: { wrapDepth?: number }): {
  provider: ProfileStorageProvider;
  db: ReturnType<typeof createMockDbThatFailsToLoadBlock>;
} {
  const db = createMockDbThatFailsToLoadBlock({
    cid: MISSING_CID,
    wrapDepth: opts?.wrapDepth ?? 0,
  });
  const cache = createMockCache();
  const provider = new ProfileStorageProvider(cache, db, {
    config: { orbitDb: { privateKey: TEST_PRIVATE_KEY } },
    encrypt: true,
  });
  provider.setIdentity(TEST_IDENTITY);
  // Force the provider into the "OrbitDB attached" state so reads route
  // through `db.get` (otherwise they short-circuit via the dbConnected
  // check). These are the same private-state knobs the existing issue
  // #280 tests use.
  (provider as unknown as { dbStatus: string }).dbStatus = 'attached';
  (provider as unknown as { status: string }).status = 'connected';
  return { provider, db };
}

describe('Issue #311 — critical-block-evicted notifier', () => {
  it('fires with the right (cid, key, attemptedAt) shape when get throws "Failed to load block"', async () => {
    const { provider } = buildProvider();
    const fired: Array<{
      cid: string | null;
      key: string;
      attemptedAt: number;
    }> = [];
    provider.setCriticalBlockEvictedNotifier((info) => {
      fired.push({ cid: info.cid, key: info.key, attemptedAt: info.attemptedAt });
    });

    // `wallet_exists` translates to the profile key `wallet_exists`. The
    // adapter's `get(...)` throws our crafted error → readEnvelopePayload
    // detects the LoadBlockFailed signature and fires the notifier.
    // (Using a non-identity key — `mnemonic` is cache-only post the
    // IDENTITY_KEYS ⊂ CACHE_ONLY_KEYS fix and would not reach `db.get`.)
    await expect(provider.getEncryptedRaw('wallet_exists')).rejects.toThrow(
      /Failed to load block/,
    );

    expect(fired.length).toBe(1);
    expect(fired[0].cid).toBe(MISSING_CID);
    expect(fired[0].key).toBe('wallet_exists');
    expect(typeof fired[0].attemptedAt).toBe('number');
    expect(fired[0].attemptedAt).toBeGreaterThan(0);
  });

  it('walks the .cause chain (extractLostHeadCid depth=3 wrapper)', async () => {
    const { provider } = buildProvider({ wrapDepth: 3 });
    const fired: string[] = [];
    provider.setCriticalBlockEvictedNotifier((info) => {
      if (info.cid !== null) fired.push(info.cid);
    });

    await expect(provider.getEncryptedRaw('wallet_exists')).rejects.toBeDefined();

    expect(fired).toEqual([MISSING_CID]);
  });

  it('dedups by (cid, key): same pair fires only once across many reads', async () => {
    const { provider } = buildProvider();
    let count = 0;
    provider.setCriticalBlockEvictedNotifier(() => {
      count += 1;
    });

    for (let i = 0; i < 5; i++) {
      await expect(provider.getEncryptedRaw('wallet_exists')).rejects.toBeDefined();
    }
    expect(count).toBe(1);
  });

  it('notifier exception does NOT swallow the underlying error', async () => {
    const { provider } = buildProvider();
    provider.setCriticalBlockEvictedNotifier(() => {
      throw new Error('notifier exploded');
    });
    // The original "Failed to load block" error must still surface to
    // the caller — the observability hook is best-effort, not a sink.
    await expect(provider.getEncryptedRaw('wallet_exists')).rejects.toThrow(
      /Failed to load block/,
    );
  });

  it('clean reads do NOT fire the notifier', async () => {
    const { provider, db } = buildProvider();
    db._getThrows = false;
    let fired = 0;
    provider.setCriticalBlockEvictedNotifier(() => {
      fired += 1;
    });
    // The key is absent, so getEncryptedRaw resolves to null cleanly.
    const result = await provider.getEncryptedRaw('wallet_exists');
    expect(result).toBeNull();
    expect(fired).toBe(0);
  });
});
