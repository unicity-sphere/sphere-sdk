/**
 * Tests for `profile/migration-outbox.ts` — legacy outbox → UXF migration (T.6.D).
 *
 * Covers:
 *   1. Single-token legacy entry → synthetic bundle with `bundleCid='txf-' + tokenId`.
 *   2. Multi-token legacy group within 60s → synthetic combined bundle with
 *      `bundleCid='legacy-' + recipientPubkey + '-' + earliestCreatedAt`.
 *   3. Status mapping per §7.2 step 3.
 *   4. `recipientNametag` preservation (W18 — first-class field on
 *      `UxfTransferOutboxEntry`).
 *   5. One-way: re-running the migration is a no-op (sentinel-gated).
 *   6. Feature gate: `featureMode` undefined / `'legacy'` → no-op.
 *   7. Fixture round-trip: every entry from
 *      `tests/fixtures/wallets/legacy-outbox-pre-T6D/profile-snapshot.json`
 *      maps cleanly per the documented mapping table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import {
  OutboxWriter,
} from '../../../extensions/uxf/profile/outbox-writer.js';
import {
  backupKey,
  migrateLegacyOutbox,
  sentinelKey,
  type LegacyOutboxBackup,
} from '../../../extensions/uxf/profile/migration-outbox.js';
import {
  isUxfTransferOutboxEntry,
  type LegacyOutboxEntry,
  type UxfTransferOutboxEntry,
} from '../../../types/uxf-outbox.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../extensions/uxf/profile/types.js';

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

/** Plant a legacy entry directly into the mock db (unencrypted, JSON-encoded). */
async function plantLegacy(
  db: MockProfileDb,
  entry: LegacyOutboxEntry,
): Promise<void> {
  const key = `${KEY_PREFIX}${entry.id}`;
  const encoded = new TextEncoder().encode(JSON.stringify(entry));
  await db.put(key, encoded);
}

/** Plant a UXF-shape entry (used to verify the migration leaves them alone). */
async function plantUxfRaw(
  db: MockProfileDb,
  id: string,
  entry: Pick<UxfTransferOutboxEntry, '_schemaVersion' | 'id' | 'lamport'> & Record<string, unknown>,
): Promise<void> {
  const key = `${KEY_PREFIX}${id}`;
  const encoded = new TextEncoder().encode(JSON.stringify(entry));
  await db.put(key, encoded);
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

function makeWriter(db: MockProfileDb): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: new Lamport(0),
  });
}

/** Read the sentinel value (parsed) — null if absent. */
async function readSentinel(db: MockProfileDb): Promise<{ at: number; version: 1 } | null> {
  const raw = db._store.get(sentinelKey(ADDR));
  if (!raw) return null;
  return JSON.parse(new TextDecoder().decode(raw));
}

/** Read the backup snapshot (parsed) — null if absent. */
async function readBackup(db: MockProfileDb): Promise<LegacyOutboxBackup | null> {
  const raw = db._store.get(backupKey(ADDR));
  if (!raw) return null;
  return JSON.parse(new TextDecoder().decode(raw));
}

/** Read all UXF-shape entries from the db, sorted by Lamport ascending. */
async function readAllUxf(db: MockProfileDb, writer: OutboxWriter): Promise<UxfTransferOutboxEntry[]> {
  const all = await writer.readAll();
  const out: UxfTransferOutboxEntry[] = [];
  for (const c of all) if (c.shape === 'uxf-1') out.push(c.entry);
  return out.sort((a, b) => a.lamport - b.lamport);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateLegacyOutbox — feature gate (§7.A)', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('is a no-op when featureMode is undefined', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));

    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
    });

    expect(result.migrated).toBe(0);
    expect(result.alreadyMigrated).toBe(false);
    expect(result.backupKey).toBe('');

    // Legacy entry is still present.
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(true);
    // No backup written.
    expect(await readBackup(db)).toBeNull();
    // No sentinel.
    expect(await readSentinel(db)).toBeNull();
  });

  it('is a no-op when featureMode is "legacy"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));

    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'legacy',
    });

    expect(result.migrated).toBe(0);
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(true);
    expect(await readBackup(db)).toBeNull();
  });

  it('runs when featureMode is "dual-write"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'delivered' }));

    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.migrated).toBe(1);
    expect(result.backupKey).toBe(backupKey(ADDR));
    expect(await readSentinel(db)).not.toBeNull();
  });

  it('runs when featureMode is "uxf"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));

    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'uxf',
    });

    expect(result.migrated).toBe(1);
  });
});

