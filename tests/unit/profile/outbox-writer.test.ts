/**
 * Tests for `profile/outbox-writer.ts` — UXF Transfer Protocol §7 (T.6.A).
 *
 * Covers:
 *   1. Round-trip — write → readAll/readOne returns structurally-equal new entry.
 *   2. Lamport bump — every write/update bumps via the §7.1 invariant.
 *   3. Per-entry-key isolation — sibling writes/deletes do not interfere.
 *   4. Schema-sniff classification — legacy vs new entries coexist at the
 *      same prefix and are correctly routed by `readAll`.
 *   5. Idempotent classification — running the sniff twice yields the same shape.
 *   6. Tombstones — `delete()` excludes the entry from subsequent `readAll`.
 *   7. Snapshot — `UXF_OUTBOX_STATUSES` and `partitionStatus` lock the §7
 *      state machine surface.
 *
 * The `OutboxWriter` is exercised against a minimal in-memory `ProfileDatabase`
 * mock that mirrors the public surface (`put`, `get`, `del`, `all`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Lamport } from '../../../profile/lamport.js';
import {
  OutboxWriter,
  type OutboxWriteInput,
} from '../../../profile/outbox-writer.js';
import { SphereError } from '../../../core/errors.js';
import {
  classifyOutboxEntryShape,
  isLegacyOutboxEntry,
  isUxfTransferOutboxEntry,
  partitionStatus,
  UXF_OUTBOX_STATUSES,
  type LegacyOutboxEntry,
  type UxfOutboxStatus,
  type UxfTransferOutboxEntry,
} from '../../../types/uxf-outbox.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../profile/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADDR = 'DIRECT_aabbcc_ddeeff';
const KEY_PREFIX = `${ADDR}.outbox.`;

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

function buildBaseInput(id: string, overrides: Partial<OutboxWriteInput> = {}): OutboxWriteInput {
  const now = Date.now();
  return {
    id,
    bundleCid: `bafy-${id}`,
    tokenIds: ['0xtoken1', '0xtoken2'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'instant',
    status: 'packaging',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildLegacyEntry(id: string): LegacyOutboxEntry {
  return {
    id,
    status: 'pending',
    sourceTokenId: `0xsrc-${id}`,
    salt: 'a'.repeat(64),
    commitmentJson: '{}',
    recipientPubkey: '02' + 'b'.repeat(64),
    recipientNametag: 'bob',
    amount: '1000000',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

/** Write a raw value (unencrypted, JSON-encoded) directly to the mock db so
 *  we can plant pre-existing legacy entries without going through the writer.
 *  Tests run with `encryptionKey: null` so this matches what the writer
 *  reads. */
async function plantRaw(
  db: MockProfileDb,
  key: string,
  json: string,
): Promise<void> {
  await db.put(key, new TextEncoder().encode(json));
}

function buildWriter(db: MockProfileDb, lamport?: Lamport): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: lamport ?? new Lamport(),
  });
}

// ---------------------------------------------------------------------------
// 1. Round-trip
// ---------------------------------------------------------------------------

