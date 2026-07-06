/**
 * Item #15 downstream sweep — Item #2 retention re-publish two-peer
 * test (per ITEM-15-OPERATIONAL-CLOSURE-PROMPT.md gap #3).
 *
 * **The scenario the test demonstrates.** Two peers (A, B) share a
 * wallet identity (same `addressId`). Peer A creates an OUTBOX entry
 * at status `'delivered'` (a successful publish whose SENT-write has
 * landed) AND a SENT ledger entry for the same bundle. The OUTBOX
 * entry is kept LIVE at `'delivered'` (the "forensic preservation"
 * mode introduced in `fcf1d53`).
 *
 * Then:
 *   1. Peer A publishes its lean profile snapshot (which includes
 *      both the OUTBOX and SENT entries).
 *   2. Peer B pulls + JOINs that snapshot. Both entries land on B.
 *   3. Peer B's `NostrPersistenceVerifier` is asked to verify the
 *      relay still holds the Nostr event; the test injects a
 *      `'missing'` outcome.
 *   4. The verifier calls `attemptRetentionRepublish` on B's OUTBOX
 *      writer. Because the entry IS present on B (via snapshot JOIN),
 *      the transition `delivered → sending` succeeds and the
 *      `transfer:retention-republish-rearmed` event fires.
 *
 * **The pre-Item-#15 baseline.** This file also exercises the
 * COMPARISON path — same fixture but WITHOUT the snapshot JOIN step.
 * In that mode Peer B does not have the OUTBOX entry locally; the
 * verifier's `update()` call surfaces `OUTBOX_ENTRY_NOT_FOUND` and
 * the emit chain fires `'transfer:retention-republish-skipped'` with
 * `reason='entry-tombstoned-or-missing'`. This locks the contract
 * that Item #15's snapshot sync materially eliminates the most common
 * skip reason on the retention-republish path.
 *
 * **What this file COVERS** (per the spec's "Scope after Item #15"
 * note on Item #2 in `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md`):
 *  - Cross-device OUTBOX propagation via the lean-snapshot pull JOIN.
 *  - `'entry-tombstoned-or-missing'` skip-reason elimination on the
 *    common cross-device retention re-publish path.
 *  - The companion SENT entry propagates alongside (so the verifier's
 *    scan loop has something to scan on the receiving device).
 *
 * **What this file DOES NOT cover** (covered by the unit tests for
 * `NostrPersistenceVerifier` already):
 *  - The verify-outcome classification (retained / missing /
 *    unverifiable).
 *  - The eligibility filter (verifyDelayMs, maxScanPerCycle, etc.).
 *  - The interaction with `SendingRecoveryWorker` after the OUTBOX
 *    flip — that path is exercised by the recovery-worker tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  NostrPersistenceVerifier,
  type NostrPersistenceVerifierDeps,
  type VerifySentEntryFn,
} from '../../../extensions/uxf/pipeline/nostr-persistence-verifier.js';
import { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer.js';
import { SentLedgerWriter } from '../../../extensions/uxf/profile/sent-ledger-writer.js';
import { Lamport } from '../../../extensions/uxf/profile/lamport.js';
import {
  buildLeanProfileSnapshot,
  parseLeanProfileSnapshot,
} from '../../../extensions/uxf/profile/profile-lean-snapshot.js';
import {
  runProfileSnapshotJoin,
  type SnapshotJoinWriterEntry,
} from '../../../extensions/uxf/profile/profile-snapshot-dispatcher.js';
import type { ProfileSyncWriter } from '../../../extensions/uxf/profile/profile-snapshot-merge.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
  UxfBundleRef,
} from '../../../extensions/uxf/profile/types.js';
import type { StorageProvider } from '../../../storage/storage-provider.js';
import type {
  FullIdentity,
  ProviderStatus,
  SphereEventMap,
  SphereEventType,
  TrackedAddressEntry,
} from '../../../types/index.js';
import type { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider.js';

// =============================================================================
// Fixture — shared `addressId`, mock DB, peer construction.
// =============================================================================

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
  async get(): Promise<string | null> {
    throw new Error('not used');
  }
  async set(): Promise<void> {
    throw new Error('not used');
  }
  async remove(): Promise<void> {
    throw new Error('not used');
  }
  async has(): Promise<boolean> {
    throw new Error('not used');
  }
  async keys(prefix?: string): Promise<string[]> {
    const all = await this.db.all();
    const out: string[] = [];
    for (const k of all.keys()) {
      if (!prefix || k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
  async clear(): Promise<void> {
    throw new Error('not used');
  }
  async saveTrackedAddresses(_: TrackedAddressEntry[]): Promise<void> {}
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    return [];
  }
  async getEncryptedRaw(key: string): Promise<string | null> {
    const raw = await this.db.get(key);
    if (raw === null) return null;
    return Buffer.from(raw).toString('base64');
  }
}

class FakeTokenStorage {
  async listBundles(): Promise<Map<string, UxfBundleRef>> {
    return new Map();
  }
}

// =============================================================================
// Helpers — publish (build snapshot) + pullAndApply (parse + dispatch)
// =============================================================================

async function publish(peer: Peer): Promise<{ readonly carBytes: Uint8Array }> {
  const result = await buildLeanProfileSnapshot({
    storage: peer.storage,
    tokenStorage: peer.tokenStorage as unknown as ProfileTokenStorageProvider,
    chainPubkey: TEST_CHAIN_PUBKEY,
    network: 'testnet',
    createdAt: 1_700_000_000_000,
  });
  return { carBytes: result.carBytes };
}

function writersForPeer(peer: Peer): (addressId: string) => ReadonlyArray<SnapshotJoinWriterEntry> {
  return (addressId: string): ReadonlyArray<SnapshotJoinWriterEntry> => {
    if (addressId !== ADDR) return [];
    return [
      { keyPrefix: OUTBOX_PREFIX, writer: peer.outbox as ProfileSyncWriter },
      { keyPrefix: SENT_PREFIX, writer: peer.sent as ProfileSyncWriter },
    ];
  };
}

async function pullAndApply(receiver: Peer, carBytes: Uint8Array): Promise<void> {
  const snapshot = await parseLeanProfileSnapshot(carBytes);
  await runProfileSnapshotJoin(snapshot, {
    writersFor: writersForPeer(receiver),
    bundleIndex: null,
  });
}

// =============================================================================
// Event-recorder fixture — captures verifier-emitted events for assertions.
// =============================================================================

interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

function makeEventRecorder(): {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      events.push({ type, data });
    },
  };
}

// =============================================================================
// Seeding helpers — Peer A creates the OUTBOX + SENT pair for the test.
// =============================================================================

const TEST_BUNDLE_CID = 'bafy-shared-bundle';
const TEST_TOKEN_IDS = ['0xtoken-shared'];
const TEST_TRANSFER_ID = 'transfer-shared';
const TEST_NOSTR_EVENT_ID = 'nostr-event-shared';
const TEST_RECIPIENT_PK = 'r'.repeat(64);

async function seedDeliveredOutboxAndSent(peer: Peer): Promise<void> {
  // Walk the OUTBOX entry through `packaging → pinned → sending →
  // delivered` so the state-machine validator doesn't reject any arc.
  // The intermediate statuses don't affect the retention path; only
  // the terminal `'delivered'` state matters.
  const now = 1_700_000_000_000;
  await peer.outbox.write({
    id: TEST_TRANSFER_ID,
    bundleCid: TEST_BUNDLE_CID,
    tokenIds: TEST_TOKEN_IDS,
    deliveryMethod: 'cid-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: TEST_RECIPIENT_PK,
    mode: 'conservative',
    status: 'packaging',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  await peer.outbox.update(TEST_TRANSFER_ID, (prev) => ({
    ...prev,
    status: 'pinned',
    updatedAt: now,
  }));
  await peer.outbox.update(TEST_TRANSFER_ID, (prev) => ({
    ...prev,
    status: 'sending',
    updatedAt: now,
  }));
  await peer.outbox.update(TEST_TRANSFER_ID, (prev) => ({
    ...prev,
    status: 'delivered',
    nostrEventId: TEST_NOSTR_EVENT_ID,
    updatedAt: now,
  }));
  await peer.sent.write({
    id: TEST_TRANSFER_ID,
    tokenIds: TEST_TOKEN_IDS,
    bundleCid: TEST_BUNDLE_CID,
    recipientTransportPubkey: TEST_RECIPIENT_PK,
    recipient: '@bob',
    deliveryMethod: 'cid-over-nostr',
    mode: 'conservative',
    sentAt: now,
    nostrEventId: TEST_NOSTR_EVENT_ID,
  });
}

function makeVerifier(
  receiver: Peer,
  verify: VerifySentEntryFn,
  emit: NostrPersistenceVerifierDeps['emit'],
  nowMs: number,
): NostrPersistenceVerifier {
  const deps: NostrPersistenceVerifierDeps = {
    sentProvider: () => receiver.sent,
    outboxProvider: () => receiver.outbox,
    verify,
    emit,
    logger: { warn: () => undefined, info: () => undefined },
    now: () => nowMs,
  };
  return new NostrPersistenceVerifier(deps, {
    intervalMs: 60_000,
    verifyDelayMs: 1_000,
    maxScanPerCycle: 10,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Item #2 downstream sweep — retention re-publish after snapshot JOIN', () => {
  let A: Peer;
  let B: Peer;

  beforeEach(() => {
    A = createPeer();
    B = createPeer();
  });

  it('with snapshot JOIN: OUTBOX entry on receiver allows retention re-publish to ARM (no entry-tombstoned-or-missing skip)', async () => {
    // 1. Peer A creates the delivered OUTBOX entry + SENT entry on
    //    the local store. The OUTBOX entry is preserved live at
    //    'delivered' (the forensic-record mode introduced in
    //    fcf1d53).
    await seedDeliveredOutboxAndSent(A);

    // 2. Peer A publishes a lean profile snapshot; Peer B pulls
    //    and JOINs. After this step Peer B's local store has both
    //    the OUTBOX entry and the SENT entry — propagated via the
    //    per-writer JOIN.
    const { carBytes } = await publish(A);
    await pullAndApply(B, carBytes);

    // Verify the propagation actually happened — pre-condition for
    // the assertion below.
    const propagatedSent = await B.sent.readAll();
    expect(propagatedSent).toHaveLength(1);
    expect(propagatedSent[0].id).toBe(TEST_TRANSFER_ID);
    const propagatedOutbox = await B.outbox.readAll();
    expect(propagatedOutbox).toHaveLength(1);
    expect(propagatedOutbox[0]).toMatchObject({
      entry: { id: TEST_TRANSFER_ID, status: 'delivered' },
    });

    // 3. Construct a verifier on Peer B. The verify closure returns
    //    'missing' for the bundle — this is the trigger.
    const recorder = makeEventRecorder();
    // Run the verifier "well past" the verify-delay so the SENT
    // entry is eligible for scanning.
    const nowMs = 1_700_000_000_000 + 10_000;
    const verifier = makeVerifier(
      B,
      async () => 'missing',
      recorder.emit,
      nowMs,
    );

    // 4. Run one scan cycle. Expect:
    //    - 'transfer:retention-warning' (always fires on 'missing')
    //    - 'transfer:retention-republish-rearmed' (the new arc)
    //    - NO 'transfer:retention-republish-skipped' with reason
    //      'entry-tombstoned-or-missing' (the legacy skip the
    //      cross-device snapshot sync materially eliminates).
    const result = await verifier.runScanCycle();
    expect(result.missing).toBe(1);
    expect(result.retained).toBe(0);
    expect(result.skipped).toBe(false);

    const rearmed = recorder.events.filter(
      (e) => e.type === 'transfer:retention-republish-rearmed',
    );
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].data).toMatchObject({
      sentId: TEST_TRANSFER_ID,
      bundleCid: TEST_BUNDLE_CID,
      fromStatus: 'delivered',
      toStatus: 'sending',
    });

    // The KEY assertion of this test — the legacy skip MUST NOT
    // fire when the OUTBOX entry propagated via snapshot JOIN.
    const skipped = recorder.events.filter(
      (e) => e.type === 'transfer:retention-republish-skipped',
    );
    expect(skipped).toEqual([]);

    // Side-effect: the OUTBOX entry on Peer B is now at 'sending'
    // — SendingRecoveryWorker (if running on B) will pick it up.
    const reread = await B.outbox.readAll();
    expect(reread[0]).toMatchObject({
      entry: { id: TEST_TRANSFER_ID, status: 'sending' },
    });

    // The SENT entry is untouched — durable historical record.
    const sentRereard = await B.sent.readAll();
    expect(sentRereard).toHaveLength(1);
  });

  it('baseline (no snapshot JOIN): entry-tombstoned-or-missing FIRES when OUTBOX entry is absent on the verifier peer', async () => {
    // Same fixture, but skip the snapshot JOIN step. We still seed
    // Peer A and copy ONLY the SENT entry over to Peer B (so the
    // verifier has something to scan). The OUTBOX entry is
    // intentionally absent on B — this is what Item #15's snapshot
    // sync materially eliminates.
    await seedDeliveredOutboxAndSent(A);

    // Direct SENT-only propagation — write the same SENT shape on B
    // without bringing the OUTBOX along. Mirrors the pre-Item-#15
    // cross-device state where OUTBOX entries did NOT pointer-
    // propagate.
    const a_sent = (await A.sent.readAll())[0];
    await B.sent.write({
      id: a_sent.id,
      tokenIds: [...a_sent.tokenIds],
      bundleCid: a_sent.bundleCid,
      recipientTransportPubkey: a_sent.recipientTransportPubkey,
      recipient: a_sent.recipient,
      deliveryMethod: a_sent.deliveryMethod,
      mode: a_sent.mode,
      sentAt: a_sent.sentAt,
      nostrEventId: a_sent.nostrEventId,
    });

    // Pre-condition: B has the SENT entry, NOT the OUTBOX entry.
    expect((await B.sent.readAll())).toHaveLength(1);
    expect((await B.outbox.readAll())).toHaveLength(0);

    const recorder = makeEventRecorder();
    const nowMs = 1_700_000_000_000 + 10_000;
    const verifier = makeVerifier(
      B,
      async () => 'missing',
      recorder.emit,
      nowMs,
    );

    const result = await verifier.runScanCycle();
    expect(result.missing).toBe(1);

    // The legacy skip fires — proves the test scenario actually
    // exercises the contrast.
    const skipped = recorder.events.filter(
      (e) => e.type === 'transfer:retention-republish-skipped',
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].data).toMatchObject({
      sentId: TEST_TRANSFER_ID,
      bundleCid: TEST_BUNDLE_CID,
      reason: 'entry-tombstoned-or-missing',
    });

    const rearmed = recorder.events.filter(
      (e) => e.type === 'transfer:retention-republish-rearmed',
    );
    expect(rearmed).toEqual([]);
  });

  it('idempotent: re-running the verifier after the first arm does NOT re-arm a second time', async () => {
    // Locks the "first cycle classifies; subsequent cycles skip"
    // contract. After the first 'missing' classification the entry
    // is added to `checkedIds` and the SENT entry's nostrEventId
    // is NOT re-verified on subsequent cycles within the same
    // worker lifetime.
    await seedDeliveredOutboxAndSent(A);
    const { carBytes } = await publish(A);
    await pullAndApply(B, carBytes);

    const recorder = makeEventRecorder();
    const nowMs = 1_700_000_000_000 + 10_000;
    const verifier = makeVerifier(
      B,
      async () => 'missing',
      recorder.emit,
      nowMs,
    );

    await verifier.runScanCycle();
    const eventsAfterFirst = recorder.events.length;
    await verifier.runScanCycle();
    expect(recorder.events.length).toBe(eventsAfterFirst);
  });
});
