/**
 * T.8.E.2 — Cross-mode compatibility: legacy outbox migration round-trip.
 *
 * **Goal**: prove that the C7 round-trip property (per UXF-TRANSFER-PROTOCOL
 * §7.2 paragraph 5 / §7.C back-out) holds end-to-end:
 *
 *   migrate(W) → backup(W) ; restore(backup(W)) → W
 *
 * Walks through every step of the supported rollback path:
 *  1. Plant the curated `legacy-outbox-pre-T6D` fixture into a mock
 *     {@link ProfileDatabase}. The fixture is the canonical pre-T.6.D
 *     wallet — five per-token outbox entries covering every documented
 *     §7.2 grouping case (single-token + multi-token within 60s).
 *  2. Run T.6.D `migrateLegacyOutbox` with `featureMode: 'uxf'`. Verify:
 *     - The backup is written at `${addr}.legacyOutbox.backup`.
 *     - The sentinel is written at `${addr}.legacyOutbox.migrated`.
 *     - Every legacy `${addr}.outbox.*` key is deleted.
 *  3. Run T.6.D.2 `restoreLegacyOutbox`. Verify:
 *     - Every backup entry round-trips back to its original
 *       `${addr}.outbox.${id}` key.
 *     - Each restored entry is byte-identical to the fixture (the
 *       acceptance criterion: `JSON.stringify(restored) === JSON.stringify(fixture)`).
 *     - The sentinel is preserved by default (operator must opt into
 *       `--clear-sentinel` for a full rewind).
 *  4. Re-run the restore: every key is `already-restored`, no writes
 *     happen, the result counts converge with the prior call.
 *
 * **Why this is a compatibility test**: T.6.D's migration is one-way at
 * the data layer — synthetic UXF entries are written and the original
 * legacy entries are deleted. If a deployment hits a regression that
 * requires rolling back to the legacy code path (post-cutover but pre-
 * T.8.D), this round-trip is the supported recovery mechanism. The
 * test guards the byte-level invariant that makes the rollback safe.
 *
 * **Fixture provenance**: `tests/fixtures/wallets/legacy-outbox-pre-T6D/
 * profile-snapshot.json` is the curated pre-T.6.D corpus. The fixture
 * carries five entries representing every documented §7.2 case:
 *  - `entry-001` — single token, delivered, with nametag → bundleCid
 *    `txf-tok-001`, status `finalized`.
 *  - `entry-002` — single token, pending, no nametag → status `sending`.
 *  - `entry-003` — single token, failed → status `failed-permanent`.
 *  - `entry-004` + `entry-005` — multi-token group within 60s →
 *    coalesced into ONE synthetic entry per W18.
 *
 * Spec references:
 *  - §7.2  Migration rules + back-out paragraph 5.
 *  - §7.C  Back-out invariants (the round-trip property).
 *  - §10.3 Backward compatibility (operator-driven rollback).
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer.js';
import {
  backupKey,
  migrateLegacyOutbox,
  sentinelKey,
} from '../../../extensions/uxf/profile/migration-outbox.js';
import { restoreLegacyOutbox } from '../../../tools/restore-legacy-outbox.js';
import { isLegacyOutboxEntry, type LegacyOutboxEntry } from '../../../extensions/uxf/types/uxf-outbox.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../extensions/uxf/profile/types.js';

// =============================================================================
// 1. Mock ProfileDatabase
// =============================================================================

const ADDR = 'DIRECT_aabbcc_ddeeff';

interface MockProfileDb extends ProfileDatabase {
  readonly _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {
      // no-op
    },
    async put(k: string, v: Uint8Array) {
      // The map MUST hold a defensive copy: OrbitDB's storage layer
      // does its own framing, so two writes that originate from the
      // same Uint8Array view should not alias. The migration code
      // reuses TextEncoder buffers; without a copy here, a re-encode
      // could mutate the previous put.
      store.set(k, new Uint8Array(v));
    },
    async get(k: string) {
      const v = store.get(k);
      return v !== undefined ? new Uint8Array(v) : null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          out.set(k, new Uint8Array(v));
        }
      }
      return out;
    },
    async close() {
      // no-op
    },
    onReplication() {
      return () => undefined;
    },
    isConnected() {
      return true;
    },
  } as MockProfileDb;
}

function makeWriter(db: MockProfileDb): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: new Lamport(0),
  });
}

// =============================================================================
// 2. Fixture loader
// =============================================================================

interface FixtureEntry {
  readonly key: string;
  readonly value: LegacyOutboxEntry;
}

interface FixtureSnapshot {
  readonly address_id: string;
  readonly entries: ReadonlyArray<FixtureEntry>;
}

async function loadFixture(): Promise<FixtureSnapshot> {
  // Resolve the fixture path relative to THIS file. The test sits in
  // `tests/compatibility/transfer/` and the fixture in
  // `tests/fixtures/wallets/legacy-outbox-pre-T6D/`. Both directories
  // share the `tests/` root, so we step up two directories.
  const here = fileURLToPath(import.meta.url);
  const fixturePath = resolve(
    here,
    '../../../fixtures/wallets/legacy-outbox-pre-T6D/profile-snapshot.json',
  );
  const raw = await readFile(fixturePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isFixtureSnapshot(parsed)) {
    throw new Error(`legacy-outbox-pre-T6D fixture is malformed: ${fixturePath}`);
  }
  return parsed;
}

function isFixtureSnapshot(value: unknown): value is FixtureSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.address_id !== 'string') return false;
  if (!Array.isArray(obj.entries)) return false;
  for (const e of obj.entries) {
    if (e === null || typeof e !== 'object') return false;
    const entry = e as Record<string, unknown>;
    if (typeof entry.key !== 'string') return false;
    if (!isLegacyOutboxEntry(entry.value)) return false;
  }
  return true;
}

/** Plant a fixture entry verbatim (unencrypted JSON, matching the migration). */
async function plantEntry(db: MockProfileDb, e: FixtureEntry): Promise<void> {
  await db.put(e.key, new TextEncoder().encode(JSON.stringify(e.value)));
}

