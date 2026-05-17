/**
 * Tests for `profile/sent-ledger-writer.ts` — Issue #97 SENT ledger.
 *
 * Mirrors `tests/unit/profile/outbox-writer.test.ts` in structure.
 * Covers:
 *   1. Round-trip — write → readAll/readOne returns structurally-equal entry.
 *   2. Lamport bump — every write bumps via the §7.1 invariant.
 *   3. Per-entry-key isolation — sibling writes/deletes do not interfere.
 *   4. Tombstones — `delete()` excludes the entry from subsequent `readAll`.
 *   5. `contains(tokenId)` — returns true iff the token appears in any
 *      live entry's `tokenIds` array.
 *   6. `findByTokenId(tokenId)` — returns all entries containing the token
 *      (multiple deliveries possible per Issue #97 spec).
 *   7. Discriminator filter — entries lacking `_schemaVersion: 'uxf-1'`
 *      are ignored on read.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Lamport } from '../../../profile/lamport.js';
import {
  SentLedgerWriter,
  type SentLedgerWriteInput,
} from '../../../profile/sent-ledger-writer.js';
import { SphereError } from '../../../core/errors.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../profile/types.js';

const ADDR = 'DIRECT_aabbcc_ddeeff';
const KEY_PREFIX = `${ADDR}.sent.`;

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

function buildBaseInput(
  id: string,
  overrides: Partial<SentLedgerWriteInput> = {},
): SentLedgerWriteInput {
  return {
    id,
    tokenIds: [`0xtok-${id}-a`, `0xtok-${id}-b`],
    bundleCid: `bafy-${id}`,
    recipientTransportPubkey: 'a'.repeat(64),
    recipient: '@bob',
    deliveryMethod: 'car-over-nostr',
    mode: 'conservative',
    sentAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('SentLedgerWriter (Issue #97)', () => {
  let db: MockProfileDb;
  let lamport: Lamport;
  let writer: SentLedgerWriter;

  beforeEach(() => {
    db = createMockDb();
    lamport = new Lamport();
    writer = new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport,
    });
  });

  // -------------------------------------------------------------------------
  // 1. Round-trip
  // -------------------------------------------------------------------------
  it('round-trips a single entry through write → readOne with bumped lamport', async () => {
    const written = await writer.write(buildBaseInput('xfer-1'));
    expect(written._schemaVersion).toBe('uxf-1');
    expect(written.lamport).toBe(1);

    const read = await writer.readOne('xfer-1');
    expect(read).toEqual(written);
  });

  it('round-trips multiple entries through readAll with stable lex order', async () => {
    await writer.write(buildBaseInput('xfer-c'));
    await writer.write(buildBaseInput('xfer-a'));
    await writer.write(buildBaseInput('xfer-b'));

    const all = await writer.readAll();
    expect(all.map((e) => e.id)).toEqual(['xfer-a', 'xfer-b', 'xfer-c']);
  });

  // -------------------------------------------------------------------------
  // 2. Lamport bump (§7.1)
  // -------------------------------------------------------------------------
  it('bumps the lamport via max(local, observedRemotes) + 1 on every write', async () => {
    const e1 = await writer.write(buildBaseInput('xfer-1'));
    const e2 = await writer.write(buildBaseInput('xfer-2'));
    const e3 = await writer.write(buildBaseInput('xfer-3'));

    // Each write observes the max of all prior entries → strict increase.
    expect(e1.lamport).toBe(1);
    expect(e2.lamport).toBe(2);
    expect(e3.lamport).toBe(3);

    // Re-writing same id bumps further (second-write-wins, but lamport
    // still climbs).
    const e1b = await writer.write(buildBaseInput('xfer-1'));
    expect(e1b.lamport).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 3. Per-entry-key isolation
  // -------------------------------------------------------------------------
  it('per-entry-key isolation: delete of a does not touch b or c', async () => {
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('b'));
    await writer.write(buildBaseInput('c'));

    await writer.delete('b');

    expect(await writer.readOne('a')).not.toBeNull();
    expect(await writer.readOne('b')).toBeNull();
    expect(await writer.readOne('c')).not.toBeNull();
    expect((await writer.readAll()).map((e) => e.id).sort()).toEqual(['a', 'c']);
  });

  // -------------------------------------------------------------------------
  // 4. Tombstone semantics
  // -------------------------------------------------------------------------
  it('tombstones make subsequent reads return null', async () => {
    await writer.write(buildBaseInput('xfer-1'));
    expect(await writer.readOne('xfer-1')).not.toBeNull();

    await writer.delete('xfer-1');
    expect(await writer.readOne('xfer-1')).toBeNull();

    // Re-writing after tombstone restores the entry.
    const restored = await writer.write(buildBaseInput('xfer-1'));
    expect(restored.id).toBe('xfer-1');
    expect(await writer.readOne('xfer-1')).toEqual(restored);
  });

  // -------------------------------------------------------------------------
  // 5. contains(tokenId)
  // -------------------------------------------------------------------------
  it('contains(tokenId) returns true iff tokenId appears in any live entry', async () => {
    await writer.write(buildBaseInput('xfer-1', { tokenIds: ['0xA', '0xB'] }));
    await writer.write(buildBaseInput('xfer-2', { tokenIds: ['0xC'] }));

    expect(await writer.contains('0xA')).toBe(true);
    expect(await writer.contains('0xB')).toBe(true);
    expect(await writer.contains('0xC')).toBe(true);
    expect(await writer.contains('0xZ')).toBe(false);
  });

  it('contains(tokenId) returns false for tombstoned entries', async () => {
    await writer.write(buildBaseInput('xfer-1', { tokenIds: ['0xA'] }));
    expect(await writer.contains('0xA')).toBe(true);

    await writer.delete('xfer-1');
    expect(await writer.contains('0xA')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. findByTokenId(tokenId)
  // -------------------------------------------------------------------------
  it('findByTokenId returns every entry containing the token', async () => {
    // Issue #97 allows the same token in multiple bundles (idempotent
    // unicity proofs). Two separate SENT entries should both surface.
    await writer.write(buildBaseInput('xfer-1', { tokenIds: ['0xA', '0xB'] }));
    await writer.write(buildBaseInput('xfer-2', { tokenIds: ['0xA'] }));
    await writer.write(buildBaseInput('xfer-3', { tokenIds: ['0xC'] }));

    const a = await writer.findByTokenId('0xA');
    expect(a.map((e) => e.id).sort()).toEqual(['xfer-1', 'xfer-2']);

    const c = await writer.findByTokenId('0xC');
    expect(c.map((e) => e.id)).toEqual(['xfer-3']);

    expect(await writer.findByTokenId('0xZ')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. Validation
  // -------------------------------------------------------------------------
  it('rejects empty addressId at construction', () => {
    expect(() => new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId: '',
      lamport,
    })).toThrow(SphereError);
  });

  it('rejects empty id on write/readOne/delete', async () => {
    await expect(writer.write({ ...buildBaseInput('valid'), id: '' })).rejects.toThrow(SphereError);
    await expect(writer.readOne('')).rejects.toThrow(SphereError);
    await expect(writer.delete('')).rejects.toThrow(SphereError);
  });

  // -------------------------------------------------------------------------
  // 8. Schema discriminator filter
  // -------------------------------------------------------------------------
  it('ignores entries missing _schemaVersion: uxf-1 discriminator', async () => {
    // Plant a "shape-correct except for discriminator" value at the
    // ledger prefix. The readAll filter must skip it.
    const fake = {
      id: 'rogue',
      tokenIds: ['0xrogue'],
      bundleCid: 'bafy-rogue',
      recipientTransportPubkey: 'r'.repeat(64),
      deliveryMethod: 'car-over-nostr' as const,
      mode: 'conservative' as const,
      sentAt: 1_700_000_000_000,
      lamport: 99,
      // _schemaVersion omitted intentionally
    };
    db._store.set(`${KEY_PREFIX}rogue`, new TextEncoder().encode(JSON.stringify(fake)));

    await writer.write(buildBaseInput('xfer-1'));

    const all = await writer.readAll();
    expect(all.map((e) => e.id)).toEqual(['xfer-1']);
    expect(await writer.contains('0xrogue')).toBe(false);
    expect(await writer.readOne('rogue')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. Confined keyspace — does not cross into outbox or other addresses
  // -------------------------------------------------------------------------
  it('does not read from other prefixes (outbox/audit/sent-of-other-address)', async () => {
    // Plant entries at adjacent prefixes — none should appear in readAll.
    db._store.set(`${ADDR}.outbox.xfer-9`, new TextEncoder().encode(JSON.stringify({
      _schemaVersion: 'uxf-1',
      id: 'xfer-9',
      lamport: 1,
    })));
    db._store.set(`${ADDR}.audit.0xtok.hash`, new TextEncoder().encode('{}'));
    db._store.set('DIRECT_OTHER_addr.sent.xfer-foreign', new TextEncoder().encode(JSON.stringify({
      _schemaVersion: 'uxf-1',
      id: 'xfer-foreign',
      tokenIds: ['0xforeign'],
      bundleCid: 'bafy-foreign',
      recipientTransportPubkey: 'f'.repeat(64),
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
      lamport: 1,
    })));

    await writer.write(buildBaseInput('xfer-1'));

    const all = await writer.readAll();
    expect(all.map((e) => e.id)).toEqual(['xfer-1']);
  });
});
