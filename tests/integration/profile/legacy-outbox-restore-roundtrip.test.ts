/**
 * Round-trip test for `tools/restore-legacy-outbox.ts` (T.6.D.2).
 *
 * **C7 PR gating** — T.8.D merge is gated on this test passing. Per
 * UXF-TRANSFER-PROTOCOL §7.2 paragraph 5 / §7.C back-out, the migrate →
 * restore round-trip must reproduce the wallet's pre-migration legacy
 * outbox state byte-for-byte (modulo the synthetic UXF entries that the
 * migration writes; those Lamport stamps are unrelated to the legacy
 * entries and are NOT touched by restore).
 *
 * Test cases:
 *
 *   1. **5-entry round-trip** — Plant single + group-of-2 + 2 more legacy
 *      entries; migrate; verify backup; restore; assert byte-identity to
 *      the original snapshot.
 *
 *   2. **Idempotency** — Run restore twice. Second run reports
 *      `restored=0`, `alreadyRestored=N`. No on-disk changes second time.
 *
 *   3. **Dry-run** — `dryRun: true` classifies but does not write.
 *      On-disk state unchanged after the call.
 *
 *   4. **Backup not found** — Restore on a wallet with no backup returns
 *      `backupNotFound: true` and writes nothing.
 *
 *   5. **Sentinel default preserves** — Without `clearSentinel: true`,
 *      the migration sentinel survives the restore.
 *
 *   6. **Sentinel explicit clear** — With `clearSentinel: true`, the
 *      sentinel is deleted.
 *
 *   7. **Mismatch overwrite** — A UXF synthetic entry under the same
 *      key is overwritten by the legacy form; mismatch counter increments.
 *
 *   8. **Encrypted profile round-trip** — Same as (1) but with an
 *      encryption key supplied to both migrate and restore.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer.js';
import {
  backupKey,
  migrateLegacyOutbox,
  sentinelKey,
} from '../../../extensions/uxf/profile/migration-outbox.js';
import { encryptProfileValue } from '../../../extensions/uxf/profile/encryption.js';
import { restoreLegacyOutbox } from '../../../tools/restore-legacy-outbox.js';
import type { LegacyOutboxEntry } from '../../../types/uxf-outbox.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../extensions/uxf/profile/types.js';

// ---------------------------------------------------------------------------
// Mock infra — same shape as tests/unit/profile/migration-outbox.test.ts
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
      // Defensively copy bytes so the snapshot we captured at write time
      // does not see later in-place mutations from the writer/restorer.
      store.set(k, new Uint8Array(v));
    },
    async get(k: string) {
      const v = store.get(k);
      return v ? new Uint8Array(v) : null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, new Uint8Array(v));
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

function makeWriter(db: MockProfileDb, encryptionKey: Uint8Array | null = null): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey,
    addressId: ADDR,
    lamport: new Lamport(0),
  });
}

/** Plant a legacy entry directly. Plaintext when no key, encrypted otherwise. */
async function plantLegacy(
  db: MockProfileDb,
  entry: LegacyOutboxEntry,
  encryptionKey: Uint8Array | null = null,
): Promise<void> {
  const key = `${KEY_PREFIX}${entry.id}`;
  const encoded = new TextEncoder().encode(JSON.stringify(entry));
  const toWrite = encryptionKey ? await encryptProfileValue(encryptionKey, encoded) : encoded;
  await db.put(key, toWrite);
}

/** Capture a snapshot of every `${addr}.outbox.${id}` key as a deep clone. */
function snapshotLegacyKeys(
  db: MockProfileDb,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [k, v] of db._store) {
    if (k.startsWith(KEY_PREFIX)) out.set(k, new Uint8Array(v));
  }
  return out;
}

/** Decode bytes → parsed JSON object (legacy entry shape). */
async function decodePlaintext(
  raw: Uint8Array,
): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(raw));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build the 5-entry fixture used across the round-trip tests. Mirrors the
 * `tests/fixtures/wallets/legacy-outbox-pre-T6D/profile-snapshot.json`
 * shape and timing so the migration produces 4 synthetic groups
 * (entry-001, entry-002, entry-003, and entry-004+entry-005 grouped).
 */
