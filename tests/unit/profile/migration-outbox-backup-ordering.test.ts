/**
 * Tests for `profile/migration-outbox.ts` — C7 backup-ordering invariant (T.6.D).
 *
 * The C7 ordering invariant (per `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.6.D):
 *
 *   1. read legacy
 *   2. write `${addr}.legacyOutbox.backup`   (BACKUP)
 *   3. synthesize + write UXF entries        (MIGRATE)
 *   4. write `${addr}.legacyOutbox.migrated` (SENTINEL)
 *   5. delete legacy entries                 (CLEAR)
 *
 * The backup MUST be written BEFORE the legacy clear so a partial-crash
 * recovery (T.6.D.2 restore script) can round-trip the snapshot.
 *
 * Tests in this file:
 *   - Order assertion via a `put`/`del` audit log on the mock db.
 *   - Crash between BACKUP and CLEAR: legacy entries still in place,
 *     no sentinel, second run re-runs cleanly.
 *   - Crash AFTER SENTINEL but before CLEAR: sentinel set, second run
 *     observes it and exits as `alreadyMigrated`. Documented limitation:
 *     legacy entries from a crashed-mid-clear state remain on-disk; they
 *     are inert (post-cutover code reads UXF-shape only) but a separate
 *     sweeper would clean them.
 *   - Backup is overwrite-safe: re-running after manually clearing the
 *     sentinel re-writes the backup with the current legacy state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer.js';
import {
  backupKey,
  migrateLegacyOutbox,
  sentinelKey,
} from '../../../extensions/uxf/profile/migration-outbox.js';
import type { LegacyOutboxEntry } from '../../../extensions/uxf/types/uxf-outbox.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../extensions/uxf/profile/types.js';

// ---------------------------------------------------------------------------
// Audited mock db — records every put/del call in order.
// ---------------------------------------------------------------------------

const ADDR = 'DIRECT_aabbcc_ddeeff';
const KEY_PREFIX = `${ADDR}.outbox.`;

interface AuditEntry {
  readonly op: 'put' | 'del';
  readonly key: string;
  readonly seq: number;
}

interface AuditedDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
  _log: AuditEntry[];
  /**
   * If non-null, the next call matching `failOn(op, key)` throws. Use to
   * simulate partial-crash mid-step.
   */
  _failOn: ((op: 'put' | 'del', key: string) => boolean) | null;
}

function createAuditedDb(): AuditedDb {
  const store = new Map<string, Uint8Array>();
  const log: AuditEntry[] = [];
  let seq = 0;
  const db: AuditedDb = {
    _store: store,
    _log: log,
    _failOn: null,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      if (db._failOn?.('put', k)) {
        throw new Error(`SIMULATED_CRASH put ${k}`);
      }
      log.push({ op: 'put', key: k, seq: seq++ });
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      if (db._failOn?.('del', k)) {
        throw new Error(`SIMULATED_CRASH del ${k}`);
      }
      log.push({ op: 'del', key: k, seq: seq++ });
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
  } as AuditedDb;
  return db;
}

function makeWriter(db: AuditedDb): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: new Lamport(0),
  });
}

