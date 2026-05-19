/**
 * Tests for `profile/prefix-sync-writer.ts` — Item #15 Phase B helper
 * for content-immutable (constant-Lamport) per-entry-key writers.
 *
 * Locks the contract:
 *   - snapshot() returns every key under the prefix (live + tombs).
 *   - joinSnapshot() applies the Phase B merge table with implicit
 *     `lamport=0` semantics:
 *       - absent + live      → write
 *       - live   + live      → no-op (idempotent)
 *       - live   + tombstone → tombstone wins (sticky at 0=0)
 *       - tombstone + live   → tombstone preserved (sticky at 0=0)
 *       - tombstone + tombstone → no-op
 *   - validateValue rejects non-conforming remote payloads as
 *     malformed.
 *   - Encryption end-to-end with shared key.
 */

import { describe, it, expect } from 'vitest';
import { PrefixSyncWriter } from '../../../profile/prefix-sync-writer.js';
import { encryptProfileValue } from '../../../profile/encryption.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';
const PREFIX_A = `${ADDR_A}.finalizationQueue.`;
const PREFIX_B = `${ADDR_B}.finalizationQueue.`;

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
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
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

function jsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function tombBytes(deletedAt = 1): Uint8Array {
  return jsonBytes({ tombstoned: true, deletedAt });
}

// =============================================================================
// 1. snapshot() — prefix scan
// =============================================================================

