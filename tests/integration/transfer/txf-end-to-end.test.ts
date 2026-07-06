/**
 * §11.2 integration — End-to-end TXF-mode (legacy wire shape) send for
 * BOTH finalization variants (conservative + instant).
 *
 * Pipeline under test (sender side, T.7.B txf-sender):
 *   `validateTargets` → `selectSources` → `commitSources` → per-token
 *   loop emitting one `sourceToken / transferTx` legacy event per source
 *   over `transport.sendTokenTransfer`.
 *
 * Acceptance per §11.2:
 *   - Conservative-TXF: each event carries an inclusion-proof-bearing
 *     `transferTx` (the orchestrator does NOT inspect the JSON; we
 *     simulate the proof attachment via the commit callback).
 *   - Instant-TXF: each event carries a proof-null `transferTx` and the
 *     orchestrator fires the per-token finalization trigger so T.5.B
 *     can complete the cycle.
 *   - Per-token isolation: K events for K source tokens — outbox writer
 *     receives 3-N transitions per token (packaging → sending →
 *     delivered/delivered-instant), strictly partitioned by entry id.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  sendTxfUxf,
  type TxfCommitResult,
  type TxfFinalization,
  type TxfSenderDeps,
  type TxfOutboxHooks,
} from '../../../extensions/uxf/pipeline/txf-sender';
import type { TransferRequest } from '../../../types';
import type { UxfTransferOutboxEntry } from '../../../extensions/uxf/types/uxf-outbox';
import { TOKEN_A } from '../../fixtures/uxf-mock-tokens';

import {
  BOB_TRANSPORT_PUBKEY,
  defaultCoinTokenLike,
  makeEventRecorder,
  makeIdentity,
  makeOracleStub,
  makePeerInfo,
  makeRecordingTransport,
  makeToken,
  rewriteFixtureTokenId,
} from './_harness';

// =============================================================================
// 1. Harness
// =============================================================================

interface OutboxRecorder {
  readonly hooks: TxfOutboxHooks;
  readonly writes: Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>>;
}

function makeOutboxRecorder(): OutboxRecorder {
  const writes: OutboxRecorder['writes'] = [];
  return {
    writes,
    hooks: {
      write: async (entry) => {
        writes.push(entry);
      },
    },
  };
}

interface RunArgs {
  readonly tokenCount: number;
  readonly variant: TxfFinalization;
}

async function runTxfSendN(args: RunArgs): Promise<{
  readonly events: ReturnType<typeof makeEventRecorder>;
  readonly transportCalls: ReadonlyArray<{ recipient: string; payload: unknown }>;
  readonly outbox: OutboxRecorder;
  readonly canonicalTokenIds: ReadonlyArray<string>;
  readonly triggerCalls: ReadonlyArray<{
    readonly outboxId: string;
    readonly bundleCid: string;
    readonly outstandingRequestIds: ReadonlyArray<string>;
  }>;
}> {
  const { tokenCount, variant } = args;
  const sources = Array.from({ length: tokenCount }, (_, i) => {
    const serial = (i + 1).toString(16).padStart(4, '0');
    const idHex = `cc${serial}${'0'.repeat(58)}`;
    const fixture = rewriteFixtureTokenId(TOKEN_A, idHex);
    return { token: makeToken({ id: idHex, fixture }), fixture, idHex };
  });

  // Synthesize the (sourceToken, transferTx) JSON pair the legacy wire
  // shape carries. The orchestrator treats both fields opaquely — it
  // forwards the strings into `payload.sourceToken / payload.transferTx`.
  const commitResults: TxfCommitResult[] = sources.map((s) => {
    const transferTx =
      variant === 'conservative'
        ? { kind: 'conservative-tx', tokenId: s.idHex, inclusionProof: { mock: 'proof' } }
        : { kind: 'instant-tx', tokenId: s.idHex, inclusionProof: null };
    return {
      sourceTokenId: s.idHex,
      method: 'split',
      requestIdHex: `req-${s.idHex}`,
      sourceTokenJson: JSON.stringify(s.fixture),
      transferTxJson: JSON.stringify(transferTx),
      tokenClass: 'coin',
    };
  });

  const transport = makeRecordingTransport();
  const events = makeEventRecorder();
  const outbox = makeOutboxRecorder();
  const triggerCalls: Array<{
    outboxId: string;
    bundleCid: string;
    outstandingRequestIds: ReadonlyArray<string>;
  }> = [];

  const deps: TxfSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    addressId: 'DIRECT://alice-direct',
    senderTransportPubkey: BOB_TRANSPORT_PUBKEY,
    emit: events.emit,
    availableSources: () => sources.map((s) => s.token),
    selectSources: async () => sources.map((s) => s.token),
    commitSources: async () => commitResults,
    outbox: outbox.hooks,
    onTriggerFinalization: ({ outboxId, bundleCid, outstandingRequestIds }) => {
      triggerCalls.push({
        outboxId,
        bundleCid,
        outstandingRequestIds: [...outstandingRequestIds],
      });
    },
    toTokenLike: defaultCoinTokenLike,
  };

  const request: TransferRequest = {
    recipient: '@bob',
    coinId: 'UCT',
    amount: String(1_000_000 * tokenCount),
    transferMode: 'conservative',
  };

  const result = await sendTxfUxf(request, makePeerInfo(), deps, variant);
  if (variant === 'conservative') {
    expect(result.status).toBe('completed');
  } else {
    expect(result.status).toBe('submitted');
  }
  expect(transport._calls).toHaveLength(tokenCount);

  return {
    events,
    transportCalls: transport._calls,
    outbox,
    canonicalTokenIds: sources.map((s) => s.idHex),
    triggerCalls,
  };
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('§11.2 — TXF-mode end-to-end (conservative, 1 token)', () => {
  it('sender emits one legacy event with inclusion-proof-bearing transferTx', async () => {
    const { events, transportCalls, canonicalTokenIds, outbox, triggerCalls } =
      await runTxfSendN({ tokenCount: 1, variant: 'conservative' });

    expect(events.count('transfer:confirmed')).toBe(1);
    expect(events.count('transfer:failed')).toBe(0);
    // Conservative-TXF skips the per-token finalization trigger.
    expect(triggerCalls).toHaveLength(0);

    // Wire payload: legacy `(sourceToken, transferTx)` shape.
    const wire = transportCalls[0].payload as {
      sourceToken: string;
      transferTx: string;
      sender?: { transportPubkey: string };
    };
    expect(typeof wire.sourceToken).toBe('string');
    expect(typeof wire.transferTx).toBe('string');
    const tx = JSON.parse(wire.transferTx) as { tokenId: string; inclusionProof: unknown };
    expect(tx.tokenId).toBe(canonicalTokenIds[0]);
    expect(tx.inclusionProof).not.toBeNull();

    // Outbox: 3 transitions per token (packaging → sending → delivered).
    expect(outbox.writes).toHaveLength(3);
    expect(outbox.writes.map((w) => w.status)).toEqual([
      'packaging',
      'sending',
      'delivered',
    ]);
  });
});

describe('§11.2 — TXF-mode end-to-end (conservative, 5 tokens)', () => {
  it('5 events, one per source token; per-token outbox isolation; deterministic order', async () => {
    const { events, transportCalls, canonicalTokenIds, outbox } = await runTxfSendN({
      tokenCount: 5,
      variant: 'conservative',
    });

    expect(transportCalls).toHaveLength(5);
    expect(events.count('transfer:confirmed')).toBe(1);
    expect(events.count('transfer:failed')).toBe(0);

    // Outbox: 3 transitions × 5 tokens = 15 writes; per-token entryIds
    // are unique.
    expect(outbox.writes).toHaveLength(15);
    const entryIds = new Set(outbox.writes.map((w) => w.id));
    expect(entryIds.size).toBe(5);

    // Each token's transitions are packaging → sending → delivered, in
    // order. Group writes by entry id and assert the per-entry sequence.
    const byEntry = new Map<
      string,
      Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>>
    >();
    for (const w of outbox.writes) {
      const list = byEntry.get(w.id) ?? [];
      list.push(w);
      byEntry.set(w.id, list);
    }
    for (const list of byEntry.values()) {
      expect(list.map((w) => w.status)).toEqual([
        'packaging',
        'sending',
        'delivered',
      ]);
    }

    // Wire events are deterministically ordered (lex-min by tokenId).
    const wireTokenIds = transportCalls.map((c) => {
      const wire = c.payload as { transferTx: string };
      return (JSON.parse(wire.transferTx) as { tokenId: string }).tokenId;
    });
    expect(wireTokenIds).toEqual([...canonicalTokenIds].sort());
  });
});

describe('§11.2 — TXF-mode end-to-end (instant, 1 token)', () => {
  it('sender emits one legacy event with proof-null transferTx; finalization trigger fires once', async () => {
    const { events, transportCalls, canonicalTokenIds, triggerCalls, outbox } =
      await runTxfSendN({ tokenCount: 1, variant: 'instant' });

    expect(events.count('transfer:submitted')).toBe(1);
    expect(events.count('transfer:confirmed')).toBe(0);
    expect(events.count('transfer:failed')).toBe(0);

    const wire = transportCalls[0].payload as { transferTx: string };
    const tx = JSON.parse(wire.transferTx) as { tokenId: string; inclusionProof: unknown };
    expect(tx.tokenId).toBe(canonicalTokenIds[0]);
    expect(tx.inclusionProof).toBeNull();

    // T.5.B trigger: fires exactly once per token, with the synthetic
    // bundleCid and the per-token outstanding requestId set.
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0].outstandingRequestIds).toEqual([
      `req-${canonicalTokenIds[0]}`,
    ]);

    // Outbox: 3 transitions; terminal is `delivered-instant` (NOT
    // `delivered`).
    expect(outbox.writes).toHaveLength(3);
    expect(outbox.writes.map((w) => w.status)).toEqual([
      'packaging',
      'sending',
      'delivered-instant',
    ]);
  });
});

describe('§11.2 — TXF-mode end-to-end (instant, 5 tokens)', () => {
  it('5 proof-null events; 5 per-token finalization triggers; per-token isolation preserved', async () => {
    const { events, transportCalls, canonicalTokenIds, triggerCalls, outbox } =
      await runTxfSendN({ tokenCount: 5, variant: 'instant' });

    expect(transportCalls).toHaveLength(5);
    expect(events.count('transfer:submitted')).toBe(1);
    expect(triggerCalls).toHaveLength(5);

    // Per-token isolation: outboxId is unique per token, and each token
    // got exactly one trigger.
    const triggerIds = new Set(triggerCalls.map((c) => c.outboxId));
    expect(triggerIds.size).toBe(5);

    // Every wire event has a proof-null transferTx (instant invariant).
    for (const c of transportCalls) {
      const wire = c.payload as { transferTx: string };
      const tx = JSON.parse(wire.transferTx) as { inclusionProof: unknown };
      expect(tx.inclusionProof).toBeNull();
    }

    // Outbox terminal status per token is `delivered-instant`.
    const terminalStatuses = outbox.writes
      .filter(
        (w) =>
          w.status === 'delivered' || w.status === 'delivered-instant',
      )
      .map((w) => w.status);
    expect(terminalStatuses).toHaveLength(5);
    for (const s of terminalStatuses) {
      expect(s).toBe('delivered-instant');
    }

    // Recovered tokenIds match the canonical set, lex-sorted.
    const wireTokenIds = transportCalls.map((c) => {
      const wire = c.payload as { transferTx: string };
      return (JSON.parse(wire.transferTx) as { tokenId: string }).tokenId;
    });
    expect(wireTokenIds).toEqual([...canonicalTokenIds].sort());
  });
});
