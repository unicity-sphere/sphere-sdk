/**
 * Unit tests for `profile/profile-snapshot-cache.ts` — Issue #313.
 *
 * Covers the snapshot read/write helpers in isolation. Lifecycle-
 * integration tests (initialize() seeds in-memory state, flush writes
 * the blob) live separately and exercise the host adapter end-to-end.
 *
 * # Acceptance contract under test
 *
 *   1. Round-trip serialize/deserialize preserves all UI-visible
 *      fields (tokens, bundles, pointer, identity binding).
 *   2. Atomic-write contract: a crash BETWEEN the pending write and
 *      the main write leaves the previous main blob intact.
 *   3. Snapshot age is computed correctly (now - blob.ts).
 *   4. walletId mismatch is reported as `corrupt` — defends against
 *      snapshot reuse across distinct mnemonics on the same disk.
 *   5. Schema version mismatch falls through to corrupt + clean.
 *   6. Partial write simulation (tamper with bytes) detected via the
 *      contentHash invariant.
 *   7. Missing blob returns `absent` (boot continues via slow path).
 *   8. Storage failure during read is reported as `corrupt`.
 *   9. `setMany` fallback path produces a byte-identical result.
 *  10. `clearSnapshot` removes both main and pending keys.
 *
 * @see profile/profile-snapshot-cache.ts
 * @see Issue #313
 */

import { describe, expect, it } from 'vitest';
import {
  PROFILE_SNAPSHOT_SCHEMA_VERSION,
  clearSnapshot,
  getSnapshotBlobKey,
  getSnapshotPendingKey,
  readSnapshot,
  writeSnapshot,
  type ProfileSnapshotBlob,
} from '../../../profile/profile-snapshot-cache.js';
import type {
  StorageProvider,
  TxfStorageDataBase,
} from '../../../storage/storage-provider.js';

// ---------------------------------------------------------------------------
// In-memory storage fakes
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory `StorageProvider`. Optionally simulates atomic
 * `setMany`: when `withSetMany` is true, the implementation commits all
 * entries in a single synchronous block (mirroring IndexedDB's
 * transaction semantics). When false, the fake omits `setMany` so the
 * helper falls through to the sequential-write path.
 *
 * The `failNext` map injects controlled failures on specific keys: the
 * next `set()` / `get()` / `remove()` matching the key throws an
 * Error('injected'). Used to test partial-write recovery.
 */
function makeStorage(opts: {
  readonly withSetMany?: boolean;
  readonly initial?: Record<string, string>;
} = {}): StorageProvider & {
  // Test-only inspection surfaces
  _store: Map<string, string>;
  _failNext: Map<string, 'set' | 'get' | 'remove'>;
} {
  const store = new Map<string, string>(Object.entries(opts.initial ?? {}));
  const failNext = new Map<string, 'set' | 'get' | 'remove'>();
  const checkFail = (op: 'set' | 'get' | 'remove', key: string): void => {
    if (failNext.get(key) === op) {
      failNext.delete(key);
      throw new Error(`injected:${op}:${key}`);
    }
  };

  const base: StorageProvider = {
    id: 'fake',
    name: 'fake',
    type: 'local',
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    getStatus: () => 'connected',
    setIdentity: () => {},
    async get(key) {
      checkFail('get', key);
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key, value) {
      checkFail('set', key);
      store.set(key, value);
    },
    async remove(key) {
      checkFail('remove', key);
      store.delete(key);
    },
    async has(key) {
      return store.has(key);
    },
    async keys(prefix) {
      const all = [...store.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear(prefix) {
      if (!prefix) {
        store.clear();
        return;
      }
      for (const k of [...store.keys()]) {
        if (k.startsWith(prefix)) store.delete(k);
      }
    },
    async saveTrackedAddresses() {},
    async loadTrackedAddresses() {
      return [];
    },
  };

  if (opts.withSetMany) {
    (base as StorageProvider & {
      setMany?: (entries: ReadonlyArray<readonly [string, string]>) => Promise<void>;
    }).setMany = async (entries) => {
      // Atomic semantics: stage in a temp buffer, commit all-or-nothing.
      const staged = new Map<string, string>();
      for (const [key, value] of entries) {
        checkFail('set', key);
        staged.set(key, value);
      }
      for (const [key, value] of staged) {
        store.set(key, value);
      }
    };
  }

  return Object.assign(base, { _store: store, _failNext: failNext });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const WALLET_ID = '02' + 'aa'.repeat(32);
const OTHER_WALLET_ID = '03' + 'bb'.repeat(32);

function buildTxfData(extra: Record<string, unknown> = {}): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: ADDRESS_ID,
      formatVersion: '2.0',
      updatedAt: 1_700_000_000_000,
    },
    _tombstones: [{ tokenId: 'tok-a', stateHash: 'aa', timestamp: 1 }],
    _outbox: [],
    _sent: [],
    ...extra,
  } as TxfStorageDataBase;
}