describe('PrefixSyncWriter.snapshot', () => {
  it('returns empty array on empty store', async () => {
    const writer = new PrefixSyncWriter({
      db: createMockDb(),
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    expect(await writer.snapshot()).toEqual([]);
  });

  it('returns every key under the prefix, sorted', async () => {
    const db = createMockDb();
    await db.put(`${PREFIX_A}z`, jsonBytes({ foo: 'z' }));
    await db.put(`${PREFIX_A}a`, jsonBytes({ foo: 'a' }));
    await db.put(`${PREFIX_A}m`, jsonBytes({ foo: 'm' }));
    const writer = new PrefixSyncWriter({
      db,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const snap = await writer.snapshot();
    expect(snap.map((e) => e.key)).toEqual([
      `${PREFIX_A}a`,
      `${PREFIX_A}m`,
      `${PREFIX_A}z`,
    ]);
  });

  it('includes tombstones', async () => {
    const db = createMockDb();
    await db.put(`${PREFIX_A}a`, jsonBytes({ foo: 'a' }));
    await db.put(`${PREFIX_A}b`, tombBytes());
    const writer = new PrefixSyncWriter({
      db,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const snap = await writer.snapshot();
    expect(snap).toHaveLength(2);
  });

  it('does not leak entries from other prefixes', async () => {
    const db = createMockDb();
    await db.put(`${PREFIX_A}a1`, jsonBytes({ foo: 'a' }));
    await db.put(`${PREFIX_B}b1`, jsonBytes({ foo: 'b' }));
    const writerA = new PrefixSyncWriter({
      db,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const snap = await writerA.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].key).toBe(`${PREFIX_A}a1`);
  });

  it('returns empty array on db.all throw', async () => {
    const db = createMockDb();
    db.all = async () => {
      throw new Error('boom');
    };
    const writer = new PrefixSyncWriter({
      db,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    expect(await writer.snapshot()).toEqual([]);
  });

  it('throws when keyPrefix is empty', () => {
    expect(
      () =>
        new PrefixSyncWriter({
          db: createMockDb(),
          encryptionKey: null,
          keyPrefix: '',
        }),
    ).toThrow(/keyPrefix/);
  });
});

// =============================================================================
// 2. joinSnapshot — merge table (constant-Lamport)
// =============================================================================

describe('PrefixSyncWriter.joinSnapshot — merge table', () => {
  function buildWriter(db: MockProfileDb) {
    return new PrefixSyncWriter({
      db,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
  }

  it('absent + live → write remote', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbB.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'remote' }));
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(1);
    expect(res.localWon).toBe(0);
    expect(dbA._store.has(`${PREFIX_A}r1`)).toBe(true);
  });

  it('absent + tombstone → write remote tombstone', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbB.put(`${PREFIX_A}r1`, tombBytes());
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.tombstonesLanded).toBe(1);
    expect(dbA._store.has(`${PREFIX_A}r1`)).toBe(true);
  });

  it('live + live (same content) → no-op (idempotent)', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbA.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'shared' }));
    await dbB.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'shared' }));
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(0);
    expect(res.localWon).toBe(1);
    // Local bytes unchanged.
    const dec = JSON.parse(new TextDecoder().decode(dbA._store.get(`${PREFIX_A}r1`)!));
    expect(dec.foo).toBe('shared');
  });

  it('live + live (different content at same Lamport=0) → no-op (local wins)', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbA.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'local' }));
    await dbB.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'remote' }));
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    // At lamport=0=0 ties, local always wins via mergeSlots.
    expect(res.localWon).toBe(1);
    expect(res.liveLanded).toBe(0);
    const dec = JSON.parse(new TextDecoder().decode(dbA._store.get(`${PREFIX_A}r1`)!));
    expect(dec.foo).toBe('local');
  });

  it('live + tombstone → tombstone wins (sticky at Lamport=0)', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbA.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'live' }));
    await dbB.put(`${PREFIX_A}r1`, tombBytes());
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.tombstonesLanded).toBe(1);
    const dec = JSON.parse(new TextDecoder().decode(dbA._store.get(`${PREFIX_A}r1`)!));
    expect(dec.tombstoned).toBe(true);
  });

  it('tombstone + live → tombstone preserved (sticky)', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbA.put(`${PREFIX_A}r1`, tombBytes());
    await dbB.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'live' }));
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.localWon).toBe(1);
    const dec = JSON.parse(new TextDecoder().decode(dbA._store.get(`${PREFIX_A}r1`)!));
    expect(dec.tombstoned).toBe(true);
  });

  it('tombstone + tombstone → no-op', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbA.put(`${PREFIX_A}r1`, tombBytes(100));
    await dbB.put(`${PREFIX_A}r1`, tombBytes(200));
    const writerA = buildWriter(dbA);
    const writerB = buildWriter(dbB);
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.localWon).toBe(1);
    const dec = JSON.parse(new TextDecoder().decode(dbA._store.get(`${PREFIX_A}r1`)!));
    expect(dec.deletedAt).toBe(100); // local preserved
  });
});

// =============================================================================
// 3. Idempotence + bidirectional convergence
// =============================================================================

describe('PrefixSyncWriter.joinSnapshot — idempotence', () => {
  it('re-running JOIN with the same remote yields no-op the second time', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbB.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'a' }));
    await dbB.put(`${PREFIX_A}r2`, jsonBytes({ foo: 'b' }));
    const writerA = new PrefixSyncWriter({
      db: dbA,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const writerB = new PrefixSyncWriter({
      db: dbB,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const snap = await writerB.snapshot();

    const first = await writerA.joinSnapshot(snap);
    expect(first.liveLanded).toBe(2);
    const second = await writerA.joinSnapshot(snap);
    expect(second.liveLanded).toBe(0);
    expect(second.localWon).toBe(2);
  });
});

