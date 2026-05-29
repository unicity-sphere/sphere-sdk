/**
 * Full-profile-sync integration tests — Item #15 Phase G.
 *
 * **Layering context**:
 *
 * Phase G validates the END-TO-END convergence story for the lean-profile-
 * snapshot sync architecture. Each test sets up two peers (A, B) that share
 * a wallet identity (same OUTBOX/SENT key prefix → same `addressId`) but
 * independent local OrbitDB stores. Cross-peer convergence rides through:
 *
 *   1. A peer "publishes" its current state — calls
 *      {@link buildLeanProfileSnapshot} on its in-memory storage adapter,
 *      yielding a CAR root CID that simulates the aggregator-pointer
 *      anchor.
 *   2. The receiving peer "polls" — fetches the CAR bytes (already in hand
 *      via the test fixture; no real IPFS), runs
 *      {@link parseLeanProfileSnapshot}, then dispatches per-writer JOINs
 *      via {@link runProfileSnapshotJoin}.
 *   3. The receiver inspects its post-JOIN local OUTBOX/SENT state. If
 *      `joinedAny`, the receiver would mark profile dirty and re-publish
 *      the union (Phase D dirty-flush wiring); the test asserts the
 *      observable end state rather than the wiring re-publish itself
 *      (that's covered by `factory-dirty-flush.test.ts`).
 *
 * **Why integration (not unit)**: per-writer tests in
 * `outbox-writer-snapshot-join.test.ts` and dispatcher tests in
 * `profile-snapshot-dispatcher.test.ts` cover their layers in isolation.
 * Phase G stitches the layers together — snapshot builder produces the
 * CAR, parser decodes it, dispatcher routes by addressId, per-writer
 * `joinSnapshot()` applies the merge. A bug at any layer surfaces here.
 *
 * **What this file COVERS** (per the Phase G acceptance criteria in
 * `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #15):
 *
 *  - G.1 Two-peer JOIN: A writes OUTBOX entry, snapshots, publishes; B
 *    polls + JOINs, observes A's entry with A's Lamport intact.
 *  - G.2 Tombstone-wins-at-JOIN: A tombstones K at Lamport L_t; B has
 *    a live entry at K with Lamport L_h < L_t; JOIN keeps tombstone.
 *  - G.3 Concurrent flush race: A and B both publish V+1; aggregator
 *    anchors A; B re-polls + JOINs A's snapshot + re-publishes V+2 as
 *    the union of both states.
 *  - G.4 Crash-recovery: A writes OUTBOX entry then "crashes" immediately
 *    after publish; B (same wallet identity) detects the new pointer
 *    version, pulls, JOINs, observes A's entry — `SendingRecoveryWorker`
 *    could then pick it up on B.
 *  - G.5 Non-overlapping union: A and B both have OUTBOX entries
 *    at different keys; after bidirectional JOIN both sides see the
 *    full union.
 *
 * **What this file DOES NOT cover**:
 *
 *  - Real aggregator-pointer publish/poll integration. The pointer layer's
 *    publish-retry / version-monotonicity / cursor-advance semantics are
 *    covered by `lifecycle-manager-publish-retry.test.ts` and
 *    `lifecycle-manager-pointer-poll.test.ts`. Phase G simulates pointer
 *    anchoring by directly handing CAR bytes to the receiver — both peers
 *    trust the bytes; no SMT mock is needed.
 *  - Real IPFS pin/fetch. The CAR bytes never leave the test process; the
 *    pin layer's content-address verification is covered by
 *    `ipfs-client-cid-verify.test.ts`.
 *  - SENT-writer convergence under tombstone. The writer surface is
 *    structurally identical to OUTBOX; the OUTBOX scenarios prove the
 *    JOIN semantics that SENT inherits. One smoke-test scenario exercises
 *    SENT end-to-end to confirm prefix routing.
 *  - BundleIndex convergence. BundleIndex requires a full
 *    `ProfileTokenStorageHost`, which is constructed by `factory.ts` at
 *    runtime; spinning that up here would duplicate the fixture work in
 *    `bundle-index-snapshot-join.test.ts` without adding integration
 *    signal beyond what the dispatcher's bundle-routing already covers.
 *
 * The integration tests below assume the per-writer JOIN cells already
 * behave correctly (proven in the unit tests). A regression at this
 * layer would surface as either a routing miss (entries reach the wrong
 * writer) or a serialization mismatch (CAR encode/decode loses Lamports
 * or ciphertext fidelity).
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { Lamport } from '../../../profile/lamport.js';
import {
  OutboxWriter,
  type OutboxWriteInput,
} from '../../../profile/outbox-writer.js';
import {
  SentLedgerWriter,
} from '../../../profile/sent-ledger-writer.js';
import {
  buildLeanProfileSnapshot,
  parseLeanProfileSnapshot,
  type LeanProfileSnapshot,
} from '../../../profile/profile-lean-snapshot.js';
import {
  runProfileSnapshotJoin,
  type SnapshotJoinWriterEntry,
} from '../../../profile/profile-snapshot-dispatcher.js';
import type { ProfileSyncWriter } from '../../../profile/profile-snapshot-merge.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
  UxfBundleRef,
} from '../../../profile/types.js';
import type { StorageProvider } from '../../../storage/storage-provider.js';
import type {
  ProviderStatus,
  TrackedAddressEntry,
  FullIdentity,
} from '../../../types/index.js';
import type { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider.js';

// =============================================================================
// Fixtures
// =============================================================================

/**
 * Same `addressId` on both peers — this is the wallet identity contract.
 * Cross-device sync means the two peers run the SAME wallet (same
 * mnemonic → same chainPubkey → same `getAddressId(chainPubkey)` →
 * same OUTBOX/SENT key prefix). A test that uses different addressIds on
 * the two peers would be modelling two different wallets, not the
 * cross-device scenario Phase G covers.
 */