function buildLegacy(overrides: Partial<LegacyOutboxEntry>): LegacyOutboxEntry {
  return {
    id: 'legacy-id',
    status: 'pending',
    sourceTokenId: '0xtok-default',
    salt: 'a'.repeat(64),
    commitmentJson: '{}',
    recipientPubkey: '02' + 'b'.repeat(64),
    amount: '1000000',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

async function plantLegacy(db: AuditedDb, entry: LegacyOutboxEntry): Promise<void> {
  const key = `${KEY_PREFIX}${entry.id}`;
  const encoded = new TextEncoder().encode(JSON.stringify(entry));
  await db.put(key, encoded);
}

/** Find the seq number of the first put-to a given key. */
function seqOfFirstPut(log: ReadonlyArray<AuditEntry>, key: string): number | null {
  for (const e of log) if (e.op === 'put' && e.key === key) return e.seq;
  return null;
}

/** Find the seq number of the first del of a key matching `predicate`. */
function seqOfFirstDelMatching(
  log: ReadonlyArray<AuditEntry>,
  predicate: (key: string) => boolean,
): number | null {
  for (const e of log) if (e.op === 'del' && predicate(e.key)) return e.seq;
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateLegacyOutbox — C7 ordering invariant', () => {
  let db: AuditedDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createAuditedDb();
    writer = makeWriter(db);
  });

  it('writes the backup BEFORE deleting any legacy entry', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    await plantLegacy(db, buildLegacy({ id: 'l2' }));
    // Reset log so we only audit the migration's writes.
    db._log.length = 0;

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const backupSeq = seqOfFirstPut(db._log, backupKey(ADDR));
    expect(backupSeq).not.toBeNull();

    const firstLegacyDelSeq = seqOfFirstDelMatching(db._log, (k) =>
      k.startsWith(KEY_PREFIX),
    );
    expect(firstLegacyDelSeq).not.toBeNull();

    expect(backupSeq!).toBeLessThan(firstLegacyDelSeq!);
  });

  it('writes the backup BEFORE writing any synthesized UXF entry', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    db._log.length = 0;

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const backupSeq = seqOfFirstPut(db._log, backupKey(ADDR));
    expect(backupSeq).not.toBeNull();

    // The first put-to a `${addr}.outbox.*` key after the backup is the
    // first synthesized UXF entry.
    let firstUxfPutSeq: number | null = null;
    for (const e of db._log) {
      if (
        e.op === 'put' &&
        e.key.startsWith(KEY_PREFIX) &&
        e.seq > backupSeq!
      ) {
        firstUxfPutSeq = e.seq;
        break;
      }
    }
    expect(firstUxfPutSeq).not.toBeNull();
    expect(backupSeq!).toBeLessThan(firstUxfPutSeq!);
  });

  it('writes the sentinel AFTER the synthesized UXF entries', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    db._log.length = 0;

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const sentinelSeq = seqOfFirstPut(db._log, sentinelKey(ADDR));
    expect(sentinelSeq).not.toBeNull();

    // Every UXF-shape put should have happened BEFORE the sentinel.
    for (const e of db._log) {
      if (
        e.op === 'put' &&
        e.key.startsWith(KEY_PREFIX) &&
        e.key !== sentinelKey(ADDR) &&
        e.key !== backupKey(ADDR)
      ) {
        expect(e.seq).toBeLessThan(sentinelSeq!);
      }
    }
  });

  it('clears legacy entries AFTER the sentinel write', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    db._log.length = 0;

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const sentinelSeq = seqOfFirstPut(db._log, sentinelKey(ADDR));
    const firstLegacyDelSeq = seqOfFirstDelMatching(db._log, (k) =>
      k.startsWith(KEY_PREFIX),
    );

    expect(sentinelSeq).not.toBeNull();
    expect(firstLegacyDelSeq).not.toBeNull();
    expect(sentinelSeq!).toBeLessThan(firstLegacyDelSeq!);
  });
});

