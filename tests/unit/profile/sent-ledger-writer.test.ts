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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import {
  SentLedgerWriter,
  type SentLedgerWriteInput,
} from '../../../extensions/uxf/profile/sent-ledger-writer.js';
import { SphereError } from '../../../core/errors.js';
import type { OrbitDbConfig, ProfileDatabase } from '../../../extensions/uxf/profile/types.js';

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
  });

  it('Issue #166 P1 #2 — re-writing a tombstoned slot is REFUSED by default', async () => {
    await writer.write(buildBaseInput('xfer-1'));
    await writer.delete('xfer-1');

    // Default behavior: tombstone resurrection rejected with
    // OUTBOX_ENTRY_TOMBSTONED. Prevents silent loss of the deletion
    // signal under concurrent-replica sync races.
    await expect(writer.write(buildBaseInput('xfer-1'))).rejects.toMatchObject({
      code: 'OUTBOX_ENTRY_TOMBSTONED',
    });
    // Slot still reads as absent.
    expect(await writer.readOne('xfer-1')).toBeNull();
  });

  it('Issue #166 P1 #2 — allowResurrection:true permits explicit resurrection (operator escape-hatch)', async () => {
    await writer.write(buildBaseInput('xfer-1'));
    await writer.delete('xfer-1');

    const restored = await writer.write(buildBaseInput('xfer-1'), {
      allowResurrection: true,
    });
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
  // 9. Cold-restart Lamport rehydration (regression test for steelman C2)
  // -------------------------------------------------------------------------
  it('cold-restart: a fresh writer with N≥3 prior entries does NOT throw LAMPORT_BOUND_VIOLATION on next write', async () => {
    // Plant 5 prior SENT entries by writing them through writer #1.
    for (let i = 0; i < 5; i += 1) {
      await writer.write(buildBaseInput(`prior-${i}`));
    }
    // Verify final lamport reached 5 — beyond the W39 bound for a fresh
    // clock (2 × max(0, 1) = 2).
    const all = await writer.readAll();
    expect(Math.max(...all.map((e) => e.lamport))).toBe(5);

    // Cold restart: a fresh writer with a brand-new Lamport(0).
    const writer2 = new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport: new Lamport(), // current=0, would reject observations >2 in bumpFor
    });

    // The next write MUST succeed and bump beyond the prior max.
    const next = await writer2.write(buildBaseInput('post-restart'));
    expect(next.lamport).toBeGreaterThan(5);
    expect(next.lamport).toBe(6);
  });

  // -------------------------------------------------------------------------
  // 10. Encrypted-path round-trip (regression test for steelman test-coverage gap)
  // -------------------------------------------------------------------------
  it('round-trips through real AES-256-GCM encryption when an encryptionKey is supplied', async () => {
    // Production path uses ~32-byte AES keys derived via HKDF from the
    // wallet master key. The other tests pass null and exercise the
    // unencrypted branch — this test pins the encrypted branch.
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) key[i] = (i * 7 + 3) & 0xff;

    const encDb = createMockDb();
    const encWriter = new SentLedgerWriter({
      db: encDb,
      encryptionKey: key,
      addressId: ADDR,
      lamport: new Lamport(),
    });

    const input = buildBaseInput('xfer-secret', { tokenIds: ['0xsecret-token-a'] });
    const written = await encWriter.write(input);

    // The on-disk bytes MUST NOT be the plaintext JSON.
    const rawBytes = encDb._store.get(encWriter.keyFor('xfer-secret'));
    expect(rawBytes).toBeDefined();
    const plaintext = JSON.stringify(input);
    const rawAsText = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes!);
    expect(rawAsText.includes('0xsecret-token-a')).toBe(false);
    expect(rawAsText.includes('xfer-secret')).toBe(false);
    expect(rawAsText.includes(plaintext)).toBe(false);

    // Round-trip through readOne MUST recover the entry.
    const read = await encWriter.readOne('xfer-secret');
    expect(read).toEqual(written);
    expect(read?.tokenIds).toEqual(['0xsecret-token-a']);
  });

  // -------------------------------------------------------------------------
  // 11. Confined keyspace — does not cross into outbox or other addresses
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

  // -------------------------------------------------------------------------
  // OUTBOX-SEND-FOLLOWUPS item #3 — contains() backed by O(1) index
  // -------------------------------------------------------------------------
  //
  // The original Issue #166 P4 #3 cost contract pinned an O(n × m)
  // full-decrypt path on every call. Item #3 replaces that with a
  // lazy in-memory `tokenId → entryId` index: the first lookup builds
  // the index from `readAll()` (still O(n × m)); subsequent lookups
  // are O(1) Map.has on the warmed index. Writes and deletes
  // maintain the index incrementally in O(m).

  describe('contains() cost contract — O(1) miss / O(b) verify-on-hit (OUTBOX-SEND-FOLLOWUPS item #3)', () => {
    it('first call builds the index (one full decrypt pass); subsequent miss calls perform zero db.get', async () => {
      for (let i = 0; i < 5; i += 1) {
        await writer.write(buildBaseInput(`xfer-${i}`));
      }

      const getSpy = vi.spyOn(db, 'get');

      // First contains() — builds the index via readAll(). 5 entries
      // → 5 db.get calls.
      const r1 = await writer.contains('not-a-real-token');
      expect(r1).toBe(false);
      expect(getSpy).toHaveBeenCalledTimes(5);

      // Second contains() (miss) — index is warm; the Map.get fails
      // fast, no storage I/O.
      getSpy.mockClear();
      const r2 = await writer.contains('still-no-such-token');
      expect(r2).toBe(false);
      expect(getSpy).toHaveBeenCalledTimes(0);

      // Third contains() (hit) — verify-on-hit reads exactly one
      // entry per bucket member to defend against cross-replica
      // staleness. Bucket size is 1 → exactly one db.get.
      getSpy.mockClear();
      const r3 = await writer.contains(`0xtok-xfer-0-a`);
      expect(r3).toBe(true);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('write() incrementally extends the index (next contains() hit avoids the full readAll rebuild)', async () => {
      await writer.write(buildBaseInput('xfer-0'));
      // Warm the index.
      const r0 = await writer.contains(`0xtok-xfer-0-a`);
      expect(r0).toBe(true);

      // New entry; the in-line index update means contains() for its
      // token reads ONE entry (verify-on-hit), not the full prefix.
      await writer.write(buildBaseInput('xfer-1'));
      const getSpy = vi.spyOn(db, 'get');
      const hit = await writer.contains(`0xtok-xfer-1-b`);
      expect(hit).toBe(true);
      expect(getSpy).toHaveBeenCalledTimes(1);
    });

    it('delete() removes the entry from the index incrementally', async () => {
      await writer.write(buildBaseInput('xfer-0'));
      const r0 = await writer.contains(`0xtok-xfer-0-a`);
      expect(r0).toBe(true);

      await writer.delete('xfer-0');

      // contains() for the deleted entry's tokenId must now be false
      // AND must not trigger storage I/O (the index was maintained
      // in-line by delete(); the Map.get fails fast).
      const getSpy = vi.spyOn(db, 'get');
      const stillThere = await writer.contains(`0xtok-xfer-0-a`);
      expect(stillThere).toBe(false);
      expect(getSpy).toHaveBeenCalledTimes(0);
    });

    it('write() of an existing id with different tokenIds drops the old tokenIds from the index', async () => {
      // Second-write-wins: the same id is re-stamped with a different
      // tokenIds set. The old tokenIds must no longer report present.
      await writer.write(
        buildBaseInput('xfer-stable', { tokenIds: ['tok-A', 'tok-B'] }),
      );
      const r0 = await writer.contains('tok-A');
      expect(r0).toBe(true);

      await writer.write(
        buildBaseInput('xfer-stable', { tokenIds: ['tok-C', 'tok-D'] }),
      );

      const getSpy = vi.spyOn(db, 'get');
      // Old tokenIds removed (miss → 0 db.get):
      expect(await writer.contains('tok-A')).toBe(false);
      expect(await writer.contains('tok-B')).toBe(false);
      // New tokenIds present (hit → 1 verify-on-hit db.get each):
      expect(await writer.contains('tok-C')).toBe(true);
      expect(await writer.contains('tok-D')).toBe(true);
      // 0 + 0 + 1 + 1 = 2 db.get total.
      expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it('findByTokenId() round-trips through the index then reads one entry per hit', async () => {
      // 3 entries with tok-shared in their tokenIds; one with only
      // a private token.
      await writer.write(
        buildBaseInput('e-1', { tokenIds: ['tok-shared', 'tok-1'] }),
      );
      await writer.write(
        buildBaseInput('e-2', { tokenIds: ['tok-shared', 'tok-2'] }),
      );
      await writer.write(
        buildBaseInput('e-3', { tokenIds: ['tok-shared', 'tok-3'] }),
      );
      await writer.write(buildBaseInput('e-private', { tokenIds: ['tok-priv'] }));

      // Warm the index.
      await writer.contains('warmup');

      const getSpy = vi.spyOn(db, 'get');
      const matches = await writer.findByTokenId('tok-shared');
      expect(matches.map((e) => e.id).sort()).toEqual(['e-1', 'e-2', 'e-3']);
      // One db.get per hit (readOne for each matched id). No full scan.
      expect(getSpy).toHaveBeenCalledTimes(3);
    });

    it('cross-replica staleness: contains() returns false for a tokenId whose entry was tombstoned by a peer', async () => {
      // Simulate a peer-driven tombstone: writer A wrote the entry,
      // then writer B (sharing the same db) tombstones it. A's
      // in-memory index still references the entry; verify-on-hit
      // catches the staleness and returns false.
      await writer.write(buildBaseInput('shared-id'));
      // Confirm a's index sees the entry.
      expect(await writer.contains(`0xtok-shared-id-a`)).toBe(true);

      // Build a second writer pointed at the same db, and use it to
      // tombstone the entry — bypassing writer's local delete().
      const writerPeer = new SentLedgerWriter({
        db,
        encryptionKey: null,
        addressId: 'DIRECT_aabbcc_ddeeff',
        lamport: new Lamport(),
      });
      await writerPeer.delete('shared-id');

      // writer's in-memory index still has the stale entry, but
      // verify-on-hit reads from durable storage and sees null →
      // returns false AND prunes the stale id from the index.
      expect(await writer.contains(`0xtok-shared-id-a`)).toBe(false);

      // Subsequent calls for the same tokenId are O(1) misses
      // (the stale id was evicted on the previous call).
      const getSpy = vi.spyOn(db, 'get');
      expect(await writer.contains(`0xtok-shared-id-a`)).toBe(false);
      expect(getSpy).toHaveBeenCalledTimes(0);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #166 P4 #1 — addressId shape validation
  // -------------------------------------------------------------------------
  describe('addressId shape validation (Issue #166 P4 #1)', () => {
    it('accepts the canonical DIRECT_[0-9a-f]{6}_[0-9a-f]{6} shape', () => {
      expect(
        () =>
          new SentLedgerWriter({
            db,
            encryptionKey: null,
            addressId: 'DIRECT_aabbcc_ddeeff',
            lamport,
          }),
      ).not.toThrow();
    });

    it.each([
      ['DIRECT_a.b_cd', 'dot in first segment'],
      ['DIRECT_aabbcc_d.eeff', 'dot in last segment'],
      ['DIRECT_aabbc_ddeeff', 'first segment 5 chars'],
      ['direct_aabbcc_ddeeff', 'lowercase DIRECT'],
      ['DIRECT_aabbcZ_ddeeff', 'non-hex char'],
      ['DIRECT_AABBCC_DDEEFF', 'uppercase hex'],
      ['DIRECT_aabbcc_ddeeff/', 'trailing slash'],
      ['addr-alice', 'non-canonical alias'],
      ['test', 'short ad-hoc id'],
    ])('rejects %s (%s)', (badId, _label) => {
      expect(
        () =>
          new SentLedgerWriter({
            db,
            encryptionKey: null,
            addressId: badId,
            lamport,
          }),
      ).toThrow(SphereError);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #166 P4 #2 — type-guard range tightening
  // -------------------------------------------------------------------------
  describe('isUxfSentLedgerEntry — P4 #2 range tightening', () => {
    function makeValid(): unknown {
      return {
        _schemaVersion: 'uxf-1',
        id: 'x',
        tokenIds: ['t'],
        bundleCid: 'b',
        recipientTransportPubkey: 'r'.repeat(64),
        deliveryMethod: 'car-over-nostr',
        mode: 'conservative',
        sentAt: 1_700_000_000_000,
        lamport: 1,
      };
    }

    // Wire up isUxfSentLedgerEntry via dynamic import so we don't
    // pollute the existing top-of-file imports.
    let isUxfSentLedgerEntry: (v: unknown) => boolean;
    beforeEach(async () => {
      const mod = await import('../../../extensions/uxf/types/uxf-sent.js');
      isUxfSentLedgerEntry = mod.isUxfSentLedgerEntry;
    });

    it('accepts 0 for sentAt/lamport (boundary)', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), sentAt: 0, lamport: 0 }),
      ).toBe(true);
    });

    it('rejects negative sentAt', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), sentAt: -1 }),
      ).toBe(false);
    });

    it('rejects non-integer sentAt (0.5)', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), sentAt: 0.5 }),
      ).toBe(false);
    });

    it('rejects negative lamport', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), lamport: -1 }),
      ).toBe(false);
    });

    it('rejects non-integer lamport (1.5)', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), lamport: 1.5 }),
      ).toBe(false);
    });

    it('rejects NaN lamport', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), lamport: NaN }),
      ).toBe(false);
    });

    it('rejects Infinity sentAt', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), sentAt: Infinity }),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #166 P1 #3 — DoS bounds-defense at the type-guard gate.
  // -------------------------------------------------------------------------
  describe('isUxfSentLedgerEntry — P1 #3 size caps', () => {
    function makeValid(): unknown {
      return {
        _schemaVersion: 'uxf-1',
        id: 'x',
        tokenIds: ['t'],
        bundleCid: 'b',
        recipientTransportPubkey: 'r'.repeat(64),
        deliveryMethod: 'car-over-nostr',
        mode: 'conservative',
        sentAt: 1_700_000_000_000,
        lamport: 1,
      };
    }

    let isUxfSentLedgerEntry: (v: unknown) => boolean;
    beforeEach(async () => {
      const mod = await import('../../../extensions/uxf/types/uxf-sent.js');
      isUxfSentLedgerEntry = mod.isUxfSentLedgerEntry;
    });

    it('accepts tokenIds.length at the cap (4096) — boundary', () => {
      const tokenIds = Array.from({ length: 4096 }, (_, i) => `t${i}`);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), tokenIds }),
      ).toBe(true);
    });

    it('rejects tokenIds.length > MAX_TOKEN_IDS_PER_ENTRY (4097)', () => {
      const tokenIds = Array.from({ length: 4097 }, (_, i) => `t${i}`);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), tokenIds }),
      ).toBe(false);
    });

    it('rejects a single tokenId longer than MAX_TOKEN_ID_LENGTH (256+1)', () => {
      const longId = 'a'.repeat(257);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), tokenIds: [longId] }),
      ).toBe(false);
    });

    it('rejects empty-string tokenId', () => {
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), tokenIds: [''] }),
      ).toBe(false);
    });

    it('rejects bundleCid longer than MAX_BUNDLE_CID_LENGTH (256+1)', () => {
      const bundleCid = 'a'.repeat(257);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), bundleCid }),
      ).toBe(false);
    });

    it('rejects recipient longer than MAX_RECIPIENT_LENGTH (1024+1) when present', () => {
      const recipient = 'a'.repeat(1025);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), recipient }),
      ).toBe(false);
    });

    it('rejects recipientNametag longer than MAX_NAMETAG_LENGTH (256+1) when present', () => {
      const recipientNametag = 'a'.repeat(257);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), recipientNametag }),
      ).toBe(false);
    });

    it('rejects recipientTransportPubkey longer than MAX_TRANSPORT_PUBKEY_LENGTH (128+1)', () => {
      const recipientTransportPubkey = 'a'.repeat(129);
      expect(
        isUxfSentLedgerEntry({
          ...(makeValid() as object),
          recipientTransportPubkey,
        }),
      ).toBe(false);
    });

    it('rejects nostrEventId longer than MAX_NOSTR_EVENT_ID_LENGTH (128+1)', () => {
      const nostrEventId = 'a'.repeat(129);
      expect(
        isUxfSentLedgerEntry({ ...(makeValid() as object), nostrEventId }),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Issue #166 P1 #2 — tombstone Lamport + refuse-write guard.
  // -------------------------------------------------------------------------
  describe('SentLedgerWriter — P1 #2 tombstone Lamport + refuse-write', () => {
    let db: MockProfileDb;
    let writer: SentLedgerWriter;

    beforeEach(() => {
      db = createMockDb();
      writer = new SentLedgerWriter({
        db,
        encryptionKey: null,
        addressId: 'DIRECT_aabbcc_ddeeff',
        lamport: new Lamport(),
      });
    });

    it('delete() stamps tombstone with Lamport > prior write Lamport', async () => {
      const written = await writer.write(buildBaseInput('a'));
      await writer.delete('a');

      const raw = db._store.get(`DIRECT_aabbcc_ddeeff.sent.a`);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(new TextDecoder().decode(raw!)) as {
        tombstoned: boolean;
        deletedAt: number;
        lamport: number;
      };
      expect(parsed.tombstoned).toBe(true);
      expect(parsed.lamport).toBeGreaterThan(written.lamport);
    });

    it('write() refuses to resurrect tombstoned slot by default', async () => {
      await writer.write(buildBaseInput('zombie'));
      await writer.delete('zombie');

      await expect(writer.write(buildBaseInput('zombie'))).rejects.toMatchObject(
        { code: 'OUTBOX_ENTRY_TOMBSTONED' },
      );
    });

    it('write({ allowResurrection: true }) permits explicit resurrection', async () => {
      await writer.write(buildBaseInput('zombie'));
      await writer.delete('zombie');

      const restored = await writer.write(buildBaseInput('zombie'), {
        allowResurrection: true,
      });
      expect(restored.id).toBe('zombie');
      expect(await writer.readOne('zombie')).not.toBeNull();
    });

    it('legacy tombstone (no lamport field) is still refused', async () => {
      // Plant a legacy tombstone directly.
      const legacy = JSON.stringify({ tombstoned: true, deletedAt: 1 });
      db._store.set(
        `DIRECT_aabbcc_ddeeff.sent.old`,
        new TextEncoder().encode(legacy),
      );

      await expect(writer.write(buildBaseInput('old'))).rejects.toMatchObject({
        code: 'OUTBOX_ENTRY_TOMBSTONED',
      });
    });

    it('pre-decrypt size cap (1MB) rejects oversized blobs', async () => {
      const big = new Uint8Array(2 * 1024 * 1024);
      big.fill(0xff);
      db._store.set(`DIRECT_aabbcc_ddeeff.sent.toobig`, big);

      expect(await writer.readOne('toobig')).toBeNull();
      expect(await writer.readAll()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // OUTBOX-SEND-FOLLOWUPS item #4 — gcExpiredTombstones
  // -------------------------------------------------------------------------
  //
  // Mirror of the OutboxWriter GC test suite. SENT tombstones are rare
  // in production (the ledger is permanent except on operator escape-
  // hatch paths), but the storage-reclamation contract is the same.

  describe('gcExpiredTombstones (OUTBOX-SEND-FOLLOWUPS item #4)', () => {
    it('purges tombstones older than retentionMs (db.get returns null AND the key is gone)', async () => {
      await writer.write(buildBaseInput('xfer-old'));
      await writer.delete('xfer-old');

      const keys = [...db._store.keys()].filter((k) => k.endsWith('.xfer-old'));
      expect(keys).toHaveLength(1);
      const k = keys[0];

      const result = await writer.gcExpiredTombstones({
        retentionMs: 0,
        now: Date.now() + 60_000,
      });
      expect(result.scanned).toBe(1);
      expect(result.purged).toBe(1);
      expect(result.kept).toBe(0);
      expect(db._store.has(k)).toBe(false);
      expect(await writer.readOne('xfer-old')).toBeNull();
    });

    it('keeps tombstones inside the retention window', async () => {
      await writer.write(buildBaseInput('xfer-fresh'));
      const t0 = Date.now();
      await writer.delete('xfer-fresh');

      const result = await writer.gcExpiredTombstones({
        retentionMs: 30 * 24 * 60 * 60 * 1000,
        now: t0 + 60_000,
      });
      expect(result.kept).toBe(1);
      expect(result.purged).toBe(0);
      expect(
        [...db._store.keys()].filter((k) => k.endsWith('.xfer-fresh')),
      ).toHaveLength(1);
    });

    it('rejects malformed retentionMs', async () => {
      await expect(
        writer.gcExpiredTombstones({ retentionMs: -1 }),
      ).rejects.toThrow(/retentionMs/);
    });

    it('after purge, a fresh write at the same id is NOT refused', async () => {
      await writer.write(buildBaseInput('reused'));
      await writer.delete('reused');
      await writer.gcExpiredTombstones({
        retentionMs: 0,
        now: Date.now() + 60_000,
      });
      await expect(
        writer.write(buildBaseInput('reused')),
      ).resolves.toBeTruthy();
    });
  });
});