const ADDR = 'DIRECT_aabbcc_ddeeff';
const OUTBOX_PREFIX = `${ADDR}.outbox.`;
const SENT_PREFIX = `${ADDR}.sent.`;

const TEST_CHAIN_PUBKEY = '02' + 'cc'.repeat(32);

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig): Promise<void> {},
    async put(k: string, v: Uint8Array): Promise<void> {
      // Defensive copy so the writer's view isn't aliased to test code.
      store.set(k, new Uint8Array(v));
    },
    async get(k: string): Promise<Uint8Array | null> {
      const v = store.get(k);
      return v ? new Uint8Array(v) : null;
    },
    async del(k: string): Promise<void> {
      store.delete(k);
    },
    async all(prefix?: string): Promise<Map<string, Uint8Array>> {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out.set(k, new Uint8Array(v));
      }
      return out;
    },
    async close(): Promise<void> {},
    onReplication(): () => void {
      return () => undefined;
    },
    isConnected(): boolean {
      return true;
    },
  } as MockProfileDb;
}

/**
 * A peer = a {@link MockProfileDb} + per-writer instances bound to it.
 * Each peer owns its own Lamport clock so the §7.1 monotonic invariant is
 * tested cross-peer (the JOIN must preserve remote Lamports verbatim).
 */
interface Peer {
  readonly db: MockProfileDb;
  readonly outbox: OutboxWriter;
  readonly sent: SentLedgerWriter;
  readonly storage: WrappedStorage;
  readonly tokenStorage: FakeTokenStorage;
}

function createPeer(): Peer {
  const db = createMockDb();
  const outbox = new OutboxWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: new Lamport(),
  });
  const sent = new SentLedgerWriter({
    db,
    encryptionKey: null,
    addressId: ADDR,
    lamport: new Lamport(),
  });
  const storage = new WrappedStorage(db);
  const tokenStorage = new FakeTokenStorage();
  return { db, outbox, sent, storage, tokenStorage };
}

/**
 * StorageProvider adapter over a {@link MockProfileDb}. The lean-snapshot
 * builder reads via `storage.keys()` + `storage.getEncryptedRaw(key)`;
 * this adapter routes both through the underlying KV. `getEncryptedRaw`
 * returns base64-encoded raw bytes — the same encoding the dispatcher
 * decodes via `base64ToBytes()`.
 *
 * Only the surface that `buildLeanProfileSnapshot` actually consumes is
 * implemented. The rest of the StorageProvider interface throws so a
 * future refactor that starts using more surface area fails loudly
 * instead of silently degrading.
 */
class WrappedStorage implements StorageProvider {
  readonly id = 'wrapped';
  readonly name = 'WrappedMockProfileDb';
  readonly type = 'local' as const;
  private status: ProviderStatus = 'connected';

  constructor(private readonly db: MockProfileDb) {}