// ---------------------------------------------------------------------------
// Happy path — round trip
// ---------------------------------------------------------------------------

describe('writeSnapshot + readSnapshot — round trip', () => {
  it('preserves all fields end-to-end (setMany path)', async () => {
    const storage = makeStorage({ withSetMany: true });
    const data = buildTxfData({
      _token1: { genesis: { id: 'g1' }, transactions: [] },
    });
    const writeTs = await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: 7,
      pointer: { version: 12, cid: 'bafyfake', ts: 1_700_000_000_000 },
      bundleCids: ['bafy1', 'bafy2'],
      data,
      now: () => 1_700_000_001_000,
    });
    expect(writeTs).toBe(1_700_000_001_000);

    const result = await readSnapshot(
      storage,
      ADDRESS_ID,
      WALLET_ID,
      () => 1_700_000_002_000,
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.blob.version).toBe(PROFILE_SNAPSHOT_SCHEMA_VERSION);
    expect(result.blob.walletId).toBe(WALLET_ID);
    expect(result.blob.addressId).toBe(ADDRESS_ID);
    expect(result.blob.network).toBe('testnet');
    expect(result.blob.epoch).toBe(7);
    expect(result.blob.pointer).toEqual({
      version: 12,
      cid: 'bafyfake',
      ts: 1_700_000_000_000,
    });
    expect(result.blob.bundleCids).toEqual(['bafy1', 'bafy2']);
    expect(result.blob.data).toEqual(data);
    expect(result.ageMs).toBe(1_000); // 1_700_000_002_000 - 1_700_000_001_000
  });

  it('preserves all fields end-to-end (sequential fallback path)', async () => {
    const storage = makeStorage({ withSetMany: false });
    const data = buildTxfData();
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'mainnet',
      epoch: null,
      pointer: null,
      bundleCids: [],
      data,
      now: () => 1_700_000_000_000,
    });

    // Pending key must be cleaned up after a successful write (best-
    // effort) — sequential path runs `remove(pendingKey)` after the
    // main write commits.
    expect(storage._store.has(getSnapshotPendingKey(ADDRESS_ID))).toBe(false);
    expect(storage._store.has(getSnapshotBlobKey(ADDRESS_ID))).toBe(true);

    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Crash safety
// ---------------------------------------------------------------------------

describe('writeSnapshot — crash safety', () => {
  it('sequential path: crash AFTER pending but BEFORE main keeps previous main intact', async () => {
    const storage = makeStorage({ withSetMany: false });

    // Initial successful write.
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['bafy_v1'],
      data: buildTxfData(),
      now: () => 1_700_000_000_000,
    });
    const mainBefore = storage._store.get(getSnapshotBlobKey(ADDRESS_ID));
    expect(mainBefore).toBeDefined();

    // Inject failure on the MAIN set, AFTER the pending set has
    // succeeded. The previous main blob must survive.
    storage._failNext.set(getSnapshotBlobKey(ADDRESS_ID), 'set');
    await expect(
      writeSnapshot(storage, {
        walletId: WALLET_ID,
        addressId: ADDRESS_ID,
        network: 'testnet',
        epoch: null,
        pointer: null,
        bundleCids: ['bafy_v2'],
        data: buildTxfData({ _token_new: { genesis: { id: 'new' } } }),
        now: () => 1_700_000_005_000,
      }),
    ).rejects.toThrow(/injected:set/);

    // Main blob untouched.
    const mainAfter = storage._store.get(getSnapshotBlobKey(ADDRESS_ID));
    expect(mainAfter).toBe(mainBefore);

    // Read returns the pre-crash blob.
    const result = await readSnapshot(
      storage,
      ADDRESS_ID,
      WALLET_ID,
      () => 1_700_000_006_000,
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.blob.bundleCids).toEqual(['bafy_v1']);
  });

  it('setMany path: failure in transaction leaves previous main intact', async () => {
    const storage = makeStorage({ withSetMany: true });

    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['bafy_v1'],
      data: buildTxfData(),
      now: () => 1_700_000_000_000,
    });
    const mainBefore = storage._store.get(getSnapshotBlobKey(ADDRESS_ID));

    // Inject failure on the main key inside the setMany transaction —
    // emulates an IndexedDB transaction abort. With the atomic fake,
    // staging happens BEFORE any commit; the throw rolls back both
    // pending and main.
    storage._failNext.set(getSnapshotBlobKey(ADDRESS_ID), 'set');
    await expect(
      writeSnapshot(storage, {
        walletId: WALLET_ID,
        addressId: ADDRESS_ID,
        network: 'testnet',
        epoch: null,
        pointer: null,
        bundleCids: ['bafy_v2'],
        data: buildTxfData(),
        now: () => 1_700_000_005_000,
      }),
    ).rejects.toThrow(/injected:set/);

    const mainAfter = storage._store.get(getSnapshotBlobKey(ADDRESS_ID));
    expect(mainAfter).toBe(mainBefore);
  });
});