describe('OutboxWriter — round-trip', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('write() then readOne() returns the same entry shape with stamps applied', async () => {
    const writer = buildWriter(db);
    const input = buildBaseInput('id-A');
    const written = await writer.write(input);

    expect(written._schemaVersion).toBe('uxf-1');
    expect(written.id).toBe('id-A');
    expect(written.bundleCid).toBe('bafy-id-A');
    expect(written.lamport).toBe(1); // first write from a fresh Lamport(0)
    expect(written.submitRetryCount).toBe(0);

    const read = await writer.readOne('id-A');
    expect(read).not.toBeNull();
    expect(read!.shape).toBe('uxf-1');
    expect(read!.entry).toEqual(written);
  });

  it('write() persists at the canonical key shape `${addr}.outbox.${id}`', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('myEntry'));
    expect(db._store.has(`${KEY_PREFIX}myEntry`)).toBe(true);
  });

  it('readAll() returns inserted entries in stable lex-key order', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('idC'));
    await writer.write(buildBaseInput('idA'));
    await writer.write(buildBaseInput('idB'));

    const all = await writer.readAll();
    expect(all.map((c) => (c.shape === 'uxf-1' ? c.entry.id : '???'))).toEqual([
      'idA',
      'idB',
      'idC',
    ]);
  });

  it('readAllNew() filters to UXF entries; readAllLegacy() filters to legacy entries', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('idNew'));
    await plantRaw(
      db,
      `${KEY_PREFIX}idLegacy`,
      JSON.stringify(buildLegacyEntry('idLegacy')),
    );

    const newOnly = await writer.readAllNew();
    expect(newOnly).toHaveLength(1);
    expect(newOnly[0].id).toBe('idNew');

    const legacyOnly = await writer.readAllLegacy();
    expect(legacyOnly).toHaveLength(1);
    expect(legacyOnly[0].id).toBe('idLegacy');
  });
});

// ---------------------------------------------------------------------------
// 2. Lamport bump
// ---------------------------------------------------------------------------

