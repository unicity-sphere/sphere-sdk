/**
 * Tests for sync-writer integration on
 * `OrbitDbDispositionStorageAdapter` (Item #15 Phase B.4).
 *
 * Locks the wiring:
 *   - `syncWritersFor` returns four PrefixSyncWriter instances bound to
 *     the correct per-address prefixes (`invalid.`, `invalid-orphan.`,
 *     `audit.`, `audit-orphan.`).
 *   - Records stamped by the adapter's `writeRecord` method are
 *     propagated via the sync writers (snapshot + JOIN round-trip).
 *   - Tombstones are sticky across JOIN.
 *   - The orphan prefix is scope-isolated from the non-orphan prefix
 *     even when their key suffixes are identical.
 *   - `notifyProfileDirty` fires on JOIN-applied remote landings.
 *
 * The manifest surface (`${addr}.manifest.`) is intentionally NOT
 * exercised here — per the B.4 scope decision it is DEFERRED (current
 * production storage is in-memory only; per-field merge in
 * `mergeManifestEntry` is incompatible with byte-verbatim JOIN). See
 * `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` item #15 "Deferred — B.4 manifest".
 */

import { describe, it, expect, vi } from 'vitest';
import {
  OrbitDbDispositionStorageAdapter,
  dispositionAuditOrphanPrefix,
  dispositionAuditPrefix,
  dispositionInvalidOrphanPrefix,
  dispositionInvalidPrefix,
} from '../../../extensions/uxf/profile/disposition-storage-adapters.js';
import { deriveProfileEncryptionKey } from '../../../extensions/uxf/profile/encryption.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../extensions/uxf/profile/types.js';

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';

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

async function deriveKey(seed: string): Promise<Uint8Array> {
  return deriveProfileEncryptionKey(new TextEncoder().encode(seed), 'sync-test');
}

// Helper: sample invalid / audit records. The disposition writer
// records are heterogeneous (different fields per failure mode); for
// these JOIN tests we just need plain-object JSON-serializable values
// that the default validator accepts.
function sampleInvalidRecord(tokenId: string): {
  readonly tokenId: string;
  readonly reason: string;
  readonly observedAt: number;
} {
  return { tokenId, reason: 'BUNDLE_REF_CORRUPT', observedAt: 1700000000 };
}

function sampleAuditRecord(tokenId: string): {
  readonly tokenId: string;
  readonly auditStatus: 'audit-recorded';
  readonly observedAt: number;
} {
  return { tokenId, auditStatus: 'audit-recorded', observedAt: 1700000000 };
}

// =============================================================================
// 1. syncWritersFor — wiring
// =============================================================================

describe('OrbitDbDispositionStorageAdapter.syncWritersFor', () => {
  it('returns four writers covering the four prefixes', async () => {
    const key = await deriveKey('alice-seed');
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
    });
    const writers = adapter.syncWritersFor(ADDR_A);
    expect(writers.invalid).toBeDefined();
    expect(writers.invalidOrphan).toBeDefined();
    expect(writers.audit).toBeDefined();
    expect(writers.auditOrphan).toBeDefined();
  });

  it('throws on empty addressId', async () => {
    const key = await deriveKey('alice-seed');
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
    });
    expect(() => adapter.syncWritersFor('')).toThrow(TypeError);
  });

  it('prefix helpers match adapter-emitted key shapes', () => {
    // Sanity: assert prefix helpers match the key shapes
    // `invalidKeyFor` / `auditKeyFor` produce (without the suffix
    // disambiguator). Mirrors the disposition-writer.ts conventions.
    expect(dispositionInvalidPrefix(ADDR_A)).toBe(`${ADDR_A}.invalid.`);
    expect(dispositionInvalidOrphanPrefix(ADDR_A)).toBe(`${ADDR_A}.invalid-orphan.`);
    expect(dispositionAuditPrefix(ADDR_A)).toBe(`${ADDR_A}.audit.`);
    expect(dispositionAuditOrphanPrefix(ADDR_A)).toBe(`${ADDR_A}.audit-orphan.`);
  });
});

// =============================================================================
// 2. Snapshot — adapter writes are picked up by the sync writer
// =============================================================================

