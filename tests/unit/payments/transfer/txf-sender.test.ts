/**
 * Tests for `modules/payments/transfer/txf-sender.ts` (T.7.A).
 *
 * Exercises the legacy single-coin TXF send orchestrator with inline-
 * mocked dependencies, covering both finalization variants:
 *
 *  - **Conservative TXF** (§4.4.1, default per §10.1):
 *      - 1, 5, 100 source tokens → exactly N Nostr events.
 *      - Each per-token outbox entry transitions
 *        `packaging → sending → delivered`.
 *      - Synthetic `bundleCid='txf-' + sourceTokenId` per entry.
 *      - `mode: 'txf'` preserved on every entry.
 *      - `transfer:confirmed` emitted after the per-token loop.
 *
 *  - **Instant TXF** (§4.4.2):
 *      - Same N events; outbox terminus is `delivered-instant`.
 *      - `outstandingRequestIds` carries the new commitment plus
 *        K-1 inherited unfinalized predecessors when chain mode is
 *        active.
 *      - `transfer:submitted` emitted (NOT `transfer:confirmed`).
 *      - `onTriggerFinalization` invoked exactly once per token.
 *      - Cascade-risk-warning emitted when source is pending coin.
 *
 *  - **Per-token outbox isolation**: deleting one entry does NOT
 *    affect others (each entry has a distinct id derived from
 *    `${baseTransferId}-${sourceTokenId}`).
 *
 *  - **Mode tag preserved on each entry** (`mode: 'txf'`) — verified
 *    in every test by extracting the `mode` field of every recorded
 *    outbox entry.
 *
 *  - **Instant-TXF + chain mode**: outstandingRequestIds includes
 *    inherited unfinalized commitmentRequestIds (per acceptance risks).
 *
 * Spec references:
 *  - §2.4   TXF wire-shape definition.
 *  - §4.4.1 Conservative TXF sequence.
 *  - §4.4.2 Instant TXF sequence.
 *  - §4.5   Outbox tracking — TXF per-token entries.
 *  - §7.0   Outbox state machine (the `mode: 'txf'` rows).
 *  - §10.1  Backward compat / TXF arm.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  sendTxfUxf,
  syntheticTxfBundleCid,
  type TxfCommitResult,
  type TxfFinalization,
  type TxfOutboxHooks,
  type TxfSenderDeps,
} from '../../../../extensions/uxf/pipeline/txf-sender';
import type { TokenLike } from '../../../../extensions/uxf/pipeline/classify-token';
import { isSphereError } from '../../../../core/errors';
import type { OracleProvider } from '../../../../oracle/oracle-provider';
import type { TransportProvider } from '../../../../transport';
import type { PeerInfo } from '../../../../transport/transport-provider';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
} from '../../../../types';
import type {
  UxfTransferOutboxEntry,
  UxfOutboxStatus,
} from '../../../../extensions/uxf/types/uxf-outbox';
import { TOKEN_A } from '../../../fixtures/uxf-mock-tokens';

// =============================================================================
// 1. Shared test fixtures + helpers
// =============================================================================

function makeToken(
  id: string,
  fixture: Record<string, unknown>,
  overrides: Partial<Token> = {},
): Token {
  return {
    id,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Unicity',
    decimals: 8,
    amount: '1000000',
    status: 'confirmed',
    createdAt: 0,
    updatedAt: 0,
    sdkData: JSON.stringify(fixture),
    ...overrides,
  };
}

function makeCommitResult(params: {
  readonly sourceTokenId: string;
  readonly fixture: Record<string, unknown>;
  readonly tokenClass?: 'coin' | 'nft';
  readonly inheritedRequestIds?: ReadonlyArray<string>;
  readonly requestIdHex?: string;
}): TxfCommitResult {
  const tokenClass = params.tokenClass ?? 'coin';
  const sourceTokenJson = JSON.stringify(params.fixture);
  // Conservative-TXF wire payload would carry an actual proof object; in
  // the unit-test the orchestrator is opaque to the contents — it just
  // ships the strings as-is. We still distinguish the two shapes so a
  // later assertion can verify the orchestrator preserved them verbatim.
  const transferTxJson = JSON.stringify({
    data: { requestId: `req-${params.sourceTokenId}` },
    inclusionProof:
      params.inheritedRequestIds !== undefined
        ? null
        : { merkleTreePath: { root: 'mock-proof-root', steps: [] } },
  });
  return {
    sourceTokenId: params.sourceTokenId,
    method: 'direct',
    requestIdHex: params.requestIdHex ?? `req-${params.sourceTokenId}`,
    sourceTokenJson,
    transferTxJson,
    tokenClass,
    ...(params.inheritedRequestIds !== undefined
      ? { inheritedRequestIds: params.inheritedRequestIds }
      : {}),
  };
}

function makeOracleStub(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    initialize: vi.fn(),
    submitCommitment: vi.fn(),
    getProof: vi.fn(),
    waitForProof: vi.fn(),
    validateToken: vi.fn(),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
    getCurrentRound: vi.fn().mockResolvedValue(1),
  };
}

interface MockTransport extends TransportProvider {
  readonly _calls: Array<{ recipient: string; payload: unknown }>;
  _failNextSendWith: Error | null;
  _failOnTokenIdContaining: string | null;
}

function makeTransportStub(): MockTransport {
  const calls: MockTransport['_calls'] = [];
  const stub: MockTransport = {
    _calls: calls,
    _failNextSendWith: null,
    _failOnTokenIdContaining: null,
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p',
    description: 'Test stub',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    getStatus: () => 'connected' as const,
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => undefined),
    sendTokenTransfer: vi
      .fn()
      .mockImplementation(async (recipient: string, payload: unknown) => {
        if (stub._failNextSendWith) {
          const err = stub._failNextSendWith;
          stub._failNextSendWith = null;
          throw err;
        }
        if (
          stub._failOnTokenIdContaining !== null &&
          typeof payload === 'object' &&
          payload !== null
        ) {
          // Match against transferTx which carries `req-${tokenId}`
          // for the per-source commitment. The mock fixture's
          // sourceToken string is fixture-shaped (TOKEN_A) and does
          // not carry the source tokenId; only the transferTx does
          // (via our makeCommitResult builder).
          const transferTx = (payload as { transferTx?: unknown }).transferTx;
          if (
            typeof transferTx === 'string' &&
            transferTx.includes(stub._failOnTokenIdContaining)
          ) {
            throw new Error(`Mock failure for token containing ${stub._failOnTokenIdContaining}`);
          }
        }
        calls.push({ recipient, payload });
        return 'event-id';
      }),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
  };
  return stub;
}

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02aaaa'.padEnd(66, 'a'),
    directAddress: 'DIRECT://mock-direct',
    privateKey: '01'.repeat(32),
  };
}

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    transportPubkey: '02bbbb'.padEnd(64, 'b'),
    chainPubkey: '02cccc'.padEnd(66, 'c'),
    directAddress: 'DIRECT://bob-direct',
    timestamp: 0,
    nametag: 'bob',
    ...overrides,
  };
}

function defaultTokenLikeForTest(token: Token): TokenLike {
  return {
    id: token.id,
    coins: [{ coinId: token.coinId, amount: BigInt(token.amount) }],
  };
}

interface OutboxRecorder extends TxfOutboxHooks {
  readonly _records: Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>>;
}

function makeOutboxRecorder(): OutboxRecorder {
  const records: Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>> = [];
  return {
    _records: records,
    write: async (entry) => {
      // Defensive copy — the orchestrator may mutate the same args
      // object across calls, but we want a snapshot per call for
      // assertions.
      records.push({ ...entry });
    },
  };
}

function makeDeps(overrides: Partial<TxfSenderDeps> = {}): {
  readonly deps: TxfSenderDeps;
  readonly transport: MockTransport;
  readonly events: Array<{ type: SphereEventType; data: unknown }>;
  readonly outbox: OutboxRecorder;
} {
  const transport = makeTransportStub();
  const events: Array<{ type: SphereEventType; data: unknown }> = [];
  const outbox = makeOutboxRecorder();
  const emit = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
    events.push({ type, data });
  };
  const deps: TxfSenderDeps = {
    aggregator: makeOracleStub(),
    transport,
    identity: makeIdentity(),
    addressId: 'addr-test-001',
    senderTransportPubkey: '02bbbb'.padEnd(64, 'b'),
    emit,
    availableSources: () => [],
    selectSources: async () => [],
    commitSources: async () => [],
    outbox,
    toTokenLike: defaultTokenLikeForTest,
    transferId: 'fixed-test-transfer-id',
    ...overrides,
  };
  return { deps, transport, events, outbox };
}

function basicRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'instant',
    ...overrides,
  };
}

function statusesOf(
  records: ReadonlyArray<{ status: UxfOutboxStatus }>,
): UxfOutboxStatus[] {
  return records.map((r) => r.status);
}

/** Build N source tokens with deterministic ids: tok-001, tok-002, ... */
function makeNTokens(n: number): { tokens: Token[]; results: TxfCommitResult[] } {
  const tokens: Token[] = [];
  const results: TxfCommitResult[] = [];
  for (let i = 0; i < n; i++) {
    const id = `tok-${String(i + 1).padStart(3, '0')}`;
    tokens.push(makeToken(id, TOKEN_A));
    results.push(makeCommitResult({ sourceTokenId: id, fixture: TOKEN_A }));
  }
  return { tokens, results };
}

