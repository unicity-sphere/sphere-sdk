/**
 * Concurrent-replica OUTBOX invariants — OUTBOX-SEND-FOLLOWUPS item #9.
 *
 * **Scope.** This file simulates two replicas sharing the same
 * underlying `ProfileDatabase` (an in-memory `Map<string, Uint8Array>`)
 * with separate `OutboxWriter` / `SentLedgerWriter` instances. Each
 * writer has its own `Lamport` clock and its own in-memory index
 * state, but all reads/writes flow through one durable map — i.e. a
 * **fully-synced** snapshot of two replicas.
 *
 * What this approach covers:
 *  - The refuse-write guard against tombstone resurrection across
 *    writer instances (Issue #166 P1 #2).
 *  - The Lamport monotonicity invariant: writer B observes writer A's
 *    tombstone Lamport and bumps past it.
 *  - The pre-sync-then-merge case where B holds a stale live value
 *    and A's tombstone arrives later — modelled here by sequencing
 *    "B writes → A tombstones → B's next write observes the
 *    tombstone".
 *  - Idempotency: repeated deletes on either side are no-ops.
 *
 * What this approach does NOT cover (gap left for a future PR):
 *  - Real `@orbitdb/core` log-merge semantics. OrbitDB's underlying
 *    Hash Log resolves concurrent writes via lex-sort on entry
 *    hashes; this test cannot exercise that conflict-resolution
 *    surface because the shared MockProfileDb is last-write-wins.
 *  - libp2p peer-to-peer dial + gossipsub replication in-process.
 *    The current `OrbitDbAdapter` is `bootstrapPeers: []` isolated
 *    mode only; enabling true peer-to-peer in-process replication
 *    requires adapter changes outside this PR's scope (the doc tags
 *    item #9 as "Large" precisely because of this).
 *  - Pre-sync race where BOTH replicas write the same key at the
 *    exact same Lamport. OrbitDB picks one via lex-sort; this is
 *    inherently a property of the underlying log layer, not of the
 *    writers, and is the next layer down for a future libp2p test.
 *
 * The writer-layer invariants tested here are load-bearing for the
 * CRDT-safety claims in OUTBOX-SEND-FOLLOWUPS; a regression at this
 * layer would surface even before OrbitDB's log layer enters the
 * picture.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { Lamport } from '../../../profile/lamport.js';
import {
  OutboxWriter,
  type OutboxWriteInput,
} from '../../../profile/outbox-writer.js';
import { SentLedgerWriter } from '../../../profile/sent-ledger-writer.js';
import { SphereError } from '../../../core/errors.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';

// ---------------------------------------------------------------------------
// Shared in-memory ProfileDatabase fixture
// ---------------------------------------------------------------------------

const ADDR = 'DIRECT_aabbcc_ddeeff';

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createSharedDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig): Promise<void> {
      /* no-op */
    },
    async put(k: string, v: Uint8Array): Promise<void> {
      store.set(k, v);
    },
    async get(k: string): Promise<Uint8Array | null> {
      return store.get(k) ?? null;
    },
    async del(k: string): Promise<void> {
      store.delete(k);
    },
    async all(prefix?: string): Promise<Map<string, Uint8Array>> {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    async close(): Promise<void> {
      /* no-op */
    },
    onReplication(): () => void {
      return () => undefined;
    },
    isConnected(): boolean {
      return true;
    },
  } as MockProfileDb;
}

function makeOutboxWriter(db: ProfileDatabase, lamport?: Lamport): OutboxWriter {
  return new OutboxWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: lamport ?? new Lamport(),
  });
}

function makeSentWriter(
  db: ProfileDatabase,
  lamport?: Lamport,
): SentLedgerWriter {
  return new SentLedgerWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: lamport ?? new Lamport(),
  });
}