describe('migrateLegacyOutbox — single-entry groups (§7.2 step 2)', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('synthesizes bundleCid="txf-" + tokenId for a single-token legacy entry', async () => {
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-XYZ',
        status: 'delivered',
        recipientNametag: 'bob',
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(1);
    expect(uxf[0]!.bundleCid).toBe('txf-tok-XYZ');
    expect(uxf[0]!.tokenIds).toEqual(['tok-XYZ']);
    expect(uxf[0]!.deliveryMethod).toBe('txf-legacy');
    expect(uxf[0]!.mode).toBe('txf');
  });

  it('maps legacy "delivered" → "finalized"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'delivered' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('finalized');
  });

  it('maps legacy "confirmed" → "finalized"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'confirmed' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('finalized');
  });

  it('maps legacy "pending" → "sending"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'pending' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('sending');
  });

  it('maps legacy "submitted" → "sending"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'submitted' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('sending');
  });

  it('maps legacy "failed" → "failed-permanent"', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'failed' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('failed-permanent');
  });
});

describe('migrateLegacyOutbox — multi-entry groups (§7.2 step 1+2)', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('groups entries within 60s for the same recipient into one bundle', async () => {
    const recipient = '02' + 'a'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        status: 'delivered',
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000030000, // +30s, same window
        updatedAt: 1700000030000,
        status: 'delivered',
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(1);
    expect(uxf[0]!.bundleCid).toBe(`legacy-${recipient}-1700000000000`);
    expect(uxf[0]!.tokenIds).toEqual(['tok-A', 'tok-B']);
    expect(uxf[0]!.status).toBe('finalized');
  });

  it('separates entries that fall outside the 60s window', async () => {
    const recipient = '02' + 'a'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000000000,
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000080000, // +80s — different window
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(2);
    expect(uxf.every((e) => e.bundleCid.startsWith('txf-'))).toBe(true);
  });

  it('separates entries with different recipients in the same window', async () => {
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: '02' + 'a'.repeat(64),
        createdAt: 1700000000000,
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: '02' + 'c'.repeat(64),
        createdAt: 1700000010000,
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(2);
  });

  it('uses the most-advanced status across the group (delivered wins over pending)', async () => {
    const recipient = '02' + 'a'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000000000,
        status: 'pending',
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000010000,
        status: 'delivered',
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(1);
    expect(uxf[0]!.status).toBe('finalized');
  });

  it('all-failed group → "failed-permanent"', async () => {
    const recipient = '02' + 'a'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000000000,
        status: 'failed',
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000010000,
        status: 'failed',
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('failed-permanent');
  });

  it('mixed pending+failed group → "sending" (active wins over soft-terminal)', async () => {
    const recipient = '02' + 'a'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000000000,
        status: 'pending',
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000010000,
        status: 'failed',
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.status).toBe('sending');
  });

  it('multi-token bundleCid uses the EARLIEST createdAt in the group', async () => {
    const recipient = '02' + 'a'.repeat(64);
    // Both timestamps must fall in the same 60s window to be grouped.
    // 1700000060000 / 60000 = 28333334.333 → window 28333334
    // 1700000110000 / 60000 = 28333335.166 → window 28333335 (different)
    // 1700000060000 + 1700000080000 → both in window 28333334.
    // Plant in reverse order to verify sort.
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000080000, // later, same window
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000060000, // earliest, same window
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(1);
    expect(uxf[0]!.bundleCid).toBe(`legacy-${recipient}-1700000060000`);
  });
});

