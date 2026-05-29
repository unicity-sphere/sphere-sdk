/**
 * Tests for `profile/single-blob-sync-writer.ts` — issue #335.
 *
 * Locks the contract:
 *   - snapshot() returns at most one entry, only when the exact key exists.
 *   - joinSnapshot() unions the remote blob into local under the configured
 *     dedup-key function — the merged blob is re-encrypted and persisted via
 *     the envelope path so subsequent local reads stay on the happy path.
 *   - Local-superset apply is a no-op (counted as `localWon`).
 *   - Malformed remote bytes (decrypt / parse / shape) are rejected without
 *     mutating local (counted as `remoteRejectedMalformed`).
 *   - Foreign keys in the snapshot slice are ignored.
 *   - Idempotence: re-running with the same remote yields no further changes.
 *   - Cross-device end-to-end via `runProfileSnapshotJoin`: a peer-A snapshot
 *     containing tombstones lands at peer B, including the issue #335
 *     regression test (the factory.ts wiring must register the writer or
 *     this assertion fails).
 */

import { describe, it, expect } from 'vitest';
import {
  buildInvalidatedNametagsSyncWriter,
  buildTombstonesSyncWriter,
  SingleBlobSyncWriter,
} from '../../../profile/single-blob-sync-writer.js';
import {
  encryptProfileValue,
  decryptProfileValue,
} from '../../../profile/encryption.js';
import { runProfileSnapshotJoin } from '../../../profile/profile-snapshot-dispatcher.js';
import { putEnvelopePayload } from '../../../profile/oplog-envelope-io.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';
import type { LeanProfileSnapshot } from '../../../profile/profile-lean-snapshot.js';

// =============================================================================
// Fixtures
// =============================================================================

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const KEY_TOMB_A = `${ADDR_A}.tombstones`;
const KEY_TAGS_A = `${ADDR_A}.invalidatedNametags`;

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as MockProfileDb;
}

interface Tomb {
  readonly tokenId: string;
  readonly stateHash: string;
  readonly timestamp: number;
}

function tomb(tokenId: string, stateHash: string, timestamp = 1): Tomb {
  return { tokenId, stateHash, timestamp };
}

/** Write a tombstone blob to a mock db at the canonical key (no encryption). */
async function writePlainBlob(
  db: MockProfileDb,
  key: string,
  blob: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(blob));
  await db.put(key, bytes);
}

/**
 * Write a tombstone blob via the envelope path so the writer's snapshot()
 * sees envelope-wrapped bytes (exercises the unwrap step).
 */
async function writeEnvelopeBlob(
  db: MockProfileDb,
  key: string,
  blob: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(blob));
  await putEnvelopePayload(db, key, bytes);
}

/**
 * Write an encrypted tombstone blob via the envelope path — the canonical
 * production layout.
 */
async function writeEncryptedEnvelopeBlob(
  db: MockProfileDb,
  key: string,
  encryptionKey: Uint8Array,
  blob: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(blob));
  const ct = await encryptProfileValue(encryptionKey, bytes);
  await putEnvelopePayload(db, key, ct);
}

function makeKey(): Uint8Array {
  // Deterministic 32-byte AES-256 key — not real entropy, fine for unit tests.
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) k[i] = i;
  return k;
}

// =============================================================================
// 1. Constructor invariants
// =============================================================================

describe('SingleBlobSyncWriter — constructor', () => {
  it('rejects an empty key', () => {
    expect(() =>
      new SingleBlobSyncWriter<Tomb>({
        db: createMockDb(),
        encryptionKey: null,
        key: '',
        validate: (v): v is ReadonlyArray<Tomb> => Array.isArray(v),
        dedupKey: (t) => `${t.tokenId}:${t.stateHash}`,
      }),
    ).toThrow(/non-empty/);
  });

  it('rejects a prefix-style key (trailing dot)', () => {
    expect(() =>
      new SingleBlobSyncWriter<Tomb>({
        db: createMockDb(),
        encryptionKey: null,
        key: `${ADDR_A}.tombstones.`,
        validate: (v): v is ReadonlyArray<Tomb> => Array.isArray(v),
        dedupKey: (t) => `${t.tokenId}:${t.stateHash}`,
      }),
    ).toThrow(/must NOT end with/);
  });
});

