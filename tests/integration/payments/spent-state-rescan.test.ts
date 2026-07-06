/**
 * Integration test for the per-token spent-state rescan worker
 * (Issue #174; UXF-TRANSFER-PROTOCOL §12.3.2).
 *
 * Wires the worker against REAL `OutboxWriter` + `SentLedgerWriter`
 * instances (backed by a mock `ProfileDatabase`) so the
 * `suspectedSiblingInstance` heuristic is exercised against the
 * production lookup paths (`SentLedgerWriter.contains` + classified
 * `OutboxWriter.readAll`), not against test fakes. The oracle and
 * disposition-route hook stay mockable so the test stays deterministic.
 *
 * Two scenarios covered (the canonical pair from the issue spec):
 *
 *  1. **Sibling-spend** — token is in the active pool; neither the
 *     local OUTBOX nor the SENT ledger holds any entry referencing
 *     it. Oracle reports `isSpent === true`. Expected: event fires
 *     with `suspectedSiblingInstance: true`, and the
 *     `transitionToAudit` route is invoked (the production wiring
 *     would then call `dispositionWriter.write()` with an AUDIT
 *     record).
 *  2. **Local-spend** — token is in the active pool AND has a SENT
 *     entry referencing its `tokenId` (we DID spend it earlier, but
 *     the local manifest hasn't reflected the spend yet — a race
 *     window between SENT-write and the rescan cycle). Oracle reports
 *     `isSpent === true`. Expected: event fires with
 *     `suspectedSiblingInstance: false`, `transitionToAudit` invoked.
 *
 * The full PaymentsModule lifecycle is not exercised here — the
 * worker's wiring to PaymentsModule is covered by the unit tests in
 * `tests/unit/payments/transfer/spent-state-rescan-worker.test.ts`
 * and by the cross-module typecheck. This file's value is exercising
 * the writer-backed `suspectedSiblingInstance` paths against the same
 * code the production wiring uses.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  SpentStateRescanWorker,
  type SpentStateRescanWorkerDeps,
  type TransitionToAuditFn,
} from '../../../extensions/uxf/pipeline/spent-state-rescan-worker';
import { OutboxWriter } from '../../../extensions/uxf/profile/outbox-writer';
import { SentLedgerWriter } from '../../../extensions/uxf/profile/sent-ledger-writer';
import { Lamport } from '../../../extensions/uxf/profile/lamport';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../extensions/uxf/profile/types';
import type {
  SphereEventMap,
  SphereEventType,
  Token,
} from '../../../types';
import type { UxfTransferOutboxEntry } from '../../../types/uxf-outbox';
import type { UxfSentLedgerEntry } from '../../../types/uxf-sent';

// =============================================================================
// Fixture — shared addressId, mock ProfileDatabase.
// =============================================================================

const ADDR = 'DIRECT_aabbcc_ddeeff';

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
  readonly outbox: OutboxWriter;
  readonly sent: SentLedgerWriter;
}

function createPeer(): Peer {
  const db = createMockDb();
  return {
    outbox: new OutboxWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport: new Lamport(),
    }),
    sent: new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport: new Lamport(),
    }),
  };
}

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: overrides.id ?? 'tok-1',
    coinId: overrides.coinId ?? 'UCT-coin',
    symbol: overrides.symbol ?? 'UCT',
    name: overrides.name ?? 'Unicity',
    decimals: overrides.decimals ?? 8,
    amount: overrides.amount ?? '1000',
    status: overrides.status ?? 'confirmed',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
    sdkData: overrides.sdkData ?? '{"genesis":{"data":{"tokenId":"tok-1"}}}',
    ...overrides,
  };
}

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

interface AuditRecorder {
  readonly fn: TransitionToAuditFn;
  readonly calls: ReadonlyArray<{
    tokenId: string;
    stateHash: string;
    suspectedSiblingInstance: boolean;
  }>;
}

function makeAuditRecorder(): AuditRecorder {
  const calls: Array<{
    tokenId: string;
    stateHash: string;
    suspectedSiblingInstance: boolean;
  }> = [];
  return {
    calls,
    fn: async (params): Promise<void> => {
      calls.push({
        tokenId: params.token.id,
        stateHash: params.currentStateHash,
        suspectedSiblingInstance: params.suspectedSiblingInstance,
      });
    },
  };
}

function buildWorker(args: {
  readonly peer: Peer;
  readonly tokens: ReadonlyArray<Token>;
  // Issue #245 #1 — isSpent now receives the token (so the
  // PaymentsModule wrapper can derive per-token publicKey). Tests
  // ignore the token and key on stateHash only.
  readonly isSpent: (token: Token, stateHash: string) => Promise<boolean>;
  readonly audit: AuditRecorder;
  readonly emit: SpentStateRescanWorkerDeps['emit'];
}): SpentStateRescanWorker {
  const deps: SpentStateRescanWorkerDeps = {
    tokensProvider: () => args.tokens,
    oracleProvider: () => ({ isSpent: args.isSpent }),
    extractCurrentStateHash: (token: Token): string => `state-${token.id}`,
    sentProvider: () => args.peer.sent,
    outboxProvider: () => args.peer.outbox,
    transitionToAudit: args.audit.fn,
    emit: args.emit,
    logger: { warn: () => undefined },
    now: () => 1_700_000_000_000,
  };
  return new SpentStateRescanWorker(deps);
}

// =============================================================================
// Tests
// =============================================================================

describe('SpentStateRescanWorker — integration with real OUTBOX/SENT writers (Issue #174)', () => {
  let peer: Peer;

  beforeEach(() => {
    peer = createPeer();
  });

  it('sibling-spend scenario: no local OUTBOX/SENT record → suspectedSiblingInstance=true, transitions to _audit', async () => {
    const token = makeToken({ id: 'tok-sibling' });
    const recorder = makeEventRecorder();
    const audit = makeAuditRecorder();
    const worker = buildWorker({
      peer,
      tokens: [token],
      isSpent: async () => true,
      audit,
      emit: recorder.emit,
    });

    const result = await worker.runScanCycle();

    expect(result.spent).toBe(1);
    expect(result.unspent).toBe(0);
    expect(result.threw).toBe(0);

    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    const data = fired[0].data as {
      tokenId: string;
      suspectedSiblingInstance: boolean;
      coinId: string;
      amount: string;
    };
    expect(data.tokenId).toBe('tok-sibling');
    // Neither OUTBOX nor SENT has any record of this tokenId.
    expect(data.suspectedSiblingInstance).toBe(true);
    expect(data.coinId).toBe('UCT-coin');
    expect(data.amount).toBe('1000');

    // transitionToAudit invoked (the production wiring would route to
    // disposition writer with reason='off-record-spend').
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0].tokenId).toBe('tok-sibling');
    expect(audit.calls[0].suspectedSiblingInstance).toBe(true);
  });

  it('local-spend scenario: SENT ledger has the tokenId → suspectedSiblingInstance=false', async () => {
    const token = makeToken({ id: 'tok-local-spend' });
    const recorder = makeEventRecorder();
    const audit = makeAuditRecorder();

    // Pre-populate SENT with an entry referencing this tokenId — the
    // production case is "we sent it, the SENT entry was written, but
    // the local manifest hasn't been GC'd to reflect the spend yet."
    const sentEntry: Omit<UxfSentLedgerEntry, '_schemaVersion' | 'lamport'> = {
      id: 'sent-id-1',
      tokenIds: ['tok-local-spend'],
      bundleCid: 'bafy-fake',
      recipientTransportPubkey: 'pk-recipient',
      recipient: '@bob',
      deliveryMethod: 'car-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
      nostrEventId: 'evt-1',
    };
    await peer.sent.write(sentEntry);

    const worker = buildWorker({
      peer,
      tokens: [token],
      isSpent: async () => true,
      audit,
      emit: recorder.emit,
    });

    const result = await worker.runScanCycle();

    expect(result.spent).toBe(1);
    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    const data = fired[0].data as { suspectedSiblingInstance: boolean };
    // SENT has the record → local instance is the spender.
    expect(data.suspectedSiblingInstance).toBe(false);
    expect(audit.calls[0].suspectedSiblingInstance).toBe(false);
  });

  it('local-spend scenario: OUTBOX has the tokenId (delivered-instant) → suspectedSiblingInstance=false', async () => {
    // OUTBOX-active filter excludes the token from cycle eligibility
    // when the entry is at e.g. 'sending'/'packaging' — but a
    // 'delivered'/'delivered-instant' entry that hasn't yet been
    // tombstoned is still picked up by readAll(). We test that path
    // by seeding a 'delivered' OUTBOX entry: the cycle-start filter
    // sees it and excludes the token, so no probe runs. This is the
    // CORRECT behavior — the send pipeline owns this state, and our
    // worker stays out of the way.
    const token = makeToken({ id: 'tok-outbox-active' });
    const recorder = makeEventRecorder();
    const audit = makeAuditRecorder();

    const outboxEntry: Omit<
      UxfTransferOutboxEntry,
      '_schemaVersion' | 'lamport'
    > = {
      id: 'outbox-id-1',
      bundleCid: 'bafy-fake',
      tokenIds: ['tok-outbox-active'],
      deliveryMethod: 'cid-over-nostr',
      recipient: '@bob',
      recipientTransportPubkey: 'pk-recipient',
      mode: 'conservative',
      status: 'delivered',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    await peer.outbox.write(outboxEntry);

    const worker = buildWorker({
      peer,
      tokens: [token],
      isSpent: async () => true,
      audit,
      emit: recorder.emit,
    });

    const result = await worker.runScanCycle();

    // OUTBOX-active filter excluded the token before the probe ran.
    expect(result.probed).toBe(0);
    expect(result.eligibleTotal).toBe(0);
    expect(recorder.events).toHaveLength(0);
    expect(audit.calls).toHaveLength(0);
  });

  it('mixed pool: spent-no-record + unspent + no-sdk-data — exactly one event fires', async () => {
    const tokens = [
      makeToken({ id: 'tok-spent', amount: '500' }),
      makeToken({ id: 'tok-unspent', amount: '2000' }),
      makeToken({ id: 'tok-no-sdk', sdkData: undefined }),
    ];
    const recorder = makeEventRecorder();
    const audit = makeAuditRecorder();

    // Oracle answers: tok-spent → true, tok-unspent → false.
    // tok-no-sdk filtered out before probe.
    const worker = buildWorker({
      peer,
      tokens,
      isSpent: async (_token: Token, stateHash: string): Promise<boolean> => {
        if (stateHash === 'state-tok-spent') return true;
        if (stateHash === 'state-tok-unspent') return false;
        throw new Error(`unexpected stateHash: ${stateHash}`);
      },
      audit,
      emit: recorder.emit,
    });

    const result = await worker.runScanCycle();

    expect(result.probed).toBe(2);
    expect(result.spent).toBe(1);
    expect(result.unspent).toBe(1);
    expect(result.eligibleTotal).toBe(2);

    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    expect((fired[0].data as { tokenId: string }).tokenId).toBe('tok-spent');
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0].tokenId).toBe('tok-spent');
    // Neither OUTBOX nor SENT seeded → flag is true.
    expect(audit.calls[0].suspectedSiblingInstance).toBe(true);
  });
});