function buildFiveEntryFixture(): ReadonlyArray<LegacyOutboxEntry> {
  return [
    {
      id: 'entry-001',
      status: 'delivered',
      sourceTokenId: 'tok-001',
      salt: '00'.repeat(32),
      commitmentJson: '{}',
      recipientPubkey: '02' + 'aa'.repeat(32),
      recipientNametag: 'bob',
      amount: '1000000',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    },
    {
      id: 'entry-002',
      status: 'pending',
      sourceTokenId: 'tok-002',
      salt: '11'.repeat(32),
      commitmentJson: '{}',
      recipientPubkey: '02' + 'cc'.repeat(32),
      amount: '500000',
      createdAt: 1700000060000,
      updatedAt: 1700000060000,
      retryCount: 1,
    },
    {
      id: 'entry-003',
      status: 'failed',
      sourceTokenId: 'tok-003',
      salt: '22'.repeat(32),
      commitmentJson: '{}',
      recipientPubkey: '02' + 'dd'.repeat(32),
      recipientNametag: 'carol',
      amount: '250000',
      createdAt: 1700000120000,
      updatedAt: 1700000120000,
      error: 'oracle rejected',
      retryCount: 3,
    },
    {
      id: 'entry-004',
      status: 'delivered',
      sourceTokenId: 'tok-004',
      salt: '33'.repeat(32),
      commitmentJson: '{}',
      recipientPubkey: '02' + 'bb'.repeat(32),
      recipientNametag: 'dave',
      amount: '750000',
      createdAt: 1700000180000,
      updatedAt: 1700000180000,
    },
    {
      id: 'entry-005',
      status: 'delivered',
      sourceTokenId: 'tok-005',
      salt: '44'.repeat(32),
      commitmentJson: '{}',
      recipientPubkey: '02' + 'bb'.repeat(32),
      amount: '750000',
      createdAt: 1700000210000,
      updatedAt: 1700000210000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('legacy-outbox-restore-roundtrip — C7 PR gating for T.8.D', () => {
  describe('5-entry round-trip (single + group-of-2 + 2 more)', () => {
    let db: MockProfileDb;
    let writer: OutboxWriter;
    let originalSnapshot: Map<string, Uint8Array>;

    beforeEach(async () => {
      db = createMockDb();
      writer = makeWriter(db);

      const fixtures = buildFiveEntryFixture();
      for (const entry of fixtures) {
        await plantLegacy(db, entry);
      }
      originalSnapshot = snapshotLegacyKeys(db);
      // Sanity: 5 legacy entries planted.
      expect(originalSnapshot.size).toBe(5);
    });

    it('migrate → backup verify → restore → byte-identical to original', async () => {
      // -----------------------------------------------------------------
      // Step 1 — migrate (T.6.D)
      // -----------------------------------------------------------------
      const migrateResult = await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      });
      // 4 groups: entry-001, entry-002, entry-003, and entry-004+005.
      expect(migrateResult.migrated).toBe(4);
      expect(migrateResult.groups).toBe(4);
      expect(migrateResult.legacyEntries).toBe(5);

      // After migration the legacy keys are gone — replaced by 4 synthetic
      // UXF entries. The backup is on disk.
      const postMigratePrefix = snapshotLegacyKeys(db);
      // No original key id (entry-NNN) survives — the migration sweep
      // cleared each one. The synthetic UXF entries use UUIDs as ids,
      // so they live under DIFFERENT keys.
      const surviving = [...postMigratePrefix.keys()].filter((k) =>
        k.match(/\.outbox\.entry-00\d$/),
      );
      expect(surviving).toHaveLength(0);
      // Backup is present.
      expect(db._store.has(backupKey(ADDR))).toBe(true);
      // Sentinel is set.
      expect(db._store.has(sentinelKey(ADDR))).toBe(true);

      // Capture the synthetic-UXF entries so we can verify restore does
      // NOT touch them. They are NOT under the entry-NNN naming, so they
      // ride at different keys.
      const syntheticUxfKeys = [...postMigratePrefix.keys()].filter(
        (k) => !k.match(/\.outbox\.entry-00\d$/),
      );
      const syntheticUxfSnapshot = new Map<string, Uint8Array>();
      for (const k of syntheticUxfKeys) {
        syntheticUxfSnapshot.set(k, postMigratePrefix.get(k)!);
      }
      expect(syntheticUxfSnapshot.size).toBe(4);

      // -----------------------------------------------------------------
      // Step 2 — restore (T.6.D.2)
      // -----------------------------------------------------------------
      const restoreResult = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
        dryRun: false,
        clearSentinel: false,
      });

      expect(restoreResult.backupNotFound).toBe(false);
      expect(restoreResult.restored).toBe(5);
      expect(restoreResult.alreadyRestored).toBe(0);
      expect(restoreResult.entries).toHaveLength(5);
      expect(restoreResult.dryRun).toBe(false);
      expect(restoreResult.sentinelCleared).toBe(false);

      // -----------------------------------------------------------------
      // Step 3 — byte-identity assertion
      //
      // Each `entry-NNN` key MUST decode to the exact same legacy
      // shape we planted at the start (modulo property order — which
      // is preserved by JSON.stringify of our planted objects → see
      // the `legacyEntriesEqual` field-by-field check).
      // -----------------------------------------------------------------
      const fixtures = buildFiveEntryFixture();
      for (const fixture of fixtures) {
        const key = `${KEY_PREFIX}${fixture.id}`;
        const raw = db._store.get(key);
        expect(raw, `entry ${fixture.id} should be restored`).toBeDefined();
        const decoded = await decodePlaintext(raw!);
        expect(decoded).toEqual(fixture);
      }

      // PLAINTEXT byte-identity for the unencrypted case: the JSON
      // serialization of a plain JS object via JSON.stringify is
      // deterministic on property order. Both the original plant and
      // the restore use JSON.stringify(value), so the resulting bytes
      // are identical for matched property order.
      for (const [key, originalBytes] of originalSnapshot) {
        const currentBytes = db._store.get(key);
        expect(currentBytes, `key ${key} should be present after restore`).toBeDefined();
        // Compare bytes verbatim. This is the "byte-identical to original"
        // assertion the C7 PR-gating spec requires.
        expect(currentBytes!.length).toBe(originalBytes.length);
        for (let i = 0; i < originalBytes.length; i++) {
          if (currentBytes![i] !== originalBytes[i]) {
            throw new Error(
              `byte mismatch at key=${key} index=${i}: ` +
                `original=${originalBytes[i]} restored=${currentBytes![i]}`,
            );
          }
        }
      }

      // -----------------------------------------------------------------
      // Step 4 — synthetic UXF entries are unchanged.
      //
      // The restore script only touches `${addr}.outbox.${id}` keys
      // present in the backup. The migration's UXF synthetics have
      // UUID ids and are NOT in the backup, so they survive untouched.
      // -----------------------------------------------------------------
      for (const [key, expectedBytes] of syntheticUxfSnapshot) {
        const currentBytes = db._store.get(key);
        expect(currentBytes).toBeDefined();
        expect(currentBytes!.length).toBe(expectedBytes.length);
        for (let i = 0; i < expectedBytes.length; i++) {
          expect(currentBytes![i]).toBe(expectedBytes[i]);
        }
      }
    });

    it('byte-identity check documentation: only Lamport differs', async () => {
      // The legacy entries themselves have NO `lamport` field. The
      // synthetic UXF entries DO carry a Lamport, but those are NOT
      // the entries this round-trip restores. So the legacy round-trip
      // is byte-perfect — no fields differ. We document the rationale
      // here as an executable assertion: the legacy `OutboxEntry` shape
      // is fully reproduced, and the only Lamport stamps in play are
      // on the synthetic UXF entries which restore does not touch.
      await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      });

      await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
      });

      const fixtures = buildFiveEntryFixture();
      for (const fixture of fixtures) {
        const key = `${KEY_PREFIX}${fixture.id}`;
        const raw = db._store.get(key);
        const decoded = (await decodePlaintext(raw!)) as Record<string, unknown>;
        // Crucially: no `lamport` field on a restored legacy entry.
        expect('lamport' in decoded).toBe(false);
        expect('_schemaVersion' in decoded).toBe(false);
        expect(decoded).toEqual(fixture);
      }
    });
  });

  describe('idempotency', () => {
    let db: MockProfileDb;
    let writer: OutboxWriter;

    beforeEach(async () => {
      db = createMockDb();
      writer = makeWriter(db);
      for (const entry of buildFiveEntryFixture()) {
        await plantLegacy(db, entry);
      }
      await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      });
    });

    it('restore twice — second run is a no-op', async () => {
      const first = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
      });
      expect(first.restored).toBe(5);
      expect(first.alreadyRestored).toBe(0);

      // Snapshot after first restore.
      const snapshotAfterFirst = snapshotLegacyKeys(db);

      const second = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
      });
      expect(second.restored).toBe(0);
      expect(second.alreadyRestored).toBe(5);
      expect(second.mismatched).toBe(0);

      // No on-disk changes between first and second restore.
      const snapshotAfterSecond = snapshotLegacyKeys(db);
      expect(snapshotAfterSecond.size).toBe(snapshotAfterFirst.size);
      for (const [key, firstBytes] of snapshotAfterFirst) {
        const secondBytes = snapshotAfterSecond.get(key);
        expect(secondBytes).toBeDefined();
        expect(secondBytes!.length).toBe(firstBytes.length);
        for (let i = 0; i < firstBytes.length; i++) {
          expect(secondBytes![i]).toBe(firstBytes[i]);
        }
      }
    });
  });

  describe('dry-run', () => {
    let db: MockProfileDb;
    let writer: OutboxWriter;

    beforeEach(async () => {
      db = createMockDb();
      writer = makeWriter(db);
      for (const entry of buildFiveEntryFixture()) {
        await plantLegacy(db, entry);
      }
      await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      });
    });

    it('classifies but does not write', async () => {
      const beforeSnapshot = snapshotLegacyKeys(db);

      const result = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.restored).toBe(5);
      expect(result.entries).toHaveLength(5);
      // Every entry would be a fresh restore (all 5 entry-NNN keys were
      // cleared by the migration).
      for (const e of result.entries) {
        expect(e.state).toBe('would-restore');
        expect(e.wouldChange).toBe(true);
      }

      // Storage is unchanged.
      const afterSnapshot = snapshotLegacyKeys(db);
      expect(afterSnapshot.size).toBe(beforeSnapshot.size);
      for (const [k, v] of beforeSnapshot) {
        const after = afterSnapshot.get(k)!;
        expect(after.length).toBe(v.length);
        for (let i = 0; i < v.length; i++) expect(after[i]).toBe(v[i]);
      }

      // No legacy entries written by the dry-run.
      for (const fixture of buildFiveEntryFixture()) {
        expect(db._store.has(`${KEY_PREFIX}${fixture.id}`)).toBe(false);
      }
    });
  });

  describe('backup not found', () => {
    let db: MockProfileDb;

    beforeEach(() => {
      db = createMockDb();
    });

    it('returns backupNotFound: true and writes nothing', async () => {
      const result = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
      });
      expect(result.backupNotFound).toBe(true);
      expect(result.restored).toBe(0);
      expect(result.alreadyRestored).toBe(0);
      expect(result.mismatched).toBe(0);
      expect(result.entries).toHaveLength(0);
      expect(db._store.size).toBe(0);
    });
  });

  describe('sentinel handling', () => {
    let db: MockProfileDb;
    let writer: OutboxWriter;

    beforeEach(async () => {
      db = createMockDb();
      writer = makeWriter(db);
      for (const entry of buildFiveEntryFixture()) {
        await plantLegacy(db, entry);
      }
      await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      });
    });

    it('default — sentinel preserved (recommended for rollback)', async () => {
      expect(db._store.has(sentinelKey(ADDR))).toBe(true);

      const result = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
      });

      expect(result.sentinelCleared).toBe(false);
      // Sentinel still present — next migration boot exits as
      // alreadyMigrated: true and does not re-clobber the restored
      // legacy entries.
      expect(db._store.has(sentinelKey(ADDR))).toBe(true);
    });

    it('explicit clearSentinel — sentinel deleted', async () => {
      expect(db._store.has(sentinelKey(ADDR))).toBe(true);

      const result = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
        clearSentinel: true,
      });

      expect(result.sentinelCleared).toBe(true);
      expect(db._store.has(sentinelKey(ADDR))).toBe(false);
    });

    it('clearSentinel + dryRun — sentinel preserved (dry-run gates the delete)', async () => {
      expect(db._store.has(sentinelKey(ADDR))).toBe(true);

      const result = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
        clearSentinel: true,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      // dry-run inhibits the sentinel delete.
      expect(result.sentinelCleared).toBe(false);
      expect(db._store.has(sentinelKey(ADDR))).toBe(true);
    });
  });

  describe('mismatch overwrite', () => {
    let db: MockProfileDb;
    let writer: OutboxWriter;

    beforeEach(async () => {
      db = createMockDb();
      writer = makeWriter(db);
      // Plant just one legacy entry so the migration produces a single
      // synthetic UXF entry under a UUID key — independent of the
      // entry-NNN namespace.
      await plantLegacy(
        db,
        {
          id: 'entry-001',
          status: 'delivered',
          sourceTokenId: 'tok-001',
          salt: '00'.repeat(32),
          commitmentJson: '{}',
          recipientPubkey: '02' + 'aa'.repeat(32),
          recipientNametag: 'bob',
          amount: '1000000',
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      );
      await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey: null,
        featureMode: 'dual-write',
      });
      // After migration: legacy entry-001 is gone. Now plant a UXF-shape
      // entry at the SAME key the legacy entry-001 used to live at —
      // this simulates an operator who manually restored a partial state,
      // or a leftover from a buggy run.
      const uxfEntry = {
        _schemaVersion: 'uxf-1' as const,
        id: 'entry-001',
        bundleCid: 'bafy-some-cid',
        tokenIds: ['tok-X'],
        deliveryMethod: 'car-over-nostr' as const,
        recipient: '@somebody',
        recipientTransportPubkey: '02' + 'ee'.repeat(32),
        mode: 'instant' as const,
        status: 'packaging' as const,
        submitRetryCount: 0,
        proofErrorCount: 0,
        createdAt: 1700000999999,
        updatedAt: 1700000999999,
        lamport: 99,
      };
      await db.put(
        `${KEY_PREFIX}entry-001`,
        new TextEncoder().encode(JSON.stringify(uxfEntry)),
      );
    });

    it('overwrites the UXF synthetic with the legacy form (mismatch counter)', async () => {
      const result = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey: null,
      });

      expect(result.restored).toBe(1);
      expect(result.alreadyRestored).toBe(0);
      expect(result.mismatched).toBe(1);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.state).toBe('mismatch');

      // The on-disk value is now the legacy entry, not the UXF synthetic.
      const raw = db._store.get(`${KEY_PREFIX}entry-001`)!;
      const decoded = (await decodePlaintext(raw)) as Record<string, unknown>;
      expect(decoded._schemaVersion).toBeUndefined();
      expect(decoded.sourceTokenId).toBe('tok-001');
      expect(decoded.recipientNametag).toBe('bob');
    });
  });

  describe('encrypted profile round-trip', () => {
    let db: MockProfileDb;
    let writer: OutboxWriter;
    let encryptionKey: Uint8Array;
    let originalPlaintexts: Map<string, Uint8Array>;

    beforeEach(async () => {
      db = createMockDb();
      // 32-byte deterministic key for the test.
      encryptionKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) encryptionKey[i] = (i * 7 + 3) & 0xff;
      writer = makeWriter(db, encryptionKey);

      originalPlaintexts = new Map();
      for (const entry of buildFiveEntryFixture()) {
        await plantLegacy(db, entry, encryptionKey);
        originalPlaintexts.set(
          `${KEY_PREFIX}${entry.id}`,
          new TextEncoder().encode(JSON.stringify(entry)),
        );
      }
    });

    it('round-trip preserves the plaintext byte-identically (ciphertext IV differs by design)', async () => {
      const migrateResult = await migrateLegacyOutbox({
        addr: ADDR,
        db,
        outboxWriter: writer,
        encryptionKey,
        featureMode: 'dual-write',
      });
      expect(migrateResult.migrated).toBe(4);

      const restoreResult = await restoreLegacyOutbox({
        addr: ADDR,
        db,
        encryptionKey,
      });
      expect(restoreResult.backupNotFound).toBe(false);
      expect(restoreResult.restored).toBe(5);

      // Each entry decrypts to plaintext that matches the original
      // JSON.stringify of the planted fixture. We do NOT compare ciphertexts
      // because AES-GCM uses a fresh IV per encrypt — that's the
      // "ciphertext differs by design" footnote.
      const { decryptProfileValue } = await import('../../../extensions/uxf/profile/encryption.js');
      for (const fixture of buildFiveEntryFixture()) {
        const key = `${KEY_PREFIX}${fixture.id}`;
        const ct = db._store.get(key);
        expect(ct, `entry ${fixture.id} should be restored`).toBeDefined();
        const pt = await decryptProfileValue(encryptionKey, ct!);
        const expected = originalPlaintexts.get(key)!;
        expect(pt.length).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(pt[i]).toBe(expected[i]);
        }
        const decoded = JSON.parse(new TextDecoder().decode(pt));
        expect(decoded).toEqual(fixture);
      }
    });
  });
});