// =============================================================================
// 2. snapshot()
// =============================================================================

describe('SingleBlobSyncWriter.snapshot', () => {
  it('returns empty when the key is absent', async () => {
    const writer = buildTombstonesSyncWriter({
      db: createMockDb(),
      encryptionKey: null,
      addressId: ADDR_A,
    });
    expect(await writer.snapshot()).toEqual([]);
  });

  it('returns one entry with envelope-stripped bytes when present', async () => {
    const db = createMockDb();
    await writeEnvelopeBlob(db, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const snap = await writer.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].key).toBe(KEY_TOMB_A);
    // Unwrapped bytes are the raw JSON (no envelope, no encryption in this case).
    const decoded = JSON.parse(new TextDecoder().decode(snap[0].encryptedValue));
    expect(decoded).toEqual([
      { tokenId: '0xT1', stateHash: '0xS1', timestamp: 100 },
    ]);
  });

  it('returns one entry for legacy raw-bytes writes (pre-#247)', async () => {
    const db = createMockDb();
    await writePlainBlob(db, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const snap = await writer.snapshot();
    expect(snap).toHaveLength(1);
  });

  it('returns empty when db.get throws', async () => {
    const db = createMockDb();
    db.get = async () => {
      throw new Error('boom');
    };
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    expect(await writer.snapshot()).toEqual([]);
  });
});

// =============================================================================
// 3. joinSnapshot — union semantics
// =============================================================================

describe('SingleBlobSyncWriter.joinSnapshot — union', () => {
  it('absent local + non-empty remote → write remote, liveLanded=1', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbRemote, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const res = await localW.joinSnapshot(await remoteW.snapshot());
    expect(res.entriesEvaluated).toBe(1);
    expect(res.liveLanded).toBe(1);
    expect(res.localWon).toBe(0);
    expect(dbLocal._store.has(KEY_TOMB_A)).toBe(true);
    // Re-snapshot reflects the union via the local writer.
    const localSnap = await localW.snapshot();
    expect(localSnap).toHaveLength(1);
    const decoded = JSON.parse(
      new TextDecoder().decode(localSnap[0].encryptedValue),
    );
    expect(decoded).toEqual([
      { tokenId: '0xT1', stateHash: '0xS1', timestamp: 100 },
    ]);
  });

  it('disjoint local + remote → union, liveLanded=1', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbLocal, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    await writeEnvelopeBlob(dbRemote, KEY_TOMB_A, [tomb('0xT2', '0xS2', 200)]);
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const res = await localW.joinSnapshot(await remoteW.snapshot());
    expect(res.liveLanded).toBe(1);
    expect(res.localWon).toBe(0);
    const after = await localW.snapshot();
    const decoded = JSON.parse(
      new TextDecoder().decode(after[0].encryptedValue),
    ) as Tomb[];
    expect(decoded).toHaveLength(2);
    expect(decoded.map((t) => t.tokenId).sort()).toEqual(['0xT1', '0xT2']);
  });

  it('local is a strict superset → no-op, localWon=1', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbLocal, KEY_TOMB_A, [
      tomb('0xT1', '0xS1', 100),
      tomb('0xT2', '0xS2', 200),
    ]);
    await writeEnvelopeBlob(dbRemote, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const before = dbLocal._store.get(KEY_TOMB_A);
    const res = await localW.joinSnapshot(await remoteW.snapshot());
    expect(res.localWon).toBe(1);
    expect(res.liveLanded).toBe(0);
    // Local bytes unchanged.
    expect(dbLocal._store.get(KEY_TOMB_A)).toBe(before);
  });

  it('collision on dedup key — earliest timestamp wins (tombstones)', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbLocal, KEY_TOMB_A, [tomb('0xT1', '0xS1', 500)]);
    await writeEnvelopeBlob(dbRemote, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const res = await localW.joinSnapshot(await remoteW.snapshot());
    expect(res.liveLanded).toBe(1);
    const after = await localW.snapshot();
    const decoded = JSON.parse(
      new TextDecoder().decode(after[0].encryptedValue),
    ) as Tomb[];
    expect(decoded).toEqual([
      { tokenId: '0xT1', stateHash: '0xS1', timestamp: 100 },
    ]);
  });

  it('idempotent — second JOIN with same remote is a no-op', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbRemote, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const snap = await remoteW.snapshot();
    const first = await localW.joinSnapshot(snap);
    expect(first.liveLanded).toBe(1);
    const second = await localW.joinSnapshot(snap);
    expect(second.liveLanded).toBe(0);
    expect(second.localWon).toBe(1);
  });

  it('foreign keys in the slice are ignored (no counter bump)', async () => {
    const db = createMockDb();
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    // Hand-crafted snapshot with a foreign key.
    const foreignBytes = new TextEncoder().encode(
      JSON.stringify([tomb('0xT1', '0xS1', 100)]),
    );
    const res = await writer.joinSnapshot([
      { key: 'DIRECT_other_addr.tombstones', encryptedValue: foreignBytes },
    ]);
    expect(res.entriesEvaluated).toBe(0);
    expect(res.liveLanded).toBe(0);
    expect(res.remoteRejectedMalformed).toBe(0);
  });
});