// =============================================================================
// 2. Conservative TXF — N=1, 5, 100 tokens
// =============================================================================

describe('sendTxfUxf — conservative TXF (default)', () => {
  it.each([
    { n: 1 },
    { n: 5 },
    { n: 100 },
  ])('N=$n tokens → N Nostr events; outbox = packaging→sending→delivered per token', async ({ n }) => {
    const { tokens, results } = makeNTokens(n);
    const { deps, transport, events, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });

    const result = await sendTxfUxf(
      basicRequest({ amount: String(1000000 * n) }),
      makePeerInfo(),
      deps,
      'conservative',
    );

    // Result shape.
    expect(result.status).toBe('completed');
    expect(result.tokens).toHaveLength(n);
    expect(result.tokenTransfers).toHaveLength(n);
    for (const detail of result.tokenTransfers) {
      // Conservative-TXF: no splitParent on the result (the parent's
      // proof is attached on the wire).
      expect(detail.splitParent).toBeUndefined();
      expect(detail.method).toBe('direct');
    }

    // Transport: exactly N events, one per token.
    expect(transport._calls).toHaveLength(n);
    for (const call of transport._calls) {
      const payload = call.payload as { sourceToken?: unknown; transferTx?: unknown };
      expect(typeof payload.sourceToken).toBe('string');
      expect(typeof payload.transferTx).toBe('string');
    }

    // Outbox: 3 records per token (packaging → sending → delivered).
    expect(outbox._records).toHaveLength(3 * n);
    const grouped = new Map<string, Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>>>();
    for (const rec of outbox._records) {
      const list = grouped.get(rec.id) ?? [];
      list.push(rec);
      grouped.set(rec.id, list);
    }
    expect(grouped.size).toBe(n);
    for (const [, list] of grouped) {
      expect(statusesOf(list)).toEqual(['packaging', 'sending', 'delivered']);
      // Mode tag preserved on each entry.
      for (const rec of list) {
        expect(rec.mode).toBe('txf');
        expect(rec.deliveryMethod).toBe('txf-legacy');
        // Conservative-TXF outstanding set is always empty.
        expect(rec.outstandingRequestIds).toEqual([]);
      }
    }

    // Single transfer:confirmed event after the loop completes.
    const confirmed = events.filter((e) => e.type === 'transfer:confirmed');
    const submitted = events.filter((e) => e.type === 'transfer:submitted');
    expect(confirmed).toHaveLength(1);
    expect(submitted).toHaveLength(0);
  });

  it('synthetic bundleCid is "txf-" + sourceTokenId', async () => {
    const { tokens, results } = makeNTokens(3);
    const { deps, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });

    await sendTxfUxf(
      basicRequest({ amount: '3000000' }),
      makePeerInfo(),
      deps,
      'conservative',
    );

    const sortedTokenIds = tokens.map((t) => t.id).sort();
    for (const tokenId of sortedTokenIds) {
      const entries = outbox._records.filter((r) => r.tokenIds[0] === tokenId);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.bundleCid).toBe(`txf-${tokenId}`);
      }
    }
  });

  it('exposes syntheticTxfBundleCid for external use', () => {
    expect(syntheticTxfBundleCid('aabbcc')).toBe('txf-aabbcc');
    expect(syntheticTxfBundleCid('')).toBe('txf-');
  });

  it('passes recipient nametag into outbox entries', async () => {
    const { tokens, results } = makeNTokens(2);
    const { deps, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });

    await sendTxfUxf(
      basicRequest({ amount: '2000000' }),
      makePeerInfo({ nametag: 'bob' }),
      deps,
      'conservative',
    );

    for (const rec of outbox._records) {
      expect(rec.recipientNametag).toBe('bob');
    }
  });
});