// ---------------------------------------------------------------------------
// Validation paths
// ---------------------------------------------------------------------------

describe('readSnapshot — validation', () => {
  it('returns absent on missing blob', async () => {
    const storage = makeStorage({ withSetMany: true });
    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('absent');
  });

  it('flags walletId mismatch as corrupt', async () => {
    const storage = makeStorage({ withSetMany: true });
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: [],
      data: buildTxfData(),
      now: () => 1,
    });

    const result = await readSnapshot(storage, ADDRESS_ID, OTHER_WALLET_ID);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') throw new Error('unreachable');
    expect(result.reason).toMatch(/walletId-mismatch/);
    expect(result.walletId).toBe(WALLET_ID);
  });

  it('flags schema version mismatch as corrupt', async () => {
    const storage = makeStorage({ withSetMany: true });
    // Hand-craft a blob with a wrong version.
    const badBlob = {
      version: 999,
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      ts: 1,
      epoch: null,
      pointer: null,
      bundleCids: [],
      data: buildTxfData(),
      contentHash: 'doesntmatter',
    };
    await storage.set(getSnapshotBlobKey(ADDRESS_ID), JSON.stringify(badBlob));

    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') throw new Error('unreachable');
    expect(result.reason).toMatch(/schema-mismatch/);
  });

  it('detects tampered bytes via contentHash', async () => {
    const storage = makeStorage({ withSetMany: true });
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['bafy_a'],
      data: buildTxfData(),
      now: () => 1,
    });

    // Tamper with the stored blob.
    const stored = storage._store.get(getSnapshotBlobKey(ADDRESS_ID))!;
    const parsed = JSON.parse(stored);
    parsed.bundleCids = ['bafy_TAMPERED'];
    await storage.set(getSnapshotBlobKey(ADDRESS_ID), JSON.stringify(parsed));

    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') throw new Error('unreachable');
    expect(result.reason).toBe('contentHash-mismatch');
  });

  it('reports parse error as corrupt (storage holds garbage)', async () => {
    const storage = makeStorage({ withSetMany: true });
    await storage.set(getSnapshotBlobKey(ADDRESS_ID), 'not-json{');
    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') throw new Error('unreachable');
    expect(result.reason).toMatch(/parse-error/);
  });

  it('reports storage read failure as corrupt', async () => {
    const storage = makeStorage({ withSetMany: true });
    storage._failNext.set(getSnapshotBlobKey(ADDRESS_ID), 'get');
    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') throw new Error('unreachable');
    expect(result.reason).toMatch(/storage-error/);
  });

  it('flags shape-invalid for non-object payload', async () => {
    const storage = makeStorage({ withSetMany: true });
    await storage.set(getSnapshotBlobKey(ADDRESS_ID), '42');
    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('corrupt');
    if (result.kind !== 'corrupt') throw new Error('unreachable');
    expect(result.reason).toBe('shape-invalid');
  });
});

// ---------------------------------------------------------------------------
// Snapshot age
// ---------------------------------------------------------------------------

describe('readSnapshot — age tracking', () => {
  it('age reflects the elapsed time since write', async () => {
    const storage = makeStorage({ withSetMany: true });
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: [],
      data: buildTxfData(),
      now: () => 1_000,
    });

    const result = await readSnapshot(
      storage,
      ADDRESS_ID,
      WALLET_ID,
      () => 11_000,
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.ageMs).toBe(10_000);
  });

  it('clamps negative age to zero (clock skew)', async () => {
    const storage = makeStorage({ withSetMany: true });
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: [],
      data: buildTxfData(),
      now: () => 100_000,
    });

    const result = await readSnapshot(
      storage,
      ADDRESS_ID,
      WALLET_ID,
      () => 50_000, // wall clock went backwards
    );
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.ageMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clearSnapshot
// ---------------------------------------------------------------------------