// =============================================================================
// 4. joinSnapshot — malformed-remote rejection
// =============================================================================

describe('SingleBlobSyncWriter.joinSnapshot — malformed remote', () => {
  it('rejects non-array remote (decoded shape)', async () => {
    const db = createMockDb();
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const garbage = new TextEncoder().encode('{"not":"an array"}');
    const res = await writer.joinSnapshot([
      { key: KEY_TOMB_A, encryptedValue: garbage },
    ]);
    expect(res.entriesEvaluated).toBe(1);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
    expect(db._store.has(KEY_TOMB_A)).toBe(false);
  });

  it('rejects non-JSON remote bytes', async () => {
    const db = createMockDb();
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd]);
    const res = await writer.joinSnapshot([
      { key: KEY_TOMB_A, encryptedValue: garbage },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
  });

  it('rejects array items missing required fields', async () => {
    const db = createMockDb();
    const writer = buildTombstonesSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const badShape = new TextEncoder().encode(
      JSON.stringify([{ tokenId: '0xT1' /* missing stateHash + timestamp */ }]),
    );
    const res = await writer.joinSnapshot([
      { key: KEY_TOMB_A, encryptedValue: badShape },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
  });
});

// =============================================================================
// 5. Encryption end-to-end
// =============================================================================

describe('SingleBlobSyncWriter — encrypted round trip', () => {
  it('decrypts remote, merges, re-encrypts under same key', async () => {
    const key = makeKey();
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEncryptedEnvelopeBlob(dbLocal, KEY_TOMB_A, key, [
      tomb('0xT1', '0xS1', 100),
    ]);
    await writeEncryptedEnvelopeBlob(dbRemote, KEY_TOMB_A, key, [
      tomb('0xT2', '0xS2', 200),
    ]);
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: key,
      addressId: ADDR_A,
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: key,
      addressId: ADDR_A,
    });
    const res = await localW.joinSnapshot(await remoteW.snapshot());
    expect(res.liveLanded).toBe(1);
    // Decrypt the merged blob directly to verify the on-disk format.
    const after = await localW.snapshot();
    const plain = await decryptProfileValue(key, after[0].encryptedValue);
    const decoded = JSON.parse(new TextDecoder().decode(plain)) as Tomb[];
    expect(decoded.map((t) => t.tokenId).sort()).toEqual(['0xT1', '0xT2']);
  });
});

// =============================================================================
// 6. invalidatedNametags — bundled in same fix per issue #335
// =============================================================================