describe('migrateLegacyOutbox — recipientNametag preservation (W18)', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('preserves recipientNametag from the legacy entry as a first-class field', async () => {
    await plantLegacy(
      db,
      buildLegacy({ id: 'l1', recipientNametag: 'alice', status: 'delivered' }),
    );
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.recipientNametag).toBe('alice');
    // §7.2 step 2: `recipient` field uses @nametag form when nametag is present.
    expect(uxf[0]!.recipient).toBe('@alice');
  });

  it('omits recipientNametag and falls back to pubkey when no nametag', async () => {
    const pubkey = '02' + 'd'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({ id: 'l1', recipientPubkey: pubkey }),
    );
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.recipientNametag).toBeUndefined();
    expect(uxf[0]!.recipient).toBe(pubkey);
  });

  it('uses the first-non-empty nametag in a multi-entry group', async () => {
    const recipient = '02' + 'a'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l1',
        sourceTokenId: 'tok-A',
        recipientPubkey: recipient,
        createdAt: 1700000000000,
        status: 'delivered',
        // no nametag
      }),
    );
    await plantLegacy(
      db,
      buildLegacy({
        id: 'l2',
        sourceTokenId: 'tok-B',
        recipientPubkey: recipient,
        createdAt: 1700000010000,
        status: 'delivered',
        recipientNametag: 'eve',
      }),
    );

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.recipientNametag).toBe('eve');
    expect(uxf[0]!.recipient).toBe('@eve');
  });

  it('always sets recipientTransportPubkey to the legacy recipientPubkey', async () => {
    const pubkey = '02' + 'e'.repeat(64);
    await plantLegacy(
      db,
      buildLegacy({ id: 'l1', recipientPubkey: pubkey, recipientNametag: 'alice' }),
    );
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const uxf = await readAllUxf(db, writer);
    expect(uxf[0]!.recipientTransportPubkey).toBe(pubkey);
  });
});

describe('migrateLegacyOutbox — one-way idempotency (§7.2 paragraph 5)', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('writes a sentinel after the first successful run', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    const sentinel = await readSentinel(db);
    expect(sentinel).not.toBeNull();
    expect(sentinel!.version).toBe(1);
    expect(typeof sentinel!.at).toBe('number');
  });

  it('clears legacy entries after the first successful run', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    await plantLegacy(db, buildLegacy({ id: 'l2' }));
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    expect(db._store.has(`${KEY_PREFIX}l1`)).toBe(false);
    expect(db._store.has(`${KEY_PREFIX}l2`)).toBe(false);
  });

  it('a second run is a no-op (alreadyMigrated=true, no new entries written)', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1' }));
    const first = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    expect(first.migrated).toBe(1);

    // Plant a fresh legacy entry post-migration. The second run should NOT
    // sweep it — the sentinel guard is the contract.
    await plantLegacy(db, buildLegacy({ id: 'l2-post' }));

    const second = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(second.alreadyMigrated).toBe(true);
    expect(second.migrated).toBe(0);
    // The newly-planted legacy entry survives — no second migration ran.
    expect(db._store.has(`${KEY_PREFIX}l2-post`)).toBe(true);
  });
});

describe('migrateLegacyOutbox — UXF-shape coexistence', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('preserves UXF-shape entries already under the prefix (dual-write window)', async () => {
    await plantLegacy(db, buildLegacy({ id: 'legacy-1' }));
    await plantUxfRaw(db, 'uxf-1', {
      _schemaVersion: 'uxf-1',
      id: 'uxf-1',
      bundleCid: 'bafy-existing',
      tokenIds: ['tok-X'],
      deliveryMethod: 'car-over-nostr',
      recipient: '@alice',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'packaging',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      lamport: 1,
    });

    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.preservedUxfEntries).toBe(1);
    expect(result.migrated).toBe(1);
    // UXF-shape entry is still present.
    expect(db._store.has(`${KEY_PREFIX}uxf-1`)).toBe(true);
    // Legacy entry was cleared.
    expect(db._store.has(`${KEY_PREFIX}legacy-1`)).toBe(false);
  });
});

describe('migrateLegacyOutbox — empty wallet edge cases', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('still writes sentinel + (empty) backup when there are no legacy entries', async () => {
    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });
    expect(result.migrated).toBe(0);
    expect(result.legacyEntries).toBe(0);
    expect(await readSentinel(db)).not.toBeNull();
    const backup = await readBackup(db);
    expect(backup).not.toBeNull();
    expect(backup!._addr).toBe(ADDR);
    expect(backup!.entries).toHaveLength(0);
  });

  it('skips malformed entries silently', async () => {
    // Plant raw garbage — neither legacy- nor UXF-shape.
    await db.put(
      `${KEY_PREFIX}garbage`,
      new TextEncoder().encode('not json at all'),
    );
    await plantLegacy(db, buildLegacy({ id: 'good-1' }));

    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.migrated).toBe(1);
    expect(result.skippedMalformed).toBe(1);
  });
});