// =============================================================================
// 3. Instant TXF — N=1, 5, 100 tokens
// =============================================================================

describe('sendTxfUxf — instant TXF', () => {
  it.each([
    { n: 1 },
    { n: 5 },
    { n: 100 },
  ])('N=$n tokens → N Nostr events; outbox terminus is delivered-instant', async ({ n }) => {
    const { tokens, results } = makeNTokens(n);
    const { deps, transport, events, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });

    const result = await sendTxfUxf(
      basicRequest({ amount: String(1000000 * n) }),
      makePeerInfo(),
      deps,
      'instant',
    );

    // Result: status='submitted' (instant — proof not yet landed).
    expect(result.status).toBe('submitted');
    expect(result.tokens).toHaveLength(n);
    expect(result.tokenTransfers).toHaveLength(n);
    for (const detail of result.tokenTransfers) {
      // Instant + coin → splitParent set, status='pending'.
      expect(detail.splitParent).toEqual({
        tokenId: detail.sourceTokenId,
        status: 'pending',
      });
    }

    // Transport: exactly N events.
    expect(transport._calls).toHaveLength(n);

    // Outbox: 3 records per token (packaging → sending → delivered-instant).
    expect(outbox._records).toHaveLength(3 * n);
    const grouped = new Map<string, Array<Omit<UxfTransferOutboxEntry, '_schemaVersion' | 'lamport'>>>();
    for (const rec of outbox._records) {
      const list = grouped.get(rec.id) ?? [];
      list.push(rec);
      grouped.set(rec.id, list);
    }
    for (const [, list] of grouped) {
      expect(statusesOf(list)).toEqual(['packaging', 'sending', 'delivered-instant']);
      for (const rec of list) {
        expect(rec.mode).toBe('txf');
        expect(rec.deliveryMethod).toBe('txf-legacy');
      }
    }

    // Final entry per token has outstandingRequestIds = [requestIdHex].
    const finals = outbox._records.filter((r) => r.status === 'delivered-instant');
    expect(finals).toHaveLength(n);
    for (const final of finals) {
      const sourceTokenId = final.tokenIds[0];
      expect(final.outstandingRequestIds).toEqual([`req-${sourceTokenId}`]);
      expect(final.completedRequestIds).toEqual([]);
    }

    // Event: transfer:submitted (NOT transfer:confirmed).
    const submitted = events.filter((e) => e.type === 'transfer:submitted');
    const confirmed = events.filter((e) => e.type === 'transfer:confirmed');
    expect(submitted).toHaveLength(1);
    expect(confirmed).toHaveLength(0);
  });

  it('chain-mode K=3 carries inherited unfinalized commitmentRequestIds in outstandingRequestIds', async () => {
    const source = makeToken('tok-chain-1', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'tok-chain-1',
      fixture: TOKEN_A,
      // K=3: 1 new + 2 inherited (the K-1 framing per §2.3).
      inheritedRequestIds: ['req-pred-2', 'req-pred-1'],
    });
    const { deps, outbox } = makeDeps({
      availableSources: () => [source],
      selectSources: async () => [source],
      commitSources: async () => [commitResult],
    });

    await sendTxfUxf(
      basicRequest({ allowPendingTokens: true }),
      makePeerInfo(),
      deps,
      'instant',
    );

    const final = outbox._records[outbox._records.length - 1];
    expect(final.status).toBe('delivered-instant');
    expect(final.outstandingRequestIds).toEqual([
      'req-chain-1' /* not really, dedup */,
      'req-pred-1',
      'req-pred-2',
      'req-tok-chain-1',
    ].sort().filter((v) => v !== 'req-chain-1'));
    // The above filter removes the placeholder we typed for clarity;
    // the real expectation:
    expect(final.outstandingRequestIds).toEqual([
      'req-pred-1',
      'req-pred-2',
      'req-tok-chain-1',
    ]);
  });

  it('triggers onTriggerFinalization once per token AFTER delivered-instant', async () => {
    const { tokens, results } = makeNTokens(3);
    const triggerCalls: Array<{
      addressId: string;
      outboxId: string;
      bundleCid: string;
      outstandingRequestIds: ReadonlyArray<string>;
    }> = [];
    const { deps, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
      onTriggerFinalization: async (params) => {
        // Capture defensively (the writer recorder uses immutable
        // copies; this callback receives the same shape).
        triggerCalls.push({
          addressId: params.addressId,
          outboxId: params.outboxId,
          bundleCid: params.bundleCid,
          outstandingRequestIds: [...params.outstandingRequestIds],
        });
      },
    });

    await sendTxfUxf(
      basicRequest({ amount: '3000000' }),
      makePeerInfo(),
      deps,
      'instant',
    );

    // 3 tokens → 3 trigger calls.
    expect(triggerCalls).toHaveLength(3);
    for (const call of triggerCalls) {
      expect(call.addressId).toBe('addr-test-001');
      expect(call.bundleCid).toMatch(/^txf-tok-\d+$/);
      // outstanding has the new requestId (no inherited in this test).
      expect(call.outstandingRequestIds).toHaveLength(1);
    }
    // Each trigger fires AFTER the delivered-instant write for its
    // token. Because each token is a fully-self-contained loop iteration
    // (write-then-trigger), the write for the last token's
    // delivered-instant is in `outbox._records` before we check.
    const finals = outbox._records.filter((r) => r.status === 'delivered-instant');
    expect(finals).toHaveLength(3);
  });

  it('swallows onTriggerFinalization throws so the publish is not retracted', async () => {
    const { tokens, results } = makeNTokens(2);
    const { deps, transport } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
      onTriggerFinalization: async () => {
        throw new Error('worker registry unavailable');
      },
    });

    // Does not reject — the orchestrator swallows worker hiccups.
    await sendTxfUxf(
      basicRequest({ amount: '2000000' }),
      makePeerInfo(),
      deps,
      'instant',
    );

    // Both tokens were published.
    expect(transport._calls).toHaveLength(2);
  });

  it('emits cascade-risk-warning when a coin source is pending', async () => {
    const pendingSource = makeToken('pending-tok', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'pending-tok',
      fixture: TOKEN_A,
    });
    const { deps, events } = makeDeps({
      availableSources: () => [pendingSource],
      selectSources: async () => [pendingSource],
      commitSources: async () => [commitResult],
      // Force projection to surface pending=true.
      toTokenLike: (t) => ({
        id: t.id,
        coins: [{ coinId: t.coinId, amount: BigInt(t.amount) }],
        pending: true,
      }),
    });

    await sendTxfUxf(
      basicRequest({ allowPendingTokens: true }),
      makePeerInfo(),
      deps,
      'instant',
    );

    const warnings = events.filter((e) => e.type === 'transfer:cascade-risk-warning');
    expect(warnings).toHaveLength(1);
    const data = warnings[0].data as {
      transferId: string;
      bundleCid: string;
      pendingSourceTokenIds: string[];
      freshlyMintedChildTokenIds: string[];
    };
    expect(data.pendingSourceTokenIds).toContain('pending-tok');
    expect(data.freshlyMintedChildTokenIds).toContain('pending-tok');
    // TXF has no real bundleCid — empty string per the orchestrator.
    expect(data.bundleCid).toBe('');
  });

  it('does NOT emit cascade-risk-warning for conservative TXF', async () => {
    const pendingSource = makeToken('pending-tok', TOKEN_A);
    const commitResult = makeCommitResult({
      sourceTokenId: 'pending-tok',
      fixture: TOKEN_A,
    });
    const { deps, events } = makeDeps({
      availableSources: () => [pendingSource],
      selectSources: async () => [pendingSource],
      commitSources: async () => [commitResult],
      toTokenLike: (t) => ({
        id: t.id,
        coins: [{ coinId: t.coinId, amount: BigInt(t.amount) }],
        pending: true,
      }),
    });

    // Conservative-TXF must not emit cascade warnings — proofs are
    // already attached on the wire so there is no recipient-side
    // cascade exposure.
    // Note: pending source rejection in the validator only fires for
    // NFTs (W11). Coin-class pending sources are accepted in chain
    // mode.
    await sendTxfUxf(
      basicRequest({ allowPendingTokens: true }),
      makePeerInfo(),
      deps,
      'conservative',
    );

    const warnings = events.filter((e) => e.type === 'transfer:cascade-risk-warning');
    expect(warnings).toHaveLength(0);
  });
});