describe('PrefixSyncWriter.joinSnapshot — bidirectional convergence', () => {
  it('non-overlapping union — both peers see both keys', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbA.put(`${PREFIX_A}a-only`, jsonBytes({ foo: 'a' }));
    await dbB.put(`${PREFIX_A}b-only`, jsonBytes({ foo: 'b' }));
    const writerA = new PrefixSyncWriter({
      db: dbA,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const writerB = new PrefixSyncWriter({
      db: dbB,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    await writerA.joinSnapshot(await writerB.snapshot());
    await writerB.joinSnapshot(await writerA.snapshot());
    expect(dbA._store.has(`${PREFIX_A}b-only`)).toBe(true);
    expect(dbB._store.has(`${PREFIX_A}a-only`)).toBe(true);
  });
});

// =============================================================================
// 4. validateValue hook
// =============================================================================

describe('PrefixSyncWriter — validateValue', () => {
  it('rejects remote payloads that fail the validator', async () => {
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbB.put(`${PREFIX_A}r1`, jsonBytes({ foo: 'no-schema' }));
    await dbB.put(`${PREFIX_A}r2`, jsonBytes({ _schemaVersion: 'uxf-1', foo: 'ok' }));
    const writerA = new PrefixSyncWriter({
      db: dbA,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
      validateValue: (v) =>
        v !== null &&
        typeof v === 'object' &&
        (v as { _schemaVersion?: unknown })._schemaVersion === 'uxf-1',
    });
    const writerB = new PrefixSyncWriter({
      db: dbB,
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(1);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(dbA._store.has(`${PREFIX_A}r1`)).toBe(false);
    expect(dbA._store.has(`${PREFIX_A}r2`)).toBe(true);
  });
});

// =============================================================================
// 5. Malformed handling
// =============================================================================

describe('PrefixSyncWriter.joinSnapshot — malformed remote', () => {
  it('garbage bytes → counted as remoteRejectedMalformed', async () => {
    const writerA = new PrefixSyncWriter({
      db: createMockDb(),
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const res = await writerA.joinSnapshot([
      { key: `${PREFIX_A}r1`, encryptedValue: new TextEncoder().encode('not-json{') },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('foreign-prefix key → rejected', async () => {
    const writerA = new PrefixSyncWriter({
      db: createMockDb(),
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const res = await writerA.joinSnapshot([
      { key: `${PREFIX_B}r1`, encryptedValue: jsonBytes({ foo: 'x' }) },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('empty bytes → rejected', async () => {
    const writerA = new PrefixSyncWriter({
      db: createMockDb(),
      encryptionKey: null,
      keyPrefix: PREFIX_A,
    });
    const res = await writerA.joinSnapshot([
      { key: `${PREFIX_A}r1`, encryptedValue: new Uint8Array(0) },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });
});

// =============================================================================
// 6. Encryption end-to-end
// =============================================================================

describe('PrefixSyncWriter — with encryption', () => {
  it('encrypted snapshot JOINs into encrypted local store (shared key)', async () => {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 1;
    const dbA = createMockDb();
    const dbB = createMockDb();
    // Encrypt + plant on B.
    await dbB.put(
      `${PREFIX_A}r1`,
      await encryptProfileValue(key, jsonBytes({ foo: 'r1' })),
    );
    const writerA = new PrefixSyncWriter({
      db: dbA,
      encryptionKey: key,
      keyPrefix: PREFIX_A,
    });
    const writerB = new PrefixSyncWriter({
      db: dbB,
      encryptionKey: key,
      keyPrefix: PREFIX_A,
    });
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(1);
    expect(dbA._store.has(`${PREFIX_A}r1`)).toBe(true);
  });

  it('encrypted snapshot from wrong-key peer → rejected', async () => {
    const keyA = new Uint8Array(32);
    const keyB = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      keyA[i] = i + 1;
      keyB[i] = i + 100;
    }
    const dbA = createMockDb();
    const dbB = createMockDb();
    await dbB.put(
      `${PREFIX_A}r1`,
      await encryptProfileValue(keyB, jsonBytes({ foo: 'r1' })),
    );
    const writerA = new PrefixSyncWriter({
      db: dbA,
      encryptionKey: keyA,
      keyPrefix: PREFIX_A,
    });
    const writerB = new PrefixSyncWriter({
      db: dbB,
      encryptionKey: keyB,
      keyPrefix: PREFIX_A,
    });
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.remoteRejectedMalformed).toBe(1);
  });
});