describe('OutboxWriter — Lamport bump (§7.1)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('first write from Lamport(0) yields lamport=1', async () => {
    const writer = buildWriter(db, new Lamport(0));
    const written = await writer.write(buildBaseInput('id1'));
    expect(written.lamport).toBe(1);
  });

  it('successive writes from a fresh-prefix store increment monotonically', async () => {
    const writer = buildWriter(db, new Lamport(0));
    const a = await writer.write(buildBaseInput('idA'));
    const b = await writer.write(buildBaseInput('idB'));
    const c = await writer.write(buildBaseInput('idC'));
    expect(a.lamport).toBe(1);
    expect(b.lamport).toBe(2);
    expect(c.lamport).toBe(3);
  });

  it('observed remote Lamports are folded into max(local, observed) + 1', async () => {
    // Plant a remote-shaped entry with lamport=8 BEFORE the writer wakes up.
    // The W39 bounds rule allows observed up to 2×max(local,1); local=5
    // means bound=10, so observed=8 is within bounds.
    const remote: UxfTransferOutboxEntry = {
      _schemaVersion: 'uxf-1',
      id: 'idRemote',
      bundleCid: 'bafy-remote',
      tokenIds: [],
      deliveryMethod: 'car-over-nostr',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'sending',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1,
      updatedAt: 1,
      lamport: 8,
    };
    await plantRaw(db, `${KEY_PREFIX}idRemote`, JSON.stringify(remote));

    const writer = buildWriter(db, new Lamport(5));
    const written = await writer.write(buildBaseInput('idLocal'));
    // bumpFor sees observed=[8] from idRemote; max(5, 8) + 1 = 9.
    expect(written.lamport).toBe(9);
  });

  it('update() bumps the Lamport on every mutation', async () => {
    const writer = buildWriter(db, new Lamport(0));
    const v1 = await writer.write(buildBaseInput('idU'));
    expect(v1.lamport).toBe(1);

    const v2 = await writer.update('idU', (prev) => ({
      ...prev,
      status: 'sending',
    }));
    // After v1.lamport=1, observed=[1] → max(1,1)+1 = 2.
    expect(v2.lamport).toBe(2);
    expect(v2.status).toBe('sending');

    const v3 = await writer.update('idU', (prev) => ({
      ...prev,
      submitRetryCount: prev.submitRetryCount + 1,
    }));
    expect(v3.lamport).toBe(3);
    expect(v3.submitRetryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-entry-key isolation
// ---------------------------------------------------------------------------

describe('OutboxWriter — per-entry-key isolation', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('writing one entry leaves siblings untouched', async () => {
    const writer = buildWriter(db, new Lamport(0));
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('b'));
    await writer.write(buildBaseInput('c'));

    const beforeRaw = new Map(db._store);
    const aBefore = beforeRaw.get(`${KEY_PREFIX}a`);
    const cBefore = beforeRaw.get(`${KEY_PREFIX}c`);

    await writer.update('b', (prev) => ({ ...prev, status: 'sending' }));

    expect(db._store.get(`${KEY_PREFIX}a`)).toBe(aBefore);
    expect(db._store.get(`${KEY_PREFIX}c`)).toBe(cBefore);

    const all = await writer.readAll();
    const ids = all.map((c) => (c.shape === 'uxf-1' ? c.entry.id : '?'));
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('deleting one entry does not touch siblings', async () => {
    const writer = buildWriter(db, new Lamport(0));
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('b'));
    await writer.write(buildBaseInput('c'));

    await writer.delete('b');

    expect(db._store.has(`${KEY_PREFIX}a`)).toBe(true);
    expect(db._store.has(`${KEY_PREFIX}c`)).toBe(true);
    // Tombstone marker stays at b's key.
    expect(db._store.has(`${KEY_PREFIX}b`)).toBe(true);

    const all = await writer.readAll();
    expect(all).toHaveLength(2);
    expect(
      all
        .map((c) => (c.shape === 'uxf-1' ? c.entry.id : '?'))
        .sort(),
    ).toEqual(['a', 'c']);

    expect(await writer.readOne('b')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Schema-sniff classification — legacy + new coexist
// ---------------------------------------------------------------------------

describe('OutboxWriter — schema-sniff classification', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('readAll() returns both new + legacy entries with correct shape labels', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('idNew1'));
    await plantRaw(
      db,
      `${KEY_PREFIX}idLegacy1`,
      JSON.stringify(buildLegacyEntry('idLegacy1')),
    );
    await writer.write(buildBaseInput('idNew2'));
    await plantRaw(
      db,
      `${KEY_PREFIX}idLegacy2`,
      JSON.stringify(buildLegacyEntry('idLegacy2')),
    );

    const all = await writer.readAll();
    expect(all).toHaveLength(4);
    const byId: Record<string, string> = {};
    for (const c of all) {
      const id = c.shape === 'uxf-1' ? c.entry.id : c.entry.id;
      byId[id] = c.shape;
    }
    expect(byId).toEqual({
      idNew1: 'uxf-1',
      idNew2: 'uxf-1',
      idLegacy1: 'legacy',
      idLegacy2: 'legacy',
    });
  });

  it('classifyOutboxEntryShape is idempotent — same input yields same shape twice', () => {
    const newEntry: UxfTransferOutboxEntry = {
      _schemaVersion: 'uxf-1',
      id: 'x',
      bundleCid: 'b',
      tokenIds: [],
      deliveryMethod: 'car-over-nostr',
      recipient: '@a',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'packaging',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1,
      updatedAt: 1,
      lamport: 1,
    };
    const legacy = buildLegacyEntry('y');

    expect(classifyOutboxEntryShape(newEntry)).toBe('uxf-1');
    expect(classifyOutboxEntryShape(newEntry)).toBe('uxf-1');

    expect(classifyOutboxEntryShape(legacy)).toBe('legacy');
    expect(classifyOutboxEntryShape(legacy)).toBe('legacy');

    expect(classifyOutboxEntryShape(null)).toBe('unknown');
    expect(classifyOutboxEntryShape({ tombstoned: true })).toBe('unknown');
    expect(classifyOutboxEntryShape({ id: 'partial' })).toBe('unknown');
  });

  it('readOne() returns the correct shape label for legacy and new entries', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('idNew'));
    await plantRaw(
      db,
      `${KEY_PREFIX}idLegacy`,
      JSON.stringify(buildLegacyEntry('idLegacy')),
    );

    const n = await writer.readOne('idNew');
    const l = await writer.readOne('idLegacy');
    expect(n?.shape).toBe('uxf-1');
    expect(l?.shape).toBe('legacy');
  });

  it('readOne() returns null for absent ids and tombstoned ids', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('present'));
    await writer.delete('present');

    expect(await writer.readOne('present')).toBeNull();
    expect(await writer.readOne('never-existed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Tombstones
// ---------------------------------------------------------------------------

describe('OutboxWriter — tombstones', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('delete() excludes the entry from readAll', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('b'));
    expect((await writer.readAll()).length).toBe(2);

    await writer.delete('a');
    const remaining = await writer.readAll();
    expect(remaining.length).toBe(1);
    expect(
      remaining.map((c) => (c.shape === 'uxf-1' ? c.entry.id : '?')),
    ).toEqual(['b']);
  });

  it('delete is idempotent — calling delete twice does not throw', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('a'));
    await writer.delete('a');
    await expect(writer.delete('a')).resolves.toBeUndefined();
    expect(await writer.readOne('a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Update — error paths
// ---------------------------------------------------------------------------

describe('OutboxWriter — update error paths', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  it('update() throws OUTBOX_ENTRY_NOT_FOUND for missing id', async () => {
    const writer = buildWriter(db);
    await expect(
      writer.update('ghost', (prev) => prev),
    ).rejects.toThrow(SphereError);
    await expect(
      writer.update('ghost', (prev) => prev),
    ).rejects.toMatchObject({ code: 'OUTBOX_ENTRY_NOT_FOUND' });
  });

  it('update() throws OUTBOX_ENTRY_NOT_FOUND for tombstoned id', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('gone'));
    await writer.delete('gone');
    await expect(
      writer.update('gone', (prev) => prev),
    ).rejects.toMatchObject({ code: 'OUTBOX_ENTRY_NOT_FOUND' });
  });

  it('update() throws OUTBOX_ENTRY_NOT_FOUND for legacy-only id (writer does not mutate legacy)', async () => {
    const writer = buildWriter(db);
    await plantRaw(
      db,
      `${KEY_PREFIX}legacyOnly`,
      JSON.stringify(buildLegacyEntry('legacyOnly')),
    );
    await expect(
      writer.update('legacyOnly', (prev) => prev),
    ).rejects.toMatchObject({ code: 'OUTBOX_ENTRY_NOT_FOUND' });
  });

  it('update() rejects mutators that change entry.id', async () => {
    const writer = buildWriter(db);
    await writer.write(buildBaseInput('keepMe'));
    await expect(
      writer.update('keepMe', (prev) => ({ ...prev, id: 'somethingElse' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('write() rejects empty id', async () => {
    const writer = buildWriter(db);
    await expect(
      writer.write(buildBaseInput('') as OutboxWriteInput),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('constructor rejects empty addressId', () => {
    expect(
      () =>
        new OutboxWriter({
          db: createMockDb(),
          encryptionKey: null,
          addressId: '',
          lamport: new Lamport(),
        }),
    ).toThrow(SphereError);
  });
});

// ---------------------------------------------------------------------------
// 7. UxfOutboxStatus — snapshot + partition
// ---------------------------------------------------------------------------

describe('UxfOutboxStatus — stability snapshot (§7)', () => {
  /**
   * Sorted snapshot of the canonical 10 outbox statuses per
   * UXF-TRANSFER-PROTOCOL §7. Adding/removing/renaming any value
   * breaks this test, forcing an ADR + on-disk migration plan.
   */
  const EXPECTED_SORTED_STATUSES: ReadonlyArray<string> = [
    'delivered',
    'delivered-instant',
    'expired',
    'failed-permanent',
    'failed-transient',
    'finalized',
    'finalizing',
    'packaging',
    'pinned',
    'sending',
  ];

  it('contains exactly 10 values', () => {
    expect(UXF_OUTBOX_STATUSES).toHaveLength(10);
  });

  it('matches the canonical sorted snapshot from §7', () => {
    const actualSorted: ReadonlyArray<string> = [...UXF_OUTBOX_STATUSES].sort();
    expect(actualSorted).toEqual(EXPECTED_SORTED_STATUSES);
  });

  it('has no duplicates', () => {
    const unique = new Set<string>(UXF_OUTBOX_STATUSES);
    expect(unique.size).toBe(UXF_OUTBOX_STATUSES.length);
  });
});

describe('partitionStatus — three-tier partition (§7.1)', () => {
  it('classifies active states', () => {
    const active: ReadonlyArray<UxfOutboxStatus> = [
      'packaging',
      'pinned',
      'sending',
      'delivered',
      'delivered-instant',
      'finalizing',
    ];
    for (const s of active) expect(partitionStatus(s)).toBe('active');
  });

  it('classifies failed-transient as soft-terminal', () => {
    expect(partitionStatus('failed-transient')).toBe('soft-terminal');
  });

  it('classifies expired/finalized/failed-permanent as hard-terminal', () => {
    expect(partitionStatus('expired')).toBe('hard-terminal');
    expect(partitionStatus('finalized')).toBe('hard-terminal');
    expect(partitionStatus('failed-permanent')).toBe('hard-terminal');
  });

  it('exhaustively covers UXF_OUTBOX_STATUSES', () => {
    for (const s of UXF_OUTBOX_STATUSES) {
      const p = partitionStatus(s);
      expect(['active', 'soft-terminal', 'hard-terminal']).toContain(p);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Runtime guards
// ---------------------------------------------------------------------------

describe('isUxfTransferOutboxEntry / isLegacyOutboxEntry', () => {
  it('isUxfTransferOutboxEntry rejects null/undefined/non-objects', () => {
    expect(isUxfTransferOutboxEntry(null)).toBe(false);
    expect(isUxfTransferOutboxEntry(undefined)).toBe(false);
    expect(isUxfTransferOutboxEntry('hi')).toBe(false);
    expect(isUxfTransferOutboxEntry(42)).toBe(false);
    expect(isUxfTransferOutboxEntry({})).toBe(false);
  });

  it('isUxfTransferOutboxEntry accepts a structurally-complete entry', () => {
    const e: UxfTransferOutboxEntry = {
      _schemaVersion: 'uxf-1',
      id: 'x',
      bundleCid: 'b',
      tokenIds: [],
      deliveryMethod: 'car-over-nostr',
      recipient: '@a',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'packaging',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1,
      updatedAt: 1,
      lamport: 1,
    };
    expect(isUxfTransferOutboxEntry(e)).toBe(true);
  });

  it('isUxfTransferOutboxEntry rejects entries missing _schemaVersion', () => {
    const partial = {
      id: 'x',
      bundleCid: 'b',
      tokenIds: [],
      deliveryMethod: 'car-over-nostr',
      recipient: '@a',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'packaging',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1,
      updatedAt: 1,
      lamport: 1,
    };
    expect(isUxfTransferOutboxEntry(partial)).toBe(false);
  });

  it('isLegacyOutboxEntry rejects entries with _schemaVersion (uxf-1)', () => {
    const newShape = {
      _schemaVersion: 'uxf-1',
      id: 'x',
      sourceTokenId: 'y',
      recipientPubkey: 'z',
      status: 'pending',
    };
    expect(isLegacyOutboxEntry(newShape)).toBe(false);
  });

  it('isLegacyOutboxEntry accepts the canonical legacy shape', () => {
    expect(isLegacyOutboxEntry(buildLegacyEntry('id1'))).toBe(true);
  });

  it('isLegacyOutboxEntry rejects status values outside the legacy enum', () => {
    const corrupt = {
      id: 'x',
      sourceTokenId: 'y',
      recipientPubkey: 'z',
      status: 'packaging', // a NEW-shape status value
    };
    expect(isLegacyOutboxEntry(corrupt)).toBe(false);
  });
});