// =============================================================================
// 4. Per-token outbox isolation — deletion of one entry doesn't affect others
// =============================================================================

describe('sendTxfUxf — per-token outbox isolation', () => {
  it('each token gets its OWN outbox entry id; ids do NOT collide', async () => {
    const { tokens, results } = makeNTokens(5);
    const { deps, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });

    await sendTxfUxf(
      basicRequest({ amount: '5000000' }),
      makePeerInfo(),
      deps,
      'conservative',
    );

    const ids = new Set(outbox._records.map((r) => r.id));
    expect(ids.size).toBe(5);
    // Each id is the deterministic `${transferId}-${sourceTokenId}` form.
    for (const id of ids) {
      expect(id).toMatch(/^fixed-test-transfer-id-tok-\d+$/);
    }
  });

  it('"deleting" one entry from the recorder does not affect others (per-token isolation invariant)', async () => {
    const { tokens, results } = makeNTokens(3);
    const { deps, outbox } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });

    await sendTxfUxf(
      basicRequest({ amount: '3000000' }),
      makePeerInfo(),
      deps,
      'conservative',
    );

    // Snapshot count before the synthetic "deletion".
    const totalBefore = outbox._records.length;
    const targetId = 'fixed-test-transfer-id-tok-002';
    const targetEntries = outbox._records.filter((r) => r.id === targetId);
    expect(targetEntries.length).toBeGreaterThan(0);

    // Simulate deletion of all entries for that id.
    const filtered = outbox._records.filter((r) => r.id !== targetId);
    expect(filtered.length).toBe(totalBefore - targetEntries.length);

    // The entries for the OTHER tokens are still intact and unchanged.
    const otherIds = new Set(filtered.map((r) => r.id));
    expect(otherIds).toEqual(new Set([
      'fixed-test-transfer-id-tok-001',
      'fixed-test-transfer-id-tok-003',
    ]));
    // Each surviving id still has its 3 status records.
    for (const otherId of otherIds) {
      const entries = filtered.filter((r) => r.id === otherId);
      expect(entries).toHaveLength(3);
      expect(statusesOf(entries)).toEqual(['packaging', 'sending', 'delivered']);
    }
  });

  it('per-token transport failure: only that token transitions to failed-transient', async () => {
    const { tokens, results } = makeNTokens(3);
    const { deps, outbox, transport } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });
    // Fail the publish for the second token (tok-002 — its sourceToken
    // string contains the substring).
    transport._failOnTokenIdContaining = 'tok-002';

    let captured: unknown = null;
    try {
      await sendTxfUxf(
        basicRequest({ amount: '3000000' }),
        makePeerInfo(),
        deps,
        'conservative',
      );
      expect.fail('expected throw, got resolved promise');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('TRANSPORT_ERROR');
    }

    // tok-001 reached `delivered`. tok-002 reached `failed-transient`.
    // tok-003 was never published (the loop short-circuits on throw).
    const tok001Entries = outbox._records.filter((r) => r.id === 'fixed-test-transfer-id-tok-001');
    const tok002Entries = outbox._records.filter((r) => r.id === 'fixed-test-transfer-id-tok-002');
    const tok003Entries = outbox._records.filter((r) => r.id === 'fixed-test-transfer-id-tok-003');

    expect(statusesOf(tok001Entries)).toEqual(['packaging', 'sending', 'delivered']);
    expect(statusesOf(tok002Entries)).toEqual(['packaging', 'sending', 'failed-transient']);
    expect(tok003Entries).toHaveLength(0);

    // tok-001's `delivered` entry was NOT mutated by tok-002's failure.
    const tok001Final = tok001Entries[tok001Entries.length - 1];
    expect(tok001Final.status).toBe('delivered');
    expect(tok001Final.error).toBeUndefined();
  });

  // ===========================================================================
  // Wave 3 steelman fix #170 issue 7 — partial-success per-token outcomes
  // attached to SphereError.cause so callers can distinguish "all failed"
  // from "some succeeded, one failed" without scraping outbox or
  // tokenTransfers length.
  // ===========================================================================
  it('attaches structured per-token outcomes to SphereError.cause on partial success (#170 issue 7)', async () => {
    const { tokens, results } = makeNTokens(3);
    const { deps, transport } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });
    // Fail the publish for the second token (tok-002).
    transport._failOnTokenIdContaining = 'tok-002';

    let captured: unknown = null;
    try {
      await sendTxfUxf(
        basicRequest({ amount: '3000000' }),
        makePeerInfo(),
        deps,
        'conservative',
      );
      expect.fail('expected throw, got resolved promise');
    } catch (err) {
      captured = err;
    }
    if (!isSphereError(captured)) {
      throw new Error(`expected SphereError; got ${String(captured)}`);
    }
    expect(captured.code).toBe('TRANSPORT_ERROR');

    // The cause must carry the structured discriminator + outcomes list.
    const cause = (captured as Error & {
      cause?: {
        kind?: string;
        outcomes?: ReadonlyArray<{
          sourceTokenId: string;
          status: string;
          bundleCid: string;
          outboxId: string;
          error?: string;
        }>;
        failedTokenId?: string;
        failedIndex?: number;
        successCount?: number;
        failureCount?: number;
        originalCause?: unknown;
      };
    }).cause;
    expect(cause).toBeDefined();
    expect(cause?.kind).toBe('txf-partial-success');
    expect(cause?.failedTokenId).toBe('tok-002');
    expect(cause?.failedIndex).toBe(1);
    expect(cause?.successCount).toBe(1);
    expect(cause?.failureCount).toBe(1);
    expect(cause?.outcomes).toHaveLength(2);
    // Sorted lex by sourceTokenId — tok-001 (delivered) comes first.
    expect(cause?.outcomes?.[0].sourceTokenId).toBe('tok-001');
    expect(cause?.outcomes?.[0].status).toBe('delivered');
    expect(cause?.outcomes?.[0].error).toBeUndefined();
    expect(cause?.outcomes?.[1].sourceTokenId).toBe('tok-002');
    expect(cause?.outcomes?.[1].status).toBe('failed');
    expect(cause?.outcomes?.[1].error).toBeDefined();
    // Original transport throw is preserved alongside.
    expect(cause?.originalCause).toBeDefined();
  });

  it('first-token failure → outcomes contains only the failure (no success list)', async () => {
    const { tokens, results } = makeNTokens(3);
    const { deps, transport } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });
    transport._failOnTokenIdContaining = 'tok-001';

    let captured: unknown = null;
    try {
      await sendTxfUxf(
        basicRequest({ amount: '3000000' }),
        makePeerInfo(),
        deps,
        'conservative',
      );
      expect.fail('expected throw');
    } catch (err) {
      captured = err;
    }
    if (!isSphereError(captured)) {
      throw new Error(`expected SphereError; got ${String(captured)}`);
    }
    const cause = (captured as Error & {
      cause?: {
        kind?: string;
        outcomes?: ReadonlyArray<{ status: string }>;
        failedIndex?: number;
        successCount?: number;
        failureCount?: number;
      };
    }).cause;
    expect(cause?.kind).toBe('txf-partial-success');
    expect(cause?.failedIndex).toBe(0);
    expect(cause?.successCount).toBe(0);
    expect(cause?.failureCount).toBe(1);
    expect(cause?.outcomes).toHaveLength(1);
    expect(cause?.outcomes?.[0].status).toBe('failed');
  });
});