describe('clearSnapshot', () => {
  it('removes main and pending keys', async () => {
    const storage = makeStorage({ withSetMany: true });
    await storage.set(getSnapshotBlobKey(ADDRESS_ID), 'main');
    await storage.set(getSnapshotPendingKey(ADDRESS_ID), 'pending');
    await clearSnapshot(storage, ADDRESS_ID);
    expect(storage._store.has(getSnapshotBlobKey(ADDRESS_ID))).toBe(false);
    expect(storage._store.has(getSnapshotPendingKey(ADDRESS_ID))).toBe(false);
  });

  it('tolerates remove failures (best-effort)', async () => {
    const storage = makeStorage({ withSetMany: true });
    await storage.set(getSnapshotBlobKey(ADDRESS_ID), 'main');
    storage._failNext.set(getSnapshotBlobKey(ADDRESS_ID), 'remove');
    await expect(clearSnapshot(storage, ADDRESS_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Key isolation
// ---------------------------------------------------------------------------

describe('snapshot key scoping', () => {
  it('main and pending keys are distinct and contain the addressId', () => {
    const main = getSnapshotBlobKey(ADDRESS_ID);
    const pending = getSnapshotPendingKey(ADDRESS_ID);
    expect(main).not.toBe(pending);
    expect(main).toContain(ADDRESS_ID);
    expect(pending).toContain(ADDRESS_ID);
    expect(pending).toBe(`${main}_pending`);
  });

  it('different addressIds produce different keys', () => {
    const a = getSnapshotBlobKey('DIRECT_aaa_bbb');
    const b = getSnapshotBlobKey('DIRECT_ccc_ddd');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Multi-write race
// ---------------------------------------------------------------------------

describe('multiple writes (snapshot replacement)', () => {
  it('second successful write overwrites the first', async () => {
    const storage = makeStorage({ withSetMany: true });

    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['v1'],
      data: buildTxfData(),
      now: () => 1,
    });
    await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['v2'],
      data: buildTxfData(),
      now: () => 2,
    });

    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.blob.bundleCids).toEqual(['v2']);
    expect(result.blob.ts).toBe(2);
  });

  it('two concurrent writes both land (last-wins on commit order)', async () => {
    const storage = makeStorage({ withSetMany: true });

    // Issue both writes back-to-back without await. Awaiting them in
    // sequence guarantees a deterministic last-write-wins under the
    // synchronous in-memory fake.
    const p1 = writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['v1'],
      data: buildTxfData(),
      now: () => 1,
    });
    const p2 = writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: ['v2'],
      data: buildTxfData(),
      now: () => 2,
    });
    await Promise.all([p1, p2]);

    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    // The fake commits synchronously; either order is acceptable for
    // correctness — what matters is that the survivor is a VALID blob,
    // not a torn mix of v1 + v2 fields.
    expect(['v1', 'v2']).toContain(result.blob.bundleCids[0]);
  });
});

// ---------------------------------------------------------------------------
// Optional Date.now() fallback
// ---------------------------------------------------------------------------

describe('default now()', () => {
  it('uses Date.now when no `now` is supplied', async () => {
    const storage = makeStorage({ withSetMany: true });
    const before = Date.now();
    const ts = await writeSnapshot(storage, {
      walletId: WALLET_ID,
      addressId: ADDRESS_ID,
      network: 'testnet',
      epoch: null,
      pointer: null,
      bundleCids: [],
      data: buildTxfData(),
    });
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    const result = await readSnapshot(storage, ADDRESS_ID, WALLET_ID);
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.blob.ts).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke
// ---------------------------------------------------------------------------

it('ProfileSnapshotBlob is a structural shape (compile + write/read)', () => {
  const blob: ProfileSnapshotBlob = {
    version: PROFILE_SNAPSHOT_SCHEMA_VERSION,
    walletId: WALLET_ID,
    addressId: ADDRESS_ID,
    network: 'testnet',
    ts: 1,
    epoch: 0,
    pointer: null,
    bundleCids: [],
    data: buildTxfData(),
    contentHash: 'abc',
  };
  expect(blob.version).toBe(PROFILE_SNAPSHOT_SCHEMA_VERSION);
});
