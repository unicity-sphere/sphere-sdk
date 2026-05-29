/**
 * Tests for `SentLedgerWriter.snapshot()` + `SentLedgerWriter.joinSnapshot()`
 * — Item #15 Phase B.3.
 *
 * Locks the contract:
 *   - snapshot() returns every key under `${addr}.sent.*` (live + tombs).
 *   - joinSnapshot() applies the Phase B merge table per entry.
 *   - In-memory tokenId index invalidates after any landed write so
 *     subsequent `contains()` / `findByTokenId` calls see fresh state.
 *   - Idempotence + bidirectional convergence + malformed handling +
 *     encryption end-to-end (matches the OutboxWriter shape).
 */

import { describe, it, expect } from 'vitest';
import { Lamport } from '../../../profile/lamport.js';
import {
  SentLedgerWriter,
  type SentLedgerWriteInput,
} from '../../../profile/sent-ledger-writer.js';
import { MAX_SAFE_LAMPORT } from '../../../profile/profile-snapshot-merge.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';

// ---------------------------------------------------------------------------
// Fixtures (mirror sent-ledger-writer.test.ts)
// ---------------------------------------------------------------------------

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';
const KEY_PREFIX_A = `${ADDR_A}.sent.`;

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

function buildWriter(
  db: MockProfileDb,
  opts: { encryptionKey?: Uint8Array | null; addressId?: string } = {},
): SentLedgerWriter {
  return new SentLedgerWriter({
    db,
    encryptionKey: opts.encryptionKey ?? null,
    addressId: opts.addressId ?? ADDR_A,
    lamport: new Lamport(),
  });
}

// =============================================================================
// 1. snapshot — prefix scan returns live + tombstones
// =============================================================================

describe('SentLedgerWriter.snapshot — prefix-scan', () => {
  it('returns empty array on empty store', async () => {
    const writer = buildWriter(createMockDb());
    expect(await writer.snapshot()).toEqual([]);
  });

  it('returns every key under the address prefix, sorted', async () => {
    const writer = buildWriter(createMockDb());
    await writer.write(buildBaseInput('z'));
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('m'));
    const snap = await writer.snapshot();
    expect(snap.map((e) => e.key)).toEqual([
      `${KEY_PREFIX_A}a`,
      `${KEY_PREFIX_A}m`,
      `${KEY_PREFIX_A}z`,
    ]);
  });

  it('includes tombstones', async () => {
    const writer = buildWriter(createMockDb());
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('b'));
    await writer.delete('b');
    const snap = await writer.snapshot();
    expect(snap).toHaveLength(2);
    const bEntry = snap.find((e) => e.key === `${KEY_PREFIX_A}b`)!;
    const decoded = JSON.parse(new TextDecoder().decode(bEntry.encryptedValue));
    expect(decoded.tombstoned).toBe(true);
  });

  it('does not leak entries from other addresses', async () => {
    const db = createMockDb();
    const writerA = buildWriter(db, { addressId: ADDR_A });
    const writerB = buildWriter(db, { addressId: ADDR_B });
    await writerA.write(buildBaseInput('a1'));
    await writerB.write(buildBaseInput('b1'));
    const snapA = await writerA.snapshot();
    expect(snapA).toHaveLength(1);
    expect(snapA[0].key).toBe(`${KEY_PREFIX_A}a1`);
  });
});

// =============================================================================
// 2. joinSnapshot — merge table per cell
// =============================================================================

