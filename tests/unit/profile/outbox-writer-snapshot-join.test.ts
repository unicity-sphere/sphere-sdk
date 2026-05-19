/**
 * Tests for `OutboxWriter.snapshot()` + `OutboxWriter.joinSnapshot()` —
 * Item #15 Phase B.2.
 *
 * Locks the contract:
 *   - snapshot() returns every key under `${addr}.outbox.*` as raw
 *     encrypted bytes (live AND tombstones).
 *   - joinSnapshot() applies the Phase B merge table per entry.
 *   - Lamports are NOT bumped at JOIN time (remote's stamp persists).
 *   - Legacy entries: remote rejected, local treated as live lamport=0.
 *   - Out-of-bounds Lamports in remote are rejected.
 *   - Idempotence: re-running with the same remote is a no-op.
 *   - Encryption round-trip: encrypted bytes JOIN correctly across two
 *     writers that share a key.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Lamport } from '../../../profile/lamport.js';
import {
  OutboxWriter,
  type OutboxWriteInput,
} from '../../../profile/outbox-writer.js';
import { encryptProfileValue } from '../../../profile/encryption.js';
import { MAX_SAFE_LAMPORT } from '../../../profile/profile-snapshot-merge.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';
import type {
  LegacyOutboxEntry,
} from '../../../types/uxf-outbox.js';

// ---------------------------------------------------------------------------
// Fixtures (mirror outbox-writer.test.ts to keep the suites side-by-side)
// ---------------------------------------------------------------------------

const ADDR_A = 'DIRECT_aabbcc_ddeeff';
const ADDR_B = 'DIRECT_112233_445566';
const KEY_PREFIX_A = `${ADDR_A}.outbox.`;

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

function buildWriter(
  db: MockProfileDb,
  opts: { lamport?: Lamport; encryptionKey?: Uint8Array | null; addressId?: string } = {},
): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey: opts.encryptionKey ?? null,
    addressId: opts.addressId ?? ADDR_A,
    lamport: opts.lamport ?? new Lamport(),
  });
}

async function plantRaw(db: MockProfileDb, key: string, json: string): Promise<void> {
  await db.put(key, new TextEncoder().encode(json));
}

// =============================================================================
// 1. snapshot() — prefix scan returns live + tombstones
// =============================================================================

describe('OutboxWriter.snapshot — prefix-scan', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = buildWriter(db);
  });

  it('returns empty array on empty store', async () => {
    const snap = await writer.snapshot();
    expect(snap).toEqual([]);
  });

  it('returns every key under the address prefix, sorted', async () => {
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

  it('includes tombstones (live + tombstone both surface)', async () => {
    await writer.write(buildBaseInput('a'));
    await writer.write(buildBaseInput('b'));
    await writer.delete('b'); // tombstone
    const snap = await writer.snapshot();
    expect(snap).toHaveLength(2);
    const bEntry = snap.find((e) => e.key === `${KEY_PREFIX_A}b`)!;
    expect(bEntry).toBeTruthy();
    // The tombstone bytes carry { tombstoned: true, ... } when decoded.
    const decoded = JSON.parse(new TextDecoder().decode(bEntry.encryptedValue));
    expect(decoded.tombstoned).toBe(true);
  });

  it('does not include entries from other addresses', async () => {
    const dbA = createMockDb();
    const writerA = buildWriter(dbA, { addressId: ADDR_A });
    const writerB = buildWriter(dbA, { addressId: ADDR_B });
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

describe('OutboxWriter.joinSnapshot — merge table', () => {
  it('absent + live → write remote', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(1);
    expect(res.localWon).toBe(0);
    expect(res.remoteRejectedMalformed).toBe(0);

    const read = await writerA.readOne('e1');
    expect(read?.shape).toBe('uxf-1');
  });

  it('absent + tombstone → write remote', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.delete('e1');
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.tombstonesLanded).toBe(1);
    // Tombstone landed: readOne returns null (tombstones are not live).
    expect(await writerA.readOne('e1')).toBeNull();
    // But the raw bytes are present.
    const raw = await peerA.get(`${KEY_PREFIX_A}e1`);
    expect(raw).not.toBeNull();
  });

  it('live + live → remote wins when remote lamport higher', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1', { status: 'packaging' }));
    expect((await writerA.readOne('e1'))?.entry.status).toBe('packaging');

    // Build a remote with a higher lamport (do 3 writes on peer B for the
    // same id, then snapshot — third write has lamport=3).
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1', { status: 'packaging' }));
    await writerB.update('e1', (e) => ({ ...e, status: 'sending' }));
    await writerB.update('e1', (e) => ({ ...e, status: 'sending' }));
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(1);
    const after = await writerA.readOne('e1');
    expect(after?.shape).toBe('uxf-1');
    if (after?.shape === 'uxf-1') {
      expect(after.entry.status).toBe('sending');
      // Remote's lamport (3) preserved verbatim — JOIN does not re-bump.
      expect(after.entry.lamport).toBe(3);
    }
  });

  it('live + live → local wins when local lamport higher', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));
    await writerA.update('e1', (e) => ({ ...e, status: 'sending' }));
    await writerA.update('e1', (e) => ({ ...e, status: 'sending' }));
    const localLamportBefore = (await writerA.readOne('e1'));
    expect(localLamportBefore?.shape).toBe('uxf-1');

    // Remote at lamport=1 only.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1', { status: 'packaging' }));
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(0);
    expect(res.localWon).toBe(1);
    const after = await writerA.readOne('e1');
    if (after?.shape === 'uxf-1') {
      // Local 'sending' preserved.
      expect(after.entry.status).toBe('sending');
    }
  });

  it('live + tombstone (tomb >= live lamport) → tombstone wins', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));
    // Remote: write + delete → tombstone at lamport=2.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.delete('e1');
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.tombstonesLanded).toBe(1);
    expect(await writerA.readOne('e1')).toBeNull();
  });

  it('live + tombstone (tomb < live lamport) → local live wins', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));
    await writerA.update('e1', (e) => ({ ...e, status: 'sending' }));
    await writerA.update('e1', (e) => ({ ...e, status: 'sending' }));
    // Remote: tombstone at lamport=1 only.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.delete('e1'); // first write is delete → lamport=1 tombstone
    const snapB = await writerB.snapshot();
    expect(snapB).toHaveLength(1);

    const res = await writerA.joinSnapshot(snapB);
    expect(res.tombstonesLanded).toBe(0);
    expect(res.localWon).toBe(1);
    expect((await writerA.readOne('e1'))?.shape).toBe('uxf-1');
  });

  it('tombstone + live (live > tomb lamport) → live resurrects', async () => {
    // Local: tombstone at lamport=1.
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.delete('e1');
    // Remote: live entry at lamport=3.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.update('e1', (e) => ({ ...e, status: 'sending' }));
    await writerB.update('e1', (e) => ({ ...e, status: 'sending' }));
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(1);
    const after = await writerA.readOne('e1');
    expect(after?.shape).toBe('uxf-1');
    if (after?.shape === 'uxf-1') {
      expect(after.entry.status).toBe('sending');
    }
  });

  it('tombstone + live (equal lamport) → tombstone preserved (sticky)', async () => {
    // Local: write (lamport=1) then delete (lamport=2) — tombstone at 2.
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));
    await writerA.delete('e1');
    // Remote: write+update → live at lamport=2.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.update('e1', (e) => ({ ...e, status: 'sending' }));
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    // Sticky tombstone: equal lamports → local tombstone preserved.
    expect(res.localWon).toBe(1);
    expect(res.liveLanded).toBe(0);
    expect(await writerA.readOne('e1')).toBeNull();
  });

  it('tombstone + tombstone → higher lamport wins', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.delete('e1'); // lamport=1
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1')); // lamport=1
    await writerB.delete('e1'); // lamport=2
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.tombstonesLanded).toBe(1);
    expect(await writerA.readOne('e1')).toBeNull();
    // Local tombstone replaced with remote's (lamport=2). Verify by
    // checking the lamport encoded in the bytes.
    const raw = await peerA.get(`${KEY_PREFIX_A}e1`);
    const decoded = JSON.parse(new TextDecoder().decode(raw!));
    expect(decoded.lamport).toBe(2);
  });
});

// =============================================================================
// 3. Idempotence
// =============================================================================

describe('OutboxWriter.joinSnapshot — idempotence', () => {
  it('re-running the JOIN with the same remote yields zero writes', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.write(buildBaseInput('e2'));
    const snapB = await writerB.snapshot();

    const first = await writerA.joinSnapshot(snapB);
    expect(first.liveLanded).toBe(2);

    const second = await writerA.joinSnapshot(snapB);
    expect(second.liveLanded).toBe(0);
    expect(second.localWon).toBe(2);

    const third = await writerA.joinSnapshot(snapB);
    expect(third.localWon).toBe(2);
  });
});

// =============================================================================
// 4. Bidirectional convergence
// =============================================================================

describe('OutboxWriter.joinSnapshot — bidirectional convergence', () => {
  it('two peers JOIN → both converge to the higher-Lamport state', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);

    // Both write the same id concurrently.
    await writerA.write(buildBaseInput('e1'));
    await writerA.update('e1', (e) => ({ ...e, status: 'sending' }));
    await writerA.update('e1', (e) => ({ ...e, status: 'sending' })); // lamport=3
    await writerB.write(buildBaseInput('e1')); // status=packaging, lamport=1

    // A pulls B → A keeps its higher state.
    const aFromB = await writerA.joinSnapshot(await writerB.snapshot());
    expect(aFromB.localWon).toBe(1);
    // B pulls A → B takes A's higher state.
    const bFromA = await writerB.joinSnapshot(await writerA.snapshot());
    expect(bFromA.liveLanded).toBe(1);

    const afterA = await writerA.readOne('e1');
    const afterB = await writerB.readOne('e1');
    expect(afterA?.shape).toBe('uxf-1');
    expect(afterB?.shape).toBe('uxf-1');
    if (afterA?.shape === 'uxf-1' && afterB?.shape === 'uxf-1') {
      expect(afterA.entry.status).toBe(afterB.entry.status);
      expect(afterA.entry.status).toBe('sending');
      expect(afterA.entry.lamport).toBe(afterB.entry.lamport);
      expect(afterA.entry.lamport).toBe(3);
    }
  });

  it('non-overlapping union — A and B both have unique entries', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerA.write(buildBaseInput('a-only'));
    await writerB.write(buildBaseInput('b-only'));

    await writerA.joinSnapshot(await writerB.snapshot());
    await writerB.joinSnapshot(await writerA.snapshot());

    expect((await writerA.readAll()).map((c) => c.entry.id).sort()).toEqual(['a-only', 'b-only']);
    expect((await writerB.readAll()).map((c) => c.entry.id).sort()).toEqual(['a-only', 'b-only']);
  });
});

// =============================================================================
// 5. Legacy entry handling
// =============================================================================

describe('OutboxWriter.joinSnapshot — legacy entries', () => {
  it('remote legacy entry → rejected as malformed (does not propagate)', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    // Plant a legacy entry directly in B's store.
    await plantRaw(peerB, `${KEY_PREFIX_A}e1`, JSON.stringify(buildLegacyEntry('e1')));
    const writerB = buildWriter(peerB);
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
    expect(res.localWon).toBe(0);
    // Local stays absent.
    expect(await writerA.readOne('e1')).toBeNull();
  });

  it('local legacy + remote uxf-1 → uxf-1 overwrites legacy', async () => {
    const peerA = createMockDb();
    // Plant legacy locally.
    await plantRaw(peerA, `${KEY_PREFIX_A}e1`, JSON.stringify(buildLegacyEntry('e1')));
    const writerA = buildWriter(peerA);
    // Remote has uxf-1.
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    const snapB = await writerB.snapshot();

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(1);
    const after = await writerA.readOne('e1');
    expect(after?.shape).toBe('uxf-1');
  });
});

// =============================================================================
// 6. Malformed remote
// =============================================================================

describe('OutboxWriter.joinSnapshot — malformed remote', () => {
  it('garbage bytes → counted as remoteRejectedMalformed; local untouched', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));

    const garbage = new TextEncoder().encode('not-json{');
    const res = await writerA.joinSnapshot([
      { key: `${KEY_PREFIX_A}e1`, encryptedValue: garbage },
      { key: `${KEY_PREFIX_A}e2`, encryptedValue: garbage },
    ]);
    expect(res.remoteRejectedMalformed).toBe(2);
    expect(res.liveLanded).toBe(0);
    expect((await writerA.readOne('e1'))?.shape).toBe('uxf-1');
  });

  it('foreign-prefix key → rejected (no cross-writer contamination)', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const foreignBytes = new TextEncoder().encode(
      JSON.stringify({ _schemaVersion: 'uxf-1', lamport: 5 }),
    );
    const res = await writerA.joinSnapshot([
      { key: `${ADDR_B}.outbox.e1`, encryptedValue: foreignBytes },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
  });

  it('out-of-bounds remote Lamport → rejected', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    // Build a valid uxf-1 entry but stamp a hostile Lamport.
    const hostile = {
      ...buildBaseInput('e1'),
      _schemaVersion: 'uxf-1',
      lamport: MAX_SAFE_LAMPORT + 1,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(hostile));
    const res = await writerA.joinSnapshot([
      { key: `${KEY_PREFIX_A}e1`, encryptedValue: bytes },
    ]);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(await writerA.readOne('e1')).toBeNull();
  });
});

// =============================================================================
// 7. Encryption end-to-end
// =============================================================================

describe('OutboxWriter.joinSnapshot — with encryption', () => {
  it('encrypted snapshot JOINs into encrypted local store (shared key)', async () => {
    // 32-byte AES-256 key shared between peers.
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 1;

    const peerA = createMockDb();
    const writerA = buildWriter(peerA, { encryptionKey: key });
    const peerB = createMockDb();
    const writerB = buildWriter(peerB, { encryptionKey: key });

    await writerB.write(buildBaseInput('e1'));
    await writerB.update('e1', (e) => ({ ...e, status: 'sending' }));
    const snapB = await writerB.snapshot();

    // Sanity: snapshot bytes are encrypted (not JSON).
    expect(snapB).toHaveLength(1);
    const looksLikeJson = (() => {
      try {
        JSON.parse(new TextDecoder().decode(snapB[0].encryptedValue));
        return true;
      } catch {
        return false;
      }
    })();
    expect(looksLikeJson).toBe(false);

    const res = await writerA.joinSnapshot(snapB);
    expect(res.liveLanded).toBe(1);

    const after = await writerA.readOne('e1');
    expect(after?.shape).toBe('uxf-1');
    if (after?.shape === 'uxf-1') {
      expect(after.entry.status).toBe('sending');
    }
  });

  it('encrypted snapshot from wrong-key peer → rejected as malformed', async () => {
    const keyA = new Uint8Array(32);
    const keyB = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      keyA[i] = i + 1;
      keyB[i] = i + 100;
    }

    const peerA = createMockDb();
    const writerA = buildWriter(peerA, { encryptionKey: keyA });
    const peerB = createMockDb();
    const writerB = buildWriter(peerB, { encryptionKey: keyB });
    await writerB.write(buildBaseInput('e1'));

    const snapB = await writerB.snapshot();
    const res = await writerA.joinSnapshot(snapB);
    expect(res.remoteRejectedMalformed).toBe(1);
    expect(res.liveLanded).toBe(0);
  });

  it('plaintext snapshot, plaintext local → JOINs correctly', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    const peerB = createMockDb();
    const writerB = buildWriter(peerB);
    await writerB.write(buildBaseInput('e1'));
    await writerB.write(buildBaseInput('e2'));

    const res = await writerA.joinSnapshot(await writerB.snapshot());
    expect(res.liveLanded).toBe(2);
  });

  it('encrypted snapshot bytes round-trip through real encryptProfileValue', async () => {
    // End-to-end belt-and-braces: ensure we can encrypt a synthetic
    // entry via the real encryption path, hand it to joinSnapshot, and
    // see the encryption round-trip end-to-end.
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 7;
    const peerA = createMockDb();
    const writerA = buildWriter(peerA, { encryptionKey: key });

    const synthetic = {
      ...buildBaseInput('e1'),
      _schemaVersion: 'uxf-1' as const,
      lamport: 5,
    };
    const ct = await encryptProfileValue(
      key,
      new TextEncoder().encode(JSON.stringify(synthetic)),
    );
    const res = await writerA.joinSnapshot([
      { key: `${KEY_PREFIX_A}e1`, encryptedValue: ct },
    ]);
    expect(res.liveLanded).toBe(1);
    const after = await writerA.readOne('e1');
    expect(after?.shape).toBe('uxf-1');
    if (after?.shape === 'uxf-1') {
      expect(after.entry.lamport).toBe(5);
    }
  });
});

// =============================================================================
// 8. Empty remote
// =============================================================================

describe('OutboxWriter.joinSnapshot — empty remote', () => {
  it('no remote entries → zero counters, no-op on local', async () => {
    const peerA = createMockDb();
    const writerA = buildWriter(peerA);
    await writerA.write(buildBaseInput('e1'));

    const res = await writerA.joinSnapshot([]);
    expect(res.entriesEvaluated).toBe(0);
    expect(res.liveLanded).toBe(0);
    expect(res.localWon).toBe(0);
    expect((await writerA.readOne('e1'))?.shape).toBe('uxf-1');
  });
});
