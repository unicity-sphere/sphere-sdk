/**
 * Tests for `modules/payments/transfer/orphan-spending-sweeper.ts`
 * (Issue #97 crash-recovery sweeper).
 *
 * Covers:
 *   1. Self-skip when either writer is null.
 *   2. Clean wallet — no `transferring` tokens → no orphans.
 *   3. All `transferring` tokens covered by OUTBOX → no orphans.
 *   4. All `transferring` tokens covered by SENT → no orphans.
 *   5. `transferring` token absent from both → orphan emitted.
 *   6. Mixed: some covered, some orphans → only orphans emitted.
 *   7. Non-`transferring` tokens (confirmed, pending) ignored even
 *      when absent from both.
 *   8. Writer read failure aborts the sweep (skipped=true, no false
 *      positives).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sweepOrphanSpendingTokens } from '../../../../modules/payments/transfer/orphan-spending-sweeper.js';
import { OutboxWriter } from '../../../../profile/outbox-writer.js';
import { SentLedgerWriter } from '../../../../profile/sent-ledger-writer.js';
import { Lamport } from '../../../../profile/lamport.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../../profile/types.js';
import type { Token, SphereEventType, SphereEventMap } from '../../../../types';

const ADDR = 'DIRECT_aabbcc_ddeeff';

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

function tok(
  id: string,
  status: Token['status'],
  overrides: Partial<Token> = {},
): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '100',
    status,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

interface EmittedEvent {
  type: SphereEventType;
  data: unknown;
}

function makeRecordingEmit(): { emit: <T extends SphereEventType>(t: T, d: SphereEventMap[T]) => void; events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => {
      events.push({ type, data });
    },
  };
}

describe('sweepOrphanSpendingTokens (Issue #97)', () => {
  let db: MockProfileDb;
  let outboxWriter: OutboxWriter;
  let sentLedgerWriter: SentLedgerWriter;

  beforeEach(() => {
    db = createMockDb();
    outboxWriter = new OutboxWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport: new Lamport(),
    });
    sentLedgerWriter = new SentLedgerWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport: new Lamport(),
    });
  });

  // -------------------------------------------------------------------------
  // 1. Self-skip when writers are null
  // -------------------------------------------------------------------------
  it('skips when outboxWriter is null', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan', 'transferring')],
      outboxWriter: null,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  it('skips when sentLedgerWriter is null', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan', 'transferring')],
      outboxWriter,
      sentLedgerWriter: null,
      emit: r.emit,
    });
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Clean wallet
  // -------------------------------------------------------------------------
  it('clean wallet — no orphans', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [
        tok('a', 'confirmed'),
        tok('b', 'pending'),
        tok('c', 'submitted'),
      ],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(0);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Covered by OUTBOX
  // -------------------------------------------------------------------------
  it('transferring token covered by OUTBOX is not flagged', async () => {
    await outboxWriter.write({
      id: 'xfer-1',
      bundleCid: 'bafy-1',
      tokenIds: ['cov-1'],
      deliveryMethod: 'car-over-nostr',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'sending',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('cov-1', 'transferring')],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(1);
    expect(result.orphans).toHaveLength(0);
    expect(result.knownTokenIdsCount).toBe(1);
    expect(r.events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Covered by SENT
  // -------------------------------------------------------------------------
  it('transferring token covered by SENT is not flagged', async () => {
    await sentLedgerWriter.write({
      id: 'xfer-2',
      tokenIds: ['cov-2'],
      bundleCid: 'bafy-2',
      recipientTransportPubkey: 'b'.repeat(64),
      deliveryMethod: 'cid-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('cov-2', 'transferring')],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(1);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. True orphan
  // -------------------------------------------------------------------------
  it('transferring token absent from both is flagged as orphan + event emitted', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan-1', 'transferring', { coinId: 'UCT', amount: '500' })],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(1);
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]).toMatchObject({
      tokenId: 'orphan-1',
      coinId: 'UCT',
      amount: '500',
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].type).toBe('transfer:orphan-spending-detected');
    expect((r.events[0].data as { tokenId: string }).tokenId).toBe('orphan-1');
  });

  // -------------------------------------------------------------------------
  // 6. Mixed: covered + orphans
  // -------------------------------------------------------------------------
  it('mixed: emits events only for the orphans', async () => {
    await outboxWriter.write({
      id: 'xfer-A',
      bundleCid: 'bafy-A',
      tokenIds: ['cov-A'],
      deliveryMethod: 'car-over-nostr',
      recipient: '@bob',
      recipientTransportPubkey: 'a'.repeat(64),
      mode: 'instant',
      status: 'sending',
      submitRetryCount: 0,
      proofErrorCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    await sentLedgerWriter.write({
      id: 'xfer-B',
      tokenIds: ['cov-B'],
      bundleCid: 'bafy-B',
      recipientTransportPubkey: 'b'.repeat(64),
      deliveryMethod: 'cid-over-nostr',
      mode: 'conservative',
      sentAt: 1_700_000_000_000,
    });

    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [
        tok('cov-A', 'transferring'),
        tok('cov-B', 'transferring'),
        tok('orphan-1', 'transferring'),
        tok('orphan-2', 'transferring'),
        tok('confirmed-1', 'confirmed'), // ignored — wrong status
      ],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(4);
    expect(result.orphans.map((o) => o.tokenId).sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(r.events.map((e) => (e.data as { tokenId: string }).tokenId).sort()).toEqual([
      'orphan-1',
      'orphan-2',
    ]);
  });

  // -------------------------------------------------------------------------
  // 7. Non-transferring tokens are ignored
  // -------------------------------------------------------------------------
  it('does NOT flag tokens in non-transferring status even when absent from OUTBOX/SENT', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [
        tok('a', 'confirmed'),
        tok('b', 'pending'),
        tok('c', 'submitted'),
        tok('d', 'invalid'),
        tok('e', 'spent'),
      ],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.scannedTransferringCount).toBe(0);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. Writer read failure aborts the sweep
  // -------------------------------------------------------------------------
  it('aborts the sweep when outbox readAllNew throws (no false positives)', async () => {
    const brokenOutbox: OutboxWriter = Object.create(outboxWriter);
    brokenOutbox.readAllNew = async () => {
      throw new Error('orbitdb is down');
    };
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan-1', 'transferring')],
      outboxWriter: brokenOutbox,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  it('aborts the sweep when SENT readAll throws (no false positives)', async () => {
    const brokenSent: SentLedgerWriter = Object.create(sentLedgerWriter);
    brokenSent.readAll = async () => {
      throw new Error('orbitdb is down');
    };
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan-1', 'transferring')],
      outboxWriter,
      sentLedgerWriter: brokenSent,
      emit: r.emit,
    });
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
    expect(r.events).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Steelman item 2 — dispatcher-in-flight gate
  // -------------------------------------------------------------------------
  it('skips the sweep when dispatcherInFlightCount > 0 (legitimate in-flight send)', async () => {
    // Scenario: a send is mid-flight. selectSources has marked the
    // token 'transferring' but the orchestrator's outbox.create
    // hasn't run yet (commitSources is still going). Without the
    // gate, the sweep would flag this as an orphan — false positive
    // that pages an operator over a normal send in progress.
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [
        tok('mid-flight-1', 'transferring'),
        tok('mid-flight-2', 'transferring'),
      ],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
      dispatcherInFlightCount: 1,
    });
    expect(result.skipped).toBe(true);
    expect(result.orphans).toHaveLength(0);
    expect(result.scannedTransferringCount).toBe(0);
    expect(r.events).toHaveLength(0);
  });

  it('skips the sweep when dispatcherInFlightCount is large (multiple concurrent sends)', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('mid-flight-1', 'transferring')],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
      dispatcherInFlightCount: 7,
    });
    expect(result.skipped).toBe(true);
    expect(r.events).toHaveLength(0);
  });

  it('runs the sweep normally when dispatcherInFlightCount is 0 (explicit)', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan-1', 'transferring')],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
      dispatcherInFlightCount: 0,
    });
    expect(result.skipped).toBe(false);
    expect(result.orphans).toHaveLength(1);
    expect(r.events).toHaveLength(1);
  });

  it('runs the sweep normally when dispatcherInFlightCount is omitted (defaults to 0, backward-compat)', async () => {
    const r = makeRecordingEmit();
    const result = await sweepOrphanSpendingTokens({
      tokens: [tok('orphan-1', 'transferring')],
      outboxWriter,
      sentLedgerWriter,
      emit: r.emit,
    });
    expect(result.skipped).toBe(false);
    expect(result.orphans).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Issue #166 P4 #4 — emit() async-rejection forward-compat
  // -------------------------------------------------------------------------
  describe('emit() async-rejection handling (Issue #166 P4 #4)', () => {
    it('does NOT throw when emit returns a rejecting Promise (sync emitters continue to work)', async () => {
      const asyncRejectingEmit: <T extends never>(
        _t: T,
        _d: unknown,
      ) => Promise<void> = async () => {
        throw new Error('emit-failed-async');
      };

      // No throw must escape — the try/catch awaits the promise.
      await expect(
        sweepOrphanSpendingTokens({
          tokens: [tok('orphan-1', 'transferring')],
          outboxWriter,
          sentLedgerWriter,
          emit: asyncRejectingEmit as never,
        }),
      ).resolves.toMatchObject({ skipped: false, orphans: [{ tokenId: 'orphan-1' }] });
    });

    it('continues processing subsequent orphans after one emit rejects', async () => {
      // The try/catch is per-orphan inside the for loop. A rejection
      // for orphan-1 must not stop orphan-2 from being processed.
      let calls = 0;
      const partiallyFailingEmit: <T extends never>(
        _t: T,
        _d: unknown,
      ) => Promise<void> | void = (_t, _d) => {
        calls += 1;
        // First call rejects; second call resolves.
        if (calls === 1) {
          return Promise.reject(new Error('emit-failed-orphan-1'));
        }
        return undefined;
      };

      const result = await sweepOrphanSpendingTokens({
        tokens: [
          tok('orphan-1', 'transferring'),
          tok('orphan-2', 'transferring'),
        ],
        outboxWriter,
        sentLedgerWriter,
        emit: partiallyFailingEmit as never,
      });

      // Both orphans should be DETECTED (the rejection only affects
      // the emit attempt — the finding is already pushed before).
      expect(result.orphans.map((o) => o.tokenId).sort()).toEqual([
        'orphan-1',
        'orphan-2',
      ]);
      // Both emit attempts should have fired (the loop didn't bail).
      expect(calls).toBe(2);
    });

    it('still works with the synchronous void-returning emit signature (backward-compat)', async () => {
      // The pre-#166 emitter (void return) must continue to work
      // — backward-compat is required. The widened type
      // `void | Promise<void>` is a superset, so this is true by
      // construction, but pin it here as a regression guard.
      const r = makeRecordingEmit();
      const result = await sweepOrphanSpendingTokens({
        tokens: [tok('orphan-1', 'transferring')],
        outboxWriter,
        sentLedgerWriter,
        emit: r.emit,
      });
      expect(result.orphans).toHaveLength(1);
      expect(r.events).toHaveLength(1);
    });
  });
});