describe('SentLedgerWriter.joinSnapshot — merge table', () => {
  it('absent + live → write remote', async () => {
    const writerA = buildWriter(createMockDb());
    const writerB = buildWriter(createMockDb());
    await writerB.write(buildBaseInput('e1'));
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(1);
    expect(await writerA.readOne('e1')).not.toBeNull();
  });

  it('absent + tombstone → write remote', async () => {
    const writerA = buildWriter(createMockDb());
    const writerB = buildWriter(createMockDb());
    await writerB.write(buildBaseInput('e1'));
    await writerB.delete('e1');
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.tombstonesLanded).toBe(1);
    expect(await writerA.readOne('e1')).toBeNull();
  });

  it('live + live → higher Lamport wins (remote)', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));
    // Remote: 3 writes (different ids on B side, but for e1 specifically
    // we burn lamport by writing additional sibling entries).
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('warmup1')); // bumps clock to 1
    await writerB.write(buildBaseInput('warmup2')); // bumps clock to 2
    await writerB.write(buildBaseInput('e1', { recipient: '@charlie' })); // lamport=3
    // Snapshot of B includes warmup1, warmup2, e1. We only care e1 here.
    const snapB = (await writerB.snapshot()).filter((e) =>
      e.key === `${KEY_PREFIX_A}e1`,
    );
    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(1);
    const after = await writerA.readOne('e1');
    expect(after?.recipient).toBe('@charlie');
    expect(after?.lamport).toBe(3);
  });

  it('live + live → local wins when local Lamport higher', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('warmup1'));
    await writerA.write(buildBaseInput('warmup2'));
    await writerA.write(buildBaseInput('e1', { recipient: '@alice' })); // lamport=3

    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1', { recipient: '@charlie' })); // lamport=1
    const snapB = (await writerB.snapshot()).filter((e) =>
      e.key === `${KEY_PREFIX_A}e1`,
    );

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(0);
    expect(res.localWon).toBe(1);
    expect((await writerA.readOne('e1'))?.recipient).toBe('@alice');
  });

  it('live + tombstone (tomb >= live lamport) → tombstone wins', async () => {
    const writerA = buildWriter(createMockDb());
    await writerA.write(buildBaseInput('e1'));
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.delete('e1');
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.tombstonesLanded).toBe(1);
    expect(await writerA.readOne('e1')).toBeNull();
  });

  it('tombstone + tombstone → higher lamport wins', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.delete('e1'); // lamport=1
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.delete('e1'); // lamport=2
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.tombstonesLanded).toBe(1);
    const raw = await peerA.get(`${KEY_PREFIX_A}e1`);
    const decoded = JSON.parse(new TextDecoder().decode(raw!));
    expect(decoded.lamport).toBe(2);
  });
});

// =============================================================================
// 3. In-memory tokenId index invalidation
// =============================================================================