// =============================================================================
// 5. Mark source pending hook — invoked per token, with the correct variant
// =============================================================================

describe('sendTxfUxf — markSourcePending hook', () => {
  it('called once per token with the finalization variant', async () => {
    const { tokens, results } = makeNTokens(3);
    const calls: Array<{ tokenId: string; finalization: TxfFinalization }> = [];
    const { deps } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
      markSourcePending: async (token, finalization) => {
        calls.push({ tokenId: token.id, finalization });
      },
    });

    await sendTxfUxf(
      basicRequest({ amount: '3000000' }),
      makePeerInfo(),
      deps,
      'instant',
    );

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.finalization).toBe('instant');
    }
    // All three token ids must appear (sorted).
    expect(calls.map((c) => c.tokenId).sort()).toEqual(['tok-001', 'tok-002', 'tok-003']);
  });

  it('correct finalization variant for conservative', async () => {
    const { tokens, results } = makeNTokens(2);
    const calls: Array<TxfFinalization> = [];
    const { deps } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
      markSourcePending: async (_, finalization) => {
        calls.push(finalization);
      },
    });

    await sendTxfUxf(
      basicRequest({ amount: '2000000' }),
      makePeerInfo(),
      deps,
      'conservative',
    );

    expect(calls).toEqual(['conservative', 'conservative']);
  });
});