describe('migrateLegacyOutbox — shape stamping', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = makeWriter(db);
  });

  it('every synthesized entry passes isUxfTransferOutboxEntry', async () => {
    await plantLegacy(db, buildLegacy({ id: 'l1', status: 'delivered' }));
    await plantLegacy(db, buildLegacy({ id: 'l2', status: 'pending', sourceTokenId: 'tok-2', recipientPubkey: '02' + 'c'.repeat(64), createdAt: 1700000200000 }));

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    for (const entry of uxf) {
      expect(isUxfTransferOutboxEntry(entry)).toBe(true);
    }
  });

  it('Lamport stamps are monotonically increasing across the group writes', async () => {
    // Plant 3 distinct groups.
    await plantLegacy(db, buildLegacy({ id: 'l1', sourceTokenId: 'tok-1', recipientPubkey: '02' + 'a'.repeat(64), createdAt: 1700000000000 }));
    await plantLegacy(db, buildLegacy({ id: 'l2', sourceTokenId: 'tok-2', recipientPubkey: '02' + 'b'.repeat(64), createdAt: 1700000100000 }));
    await plantLegacy(db, buildLegacy({ id: 'l3', sourceTokenId: 'tok-3', recipientPubkey: '02' + 'c'.repeat(64), createdAt: 1700000200000 }));

    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    expect(uxf).toHaveLength(3);
    // Each Lamport must be strictly greater than the previous (write rule).
    for (let i = 1; i < uxf.length; i++) {
      expect(uxf[i]!.lamport).toBeGreaterThan(uxf[i - 1]!.lamport);
    }
  });
});

describe('migrateLegacyOutbox — fixture round-trip', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  // Resolve the fixture path relative to this test file.
  const fixturePath = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../fixtures/wallets/legacy-outbox-pre-T6D/profile-snapshot.json',
  );

  interface FixtureEntry {
    readonly key: string;
    readonly value: LegacyOutboxEntry;
  }
  interface FixtureSnapshot {
    readonly address_id: string;
    readonly entries: FixtureEntry[];
  }

  async function loadFixture(): Promise<FixtureSnapshot> {
    const raw = await readFile(fixturePath, 'utf8');
    return JSON.parse(raw);
  }

  beforeEach(async () => {
    db = createMockDb();
    writer = makeWriter(db);

    const fixture = await loadFixture();
    expect(fixture.address_id).toBe(ADDR);

    for (const entry of fixture.entries) {
      const encoded = new TextEncoder().encode(JSON.stringify(entry.value));
      await db.put(entry.key, encoded);
    }
  });

  it('produces 4 synthetic UXF entries from the 5-entry fixture (one multi-token group)', async () => {
    const result = await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    expect(result.migrated).toBe(4);
    expect(result.groups).toBe(4);
    expect(result.legacyEntries).toBe(5);
    expect(result.skippedMalformed).toBe(0);
  });

  it('the fixture multi-token group folds entries 004 + 005 into one bundle', async () => {
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const uxf = await readAllUxf(db, writer);
    const multi = uxf.find((e) => e.bundleCid.startsWith('legacy-'));
    expect(multi).toBeDefined();
    expect(multi!.tokenIds).toEqual(['tok-004', 'tok-005']);
    // First-non-empty nametag rule: entry 004 has 'dave', 005 has none.
    expect(multi!.recipientNametag).toBe('dave');
    expect(multi!.recipient).toBe('@dave');
    expect(multi!.status).toBe('finalized');
    // bundleCid uses the earliest createdAt (entry 004 = 1700000180000).
    expect(multi!.bundleCid).toMatch(/^legacy-02b{64}-1700000180000$/);
  });

  it('clears the legacy entries and sets the sentinel after success', async () => {
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    for (let i = 1; i <= 5; i++) {
      const id = `entry-00${i}`;
      expect(db._store.has(`${KEY_PREFIX}${id}`)).toBe(false);
    }
    expect(await readSentinel(db)).not.toBeNull();
  });

  it('writes a backup that round-trips back to the original 5 legacy entries', async () => {
    await migrateLegacyOutbox({
      addr: ADDR,
      db,
      outboxWriter: writer,
      encryptionKey: null,
      featureMode: 'dual-write',
    });

    const backup = await readBackup(db);
    expect(backup).not.toBeNull();
    expect(backup!.entries).toHaveLength(5);
    // Backup keys cover entry-001 through entry-005.
    const keys = backup!.entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      `${KEY_PREFIX}entry-001`,
      `${KEY_PREFIX}entry-002`,
      `${KEY_PREFIX}entry-003`,
      `${KEY_PREFIX}entry-004`,
      `${KEY_PREFIX}entry-005`,
    ]);
  });
});