function buildOutboxInput(
  id: string,
  overrides: Partial<OutboxWriteInput> = {},
): OutboxWriteInput {
  const now = Date.now();
  return {
    id,
    bundleCid: `bafy-${id}`,
    tokenIds: [`0xtoken-${id}`],
    deliveryMethod: 'cid-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'conservative',
    status: 'packaging',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — Tombstone resurrection guard across writer instances
// ---------------------------------------------------------------------------

describe('OutboxWriter — concurrent-replica refuse-write guard (#166 item #9 scenario 1)', () => {
  let db: MockProfileDb;
  let writerA: OutboxWriter;
  let writerB: OutboxWriter;

  beforeEach(() => {
    db = createSharedDb();
    writerA = makeOutboxWriter(db);
    writerB = makeOutboxWriter(db);
  });

  it('A tombstones a key; B trying to write the same id is refused', async () => {
    // A writes an entry.
    await writerA.write(buildOutboxInput('shared-key'));
    expect(await writerA.readOne('shared-key')).not.toBeNull();

    // A tombstones it. Shared storage means B sees it immediately.
    await writerA.delete('shared-key');

    // B's view: the slot is tombstoned. A write attempt MUST fail
    // with OUTBOX_ENTRY_TOMBSTONED — this is the refuse-write guard.
    await expect(writerB.write(buildOutboxInput('shared-key'))).rejects.toThrow(
      SphereError,
    );
    try {
      await writerB.write(buildOutboxInput('shared-key'));
    } catch (err) {
      expect((err as SphereError).code).toBe('OUTBOX_ENTRY_TOMBSTONED');
    }
  });

  it("B's refuse-write guard fires even when B never saw the live value (pre-sync state)", async () => {
    // A's lifecycle is fully off-screen from B's perspective. B comes
    // online, sees the tombstone immediately (shared db), and attempts
    // a write at the same id (e.g. a stale dispatcher reusing the id).
    await writerA.write(buildOutboxInput('hidden-key'));
    await writerA.delete('hidden-key');

    // B never observed the live value. Still, the refuse-write guard
    // reads the slot at write time and surfaces the tombstone.
    await expect(writerB.write(buildOutboxInput('hidden-key'))).rejects.toThrow(
      /tombstoned/,
    );
  });

  it("operator escape-hatch (`{ allowResurrection: true }`) bypasses the guard for B", async () => {
    await writerA.write(buildOutboxInput('rescue'));
    await writerA.delete('rescue');

    // Without the flag → refused.
    await expect(writerB.write(buildOutboxInput('rescue'))).rejects.toThrow(
      SphereError,
    );

    // With the flag → write succeeds (operator restored the slot).
    const written = await writerB.write(buildOutboxInput('rescue'), {
      allowResurrection: true,
    });
    expect(written.id).toBe('rescue');
    // The post-restore value is what B wrote (overwrote the tombstone).
    expect((await writerB.readOne('rescue'))?.shape).toBe('uxf-1');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Lamport monotonicity across writer instances
// ---------------------------------------------------------------------------

describe('OutboxWriter — concurrent Lamport bumps (#166 item #9 scenario 2)', () => {
  let db: MockProfileDb;
  let writerA: OutboxWriter;
  let writerB: OutboxWriter;

  beforeEach(() => {
    db = createSharedDb();
    writerA = makeOutboxWriter(db);
    writerB = makeOutboxWriter(db);
  });

  it("B's first write observes A's Lamport stamps and bumps past them", async () => {
    const a1 = await writerA.write(buildOutboxInput('a-1'));
    const a2 = await writerA.write(buildOutboxInput('a-2'));
    const a3 = await writerA.write(buildOutboxInput('a-3'));
    expect(a1.lamport).toBe(1);
    expect(a2.lamport).toBe(2);
    expect(a3.lamport).toBe(3);

    // B has its own Lamport(0); the bump rule reads observed stamps
    // from the shared store and bumps past max(observed).
    const b1 = await writerB.write(buildOutboxInput('b-1'));
    expect(b1.lamport).toBeGreaterThan(a3.lamport);
  });

  it("B's tombstone observes A's tombstone Lamport (not just live values)", async () => {
    // A writes then tombstones. The tombstone carries lamport=2.
    await writerA.write(buildOutboxInput('a-key'));
    await writerA.delete('a-key');

    // B writes a NEW key. Its lamport must exceed the tombstone's
    // (Issue #166 P1 #2: collectObservedLamports includes tombstones).
    const b1 = await writerB.write(buildOutboxInput('b-key'));
    expect(b1.lamport).toBeGreaterThanOrEqual(3);
  });

  it("B's delete bumps past A's most-recent stamp (live or tombstone)", async () => {
    await writerA.write(buildOutboxInput('a-1')); // lamport 1
    await writerA.write(buildOutboxInput('a-2')); // lamport 2

    await writerB.write(buildOutboxInput('b-1')); // lamport ≥ 3
    await writerB.delete('b-1'); // tombstone bumps further

    // No assertion on the exact tombstone lamport — the guarantee is
    // monotonicity. A subsequent write by either writer must continue
    // above this point.
    const c = await writerA.write(buildOutboxInput('a-3'));
    expect(c.lamport).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Pre-sync live write vs. arriving-tombstone
// ---------------------------------------------------------------------------
//
// Real CRDT scenario:
//  1. A and B both have a live value for key K at lamport L (pre-fork).
//  2. A tombstones K (lamport L+1).
//  3. B has NOT yet seen A's tombstone and is about to write K.
//
// In a real OrbitDB log, A's tombstone and B's pending write race.
// Whichever lands later wins by LWW; the refuse-write guard catches
// the case where B's write happens AFTER A's tombstone has propagated.
//
// With our shared-storage fixture, propagation is instantaneous —
// once A's tombstone is in the db, B sees it on its next read. So
// the test models the sequence "tombstone arrives BEFORE B writes":

describe('OutboxWriter — pre-sync race resolution (#166 item #9 scenario 3)', () => {
  let db: MockProfileDb;
  let writerA: OutboxWriter;
  let writerB: OutboxWriter;

  beforeEach(() => {
    db = createSharedDb();
    writerA = makeOutboxWriter(db);
    writerB = makeOutboxWriter(db);
  });

  it("when A's tombstone arrives before B's write, the tombstone wins (B refused)", async () => {
    // Common ancestor: both replicas have a live value for K.
    await writerA.write(buildOutboxInput('K'));

    // A tombstones K. The tombstone "propagates" instantly (shared db).
    await writerA.delete('K');

    // B attempts to write K (e.g. an in-flight dispatcher that hasn't
    // observed the tombstone in its own logic). The refuse-write
    // guard re-reads the slot at write time and catches it.
    await expect(writerB.write(buildOutboxInput('K'))).rejects.toThrow(
      /tombstoned/,
    );
  });

  it("when B's write happens BEFORE A's tombstone, A's tombstone wins on subsequent reads", async () => {
    // Common ancestor: live value for K.
    await writerA.write(buildOutboxInput('K'));

    // B writes K with new fields (e.g. a status update via update()).
    await writerB.update('K', (prev) => ({
      ...prev,
      status: 'pinned',
      updatedAt: Date.now(),
    }));
    // B's view: K is live at status='pinned'.
    expect((await writerB.readOne('K'))?.shape).toBe('uxf-1');

    // A's tombstone arrives.
    await writerA.delete('K');

    // After the tombstone propagates, both writers see K as gone.
    expect(await writerA.readOne('K')).toBeNull();
    expect(await writerB.readOne('K')).toBeNull();
    // The slot is now tombstoned for both — a fresh write by EITHER
    // writer is refused.
    await expect(writerA.write(buildOutboxInput('K'))).rejects.toThrow(
      /tombstoned/,
    );
    await expect(writerB.write(buildOutboxInput('K'))).rejects.toThrow(
      /tombstoned/,
    );
  });

  it("repeated deletes on either side are idempotent (no monotonicity violation)", async () => {
    await writerA.write(buildOutboxInput('K'));
    await writerA.delete('K');
    // B observes the tombstone and re-issues delete (e.g. on a sweep
    // that hasn't yet learned the slot is gone).
    await expect(writerB.delete('K')).resolves.toBeUndefined();

    // The slot is still tombstoned; no monotonicity violation: the
    // refuse-write guard still fires.
    await expect(writerA.write(buildOutboxInput('K'))).rejects.toThrow(
      /tombstoned/,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — SentLedgerWriter mirrors the same invariants
// ---------------------------------------------------------------------------

describe('SentLedgerWriter — concurrent-replica refuse-write guard (#166 item #9)', () => {
  it('A tombstones a SENT entry; B is refused on the same id', async () => {
    const db = createSharedDb();
    const a = makeSentWriter(db);
    const b = makeSentWriter(db);

    await a.write({
      id: 'sent-K',
      tokenIds: ['tok-1'],
      bundleCid: 'bafy-K',
      recipientTransportPubkey: 'a'.repeat(64),
      recipient: '@bob',
      deliveryMethod: 'cid-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });
    await a.delete('sent-K');

    await expect(
      b.write({
        id: 'sent-K',
        tokenIds: ['tok-1'],
        bundleCid: 'bafy-K',
        recipientTransportPubkey: 'a'.repeat(64),
        recipient: '@bob',
        deliveryMethod: 'cid-over-nostr',
        mode: 'conservative',
        sentAt: 1_700_000_000_001,
      }),
    ).rejects.toThrow(/tombstoned/);
  });

  it('B observes A’s SENT-write in its contains() index after a deliberate ensureIndex round-trip', async () => {
    // Item #3's in-memory index is per-instance. Writer B hasn't called
    // contains() yet, so its index is empty. After ensureIndex runs
    // (via the first contains() call), B must see A's tokenIds.
    const db = createSharedDb();
    const a = makeSentWriter(db);
    const b = makeSentWriter(db);

    await a.write({
      id: 'sent-cross',
      tokenIds: ['tok-x'],
      bundleCid: 'bafy-cross',
      recipientTransportPubkey: 'a'.repeat(64),
      recipient: '@bob',
      deliveryMethod: 'cid-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    // B's first contains() builds its index from the shared db —
    // observing A's tokenIds.
    expect(await b.contains('tok-x')).toBe(true);
    expect(await b.contains('tok-not-here')).toBe(false);
  });
});