describe('OrbitDbDispositionStorageAdapter.syncWritersFor — snapshot', () => {
  it('invalid writer snapshot includes records written via writeRecord', async () => {
    const key = await deriveKey('snap-seed');
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
    });
    const k1 = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    const k2 = `${ADDR_A}.invalid.0xtok2.${'b'.repeat(64)}`;
    await adapter.writeRecord(k1, sampleInvalidRecord('0xtok1'));
    await adapter.writeRecord(k2, sampleInvalidRecord('0xtok2'));

    const writers = adapter.syncWritersFor(ADDR_A);
    const snap = await writers.invalid.snapshot();
    expect(snap.map((e) => e.key).sort()).toEqual([k1, k2]);
  });

  it('audit writer snapshot is scope-isolated from invalid writer', async () => {
    const key = await deriveKey('isolation-seed');
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
    });
    const invKey = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    const audKey = `${ADDR_A}.audit.0xtok1.${'a'.repeat(64)}`;
    await adapter.writeRecord(invKey, sampleInvalidRecord('0xtok1'));
    await adapter.writeRecord(audKey, sampleAuditRecord('0xtok1'));

    const writers = adapter.syncWritersFor(ADDR_A);
    const invSnap = await writers.invalid.snapshot();
    const audSnap = await writers.audit.snapshot();
    expect(invSnap.map((e) => e.key)).toEqual([invKey]);
    expect(audSnap.map((e) => e.key)).toEqual([audKey]);
  });

  it('orphan writer is scope-isolated from non-orphan writer (no double-dot overlap)', async () => {
    // Subtle: `invalid.` is a prefix of `invalid-orphan.` only if we
    // misuse the comparison (we do not — `${addr}.invalid.` does not
    // match `${addr}.invalid-orphan.foo`). Lock the contract.
    const key = await deriveKey('orphan-seed');
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
    });
    const orphanKey = `${ADDR_A}.invalid-orphan.${'c'.repeat(64)}`;
    const nonOrphanKey = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    await adapter.writeRecord(orphanKey, sampleInvalidRecord(''));
    await adapter.writeRecord(nonOrphanKey, sampleInvalidRecord('0xtok1'));

    const writers = adapter.syncWritersFor(ADDR_A);
    const orphanSnap = await writers.invalidOrphan.snapshot();
    const nonOrphanSnap = await writers.invalid.snapshot();
    expect(orphanSnap.map((e) => e.key)).toEqual([orphanKey]);
    expect(nonOrphanSnap.map((e) => e.key)).toEqual([nonOrphanKey]);
  });

  it('different addressId → different prefix scope', async () => {
    const key = await deriveKey('multiaddr-seed');
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
    });
    const kA = `${ADDR_A}.invalid.0xtokA.${'a'.repeat(64)}`;
    const kB = `${ADDR_B}.invalid.0xtokB.${'b'.repeat(64)}`;
    await adapter.writeRecord(kA, sampleInvalidRecord('0xtokA'));
    await adapter.writeRecord(kB, sampleInvalidRecord('0xtokB'));

    const writersA = adapter.syncWritersFor(ADDR_A);
    const writersB = adapter.syncWritersFor(ADDR_B);
    const snapA = await writersA.invalid.snapshot();
    const snapB = await writersB.invalid.snapshot();
    expect(snapA.map((e) => e.key)).toEqual([kA]);
    expect(snapB.map((e) => e.key)).toEqual([kB]);
  });
});

// =============================================================================
// 3. JOIN — two adapters sharing a key
// =============================================================================