describe('migrateLegacyOutbox — partial-crash recovery', () => {
  let db: AuditedDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createAuditedDb();
    writer = makeWriter(db);
  });

  it('crash AFTER backup, BEFORE first synthesized write — second run completes cleanly', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'delivered' }));
    await plantLegacy(db, buildLegacy({ id: 'l2', status: 'pending', sourceTokenId: 'tok-2', recipientPubkey: '02' + 'c'.repeat(64), createdAt: 1700000200000 }));

    // Fail on the FIRST `${ADDR}.outbox.*` put after the backup. This
    // simulates the writer dying just after backup + just before the
    // first synthesized entry lands on disk.
    let backupSeen = false;
    db._failOn = (op, key) => {
      if (op === 'put' && key === backupKey(ADDR)) {
        backupSeen = true;
        return false;
      }
      if (backupSeen && op === 'put' && key.startsWith(KEY_PREFIX)) {
        return true;
      }
      return false;
    };

    await expect(
      migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      }),
    ).rejects.toThrow(/SIMULATED_CRASH/);

    // Backup is in place.
    expect(db._store.has(backupKey(ADDR))).toBe(true);
    // Sentinel is NOT in place.
    expect(db._store.has(sentinelKey(ADDR))).toBe(false);
    // Legacy entries are STILL there.
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(true);
    expect(db._store.has(`${KEY_PREFIX}l2`)).toBe(true);

    // Lift the failure injector and re-run.
    db._failOn = null;
    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.alreadyMigrated).toBe(false);
    expect(result.migrated).toBe(2);
    expect(db._store.has(sentinelKey(ADDR))).toBe(true);
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(false);
    expect(db._store.has(`${KEY_PREFIX}l2`)).toBe(false);
  });

  it('crash AFTER sentinel write, BEFORE legacy clear — second run is alreadyMigrated no-op', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'delivered' }));

    // Fail on the FIRST `del` to a `${ADDR}.outbox.*` key (i.e. mid-clear).
    let sentinelSeen = false;
    db._failOn = (op, key) => {
      if (op === 'put' && key === sentinelKey(ADDR)) {
        sentinelSeen = true;
        return false;
      }
      if (sentinelSeen && op === 'del' && key.startsWith(KEY_PREFIX)) {
        return true;
      }
      return false;
    };

    await expect(
      migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      }),
    ).rejects.toThrow(/SIMULATED_CRASH/);

    // Sentinel is in place.
    expect(db._store.has(sentinelKey(ADDR))).toBe(true);
    // Legacy entry is STILL there (clear failed mid-loop).
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(true);

    // Lift the failure injector and re-run. The sentinel guard should
    // make this a no-op.
    db._failOn = null;
    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.alreadyMigrated).toBe(true);
    expect(result.migrated).toBe(0);
    // Documented limitation: the leftover legacy entry remains on-disk.
    // Post-cutover code reads UXF-shape only, so this is inert. A
    // separate sweeper (out of T.6.D scope) would clean it up.
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(true);
  });

  it('crash mid-clear (after partial deletes) — second run is alreadyMigrated no-op', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    await plantLegacy(db, buildLegacy({ id: 'l2', sourceTokenId: 'tok-2', recipientPubkey: '02' + 'c'.repeat(64), createdAt: 1700000200000 }));
    await plantLegacy(db, buildLegacy({ id: 'l3', sourceTokenId: 'tok-3', recipientPubkey: '02' + 'd'.repeat(64), createdAt: 1700000400000 }));

    // Allow the first `del` to succeed, fail the second. This simulates
    // a crash partway through the clear loop.
    let delsSeen = 0;
    db._failOn = (op, key) => {
      if (op === 'del' && key.startsWith(KEY_PREFIX)) {
        delsSeen++;
        return delsSeen === 2;
      }
      return false;
    };

    await expect(
      migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      }),
    ).rejects.toThrow(/SIMULATED_CRASH/);

    // Sentinel is in place.
    expect(db._store.has(sentinelKey(ADDR))).toBe(true);

    // Lift the injector and re-run.
    db._failOn = null;
    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.alreadyMigrated).toBe(true);
    expect(result.migrated).toBe(0);
  });

  it('backup is overwrite-safe — re-running after manual sentinel removal re-writes', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));

    // First run.
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const firstBackup = db._store.get(backupKey(ADDR));
    expect(firstBackup).toBeDefined();

    // Simulate forensic intervention: operator removes the sentinel and
    // plants new legacy data (e.g. recovered from a backup snapshot).
    db._store.delete(sentinelKey(ADDR));
    await plantLegacy(db, buildLegacy({ id: 'l2-recovered' }));

    // Re-run — backup should be overwritten with the new state.
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const secondBackup = db._store.get(backupKey(ADDR));
    expect(secondBackup).toBeDefined();
    // The two backups differ — the second captures `l2-recovered`.
    expect(secondBackup!).not.toEqual(firstBackup!);

    const decoded = JSON.parse(new TextDecoder().decode(secondBackup!));
    const keys: string[] = decoded.entries.map((e: { key: string }) => e.key);
    expect(keys).toContain(`${KEY_PREFIX}l2-recovered`);
  });
});

describe('migrateLegacyOutbox — feature-gate skip vs. sentinel skip semantics', () => {
  let db: AuditedDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createAuditedDb();
    writer = makeWriter(db);
  });

  it('feature-gate skip writes NO backup, NO sentinel, NO synthesized entries', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    db._log.length = 0;

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      // featureMode omitted
    });

    expect(db._store.has(backupKey(ADDR))).toBe(false);
    expect(db._store.has(sentinelKey(ADDR))).toBe(false);
    expect(db._log.length).toBe(0);
  });

  it('sentinel skip writes NO new backup and NO new entries', async () => {
    // First run — establishes sentinel.
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const backupBefore = db._store.get(backupKey(ADDR));
    expect(backupBefore).toBeDefined();
    db._log.length = 0;

    // Re-run — should observe sentinel and exit immediately.
    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.alreadyMigrated).toBe(true);
    // No new puts should have happened.
    expect(db._log.filter((e) => e.op === 'put')).toHaveLength(0);
    // Backup is unchanged.
    expect(db._store.get(backupKey(ADDR))).toEqual(backupBefore);
  });
});

describe('migrateLegacyOutbox — input validation', () => {
  let db: AuditedDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createAuditedDb();
    writer = makeWriter(db);
  });

  it('throws when addr is empty', async () => {
    await expect(
      migrateLegacyOutbox({
        addr: '',
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      }),
    ).rejects.toThrow(/addr must be a non-empty string/);
  });

  it('throws when outboxWriter is not an OutboxWriter instance', async () => {
    await expect(
      migrateLegacyOutbox({
        addr: ADDR,
        db,
        // @ts-expect-error — purposeful invalid input for the runtime guard.
        outboxWriter: { write: vi.fn() },
        encryptionKey: null,
        featureMode: 'dual-write',
      }),
    ).rejects.toThrow(/outboxWriter must be an OutboxWriter instance/);
  });
});