  async connect(): Promise<void> {
    this.status = 'connected';
  }
  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }
  isConnected(): boolean {
    return this.status === 'connected';
  }
  getStatus(): ProviderStatus {
    return this.status;
  }
  setIdentity(_: FullIdentity): void {}

  async get(_key: string): Promise<string | null> {
    throw new Error('WrappedStorage.get not used by Phase G');
  }
  async set(_key: string, _value: string): Promise<void> {
    throw new Error('WrappedStorage.set not used by Phase G');
  }
  async remove(_key: string): Promise<void> {
    throw new Error('WrappedStorage.remove not used by Phase G');
  }
  async has(_key: string): Promise<boolean> {
    throw new Error('WrappedStorage.has not used by Phase G');
  }

  async keys(prefix?: string): Promise<string[]> {
    const all = await this.db.all();
    const out: string[] = [];
    for (const k of all.keys()) {
      if (!prefix || k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  async clear(_prefix?: string): Promise<void> {
    throw new Error('WrappedStorage.clear not used by Phase G');
  }

  async saveTrackedAddresses(_: TrackedAddressEntry[]): Promise<void> {}
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    return [];
  }

  /**
   * Lean snapshot ciphertext channel. The OUTBOX/SENT writers store raw
   * bytes via `db.put`; here we surface them as base64 strings so the
   * builder can embed them in the CAR. The dispatcher decodes via
   * `base64ToBytes()` on the receiving side, yielding the same raw bytes
   * the writer originally wrote.
   */
  async getEncryptedRaw(key: string): Promise<string | null> {
    const raw = await this.db.get(key);
    if (raw === null) return null;
    return Buffer.from(raw).toString('base64');
  }
}

/**
 * Minimal token-storage stub. Phase G focuses on per-address writers
 * (OUTBOX, SENT); the bundle index has its own dedicated test surface
 * (`bundle-index-snapshot-join.test.ts`). An empty bundle map keeps the
 * CAR small and the assertion targets focused.
 */
class FakeTokenStorage {
  async listBundles(): Promise<Map<string, UxfBundleRef>> {
    return new Map();
  }
}

function buildOutboxInput(
  id: string,
  overrides: Partial<OutboxWriteInput> = {},
): OutboxWriteInput {
  const now = 1_700_000_000_000;
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

// =============================================================================
// Sync helpers — publish (build snapshot) + pullAndApply (parse + dispatch)
// =============================================================================

/**
 * "Publish": A peer flushes its current state to a lean-snapshot CAR. In
 * production this CID is anchored on the aggregator pointer and the CAR
 * is pinned on IPFS; here we just return the bytes. The receiver gets
 * them as opaque input to `parseLeanProfileSnapshot()`.
 */
async function publish(peer: Peer): Promise<{
  readonly carBytes: Uint8Array;
  readonly rootCid: string;
  readonly entryCount: number;
}> {
  const result = await buildLeanProfileSnapshot({
    storage: peer.storage,
    tokenStorage: peer.tokenStorage as unknown as ProfileTokenStorageProvider,
    chainPubkey: TEST_CHAIN_PUBKEY,
    network: 'testnet',
    // Fixed createdAt so two publishes of the same state produce
    // byte-identical CARs in the determinism assertions.
    createdAt: 1_700_000_000_000,
  });
  return {
    carBytes: result.carBytes,
    rootCid: result.rootCid,
    entryCount: result.entryCount,
  };
}

/**
 * Build the per-address writer set for the receiving peer. This is the
 * same wiring `factory.ts:createProfileProviders` builds in production —
 * see `runProfileSnapshotApply`. For Phase G we wire only the OUTBOX +
 * SENT prefixes; bundle/finalization/recipient context writers live
 * elsewhere and are covered by their own tests.
 */
function writersForPeer(peer: Peer): (addressId: string) => ReadonlyArray<SnapshotJoinWriterEntry> {
  return (addressId: string): ReadonlyArray<SnapshotJoinWriterEntry> => {
    if (addressId !== ADDR) return [];
    return [
      { keyPrefix: OUTBOX_PREFIX, writer: peer.outbox as ProfileSyncWriter },
      { keyPrefix: SENT_PREFIX, writer: peer.sent as ProfileSyncWriter },
    ];
  };
}

/**
 * "Pull and apply": receiving peer parses the CAR, dispatches per-writer
 * JOINs. Mirrors `runProfileSnapshotApply` in `factory.ts` but specialised
 * for the Phase G fixture (no BundleIndex). Returns the dispatcher's
 * aggregated counters so tests can assert convergence shape.
 */
async function pullAndApply(receiver: Peer, carBytes: Uint8Array): Promise<{
  readonly joinedAny: boolean;
  readonly addressesSeen: number;
  readonly liveLanded: number;
  readonly tombstonesLanded: number;
  readonly localWon: number;
  readonly snapshot: LeanProfileSnapshot;
}> {
  const snapshot = await parseLeanProfileSnapshot(carBytes);
  const result = await runProfileSnapshotJoin(snapshot, {
    writersFor: writersForPeer(receiver),
    bundleIndex: null,
  });
  return {
    joinedAny: result.joinedAny,
    addressesSeen: result.addressesSeen,
    liveLanded: result.counters.liveLanded,
    tombstonesLanded: result.counters.tombstonesLanded,
    localWon: result.counters.localWon,
    snapshot,
  };
}

// =============================================================================
// G.1 — Two-peer JOIN basic propagation
// =============================================================================

describe('Phase G.1 — Two-peer JOIN basic propagation', () => {
  let A: Peer;
  let B: Peer;

  beforeEach(() => {
    A = createPeer();
    B = createPeer();
  });

  it("A writes OUTBOX entry, publishes; B polls + JOINs, observes A's entry with A's Lamport", async () => {
    // A: write one OUTBOX entry, then publish.
    const aEntry = await A.outbox.write(buildOutboxInput('e1'));
    expect(aEntry.lamport).toBe(1);

    const published = await publish(A);
    // Sanity: the lean snapshot picked up the OUTBOX entry as one KV row.
    expect(published.entryCount).toBe(1);

    // B: pull + apply. B's local OUTBOX was empty → remote lands.
    const result = await pullAndApply(B, published.carBytes);
    expect(result.joinedAny).toBe(true);
    expect(result.addressesSeen).toBe(1);
    expect(result.liveLanded).toBe(1);
    expect(result.tombstonesLanded).toBe(0);
    expect(result.localWon).toBe(0);

    // B's local OUTBOX now contains A's entry verbatim, including A's
    // Lamport. The JOIN does NOT re-bump on landing remote bytes — this
    // is the invariant the spec calls out in
    // `OutboxWriter.joinSnapshot`'s "Lamport bumping is intentionally
    // bypassed" doc-comment.
    const bRead = await B.outbox.readOne('e1');
    expect(bRead?.shape).toBe('uxf-1');
    if (bRead?.shape === 'uxf-1') {
      expect(bRead.entry.lamport).toBe(1);
      expect(bRead.entry.id).toBe('e1');
      expect(bRead.entry.status).toBe('packaging');
      expect(bRead.entry.recipientTransportPubkey).toBe('a'.repeat(64));
    }
  });

  it('round-trips a SENT entry through the same pipeline (prefix routing smoke test)', async () => {
    // SENT writers inherit the OUTBOX writer's JOIN semantics; one
    // scenario here confirms the dispatcher routes ${addr}.sent.* to
    // SentLedgerWriter rather than OutboxWriter.
    await A.sent.write({
      id: 's1',
      tokenIds: ['0xtoken-s1'],
      bundleCid: 'bafy-s1',
      recipientTransportPubkey: 'a'.repeat(64),
      recipient: '@bob',
      deliveryMethod: 'cid-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    const published = await publish(A);
    expect(published.entryCount).toBe(1);

    const result = await pullAndApply(B, published.carBytes);
    expect(result.liveLanded).toBe(1);

    // B observes A's SENT entry — same id, tokenIds, bundleCid.
    // `SentLedgerWriter.readOne` returns the entry directly (not a
    // ClassifiedSlot union), so we check the entry's `_schemaVersion`
    // discriminator to confirm it round-tripped through JOIN intact.
    const bSent = await B.sent.readOne('s1');
    expect(bSent).not.toBeNull();
    expect(bSent?._schemaVersion).toBe('uxf-1');
    expect(bSent?.id).toBe('s1');
    expect(bSent?.tokenIds).toEqual(['0xtoken-s1']);
    expect(bSent?.bundleCid).toBe('bafy-s1');
    // OUTBOX must NOT see the SENT entry (prefix routing).
    expect(await B.outbox.readOne('s1')).toBeNull();
  });

  it('idempotent: re-pulling the same snapshot is a no-op on the second pass', async () => {
    await A.outbox.write(buildOutboxInput('e1'));
    const published = await publish(A);

    const r1 = await pullAndApply(B, published.carBytes);
    expect(r1.liveLanded).toBe(1);

    const r2 = await pullAndApply(B, published.carBytes);
    expect(r2.liveLanded).toBe(0);
    expect(r2.localWon).toBe(1);
    expect(r2.joinedAny).toBe(false);
  });
});

// =============================================================================
// G.2 — Tombstone-wins-at-JOIN
// =============================================================================

describe('Phase G.2 — Tombstone-wins-at-JOIN', () => {
  let A: Peer;
  let B: Peer;

  beforeEach(() => {
    A = createPeer();
    B = createPeer();
  });

  it("A tombstones K at Lamport L_t; B has live K at L_h < L_t; JOIN preserves tombstone on B", async () => {
    // Common ancestor: both peers have a live entry at K with lamport=1.
    await A.outbox.write(buildOutboxInput('K'));
    await B.outbox.write(buildOutboxInput('K'));

    // A advances local clock then tombstones at lamport=3.
    await A.outbox.update('K', (e) => ({ ...e, status: 'sending' })); // lamport=2
    await A.outbox.delete('K'); // tombstone at lamport=3

    // Sanity: B's live K is still at lamport=1, A's tombstone at 3.
    const bBefore = await B.outbox.readOne('K');
    if (bBefore?.shape === 'uxf-1') expect(bBefore.entry.lamport).toBe(1);

    // A publishes; B pulls.
    const published = await publish(A);
    const result = await pullAndApply(B, published.carBytes);

    // The tombstone (lamport=3) wins over B's live entry (lamport=1) per
    // the merge table's "live + tombstone (tomb.lamport >= live.lamport)
    // → tombstone wins" row. The receive-side observable is "K is gone".
    expect(result.tombstonesLanded).toBe(1);
    expect(result.liveLanded).toBe(0);
    expect(await B.outbox.readOne('K')).toBeNull();
  });

  it("A tombstones K at low Lamport; B has live K at higher Lamport; JOIN keeps B's live", async () => {
    // Common ancestor.
    await A.outbox.write(buildOutboxInput('K'));
    await B.outbox.write(buildOutboxInput('K'));

    // A immediately tombstones at lamport=2 (write was lamport=1).
    await A.outbox.delete('K'); // tombstone at lamport=2

    // B advances local K well past A's tombstone Lamport.
    await B.outbox.update('K', (e) => ({ ...e, status: 'sending' })); // 2
    await B.outbox.update('K', (e) => ({ ...e, status: 'sending' })); // 3
    await B.outbox.update('K', (e) => ({ ...e, status: 'sending' })); // 4

    // A publishes; B pulls.
    const published = await publish(A);
    const result = await pullAndApply(B, published.carBytes);

    // Live (lamport=4) wins over tombstone (lamport=2). B's K stays live.
    expect(result.tombstonesLanded).toBe(0);
    expect(result.liveLanded).toBe(0);
    expect(result.localWon).toBe(1);
    const after = await B.outbox.readOne('K');
    expect(after?.shape).toBe('uxf-1');
    if (after?.shape === 'uxf-1') {
      expect(after.entry.status).toBe('sending');
      expect(after.entry.lamport).toBe(4);
    }
  });

  it("tombstone-sticky at Lamport tie: tomb.lamport == live.lamport → tombstone wins (refuse-write guard symmetry)", async () => {
    // Pre-sync race: both peers start cold and write the same id at
    // lamport=1; A immediately tombstones at lamport=2; B updates to
    // status='sending' at lamport=2. After A publishes, B pulls.
    await A.outbox.write(buildOutboxInput('K')); // lamport=1
    await B.outbox.write(buildOutboxInput('K')); // lamport=1

    await A.outbox.delete('K'); // tombstone at lamport=2
    await B.outbox.update('K', (e) => ({ ...e, status: 'sending' })); // live lamport=2

    const published = await publish(A);
    const result = await pullAndApply(B, published.carBytes);

    // Tombstone wins at tie — this is the refuse-write guard projected
    // onto JOIN per `OutboxWriter.joinSnapshot`'s merge table.
    expect(result.tombstonesLanded).toBe(1);
    expect(await B.outbox.readOne('K')).toBeNull();
  });
});

// =============================================================================
// G.3 — Concurrent flush race + JOIN convergence
// =============================================================================

describe('Phase G.3 — Concurrent flush race + JOIN convergence', () => {
  let A: Peer;
  let B: Peer;

  beforeEach(() => {
    A = createPeer();
    B = createPeer();
  });

  it("A and B both publish V+1; aggregator anchors A; B re-polls + JOINs + re-publishes V+2 as union", async () => {
    // V (shared prior state): both peers know about entry 'shared' at
    // lamport=1. We model this by writing on A then propagating to B.
    await A.outbox.write(buildOutboxInput('shared'));
    {
      const v = await publish(A);
      await pullAndApply(B, v.carBytes);
    }
    // Sanity: both peers see 'shared' at lamport=1.
    {
      const a = await A.outbox.readOne('shared');
      const b = await B.outbox.readOne('shared');
      if (a?.shape === 'uxf-1') expect(a.entry.lamport).toBe(1);
      if (b?.shape === 'uxf-1') expect(b.entry.lamport).toBe(1);
    }

    // V+1 race: both peers mutate independently and try to publish.
    await A.outbox.write(buildOutboxInput('a-only')); // A: new entry
    await B.outbox.write(buildOutboxInput('b-only')); // B: new entry

    const publishA = await publish(A);
    // B also builds its own snapshot for V+1 (in production, would also
    // attempt to anchor at the same version). The aggregator only
    // anchors ONE per pointer version; we drop B's CAR bytes to model
    // the loss-of-race outcome — the producer-side work still happened,
    // but the resulting CID is never anchored, so no other peer ever
    // sees it.
    await publish(B);

    // Suppose A's anchor wins for V+1. B then polls the new V+1 pointer
    // and sees A's snapshot.
    const r1 = await pullAndApply(B, publishA.carBytes);
    expect(r1.joinedAny).toBe(true);
    // B observed A's 'a-only' entry; B's local 'b-only' is preserved.
    expect(await B.outbox.readOne('a-only')).not.toBeNull();
    expect(await B.outbox.readOne('b-only')).not.toBeNull();

    // B re-publishes V+2 as the union of (V+1 from A) + (B's local
    // additions). The aggregator anchors it — A polls and converges.
    const publishB2 = await publish(B);
    // The union snapshot has 3 OUTBOX entries: 'shared', 'a-only',
    // 'b-only'. (B's 'shared' is at the same Lamport=1, no divergence.)
    {
      // Count OUTBOX-prefixed entries in the snapshot.
      const parsed = await parseLeanProfileSnapshot(publishB2.carBytes);
      const outboxKeys = parsed.entries
        .map((e) => e.key)
        .filter((k) => k.startsWith(OUTBOX_PREFIX));
      expect(outboxKeys.sort()).toEqual([
        `${OUTBOX_PREFIX}a-only`,
        `${OUTBOX_PREFIX}b-only`,
        `${OUTBOX_PREFIX}shared`,
      ]);
    }

    // A pulls V+2 and sees the union too.
    const r2 = await pullAndApply(A, publishB2.carBytes);
    expect(r2.liveLanded).toBe(1); // only 'b-only' is new for A
    expect(await A.outbox.readOne('a-only')).not.toBeNull();
    expect(await A.outbox.readOne('b-only')).not.toBeNull();
    expect(await A.outbox.readOne('shared')).not.toBeNull();
  });

  it('convergence is bounded: bidirectional re-pulls fix-point in one round', async () => {
    // After the convergence round, a follow-up bidirectional pull
    // produces no further state changes. This is the "JOIN is idempotent
    // when both sides have already merged" invariant from
    // `runJoinSnapshot`'s loop docstring.
    await A.outbox.write(buildOutboxInput('e1'));
    await B.outbox.write(buildOutboxInput('e2'));

    // Round 1: A → B
    const p1 = await publish(A);
    await pullAndApply(B, p1.carBytes);
    // Round 2: B → A (with B's union state)
    const p2 = await publish(B);
    await pullAndApply(A, p2.carBytes);

    // Fix-point check: any further pulls in either direction land
    // nothing new (liveLanded=0, no tombstones).
    const p3 = await publish(A);
    const r3 = await pullAndApply(B, p3.carBytes);
    expect(r3.liveLanded).toBe(0);
    expect(r3.tombstonesLanded).toBe(0);
    expect(r3.joinedAny).toBe(false);

    const p4 = await publish(B);
    const r4 = await pullAndApply(A, p4.carBytes);
    expect(r4.liveLanded).toBe(0);
    expect(r4.tombstonesLanded).toBe(0);
    expect(r4.joinedAny).toBe(false);
  });
});

// =============================================================================
// G.4 — Crash-recovery cross-device
// =============================================================================

describe('Phase G.4 — Crash-recovery cross-device', () => {
  let A: Peer;
  let B: Peer;

  beforeEach(() => {
    A = createPeer();
    B = createPeer();
  });

  it("A writes OUTBOX entry then 'crashes' after publish; B (same wallet) pulls + JOINs + sees the entry", async () => {
    // A: write entry, publish, then "crash" — we simulate the crash by
    // not invoking any further A-side methods. The point is that A's
    // local OrbitDB has persisted the entry AND the aggregator pointer
    // anchored the published CAR before A went away.
    await A.outbox.write(buildOutboxInput('orphan', { status: 'sending' }));
    const published = await publish(A);

    // (Crash simulated — no more A-side work happens.)

    // B (same wallet identity, different device) detects a new pointer
    // version and pulls. The crash-safety contract is: B can resume
    // any in-flight send A was working on because the OUTBOX entry is
    // signed against the same wallet key.
    const result = await pullAndApply(B, published.carBytes);
    expect(result.joinedAny).toBe(true);
    expect(result.liveLanded).toBe(1);

    const bView = await B.outbox.readOne('orphan');
    expect(bView?.shape).toBe('uxf-1');
    if (bView?.shape === 'uxf-1') {
      // Status preserved — this is the load-bearing fact for
      // SendingRecoveryWorker pickup: it knows the entry was at
      // 'sending' when A crashed, so it picks up exactly the work
      // A was doing.
      expect(bView.entry.status).toBe('sending');
      expect(bView.entry.lamport).toBe(1);
      // The bundleCid and tokenIds are visible — the recovery worker
      // uses these to re-attempt delivery or to surface the in-flight
      // state to the user.
      expect(bView.entry.bundleCid).toBe('bafy-orphan');
      expect(bView.entry.tokenIds).toEqual(['0xtoken-orphan']);
    }
  });

  it("A's crash mid-state-machine: 'finalizing' status survives the JOIN with sticky everFinalizing", async () => {
    // The OUTBOX entry's `everFinalizing` flag is sticky (set-OR
    // persistence per the writer spec). When the status reaches
    // 'finalizing', the flag is set. After a crash + cross-device JOIN,
    // the receiving peer must see both `status: 'finalizing'` AND
    // `everFinalizing: true` so the CRDT merger's override semantics
    // remain available.
    // The canonical path to 'finalizing' is
    //   packaging → sending → delivered-instant → finalizing
    // per the §7.0 state-machine table in
    // `profile/outbox-state-machine.ts`. Four writes → lamport=4 on A.
    await A.outbox.write(buildOutboxInput('mid'));
    await A.outbox.update('mid', (e) => ({ ...e, status: 'sending' }));
    await A.outbox.update('mid', (e) => ({ ...e, status: 'delivered-instant' }));
    await A.outbox.update('mid', (e) => ({ ...e, status: 'finalizing' }));

    const published = await publish(A);

    // B has no prior state for 'mid' — pulls A's snapshot.
    const r = await pullAndApply(B, published.carBytes);
    expect(r.liveLanded).toBe(1);

    const bView = await B.outbox.readOne('mid');
    expect(bView?.shape).toBe('uxf-1');
    if (bView?.shape === 'uxf-1') {
      expect(bView.entry.status).toBe('finalizing');
      expect(bView.entry.everFinalizing).toBe(true);
      // Lamport is preserved exactly (4 writes → lamport=4).
      expect(bView.entry.lamport).toBe(4);
    }
  });
});

// =============================================================================
// G.5 — Non-overlapping union
// =============================================================================

describe('Phase G.5 — Non-overlapping union', () => {
  let A: Peer;
  let B: Peer;

  beforeEach(() => {
    A = createPeer();
    B = createPeer();
  });

  it('A {key1, key2}, B {key3, key4}; after bidirectional JOIN both see all four', async () => {
    await A.outbox.write(buildOutboxInput('key1'));
    await A.outbox.write(buildOutboxInput('key2'));
    await B.outbox.write(buildOutboxInput('key3'));
    await B.outbox.write(buildOutboxInput('key4'));

    // A → B
    const pA = await publish(A);
    const rA = await pullAndApply(B, pA.carBytes);
    expect(rA.liveLanded).toBe(2);

    // B → A (B's snapshot now contains the union from the prior JOIN)
    const pB = await publish(B);
    const rB = await pullAndApply(A, pB.carBytes);
    expect(rB.liveLanded).toBe(2);

    // Both sides observe the full union of 4 entries.
    for (const id of ['key1', 'key2', 'key3', 'key4']) {
      expect(await A.outbox.readOne(id)).not.toBeNull();
      expect(await B.outbox.readOne(id)).not.toBeNull();
    }
  });

  it("union preserves each entry's original Lamport across the bidirectional JOIN", async () => {
    // Each peer writes 3 entries; their Lamports are 1,2,3 per peer.
    // After bidirectional JOIN, each peer's local store has 6 entries
    // (3 from local, 3 from remote). Remote entries land with the
    // ORIGINATING peer's Lamport — JOIN never re-bumps.
    await A.outbox.write(buildOutboxInput('a1')); // lamport 1 on A
    await A.outbox.write(buildOutboxInput('a2')); // lamport 2 on A
    await A.outbox.write(buildOutboxInput('a3')); // lamport 3 on A
    await B.outbox.write(buildOutboxInput('b1')); // lamport 1 on B
    await B.outbox.write(buildOutboxInput('b2')); // lamport 2 on B
    await B.outbox.write(buildOutboxInput('b3')); // lamport 3 on B

    const pA = await publish(A);
    await pullAndApply(B, pA.carBytes);
    const pB = await publish(B);
    await pullAndApply(A, pB.carBytes);

    // A inspects b-keys → must see B's Lamports (1, 2, 3).
    const aB1 = await A.outbox.readOne('b1');
    const aB2 = await A.outbox.readOne('b2');
    const aB3 = await A.outbox.readOne('b3');
    if (aB1?.shape === 'uxf-1') expect(aB1.entry.lamport).toBe(1);
    if (aB2?.shape === 'uxf-1') expect(aB2.entry.lamport).toBe(2);
    if (aB3?.shape === 'uxf-1') expect(aB3.entry.lamport).toBe(3);

    // B inspects a-keys → must see A's Lamports (1, 2, 3).
    const bA1 = await B.outbox.readOne('a1');
    const bA2 = await B.outbox.readOne('a2');
    const bA3 = await B.outbox.readOne('a3');
    if (bA1?.shape === 'uxf-1') expect(bA1.entry.lamport).toBe(1);
    if (bA2?.shape === 'uxf-1') expect(bA2.entry.lamport).toBe(2);
    if (bA3?.shape === 'uxf-1') expect(bA3.entry.lamport).toBe(3);

    // Following the JOIN, each peer's local clock will observe the
    // remote Lamports on the NEXT live write via collectObservedLamports
    // + rehydrate — that's the writer's path for absorbing remote state
    // into the clock. A subsequent write on A bumps past max(local=3,
    // observed=3) → 4. Sanity-check that invariant survives a JOIN.
    const aPostJoin = await A.outbox.write(buildOutboxInput('after-join'));
    expect(aPostJoin.lamport).toBeGreaterThanOrEqual(4);
  });

  it('union after asymmetric mutations: A modifies one of its own keys; B never sees the OLD state', async () => {
    // Pre-condition: A and B both have key1 at lamport=1 via JOIN.
    await A.outbox.write(buildOutboxInput('key1'));
    {
      const p = await publish(A);
      await pullAndApply(B, p.carBytes);
    }

    // A advances key1 along the canonical §7.0 path to 'finalizing'.
    // packaging (1) → sending (2) → delivered-instant (3) → finalizing (4).
    await A.outbox.update('key1', (e) => ({ ...e, status: 'sending' }));
    await A.outbox.update('key1', (e) => ({ ...e, status: 'delivered-instant' }));
    await A.outbox.update('key1', (e) => ({ ...e, status: 'finalizing' }));

    // B pulls.
    const p2 = await publish(A);
    const r = await pullAndApply(B, p2.carBytes);
    expect(r.liveLanded).toBe(1);

    // B's local key1 is at A's terminal status with A's terminal Lamport.
    const bKey1 = await B.outbox.readOne('key1');
    if (bKey1?.shape === 'uxf-1') {
      expect(bKey1.entry.status).toBe('finalizing');
      expect(bKey1.entry.lamport).toBe(4);
      expect(bKey1.entry.everFinalizing).toBe(true);
    }
  });
});