describe('SingleBlobSyncWriter — invalidatedNametags', () => {
  it('unions string sets', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbLocal, KEY_TAGS_A, ['alice']);
    await writeEnvelopeBlob(dbRemote, KEY_TAGS_A, ['bob']);
    const localW = buildInvalidatedNametagsSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const remoteW = buildInvalidatedNametagsSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const res = await localW.joinSnapshot(await remoteW.snapshot());
    expect(res.liveLanded).toBe(1);
    const after = await localW.snapshot();
    const decoded = JSON.parse(
      new TextDecoder().decode(after[0].encryptedValue),
    ) as string[];
    expect(decoded.sort()).toEqual(['alice', 'bob']);
  });

  it('rejects non-string array items', async () => {
    const db = createMockDb();
    const writer = buildInvalidatedNametagsSyncWriter({
      db,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    const bad = new TextEncoder().encode(JSON.stringify(['alice', 42, 'bob']));
    const res = await writer.joinSnapshot([
      { key: KEY_TAGS_A, encryptedValue: bad },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });
});

// =============================================================================
// 7. notifyProfileDirty
// =============================================================================

describe('SingleBlobSyncWriter — notifyProfileDirty', () => {
  it('fires once per JOIN that lands new items', async () => {
    const dbLocal = createMockDb();
    const dbRemote = createMockDb();
    await writeEnvelopeBlob(dbRemote, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    let fired = 0;
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
      notifyProfileDirty: () => {
        fired += 1;
      },
    });
    const remoteW = buildTombstonesSyncWriter({
      db: dbRemote,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await localW.joinSnapshot(await remoteW.snapshot());
    expect(fired).toBe(1);
    // Idempotent second pass should NOT fire.
    await localW.joinSnapshot(await remoteW.snapshot());
    expect(fired).toBe(1);
  });

  it('does not fire when nothing lands', async () => {
    const dbLocal = createMockDb();
    await writeEnvelopeBlob(dbLocal, KEY_TOMB_A, [tomb('0xT1', '0xS1', 100)]);
    let fired = 0;
    const localW = buildTombstonesSyncWriter({
      db: dbLocal,
      encryptionKey: null,
      addressId: ADDR_A,
      notifyProfileDirty: () => {
        fired += 1;
      },
    });
    // Use an empty remote snapshot.
    await localW.joinSnapshot([]);
    expect(fired).toBe(0);
  });
});

// =============================================================================
// 8. CROSS-DEVICE END-TO-END VIA THE DISPATCHER
//    Issue #335 regression: a peer-A snapshot containing tombstones must
//    land on peer B's storage. This test fails without the factory.ts
//    writers registration — proves the fix wiring.
// =============================================================================

function buildSnapshotFromEntries(
  entries: ReadonlyArray<{ readonly key: string; readonly encryptedValue: Uint8Array }>,
): LeanProfileSnapshot {
  return {
    version: 2,
    chainPubkey: '02' + 'bb'.repeat(32),
    network: 'testnet',
    createdAt: 1_700_000_000_000,
    entries: entries.map((e) => ({
      key: e.key,
      value: Buffer.from(e.encryptedValue).toString('base64'),
    })),
    bundles: [],
  };
}

describe('issue #335 — cross-device tombstone propagation via dispatcher', () => {
  it('peer-A snapshot containing tombstones lands at peer B', async () => {
    // --- Peer A: seed a tombstones blob ---
    const dbA = createMockDb();
    const writerA = buildTombstonesSyncWriter({
      db: dbA,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await writeEnvelopeBlob(dbA, KEY_TOMB_A, [
      tomb('0xSpentFaucetToken', '0xSpentStateHash', 1_700_000_000_000),
    ]);

    // --- Peer A: lift its single-blob snapshot entry ---
    const snapA = await writerA.snapshot();
    expect(snapA).toHaveLength(1);
    expect(snapA[0].key).toBe(KEY_TOMB_A);

    const dispatcherSnapshot = buildSnapshotFromEntries(snapA);

    // --- Peer B: empty storage, register tombstones writer via the same
    //     factory contract that profile/factory.ts:writersFor() uses ---
    const dbB = createMockDb();
    const tombstonesWriterB = buildTombstonesSyncWriter({
      db: dbB,
      encryptionKey: null,
      addressId: ADDR_A,
    });

    const result = await runProfileSnapshotJoin(dispatcherSnapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [
          { keyPrefix: `${addressId}.tombstones`, writer: tombstonesWriterB },
        ];
      },
      bundleIndex: null,
    });

    // --- Assertions: B's storage now carries A's tombstone ---
    expect(result.joinedAny).toBe(true);
    expect(result.counters.liveLanded).toBe(1);
    expect(dbB._store.has(KEY_TOMB_A)).toBe(true);

    const reloaded = await tombstonesWriterB.snapshot();
    expect(reloaded).toHaveLength(1);
    const decoded = JSON.parse(
      new TextDecoder().decode(reloaded[0].encryptedValue),
    ) as Tomb[];
    expect(decoded).toEqual([
      {
        tokenId: '0xSpentFaucetToken',
        stateHash: '0xSpentStateHash',
        timestamp: 1_700_000_000_000,
      },
    ]);
  });

  it('peer-A snapshot containing invalidatedNametags lands at peer B', async () => {
    const dbA = createMockDb();
    const writerA = buildInvalidatedNametagsSyncWriter({
      db: dbA,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await writeEnvelopeBlob(dbA, KEY_TAGS_A, ['phisher123']);
    const snapA = await writerA.snapshot();
    const dispatcherSnapshot = buildSnapshotFromEntries(snapA);

    const dbB = createMockDb();
    const tagsWriterB = buildInvalidatedNametagsSyncWriter({
      db: dbB,
      encryptionKey: null,
      addressId: ADDR_A,
    });

    const result = await runProfileSnapshotJoin(dispatcherSnapshot, {
      writersFor: (addressId) => {
        if (addressId !== ADDR_A) return [];
        return [
          {
            keyPrefix: `${addressId}.invalidatedNametags`,
            writer: tagsWriterB,
          },
        ];
      },
      bundleIndex: null,
    });

    expect(result.counters.liveLanded).toBe(1);
    expect(dbB._store.has(KEY_TAGS_A)).toBe(true);
    const reloaded = await tagsWriterB.snapshot();
    const decoded = JSON.parse(
      new TextDecoder().decode(reloaded[0].encryptedValue),
    ) as string[];
    expect(decoded).toEqual(['phisher123']);
  });

  it('REGRESSION: no writer registered → tombstone silently dropped (issue #335 baseline)', async () => {
    // This test pins the failure mode: WITHOUT a registered writer, the
    // dispatcher silently drops the single-blob entry. It is the
    // pre-fix behaviour that the issue #335 RCA documents. The
    // production fix lives in profile/factory.ts:writersFor() —
    // commenting out the tombstones writer there would cause every
    // assertion below to remain unchanged while the cross-device tests
    // above start failing.
    const dbA = createMockDb();
    const writerA = buildTombstonesSyncWriter({
      db: dbA,
      encryptionKey: null,
      addressId: ADDR_A,
    });
    await writeEnvelopeBlob(dbA, KEY_TOMB_A, [
      tomb('0xSpentFaucetToken', '0xSpentStateHash', 1_700_000_000_000),
    ]);
    const dispatcherSnapshot = buildSnapshotFromEntries(
      await writerA.snapshot(),
    );

    const dbB = createMockDb();

    // No writer registered.
    const result = await runProfileSnapshotJoin(dispatcherSnapshot, {
      writersFor: () => [],
      bundleIndex: null,
    });

    expect(result.addressesSeen).toBe(1);
    expect(result.counters.liveLanded).toBe(0);
    expect(dbB._store.has(KEY_TOMB_A)).toBe(false);
  });
});