describe('OrbitDbDispositionStorageAdapter.syncWritersFor — JOIN', () => {
  it('JOIN propagates invalid records between two adapters sharing a key', async () => {
    const key = await deriveKey('shared-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbDispositionStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbDispositionStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const k = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    await adapterB.writeRecord(k, sampleInvalidRecord('0xtok1'));

    const syncA = adapterA.syncWritersFor(ADDR_A).invalid;
    const syncB = adapterB.syncWritersFor(ADDR_A).invalid;
    const res = await syncA.joinSnapshot(await syncB.snapshot());
    expect(res.liveLanded).toBe(1);

    // Adapter A can now read the record through its public surface.
    const read = await adapterA.readRecord<{ tokenId: string }>(k);
    expect(read?.tokenId).toBe('0xtok1');
  });

  it('JOIN propagates audit records between two adapters sharing a key', async () => {
    const key = await deriveKey('audit-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbDispositionStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbDispositionStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const k = `${ADDR_A}.audit.0xtok1.${'a'.repeat(64)}`;
    await adapterB.writeRecord(k, sampleAuditRecord('0xtok1'));

    const syncA = adapterA.syncWritersFor(ADDR_A).audit;
    const syncB = adapterB.syncWritersFor(ADDR_A).audit;
    const res = await syncA.joinSnapshot(await syncB.snapshot());
    expect(res.liveLanded).toBe(1);

    const read = await adapterA.readRecord<{ auditStatus: string }>(k);
    expect(read?.auditStatus).toBe('audit-recorded');
  });

  it('JOIN is idempotent (re-running on same remote is a no-op)', async () => {
    const key = await deriveKey('idem-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbDispositionStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbDispositionStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const k = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    await adapterB.writeRecord(k, sampleInvalidRecord('0xtok1'));

    const syncA = adapterA.syncWritersFor(ADDR_A).invalid;
    const syncB = adapterB.syncWritersFor(ADDR_A).invalid;
    const first = await syncA.joinSnapshot(await syncB.snapshot());
    expect(first.liveLanded).toBe(1);

    const second = await syncA.joinSnapshot(await syncB.snapshot());
    // The second JOIN sees the remote live + local live at lamport=0,
    // which is a no-op (`localWon` per the constant-lamport semantics
    // of PrefixSyncWriter).
    expect(second.liveLanded).toBe(0);
    expect(second.localWon).toBe(1);
  });

  it('tombstones are sticky across JOIN', async () => {
    const key = await deriveKey('tomb-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbDispositionStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbDispositionStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const k = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;

    // A has a live record; B tombstones the same key.
    await adapterA.writeRecord(k, sampleInvalidRecord('0xtok1'));
    await adapterB.tombstone(k);

    const syncA = adapterA.syncWritersFor(ADDR_A).invalid;
    const syncB = adapterB.syncWritersFor(ADDR_A).invalid;
    const res = await syncA.joinSnapshot(await syncB.snapshot());
    expect(res.tombstonesLanded).toBe(1);

    // Adapter A's `readRecord` skips tombstones and returns undefined.
    const read = await adapterA.readRecord(k);
    expect(read).toBeUndefined();
  });

  it('orphan and non-orphan writers do NOT cross-pollinate via JOIN', async () => {
    // Plant orphan in B, non-orphan in A. JOIN only over invalid (non-
    // orphan) prefix MUST NOT pull the orphan record across.
    const key = await deriveKey('cross-seed');
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbDispositionStorageAdapter({
      db: dbA,
      encryptionKey: key,
    });
    const adapterB = new OrbitDbDispositionStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const orphanKey = `${ADDR_A}.invalid-orphan.${'c'.repeat(64)}`;
    const nonOrphanKey = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    await adapterB.writeRecord(orphanKey, sampleInvalidRecord(''));
    await adapterB.writeRecord(nonOrphanKey, sampleInvalidRecord('0xtok1'));

    const writersA = adapterA.syncWritersFor(ADDR_A);
    const writersB = adapterB.syncWritersFor(ADDR_A);

    // Snapshot the NON-orphan writer; JOIN it into A's non-orphan
    // writer. The orphan record must not appear in A.
    const res = await writersA.invalid.joinSnapshot(
      await writersB.invalid.snapshot(),
    );
    expect(res.liveLanded).toBe(1);
    expect(await adapterA.readRecord(orphanKey)).toBeUndefined();
    expect(await adapterA.readRecord(nonOrphanKey)).not.toBeUndefined();
  });
});

// =============================================================================
// 4. notifyProfileDirty — propagation to writers
// =============================================================================

describe('OrbitDbDispositionStorageAdapter — notifyProfileDirty propagation', () => {
  it('JOIN-applied remote landings fire the host notifier', async () => {
    const key = await deriveKey('notify-seed');
    const notifier = vi.fn();
    const dbA = createMockDb();
    const dbB = createMockDb();
    const adapterA = new OrbitDbDispositionStorageAdapter({
      db: dbA,
      encryptionKey: key,
      notifyProfileDirty: notifier,
    });
    const adapterB = new OrbitDbDispositionStorageAdapter({
      db: dbB,
      encryptionKey: key,
    });
    const k = `${ADDR_A}.invalid.0xtok1.${'a'.repeat(64)}`;
    await adapterB.writeRecord(k, sampleInvalidRecord('0xtok1'));

    const syncA = adapterA.syncWritersFor(ADDR_A).invalid;
    const syncB = adapterB.syncWritersFor(ADDR_A).invalid;
    const res = await syncA.joinSnapshot(await syncB.snapshot());
    expect(res.liveLanded).toBe(1);
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it('JOIN that lands NOTHING does NOT fire the notifier', async () => {
    const key = await deriveKey('quiet-seed');
    const notifier = vi.fn();
    const db = createMockDb();
    const adapter = new OrbitDbDispositionStorageAdapter({
      db,
      encryptionKey: key,
      notifyProfileDirty: notifier,
    });
    const sync = adapter.syncWritersFor(ADDR_A).invalid;
    const res = await sync.joinSnapshot([]);
    expect(res.liveLanded).toBe(0);
    expect(res.tombstonesLanded).toBe(0);
    expect(notifier).not.toHaveBeenCalled();
  });
});