describe('SentLedgerWriter.joinSnapshot — tokenId index maintenance', () => {
  it('contains() reflects entries landed via JOIN', async () => {
    const writerA = buildWriter(createMockDb());
    // Prime the index before JOIN — empty so contains is always false.
    expect(await writerA.contains('0xtok-e1-a')).toBe(false);
    // JOIN brings in remote e1 with tokenIds ['0xtok-e1-a', '0xtok-e1-b'].
    const writerB = buildWriter(createMockDb());
    await writerB.write(buildBaseInput('e1'));
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(1);
    // After JOIN: contains() must observe the new tokenIds.
    expect(await writerA.contains('0xtok-e1-a')).toBe(true);
    expect(await writerA.contains('0xtok-e1-b')).toBe(true);
    expect(await writerA.contains('0xnonexistent')).toBe(false);
  });

  it('contains() drops tombstoned entries landed via JOIN', async () => {
    const writerA = buildWriter(createMockDb());
    // Pre-populate locally so the index sees the tokenIds.
    await writerA.write(buildBaseInput('e1'));
    expect(await writerA.contains('0xtok-e1-a')).toBe(true);
    // Remote tombstones e1 at a higher lamport — JOIN lands the tombstone.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.delete('e1'); // lamport=2 > local lamport=1
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.tombstonesLanded).toBe(1);
    // Index must reflect the eviction.
    expect(await writerA.contains('0xtok-e1-a')).toBe(false);
  });

  it('findByTokenId() reflects entries landed via JOIN', async () => {
    const writerA = buildWriter(createMockDb());
    const writerB = buildWriter(createMockDb());
    await writerB.write(
      buildBaseInput('e1', { tokenIds: ['shared-tok', '0xtok-e1-b'] }),
    );
    await writerB.write(
      buildBaseInput('e2', { tokenIds: ['shared-tok', '0xtok-e2-b'] }),
    );
    await writerA.joinSnapshot(await writerB.snapshot());
    const found = await writerA.findByTokenId('shared-tok');
    expect(found.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('no-op JOIN does not invalidate index unnecessarily', async () => {
    const writerA = buildWriter(createMockDb());
    await writerA.write(buildBaseInput('e1'));
    // Force-build the index.
    expect(await writerA.contains('0xtok-e1-a')).toBe(true);
    // Remote has nothing new — JOIN is a no-op.
    const writerB = buildWriter(createMockDb());
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.entriesEvaluated).toBe(0);
    // Index still works (rebuilds-or-cached, both correct).
    expect(await writerA.contains('0xtok-e1-a')).toBe(true);
  });
});

// =============================================================================
// 4. Idempotence + bidirectional convergence
// =============================================================================

describe('SentLedgerWriter.joinSnapshot — idempotence', () => {
  it('re-running JOIN with the same remote yields zero writes', async () => {
    const writerA = buildWriter(createMockDb());
    const writerB = buildWriter(createMockDb());
    await writerB.write(buildBaseInput('e1'));
    await writerB.write(buildBaseInput('e2'));
    const snapB = await writerB.snapshot();

    const first = await writerA.joinSnapshot(snapB);
    expect(first.liveLanded).toBe(2);
    const second = await writerA.joinSnapshot(snapB);
    expect(second.liveLanded).toBe(0);
    expect(second.localWon).toBe(2);
  });
});

describe('SentLedgerWriter.joinSnapshot — bidirectional convergence', () => {
  it('non-overlapping union', async () => {
    const writerA = buildWriter(createMockDb());
    const writerB = buildWriter(createMockDb());
    await writerA.write(buildBaseInput('a-only'));
    await writerB.write(buildBaseInput('b-only'));
    await writerA.joinSnapshot(await writerB.snapshot());
    await writerB.joinSnapshot(await writerA.snapshot());

    expect((await writerA.readAll()).map((e) => e.id).sort()).toEqual([
      'a-only',
      'b-only',
    ]);
    expect((await writerB.readAll()).map((e) => e.id).sort()).toEqual([
      'a-only',
      'b-only',
    ]);
  });
});

// =============================================================================
// 5. Malformed handling
// =============================================================================

describe('SentLedgerWriter.joinSnapshot — malformed remote', () => {
  it('garbage bytes → counted as remoteRejectedMalformed', async () => {
    const writerA = buildWriter(createMockDb());
    const garbage = new TextEncoder().encode('not-json{');
    const res = await writerA.joinSnapshot([
      { key: `${KEY_PREFIX_A}e1`, encryptedValue: garbage },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
  });

  it('foreign-prefix key → rejected', async () => {
    const writerA = buildWriter(createMockDb());
    const synthetic = new TextEncoder().encode(
      JSON.stringify({
        _schemaVersion: 'uxf-1',
        id: 'e1',
        lamport: 5,
        tokenIds: ['t'],
      }),
    );
    const res = await writerA.joinSnapshot([
      { key: `${ADDR_B}.sent.e1`, encryptedValue: synthetic },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('out-of-bounds remote Lamport → rejected', async () => {
    const writerA = buildWriter(createMockDb());
    const hostile = new TextEncoder().encode(
      JSON.stringify({
        _schemaVersion: 'uxf-1',
        id: 'e1',
        lamport: MAX_SAFE_LAMPORT + 1,
        tokenIds: ['0xtok'],
        bundleCid: 'bafy-e1',
        recipientTransportPubkey: 'a'.repeat(64),
        recipient: '@bob',
        deliveryMethod: 'car-over-nostr',
        mode: 'conservative',
        sentAt: 1_700_000_000_000,
      }),
    );
    const res = await writerA.joinSnapshot([
      { key: `${KEY_PREFIX_A}e1`, encryptedValue: hostile },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(await writerA.readOne('e1')).toBeNull();
  });
});

// =============================================================================
// 6. Encryption end-to-end
// =============================================================================

describe('SentLedgerWriter.joinSnapshot — with encryption', () => {
  it('encrypted snapshot JOINs into encrypted local store (shared key)', async () => {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 1;
    const writerA = buildWriter(createMockDb(), { encryptionKey: key });
    const writerB = buildWriter(createMockDb(), { encryptionKey: key });
    await writerB.write(buildBaseInput('e1'));
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(1);
    const after = await writerA.readOne('e1');
    expect(after?.id).toBe('e1');
  });

  it('encrypted snapshot from wrong-key peer → rejected', async () => {
    const keyA = new Uint8Array(32);
    const keyB = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      keyA[i] = i + 1;
      keyB[i] = i + 100;
    }
    const writerA = buildWriter(createMockDb(), { encryptionKey: keyA });
    const writerB = buildWriter(createMockDb(), { encryptionKey: keyB });
    await writerB.write(buildBaseInput('e1'));
    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.remoteRejectedMalformed).toBe(1);
  });
});