/**
 * Read the on-disk legacy entry at `${addr}.outbox.${id}`, parse it, and
 * return it as a `LegacyOutboxEntry`. Returns `null` if the key is absent
 * or the on-disk shape is not legacy.
 */
async function readLegacyAt(
  db: MockProfileDb,
  key: string,
): Promise<LegacyOutboxEntry | null> {
  const raw = db._store.get(key);
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  return isLegacyOutboxEntry(parsed) ? parsed : null;
}

// =============================================================================
// 3. Round-trip test
// =============================================================================

describe('Legacy outbox migration round-trip — T.6.D + T.6.D.2', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;
  let fixture: FixtureSnapshot;

  beforeEach(async () => {
    db = createMockDb();
    writer = makeWriter(db);
    fixture = await loadFixture();
    expect(fixture.address_id).toBe(ADDR);
  });

  it('plants → migrates → restores back to byte-identical legacy entries', async () => {
    // -------------------------------------------------------------------
    // Step 1 — plant the fixture into the mock DB.
    // -------------------------------------------------------------------
    for (const e of fixture.entries) {
      await plantEntry(db, e);
    }
    // Sanity: every fixture key is present.
    for (const e of fixture.entries) {
      expect(db._store.has(e.key)).toBe(true);
    }

    // -------------------------------------------------------------------
    // Step 2 — run the migration.
    // -------------------------------------------------------------------
    const migration = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'uxf',
    });

    expect(migration.alreadyMigrated).toBe(false);
    expect(migration.legacyEntries).toBe(fixture.entries.length);
    expect(migration.skippedMalformed).toBe(0);
    // Backup is written.
    expect(db._store.has(backupKey(ADDR))).toBe(true);
    // Sentinel is written.
    expect(db._store.has(sentinelKey(ADDR))).toBe(true);
    // Legacy entries are cleared.
    for (const e of fixture.entries) {
      expect(db._store.has(e.key)).toBe(false);
    }
    // Synthesized UXF entries exist (one per legacy group). The fixture
    // describes 4 groups (3 single-token + 1 two-token). The migration's
    // `groups` count is the canonical source of truth.
    expect(migration.groups).toBeGreaterThan(0);
    expect(migration.migrated).toBe(migration.groups);

    // -------------------------------------------------------------------
    // Step 3 — run the restore (default policy: keep sentinel).
    // -------------------------------------------------------------------
    const restore = await restoreLegacyOutbox({
      addr: ADDR,
      db,
      encryptionKey: null,
    });
    expect(restore.backupNotFound).toBe(false);
    expect(restore.dryRun).toBe(false);
    // Every backup entry round-trips: the prior on-disk values were UXF
    // synthetics under the same prefix, so the restore counts them as
    // `mismatch` and overwrites them. `restored` covers all writes.
    expect(restore.restored).toBe(fixture.entries.length);
    // Sentinel is preserved by default (rollback semantics).
    expect(restore.sentinelCleared).toBe(false);
    expect(db._store.has(sentinelKey(ADDR))).toBe(true);

    // -------------------------------------------------------------------
    // Step 4 — verify byte-identity of the restored entries.
    // -------------------------------------------------------------------
    for (const e of fixture.entries) {
      const restored = await readLegacyAt(db, e.key);
      expect(restored).not.toBeNull();
      // Byte-identity at the canonicalized JSON layer. We compare via
      // re-serialization so cosmetic property-order shifts do not
      // induce false negatives — the documented contract in
      // `restore-legacy-outbox.ts` is field-by-field equality, and the
      // canonical JSON shape of the same `LegacyOutboxEntry` object is
      // stable across the round-trip.
      expect(JSON.stringify(restored)).toBe(JSON.stringify(e.value));
    }
  });

  it('idempotent restore: a second run is a no-op (every entry already-restored)', async () => {
    // Same setup as the round-trip test, run through migrate → restore →
    // restore. The second restore observes every backup entry already on
    // disk and skips writes.
    for (const e of fixture.entries) {
      await plantEntry(db, e);
    }
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'uxf',
    });
    const first = await restoreLegacyOutbox({
      addr: ADDR,
      db,
      encryptionKey: null,
    });
    const second = await restoreLegacyOutbox({
      addr: ADDR,
      db,
      encryptionKey: null,
    });

    expect(first.restored).toBe(fixture.entries.length);
    expect(second.restored).toBe(0);
    expect(second.alreadyRestored).toBe(fixture.entries.length);
    expect(second.mismatched).toBe(0);
    // Every entry should classify as `already-restored` on the second pass.
    for (const cls of second.entries) {
      expect(cls.state).toBe('already-restored');
      expect(cls.wouldChange).toBe(false);
    }
  });

  it('--clear-sentinel removes the sentinel for a full rewind', async () => {
    for (const e of fixture.entries) {
      await plantEntry(db, e);
    }
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'uxf',
    });
    const restore = await restoreLegacyOutbox({
      addr: ADDR,
      db,
      encryptionKey: null,
      clearSentinel: true,
    });
    expect(restore.sentinelCleared).toBe(true);
    expect(db._store.has(sentinelKey(ADDR))).toBe(false);
  });

  it('dry-run classifies but does not write — backup remains, no entries restored', async () => {
    for (const e of fixture.entries) {
      await plantEntry(db, e);
    }
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'uxf',
    });
    // Snapshot the on-disk state before the dry-run.
    const beforeKeys = [...db._store.keys()].sort();
    const dryRun = await restoreLegacyOutbox({
      addr: ADDR,
      db,
      encryptionKey: null,
      dryRun: true,
    });
    // Dry-run reports counts but does not write — every key on disk is
    // unchanged.
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.backupNotFound).toBe(false);
    // The reported `restored` count reflects work that WOULD be done.
    expect(dryRun.restored).toBe(fixture.entries.length);
    const afterKeys = [...db._store.keys()].sort();
    expect(afterKeys).toEqual(beforeKeys);
  });
});