// =============================================================================
// 6. Negative paths
// =============================================================================

describe('sendTxfUxf — negative paths', () => {
  it('throws when no source selection covers the request', async () => {
    // Empty available pool → validateTargets throws INSUFFICIENT_BALANCE
    // first (the §4.1 step 1 validator runs before source-selection).
    // If a caller bypasses validation by injecting a non-empty pool but
    // a selector returning empty, the orchestrator's own
    // SEND_INSUFFICIENT_BALANCE guard fires.
    const { deps } = makeDeps({
      availableSources: () => [],
      selectSources: async () => [],
      commitSources: async () => [],
    });

    let captured: unknown = null;
    try {
      await sendTxfUxf(basicRequest(), makePeerInfo(), deps, 'conservative');
      expect.fail('expected throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      // validateTargets throws first with INSUFFICIENT_BALANCE.
      expect(captured.code).toBe('INSUFFICIENT_BALANCE');
    }
  });

  it('throws SEND_INSUFFICIENT_BALANCE when selectSources returns empty despite available pool', async () => {
    // Caller bypassed source-coverage by injecting a token but a
    // selector returning empty. The orchestrator's own guard fires.
    const { tokens } = makeNTokens(1);
    const { deps } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => [],
      commitSources: async () => [],
    });

    let captured: unknown = null;
    try {
      await sendTxfUxf(basicRequest(), makePeerInfo(), deps, 'conservative');
      expect.fail('expected throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('SEND_INSUFFICIENT_BALANCE');
    }
  });

  it('throws TRANSFER_FAILED when commitSources returns empty', async () => {
    const { tokens } = makeNTokens(1);
    const { deps } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      // Caller "selected" tokens but commit returned nothing — orchestrator
      // refuses to ship an empty TXF batch.
      commitSources: async () => [],
    });

    let captured: unknown = null;
    try {
      await sendTxfUxf(basicRequest(), makePeerInfo(), deps, 'conservative');
      expect.fail('expected throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('TRANSFER_FAILED');
    }
  });

  it('emits transfer:failed on transport error', async () => {
    const { tokens, results } = makeNTokens(2);
    const { deps, events, transport } = makeDeps({
      availableSources: () => tokens,
      selectSources: async () => tokens,
      commitSources: async () => results,
    });
    transport._failNextSendWith = new Error('relay rejected');

    let captured: unknown = null;
    try {
      await sendTxfUxf(
        basicRequest({ amount: '2000000' }),
        makePeerInfo(),
        deps,
        'conservative',
      );
      expect.fail('expected throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('TRANSPORT_ERROR');
    }
    const failed = events.filter((e) => e.type === 'transfer:failed');
    expect(failed).toHaveLength(1);
  });
});
